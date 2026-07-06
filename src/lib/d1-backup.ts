// Scheduled full-database D1 → R2 backup (disaster recovery).
//
// This is the second line of DR. The first line is D1 Time Travel
// (point-in-time restore to any minute in the last 30 days,
// `wrangler d1 time-travel restore`) — but Time Travel dies with the
// database: it does not survive database deletion, account loss, or
// need a >30-day horizon. These exports do. See
// docs/disaster-recovery.md for the full runbook.
//
// Design constraints, in order:
//   1. READ-ONLY against D1. The backup never mutates schema or data —
//      that is what makes it safe to run against the in-flight V2
//      overhaul's tables. All writes go to R2 under backups/d1/.
//   2. Runs as a Workflow (D1BackupWorkflow) so every table part gets
//      its own step — own subrequest budget, own retries, CF-side
//      lifecycle — instead of one giant scheduled invocation racing
//      the per-invocation caps. The orchestrator below takes a minimal
//      step interface so tests can drive it inline without importing
//      `cloudflare:workers`.
//   3. Output format matches the maintenance snapshots the existing
//      restore tooling already consumes: JSONL rows, one object per
//      line, restored with INSERT OR REPLACE
//      (scripts/restore-d1-backup.mjs, scripts/lib/d1-restore-core.mjs).
//   4. Consistency is per-table, not point-in-time: tables are dumped
//      sequentially while writers may be active. The manifest says so.
//      For surgical point-in-time recovery inside 30 days, prefer Time
//      Travel; these exports are for catastrophe + long horizon.

import type { Env } from '../types/env';

export interface D1BackupEnv {
  D1: Env['D1'];
  R2: Env['R2'];
  ENVIRONMENT?: string;
}

// Minimal structural slice of cloudflare:workers' WorkflowStep. The
// workflow shell passes the real step; tests pass an inline executor.
export interface BackupStepper {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface D1BackupParams {
  // YYYY-MM-DD partition for the backup prefix. The cron dispatcher
  // passes the tick date; manual triggers may omit it.
  date?: string;
  // How many daily backups to retain in R2. Default 14.
  keepDays?: number;
}

export interface BackupPartMeta {
  key: string;
  rows: number;
  bytes: number;
  hash: string;
}

export interface BackupTableMeta {
  name: string;
  rows: number;
  mode: 'rowid' | 'offset';
  parts: BackupPartMeta[];
}

export interface SkippedTable {
  name: string;
  reason: string;
}

export interface D1BackupResult {
  prefix: string;
  date: string;
  tables: number;
  rows: number;
  parts: number;
  bytes: number;
  skipped: SkippedTable[];
  retention: { kept: string[]; deleted_prefixes: string[]; deleted_objects: number };
}

export const BACKUP_ROOT = 'backups/d1/';
export const BACKUP_FORMAT = 'medina-d1-backup/1';
const DEFAULT_KEEP_DAYS = 14;

// Per-part budgets. Parts bound Worker memory per step and R2 object
// size; the per-query LIMIT bounds each D1 response (house rule: no
// unbounded row scans) and halves adaptively if a response is too
// large for the platform to return.
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PART_ROWS = 5_000;
const INITIAL_QUERY_LIMIT = 200;
const MIN_QUERY_LIMIT = 25;
// Backstop against a runaway table producing unbounded steps. 500
// parts × 8 MB ≈ 4 GB for a single table — beyond plausible D1 size.
const MAX_PARTS_PER_TABLE = 500;

// Same tiny content hash the maintenance snapshots stamp on R2 objects.
// Deliberately duplicated from d1-maintenance.ts rather than imported:
// backup must not depend on the destructive-cleanup module's internals.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface BackupPlan {
  tables: string[];
  skipped: SkippedTable[];
  schemaSql: string;
}

// FTS5 (and other virtual-table) shadow tables are derived storage:
// dumping them is wasted bytes and restoring them corrupts the module's
// internal state. We back up the CREATE VIRTUAL TABLE statement (in
// schema.sql) and rebuild content after restore — the search modules
// already ship admin rebuild endpoints for exactly that.
const VIRTUAL_SHADOW_SUFFIXES = ['_data', '_idx', '_content', '_docsize', '_config'];

export function classifySqliteMaster(rows: SqliteMasterRow[]): BackupPlan {
  const virtualNames = new Set(
    rows
      .filter(r => r.type === 'table' && (r.sql || '').toUpperCase().includes('CREATE VIRTUAL TABLE'))
      .map(r => r.name)
  );
  const shadowNames = new Set<string>();
  for (const v of virtualNames) {
    for (const suffix of VIRTUAL_SHADOW_SUFFIXES) shadowNames.add(`${v}${suffix}`);
  }

  const tables: string[] = [];
  const skipped: SkippedTable[] = [];
  const schemaParts: string[] = [];

  for (const row of rows) {
    const isInternal = row.name.startsWith('sqlite_') || row.name.startsWith('_cf_');
    if (row.type === 'table') {
      if (isInternal) {
        skipped.push({ name: row.name, reason: 'internal' });
        continue;
      }
      if (virtualNames.has(row.name)) {
        skipped.push({ name: row.name, reason: 'virtual_table_content_rebuilt_on_restore' });
        // Schema still carries the CREATE VIRTUAL TABLE so a from-scratch
        // restore recreates the structure before rebuild.
        if (row.sql) schemaParts.push(`${row.sql};`);
        continue;
      }
      if (shadowNames.has(row.name)) {
        skipped.push({ name: row.name, reason: 'virtual_table_shadow' });
        continue;
      }
      tables.push(row.name);
      if (row.sql) schemaParts.push(`${row.sql};`);
    } else if (row.type === 'index' || row.type === 'trigger' || row.type === 'view') {
      // sql IS NULL for auto-indexes (PK/UNIQUE) — those come back with
      // their CREATE TABLE. Skip internal/shadow-owned objects.
      if (!row.sql || isInternal || shadowNames.has(row.tbl_name) || row.tbl_name.startsWith('_cf_')) continue;
      schemaParts.push(`${row.sql};`);
    }
  }

  tables.sort();
  return { tables, skipped, schemaSql: schemaParts.join('\n') + '\n' };
}

export async function planBackup(env: D1BackupEnv): Promise<BackupPlan> {
  const rows = await env.D1.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`
  ).all<SqliteMasterRow>();
  return classifySqliteMaster(rows.results || []);
}

export type DumpCursor =
  | { mode: 'rowid'; last: number }
  | { mode: 'offset'; offset: number };

export interface DumpPartResult {
  lines: string;
  rows: number;
  bytes: number;
  nextCursor: DumpCursor | null;
  mode: 'rowid' | 'offset';
}

// D1 returns BLOB columns as ArrayBuffer; raw JSON.stringify would
// flatten them to {} and silently corrupt the backup. Encode as a
// tagged base64 object; the restore core turns it back into an X'..'
// blob literal.
function encodeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { $b64: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return { $b64: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function serializeRow(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '__rowid') continue;
    out[key] = encodeValue(value);
  }
  return JSON.stringify(out);
}

// Dump up to one part's worth of rows starting at `cursor`. Keyset
// pagination on rowid keeps the scan stable under concurrent inserts;
// WITHOUT ROWID tables fall back to LIMIT/OFFSET (detected on the
// first query, carried in cursor.mode from then on).
export async function dumpTablePart(
  env: D1BackupEnv,
  table: string,
  cursor: DumpCursor | null,
  budgets: { maxRows?: number; maxBytes?: number } = {}
): Promise<DumpPartResult> {
  const maxRows = budgets.maxRows ?? MAX_PART_ROWS;
  const maxBytes = budgets.maxBytes ?? MAX_PART_BYTES;

  let mode: 'rowid' | 'offset' = cursor?.mode ?? 'rowid';
  let last = cursor?.mode === 'rowid' ? cursor.last : -Infinity;
  let offset = cursor?.mode === 'offset' ? cursor.offset : 0;

  const lines: string[] = [];
  let bytes = 0;
  let rows = 0;
  let queryLimit = INITIAL_QUERY_LIMIT;
  let exhausted = false;

  while (rows < maxRows && bytes < maxBytes) {
    const limit = Math.min(queryLimit, maxRows - rows);
    let results: Record<string, unknown>[];
    try {
      if (mode === 'rowid') {
        const r = await env.D1.prepare(
          `SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`
        ).bind(last === -Infinity ? -1 : last, limit).all<Record<string, unknown>>();
        results = r.results || [];
      } else {
        const r = await env.D1.prepare(
          `SELECT * FROM "${table}" LIMIT ? OFFSET ?`
        ).bind(limit, offset).all<Record<string, unknown>>();
        results = r.results || [];
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // WITHOUT ROWID table: switch pagination mode once, from the start
      // of the table (only reachable on the very first query).
      if (mode === 'rowid' && /rowid/i.test(message)) {
        if (rows > 0) throw e;
        mode = 'offset';
        offset = 0;
        continue;
      }
      // Oversized response for this LIMIT (huge rows): halve and retry.
      if (queryLimit > MIN_QUERY_LIMIT) {
        queryLimit = Math.max(MIN_QUERY_LIMIT, Math.floor(queryLimit / 2));
        continue;
      }
      throw e;
    }

    if (results.length === 0) {
      exhausted = true;
      break;
    }

    // Consume row-by-row so the byte budget can stop a part mid-chunk
    // (wide rows would otherwise blow past maxBytes by a whole chunk).
    let consumed = 0;
    for (const row of results) {
      if (mode === 'rowid') {
        const rowid = Number(row.__rowid);
        if (Number.isFinite(rowid)) last = rowid;
      }
      const line = serializeRow(row);
      lines.push(line);
      bytes += line.length + 1;
      rows++;
      consumed++;
      if (rows >= maxRows || bytes >= maxBytes) break;
    }
    if (mode === 'offset') offset += consumed;

    if (consumed < results.length) break; // budget hit mid-chunk; more rows remain
    if (results.length < limit) {
      exhausted = true;
      break;
    }
  }
  const nextCursor: DumpCursor | null = exhausted
    ? null
    : mode === 'rowid'
      ? { mode: 'rowid', last: last === -Infinity ? -1 : last }
      : { mode: 'offset', offset };

  return {
    lines: lines.length ? lines.join('\n') + '\n' : '',
    rows,
    bytes,
    nextCursor,
    mode,
  };
}

export interface RetentionResult {
  kept: string[];
  deleted_prefixes: string[];
  deleted_objects: number;
}

// Delete date partitions older than the newest `keepDays`. Only
// date-shaped prefixes under backups/d1/ are candidates — nothing else
// in the bucket is touched.
export async function runBackupRetention(
  env: D1BackupEnv,
  keepDays: number
): Promise<RetentionResult> {
  const datePrefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await env.R2.list({ prefix: BACKUP_ROOT, delimiter: '/', cursor });
    for (const p of listing.delimitedPrefixes || []) {
      const partition = p.slice(BACKUP_ROOT.length).replace(/\/$/, '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(partition)) datePrefixes.push(partition);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  datePrefixes.sort(); // ISO dates sort chronologically
  const kept = datePrefixes.slice(-Math.max(1, keepDays));
  const stale = datePrefixes.slice(0, Math.max(0, datePrefixes.length - Math.max(1, keepDays)));

  let deletedObjects = 0;
  for (const partition of stale) {
    let listCursor: string | undefined;
    do {
      const listing = await env.R2.list({ prefix: `${BACKUP_ROOT}${partition}/`, cursor: listCursor });
      const keys = (listing.objects || []).map(o => o.key);
      if (keys.length) {
        await env.R2.delete(keys);
        deletedObjects += keys.length;
      }
      listCursor = listing.truncated ? listing.cursor : undefined;
    } while (listCursor);
  }

  return { kept, deleted_prefixes: stale, deleted_objects: deletedObjects };
}

function partKey(prefix: string, seq: number, table: string): string {
  return `${prefix}/parts/${String(seq).padStart(4, '0')}-${table}.jsonl`;
}

// Orchestrator. `step` is the workflow's step at runtime and an inline
// executor in tests. Everything that touches D1/R2 or the clock runs
// INSIDE a step so workflow replay never re-executes side effects and
// never re-derives a different date.
export async function runD1Backup(
  env: D1BackupEnv,
  step: BackupStepper,
  params: D1BackupParams = {}
): Promise<D1BackupResult> {
  const keepDays = params.keepDays ?? DEFAULT_KEEP_DAYS;

  const header = await step.do('plan', async () => {
    const date = params.date ?? new Date().toISOString().slice(0, 10);
    const prefix = `${BACKUP_ROOT}${date}`;
    const startedAt = new Date().toISOString();
    const plan = await planBackup(env);
    await env.R2.put(`${prefix}/schema.sql`, plan.schemaSql, {
      httpMetadata: { contentType: 'application/sql' },
      customMetadata: { hash: fnv1a(plan.schemaSql) },
    });
    return { date, prefix, startedAt, tables: plan.tables, skipped: plan.skipped };
  });

  const tableMetas: BackupTableMeta[] = [];
  let seq = 0;
  let totalRows = 0;
  let totalBytes = 0;

  for (const table of header.tables) {
    let cursor: DumpCursor | null = null;
    let part = 0;
    const meta: BackupTableMeta = { name: table, rows: 0, mode: 'rowid', parts: [] };

    do {
      if (part >= MAX_PARTS_PER_TABLE) {
        throw new Error(`D1_BACKUP_PART_CAP:${table}: exceeded ${MAX_PARTS_PER_TABLE} parts — raise the cap deliberately if the table is really this large`);
      }
      const inCursor: DumpCursor | null = cursor;
      const partSeq = ++seq;
      const currentPart = part;
      const stepResult: { rows: number; bytes: number; hash: string | null; key: string | null; nextCursor: DumpCursor | null; mode: 'rowid' | 'offset' } =
        await step.do(`dump:${table}:${String(currentPart).padStart(4, '0')}`, async () => {
          const dumped = await dumpTablePart(env, table, inCursor);
          if (dumped.rows === 0) {
            return { rows: 0, bytes: 0, hash: null, key: null, nextCursor: dumped.nextCursor, mode: dumped.mode };
          }
          const key = partKey(header.prefix, partSeq, table);
          const hash = fnv1a(dumped.lines);
          await env.R2.put(key, dumped.lines, {
            httpMetadata: { contentType: 'application/x-ndjson' },
            customMetadata: { table, rows: String(dumped.rows), hash },
          });
          return { rows: dumped.rows, bytes: dumped.bytes, hash, key, nextCursor: dumped.nextCursor, mode: dumped.mode };
        });

      meta.mode = stepResult.mode;
      if (stepResult.key && stepResult.hash) {
        meta.parts.push({ key: stepResult.key, rows: stepResult.rows, bytes: stepResult.bytes, hash: stepResult.hash });
        meta.rows += stepResult.rows;
        totalRows += stepResult.rows;
        totalBytes += stepResult.bytes;
      }
      cursor = stepResult.nextCursor;
      part++;
    } while (cursor);

    tableMetas.push(meta);
  }

  await step.do('manifest', async () => {
    const finishedAt = new Date().toISOString();
    const manifest = {
      format: BACKUP_FORMAT,
      database: 'medina-ventures-db',
      environment: env.ENVIRONMENT ?? 'unknown',
      date: header.date,
      started_at: header.startedAt,
      finished_at: finishedAt,
      consistency: 'per-table sequential snapshot; not point-in-time — use D1 Time Travel for <=30d point-in-time recovery',
      schema_key: `${header.prefix}/schema.sql`,
      tables: tableMetas,
      skipped: header.skipped,
      total_rows: totalRows,
      total_bytes: totalBytes,
    };
    const body = JSON.stringify(manifest, null, 2);
    // Manifest is the completion marker: written only after every part
    // landed. latest.json is a convenience pointer for tooling.
    await env.R2.put(`${header.prefix}/manifest.json`, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { hash: fnv1a(body) },
    });
    await env.R2.put(`${BACKUP_ROOT}latest.json`, JSON.stringify({
      date: header.date,
      prefix: header.prefix,
      manifest_key: `${header.prefix}/manifest.json`,
      finished_at: finishedAt,
      total_rows: totalRows,
    }), { httpMetadata: { contentType: 'application/json' } });
    return { finishedAt };
  });

  const retention = await step.do('retention', async () => runBackupRetention(env, keepDays));

  return {
    prefix: header.prefix,
    date: header.date,
    tables: tableMetas.length,
    rows: totalRows,
    parts: tableMetas.reduce((sum, t) => sum + t.parts.length, 0),
    bytes: totalBytes,
    skipped: header.skipped,
    retention,
  };
}

export const __d1BackupTestHooks = {
  classifySqliteMaster,
  dumpTablePart,
  runBackupRetention,
  fnv1a,
  serializeRow,
  MAX_PART_BYTES,
  MAX_PART_ROWS,
  DEFAULT_KEEP_DAYS,
};

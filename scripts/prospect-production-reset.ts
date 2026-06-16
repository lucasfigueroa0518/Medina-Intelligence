#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const RESET_CONFIRMATION = 'PROSPECT_RESET_GO';
const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const DEFAULT_PAGE_SIZE = 250;
const MAX_D1_ATTEMPTS = 3;

type TableExport = {
  table: string;
  exists: boolean;
  expectedRows: number;
  rows: number;
  file: string | null;
  sha256: string | null;
};

type D1Meta = {
  query_count: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
};

type Args = {
  orgId: string;
  database: string;
  outputDir: string;
  apply: boolean;
  confirmProductionWrite: string | null;
};

const scopedTables = [
  'prospects',
  'prospect_signals',
  'prospect_classification_history',
  'prospect_soft_links',
  'prospect_merge_audit',
  'prospect_classifier_samples',
  'prospect_backfill_runs',
  'prospect_backfill_coverage',
  'entity_identity_aliases',
  'prospect_classifier_cache',
  'prospect_llm_cache',
] as const;

const deleteStatements = [
  `DELETE FROM prospect_classification_history WHERE org_id = ?`,
  `DELETE FROM prospect_classifier_samples WHERE org_id = ?`,
  `DELETE FROM prospect_merge_audit WHERE org_id = ?`,
  `DELETE FROM prospect_soft_links WHERE org_id = ?`,
  `DELETE FROM prospect_signals WHERE org_id = ?`,
  `DELETE FROM prospects WHERE org_id = ?`,
  `DELETE FROM prospect_backfill_coverage WHERE org_id = ?`,
  `DELETE FROM prospect_backfill_runs WHERE org_id = ?`,
  `DELETE FROM work_queue WHERE org_id = ? AND domain = 'prospect_detect'`,
  `DELETE FROM entity_identity_aliases WHERE org_id = ? AND entity_type = 'prospect'`,
  `DELETE FROM prospect_classifier_cache WHERE org_id = ?`,
  `DELETE FROM prospect_llm_cache WHERE org_id = ?`,
];

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      index += 1;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    orgId: raw.get('org-id') || DEFAULT_ORG_ID,
    database: raw.get('database') || DEFAULT_DATABASE,
    outputDir: resolve(raw.get('output-dir') || join('outputs', `prospect-production-reset-backup-${stamp}`)),
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function bindSql(sql: string, binds: unknown[]): string {
  let bindIndex = 0;
  const out = sql.replace(/\?/g, () => {
    const value = binds[bindIndex++];
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value === null || typeof value === 'undefined') return 'NULL';
    return sqlString(String(value));
  });
  if (bindIndex !== binds.length) throw new Error('BIND_COUNT_MISMATCH');
  return out;
}

class WranglerD1 {
  meta: D1Meta = { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false };

  constructor(private readonly database: string) {}

  execute<T = any>(sql: string): T[] {
    let stdout = '';
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_D1_ATTEMPTS; attempt++) {
      try {
        stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', this.database, '--remote', '--json', '--command', sql], {
          cwd: process.cwd(),
          encoding: 'utf8',
          maxBuffer: 120 * 1024 * 1024,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_D1_ATTEMPTS) sleepSync(750 * attempt);
      }
    }
    if (lastError) throw new Error(formatWranglerError(lastError, sql));
    let parsed: Array<{ results?: T[]; success?: boolean; meta?: Partial<D1Meta> }>;
    try {
      parsed = JSON.parse(stdout) as Array<{ results?: T[]; success?: boolean; meta?: Partial<D1Meta> }>;
    } catch (error) {
      throw new Error(`WRANGLER_D1_JSON_PARSE_FAILED:${String(error)}:${stdout.slice(0, 1000)}`);
    }
    const first = parsed[0] || {};
    if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
    this.meta.query_count += 1;
    this.meta.rows_read += Number(first.meta?.rows_read || 0);
    this.meta.rows_written += Number(first.meta?.rows_written || 0);
    this.meta.changed_db = Boolean(this.meta.changed_db || first.meta?.changed_db);
    return first.results || [];
  }

  run(sql: string, binds: unknown[] = []): void {
    this.execute(bindSql(sql, binds));
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function formatWranglerError(error: unknown, sql: string): string {
  const maybe = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
  const stdout = typeof maybe.stdout === 'string' ? maybe.stdout : maybe.stdout?.toString('utf8') || '';
  const stderr = typeof maybe.stderr === 'string' ? maybe.stderr : maybe.stderr?.toString('utf8') || '';
  return [
    `WRANGLER_D1_COMMAND_FAILED status=${maybe.status ?? 'unknown'}`,
    maybe.message ? `message=${maybe.message}` : null,
    stderr ? `stderr=${stderr.slice(0, 2000)}` : null,
    stdout ? `stdout=${stdout.slice(0, 2000)}` : null,
    `sql=${sql.slice(0, 1000)}`,
  ].filter(Boolean).join('\n');
}

function tableExists(db: WranglerD1, table: string): boolean {
  const rows = db.execute<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlString(table)}`
  );
  return rows.some(row => row.name === table);
}

function countTable(db: WranglerD1, table: string, orgId: string): number {
  if (table === 'work_queue') {
    return Number(db.execute<{ count: number }>(
      `SELECT COUNT(*) AS count FROM work_queue WHERE org_id=${sqlString(orgId)} AND domain='prospect_detect'`
    )[0]?.count || 0);
  }
  if (table === 'entity_identity_aliases') {
    return Number(db.execute<{ count: number }>(
      `SELECT COUNT(*) AS count FROM entity_identity_aliases WHERE org_id=${sqlString(orgId)} AND entity_type='prospect'`
    )[0]?.count || 0);
  }
  return Number(db.execute<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE org_id=${sqlString(orgId)}`
  )[0]?.count || 0);
}

function exportPageSize(table: string): number {
  if (table === 'prospect_classification_history') return 50;
  if (table === 'prospect_signals') return 100;
  if (table === 'prospect_classifier_samples') return 100;
  if (table === 'work_queue') return 100;
  return DEFAULT_PAGE_SIZE;
}

function exportTable(db: WranglerD1, table: string, orgId: string, outputDir: string): TableExport {
  const exists = table === 'work_queue' ? tableExists(db, table) : tableExists(db, table);
  if (!exists) return { table, exists: false, expectedRows: 0, rows: 0, file: null, sha256: null };
  const expected = countTable(db, table, orgId);
  const file = join(outputDir, `${table}.jsonl`);
  const chunks: string[] = [];
  const pageSize = exportPageSize(table);
  for (let offset = 0; offset < expected; offset += pageSize) {
    const where = table === 'work_queue'
      ? `org_id=${sqlString(orgId)} AND domain='prospect_detect'`
      : table === 'entity_identity_aliases'
        ? `org_id=${sqlString(orgId)} AND entity_type='prospect'`
        : `org_id=${sqlString(orgId)}`;
    const rows = db.execute<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`
    );
    chunks.push(...rows.map(row => JSON.stringify(row)));
  }
  const body = chunks.length ? `${chunks.join('\n')}\n` : '';
  writeFileSync(file, body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { table, exists: true, expectedRows: expected, rows: chunks.length, file, sha256 };
}

function activeProspectWorkCount(db: WranglerD1, orgId: string): number {
  if (!tableExists(db, 'work_queue')) return 0;
  return Number(db.execute<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE org_id=${sqlString(orgId)}
        AND domain='prospect_detect'
        AND status IN ('pending','in_progress')`
  )[0]?.count || 0);
}

function assertBackupComplete(exports: TableExport[]): void {
  const missing = exports.filter(row => row.exists && (!row.file || !row.sha256 || !existsSync(row.file)));
  if (missing.length > 0) {
    throw new Error(`PROSPECT_RESET_BACKUP_INCOMPLETE:${missing.map(row => row.table).join(',')}`);
  }
  const mismatched = exports.filter(row => row.exists && row.rows !== row.expectedRows);
  if (mismatched.length > 0) {
    throw new Error(`PROSPECT_RESET_BACKUP_COUNT_MISMATCH:${mismatched
      .map(row => `${row.table}:${row.rows}/${row.expectedRows}`)
      .join(',')}`);
  }
}

export async function runProspectProductionReset(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });
  const db = new WranglerD1(args.database);
  const tables = [...scopedTables, 'work_queue'];
  const exports = tables.map(table => exportTable(db, table, args.orgId, args.outputDir));
  assertBackupComplete(exports);
  const activeWork = activeProspectWorkCount(db, args.orgId);
  const manifest = {
    dry_run: !args.apply,
    org_id: args.orgId,
    database: args.database,
    output_dir: args.outputDir,
    active_prospect_work: activeWork,
    exports,
    d1_meta_before_delete: { ...db.meta },
    deleted: false,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.pre-delete.json'), JSON.stringify(manifest, null, 2));

  if (activeWork > 0) {
    throw new Error(`PROSPECT_RESET_ACTIVE_WORK:${activeWork}`);
  }
  if (!args.apply) return manifest;
  if (args.confirmProductionWrite !== RESET_CONFIRMATION) {
    throw new Error(`PROSPECT_RESET_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${RESET_CONFIRMATION}`);
  }

  for (const statement of deleteStatements) {
    const table = statement.match(/DELETE FROM\s+([a-z_]+)/i)?.[1] || '';
    if (table && !tableExists(db, table)) continue;
    db.run(statement, [args.orgId]);
  }
  const after = {
    prospects: tableExists(db, 'prospects') ? countTable(db, 'prospects', args.orgId) : 0,
    prospect_signals: tableExists(db, 'prospect_signals') ? countTable(db, 'prospect_signals', args.orgId) : 0,
    prospect_classifier_samples: tableExists(db, 'prospect_classifier_samples') ? countTable(db, 'prospect_classifier_samples', args.orgId) : 0,
    prospect_backfill_runs: tableExists(db, 'prospect_backfill_runs') ? countTable(db, 'prospect_backfill_runs', args.orgId) : 0,
    prospect_backfill_coverage: tableExists(db, 'prospect_backfill_coverage') ? countTable(db, 'prospect_backfill_coverage', args.orgId) : 0,
    prospect_detect_work_queue: tableExists(db, 'work_queue') ? countTable(db, 'work_queue', args.orgId) : 0,
  };
  const finalManifest = {
    ...manifest,
    deleted: true,
    after,
    d1_meta_after_delete: db.meta,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.json'), JSON.stringify(finalManifest, null, 2));
  return finalManifest;
}

async function main(): Promise<void> {
  const summary = await runProspectProductionReset(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

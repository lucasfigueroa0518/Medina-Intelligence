#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { PROSPECT_CLASSIFIER_VERSION } from '../src/lib/prospect-intelligence';

const CLEANUP_CONFIRMATION = 'PROSPECT_CUTOVER_CLEANUP_GO';
const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const MAX_D1_ATTEMPTS = 3;

type Args = {
  orgId: string;
  database: string;
  outputDir: string;
  apply: boolean;
  confirmProductionWrite: string | null;
};

type D1Meta = {
  query_count: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
};

type ProspectSignal = {
  id: string;
  org_id: string;
  prospect_id: string | null;
  source_type: string;
  source_id: string;
  mention_ordinal: number;
  raw_mention_text: string | null;
  normalized_mention: string | null;
  mention_type: string | null;
  classifier_version: string | null;
  resolution_status: string | null;
  metadata_json: string | null;
};

type Prospect = {
  id: string;
  normalized_name: string;
};

type SignalUpdate = {
  id: string;
  action: 'link_to_existing_prospect' | 'demote_to_noise';
  prospect_id: string | null;
  normalized_mention: string | null;
  raw_mention_text: string | null;
  reason: string;
};

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
    outputDir: resolve(raw.get('output-dir') || join('outputs', `prospect-cutover-cleanup-${stamp}`)),
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
  };
}

function sqlString(value: string | null | undefined): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeProspectName(value: string | null | undefined): string {
  let text = String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co)\b\.?/g, ' ')
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  text = text.replace(/\b(ai|technologies|technology|labs|systems)\b$/g, '').trim();
  return text.replace(/\s+/g, '');
}

function readMetadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeJsonl(path: string, rows: unknown[]): string {
  const body = rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
  writeFileSync(path, body);
  return createHash('sha256').update(body).digest('hex');
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
    const parsed = parseWranglerJson(stdout) as Array<{ results?: T[]; success?: boolean; meta?: Partial<D1Meta> }>;
    const first = parsed[0] || {};
    if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
    this.meta.query_count += 1;
    this.meta.rows_read += Number(first.meta?.rows_read || 0);
    this.meta.rows_written += Number(first.meta?.rows_written || 0);
    this.meta.changed_db = Boolean(this.meta.changed_db || first.meta?.changed_db);
    return first.results || [];
  }

  run(sql: string): void {
    this.execute(sql);
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function parseWranglerJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const jsonStart = stdout.lastIndexOf('\n[');
    if (jsonStart >= 0) return JSON.parse(stdout.slice(jsonStart + 1));
    const trimmed = stdout.trim();
    const bracketStart = trimmed.indexOf('[');
    if (bracketStart >= 0) return JSON.parse(trimmed.slice(bracketStart));
    throw new Error(`WRANGLER_JSON_PARSE_FAILED:${stdout.slice(0, 500)}`);
  }
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

function activeProspectWorkCount(db: WranglerD1, orgId: string): number {
  return Number(db.execute<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE org_id=${sqlString(orgId)}
        AND domain='prospect_detect'
        AND status IN ('pending','in_progress')`
  )[0]?.count || 0);
}

function indexProspects(rows: Prospect[]): Map<string, Prospect[]> {
  const out = new Map<string, Prospect[]>();
  for (const prospect of rows) {
    const key = prospect.normalized_name;
    if (!key) continue;
    const group = out.get(key) || [];
    group.push(prospect);
    out.set(key, group);
  }
  return out;
}

function cleanupMetadata(signal: ProspectSignal, update: SignalUpdate): string {
  return JSON.stringify({
    ...readMetadata(signal.metadata_json),
    cutover_cleanup: {
      applied_at: new Date().toISOString(),
      action: update.action,
      reason: update.reason,
      previous_mention_type: signal.mention_type,
      previous_prospect_id: signal.prospect_id,
      classifier_version: signal.classifier_version,
    },
  });
}

function planUnlinkedInboundUpdates(signals: ProspectSignal[], prospectsByNormalized: Map<string, Prospect[]>): SignalUpdate[] {
  return signals.map(signal => {
    const metadata = readMetadata(signal.metadata_json);
    const prospectAction = String(metadata.prospect_action || '');
    const shouldCreate = metadata.should_create_prospect === true || metadata.should_create_prospect === 1;
    const normalized = signal.normalized_mention || normalizeProspectName(signal.raw_mention_text);
    const matches = prospectsByNormalized.get(normalized) || [];
    if (prospectAction === 'create_prospect' && shouldCreate && matches.length === 1) {
      return {
        id: signal.id,
        action: 'link_to_existing_prospect',
        prospect_id: matches[0].id,
        normalized_mention: normalized,
        raw_mention_text: signal.raw_mention_text,
        reason: 'unlinked_create_signal_exact_normalized_prospect_match',
      };
    }
    return {
      id: signal.id,
      action: 'demote_to_noise',
      prospect_id: null,
      normalized_mention: normalized,
      raw_mention_text: signal.raw_mention_text,
      reason: prospectAction === 'create_prospect' && shouldCreate
        ? 'unlinked_create_signal_no_unambiguous_prospect_match'
        : 'unlinked_context_signal_must_not_present_as_inbound_prospect',
    };
  });
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

function exportTargetRows(args: Args, oldSignals: unknown[], oldSamples: unknown[], oldHistory: unknown[], unlinkedInbound: ProspectSignal[], updates: SignalUpdate[]): Record<string, unknown> {
  mkdirSync(args.outputDir, { recursive: true });
  const files = [
    { name: 'old-prospect-signals', rows: oldSignals },
    { name: 'old-classifier-samples', rows: oldSamples },
    { name: 'old-classification-history', rows: oldHistory },
    { name: 'unlinked-inbound-prospect-signals', rows: unlinkedInbound },
    { name: 'planned-signal-updates', rows: updates },
  ].map(file => {
    const path = join(args.outputDir, `${file.name}.jsonl`);
    return { ...file, path, count: file.rows.length, sha256: writeJsonl(path, file.rows) };
  });
  return { files };
}

function deleteByIds(db: WranglerD1, table: string, ids: string[]): void {
  for (const idsChunk of chunk(ids, 75)) {
    if (idsChunk.length === 0) continue;
    db.run(`DELETE FROM ${table} WHERE id IN (${idsChunk.map(sqlString).join(',')})`);
  }
}

function recomputeProspectAggregates(db: WranglerD1, orgId: string): void {
  db.run(`UPDATE prospects
     SET signal_count = COALESCE((
           SELECT COUNT(*)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
         ), 0),
         evidence_count = COALESCE((
           SELECT COUNT(*)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.classification_status = 'classified'
              AND s.resolution_status = 'resolved'
         ), 0),
         first_seen_at = COALESCE((
           SELECT MIN(s.occurred_at)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.occurred_at IS NOT NULL
         ), first_seen_at),
         last_seen_at = COALESCE((
           SELECT MAX(s.occurred_at)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.occurred_at IS NOT NULL
         ), last_seen_at),
         last_signal_at = COALESCE((
           SELECT MAX(s.occurred_at)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.occurred_at IS NOT NULL
         ), last_signal_at),
         confidence = COALESCE((
           SELECT MAX(s.confidence)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
         ), confidence),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE org_id = ${sqlString(orgId)}
     AND deleted_at IS NULL;`);
}

function verificationCounts(db: WranglerD1, orgId: string): Record<string, number> {
  const count = (sql: string): number => Number(db.execute<{ count: number }>(sql)[0]?.count || 0);
  return {
    old_classifier_signals: count(
      `SELECT COUNT(*) AS count
         FROM prospect_signals
        WHERE org_id=${sqlString(orgId)}
          AND classifier_version <> ${sqlString(PROSPECT_CLASSIFIER_VERSION)}`
    ),
    old_classifier_samples: count(
      `SELECT COUNT(*) AS count
         FROM prospect_classifier_samples pcs
         LEFT JOIN prospect_signals s ON s.id = pcs.prospect_signal_id AND s.org_id = pcs.org_id
        WHERE pcs.org_id=${sqlString(orgId)}
          AND s.classifier_version IS NOT NULL
          AND s.classifier_version <> ${sqlString(PROSPECT_CLASSIFIER_VERSION)}`
    ),
    old_classifier_history: count(
      `SELECT COUNT(*) AS count
         FROM prospect_classification_history
        WHERE org_id=${sqlString(orgId)}
          AND classifier_version <> ${sqlString(PROSPECT_CLASSIFIER_VERSION)}`
    ),
    prospect_detect_work_queue: count(
      `SELECT COUNT(*) AS count
         FROM work_queue
        WHERE org_id=${sqlString(orgId)}
          AND domain='prospect_detect'`
    ),
    unlinked_inbound_prospect_signals: count(
      `SELECT COUNT(*) AS count
         FROM prospect_signals
        WHERE org_id=${sqlString(orgId)}
          AND mention_type='inbound_prospect'
          AND prospect_id IS NULL`
    ),
    duplicate_active_prospect_names: count(
      `SELECT COUNT(*) AS count
         FROM (
          SELECT normalized_name
            FROM prospects
           WHERE org_id=${sqlString(orgId)}
             AND deleted_at IS NULL
           GROUP BY normalized_name
          HAVING COUNT(*) > 1
         )`
    ),
    prospects_without_signals: count(
      `SELECT COUNT(*) AS count
         FROM prospects p
        WHERE p.org_id=${sqlString(orgId)}
          AND p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM prospect_signals s WHERE s.org_id=p.org_id AND s.prospect_id=p.id
          )`
    ),
    aggregate_mismatches: count(
      `SELECT COUNT(*) AS count
         FROM prospects p
         LEFT JOIN (
          SELECT prospect_id, COUNT(*) AS actual_signal_count,
                 SUM(CASE WHEN classification_status='classified' AND resolution_status='resolved' THEN 1 ELSE 0 END) AS actual_evidence_count
            FROM prospect_signals
           WHERE org_id=${sqlString(orgId)}
             AND prospect_id IS NOT NULL
           GROUP BY prospect_id
         ) s ON s.prospect_id=p.id
        WHERE p.org_id=${sqlString(orgId)}
          AND p.deleted_at IS NULL
          AND (
            p.signal_count <> COALESCE(s.actual_signal_count,0)
            OR p.evidence_count <> COALESCE(s.actual_evidence_count,0)
          )`
    ),
  };
}

export async function runProspectCutoverCleanup(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });
  const db = new WranglerD1(args.database);
  const activeWork = activeProspectWorkCount(db, args.orgId);
  if (activeWork > 0) throw new Error(`PROSPECT_CUTOVER_CLEANUP_ACTIVE_WORK:${activeWork}`);

  const oldSignals = db.execute<Record<string, unknown>>(
    `SELECT *
       FROM prospect_signals
      WHERE org_id=${sqlString(args.orgId)}
        AND classifier_version <> ${sqlString(PROSPECT_CLASSIFIER_VERSION)}
      ORDER BY created_at, id`
  );
  const oldSamples = db.execute<Record<string, unknown>>(
    `SELECT pcs.*
       FROM prospect_classifier_samples pcs
       JOIN prospect_signals s ON s.id = pcs.prospect_signal_id AND s.org_id = pcs.org_id
      WHERE pcs.org_id=${sqlString(args.orgId)}
        AND s.classifier_version <> ${sqlString(PROSPECT_CLASSIFIER_VERSION)}
      ORDER BY pcs.created_at, pcs.id`
  );
  const oldHistory = db.execute<Record<string, unknown>>(
    `SELECT *
       FROM prospect_classification_history
      WHERE org_id=${sqlString(args.orgId)}
        AND classifier_version <> ${sqlString(PROSPECT_CLASSIFIER_VERSION)}
      ORDER BY created_at, id`
  );
  const unlinkedInbound = db.execute<ProspectSignal>(
    `SELECT id, org_id, prospect_id, source_type, source_id, mention_ordinal,
            raw_mention_text, normalized_mention, mention_type, classifier_version,
            resolution_status, metadata_json
       FROM prospect_signals
      WHERE org_id=${sqlString(args.orgId)}
        AND mention_type='inbound_prospect'
        AND prospect_id IS NULL
      ORDER BY created_at, id`
  );
  const prospects = db.execute<Prospect>(
    `SELECT id, normalized_name
       FROM prospects
      WHERE org_id=${sqlString(args.orgId)}
        AND deleted_at IS NULL`
  );
  const updates = planUnlinkedInboundUpdates(unlinkedInbound, indexProspects(prospects));
  const backup = exportTargetRows(args, oldSignals, oldSamples, oldHistory, unlinkedInbound, updates);
  const beforeCounts = verificationCounts(db, args.orgId);
  const manifest = {
    dry_run: !args.apply,
    org_id: args.orgId,
    database: args.database,
    output_dir: args.outputDir,
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    active_prospect_work: activeWork,
    targets: {
      old_signals: oldSignals.length,
      old_samples: oldSamples.length,
      old_history: oldHistory.length,
      unlinked_inbound_signals: unlinkedInbound.length,
      signal_updates: updates.length,
      link_updates: updates.filter(row => row.action === 'link_to_existing_prospect').length,
      demotions: updates.filter(row => row.action === 'demote_to_noise').length,
    },
    backup,
    before_counts: beforeCounts,
    d1_meta_before_apply: { ...db.meta },
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.pre-apply.json'), JSON.stringify(manifest, null, 2));
  if (!args.apply) return manifest;
  if (args.confirmProductionWrite !== CLEANUP_CONFIRMATION) {
    throw new Error(`PROSPECT_CUTOVER_CLEANUP_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${CLEANUP_CONFIRMATION}`);
  }
  for (const file of (backup.files as Array<{ path: string; count: number }>)) {
    if (file.count > 0 && !existsSync(file.path)) throw new Error(`PROSPECT_CUTOVER_CLEANUP_BACKUP_MISSING:${file.path}`);
  }

  deleteByIds(db, 'prospect_classifier_samples', oldSamples.map(row => String(row.id)));
  deleteByIds(db, 'prospect_classification_history', oldHistory.map(row => String(row.id)));
  deleteByIds(db, 'prospect_signals', oldSignals.map(row => String(row.id)));

  const signalsById = new Map(unlinkedInbound.map(signal => [signal.id, signal]));
  for (const update of updates) {
    const signal = signalsById.get(update.id);
    if (!signal) continue;
    const metadata = cleanupMetadata(signal, update);
    if (update.action === 'link_to_existing_prospect' && update.prospect_id) {
      db.run(`UPDATE prospect_signals
                 SET prospect_id=${sqlString(update.prospect_id)},
                     mention_type='inbound_prospect',
                     resolution_status='resolved',
                     metadata_json=${sqlString(metadata)},
                     updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE org_id=${sqlString(args.orgId)}
                 AND id=${sqlString(update.id)}`);
    } else {
      db.run(`UPDATE prospect_signals
                 SET prospect_id=NULL,
                     mention_type='noise',
                     resolution_status=CASE WHEN json_extract(metadata_json, '$.prospect_action')='ignore' THEN 'dropped' ELSE 'resolved' END,
                     metadata_json=${sqlString(metadata)},
                     updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE org_id=${sqlString(args.orgId)}
                 AND id=${sqlString(update.id)}`);
    }
  }
  recomputeProspectAggregates(db, args.orgId);
  const afterCounts = verificationCounts(db, args.orgId);
  const summary = {
    ...manifest,
    dry_run: false,
    applied: true,
    after_counts: afterCounts,
    d1_meta_after_apply: db.meta,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.json'), JSON.stringify(summary, null, 2));
  return summary;
}

async function main(): Promise<void> {
  const summary = await runProspectCutoverCleanup(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

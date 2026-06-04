#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

type SourceFamily = 'conversation' | 'event' | 'document';

const BACKFILL_ENQUEUE_CONFIRMATION = 'PROSPECT_BACKFILL_ENQUEUE_GO';
const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const DEFAULT_LOOKBACK_HOURS = 168;
const DEFAULT_MAX_SOURCE_ROWS = 10_000;
const DEFAULT_SCHEDULE_RATE_PER_MINUTE = 10;

interface Args {
  orgId: string;
  database: string;
  windowStart: string;
  windowEnd: string;
  sourceFamilies: SourceFamily[];
  apply: boolean;
  confirmProductionWrite: string | null;
  maxSourceRows: number;
  priority: number;
  scheduleRatePerMinute: number;
  origin: string;
}

interface D1Meta {
  query_count: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
}

interface D1ExecuteResult<T = any> {
  results: T[];
  meta?: Partial<D1Meta>;
}

interface D1Executor {
  execute<T = any>(sql: string): Promise<D1ExecuteResult<T>>;
  meta: D1Meta;
}

interface FamilyPlan {
  source_family: SourceFamily;
  candidates: number;
  already_queued: number;
  inserted: number;
}

export interface ProspectBackfillEnqueueSummary {
  dry_run: boolean;
  org_id: string;
  database: string;
  run_id: string | null;
  window_start: string;
  window_end: string;
  source_families: SourceFamily[];
  total_candidates: number;
  total_already_queued: number;
  total_inserted: number;
  priority: number;
  schedule_rate_per_minute: number;
  origin: string;
  family_plan: FamilyPlan[];
  work_queue_status_after: Array<{ status: string; count: number }>;
  d1_meta: D1Meta;
}

function parseArgs(argv: string[], now = new Date()): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      i += 1;
    }
  }

  const sourceFamilies = String(raw.get('source-families') || 'conversation,event,document')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean) as SourceFamily[];
  if (sourceFamilies.length === 0 || sourceFamilies.some(value => !['conversation', 'event', 'document'].includes(value))) {
    throw new Error('INVALID_SOURCE_FAMILIES');
  }

  const lookbackHours = Number(raw.get('lookback-hours') || DEFAULT_LOOKBACK_HOURS);
  if (!Number.isFinite(lookbackHours) || lookbackHours < 1 || lookbackHours > 24 * 365) {
    throw new Error('INVALID_LOOKBACK_HOURS');
  }

  const windowEnd = raw.get('window-end') || now.toISOString();
  const windowStart = raw.get('window-start') || new Date(new Date(windowEnd).getTime() - Math.floor(lookbackHours) * 3_600_000).toISOString();
  assertWindow(windowStart, windowEnd);

  const maxSourceRows = Number(raw.get('max-source-rows') || DEFAULT_MAX_SOURCE_ROWS);
  if (!Number.isFinite(maxSourceRows) || maxSourceRows < 1 || maxSourceRows > 250_000) {
    throw new Error('INVALID_MAX_SOURCE_ROWS');
  }

  const priority = Number(raw.get('priority') || 20);
  if (!Number.isFinite(priority) || priority < -100 || priority > 100) {
    throw new Error('INVALID_PRIORITY');
  }

  const scheduleRatePerMinute = Number(raw.get('schedule-rate-per-minute') || DEFAULT_SCHEDULE_RATE_PER_MINUTE);
  if (!Number.isFinite(scheduleRatePerMinute) || scheduleRatePerMinute < 1 || scheduleRatePerMinute > 10) {
    throw new Error('INVALID_SCHEDULE_RATE_PER_MINUTE');
  }

  return {
    orgId: raw.get('org-id') || DEFAULT_ORG_ID,
    database: raw.get('database') || DEFAULT_DATABASE,
    windowStart,
    windowEnd,
    sourceFamilies,
    apply: raw.get('apply') === 'true' || raw.get('enqueue') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
    maxSourceRows: Math.floor(maxSourceRows),
    priority: Math.floor(priority),
    scheduleRatePerMinute: Math.floor(scheduleRatePerMinute),
    origin: raw.get('origin') || 'prospect_backfill_large',
  };
}

function assertWindow(windowStart: string, windowEnd: string): void {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (!windowStart || !windowEnd || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('INVALID_BACKFILL_WINDOW');
  }
  if (start >= end) throw new Error('INVALID_BACKFILL_WINDOW_RANGE');
}

function assertWriteAllowed(args: Args, totalCandidates: number): void {
  if (!args.apply) return;
  if (args.confirmProductionWrite !== BACKFILL_ENQUEUE_CONFIRMATION) {
    throw new Error(`PROSPECT_BACKFILL_ENQUEUE_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${BACKFILL_ENQUEUE_CONFIRMATION} only after Lucas GO`);
  }
  if (totalCandidates > args.maxSourceRows) {
    throw new Error(`PROSPECT_BACKFILL_ENQUEUE_TOO_LARGE: ${totalCandidates} source rows exceeds --max-source-rows ${args.maxSourceRows}`);
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function familySourceSql(family: SourceFamily, orgId: string, windowStart: string, windowEnd: string): string {
  const org = sqlString(orgId);
  const start = sqlString(windowStart);
  const end = sqlString(windowEnd);
  if (family === 'conversation') {
    return `
      SELECT c.org_id, c.id, c.sent_at AS occurred_at
        FROM conversations c
       WHERE c.org_id = ${org}
         AND c.sent_at >= ${start}
         AND c.sent_at < ${end}`;
  }
  if (family === 'event') {
    return `
      SELECT e.org_id, e.id, COALESCE(e.start_time, e.created_at) AS occurred_at
        FROM events e
       WHERE e.org_id = ${org}
         AND e.deleted_at IS NULL
         AND (
           (e.start_time >= ${start} AND e.start_time < ${end})
           OR (e.created_at >= ${start} AND e.created_at < ${end} AND e.start_time >= ${start})
         )`;
  }
  return `
    SELECT d.org_id, d.id, d.created_at AS occurred_at
      FROM documents d
     WHERE d.org_id = ${org}
       AND d.deleted_at IS NULL
       AND d.created_at >= ${start}
       AND d.created_at < ${end}`;
}

function idempotencyExpression(alias: string, family: SourceFamily): string {
  return `${alias}.org_id || ':${family}:' || ${alias}.id || ':prospect_detect:v1'`;
}

function countCandidatesSql(family: SourceFamily, orgId: string, windowStart: string, windowEnd: string): string {
  return `SELECT COUNT(*) AS count FROM (${familySourceSql(family, orgId, windowStart, windowEnd)}) src`;
}

function countAlreadyQueuedSql(family: SourceFamily, orgId: string, windowStart: string, windowEnd: string): string {
  return `
    SELECT COUNT(*) AS count
      FROM (${familySourceSql(family, orgId, windowStart, windowEnd)}) src
     WHERE EXISTS (
       SELECT 1
         FROM work_queue w
        WHERE w.domain = 'prospect_detect'
          AND w.idempotency_key = ${idempotencyExpression('src', family)}
     )`;
}

function insertRunSql(args: Args, runId: string, totalCandidates: number): string {
  return `
    INSERT INTO prospect_backfill_runs (
      id, org_id, window_start, window_end, cursor, status, source_families,
      items_found, items_processed, signals_recorded, measured_cost_per_item,
      estimated_total_cost, started_at, created_at, updated_at
    ) VALUES (
      ${sqlString(runId)},
      ${sqlString(args.orgId)},
      ${sqlString(args.windowStart)},
      ${sqlString(args.windowEnd)},
      'work_queue:prospect_detect',
      'pending',
      ${sqlString(JSON.stringify(args.sourceFamilies))},
      ${totalCandidates},
      0,
      0,
      NULL,
      NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )`;
}

function insertFamilyQueueSql(args: Args, family: SourceFamily, runId: string): string {
  const sourceSql = familySourceSql(family, args.orgId, args.windowStart, args.windowEnd);
  const scheduleRate = Math.max(1, args.scheduleRatePerMinute);
  return `
    WITH candidates AS (
      SELECT src.org_id,
             src.id,
             src.occurred_at,
             ROW_NUMBER() OVER (ORDER BY src.occurred_at ASC, src.id ASC) AS rn
        FROM (${sourceSql}) src
    )
    INSERT OR IGNORE INTO work_queue (
      org_id, domain, payload, upstream, idempotency_key, priority,
      max_attempts, next_attempt_at
    )
    SELECT c.org_id,
           'prospect_detect',
           json_object(
             'source_type', ${sqlString(family)},
             'source_id', c.id,
             'origin', ${sqlString(args.origin)},
             'detected_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             'ingestion_mode', 'backfill',
             'backfill_run_id', ${sqlString(runId)}
           ),
           'claude',
           ${idempotencyExpression('c', family)},
           ${args.priority},
           5,
           strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now',
             printf('+%d minutes', CAST((c.rn - 1) / ${scheduleRate} AS INTEGER))
           )
      FROM candidates c`;
}

function countRunInsertedSql(runId: string, family: SourceFamily): string {
  return `
    SELECT COUNT(*) AS count
      FROM work_queue
     WHERE domain = 'prospect_detect'
       AND json_extract(payload, '$.backfill_run_id') = ${sqlString(runId)}
       AND json_extract(payload, '$.source_type') = ${sqlString(family)}`;
}

function queueStatusSql(orgId: string): string {
  return `
    SELECT status, COUNT(*) AS count
      FROM work_queue
     WHERE org_id = ${sqlString(orgId)}
       AND domain = 'prospect_detect'
     GROUP BY status
     ORDER BY status ASC`;
}

class WranglerD1Executor implements D1Executor {
  meta: D1Meta = { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false };

  constructor(private readonly database: string) {}

  async execute<T = any>(sql: string): Promise<D1ExecuteResult<T>> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', this.database, '--remote', '--command', sql, '--json'], {
          cwd: process.cwd(),
          encoding: 'utf8',
          maxBuffer: 80 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as Array<{ results?: T[]; meta?: Partial<D1Meta>; success?: boolean }>;
        const first = parsed[0] || {};
        if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
        this.meta.query_count += 1;
        this.meta.rows_read += Number(first.meta?.rows_read || 0);
        this.meta.rows_written += Number(first.meta?.rows_written || 0);
        this.meta.changed_db = Boolean(this.meta.changed_db || first.meta?.changed_db);
        return { results: first.results || [], meta: first.meta };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 3 || !/(7403|429|5\d\d|ETIMEDOUT|ECONNRESET|fetch failed|network)/i.test(message)) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

async function countNumber(executor: D1Executor, sql: string): Promise<number> {
  const result = await executor.execute<{ count: number }>(sql);
  return Number(result.results[0]?.count || 0);
}

export async function runProspectBackfillEnqueue(
  args: Args,
  executor: D1Executor = new WranglerD1Executor(args.database)
): Promise<ProspectBackfillEnqueueSummary> {
  const familyPlan: FamilyPlan[] = [];
  for (const family of args.sourceFamilies) {
    const [candidates, alreadyQueued] = await Promise.all([
      countNumber(executor, countCandidatesSql(family, args.orgId, args.windowStart, args.windowEnd)),
      countNumber(executor, countAlreadyQueuedSql(family, args.orgId, args.windowStart, args.windowEnd)),
    ]);
    familyPlan.push({ source_family: family, candidates, already_queued: alreadyQueued, inserted: 0 });
  }

  const totalCandidates = familyPlan.reduce((sum, row) => sum + row.candidates, 0);
  const totalAlreadyQueued = familyPlan.reduce((sum, row) => sum + row.already_queued, 0);
  assertWriteAllowed(args, totalCandidates);

  let runId: string | null = null;
  let workQueueStatusAfter: Array<{ status: string; count: number }> = [];

  if (args.apply) {
    runId = crypto.randomUUID();
    await executor.execute(insertRunSql(args, runId, totalCandidates));
    for (const row of familyPlan) {
      await executor.execute(insertFamilyQueueSql(args, row.source_family, runId));
      row.inserted = await countNumber(executor, countRunInsertedSql(runId, row.source_family));
    }
    const status = await executor.execute<{ status: string; count: number }>(queueStatusSql(args.orgId));
    workQueueStatusAfter = (status.results || []).map(row => ({ status: row.status, count: Number(row.count || 0) }));
  }

  return {
    dry_run: !args.apply,
    org_id: args.orgId,
    database: args.database,
    run_id: runId,
    window_start: args.windowStart,
    window_end: args.windowEnd,
    source_families: args.sourceFamilies,
    total_candidates: totalCandidates,
    total_already_queued: totalAlreadyQueued,
    total_inserted: familyPlan.reduce((sum, row) => sum + row.inserted, 0),
    priority: args.priority,
    schedule_rate_per_minute: args.scheduleRatePerMinute,
    origin: args.origin,
    family_plan: familyPlan,
    work_queue_status_after: workQueueStatusAfter,
    d1_meta: executor.meta,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runProspectBackfillEnqueue(args);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

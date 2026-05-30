import type { Env } from '../types/env';
import {
  chooseCanonicalAttendee,
  mergeAttendeeRows,
  type EventAttendeeRow,
} from './event-attendees';
import { normalizeNewsSourceUrl } from './news-quality';

export type MaintenanceStep =
  | 'event_attendees'
  | 'stale_operations'
  | 'retention'
  | 'import_contacts'
  | 'news_articles'
  | 'cleanup_scratch';

export interface MaintenanceOptions {
  mode: 'preview' | 'run' | 'scheduled';
  orgId?: string | null;
  requestedByUserId?: string | null;
  steps?: MaintenanceStep[];
  batchSize?: number;
}

export interface MaintenanceReport {
  run_id?: string;
  mode: 'preview' | 'run' | 'scheduled';
  status: 'completed' | 'failed';
  r2_prefix?: string;
  steps: Record<string, Record<string, unknown>>;
  snapshots: SnapshotRecord[];
  error?: string;
}

interface SnapshotRecord {
  table: string;
  key: string;
  rows: number;
  hash: string;
}

interface RunContext {
  env: Env;
  runId: string;
  r2Prefix: string;
  snapshots: SnapshotRecord[];
  snapshotSeq: number;
  batchSize: number;
  orgId?: string | null;
}

const DEFAULT_STEPS: MaintenanceStep[] = [
  'event_attendees',
  'stale_operations',
  'retention',
  'import_contacts',
  'news_articles',
  'cleanup_scratch',
];

const SUCCESS_RETENTION_DAYS = 30;
const FAILURE_RETENTION_DAYS = 90;
const STALE_RUNNING_HOURS = 2;
const SQL_PARAM_LIMIT = 40;

function nowIso(): string {
  return new Date().toISOString();
}

function clampBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value || NaN)) return 250;
  return Math.max(10, Math.min(250, Math.floor(value || 250)));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function paramChunks<T>(items: T[], reservedParams = 0): T[][] {
  const size = Math.max(1, SQL_PARAM_LIMIT - reservedParams);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function tableExists(env: Env, table: string): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table','view')`
  ).bind(table).first<{ name: string }>();
  return !!row?.name;
}

async function snapshotRows(ctx: RunContext, table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const key = `${ctx.r2Prefix}/${String(++ctx.snapshotSeq).padStart(4, '0')}-${table}.jsonl`;
  const hash = fnv1a(lines);
  await ctx.env.R2.put(key, lines, {
    httpMetadata: { contentType: 'application/x-ndjson' },
    customMetadata: { table, rows: String(rows.length), hash },
  });
  ctx.snapshots.push({ table, key, rows: rows.length, hash });
}

async function snapshotByIds(ctx: RunContext, table: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const chunk of paramChunks(ids)) {
    const rows = await ctx.env.D1.prepare(
      `SELECT * FROM ${table} WHERE id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).all();
    await snapshotRows(ctx, table, rows.results || []);
  }
}

async function snapshotWholeTable(ctx: RunContext, table: string): Promise<number> {
  let offset = 0;
  let total = 0;
  while (true) {
    const rows = await ctx.env.D1.prepare(
      `SELECT * FROM ${table} LIMIT ? OFFSET ?`
    ).bind(500, offset).all();
    if (!rows.results.length) break;
    total += rows.results.length;
    await snapshotRows(ctx, table, rows.results);
    offset += rows.results.length;
    if (rows.results.length < 500) break;
  }
  return total;
}

async function deleteByIds(ctx: RunContext, table: string, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const chunk of paramChunks(ids)) {
    const result = await ctx.env.D1.prepare(
      `DELETE FROM ${table} WHERE id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).run();
    deleted += result.meta?.changes || 0;
  }
  return deleted;
}

async function selectIds(env: Env, sql: string, binds: unknown[]): Promise<string[]> {
  const rows = await env.D1.prepare(sql).bind(...binds).all<{ id: string }>();
  return rows.results.map(r => r.id).filter(Boolean);
}

export async function previewD1Maintenance(
  env: Env,
  options: Pick<MaintenanceOptions, 'orgId' | 'steps' | 'batchSize'> = {}
): Promise<MaintenanceReport> {
  const steps = options.steps?.length ? options.steps : DEFAULT_STEPS;
  const report: MaintenanceReport = {
    mode: 'preview',
    status: 'completed',
    steps: {},
    snapshots: [],
  };
  for (const step of steps) {
    report.steps[step] = await previewStep(env, step, options.orgId || null);
  }
  return report;
}

export async function runD1Maintenance(
  env: Env,
  options: MaintenanceOptions
): Promise<MaintenanceReport> {
  const steps = options.steps?.length ? options.steps : DEFAULT_STEPS;
  const runId = crypto.randomUUID();
  const date = nowIso().slice(0, 10);
  const r2Prefix = `maintenance/d1/${date}/${runId}`;
  const ctx: RunContext = {
    env,
    runId,
    r2Prefix,
    snapshots: [],
    snapshotSeq: 0,
    batchSize: clampBatchSize(options.batchSize),
    orgId: options.orgId || null,
  };

  const preview = await previewD1Maintenance(env, {
    orgId: options.orgId || null,
    steps,
    batchSize: options.batchSize,
  });

  await env.D1.prepare(
    `INSERT INTO maintenance_runs
       (id, org_id, mode, status, requested_by_user_id, steps, r2_prefix, preview_json)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`
  ).bind(
    runId,
    options.orgId || null,
    options.mode,
    options.requestedByUserId || null,
    JSON.stringify(steps),
    r2Prefix,
    JSON.stringify(preview.steps)
  ).run();

  const report: MaintenanceReport = {
    run_id: runId,
    mode: options.mode,
    status: 'completed',
    r2_prefix: r2Prefix,
    steps: {},
    snapshots: ctx.snapshots,
  };

  try {
    for (const step of steps) {
      report.steps[step] = await runStep(ctx, step);
    }
    await env.D1.prepare(
      `UPDATE maintenance_runs
          SET status = 'completed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              stats_json = ?
        WHERE id = ?`
    ).bind(JSON.stringify({ steps: report.steps, snapshots: ctx.snapshots }), runId).run();
  } catch (e: any) {
    report.status = 'failed';
    report.error = String(e?.message || e);
    await env.D1.prepare(
      `UPDATE maintenance_runs
          SET status = 'failed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              error_message = ?,
              stats_json = ?
        WHERE id = ?`
    ).bind(report.error, JSON.stringify({ steps: report.steps, snapshots: ctx.snapshots }), runId).run();
  }

  return report;
}

export async function getD1MaintenanceRun(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const run = await env.D1.prepare(
    `SELECT * FROM maintenance_runs WHERE id = ?`
  ).bind(id).first<any>();
  if (!run) return null;
  return {
    ...run,
    steps: safeJson(run.steps, []),
    preview: safeJson(run.preview_json, {}),
    stats: safeJson(run.stats_json, {}),
  };
}

export async function listD1MaintenanceRuns(env: Env, orgId: string, limit = 25): Promise<Record<string, unknown>[]> {
  const rows = await env.D1.prepare(
    `SELECT id, org_id, mode, status, requested_by_user_id, steps, r2_prefix,
            started_at, completed_at, created_at, error_message
       FROM maintenance_runs
      WHERE org_id IS NULL OR org_id = ?
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(orgId, Math.max(1, Math.min(limit, 100))).all<any>();
  return rows.results.map(r => ({ ...r, steps: safeJson(r.steps, []) }));
}

export async function runScheduledD1Maintenance(env: Env): Promise<MaintenanceReport> {
  return runD1Maintenance(env, {
    mode: 'scheduled',
    orgId: null,
    requestedByUserId: null,
    steps: ['stale_operations', 'retention'],
    batchSize: 500,
  });
}

async function previewStep(env: Env, step: MaintenanceStep, orgId: string | null): Promise<Record<string, unknown>> {
  switch (step) {
    case 'event_attendees': return previewEventAttendees(env);
    case 'stale_operations': return previewStaleOperations(env);
    case 'retention': return previewRetention(env);
    case 'import_contacts': return previewImportContacts(env, orgId);
    case 'news_articles': return previewNewsArticles(env, orgId);
    case 'cleanup_scratch': return previewScratch(env, orgId);
  }
}

async function runStep(ctx: RunContext, step: MaintenanceStep): Promise<Record<string, unknown>> {
  switch (step) {
    case 'event_attendees': return runEventAttendeeDedupe(ctx);
    case 'stale_operations': return runStaleOperations(ctx);
    case 'retention': return runRetention(ctx);
    case 'import_contacts': return runImportContactCleanup(ctx);
    case 'news_articles': return runNewsCleanup(ctx);
    case 'cleanup_scratch': return runScratchCleanup(ctx);
  }
}

async function previewEventAttendees(env: Env): Promise<Record<string, unknown>> {
  const row = await env.D1.prepare(
    `SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(cnt - 1), 0) AS duplicate_rows
       FROM (
         SELECT event_id, lower(trim(email)) AS email_norm, COUNT(*) AS cnt
           FROM event_attendees
          WHERE trim(email) != ''
          GROUP BY event_id, email_norm
         HAVING COUNT(*) > 1
       )`
  ).first<{ duplicate_groups: number; duplicate_rows: number }>();
  return {
    duplicate_groups: Number(row?.duplicate_groups || 0),
    duplicate_rows: Number(row?.duplicate_rows || 0),
  };
}

async function runEventAttendeeDedupe(ctx: RunContext): Promise<Record<string, unknown>> {
  const rows = await ctx.env.D1.prepare(
    `WITH duplicate_keys AS (
       SELECT event_id, lower(trim(email)) AS email_norm, COUNT(*) AS cnt
         FROM event_attendees
        WHERE trim(email) != ''
        GROUP BY event_id, email_norm
       HAVING COUNT(*) > 1
        ORDER BY cnt DESC
        LIMIT ?
     )
     SELECT ea.*, dk.email_norm
       FROM event_attendees ea
       JOIN duplicate_keys dk
         ON ea.event_id = dk.event_id
        AND lower(trim(ea.email)) = dk.email_norm
      ORDER BY dk.cnt DESC, ea.event_id, dk.email_norm, ea.created_at ASC`
  ).bind(Math.max(1, Math.min(ctx.batchSize, 100))).all<EventAttendeeRow & { email_norm: string }>();

  let groupsProcessed = 0;
  let deleted = 0;
  let merged = 0;
  const canonicalUpdates: EventAttendeeRow[] = [];
  const loserRows: EventAttendeeRow[] = [];
  const rowsByKey = new Map<string, EventAttendeeRow[]>();

  for (const row of rows.results) {
    const key = `${row.event_id}\u0000${row.email_norm}`;
    const groupRows = rowsByKey.get(key) || [];
    groupRows.push(row);
    rowsByKey.set(key, groupRows);
  }

  for (const groupRows of rowsByKey.values()) {
    const canonical = chooseCanonicalAttendee(groupRows);
    if (!canonical) continue;
    const mergedRow = mergeAttendeeRows(groupRows, canonical);
    const losers = groupRows.filter(r => r.id !== canonical.id);
    canonicalUpdates.push(mergedRow);
    loserRows.push(...losers);
    groupsProcessed++;
  }

  await snapshotRows(ctx, 'event_attendees', loserRows);

  for (const chunk of paramChunks(canonicalUpdates)) {
    await ctx.env.D1.batch(chunk.map(mergedRow =>
      ctx.env.D1.prepare(
        `UPDATE event_attendees
            SET contact_id = ?, user_id = ?, email = ?, display_name = ?, role = ?, is_internal = ?
          WHERE id = ?`
      ).bind(
        mergedRow.contact_id,
        mergedRow.user_id,
        mergedRow.email,
        mergedRow.display_name,
        mergedRow.role,
        mergedRow.is_internal,
        mergedRow.id
      )
    ));
    merged += chunk.length;
  }
  deleted += await deleteByIds(ctx, 'event_attendees', loserRows.map(r => r.id));

  const remaining = await previewEventAttendees(ctx.env);
  let uniqueGuard = 'skipped_duplicates_remaining';
  if (Number(remaining.duplicate_rows || 0) === 0) {
    await ctx.env.D1.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_event_attendees_event_email_unique
         ON event_attendees(event_id, lower(trim(email)))
       WHERE trim(email) != ''`
    ).run();
    uniqueGuard = 'created_or_exists';
  }

  return {
    groups_processed: groupsProcessed,
    canonical_rows_updated: merged,
    duplicate_rows_deleted: deleted,
    unique_guard: uniqueGuard,
    remaining,
  };
}

async function previewStaleOperations(env: Env): Promise<Record<string, unknown>> {
  const syncJobs = await env.D1.prepare(
    `SELECT COUNT(*) AS cnt FROM sync_jobs
      WHERE status = 'running'
        AND (
          (timeout_at IS NOT NULL AND timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR COALESCE(started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        )`
  ).bind(`-${STALE_RUNNING_HOURS} hours`).first<{ cnt: number }>();
  const taskRuns = await env.D1.prepare(
    `SELECT COUNT(*) AS cnt FROM task_runs
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
  ).bind(`-${STALE_RUNNING_HOURS} hours`).first<{ cnt: number }>();
  return {
    stale_sync_jobs: Number(syncJobs?.cnt || 0),
    stale_task_runs: Number(taskRuns?.cnt || 0),
  };
}

async function runStaleOperations(ctx: RunContext): Promise<Record<string, unknown>> {
  const syncIds = await selectIds(ctx.env,
    `SELECT id FROM sync_jobs
      WHERE status = 'running'
        AND (
          (timeout_at IS NOT NULL AND timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR COALESCE(started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        )
      ORDER BY COALESCE(started_at, created_at) ASC
      LIMIT ?`,
    [`-${STALE_RUNNING_HOURS} hours`, ctx.batchSize]
  );
  await snapshotByIds(ctx, 'sync_jobs', syncIds);
  let syncUpdated = 0;
  for (const chunk of paramChunks(syncIds, 1)) {
    const result = await ctx.env.D1.prepare(
      `UPDATE sync_jobs
          SET status = 'failed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              error_message = COALESCE(error_message, 'stale running row auto-reconciled by d1 maintenance'),
              metadata = json_set(CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
                '$.maintenance_reconciled_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                '$.maintenance_run_id', ?,
                '$.maintenance_reason', 'stale_running')
        WHERE id IN (${placeholders(chunk.length)})`
    ).bind(ctx.runId, ...chunk).run();
    syncUpdated += result.meta?.changes || 0;
  }

  const taskIds = await selectIds(ctx.env,
    `SELECT id FROM task_runs
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
      ORDER BY COALESCE(heartbeat_at, started_at, created_at) ASC
      LIMIT ?`,
    [`-${STALE_RUNNING_HOURS} hours`, ctx.batchSize]
  );
  await snapshotByIds(ctx, 'task_runs', taskIds);
  let taskUpdated = 0;
  for (const chunk of paramChunks(taskIds, 1)) {
    const result = await ctx.env.D1.prepare(
      `UPDATE task_runs
          SET status = 'failed',
              ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              duration_ms = CAST((julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) - julianday(started_at)) * 86400000 AS INTEGER),
              last_error = COALESCE(last_error, 'stale running row auto-reconciled by d1 maintenance'),
              metadata = json_set(CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
                '$.maintenance_reconciled_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                '$.maintenance_run_id', ?,
                '$.maintenance_reason', 'stale_running')
        WHERE id IN (${placeholders(chunk.length)})`
    ).bind(ctx.runId, ...chunk).run();
    taskUpdated += result.meta?.changes || 0;
  }

  return {
    sync_jobs_marked_failed: syncUpdated,
    task_runs_marked_failed: taskUpdated,
    remaining: await previewStaleOperations(ctx.env),
  };
}

async function previewRetention(env: Env): Promise<Record<string, unknown>> {
  const counts: Record<string, number> = {};
  for (const c of retentionConfigs()) {
    counts[c.name] = await countSql(env, c.countSql, c.binds);
  }
  return counts;
}

function retentionConfigs(): Array<{ name: string; table: string; countSql: string; idSql: string; binds: unknown[] }> {
  const successCutoff = `-${SUCCESS_RETENTION_DAYS} days`;
  const failureCutoff = `-${FAILURE_RETENTION_DAYS} days`;
  return [
    {
      name: 'work_queue_completed',
      table: 'work_queue',
      countSql: `SELECT COUNT(*) AS cnt FROM work_queue WHERE status = 'completed' AND COALESCE(completed_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
      idSql: `SELECT id FROM work_queue WHERE status = 'completed' AND COALESCE(completed_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY COALESCE(completed_at, created_at) ASC LIMIT ?`,
      binds: [successCutoff],
    },
    {
      name: 'work_queue_dead_letter',
      table: 'work_queue',
      countSql: `SELECT COUNT(*) AS cnt FROM work_queue WHERE status = 'dead_letter' AND COALESCE(completed_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
      idSql: `SELECT id FROM work_queue WHERE status = 'dead_letter' AND COALESCE(completed_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY COALESCE(completed_at, created_at) ASC LIMIT ?`,
      binds: [failureCutoff],
    },
    {
      name: 'sync_jobs_completed',
      table: 'sync_jobs',
      countSql: `SELECT COUNT(*) AS cnt FROM sync_jobs WHERE status = 'completed' AND COALESCE(completed_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
      idSql: `SELECT id FROM sync_jobs WHERE status = 'completed' AND COALESCE(completed_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY COALESCE(completed_at, started_at, created_at) ASC LIMIT ?`,
      binds: [successCutoff],
    },
    {
      name: 'sync_jobs_failed_partial',
      table: 'sync_jobs',
      countSql: `SELECT COUNT(*) AS cnt FROM sync_jobs WHERE status IN ('failed','partial') AND COALESCE(completed_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
      idSql: `SELECT id FROM sync_jobs WHERE status IN ('failed','partial') AND COALESCE(completed_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY COALESCE(completed_at, started_at, created_at) ASC LIMIT ?`,
      binds: [failureCutoff],
    },
    {
      name: 'task_runs_success_skipped',
      table: 'task_runs',
      countSql: `SELECT COUNT(*) AS cnt FROM task_runs WHERE status IN ('success','skipped') AND COALESCE(ended_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
      idSql: `SELECT id FROM task_runs WHERE status IN ('success','skipped') AND COALESCE(ended_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY COALESCE(ended_at, started_at, created_at) ASC LIMIT ?`,
      binds: [successCutoff],
    },
    {
      name: 'task_runs_failed_partial',
      table: 'task_runs',
      countSql: `SELECT COUNT(*) AS cnt FROM task_runs WHERE status IN ('failed','partial') AND COALESCE(ended_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
      idSql: `SELECT id FROM task_runs WHERE status IN ('failed','partial') AND COALESCE(ended_at, started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) ORDER BY COALESCE(ended_at, started_at, created_at) ASC LIMIT ?`,
      binds: [failureCutoff],
    },
  ];
}

async function runRetention(ctx: RunContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const c of retentionConfigs()) {
    const ids = await selectIds(ctx.env, c.idSql, [...c.binds, ctx.batchSize]);
    await snapshotByIds(ctx, c.table, ids);
    out[c.name] = await deleteByIds(ctx, c.table, ids);
  }
  out.remaining = await previewRetention(ctx.env);
  return out;
}

async function previewImportContacts(env: Env, orgId: string | null): Promise<Record<string, unknown>> {
  return {
    deletable_contacts: await countSql(env, importContactCountSql(orgId), orgId ? [orgId] : []),
  };
}

function importContactBaseWhere(orgScoped: boolean): string {
  return `c.source = 'import'
    AND c.deleted_at IS NOT NULL
    ${orgScoped ? 'AND c.org_id = ?' : ''}
    AND NOT EXISTS (SELECT 1 FROM conversation_contacts x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM event_attendees x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM deal_contacts x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM document_links x WHERE x.entity_type = 'contact' AND x.entity_id = c.id AND x.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM email_campaign_recipients x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM contact_associations x WHERE x.contact_id_a = c.id OR x.contact_id_b = c.id)
    AND NOT EXISTS (SELECT 1 FROM merge_locks x WHERE x.contact_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM approval_queue x WHERE x.entity_type = 'contact' AND x.entity_id = c.id)`;
}

function importContactCountSql(orgId: string | null): string {
  return `SELECT COUNT(*) AS cnt FROM contacts c WHERE ${importContactBaseWhere(!!orgId)}`;
}

async function runImportContactCleanup(ctx: RunContext): Promise<Record<string, unknown>> {
  const orgScoped = !!ctx.orgId;
  const ids = await selectIds(ctx.env,
    `SELECT c.id FROM contacts c WHERE ${importContactBaseWhere(orgScoped)} ORDER BY c.deleted_at ASC LIMIT ?`,
    orgScoped ? [ctx.orgId, ctx.batchSize] : [ctx.batchSize]
  );
  await snapshotByIds(ctx, 'contacts', ids);

  const vectorRows: Array<{ vector_id: string }> = [];
  for (const chunk of paramChunks(ids)) {
    const rows = await ctx.env.D1.prepare(
      `SELECT vector_id FROM vector_entity_index
        WHERE source_table = 'contacts' AND entity_id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).all<{ vector_id: string }>();
    vectorRows.push(...rows.results);
  }
  await snapshotRows(ctx, 'vector_entity_index', vectorRows);
  await deleteVectorIds(ctx.env, vectorRows.map(r => r.vector_id), 'legacy');

  const derived = [
    ['contact_activity_rollups', 'contact_id'],
    ['contact_timeline_items', 'contact_id'],
    ['contact_detail_read_model_repairs', 'contact_id'],
    ['contact_search_index_state', 'contact_id'],
    ['contact_search_index_repairs', 'contact_id'],
  ] as const;
  const derivedDeleted: Record<string, number> = {};
  for (const [table, column] of derived) {
    derivedDeleted[table] = await snapshotAndDeleteByColumn(ctx, table, column, ids);
  }
  derivedDeleted.entity_field_state = await snapshotAndDeleteByColumn(ctx, 'entity_field_state', 'entity_id', ids, `entity_type = 'contact'`);
  derivedDeleted.entity_field_provenance = await snapshotAndDeleteByColumn(ctx, 'entity_field_provenance', 'entity_id', ids, `entity_type = 'contact'`);
  derivedDeleted.contact_search_fts = await snapshotAndDeleteByColumn(ctx, 'contact_search_fts', 'contact_id', ids);

  let vectorIndexDeleted = 0;
  for (const chunk of paramChunks(ids)) {
    const result = await ctx.env.D1.prepare(
      `DELETE FROM vector_entity_index
        WHERE source_table = 'contacts' AND entity_id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).run();
    vectorIndexDeleted += result.meta?.changes || 0;
  }

  const contactsDeleted = await deleteByIds(ctx, 'contacts', ids);
  return {
    contacts_deleted: contactsDeleted,
    vector_index_deleted: vectorIndexDeleted,
    derived_deleted: derivedDeleted,
    remaining: await previewImportContacts(ctx.env, ctx.orgId || null),
  };
}

async function previewNewsArticles(env: Env, orgId: string | null): Promise<Record<string, unknown>> {
  const binds = orgId ? [orgId] : [];
  const orgWhere = orgId ? 'org_id = ? AND' : '';
  const dup = await env.D1.prepare(
    `SELECT COUNT(*) AS groups, COALESCE(SUM(cnt - 1), 0) AS rows
       FROM (
         SELECT org_id, source_url_normalized, COUNT(*) AS cnt
           FROM news_articles
          WHERE ${orgWhere} quality_status = 'usable'
            AND source_url_normalized IS NOT NULL
          GROUP BY org_id, source_url_normalized
         HAVING COUNT(*) > 1
       )`
  ).bind(...binds).first<{ groups: number; rows: number }>();
  return {
    missing_urls_usable: await countSql(env, `SELECT COUNT(*) AS cnt FROM news_articles WHERE ${orgWhere} quality_status = 'usable' AND (source_url IS NULL OR trim(source_url) = '')`, binds),
    future_dated_usable: await countSql(env, `SELECT COUNT(*) AS cnt FROM news_articles WHERE ${orgWhere} quality_status = 'usable' AND published_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')`, binds),
    duplicate_url_groups: Number(dup?.groups || 0),
    duplicate_url_rows: Number(dup?.rows || 0),
    url_normalization_pending: await countSql(env, `SELECT COUNT(*) AS cnt FROM news_articles WHERE ${orgWhere} source_url IS NOT NULL AND trim(source_url) != '' AND (source_url_normalized IS NULL OR source_url_normalized = '')`, binds),
  };
}

async function runNewsCleanup(ctx: RunContext): Promise<Record<string, unknown>> {
  const orgWhere = ctx.orgId ? 'org_id = ? AND' : '';
  const orgBinds = ctx.orgId ? [ctx.orgId] : [];
  let normalized = 0;
  const toNormalize = await ctx.env.D1.prepare(
    `SELECT id, source_url FROM news_articles
      WHERE ${orgWhere} source_url IS NOT NULL AND trim(source_url) != ''
        AND (source_url_normalized IS NULL OR source_url_normalized = '')
      LIMIT ?`
  ).bind(...orgBinds, ctx.batchSize).all<{ id: string; source_url: string }>();
  await snapshotRows(ctx, 'news_articles', toNormalize.results);
  for (const row of toNormalize.results) {
    await ctx.env.D1.prepare(
      `UPDATE news_articles SET source_url_normalized = ? WHERE id = ?`
    ).bind(normalizeNewsSourceUrl(row.source_url), row.id).run();
    normalized++;
  }

  const missingUrlIds = await selectIds(ctx.env,
    `SELECT id FROM news_articles
      WHERE ${orgWhere} quality_status = 'usable'
        AND (source_url IS NULL OR trim(source_url) = '')
      ORDER BY created_at ASC LIMIT ?`,
    [...orgBinds, ctx.batchSize]
  );
  const missingQuarantined = await quarantineNews(ctx, missingUrlIds, 'missing_source_url', null);

  const futureIds = await selectIds(ctx.env,
    `SELECT id FROM news_articles
      WHERE ${orgWhere} quality_status = 'usable'
        AND published_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')
      ORDER BY published_at DESC LIMIT ?`,
    [...orgBinds, ctx.batchSize]
  );
  const futureQuarantined = await quarantineNews(ctx, futureIds, 'future_published_at', null);

  const duplicateGroups = await ctx.env.D1.prepare(
    `SELECT org_id, source_url_normalized, COUNT(*) AS cnt
       FROM news_articles
      WHERE ${orgWhere} quality_status = 'usable'
        AND source_url_normalized IS NOT NULL
      GROUP BY org_id, source_url_normalized
     HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT ?`
  ).bind(...orgBinds, Math.max(1, Math.min(ctx.batchSize, 50))).all<{
    org_id: string;
    source_url_normalized: string;
    cnt: number;
  }>();

  let duplicateRows = 0;
  for (const group of duplicateGroups.results) {
    const rows = await ctx.env.D1.prepare(
      `SELECT id, relevance_score, facts_extracted_at, summary, published_at, created_at
         FROM news_articles
        WHERE org_id = ? AND source_url_normalized = ? AND quality_status = 'usable'
        ORDER BY
          relevance_score DESC,
          CASE WHEN facts_extracted_at IS NOT NULL THEN 0 ELSE 1 END,
          length(COALESCE(summary,'')) DESC,
          published_at DESC,
          created_at ASC`
    ).bind(group.org_id, group.source_url_normalized).all<any>();
    const canonical = rows.results[0];
    const losers = rows.results.slice(1).map(r => r.id);
    duplicateRows += await quarantineNews(ctx, losers, 'duplicate_source_url', canonical?.id || null);
  }

  const remaining = await previewNewsArticles(ctx.env, ctx.orgId || null);
  let uniqueGuard = 'skipped_duplicates_remaining';
  if (Number(remaining.duplicate_url_rows || 0) === 0) {
    await ctx.env.D1.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_news_articles_usable_url_unique
         ON news_articles(org_id, source_url_normalized)
       WHERE source_url_normalized IS NOT NULL AND quality_status = 'usable'`
    ).run();
    uniqueGuard = 'created_or_exists';
  }

  return {
    urls_normalized: normalized,
    missing_url_quarantined: missingQuarantined,
    future_dated_quarantined: futureQuarantined,
    duplicate_rows_quarantined: duplicateRows,
    unique_guard: uniqueGuard,
    remaining,
  };
}

async function quarantineNews(ctx: RunContext, ids: string[], reason: string, canonicalId: string | null): Promise<number> {
  if (ids.length === 0) return 0;
  await snapshotByIds(ctx, 'news_articles', ids);
  await removeNewsFromRetrieval(ctx, ids);
  let updated = 0;
  for (const chunk of paramChunks(ids, 3)) {
    const result = await ctx.env.D1.prepare(
      `UPDATE news_articles
          SET quality_status = ?,
              quality_reason = ?,
              canonical_news_article_id = COALESCE(?, canonical_news_article_id),
              quarantined_at = COALESCE(quarantined_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE id IN (${placeholders(chunk.length)})`
    ).bind(reason === 'duplicate_source_url' ? 'duplicate' : 'quarantined', reason, canonicalId, ...chunk).run();
    updated += result.meta?.changes || 0;
  }
  return updated;
}

async function removeNewsFromRetrieval(ctx: RunContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const chunkRows: Array<{
    id: string;
    text_r2_key: string | null;
    kv_key: string | null;
    vector_id_bge: string | null;
    vector_id_qwen3: string | null;
    vector_id_minilm: string | null;
  }> = [];
  for (const chunk of paramChunks(ids)) {
    const rows = await ctx.env.D1.prepare(
      `SELECT id, text_r2_key, kv_key, vector_id_bge, vector_id_qwen3, vector_id_minilm
         FROM rag_chunks_v2
        WHERE source_table = 'news_articles'
          AND source_id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).all<{
      id: string;
      text_r2_key: string | null;
      kv_key: string | null;
      vector_id_bge: string | null;
      vector_id_qwen3: string | null;
      vector_id_minilm: string | null;
    }>();
    chunkRows.push(...rows.results);
  }
  await snapshotRows(ctx, 'rag_chunks_v2', chunkRows);
  await deleteVectorIds(ctx.env, chunkRows.map(r => r.vector_id_bge).filter(Boolean) as string[], 'bge');
  await deleteVectorIds(ctx.env, chunkRows.map(r => r.vector_id_qwen3).filter(Boolean) as string[], 'qwen3');
  await deleteVectorIds(ctx.env, chunkRows.map(r => r.vector_id_minilm).filter(Boolean) as string[], 'minilm');
  await Promise.all(chunkRows.flatMap(r => [
    r.text_r2_key ? ctx.env.R2.delete(r.text_r2_key).catch(() => undefined) : Promise.resolve(),
    r.kv_key ? ctx.env.KV.delete(r.kv_key).catch(() => undefined) : Promise.resolve(),
  ]));
  const chunkIds = chunkRows.map(r => r.id);
  for (const chunk of paramChunks(chunkIds)) {
    await ctx.env.D1.batch([
      ctx.env.D1.prepare(`DELETE FROM rag_chunks_v2_fts WHERE chunk_id IN (${placeholders(chunk.length)})`).bind(...chunk),
      ctx.env.D1.prepare(`DELETE FROM rag_chunks_v2 WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk),
    ]);
  }

  const legacyRows: Array<{ vector_id: string }> = [];
  for (const chunk of paramChunks(ids)) {
    const rows = await ctx.env.D1.prepare(
      `SELECT vector_id FROM vector_entity_index
        WHERE source_table = 'news_articles'
          AND entity_id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).all<{ vector_id: string }>();
    legacyRows.push(...rows.results);
  }
  await snapshotRows(ctx, 'vector_entity_index', legacyRows);
  await deleteVectorIds(ctx.env, legacyRows.map(r => r.vector_id), 'legacy');
  if (legacyRows.length) {
    for (const chunk of paramChunks(ids)) {
      await ctx.env.D1.prepare(
        `DELETE FROM vector_entity_index
          WHERE source_table = 'news_articles'
            AND entity_id IN (${placeholders(chunk.length)})`
      ).bind(...chunk).run();
    }
  }
  for (const chunk of paramChunks(ids)) {
    await ctx.env.D1.prepare(
      `UPDATE rag_source_index_state
          SET backfill_status = 'skipped',
              last_error = 'news_article_quarantined',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE source_table = 'news_articles'
          AND source_id IN (${placeholders(chunk.length)})`
    ).bind(...chunk).run().catch(() => undefined);
  }
}

async function previewScratch(env: Env, orgId: string | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (await tableExists(env, '_cleanup_dangling_vectors')) {
    out.dangling_vectors_pending = await countSql(env, `SELECT COUNT(*) AS cnt FROM _cleanup_dangling_vectors WHERE COALESCE(vectorize_deleted, 0) = 0`, []);
    out.dangling_vectors_total = await countSql(env, `SELECT COUNT(*) AS cnt FROM _cleanup_dangling_vectors`, []);
  }
  if (await tableExists(env, '_cleanup_transcript_acl')) {
    const binds = orgId ? [orgId] : [];
    const orgWhere = orgId ? 'AND vei.org_id = ?' : '';
    out.transcript_acl_remaining = await countSql(env,
      `SELECT COUNT(*) AS cnt
         FROM vector_entity_index vei
        WHERE vei.source_table = 'events'
          ${orgWhere}
          AND NOT EXISTS (SELECT 1 FROM _cleanup_transcript_acl c WHERE c.vector_id = vei.vector_id)`,
      binds
    );
    out.transcript_acl_tracking_rows = await countSql(env, `SELECT COUNT(*) AS cnt FROM _cleanup_transcript_acl`, []);
  }
  if (await tableExists(env, '_cleanup_orphaned_evidence')) {
    out.orphaned_evidence_rows = await countSql(env, `SELECT COUNT(*) AS cnt FROM _cleanup_orphaned_evidence`, []);
  }
  return out;
}

async function runScratchCleanup(ctx: RunContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (await tableExists(ctx.env, '_cleanup_dangling_vectors')) {
    const rows = await ctx.env.D1.prepare(
      `SELECT vector_id FROM _cleanup_dangling_vectors
        WHERE COALESCE(vectorize_deleted, 0) = 0
        LIMIT ?`
    ).bind(ctx.batchSize).all<{ vector_id: string }>();
    await deleteVectorIds(ctx.env, rows.results.map(r => r.vector_id), 'legacy');
    for (const chunk of paramChunks(rows.results.map(r => r.vector_id))) {
      await ctx.env.D1.prepare(
        `UPDATE _cleanup_dangling_vectors
            SET vectorize_deleted = 1
          WHERE vector_id IN (${placeholders(chunk.length)})`
      ).bind(...chunk).run();
    }
    const pending = await countSql(ctx.env, `SELECT COUNT(*) AS cnt FROM _cleanup_dangling_vectors WHERE COALESCE(vectorize_deleted, 0) = 0`, []);
    out.dangling_vectors_marked_deleted = rows.results.length;
    out.dangling_vectors_pending = pending;
    if (pending === 0) {
      out.dangling_vectors_snapshot_rows = await snapshotWholeTable(ctx, '_cleanup_dangling_vectors');
      await ctx.env.D1.prepare(`DROP TABLE _cleanup_dangling_vectors`).run();
      out.dangling_vectors_table = 'dropped';
    }
  }

  if (await tableExists(ctx.env, '_cleanup_transcript_acl')) {
    const remaining = Number((await previewScratch(ctx.env, ctx.orgId || null)).transcript_acl_remaining || 0);
    out.transcript_acl_remaining = remaining;
    if (remaining === 0) {
      out.transcript_acl_snapshot_rows = await snapshotWholeTable(ctx, '_cleanup_transcript_acl');
      await ctx.env.D1.prepare(`DROP TABLE _cleanup_transcript_acl`).run();
      out.transcript_acl_table = 'dropped';
    }
  }

  if (await tableExists(ctx.env, '_cleanup_orphaned_evidence')) {
    out.orphaned_evidence_snapshot_rows = await snapshotWholeTable(ctx, '_cleanup_orphaned_evidence');
    await ctx.env.D1.prepare(`DROP TABLE _cleanup_orphaned_evidence`).run();
    out.orphaned_evidence_table = 'dropped';
  }

  out.remaining = await previewScratch(ctx.env, ctx.orgId || null);
  return out;
}

async function countSql(env: Env, sql: string, binds: unknown[]): Promise<number> {
  const row = await env.D1.prepare(sql).bind(...binds).first<{ cnt: number }>();
  return Number(row?.cnt || 0);
}

async function snapshotAndDeleteByColumn(
  ctx: RunContext,
  table: string,
  column: string,
  ids: string[],
  extraWhere?: string
): Promise<number> {
  if (ids.length === 0 || !(await tableExists(ctx.env, table))) return 0;
  let deleted = 0;
  for (const chunk of paramChunks(ids)) {
    const where = `${extraWhere ? `${extraWhere} AND ` : ''}${column} IN (${placeholders(chunk.length)})`;
    const rows = await ctx.env.D1.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...chunk).all();
    await snapshotRows(ctx, table, rows.results || []);
    const result = await ctx.env.D1.prepare(`DELETE FROM ${table} WHERE ${where}`).bind(...chunk).run();
    deleted += result.meta?.changes || 0;
  }
  return deleted;
}

async function deleteVectorIds(env: Env, ids: string[], profile: 'legacy' | 'bge' | 'qwen3' | 'minilm'): Promise<void> {
  if (ids.length === 0) return;
  const index =
    profile === 'bge' ? env.VECTORIZE_RAG_V2_BGE :
    profile === 'qwen3' ? env.VECTORIZE_RAG_V2_QWEN3 :
    profile === 'minilm' ? env.VECTORIZE_RAG_V2_MINILM :
    env.VECTORIZE;
  if (!index) return;
  for (let i = 0; i < ids.length; i += 1000) {
    await index.deleteByIds(ids.slice(i, i + 1000)).catch(() => undefined);
  }
}

function safeJson(value: string | null | undefined, fallback: unknown): unknown {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export const __d1MaintenanceTestHooks = {
  DEFAULT_STEPS,
  FAILURE_RETENTION_DAYS,
  SUCCESS_RETENTION_DAYS,
  fnv1a,
  retentionConfigs,
};

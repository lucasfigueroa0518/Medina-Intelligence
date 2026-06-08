import type { Env } from '../types/env';

export type SyncJobStatus = 'running' | 'completed' | 'failed' | 'partial' | 'paused';

export interface OpenSyncJobInput {
  orgId: string;
  workflowType: string;
  metadata?: Record<string, unknown>;
  timeoutMinutes?: number;
  id?: string;
}

export interface CloseSyncJobInput {
  status: Exclude<SyncJobStatus, 'running'>;
  metadata?: Record<string, unknown>;
  errorMessage?: string | null;
}

const DEFAULT_TIMEOUT_MINUTES = 10;
const STALE_OPERATIONAL_WORKFLOWS = [
  'webhook',
  'progressive-backfill-window',
  'attachment_backfill',
];

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function metadataJson(metadata?: Record<string, unknown>): string {
  try {
    return JSON.stringify(metadata || {});
  } catch {
    return '{}';
  }
}

function sourceForWorkflow(workflowType: string): string {
  if (workflowType === 'webhook' || workflowType === 'progressive-backfill-window') return 'outlook_email';
  if (workflowType === 'attachment_backfill') return 'outlook_email';
  return 'work_queue';
}

function staleCodeForWorkflow(workflowType: string): string {
  if (workflowType === 'webhook') return 'webhook_sync_job_stale';
  if (workflowType === 'progressive-backfill-window') return 'progressive_backfill_terminal_graph_error';
  if (workflowType === 'attachment_backfill') return 'attachment_backfill_sync_job_stale';
  return 'sync_job_stale';
}

export async function openSyncJob(env: Env, input: OpenSyncJobInput): Promise<string> {
  const id = input.id || crypto.randomUUID();
  const timeoutMinutes = Math.max(1, input.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
  await env.D1.prepare(
    `INSERT INTO sync_jobs
       (id, org_id, workflow_type, status, started_at, timeout_at, metadata)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`
  ).bind(
    id,
    input.orgId,
    input.workflowType,
    nowIso(),
    addMinutes(timeoutMinutes),
    metadataJson(input.metadata)
  ).run();
  return id;
}

export async function patchSyncJobMetadata(
  env: Env,
  syncJobId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await env.D1.prepare(
    `UPDATE sync_jobs
        SET metadata = json_patch(
              CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
              ?
            )
      WHERE id = ?`
  ).bind(metadataJson(metadata), syncJobId).run();
}

export async function closeSyncJob(
  env: Env,
  syncJobId: string,
  input: CloseSyncJobInput
): Promise<void> {
  const hasError = input.errorMessage !== undefined;
  const sets = [
    `status = ?`,
    `completed_at = ?`,
    `timeout_at = NULL`,
    `metadata = json_patch(
       CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
       ?
     )`,
  ];
  const binds: unknown[] = [
    input.status,
    nowIso(),
    metadataJson({ ended_status: input.status, ...(input.metadata || {}) }),
  ];

  if (hasError) {
    sets.push(`error_message = ?`);
    binds.push(input.errorMessage ? input.errorMessage.slice(0, 500) : null);
  }

  binds.push(syncJobId);
  await env.D1.prepare(
    `UPDATE sync_jobs SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
}

export async function reconcileStaleOperationalSyncJobs(
  env: Env,
  opts: { maxAgeMinutes?: number; limit?: number } = {}
): Promise<{ reconciled: number; sampled_ids: string[] }> {
  const maxAgeMinutes = Math.max(1, opts.maxAgeMinutes || DEFAULT_TIMEOUT_MINUTES);
  const limit = Math.max(1, Math.min(100, opts.limit || 50));
  const workflowPlaceholders = STALE_OPERATIONAL_WORKFLOWS.map(() => '?').join(',');
  const rows = await env.D1.prepare(
    `SELECT id, org_id, workflow_type, started_at, created_at, timeout_at, metadata
       FROM sync_jobs
      WHERE status = 'running'
        AND workflow_type IN (${workflowPlaceholders})
        AND (
          (timeout_at IS NOT NULL AND timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR COALESCE(started_at, created_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        )
      ORDER BY COALESCE(started_at, created_at) ASC
      LIMIT ?`
  ).bind(...STALE_OPERATIONAL_WORKFLOWS, `-${maxAgeMinutes} minutes`, limit).all<{
    id: string;
    org_id: string;
    workflow_type: string;
    started_at: string | null;
    created_at: string;
    timeout_at: string | null;
    metadata: string | null;
  }>();

  if (rows.results.length === 0) return { reconciled: 0, sampled_ids: [] };

  let reconciled = 0;
  for (const row of rows.results) {
    const message = `${row.workflow_type} sync job exceeded ${maxAgeMinutes} minute running timeout`;
    const result = await env.D1.prepare(
      `UPDATE sync_jobs
          SET status = 'failed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              timeout_at = NULL,
              error_message = COALESCE(error_message, ?),
              metadata = json_set(
                CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
                '$.stale_reconciled_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                '$.stale_reconcile_reason', 'running_timeout'
              )
        WHERE id = ? AND status = 'running'`
    ).bind(message, row.id).run();

    if (Number(result.meta?.changes || 0) === 0) continue;
    reconciled++;

    try {
      const { reportIngestionFailure } = await import('./ingestion-health');
      await reportIngestionFailure(env, {
        orgId: row.org_id,
        source: sourceForWorkflow(row.workflow_type),
        scopeType: 'sync_job',
        scopeId: row.id,
        code: staleCodeForWorkflow(row.workflow_type),
        title: `${row.workflow_type} sync job went stale`,
        message,
        severity: 'warning',
        humanActionRequired: false,
        metadata: {
          workflow_type: row.workflow_type,
          sync_job_id: row.id,
          started_at: row.started_at,
          timeout_at: row.timeout_at,
        },
      });
    } catch (e) {
      console.error(`[sync-job-lifecycle] incident report failed for stale sync job ${row.id}:`, e);
    }
  }

  return {
    reconciled,
    sampled_ids: rows.results.slice(0, 10).map(row => row.id),
  };
}

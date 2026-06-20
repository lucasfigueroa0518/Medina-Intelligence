import type { Env } from '../types/env';
import { enqueueWork } from './work-queue';

export type IngestionSeverity = 'warning' | 'critical';
export type IngestionSource =
  | 'outlook_email'
  | 'calendar'
  | 'slack'
  | 'firefly'
  | 'embedding'
  | 'work_queue'
  | string;

export interface IngestionIncident {
  id: string;
  org_id: string;
  source: IngestionSource;
  scope_type: string;
  scope_id: string;
  status: 'open' | 'recovering' | 'blocked' | 'resolved';
  severity: IngestionSeverity;
  code: string;
  title: string;
  message: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  last_success_at: string | null;
  human_action_required: number;
  recovery_status: 'idle' | 'repair_queued' | 'repairing' | 'blocked_on_auth';
  recovery_window_start: string | null;
  recovery_window_end: string | null;
  repair_attempt_count: number;
  last_repair_at: string | null;
  metadata: string;
}

export interface ReportIngestionFailureInput {
  orgId: string;
  source: IngestionSource;
  code: string;
  message: string;
  scopeType?: string;
  scopeId?: string | null;
  title?: string;
  severity?: IngestionSeverity;
  humanActionRequired?: boolean;
  occurredAt?: string;
  recoveryWindowStart?: string | null;
  recoveryWindowEnd?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReportIngestionSuccessInput {
  orgId: string;
  source: IngestionSource;
  scopeType?: string;
  scopeId?: string | null;
  successAt?: string;
  metadata?: Record<string, unknown>;
}

export interface UserFacingIngestionWarning {
  type: string;
  message: string;
  severity?: IngestionSeverity;
  source?: string;
  incident_id?: string;
  code?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  recovery_status?: string;
  human_action_required?: boolean;
  recovery_window_start?: string | null;
  recovery_window_end?: string | null;
}

const REPAIR_PADDING_DAYS = 14;
const AUTO_REPAIR_COOLDOWN_MS = 15 * 60 * 1000;
const RAG_V2_FRESHNESS_SLO_MS = 15 * 60 * 1000;
const FIREFLY_SILENCE_MS = 48 * 60 * 60 * 1000;
const FIREFLY_SELF_REPAIR_DAYS = 7;
const FIREFLY_PERSISTENT_REPAIR_DAYS = 10;
const SLACK_MESSAGE_STALE_MS = 48 * 60 * 60 * 1000;
const SLACK_SELF_REPAIR_DAYS = 7;

function scopeId(input: string | null | undefined): string {
  return input || '';
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(input: string, max = 800): string {
  return input.length > max ? input.slice(0, max) : input;
}

function errToString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function sourceTitle(source: string): string {
  switch (source) {
    case 'outlook_email': return 'Outlook email ingestion';
    case 'calendar': return 'Calendar ingestion';
    case 'slack': return 'Slack ingestion';
    case 'firefly': return 'Meeting transcript ingestion';
    case 'embedding': return 'Embedding repair';
    case 'rag_v2': return 'MARTy RAG v2 indexing';
    default: return source.replace(/[_-]+/g, ' ');
  }
}

function defaultTitle(input: ReportIngestionFailureInput): string {
  const base = sourceTitle(input.source);
  if (input.humanActionRequired) return `${base} needs attention`;
  return `${base} is repairing`;
}

function repairWindow(firstSeenAt: string, lastSeenAt: string): { start: string; end: string } {
  const first = Date.parse(firstSeenAt);
  const last = Date.parse(lastSeenAt);
  const startMs = Number.isFinite(first) ? first : Date.now();
  const endMs = Number.isFinite(last) ? last : Date.now();
  return {
    start: new Date(startMs - REPAIR_PADDING_DAYS * 86400000).toISOString(),
    end: new Date(Math.max(Date.now(), endMs) + 86400000).toISOString(),
  };
}

function isHumanActionError(error: string): boolean {
  return /reauth|required|missing_token|missing token|no firefly key|credential missing|decrypt-failed|invalid_auth|account_inactive|not_authed|token_failed_threshold|permission|forbidden|revoked|invalid_grant/i.test(error);
}

function parseWorkQueuePayload(payload: string): Record<string, unknown> {
  try {
    return JSON.parse(payload || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function isRepairBlockedByHumanAction(
  env: Env,
  row: { domain: string; payload: string; last_error?: string | null },
  error: string
): Promise<boolean> {
  if (isHumanActionError(error)) return true;
  if (!/token_refresh_failed/i.test(error)) return false;
  const payload = parseWorkQueuePayload(row.payload);
  const userId = typeof payload.user_id === 'string' ? payload.user_id : '';
  if (!userId) return false;
  const state = await env.KV.get<{ count: number; reason?: string; message?: string }>(
    `token_failed:${userId}:outlook`,
    'json'
  ).catch(() => null);
  return Boolean(state && (
    state.count >= 3 ||
    /reauth|required|missing_token|invalid_grant|revoked/i.test(`${state.reason || ''} ${state.message || ''}`)
  ));
}

function workQueueSource(domain: string): IngestionSource {
  if (domain === 'calendar_refresh') return 'calendar';
  if (domain === 'firefly_window') return 'firefly';
  if (domain === 'firefly_transcript_hydrate') return 'firefly';
  if (domain === 'embed_retry') return 'embedding';
  if (domain === 'attachment_backfill') return 'outlook_email';
  if (domain === 'deal_evidence_detect') return 'deal_evidence';
  if (domain === 'rag_reindex_v2') return 'rag_v2';
  if (domain === 'slack_channel_backfill') return 'slack';
  return 'work_queue';
}

async function scanFireflySilence(
  orgId: string,
  env: Env
): Promise<number> {
  const credentialed = await env.D1.prepare(
    `SELECT u.id AS user_id, u.email, c.created_at, c.updated_at, c.last_used_at
       FROM user_firefly_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE u.org_id = ?
        AND u.deleted_at IS NULL
        AND COALESCE(u.is_active, 1) = 1`
  ).bind(orgId).all<{
    user_id: string;
    email: string | null;
    created_at: string | null;
    updated_at: string | null;
    last_used_at: string | null;
  }>();

  let incidents = 0;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  for (const user of credentialed.results) {
    const [latestItem, latestWebhook, activeJob, hydrateActive, existingIncident, deadLetters] = await Promise.all([
      env.D1.prepare(
        `SELECT MAX(COALESCE(updated_at, created_at)) AS last_item_at,
                COUNT(*) AS total_items
           FROM firefly_transcript_items
          WHERE org_id = ? AND user_id = ?`
      ).bind(orgId, user.user_id).first<{ last_item_at: string | null; total_items: number }>(),
      env.D1.prepare(
        `SELECT MAX(received_at) AS last_webhook_at,
                MAX(CASE WHEN status = 'hydrated' THEN completed_at ELSE NULL END) AS last_hydrated_at
           FROM firefly_webhook_deliveries
          WHERE org_id = ?
            AND (selected_user_id = ? OR selected_user_id IS NULL)`
      ).bind(orgId, user.user_id).first<{ last_webhook_at: string | null; last_hydrated_at: string | null }>(),
      env.D1.prepare(
        `SELECT id
           FROM firefly_progressive_backfill_jobs
          WHERE org_id = ? AND user_id = ? AND status = 'active'
          LIMIT 1`
      ).bind(orgId, user.user_id).first<{ id: string }>(),
      env.D1.prepare(
        `SELECT COUNT(*) AS n
           FROM work_queue
          WHERE org_id = ?
            AND domain = 'firefly_transcript_hydrate'
            AND status IN ('pending','in_progress')
            AND (json_extract(payload, '$.user_id') = ? OR json_extract(payload, '$.user_id') IS NULL)`
      ).bind(orgId, user.user_id).first<{ n: number }>(),
      env.D1.prepare(
        `SELECT repair_attempt_count, first_seen_at
           FROM ingestion_incidents
          WHERE org_id = ?
            AND source = 'firefly'
            AND scope_type = 'user'
            AND scope_id = ?
            AND code = 'firefly_ingestion_silent'
            AND status IN ('open','recovering','blocked')
          LIMIT 1`
      ).bind(orgId, user.user_id).first<{ repair_attempt_count: number; first_seen_at: string | null }>(),
      env.D1.prepare(
        `SELECT COUNT(*) AS n
           FROM work_queue
          WHERE org_id = ?
            AND domain IN ('firefly_window','firefly_transcript_hydrate')
            AND status = 'dead_letter'
            AND (json_extract(payload, '$.user_id') = ? OR json_extract(payload, '$.user_id') IS NULL)`
      ).bind(orgId, user.user_id).first<{ n: number }>(),
    ]);

    const latestTranscriptAt = latestItem?.last_item_at || null;
    const newestSuccess = latestTranscriptAt || latestWebhook?.last_hydrated_at || null;
    const credentialBaseline = user.last_used_at || user.updated_at || user.created_at || nowIso;
    const observedAt = newestSuccess || credentialBaseline;
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) continue;

    if (activeJob?.id || (hydrateActive?.n || 0) > 0) {
      continue;
    }

    if (now - observedMs < FIREFLY_SILENCE_MS) {
      await reportIngestionSuccess(env, {
        orgId,
        source: 'firefly',
        scopeType: 'user',
        scopeId: user.user_id,
        metadata: {
          last_transcript_at: latestTranscriptAt,
          last_webhook_at: latestWebhook?.last_webhook_at || null,
          last_hydrated_at: latestWebhook?.last_hydrated_at || null,
          total_transcript_items: latestItem?.total_items || 0,
        },
      }).catch(() => {});
      continue;
    }

    const persistent = Boolean(existingIncident && (existingIncident.repair_attempt_count > 0));
    const daysBack = persistent ? FIREFLY_PERSISTENT_REPAIR_DAYS : FIREFLY_SELF_REPAIR_DAYS;
    const start = new Date(now - daysBack * 86400000).toISOString();
    await reportIngestionFailure(env, {
      orgId,
      source: 'firefly',
      scopeType: 'user',
      scopeId: user.user_id,
      code: 'firefly_ingestion_silent',
      title: 'Fireflies transcript ingestion is silent',
      message: `No Fireflies transcripts have been staged for ${user.email || user.user_id} since ${observedAt}. A bounded ${daysBack}-day catch-up will run automatically.`,
      severity: 'warning',
      humanActionRequired: false,
      recoveryWindowStart: start,
      recoveryWindowEnd: nowIso,
      metadata: {
        last_transcript_at: latestTranscriptAt,
        last_webhook_at: latestWebhook?.last_webhook_at || null,
        last_hydrated_at: latestWebhook?.last_hydrated_at || null,
        firefly_key_last_used_at: user.last_used_at,
        active_parent_id: activeJob?.id || null,
        hydrate_active: hydrateActive?.n || 0,
        firefly_dead_letters: deadLetters?.n || 0,
        repair_days_back: daysBack,
      },
    });
    incidents++;
  }

  return incidents;
}

function isQuarantinedVectorizePayload(error: string): boolean {
  return /vectorize_payload_quarantined|VECTORIZE_PAYLOAD_QUARANTINED|40023|failed to parse upsert vectors request|VECTOR_UPSERT_ERROR/i.test(error);
}

function maybeJson(metadata: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(metadata || {});
  } catch {
    return '{}';
  }
}

export async function reportIngestionFailure(
  env: Env,
  input: ReportIngestionFailureInput
): Promise<void> {
  const at = input.occurredAt || nowIso();
  const scType = input.scopeType || 'org';
  const scId = scopeId(input.scopeId);
  const severity = input.severity || (input.humanActionRequired ? 'critical' : 'warning');
  const recoveryStatus = input.humanActionRequired ? 'blocked_on_auth' : 'idle';
  const status = input.humanActionRequired ? 'blocked' : severity === 'critical' ? 'recovering' : 'degraded';
  const incidentStatus = input.humanActionRequired ? 'blocked' : 'open';
  const metadataJson = maybeJson(input.metadata);

  await env.D1.prepare(
    `INSERT INTO ingestion_source_state
       (org_id, source, scope_type, scope_id, status, severity, last_failure_at,
        failure_count, last_error_code, last_error, human_action_required,
        recovery_status, recovery_window_start, recovery_window_end, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, source, scope_type, scope_id) DO UPDATE SET
       status = excluded.status,
       severity = excluded.severity,
       last_failure_at = excluded.last_failure_at,
       failure_count = ingestion_source_state.failure_count + 1,
       last_error_code = excluded.last_error_code,
       last_error = excluded.last_error,
       human_action_required = excluded.human_action_required,
       recovery_status = excluded.recovery_status,
       recovery_window_start = COALESCE(ingestion_source_state.recovery_window_start, excluded.recovery_window_start),
       recovery_window_end = excluded.recovery_window_end,
       metadata = excluded.metadata,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    input.orgId,
    input.source,
    scType,
    scId,
    status,
    severity,
    at,
    input.code,
    truncate(input.message),
    input.humanActionRequired ? 1 : 0,
    recoveryStatus,
    input.recoveryWindowStart || null,
    input.recoveryWindowEnd || null,
    metadataJson
  ).run();

  await env.D1.prepare(
    `INSERT INTO ingestion_incidents
       (org_id, source, scope_type, scope_id, status, severity, code, title, message,
        first_seen_at, last_seen_at, human_action_required, recovery_status,
        recovery_window_start, recovery_window_end, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, source, scope_type, scope_id, code)
       WHERE status IN ('open','recovering','blocked')
     DO UPDATE SET
       status = excluded.status,
       severity = excluded.severity,
       title = excluded.title,
       message = excluded.message,
       last_seen_at = excluded.last_seen_at,
       human_action_required = excluded.human_action_required,
       recovery_status = excluded.recovery_status,
       recovery_window_start = COALESCE(ingestion_incidents.recovery_window_start, excluded.recovery_window_start),
       recovery_window_end = excluded.recovery_window_end,
       metadata = excluded.metadata,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    input.orgId,
    input.source,
    scType,
    scId,
    incidentStatus,
    severity,
    input.code,
    input.title || defaultTitle(input),
    truncate(input.message),
    at,
    at,
    input.humanActionRequired ? 1 : 0,
    recoveryStatus,
    input.recoveryWindowStart || null,
    input.recoveryWindowEnd || null,
    metadataJson
  ).run();
}

export async function reportIngestionSuccess(
  env: Env,
  input: ReportIngestionSuccessInput
): Promise<void> {
  const at = input.successAt || nowIso();
  const scType = input.scopeType || 'org';
  const scId = scopeId(input.scopeId);
  const metadataJson = maybeJson(input.metadata);

  await env.D1.prepare(
    `INSERT INTO ingestion_source_state
       (org_id, source, scope_type, scope_id, status, severity, last_success_at,
        failure_count, human_action_required, recovery_status, metadata)
     VALUES (?, ?, ?, ?, 'healthy', 'info', ?, 0, 0, 'idle', ?)
     ON CONFLICT(org_id, source, scope_type, scope_id) DO UPDATE SET
       status = 'healthy',
       severity = 'info',
       last_success_at = excluded.last_success_at,
       failure_count = 0,
       human_action_required = 0,
       recovery_status = 'idle',
       last_error_code = NULL,
       last_error = NULL,
       metadata = excluded.metadata,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(input.orgId, input.source, scType, scId, at, metadataJson).run();

  await env.D1.prepare(
    `UPDATE ingestion_incidents
        SET status = 'resolved',
            resolved_at = ?,
            last_success_at = ?,
            recovery_status = 'idle',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ?
        AND source = ?
        AND scope_type = ?
        AND scope_id = ?
        AND status IN ('open','recovering','blocked')`
  ).bind(at, at, input.orgId, input.source, scType, scId).run();
}

export async function listActiveIngestionIncidents(
  env: Env,
  orgId: string,
  limit = 50
): Promise<IngestionIncident[]> {
  const result = await env.D1.prepare(
    `SELECT * FROM ingestion_incidents
      WHERE org_id = ? AND status IN ('open','recovering','blocked')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
        last_seen_at DESC
      LIMIT ?`
  ).bind(orgId, limit).all<IngestionIncident>();
  return result.results;
}

export function incidentsToUserWarnings(
  incidents: IngestionIncident[]
): UserFacingIngestionWarning[] {
  return incidents
    .filter(i => i.source !== 'work_queue')
    .filter(i => i.severity === 'critical' || i.human_action_required === 1)
    .slice(0, 5)
    .map(i => ({
      type: `ingestion_incident:${i.id}`,
      message: i.message,
      severity: i.severity,
      source: i.source,
      incident_id: i.id,
      code: i.code,
      first_seen_at: i.first_seen_at,
      last_seen_at: i.last_seen_at,
      recovery_status: i.recovery_status,
      human_action_required: i.human_action_required === 1,
      recovery_window_start: i.recovery_window_start,
      recovery_window_end: i.recovery_window_end,
    }));
}

async function markIncidentRepairQueued(
  env: Env,
  incidentId: string,
  start: string,
  end: string
): Promise<void> {
  await env.D1.prepare(
    `UPDATE ingestion_incidents
        SET status = CASE WHEN human_action_required = 1 THEN 'blocked' ELSE 'recovering' END,
            recovery_status = CASE WHEN human_action_required = 1 THEN 'blocked_on_auth' ELSE 'repair_queued' END,
            recovery_window_start = COALESCE(recovery_window_start, ?),
            recovery_window_end = ?,
            repair_attempt_count = repair_attempt_count + 1,
            last_repair_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(start, end, incidentId).run();
}

function incidentMetadataUserId(incident: IngestionIncident): string {
  if (!incident.metadata) return '';
  try {
    const parsed = JSON.parse(incident.metadata) as { user_id?: unknown };
    return typeof parsed.user_id === 'string' ? parsed.user_id : '';
  } catch {
    return '';
  }
}

async function resolveOutlookEmailRepairUserId(env: Env, incident: IngestionIncident): Promise<string | null> {
  let userId = '';

  if (incident.scope_type === 'user') {
    userId = incident.scope_id;
  } else if (incident.scope_type === 'progressive_backfill_window') {
    const row = await env.D1.prepare(
      `SELECT p.user_id
         FROM progressive_backfill_windows w
         JOIN progressive_backfill_jobs p ON p.id = w.parent_id
        WHERE w.id = ?
          AND p.org_id = ?
        LIMIT 1`
    ).bind(incident.scope_id, incident.org_id).first<{ user_id: string }>();
    userId = row?.user_id || '';
  } else {
    userId = incidentMetadataUserId(incident);
  }

  if (!userId) return null;

  const active = await env.D1.prepare(
    `SELECT id
       FROM users
      WHERE id = ?
        AND org_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
      LIMIT 1`
  ).bind(userId, incident.org_id).first<{ id: string }>();

  return active?.id || null;
}

async function repairOutlookEmailIncident(env: Env, incident: IngestionIncident, start: string, end: string): Promise<boolean> {
  const userId = await resolveOutlookEmailRepairUserId(env, incident);
  if (!userId) return false;

  const { createProgressiveBackfillRange } = await import('./progressive-backfill');
  const result = await createProgressiveBackfillRange(
    incident.org_id,
    userId,
    start,
    end,
    10,
    env
  );
  return result.created || /already has active parent/i.test(result.reason || '');
}

async function repairCalendarIncident(env: Env, incident: IngestionIncident, start: string, end: string): Promise<boolean> {
  if (!incident.scope_id) return false;
  await env.D1.prepare(
    `UPDATE calendar_progressive_backfill_windows
        SET last_synced_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ?
        AND user_id = ?
        AND window_start < ?
        AND window_end > ?`
  ).bind(incident.org_id, incident.scope_id, end, start).run();
  const { enqueueCalendarRefreshes } = await import('./calendar-progressive-backfill');
  await enqueueCalendarRefreshes(incident.org_id, env);
  return true;
}

async function repairSlackIncident(env: Env, incident: IngestionIncident, start: string): Promise<boolean> {
  const daysBack = Math.min(90, Math.max(1, Math.ceil((Date.now() - Date.parse(start)) / 86400000)));
  if (incident.scope_type === 'channel' && incident.scope_id) {
    const result = await enqueueWork(
      env,
      incident.org_id,
      'slack_channel_backfill',
      { channel_id: incident.scope_id, days_back: daysBack },
      {
        upstream: 'slack',
        idempotency_key: `${incident.org_id}:${incident.scope_id}:${daysBack}:${new Date().toISOString().slice(0, 13)}`,
        max_attempts: 6,
      }
    );
    return result.inserted || Boolean(result.id);
  }

  const channels = await env.D1.prepare(
    `SELECT channel_id FROM slack_channels
      WHERE org_id = ?
        AND (last_error IS NOT NULL OR last_sync_at IS NULL)
      LIMIT 25`
  ).bind(incident.org_id).all<{ channel_id: string }>();
  let any = false;
  for (const channel of channels.results) {
    const result = await enqueueWork(
      env,
      incident.org_id,
      'slack_channel_backfill',
      { channel_id: channel.channel_id, days_back: daysBack },
      {
        upstream: 'slack',
        idempotency_key: `${incident.org_id}:${channel.channel_id}:${daysBack}:${new Date().toISOString().slice(0, 13)}`,
        max_attempts: 6,
      }
    );
    any = any || result.inserted || Boolean(result.id);
  }
  return any;
}

async function scanSlackMessageStaleness(orgId: string, env: Env): Promise<number> {
  const [latest, activeRepair] = await Promise.all([
    env.D1.prepare(
      `SELECT COUNT(*) AS total_rows,
              MAX(COALESCE(created_at, sent_at)) AS latest_staged_at,
              MAX(sent_at) AS latest_source_sent_at
         FROM conversations
        WHERE org_id = ? AND source = 'slack'`
    ).bind(orgId).first<{
      total_rows: number;
      latest_staged_at: string | null;
      latest_source_sent_at: string | null;
    }>(),
    env.D1.prepare(
      `SELECT COUNT(*) AS n
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'slack_channel_backfill'
          AND status IN ('pending','in_progress')`
    ).bind(orgId).first<{ n: number }>(),
  ]);

  if ((activeRepair?.n || 0) > 0) return 0;

  const now = Date.now();
  const latestStagedAt = latest?.latest_staged_at || null;
  const latestMs = latestStagedAt ? Date.parse(latestStagedAt) : NaN;
  if (Number.isFinite(latestMs) && now - latestMs < SLACK_MESSAGE_STALE_MS) {
    await reportIngestionSuccess(env, {
      orgId,
      source: 'slack',
      metadata: {
        latest_staged_at: latestStagedAt,
        latest_source_sent_at: latest?.latest_source_sent_at || null,
        total_rows: latest?.total_rows || 0,
      },
    }).catch(() => {});
    return 0;
  }

  const { findSlackRecentCoverageGaps } = await import('../integrations/slack');
  const coverage = await findSlackRecentCoverageGaps(orgId, env, {
    daysBack: SLACK_SELF_REPAIR_DAYS,
    maxChannels: 25,
    perChannelLimit: 20,
  });

  if (coverage.missing_messages === 0) {
    await reportIngestionSuccess(env, {
      orgId,
      source: 'slack',
      metadata: {
        latest_staged_at: latestStagedAt,
        latest_source_sent_at: latest?.latest_source_sent_at || null,
        total_rows: latest?.total_rows || 0,
        recent_verify: true,
        days_back: SLACK_SELF_REPAIR_DAYS,
        channels_scanned: coverage.channels_scanned,
        history_calls_ok: coverage.history_calls_ok,
        messages_seen: coverage.messages_seen,
        missing_messages: 0,
        channels_with_errors: coverage.channels_with_errors,
        errors_sample: coverage.errors.slice(0, 5),
      },
    }).catch(() => {});
    return 0;
  }

  let enqueued = 0;
  const hourKey = new Date(now).toISOString().slice(0, 13);
  for (const gap of coverage.channels_with_missing.slice(0, 10)) {
    const queued = await enqueueWork(
      env,
      orgId,
      'slack_channel_backfill',
      { channel_id: gap.channel_id, days_back: SLACK_SELF_REPAIR_DAYS },
      {
        upstream: 'slack',
        idempotency_key: `${orgId}:${gap.channel_id}:slack_recent_gap:${SLACK_SELF_REPAIR_DAYS}:${hourKey}`,
        max_attempts: 6,
      }
    );
    if (queued.inserted || queued.id) enqueued++;
  }

  const end = new Date(now).toISOString();
  const start = new Date(now - SLACK_SELF_REPAIR_DAYS * 86400000).toISOString();
  await reportIngestionFailure(env, {
    orgId,
    source: 'slack',
    scopeType: 'org',
    scopeId: orgId,
    code: 'slack_messages_stale',
    title: 'Slack message ingestion is stale',
    message: `Slack conversation rows have not advanced since ${latestStagedAt || 'never'}, and recent source verification found ${coverage.missing_messages} missing messages across ${coverage.channels_with_missing.length} channel(s).`,
    severity: 'warning',
    humanActionRequired: false,
    recoveryWindowStart: start,
    recoveryWindowEnd: end,
    metadata: {
      latest_staged_at: latestStagedAt,
      latest_source_sent_at: latest?.latest_source_sent_at || null,
      total_rows: latest?.total_rows || 0,
      days_back: SLACK_SELF_REPAIR_DAYS,
      channels_scanned: coverage.channels_scanned,
      history_calls_ok: coverage.history_calls_ok,
      messages_seen: coverage.messages_seen,
      missing_messages: coverage.missing_messages,
      channels_with_errors: coverage.channels_with_errors,
      backfills_enqueued: enqueued,
      gaps_sample: coverage.channels_with_missing.slice(0, 10),
      errors_sample: coverage.errors.slice(0, 5),
    },
  });
  return 1;
}

async function repairFireflyIncident(env: Env, incident: IngestionIncident, start: string, end: string): Promise<boolean> {
  if (!incident.scope_id) return false;
  const { createFireflyProgressiveBackfillRange } = await import('./firefly-progressive-backfill');
  const result = await createFireflyProgressiveBackfillRange(
    incident.org_id,
    incident.scope_id,
    start,
    end,
    10,
    null,
    env
  );
  return result.created || /already has active firefly parent/i.test(result.reason || '');
}

async function repairRagV2Incident(env: Env, incident: IngestionIncident): Promise<boolean> {
  const { scanAndRepairRagV2Coverage } = await import('./rag-v2');
  const sourceFamilies = incident.scope_type === 'source_family' && incident.scope_id
    ? [incident.scope_id]
    : undefined;
  const result = await scanAndRepairRagV2Coverage(env, incident.org_id, {
    sourceFamilies,
    limitPerSpec: 100,
    priority: 30,
  });
  return result.enqueued > 0 || result.already_queued > 0 || result.candidates > 0;
}

export async function enqueueAutomaticRepairForIncident(
  env: Env,
  incident: IngestionIncident
): Promise<boolean> {
  if (incident.human_action_required === 1) return false;
  if (incident.last_repair_at) {
    const lastRepairMs = Date.parse(incident.last_repair_at);
    if (Number.isFinite(lastRepairMs) && Date.now() - lastRepairMs < AUTO_REPAIR_COOLDOWN_MS) {
      return false;
    }
  }
  const window = repairWindow(incident.first_seen_at, incident.last_seen_at);
  const start = incident.recovery_window_start || window.start;
  const end = incident.recovery_window_end || window.end;

  let repaired = false;
  if (incident.source === 'outlook_email') repaired = await repairOutlookEmailIncident(env, incident, start, end);
  else if (incident.source === 'calendar') repaired = await repairCalendarIncident(env, incident, start, end);
  else if (incident.source === 'slack') repaired = await repairSlackIncident(env, incident, start);
  else if (incident.source === 'firefly') repaired = await repairFireflyIncident(env, incident, start, end);
  else if (incident.source === 'rag_v2') repaired = await repairRagV2Incident(env, incident);
  else if (incident.source === 'embedding') repaired = false;

  if (repaired) {
    await markIncidentRepairQueued(env, incident.id, start, end);
  }
  return repaired;
}

export async function reportWorkQueueOutcome(
  env: Env,
  row: { id: string; org_id: string; domain: string; payload: string; status?: string; last_error?: string | null },
  error: string | null
): Promise<void> {
  const source = workQueueSource(row.domain);
  const payload = parseWorkQueuePayload(row.payload);
  const userId = typeof payload.user_id === 'string' ? payload.user_id : '';
  const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : '';
  const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : '';
  const sourceType = typeof payload.source_type === 'string' ? payload.source_type : '';
  const sourceId = typeof payload.source_id === 'string' ? payload.source_id : '';
  const scopeType = conversationId
    ? 'conversation'
    : sourceId
      ? sourceType || 'source'
      : channelId
        ? 'channel'
        : userId
          ? 'user'
          : 'work_item';
  const scId = conversationId || sourceId || channelId || userId || row.id;

  if (!error) {
    await reportIngestionSuccess(env, {
      orgId: row.org_id,
      source,
      scopeType,
      scopeId: scId,
      metadata: { domain: row.domain, work_queue_id: row.id },
    });
    return;
  }

  const human = await isRepairBlockedByHumanAction(env, row, error);
  const vectorizeQuarantine = row.domain === 'embed_retry' && isQuarantinedVectorizePayload(error);
  const code = vectorizeQuarantine
    ? 'vectorize_payload_quarantined'
    : human && /token_refresh_failed/i.test(error)
    ? `${source}_reauth_required`
    : `work_queue_${row.domain}_failed`;
  await reportIngestionFailure(env, {
    orgId: row.org_id,
    source,
    scopeType,
    scopeId: scId,
    code,
    message: `${sourceTitle(source)} work item failed: ${truncate(error, 300)}`,
    severity: human ? 'critical' : 'warning',
    humanActionRequired: human,
    metadata: { domain: row.domain, work_queue_id: row.id, payload },
  });
}

export async function scanAndRepairIngestion(
  orgId: string,
  env: Env
): Promise<{ incidents: number; repairs_enqueued: number; dead_letters_requeued: number }> {
  let repairs = 0;
  let deadLettersRequeued = 0;

  const newsTreatmentDeadLetters = await env.D1.prepare(
    `SELECT id, last_error
       FROM work_queue
      WHERE org_id = ?
        AND status = 'dead_letter'
        AND domain = 'ingestion_treatment'
        AND last_error LIKE '%no such column: url%'
      ORDER BY completed_at DESC
      LIMIT 500`
  ).bind(orgId).all<{ id: string; last_error: string | null }>();
  for (const row of newsTreatmentDeadLetters.results) {
    const result = await env.D1.prepare(
      `UPDATE work_queue
          SET status = 'pending',
              attempt = 0,
              max_attempts = CASE WHEN max_attempts < 6 THEN 6 ELSE max_attempts END,
              next_attempt_at = NULL,
              completed_at = NULL,
              locked_until = NULL,
              last_error = ?
        WHERE id = ? AND status = 'dead_letter'`
    ).bind('auto_repair_requeued after news_articles.source_url fix', row.id).run();
    if (Number(result.meta?.changes || 0) > 0) deadLettersRequeued++;
  }

  const missingGraphConfig = !env.AZURE_CLIENT_ID ||
    !env.AZURE_TENANT_ID ||
    !env.AZURE_CLIENT_CERT_PRIVATE_KEY ||
    !env.AZURE_CLIENT_CERT_THUMBPRINT;
  if (missingGraphConfig) {
    await reportIngestionFailure(env, {
      orgId,
      source: 'outlook_email',
      scopeType: 'org',
      scopeId: orgId,
      code: 'outlook_app_only_config_missing',
      title: 'Outlook app-only configuration incomplete',
      message: 'Outlook ingestion requires app-only Microsoft Graph certificate configuration.',
      severity: 'critical',
      humanActionRequired: true,
      metadata: {
        missing: [
          !env.AZURE_CLIENT_ID ? 'AZURE_CLIENT_ID' : null,
          !env.AZURE_TENANT_ID ? 'AZURE_TENANT_ID' : null,
          !env.AZURE_CLIENT_CERT_PRIVATE_KEY ? 'AZURE_CLIENT_CERT_PRIVATE_KEY' : null,
          !env.AZURE_CLIENT_CERT_THUMBPRINT ? 'AZURE_CLIENT_CERT_THUMBPRINT' : null,
        ].filter(Boolean),
      },
    });
  }

  const deadLetters = await env.D1.prepare(
    `SELECT id, org_id, domain, payload, last_error, created_at
       FROM work_queue
      WHERE org_id = ?
        AND status = 'dead_letter'
        AND domain IN ('calendar_refresh','firefly_window','firefly_transcript_hydrate','embed_retry','rag_reindex_v2','slack_channel_backfill','attachment_backfill','deal_evidence_detect')
      ORDER BY completed_at DESC
      LIMIT 100`
  ).bind(orgId).all<{
    id: string;
    org_id: string;
    domain: string;
    payload: string;
    last_error: string | null;
    created_at: string;
  }>();

  for (const row of deadLetters.results) {
    const error = row.last_error || 'dead_letter';
    await reportWorkQueueOutcome(env, row, error);
    if (row.domain === 'embed_retry' && isQuarantinedVectorizePayload(error)) {
      continue;
    }
    if (!(await isRepairBlockedByHumanAction(env, row, error))) {
      await env.D1.prepare(
        `UPDATE work_queue
            SET status = 'pending',
                attempt = 0,
                max_attempts = CASE WHEN max_attempts < 6 THEN 6 ELSE max_attempts END,
                next_attempt_at = NULL,
                completed_at = NULL,
                locked_until = NULL,
                last_error = ?
          WHERE id = ? AND status = 'dead_letter'`
      ).bind(`auto_repair_requeued after dead_letter: ${truncate(error, 300)}`, row.id).run();
      deadLettersRequeued++;
    }
  }

  const slackAuthFailures = await env.KV.get(`slack_token_failed:${orgId}`);
  const slackFailureCount = slackAuthFailures ? parseInt(slackAuthFailures, 10) : 0;
  if (slackFailureCount >= 3) {
    await reportIngestionFailure(env, {
      orgId,
      source: 'slack',
      code: 'slack_auth_failed',
      title: 'Slack reconnect required',
      message: `Slack ingestion is blocked. The bot token has failed ${slackFailureCount} consecutive checks and needs reinstalling or replacing.`,
      severity: 'critical',
      humanActionRequired: true,
      metadata: { consecutive_failures: slackFailureCount },
    });
  }

  const channelErrors = await env.D1.prepare(
    `SELECT channel_id, channel_name, last_error, last_sync_at
       FROM slack_channels
      WHERE org_id = ? AND last_error IS NOT NULL
      LIMIT 25`
  ).bind(orgId).all<{ channel_id: string; channel_name: string | null; last_error: string | null; last_sync_at: string | null }>();
  for (const ch of channelErrors.results) {
    const message = ch.last_error || 'channel_sync_failed';
    await reportIngestionFailure(env, {
      orgId,
      source: 'slack',
      scopeType: 'channel',
      scopeId: ch.channel_id,
      code: 'slack_channel_sync_failed',
      message: `Slack channel #${ch.channel_name || ch.channel_id} is not syncing cleanly: ${message}.`,
      severity: isHumanActionError(message) ? 'critical' : 'warning',
      humanActionRequired: /cannot_join|not_in_channel|missing_scope|restricted_action/i.test(message),
      metadata: { channel_name: ch.channel_name, last_sync_at: ch.last_sync_at },
    });
  }

  try {
    const { scanAndRepairRagV2Coverage, getRagV2SourceFreshness } = await import('./rag-v2');
    const repair = await scanAndRepairRagV2Coverage(env, orgId, {
      sourceFamilies: ['slack'],
      limitPerSpec: 100,
      priority: 30,
    });
    repairs += repair.enqueued;

    const slackFreshness = repair.freshness.find(row => row.source_family === 'slack') ||
      await getRagV2SourceFreshness(env, orgId, 'slack');
    const lag = slackFreshness?.freshness_lag_ms;
    const hasUnindexedSlack = Boolean(slackFreshness && (
      slackFreshness.missing_sources > 0 ||
      slackFreshness.incomplete_sources > 0 ||
      (typeof lag === 'number' && lag > RAG_V2_FRESHNESS_SLO_MS) ||
      (slackFreshness.total_sources > 0 && !slackFreshness.latest_indexed_source_at)
    ));

    if (hasUnindexedSlack && slackFreshness) {
      await reportIngestionFailure(env, {
        orgId,
        source: 'rag_v2',
        scopeType: 'source_family',
        scopeId: 'slack',
        code: 'rag_v2_slack_freshness_lag',
        title: 'MARTy Slack retrieval index is behind',
        message: `MARTy RAG v2 Slack index is stale: latest Slack source=${slackFreshness.latest_source_at || 'none'}, latest indexed=${slackFreshness.latest_indexed_source_at || 'none'}, missing=${slackFreshness.missing_sources}, incomplete=${slackFreshness.incomplete_sources}.`,
        severity: 'warning',
        humanActionRequired: false,
        metadata: {
          ...slackFreshness,
          repair_enqueued: repair.enqueued,
          repair_already_queued: repair.already_queued,
          repair_errors: repair.errors.slice(0, 5),
        },
      });
    } else if (slackFreshness) {
      await reportIngestionSuccess(env, {
        orgId,
        source: 'rag_v2',
        scopeType: 'source_family',
        scopeId: 'slack',
        metadata: slackFreshness as unknown as Record<string, unknown>,
      });
    }
  } catch (e) {
    await reportIngestionFailure(env, {
      orgId,
      source: 'rag_v2',
      scopeType: 'source_family',
      scopeId: 'slack',
      code: 'rag_v2_slack_freshness_scan_failed',
      title: 'MARTy Slack retrieval index scan failed',
      message: `RAG v2 Slack freshness scanner failed: ${truncate(errToString(e), 300)}`,
      severity: 'warning',
      humanActionRequired: false,
    });
  }

  await scanFireflySilence(orgId, env);
  await scanSlackMessageStaleness(orgId, env);

  const incidents = await listActiveIngestionIncidents(env, orgId, 100);
  for (const incident of incidents) {
    if (await enqueueAutomaticRepairForIncident(env, incident)) repairs++;
  }

  return {
    incidents: incidents.length,
    repairs_enqueued: repairs,
    dead_letters_requeued: deadLettersRequeued,
  };
}

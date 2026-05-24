import type { Env } from '../types/env';
import { getActiveUsersForOrg } from './helpers';
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

function scopeId(input: string | null | undefined): string {
  return input || '';
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(input: string, max = 800): string {
  return input.length > max ? input.slice(0, max) : input;
}

function sourceTitle(source: string): string {
  switch (source) {
    case 'outlook_email': return 'Outlook email ingestion';
    case 'calendar': return 'Calendar ingestion';
    case 'slack': return 'Slack ingestion';
    case 'firefly': return 'Meeting transcript ingestion';
    case 'embedding': return 'Embedding repair';
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

function workQueueSource(domain: string): IngestionSource {
  if (domain === 'calendar_refresh') return 'calendar';
  if (domain === 'firefly_window') return 'firefly';
  if (domain === 'embed_retry') return 'embedding';
  if (domain === 'slack_channel_backfill') return 'slack';
  return 'work_queue';
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
        AND status IN ('open','recovering')`
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

async function repairOutlookEmailIncident(env: Env, incident: IngestionIncident, start: string, end: string): Promise<boolean> {
  if (!incident.scope_id) return false;
  const { createProgressiveBackfillRange } = await import('./progressive-backfill');
  const result = await createProgressiveBackfillRange(
    incident.org_id,
    incident.scope_id,
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
  else if (incident.source === 'embedding') repaired = true;

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
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch { /* ignore */ }
  const userId = typeof payload.user_id === 'string' ? payload.user_id : '';
  const channelId = typeof payload.channel_id === 'string' ? payload.channel_id : '';
  const scopeType = channelId ? 'channel' : userId ? 'user' : 'work_item';
  const scId = channelId || userId || row.id;

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

  const human = isHumanActionError(error);
  await reportIngestionFailure(env, {
    orgId: row.org_id,
    source,
    scopeType,
    scopeId: scId,
    code: `work_queue_${row.domain}_failed`,
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

  const users = await getActiveUsersForOrg(orgId, env);
  for (const user of users) {
    if (!user.outlook_token) continue;
    const state = await env.KV.get<{ count: number; last_failed?: string; reason?: string; message?: string }>(
      `token_failed:${user.id}:outlook`,
      'json'
    );
    if (state && state.count >= 3) {
      await reportIngestionFailure(env, {
        orgId,
        source: 'outlook_email',
        scopeType: 'user',
        scopeId: user.id,
        code: 'outlook_reauth_required',
        title: 'Outlook reconnect required',
        message: `Outlook ingestion is blocked for ${user.email}. Refresh Microsoft Outlook to resume email and calendar sync; automatic repair will run after reconnect.`,
        severity: 'critical',
        humanActionRequired: true,
        occurredAt: state.last_failed,
        metadata: { email: user.email, consecutive_failures: state.count, reason: state.reason, message: state.message },
      });
      await reportIngestionFailure(env, {
        orgId,
        source: 'calendar',
        scopeType: 'user',
        scopeId: user.id,
        code: 'outlook_reauth_required',
        title: 'Calendar reconnect required',
        message: `Calendar ingestion is blocked for ${user.email}. Refresh Microsoft Outlook to resume calendar sync; automatic repair will run after reconnect.`,
        severity: 'critical',
        humanActionRequired: true,
        occurredAt: state.last_failed,
        metadata: { email: user.email, consecutive_failures: state.count, reason: state.reason, message: state.message },
      });
    }
  }

  const deadLetters = await env.D1.prepare(
    `SELECT id, org_id, domain, payload, last_error, created_at
       FROM work_queue
      WHERE org_id = ?
        AND status = 'dead_letter'
        AND domain IN ('calendar_refresh','firefly_window','embed_retry','slack_channel_backfill')
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
    if (!isHumanActionError(error)) {
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

import type { Env } from '../types/env';
import type { IngestionIncident } from './ingestion-health';
import { getAppOnlyGraphAccessToken, graphMailboxUrl } from './graph-auth';
import {
  ensureSubscriptionsForUser,
  expectedSubscriptionResourcesForMailbox,
  graphSubscriptionWebhookUrl,
} from './graph-subscriptions';

const PROBE_CACHE_TTL_SECONDS = 5 * 60;
const STALE_DELEGATED_RE = /token_refresh_failed|missing_token|refresh token|reauth|required|delegated/i;
const STALE_DELEGATED_WORK_SQL = `(
  last_error LIKE '%token_refresh_failed%' OR
  last_error LIKE '%missing_token%' OR
  last_error LIKE '%No Outlook token%' OR
  last_error LIKE '%refresh token%' OR
  last_error LIKE '%reauth%'
)`;

export type OutlookMailboxHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'blocked'
  | 'missing_mailbox';

export type OutlookOverallHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'blocked'
  | 'missing_config';

export interface OutlookSubscriptionHealth {
  expected: string[];
  current: string[];
  missing: string[];
  expired: string[];
  legacy: string[];
}

export interface OutlookGraphProbeHealth {
  checked_at: string | null;
  messages_status: number | null;
  calendar_status: number | null;
  messages_ok: boolean | null;
  calendar_ok: boolean | null;
  error: string | null;
}

export interface OutlookMailboxHealth {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  mailbox: string | null;
  status: OutlookMailboxHealthStatus;
  blockers: string[];
  warnings: string[];
  graph: OutlookGraphProbeHealth;
  subscriptions: OutlookSubscriptionHealth;
  last_email_ingested_at: string | null;
  last_email_sent_at: string | null;
  conversation_count: number;
  last_calendar_success_at: string | null;
  last_calendar_failure_at: string | null;
  pending_work: number;
  dead_letter_work: number;
  stale_delegated_incident_ids: string[];
}

export interface OutlookAppOnlyHealthSnapshot {
  generated_at: string;
  auth_mode: 'app_only' | 'delegated_fallback';
  configured: boolean;
  status: OutlookOverallHealthStatus;
  label: string;
  detail: string;
  summary: {
    total_mailboxes: number;
    healthy_mailboxes: number;
    degraded_mailboxes: number;
    blocked_mailboxes: number;
    missing_mailboxes: number;
    missing_subscriptions: number;
    expired_subscriptions: number;
    legacy_subscriptions: number;
    stale_delegated_incidents: number;
  };
  mailboxes: OutlookMailboxHealth[];
  suppressed_incident_ids: string[];
  warnings: string[];
  blockers: string[];
}

interface SnapshotOptions {
  includeGraphProbes?: boolean;
  forceGraphProbe?: boolean;
}

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  outlook_mailbox: string | null;
}

interface SubscriptionRow {
  user_id: string;
  resource: string;
  expiration_at: string;
}

interface SourceStateRow {
  source: string;
  scope_id: string;
  status: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
}

interface ConversationStatRow {
  user_id: string;
  conversation_count: number;
  last_ingested_at: string | null;
  last_sent_at: string | null;
}

interface WorkQueueStatRow {
  user_id: string;
  pending_count: number;
  dead_letter_count: number;
}

interface CachedProbeMap {
  generated_at: string;
  probes: Record<string, OutlookGraphProbeHealth>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function appOnlyConfigured(env: Env): boolean {
  return Boolean(
    env.AZURE_CLIENT_ID &&
    env.AZURE_TENANT_ID &&
    env.AZURE_CLIENT_CERT_PRIVATE_KEY &&
    env.AZURE_CLIENT_CERT_THUMBPRINT
  );
}

function authMode(env: Env): 'app_only' | 'delegated_fallback' {
  return env.OUTLOOK_AUTH_MODE === 'delegated_fallback' ? 'delegated_fallback' : 'app_only';
}

function isFuture(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > Date.now();
}

function isStaleDelegatedOutlookIncident(incident: Pick<IngestionIncident, 'source' | 'code' | 'message'>): boolean {
  if (incident.source !== 'outlook_email' && incident.source !== 'calendar') return false;
  return STALE_DELEGATED_RE.test(`${incident.code || ''} ${incident.message || ''}`);
}

function emptyProbe(): OutlookGraphProbeHealth {
  return {
    checked_at: null,
    messages_status: null,
    calendar_status: null,
    messages_ok: null,
    calendar_ok: null,
    error: null,
  };
}

async function fetchJsonStatus(token: string, mailbox: string, path: string): Promise<{ status: number; ok: boolean; error: string | null }> {
  try {
    const resp = await fetch(graphMailboxUrl(mailbox, path), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    let error: string | null = null;
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      error = body.slice(0, 300) || `HTTP ${resp.status}`;
    }
    return { status: resp.status, ok: resp.ok, error };
  } catch (e) {
    return { status: 0, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function loadProbeCache(orgId: string, env: Env): Promise<CachedProbeMap | null> {
  return env.KV.get<CachedProbeMap>(`outlook_app_only_health:${orgId}:probes`, 'json').catch(() => null);
}

async function runGraphProbes(orgId: string, users: UserRow[], env: Env): Promise<Record<string, OutlookGraphProbeHealth>> {
  const probes: Record<string, OutlookGraphProbeHealth> = {};
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken(env);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    for (const user of users) {
      probes[user.id] = { ...emptyProbe(), checked_at: nowIso(), messages_ok: false, calendar_ok: false, error };
    }
    return probes;
  }

  await Promise.all(users.map(async user => {
    const mailbox = (user.outlook_mailbox || user.email || '').trim().toLowerCase();
    if (!mailbox) {
      probes[user.id] = emptyProbe();
      return;
    }
    const start = encodeURIComponent(new Date(Date.now() - 24 * 3600_000).toISOString());
    const end = encodeURIComponent(new Date(Date.now() + 24 * 3600_000).toISOString());
    const [messages, calendar] = await Promise.all([
      fetchJsonStatus(token, mailbox, '/messages?$top=1&$select=id,receivedDateTime'),
      fetchJsonStatus(token, mailbox, `/calendarView?startDateTime=${start}&endDateTime=${end}&$top=1&$select=id,start,end`),
    ]);
    probes[user.id] = {
      checked_at: nowIso(),
      messages_status: messages.status,
      calendar_status: calendar.status,
      messages_ok: messages.ok,
      calendar_ok: calendar.ok,
      error: messages.error || calendar.error,
    };
  }));

  await env.KV.put(
    `outlook_app_only_health:${orgId}:probes`,
    JSON.stringify({ generated_at: nowIso(), probes } satisfies CachedProbeMap),
    { expirationTtl: PROBE_CACHE_TTL_SECONDS }
  ).catch(() => {});
  return probes;
}

async function getProbeMap(orgId: string, users: UserRow[], env: Env, options: SnapshotOptions): Promise<Record<string, OutlookGraphProbeHealth>> {
  if (!options.includeGraphProbes) return {};
  if (!options.forceGraphProbe) {
    const cached = await loadProbeCache(orgId, env);
    if (cached?.probes) return cached.probes;
  }
  return runGraphProbes(orgId, users, env);
}

function bucketBy<T extends Record<string, any>>(rows: T[], key: keyof T): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const value = String(row[key] || '');
    if (!out.has(value)) out.set(value, []);
    out.get(value)!.push(row);
  }
  return out;
}

export function expectedResourcesForMailbox(mailbox: string): string[] {
  return expectedSubscriptionResourcesForMailbox(mailbox);
}

export function filterOutlookIncidentsForUserReports(
  incidents: IngestionIncident[],
  health: OutlookAppOnlyHealthSnapshot | null
): IngestionIncident[] {
  if (!health) return incidents;
  const suppressed = new Set(health.suppressed_incident_ids);
  return incidents.filter(i => !suppressed.has(i.id));
}

export async function getOutlookAppOnlyHealthSnapshot(
  orgId: string,
  env: Env,
  options: SnapshotOptions = {}
): Promise<OutlookAppOnlyHealthSnapshot> {
  const generatedAt = nowIso();
  const configured = appOnlyConfigured(env);
  const mode = authMode(env);
  const [
    usersResult,
    subsResult,
    statesResult,
    incidentsResult,
    convoStatsResult,
    workQueueStatsResult,
  ] = await Promise.all([
    env.D1.prepare(
      `SELECT id, email, full_name, role, outlook_mailbox
         FROM users
        WHERE org_id = ? AND deleted_at IS NULL AND is_active = 1
        ORDER BY email`
    ).bind(orgId).all<UserRow>(),
    env.D1.prepare(
      `SELECT user_id, resource, expiration_at
         FROM graph_subscriptions
        WHERE org_id = ?`
    ).bind(orgId).all<SubscriptionRow>(),
    env.D1.prepare(
      `SELECT source, scope_id, status, last_success_at, last_failure_at, last_error_code, last_error
         FROM ingestion_source_state
        WHERE org_id = ? AND source IN ('outlook_email','calendar')`
    ).bind(orgId).all<SourceStateRow>(),
    env.D1.prepare(
      `SELECT *
         FROM ingestion_incidents
        WHERE org_id = ?
          AND source IN ('outlook_email','calendar')
          AND status IN ('open','recovering','blocked')`
    ).bind(orgId).all<IngestionIncident>(),
    env.D1.prepare(
      `SELECT cp.user_id AS user_id,
              COUNT(DISTINCT c.id) AS conversation_count,
              MAX(c.created_at) AS last_ingested_at,
              MAX(c.sent_at) AS last_sent_at
         FROM conversation_participants cp
         JOIN conversations c
           ON c.id = cp.conversation_id
          AND c.org_id = cp.org_id
        WHERE cp.org_id = ?
          AND c.source = 'outlook'
        GROUP BY cp.user_id`
    ).bind(orgId).all<ConversationStatRow>(),
    env.D1.prepare(
      `SELECT json_extract(payload, '$.user_id') AS user_id,
              SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count
         FROM work_queue
        WHERE org_id = ?
          AND domain IN ('calendar_refresh','outlook_email')
        GROUP BY json_extract(payload, '$.user_id')`
    ).bind(orgId).all<WorkQueueStatRow>(),
  ]);

  const users = usersResult.results || [];
  let subscriptionWebhookError: string | null = null;
  try {
    graphSubscriptionWebhookUrl(env);
  } catch (e) {
    subscriptionWebhookError = e instanceof Error ? e.message : String(e);
  }
  const probes = await getProbeMap(orgId, users, env, options);
  const subsByUser = bucketBy(subsResult.results || [], 'user_id');
  const statesByUser = bucketBy(statesResult.results || [], 'scope_id');
  const incidentsByUser = bucketBy(incidentsResult.results || [], 'scope_id');
  const convoByUser = new Map((convoStatsResult.results || []).map(r => [r.user_id, r]));
  const workByUser = new Map((workQueueStatsResult.results || []).map(r => [r.user_id, r]));

  const mailboxes: OutlookMailboxHealth[] = users.map(user => {
    const mailbox = (user.outlook_mailbox || user.email || '').trim().toLowerCase() || null;
    const expected = mailbox ? expectedResourcesForMailbox(mailbox) : [];
    const subRows = subsByUser.get(user.id) || [];
    const current = subRows.filter(s => expected.includes(s.resource) && isFuture(s.expiration_at)).map(s => s.resource);
    const expired = subRows.filter(s => expected.includes(s.resource) && !isFuture(s.expiration_at)).map(s => s.resource);
    const legacy = subRows.filter(s => /^me\//i.test(s.resource)).map(s => s.resource);
    const missing = expected.filter(r => !current.includes(r));
    const sourceStates = statesByUser.get(user.id) || [];
    const emailState = sourceStates.find(s => s.source === 'outlook_email');
    const calendarState = sourceStates.find(s => s.source === 'calendar');
    const staleDelegated = (incidentsByUser.get(user.id) || []).filter(isStaleDelegatedOutlookIncident);
    const convo = convoByUser.get(user.id);
    const work = workByUser.get(user.id);
    const graph = probes[user.id] || emptyProbe();
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (!mailbox) blockers.push('No mailbox target is configured.');
    if (configured && options.includeGraphProbes && (graph.messages_ok === false || graph.calendar_ok === false)) {
      blockers.push(`Graph probe failed${graph.error ? `: ${graph.error}` : ''}.`);
    }
    if (configured && subscriptionWebhookError && missing.length > 0) {
      blockers.push(subscriptionWebhookError);
    }
    if (missing.length > 0) warnings.push(`${missing.length} required Graph subscription${missing.length === 1 ? '' : 's'} missing.`);
    if (expired.length > 0) warnings.push(`${expired.length} Graph subscription${expired.length === 1 ? '' : 's'} expired.`);
    if (legacy.length > 0) warnings.push(`${legacy.length} delegated /me subscription${legacy.length === 1 ? '' : 's'} should be retired.`);
    if ((work?.dead_letter_count || 0) > 0) warnings.push(`${work?.dead_letter_count || 0} Outlook work item${work?.dead_letter_count === 1 ? '' : 's'} dead-lettered.`);
    if (staleDelegated.length > 0 && graph.messages_ok === true && graph.calendar_ok === true) {
      warnings.push(`${staleDelegated.length} stale delegated OAuth incident${staleDelegated.length === 1 ? '' : 's'} can be resolved.`);
    }
    if (!convo?.last_ingested_at && (work?.pending_count || 0) === 0) warnings.push('No recent mailbox ingestion evidence found.');

    let status: OutlookMailboxHealthStatus = 'healthy';
    if (!mailbox) status = 'missing_mailbox';
    else if (blockers.length > 0) status = 'blocked';
    else if (warnings.length > 0) status = 'degraded';

    return {
      user_id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      mailbox,
      status,
      blockers,
      warnings,
      graph,
      subscriptions: { expected, current, missing, expired, legacy },
      last_email_ingested_at: convo?.last_ingested_at || emailState?.last_success_at || null,
      last_email_sent_at: convo?.last_sent_at || null,
      conversation_count: Number(convo?.conversation_count || 0),
      last_calendar_success_at: calendarState?.last_success_at || null,
      last_calendar_failure_at: calendarState?.last_failure_at || null,
      pending_work: Number(work?.pending_count || 0),
      dead_letter_work: Number(work?.dead_letter_count || 0),
      stale_delegated_incident_ids: staleDelegated.map(i => i.id),
    };
  });

  const suppressed = new Set<string>();
  for (const mailbox of mailboxes) {
    const graphHealthy = mailbox.graph.messages_ok === true && mailbox.graph.calendar_ok === true;
    if (configured && graphHealthy) {
      for (const id of mailbox.stale_delegated_incident_ids) suppressed.add(id);
    }
  }

  const missingMailboxCount = mailboxes.filter(m => m.status === 'missing_mailbox').length;
  const blockedMailboxCount = mailboxes.filter(m => m.status === 'blocked').length;
  const degradedMailboxCount = mailboxes.filter(m => m.status === 'degraded').length;
  const healthyMailboxCount = mailboxes.filter(m => m.status === 'healthy').length;
  const missingSubs = mailboxes.reduce((sum, m) => sum + m.subscriptions.missing.length, 0);
  const expiredSubs = mailboxes.reduce((sum, m) => sum + m.subscriptions.expired.length, 0);
  const legacySubs = mailboxes.reduce((sum, m) => sum + m.subscriptions.legacy.length, 0);
  const staleDelegated = mailboxes.reduce((sum, m) => sum + m.stale_delegated_incident_ids.length, 0);

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!configured) blockers.push('Microsoft Graph app-only certificate configuration is incomplete.');
  if (configured && subscriptionWebhookError && missingSubs > 0) blockers.push(subscriptionWebhookError);
  if (missingMailboxCount > 0) blockers.push(`${missingMailboxCount} platform user${missingMailboxCount === 1 ? '' : 's'} have no mailbox target.`);
  if (blockedMailboxCount > 0) blockers.push(`${blockedMailboxCount} mailbox${blockedMailboxCount === 1 ? '' : 'es'} blocked app-only ingestion.`);
  if (missingSubs > 0) warnings.push(`${missingSubs} required Graph subscription${missingSubs === 1 ? '' : 's'} missing.`);
  if (expiredSubs > 0) warnings.push(`${expiredSubs} required Graph subscription${expiredSubs === 1 ? '' : 's'} expired.`);
  if (legacySubs > 0) warnings.push(`${legacySubs} delegated /me subscription${legacySubs === 1 ? '' : 's'} should be retired.`);
  if (staleDelegated > 0) warnings.push(`${staleDelegated} stale delegated OAuth incident${staleDelegated === 1 ? '' : 's'} found.`);
  if (degradedMailboxCount > 0) warnings.push(`${degradedMailboxCount} mailbox${degradedMailboxCount === 1 ? '' : 'es'} need repair.`);

  let status: OutlookOverallHealthStatus = 'healthy';
  if (!configured) status = 'missing_config';
  else if (blockers.length > 0) status = 'blocked';
  else if (warnings.length > 0) status = 'degraded';

  const label = status === 'healthy'
    ? 'Healthy'
    : status === 'missing_config'
      ? 'Tenant setup needed'
      : status === 'blocked'
        ? 'Blocked'
        : 'Repair needed';
  const detail = status === 'healthy'
    ? `App-only Graph ingestion is healthy for ${healthyMailboxCount}/${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}.`
    : (blockers[0] || warnings[0] || 'Outlook app-only ingestion needs attention.');

  return {
    generated_at: generatedAt,
    auth_mode: mode,
    configured,
    status,
    label,
    detail,
    summary: {
      total_mailboxes: mailboxes.length,
      healthy_mailboxes: healthyMailboxCount,
      degraded_mailboxes: degradedMailboxCount,
      blocked_mailboxes: blockedMailboxCount,
      missing_mailboxes: missingMailboxCount,
      missing_subscriptions: missingSubs,
      expired_subscriptions: expiredSubs,
      legacy_subscriptions: legacySubs,
      stale_delegated_incidents: staleDelegated,
    },
    mailboxes,
    suppressed_incident_ids: [...suppressed],
    warnings,
    blockers,
  };
}

export interface OutlookAppOnlyRepairResult {
  ok: boolean;
  apply: boolean;
  health: OutlookAppOnlyHealthSnapshot;
  actions: Array<{ type: string; count?: number; user_id?: string; email?: string | null; detail?: string }>;
}

export async function repairOutlookAppOnlyState(
  orgId: string,
  env: Env,
  options: { apply?: boolean } = {}
): Promise<OutlookAppOnlyRepairResult> {
  const apply = options.apply === true;
  const health = await getOutlookAppOnlyHealthSnapshot(orgId, env, {
    includeGraphProbes: true,
    forceGraphProbe: true,
  });
  const actions: OutlookAppOnlyRepairResult['actions'] = [];
  const globallySafe = health.configured && health.mailboxes.every(m =>
    m.mailbox &&
    m.graph.messages_ok === true &&
    m.graph.calendar_ok === true
  );

  if (!globallySafe) {
    return {
      ok: false,
      apply,
      health,
      actions: [{ type: 'blocked', detail: 'App-only Graph probes must pass for every platform mailbox before stale delegated state is repaired.' }],
    };
  }

  const userIds = health.mailboxes.map(m => m.user_id);
  const staleIds = [...new Set(health.mailboxes.flatMap(m => m.stale_delegated_incident_ids))];
  const resettableDeadLetters = health.mailboxes.filter(m => m.dead_letter_work > 0);
  const legacyCount = health.summary.legacy_subscriptions;
  const staleWorkErrorRow = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ?
        AND domain IN ('calendar_refresh','outlook_email')
        AND last_error IS NOT NULL
        AND ${STALE_DELEGATED_WORK_SQL}`
  ).bind(orgId).first<{ count: number }>();
  const staleWorkErrorCount = Number(staleWorkErrorRow?.count || 0);

  if (staleIds.length > 0) {
    actions.push({ type: 'resolve_stale_delegated_incidents', count: staleIds.length });
  }
  actions.push({ type: 'clear_outlook_token_failure_kv', count: userIds.length });
  if (staleWorkErrorCount > 0) {
    actions.push({ type: 'clear_stale_delegated_work_queue_errors', count: staleWorkErrorCount });
  }
  if (resettableDeadLetters.length > 0) {
    actions.push({ type: 'reset_delegated_calendar_dead_letters', count: resettableDeadLetters.reduce((sum, m) => sum + m.dead_letter_work, 0) });
  }
  if (legacyCount > 0) {
    actions.push({ type: 'delete_legacy_me_subscriptions', count: legacyCount });
  }
  for (const mailbox of health.mailboxes) {
    actions.push({
      type: 'ensure_user_subscriptions',
      user_id: mailbox.user_id,
      email: mailbox.email,
      detail: mailbox.mailbox || undefined,
    });
  }

  if (apply) {
    const ensureErrors: OutlookAppOnlyRepairResult['actions'] = [];
    for (const mailbox of health.mailboxes) {
      const result = await ensureSubscriptionsForUser(mailbox.user_id, orgId, env);
      if (result?.errors.length) {
        ensureErrors.push({
          type: 'subscription_create_failed',
          user_id: mailbox.user_id,
          email: mailbox.email,
          detail: result.errors.join(' | ').slice(0, 1000),
        });
      }
    }
    const subscriptionCheckedHealth = await getOutlookAppOnlyHealthSnapshot(orgId, env, {
      includeGraphProbes: true,
    });
    const subscriptionGaps =
      subscriptionCheckedHealth.summary.missing_subscriptions +
      subscriptionCheckedHealth.summary.expired_subscriptions;
    if (subscriptionGaps > 0) {
      return {
        ok: false,
        apply,
        health: subscriptionCheckedHealth,
        actions: [
          ...actions,
          ...ensureErrors,
          {
            type: 'blocked',
            detail: `${subscriptionGaps} required app-only Graph subscription${subscriptionGaps === 1 ? '' : 's'} could not be created; stale delegated state was not cleared.`,
          },
        ],
      };
    }

    for (const id of staleIds) {
      await env.D1.prepare(
        `UPDATE ingestion_incidents
            SET status = 'resolved',
                resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                last_success_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                recovery_status = 'idle',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(id, orgId).run();
    }
    await Promise.all(userIds.map(id => env.KV.delete(`token_failed:${id}:outlook`).catch(() => {})));
    if (staleWorkErrorCount > 0) {
      await env.D1.prepare(
        `UPDATE work_queue
            SET last_error = NULL,
                attempt = CASE WHEN status = 'pending' THEN 0 ELSE attempt END,
                next_attempt_at = CASE WHEN status = 'pending' THEN NULL ELSE next_attempt_at END
          WHERE org_id = ?
            AND domain IN ('calendar_refresh','outlook_email')
            AND last_error IS NOT NULL
            AND ${STALE_DELEGATED_WORK_SQL}`
      ).bind(orgId).run();
    }
    if (resettableDeadLetters.length > 0) {
      for (const user of resettableDeadLetters) {
        await env.D1.prepare(
          `UPDATE work_queue
              SET status = 'pending',
                  attempt = 0,
                  max_attempts = CASE WHEN max_attempts < 6 THEN 6 ELSE max_attempts END,
                  next_attempt_at = NULL,
                  locked_until = NULL,
                  completed_at = NULL,
                  last_error = NULL
            WHERE org_id = ?
              AND domain = 'calendar_refresh'
              AND status = 'dead_letter'
              AND json_extract(payload, '$.user_id') = ?
              AND ${STALE_DELEGATED_WORK_SQL}`
        ).bind(orgId, user.user_id).run();
      }
    }
    if (legacyCount > 0) {
      await env.D1.prepare(
        `DELETE FROM graph_subscriptions
          WHERE org_id = ? AND resource LIKE 'me/%'`
      ).bind(orgId).run();
    }
  }

  return { ok: true, apply, health, actions };
}

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { getOrgSettings, hasOrgWidePrivateDataAccess } from './helpers';
import { buildLiveMartyRuntimeFingerprint } from './marty-runtime';

export type PlatformTelemetryTopic =
  | 'auto'
  | 'user_ingestion'
  | 'data_coverage'
  | 'pipeline_health'
  | 'work_queue'
  | 'platform_overview';

export interface PlatformTelemetryInput {
  topic?: PlatformTelemetryTopic;
  query?: string;
  subject?: string;
  user_id?: string;
  email?: string;
  days_back?: number;
  limit?: number;
}

interface TelemetryUserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  is_active: number;
  has_outlook_token: number;
  has_inbox_delta_token: number;
  created_at: string | null;
  updated_at: string | null;
}

interface UserCandidate {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  score: number;
  reasons: string[];
}

const PLATFORM_LIMIT_DEFAULT = 10;
const PLATFORM_LIMIT_MAX = 50;
const BUDGET_WINDOW_MS: Record<string, number> = {
  per_second: 1_000,
  minute: 60_000,
  ten_minute: 600_000,
  hourly: 3_600_000,
  daily: 86_400_000,
};

function normalizeEmail(value: unknown): string | null {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pct(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((current / total) * 100);
}

function clampLimit(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return PLATFORM_LIMIT_DEFAULT;
  return Math.min(Math.max(n, 1), PLATFORM_LIMIT_MAX);
}

function safeJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function objectJson(value: unknown): Record<string, any> {
  const parsed = safeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function statusCounts(rows: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const status = String(row.status || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function summarizeCadence(rows: any[], timestampField = 'started_at'): Record<string, unknown> {
  const stamps = (rows || [])
    .map(row => Date.parse(row[timestampField] || row.created_at || ''))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = stamps.slice(1).map((stamp, idx) => Math.round((stamp - stamps[idx]) / 60000));
  const avg = gaps.length > 0
    ? Math.round(gaps.reduce((acc, gap) => acc + gap, 0) / gaps.length)
    : null;
  return {
    observed_runs: stamps.length,
    first_observed_at: stamps.length ? new Date(stamps[0]).toISOString() : null,
    latest_observed_at: stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : null,
    average_gap_minutes: avg,
    min_gap_minutes: gaps.length ? Math.min(...gaps) : null,
    max_gap_minutes: gaps.length ? Math.max(...gaps) : null,
    status_counts: statusCounts(rows),
  };
}

function summarizeBudgetRow(row: any): Record<string, unknown> {
  const used = asNumber(row.used);
  const cap = asNumber(row.cap);
  const bucketStartMs = Date.parse(row.bucket_start || '');
  const windowMs = BUDGET_WINDOW_MS[String(row.bucket_window || '')] || 0;
  const circuitMs = Date.parse(row.circuit_open_until || '');
  return {
    upstream: row.upstream,
    user_id: row.user_id,
    bucket_window: row.bucket_window,
    bucket_start: row.bucket_start,
    window_ends_at: Number.isFinite(bucketStartMs) && windowMs > 0
      ? new Date(bucketStartMs + windowMs).toISOString()
      : null,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    utilization_percentage: pct(used, cap),
    last_429_at: row.last_429_at || null,
    consecutive_429s: asNumber(row.consecutive_429s),
    circuit_open_until: row.circuit_open_until || null,
    circuit_open_now: Number.isFinite(circuitMs) && circuitMs > Date.now(),
    cap_lowered_at: row.cap_lowered_at || null,
    cap_lowered_count: asNumber(row.cap_lowered_count),
    updated_at: row.updated_at || null,
  };
}

function runtimeSnapshot(env: Env): Record<string, unknown> | null {
  try {
    const fp = buildLiveMartyRuntimeFingerprint(env, { deepDive: false });
    return {
      fingerprint_version: fp.fingerprint_version,
      runtime_kind: fp.runtime_kind,
      production_runtime_hash: fp.production_runtime_hash,
      generated_at: fp.generated_at,
      deploy_sha: fp.deploy_sha || null,
      components: fp.components,
    };
  } catch {
    return null;
  }
}

async function safeKvGet<T = unknown>(
  env: Env,
  key: string,
  type?: 'json'
): Promise<T | null> {
  try {
    if (!env.KV) return null;
    return type ? await env.KV.get<T>(key, type) : await env.KV.get(key) as T | null;
  } catch {
    return null;
  }
}

export function inferPlatformTelemetryTopic(input: PlatformTelemetryInput = {}): Exclude<PlatformTelemetryTopic, 'auto'> {
  if (input.topic && input.topic !== 'auto') return input.topic;

  const text = [
    input.query,
    input.subject,
    input.email,
    input.user_id,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b(backfill|backfilled|ingest|ingested|ingestion|sync(?:ed|ing)?|outlook|mailbox|email count|emails has|connector|delta token)\b/.test(text)) {
    return 'user_ingestion';
  }
  if (/\b(data completeness|document coverage|email coverage|meeting coverage|embedding coverage|embedding|searchable|searchability|vector|indexed|indexing|embedded\s+(?:documents?|emails?|meetings?|conversations?)|(?:documents?|emails?|meetings?|conversations?)\s+embedded)\b/.test(text)) {
    return 'data_coverage';
  }
  if (/\b(work queue|queue|dead[- ]?letter|retry|stuck|failed item|backlog)\b/.test(text)) {
    return 'work_queue';
  }
  if (/\b(sync job|task run|cron|pipeline|system status|health|workflow|status|scheduler|schedule|cadence|frequency|how often|consistent|consistently|company enrichment|contact enrichment|enrichment workflow|news enrichment|news feed|news pipeline|gemini(?: api)?|gemini calls?|calling gemini|api call telemetry|rate limit|upstream budget)\b/.test(text)) {
    return 'pipeline_health';
  }
  return 'platform_overview';
}

export function scoreTelemetryUserCandidate(
  query: string,
  user: Pick<TelemetryUserRow, 'id' | 'email' | 'full_name'>
): UserCandidate {
  const text = query.toLowerCase();
  const email = user.email.toLowerCase();
  const fullName = String(user.full_name || '').trim().toLowerCase();
  const localPart = email.split('@')[0] || '';
  const firstName = fullName.split(/\s+/).find(Boolean) || '';
  const reasons: string[] = [];
  let score = 0;

  if (text.includes(user.id.toLowerCase())) {
    score = Math.max(score, 100);
    reasons.push('user_id_match');
  }
  if (text.includes(email)) {
    score = Math.max(score, 95);
    reasons.push('email_match');
  }
  if (fullName && text.includes(fullName)) {
    score = Math.max(score, 90);
    reasons.push('full_name_match');
  }
  if (firstName && new RegExp(`\\b${escapeRegExp(firstName)}\\b`, 'i').test(query)) {
    score = Math.max(score, 75);
    reasons.push('first_name_match');
  }
  if (localPart && new RegExp(`\\b${escapeRegExp(localPart)}\\b`, 'i').test(query)) {
    score = Math.max(score, 70);
    reasons.push('email_local_match');
  }

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: (user as any).role || 'member',
    score,
    reasons,
  };
}

async function loadTelemetryUsers(ctx: AuthContext, env: Env): Promise<TelemetryUserRow[]> {
  const rows = await env.D1.prepare(
    `SELECT id, email, full_name, role, is_active, created_at, updated_at,
            outlook_token IS NOT NULL AS has_outlook_token,
            outlook_delta_token IS NOT NULL AS has_inbox_delta_token
       FROM users
      WHERE org_id = ?
        AND deleted_at IS NULL
      ORDER BY is_active DESC, full_name ASC`
  ).bind(ctx.orgId).all<TelemetryUserRow>();
  return rows.results || [];
}

function resolveTelemetryUser(
  ctx: AuthContext,
  input: PlatformTelemetryInput,
  users: TelemetryUserRow[]
): { user: TelemetryUserRow | null; candidates: UserCandidate[]; ambiguous: boolean; query: string } {
  const explicitEmail = normalizeEmail(input.email || input.subject || input.query);
  if (input.user_id) {
    const user = users.find(u => u.id === input.user_id) || null;
    return { user, candidates: [], ambiguous: false, query: input.user_id };
  }
  if (explicitEmail) {
    const user = users.find(u => u.email.toLowerCase() === explicitEmail) || null;
    return { user, candidates: [], ambiguous: false, query: explicitEmail };
  }

  const query = [
    input.subject,
    input.query,
  ].filter(Boolean).join(' ').trim();

  if (!query || /\b(my|me|mine|myself)\b/i.test(query)) {
    const self = users.find(u => u.id === ctx.userId) || null;
    return { user: self, candidates: [], ambiguous: false, query };
  }

  const scored = users
    .map(user => scoreTelemetryUserCandidate(query, user))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));

  const top = scored[0];
  if (!top) return { user: null, candidates: [], ambiguous: false, query };

  const tied = scored.filter(candidate => candidate.score === top.score);
  if (tied.length > 1 && top.score < 90) {
    return { user: null, candidates: tied.slice(0, 5), ambiguous: true, query };
  }

  return {
    user: users.find(u => u.id === top.id) || null,
    candidates: scored.slice(0, 5),
    ambiguous: false,
    query,
  };
}

function summarizeSyncJob(row: any): Record<string, unknown> {
  return {
    id: row.id,
    workflow_type: row.workflow_type,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    items_processed: asNumber(row.items_processed),
    items_failed: asNumber(row.items_failed),
    error_message: row.error_message || null,
    metadata: safeJson(row.metadata),
  };
}

function summarizeTaskRun(row: any): Record<string, unknown> {
  return {
    id: row.id,
    task_name: row.task_name,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms == null ? null : asNumber(row.duration_ms),
    items_processed: asNumber(row.items_processed),
    items_failed: asNumber(row.items_failed),
    items_skipped: asNumber(row.items_skipped),
    last_error: row.last_error || null,
    metadata: safeJson(row.metadata),
  };
}

async function getQueueSummary(ctx: AuthContext, env: Env, opts: { payloadNeedles?: string[]; limit?: number } = {}): Promise<any> {
  const payloadNeedles = (opts.payloadNeedles || []).filter(Boolean);
  const binds: unknown[] = [ctx.orgId];
  const where = ['org_id = ?'];
  if (payloadNeedles.length > 0) {
    where.push(`(${payloadNeedles.map(() => 'payload LIKE ?').join(' OR ')})`);
    for (const needle of payloadNeedles) binds.push(`%${needle}%`);
  }

  const rows = await env.D1.prepare(
    `SELECT domain, status, COUNT(*) AS count,
            MIN(created_at) AS oldest_created_at,
            MAX(created_at) AS newest_created_at,
            SUM(attempt) AS attempts
       FROM work_queue
      WHERE ${where.join(' AND ')}
      GROUP BY domain, status
      ORDER BY domain ASC, status ASC`
  ).bind(...binds).all<{
    domain: string; status: string; count: number;
    oldest_created_at: string | null; newest_created_at: string | null; attempts: number | null;
  }>();

  const deadLetters = await env.D1.prepare(
    `SELECT id, domain, status, attempt, max_attempts, last_error, created_at, completed_at, payload
       FROM work_queue
      WHERE ${where.join(' AND ')}
        AND status IN ('dead_letter', 'failed', 'in_progress')
      ORDER BY CASE status WHEN 'dead_letter' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
               created_at ASC
      LIMIT ?`
  ).bind(...binds, clampLimit(opts.limit)).all<any>();

  return {
    summary: rows.results || [],
    attention_items: (deadLetters.results || []).map(row => ({
      id: row.id,
      domain: row.domain,
      status: row.status,
      attempt: asNumber(row.attempt),
      max_attempts: asNumber(row.max_attempts),
      last_error: row.last_error || null,
      created_at: row.created_at,
      completed_at: row.completed_at,
      payload: safeJson(row.payload),
    })),
  };
}

async function inspectUserIngestionTelemetry(
  ctx: AuthContext,
  input: PlatformTelemetryInput,
  env: Env
): Promise<any> {
  const users = await loadTelemetryUsers(ctx, env);
  const resolved = resolveTelemetryUser(ctx, input, users);

  if (!resolved.user) {
    return {
      ok: false,
      topic: 'user_ingestion',
      error: resolved.ambiguous ? 'AMBIGUOUS_USER' : 'USER_NOT_RESOLVED',
      query: resolved.query || input.query || input.subject || null,
      candidates: resolved.candidates,
      message: resolved.ambiguous
        ? 'Multiple platform users matched. Ask with the email address or full name.'
        : 'No platform user matched that name/email in this org.',
    };
  }

  const canInspect = hasOrgWidePrivateDataAccess(ctx.userRole) || resolved.user.id === ctx.userId;
  if (!canInspect) {
    return {
      ok: false,
      topic: 'user_ingestion',
      error: 'FORBIDDEN',
      message: 'Platform ingestion telemetry for another user is owner/super-admin only.',
    };
  }

  const limit = clampLimit(input.limit);
  const user = resolved.user;
  const email = user.email.toLowerCase();
  const emailLike = `%${email}%`;
  const mailboxLike = `%${user.id}%`;
  const addressCase = `(LOWER(c.from_email) = ? OR LOWER(c.to_emails) LIKE ? OR LOWER(c.cc_emails) LIKE ?)`;
  const matchedCte = `
    WITH matched AS (
      SELECT c.*,
             CASE WHEN c.participant_user_ids LIKE ? THEN 1 ELSE 0 END AS mailbox_match,
             CASE WHEN ${addressCase} THEN 1 ELSE 0 END AS address_match
        FROM conversations c
       WHERE c.org_id = ?
         AND c.source = 'outlook'
    )`;
  const matchedBinds: unknown[] = [mailboxLike, email, emailLike, emailLike, ctx.orgId];

  const [
    conversationStats,
    recentConversations,
    latestProgressiveParent,
    userRelatedSyncRuns,
    recentOrgIngestionRuns,
    userRelatedTaskRuns,
    backfillProgress,
    tokenFailureState,
    syncConfig,
    sentDeltaToken,
  ] = await Promise.all([
    env.D1.prepare(
      `${matchedCte}
       SELECT COUNT(*) AS total_matched,
              SUM(mailbox_match) AS mailbox_ingested,
              SUM(address_match) AS address_involved,
              COUNT(DISTINCT COALESCE(external_thread_id, id)) AS thread_count,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM vector_entity_index v
                     WHERE v.entity_id = matched.id
                       AND v.source_table = 'conversations'
                       AND v.org_id = matched.org_id
                  ) THEN 1 ELSE 0 END) AS embedded_count,
              SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_count,
              SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count,
              SUM(CASE WHEN direction = 'internal' THEN 1 ELSE 0 END) AS internal_count,
              MIN(sent_at) AS first_sent_at,
              MAX(sent_at) AS last_sent_at,
              MIN(created_at) AS first_ingested_at,
              MAX(created_at) AS last_ingested_at
         FROM matched
        WHERE mailbox_match = 1 OR address_match = 1`
    ).bind(...matchedBinds).first<any>(),
    env.D1.prepare(
      `${matchedCte}
       SELECT id, subject, direction, sent_at, created_at, from_email,
              to_emails, cc_emails, mailbox_match, address_match
         FROM matched
        WHERE mailbox_match = 1 OR address_match = 1
        ORDER BY sent_at DESC
        LIMIT ?`
    ).bind(...matchedBinds, Math.min(limit, 10)).all<any>(),
    env.D1.prepare(
      `SELECT id, status, window_size_days, total_windows, created_at, updated_at, completed_at
         FROM progressive_backfill_jobs
        WHERE org_id = ? AND user_id = ?
        ORDER BY created_at DESC
        LIMIT 1`
    ).bind(ctx.orgId, user.id).first<any>(),
    env.D1.prepare(
      `SELECT id, workflow_type, status, started_at, completed_at,
              items_processed, items_failed, error_message, metadata
         FROM sync_jobs
        WHERE org_id = ?
          AND (metadata LIKE ? OR metadata LIKE ?)
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(ctx.orgId, `%${user.id}%`, `%${email}%`, limit).all<any>(),
    env.D1.prepare(
      `SELECT id, workflow_type, status, started_at, completed_at,
              items_processed, items_failed, error_message, metadata
         FROM sync_jobs
        WHERE org_id = ?
          AND workflow_type IN ('ingestion', 'progressive-backfill-window', 'attachment_backfill')
        ORDER BY created_at DESC
        LIMIT 8`
    ).bind(ctx.orgId).all<any>(),
    env.D1.prepare(
      `SELECT id, task_name, status, started_at, ended_at, duration_ms,
              items_processed, items_failed, items_skipped, last_error, metadata
         FROM task_runs
        WHERE org_id = ?
          AND (metadata LIKE ? OR metadata LIKE ?)
        ORDER BY started_at DESC
        LIMIT ?`
    ).bind(ctx.orgId, `%${user.id}%`, `%${email}%`, limit).all<any>(),
    safeKvGet(env, `backfill_progress:${user.id}`, 'json'),
    safeKvGet(env, `token_failed:${user.id}:outlook`, 'json'),
    safeKvGet<{ sync_history_days?: number }>(env, `sync_config:${user.id}`, 'json'),
    safeKvGet<string>(env, `sent_delta:${user.id}`),
  ]);

  let progressiveWindowSummary: any = null;
  let failedWindows: any[] = [];
  if (latestProgressiveParent?.id) {
    const [summaryRow, failedRows] = await Promise.all([
      env.D1.prepare(
        `SELECT COUNT(*) AS total_windows,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_windows,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_windows,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_windows,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_windows,
                SUM(emails_fetched) AS emails_fetched,
                SUM(conversations_added) AS conversations_added,
                SUM(embedded_count) AS embedded_count,
                MIN(start_date) AS earliest_window_start,
                MAX(end_date) AS latest_window_end,
                MAX(completed_at) AS latest_window_completed_at
           FROM progressive_backfill_windows
          WHERE parent_id = ?`
      ).bind(latestProgressiveParent.id).first<any>(),
      env.D1.prepare(
        `SELECT window_index, start_date, end_date, status, last_error, completed_at
           FROM progressive_backfill_windows
          WHERE parent_id = ?
            AND status = 'failed'
          ORDER BY completed_at DESC, window_index ASC
          LIMIT 5`
      ).bind(latestProgressiveParent.id).all<any>(),
    ]);
    progressiveWindowSummary = summaryRow;
    failedWindows = failedRows.results || [];
  }

  const payloadNeedles = [user.id, email];
  const userQueue = await getQueueSummary(ctx, env, { payloadNeedles, limit: Math.min(limit, 10) });
  const stats = conversationStats || {};
  const totalMatched = asNumber(stats.total_matched);
  const embedded = asNumber(stats.embedded_count);
  const userRelatedRuns = (userRelatedSyncRuns.results || []).map(summarizeSyncJob);
  const backfillEvidence = Boolean(
    latestProgressiveParent
    || backfillProgress
    || userRelatedRuns.some((run: any) =>
      String(run.workflow_type || '').includes('backfill')
      || String((run.metadata as any)?.trigger || '').includes('backfill')
      || (run.metadata as any)?.trigger === 'manual_date_range'
    )
  );

  return {
    ok: true,
    topic: 'user_ingestion',
    access_scope: hasOrgWidePrivateDataAccess(ctx.userRole) ? 'org_wide_operator' : 'self',
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      is_active: Boolean(user.is_active),
      outlook_connected: Boolean(user.has_outlook_token),
      inbox_delta_token_present: Boolean(user.has_inbox_delta_token),
      sent_delta_token_present: Boolean(sentDeltaToken),
      sync_history_days: syncConfig?.sync_history_days ?? 30,
      token_failure_state: tokenFailureState || { healthy: true },
    },
    email_ingestion: {
      metric_definition: 'Counts are Outlook conversation rows stored in conversations. mailbox_ingested_conversations uses the participant_user_ids mailbox stamp from the ingestion pipeline; address_involved_conversations matches the user email in From/To/Cc. Duplicate Graph messages are deduped by external_message_id before/while persisting.',
      total_outlook_conversations_matched: totalMatched,
      mailbox_ingested_conversations: asNumber(stats.mailbox_ingested),
      address_involved_conversations: asNumber(stats.address_involved),
      thread_count: asNumber(stats.thread_count),
      embedded_conversations: embedded,
      embedding_percentage: pct(embedded, totalMatched),
      inbound_count: asNumber(stats.inbound_count),
      outbound_count: asNumber(stats.outbound_count),
      internal_count: asNumber(stats.internal_count),
      first_sent_at: stats.first_sent_at || null,
      last_sent_at: stats.last_sent_at || null,
      first_ingested_at: stats.first_ingested_at || null,
      last_ingested_at: stats.last_ingested_at || null,
    },
    backfill: {
      has_backfill_evidence: backfillEvidence,
      latest_progressive_job: latestProgressiveParent || null,
      latest_progressive_window_summary: progressiveWindowSummary,
      failed_windows: failedWindows,
      live_kv_progress: backfillProgress || null,
    },
    recent_activity: {
      recent_matched_conversations: (recentConversations.results || []).map(row => ({
        id: row.id,
        subject: row.subject,
        direction: row.direction,
        sent_at: row.sent_at,
        ingested_at: row.created_at,
        from_email: row.from_email,
        mailbox_match: Boolean(row.mailbox_match),
        address_match: Boolean(row.address_match),
      })),
      user_related_sync_runs: userRelatedRuns,
      recent_org_ingestion_runs: (recentOrgIngestionRuns.results || []).map(summarizeSyncJob),
      user_related_task_runs: (userRelatedTaskRuns.results || []).map(summarizeTaskRun),
      user_related_work_queue: userQueue,
    },
    answer_guidance: [
      'Use mailbox_ingested_conversations for “how many emails has this user ingested” unless the user specifically asks for address-involved messages.',
      'Use has_backfill_evidence plus latest_progressive_job/window_summary to answer whether a backfill ran.',
      'If total_outlook_conversations_matched differs from mailbox_ingested_conversations, explain the distinction instead of blending the metrics.',
    ],
  };
}

async function inspectDataCoverage(ctx: AuthContext, env: Env): Promise<any> {
  if (!hasOrgWidePrivateDataAccess(ctx.userRole)) {
    return { ok: false, topic: 'data_coverage', error: 'FORBIDDEN', message: 'Platform-wide coverage telemetry is owner/super-admin only.' };
  }

  const [
    conversationsTotal,
    conversationsEmbedded,
    documentsTotal,
    documentsEmbedded,
    eventsTotal,
    eventsEmbedded,
    connectedUsers,
  ] = await Promise.all([
    env.D1.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE org_id = ?`).bind(ctx.orgId).first<{ n: number }>(),
    env.D1.prepare(`SELECT COUNT(DISTINCT entity_id) AS n FROM vector_entity_index WHERE org_id = ? AND source_table = 'conversations'`).bind(ctx.orgId).first<{ n: number }>(),
    env.D1.prepare(
      `SELECT COUNT(*) AS n
         FROM documents
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND processing_status = 'completed'
          AND r2_key IS NOT NULL`
    ).bind(ctx.orgId).first<{ n: number }>(),
    env.D1.prepare(
      `SELECT COUNT(DISTINCT d.id) AS n
         FROM documents d
         JOIN vector_entity_index v
           ON v.entity_id = d.id
          AND v.source_table = 'documents'
          AND v.org_id = d.org_id
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.processing_status = 'completed'
          AND d.r2_key IS NOT NULL`
    ).bind(ctx.orgId).first<{ n: number }>(),
    env.D1.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND deleted_at IS NULL`).bind(ctx.orgId).first<{ n: number }>(),
    env.D1.prepare(`SELECT COUNT(DISTINCT entity_id) AS n FROM vector_entity_index WHERE org_id = ? AND source_table = 'events'`).bind(ctx.orgId).first<{ n: number }>(),
    env.D1.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN outlook_token IS NOT NULL THEN 1 END) AS outlook_connected
         FROM users
        WHERE org_id = ?
          AND deleted_at IS NULL`
    ).bind(ctx.orgId).first<{ total: number; outlook_connected: number }>(),
  ]);

  const convTotal = asNumber(conversationsTotal?.n);
  const convEmbedded = asNumber(conversationsEmbedded?.n);
  const docTotal = asNumber(documentsTotal?.n);
  const docEmbedded = asNumber(documentsEmbedded?.n);
  const eventTotal = asNumber(eventsTotal?.n);
  const eventEmbedded = asNumber(eventsEmbedded?.n);

  return {
    ok: true,
    topic: 'data_coverage',
    metric_definition: 'Embedding coverage counts distinct source entity IDs present in vector_entity_index. Documents count completed, stored documents with an R2 object.',
    coverage: {
      emails: { total: convTotal, embedded: convEmbedded, percentage: pct(convEmbedded, convTotal) },
      documents: { total: docTotal, embedded: docEmbedded, percentage: pct(docEmbedded, docTotal) },
      meetings: { total: eventTotal, embedded: eventEmbedded, percentage: pct(eventEmbedded, eventTotal) },
      users: {
        total: asNumber(connectedUsers?.total),
        outlook_connected: asNumber(connectedUsers?.outlook_connected),
      },
    },
  };
}

async function inspectPipelineHealth(ctx: AuthContext, input: PlatformTelemetryInput, env: Env): Promise<any> {
  if (!hasOrgWidePrivateDataAccess(ctx.userRole)) {
    return { ok: false, topic: 'pipeline_health', error: 'FORBIDDEN', message: 'Platform-wide pipeline telemetry is owner/super-admin only.' };
  }

  const limit = clampLimit(input.limit);
  const daysBack = Math.min(Math.max(Math.floor(Number(input.days_back || 7)), 1), 30);
  const cutoff = isoDaysAgo(daysBack);
  const cutoff24h = isoDaysAgo(1);
  const cutoff30d = isoDaysAgo(30);

  const [
    settings,
    syncRuns,
    taskRuns,
    queue,
    recentEnrichmentRuns,
    recentIngestionRuns,
    companyEnrichmentStats,
    contactEnrichmentStats,
    newsCoverageStats,
    recentNewsArticles,
    contactEnrichmentQueue,
    geminiBudgets,
    geminiEnrichmentCooldown,
    geminiNewsCooldown,
    geminiLinkedinCooldown,
  ] = await Promise.all([
    getOrgSettings(ctx.orgId, env),
    env.D1.prepare(
      `SELECT id, workflow_type, status, started_at, completed_at,
              items_processed, items_failed, error_message, metadata
         FROM sync_jobs
        WHERE org_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(ctx.orgId, limit).all<any>(),
    env.D1.prepare(
      `SELECT id, task_name, status, started_at, ended_at, duration_ms,
              items_processed, items_failed, items_skipped, last_error, metadata
         FROM task_runs
       WHERE org_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    ).bind(ctx.orgId, limit).all<any>(),
    getQueueSummary(ctx, env, { limit }),
    env.D1.prepare(
      `SELECT id, workflow_type, status, started_at, completed_at,
              items_processed, items_failed, error_message, metadata
         FROM sync_jobs
        WHERE org_id = ?
          AND workflow_type = 'enrichment'
          AND COALESCE(started_at, created_at) >= ?
        ORDER BY COALESCE(started_at, created_at) DESC
        LIMIT ?`
    ).bind(ctx.orgId, cutoff, Math.min(limit, 25)).all<any>(),
    env.D1.prepare(
      `SELECT id, workflow_type, status, started_at, completed_at,
              items_processed, items_failed, error_message, metadata
         FROM sync_jobs
        WHERE org_id = ?
          AND workflow_type = 'ingestion'
          AND COALESCE(started_at, created_at) >= ?
        ORDER BY COALESCE(started_at, created_at) DESC
        LIMIT ?`
    ).bind(ctx.orgId, cutoff, Math.min(limit, 25)).all<any>(),
    env.D1.prepare(
      `SELECT COUNT(*) AS active_total,
              SUM(CASE WHEN enrichment_last_run IS NOT NULL THEN 1 ELSE 0 END) AS enriched_total,
              SUM(CASE WHEN enrichment_last_run IS NULL THEN 1 ELSE 0 END) AS never_enriched,
              SUM(CASE WHEN enrichment_last_run >= ? THEN 1 ELSE 0 END) AS enriched_last_24h,
              SUM(CASE WHEN enrichment_last_run >= ? THEN 1 ELSE 0 END) AS enriched_last_window,
              SUM(CASE WHEN enrichment_last_run IS NULL OR enrichment_last_run < ? THEN 1 ELSE 0 END) AS due_or_stale,
              MAX(enrichment_last_run) AS latest_enrichment_at
         FROM companies
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND merged_into IS NULL
          AND (investment_status IS NULL OR investment_status NOT IN ('passed','exited'))`
    ).bind(cutoff24h, cutoff, cutoff30d, ctx.orgId).first<any>(),
    env.D1.prepare(
      `SELECT COUNT(*) AS active_total,
              SUM(CASE WHEN enrichment_last_run IS NOT NULL THEN 1 ELSE 0 END) AS enriched_total,
              SUM(CASE WHEN enrichment_last_run IS NULL THEN 1 ELSE 0 END) AS never_enriched,
              SUM(CASE WHEN enrichment_last_run >= ? THEN 1 ELSE 0 END) AS enriched_last_24h,
              SUM(CASE WHEN enrichment_last_run >= ? THEN 1 ELSE 0 END) AS enriched_last_window,
              SUM(CASE WHEN enrichment_last_run IS NULL OR enrichment_last_run < ? THEN 1 ELSE 0 END) AS due_or_stale,
              MAX(enrichment_last_run) AS latest_enrichment_at
         FROM contacts
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND merged_into IS NULL`
    ).bind(cutoff24h, cutoff, cutoff30d, ctx.orgId).first<any>(),
    env.D1.prepare(
      `SELECT COUNT(*) AS active_companies,
              SUM(CASE WHEN last_news_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS attempted_companies,
              SUM(CASE WHEN last_news_fetched_at IS NULL THEN 1 ELSE 0 END) AS never_attempted,
              SUM(CASE WHEN last_news_fetched_at >= ? THEN 1 ELSE 0 END) AS attempted_last_24h,
              SUM(CASE WHEN last_news_fetched_at >= ? THEN 1 ELSE 0 END) AS attempted_last_window,
              SUM(CASE WHEN last_news_fetched_at IS NULL OR last_news_fetched_at < ? THEN 1 ELSE 0 END) AS due_or_stale,
              MAX(last_news_fetched_at) AS latest_news_attempt_at,
              (SELECT COUNT(*) FROM news_articles WHERE org_id = ?) AS total_articles,
              (SELECT COUNT(*) FROM news_articles WHERE org_id = ? AND created_at >= ?) AS articles_created_last_window,
              (SELECT MAX(created_at) FROM news_articles WHERE org_id = ?) AS latest_article_ingested_at
         FROM companies
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND merged_into IS NULL
          AND (investment_status IS NULL OR investment_status NOT IN ('passed','exited'))`
    ).bind(cutoff24h, cutoff, cutoff24h, ctx.orgId, ctx.orgId, cutoff, ctx.orgId, ctx.orgId).first<any>(),
    env.D1.prepare(
      `SELECT id, company_id, title, source_name, published_at, relevance_tag, relevance_score, created_at
         FROM news_articles
        WHERE org_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(ctx.orgId, Math.min(limit, 8)).all<any>(),
    env.D1.prepare(
      `SELECT domain, status, COUNT(*) AS count,
              MIN(created_at) AS oldest_created_at,
              MAX(created_at) AS newest_created_at,
              SUM(attempt) AS attempts
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'contact_enrichment'
        GROUP BY domain, status
        ORDER BY status ASC`
    ).bind(ctx.orgId).all<any>(),
    env.D1.prepare(
      `SELECT org_id, user_id, upstream, bucket_window, bucket_start, used, cap,
              last_429_at, consecutive_429s, circuit_open_until,
              cap_lowered_at, cap_lowered_count, updated_at
         FROM upstream_budget_ledger
        WHERE org_id = ?
          AND upstream IN ('gemini', 'gemini_web_search')
        ORDER BY upstream ASC, bucket_window ASC, user_id ASC`
    ).bind(ctx.orgId).all<any>(),
    safeKvGet(env, `rate_limit:gemini_enrichment:${ctx.orgId}`, 'json'),
    safeKvGet(env, `rate_limit:gemini_news:${ctx.orgId}`, 'json'),
    safeKvGet(env, `rate_limit:gemini_linkedin:${ctx.orgId}`, 'json'),
  ]);

  const enrichmentRows = recentEnrichmentRuns.results || [];
  const ingestionRows = recentIngestionRuns.results || [];
  const newsFetchRuns = ingestionRows.map(row => {
    const metadata = objectJson(row.metadata);
    return {
      ...summarizeSyncJob(row),
      news_companies_queried: asNumber(metadata.news_companies_queried),
      news_companies_succeeded: asNumber(metadata.news_companies_succeeded),
      news_companies_failed: asNumber(metadata.news_companies_failed),
      news_articles_fetched: asNumber(metadata.news_articles_fetched),
      news_step_duration_ms: metadata.news_step_duration_ms == null ? null : asNumber(metadata.news_step_duration_ms),
      fetched_news: asNumber(metadata.fetched_news),
      current_step: metadata.current_step || null,
      last_completed_step: metadata.last_completed_step || null,
      failed_step: metadata.failed_step || null,
    };
  });
  const newsFetchTotals = newsFetchRuns.reduce((acc, run: any) => {
    acc.news_companies_queried += asNumber(run.news_companies_queried);
    acc.news_companies_succeeded += asNumber(run.news_companies_succeeded);
    acc.news_companies_failed += asNumber(run.news_companies_failed);
    acc.news_articles_fetched += asNumber(run.news_articles_fetched);
    return acc;
  }, { news_companies_queried: 0, news_companies_succeeded: 0, news_companies_failed: 0, news_articles_fetched: 0 });

  const companyTotal = asNumber(companyEnrichmentStats?.active_total);
  const contactTotal = asNumber(contactEnrichmentStats?.active_total);
  const newsCompanyTotal = asNumber(newsCoverageStats?.active_companies);

  return {
    ok: true,
    topic: 'pipeline_health',
    runtime: runtimeSnapshot(env),
    schedule_contract: {
      deployed_crons: ['0 * * * *', '* * * * *'],
      ingestion_workflow: 'Scheduled hourly at minute :00 UTC by the pipelines Worker. The fetch-news step runs inside this workflow.',
      enrichment_workflow: 'Scheduled hourly at minute :04 UTC by the minute-tick handler. Company enrichment runs directly inside that workflow; contact enrichment is enqueued to work_queue.',
      contact_enrichment_queue: 'The contact_enrichment work_queue handler runs from the minute-tick driver with batchSize=1 and maxConcurrent=1.',
      daily_maintenance: 'Runs at 02:10 UTC through the minute-tick handler.',
    },
    settings: {
      news_feed_enabled: settings.news_feed_enabled,
      linkedin_enrichment_enabled: settings.linkedin_enrichment_enabled,
      max_enrichments_per_cycle: settings.max_enrichments_per_cycle,
      sync_interval_minutes: settings.sync_interval_minutes,
    },
    operational_cadence: {
      lookback_days: daysBack,
      enrichment_workflow: {
        expected_cadence: 'hourly at minute :04 UTC',
        observed: summarizeCadence(enrichmentRows),
        recent_runs: enrichmentRows.map(summarizeSyncJob),
      },
      company_enrichment: {
        metric_definition: 'Company enrichment_last_run is stamped when triggerCompanyEnrichment completes for a company. Due/stale means never enriched or older than 30 days among active non-passed/non-exited companies.',
        active_companies: companyTotal,
        enriched_total: asNumber(companyEnrichmentStats?.enriched_total),
        coverage_percentage: pct(asNumber(companyEnrichmentStats?.enriched_total), companyTotal),
        enriched_last_24h: asNumber(companyEnrichmentStats?.enriched_last_24h),
        enriched_last_window: asNumber(companyEnrichmentStats?.enriched_last_window),
        never_enriched: asNumber(companyEnrichmentStats?.never_enriched),
        due_or_stale: asNumber(companyEnrichmentStats?.due_or_stale),
        latest_enrichment_at: companyEnrichmentStats?.latest_enrichment_at || null,
      },
      contact_enrichment: {
        active_contacts: contactTotal,
        enriched_total: asNumber(contactEnrichmentStats?.enriched_total),
        coverage_percentage: pct(asNumber(contactEnrichmentStats?.enriched_total), contactTotal),
        enriched_last_24h: asNumber(contactEnrichmentStats?.enriched_last_24h),
        enriched_last_window: asNumber(contactEnrichmentStats?.enriched_last_window),
        never_enriched: asNumber(contactEnrichmentStats?.never_enriched),
        due_or_stale: asNumber(contactEnrichmentStats?.due_or_stale),
        latest_enrichment_at: contactEnrichmentStats?.latest_enrichment_at || null,
        queue_by_status: contactEnrichmentQueue.results || [],
      },
      news_fetch: {
        expected_cadence: 'hourly inside the ingestion workflow fetch-news step; each company is skipped until roughly 24h stale after last_news_fetched_at.',
        observed_ingestion_runs: summarizeCadence(ingestionRows),
        run_totals_from_metadata: newsFetchTotals,
        recent_runs: newsFetchRuns,
        active_companies: newsCompanyTotal,
        attempted_companies: asNumber(newsCoverageStats?.attempted_companies),
        attempted_coverage_percentage: pct(asNumber(newsCoverageStats?.attempted_companies), newsCompanyTotal),
        attempted_last_24h: asNumber(newsCoverageStats?.attempted_last_24h),
        attempted_last_window: asNumber(newsCoverageStats?.attempted_last_window),
        never_attempted: asNumber(newsCoverageStats?.never_attempted),
        due_or_stale: asNumber(newsCoverageStats?.due_or_stale),
        latest_news_attempt_at: newsCoverageStats?.latest_news_attempt_at || null,
        total_articles: asNumber(newsCoverageStats?.total_articles),
        articles_created_last_window: asNumber(newsCoverageStats?.articles_created_last_window),
        latest_article_ingested_at: newsCoverageStats?.latest_article_ingested_at || null,
        recent_articles: recentNewsArticles.results || [],
      },
      gemini: {
        metric_definition: 'Gemini usage is durably visible through upstream_budget_ledger current budget windows plus source-specific KV cooldowns. Exact historical per-call logs are not stored; use enrichment/news run metadata as proxy workload evidence.',
        current_budget_windows: (geminiBudgets.results || []).map(summarizeBudgetRow),
        source_cooldowns: {
          gemini_enrichment: geminiEnrichmentCooldown || null,
          gemini_news: geminiNewsCooldown || null,
          gemini_linkedin: geminiLinkedinCooldown || null,
        },
      },
    },
    recent_sync_jobs: (syncRuns.results || []).map(summarizeSyncJob),
    recent_task_runs: (taskRuns.results || []).map(summarizeTaskRun),
    work_queue: queue,
    answer_guidance: [
      'For “how often is company enrichment happening,” lead with schedule_contract.enrichment_workflow and operational_cadence.enrichment_workflow.observed, then use company_enrichment latest/counts to say whether it is actually producing updates.',
      'For “the news,” use schedule_contract.ingestion_workflow plus operational_cadence.news_fetch run metadata and last_news_fetched_at coverage.',
      'For “how consistently are we calling Gemini,” use operational_cadence.gemini current budget/circuit/cooldown state and be explicit that exact historical per-call Gemini logs are not retained beyond budget windows.',
      'Do not answer these questions from Recall/email snippets when inspect_platform_telemetry returned operational_cadence.',
    ],
  };
}

export async function inspectPlatformTelemetryTool(
  ctx: AuthContext,
  input: PlatformTelemetryInput = {},
  env: Env
): Promise<any> {
  const topic = inferPlatformTelemetryTopic(input);

  if (topic === 'user_ingestion') {
    return inspectUserIngestionTelemetry(ctx, input, env);
  }
  if (topic === 'data_coverage') {
    return inspectDataCoverage(ctx, env);
  }
  if (topic === 'work_queue') {
    if (!hasOrgWidePrivateDataAccess(ctx.userRole)) {
      return { ok: false, topic: 'work_queue', error: 'FORBIDDEN', message: 'Platform-wide work queue telemetry is owner/super-admin only.' };
    }
    return { ok: true, topic: 'work_queue', work_queue: await getQueueSummary(ctx, env, { limit: input.limit }) };
  }
  if (topic === 'pipeline_health') {
    return inspectPipelineHealth(ctx, input, env);
  }

  const [coverage, health] = await Promise.all([
    inspectDataCoverage(ctx, env),
    inspectPipelineHealth(ctx, input, env),
  ]);

  return {
    ok: coverage.ok !== false && health.ok !== false,
    topic: 'platform_overview',
    runtime: runtimeSnapshot(env),
    coverage,
    pipeline_health: health,
  };
}

export const __platformTelemetryTestHooks = {
  inferPlatformTelemetryTopic,
  scoreTelemetryUserCandidate,
};

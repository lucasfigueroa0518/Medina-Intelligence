// One-shot recovery + diagnostic endpoints around the Firefly→Outlook
// reconciliation path. Companion to the matcher fix in src/lib/reconciliation.ts.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { reconcileFireflyToOutlook } from '../lib/reconciliation';
import { getGraphMailboxAuthForUser, graphMailboxUrl } from '../lib/graph-auth';
import {
  createFireflyProgressiveBackfillRange,
  MAX_BACKFILL_DAYS,
} from '../lib/firefly-progressive-backfill';
import {
  getFireflyKeyStatus,
  listFireflyKeyStatuses,
} from '../lib/firefly-credentials';
import { sixCalendarMonthsRange } from '../lib/firefly-transcript-rebuild';

interface ReconcileBody {
  dry_run?: boolean;
  user_id?: string;   // optional filter
  limit?: number;
}

/**
 * POST /api/admin/reconcile-orphaned-fireflies
 *
 * Runs the matcher against every Firefly event in `pending_reconciliation`
 * for this org. Owner-only.
 *
 * Body: { dry_run?: boolean, user_id?: string, limit?: number }
 *   - dry_run: count candidates without mutating anything
 *   - user_id: scope to a single user's events (event_attendees join)
 *   - limit: cap rows scanned (default 500, max 2000)
 */
export async function handleReconcileOrphanedFireflies(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can run reconciliation backfill.');
  }

  const body = (await parseJsonBody<ReconcileBody>(request)) || {};
  const dryRun = body.dry_run === true;
  const limit = Math.min(Math.max(body.limit ?? 500, 1), 2000);

  // Pull pending Firefly events. Optionally scope to a user via the
  // event_attendees join — the user is an attendee on their own meetings,
  // so this filters to the user's transcripts.
  const sql = body.user_id
    ? `SELECT e.id, e.firefly_event_id, e.start_time, e.transcript_r2_key
         FROM events e
         JOIN event_attendees ea ON ea.event_id = e.id
        WHERE e.org_id = ? AND e.source = 'firefly'
          AND e.reconciliation_status = 'pending_reconciliation'
          AND e.deleted_at IS NULL
          AND ea.user_id = ?
        GROUP BY e.id
        ORDER BY e.start_time DESC
        LIMIT ?`
    : `SELECT e.id, e.firefly_event_id, e.start_time, e.transcript_r2_key
         FROM events e
        WHERE e.org_id = ? AND e.source = 'firefly'
          AND e.reconciliation_status = 'pending_reconciliation'
          AND e.deleted_at IS NULL
        ORDER BY e.start_time DESC
        LIMIT ?`;

  const rows = body.user_id
    ? await env.D1.prepare(sql).bind(ctx.orgId, body.user_id, limit)
        .all<{ id: string; firefly_event_id: string | null; start_time: string; transcript_r2_key: string | null }>()
    : await env.D1.prepare(sql).bind(ctx.orgId, limit)
        .all<{ id: string; firefly_event_id: string | null; start_time: string; transcript_r2_key: string | null }>();

  const candidates = rows.results;

  if (dryRun) {
    return jsonResponse({
      ok: true,
      dry_run: true,
      candidate_count: candidates.length,
      sample: candidates.slice(0, 5).map(r => ({
        id: r.id,
        start_time: r.start_time,
        has_transcript: !!r.transcript_r2_key,
        firefly_event_id: r.firefly_event_id,
      })),
    });
  }

  let reconciled = 0;
  let still_pending = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const row of candidates) {
    try {
      const matched = await reconcileFireflyToOutlook(
        {
          id: row.id,
          firefly_event_id: row.firefly_event_id,
          start_time: row.start_time,
          transcript_r2_key: row.transcript_r2_key,
        },
        ctx.orgId,
        env
      );
      if (matched) reconciled++;
      else still_pending++;
    } catch (e: any) {
      errors.push({ id: row.id, error: String(e?.message || e).slice(0, 200) });
    }
  }

  return jsonResponse({
    ok: true,
    scanned: candidates.length,
    reconciled,
    still_pending,
    errors_count: errors.length,
    errors_sample: errors.slice(0, 10),
  });
}

interface DiagnoseBody {
  user_id?: string;
  days_back?: number;
}

/**
 * POST /api/admin/diagnose-calendar-sync
 *
 * One-shot Graph mailbox-scoped `calendarView` (NOT delta) call against a target user's
 * stored token. Returns the count + first 5 events so we can see what Graph
 * actually returns. Owner-only.
 *
 * The hourly ingestion's calendar sync uses mailbox-scoped Graph calendar reads and has
 * been returning 0 events for every recent run with no delta token in KV
 * (which would imply a fresh-sync attempt). This endpoint bypasses delta to
 * see whether the underlying API call works at all.
 *
 * Body: { user_id?: string, days_back?: number (default 30, max 365) }
 */
export async function handleDiagnoseCalendarSync(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can diagnose calendar sync.');
  }

  const body = (await parseJsonBody<DiagnoseBody>(request)) || {};
  const userId = body.user_id || ctx.userId;
  const daysBack = Math.min(Math.max(body.days_back ?? 30, 1), 365);

  const userRow = await env.D1.prepare(
    `SELECT id, email FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(userId, ctx.orgId).first<{ id: string; email: string }>();
  if (!userRow) return errorResponse('USER_NOT_FOUND', 404, 'User not in org');

  let auth: { token: string; mailbox: string };
  try {
    auth = await getGraphMailboxAuthForUser(userId, ctx.orgId, env);
  } catch (e: any) {
    return jsonResponse({
      ok: false,
      stage: 'graph_auth',
      error: String(e?.message || e).slice(0, 200),
    });
  }

  const start = new Date(Date.now() - daysBack * 86400000).toISOString();
  const end = new Date(Date.now() + 90 * 86400000).toISOString();
  const url = graphMailboxUrl(auth.mailbox, `/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=10&$select=id,subject,start,end,attendees,organizer`);

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  const text = await resp.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }

  if (!resp.ok) {
    return jsonResponse({
      ok: false,
      stage: 'graph_api',
      http_status: resp.status,
      user_email: userRow.email,
      error_body: parsed || text.slice(0, 500),
      diagnostic: resp.status === 401 || resp.status === 403
        ? 'Graph calendar access was rejected. Check app-only certificate config, Exchange RBAC scope, and mailbox target.'
        : `Graph API returned ${resp.status} — investigate response body.`,
    });
  }

  const events: Array<{ id: string; subject: string; start: { dateTime: string }; attendees?: any[] }>
    = parsed?.value || [];

  return jsonResponse({
    ok: true,
    user_id: userId,
    user_email: userRow.email,
    range: { start, end },
    event_count: events.length,
    sample: events.slice(0, 5).map(e => ({
      id: e.id,
      subject: e.subject,
      start: e.start?.dateTime,
      attendees: e.attendees?.length ?? 0,
    })),
    diagnostic: events.length === 0
      ? 'Graph returned 200 with empty value[]. Either calendar is genuinely empty in this date range, or Calendars.Read consent is missing despite token validity.'
      : 'Calendar API works. The hourly delta-sync producing 0 events is then a delta-token / rate-limit edge case in fetchOutlookCalendarDelta. Force a fresh delta by deleting calendar_delta:<user_id> KV key.',
  });
}

/**
 * POST /api/admin/clear-calendar-delta
 *
 * Force-clear the calendar_delta KV key for a target user so the next
 * hourly cron does a full resync. Owner-only.
 *
 * Body: { user_id?: string } — defaults to caller
 */
export async function handleClearCalendarDelta(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can clear calendar delta.');
  }
  const body = (await parseJsonBody<{ user_id?: string }>(request)) || {};
  const userId = body.user_id || ctx.userId;
  await env.KV.delete(`calendar_delta:${userId}`);
  return jsonResponse({ ok: true, cleared: `calendar_delta:${userId}` });
}

function canOperateTranscriptRebuild(ctx: AuthContext): boolean {
  return ctx.userRole === 'owner' || ctx.userRole === 'super_admin';
}

function virtualOutlookPredicate(alias = 'e'): string {
  return `(
    lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%zoom%'
    OR lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%teams%'
    OR lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%google meet%'
    OR lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%meet.google%'
    OR lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%webex%'
    OR lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%online meeting%'
    OR lower(coalesce(${alias}.location,'') || ' ' || coalesce(${alias}.description,'') || ' ' || coalesce(${alias}.title,'')) LIKE '%join meeting%'
  )`;
}

function rangeFromCoverageUrl(url: URL): { startDate: string; endDate: string } {
  const explicitStart = url.searchParams.get('start_date');
  const explicitEnd = url.searchParams.get('end_date');
  if (explicitStart && explicitEnd && !isNaN(Date.parse(explicitStart)) && !isNaN(Date.parse(explicitEnd))) {
    return { startDate: new Date(explicitStart).toISOString(), endDate: new Date(explicitEnd).toISOString() };
  }
  const months = Math.min(Math.max(Number(url.searchParams.get('months') || 6), 1), 6);
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - months,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds()
  ));
  return { startDate: start.toISOString(), endDate: now.toISOString() };
}

/**
 * GET /api/admin/firefly-transcript-coverage?months=6&user_id=...
 *
 * Owner-only transcript rebuild telemetry. Separates source transcripts,
 * Outlook attachment, embedding, queue health, and missing credentials.
 */
export async function handleFireflyTranscriptCoverage(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canOperateTranscriptRebuild(ctx)) {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can inspect Fireflies transcript coverage.');
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const { startDate, endDate } = rangeFromCoverageUrl(url);
  const userFilter = userId
    ? `AND EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = ?)`
    : '';
  const userBinds = userId ? [userId] : [];

  const [users, virtualOutlook, transcriptOutlook, transcriptItems, links, embedding, queued, jobs, failures, keyStatuses] =
    await Promise.all([
      env.D1.prepare(
        `SELECT u.id, u.email, u.full_name, u.role,
                CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS has_firefly_key,
                c.created_at AS firefly_key_created_at,
                c.last_used_at AS firefly_key_last_used_at
           FROM users u
           LEFT JOIN user_firefly_credentials c ON c.user_id = u.id
          WHERE u.org_id = ? AND u.deleted_at IS NULL
          ORDER BY u.email`
      ).bind(ctx.orgId).all<Record<string, unknown>>(),
      env.D1.prepare(
        `SELECT COUNT(DISTINCT e.id) AS n
           FROM events e
          WHERE e.org_id = ? AND e.deleted_at IS NULL
            AND e.source = 'outlook'
            AND e.start_time >= ? AND e.start_time < ?
            AND ${virtualOutlookPredicate('e')}
            ${userFilter}`
      ).bind(ctx.orgId, startDate, endDate, ...userBinds).first<{ n: number }>(),
      env.D1.prepare(
        `SELECT COUNT(DISTINCT e.id) AS n
           FROM events e
          WHERE e.org_id = ? AND e.deleted_at IS NULL
            AND e.source = 'outlook'
            AND e.start_time >= ? AND e.start_time < ?
            AND e.transcript_r2_key IS NOT NULL AND e.transcript_r2_key != ''
            AND ${virtualOutlookPredicate('e')}
            ${userFilter}`
      ).bind(ctx.orgId, startDate, endDate, ...userBinds).first<{ n: number }>(),
      env.D1.prepare(
        `SELECT canonical_status, COUNT(*) AS n
           FROM firefly_transcript_items
          WHERE org_id = ?
            AND transcript_date >= ? AND transcript_date < ?
            ${userId ? 'AND user_id = ?' : ''}
          GROUP BY canonical_status`
      ).bind(ctx.orgId, startDate, endDate, ...userBinds).all<{ canonical_status: string; n: number }>(),
      env.D1.prepare(
        `SELECT COUNT(*) AS n
           FROM firefly_transcript_event_links l
           JOIN events e ON e.id = l.event_id
          WHERE l.org_id = ?
            AND e.start_time >= ? AND e.start_time < ?
            ${userId ? 'AND EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = ?)' : ''}`
      ).bind(ctx.orgId, startDate, endDate, ...userBinds).first<{ n: number }>(),
      env.D1.prepare(
        `SELECT COUNT(DISTINCT e.id) AS transcript_events,
                COUNT(DISTINCT vei.entity_id) AS embedded_events
           FROM events e
           LEFT JOIN vector_entity_index vei
             ON vei.org_id = e.org_id
            AND vei.source_table = 'events'
            AND vei.entity_id = e.id
          WHERE e.org_id = ? AND e.deleted_at IS NULL
            AND e.start_time >= ? AND e.start_time < ?
            AND e.transcript_r2_key IS NOT NULL AND e.transcript_r2_key != ''
            ${userFilter}`
      ).bind(ctx.orgId, startDate, endDate, ...userBinds).first<{ transcript_events: number; embedded_events: number }>(),
      env.D1.prepare(
        `SELECT domain, status, COUNT(*) AS n
           FROM work_queue
          WHERE org_id = ?
            AND domain IN ('firefly_window','embed_retry','prospect_detect')
            AND status IN ('pending','in_progress','dead_letter')
          GROUP BY domain, status
          ORDER BY domain, status`
      ).bind(ctx.orgId).all<Record<string, unknown>>(),
      env.D1.prepare(
        `SELECT id, user_id, status, start_date, end_date, source_transcripts,
                r2_staged, linked_events, standalone_transcripts,
                embedding_queued, prospect_queued, error_count, last_error,
                started_at, completed_at
           FROM firefly_transcript_runs
          WHERE org_id = ?
          ORDER BY started_at DESC
          LIMIT 20`
      ).bind(ctx.orgId).all<Record<string, unknown>>(),
      env.D1.prepare(
        `SELECT id, domain, status, last_error, attempt, max_attempts, updated_at, completed_at
           FROM work_queue
          WHERE org_id = ?
            AND domain = 'firefly_window'
            AND (status = 'dead_letter' OR last_error IS NOT NULL)
          ORDER BY COALESCE(completed_at, started_at, created_at) DESC
          LIMIT 20`
      ).bind(ctx.orgId).all<Record<string, unknown>>(),
      listFireflyKeyStatuses(ctx.orgId, env),
    ]);

  const keyUserIds = new Set(keyStatuses.map(k => k.user_id));
  const missingCredentials = users.results
    .filter(row => !keyUserIds.has(String(row.id)))
    .map(row => ({
      user_id: row.id,
      email: row.email,
      full_name: row.full_name,
      reason: 'missing_fireflies_credential',
    }));

  return jsonResponse({
    ok: true,
    range: { start_date: startDate, end_date: endDate, max_backfill_days: MAX_BACKFILL_DAYS },
    user_id: userId,
    users: users.results,
    missing_credentials: missingCredentials,
    coverage: {
      virtual_outlook_events: virtualOutlook?.n || 0,
      virtual_outlook_with_transcript: transcriptOutlook?.n || 0,
      fireflies_source_transcripts: transcriptItems.results.reduce((sum, row) => sum + Number(row.n || 0), 0),
      fireflies_by_status: transcriptItems.results,
      transcript_event_links: links?.n || 0,
      transcript_events: embedding?.transcript_events || 0,
      embedded_transcript_events: embedding?.embedded_events || 0,
    },
    work_queue: queued.results,
    recent_runs: jobs.results,
    recent_failures: failures.results,
  });
}

interface TranscriptRebuildBody {
  user_ids?: string[];
  start_date?: string;
  end_date?: string;
  dry_run?: boolean;
  repair_embeddings?: boolean;
  repair_prospect_signals?: boolean;
}

function validateRebuildRange(startDate: string, endDate: string): string | null {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'start_date / end_date must be ISO 8601';
  if (end <= start) return 'end_date must be after start_date';
  const days = Math.ceil((end - start) / 86400000);
  if (days > MAX_BACKFILL_DAYS) return `date span exceeds ${MAX_BACKFILL_DAYS} days`;
  return null;
}

/**
 * POST /api/admin/firefly-transcript-rebuild
 *
 * Body: { user_ids?, start_date?, end_date?, dry_run?, repair_embeddings?,
 * repair_prospect_signals? }
 */
export async function handleFireflyTranscriptRebuild(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canOperateTranscriptRebuild(ctx)) {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can start Fireflies transcript rebuilds.');
  }
  const body = (await parseJsonBody<TranscriptRebuildBody>(request)) || {};
  const fallbackRange = sixCalendarMonthsRange();
  if (body.start_date && isNaN(Date.parse(body.start_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'start_date must be ISO 8601');
  }
  if (body.end_date && isNaN(Date.parse(body.end_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'end_date must be ISO 8601');
  }
  const startDate = body.start_date ? new Date(body.start_date).toISOString() : fallbackRange.startDate;
  const endDate = body.end_date ? new Date(body.end_date).toISOString() : fallbackRange.endDate;
  const rangeError = validateRebuildRange(startDate, endDate);
  if (rangeError) return errorResponse('VALIDATION_ERROR', 400, rangeError);

  let userIds = Array.isArray(body.user_ids)
    ? body.user_ids.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  if (userIds.length === 0) {
    const credentialed = await listFireflyKeyStatuses(ctx.orgId, env);
    userIds = credentialed.map(row => row.user_id);
  }
  userIds = Array.from(new Set(userIds));

  const dryRun = body.dry_run === true;
  const results: Array<Record<string, unknown>> = [];
  for (const userId of userIds) {
    const user = await env.D1.prepare(
      `SELECT id, email FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(userId, ctx.orgId).first<{ id: string; email: string }>();
    if (!user) {
      results.push({ user_id: userId, created: false, reason: 'user_not_found' });
      continue;
    }
    const credential = await getFireflyKeyStatus(userId, env);
    if (!credential.exists) {
      results.push({
        user_id: userId,
        email: user.email,
        created: false,
        reason: 'missing_fireflies_credential',
      });
      continue;
    }

    const totalWindows = Math.ceil(Math.ceil((Date.parse(endDate) - Date.parse(startDate)) / 86400000) / 10);
    if (dryRun) {
      results.push({
        user_id: userId,
        email: user.email,
        created: false,
        dry_run: true,
        credential: { exists: true, last_used_at: credential.last_used_at },
        start_date: startDate,
        end_date: endDate,
        window_size_days: 10,
        total_windows: totalWindows,
      });
      continue;
    }

    const created = await createFireflyProgressiveBackfillRange(
      ctx.orgId,
      userId,
      startDate,
      endDate,
      10,
      undefined,
      env
    );
    results.push({
      user_id: userId,
      email: user.email,
      ...created,
      repair_embeddings: body.repair_embeddings !== false,
      repair_prospect_signals: body.repair_prospect_signals !== false,
    });
  }

  return jsonResponse({
    ok: true,
    dry_run: dryRun,
    range: { start_date: startDate, end_date: endDate, max_backfill_days: MAX_BACKFILL_DAYS },
    results,
  });
}

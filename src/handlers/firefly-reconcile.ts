// One-shot recovery + diagnostic endpoints around the Firefly→Outlook
// reconciliation path. Companion to the matcher fix in src/lib/reconciliation.ts.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { reconcileFireflyToOutlook } from '../lib/reconciliation';
import { getGraphMailboxAuthForUser, graphMailboxUrl } from '../lib/graph-auth';

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

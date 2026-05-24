// Phase 0a-3 — Outlook calendar progressive backfill driver.
//
// Replaces the prior all-at-once fetchOutlookCalendarDelta path which
// fetched 120 days × all users in a single step.do invocation and blew
// the 1000-subrequest CF cap (Terminal 5 forensic 2026-05-03).
//
// The driver chunks the calendar window into per-user-per-week rows
// (table calendar_progressive_backfill_windows, migration 0080),
// processes 1-2 stale rows per user per tick, and converges to full
// 120-day coverage over ~15 hours of hourly ticks.
//
// Architectural mirror of Firefly progressive-backfill (migration 0064 +
// src/lib/firefly-progressive-backfill.ts):
//   • Per-window state row with status state machine + attempts counter.
//   • Bootstrap on first call (idempotent INSERT OR IGNORE).
//   • Lock-via-locked_until on in_progress to prevent concurrent
//     processing across cron-tick overlap.
//   • Three-tier retry: transient → backoff (5min, 30min) → dead-letter.
//
// Standing properties:
//   • Idempotency      — UNIQUE(org_id, user_id, window_start) on the
//                        windows table; upsertOutlookEvent ON CONFLICT
//                        on the events table.
//   • Atomicity        — single-statement state transitions; in_progress
//                        lock prevents concurrent processing.
//   • Checkpointing    — last_synced_at + attempts + next_attempt_at
//                        per row are durable progress markers.
//   • Rate-limit aware — checkGraphRateLimit gates every Graph fetch.
//   • Three-tier retry — encoded in driveCalendarProgressiveBackfill.
//   • Observability    — structured return shape feeds System Status
//                        when Phase 0 ships.
//   • Self-healing     — failed token refreshes / transient HTTP errors
//                        record per-row and back off; new weeks
//                        auto-bootstrap as time advances.

import type { Env } from '../types/env';
import { getActiveUsersForOrg, getDecryptedAccessToken } from './helpers';
import { refreshOutlookToken, recordTokenFailure } from '../integrations/oauth';
import { upsertOutlookEvent, type OutlookEventLike } from './reconciliation';
import { checkGraphRateLimit, recordGraphApiCall } from './rate-limit';
import type { CalendarSyncResult } from '../integrations/outlook';

// ─── Constants ────────────────────────────────────────────────────────────

// Window coverage. Matches the prior fetchOutlookCalendarDelta:
//   start = now - 120d  → covers the oldest backfilled Firefly transcripts
//   end   = now + 90d   → forward window for upcoming meetings
const PAST_DAYS = 120;
const FUTURE_DAYS = 90;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Per-tick budget. Drives 2 windows per user per invocation; with ~4
// active users that's 8 weeks of work per tick. Each window costs ~1
// Graph fetch (one page handles a week's events for typical density)
// + 5–50 D1 upserts. Total per tick: ≤ 8 × 60 ≈ 480 subrequests, well
// inside the 1000-subrequest CF cap.
const MAX_WINDOWS_PER_USER_PER_TICK = 2;

// Refresh intervals — gates how often a 'completed' row is re-promoted
// to pickable. Tighter for current+adjacent weeks (events shift more
// frequently near "now"); looser for older weeks (mostly settled).
const REFRESH_INTERVAL_RECENT_MS = 4 * 60 * 60 * 1000;   // 4h
const REFRESH_INTERVAL_OLDER_MS = 24 * 60 * 60 * 1000;   // 24h
// Number of weeks ±now considered "recent" for refresh-interval
// classification.
const RECENT_WEEKS_THRESHOLD = 2;

// Per-Graph-fetch HTTP timeout. Mirrors GRAPH_REQUEST_TIMEOUT_MS in
// outlook.ts (Phase 0a). 30s is generous for one paginated page.
const GRAPH_REQUEST_TIMEOUT_MS = 30_000;

// Wallclock cap on processWindow for a single window. Bounded by the
// outer step budget; this is defense in depth.
const PER_WINDOW_BUDGET_MS = 60_000;

// Lock duration: while a row is in_progress, locked_until = now + this.
// 5 min is well above PER_WINDOW_BUDGET_MS; expired locks are safely
// reclaimable by the next tick if the prior owner died.
const LOCK_DURATION_MS = 5 * 60 * 1000;

// Three-tier retry. After MAX_ATTEMPTS the row dead-letters as 'failed'.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFFS_MS: Record<number, number> = {
  1: 5 * 60 * 1000,    // 5 min after 1st fail
  2: 30 * 60 * 1000,   // 30 min after 2nd fail
  // After 3rd: status='failed', no auto retry (dead-letter)
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Return the UTC Monday 00:00 of the week containing `d`. */
function weekStartUtc(d: Date): Date {
  // getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat → daysFromMonday: Sun=6, Mon=0, ..., Sat=5
  const daysFromMonday = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysFromMonday,
    0, 0, 0, 0
  ));
}

/** Compute the refresh interval for a window based on its proximity to now. */
export function refreshIntervalForWindow(windowStartIso: string): number {
  const windowStartMs = Date.parse(windowStartIso);
  if (!Number.isFinite(windowStartMs)) return REFRESH_INTERVAL_OLDER_MS;
  const weeksFromNow = Math.abs((Date.now() - windowStartMs) / WEEK_MS);
  return weeksFromNow <= RECENT_WEEKS_THRESHOLD
    ? REFRESH_INTERVAL_RECENT_MS
    : REFRESH_INTERVAL_OLDER_MS;
}

interface WindowRow {
  id: string;
  org_id: string;
  user_id: string;
  window_start: string;
  window_end: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  last_synced_at: string | null;
  events_upserted: number;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  locked_until: string | null;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────

/**
 * INSERT OR IGNORE one row per (user, week) for the configured coverage
 * range. Idempotent — no-op for rows that already exist. New weeks are
 * picked up automatically as time advances.
 */
export async function ensureWindowRowsExist(
  orgId: string,
  userId: string,
  env: Env
): Promise<{ inserted: number }> {
  const now = new Date();
  const earliest = new Date(now.getTime() - PAST_DAYS * 86400000);
  const latest = new Date(now.getTime() + FUTURE_DAYS * 86400000);

  const firstWeek = weekStartUtc(earliest);
  const lastWeek = weekStartUtc(latest);

  const stmts = [];
  for (
    let cursor = new Date(firstWeek.getTime());
    cursor.getTime() <= lastWeek.getTime();
    cursor = new Date(cursor.getTime() + WEEK_MS)
  ) {
    const wStart = cursor.toISOString();
    const wEnd = new Date(cursor.getTime() + WEEK_MS).toISOString();
    stmts.push(
      env.D1.prepare(
        `INSERT OR IGNORE INTO calendar_progressive_backfill_windows
           (org_id, user_id, window_start, window_end, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).bind(orgId, userId, wStart, wEnd)
    );
  }

  if (stmts.length === 0) return { inserted: 0 };
  const results = await env.D1.batch(stmts);
  const inserted = results.reduce((acc, r) => acc + (r.meta?.changes ?? 0), 0);
  return { inserted };
}

// ─── Pick + lock ──────────────────────────────────────────────────────────

/**
 * Pick the next pickable window for this user. Pickable means:
 *   (status='pending'
 *      AND (next_attempt_at IS NULL OR next_attempt_at <= now))
 *   OR (status='completed'
 *      AND last_synced_at < now − refresh_interval)
 * AND (locked_until IS NULL OR locked_until <= now)
 *
 * Refresh-interval varies per row — the sort prefers oldest-stale-first
 * and oldest-pending-first. Sorting all together by COALESCE(last_synced_at,
 * window_start) achieves "things last touched longest ago" without
 * needing per-row refresh-interval comparison in SQL.
 *
 * Lock-and-pick is two statements, NOT atomic: a concurrent driver could
 * pick the same row. Acceptable because (a) cron firing at the same
 * minute is rare, (b) the lock_until column ensures only one driver
 * actually advances the row's state past in_progress, (c) upsertOutlookEvent
 * is idempotent so duplicate processing is safe.
 */
async function pickNextWindow(
  orgId: string,
  userId: string,
  env: Env
): Promise<WindowRow | null> {
  const nowIso = new Date().toISOString();

  // SELECT pending + completed-stale rows. Filter by lock + retry-backoff
  // in WHERE; refresh-interval staleness check is approximate (WEEK_MS as
  // the floor — anything older than 1 week is definitely stale; we
  // re-check refresh interval in JS for tighter intervals on recent weeks).
  const candidates = await env.D1.prepare(
    `SELECT id, org_id, user_id, window_start, window_end, status,
            last_synced_at, events_upserted, attempts, last_error,
            next_attempt_at, locked_until
       FROM calendar_progressive_backfill_windows
      WHERE org_id = ? AND user_id = ?
        AND status IN ('pending', 'completed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (locked_until IS NULL OR locked_until <= ?)
      ORDER BY COALESCE(last_synced_at, '0000-00-00') ASC,
               window_start ASC
      LIMIT 10`
  ).bind(orgId, userId, nowIso, nowIso).all<WindowRow>();

  // Walk candidates and return the first one that's actually pickable
  // per the per-row refresh interval. (Pending rows always pickable;
  // completed rows only pickable if last_synced_at < now − interval.)
  for (const row of candidates.results) {
    if (row.status === 'pending') return row;
    if (row.status === 'completed' && row.last_synced_at) {
      const staleAfter = Date.parse(row.last_synced_at) +
        refreshIntervalForWindow(row.window_start);
      if (Date.now() >= staleAfter) return row;
    }
  }
  return null;
}

/**
 * Atomically claim a row by transitioning to in_progress + setting
 * locked_until. Returns true when this driver instance won the lock.
 *
 * The WHERE clause double-checks the row's state so two drivers picking
 * the same candidate row will only have one win — the loser's UPDATE
 * matches zero rows.
 */
async function claimWindow(
  windowId: string,
  expectedStatus: 'pending' | 'completed',
  env: Env
): Promise<boolean> {
  const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
  const result = await env.D1.prepare(
    `UPDATE calendar_progressive_backfill_windows
        SET status = 'in_progress',
            locked_until = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
        AND status = ?
        AND (locked_until IS NULL OR locked_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(lockedUntil, windowId, expectedStatus).run();
  return (result.meta?.changes ?? 0) > 0;
}

// ─── Fetch + process one window ──────────────────────────────────────────

interface ApiCalendarEvent extends OutlookEventLike {
  // /calendarView returns the OutlookEventLike shape; this alias makes
  // the fetch path's intent obvious without a redundant local interface.
}

/**
 * Paginate through /me/calendarView for the given window's date range.
 * Per-fetch AbortSignal, paginate via @odata.nextLink. Returns the
 * collected events. Throws on hard failure (caller decides retry).
 */
export async function fetchEventsForWindow(
  token: string,
  userId: string,
  windowStart: string,
  windowEnd: string,
  orgId: string,
  env: Env
): Promise<ApiCalendarEvent[]> {
  let url: string =
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(
      windowStart
    )}&endDateTime=${encodeURIComponent(windowEnd)}&$top=50`;

  const events: ApiCalendarEvent[] = [];
  const startedAt = Date.now();

  while (url) {
    if (Date.now() - startedAt > PER_WINDOW_BUDGET_MS) {
      throw new Error(
        `per_window_budget_exceeded user=${userId} window=${windowStart} events_so_far=${events.length}`
      );
    }
    if (!(await checkGraphRateLimit(orgId, env))) {
      throw new Error('graph_rate_limit_open');
    }

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'odata.maxpagesize=50, outlook.timezone="UTC"',
      },
      signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
    });
    await recordGraphApiCall(orgId, env);

    if (!resp.ok) {
      const status = resp.status;
      if (status === 401) await recordTokenFailure(userId, 'outlook', env);
      // Surface as throwable so the row attempt counter increments and
      // backoff kicks in. http_status preserved in the error message for
      // diagnostics.
      throw new Error(`graph_api_error (HTTP ${status})`);
    }

    const data = (await resp.json()) as {
      value: ApiCalendarEvent[];
      '@odata.nextLink'?: string;
    };
    events.push(...(data.value || []));
    url = data['@odata.nextLink'] || '';
  }

  return events;
}

/** Mark window completed with the success path. */
async function markWindowCompleted(
  windowId: string,
  eventsUpserted: number,
  env: Env
): Promise<void> {
  await env.D1.prepare(
    `UPDATE calendar_progressive_backfill_windows
        SET status = 'completed',
            last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            events_upserted = events_upserted + ?,
            attempts = 0,
            last_error = NULL,
            next_attempt_at = NULL,
            locked_until = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(eventsUpserted, windowId).run();
}

/**
 * Phase 6.1 (2026-05-05): slim cousin of markWindowCompleted that only
 * touches the LONG-LIVED columns (last_synced_at + events_upserted).
 * The per-cycle columns (status, attempts, last_error, next_attempt_at,
 * locked_until) are now legacy — work_queue tracks per-cycle state on
 * its own rows. Called by calendarRefreshHandler after a successful
 * fetch+upsert pass.
 */
export async function recordCalendarSyncSuccess(
  windowId: string,
  eventsUpserted: number,
  env: Env
): Promise<void> {
  await env.D1.prepare(
    `UPDATE calendar_progressive_backfill_windows
        SET last_synced_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            events_upserted = events_upserted + ?,
            updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(eventsUpserted, windowId).run();
}

/** Mark window for retry or dead-letter based on attempts. */
async function markWindowFailed(
  windowId: string,
  newAttempts: number,
  errorMsg: string,
  env: Env
): Promise<void> {
  if (newAttempts >= MAX_ATTEMPTS) {
    // Dead-letter. Status='failed', no next_attempt_at — operator
    // must reset via admin endpoint (or a periodic sweep can promote
    // back to pending after N hours; deferred to follow-up).
    await env.D1.prepare(
      `UPDATE calendar_progressive_backfill_windows
          SET status = 'failed',
              attempts = ?,
              last_error = ?,
              next_attempt_at = NULL,
              locked_until = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(newAttempts, errorMsg.slice(0, 500), windowId).run();
    return;
  }

  // Transient: schedule the retry via next_attempt_at + return to pending.
  const backoffMs = RETRY_BACKOFFS_MS[newAttempts] ?? 5 * 60 * 1000;
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
  await env.D1.prepare(
    `UPDATE calendar_progressive_backfill_windows
        SET status = 'pending',
            attempts = ?,
            last_error = ?,
            next_attempt_at = ?,
            locked_until = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(newAttempts, errorMsg.slice(0, 500), nextAttemptAt, windowId).run();
}

// ─── Public driver ────────────────────────────────────────────────────────

/**
 * Phase 6.1 (2026-05-05): the inline pick-and-sync loop has been
 * replaced by a work_queue handler running on the minute tick (see
 * src/lib/work-queue-handlers/calendar-refresh.ts). This function
 * now does ONLY bootstrap — it ensures one window row per
 * (user × week) exists in calendar_progressive_backfill_windows.
 * The actual fetch/upsert work is enqueued separately by
 * enqueueCalendarRefreshes (called every minute tick) and processed
 * by the calendar_refresh handler at minute cadence.
 *
 * Net behavior change: hourly drain → minute drain (~60× faster
 * healing for never-synced + stale-completed paths). graph circuit-
 * breaker still gates per-page fetches; bursts above the breaker's
 * cap auto-defer until the circuit closes.
 *
 * Return shape preserved for the ingestion workflow's calendar step:
 * events_upserted=0 because no sync happens here. errors[] surfaces
 * only per-user bootstrap failures + token-failure threshold skips
 * (those are detected pre-bootstrap to mirror prior behavior).
 *
 * The pickNextWindow / claimWindow / markWindowCompleted /
 * markWindowFailed helpers below are kept in source as dead code —
 * they're unused after Phase 6.1 but preserved for revert. Drop in
 * Phase 6.x or 7 once work_queue calendar handler has handled real
 * traffic for several days.
 */
export async function driveCalendarProgressiveBackfill(
  orgId: string,
  env: Env
): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = { events_upserted: 0, errors: [] };
  const users = await getActiveUsersForOrg(orgId, env);

  for (const user of users) {
    // Skip users whose Outlook tokens have failed too many times.
    // Preserved here (vs leaving to the handler) so a permanently-
    // broken-token user doesn't churn through bootstrap → enqueue →
    // handler-fail → dead_letter on every tick. The handler also
    // checks via refreshOutlookToken's success flag, but heading off
    // the enqueue saves cycles.
    const failState = await env.KV.get<{ count: number }>(
      `token_failed:${user.id}:outlook`,
      'json'
    );
    if (failState && failState.count >= 3) {
      result.errors.push({ user_id: user.id, error: 'token_failed_threshold_exceeded' });
      continue;
    }

    // Bootstrap any missing window rows. INSERT OR IGNORE so this is a
    // no-op after first run; cheap (a single batch).
    try {
      await ensureWindowRowsExist(orgId, user.id, env);
    } catch (e) {
      console.error(`[calendar-progressive] bootstrap failed for user=${user.id}:`, e);
      result.errors.push({
        user_id: user.id,
        error: `bootstrap_failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return result;
}

// ─── Phase 6.1: minute-tick scheduler ─────────────────────────────────────

interface CalendarScanRow {
  id: string;
  org_id: string;
  user_id: string;
  window_start: string;
  window_end: string;
  last_synced_at: string | null;
}

/**
 * Scan calendar_progressive_backfill_windows for rows that need work
 * and enqueue work_queue rows for each. Runs on every minute tick
 * (called from src/index.ts before processWorkQueueTick).
 *
 * "Needs work" means:
 *   • last_synced_at IS NULL (never synced) — initial sync
 *   • last_synced_at + refreshIntervalForWindow(window_start) < now
 *     (refresh stale per the per-window 4h/24h policy)
 *
 * Status is intentionally NOT in the predicate. Legacy 'failed' rows
 * from the pre-Phase-6.1 era will re-enqueue here and either succeed
 * (if the failure was transient) or fail through work_queue's three-
 * tier retry into work_queue:dead_letter (where they surface in
 * System Status). This is a deliberate self-healing improvement —
 * code changes that fix the underlying bug now heal old failed rows
 * automatically.
 *
 * Idempotency_key = `${user_id}:${window_start}:${last_synced_at ?? 'init'}`.
 *   • Fresh enqueues with the same key collapse via partial UNIQUE
 *     on (domain, idempotency_key) — concurrent staleness scans
 *     from overlapping ticks don't double-enqueue.
 *   • After the handler completes a refresh, recordCalendarSyncSuccess
 *     bumps last_synced_at; the next staleness scan computes a NEW
 *     key (different last_synced_at suffix), so a fresh refresh row
 *     enqueues cleanly without colliding with the prior completed
 *     work_queue row.
 *
 * Subrequest cost: 1 SELECT (returns ~30 rows × N users in this org)
 * + up to N enqueueWork calls. Steady state (most rows fresh): just
 * the SELECT. Initial bootstrap or after a refresh-interval boundary:
 * up to ~30 enqueueWork calls per user. Stays under per-tick budget.
 */
export async function enqueueCalendarRefreshes(
  orgId: string,
  env: Env
): Promise<{ enqueued: number; scanned: number }> {
  const rows = await env.D1.prepare(
    `SELECT id, org_id, user_id, window_start, window_end, last_synced_at
       FROM calendar_progressive_backfill_windows
      WHERE org_id = ?`
  ).bind(orgId).all<CalendarScanRow>();

  if (rows.results.length === 0) return { enqueued: 0, scanned: 0 };

  const { enqueueWork } = await import('./work-queue');
  const now = Date.now();
  let enqueued = 0;

  for (const row of rows.results) {
    const needsWork =
      row.last_synced_at === null ||
      Date.parse(row.last_synced_at) + refreshIntervalForWindow(row.window_start) < now;
    if (!needsWork) continue;

    const idempotencyKey = `${row.user_id}:${row.window_start}:${row.last_synced_at ?? 'init'}`;
    const result = await enqueueWork(env, row.org_id, 'calendar_refresh',
      {
        window_id: row.id,
        user_id: row.user_id,
        window_start: row.window_start,
        window_end: row.window_end,
      },
      {
        upstream: 'graph',
        idempotency_key: idempotencyKey,
      }
    );
    if (result.inserted) enqueued++;
  }
  return { enqueued, scanned: rows.results.length };
}

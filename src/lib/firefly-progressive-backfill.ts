// Firefly progressive backfill — mirrors src/lib/progressive-backfill.ts
// for transcript pulls. Splits a long window (e.g. 90 days) into N small
// windows (9 × 10 days) and advances them one paginated batch at a time
// across cron ticks.
//
// Key differences from the Outlook progressive lib:
//   - Per-user Firefly API key encrypted on the parent row (Outlook uses
//     OAuth tokens on users.outlook_token; Firefly is user-supplied each
//     time, so the key lives only as long as the parent job and is nuked
//     on completion / cancellation per Phase F Q(a)).
//   - Pagination resume is offset-based (last_skip on the window row)
//     rather than KV-resume. Firefly GraphQL doesn't expose opaque
//     cursors, so the last successfully-processed `skip` IS the cursor.
//   - Per-window driver is runFireflyWindowBackfill in src/lib/firefly-ingest.ts;
//     the Outlook equivalent is runHistoricalBackfill in src/integrations/outlook.ts.
//
// One active parent per user at a time — preserves the same simple
// invariant Outlook progressive uses. Multiple users run in parallel
// across cron ticks (different user_ids, different api_keys, no shared
// per-user state).

import type { Env } from '../types/env';
import { encryptToken, decryptToken } from './encryption';
import { runFireflyWindowBackfill } from './firefly-ingest';
import { checkBudget, recordUsage, recordRateLimit } from './upstream-budget';
import { getFireflyKey, storeFireflyKey, getFireflyKeyStatus } from './firefly-credentials';

// Multi-day scheduling tunables.
//
// MAX_BACKFILL_DAYS: hard cap on total date span per parent. Pulls beyond
// this need to be split into multiple parents.
//
// Phase 4 (2026-05-04): reduced 180 → 120. The frontend Fireflies
// Historical Backfill card now offers presets up to 120 days (the
// 180-day button was dropped per the bundled UX redesign). Aligning
// the backend cap with the frontend UX prevents the "you can request
// 180 in JSON but the dropdown maxes at 120" mismatch. Q3 audit on
// 2026-05-04 confirmed zero in-flight backfills with
// scheduled_days_count > 120, so the change is safely "cap NEW
// creates" with no migration logic needed for existing rows
// (Option C from the Phase 4 plan).
export const MAX_BACKFILL_DAYS = 120;

// WINDOWS_PER_DAY: target windows scheduled to run on the same UTC day.
// Each window does ~5-15 transcripts depending on density; 4 windows × ~10
// transcripts ≈ 40 transcripts/day, comfortably under Fireflies' observed
// daily quota for a single user. Tuned conservatively so the first
// real-world hit informs daily_quota_target on the parent.
export const WINDOWS_PER_DAY = 4;

// LOCK_DURATION_MS: per-window concurrency lock duration. Two cron ticks
// firing within the same minute (the every-minute progressive cron + a
// secondary scheduled ingestion that imports './lib/firefly-progressive-backfill'
// could race on the same in_progress window. Audit 2026-04-30 confirmed
// this caused counter drift (window 4: persisted+dup+failed=27 vs
// last_skip=13). 5 min is well above the per-tick wallclock cap (25s) so
// a winning tick fully owns the window for its execution; expired locks
// are reclaimable by the next tick if a worker died mid-flight.
export const LOCK_DURATION_MS = 5 * 60 * 1000;

// On rate-limit pause: defer the window until the next UTC midnight (the
// observed Fireflies daily-quota reset boundary per the
// "Please retry after Fri, 01 May 2026 00:00:01 GMT (UTC)" response). The
// driver will not re-pick a deferred window until earliest_run_at is reached.
function nextUtcMidnightIso(): string {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0, 0
  ));
  return tomorrow.toISOString();
}

function utcDateString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Increment per-user daily quota counters. Idempotent on (user_id,
 * quota_date) via ON CONFLICT. Called from the driver on each Fireflies
 * page fetch so we have visibility into per-user API usage trending toward
 * the daily limit.
 *
 * Phase 3.4 (2026-05-04) hybrid: ALSO dual-writes to the
 * upstream_budget_ledger when `orgId` is provided. firefly_user_quotas
 * stays as the per-user-daily authoritative store (it carries detail the
 * ledger doesn't — backfill_calls vs webhook_deliveries vs daily_limit
 * self-discovery); the ledger adds cross-org observability + circuit-
 * breaker auto-tune-down. Both writes are independent (per-store
 * catch-and-log) so a failure on one does not block the other.
 *
 * `orgId` is optional so future callers without an org context can
 * keep using the function and only get the firefly_user_quotas write.
 */
async function recordFireflyApiCall(
  userId: string,
  env: Env,
  rateLimited: boolean = false,
  orgId?: string,
): Promise<void> {
  const date = utcDateString();
  await env.D1.prepare(
    `INSERT INTO firefly_user_quotas (user_id, quota_date, api_calls_used, backfill_calls, rate_limited_at)
     VALUES (?, ?, 1, 1, ?)
     ON CONFLICT(user_id, quota_date) DO UPDATE SET
       api_calls_used = api_calls_used + 1,
       backfill_calls = backfill_calls + 1,
       rate_limited_at = COALESCE(excluded.rate_limited_at, rate_limited_at)`
  ).bind(userId, date, rateLimited ? new Date().toISOString() : null).run().catch(e => {
    console.error(`[firefly-quota] insert failed for ${userId}:`, e?.message || e);
  });

  // Phase 3.4 hybrid dual-write to upstream_budget_ledger. Per-user
  // (user_id is the actual user, NOT the '*' org-wide sentinel that
  // graph/gemini/claude/bge use). On rate-limit: feed the circuit
  // breaker (3 × 429 → cap drops 10%, circuit opens 30 min). On
  // success: increment used. Catch-and-log so a ledger failure does
  // not block the tick or shadow the firefly_user_quotas write above.
  if (orgId) {
    if (rateLimited) {
      await recordRateLimit(env, orgId, userId, 'firefly', 'daily').catch(e => {
        console.error(`[firefly-ledger] recordRateLimit failed for ${userId}:`, e?.message || e);
      });
    } else {
      await recordUsage(env, orgId, userId, 'firefly', 'daily').catch(e => {
        console.error(`[firefly-ledger] recordUsage failed for ${userId}:`, e?.message || e);
      });
    }
  }
}

export interface FireflyProgressiveBackfillJob {
  id: string;
  org_id: string;
  user_id: string;
  api_key_encrypted: string;
  window_size_days: number;
  total_windows: number;
  status: 'active' | 'completed' | 'partially_completed' | 'cancelled';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  scheduled_days_count: number;
  current_day_index: number;
  daily_quota_target: number | null;
}

export interface FireflyProgressiveBackfillWindow {
  id: string;
  parent_id: string;
  window_index: number;
  start_date: string;
  end_date: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  last_skip: number;
  transcripts_fetched: number;
  transcripts_persisted: number;
  transcripts_skipped_duplicate: number;
  transcripts_failed: number;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  scheduled_for_day: number;
  earliest_run_at: string | null;
  lock_expires_at: string | null;
}

/**
 * Seed a new Firefly progressive backfill: persist the API key (Phase 4),
 * INSERT parent + N pending windows going BACKWARDS in time. Window 0 is
 * the most recent slice (now-windowSizeDays → now), window N-1 is the
 * oldest. Refuses if the user has any other active parent (same
 * one-active-at-a-time invariant Outlook uses).
 *
 * Phase 4 (2026-05-04): `fireflyApiKey` is now optional.
 *   • If provided: stored in user_firefly_credentials (persisted for
 *     future runs) AND encrypted into the job row (legacy fallback for
 *     this job specifically — defense-in-depth).
 *   • If omitted: look up the user's persistent credential. If absent,
 *     return an error prompting setup. The job's api_key_encrypted is
 *     written as '' since the driver reads from the persistent table
 *     anyway (the column is NOT NULL so we can't omit it).
 */
export async function createFireflyProgressiveBackfill(
  orgId: string,
  userId: string,
  totalDays: number,
  windowSizeDays: number,
  fireflyApiKey: string | null | undefined,
  env: Env
): Promise<{ created: boolean; parent_id?: string; total_windows?: number; scheduled_days_count?: number; reason?: string }> {
  if (totalDays <= 0 || windowSizeDays <= 0 || windowSizeDays > totalDays) {
    return { created: false, reason: 'invalid totalDays / windowSizeDays' };
  }
  if (totalDays > MAX_BACKFILL_DAYS) {
    return { created: false, reason: `date span exceeds the ${MAX_BACKFILL_DAYS}-day cap; split into multiple requests` };
  }

  // Phase 4: resolve the API key — either from request body (auto-persist)
  // or from the user's stored credential. Either path produces a job row
  // with non-null api_key_encrypted, so the legacy column constraint is
  // satisfied without schema change.
  const trimmed = fireflyApiKey?.trim() || '';
  let apiKeyEncrypted: string;
  if (trimmed.length > 0) {
    // Provided: persist for future use AND encrypt into the job row
    // (legacy backward-compat — driver reads from persistent first
    // anyway, but the per-job copy is defense-in-depth in case the
    // credentials table has decrypt issues mid-job).
    await storeFireflyKey(userId, trimmed, env);
    apiKeyEncrypted = await encryptToken({ api_key: trimmed }, env);
  } else {
    // Omitted: must already have a stored credential. Existence check
    // (no plaintext fetch) — driver will fetch the plaintext at tick
    // time. Job row's api_key_encrypted is set to '' as placeholder;
    // the driver detects empty and skips the legacy fallback path.
    const status = await getFireflyKeyStatus(userId, env);
    if (!status.exists) {
      return {
        created: false,
        reason: 'no firefly_api_key provided and no stored credential — set up Firefly credentials first',
      };
    }
    apiKeyEncrypted = '';
  }

  const existing = await env.D1.prepare(
    `SELECT id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (existing) {
    return { created: false, reason: `User already has active firefly parent ${existing.id}` };
  }

  const totalWindows = Math.ceil(totalDays / windowSizeDays);
  const scheduledDaysCount = Math.max(1, Math.ceil(totalWindows / WINDOWS_PER_DAY));

  const insertedParent = await env.D1.prepare(
    `INSERT INTO firefly_progressive_backfill_jobs
       (org_id, user_id, api_key_encrypted, window_size_days, total_windows, status, scheduled_days_count)
     VALUES (?, ?, ?, ?, ?, 'active', ?)
     RETURNING id`
  ).bind(orgId, userId, apiKeyEncrypted, windowSizeDays, totalWindows, scheduledDaysCount).first<{ id: string }>();
  if (!insertedParent) {
    return { created: false, reason: 'parent insert failed' };
  }
  const parentId = insertedParent.id;

  // Newest-first windows anchored on `now`. Window i covers
  // [now - (i+1)*windowSizeDays, now - i*windowSizeDays). scheduled_for_day
  // distributes WINDOWS_PER_DAY windows per UTC day; earliest_run_at is
  // null for day 0 (run immediately) and (parent.created_at + day*24h) for
  // later days. The driver gates on earliest_run_at <= now when picking.
  const now = Date.now();
  const stmts = [];
  for (let i = 0; i < totalWindows; i++) {
    const end = new Date(now - i * windowSizeDays * 86400000).toISOString();
    const start = new Date(now - (i + 1) * windowSizeDays * 86400000).toISOString();
    const scheduledForDay = Math.floor(i / WINDOWS_PER_DAY);
    const earliestRunAt = scheduledForDay === 0
      ? null
      : new Date(now + scheduledForDay * 86400000).toISOString();
    stmts.push(
      env.D1.prepare(
        `INSERT INTO firefly_progressive_backfill_windows
           (parent_id, window_index, start_date, end_date, status, scheduled_for_day, earliest_run_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(parentId, i, start, end, scheduledForDay, earliestRunAt)
    );
  }
  await env.D1.batch(stmts);

  return { created: true, parent_id: parentId, total_windows: totalWindows, scheduled_days_count: scheduledDaysCount };
}

/**
 * Sibling for explicit date-range mode. Same backward windowing as the
 * days_back variant — window 0 is the most recent slice anchored on
 * endDate, window N-1 is the oldest slice clamped at startDate. Used by
 * Tony's recovery path (start_date = 90 days ago, end_date = today).
 */
export async function createFireflyProgressiveBackfillRange(
  orgId: string,
  userId: string,
  startDate: string,
  endDate: string,
  windowSizeDays: number,
  fireflyApiKey: string | null | undefined,
  env: Env
): Promise<{ created: boolean; parent_id?: string; total_windows?: number; scheduled_days_count?: number; reason?: string }> {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { created: false, reason: 'invalid start_date / end_date' };
  }
  if (end <= start) {
    return { created: false, reason: 'end_date must be > start_date' };
  }
  if (windowSizeDays <= 0) {
    return { created: false, reason: 'invalid windowSizeDays' };
  }
  const totalDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);
  if (totalDays > MAX_BACKFILL_DAYS) {
    return { created: false, reason: `date span exceeds the ${MAX_BACKFILL_DAYS}-day cap; split into multiple requests` };
  }
  const totalWindows = Math.ceil(totalDays / windowSizeDays);
  const scheduledDaysCount = Math.max(1, Math.ceil(totalWindows / WINDOWS_PER_DAY));

  const existing = await env.D1.prepare(
    `SELECT id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (existing) {
    return { created: false, reason: `User already has active firefly parent ${existing.id}` };
  }

  // Phase 4: same key resolution as the days_back variant — see that
  // function's comments for full rationale (auto-persist when provided,
  // require existing stored credential when omitted, '' placeholder
  // when relying on persistent for backward-compat with NOT NULL column).
  const trimmed = fireflyApiKey?.trim() || '';
  let apiKeyEncrypted: string;
  if (trimmed.length > 0) {
    await storeFireflyKey(userId, trimmed, env);
    apiKeyEncrypted = await encryptToken({ api_key: trimmed }, env);
  } else {
    const status = await getFireflyKeyStatus(userId, env);
    if (!status.exists) {
      return {
        created: false,
        reason: 'no firefly_api_key provided and no stored credential — set up Firefly credentials first',
      };
    }
    apiKeyEncrypted = '';
  }

  const insertedParent = await env.D1.prepare(
    `INSERT INTO firefly_progressive_backfill_jobs
       (org_id, user_id, api_key_encrypted, window_size_days, total_windows, status, scheduled_days_count)
     VALUES (?, ?, ?, ?, ?, 'active', ?)
     RETURNING id`
  ).bind(orgId, userId, apiKeyEncrypted, windowSizeDays, totalWindows, scheduledDaysCount).first<{ id: string }>();
  if (!insertedParent) {
    return { created: false, reason: 'parent insert failed' };
  }
  const parentId = insertedParent.id;

  const stmts = [];
  const endMs = end.getTime();
  const startMs = start.getTime();
  const nowMs = Date.now();
  for (let i = 0; i < totalWindows; i++) {
    const winEndMs = endMs - i * windowSizeDays * 86400000;
    const winStartMs = Math.max(startMs, endMs - (i + 1) * windowSizeDays * 86400000);
    const scheduledForDay = Math.floor(i / WINDOWS_PER_DAY);
    const earliestRunAt = scheduledForDay === 0
      ? null
      : new Date(nowMs + scheduledForDay * 86400000).toISOString();
    stmts.push(
      env.D1.prepare(
        `INSERT INTO firefly_progressive_backfill_windows
           (parent_id, window_index, start_date, end_date, status, scheduled_for_day, earliest_run_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(parentId, i, new Date(winStartMs).toISOString(), new Date(winEndMs).toISOString(), scheduledForDay, earliestRunAt)
    );
  }
  await env.D1.batch(stmts);

  return { created: true, parent_id: parentId, total_windows: totalWindows, scheduled_days_count: scheduledDaysCount };
}

/**
 * Cancel an active backfill: parent → 'cancelled', in-progress/pending
 * windows → 'failed' with reason (windows CHECK doesn't allow
 * 'cancelled'). NUKES api_key_encrypted to '' per Phase F Q(a):
 * least-privilege default for transactional secrets.
 */
export async function cancelFireflyProgressiveBackfill(
  orgId: string,
  userId: string,
  env: Env,
  reason: string = 'cancelled by user'
): Promise<{ ok: boolean; result: 'cancelled' | 'not_found' }> {
  const parent = await env.D1.prepare(
    `SELECT id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (!parent) return { ok: true, result: 'not_found' };

  await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_jobs
        SET status = 'cancelled',
            api_key_encrypted = '',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(parent.id).run();

  await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_windows
        SET status = 'failed',
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE parent_id = ? AND status IN ('pending','in_progress')`
  ).bind(reason, parent.id).run();

  return { ok: true, result: 'cancelled' };
}

/**
 * Finalize a parent's status. If any window ended in 'failed' (terminal,
 * non-rate-limit), parent flips to 'partially_completed' so the failures
 * are visible. If all completed, parent → 'completed'. In either case the
 * api_key is nuked. Called from the driver when no pickable window remains
 * AND no future-scheduled window is waiting for its earliest_run_at.
 */
async function finalizeParent(parentId: string, env: Env): Promise<'completed' | 'partially_completed'> {
  const counts = await env.D1.prepare(
    `SELECT
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM firefly_progressive_backfill_windows WHERE parent_id = ?`
  ).bind(parentId).first<{ failed: number; completed: number }>();
  const finalStatus: 'completed' | 'partially_completed' =
    (counts?.failed ?? 0) > 0 ? 'partially_completed' : 'completed';
  await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_jobs
        SET status = ?,
            api_key_encrypted = '',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(finalStatus, parentId).run();
  return finalStatus;
}

/**
 * One cron tick of work for one user: claim and advance the next pickable
 * window. Multi-day-aware (defers to earliest_run_at) and concurrency-safe
 * (lock_expires_at gates two-tick races).
 *
 * Sequence:
 *   1. Find this user's active parent. If none, return.
 *   2. Atomically claim the lowest-indexed pickable window — pending OR
 *      in_progress, with earliest_run_at <= now AND lock_expires_at expired.
 *      The atomic claim is a single UPDATE ... RETURNING so two cron ticks
 *      can't both pick the same row. If the claim returns no row, either
 *      the parent has no work for this UTC day (some windows scheduled for
 *      tomorrow) or another tick already owns the next window.
 *   3. Decrypt api_key. If decrypt fails, mark window failed.
 *   4. Call runFireflyWindowBackfill with the window's date range +
 *      last_skip resume cursor.
 *   5. Update window with new last_skip + counters. On rate-limit-pause,
 *      defer to next UTC midnight. On completed, stamp completed_at. On
 *      terminal failure, stamp completed_at AND last_error. Always clear
 *      lock_expires_at on exit so the next tick can re-pick if applicable.
 *   6. If no pickable window remains AND no window is waiting for a future
 *      earliest_run_at, finalize the parent.
 */
export async function driveFireflyProgressiveBackfill(
  orgId: string,
  userId: string,
  env: Env
): Promise<{ advanced: boolean; window_index?: number; status?: string; note?: string }> {
  const parent = await env.D1.prepare(
    `SELECT id, api_key_encrypted, total_windows
       FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string; api_key_encrypted: string; total_windows: number }>();
  if (!parent) return { advanced: false, note: 'no active firefly parent' };

  // Phase 3.4 (2026-05-04) pre-gate: refuse the tick when the
  // upstream_budget_ledger says this user is at cap or the circuit is
  // open. Earlier than the claim so we don't even take a row lock when
  // we know the work would be wasted. Per-window earliest_run_at
  // deferral (the existing reactive path on line ~561+) is what bumps
  // individual windows past UTC midnight on observed rate-limit; this
  // pre-gate is the proactive layer that short-circuits all further
  // attempts for this user during a circuit-open window. While circuit
  // is open (30 min), each tick costs 2 D1 reads (parent SELECT + budget
  // SELECT) and exits fast — bounded waste, self-healing.
  const budget = await checkBudget(env, orgId, userId, 'firefly', 'daily');
  if (budget.decision !== 'ok') {
    return {
      advanced: false,
      note: `firefly ${budget.decision} for user ${userId} (used=${budget.used}/${budget.cap}${
        budget.circuit_open_until ? `, circuit_open_until=${budget.circuit_open_until}` : ''
      })`,
    };
  }

  // Atomic claim. lockUntil = now+5min. The UPDATE ... RETURNING returns
  // the claimed row only if it was previously unclaimed (lock expired or
  // null) AND eligible (earliest_run_at <= now). Two simultaneous ticks
  // can't both claim — SQLite's UPDATE is row-locked.
  const nowIso = new Date().toISOString();
  const lockUntilIso = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
  const claimed = await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_windows
        SET lock_expires_at = ?,
            status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
            started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE id = (
        SELECT id FROM firefly_progressive_backfill_windows
         WHERE parent_id = ?
           AND status IN ('pending','in_progress')
           AND (earliest_run_at IS NULL OR earliest_run_at <= ?)
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)
         ORDER BY window_index ASC LIMIT 1
      )
      RETURNING id, window_index, start_date, end_date, status, last_skip`
  ).bind(lockUntilIso, parent.id, nowIso, nowIso).first<{
    id: string; window_index: number; start_date: string; end_date: string;
    status: string; last_skip: number;
  }>();

  if (!claimed) {
    // No pickable window. If there's a window waiting for a future day,
    // stay 'active' and let the next cron tick try again. Otherwise
    // finalize the parent (api_key nuked, status partially_completed if
    // any windows failed, else completed).
    const futureWindow = await env.D1.prepare(
      `SELECT 1 FROM firefly_progressive_backfill_windows
         WHERE parent_id = ?
           AND status IN ('pending','in_progress')
           AND earliest_run_at IS NOT NULL
           AND earliest_run_at > ?
         LIMIT 1`
    ).bind(parent.id, nowIso).first();
    if (futureWindow) {
      return { advanced: false, note: 'all today\'s windows done; future windows scheduled for later UTC days' };
    }
    const finalStatus = await finalizeParent(parent.id, env);
    return { advanced: false, note: `firefly parent ${finalStatus}` };
  }

  const win = claimed;

  // Phase 4 (2026-05-04): two-tier API key resolution.
  //   1. Primary: user_firefly_credentials (persistent, set once via
  //      Settings UI / POST /api/settings/firefly-credentials). The
  //      "set once, reuse forever" UX.
  //   2. Fallback: parent.api_key_encrypted (legacy per-job storage
  //      from before Phase 4). Empty-string '' is the Phase-4
  //      placeholder for new jobs that rely on persistent only — the
  //      decrypt path is skipped in that case. Once any pre-Phase-4
  //      in-flight backfills drain, this fallback becomes dead code.
  //
  // Either source produces a usable plaintext key. If both fail, the
  // window is marked failed with a descriptive error so the operator
  // can prompt the user to (re)set credentials.
  let apiKey: string | null = null;

  // Primary: persistent credential.
  try {
    apiKey = await getFireflyKey(userId, env);
  } catch (e) {
    console.error('[firefly-driver] persistent key fetch error:', e instanceof Error ? e.message : e);
  }

  // Fallback: legacy per-job key. Skipped when api_key_encrypted is ''
  // (Phase 4 placeholder for new jobs that rely on persistent only) or
  // null. The decrypt path mirrors the prior implementation exactly so
  // pre-Phase-4 jobs continue to drain without regression.
  if (!apiKey && parent.api_key_encrypted && parent.api_key_encrypted.length > 0) {
    try {
      const decrypted = await decryptToken(parent.api_key_encrypted, env);
      apiKey = decrypted.api_key || null;
    } catch (e) {
      console.error('[firefly-driver] legacy per-job decrypt failed:', e instanceof Error ? e.message : e);
      // Don't return yet — the persistent path may have surfaced a key
      // (race), or operator may set fresh credentials before we hit the
      // !apiKey check below.
    }
  }

  if (!apiKey) {
    const msg = 'no firefly key (persistent credential missing or decrypt-failed; legacy per-job key unavailable). User must set Firefly credentials.';
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'failed', last_error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              lock_expires_at = NULL
        WHERE id = ?`
    ).bind(msg, win.id).run();
    return { advanced: true, window_index: win.window_index, status: 'failed', note: msg };
  }

  // Phase 3.4.1 (2026-05-04): per-tick API call accounting moved from
  // pre-call (used to be HERE) to post-confirmed-success (in the
  // 'completed' branch below). The pre-call recordUsage was hardcoded
  // to reset `consecutive_429s = 0` every tick (per upstream-budget.ts
  // "success ALWAYS resets the breaker counter" semantic), which made
  // the CIRCUIT_TRIP_THRESHOLD = 3 structurally unreachable for
  // sequential workloads like Firefly's per-tick driver: each
  // rate-limited tick could only ever bump consecutive_429s to 1
  // before the next tick reset it back to 0. Auto-tune-down was dead
  // code; the pre-gate's circuit_open branch never fired. Terminal 5
  // forensic 2026-05-04 confirmed the gap. Moving the call to post-
  // success means: only confirmed Firefly successes reset the breaker
  // counter; 3 consecutive rate-limited ticks (no successes between)
  // can now trip the breaker, which is the documented contract.

  let result;
  try {
    result = await runFireflyWindowBackfill(
      {
        userId,
        orgId,
        fireflyApiKey: apiKey,
        startDate: win.start_date,
        endDate: win.end_date,
        initialSkip: win.last_skip ?? 0,
        progressiveWindowId: win.id,
      },
      env
    );
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'failed', last_error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              lock_expires_at = NULL
        WHERE id = ?`
    ).bind(msg, win.id).run();
    return { advanced: true, window_index: win.window_index, status: 'failed', note: msg };
  }

  if (result.status === 'completed') {
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'completed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              last_skip = ?,
              transcripts_fetched = transcripts_fetched + ?,
              transcripts_persisted = transcripts_persisted + ?,
              transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
              transcripts_failed = transcripts_failed + ?,
              last_error = ?,
              lock_expires_at = NULL
        WHERE id = ?`
    ).bind(
      result.last_skip,
      result.total_fetched,
      result.ingested,
      result.duplicates,
      result.failed,
      result.errors && result.errors.length > 0
        ? `${result.errors.length} per-transcript errors (see sync_jobs.metadata.errors_sample)`
        : null,
      win.id
    ).run();

    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_jobs
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(parent.id).run();

    // Phase 3.4.1: post-success dual-write to firefly_user_quotas +
    // upstream_budget_ledger. Fires ONLY on confirmed window completion
    // so recordUsage's hardcoded `consecutive_429s = 0` reset doesn't
    // pre-empt the breaker counter accumulation. 'failed' and 'paused'
    // status branches deliberately do NOT call this — preserves correct
    // breaker semantic where only successful ticks reset the counter.
    await recordFireflyApiCall(userId, env, false, orgId);

    return { advanced: true, window_index: win.window_index, status: 'completed' };
  }

  if (result.status === 'failed') {
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'failed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              last_skip = ?,
              transcripts_fetched = transcripts_fetched + ?,
              transcripts_persisted = transcripts_persisted + ?,
              transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
              transcripts_failed = transcripts_failed + ?,
              last_error = ?,
              lock_expires_at = NULL
        WHERE id = ?`
    ).bind(
      result.last_skip,
      result.total_fetched,
      result.ingested,
      result.duplicates,
      result.failed,
      result.reason || 'window failed',
      win.id
    ).run();
    return { advanced: true, window_index: win.window_index, status: 'failed', note: result.reason };
  }

  // Paused — keep status='in_progress' so a future tick can resume.
  // If the pause was caused by the Fireflies daily quota
  // (FIREFLY_RATE_LIMITED → 'firefly_rate_limit' reason), defer to next
  // UTC midnight via earliest_run_at — the daily quota resets there per
  // the observed "Please retry after Fri, 01 May 2026 00:00:01 GMT (UTC)"
  // response. Other pause reasons (wallclock_cap, transcript_count_cap)
  // mean the Worker hit its per-tick budget and the next minute's cron
  // tick should resume immediately, so leave earliest_run_at unchanged.
  // ALWAYS clear lock_expires_at so the next eligible tick can re-claim.
  const isRateLimitPause =
    result.reason === 'firefly_rate_limit' ||
    /rate.?limit/i.test(result.reason || '');
  const newEarliestRunAt = isRateLimitPause ? nextUtcMidnightIso() : null;

  if (isRateLimitPause) {
    // Phase 3.4: dual-write the rate-limit signal to firefly_user_quotas
    // AND upstream_budget_ledger. Three consecutive rate-limit ticks for
    // a user → ledger trips circuit (cap −10%, 30-min cooldown), and the
    // pre-gate above will short-circuit subsequent ticks until circuit
    // closes or UTC midnight whichever comes first.
    await recordFireflyApiCall(userId, env, true, orgId);
  }

  await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_windows
        SET last_skip = ?,
            transcripts_fetched = transcripts_fetched + ?,
            transcripts_persisted = transcripts_persisted + ?,
            transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
            transcripts_failed = transcripts_failed + ?,
            lock_expires_at = NULL,
            earliest_run_at = COALESCE(?, earliest_run_at)
      WHERE id = ?`
  ).bind(
    result.last_skip,
    result.total_fetched,
    result.ingested,
    result.duplicates,
    result.failed,
    newEarliestRunAt,
    win.id
  ).run();

  await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_jobs
        SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(parent.id).run();

  return {
    advanced: true,
    window_index: win.window_index,
    status: result.status,
    note: isRateLimitPause
      ? `rate-limited; deferred to ${newEarliestRunAt}`
      : `paused at skip=${result.last_skip} (${result.reason || 'budget cap'})`,
  };
}

/**
 * Driver entry point for the cron — finds every active parent for an
 * org and advances each one SEQUENTIALLY. Mirrors
 * driveAllActiveProgressive in progressive-backfill.ts. Sequential
 * rather than parallel because Workers AI BGE has a per-org rate limit
 * (10 RPS) and the embedding step inside processTranscriptItems is the
 * dominant cost.
 */
export async function driveAllActiveFireflyProgressive(orgId: string, env: Env): Promise<void> {
  const ordered = await env.D1.prepare(
    `SELECT user_id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND status = 'active'
       ORDER BY updated_at ASC`
  ).bind(orgId).all<{ user_id: string }>();
  if (ordered.results.length === 0) return;

  for (const r of ordered.results) {
    try {
      await driveFireflyProgressiveBackfill(orgId, r.user_id, env);
    } catch (e) {
      console.error(`firefly progressive backfill drive failed for ${r.user_id}:`, e);
    }
  }
}

/** Per-user status: parent + all windows. Mirrors getProgressiveStatus. */
export async function getFireflyProgressiveStatus(
  orgId: string,
  userId: string,
  env: Env
): Promise<{ parent: FireflyProgressiveBackfillJob | null; windows: FireflyProgressiveBackfillWindow[] }> {
  const parent = await env.D1.prepare(
    `SELECT * FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(orgId, userId).first<FireflyProgressiveBackfillJob>();

  if (!parent) return { parent: null, windows: [] };

  const windows = await env.D1.prepare(
    `SELECT * FROM firefly_progressive_backfill_windows
       WHERE parent_id = ?
       ORDER BY window_index ASC`
  ).bind(parent.id).all<FireflyProgressiveBackfillWindow>();

  return { parent, windows: windows.results };
}

/** Org-wide list. Mirrors listProgressiveBackfills. */
export async function listFireflyProgressiveBackfills(
  orgId: string,
  env: Env
): Promise<Array<{
  parent: FireflyProgressiveBackfillJob;
  user_email: string | null;
  windows: FireflyProgressiveBackfillWindow[];
}>> {
  const parents = await env.D1.prepare(
    `SELECT * FROM firefly_progressive_backfill_jobs
       WHERE org_id = ?
       ORDER BY status ASC, created_at DESC LIMIT 20`
  ).bind(orgId).all<FireflyProgressiveBackfillJob>();

  const out: Array<{
    parent: FireflyProgressiveBackfillJob;
    user_email: string | null;
    windows: FireflyProgressiveBackfillWindow[];
  }> = [];
  for (const p of parents.results) {
    const u = await env.D1.prepare(`SELECT email FROM users WHERE id = ?`)
      .bind(p.user_id).first<{ email: string }>();
    const w = await env.D1.prepare(
      `SELECT * FROM firefly_progressive_backfill_windows
         WHERE parent_id = ? ORDER BY window_index ASC`
    ).bind(p.id).all<FireflyProgressiveBackfillWindow>();
    out.push({ parent: p, user_email: u?.email ?? null, windows: w.results });
  }
  return out;
}

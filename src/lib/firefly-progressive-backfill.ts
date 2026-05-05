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
export function nextUtcMidnightIso(): string {
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
export async function recordFireflyApiCall(
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

// ─── Phase 6.2 1a: dual-write helper ──────────────────────────────────────

/**
 * Phase 6.2 1a (2026-05-05): write each window descriptor into work_queue
 * (domain='firefly_window') alongside the legacy
 * firefly_progressive_backfill_windows INSERT. During 1a the legacy
 * driver is the authoritative drain — work_queue rows accumulate but
 * aren't claimed because the firefly_window handler isn't registered
 * in WORK_QUEUE_HANDLERS yet. 1b registers it, runs migration 0086
 * (reconciles any drift between the two tables), and strips the legacy
 * pick-and-sync.
 *
 * Idempotency_key = `${parent_id}:${window_index}` — domain context is
 * already in the partial UNIQUE on (domain, idempotency_key) per Phase
 * 5's substrate. Re-creating a parent (rare; normally blocked by the
 * "already active" check) would collide cleanly. The (parent_id,
 * window_index) tuple mirrors the legacy table's own UNIQUE constraint.
 *
 * Upstream tag = 'firefly_api' so the driver's claimNextBatch
 * automatically defers all firefly_window claims when Phase 3.4.1's
 * breaker trips.
 *
 * next_attempt_at = earliest_run_at when set; null otherwise. Matches
 * the legacy table's gating semantics (Phase 4's multi-day spreading).
 *
 * Best-effort: errors logged but don't throw. If a row fails to land
 * here, migration 0086 in 1b INSERT-OR-IGNOREs every legacy row whose
 * (parent_id, window_index) doesn't already exist in work_queue. So a
 * dual-write failure in 1a is recoverable, not lossy.
 */
async function dualWriteFireflyWindowsToWorkQueue(
  env: Env,
  parentId: string,
  orgId: string,
  userId: string,
  windows: Array<{
    window_index: number;
    start_date: string;
    end_date: string;
    earliest_run_at: string | null;
  }>
): Promise<void> {
  const { enqueueWork } = await import('./work-queue');
  for (const w of windows) {
    try {
      await enqueueWork(env, orgId, 'firefly_window',
        {
          parent_id: parentId,
          user_id: userId,
          window_index: w.window_index,
          start_date: w.start_date,
          end_date: w.end_date,
          last_skip: 0,
          transcripts_fetched: 0,
          transcripts_persisted: 0,
          transcripts_skipped_duplicate: 0,
          transcripts_failed: 0,
        },
        {
          upstream: 'firefly_api',
          idempotency_key: `${parentId}:${w.window_index}`,
          next_attempt_at: w.earliest_run_at,
        }
      );
    } catch (e) {
      console.error(
        `[firefly-progressive] dual-write to work_queue failed parent=${parentId} window_index=${w.window_index}:`,
        e instanceof Error ? e.message : e
      );
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
  // Phase 6.2 1a (2026-05-05): collect window descriptors so we can
  // dual-write into work_queue (domain='firefly_window') after the
  // legacy batch lands. 1a's dual-write keeps the legacy driver as
  // the authoritative drain — work_queue rows accumulate but are NOT
  // claimed (handler unregistered until 1b). 1b registers the handler,
  // strips the legacy pick-and-sync, and reconciles via migration 0086.
  const windowDescriptors: Array<{
    window_index: number;
    start_date: string;
    end_date: string;
    earliest_run_at: string | null;
  }> = [];
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
    windowDescriptors.push({ window_index: i, start_date: start, end_date: end, earliest_run_at: earliestRunAt });
  }
  await env.D1.batch(stmts);

  // Phase 6.2 1a (2026-05-05): dual-write into work_queue. Best-effort —
  // failures here don't block parent creation. Migration 0086 (1b) will
  // reconcile any windows the dual-write missed by INSERT-OR-IGNOREing
  // every legacy row whose corresponding work_queue row doesn't already
  // exist. So a failed dual-write is recoverable, not lossy.
  await dualWriteFireflyWindowsToWorkQueue(env, parentId, orgId, userId, windowDescriptors);

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
  // Phase 6.2 1a (2026-05-05): see sibling createFireflyProgressiveBackfill
  // for full rationale on the dual-write pattern.
  const windowDescriptors: Array<{
    window_index: number;
    start_date: string;
    end_date: string;
    earliest_run_at: string | null;
  }> = [];
  for (let i = 0; i < totalWindows; i++) {
    const winEndMs = endMs - i * windowSizeDays * 86400000;
    const winStartMs = Math.max(startMs, endMs - (i + 1) * windowSizeDays * 86400000);
    const scheduledForDay = Math.floor(i / WINDOWS_PER_DAY);
    const earliestRunAt = scheduledForDay === 0
      ? null
      : new Date(nowMs + scheduledForDay * 86400000).toISOString();
    const winStartIso = new Date(winStartMs).toISOString();
    const winEndIso = new Date(winEndMs).toISOString();
    stmts.push(
      env.D1.prepare(
        `INSERT INTO firefly_progressive_backfill_windows
           (parent_id, window_index, start_date, end_date, status, scheduled_for_day, earliest_run_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(parentId, i, winStartIso, winEndIso, scheduledForDay, earliestRunAt)
    );
    windowDescriptors.push({
      window_index: i, start_date: winStartIso, end_date: winEndIso, earliest_run_at: earliestRunAt,
    });
  }
  await env.D1.batch(stmts);

  await dualWriteFireflyWindowsToWorkQueue(env, parentId, orgId, userId, windowDescriptors);

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
  // Phase 6.2 1b (2026-05-05): count failed windows from work_queue
  // (dead_letter status) instead of legacy table. The handler dual-
  // writes the legacy 'failed' status for UI continuity, so either
  // source would work — but work_queue is the authoritative state
  // post-cutover. Counting from work_queue keeps the data flow
  // consistent: handler-side updates → work_queue → finalization.
  const counts = await env.D1.prepare(
    `SELECT
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'completed'   THEN 1 ELSE 0 END) AS completed
       FROM work_queue
      WHERE domain = 'firefly_window'
        AND json_extract(payload, '$.parent_id') = ?`
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
  // Phase 6.2 1b (2026-05-05): the inline pick-and-sync loop has been
  // replaced by the firefly_window handler running on Phase 5's
  // minute-tick driver (src/lib/work-queue-handlers/firefly-window.ts).
  // This function is now a thin parent-status monitor + finalizer:
  //   1. Find the user's active parent (legacy table; canonical
  //      orchestration journal post-Phase-6.2)
  //   2. Count remaining work_queue rows for this parent
  //   3. If zero → finalize parent (api_key nuke + status transition)
  //   4. Otherwise → no-op for this parent, handler picks up next tick
  //
  // The legacy claim/dispatch/result-handling flow (~290 lines) has
  // been deleted — all of it now lives in the handler. Token resolution,
  // runFireflyWindowBackfill, recordFireflyApiCall (Phase 3.4.1
  // post-success-gated), deferWork (Phase 6.2 1a primitive for paused-
  // state checkpoint-resume) — all handler-side. This driver no longer
  // consumes Firefly subreqs or touches user_firefly_credentials.
  //
  // Return shape preserved for driveAllActiveFireflyProgressive's
  // logging path. `advanced` is now always false (this driver doesn't
  // process windows; the handler does).
  const parent = await env.D1.prepare(
    `SELECT id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (!parent) return { advanced: false, note: 'no active firefly parent' };

  // Count remaining work_queue rows for this parent. Pending +
  // in_progress are both "still has work to do." Paused windows are
  // status='pending' (via deferWork) so they count here. dead_letter
  // and completed don't count — both are terminal.
  const remaining = await env.D1.prepare(
    `SELECT COUNT(*) AS n FROM work_queue
       WHERE domain = 'firefly_window'
         AND status IN ('pending', 'in_progress')
         AND json_extract(payload, '$.parent_id') = ?`
  ).bind(parent.id).first<{ n: number }>();

  if ((remaining?.n ?? 0) > 0) {
    // Work still queued — handler will process next tick(s). No
    // action here; parent stays 'active'.
    return {
      advanced: false,
      note: `${remaining?.n ?? 0} work_queue rows pending for parent ${parent.id}`,
    };
  }

  // No remaining work — finalize. finalizeParent counts work_queue
  // dead_letter rows to decide partially_completed vs completed,
  // nukes api_key_encrypted, transitions parent.status.
  const finalStatus = await finalizeParent(parent.id, env);
  return { advanced: false, note: `firefly parent ${finalStatus}` };
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

  // Phase 6.2 1b (2026-05-05): wire-collapse 'partially_completed' →
  // 'completed' for frontend compatibility. The frontend's response
  // type union (frontend/lib/api.ts) is {'active', 'completed',
  // 'cancelled'}; 'partially_completed' was added in Phase 4 migration
  // 0070 but never landed in production rows. Per-window 'failed'
  // detail remains visible via the windows array, so failure forensics
  // aren't lost — only the parent-level status pill is collapsed.
  //
  // Phase 7c (2026-05-05): refactored from in-place mutation
  // (`parent.status = 'completed'`) to a returned-copy pattern so
  // the deserialized DB row is left untouched. Callers receive a
  // fresh object with the collapsed status field; downstream
  // redaction in handlers/firefly-backfill.ts mutates its own
  // copy, not this one.
  return {
    parent: { ...parent, status: collapseFireflyParentStatus(parent.status) },
    windows: windows.results,
  };
}

/** Phase 7c (2026-05-05): wire-collapse helper. Frontend type union
 *  doesn't include 'partially_completed'; collapse to 'completed' for
 *  shape parity. Per-window detail (windows[].status) preserves
 *  failure forensics. */
function collapseFireflyParentStatus(
  s: FireflyProgressiveBackfillJob['status']
): FireflyProgressiveBackfillJob['status'] {
  return s === 'partially_completed' ? 'completed' : s;
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
    // Phase 6.2 1b + 7c (2026-05-05): wire-collapse via returned copy;
    // see getFireflyProgressiveStatus for full rationale.
    out.push({
      parent: { ...p, status: collapseFireflyParentStatus(p.status) },
      user_email: u?.email ?? null,
      windows: w.results,
    });
  }
  return out;
}

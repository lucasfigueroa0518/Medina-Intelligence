// Progressive historical backfill — splits a long window (e.g. 180 days)
// into N small windows (e.g. 18 × 10 days) and advances them one batch at
// a time across cron ticks. Survives Worker CPU limits, runs entirely
// server-side, no operator presence required.
//
// Each user has at most one active parent job. Multiple users run in
// parallel (different KV keys, different mailboxes). The cron driver
// `driveProgressiveBackfill` is called once per active parent per */2 cron
// tick and advances that user's currently-active window by one paginated
// batch (~25s of fetch + classify + embed work).

import type { Env } from '../types/env';
import { runHistoricalBackfill } from '../integrations/outlook';

export interface ProgressiveBackfillJob {
  id: string;
  org_id: string;
  user_id: string;
  window_size_days: number;
  total_windows: number;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProgressiveBackfillWindow {
  id: string;
  parent_id: string;
  window_index: number;
  start_date: string;
  end_date: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  emails_fetched: number;
  conversations_added: number;
  embedded_count: number;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

async function markProgressiveBackfillFailed(
  env: Env,
  opts: {
    orgId: string;
    userId: string;
    parentId: string;
    windowId: string;
    windowIndex: number;
    message: string;
    startDate?: string | null;
    endDate?: string | null;
    cause?: unknown;
  }
): Promise<void> {
  const message = opts.message.slice(0, 500);
  await env.KV.delete(`backfill_progress:${opts.userId}`).catch(() => undefined);
  await env.D1.prepare(
    `UPDATE progressive_backfill_windows
        SET status = 'failed',
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(message, opts.windowId).run();
  await env.D1.prepare(
    `UPDATE progressive_backfill_jobs
        SET status = 'failed',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'active'`
  ).bind(opts.parentId).run();

  try {
    const { reportIngestionFailure } = await import('./ingestion-health');
    await reportIngestionFailure(env, {
      orgId: opts.orgId,
      source: 'outlook_email',
      scopeType: 'progressive_backfill_window',
      scopeId: opts.windowId,
      code: 'progressive_backfill_terminal_graph_error',
      title: 'Progressive backfill window failed terminally',
      message,
      severity: 'warning',
      humanActionRequired: false,
      metadata: {
        parent_id: opts.parentId,
        user_id: opts.userId,
        window_id: opts.windowId,
        window_index: opts.windowIndex,
        start_date: opts.startDate,
        end_date: opts.endDate,
        cause: opts.cause instanceof Error ? opts.cause.message : opts.cause ? String(opts.cause).slice(0, 500) : null,
      },
    });
  } catch (e) {
    console.error(
      `[progressive-backfill] terminal failure incident report failed for ${opts.windowId}:`,
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Seed a new progressive backfill: parent row + N pending window rows
 * going BACKWARDS in time. Window 0 is the most recent (now-N days → now),
 * window N-1 is the oldest (now-totalDays → now-(totalDays - N)).
 *
 * Refuses if the user already has an `active` parent — one progressive run
 * per user at a time, since they share a single backfill_progress KV key.
 */
export async function createProgressiveBackfill(
  orgId: string,
  userId: string,
  totalDays: number,
  windowSizeDays: number,
  env: Env
): Promise<{ created: boolean; parent_id?: string; reason?: string }> {
  const existing = await env.D1.prepare(
    `SELECT id FROM progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (existing) {
    return { created: false, reason: `User already has active parent ${existing.id}` };
  }

  if (totalDays <= 0 || windowSizeDays <= 0 || windowSizeDays > totalDays) {
    return { created: false, reason: 'invalid totalDays / windowSizeDays' };
  }
  const totalWindows = Math.ceil(totalDays / windowSizeDays);

  const insertedParent = await env.D1.prepare(
    `INSERT INTO progressive_backfill_jobs (org_id, user_id, window_size_days, total_windows, status)
     VALUES (?, ?, ?, ?, 'active')
     RETURNING id`
  ).bind(orgId, userId, windowSizeDays, totalWindows).first<{ id: string }>();
  if (!insertedParent) {
    return { created: false, reason: 'parent insert failed' };
  }
  const parentId = insertedParent.id;

  // Seed N windows going backwards in time. Window i covers
  // [now - (i+1)*windowSizeDays, now - i*windowSizeDays).
  const now = Date.now();
  const stmts = [];
  for (let i = 0; i < totalWindows; i++) {
    const end = new Date(now - i * windowSizeDays * 86400000).toISOString();
    const start = new Date(now - (i + 1) * windowSizeDays * 86400000).toISOString();
    stmts.push(
      env.D1.prepare(
        `INSERT INTO progressive_backfill_windows (parent_id, window_index, start_date, end_date, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).bind(parentId, i, start, end)
    );
  }
  await env.D1.batch(stmts);

  return { created: true, parent_id: parentId };
}

/**
 * Sibling of createProgressiveBackfill for custom date-range mode. Same
 * backward windowing semantics — window 0 is the most recent slice
 * (endDate - windowSizeDays → endDate), window N-1 is the oldest. The
 * only difference is the user provides explicit start/end anchors instead
 * of "totalDays back from now".
 *
 * Reuses the same per-user "one active parent" guard as createProgressiveBackfill.
 */
export async function createProgressiveBackfillRange(
  orgId: string,
  userId: string,
  startDate: string,
  endDate: string,
  windowSizeDays: number,
  env: Env
): Promise<{ created: boolean; parent_id?: string; total_windows?: number; reason?: string }> {
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
  const totalMs = end.getTime() - start.getTime();
  const totalDays = Math.ceil(totalMs / 86400000);
  if (totalDays > 730) {
    return { created: false, reason: 'date range exceeds 730 days' };
  }
  const totalWindows = Math.ceil(totalDays / windowSizeDays);

  const existing = await env.D1.prepare(
    `SELECT id FROM progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (existing) {
    return { created: false, reason: `User already has active parent ${existing.id}` };
  }

  const insertedParent = await env.D1.prepare(
    `INSERT INTO progressive_backfill_jobs (org_id, user_id, window_size_days, total_windows, status)
     VALUES (?, ?, ?, ?, 'active')
     RETURNING id`
  ).bind(orgId, userId, windowSizeDays, totalWindows).first<{ id: string }>();
  if (!insertedParent) {
    return { created: false, reason: 'parent insert failed' };
  }
  const parentId = insertedParent.id;

  // Anchor windows backward from endDate. Window 0 = endDate - windowSizeDays
  // → endDate; window N-1 = startDate (clamped) → startDate + windowSizeDays.
  // Last window's start is clamped to startDate so we never fetch outside the
  // requested range.
  const stmts = [];
  const endMs = end.getTime();
  const startMs = start.getTime();
  for (let i = 0; i < totalWindows; i++) {
    const winEndMs = endMs - i * windowSizeDays * 86400000;
    const winStartMs = Math.max(startMs, endMs - (i + 1) * windowSizeDays * 86400000);
    stmts.push(
      env.D1.prepare(
        `INSERT INTO progressive_backfill_windows (parent_id, window_index, start_date, end_date, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).bind(parentId, i, new Date(winStartMs).toISOString(), new Date(winEndMs).toISOString())
    );
  }
  await env.D1.batch(stmts);

  return { created: true, parent_id: parentId, total_windows: totalWindows };
}

/**
 * Cancel an active backfill. Marks parent='cancelled' (CHECK allows it on the
 * parent table) and any in-progress/pending windows as 'failed' with a
 * cancellation note (CHECK on the windows table doesn't allow 'cancelled'
 * — same constraint we ran into when manually stopping Tony's job).
 *
 * Returns 'not_found' if no active job, 'cancelled' otherwise.
 */
export async function cancelProgressiveBackfill(
  orgId: string,
  userId: string,
  env: Env,
  reason: string = 'cancelled by user'
): Promise<{ ok: boolean; result: 'cancelled' | 'not_found' }> {
  const parent = await env.D1.prepare(
    `SELECT id FROM progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (!parent) return { ok: true, result: 'not_found' };

  await env.D1.prepare(
    `UPDATE progressive_backfill_jobs
        SET status = 'cancelled',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(parent.id).run();

  await env.D1.prepare(
    `UPDATE progressive_backfill_windows
        SET status = 'failed',
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE parent_id = ? AND status IN ('pending','in_progress')`
  ).bind(reason, parent.id).run();

  // Clear KV resume marker so any in-flight cron tick won't rehydrate the
  // backfill_progress on next call. (Defensive — the cron driver also
  // checks parent.status='active' before doing work.)
  await env.KV.delete(`backfill_progress:${userId}`);

  return { ok: true, result: 'cancelled' };
}

/**
 * One cron tick of work for one user: advance their currently-active
 * window by a single paginated batch. Idempotent — safe to call repeatedly.
 *
 * Sequence:
 *   1. Find this user's active parent. If none, return.
 *   2. Find the lowest-indexed window that's still pending or in_progress.
 *      If none, mark parent completed.
 *   3. If the window is pending, clear stale KV from the previous window's
 *      backfill_progress, mark window in_progress, set started_at.
 *   4. Call runHistoricalBackfill with the window's explicit date range.
 *      The function paginates internally; it returns paused after one
 *      batch (or completed when the date range is exhausted).
 *   5. If the call returns completed, count the actual data landed in
 *      conversations (and the subset that's embedded) and stamp the window.
 *      Otherwise leave it as in_progress; the next cron tick continues.
 */
export async function driveProgressiveBackfill(
  orgId: string,
  userId: string,
  env: Env
): Promise<{ advanced: boolean; window_index?: number; status?: string; note?: string }> {
  const parent = await env.D1.prepare(
    `SELECT id, total_windows FROM progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string; total_windows: number }>();
  if (!parent) return { advanced: false, note: 'no active parent' };

  const win = await env.D1.prepare(
    `SELECT id, window_index, start_date, end_date, status
       FROM progressive_backfill_windows
      WHERE parent_id = ? AND status IN ('pending','in_progress')
      ORDER BY window_index ASC LIMIT 1`
  ).bind(parent.id).first<ProgressiveBackfillWindow>();

  if (!win) {
    const failed = await env.D1.prepare(
      `SELECT COUNT(*) AS count
         FROM progressive_backfill_windows
        WHERE parent_id = ? AND status = 'failed'`
    ).bind(parent.id).first<{ count: number }>();
    if ((failed?.count || 0) > 0) {
      await env.KV.delete(`backfill_progress:${userId}`).catch(() => undefined);
      await env.D1.prepare(
        `UPDATE progressive_backfill_jobs
            SET status = 'failed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'active'`
      ).bind(parent.id).run();
      return { advanced: false, status: 'failed', note: 'parent failed due to failed child window' };
    }

    // All windows done — finalize parent.
    await env.D1.prepare(
      `UPDATE progressive_backfill_jobs
          SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(parent.id).run();
    return { advanced: false, note: 'parent completed' };
  }

  // Transition pending → in_progress: clear stale KV from previous window
  // (otherwise runHistoricalBackfill would see a leftover last_page_url
  // and try to resume the wrong range).
  if (win.status === 'pending') {
    await env.KV.delete(`backfill_progress:${userId}`);
    await env.D1.prepare(
      `UPDATE progressive_backfill_windows
          SET status = 'in_progress', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(win.id).run();
  }

  let result;
  try {
    result = await runHistoricalBackfill(userId, orgId, 10, env, {
      start_date: win.start_date,
      end_date: win.end_date,
      progressive_window_id: win.id,
    });
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    await markProgressiveBackfillFailed(env, {
      orgId,
      userId,
      parentId: parent.id,
      windowId: win.id,
      windowIndex: win.window_index,
      startDate: win.start_date,
      endDate: win.end_date,
      message: msg,
      cause: e,
    });
    return { advanced: true, window_index: win.window_index, status: 'failed', note: msg };
  }

  if (result.status === 'failed') {
    const msg = String(result.error || 'progressive backfill failed').slice(0, 500);
    await markProgressiveBackfillFailed(env, {
      orgId,
      userId,
      parentId: parent.id,
      windowId: win.id,
      windowIndex: win.window_index,
      startDate: win.start_date,
      endDate: win.end_date,
      message: msg,
      cause: result.error || result.status,
    });
    return { advanced: true, window_index: win.window_index, status: 'failed', note: msg };
  }

  if (result.status === 'completed') {
    // Window finished — measure what landed in conversations during this
    // date range. Use sent_at (matches Graph receivedDateTime filter, not
    // ingestion created_at) so re-runs across overlapping days don't
    // double-count items that landed in earlier overlapping windows.
    const stats = await env.D1.prepare(
      `SELECT COUNT(*) AS conv,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM vector_entity_index v
                 WHERE v.entity_id = c.id
                   AND v.source_table = 'conversations'
                   AND v.org_id = c.org_id
              ) THEN 1 ELSE 0 END) AS embedded
         FROM conversations c
        WHERE c.org_id = ? AND c.source = 'outlook'
          AND c.sent_at >= ? AND c.sent_at < ?`
    ).bind(orgId, win.start_date, win.end_date).first<{ conv: number; embedded: number }>();

    await env.D1.prepare(
      `UPDATE progressive_backfill_windows
          SET status = 'completed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              emails_fetched = ?,
              conversations_added = ?,
              embedded_count = ?
        WHERE id = ?`
    ).bind(
      result.total_fetched ?? 0,
      stats?.conv ?? 0,
      stats?.embedded ?? 0,
      win.id
    ).run();

    // Touch parent updated_at so dashboards show recent activity.
    await env.D1.prepare(
      `UPDATE progressive_backfill_jobs
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(parent.id).run();

    return { advanced: true, window_index: win.window_index, status: 'completed' };
  }

  // result is paused / in_progress — leave window in_progress; next tick
  // resumes via the KV last_page_url that runHistoricalBackfill stamped.
  return {
    advanced: true,
    window_index: win.window_index,
    status: result.status,
    note: `paused after ${result.total_fetched} fetched`,
  };
}

/** Driver entry point for the cron — finds every active parent for an org
 *  and advances each one SEQUENTIALLY. Different users have different
 *  backfill_progress KV keys so per-user state doesn't contend, but they
 *  share a single per-org Workers AI BGE rate limiter (10 RPS). When two
 *  users run in parallel inside the same cron tick, one consistently
 *  starves the other (audit 2026-04-28: Tony's per-batch progress stalled
 *  while Alvaro's ran clean). Serializing gives each user a clean 25s
 *  window per tick at the cost of half the parallelism — but with two
 *  active users and a 2-minute cron cadence, each user still gets one
 *  batch every 4 minutes, which is fine for the 18-window pace. */
export async function driveAllActiveProgressive(orgId: string, env: Env): Promise<void> {
  const active = await env.D1.prepare(
    `SELECT user_id FROM progressive_backfill_jobs
       WHERE org_id = ? AND status = 'active'`
  ).bind(orgId).all<{ user_id: string }>();
  if (active.results.length === 0) return;

  // Sort so the user with the OLDEST updated_at goes first — naturally
  // gives catch-up priority to whichever user is lagging.
  const ordered = await env.D1.prepare(
    `SELECT user_id FROM progressive_backfill_jobs
       WHERE org_id = ? AND status = 'active'
       ORDER BY updated_at ASC`
  ).bind(orgId).all<{ user_id: string }>();

  for (const r of ordered.results) {
    try {
      await driveProgressiveBackfill(orgId, r.user_id, env);
    } catch (e) {
      console.error(`progressive backfill drive failed for ${r.user_id}:`, e);
    }
  }
}

/** Per-user status: parent + all 18 windows with stats. */
export async function getProgressiveStatus(
  orgId: string,
  userId: string,
  env: Env
): Promise<{ parent: ProgressiveBackfillJob | null; windows: ProgressiveBackfillWindow[] }> {
  const parent = await env.D1.prepare(
    `SELECT * FROM progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(orgId, userId).first<ProgressiveBackfillJob>();

  if (!parent) return { parent: null, windows: [] };

  const windows = await env.D1.prepare(
    `SELECT * FROM progressive_backfill_windows
       WHERE parent_id = ?
       ORDER BY window_index ASC`
  ).bind(parent.id).all<ProgressiveBackfillWindow>();

  return { parent, windows: windows.results };
}

/** Org-wide list (Tony + Alvaro side-by-side). */
export async function listProgressiveBackfills(
  orgId: string,
  env: Env
): Promise<Array<{ parent: ProgressiveBackfillJob; user_email: string | null; windows: ProgressiveBackfillWindow[] }>> {
  const parents = await env.D1.prepare(
    `SELECT * FROM progressive_backfill_jobs
       WHERE org_id = ?
       ORDER BY status ASC, created_at DESC LIMIT 20`
  ).bind(orgId).all<ProgressiveBackfillJob>();

  const out: Array<{ parent: ProgressiveBackfillJob; user_email: string | null; windows: ProgressiveBackfillWindow[] }> = [];
  for (const p of parents.results) {
    const u = await env.D1.prepare(`SELECT email FROM users WHERE id = ?`)
      .bind(p.user_id).first<{ email: string }>();
    const w = await env.D1.prepare(
      `SELECT * FROM progressive_backfill_windows WHERE parent_id = ? ORDER BY window_index ASC`
    ).bind(p.id).all<ProgressiveBackfillWindow>();
    out.push({ parent: p, user_email: u?.email ?? null, windows: w.results });
  }
  return out;
}

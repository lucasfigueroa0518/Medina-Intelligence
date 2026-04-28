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
  status: 'active' | 'completed' | 'cancelled';
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
    });
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    await env.D1.prepare(
      `UPDATE progressive_backfill_windows
          SET status = 'failed', last_error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(msg, win.id).run();
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
 *  and advances each in parallel. Different users have different
 *  backfill_progress KV keys so they don't contend. */
export async function driveAllActiveProgressive(orgId: string, env: Env): Promise<void> {
  const active = await env.D1.prepare(
    `SELECT user_id FROM progressive_backfill_jobs
       WHERE org_id = ? AND status = 'active'`
  ).bind(orgId).all<{ user_id: string }>();
  if (active.results.length === 0) return;

  await Promise.allSettled(
    active.results.map(r => driveProgressiveBackfill(orgId, r.user_id, env))
  );
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

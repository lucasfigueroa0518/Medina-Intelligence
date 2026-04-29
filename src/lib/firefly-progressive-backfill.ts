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

export interface FireflyProgressiveBackfillJob {
  id: string;
  org_id: string;
  user_id: string;
  api_key_encrypted: string;
  window_size_days: number;
  total_windows: number;
  status: 'active' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
}

/**
 * Seed a new Firefly progressive backfill: encrypt the API key, INSERT
 * parent + N pending windows going BACKWARDS in time. Window 0 is the
 * most recent slice (now-windowSizeDays → now), window N-1 is the
 * oldest. Refuses if the user has any other active parent (same
 * one-active-at-a-time invariant Outlook uses).
 */
export async function createFireflyProgressiveBackfill(
  orgId: string,
  userId: string,
  totalDays: number,
  windowSizeDays: number,
  fireflyApiKey: string,
  env: Env
): Promise<{ created: boolean; parent_id?: string; total_windows?: number; reason?: string }> {
  if (totalDays <= 0 || windowSizeDays <= 0 || windowSizeDays > totalDays) {
    return { created: false, reason: 'invalid totalDays / windowSizeDays' };
  }
  if (!fireflyApiKey || fireflyApiKey.trim().length === 0) {
    return { created: false, reason: 'firefly_api_key required' };
  }

  const existing = await env.D1.prepare(
    `SELECT id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (existing) {
    return { created: false, reason: `User already has active firefly parent ${existing.id}` };
  }

  const totalWindows = Math.ceil(totalDays / windowSizeDays);
  const apiKeyEncrypted = await encryptToken({ api_key: fireflyApiKey.trim() }, env);

  const insertedParent = await env.D1.prepare(
    `INSERT INTO firefly_progressive_backfill_jobs
       (org_id, user_id, api_key_encrypted, window_size_days, total_windows, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     RETURNING id`
  ).bind(orgId, userId, apiKeyEncrypted, windowSizeDays, totalWindows).first<{ id: string }>();
  if (!insertedParent) {
    return { created: false, reason: 'parent insert failed' };
  }
  const parentId = insertedParent.id;

  // Newest-first windows anchored on `now`. Window i covers
  // [now - (i+1)*windowSizeDays, now - i*windowSizeDays).
  const now = Date.now();
  const stmts = [];
  for (let i = 0; i < totalWindows; i++) {
    const end = new Date(now - i * windowSizeDays * 86400000).toISOString();
    const start = new Date(now - (i + 1) * windowSizeDays * 86400000).toISOString();
    stmts.push(
      env.D1.prepare(
        `INSERT INTO firefly_progressive_backfill_windows
           (parent_id, window_index, start_date, end_date, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).bind(parentId, i, start, end)
    );
  }
  await env.D1.batch(stmts);

  return { created: true, parent_id: parentId, total_windows: totalWindows };
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
  fireflyApiKey: string,
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
  if (!fireflyApiKey || fireflyApiKey.trim().length === 0) {
    return { created: false, reason: 'firefly_api_key required' };
  }
  const totalDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);
  if (totalDays > 730) {
    return { created: false, reason: 'date range exceeds 730 days' };
  }
  const totalWindows = Math.ceil(totalDays / windowSizeDays);

  const existing = await env.D1.prepare(
    `SELECT id FROM firefly_progressive_backfill_jobs
       WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`
  ).bind(orgId, userId).first<{ id: string }>();
  if (existing) {
    return { created: false, reason: `User already has active firefly parent ${existing.id}` };
  }

  const apiKeyEncrypted = await encryptToken({ api_key: fireflyApiKey.trim() }, env);

  const insertedParent = await env.D1.prepare(
    `INSERT INTO firefly_progressive_backfill_jobs
       (org_id, user_id, api_key_encrypted, window_size_days, total_windows, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     RETURNING id`
  ).bind(orgId, userId, apiKeyEncrypted, windowSizeDays, totalWindows).first<{ id: string }>();
  if (!insertedParent) {
    return { created: false, reason: 'parent insert failed' };
  }
  const parentId = insertedParent.id;

  const stmts = [];
  const endMs = end.getTime();
  const startMs = start.getTime();
  for (let i = 0; i < totalWindows; i++) {
    const winEndMs = endMs - i * windowSizeDays * 86400000;
    const winStartMs = Math.max(startMs, endMs - (i + 1) * windowSizeDays * 86400000);
    stmts.push(
      env.D1.prepare(
        `INSERT INTO firefly_progressive_backfill_windows
           (parent_id, window_index, start_date, end_date, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).bind(parentId, i, new Date(winStartMs).toISOString(), new Date(winEndMs).toISOString())
    );
  }
  await env.D1.batch(stmts);

  return { created: true, parent_id: parentId, total_windows: totalWindows };
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
 * One cron tick of work for one user: advance their currently-active
 * window by a single paginated batch. Idempotent — safe to call repeatedly.
 *
 * Sequence (mirrors driveProgressiveBackfill in progressive-backfill.ts):
 *   1. Find this user's active parent. If none, return.
 *   2. Find the lowest-indexed window that's still pending or in_progress.
 *      If none, mark parent completed AND nuke api_key_encrypted.
 *   3. Decrypt api_key. If decrypt fails (key was nuked or corrupted),
 *      mark window failed with a clear error.
 *   4. If window is pending, transition to in_progress.
 *   5. Call runFireflyWindowBackfill with the window's date range and
 *      last_skip resume cursor. Cron tick is wall-clock-bounded
 *      internally (FIREFLY_MAX_RUNTIME_MS = 25s).
 *   6. Update window with new last_skip + counters. If returned
 *      'completed', stamp completed_at. Otherwise leave as in_progress.
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

  const win = await env.D1.prepare(
    `SELECT id, window_index, start_date, end_date, status, last_skip
       FROM firefly_progressive_backfill_windows
      WHERE parent_id = ? AND status IN ('pending','in_progress')
      ORDER BY window_index ASC LIMIT 1`
  ).bind(parent.id).first<{
    id: string; window_index: number; start_date: string; end_date: string;
    status: string; last_skip: number;
  }>();

  if (!win) {
    // All windows done — finalize parent + nuke api_key.
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_jobs
          SET status = 'completed',
              api_key_encrypted = '',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(parent.id).run();
    return { advanced: false, note: 'firefly parent completed' };
  }

  if (!parent.api_key_encrypted) {
    // Already nuked. Should never happen for an active parent — if it
    // does, the parent should have been moved to completed/cancelled,
    // not left active. Mark window failed and surface so an operator
    // can notice the inconsistency.
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'failed',
              last_error = 'api_key_encrypted is empty; parent may be in inconsistent state',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(win.id).run();
    return { advanced: true, window_index: win.window_index, status: 'failed', note: 'empty api_key' };
  }

  let apiKey: string;
  try {
    const decrypted = await decryptToken(parent.api_key_encrypted, env);
    apiKey = decrypted.api_key;
    if (!apiKey) throw new Error('decrypted payload missing api_key field');
  } catch (e: any) {
    const msg = `decrypt failed: ${String(e?.message || e).slice(0, 200)}`;
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'failed', last_error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(msg, win.id).run();
    return { advanced: true, window_index: win.window_index, status: 'failed', note: msg };
  }

  if (win.status === 'pending') {
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET status = 'in_progress', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(win.id).run();
  }

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
          SET status = 'failed', last_error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
              last_error = ?
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
              last_error = ?
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

  // Paused — leave window as in_progress for next tick. Persist updated
  // last_skip so the resume cursor advances.
  await env.D1.prepare(
    `UPDATE firefly_progressive_backfill_windows
        SET last_skip = ?,
            transcripts_fetched = transcripts_fetched + ?,
            transcripts_persisted = transcripts_persisted + ?,
            transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
            transcripts_failed = transcripts_failed + ?
      WHERE id = ?`
  ).bind(
    result.last_skip,
    result.total_fetched,
    result.ingested,
    result.duplicates,
    result.failed,
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
    note: `paused at skip=${result.last_skip} (${result.reason || 'budget cap'})`,
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

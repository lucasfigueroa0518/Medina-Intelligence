// User-facing progressive backfill endpoints. Wraps the existing
// createProgressiveBackfill / getProgressiveStatus / cancelProgressiveBackfill
// helpers in src/lib/progressive-backfill.ts. Members can backfill
// themselves; owners can backfill any user in their org. Per-org cap
// of 3 concurrent active jobs (returns 429 when exceeded) keeps the
// shared BGE / Graph rate limiters from being trampled.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';
import {
  createProgressiveBackfill,
  createProgressiveBackfillRange,
  cancelProgressiveBackfill,
  getProgressiveStatus,
} from '../lib/progressive-backfill';

const ALLOWED_DAYS_BACK = [30, 60, 90, 180] as const;
// Hard-coded by product decision — never user-tunable. The cron tick budget
// and BGE/Graph rate limiters are calibrated to a 10-day batch; varying it
// would break the per-tick fetch headroom.
const WINDOW_SIZE_DAYS = 10;
const MAX_ACTIVE_PER_ORG = 3;
export const DEFAULT_ONBOARDING_BACKFILL_DAYS = 90;

interface StartBody {
  user_id?: string;
  days_back?: number;
  start_date?: string;
  end_date?: string;
}

/**
 * POST /api/backfill/start
 *
 * Body:  { days_back: 30 | 90 | 365 } | { start_date, end_date }
 *        plus optional { user_id, window_size_days }
 *
 * Authorization:
 *   - members: must omit user_id (or pass own). 403 if user_id != ctx.userId.
 *   - owners: may pass any user_id in their org.
 *
 * Concurrency:
 *   - 429 if MAX_ACTIVE_PER_ORG already running in org.
 *   - 409 if THIS user already has an active parent.
 */
export async function startBackfill(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = (await parseJsonBody<StartBody>(request)) || {};

  const targetUserId = body.user_id || ctx.userId;
  if (targetUserId !== ctx.userId && ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Members can only backfill themselves.');
  }

  const targetUser = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(targetUserId, ctx.orgId).first<{ id: string }>();
  if (!targetUser) {
    return errorResponse('USER_NOT_FOUND', 404, 'User not in your org.');
  }

  const hasDateRange = !!(body.start_date || body.end_date);
  const hasDaysBack = body.days_back !== undefined;
  if (hasDateRange && hasDaysBack) {
    return errorResponse('VALIDATION_ERROR', 400, 'Provide either days_back OR (start_date,end_date), not both.');
  }
  if (!hasDateRange && !hasDaysBack) {
    return errorResponse('VALIDATION_ERROR', 400, 'Provide days_back or (start_date,end_date).');
  }

  const activeCount = await env.D1.prepare(
    `SELECT COUNT(*) AS n FROM progressive_backfill_jobs
       WHERE org_id = ? AND status = 'active'`
  ).bind(ctx.orgId).first<{ n: number }>();
  if ((activeCount?.n ?? 0) >= MAX_ACTIVE_PER_ORG) {
    return errorResponse(
      'CONCURRENCY_LIMIT',
      429,
      `Org already has ${activeCount?.n} active backfills (max ${MAX_ACTIVE_PER_ORG}). Wait for one to finish or cancel it.`
    );
  }

  if (hasDaysBack) {
    if (!ALLOWED_DAYS_BACK.includes(body.days_back as (typeof ALLOWED_DAYS_BACK)[number])) {
      return errorResponse(
        'VALIDATION_ERROR',
        400,
        `days_back must be one of: ${ALLOWED_DAYS_BACK.join(', ')}`
      );
    }
    const result = await createProgressiveBackfill(
      ctx.orgId,
      targetUserId,
      body.days_back!,
      WINDOW_SIZE_DAYS,
      env
    );
    if (!result.created) {
      return errorResponse('PROGRESSIVE_BACKFILL_BLOCKED', 409, result.reason || 'cannot create');
    }
    return jsonResponse({
      ok: true,
      parent_id: result.parent_id,
      mode: 'days_back',
      days_back: body.days_back,
      window_size_days: WINDOW_SIZE_DAYS,
      total_windows: Math.ceil(body.days_back! / WINDOW_SIZE_DAYS),
    });
  }

  // Date-range mode
  if (!body.start_date || !body.end_date) {
    return errorResponse('VALIDATION_ERROR', 400, 'Both start_date and end_date are required.');
  }
  const result = await createProgressiveBackfillRange(
    ctx.orgId,
    targetUserId,
    body.start_date,
    body.end_date,
    WINDOW_SIZE_DAYS,
    env
  );
  if (!result.created) {
    return errorResponse('PROGRESSIVE_BACKFILL_BLOCKED', 409, result.reason || 'cannot create');
  }
  return jsonResponse({
    ok: true,
    parent_id: result.parent_id,
    mode: 'date_range',
    start_date: body.start_date,
    end_date: body.end_date,
    window_size_days: WINDOW_SIZE_DAYS,
    total_windows: result.total_windows,
  });
}

/**
 * GET /api/backfill/progress[?user_id=...]
 *
 * No params → ctx.userId's status.
 * ?user_id=... → another user's status. Owner-only.
 *
 * Returns parent + windows + a precomputed summary block for the UI:
 *   windows_completed, windows_total, emails_total, attachments_total,
 *   eta_seconds (null until at least one window has completed), elapsed_seconds.
 */
export async function getBackfillProgress(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const requestedUserId = url.searchParams.get('user_id');
  const targetUserId = requestedUserId || ctx.userId;

  if (targetUserId !== ctx.userId && ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Members can only view their own progress.');
  }

  const { parent, windows } = await getProgressiveStatus(ctx.orgId, targetUserId, env);
  if (!parent) {
    return jsonResponse({ ok: true, parent: null, windows: [], summary: null });
  }

  let completedDurationSec = 0;
  let completedCount = 0;
  let emailsTotal = 0;
  let attachmentsProcessed = 0;
  let attachmentsPersisted = 0;
  let attachmentsFailed = 0;
  let attachmentsSkipped = 0;
  let conversationsAdded = 0;
  let embeddedTotal = 0;
  let inProgressIndex: number | null = null;

  for (const w of windows) {
    if (w.status === 'completed') {
      completedCount++;
      if (w.started_at && w.completed_at) {
        completedDurationSec += Math.max(
          0,
          (Date.parse(w.completed_at) - Date.parse(w.started_at)) / 1000
        );
      }
    }
    emailsTotal += w.emails_fetched ?? 0;
    conversationsAdded += w.conversations_added ?? 0;
    embeddedTotal += w.embedded_count ?? 0;
    attachmentsProcessed += (w as any).attachments_processed ?? 0;
    attachmentsPersisted += (w as any).attachments_persisted ?? 0;
    attachmentsFailed += (w as any).attachments_failed ?? 0;
    attachmentsSkipped += (w as any).attachments_skipped ?? 0;
    if (w.status === 'in_progress' && inProgressIndex === null) {
      inProgressIndex = w.window_index;
    }
  }

  const avgWindowSec = completedCount > 0 ? completedDurationSec / completedCount : null;
  const remaining = parent.total_windows - completedCount;
  const etaSeconds =
    avgWindowSec !== null && remaining > 0 ? Math.round(avgWindowSec * remaining) : null;

  const elapsedSeconds = parent.created_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(parent.created_at)) / 1000))
    : 0;

  return jsonResponse({
    ok: true,
    parent,
    windows,
    summary: {
      windows_completed: completedCount,
      windows_total: parent.total_windows,
      windows_in_progress_index: inProgressIndex,
      emails_total: emailsTotal,
      conversations_added: conversationsAdded,
      embedded_total: embeddedTotal,
      attachments_processed: attachmentsProcessed,
      attachments_persisted: attachmentsPersisted,
      attachments_failed: attachmentsFailed,
      attachments_skipped: attachmentsSkipped,
      avg_window_seconds: avgWindowSec !== null ? Math.round(avgWindowSec) : null,
      eta_seconds: etaSeconds,
      elapsed_seconds: elapsedSeconds,
    },
  });
}

/**
 * POST /api/backfill/cancel
 * Body: { user_id? }  — omit to cancel own.
 *
 * Members: own only. Owners: any user in org.
 */
export async function cancelBackfill(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = (await parseJsonBody<{ user_id?: string }>(request)) || {};
  const targetUserId = body.user_id || ctx.userId;
  if (targetUserId !== ctx.userId && ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Members can only cancel their own backfill.');
  }

  const targetUser = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(targetUserId, ctx.orgId).first<{ id: string }>();
  if (!targetUser) {
    return errorResponse('USER_NOT_FOUND', 404, 'User not in your org.');
  }

  const reason = ctx.userId === targetUserId
    ? `cancelled by user ${ctx.email}`
    : `cancelled by owner ${ctx.email}`;
  const result = await cancelProgressiveBackfill(ctx.orgId, targetUserId, env, reason);
  return jsonResponse({ ...result, user_id: targetUserId });
}

/**
 * GET /api/backfill/eligible-users  (owner-only)
 *
 * Powers the owner-only user-picker in the Settings UI. Returns users in the
 * caller's org with a provisioned platform user mailbox. The auto-resolved
 * "yourself" option in the UI doesn't need this list — it's purely the picker for
 * impersonating other users.
 */
export async function listEligibleUsers(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can list eligible users.');
  }
  const users = await env.D1.prepare(
    `SELECT id, COALESCE(outlook_mailbox, email) AS email, full_name, role
       FROM users
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND COALESCE(outlook_mailbox, email) IS NOT NULL
      ORDER BY (id = ?) DESC, full_name ASC`
  ).bind(ctx.orgId, ctx.userId).all<{
    id: string;
    email: string;
    full_name: string | null;
    role: string;
  }>();
  return jsonResponse({ ok: true, users: users.results });
}

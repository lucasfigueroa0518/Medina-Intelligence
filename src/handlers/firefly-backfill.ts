// Progressive Firefly transcript backfill (Phase F2) — admin-triggered,
// cron-driven. Seeds a parent job + N×10-day windows and advances them one
// paginated batch at a time across cron ticks. Replaces the prior synchronous
// one-shot path that couldn't survive the Cloudflare Worker CPU/wallclock
// limits (Tony's 90-day pull stalled mid-loop on 2026-04-29 + 2026-04-30).
// See src/lib/firefly-progressive-backfill.ts for the driver.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { getFireflyKeyStatus } from '../lib/firefly-credentials';
import {
  createFireflyProgressiveBackfill,
  createFireflyProgressiveBackfillRange,
  cancelFireflyProgressiveBackfill,
  getFireflyProgressiveStatus,
  listFireflyProgressiveBackfills,
  MAX_BACKFILL_DAYS,
} from '../lib/firefly-progressive-backfill';

interface ProgressiveBody {
  user_id?: string;
  fireflies_api_key?: string;
  days_back?: number;
  start_date?: string;
  end_date?: string;
  window_size_days?: number;
}

function canManageFireflyBackfill(ctx: AuthContext, userId: string): boolean {
  return userId === ctx.userId || ctx.userRole === 'owner' || ctx.userRole === 'super_admin';
}

/**
 * POST /api/admin/firefly-progressive-backfill
 *
 * Body: { user_id, fireflies_api_key, days_back? | (start_date,end_date)?, window_size_days? }
 *
 * Self-service for the target user; owners may start on behalf of org users.
 * Seeds a parent job + N×10-day windows backwards from now (or
 * from the provided end_date). Cron driver picks it up on the next every-
 * minute tick and advances one window per tick until exhausted. Encrypts the api_key
 * with TOKEN_ENCRYPTION_KEY (AES-256-GCM via src/lib/encryption.ts) and
 * nukes it to '' when the parent flips to completed/cancelled.
 */
export async function handleFireflyProgressiveBackfill(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<ProgressiveBody>(request);
  if (!body) return errorResponse('INVALID_BODY', 400);
  const targetUserId = body?.user_id || ctx.userId;
  if (!canManageFireflyBackfill(ctx, targetUserId)) {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Members can only import their own Fireflies transcripts.');
  }

  // Phase 4 fix (2026-05-04): the handler used to hard-reject when
  // fireflies_api_key was missing — predates persistent credentials and
  // gate-kept BEFORE the lib's getFireflyKeyStatus check ever ran. Now we
  // forward whatever the body provided (undefined / '' / a real key) into
  // the lib creators below; they handle resolution:
  //   • non-empty key → auto-persist via storeFireflyKey + per-job copy
  //   • empty/missing → existence-check getFireflyKeyStatus; if no row,
  //                     lib returns {created:false, reason:'… set up
  //                     Firefly credentials first'} which we surface as
  //                     409 FIREFLY_PROGRESSIVE_BLOCKED below.
  // Normalize '' → undefined so the lib's `?.trim() || ''` cleanly lands
  // in the persistent-resolution branch.
  const trimmedKey = body.fireflies_api_key?.trim();
  const apiKey = trimmedKey ? trimmedKey : undefined;

  const userExists = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(targetUserId, ctx.orgId).first();
  if (!userExists) {
    return errorResponse('USER_NOT_FOUND', 404, 'User not in your org');
  }

  const windowSize = body.window_size_days ?? 10;
  if (windowSize < 1 || windowSize > 90) {
    return errorResponse('VALIDATION_ERROR', 400, 'window_size_days must be 1..90');
  }

  const hasDateRange = !!(body.start_date || body.end_date);
  const hasDaysBack = body.days_back !== undefined;
  if (hasDateRange && hasDaysBack) {
    return errorResponse('VALIDATION_ERROR', 400, 'Provide either days_back OR (start_date,end_date), not both.');
  }
  if (!hasDateRange && !hasDaysBack) {
    return errorResponse('VALIDATION_ERROR', 400, 'Provide days_back or (start_date,end_date).');
  }

  if (hasDaysBack) {
    if (body.days_back! < 1 || body.days_back! > MAX_BACKFILL_DAYS) {
      return errorResponse(
        'VALIDATION_ERROR',
        400,
        `days_back must be 1..${MAX_BACKFILL_DAYS}; for longer pulls split into multiple requests`
      );
    }
    const result = await createFireflyProgressiveBackfill(
      ctx.orgId, targetUserId, body.days_back!, windowSize, apiKey, env
    );
    if (!result.created) {
      return errorResponse('FIREFLY_PROGRESSIVE_BLOCKED', 409, result.reason || 'cannot create');
    }
    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'create',
      entity_type: 'sync_job',
      entity_id: result.parent_id,
      metadata: {
        kind: 'firefly_progressive_backfill',
        triggered_by: ctx.userId,
        target_user: targetUserId,
        mode: 'days_back',
        days_back: body.days_back,
        window_size_days: windowSize,
        total_windows: result.total_windows,
        scheduled_days_count: result.scheduled_days_count,
      },
      created_at: new Date().toISOString(),
    });
    return jsonResponse({
      ok: true,
      parent_id: result.parent_id,
      mode: 'days_back',
      days_back: body.days_back,
      window_size_days: windowSize,
      total_windows: result.total_windows,
      scheduled_days_count: result.scheduled_days_count,
    });
  }

  if (!body.start_date || !body.end_date) {
    return errorResponse('VALIDATION_ERROR', 400, 'Both start_date and end_date are required.');
  }
  if (isNaN(Date.parse(body.start_date)) || isNaN(Date.parse(body.end_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'start_date / end_date must be ISO 8601');
  }
  const result = await createFireflyProgressiveBackfillRange(
    ctx.orgId, targetUserId, body.start_date, body.end_date, windowSize, apiKey, env
  );
  if (!result.created) {
    return errorResponse('FIREFLY_PROGRESSIVE_BLOCKED', 409, result.reason || 'cannot create');
  }
  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'sync_job',
    entity_id: result.parent_id,
    metadata: {
      kind: 'firefly_progressive_backfill',
      triggered_by: ctx.userId,
      target_user: targetUserId,
      mode: 'date_range',
      start_date: body.start_date,
      end_date: body.end_date,
      window_size_days: windowSize,
      total_windows: result.total_windows,
      scheduled_days_count: result.scheduled_days_count,
    },
    created_at: new Date().toISOString(),
  });
  return jsonResponse({
    ok: true,
    parent_id: result.parent_id,
    mode: 'date_range',
    start_date: body.start_date,
    end_date: body.end_date,
    window_size_days: windowSize,
    scheduled_days_count: result.scheduled_days_count,
    total_windows: result.total_windows,
  });
}

/**
 * GET /api/admin/firefly-progressive-backfill[?user_id=...]
 *
 * No params: owners get org-wide list of recent progressive Firefly backfills;
 * members get their own progress.
 * ?user_id=...: parent + windows for that user.
 *
 * Strips api_key_encrypted from the wire response either way.
 */
export async function handleFireflyProgressiveBackfillStatus(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) {
    if (ctx.userRole !== 'owner' && ctx.userRole !== 'super_admin') {
      const status = await getFireflyProgressiveStatus(ctx.orgId, ctx.userId, env);
      if (status.parent) {
        status.parent.api_key_encrypted = status.parent.api_key_encrypted ? '<redacted>' : '';
      }
      return jsonResponse({
        ok: true,
        ...status,
        credential_status: await getFireflyKeyStatus(ctx.userId, env),
      });
    }
    const all = await listFireflyProgressiveBackfills(ctx.orgId, env);
    const stripped = all.map(j => ({
      ...j,
      parent: { ...j.parent, api_key_encrypted: j.parent.api_key_encrypted ? '<redacted>' : '' },
    }));
    return jsonResponse({ ok: true, jobs: stripped });
  }
  if (!canManageFireflyBackfill(ctx, userId)) {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Members can only view their own Fireflies import status.');
  }
  const status = await getFireflyProgressiveStatus(ctx.orgId, userId, env);
  if (status.parent) {
    status.parent.api_key_encrypted = status.parent.api_key_encrypted ? '<redacted>' : '';
  }
  return jsonResponse({
    ok: true,
    ...status,
    credential_status: await getFireflyKeyStatus(userId, env),
  });
}

/**
 * POST /api/admin/firefly-progressive-backfill/cancel
 *
 * Body: { user_id }
 *
 * Self-service for the target user; owners may cancel for org users.
 * Cancels the user's active progressive Firefly backfill,
 * marks in-progress windows as failed, and nukes api_key_encrypted.
 */
export async function handleFireflyProgressiveBackfillCancel(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ user_id?: string }>(request);
  const targetUserId = body?.user_id || ctx.userId;
  if (!canManageFireflyBackfill(ctx, targetUserId)) {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Members can only cancel their own Fireflies import.');
  }
  const result = await cancelFireflyProgressiveBackfill(
    ctx.orgId, targetUserId, env, targetUserId === ctx.userId ? `cancelled by ${ctx.email}` : `cancelled by owner ${ctx.email}`
  );
  return jsonResponse({ ...result, user_id: targetUserId });
}

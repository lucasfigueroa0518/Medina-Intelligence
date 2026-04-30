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

/**
 * POST /api/admin/firefly-progressive-backfill
 *
 * Body: { user_id, fireflies_api_key, days_back? | (start_date,end_date)?, window_size_days? }
 *
 * Owner-gated. Seeds a parent job + N×10-day windows backwards from now (or
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
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can start a progressive Firefly backfill.');
  }

  const body = await parseJsonBody<ProgressiveBody>(request);
  if (!body?.user_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'user_id required');
  }
  const apiKey = body.fireflies_api_key?.trim();
  if (!apiKey) {
    return errorResponse('MISSING_API_KEY', 400, 'fireflies_api_key required');
  }

  const userExists = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(body.user_id, ctx.orgId).first();
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
      ctx.orgId, body.user_id, body.days_back!, windowSize, apiKey, env
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
        target_user: body.user_id,
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
    ctx.orgId, body.user_id, body.start_date, body.end_date, windowSize, apiKey, env
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
      target_user: body.user_id,
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
 * No params: org-wide list of recent progressive Firefly backfills.
 * ?user_id=...: parent + windows for that user.
 *
 * Owner-gated only because it surfaces the parent's encrypted api_key column
 * (which is '' when cleared, but kept owner-gated as a defense-in-depth
 * default). Strips api_key_encrypted from the wire response either way.
 */
export async function handleFireflyProgressiveBackfillStatus(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can view progressive Firefly backfill status.');
  }
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) {
    const all = await listFireflyProgressiveBackfills(ctx.orgId, env);
    const stripped = all.map(j => ({
      ...j,
      parent: { ...j.parent, api_key_encrypted: j.parent.api_key_encrypted ? '<redacted>' : '' },
    }));
    return jsonResponse({ ok: true, jobs: stripped });
  }
  const status = await getFireflyProgressiveStatus(ctx.orgId, userId, env);
  if (status.parent) {
    status.parent.api_key_encrypted = status.parent.api_key_encrypted ? '<redacted>' : '';
  }
  return jsonResponse({ ok: true, ...status });
}

/**
 * POST /api/admin/firefly-progressive-backfill/cancel
 *
 * Body: { user_id }
 *
 * Owner-gated. Cancels the user's active progressive Firefly backfill,
 * marks in-progress windows as failed, and nukes api_key_encrypted.
 */
export async function handleFireflyProgressiveBackfillCancel(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can cancel progressive Firefly backfills.');
  }
  const body = await parseJsonBody<{ user_id?: string }>(request);
  if (!body?.user_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'user_id required');
  }
  const result = await cancelFireflyProgressiveBackfill(
    ctx.orgId, body.user_id, env, `cancelled by owner ${ctx.email}`
  );
  return jsonResponse({ ...result, user_id: body.user_id });
}

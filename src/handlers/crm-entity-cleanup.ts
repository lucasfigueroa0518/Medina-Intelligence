import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { applyCrmEntityCleanupPlan, validateCrmEntityCleanupPlan } from '../lib/crm-entity-cleanup';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';

interface ApplyCleanupBody {
  dry_run?: boolean;
  limit?: number;
}

function isOwnerLike(ctx: AuthContext): boolean {
  return ctx.userRole === 'owner' || ctx.userRole === 'super_admin';
}

export async function validateCrmEntityCleanupHandler(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!isOwnerLike(ctx) && ctx.userRole !== 'admin') {
    return errorResponse('FORBIDDEN', 403, 'owner/admin only');
  }
  const result = await validateCrmEntityCleanupPlan(env, ctx.orgId);
  return jsonResponse({ ok: true, ...result });
}

export async function applyCrmEntityCleanupHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!isOwnerLike(ctx)) return errorResponse('FORBIDDEN', 403, 'owner-only');
  const body = (await parseJsonBody<ApplyCleanupBody>(request)) || {};
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.floor(Number(body.limit))) : undefined;
  const result = await applyCrmEntityCleanupPlan({
    env,
    orgId: ctx.orgId,
    userId: ctx.userId,
    dryRun: body.dry_run !== false,
    limit,
  });
  return jsonResponse({ ok: true, ...result });
}

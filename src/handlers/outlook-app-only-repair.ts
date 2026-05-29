import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import {
  getOutlookAppOnlyHealthSnapshot,
  repairOutlookAppOnlyState,
} from '../lib/outlook-app-only-health';

interface RepairBody {
  apply?: boolean;
}

function canRepair(ctx: AuthContext): boolean {
  return ctx.userRole === 'owner' || ctx.userRole === 'super_admin';
}

export async function handleOutlookAppOnlyHealth(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canRepair(ctx) && ctx.userRole !== 'admin') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Admin role required.');
  }
  const health = await getOutlookAppOnlyHealthSnapshot(ctx.orgId, env, {
    includeGraphProbes: true,
  });
  return jsonResponse({ ok: true, health });
}

export async function handleOutlookAppOnlyRepair(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canRepair(ctx)) {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Owner role required.');
  }
  const body = await parseJsonBody<RepairBody>(request).catch(() => null);
  const apply = body?.apply === true;
  const result = await repairOutlookAppOnlyState(ctx.orgId, env, { apply });
  return jsonResponse(result, result.ok ? 200 : 409);
}

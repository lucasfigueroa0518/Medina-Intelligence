import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';
import { canViewMartySandbox } from '../lib/marty-sandbox-access';
import {
  checkMartyLabReadiness,
  cancelMartyLabRun,
  getMartyLabRunDetail,
  getMartyLabStatusSnapshot,
  repairMartyLabReadinessBlocker,
} from '../lib/marty-lab';

interface ReadinessRepairBody {
  action?: 'clear_orphaned_lab_queue' | 'archive_legacy_full_lab' | 'quarantine_lab_artifacts' | 'reset_lab_baseline_to_live_runtime';
}

function hiddenMartySandboxResponse(): Response {
  return errorResponse('NOT_FOUND', 404, 'Not found');
}

function disabledMartySandboxResponse(): Response {
  return errorResponse(
    'MARTY_SANDBOX_DISABLED',
    403,
    'MARTy Sandbox execution is disabled so it cannot run work or consume credits.'
  );
}

export async function getMartyLabStatus(ctx: AuthContext, env: Env): Promise<Response> {
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return jsonResponse(await getMartyLabStatusSnapshot(env, ctx.orgId));
}

export async function getMartyLabReadiness(ctx: AuthContext, env: Env): Promise<Response> {
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return jsonResponse(await checkMartyLabReadiness(env, ctx.orgId));
}

export async function repairMartyLabReadinessHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  const body = (await parseJsonBody<ReadinessRepairBody>(request)) || {};
  try {
    return jsonResponse(await repairMartyLabReadinessBlocker(env, ctx.orgId, ctx.userId, body));
  } catch (error: any) {
    return errorResponse('BAD_REQUEST', 400, error?.message || 'Unable to repair MARTy Sandbox readiness');
  }
}

export async function startMartyLabRunHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  void request;
  void env;
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return disabledMartySandboxResponse();
}

export async function getMartyLabRunHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  const snapshot = await getMartyLabRunDetail(env, ctx.orgId, runId);
  if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
  return jsonResponse(snapshot);
}

export async function cancelMartyLabRunHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  const snapshot = await cancelMartyLabRun(env, ctx.orgId, runId);
  if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
  return jsonResponse(snapshot);
}

export async function decideMartyLabRunHandler(
  request: Request,
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  void request;
  void runId;
  void env;
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return disabledMartySandboxResponse();
}

export async function reviewInconclusiveMartyLabRoundHandler(
  request: Request,
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  void request;
  void runId;
  void env;
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return disabledMartySandboxResponse();
}

export async function recordMartyLabExperimentResultHandler(
  request: Request,
  runId: string,
  experimentId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  void request;
  void runId;
  void experimentId;
  void env;
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return disabledMartySandboxResponse();
}

export async function startMartyLabCodePatchJobHandler(
  request: Request,
  runId: string,
  deepWorkItemId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  void request;
  void runId;
  void deepWorkItemId;
  void env;
  if (!canViewMartySandbox(ctx)) return hiddenMartySandboxResponse();
  return disabledMartySandboxResponse();
}

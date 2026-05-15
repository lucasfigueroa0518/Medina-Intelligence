import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';
import {
  checkMartyLabReadiness,
  cancelMartyLabRun,
  decideMartyLabRun,
  getMartyLabRunDetail,
  getMartyLabStatusSnapshot,
  MartyLabReadinessError,
  recordMartyLabExperimentResult,
  repairMartyLabReadinessBlocker,
  reviewInconclusiveMartyLabRound,
  startMartyLabCodePatchJob,
  startMartyLabRun,
  type MartyLabExperimentStatus,
  type MartyLabHumanDecision,
  type MartyLabRoundReviewDecision,
  type MartyLabRunMode,
} from '../lib/marty-lab';

interface StartBody {
  suite_name?: string;
  baseline_label?: string;
  candidate_label?: string;
  mode?: MartyLabRunMode;
  round_count?: number;
  focus_prompt?: string;
  queue_if_blocked?: boolean;
}

interface ResultBody {
  baseline_score?: unknown;
  candidate_score?: unknown;
  baseline_transcript?: Array<Record<string, unknown>>;
  candidate_transcript?: Array<Record<string, unknown>>;
  recommendation?: string;
  privacy_failure?: boolean;
  tool_trace?: Record<string, unknown>;
  sources?: Record<string, unknown>;
  friction?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
  status?: MartyLabExperimentStatus;
}

interface DecisionBody {
  decision?: MartyLabHumanDecision;
}

interface RoundReviewBody {
  decision?: MartyLabRoundReviewDecision;
}

interface CodePatchBody {
  focus_prompt?: string;
}

interface ReadinessRepairBody {
  action?: 'clear_orphaned_lab_queue' | 'archive_legacy_full_lab' | 'quarantine_lab_artifacts' | 'reset_lab_baseline_to_live_runtime';
}

export async function getMartyLabStatus(ctx: AuthContext, env: Env): Promise<Response> {
  return jsonResponse(await getMartyLabStatusSnapshot(env, ctx.orgId));
}

export async function getMartyLabReadiness(ctx: AuthContext, env: Env): Promise<Response> {
  return jsonResponse(await checkMartyLabReadiness(env, ctx.orgId));
}

export async function repairMartyLabReadinessHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
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
  const body = (await parseJsonBody<StartBody>(request)) || {};
  try {
    return jsonResponse(await startMartyLabRun(env, ctx.orgId, ctx.userId, body));
  } catch (error: any) {
    if (error instanceof MartyLabReadinessError) {
      return jsonResponse({
        error: 'MARTY_LAB_NOT_READY',
        message: error.message,
        readiness: error.readiness,
      }, 409);
    }
    return errorResponse('BAD_REQUEST', 400, error?.message || 'Unable to start MARTy Lab run');
  }
}

export async function getMartyLabRunHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const snapshot = await getMartyLabRunDetail(env, ctx.orgId, runId);
  if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
  return jsonResponse(snapshot);
}

export async function cancelMartyLabRunHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
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
  const body = await parseJsonBody<DecisionBody>(request);
  if (!body || (body.decision !== 'ship' && body.decision !== 'reject')) {
    return errorResponse('BAD_REQUEST', 400, 'Expected decision to be ship or reject');
  }
  try {
    const snapshot = await decideMartyLabRun(env, ctx.orgId, runId, ctx.userId, body.decision);
    if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
    return jsonResponse(snapshot);
  } catch (error: any) {
    return errorResponse('BAD_REQUEST', 400, error?.message || 'Unable to apply MARTy Lab decision');
  }
}

export async function reviewInconclusiveMartyLabRoundHandler(
  request: Request,
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<RoundReviewBody>(request);
  if (!body || (body.decision !== 'approve_continue' && body.decision !== 'reject_continue')) {
    return errorResponse('BAD_REQUEST', 400, 'Expected decision to be approve_continue or reject_continue');
  }
  try {
    const snapshot = await reviewInconclusiveMartyLabRound(env, ctx.orgId, runId, ctx.userId, body.decision);
    if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
    return jsonResponse(snapshot);
  } catch (error: any) {
    return errorResponse('BAD_REQUEST', 400, error?.message || 'Unable to apply MARTy Lab round review');
  }
}

export async function recordMartyLabExperimentResultHandler(
  request: Request,
  runId: string,
  experimentId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<ResultBody>(request);
  if (!body) return errorResponse('BAD_REQUEST', 400, 'Expected JSON body');

  const snapshot = await recordMartyLabExperimentResult(env, ctx.orgId, runId, experimentId, body);
  if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
  return jsonResponse(snapshot);
}

export async function startMartyLabCodePatchJobHandler(
  request: Request,
  runId: string,
  deepWorkItemId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = (await parseJsonBody<CodePatchBody>(request)) || {};
  try {
    const snapshot = await startMartyLabCodePatchJob(
      env,
      ctx.orgId,
      runId,
      deepWorkItemId,
      ctx.userId,
      body
    );
    if (!snapshot.run) return errorResponse('NOT_FOUND', 404, 'MARTy Lab run not found');
    return jsonResponse(snapshot);
  } catch (error: any) {
    return errorResponse('BAD_REQUEST', 400, error?.message || 'Unable to start MARTy Lab code-patch lane');
  }
}

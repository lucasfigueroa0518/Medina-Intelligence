import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';
import {
  cancelMartyLabRun,
  getMartyLabRunDetail,
  getMartyLabStatusSnapshot,
  recordMartyLabExperimentResult,
  startMartyLabRun,
  type MartyLabExperimentStatus,
} from '../lib/marty-lab';

interface StartBody {
  suite_name?: string;
  baseline_label?: string;
  candidate_label?: string;
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

export async function getMartyLabStatus(ctx: AuthContext, env: Env): Promise<Response> {
  return jsonResponse(await getMartyLabStatusSnapshot(env, ctx.orgId));
}

export async function startMartyLabRunHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = (await parseJsonBody<StartBody>(request)) || {};
  return jsonResponse(await startMartyLabRun(env, ctx.orgId, ctx.userId, body));
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

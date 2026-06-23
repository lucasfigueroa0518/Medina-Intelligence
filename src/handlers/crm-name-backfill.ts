import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';
import {
  cancelCrmNameBackfillRun,
  DEFAULT_CRM_NAME_BACKFILL_SHARDS,
  getCrmNameBackfillRunStatus,
  resumeCrmNameBackfillRun,
  startCrmNameBackfillRun,
  type CrmNameBackfillMode,
} from '../lib/crm-name-backfill';

interface StartBackfillBody {
  mode?: CrmNameBackfillMode;
  shard_count?: number;
  chunk_size?: number;
}

function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function mapBackfillError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'CRM_NAME_BACKFILL_APPLY_DISABLED') {
    return errorResponse(
      'CRM_NAME_BACKFILL_APPLY_DISABLED',
      403,
      'Apply mode is disabled. Run dry_run first or enable CRM_NAME_BACKFILL_APPLY_ENABLED explicitly.'
    );
  }
  if (message.startsWith('CRM_NAME_BACKFILL_ALREADY_ACTIVE:')) {
    return errorResponse(
      'CRM_NAME_BACKFILL_ALREADY_ACTIVE',
      409,
      message.split(':')[1] || 'A CRM name backfill is already active for this org.'
    );
  }
  return errorResponse('CRM_NAME_BACKFILL_ERROR', 500, message);
}

export async function startCrmNameBackfillHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = (await parseJsonBody<StartBackfillBody>(request)) || {};
  const mode: CrmNameBackfillMode = body.mode === 'apply' ? 'apply' : 'dry_run';
  const shardCount = normalizePositiveInt(body.shard_count, DEFAULT_CRM_NAME_BACKFILL_SHARDS, 64);
  const chunkSize = normalizePositiveInt(body.chunk_size, 4, 20);
  try {
    const result = await startCrmNameBackfillRun({
      env,
      orgId: ctx.orgId,
      requestedBy: ctx.userId,
      mode,
      shardCount,
      chunkSize,
    });
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return mapBackfillError(error);
  }
}

export async function getCrmNameBackfillStatusHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const status = await getCrmNameBackfillRunStatus(env, ctx.orgId, runId);
  if (!status) return errorResponse('NOT_FOUND', 404, 'CRM name backfill run not found');
  return jsonResponse(status);
}

export async function cancelCrmNameBackfillHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const cancelled = await cancelCrmNameBackfillRun(env, ctx.orgId, runId);
  if (!cancelled) return errorResponse('NOT_FOUND_OR_NOT_ACTIVE', 404, 'CRM name backfill run is not active');
  return jsonResponse({ ok: true, run_id: runId, status: 'cancelled' });
}

export async function resumeCrmNameBackfillHandler(
  runId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const resumed = await resumeCrmNameBackfillRun(env, ctx.orgId, runId);
  if (!resumed) return errorResponse('NOT_FOUND_OR_NOT_CANCELLED', 404, 'CRM name backfill run is not cancelled');
  return jsonResponse({ ok: true, run_id: runId, status: 'running' });
}

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import {
  getD1MaintenanceRun,
  listD1MaintenanceRuns,
  previewD1Maintenance,
  runD1Maintenance,
  type MaintenanceStep,
} from '../lib/d1-maintenance';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';

const STEP_SET = new Set<MaintenanceStep>([
  'event_attendees',
  'stale_operations',
  'retention',
  'import_contacts',
  'news_articles',
  'cleanup_scratch',
]);

function requireOwner(ctx: AuthContext): Response | null {
  if (ctx.userRole !== 'owner' && ctx.userRole !== 'super_admin') {
    return errorResponse('FORBIDDEN', 403, 'owner role required');
  }
  return null;
}

function parseSteps(input: unknown): MaintenanceStep[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const steps = input.filter((v): v is MaintenanceStep => STEP_SET.has(v as MaintenanceStep));
  return steps.length ? steps : undefined;
}

export async function preview(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;
  const body = await parseJsonBody<{ steps?: unknown; batch_size?: number; org_id?: string | null }>(request);
  const report = await previewD1Maintenance(env, {
    orgId: body?.org_id === null ? null : body?.org_id || ctx.orgId,
    steps: parseSteps(body?.steps),
    batchSize: body?.batch_size,
  });
  return jsonResponse(report);
}

export async function run(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;
  const body = await parseJsonBody<{ steps?: unknown; batch_size?: number; org_id?: string | null }>(request);
  const report = await runD1Maintenance(env, {
    mode: 'run',
    orgId: body?.org_id === null ? null : body?.org_id || ctx.orgId,
    requestedByUserId: ctx.userId,
    steps: parseSteps(body?.steps),
    batchSize: body?.batch_size,
  });
  return jsonResponse(report, report.status === 'failed' ? 500 : 200);
}

export async function getRun(
  request: Request,
  runId: string | null,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const forbidden = requireOwner(ctx);
  if (forbidden) return forbidden;
  if (runId) {
    const run = await getD1MaintenanceRun(env, runId);
    if (!run) return errorResponse('NOT_FOUND', 404, 'maintenance run not found');
    return jsonResponse({ run });
  }
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || '25');
  const runs = await listD1MaintenanceRuns(env, ctx.orgId, limit);
  return jsonResponse({ runs });
}

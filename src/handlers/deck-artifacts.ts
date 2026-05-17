import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { errorResponse, jsonResponse, parseJsonBody } from './utils';
import {
  applyDeckRenderResult,
  getDeckJobEventsSnapshot,
  getDeckJobSnapshot,
  type DeckRenderResult,
} from '../lib/document-artifacts';

const MAX_WAIT_MS = 25_000;

function clampWaitMs(value: string | null): number {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.max(Math.round(parsed), 0), MAX_WAIT_MS);
}

function authHeaderToken(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return (match?.[1] || request.headers.get('X-Deck-Renderer-Token') || '').trim();
}

export async function getDeckJob(
  jobId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const job = await getDeckJobSnapshot(ctx, env, jobId);
  if (!job) return errorResponse('DECK_JOB_NOT_FOUND', 404);
  return jsonResponse({ job });
}

export async function getDeckJobEvents(
  request: Request,
  jobId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const afterSeq = Math.max(0, Number(url.searchParams.get('after_seq') || 0) || 0);
  const waitMs = clampWaitMs(url.searchParams.get('wait_ms'));
  const started = Date.now();

  let snapshot = await getDeckJobEventsSnapshot(ctx, env, jobId, afterSeq);
  while (snapshot.job && snapshot.events.length === 0 && waitMs > 0 && Date.now() - started < waitMs) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    snapshot = await getDeckJobEventsSnapshot(ctx, env, jobId, afterSeq);
  }

  if (!snapshot.job) return errorResponse('DECK_JOB_NOT_FOUND', 404);
  const latestSeq = snapshot.events.reduce((max, event) => Math.max(max, Number(event.seq || 0)), afterSeq);
  return jsonResponse({
    job: snapshot.job,
    events: snapshot.events,
    latest_seq: latestSeq,
  });
}

export async function internalDeckRenderComplete(
  request: Request,
  env: Env
): Promise<Response> {
  const expected = env.DECK_RENDERER_TOKEN || '';
  const received = authHeaderToken(request);
  if (!expected || !received || received !== expected) {
    return errorResponse('UNAUTHORIZED', 401);
  }

  const body = await parseJsonBody<DeckRenderResult>(request);
  if (!body?.job_id) return errorResponse('INVALID_DECK_RENDER_RESULT', 400, 'Missing job_id');

  const job = await env.D1.prepare(
    `SELECT id, org_id, user_id
       FROM deck_artifact_jobs
      WHERE id = ?
      LIMIT 1`
  ).bind(body.job_id).first<{ id: string; org_id: string; user_id: string | null }>();
  if (!job) return errorResponse('DECK_JOB_NOT_FOUND', 404);
  if (!job.user_id) return errorResponse('DECK_JOB_USER_MISSING', 409);

  const user = await env.D1.prepare(
    `SELECT id, email, role
       FROM users
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(job.user_id, job.org_id).first<{ id: string; email: string; role: AuthContext['userRole'] }>();
  if (!user) return errorResponse('DECK_JOB_USER_NOT_FOUND', 409);

  const ctx: AuthContext = {
    orgId: job.org_id,
    userId: user.id,
    userRole: user.role || 'member',
    email: user.email,
  };

  try {
    await applyDeckRenderResult(ctx, env, body);
    return jsonResponse({ ok: true, job_id: body.job_id });
  } catch (e: any) {
    return errorResponse('DECK_RENDER_COMPLETE_FAILED', 500, String(e?.message || e));
  }
}

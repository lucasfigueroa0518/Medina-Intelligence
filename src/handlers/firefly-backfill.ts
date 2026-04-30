// Legacy one-shot Firefly transcript backfill via the GraphQL API.
//
// POST /api/admin/firefly-backfill — auth required, no role restriction.
// The user supplies their own Firefly API key in the request body, so each
// team member can backfill their own meeting history.
//
// Status: LEGACY — kept alive for backward compatibility but DEPRECATED for
// pulls > 100 transcripts. The synchronous loop here cannot survive the
// Cloudflare Worker CPU/wallclock limits (Tony's 90-day pull stalled at
// transcript 12 on 2026-04-29 after the request timed out mid-loop). For
// any pull that might exceed ~30 transcripts, use the progressive variant:
//
//   POST /api/admin/firefly-progressive-backfill   (Phase F2)
//
// which seeds a parent job + N×10-day windows and advances them one
// paginated batch at a time across cron ticks. See
// src/lib/firefly-progressive-backfill.ts.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import {
  fetchTranscriptBatch,
  ingestSingleFireflyTranscript,
  type FireflyTranscript,
} from '../lib/firefly-ingest';
import {
  createFireflyProgressiveBackfill,
  createFireflyProgressiveBackfillRange,
  cancelFireflyProgressiveBackfill,
  getFireflyProgressiveStatus,
  listFireflyProgressiveBackfills,
} from '../lib/firefly-progressive-backfill';

const PAGE_SIZE = 50;
const MAX_TRANSCRIPTS_PER_RUN = 100;
const PER_TRANSCRIPT_DELAY_MS = 1000;

interface BackfillBody {
  api_key?: string;
  days?: number;
  start_date?: string;
  end_date?: string;
}

interface BackfillResult {
  total_found: number;
  ingested: number;
  skipped_duplicates: number;
  failed: number;
  errors: Array<{ transcript_id: string; title: string; error: string }>;
  partial?: boolean;
  partial_reason?: string;
}

export async function handleFireflyBackfill(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<BackfillBody>(request);
  const apiKey = body?.api_key?.trim();
  if (!apiKey) {
    return errorResponse('MISSING_API_KEY', 400, 'Provide your Firefly API key in the request body.');
  }

  const daysRaw = body?.days ?? 30;
  const days = Math.min(Math.max(Math.floor(daysRaw), 1), 90);
  const now = Date.now();

  let fromDate: string;
  let toDate: string;

  if (body?.start_date) {
    const parsed = Date.parse(body.start_date);
    if (isNaN(parsed)) {
      return errorResponse('VALIDATION_ERROR', 400, 'start_date must be a valid ISO 8601 date');
    }
    fromDate = new Date(parsed).toISOString();
    toDate = body.end_date ? new Date(Date.parse(body.end_date)).toISOString() : new Date(now).toISOString();
  } else {
    fromDate = new Date(now - days * 86400000).toISOString();
    toDate = new Date(now).toISOString();
  }

  const result: BackfillResult = {
    total_found: 0,
    ingested: 0,
    skipped_duplicates: 0,
    failed: 0,
    errors: [],
  };

  // ── Paginate the GraphQL endpoint ──
  const transcripts: FireflyTranscript[] = [];
  let skip = 0;
  while (transcripts.length < MAX_TRANSCRIPTS_PER_RUN) {
    let batch: FireflyTranscript[];
    try {
      batch = await fetchTranscriptBatch(apiKey, fromDate, toDate, PAGE_SIZE, skip);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('FIREFLY_RATE_LIMITED')) {
        result.partial = true;
        result.partial_reason = 'Firefly API rate limit hit during pagination';
        break;
      }
      if (msg.includes('FIREFLY_AUTH_FAILED')) {
        return errorResponse('FIREFLY_AUTH_FAILED', 401, 'Firefly rejected the API key. Verify it at app.fireflies.ai → Settings → Developer settings.');
      }
      return errorResponse('FIREFLY_FETCH_FAILED', 502, msg);
    }
    if (batch.length === 0) break;
    transcripts.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  if (transcripts.length > MAX_TRANSCRIPTS_PER_RUN) {
    transcripts.length = MAX_TRANSCRIPTS_PER_RUN;
    result.partial = true;
    result.partial_reason = `capped at ${MAX_TRANSCRIPTS_PER_RUN} transcripts per call`;
  }
  result.total_found = transcripts.length;

  // ── Process each transcript via the shared helper ──
  for (let i = 0; i < transcripts.length; i++) {
    const t = transcripts[i];
    try {
      const outcome = await ingestSingleFireflyTranscript(t, ctx.orgId, 'firefly-backfill', env);
      if (outcome === 'ingested') result.ingested++;
      else if (outcome === 'duplicate') result.skipped_duplicates++;
    } catch (e: any) {
      result.failed++;
      result.errors.push({
        transcript_id: t.id,
        title: t.title || '(untitled)',
        error: String(e?.message || e).slice(0, 300),
      });
    }
    // LEGACY: this 1s delay was the original Worker-timeout culprit. Kept
    // here for backward compat with the one-shot endpoint's existing
    // behavior. Progressive backfill (firefly-ingest.ts) uses 100ms.
    if (i < transcripts.length - 1) {
      await sleep(PER_TRANSCRIPT_DELAY_MS);
    }
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    action: 'create',
    entity_type: 'event',
    metadata: {
      source: 'firefly_backfill',
      triggered_by: ctx.userId,
      days,
      ...result,
    },
    created_at: new Date().toISOString(),
  });

  return jsonResponse(result);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// Progressive Firefly backfill (Phase F2) — admin-triggered, cron-driven.
// Replaces the legacy one-shot endpoint above for any pull that might exceed
// what fits in a single Worker request (~30 transcripts at the legacy delay).
// ────────────────────────────────────────────────────────────────────────────

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
    if (body.days_back! < 1 || body.days_back! > 730) {
      return errorResponse('VALIDATION_ERROR', 400, 'days_back must be 1..730');
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

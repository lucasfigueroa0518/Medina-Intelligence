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

// One-time Firefly transcript backfill via the GraphQL API.
//
// POST /api/admin/firefly-backfill — auth required, no role restriction.
// The user supplies their own Firefly API key in the request body, so each
// team member can backfill their own meeting history.

import type { Env } from '../types/env';
import type { AuthContext, SpeakerTurn } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import {
  processTranscriptItems,
  type TranscriptItem,
} from '../lib/process-transcript-items';

const FIREFLY_GRAPHQL = 'https://api.fireflies.ai/graphql';
const PAGE_SIZE = 50;
const MAX_TRANSCRIPTS_PER_RUN = 100;
const PER_TRANSCRIPT_DELAY_MS = 1000;

interface FireflyTranscript {
  id: string;
  title: string | null;
  date: number | string;            // Firefly returns epoch ms or ISO string
  duration: number | null;          // minutes
  meeting_attendees: Array<{ displayName?: string | null; email?: string | null; name?: string | null }> | null;
  summary: {
    overview?: string | null;
    action_items?: string | null;
    keywords?: string[] | null;
    shorthand_bullet?: string | null;
    outline?: string | null;
  } | null;
  sentences: Array<{ speaker_name: string; text: string; start_time: number }> | null;
}

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

  // ── Process each transcript ──
  for (let i = 0; i < transcripts.length; i++) {
    const t = transcripts[i];
    try {
      const outcome = await ingestTranscript(t, ctx.orgId, env);
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
    // Pace ourselves so the Firefly API doesn't throttle subsequent backfills,
    // and so we don't burn the Worker subrequest budget all at once.
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

// ────────────────────────────────────────────────────────────────────────────
// GraphQL fetch
// ────────────────────────────────────────────────────────────────────────────

async function fetchTranscriptBatch(
  apiKey: string,
  fromDate: string,
  toDate: string,
  limit: number,
  skip: number
): Promise<FireflyTranscript[]> {
  const query = `
    query GetTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
      transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
        id
        title
        date
        duration
        meeting_attendees { displayName email name }
        summary { overview action_items keywords shorthand_bullet outline }
        sentences { speaker_name text start_time }
      }
    }
  `;
  const resp = await fetch(FIREFLY_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables: { fromDate, toDate, limit, skip } }),
  });

  if (resp.status === 429) throw new Error('FIREFLY_RATE_LIMITED');
  if (resp.status === 401 || resp.status === 403) throw new Error('FIREFLY_AUTH_FAILED');

  const data = (await resp.json()) as {
    data?: { transcripts?: FireflyTranscript[] | null };
    errors?: Array<{ message: string }>;
  };

  if (data.errors?.length) {
    const msg = data.errors.map(e => e.message).join('; ');
    if (/auth|api key|unauthor/i.test(msg)) throw new Error('FIREFLY_AUTH_FAILED');
    throw new Error(`FIREFLY_GRAPHQL_ERROR: ${msg.slice(0, 200)}`);
  }

  return data.data?.transcripts || [];
}

// ────────────────────────────────────────────────────────────────────────────
// Per-transcript ingest — delegates the safety envelope (Phase 1 bail,
// per-attendee ACL, sync_jobs lifecycle, errors_sample) to processTranscriptItems.
// Backfill keeps the duplicate pre-check as an early-return optimization to
// avoid re-doing work for already-ingested transcripts. The race-safe canonical
// id read-back that this function used to own (post-INSERT verify) is now
// inside the helper's Phase 1 — removed here.
// ────────────────────────────────────────────────────────────────────────────

type IngestOutcome = 'ingested' | 'duplicate';

async function ingestTranscript(
  t: FireflyTranscript,
  orgId: string,
  env: Env
): Promise<IngestOutcome> {
  const startTime = normalizeFireflyDate(t.date);
  const durationMin = typeof t.duration === 'number' ? t.duration : 0;
  const endTime = startTime
    ? new Date(new Date(startTime).getTime() + durationMin * 60_000).toISOString()
    : null;
  const title = t.title?.trim() || '(untitled meeting)';

  // ── Duplicate pre-check: firefly_event_id (UNIQUE), then fuzzy title+start.
  // Optimization for the common case — avoids the helper's INSERT+read-back
  // round-trip when we know the transcript is already ingested. The helper's
  // Phase 1 read-back still backs us up if we lose a race after this check.
  const existingById = await env.D1.prepare(
    `SELECT id FROM events WHERE org_id = ? AND firefly_event_id = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(orgId, t.id).first<{ id: string }>();
  if (existingById) return 'duplicate';

  if (startTime) {
    const fuzzy = await env.D1.prepare(
      `SELECT id FROM events
        WHERE org_id = ? AND deleted_at IS NULL
          AND LOWER(title) = LOWER(?)
          AND ABS(strftime('%s', start_time) - strftime('%s', ?)) < 60
        LIMIT 1`
    ).bind(orgId, title, startTime).first<{ id: string }>();
    if (fuzzy) return 'duplicate';
  }

  // ── Build transcript text + speaker turns from sentences ──
  const sentences = t.sentences || [];
  const transcriptText = sentences
    .map(s => `${s.speaker_name}: ${s.text}`)
    .join('\n');
  const speakerTurns: SpeakerTurn[] = sentences.map(s => ({
    speaker: s.speaker_name,
    affiliation: lookupAffiliation(s.speaker_name, t.meeting_attendees || []),
    text: s.text,
  }));

  // Caller-side R2 PUT — helper takes the already-staged key. Path scheme
  // matches legacy backfill (`{org}/transcripts/{YYYY}/{MM}/{id}.txt`); R2
  // path standardization across webhook + backfill is deferred to Phase G.
  const transientId = crypto.randomUUID();
  const startDate = startTime ? new Date(startTime) : new Date();
  const yyyy = startDate.getUTCFullYear();
  const mm = String(startDate.getUTCMonth() + 1).padStart(2, '0');
  const r2Key = `${orgId}/transcripts/${yyyy}/${mm}/${transientId}.txt`;

  if (transcriptText.length > 0) {
    await env.R2.put(r2Key, transcriptText);
  }

  // Normalize summary fields for the helper. Firefly's GraphQL returns
  // action_items as a single string blob; we wrap into a one-element array
  // so it round-trips through the helper's JSON.stringify cleanly.
  const summaryOverview = t.summary?.overview?.trim() || null;
  const actionItemsRaw = t.summary?.action_items?.trim();
  const actionItems = actionItemsRaw ? [actionItemsRaw] : [];
  const topics = Array.isArray(t.summary?.keywords) ? t.summary!.keywords! : [];

  const item: TranscriptItem = {
    fireflyEventId: t.id,
    title,
    startTime: startTime || new Date().toISOString(),
    endTime,
    transcriptR2Key: transcriptText.length > 0 ? r2Key : null,
    transcriptText: transcriptText.length > 0 ? transcriptText : null,
    participants: (t.meeting_attendees || []).map(a => ({
      displayName: a.displayName || a.name || null,
      email: a.email ?? null,
    })),
    summaryOverview,
    actionItems,
    topics,
    speakerTurns,
  };

  const stats = await processTranscriptItems(
    [item],
    { orgId, sourcePath: 'firefly-backfill' },
    env
  );

  // Phase 1 bail = fail this transcript. The helper's sync_jobs row already
  // captured the staging error in errors_sample; surface the first message
  // so the BackfillResult.errors entry is informative.
  if (stats.items_staged === 0) {
    const firstErr = stats.errors[0];
    throw new Error(
      firstErr ? `${firstErr.phase}: ${firstErr.error}` : 'staging failed'
    );
  }

  // Partial success — Phase 2/3 had errors but the event row exists. Log
  // for backfill-side visibility; the helper persisted full detail to
  // sync_jobs.metadata.errors_sample.
  if (stats.errors.length > 0) {
    console.warn(
      `[firefly-backfill] partial success firefly_event_id=${t.id} ` +
      `errors=${stats.errors.length} sync_job=${stats.sync_job_id} ` +
      `(see sync_jobs.metadata.errors_sample)`
    );
  }

  return 'ingested';
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function normalizeFireflyDate(d: number | string | null | undefined): string | null {
  if (d == null) return null;
  if (typeof d === 'number') return new Date(d).toISOString();
  const parsed = Date.parse(d);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function lookupAffiliation(
  speakerName: string,
  attendees: Array<{ displayName?: string | null; email?: string | null; name?: string | null }>
): string {
  const lower = speakerName.toLowerCase();
  for (const a of attendees) {
    const candidates = [a.displayName, a.name].filter(Boolean) as string[];
    if (candidates.some(c => c.toLowerCase() === lower)) {
      return a.email || 'External';
    }
  }
  return 'External';
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Shared Fireflies ingest helpers — extracted from src/handlers/firefly-backfill.ts
// during Phase F so the legacy one-shot endpoint and the new progressive
// backfill driver can share the same per-transcript ingest path.
//
// Three exports:
//   - fetchTranscriptBatch     : paginated GraphQL fetch (offset-based)
//   - ingestSingleFireflyTranscript : per-transcript ingest with dup pre-check
//   - runFireflyWindowBackfill : per-window driver invoked by the progressive
//                                cron tick. Mirrors runHistoricalBackfill in
//                                src/integrations/outlook.ts.
//
// All three sit in src/lib/ rather than src/integrations/ because they're
// pure orchestration (no transport state, no token refresh) — they take an
// already-decrypted API key and don't manage its lifecycle. The progressive
// lib (src/lib/firefly-progressive-backfill.ts) is responsible for decrypt
// + nuke-on-completion.
//
// Per-attendee ACL, sync_jobs lifecycle, errors_sample, and Phase 1 bail
// are owned by processTranscriptItems — this module just feeds it.

import type { Env } from '../types/env';
import type { SpeakerTurn } from '../types/interfaces';
import {
  processTranscriptItems,
  type TranscriptItem,
} from './process-transcript-items';

const FIREFLY_GRAPHQL = 'https://api.fireflies.ai/graphql';
export const FIREFLY_PAGE_SIZE = 50;

// Per-tick budget for the progressive driver. Calibrated for transcripts
// (~14 chunks/transcript averaged from production data) — 15 transcripts
// × 14 chunks = ~210 BGE embed calls per tick, comfortably under the
// 25s wallclock budget.
export const FIREFLY_MAX_TRANSCRIPTS_PER_TICK = 15;
export const FIREFLY_MAX_RUNTIME_MS = 25_000;
// Pace per-transcript work so we don't slam Workers AI / D1. Way smaller
// than the legacy 1000ms — that one-shot delay multiplied across an
// uncapped loop is what tipped the original endpoint past Worker CPU
// limits. Cron-paced ticks don't compound.
const FIREFLY_PER_TRANSCRIPT_DELAY_MS = 100;

export interface FireflyTranscript {
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

export type FireflySourcePath = 'firefly-progressive-backfill-window';
export type IngestOutcome = 'ingested' | 'duplicate' | 'failed';

export interface RunFireflyWindowResult {
  status: 'completed' | 'paused' | 'failed';
  total_fetched: number;       // pages × PAGE_SIZE-ish; informational
  total_processed: number;     // transcripts whose ingest path actually ran
  ingested: number;
  duplicates: number;
  failed: number;
  last_skip: number;           // resume cursor (0 means "start fresh")
  reason?: string;             // pause/fail reason
  errors?: Array<{ transcript_id: string; error: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// GraphQL fetch — offset/limit pagination via $skip / $limit
// ────────────────────────────────────────────────────────────────────────────

export async function fetchTranscriptBatch(
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
    // Fireflies returns rate-limit as HTTP 200 + errors[].message ("Too many
    // requests. Please retry after ..."), NOT as HTTP 429. Route through the
    // same paused-resumes-later path the status-code check above would have.
    // Without this, rate-limited windows mark themselves 'failed' and require
    // manual SQL recovery; with this, they pause and the next cron tick (after
    // Fireflies' daily quota resets at 00:00 UTC) resumes from last_skip.
    if (/too many requests|rate.?limit/i.test(msg)) throw new Error('FIREFLY_RATE_LIMITED');
    throw new Error(`FIREFLY_GRAPHQL_ERROR: ${msg.slice(0, 200)}`);
  }

  return data.data?.transcripts || [];
}

// ────────────────────────────────────────────────────────────────────────────
// Per-transcript ingest — duplicate pre-check, R2 staging, processTranscriptItems
// ────────────────────────────────────────────────────────────────────────────

export async function ingestSingleFireflyTranscript(
  t: FireflyTranscript,
  orgId: string,
  sourcePath: FireflySourcePath,
  env: Env
): Promise<IngestOutcome> {
  const startTime = normalizeFireflyDate(t.date);
  const durationMin = typeof t.duration === 'number' ? t.duration : 0;
  const endTime = startTime
    ? new Date(new Date(startTime).getTime() + durationMin * 60_000).toISOString()
    : null;
  const title = t.title?.trim() || '(untitled meeting)';

  // Duplicate pre-check: firefly_event_id (UNIQUE), then fuzzy title+start.
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
  // matches legacy backfill (`{org}/transcripts/{YYYY}/{MM}/{id}.txt`).
  const transientId = crypto.randomUUID();
  const startDate = startTime ? new Date(startTime) : new Date();
  const yyyy = startDate.getUTCFullYear();
  const mm = String(startDate.getUTCMonth() + 1).padStart(2, '0');
  const r2Key = `${orgId}/transcripts/${yyyy}/${mm}/${transientId}.txt`;

  if (transcriptText.length > 0) {
    await env.R2.put(r2Key, transcriptText);
  }

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
    { orgId, sourcePath },
    env
  );

  // Phase 1 bail = fail this transcript. The helper's sync_jobs row already
  // captured the staging error in errors_sample; surface the first message
  // so the caller's error log is informative.
  if (stats.items_staged === 0) {
    const firstErr = stats.errors[0];
    throw new Error(
      firstErr ? `${firstErr.phase}: ${firstErr.error}` : 'staging failed'
    );
  }

  if (stats.errors.length > 0) {
    console.warn(
      `[firefly-ingest] partial success firefly_event_id=${t.id} ` +
      `errors=${stats.errors.length} sync_job=${stats.sync_job_id} ` +
      `(see sync_jobs.metadata.errors_sample)`
    );
  }

  return 'ingested';
}

// ────────────────────────────────────────────────────────────────────────────
// Per-window driver — invoked by the progressive cron tick (one window at
// a time, one cron tick at a time). Mirrors runHistoricalBackfill in
// src/integrations/outlook.ts. Returns paused with last_skip when the
// per-tick budget hits, completed when the window's date range is exhausted.
// ────────────────────────────────────────────────────────────────────────────

export interface RunFireflyWindowOpts {
  userId: string;
  orgId: string;
  fireflyApiKey: string;     // already decrypted by caller
  startDate: string;         // ISO 8601, inclusive
  endDate: string;           // ISO 8601, exclusive
  initialSkip: number;       // resume cursor; 0 for fresh window
  progressiveWindowId: string;
}

export async function runFireflyWindowBackfill(
  opts: RunFireflyWindowOpts,
  env: Env
): Promise<RunFireflyWindowResult> {
  const startedAt = Date.now();
  let skip = Math.max(0, opts.initialSkip | 0);
  let totalFetched = 0;
  let totalProcessed = 0;
  let ingested = 0;
  let duplicates = 0;
  let failed = 0;
  const errors: Array<{ transcript_id: string; error: string }> = [];

  // Per-tick sync_jobs row — mirrors what closeSyncJob does for Outlook.
  // One row per cron-tick invocation; aggregate across rows by
  // metadata.progressive_window_id when reporting.
  const syncJobId = crypto.randomUUID();
  const userRow = await env.D1.prepare(
    'SELECT email FROM users WHERE id = ? AND org_id = ?'
  ).bind(opts.userId, opts.orgId).first<{ email: string | null }>();
  const userEmail = userRow?.email ?? null;

  const syncJobTimeoutAt = new Date(startedAt + 5 * 60_000).toISOString();
  await env.D1.prepare(
    `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, timeout_at, metadata)
     VALUES (?, ?, 'firefly-progressive-backfill-window', 'running', ?, ?, ?)`
  ).bind(
    syncJobId, opts.orgId, new Date(startedAt).toISOString(), syncJobTimeoutAt,
    JSON.stringify({
      user_id: opts.userId,
      user_email: userEmail,
      window_start: opts.startDate,
      window_end: opts.endDate,
      initial_skip: skip,
      progressive_window_id: opts.progressiveWindowId,
    })
  ).run().catch(e => {
    console.error(`[firefly-ingest] sync_jobs insert failed for ${syncJobId}:`, (e as any)?.message || e);
  });

  const closeSyncJob = async (status: 'completed' | 'failed' | 'paused', extra?: Record<string, unknown>) => {
    try {
      await env.D1.prepare(
        `UPDATE sync_jobs
            SET status = ?, completed_at = ?,
                metadata = json_patch(COALESCE(metadata, '{}'), ?)
          WHERE id = ?`
      ).bind(
        status, new Date().toISOString(),
        JSON.stringify({
          ended_status: status,
          ingested,
          duplicates,
          failed,
          last_skip: skip,
          ...(extra || {}),
        }),
        syncJobId
      ).run();
    } catch (e) {
      console.error(`[firefly-ingest] sync_jobs close failed for ${syncJobId}:`, (e as any)?.message || e);
    }
  };

  try {
    while (true) {
      // Per-tick budget caps — prefer terminating before the Worker
      // wallclock kicks in so closeSyncJob always runs.
      if (Date.now() - startedAt > FIREFLY_MAX_RUNTIME_MS) {
        await closeSyncJob('paused', { reason: 'wallclock_cap' });
        return {
          status: 'paused', total_fetched: totalFetched, total_processed: totalProcessed,
          ingested, duplicates, failed, last_skip: skip,
          reason: 'wallclock_cap', errors,
        };
      }
      if (totalProcessed >= FIREFLY_MAX_TRANSCRIPTS_PER_TICK) {
        await closeSyncJob('paused', { reason: 'transcript_count_cap' });
        return {
          status: 'paused', total_fetched: totalFetched, total_processed: totalProcessed,
          ingested, duplicates, failed, last_skip: skip,
          reason: 'transcript_count_cap', errors,
        };
      }

      let batch: FireflyTranscript[];
      try {
        batch = await fetchTranscriptBatch(
          opts.fireflyApiKey, opts.startDate, opts.endDate, FIREFLY_PAGE_SIZE, skip
        );
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes('FIREFLY_RATE_LIMITED')) {
          await closeSyncJob('paused', { reason: 'firefly_rate_limit' });
          return {
            status: 'paused', total_fetched: totalFetched, total_processed: totalProcessed,
            ingested, duplicates, failed, last_skip: skip,
            reason: 'firefly_rate_limit', errors,
          };
        }
        // Auth fail or any other GraphQL error → surface as window-level failure.
        await closeSyncJob('failed', { reason: 'fetch_error', error: msg.slice(0, 200) });
        return {
          status: 'failed', total_fetched: totalFetched, total_processed: totalProcessed,
          ingested, duplicates, failed, last_skip: skip,
          reason: msg.slice(0, 200), errors,
        };
      }

      totalFetched += batch.length;

      if (batch.length === 0) {
        // No more transcripts in this window's date range — done.
        await closeSyncJob('completed', { reason: 'range_exhausted' });
        return {
          status: 'completed', total_fetched: totalFetched, total_processed: totalProcessed,
          ingested, duplicates, failed, last_skip: skip,
          errors,
        };
      }

      for (const t of batch) {
        if (Date.now() - startedAt > FIREFLY_MAX_RUNTIME_MS) {
          await closeSyncJob('paused', { reason: 'wallclock_cap_inner' });
          return {
            status: 'paused', total_fetched: totalFetched, total_processed: totalProcessed,
            ingested, duplicates, failed, last_skip: skip,
            reason: 'wallclock_cap_inner', errors,
          };
        }
        if (totalProcessed >= FIREFLY_MAX_TRANSCRIPTS_PER_TICK) {
          await closeSyncJob('paused', { reason: 'transcript_count_cap_inner' });
          return {
            status: 'paused', total_fetched: totalFetched, total_processed: totalProcessed,
            ingested, duplicates, failed, last_skip: skip,
            reason: 'transcript_count_cap_inner', errors,
          };
        }

        try {
          const outcome = await ingestSingleFireflyTranscript(
            t, opts.orgId, 'firefly-progressive-backfill-window', env
          );
          if (outcome === 'ingested') ingested++;
          else if (outcome === 'duplicate') duplicates++;
        } catch (e: any) {
          failed++;
          errors.push({ transcript_id: t.id, error: String(e?.message || e).slice(0, 300) });
        }

        skip++;
        totalProcessed++;
        await sleep(FIREFLY_PER_TRANSCRIPT_DELAY_MS);
      }

      // Short batch = no more pages in this date range. Standard offset/limit
      // pagination signal: when the page returns < limit, there's nothing
      // after it.
      if (batch.length < FIREFLY_PAGE_SIZE) {
        await closeSyncJob('completed', { reason: 'short_batch' });
        return {
          status: 'completed', total_fetched: totalFetched, total_processed: totalProcessed,
          ingested, duplicates, failed, last_skip: skip,
          errors,
        };
      }
    }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    await closeSyncJob('failed', { reason: 'unexpected', error: msg });
    return {
      status: 'failed', total_fetched: totalFetched, total_processed: totalProcessed,
      ingested, duplicates, failed, last_skip: skip,
      reason: msg, errors,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

export function normalizeFireflyDate(d: number | string | null | undefined): string | null {
  if (d == null) return null;
  if (typeof d === 'number') return new Date(d).toISOString();
  const parsed = Date.parse(d);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function lookupAffiliation(
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

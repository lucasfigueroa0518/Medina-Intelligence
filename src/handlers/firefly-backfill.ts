// One-time Firefly transcript backfill via the GraphQL API.
//
// POST /api/admin/firefly-backfill — auth required, no role restriction.
// The user supplies their own Firefly API key in the request body, so each
// team member can backfill their own meeting history.

import type { Env } from '../types/env';
import type { AuthContext, ChunkMetadata, SpeakerTurn } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { chunkTranscriptBySpeakerTurns, determineOverlapTurns } from '../lib/chunking';
import { chunkEmbedAndPersist } from '../lib/embedding';
import { reconcileFireflyWithoutId } from '../lib/reconciliation';
import { emitAudit } from '../lib/audit';
import { autoCreateContactFromAttendee, extractAndRouteSignals } from '../lib/firefly-intelligence';
import { autoLinkAttendees } from '../lib/associations';

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
  const fromDate = new Date(now - days * 86400000).toISOString();
  const toDate = new Date(now).toISOString();

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
// Per-transcript ingest — mirrors processFireflyWebhook in firefly.ts
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

  // ── Duplicate check: firefly_event_id (UNIQUE), then fuzzy title+start ──
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

  // ── Build transcript text from sentences ──
  const sentences = t.sentences || [];
  const transcriptText = sentences
    .map(s => `${s.speaker_name}: ${s.text}`)
    .join('\n');

  const eventId = crypto.randomUUID();
  const startDate = startTime ? new Date(startTime) : new Date();
  const yyyy = startDate.getUTCFullYear();
  const mm = String(startDate.getUTCMonth() + 1).padStart(2, '0');
  const r2Key = `${orgId}/transcripts/${yyyy}/${mm}/${eventId}.txt`;

  if (transcriptText.length > 0) {
    await env.R2.put(r2Key, transcriptText);
  }

  const summaryOverview = t.summary?.overview?.trim() || null;
  const actionItems = t.summary?.action_items?.trim() || null;
  const keywords = t.summary?.keywords;
  const topicsJson = JSON.stringify(Array.isArray(keywords) ? keywords : []);
  const actionItemsJson = JSON.stringify(actionItems ? [actionItems] : []);

  const now = new Date().toISOString();
  await env.D1.prepare(
    `INSERT OR IGNORE INTO events
       (id, org_id, title, event_type, start_time, end_time, source, firefly_event_id,
        reconciliation_status, transcript_r2_key, transcript_source, summary,
        action_items, topics_discussed, created_at, updated_at)
     VALUES (?, ?, ?, 'meeting', ?, ?, 'firefly', ?, 'pending_reconciliation', ?,
             'firefly', ?, ?, ?, ?, ?)`
  )
    .bind(
      eventId,
      orgId,
      title,
      startTime || now,
      endTime,
      t.id,
      transcriptText.length > 0 ? r2Key : null,
      summaryOverview,
      actionItemsJson,
      topicsJson,
      now,
      now
    )
    .run();

  // INSERT OR IGNORE silently no-ops on UNIQUE collision (firefly_event_id).
  // If a parallel run beat us to it, the row we just inserted may not be
  // ours — verify before doing downstream work.
  const ours = await env.D1.prepare(
    `SELECT id FROM events WHERE id = ?`
  ).bind(eventId).first<{ id: string }>();
  if (!ours) return 'duplicate';

  // ── Attendees ──
  // Three-step linkage:
  //   1. Existing org user → user_id link, is_internal=1
  //   2. Existing contact → contact_id link
  //   3. Neither → auto-create contact from attendee (skips automated emails,
  //      requires a usable display name) so the meeting graph isn't full of
  //      orphan rows.
  for (const p of t.meeting_attendees || []) {
    const email = (p.email || '').toLowerCase().trim();
    if (!email) continue;
    const displayName = p.displayName || p.name || email.split('@')[0];

    const user = await env.D1.prepare(
      'SELECT id FROM users WHERE LOWER(email) = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(email, orgId).first<{ id: string }>();

    let contactId: string | null = null;
    if (!user) {
      const auto = await autoCreateContactFromAttendee({
        email, displayName, orgId, env,
      });
      if (auto) contactId = auto.contactId;
    }

    await env.D1.prepare(
      `INSERT OR IGNORE INTO event_attendees
         (event_id, contact_id, user_id, email, display_name, role, is_internal)
       VALUES (?, ?, ?, ?, ?, 'attendee', ?)`
    )
      .bind(eventId, contactId, user?.id || null, email, displayName, user ? 1 : 0)
      .run();
  }

  // ── Speaker-turn chunking + embed ──
  if (sentences.length > 0) {
    const turns: SpeakerTurn[] = sentences.map(s => ({
      speaker: s.speaker_name,
      affiliation: lookupAffiliation(s.speaker_name, t.meeting_attendees || []),
      text: s.text,
    }));
    const overlapTurns = determineOverlapTurns(turns);
    const chunks = chunkTranscriptBySpeakerTurns(turns, 1024, overlapTurns);

    for (let i = 0; i < chunks.length; i++) {
      const meta: ChunkMetadata = {
        org_id: orgId,
        document_type: 'transcript',
        source_table: 'events',
        source_id: eventId,
        r2_key: r2Key,
        visibility: 'org_wide',
        primary_entity_id: eventId,
        created_at: now,
        entity_name: title,
        date: startTime || undefined,
        speakers: chunks[i].speakers.join(','),
        primary_speaker: chunks[i].primary_speaker,
      };
      const entry = await chunkEmbedAndPersist(chunks[i].text, meta, i, chunks.length, env);
      await env.D1.prepare(
        'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
      ).bind(entry.vectorId, entry.entityId, entry.sourceTable, entry.orgId).run();
    }
  }

  // ── Outlook reconciliation (best-effort) ──
  try {
    await reconcileFireflyWithoutId(
      { id: eventId, firefly_event_id: t.id, start_time: startTime || now, transcript_r2_key: transcriptText.length > 0 ? r2Key : null },
      orgId,
      env
    );
  } catch (e) {
    console.error('[firefly-backfill] reconciliation failed:', e);
  }

  // ── Co-meeting graph: link every pair of contact-bearing attendees ──
  try {
    await autoLinkAttendees(eventId, orgId, env);
  } catch (e) {
    console.error('[firefly-backfill] autoLinkAttendees failed:', e);
  }

  // ── Transcript intelligence: signals + summary distribution ──
  // Wrapped so a Claude failure doesn't lose the transcript we already
  // persisted. The enrichment cron's Step 5 will retry next cycle if this
  // fails (signals_extracted_at stays NULL).
  if (transcriptText.length > 0) {
    try {
      await extractAndRouteSignals(eventId, orgId, env);
    } catch (e) {
      console.error('[firefly-backfill] signal extraction failed:', e);
    }
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

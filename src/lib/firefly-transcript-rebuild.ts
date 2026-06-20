import type { Env } from '../types/env';
import type { SpeakerTurn } from '../types/interfaces';
import { upsertEventAttendee } from './event-attendees';
import { enqueueWork } from './work-queue';
import { enqueueProspectDetectSource } from './work-queue-handlers/prospect-detect';
import { enqueueIngestionTreatment } from './ingestion-treatment';

export const FIREFLY_TRANSCRIPT_REBUILD_MAX_DAYS = 190;

export interface FireflyTranscriptParticipant {
  displayName: string | null;
  email: string | null;
}

export interface FireflyTranscriptRecordInput {
  fireflyEventId: string;
  title: string;
  startTime: string;
  endTime: string | null;
  durationMinutes?: number | null;
  transcriptText: string | null;
  participants: FireflyTranscriptParticipant[];
  summaryOverview: string | null;
  actionItems: string[];
  topics: string[];
  speakerTurns: SpeakerTurn[];
}

export interface FireflyTranscriptIngestContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  sourcePath:
    | 'firefly-progressive-backfill-window'
    | 'firefly-webhook'
    | 'firefly-recent-sweep'
    | 'firefly-transcript-rebuild';
}

export interface FireflyTranscriptIngestOptions {
  dryRun?: boolean;
  repairEmbeddings?: boolean;
  repairProspectSignals?: boolean;
}

export interface OutlookTranscriptMatch {
  event_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  outlook_event_id: string | null;
  score: number;
  reason: {
    time_delta_minutes: number;
    title_score: number;
    attendee_overlap: number;
    attendee_count: number;
    virtual_evidence: boolean;
    cancelled: boolean;
  };
}

export interface FireflyTranscriptIngestResult {
  outcome: 'ingested' | 'duplicate';
  canonical_status: 'linked' | 'standalone' | 'dry_run';
  r2_staged: number;
  linked_events: number;
  standalone_transcripts: number;
  embedding_queued: number;
  prospect_queued: number;
  event_ids: string[];
  transcript_item_id: string | null;
}

interface ExistingFireflyEventRow {
  id: string;
  source: string;
  transcript_r2_key: string | null;
}

interface OutlookCandidateRow {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  description: string | null;
  outlook_event_id: string | null;
}

interface TranscriptItemRow {
  id: string;
}

const SQLITE_BIND_CHUNK_SIZE = 50;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function normalizeEmail(email: string | null | undefined): string {
  return String(email || '').trim().toLowerCase();
}

export function normalizeMeetingTitle(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(cancelled|canceled)\s*:\s*/g, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^)]+\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(zoom|teams|google|meet|meeting|call|fireflies|recurring)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlapScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 30;
  const aTokens = new Set(a.split(' ').filter(t => t.length > 1));
  const bTokens = new Set(b.split(' ').filter(t => t.length > 1));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap++;
  const ratio = overlap / Math.max(aTokens.size, bTokens.size);
  if (ratio >= 0.75) return 25;
  if (ratio >= 0.5) return 18;
  if (ratio >= 0.3) return 10;
  return 0;
}

function hasVirtualEvidence(row: Pick<OutlookCandidateRow, 'location' | 'description' | 'title'>): boolean {
  const haystack = `${row.location || ''} ${row.description || ''} ${row.title || ''}`.toLowerCase();
  return /\b(zoom|teams|google meet|meet\.google|webex|join meeting|online meeting|conference)\b/.test(haystack);
}

function looksCanceled(title: string | null | undefined, description?: string | null): boolean {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  return /^\s*(cancelled|canceled)\s*:/.test(text) || /\b(cancelled|canceled)\b/.test(text);
}

export function safeFireflyId(id: string): string {
  const cleaned = String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180);
  return cleaned || 'unknown';
}

export function stableFireflyTranscriptR2Key(orgId: string, startTime: string, fireflyEventId: string): string {
  const d = new Date(startTime);
  const yyyy = Number.isFinite(d.getTime()) ? d.getUTCFullYear() : new Date().getUTCFullYear();
  const mm = String(Number.isFinite(d.getTime()) ? d.getUTCMonth() + 1 : new Date().getUTCMonth() + 1).padStart(2, '0');
  return `${orgId}/transcripts/fireflies/${yyyy}/${mm}/${safeFireflyId(fireflyEventId)}.txt`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeTranscriptText(text: string | null | undefined): string | null {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return normalized.length > 0 ? normalized : null;
}

function participantEmails(participants: FireflyTranscriptParticipant[]): Set<string> {
  return new Set(participants.map(p => normalizeEmail(p.email)).filter(Boolean));
}

function scoreOutlookCandidate(
  input: FireflyTranscriptRecordInput,
  candidate: OutlookCandidateRow,
  candidateEmails: Set<string>
): OutlookTranscriptMatch {
  const fireflyEmails = participantEmails(input.participants);
  const fireflyStart = Date.parse(input.startTime) || 0;
  const candidateStart = Date.parse(candidate.start_time) || 0;
  const deltaMinutes = Math.abs(candidateStart - fireflyStart) / 60_000;
  const timeScore =
    deltaMinutes <= 5 ? 40 :
    deltaMinutes <= 15 ? 32 :
    deltaMinutes <= 30 ? 20 :
    deltaMinutes <= 60 ? 10 : 0;

  const titleScore = tokenOverlapScore(
    normalizeMeetingTitle(input.title),
    normalizeMeetingTitle(candidate.title)
  );

  let overlap = 0;
  for (const email of fireflyEmails) if (candidateEmails.has(email)) overlap++;
  const attendeeScore =
    overlap >= 3 ? 25 :
    overlap === 2 ? 20 :
    overlap === 1 ? 12 : 0;

  const virtualEvidence = hasVirtualEvidence(candidate);
  const cancelled = looksCanceled(candidate.title, candidate.description);
  const score = timeScore + titleScore + attendeeScore + (virtualEvidence ? 5 : 0) - (cancelled ? 100 : 0);

  return {
    event_id: candidate.id,
    title: candidate.title,
    start_time: candidate.start_time,
    end_time: candidate.end_time,
    outlook_event_id: candidate.outlook_event_id,
    score,
    reason: {
      time_delta_minutes: Math.round(deltaMinutes * 10) / 10,
      title_score: titleScore,
      attendee_overlap: overlap,
      attendee_count: fireflyEmails.size,
      virtual_evidence: virtualEvidence,
      cancelled,
    },
  };
}

function acceptsMatch(input: FireflyTranscriptRecordInput, match: OutlookTranscriptMatch): boolean {
  if (match.reason.cancelled) return false;
  if (match.score >= 60) return true;
  if (match.reason.attendee_count > 0) {
    return match.reason.attendee_overlap >= 1 && match.reason.time_delta_minutes <= 30 && match.score >= 44;
  }
  return (
    normalizeMeetingTitle(input.title).length >= 12 &&
    match.reason.title_score >= 25 &&
    match.reason.time_delta_minutes <= 15 &&
    match.score >= 55
  );
}

export async function findOutlookMatchesForFireflyTranscript(
  input: FireflyTranscriptRecordInput,
  orgId: string,
  env: Env
): Promise<OutlookTranscriptMatch[]> {
  const startMs = Date.parse(input.startTime);
  if (!Number.isFinite(startMs)) return [];
  const windowStart = new Date(startMs - 60 * 60_000).toISOString();
  const windowEnd = new Date(startMs + 60 * 60_000).toISOString();

  const candidates = await env.D1.prepare(
    `SELECT id, title, start_time, end_time, location, description, outlook_event_id
       FROM events
      WHERE org_id = ?
        AND source = 'outlook'
        AND deleted_at IS NULL
        AND start_time BETWEEN ? AND ?
      ORDER BY start_time ASC
      LIMIT 100`
  ).bind(orgId, windowStart, windowEnd).all<OutlookCandidateRow>();

  const eventIds = candidates.results.map(c => c.id);
  const attendeeEmailsByEvent = new Map<string, Set<string>>();
  if (eventIds.length > 0) {
    for (const eventIdChunk of chunks(eventIds, SQLITE_BIND_CHUNK_SIZE)) {
      const placeholders = eventIdChunk.map(() => '?').join(',');
      const attendeeRows = await env.D1.prepare(
        `SELECT event_id, email FROM event_attendees WHERE event_id IN (${placeholders})`
      ).bind(...eventIdChunk).all<{ event_id: string; email: string | null }>();
      for (const row of attendeeRows.results) {
        let emails = attendeeEmailsByEvent.get(row.event_id);
        if (!emails) {
          emails = new Set<string>();
          attendeeEmailsByEvent.set(row.event_id, emails);
        }
        const email = normalizeEmail(row.email);
        if (email) emails.add(email);
      }
    }
  }

  const scored: OutlookTranscriptMatch[] = [];
  for (const candidate of candidates.results) {
    const emails = attendeeEmailsByEvent.get(candidate.id) || new Set<string>();
    const match = scoreOutlookCandidate(input, candidate, emails);
    if (acceptsMatch(input, match)) scored.push(match);
  }

  return scored.sort((a, b) => b.score - a.score || a.reason.time_delta_minutes - b.reason.time_delta_minutes);
}

async function upsertTranscriptItem(
  input: FireflyTranscriptRecordInput,
  ctx: FireflyTranscriptIngestContext,
  r2Key: string | null,
  sourceHash: string | null,
  status: 'staged' | 'linked' | 'standalone' | 'dry_run' | 'error',
  canonicalEventId: string | null,
  matchedCount: number,
  env: Env
): Promise<string | null> {
  const row = await env.D1.prepare(
    `INSERT INTO firefly_transcript_items
       (org_id, user_id, run_id, firefly_event_id, transcript_date, title,
        duration_minutes, r2_key, source_hash, canonical_status,
        canonical_event_id, matched_event_count, error_message, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(org_id, firefly_event_id) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, firefly_transcript_items.user_id),
       run_id = COALESCE(excluded.run_id, firefly_transcript_items.run_id),
       transcript_date = excluded.transcript_date,
       title = excluded.title,
       duration_minutes = excluded.duration_minutes,
       r2_key = COALESCE(excluded.r2_key, firefly_transcript_items.r2_key),
       source_hash = COALESCE(excluded.source_hash, firefly_transcript_items.source_hash),
       canonical_status = excluded.canonical_status,
       canonical_event_id = excluded.canonical_event_id,
       matched_event_count = excluded.matched_event_count,
       error_message = NULL,
       metadata = excluded.metadata,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id`
  ).bind(
    ctx.orgId,
    ctx.userId || null,
    ctx.runId || null,
    input.fireflyEventId,
    input.startTime,
    input.title,
    input.durationMinutes ?? null,
    r2Key,
    sourceHash,
    status,
    canonicalEventId,
    matchedCount,
    JSON.stringify({
      source_path: ctx.sourcePath,
      participants: input.participants.length,
      action_items: input.actionItems.length,
      topics: input.topics,
    })
  ).first<TranscriptItemRow>();
  return row?.id || null;
}

async function upsertTranscriptAttendeesForEvent(
  eventId: string,
  input: FireflyTranscriptRecordInput,
  ctx: FireflyTranscriptIngestContext,
  env: Env
): Promise<void> {
  const emails = input.participants
    .map(p => normalizeEmail(p.email))
    .filter(Boolean);
  const usersByEmail = new Map<string, string>();
  if (emails.length > 0) {
    const uniqueEmails = [...new Set(emails)];
    for (const emailChunk of chunks(uniqueEmails, SQLITE_BIND_CHUNK_SIZE)) {
      const placeholders = emailChunk.map(() => '?').join(',');
      const userRows = await env.D1.prepare(
        `SELECT id, LOWER(email) AS email
           FROM users
          WHERE org_id = ?
            AND deleted_at IS NULL
            AND LOWER(email) IN (${placeholders})`
      ).bind(ctx.orgId, ...emailChunk).all<{ id: string; email: string }>();
      for (const user of userRows.results) {
        usersByEmail.set(normalizeEmail(user.email), user.id);
      }
    }
  }

  for (const participant of input.participants) {
    const email = normalizeEmail(participant.email);
    if (!email) continue;
    const displayName = participant.displayName?.trim() || email.split('@')[0];
    const userId = usersByEmail.get(email) || null;

    await upsertEventAttendee(env, {
      eventId,
      contactId: null,
      userId,
      email,
      displayName,
      role: 'attendee',
      isInternal: !!userId,
    });
  }
}

async function enqueueEmbeddingIfMissing(eventId: string, orgId: string, env: Env): Promise<number> {
  const existing = await env.D1.prepare(
    `SELECT 1 FROM vector_entity_index
      WHERE entity_id = ? AND source_table = 'events' AND org_id = ?
      LIMIT 1`
  ).bind(eventId, orgId).first();
  if (existing) return 0;
  const queued = await enqueueWork(env, orgId, 'embed_retry',
    { entity_id: eventId, source_table: 'events' },
    {
      upstream: 'bge',
      idempotency_key: `${orgId}:${eventId}:events`,
      priority: 20,
    }
  );
  return queued.inserted ? 1 : 0;
}

async function enqueueProspectIfRequested(
  eventId: string,
  orgId: string,
  env: Env,
  requested: boolean
): Promise<number> {
  if (!requested) return 0;
  const queued = await enqueueProspectDetectSource(env, {
    orgId,
    sourceType: 'event',
    sourceId: eventId,
    origin: 'firefly_transcript_rebuild',
    ingestionMode: 'backfill',
    priority: 20,
  });
  return queued.inserted ? 1 : 0;
}

async function updateOutlookEventWithTranscript(
  eventId: string,
  input: FireflyTranscriptRecordInput,
  r2Key: string | null,
  env: Env
): Promise<void> {
  const actionJson = input.actionItems.length > 0 ? JSON.stringify(input.actionItems) : null;
  const topicsJson = input.topics.length > 0 ? JSON.stringify(input.topics) : null;
  await env.D1.prepare(
    `UPDATE events
        SET transcript_r2_key = ?,
            transcript_source = 'firefly',
            summary = COALESCE(NULLIF(?, ''), summary),
            action_items = COALESCE(?, action_items),
            topics_discussed = COALESCE(?, topics_discussed),
            reconciliation_status = 'reconciled',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(
    r2Key,
    input.summaryOverview || '',
    actionJson,
    topicsJson,
    eventId
  ).run();
}

async function upsertTranscriptLink(
  match: OutlookTranscriptMatch,
  input: FireflyTranscriptRecordInput,
  transcriptItemId: string | null,
  orgId: string,
  env: Env
): Promise<void> {
  await env.D1.prepare(
    `INSERT INTO firefly_transcript_event_links
       (org_id, firefly_event_id, transcript_item_id, event_id, link_status, match_score, match_reason)
     VALUES (?, ?, ?, ?, 'linked', ?, ?)
     ON CONFLICT(org_id, firefly_event_id, event_id) DO UPDATE SET
       transcript_item_id = COALESCE(excluded.transcript_item_id, firefly_transcript_event_links.transcript_item_id),
       link_status = 'linked',
       match_score = excluded.match_score,
       match_reason = excluded.match_reason,
       linked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    orgId,
    input.fireflyEventId,
    transcriptItemId,
    match.event_id,
    match.score,
    JSON.stringify(match.reason)
  ).run();
}

async function findExistingFireflyEvent(
  input: FireflyTranscriptRecordInput,
  orgId: string,
  env: Env
): Promise<ExistingFireflyEventRow | null> {
  return await env.D1.prepare(
    `SELECT id, source, transcript_r2_key
       FROM events
      WHERE org_id = ? AND firefly_event_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, input.fireflyEventId).first<ExistingFireflyEventRow>();
}

async function upsertStandaloneFireflyEvent(
  input: FireflyTranscriptRecordInput,
  ctx: FireflyTranscriptIngestContext,
  r2Key: string | null,
  env: Env
): Promise<string> {
  const existing = await findExistingFireflyEvent(input, ctx.orgId, env);
  if (existing) {
    await env.D1.prepare(
      `UPDATE events
          SET transcript_r2_key = COALESCE(?, transcript_r2_key),
              transcript_source = 'firefly',
              summary = COALESCE(NULLIF(?, ''), summary),
              action_items = COALESCE(?, action_items),
              topics_discussed = COALESCE(?, topics_discussed),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(
      r2Key,
      input.summaryOverview || '',
      input.actionItems.length ? JSON.stringify(input.actionItems) : null,
      input.topics.length ? JSON.stringify(input.topics) : null,
      existing.id
    ).run();
    return existing.id;
  }

  try {
    const inserted = await env.D1.prepare(
      `INSERT INTO events
         (id, org_id, title, event_type, start_time, end_time,
          source, firefly_event_id, reconciliation_status,
          transcript_r2_key, transcript_source, summary, action_items, topics_discussed,
          created_at, updated_at)
       VALUES (?, ?, ?, 'meeting', ?, ?,
          'firefly', ?, 'standalone',
          ?, 'firefly', ?, ?, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       RETURNING id`
    ).bind(
      crypto.randomUUID(),
      ctx.orgId,
      input.title,
      input.startTime,
      input.endTime,
      input.fireflyEventId,
      r2Key,
      input.summaryOverview,
      JSON.stringify(input.actionItems || []),
      JSON.stringify(input.topics || [])
    ).first<{ id: string }>();
    if (inserted?.id) return inserted.id;
  } catch (e: any) {
    if (!String(e?.message || e).toLowerCase().includes('unique')) throw e;
  }

  {
    const row = await findExistingFireflyEvent(input, ctx.orgId, env);
    if (row?.id) return row.id;
    throw new Error(`failed to insert standalone Fireflies event ${input.fireflyEventId}`);
  }
}

async function markFireflyRowSuperseded(
  fireflyEventId: string,
  orgId: string,
  supersededByEventIds: string[],
  env: Env
): Promise<string | null> {
  const existing = await env.D1.prepare(
    `SELECT id FROM events
      WHERE org_id = ? AND source = 'firefly' AND firefly_event_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, fireflyEventId).first<{ id: string }>();
  if (!existing?.id) return null;

  await env.D1.prepare(
    `UPDATE events
        SET custom_fields = json_set(
              CASE WHEN custom_fields IS NOT NULL AND json_valid(custom_fields)
                   THEN custom_fields ELSE '{}' END,
              '$.firefly_superseded_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              '$.firefly_superseded_by_event_ids', ?,
              '$.firefly_supersession_reason', 'matched_outlook_canonical_event'
            ),
            reconciliation_status = 'reconciled',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(supersededByEventIds), existing.id).run();

  await env.D1.prepare(
    `UPDATE prospect_signals
        SET resolution_status = 'dropped',
            metadata_json = json_set(
              CASE WHEN metadata_json IS NOT NULL AND json_valid(metadata_json)
                   THEN metadata_json ELSE '{}' END,
              '$.superseded_by_event_ids', ?,
              '$.superseded_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
            ),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ? AND source_type = 'event' AND source_id = ?`
  ).bind(JSON.stringify(supersededByEventIds), orgId, existing.id).run().catch(() => {});

  return existing.id;
}

async function retireSupersededFireflyVectorsIfSafe(
  supersededEventId: string | null,
  canonicalEventIds: string[],
  orgId: string,
  env: Env
): Promise<void> {
  if (!supersededEventId || canonicalEventIds.length === 0) return;
  const placeholders = canonicalEventIds.map(() => '?').join(',');
  const canonicalHasVectors = await env.D1.prepare(
    `SELECT 1 FROM vector_entity_index
      WHERE org_id = ? AND source_table = 'events' AND entity_id IN (${placeholders})
      LIMIT 1`
  ).bind(orgId, ...canonicalEventIds).first();
  if (!canonicalHasVectors) return;

  const oldVectors = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index
      WHERE org_id = ? AND source_table = 'events' AND entity_id = ?`
  ).bind(orgId, supersededEventId).all<{ vector_id: string }>();
  const ids = oldVectors.results.map(r => r.vector_id);
  if (ids.length === 0) return;
  await env.VECTORIZE.deleteByIds(ids).catch(() => {});
  const vectorPlaceholders = ids.map(() => '?').join(',');
  await env.D1.prepare(
    `DELETE FROM vector_entity_index WHERE vector_id IN (${vectorPlaceholders})`
  ).bind(...ids).run();
}

export async function ingestFireflyTranscriptRecord(
  input: FireflyTranscriptRecordInput,
  ctx: FireflyTranscriptIngestContext,
  env: Env,
  options: FireflyTranscriptIngestOptions = {}
): Promise<FireflyTranscriptIngestResult> {
  const dryRun = options.dryRun === true;
  const repairEmbeddings = options.repairEmbeddings !== false;
  const repairProspectSignals = options.repairProspectSignals !== false;
  const transcriptText = normalizeTranscriptText(input.transcriptText);
  const r2Key = transcriptText
    ? stableFireflyTranscriptR2Key(ctx.orgId, input.startTime, input.fireflyEventId)
    : null;
  const sourceHash = transcriptText ? await sha256Hex(transcriptText) : null;

  const matches = await findOutlookMatchesForFireflyTranscript(input, ctx.orgId, env);

  if (dryRun) {
    return {
      outcome: 'ingested',
      canonical_status: matches.length > 0 ? 'linked' : 'dry_run',
      r2_staged: 0,
      linked_events: matches.length,
      standalone_transcripts: matches.length > 0 ? 0 : 1,
      embedding_queued: 0,
      prospect_queued: 0,
      event_ids: matches.map(m => m.event_id),
      transcript_item_id: null,
    };
  }

  if (transcriptText && r2Key) {
    await env.R2.put(r2Key, transcriptText);
  }

  let transcriptItemId = await upsertTranscriptItem(
    input,
    ctx,
    r2Key,
    sourceHash,
    'staged',
    null,
    matches.length,
    env
  );

  let embeddingQueued = 0;
  let prospectQueued = 0;

  if (matches.length > 0) {
    const eventIds = matches.map(m => m.event_id);
    for (const match of matches) {
      await updateOutlookEventWithTranscript(match.event_id, input, r2Key, env);
      await upsertTranscriptLink(match, input, transcriptItemId, ctx.orgId, env);
      await upsertTranscriptAttendeesForEvent(match.event_id, input, ctx, env);
    }

    transcriptItemId = await upsertTranscriptItem(
      input,
      ctx,
      r2Key,
      sourceHash,
      'linked',
      eventIds[0] || null,
      matches.length,
      env
    );

    const supersededEventId = await markFireflyRowSuperseded(
      input.fireflyEventId,
      ctx.orgId,
      eventIds,
      env
    );
    await retireSupersededFireflyVectorsIfSafe(supersededEventId, eventIds, ctx.orgId, env).catch(() => {});

    for (const match of matches) {
      if (repairEmbeddings) embeddingQueued += await enqueueEmbeddingIfMissing(match.event_id, ctx.orgId, env);
      prospectQueued += await enqueueProspectIfRequested(match.event_id, ctx.orgId, env, repairProspectSignals);
      await enqueueIngestionTreatment(env, {
        orgId: ctx.orgId,
        sourceTable: 'events',
        sourceId: match.event_id,
        sourceKind: 'firefly_transcript_event',
        ingestionMode: ctx.sourcePath === 'firefly-webhook' ? 'live' : 'backfill',
        origin: ctx.sourcePath,
        priority: 30,
      }).catch(e => {
        console.error(`[firefly-rebuild] treatment enqueue failed for event=${match.event_id}:`, e);
      });
    }

    return {
      outcome: 'ingested',
      canonical_status: 'linked',
      r2_staged: transcriptText ? 1 : 0,
      linked_events: eventIds.length,
      standalone_transcripts: 0,
      embedding_queued: embeddingQueued,
      prospect_queued: prospectQueued,
      event_ids: eventIds,
      transcript_item_id: transcriptItemId,
    };
  }

  const standaloneEventId = await upsertStandaloneFireflyEvent(input, ctx, r2Key, env);
  transcriptItemId = await upsertTranscriptItem(
    input,
    ctx,
    r2Key,
    sourceHash,
    'standalone',
    standaloneEventId,
    0,
    env
  );

  await upsertTranscriptAttendeesForEvent(standaloneEventId, input, ctx, env);
  if (repairEmbeddings) embeddingQueued += await enqueueEmbeddingIfMissing(standaloneEventId, ctx.orgId, env);
  prospectQueued += await enqueueProspectIfRequested(standaloneEventId, ctx.orgId, env, repairProspectSignals);
  await enqueueIngestionTreatment(env, {
    orgId: ctx.orgId,
    sourceTable: 'events',
    sourceId: standaloneEventId,
    sourceKind: 'firefly_standalone_transcript',
    ingestionMode: ctx.sourcePath === 'firefly-webhook' ? 'live' : 'backfill',
    origin: ctx.sourcePath,
    priority: 30,
  }).catch(e => {
    console.error(`[firefly-rebuild] treatment enqueue failed for standalone event=${standaloneEventId}:`, e);
  });

  return {
    outcome: 'ingested',
    canonical_status: 'standalone',
    r2_staged: transcriptText ? 1 : 0,
    linked_events: 0,
    standalone_transcripts: 1,
    embedding_queued: embeddingQueued,
    prospect_queued: prospectQueued,
    event_ids: [standaloneEventId],
    transcript_item_id: transcriptItemId,
  };
}

export function sixCalendarMonthsRange(now: Date = new Date()): { startDate: string; endDate: string } {
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - 6,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds()
  ));
  return { startDate: start.toISOString(), endDate: now.toISOString() };
}

export const __fireflyTranscriptRebuildTestHooks = {
  acceptsMatch,
  hasVirtualEvidence,
  looksCanceled,
  normalizeMeetingTitle,
  participantEmails,
  safeFireflyId,
  scoreOutlookCandidate,
  sha256Hex,
  stableFireflyTranscriptR2Key,
  tokenOverlapScore,
};

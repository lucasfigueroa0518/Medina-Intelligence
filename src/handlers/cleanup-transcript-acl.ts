// One-shot ACL migration for the 233 legacy Firefly transcript chunks
// embedded before Wave 4 (Phases A-C) routed transcripts through
// processTranscriptItems with per-attendee ACL.
//
// Pre-Wave-4 every transcript chunk shipped with visibility='org_wide' —
// every internal user could retrieve any meeting's chunks regardless of
// attendance. New chunks (Phases B + C) carry visibility='private' +
// participant_user_ids = comma-sep internal user_ids resolved from
// event_attendees. This endpoint backfills the same metadata onto
// existing chunks via Vectorize metadata-only upsert (Path A from the
// architectural decision):
//
//   1. SELECT up to BATCH_SIZE unprocessed vector_entity_index rows where
//      source_table='events'.
//   2. For each event_id in the batch, JOIN event_attendees → list of
//      internal user_ids (those with user_id IS NOT NULL).
//   3. Vectorize.getByIds([ids]) — preserves the existing 768-dim BGE
//      values so we don't recompute embeddings.
//   4. For each fetched vector, build new metadata: { ...existing,
//      visibility: 'private', participant_user_ids: <comma-sep> }.
//   5. Vectorize.upsert with the same id + same values + new metadata.
//   6. Mark the vector_id in _cleanup_transcript_acl tracking table to
//      keep the next batch advancing.
//
// Idempotent: re-runs use the tracking table to skip done rows; if a
// row's metadata is already 'private' (e.g. partial prior run), it's
// counted as already_migrated and marked.
//
// Edge case: events with zero internal-user attendees end up with
// participant_user_ids='' — meaning the meeting becomes invisible to
// all org users in retrieval. Per architectural decision: transcripts
// with zero internal attendees were external-presenter recordings, not
// co-attended firm meetings; we don't fall back to org_wide.
//
// Owner-gated. The /api/admin path itself is owner-or-admin gated in
// index.ts; we add a strict owner check inline because metadata
// rewrites in Vectorize are non-trivial to undo.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';

const BATCH_SIZE = 20; // Vectorize.getByIds cap (CF VECTOR_GET_ERROR 40007)

interface CleanupResult {
  rows_processed: number;
  rows_remaining: number;
  rows_already_migrated: number;
  rows_missing_in_vectorize: number;
  errors: Array<{ vector_id?: string; phase: string; error: string }>;
}

export async function handleCleanupTranscriptAcl(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('FORBIDDEN', 403, 'cleanup-transcript-acl is owner-only');
  }

  const errors: CleanupResult['errors'] = [];

  // Tracking table — idempotent CREATE.
  await env.D1.prepare(
    `CREATE TABLE IF NOT EXISTS _cleanup_transcript_acl (
      vector_id TEXT PRIMARY KEY,
      migrated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`
  )
    .run()
    .catch((e: any) => {
      errors.push({ phase: 'init', error: e?.message || String(e) });
    });

  const candidates = await env.D1.prepare(
    `SELECT vei.vector_id, vei.entity_id
       FROM vector_entity_index vei
      WHERE vei.source_table = 'events'
        AND vei.org_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM _cleanup_transcript_acl c
           WHERE c.vector_id = vei.vector_id
        )
      ORDER BY vei.vector_id
      LIMIT ?`
  )
    .bind(ctx.orgId, BATCH_SIZE)
    .all<{ vector_id: string; entity_id: string }>();

  if (candidates.results.length === 0) {
    return jsonResponse({
      rows_processed: 0,
      rows_remaining: 0,
      rows_already_migrated: 0,
      rows_missing_in_vectorize: 0,
      errors,
    });
  }

  // Cache participant_user_ids per event_id — multiple chunks of the same
  // event share the same list, no need to JOIN once per chunk.
  const participantsByEvent = new Map<string, string>();
  const uniqueEventIds = [...new Set(candidates.results.map(c => c.entity_id))];
  for (const eventId of uniqueEventIds) {
    try {
      const rows = await env.D1.prepare(
        `SELECT user_id FROM event_attendees
           WHERE event_id = ? AND user_id IS NOT NULL`
      )
        .bind(eventId)
        .all<{ user_id: string }>();
      const ids = rows.results.map(r => r.user_id).filter(Boolean);
      participantsByEvent.set(eventId, ids.join(','));
    } catch (e: any) {
      errors.push({
        phase: 'attendee-lookup',
        error: `${eventId}: ${String(e?.message || e).slice(0, 500)}`,
      });
      participantsByEvent.set(eventId, '');
    }
  }

  // Vectorize getByIds — already capped at 20.
  const ids = candidates.results.map(c => c.vector_id);
  const fetchedMap = new Map<string, { values: number[]; metadata: any }>();
  try {
    const fetched = await env.VECTORIZE.getByIds(ids);
    for (const v of fetched) {
      fetchedMap.set(v.id, {
        values: (v.values as number[]) || [],
        metadata: v.metadata || {},
      });
    }
  } catch (e: any) {
    errors.push({ phase: 'getByIds', error: String(e?.message || e).slice(0, 500) });
    return jsonResponse({
      rows_processed: 0,
      rows_remaining: candidates.results.length,
      rows_already_migrated: 0,
      rows_missing_in_vectorize: 0,
      errors,
    });
  }

  let alreadyMigrated = 0;
  let missingInVectorize = 0;
  const toUpsert: Array<{ id: string; values: number[]; metadata: any }> = [];
  const idsToMark = new Set<string>();

  for (const candidate of candidates.results) {
    const existing = fetchedMap.get(candidate.vector_id);
    if (!existing || !existing.values || existing.values.length === 0) {
      // Phantom: D1 says the row exists, Vectorize doesn't have it (or
      // returned without values). Mark as processed to keep the cursor
      // advancing — full repair would require re-embedding from R2 which
      // is out of scope for this migration.
      missingInVectorize++;
      idsToMark.add(candidate.vector_id);
      continue;
    }

    // Idempotency check — skip if already migrated. We treat "visibility is
    // already 'private' AND participant_user_ids is set" as the migrated
    // signature (matches what Phases B+C write for new chunks).
    if (
      existing.metadata?.visibility === 'private' &&
      typeof existing.metadata.participant_user_ids !== 'undefined'
    ) {
      alreadyMigrated++;
      idsToMark.add(candidate.vector_id);
      continue;
    }

    const newParticipants = participantsByEvent.get(candidate.entity_id) || '';
    toUpsert.push({
      id: candidate.vector_id,
      values: existing.values,
      metadata: {
        ...existing.metadata,
        visibility: 'private',
        participant_user_ids: newParticipants,
      },
    });
    idsToMark.add(candidate.vector_id);
  }

  // Batch upsert with per-vector fallback — mirrors admin.ts pattern at
  // line 357-371. Successful per-vector upserts stay marked; failures get
  // unmarked so the next batch retries them.
  let processed = 0;
  if (toUpsert.length > 0) {
    try {
      await env.VECTORIZE.upsert(toUpsert);
      processed = toUpsert.length;
    } catch (err: any) {
      errors.push({
        phase: 'upsert_batch',
        error: `${String(err?.message || err).slice(0, 400)} — falling back per-vector`,
      });
      for (const v of toUpsert) {
        try {
          await env.VECTORIZE.upsert([v]);
          processed += 1;
        } catch (perErr: any) {
          errors.push({
            vector_id: v.id,
            phase: 'upsert_one',
            error: String(perErr?.message || perErr).slice(0, 500),
          });
          idsToMark.delete(v.id);
        }
      }
    }
  }

  if (idsToMark.size > 0) {
    try {
      await env.D1.batch(
        [...idsToMark].map(id =>
          env.D1.prepare(
            `INSERT OR IGNORE INTO _cleanup_transcript_acl (vector_id) VALUES (?)`
          ).bind(id)
        )
      );
    } catch (e: any) {
      errors.push({
        phase: 'mark-migrated',
        error: String(e?.message || e).slice(0, 500),
      });
    }
  }

  const finalRemaining = await env.D1.prepare(
    `SELECT COUNT(*) as cnt
       FROM vector_entity_index vei
      WHERE vei.source_table = 'events'
        AND vei.org_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM _cleanup_transcript_acl c
           WHERE c.vector_id = vei.vector_id
        )`
  )
    .bind(ctx.orgId)
    .first<{ cnt: number }>();

  return jsonResponse({
    rows_processed: processed,
    rows_remaining: finalRemaining?.cnt || 0,
    rows_already_migrated: alreadyMigrated,
    rows_missing_in_vectorize: missingInVectorize,
    errors,
  });
}

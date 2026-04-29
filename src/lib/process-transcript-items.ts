// Wave 4: shared post-receipt pipeline for Firefly transcripts — the single
// source of truth for what happens to a batch of transcript items between
// "we have the data" and "the meeting is durable + searchable + extracted".
//
// Two callers route through this helper (Phases B+C):
//   1. processFireflyWebhook     (src/integrations/firefly.ts)
//   2. ingestTranscript          (src/handlers/firefly-backfill.ts)
//
// Mirrors the safety properties of processClassifiedItems for emails:
//   • Phase 1 bail — events INSERT must succeed AND read back canonical id by
//     firefly_event_id before any FK-bearing downstream rows are written.
//     If items_staged < items_total, the entire batch bails (Phase 2/3 skipped).
//   • Per-attendee ACL — transcript chunks get visibility='private' with
//     participant_user_ids = comma-separated internal user_ids resolved from
//     event_attendees.user_id (matches the email ACL pattern). Speakers
//     without email matches do NOT grant ACL.
//   • sync_jobs lifecycle — one row per call, workflow_type per ctx.sourcePath.
//     Closes with status (`completed` | `partial` | `failed`) and counters in
//     metadata; errors_sample mirrors the structural-fix pattern.
//   • errors_sample — { phase, message } truncated to 500 chars, capped at 5.

import type { Env } from '../types/env';
import type { ChunkMetadata, SpeakerTurn } from '../types/interfaces';

export interface TranscriptItem {
  /** Firefly's transcript id — natural external key for race-safe read-back. */
  fireflyEventId: string;
  title: string;
  /** ISO-8601. */
  startTime: string;
  endTime: string | null;
  /** R2 path. Caller must have already PUT the transcript content. Null when
   *  there is no transcript content at all. */
  transcriptR2Key: string | null;
  /** Raw transcript text — used for length-gating signal extraction. */
  transcriptText: string | null;
  participants: Array<{
    displayName: string | null;
    email: string | null;
  }>;
  summaryOverview: string | null;
  /** Already an array of bullets. Caller normalizes. */
  actionItems: string[];
  /** Already an array of keywords/topics. Caller normalizes. */
  topics: string[];
  /** Pre-parsed speaker turns. Backfill builds these from sentences[];
   *  webhook builds them from "Speaker Name: text" line splitting. Empty
   *  array when no transcript content. */
  speakerTurns: SpeakerTurn[];
}

export interface ProcessTranscriptContext {
  orgId: string;
  /** Drives sync_jobs.workflow_type. */
  sourcePath: 'firefly-webhook' | 'firefly-backfill';
}

export interface TranscriptStats {
  items_total: number;
  /** Events INSERT succeeded AND canonical id read back by firefly_event_id. */
  items_staged: number;
  attendees_linked: number;
  chunks_embedded: number;
  /** Count of items where extractAndRouteSignals returned a non-null outcome. */
  signals_extracted: number;
  errors: Array<{ phase: string; error: string }>;
  /** Canonical event ids for the items that staged. Callers can use these
   *  for follow-up work (e.g. webhook-consumer's eager extract path before
   *  it routed through this helper). */
  staged_event_ids: string[];
  /** sync_jobs.id created at the start of the call. */
  sync_job_id: string;
}

function emptyStats(syncJobId: string): TranscriptStats {
  return {
    items_total: 0,
    items_staged: 0,
    attendees_linked: 0,
    chunks_embedded: 0,
    signals_extracted: 0,
    errors: [],
    staged_event_ids: [],
    sync_job_id: syncJobId,
  };
}

/**
 * Run the full receive-to-extracted pipeline on a batch of Firefly transcript
 * items. The single source of truth for "what happens to a transcript between
 * 'we have the data' and 'the meeting is durable + searchable + extracted'."
 *
 * Both Firefly callers route through this helper:
 *   - processFireflyWebhook        (src/integrations/firefly.ts)
 *   - ingestTranscript (backfill)  (src/handlers/firefly-backfill.ts)
 *
 * Phases run sequentially:
 *
 *   1. Stage events — `INSERT OR IGNORE INTO events` then read back the
 *      canonical id by `firefly_event_id`. The read-back is race-safe: if a
 *      concurrent caller (or an earlier delivery of the same webhook)
 *      already inserted a row, our INSERT no-ops and the read-back resolves
 *      to the winner's id. All FK-bearing downstream work attaches to that
 *      canonicalId, which may differ from the locally-generated candidate
 *      UUID we tried to insert. Race occurrences are logged at WARN level
 *      ("firefly_event_id race: ...") so operators can monitor frequency.
 *
 *   2. Per-item: attendees → chunks → reconcile (best-effort).
 *      Attendees: `event_attendees` rows with `user_id` set when the email
 *      matches an internal users row, contact_id otherwise (auto-creating
 *      contacts via autoCreateContactFromAttendee for unknown attendees).
 *      Chunks: speaker-turn chunking (1024 tokens, dynamic overlap) with
 *      `visibility='private'` + `participant_user_ids` = comma-sep internal
 *      user_ids. Speakers without internal-email matches do NOT grant ACL.
 *      Reconciliation: best-effort match against existing Outlook calendar
 *      events; failure is logged but doesn't enter stats.errors.
 *
 *   3. Signal extraction — `extractAndRouteSignals(canonicalId, ...)` per
 *      staged item. No race: we receive the canonical id directly from
 *      Phase 1, replacing the legacy webhook-consumer's "find latest event
 *      ORDER BY created_at LIMIT 1" pattern that could attribute signals
 *      to the wrong event under concurrent delivery.
 *
 * Phase 1 bail: if `items_staged < items_total` after the staging loop,
 * Phases 2 and 3 are skipped for the entire batch. Mirrors the structural-
 * fix philosophy from Outlook ingestion: never write FK-bearing rows
 * (event_attendees, vector_entity_index) when the parent set is incomplete.
 *
 * Failure semantics — IMPORTANT for callers:
 *
 *   • This helper does NOT throw on Phase 2 or Phase 3 errors. Per-item,
 *     per-phase errors are caught, pushed into `stats.errors[]`, and
 *     persisted to `sync_jobs.metadata.errors_sample` (capped at 5 entries
 *     × 500 chars). Callers wanting per-transcript failure visibility
 *     beyond Phase 1 must read sync_jobs.metadata; the return value's
 *     `staged_event_ids[]` only confirms Phase 1 succeeded.
 *
 *   • Throws are reserved for catastrophic conditions (e.g. an unhandled
 *     D1 error inside the staging loop's outer try). Even then the
 *     `finally` block calls `closeSyncJob` so the row never sits in
 *     `running` indefinitely.
 *
 * sync_jobs lifecycle:
 *
 *   • One row per call. `workflow_type = ctx.sourcePath` ('firefly-webhook'
 *     or 'firefly-backfill'). Status starts 'running' and closes to one of
 *     'completed' (no errors), 'partial' (some errors but at least one item
 *     staged), or 'failed' (zero items staged).
 *
 *   • Counter accumulation uses `json_patch` (single-call replacement) at
 *     close time rather than per-phase increments — the helper holds stats
 *     in-memory across phases and writes once. Differs from Outlook's
 *     `persistClassifiedStats` which uses `json_set + COALESCE` for
 *     accumulation across multiple chunk-workflow steps; that's
 *     intentional — transcripts process as a single batch, no chunking.
 *
 *   • `error_message` column on the row is populated from
 *     `errors_sample[0].message` when status is 'failed' so the row is
 *     diagnosable from sync_jobs UI listings without unpacking metadata.
 *
 * Idempotency: callers are responsible for de-duplicating before calling.
 * The webhook gates on KV `webhook_idem:{key}` 24h TTL; backfill does a
 * `firefly_event_id`-and-fuzzy-title pre-check. The helper itself relies
 * on the events.firefly_event_id UNIQUE constraint as a safety net via
 * Phase 1's read-back.
 *
 * @param items   Pre-shaped transcript items. Caller writes R2 first; the
 *                helper takes the R2 key as input.
 * @param ctx     orgId + sourcePath (drives sync_jobs.workflow_type).
 * @param env     Worker bindings.
 * @returns       Stats with per-phase counters, errors[], staged canonical
 *                event ids, and the sync_jobs row id.
 */
export async function processTranscriptItems(
  items: TranscriptItem[],
  ctx: ProcessTranscriptContext,
  env: Env
): Promise<TranscriptStats> {
  const syncJobId = crypto.randomUUID();
  const stats = emptyStats(syncJobId);
  stats.items_total = items.length;

  const startedAt = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, metadata)
     VALUES (?, ?, ?, 'running', ?, ?)`
  )
    .bind(
      syncJobId,
      ctx.orgId,
      ctx.sourcePath,
      startedAt,
      JSON.stringify({ items_total: items.length, source_path: ctx.sourcePath })
    )
    .run()
    .catch((e: any) => {
      console.error(
        `[process-transcript] sync_jobs insert failed for ${syncJobId}:`,
        e?.message || e
      );
    });

  if (items.length === 0) {
    await closeSyncJob(syncJobId, 'completed', stats, env);
    return stats;
  }

  try {
    // ── PHASE 1 — Stage events. INSERT OR IGNORE → read back canonical id. ──
    // Race-safe: if a concurrent caller wins the firefly_event_id UNIQUE, our
    // INSERT no-ops and the read-back returns the winner's id. Either way,
    // canonicalId is the row to attach all FK-bearing downstream work to.
    const stagedItems: Array<{ item: TranscriptItem; canonicalId: string }> = [];

    for (const item of items) {
      try {
        const candidateId = crypto.randomUUID();
        const insertNow = new Date().toISOString();
        await env.D1.prepare(
          `INSERT OR IGNORE INTO events
             (id, org_id, title, event_type, start_time, end_time,
              source, firefly_event_id, reconciliation_status,
              transcript_r2_key, transcript_source,
              summary, action_items, topics_discussed,
              created_at, updated_at)
           VALUES (?, ?, ?, 'meeting', ?, ?,
                   'firefly', ?, 'pending_reconciliation',
                   ?, 'firefly',
                   ?, ?, ?,
                   ?, ?)`
        )
          .bind(
            candidateId,
            ctx.orgId,
            item.title,
            item.startTime,
            item.endTime,
            item.fireflyEventId,
            item.transcriptR2Key,
            item.summaryOverview,
            JSON.stringify(item.actionItems || []),
            JSON.stringify(item.topics || []),
            insertNow,
            insertNow
          )
          .run();

        const canonical = await env.D1.prepare(
          `SELECT id FROM events
             WHERE org_id = ? AND firefly_event_id = ? AND deleted_at IS NULL
             LIMIT 1`
        )
          .bind(ctx.orgId, item.fireflyEventId)
          .first<{ id: string }>();

        if (!canonical?.id) {
          stats.errors.push({
            phase: 'stage',
            error: `${item.fireflyEventId}: events INSERT no-op'd and read-back returned no row`,
          });
          continue;
        }

        // Race-detection log: when canonical id differs from the candidate
        // we generated, INSERT OR IGNORE no-op'd because a concurrent caller
        // (or earlier delivery of this same firefly_event_id) won the
        // UNIQUE constraint first. The read-back correctly resolved to the
        // winner's row; downstream FK-bearing work attaches to canonicalId.
        // Operators can grep for this log to see how often the race fires
        // in production.
        if (canonical.id !== candidateId) {
          console.warn(
            `[process-transcript] firefly_event_id race: ` +
            `firefly_event_id=${item.fireflyEventId} ` +
            `candidate=${candidateId} canonical=${canonical.id} ` +
            `sync_job=${syncJobId} source=${ctx.sourcePath}`
          );
        }

        stats.items_staged += 1;
        stagedItems.push({ item, canonicalId: canonical.id });
        stats.staged_event_ids.push(canonical.id);
      } catch (e: any) {
        stats.errors.push({
          phase: 'stage',
          error: `${item.fireflyEventId}: ${String(e?.message || e).slice(0, 500)}`,
        });
      }
    }

    // PHASE 1 BAIL — if any item failed staging, skip Phase 2/3 for the entire
    // batch. Mirrors the structural-fix philosophy: never write FK-bearing rows
    // (event_attendees, vector_entity_index) when the parent set is incomplete.
    if (stats.items_staged < stats.items_total) {
      console.warn(
        `[process-transcript] staging incomplete (${stats.items_staged}/${stats.items_total}) — bailing Phase 2/3 for batch sync_job=${syncJobId}`
      );
      return stats;
    }

    // ── PHASE 2 — Per-item: attendees, chunks (per-attendee ACL), reconcile. ──
    for (const { item, canonicalId } of stagedItems) {
      const internalUserIds: string[] = [];

      // Attendees — resolve to users + auto-create contacts; collect internal
      // user_ids for the per-attendee ACL we're about to write into vector
      // metadata. Only event_attendees.user_id grants ACL — contact_id-only
      // attendees (external participants) do not.
      try {
        for (const p of item.participants) {
          const email = (p.email || '').toLowerCase().trim();
          if (!email) continue;
          const displayName =
            p.displayName?.trim() || email.split('@')[0];

          const user = await env.D1.prepare(
            `SELECT id FROM users
               WHERE LOWER(email) = ? AND org_id = ? AND deleted_at IS NULL
               LIMIT 1`
          )
            .bind(email, ctx.orgId)
            .first<{ id: string }>();

          let contactId: string | null = null;
          if (!user) {
            const { autoCreateContactFromAttendee } = await import('./firefly-intelligence');
            const auto = await autoCreateContactFromAttendee({
              email,
              displayName,
              orgId: ctx.orgId,
              env,
            });
            if (auto) contactId = auto.contactId;
          }

          if (user) internalUserIds.push(user.id);

          await env.D1.prepare(
            `INSERT OR IGNORE INTO event_attendees
               (event_id, contact_id, user_id, email, display_name, role, is_internal)
             VALUES (?, ?, ?, ?, ?, 'attendee', ?)`
          )
            .bind(
              canonicalId,
              contactId,
              user?.id || null,
              email,
              displayName,
              user ? 1 : 0
            )
            .run();

          stats.attendees_linked += 1;
        }
      } catch (e: any) {
        stats.errors.push({
          phase: 'attendees',
          error: `${canonicalId}: ${String(e?.message || e).slice(0, 500)}`,
        });
      }

      // Co-meeting graph (best-effort, not part of error budget — per-pair
      // INSERT OR IGNORE means a partial failure is recoverable on retry).
      try {
        const { autoLinkAttendees } = await import('./associations');
        await autoLinkAttendees(canonicalId, ctx.orgId, env);
      } catch (e: any) {
        console.error(
          `[process-transcript] autoLinkAttendees failed event=${canonicalId}:`,
          e?.message || e
        );
      }

      // Chunk + embed transcript with per-attendee ACL.
      // visibility='private' + participant_user_ids = comma-sep internal
      // user_ids matches the email ACL pattern. If internalUserIds is empty
      // (all-external meeting), the meeting will be invisible to all org users
      // — flag the surprise but persist faithfully; this is the strict
      // semantic the user asked for.
      if (
        item.transcriptR2Key &&
        item.transcriptText &&
        item.transcriptText.length > 0 &&
        item.speakerTurns.length > 0
      ) {
        if (internalUserIds.length === 0) {
          console.warn(
            `[process-transcript] event=${canonicalId} has zero internal attendees — chunks will be invisible to all users`
          );
        }
        try {
          const { chunkTranscriptBySpeakerTurns, determineOverlapTurns } = await import('./chunking');
          const { chunkEmbedAndPersist } = await import('./embedding');

          const overlapTurns = determineOverlapTurns(item.speakerTurns);
          const chunks = chunkTranscriptBySpeakerTurns(item.speakerTurns, 1024, overlapTurns);
          const participantUserIdsStr = internalUserIds.join(',');
          const chunkCreatedAt = new Date().toISOString();

          for (let i = 0; i < chunks.length; i++) {
            const meta: ChunkMetadata = {
              org_id: ctx.orgId,
              document_type: 'transcript',
              source_table: 'events',
              source_id: canonicalId,
              r2_key: item.transcriptR2Key,
              visibility: 'private',
              participant_user_ids: participantUserIdsStr,
              primary_entity_id: canonicalId,
              created_at: chunkCreatedAt,
              entity_name: item.title,
              date: item.startTime,
              speakers: chunks[i].speakers.join(','),
              primary_speaker: chunks[i].primary_speaker,
            };

            const entry = await chunkEmbedAndPersist(
              chunks[i].text,
              meta,
              i,
              chunks.length,
              env
            );

            await env.D1.prepare(
              'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
            )
              .bind(entry.vectorId, entry.entityId, entry.sourceTable, entry.orgId)
              .run();

            stats.chunks_embedded += 1;
          }
        } catch (e: any) {
          stats.errors.push({
            phase: 'embed',
            error: `${canonicalId}: ${String(e?.message || e).slice(0, 500)}`,
          });
        }
      }

      // Outlook reconciliation (best-effort — same pattern as the legacy
      // path; reconcileFireflyWithoutId handles its own no-match path by
      // leaving reconciliation_status='pending_reconciliation' or moving it
      // to 'standalone' / 'reconciled').
      try {
        const { reconcileFireflyWithoutId } = await import('./reconciliation');
        await reconcileFireflyWithoutId(
          {
            id: canonicalId,
            firefly_event_id: item.fireflyEventId,
            start_time: item.startTime,
            transcript_r2_key: item.transcriptR2Key,
          },
          ctx.orgId,
          env
        );
      } catch (e: any) {
        console.error(
          `[process-transcript] reconciliation failed event=${canonicalId}:`,
          e?.message || e
        );
      }
    }

    // ── PHASE 3 — Signal extraction on canonical event ids (no race). ──
    // Replaces the webhook-consumer's "find latest event by ORDER BY created_at"
    // race with a direct call against the canonical id.
    for (const { item, canonicalId } of stagedItems) {
      if (!item.transcriptText || item.transcriptText.length < 100) continue;
      try {
        const { extractAndRouteSignals } = await import('./firefly-intelligence');
        const outcome = await extractAndRouteSignals(canonicalId, ctx.orgId, env);
        if (outcome) stats.signals_extracted += 1;
      } catch (e: any) {
        stats.errors.push({
          phase: 'extract-signals',
          error: `${canonicalId}: ${String(e?.message || e).slice(0, 500)}`,
        });
      }
    }

    return stats;
  } finally {
    const status: 'completed' | 'partial' | 'failed' =
      stats.errors.length === 0
        ? 'completed'
        : stats.items_staged === 0
          ? 'failed'
          : 'partial';
    await closeSyncJob(syncJobId, status, stats, env);
  }
}

async function closeSyncJob(
  syncJobId: string,
  status: 'completed' | 'partial' | 'failed',
  stats: TranscriptStats,
  env: Env
): Promise<void> {
  const errorsSample = stats.errors.slice(0, 5).map(e => ({
    phase: e.phase,
    message: String(e.error).slice(0, 500),
  }));

  const metadataPatch = JSON.stringify({
    items_total: stats.items_total,
    items_staged: stats.items_staged,
    attendees_linked: stats.attendees_linked,
    chunks_embedded: stats.chunks_embedded,
    signals_extracted: stats.signals_extracted,
    staged_event_ids: stats.staged_event_ids,
    errors_sample: errorsSample,
  });

  const completedAt = new Date().toISOString();
  const errorMessage =
    status === 'failed'
      ? errorsSample[0]?.message?.slice(0, 500) || 'no items staged'
      : null;

  await env.D1.prepare(
    `UPDATE sync_jobs
        SET status = ?,
            completed_at = ?,
            error_message = ?,
            metadata = json_patch(COALESCE(metadata, '{}'), ?)
      WHERE id = ?`
  )
    .bind(status, completedAt, errorMessage, metadataPatch, syncJobId)
    .run()
    .catch((e: any) => {
      console.error(
        `[process-transcript] closeSyncJob failed for ${syncJobId}:`,
        e?.message || e
      );
    });
}

// Phase 6 1a (2026-05-05) — embed_retry domain handler.
//
// First domain pilot for the universal work_queue substrate (Phase 5).
// Replaces the per-domain handcrafted drain loop at
// src/lib/daily-cron.ts:processEmbedRetryQueue with a Phase 5
// WorkQueueHandler. The actual embedding work still happens via
// embedSingleItem (now exported from daily-cron.ts) — only the queue
// state machine, retry/backoff, and circuit-breaker gating change.
//
// What's the same vs the prior drain:
//   • Per-source-table dispatch (conversations / events / documents)
//     happens inside embedSingleItem; this handler just decodes the
//     payload and forwards.
//   • recordUsage / recordRateLimit on bge stay live so the ledger's
//     window mechanics + auto-tune-DOWN keep working.
//   • 'missing' return value is a clean completion (no retry needed —
//     entity is gone). Same as the prior drain's DELETE-on-missing.
//
// What's different:
//   • Status state machine — work_queue's 5-state model (pending →
//     in_progress → completed/failed/dead_letter) replaces
//     embed_retry_queue's 3-state model. failed_permanent → dead_letter.
//   • Retry cadence — work_queue's three-tier backoff [5min, 30min]
//     replaces the implicit "next daily run" cadence. Faster healing
//     under healthy operation; bge circuit filter prevents fast retries
//     from compounding rate-limit incidents.
//   • Circuit gating — claimNextBatch filters claims by upstream-circuit
//     OPEN set BEFORE selection (one D1 read per tick), eliminating the
//     per-item checkBudget call inside the loop. Subrequest savings.
//   • Lock TTL — claim's 5-min locked_until window + heartbeat-eligible
//     mid-handler. Embed work caps at 60s per item, so the lock is
//     comfortably oversized.

import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { recordUsage, recordRateLimit } from '../upstream-budget';
import { embedDocumentItem, embedSingleItem } from '../daily-cron';
import { enqueueDocumentEmbeddingRepair } from '../document-embedding';
import { isDeterministicVectorizePayloadError } from '../embedding';
import { deadLetterWork } from '../work-queue';

interface EmbedRetryPayload {
  entity_id: string;
  source_table: 'conversations' | 'events' | 'documents';
  cursor?: number | null;
  audit_key?: string | null;
}

const DOCUMENT_CHUNKS_PER_WORK_ITEM = 25;

const TRANSIENT_RATE_LIMIT_PATTERNS = [
  'EMBED_RATE_LIMIT_TIMEOUT',
  '429',
  'rate_limit',
];

async function markVectorizePayloadQuarantined(
  env: Env,
  itemId: string,
  orgId: string,
  payload: EmbedRetryPayload,
  error: string
): Promise<void> {
  if (payload.source_table !== 'documents') return;
  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = json_set(
              CASE WHEN custom_fields IS NOT NULL AND json_valid(custom_fields)
                   THEN custom_fields ELSE '{}' END,
              '$.embedding_quarantined_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              '$.embedding_quarantine_code', 'vectorize_payload_quarantined',
              '$.embedding_quarantine_work_queue_id', ?,
              '$.embedding_quarantine_reason', ?
            ),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(itemId, error.slice(0, 500), payload.entity_id, orgId).run();
}

export const embedRetryHandler: WorkQueueHandler = {
  domain: 'embed_retry',

  // Conservative ≤10 per the Phase 5 standing rule. The prior drain ran
  // 200/daily-tick; minute-tick × 10 gives 14,400/day which dwarfs
  // realistic enqueue volume. If a domain ever genuinely backlogs >10
  // pending we still drain at full minute-tick cadence.
  batchSize: 10,

  cadence: 'minute',

  process: async (item, env) => {
    let payload: EmbedRetryPayload;
    try {
      payload = JSON.parse(item.payload) as EmbedRetryPayload;
    } catch (e) {
      // Malformed payload is structurally fatal — no point retrying.
      // Throw a sentinel that the driver's failWork path treats as
      // unrecoverable on first attempt by setting attempt to max.
      // (failWork will dead-letter on attempt >= max_attempts; this row
      // already has attempt 0 so it will retry twice before dead-letter.
      // Future Phase 6.x could add an explicit deadLetterWork call here.)
      throw new Error(`malformed payload: ${e instanceof Error ? e.message : String(e)}`);
    }

    const { entity_id, source_table } = payload;
    if (!entity_id || !source_table) {
      throw new Error(`payload missing entity_id or source_table: ${item.payload}`);
    }

    try {
      if (source_table === 'documents') {
        const result = await embedDocumentItem(
          entity_id,
          item.org_id,
          env,
          Math.max(0, payload.cursor || 0),
          DOCUMENT_CHUNKS_PER_WORK_ITEM
        );

        if (result.status === 'partial') {
          const nextCursor = result.next_cursor ?? 0;
          await enqueueDocumentEmbeddingRepair(
            env,
            item.org_id,
            entity_id,
            { cursor: nextCursor, auditKey: payload.audit_key || item.id, priority: item.priority }
          );
        }

        if ((result.embedded_chunks || 0) > 0) {
          await recordUsage(env, item.org_id, null, 'bge', 'per_second');
        }
        return;
      }

      // embedSingleItem returns 'embedded' | 'skipped' | 'missing'. All
      // three are non-retryable success terminals — driver's completeWork
      // path runs after we return.
      //   • 'embedded' — vectors freshly written
      //   • 'skipped'  — vectors already present (dedup guard hit)
      //   • 'missing'  — source row gone (deleted since enqueue); no
      //                  work to do, terminal.
      await embedSingleItem(entity_id, source_table, item.org_id, env);
      // Success → bump bge usage so the ledger's window/cap mechanics
      // see the call. Mirrors the prior drain's recordUsage call.
      await recordUsage(env, item.org_id, null, 'bge', 'per_second');
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (isDeterministicVectorizePayloadError(e)) {
        const quarantineMessage = `vectorize_payload_quarantined: entity=${source_table}:${entity_id} ${errMsg}`.slice(0, 900);
        await markVectorizePayloadQuarantined(env, item.id, item.org_id, payload, quarantineMessage);
        await deadLetterWork(env, item.id, quarantineMessage);
        return;
      }

      // Rate-limit detection — same shape patterns as the prior drain.
      // Trips the bge ledger's 429 counter; on 3 consecutive 429s the
      // circuit opens for 30min and Phase 5's claimNextBatch will skip
      // bge-tagged claims until it closes.
      if (TRANSIENT_RATE_LIMIT_PATTERNS.some(p => errMsg.includes(p))) {
        await recordRateLimit(env, item.org_id, null, 'bge', 'per_second');
      }
      // Re-throw so the driver routes through failWork (3-tier backoff
      // or dead_letter at attempt >= max_attempts).
      throw e;
    }
  },
};

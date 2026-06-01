// Wave 2: shared post-classify pipeline — the single source of truth for
// what happens to a batch of classified items between "we know what they
// are" and "they're durable + searchable + linked".
//
// Two callers live above this helper:
//   1. IngestionChunkWorkflow.run() — hourly delta-sync via Cloudflare
//      Workflows. Wraps this call in one step.do() for durability.
//   2. runHistoricalBackfill() in src/integrations/outlook.ts — inline page-
//      loop backfill running under a 25s CPU budget. Calls per page so the
//      budget per call stays bounded.
//
// Before Wave 2 these two paths each re-implemented stage-and-commit, embed,
// process-attachments, and detect-deals — and they drifted: the inline path
// silently skipped both process-attachments AND detect-deals, which is why
// 85 declared email attachments produced 0 documents rows. Diagnostic 1
// pinned the cause; this helper fixes it by making "the right step set" a
// single function both paths must call.

import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';

export interface ProcessClassifiedContext {
  orgId: string;
  /** Used for stage-and-commit's audit trail. Inline-backfill passes a synthetic key (`backfill-${userId}`). */
  syncJobId: string;
  ingestionMode?: 'live' | 'backfill';
}

export interface ProcessClassifiedStats {
  items_total: number;
  items_staged: number;
  items_embedded: number;
  embed_failures: number;
  attachments_attempted: number;
  attachments_processed: number;
  attachments_skipped: number;
  attachments_failed: number;
  deal_signals_staged: number;
  deal_candidates_seen: number;
  deal_candidates_scanned: number;
  deal_candidates_deferred: number;
  deal_skip_reasons: Record<string, number>;
  prospect_signals_recorded: number;
  prospects_upserted: number;
  prospect_classifications_pending: number;
  errors: Array<{ phase: string; error: string }>;
}

function emptyStats(): ProcessClassifiedStats {
  return {
    items_total: 0,
    items_staged: 0,
    items_embedded: 0,
    embed_failures: 0,
    attachments_attempted: 0,
    attachments_processed: 0,
    attachments_skipped: 0,
    attachments_failed: 0,
    deal_signals_staged: 0,
    deal_candidates_seen: 0,
    deal_candidates_scanned: 0,
    deal_candidates_deferred: 0,
    deal_skip_reasons: {},
    prospect_signals_recorded: 0,
    prospects_upserted: 0,
    prospect_classifications_pending: 0,
    errors: [],
  };
}

/**
 * Run the full post-classify step set on a batch of classified items.
 *
 * Phases run sequentially:
 *   1. stage-and-commit  — write conversations + per-entity associations to D1
 *   2. chunk-and-embed   — split + embed each item's text, write vector rows
 *   3. process-attachments — Graph fetch + persist email attachments as docs
 *   4. detect-deals      — LLM-screen for deal-signal candidates, stage them
 *   5. detect-prospects  — deterministic prospect mentions/signals, no holds
 *
 * Per-item failures within a phase are caught + counted in stats, not
 * rethrown — a single bad item can't take down the rest of the batch. The
 * caller decides what to do with stats.errors (chunk workflow persists into
 * sync_jobs.metadata; inline backfill console.logs).
 */
export async function processClassifiedItems(
  classified: ClassifiedItem[],
  ctx: ProcessClassifiedContext,
  env: Env
): Promise<ProcessClassifiedStats> {
  const stats = emptyStats();
  stats.items_total = classified.length;
  if (classified.length === 0) return stats;

  // Phase 1 — stage and commit. Wrapped in try/catch because a transient FK
  // race inside contact-association inserts shouldn't fail the whole batch.
  try {
    const { stageAndCommitApprovals } = await import('./stage-approvals');
    await stageAndCommitApprovals(classified, ctx.orgId, ctx.syncJobId, env);
    stats.items_staged = classified.length;
  } catch (e: any) {
    stats.errors.push({ phase: 'stage-and-commit', error: e?.message || String(e) });
  }

  // If Phase 1 didn't stage every item, abort the rest of the pipeline.
  // Phases 2-4 write rows that REFERENCE conversations (vector_entity_index,
  // documents.conversation_id, deal_signals_staged.source_conversation_id);
  // running them when stage-and-commit threw produces dangling rows pointing
  // at conversation IDs that don't exist. Diagnostic 2026-04-29 found 13
  // dangling email_attachment docs created in 6 minutes from a single
  // staged=0/28 batch. Bail here so we never make that mistake again.
  if (stats.items_staged < classified.length) {
    console.error(
      `[ingestion-shared] Phase 1 partial-fail: staged=${stats.items_staged}/${classified.length} for syncJob=${ctx.syncJobId}. ` +
      `Skipping phases 2-4 to avoid dangling references. ` +
      `errors=${JSON.stringify(stats.errors.slice(0, 3))}`
    );
    return stats;
  }

  // Phase 2 — chunk + embed. Per-item try/catch so a single bad text payload
  // (extraction error, AI rate-limit) doesn't drop the others. The hourly
  // self-heal cron (backfillUnembeddedConversations + embed_retry_queue)
  // catches anything that fails here.
  {
    const { chunkEmbedAndPersistAll } = await import('./embedding');
    for (const item of classified) {
      try {
        const entries = await chunkEmbedAndPersistAll(item.text, item.metadata, env);
        if (entries.length > 0) {
          await env.D1.batch(
            entries.map(e =>
              env.D1.prepare(
                'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
              ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
            )
          );
        }
        stats.items_embedded += 1;
      } catch (e: any) {
        stats.embed_failures += 1;
        stats.errors.push({ phase: 'embed', error: `${item.entityId}: ${e?.message || e}` });
      }
    }
  }

  // Phase 3 — process attachments. THIS is the step that was missing from
  // inline-backfill (Diagnostic 1 finding). After this helper ships, both
  // paths run it. processEmailAttachments is internally idempotent on
  // content_hash so a re-run over the same window is safe.
  {
    const { processEmailAttachments } = await import('./attachment-processor');
    for (const item of classified) {
      if (item.attachments?.length) {
        stats.attachments_attempted += item.attachments.length;
        try {
          const r = await processEmailAttachments(item, ctx.orgId, env);
          stats.attachments_processed += r.documents_created;
          stats.attachments_skipped += r.documents_skipped;
          stats.attachments_failed += r.errors.length;
          for (const err of r.errors) {
            stats.errors.push({ phase: 'process-attachments', error: err });
          }
        } catch (e: any) {
          stats.attachments_failed += item.attachments.length;
          stats.errors.push({ phase: 'process-attachments', error: `${item.entityId}: ${e?.message || e}` });
        }
      }
    }
  }

  // Phase 4 — detect deals. Also missing from inline-backfill before Wave 2.
  // detectAndStageDealSignalsDetailed scans the first 20 candidates inline and
  // enqueues overflow to deal_evidence_detect so budget caps are visible and
  // recoverable instead of silently dropping deal-looking sources.
  try {
    const { detectAndStageDealSignalsDetailed } = await import('./deal-detection');
    const dealStats = await detectAndStageDealSignalsDetailed(classified, ctx.orgId, env);
    stats.deal_signals_staged = dealStats.deal_signals_staged;
    stats.deal_candidates_seen = dealStats.deal_candidates_seen;
    stats.deal_candidates_scanned = dealStats.deal_candidates_scanned;
    stats.deal_candidates_deferred = dealStats.deal_candidates_deferred;
    stats.deal_skip_reasons = dealStats.deal_skip_reasons;
  } catch (e: any) {
    stats.errors.push({ phase: 'detect-deals', error: e?.message || String(e) });
  }

  // Phase 5 — detect prospects. This path deliberately records uncertainty as
  // recoverable entity metadata.
  try {
    const {
      detectAndRecordProspectSignals,
      recordProspectBackfillCoverage,
    } = await import('./prospect-intelligence');
    const ingestionMode = ctx.ingestionMode || (ctx.syncJobId.includes('backfill') ? 'backfill' : 'live');
    const prospectStats = await detectAndRecordProspectSignals(classified, ctx.orgId, env, {
      ingestionMode,
    });
    stats.prospect_signals_recorded = prospectStats.signals_recorded;
    stats.prospects_upserted = prospectStats.prospects_upserted;
    stats.prospect_classifications_pending = prospectStats.classifications_pending;
    for (const err of prospectStats.errors) {
      stats.errors.push({ phase: 'detect-prospects', error: `${err.item_id}: ${err.error}` });
    }
    if (ingestionMode === 'backfill') {
      const bySource = new Map<string, ClassifiedItem[]>();
      for (const item of classified) {
        const key = item.source || item.type || 'unknown';
        const bucket = bySource.get(key) || [];
        bucket.push(item);
        bySource.set(key, bucket);
      }
      for (const [sourceFamily, items] of bySource) {
        const dates = items
          .map(item => item.sentAt)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .sort();
        if (dates.length === 0) continue;
        await recordProspectBackfillCoverage(ctx.orgId, env, {
          sourceFamily,
          windowStart: dates[0],
          windowEnd: dates[dates.length - 1],
          itemsScanned: items.length,
          signalsRecorded: prospectStats.signals_recorded,
          prospectsUpserted: prospectStats.prospects_upserted,
          classificationsPending: prospectStats.classifications_pending,
          status: prospectStats.errors.length > 0 ? 'partial' : 'completed',
          error: prospectStats.errors[0]?.error || null,
        });
      }
    }
  } catch (e: any) {
    stats.errors.push({ phase: 'detect-prospects', error: e?.message || String(e) });
  }

  return stats;
}

/**
 * Persist a stats batch into sync_jobs.metadata. Counters accumulate across
 * chunks via json_set + COALESCE so each chunk increments without clobbering
 * its siblings'. Safe to call when stats has zero counters; will no-op if no
 * fields would change.
 */
export async function persistClassifiedStats(
  stats: ProcessClassifiedStats,
  syncJobId: string,
  env: Env
): Promise<void> {
  const hasAny =
    stats.items_total > 0 ||
    stats.attachments_attempted > 0 ||
    stats.deal_signals_staged > 0 ||
    stats.deal_candidates_seen > 0 ||
    stats.deal_candidates_deferred > 0 ||
    stats.prospect_signals_recorded > 0 ||
    stats.prospect_classifications_pending > 0 ||
    stats.embed_failures > 0 ||
    stats.errors.length > 0;
  if (!hasAny) return;

  try {
    await env.D1.prepare(
      `UPDATE sync_jobs
          SET metadata = json_set(
            COALESCE(metadata, '{}'),
            '$.items_total',           COALESCE(json_extract(metadata, '$.items_total'),           0) + ?,
            '$.items_staged',          COALESCE(json_extract(metadata, '$.items_staged'),          0) + ?,
            '$.items_embedded',        COALESCE(json_extract(metadata, '$.items_embedded'),        0) + ?,
            '$.embed_failures',        COALESCE(json_extract(metadata, '$.embed_failures'),        0) + ?,
            '$.attachments_attempted', COALESCE(json_extract(metadata, '$.attachments_attempted'), 0) + ?,
            '$.attachments_processed', COALESCE(json_extract(metadata, '$.attachments_processed'), 0) + ?,
            '$.attachments_skipped',   COALESCE(json_extract(metadata, '$.attachments_skipped'),   0) + ?,
            '$.attachments_failed',    COALESCE(json_extract(metadata, '$.attachments_failed'),    0) + ?,
            '$.deal_signals_staged',   COALESCE(json_extract(metadata, '$.deal_signals_staged'),   0) + ?,
            '$.deal_candidates_seen',   COALESCE(json_extract(metadata, '$.deal_candidates_seen'),   0) + ?,
            '$.deal_candidates_scanned', COALESCE(json_extract(metadata, '$.deal_candidates_scanned'), 0) + ?,
            '$.deal_candidates_deferred', COALESCE(json_extract(metadata, '$.deal_candidates_deferred'), 0) + ?,
            '$.prospect_signals_recorded', COALESCE(json_extract(metadata, '$.prospect_signals_recorded'), 0) + ?,
            '$.prospects_upserted',    COALESCE(json_extract(metadata, '$.prospects_upserted'),    0) + ?,
            '$.prospect_classifications_pending', COALESCE(json_extract(metadata, '$.prospect_classifications_pending'), 0) + ?
          )
        WHERE id = ?`
    ).bind(
      stats.items_total, stats.items_staged, stats.items_embedded, stats.embed_failures,
      stats.attachments_attempted, stats.attachments_processed, stats.attachments_skipped, stats.attachments_failed,
      stats.deal_signals_staged, stats.deal_candidates_seen, stats.deal_candidates_scanned, stats.deal_candidates_deferred,
      stats.prospect_signals_recorded, stats.prospects_upserted, stats.prospect_classifications_pending,
      syncJobId
    ).run();

    if (Object.keys(stats.deal_skip_reasons || {}).length > 0) {
      await env.D1.prepare(
        `UPDATE sync_jobs
            SET metadata = json_set(
              COALESCE(metadata, '{}'),
              '$.deal_skip_reasons',
              json(?)
            )
          WHERE id = ?`
      ).bind(JSON.stringify(stats.deal_skip_reasons), syncJobId).run();
    }

    // Persist error context for debugging. Latest-wins (no accumulation
    // across calls) — for the dangling-row diagnostic the first page's
    // error is usually the cascade root cause; if a later page also
    // fails we'd rather see its fresh state than wade through history.
    // Skip when there are no errors so we don't clobber a prior page's
    // useful context with an empty array.
    if (stats.errors.length > 0) {
      const errorsSample = stats.errors.slice(0, 5).map(e => ({
        phase: e.phase,
        message: String(e.error).slice(0, 500),
      }));
      await env.D1.prepare(
        `UPDATE sync_jobs
            SET metadata = json_set(COALESCE(metadata, '{}'), '$.errors_sample', json(?))
          WHERE id = ?`
      ).bind(JSON.stringify(errorsSample), syncJobId).run();
    }
  } catch (e: any) {
    console.error(`[ingestion-shared] persistClassifiedStats failed for ${syncJobId}:`, e?.message || e);
  }
}

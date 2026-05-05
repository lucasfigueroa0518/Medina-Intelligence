// Ingestion finalizer — runs once after every chunk worker has decremented
// the pending counter to zero. Bulk post-processing that touches all org
// data (relationship graph recompute, association scan, etc.) lives here so
// it doesn't multiply by chunk count.

import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { invalidateRagCache } from '../lib/cache';
import { reconcileOrphanContacts } from '../lib/contact-reconciliation';
import { emitAudit } from '../lib/audit';
import { trackedStep } from '../lib/workflow-telemetry';

console.log('[IngestionFinalizerWorkflow] module loaded');

interface FinalizerParams {
  org_id: string;
  sync_job_id: string;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export class IngestionFinalizerWorkflow extends WorkflowEntrypoint<Env, FinalizerParams> {
  async run(event: WorkflowEvent<FinalizerParams>, step: WorkflowStep): Promise<void> {
    const { org_id, sync_job_id } = event.payload;
    console.log(`[IngestionFinalizerWorkflow] start job=${sync_job_id}`);

    try {
      await trackedStep(
        this.env,
        step,
        sync_job_id,
        'invalidate-cache',
        { timeout: '60 seconds', retries: { limit: 1, delay: '5 seconds' } },
        async () => {
          await invalidateRagCache(org_id, this.env);
        }
      );

      await trackedStep(
        this.env,
        step,
        sync_job_id,
        'reconcile-orphan-contacts',
        { timeout: '300 seconds', retries: { limit: 1, delay: '10 seconds' } },
        async () => {
          try {
            const r = await reconcileOrphanContacts(org_id, this.env);
            console.log(
              `[IngestionFinalizerWorkflow] reconciliation: orphans=${r.orphan_contacts_scanned} links_inserted=${r.links_inserted} counter_updates=${r.contacts_with_counter_change}`
            );
          } catch (e) {
            console.error('[IngestionFinalizerWorkflow] reconciliation failed:', errMessage(e));
          }
        }
      );

      // Detect items that landed in D1 this run but never made it into
      // vector_entity_index (audit 2026-04-28 scale-up Fix 3). When an embed
      // throws after the 3 retries, the chunk's outer catch records it as
      // "completed" anyway, leaving the items D1-resident but invisible to
      // semantic search. Enqueue them so the daily cron (or the on-demand
      // /api/admin/process-embed-queue endpoint) can re-embed.
      await trackedStep(
        this.env,
        step,
        sync_job_id,
        'detect-embed-gaps',
        { timeout: '120 seconds', retries: { limit: 1, delay: '5 seconds' } },
        async () => {
          try {
            const startedAt = await this.env.D1.prepare(
              `SELECT started_at FROM sync_jobs WHERE id = ?`
            ).bind(sync_job_id).first<{ started_at: string }>();
            if (!startedAt?.started_at) return;

            const convoGaps = await this.env.D1.prepare(
              `SELECT c.id FROM conversations c
                 LEFT JOIN vector_entity_index vei
                        ON vei.entity_id = c.id
                       AND vei.source_table = 'conversations'
                       AND vei.org_id = c.org_id
                WHERE c.org_id = ?
                  AND c.created_at >= ?
                  AND vei.entity_id IS NULL`
            ).bind(org_id, startedAt.started_at).all<{ id: string }>();

            const eventGaps = await this.env.D1.prepare(
              `SELECT e.id FROM events e
                 LEFT JOIN vector_entity_index vei
                        ON vei.entity_id = e.id
                       AND vei.source_table = 'events'
                       AND vei.org_id = e.org_id
                WHERE e.org_id = ?
                  AND e.created_at >= ?
                  AND e.deleted_at IS NULL
                  AND vei.entity_id IS NULL`
            ).bind(org_id, startedAt.started_at).all<{ id: string }>();

            const docGaps = await this.env.D1.prepare(
              `SELECT d.id FROM documents d
                 LEFT JOIN vector_entity_index vei
                        ON vei.entity_id = d.id
                       AND vei.source_table = 'documents'
                       AND vei.org_id = d.org_id
                WHERE d.org_id = ?
                  AND d.created_at >= ?
                  AND d.deleted_at IS NULL
                  AND d.processing_status != 'skipped'
                  AND vei.entity_id IS NULL`
            ).bind(org_id, startedAt.started_at).all<{ id: string }>();

            const totalGaps = convoGaps.results.length + eventGaps.results.length + docGaps.results.length;

            if (totalGaps === 0) {
              console.log('[IngestionFinalizerWorkflow] detect-embed-gaps: clean run, no gaps');
              return;
            }

            console.warn(
              `[IngestionFinalizerWorkflow] detect-embed-gaps: ${convoGaps.results.length} conv + ${eventGaps.results.length} events + ${docGaps.results.length} docs missing vectors — enqueueing`
            );

            // Phase 6 1a (2026-05-05): write side now goes to work_queue
            // via enqueueWork. Pre-existing embed_retry_queue rows continue
            // to drain via daily-cron.processEmbedRetryQueue during the
            // 1a→1b transition. Idempotency_key mirrors the prior table's
            // UNIQUE(org_id, entity_id, source_table) so re-enqueue during
            // drain collapses cleanly.
            const { enqueueWork } = await import('../lib/work-queue');
            const enqueueGap = async (entity_id: string, source_table: string) => {
              await enqueueWork(this.env, org_id, 'embed_retry',
                { entity_id, source_table },
                {
                  upstream: 'bge',
                  idempotency_key: `${org_id}:${entity_id}:${source_table}`,
                }
              );
            };
            for (const g of convoGaps.results) await enqueueGap(g.id, 'conversations');
            for (const g of eventGaps.results) await enqueueGap(g.id, 'events');
            for (const g of docGaps.results) await enqueueGap(g.id, 'documents');

            await this.env.D1.prepare(
              `UPDATE sync_jobs SET metadata = json_set(
                  COALESCE(metadata, '{}'),
                  '$.embed_gaps_conversations', ?,
                  '$.embed_gaps_events', ?,
                  '$.embed_gaps_documents', ?,
                  '$.embed_gaps_total', ?
                ) WHERE id = ?`
            ).bind(
              convoGaps.results.length,
              eventGaps.results.length,
              docGaps.results.length,
              totalGaps,
              sync_job_id
            ).run();
          } catch (e) {
            console.error('[IngestionFinalizerWorkflow] detect-embed-gaps failed:', errMessage(e));
          }
        }
      );

      // Phase 0a-4 (2026-05-04): the four heavy org-wide bulk calcs
      // (relationship status, owners, comms patterns, associations) were
      // removed from this finalizer and migrated to daily-cron.
      //
      // Why: Terminal 5 forensic 2026-05-04 confirmed the finalizer was
      // consistently hitting the 1000-subrequest CF cap during these
      // calcs. recalculateAllAssociations alone iterates 500 contacts ×
      // ~10 association upserts each = ~5,000 D1 writes — cumulative
      // across the four calcs the finalizer routinely exceeded the
      // workflow's subreq budget. The cap-hit failed the finalizer
      // before mark-job-completed could run, leaving sync_jobs orphaned
      // in 'running'. The next ingestion's check-concurrency then
      // marked the orphan with a misleading "Timed out or interrupted
      // by deploy" string (a relic from when deploy interrupts were
      // the only orphan source — see ingestion.ts:93 fix in this PR).
      //
      // recalculateAllAssociations was already called from daily-cron
      // (line 55); the other three are added alongside it. Trade-off
      // accepted: these recomputes go from "after every ingestion"
      // (hourly) to "once per day" (24h cron). For background analytics
      // — relationship statuses, owners, comms patterns, associations —
      // that's fine. None feed user-facing realtime UI; they update
      // slow-changing entity-level fields.
      //
      // Net: finalizer wallclock drops from 30+ min worst case to
      // <5 min, and sync_jobs no longer gets stuck on calc-* failures.

      await trackedStep(
        this.env,
        step,
        sync_job_id,
        'trigger-post-ingest-enrichment',
        { timeout: '60 seconds' },
        async () => {
          const running = await this.env.D1.prepare(
            `SELECT id FROM sync_jobs
               WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running'
                 AND timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
          ).bind(org_id).first();
          if (running) {
            console.log('[IngestionFinalizerWorkflow] enrichment already in flight — skipping');
            return;
          }
          try {
            await this.env.ENRICHMENT_WORKFLOW.create({ params: { org_id } });
            console.log('[IngestionFinalizerWorkflow] post-ingest enrichment triggered');
          } catch (e) {
            console.error('[IngestionFinalizerWorkflow] enrichment trigger failed:', errMessage(e));
          }
        }
      );

      await trackedStep(this.env, step, sync_job_id, 'mark-job-completed', { timeout: '30 seconds' }, async () => {
        await this.env.D1.prepare(
          `UPDATE sync_jobs
             SET status = 'completed',
                 completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 metadata = json_set(COALESCE(metadata, '{}'), '$.finalized_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           WHERE id = ?`
        ).bind(sync_job_id).run();
        console.log(`[IngestionFinalizerWorkflow] job=${sync_job_id} marked completed`);
      });
    } catch (e) {
      console.error('[IngestionFinalizerWorkflow] FATAL:', errMessage(e));
      try {
        await this.env.D1.prepare(
          `UPDATE sync_jobs
             SET status = 'partial',
                 completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 error_message = ?
           WHERE id = ?`
        ).bind(`finalizer: ${errMessage(e).slice(0, 400)}`, sync_job_id).run();
        await emitAudit(this.env, {
          org_id,
          action: 'update',
          entity_type: 'sync_job',
          entity_id: sync_job_id,
          metadata: { workflow: 'ingestion-finalizer', error: errMessage(e) },
          created_at: new Date().toISOString(),
        });
      } catch (postErr) {
        console.error('[IngestionFinalizerWorkflow] post-failure bookkeeping failed:', errMessage(postErr));
      }
      throw e;
    }
  }
}

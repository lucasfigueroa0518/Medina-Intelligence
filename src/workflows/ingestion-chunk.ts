// Ingestion chunk worker — runs as a child of IngestionWorkflow.
// Each chunk gets its own Worker invocation so it has a fresh
// 1000-subrequest budget. Cloudflare's workflow runtime treats every
// step.do() across run() as a single Worker invocation that shares
// one budget, which is why we fan out across multiple workflows.

import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { ClassifiableItem, ClassifiedItem, VectorIndexEntry } from '../types/interfaces';
import { classifyAndDeduplicate } from '../lib/classification';
import { chunkEmbedAndPersistAll } from '../lib/embedding';
import { stageAndCommitApprovals } from '../lib/stage-approvals';
import { trackedStep } from '../lib/workflow-telemetry';

console.log('[IngestionChunkWorkflow] module loaded');

interface ChunkParams {
  org_id: string;
  sync_job_id: string;
  chunk_index: number;
  chunk_r2_key: string;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export class IngestionChunkWorkflow extends WorkflowEntrypoint<Env, ChunkParams> {
  async run(event: WorkflowEvent<ChunkParams>, step: WorkflowStep): Promise<void> {
    const { org_id, sync_job_id, chunk_index, chunk_r2_key } = event.payload;
    console.log(`[IngestionChunkWorkflow] start chunk=${chunk_index} job=${sync_job_id} key=${chunk_r2_key}`);

    let processingError: unknown = null;
    let classifiedCount = 0;

    try {
      const items = await trackedStep(this.env, step, sync_job_id, `load-chunk:${chunk_index}`, async () => {
        const obj = await this.env.R2.get(chunk_r2_key);
        if (!obj) throw new Error(`chunk not found in R2: ${chunk_r2_key}`);
        const text = await obj.text();
        return JSON.parse(text) as ClassifiableItem[];
      });

      const classified: ClassifiedItem[] = await trackedStep(
        this.env,
        step,
        sync_job_id,
        `classify:${chunk_index}`,
        async () => {
          return classifyAndDeduplicate(items, org_id, this.env);
        }
      );
      classifiedCount = classified.length;

      await trackedStep(this.env, step, sync_job_id, `stage-approvals:${chunk_index}`, async () => {
        await stageAndCommitApprovals(classified, org_id, sync_job_id, this.env);
      });

      await trackedStep(
        this.env,
        step,
        sync_job_id,
        `embed:${chunk_index}`,
        { retries: { limit: 3, delay: '10 seconds' } },
        async () => {
        const indexEntries: VectorIndexEntry[] = [];
        for (const item of classified) {
          try {
            const entries = await chunkEmbedAndPersistAll(item.text, item.metadata, this.env);
            indexEntries.push(...entries);
          } catch (e) {
            console.error(`[IngestionChunkWorkflow] embed failed for ${item.entityId}:`, errMessage(e));
          }
        }
        if (indexEntries.length > 0) {
          await this.env.D1.batch(
            indexEntries.map(e =>
              this.env.D1.prepare(
                'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
              ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
            )
          );
        }
      });

      await trackedStep(
        this.env,
        step,
        sync_job_id,
        `process-attachments:${chunk_index}`,
        { retries: { limit: 1, delay: '5 seconds' } },
        async () => {
        const { processEmailAttachments } = await import('../lib/attachment-processor');
        // Counters track every attachment we observe vs. what landed in
        // documents. Persisted into sync_jobs.metadata at the end of the step
        // so a single SQL query (`SELECT json_extract(metadata, '$.attachments_*')
        // FROM sync_jobs ...`) can detect divergence between conversations
        // declaring attachments and documents actually written. Without this,
        // the email-attachment pipeline silently dropping rows was invisible.
        let attempted = 0;
        let totalDocs = 0;
        let totalSkipped = 0;
        let totalFailed = 0;
        for (const item of classified) {
          if (item.attachments?.length) {
            attempted += item.attachments.length;
            try {
              const r = await processEmailAttachments(item, org_id, this.env);
              totalDocs += r.documents_created;
              totalSkipped += r.documents_skipped;
              totalFailed += r.errors.length;
              if (r.errors.length) console.warn(`[IngestionChunkWorkflow] attachment errors:`, r.errors);
            } catch (e) {
              totalFailed += item.attachments.length;
              console.error(`[IngestionChunkWorkflow] attachment processing failed for ${item.entityId}:`, errMessage(e));
            }
          }
        }
        if (attempted > 0) {
          console.log(`[IngestionChunkWorkflow] chunk=${chunk_index} attachments: attempted=${attempted} created=${totalDocs} skipped=${totalSkipped} failed=${totalFailed}`);
          // Accumulate across chunks via json_set + COALESCE: each chunk
          // increments the running total without clobbering siblings'
          // contributions. NULL metadata bootstraps to '{}'.
          try {
            await this.env.D1.prepare(
              `UPDATE sync_jobs
                  SET metadata = json_set(
                    COALESCE(metadata, '{}'),
                    '$.attachments_attempted', COALESCE(json_extract(metadata, '$.attachments_attempted'), 0) + ?,
                    '$.attachments_processed', COALESCE(json_extract(metadata, '$.attachments_processed'), 0) + ?,
                    '$.attachments_skipped',   COALESCE(json_extract(metadata, '$.attachments_skipped'),   0) + ?,
                    '$.attachments_failed',    COALESCE(json_extract(metadata, '$.attachments_failed'),    0) + ?
                  )
                WHERE id = ?`
            ).bind(attempted, totalDocs, totalSkipped, totalFailed, sync_job_id).run();
          } catch (e) {
            console.error(`[IngestionChunkWorkflow] sync_jobs metadata update failed:`, errMessage(e));
          }
        }
      });

      await trackedStep(
        this.env,
        step,
        sync_job_id,
        `detect-deals:${chunk_index}`,
        { retries: { limit: 1, delay: '5 seconds' } },
        async () => {
        try {
          const { detectAndStageDealSignals } = await import('../lib/deal-detection');
          const stagedCount = await detectAndStageDealSignals(classified, org_id, this.env);
          console.log(`[IngestionChunkWorkflow] chunk=${chunk_index} deals_staged=${stagedCount}`);
        } catch (e) {
          console.error('[IngestionChunkWorkflow] deal detection failed:', errMessage(e));
        }
      });
    } catch (e) {
      // Capture but don't rethrow yet — we always want to decrement so the
      // finalizer still runs and the sync_job doesn't dangle until timeout.
      processingError = e;
      console.error(`[IngestionChunkWorkflow] chunk=${chunk_index} processing failed:`, errMessage(e));
    }

    // Idempotent completion record + once-only finalizer trigger.
    //
    // sync_job_chunks: per-chunk completion row. INSERT OR IGNORE makes
    // a CF retry of this step a no-op (audit 2026-04-28: the prior
    // arithmetic decrement on metadata.pending_chunks double-decremented
    // on retry, leaving counter at -1 and orphaning the finalizer).
    //
    // sync_job_finalizers: PRIMARY KEY job_id + INSERT OR IGNORE means
    // exactly one chunk wins the finalizer trigger race even under retry
    // or concurrent decrement.
    await trackedStep(this.env, step, sync_job_id, `decrement-and-finalize:${chunk_index}`, async () => {
      const chunkId = String(chunk_index);

      const inserted = await this.env.D1.prepare(
        `INSERT OR IGNORE INTO sync_job_chunks
           (job_id, chunk_id, items_in_chunk, items_succeeded, items_failed)
         VALUES (?, ?, ?, ?, 0)`
      ).bind(sync_job_id, chunkId, classifiedCount, classifiedCount).run();

      // Only update items_processed when this insert actually succeeded
      // (changes > 0). Re-fires of this step are no-ops.
      if (inserted.meta.changes && inserted.meta.changes > 0) {
        await this.env.D1.prepare(
          `UPDATE sync_jobs
              SET items_processed = (
                    SELECT COALESCE(SUM(items_succeeded), 0)
                      FROM sync_job_chunks WHERE job_id = ?
                  )
            WHERE id = ?`
        ).bind(sync_job_id, sync_job_id).run();
      }

      const status = await this.env.D1.prepare(
        `SELECT
            (SELECT COUNT(*) FROM sync_job_chunks WHERE job_id = ?) AS completed_chunks,
            CAST(json_extract(metadata, '$.chunk_count') AS INTEGER) AS total_chunks
           FROM sync_jobs WHERE id = ?`
      ).bind(sync_job_id, sync_job_id).first<{ completed_chunks: number; total_chunks: number }>();

      const completed = status?.completed_chunks ?? 0;
      const total = status?.total_chunks ?? -1;
      console.log(
        `[IngestionChunkWorkflow] chunk=${chunk_index} recorded. completed=${completed}/${total}`
      );

      if (total > 0 && completed >= total) {
        // Race-safe trigger: exactly one chunk wins the INSERT.
        const trigger = await this.env.D1.prepare(
          `INSERT OR IGNORE INTO sync_job_finalizers (job_id, triggered_at)
           VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(sync_job_id).run();

        if (trigger.meta.changes && trigger.meta.changes > 0) {
          try {
            await this.env.INGESTION_FINALIZER_WORKFLOW.create({
              id: `finalizer-${sync_job_id}`,
              params: { org_id, sync_job_id },
            });
            console.log(`[IngestionChunkWorkflow] last chunk — finalizer triggered`);
          } catch (e) {
            // Duplicate workflow-id is benign (another retry beat us via CF
            // workflow ID dedup, even though we won the table-level race).
            const msg = errMessage(e).toLowerCase();
            if (!msg.includes('already') && !msg.includes('exists')) {
              console.error('[IngestionChunkWorkflow] finalizer trigger failed:', errMessage(e));
              throw e;
            }
            console.log('[IngestionChunkWorkflow] finalizer workflow already exists — skipping');
          }
        } else {
          console.log('[IngestionChunkWorkflow] finalizer already triggered by another chunk — skipping');
        }
      }
    });

    if (processingError) throw processingError;
  }
}

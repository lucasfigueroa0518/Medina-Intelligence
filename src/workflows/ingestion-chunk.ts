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
      const items = await step.do('load-chunk', async () => {
        const obj = await this.env.R2.get(chunk_r2_key);
        if (!obj) throw new Error(`chunk not found in R2: ${chunk_r2_key}`);
        const text = await obj.text();
        return JSON.parse(text) as ClassifiableItem[];
      });

      const classified: ClassifiedItem[] = await step.do('classify', async () => {
        return classifyAndDeduplicate(items, org_id, this.env);
      });
      classifiedCount = classified.length;

      await step.do('stage-approvals', async () => {
        await stageAndCommitApprovals(classified, org_id, sync_job_id, this.env);
      });

      await step.do('embed', { retries: { limit: 3, delay: '10 seconds' } }, async () => {
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

      await step.do('detect-deals', { retries: { limit: 1, delay: '5 seconds' } }, async () => {
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

    // Atomic decrement + conditional finalizer trigger. RETURNING gives us
    // the post-decrement value so the worker that drains the counter to zero
    // is the one that fires the finalizer.
    await step.do('decrement-and-finalize', async () => {
      const row = await this.env.D1.prepare(
        `UPDATE sync_jobs
           SET metadata = json_set(metadata, '$.pending_chunks',
                            CAST(json_extract(metadata, '$.pending_chunks') AS INTEGER) - 1),
               items_processed = COALESCE(items_processed, 0) + ?
         WHERE id = ?
         RETURNING CAST(json_extract(metadata, '$.pending_chunks') AS INTEGER) AS remaining`
      ).bind(classifiedCount, sync_job_id).first<{ remaining: number }>();

      const remaining = row?.remaining ?? -1;
      console.log(`[IngestionChunkWorkflow] chunk=${chunk_index} decremented. remaining=${remaining}`);

      if (remaining === 0) {
        try {
          await this.env.INGESTION_FINALIZER_WORKFLOW.create({
            id: `finalizer-${sync_job_id}`,
            params: { org_id, sync_job_id },
          });
          console.log(`[IngestionChunkWorkflow] last chunk — finalizer triggered`);
        } catch (e) {
          // A duplicate-id error means another retry already triggered it.
          // Anything else is a real failure to propagate.
          const msg = errMessage(e).toLowerCase();
          if (!msg.includes('already') && !msg.includes('exists')) {
            console.error('[IngestionChunkWorkflow] finalizer trigger failed:', errMessage(e));
            throw e;
          }
          console.log('[IngestionChunkWorkflow] finalizer already triggered — skipping');
        }
      }
    });

    if (processingError) throw processingError;
  }
}

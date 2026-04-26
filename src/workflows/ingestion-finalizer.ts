// Ingestion finalizer — runs once after every chunk worker has decremented
// the pending counter to zero. Bulk post-processing that touches all org
// data (relationship graph recompute, association scan, etc.) lives here so
// it doesn't multiply by chunk count.

import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { invalidateRagCache } from '../lib/cache';
import { reconcileOrphanContacts } from '../lib/contact-reconciliation';
import { calculateAllRelationshipStatuses } from '../lib/relationship-status';
import { calculateAllRelationshipOwners } from '../lib/relationship-owner';
import { analyzeAllCommsPatterns } from '../lib/communication-patterns';
import { recalculateAllAssociations } from '../lib/associations';
import { emitAudit } from '../lib/audit';

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
      await step.do('invalidate-cache', async () => {
        await invalidateRagCache(org_id, this.env);
      });

      await step.do('reconcile-orphan-contacts', { retries: { limit: 1, delay: '5 seconds' } }, async () => {
        try {
          const r = await reconcileOrphanContacts(org_id, this.env);
          console.log(
            `[IngestionFinalizerWorkflow] reconciliation: orphans=${r.orphan_contacts_scanned} links_inserted=${r.links_inserted} counter_updates=${r.contacts_with_counter_change}`
          );
        } catch (e) {
          console.error('[IngestionFinalizerWorkflow] reconciliation failed:', errMessage(e));
        }
      });

      await step.do('post-ingestion-calcs', { retries: { limit: 1, delay: '5 seconds' } }, async () => {
        try {
          const c = await calculateAllRelationshipStatuses(org_id, this.env);
          console.log(`[IngestionFinalizerWorkflow] relationship statuses updated: ${c}`);
        } catch (e) { console.error('[IngestionFinalizerWorkflow] relationship-status calc failed:', errMessage(e)); }

        try {
          const c = await calculateAllRelationshipOwners(org_id, this.env);
          console.log(`[IngestionFinalizerWorkflow] relationship owners updated: ${c}`);
        } catch (e) { console.error('[IngestionFinalizerWorkflow] relationship-owner calc failed:', errMessage(e)); }

        try {
          const c = await analyzeAllCommsPatterns(org_id, this.env);
          console.log(`[IngestionFinalizerWorkflow] comms patterns analyzed: ${c}`);
        } catch (e) { console.error('[IngestionFinalizerWorkflow] comms-patterns calc failed:', errMessage(e)); }

        try {
          await recalculateAllAssociations(org_id, this.env);
          console.log(`[IngestionFinalizerWorkflow] entity associations recalculated`);
        } catch (e) { console.error('[IngestionFinalizerWorkflow] associations calc failed:', errMessage(e)); }
      });

      await step.do('trigger-post-ingest-enrichment', async () => {
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
      });

      await step.do('mark-job-completed', async () => {
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

// TRD §7.1 Workflow A — Ingestion (every 20 min)
import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type {
  ClassifiableItem,
  ClassifiedItem,
  VectorIndexEntry,
} from '../types/interfaces';
import { fetchOutlookDelta, fetchOutlookCalendarDelta } from '../integrations/outlook';
import { fetchSlackMessages } from '../integrations/slack';
import { fetchNewsForActiveCompanies } from '../integrations/news-search';
import { classifyAndDeduplicate } from '../lib/classification';
import { chunkEmbedAndPersistAll } from '../lib/embedding';
import { stageAndCommitApprovals } from '../lib/stage-approvals';
import { invalidateRagCache } from '../lib/cache';
import { chunkArray, getCurrentSyncJobId } from '../lib/helpers';
import { emitAudit } from '../lib/audit';
import { calculateAllRelationshipStatuses } from '../lib/relationship-status';
import { calculateAllRelationshipOwners } from '../lib/relationship-owner';
import { analyzeAllCommsPatterns } from '../lib/communication-patterns';
import { recalculateAllAssociations } from '../lib/associations';
import { reconcileOrphanContacts } from '../lib/contact-reconciliation';

// Module-load probe: if this never fires in `wrangler tail`, the crash is at
// import/class-definition time, not in run().
console.log('[IngestionWorkflow] module loaded');

interface IngestionParams {
  org_id: string;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export class IngestionWorkflow extends WorkflowEntrypoint<Env, IngestionParams> {
  async run(event: WorkflowEvent<IngestionParams>, step: WorkflowStep): Promise<void> {
    // First log — proves run() was entered. If module-loaded fires but this
    // does not, the crash is in entrypoint construction, not in the body.
    console.log(
      '[IngestionWorkflow] run started',
      (() => {
        try {
          return JSON.stringify(event?.payload ?? null);
        } catch {
          return '(payload not serializable)';
        }
      })()
    );

    let org_id: string | undefined;
    let jobCreated = false;

    try {
      // Defensive payload unpack — a bad trigger payload used to crash the
      // workflow silently before any step ran.
      if (!event || !event.payload) {
        throw new Error('IngestionWorkflow invoked with no event.payload');
      }
      org_id = event.payload.org_id;
      if (!org_id || typeof org_id !== 'string') {
        throw new Error(
          `IngestionWorkflow invoked with invalid org_id: ${JSON.stringify(event.payload)}`
        );
      }
      console.log(`[IngestionWorkflow] org_id=${org_id}`);

      // Step 1: concurrency guard with timeout recovery
      console.log('[IngestionWorkflow] step → check-concurrency');
      const canProceed = await step.do('check-concurrency', async () => {
        const running = await this.env.D1.prepare(
          `SELECT id FROM sync_jobs WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running' AND timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
        ).bind(org_id!).first();
        if (running) return false;

        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running' AND (timeout_at IS NULL OR timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(org_id!).run();

        await this.env.D1.prepare(
          `INSERT INTO sync_jobs (org_id, workflow_type, status, started_at, timeout_at)
           VALUES (?, 'ingestion', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'))`
        ).bind(org_id!).run();
        return true;
      });

      if (!canProceed) {
        console.log('[IngestionWorkflow] another run already in flight — exiting');
        return;
      }
      jobCreated = true;

      // Step 2: parallel source fetch
      interface SourceBundle {
        outlook: ClassifiableItem[];
        slack: ClassifiableItem[];
        news: ClassifiableItem[];
        calendar: ClassifiableItem[];
        failures: Array<{ source: string; error: string }>;
      }

      console.log('[IngestionWorkflow] step → fetch-all-sources');
      const sourceData: SourceBundle = await step.do(
        'fetch-all-sources',
        {
          retries: { limit: 2, delay: '10 seconds' },
          timeout: '120 seconds',
        },
        async (): Promise<SourceBundle> => {
          const results = await Promise.allSettled([
            fetchOutlookDelta(org_id!, this.env),
            fetchSlackMessages(org_id!, this.env),
            fetchNewsForActiveCompanies(org_id!, this.env),
            fetchOutlookCalendarDelta(org_id!, this.env).then(() => [] as ClassifiableItem[]),
          ]);

          const names = ['outlook', 'slack', 'news', 'calendar'] as const;
          const failures: Array<{ source: string; error: string }> = [];
          const data = {
            outlook: [] as ClassifiableItem[],
            slack: [] as ClassifiableItem[],
            news: [] as ClassifiableItem[],
            calendar: [] as ClassifiableItem[],
          };

          for (let i = 0; i < results.length; i++) {
            const key = names[i];
            if (results[i].status === 'fulfilled') {
              data[key] = (results[i] as PromiseFulfilledResult<ClassifiableItem[]>).value;
            } else {
              failures.push({
                source: key,
                error: (results[i] as PromiseRejectedResult).reason?.message || 'unknown',
              });
            }
          }

          if (failures.length === 4) throw new Error('All source fetches failed');
          return { ...data, failures };
        }
      );

      // Step 3: classify + deduplicate (batched 50/step)
      const allItems: ClassifiableItem[] = [
        ...sourceData.outlook,
        ...sourceData.slack,
        ...sourceData.news,
      ];

      const classifiedItems: ClassifiedItem[] = [];
      // Batch size 10 to stay under the 1000-subrequest-per-Worker cap. High-
      // fanout emails (calendar invites with many attendees) can trigger 80+
      // subrequests per item via per-recipient discover/dedup queries, so even
      // 20/batch overflows on certain shapes. 10/batch is the safe ceiling.
      const classifyBatches = chunkArray(allItems, 10);
      for (let i = 0; i < classifyBatches.length; i++) {
        console.log(`[IngestionWorkflow] step → classify-batch-${i} (${classifyBatches[i].length} items)`);
        const batch = await step.do(`classify-batch-${i}`, async () =>
          classifyAndDeduplicate(classifyBatches[i], org_id!, this.env)
        );
        classifiedItems.push(...batch);
      }

      // Step 4: embed + cache (batched 20/step)
      const embedBatches = chunkArray(classifiedItems, 20);
      for (let i = 0; i < embedBatches.length; i++) {
        console.log(`[IngestionWorkflow] step → embed-batch-${i} (${embedBatches[i].length} items)`);
        await step.do(
          `embed-batch-${i}`,
          { retries: { limit: 3, delay: '10 seconds' } },
          async () => {
            const indexEntries: VectorIndexEntry[] = [];

            for (const item of embedBatches[i]) {
              try {
                const entries = await chunkEmbedAndPersistAll(
                  item.text,
                  item.metadata,
                  this.env
                );
                indexEntries.push(...entries);
              } catch (e) {
                console.error('embed failed for item', item.entityId, e);
              }
            }

            if (indexEntries.length > 0) {
              await this.env.D1.batch(
                indexEntries.map(e =>
                  this.env.D1
                    .prepare(
                      'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
                    )
                    .bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
                )
              );
            }
          }
        );
      }

      // Step 5: stage approvals + commit auto-approved
      console.log('[IngestionWorkflow] step → stage-approvals');
      await step.do('stage-approvals', async () => {
        const syncJobId = await getCurrentSyncJobId(org_id!, 'ingestion', this.env);
        await stageAndCommitApprovals(classifiedItems, org_id!, syncJobId, this.env);
      });

      // Step 6: invalidate cache
      console.log('[IngestionWorkflow] step → invalidate-cache');
      await step.do('invalidate-cache', async () => {
        await invalidateRagCache(org_id!, this.env);
      });

      // Step 6b: reconcile orphan contacts. Heals any contact whose
      // discovery committed under a previous failed run but whose
      // conversation_contacts link never got written (workflow died between
      // classify-batch and stage-approvals). Recomputes total_interactions
      // from the junction table so the counter is always the source of truth.
      console.log('[IngestionWorkflow] step → reconcile-orphan-contacts');
      await step.do('reconcile-orphan-contacts', { retries: { limit: 1, delay: '5 seconds' } }, async () => {
        try {
          const r = await reconcileOrphanContacts(org_id!, this.env);
          console.log(
            `[IngestionWorkflow] reconciliation: orphans=${r.orphan_contacts_scanned} links_inserted=${r.links_inserted} counter_updates=${r.contacts_with_counter_change}`
          );
        } catch (e) {
          console.error('[IngestionWorkflow] reconciliation failed:', e);
        }
      });

      // Step 7: post-ingestion calculations
      console.log('[IngestionWorkflow] step → post-ingestion-calcs');
      await step.do('post-ingestion-calcs', { retries: { limit: 1, delay: '5 seconds' } }, async () => {
        try {
          const statusCount = await calculateAllRelationshipStatuses(org_id!, this.env);
          console.log(`[IngestionWorkflow] relationship statuses updated: ${statusCount}`);
        } catch (e) { console.error('[IngestionWorkflow] relationship-status calc failed:', e); }

        try {
          const ownerCount = await calculateAllRelationshipOwners(org_id!, this.env);
          console.log(`[IngestionWorkflow] relationship owners updated: ${ownerCount}`);
        } catch (e) { console.error('[IngestionWorkflow] relationship-owner calc failed:', e); }

        try {
          const commsCount = await analyzeAllCommsPatterns(org_id!, this.env);
          console.log(`[IngestionWorkflow] comms patterns analyzed: ${commsCount}`);
        } catch (e) { console.error('[IngestionWorkflow] comms-patterns calc failed:', e); }

        try {
          await recalculateAllAssociations(org_id!, this.env);
          console.log(`[IngestionWorkflow] entity associations recalculated`);
        } catch (e) { console.error('[IngestionWorkflow] associations calc failed:', e); }
      });

      // Step 7b: deal detection from this batch (Finding 5)
      console.log('[IngestionWorkflow] step → detect-deals');
      const dealsStaged = await step.do('detect-deals', { retries: { limit: 1, delay: '5 seconds' } }, async () => {
        try {
          const { detectAndStageDealSignals } = await import('../lib/deal-detection');
          const stagedCount = await detectAndStageDealSignals(classifiedItems, org_id!, this.env);
          console.log(`[IngestionWorkflow] deal signals staged: ${stagedCount}`);
          return stagedCount;
        } catch (e) {
          console.error('[IngestionWorkflow] deal detection failed:', e);
          return 0;
        }
      });

      // Step 7c: kick off enrichment now so newly-discovered contacts/companies
      // don't wait the full hour. Skip if an enrichment run is already in flight.
      console.log('[IngestionWorkflow] step → trigger-post-ingest-enrichment');
      await step.do('trigger-post-ingest-enrichment', async () => {
        const running = await this.env.D1.prepare(
          `SELECT id FROM sync_jobs
           WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running'
             AND timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
        ).bind(org_id!).first();

        if (running) {
          console.log('[IngestionWorkflow] enrichment already in flight — skipping post-ingest trigger');
          return;
        }

        try {
          await this.env.ENRICHMENT_WORKFLOW.create({
            params: { org_id: org_id! },
          });
          console.log('[IngestionWorkflow] post-ingest enrichment workflow triggered');
        } catch (e) {
          console.error('[IngestionWorkflow] failed to trigger post-ingest enrichment:', e);
        }
      });

      // Step 8: finalize — record a structured metadata summary on the job row
      console.log('[IngestionWorkflow] step → finalize');
      await step.do('finalize', async () => {
        // Quality gates: log a warning when this run looks suspicious so it's
        // findable in `wrangler tail` without rooting through every log line.
        const fetched = sourceData.outlook.length + sourceData.slack.length + sourceData.news.length + sourceData.calendar.length;
        const classifiedCount = classifiedItems.length;
        const dropRate = fetched > 0 ? 1 - classifiedCount / fetched : 0;

        const warnings: string[] = [];
        if (sourceData.failures.length > 0) {
          warnings.push(`source_failures:${sourceData.failures.map(f => f.source).join(',')}`);
        }
        if (fetched > 50 && classifiedCount === 0) {
          warnings.push('all_items_dropped');
        }
        if (fetched > 100 && dropRate > 0.9) {
          warnings.push(`high_drop_rate:${dropRate.toFixed(2)}`);
        }
        if (warnings.length > 0) {
          console.warn(`[IngestionWorkflow] QUALITY GATES TRIPPED: ${warnings.join(' | ')}`);
        }

        const metadata = {
          fetched_outlook: sourceData.outlook.length,
          fetched_slack: sourceData.slack.length,
          fetched_news: sourceData.news.length,
          fetched_calendar: sourceData.calendar.length,
          source_failures: sourceData.failures,
          classified: classifiedCount,
          drop_rate: Number(dropRate.toFixed(4)),
          deals_staged: dealsStaged,
          warnings,
        };

        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             items_processed = ?, metadata = ?
           WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running'`
        ).bind(classifiedCount, JSON.stringify(metadata), org_id!).run();
      });

      console.log('[IngestionWorkflow] run completed successfully');
    } catch (e) {
      // Mirror EnrichmentWorkflow: nothing in this catch block may throw —
      // we wrap every side-effect so the original error always re-throws.
      console.error(`[IngestionWorkflow] FATAL: ${errMessage(e)}`,
        e instanceof Error && e.stack ? e.stack : '');

      if (jobCreated && org_id) {
        try {
          await this.env.D1.prepare(
            `UPDATE sync_jobs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error_message = ?
             WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running'`
          ).bind(errMessage(e).slice(0, 500), org_id).run();
        } catch (updateErr) {
          console.error(
            `[IngestionWorkflow] failed to mark sync_job as failed: ${errMessage(updateErr)}`
          );
        }
      }

      if (org_id) {
        try {
          await emitAudit(this.env, {
            org_id,
            action: 'update',
            entity_type: 'sync_job',
            metadata: { workflow: 'ingestion', error: errMessage(e) },
            created_at: new Date().toISOString(),
          });
        } catch (auditErr) {
          console.error(
            `[IngestionWorkflow] failed to emit audit event: ${errMessage(auditErr)}`
          );
        }
      }

      throw e;
    }
  }
}

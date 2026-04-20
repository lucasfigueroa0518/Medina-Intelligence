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
      const classifyBatches = chunkArray(allItems, 50);
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

      // Step 8: finalize
      console.log('[IngestionWorkflow] step → finalize');
      await step.do('finalize', async () => {
        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             items_processed = ?
           WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running'`
        ).bind(classifiedItems.length, org_id!).run();
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

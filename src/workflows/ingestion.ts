// TRD §7.1 Workflow A — Ingestion master.
//
// Architecture: this workflow only fetches sources, writes per-chunk
// item slices to R2, and fans out child IngestionChunkWorkflow runs.
// Each child gets a fresh Worker invocation (fresh 1000-subrequest
// budget). The last child to finish triggers IngestionFinalizerWorkflow
// for bulk post-processing. The master itself stays well under the
// subrequest cap because it only does fetch + R2 puts + N create() calls.
import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { ClassifiableItem } from '../types/interfaces';
import { fetchOutlookDelta, fetchOutlookCalendarDelta } from '../integrations/outlook';
import { fetchSlackMessages } from '../integrations/slack';
import { fetchNewsForActiveCompanies } from '../integrations/news-search';
import { chunkArray, getCurrentSyncJobId } from '../lib/helpers';
import { emitAudit } from '../lib/audit';
import { trackedStep } from '../lib/workflow-telemetry';

console.log('[IngestionWorkflow] module loaded');

// Items per child workflow. Each child has a fresh 1000-subrequest budget,
// so we can be a touch more generous than the previous in-process batch
// size (5) — but not too generous, because high-fanout items (large CC
// lists, calendar invites) can spend ~100 subrequests each on contact
// discovery alone. 8 keeps a comfortable margin for the worst case.
const CHILDREN_CHUNK_SIZE = 8;

// Fanout pacing (audit 2026-04-28 scale-up Fix 2). Spawning all child
// workflows simultaneously turned every large run into a thundering-herd
// problem on Workers AI / Vectorize. Batching keeps concurrent work bounded:
// spawn 25 children, wait for them to record completion in sync_job_chunks,
// then spawn the next batch. Caps wait per batch so a single stuck chunk
// doesn't lock the master forever — finalizer trigger still fires correctly
// when the late chunk eventually records completion.
const FANOUT_BATCH_SIZE = 25;
const FANOUT_BATCH_WAIT_MS = 500;
const FANOUT_MAX_WAIT_PER_BATCH_MS = 180_000;

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
    let syncJobId: string | null = null;

    try {
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

      // Step 1: concurrency guard with timeout recovery.
      // Deploy-killed workflows leave orphan "running" rows. We use timeout_at
      // as the authority: once past, the job is considered abandoned. We also
      // treat any job running for >15 minutes as stale (healthy runs complete
      // the master in <2 min; children run independently).
      console.log('[IngestionWorkflow] step → check-concurrency');
      // No telemetry on this step — sync_jobs.id doesn't exist yet.
      const newJobId = await step.do('check-concurrency', async () => {
        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 error_message = COALESCE(error_message, 'Timed out or interrupted by deploy')
           WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running'
             AND (timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  OR started_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes'))`
        ).bind(org_id!).run();

        const running = await this.env.D1.prepare(
          `SELECT id FROM sync_jobs WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'running'`
        ).bind(org_id!).first();
        if (running) return null;

        const inserted = await this.env.D1.prepare(
          `INSERT INTO sync_jobs (org_id, workflow_type, status, started_at, timeout_at)
           VALUES (?, 'ingestion', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'))
           RETURNING id`
        ).bind(org_id!).first<{ id: string }>();
        return inserted?.id ?? null;
      });

      if (!newJobId) {
        console.log('[IngestionWorkflow] another run already in flight — exiting');
        return;
      }
      jobCreated = true;
      syncJobId = newJobId;

      // Step 2a: fetch email + slack + calendar (fast sources)
      interface CoreSourceBundle {
        outlook: ClassifiableItem[];
        slack: ClassifiableItem[];
        calendar_events_upserted: number;
        failures: Array<{ source: string; error: string }>;
      }

      console.log('[IngestionWorkflow] step → fetch-core-sources');
      const coreData: CoreSourceBundle = await trackedStep(
        this.env,
        step,
        syncJobId,
        'fetch-core-sources',
        {
          retries: { limit: 2, delay: '10 seconds' },
          timeout: '300 seconds',
        },
        async (): Promise<CoreSourceBundle> => {
          const results = await Promise.allSettled([
            fetchOutlookDelta(org_id!, this.env),
            fetchSlackMessages(org_id!, this.env),
            fetchOutlookCalendarDelta(org_id!, this.env),
          ]);

          const failures: Array<{ source: string; error: string }> = [];
          const data: CoreSourceBundle = {
            outlook: [] as ClassifiableItem[],
            slack: [] as ClassifiableItem[],
            calendar_events_upserted: 0,
            failures,
          };

          if (results[0].status === 'fulfilled') {
            data.outlook = (results[0] as PromiseFulfilledResult<ClassifiableItem[]>).value;
          } else {
            failures.push({ source: 'outlook', error: (results[0] as PromiseRejectedResult).reason?.message || 'unknown' });
          }

          if (results[1].status === 'fulfilled') {
            const slackResult = (results[1] as PromiseFulfilledResult<{
              messages: ClassifiableItem[];
              errors: Array<{ channel_id: string; channel_name: string; error: string }>;
            }>).value;
            data.slack = slackResult.messages;
            for (const e of slackResult.errors) {
              failures.push({ source: `slack:#${e.channel_name}`, error: e.error });
            }
          } else {
            failures.push({ source: 'slack', error: (results[1] as PromiseRejectedResult).reason?.message || 'unknown' });
          }

          if (results[2].status === 'fulfilled') {
            const calResult = results[2].value;
            data.calendar_events_upserted = calResult.events_upserted;
            for (const e of calResult.errors) {
              failures.push({ source: `calendar:${e.user_id}`, error: `${e.error}${e.http_status ? ` (HTTP ${e.http_status})` : ''}` });
            }
          } else {
            failures.push({ source: 'calendar', error: (results[2] as PromiseRejectedResult).reason?.message || 'unknown' });
          }

          return data;
        }
      );

      // Step 2b: fetch news. New design (audit 2026-04-28 Task 1): staleness
      // filter + hard cap (25/run) + parallel-per-company + per-company budget.
      // 25 companies in parallel × ~5–10s each = total wallclock well under 60s.
      console.log('[IngestionWorkflow] step → fetch-news');
      const newsData = await trackedStep(
        this.env,
        step,
        syncJobId,
        'fetch-news',
        {
          retries: { limit: 1, delay: '10 seconds' },
          timeout: '60 seconds',
        },
        async (): Promise<{
          news: ClassifiableItem[];
          failures: Array<{ source: string; error: string }>;
          telemetry: {
            companies_queried: number;
            succeeded: number;
            failed: number;
            articles_fetched: number;
            step_duration_ms: number;
          };
        }> => {
          try {
            const result = await fetchNewsForActiveCompanies(org_id!, this.env);
            return { news: result.items, failures: [], telemetry: result.telemetry };
          } catch (e: any) {
            return {
              news: [],
              failures: [{ source: 'news', error: e?.message || 'unknown' }],
              telemetry: {
                companies_queried: 0,
                succeeded: 0,
                failed: 0,
                articles_fetched: 0,
                step_duration_ms: 0,
              },
            };
          }
        }
      );

      // Combine into unified shape
      interface SourceBundle {
        outlook: ClassifiableItem[];
        slack: ClassifiableItem[];
        news: ClassifiableItem[];
        calendar_events_upserted: number;
        failures: Array<{ source: string; error: string }>;
      }
      const sourceData: SourceBundle = {
        outlook: coreData.outlook,
        slack: coreData.slack,
        news: newsData.news,
        calendar_events_upserted: coreData.calendar_events_upserted,
        failures: [...coreData.failures, ...newsData.failures],
      };

      // Step 3: write chunks to R2 + fan out children. With batched fanout
      // (Fix 2 of 2026-04-28 scale-up) this step now blocks until all batches
      // are spawned, so the budget needs to cover the full fanout duration.
      // 263 chunks × ~30s/batch wait / 25 = ~5 min realistic; 15 min ceiling.
      console.log('[IngestionWorkflow] step → write-chunks-and-fanout');
      await trackedStep(
        this.env,
        step,
        syncJobId,
        'write-chunks-and-fanout',
        { timeout: '900 seconds', retries: { limit: 1, delay: '10 seconds' } },
        async () => {
        const allItems: ClassifiableItem[] = [
          ...sourceData.outlook,
          ...sourceData.slack,
          ...sourceData.news,
        ];
        const syncJobId = await getCurrentSyncJobId(org_id!, 'ingestion', this.env);
        const chunks = chunkArray(allItems, CHILDREN_CHUNK_SIZE);

        const baseSummary = {
          fetched_outlook: sourceData.outlook.length,
          fetched_slack: sourceData.slack.length,
          fetched_news: sourceData.news.length,
          fetched_calendar: sourceData.calendar_events_upserted,
          source_failures: sourceData.failures,
          news_companies_queried: newsData.telemetry.companies_queried,
          news_companies_succeeded: newsData.telemetry.succeeded,
          news_companies_failed: newsData.telemetry.failed,
          news_articles_fetched: newsData.telemetry.articles_fetched,
          news_step_duration_ms: newsData.telemetry.step_duration_ms,
        };

        // No items → finalize immediately (no children, no finalizer needed).
        if (chunks.length === 0) {
          const warnings: string[] = [];
          if (sourceData.failures.length > 0) {
            warnings.push(`source_failures:${sourceData.failures.map(f => f.source).join(',')}`);
          }
          const metadata = {
            ...baseSummary,
            chunk_count: 0,
            pending_chunks: 0,
            classified: 0,
            warnings,
          };
          await this.env.D1.prepare(
            `UPDATE sync_jobs
               SET status = 'completed',
                   completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                   items_processed = 0,
                   metadata = ?
             WHERE id = ?`
          ).bind(JSON.stringify(metadata), syncJobId).run();
          console.log('[IngestionWorkflow] no items fetched — job marked completed');
          return;
        }

        // Write per-chunk slices to R2 in parallel.
        const manifestPrefix = `ingestion/${org_id}/${syncJobId}`;
        const chunkKeys = chunks.map((_, i) => `${manifestPrefix}/chunks/${i}.json`);
        await Promise.all(
          chunks.map((chunk, i) => this.env.R2.put(chunkKeys[i], JSON.stringify(chunk)))
        );

        // Manifest is for observability only — children read their own chunk file.
        await this.env.R2.put(
          `${manifestPrefix}/manifest.json`,
          JSON.stringify({
            org_id,
            sync_job_id: syncJobId,
            chunk_count: chunks.length,
            chunk_size: CHILDREN_CHUNK_SIZE,
            total_items: allItems.length,
            fetched_at: new Date().toISOString(),
            source_summary: baseSummary,
            chunk_keys: chunkKeys,
          })
        );

        // Set the counter BEFORE spawning children so the first child to
        // finish doesn't observe a missing pending_chunks key.
        const initialMetadata = {
          ...baseSummary,
          manifest_key: `${manifestPrefix}/manifest.json`,
          chunk_count: chunks.length,
          pending_chunks: chunks.length,
          fanout_started_at: new Date().toISOString(),
        };
        await this.env.D1.prepare(
          `UPDATE sync_jobs SET metadata = ? WHERE id = ?`
        ).bind(JSON.stringify(initialMetadata), syncJobId).run();

        // Batched fanout. Spawn FANOUT_BATCH_SIZE children, wait for them to
        // record completion in sync_job_chunks, then spawn the next batch.
        // The trailing pause between batches gives Workers AI / Vectorize
        // KV state time to settle.
        for (let batchStart = 0; batchStart < chunks.length; batchStart += FANOUT_BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + FANOUT_BATCH_SIZE, chunks.length);
          const batchSize = batchEnd - batchStart;
          const batchChunkIds: string[] = [];
          for (let i = batchStart; i < batchEnd; i++) batchChunkIds.push(String(i));

          await Promise.all(
            batchChunkIds.map((chunkId, j) => {
              const i = batchStart + j;
              return this.env.INGESTION_CHUNK_WORKFLOW.create({
                id: `chunk-${syncJobId}-${i}`,
                params: {
                  org_id: org_id!,
                  sync_job_id: syncJobId,
                  chunk_index: i,
                  chunk_r2_key: chunkKeys[i],
                },
              });
            })
          );

          console.log(
            `[IngestionWorkflow] spawned batch ${batchStart}-${batchEnd} of ${chunks.length}`
          );

          // Skip the wait for the final batch — the finalizer trigger fires
          // when the last chunk records completion, regardless of whether
          // the master is still in this step.
          if (batchEnd >= chunks.length) break;

          // Wait for this batch to record completion before spawning the
          // next. Soft-cap at FANOUT_MAX_WAIT_PER_BATCH_MS — if a chunk is
          // genuinely stuck, proceed and let the finalizer-trigger logic
          // catch up when the straggler eventually completes.
          const waitStartedAt = Date.now();
          const placeholders = batchChunkIds.map(() => '?').join(',');
          while (true) {
            const completed = await this.env.D1.prepare(
              `SELECT COUNT(*) AS cnt FROM sync_job_chunks
                WHERE job_id = ? AND chunk_id IN (${placeholders})`
            ).bind(syncJobId, ...batchChunkIds).first<{ cnt: number }>();

            if ((completed?.cnt ?? 0) >= batchSize) break;

            if (Date.now() - waitStartedAt > FANOUT_MAX_WAIT_PER_BATCH_MS) {
              console.warn(
                `[IngestionWorkflow] batch wait timeout — proceeding with ${completed?.cnt ?? 0}/${batchSize} complete in batch ${batchStart}-${batchEnd}`
              );
              break;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          await new Promise(resolve => setTimeout(resolve, FANOUT_BATCH_WAIT_MS));
        }

        console.log(
          `[IngestionWorkflow] fanned out ${chunks.length} children for job=${syncJobId} (chunk_size=${CHILDREN_CHUNK_SIZE}, batch_size=${FANOUT_BATCH_SIZE}, total_items=${allItems.length})`
        );
      });

      // Master ends here. Children continue independently. The last child
      // to decrement the counter triggers IngestionFinalizerWorkflow which
      // marks the sync_job as 'completed'.
      console.log('[IngestionWorkflow] master finished — children running async');
    } catch (e) {
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

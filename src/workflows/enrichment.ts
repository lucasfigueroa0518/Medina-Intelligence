// TRD §7.1 Workflow B — Enrichment (every 60 min)
import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { triggerContactEnrichment, triggerCompanyEnrichment } from '../lib/enrichment';
import { extractEnrichmentSignals } from '../lib/extraction';
import {
  promoteToStandalone,
  flagStaleOrphanedEvents,
} from '../lib/reconciliation';
import { invalidateRagCache } from '../lib/cache';
import { chunkArray, getOrgSettings } from '../lib/helpers';
import { emitAudit } from '../lib/audit';

interface EnrichmentParams {
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

function errStack(e: unknown): string {
  return e instanceof Error && e.stack ? e.stack : '';
}

export class EnrichmentWorkflow extends WorkflowEntrypoint<Env, EnrichmentParams> {
  async run(event: WorkflowEvent<EnrichmentParams>, step: WorkflowStep): Promise<void> {
    // First log — proves run() was entered. If this line never fires in wrangler
    // tail, the crash is at class-instantiation / module-load time, not in run().
    console.log(
      '[EnrichmentWorkflow] run started',
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
      // Defensive payload unpack — if the runtime hands us no payload we want
      // a clear error rather than a "Cannot read properties of undefined" trace.
      if (!event || !event.payload) {
        throw new Error('EnrichmentWorkflow invoked with no event.payload');
      }
      org_id = event.payload.org_id;
      if (!org_id || typeof org_id !== 'string') {
        throw new Error(
          `EnrichmentWorkflow invoked with invalid org_id: ${JSON.stringify(event.payload)}`
        );
      }
      console.log(`[EnrichmentWorkflow] org_id=${org_id}`);

      // Step 1: concurrency guard
      console.log('[EnrichmentWorkflow] step → check-concurrency');
      const canProceed = await step.do('check-concurrency', async () => {
        const running = await this.env.D1.prepare(
          `SELECT id FROM sync_jobs WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running' AND timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
        ).bind(org_id!).first();
        if (running) return false;

        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running' AND (timeout_at IS NULL OR timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(org_id!).run();

        await this.env.D1.prepare(
          `INSERT INTO sync_jobs (org_id, workflow_type, status, started_at, timeout_at)
           VALUES (?, 'enrichment', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 minutes'))`
        ).bind(org_id!).run();
        return true;
      });

      if (!canProceed) {
        console.log('[EnrichmentWorkflow] another run already in flight — exiting');
        return;
      }
      jobCreated = true;

      // Step 2: identify pending entities
      console.log('[EnrichmentWorkflow] loading org settings');
      const settings = await getOrgSettings(org_id!, this.env);
      const maxPerCycle = settings.max_enrichments_per_cycle || 50;
      console.log(`[EnrichmentWorkflow] max_per_cycle=${maxPerCycle}`);

      console.log('[EnrichmentWorkflow] step → identify-pending-contacts');
      const contacts = await step.do('identify-pending-contacts', async () => {
        // Two pools:
        //   1. Never enriched (enrichment_last_run IS NULL) — pick these up
        //      regardless of interaction count so manually-created contacts
        //      get enriched on their first cycle.
        //   2. Stale enrichment (>30 days old) — only re-enrich contacts that
        //      have at least one interaction (email/meeting). No point spending
        //      Claude RPM on zero-engagement records.
        // Require email AND a real name (≥4 chars) — skips auto-discovered
        // junk stubs ("Slack", "Anthropic") that have no usable anchor for
        // enrichment and would waste Claude RPM budget.
        const rows = await this.env.D1.prepare(
          `SELECT id, full_name, email, enrichment_last_run, total_interactions
             FROM contacts WHERE org_id = ? AND deleted_at IS NULL
             AND email IS NOT NULL AND email != ''
             AND LENGTH(full_name) >= 4
             AND merged_into IS NULL
             AND (
               enrichment_last_run IS NULL
               OR (enrichment_last_run < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
                   AND total_interactions > 0)
             )
           ORDER BY
             CASE WHEN enrichment_last_run IS NULL THEN 0 ELSE 1 END,
             total_interactions DESC
           LIMIT ?`
        ).bind(org_id!, Math.floor(maxPerCycle * 0.6)).all<{
          id: string;
          full_name: string;
          email: string | null;
          enrichment_last_run: string | null;
          total_interactions: number;
        }>();
        for (const r of rows.results) {
          console.log(
            `[EnrichmentWorkflow]   candidate contact: ${r.full_name} (${r.email || 'no email'}) interactions=${r.total_interactions} last_run=${r.enrichment_last_run || 'never'}`
          );
        }
        return rows.results.map(r => r.id);
      });
      console.log(`[EnrichmentWorkflow] pending contacts: ${contacts.length}`);

      console.log('[EnrichmentWorkflow] step → identify-pending-companies');
      const companies = await step.do('identify-pending-companies', async () => {
        const rows = await this.env.D1.prepare(
          `SELECT id FROM companies WHERE org_id = ? AND deleted_at IS NULL
             AND (enrichment_last_run IS NULL OR enrichment_last_run < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'))
             AND investment_status NOT IN ('passed','exited')
           ORDER BY news_relevance_score DESC LIMIT ?`
        ).bind(org_id!, Math.floor(maxPerCycle * 0.4)).all<{ id: string }>();
        return rows.results.map(r => r.id);
      });
      console.log(`[EnrichmentWorkflow] pending companies: ${companies.length}`);

      // Step 3: enrich in batches of 10
      const contactBatches = chunkArray(contacts, 10);
      for (let i = 0; i < contactBatches.length; i++) {
        console.log(`[EnrichmentWorkflow] step → enrich-contacts-${i} (${contactBatches[i].length} contacts)`);
        await step.do(
          `enrich-contacts-${i}`,
          { retries: { limit: 2, delay: '30 seconds' } },
          async () => {
            for (const cid of contactBatches[i]) {
              try {
                await triggerContactEnrichment(cid, org_id!, this.env);
              } catch (e) {
                console.error(`[EnrichmentWorkflow] contact enrich failed ${cid}: ${errMessage(e)}`);
              }
            }
            return { status: 'completed', count: contactBatches[i].length };
          }
        );
      }

      const companyBatches = chunkArray(companies, 10);
      for (let i = 0; i < companyBatches.length; i++) {
        console.log(`[EnrichmentWorkflow] step → enrich-companies-${i} (${companyBatches[i].length} companies)`);
        await step.do(
          `enrich-companies-${i}`,
          { retries: { limit: 2, delay: '30 seconds' } },
          async () => {
            for (const cid of companyBatches[i]) {
              try {
                await triggerCompanyEnrichment(cid, org_id!, this.env);
              } catch (e) {
                console.error(`[EnrichmentWorkflow] company enrich failed ${cid}: ${errMessage(e)}`);
              }
            }
            return { status: 'completed', count: companyBatches[i].length };
          }
        );
      }

      // Step 4: LLM extraction from recent communications
      console.log('[EnrichmentWorkflow] step → llm-extraction');
      await step.do('llm-extraction', async () => {
        const recent = await this.env.D1.prepare(
          `SELECT * FROM conversations WHERE org_id = ?
             AND sent_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
           LIMIT 100`
        ).bind(org_id!).all<any>();

        for (const conv of recent.results) {
          try {
            await extractEnrichmentSignals(conv, org_id!, this.env);
          } catch (e) {
            console.error(
              `[EnrichmentWorkflow] extraction failed conv=${conv.id}: ${errMessage(e)}`
            );
          }
        }
      });

      // Step 5: event reconciliation
      console.log('[EnrichmentWorkflow] step → reconcile-events');
      await step.do('reconcile-events', async () => {
        await promoteToStandalone(org_id!, this.env);
        await flagStaleOrphanedEvents(org_id!, this.env);
      });

      // Step 6: cache invalidation
      console.log('[EnrichmentWorkflow] step → invalidate-cache');
      await step.do('invalidate-cache', async () => {
        await invalidateRagCache(org_id!, this.env);
      });

      // Step 7: finalize
      console.log('[EnrichmentWorkflow] step → finalize');
      await step.do('finalize', async () => {
        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             items_processed = ?
           WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running'`
        ).bind(contacts.length + companies.length, org_id!).run();
      });

      console.log('[EnrichmentWorkflow] run completed successfully');
    } catch (e) {
      // Log the failure with as much detail as possible BEFORE re-throwing.
      // Nothing in this catch block is allowed to throw — we wrap every
      // side-effect so the original error always makes it to the re-throw.
      console.error(
        `[EnrichmentWorkflow] FATAL: ${errMessage(e)}`,
        errStack(e)
      );

      if (jobCreated && org_id) {
        try {
          await this.env.D1.prepare(
            `UPDATE sync_jobs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error_message = ?
             WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running'`
          ).bind(errMessage(e).slice(0, 500), org_id).run();
        } catch (updateErr) {
          console.error(
            `[EnrichmentWorkflow] failed to mark sync_job as failed: ${errMessage(updateErr)}`
          );
        }
      }

      if (org_id) {
        try {
          await emitAudit(this.env, {
            org_id,
            action: 'update',
            entity_type: 'sync_job',
            metadata: { workflow: 'enrichment', error: errMessage(e) },
            created_at: new Date().toISOString(),
          });
        } catch (auditErr) {
          console.error(
            `[EnrichmentWorkflow] failed to emit audit event: ${errMessage(auditErr)}`
          );
        }
      }

      throw e;
    }
  }
}

// TRD §7.1 Workflow B — Enrichment (every 60 min)
import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { triggerCompanyEnrichment } from '../lib/enrichment';
import { enqueueDueContactEnrichment } from '../lib/contact-enrichment-queue';
import { extractEnrichmentSignals } from '../lib/extraction';
import {
  promoteToStandalone,
  flagStaleOrphanedEvents,
} from '../lib/reconciliation';
import { invalidateRagCache } from '../lib/cache';
import { chunkArray, getOrgSettings } from '../lib/helpers';
import { emitAudit } from '../lib/audit';
import { extractTranscriptSignals, generateMeetingSummary } from '../lib/transcript-extraction';
import { routeTranscriptSignals, distributeMeetingSummary } from '../lib/signal-router';
import { incrementalAssociationUpdate } from '../lib/associations';
import { trackedStep } from '../lib/workflow-telemetry';

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
    let syncJobId: string | null = null;
    const cfInstanceId = event.instanceId;

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
      // No telemetry on this step — sync_jobs.id doesn't exist yet.
      const newJobId = await step.do('check-concurrency', async () => {
        const running = await this.env.D1.prepare(
          `SELECT id FROM sync_jobs WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running' AND timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
        ).bind(org_id!).first();
        if (running) return null;

        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running' AND (timeout_at IS NULL OR timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(org_id!).run();

        const inserted = await this.env.D1.prepare(
          `INSERT INTO sync_jobs (org_id, workflow_type, status, started_at, timeout_at, cf_instance_id)
           VALUES (?, 'enrichment', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 minutes'), ?)
           RETURNING id`
        ).bind(org_id!, cfInstanceId || null).first<{ id: string }>();
        return inserted?.id ?? null;
      });

      if (!newJobId) {
        console.log('[EnrichmentWorkflow] another run already in flight — exiting');
        return;
      }
      jobCreated = true;
      syncJobId = newJobId;

      // Step 2: identify pending entities
      console.log('[EnrichmentWorkflow] loading org settings');
      const settings = await getOrgSettings(org_id!, this.env);
      const maxPerCycle = settings.max_enrichments_per_cycle || 50;
      console.log(`[EnrichmentWorkflow] max_per_cycle=${maxPerCycle}`);

      console.log('[EnrichmentWorkflow] step → identify-pending-contacts');
      const contacts = await trackedStep(this.env, step, syncJobId, 'identify-pending-contacts', async () => {
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
      const companies = await trackedStep(this.env, step, syncJobId, 'identify-pending-companies', async () => {
        // Order by enrichment_last_run NULLS FIRST (never-enriched first) and
        // bump the cap to 0.6 so the first cycle clears the auto-discovered
        // backlog instead of leaving 60% of companies un-enriched forever.
        // Prioritize:
        //   1. Never enriched (enrichment_last_run IS NULL).
        //   2. Companies whose name still equals their domain — discovery
        //      stores the domain as a placeholder; enrichment should resolve
        //      it to a real name (when that pipeline starts writing names back).
        //   3. Highest news relevance, then oldest.
        const rows = await this.env.D1.prepare(
          `SELECT id FROM companies WHERE org_id = ? AND deleted_at IS NULL
             AND merged_into IS NULL
             AND (enrichment_last_run IS NULL OR enrichment_last_run < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'))
             AND investment_status NOT IN ('passed','exited')
           ORDER BY
             CASE WHEN enrichment_last_run IS NULL THEN 0 ELSE 1 END,
             CASE WHEN LOWER(name) = LOWER(domain) OR LOWER(name) = LOWER(REPLACE(REPLACE(website,'https://',''),'http://','')) THEN 0 ELSE 1 END,
             COALESCE(news_relevance_score, 0) DESC,
             created_at ASC
           LIMIT ?`
        ).bind(org_id!, Math.floor(maxPerCycle * 0.6)).all<{ id: string }>();
        return rows.results.map(r => r.id);
      });
      console.log(`[EnrichmentWorkflow] pending companies: ${companies.length}`);

      // Step 3: enqueue contact enrichment as durable per-contact work.
      // The work_queue handler owns execution, retries, rate-limit deferral,
      // heartbeat/lock recovery, DLQ visibility, association updates, and
      // cache invalidation. The workflow remains responsible for discovery
      // and the lighter enrichment-adjacent maintenance steps below.
      console.log(`[EnrichmentWorkflow] step → enqueue-contact-enrichment (${contacts.length} contacts)`);
      const queuedContacts = await trackedStep(
        this.env,
        step,
        syncJobId,
        'enqueue-contact-enrichment',
        async () => enqueueDueContactEnrichment(org_id!, this.env, {
          limit: Math.max(contacts.length, Math.floor(maxPerCycle * 0.6)),
          targetBacklog: Math.max(100, maxPerCycle * 2),
          contactIds: contacts,
        })
      );
      console.log(
        `[EnrichmentWorkflow] contact enrichment queued inserted=${queuedContacts.inserted} existing=${queuedContacts.existing}`
      );

      const companyBatches = chunkArray(companies, 10);
      for (let i = 0; i < companyBatches.length; i++) {
        console.log(`[EnrichmentWorkflow] step → enrich-companies-${i} (${companyBatches[i].length} companies)`);
        await trackedStep(
          this.env,
          step,
          syncJobId,
          `enrich-companies-${i}`,
          { retries: { limit: 2, delay: '30 seconds' } },
          async () => {
            for (let j = 0; j < companyBatches[i].length; j++) {
              const cid = companyBatches[i][j];
              try {
                await triggerCompanyEnrichment(cid, org_id!, this.env);
              } catch (e) {
                console.error(`[EnrichmentWorkflow] company enrich failed ${cid}: ${errMessage(e)}`);
              }
              if (j < companyBatches[i].length - 1) {
                await new Promise(r => setTimeout(r, 2000));
              }
            }
            return { status: 'completed', count: companyBatches[i].length };
          }
        );
      }

      // Step 4: LLM extraction from recent communications.
      // Each conversation is extracted at most once — gated by signals_extracted_at
      // (mirrors events.signals_extracted_at and news_articles.facts_extracted_at).
      // The cron runs twice an hour over a 24h window; without this marker the
      // same email gets re-sent to Claude up to 48× and stages a fresh approval
      // row each time.
      console.log('[EnrichmentWorkflow] step → llm-extraction');
      await trackedStep(this.env, step, syncJobId, 'llm-extraction', async () => {
        const recent = await this.env.D1.prepare(
          `SELECT * FROM conversations WHERE org_id = ?
             AND sent_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
             AND signals_extracted_at IS NULL
           LIMIT 100`
        ).bind(org_id!).all<any>();

        for (const conv of recent.results) {
          try {
            await extractEnrichmentSignals(conv, org_id!, this.env);
          } catch (e) {
            console.error(
              `[EnrichmentWorkflow] extraction failed conv=${conv.id}: ${errMessage(e)}`
            );
          } finally {
            // Stamp regardless of outcome — a transient failure shouldn't make
            // us re-charge Claude for the same email on the next cron tick.
            await this.env.D1.prepare(
              `UPDATE conversations SET signals_extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
            ).bind(conv.id).run().catch(() => undefined);
          }
        }
      });

      // Step 5: transcript signal extraction from Firefly meetings
      console.log('[EnrichmentWorkflow] step → transcript-extraction');
      await trackedStep(this.env, step, syncJobId, 'transcript-extraction', { retries: { limit: 1, delay: '15 seconds' } }, async () => {
        const unextracted = await this.env.D1.prepare(
          `SELECT id, title, start_time, transcript_r2_key FROM events
           WHERE org_id = ? AND transcript_r2_key IS NOT NULL
             AND signals_extracted_at IS NULL
             AND deleted_at IS NULL
           ORDER BY start_time DESC LIMIT 10`
        ).bind(org_id!).all<{
          id: string; title: string; start_time: string; transcript_r2_key: string;
        }>();

        console.log(`[EnrichmentWorkflow] ${unextracted.results.length} transcripts to extract`);

        for (const event of unextracted.results) {
          try {
            const obj = await this.env.R2.get(event.transcript_r2_key);
            if (!obj) continue;
            const transcriptText = await obj.text();
            if (transcriptText.length < 100) continue;

            const attendees = await this.env.D1.prepare(
              `SELECT display_name as name, email FROM event_attendees WHERE event_id = ?`
            ).bind(event.id).all<{ name: string; email: string | null }>();

            const participants = attendees.results.map(a => ({
              name: a.name,
              email: a.email || undefined,
            }));

            const signals = await extractTranscriptSignals(
              transcriptText, event.title, participants, org_id!, this.env
            );

            const totalSignals =
              signals.contact_signals.length +
              signals.company_signals.length +
              signals.deal_signals.length +
              signals.relationship_signals.length;

            console.log(`[EnrichmentWorkflow] event=${event.id}: ${totalSignals} signals extracted`);

            if (totalSignals > 0) {
              const result = await routeTranscriptSignals(signals, event.id, org_id!, this.env);
              console.log(`[EnrichmentWorkflow] routed: contacts=${result.contact_signals_routed} companies=${result.company_signals_routed} deals=${result.deal_signals_routed} relationships=${result.relationship_signals_routed} new_companies=${result.new_companies_flagged.length}`);
            }

            const summary = await generateMeetingSummary(
              transcriptText, event.title, event.start_time, participants, org_id!, this.env
            );

            if (summary) {
              const distributed = await distributeMeetingSummary(
                summary, event.id, event.title, event.start_time, org_id!, this.env
              );
              console.log(`[EnrichmentWorkflow] meeting summary distributed to ${distributed} contacts`);

              await this.env.D1.prepare(
                `UPDATE events SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
              ).bind(summary.substring(0, 2000), event.id).run();
            }

            await this.env.D1.prepare(
              `UPDATE events SET signals_extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
            ).bind(event.id).run();
          } catch (e) {
            console.error(`[EnrichmentWorkflow] transcript extraction failed event=${event.id}:`, errMessage(e));
          }
        }
      });

      // Step 6: event reconciliation
      console.log('[EnrichmentWorkflow] step → reconcile-events');
      await trackedStep(this.env, step, syncJobId, 'reconcile-events', async () => {
        await promoteToStandalone(org_id!, this.env);
        await flagStaleOrphanedEvents(org_id!, this.env);
      });

      // Step 7: update associations for contacts that were enriched by the
      // queue handler. Kept as a cheap backstop for any contact that completed
      // before this workflow reaches the maintenance phase.
      console.log('[EnrichmentWorkflow] step → update-associations');
      await trackedStep(this.env, step, syncJobId, 'update-associations', async () => {
        for (const cid of contacts) {
          try {
            await incrementalAssociationUpdate(cid, org_id!, this.env);
          } catch (e) {
            console.error(`[EnrichmentWorkflow] association update failed ${cid}: ${errMessage(e)}`);
          }
        }
      });

      // Step 8: cache invalidation
      console.log('[EnrichmentWorkflow] step → invalidate-cache');
      await trackedStep(this.env, step, syncJobId, 'invalidate-cache', async () => {
        await invalidateRagCache(org_id!, this.env);
      });

      // Step 9: finalize
      console.log('[EnrichmentWorkflow] step → finalize');
      await trackedStep(this.env, step, syncJobId, 'finalize', async () => {
        await this.env.D1.prepare(
          `UPDATE sync_jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             items_processed = ?
           WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'running'`
        ).bind((queuedContacts.inserted || 0) + companies.length, org_id!).run();
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

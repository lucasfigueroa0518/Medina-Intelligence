import type { WorkQueueHandler } from '../work-queue-driver';
import {
  CONTACT_ENRICHMENT_DOMAIN,
  CONTACT_ENRICHMENT_PAUSE_MS,
  contactEnrichmentPauseKey,
} from '../contact-enrichment-queue';
import { triggerContactEnrichment } from '../enrichment';
import { incrementalAssociationUpdate } from '../associations';
import { invalidateRagCache } from '../cache';
import { deadLetterWork, deferWork } from '../work-queue';

interface ContactEnrichmentPayload {
  contact_id?: string;
  selected_at?: string;
  prior_enrichment_last_run?: string | null;
  deferred_count?: number;
  last_status?: string;
  last_reason?: string;
  paused_until?: string;
}

function parsePayload(raw: string): ContactEnrichmentPayload {
  try {
    return JSON.parse(raw) as ContactEnrichmentPayload;
  } catch (e) {
    throw new Error(`malformed payload: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const contactEnrichmentHandler: WorkQueueHandler = {
  domain: CONTACT_ENRICHMENT_DOMAIN,
  batchSize: 1,
  maxConcurrent: 1,
  cadence: 'minute',

  process: async (item, env) => {
    const payload = parsePayload(item.payload);
    const contactId = payload.contact_id;
    if (!contactId) {
      await deadLetterWork(env, item.id, 'payload missing contact_id');
      return;
    }

    const pausedUntil = await env.KV.get(contactEnrichmentPauseKey(item.org_id));
    if (pausedUntil && Date.parse(pausedUntil) > Date.now()) {
      const deferredCount = Math.max(0, Number(payload.deferred_count || 0)) + 1;
      await deferWork(
        env,
        item.id,
        pausedUntil,
        JSON.stringify({
          ...payload,
          deferred_count: deferredCount,
          last_status: 'paused_rate_limit',
          last_reason: payload.last_status === 'rate_limited'
            ? payload.last_reason
            : 'shared_contact_enrichment_pause',
          paused_until: pausedUntil,
        })
      );
      return;
    }

    const result = await triggerContactEnrichment(contactId, item.org_id, env, {
      linkedinDiscovery: false,
    });

    if (result.status === 'not_found') {
      await deadLetterWork(env, item.id, 'contact not found or deleted');
      return;
    }

    if (result.status === 'rate_limited') {
      const deferredCount = Math.max(0, Number(payload.deferred_count || 0)) + 1;
      const nextAttemptAt = new Date(Date.now() + CONTACT_ENRICHMENT_PAUSE_MS).toISOString();
      const sharedPause = !String(result.reason || '').includes('gemini_budget_gate');
      if (sharedPause) {
        await env.KV.put(contactEnrichmentPauseKey(item.org_id), nextAttemptAt, {
          expirationTtl: Math.ceil(CONTACT_ENRICHMENT_PAUSE_MS / 1000) + 60,
        });
      }
      await deferWork(
        env,
        item.id,
        nextAttemptAt,
        JSON.stringify({
          ...payload,
          deferred_count: deferredCount,
          last_status: result.status,
          last_reason: result.reason,
          paused_until: sharedPause ? nextAttemptAt : undefined,
        })
      );
      return;
    }

    if (result.status === 'transient_error') {
      throw new Error(result.reason || 'contact enrichment transient error');
    }

    if (result.status === 'enriched') {
      try {
        await incrementalAssociationUpdate(contactId, item.org_id, env);
      } catch (e) {
        console.error(
          `[contact-enrichment] association update failed contact=${contactId}:`,
          e instanceof Error ? e.message : e
        );
      }
      try {
        await invalidateRagCache(item.org_id, env);
      } catch (e) {
        console.error(
          `[contact-enrichment] cache invalidation failed org=${item.org_id}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
  },
};

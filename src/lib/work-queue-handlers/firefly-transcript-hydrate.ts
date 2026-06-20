import type { WorkQueueHandler } from '../work-queue-driver';
import { deferWork } from '../work-queue';
import { nextUtcMidnightIso } from '../firefly-progressive-backfill';
import { hydrateFireflyTranscriptById } from '../../integrations/firefly';
import {
  FIREFLY_TRANSCRIPT_HYDRATE_DOMAIN,
  markFireflyWebhookDeliveryDeferred,
  markFireflyWebhookDeliveryFailed,
  markFireflyWebhookDeliveryHydrated,
  markFireflyWebhookDeliveryHydrating,
  type FireflyHydratePayload,
} from '../firefly-webhook-deliveries';
import { reportIngestionSuccess } from '../ingestion-health';

function parsePayload(payload: string): FireflyHydratePayload {
  const parsed = JSON.parse(payload) as FireflyHydratePayload;
  if (!parsed.firefly_event_id) {
    throw new Error(`malformed firefly hydrate payload: ${payload}`);
  }
  if (!['webhook', 'recent_sweep', 'repair'].includes(parsed.source)) {
    throw new Error(`invalid firefly hydrate source: ${String(parsed.source)}`);
  }
  return parsed;
}

export const fireflyTranscriptHydrateHandler: WorkQueueHandler = {
  domain: FIREFLY_TRANSCRIPT_HYDRATE_DOMAIN,
  batchSize: 4,
  maxConcurrent: 8,
  processConcurrency: 4,
  cadence: 'minute',

  process: async (item, env) => {
    const payload = parsePayload(item.payload);
    await markFireflyWebhookDeliveryHydrating(env, payload.delivery_id).catch(() => {});

    try {
      const result = await hydrateFireflyTranscriptById(
        payload.firefly_event_id,
        item.org_id,
        env,
        {
          preferredUserId: payload.user_id || null,
          sourcePath: payload.source === 'recent_sweep' ? 'firefly-recent-sweep' : 'firefly-webhook',
        }
      );

      await markFireflyWebhookDeliveryHydrated(env, payload.delivery_id, {
        selectedUserId: result.selected_user_id,
        transcriptItemId: result.transcript_item_id,
        linkedEvents: result.linked_events,
        r2Staged: result.r2_staged,
        embeddingQueued: result.embedding_queued,
        prospectQueued: result.prospect_queued,
      }).catch(() => {});

      await reportIngestionSuccess(env, {
        orgId: item.org_id,
        source: 'firefly',
        scopeType: 'user',
        scopeId: result.selected_user_id,
        metadata: {
          firefly_event_id: payload.firefly_event_id,
          delivery_id: payload.delivery_id || null,
          source: payload.source,
          linked_events: result.linked_events,
          r2_staged: result.r2_staged,
        },
      }).catch(() => {});
    } catch (e: any) {
      const message = String(e?.message || e);
      if (message.includes('FIREFLY_RATE_LIMITED')) {
        const nextAttemptAt = nextUtcMidnightIso();
        await markFireflyWebhookDeliveryDeferred(env, payload.delivery_id, message).catch(() => {});
        await deferWork(env, item.id, nextAttemptAt, item.payload);
        return;
      }

      await markFireflyWebhookDeliveryFailed(env, payload.delivery_id, message).catch(() => {});
      throw e;
    }
  },
};

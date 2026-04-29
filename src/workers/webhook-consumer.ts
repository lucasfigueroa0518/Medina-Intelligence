// Webhook intake queue consumer
import type { Env } from '../types/env';
import type { WebhookQueueMessage } from '../types/webhooks';
import { processFireflyWebhook } from '../integrations/firefly';

export async function handleWebhookBatch(
  batch: MessageBatch<WebhookQueueMessage>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const { source, rawPayload, orgId } = msg.body;
      const data = JSON.parse(rawPayload);

      if (source === 'firefly') {
        let resolvedOrgId = orgId;
        if (!resolvedOrgId) {
          const org = await env.D1.prepare(
            'SELECT id FROM organizations LIMIT 1'
          ).first<{ id: string }>();
          resolvedOrgId = org?.id;
        }
        if (!resolvedOrgId) throw new Error('No org_id available');
        // processFireflyWebhook delegates to processTranscriptItems which
        // runs Phase 3 (extractAndRouteSignals) against the canonical event
        // id internally — no more "find latest event ORDER BY created_at"
        // race window where concurrent deliveries could attribute signals
        // to the wrong event.
        await processFireflyWebhook(data, resolvedOrgId, env);
      } else if (source === 'slack') {
        // Slack events API — event callback
        // Full handling would route by event type; for now we ack events.
        // The fetchSlackMessages poller handles message ingestion.
      }

      msg.ack();
    } catch (e) {
      console.error('Webhook consumer error:', e);
      msg.retry({ delaySeconds: 60 });
    }
  }
}

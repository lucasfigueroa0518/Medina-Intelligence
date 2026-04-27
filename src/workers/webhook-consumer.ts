// Webhook intake queue consumer
import type { Env } from '../types/env';
import type { WebhookQueueMessage } from '../types/webhooks';
import { processFireflyWebhook } from '../integrations/firefly';
import { extractAndRouteSignals } from '../lib/firefly-intelligence';

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
        await processFireflyWebhook(data, resolvedOrgId, env);

        // Eagerly extract signals from the transcript that was just stored.
        // Find the event that was just created by processFireflyWebhook.
        try {
          const recentEvent = await env.D1.prepare(
            `SELECT id FROM events WHERE org_id = ? AND source = 'firefly'
             AND transcript_r2_key IS NOT NULL AND signals_extracted_at IS NULL
             ORDER BY created_at DESC LIMIT 1`
          ).bind(resolvedOrgId).first<{ id: string }>();

          if (recentEvent) {
            const outcome = await extractAndRouteSignals(recentEvent.id, resolvedOrgId, env);
            if (outcome) {
              const total = outcome.contact_signals + outcome.company_signals + outcome.deal_signals + outcome.relationship_signals;
              console.log(`[webhook-consumer] Firefly extraction complete: event=${recentEvent.id} signals=${total} distributed=${outcome.summary_distributed_to}`);
            }
          }
        } catch (e) {
          console.error('[webhook-consumer] Eager transcript extraction failed:', e);
        }
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

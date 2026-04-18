// DLQ consumer: persist failed webhook payloads to R2 + D1 for admin review
import type { Env } from '../types/env';
import type { WebhookQueueMessage } from '../types/webhooks';

export async function handleDlqBatch(
  batch: MessageBatch<WebhookQueueMessage>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const { source, rawPayload, receivedAt, orgId } = msg.body;
      const yearMonth = new Date().toISOString().slice(0, 7);
      const id = crypto.randomUUID();
      const r2Key = `dlq/${source}/${yearMonth}/${id}.json`;

      await env.R2.put(r2Key, rawPayload);

      await env.D1.prepare(
        `INSERT INTO dlq_entries
           (id, org_id, source, payload_r2_key, error_message, retry_count, original_received_at)
         VALUES (?, ?, ?, ?, ?, 3, ?)`
      ).bind(id, orgId || null, source, r2Key, 'Max retries exceeded', receivedAt).run();

      msg.ack();
    } catch (e) {
      console.error('DLQ consumer error:', e);
      msg.ack(); // DLQ entries cannot retry
    }
  }
}

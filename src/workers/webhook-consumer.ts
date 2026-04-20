// Webhook intake queue consumer
import type { Env } from '../types/env';
import type { WebhookQueueMessage } from '../types/webhooks';
import { processFireflyWebhook } from '../integrations/firefly';
import { extractTranscriptSignals, generateMeetingSummary } from '../lib/transcript-extraction';
import { routeTranscriptSignals, distributeMeetingSummary } from '../lib/signal-router';

async function extractSignalsFromFireflyEvent(
  eventId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const event = await env.D1.prepare(
    `SELECT id, title, start_time, transcript_r2_key FROM events
     WHERE id = ? AND org_id = ? AND transcript_r2_key IS NOT NULL AND signals_extracted_at IS NULL`
  ).bind(eventId, orgId).first<{
    id: string; title: string; start_time: string; transcript_r2_key: string;
  }>();

  if (!event) return;

  const obj = await env.R2.get(event.transcript_r2_key);
  if (!obj) return;
  const transcriptText = await obj.text();
  if (transcriptText.length < 100) return;

  const attendees = await env.D1.prepare(
    `SELECT display_name as name, email FROM event_attendees WHERE event_id = ?`
  ).bind(event.id).all<{ name: string; email: string | null }>();

  const participants = attendees.results.map(a => ({
    name: a.name,
    email: a.email || undefined,
  }));

  const signals = await extractTranscriptSignals(
    transcriptText, event.title, participants, orgId, env
  );

  const totalSignals =
    signals.contact_signals.length +
    signals.company_signals.length +
    signals.deal_signals.length +
    signals.relationship_signals.length;

  if (totalSignals > 0) {
    await routeTranscriptSignals(signals, event.id, orgId, env);
  }

  const summary = await generateMeetingSummary(
    transcriptText, event.title, event.start_time, participants, orgId, env
  );

  if (summary) {
    await distributeMeetingSummary(summary, event.id, event.title, event.start_time, orgId, env);
    await env.D1.prepare(
      `UPDATE events SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(summary.substring(0, 2000), event.id).run();
  }

  await env.D1.prepare(
    `UPDATE events SET signals_extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(event.id).run();

  console.log(`[webhook-consumer] Firefly transcript extraction complete: event=${event.id} signals=${totalSignals}`);
}

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
            await extractSignalsFromFireflyEvent(recentEvent.id, resolvedOrgId, env);
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

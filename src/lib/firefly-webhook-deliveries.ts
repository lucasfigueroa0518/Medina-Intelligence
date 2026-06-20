import type { Env } from '../types/env';
import { enqueueWork } from './work-queue';

export const FIREFLY_TRANSCRIPT_HYDRATE_DOMAIN = 'firefly_transcript_hydrate';

export interface FireflyWebhookEnvelope {
  eventName: string;
  normalizedEventName: string;
  fireflyEventId: string;
}

export interface FireflyHydratePayload {
  firefly_event_id: string;
  delivery_id?: string | null;
  source: 'webhook' | 'recent_sweep' | 'repair';
  user_id?: string | null;
}

interface DeliveryRow {
  id: string;
  status: string;
  firefly_event_id: string | null;
  event_name: string | null;
}

function normalizeEventName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function parseFireflyWebhookEnvelope(rawPayload: string | Record<string, unknown>): FireflyWebhookEnvelope {
  let data: Record<string, unknown> = {};
  if (typeof rawPayload === 'string') {
    try {
      data = JSON.parse(rawPayload) as Record<string, unknown>;
    } catch {
      data = {};
    }
  } else {
    data = rawPayload;
  }

  const eventName = String(
    data.event_type ||
    data.eventType ||
    data.event ||
    ''
  ).trim();
  const fireflyEventId = String(
    data.event_id ||
    data.meeting_id ||
    data.meetingId ||
    data.transcript_id ||
    data.transcriptId ||
    ''
  ).trim();

  return {
    eventName,
    normalizedEventName: normalizeEventName(eventName),
    fireflyEventId,
  };
}

export function isFireflyTranscriptReadyEvent(eventName: string): boolean {
  const normalized = eventName.toLowerCase();
  return (
    normalized === 'transcript_ready' ||
    normalized === 'meeting_completed' ||
    normalized === 'transcription completed' ||
    normalized === 'meeting.transcribed' ||
    normalized === 'meeting.summarized' ||
    normalized.includes('transcription completed') ||
    normalized.includes('transcript')
  );
}

export function fireflyDeliveryKey(rawPayload: string): string | null {
  const envelope = parseFireflyWebhookEnvelope(rawPayload);
  if (!envelope.fireflyEventId) return null;
  return `firefly:${envelope.fireflyEventId}:${envelope.normalizedEventName}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function truncate(input: string, max = 3000): string {
  return input.length > max ? input.slice(0, max) : input;
}

export async function recordFireflyWebhookDelivery(
  env: Env,
  input: {
    orgId: string;
    rawPayload: string;
    signatureHeader?: string | null;
    receivedAt?: string;
  }
): Promise<{
  id: string;
  duplicate: boolean;
  shouldQueue: boolean;
  deliveryKey: string;
  fireflyEventId: string;
  eventName: string;
}> {
  const envelope = parseFireflyWebhookEnvelope(input.rawPayload);
  const payloadHash = await sha256Hex(input.rawPayload);
  const deliveryKey = envelope.fireflyEventId
    ? `firefly:${envelope.fireflyEventId}:${envelope.normalizedEventName}`
    : `firefly_payload:${payloadHash}`;
  const receivedAt = input.receivedAt || new Date().toISOString();

  const existing = await env.D1.prepare(
    `SELECT id, status, firefly_event_id, event_name
       FROM firefly_webhook_deliveries
      WHERE org_id = ? AND delivery_key = ?
      LIMIT 1`
  ).bind(input.orgId, deliveryKey).first<DeliveryRow>();

  if (existing?.id) {
    await env.D1.prepare(
      `UPDATE firefly_webhook_deliveries
          SET duplicate_count = duplicate_count + 1,
              received_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(receivedAt, existing.id).run();
    return {
      id: existing.id,
      duplicate: true,
      shouldQueue: existing.status === 'failed' || existing.status === 'deferred',
      deliveryKey,
      fireflyEventId: envelope.fireflyEventId,
      eventName: envelope.eventName,
    };
  }

  const inserted = await env.D1.prepare(
    `INSERT INTO firefly_webhook_deliveries
       (org_id, delivery_key, firefly_event_id, event_name, payload_hash,
        payload_excerpt, status, received_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?)
     RETURNING id`
  ).bind(
    input.orgId,
    deliveryKey,
    envelope.fireflyEventId || null,
    envelope.eventName || null,
    payloadHash,
    truncate(input.rawPayload),
    receivedAt,
    JSON.stringify({ signature_present: Boolean(input.signatureHeader) })
  ).first<{ id: string }>();

  if (!inserted?.id) throw new Error('FIREFLY_WEBHOOK_DELIVERY_INSERT_FAILED');
  return {
    id: inserted.id,
    duplicate: false,
    shouldQueue: true,
    deliveryKey,
    fireflyEventId: envelope.fireflyEventId,
    eventName: envelope.eventName,
  };
}

export async function markFireflyWebhookDeliveryQueued(
  env: Env,
  deliveryId: string | null | undefined,
  workQueueId: string | null | undefined
): Promise<void> {
  if (!deliveryId) return;
  await env.D1.prepare(
    `UPDATE firefly_webhook_deliveries
        SET status = 'queued',
            work_queue_id = COALESCE(?, work_queue_id),
            queued_at = COALESCE(queued_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(workQueueId || null, deliveryId).run();
}

export async function markFireflyWebhookDeliveryIgnored(
  env: Env,
  deliveryId: string | null | undefined,
  reason: string
): Promise<void> {
  if (!deliveryId) return;
  await env.D1.prepare(
    `UPDATE firefly_webhook_deliveries
        SET status = 'ignored',
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(reason.slice(0, 500), deliveryId).run();
}

export async function markFireflyWebhookDeliveryHydrating(
  env: Env,
  deliveryId: string | null | undefined
): Promise<void> {
  if (!deliveryId) return;
  await env.D1.prepare(
    `UPDATE firefly_webhook_deliveries
        SET status = 'hydrating',
            attempt_count = attempt_count + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(deliveryId).run();
}

export async function markFireflyWebhookDeliveryHydrated(
  env: Env,
  deliveryId: string | null | undefined,
  result: {
    selectedUserId?: string | null;
    transcriptItemId?: string | null;
    linkedEvents: number;
    r2Staged: number;
    embeddingQueued: number;
    prospectQueued: number;
  }
): Promise<void> {
  if (!deliveryId) return;
  await env.D1.prepare(
    `UPDATE firefly_webhook_deliveries
        SET status = 'hydrated',
            selected_user_id = COALESCE(?, selected_user_id),
            transcript_item_id = COALESCE(?, transcript_item_id),
            linked_events = ?,
            r2_staged = ?,
            embedding_queued = ?,
            prospect_queued = ?,
            last_error = NULL,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(
    result.selectedUserId || null,
    result.transcriptItemId || null,
    result.linkedEvents,
    result.r2Staged,
    result.embeddingQueued,
    result.prospectQueued,
    deliveryId
  ).run();
}

export async function markFireflyWebhookDeliveryDeferred(
  env: Env,
  deliveryId: string | null | undefined,
  reason: string
): Promise<void> {
  if (!deliveryId) return;
  await env.D1.prepare(
    `UPDATE firefly_webhook_deliveries
        SET status = 'deferred',
            last_error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(reason.slice(0, 500), deliveryId).run();
}

export async function markFireflyWebhookDeliveryFailed(
  env: Env,
  deliveryId: string | null | undefined,
  error: string
): Promise<void> {
  if (!deliveryId) return;
  await env.D1.prepare(
    `UPDATE firefly_webhook_deliveries
        SET status = 'failed',
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(error.slice(0, 500), deliveryId).run();
}

export async function enqueueFireflyTranscriptHydration(
  env: Env,
  orgId: string,
  payload: FireflyHydratePayload,
  opts: { priority?: number; nextAttemptAt?: string | null } = {}
): Promise<{ inserted: boolean; id?: string }> {
  return enqueueWork(
    env,
    orgId,
    FIREFLY_TRANSCRIPT_HYDRATE_DOMAIN,
    payload,
    {
      upstream: 'firefly_api',
      priority: opts.priority ?? 35,
      max_attempts: 8,
      next_attempt_at: opts.nextAttemptAt ?? null,
      idempotency_key: `${orgId}:${payload.firefly_event_id}:firefly_transcript_hydrate:v1`,
    }
  );
}

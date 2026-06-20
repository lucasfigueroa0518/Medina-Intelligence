import { fireflyDeliveryKey } from './firefly-webhook-deliveries';

// TRD §5.2 — webhook idempotency key extraction
export function extractIdempotencyKey(
  source: string,
  rawPayload: string
): string | null {
  try {
    const data = JSON.parse(rawPayload);
    switch (source) {
      case 'firefly':
        return fireflyDeliveryKey(rawPayload);
      case 'slack':
        return data.event_id ? `slack:${data.event_id}` : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

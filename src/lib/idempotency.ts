// TRD §5.2 — webhook idempotency key extraction
export function extractIdempotencyKey(
  source: string,
  rawPayload: string
): string | null {
  try {
    const data = JSON.parse(rawPayload);
    switch (source) {
      case 'firefly':
        return data.event_id || data.meeting_id
          ? `firefly:${data.event_id || data.meeting_id}`
          : null;
      case 'slack':
        return data.event_id ? `slack:${data.event_id}` : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

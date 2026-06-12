export interface WebhookQueueMessage {
  source: 'firefly' | 'slack' | 'outlook';
  receivedAt: string;
  idempotencyKey: string | null;
  rawPayload: string;
  eventType?: string;
  signatureHeader?: string;
  orgId?: string;
  deliveryId?: string;
}

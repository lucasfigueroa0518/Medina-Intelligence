// TRD §5.2 — Webhook endpoints: Firefly + Slack + Outlook Graph
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { jsonResponse } from './utils';
import { extractIdempotencyKey } from '../lib/idempotency';
import { verifyFireflySignature } from '../integrations/firefly';
import { verifySlackSignature } from '../integrations/slack';
import { getDecryptedAccessToken, getOrgDomains, stripHtml, getCurrentSyncJobId } from '../lib/helpers';
import { refreshOutlookToken } from '../integrations/oauth';
import { classifyAndDeduplicate } from '../lib/classification';
import { chunkEmbedAndPersistAll } from '../lib/embedding';
import { stageAndCommitApprovals } from '../lib/stage-approvals';

export async function receiveFireflyWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get('X-Firefly-Signature') || '';
  const rawBody = await request.text();

  if (env.FIREFLY_WEBHOOK_SECRET) {
    const valid = await verifyFireflySignature(
      env.FIREFLY_WEBHOOK_SECRET,
      rawBody,
      signature
    );
    if (!valid) {
      return jsonResponse({ error: 'INVALID_SIGNATURE' }, 401);
    }
  }

  const idempotencyKey = extractIdempotencyKey('firefly', rawBody);
  if (idempotencyKey) {
    const seen = await env.KV.get(`webhook_idem:${idempotencyKey}`);
    if (seen) return jsonResponse({ ok: true, duplicate: true });
    await env.KV.put(`webhook_idem:${idempotencyKey}`, '1', {
      expirationTtl: 86400,
    });
  }

  await env.WEBHOOK_QUEUE.send({
    source: 'firefly',
    receivedAt: new Date().toISOString(),
    idempotencyKey,
    rawPayload: rawBody,
    signatureHeader: signature,
  });

  return jsonResponse({ ok: true });
}

export async function receiveSlackWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp') || '';
  const signature = request.headers.get('X-Slack-Signature') || '';
  const rawBody = await request.text();

  if (env.SLACK_SIGNING_SECRET && timestamp && signature) {
    const valid = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      timestamp,
      rawBody,
      signature
    );
    if (!valid) return jsonResponse({ error: 'INVALID_SIGNATURE' }, 401);
  }

  // Slack URL verification handshake
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed.type === 'url_verification' && parsed.challenge) {
      return new Response(parsed.challenge, { status: 200 });
    }
  } catch {
    /* non-JSON bodies — form-encoded slash commands */
  }

  const idempotencyKey = extractIdempotencyKey('slack', rawBody);
  if (idempotencyKey) {
    const seen = await env.KV.get(`webhook_idem:${idempotencyKey}`);
    if (seen) return jsonResponse({ ok: true, duplicate: true });
    await env.KV.put(`webhook_idem:${idempotencyKey}`, '1', {
      expirationTtl: 86400,
    });
  }

  await env.WEBHOOK_QUEUE.send({
    source: 'slack',
    receivedAt: new Date().toISOString(),
    idempotencyKey,
    rawPayload: rawBody,
  });

  return jsonResponse({ ok: true });
}

interface GraphNotification {
  subscriptionId: string;
  clientState: string;
  changeType: string;
  resource: string;
  resourceData: {
    '@odata.type': string;
    '@odata.id': string;
    '@odata.etag': string;
    id: string;
  };
}

interface GraphNotificationPayload {
  value: GraphNotification[];
}

export async function receiveOutlookMailWebhook(
  request: Request,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Graph validation handshake — must return validationToken as plain text
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Notification payload
  let payload: GraphNotificationPayload;
  try {
    payload = await request.json() as GraphNotificationPayload;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  if (!payload.value || payload.value.length === 0) {
    return new Response(null, { status: 202 });
  }

  // Respond 202 immediately, process in background
  ctxExec.waitUntil(processGraphNotifications(payload.value, env));
  return new Response(null, { status: 202 });
}

async function processGraphNotifications(
  notifications: GraphNotification[],
  env: Env
): Promise<void> {
  for (const notification of notifications) {
    try {
      await processOneNotification(notification, env);
    } catch (e) {
      console.error(`[graph-webhook] Error processing notification for subscription ${notification.subscriptionId}:`, e);
    }
  }
}

async function processOneNotification(
  notification: GraphNotification,
  env: Env
): Promise<void> {
  // Verify clientState matches a known subscription
  const sub = await env.D1.prepare(
    'SELECT org_id, user_id, client_state, resource FROM graph_subscriptions WHERE subscription_id = ?'
  ).bind(notification.subscriptionId).first<{
    org_id: string; user_id: string; client_state: string; resource: string;
  }>();

  if (!sub) {
    console.warn(`[graph-webhook] Unknown subscription ${notification.subscriptionId}`);
    return;
  }

  if (sub.client_state !== notification.clientState) {
    console.warn(`[graph-webhook] clientState mismatch for subscription ${notification.subscriptionId}`);
    return;
  }

  const { org_id: orgId, user_id: userId } = sub;

  // Idempotency check on the resource data id
  const messageId = notification.resourceData?.id;
  if (!messageId) return;

  const idemKey = `graph_notif:${messageId}`;
  const seen = await env.KV.get(idemKey);
  if (seen) return;
  await env.KV.put(idemKey, '1', { expirationTtl: 86400 });

  // Refresh token and fetch full message
  const refreshResult = await refreshOutlookToken(userId, orgId, env);
  if (!refreshResult.success) {
    console.error(`[graph-webhook] Token refresh failed for user ${userId}`);
    return;
  }

  let token: string;
  try {
    token = await getDecryptedAccessToken(userId, env);
  } catch {
    return;
  }

  const isCalendar = sub.resource === 'me/events';

  if (isCalendar) {
    // Calendar notifications — trigger a delta sync via the existing cron path
    // rather than duplicating upsertOutlookEvent logic here
    console.log(`[graph-webhook] Calendar change for user ${userId}, will sync on next cron`);
    return;
  }

  // Mail notification — fetch full message from Graph
  const msgResp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=id,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,importance,hasAttachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!msgResp.ok) {
    console.error(`[graph-webhook] Failed to fetch message ${messageId}:`, msgResp.status);
    return;
  }

  const msg = await msgResp.json() as {
    id: string;
    subject: string;
    bodyPreview: string;
    body: { contentType: string; content: string };
    from: { emailAddress: { name: string; address: string } };
    toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
    ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
    sentDateTime: string;
    receivedDateTime: string;
    conversationId: string;
    importance?: string;
  };

  // Classify direction
  const internalDomains = await getOrgDomains(orgId, env);
  const allRecipients = [
    ...msg.toRecipients.map(r => r.emailAddress.address),
    ...msg.ccRecipients.map(r => r.emailAddress.address),
  ];
  const fromIsInternal = internalDomains.some(d =>
    msg.from.emailAddress.address.endsWith(`@${d}`)
  );
  const allRecipientsInternal = allRecipients.every(e =>
    internalDomains.some(d => e.endsWith(`@${d}`))
  );

  let direction: 'inbound' | 'outbound' | 'internal';
  if (fromIsInternal && allRecipientsInternal) direction = 'internal';
  else if (fromIsInternal) direction = 'outbound';
  else direction = 'inbound';

  const item: ClassifiableItem = {
    type: 'email',
    source: 'outlook',
    externalId: msg.id,
    threadId: msg.conversationId,
    subject: msg.subject,
    bodyText: msg.body.contentType === 'html' ? stripHtml(msg.body.content) : msg.body.content,
    bodyPreview: (msg.bodyPreview || '').substring(0, 500),
    fromEmail: msg.from.emailAddress.address,
    fromName: msg.from.emailAddress.name,
    toEmails: msg.toRecipients.map(r => r.emailAddress.address),
    ccEmails: msg.ccRecipients.map(r => r.emailAddress.address),
    sentAt: msg.sentDateTime,
    direction,
    importance: msg.importance,
    userId,
    orgId,
    visibility: 'org_wide',
  };

  // Run through the standard ingestion pipeline
  const classified = await classifyAndDeduplicate([item], orgId, env);
  if (classified.length === 0) return;

  for (const ci of classified) {
    try {
      await chunkEmbedAndPersistAll(ci.text, ci.metadata, env);
    } catch (e) {
      console.error(`[graph-webhook] Embedding failed for ${ci.entityId}:`, e);
    }
  }

  const syncJobId = await getCurrentSyncJobId(orgId, 'webhook', env);
  await stageAndCommitApprovals(classified, orgId, syncJobId, env);

  console.log(`[graph-webhook] Processed message "${msg.subject}" for user ${userId}`);
}

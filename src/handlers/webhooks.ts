// TRD §5.2 — Webhook endpoints: Firefly + Slack + Outlook Graph
import type { Env } from '../types/env';
import type { ClassifiableItem, AttachmentMeta } from '../types/interfaces';
import { jsonResponse } from './utils';
import { extractIdempotencyKey } from '../lib/idempotency';
import { verifyFireflySignature } from '../integrations/firefly';
import { verifySlackSignature } from '../integrations/slack';
import { getOrgDomains, stripHtml } from '../lib/helpers';
import { getGraphMailboxAuthForUser, graphMailboxUrl } from '../lib/graph-auth';
import { classifyAndDeduplicate } from '../lib/classification';
import { processClassifiedItems, persistClassifiedStats } from '../lib/ingestion-shared';

export async function receiveFireflyWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  // Firefly sends HMAC-SHA256 in `x-hub-signature` (GitHub-style), formatted
  // as `sha256=<hex>`. Despite some docs naming it X-Firefly-Signature, the
  // actual production header is x-hub-signature.
  const signature = request.headers.get('x-hub-signature') || '';
  const rawBody = await request.text();

  const kvSecret = await env.KV.get('firefly_webhook_secret');
  const secret = kvSecret || env.FIREFLY_WEBHOOK_SECRET;
  if (secret) {
    const valid = await verifyFireflySignature(secret, rawBody, signature);
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

  let auth: { token: string; mailbox: string };
  try {
    auth = await getGraphMailboxAuthForUser(userId, orgId, env);
  } catch (e) {
    console.error(`[graph-webhook] Graph auth failed for user ${userId}:`, e);
    return;
  }

  const isCalendar = sub.resource === 'me/events' || /\/?users\/[^/]+\/events$/i.test(sub.resource || '');

  if (isCalendar) {
    // Calendar notifications — trigger a delta sync via the existing cron path
    // rather than duplicating upsertOutlookEvent logic here
    console.log(`[graph-webhook] Calendar change for user ${userId}, will sync on next cron`);
    return;
  }

  // Mail notification — fetch full message from Graph. $expand=attachments
  // is required for the Wave 3 webhook fix: without it, processEmailAttachments
  // (called inside processClassifiedItems) sees no attachments to download
  // and the conversation lands as a permanent orphan. Pre-fix the webhook
  // ingestion path silently dropped every attachment that arrived this way.
  const msgResp = await fetch(
    graphMailboxUrl(auth.mailbox, `/messages/${messageId}?$select=id,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,importance,hasAttachments&$expand=attachments($select=id,name,size,contentType,isInline)`),
    { headers: { Authorization: `Bearer ${auth.token}` } }
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
    hasAttachments?: boolean;
    attachments?: Array<{
      id: string; name: string; size: number; contentType: string; isInline?: boolean;
    }>;
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

  // Mirror the same attachment filter outlook.ts:179-184 uses for delta-sync:
  // drop small inline images (signatures), cap at 5 per message.
  const attachments: AttachmentMeta[] | undefined =
    msg.hasAttachments && msg.attachments?.length
      ? msg.attachments
          .filter(a => !(a.isInline && a.size < 51200))
          .slice(0, 5)
          .map(a => ({
            id: a.id, name: a.name, size: a.size,
            contentType: a.contentType, isInline: a.isInline,
          }))
      : undefined;

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
    attachments,
  };

  // Classify, then route through processClassifiedItems — the Wave 2
  // converged helper that does stage → embed → process-attachments →
  // detect-deals. Pre-Wave-3 the webhook open-coded only embed + stage,
  // skipping attachments + deal signals (the same divergence Wave 2 closed
  // for runHistoricalBackfill but didn't reach here).
  const classified = await classifyAndDeduplicate([item], orgId, env);
  if (classified.length === 0) return;

  // Real sync_jobs row so persistClassifiedStats has a target for the
  // attachments_attempted/processed/failed counters. workflow_type='webhook'
  // is allowed since migration 0062 relaxed the CHECK enum.
  const jobId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, metadata)
     VALUES (?, ?, 'webhook', 'running', ?, ?)`
  ).bind(
    jobId, orgId, startedAt,
    JSON.stringify({
      subscription_id: notification.subscriptionId,
      message_id: messageId,
      user_id: userId,
    })
  ).run().catch(e => {
    console.error(`[graph-webhook] sync_jobs insert failed for ${jobId}:`, e?.message || e);
  });

  try {
    const stats = await processClassifiedItems(classified, { orgId, syncJobId: jobId }, env);
    await persistClassifiedStats(stats, jobId, env);

    const status = stats.errors.length > 0 ? 'partial' : 'completed';
    await env.D1.prepare(
      `UPDATE sync_jobs SET status = ?, completed_at = ? WHERE id = ?`
    ).bind(status, new Date().toISOString(), jobId).run();

    console.log(
      `[graph-webhook] msg="${msg.subject}" user=${userId} ` +
      `embedded=${stats.items_embedded} attachments(att/proc/skip/fail)=` +
      `${stats.attachments_attempted}/${stats.attachments_processed}/${stats.attachments_skipped}/${stats.attachments_failed} ` +
      `deals_staged=${stats.deal_signals_staged} errors=${stats.errors.length}`
    );
  } catch (e: any) {
    console.error(`[graph-webhook] processClassifiedItems failed for msg ${messageId}:`, e?.message || e);
    await env.D1.prepare(
      `UPDATE sync_jobs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`
    ).bind(new Date().toISOString(), String(e?.message || e).slice(0, 500), jobId).run().catch(() => undefined);
  }
}

import type { Env } from '../types/env';
import { getGraphMailboxAuthForUser } from './graph-auth';

const GRAPH_SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
const MAX_EXPIRATION_MINUTES = 4230; // Graph max for mail: ~2.94 days

type SubscriptionCreateResult = { subscriptionId: string } | { error: string };

export function graphSubscriptionWebhookUrl(env: Env): string {
  const configuredBase = (env.OUTLOOK_WEBHOOK_BASE_URL || '').trim();
  const redirect = env.AZURE_REDIRECT_URI || '';
  const base = (configuredBase || redirect.replace('/auth/outlook/callback', '')).replace(/\/+$/, '');
  if (!base) {
    throw new Error('OUTLOOK_WEBHOOK_BASE_URL or AZURE_REDIRECT_URI is required for Graph subscriptions');
  }
  if (!/^https:\/\//i.test(base)) {
    throw new Error('Graph subscription notification URL must be HTTPS. Set OUTLOOK_WEBHOOK_BASE_URL to a public HTTPS Worker or tunnel URL for local validation.');
  }
  return `${base}/webhooks/outlook-mail`;
}

function expirationDateTime(): string {
  const exp = new Date(Date.now() + MAX_EXPIRATION_MINUTES * 60 * 1000);
  return exp.toISOString();
}

export function expectedSubscriptionResourcesForMailbox(mailbox: string): string[] {
  const encoded = encodeURIComponent(mailbox.trim().toLowerCase());
  return [
    `users/${encoded}/mailFolders/inbox/messages`,
    `users/${encoded}/mailFolders/sentitems/messages`,
    `users/${encoded}/events`,
  ];
}

async function deleteExistingResourceRows(userId: string, orgId: string, resource: string, env: Env): Promise<void> {
  await env.D1.prepare(
    `DELETE FROM graph_subscriptions
      WHERE user_id = ? AND org_id = ? AND resource = ?`
  ).bind(userId, orgId, resource).run();
}

export async function createMailSubscription(
  userId: string,
  orgId: string,
  env: Env
): Promise<SubscriptionCreateResult | null> {
  let auth: { token: string; mailbox: string };
  try {
    auth = await getGraphMailboxAuthForUser(userId, orgId, env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  let notificationUrl: string;
  try {
    notificationUrl = graphSubscriptionWebhookUrl(env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const clientState = `${orgId}:${userId}`;
  const resource = `users/${encodeURIComponent(auth.mailbox)}/mailFolders/inbox/messages`;
  const body = {
    changeType: 'created',
    notificationUrl,
    resource,
    expirationDateTime: expirationDateTime(),
    clientState,
  };

  const resp = await fetch(GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to create mail subscription for user ${userId}:`, resp.status, err);
    return { error: `HTTP ${resp.status}: ${err.slice(0, 500)}` };
  }

  const sub = (await resp.json()) as { id: string; expirationDateTime: string };

  await deleteExistingResourceRows(userId, orgId, resource, env);
  await env.D1.prepare(
    `INSERT INTO graph_subscriptions (org_id, user_id, subscription_id, resource, expiration_at, client_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orgId, userId, sub.id, resource, sub.expirationDateTime, clientState).run();

  console.log(`[graph-sub] Created mail subscription ${sub.id} for user ${userId}, expires ${sub.expirationDateTime}`);
  return { subscriptionId: sub.id };
}

export async function createSentMailSubscription(
  userId: string,
  orgId: string,
  env: Env
): Promise<SubscriptionCreateResult | null> {
  let auth: { token: string; mailbox: string };
  try {
    auth = await getGraphMailboxAuthForUser(userId, orgId, env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  let notificationUrl: string;
  try {
    notificationUrl = graphSubscriptionWebhookUrl(env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const clientState = `${orgId}:${userId}`;
  const resource = `users/${encodeURIComponent(auth.mailbox)}/mailFolders/sentitems/messages`;
  const body = {
    changeType: 'created',
    notificationUrl,
    resource,
    expirationDateTime: expirationDateTime(),
    clientState,
  };

  const resp = await fetch(GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to create sent-mail subscription for user ${userId}:`, resp.status, err);
    return { error: `HTTP ${resp.status}: ${err.slice(0, 500)}` };
  }

  const sub = (await resp.json()) as { id: string; expirationDateTime: string };

  await deleteExistingResourceRows(userId, orgId, resource, env);
  await env.D1.prepare(
    `INSERT INTO graph_subscriptions (org_id, user_id, subscription_id, resource, expiration_at, client_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orgId, userId, sub.id, resource, sub.expirationDateTime, clientState).run();

  console.log(`[graph-sub] Created sent-mail subscription ${sub.id} for user ${userId}, expires ${sub.expirationDateTime}`);
  return { subscriptionId: sub.id };
}

export async function createCalendarSubscription(
  userId: string,
  orgId: string,
  env: Env
): Promise<SubscriptionCreateResult | null> {
  let auth: { token: string; mailbox: string };
  try {
    auth = await getGraphMailboxAuthForUser(userId, orgId, env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  let notificationUrl: string;
  try {
    notificationUrl = graphSubscriptionWebhookUrl(env);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const clientState = `${orgId}:${userId}`;
  const resource = `users/${encodeURIComponent(auth.mailbox)}/events`;
  const body = {
    changeType: 'created,updated',
    notificationUrl,
    resource,
    expirationDateTime: expirationDateTime(),
    clientState,
  };

  const resp = await fetch(GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to create calendar subscription for user ${userId}:`, resp.status, err);
    return { error: `HTTP ${resp.status}: ${err.slice(0, 500)}` };
  }

  const sub = (await resp.json()) as { id: string; expirationDateTime: string };

  await deleteExistingResourceRows(userId, orgId, resource, env);
  await env.D1.prepare(
    `INSERT INTO graph_subscriptions (org_id, user_id, subscription_id, resource, expiration_at, client_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orgId, userId, sub.id, resource, sub.expirationDateTime, clientState).run();

  console.log(`[graph-sub] Created calendar subscription ${sub.id} for user ${userId}, expires ${sub.expirationDateTime}`);
  return { subscriptionId: sub.id };
}

export async function renewSubscription(
  subscriptionId: string,
  userId: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  let auth: { token: string };
  try {
    auth = await getGraphMailboxAuthForUser(userId, orgId, env);
  } catch {
    return false;
  }

  const resp = await fetch(`${GRAPH_SUBSCRIPTIONS_URL}/${subscriptionId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expirationDateTime: expirationDateTime() }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to renew subscription ${subscriptionId}:`, resp.status, err);
    if (resp.status === 404) {
      await env.D1.prepare('DELETE FROM graph_subscriptions WHERE subscription_id = ?')
        .bind(subscriptionId).run();
    }
    return false;
  }

  const sub = (await resp.json()) as { expirationDateTime: string };
  await env.D1.prepare(
    `UPDATE graph_subscriptions SET expiration_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE subscription_id = ?`
  ).bind(sub.expirationDateTime, subscriptionId).run();

  console.log(`[graph-sub] Renewed subscription ${subscriptionId}, new expiry ${sub.expirationDateTime}`);
  return true;
}

export async function deleteSubscription(
  subscriptionId: string,
  userId: string,
  env: Env
): Promise<void> {
  try {
    const row = await env.D1.prepare(
      'SELECT org_id FROM graph_subscriptions WHERE subscription_id = ? AND user_id = ?'
    ).bind(subscriptionId, userId).first<{ org_id: string }>();
    if (!row) throw new Error('subscription not found');
    const auth = await getGraphMailboxAuthForUser(userId, row.org_id, env);
    await fetch(`${GRAPH_SUBSCRIPTIONS_URL}/${subscriptionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
  } catch {
    // Best-effort — subscription will expire on its own
  }

  await env.D1.prepare('DELETE FROM graph_subscriptions WHERE subscription_id = ?')
    .bind(subscriptionId).run();
}

export async function renewExpiringSubscriptions(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const expiring = await env.D1.prepare(
    `SELECT subscription_id, user_id, org_id, resource FROM graph_subscriptions
     WHERE expiration_at < ? ORDER BY expiration_at ASC LIMIT 50`
  ).bind(cutoff).all<{ subscription_id: string; user_id: string; org_id: string; resource: string }>();

  for (const sub of expiring.results) {
    if (!sub.resource.startsWith('users/')) {
      continue;
    }
    const ok = await renewSubscription(sub.subscription_id, sub.user_id, sub.org_id, env);
    if (!ok) {
      console.warn(`[graph-sub] Renewal failed for ${sub.subscription_id}, will recreate on next daily cron`);
    }
  }

  const users = await env.D1.prepare(
    `SELECT id, org_id FROM users
      WHERE deleted_at IS NULL
        AND is_active = 1
        AND COALESCE(outlook_mailbox, email) IS NOT NULL
      ORDER BY org_id, email
      LIMIT 200`
  ).all<{ id: string; org_id: string }>();
  for (const user of users.results || []) {
    await ensureSubscriptionsForUser(user.id, user.org_id, env);
  }
}

export interface EnsureSubscriptionsResult {
  user_id: string;
  mailbox: string;
  expected: string[];
  existing: string[];
  created: string[];
  errors: string[];
  deleted_legacy: number;
  deleted_expired: number;
}

export async function ensureSubscriptionsForUser(
  userId: string,
  orgId: string,
  env: Env
): Promise<EnsureSubscriptionsResult | null> {
  const user = await env.D1.prepare(
    `SELECT email, outlook_mailbox FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(userId, orgId).first<{ email: string | null; outlook_mailbox: string | null }>();
  const mailbox = (user?.outlook_mailbox || user?.email || '').trim().toLowerCase();
  if (!mailbox) return null;

  const expected = expectedSubscriptionResourcesForMailbox(mailbox);
  const existing = await env.D1.prepare(
    `SELECT resource, expiration_at FROM graph_subscriptions
      WHERE user_id = ? AND org_id = ?`
  ).bind(userId, orgId).all<{ resource: string; expiration_at: string }>();

  const legacy = existing.results.filter(r => /^me\//i.test(r.resource));
  const expiredExpected = existing.results.filter(r =>
    expected.includes(r.resource) && Date.parse(r.expiration_at) <= Date.now()
  );

  const activeResources = new Set(
    existing.results
      .filter(r => expected.includes(r.resource) && Date.parse(r.expiration_at) > Date.now())
      .map(r => r.resource)
  );
  const created: string[] = [];
  const errors: string[] = [];
  if (!activeResources.has(expected[0])) {
    const result = await createMailSubscription(userId, orgId, env);
    if (result && 'subscriptionId' in result) created.push(expected[0]);
    else errors.push(`inbox:${result && 'error' in result ? result.error : 'unknown subscription create failure'}`);
  }
  if (!activeResources.has(expected[1])) {
    const result = await createSentMailSubscription(userId, orgId, env);
    if (result && 'subscriptionId' in result) created.push(expected[1]);
    else errors.push(`sentitems:${result && 'error' in result ? result.error : 'unknown subscription create failure'}`);
  }
  if (!activeResources.has(expected[2])) {
    const result = await createCalendarSubscription(userId, orgId, env);
    if (result && 'subscriptionId' in result) created.push(expected[2]);
    else errors.push(`events:${result && 'error' in result ? result.error : 'unknown subscription create failure'}`);
  }

  const expectedSatisfied = expected.every(resource => activeResources.has(resource) || created.includes(resource));
  let deletedLegacy = 0;
  let deletedExpired = 0;
  if (expectedSatisfied && (legacy.length > 0 || expiredExpected.length > 0)) {
    await env.D1.prepare(
      `DELETE FROM graph_subscriptions
        WHERE user_id = ? AND org_id = ?
          AND (resource LIKE 'me/%'
            OR (resource IN (${expected.map(() => '?').join(',')}) AND expiration_at <= ?))`
    ).bind(userId, orgId, ...expected, new Date().toISOString()).run();
    deletedLegacy = legacy.length;
    deletedExpired = expiredExpected.length;
  }

  return {
    user_id: userId,
    mailbox,
    expected,
    existing: existing.results.map(r => r.resource),
    created,
    errors,
    deleted_legacy: deletedLegacy,
    deleted_expired: deletedExpired,
  };
}

import type { Env } from '../types/env';
import { getDecryptedAccessToken } from './helpers';
import { refreshOutlookToken } from '../integrations/oauth';

const GRAPH_SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
const MAX_EXPIRATION_MINUTES = 4230; // Graph max for mail: ~2.94 days

function webhookUrl(env: Env): string {
  const base = env.AZURE_REDIRECT_URI.replace('/auth/outlook/callback', '');
  return `${base}/webhooks/outlook-mail`;
}

function expirationDateTime(): string {
  const exp = new Date(Date.now() + MAX_EXPIRATION_MINUTES * 60 * 1000);
  return exp.toISOString();
}

export async function createMailSubscription(
  userId: string,
  orgId: string,
  env: Env
): Promise<{ subscriptionId: string } | null> {
  const refreshResult = await refreshOutlookToken(userId, orgId, env);
  if (!refreshResult.success) return null;

  let token: string;
  try {
    token = await getDecryptedAccessToken(userId, env);
  } catch {
    return null;
  }

  const clientState = `${orgId}:${userId}`;
  const body = {
    changeType: 'created',
    notificationUrl: webhookUrl(env),
    resource: 'me/mailFolders/inbox/messages',
    expirationDateTime: expirationDateTime(),
    clientState,
  };

  const resp = await fetch(GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to create mail subscription for user ${userId}:`, resp.status, err);
    return null;
  }

  const sub = (await resp.json()) as { id: string; expirationDateTime: string };

  await env.D1.prepare(
    `INSERT INTO graph_subscriptions (org_id, user_id, subscription_id, resource, expiration_at, client_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orgId, userId, sub.id, 'me/mailFolders/inbox/messages', sub.expirationDateTime, clientState).run();

  console.log(`[graph-sub] Created mail subscription ${sub.id} for user ${userId}, expires ${sub.expirationDateTime}`);
  return { subscriptionId: sub.id };
}

export async function createSentMailSubscription(
  userId: string,
  orgId: string,
  env: Env
): Promise<{ subscriptionId: string } | null> {
  const refreshResult = await refreshOutlookToken(userId, orgId, env);
  if (!refreshResult.success) return null;

  let token: string;
  try {
    token = await getDecryptedAccessToken(userId, env);
  } catch {
    return null;
  }

  const clientState = `${orgId}:${userId}`;
  const body = {
    changeType: 'created',
    notificationUrl: webhookUrl(env),
    resource: 'me/mailFolders/sentitems/messages',
    expirationDateTime: expirationDateTime(),
    clientState,
  };

  const resp = await fetch(GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to create sent-mail subscription for user ${userId}:`, resp.status, err);
    return null;
  }

  const sub = (await resp.json()) as { id: string; expirationDateTime: string };

  await env.D1.prepare(
    `INSERT INTO graph_subscriptions (org_id, user_id, subscription_id, resource, expiration_at, client_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orgId, userId, sub.id, 'me/mailFolders/sentitems/messages', sub.expirationDateTime, clientState).run();

  console.log(`[graph-sub] Created sent-mail subscription ${sub.id} for user ${userId}, expires ${sub.expirationDateTime}`);
  return { subscriptionId: sub.id };
}

export async function createCalendarSubscription(
  userId: string,
  orgId: string,
  env: Env
): Promise<{ subscriptionId: string } | null> {
  const refreshResult = await refreshOutlookToken(userId, orgId, env);
  if (!refreshResult.success) return null;

  let token: string;
  try {
    token = await getDecryptedAccessToken(userId, env);
  } catch {
    return null;
  }

  const clientState = `${orgId}:${userId}`;
  const body = {
    changeType: 'created,updated',
    notificationUrl: webhookUrl(env),
    resource: 'me/events',
    expirationDateTime: expirationDateTime(),
    clientState,
  };

  const resp = await fetch(GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[graph-sub] Failed to create calendar subscription for user ${userId}:`, resp.status, err);
    return null;
  }

  const sub = (await resp.json()) as { id: string; expirationDateTime: string };

  await env.D1.prepare(
    `INSERT INTO graph_subscriptions (org_id, user_id, subscription_id, resource, expiration_at, client_state)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(orgId, userId, sub.id, 'me/events', sub.expirationDateTime, clientState).run();

  console.log(`[graph-sub] Created calendar subscription ${sub.id} for user ${userId}, expires ${sub.expirationDateTime}`);
  return { subscriptionId: sub.id };
}

export async function renewSubscription(
  subscriptionId: string,
  userId: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  const refreshResult = await refreshOutlookToken(userId, orgId, env);
  if (!refreshResult.success) return false;

  let token: string;
  try {
    token = await getDecryptedAccessToken(userId, env);
  } catch {
    return false;
  }

  const resp = await fetch(`${GRAPH_SUBSCRIPTIONS_URL}/${subscriptionId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
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
    const token = await getDecryptedAccessToken(userId, env);
    await fetch(`${GRAPH_SUBSCRIPTIONS_URL}/${subscriptionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
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
    `SELECT subscription_id, user_id, org_id FROM graph_subscriptions
     WHERE expiration_at < ? ORDER BY expiration_at ASC LIMIT 50`
  ).bind(cutoff).all<{ subscription_id: string; user_id: string; org_id: string }>();

  for (const sub of expiring.results) {
    const ok = await renewSubscription(sub.subscription_id, sub.user_id, sub.org_id, env);
    if (!ok) {
      console.warn(`[graph-sub] Renewal failed for ${sub.subscription_id}, will recreate on next daily cron`);
    }
  }
}

// Self-heal: any active user (outlook_token AND outlook_delta_token both set)
// must have all three subscription resources. Closes the 2026-05-09 gap where
// expired subscriptions got 404 → D1 row deleted → never recreated because
// renewExpiringSubscriptions only renews and ensureSubscriptionsForUser was
// only called at OAuth time. ensureSubscriptionsForUser is idempotent on the
// resource set, so this is safe to fire every hour.
export async function ensureSubscriptionsForActiveUsers(env: Env): Promise<void> {
  const users = await env.D1.prepare(
    `SELECT id, org_id FROM users
       WHERE deleted_at IS NULL
         AND outlook_token IS NOT NULL
         AND outlook_delta_token IS NOT NULL`
  ).all<{ id: string; org_id: string }>();

  for (const u of users.results) {
    try {
      await ensureSubscriptionsForUser(u.id, u.org_id, env);
    } catch (e) {
      console.error(`[graph-sub] ensureSubscriptionsForActiveUsers failed for user ${u.id}:`, e);
    }
  }
}

export async function ensureSubscriptionsForUser(
  userId: string,
  orgId: string,
  env: Env
): Promise<void> {
  // Phase 2 (2026-05-13): now expiration-aware. Original implementation
  // only created subs for resources MISSING in D1, so an EXPIRED-but-
  // present row (e.g. Tony's mail subs expired 2026-05-09 with rows
  // never cleaned up because renewExpiringSubscriptions only deletes on
  // a 404 from Graph — non-404 failures leave the row in place forever)
  // would shadow ensure into a no-op and the subscription stayed dead.
  //
  // New behavior: for each row, if expiration_at < now, best-effort
  // delete it from Graph + drop the D1 row. Then for each of the three
  // expected resources, create fresh if not currently LIVE.
  const existing = await env.D1.prepare(
    'SELECT subscription_id, resource, expiration_at FROM graph_subscriptions WHERE user_id = ?'
  ).bind(userId).all<{ subscription_id: string; resource: string; expiration_at: string }>();

  const nowIso = new Date().toISOString();
  const liveResources = new Set<string>();

  for (const row of existing.results) {
    if (row.expiration_at < nowIso) {
      console.log(
        `[graph-sub] ensureSubscriptionsForUser: dropping stale ${row.resource} sub ${row.subscription_id} (expired ${row.expiration_at}) for user ${userId}`
      );
      // Best-effort delete from Graph — if Graph already 404s us, it's a
      // no-op. The D1 delete is what matters for re-creation.
      try {
        await deleteSubscription(row.subscription_id, userId, env);
      } catch {
        // ignore — fall through to D1 delete
      }
      try {
        await env.D1.prepare('DELETE FROM graph_subscriptions WHERE subscription_id = ?')
          .bind(row.subscription_id).run();
      } catch (e) {
        console.error(`[graph-sub] failed to delete stale row ${row.subscription_id}:`, e);
      }
    } else {
      liveResources.add(row.resource);
    }
  }

  if (!liveResources.has('me/mailFolders/inbox/messages')) {
    const result = await createMailSubscription(userId, orgId, env);
    if (!result) {
      console.error(`[graph-sub] ensureSubscriptionsForUser: createMailSubscription returned null for ${userId}`);
    }
  }
  if (!liveResources.has('me/mailFolders/sentitems/messages')) {
    const result = await createSentMailSubscription(userId, orgId, env);
    if (!result) {
      console.error(`[graph-sub] ensureSubscriptionsForUser: createSentMailSubscription returned null for ${userId}`);
    }
  }
  if (!liveResources.has('me/events')) {
    const result = await createCalendarSubscription(userId, orgId, env);
    if (!result) {
      console.error(`[graph-sub] ensureSubscriptionsForUser: createCalendarSubscription returned null for ${userId}`);
    }
  }
}

// TRD §6.2 — Slack Events API message sync
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { getDecryptedSlackBotToken } from '../lib/helpers';

interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
}

interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  subtype?: string;
  thread_ts?: string;
  channel?: string;
}

export async function fetchSlackMessages(
  orgId: string,
  env: Env
): Promise<ClassifiableItem[]> {
  const allItems: ClassifiableItem[] = [];

  const lastSync = (await env.KV.get(`slack_last_sync:${orgId}`)) || '0';

  let botToken: string;
  try {
    botToken = await getDecryptedSlackBotToken(orgId, env);
    console.log(`[slack] token resolved for org ${orgId} (${botToken.slice(0, 8)}...)`);
  } catch (e) {
    console.error(`[slack] token resolution failed for org ${orgId}:`, e);
    return [];
  }

  const authResp = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const authData = (await authResp.json()) as { ok: boolean; error?: string; team?: string; user?: string };
  console.log(`[slack] auth.test: ok=${authData.ok} team=${authData.team || 'n/a'} user=${authData.user || 'n/a'} error=${authData.error || 'none'}`);
  if (!authData.ok) return [];

  const channelsResp = await fetch(
    'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200',
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const channelsData = (await channelsResp.json()) as {
    ok: boolean;
    channels?: SlackChannel[];
    error?: string;
  };
  console.log(`[slack] conversations.list: ok=${channelsData.ok} channels=${channelsData.channels?.length ?? 0} error=${channelsData.error || 'none'}`);
  if (!channelsData.ok) return [];

  const channels = channelsData.channels || [];

  for (const channel of channels) {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        channel: channel.id,
        oldest: lastSync,
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      const resp = await fetch(
        `https://slack.com/api/conversations.history?${params}`,
        { headers: { Authorization: `Bearer ${botToken}` } }
      );
      const data = (await resp.json()) as {
        ok: boolean;
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      };
      if (!data.ok) {
        console.warn(`[slack] conversations.history failed for #${channel.name}: ${(data as any).error || 'unknown'}`);
        break;
      }

      for (const msg of data.messages || []) {
        if (msg.subtype) continue;
        if (!msg.user) continue;

        const userEmail = await resolveSlackUserEmail(msg.user, botToken, env);
        if (!userEmail) continue;

        allItems.push({
          type: 'slack_message',
          source: 'slack',
          externalId: `${channel.id}:${msg.ts}`,
          threadId: msg.thread_ts || msg.ts,
          subject: `#${channel.name}`,
          bodyText: msg.text,
          bodyPreview: msg.text.substring(0, 500),
          fromEmail: userEmail,
          fromName: msg.user,
          toEmails: [],
          ccEmails: [],
          sentAt: new Date(parseFloat(msg.ts) * 1000).toISOString(),
          direction: 'internal',
          userId: null,
          orgId,
          visibility: channel.is_private ? 'confidential' : 'org_wide',
        });
      }
      cursor = data.response_metadata?.next_cursor;
    } while (cursor);
  }

  console.log(`[slack] fetch complete: ${allItems.length} messages from ${channels.length} channels`);
  await env.KV.put(`slack_last_sync:${orgId}`, (Date.now() / 1000).toString());
  return allItems;
}

export async function resolveSlackUserEmail(
  slackUserId: string,
  botToken: string,
  env: Env
): Promise<string | null> {
  const cacheKey = `slack_user:${slackUserId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const resp = await fetch(
    `https://slack.com/api/users.info?user=${slackUserId}`,
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const data = (await resp.json()) as {
    ok: boolean;
    user?: { profile?: { email?: string } };
  };
  const email = data.user?.profile?.email;
  if (email) await env.KV.put(cacheKey, email, { expirationTtl: 86400 });
  return email || null;
}

export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  // Slack uses v0 HMAC-SHA256: signature = 'v0=' + hmac(secret, 'v0:' + timestamp + ':' + body)
  const basestring = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(basestring)
  );
  const hex = [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `v0=${hex}`;
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

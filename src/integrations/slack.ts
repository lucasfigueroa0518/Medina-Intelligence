// TRD §6.2 — Slack Events API message sync
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { getDecryptedSlackBotToken } from '../lib/helpers';

interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
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

export interface SlackChannelError {
  channel_id: string;
  channel_name: string;
  error: string;
}

export interface SlackFetchResult {
  messages: ClassifiableItem[];
  errors: SlackChannelError[];
  channels_visible: number;
}

// Subtypes that carry no human content. Anything else (file_share,
// thread_broadcast, me_message, etc.) is a real user post and gets ingested.
const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'bot_message', 'tombstone', 'ekm_access_denied',
]);

const SLACK_MAX_RETRIES = 2;

async function slackFetchWithRetry(
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, { headers });
    const retryAfter = resp.headers.get('Retry-After');
    const body = (await resp.json()) as { ok: boolean; error?: string; [k: string]: unknown };

    if (body.ok || body.error !== 'ratelimited' || attempt >= SLACK_MAX_RETRIES) {
      return new Response(JSON.stringify(body), {
        status: resp.status,
        headers: resp.headers,
      });
    }

    const delaySec = parseInt(retryAfter || '5', 10);
    console.warn(`[slack] ${label} rate-limited, retry ${attempt + 1}/${SLACK_MAX_RETRIES} after ${delaySec}s`);
    await new Promise(r => setTimeout(r, delaySec * 1000));
  }
}

export async function fetchSlackMessages(
  orgId: string,
  env: Env
): Promise<SlackFetchResult> {
  const messages: ClassifiableItem[] = [];
  const errors: SlackChannelError[] = [];

  let botToken: string;
  try {
    botToken = await getDecryptedSlackBotToken(orgId, env);
    console.log(`[slack] token resolved for org ${orgId} (${botToken.slice(0, 8)}...)`);
  } catch (e) {
    console.error(`[slack] token resolution failed for org ${orgId}:`, e);
    return { messages, errors, channels_visible: 0 };
  }

  const authHeaders = { Authorization: `Bearer ${botToken}` };

  const authResp = await slackFetchWithRetry(
    'https://slack.com/api/auth.test', authHeaders, 'auth.test',
  );
  const authData = (await authResp.json()) as { ok: boolean; error?: string; team?: string; user?: string };
  console.log(`[slack] auth.test: ok=${authData.ok} team=${authData.team || 'n/a'} user=${authData.user || 'n/a'} error=${authData.error || 'none'}`);
  if (!authData.ok) return { messages, errors, channels_visible: 0 };

  const channelsResp = await slackFetchWithRetry(
    'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200',
    authHeaders, 'conversations.list',
  );
  const channelsData = (await channelsResp.json()) as {
    ok: boolean;
    channels?: SlackChannel[];
    error?: string;
  };
  console.log(`[slack] conversations.list: ok=${channelsData.ok} channels=${channelsData.channels?.length ?? 0} error=${channelsData.error || 'none'}`);
  if (!channelsData.ok) {
    if (channelsData.error === 'ratelimited') {
      errors.push({ channel_id: '*', channel_name: '*', error: 'ratelimited:conversations.list' });
    }
    return { messages, errors, channels_visible: 0 };
  }

  const channels = channelsData.channels || [];
  let anyChannelReturnedMessages = false;

  // Persist the channel inventory + membership state so System Status can
  // surface "bot not in #X" without having to call Slack on every page load.
  // Audit 2026-04-28: this is also the surface where auto-join outcomes are
  // recorded — see the not_in_channel handler below.
  if (channels.length > 0) {
    await env.D1.batch(
      channels.map(c =>
        env.D1.prepare(
          `INSERT INTO slack_channels (org_id, channel_id, channel_name, is_member, is_private)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(org_id, channel_id) DO UPDATE SET
             channel_name = excluded.channel_name,
             is_member = excluded.is_member,
             is_private = excluded.is_private`
        ).bind(orgId, c.id, c.name, c.is_member ? 1 : 0, c.is_private ? 1 : 0)
      )
    );
  }

  for (const channel of channels) {
    // Per-channel marker so a newly-invited channel backfills from oldest=0
    // instead of inheriting the org-wide "last sync = now" and missing every
    // message that pre-dates the invite.
    const channelMarkerKey = `slack_last_sync:${orgId}:${channel.id}`;
    const channelLastSync = (await env.KV.get(channelMarkerKey)) || '0';
    let latestTsThisChannel = channelLastSync;
    let cursor: string | undefined;
    let channelHadError = false;

    do {
      const params = new URLSearchParams({
        channel: channel.id,
        oldest: channelLastSync,
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      const resp = await slackFetchWithRetry(
        `https://slack.com/api/conversations.history?${params}`,
        authHeaders, `conversations.history #${channel.name}`,
      );
      const data = (await resp.json()) as {
        ok: boolean;
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
        error?: string;
      };
      if (!data.ok) {
        const code = data.error || 'unknown';

        // Auto-join recovery: if we got listed by conversations.list but the
        // bot isn't actually in the channel, try to join and replay this
        // history call once. Audit 2026-04-28: the prior code just recorded
        // not_in_channel as an error every hour forever (#emerge sat
        // unjoinable in every run for >24h). Auto-join makes new public
        // channels reachable without manual /invite babysitting; private
        // channels still need a human to invite the bot.
        if (code === 'not_in_channel') {
          console.log(`[slack] auto-joining #${channel.name} (${channel.id})`);
          const joinResp = await slackFetchWithRetry(
            `https://slack.com/api/conversations.join?channel=${encodeURIComponent(channel.id)}`,
            authHeaders, `conversations.join #${channel.name}`,
          );
          const joinData = (await joinResp.json()) as { ok: boolean; error?: string };
          const joinedAt = new Date().toISOString();
          await env.D1.prepare(
            `UPDATE slack_channels
                SET is_member = ?, last_join_attempt_at = ?, last_error = ?
              WHERE org_id = ? AND channel_id = ?`
          ).bind(joinData.ok ? 1 : 0, joinedAt, joinData.ok ? null : (joinData.error || 'join_failed'), orgId, channel.id).run();

          if (joinData.ok) {
            console.log(`[slack] joined #${channel.name} — retrying history`);
            cursor = undefined; // restart from oldest
            continue;
          } else {
            const reason = joinData.error || 'join_failed';
            console.warn(`[slack] couldn't join #${channel.name}: ${reason}`);
            errors.push({ channel_id: channel.id, channel_name: channel.name, error: `cannot_join:${reason}` });
            channelHadError = true;
            break;
          }
        }

        console.warn(`[slack] conversations.history failed for #${channel.name}: ${code}`);
        errors.push({ channel_id: channel.id, channel_name: channel.name, error: code });
        await env.D1.prepare(
          `UPDATE slack_channels SET last_error = ? WHERE org_id = ? AND channel_id = ?`
        ).bind(code, orgId, channel.id).run();
        channelHadError = true;
        break;
      }

      for (const msg of data.messages || []) {
        if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) continue;
        if (!msg.user) continue;

        const userEmail = await resolveSlackUserEmail(msg.user, botToken, env);
        if (!userEmail) continue;

        messages.push({
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

        // Track the latest message ts in this channel so we can advance the
        // per-channel marker only past messages we actually persisted.
        if (parseFloat(msg.ts) > parseFloat(latestTsThisChannel)) {
          latestTsThisChannel = msg.ts;
        }
        anyChannelReturnedMessages = true;
      }
      cursor = data.response_metadata?.next_cursor;
    } while (cursor);

    // Only advance the per-channel marker on a clean pass with at least one
    // message. A 0-message clean pass leaves the marker untouched so the next
    // cycle re-checks the same window — cheap and avoids advancing past
    // messages that arrive between API call and our response.
    if (!channelHadError && latestTsThisChannel !== channelLastSync) {
      await env.KV.put(channelMarkerKey, latestTsThisChannel);
    }

    if (!channelHadError) {
      await env.D1.prepare(
        `UPDATE slack_channels
            SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                last_error = NULL
          WHERE org_id = ? AND channel_id = ?`
      ).bind(orgId, channel.id).run();
    }
  }

  // Org-level marker is for the Settings card "Last sync" display only — it
  // advances only when the cycle actually pulled at least one message, so a
  // user staring at the UI can tell when something was last ingested.
  if (anyChannelReturnedMessages) {
    await env.KV.put(`slack_last_sync:${orgId}`, new Date().toISOString());
  }

  console.log(
    `[slack] fetch complete: ${messages.length} messages from ${channels.length} channels, ${errors.length} channel errors`
  );

  return { messages, errors, channels_visible: channels.length };
}

export async function resolveSlackUserEmail(
  slackUserId: string,
  botToken: string,
  env: Env
): Promise<string | null> {
  const cacheKey = `slack_user:${slackUserId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const resp = await slackFetchWithRetry(
    `https://slack.com/api/users.info?user=${slackUserId}`,
    { Authorization: `Bearer ${botToken}` },
    `users.info ${slackUserId}`,
  );
  const data = (await resp.json()) as {
    ok: boolean;
    user?: { profile?: { email?: string } };
    error?: string;
  };
  if (!data.ok && data.error === 'ratelimited') {
    console.warn(`[slack] users.info rate-limited for ${slackUserId} after retries`);
    return null;
  }
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

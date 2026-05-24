// TRD §6.2 — Slack Events API message sync
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { getDecryptedSlackBotToken } from '../lib/helpers';
import { reportIngestionFailure, reportIngestionSuccess } from '../lib/ingestion-health';

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

// Per-tick wallclock budget for fetchSlackMessages. The function walks ALL
// visible channels × paginated history since each channel's last marker. With
// 16+ channels and a busy active workspace, an unbounded run can blow past
// the Cloudflare Worker 30s wallclock cap mid-pagination — partial data lands
// in conversations but the per-channel KV markers don't advance, leaving the
// next tick to refetch the same range. Bounding here keeps each tick within
// budget; the per-channel marker only advances on a clean pass with messages,
// so unfinished channels resume from the same `oldest` next tick. Phase E's
// 60-day backfill relies on `external_message_id LIKE '<channelId>:%'` over
// the full historical set, which means we need to actually GET those rows
// into conversations — exiting cleanly here is what makes that work.
export const SLACK_MAX_RUNTIME_MS = 25_000;

// KV counter for consecutive Slack auth failures (mirrors the
// token_failed:{user_id}:outlook pattern). Bumped on every auth.test
// non-ok response; cleared on success. integrations.ts already surfaces
// the live auth.test result on settings page load; this counter surfaces
// SUSTAINED failures ("the token has been broken for N hours") without
// round-tripping to Slack on every Settings render.
const SLACK_AUTH_FAIL_KEY_PREFIX = 'slack_token_failed:';
const SLACK_AUTH_FAIL_TTL_SECONDS = 7 * 86400; // 7 days

async function recordSlackAuthFailure(orgId: string, env: Env): Promise<number> {
  const key = `${SLACK_AUTH_FAIL_KEY_PREFIX}${orgId}`;
  const raw = await env.KV.get(key);
  const prev = raw ? parseInt(raw, 10) : 0;
  const next = (Number.isFinite(prev) ? prev : 0) + 1;
  await env.KV.put(
    key,
    String(next),
    { expirationTtl: SLACK_AUTH_FAIL_TTL_SECONDS }
  );
  return next;
}

async function clearSlackAuthFailures(orgId: string, env: Env): Promise<void> {
  await env.KV.delete(`${SLACK_AUTH_FAIL_KEY_PREFIX}${orgId}`);
}

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
  const startedAt = Date.now();
  const messages: ClassifiableItem[] = [];
  const errors: SlackChannelError[] = [];

  let botToken: string;
  try {
    botToken = await getDecryptedSlackBotToken(orgId, env);
    console.log(`[slack] token resolved for org ${orgId} (${botToken.slice(0, 8)}...)`);
  } catch (e) {
    console.error(`[slack] token resolution failed for org ${orgId}:`, e);
    errors.push({ channel_id: '*', channel_name: '*', error: `token_resolution_failed:${e instanceof Error ? e.message : String(e)}` });
    await reportIngestionFailure(env, {
      orgId,
      source: 'slack',
      code: 'slack_token_resolution_failed',
      message: `Slack ingestion cannot decrypt or resolve the bot token: ${e instanceof Error ? e.message : String(e)}`,
      severity: 'critical',
      humanActionRequired: true,
    }).catch(() => {});
    return { messages, errors, channels_visible: 0 };
  }

  const authHeaders = { Authorization: `Bearer ${botToken}` };

  const authResp = await slackFetchWithRetry(
    'https://slack.com/api/auth.test', authHeaders, 'auth.test',
  );
  const authData = (await authResp.json()) as { ok: boolean; error?: string; team?: string; user?: string };
  console.log(`[slack] auth.test: ok=${authData.ok} team=${authData.team || 'n/a'} user=${authData.user || 'n/a'} error=${authData.error || 'none'}`);
  if (!authData.ok) {
    // Sustained-failure counter: surfaces "token has been broken for N
    // consecutive checks" without round-tripping Slack on every Settings
    // render. Bot tokens don't expire automatically but CAN be revoked
    // (workspace owner removes the app, scope is reduced, etc.) — this
    // surface gives the Settings card a way to differentiate a transient
    // hiccup from a sustained outage. integrations.ts can read this KV
    // counter and reflect it in the IntegrationRow.detail.
    const count = await recordSlackAuthFailure(orgId, env);
    console.error(`[slack] auth.test failed (${authData.error || 'unknown'}); consecutive_failures=${count}`);
    errors.push({ channel_id: '*', channel_name: '*', error: `auth_failed:${authData.error || 'unknown'}` });
    await reportIngestionFailure(env, {
      orgId,
      source: 'slack',
      code: 'slack_auth_failed',
      message: `Slack ingestion is blocked because auth.test failed (${authData.error || 'unknown'}).`,
      severity: count >= 3 ? 'critical' : 'warning',
      humanActionRequired: count >= 3,
      metadata: { consecutive_failures: count, slack_error: authData.error || 'unknown' },
    }).catch(() => {});
    return { messages, errors, channels_visible: 0 };
  }
  // Clear the counter on success — sustained-failure window resets the
  // moment the token starts working again.
  await clearSlackAuthFailures(orgId, env);

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
    const code = channelsData.error || 'unknown';
    errors.push({ channel_id: '*', channel_name: '*', error: `${code}:conversations.list` });
    await reportIngestionFailure(env, {
      orgId,
      source: 'slack',
      code: 'slack_channels_list_failed',
      message: `Slack channel inventory failed: ${code}. Automatic repair will retry with backoff.`,
      severity: code === 'ratelimited' ? 'warning' : 'critical',
      humanActionRequired: /invalid_auth|not_authed|account_inactive|missing_scope/i.test(code),
      metadata: { slack_error: code },
    }).catch(() => {});
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

    // Phase E: background classifier. For each visible channel, attempt
    // to fuzzy-match channel name → open-deal company name. On match,
    // insert slack_channel_deals + backfill last 60d into
    // conversation_deals via inherited_channel. Idempotent (PKs collapse
    // dupes), so running every sync is cheap-ish — Jaccard runs in-Worker
    // against ≤200 open deals, no LLM calls. Best-effort; per-channel
    // failure swallowed so a bad channel never blocks message ingestion.
    try {
      const { classifySlackChannelForDeals } = await import('../lib/deal-association');
      let totalLinked = 0;
      let totalBackfilled = 0;
      for (const c of channels) {
        try {
          const r = await classifySlackChannelForDeals(c.id, c.name, orgId, env);
          totalLinked += r.linked;
          totalBackfilled += r.backfilled;
        } catch (e) {
          console.error(`[slack-classifier] failed for #${c.name} (${c.id}):`, e);
        }
      }
      if (totalLinked > 0 || totalBackfilled > 0) {
        console.log(`[slack-classifier] sweep: linked=${totalLinked} backfilled=${totalBackfilled} channels=${channels.length}`);
      }
    } catch (e) {
      console.error('[slack-classifier] import failed:', e);
    }
  }

  let budgetExhausted = false;

  for (const channel of channels) {
    if (Date.now() - startedAt > SLACK_MAX_RUNTIME_MS) {
      budgetExhausted = true;
      console.warn(
        `[slack] wallclock budget exhausted at channel #${channel.name}; ` +
        `${messages.length} messages collected so far, remaining channels resume next tick`
      );
      break;
    }

    // Per-channel marker so a newly-invited channel backfills from oldest=0
    // instead of inheriting the org-wide "last sync = now" and missing every
    // message that pre-dates the invite.
    const channelMarkerKey = `slack_last_sync:${orgId}:${channel.id}`;
    const channelLastSync = (await env.KV.get(channelMarkerKey)) || '0';
    let latestTsThisChannel = channelLastSync;
    let cursor: string | undefined;
    let channelHadError = false;

    do {
      if (Date.now() - startedAt > SLACK_MAX_RUNTIME_MS) {
        // Mid-channel budget exhaustion. Don't advance the marker for this
        // channel — next tick re-fetches from the same `channelLastSync`.
        // Phase E's backfill query relies on completeness, so it's better
        // to refetch some messages than to skip a chunk silently.
        budgetExhausted = true;
        channelHadError = true; // suppresses marker advance below
        console.warn(
          `[slack] wallclock budget exhausted mid-pagination of #${channel.name}; ` +
          `marker preserved for resume next tick`
        );
        break;
      }
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

        const userEmail = await resolveSlackUserEmail(msg.user, botToken, env)
          || `${msg.user.toLowerCase()}@slack.local`;

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
      await reportIngestionSuccess(env, {
        orgId,
        source: 'slack',
        scopeType: 'channel',
        scopeId: channel.id,
        metadata: { channel_name: channel.name },
      }).catch(() => {});
    }
  }

  // Org-level marker is for the Settings card "Last sync" display only — it
  // advances only when the cycle actually pulled at least one message, so a
  // user staring at the UI can tell when something was last ingested.
  if (anyChannelReturnedMessages) {
    await env.KV.put(`slack_last_sync:${orgId}`, new Date().toISOString());
  }

  if (errors.length === 0) {
    await reportIngestionSuccess(env, {
      orgId,
      source: 'slack',
      metadata: { channels_visible: channels.length, messages: messages.length },
    }).catch(() => {});
  }

  console.log(
    `[slack] fetch complete: ${messages.length} messages from ${channels.length} channels, ${errors.length} channel errors` +
    (budgetExhausted ? ` (budget_exhausted=true; some channels will resume next tick)` : '')
  );

  return { messages, errors, channels_visible: channels.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-channel admin force-resync. Lets ops force a deeper backfill for a
// specific channel than the per-channel KV marker would naturally yield —
// useful when a channel's been around longer than we have message coverage
// for (Phase E's 60-day backfillSlackChannelToDeal needs the conversations
// in DB to actually land deal links). days_back=null means "from oldest"
// (Slack's default). Wallclock-budgeted just like the regular sync.
// ────────────────────────────────────────────────────────────────────────────

export interface SlackChannelBackfillResult {
  channel_id: string;
  channel_name: string | null;
  messages_fetched: number;
  pages: number;
  cursor_remaining: boolean;
  error: string | null;
  budget_exhausted: boolean;
}

export async function backfillSlackChannelHistory(
  orgId: string,
  channelId: string,
  daysBack: number | null,
  env: Env
): Promise<SlackChannelBackfillResult> {
  const startedAt = Date.now();
  const result: SlackChannelBackfillResult = {
    channel_id: channelId,
    channel_name: null,
    messages_fetched: 0,
    pages: 0,
    cursor_remaining: false,
    error: null,
    budget_exhausted: false,
  };

  let botToken: string;
  try {
    botToken = await getDecryptedSlackBotToken(orgId, env);
  } catch (e: any) {
    result.error = `token_resolution: ${String(e?.message || e).slice(0, 200)}`;
    return result;
  }
  const authHeaders = { Authorization: `Bearer ${botToken}` };

  // Resolve channel_name from slack_channels for log readability and the
  // ClassifiableItem.subject downstream. If the channel isn't in our table
  // (rare — bot would normally see it via conversations.list), we still
  // fetch but stamp channel_name as the channel_id.
  const channelRow = await env.D1.prepare(
    `SELECT channel_name, is_private FROM slack_channels WHERE org_id = ? AND channel_id = ?`
  ).bind(orgId, channelId).first<{ channel_name: string | null; is_private: number }>();
  result.channel_name = channelRow?.channel_name || channelId;
  const isPrivate = channelRow?.is_private === 1;

  const oldest = daysBack !== null && daysBack > 0
    ? String(Math.floor((Date.now() - daysBack * 86400000) / 1000))
    : '0';

  const messages: ClassifiableItem[] = [];
  let cursor: string | undefined;

  while (true) {
    if (Date.now() - startedAt > SLACK_MAX_RUNTIME_MS) {
      result.budget_exhausted = true;
      result.cursor_remaining = !!cursor;
      break;
    }
    const params = new URLSearchParams({
      channel: channelId,
      oldest,
      limit: '200',
      ...(cursor ? { cursor } : {}),
    });
    const resp = await slackFetchWithRetry(
      `https://slack.com/api/conversations.history?${params}`,
      authHeaders, `conversations.history backfill #${result.channel_name}`,
    );
    const data = (await resp.json()) as {
      ok: boolean;
      messages?: SlackMessage[];
      response_metadata?: { next_cursor?: string };
      error?: string;
    };
    result.pages++;
    if (!data.ok) {
      result.error = data.error || 'unknown';
      break;
    }
    for (const msg of data.messages || []) {
      if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) continue;
      if (!msg.user) continue;
      const userEmail = await resolveSlackUserEmail(msg.user, botToken, env)
        || `${msg.user.toLowerCase()}@slack.local`;
      messages.push({
        type: 'slack_message',
        source: 'slack',
        externalId: `${channelId}:${msg.ts}`,
        threadId: msg.thread_ts || msg.ts,
        subject: `#${result.channel_name}`,
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
        visibility: isPrivate ? 'confidential' : 'org_wide',
      });
    }
    result.messages_fetched += messages.length - result.messages_fetched;
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  // Caller (admin handler) is responsible for routing `messages` through
  // classifyAndDeduplicate → stage-approvals just like the regular cron
  // path. Returning the messages list rather than persisting here keeps
  // the ingestion semantics in one place (classification.ts).
  (result as SlackChannelBackfillResult & { _messages: ClassifiableItem[] })._messages = messages;
  return result;
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

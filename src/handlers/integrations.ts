// TRD §5.1 — Live integration status for the Settings page.
//
// GET /api/integrations/status
//
// Returns the real connection state for each integration, scoped to the
// currently authenticated user. Used by the Settings page to render dynamic
// "Connect" vs "Manage" buttons instead of static labels.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse } from './utils';
import { listActiveIngestionIncidents } from '../lib/ingestion-health';

export type IntegrationStatus =
  | 'connected'
  | 'not_connected'
  | 'configured'
  | 'not_configured'
  | 'configured_no_channels'
  | 'auth_failed'
  | 'webhook_ready';

export interface IntegrationRow {
  status: IntegrationStatus;
  label: string;
  detail?: string;
  last_sync?: string | null;
  connected_email?: string | null;
  token_healthy?: boolean;
  webhook_url?: string;
  items_processed?: number;
  items_failed?: number;
  enriched_count?: number;
  rate_limit_status?: 'active' | 'rate_limited' | 'auth_failed';
  rate_limit_until?: string | null;
  // Slack-specific
  team_name?: string | null;
  bot_user_id?: string | null;
  channels_visible?: number;
  messages_synced?: number;
  warnings?: string[];
}

export interface IntegrationsStatusResponse {
  outlook: IntegrationRow;
  slack: IntegrationRow;
  reversecontact: IntegrationRow;
  firefly: IntegrationRow;
}

const WEBHOOK_SECRET_KV_KEY = 'firefly_webhook_secret';

export async function getFireflyWebhookSecret(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  let secret = await env.KV.get(WEBHOOK_SECRET_KV_KEY);
  if (!secret) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    secret = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.KV.put(WEBHOOK_SECRET_KV_KEY, secret);
  }
  return jsonResponse({ secret });
}

export async function getIntegrationsStatus(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  // --- Outlook: check the current user's row ---
  const user = await env.D1.prepare(
    `SELECT email, outlook_token, outlook_delta_token, updated_at
       FROM users
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId, ctx.orgId).first<{
    email: string;
    outlook_token: string | null;
    outlook_delta_token: string | null;
    updated_at: string;
  }>();

  const outlookConnected = Boolean(user?.outlook_token);

  // Token refresh health counter (§5.3)
  const failState = outlookConnected
    ? await env.KV.get<{ count: number; last_failed?: string }>(
        `token_failed:${ctx.userId}:outlook`,
        'json'
      )
    : null;
  const tokenHealthy = !failState || (failState.count || 0) < 3;
  const outlookStatus: IntegrationStatus = !outlookConnected
    ? 'not_connected'
    : tokenHealthy
      ? 'connected'
      : 'auth_failed';

  // Last ingestion sync for this org (proxy for "last email sync ran")
  const lastSync = outlookConnected
    ? await env.D1.prepare(
        `SELECT completed_at, items_processed, items_failed FROM sync_jobs
          WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'completed'
          ORDER BY completed_at DESC LIMIT 1`
      )
        .bind(ctx.orgId)
        .first<{ completed_at: string | null; items_processed: number; items_failed: number }>()
    : null;

  const outlook: IntegrationRow = {
    status: outlookStatus,
    label: outlookStatus === 'connected'
      ? 'Connected'
      : outlookStatus === 'auth_failed'
        ? 'Refresh needed'
        : 'Not connected',
    detail: outlookStatus === 'connected'
      ? `Signed in as ${user?.email || 'unknown'}`
      : outlookStatus === 'auth_failed'
        ? `Refresh Microsoft Outlook for ${user?.email || 'this mailbox'} to resume live email and calendar updates.`
        : 'Click Connect to authorize email, calendar, and Sent-folder access.',
    last_sync: lastSync?.completed_at || null,
    connected_email: outlookConnected ? user?.email || null : null,
    token_healthy: outlookConnected ? tokenHealthy : undefined,
    items_processed: lastSync?.items_processed || 0,
    items_failed: lastSync?.items_failed || 0,
  };

  // --- Slack: pre-configured bot token + live auth/channel probe ---
  const slack = await buildSlackIntegrationRow(ctx.orgId, env);

  // --- ReverseContact: API key env + health ---
  const rcConfigured = Boolean(
    env.REVERSECONTACT_API_KEY && env.REVERSECONTACT_API_KEY.trim().length > 0
  );

  let rcRateLimitStatus: 'active' | 'rate_limited' | 'auth_failed' = 'active';
  let rcRateLimitUntil: string | null = null;
  let rcEnrichedCount = 0;

  if (rcConfigured) {
    const [rcRateState, rcCircuit, enrichedRow] = await Promise.all([
      env.KV.get<{ blocked_until?: string }>(`rate_limit:reversecontact:${ctx.orgId}`, 'json'),
      env.KV.get(`rc_failures:${ctx.orgId}`),
      env.D1.prepare(
        `SELECT COUNT(*) as cnt FROM contacts WHERE org_id = ? AND linkedin_data_r2_key IS NOT NULL AND deleted_at IS NULL`
      ).bind(ctx.orgId).first<{ cnt: number }>(),
    ]);

    rcEnrichedCount = enrichedRow?.cnt || 0;

    const circuitCount = rcCircuit ? parseInt(rcCircuit, 10) : 0;
    if (circuitCount >= 3) {
      rcRateLimitStatus = 'auth_failed';
    } else if (rcRateState?.blocked_until && new Date(rcRateState.blocked_until) > new Date()) {
      rcRateLimitStatus = 'rate_limited';
      rcRateLimitUntil = rcRateState.blocked_until;
    }
  }

  let rcDetail: string;
  if (!rcConfigured) {
    rcDetail = 'Run `wrangler secret put REVERSECONTACT_API_KEY` on the Worker.';
  } else if (rcRateLimitStatus === 'auth_failed') {
    rcDetail = 'Authentication failed — check API key.';
  } else if (rcRateLimitStatus === 'rate_limited') {
    rcDetail = `Rate limited — resumes at ${new Date(rcRateLimitUntil!).toLocaleString()}.`;
  } else {
    rcDetail = `Active — ${rcEnrichedCount} contacts enriched via LinkedIn.`;
  }

  const reversecontact: IntegrationRow = {
    status: rcConfigured ? 'configured' : 'not_configured',
    label: rcConfigured ? 'Configured' : 'Not configured',
    detail: rcDetail,
    rate_limit_status: rcRateLimitStatus,
    rate_limit_until: rcRateLimitUntil,
    enriched_count: rcEnrichedCount,
  };

  // --- Firefly: webhook URL is derived from the request host ---
  // Status reflects actual delivery activity, not just "we have an endpoint".
  // Pre-cleanup the status was hardcoded to 'webhook_ready' which was a UI
  // lie — it stayed green even when zero webhooks had ever arrived. We now
  // probe sync_jobs for firefly-webhook rows: presence ⇒ Fireflies has
  // successfully delivered to us; absence ⇒ webhook is configured on our
  // side but Fireflies isn't (yet) firing into it.
  const requestUrl = new URL(request.url);
  const webhookUrl = `${requestUrl.origin}/webhooks/firefly`;
  const lastWebhook = await env.D1.prepare(
    `SELECT MAX(completed_at) AS last_at FROM sync_jobs
       WHERE org_id = ? AND workflow_type = 'firefly-webhook' AND status = 'completed'`
  ).bind(ctx.orgId).first<{ last_at: string | null }>();
  const firefly: IntegrationRow = lastWebhook?.last_at
    ? {
        status: 'webhook_ready',
        label: 'Receiving deliveries',
        detail: `Last meeting received ${new Date(lastWebhook.last_at).toLocaleString()}.`,
        last_sync: lastWebhook.last_at,
        webhook_url: webhookUrl,
      }
    : {
        status: 'webhook_ready',
        label: 'Awaiting first delivery',
        detail:
          'Webhook endpoint configured on our side. If Fireflies is set up but no meetings have arrived, verify the signing secret + webhook URL in the Fireflies dashboard match the values in the setup guide below.',
        last_sync: null,
        webhook_url: webhookUrl,
      };

  const incidents = await listActiveIngestionIncidents(env, ctx.orgId, 25).catch(() => []);
  const attachIncidentWarnings = (row: IntegrationRow, sources: string[]) => {
    const matching = incidents.filter(i => sources.includes(i.source));
    if (matching.length === 0) return;
    row.warnings = [
      ...(row.warnings || []),
      ...matching.slice(0, 4).map(i => `${i.severity === 'critical' ? 'Critical' : 'Warning'}: ${i.message}`),
    ];
    if (matching.some(i => i.severity === 'critical' || i.human_action_required === 1)) {
      row.status = 'auth_failed';
      row.label = row.label === 'Connected' ? 'Degraded' : row.label;
    }
  };

  attachIncidentWarnings(outlook, ['outlook_email', 'calendar']);
  attachIncidentWarnings(slack, ['slack']);
  attachIncidentWarnings(firefly, ['firefly']);

  const body: IntegrationsStatusResponse = {
    outlook,
    slack,
    reversecontact,
    firefly,
  };
  return jsonResponse(body);
}

// ────────────────────────────────────────────────────────────────────────────
// Slack: live auth + channel probe with 1h KV cache.
//
// Settings page loads this on every visit, so we don't want to hammer Slack's
// API. auth.test and conversations.list are each cached for 1h per org.
// ────────────────────────────────────────────────────────────────────────────

interface SlackAuthCache {
  ok: boolean;
  team_name?: string;
  bot_user_id?: string;
  error?: string;
}

interface SlackChannelsCache {
  ok: boolean;
  count: number;
  error?: string;
}

async function buildSlackIntegrationRow(orgId: string, env: Env): Promise<IntegrationRow> {
  const tokenPresent = Boolean(
    env.SLACK_BOT_TOKEN && env.SLACK_BOT_TOKEN.trim().length > 0
  );

  if (!tokenPresent) {
    return {
      status: 'not_configured',
      label: 'Not configured',
      detail: 'No bot token configured. Run `wrangler secret put SLACK_BOT_TOKEN`.',
      team_name: null,
      bot_user_id: null,
      channels_visible: 0,
      messages_synced: 0,
      warnings: [],
    };
  }

  const token = env.SLACK_BOT_TOKEN!.trim();

  // ── auth.test (1h KV cache) ──
  const authCacheKey = `slack_auth_cache:${orgId}`;
  let auth = await env.KV.get<SlackAuthCache>(authCacheKey, 'json');
  if (!auth) {
    try {
      const resp = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await resp.json()) as { ok: boolean; team?: string; user_id?: string; error?: string };
      auth = data.ok
        ? { ok: true, team_name: data.team, bot_user_id: data.user_id }
        : { ok: false, error: data.error || 'unknown' };
    } catch (e: any) {
      auth = { ok: false, error: e?.message || 'fetch_failed' };
    }
    await env.KV.put(authCacheKey, JSON.stringify(auth), { expirationTtl: 3600 });
  }

  if (!auth.ok) {
    // Layer in the sustained-failure counter that fetchSlackMessages
    // bumps whenever auth.test returns non-ok during the hourly cron.
    // Differentiates a fresh hiccup ("just now, 1 failure") from a
    // sustained outage ("broken for 12 hours, 12 failures") so the
    // operator can prioritize correctly.
    const sustained = await env.KV.get(`slack_token_failed:${orgId}`);
    const consecutive = sustained ? parseInt(sustained, 10) : 0;
    const sustainedNote = consecutive > 1
      ? ` (${consecutive} consecutive cron failures)`
      : '';
    return {
      status: 'auth_failed',
      label: 'Authentication failed',
      detail: `Slack API rejected the bot token (${auth.error})${sustainedNote}. Reinstall the Slack app or run \`wrangler secret put SLACK_BOT_TOKEN\`.`,
      team_name: null,
      bot_user_id: null,
      channels_visible: 0,
      messages_synced: 0,
      warnings: [],
    };
  }

  // ── conversations.list (1h KV cache) ──
  const channelsCacheKey = `slack_channels_cache:${orgId}`;
  let channels = await env.KV.get<SlackChannelsCache>(channelsCacheKey, 'json');
  if (!channels) {
    try {
      const resp = await fetch(
        'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = (await resp.json()) as { ok: boolean; channels?: unknown[]; error?: string };
      channels = data.ok
        ? { ok: true, count: data.channels?.length || 0 }
        : { ok: false, count: 0, error: data.error || 'unknown' };
    } catch (e: any) {
      channels = { ok: false, count: 0, error: e?.message || 'fetch_failed' };
    }
    await env.KV.put(channelsCacheKey, JSON.stringify(channels), { expirationTtl: 3600 });
  }

  // ── messages_synced (live D1 count) + last_sync (KV) ──
  const [msgRow, lastSync] = await Promise.all([
    env.D1.prepare(
      `SELECT COUNT(*) as n FROM conversations
        WHERE org_id = ? AND source = 'slack'`
    ).bind(orgId).first<{ n: number }>(),
    env.KV.get(`slack_last_sync:${orgId}`),
  ]);
  const messagesSynced = msgRow?.n || 0;

  // ── Status + UX ──
  const warnings: string[] = [];
  let status: IntegrationStatus;
  let label: string;
  let detail: string;

  if (channels.count === 0) {
    status = 'configured_no_channels';
    label = 'No channel access';
    detail = `Bot installed in ${auth.team_name || 'workspace'} but not invited to any channels. Use \`/invite @${auth.bot_user_id || 'bot'}\` in each channel you want indexed.`;
  } else {
    status = 'connected';
    label = 'Connected';
    detail = `${channels.count} channel${channels.count === 1 ? '' : 's'} visible.`;
    if (messagesSynced === 0) {
      warnings.push('Bot is in channels but no messages have been synced. Verify channels have recent activity.');
    }
  }

  return {
    status,
    label,
    detail,
    last_sync: lastSync || null,
    team_name: auth.team_name || null,
    bot_user_id: auth.bot_user_id || null,
    channels_visible: channels.count,
    messages_synced: messagesSynced,
    warnings,
  };
}

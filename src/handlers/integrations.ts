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

export type IntegrationStatus =
  | 'connected'
  | 'not_connected'
  | 'configured'
  | 'not_configured'
  | 'webhook_ready';

export interface IntegrationRow {
  status: IntegrationStatus;
  label: string;
  detail?: string;
  last_sync?: string | null;
  connected_email?: string | null;
  token_healthy?: boolean;
  webhook_url?: string;
}

export interface IntegrationsStatusResponse {
  outlook: IntegrationRow;
  slack: IntegrationRow;
  reversecontact: IntegrationRow;
  firefly: IntegrationRow;
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

  // Last ingestion sync for this org (proxy for "last email sync ran")
  const lastSync = outlookConnected
    ? await env.D1.prepare(
        `SELECT completed_at FROM sync_jobs
          WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'completed'
          ORDER BY completed_at DESC LIMIT 1`
      )
        .bind(ctx.orgId)
        .first<{ completed_at: string | null }>()
    : null;

  const outlook: IntegrationRow = {
    status: outlookConnected ? 'connected' : 'not_connected',
    label: outlookConnected ? 'Connected' : 'Not connected',
    detail: outlookConnected
      ? tokenHealthy
        ? `Signed in as ${user?.email || 'unknown'}`
        : `Signed in as ${user?.email || 'unknown'} — token refresh failing`
      : 'Click Connect to authorize email, calendar, and Sent-folder access.',
    last_sync: lastSync?.completed_at || null,
    connected_email: outlookConnected ? user?.email || null : null,
    token_healthy: outlookConnected ? tokenHealthy : undefined,
  };

  // --- Slack: pre-configured bot token (no OAuth flow) ---
  const slackConfigured = Boolean(
    env.SLACK_BOT_TOKEN && env.SLACK_BOT_TOKEN.trim().length > 0
  );
  const slack: IntegrationRow = {
    status: slackConfigured ? 'configured' : 'not_configured',
    label: slackConfigured ? 'Bot configured' : 'Not configured',
    detail: slackConfigured
      ? 'Invite the bot to channels to start syncing.'
      : 'Run `wrangler secret put SLACK_BOT_TOKEN` on the Worker.',
  };

  // --- ReverseContact: API key env ---
  const rcConfigured = Boolean(
    env.REVERSECONTACT_API_KEY && env.REVERSECONTACT_API_KEY.trim().length > 0
  );
  const reversecontact: IntegrationRow = {
    status: rcConfigured ? 'configured' : 'not_configured',
    label: rcConfigured ? 'Configured' : 'Not configured',
    detail: rcConfigured
      ? 'LinkedIn contact + company enrichment via API key.'
      : 'Run `wrangler secret put REVERSECONTACT_API_KEY` on the Worker.',
  };

  // --- Firefly: webhook URL is derived from the request host ---
  const requestUrl = new URL(request.url);
  const webhookUrl = `${requestUrl.origin}/webhooks/firefly`;
  const firefly: IntegrationRow = {
    status: 'webhook_ready',
    label: 'Webhook ready',
    detail:
      'Configure the Firefly dashboard to POST meeting-completion events to the webhook URL below.',
    webhook_url: webhookUrl,
  };

  const body: IntegrationsStatusResponse = {
    outlook,
    slack,
    reversecontact,
    firefly,
  };
  return jsonResponse(body);
}

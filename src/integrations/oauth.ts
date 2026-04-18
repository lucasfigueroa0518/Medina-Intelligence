// TRD §5.3 — OAuth token refresh with failure tracking
import type { Env } from '../types/env';
import { decryptToken, encryptToken } from '../lib/encryption';
import { emitAudit } from '../lib/audit';

export async function refreshOutlookToken(
  userId: string,
  orgId: string,
  env: Env
): Promise<{ success: boolean; consecutiveFailures?: number }> {
  const user = await env.D1.prepare(
    'SELECT outlook_token FROM users WHERE id = ?'
  ).bind(userId).first<{ outlook_token: string | null }>();

  if (!user?.outlook_token) return { success: false };

  try {
    const decrypted = await decryptToken(user.outlook_token, env);

    const tenantId = env.AZURE_TENANT_ID || 'common';
    const refreshed = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.AZURE_CLIENT_ID,
          client_secret: env.AZURE_CLIENT_SECRET,
          refresh_token: decrypted.refresh_token,
          grant_type: 'refresh_token',
          scope: 'https://graph.microsoft.com/.default offline_access',
        }),
      }
    );

    if (!refreshed.ok) throw new Error(`Token refresh failed: ${refreshed.status}`);

    const tokens = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };

    const encrypted = await encryptToken(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || decrypted.refresh_token,
        expires_at: new Date(
          Date.now() + (tokens.expires_in || 3600) * 1000
        ).toISOString(),
      },
      env
    );

    await env.D1.prepare(
      `UPDATE users SET outlook_token = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(encrypted, userId).run();

    await env.KV.delete(`token_failed:${userId}:outlook`);
    return { success: true };
  } catch (e) {
    const failKey = `token_failed:${userId}:outlook`;
    const state = await env.KV.get<{ count: number }>(failKey, 'json');
    const count = (state?.count || 0) + 1;

    await env.KV.put(
      failKey,
      JSON.stringify({ count, last_failed: new Date().toISOString() }),
      { expirationTtl: 604800 }
    );

    await emitAudit(env, {
      org_id: orgId,
      user_id: userId,
      action: 'token_refresh_failed',
      entity_type: 'user',
      entity_id: userId,
      metadata: { provider: 'outlook', consecutive_failures: count },
      created_at: new Date().toISOString(),
    });

    return { success: false, consecutiveFailures: count };
  }
}

export async function recordTokenFailure(
  userId: string,
  provider: string,
  env: Env
): Promise<void> {
  const failKey = `token_failed:${userId}:${provider}`;
  const state = await env.KV.get<{ count: number }>(failKey, 'json');
  const count = (state?.count || 0) + 1;
  await env.KV.put(
    failKey,
    JSON.stringify({ count, last_failed: new Date().toISOString() }),
    { expirationTtl: 604800 }
  );
}

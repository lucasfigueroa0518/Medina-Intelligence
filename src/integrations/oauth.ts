// TRD §5.3 — OAuth token refresh with failure tracking
import type { Env } from '../types/env';
import { decryptToken, encryptToken } from '../lib/encryption';
import { emitAudit } from '../lib/audit';

const OUTLOOK_REFRESH_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/Contacts.Read',
  'offline_access',
].join(' ');

const ACCESS_TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;

type OutlookRefreshFailureReason =
  | 'missing_token'
  | 'reauth_required'
  | 'transient'
  | 'config_error';

interface TokenEndpointError {
  status: number;
  errorCode: string | null;
  message: string;
}

function accessTokenStillFresh(tokens: Record<string, string>): boolean {
  const expiresAt = tokens.expires_at ? Date.parse(tokens.expires_at) : NaN;
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_SKEW_MS;
}

function parseTokenEndpointError(status: number, body: string): TokenEndpointError {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };
    return {
      status,
      errorCode: parsed.error || null,
      message: String(parsed.error_description || parsed.error || body || `HTTP ${status}`).slice(0, 800),
    };
  } catch {
    return {
      status,
      errorCode: null,
      message: String(body || `HTTP ${status}`).slice(0, 800),
    };
  }
}

function classifyTokenEndpointError(error: TokenEndpointError): OutlookRefreshFailureReason {
  const code = (error.errorCode || '').toLowerCase();
  if (error.status === 408 || error.status === 429 || error.status >= 500) return 'transient';
  if (code === 'temporarily_unavailable' || code === 'server_error') return 'transient';
  if (code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required') {
    return 'reauth_required';
  }
  if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'invalid_scope') {
    return 'config_error';
  }
  return error.status >= 500 ? 'transient' : 'config_error';
}

async function storedTokenChangedAndFresh(
  userId: string,
  originalEncryptedToken: string,
  env: Env
): Promise<boolean> {
  const current = await env.D1.prepare(
    'SELECT outlook_token FROM users WHERE id = ?'
  ).bind(userId).first<{ outlook_token: string | null }>();
  if (!current?.outlook_token || current.outlook_token === originalEncryptedToken) return false;
  try {
    const tokens = await decryptToken(current.outlook_token, env);
    return accessTokenStillFresh(tokens);
  } catch {
    return false;
  }
}

async function acquireIngestionLock(
  env: Env,
  lockKey: string,
  ttlMs = 60_000
): Promise<string | null> {
  const owner = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const row = await env.D1.prepare(
    `INSERT INTO ingestion_locks (lock_key, owner, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(lock_key) DO UPDATE SET
       owner = excluded.owner,
       expires_at = excluded.expires_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE ingestion_locks.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING owner`
  ).bind(lockKey, owner, expiresAt).first<{ owner: string }>();
  return row?.owner === owner ? owner : null;
}

async function releaseIngestionLock(env: Env, lockKey: string, owner: string | null): Promise<void> {
  if (!owner) return;
  await env.D1.prepare(
    `DELETE FROM ingestion_locks WHERE lock_key = ? AND owner = ?`
  ).bind(lockKey, owner).run();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function refreshOutlookToken(
  userId: string,
  orgId: string,
  env: Env
): Promise<{
  success: boolean;
  consecutiveFailures?: number;
  reason?: OutlookRefreshFailureReason;
  errorCode?: string | null;
  status?: number;
  refreshed?: boolean;
}> {
  if (env.OUTLOOK_AUTH_MODE !== 'delegated_fallback' || env.OUTLOOK_DELEGATED_FALLBACK_ENABLED !== 'true') {
    return { success: false, reason: 'config_error', errorCode: 'delegated_fallback_disabled' };
  }
  const user = await env.D1.prepare(
    'SELECT outlook_token FROM users WHERE id = ?'
  ).bind(userId).first<{ outlook_token: string | null }>();

  if (!user?.outlook_token) return { success: false, reason: 'missing_token' };
  const originalEncryptedToken = user.outlook_token;
  const lockKey = `outlook_refresh:${userId}`;
  let lockOwner: string | null = null;

  try {
    const decrypted = await decryptToken(originalEncryptedToken, env);
    if (accessTokenStillFresh(decrypted)) {
      await env.KV.delete(`token_failed:${userId}:outlook`);
      return { success: true, refreshed: false };
    }

    lockOwner = await acquireIngestionLock(env, lockKey);
    if (!lockOwner) {
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        if (await storedTokenChangedAndFresh(userId, originalEncryptedToken, env)) {
          await env.KV.delete(`token_failed:${userId}:outlook`);
          return { success: true, refreshed: false };
        }
      }
      return { success: false, reason: 'transient', errorCode: 'refresh_lock_busy' };
    }

    const tenantId = env.AZURE_TENANT_ID || 'common';
    const refreshed = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.AZURE_CLIENT_ID,
          client_secret: env.AZURE_CLIENT_SECRET || '',
          refresh_token: decrypted.refresh_token,
          grant_type: 'refresh_token',
          scope: OUTLOOK_REFRESH_SCOPES,
        }),
      }
    );

    if (!refreshed.ok) {
      const err = parseTokenEndpointError(refreshed.status, await refreshed.text().catch(() => ''));
      throw Object.assign(new Error(`Token refresh failed: ${err.status} ${err.errorCode || ''}`.trim()), {
        tokenEndpointError: err,
      });
    }

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

    const updateResult = await env.D1.prepare(
      `UPDATE users
          SET outlook_token = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
          AND outlook_token = ?`
    ).bind(encrypted, userId, originalEncryptedToken).run();
    if (!updateResult.meta?.changes && !(await storedTokenChangedAndFresh(userId, originalEncryptedToken, env))) {
      await env.D1.prepare(
        `UPDATE users
            SET outlook_token = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(encrypted, userId).run();
    }

    await releaseIngestionLock(env, lockKey, lockOwner);
    lockOwner = null;
    await env.KV.delete(`token_failed:${userId}:outlook`);
    return { success: true, refreshed: true };
  } catch (e) {
    await releaseIngestionLock(env, lockKey, lockOwner).catch(() => {});
    lockOwner = null;
    if (await storedTokenChangedAndFresh(userId, originalEncryptedToken, env)) {
      await env.KV.delete(`token_failed:${userId}:outlook`);
      return { success: true, refreshed: false };
    }

    const tokenEndpointError = (e as any)?.tokenEndpointError as TokenEndpointError | undefined;
    const reason = tokenEndpointError
      ? classifyTokenEndpointError(tokenEndpointError)
      : 'transient';

    if (reason !== 'reauth_required') {
      console.warn('[outlook-oauth] token refresh did not require user reconnect', {
        userId,
        reason,
        status: tokenEndpointError?.status || null,
        errorCode: tokenEndpointError?.errorCode || null,
        message: tokenEndpointError?.message || (e instanceof Error ? e.message : String(e)),
      });
      return {
        success: false,
        reason,
        status: tokenEndpointError?.status,
        errorCode: tokenEndpointError?.errorCode,
      };
    }

    const failKey = `token_failed:${userId}:outlook`;
    const state = await env.KV.get<{ count: number }>(failKey, 'json');
    const count = (state?.count || 0) + 1;

    await env.KV.put(
      failKey,
      JSON.stringify({
        count,
        last_failed: new Date().toISOString(),
        reason,
        status: tokenEndpointError?.status || null,
        error_code: tokenEndpointError?.errorCode || null,
        message: tokenEndpointError?.message || (e instanceof Error ? e.message : String(e)).slice(0, 800),
      }),
      { expirationTtl: 604800 }
    );

    await emitAudit(env, {
      org_id: orgId,
      user_id: userId,
      action: 'token_refresh_failed',
      entity_type: 'user',
      entity_id: userId,
      metadata: {
        provider: 'outlook',
        consecutive_failures: count,
        reason,
        status: tokenEndpointError?.status || null,
        error_code: tokenEndpointError?.errorCode || null,
      },
      created_at: new Date().toISOString(),
    });

    return {
      success: false,
      consecutiveFailures: count,
      reason,
      status: tokenEndpointError?.status,
      errorCode: tokenEndpointError?.errorCode,
    };
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

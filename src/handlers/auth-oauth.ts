// TRD §5.3 — Microsoft/Outlook OAuth flow (single-tenant)
//
// Flow:
//   1. Frontend Settings "Connect" button opens:
//        GET  {API}/auth/outlook?token=<JWT>
//      The JWT identifies which firm user is connecting their Outlook mailbox.
//   2. This handler verifies the JWT, persists the user_id + a CSRF state in KV,
//      and 302 redirects the browser to Microsoft's login page.
//   3. Microsoft redirects back to:
//        GET  {API}/auth/outlook/callback?code=...&state=...
//   4. The callback handler exchanges the code for tokens, encrypts them with
//      AES-256-GCM via TOKEN_ENCRYPTION_KEY, stores them on users.outlook_token
//      for the user_id captured in step 2, and 302 redirects back to:
//        {FRONTEND_URL}/settings?connected=outlook
//
// Neither route requires JWT auth at the routing layer — the start route
// validates its own token query param, and the callback trusts the CSRF state
// record in KV to identify the user.

import type { Env } from '../types/env';
import { errorResponse } from './utils';
import { encryptToken } from '../lib/encryption';
import { verifyJwt } from './auth';
import { emitAudit } from '../lib/audit';
import { ensureSubscriptionsForUser } from '../lib/graph-subscriptions';

interface OAuthStateRecord {
  user_id: string;
  org_id: string;
  nonce: string;
  created_at: string;
}

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/Contacts.Read',
  'offline_access',
].join(' ');

function frontendUrl(env: Env): string {
  return env.FRONTEND_URL || 'http://localhost:3000';
}

// Azure AD tenant IDs are GUIDs, or one of the well-known aliases that
// Microsoft accepts at the /{tenant}/ position of the OAuth 2.0 endpoints.
const TENANT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TENANT_ALIASES = new Set(['common', 'organizations', 'consumers']);
const GUID_PATTERN = TENANT_ID_PATTERN;

function isValidTenantId(v: string | undefined | null): boolean {
  if (!v) return false;
  return TENANT_ALIASES.has(v) || TENANT_ID_PATTERN.test(v);
}

function isValidGuid(v: string | undefined | null): boolean {
  if (!v) return false;
  return GUID_PATTERN.test(v);
}

function isValidHttpUrl(v: string | undefined | null): boolean {
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function describeSwap(env: Env): string | null {
  // Common failure mode: secrets are set but swapped between each other.
  // Detect the most likely swaps and point the user at a clear fix.
  const tenant = env.AZURE_TENANT_ID || '';
  const redirect = env.AZURE_REDIRECT_URI || '';
  const clientId = env.AZURE_CLIENT_ID || '';
  const clientSecret = env.AZURE_CLIENT_SECRET || '';

  const issues: string[] = [];

  // AZURE_TENANT_ID should be a tenant GUID or alias, never a URL.
  if (isValidHttpUrl(tenant)) {
    issues.push(
      'AZURE_TENANT_ID holds a URL — it must be the tenant GUID (e.g. 58771eb1-9e15-4da7-b7f6-b0db47350d9b). Re-run `wrangler secret put AZURE_TENANT_ID`.'
    );
  }

  // AZURE_CLIENT_ID should be a GUID, never a URL.
  if (isValidHttpUrl(clientId)) {
    issues.push(
      'AZURE_CLIENT_ID holds a URL — it must be the Azure app registration GUID. Re-run `wrangler secret put AZURE_CLIENT_ID`.'
    );
  }

  // AZURE_REDIRECT_URI should be an http(s) URL, never a GUID.
  if (redirect && isValidGuid(redirect)) {
    issues.push(
      'AZURE_REDIRECT_URI holds a GUID — it must be an https:// callback URL. Re-run `wrangler secret put AZURE_REDIRECT_URI`.'
    );
  }

  // Specific CLIENT_ID ↔ CLIENT_SECRET swap pattern:
  // CLIENT_ID looks like a secret (non-GUID, no URL, odd length) AND CLIENT_SECRET is a GUID.
  if (clientId && !isValidGuid(clientId) && !isValidHttpUrl(clientId) && isValidGuid(clientSecret)) {
    issues.push(
      'AZURE_CLIENT_ID and AZURE_CLIENT_SECRET appear to be swapped (AZURE_CLIENT_SECRET is a GUID, AZURE_CLIENT_ID is not). Re-run both `wrangler secret put` commands with the correct values.'
    );
  }

  return issues.length > 0 ? issues.join(' | ') : null;
}

function requireAzureConfig(env: Env): string | null {
  if (!env.AZURE_CLIENT_ID) return 'AZURE_CLIENT_ID is not set';
  if (!env.AZURE_CLIENT_SECRET) return 'AZURE_CLIENT_SECRET is not set';
  if (!env.AZURE_TENANT_ID) return 'AZURE_TENANT_ID is not set';
  if (!env.AZURE_REDIRECT_URI) return 'AZURE_REDIRECT_URI is not set';

  // Detect the most likely misconfiguration first so the error points at the fix.
  const swap = describeSwap(env);
  if (swap) return swap;

  if (!isValidGuid(env.AZURE_CLIENT_ID)) {
    return `AZURE_CLIENT_ID "${env.AZURE_CLIENT_ID.slice(0, 40)}" is not a valid GUID. Expected 8-4-4-4-12 hex format.`;
  }
  if (!isValidTenantId(env.AZURE_TENANT_ID)) {
    return `AZURE_TENANT_ID "${env.AZURE_TENANT_ID.slice(0, 40)}" is not a valid tenant GUID or alias (common/organizations/consumers). It looks like the wrong value is in this secret.`;
  }
  if (!isValidHttpUrl(env.AZURE_REDIRECT_URI)) {
    return `AZURE_REDIRECT_URI "${env.AZURE_REDIRECT_URI.slice(0, 80)}" is not a valid http(s) URL. Expected e.g. https://medina-ventures-api.intel-ad5.workers.dev/auth/outlook/callback.`;
  }
  return null;
}

function tenantAuthorizeUrl(env: Env): string {
  const tenant = encodeURIComponent(env.AZURE_TENANT_ID);
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

function tenantTokenUrl(env: Env): string {
  const tenant = encodeURIComponent(env.AZURE_TENANT_ID);
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

/**
 * GET /auth/outlook/debug
 *
 * Sanitized snapshot of the Azure env var state for the deployed Worker.
 * Returns format-only diagnostics — NEVER raw secret values.
 */
export async function outlookOAuthDebug(
  _request: Request,
  env: Env
): Promise<Response> {
  const tenantValid = isValidTenantId(env.AZURE_TENANT_ID);
  const clientIdValid = isValidGuid(env.AZURE_CLIENT_ID);
  const redirectValid = isValidHttpUrl(env.AZURE_REDIRECT_URI);
  const clientSecretPresent = Boolean(env.AZURE_CLIENT_SECRET && env.AZURE_CLIENT_SECRET.length > 0);

  const diag = {
    AZURE_CLIENT_ID: {
      present: Boolean(env.AZURE_CLIENT_ID),
      length: (env.AZURE_CLIENT_ID || '').length,
      format_valid_guid: clientIdValid,
      looks_like_url: isValidHttpUrl(env.AZURE_CLIENT_ID),
    },
    AZURE_CLIENT_SECRET: {
      present: clientSecretPresent,
      length: (env.AZURE_CLIENT_SECRET || '').length,
    },
    AZURE_TENANT_ID: {
      present: Boolean(env.AZURE_TENANT_ID),
      length: (env.AZURE_TENANT_ID || '').length,
      format_valid: tenantValid,
      looks_like_url: isValidHttpUrl(env.AZURE_TENANT_ID),
      looks_like_guid: isValidGuid(env.AZURE_TENANT_ID),
    },
    AZURE_REDIRECT_URI: {
      present: Boolean(env.AZURE_REDIRECT_URI),
      length: (env.AZURE_REDIRECT_URI || '').length,
      format_valid_http: redirectValid,
      looks_like_guid: isValidGuid(env.AZURE_REDIRECT_URI),
    },
    FRONTEND_URL: {
      present: Boolean(env.FRONTEND_URL),
      value: env.FRONTEND_URL || '(falling back to http://localhost:3000)',
    },
    detected_swap: describeSwap(env),
    would_build_authorize_url: tenantValid ? tenantAuthorizeUrl(env) : '(not built — tenant invalid)',
  };

  return new Response(JSON.stringify(diag, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settingsRedirect(env: Env, params: Record<string, string>): Response {
  const url = new URL('/settings', frontendUrl(env));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

/**
 * GET /auth/outlook?token=<JWT>
 *
 * Verifies the JWT, records a CSRF state that binds state → user_id, and
 * 302 redirects to the Microsoft Azure AD authorize URL for the configured
 * single tenant.
 */
export async function outlookOAuthStart(
  request: Request,
  env: Env
): Promise<Response> {
  const cfgError = requireAzureConfig(env);
  if (cfgError) {
    console.error('[auth-oauth] AZURE_CONFIG_ERROR:', cfgError);
    return settingsRedirect(env, {
      error: 'azure_config',
      message: cfgError,
    });
  }

  const url = new URL(request.url);
  const jwt = url.searchParams.get('token');
  if (!jwt) {
    return settingsRedirect(env, {
      error: 'missing_token',
      message: 'Not signed in. Log in before connecting Outlook.',
    });
  }

  const ctx = await verifyJwt(jwt, env);
  if (!ctx) {
    return settingsRedirect(env, {
      error: 'invalid_token',
      message: 'Your session expired. Reload and try again.',
    });
  }

  const state = crypto.randomUUID();
  const record: OAuthStateRecord = {
    user_id: ctx.userId,
    org_id: ctx.orgId,
    nonce: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
  await env.KV.put(`oauth_state:${state}`, JSON.stringify(record), {
    expirationTtl: 600,
  });

  const authorize = new URL(tenantAuthorizeUrl(env));
  authorize.searchParams.set('client_id', env.AZURE_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', env.AZURE_REDIRECT_URI);
  authorize.searchParams.set('response_mode', 'query');
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('prompt', 'select_account');

  return Response.redirect(authorize.toString(), 302);
}

/**
 * GET /auth/outlook/callback?code=...&state=...
 *
 * Exchanges the authorization code for access + refresh tokens, encrypts them,
 * persists to users.outlook_token for the user_id tracked in the KV state,
 * then 302 redirects back to {FRONTEND_URL}/settings.
 */
export async function outlookOAuthCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const cfgError = requireAzureConfig(env);
  if (cfgError) {
    console.error('[auth-oauth] AZURE_CONFIG_ERROR:', cfgError);
    return settingsRedirect(env, {
      error: 'azure_config',
      message: cfgError,
    });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const oauthErrorDesc = url.searchParams.get('error_description');

  if (oauthError) {
    return settingsRedirect(env, {
      error: oauthError,
      message: oauthErrorDesc || 'Microsoft denied the authorization request.',
    });
  }

  if (!code || !state) {
    return settingsRedirect(env, {
      error: 'missing_code_or_state',
      message: 'Callback from Microsoft was missing required parameters.',
    });
  }

  // Consume the state record (single-use).
  const stateJson = await env.KV.get(`oauth_state:${state}`);
  if (!stateJson) {
    return settingsRedirect(env, {
      error: 'invalid_state',
      message: 'OAuth state expired or did not match. Please try again.',
    });
  }
  await env.KV.delete(`oauth_state:${state}`);

  let record: OAuthStateRecord;
  try {
    record = JSON.parse(stateJson);
  } catch {
    return settingsRedirect(env, {
      error: 'invalid_state',
      message: 'Corrupt OAuth state record.',
    });
  }

  // Exchange code for tokens on the single-tenant token endpoint.
  const tokenResp = await fetch(tenantTokenUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.AZURE_CLIENT_ID,
      client_secret: env.AZURE_CLIENT_SECRET,
      code,
      redirect_uri: env.AZURE_REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: SCOPES,
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error('OAuth token exchange failed:', err);
    return settingsRedirect(env, {
      error: 'token_exchange_failed',
      message: `Microsoft rejected the code exchange (${tokenResp.status}).`,
    });
  }

  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  if (!tokens.access_token || !tokens.refresh_token) {
    return settingsRedirect(env, {
      error: 'missing_tokens',
      message: 'Microsoft did not return access + refresh tokens.',
    });
  }

  // Verify the authenticated Microsoft account matches the firm user's expectations
  // (informational only — we still attach to the JWT-identified user either way).
  let connectedEmail: string | null = null;
  try {
    const meResp = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (meResp.ok) {
      const me = (await meResp.json()) as {
        mail?: string;
        userPrincipalName?: string;
      };
      connectedEmail = (me.mail || me.userPrincipalName || '').toLowerCase() || null;
    }
  } catch {
    // non-fatal
  }

  // Make sure the firm user still exists.
  const user = await env.D1.prepare(
    'SELECT id, org_id FROM users WHERE id = ? AND deleted_at IS NULL'
  ).bind(record.user_id).first<{ id: string; org_id: string }>();
  if (!user) {
    return settingsRedirect(env, {
      error: 'user_not_found',
      message: 'Your user record was not found. Please contact an admin.',
    });
  }

  const encrypted = await encryptToken(
    {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(
        Date.now() + (tokens.expires_in || 3600) * 1000
      ).toISOString(),
    },
    env
  );

  await env.D1.prepare(
    `UPDATE users
        SET outlook_token = ?,
            outlook_delta_token = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(encrypted, record.user_id).run();

  // Reset any prior token-refresh failure counter.
  await env.KV.delete(`token_failed:${record.user_id}:outlook`);

  // Read per-user sync window for first delta fetch logging
  const syncConfigRaw = await env.KV.get(`sync_config:${record.user_id}`, 'json') as { sync_history_days?: number } | null;
  const syncDays = syncConfigRaw?.sync_history_days ?? 30;
  console.log(`[outlook] First sync for user ${record.user_id}, fetching last ${syncDays} days`);

  // Create Graph push notification subscriptions for near-instant email/calendar ingestion
  try {
    await ensureSubscriptionsForUser(record.user_id, record.org_id, env);
  } catch (e) {
    console.error('[auth-oauth] Graph subscription creation failed (non-fatal):', e);
  }

  await emitAudit(env, {
    org_id: record.org_id,
    user_id: record.user_id,
    action: 'update',
    entity_type: 'integration',
    entity_id: record.user_id,
    metadata: {
      provider: 'outlook',
      connected_email: connectedEmail,
      scopes: tokens.scope || SCOPES,
    },
    created_at: new Date().toISOString(),
  });

  return settingsRedirect(env, { connected: 'outlook' });
}

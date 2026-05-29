import type { Env } from '../types/env';
import { decryptToken } from './encryption';
import { refreshOutlookToken } from '../integrations/oauth';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const APP_TOKEN_CACHE_SKEW_MS = 5 * 60 * 1000;

let cachedAppToken: { key: string; accessToken: string; expiresAt: number } | null = null;

export interface GraphMailboxAuth {
  token: string;
  mailbox: string;
  authMode: 'app_only' | 'delegated_fallback';
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlString(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!b64) throw new Error('AZURE_CLIENT_CERT_PRIVATE_KEY is empty or invalid PEM');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function normalizeCertificateThumbprintForX5t(raw: string): string {
  const trimmed = raw.trim();
  const hex = trimmed.replace(/[^a-fA-F0-9]/g, '');
  if (hex.length === 40 && /^[a-fA-F0-9]+$/.test(hex)) {
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return base64UrlBytes(bytes);
  }
  return trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function getOutlookAuthMode(env: Env): 'app_only' | 'delegated_fallback' {
  return env.OUTLOOK_AUTH_MODE === 'delegated_fallback' ? 'delegated_fallback' : 'app_only';
}

export function isDelegatedOutlookFallbackEnabled(env: Env): boolean {
  return getOutlookAuthMode(env) === 'delegated_fallback'
    && env.OUTLOOK_DELEGATED_FALLBACK_ENABLED === 'true';
}

export function requireDelegatedOutlookFallback(env: Env): Response | null {
  if (isDelegatedOutlookFallbackEnabled(env)) return null;
  return new Response('Delegated Outlook OAuth fallback is disabled', { status: 404 });
}

function requireAppOnlyConfig(env: Env): void {
  const missing = [
    ['AZURE_CLIENT_ID', env.AZURE_CLIENT_ID],
    ['AZURE_TENANT_ID', env.AZURE_TENANT_ID],
    ['AZURE_CLIENT_CERT_PRIVATE_KEY', env.AZURE_CLIENT_CERT_PRIVATE_KEY],
    ['AZURE_CLIENT_CERT_THUMBPRINT', env.AZURE_CLIENT_CERT_THUMBPRINT],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing app-only Graph config: ${missing.join(', ')}`);
  }
}

export async function buildClientAssertion(env: Env, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  requireAppOnlyConfig(env);
  const tokenEndpoint = `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    x5t: normalizeCertificateThumbprintForX5t(env.AZURE_CLIENT_CERT_THUMBPRINT!),
  };
  const payload = {
    aud: tokenEndpoint,
    iss: env.AZURE_CLIENT_ID,
    sub: env.AZURE_CLIENT_ID,
    jti: crypto.randomUUID(),
    nbf: nowSeconds - 60,
    exp: nowSeconds + 600,
  };
  const signingInput = `${base64UrlString(JSON.stringify(header))}.${base64UrlString(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.AZURE_CLIENT_CERT_PRIVATE_KEY!),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

export async function getAppOnlyGraphAccessToken(env: Env): Promise<string> {
  requireAppOnlyConfig(env);
  const cacheKey = `${env.AZURE_TENANT_ID}:${env.AZURE_CLIENT_ID}:${env.AZURE_CLIENT_CERT_THUMBPRINT}`;
  if (cachedAppToken?.key === cacheKey && cachedAppToken.expiresAt - Date.now() > APP_TOKEN_CACHE_SKEW_MS) {
    return cachedAppToken.accessToken;
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const assertion = await buildClientAssertion(env);
  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.AZURE_CLIENT_ID,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Graph app-only token request failed: ${resp.status} ${body.slice(0, 500)}`);
  }

  const json = await resp.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Graph app-only token response missing access_token');
  cachedAppToken = {
    key: cacheKey,
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return json.access_token;
}

export function graphMailboxUrl(mailbox: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}${cleanPath}`;
}

export async function getGraphMailboxAuthForUser(userId: string, orgId: string, env: Env): Promise<GraphMailboxAuth> {
  const row = await env.D1.prepare(
    `SELECT id, email, outlook_mailbox, outlook_token
       FROM users
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(userId, orgId).first<{
    id: string;
    email: string | null;
    outlook_mailbox: string | null;
    outlook_token: string | null;
  }>();
  if (!row) throw new Error(`No active user ${userId} in org ${orgId}`);

  const mailbox = (row.outlook_mailbox || row.email || '').trim().toLowerCase();
  if (!mailbox) throw new Error(`No Outlook mailbox configured for user ${userId}`);

  if (isDelegatedOutlookFallbackEnabled(env)) {
    const refresh = await refreshOutlookToken(userId, orgId, env);
    if (!refresh.success) {
      throw new Error(`Delegated Outlook token refresh failed: ${refresh.reason || refresh.errorCode || 'unknown'}`);
    }
    if (!row.outlook_token) throw new Error(`No delegated Outlook token for user ${userId}`);
    const updated = await env.D1.prepare(
      'SELECT outlook_token FROM users WHERE id = ? AND org_id = ?'
    ).bind(userId, orgId).first<{ outlook_token: string | null }>();
    if (!updated?.outlook_token) throw new Error(`No delegated Outlook token for user ${userId}`);
    const decrypted = await decryptToken(updated.outlook_token, env);
    return { token: decrypted.access_token, mailbox, authMode: 'delegated_fallback' };
  }

  return {
    token: await getAppOnlyGraphAccessToken(env),
    mailbox,
    authMode: 'app_only',
  };
}

export async function getSystemSenderMailboxAuth(orgId: string, env: Env): Promise<GraphMailboxAuth> {
  const configured = (env.OUTLOOK_SYSTEM_SENDER_EMAIL || '').trim().toLowerCase();
  if (!configured) throw new Error('OUTLOOK_SYSTEM_SENDER_EMAIL is not set');
  if (isDelegatedOutlookFallbackEnabled(env)) {
    const row = await env.D1.prepare(
      `SELECT id FROM users
        WHERE org_id = ? AND lower(COALESCE(outlook_mailbox, email)) = ?
          AND deleted_at IS NULL
        LIMIT 1`
    ).bind(orgId, configured).first<{ id: string }>();
    if (row?.id) return getGraphMailboxAuthForUser(row.id, orgId, env);
  }
  return {
    token: await getAppOnlyGraphAccessToken(env),
    mailbox: configured,
    authMode: 'app_only',
  };
}

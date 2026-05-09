// TRD §14 — JWT middleware + tenant isolation
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';

/**
 * Verifies a JWT via HS256 and returns the AuthContext.
 * Returns null if invalid.
 */
export async function verifyJwt(
  token: string,
  env: Env
): Promise<AuthContext | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const sigBytes = base64UrlDecode(sigB64);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(data)
  );
  if (!valid) return null;

  let payload: any;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64))
    );
  } catch {
    return null;
  }

  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (!payload.sub || !payload.org_id) return null;
  // Reject purpose-scoped tokens (e.g. mfa_challenge) — only session tokens
  // (no purpose claim, or purpose === 'session') unlock authenticated routes.
  if (payload.purpose && payload.purpose !== 'session') return null;

  return {
    userId: payload.sub,
    orgId: payload.org_id,
    userRole: payload.role || 'member',
    email: payload.email || '',
  };
}

/**
 * Verify a JWT minted for a specific non-session purpose (e.g. 'mfa_challenge').
 * Returns the raw payload on success, null on failure.
 */
export async function verifyPurposeJwt(
  token: string,
  env: Env,
  purpose: string
): Promise<{ sub: string; org_id: string; email: string; purpose: string; exp: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBytes = base64UrlDecode(sigB64);
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (payload.purpose !== purpose) return null;
  if (!payload.sub || !payload.org_id) return null;
  return payload;
}

export async function signJwt(
  claims: {
    sub: string;
    org_id: string;
    role: string;
    email: string;
    exp?: number;
    purpose?: string;
  },
  env: Env
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    ...claims,
    iat: Math.floor(Date.now() / 1000),
    exp: claims.exp || Math.floor(Date.now() / 1000) + 86400 * 7,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = base64UrlEncodeBytes(new Uint8Array(sig));

  return `${data}.${sigB64}`;
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function base64UrlDecode(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

/**
 * Middleware helper — extracts and verifies the Authorization header.
 * Returns a Response (401) on failure or the AuthContext on success.
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<AuthContext | Response> {
  const authHeader = request.headers.get('Authorization') || '';
  let token = authHeader.replace(/^Bearer\s+/i, '');
  // Fallback for browser-initiated GETs that can't set Authorization headers
  // (e.g. <img src> for avatars). Header is preferred when present.
  if (!token) {
    try {
      const url = new URL(request.url);
      token = url.searchParams.get('token') || '';
    } catch { /* ignore */ }
  }
  if (!token) {
    return new Response(
      JSON.stringify({ error: 'AUTH_TOKEN_INVALID' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const ctx = await verifyJwt(token, env);
  if (!ctx) {
    return new Response(
      JSON.stringify({ error: 'AUTH_TOKEN_INVALID' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const userRow = await env.D1.prepare(
    'SELECT email_verified FROM users WHERE id = ? AND deleted_at IS NULL'
  ).bind(ctx.userId).first<{ email_verified: number | null }>();
  if (userRow && !userRow.email_verified) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/auth/me') {
      return new Response(
        JSON.stringify({ error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email address.' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return ctx;
}

export function requireRole(
  ctx: AuthContext,
  roles: Array<'owner' | 'admin' | 'member' | 'super_admin'>
): Response | null {
  const effectiveRoles = ctx.userRole === 'super_admin'
    ? [...roles, 'super_admin', 'owner']
    : roles;
  if (!effectiveRoles.includes(ctx.userRole)) {
    return new Response(
      JSON.stringify({ error: 'AUTH_FORBIDDEN' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return null;
}

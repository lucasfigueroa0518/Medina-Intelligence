import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { signJwt, verifyJwt } from './auth';
import { jsonResponse, errorResponse } from './utils';
import { emitAudit } from '../lib/audit';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 32;
const HASH_BYTES = 32;

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    HASH_BYTES * 8
  );
  const saltHex = toHex(salt);
  const hashHex = toHex(new Uint8Array(derived));
  return `pbkdf2:sha256:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts[0] !== 'pbkdf2' || parts.length !== 5) return false;
  const iterations = parseInt(parts[2], 10);
  const salt = fromHex(parts[3]);
  const expectedHash = parts[4];
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    HASH_BYTES * 8
  );
  return toHex(new Uint8Array(derived)) === expectedHash;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

async function hashTokenForStorage(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

async function recordToken(userId: string, token: string, expiresAt: string, env: Env): Promise<void> {
  const tokenHash = await hashTokenForStorage(token);
  await env.D1.prepare(
    `INSERT INTO auth_tokens (user_id, token_hash, expires_at)
     VALUES (?, ?, ?)`
  ).bind(userId, tokenHash, expiresAt).run();
}

export async function isTokenRevoked(token: string, env: Env): Promise<boolean> {
  const tokenHash = await hashTokenForStorage(token);
  const row = await env.D1.prepare(
    `SELECT revoked_at FROM auth_tokens WHERE token_hash = ?`
  ).bind(tokenHash).first<{ revoked_at: string | null }>();
  if (!row) return false;
  return row.revoked_at !== null;
}

/**
 * POST /api/auth/register
 */
export async function register(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string; full_name?: string; org_id?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 400);
  }

  const { email, password, full_name, org_id } = body;
  if (!email || !password || !full_name || !org_id) {
    return errorResponse('MISSING_FIELDS', 400, 'email, password, full_name, and org_id are required');
  }

  if (password.length < 8) {
    return errorResponse('WEAK_PASSWORD', 400, 'Password must be at least 8 characters');
  }

  const org = await env.D1.prepare(
    'SELECT id FROM organizations WHERE id = ? AND deleted_at IS NULL'
  ).bind(org_id).first();
  if (!org) {
    return errorResponse('ORG_NOT_FOUND', 404, 'Organization not found');
  }

  const existing = await env.D1.prepare(
    'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL'
  ).bind(email.toLowerCase()).first();
  if (existing) {
    return errorResponse('EMAIL_EXISTS', 409, 'A user with this email already exists');
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await env.D1.prepare(
    `INSERT INTO users (id, org_id, email, full_name, role, password_hash, is_active)
     VALUES (?, ?, ?, ?, 'member', ?, 1)`
  ).bind(userId, org_id, email.toLowerCase(), full_name, passwordHash).run();

  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const token = await signJwt(
    { sub: userId, org_id, role: 'member', email: email.toLowerCase() },
    env
  );
  await recordToken(userId, token, expiresAt, env);

  await emitAudit(env, {
    org_id,
    user_id: userId,
    action: 'create',
    entity_type: 'user',
    entity_id: userId,
    metadata: { method: 'register' },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    token,
    user: { id: userId, email: email.toLowerCase(), full_name, role: 'member' },
  }, 201);
}

/**
 * POST /api/auth/login
 */
export async function login(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 400);
  }

  const { email, password } = body;
  if (!email || !password) {
    return errorResponse('MISSING_FIELDS', 400, 'email and password are required');
  }

  const user = await env.D1.prepare(
    `SELECT id, org_id, email, full_name, role, password_hash, is_active
     FROM users WHERE email = ? AND deleted_at IS NULL`
  ).bind(email.toLowerCase()).first<{
    id: string; org_id: string; email: string; full_name: string;
    role: string; password_hash: string | null; is_active: number;
  }>();

  if (!user || !user.password_hash) {
    return errorResponse('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }

  if (!user.is_active) {
    return errorResponse('ACCOUNT_DISABLED', 403, 'Account is disabled');
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return errorResponse('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }

  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const token = await signJwt(
    { sub: user.id, org_id: user.org_id, role: user.role, email: user.email },
    env
  );
  await recordToken(user.id, token, expiresAt, env);

  await env.D1.prepare(
    `UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(user.id).run();

  await emitAudit(env, {
    org_id: user.org_id,
    user_id: user.id,
    action: 'login',
    entity_type: 'user',
    entity_id: user.id,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    token,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, org_id: user.org_id },
  });
}

/**
 * POST /api/auth/logout
 */
export async function logout(request: Request, ctx: AuthContext, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token) {
    const tokenHash = await hashTokenForStorage(token);
    await env.D1.prepare(
      `UPDATE auth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?`
    ).bind(tokenHash).run();
  }
  return jsonResponse({ success: true });
}

/**
 * GET /api/auth/me
 */
export async function me(ctx: AuthContext, env: Env): Promise<Response> {
  const user = await env.D1.prepare(
    `SELECT id, email, full_name, role, org_id, avatar_url, phone, job_title, linkedin_url, bio, last_login_at
     FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId).first();

  if (!user) {
    return errorResponse('USER_NOT_FOUND', 404);
  }

  return jsonResponse({ user });
}

/**
 * POST /api/users/me/change-password
 */
export async function changePassword(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  let body: { current_password?: string; new_password?: string };
  try { body = await request.json(); } catch { return errorResponse('INVALID_BODY', 400); }

  const { current_password, new_password } = body;
  if (!current_password || !new_password) {
    return errorResponse('MISSING_FIELDS', 400, 'current_password and new_password are required');
  }
  if (new_password.length < 8) {
    return errorResponse('WEAK_PASSWORD', 400, 'New password must be at least 8 characters');
  }

  const user = await env.D1.prepare(
    `SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId).first<{ password_hash: string | null }>();

  if (!user || !user.password_hash) {
    return errorResponse('NO_PASSWORD_SET', 400, 'No password is set for this account');
  }

  const valid = await verifyPassword(current_password, user.password_hash);
  if (!valid) {
    return errorResponse('INVALID_CREDENTIALS', 401, 'Current password is incorrect');
  }

  const newHash = await hashPassword(new_password);
  await env.D1.prepare(
    `UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(newHash, ctx.userId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'user',
    entity_id: ctx.userId,
    metadata: { fields: ['password_hash'] },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

/**
 * GET /api/users/me/sessions
 * Returns active (non-revoked, non-expired) sessions for the current user.
 * Marks the session belonging to the current request as `current: true`.
 */
export async function listMySessions(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const currentToken = authHeader.replace(/^Bearer\s+/i, '');
  const currentTokenHash = currentToken ? await hashTokenForStorage(currentToken) : '';

  const rows = await env.D1.prepare(
    `SELECT id, token_hash, expires_at, created_at, revoked_at
     FROM auth_tokens
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     ORDER BY created_at DESC`
  ).bind(ctx.userId).all<{ id: string; token_hash: string; expires_at: string; created_at: string; revoked_at: string | null }>();

  const sessions = rows.results.map(r => ({
    id: r.id,
    created_at: r.created_at,
    expires_at: r.expires_at,
    current: r.token_hash === currentTokenHash,
  }));

  return jsonResponse({ sessions });
}

/**
 * DELETE /api/users/me/sessions/:id
 * Revokes a specific session. A user can only revoke their own.
 */
export async function revokeMySession(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `UPDATE auth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
  ).bind(id, ctx.userId).run();

  if ((result.meta?.changes ?? 0) === 0) {
    return errorResponse('SESSION_NOT_FOUND', 404);
  }
  return jsonResponse({ ok: true });
}

/**
 * POST /api/users/me/sessions/logout-all
 * Revokes every active session for this user EXCEPT the one making the request.
 */
export async function revokeAllOtherSessions(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const currentToken = authHeader.replace(/^Bearer\s+/i, '');
  const currentTokenHash = currentToken ? await hashTokenForStorage(currentToken) : '';

  const result = await env.D1.prepare(
    `UPDATE auth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?`
  ).bind(ctx.userId, currentTokenHash).run();

  return jsonResponse({ ok: true, revoked: result.meta?.changes ?? 0 });
}

/**
 * POST /api/auth/set-initial-password
 * Temporary bootstrap endpoint — set password for existing users without one.
 */
export async function setInitialPassword(request: Request, env: Env): Promise<Response> {
  let body: { user_id?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 400);
  }

  const { user_id, password } = body;
  if (!user_id || !password) {
    return errorResponse('MISSING_FIELDS', 400, 'user_id and password are required');
  }

  if (password.length < 8) {
    return errorResponse('WEAK_PASSWORD', 400, 'Password must be at least 8 characters');
  }

  const user = await env.D1.prepare(
    'SELECT id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL'
  ).bind(user_id).first<{ id: string; password_hash: string | null }>();

  if (!user) {
    return errorResponse('USER_NOT_FOUND', 404);
  }

  const passwordHash = await hashPassword(password);
  await env.D1.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ?'
  ).bind(passwordHash, user_id).run();

  return jsonResponse({ ok: true, user_id });
}

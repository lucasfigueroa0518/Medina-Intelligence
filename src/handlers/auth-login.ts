import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { signJwt, verifyJwt, verifyPurposeJwt } from './auth';
import { jsonResponse, errorResponse } from './utils';
import { emitAudit } from '../lib/audit';
import { generateSecret, otpauthUrl, verifyTotp, generateRecoveryCodes, hashRecoveryCode } from '../lib/totp';
import { sendVerificationEmail } from '../lib/verification-email';
import { sendResetEmail } from '../lib/reset-email';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 32;
const HASH_BYTES = 32;
const SEVERAL_MISSED_SYNC_DAYS = 3;

type UserWarning = {
  type: string;
  message: string;
  consecutive_failures?: number;
  last_successful_sync?: string | null;
  missed_days?: number;
  suggest_backfill_days?: 30;
  backfill_prompt?: string;
};

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

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

async function generateVerificationToken(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createVerificationToken(
  userId: string,
  email: string,
  env: Env
): Promise<string> {
  const token = await generateVerificationToken();
  const tokenHash = await hashTokenForStorage(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await env.D1.prepare(
    `INSERT INTO email_verification_tokens (user_id, token_hash, email, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(userId, tokenHash, email, expiresAt).run();

  return token;
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
  const lowerEmail = email.toLowerCase();

  await env.D1.prepare(
    `INSERT INTO users (id, org_id, email, full_name, role, password_hash, is_active, email_verified)
     VALUES (?, ?, ?, ?, 'member', ?, 1, 0)`
  ).bind(userId, org_id, lowerEmail, full_name, passwordHash).run();

  await emitAudit(env, {
    org_id,
    user_id: userId,
    action: 'create',
    entity_type: 'user',
    entity_id: userId,
    metadata: { method: 'register' },
    created_at: new Date().toISOString(),
  });

  const verificationToken = await createVerificationToken(userId, lowerEmail, env);
  const emailResult = await sendVerificationEmail(userId, lowerEmail, full_name, verificationToken, org_id, env);
  if (!emailResult.ok) {
    console.error(`[register] verification email failed for ${lowerEmail}: ${emailResult.error}`);
  }

  return jsonResponse({
    verification_pending: true,
    email_sent: emailResult.ok,
    email: lowerEmail,
    message: emailResult.ok
      ? 'Account created. Please check your email to verify your address.'
      : 'Account created. We could not send a verification email — please use "Resend" on the next page.',
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
    `SELECT id, org_id, email, full_name, role, password_hash, is_active,
            email_verified, mfa_enabled
     FROM users WHERE email = ? AND deleted_at IS NULL`
  ).bind(email.toLowerCase()).first<{
    id: string; org_id: string; email: string; full_name: string;
    role: string; password_hash: string | null; is_active: number;
    email_verified: number | null; mfa_enabled: number | null;
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

  if (!user.email_verified) {
    return jsonResponse(
      { error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email address before signing in.', email: user.email },
      403
    );
  }

  // If 2FA is enabled, return a short-lived purpose-scoped token instead of a session.
  if (user.mfa_enabled) {
    const challengeExp = Math.floor(Date.now() / 1000) + 5 * 60;
    const challengeToken = await signJwt(
      { sub: user.id, org_id: user.org_id, role: user.role, email: user.email,
        exp: challengeExp, purpose: 'mfa_challenge' },
      env
    );
    return jsonResponse({ mfa_required: 'verify', mfa_token: challengeToken });
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
    `SELECT id, email, full_name, role, org_id, avatar_url, phone, job_title, linkedin_url, bio, last_login_at, share_emails_org_wide, email_verified
     FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId).first();

  if (!user) {
    return errorResponse('USER_NOT_FOUND', 404);
  }

  const warnings: UserWarning[] = [];

  const tokenFailState = await env.KV.get<{ count: number; last_failed?: string }>(
    `token_failed:${ctx.userId}:outlook`,
    'json'
  );
  if (tokenFailState && tokenFailState.count >= 3) {
    const lastSync = await env.D1.prepare(
      `SELECT completed_at FROM sync_jobs
        WHERE org_id = ? AND workflow_type = 'ingestion' AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1`
    ).bind(ctx.orgId).first<{ completed_at: string | null }>();
    const missedDays = daysSince(lastSync?.completed_at);

    warnings.push({
      type: 'outlook_token_expired',
      message: 'Outlook needs a quick refresh to keep email and calendar updates flowing.',
      consecutive_failures: tokenFailState.count,
      last_successful_sync: lastSync?.completed_at || null,
      ...(missedDays !== null && missedDays >= SEVERAL_MISSED_SYNC_DAYS
        ? {
            missed_days: missedDays,
            suggest_backfill_days: 30 as const,
            backfill_prompt: `It looks like about ${missedDays} day${missedDays === 1 ? '' : 's'} may need a catch-up import. Refresh Outlook first, then start a 30-day backfill.`,
          }
        : {}),
    });
  }

  return jsonResponse({ user, warnings });
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
 * POST /api/admin/users/:id/reset-password
 * Owner/admin-only password reset for another user. Always emits an audit entry
 * (action='admin_reset_password') so password rewrites are observable.
 */
export async function adminResetPassword(
  targetUserId: string,
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  let body: { password?: string };
  try { body = await request.json(); } catch { return errorResponse('INVALID_BODY', 400); }
  const password = body.password;
  if (!password) return errorResponse('MISSING_FIELDS', 400, 'password is required');
  if (password.length < 8) return errorResponse('WEAK_PASSWORD', 400, 'Password must be at least 8 characters');

  const target = await env.D1.prepare(
    'SELECT id, org_id FROM users WHERE id = ? AND deleted_at IS NULL'
  ).bind(targetUserId).first<{ id: string; org_id: string }>();
  if (!target) return errorResponse('USER_NOT_FOUND', 404);
  if (target.org_id !== ctx.orgId) return errorResponse('FORBIDDEN', 403, 'Cannot reset users in other organizations');

  const passwordHash = await hashPassword(password);
  await env.D1.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, targetUserId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'admin_reset_password',
    entity_type: 'user',
    entity_id: targetUserId,
    metadata: { reset_by: ctx.userId },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, user_id: targetUserId });
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
 * Bootstrap endpoint — sets a password for a user that doesn't have one yet.
 * Refuses to overwrite an existing password (use /api/users/me/change-password
 * or the admin reset endpoint for that). Emits an audit event so silent
 * password rewrites can never happen unobserved again.
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
    'SELECT id, org_id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL'
  ).bind(user_id).first<{ id: string; org_id: string; password_hash: string | null }>();

  if (!user) {
    return errorResponse('USER_NOT_FOUND', 404);
  }

  if (user.password_hash) {
    return errorResponse(
      'PASSWORD_ALREADY_SET',
      409,
      'This user already has a password. Use change-password (with current password) or admin reset.'
    );
  }

  const passwordHash = await hashPassword(password);
  await env.D1.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ?'
  ).bind(passwordHash, user_id).run();

  await emitAudit(env, {
    org_id: user.org_id,
    user_id,
    action: 'set_initial_password',
    entity_type: 'user',
    entity_id: user_id,
    metadata: { method: 'set_initial_password' },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, user_id });
}

// =====================================================================
// Self-signup (domain-restricted, no email verification)
// =====================================================================

function isAllowedSignupDomain(email: string, env: Env): boolean {
  const domains = (env.ALLOWED_SIGNUP_DOMAINS || 'medinavc.com')
    .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at === -1) return false;
  const domain = lower.slice(at + 1);
  return domains.includes(domain);
}

/**
 * POST /api/auth/signup
 * Body: { email, password, full_name }. Creates an active user and returns a session token.
 */
export async function signup(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string; full_name?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 400);
  }

  const { email, password, full_name } = body;
  if (!email || !password || !full_name) {
    return errorResponse('MISSING_FIELDS', 400, 'email, password, and full_name are required');
  }
  if (password.length < 8) {
    return errorResponse('WEAK_PASSWORD', 400, 'Password must be at least 8 characters');
  }
  if (!isAllowedSignupDomain(email, env)) {
    return errorResponse('DOMAIN_NOT_ALLOWED', 400, 'Signup is restricted to approved email domains');
  }

  const orgId = env.DEFAULT_SIGNUP_ORG_ID;
  if (!orgId) {
    return errorResponse('SIGNUP_DISABLED', 500, 'Signup is not configured');
  }
  const org = await env.D1.prepare(
    'SELECT id FROM organizations WHERE id = ? AND deleted_at IS NULL'
  ).bind(orgId).first();
  if (!org) {
    return errorResponse('SIGNUP_DISABLED', 500, 'Default signup organization missing');
  }

  const lowerEmail = email.toLowerCase();
  const existing = await env.D1.prepare(
    'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL'
  ).bind(lowerEmail).first();
  if (existing) {
    return errorResponse('EMAIL_EXISTS', 409, 'An account with this email already exists');
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await env.D1.prepare(
    `INSERT INTO users (id, org_id, email, full_name, role, password_hash, is_active, email_verified)
     VALUES (?, ?, ?, ?, 'member', ?, 1, 0)`
  ).bind(userId, orgId, lowerEmail, full_name, passwordHash).run();

  await emitAudit(env, {
    org_id: orgId,
    user_id: userId,
    action: 'create',
    entity_type: 'user',
    entity_id: userId,
    metadata: { method: 'signup' },
    created_at: new Date().toISOString(),
  });

  const verificationToken = await createVerificationToken(userId, lowerEmail, env);
  const emailResult = await sendVerificationEmail(userId, lowerEmail, full_name, verificationToken, orgId, env);
  if (!emailResult.ok) {
    console.error(`[signup] verification email failed for ${lowerEmail}: ${emailResult.error}`);
  }

  return jsonResponse({
    verification_pending: true,
    email_sent: emailResult.ok,
    email: lowerEmail,
    message: emailResult.ok
      ? 'Account created. Please check your email to verify your address.'
      : 'Account created. We could not send a verification email — please use "Resend" on the next page.',
  }, 201);
}

// =====================================================================
// Email Verification
// =====================================================================

/**
 * GET /api/auth/verify?token=...
 * Public endpoint — verifies email and returns success/failure JSON.
 */
export async function verifyEmail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return jsonResponse({ error: 'MISSING_TOKEN', message: 'Verification token is required.' }, 400);
  }

  const tokenHash = await hashTokenForStorage(token);

  const row = await env.D1.prepare(
    `SELECT id, user_id, email, expires_at, used_at
     FROM email_verification_tokens WHERE token_hash = ?`
  ).bind(tokenHash).first<{
    id: string; user_id: string; email: string; expires_at: string; used_at: string | null;
  }>();

  if (!row) {
    return jsonResponse({ error: 'INVALID_TOKEN', message: 'This verification link is invalid.' }, 400);
  }

  if (row.used_at) {
    return jsonResponse({ error: 'ALREADY_VERIFIED', message: 'This email has already been verified.' }, 400);
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return jsonResponse({ error: 'TOKEN_EXPIRED', message: 'This verification link has expired. Please request a new one.' }, 400);
  }

  await env.D1.prepare(
    `UPDATE users SET email_verified = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND email = ?`
  ).bind(row.user_id, row.email).run();

  await env.D1.prepare(
    `UPDATE email_verification_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(row.id).run();

  const user = await env.D1.prepare(
    'SELECT org_id FROM users WHERE id = ?'
  ).bind(row.user_id).first<{ org_id: string }>();

  await emitAudit(env, {
    org_id: user?.org_id || '',
    user_id: row.user_id,
    action: 'email_verified',
    entity_type: 'user',
    entity_id: row.user_id,
    metadata: { email: row.email },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, message: 'Email verified successfully. You can now sign in.' });
}

const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * POST /api/auth/resend-verification
 * Body: { email }. Public endpoint — rate-limited to 1 per minute per email.
 */
export async function resendVerification(request: Request, env: Env): Promise<Response> {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 400);
  }

  const email = body.email?.toLowerCase();
  if (!email) {
    return errorResponse('MISSING_FIELDS', 400, 'email is required');
  }

  const rateLimitKey = `verify_resend:${email}`;
  const lastSent = await env.KV.get(rateLimitKey);
  if (lastSent) {
    return jsonResponse(
      { error: 'RATE_LIMITED', message: 'Please wait before requesting another verification email.' },
      429
    );
  }

  const user = await env.D1.prepare(
    `SELECT id, org_id, full_name, email_verified
     FROM users WHERE email = ? AND deleted_at IS NULL`
  ).bind(email).first<{ id: string; org_id: string; full_name: string; email_verified: number | null }>();

  await env.KV.put(rateLimitKey, '1', { expirationTtl: 60 });

  if (!user || user.email_verified) {
    return jsonResponse({ ok: true, message: 'If that email exists and is unverified, a verification link has been sent.' });
  }

  const verificationToken = await createVerificationToken(user.id, email, env);
  const emailResult = await sendVerificationEmail(user.id, email, user.full_name, verificationToken, user.org_id, env);
  if (!emailResult.ok) {
    console.error(`[resend-verification] email failed for ${email}: ${emailResult.error}`);
  }

  return jsonResponse({ ok: true, message: 'If that email exists and is unverified, a verification link has been sent.' });
}

// =====================================================================
// Password Reset
// =====================================================================

/**
 * POST /api/auth/forgot-password
 * Public endpoint — always returns the same response to prevent email enumeration.
 */
export async function forgotPassword(request: Request, env: Env): Promise<Response> {
  const successMsg = 'If an account exists with that email, a password reset link has been sent.';

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ message: successMsg });
  }

  const email = body.email?.toLowerCase().trim();
  if (!email) return jsonResponse({ message: successMsg });

  const rateLimitKey = `reset_rate:${email}`;
  const rateCount = parseInt(await env.KV.get(rateLimitKey) || '0');
  if (rateCount >= 3) {
    return jsonResponse({ message: successMsg });
  }
  await env.KV.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 3600 });

  const user = await env.D1.prepare(
    'SELECT id, org_id, email, full_name FROM users WHERE email = ? AND deleted_at IS NULL AND is_active = 1'
  ).bind(email).first<{ id: string; org_id: string; email: string; full_name: string }>();

  if (!user) return jsonResponse({ message: successMsg });

  await env.D1.prepare(
    `UPDATE password_reset_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ? AND used_at IS NULL`
  ).bind(user.id).run();

  const rawToken = crypto.randomUUID() + '-' + crypto.randomUUID();
  const tokenHash = await hashTokenForStorage(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  await env.D1.prepare(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address)
     VALUES (?, ?, ?, ?)`
  ).bind(user.id, tokenHash, expiresAt, ip).run();

  const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
  const resetUrl = `${frontendUrl}/auth/reset-password?token=${encodeURIComponent(rawToken)}`;

  const emailResult = await sendResetEmail(user.email, user.full_name, resetUrl, user.org_id, env);
  if (!emailResult.ok) {
    console.error(`[forgot-password] email send failed for ${email}: ${emailResult.error}`);
  }

  return jsonResponse({ message: successMsg });
}

/**
 * POST /api/auth/reset-password
 * Public endpoint — validates token and sets new password.
 */
export async function resetPassword(request: Request, env: Env): Promise<Response> {
  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_BODY', 400);
  }

  const { token, password } = body;
  if (!token) return errorResponse('MISSING_TOKEN', 400, 'Reset token is required.');
  if (!password || password.length < 8) {
    return errorResponse('WEAK_PASSWORD', 400, 'Password must be at least 8 characters.');
  }

  const tokenHash = await hashTokenForStorage(token);

  const resetRecord = await env.D1.prepare(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?'
  ).bind(tokenHash).first<{
    id: string; user_id: string; expires_at: string; used_at: string | null;
  }>();

  if (!resetRecord) {
    return jsonResponse(
      { error: 'INVALID_TOKEN', message: 'This reset link is invalid. Please request a new one.' },
      400
    );
  }
  if (resetRecord.used_at) {
    return jsonResponse(
      { error: 'TOKEN_USED', message: 'This reset link has already been used. Please request a new one.' },
      400
    );
  }
  if (new Date(resetRecord.expires_at).getTime() < Date.now()) {
    return jsonResponse(
      { error: 'TOKEN_EXPIRED', message: 'This reset link has expired. Please request a new one.' },
      400
    );
  }

  const newHash = await hashPassword(password);

  await env.D1.prepare(
    `UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(newHash, resetRecord.user_id).run();

  await env.D1.prepare(
    `UPDATE password_reset_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ? AND used_at IS NULL`
  ).bind(resetRecord.user_id).run();

  await env.D1.prepare(
    `UPDATE auth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ? AND revoked_at IS NULL`
  ).bind(resetRecord.user_id).run();

  const user = await env.D1.prepare(
    'SELECT org_id FROM users WHERE id = ?'
  ).bind(resetRecord.user_id).first<{ org_id: string }>();

  await emitAudit(env, {
    org_id: user?.org_id || '',
    user_id: resetRecord.user_id,
    action: 'password_reset',
    entity_type: 'user',
    entity_id: resetRecord.user_id,
    metadata: { ip: request.headers.get('cf-connecting-ip') || 'unknown' },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, message: 'Password has been reset. Please sign in with your new password.' });
}

// =====================================================================
// Optional TOTP 2FA
// =====================================================================

const MFA_PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * POST /api/auth/mfa/enroll/start
 * Auth: full session JWT. Generates pending secret + recovery codes.
 */
export async function mfaEnrollStart(ctx: AuthContext, env: Env): Promise<Response> {
  const user = await env.D1.prepare(
    `SELECT email, mfa_enabled FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId).first<{ email: string; mfa_enabled: number | null }>();
  if (!user) return errorResponse('USER_NOT_FOUND', 404);
  if (user.mfa_enabled) return errorResponse('MFA_ALREADY_ENABLED', 400);

  const secret = generateSecret();
  const { plain } = generateRecoveryCodes(10);
  const hashes = await Promise.all(plain.map(hashRecoveryCode));
  const expiresAt = new Date(Date.now() + MFA_PENDING_TTL_MS).toISOString();

  await env.D1.prepare(
    `INSERT INTO auth_mfa_pending (user_id, secret, recovery_hashes, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret,
       recovery_hashes = excluded.recovery_hashes, expires_at = excluded.expires_at,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(ctx.userId, secret, JSON.stringify(hashes), expiresAt).run();

  return jsonResponse({
    secret,
    otpauth_url: otpauthUrl(secret, user.email),
    recovery_codes: plain,
  });
}

/**
 * POST /api/auth/mfa/enroll/confirm
 * Auth: full session JWT. Body: { code }. Persists and enables 2FA.
 */
export async function mfaEnrollConfirm(request: Request, ctx: AuthContext, env: Env): Promise<Response> {
  let body: { code?: string };
  try { body = await request.json(); } catch { return errorResponse('INVALID_BODY', 400); }
  const code = (body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return errorResponse('INVALID_CODE', 400);

  const pending = await env.D1.prepare(
    `SELECT secret, recovery_hashes, expires_at FROM auth_mfa_pending WHERE user_id = ?`
  ).bind(ctx.userId).first<{ secret: string; recovery_hashes: string; expires_at: string }>();
  if (!pending) return errorResponse('NO_PENDING_ENROLLMENT', 400);
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await env.D1.prepare('DELETE FROM auth_mfa_pending WHERE user_id = ?').bind(ctx.userId).run();
    return errorResponse('ENROLLMENT_EXPIRED', 400);
  }

  const ok = await verifyTotp(pending.secret, code);
  if (!ok) return errorResponse('INVALID_CODE', 400);

  await env.D1.prepare(
    `UPDATE users SET mfa_secret = ?, mfa_enabled = 1, mfa_recovery_codes = ?,
       mfa_enrolled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       mfa_failed_attempts = 0, mfa_locked_until = NULL
     WHERE id = ?`
  ).bind(pending.secret, pending.recovery_hashes, ctx.userId).run();
  await env.D1.prepare('DELETE FROM auth_mfa_pending WHERE user_id = ?').bind(ctx.userId).run();

  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId,
    action: 'update', entity_type: 'user', entity_id: ctx.userId,
    metadata: { fields: ['mfa_enabled'], value: true },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

/**
 * POST /api/auth/mfa/disable
 * Auth: full session JWT. Body: { code } — current TOTP code required.
 */
export async function mfaDisable(request: Request, ctx: AuthContext, env: Env): Promise<Response> {
  let body: { code?: string };
  try { body = await request.json(); } catch { return errorResponse('INVALID_BODY', 400); }
  const code = (body.code || '').trim();

  const user = await env.D1.prepare(
    `SELECT mfa_secret, mfa_enabled FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId).first<{ mfa_secret: string | null; mfa_enabled: number | null }>();
  if (!user || !user.mfa_enabled || !user.mfa_secret) {
    return errorResponse('MFA_NOT_ENABLED', 400);
  }
  const ok = await verifyTotp(user.mfa_secret, code);
  if (!ok) return errorResponse('INVALID_CODE', 400);

  await env.D1.prepare(
    `UPDATE users SET mfa_secret = NULL, mfa_enabled = 0,
       mfa_recovery_codes = NULL, mfa_enrolled_at = NULL,
       mfa_failed_attempts = 0, mfa_locked_until = NULL
     WHERE id = ?`
  ).bind(ctx.userId).run();

  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId,
    action: 'update', entity_type: 'user', entity_id: ctx.userId,
    metadata: { fields: ['mfa_enabled'], value: false },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

/**
 * POST /api/auth/mfa/verify
 * Auth: short-lived purpose='mfa_challenge' JWT in Authorization header.
 * Body: { code } OR { recovery_code }.
 * Issues real session JWT on success.
 */
export async function mfaVerify(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const challengeToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!challengeToken) return errorResponse('MFA_TOKEN_INVALID', 401);

  const payload = await verifyPurposeJwt(challengeToken, env, 'mfa_challenge');
  if (!payload) return errorResponse('MFA_TOKEN_INVALID', 401);

  let body: { code?: string; recovery_code?: string };
  try { body = await request.json(); } catch { return errorResponse('INVALID_BODY', 400); }

  const user = await env.D1.prepare(
    `SELECT id, org_id, email, full_name, role, mfa_secret, mfa_enabled,
            mfa_recovery_codes, mfa_failed_attempts, mfa_locked_until
     FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(payload.sub).first<{
    id: string; org_id: string; email: string; full_name: string; role: string;
    mfa_secret: string | null; mfa_enabled: number | null;
    mfa_recovery_codes: string | null; mfa_failed_attempts: number | null;
    mfa_locked_until: string | null;
  }>();
  if (!user || !user.mfa_enabled || !user.mfa_secret) {
    return errorResponse('MFA_NOT_ENABLED', 400);
  }

  if (user.mfa_locked_until && new Date(user.mfa_locked_until).getTime() > Date.now()) {
    return errorResponse('MFA_LOCKED', 423, 'Too many failed attempts. Try again later.');
  }

  let success = false;
  let updatedRecovery: string | null = null;

  if (body.code) {
    success = await verifyTotp(user.mfa_secret, body.code.trim());
  } else if (body.recovery_code) {
    const incomingHash = await hashRecoveryCode(body.recovery_code);
    const stored: string[] = user.mfa_recovery_codes ? JSON.parse(user.mfa_recovery_codes) : [];
    const idx = stored.indexOf(incomingHash);
    if (idx >= 0) {
      stored.splice(idx, 1);
      updatedRecovery = JSON.stringify(stored);
      success = true;
    }
  } else {
    return errorResponse('MISSING_CODE', 400);
  }

  if (!success) {
    const attempts = (user.mfa_failed_attempts ?? 0) + 1;
    const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await env.D1.prepare(
      `UPDATE users SET mfa_failed_attempts = ?, mfa_locked_until = ? WHERE id = ?`
    ).bind(attempts, lockUntil, user.id).run();
    return errorResponse('INVALID_CODE', 401);
  }

  // Reset counters and consume recovery code if used
  if (updatedRecovery !== null) {
    await env.D1.prepare(
      `UPDATE users SET mfa_recovery_codes = ?, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = ?`
    ).bind(updatedRecovery, user.id).run();
  } else {
    await env.D1.prepare(
      `UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = ?`
    ).bind(user.id).run();
  }

  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const sessionToken = await signJwt(
    { sub: user.id, org_id: user.org_id, role: user.role, email: user.email },
    env
  );
  await recordToken(user.id, sessionToken, expiresAt, env);
  await env.D1.prepare(
    `UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(user.id).run();

  await emitAudit(env, {
    org_id: user.org_id, user_id: user.id,
    action: 'login', entity_type: 'user', entity_id: user.id,
    metadata: { mfa: true, recovery: updatedRecovery !== null },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    token: sessionToken,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, org_id: user.org_id },
  });
}

/**
 * GET /api/auth/mfa/status
 * Auth: full session JWT. Returns whether the current user has 2FA enabled.
 */
export async function mfaStatus(ctx: AuthContext, env: Env): Promise<Response> {
  const row = await env.D1.prepare(
    `SELECT mfa_enabled, mfa_enrolled_at FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(ctx.userId).first<{ mfa_enabled: number | null; mfa_enrolled_at: string | null }>();
  return jsonResponse({
    enabled: !!row?.mfa_enabled,
    enrolled_at: row?.mfa_enrolled_at ?? null,
  });
}

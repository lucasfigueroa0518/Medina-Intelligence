// Phase 4 (2026-05-04) — persistent per-user Firefly API key helpers.
//
// Replaces the "user pastes API key on every backfill, key is nuked on
// completion" UX with "set once, reuse forever". The driver
// (driveFireflyProgressiveBackfill) reads from here first; the legacy
// per-job api_key_encrypted column is kept as a fallback for in-flight
// backfills created before this phase.
//
// Security model (per Lucas 2026-05-04 final decisions):
//   • api_key_encrypted holds AES-256-GCM ciphertext via the existing
//     encryptToken/decryptToken helpers (same scheme as Outlook OAuth
//     tokens). Plaintext lives only in Worker memory at decrypt time.
//   • getFireflyKey is server-internal in spirit — never returned via
//     any HTTP endpoint. Caller is the driver at use-time only.
//   • Status helpers return metadata only (created_at, updated_at,
//     last_used_at, rotation_count) for System Status / settings UI.
//   • Hard delete on revocation. No soft-delete / revoked_at column.
//     Re-storing creates a fresh row.
//
// API surface (4 functions):
//   • storeFireflyKey       — UPSERT. Returns 'created' or 'rotated'.
//   • getFireflyKey         — fetch + decrypt + bump last_used_at.
//                             Returns null on no-row or decrypt failure.
//   • revokeFireflyKey      — hard DELETE. Used for both user-initiated
//                             revocation AND user-removal cascade.
//   • getFireflyKeyStatus   — read-only metadata (no plaintext).
//   • listFireflyKeyStatuses — for System Status: all rows in org.
//
// All writes catch-and-log so a credential failure does not block
// surrounding flows (driver tick, settings API request, etc.).

import type { Env } from '../types/env';
import { encryptToken, decryptToken } from './encryption';

// ─── storeFireflyKey ──────────────────────────────────────────────────────

export interface StoreResult {
  stored: 'created' | 'rotated';
}

/**
 * Encrypt the plaintext API key and UPSERT into user_firefly_credentials.
 *
 * Behavior:
 *   • First store: INSERT. rotation_count stays at default 0. Returns
 *     {stored: 'created'}.
 *   • Subsequent stores: UPDATE existing row. rotation_count += 1,
 *     updated_at advances. Returns {stored: 'rotated'}.
 *
 * The "was this a rotation?" distinction is conveyed via the SQL
 * RETURNING clause inspecting whether rotation_count moved past 0.
 *
 * Throws on encryption failure (TOKEN_ENCRYPTION_KEY missing/invalid)
 * or on D1 write failure. Callers should surface the error to the user
 * — these are configuration/infra failures, not transient flaky calls.
 */
export async function storeFireflyKey(
  userId: string,
  plaintextKey: string,
  env: Env
): Promise<StoreResult> {
  const trimmed = plaintextKey.trim();
  if (trimmed.length === 0) {
    throw new Error('plaintext key cannot be empty');
  }
  const encrypted = await encryptToken({ api_key: trimmed }, env);

  // Single UPSERT. On conflict (user already has a key), increments
  // rotation_count and updates updated_at. RETURNING surfaces the
  // POST-update rotation_count; >0 means this was a rotation, =0 means
  // freshly created.
  const row = await env.D1.prepare(
    `INSERT INTO user_firefly_credentials (user_id, api_key_encrypted)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       api_key_encrypted = excluded.api_key_encrypted,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       rotation_count = rotation_count + 1
     RETURNING rotation_count`
  ).bind(userId, encrypted).first<{ rotation_count: number }>();

  return { stored: (row?.rotation_count ?? 0) > 0 ? 'rotated' : 'created' };
}

// ─── getFireflyKey ────────────────────────────────────────────────────────

/**
 * Fetch and decrypt the user's stored Firefly API key. Returns null
 * when no row exists OR decryption fails (ciphertext corruption,
 * encryption-key rotation breakage, etc.).
 *
 * Bumps last_used_at on a successful decrypt. The bump is fire-and-
 * forget (catch-and-log) so a metadata write failure doesn't poison
 * the driver tick that needs the key.
 *
 * SECURITY: returns plaintext. Callers MUST NOT echo this value back
 * to any HTTP response, log line, or external system. The only
 * legitimate caller is the Firefly progressive-backfill driver at
 * fetch-time.
 */
export async function getFireflyKey(
  userId: string,
  env: Env
): Promise<string | null> {
  const row = await env.D1.prepare(
    `SELECT api_key_encrypted FROM user_firefly_credentials WHERE user_id = ?`
  ).bind(userId).first<{ api_key_encrypted: string }>();
  if (!row?.api_key_encrypted) return null;

  let plaintext: string | null = null;
  try {
    const decrypted = await decryptToken(row.api_key_encrypted, env);
    plaintext = decrypted.api_key || null;
  } catch (e) {
    // Decryption failure — likely a TOKEN_ENCRYPTION_KEY rotation or
    // ciphertext corruption. We treat as "no usable key" rather than
    // throwing — the driver will then fall back to the legacy per-job
    // path and ultimately mark the window failed if no key surfaces.
    console.error(`[firefly-creds] decrypt failed for user ${userId}:`, e instanceof Error ? e.message : e);
    return null;
  }

  // Best-effort last_used_at bump. Don't await — the driver shouldn't
  // wait on this metadata write to begin its actual API call.
  env.D1.prepare(
    `UPDATE user_firefly_credentials
        SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ?`
  ).bind(userId).run().catch(e => {
    console.error(`[firefly-creds] last_used_at bump failed for ${userId}:`, e instanceof Error ? e.message : e);
  });

  return plaintext;
}

// ─── revokeFireflyKey ─────────────────────────────────────────────────────

export interface RevokeResult {
  revoked: boolean; // true iff a row was deleted (false → no key existed)
}

/**
 * Hard-delete the user's persistent credential. Used for both:
 *   • User-initiated revoke (DELETE /api/settings/firefly-credentials).
 *   • User-removal cascade (called from the user-removal handler when
 *     a user is removed from the org).
 *
 * Re-storing after revocation creates a fresh row with rotation_count
 * back to 0 — there's no soft-delete state to un-revoke. Per Lucas's
 * 2026-05-04 decision: simpler schema, simpler reasoning.
 */
export async function revokeFireflyKey(
  userId: string,
  env: Env
): Promise<RevokeResult> {
  const result = await env.D1.prepare(
    `DELETE FROM user_firefly_credentials WHERE user_id = ?`
  ).bind(userId).run();
  return { revoked: (result.meta?.changes ?? 0) > 0 };
}

// ─── getFireflyKeyStatus ──────────────────────────────────────────────────

export interface FireflyKeyStatus {
  exists: boolean;
  user_id: string;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
  rotation_count: number;
}

/**
 * Read-only metadata about a user's stored credential. NEVER returns
 * plaintext or ciphertext — only lifecycle markers. Safe to expose via
 * authenticated GET /api/settings/firefly-credentials and via System
 * Status.
 *
 * `exists: false` when no row found. All other fields nulled in that
 * case. Callers can treat absence-of-row and exists=false uniformly.
 */
export async function getFireflyKeyStatus(
  userId: string,
  env: Env
): Promise<FireflyKeyStatus> {
  const row = await env.D1.prepare(
    `SELECT created_at, updated_at, last_used_at, rotation_count
       FROM user_firefly_credentials WHERE user_id = ?`
  ).bind(userId).first<{
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
    rotation_count: number;
  }>();
  if (!row) {
    return {
      exists: false,
      user_id: userId,
      created_at: null,
      updated_at: null,
      last_used_at: null,
      rotation_count: 0,
    };
  }
  return {
    exists: true,
    user_id: userId,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at,
    rotation_count: row.rotation_count,
  };
}

// ─── listFireflyKeyStatuses (org-wide, for System Status) ─────────────────

/**
 * List metadata for every credential row whose user belongs to the
 * given org. Joined against users so we only return rows for users
 * still active in the org (deleted_at IS NULL, org_id matches). A
 * stale row whose user has been hard-deleted via the cascade path
 * won't appear here, but the cascade should have removed it anyway —
 * this is defense in depth.
 *
 * Returns one entry per active user with a credential. No plaintext.
 */
export async function listFireflyKeyStatuses(
  orgId: string,
  env: Env
): Promise<FireflyKeyStatus[]> {
  const rows = await env.D1.prepare(
    `SELECT c.user_id, c.created_at, c.updated_at, c.last_used_at, c.rotation_count
       FROM user_firefly_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE u.org_id = ? AND u.deleted_at IS NULL
      ORDER BY c.user_id`
  ).bind(orgId).all<{
    user_id: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
    rotation_count: number;
  }>();
  return rows.results.map(r => ({
    exists: true,
    user_id: r.user_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_used_at: r.last_used_at,
    rotation_count: r.rotation_count,
  }));
}

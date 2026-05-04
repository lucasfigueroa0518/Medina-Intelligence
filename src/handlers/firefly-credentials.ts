// Self-service Firefly credential management — Phase 4 sub-stage 1b.
//
// Three endpoints, all auth-gated to the caller's own user_id. No
// admin-override path: per Lucas 2026-05-04, Phase 4 is self-service
// only. A user can only set, read status of, or revoke THEIR OWN
// stored Firefly API key. Future admin tooling is its own phase.
//
//   POST   /api/settings/firefly-credentials   — set or rotate
//   GET    /api/settings/firefly-credentials   — status (no plaintext)
//   DELETE /api/settings/firefly-credentials   — hard-revoke
//
// Plaintext NEVER returns from any of these endpoints. POST accepts
// plaintext in the request body, encrypts it via storeFireflyKey, and
// responds with metadata only. GET responds with metadata only. DELETE
// responds with confirmation only. The only legitimate consumer of
// the plaintext is the Firefly progressive-backfill driver at
// fetch-time via getFireflyKey (server-internal).

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import {
  storeFireflyKey,
  revokeFireflyKey,
  getFireflyKeyStatus,
} from '../lib/firefly-credentials';

interface StoreBody {
  api_key?: string;
}

/**
 * POST /api/settings/firefly-credentials
 * Body: { api_key: string }
 *
 * Stores or rotates the caller's Firefly API key. Encrypts via
 * AES-256-GCM (TOKEN_ENCRYPTION_KEY) and persists to
 * user_firefly_credentials. Returns {stored: 'created'} on first
 * write, {stored: 'rotated'} on subsequent writes.
 */
export async function storeMyFireflyCredential(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<StoreBody>(request);
  if (!body) return errorResponse('INVALID_BODY', 400);

  const apiKey = body.api_key?.trim();
  if (!apiKey) {
    return errorResponse('VALIDATION_ERROR', 400, 'api_key is required and must be non-empty');
  }
  if (apiKey.length > 4096) {
    // Sanity bound — Firefly API keys are far shorter than this. Guards
    // against payload-bloat attacks on the encryption path.
    return errorResponse('VALIDATION_ERROR', 400, 'api_key exceeds maximum length (4096 chars)');
  }

  let result: { stored: 'created' | 'rotated' };
  try {
    result = await storeFireflyKey(ctx.userId, apiKey, env);
  } catch (e) {
    console.error(`[firefly-creds] storeFireflyKey failed for user ${ctx.userId}:`, e instanceof Error ? e.message : e);
    return errorResponse('STORE_FAILED', 500, 'failed to encrypt or persist credential');
  }

  // Audit the metadata event (no plaintext or ciphertext logged).
  // entity_type='integration' is the closest match in the existing
  // AuditEntityType enum — Firefly credentials are integration secrets.
  // metadata.kind='firefly_credential' makes the per-Firefly subset
  // queryable without extending the enum.
  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: result.stored === 'created' ? 'create' : 'update',
    entity_type: 'integration',
    entity_id: ctx.userId,
    metadata: { kind: 'firefly_credential', stored: result.stored },
    created_at: new Date().toISOString(),
  });

  // Fetch fresh status to return — saves the caller a round-trip.
  const status = await getFireflyKeyStatus(ctx.userId, env);

  return jsonResponse({ stored: result.stored, status });
}

/**
 * GET /api/settings/firefly-credentials
 *
 * Returns metadata about the caller's stored credential. No plaintext,
 * no ciphertext. Drives the Settings UI's "do I have a key set up?"
 * check and the surrounding date-range buttons' disabled-state.
 */
export async function getMyFireflyCredential(
  _request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const status = await getFireflyKeyStatus(ctx.userId, env);
  return jsonResponse({ status });
}

/**
 * DELETE /api/settings/firefly-credentials
 *
 * Hard-deletes the caller's stored credential. Re-storing creates a
 * fresh row (rotation_count back to 0) — no soft-delete to un-revoke.
 * Returns { revoked: true } if a row was deleted, { revoked: false }
 * if no row existed. Both responses are 200 — idempotent from the
 * caller's perspective.
 */
export async function revokeMyFireflyCredential(
  _request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  let result: { revoked: boolean };
  try {
    result = await revokeFireflyKey(ctx.userId, env);
  } catch (e) {
    console.error(`[firefly-creds] revokeFireflyKey failed for user ${ctx.userId}:`, e instanceof Error ? e.message : e);
    return errorResponse('REVOKE_FAILED', 500, 'failed to delete credential');
  }

  if (result.revoked) {
    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'hard_delete',
      entity_type: 'integration',
      entity_id: ctx.userId,
      metadata: { kind: 'firefly_credential', source: 'user_initiated' },
      created_at: new Date().toISOString(),
    });
  }

  return jsonResponse({ revoked: result.revoked });
}

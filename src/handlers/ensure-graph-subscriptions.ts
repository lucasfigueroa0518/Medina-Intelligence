// Owner-triggered server-side recovery for missing Graph subscriptions.
//
// Background: when subs reach Microsoft Graph's 3-day max TTL without
// being renewed (e.g. because the daily cron didn't fire), MS deletes
// them server-side and our 404 handler at graph-subscriptions.ts:197
// removes the local row. Pre-2026-04-30 the only recovery path was a
// user-facing OAuth disconnect/reconnect — interrupting the user for a
// failure mode they can't see and didn't cause.
//
// This endpoint exposes the existing server-side primitive
// `ensureSubscriptionsForUser` as an owner-only admin operation. The
// stored refresh_token is offline_access scoped (~90-day persistence)
// and survives long after the access_token expires, so we can mint
// fresh subs without any user interaction as long as the refresh_token
// hasn't been revoked.
//
// Establishes the architectural pattern: users never reauth for
// subscription failures — only for genuine OAuth grant revocations
// (password change, IT policy, 90-day inactivity).
//
// POST /api/admin/ensure-graph-subscriptions
// Body (optional): { user_id?: string } — defaults to ctx.userId
// Returns:
//   { ok: true, user_id, subs: [...] } on success
//   { ok: false, reason: 'refresh_token_invalid' | 'unknown_error', detail? } on failure

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { ensureSubscriptionsForUser } from '../lib/graph-subscriptions';

const EXPECTED_RESOURCES = [
  'me/mailFolders/inbox/messages',
  'me/mailFolders/sentitems/messages',
  'me/events',
];

interface RequestBody {
  user_id?: string;
}

export async function handleEnsureGraphSubscriptions(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('FORBIDDEN', 403, 'owner role required');
  }

  const body = await parseJsonBody<RequestBody>(request);
  const targetUserId = body?.user_id?.trim() || ctx.userId;

  // Same-org guard. An owner in org A must not be able to ensure subs
  // for a user in org B. The check also confirms the target user is
  // active (deleted_at IS NULL).
  const target = await env.D1.prepare(
    `SELECT id, email FROM users
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL
       LIMIT 1`
  )
    .bind(targetUserId, ctx.orgId)
    .first<{ id: string; email: string }>();

  if (!target) {
    return errorResponse(
      'USER_NOT_IN_ORG',
      404,
      `user_id ${targetUserId} not found in org ${ctx.orgId} (or deleted)`
    );
  }

  // Pre-call snapshot — useful for distinguishing "all 3 already present"
  // from "all 3 created" in the response.
  const before = await env.D1.prepare(
    `SELECT resource FROM graph_subscriptions WHERE user_id = ? AND org_id = ?`
  )
    .bind(targetUserId, ctx.orgId)
    .all<{ resource: string }>();
  const beforeResources = new Set(before.results.map(r => r.resource));

  try {
    await ensureSubscriptionsForUser(targetUserId, ctx.orgId, env);
  } catch (e: any) {
    return jsonResponse({
      ok: false,
      reason: 'unknown_error',
      detail: String(e?.message || e).slice(0, 500),
    }, 500);
  }

  // Post-call query — what actually exists now.
  const after = await env.D1.prepare(
    `SELECT subscription_id, resource, expiration_at, updated_at
       FROM graph_subscriptions
      WHERE user_id = ? AND org_id = ?
      ORDER BY resource ASC`
  )
    .bind(targetUserId, ctx.orgId)
    .all<{ subscription_id: string; resource: string; expiration_at: string; updated_at: string }>();

  const afterResources = new Set(after.results.map(r => r.resource));
  const missing = EXPECTED_RESOURCES.filter(r => !afterResources.has(r));

  // If any of the 3 expected resources is still missing after the call,
  // the create-subscription path failed — almost always because
  // refreshOutlookToken returned { success: false }, which means
  // Microsoft rejected the stored refresh_token. Surface that reason
  // explicitly so the caller knows to fall back to user-facing reauth.
  if (missing.length > 0) {
    return jsonResponse({
      ok: false,
      reason: 'refresh_token_invalid',
      detail:
        `Expected resources still missing after ensureSubscriptionsForUser: ` +
        missing.join(', ') +
        ` — Microsoft likely rejected the stored refresh_token. User must reauth via OAuth.`,
      user_id: targetUserId,
      user_email: target.email,
      subs_present: after.results,
    });
  }

  return jsonResponse({
    ok: true,
    user_id: targetUserId,
    user_email: target.email,
    subs_existing_before: [...beforeResources],
    subs_present_after: after.results,
  });
}

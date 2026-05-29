// Phase F — manual link / unlink endpoints for deal evidence.
//
// These write to the same Phase B junction tables (conversation_deals,
// event_deals) and Phase E channel junction (slack_channel_deals) using
// source='manual'. Every write fires invalidateDealIntelligence so the
// brief_summary recomputes on next read.
//
// All four endpoints accept a deal_id in the path + a body with the
// source side. Auth: any user with role >= 'member' who can see the
// deal (i.e., the deal exists in their org). Owner-only is too strict
// — manual evidence curation is a daily curation task.
//
// Routes (registered in src/index.ts):
//   POST   /api/deals/:id/evidence/conversation { conversation_id }
//   DELETE /api/deals/:id/evidence/conversation/:conversation_id
//   POST   /api/deals/:id/evidence/event        { event_id }
//   DELETE /api/deals/:id/evidence/event/:event_id
//   POST   /api/deals/:id/evidence/slack-channel { channel_id }
//   DELETE /api/deals/:id/evidence/slack-channel/:channel_id
//
// On link: if the source record is in a different org, refuse (404).
// On unlink: idempotent — returns 200 even when no row existed.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { linkConversationToDeal, linkEventToDeal } from '../lib/deal-association';
import { canViewerReadConversation } from '../lib/email-derived-visibility';

async function assertDealVisible(dealId: string, orgId: string, env: Env): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(dealId, orgId).first();
  return !!row;
}

async function invalidateDeal(dealId: string, orgId: string, env: Env): Promise<void> {
  // Mirror invalidateDealIntelligence in deal-association.ts — broadcast
  // to all org users; per-user ACL filtering happens during recompute.
  await env.D1.prepare(
    `UPDATE deal_intelligence
        SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE deal_id = ? AND user_id IN (
        SELECT id FROM users WHERE org_id = ? AND deleted_at IS NULL
      )`
  ).bind(dealId, orgId).run();
}

// ─── Conversation ─────────────────────────────────────────────────────

export async function linkConversationToDealEndpoint(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!await assertDealVisible(dealId, ctx.orgId, env)) {
    return errorResponse('DEAL_NOT_FOUND', 404);
  }
  const body = await parseJsonBody<{ conversation_id?: string }>(request);
  if (!body?.conversation_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'conversation_id required');
  }
  const conv = await env.D1.prepare(
    `SELECT id FROM conversations WHERE id = ? AND org_id = ?`
  ).bind(body.conversation_id, ctx.orgId).first();
  if (!conv) return errorResponse('CONVERSATION_NOT_FOUND', 404);
  if (!await canViewerReadConversation(env, ctx, body.conversation_id)) {
    return errorResponse('CONVERSATION_FORBIDDEN', 403, 'Conversation is private and not readable by this viewer');
  }

  const r = await linkConversationToDeal(
    body.conversation_id, dealId, 'manual', 1.0, ctx.orgId, env, ctx.userId
  );
  return jsonResponse({ inserted: r.inserted, source: 'manual' }, r.inserted ? 201 : 200);
}

export async function unlinkConversationFromDeal(
  dealId: string,
  conversationId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!await assertDealVisible(dealId, ctx.orgId, env)) {
    return errorResponse('DEAL_NOT_FOUND', 404);
  }
  const result = await env.D1.prepare(
    `DELETE FROM conversation_deals
       WHERE conversation_id = ? AND deal_id = ?`
  ).bind(conversationId, dealId).run();
  if ((result.meta?.changes ?? 0) > 0) {
    await invalidateDeal(dealId, ctx.orgId, env);
  }
  return jsonResponse({ removed: result.meta?.changes ?? 0 });
}

// ─── Event ────────────────────────────────────────────────────────────

export async function linkEventToDealEndpoint(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!await assertDealVisible(dealId, ctx.orgId, env)) {
    return errorResponse('DEAL_NOT_FOUND', 404);
  }
  const body = await parseJsonBody<{ event_id?: string }>(request);
  if (!body?.event_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'event_id required');
  }
  const ev = await env.D1.prepare(
    `SELECT id FROM events WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(body.event_id, ctx.orgId).first();
  if (!ev) return errorResponse('EVENT_NOT_FOUND', 404);

  const r = await linkEventToDeal(
    body.event_id, dealId, 'manual', 1.0, ctx.orgId, env, ctx.userId
  );
  return jsonResponse({ inserted: r.inserted, source: 'manual' }, r.inserted ? 201 : 200);
}

export async function unlinkEventFromDeal(
  dealId: string,
  eventId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!await assertDealVisible(dealId, ctx.orgId, env)) {
    return errorResponse('DEAL_NOT_FOUND', 404);
  }
  const result = await env.D1.prepare(
    `DELETE FROM event_deals WHERE event_id = ? AND deal_id = ?`
  ).bind(eventId, dealId).run();
  if ((result.meta?.changes ?? 0) > 0) {
    await invalidateDeal(dealId, ctx.orgId, env);
  }
  return jsonResponse({ removed: result.meta?.changes ?? 0 });
}

// ─── Slack channel ────────────────────────────────────────────────────

export async function linkSlackChannelToDealEndpoint(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!await assertDealVisible(dealId, ctx.orgId, env)) {
    return errorResponse('DEAL_NOT_FOUND', 404);
  }
  const body = await parseJsonBody<{ channel_id?: string; backfill?: boolean }>(request);
  if (!body?.channel_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'channel_id required');
  }

  // Verify the channel exists in this org's slack inventory. Soft check
  // — we don't reject if not present (admin may be linking ahead of the
  // next slack sync), but warn the caller via has_channel: false.
  const channel = await env.D1.prepare(
    `SELECT channel_id FROM slack_channels WHERE org_id = ? AND channel_id = ?`
  ).bind(ctx.orgId, body.channel_id).first();

  const ins = await env.D1.prepare(
    `INSERT OR IGNORE INTO slack_channel_deals
       (org_id, channel_id, deal_id, confidence, source, created_by)
     VALUES (?, ?, ?, 1.0, 'manual', ?)`
  ).bind(ctx.orgId, body.channel_id, dealId, ctx.userId).run();

  const inserted = (ins.meta?.changes ?? 0) > 0;
  let backfilled = 0;
  if (inserted && body.backfill !== false) {
    // Reuse the Phase E backfill helper. Bounded; idempotent.
    try {
      const { backfillSlackChannelToDeal } = await import('../lib/deal-association');
      const r = await backfillSlackChannelToDeal(body.channel_id, dealId, ctx.orgId, env, 1.0);
      backfilled = r.inserted;
    } catch (e) {
      console.error(`[evidence-manual] slack backfill failed for channel=${body.channel_id} deal=${dealId}:`, e);
    }
  }
  if (inserted) await invalidateDeal(dealId, ctx.orgId, env);

  return jsonResponse({
    inserted,
    has_channel: !!channel,
    backfilled,
    source: 'manual',
  }, inserted ? 201 : 200);
}

export async function unlinkSlackChannelFromDeal(
  dealId: string,
  channelId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (!await assertDealVisible(dealId, ctx.orgId, env)) {
    return errorResponse('DEAL_NOT_FOUND', 404);
  }
  const result = await env.D1.prepare(
    `DELETE FROM slack_channel_deals
       WHERE org_id = ? AND channel_id = ? AND deal_id = ?`
  ).bind(ctx.orgId, channelId, dealId).run();
  if ((result.meta?.changes ?? 0) > 0) {
    await invalidateDeal(dealId, ctx.orgId, env);
  }
  return jsonResponse({ removed: result.meta?.changes ?? 0 });
}

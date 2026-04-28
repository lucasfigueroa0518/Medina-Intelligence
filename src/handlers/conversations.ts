// TRD §5.1, §3.12 — Conversations with email privacy gating
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { canReadEmailContent, getSharingFlags } from '../lib/helpers';

export async function listConversations(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const contactId = url.searchParams.get('contact_id');
  const source = url.searchParams.get('source');

  const where: string[] = ['c.org_id = ?'];
  const binds: unknown[] = [ctx.orgId];

  let join = '';
  if (contactId) {
    join = 'JOIN conversation_contacts cc ON c.id = cc.conversation_id';
    where.push('cc.contact_id = ?');
    binds.push(contactId);
  }
  if (start) {
    where.push('c.sent_at >= ?');
    binds.push(start);
  }
  if (end) {
    where.push('c.sent_at <= ?');
    binds.push(end);
  }
  if (source) {
    where.push('c.source = ?');
    binds.push(source);
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const whereClause = where.join(' AND ');

  const [result, countResult, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.* FROM conversations c ${join} WHERE ${whereClause} ORDER BY c.sent_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM conversations c ${join} WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const conversations = result.results.map((c: any) => {
    const canRead = canReadEmailContent(
      {
        source: c.source,
        participant_user_ids: c.participant_user_ids,
        is_campaign_email: c.is_campaign_email,
      } as any,
      ctx.userId,
      ctx.userRole,
      sharingFlags
    );
    return {
      ...c,
      canReadContent: canRead,
      body_preview: canRead ? c.body_preview : null,
      sentiment: canRead ? c.sentiment : null,
      topics: canRead ? c.topics : null,
      action_items: canRead ? c.action_items : null,
    };
  });

  return jsonResponse({
    conversations,
    total: countResult?.total || 0,
    limit,
    offset,
    has_more: offset + limit < (countResult?.total || 0),
  });
}

export async function getConversation(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const [conv, sharingFlags] = await Promise.all([
    env.D1.prepare(
      'SELECT * FROM conversations WHERE id = ? AND org_id = ?'
    ).bind(id, ctx.orgId).first<any>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  if (!conv) return errorResponse('CONVERSATION_NOT_FOUND', 404);

  const canRead = canReadEmailContent(conv, ctx.userId, ctx.userRole, sharingFlags);

  const out: any = {
    ...conv,
    canReadContent: canRead,
  };

  if (!canRead) {
    out.body_preview = null;
    out.sentiment = null;
    out.topics = null;
    out.action_items = null;
    return jsonResponse({ conversation: out });
  }

  // Fetch body from R2
  try {
    const bodyObj = await env.R2.get(conv.body_r2_key);
    if (bodyObj) out.body = await bodyObj.text();
  } catch {
    out.body = null;
  }

  return jsonResponse({ conversation: out });
}

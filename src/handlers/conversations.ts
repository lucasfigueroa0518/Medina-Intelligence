// TRD §5.1, §3.12 — Conversations with email privacy gating
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { canReadConversationContent, getSharingFlags } from '../lib/helpers';

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
      `SELECT c.*, sc.is_private AS slack_is_private
       FROM conversations c
       ${join}
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE ${whereClause}
       ORDER BY c.sent_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM conversations c ${join} WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const conversations = result.results.map((c: any) => {
    const canRead = canReadConversationContent(
      {
        source: c.source,
        participant_user_ids: c.participant_user_ids,
        is_campaign_email: c.is_campaign_email,
        slack_is_private: c.slack_is_private,
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
  }).filter((c: any) => c.canReadContent)
    .map(({ slack_is_private: _s, participant_user_ids: _p, is_campaign_email: _i, ...rest }: any) => rest);

  return jsonResponse({
    conversations,
    total: conversations.length,
    limit,
    offset,
    has_more: conversations.length === limit && offset + limit < (countResult?.total || 0),
  });
}

export async function getConversation(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const [conv, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.*, sc.is_private AS slack_is_private
       FROM conversations c
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE c.id = ? AND c.org_id = ?`
    ).bind(id, ctx.orgId).first<any>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  if (!conv) return errorResponse('CONVERSATION_NOT_FOUND', 404);

  const canRead = canReadConversationContent(conv, ctx.userId, ctx.userRole, sharingFlags);
  if (!canRead) return errorResponse('CONVERSATION_NOT_FOUND', 404);

  const out: any = {
    ...conv,
    canReadContent: canRead,
  };
  delete out.participant_user_ids;
  delete out.is_campaign_email;
  delete out.slack_is_private;

  // Fetch body from R2
  try {
    const bodyObj = await env.R2.get(conv.body_r2_key);
    if (bodyObj) out.body = await bodyObj.text();
  } catch {
    out.body = null;
  }

  return jsonResponse({ conversation: out });
}

export async function getConversationThread(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const [anchor, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.*, sc.is_private AS slack_is_private
       FROM conversations c
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE c.id = ? AND c.org_id = ?`
    ).bind(id, ctx.orgId).first<any>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  if (!anchor) return errorResponse('CONVERSATION_NOT_FOUND', 404);

  const rows = anchor.external_thread_id
    ? await env.D1.prepare(
      `SELECT c.*, sc.is_private AS slack_is_private
       FROM conversations c
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE c.org_id = ? AND c.external_thread_id = ?
       ORDER BY c.sent_at ASC`
    ).bind(ctx.orgId, anchor.external_thread_id).all<any>()
    : await env.D1.prepare(
      `SELECT c.*, sc.is_private AS slack_is_private
       FROM conversations c
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE c.id = ? AND c.org_id = ?
       ORDER BY c.sent_at ASC`
    ).bind(id, ctx.orgId).all<any>();

  const readableRows = rows.results.filter((row: any) => canReadConversationContent(
    {
      source: row.source,
      participant_user_ids: row.participant_user_ids,
      is_campaign_email: row.is_campaign_email,
      slack_is_private: row.slack_is_private,
    } as any,
    ctx.userId,
    ctx.userRole,
    sharingFlags
  ));

  if (readableRows.length === 0) return errorResponse('CONVERSATION_NOT_FOUND', 404);

  const contactIds = Array.from(new Set(
    readableRows.map((row: any) => row.from_contact_id).filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
  ));
  const contactsById = new Map<string, { full_name: string | null; email: string | null }>();
  if (contactIds.length > 0) {
    const placeholders = contactIds.map(() => '?').join(',');
    const contacts = await env.D1.prepare(
      `SELECT id, full_name, email FROM contacts
       WHERE org_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(ctx.orgId, ...contactIds).all<{ id: string; full_name: string | null; email: string | null }>();
    for (const contact of contacts.results) {
      contactsById.set(contact.id, { full_name: contact.full_name, email: contact.email });
    }
  }

  const messages = await Promise.all(readableRows.map(async (row: any) => {
    let body: string | null = null;
    if (row.body_r2_key) {
      try {
        const bodyObj = await env.R2.get(row.body_r2_key);
        if (bodyObj) body = await bodyObj.text();
      } catch {
        body = null;
      }
    }
    const contact = row.from_contact_id ? contactsById.get(row.from_contact_id) : undefined;
    return {
      id: row.id,
      source: row.source,
      external_message_id: row.external_message_id,
      subject: row.subject,
      sent_at: row.sent_at,
      direction: row.direction,
      from_name: contact?.full_name || null,
      from_email: contact?.email || row.from_email || null,
      body_preview: row.body_preview,
      body,
      has_attachments: !!row.has_attachments,
    };
  }));

  const last = messages[messages.length - 1];
  return jsonResponse({
    thread: {
      anchor_id: id,
      external_thread_id: anchor.external_thread_id || null,
      subject: last?.subject || anchor.subject || '(no subject)',
      source: anchor.source,
      message_count: messages.length,
      last_sent_at: last?.sent_at || anchor.sent_at || null,
      messages,
    },
  });
}

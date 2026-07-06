// TRD §5.1, §3.12 — Conversations with email privacy gating
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { canReadConversationContent, getSharingFlags } from '../lib/helpers';
import { conversationAclSql } from '../lib/email-derived-visibility';

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
  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  const acl = conversationAclSql('c', ctx, sharingFlags, 'sc.is_private');
  where.push(acl.sql);
  binds.push(...acl.binds);
  const whereClause = where.join(' AND ');
  const slackJoin = `LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END`;

  const [result, countResult] = await Promise.all([
    env.D1.prepare(
      `SELECT c.*, sc.is_private AS slack_is_private
       FROM conversations c
       ${join}
       ${slackJoin}
       WHERE ${whereClause}
       ORDER BY c.sent_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM conversations c ${join} ${slackJoin} WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
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

// Windowed pagination for conversation threads. A thread can be a long
// email/Slack chain; fetching every message body from R2 in one shot is the
// "thread is slow" symptom. We fetch row METADATA for the whole (ACL-filtered)
// thread — cheap, no R2 — then only fetch R2 bodies for the returned window.
const THREAD_WINDOW_DEFAULT = 30;
const THREAD_WINDOW_MAX = 100;

// Opaque cursor pointing at a message (its sent_at + id tiebreak). The client
// treats it as opaque; we encode/decode base64 JSON. Older messages are those
// that sort BEFORE this message under (sent_at ASC, id ASC).
interface ThreadCursor {
  sent_at: string | null;
  id: string;
}

function encodeThreadCursor(c: ThreadCursor): string {
  return btoa(JSON.stringify(c));
}

function decodeThreadCursor(raw: string | null): ThreadCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(atob(raw));
    if (parsed && typeof parsed.id === 'string') {
      return { sent_at: parsed.sent_at ?? null, id: parsed.id };
    }
  } catch {
    // Malformed cursor → treat as no cursor (newest window).
  }
  return null;
}

// True when `row` sorts strictly BEFORE `cursor` under (sent_at ASC, id ASC) —
// i.e. row is "older" than the message the cursor points at. Mirrors the ASC
// ordering used to build the thread so window math and cursor math never
// disagree. Rows with a null sent_at sort first (oldest).
function isOlderThanCursor(row: { sent_at: string | null; id: string }, cursor: ThreadCursor): boolean {
  const rowKey = row.sent_at ?? '';
  const curKey = cursor.sent_at ?? '';
  if (rowKey !== curKey) return rowKey < curKey;
  return row.id < cursor.id;
}

export async function getConversationThread(
  id: string,
  ctx: AuthContext,
  env: Env,
  request?: Request
): Promise<Response> {
  const url = request ? new URL(request.url) : null;
  const rawLimit = parseInt(url?.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, THREAD_WINDOW_MAX)
    : THREAD_WINDOW_DEFAULT;
  const beforeCursor = decodeThreadCursor(url?.searchParams.get('before') ?? null);

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

  // ACL FIRST, THEN WINDOW. Rows are ACL-filtered here; the window is applied
  // to the already-filtered list below. This is deliberate: if we windowed the
  // raw rows and then ACL-filtered, a page could come back padded with
  // unreadable rows (silently short) and the cursor could point at a row the
  // caller can't see, breaking older-page fetches. Filtering first keeps the
  // window and cursor defined purely over readable rows.
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

  // Canonical (sent_at ASC, id ASC) sort: the SQL ORDER BY has no id tiebreak,
  // so rows sharing a sent_at could be ordered differently by SQL than by the
  // cursor comparison, skipping/duplicating a row across pages. Sorting here
  // makes window math and isOlderThanCursor agree by construction.
  readableRows.sort((a: any, b: any) => {
    const ak = a.sent_at ?? '';
    const bk = b.sent_at ?? '';
    if (ak !== bk) return ak < bk ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Total readable messages in the thread (not the window size). Backward
  // compatible: message_count keeps meaning "how many messages in the thread".
  const totalReadable = readableRows.length;

  // Apply the window over the ACL-filtered rows. readableRows is sent_at ASC
  // (oldest→newest). A `before` cursor pages backward into older messages; the
  // default (no cursor) returns the NEWEST window (the recent tail users need
  // first). In both cases the returned slice stays ASC so the thread renders
  // newest-last, and older_cursor points at the oldest row of the window.
  const eligibleRows = beforeCursor
    ? readableRows.filter((row: any) => isOlderThanCursor(row, beforeCursor))
    : readableRows;
  const windowRows = eligibleRows.slice(Math.max(0, eligibleRows.length - limit));
  const hasMoreOlder = eligibleRows.length > windowRows.length;
  const oldestInWindow = windowRows[0];
  const olderCursor = hasMoreOlder && oldestInWindow
    ? encodeThreadCursor({ sent_at: oldestInWindow.sent_at ?? null, id: oldestInWindow.id })
    : null;

  const contactIds = Array.from(new Set(
    windowRows.map((row: any) => row.from_contact_id).filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
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

  // Only fetch R2 bodies for the returned window — this is the actual fix for
  // the slow-thread symptom (previously every message body was fetched).
  const messages = await Promise.all(windowRows.map(async (row: any) => {
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
      // Subject/last_sent_at describe the thread, not the window: derive them
      // from the NEWEST readable row (the anchor is just whatever message was
      // clicked and may be old), falling back to the anchor. Stable across
      // older-page fetches because readableRows always spans the whole thread.
      subject: readableRows[totalReadable - 1]?.subject || anchor.subject || '(no subject)',
      source: anchor.source,
      // Total messages in the thread (unchanged meaning), NOT the window size.
      message_count: totalReadable,
      last_sent_at: readableRows[totalReadable - 1]?.sent_at || anchor.sent_at || null,
      messages,
      // --- Additive pagination fields (unupgraded clients ignore them) ---
      // Number of messages actually returned in this window.
      window_size: messages.length,
      // True when older messages exist before this window. Pass older_cursor
      // back as `before` to fetch the previous (older) page.
      has_more_older: hasMoreOlder,
      older_cursor: olderCursor,
    },
  });
}

// Phase F — GET /api/deals/:id/evidence
//
// The user-visible payoff of the 6-phase deal-linkage architecture.
// Returns the full evidence trail for a deal: every conversation_deals
// + event_deals + slack_channel_deals row joined to its source record,
// reverse-chronological, ACL-filtered.
//
// Output shape: a single `evidence: EvidenceItem[]` array with type
// discriminators ('conversation' | 'event' | 'slack_channel') so the
// frontend can render each row with the right citation chip + remove
// button + source preview.
//
// ACL:
//   • Conversation rows: same canReadEmailContent gate the timeline
//     uses. Subject + metadata visible regardless; body_preview +
//     sender nulled when the user isn't a participant.
//   • Event rows: events are not body-protected; surface title +
//     start_time always.
//   • Slack channel rows: visible to anyone who can see the deal,
//     since the channel-level link doesn't carry per-message body.
//
// "Why it's here" reason maps the junction's `source` field to a
// human-readable label client-side; this endpoint just passes the
// raw enum through.
//
// Junction sources (from migrations 0071 + 0072):
//   conversation_deals/event_deals.source:
//     'auto_high', 'auto_medium', 'inherited_thread', 'inherited_channel',
//     'inherited_series', 'manual', 'llm_classification',
//     'approval_committed'
//   slack_channel_deals.source:
//     'channel_name_match', 'manual', 'llm_classification'

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { canReadEmailContent, getSharingFlags } from '../lib/helpers';

/* Phase F — manual-link candidate search.
 *
 * Returns conversations / events / slack channels the user can see and
 * link to this deal but that aren't already linked. Filtered by an
 * optional ?q= subject/title substring (case-insensitive). Scoped to
 * the most-recent N to keep responses bounded. */
export async function getDealEvidenceCandidates(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const deal = await env.D1.prepare(
    `SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(dealId, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const type = url.searchParams.get('type') || 'all'; // 'conversation'|'event'|'slack_channel'|'all'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10), 50);

  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  const qPattern = q ? `%${q}%` : '%';

  const out: any[] = [];

  if (type === 'conversation' || type === 'all') {
    const rows = await env.D1.prepare(
      `SELECT conv.id, conv.subject, conv.sent_at, conv.from_email, conv.from_name,
              conv.body_preview, conv.source AS conv_source, conv.participant_user_ids,
              conv.is_campaign_email
         FROM conversations conv
         LEFT JOIN conversation_deals cd
           ON cd.conversation_id = conv.id AND cd.deal_id = ?
        WHERE conv.org_id = ?
          AND cd.deal_id IS NULL
          AND (lower(conv.subject) LIKE ? OR lower(conv.body_preview) LIKE ?)
        ORDER BY conv.sent_at DESC
        LIMIT ?`
    ).bind(dealId, ctx.orgId, qPattern, qPattern, limit).all<any>();
    for (const r of rows.results) {
      const canRead = canReadEmailContent(
        { source: r.conv_source, participant_user_ids: r.participant_user_ids, is_campaign_email: r.is_campaign_email } as any,
        ctx.userId, ctx.userRole, sharingFlags
      );
      out.push({
        type: 'conversation',
        id: r.id,
        subject: r.subject || '(no subject)',
        sent_at: r.sent_at,
        from_name: canRead ? (r.from_name || r.from_email || null) : null,
        body_preview: canRead ? (r.body_preview || null) : null,
        can_read_body: canRead,
      });
    }
  }

  if (type === 'event' || type === 'all') {
    const rows = await env.D1.prepare(
      `SELECT e.id, e.title, e.start_time, e.event_type
         FROM events e
         LEFT JOIN event_deals ed ON ed.event_id = e.id AND ed.deal_id = ?
        WHERE e.org_id = ? AND e.deleted_at IS NULL
          AND ed.deal_id IS NULL
          AND lower(e.title) LIKE ?
        ORDER BY e.start_time DESC
        LIMIT ?`
    ).bind(dealId, ctx.orgId, qPattern, limit).all<any>();
    for (const r of rows.results) {
      out.push({
        type: 'event',
        id: r.id,
        title: r.title,
        start_time: r.start_time,
        event_type: r.event_type ?? null,
      });
    }
  }

  if (type === 'slack_channel' || type === 'all') {
    const rows = await env.D1.prepare(
      `SELECT sc.channel_id, sc.channel_name, sc.is_member
         FROM slack_channels sc
         LEFT JOIN slack_channel_deals scd
           ON scd.org_id = sc.org_id AND scd.channel_id = sc.channel_id AND scd.deal_id = ?
        WHERE sc.org_id = ?
          AND scd.deal_id IS NULL
          AND lower(coalesce(sc.channel_name,'')) LIKE ?
        ORDER BY sc.channel_name ASC
        LIMIT ?`
    ).bind(dealId, ctx.orgId, qPattern, limit).all<any>();
    for (const r of rows.results) {
      out.push({
        type: 'slack_channel',
        id: r.channel_id,
        channel_name: r.channel_name ?? null,
        is_member: r.is_member === 1,
      });
    }
  }

  return jsonResponse({ candidates: out });
}

interface ConversationEvidence {
  type: 'conversation';
  id: string;
  conversation_id: string;
  subject: string | null;
  sent_at: string;
  from_email: string | null;
  from_name: string | null;
  body_preview: string | null;
  source: string;
  confidence: number;
  linked_at: string;
  created_by: string | null;
  created_by_name: string | null;
  can_read_body: boolean;
}

interface EventEvidence {
  type: 'event';
  id: string;
  event_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  event_type: string | null;
  source: string;
  confidence: number;
  linked_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

interface SlackChannelEvidence {
  type: 'slack_channel';
  id: string;
  channel_id: string;
  channel_name: string | null;
  is_member: boolean;
  source: string;
  confidence: number;
  linked_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

type EvidenceItem = ConversationEvidence | EventEvidence | SlackChannelEvidence;

export async function getDealEvidence(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const deal = await env.D1.prepare(
    `SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const sharingFlags = await getSharingFlags(ctx.orgId, env);

  // Conversations + creator name + ACL inputs in one round-trip.
  const convRows = await env.D1.prepare(
    `SELECT cd.conversation_id AS id, cd.source, cd.confidence, cd.created_at AS linked_at,
            cd.created_by, cu.full_name AS created_by_name,
            conv.subject, conv.sent_at, conv.from_email, conv.from_name,
            conv.body_preview, conv.source AS conv_source,
            conv.participant_user_ids, conv.is_campaign_email
       FROM conversation_deals cd
       JOIN conversations conv ON conv.id = cd.conversation_id
       LEFT JOIN users cu ON cu.id = cd.created_by
      WHERE cd.deal_id = ? AND conv.org_id = ?
      ORDER BY conv.sent_at DESC`
  ).bind(id, ctx.orgId).all<any>();

  const conversationEvidence: ConversationEvidence[] = convRows.results.map(r => {
    const canRead = canReadEmailContent(
      { source: r.conv_source, participant_user_ids: r.participant_user_ids, is_campaign_email: r.is_campaign_email } as any,
      ctx.userId, ctx.userRole, sharingFlags
    );
    return {
      type: 'conversation',
      id: r.id,
      conversation_id: r.id,
      subject: r.subject ?? null,
      sent_at: r.sent_at,
      from_email: canRead ? (r.from_email ?? null) : null,
      from_name: canRead ? (r.from_name ?? null) : null,
      body_preview: canRead ? (r.body_preview ?? null) : null,
      source: r.source,
      confidence: r.confidence,
      linked_at: r.linked_at,
      created_by: r.created_by ?? null,
      created_by_name: r.created_by_name ?? null,
      can_read_body: canRead,
    };
  });

  const eventRows = await env.D1.prepare(
    `SELECT ed.event_id AS id, ed.source, ed.confidence, ed.created_at AS linked_at,
            ed.created_by, eu.full_name AS created_by_name,
            e.title, e.start_time, e.end_time, e.event_type
       FROM event_deals ed
       JOIN events e ON e.id = ed.event_id
       LEFT JOIN users eu ON eu.id = ed.created_by
      WHERE ed.deal_id = ? AND e.org_id = ? AND e.deleted_at IS NULL
      ORDER BY e.start_time DESC`
  ).bind(id, ctx.orgId).all<any>();

  const eventEvidence: EventEvidence[] = eventRows.results.map(r => ({
    type: 'event',
    id: r.id,
    event_id: r.id,
    title: r.title,
    start_time: r.start_time,
    end_time: r.end_time ?? null,
    event_type: r.event_type ?? null,
    source: r.source,
    confidence: r.confidence,
    linked_at: r.linked_at,
    created_by: r.created_by ?? null,
    created_by_name: r.created_by_name ?? null,
  }));

  const slackRows = await env.D1.prepare(
    `SELECT scd.channel_id AS id, scd.source, scd.confidence, scd.created_at AS linked_at,
            scd.created_by, su.full_name AS created_by_name,
            sc.channel_name, sc.is_member
       FROM slack_channel_deals scd
       LEFT JOIN slack_channels sc ON sc.org_id = scd.org_id AND sc.channel_id = scd.channel_id
       LEFT JOIN users su ON su.id = scd.created_by
      WHERE scd.org_id = ? AND scd.deal_id = ?
      ORDER BY scd.created_at DESC`
  ).bind(ctx.orgId, id).all<any>();

  const slackEvidence: SlackChannelEvidence[] = slackRows.results.map(r => ({
    type: 'slack_channel',
    id: r.id,
    channel_id: r.id,
    channel_name: r.channel_name ?? null,
    is_member: r.is_member === 1,
    source: r.source,
    confidence: r.confidence,
    linked_at: r.linked_at,
    created_by: r.created_by ?? null,
    created_by_name: r.created_by_name ?? null,
  }));

  // Reverse-chronological merge. Conversations sort by sent_at, events by
  // start_time, slack channels by linked_at (no per-channel timestamp).
  const sortKey = (e: EvidenceItem): string =>
    e.type === 'conversation' ? e.sent_at
    : e.type === 'event' ? e.start_time
    : e.linked_at;
  const evidence: EvidenceItem[] = [...conversationEvidence, ...eventEvidence, ...slackEvidence]
    .sort((a, b) => String(sortKey(b)).localeCompare(String(sortKey(a))));

  return jsonResponse({
    deal_id: id,
    evidence,
    counts: {
      conversations: conversationEvidence.length,
      events: eventEvidence.length,
      slack_channels: slackEvidence.length,
      total: evidence.length,
    },
  });
}

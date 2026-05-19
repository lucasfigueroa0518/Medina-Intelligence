import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';
import { findDuplicateCompany } from './discovery';
import { updateEntityInIndex } from './entity-index';
import { canReadConversationContent, chunkArray, getSharingFlags, hasOrgWidePrivateDataAccess } from './helpers';
import { isCompanyInternal, assertNoOpenDealForCompany, OpenDealConflictError } from './internal-entity';
import {
  updateContactFields, updateCompanyFields, updateDealFields,
  deleteEntityField,
  createContactRecord, createCompanyRecord, createDealRecord,
  type WriteContext,
} from './entity-writes';
import { linkConversationToDeal, linkEventToDeal } from './deal-association';
import { loadFirmRelationshipSnapshot, upsertFirmCompanyRelationship } from './firm-relationship-state';
import { preprocessQuery, retrieveContext } from './retrieval';
import { buildSourcesAndContext } from './citations';
import { MAX_MODE_LIMITS, NORMAL_MODE_LIMITS } from './max-mode';

export interface AgentToolContext {
  deepDive?: boolean;
}

function structuredLimit(inputLimit: number | undefined, toolContext?: AgentToolContext): number {
  const fallback = toolContext?.deepDive
    ? MAX_MODE_LIMITS.structuredDefault
    : NORMAL_MODE_LIMITS.structuredDefault;
  const max = toolContext?.deepDive
    ? MAX_MODE_LIMITS.structuredMax
    : NORMAL_MODE_LIMITS.structuredMax;
  return Math.min(Math.max(inputLimit ?? fallback, 1), max);
}

function sweepLimit(inputLimit: number | undefined, toolContext?: AgentToolContext): number {
  const fallback = toolContext?.deepDive
    ? MAX_MODE_LIMITS.conversationSweepDefault
    : NORMAL_MODE_LIMITS.structuredDefault;
  const max = toolContext?.deepDive
    ? MAX_MODE_LIMITS.conversationSweepMax
    : NORMAL_MODE_LIMITS.structuredMax;
  return Math.min(Math.max(inputLimit ?? fallback, 1), max);
}

function normalizeEmail(value: unknown): string | null {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function cleanTerm(term: unknown): string | null {
  const text = String(term || '').trim().toLowerCase();
  if (!text) return null;
  return text.replace(/[%_]/g, '').slice(0, 120) || null;
}

const SWEEP_STOP_WORDS = new Set([
  'all', 'and', 'are', 'associated', 'can', 'could', 'every', 'excel', 'file',
  'first', 'for', 'from', 'get', 'give', 'have', 'individuals', 'list', 'mail',
  'merge', 'myself', 'names', 'need', 'people', 'pull', 'that', 'the', 'their',
  'them', 'this', 'took', 'type', 'want', 'with', 'you', 'your',
]);

function deriveSweepTerms(query: string | undefined): string[] {
  if (!query) return [];
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._@-]{2,}/gi) || [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/^[-_.]+|[-_.]+$/g, '');
    if (cleaned.length < 3 || SWEEP_STOP_WORDS.has(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    terms.push(cleaned);
    if (terms.length >= 12) break;
  }
  return terms;
}

function parseMaybeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function collectEmailEntries(value: unknown): Array<{ email: string; display_name?: string }> {
  if (value == null) return [];
  if (typeof value === 'string') {
    const parsed = value.trim().startsWith('[') || value.trim().startsWith('{')
      ? parseMaybeJson(value)
      : value;
    if (parsed !== value) return collectEmailEntries(parsed);
    const entries: Array<{ email: string; display_name?: string }> = [];
    const emailRegex = /(?:"?([^"<,;]+?)"?\s*)?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/gi;
    let match: RegExpExecArray | null;
    while ((match = emailRegex.exec(value)) !== null) {
      const email = normalizeEmail(match[2]);
      if (!email) continue;
      const display = String(match[1] || '').trim().replace(/^"|"$/g, '');
      entries.push({ email, display_name: display || undefined });
    }
    return entries;
  }
  if (Array.isArray(value)) return value.flatMap(collectEmailEntries);
  if (typeof value === 'object') {
    const record = value as Record<string, any>;
    const email =
      normalizeEmail(record.email) ||
      normalizeEmail(record.address) ||
      normalizeEmail(record.emailAddress?.address) ||
      normalizeEmail(record.email_address);
    const display = String(
      record.name ||
      record.displayName ||
      record.emailAddress?.name ||
      ''
    ).trim();
    return email ? [{ email, display_name: display || undefined }] : [];
  }
  const email = normalizeEmail(value);
  return email ? [{ email }] : [];
}

function firstNameFrom(fullName: string | undefined, email: string): string {
  const name = String(fullName || '').trim();
  if (name) return name.split(/\s+/)[0];
  const local = email.split('@')[0] || email;
  return local
    .split(/[._+-]+/)
    .find(part => part.length > 0)
    ?.replace(/^\w/, c => c.toUpperCase()) || email;
}

async function lookupContactsByEmail(
  orgId: string,
  emails: string[],
  env: Env
): Promise<Map<string, { full_name: string; company_name?: string | null }>> {
  const out = new Map<string, { full_name: string; company_name?: string | null }>();
  const unique = [...new Set(emails.map(e => e.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 80) {
    const batch = unique.slice(i, i + 80);
    const ph = batch.map(() => '?').join(',');
    const rows = await env.D1.prepare(
      `SELECT LOWER(c.email) AS email, c.full_name, co.name AS company_name
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.org_id = ? AND c.deleted_at IS NULL AND LOWER(c.email) IN (${ph})`
    ).bind(orgId, ...batch).all<{ email: string; full_name: string; company_name: string | null }>();
    for (const row of rows.results || []) {
      if (row.email) out.set(row.email, { full_name: row.full_name, company_name: row.company_name });
    }
  }
  return out;
}

// ACL redaction: nulls fields whose value may have been derived from private
// conversation content (LLM-extracted topics, auto-populated deal notes,
// raw-data R2 keys). Owner gets the full row. Membership-aware filtering of
// conversation rows happens via canReadEmailContent in the conversation
// tools — this helper handles entity-level fields that aren't conversation
// rows but still expose synthesized email/meeting context.
//
// Mutates `entity` in place and returns it for ergonomic chaining. Safe
// because callers are working with freshly-allocated D1 row objects.
const CONTACT_REDACTED_FIELDS = [
  'topics_of_interest',
  'pain_points',
  'investment_thesis_tags',
  'next_followup_note',
  // Defense-in-depth: R2 keys aren't fetchable through the agent tools
  // today, but a future read-blob tool would expose them. Strip now.
  'r2_key',
  'linkedin_data_r2_key',
  'pitchbook_data_r2_key',
  'web_enrichment_r2_key',
] as const;
const DEAL_REDACTED_FIELDS = [
  'notes',           // auto-populated with email/conversation evidence (cleanup.ts)
  'thesis_fit',      // LLM-derived from communications
  'deal_memo_r2_key', // defense-in-depth
] as const;

function redactSensitiveFields<T extends Record<string, any>>(
  entity: T,
  userRole: string,
  entityType: 'contact' | 'deal',
): T {
  if (hasOrgWidePrivateDataAccess(userRole)) return entity;
  const fields = entityType === 'contact' ? CONTACT_REDACTED_FIELDS : DEAL_REDACTED_FIELDS;
  for (const f of fields) {
    if (f in entity) entity[f as keyof T] = null as T[keyof T];
  }
  return entity;
}

// ---------------------------------------------------------------------------
// READ TOOLS
// ---------------------------------------------------------------------------

// ACL: filtered to rows the requesting user can read per canReadEmailContent.
// Owner role bypasses per existing helpers.ts policy.
export async function searchConversations(
  ctx: AuthContext,
  input: {
    keyword?: string;
    source?: string;
    contact_id?: string;
    direction?: string;
    days_back?: number;
    limit?: number;
  },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const where: string[] = ['c.org_id = ?'];
  const binds: unknown[] = [ctx.orgId];

  if (input.source === 'firefly' || input.source === 'meeting' || input.source === 'meetings') {
    return {
      conversations: [],
      count: 0,
      error: 'SOURCE_NOT_IN_CONVERSATIONS',
      message: 'Firefly meeting transcripts and calendar events are stored in the events table, not conversations. Use search_events for meetings, calendar windows, and transcript-backed recaps.',
    };
  }

  if (input.source && input.source !== 'all') {
    where.push('c.source = ?');
    binds.push(input.source);
  }

  if (input.direction && input.direction !== 'all') {
    where.push('c.direction = ?');
    binds.push(input.direction);
  }

  const daysBack = input.days_back || (
    toolContext.deepDive
      ? MAX_MODE_LIMITS.conversationDaysBackDefault
      : NORMAL_MODE_LIMITS.conversationDaysBackDefault
  );
  where.push(`c.sent_at >= datetime('now', '-${Math.min(daysBack, 365)} days')`);

  if (input.contact_id) {
    where.push(
      `(c.from_contact_id = ? OR c.id IN (SELECT conversation_id FROM conversation_contacts WHERE contact_id = ?))`
    );
    binds.push(input.contact_id, input.contact_id);
  }

  if (input.keyword) {
    where.push('(c.subject LIKE ? OR c.body_preview LIKE ? OR c.from_email LIKE ? OR c.to_emails LIKE ? OR c.cc_emails LIKE ?)');
    binds.push(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`);
  }

  const limit = structuredLimit(input.limit, toolContext);
  // Over-fetch so post-filter list still approximates `limit`. MAX mode gets
  // a larger fetch window while preserving the same post-filter privacy gate.
  const fetchLimit = toolContext.deepDive
    ? Math.min(limit * MAX_MODE_LIMITS.conversationOverfetchMultiplier, MAX_MODE_LIMITS.conversationFetchMax)
    : Math.min(limit * 2, 100);

  const [result, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, c.subject, c.from_email, c.direction, c.source, c.sent_at,
              c.body_preview, c.body_r2_key, c.sentiment, c.topics, c.action_items,
              c.to_emails, c.cc_emails, c.from_contact_id,
              c.participant_user_ids, c.is_campaign_email,
              c.external_message_id, sc.is_private AS slack_is_private,
              fc.full_name AS from_name
       FROM conversations c
       LEFT JOIN contacts fc ON c.from_contact_id = fc.id
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE ${where.join(' AND ')}
       ORDER BY c.sent_at DESC
       LIMIT ?`
    ).bind(...binds, fetchLimit).all(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const conversations = (result.results as any[])
    .filter(c =>
      canReadConversationContent(
        {
          source: c.source,
          participant_user_ids: c.participant_user_ids,
          is_campaign_email: c.is_campaign_email,
          slack_is_private: c.slack_is_private,
        },
        ctx.userId,
        ctx.userRole,
        sharingFlags
      )
    )
    .slice(0, limit);

  for (const c of conversations) {
    delete c.participant_user_ids;
    delete c.is_campaign_email;
    delete c.external_message_id;
    delete c.slack_is_private;
  }

  if (conversations.length > 0) {
    const ids = conversations.map(c => c.id);
    const ph = ids.map(() => '?').join(',');
    const participantRows = await env.D1.prepare(
      `SELECT cc.conversation_id, ct.full_name
       FROM conversation_contacts cc
       JOIN contacts ct ON cc.contact_id = ct.id
       WHERE cc.conversation_id IN (${ph})`
    ).bind(...ids).all();

    const participantMap = new Map<string, string[]>();
    for (const r of participantRows.results as any[]) {
      const arr = participantMap.get(r.conversation_id) || [];
      arr.push(r.full_name);
      participantMap.set(r.conversation_id, arr);
    }

    for (const conv of conversations) {
      conv.participants = participantMap.get(conv.id) || [];

      if (conv.body_r2_key) {
        try {
          const obj = await env.R2.get(conv.body_r2_key);
          if (obj) {
            const fullBody = await obj.text();
            conv.body_preview = fullBody.slice(0, 500);
            if (fullBody.length > 500) conv.body_preview += '...';
          }
        } catch { /* R2 fetch failed, keep existing preview */ }
      }

      delete conv.body_r2_key;
    }
  }

  return { conversations, count: conversations.length };
}

type SearchEventsTimeframe = 'recent' | 'upcoming' | 'past' | 'recent_and_upcoming' | 'all';

const EVENT_KEYWORD_STOP_WORDS = new Set([
  'all', 'and', 'calendar', 'event', 'events', 'future', 'give', 'into',
  'meeting', 'meetings', 'past', 'recent', 'recap', 'recaps', 'show',
  'transcript', 'transcripts', 'upcoming', 'window',
]);

function addDaysIso(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function normalizeDateBound(value: unknown): string | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function deriveEventKeywordTerms(keyword: unknown): string[] {
  const text = String(keyword || '').trim().toLowerCase();
  if (!text) return [];
  const tokens = text.match(/[a-z0-9][a-z0-9._@-]{2,}/gi) || [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/^[-_.]+|[-_.]+$/g, '').toLowerCase();
    if (cleaned.length < 3 || EVENT_KEYWORD_STOP_WORDS.has(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    terms.push(cleaned);
    if (terms.length >= 8) break;
  }
  return terms;
}

function cleanEventText(value: unknown, max = 700): string | null {
  if (value == null) return null;
  let text = String(value).trim();
  if (!text) return null;
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        text = parsed
          .map(item => typeof item === 'string' ? item : JSON.stringify(item))
          .join('; ');
      } else if (parsed && typeof parsed === 'object') {
        text = Object.entries(parsed as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('; ');
      }
    } catch {
      // Keep the original string when legacy rows contain JSON-ish text.
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function canUseEventSource(source: unknown): source is 'outlook' | 'firefly' | 'manual' | 'all' {
  return source === 'outlook' || source === 'firefly' || source === 'manual' || source === 'all';
}

function canUseEventType(type: unknown): type is 'meeting' | 'conference' | 'call' | 'email_thread' | 'hosted_event' | 'in_person' | 'other' | 'all' {
  return type === 'meeting' || type === 'conference' || type === 'call' || type === 'email_thread' || type === 'hosted_event' || type === 'in_person' || type === 'other' || type === 'all';
}

// Deterministic calendar/event search. This is intentionally separate from
// search_conversations: Firefly transcripts are first-class event rows, not
// conversation rows. Keeping the data families separate prevents a zero-result
// conversation search from being misread as "no meeting transcripts exist."
export async function searchEvents(
  ctx: AuthContext,
  input: {
    keyword?: string;
    event_type?: 'meeting' | 'conference' | 'call' | 'email_thread' | 'hosted_event' | 'in_person' | 'other' | 'all';
    source?: 'outlook' | 'firefly' | 'manual' | 'all';
    timeframe?: SearchEventsTimeframe;
    start_date?: string;
    end_date?: string;
    days_back?: number;
    days_forward?: number;
    has_transcript?: boolean;
    include_transcript_excerpt?: boolean;
    limit?: number;
  },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const now = new Date();
  const timeframe: SearchEventsTimeframe = input.timeframe || 'recent_and_upcoming';
  const daysBack = Math.min(Math.max(Number(input.days_back ?? 60), 1), 730);
  const daysForward = Math.min(Math.max(Number(input.days_forward ?? 90), 1), 730);

  let startBound = normalizeDateBound(input.start_date);
  let endBound = normalizeDateBound(input.end_date);
  if (!startBound && !endBound) {
    if (timeframe === 'upcoming') {
      startBound = now.toISOString();
      endBound = addDaysIso(now, daysForward);
    } else if (timeframe === 'past' || timeframe === 'recent') {
      startBound = addDaysIso(now, -daysBack);
      endBound = now.toISOString();
    } else if (timeframe === 'recent_and_upcoming') {
      startBound = addDaysIso(now, -daysBack);
      endBound = addDaysIso(now, daysForward);
    }
  }

  const where: string[] = ['e.org_id = ?', 'e.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  const sharingFlags = await getSharingFlags(ctx.orgId, env);

  if (!hasOrgWidePrivateDataAccess(ctx.userRole)) {
    const readableUserIds = [ctx.userId, ...Object.keys(sharingFlags).filter(id => id !== ctx.userId)];
    const ph = readableUserIds.map(() => '?').join(',');
    where.push(`EXISTS (
      SELECT 1 FROM event_attendees ea_acl
       WHERE ea_acl.event_id = e.id
         AND ea_acl.user_id IN (${ph})
    )`);
    binds.push(...readableUserIds);
  }

  if (startBound) {
    where.push('e.start_time >= ?');
    binds.push(startBound);
  }
  if (endBound) {
    where.push('e.start_time <= ?');
    binds.push(endBound);
  }

  if (input.source && canUseEventSource(input.source) && input.source !== 'all') {
    where.push('e.source = ?');
    binds.push(input.source);
  }

  if (input.event_type && canUseEventType(input.event_type) && input.event_type !== 'all') {
    where.push('e.event_type = ?');
    binds.push(input.event_type);
  }

  if (typeof input.has_transcript === 'boolean') {
    where.push(input.has_transcript ? 'e.transcript_r2_key IS NOT NULL' : 'e.transcript_r2_key IS NULL');
  }

  const keywordTerms = deriveEventKeywordTerms(input.keyword);
  if (keywordTerms.length > 0) {
    const searchable = [
      'LOWER(COALESCE(e.title, \'\'))',
      'LOWER(COALESCE(e.location, \'\'))',
      'LOWER(COALESCE(e.description, \'\'))',
      'LOWER(COALESCE(e.summary, \'\'))',
      'LOWER(COALESCE(e.key_decisions, \'\'))',
      'LOWER(COALESCE(e.action_items, \'\'))',
      'LOWER(COALESCE(e.topics_discussed, \'\'))',
    ];
    const termClauses = keywordTerms.map(() => `(${searchable.map(expr => `${expr} LIKE ?`).join(' OR ')})`);
    where.push(`(${termClauses.join(' OR ')})`);
    for (const term of keywordTerms) {
      for (let i = 0; i < searchable.length; i++) binds.push(`%${term}%`);
    }
  }

  const limit = structuredLimit(input.limit, toolContext);
  const whereSql = where.join(' AND ');
  const orderBinds: unknown[] = [];
  let orderSql = 'e.start_time DESC';
  if (timeframe === 'upcoming') {
    orderSql = 'e.start_time ASC';
  } else if (timeframe === 'recent_and_upcoming') {
    orderSql = `CASE WHEN e.start_time >= ? THEN 0 ELSE 1 END ASC,
                CASE WHEN e.start_time >= ? THEN e.start_time END ASC,
                e.start_time DESC`;
    orderBinds.push(now.toISOString(), now.toISOString());
  }

  const rowSql = `
    SELECT e.id, e.title, e.event_type, e.start_time, e.end_time, e.location,
           e.description, e.source, e.outlook_event_id, e.firefly_event_id,
           e.reconciliation_status, e.transcript_r2_key, e.transcript_source,
           e.summary, e.key_decisions, e.action_items, e.topics_discussed,
           e.followup_status, e.followup_due_date
      FROM events e
     WHERE ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ?`;

  const [rows, totalRow, transcriptRow, sourceRows] = await Promise.all([
    env.D1.prepare(rowSql).bind(...binds, ...orderBinds, limit).all<any>(),
    env.D1.prepare(`SELECT COUNT(*) AS total FROM events e WHERE ${whereSql}`).bind(...binds).first<{ total: number }>(),
    env.D1.prepare(`SELECT COUNT(*) AS total FROM events e WHERE ${whereSql} AND e.transcript_r2_key IS NOT NULL`).bind(...binds).first<{ total: number }>(),
    env.D1.prepare(`SELECT e.source, COUNT(*) AS total FROM events e WHERE ${whereSql} GROUP BY e.source`).bind(...binds).all<{ source: string; total: number }>(),
  ]);

  const eventRows = rows.results || [];
  const eventIds = eventRows.map((row: any) => row.id).filter(Boolean);
  const attendeesByEvent = new Map<string, Array<Record<string, unknown>>>();
  const attendeeCounts = new Map<string, number>();
  if (eventIds.length > 0) {
    for (const batch of chunkArray(eventIds, 80)) {
      const ph = batch.map(() => '?').join(',');
      const attendeeRows = await env.D1.prepare(
        `SELECT event_id, email, display_name, role, is_internal
           FROM event_attendees
          WHERE event_id IN (${ph})
          ORDER BY CASE role
            WHEN 'organizer' THEN 0
            WHEN 'presenter' THEN 1
            WHEN 'attendee' THEN 2
            ELSE 3
          END, display_name ASC, email ASC`
      ).bind(...batch).all<any>();
      for (const attendee of attendeeRows.results || []) {
        attendeeCounts.set(attendee.event_id, (attendeeCounts.get(attendee.event_id) || 0) + 1);
        const list = attendeesByEvent.get(attendee.event_id) || [];
        if (list.length < 25) {
          list.push({
            email: attendee.email,
            display_name: attendee.display_name,
            role: attendee.role,
            is_internal: !!attendee.is_internal,
          });
        }
        attendeesByEvent.set(attendee.event_id, list);
      }
    }
  }

  const events: any[] = [];
  for (const row of eventRows) {
    let transcriptExcerpt: string | null = null;
    if (input.include_transcript_excerpt && row.transcript_r2_key) {
      try {
        const obj = await env.R2.get(row.transcript_r2_key);
        if (obj) transcriptExcerpt = cleanEventText(await obj.text(), 1400);
      } catch {
        transcriptExcerpt = null;
      }
    }

    events.push({
      id: row.id,
      title: row.title,
      event_type: row.event_type,
      source: row.source,
      start_time: row.start_time,
      end_time: row.end_time,
      location: row.location,
      description: cleanEventText(row.description, 500),
      summary: cleanEventText(row.summary, 900),
      key_decisions: cleanEventText(row.key_decisions, 700),
      action_items: cleanEventText(row.action_items, 700),
      topics_discussed: cleanEventText(row.topics_discussed, 700),
      followup_status: row.followup_status,
      followup_due_date: row.followup_due_date,
      reconciliation_status: row.reconciliation_status,
      has_transcript: !!row.transcript_r2_key,
      transcript_source: row.transcript_source,
      transcript_excerpt: transcriptExcerpt || undefined,
      attendee_count: attendeeCounts.get(row.id) || 0,
      attendees: attendeesByEvent.get(row.id) || [],
    });
  }

  const source_counts: Record<string, number> = {};
  for (const row of sourceRows.results || []) source_counts[row.source || 'unknown'] = row.total || 0;

  return {
    events,
    count: events.length,
    coverage: {
      mode: toolContext.deepDive ? 'deep' : 'agile',
      total_matching_events: totalRow?.total || 0,
      returned_count: events.length,
      effective_limit: limit,
      has_more: (totalRow?.total || 0) > events.length,
      matching_events_with_transcripts: transcriptRow?.total || 0,
      source_counts,
      timeframe,
      start_bound: startBound,
      end_bound: endBound,
      keyword_terms: keywordTerms,
      acl_scope: hasOrgWidePrivateDataAccess(ctx.userRole) ? 'org_wide_role' : 'participant_or_shared_user_events',
    },
    data_model_note: 'Meeting transcripts and calendar events live in events. search_conversations only covers emails and Slack/manual conversation rows.',
    note: (totalRow?.total || 0) > events.length
      ? `Showing ${events.length} of ${totalRow?.total || 0} matching events. Increase limit or narrow the window for more.`
      : undefined,
  };
}

// MAX-mode deterministic conversation sweep. Unlike recall(), this is not a
// top-N semantic retriever: it walks the conversations table with SQL filters
// and returns large, structured row sets plus optional recipient aggregation.
// This is the path for "all/every/list/export/count" questions where missing
// the long tail is worse than returning a few extra rows for MARTy to classify.
export async function sweepConversations(
  ctx: AuthContext,
  input: {
    query?: string;
    all_terms?: string[];
    any_terms?: string[];
    source?: 'outlook' | 'email' | 'slack' | 'manual' | 'all';
    direction?: string;
    from_emails?: string[];
    participant_emails?: string[];
    start_date?: string;
    end_date?: string;
    days_back?: number;
    include_recipients?: boolean;
    include_body?: boolean;
    body_fetch_limit?: number;
    exclude_domains?: string[];
    limit?: number;
    offset?: number;
  },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const where: string[] = ['c.org_id = ?'];
  const binds: unknown[] = [ctx.orgId];
  const searchable = [
    'LOWER(COALESCE(c.subject, \'\'))',
    'LOWER(COALESCE(c.body_preview, \'\'))',
    'LOWER(COALESCE(c.from_email, \'\'))',
    'LOWER(COALESCE(c.to_emails, \'\'))',
    'LOWER(COALESCE(c.cc_emails, \'\'))',
  ];
  const addRequiredTermClause = (term: string): void => {
    const cleaned = cleanTerm(term);
    if (!cleaned) return;
    const clause = `(${searchable.map(expr => `${expr} LIKE ?`).join(' OR ')})`;
    where.push(clause);
    for (let i = 0; i < searchable.length; i++) binds.push(`%${cleaned}%`);
  };

  const allTerms = (input.all_terms || []).map(cleanTerm).filter((x): x is string => Boolean(x));
  const anyTerms = (input.any_terms || []).map(cleanTerm).filter((x): x is string => Boolean(x));
  const derivedTerms = allTerms.length === 0 && anyTerms.length === 0
    ? deriveSweepTerms(input.query)
    : [];

  for (const term of allTerms) addRequiredTermClause(term);
  const groupedAnyTerms = anyTerms.length > 0 ? anyTerms : derivedTerms;
  if (groupedAnyTerms.length > 0) {
    const clauses: string[] = [];
    for (const term of groupedAnyTerms) {
      const cleaned = cleanTerm(term);
      if (!cleaned) continue;
      clauses.push(`(${searchable.map(expr => `${expr} LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < searchable.length; i++) binds.push(`%${cleaned}%`);
    }
    if (clauses.length > 0) where.push(`(${clauses.join(' OR ')})`);
  }

  const source = input.source === 'email' ? 'outlook' : input.source;
  if (source && source !== 'all') {
    where.push('c.source = ?');
    binds.push(source);
  }
  if (input.direction && input.direction !== 'all') {
    where.push('c.direction = ?');
    binds.push(input.direction);
  }
  if (input.start_date) {
    where.push('c.sent_at >= ?');
    binds.push(input.start_date);
  }
  if (input.end_date) {
    where.push('c.sent_at <= ?');
    binds.push(input.end_date);
  }
  if (!input.start_date && !input.end_date && input.days_back && input.days_back > 0) {
    const daysBack = Math.min(Math.max(input.days_back, 1), 3650);
    where.push(`c.sent_at >= datetime('now', '-${daysBack} days')`);
  }

  const fromEmails = (input.from_emails || []).map(normalizeEmail).filter((x): x is string => Boolean(x));
  if (fromEmails.length > 0) {
    where.push(`LOWER(c.from_email) IN (${fromEmails.map(() => '?').join(',')})`);
    binds.push(...fromEmails);
  }

  const participantEmails = (input.participant_emails || []).map(normalizeEmail).filter((x): x is string => Boolean(x));
  if (participantEmails.length > 0) {
    const clauses: string[] = [];
    for (const email of participantEmails) {
      clauses.push('(LOWER(c.from_email) = ? OR LOWER(c.to_emails) LIKE ? OR LOWER(c.cc_emails) LIKE ?)');
      binds.push(email, `%${email}%`, `%${email}%`);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  const limit = sweepLimit(input.limit, toolContext);
  const offset = Math.max(0, input.offset || 0);
  const fetchLimit = Math.min(
    limit * (toolContext.deepDive ? MAX_MODE_LIMITS.conversationOverfetchMultiplier : 2),
    toolContext.deepDive ? MAX_MODE_LIMITS.conversationFetchMax : 200
  );
  const whereClause = where.join(' AND ');

  const [rowsResult, countResult, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, c.subject, c.from_email, c.direction, c.source, c.sent_at,
              c.body_preview, c.body_r2_key, c.to_emails, c.cc_emails,
              c.participant_user_ids, c.is_campaign_email, c.external_message_id,
              sc.is_private AS slack_is_private,
              fc.full_name AS from_name
       FROM conversations c
       LEFT JOIN contacts fc ON c.from_contact_id = fc.id
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE ${whereClause}
       ORDER BY c.sent_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, fetchLimit, offset).all(),
    env.D1.prepare(`SELECT COUNT(*) AS total FROM conversations c WHERE ${whereClause}`)
      .bind(...binds).first<{ total: number }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const accessibleRows = (rowsResult.results as any[])
    .filter(c =>
      canReadConversationContent(
        {
          source: c.source,
          participant_user_ids: c.participant_user_ids,
          is_campaign_email: c.is_campaign_email,
          slack_is_private: c.slack_is_private,
        },
        ctx.userId,
        ctx.userRole,
        sharingFlags
      )
    );
  const accessible = accessibleRows.slice(0, limit);
  const rawCandidateCount = countResult?.total || 0;
  const canReportRawCandidateCount = hasOrgWidePrivateDataAccess(ctx.userRole);
  const hasMore = canReportRawCandidateCount
    ? rawCandidateCount > offset + fetchLimit || accessibleRows.length > limit
    : accessibleRows.length > limit || (rowsResult.results as any[]).length === fetchLimit;

  const conversationIds = accessible.map(c => c.id);
  const participantMap = new Map<string, Array<{ full_name: string; email?: string | null }>>();
  if (conversationIds.length > 0) {
    const ph = conversationIds.map(() => '?').join(',');
    const participants = await env.D1.prepare(
      `SELECT cc.conversation_id, ct.full_name, ct.email
       FROM conversation_contacts cc
       JOIN contacts ct ON cc.contact_id = ct.id
       WHERE cc.conversation_id IN (${ph})`
    ).bind(...conversationIds).all<{ conversation_id: string; full_name: string; email: string | null }>();
    for (const row of participants.results || []) {
      const list = participantMap.get(row.conversation_id) || [];
      list.push({ full_name: row.full_name, email: row.email });
      participantMap.set(row.conversation_id, list);
    }
  }

  const bodyFetchLimit = Math.min(
    Math.max(input.body_fetch_limit || 80, 0),
    toolContext.deepDive ? 200 : 40,
    accessible.length
  );
  if (input.include_body && bodyFetchLimit > 0) {
    await Promise.all(accessible.slice(0, bodyFetchLimit).map(async row => {
      if (!row.body_r2_key) return;
      try {
        const obj = await env.R2.get(row.body_r2_key);
        if (!obj) return;
        const body = await obj.text();
        row.body_preview = body.slice(0, 2000);
        if (body.length > 2000) row.body_preview += '...';
      } catch { /* keep existing preview */ }
    }));
  }

  const excludeDomains = new Set((input.exclude_domains || []).map(d => d.toLowerCase().replace(/^@/, '')));
  const recipientEntries = new Map<string, {
    email: string;
    display_name?: string;
    source_count: number;
    source_conversations: Array<{ id: string; subject?: string | null; date?: string; via: 'to' | 'cc' }>;
  }>();

  if (input.include_recipients) {
    for (const row of accessible) {
      const to = collectEmailEntries(row.to_emails).map(e => ({ ...e, via: 'to' as const }));
      const cc = collectEmailEntries(row.cc_emails).map(e => ({ ...e, via: 'cc' as const }));
      for (const entry of [...to, ...cc]) {
        const domain = entry.email.split('@')[1] || '';
        if (excludeDomains.has(domain)) continue;
        const existing = recipientEntries.get(entry.email) || {
          email: entry.email,
          display_name: entry.display_name,
          source_count: 0,
          source_conversations: [],
        };
        existing.source_count += 1;
        if (!existing.display_name && entry.display_name) existing.display_name = entry.display_name;
        if (existing.source_conversations.length < 8) {
          existing.source_conversations.push({
            id: row.id,
            subject: row.subject,
            date: row.sent_at,
            via: entry.via,
          });
        }
        recipientEntries.set(entry.email, existing);
      }
    }
  }

  const contactNames = input.include_recipients
    ? await lookupContactsByEmail(ctx.orgId, [...recipientEntries.keys()], env)
    : new Map<string, { full_name: string; company_name?: string | null }>();

  const recipients = [...recipientEntries.values()]
    .slice(0, MAX_MODE_LIMITS.recipientRollupMax)
    .map(entry => {
      const contact = contactNames.get(entry.email);
      const fullName = contact?.full_name || entry.display_name;
      return {
        email: entry.email,
        first_name: firstNameFrom(fullName, entry.email),
        full_name: fullName || null,
        company_name: contact?.company_name || null,
        source_count: entry.source_count,
        source_conversations: entry.source_conversations,
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));

  return {
    mode: toolContext.deepDive ? 'max' : 'normal',
    query_terms: {
      all_terms: allTerms,
      any_terms: groupedAnyTerms,
      derived_from_query: derivedTerms.length > 0,
    },
    filters: {
      source: source || 'all',
      direction: input.direction || 'all',
      from_emails: fromEmails,
      participant_emails: participantEmails,
      start_date: input.start_date || null,
      end_date: input.end_date || null,
      days_back: input.days_back || null,
    },
    candidate_count_matching_filters: canReportRawCandidateCount ? rawCandidateCount : undefined,
    returned_count: accessible.length,
    effective_limit: limit,
    offset,
    has_more: hasMore,
    body_fetch_limit: input.include_body ? bodyFetchLimit : 0,
    conversations: accessible.map(row => ({
      id: row.id,
      source: row.source,
      direction: row.direction,
      subject: row.subject,
      from_email: row.from_email,
      from_name: row.from_name,
      sent_at: row.sent_at,
      to_emails: collectEmailEntries(row.to_emails).map(e => e.email),
      cc_emails: collectEmailEntries(row.cc_emails).map(e => e.email),
      participants: participantMap.get(row.id) || [],
      body_excerpt: row.body_preview,
    })),
    recipient_rollup: input.include_recipients
      ? {
          unique_recipient_count: recipientEntries.size,
          returned_recipient_count: recipients.length,
          truncated: recipientEntries.size > recipients.length,
          recipients,
        }
      : undefined,
    note: input.include_recipients
      ? 'Recipient rollup is built from To/Cc fields stored on matching conversations. Bcc recipients are not available unless they were stored in source data.'
      : undefined,
  };
}

// ACL: returns entity-level CRM fields only (no email/conversation bodies).
// Per VC platform policy contacts are org-wide visible; the privacy boundary
// is conversation content, enforced by canReadEmailContent in tools that
// surface bodies. Owner role bypasses per existing helpers.ts policy.
export async function searchContacts(
  ctx: AuthContext,
  input: { keyword?: string; contact_type?: string; has_followup_overdue?: boolean; limit?: number },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const where: string[] = ['c.org_id = ?', 'c.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (input.keyword) {
    where.push('(c.full_name LIKE ? OR c.email LIKE ? OR co.name LIKE ?)');
    binds.push(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`);
  }
  if (input.contact_type) {
    where.push('c.contact_type = ?');
    binds.push(input.contact_type);
  }
  if (input.has_followup_overdue) {
    where.push("c.next_followup_date IS NOT NULL AND c.next_followup_date < strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  }

  const limit = structuredLimit(input.limit, toolContext);
  const result = await env.D1.prepare(
    `SELECT c.id, c.full_name, c.email, c.phone, c.contact_type, c.job_title,
            c.engagement_status, c.relationship_status, c.total_interactions,
            c.last_contact_date, c.next_followup_date, c.location,
            co.name AS company_name
     FROM contacts c
     LEFT JOIN companies co ON c.company_id = co.id
     WHERE ${where.join(' AND ')}
     ORDER BY c.last_contact_date DESC NULLS LAST
     LIMIT ?`
  ).bind(...binds, limit).all();

  const contacts = result.results as any[];
  if (contacts.length > 0) {
    const ids = contacts.map(c => c.id);
    const ph = ids.map(() => '?').join(',');
    const tagRows = await env.D1.prepare(
      `SELECT ct.contact_id, t.name, t.color FROM contact_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.contact_id IN (${ph})`
    ).bind(...ids).all();
    const tagMap = new Map<string, string[]>();
    for (const r of tagRows.results as any[]) {
      const arr = tagMap.get(r.contact_id) || [];
      arr.push(r.name);
      tagMap.set(r.contact_id, arr);
    }
    for (const c of contacts) c.tags = tagMap.get(c.id) || [];
  }

  return { contacts, count: contacts.length };
}

// ACL: entity-level CRM data only — see searchContacts comment.
export async function searchCompanies(
  ctx: AuthContext,
  input: { keyword?: string; company_type?: string; sector?: string; limit?: number },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  if (String(input.company_type || '').toLowerCase() === 'portfolio') {
    const snapshot = await loadFirmRelationshipSnapshot(ctx, env, {
      includePipeline: false,
      limit: input.limit,
    });
    const keyword = cleanTerm(input.keyword);
    const companies = snapshot.current_portfolio
      .filter(company => {
        if (!keyword) return true;
        return [company.name, company.domain, company.sector]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(keyword));
      })
      .map(company => ({
        id: company.id,
        name: company.name,
        domain: company.domain,
        website: company.website,
        sector: company.sector,
        company_type: company.company_type,
        investment_status: company.investment_status,
        current_valuation: company.current_valuation,
        firm_relationship_state: company.classification.state,
        firm_relationship_confidence: company.classification.confidence,
        firm_relationship_reasons: company.classification.reasons,
      }));
    return {
      companies,
      count: companies.length,
      note: 'company_type=portfolio is resolved through the authoritative firm relationship snapshot, not fuzzy CRM tags alone.',
      sources: snapshot.sources,
    };
  }

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (input.keyword) {
    where.push('(name LIKE ? OR domain LIKE ? OR description LIKE ?)');
    binds.push(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`);
  }
  if (input.company_type) {
    where.push('company_type = ?');
    binds.push(input.company_type);
  }
  if (input.sector) {
    where.push('sector LIKE ?');
    binds.push(`%${input.sector}%`);
  }

  const limit = structuredLimit(input.limit, toolContext);
  const result = await env.D1.prepare(
    `SELECT id, name, domain, website, sector, company_type, stage,
            investment_status, current_valuation, news_relevance_score,
            (SELECT COUNT(*) FROM contacts WHERE company_id = companies.id AND deleted_at IS NULL) AS contact_count,
            (SELECT COUNT(*) FROM deals WHERE company_id = companies.id AND deleted_at IS NULL) AS deal_count
     FROM companies WHERE ${where.join(' AND ')}
     ORDER BY name ASC LIMIT ?`
  ).bind(...binds, limit).all();

  return { companies: result.results, count: result.results.length };
}

export async function getFirmRelationshipSnapshotTool(
  ctx: AuthContext,
  input: { include_pipeline?: boolean; limit?: number },
  env: Env
): Promise<any> {
  const snapshot = await loadFirmRelationshipSnapshot(ctx, env, {
    includePipeline: input.include_pipeline !== false,
    limit: input.limit,
  });
  return {
    ...snapshot,
    note: 'Use current_portfolio as the authoritative current portfolio set. Do not infer portfolio membership from semantically related documents or pipeline companies.',
  };
}

export async function setFirmCompanyRelationshipTool(
  ctx: AuthContext,
  input: {
    company_id?: string;
    company_name?: string;
    relationship_state?: 'current_portfolio' | 'active_pipeline' | 'watchlist' | 'passed' | 'exited' | 'other';
    effective_date?: string;
    notes?: string;
    create_if_missing?: boolean;
  },
  env: Env
): Promise<any> {
  if (!input.company_id && !input.company_name) {
    return { error: 'COMPANY_REQUIRED', message: 'Provide company_id or company_name.' };
  }
  const result = await upsertFirmCompanyRelationship(ctx, env, {
    company_id: input.company_id || null,
    company_name: input.company_name || null,
    relationship_state: input.relationship_state || 'current_portfolio',
    effective_date: input.effective_date || null,
    notes: input.notes || null,
    create_if_missing: input.create_if_missing !== false,
  });
  try {
    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'update',
      entity_type: 'company',
      entity_id: result.company_id,
      after_data: {
        firm_relationship_state: result.relationship_state,
        company_name: result.company_name,
        created_company: result.created_company,
      },
      metadata: {
        origin: 'marty',
        subaction: 'set_firm_company_relationship',
        source: 'marty_user_assertion',
      },
      created_at: new Date().toISOString(),
    });
  } catch { /* best-effort */ }
  try { await updateEntityInIndex(ctx.orgId, 'company', result.company_id, env); } catch {}

  const snapshot = await loadFirmRelationshipSnapshot(ctx, env, { includePipeline: true });
  return {
    success: true,
    ...result,
    message: `${result.company_name} is now recorded as ${result.relationship_state}.`,
    snapshot_counts: snapshot.counts,
    sources: snapshot.sources,
  };
}

// ACL redaction: For non-owner users, fields derived from private conversation
// content (e.g., LLM-extracted topics_of_interest, deal notes) are nulled.
// See helpers.ts canReadEmailContent for the conversation-row equivalent.
export async function searchDeals(
  ctx: AuthContext,
  input: { keyword?: string; stage?: string; company_id?: string; limit?: number },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const where: string[] = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (input.keyword) {
    where.push('(d.title LIKE ? OR co.name LIKE ?)');
    binds.push(`%${input.keyword}%`, `%${input.keyword}%`);
  }
  if (input.stage) {
    where.push('d.stage = ?');
    binds.push(input.stage);
  }
  if (input.company_id) {
    where.push('d.company_id = ?');
    binds.push(input.company_id);
  }

  const limit = structuredLimit(input.limit, toolContext);
  const result = await env.D1.prepare(
    `SELECT d.id, d.title, d.stage, d.amount, d.currency, d.valuation,
            d.probability, d.expected_close, d.days_in_stage,
            d.our_allocation, d.instrument_type, d.lead_source,
            d.last_activity_date, d.notes,
            co.name AS company_name, co.sector AS company_sector,
            u.full_name AS owner_name
     FROM deals d
     LEFT JOIN companies co ON d.company_id = co.id
     LEFT JOIN users u ON d.owner_id = u.id
     WHERE ${where.join(' AND ')}
     ORDER BY d.expected_close ASC NULLS LAST LIMIT ?`
  ).bind(...binds, limit).all();

  const deals = (result.results as any[]).map(d =>
    redactSensitiveFields(d, ctx.userRole, 'deal')
  );

  return { deals, count: deals.length };
}

// recall — semantic retrieval tool exposed to MARTy for in-loop information
// gathering. Routes through preprocessQuery + retrieveContext + the citations
// hydrator, then optionally post-filters by source.type.
//
// Why a tool, when retrieveContext already runs pre-Claude in agent.ts:827?
//
// The pre-Claude run primes a single SOURCES list from the user's raw query.
// When that fails to surface a source type the user explicitly asked about
// (e.g. "summarize recent slack conversations" → broad query returns Slack-
// themed emails, secondary doc-type query under-ranked), MARTy is stuck —
// no way to retry with a different query phrasing or scope. This tool gives
// Claude the iterative ability the prompt now requires:
//   - Empty SOURCES for an asked-for type → call recall(query, source_types=[type])
//   - Need to dig deeper on a specific entity → call recall("entity name", ...)
//   - Cross-check before answering "no data" → call recall first
//
// Post-hydration filter on source.type is the structural-correctness lever:
// even if Vectorize metadata-index drift hides pre-2026-04-27 vectors from
// document_type-filtered queries, the broad query still returns chunks
// whose D1 source is 'slack' / 'firefly' etc., and the post-hydration
// filter rescues them. (Audit 2026-05-05 surfaced this drift class.)
function recallLog(stage: string, payload: Record<string, unknown>): void {
  try {
    console.log(`[recall:${stage}] ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[recall:${stage}] {"telemetry_error":"json_stringify_failed"}`);
  }
}

function countRecallDocTypes(chunks: Array<{ metadata?: Record<string, any> }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chunk of chunks) {
    const docType = String(chunk.metadata?.document_type || 'unknown');
    counts[docType] = (counts[docType] || 0) + 1;
  }
  return counts;
}

function countRecallSourceTypes(sources: Array<{ type?: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of sources) {
    const type = String(source.type || 'unknown');
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

export async function recall(
  ctx: AuthContext,
  input: {
    query: string;
    source_types?: Array<'email' | 'slack' | 'meeting' | 'document'>;
    limit?: number;
  },
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  if (!input.query || input.query.trim().length === 0) {
    return { sources: [], count: 0, message: 'recall: query is required' };
  }

  // Minimal AgentSession for preprocessQuery / retrieveContext. The retrieval
  // layer reads org_id, user_id, user_role; the rest is decorative. Synthesizing
  // here avoids requiring callers (the agent dispatcher) to thread the live
  // session through every tool call.
  const session: AgentSession = {
    id: `recall-${ctx.userId}-${Date.now()}`,
    org_id: ctx.orgId,
    user_id: ctx.userId,
    user_role: ctx.userRole,
    turn_count: 0,
    last_activity_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  // Map source_types (agent-facing: email|slack|meeting|document) to
  // document_type values (embedding metadata: email|conversation|transcript)
  // plus the document-family alias. Slack messages get ingested with document_type='conversation'
  // (daily-cron.ts:562-564); Firefly transcripts with document_type=
  // 'transcript' (process-transcript-items.ts:409). When source_types is
  // set, recall passes the mapped values via forceDocTypes — retrieveContext
  // then drives the targeted secondary Vectorize query for those types
  // regardless of detectDocTypes's keyword inspection of the query string.
  // (Audit 2026-05-05 stage-gate fail: TEST 1 broke because Claude called
  // recall with source_types=['slack'] but a query lacking 'slack' keyword;
  // detectDocTypes returned empty, no targeted query fired, broad query
  // dominated with email matches, post-filter on type='slack' empty.)
  const SOURCE_TYPE_TO_DOC_TYPE: Record<string, string> = {
    email: 'email',
    slack: 'conversation',
    meeting: 'transcript',
    document: 'document',
  };
  const forceDocTypes = (input.source_types || [])
    .map(t => SOURCE_TYPE_TO_DOC_TYPE[t])
    .filter((dt): dt is string => Boolean(dt));

  recallLog('start', {
    query: input.query.slice(0, 80),
    source_types: input.source_types || null,
    force_doc_types: forceDocTypes,
    limit: input.limit ?? null,
  });

  const pq = await preprocessQuery(input.query, session, env, { deepDive: !!toolContext.deepDive });
  const result = await retrieveContext(pq, env, {
    deepDive: !!toolContext.deepDive,
    forceDocTypes: forceDocTypes.length > 0 ? forceDocTypes : undefined,
  });

  const { sources } = await buildSourcesAndContext(
    result.internal,
    result.news,
    undefined,
    ctx.orgId,
    env,
    input.query,
    { deepDive: !!toolContext.deepDive }
  );

  // Post-hydration source-type filter — applied AFTER D1 enrichment
  // (citations.ts maps row.source='slack' → source.type='slack'), so it
  // bypasses any Vectorize metadata-index drift that would have hidden
  // chunks from a document_type-filtered query. This is the structural
  // immunity property the audit identified.
  let filtered = sources;
  if (input.source_types && input.source_types.length > 0) {
    const wanted = new Set(input.source_types);
    filtered = sources.filter(s => wanted.has(s.type as any));
  }

  const defaultLimit = toolContext.deepDive
    ? MAX_MODE_LIMITS.recallDefault
    : NORMAL_MODE_LIMITS.recallDefault;
  const maxLimit = toolContext.deepDive
    ? MAX_MODE_LIMITS.recallMax
    : NORMAL_MODE_LIMITS.recallMax;
  const limit = Math.min(Math.max(input.limit ?? defaultLimit, 1), maxLimit);
  const trimmed = filtered.slice(0, limit);
  const sourceTypeCountsAfterFilter = countRecallSourceTypes(filtered);
  const sourceTypeCountsBeforeFilter = countRecallSourceTypes(sources);
  const internalDocTypeCounts = countRecallDocTypes(result.internal);
  recallLog('result', {
    query: input.query.slice(0, 80),
    source_types: input.source_types || null,
    force_doc_types: forceDocTypes,
    internal_count: result.internal.length,
    internal_doc_type_counts: internalDocTypeCounts,
    news_count: result.news.length,
    sources_before_filter_count: sources.length,
    source_type_counts_before_filter: sourceTypeCountsBeforeFilter,
    sources_after_filter_count: filtered.length,
    source_type_counts_after_filter: sourceTypeCountsAfterFilter,
    trimmed_count: trimmed.length,
    limit,
    max_mode: !!toolContext.deepDive,
  });

  return {
    count: trimmed.length,
    coverage: {
      mode: toolContext.deepDive ? 'max' : 'normal',
      total_matched: filtered.length,
      returned_count: trimmed.length,
      requested_limit: input.limit ?? null,
      effective_limit: limit,
      filtered_by_source_type: !!(input.source_types && input.source_types.length > 0),
      source_type_counts_before_filter: sourceTypeCountsBeforeFilter,
      source_type_counts_after_filter: sourceTypeCountsAfterFilter,
      internal_doc_type_counts: internalDocTypeCounts,
      news_count: result.news.length,
    },
    current_date: new Date().toISOString(),
    timeline_note: 'Dates are source dates. Relative phrases in excerpts such as "next week", "currently", "today", or "now" are relative to each source date, not the current date.',
    sources: trimmed.map(s => ({
      id: s.id,
      type: s.type,
      source_table: s.source_table,
      source_id: s.source_id,
      entity_id: s.entity_id,
      title: s.title,
      subtitle: s.subtitle,
      date: s.date,
      url_path: s.url_path,
      external_url: s.external_url,
      excerpt: s.excerpt,
      citation_marker: `[^${s.id}]`,
    })),
    note: filtered.length > limit
      ? `Showing top ${limit} of ${filtered.length} matches.`
      : undefined,
  };
}

// ACL redaction: For non-owner users, contact-level fields derived from
// private conversation content (LLM-extracted topics_of_interest, pain_points,
// investment_thesis_tags, manual next_followup_note, raw-data R2 keys) are
// nulled. recent_conversations is row-filtered via canReadEmailContent —
// strictly more secure than nulling body_preview alone, since the existence
// + subject of a private email is also sensitive. Owner role bypasses both.
export async function getContactDetail(
  ctx: AuthContext,
  contactId: string,
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const contactRow = await env.D1.prepare(
    `SELECT c.*, co.name AS company_name
     FROM contacts c LEFT JOIN companies co ON c.company_id = co.id
     WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(contactId, ctx.orgId).first();
  if (!contactRow) return { error: 'Contact not found' };
  const contact = redactSensitiveFields(contactRow as Record<string, any>, ctx.userRole, 'contact');

  const [tags, recentConvosRaw, deals, associations, sharingFlags] = await Promise.all([
    env.D1.prepare(
      'SELECT t.id, t.name, t.color FROM contact_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.contact_id = ?'
    ).bind(contactId).all(),
    env.D1.prepare(
      `SELECT c.id, c.subject, c.sent_at, c.source, c.direction, c.sentiment, c.body_preview,
              c.participant_user_ids, c.is_campaign_email, c.external_message_id,
              sc.is_private AS slack_is_private
       FROM conversations c
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
       WHERE c.from_contact_id = ? AND c.org_id = ?
       ORDER BY sent_at DESC LIMIT ?`
    ).bind(
      contactId,
      ctx.orgId,
      toolContext.deepDive
        ? MAX_MODE_LIMITS.contactDetailConversationFetch
        : 20
    ).all(),
    env.D1.prepare(
      `SELECT d.id, d.title, d.stage, d.amount, d.valuation, dc.role, dc.side
       FROM deal_contacts dc JOIN deals d ON dc.deal_id = d.id
       WHERE dc.contact_id = ? AND d.deleted_at IS NULL`
    ).bind(contactId).all(),
    env.D1.prepare(
      `SELECT ea.*, CASE
         WHEN ea.entity_a_type = 'contact' AND ea.entity_a_id = ? THEN ea.entity_b_type
         ELSE ea.entity_a_type END AS related_type,
       CASE
         WHEN ea.entity_a_type = 'contact' AND ea.entity_a_id = ? THEN ea.entity_b_id
         ELSE ea.entity_a_id END AS related_id
       FROM entity_associations ea
       WHERE (ea.entity_a_type = 'contact' AND ea.entity_a_id = ?) OR (ea.entity_b_type = 'contact' AND ea.entity_b_id = ?)`
    ).bind(contactId, contactId, contactId, contactId).all(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const recentConvos = (recentConvosRaw.results as any[])
    .filter(c =>
      canReadConversationContent(
        {
          source: c.source,
          participant_user_ids: c.participant_user_ids,
          is_campaign_email: c.is_campaign_email,
          slack_is_private: c.slack_is_private,
        },
        ctx.userId,
        ctx.userRole,
        sharingFlags
      )
    )
    .slice(0, toolContext.deepDive ? MAX_MODE_LIMITS.contactDetailConversationReturn : 10);

  for (const c of recentConvos) {
    delete c.participant_user_ids;
    delete c.is_campaign_email;
    delete c.external_message_id;
    delete c.slack_is_private;
  }

  return {
    contact,
    tags: tags.results,
    recent_conversations: recentConvos,
    deals: deals.results,
    associations: associations.results,
  };
}

// ACL: entity-level CRM data only — see searchContacts comment.
export async function getCompanyDetail(
  ctx: AuthContext,
  companyId: string,
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const company = await env.D1.prepare(
    'SELECT * FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(companyId, ctx.orgId).first();
  if (!company) return { error: 'Company not found' };

  const [contacts, deals, tags, news, firmSnapshot] = await Promise.all([
    env.D1.prepare(
      `SELECT id, full_name, email, job_title, contact_type, last_contact_date, total_interactions
       FROM contacts WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
       ORDER BY total_interactions DESC LIMIT ?`
    ).bind(companyId, ctx.orgId, toolContext.deepDive ? MAX_MODE_LIMITS.relatedEntityReturn : 20).all(),
    toolContext.deepDive
      ? env.D1.prepare(
          `SELECT id, title, stage, amount, valuation, probability, expected_close, days_in_stage
           FROM deals WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC LIMIT ?`
        ).bind(companyId, ctx.orgId, MAX_MODE_LIMITS.relatedEntityReturn).all()
      : env.D1.prepare(
          `SELECT id, title, stage, amount, valuation, probability, expected_close, days_in_stage
           FROM deals WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC`
        ).bind(companyId, ctx.orgId).all(),
    env.D1.prepare(
      'SELECT t.id, t.name, t.color FROM company_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.company_id = ?'
    ).bind(companyId).all(),
    env.D1.prepare(
      `SELECT id, title, source, published_at, summary, relevance_tag, relevance_score
       FROM news_articles
       WHERE company_id = ?
       ORDER BY CASE WHEN relevance_tag = 'direct_mention' THEN 0 ELSE 1 END,
                published_at DESC
       LIMIT ?`
    ).bind(companyId, toolContext.deepDive ? MAX_MODE_LIMITS.ragV1NewsReturn : 10).all().catch(() => ({ results: [] })),
    loadFirmRelationshipSnapshot(ctx, env, { includePipeline: true, limit: 1000 }).catch(() => null),
  ]);
  const firmRelationship = firmSnapshot
    ? [
        ...firmSnapshot.current_portfolio,
        ...firmSnapshot.active_pipeline,
        ...firmSnapshot.watchlist,
        ...firmSnapshot.passed,
        ...firmSnapshot.exited,
        ...firmSnapshot.unknown,
      ].find(c => c.id === companyId)?.classification || null
    : null;

  return {
    company,
    firm_relationship: firmRelationship,
    contacts: contacts.results,
    deals: deals.results,
    tags: tags.results,
    news: news.results,
  };
}

// ACL redaction: For non-owner users, deal-level fields derived from private
// conversation content (auto-populated `notes` evidence, LLM-derived
// `thesis_fit`, raw-memo R2 key) are nulled. The user-authored deal_notes
// and deal_action_items sub-arrays remain visible — they're explicit human
// entries, not auto-extracted summaries (revisit in a follow-up if needed).
// Owner role bypasses.
export async function getDealDetail(
  ctx: AuthContext,
  dealId: string,
  env: Env,
  toolContext: AgentToolContext = {}
): Promise<any> {
  const dealRow = await env.D1.prepare(
    `SELECT d.*, co.name AS company_name, co.sector AS company_sector, u.full_name AS owner_name
     FROM deals d
     LEFT JOIN companies co ON d.company_id = co.id
     LEFT JOIN users u ON d.owner_id = u.id
     WHERE d.id = ? AND d.org_id = ? AND d.deleted_at IS NULL`
  ).bind(dealId, ctx.orgId).first();
  if (!dealRow) return { error: 'Deal not found' };
  const deal = redactSensitiveFields(dealRow as Record<string, any>, ctx.userRole, 'deal');

  const [contacts, actionItems, notes] = await Promise.all([
    env.D1.prepare(
      `SELECT dc.role, dc.side, c.id, c.full_name, c.email, c.job_title
       FROM deal_contacts dc JOIN contacts c ON dc.contact_id = c.id
       WHERE dc.deal_id = ?`
    ).bind(dealId).all(),
    env.D1.prepare(
      `SELECT id, description, status, assignee_id, due_date, created_at
       FROM deal_action_items WHERE deal_id = ? ORDER BY created_at DESC`
    ).bind(dealId).all(),
    env.D1.prepare(
      `SELECT id, content, author_id, created_at
       FROM deal_notes WHERE deal_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(dealId, toolContext.deepDive ? MAX_MODE_LIMITS.detailNotesReturn : 10).all(),
  ]);

  return {
    deal,
    contacts: contacts.results,
    action_items: actionItems.results,
    notes: notes.results,
  };
}

// ---------------------------------------------------------------------------
// WRITE TOOLS
// ---------------------------------------------------------------------------

export async function createContactTool(
  ctx: AuthContext,
  input: {
    full_name: string; email?: string; phone?: string;
    contact_type?: string; company_name?: string; job_title?: string;
    linkedin_url?: string; notes?: string;
  },
  env: Env
): Promise<any> {
  // MARTy-side conveniences kept at the tool layer (entity-writes
  // takes structured input; dedup + company-name → company-id
  // resolution is tool ergonomics, not a write-path concern).
  let companyId: string | null = null;
  if (input.company_name) {
    const existingCompany = await findDuplicateCompany(input.company_name, null, ctx.orgId, env);
    if (existingCompany) {
      companyId = existingCompany;
    } else {
      // Auto-create a placeholder company for the contact's
      // affiliation. Routes through createCompanyRecord so the new
      // company gets the same audit + invalidation hooks.
      const created = await createCompanyRecord(
        { name: input.company_name, company_type: 'other' },
        { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
        env
      );
      if (created.ok && created.id) {
        companyId = created.id;
        try { await updateEntityInIndex(ctx.orgId, 'company', companyId, env); } catch {}
      }
    }
  }

  const normalizedEmail = input.email?.toLowerCase().trim() || null;

  // Dedup by email — return existing without creating.
  if (normalizedEmail) {
    const byEmail = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(ctx.orgId, normalizedEmail).first<{ id: string }>();
    if (byEmail) {
      return { success: true, contact_id: byEmail.id, message: `Contact "${input.full_name}" already exists`, deduplicated: true };
    }
  }
  // Dedup by name + company when no email provided.
  if (!normalizedEmail && companyId) {
    const byNameCompany = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(full_name) = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(ctx.orgId, input.full_name.trim().toLowerCase(), companyId).first<{ id: string }>();
    if (byNameCompany) {
      return { success: true, contact_id: byNameCompany.id, message: `Contact "${input.full_name}" already exists`, deduplicated: true };
    }
  }

  // Actual write through entity-writes — same audit + invalidation as
  // manual UI create.
  const result = await createContactRecord(
    {
      full_name: input.full_name,
      email: normalizedEmail,
      phone: input.phone || null,
      linkedin_url: input.linkedin_url || null,
      contact_type: input.contact_type || null,
      company_id: companyId,
      job_title: input.job_title || null,
      bio_summary: input.notes || null,
    },
    { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
    env
  );
  if (!result.ok || !result.id) {
    return { error: result.error?.message || 'Failed to create contact', code: result.error?.code };
  }
  try { await updateEntityInIndex(ctx.orgId, 'contact', result.id, env); } catch {}
  return { success: true, contact_id: result.id, message: `Created contact "${input.full_name}"` };
}

export async function updateContactTool(
  ctx: AuthContext,
  input: { contact_id: string; fields: Record<string, any> },
  env: Env
): Promise<any> {
  // Routes through src/lib/entity-writes.ts so MARTy writes get the
  // same lock checks (permanent_lock, 180-day human-edit lock with
  // same-user exception), the same entity_field_state state-sync, and
  // the same audit row shape that manual UI edits get. origin='marty'
  // tags the write in the audit metadata.
  const wctx: WriteContext = {
    orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty',
  };
  const result = await updateContactFields(input.contact_id, input.fields, wctx, env);
  if (!result.ok && result.error) {
    return { error: result.error.message, code: result.error.code };
  }
  const appliedFields = Object.keys(result.applied);
  // Compose a MARTy-readable confirmation. Surface per-field
  // rejections so the agent can narrate "I updated X but couldn't
  // change Y because…" — locked spec for clear refusal patterns.
  const lines: string[] = [];
  if (appliedFields.length > 0) {
    const after = (result.after as any) || {};
    lines.push(`Updated ${appliedFields.join(', ')} on "${after.full_name || input.contact_id}".`);
  }
  if (result.rejected.length > 0) {
    for (const r of result.rejected) {
      lines.push(`Could not update ${r.field_name}: ${r.detail || r.reason}.`);
    }
  }
  if (lines.length === 0) lines.push('No fields needed updating (all values already match).');
  return {
    success: appliedFields.length > 0 || result.rejected.length === 0,
    message: lines.join(' '),
    applied: result.applied,
    rejected: result.rejected,
  };
}

export async function createCompanyTool(
  ctx: AuthContext,
  input: { name: string; domain?: string; website?: string; sector?: string; company_type?: string; location?: string; description?: string },
  env: Env
): Promise<any> {
  const domain = input.domain || (input.website
    ? input.website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim()
    : null);

  const existing = await findDuplicateCompany(input.name, domain, ctx.orgId, env);
  if (existing) {
    return { success: true, company_id: existing, message: `Company "${input.name}" already exists`, deduplicated: true };
  }

  const result = await createCompanyRecord(
    {
      name: input.name,
      domain: domain || null,
      website: input.website || null,
      description: input.description || null,
      sector: input.sector || null,
      company_type: input.company_type || 'other',
    },
    { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
    env
  );
  if (!result.ok || !result.id) {
    return { error: result.error?.message || 'Failed to create company', code: result.error?.code };
  }
  try { await updateEntityInIndex(ctx.orgId, 'company', result.id, env); } catch {}
  return { success: true, company_id: result.id, message: `Created company "${input.name}"` };
}

export async function updateCompanyTool(
  ctx: AuthContext,
  input: { company_id: string; fields: Record<string, any> },
  env: Env
): Promise<any> {
  const wctx: WriteContext = {
    orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty',
  };
  const result = await updateCompanyFields(input.company_id, input.fields, wctx, env);
  if (!result.ok && result.error) {
    return { error: result.error.message, code: result.error.code };
  }
  const appliedFields = Object.keys(result.applied);
  const after = (result.after as any) || {};
  const lines: string[] = [];
  if (appliedFields.length > 0) {
    lines.push(`Updated ${appliedFields.join(', ')} on "${after.name || input.company_id}".`);
  }
  for (const r of result.rejected) {
    lines.push(`Could not update ${r.field_name}: ${r.detail || r.reason}.`);
  }
  if (lines.length === 0) lines.push('No fields needed updating (all values already match).');
  return {
    success: appliedFields.length > 0 || result.rejected.length === 0,
    message: lines.join(' '),
    applied: result.applied,
    rejected: result.rejected,
  };
}

export async function createDealTool(
  ctx: AuthContext,
  input: {
    title: string; company_name?: string; company_id?: string;
    stage?: string; amount?: number; valuation?: number;
    description?: string; expected_close?: string;
  },
  env: Env
): Promise<any> {
  // Tool-layer convenience: resolve company_name → company_id.
  let companyId = input.company_id || null;
  if (!companyId && input.company_name) {
    const existing = await env.D1.prepare(
      'SELECT id FROM companies WHERE org_id = ? AND name LIKE ? AND deleted_at IS NULL LIMIT 1'
    ).bind(ctx.orgId, input.company_name).first<{ id: string }>();
    if (existing) companyId = existing.id;
  }
  if (!companyId) return { error: 'company_id or company_name matching an existing company is required' };

  // createDealRecord handles Wave 1 (assertExternalCompanyForDeal) +
  // Wave 2 (assertNoOpenDealForCompany) guards inline; embed-deal too.
  const result = await createDealRecord(
    {
      company_id: companyId,
      title: input.title,
      stage: input.stage || 'prospect',
      amount: input.amount ?? null,
      valuation: input.valuation ?? null,
      notes: input.description || null,
      expected_close: input.expected_close || null,
    },
    { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
    env
  );
  if (!result.ok || !result.id) {
    return { error: result.error?.message || 'Failed to create deal', code: result.error?.code };
  }
  return { success: true, deal_id: result.id, message: `Created deal "${input.title}"` };
}

export async function updateDealTool(
  ctx: AuthContext,
  input: { deal_id: string; fields: Record<string, any> },
  env: Env
): Promise<any> {
  const wctx: WriteContext = {
    orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty',
  };
  const result = await updateDealFields(input.deal_id, input.fields, wctx, env);
  if (!result.ok && result.error) {
    return { error: result.error.message, code: result.error.code };
  }
  const appliedFields = Object.keys(result.applied);
  const after = (result.after as any) || {};
  const lines: string[] = [];
  if (appliedFields.length > 0) {
    lines.push(`Updated ${appliedFields.join(', ')} on "${after.title || input.deal_id}".`);
  }
  for (const r of result.rejected) {
    lines.push(`Could not update ${r.field_name}: ${r.detail || r.reason}.`);
  }
  if (lines.length === 0) lines.push('No fields needed updating (all values already match).');
  // last_activity_date bump — same as the manual UI handler does after
  // updateDealFields. Keeps deal cards sorted by recency.
  await env.D1.prepare(
    `UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(input.deal_id).run();
  return {
    success: appliedFields.length > 0 || result.rejected.length === 0,
    message: lines.join(' '),
    applied: result.applied,
    rejected: result.rejected,
  };
}

export async function addNoteTool(
  orgId: string,
  userId: string,
  input: { entity_type: string; entity_id: string; content: string },
  env: Env
): Promise<any> {
  if (input.entity_type === 'deal') {
    const deal = await env.D1.prepare(
      'SELECT id, title FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
    ).bind(input.entity_id, orgId).first<{ id: string; title: string }>();
    if (!deal) return { error: 'Deal not found' };

    const noteId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.D1.prepare(
      'INSERT INTO deal_notes (id, org_id, deal_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(noteId, orgId, input.entity_id, userId, input.content, now, now).run();

    await env.D1.prepare(
      "UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).bind(input.entity_id).run();

    return { success: true, note_id: noteId, message: `Note added to deal "${deal.title}"` };
  }

  if (input.entity_type === 'contact') {
    const contact = await env.D1.prepare(
      'SELECT id, full_name, bio_summary FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
    ).bind(input.entity_id, orgId).first<{ id: string; full_name: string; bio_summary: string | null }>();
    if (!contact) return { error: 'Contact not found' };

    const existing = contact.bio_summary || '';
    const separator = existing ? '\n\n---\n\n' : '';
    const updated = existing + separator + `[${new Date().toISOString().slice(0, 10)}] ${input.content}`;

    await env.D1.prepare(
      "UPDATE contacts SET bio_summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).bind(updated, input.entity_id).run();

    return { success: true, message: `Note added to contact "${contact.full_name}"` };
  }

  return { error: `Unsupported entity type: ${input.entity_type}. Use "deal" or "contact".` };
}

export async function addDealActionItemTool(
  orgId: string,
  userId: string,
  input: { deal_id: string; description: string; assignee_id?: string; due_date?: string },
  env: Env
): Promise<any> {
  const deal = await env.D1.prepare(
    'SELECT id, title FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(input.deal_id, orgId).first<{ id: string; title: string }>();
  if (!deal) return { error: 'Deal not found' };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deal_action_items (id, deal_id, description, status, assignee_id, due_date, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`
  ).bind(id, input.deal_id, input.description, input.assignee_id || null, input.due_date || null, now, now).run();

  await env.D1.prepare(
    "UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).bind(input.deal_id).run();

  return { success: true, action_item_id: id, message: `Action item added to deal "${deal.title}": ${input.description}` };
}

export async function applyTagTool(
  orgId: string,
  input: { entity_type: string; entity_id: string; tag_name: string },
  env: Env
): Promise<any> {
  const entityType = input.entity_type === 'company' ? 'company' : 'contact';

  let tag = await env.D1.prepare(
    'SELECT id, name FROM tags WHERE org_id = ? AND name = ? AND entity_type = ?'
  ).bind(orgId, input.tag_name, entityType).first<{ id: string; name: string }>();

  if (!tag) {
    const tagId = crypto.randomUUID();
    const colors = ['#D946A8', '#3B82F6', '#22C55E', '#F59E0B', '#EF4444', '#8B5CF6'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    await env.D1.prepare(
      "INSERT INTO tags (id, org_id, name, color, entity_type, created_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    ).bind(tagId, orgId, input.tag_name, color, entityType).run();
    tag = { id: tagId, name: input.tag_name };
  }

  const table = entityType === 'company' ? 'company_tags' : 'contact_tags';
  const fkCol = entityType === 'company' ? 'company_id' : 'contact_id';

  const exists = await env.D1.prepare(
    `SELECT 1 FROM ${table} WHERE ${fkCol} = ? AND tag_id = ?`
  ).bind(input.entity_id, tag.id).first();

  if (!exists) {
    await env.D1.prepare(
      `INSERT INTO ${table} (${fkCol}, tag_id) VALUES (?, ?)`
    ).bind(input.entity_id, tag.id).run();
  }

  return { success: true, message: `Tagged ${entityType} with "${tag.name}"` };
}

export async function deleteEntityTool(
  orgId: string,
  userId: string,
  input: { entity_type: string; entity_id: string; confirmed?: boolean },
  env: Env
): Promise<any> {
  if (!input.confirmed) {
    let name = '';
    if (input.entity_type === 'contact') {
      const c = await env.D1.prepare('SELECT full_name FROM contacts WHERE id = ? AND org_id = ?').bind(input.entity_id, orgId).first<{ full_name: string }>();
      name = c?.full_name || input.entity_id;
    } else if (input.entity_type === 'company') {
      const c = await env.D1.prepare('SELECT name FROM companies WHERE id = ? AND org_id = ?').bind(input.entity_id, orgId).first<{ name: string }>();
      name = c?.name || input.entity_id;
    } else if (input.entity_type === 'deal') {
      const d = await env.D1.prepare('SELECT title FROM deals WHERE id = ? AND org_id = ?').bind(input.entity_id, orgId).first<{ title: string }>();
      name = d?.title || input.entity_id;
    }

    return {
      requires_confirmation: true,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      entity_name: name,
      message: `Are you sure you want to delete ${input.entity_type} "${name}"? This action cannot be undone. Please confirm.`,
    };
  }

  const now = new Date().toISOString();
  const table = input.entity_type === 'contact' ? 'contacts' : input.entity_type === 'company' ? 'companies' : 'deals';

  await env.D1.prepare(
    `UPDATE ${table} SET deleted_at = ? WHERE id = ? AND org_id = ?`
  ).bind(now, input.entity_id, orgId).run();

  const auditEntityType = input.entity_type as 'contact' | 'company' | 'deal';
  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'soft_delete',
    entity_type: auditEntityType, entity_id: input.entity_id,
    after_data: { deleted: true, source: 'manual' },
    created_at: now,
  });
  await invalidateRagCache(orgId, env);

  return { success: true, message: `Deleted ${input.entity_type} "${input.entity_id}"` };
}

// ────────────────────────────────────────────────────────────────────
// Phase 2 — additional MARTy write tools
// ────────────────────────────────────────────────────────────────────

// Field deletions — set the entity column to NULL. User explicitly
// asked via natural-language ("clear Tony's email") so this is direct
// (no held-proposal queue). Routes through entity-writes.ts which
// performs the lock-check and uses recordApprovalOfDeletion for the
// entity_field_state side. Confirms back to MARTy what got cleared
// (or what got refused, with the reason).

export async function deleteContactFieldTool(
  ctx: AuthContext,
  input: { contact_id: string; field_name: string },
  env: Env
): Promise<any> {
  const result = await deleteEntityField(
    'contact', input.contact_id, input.field_name,
    { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
    env
  );
  if (!result.ok && result.error) {
    return { error: result.error.message, code: result.error.code };
  }
  if (result.applied[input.field_name] === null) {
    const after = (result.after as any) || {};
    return { success: true, message: `Cleared ${input.field_name} on "${after.full_name || input.contact_id}".` };
  }
  return { success: true, message: `${input.field_name} was already empty — nothing to clear.` };
}

export async function deleteCompanyFieldTool(
  ctx: AuthContext,
  input: { company_id: string; field_name: string },
  env: Env
): Promise<any> {
  const result = await deleteEntityField(
    'company', input.company_id, input.field_name,
    { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
    env
  );
  if (!result.ok && result.error) return { error: result.error.message, code: result.error.code };
  const after = (result.after as any) || {};
  return result.applied[input.field_name] === null
    ? { success: true, message: `Cleared ${input.field_name} on "${after.name || input.company_id}".` }
    : { success: true, message: `${input.field_name} was already empty.` };
}

export async function deleteDealFieldTool(
  ctx: AuthContext,
  input: { deal_id: string; field_name: string },
  env: Env
): Promise<any> {
  const result = await deleteEntityField(
    'deal', input.deal_id, input.field_name,
    { orgId: ctx.orgId, userId: ctx.userId, userRole: ctx.userRole, origin: 'marty' },
    env
  );
  if (!result.ok && result.error) return { error: result.error.message, code: result.error.code };
  const after = (result.after as any) || {};
  return result.applied[input.field_name] === null
    ? { success: true, message: `Cleared ${input.field_name} on "${after.title || input.deal_id}".` }
    : { success: true, message: `${input.field_name} was already empty.` };
}

// Conversation/event ↔ deal linkage. Uses the conversation_deals /
// event_deals junctions from T1's Phase B (migration 0071). MARTy-
// driven links land with source='manual' so they take precedence over
// auto/inherited links in fetchDealConversations and trigger
// invalidateDealIntelligence (linkConversationToDeal does this).

async function verifyDealInOrg(dealId: string, orgId: string, env: Env): Promise<boolean> {
  const row = await env.D1.prepare(
    'SELECT 1 FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(dealId, orgId).first();
  return !!row;
}

async function verifyConversationInOrg(conversationId: string, orgId: string, env: Env): Promise<boolean> {
  const row = await env.D1.prepare(
    'SELECT 1 FROM conversations WHERE id = ? AND org_id = ? LIMIT 1'
  ).bind(conversationId, orgId).first();
  return !!row;
}

async function verifyEventInOrg(eventId: string, orgId: string, env: Env): Promise<boolean> {
  const row = await env.D1.prepare(
    'SELECT 1 FROM events WHERE id = ? AND org_id = ? LIMIT 1'
  ).bind(eventId, orgId).first();
  return !!row;
}

export async function linkConversationToDealTool(
  ctx: AuthContext,
  input: { conversation_id: string; deal_id: string },
  env: Env
): Promise<any> {
  if (!(await verifyConversationInOrg(input.conversation_id, ctx.orgId, env))) {
    return { error: 'Conversation not found in your org' };
  }
  if (!(await verifyDealInOrg(input.deal_id, ctx.orgId, env))) {
    return { error: 'Deal not found in your org' };
  }
  const result = await linkConversationToDeal(
    input.conversation_id, input.deal_id,
    'manual', 1.0, ctx.orgId, env, ctx.userId
  );
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: { conversation_id: input.conversation_id, source: 'manual' },
    metadata: { origin: 'marty', subaction: 'link_conversation' },
    created_at: new Date().toISOString(),
  });
  return result.inserted
    ? { success: true, message: `Linked conversation to deal.` }
    : { success: true, message: `Conversation was already linked to this deal.`, deduplicated: true };
}

export async function linkEventToDealTool(
  ctx: AuthContext,
  input: { event_id: string; deal_id: string },
  env: Env
): Promise<any> {
  if (!(await verifyEventInOrg(input.event_id, ctx.orgId, env))) {
    return { error: 'Event not found in your org' };
  }
  if (!(await verifyDealInOrg(input.deal_id, ctx.orgId, env))) {
    return { error: 'Deal not found in your org' };
  }
  const result = await linkEventToDeal(
    input.event_id, input.deal_id,
    'manual', 1.0, ctx.orgId, env, ctx.userId
  );
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: { event_id: input.event_id, source: 'manual' },
    metadata: { origin: 'marty', subaction: 'link_event' },
    created_at: new Date().toISOString(),
  });
  return result.inserted
    ? { success: true, message: `Linked meeting to deal.` }
    : { success: true, message: `Meeting was already linked to this deal.`, deduplicated: true };
}

export async function unlinkConversationFromDealTool(
  ctx: AuthContext,
  input: { conversation_id: string; deal_id: string },
  env: Env
): Promise<any> {
  if (!(await verifyDealInOrg(input.deal_id, ctx.orgId, env))) {
    return { error: 'Deal not found in your org' };
  }
  const result = await env.D1.prepare(
    'DELETE FROM conversation_deals WHERE conversation_id = ? AND deal_id = ?'
  ).bind(input.conversation_id, input.deal_id).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return { success: true, message: `Conversation was not linked to this deal.` };
  }
  // Invalidate deal_intelligence — fewer linked conversations may
  // shift sentiment/topics. Mirrors the link path's invalidation
  // (deal-association.ts's internal invalidateDealIntelligence — not
  // exported there; inlined here so we don't reach into module privates).
  try {
    await env.D1.prepare(
      `UPDATE deal_intelligence
          SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE deal_id = ? AND user_id IN (
          SELECT id FROM users WHERE org_id = ? AND deleted_at IS NULL
        )`
    ).bind(input.deal_id, ctx.orgId).run();
  } catch { /* best-effort */ }
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: { conversation_id: input.conversation_id },
    metadata: { origin: 'marty', subaction: 'unlink_conversation' },
    created_at: new Date().toISOString(),
  });
  return { success: true, message: `Unlinked conversation from deal.` };
}

export async function unlinkEventFromDealTool(
  ctx: AuthContext,
  input: { event_id: string; deal_id: string },
  env: Env
): Promise<any> {
  if (!(await verifyDealInOrg(input.deal_id, ctx.orgId, env))) {
    return { error: 'Deal not found in your org' };
  }
  const result = await env.D1.prepare(
    'DELETE FROM event_deals WHERE event_id = ? AND deal_id = ?'
  ).bind(input.event_id, input.deal_id).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return { success: true, message: `Meeting was not linked to this deal.` };
  }
  // Invalidate deal_intelligence (mirrors the conversation-unlink path
  // — invalidateDealIntelligence isn't exported from deal-association.ts).
  try {
    await env.D1.prepare(
      `UPDATE deal_intelligence
          SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE deal_id = ? AND user_id IN (
          SELECT id FROM users WHERE org_id = ? AND deleted_at IS NULL
        )`
    ).bind(input.deal_id, ctx.orgId).run();
  } catch { /* best-effort */ }
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: { event_id: input.event_id },
    metadata: { origin: 'marty', subaction: 'unlink_event' },
    created_at: new Date().toISOString(),
  });
  return { success: true, message: `Unlinked meeting from deal.` };
}

// Contact ↔ deal membership. deal_contacts is the canonical "who's
// involved in this deal" table. side = 'us' | 'them' (the existing
// addDealContact handler validates this); role is freeform.

export async function addContactToDealTool(
  ctx: AuthContext,
  input: { deal_id: string; contact_id: string; role?: string; side?: 'us' | 'them' },
  env: Env
): Promise<any> {
  if (!(await verifyDealInOrg(input.deal_id, ctx.orgId, env))) {
    return { error: 'Deal not found in your org' };
  }
  const contact = await env.D1.prepare(
    'SELECT id, full_name FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(input.contact_id, ctx.orgId).first<{ id: string; full_name: string }>();
  if (!contact) return { error: 'Contact not found in your org' };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, ctx.orgId, input.deal_id, input.contact_id,
    input.role || null, input.side || 'them', now
  ).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return { success: true, message: `${contact.full_name} is already linked to this deal.`, deduplicated: true };
  }
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: { contact_id: input.contact_id, role: input.role, side: input.side || 'them' },
    metadata: { origin: 'marty', subaction: 'add_contact' },
    created_at: now,
  });
  return { success: true, message: `Added ${contact.full_name} to the deal.` };
}

export async function removeContactFromDealTool(
  ctx: AuthContext,
  input: { deal_id: string; contact_id: string },
  env: Env
): Promise<any> {
  if (!(await verifyDealInOrg(input.deal_id, ctx.orgId, env))) {
    return { error: 'Deal not found in your org' };
  }
  const result = await env.D1.prepare(
    'DELETE FROM deal_contacts WHERE deal_id = ? AND contact_id = ? AND org_id = ?'
  ).bind(input.deal_id, input.contact_id, ctx.orgId).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return { success: true, message: `Contact was not linked to this deal.` };
  }
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: { contact_id: input.contact_id },
    metadata: { origin: 'marty', subaction: 'remove_contact' },
    created_at: new Date().toISOString(),
  });
  return { success: true, message: `Removed contact from deal.` };
}

// Observation + held-proposal + field-lock tools — wrap the existing
// handler functions from Q11/Q12 wave + Wave 6 UX. MARTy can dismiss
// noise observations, accept/reject held proposals, and lock fields
// without the user opening Settings.

export async function dismissObservationTool(
  ctx: AuthContext,
  input: { observation_id: string },
  env: Env
): Promise<any> {
  const { dismissObservation } = await import('./synthetic-observations');
  const result = await dismissObservation(input.observation_id, ctx.userId, ctx.orgId, env);
  return result.ok
    ? { success: true, message: 'Observation dismissed.' }
    : { error: 'Observation not found or already dismissed' };
}

export async function approveHeldProposalTool(
  ctx: AuthContext,
  input: {
    entity_type: 'contact' | 'company' | 'deal';
    entity_id: string;
    field_name: string;
    value?: string;
    is_deletion?: boolean;
  },
  env: Env
): Promise<any> {
  // Reuse the existing approval.ts logic by reproducing its body via
  // the same helpers — recordApproval / recordApprovalOfDeletion.
  // Lock check IS performed (via the entity table read inside
  // checkFieldWritability) since the held-approval is a human edit
  // and gets stamped as one. Behaviorally equivalent to the user
  // clicking Approve in the held-proposals UI.
  const { recordApproval, recordApprovalOfDeletion } = await import('./proposal-evaluator');
  const { invalidateRagCache } = await import('./cache');
  const tableMap: Record<string, string> = { contact: 'contacts', company: 'companies', deal: 'deals' };
  const table = tableMap[input.entity_type];
  if (!table) return { error: 'invalid entity_type' };
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(input.entity_id, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) return { error: 'Entity not in your org' };
  if (input.is_deletion === true) {
    await env.D1.prepare(
      `UPDATE ${table} SET ${input.field_name} = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(input.entity_id).run();
    await recordApprovalOfDeletion({
      orgId: ctx.orgId, entityType: input.entity_type,
      entityId: input.entity_id, fieldName: input.field_name, userId: ctx.userId,
    }, env);
    await invalidateRagCache(ctx.orgId, env);
    return { success: true, message: `Cleared ${input.field_name} (held deletion approved).` };
  }
  if (input.value === undefined) {
    return { error: 'value required when is_deletion is not true' };
  }
  await env.D1.prepare(
    `UPDATE ${table} SET ${input.field_name} = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(input.value, input.entity_id).run();
  await recordApproval({
    orgId: ctx.orgId, entityType: input.entity_type,
    entityId: input.entity_id, fieldName: input.field_name,
    approvedValue: input.value, userId: ctx.userId,
  }, env);
  await invalidateRagCache(ctx.orgId, env);
  return { success: true, message: `Approved held value for ${input.field_name}.` };
}

export async function dismissHeldProposalTool(
  ctx: AuthContext,
  input: {
    entity_type: 'contact' | 'company' | 'deal';
    entity_id: string;
    field_name: string;
    value?: string;
    is_deletion?: boolean;
  },
  env: Env
): Promise<any> {
  const { recordRejection } = await import('./proposal-evaluator');
  const tableMap: Record<string, string> = { contact: 'contacts', company: 'companies', deal: 'deals' };
  const table = tableMap[input.entity_type];
  if (!table) return { error: 'invalid entity_type' };
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(input.entity_id, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) return { error: 'Entity not in your org' };
  await recordRejection({
    orgId: ctx.orgId, entityType: input.entity_type,
    entityId: input.entity_id, fieldName: input.field_name,
    rejectedValue: input.value ?? '',
    isDeletion: input.is_deletion === true,
  }, env);
  return {
    success: true,
    message: input.is_deletion === true
      ? `Dismissed held deletion of ${input.field_name} (90-day no-re-ask).`
      : `Dismissed held value for ${input.field_name} (90-day no-re-ask).`,
  };
}

export async function lockFieldPermanentlyTool(
  ctx: AuthContext,
  input: { entity_type: 'contact' | 'company' | 'deal'; entity_id: string; field_name: string },
  env: Env
): Promise<any> {
  return setFieldLockHelper(ctx, input.entity_type, input.entity_id, input.field_name, true, env);
}

export async function unlockFieldTool(
  ctx: AuthContext,
  input: { entity_type: 'contact' | 'company' | 'deal'; entity_id: string; field_name: string },
  env: Env
): Promise<any> {
  return setFieldLockHelper(ctx, input.entity_type, input.entity_id, input.field_name, false, env);
}

async function setFieldLockHelper(
  ctx: AuthContext,
  entityType: 'contact' | 'company' | 'deal',
  entityId: string,
  fieldName: string,
  locked: boolean,
  env: Env
): Promise<any> {
  if (ctx.userRole !== 'owner') return { error: 'Owner role required to lock/unlock fields.' };
  const tableMap: Record<string, string> = { contact: 'contacts', company: 'companies', deal: 'deals' };
  const table = tableMap[entityType];
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(entityId, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) return { error: 'Entity not in your org' };
  const existing = await env.D1.prepare(
    `SELECT id FROM entity_field_state WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(entityType, entityId, fieldName).first<{ id: string }>();
  if (existing) {
    await env.D1.prepare(
      `UPDATE entity_field_state SET permanently_locked = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(locked ? 1 : 0, existing.id).run();
  } else {
    // Cold path — seed from entity table.
    const liveRow = await env.D1.prepare(
      `SELECT ${fieldName} as v FROM ${table} WHERE id = ?`
    ).bind(entityId).first<{ v: unknown }>().catch(() => null);
    const currentValue = liveRow?.v == null ? null
      : typeof liveRow.v === 'string' ? liveRow.v
      : String(liveRow.v);
    const sources = currentValue && currentValue.trim() !== '' ? '["historical_unknown"]' : '[]';
    await env.D1.prepare(
      `INSERT INTO entity_field_state
         (entity_type, entity_id, field_name, current_value,
          current_value_sources, permanently_locked)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(entityType, entityId, fieldName, currentValue, sources, locked ? 1 : 0).run();
  }
  await emitAudit(env, {
    org_id: ctx.orgId, user_id: ctx.userId, action: 'update',
    entity_type: entityType, entity_id: entityId,
    after_data: { field: fieldName, permanently_locked: locked },
    metadata: { origin: 'marty', source: 'field_lock_toggle' },
    created_at: new Date().toISOString(),
  });
  return {
    success: true,
    message: locked
      ? `Locked ${fieldName} on ${entityType} from automated proposals.`
      : `Unlocked ${fieldName} on ${entityType} (automated proposals can resume).`,
  };
}

export const __agentToolsTestHooks = {
  deriveEventKeywordTerms,
  cleanEventText,
};

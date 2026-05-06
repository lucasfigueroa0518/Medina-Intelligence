import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';
import { findDuplicateCompany } from './discovery';
import { updateEntityInIndex } from './entity-index';
import { canReadEmailContent, getSharingFlags } from './helpers';
import { isCompanyInternal, assertNoOpenDealForCompany, OpenDealConflictError } from './internal-entity';
import {
  updateContactFields, updateCompanyFields, updateDealFields,
  deleteEntityField,
  createContactRecord, createCompanyRecord, createDealRecord,
  type WriteContext,
} from './entity-writes';
import { linkConversationToDeal, linkEventToDeal } from './deal-association';
import { preprocessQuery, retrieveContext } from './retrieval';
import { buildSourcesAndContext } from './citations';

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
  if (userRole === 'owner') return entity;
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
  env: Env
): Promise<any> {
  const where: string[] = ['c.org_id = ?'];
  const binds: unknown[] = [ctx.orgId];

  if (input.source && input.source !== 'all') {
    where.push('c.source = ?');
    binds.push(input.source);
  }

  if (input.direction && input.direction !== 'all') {
    where.push('c.direction = ?');
    binds.push(input.direction);
  }

  const daysBack = input.days_back || 30;
  where.push(`c.sent_at >= datetime('now', '-${Math.min(daysBack, 365)} days')`);

  if (input.contact_id) {
    where.push(
      `(c.from_contact_id = ? OR c.id IN (SELECT conversation_id FROM conversation_contacts WHERE contact_id = ?))`
    );
    binds.push(input.contact_id, input.contact_id);
  }

  if (input.keyword) {
    where.push('(c.subject LIKE ? OR c.body_preview LIKE ? OR c.from_email LIKE ?)');
    binds.push(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`);
  }

  const limit = Math.min(input.limit || 20, 50);
  // Over-fetch so post-filter list still approximates `limit`. Capped at 100
  // to keep the work bounded when most rows are visible to the requester.
  const fetchLimit = Math.min(limit * 2, 100);

  const [result, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, c.subject, c.from_email, c.direction, c.source, c.sent_at,
              c.body_preview, c.body_r2_key, c.sentiment, c.topics, c.action_items,
              c.to_emails, c.cc_emails, c.from_contact_id,
              c.participant_user_ids, c.is_campaign_email,
              fc.full_name AS from_name
       FROM conversations c
       LEFT JOIN contacts fc ON c.from_contact_id = fc.id
       WHERE ${where.join(' AND ')}
       ORDER BY c.sent_at DESC
       LIMIT ?`
    ).bind(...binds, fetchLimit).all(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const conversations = (result.results as any[])
    .filter(c =>
      canReadEmailContent(
        {
          source: c.source,
          participant_user_ids: c.participant_user_ids,
          is_campaign_email: c.is_campaign_email,
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

// ACL: returns entity-level CRM fields only (no email/conversation bodies).
// Per VC platform policy contacts are org-wide visible; the privacy boundary
// is conversation content, enforced by canReadEmailContent in tools that
// surface bodies. Owner role bypasses per existing helpers.ts policy.
export async function searchContacts(
  ctx: AuthContext,
  input: { keyword?: string; contact_type?: string; has_followup_overdue?: boolean; limit?: number },
  env: Env
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

  const limit = Math.min(input.limit || 20, 50);
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
  env: Env
): Promise<any> {
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

  const limit = Math.min(input.limit || 20, 50);
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

// ACL redaction: For non-owner users, fields derived from private conversation
// content (e.g., LLM-extracted topics_of_interest, deal notes) are nulled.
// See helpers.ts canReadEmailContent for the conversation-row equivalent.
export async function searchDeals(
  ctx: AuthContext,
  input: { keyword?: string; stage?: string; company_id?: string; limit?: number },
  env: Env
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

  const limit = Math.min(input.limit || 20, 50);
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
  env: Env
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
  // document_type values (embedding metadata: email|conversation|transcript
  // |document). Slack messages get ingested with document_type='conversation'
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

  const pq = await preprocessQuery(input.query, session, env, {});
  const result = await retrieveContext(pq, env, {
    forceDocTypes: forceDocTypes.length > 0 ? forceDocTypes : undefined,
  });

  const { sources } = await buildSourcesAndContext(
    result.internal,
    result.news,
    undefined,
    ctx.orgId,
    env,
    input.query
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

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const trimmed = filtered.slice(0, limit);
  recallLog('result', {
    query: input.query.slice(0, 80),
    source_types: input.source_types || null,
    force_doc_types: forceDocTypes,
    internal_count: result.internal.length,
    internal_doc_type_counts: countRecallDocTypes(result.internal),
    news_count: result.news.length,
    sources_before_filter_count: sources.length,
    source_type_counts_before_filter: countRecallSourceTypes(sources),
    sources_after_filter_count: filtered.length,
    source_type_counts_after_filter: countRecallSourceTypes(filtered),
    trimmed_count: trimmed.length,
    limit,
  });

  return {
    count: trimmed.length,
    sources: trimmed.map(s => ({
      type: s.type,
      title: s.title,
      subtitle: s.subtitle,
      date: s.date,
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
  env: Env
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
      `SELECT id, subject, sent_at, source, direction, sentiment, body_preview,
              participant_user_ids, is_campaign_email
       FROM conversations WHERE from_contact_id = ? AND org_id = ?
       ORDER BY sent_at DESC LIMIT 20`
    ).bind(contactId, ctx.orgId).all(),
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
      canReadEmailContent(
        {
          source: c.source,
          participant_user_ids: c.participant_user_ids,
          is_campaign_email: c.is_campaign_email,
        },
        ctx.userId,
        ctx.userRole,
        sharingFlags
      )
    )
    .slice(0, 10);

  for (const c of recentConvos) {
    delete c.participant_user_ids;
    delete c.is_campaign_email;
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
  env: Env
): Promise<any> {
  const company = await env.D1.prepare(
    'SELECT * FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(companyId, ctx.orgId).first();
  if (!company) return { error: 'Company not found' };

  const [contacts, deals, tags, news] = await Promise.all([
    env.D1.prepare(
      `SELECT id, full_name, email, job_title, contact_type, last_contact_date, total_interactions
       FROM contacts WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
       ORDER BY total_interactions DESC LIMIT 20`
    ).bind(companyId, ctx.orgId).all(),
    env.D1.prepare(
      `SELECT id, title, stage, amount, valuation, probability, expected_close, days_in_stage
       FROM deals WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`
    ).bind(companyId, ctx.orgId).all(),
    env.D1.prepare(
      'SELECT t.id, t.name, t.color FROM company_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.company_id = ?'
    ).bind(companyId).all(),
    env.D1.prepare(
      `SELECT id, title, source, published_at, summary, relevance_score
       FROM news_articles WHERE company_id = ? ORDER BY published_at DESC LIMIT 10`
    ).bind(companyId).all().catch(() => ({ results: [] })),
  ]);

  return {
    company,
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
  env: Env
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
       FROM deal_notes WHERE deal_id = ? ORDER BY created_at DESC LIMIT 10`
    ).bind(dealId).all(),
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

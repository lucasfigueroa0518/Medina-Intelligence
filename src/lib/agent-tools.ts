import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';
import { findDuplicateCompany } from './discovery';
import { updateEntityInIndex } from './entity-index';
import { canReadEmailContent, getSharingFlags } from './helpers';

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

// ACL: entity-level CRM data only — see searchContacts comment.
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

  return { deals: result.results, count: result.results.length };
}

// ACL: recent_conversations is filtered to rows the requesting user can read
// per canReadEmailContent. Owner role bypasses per existing helpers.ts policy.
// Other fields (contact, tags, deals, associations) are entity-level CRM data
// and remain org-wide visible.
export async function getContactDetail(
  ctx: AuthContext,
  contactId: string,
  env: Env
): Promise<any> {
  const contact = await env.D1.prepare(
    `SELECT c.*, co.name AS company_name
     FROM contacts c LEFT JOIN companies co ON c.company_id = co.id
     WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(contactId, ctx.orgId).first();
  if (!contact) return { error: 'Contact not found' };

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

// ACL: entity-level CRM data only — see searchContacts comment.
export async function getDealDetail(
  ctx: AuthContext,
  dealId: string,
  env: Env
): Promise<any> {
  const deal = await env.D1.prepare(
    `SELECT d.*, co.name AS company_name, co.sector AS company_sector, u.full_name AS owner_name
     FROM deals d
     LEFT JOIN companies co ON d.company_id = co.id
     LEFT JOIN users u ON d.owner_id = u.id
     WHERE d.id = ? AND d.org_id = ? AND d.deleted_at IS NULL`
  ).bind(dealId, ctx.orgId).first();
  if (!deal) return { error: 'Deal not found' };

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
  orgId: string,
  userId: string,
  input: {
    full_name: string; email?: string; phone?: string;
    contact_type?: string; company_name?: string; job_title?: string;
    linkedin_url?: string; notes?: string;
  },
  env: Env
): Promise<any> {
  let companyId: string | null = null;
  if (input.company_name) {
    const existingCompany = await findDuplicateCompany(input.company_name, null, orgId, env);
    if (existingCompany) {
      companyId = existingCompany;
    } else {
      companyId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.D1.prepare(
        `INSERT INTO companies (id, org_id, name, company_type, created_at, updated_at)
         VALUES (?, ?, ?, 'other', ?, ?)`
      ).bind(companyId, orgId, input.company_name, now, now).run();
      try { await updateEntityInIndex(orgId, 'company', companyId, env); } catch {}
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const contactType = input.contact_type || 'individual';
  const normalizedEmail = input.email?.toLowerCase().trim() || null;

  // Dedup by email
  if (normalizedEmail) {
    const byEmail = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, normalizedEmail).first<{ id: string }>();
    if (byEmail) {
      return { success: true, contact_id: byEmail.id, message: `Contact "${input.full_name}" already exists`, deduplicated: true };
    }
  }

  // Dedup by name + company when no email provided
  if (!normalizedEmail && companyId) {
    const byNameCompany = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(full_name) = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, input.full_name.trim().toLowerCase(), companyId).first<{ id: string }>();
    if (byNameCompany) {
      return { success: true, contact_id: byNameCompany.id, message: `Contact "${input.full_name}" already exists`, deduplicated: true };
    }
  }

  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO contacts
       (id, org_id, full_name, email, phone, linkedin_url, contact_type,
        company_id, job_title, bio_summary, source, source_confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1.0, ?, ?)`
  ).bind(
    id, orgId, input.full_name.trim(),
    normalizedEmail,
    input.phone || null, input.linkedin_url || null,
    contactType, companyId, input.job_title || null,
    input.notes || null, now, now
  ).run();

  if (!result.meta?.changes) {
    const raced = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, normalizedEmail || '').first<{ id: string }>();
    if (raced) return { success: true, contact_id: raced.id, message: `Contact "${input.full_name}" already exists`, deduplicated: true };
    return { error: 'Failed to create contact' };
  }

  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'create',
    entity_type: 'contact', entity_id: id,
    after_data: { id, full_name: input.full_name, source: 'manual' },
    created_at: now,
  });
  try { await updateEntityInIndex(orgId, 'contact', id, env); } catch {}
  await invalidateRagCache(orgId, env);

  return { success: true, contact_id: id, message: `Created contact "${input.full_name}"` };
}

export async function updateContactTool(
  orgId: string,
  userId: string,
  input: { contact_id: string; fields: Record<string, any> },
  env: Env
): Promise<any> {
  const contact = await env.D1.prepare(
    'SELECT id, full_name FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(input.contact_id, orgId).first<{ id: string; full_name: string }>();
  if (!contact) return { error: 'Contact not found' };

  const allowed = new Set([
    'full_name', 'email', 'phone', 'linkedin_url', 'contact_type', 'job_title',
    'bio_summary', 'company_id', 'relationship_status', 'engagement_status',
    'next_followup_date', 'topics_of_interest', 'pain_points', 'location',
    'investment_focus', 'check_size_range', 'communication_channel_preference',
  ]);

  const updates: string[] = [];
  const binds: unknown[] = [];
  const changedFields: string[] = [];

  for (const [key, value] of Object.entries(input.fields)) {
    if (!allowed.has(key)) continue;
    updates.push(`${key} = ?`);
    binds.push(value);
    changedFields.push(key);
  }

  if (updates.length === 0) return { error: 'No valid fields to update' };

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  binds.push(input.contact_id, orgId);

  await env.D1.prepare(
    `UPDATE contacts SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`
  ).bind(...binds).run();

  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'update',
    entity_type: 'contact', entity_id: input.contact_id,
    after_data: input.fields,
    created_at: new Date().toISOString(),
  });
  await invalidateRagCache(orgId, env);

  return { success: true, message: `Updated ${changedFields.join(', ')} on "${contact.full_name}"` };
}

export async function createCompanyTool(
  orgId: string,
  userId: string,
  input: { name: string; domain?: string; website?: string; sector?: string; company_type?: string; location?: string; description?: string },
  env: Env
): Promise<any> {
  const domain = input.domain || (input.website
    ? input.website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim()
    : null);

  const existing = await findDuplicateCompany(input.name, domain, orgId, env);
  if (existing) {
    return { success: true, company_id: existing, message: `Company "${input.name}" already exists`, deduplicated: true };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies (id, org_id, name, domain, website, sector, company_type, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, orgId, input.name.trim(),
    domain || null, input.website || null,
    input.sector || null, input.company_type || 'other',
    input.description || null, now, now
  ).run();

  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'create',
    entity_type: 'company', entity_id: id,
    after_data: { id, name: input.name, source: 'manual' },
    created_at: now,
  });
  try { await updateEntityInIndex(orgId, 'company', id, env); } catch {}
  await invalidateRagCache(orgId, env);

  return { success: true, company_id: id, message: `Created company "${input.name}"` };
}

export async function updateCompanyTool(
  orgId: string,
  userId: string,
  input: { company_id: string; fields: Record<string, any> },
  env: Env
): Promise<any> {
  const company = await env.D1.prepare(
    'SELECT id, name FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(input.company_id, orgId).first<{ id: string; name: string }>();
  if (!company) return { error: 'Company not found' };

  const allowed = new Set([
    'name', 'domain', 'website', 'sector', 'company_type',
    'description', 'stage', 'investment_status', 'current_valuation',
  ]);

  const updates: string[] = [];
  const binds: unknown[] = [];
  const changedFields: string[] = [];

  for (const [key, value] of Object.entries(input.fields)) {
    if (!allowed.has(key)) continue;
    updates.push(`${key} = ?`);
    binds.push(value);
    changedFields.push(key);
  }

  if (updates.length === 0) return { error: 'No valid fields to update' };

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  binds.push(input.company_id, orgId);

  await env.D1.prepare(
    `UPDATE companies SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`
  ).bind(...binds).run();

  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'update',
    entity_type: 'company', entity_id: input.company_id,
    after_data: input.fields,
    created_at: new Date().toISOString(),
  });
  await invalidateRagCache(orgId, env);

  return { success: true, message: `Updated ${changedFields.join(', ')} on "${company.name}"` };
}

export async function createDealTool(
  orgId: string,
  userId: string,
  input: {
    title: string; company_name?: string; company_id?: string;
    stage?: string; amount?: number; valuation?: number;
    description?: string; expected_close?: string;
  },
  env: Env
): Promise<any> {
  let companyId = input.company_id || null;
  if (!companyId && input.company_name) {
    const existing = await env.D1.prepare(
      'SELECT id FROM companies WHERE org_id = ? AND name LIKE ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, input.company_name).first<{ id: string }>();
    if (existing) companyId = existing.id;
  }
  if (!companyId) return { error: 'company_id or company_name matching an existing company is required' };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const stage = input.stage || 'prospect';

  await env.D1.prepare(
    `INSERT INTO deals
       (id, org_id, company_id, owner_id, title, stage, amount, currency,
        valuation, notes, probability,
        stage_changed_at, last_activity_date, days_in_stage,
        expected_close, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, 0, ?, ?, 0, ?, ?, ?)`
  ).bind(
    id, orgId, companyId, userId, input.title.trim(),
    stage, input.amount ?? null, input.valuation ?? null,
    input.description || null, now, now,
    input.expected_close || null, now, now
  ).run();

  const sourceMetadata: Record<string, any> = {};
  if (input.stage) sourceMetadata.stage = { source: 'manual', set_by: userId, set_at: now };
  if (input.amount) sourceMetadata.amount = { source: 'manual', set_by: userId, set_at: now };
  if (Object.keys(sourceMetadata).length > 0) {
    await env.D1.prepare('UPDATE deals SET source_metadata = ? WHERE id = ?')
      .bind(JSON.stringify(sourceMetadata), id).run();
  }

  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'create',
    entity_type: 'deal', entity_id: id,
    after_data: { id, title: input.title, stage, source: 'manual' },
    created_at: now,
  });
  await invalidateRagCache(orgId, env);

  return { success: true, deal_id: id, message: `Created deal "${input.title}"` };
}

export async function updateDealTool(
  orgId: string,
  userId: string,
  input: { deal_id: string; fields: Record<string, any> },
  env: Env
): Promise<any> {
  const deal = await env.D1.prepare(
    'SELECT id, title, stage FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(input.deal_id, orgId).first<{ id: string; title: string; stage: string }>();
  if (!deal) return { error: 'Deal not found' };

  const allowed = new Set([
    'title', 'stage', 'amount', 'valuation', 'probability', 'expected_close',
    'notes', 'our_allocation', 'instrument_type', 'lead_source', 'thesis_fit', 'currency',
  ]);

  const updates: string[] = [];
  const binds: unknown[] = [];
  const changedFields: string[] = [];

  for (const [key, value] of Object.entries(input.fields)) {
    if (!allowed.has(key)) continue;
    updates.push(`${key} = ?`);
    binds.push(value);
    changedFields.push(key);
  }

  if (updates.length === 0) return { error: 'No valid fields to update' };

  if (input.fields.stage && input.fields.stage !== deal.stage) {
    updates.push("stage_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    updates.push('days_in_stage = 0');
  }
  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  updates.push("last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  binds.push(input.deal_id, orgId);

  await env.D1.prepare(
    `UPDATE deals SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`
  ).bind(...binds).run();

  await emitAudit(env, {
    org_id: orgId, user_id: userId, action: 'update',
    entity_type: 'deal', entity_id: input.deal_id,
    after_data: input.fields,
    created_at: new Date().toISOString(),
  });
  await invalidateRagCache(orgId, env);

  return { success: true, message: `Updated ${changedFields.join(', ')} on "${deal.title}"` };
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

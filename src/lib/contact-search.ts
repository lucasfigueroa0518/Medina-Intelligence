import type { Env } from '../types/env';

const MAX_SEARCH_TERMS = 8;

export interface ContactSearchQuery {
  raw: string;
  normalized: string;
  terms: string[];
  ftsMatch: string;
  prefix: string;
  contains: string;
}

interface ContactIndexRow {
  id: string;
  org_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  job_title: string | null;
  bio_summary: string | null;
  custom_fields: string | null;
  updated_at: string | null;
  created_at: string | null;
  resolved_company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
}

export function normalizeContactSearchText(input: string | null | undefined): string {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractContactSearchTerms(input: string | null | undefined): string[] {
  const normalized = normalizeContactSearchText(input);
  if (!normalized) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of normalized.match(/[a-z0-9]+/g) || []) {
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms;
}

export function buildContactSearchQuery(input: string | null | undefined): ContactSearchQuery | null {
  const normalized = normalizeContactSearchText(input);
  const terms = extractContactSearchTerms(normalized);
  if (terms.length === 0) return null;
  return {
    raw: String(input || ''),
    normalized,
    terms,
    ftsMatch: terms.map(term => `${term}*`).join(' AND '),
    prefix: `${normalized}%`,
    contains: `%${normalized}%`,
  };
}

export function contactSearchRankSql(): string {
  return `
    CASE
      WHEN lower(f.email) = ? THEN 0
      WHEN lower(f.full_name) = ? THEN 1
      WHEN lower(f.email) LIKE ? THEN 2
      WHEN lower(f.email_local) LIKE ? THEN 2
      WHEN lower(f.full_name) LIKE ? THEN 3
      WHEN lower(f.company_name) LIKE ? THEN 5
      WHEN lower(f.company_domain) LIKE ? THEN 5
      ELSE 10
    END
  `;
}

export function contactSearchRankBinds(query: ContactSearchQuery): unknown[] {
  return [
    query.normalized,
    query.normalized,
    query.prefix,
    query.prefix,
    query.prefix,
    query.contains,
    query.contains,
  ];
}

export function contactSearchCteSql(): string {
  return `
    WITH matched AS (
      SELECT
        f.contact_id,
        ${contactSearchRankSql()} AS search_rank,
        bm25(contact_search_fts, 8.0, 6.0, 4.0, 1.0, 1.0, 3.0, 5.0, 5.0, 2.0, 1.0, 1.0, 3.0) AS fts_rank
      FROM contact_search_fts f
      WHERE contact_search_fts MATCH ?
        AND f.org_id = ?
    )
  `;
}

export function contactSearchCteBinds(query: ContactSearchQuery, orgId: string): unknown[] {
  return [...contactSearchRankBinds(query), query.ftsMatch, orgId];
}

function emailLocalPart(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeDomainForEmailMatch(value: string | null | undefined): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const host = raw
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
  return normalizeContactSearchText(host).replace(/\s+/g, '');
}

async function contactTagsText(env: Env, contactId: string): Promise<string> {
  const rows = await env.D1.prepare(
    `SELECT t.name
       FROM contact_tags ct
       JOIN tags t ON t.id = ct.tag_id
      WHERE ct.contact_id = ?
      ORDER BY t.name COLLATE NOCASE ASC`
  ).bind(contactId).all<{ name: string }>();
  return rows.results.map(row => row.name).filter(Boolean).join(' ');
}

async function loadContactIndexRow(env: Env, orgId: string, contactId: string): Promise<ContactIndexRow | null> {
  return await env.D1.prepare(
    `SELECT
        c.id,
        c.org_id,
        c.full_name,
        c.email,
        c.phone,
        c.linkedin_url,
        c.job_title,
        c.bio_summary,
        c.custom_fields,
        c.updated_at,
        c.created_at,
        COALESCE(co.id, ico.id) AS resolved_company_id,
        COALESCE(co.name, ico.name) AS company_name,
        COALESCE(co.domain, ico.domain) AS company_domain
       FROM contacts c
       LEFT JOIN companies co
         ON co.id = c.company_id
        AND co.org_id = c.org_id
        AND co.deleted_at IS NULL
        AND co.merged_into IS NULL
       LEFT JOIN companies ico
         ON ico.id = (
           SELECT sco.id
             FROM companies sco
            WHERE sco.org_id = c.org_id
              AND sco.deleted_at IS NULL
              AND sco.merged_into IS NULL
              AND sco.domain IS NOT NULL
              AND sco.domain != ''
              AND c.email IS NOT NULL
              AND (
                lower(c.email) LIKE '%@' || lower(sco.domain)
                OR lower(c.email) LIKE '%@%.' || lower(sco.domain)
              )
            ORDER BY length(sco.domain) DESC
            LIMIT 1
         )
      WHERE c.id = ?
        AND c.org_id = ?
        AND c.deleted_at IS NULL
        AND c.merged_into IS NULL`
  ).bind(contactId, orgId).first<ContactIndexRow>();
}

export async function recordContactSearchIndexRepair(
  env: Env,
  orgId: string,
  args: { contactId?: string | null; reason: string; error?: unknown; metadata?: Record<string, unknown> }
): Promise<void> {
  const contactId = args.contactId || '';
  const lastError = args.error instanceof Error ? args.error.message : args.error ? String(args.error) : null;
  try {
    await env.D1.prepare(
      `INSERT INTO contact_search_index_repairs
         (org_id, contact_id, reason, status, last_error, metadata, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(org_id, contact_id, reason) DO UPDATE SET
         status = 'pending',
         last_error = excluded.last_error,
         metadata = excluded.metadata,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(
      orgId,
      contactId,
      args.reason,
      lastError,
      JSON.stringify(args.metadata || {})
    ).run();
  } catch (repairError) {
    console.error('[contact-search] failed to record repair', {
      orgId,
      contactId,
      reason: args.reason,
      error: repairError instanceof Error ? repairError.message : String(repairError),
    });
  }
}

export async function deleteContactSearchIndexForContact(env: Env, contactId: string): Promise<void> {
  await env.D1.prepare('DELETE FROM contact_search_fts WHERE contact_id = ?').bind(contactId).run();
}

export async function safelyDeleteContactSearchIndexForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  try {
    await deleteContactSearchIndexForContact(env, contactId);
  } catch (error) {
    await recordContactSearchIndexRepair(env, orgId, {
      contactId,
      reason: 'delete_failed',
      error,
    });
  }
}

export async function rebuildContactSearchIndexForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  const row = await loadContactIndexRow(env, orgId, contactId);
  if (!row) {
    await deleteContactSearchIndexForContact(env, contactId);
    return;
  }

  const tags = await contactTagsText(env, contactId);
  const exactTerms = [
    row.full_name,
    row.email,
    emailLocalPart(row.email),
    row.company_name,
    row.company_domain,
    tags,
  ].map(value => normalizeContactSearchText(value)).filter(Boolean).join(' ');

  await env.D1.batch([
    env.D1.prepare('DELETE FROM contact_search_fts WHERE contact_id = ?').bind(contactId),
    env.D1.prepare(
      `INSERT INTO contact_search_fts
         (contact_id, org_id, company_id, full_name, email, email_local, phone,
          linkedin_url, job_title, company_name, company_domain, tags,
          bio_summary, custom_fields, exact_terms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id,
      row.org_id,
      row.resolved_company_id,
      row.full_name || '',
      row.email || '',
      emailLocalPart(row.email),
      row.phone || '',
      row.linkedin_url || '',
      row.job_title || '',
      row.company_name || '',
      row.company_domain || '',
      tags,
      row.bio_summary || '',
      asText(row.custom_fields),
      exactTerms,
      row.updated_at || row.created_at || new Date().toISOString()
    ),
  ]);
}

export async function safelyRebuildContactSearchIndexForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  try {
    await rebuildContactSearchIndexForContact(env, orgId, contactId);
  } catch (error) {
    await recordContactSearchIndexRepair(env, orgId, {
      contactId,
      reason: 'upsert_failed',
      error,
    });
  }
}

export async function rebuildContactSearchIndexForCompany(
  env: Env,
  orgId: string,
  companyId: string,
  extraDomain?: string | null
): Promise<{ scanned: number; rebuilt: number }> {
  const company = await env.D1.prepare(
    `SELECT id, domain FROM companies WHERE id = ? AND org_id = ?`
  ).bind(companyId, orgId).first<{ id: string; domain: string | null }>();

  const domains = [company?.domain, extraDomain]
    .map(domain => normalizeDomainForEmailMatch(domain))
    .filter((domain): domain is string => !!domain);
  const uniqueDomains = Array.from(new Set(domains));

  const companyPredicates = ['company_id = ?'];
  const binds: unknown[] = [companyId];
  for (const domain of uniqueDomains) {
    companyPredicates.push(`(
      email IS NOT NULL
      AND (
        lower(email) LIKE ?
        OR lower(email) LIKE ?
      )
    )`);
    binds.push(`%@${domain}`, `%@%.${domain}`);
  }

  const rows = await env.D1.prepare(
    `SELECT id
       FROM contacts
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND merged_into IS NULL
        AND (${companyPredicates.join(' OR ')})`
  ).bind(orgId, ...binds).all<{ id: string }>();

  let rebuilt = 0;
  for (const row of rows.results) {
    await safelyRebuildContactSearchIndexForContact(env, orgId, row.id);
    rebuilt++;
  }
  return { scanned: rows.results.length, rebuilt };
}

export async function safelyRebuildContactSearchIndexForCompany(
  env: Env,
  orgId: string,
  companyId: string,
  extraDomain?: string | null
): Promise<void> {
  try {
    await rebuildContactSearchIndexForCompany(env, orgId, companyId, extraDomain);
  } catch (error) {
    await recordContactSearchIndexRepair(env, orgId, {
      reason: 'company_rebuild_failed',
      error,
      metadata: { company_id: companyId, extra_domain: extraDomain || null },
    });
  }
}

export async function rebuildContactSearchIndexForOrg(
  env: Env,
  orgId: string,
  limit = 10000
): Promise<{ active_contacts: number; rebuilt: number; errors: number }> {
  await env.D1.prepare('DELETE FROM contact_search_fts WHERE org_id = ?').bind(orgId).run();
  const rows = await env.D1.prepare(
    `SELECT id
       FROM contacts
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND merged_into IS NULL
      ORDER BY updated_at DESC
      LIMIT ?`
  ).bind(orgId, limit).all<{ id: string }>();

  let rebuilt = 0;
  let errors = 0;
  for (const row of rows.results) {
    try {
      await rebuildContactSearchIndexForContact(env, orgId, row.id);
      rebuilt++;
    } catch (error) {
      errors++;
      await recordContactSearchIndexRepair(env, orgId, {
        contactId: row.id,
        reason: 'org_rebuild_contact_failed',
        error,
      });
    }
  }
  return { active_contacts: rows.results.length, rebuilt, errors };
}

export async function repairContactSearchIndexDrift(
  orgId: string,
  env: Env,
  limit = 200
): Promise<{ checked: number; repaired: number }> {
  const rows = await env.D1.prepare(
    `SELECT c.id
       FROM contacts c
       LEFT JOIN contact_search_fts f
         ON f.contact_id = c.id
        AND f.org_id = c.org_id
      WHERE c.org_id = ?
        AND c.deleted_at IS NULL
        AND c.merged_into IS NULL
        AND (
          f.contact_id IS NULL
          OR COALESCE(c.updated_at, c.created_at, '') > COALESCE(f.updated_at, '')
        )
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT ?`
  ).bind(orgId, limit).all<{ id: string }>();

  let repaired = 0;
  for (const row of rows.results) {
    await safelyRebuildContactSearchIndexForContact(env, orgId, row.id);
    repaired++;
  }
  return { checked: rows.results.length, repaired };
}

export async function ensureContactSearchIndexReady(
  env: Env,
  orgId: string
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const [active, indexed] = await Promise.all([
    env.D1.prepare(
      `SELECT COUNT(*) AS n
         FROM contacts
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND merged_into IS NULL`
    ).bind(orgId).first<{ n: number }>(),
    env.D1.prepare(
      `SELECT COUNT(DISTINCT contact_id) AS n
         FROM contact_search_fts
        WHERE org_id = ?`
    ).bind(orgId).first<{ n: number }>(),
  ]);

  const activeCount = active?.n || 0;
  const indexedCount = indexed?.n || 0;
  if (activeCount > 0 && indexedCount === 0) {
    await recordContactSearchIndexRepair(env, orgId, {
      reason: 'index_empty',
      metadata: { active_contacts: activeCount, indexed_contacts: indexedCount },
    });
    return {
      ok: false,
      code: 'CONTACT_SEARCH_INDEX_EMPTY',
      message: 'Contact search index is empty. Run the contact search index rebuild before serving searched contact results.',
    };
  }

  if (indexedCount < activeCount) {
    await recordContactSearchIndexRepair(env, orgId, {
      reason: 'index_incomplete',
      metadata: { active_contacts: activeCount, indexed_contacts: indexedCount },
    });
  }

  return { ok: true };
}

export const __contactSearchTestHooks = {
  normalizeContactSearchText,
  extractContactSearchTerms,
  buildContactSearchQuery,
};

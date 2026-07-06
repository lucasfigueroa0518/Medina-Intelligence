import type { Env } from '../types/env';

// Dedicated FTS5 search for companies. Mirrors src/lib/contact-search.ts, but
// simpler: companies is the base entity, so there is no contact→company
// resolution join. The companies list/search handler uses this instead of a
// wide `name/domain/description LIKE %term%` scan, and falls back to that LIKE
// path when the index is empty or errors (see companies handler).

const MAX_SEARCH_TERMS = 8;
const COMPANY_SEARCH_INLINE_REPAIR_LIMIT = 25;

export interface CompanySearchQuery {
  raw: string;
  normalized: string;
  terms: string[];
  ftsMatch: string;
  prefix: string;
  contains: string;
}

interface CompanyIndexRow {
  id: string;
  org_id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  sector: string | null;
  location_mentioned: string | null;
  description: string | null;
  custom_fields: string | null;
  updated_at: string | null;
  created_at: string | null;
}

function isMissingCompanySearchStateTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /no such table:?\s*company_search_index_state/i.test(message);
}

export function isMissingCompanySearchTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /no such table:?\s*company_search_fts/i.test(message);
}

export function normalizeCompanySearchText(input: string | null | undefined): string {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractCompanySearchTerms(input: string | null | undefined): string[] {
  const normalized = normalizeCompanySearchText(input);
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

export function buildCompanySearchQuery(input: string | null | undefined): CompanySearchQuery | null {
  const normalized = normalizeCompanySearchText(input);
  const terms = extractCompanySearchTerms(normalized);
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

export function companySearchRankSql(): string {
  return `
    CASE
      WHEN lower(f.name) = ? THEN 0
      WHEN lower(f.domain) = ? THEN 1
      WHEN lower(f.name) LIKE ? THEN 2
      WHEN lower(f.domain) LIKE ? THEN 3
      WHEN lower(f.sector) LIKE ? THEN 5
      ELSE 10
    END
  `;
}

export function companySearchRankBinds(query: CompanySearchQuery): unknown[] {
  return [
    query.normalized,
    query.normalized,
    query.prefix,
    query.prefix,
    query.contains,
  ];
}

export function companySearchCteSql(): string {
  return `
    WITH matched AS (
      SELECT
        f.company_id,
        ${companySearchRankSql()} AS search_rank
      FROM company_search_fts f
      WHERE company_search_fts MATCH ?
        AND f.org_id = ?
    )
  `;
}

export function companySearchCteBinds(query: CompanySearchQuery, orgId: string): unknown[] {
  return [...companySearchRankBinds(query), query.ftsMatch, orgId];
}

export function companySearchDriftSql(): string {
  return `
    SELECT co.id
      FROM companies co
      LEFT JOIN company_search_index_state s
        ON s.org_id = co.org_id
       AND s.company_id = co.id
     WHERE co.org_id = ?
       AND co.deleted_at IS NULL
       AND co.merged_into IS NULL
       AND (
         s.company_id IS NULL
         OR s.status != 'indexed'
         OR COALESCE(co.updated_at, co.created_at, '') > COALESCE(s.company_updated_at, '')
       )
     ORDER BY co.updated_at DESC
     LIMIT ?
  `;
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

async function companyTagsText(env: Env, companyId: string): Promise<string> {
  const rows = await env.D1.prepare(
    `SELECT t.name
       FROM company_tags ct
       JOIN tags t ON t.id = ct.tag_id
      WHERE ct.company_id = ?
      ORDER BY t.name COLLATE NOCASE ASC`
  ).bind(companyId).all<{ name: string }>();
  return rows.results.map(row => row.name).filter(Boolean).join(' ');
}

async function loadCompanyIndexRow(env: Env, orgId: string, companyId: string): Promise<CompanyIndexRow | null> {
  return await env.D1.prepare(
    `SELECT
        co.id,
        co.org_id,
        co.name,
        co.domain,
        co.website,
        co.sector,
        co.location_mentioned,
        co.description,
        co.custom_fields,
        co.updated_at,
        co.created_at
       FROM companies co
      WHERE co.id = ?
        AND co.org_id = ?
        AND co.deleted_at IS NULL
        AND co.merged_into IS NULL`
  ).bind(companyId, orgId).first<CompanyIndexRow>();
}

export async function recordCompanySearchIndexRepair(
  env: Env,
  orgId: string,
  args: { companyId?: string | null; reason: string; error?: unknown; metadata?: Record<string, unknown> }
): Promise<void> {
  const companyId = args.companyId || '';
  const lastError = args.error instanceof Error ? args.error.message : args.error ? String(args.error) : null;
  try {
    await env.D1.prepare(
      `INSERT INTO company_search_index_repairs
         (org_id, company_id, reason, status, last_error, metadata, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(org_id, company_id, reason) DO UPDATE SET
         status = 'pending',
         last_error = excluded.last_error,
         metadata = excluded.metadata,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(
      orgId,
      companyId,
      args.reason,
      lastError,
      JSON.stringify(args.metadata || {})
    ).run();
  } catch (repairError) {
    // A missing repairs table shouldn't take down the write path.
    console.error('[company-search] failed to record repair', {
      orgId,
      companyId,
      reason: args.reason,
      error: repairError instanceof Error ? repairError.message : String(repairError),
    });
  }
}

async function upsertCompanySearchIndexState(
  env: Env,
  orgId: string,
  companyId: string,
  args: {
    companyUpdatedAt?: string | null;
    indexedAt?: string | null;
    status?: 'indexed' | 'stale' | 'failed' | 'deleted';
    error?: unknown;
  } = {}
): Promise<void> {
  const status = args.status || 'indexed';
  const errorText = args.error instanceof Error ? args.error.message : args.error ? String(args.error) : null;
  try {
    await env.D1.prepare(
      `INSERT INTO company_search_index_state
         (org_id, company_id, company_updated_at, indexed_at, status, last_error, repair_attempt_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'failed' THEN 1 ELSE 0 END, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(org_id, company_id) DO UPDATE SET
         company_updated_at = excluded.company_updated_at,
         indexed_at = excluded.indexed_at,
         status = excluded.status,
         last_error = excluded.last_error,
         repair_attempt_count = CASE
           WHEN excluded.status = 'failed' THEN company_search_index_state.repair_attempt_count + 1
           WHEN excluded.status = 'indexed' THEN 0
           ELSE company_search_index_state.repair_attempt_count
         END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(
      orgId,
      companyId,
      args.companyUpdatedAt || null,
      args.indexedAt || (status === 'indexed' ? new Date().toISOString() : null),
      status,
      errorText,
      status
    ).run();
  } catch (error) {
    if (!isMissingCompanySearchStateTable(error)) throw error;
  }
}

async function deleteCompanySearchIndexStateForCompany(env: Env, companyId: string): Promise<void> {
  try {
    await env.D1.prepare('DELETE FROM company_search_index_state WHERE company_id = ?').bind(companyId).run();
  } catch (error) {
    if (!isMissingCompanySearchStateTable(error)) throw error;
  }
}

export async function deleteCompanySearchIndexForCompany(env: Env, companyId: string): Promise<void> {
  await env.D1.prepare('DELETE FROM company_search_fts WHERE company_id = ?').bind(companyId).run();
  await deleteCompanySearchIndexStateForCompany(env, companyId);
}

export async function rebuildCompanySearchIndexForCompany(
  env: Env,
  orgId: string,
  companyId: string
): Promise<void> {
  const row = await loadCompanyIndexRow(env, orgId, companyId);
  if (!row) {
    await deleteCompanySearchIndexForCompany(env, companyId);
    return;
  }

  const tags = await companyTagsText(env, companyId);
  const exactTerms = [
    row.name,
    row.domain,
    row.website,
    row.sector,
    tags,
  ].map(value => normalizeCompanySearchText(value)).filter(Boolean).join(' ');

  await env.D1.batch([
    env.D1.prepare('DELETE FROM company_search_fts WHERE company_id = ?').bind(companyId),
    env.D1.prepare(
      `INSERT INTO company_search_fts
         (company_id, org_id, name, domain, website, sector, location_mentioned,
          description, tags, custom_fields, exact_terms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id,
      row.org_id,
      row.name || '',
      row.domain || '',
      row.website || '',
      row.sector || '',
      row.location_mentioned || '',
      row.description || '',
      tags,
      asText(row.custom_fields),
      exactTerms,
      row.updated_at || row.created_at || new Date().toISOString()
    ),
  ]);

  await upsertCompanySearchIndexState(env, orgId, companyId, {
    companyUpdatedAt: row.updated_at || row.created_at || null,
    status: 'indexed',
  });
}

/** Best-effort rebuild that never throws into the caller's write path. A
 *  missing company_search_fts table (local DB without the migration) is
 *  swallowed — search silently falls back to LIKE. */
export async function safelyRebuildCompanySearchIndexForCompany(
  env: Env,
  orgId: string,
  companyId: string
): Promise<void> {
  try {
    await rebuildCompanySearchIndexForCompany(env, orgId, companyId);
  } catch (error) {
    if (isMissingCompanySearchTable(error)) return;
    await upsertCompanySearchIndexState(env, orgId, companyId, {
      status: 'failed',
      error,
    }).catch(() => {});
    await recordCompanySearchIndexRepair(env, orgId, {
      companyId,
      reason: 'upsert_failed',
      error,
    });
  }
}

export async function safelyDeleteCompanySearchIndexForCompany(
  env: Env,
  orgId: string,
  companyId: string
): Promise<void> {
  try {
    await deleteCompanySearchIndexForCompany(env, companyId);
  } catch (error) {
    if (isMissingCompanySearchTable(error)) return;
    await recordCompanySearchIndexRepair(env, orgId, {
      companyId,
      reason: 'delete_failed',
      error,
    });
  }
}

export async function rebuildCompanySearchIndexForOrg(
  env: Env,
  orgId: string,
  limit = 10000
): Promise<{ active_companies: number; rebuilt: number; errors: number }> {
  await env.D1.prepare('DELETE FROM company_search_fts WHERE org_id = ?').bind(orgId).run();
  try {
    await env.D1.prepare('DELETE FROM company_search_index_state WHERE org_id = ?').bind(orgId).run();
  } catch (error) {
    if (!isMissingCompanySearchStateTable(error)) throw error;
  }
  const rows = await env.D1.prepare(
    `SELECT id
       FROM companies
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
      await rebuildCompanySearchIndexForCompany(env, orgId, row.id);
      rebuilt++;
    } catch (error) {
      errors++;
      await recordCompanySearchIndexRepair(env, orgId, {
        companyId: row.id,
        reason: 'org_rebuild_company_failed',
        error,
      });
    }
  }
  return { active_companies: rows.results.length, rebuilt, errors };
}

async function listCompanySearchDriftRows(
  env: Env,
  orgId: string,
  limit: number
): Promise<Array<{ id: string }>> {
  try {
    const rows = await env.D1.prepare(companySearchDriftSql()).bind(orgId, limit).all<{ id: string }>();
    return rows.results || [];
  } catch (error) {
    if (!isMissingCompanySearchStateTable(error)) throw error;
    const rows = await env.D1.prepare(
      `SELECT co.id
         FROM companies co
         LEFT JOIN company_search_fts f
           ON f.company_id = co.id
          AND f.org_id = co.org_id
        WHERE co.org_id = ?
          AND co.deleted_at IS NULL
          AND co.merged_into IS NULL
          AND (
            f.company_id IS NULL
            OR COALESCE(co.updated_at, co.created_at, '') > COALESCE(f.updated_at, '')
          )
        GROUP BY co.id
        ORDER BY co.updated_at DESC
        LIMIT ?`
    ).bind(orgId, limit).all<{ id: string }>();
    return rows.results || [];
  }
}

/** True when the FTS index is populated enough to serve searches. Returns false
 *  (so the caller can fall back to LIKE) when the index is empty despite active
 *  companies, or is missing outright. Repairs a small amount of drift inline. */
export async function isCompanySearchIndexUsable(env: Env, orgId: string): Promise<boolean> {
  let active: { n: number } | null;
  let indexed: { n: number } | null;
  try {
    [active, indexed] = await Promise.all([
      env.D1.prepare(
        `SELECT COUNT(*) AS n
           FROM companies
          WHERE org_id = ?
            AND deleted_at IS NULL
            AND merged_into IS NULL`
      ).bind(orgId).first<{ n: number }>(),
      env.D1.prepare(
        `SELECT COUNT(DISTINCT company_id) AS n
           FROM company_search_fts
          WHERE org_id = ?`
      ).bind(orgId).first<{ n: number }>(),
    ]);
  } catch (error) {
    if (isMissingCompanySearchTable(error)) return false;
    throw error;
  }

  const activeCount = active?.n || 0;
  const indexedCount = indexed?.n || 0;
  // Empty index but there are companies → not usable; caller uses LIKE.
  if (activeCount > 0 && indexedCount === 0) {
    await recordCompanySearchIndexRepair(env, orgId, {
      reason: 'index_empty',
      metadata: { active_companies: activeCount, indexed_companies: indexedCount },
    }).catch(() => {});
    return false;
  }

  // Repair a bounded amount of drift inline so freshly-edited rows are findable.
  try {
    const driftRows = await listCompanySearchDriftRows(env, orgId, COMPANY_SEARCH_INLINE_REPAIR_LIMIT);
    for (const row of driftRows) {
      await safelyRebuildCompanySearchIndexForCompany(env, orgId, row.id);
    }
  } catch (error) {
    if (isMissingCompanySearchTable(error)) return false;
    // Drift repair is best-effort; the index is still usable.
  }

  return true;
}

export const __companySearchTestHooks = {
  normalizeCompanySearchText,
  extractCompanySearchTerms,
  buildCompanySearchQuery,
  companySearchCteSql,
  companySearchDriftSql,
};

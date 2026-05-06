// TRD §5.1, §11.3 — Companies CRUD + news + enrich
import type { Env } from '../types/env';
import type { AuthContext, CompanyFilter } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { cleanupVectorsForEntity } from '../lib/merge';
import { triggerCompanyEnrichment } from '../lib/enrichment';
import { findDuplicateCompany } from '../lib/discovery';
import { markFieldsHumanEdited } from '../lib/progressive-enrichment';
import { updateCompanyFields } from '../lib/entity-writes';
import { updateEntityInIndex } from '../lib/entity-index';

// News-score buckets. The underlying scale is 0-10 (see lib/news-scoring).
function newsScorePredicate(bucket: string): string | null {
  switch (bucket) {
    case 'high': return 'co.news_relevance_score >= 7';
    case 'medium': return 'co.news_relevance_score >= 3 AND co.news_relevance_score < 7';
    case 'low': return 'co.news_relevance_score > 0 AND co.news_relevance_score < 3';
    case 'none': return '(co.news_relevance_score IS NULL OR co.news_relevance_score = 0)';
    default: return null;
  }
}

const COMPANY_SORT_MAP: Record<string, { col: string; defaultDir: 'ASC' | 'DESC' }> = {
  news_score: { col: 'co.news_relevance_score', defaultDir: 'DESC' },
  name: { col: 'co.name', defaultDir: 'ASC' },
  city: { col: 'co.hq_location', defaultDir: 'ASC' },
  investment_status: { col: 'co.investment_status', defaultDir: 'ASC' },
  stage: { col: 'co.stage', defaultDir: 'ASC' },
  current_valuation: { col: 'co.current_valuation', defaultDir: 'DESC' },
  created_at: { col: 'co.created_at', defaultDir: 'DESC' },
};

function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

// Same dual-form helper used by the contacts handler — handles legacy
// multi-value params and the new comma-separated form transparently.
function readMulti(sp: URLSearchParams, key: string): string[] | undefined {
  const all = sp.getAll(key);
  if (all.length === 0) return undefined;
  if (all.length === 1) return parseList(all[0]);
  return all;
}

export async function listCompanies(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const f = parseCompanyFilter(url);
  const sp = url.searchParams;

  const where: string[] = ['co.org_id = ?', 'co.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  // Type filter — new comma-separated `type` OR legacy multi-value `company_types`.
  const typeList = readMulti(sp, 'type') ?? f.company_types;
  if (typeList?.length) {
    where.push(`co.company_type IN (${typeList.map(() => '?').join(',')})`);
    binds.push(...typeList);
  }

  // Investment status — comma-separated `investment_status` OR legacy multi.
  const investmentStatus = readMulti(sp, 'investment_status') ?? f.investment_status;
  if (investmentStatus?.length) {
    where.push(`co.investment_status IN (${investmentStatus.map(() => '?').join(',')})`);
    binds.push(...investmentStatus);
  }

  if (f.stage?.length) {
    where.push(`co.stage IN (${f.stage.map(() => '?').join(',')})`);
    binds.push(...f.stage);
  }
  if (f.sector?.length) {
    where.push(`co.sector IN (${f.sector.map(() => '?').join(',')})`);
    binds.push(...f.sector);
  }

  // City filter — hq_location stores "City, Region" or just "City"; match on
  // the leading segment so queries are intuitive ("San Francisco" finds
  // "San Francisco, CA").
  const city = sp.get('city');
  if (city) {
    where.push('(co.hq_location = ? OR co.hq_location LIKE ?)');
    binds.push(city, `${city},%`);
  }

  // News score bucket. Comma-separated combines buckets ("In News" =
  // high,medium).
  const newsScoreBuckets = readMulti(sp, 'news_score');
  if (newsScoreBuckets?.length) {
    const predicates = newsScoreBuckets
      .map(b => newsScorePredicate(b))
      .filter((p): p is string => !!p);
    if (predicates.length) where.push(`(${predicates.join(' OR ')})`);
  }

  // Has-deals — only include companies with at least one non-deleted active
  // deal (excludes the closed stage so "in active deals" matches).
  if (sp.get('has_deals') === 'true') {
    where.push(
      `EXISTS (SELECT 1 FROM deals d
               WHERE d.company_id = co.id
                 AND d.deleted_at IS NULL
                 AND d.stage != 'closed')`
    );
  }

  // Search — name + domain + description. Matches the placeholder text in
  // the companies search input.
  const search = sp.get('search') ?? f.keyword;
  if (search) {
    const pat = `%${search}%`;
    where.push('(co.name LIKE ? OR co.domain LIKE ? OR co.description LIKE ?)');
    binds.push(pat, pat, pat);
  }

  // Tag filtering — IDs preferred, fall back to names for legacy callers.
  let tagJoin = '';
  const tagsParam = readMulti(sp, 'tags') ?? f.tags;
  if (tagsParam?.length) {
    const looksLikeIds = tagsParam.every(t => /^[a-f0-9]{16,}$/i.test(t));
    tagJoin = `JOIN company_tags ctg ON co.id = ctg.company_id
               JOIN tags t ON ctg.tag_id = t.id`;
    if (looksLikeIds) {
      where.push(`t.id IN (${tagsParam.map(() => '?').join(',')})`);
    } else {
      where.push(`t.name IN (${tagsParam.map(() => '?').join(',')})`);
    }
    binds.push(...tagsParam);
  }

  // Sort. New `sort`/`order` aliases override legacy `sort_by`/`sort_dir`.
  const sortKey = sp.get('sort') ?? f.sort_by;
  const sortMeta = COMPANY_SORT_MAP[sortKey ?? 'news_score'] ?? COMPANY_SORT_MAP.news_score;
  const orderParam = sp.get('order') ?? f.sort_dir;
  const sortDir = orderParam
    ? (orderParam.toLowerCase() === 'asc' ? 'ASC' : 'DESC')
    : sortMeta.defaultDir;

  // Default sort is news_score DESC NULLS LAST tiebroken alpha — beats pure
  // alphabetical because the in-news rows surface to the top without burying
  // the rest.
  const tieBreak = sortKey === 'news_score' || !sortKey ? ', co.name COLLATE NOCASE ASC' : ', co.id ASC';

  // Default 100/page, ceiling 500. Frontend cumulative-paginates.
  const limit = Math.min(f.limit || 100, 500);
  const offset = f.offset || 0;

  const havingClause =
    tagsParam?.length && f.tag_logic === 'and'
      ? `HAVING COUNT(DISTINCT t.id) = ${tagsParam.length}`
      : '';

  const sql = `
    SELECT co.*
    FROM companies co
    ${tagJoin}
    WHERE ${where.join(' AND ')}
    GROUP BY co.id
    ${havingClause}
    ORDER BY ${sortMeta.col} ${sortDir} NULLS LAST${tieBreak}
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(DISTINCT co.id) as n
    FROM companies co
    ${tagJoin}
    WHERE ${where.join(' AND ')}
  `;

  const [result, countResult] = await Promise.all([
    env.D1.prepare(sql).bind(...binds, limit, offset).all(),
    env.D1.prepare(countSql).bind(...binds).first<{ n: number }>(),
  ]);
  const total = countResult?.n ?? 0;

  const companies = result.results as any[];
  if (companies.length > 0) {
    const ids = companies.map(c => c.id);
    const ph = ids.map(() => '?').join(',');
    const tagRows = await env.D1.prepare(
      `SELECT ct.company_id, t.id, t.name, t.color
       FROM company_tags ct JOIN tags t ON ct.tag_id = t.id
       WHERE ct.company_id IN (${ph})`
    ).bind(...ids).all();
    const tagMap = new Map<string, any[]>();
    for (const r of tagRows.results as any[]) {
      const arr = tagMap.get(r.company_id) || [];
      arr.push({ id: r.id, name: r.name, color: r.color });
      tagMap.set(r.company_id, arr);
    }
    for (const c of companies) {
      c.tags = tagMap.get(c.id) || [];
    }
  }

  return jsonResponse({
    companies,
    limit,
    offset,
    total,
    has_more: offset + companies.length < total,
  });
}

// --- GET /api/companies/cities ---
// Distinct city list extracted from the leading segment of hq_location, with
// a count per city. Cached for 5 minutes — these don't move quickly and the
// dropdown calls this on every page load.
export async function listCompanyCities(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT hq_location FROM companies
     WHERE org_id = ? AND deleted_at IS NULL AND hq_location IS NOT NULL AND hq_location != ''`
  ).bind(ctx.orgId).all<{ hq_location: string }>();

  const counts = new Map<string, number>();
  for (const r of rows.results) {
    const city = r.hq_location.split(',')[0].trim();
    if (!city) continue;
    counts.set(city, (counts.get(city) || 0) + 1);
  }

  const cities = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return jsonResponse(
    { cities },
    200,
    { 'Cache-Control': 'private, max-age=300' }
  );
}

function parseCompanyFilter(url: URL): CompanyFilter {
  const f: CompanyFilter = {};
  const sp = url.searchParams;
  if (sp.getAll('company_types').length) f.company_types = sp.getAll('company_types');
  if (sp.getAll('investment_status').length)
    f.investment_status = sp.getAll('investment_status');
  if (sp.getAll('stage').length) f.stage = sp.getAll('stage');
  if (sp.getAll('sector').length) f.sector = sp.getAll('sector');
  if (sp.get('keyword')) f.keyword = sp.get('keyword')!;
  if (sp.get('sort_by')) f.sort_by = sp.get('sort_by') as CompanyFilter['sort_by'];
  if (sp.get('sort_dir')) f.sort_dir = sp.get('sort_dir') as CompanyFilter['sort_dir'];
  if (sp.get('limit')) f.limit = parseInt(sp.get('limit')!, 10);
  if (sp.get('offset')) f.offset = parseInt(sp.get('offset')!, 10);
  return f;
}

// --- GET /api/companies/filter-counts ---

export async function getCompanyFilterCounts(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const tagCounts = await env.D1.prepare(
    `SELECT ct.tag_id, COUNT(*) as cnt FROM company_tags ct
     JOIN companies c ON c.id = ct.company_id
     WHERE c.org_id = ? AND c.deleted_at IS NULL
     GROUP BY ct.tag_id`
  ).bind(ctx.orgId).all<{ tag_id: string; cnt: number }>();

  const tags: Record<string, number> = {};
  for (const r of tagCounts.results) tags[r.tag_id] = r.cnt;

  return jsonResponse({ tags });
}

export async function createCompany(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.name) return errorResponse('VALIDATION_ERROR', 400);

  const domain = body.website
    ? body.website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim()
    : null;
  const existingDup = await findDuplicateCompany(body.name, domain, ctx.orgId, env);
  if (existingDup) {
    const existing = await env.D1.prepare('SELECT * FROM companies WHERE id = ?').bind(existingDup).first();
    return jsonResponse({ company: existing, deduplicated: true });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, domain, website, description, company_type, sector, stage, investment_status, linkedin_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      body.name,
      domain,
      body.website || null,
      body.description || null,
      body.company_type || 'startup',
      body.sector || null,
      body.stage || null,
      body.investment_status || 'tracking',
      body.linkedin_url || null,
      now,
      now
    )
    .run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'company',
    entity_id: id,
    after_data: { id, name: body.name },
    created_at: now,
  });

  try { await updateEntityInIndex(ctx.orgId, 'company', id, env); } catch {}

  ctxExec.waitUntil(triggerCompanyEnrichment(id, ctx.orgId, env));
  await invalidateRagCache(ctx.orgId, env);

  const created = await env.D1.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();
  return jsonResponse({ company: created }, 201);
}

export async function getCompany(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const company = await env.D1.prepare(
    'SELECT * FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();

  if (!company) return errorResponse('COMPANY_NOT_FOUND', 404);

  const contacts = await env.D1.prepare(
    'SELECT id, full_name, job_title, email FROM contacts WHERE company_id = ? AND deleted_at IS NULL'
  ).bind(id).all();

  const deals = await env.D1.prepare(
    'SELECT id, title, stage, amount, probability FROM deals WHERE company_id = ? AND deleted_at IS NULL'
  ).bind(id).all();

  const tags = await env.D1.prepare(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN company_tags ct ON t.id = ct.tag_id
     WHERE ct.company_id = ?`
  ).bind(id).all();

  const newsArticles = await env.D1.prepare(
    `SELECT id, title, source_url, source_name, published_at, summary,
            relevance_tag, relevance_score
     FROM news_articles
     WHERE company_id = ? AND org_id = ?
     ORDER BY published_at DESC LIMIT 10`
  ).bind(id, ctx.orgId).all();

  return jsonResponse({
    company,
    contacts: contacts.results,
    deals: deals.results,
    tags: tags.results,
    news_articles: newsArticles.results,
  });
}

export async function updateCompany(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400);

  // Phase 1 refactor — see contacts.ts:updateContact for the full
  // rationale. Same single source of truth (src/lib/entity-writes.ts)
  // that MARTy's update_company_field tool will call in Phase 2.
  const result = await updateCompanyFields(id, body, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    userRole: ctx.userRole,
    origin: 'manual_ui',
  }, env);
  if (!result.ok && result.error) {
    return errorResponse(result.error.code, result.error.status, result.error.message);
  }
  const responseBody: Record<string, unknown> = { company: result.after };
  if (result.rejected.length > 0) responseBody.rejected_fields = result.rejected;
  return jsonResponse(responseBody);
}

export async function deleteCompany(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const before = await env.D1.prepare(
    'SELECT * FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('COMPANY_NOT_FOUND', 404);

  await env.D1.batch([
    env.D1.prepare(
      `UPDATE companies SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(id),
    env.D1.prepare(
      `UPDATE contacts SET company_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE company_id = ? AND org_id = ?`
    ).bind(id, ctx.orgId),
  ]);

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'company',
    entity_id: id,
    before_data: before,
    created_at: new Date().toISOString(),
  });

  try { await cleanupVectorsForEntity(id, 'companies', env); } catch { /* best-effort */ }
  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

export async function getCompanyNews(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const company = await env.D1.prepare(
    'SELECT id, name, sector, last_news_summary, news_relevance_score FROM companies WHERE id = ? AND org_id = ?'
  ).bind(id, ctx.orgId).first<{
    id: string; name: string; sector: string | null;
    last_news_summary: string | null; news_relevance_score: number | null;
  }>();

  if (!company) return errorResponse('COMPANY_NOT_FOUND', 404);

  const articles = await env.D1.prepare(
    `SELECT id, title, source_url, source_name, published_at, summary,
            relevance_tag, relevance_score
     FROM news_articles
     WHERE company_id = ? AND org_id = ?
     ORDER BY published_at DESC LIMIT 30`
  ).bind(id, ctx.orgId).all();

  // Fallback to legacy conversation-based news
  const legacyNews = await env.D1.prepare(
    `SELECT id, subject, body_preview, sent_at
     FROM conversations
     WHERE org_id = ? AND source = 'manual' AND from_email = 'news@claude-search'
     ORDER BY sent_at DESC LIMIT 10`
  ).bind(ctx.orgId).all();

  return jsonResponse({
    company,
    articles: articles.results,
    legacy_news: legacyNews.results,
    news_relevance_score: company.news_relevance_score,
    last_summary: company.last_news_summary,
  });
}

export async function enrichCompanyEndpoint(
  id: string,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  ctxExec.waitUntil(triggerCompanyEnrichment(id, ctx.orgId, env));
  return jsonResponse({ ok: true, message: 'Enrichment queued' });
}

export async function getCompanyEnrichment(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const company = await env.D1.prepare(
    `SELECT id, name, enrichment_confidence, enrichment_last_run
     FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.orgId).first<{
    id: string;
    name: string;
    enrichment_confidence: number | null;
    enrichment_last_run: string | null;
  }>();

  if (!company) return errorResponse('COMPANY_NOT_FOUND', 404);

  const r2Key = `${ctx.orgId}/enrichment/aggregated/${id}.json`;
  const obj = await env.R2.get(r2Key);

  if (!obj) {
    return jsonResponse({
      company_id: company.id,
      full_bio: null,
      enrichment_confidence: company.enrichment_confidence,
      enrichment_last_run: company.enrichment_last_run,
      status: 'not_enriched',
    });
  }

  const raw = await obj.text();
  let fullBio: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { full_bio?: string };
    fullBio = parsed.full_bio ?? null;
  } catch {
    fullBio = raw;
  }

  return jsonResponse({
    company_id: company.id,
    full_bio: fullBio,
    enrichment_confidence: company.enrichment_confidence,
    enrichment_last_run: company.enrichment_last_run,
    status: fullBio ? 'enriched' : 'not_enriched',
  });
}

export async function applyCompanyTags(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ tag_ids: string[] }>(request);
  if (!body?.tag_ids?.length) return errorResponse('VALIDATION_ERROR', 400);
  const now = new Date().toISOString();

  for (const tagId of body.tag_ids) {
    await env.D1.prepare(
      `INSERT OR IGNORE INTO company_tags (company_id, tag_id, applied_by, applied_at) VALUES (?, ?, ?, ?)`
    ).bind(id, tagId, ctx.userId, now).run();

    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'tag_apply',
      entity_type: 'company',
      entity_id: id,
      metadata: { tag_id: tagId },
      created_at: now,
    });
  }
  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

export async function getCompanyAssociations(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT ea.id, ea.entity_a_type, ea.entity_a_id, ea.entity_b_type, ea.entity_b_id,
            ea.association_type, ea.strength, ea.reason, ea.evidence_count,
            ea.first_seen_at, ea.last_seen_at,
            CASE
              WHEN ea.entity_a_type = 'company' AND ea.entity_a_id = ? THEN ea.entity_b_type
              ELSE ea.entity_a_type
            END as other_type,
            CASE
              WHEN ea.entity_a_type = 'company' AND ea.entity_a_id = ? THEN ea.entity_b_id
              ELSE ea.entity_a_id
            END as other_id
     FROM entity_associations ea
     WHERE ea.org_id = ?
       AND ((ea.entity_a_type = 'company' AND ea.entity_a_id = ?)
         OR (ea.entity_b_type = 'company' AND ea.entity_b_id = ?))
     ORDER BY ea.strength DESC
     LIMIT 100`
  ).bind(id, id, ctx.orgId, id, id).all();

  const hydrated = [];
  for (const row of rows.results as any[]) {
    let entityName: string | null = null;
    let entityTitle: string | null = null;

    if (row.other_type === 'contact') {
      const c = await env.D1.prepare(
        'SELECT full_name, job_title FROM contacts WHERE id = ? AND deleted_at IS NULL'
      ).bind(row.other_id).first<{ full_name: string; job_title: string | null }>();
      if (c) { entityName = c.full_name; entityTitle = c.job_title; }
    } else if (row.other_type === 'company') {
      const c = await env.D1.prepare(
        'SELECT name, sector FROM companies WHERE id = ? AND deleted_at IS NULL'
      ).bind(row.other_id).first<{ name: string; sector: string | null }>();
      if (c) { entityName = c.name; entityTitle = c.sector; }
    } else if (row.other_type === 'deal') {
      const d = await env.D1.prepare(
        'SELECT title, stage FROM deals WHERE id = ? AND deleted_at IS NULL'
      ).bind(row.other_id).first<{ title: string; stage: string | null }>();
      if (d) { entityName = d.title; entityTitle = d.stage; }
    }

    if (entityName) {
      hydrated.push({ ...row, entity_name: entityName, entity_title: entityTitle });
    }
  }

  const grouped = new Map<string, any>();
  for (const h of hydrated) {
    const key = `${h.other_type}:${h.other_id}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.association_types.includes(h.association_type)) {
        existing.association_types.push(h.association_type);
      }
      if (h.strength > existing.strength) existing.strength = h.strength;
      if (h.reason && !existing.reason.includes(h.reason)) {
        existing.reason = `${existing.reason} · ${h.reason}`;
      }
      existing.evidence_count = (existing.evidence_count || 0) + (h.evidence_count || 0);
    } else {
      grouped.set(key, {
        ...h,
        association_types: [h.association_type],
      });
    }
  }

  return jsonResponse({ associations: Array.from(grouped.values()) });
}

export async function removeCompanyTag(
  id: string,
  tagId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    'DELETE FROM company_tags WHERE company_id = ? AND tag_id = ?'
  ).bind(id, tagId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'tag_remove',
    entity_type: 'company',
    entity_id: id,
    metadata: { tag_id: tagId },
    created_at: new Date().toISOString(),
  });
  return jsonResponse({ ok: true });
}

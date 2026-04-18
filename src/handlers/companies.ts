// TRD §5.1, §11.3 — Companies CRUD + news + enrich
import type { Env } from '../types/env';
import type { AuthContext, CompanyFilter } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { triggerCompanyEnrichment } from '../lib/enrichment';

export async function listCompanies(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const f = parseCompanyFilter(url);

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (f.company_types?.length) {
    where.push(`company_type IN (${f.company_types.map(() => '?').join(',')})`);
    binds.push(...f.company_types);
  }
  if (f.investment_status?.length) {
    where.push(
      `investment_status IN (${f.investment_status.map(() => '?').join(',')})`
    );
    binds.push(...f.investment_status);
  }
  if (f.stage?.length) {
    where.push(`stage IN (${f.stage.map(() => '?').join(',')})`);
    binds.push(...f.stage);
  }
  if (f.sector?.length) {
    where.push(`sector IN (${f.sector.map(() => '?').join(',')})`);
    binds.push(...f.sector);
  }
  if (f.keyword) {
    where.push('(name LIKE ? OR description LIKE ?)');
    binds.push(`%${f.keyword}%`, `%${f.keyword}%`);
  }

  const sortBy = f.sort_by || 'name';
  const sortDir = f.sort_dir === 'desc' ? 'DESC' : 'ASC';
  const allowedSort = new Set([
    'name',
    'investment_status',
    'stage',
    'current_valuation',
    'created_at',
  ]);
  const sortCol = allowedSort.has(sortBy) ? sortBy : 'name';

  const limit = Math.min(f.limit || 50, 500);
  const offset = f.offset || 0;

  const result = await env.D1.prepare(
    `SELECT * FROM companies WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  return jsonResponse({ companies: result.results, limit, offset });
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

export async function createCompany(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.name) return errorResponse('VALIDATION_ERROR', 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, website, description, company_type, sector, stage, investment_status, linkedin_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      body.name,
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

  // Trigger enrichment asynchronously
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

  return jsonResponse({
    company,
    contacts: contacts.results,
    deals: deals.results,
    tags: tags.results,
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

  const before = await env.D1.prepare(
    'SELECT * FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('COMPANY_NOT_FOUND', 404);

  const allowed = [
    'name',
    'website',
    'logo_url',
    'description',
    'company_type',
    'sector',
    'stage',
    'investment_status',
    'investment_amount',
    'investment_date',
    'ownership_pct',
    'current_valuation',
    'currency',
    'linkedin_url',
    'custom_fields',
  ];

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      updates.push(`${k} = ?`);
      binds.push(body[k]);
    }
  }
  if (updates.length === 0) return jsonResponse({ company: before });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  await env.D1.prepare(
    `UPDATE companies SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();

  const after = await env.D1.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'company',
    entity_id: id,
    before_data: before,
    after_data: after,
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ company: after });
}

export async function getCompanyNews(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const company = await env.D1.prepare(
    'SELECT id, name, last_news_summary FROM companies WHERE id = ? AND org_id = ?'
  ).bind(id, ctx.orgId).first<{ id: string; name: string; last_news_summary: string | null }>();

  if (!company) return errorResponse('COMPANY_NOT_FOUND', 404);

  const news = await env.D1.prepare(
    `SELECT id, subject, body_preview, sent_at, from_email
     FROM conversations
     WHERE org_id = ? AND source = 'manual' AND from_email = 'news@claude-search'
     ORDER BY sent_at DESC LIMIT 20`
  ).bind(ctx.orgId).all();

  return jsonResponse({
    company,
    news: news.results,
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

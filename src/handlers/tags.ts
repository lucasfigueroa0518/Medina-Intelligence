// TRD §5.1 — Tags CRUD
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';

export async function listTags(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const entityType = url.searchParams.get('entity_type');

  let sql = `SELECT t.*,
       (SELECT COUNT(*) FROM contact_tags ct WHERE ct.tag_id = t.id) as contact_count,
       (SELECT COUNT(*) FROM company_tags cot WHERE cot.tag_id = t.id) as company_count
     FROM tags t WHERE t.org_id = ?`;
  const binds: unknown[] = [ctx.orgId];

  if (entityType === 'contact' || entityType === 'company') {
    sql += ' AND t.entity_type = ?';
    binds.push(entityType);
  }

  sql += ' ORDER BY t.name ASC';

  const rows = await env.D1.prepare(sql).bind(...binds).all();
  return jsonResponse({ tags: rows.results });
}

export async function createTag(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ name: string; color?: string; entity_type?: string }>(request);
  if (!body?.name) return errorResponse('VALIDATION_ERROR', 400);

  const entityType = body.entity_type || 'contact';
  if (entityType !== 'contact' && entityType !== 'company') {
    return errorResponse('VALIDATION_ERROR', 400, 'entity_type must be "contact" or "company"');
  }

  const id = crypto.randomUUID();
  try {
    await env.D1.prepare(
      `INSERT INTO tags (id, org_id, name, color, entity_type, created_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, ctx.orgId, body.name, body.color || '#888888', entityType, ctx.userId).run();
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE'))
      return errorResponse('TAG_EXISTS', 409);
    throw e;
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'tag',
    entity_id: id,
    after_data: { name: body.name, entity_type: entityType },
    created_at: new Date().toISOString(),
  });

  const tag = await env.D1.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first();
  return jsonResponse({ tag }, 201);
}

export async function updateTag(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ name?: string; color?: string }>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400);

  const updates: string[] = [];
  const binds: unknown[] = [];
  if (body.name) { updates.push('name = ?'); binds.push(body.name); }
  if (body.color) { updates.push('color = ?'); binds.push(body.color); }
  if (updates.length === 0) return jsonResponse({ ok: true });

  await env.D1.prepare(
    `UPDATE tags SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`
  ).bind(...binds, id, ctx.orgId).run();

  const tag = await env.D1.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first();
  return jsonResponse({ tag });
}

export async function deleteTag(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    'DELETE FROM tags WHERE id = ? AND org_id = ?'
  ).bind(id, ctx.orgId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'tag_delete',
    entity_type: 'tag',
    entity_id: id,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

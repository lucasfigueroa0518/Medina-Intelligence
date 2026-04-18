// TRD §5.1 §11 — Deals CRUD
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';

export async function listDeals(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage');
  const companyId = url.searchParams.get('company_id');
  const ownerId = url.searchParams.get('owner_id');

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  if (stage) {
    where.push('stage = ?');
    binds.push(stage);
  }
  if (companyId) {
    where.push('company_id = ?');
    binds.push(companyId);
  }
  if (ownerId) {
    where.push('owner_id = ?');
    binds.push(ownerId);
  }

  const result = await env.D1.prepare(
    `SELECT * FROM deals WHERE ${where.join(' AND ')} ORDER BY expected_close ASC NULLS LAST LIMIT 500`
  ).bind(...binds).all();
  return jsonResponse({ deals: result.results });
}

export async function createDeal(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.title || !body?.company_id)
    return errorResponse('VALIDATION_ERROR', 400, 'title and company_id required');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deals
       (id, org_id, company_id, owner_id, title, stage, amount, currency, probability, expected_close, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      body.company_id,
      body.owner_id || ctx.userId,
      body.title,
      body.stage || 'prospect',
      body.amount || null,
      body.currency || 'USD',
      body.probability || 0,
      body.expected_close || null,
      body.notes || null,
      now,
      now
    )
    .run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'deal',
    entity_id: id,
    after_data: { id, title: body.title, stage: body.stage || 'prospect' },
    created_at: now,
  });

  await invalidateRagCache(ctx.orgId, env);
  const created = await env.D1.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first();
  return jsonResponse({ deal: created }, 201);
}

export async function getDeal(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const deal = await env.D1.prepare(
    'SELECT * FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);
  return jsonResponse({ deal });
}

export async function updateDeal(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400);

  const before = await env.D1.prepare(
    'SELECT * FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('DEAL_NOT_FOUND', 404);

  const allowed = [
    'title',
    'stage',
    'amount',
    'currency',
    'probability',
    'expected_close',
    'notes',
    'owner_id',
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
  if (updates.length === 0) return jsonResponse({ deal: before });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  await env.D1.prepare(`UPDATE deals SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();

  const after = await env.D1.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first();
  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: id,
    before_data: before,
    after_data: after,
    metadata: (before as any).stage !== (after as any).stage
      ? { stage_changed_from: (before as any).stage, stage_changed_to: (after as any).stage }
      : {},
    created_at: new Date().toISOString(),
  });
  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ deal: after });
}

export async function deleteDeal(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const before = await env.D1.prepare(
    'SELECT * FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('DEAL_NOT_FOUND', 404);

  await env.D1.prepare(
    `UPDATE deals SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(id).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'deal',
    entity_id: id,
    before_data: before,
    created_at: new Date().toISOString(),
  });
  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

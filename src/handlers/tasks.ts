// TRD §5.1 — Tasks CRUD
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { safelyRebuildContactDetailReadModelForContact } from '../lib/contact-detail-read-model';

export async function listTasks(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const assignee = url.searchParams.get('assignee');
  const contactId = url.searchParams.get('contact_id');

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (assignee) { where.push('assigned_to = ?'); binds.push(assignee); }
  if (contactId) { where.push('contact_id = ?'); binds.push(contactId); }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const whereClause = where.join(' AND ');

  const [rows, countResult] = await Promise.all([
    env.D1.prepare(
      `SELECT * FROM tasks WHERE ${whereClause} ORDER BY due_date ASC NULLS LAST LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM tasks WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
  ]);

  return jsonResponse({
    tasks: rows.results,
    total: countResult?.total || 0,
    limit,
    offset,
    has_more: offset + limit < (countResult?.total || 0),
  });
}

export async function createTask(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.title) return errorResponse('VALIDATION_ERROR', 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO tasks
       (id, org_id, title, description, contact_id, company_id, deal_id, assigned_to, created_by, status, priority, due_date, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      body.title,
      body.description || null,
      body.contact_id || null,
      body.company_id || null,
      body.deal_id || null,
      body.assigned_to || ctx.userId,
      ctx.userId,
      body.status || 'pending',
      body.priority || 'medium',
      body.due_date || null,
      now,
      now
    )
    .run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'task',
    entity_id: id,
    after_data: { title: body.title },
    created_at: now,
  });
  if (body.contact_id) {
    await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, body.contact_id, 'task_created');
  }

  const task = await env.D1.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  return jsonResponse({ task }, 201);
}

export async function updateTask(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400);

  const before = await env.D1.prepare(
    'SELECT * FROM tasks WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!before) return errorResponse('TASK_NOT_FOUND', 404);

  const allowed = ['title', 'description', 'status', 'priority', 'due_date', 'assigned_to', 'completed_at'];
  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      updates.push(`${k} = ?`);
      binds.push(body[k]);
    }
  }
  if (updates.length === 0) return jsonResponse({ task: before });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  await env.D1.prepare(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();

  const after = await env.D1.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'task',
    entity_id: id,
    before_data: before,
    after_data: after,
    created_at: new Date().toISOString(),
  });
  const contactId = (after as any)?.contact_id || (before as any)?.contact_id;
  if (contactId) {
    await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, contactId, 'task_updated');
  }
  return jsonResponse({ task: after });
}

export async function deleteTask(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const before = await env.D1.prepare(
    'SELECT contact_id FROM tasks WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first<{ contact_id: string | null }>();

  await env.D1.prepare(
    `UPDATE tasks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND org_id = ?`
  ).bind(id, ctx.orgId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'task',
    entity_id: id,
    created_at: new Date().toISOString(),
  });
  if (before?.contact_id) {
    await safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, before.contact_id, 'task_deleted');
  }
  return jsonResponse({ ok: true });
}

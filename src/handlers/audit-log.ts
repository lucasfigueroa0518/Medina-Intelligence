// TRD §5.1 — Audit log API
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse } from './utils';

export async function listAuditLog(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const entityType = url.searchParams.get('entity_type');
  const userId = url.searchParams.get('user_id');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  const where: string[] = ['org_id = ?'];
  const binds: unknown[] = [ctx.orgId];
  if (action) { where.push('action = ?'); binds.push(action); }
  if (entityType) { where.push('entity_type = ?'); binds.push(entityType); }
  if (userId) { where.push('user_id = ?'); binds.push(userId); }
  if (start) { where.push('created_at >= ?'); binds.push(start); }
  if (end) { where.push('created_at <= ?'); binds.push(end); }

  const rows = await env.D1.prepare(
    `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`
  ).bind(...binds).all();
  return jsonResponse({ entries: rows.results });
}

export async function getEntityHistory(
  entityType: string,
  entityId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT * FROM audit_log WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC`
  ).bind(ctx.orgId, entityType, entityId).all();
  return jsonResponse({ entries: rows.results });
}

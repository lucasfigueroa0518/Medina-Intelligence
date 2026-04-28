// TRD §5.1 — Events CRUD + link-outlook
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';

export async function listEvents(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const source = url.searchParams.get('source');
  const reconciliationStatus = url.searchParams.get('reconciliation_status');

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (start) {
    where.push('start_time >= ?');
    binds.push(start);
  }
  if (end) {
    where.push('start_time <= ?');
    binds.push(end);
  }
  if (source) {
    where.push('source = ?');
    binds.push(source);
  }
  if (reconciliationStatus) {
    where.push('reconciliation_status = ?');
    binds.push(reconciliationStatus);
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const whereClause = where.join(' AND ');

  const [result, countResult] = await Promise.all([
    env.D1.prepare(
      `SELECT * FROM events WHERE ${whereClause} ORDER BY start_time DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM events WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
  ]);

  return jsonResponse({
    events: result.results,
    total: countResult?.total || 0,
    limit,
    offset,
    has_more: offset + limit < (countResult?.total || 0),
  });
}

export async function getEvent(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const event = await env.D1.prepare(
    'SELECT * FROM events WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!event) return errorResponse('EVENT_NOT_FOUND', 404);

  const attendees = await env.D1.prepare(
    'SELECT * FROM event_attendees WHERE event_id = ?'
  ).bind(id).all();

  return jsonResponse({ event, attendees: attendees.results });
}

export async function updateEvent(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  const before = await env.D1.prepare(
    'SELECT * FROM events WHERE id = ? AND org_id = ? AND source = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId, 'manual').first();

  if (!before) return errorResponse('EVENT_NOT_FOUND_OR_READONLY', 404);

  const allowed = [
    'title',
    'event_type',
    'start_time',
    'end_time',
    'location',
    'description',
    'followup_status',
    'followup_due_date',
  ];
  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (body && k in body) {
      updates.push(`${k} = ?`);
      binds.push(body[k]);
    }
  }
  if (updates.length === 0) return jsonResponse({ event: before });

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  await env.D1.prepare(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds, id)
    .run();

  const after = await env.D1.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'event',
    entity_id: id,
    before_data: before,
    after_data: after,
    created_at: new Date().toISOString(),
  });
  return jsonResponse({ event: after });
}

export async function linkEventToOutlook(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ outlook_event_id: string }>(request);
  if (!body?.outlook_event_id) return errorResponse('VALIDATION_ERROR', 400);

  const event = await env.D1.prepare(
    'SELECT * FROM events WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!event) return errorResponse('EVENT_NOT_FOUND', 404);

  await env.D1.prepare(
    `UPDATE events SET outlook_event_id = ?, reconciliation_status = 'reconciled',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(body.outlook_event_id, id).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'event',
    entity_id: id,
    metadata: { manually_linked_to: body.outlook_event_id },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

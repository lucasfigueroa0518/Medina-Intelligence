// TRD §5.1, §3.16 — Approval queue list / approve / reject / bulk
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { canReadEmailContent } from '../lib/helpers';

export async function listApprovalQueue(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const entityType = url.searchParams.get('entity_type');

  const where: string[] = ['org_id = ?', 'status = ?'];
  const binds: unknown[] = [ctx.orgId, status];
  if (entityType) {
    where.push('entity_type = ?');
    binds.push(entityType);
  }

  const rows = await env.D1.prepare(
    `SELECT * FROM approval_queue WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`
  ).bind(...binds).all();

  // Email privacy gating: hide evidence quotes from non-participant reviewers
  const entries = await Promise.all(
    rows.results.map(async (row: any) => {
      if (row.source_communication_id && row.source_visibility === 'private') {
        const conv = await env.D1.prepare(
          'SELECT source, participant_user_ids, is_campaign_email FROM conversations WHERE id = ?'
        ).bind(row.source_communication_id).first<any>();

        const canRead = conv
          ? canReadEmailContent(conv, ctx.userId, ctx.userRole)
          : false;

        if (!canRead) {
          return {
            ...row,
            proposed_value: row.proposed_value,
            evidence_visible: false,
            source_note: 'Private email · evidence not visible',
          };
        }
      }
      return { ...row, evidence_visible: true };
    })
  );

  return jsonResponse({ entries });
}

export async function approveItem(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const item = await env.D1.prepare(
    `SELECT * FROM approval_queue WHERE id = ? AND org_id = ? AND status = 'pending'`
  ).bind(id, ctx.orgId).first<any>();
  if (!item) return errorResponse('APPROVAL_ALREADY_RESOLVED', 409);

  // Optimistic concurrency
  const result = await env.D1.prepare(
    `UPDATE approval_queue SET status = 'approved', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND status = 'pending'`
  ).bind(ctx.userId, id).run();

  if ((result.meta?.changes || 0) === 0) {
    return errorResponse('APPROVAL_ALREADY_RESOLVED', 409);
  }

  // Commit the proposed change
  await commitApproval(item, env);

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'approve',
    entity_type: (item.entity_type as any) || 'contact',
    entity_id: item.entity_id,
    after_data: { field: item.field_name, value: item.proposed_value },
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

export async function rejectItem(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `UPDATE approval_queue SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND org_id = ? AND status = 'pending'`
  ).bind(ctx.userId, id, ctx.orgId).run();

  if ((result.meta?.changes || 0) === 0) {
    return errorResponse('APPROVAL_ALREADY_RESOLVED', 409);
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'reject',
    entity_type: 'contact',
    entity_id: id,
    created_at: new Date().toISOString(),
  });
  return jsonResponse({ ok: true });
}

export async function bulkApprove(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ ids: string[] }>(request);
  if (!body?.ids?.length) return errorResponse('VALIDATION_ERROR', 400);

  const resolved: string[] = [];
  const conflicts: string[] = [];
  for (const id of body.ids) {
    const r = await approveItem(id, ctx, env);
    if (r.status === 200) resolved.push(id);
    else conflicts.push(id);
  }
  return jsonResponse({ resolved, conflicts });
}

export async function bulkReject(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ ids: string[] }>(request);
  if (!body?.ids?.length) return errorResponse('VALIDATION_ERROR', 400);

  const resolved: string[] = [];
  const conflicts: string[] = [];
  for (const id of body.ids) {
    const r = await rejectItem(id, ctx, env);
    if (r.status === 200) resolved.push(id);
    else conflicts.push(id);
  }
  return jsonResponse({ resolved, conflicts });
}

async function commitApproval(item: any, env: Env): Promise<void> {
  if (!item.field_name || !item.proposed_value) return;

  let value: unknown;
  try {
    value = JSON.parse(item.proposed_value);
  } catch {
    value = item.proposed_value;
  }

  const table = item.entity_type === 'contact' ? 'contacts' : 'companies';
  // Whitelist-only to prevent SQL injection via field_name
  const allowed = new Set([
    'job_title',
    'company_id',
    'stage',
    'current_valuation',
    'topics_of_interest',
    'pain_points',
    'investment_thesis_tags',
    'sector',
    'bio_summary',
  ]);
  if (!allowed.has(item.field_name)) return;

  try {
    await env.D1.prepare(
      `UPDATE ${table} SET ${item.field_name} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
      .bind(typeof value === 'string' ? value : JSON.stringify(value), item.entity_id)
      .run();
  } catch (e) {
    console.error('Commit approval failed:', e);
  }
}

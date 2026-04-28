// TRD §5.1, §3.16 — Approval queue list / approve / reject / bulk + progressive enrichment
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { canReadEmailContent, getSharingFlags } from '../lib/helpers';
import { commitProgressiveApproval, markFieldsHumanEdited } from '../lib/progressive-enrichment';
import { triggerContactEnrichment } from '../lib/enrichment';

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

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const whereClause = where.join(' AND ');

  const [rows, countResult, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT * FROM approval_queue WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM approval_queue WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const entries = await Promise.all(
    rows.results.map(async (row: any) => {
      let proposedDisplay = row.proposed_value;
      let metadata: any = null;
      try {
        const parsed = JSON.parse(row.proposed_value);
        if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
          proposedDisplay = String(parsed.value);
          metadata = parsed.metadata || null;
        } else if (typeof parsed === 'string') {
          proposedDisplay = parsed;
        }
      } catch { /* use raw value */ }

      const base = {
        ...row,
        proposed_value: proposedDisplay,
        current_value: metadata?.current_value ?? null,
        source_description: metadata?.source_description ?? row.change_type ?? null,
        source_type: metadata?.source_type ?? row.change_type ?? null,
      };

      if (row.source_communication_id && row.source_visibility === 'private') {
        const conv = await env.D1.prepare(
          'SELECT source, participant_user_ids, is_campaign_email FROM conversations WHERE id = ?'
        ).bind(row.source_communication_id).first<any>();

        const canRead = conv
          ? canReadEmailContent(conv, ctx.userId, ctx.userRole, sharingFlags)
          : false;

        if (!canRead) {
          return {
            ...base,
            evidence_visible: false,
            source_note: 'Private email · evidence not visible',
          };
        }
      }
      return { ...base, evidence_visible: true };
    })
  );

  return jsonResponse({
    entries,
    total: countResult?.total || 0,
    limit,
    offset,
    has_more: offset + limit < (countResult?.total || 0),
  });
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
  const { reEnrich } = await commitApproval(item, env);

  // Approving a queued change is human intent — record it so future enrichment
  // defers to the queue for this field instead of auto-overwriting.
  if (item.field_name && (item.entity_type === 'company' || item.entity_type === 'contact' || item.entity_type === 'deal')) {
    await markFieldsHumanEdited(ctx.orgId, item.entity_type, item.entity_id, [item.field_name], ctx.userId, env)
      .catch(e => console.error('[approval] markFieldsHumanEdited failed:', e));
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'approve',
    entity_type: (item.entity_type as any) || 'contact',
    entity_id: item.entity_id,
    after_data: { field: item.field_name, value: item.proposed_value },
    created_at: new Date().toISOString(),
  });

  if (reEnrich && item.entity_type === 'contact') {
    triggerContactEnrichment(item.entity_id, ctx.orgId, env).catch(e =>
      console.error(`[approval] re-enrich after approval failed:`, e)
    );
  }

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true, re_enrich_triggered: reEnrich || false });
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

async function commitApproval(item: any, env: Env): Promise<{ reEnrich?: boolean }> {
  if (!item.field_name || !item.proposed_value) return {};

  if (item.change_type === 'progressive_update') {
    return commitProgressiveApproval(item, env);
  }

  let value: string;
  try {
    const parsed = JSON.parse(item.proposed_value);
    if (typeof parsed === 'string') {
      value = parsed;
    } else if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
      value = String(parsed.value);
    } else {
      value = typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
    }
  } catch {
    value = item.proposed_value;
  }

  const table = item.entity_type === 'contact' ? 'contacts' : 'companies';
  const allowed = new Set([
    'full_name', 'job_title', 'company_id', 'phone', 'email',
    'linkedin_url', 'twitter_url', 'location',
    'stage', 'current_valuation', 'topics_of_interest',
    'pain_points', 'investment_thesis_tags', 'sector', 'bio_summary',
    'investment_focus', 'check_size_range', 'communication_channel_preference',
    'introduced_via', 'fund_name',
  ]);
  if (!allowed.has(item.field_name)) return {};

  try {
    await env.D1.prepare(
      `UPDATE ${table} SET ${item.field_name} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
      .bind(value, item.entity_id)
      .run();
  } catch (e) {
    console.error('Commit approval failed:', e);
  }
  return {};
}

export async function getPendingUpdates(
  entityType: string,
  entityId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT id, field_name, proposed_value, confidence, source_communication_id, created_at, change_type
     FROM approval_queue
     WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 50`
  ).bind(ctx.orgId, entityType, entityId).all();

  const updates = rows.results.map((row: any) => {
    let proposedDisplay = row.proposed_value;
    let metadata: any = null;
    try {
      const parsed = JSON.parse(row.proposed_value);
      if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
        proposedDisplay = String(parsed.value);
        metadata = parsed.metadata || null;
      } else if (typeof parsed === 'string') {
        proposedDisplay = parsed;
      }
    } catch { /* use raw value */ }

    return {
      id: row.id,
      field_name: row.field_name,
      proposed_value: proposedDisplay,
      confidence: row.confidence,
      source_description: metadata?.source_description || metadata?.source_type || row.change_type,
      source_type: metadata?.source_type || row.change_type,
      current_value: metadata?.current_value || null,
      created_at: row.created_at,
    };
  });

  return jsonResponse({ updates });
}

export async function approveAllForEntity(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ entity_type: string; entity_id: string }>(request);
  if (!body?.entity_type || !body?.entity_id) return errorResponse('VALIDATION_ERROR', 400);

  const pending = await env.D1.prepare(
    `SELECT id FROM approval_queue
     WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND status = 'pending'`
  ).bind(ctx.orgId, body.entity_type, body.entity_id).all<{ id: string }>();

  const resolved: string[] = [];
  for (const row of pending.results) {
    const r = await approveItem(row.id, ctx, env);
    if (r.status === 200) resolved.push(row.id);
  }

  return jsonResponse({ ok: true, resolved_count: resolved.length });
}

export async function rejectAllForEntity(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ entity_type: string; entity_id: string }>(request);
  if (!body?.entity_type || !body?.entity_id) return errorResponse('VALIDATION_ERROR', 400);

  const result = await env.D1.prepare(
    `UPDATE approval_queue SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND status = 'pending'`
  ).bind(ctx.userId, ctx.orgId, body.entity_type, body.entity_id).run();

  return jsonResponse({ ok: true, resolved_count: result.meta?.changes || 0 });
}

export async function listApprovalQueueGrouped(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const entityTypeFilter = url.searchParams.get('entity_type');
  const sourceTypeFilter = url.searchParams.get('source_type');

  const where: string[] = ['aq.org_id = ?', "aq.status = 'pending'"];
  const binds: unknown[] = [ctx.orgId];

  if (entityTypeFilter) {
    where.push('aq.entity_type = ?');
    binds.push(entityTypeFilter);
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const rows = await env.D1.prepare(
    `SELECT aq.*,
            CASE WHEN aq.entity_type = 'contact' THEN (SELECT full_name FROM contacts WHERE id = aq.entity_id)
                 WHEN aq.entity_type = 'company' THEN (SELECT name FROM companies WHERE id = aq.entity_id)
                 ELSE NULL END as entity_name,
            CASE WHEN aq.entity_type = 'contact' THEN (SELECT avatar_url FROM contacts WHERE id = aq.entity_id)
                 ELSE NULL END as entity_avatar
     FROM approval_queue aq
     WHERE ${where.join(' AND ')}
     ORDER BY aq.entity_id, aq.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  const grouped = new Map<string, any>();
  for (const row of rows.results as any[]) {
    const key = `${row.entity_type}:${row.entity_id}`;

    let proposedDisplay = row.proposed_value;
    let metadata: any = null;
    try {
      const parsed = JSON.parse(row.proposed_value);
      if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
        proposedDisplay = String(parsed.value);
        metadata = parsed.metadata || null;
      } else if (typeof parsed === 'string') {
        proposedDisplay = parsed;
      }
    } catch { /* use raw */ }

    if (sourceTypeFilter && metadata?.source_type !== sourceTypeFilter && row.change_type !== sourceTypeFilter) {
      continue;
    }

    const entry = {
      id: row.id,
      field_name: row.field_name,
      proposed_value: proposedDisplay,
      current_value: metadata?.current_value || null,
      confidence: row.confidence,
      source_type: metadata?.source_type || row.change_type,
      source_description: metadata?.source_description || row.change_type,
      created_at: row.created_at,
      change_type: row.change_type,
    };

    if (grouped.has(key)) {
      grouped.get(key).updates.push(entry);
    } else {
      grouped.set(key, {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        entity_name: row.entity_name,
        entity_avatar: row.entity_avatar,
        updates: [entry],
      });
    }
  }

  return jsonResponse({ entities: Array.from(grouped.values()) });
}

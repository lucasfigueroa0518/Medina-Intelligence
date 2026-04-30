// TRD §5.1 §11 — Deals CRUD + deal contacts, action items, notes, timeline, metrics
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { canReadEmailContent, getSharingFlags } from '../lib/helpers';

// ---------------------------------------------------------------------------
// GET /api/deals
// ---------------------------------------------------------------------------

export async function listDeals(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage');
  const companyId = url.searchParams.get('company_id');
  const ownerId = url.searchParams.get('owner_id');

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const where: string[] = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (stage) {
    where.push('d.stage = ?');
    binds.push(stage);
  }
  if (companyId) {
    where.push('d.company_id = ?');
    binds.push(companyId);
  }
  if (ownerId) {
    where.push('d.owner_id = ?');
    binds.push(ownerId);
  }

  const whereClause = where.join(' AND ');

  const [result, countResult] = await Promise.all([
    env.D1.prepare(
      // last_inferred_activity_date: query-time MAX from the same two-hop join
      // getDealTimeline uses (deal_contacts → conversation_contacts →
      // conversations). Fixes the staleness of deals.last_activity_date,
      // which is only bumped by manual deal edits / Marty's agent-tools and
      // does NOT update when an inbound conversation lands. The legacy
      // last_activity_date column is left untouched on the wire (still in
      // d.*) — frontend reads the new field with a fallback to the old one.
      // See Day 4 Priority 6 audit, Section 1.3 finding.
      `SELECT d.*, co.name AS company_name, co.sector AS company_sector,
              u.full_name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM deal_contacts dc WHERE dc.deal_id = d.id) AS contacts_count,
              (SELECT COUNT(*) FROM deal_action_items dai WHERE dai.deal_id = d.id AND dai.status IN ('open','in_progress')) AS open_items_count,
              (SELECT MAX(conv.sent_at)
                 FROM deal_contacts dc
                 JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
                 JOIN conversations conv ON cc.conversation_id = conv.id
                WHERE dc.deal_id = d.id) AS last_inferred_activity_date
       FROM deals d
       LEFT JOIN companies co ON d.company_id = co.id
       LEFT JOIN users u ON d.owner_id = u.id
       WHERE ${whereClause}
       ORDER BY d.expected_close ASC NULLS LAST
       LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all(),
    env.D1.prepare(
      `SELECT COUNT(*) as total FROM deals d WHERE ${whereClause}`
    ).bind(...binds).first<{ total: number }>(),
  ]);

  return jsonResponse({
    deals: result.results,
    total: countResult?.total || 0,
    limit,
    offset,
    has_more: offset + limit < (countResult?.total || 0),
  });
}

// ---------------------------------------------------------------------------
// POST /api/deals
// ---------------------------------------------------------------------------

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
       (id, org_id, company_id, owner_id, title, stage, amount, currency,
        probability, expected_close, notes, valuation, our_allocation,
        instrument_type, lead_source, thesis_fit,
        stage_changed_at, last_activity_date, days_in_stage,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      body.company_id,
      body.owner_id || ctx.userId,
      body.title,
      body.stage || 'prospect',
      body.amount ?? null,
      body.currency || 'USD',
      body.probability ?? 0,
      body.expected_close ?? null,
      body.notes ?? null,
      body.valuation ?? null,
      body.our_allocation ?? null,
      body.instrument_type ?? null,
      body.lead_source ?? null,
      body.thesis_fit ?? null,
      now, // stage_changed_at
      now, // last_activity_date
      now,
      now
    )
    .run();

  // Build per-field provenance for source_metadata
  const provenanceFields = [
    'amount', 'valuation', 'our_allocation', 'instrument_type',
    'lead_source', 'thesis_fit', 'expected_close', 'probability', 'stage',
  ] as const;
  const sourceMetadata: Record<string, { source: string; set_by: string; set_at: string }> = {};
  for (const field of provenanceFields) {
    const val = field === 'stage' ? (body.stage || 'prospect') : body[field];
    if (val != null) {
      sourceMetadata[field] = { source: 'manual', set_by: ctx.userId, set_at: now };
    }
  }
  await env.D1.prepare(
    `UPDATE deals SET source_metadata = ? WHERE id = ?`
  ).bind(JSON.stringify(sourceMetadata), id).run();

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
  // Embed the new deal so MARTy's broad and per-entity Vectorize queries can
  // surface it. Inline (no ctxExec available here) so the embedding lands
  // before the next ingest run dedups against an absent record. Wrapped in
  // try/catch — embed failure must not block deal creation.
  try {
    const { embedDeal } = await import('../lib/embedding');
    await embedDeal(id, ctx.orgId, env);
  } catch (e) {
    console.error(`[deals] embed failed for new deal ${id}:`, e);
  }
  const created = await env.D1.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first();
  return jsonResponse({ deal: created }, 201);
}

// ---------------------------------------------------------------------------
// GET /api/deals/:id
// ---------------------------------------------------------------------------

export async function getDeal(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const deal = await env.D1.prepare(
    // See listDeals comment above re: last_inferred_activity_date — same
    // two-hop join, surfaced alongside the legacy last_activity_date column.
    `SELECT d.*, co.name AS company_name, co.sector AS company_sector,
            u.full_name AS owner_name, u.email AS owner_email,
            (SELECT MAX(conv.sent_at)
               FROM deal_contacts dc
               JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
               JOIN conversations conv ON cc.conversation_id = conv.id
              WHERE dc.deal_id = d.id) AS last_inferred_activity_date
     FROM deals d
     LEFT JOIN companies co ON d.company_id = co.id
     LEFT JOIN users u ON d.owner_id = u.id
     WHERE d.id = ? AND d.org_id = ? AND d.deleted_at IS NULL`
  ).bind(id, ctx.orgId).first();

  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const [contacts, actionItems, notes, openActionCount, usersResult] = await Promise.all([
    env.D1.prepare(
      `SELECT dc.id AS deal_contact_id, dc.role, dc.side, dc.added_at,
              c.id, c.full_name, c.email, c.job_title
       FROM deal_contacts dc
       JOIN contacts c ON dc.contact_id = c.id AND c.deleted_at IS NULL
       WHERE dc.deal_id = ? AND dc.org_id = ?
       ORDER BY dc.side, dc.role`
    ).bind(id, ctx.orgId).all(),

    env.D1.prepare(
      `SELECT dai.*, u.full_name AS assignee_name
       FROM deal_action_items dai
       LEFT JOIN users u ON dai.assignee_id = u.id
       WHERE dai.deal_id = ? AND dai.org_id = ?
       ORDER BY CASE dai.status
         WHEN 'open' THEN 0
         WHEN 'in_progress' THEN 1
         WHEN 'completed' THEN 2
         WHEN 'cancelled' THEN 3
       END, dai.due_date ASC NULLS LAST`
    ).bind(id, ctx.orgId).all(),

    env.D1.prepare(
      `SELECT dn.*, u.full_name AS author_name
       FROM deal_notes dn
       LEFT JOIN users u ON dn.author_id = u.id
       WHERE dn.deal_id = ? AND dn.org_id = ?
       ORDER BY dn.created_at DESC`
    ).bind(id, ctx.orgId).all(),

    env.D1.prepare(
      `SELECT COUNT(*) AS cnt FROM deal_action_items
       WHERE deal_id = ? AND org_id = ? AND status IN ('open','in_progress')`
    ).bind(id, ctx.orgId).first<{ cnt: number }>(),

    // Platform users for this org (for "Ours" section assignments)
    env.D1.prepare(
      `SELECT id, full_name, email, avatar_url FROM users WHERE org_id = ? AND deleted_at IS NULL`
    ).bind(ctx.orgId).all(),
  ]);

  const contactsByGroup: Record<string, any[]> = { theirs: [], ours: [], other: [] };
  for (const c of contacts.results as any[]) {
    const side = c.side || 'other';
    (contactsByGroup[side] || contactsByGroup.other).push(c);
  }

  return jsonResponse({
    deal,
    contacts: contactsByGroup,
    action_items: actionItems.results,
    notes: notes.results,
    open_action_items_count: openActionCount?.cnt ?? 0,
    company: { id: (deal as any).company_id, name: (deal as any).company_name, sector: (deal as any).company_sector },
    users: usersResult.results,
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/deals/:id
// ---------------------------------------------------------------------------

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
    'valuation',
    'our_allocation',
    'instrument_type',
    'actual_close_date',
    'lead_source',
    'thesis_fit',
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

  // --- Per-field provenance tracking in source_metadata ---
  const trackedFields = [
    'amount', 'valuation', 'our_allocation', 'instrument_type',
    'lead_source', 'thesis_fit', 'expected_close', 'probability', 'stage',
  ];
  const existingMeta: Record<string, any> = (() => {
    try {
      return JSON.parse((before as any).source_metadata || '{}');
    } catch {
      return {};
    }
  })();
  const metaNow = new Date().toISOString();

  for (const field of trackedFields) {
    if (field in body && body[field] !== (before as any)[field]) {
      const entry: Record<string, any> = {
        source: body._source || 'manual',
        set_by: ctx.userId,
        set_at: metaNow,
        source_id: body._source_id || null,
      };
      if (field === 'stage') {
        entry.previous = (before as any).stage;
      }
      existingMeta[field] = entry;
    }
  }

  updates.push('source_metadata = ?');
  binds.push(JSON.stringify(existingMeta));

  // Stage transition logic
  const stageChanged =
    'stage' in body && body.stage !== (before as any).stage;
  let auditMetadata: Record<string, unknown> = {};

  if (stageChanged) {
    const oldStageChangedAt = (before as any).stage_changed_at;
    let daysInOldStage = 0;
    if (oldStageChangedAt) {
      const elapsed = Date.now() - new Date(oldStageChangedAt).getTime();
      daysInOldStage = Math.floor(elapsed / 86_400_000);
    }

    updates.push(`stage_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    updates.push('days_in_stage = 0');

    auditMetadata = {
      old_stage: (before as any).stage,
      new_stage: body.stage,
      days_in_old_stage: daysInOldStage,
    };
  }

  updates.push(`last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

  await env.D1.prepare(
    `UPDATE deals SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds, id).run();

  const after = await env.D1.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: id,
    before_data: before,
    after_data: after,
    metadata: auditMetadata,
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);

  // Re-embed when content-bearing fields change. Stage/amount don't change
  // the embedding text materially but title/notes/thesis do; we re-embed on
  // any of those to keep RAG fresh.
  const contentFields = ['title', 'stage', 'notes', 'thesis_fit', 'amount', 'valuation', 'our_allocation', 'instrument_type'];
  const contentChanged = contentFields.some(f => f in body && body[f] !== (before as any)[f]);
  if (contentChanged) {
    try {
      const { reembedDeal } = await import('../lib/embedding');
      await reembedDeal(id, ctx.orgId, env);
    } catch (e) {
      console.error(`[deals] reembed failed for ${id}:`, e);
    }
  }

  return jsonResponse({ deal: after });
}

// ---------------------------------------------------------------------------
// DELETE /api/deals/:id  (soft delete)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /api/deals/:id/associations
// ---------------------------------------------------------------------------

export async function getDealAssociations(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT ea.id, ea.entity_a_type, ea.entity_a_id, ea.entity_b_type, ea.entity_b_id,
            ea.association_type, ea.strength, ea.reason, ea.evidence_count,
            ea.first_seen_at, ea.last_seen_at,
            CASE
              WHEN ea.entity_a_type = 'deal' AND ea.entity_a_id = ? THEN ea.entity_b_type
              ELSE ea.entity_a_type
            END as other_type,
            CASE
              WHEN ea.entity_a_type = 'deal' AND ea.entity_a_id = ? THEN ea.entity_b_id
              ELSE ea.entity_a_id
            END as other_id
     FROM entity_associations ea
     WHERE ea.org_id = ?
       AND ((ea.entity_a_type = 'deal' AND ea.entity_a_id = ?)
         OR (ea.entity_b_type = 'deal' AND ea.entity_b_id = ?))
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
    }

    if (entityName) {
      hydrated.push({ ...row, entity_name: entityName, entity_title: entityTitle });
    }
  }

  return jsonResponse({ associations: hydrated });
}

// ---------------------------------------------------------------------------
// GET /api/deals/:id/timeline
// ---------------------------------------------------------------------------

export async function getDealTimeline(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 200);

  // Verify deal exists
  const deal = await env.D1.prepare(
    'SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const [conversations, events, notes, auditEntries, sharingFlags] = await Promise.all([
    // Conversations involving deal contacts
    env.D1.prepare(
      `SELECT DISTINCT conv.id, conv.subject AS title, conv.sent_at AS timestamp,
              'conversation' AS type, conv.source AS subtype, conv.body_preview,
              conv.source AS conv_source, conv.participant_user_ids, conv.is_campaign_email
       FROM deal_contacts dc
       JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
       JOIN conversations conv ON cc.conversation_id = conv.id
       WHERE dc.deal_id = ? AND dc.org_id = ? AND conv.org_id = ?
       ORDER BY conv.sent_at DESC
       LIMIT ?`
    ).bind(id, ctx.orgId, ctx.orgId, limit).all(),

    // Events involving deal contacts
    env.D1.prepare(
      `SELECT DISTINCT e.id, e.title, e.start_time AS timestamp,
              'event' AS type, e.event_type AS subtype
       FROM deal_contacts dc
       JOIN event_attendees ea ON dc.contact_id = ea.contact_id
       JOIN events e ON ea.event_id = e.id
       WHERE dc.deal_id = ? AND dc.org_id = ? AND e.org_id = ? AND e.deleted_at IS NULL
       ORDER BY e.start_time DESC
       LIMIT ?`
    ).bind(id, ctx.orgId, ctx.orgId, limit).all(),

    // Deal notes
    env.D1.prepare(
      `SELECT dn.id, dn.content AS title, dn.created_at AS timestamp,
              'note' AS type, 'deal_note' AS subtype,
              u.full_name AS author_name
       FROM deal_notes dn
       LEFT JOIN users u ON dn.author_id = u.id
       WHERE dn.deal_id = ? AND dn.org_id = ?
       ORDER BY dn.created_at DESC
       LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),

    // Audit log entries
    env.D1.prepare(
      `SELECT al.id, al.action, al.created_at AS timestamp,
              'audit' AS type,
              al.metadata, al.before_data, al.after_data,
              u.full_name AS user_name
       FROM audit_log al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE al.entity_type = 'deal' AND al.entity_id = ? AND al.org_id = ?
       ORDER BY al.created_at DESC
       LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),

    getSharingFlags(ctx.orgId, env),
  ]);

  const parsedAudit = (auditEntries.results as any[]).map(row => {
    let metadata: any = {};
    let before: any = null;
    let after: any = null;
    try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
    try { before = JSON.parse(row.before_data || 'null'); } catch {}
    try { after = JSON.parse(row.after_data || 'null'); } catch {}

    const changedFields: string[] = [];
    if (row.action === 'update' && before && after) {
      const skip = new Set(['updated_at', 'last_activity_date', 'stage_changed_at', 'days_in_stage', 'source_metadata', 'custom_fields']);
      for (const key of Object.keys(after)) {
        if (skip.has(key)) continue;
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
          changedFields.push(key);
        }
      }
    }

    return {
      id: row.id,
      type: 'audit',
      action: row.action,
      timestamp: row.timestamp,
      user_name: row.user_name,
      metadata,
      changed_fields: changedFields,
      after_snapshot: after,
    };
  });

  const conversationsWithAccess = (conversations.results as any[]).map((c: any) => {
    const canRead = canReadEmailContent(
      {
        source: c.conv_source,
        participant_user_ids: c.participant_user_ids,
        is_campaign_email: c.is_campaign_email,
      } as any,
      ctx.userId,
      ctx.userRole,
      sharingFlags
    );
    return {
      ...c,
      canReadContent: canRead,
      body_preview: canRead ? c.body_preview : null,
    };
  });

  const entries = [
    ...conversationsWithAccess,
    ...events.results,
    ...notes.results,
    ...parsedAudit,
  ]
    .sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);

  return jsonResponse({ entries });
}

// ---------------------------------------------------------------------------
// Deal Contacts CRUD
// ---------------------------------------------------------------------------

// POST /api/deals/:id/contacts
export async function addDealContact(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.contact_id)
    return errorResponse('VALIDATION_ERROR', 400, 'contact_id is required');

  // Verify deal exists
  const deal = await env.D1.prepare(
    'SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(dealId, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      dealId,
      body.contact_id,
      body.role ?? null,
      body.side ?? null,
      now
    )
    .run();

  // Update last_activity_date on the deal
  await env.D1.prepare(
    `UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(dealId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'add_contact', contact_id: body.contact_id, role: body.role },
    created_at: now,
  });

  return jsonResponse({ deal_contact: { id, deal_id: dealId, contact_id: body.contact_id, role: body.role, side: body.side } }, 201);
}

// DELETE /api/deals/:dealId/contacts/:contactId
export async function removeDealContact(
  dealId: string,
  contactId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    'DELETE FROM deal_contacts WHERE deal_id = ? AND contact_id = ? AND org_id = ?'
  ).bind(dealId, contactId, ctx.orgId).run();

  await env.D1.prepare(
    `UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(dealId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'remove_contact', contact_id: contactId },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

// GET /api/deals/:id/contacts
export async function listDealContacts(
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `SELECT dc.id AS deal_contact_id, dc.role, dc.side, dc.added_at,
            c.id AS contact_id, c.full_name, c.email, c.job_title
     FROM deal_contacts dc
     JOIN contacts c ON dc.contact_id = c.id AND c.deleted_at IS NULL
     WHERE dc.deal_id = ? AND dc.org_id = ?
     ORDER BY dc.side, dc.role`
  ).bind(dealId, ctx.orgId).all();

  // Group by side
  const grouped: Record<string, any[]> = { theirs: [], ours: [], other: [] };
  for (const row of result.results as any[]) {
    const side = row.side || 'other';
    if (!grouped[side]) grouped[side] = [];
    grouped[side].push(row);
  }

  return jsonResponse({ deal_contacts: grouped });
}

// ---------------------------------------------------------------------------
// Deal Action Items CRUD
// ---------------------------------------------------------------------------

// GET /api/deals/:id/action-items
export async function listDealActionItems(
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `SELECT dai.*, u.full_name AS assignee_name
     FROM deal_action_items dai
     LEFT JOIN users u ON dai.assignee_id = u.id
     WHERE dai.deal_id = ? AND dai.org_id = ?
     ORDER BY CASE dai.status
       WHEN 'open' THEN 0
       WHEN 'in_progress' THEN 1
       WHEN 'completed' THEN 2
       WHEN 'cancelled' THEN 3
     END, dai.due_date ASC NULLS LAST`
  ).bind(dealId, ctx.orgId).all();

  return jsonResponse({ action_items: result.results });
}

// POST /api/deals/:id/action-items
export async function createDealActionItem(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.description)
    return errorResponse('VALIDATION_ERROR', 400, 'description is required');

  // Verify deal exists
  const deal = await env.D1.prepare(
    'SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(dealId, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deal_action_items
       (id, org_id, deal_id, description, assignee_id, due_date, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 'manual', ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      dealId,
      body.description,
      body.assignee_id ?? null,
      body.due_date ?? null,
      now,
      now
    )
    .run();

  // Update last_activity_date on the deal
  await env.D1.prepare(
    `UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(dealId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'create_action_item', action_item_id: id },
    created_at: now,
  });

  const created = await env.D1.prepare('SELECT * FROM deal_action_items WHERE id = ?').bind(id).first();
  return jsonResponse({ action_item: created }, 201);
}

// PATCH /api/deals/:dealId/action-items/:itemId
export async function updateDealActionItem(
  request: Request,
  dealId: string,
  itemId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400);

  const before = await env.D1.prepare(
    'SELECT * FROM deal_action_items WHERE id = ? AND deal_id = ? AND org_id = ?'
  ).bind(itemId, dealId, ctx.orgId).first();
  if (!before) return errorResponse('ACTION_ITEM_NOT_FOUND', 404);

  const allowed = ['description', 'assignee_id', 'due_date', 'status'];
  const updates: string[] = [];
  const binds: unknown[] = [];

  for (const k of allowed) {
    if (k in body) {
      updates.push(`${k} = ?`);
      binds.push(body[k]);
    }
  }

  if (updates.length === 0) return jsonResponse({ action_item: before });

  // Set completed_at when status changes to completed
  if ('status' in body && body.status === 'completed' && (before as any).status !== 'completed') {
    updates.push(`completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  }
  // Clear completed_at if moving away from completed
  if ('status' in body && body.status !== 'completed' && (before as any).status === 'completed') {
    updates.push('completed_at = NULL');
  }

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

  await env.D1.prepare(
    `UPDATE deal_action_items SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds, itemId).run();

  // Update last_activity_date on the deal
  await env.D1.prepare(
    `UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(dealId).run();

  const after = await env.D1.prepare('SELECT * FROM deal_action_items WHERE id = ?').bind(itemId).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'update_action_item', action_item_id: itemId },
    before_data: before,
    after_data: after,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ action_item: after });
}

// DELETE /api/deals/:dealId/action-items/:itemId
export async function deleteDealActionItem(
  dealId: string,
  itemId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const existing = await env.D1.prepare(
    'SELECT id FROM deal_action_items WHERE id = ? AND deal_id = ? AND org_id = ?'
  ).bind(itemId, dealId, ctx.orgId).first();
  if (!existing) return errorResponse('ACTION_ITEM_NOT_FOUND', 404);

  await env.D1.prepare('DELETE FROM deal_action_items WHERE id = ?').bind(itemId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'hard_delete',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'delete_action_item', action_item_id: itemId },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Deal Notes CRUD
// ---------------------------------------------------------------------------

// GET /api/deals/:id/notes
export async function listDealNotes(
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `SELECT dn.*, u.full_name AS author_name
     FROM deal_notes dn
     LEFT JOIN users u ON dn.author_id = u.id
     WHERE dn.deal_id = ? AND dn.org_id = ?
     ORDER BY dn.created_at DESC`
  ).bind(dealId, ctx.orgId).all();

  return jsonResponse({ notes: result.results });
}

// POST /api/deals/:id/notes
export async function createDealNote(
  request: Request,
  dealId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.content || typeof body.content !== 'string' || !body.content.trim())
    return errorResponse('VALIDATION_ERROR', 400, 'content is required');

  // Verify deal exists
  const deal = await env.D1.prepare(
    'SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(dealId, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deal_notes (id, org_id, deal_id, author_id, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, ctx.orgId, dealId, ctx.userId, body.content.trim(), now, now)
    .run();

  // Update last_activity_date on the deal
  await env.D1.prepare(
    `UPDATE deals SET last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(dealId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'create_note', note_id: id },
    created_at: now,
  });

  const created = await env.D1.prepare(
    `SELECT dn.*, u.full_name AS author_name
     FROM deal_notes dn
     LEFT JOIN users u ON dn.author_id = u.id
     WHERE dn.id = ?`
  ).bind(id).first();

  return jsonResponse({ note: created }, 201);
}

// PATCH /api/deals/:dealId/notes/:noteId
export async function updateDealNote(
  request: Request,
  dealId: string,
  noteId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<any>(request);
  if (!body?.content || typeof body.content !== 'string' || !body.content.trim())
    return errorResponse('VALIDATION_ERROR', 400, 'content is required');

  const existing = await env.D1.prepare(
    'SELECT * FROM deal_notes WHERE id = ? AND deal_id = ? AND org_id = ?'
  ).bind(noteId, dealId, ctx.orgId).first();
  if (!existing) return errorResponse('NOTE_NOT_FOUND', 404);

  // Only the author can edit their own notes
  if ((existing as any).author_id !== ctx.userId)
    return errorResponse('FORBIDDEN', 403, 'You can only edit your own notes');

  await env.D1.prepare(
    `UPDATE deal_notes SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).bind(body.content.trim(), noteId).run();

  const after = await env.D1.prepare(
    `SELECT dn.*, u.full_name AS author_name
     FROM deal_notes dn
     LEFT JOIN users u ON dn.author_id = u.id
     WHERE dn.id = ?`
  ).bind(noteId).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'update_note', note_id: noteId },
    before_data: existing,
    after_data: after,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ note: after });
}

// DELETE /api/deals/:dealId/notes/:noteId
export async function deleteDealNote(
  dealId: string,
  noteId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const existing = await env.D1.prepare(
    'SELECT * FROM deal_notes WHERE id = ? AND deal_id = ? AND org_id = ?'
  ).bind(noteId, dealId, ctx.orgId).first();
  if (!existing) return errorResponse('NOTE_NOT_FOUND', 404);

  // Only the author can delete their own notes
  if ((existing as any).author_id !== ctx.userId)
    return errorResponse('FORBIDDEN', 403, 'You can only delete your own notes');

  await env.D1.prepare('DELETE FROM deal_notes WHERE id = ?').bind(noteId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'hard_delete',
    entity_type: 'deal',
    entity_id: dealId,
    metadata: { sub_action: 'delete_note', note_id: noteId },
    before_data: existing,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// GET /api/deals/metrics
// ---------------------------------------------------------------------------

export async function getDealMetrics(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const [byStage, avgDays, pipeline, staleDeals] = await Promise.all([
    // Total deals by stage with aggregate amount
    env.D1.prepare(
      `SELECT stage, COUNT(*) AS deal_count, COALESCE(SUM(amount), 0) AS total_amount
       FROM deals
       WHERE org_id = ? AND deleted_at IS NULL
       GROUP BY stage
       ORDER BY CASE stage
         WHEN 'prospect' THEN 0
         WHEN 'first_contact' THEN 1
         WHEN 'meeting_scheduled' THEN 2
         WHEN 'due_diligence' THEN 3
         WHEN 'term_sheet' THEN 4
         WHEN 'closing' THEN 5
         WHEN 'closed_won' THEN 6
         WHEN 'closed_lost' THEN 7
       END`
    ).bind(ctx.orgId).all(),

    // Average days_in_stage per stage (for deals currently in each stage)
    env.D1.prepare(
      `SELECT stage,
              ROUND(AVG(
                CASE WHEN stage_changed_at IS NOT NULL
                  THEN (julianday('now') - julianday(stage_changed_at))
                  ELSE days_in_stage
                END
              ), 1) AS avg_days
       FROM deals
       WHERE org_id = ? AND deleted_at IS NULL
         AND stage NOT IN ('closed_won','closed_lost')
       GROUP BY stage`
    ).bind(ctx.orgId).all(),

    // Total pipeline value (non-closed deals)
    env.D1.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total_pipeline_value
       FROM deals
       WHERE org_id = ? AND deleted_at IS NULL
         AND stage NOT IN ('closed_won','closed_lost')`
    ).bind(ctx.orgId).first<{ total_pipeline_value: number }>(),

    // Stale deals: no activity in the last 7 days
    env.D1.prepare(
      `SELECT id, title, stage, last_activity_date, company_id
       FROM deals
       WHERE org_id = ? AND deleted_at IS NULL
         AND stage NOT IN ('closed_won','closed_lost')
         AND (last_activity_date IS NULL
              OR last_activity_date < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'))
       ORDER BY last_activity_date ASC NULLS FIRST
       LIMIT 50`
    ).bind(ctx.orgId).all(),
  ]);

  // Build avg_days lookup
  const avgDaysMap: Record<string, number> = {};
  for (const row of avgDays.results as any[]) {
    avgDaysMap[row.stage] = row.avg_days;
  }

  return jsonResponse({
    stages: byStage.results,
    avg_days_in_stage: avgDaysMap,
    total_pipeline_value: pipeline?.total_pipeline_value ?? 0,
    stale_deals: staleDeals.results,
  });
}

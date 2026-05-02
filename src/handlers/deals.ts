// TRD §5.1 §11 — Deals CRUD + deal contacts, action items, notes, timeline, metrics
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { canReadEmailContent, getSharingFlags } from '../lib/helpers';
import { computeDealIntelligence, readDealIntelligence } from '../lib/deal-intelligence';
import {
  assertExternalCompanyForDeal,
  InternalDealError,
  assertNoOpenDealForCompany,
  OpenDealConflictError,
} from '../lib/internal-entity';

// ---------------------------------------------------------------------------
// GET /api/deals
// ---------------------------------------------------------------------------

export async function listDeals(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  // Stage supports multi-select via repeated ?stage=X&stage=Y. Single ?stage=X
  // still works for backward compat with existing callers (deal-detail page).
  const stageParams = url.searchParams.getAll('stage').filter(Boolean);
  const companyId = url.searchParams.get('company_id');
  // owner_id supports multi-select + the special sentinel `unassigned` which
  // matches owner_id IS NULL. Both shapes are useful for the board filter UI.
  const ownerParams = url.searchParams.getAll('owner_id').filter(Boolean);
  const instrumentParams = url.searchParams.getAll('instrument_type').filter(Boolean);
  const leadSourceParams = url.searchParams.getAll('lead_source').filter(Boolean);
  const minAmountRaw = url.searchParams.get('min_amount');
  const maxAmountRaw = url.searchParams.get('max_amount');
  const hasMemo = url.searchParams.get('has_memo');  // 'true' / 'false' / null

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const where: string[] = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];

  if (stageParams.length > 0) {
    where.push(`d.stage IN (${stageParams.map(() => '?').join(',')})`);
    binds.push(...stageParams);
  }
  if (companyId) {
    where.push('d.company_id = ?');
    binds.push(companyId);
  }
  // owner_id: 'unassigned' sentinel maps to IS NULL; otherwise IN (...).
  // Both can be combined: ?owner_id=unassigned&owner_id=<uuid> means
  // unassigned OR owned-by-uuid.
  if (ownerParams.length > 0) {
    const wantsUnassigned = ownerParams.includes('unassigned');
    const realOwners = ownerParams.filter(o => o !== 'unassigned');
    const clauses: string[] = [];
    if (wantsUnassigned) clauses.push('d.owner_id IS NULL');
    if (realOwners.length > 0) {
      clauses.push(`d.owner_id IN (${realOwners.map(() => '?').join(',')})`);
      binds.push(...realOwners);
    }
    if (clauses.length > 0) where.push(`(${clauses.join(' OR ')})`);
  }
  if (instrumentParams.length > 0) {
    where.push(`d.instrument_type IN (${instrumentParams.map(() => '?').join(',')})`);
    binds.push(...instrumentParams);
  }
  // lead_source is a freeform TEXT column — exact match only (no LIKE), since
  // freeform values may collide unpredictably.
  if (leadSourceParams.length > 0) {
    where.push(`d.lead_source IN (${leadSourceParams.map(() => '?').join(',')})`);
    binds.push(...leadSourceParams);
  }
  // amount range — filter on `amount` (deal size). NULL amounts are excluded
  // when either bound is set since "min_amount=1000000" implies "exists".
  if (minAmountRaw !== null) {
    const v = Number(minAmountRaw);
    if (Number.isFinite(v)) { where.push('d.amount IS NOT NULL AND d.amount >= ?'); binds.push(v); }
  }
  if (maxAmountRaw !== null) {
    const v = Number(maxAmountRaw);
    if (Number.isFinite(v)) { where.push('d.amount IS NOT NULL AND d.amount <= ?'); binds.push(v); }
  }
  if (hasMemo === 'true') {
    where.push("d.deal_memo_r2_key IS NOT NULL AND d.deal_memo_r2_key != ''");
  } else if (hasMemo === 'false') {
    where.push("(d.deal_memo_r2_key IS NULL OR d.deal_memo_r2_key = '')");
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
      // Day-5 Phase D: also surface the most-recent linked conversation's
      // subject + sender for the "Last touched by [name]" subtitle on the
      // detail page's Last Activity tile. Correlated subqueries reuse the
      // same two-hop join that powers last_inferred_activity_date so the
      // subject + sender are guaranteed to match the timestamp.
      `SELECT d.*, co.name AS company_name, co.sector AS company_sector,
              u.full_name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM deal_contacts dc WHERE dc.deal_id = d.id) AS contacts_count,
              (SELECT COUNT(*) FROM deal_action_items dai WHERE dai.deal_id = d.id AND dai.status IN ('open','in_progress')) AS open_items_count,
              (SELECT MAX(conv.sent_at)
                 FROM deal_contacts dc
                 JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
                 JOIN conversations conv ON cc.conversation_id = conv.id
                WHERE dc.deal_id = d.id) AS last_inferred_activity_date,
              (SELECT conv.subject
                 FROM deal_contacts dc
                 JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
                 JOIN conversations conv ON cc.conversation_id = conv.id
                WHERE dc.deal_id = d.id
                ORDER BY conv.sent_at DESC LIMIT 1) AS last_inferred_activity_subject,
              (SELECT COALESCE(c.full_name, conv.from_email)
                 FROM deal_contacts dc
                 JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
                 JOIN conversations conv ON cc.conversation_id = conv.id
                 LEFT JOIN contacts c ON conv.from_contact_id = c.id
                WHERE dc.deal_id = d.id
                ORDER BY conv.sent_at DESC LIMIT 1) AS last_inferred_activity_sender
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

  // Wave 1: deal target must be an external (non-internal) company.
  // Wave 2: at most one open deal per company.
  try {
    await assertExternalCompanyForDeal(body.company_id, ctx.orgId, env);
    await assertNoOpenDealForCompany(body.company_id, ctx.orgId, env);
  } catch (e) {
    if (e instanceof InternalDealError) return errorResponse(e.code, 400, e.message);
    if (e instanceof OpenDealConflictError) return errorResponse(e.code, 409, e.message);
    throw e;
  }

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
  // Day-5 hotfix: auto-populate deal_contacts from contacts already
  // resolved to this deal's company. Closes the gap that left
  // deal_intelligence compute starved (the two-hop join
  // deal_contacts → conversation_contacts → conversations had no first
  // hop). Best-effort; failures swallowed so deal creation always
  // succeeds. See src/lib/deal-association.ts.
  try {
    const { linkContactsByCompanyMatch } = await import('../lib/deal-association');
    const r = await linkContactsByCompanyMatch(id, ctx.orgId, env);
    if (r.linked > 0) {
      console.log(`[deals] auto-linked ${r.linked}/${r.matched_contact_count} contacts to new deal ${id}`);
    }
  } catch (e) {
    console.error(`[deals] auto-link contacts failed for new deal ${id}:`, e);
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
              WHERE dc.deal_id = d.id) AS last_inferred_activity_date,
            (SELECT conv.subject
               FROM deal_contacts dc
               JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
               JOIN conversations conv ON cc.conversation_id = conv.id
              WHERE dc.deal_id = d.id
              ORDER BY conv.sent_at DESC LIMIT 1) AS last_inferred_activity_subject,
            (SELECT COALESCE(c2.full_name, conv.from_email)
               FROM deal_contacts dc
               JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
               JOIN conversations conv ON cc.conversation_id = conv.id
               LEFT JOIN contacts c2 ON conv.from_contact_id = c2.id
              WHERE dc.deal_id = d.id
              ORDER BY conv.sent_at DESC LIMIT 1) AS last_inferred_activity_sender
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
// POST /api/deals/bulk-update — Day-5 Phase C
// ---------------------------------------------------------------------------
// Body: { deal_ids: string[], updates: { stage?, owner_id?, ... }, archive?: boolean }
//
// Applies the same field whitelist as updateDeal to every deal_id that
// belongs to the caller's org. archive=true is a sugar for soft-delete
// (sets deleted_at=now) — distinct from setting stage='closed_lost' which
// keeps the row visible on the board's Closed Lost column.
//
// ACL matches updateDeal: any authenticated user in the org can update any
// deal in the org. Per-deal id ownership check is implicit in the WHERE
// org_id=? clause; ids that don't belong to this org are silently dropped.
//
// Stage transitions on bulk path get the same stage_changed_at + days_in_stage
// reset as single-deal updateDeal. last_activity_date bumped on every update.
// Audit row emitted per deal. Re-embedding skipped — bulk operations are
// stage / ownership / archive shifts and don't change embedding-meaningful
// content (title/notes/thesis_fit). If a future bulk path needs content
// updates, add reembedDeal calls per deal then.

const BULK_ALLOWED_FIELDS = [
  'stage', 'owner_id', 'instrument_type', 'lead_source', 'thesis_fit',
  'expected_close', 'actual_close_date', 'probability',
];

export async function bulkUpdateDeals(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{
    deal_ids?: unknown;
    updates?: Record<string, unknown>;
    archive?: boolean;
  }>(request);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, 'body required');

  const dealIds = Array.isArray(body.deal_ids)
    ? body.deal_ids.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  if (dealIds.length === 0) {
    return errorResponse('VALIDATION_ERROR', 400, 'deal_ids must be a non-empty array of strings');
  }
  if (dealIds.length > 100) {
    return errorResponse('VALIDATION_ERROR', 400, 'bulk update capped at 100 deal_ids per call');
  }

  const archive = body.archive === true;
  const updates = body.updates && typeof body.updates === 'object' ? body.updates : {};

  if (!archive && Object.keys(updates).length === 0) {
    return errorResponse('VALIDATION_ERROR', 400, 'either archive=true or updates with at least one field is required');
  }

  // Whitelist + validate update fields. Soft-delete via archive=true bypasses
  // the field whitelist (it's a separate operation).
  const filteredUpdates: Record<string, unknown> = {};
  if (!archive) {
    for (const k of BULK_ALLOWED_FIELDS) {
      if (k in updates) filteredUpdates[k] = (updates as any)[k];
    }
    if (Object.keys(filteredUpdates).length === 0) {
      return errorResponse('VALIDATION_ERROR', 400, `updates must include at least one of: ${BULK_ALLOWED_FIELDS.join(', ')}`);
    }
  }

  // Fetch all matching deals in one round-trip. Org-scoped + not-deleted.
  // Ids that don't belong to this org or are already deleted are silently
  // dropped — no leak (we never reveal whether the id exists).
  const placeholders = dealIds.map(() => '?').join(',');
  const beforeRows = await env.D1.prepare(
    `SELECT * FROM deals WHERE id IN (${placeholders}) AND org_id = ? AND deleted_at IS NULL`
  ).bind(...dealIds, ctx.orgId).all<any>();
  const beforeById = new Map<string, any>(beforeRows.results.map(r => [r.id, r]));
  const matchedIds = Array.from(beforeById.keys());

  if (matchedIds.length === 0) {
    return jsonResponse({ ok: true, updated_count: 0, skipped_ids: dealIds, archived: archive });
  }

  // Build the per-deal UPDATE statements. Stage changes need stage_changed_at
  // + days_in_stage reset on a per-deal basis (since each deal may transition
  // from a different prior stage), so we issue one UPDATE per deal in a
  // batch. D1's batch() commits them atomically per call.
  const stmts: D1PreparedStatement[] = [];
  const auditEntries: Array<{ id: string; before: any; after_partial: Record<string, unknown>; metadata: Record<string, unknown> }> = [];

  for (const id of matchedIds) {
    const before = beforeById.get(id);

    if (archive) {
      stmts.push(env.D1.prepare(
        `UPDATE deals SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(id));
      auditEntries.push({
        id, before,
        after_partial: { deleted_at: new Date().toISOString() },
        metadata: { bulk: true, action: 'archive' },
      });
      continue;
    }

    const setFragments: string[] = [];
    const binds: unknown[] = [];
    const stageChanged = 'stage' in filteredUpdates && filteredUpdates.stage !== before.stage;

    for (const [k, v] of Object.entries(filteredUpdates)) {
      setFragments.push(`${k} = ?`);
      binds.push(v);
    }

    if (stageChanged) {
      setFragments.push(`stage_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      setFragments.push('days_in_stage = 0');
    }
    setFragments.push(`last_activity_date = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    setFragments.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);

    stmts.push(env.D1.prepare(
      `UPDATE deals SET ${setFragments.join(', ')} WHERE id = ?`
    ).bind(...binds, id));

    auditEntries.push({
      id, before,
      after_partial: { ...filteredUpdates },
      metadata: stageChanged
        ? { bulk: true, old_stage: before.stage, new_stage: filteredUpdates.stage }
        : { bulk: true },
    });
  }

  await env.D1.batch(stmts);

  // Emit one audit row per affected deal. Failures here are non-fatal —
  // the underlying update already committed, audit is best-effort observability.
  await Promise.all(auditEntries.map(e => emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: archive ? 'soft_delete' : 'update',
    entity_type: 'deal',
    entity_id: e.id,
    before_data: e.before,
    after_data: { ...e.before, ...e.after_partial },
    metadata: e.metadata,
    created_at: new Date().toISOString(),
  }).catch(err => {
    console.error(`[bulk-update] audit emit failed for deal ${e.id}:`, err);
  })));

  await invalidateRagCache(ctx.orgId, env);

  return jsonResponse({
    ok: true,
    updated_count: matchedIds.length,
    skipped_ids: dealIds.filter(id => !beforeById.has(id)),
    archived: archive,
  });
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
    // Wave 4: timeline reads from conversation_deals junction (Phase B+)
    // exclusively — contact-overlap noise (every email any deal contact
    // ever participated in) is excluded entirely. Junctions are populated
    // by hard signals (inherited_thread + auto_high), Phase C LLM
    // detection auto-link, approval-committed source-communication, and
    // Phase E inherited_channel for Slack.
    //
    // Existing deals with sparse junctions populate over time as new
    // conversations arrive; the admin endpoint
    // POST /api/admin/backfill-deal-timeline-junctions primes existing
    // conversations by re-running applyHardSignalsToConversation.
    env.D1.prepare(
      `SELECT conv.id, conv.subject AS title, conv.sent_at AS timestamp,
              'conversation' AS type, conv.source AS subtype, conv.body_preview,
              conv.source AS conv_source, conv.participant_user_ids,
              conv.is_campaign_email, conv.external_thread_id,
              cd.source AS link_source, cd.confidence AS link_confidence
         FROM conversation_deals cd
         JOIN conversations conv ON conv.id = cd.conversation_id
        WHERE cd.deal_id = ? AND conv.org_id = ?
        ORDER BY conv.sent_at DESC
        LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),

    // Events: junction-only via event_deals.
    env.D1.prepare(
      `SELECT e.id, e.title, e.start_time AS timestamp,
              'event' AS type, e.event_type AS subtype,
              ed.source AS link_source, ed.confidence AS link_confidence
         FROM event_deals ed
         JOIN events e ON e.id = ed.event_id
        WHERE ed.deal_id = ? AND e.org_id = ? AND e.deleted_at IS NULL
        ORDER BY e.start_time DESC
        LIMIT ?`
    ).bind(id, ctx.orgId, limit).all(),

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

  // Wave 4B: dedup conversations by external_thread_id — keep the most
  // recent message per thread + a count. Conversations without a thread
  // id (slack messages, manual) pass through untouched.
  const threadGroups = new Map<string, any>();
  const standaloneConvs: any[] = [];
  for (const c of conversationsWithAccess) {
    const tid = c.external_thread_id;
    if (!tid) { standaloneConvs.push(c); continue; }
    const existing = threadGroups.get(tid);
    if (!existing || String(c.timestamp) > String(existing.timestamp)) {
      threadGroups.set(tid, { ...c, thread_count: (existing?.thread_count ?? 0) + 1 });
    } else {
      existing.thread_count = (existing.thread_count ?? 1) + 1;
    }
  }
  const dedupedConvs = [...threadGroups.values(), ...standaloneConvs];

  // Wave 4B: dedup recurring events by (lower(title), DATE(start_time)).
  // No series_master_id column on events, so collapse same-day-same-title
  // occurrences (Outlook recurrings often appear N times/day across
  // attendee chains; the dedup tightens them to one row + count).
  const eventGroups = new Map<string, any>();
  for (const e of (events.results as any[])) {
    const key = `${(e.title || '').toLowerCase()}|${(e.timestamp || '').slice(0, 10)}`;
    const existing = eventGroups.get(key);
    if (!existing || String(e.timestamp) > String(existing.timestamp)) {
      eventGroups.set(key, { ...e, occurrence_count: (existing?.occurrence_count ?? 0) + 1 });
    } else {
      existing.occurrence_count = (existing.occurrence_count ?? 1) + 1;
    }
  }
  const dedupedEvents = [...eventGroups.values()];

  const entries = [
    ...dedupedConvs,
    ...dedupedEvents,
    ...notes.results,
    ...parsedAudit,
  ]
    .sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, limit);

  return jsonResponse({ entries });
}

// ---------------------------------------------------------------------------
// GET /api/deals/:id/conversations  — Day-5 Phase 2
// ---------------------------------------------------------------------------
// Thread-grouped, ACL-aware conversation surfacing for the deal detail page.
// The two-hop join (deal_contacts → conversation_contacts → conversations) is
// the canonical linkage; this endpoint groups the result by
// external_thread_id and applies the same canReadEmailContent gate that
// getDealTimeline uses.
//
// ACL invariant (mirrors getDealTimeline + getContactTimeline):
//   - Subject + sent_at + has_attachments + direction + thread metadata are
//     visible to anyone who can see the deal (org members).
//   - body_preview + sender_name + sender_email are nulled when
//     canReadEmailContent returns false for the requesting user.
//   - This is the codebase's established two-tier ACL: body-scoped
//     redaction, not metadata-scoped.
//
// NULL external_thread_id rows surface as single-message "threads" of their
// own — the ungrouped_count field on the response tells the caller how
// many of those there are (pre-existing data quality artifact, not a bug
// in this endpoint).

export async function getDealConversations(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

  // Verify deal exists + visible to caller. Same pattern as getDealTimeline.
  const deal = await env.D1.prepare(
    'SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  // Pull all linked conversations (the SQL deliberately fetches more rows
  // than `limit` because limit applies to threads, not messages — we need
  // to grab every message of the threads we'll ultimately return). The
  // hard cap of `limit * 50` is a safety belt against pathological inboxes
  // with thousand-message threads; cron-paced data growth in production
  // makes this overhead negligible for normal threads.
  const messageCap = limit * 50;

  const [rows, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT DISTINCT
              conv.id, conv.external_thread_id, conv.external_message_id,
              conv.subject, conv.sent_at,
              conv.source, conv.body_preview, conv.participant_user_ids,
              conv.is_campaign_email, conv.from_email, conv.from_contact_id,
              conv.direction, conv.has_attachments
         FROM deal_contacts dc
         JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
         JOIN conversations conv       ON cc.conversation_id = conv.id
        WHERE dc.deal_id = ? AND dc.org_id = ? AND conv.org_id = ?
        ORDER BY conv.external_thread_id IS NULL,
                 conv.external_thread_id ASC,
                 conv.sent_at ASC
        LIMIT ?`
    ).bind(id, ctx.orgId, ctx.orgId, messageCap).all<{
      id: string; external_thread_id: string | null;
      external_message_id: string | null; subject: string | null;
      sent_at: string; source: string; body_preview: string | null;
      participant_user_ids: string | null; is_campaign_email: number;
      from_email: string | null; from_contact_id: string | null;
      direction: string | null; has_attachments: number;
    }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  // Resolve from_contact_id → name (batched single round-trip).
  const contactIds = Array.from(new Set(
    rows.results.map(r => r.from_contact_id).filter((v): v is string => !!v)
  ));
  const contactNameById: Record<string, { name: string | null; email: string | null }> = {};
  if (contactIds.length > 0) {
    const placeholders = contactIds.map(() => '?').join(',');
    const contactRows = await env.D1.prepare(
      `SELECT id, full_name, email FROM contacts
        WHERE id IN (${placeholders}) AND org_id = ? AND deleted_at IS NULL`
    ).bind(...contactIds, ctx.orgId).all<{ id: string; full_name: string | null; email: string | null }>();
    for (const r of contactRows.results) {
      contactNameById[r.id] = { name: r.full_name, email: r.email };
    }
  }

  // Group messages by external_thread_id. NULL → each row is its own thread.
  type Msg = {
    id: string;
    external_message_id: string | null;  // for "Open in Outlook" deep-link
    source: string;                       // 'outlook' / 'slack' / 'manual'
    sender_name: string | null;   // null when can_read_body=false (PII gate)
    sender_email: string | null;  // null when can_read_body=false
    sent_at: string;
    direction: string | null;
    can_read_body: boolean;
    body_preview: string | null;  // null when can_read_body=false
    has_attachments: boolean;
  };
  type Thread = {
    external_thread_id: string | null;
    subject: string;             // last message's subject (org-visible)
    last_sender_name: string | null;
    last_sent_at: string;
    message_count: number;
    can_read_any: boolean;       // true if any message in thread is body-readable
    participants: Array<{ contact_id: string | null; name: string | null; email: string | null }>;
    messages: Msg[];
  };

  const threadMap = new Map<string, Thread>();
  // Use the row's id as a unique key when external_thread_id is null so
  // single-message ungrouped rows each become their own thread.
  let ungroupedCount = 0;

  for (const r of rows.results) {
    const canRead = canReadEmailContent(
      {
        source: r.source as 'outlook' | 'slack' | 'manual',
        participant_user_ids: r.participant_user_ids ?? '[]',
        is_campaign_email: r.is_campaign_email,
      } as any,
      ctx.userId,
      ctx.userRole,
      sharingFlags
    );

    const fromContact = r.from_contact_id ? contactNameById[r.from_contact_id] : undefined;
    const senderName = fromContact?.name ?? null;
    const senderEmail = fromContact?.email ?? r.from_email ?? null;

    const msg: Msg = {
      id: r.id,
      external_message_id: r.external_message_id,
      source: r.source,
      sender_name: canRead ? senderName : null,
      sender_email: canRead ? senderEmail : null,
      sent_at: r.sent_at,
      direction: r.direction,
      can_read_body: canRead,
      body_preview: canRead ? r.body_preview : null,
      has_attachments: !!r.has_attachments,
    };

    const groupKey = r.external_thread_id ?? `__ungrouped__:${r.id}`;
    if (r.external_thread_id == null) ungroupedCount++;

    let thread = threadMap.get(groupKey);
    if (!thread) {
      thread = {
        external_thread_id: r.external_thread_id,
        subject: r.subject || '(no subject)',
        last_sender_name: msg.sender_name,
        last_sent_at: r.sent_at,
        message_count: 0,
        can_read_any: false,
        participants: [],
        messages: [],
      };
      threadMap.set(groupKey, thread);
    }
    thread.messages.push(msg);
    thread.message_count++;
    thread.can_read_any = thread.can_read_any || canRead;

    // Latest message wins for thread-level fields. Rows are pre-sorted by
    // sent_at ASC, so the last assignment per thread is the most recent.
    if (r.sent_at >= thread.last_sent_at) {
      thread.last_sent_at = r.sent_at;
      thread.last_sender_name = msg.sender_name;
      thread.subject = r.subject || thread.subject;
    }

    // Accumulate unique participants by contact_id (or email when no contact).
    const partKey = r.from_contact_id ?? r.from_email ?? '';
    if (partKey && !thread.participants.some(p =>
      (p.contact_id && p.contact_id === r.from_contact_id) ||
      (!p.contact_id && p.email === r.from_email)
    )) {
      thread.participants.push({
        contact_id: r.from_contact_id ?? null,
        name: fromContact?.name ?? null,
        email: r.from_email ?? null,
      });
    }
  }

  // Sort threads DESC by last_sent_at, take first `limit`.
  const threads = Array.from(threadMap.values())
    .sort((a, b) => b.last_sent_at.localeCompare(a.last_sent_at))
    .slice(0, limit);

  return jsonResponse({
    threads,
    ungrouped_count: ungroupedCount,
    total_threads_seen: threadMap.size,
    truncated: threadMap.size > limit,
  });
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

// ---------------------------------------------------------------------------
// GET /api/deals/:id/intelligence — per-(deal, user) computed-cached
// intelligence (sentiment / topics / risk_signals / momentum). Cold-path
// reads compute synchronously then UPSERT and return. Subsequent reads
// serve from cache, marked is_stale per the freshness contract.
// Stale reads serve cached data + queue an async recompute via
// ctxExec.waitUntil so the user-visible read never blocks on the LLM.
// Per-(deal_id, user_id) PK enforces the ACL layered redaction principle:
// each user's intelligence reflects only conversations they can read.
// ---------------------------------------------------------------------------

export async function getDealIntelligence(
  id: string,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  // ACL — same gate as deal detail page. If the deal isn't in the
  // caller's org (or is soft-deleted), 404 without leaking existence.
  const deal = await env.D1.prepare(
    'SELECT id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first();
  if (!deal) return errorResponse('DEAL_NOT_FOUND', 404);

  let intelligence = await readDealIntelligence(id, ctx.userId, env);

  // Cold path — first read for this (deal, user) pair triggers a
  // synchronous compute. Subsequent reads serve from cache.
  if (!intelligence) {
    try {
      const result = await computeDealIntelligence(id, ctx.userId, ctx.userRole, ctx.orgId, env);
      intelligence = result.intelligence;
    } catch (e) {
      console.error(`[deal-intelligence] cold-start compute failed for ${id}/${ctx.userId}:`, e);
      return errorResponse('INTELLIGENCE_COMPUTE_FAILED', 500);
    }
  } else if (intelligence.is_stale) {
    // Stale path — return cached row immediately, kick async recompute.
    // The user-visible read never blocks on the LLM. Next read after
    // recompute lands serves the fresh data; in the worst case the
    // hourly batch picks it up.
    ctxExec.waitUntil((async () => {
      try {
        await computeDealIntelligence(id, ctx.userId, ctx.userRole, ctx.orgId, env);
      } catch (e) {
        console.error(`[deal-intelligence] async recompute failed for ${id}/${ctx.userId}:`, e);
      }
    })());
  }

  return jsonResponse(intelligence);
}

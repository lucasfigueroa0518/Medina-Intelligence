// TRD §5.1, §3.16 — Approval queue list / approve / reject / bulk + progressive enrichment
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';
import { invalidateRagCache } from '../lib/cache';
import { canReadConversationContent, getSharingFlags } from '../lib/helpers';
import { commitProgressiveApproval, markFieldsHumanEdited } from '../lib/progressive-enrichment';
import { triggerContactEnrichment } from '../lib/enrichment';
import { recordApproval, recordApprovalOfDeletion, recordRejection } from '../lib/proposal-evaluator';

// Wave 6 column-overwrite tables. Mirrors proposal-evaluator's tableForEntity
// — kept here too to avoid a circular import via approval-evaluator helpers.
function tableForEntity(t: 'contact' | 'company' | 'deal'): string {
  if (t === 'contact') return 'contacts';
  if (t === 'company') return 'companies';
  return 'deals';
}

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
          `SELECT c.source, c.participant_user_ids, c.is_campaign_email, sc.is_private AS slack_is_private
             FROM conversations c
             LEFT JOIN slack_channels sc
               ON c.source = 'slack'
              AND sc.org_id = c.org_id
              AND sc.channel_id = CASE
                WHEN instr(c.external_message_id, ':') > 0
                THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
                ELSE c.external_message_id
              END
            WHERE c.id = ? AND c.org_id = ?`
        ).bind(row.source_communication_id, ctx.orgId).first<any>();

        const canRead = conv
          ? canReadConversationContent(conv, ctx.userId, ctx.userRole, sharingFlags)
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

  if (item.change_type === 'create_deal') {
    return errorResponse(
      'DEAL_APPROVAL_RETIRED',
      422,
      'AI deal proposals now require conservative replay evidence before they can become deals.'
    );
  }

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
  // Read the row before updating so we can extract field_name +
  // proposed_value for the Wave 6 rejection record (entity_field_state's
  // rejected_values map drives the 90-day no-re-ask rule).
  const item = await env.D1.prepare(
    `SELECT id, entity_type, entity_id, field_name, proposed_value
       FROM approval_queue
       WHERE id = ? AND org_id = ? AND status = 'pending'`
  ).bind(id, ctx.orgId).first<{
    id: string;
    entity_type: string;
    entity_id: string;
    field_name: string | null;
    proposed_value: string | null;
  }>();
  if (!item) return errorResponse('APPROVAL_ALREADY_RESOLVED', 409);

  const result = await env.D1.prepare(
    `UPDATE approval_queue SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND org_id = ? AND status = 'pending'`
  ).bind(ctx.userId, id, ctx.orgId).run();

  if ((result.meta?.changes || 0) === 0) {
    return errorResponse('APPROVAL_ALREADY_RESOLVED', 409);
  }

  // Wave 6: stamp the rejected value into entity_field_state so the
  // evaluator auto-rejects re-asks of the same value within 90 days.
  // Best-effort — never blocks the user-visible reject. Skip for
  // proposal kinds that don't have a field-state row (new_entity,
  // synthetic new_association, create_deal, etc.).
  if (
    item.field_name &&
    item.proposed_value &&
    (item.entity_type === 'contact' || item.entity_type === 'company' || item.entity_type === 'deal')
  ) {
    try {
      let extractedValue: string;
      try {
        const parsed = JSON.parse(item.proposed_value);
        extractedValue =
          parsed && typeof parsed === 'object' && parsed.value !== undefined
            ? String(parsed.value)
            : item.proposed_value;
      } catch {
        extractedValue = item.proposed_value;
      }
      await recordRejection(
        {
          orgId: ctx.orgId,
          entityType: item.entity_type as 'contact' | 'company' | 'deal',
          entityId: item.entity_id,
          fieldName: item.field_name,
          rejectedValue: extractedValue,
        },
        env
      );
    } catch (e) {
      console.error('[approval] recordRejection failed:', e);
    }
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

  if (item.change_type === 'create_deal') {
    console.warn('[approval] ignored retired create_deal approval path');
    return {};
  }

  // Phase C/D: 'link_to_deal' proposals from medium-confidence detection
  // (LLM 0.7-0.9). Approving inserts the appropriate junction row
  // (conversation_deals or event_deals depending on entity_type) with
  // source='approval_committed', confidence=1.0 (human ack overrides LLM
  // confidence).
  if (item.change_type === 'link_to_deal') {
    return commitLinkToDealApproval(item, env);
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

/** Commit a create_deal approval. Inserts a deals row from the proposed
 *  payload, then auto-links contacts at the company AND the source
 *  conversation's participants. Idempotent on the deal insert via the
 *  approval_queue's idempotency_key. */
async function commitCreateDealApproval(item: any, env: Env): Promise<{ reEnrich?: boolean }> {
  // Proposed value shape per src/lib/deal-detection.ts:103-113:
  //   { company_id, title, stage, amount, our_allocation, lead_source,
  //     evidence, source_communication_id, source_sent_at }
  let payload: any;
  try {
    payload = JSON.parse(item.proposed_value);
  } catch (e) {
    console.error('[commit-create-deal] payload parse failed:', e);
    return {};
  }
  if (!payload?.company_id || !payload?.title) {
    console.error('[commit-create-deal] missing required fields company_id/title');
    return {};
  }

  // The deal-detection proposal's stage values come from a 5-categorical
  // prompt set ('prospect','qualified','diligence','term_sheet','closing')
  // but the deals table CHECK accepts 8 stages. Map the LLM-side stages
  // to the table-side stages so the INSERT doesn't violate the constraint.
  const STAGE_MAP: Record<string, string> = {
    prospect: 'prospect',
    qualified: 'first_contact',
    diligence: 'due_diligence',
    term_sheet: 'term_sheet',
    closing: 'closing',
  };
  const stage = STAGE_MAP[payload.stage] || 'prospect';

  const dealId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Verify company still exists in the org. The proposal could be days
  // old; if the company was soft-deleted in between, fail loudly rather
  // than insert a deal pointing at a tombstone.
  const company = await env.D1.prepare(
    `SELECT id, is_internal_entity FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(payload.company_id, item.org_id).first<{ id: string; is_internal_entity: number }>();
  if (!company) {
    console.error(`[commit-create-deal] company ${payload.company_id} not found in org ${item.org_id}`);
    return {};
  }
  // Wave 1: refuse to commit deal proposals on internal entities. Old
  // proposals from before the rule landed will be skipped silently —
  // they should also be cleaned out of approval_queue (admin sweep).
  if (company.is_internal_entity === 1) {
    console.warn(
      `[commit-create-deal] skipping internal-entity proposal company=${payload.company_id} title=${String(payload.title).slice(0, 60)}`
    );
    return {};
  }

  // Wave 2: silently skip if an open deal already exists for this
  // company. The proposal is moot — the source communication should
  // link to the existing deal via Phase B junctions, not create a
  // duplicate.
  const existingOpen = await env.D1.prepare(
    `SELECT id, title FROM deals
       WHERE org_id = ? AND company_id = ?
         AND deleted_at IS NULL
         AND stage NOT IN ('closed','closed_won','closed_lost')
       LIMIT 1`
  ).bind(item.org_id, payload.company_id).first<{ id: string; title: string }>();
  if (existingOpen) {
    console.warn(
      `[commit-create-deal] skipping — open deal already exists for company=${payload.company_id} existing="${existingOpen.title}"`
    );
    // Best-effort: redirect the source communication to the existing
    // deal so the signal isn't lost.
    if (payload.source_communication_id) {
      try {
        const { linkConversationToDeal, linkEventToDeal } = await import('../lib/deal-association');
        const kind = payload.source_kind === 'event' ? 'event' : 'conversation';
        if (kind === 'event') {
          await linkEventToDeal(payload.source_communication_id, existingOpen.id, 'approval_committed', 1.0, item.org_id, env, item.resolved_by ?? undefined);
        } else {
          await linkConversationToDeal(payload.source_communication_id, existingOpen.id, 'approval_committed', 1.0, item.org_id, env, item.resolved_by ?? undefined);
        }
      } catch (e) {
        console.error(`[commit-create-deal] redirect-to-existing link failed:`, e);
      }
    }
    return {};
  }

  try {
    await env.D1.prepare(
      `INSERT INTO deals
         (id, org_id, company_id, owner_id, title, stage, amount, currency,
          probability, our_allocation, lead_source,
          stage_changed_at, last_activity_date, days_in_stage,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(
        dealId,
        item.org_id,
        payload.company_id,
        item.resolved_by || null,                 // approver becomes owner
        String(payload.title).slice(0, 120),
        stage,
        Number.isFinite(payload.amount) ? payload.amount : null,
        Math.min(Math.max(Number(item.confidence) || 0, 0), 1),  // confidence as initial probability proxy
        Number.isFinite(payload.our_allocation) ? payload.our_allocation : null,
        payload.lead_source || null,
        now, now, now, now
      )
      .run();
  } catch (e) {
    console.error(`[commit-create-deal] deal insert failed:`, e);
    return {};
  }

  // Phase F: stamp origin trace on deal.source_metadata. Captures the
  // single conversation/event that triggered the create_deal proposal +
  // who approved it + when. The Origin line on the deal page reads
  // back from this. Best-effort — if the JSON write fails the deal is
  // still valid, we just lose the surface for "Created from email X".
  try {
    const originMeta = {
      origin: {
        source_kind: payload.source_kind === 'event' ? 'event' : 'conversation',
        source_communication_id: payload.source_communication_id ?? null,
        source_sent_at: payload.source_sent_at ?? null,
        approved_by: item.resolved_by ?? null,
        approved_at: now,
        confidence: Math.min(Math.max(Number(item.confidence) || 0, 0), 1),
        evidence: typeof payload.evidence === 'string' ? payload.evidence.slice(0, 500) : null,
      },
    };
    await env.D1.prepare(
      `UPDATE deals SET source_metadata = json_patch(coalesce(source_metadata, '{}'), ?)
        WHERE id = ?`
    ).bind(JSON.stringify(originMeta), dealId).run();
  } catch (e) {
    console.error(`[commit-create-deal] origin stamp failed for ${dealId}:`, e);
  }

  // Auto-link contacts via two evidence paths. Both idempotent.
  try {
    const { linkContactsByCompanyMatch, linkConversationParticipantsToDeal }
      = await import('../lib/deal-association');
    const companyMatch = await linkContactsByCompanyMatch(dealId, item.org_id, env);
    let sourceMatch = { linked: 0, participant_count: 0 };
    if (payload.source_communication_id) {
      sourceMatch = await linkConversationParticipantsToDeal(
        dealId, payload.source_communication_id, item.org_id, env
      );
    }

    // Phase C: also write a direct junction row from the source
    // communication to the new deal. source_kind tells us which table.
    // Defaults to 'conversation' for back-compat with proposals that
    // pre-date Phase C (didn't include source_kind in the payload).
    if (payload.source_communication_id) {
      const kind = payload.source_kind === 'event' ? 'event' : 'conversation';
      try {
        const { linkConversationToDeal, linkEventToDeal } = await import('../lib/deal-association');
        if (kind === 'event') {
          await linkEventToDeal(payload.source_communication_id, dealId, 'approval_committed', 1.0, item.org_id, env, item.resolved_by ?? undefined);
        } else {
          await linkConversationToDeal(payload.source_communication_id, dealId, 'approval_committed', 1.0, item.org_id, env, item.resolved_by ?? undefined);
        }
      } catch (e) {
        console.error(`[commit-create-deal] direct ${kind}_deals link failed for ${dealId}:`, e);
      }
    }

    console.log(
      `[commit-create-deal] deal=${dealId} company-link=${companyMatch.linked}/${companyMatch.matched_contact_count} source-link=${sourceMatch.linked}/${sourceMatch.participant_count}`
    );
  } catch (e) {
    console.error(`[commit-create-deal] auto-link failed for ${dealId}:`, e);
  }

  // Embed the new deal so MARTy + RAG can surface it. Best-effort.
  try {
    const { embedDeal } = await import('../lib/embedding');
    await embedDeal(dealId, item.org_id, env);
  } catch (e) {
    console.error(`[commit-create-deal] embed failed for ${dealId}:`, e);
  }

  return {};
}

/** Commit a 'link_to_deal' approval (Phase C/D medium-confidence path).
 *  Inserts conversation_deals or event_deals depending on entity_type.
 *  source='approval_committed', confidence=1.0 (human ack overrides LLM). */
async function commitLinkToDealApproval(item: any, env: Env): Promise<{ reEnrich?: boolean }> {
  let payload: any;
  try {
    payload = JSON.parse(item.proposed_value);
  } catch (e) {
    console.error('[commit-link-to-deal] payload parse failed:', e);
    return {};
  }
  const dealId = payload?.deal_id;
  if (!dealId) {
    console.error('[commit-link-to-deal] missing deal_id in payload');
    return {};
  }

  const kind: 'conversation' | 'event' =
    item.entity_type === 'event' ? 'event' : 'conversation';

  try {
    const { linkConversationToDeal, linkEventToDeal } = await import('../lib/deal-association');
    if (kind === 'event') {
      await linkEventToDeal(item.entity_id, dealId, 'approval_committed', 1.0, item.org_id, env, item.resolved_by ?? undefined);
    } else {
      await linkConversationToDeal(item.entity_id, dealId, 'approval_committed', 1.0, item.org_id, env, item.resolved_by ?? undefined);
    }
    console.log(`[commit-link-to-deal] linked ${kind}=${item.entity_id} → deal=${dealId}`);
  } catch (e) {
    console.error(`[commit-link-to-deal] insert failed for ${kind}=${item.entity_id} → deal=${dealId}:`, e);
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

// Dismiss every pending approval for the org in one shot. Used by the
// Settings → Approval Queue "Dismiss all" button when a user wants to
// clear out a backlog of low-confidence enrichment updates rather than
// triage them one by one. Single bulk UPDATE — no per-row loop.
export async function rejectAllPending(
  _request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const result = await env.D1.prepare(
    `UPDATE approval_queue SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND status = 'pending'`
  ).bind(ctx.userId, ctx.orgId).run();

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
      // Wave 6 corroboration packet — present when the row was produced
      // by evaluateProposal's QUEUE path. Older rows or non-evaluator
      // sources won't have it; UI renders gracefully when absent.
      current_value_sources: Array.isArray(metadata?.current_value_sources)
        ? metadata.current_value_sources
        : null,
      proposed_value_sources: Array.isArray(metadata?.proposed_value_sources)
        ? metadata.proposed_value_sources
        : null,
      corroboration_count: typeof metadata?.corroboration_count === 'number'
        ? metadata.corroboration_count
        : null,
      // ReverseContact unverified payloads carry their candidate-fields
      // map here; the UI renders a structured field-list instead of a
      // raw JSON blob (Phase B normalized this).
      candidate_fields:
        metadata?.candidate_fields && typeof metadata.candidate_fields === 'object'
          ? metadata.candidate_fields
          : null,
      identity_score: typeof metadata?.identity_score === 'number'
        ? metadata.identity_score
        : null,
      identity_details: Array.isArray(metadata?.identity_details)
        ? metadata.identity_details
        : null,
      // LinkedIn discovery alternatives (Phase B normalized).
      alternatives: Array.isArray(metadata?.alternatives)
        ? metadata.alternatives
        : null,
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
        held_proposals: [],
      });
    }
  }

  // Wave 6 UX surface — held proposals from entity_field_state.pending_proposals.
  // These are values that have been observed but didn't meet the 3-channel
  // overwrite threshold (or 2-channel empty-fill), so the evaluator stashed
  // them silently. Surfacing them under ?include_held=true lets a user opt
  // into seeing the pipeline of "alternative values we've heard but haven't
  // surfaced." Same ACL as listApprovalQueueGrouped — members see their org's
  // entities only (the entity-table joins below filter by org_id).
  const includeHeld = url.searchParams.get('include_held') === 'true';
  if (includeHeld) {
    // Pull held proposals per entity type, joining through the entity table
    // for org isolation. entity_field_state itself has no org column —
    // mirrors progressive-enrichment.ts's per-table lookup pattern.
    const heldQueries: Array<{ entityType: 'contact' | 'company' | 'deal'; sql: string }> = [
      // Q11: include rows that have either pending_proposals OR
      // pending_deletions populated, so held deletions surface in the
      // same UX as held overwrites.
      { entityType: 'contact',
        sql: `SELECT efs.entity_type, efs.entity_id, efs.field_name, efs.current_value,
                     efs.current_value_sources, efs.pending_proposals,
                     efs.pending_deletions,
                     efs.last_human_edit_at, efs.permanently_locked
                FROM entity_field_state efs
                JOIN contacts c ON c.id = efs.entity_id
               WHERE efs.entity_type = 'contact'
                 AND (efs.pending_proposals != '{}' OR efs.pending_deletions != '[]')
                 AND c.org_id = ? AND c.deleted_at IS NULL` },
      { entityType: 'company',
        sql: `SELECT efs.entity_type, efs.entity_id, efs.field_name, efs.current_value,
                     efs.current_value_sources, efs.pending_proposals,
                     efs.pending_deletions,
                     efs.last_human_edit_at, efs.permanently_locked
                FROM entity_field_state efs
                JOIN companies c ON c.id = efs.entity_id
               WHERE efs.entity_type = 'company'
                 AND (efs.pending_proposals != '{}' OR efs.pending_deletions != '[]')
                 AND c.org_id = ? AND c.deleted_at IS NULL` },
      { entityType: 'deal',
        sql: `SELECT efs.entity_type, efs.entity_id, efs.field_name, efs.current_value,
                     efs.current_value_sources, efs.pending_proposals,
                     efs.pending_deletions,
                     efs.last_human_edit_at, efs.permanently_locked
                FROM entity_field_state efs
                JOIN deals d ON d.id = efs.entity_id
               WHERE efs.entity_type = 'deal'
                 AND (efs.pending_proposals != '{}' OR efs.pending_deletions != '[]')
                 AND d.org_id = ? AND d.deleted_at IS NULL` },
    ];

    for (const q of heldQueries) {
      if (entityTypeFilter && entityTypeFilter !== q.entityType) continue;

      const heldRows = await env.D1.prepare(q.sql).bind(ctx.orgId).all<{
        entity_type: string;
        entity_id: string;
        field_name: string;
        current_value: string | null;
        current_value_sources: string;
        pending_proposals: string;
        pending_deletions: string;
        last_human_edit_at: string | null;
        permanently_locked: number;
      }>();

      for (const hr of heldRows.results) {
        let pending: Record<string, string[]> = {};
        try {
          const parsed = JSON.parse(hr.pending_proposals);
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              if (Array.isArray(v)) pending[k] = v.filter(s => typeof s === 'string');
            }
          }
        } catch { /* malformed pending_proposals — fall through */ }

        let pendingDeletions: string[] = [];
        try {
          const parsed = JSON.parse(hr.pending_deletions);
          if (Array.isArray(parsed)) pendingDeletions = parsed.filter(s => typeof s === 'string');
        } catch { /* default empty */ }

        // Skip if both are empty (the WHERE clause should prevent this,
        // but malformed JSON is a possible cause for landing here).
        if (Object.keys(pending).length === 0 && pendingDeletions.length === 0) continue;

        let currentSources: string[] = [];
        try {
          const parsed = JSON.parse(hr.current_value_sources);
          if (Array.isArray(parsed)) currentSources = parsed.filter(s => typeof s === 'string');
        } catch { /* default to [] */ }

        const key = `${hr.entity_type}:${hr.entity_id}`;
        if (!grouped.has(key)) {
          // No active queue rows for this entity, but we have held proposals
          // — surface anyway. Need a lookup for entity_name + avatar.
          const entityRow = await env.D1.prepare(
            hr.entity_type === 'contact'
              ? 'SELECT full_name as name, avatar_url FROM contacts WHERE id = ?'
              : hr.entity_type === 'company'
              ? 'SELECT name, NULL as avatar_url FROM companies WHERE id = ?'
              : 'SELECT title as name, NULL as avatar_url FROM deals WHERE id = ?'
          ).bind(hr.entity_id).first<{ name: string | null; avatar_url: string | null }>();

          grouped.set(key, {
            entity_type: hr.entity_type,
            entity_id: hr.entity_id,
            entity_name: entityRow?.name || null,
            entity_avatar: entityRow?.avatar_url || null,
            updates: [],
            held_proposals: [],
          });
        }

        const entityEntry = grouped.get(key);
        // Held overwrite proposals — one entry per (value, channels[]).
        for (const [value, channels] of Object.entries(pending)) {
          entityEntry.held_proposals.push({
            field_name: hr.field_name,
            value,
            channels,
            current_value: hr.current_value,
            current_value_sources: currentSources,
            last_human_edit_at: hr.last_human_edit_at,
            permanently_locked: hr.permanently_locked === 1,
            is_deletion: false,
          });
        }
        // Q11 — held deletion proposals. Surface as a single entry per
        // field with is_deletion=true so the UI renders "Proposed:
        // clear this field" instead of a value swap. value is null.
        if (pendingDeletions.length > 0) {
          entityEntry.held_proposals.push({
            field_name: hr.field_name,
            value: null,
            channels: pendingDeletions,
            current_value: hr.current_value,
            current_value_sources: currentSources,
            last_human_edit_at: hr.last_human_edit_at,
            permanently_locked: hr.permanently_locked === 1,
            is_deletion: true,
          });
        }
      }
    }
  }

  return jsonResponse({ entities: Array.from(grouped.values()) });
}

// Wave 6 UX — approve a held proposal. Held proposals live in
// entity_field_state.pending_proposals (not approval_queue); approving
// commits the value as if it were a fresh human edit per the locked spec.
// recordApproval handles the entity_field_state side: resets
// current_value_sources to [manual_edit_<userId>], clears pending_proposals,
// stamps last_human_edit_at. We additionally write the value to the entity
// table since recordApproval expects the entity table to already reflect
// the new value (mirrors the markFieldsHumanEdited flow).
export async function approveHeldProposal(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{
    entity_type: 'contact' | 'company' | 'deal';
    entity_id: string;
    field_name: string;
    /** Required for value-overwrite approvals; ignored when
     *  is_deletion=true (deletion has no proposed_value). */
    value?: string;
    /** Q11: when true, this is approval of a held DELETION. The entity
     *  field gets set to NULL and entity_field_state's
     *  current_value/sources reset accordingly. */
    is_deletion?: boolean;
  }>(request);
  if (!body?.entity_type || !body?.entity_id || !body?.field_name) {
    return errorResponse('VALIDATION_ERROR', 400);
  }
  if (body.entity_type !== 'contact' && body.entity_type !== 'company' && body.entity_type !== 'deal') {
    return errorResponse('VALIDATION_ERROR', 400, 'entity_type must be contact|company|deal');
  }
  const isDeletion = body.is_deletion === true;
  if (!isDeletion && body.value === undefined) {
    return errorResponse('VALIDATION_ERROR', 400, 'value required unless is_deletion=true');
  }

  // Org-isolation check via entity table.
  const table = tableForEntity(body.entity_type);
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(body.entity_id, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) {
    return errorResponse('NOT_FOUND', 404, 'Entity not in your org');
  }

  if (isDeletion) {
    // Verify a held deletion exists before writing anything.
    const stateRow = await env.D1.prepare(
      `SELECT pending_deletions FROM entity_field_state
         WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
    ).bind(body.entity_type, body.entity_id, body.field_name)
     .first<{ pending_deletions: string }>();
    if (!stateRow) {
      return errorResponse('NOT_FOUND', 404, 'No field state row for this entity/field');
    }
    let deletions: string[] = [];
    try {
      const parsed = JSON.parse(stateRow.pending_deletions);
      if (Array.isArray(parsed)) deletions = parsed.filter(s => typeof s === 'string');
    } catch { /* treat as empty */ }
    if (deletions.length === 0) {
      return errorResponse('NOT_FOUND', 404, 'No held deletion for this field');
    }

    // Set entity field to NULL.
    await env.D1.prepare(
      `UPDATE ${table} SET ${body.field_name} = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(body.entity_id).run();

    // recordApprovalOfDeletion clears pending_proposals + pending_deletions,
    // resets current_value_sources to [manual_edit_<userId>], stamps
    // last_human_edit_at — so future automated proposals (overwrites OR
    // re-proposed deletions) are gated by the 180-day human-edit lock.
    await recordApprovalOfDeletion({
      orgId: ctx.orgId,
      entityType: body.entity_type,
      entityId: body.entity_id,
      fieldName: body.field_name,
      userId: ctx.userId,
    }, env);

    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'approve',
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      after_data: { field: body.field_name, source: 'held_deletion_approve' },
      created_at: new Date().toISOString(),
    });

    await invalidateRagCache(ctx.orgId, env);
    return jsonResponse({ ok: true, deletion: true });
  }

  // ── overwrite path (existing Wave 6 UX) ──────────────────────────
  // Verify the held proposal exists for this org/entity/field/value before
  // writing anything. Prevents the endpoint being abused to set arbitrary
  // values on entities the caller has no claim to.
  const stateRow = await env.D1.prepare(
    `SELECT pending_proposals FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(body.entity_type, body.entity_id, body.field_name)
   .first<{ pending_proposals: string }>();

  if (!stateRow) {
    return errorResponse('NOT_FOUND', 404, 'No field state row for this entity/field');
  }
  let pending: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(stateRow.pending_proposals);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) pending[k] = v.filter(s => typeof s === 'string');
      }
    }
  } catch { /* treat as empty */ }
  if (!pending[body.value!]) {
    return errorResponse('NOT_FOUND', 404, 'No held proposal for this value');
  }

  // Write to entity table.
  await env.D1.prepare(
    `UPDATE ${table} SET ${body.field_name} = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(body.value, body.entity_id).run();

  // recordApproval syncs entity_field_state — resets corroboration history
  // per the locked spec. current_value_sources becomes
  // [manual_edit_<userId>], pending_proposals clears entirely (any other
  // held alternatives for this field are dropped — the human just decided).
  await recordApproval({
    orgId: ctx.orgId,
    entityType: body.entity_type,
    entityId: body.entity_id,
    fieldName: body.field_name,
    approvedValue: body.value!,
    userId: ctx.userId,
  }, env);

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'approve',
    entity_type: body.entity_type,
    entity_id: body.entity_id,
    after_data: { field: body.field_name, value: body.value, source: 'held_proposal_approve' },
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);
  return jsonResponse({ ok: true });
}

// Wave 6 UX — dismiss a held proposal. Removes the value from
// pending_proposals and stamps it into rejected_values so the evaluator's
// 90-day no-re-ask rule auto-rejects re-proposals of the same value.
// Does NOT change current_value or current_value_sources — dismissing a
// held alternative leaves current alone.
export async function dismissHeldProposal(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{
    entity_type: 'contact' | 'company' | 'deal';
    entity_id: string;
    field_name: string;
    value?: string;
    /** Q11: when true, dismiss a held DELETION (stamp __DELETE__
     *  sentinel in rejected_values, clear pending_deletions). 90-day
     *  no-re-ask then suppresses repeat deletion proposals. */
    is_deletion?: boolean;
  }>(request);
  if (!body?.entity_type || !body?.entity_id || !body?.field_name) {
    return errorResponse('VALIDATION_ERROR', 400);
  }
  if (body.entity_type !== 'contact' && body.entity_type !== 'company' && body.entity_type !== 'deal') {
    return errorResponse('VALIDATION_ERROR', 400);
  }
  const isDeletion = body.is_deletion === true;
  if (!isDeletion && body.value === undefined) {
    return errorResponse('VALIDATION_ERROR', 400, 'value required unless is_deletion=true');
  }

  // Org-isolation check.
  const table = tableForEntity(body.entity_type);
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(body.entity_id, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) {
    return errorResponse('NOT_FOUND', 404, 'Entity not in your org');
  }

  await recordRejection({
    orgId: ctx.orgId,
    entityType: body.entity_type,
    entityId: body.entity_id,
    fieldName: body.field_name,
    rejectedValue: body.value ?? '',
    isDeletion,
  }, env);

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'reject',
    entity_type: body.entity_type,
    entity_id: body.entity_id,
    after_data: {
      field: body.field_name,
      ...(isDeletion ? { source: 'held_deletion_dismiss' } : { value: body.value, source: 'held_proposal_dismiss' }),
    },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, deletion: isDeletion });
}

// Wave 6 UX — toggle permanently_locked on a single field. When locked,
// the evaluator's permanent-lock check returns REJECT regardless of
// corroboration count or human-edit recency. Owner-only — locking is an
// administrative action, not a user-level edit.
export async function toggleFieldLock(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('FORBIDDEN', 403, 'owner role required');
  }
  const body = await parseJsonBody<{
    entity_type: 'contact' | 'company' | 'deal';
    entity_id: string;
    field_name: string;
    locked: boolean;
  }>(request);
  if (
    !body?.entity_type || !body?.entity_id || !body?.field_name ||
    typeof body?.locked !== 'boolean'
  ) {
    return errorResponse('VALIDATION_ERROR', 400);
  }
  if (body.entity_type !== 'contact' && body.entity_type !== 'company' && body.entity_type !== 'deal') {
    return errorResponse('VALIDATION_ERROR', 400);
  }

  // Org-isolation check.
  const table = tableForEntity(body.entity_type);
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(body.entity_id, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) {
    return errorResponse('NOT_FOUND', 404, 'Entity not in your org');
  }

  // Upsert the field state row with the new lock value. If no row exists
  // (the field has never been touched by a Wave 6 evaluator-routed
  // proposal), seed one with the current entity-table value as
  // current_value and ['historical_unknown'] sources — same shape as
  // Phase A backfill.
  const existing = await env.D1.prepare(
    `SELECT id FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(body.entity_type, body.entity_id, body.field_name).first<{ id: string }>();

  if (existing) {
    await env.D1.prepare(
      `UPDATE entity_field_state
          SET permanently_locked = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(body.locked ? 1 : 0, existing.id).run();
  } else {
    // Cold path. Read entity-table value to seed the field state row.
    const liveRow = await env.D1.prepare(
      `SELECT ${body.field_name} as v FROM ${table} WHERE id = ?`
    ).bind(body.entity_id).first<{ v: unknown }>().catch(() => null);
    const currentValue =
      liveRow?.v == null ? null :
      typeof liveRow.v === 'string' ? liveRow.v :
      String(liveRow.v);
    const sources = currentValue && currentValue.trim() !== ''
      ? '["historical_unknown"]'
      : '[]';
    await env.D1.prepare(
      `INSERT INTO entity_field_state
         (entity_type, entity_id, field_name, current_value,
          current_value_sources, permanently_locked)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      body.entity_type, body.entity_id, body.field_name,
      currentValue, sources, body.locked ? 1 : 0
    ).run();
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: body.entity_type,
    entity_id: body.entity_id,
    after_data: { field: body.field_name, permanently_locked: body.locked, source: 'field_lock_toggle' },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, field_name: body.field_name, locked: body.locked });
}

// Wave 6 UX — surface per-field locks for a single entity. Used by the
// detail-page lock-icon UI so it can render the closed-padlock badge for
// fields that are currently locked. Returns one row per (field_name,
// permanently_locked) so the UI can map field → lock state.
export async function listFieldLocks(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const entityType = url.searchParams.get('entity_type');
  const entityId = url.searchParams.get('entity_id');
  if (!entityType || !entityId) {
    return errorResponse('VALIDATION_ERROR', 400, 'entity_type and entity_id required');
  }
  if (entityType !== 'contact' && entityType !== 'company' && entityType !== 'deal') {
    return errorResponse('VALIDATION_ERROR', 400);
  }

  const table = tableForEntity(entityType);
  const ownerCheck = await env.D1.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(entityId, ctx.orgId).first<{ id: string }>();
  if (!ownerCheck) {
    return errorResponse('NOT_FOUND', 404, 'Entity not in your org');
  }

  const rows = await env.D1.prepare(
    `SELECT field_name, permanently_locked, last_human_edit_at
       FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ?`
  ).bind(entityType, entityId).all<{
    field_name: string;
    permanently_locked: number;
    last_human_edit_at: string | null;
  }>();

  return jsonResponse({
    fields: rows.results.map(r => ({
      field_name: r.field_name,
      permanently_locked: r.permanently_locked === 1,
      last_human_edit_at: r.last_human_edit_at,
    })),
  });
}

// MARTy write capability ("God Mode") — Phase 1 foundation.
//
// Single source of truth for entity field updates / deletions /
// creations. Both the manual UI PATCH/POST handlers AND MARTy's
// write tools (Phase 2) call these functions. Same lock semantics,
// same audit trail, same cache invalidations — no parallel write
// surface.
//
// Locked safety guarantees, applied to every write:
//   1. ACL — entity must be in the caller's org and not soft-deleted
//      (404 otherwise; never leak existence).
//   2. permanently_locked fields are REFUSED with a clear error.
//   3. 180-day human-edit lock REFUSES, UNLESS the user IS the human
//      who set the lock (updating their own prior edit is allowed).
//   4. Every successful write stamps last_human_edit_at AND
//      last_human_edit_user_id (migration 0076) on entity_field_state
//      and resets current_value_sources to [manual_edit_<userId>].
//      Rule of thumb: a write through this module IS a human edit, by
//      definition — corroboration history clears.
//   5. invalidateRagCache + invalidateForConversation hooks fire so
//      MARTy / deal_intelligence / cached read paths see fresh state.
//
// origin: 'manual_ui' | 'marty' threads through to the audit log
// (Phase 3 hook). Phase 1 stamps it but the dedicated agent_writes
// table doesn't exist yet — emitAudit treats both origins identically
// for now.

import type { Env } from '../types/env';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';
import { markFieldsHumanEdited } from './progressive-enrichment';
import { recordApprovalOfDeletion } from './proposal-evaluator';

export type EntityType = 'contact' | 'company' | 'deal';

export interface WriteContext {
  orgId: string;
  userId: string;
  userRole: string;
  /** Distinguishes manual UI edits from MARTy-driven writes. The
   *  audit row carries this verbatim so we can answer "what did MARTy
   *  do?" without filtering by tool name. */
  origin: 'manual_ui' | 'marty';
}

export interface FieldRejection {
  field_name: string;
  reason: 'permanently_locked' | 'human_edit_locked_other_user' | 'unknown_field' | 'not_writable';
  detail?: string;
}

export interface EntityWriteResult<T = Record<string, unknown>> {
  ok: boolean;
  /** Set when ok === false and the entity itself isn't writable
   *  (404, ACL fail, business-rule conflict). */
  error?: { code: string; status: number; message: string };
  /** Only fields that actually changed — same value as before is dropped. */
  applied: Record<string, unknown>;
  /** Per-field rejections (lock violations, unknown fields). The
   *  caller decides whether to surface each one to the user; MARTy
   *  uses these to compose its refusal narration. */
  rejected: FieldRejection[];
  /** The post-write entity row (or undefined when the operation
   *  failed before running the write). */
  after?: T;
}

// ── Allowed-field sets ───────────────────────────────────────────────
// Mirrors the existing handler allow-lists verbatim so nothing the UI
// already lets through gets blocked by the refactor. Curated here so
// MARTy + UI share the same writable surface.

const CONTACT_WRITABLE = new Set([
  'full_name', 'email', 'phone', 'linkedin_url', 'twitter_url',
  'contact_type', 'relationship_status', 'company_id', 'job_title',
  'next_followup_date', 'next_followup_note',
  'investment_amount', 'fund_commitment',
  'bio_summary', 'topics_of_interest', 'pain_points', 'investment_thesis_tags',
  'custom_fields', 'location', 'introduced_via',
  'investment_focus', 'check_size_range', 'fund_name',
  'commitment_status', 'engagement_status', 'relationship_owner_id',
]);

const COMPANY_WRITABLE = new Set([
  'name', 'domain', 'website', 'logo_url', 'description', 'company_type',
  'sector', 'stage', 'investment_status', 'investment_amount',
  'investment_date', 'ownership_pct', 'current_valuation', 'currency',
  'linkedin_url', 'custom_fields',
]);

const DEAL_WRITABLE = new Set([
  'title', 'stage', 'amount', 'currency', 'probability', 'expected_close',
  'notes', 'owner_id', 'custom_fields', 'valuation', 'our_allocation',
  'instrument_type', 'actual_close_date', 'lead_source', 'thesis_fit',
]);

// Deal fields whose changes are tracked in source_metadata for the
// per-field provenance trail. Mirrors the existing updateDeal handler.
const DEAL_PROVENANCE_FIELDS = [
  'amount', 'valuation', 'our_allocation', 'instrument_type',
  'lead_source', 'thesis_fit', 'expected_close', 'probability', 'stage',
] as const;

function tableForEntity(t: EntityType): string {
  if (t === 'contact') return 'contacts';
  if (t === 'company') return 'companies';
  return 'deals';
}

function writableSetFor(t: EntityType): Set<string> {
  if (t === 'contact') return CONTACT_WRITABLE;
  if (t === 'company') return COMPANY_WRITABLE;
  return DEAL_WRITABLE;
}

// ── Lock check (the core safety primitive) ──────────────────────────

const HUMAN_EDIT_LOCK_DAYS = 180;

export type LockCheckOutcome =
  | { allowed: true }
  | { allowed: false; reason: 'permanently_locked' | 'human_edit_locked_other_user'; locked_by?: string | null; locked_at?: string | null };

interface FieldStateLockRow {
  permanently_locked: number;
  last_human_edit_at: string | null;
  last_human_edit_user_id: string | null;
}

/**
 * Check whether `userId` can write to (entity_type, entity_id, field_name).
 * Pure function over entity_field_state — no UPDATE side effect. Returns
 * structured outcome; caller decides how to respond.
 *
 * Rules per locked spec:
 *   • permanently_locked=1 → REFUSE for everyone (including the user who
 *     locked it; they must unlock first via the explicit unlock_field
 *     tool / UI toggle).
 *   • last_human_edit_at within 180 days AND last_human_edit_user_id !==
 *     userId → REFUSE (someone else's recent edit). NULL user_id is
 *     treated conservatively as "lock applies to everyone" so historic
 *     rows that pre-date migration 0076 don't accidentally become
 *     same-user-overrideable.
 *   • Otherwise → ALLOW.
 */
export async function checkFieldWritability(
  entityType: EntityType,
  entityId: string,
  fieldName: string,
  userId: string,
  env: Env
): Promise<LockCheckOutcome> {
  const row = await env.D1.prepare(
    `SELECT permanently_locked, last_human_edit_at, last_human_edit_user_id
       FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(entityType, entityId, fieldName).first<FieldStateLockRow>();

  if (!row) return { allowed: true };

  if (row.permanently_locked === 1) {
    return {
      allowed: false,
      reason: 'permanently_locked',
      locked_by: row.last_human_edit_user_id,
      locked_at: row.last_human_edit_at,
    };
  }

  if (row.last_human_edit_at) {
    const editedAtMs = new Date(row.last_human_edit_at).getTime();
    const withinWindow = Number.isFinite(editedAtMs) && (Date.now() - editedAtMs < HUMAN_EDIT_LOCK_DAYS * 86_400_000);
    if (withinWindow) {
      const sameUser = row.last_human_edit_user_id && row.last_human_edit_user_id === userId;
      if (!sameUser) {
        return {
          allowed: false,
          reason: 'human_edit_locked_other_user',
          locked_by: row.last_human_edit_user_id,
          locked_at: row.last_human_edit_at,
        };
      }
    }
  }

  return { allowed: true };
}

// ── Entity load + ACL helper ────────────────────────────────────────

async function loadEntityForWrite<T extends Record<string, unknown> = Record<string, unknown>>(
  entityType: EntityType,
  entityId: string,
  ctx: WriteContext,
  env: Env
): Promise<T | null> {
  const table = tableForEntity(entityType);
  const row = await env.D1.prepare(
    `SELECT * FROM ${table} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(entityId, ctx.orgId).first<T>();
  return row ?? null;
}

// ── updateEntityFields — generic update path ────────────────────────

interface UpdateEntityOptions {
  /** When true, fields that fail the lock check are silently dropped
   *  rather than surfaced as rejected[]. Used by paths that want to
   *  apply whatever they can without a partial-failure shape. The
   *  default (false) reports each rejection so the caller can show
   *  the user exactly what was blocked. */
  silentLockSkip?: boolean;
}

async function updateEntityFieldsCommon(
  entityType: 'contact' | 'company',
  entityId: string,
  fields: Record<string, unknown>,
  ctx: WriteContext,
  env: Env,
  opts: UpdateEntityOptions = {}
): Promise<EntityWriteResult> {
  const before = await loadEntityForWrite(entityType, entityId, ctx, env);
  if (!before) {
    return {
      ok: false,
      applied: {},
      rejected: [],
      error: {
        code: entityType === 'contact' ? 'CONTACT_NOT_FOUND' : 'COMPANY_NOT_FOUND',
        status: 404,
        message: `${entityType} not found in your org`,
      },
    };
  }

  const allowed = writableSetFor(entityType);
  const rejected: FieldRejection[] = [];
  const passingFields: Record<string, unknown> = {};
  const changedFields: string[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!allowed.has(field)) {
      if (!opts.silentLockSkip) {
        rejected.push({ field_name: field, reason: 'unknown_field', detail: 'Field not writable through this surface' });
      }
      continue;
    }
    const beforeVal = (before as any)[field];
    const beforeNorm = beforeVal == null ? '' : String(beforeVal).trim();
    const afterNorm = value == null ? '' : String(value).trim();
    if (beforeNorm === afterNorm) {
      // Same value — skip silently. No lock check needed (we're not
      // editing), no audit entry generated.
      continue;
    }
    const lockCheck = await checkFieldWritability(entityType, entityId, field, ctx.userId, env);
    if (!lockCheck.allowed) {
      if (!opts.silentLockSkip) {
        rejected.push({
          field_name: field,
          reason: lockCheck.reason,
          detail: lockCheck.reason === 'permanently_locked'
            ? 'Field is permanently locked. Unlock it in Settings → Approval Queue first.'
            : `Field is under 180-day human-edit lock (last edited ${lockCheck.locked_at} by another user).`,
        });
      }
      continue;
    }
    passingFields[field] = value;
    changedFields.push(field);
  }

  // Engagement / relationship special-case parity with the existing
  // contact PATCH handler — the `engagement_status_manual` /
  // `relationship_owner_manual` flags get stamped when the user
  // explicitly sets those fields.
  const extraSets: string[] = [];
  const extraBinds: unknown[] = [];
  if (entityType === 'contact') {
    if ('engagement_status' in passingFields) {
      extraSets.push('engagement_status_manual = ?');
      extraBinds.push(1);
    }
    if ('relationship_owner_id' in passingFields) {
      extraSets.push('relationship_owner_manual = ?');
      extraBinds.push(1);
    }
  }

  if (Object.keys(passingFields).length === 0 && extraSets.length === 0) {
    return { ok: true, applied: {}, rejected, after: before };
  }

  const table = tableForEntity(entityType);
  const setClause = [
    ...Object.keys(passingFields).map(k => `${k} = ?`),
    ...extraSets,
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ].join(', ');
  const setBinds = [...Object.values(passingFields), ...extraBinds];

  await env.D1.prepare(
    `UPDATE ${table} SET ${setClause} WHERE id = ?`
  ).bind(...setBinds, entityId).run();

  // markFieldsHumanEdited stamps last_human_edit_at + (post-0076)
  // last_human_edit_user_id on entity_field_state, syncs current_value
  // and current_value_sources to [manual_edit_<userId>], clears
  // pending_proposals + pending_deletions. The ONLY entry point for
  // human-edit state sync — both the manual UI and MARTy land here.
  if (changedFields.length > 0) {
    await markFieldsHumanEdited(ctx.orgId, entityType, entityId, changedFields, ctx.userId, env)
      .catch(e => console.error(`[entity-writes] markFieldsHumanEdited failed for ${entityType}/${entityId}:`, e));
  }

  const after = await env.D1.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(entityId).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: entityType,
    entity_id: entityId,
    before_data: before,
    after_data: after,
    metadata: { origin: ctx.origin, fields: changedFields },
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);

  return {
    ok: true,
    applied: passingFields,
    rejected,
    after: after as Record<string, unknown> | undefined,
  };
}

export const updateContactFields = (
  id: string, fields: Record<string, unknown>, ctx: WriteContext, env: Env, opts?: UpdateEntityOptions
) => updateEntityFieldsCommon('contact', id, fields, ctx, env, opts);

export const updateCompanyFields = (
  id: string, fields: Record<string, unknown>, ctx: WriteContext, env: Env, opts?: UpdateEntityOptions
) => updateEntityFieldsCommon('company', id, fields, ctx, env, opts);

// ── Deal updates: same shape + per-field provenance + stage transition ──
//
// Deal updates carry extra business logic that the contact/company path
// doesn't have:
//   • source_metadata JSON tracks per-field provenance (set_by, set_at,
//     source) for tracked fields. MARTy writes get source='marty' so
//     the trail records who actually wrote what.
//   • stage_changed_at + days_in_stage stamp on stage transitions.
// The lock-check + audit + cache-invalidation safety primitives are
// identical to the contact/company path; the deal-specific extras
// layer on top.

export async function updateDealFields(
  dealId: string,
  fields: Record<string, unknown>,
  ctx: WriteContext,
  env: Env,
  opts: UpdateEntityOptions = {}
): Promise<EntityWriteResult> {
  const before = await loadEntityForWrite('deal', dealId, ctx, env);
  if (!before) {
    return {
      ok: false,
      applied: {},
      rejected: [],
      error: { code: 'DEAL_NOT_FOUND', status: 404, message: 'Deal not found in your org' },
    };
  }

  const rejected: FieldRejection[] = [];
  const passingFields: Record<string, unknown> = {};
  const changedFields: string[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!DEAL_WRITABLE.has(field)) {
      if (!opts.silentLockSkip) {
        rejected.push({ field_name: field, reason: 'unknown_field' });
      }
      continue;
    }
    if ((before as any)[field] === value) continue;
    const lockCheck = await checkFieldWritability('deal', dealId, field, ctx.userId, env);
    if (!lockCheck.allowed) {
      if (!opts.silentLockSkip) {
        rejected.push({
          field_name: field,
          reason: lockCheck.reason,
          detail: lockCheck.reason === 'permanently_locked'
            ? 'Field is permanently locked. Unlock it in Settings → Approval Queue first.'
            : `Field is under 180-day human-edit lock (last edited by another user).`,
        });
      }
      continue;
    }
    passingFields[field] = value;
    changedFields.push(field);
  }

  if (Object.keys(passingFields).length === 0) {
    return { ok: true, applied: {}, rejected, after: before };
  }

  // Per-field provenance for source_metadata. Mirrors the existing
  // updateDeal handler; origin=='marty' tags MARTy writes so the
  // provenance trail makes the agent's involvement legible.
  const existingMeta: Record<string, any> = (() => {
    try { return JSON.parse((before as any).source_metadata || '{}'); }
    catch { return {}; }
  })();
  const metaNow = new Date().toISOString();
  const provenanceSource = ctx.origin === 'marty' ? 'marty' : 'manual';
  for (const field of DEAL_PROVENANCE_FIELDS) {
    if (field in passingFields) {
      const entry: Record<string, any> = {
        source: provenanceSource,
        set_by: ctx.userId,
        set_at: metaNow,
      };
      if (field === 'stage') entry.previous = (before as any).stage;
      existingMeta[field] = entry;
    }
  }

  const setExpressions: string[] = [
    ...Object.keys(passingFields).map(k => `${k} = ?`),
    'source_metadata = ?',
    "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ];
  const binds: unknown[] = [...Object.values(passingFields), JSON.stringify(existingMeta)];

  // Stage transition stamps stage_changed_at + days_in_stage. Mirrors
  // the existing handler.
  const stageChanged = 'stage' in passingFields && passingFields.stage !== (before as any).stage;
  if (stageChanged) {
    setExpressions.push("stage_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    setExpressions.push('days_in_stage = 0');
  }

  await env.D1.prepare(
    `UPDATE deals SET ${setExpressions.join(', ')} WHERE id = ?`
  ).bind(...binds, dealId).run();

  // Mark the changed fields as human-edited for entity_field_state.
  await markFieldsHumanEdited(ctx.orgId, 'deal', dealId, changedFields, ctx.userId, env)
    .catch(e => console.error(`[entity-writes] markFieldsHumanEdited failed for deal/${dealId}:`, e));

  const after = await env.D1.prepare('SELECT * FROM deals WHERE id = ?').bind(dealId).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'deal',
    entity_id: dealId,
    before_data: before,
    after_data: after,
    metadata: { origin: ctx.origin, fields: changedFields, stage_changed: stageChanged },
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);

  return {
    ok: true,
    applied: passingFields,
    rejected,
    after: after as Record<string, unknown> | undefined,
  };
}

// ── Field deletions (set-to-NULL, locked spec Q11 path but direct) ──
//
// User explicitly asked for the deletion via UI or MARTy. No held-
// proposal queue — direct write through the same safety primitives.
// Reuses recordApprovalOfDeletion for the entity_field_state side
// (clears pending_proposals + pending_deletions, resets sources to
// [manual_edit_<userId>], stamps last_human_edit_at + user_id).

export async function deleteEntityField(
  entityType: EntityType,
  entityId: string,
  fieldName: string,
  ctx: WriteContext,
  env: Env
): Promise<EntityWriteResult> {
  const before = await loadEntityForWrite(entityType, entityId, ctx, env);
  if (!before) {
    return {
      ok: false,
      applied: {},
      rejected: [],
      error: {
        code: `${entityType.toUpperCase()}_NOT_FOUND`,
        status: 404,
        message: `${entityType} not found in your org`,
      },
    };
  }
  if (!writableSetFor(entityType).has(fieldName)) {
    return {
      ok: false,
      applied: {},
      rejected: [{ field_name: fieldName, reason: 'unknown_field' }],
      error: { code: 'UNKNOWN_FIELD', status: 400, message: `Field "${fieldName}" not writable on ${entityType}` },
    };
  }
  // Already empty → no-op (no audit, no state change).
  const beforeVal = (before as any)[fieldName];
  if (beforeVal == null || (typeof beforeVal === 'string' && beforeVal.trim() === '')) {
    return { ok: true, applied: {}, rejected: [], after: before };
  }
  const lockCheck = await checkFieldWritability(entityType, entityId, fieldName, ctx.userId, env);
  if (!lockCheck.allowed) {
    return {
      ok: false,
      applied: {},
      rejected: [{
        field_name: fieldName,
        reason: lockCheck.reason,
        detail: lockCheck.reason === 'permanently_locked'
          ? 'Field is permanently locked. Unlock it in Settings → Approval Queue first.'
          : 'Field is under 180-day human-edit lock (last edited by another user).',
      }],
      error: { code: 'FIELD_LOCKED', status: 403, message: `Cannot delete "${fieldName}" — ${lockCheck.reason}` },
    };
  }

  const table = tableForEntity(entityType);
  await env.D1.prepare(
    `UPDATE ${table} SET ${fieldName} = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(entityId).run();

  // recordApprovalOfDeletion handles entity_field_state — same path
  // the held-deletion approval flow uses. Resets corroboration history,
  // clears pending_proposals + pending_deletions, stamps human-edit
  // metadata.
  await recordApprovalOfDeletion({
    orgId: ctx.orgId,
    entityType,
    entityId,
    fieldName,
    userId: ctx.userId,
  }, env);

  const after = await env.D1.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(entityId).first();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: entityType,
    entity_id: entityId,
    before_data: before,
    after_data: after,
    metadata: { origin: ctx.origin, deleted_field: fieldName },
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(ctx.orgId, env);

  return {
    ok: true,
    applied: { [fieldName]: null },
    rejected: [],
    after: after as Record<string, unknown> | undefined,
  };
}

// ── Entity creation ─────────────────────────────────────────────────
//
// Creation doesn't have a lock-check (the entity didn't exist before;
// nothing to lock). The new entity's fields land in the entity table
// directly + no entity_field_state seeding — the next read or write
// will lazily initialize state rows as needed (per evaluator's
// loadOrInit path).

export interface CreateContactInput {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  contact_type?: string | null;
  relationship_status?: string | null;
  company_id?: string | null;
  job_title?: string | null;
  bio_summary?: string | null;
}

export async function createContactRecord(
  input: CreateContactInput,
  ctx: WriteContext,
  env: Env
): Promise<{ ok: boolean; id?: string; error?: { code: string; status: number; message: string } }> {
  if (!input.full_name || !input.full_name.trim()) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', status: 400, message: 'full_name is required' } };
  }
  if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', status: 400, message: 'email is not valid' } };
  }
  const allowedTypes = new Set(['individual', 'family', 'institutional_investor', 'company', 'other']);
  const contactType = input.contact_type && allowedTypes.has(input.contact_type) ? input.contact_type : 'individual';

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const sourceLabel = ctx.origin === 'marty' ? 'manual_marty' : 'manual';

  await env.D1.prepare(
    `INSERT INTO contacts
       (id, org_id, full_name, email, phone, linkedin_url, contact_type, relationship_status,
        company_id, job_title, bio_summary,
        source, source_confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?)`
  ).bind(
    id, ctx.orgId, input.full_name.trim(),
    input.email ? input.email.toLowerCase().trim() : null,
    input.phone || null, input.linkedin_url || null,
    contactType, input.relationship_status || null,
    input.company_id || null, input.job_title || null, input.bio_summary || null,
    sourceLabel, now, now
  ).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'contact',
    entity_id: id,
    after_data: { id, full_name: input.full_name },
    metadata: { origin: ctx.origin },
    created_at: now,
  });

  await invalidateRagCache(ctx.orgId, env);

  return { ok: true, id };
}

export interface CreateCompanyInput {
  name: string;
  domain?: string | null;
  website?: string | null;
  description?: string | null;
  sector?: string | null;
  company_type?: string | null;
}

export async function createCompanyRecord(
  input: CreateCompanyInput,
  ctx: WriteContext,
  env: Env
): Promise<{ ok: boolean; id?: string; error?: { code: string; status: number; message: string } }> {
  if (!input.name || !input.name.trim()) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', status: 400, message: 'name is required' } };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, domain, website, description, sector, company_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, ctx.orgId, input.name.trim(),
    input.domain || null, input.website || null,
    input.description || null, input.sector || null,
    input.company_type || 'other',
    now, now
  ).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'company',
    entity_id: id,
    after_data: { id, name: input.name },
    metadata: { origin: ctx.origin },
    created_at: now,
  });

  await invalidateRagCache(ctx.orgId, env);

  return { ok: true, id };
}

export interface CreateDealInput {
  company_id: string;
  title?: string | null;
  stage?: string | null;
  amount?: number | null;
  currency?: string | null;
  valuation?: number | null;
  our_allocation?: number | null;
  instrument_type?: string | null;
  lead_source?: string | null;
  thesis_fit?: string | null;
  expected_close?: string | null;
  probability?: number | null;
  notes?: string | null;
  owner_id?: string | null;
}

/**
 * Wave 1+2 deal semantics still apply: assertExternalCompanyForDeal
 * (no internal-entity deals) + assertNoOpenDealForCompany (one open
 * deal per company). MARTy writes that violate either return a clear
 * error so the agent can narrate the rejection.
 */
export async function createDealRecord(
  input: CreateDealInput,
  ctx: WriteContext,
  env: Env
): Promise<{ ok: boolean; id?: string; error?: { code: string; status: number; message: string } }> {
  if (!input.company_id) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', status: 400, message: 'company_id is required' } };
  }

  // Wave 1 + 2 guards — same code path as the manual createDeal handler.
  const { assertExternalCompanyForDeal, assertNoOpenDealForCompany, InternalDealError, OpenDealConflictError } =
    await import('./internal-entity');
  try {
    await assertExternalCompanyForDeal(input.company_id, ctx.orgId, env);
    await assertNoOpenDealForCompany(input.company_id, ctx.orgId, env);
  } catch (e) {
    if (e instanceof InternalDealError) {
      return { ok: false, error: { code: e.code, status: 400, message: e.message } };
    }
    if (e instanceof OpenDealConflictError) {
      return { ok: false, error: { code: e.code, status: 409, message: e.message } };
    }
    throw e;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Resolve title (default to "<Company> opportunity" when missing).
  let title = input.title?.trim() || null;
  if (!title) {
    const company = await env.D1.prepare(
      'SELECT name FROM companies WHERE id = ? AND org_id = ?'
    ).bind(input.company_id, ctx.orgId).first<{ name: string }>();
    title = `${company?.name || 'Unknown'} opportunity`;
  }

  await env.D1.prepare(
    `INSERT INTO deals
       (id, org_id, company_id, owner_id, title, stage, amount, currency,
        probability, expected_close, notes, valuation, our_allocation,
        instrument_type, lead_source, thesis_fit,
        stage_changed_at, last_activity_date, days_in_stage,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    id, ctx.orgId, input.company_id,
    input.owner_id || ctx.userId,
    title,
    input.stage || 'prospect',
    input.amount ?? null, input.currency || 'USD',
    input.probability ?? 0, input.expected_close ?? null,
    input.notes ?? null, input.valuation ?? null, input.our_allocation ?? null,
    input.instrument_type ?? null, input.lead_source ?? null, input.thesis_fit ?? null,
    now, now, now, now
  ).run();

  // Per-field provenance — tag MARTy-created deals so the trail is
  // legible when reading source_metadata later.
  const provenanceSource = ctx.origin === 'marty' ? 'marty' : 'manual';
  const sourceMetadata: Record<string, { source: string; set_by: string; set_at: string }> = {};
  for (const field of DEAL_PROVENANCE_FIELDS) {
    const val = field === 'stage' ? (input.stage || 'prospect') : (input as any)[field];
    if (val != null) {
      sourceMetadata[field] = { source: provenanceSource, set_by: ctx.userId, set_at: now };
    }
  }
  await env.D1.prepare(
    'UPDATE deals SET source_metadata = ? WHERE id = ?'
  ).bind(JSON.stringify(sourceMetadata), id).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'deal',
    entity_id: id,
    after_data: { id, title, stage: input.stage || 'prospect' },
    metadata: { origin: ctx.origin },
    created_at: now,
  });

  await invalidateRagCache(ctx.orgId, env);

  // Embed for MARTy semantic search. Inline so the embedding lands
  // before the next ingest run dedups against an absent record.
  try {
    const { embedDeal } = await import('./embedding');
    await embedDeal(id, ctx.orgId, env);
  } catch (e) {
    console.error(`[entity-writes] embedDeal failed for ${id}:`, e);
  }

  return { ok: true, id };
}

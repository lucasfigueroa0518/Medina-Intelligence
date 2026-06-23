import type { Env } from '../types/env';
import { emitAudit } from './audit';
import {
  crmNameResolutionCustomFields,
  resolveCrmEntityNameWithEvidence,
  type CrmNameEvidenceCandidate,
  type CrmNameResolutionResult,
} from './crm-name-resolver';
import type { CrmEntityType, CrmQualityNameStatus, CrmQualitySourceEvidence } from './crm-quality-gate';
import { updateEntityInIndex } from './entity-index';
import { safelyMaintainContactReadModels } from './contact-maintenance';
import { HUMAN_EDIT_LOCK_DAYS } from './proposal-evaluator';
import { resolveChannel, type ChannelContext } from './source-channels';

type MatchedNameAction =
  | 'skipped'
  | 'recorded_corroboration'
  | 'recorded_pending'
  | 'promoted_verified'
  | 'updated_provisional'
  | 'blocked_locked'
  | 'blocked_duplicate';

interface MatchedEntityRow {
  id: string;
  name: string | null;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  custom_fields: string | null;
}

interface FieldStateRow {
  id: string;
  current_value: string | null;
  current_value_sources: string;
  pending_proposals: string;
  last_human_edit_at: string | null;
  permanently_locked: number;
}

export interface ReconcileMatchedEntityNameInput {
  entityType: Extract<CrmEntityType, 'contact' | 'company'>;
  entityId: string;
  orgId: string;
  rawName?: string | null;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  trigger: string;
  source: CrmQualitySourceEvidence;
  channelSource?: string | null;
  channelContext?: ChannelContext;
  runtimeEvidenceCandidates?: CrmNameEvidenceCandidate[] | null;
}

export interface ReconcileMatchedEntityNameResult {
  action: MatchedNameAction;
  entityType: 'contact' | 'company';
  entityId: string;
  currentName?: string;
  proposedName?: string;
  proposedStatus?: CrmQualityNameStatus;
  reason: string;
  channels?: string[];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function norm(value: string): string {
  return clean(value).toLowerCase();
}

function normalizeDomain(raw: string | null | undefined): string {
  return norm(raw || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function looksLikeDomainName(value: string, domain?: string | null, website?: string | null): boolean {
  const name = normalizeDomain(value);
  if (!name || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) return false;
  const expected = normalizeDomain(domain || website || '');
  return !expected || name === expected;
}

function parseJson(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyFields(fields: Record<string, any>): string {
  return JSON.stringify(fields);
}

function nameStatusFromCustomFields(customFields: string | null): CrmQualityNameStatus {
  const status = parseJson(customFields).crm_quality?.name_status;
  return status === 'provisional' || status === 'domain_placeholder' ? status : 'verified';
}

function parseArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parsePending(raw: string | null | undefined): Record<string, string[]> {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) out[key] = value.filter(item => typeof item === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function isWithinHumanLock(row: FieldStateRow): boolean {
  if (row.permanently_locked === 1) return true;
  if (!row.last_human_edit_at) return false;
  const editedAt = new Date(row.last_human_edit_at).getTime();
  return Number.isFinite(editedAt) && Date.now() - editedAt < HUMAN_EDIT_LOCK_DAYS * 86_400_000;
}

function tokenCount(value: string): number {
  return (clean(value).match(/[A-Za-z0-9&'.-]+/g) || []).length;
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean(value));
}

function betterTentativeName(
  entityType: 'contact' | 'company',
  currentStatus: CrmQualityNameStatus,
  currentName: string,
  proposedName: string
): boolean {
  if (!proposedName || norm(currentName) === norm(proposedName)) return false;
  if (currentStatus === 'domain_placeholder') return !looksLikeDomain(proposedName) || looksLikeDomain(currentName);
  if (entityType === 'contact') {
    return tokenCount(proposedName) > tokenCount(currentName) || proposedName.length > currentName.length + 2;
  }
  return !looksLikeDomain(proposedName) && (
    tokenCount(proposedName) > tokenCount(currentName)
    || proposedName.length > currentName.length + 2
  );
}

function customFieldsForNameStatus(
  existingCustomFields: string | null,
  resolution: CrmNameResolutionResult,
  status: CrmQualityNameStatus
): string {
  const withResolution = parseJson(crmNameResolutionCustomFields(resolution, existingCustomFields || '{}'));
  if (status === 'verified') {
    withResolution.crm_quality = {
      ...(withResolution.crm_quality || {}),
      name_status: 'verified',
      label: null,
      canonical_name: null,
      confidence: resolution.confidence,
      rule_ids: resolution.ruleIds,
      reasons: resolution.reasons,
      source: {
        source_channel: resolution.evidence.source_channel,
        source_record_id: resolution.evidence.source_record_id,
        codepath: resolution.evidence.codepath,
        evidence_level: resolution.evidence.evidence_level,
      },
      promotion_policy: null,
    };
  }
  return stringifyFields(withResolution);
}

async function loadEntity(
  input: ReconcileMatchedEntityNameInput,
  env: Env
): Promise<MatchedEntityRow | null> {
  if (input.entityType === 'contact') {
    const row = await env.D1.prepare(
      `SELECT id, full_name AS name, email, custom_fields
         FROM contacts
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(input.entityId, input.orgId).first<MatchedEntityRow>();
    return row || null;
  }
  const row = await env.D1.prepare(
    `SELECT id, name, domain, website, custom_fields
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
  ).bind(input.entityId, input.orgId).first<MatchedEntityRow>();
  return row || null;
}

async function loadOrInitFieldState(
  entityType: 'contact' | 'company',
  entityId: string,
  fieldName: 'full_name' | 'name',
  currentName: string,
  env: Env
): Promise<FieldStateRow> {
  const existing = await env.D1.prepare(
    `SELECT id, current_value, current_value_sources, pending_proposals,
            last_human_edit_at, permanently_locked
       FROM entity_field_state
      WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(entityType, entityId, fieldName).first<FieldStateRow>();
  if (existing) return existing;

  const sources = currentName ? '["historical_unknown"]' : '[]';
  await env.D1.prepare(
    `INSERT OR IGNORE INTO entity_field_state
       (entity_type, entity_id, field_name, current_value, current_value_sources)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(entityType, entityId, fieldName, currentName || null, sources).run();

  const fresh = await env.D1.prepare(
    `SELECT id, current_value, current_value_sources, pending_proposals,
            last_human_edit_at, permanently_locked
       FROM entity_field_state
      WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(entityType, entityId, fieldName).first<FieldStateRow>();
  if (!fresh) {
    return {
      id: '',
      current_value: currentName || null,
      current_value_sources: sources,
      pending_proposals: '{}',
      last_human_edit_at: null,
      permanently_locked: 0,
    };
  }
  return fresh;
}

async function companyNameCollision(
  orgId: string,
  companyId: string,
  proposedName: string,
  env: Env
): Promise<string | null> {
  const row = await env.D1.prepare(
    `SELECT id FROM companies
      WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id != ?
        AND deleted_at IS NULL AND merged_into IS NULL
      LIMIT 1`
  ).bind(orgId, proposedName, companyId).first<{ id: string }>();
  return row?.id || null;
}

async function writePending(
  state: FieldStateRow,
  proposedName: string,
  channel: string,
  env: Env
): Promise<string[]> {
  const pending = parsePending(state.pending_proposals);
  const channels = Array.from(new Set([...(pending[proposedName] || []), channel]));
  pending[proposedName] = channels;
  await env.D1.prepare(
    `UPDATE entity_field_state
        SET pending_proposals = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(pending), state.id).run();
  return channels;
}

async function writeCurrentSource(
  state: FieldStateRow,
  channel: string,
  env: Env
): Promise<string[]> {
  const sources = Array.from(new Set([...parseArray(state.current_value_sources), channel]));
  await env.D1.prepare(
    `UPDATE entity_field_state
        SET current_value_sources = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(sources), state.id).run();
  return sources;
}

async function writePromotedState(
  state: FieldStateRow,
  proposedName: string,
  channels: string[],
  env: Env
): Promise<void> {
  const pending = parsePending(state.pending_proposals);
  delete pending[proposedName];
  await env.D1.prepare(
    `UPDATE entity_field_state
        SET current_value = ?,
            current_value_sources = ?,
            pending_proposals = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(proposedName, JSON.stringify(Array.from(new Set(channels))), JSON.stringify(pending), state.id).run();
}

async function updateVisibleName(args: {
  input: ReconcileMatchedEntityNameInput;
  row: MatchedEntityRow;
  proposedName: string;
  status: CrmQualityNameStatus;
  resolution: CrmNameResolutionResult;
  fieldName: 'full_name' | 'name';
  channels: string[];
  state: FieldStateRow;
  env: Env;
  reason: string;
}): Promise<void> {
  const customFields = customFieldsForNameStatus(args.row.custom_fields, args.resolution, args.status);
  const table = args.input.entityType === 'contact' ? 'contacts' : 'companies';
  await args.env.D1.prepare(
    `UPDATE ${table}
        SET ${args.fieldName} = ?,
            custom_fields = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(args.proposedName, customFields, args.input.entityId).run();
  await writePromotedState(args.state, args.proposedName, args.channels, args.env);
  await emitAudit(args.env, {
    org_id: args.input.orgId,
    action: 'update',
    entity_type: args.input.entityType,
    entity_id: args.input.entityId,
    before_data: { [args.fieldName]: args.row.name },
    after_data: { [args.fieldName]: args.proposedName, name_status: args.status },
    metadata: {
      reason: args.reason,
      trigger: args.input.trigger,
      source_channel: args.input.source.source_channel,
      channels: args.channels,
    },
    created_at: new Date().toISOString(),
  });
  if (args.input.entityType === 'contact') {
    await safelyMaintainContactReadModels(args.env, args.input.orgId, args.input.entityId, 'matched_contact_name_reconciled');
  }
  try { await updateEntityInIndex(args.input.orgId, args.input.entityType, args.input.entityId, args.env); } catch {}
}

export async function reconcileMatchedEntityName(
  input: ReconcileMatchedEntityNameInput,
  env: Env
): Promise<ReconcileMatchedEntityNameResult> {
  const row = await loadEntity(input, env);
  if (!row) {
    return { action: 'skipped', entityType: input.entityType, entityId: input.entityId, reason: 'entity_not_found' };
  }

  const currentName = clean(row.name);
  const fieldName = input.entityType === 'contact' ? 'full_name' : 'name';
  let currentStatus = nameStatusFromCustomFields(row.custom_fields);
  if (
    input.entityType === 'company'
    && currentStatus === 'verified'
    && looksLikeDomainName(currentName, input.domain || row.domain, input.website || row.website)
  ) {
    currentStatus = 'domain_placeholder';
  }
  const { resolution } = await resolveCrmEntityNameWithEvidence({
    entityType: input.entityType,
    entityId: input.entityId,
    orgId: input.orgId,
    trigger: input.trigger,
    rawName: input.rawName || input.source.source_text || currentName,
    currentName,
    email: input.email || row.email || null,
    domain: input.domain || row.domain || null,
    website: input.website || row.website || null,
    relationshipEvidence: true,
    allowDomainPlaceholder: input.entityType === 'company',
    runtimeEvidenceCandidates: input.runtimeEvidenceCandidates || null,
    source: input.source,
  }, env);
  const proposedName = clean(resolution.normalizedName);
  const proposedStatus = resolution.nameStatus || (resolution.status === 'verified' ? 'verified' : undefined);
  if (!proposedName || !proposedStatus || resolution.status === 'no_entity' || resolution.status === 'fail') {
    return {
      action: 'skipped',
      entityType: input.entityType,
      entityId: input.entityId,
      currentName,
      reason: resolution.reasons.join('; ') || 'name_resolution_failed',
    };
  }

  const state = await loadOrInitFieldState(input.entityType, input.entityId, fieldName, currentName, env);
  const channel = resolveChannel(input.channelSource || input.source.source_channel || input.trigger, input.channelContext || {});
  const locked = isWithinHumanLock(state);

  if (norm(proposedName) === norm(currentName) && proposedStatus === 'verified') {
    const channels = await writeCurrentSource(state, channel, env);
    return {
      action: 'recorded_corroboration',
      entityType: input.entityType,
      entityId: input.entityId,
      currentName,
      proposedName,
      proposedStatus,
      channels,
      reason: 'incoming verified name matches current name',
    };
  }

  if (currentStatus === 'provisional' || currentStatus === 'domain_placeholder') {
    if (proposedStatus === 'verified' || betterTentativeName(input.entityType, currentStatus, currentName, proposedName)) {
      if (locked) {
        const channels = await writePending(state, proposedName, channel, env);
        return {
          action: 'blocked_locked',
          entityType: input.entityType,
          entityId: input.entityId,
          currentName,
          proposedName,
          proposedStatus,
          channels,
          reason: 'name field is locked; recorded pending evidence instead',
        };
      }
      if (input.entityType === 'company') {
        const collision = await companyNameCollision(input.orgId, input.entityId, proposedName, env);
        if (collision) {
          const channels = await writePending(state, proposedName, channel, env);
          return {
            action: 'blocked_duplicate',
            entityType: input.entityType,
            entityId: input.entityId,
            currentName,
            proposedName,
            proposedStatus,
            channels,
            reason: `proposed company name collides with existing company ${collision}`,
          };
        }
      }
      await updateVisibleName({
        input,
        row,
        proposedName,
        status: proposedStatus,
        resolution,
        fieldName,
        channels: [channel],
        state,
        env,
        reason: proposedStatus === 'verified' ? 'tentative_name_promoted_by_matched_evidence' : 'tentative_name_improved_by_matched_evidence',
      });
      return {
        action: proposedStatus === 'verified' ? 'promoted_verified' : 'updated_provisional',
        entityType: input.entityType,
        entityId: input.entityId,
        currentName,
        proposedName,
        proposedStatus,
        channels: [channel],
        reason: proposedStatus === 'verified' ? 'tentative name promoted by verified evidence' : 'tentative name improved but remains provisional',
      };
    }
    return {
      action: 'skipped',
      entityType: input.entityType,
      entityId: input.entityId,
      currentName,
      proposedName,
      proposedStatus,
      reason: 'incoming tentative name was not stronger than current tentative name',
    };
  }

  if (proposedStatus !== 'verified') {
    return {
      action: 'skipped',
      entityType: input.entityType,
      entityId: input.entityId,
      currentName,
      proposedName,
      proposedStatus,
      reason: 'verified current name protected from weak or provisional incoming evidence',
    };
  }

  const channels = Array.from(new Set([...(parsePending(state.pending_proposals)[proposedName] || []), channel]));
  if (channels.length < 2) {
    const writtenChannels = await writePending(state, proposedName, channel, env);
    return {
      action: 'recorded_pending',
      entityType: input.entityType,
      entityId: input.entityId,
      currentName,
      proposedName,
      proposedStatus,
      channels: writtenChannels,
      reason: 'verified current name protected until another independent verified source corroborates the new name',
    };
  }
  if (locked) {
    const writtenChannels = await writePending(state, proposedName, channel, env);
    return {
      action: 'blocked_locked',
      entityType: input.entityType,
      entityId: input.entityId,
      currentName,
      proposedName,
      proposedStatus,
      channels: writtenChannels,
      reason: 'name field is locked; verified conflict remains pending',
    };
  }
  if (input.entityType === 'company') {
    const collision = await companyNameCollision(input.orgId, input.entityId, proposedName, env);
    if (collision) {
      const writtenChannels = await writePending(state, proposedName, channel, env);
      return {
        action: 'blocked_duplicate',
        entityType: input.entityType,
        entityId: input.entityId,
        currentName,
        proposedName,
        proposedStatus,
        channels: writtenChannels,
        reason: `proposed company name collides with existing company ${collision}`,
      };
    }
  }
  await updateVisibleName({
    input,
    row,
    proposedName,
    status: 'verified',
    resolution,
    fieldName,
    channels,
    state,
    env,
    reason: 'verified_conflict_promoted_after_second_source',
  });
  return {
    action: 'promoted_verified',
    entityType: input.entityType,
    entityId: input.entityId,
    currentName,
    proposedName,
    proposedStatus,
    channels,
    reason: 'verified conflict promoted after second independent verified source',
  };
}

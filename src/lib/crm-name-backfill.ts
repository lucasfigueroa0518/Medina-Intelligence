import crypto from 'node:crypto';
import type { Env } from '../types/env';
import { emitAudit } from './audit';
import {
  crmNameResolutionCustomFields,
  resolveCrmEntityNameWithEvidence,
  type CrmNameEvidenceBundle,
  type CrmNameResolutionResult,
} from './crm-name-resolver';
import type { CrmEntityType, CrmQualityNameStatus, CrmQualitySourceEvidence } from './crm-quality-gate';
import { updateEntityInIndex } from './entity-index';
import { safelyMaintainContactReadModels } from './contact-maintenance';
import { HUMAN_EDIT_LOCK_DAYS } from './proposal-evaluator';
import { enqueueWork, deferWork, type WorkQueueRow } from './work-queue';

export const CRM_NAME_BACKFILL_DOMAIN = 'crm_name_backfill_shard';
export const DEFAULT_CRM_NAME_BACKFILL_SHARDS = 24;
const DEFAULT_ENTITY_CHUNK_SIZE = 4;
const SCAN_MULTIPLIER = 12;

export type CrmNameBackfillMode = 'dry_run' | 'apply';
export type CrmNameBackfillApplyStrategy = 'resolver' | 'reviewed_results';
export type CrmNameBackfillEntityType = Extract<CrmEntityType, 'contact' | 'company'>;

export type CrmNameBackfillAction =
  | 'no_op_verified'
  | 'set_status_verified'
  | 'rename_verified'
  | 'rename_provisional'
  | 'set_domain_placeholder'
  | 'record_pending_proposal'
  | 'skip_locked'
  | 'skip_merged_or_deleted'
  | 'error';

export interface CrmNameBackfillPayload {
  run_id: string;
  org_id: string;
  shard_index: number;
  shard_count: number;
  entity_type: CrmNameBackfillEntityType;
  cursor?: string | null;
  mode: CrmNameBackfillMode;
  chunk_size?: number | null;
  apply_strategy?: CrmNameBackfillApplyStrategy | null;
  source_run_id?: string | null;
}

interface EntityRow {
  id: string;
  name: string | null;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  company_id?: string | null;
  custom_fields: string | null;
  deleted_at?: string | null;
  merged_into?: string | null;
}

interface FieldStateRow {
  id: string;
  current_value: string | null;
  current_value_sources: string;
  pending_proposals: string;
  last_human_edit_at: string | null;
  permanently_locked: number;
}

interface ProcessShardResult {
  processed: number;
  scanned: number;
  cursor: string | null;
  done: boolean;
}

interface BackfillRunRow {
  id: string;
  org_id: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  mode: CrmNameBackfillMode;
  shard_count: number;
  apply_strategy?: CrmNameBackfillApplyStrategy | null;
  source_run_id?: string | null;
}

interface BackfillBudgetRow {
  scanned_count: number;
  failed_count: number;
  network_rows: number;
}

interface ReviewedBackfillSourceRow {
  entity_type: CrmNameBackfillEntityType;
  entity_id: string;
  before_name: string | null;
  before_status: string | null;
  proposed_name: string | null;
  proposed_status: string | null;
  action: CrmNameBackfillAction;
  confidence: string | null;
  evidence_summary: string | null;
  rule_ids: string | null;
  risk_flags: string | null;
  cost_tier: number | null;
  network_calls: number | null;
  cache_hits: number | null;
  override_rationale: string | null;
  override_source_artifact: string | null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function norm(value: string): string {
  return clean(value).toLowerCase();
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

function parsePending(raw: string | null | undefined): Record<string, string[]> {
  const parsed = parseJson(raw);
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) out[key] = value.filter(item => typeof item === 'string');
  }
  return out;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function nameStatusFromCustomFields(customFields: string | null): CrmQualityNameStatus {
  const status = parseJson(customFields).crm_quality?.name_status;
  return status === 'provisional' || status === 'domain_placeholder' ? status : 'verified';
}

function statusFromResolution(resolution: CrmNameResolutionResult): CrmQualityNameStatus | null {
  if (resolution.nameStatus) return resolution.nameStatus;
  if (resolution.status === 'verified') return 'verified';
  if (resolution.status === 'provisional') return 'provisional';
  if (resolution.status === 'domain_placeholder') return 'domain_placeholder';
  return null;
}

function isCrmQualityNameStatus(value: string | null | undefined): value is CrmQualityNameStatus {
  return value === 'verified' || value === 'provisional' || value === 'domain_placeholder';
}

function fieldNameFor(entityType: CrmNameBackfillEntityType): 'full_name' | 'name' {
  return entityType === 'contact' ? 'full_name' : 'name';
}

function tableFor(entityType: CrmNameBackfillEntityType): 'contacts' | 'companies' {
  return entityType === 'contact' ? 'contacts' : 'companies';
}

function shardForId(id: string, shardCount: number): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % shardCount;
}

export function selectCrmNameBackfillShardPage<T extends { id: string }>(args: {
  candidates: T[];
  shardIndex: number;
  shardCount: number;
  remaining: number;
}): { selected: T[]; cursor: string | null; inspected: number } {
  const selected: T[] = [];
  let cursor: string | null = null;
  let inspected = 0;
  for (const row of args.candidates) {
    cursor = row.id;
    inspected++;
    if (shardForId(row.id, args.shardCount) !== args.shardIndex) continue;
    selected.push(row);
    if (selected.length >= args.remaining) break;
  }
  return { selected, cursor, inspected };
}

function currentNameLooksSemanticallyUnsafe(value: string): boolean {
  const name = clean(value);
  if (!name) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name) && /\.[a-z]{2,}$/i.test(name)) return true;
  if (/\b20\d{2}\s*[-–]\s*20\d{2},?$/.test(name)) return true;
  if (/^[A-Za-z]{24,}$/.test(name) && !/[A-Z][a-z]+[A-Z][a-z]+/.test(name)) return true;
  if (/[a-z]{8,}[A-Z][a-z]{8,}[A-Z]/.test(name)) return true;
  if (/\b(?:sent|get|from)\b/i.test(name) && name.split(/\s+/).length <= 3) return true;
  if (/^\S+\s+\S+\s+\S+\s+\S+/.test(name) && /\bAnd\b/i.test(name) && !/,/.test(name)) return true;
  return false;
}

function isWithinHumanLock(row: FieldStateRow | null): boolean {
  if (!row) return false;
  if (row.permanently_locked === 1) return true;
  if (!row.last_human_edit_at) return false;
  const editedAt = new Date(row.last_human_edit_at).getTime();
  return Number.isFinite(editedAt) && Date.now() - editedAt < HUMAN_EDIT_LOCK_DAYS * 86_400_000;
}

function customFieldsForStatus(
  existingCustomFields: string | null,
  resolution: CrmNameResolutionResult,
  status: CrmQualityNameStatus
): string {
  const fields = parseJson(crmNameResolutionCustomFields(resolution, existingCustomFields || '{}'));
  if (status === 'verified') {
    fields.crm_quality = {
      ...(fields.crm_quality || {}),
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
  return JSON.stringify(fields);
}

function maxCostTier(bundle: CrmNameEvidenceBundle): number {
  return bundle.candidates.reduce((max, candidate) => Math.max(max, candidate.cost_tier || 0), 0);
}

function evidenceSummary(bundle: CrmNameEvidenceBundle, resolution: CrmNameResolutionResult): string {
  const sources = Array.from(new Set(bundle.candidates.map(candidate => candidate.source_type))).join('; ');
  const accepted = bundle.candidates.find(candidate => candidate.accepted);
  return [
    sources ? `sources=${sources}` : '',
    accepted ? `accepted=${accepted.source_type}:${accepted.value}` : '',
    resolution.reasons[0] || '',
  ].filter(Boolean).join(' | ').slice(0, 900);
}

function selectedRiskFlags(resolution: CrmNameResolutionResult): string[] {
  const selected = resolution.candidates.find(candidate => candidate.accepted) || resolution.candidates[0];
  return selected?.risk_flags || [];
}

function selectedRuleIds(resolution: CrmNameResolutionResult): string[] {
  const selected = resolution.candidates.find(candidate => candidate.accepted) || resolution.candidates[0];
  return Array.from(new Set([...(resolution.ruleIds || []), ...((selected?.ruleIds) || [])]));
}

function actionForEvaluation(args: {
  row: EntityRow;
  beforeName: string;
  beforeStatus: CrmQualityNameStatus;
  proposedName: string;
  proposedStatus: CrmQualityNameStatus;
  resolution: CrmNameResolutionResult;
  fieldState: FieldStateRow | null;
}): CrmNameBackfillAction {
  if (args.row.deleted_at || args.row.merged_into) return 'skip_merged_or_deleted';
  if (!args.proposedName) return 'error';
  if (isWithinHumanLock(args.fieldState)) return 'skip_locked';

  const sameName = norm(args.beforeName) === norm(args.proposedName);
  if (sameName) {
    if (args.proposedStatus === 'verified') {
      return args.beforeStatus === 'verified' ? 'no_op_verified' : 'set_status_verified';
    }
    if (args.proposedStatus === 'domain_placeholder') return 'set_domain_placeholder';
    return 'rename_provisional';
  }

  if (args.beforeStatus === 'provisional' || args.beforeStatus === 'domain_placeholder') {
    if (args.proposedStatus === 'verified') return 'rename_verified';
    if (args.proposedStatus === 'domain_placeholder') return 'set_domain_placeholder';
    return 'rename_provisional';
  }

  if (args.proposedStatus === 'domain_placeholder') return 'record_pending_proposal';
  if (args.proposedStatus !== 'verified') return 'record_pending_proposal';
  if (currentNameLooksSemanticallyUnsafe(args.beforeName)) return 'rename_verified';
  return 'record_pending_proposal';
}

async function loadEntity(
  env: Env,
  orgId: string,
  entityType: CrmNameBackfillEntityType,
  entityId: string
): Promise<EntityRow | null> {
  if (entityType === 'contact') {
    return await env.D1.prepare(
      `SELECT id, full_name AS name, email, company_id, custom_fields, deleted_at, merged_into
         FROM contacts
        WHERE id = ? AND org_id = ?`
    ).bind(entityId, orgId).first<EntityRow>();
  }
  return await env.D1.prepare(
    `SELECT id, name, domain, website, custom_fields, deleted_at, merged_into
       FROM companies
      WHERE id = ? AND org_id = ?`
  ).bind(entityId, orgId).first<EntityRow>();
}

async function loadFieldState(
  env: Env,
  entityType: CrmNameBackfillEntityType,
  entityId: string,
  fieldName: 'full_name' | 'name'
): Promise<FieldStateRow | null> {
  return await env.D1.prepare(
    `SELECT id, current_value, current_value_sources, pending_proposals,
            last_human_edit_at, permanently_locked
       FROM entity_field_state
      WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(entityType, entityId, fieldName).first<FieldStateRow>();
}

async function loadOrInitFieldState(
  env: Env,
  entityType: CrmNameBackfillEntityType,
  entityId: string,
  fieldName: 'full_name' | 'name',
  currentName: string
): Promise<FieldStateRow> {
  const existing = await loadFieldState(env, entityType, entityId, fieldName);
  if (existing) return existing;

  await env.D1.prepare(
    `INSERT OR IGNORE INTO entity_field_state
       (entity_type, entity_id, field_name, current_value, current_value_sources)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(entityType, entityId, fieldName, currentName || null, '["crm_name_backfill_baseline"]').run();

  const created = await loadFieldState(env, entityType, entityId, fieldName);
  if (!created) {
    throw new Error(`failed to initialize entity_field_state for ${entityType}:${entityId}:${fieldName}`);
  }
  return created;
}

async function recordPendingProposal(args: {
  env: Env;
  entityType: CrmNameBackfillEntityType;
  entityId: string;
  fieldName: 'full_name' | 'name';
  currentName: string;
  proposedName: string;
}): Promise<void> {
  const state = await loadOrInitFieldState(args.env, args.entityType, args.entityId, args.fieldName, args.currentName);
  const pending = parsePending(state.pending_proposals);
  pending[args.proposedName] = Array.from(new Set([...(pending[args.proposedName] || []), 'crm_name_backfill']));
  await args.env.D1.prepare(
    `UPDATE entity_field_state
        SET pending_proposals = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(pending), state.id).run();
}

async function writeFieldStateCurrent(args: {
  env: Env;
  entityType: CrmNameBackfillEntityType;
  entityId: string;
  fieldName: 'full_name' | 'name';
  proposedName: string;
}): Promise<void> {
  const state = await loadOrInitFieldState(args.env, args.entityType, args.entityId, args.fieldName, args.proposedName);
  await args.env.D1.prepare(
    `UPDATE entity_field_state
        SET current_value = ?,
            current_value_sources = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(args.proposedName, '["crm_name_backfill"]', state.id).run();
}

async function applyNameBackfill(args: {
  env: Env;
  orgId: string;
  entityType: CrmNameBackfillEntityType;
  entityId: string;
  beforeName: string;
  proposedName: string;
  proposedStatus: CrmQualityNameStatus;
  action: CrmNameBackfillAction;
  resolution: CrmNameResolutionResult;
  existingCustomFields: string | null;
}): Promise<boolean> {
  if (args.action === 'record_pending_proposal') {
    await recordPendingProposal({
      env: args.env,
      entityType: args.entityType,
      entityId: args.entityId,
      fieldName: fieldNameFor(args.entityType),
      currentName: args.beforeName,
      proposedName: args.proposedName,
    });
    return true;
  }

  if (!['set_status_verified', 'rename_verified', 'rename_provisional', 'set_domain_placeholder'].includes(args.action)) {
    return false;
  }

  const table = tableFor(args.entityType);
  const fieldName = fieldNameFor(args.entityType);
  const customFields = customFieldsForStatus(args.existingCustomFields, args.resolution, args.proposedStatus);

  await args.env.D1.prepare(
    `UPDATE ${table}
        SET ${fieldName} = ?,
            custom_fields = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(args.proposedName, customFields, args.entityId, args.orgId).run();

  await writeFieldStateCurrent({
    env: args.env,
    entityType: args.entityType,
    entityId: args.entityId,
    fieldName,
    proposedName: args.proposedName,
  });

  await emitAudit(args.env, {
    org_id: args.orgId,
    action: 'update',
    entity_type: args.entityType,
    entity_id: args.entityId,
    before_data: { [fieldName]: args.beforeName },
    after_data: { [fieldName]: args.proposedName, name_status: args.proposedStatus },
    metadata: {
      reason: 'crm_name_backfill',
      backfill_action: args.action,
      rule_ids: args.resolution.ruleIds,
    },
    created_at: new Date().toISOString(),
  });

  if (args.entityType === 'contact') {
    await safelyMaintainContactReadModels(args.env, args.orgId, args.entityId, 'crm_name_backfill');
  }
  try { await updateEntityInIndex(args.orgId, args.entityType, args.entityId, args.env); } catch {}
  return true;
}

function reviewedResolution(args: {
  entityType: CrmNameBackfillEntityType;
  entityId: string;
  proposedName: string;
  proposedStatus: CrmQualityNameStatus;
  confidence: string | null;
  evidenceSummary: string | null;
  ruleIds: string[];
  riskFlags: string[];
}): CrmNameResolutionResult {
  const confidence = args.confidence === 'high' || args.confidence === 'medium' || args.confidence === 'low'
    ? args.confidence
    : 'medium';
  const ruleIds = Array.from(new Set(['RULE-CRM-NAME-REVIEWED-APPLY-001', ...args.ruleIds]));
  return {
    status: args.proposedStatus,
    normalizedName: args.proposedName,
    nameStatus: args.proposedStatus,
    confidence,
    ruleIds,
    reasons: [
      'reviewed production dry-run result applied without resolver recompute',
      ...(args.evidenceSummary ? [args.evidenceSummary] : []),
    ],
    candidates: [{
      candidateName: args.proposedName,
      normalizedName: args.proposedName,
      status: args.proposedStatus,
      confidence,
      score: 100,
      ruleIds,
      reason: 'reviewed production dry-run result',
      sourceText: args.evidenceSummary || args.proposedName,
      accepted: true,
      risk_flags: args.riskFlags as any,
    }],
    evidence: {
      source_channel: 'crm_name_reviewed_apply',
      source_record_id: args.entityId,
      source_text: args.evidenceSummary || args.proposedName,
      codepath: 'crm_name_backfill_reviewed_results',
      evidence_level: 'corroborated',
    },
  };
}

async function fetchReviewedResultCandidates(args: {
  env: Env;
  orgId: string;
  sourceRunId: string;
  entityType: CrmNameBackfillEntityType;
  cursor: string | null;
  scanLimit: number;
}): Promise<ReviewedBackfillSourceRow[]> {
  const rows = await args.env.D1.prepare(
    `SELECT
        s.entity_type,
        s.entity_id,
        s.before_name,
        s.before_status,
        COALESCE(o.corrected_name, s.proposed_name) AS proposed_name,
        COALESCE(o.corrected_status, s.proposed_status) AS proposed_status,
        COALESCE(o.corrected_action, s.action) AS action,
        COALESCE(o.corrected_confidence, s.confidence) AS confidence,
        CASE
          WHEN o.id IS NOT NULL THEN COALESCE(o.rationale, '') || ' | reviewed_override=' || COALESCE(o.source_artifact, 'unknown')
          ELSE s.evidence_summary
        END AS evidence_summary,
        s.rule_ids,
        s.risk_flags,
        s.cost_tier,
        0 AS network_calls,
        s.cache_hits,
        o.rationale AS override_rationale,
        o.source_artifact AS override_source_artifact
       FROM crm_name_backfill_results s
       LEFT JOIN crm_name_backfill_review_overrides o
         ON o.org_id = s.org_id
        AND o.source_run_id = s.run_id
        AND o.entity_type = s.entity_type
        AND o.entity_id = s.entity_id
        AND o.apply_ready = 1
      WHERE s.org_id = ?
        AND s.run_id = ?
        AND s.entity_type = ?
        AND s.entity_id > ?
      ORDER BY s.entity_id ASC
      LIMIT ?`
  ).bind(args.orgId, args.sourceRunId, args.entityType, args.cursor || '', args.scanLimit).all<ReviewedBackfillSourceRow>();
  return rows.results;
}

async function evaluateAndMaybeApplyReviewedCrmNameBackfillResult(args: {
  env: Env;
  runId: string;
  orgId: string;
  sourceRunId: string;
  sourceRow: ReviewedBackfillSourceRow;
  shardIndex: number;
  shardCount: number;
  mode: CrmNameBackfillMode;
}): Promise<CrmNameBackfillAction> {
  const entityType = args.sourceRow.entity_type;
  const entityId = args.sourceRow.entity_id;
  const row = await loadEntity(args.env, args.orgId, entityType, entityId);
  const beforeName = clean(row?.name || args.sourceRow.before_name || '');
  const beforeStatus = row ? nameStatusFromCustomFields(row.custom_fields) : clean(args.sourceRow.before_status);
  const proposedName = clean(args.sourceRow.proposed_name);
  const proposedStatus = isCrmQualityNameStatus(args.sourceRow.proposed_status) ? args.sourceRow.proposed_status : null;
  const action = args.sourceRow.action;
  const ruleIds = parseStringArray(args.sourceRow.rule_ids);
  const riskFlags = parseStringArray(args.sourceRow.risk_flags);
  const evidenceSummary = clean(args.sourceRow.evidence_summary);

  if (!row || row.deleted_at || row.merged_into) {
    await writeResult({
      env: args.env,
      runId: args.runId,
      orgId: args.orgId,
      entityType,
      entityId,
      shardIndex: args.shardIndex,
      shardCount: args.shardCount,
      mode: args.mode,
      beforeName,
      beforeStatus,
      proposedName: '',
      proposedStatus: '',
      action: 'skip_merged_or_deleted',
      applied: false,
      reviewedEvidenceSummary: evidenceSummary,
      reviewedRuleIds: ruleIds,
      reviewedRiskFlags: riskFlags,
      reviewedCostTier: args.sourceRow.cost_tier || 0,
      reviewedNetworkCalls: 0,
      reviewedCacheHits: args.sourceRow.cache_hits || 0,
    });
    await bumpRunCounts({ env: args.env, runId: args.runId, action: 'skip_merged_or_deleted' });
    return 'skip_merged_or_deleted';
  }

  let applied = false;
  let error: string | null = null;
  let resolution: CrmNameResolutionResult | undefined;
  const canApplyNameAction = ['set_status_verified', 'rename_verified', 'rename_provisional', 'set_domain_placeholder', 'record_pending_proposal'].includes(action);

  if (canApplyNameAction && proposedName && proposedStatus) {
    resolution = reviewedResolution({
      entityType,
      entityId,
      proposedName,
      proposedStatus,
      confidence: args.sourceRow.confidence,
      evidenceSummary,
      ruleIds,
      riskFlags,
    });
    if (args.mode === 'apply' && args.env.CRM_NAME_BACKFILL_APPLY_ENABLED === 'true') {
      applied = await applyNameBackfill({
        env: args.env,
        orgId: args.orgId,
        entityType,
        entityId,
        beforeName,
        proposedName,
        proposedStatus,
        action,
        resolution,
        existingCustomFields: row.custom_fields,
      });
    }
  } else if (action === 'error') {
    error = evidenceSummary || 'source dry-run result was an error';
  } else if (!['no_op_verified', 'skip_locked', 'skip_merged_or_deleted'].includes(action)) {
    error = `reviewed_result_not_applicable:${action}`;
  }

  await writeResult({
    env: args.env,
    runId: args.runId,
    orgId: args.orgId,
    entityType,
    entityId,
    shardIndex: args.shardIndex,
    shardCount: args.shardCount,
    mode: args.mode,
    beforeName,
    beforeStatus,
    proposedName,
    proposedStatus: proposedStatus || clean(args.sourceRow.proposed_status),
    action,
    applied,
    resolution,
    error,
    reviewedConfidence: args.sourceRow.confidence,
    reviewedEvidenceSummary: evidenceSummary,
    reviewedRuleIds: ruleIds,
    reviewedRiskFlags: riskFlags,
    reviewedCostTier: args.sourceRow.cost_tier || 0,
    reviewedNetworkCalls: 0,
    reviewedCacheHits: args.sourceRow.cache_hits || 0,
  });
  await bumpRunCounts({ env: args.env, runId: args.runId, action });
  return action;
}

async function writeResult(args: {
  env: Env;
  runId: string;
  orgId: string;
  entityType: CrmNameBackfillEntityType;
  entityId: string;
  shardIndex: number;
  shardCount: number;
  mode: CrmNameBackfillMode;
  beforeName: string;
  beforeStatus: CrmQualityNameStatus | string;
  proposedName: string;
  proposedStatus: CrmQualityNameStatus | string;
  action: CrmNameBackfillAction;
  applied: boolean;
  resolution?: CrmNameResolutionResult;
  bundle?: CrmNameEvidenceBundle;
  error?: string | null;
  reviewedConfidence?: string | null;
  reviewedEvidenceSummary?: string | null;
  reviewedRuleIds?: string[];
  reviewedRiskFlags?: string[];
  reviewedCostTier?: number | null;
  reviewedNetworkCalls?: number | null;
  reviewedCacheHits?: number | null;
}): Promise<void> {
  const confidence = args.resolution?.confidence || args.reviewedConfidence || null;
  const riskFlags = args.resolution ? selectedRiskFlags(args.resolution) : (args.reviewedRiskFlags || []);
  const ruleIds = args.resolution ? selectedRuleIds(args.resolution) : (args.reviewedRuleIds || []);
  const networkCalls = args.bundle?.network_calls || args.reviewedNetworkCalls || 0;
  const cacheHits = args.bundle?.cache_hits || args.reviewedCacheHits || 0;
  const costTier = args.bundle ? maxCostTier(args.bundle) : (args.reviewedCostTier || 0);
  const summary = args.bundle && args.resolution ? evidenceSummary(args.bundle, args.resolution) : (args.reviewedEvidenceSummary || '');

  await args.env.D1.prepare(
    `INSERT INTO crm_name_backfill_results
       (run_id, org_id, entity_type, entity_id, shard_index, shard_count, mode,
        before_name, before_status, proposed_name, proposed_status, action,
        applied, confidence, evidence_summary, rule_ids, risk_flags, cost_tier,
        network_calls, cache_hits, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, entity_type, entity_id) DO UPDATE SET
        before_name = excluded.before_name,
        before_status = excluded.before_status,
        proposed_name = excluded.proposed_name,
        proposed_status = excluded.proposed_status,
        action = excluded.action,
        applied = excluded.applied,
        confidence = excluded.confidence,
        evidence_summary = excluded.evidence_summary,
        rule_ids = excluded.rule_ids,
        risk_flags = excluded.risk_flags,
        cost_tier = excluded.cost_tier,
        network_calls = excluded.network_calls,
        cache_hits = excluded.cache_hits,
        error = excluded.error,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    args.runId,
    args.orgId,
    args.entityType,
    args.entityId,
    args.shardIndex,
    args.shardCount,
    args.mode,
    args.beforeName || null,
    args.beforeStatus || null,
    args.proposedName || null,
    args.proposedStatus || null,
    args.action,
    args.applied ? 1 : 0,
    confidence,
    summary || null,
    JSON.stringify(ruleIds),
    JSON.stringify(riskFlags),
    costTier,
    networkCalls,
    cacheHits,
    args.error || null
  ).run();
}

async function bumpRunCounts(args: {
  env: Env;
  runId: string;
  action: CrmNameBackfillAction;
  bundle?: CrmNameEvidenceBundle;
}): Promise<void> {
  const actionColumn: Record<CrmNameBackfillAction, string> = {
    no_op_verified: 'no_op_count',
    set_status_verified: 'status_only_count',
    rename_verified: 'renamed_count',
    rename_provisional: 'renamed_count',
    set_domain_placeholder: 'domain_placeholder_count',
    record_pending_proposal: 'pending_proposal_count',
    skip_locked: 'skipped_count',
    skip_merged_or_deleted: 'skipped_count',
    error: 'failed_count',
  };
  const proposedExtra =
    args.action === 'rename_provisional'
      ? ', provisional_count = provisional_count + 1'
      : '';
  const networkRows = (args.bundle?.network_calls || 0) > 0 ? 1 : 0;
  const providerRows = args.bundle?.candidates.some(candidate => candidate.source_type === 'first_party_identity') ? 1 : 0;
  const localOnlyRows = networkRows === 0 && providerRows === 0 ? 1 : 0;
  const cacheHits = args.bundle?.cache_hits || 0;
  const column = actionColumn[args.action];
  await args.env.D1.prepare(
    `UPDATE crm_name_backfill_runs
        SET scanned_count = scanned_count + 1,
            ${column} = ${column} + 1
            ${proposedExtra},
            local_only_rows = local_only_rows + ?,
            network_rows = network_rows + ?,
            provider_rows = provider_rows + ?,
            cache_hits = cache_hits + ?,
            heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(localOnlyRows, networkRows, providerRows, cacheHits, args.runId).run();
}

function parsePositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function failRunForBudget(env: Env, runId: string, reason: string): Promise<void> {
  await env.D1.prepare(
    `UPDATE crm_name_backfill_runs
        SET status = 'failed',
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status IN ('queued','running')`
  ).bind(reason, runId).run();
}

async function enforceBackfillBudgets(env: Env, runId: string): Promise<void> {
  const row = await env.D1.prepare(
    `SELECT scanned_count, failed_count, network_rows
       FROM crm_name_backfill_runs
      WHERE id = ?`
  ).bind(runId).first<BackfillBudgetRow>();
  if (!row) return;
  const maxNetworkRows = parsePositiveNumber(env.CRM_NAME_BACKFILL_MAX_NETWORK_ROWS);
  if (maxNetworkRows !== null && row.network_rows > maxNetworkRows) {
    const reason = `crm_name_backfill_network_budget_exceeded:${row.network_rows}/${maxNetworkRows}`;
    await failRunForBudget(env, runId, reason);
    throw new Error(reason);
  }
  const maxFailureRate = parsePositiveNumber(env.CRM_NAME_BACKFILL_MAX_FAILURE_RATE);
  if (maxFailureRate !== null && row.scanned_count >= 100) {
    const failureRate = row.failed_count / Math.max(row.scanned_count, 1);
    if (failureRate > maxFailureRate) {
      const reason = `crm_name_backfill_failure_rate_exceeded:${failureRate.toFixed(4)}/${maxFailureRate}`;
      await failRunForBudget(env, runId, reason);
      throw new Error(reason);
    }
  }
}

export async function evaluateAndMaybeApplyCrmNameBackfillEntity(args: {
  env: Env;
  runId: string;
  orgId: string;
  entityType: CrmNameBackfillEntityType;
  entityId: string;
  shardIndex: number;
  shardCount: number;
  mode: CrmNameBackfillMode;
}): Promise<CrmNameBackfillAction> {
  const row = await loadEntity(args.env, args.orgId, args.entityType, args.entityId);
  if (!row || row.deleted_at || row.merged_into) {
    await writeResult({
      ...args,
      beforeName: row?.name || '',
      beforeStatus: row ? nameStatusFromCustomFields(row.custom_fields) : '',
      proposedName: '',
      proposedStatus: '',
      action: 'skip_merged_or_deleted',
      applied: false,
    });
    await bumpRunCounts({ env: args.env, runId: args.runId, action: 'skip_merged_or_deleted' });
    return 'skip_merged_or_deleted';
  }

  const beforeName = clean(row.name);
  const beforeStatus = nameStatusFromCustomFields(row.custom_fields);
  const source: CrmQualitySourceEvidence = {
    source_channel: 'crm_name_backfill',
    source_record_id: args.entityId,
    source_text: beforeName,
    codepath: 'crm_name_backfill',
    evidence_level: 'corroborated',
  };
  const fieldState = await loadFieldState(args.env, args.entityType, args.entityId, fieldNameFor(args.entityType));

  try {
    const { resolution, evidenceBundle } = await resolveCrmEntityNameWithEvidence({
      entityType: args.entityType,
      orgId: args.orgId,
      entityId: args.entityId,
      trigger: 'crm_name_backfill',
      rawName: beforeName,
      currentName: beforeName,
      email: row.email || null,
      domain: row.domain || null,
      website: row.website || null,
      relationshipEvidence: true,
      allowDomainPlaceholder: args.entityType === 'company',
      source,
    }, args.env, {
      maxNetworkCalls: 2,
      networkTimeoutMs: 4000,
    });

    const proposedName = clean(resolution.normalizedName);
    const proposedStatus = statusFromResolution(resolution);
    const action = proposedName && proposedStatus
      ? actionForEvaluation({ row, beforeName, beforeStatus, proposedName, proposedStatus, resolution, fieldState })
      : 'error';

    let applied = false;
    if (args.mode === 'apply' && args.env.CRM_NAME_BACKFILL_APPLY_ENABLED === 'true') {
      applied = await applyNameBackfill({
        env: args.env,
        orgId: args.orgId,
        entityType: args.entityType,
        entityId: args.entityId,
        beforeName,
        proposedName,
        proposedStatus: proposedStatus || beforeStatus,
        action,
        resolution,
        existingCustomFields: row.custom_fields,
      });
    }

    await writeResult({
      ...args,
      beforeName,
      beforeStatus,
      proposedName,
      proposedStatus: proposedStatus || '',
      action,
      applied,
      resolution,
      bundle: evidenceBundle,
      error: action === 'error' ? resolution.reasons.join('; ') || 'name_resolution_failed' : null,
    });
    await bumpRunCounts({ env: args.env, runId: args.runId, action, bundle: evidenceBundle });
    return action;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await writeResult({
      ...args,
      beforeName,
      beforeStatus,
      proposedName: '',
      proposedStatus: '',
      action: 'error',
      applied: false,
      error: message.slice(0, 1000),
    });
    await bumpRunCounts({ env: args.env, runId: args.runId, action: 'error' });
    return 'error';
  }
}

async function fetchShardCandidates(args: {
  env: Env;
  orgId: string;
  entityType: CrmNameBackfillEntityType;
  cursor: string | null;
  scanLimit: number;
}): Promise<EntityRow[]> {
  if (args.entityType === 'contact') {
    const rows = await args.env.D1.prepare(
      `SELECT id, full_name AS name, email, company_id, custom_fields, deleted_at, merged_into
         FROM contacts
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND merged_into IS NULL
          AND id > ?
        ORDER BY id ASC
        LIMIT ?`
    ).bind(args.orgId, args.cursor || '', args.scanLimit).all<EntityRow>();
    return rows.results;
  }
  const rows = await args.env.D1.prepare(
    `SELECT id, name, domain, website, custom_fields, deleted_at, merged_into
       FROM companies
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND merged_into IS NULL
        AND id > ?
      ORDER BY id ASC
      LIMIT ?`
  ).bind(args.orgId, args.cursor || '', args.scanLimit).all<EntityRow>();
  return rows.results;
}

export async function processCrmNameBackfillShardPayload(
  payload: CrmNameBackfillPayload,
  env: Env
): Promise<ProcessShardResult> {
  const chunkSize = Math.max(1, Math.min(payload.chunk_size || DEFAULT_ENTITY_CHUNK_SIZE, 20));
  const scanLimit = Math.max(chunkSize * SCAN_MULTIPLIER, 50);
  let cursor = payload.cursor || '';
  let processed = 0;
  let scanned = 0;
  let done = false;
  const applyStrategy = payload.apply_strategy || 'resolver';

  if (applyStrategy === 'reviewed_results') {
    if (!payload.source_run_id) throw new Error('crm_name_backfill_source_run_id_required');
    while (processed < chunkSize) {
      const candidates = await fetchReviewedResultCandidates({
        env,
        orgId: payload.org_id,
        sourceRunId: payload.source_run_id,
        entityType: payload.entity_type,
        cursor,
        scanLimit,
      });
      if (candidates.length === 0) {
        done = true;
        break;
      }
      const page = selectCrmNameBackfillShardPage({
        candidates: candidates.map(row => ({ ...row, id: row.entity_id })),
        shardIndex: payload.shard_index,
        shardCount: payload.shard_count,
        remaining: chunkSize - processed,
      });
      scanned += page.inspected;
      cursor = page.cursor || cursor;
      for (const row of page.selected) {
        await evaluateAndMaybeApplyReviewedCrmNameBackfillResult({
          env,
          runId: payload.run_id,
          orgId: payload.org_id,
          sourceRunId: payload.source_run_id,
          sourceRow: row,
          shardIndex: payload.shard_index,
          shardCount: payload.shard_count,
          mode: payload.mode,
        });
        processed++;
      }
    }

    await env.D1.prepare(
      `UPDATE crm_name_backfill_runs
          SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(payload.run_id).run();

    return { processed, scanned, cursor: cursor || null, done };
  }

  while (processed < chunkSize) {
    const candidates = await fetchShardCandidates({
      env,
      orgId: payload.org_id,
      entityType: payload.entity_type,
      cursor,
      scanLimit,
    });
    if (candidates.length === 0) {
      done = true;
      break;
    }
    const page = selectCrmNameBackfillShardPage({
      candidates,
      shardIndex: payload.shard_index,
      shardCount: payload.shard_count,
      remaining: chunkSize - processed,
    });
    scanned += page.inspected;
    cursor = page.cursor || cursor;
    for (const row of page.selected) {
      await evaluateAndMaybeApplyCrmNameBackfillEntity({
        env,
        runId: payload.run_id,
        orgId: payload.org_id,
        entityType: payload.entity_type,
        entityId: row.id,
        shardIndex: payload.shard_index,
        shardCount: payload.shard_count,
        mode: payload.mode,
      });
      processed++;
    }
  }

  await env.D1.prepare(
    `UPDATE crm_name_backfill_runs
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(payload.run_id).run();

  return { processed, scanned, cursor: cursor || null, done };
}

export async function processCrmNameBackfillWorkItem(item: WorkQueueRow, env: Env): Promise<void> {
  const payload = JSON.parse(item.payload) as CrmNameBackfillPayload;
  const run = await env.D1.prepare(
    `SELECT id, org_id, status, mode, shard_count FROM crm_name_backfill_runs WHERE id = ?`
  ).bind(payload.run_id).first<BackfillRunRow>();
  if (!run) throw new Error(`crm_name_backfill_run_not_found:${payload.run_id}`);
  if (run.status === 'cancelled') {
    await deferWork(env, item.id, new Date(Date.now() + 60 * 60_000).toISOString(), JSON.stringify(payload));
    return;
  }
  if (run.status === 'failed' || run.status === 'completed') return;
  if (run.status === 'queued') {
    await env.D1.prepare(
      `UPDATE crm_name_backfill_runs
          SET status = 'running',
              started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(run.id).run();
  }
  if (payload.mode === 'apply' && env.CRM_NAME_BACKFILL_APPLY_ENABLED !== 'true') {
    throw new Error('CRM_NAME_BACKFILL_APPLY_DISABLED');
  }

  const result = await processCrmNameBackfillShardPayload(payload, env);
  await enforceBackfillBudgets(env, payload.run_id);
  if (!result.done) {
    await deferWork(env, item.id, new Date(Date.now() + 1000).toISOString(), JSON.stringify({
      ...payload,
      cursor: result.cursor,
    }));
    return;
  }
  await maybeFinalizeCrmNameBackfillRun(env, payload.run_id, item.id);
}

export async function startCrmNameBackfillRun(args: {
  env: Env;
  orgId: string;
  requestedBy: string;
  mode?: CrmNameBackfillMode;
  shardCount?: number;
  chunkSize?: number;
  applyStrategy?: CrmNameBackfillApplyStrategy;
  sourceRunId?: string | null;
}): Promise<{ run_id: string; enqueued: number; shard_count: number; mode: CrmNameBackfillMode; apply_strategy: CrmNameBackfillApplyStrategy; source_run_id: string | null }> {
  const mode = args.mode || 'dry_run';
  const applyStrategy = args.applyStrategy || 'resolver';
  const shardCount = Math.max(1, Math.min(args.shardCount || DEFAULT_CRM_NAME_BACKFILL_SHARDS, 64));
  if (mode === 'apply' && args.env.CRM_NAME_BACKFILL_APPLY_ENABLED !== 'true') {
    throw new Error('CRM_NAME_BACKFILL_APPLY_DISABLED');
  }
  if (applyStrategy === 'reviewed_results' && !args.sourceRunId) {
    throw new Error('CRM_NAME_BACKFILL_SOURCE_RUN_REQUIRED');
  }
  const existing = await args.env.D1.prepare(
    `SELECT id FROM crm_name_backfill_runs
      WHERE org_id = ? AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`
  ).bind(args.orgId).first<{ id: string }>();
  if (existing) {
    throw new Error(`CRM_NAME_BACKFILL_ALREADY_ACTIVE:${existing.id}`);
  }
  const runId = crypto.randomUUID();
  await args.env.D1.prepare(
    `INSERT INTO crm_name_backfill_runs
       (id, org_id, status, mode, shard_count, requested_by, started_at, heartbeat_at, apply_strategy, source_run_id)
     VALUES (?, ?, 'queued', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`
  ).bind(runId, args.orgId, mode, shardCount, args.requestedBy || null, applyStrategy, args.sourceRunId || null).run();

  let enqueued = 0;
  for (const entityType of ['company', 'contact'] as CrmNameBackfillEntityType[]) {
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
      const payload: CrmNameBackfillPayload = {
        run_id: runId,
        org_id: args.orgId,
        shard_index: shardIndex,
        shard_count: shardCount,
        entity_type: entityType,
        cursor: null,
        mode,
        chunk_size: args.chunkSize || DEFAULT_ENTITY_CHUNK_SIZE,
        apply_strategy: applyStrategy,
        source_run_id: args.sourceRunId || null,
      };
      const result = await enqueueWork(args.env, args.orgId, CRM_NAME_BACKFILL_DOMAIN, payload, {
        idempotency_key: `crm-name-backfill:${runId}:${entityType}:${shardIndex}`,
        priority: 50,
        max_attempts: 5,
        upstream: null,
      });
      if (result.inserted) enqueued++;
    }
  }
  return { run_id: runId, enqueued, shard_count: shardCount, mode, apply_strategy: applyStrategy, source_run_id: args.sourceRunId || null };
}

export async function getCrmNameBackfillRunStatus(env: Env, orgId: string, runId: string): Promise<Record<string, unknown> | null> {
  await maybeFinalizeCrmNameBackfillRun(env, runId);
  const run = await env.D1.prepare(
    `SELECT * FROM crm_name_backfill_runs WHERE id = ? AND org_id = ?`
  ).bind(runId, orgId).first<Record<string, unknown>>();
  if (!run) return null;
  const actionCounts = await env.D1.prepare(
    `SELECT action, COUNT(*) AS count
       FROM crm_name_backfill_results
      WHERE run_id = ?
      GROUP BY action`
  ).bind(runId).all<{ action: string; count: number }>();
  const shardCounts = await env.D1.prepare(
    `SELECT entity_type, shard_index, COUNT(*) AS processed
       FROM crm_name_backfill_results
      WHERE run_id = ?
      GROUP BY entity_type, shard_index
      ORDER BY entity_type, shard_index`
  ).bind(runId).all<{ entity_type: string; shard_index: number; processed: number }>();
  const queueCounts = await env.D1.prepare(
    `SELECT status, COUNT(*) AS count
       FROM work_queue
      WHERE domain = ? AND json_extract(payload, '$.run_id') = ?
      GROUP BY status`
  ).bind(CRM_NAME_BACKFILL_DOMAIN, runId).all<{ status: string; count: number }>();
  const failures = await env.D1.prepare(
    `SELECT entity_type, entity_id, before_name, proposed_name, action, error
       FROM crm_name_backfill_results
      WHERE run_id = ? AND (action = 'error' OR error IS NOT NULL)
      ORDER BY updated_at DESC
      LIMIT 25`
  ).bind(runId).all<Record<string, unknown>>();
  return {
    run,
    action_counts: actionCounts.results,
    shard_counts: shardCounts.results,
    queue_counts: queueCounts.results,
    failures: failures.results,
  };
}

export async function cancelCrmNameBackfillRun(env: Env, orgId: string, runId: string): Promise<boolean> {
  const result = await env.D1.prepare(
    `UPDATE crm_name_backfill_runs
        SET status = 'cancelled',
            cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ? AND status IN ('queued','running')`
  ).bind(runId, orgId).run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function resumeCrmNameBackfillRun(env: Env, orgId: string, runId: string): Promise<boolean> {
  const result = await env.D1.prepare(
    `UPDATE crm_name_backfill_runs
        SET status = 'running',
            cancelled_at = NULL,
            heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ? AND status = 'cancelled'`
  ).bind(runId, orgId).run();
  if (!Number(result.meta?.changes || 0)) return false;
  await env.D1.prepare(
    `UPDATE work_queue
        SET next_attempt_at = NULL
      WHERE domain = ? AND json_extract(payload, '$.run_id') = ?
        AND status = 'pending'`
  ).bind(CRM_NAME_BACKFILL_DOMAIN, runId).run();
  return true;
}

export async function maybeFinalizeCrmNameBackfillRun(env: Env, runId: string, activeItemId?: string): Promise<void> {
  const activeExclusion = activeItemId ? ` AND id <> ?` : '';
  const remaining = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE domain = ? AND json_extract(payload, '$.run_id') = ?
        AND status IN ('pending','in_progress','failed')`
      + activeExclusion
  ).bind(...(activeItemId ? [CRM_NAME_BACKFILL_DOMAIN, runId, activeItemId] : [CRM_NAME_BACKFILL_DOMAIN, runId])).first<{ count: number }>();
  if ((remaining?.count || 0) > 0) return;
  const dead = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE domain = ? AND json_extract(payload, '$.run_id') = ?
        AND status = 'dead_letter'`
  ).bind(CRM_NAME_BACKFILL_DOMAIN, runId).first<{ count: number }>();
  await env.D1.prepare(
    `UPDATE crm_name_backfill_runs
        SET status = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_error = CASE WHEN ? > 0 THEN 'one or more shards dead-lettered' ELSE last_error END
      WHERE id = ? AND status IN ('queued','running')`
  ).bind((dead?.count || 0) > 0 ? 'failed' : 'completed', dead?.count || 0, runId).run();
}

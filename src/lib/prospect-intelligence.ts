import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import {
  callClaudeWithUsage,
  isClaudeHardQuotaErrorMessage,
  prewarmClaudePromptCache,
  type ClaudeSystemPrompt,
  type ClaudeUsage,
} from './claude';
import { emailDomain, getConfiguredInternalDomains, isInternalEmailDomain } from './internal-domains';
import { budgetUpstreamForClaudeModel, CLAUDE_HAIKU_MODEL } from './model-policy';
import { triggerCompanyEnrichment } from './enrichment';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';
import { updateEntityInIndex } from './entity-index';
import { jaroWinkler } from './dedup';
import { registrableDomain } from './discovery';

export const PROSPECT_CLASSIFIER_VERSION = 'prospect-v1-source-prospect-verdict-2026-06-14-rescue-v2';
export const PROSPECT_SOURCE_CLASSIFIER_CACHE_VERSION = `${PROSPECT_CLASSIFIER_VERSION}:source-batch-v1`;
export const PROSPECT_REASONING_JUDGE_CACHE_VERSION = `${PROSPECT_CLASSIFIER_VERSION}:reasoning-judge-v2`;
export const PROSPECT_FINAL_QUALITY_GATE_CACHE_VERSION = `${PROSPECT_CLASSIFIER_VERSION}:final-quality-gate-v4`;
const PROSPECT_CLASSIFIER_DEFAULT_MODEL = CLAUDE_HAIKU_MODEL;
const DEFAULT_PROSPECT_PRODUCTION_SAMPLE_RATE = 0.02;
export const PROSPECT_CONTEXT_WINDOW_CHARS = 4000;
const PROSPECT_SOURCE_TEXT_MAX_CHARS = 12000;
const PROSPECT_SOURCE_CLASSIFIER_PARSE_RETRY_CHUNK_SIZE = 8;
const PROSPECT_FINAL_QUALITY_GATE_BATCH_SIZE = 8;
const PROSPECT_FINAL_QUALITY_GATE_RETRY_CHUNK_SIZE = 4;
const PROSPECT_FINAL_QUALITY_GATE_CONTEXT_SIZE = 4;
const PROSPECT_FINAL_QUALITY_GATE_EXCERPT_CHARS = 550;

export const PROSPECT_SECTOR_TAXONOMY = [
  { key: 'ai_data', label: 'AI / Data' },
  { key: 'cybersecurity', label: 'Cybersecurity' },
  { key: 'quantum', label: 'Quantum' },
  { key: 'dev_cloud_infra', label: 'Developer / Cloud Infrastructure' },
  { key: 'enterprise_software', label: 'Enterprise Software' },
  { key: 'fintech', label: 'Fintech' },
  { key: 'healthcare', label: 'Healthcare' },
  { key: 'aerospace_defense', label: 'Aerospace / Defense' },
  { key: 'hardware_semis', label: 'Hardware / Semiconductors' },
  { key: 'robotics', label: 'Robotics' },
  { key: 'energy_climate', label: 'Energy / Climate' },
  { key: 'materials_manufacturing', label: 'Materials / Manufacturing' },
  { key: 'mobility_logistics', label: 'Mobility / Logistics' },
  { key: 'real_estate_built_env', label: 'Real Estate / Built Environment' },
  { key: 'consumer', label: 'Consumer' },
  { key: 'agri_food', label: 'Agriculture / Food' },
  { key: 'education', label: 'Education' },
  { key: 'uncategorized', label: 'Uncategorized' },
] as const;
const PROSPECT_SECTOR_KEYS = new Set(PROSPECT_SECTOR_TAXONOMY.map(s => s.key));
const PROSPECT_SECTOR_LABELS = PROSPECT_SECTOR_TAXONOMY.map(s => s.key).join(', ');

export const PROSPECT_MENTION_TYPES = [
  'inbound_prospect',
  'known_deal',
  'intro_source',
  'news',
  'noise',
  'web_analytics',
] as const;
const PROSPECT_MENTION_TYPE_SET = new Set<string>(PROSPECT_MENTION_TYPES);

export const PROSPECT_ACTIONS = [
  'create_prospect',
  'attach_existing_deal',
  'record_context',
  'ignore',
] as const;
const PROSPECT_ACTION_SET = new Set<string>(PROSPECT_ACTIONS);

export const PROSPECT_DIRECTIONS = ['inbound', 'outbound', 'internal', 'news'] as const;
const PROSPECT_DIRECTION_SET = new Set<string>(PROSPECT_DIRECTIONS);

export type SourceType = 'conversation' | 'event' | 'document';
type Direction = typeof PROSPECT_DIRECTIONS[number];
type DeterministicDirection = Direction | 'unknown';
type MentionType = typeof PROSPECT_MENTION_TYPES[number];
type ProspectAction = typeof PROSPECT_ACTIONS[number];
type SectorKey = typeof PROSPECT_SECTOR_TAXONOMY[number]['key'];
type SignalKind = 'intro' | 'raise' | 'deck' | 'meeting' | 'list_entry' | 'cold_mention' | 'unknown';
type ConfidenceTier = 'high' | 'medium' | 'low';

export interface ProspectDetectionStats {
  items_scanned: number;
  mentions_seen: number;
  signals_recorded: number;
  prospects_upserted: number;
  classifications_pending: number;
  classifier_cache_hits: number;
  classifier_cache_misses: number;
  classifier_paid_calls: number;
  classifier_paid_calls_saved: number;
  llm_stage_usage: Record<string, ProspectLlmStageUsage>;
  prefilter_dropped: number;
  production_samples_recorded: number;
  known_deals_attached: number;
  record_context_skipped: number;
  ignored_or_noise_skipped: number;
  skipped_known_deal: number;
  skipped_intro_source: number;
  skipped_news: number;
  skipped_noise: number;
  skipped_web_analytics: number;
  final_quality_gate_reviewed: number;
  final_quality_gate_allowed: number;
  final_quality_gate_renamed: number;
  final_quality_gate_merged: number;
  final_quality_gate_blocked: number;
  final_quality_gate_batches: number;
  final_quality_gate_cache_hits: number;
  final_quality_gate_failed_open: number;
  final_quality_gate_fallback_used: number;
  final_quality_gate_merge_resolved: number;
  final_quality_gate_merge_unresolved: number;
  errors: Array<{ item_id: string; error: string }>;
}

export interface MentionCandidate {
  raw: string;
  canonicalName: string;
  normalizedName: string;
  mentionOrdinal: number;
  spanStart: number | null;
  spanEnd: number | null;
  lineText: string;
  contextText: string;
  isListEntry: boolean;
  products: string[];
  listFields?: ParsedDealflowListFields;
}

interface ExistingContext {
  companyId: string | null;
  dealId: string | null;
  companyDomain: string | null;
  relationshipStates: string[];
  isInternal: boolean;
  matchStrength: 'none' | 'name' | 'domain' | 'company_id';
  identityScore?: number;
  identityStrength?: 'none' | 'weak' | 'soft' | 'hard' | 'ambiguous';
  identityMethod?: string | null;
  identityAmbiguous?: boolean;
  identityCandidates?: ExistingIdentityCandidateAudit[];
}

interface ExistingIdentityCandidateAudit {
  entity_type: 'company' | 'prospect';
  entity_id: string;
  company_id: string | null;
  deal_id: string | null;
  name: string;
  domain: string | null;
  score: number;
  method: string;
  reasons: string[];
}

type CrossD1CompanyRole =
  | 'startup_or_private_company'
  | 'known_deal'
  | 'bank'
  | 'vc_firm'
  | 'lp_or_family_office'
  | 'nonprofit'
  | 'government_or_event_channel'
  | 'vendor_or_service_provider'
  | 'advisor_or_intro_source'
  | 'customer_or_buyer'
  | 'internal_entity'
  | 'portfolio_company'
  | 'frequent_partner_or_source'
  | 'public_or_acquired_company'
  | 'unknown';

type CrossD1RoleConfidence = 'authoritative' | 'high' | 'medium' | 'low';
type CrossD1RoleActionOverride = 'attach_existing_deal' | 'record_context' | 'ignore' | 'mark_provisional' | null;
type LowConfidenceVerificationVerdict =
  | 'not_applicable'
  | 'verified_create'
  | 'provisional_create'
  | 'record_context'
  | 'ignore';
type LowConfidenceVerificationActionOverride = 'record_context' | 'ignore' | 'mark_provisional' | null;
type ProspectSecondLookLane = 'accepted_but_suspicious' | 'rejected_but_promising';
type ProspectSecondLookRecommendedAction =
  | 'keep_create_pending_recheck'
  | 'rerun_original_pipeline'
  | 'hold_context'
  | 'none';

interface CrossD1CompanyRoleCheck {
  checked: boolean;
  eligible: boolean;
  role: CrossD1CompanyRole;
  confidence: CrossD1RoleConfidence;
  evidence: string[];
  action_override: CrossD1RoleActionOverride;
  matched_company_id: string | null;
  matched_deal_id: string | null;
  reason: string | null;
}

interface LowConfidenceProspectVerification {
  checked: boolean;
  eligible: boolean;
  verdict: LowConfidenceVerificationVerdict;
  action_override: LowConfidenceVerificationActionOverride;
  reason: string | null;
  scores: {
    identity: number;
    intent: number;
    source_quality: number;
    d1_support: number;
    extraction_risk: number;
    total: number;
  };
  identity_signals: string[];
  intent_signals: string[];
  source_quality_signals: string[];
  d1_signals: string[];
  extraction_flags: string[];
}

interface ProspectSecondLookPacket {
  required: boolean;
  lane: ProspectSecondLookLane | null;
  recommended_action: ProspectSecondLookRecommendedAction;
  reasons: string[];
  evidence: string[];
  warnings: string[];
  packet: {
    candidate_name: string;
    prospect_company_name: string | null;
    source_title: string | null;
    source_type: SourceType;
    excerpt: string;
    original_reasoning: string | null;
    original_is_prospect: boolean;
    original_action: ProspectAction;
    final_action: ProspectAction;
    final_should_create: boolean;
    final_veto_reason: string | null;
    reasoning_judge_action: ProspectReasoningJudgeAction | 'not_evaluated';
    reasoning_judge_reason: string | null;
    target_evidence_reasons: string[];
    known_entity: {
      company_id: string | null;
      deal_id: string | null;
      match_strength: ExistingContext['matchStrength'];
      identity_score: number;
      identity_strength: ExistingContext['identityStrength'];
      identity_ambiguous: boolean;
    };
  };
}

interface Classification {
  direction: Direction;
  directionUncertain: boolean;
  mentionType: MentionType;
  prospectAction: ProspectAction;
  shouldCreateProspect: boolean;
  prospectCompanyName: string | null;
  confidence: number;
  confidenceTier: ConfidenceTier;
  sectorKey: SectorKey;
  sectorConfidence: number;
  signalKind: SignalKind;
  hasDeck: boolean;
  hasMeeting: boolean;
  hasWarmIntro: boolean;
  dealmakerName: string | null;
  possibleCompanyId: string | null;
  possibleDealId: string | null;
  linkedDealId: string | null;
  provisional: boolean;
  sampledForProduction: boolean;
  samplingReason: string | null;
  metadata: Record<string, unknown>;
}

export interface ProspectLlmStageUsage {
  cache_hits: number;
  cache_misses: number;
  paid_calls: number;
  paid_calls_saved: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface ClassifierPrefilter {
  shouldClassify: boolean;
  reasons: string[];
  deterministicDirection: DeterministicDirection;
  newsletterLikely: boolean;
  hasDeck: boolean;
  hasMeeting: boolean;
  hasWarmIntro: boolean;
  signalKind: SignalKind;
  sectorHint: { key: SectorKey; confidence: number };
  confidenceHint: { confidence: number; tier: ConfidenceTier; provisional: boolean };
}

interface LlmClassifierDecision {
  isProspect: boolean;
  mentionType: MentionType;
  direction: Direction;
  sectorKey: SectorKey;
  sectorConfidence: number;
  confidence: number;
  prospectAction: ProspectAction;
  prospectCompanyName: string | null;
  reasoning: string | null;
  model: string;
  usage?: ClaudeUsage;
}

type ProspectReasoningJudgeAction = 'allow_create' | 'block_create' | 'needs_review';
type ProspectFinalQualityDecisionAction = 'allow_create' | 'rename_and_allow' | 'merge_into_record' | 'block_create';

interface ProspectFinalQualityDecision {
  record_ordinal: number;
  decision: ProspectFinalQualityDecisionAction;
  canonical_name: string | null;
  merge_target_ordinal: number | null;
  merge_target_prospect_id: string | null;
  reason: string;
  model: string;
  usage?: ClaudeUsage | null;
  cache_hit?: boolean;
  fallback_used?: boolean;
  failed_open?: boolean;
  parse_failed?: boolean;
  retry_used?: boolean;
  fallback_basis?: string | null;
  target_proof?: string[];
  hard_block_reason?: string | null;
  batch_size?: number;
}

interface ProspectFinalQualityKnownEntity {
  id: string;
  name: string | null;
  domain: string | null;
  website?: string | null;
  type?: string | null;
  description?: string | null;
  investment_status?: string | null;
  stage?: string | null;
  sector?: string | null;
  last_news_summary?: string | null;
  custom_fields?: string | null;
}

interface ProspectFinalQualityKnownDeal {
  id: string;
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_website?: string | null;
}

interface ProspectFinalQualityHistoricalSignal {
  source_type: SourceType | null;
  source_id: string | null;
  source_title: string | null;
  occurred_at: string | null;
  mention_type: MentionType | string | null;
  prospect_action: ProspectAction | string | null;
  prospect_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  final_quality_decision: string | null;
}

interface ProspectFinalQualityNeighborhood {
  existingProspect: ProspectIdentityMatch | null;
  knownCompany: ProspectFinalQualityKnownEntity | null;
  knownDeal: ProspectFinalQualityKnownDeal | null;
  identityCandidates: ExistingIdentityCandidateAudit[];
  recentSignals: ProspectFinalQualityHistoricalSignal[];
  historicalContextCount: number;
  duplicateGroupId: string;
  aliasKeys: string[];
  deterministicHint: {
    suggested_action: 'clean_create' | 'rename_candidate' | 'merge_candidate' | 'block_candidate';
    reasons: string[];
  };
}

interface ProspectReasoningJudgeDecision {
  reasoning_valid: boolean;
  action: ProspectReasoningJudgeAction;
  confidence: number;
  reason: string;
  model: string;
  usage?: ClaudeUsage | null;
  cache_hit?: boolean;
}

export interface ProspectClassifierCacheValue {
  cache_key: string;
  org_id: string;
  version: string;
  model: string;
  source_type: SourceType;
  source_id: string;
  source_hash: string;
  candidate_hash: string;
  context_hash: string;
  result_json: Record<string, LlmClassifierDecision>;
  usage?: ClaudeUsage | null;
  created_at: string;
}

export interface ProspectClassifierCache {
  get(cacheKey: string): Promise<ProspectClassifierCacheValue | null>;
  put(value: ProspectClassifierCacheValue): Promise<void>;
}

interface ProspectLlmCacheValue<T = unknown> {
  cache_key: string;
  org_id: string;
  stage: string;
  prompt_version: string;
  model: string;
  source_hash: string;
  candidate_hash: string;
  context_hash: string;
  decision_hash?: string | null;
  value_json: T;
  usage?: ClaudeUsage | null;
  created_at: string;
}

interface ProspectCreateVetoInput {
  prospectAction: string;
  companyName: string;
  rawMention?: string | null;
  rawExcerpt?: string | null;
  senderAndContext?: string | null;
  llmReasoning?: string | null;
}

interface ProspectCreateVetoDecision {
  applied: boolean;
  reason: string | null;
  confidence: number | null;
}

interface ProspectValuableActionVetoInput extends ProspectCreateVetoInput {
  prospectAction: string;
  prospectCompanyName?: string | null;
}

interface ProspectValuableActionVetoDecision extends ProspectCreateVetoDecision {
  nonValuableAction: 'ignore' | 'record_context' | null;
}

export interface ProspectClassifierKnownEntity {
  name: string;
  domain?: string | null;
}

export interface ProspectClassifierKnownContext {
  knownDeals: ProspectClassifierKnownEntity[];
  knownDealmakers: ProspectClassifierKnownEntity[];
}

export interface ProspectClassifierInput {
  sourceType: string;
  senderAndContext: string;
  companyName: string;
  rawExcerpt: string;
  prefilterHints: Record<string, unknown>;
  sectorHints: { key: SectorKey; confidence: number };
  knownContext: ProspectClassifierKnownContext;
  orgId: string;
  policyLens?: ProspectClassifierPolicyLens | null;
}

export interface ProspectClassifierPolicyLens {
  id: string;
  name: string;
  instructions: string;
}

export interface ParsedDealflowListFields {
  stage?: string | null;
  amount?: string | null;
  website?: string | null;
  poc?: string | null;
  problem?: string | null;
  approach?: string | null;
}

export interface ProspectOrgExtractionLlmInput {
  cleanedText: string;
  sourceContext: string;
  orgId: string;
  mode?: 'all_organizations' | 'target_recovery';
}

export interface ProspectOrgExtractionLlmOutput {
  name: string;
  raw?: string | null;
  context?: string | null;
}

export type ProspectOrgExtractionLlm = (input: ProspectOrgExtractionLlmInput) => Promise<ProspectOrgExtractionLlmOutput[]>;

export interface ProspectOrganizationExtractionOptions {
  fallbackName?: string | null;
  knownContext?: ProspectClassifierKnownContext;
  allowLlm?: boolean;
  forceLlm?: boolean;
  maxLlmOrganizations?: number;
  llmExtractor?: ProspectOrgExtractionLlm;
  dryRunNoBudgetWrites?: boolean;
  recoveryMode?: boolean;
  existingMentions?: MentionCandidate[];
  stats?: ProspectDetectionStats;
}

export interface ProspectEnrichmentCandidate {
  prospectId: string;
  canonicalName: string;
  domain?: string | null;
  sourceKind: 'own_domain' | 'google_news' | 'duckduckgo';
  sourceUrl: string;
  fields: Partial<Record<'website' | 'domain' | 'description' | 'hq_location' | 'founders_json', string>>;
  corroboratingSourceCount?: number;
}

export interface EnsureProspectForDealResult {
  prospectId: string | null;
  action: 'created' | 'updated' | 'already_linked' | 'skipped_no_deal';
  dealId: string;
  companyId: string | null;
}

const PROSPECT_ENRICHMENT_FIELDS = new Set(['website', 'domain', 'description', 'hq_location', 'founders_json']);

type ProspectBackfillSourceFamily = 'conversation' | 'event' | 'document';

export interface ProspectBackfillWindowInput {
  windowStart: string;
  windowEnd: string;
  sourceFamilies?: ProspectBackfillSourceFamily[];
  batchLimit?: number;
  sliceSize?: number;
  measuredCostPerItemUsd?: number | null;
  runId?: string | null;
}

export interface ProspectBackfillWindowResult {
  run_id: string;
  window_start: string;
  window_end: string;
  items_found: number;
  items_processed: number;
  signals_recorded: number;
  prospects_upserted: number;
  classifications_pending: number;
  source_families: string[];
  reconciliation: Awaited<ReturnType<typeof runProspectReconciliation>>;
}

export interface ProspectDryRunDecision {
  item_id: string;
  source_type: SourceType;
  source_id: string;
  source_title: string | null;
  occurred_at: string;
  mention_ordinal: number;
  company_name: string;
  normalized_company_name: string;
  duplicate_key: string;
  prospect_action: ProspectAction | 'classifier_error';
  mention_type: MentionType | 'classifier_error';
  direction: Direction | null;
  confidence: number | null;
  sector_key: SectorKey | null;
  prospect_company_name: string | null;
  should_create_prospect: boolean;
  linked_deal_id: string | null;
  possible_company_id: string | null;
  possible_deal_id: string | null;
  provisional: boolean;
  reasoning: string | null;
  error: string | null;
  original_llm_is_prospect?: boolean | null;
  original_llm_prospect_action?: ProspectAction | null;
  create_prospect_veto_reason?: string | null;
  valuable_action_veto_reason?: string | null;
  finalization_blocked?: boolean | null;
  finalization_block_reasons?: string | null;
  has_create_evidence?: boolean | null;
  reasoning_judge_action?: ProspectReasoningJudgeAction | 'not_evaluated' | null;
  reasoning_judge_valid?: boolean | null;
  reasoning_judge_reason?: string | null;
  reasoning_judge_blocked_company?: string | null;
  target_evidence_reasons?: string | null;
  corrected_prospect_company_name?: string | null;
  second_look_required?: boolean | null;
  second_look_lane?: ProspectSecondLookLane | null;
  second_look_recommended_action?: ProspectSecondLookRecommendedAction | null;
  second_look_reasons?: string | null;
  second_look_warnings?: string | null;
  second_look_evidence?: string | null;
  second_look_create_blocked?: boolean | null;
  second_look_block_reason?: string | null;
  final_quality_decision?: ProspectFinalQualityDecisionAction | null;
  final_quality_canonical_name?: string | null;
  final_quality_merge_target?: string | null;
  final_quality_reason?: string | null;
  final_quality_blocked?: boolean | null;
  final_quality_renamed?: boolean | null;
  final_quality_merged?: boolean | null;
  final_quality_batch_id?: string | null;
  final_quality_failed_open?: boolean | null;
  final_quality_fallback_used?: boolean | null;
  final_quality_parse_failed?: boolean | null;
  final_quality_retry_used?: boolean | null;
  final_quality_fallback_basis?: string | null;
  final_quality_target_proof?: string | null;
  final_quality_hard_block_reason?: string | null;
  final_quality_batch_size?: number | null;
  final_quality_attach_only?: boolean | null;
  final_quality_merge_resolved?: boolean | null;
  final_quality_existing_prospect_id?: string | null;
  final_quality_duplicate_group_id?: string | null;
  final_quality_record_key?: string | null;
}

export interface ProspectDryRunDuplicate {
  duplicate_key: string;
  count: number;
  item_ids: string[];
  company_name: string;
}

export interface ProspectDryRunResult {
  dry_run: true;
  rows_written: 0;
  changed_db: false;
  stats: ProspectDetectionStats;
  decision_counts: Record<ProspectAction | 'classifier_error', number>;
  decisions: ProspectDryRunDecision[];
  duplicates: ProspectDryRunDuplicate[];
}

interface ProspectClassifierRuntimeOptions {
  dryRunNoBudgetWrites?: boolean;
  allowPartialSchema?: boolean;
  classifierCache?: ProspectClassifierCache | null;
  disableD1ClassifierCache?: boolean;
  disableSourceClassifierCacheWrite?: boolean;
  llmDecision?: LlmClassifierDecision;
  classifierInput?: ProspectClassifierInput;
  sourceClassifierMode?: 'source_batch' | 'single' | 'single_fallback';
  sourceClassifierFallbackReason?: string | null;
  sourceClassifierBatchCacheHit?: boolean;
  sourceClassifierBatchPaidCall?: boolean;
  sourceClassifierBatchPartialReason?: string | null;
  stats?: ProspectDetectionStats;
}

interface SourceClassificationOutcome {
  mention: MentionCandidate;
  cls: Classification;
  existing: ExistingContext;
}

interface RecordableProspectOutcome {
  item: ClassifiedItem;
  sourceType: SourceType;
  mention: MentionCandidate;
  cls: Classification;
  existing: ExistingContext;
  occurredAt: string;
}

interface SourceClassificationBatchRow {
  mention: MentionCandidate;
  existing: ExistingContext;
  cls?: Classification;
  error?: string | null;
  cacheHit: boolean;
  paidCall: boolean;
}

function emptyStats(items: number): ProspectDetectionStats {
  return {
    items_scanned: items,
    mentions_seen: 0,
    signals_recorded: 0,
    prospects_upserted: 0,
    classifications_pending: 0,
    classifier_cache_hits: 0,
    classifier_cache_misses: 0,
    classifier_paid_calls: 0,
    classifier_paid_calls_saved: 0,
    llm_stage_usage: {},
    prefilter_dropped: 0,
    production_samples_recorded: 0,
    known_deals_attached: 0,
    record_context_skipped: 0,
    ignored_or_noise_skipped: 0,
    skipped_known_deal: 0,
    skipped_intro_source: 0,
    skipped_news: 0,
    skipped_noise: 0,
    skipped_web_analytics: 0,
    final_quality_gate_reviewed: 0,
    final_quality_gate_allowed: 0,
    final_quality_gate_renamed: 0,
    final_quality_gate_merged: 0,
    final_quality_gate_blocked: 0,
    final_quality_gate_batches: 0,
    final_quality_gate_cache_hits: 0,
    final_quality_gate_failed_open: 0,
    final_quality_gate_fallback_used: 0,
    final_quality_gate_merge_resolved: 0,
    final_quality_gate_merge_unresolved: 0,
    errors: [],
  };
}

function emptyExistingContext(companyDomain: string | null = null): ExistingContext {
  return {
    companyId: null,
    dealId: null,
    companyDomain,
    relationshipStates: [],
    isInternal: false,
    matchStrength: 'none',
    identityScore: 0,
    identityStrength: 'none',
    identityMethod: null,
    identityAmbiguous: false,
    identityCandidates: [],
  };
}

function emptyLlmStageUsage(): ProspectLlmStageUsage {
  return {
    cache_hits: 0,
    cache_misses: 0,
    paid_calls: 0,
    paid_calls_saved: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function recordLlmStageUsage(
  stats: ProspectDetectionStats | undefined,
  stage: string,
  input: {
    usage?: ClaudeUsage | null;
    cacheHit?: boolean;
    paidCall?: boolean;
  }
): void {
  if (!stats) return;
  const current = stats.llm_stage_usage[stage] || emptyLlmStageUsage();
  if (input.cacheHit) {
    current.cache_hits++;
    current.paid_calls_saved++;
  } else if (input.paidCall) {
    current.cache_misses++;
    current.paid_calls++;
  }
  if (input.usage) {
    current.input_tokens += Number(input.usage.input_tokens || 0);
    current.output_tokens += Number(input.usage.output_tokens || 0);
    current.cache_creation_input_tokens += Number(input.usage.cache_creation_input_tokens || 0);
    current.cache_read_input_tokens += Number(input.usage.cache_read_input_tokens || 0);
  }
  stats.llm_stage_usage[stage] = current;
}

const PROSPECT_BACKFILL_DEFAULT_SLICE_SIZE = 12;
const PROSPECT_BACKFILL_MAX_SLICE_SIZE = 25;
const LOW_CONFIDENCE_VERIFICATION_EXEMPT_CONFIDENCE = 0.96;

function mergeProspectDetectionStats(target: ProspectDetectionStats, next: ProspectDetectionStats): void {
  target.items_scanned += next.items_scanned;
  target.mentions_seen += next.mentions_seen;
  target.signals_recorded += next.signals_recorded;
  target.prospects_upserted += next.prospects_upserted;
  target.classifications_pending += next.classifications_pending;
  target.prefilter_dropped += next.prefilter_dropped;
  target.production_samples_recorded += next.production_samples_recorded;
  target.known_deals_attached += next.known_deals_attached;
  target.record_context_skipped += next.record_context_skipped;
  target.ignored_or_noise_skipped += next.ignored_or_noise_skipped;
  target.skipped_known_deal += next.skipped_known_deal;
  target.skipped_intro_source += next.skipped_intro_source;
  target.skipped_news += next.skipped_news;
  target.skipped_noise += next.skipped_noise;
  target.skipped_web_analytics += next.skipped_web_analytics;
  target.final_quality_gate_reviewed += next.final_quality_gate_reviewed || 0;
  target.final_quality_gate_allowed += next.final_quality_gate_allowed || 0;
  target.final_quality_gate_renamed += next.final_quality_gate_renamed || 0;
  target.final_quality_gate_merged += next.final_quality_gate_merged || 0;
  target.final_quality_gate_blocked += next.final_quality_gate_blocked || 0;
  target.final_quality_gate_batches += next.final_quality_gate_batches || 0;
  target.final_quality_gate_cache_hits += next.final_quality_gate_cache_hits || 0;
  target.final_quality_gate_failed_open += next.final_quality_gate_failed_open || 0;
  target.final_quality_gate_fallback_used += next.final_quality_gate_fallback_used || 0;
  target.final_quality_gate_merge_resolved += next.final_quality_gate_merge_resolved || 0;
  target.final_quality_gate_merge_unresolved += next.final_quality_gate_merge_unresolved || 0;
  for (const [stage, usage] of Object.entries(next.llm_stage_usage || {})) {
    const current = target.llm_stage_usage[stage] || emptyLlmStageUsage();
    current.cache_hits += usage.cache_hits;
    current.cache_misses += usage.cache_misses;
    current.paid_calls += usage.paid_calls;
    current.paid_calls_saved += usage.paid_calls_saved;
    current.input_tokens += usage.input_tokens;
    current.output_tokens += usage.output_tokens;
    current.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    current.cache_read_input_tokens += usage.cache_read_input_tokens;
    target.llm_stage_usage[stage] = current;
  }
  target.errors.push(...next.errors);
}

export function isProspectBackfillDeferrableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /CLAUDE_RATE_LIMITED|429|rate.?limit|timeout|overloaded|529|ETIMEDOUT|ECONNRESET|fetch failed|network|Could not access `?api\.cloudflare\.com/i
    .test(message);
}

function compactProspectBackfillError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  return normalizeWhitespace(raw)
    .replace(/\bnpx wrangler d1 execute\b[\s\S]*/i, 'wrangler_d1_command_failed')
    .slice(0, 500);
}

function updateStatsForProspectClassification(stats: ProspectDetectionStats, cls: Classification): void {
  if (cls.prospectAction === 'attach_existing_deal') {
    stats.known_deals_attached++;
  }
  if (cls.prospectAction === 'record_context') {
    stats.record_context_skipped++;
  }
  if (cls.prospectAction === 'ignore' || ['news', 'noise', 'web_analytics'].includes(cls.mentionType)) {
    stats.ignored_or_noise_skipped++;
  }
}

function prospectDryRunDecisionCounts(decisions: ProspectDryRunDecision[]): Record<ProspectAction | 'classifier_error', number> {
  return {
    create_prospect: decisions.filter(row => row.prospect_action === 'create_prospect').length,
    attach_existing_deal: decisions.filter(row => row.prospect_action === 'attach_existing_deal').length,
    record_context: decisions.filter(row => row.prospect_action === 'record_context').length,
    ignore: decisions.filter(row => row.prospect_action === 'ignore').length,
    classifier_error: decisions.filter(row => row.prospect_action === 'classifier_error').length,
  };
}

function prospectDryRunDuplicateKey(sourceType: SourceType, sourceId: string, mention: MentionCandidate): string {
  return `${sourceType}:${sourceId}:${mention.mentionOrdinal}:${mention.normalizedName}`;
}

function prospectDryRunDuplicates(decisions: ProspectDryRunDecision[]): ProspectDryRunDuplicate[] {
  const grouped = new Map<string, ProspectDryRunDecision[]>();
  for (const decision of decisions) {
    const rows = grouped.get(decision.duplicate_key) || [];
    rows.push(decision);
    grouped.set(decision.duplicate_key, rows);
  }
  return [...grouped.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([duplicateKey, rows]) => ({
      duplicate_key: duplicateKey,
      count: rows.length,
      item_ids: rows.map(row => row.item_id).sort(),
      company_name: rows[0]?.company_name || '',
    }))
    .sort((a, b) => b.count - a.count || a.duplicate_key.localeCompare(b.duplicate_key));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PERSON_FIRST_NAMES = new Set([
  'adam', 'albert', 'alex', 'alicia', 'alvaro', 'andrew', 'anthony', 'apollo',
  'bea', 'ben', 'brad', 'brian', 'chris', 'christian', 'chuck', 'craig',
  'dan', 'daniel', 'david', 'dylan', 'eric', 'james', 'javier',
  'jennifer', 'john', 'josh', 'kevin', 'laura', 'leonardo', 'lloyd',
  'lucas', 'manny', 'maria', 'melissa', 'michael', 'mike', 'nick',
  'nicholas', 'noah', 'patrick', 'paul', 'peter', 'phil', 'philip',
  'raul', 'robert', 'sam', 'sarah', 'shirley', 'steve', 'tony', 'victor', 'wes',
  'william', 'yesha',
]);

const PERSON_CONTACT_SINGLE_NAMES = new Set([
  'khizroev',
]);

const KNOWN_CONNECTOR_COMPANY_NAMES = new Set([
  'boozallenhamilton',
  'johnsonandjohnson',
  'procterandgamble',
]);

const STANDALONE_DOCUMENT_HEADINGS = new Set([
  'companyoverview',
  'companyprofile',
  'executivesummary',
  'keytakeaways',
  'overview',
  'problem',
  'risks',
  'solution',
  'team',
  'traction',
  'market',
  'whattheydo',
  'whynow',
]);

const SAFE_DOCUMENT_HEADING_PREFIXES = [
  'company overview',
  'company profile',
  'executive summary',
  'initial analysis',
  'investment memo',
  'investment overview',
  'short description',
  'target company',
];

const GENERIC_FRAGMENT_NAMES = new Set([
  'aprilwe',
  'bea',
  'both',
  'ceothey',
  'goto',
  'non',
  'sub',
  'target',
  'two',
  'you',
]);

const MARKUP_ARTIFACT_NAMES = new Set([
  'bodycontainer',
  'columnper',
  'datasets',
  'html',
  'locale',
  'schema',
  'schemaorg',
  'stylesheet',
  'template',
  'xdp',
  'xfa',
  'xhtml',
  'xml',
]);

function hasCompanyToken(name: string): boolean {
  return /\b(?:ai|bank|capital|co|company|corp|corporation|foundation|fund|group|holdings|inc|industries|labs|llc|llp|ltd|management|partners|securities|software|systems|technologies|technology|university|ventures)\b/i.test(name);
}

function isKnownConnectorCompanyName(name: string): boolean {
  return KNOWN_CONNECTOR_COMPANY_NAMES.has(normalizeProspectName(name));
}

export function normalizeProspectName(value: string | null | undefined): string {
  let text = (value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|pbc)\b\.?/g, ' ')
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  text = text.replace(/\b(ai|technologies|technology|labs|systems)\b$/g, '').trim();
  return text.replace(/\s+/g, '');
}

function isStandaloneDocumentHeading(name: string): boolean {
  return STANDALONE_DOCUMENT_HEADINGS.has(normalizeProspectName(name));
}

function isGenericFragmentCandidate(name: string): boolean {
  return GENERIC_FRAGMENT_NAMES.has(normalizeProspectName(name));
}

function isMarkupArtifactCandidate(name: string): boolean {
  if (hasCompanyToken(name) || isKnownConnectorCompanyName(name)) return false;
  const normalized = normalizeProspectName(name);
  if (MARKUP_ARTIFACT_NAMES.has(normalized)) return true;
  return /\b(?:schema\.org|xhtml|xfa|stylesheet|body-container|column-per|xmlns|doctype|css|html)\b/i.test(name);
}

function isPlausibleCompanyStemAfterFileStrip(stem: string): boolean {
  if (!stem || stem.length > 80) return false;
  if (!/[A-Za-z]/.test(stem)) return false;
  if (/[_/@\\]/.test(stem)) return false;
  const normalized = normalizeProspectName(stem);
  if (!normalized || normalized.length < 3) return false;
  if (isStandaloneDocumentHeading(stem) || isMarkupArtifactCandidate(stem) || isGenericFragmentCandidate(stem)) return false;
  if (/\b(?:q[1-4]|fy\d{2,4}|20\d{2}|v\d+)\b/i.test(stem) && /\b(?:analysis|deck|memo|report|update)\b/i.test(stem)) return false;
  return true;
}

function stripTrailingAttachmentExtension(name: string): string {
  const match = name.match(/^(.*?)(?:\s*\.\s*(?:zip|pdf|pptx?|docx?|xlsx?|csv))$/i);
  if (!match?.[1]) return name;
  const stem = normalizeWhitespace(match[1].replace(/[_-]+/g, ' ')).replace(/[._-]+$/g, '').trim();
  return isPlausibleCompanyStemAfterFileStrip(stem) ? stem : name;
}

function stripTrailingMaterialWrapper(name: string): string {
  const clean = normalizeWhitespace(name.replace(/[_]+/g, ' '));
  const stripped = clean
    .replace(/\s+(?:company\s+)?(?:one|1|two|2)[-\s]?pager(?:\s+deck)?$/i, '')
    .replace(/\s+(?:investor|investment|pitch|sales|company|product)?\s*(?:deck|memo|teaser|cim|overview|presentation|materials?|pre[-\s]?read|read[-\s]?ahead)$/i, '')
    .replace(/\s+(?:pdf|docx?|pptx?|xlsx?|csv)$/i, '')
    .replace(/[._-]+$/g, '')
    .trim();
  return stripped && stripped !== clean && isPlausibleCompanyRemainder(stripped) ? stripped : clean;
}

function stripFounderPersonWrapper(name: string): string {
  const clean = normalizeWhitespace(name);
  const patterns = [
    /^[A-Z][A-Za-z.'’_-]{1,40}\s+(?:founder|co[-\s]?founder|ceo|chief\s+executive|president)\s+(?:of|at)\s+(.+)$/i,
    /^(?:founder|co[-\s]?founder|ceo|chief\s+executive|president)\s+[A-Z][A-Za-z.'’_-]{1,40}\s+(?:of|at)\s+(.+)$/i,
    /^(?:founder|co[-\s]?founder|ceo|chief\s+executive|president)\s+(?:of|at)\s+(.+)$/i,
    /^[A-Z][A-Za-z.'’_-]{1,40}\s*,?\s+(?:founder|co[-\s]?founder|ceo|chief\s+executive|president)\s+(?:of|at)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const remainder = normalizeWhitespace(clean.match(pattern)?.[1] || '');
    if (remainder && remainder !== clean && isPlausibleCompanyRemainder(remainder)) return remainder;
  }
  return clean;
}

function isPlausibleCompanyRemainder(name: string): boolean {
  const clean = normalizeWhitespace(name);
  if (!clean || clean.length > 100) return false;
  if (!/[A-Za-z]/.test(clean)) return false;
  if (isStandaloneDocumentHeading(clean) || isMarkupArtifactCandidate(clean) || isGenericFragmentCandidate(clean)) return false;
  if (looksLikePersonName(clean) || looksLikePersonOrParticipantBundle(clean)) return false;
  if (hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return true;
  return /^[A-Z0-9][A-Za-z0-9&.'’/-]*(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]*){0,5}$/.test(clean);
}

function stripLeadingDocumentHeadingPrefix(name: string): string {
  const clean = normalizeWhitespace(name);
  for (const prefix of SAFE_DOCUMENT_HEADING_PREFIXES) {
    const match = clean.match(new RegExp(`^${escapeRegExp(prefix)}\\s*(?:[:\\-|–—])?\\s+(.+)$`, 'i'));
    const remainder = normalizeWhitespace(match?.[1] || '');
    if (remainder && isPlausibleCompanyRemainder(remainder)) return remainder;
  }
  return clean;
}

function stripLeadingPersonTitlePrefix(name: string): string {
  const clean = normalizeWhitespace(name);
  const match = clean.match(/^[A-Z][A-Za-z.'’_-]{1,30}\s+(?:CEO|Founder(?:\/CEO)?|Co[-\s]?Founder|CTO|CFO|COO|President|Chief\s+[A-Za-z]+\s+Officer)\s+(.+)$/);
  const remainder = normalizeWhitespace(match?.[1] || '');
  if (!remainder || remainder === clean) return clean;
  return isPlausibleCompanyRemainder(remainder) ? remainder : clean;
}

function canonicalizeMention(raw: string): { canonicalName: string; products: string[] } {
  let cleaned = normalizeWhitespace(raw)
    .replace(/_/g, ' ')
    .replace(/^<?https?:\/\/(?:www\.)?/i, '')
    .replace(/^<?www\./i, '')
    .replace(/\|[^>]+>?$/i, '')
    .replace(/\/$/g, '')
    .replace(/^(?:20\d{2}|fy\s*20\d{2})\s+/i, '')
    .replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)/, '')
    .replace(/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!.\s]*$/i, '')
    .replace(/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!\s]+/i, '')
    .replace(/^(?:about|regarding|subject|re|fw|fwd)\s*[:\-]?\s+/i, '')
    .replace(/^(?:Company\s+Name|Target\s+Company|Issuer|Business)\s*[:=-]?\s+/i, '')
    .replace(/\s+(?:presenting|developing|building|offering|creating)\b[\s\S]*$/i, '')
    .replace(/\b([A-Z][A-Za-z0-9&.'’-]{2,})\s+\1\b/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[.,:;]+$/g, '')
    .replace(/\s+\b(?:for|to|from|with|and|the|at)\b$/i, '')
    .trim();
  const urlDomain = cleaned.match(/^([a-z0-9-]+\.(?:ai|com|io|co|vc|capital|org|net|gov|mil|edu|health|tech|dev|finance|xyz|systems))$/i)?.[1];
  if (urlDomain && /^<?https?:\/\//i.test(normalizeWhitespace(raw))) {
    cleaned = domainLabelToCompany(urlDomain);
  }
  cleaned = stripTrailingAttachmentExtension(cleaned);
  cleaned = stripTrailingMaterialWrapper(cleaned);
  cleaned = stripFounderPersonWrapper(cleaned);
  cleaned = stripLeadingDocumentHeadingPrefix(cleaned);
  cleaned = stripLeadingPersonTitlePrefix(cleaned);
  cleaned = collapseRepeatedAdjacentName(cleaned);
  cleaned = canonicalizeKnownProspectAliasDisplay(cleaned);
  if (looksLikePersonOrParticipantBundle(cleaned)) {
    return { canonicalName: cleaned, products: [] };
  }
  const parts = cleaned.split(/\s+\/\s+/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    return { canonicalName: parts[0], products: parts.slice(1) };
  }
  return { canonicalName: cleaned, products: [] };
}

function collapseRepeatedAdjacentName(name: string): string {
  const tokens = normalizeWhitespace(name).split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length % 2 !== 0) return name;
  const mid = tokens.length / 2;
  const left = normalizeProspectName(tokens.slice(0, mid).join(' '));
  const right = normalizeProspectName(tokens.slice(mid).join(' '));
  if (left && left === right) return tokens.slice(0, mid).join(' ');
  return name;
}

function isGenericCandidate(name: string): boolean {
  const clean = normalizeWhitespace(name);
  if (isStandaloneDocumentHeading(clean) || isMarkupArtifactCandidate(clean) || isGenericFragmentCandidate(clean)) return true;
  if (looksLikePersonOrParticipantBundle(clean)) return true;
  if (/^(?:i['’]?m|i\s+am|we|they|it|there|please|sorry|no worries|sounds great|great|thanks)\b/i.test(clean)) return true;
  if (/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!.\s]*$/i.test(clean)) return true;
  if (/^(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/i.test(clean)) return true;
  if (/^(?:quantum|cyber|ai|ml|data|security|healthcare|fintech|aerospace|defense)$/i.test(clean)) return true;
  if (/\b(?:employee search endpoint|search endpoint|prospector spreadsheets?|spreadsheet|spreadsheets|presentation|verification code|calendar artifact)\b/i.test(clean)) return true;
  if (/\b(?:google meet|meet\.google\.com|join by phone|meeting link|calendar invite)\b/i.test(clean)) return true;
  if (/^(?:join with|join by|joining info|meeting link|video call|conference call|docreq)\b/i.test(clean)) return true;
  if (/^(?:about|regarding|subject|re|fw|fwd)\s*[:\-]?\s*$/i.test(clean)) return true;
  const normalized = normalizeProspectName(name);
  if (!normalized || normalized.length < 3) return true;
  return new Set([
    'hi', 'hello', 'thanks', 'thankyou', 'best', 'regards', 'forwarded',
    'subject', 'from', 'to', 'cc', 'date', 'team', 'fund', 'company',
    'meeting', 'call', 'deck', 'memo', 'newsletter', 'update', 'funding', 'claude',
    'sent', 'fwd', 'fw', 're', 'on', 'thu', 'thursday', 'wednesday',
    'monday', 'tuesday', 'friday', 'saturday', 'sunday', 'jan', 'january',
    'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun',
    'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
    'oct', 'october', 'nov', 'november', 'dec', 'december', 'lucas',
    'tony', 'anthony', 'alicia', 'michael', 'mike', 'john', 'david',
    'andrew', 'alex', 'sam', 'chris', 'leonardo', 'craig', 'manny', 'raul',
    'chuck', 'dylan', 'javier', 'kevin', 'melissa', 'nick', 'nicholas', 'wes',
    'yesha', 'khizroev', 'medina',
    'medinaventures', 'medinavc', 'mediavc', 'claudeopus', 'googlemeet',
    'meetinglink', 'joinwithgooglemeet', 'joinby', 'docreq', 'hitony',
    'employeeendpoint', 'employeesearchendpoint', 'prospectorspreadsheets',
    'cyberpresentation', 'thursdayafter', 'hco',
    'japaneseendowment', 'britishcolumbia', 'gables', 'neural',
  ]).has(normalized);
}

function isOwnFundEntity(name: string): boolean {
  const normalized = normalizeProspectName(name);
  if (!normalized) return true;
  if (/^(lucas|tony|anthony|alicia|medina|medinaventures|medinavc|mediavc)$/.test(normalized)) return true;
  return /\bmedina\s+(ventures|vc|capital)\b/i.test(name);
}

function looksLikePersonName(name: string): boolean {
  const clean = normalizeWhitespace(name).replace(/[,.]+$/g, '');
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return false;
  return PERSON_FIRST_NAMES.has(tokens[0].toLowerCase()) && tokens.every(token => /^[A-Z][a-zA-Z.'’-]+$/.test(token));
}

function isPersonSingleTokenSegment(segment: string): boolean {
  const clean = normalizeWhitespace(segment).replace(/[,.]+$/g, '');
  const normalized = clean.toLowerCase().replace(/[^a-z]/g, '');
  return /^[A-Z][a-zA-Z.'’-]+$/.test(clean) &&
    (PERSON_FIRST_NAMES.has(normalized) || PERSON_CONTACT_SINGLE_NAMES.has(normalized));
}

function isPersonSegmentLike(segment: string): boolean {
  let clean = normalizeWhitespace(segment).replace(/^[([{]+|[)\]}]+$/g, '').replace(/[,.]+$/g, '');
  clean = clean.replace(/^(?:dr|mr|mrs|ms)\.?\s+/i, '');
  if (!clean || hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return false;
  if (isPersonSingleTokenSegment(clean) || looksLikePersonName(clean)) return true;
  return /^(?:[A-Z]\.?\s*){1,3}[A-Z][a-zA-Z.'’-]+$/.test(clean);
}

function personBundleSegments(name: string): string[] {
  const clean = normalizeWhitespace(name);
  if (!clean || isKnownConnectorCompanyName(clean)) return [];
  let normalized = clean
    .replace(/\s+(?:and|with)\s+/gi, ' / ')
    .replace(/\s*[\/+;,]\s*/g, ' / ');
  if (!isKnownConnectorCompanyName(clean)) normalized = normalized.replace(/\s*&\s*/g, ' / ');
  return normalized.split(/\s+\/\s+/).map(part => part.trim()).filter(Boolean);
}

function looksLikePersonOrParticipantBundle(name: string): boolean {
  const clean = normalizeWhitespace(name);
  if (!clean || hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return false;
  const descriptor = clean.match(/^(.+?)\s+of\s+(.+)$/i);
  if (descriptor?.[1] && isPersonSegmentLike(descriptor[1])) return true;
  const segments = personBundleSegments(clean);
  if (segments.length < 2 || segments.length > 5) return false;
  return segments.every(isPersonSegmentLike);
}

function lineExcerptAt(text: string, start: number, end: number): string {
  const before = text.lastIndexOf('\n', Math.max(0, start - 1));
  const after = text.indexOf('\n', end);
  return text.slice(before < 0 ? 0 : before + 1, after < 0 ? text.length : after).slice(0, 500);
}

const PROSPECT_DOMAIN_TLDS = [
  'capital',
  'finance',
  'health',
  'tech',
  'dev',
  'com',
  'org',
  'net',
  'gov',
  'mil',
  'edu',
  'xyz',
  'vc',
  'ai',
  'io',
  'co',
];
const PROSPECT_SPLIT_TLD_PATTERN = PROSPECT_DOMAIN_TLDS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map(tld => tld.split('').map(ch => escapeRegExp(ch)).join('\\s*'))
  .join('|');
const PROSPECT_SPLIT_DOMAIN_PATTERN = String.raw`(?:[a-z0-9-]+(?:\s+[a-z0-9-]+)?\.)+\s*(?:${PROSPECT_SPLIT_TLD_PATTERN})`;

function repairBrokenDomainWhitespace(value: string): string {
  let text = String(value || '');
  const emailish = new RegExp(String.raw`\b([A-Z0-9._%+-]+@)(${PROSPECT_SPLIT_DOMAIN_PATTERN})\b`, 'gi');
  text = text.replace(emailish, (match, local: string, domainish: string) => {
    const firstDomain = domainish.match(new RegExp(String.raw`^((?:[a-z0-9-]+(?:\s+[a-z0-9-]+)?\.)+?\s*(?:${PROSPECT_SPLIT_TLD_PATTERN}))\b`, 'i'))?.[1] || domainish;
    const domain = firstDomain.replace(/\s+/g, '').toLowerCase();
    if (!domainFromUrl(domain) || shouldIgnoreDomain(domain)) return match;
    return `${local}${domain}${domainish.slice(firstDomain.length)}`;
  });
  const splitWwwDomain = new RegExp(String.raw`\b((?:https?:\/\/)?www\.[a-z0-9.-]+\.\s*(?:${PROSPECT_SPLIT_TLD_PATTERN}))\b`, 'gi');
  text = text.replace(splitWwwDomain, (match: string) => {
    const repaired = match.replace(/\s+/g, '').toLowerCase();
    const domain = domainFromUrl(repaired);
    return domain && !shouldIgnoreDomain(domain) ? repaired : match;
  });
  const domainish = new RegExp(String.raw`\b((?:https?:\/\/)?(?:www\.)?${PROSPECT_SPLIT_DOMAIN_PATTERN})\b`, 'gi');
  return text.replace(domainish, (match: string) => {
    if (/\.[a-z]{2,}\s+(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\./i.test(match)) return match;
    const beforeFinalDot = match.slice(0, Math.max(0, match.lastIndexOf('.')));
    const startsWithWww = /^(?:https?:\/\/)?www\./i.test(match);
    if (/\s/.test(beforeFinalDot) && !startsWithWww) return match;
    const repaired = match.replace(/\s+/g, '').toLowerCase();
    const domain = domainFromUrl(repaired);
    return domain && !shouldIgnoreDomain(domain) ? repaired : match;
  });
}

export function prospectContextWindow(
  text: string,
  spanStart?: number | null,
  spanEnd?: number | null,
  targetChars = PROSPECT_CONTEXT_WINDOW_CHARS
): string {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return '';
  const limit = Math.max(200, Math.floor(targetChars || PROSPECT_CONTEXT_WINDOW_CHARS));
  if (source.length <= limit) return source;

  const start = typeof spanStart === 'number' && Number.isFinite(spanStart)
    ? Math.max(0, Math.min(source.length, Math.floor(spanStart)))
    : null;
  const end = typeof spanEnd === 'number' && Number.isFinite(spanEnd)
    ? Math.max(start ?? 0, Math.min(source.length, Math.floor(spanEnd)))
    : start;

  if (start == null || end == null) {
    const prefix = source.slice(0, limit).trim();
    return `${prefix}...`;
  }

  const center = Math.floor((start + end) / 2);
  let windowStart = Math.max(0, center - Math.floor(limit / 2));
  let windowEnd = Math.min(source.length, windowStart + limit);
  windowStart = Math.max(0, windowEnd - limit);

  const excerpt = source.slice(windowStart, windowEnd).trim();
  return `${windowStart > 0 ? '...' : ''}${excerpt}${windowEnd < source.length ? '...' : ''}`;
}

function emailMatchesInText(text: string): Array<{ value: string; start: number; end: number }> {
  const matches: Array<{ value: string; start: number; end: number }> = [];
  for (const match of String(text || '').matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    if (typeof match.index !== 'number') continue;
    matches.push({
      value: String(match[0] || '').toLowerCase(),
      start: match.index,
      end: match.index + String(match[0] || '').length,
    });
  }
  return matches;
}

function domainMatchesInText(text: string): Array<{ value: string; start: number; end: number }> {
  const matches: Array<{ value: string; start: number; end: number }> = [];
  for (const match of String(text || '').matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:ai|com|io|co|health|tech|dev|finance|xyz|systems))\b/gi)) {
    const value = String(match[1] || '').toLowerCase().replace(/^www\./, '');
    if (!value || shouldIgnoreDomain(value) || typeof match.index !== 'number') continue;
    const raw = String(match[0] || '');
    const valueOffset = raw.toLowerCase().lastIndexOf(value);
    const start = match.index + Math.max(0, valueOffset);
    matches.push({ value, start, end: start + value.length });
  }
  for (const email of emailMatchesInText(text)) {
    const domain = email.value.split('@')[1]?.toLowerCase().replace(/^www\./, '');
    if (!domain || shouldIgnoreDomain(domain)) continue;
    const atIndex = email.value.indexOf('@');
    matches.push({ value: domain, start: email.start + atIndex + 1, end: email.end });
  }
  matches.sort((a, b) => a.start - b.start || a.value.localeCompare(b.value));
  const seen = new Set<string>();
  return matches.filter(match => {
    const key = `${match.value}:${match.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contactNameStartBeforeEmail(text: string, emailStart: number): number | null {
  const source = String(text || '');
  const email = source.slice(emailStart).match(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const localFirst = normalizeProspectName(email.split('@')[0]?.split(/[._-]+/)[0] || '');
  if (!localFirst || localFirst.length < 3) return null;
  const searchStart = Math.max(0, emailStart - 160);
  const beforeEmail = source.slice(searchStart, emailStart);
  const tokens = Array.from(beforeEmail.matchAll(/\b[A-Z][A-Za-z.'’/-]{1,40}\b/g));
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    const normalized = normalizeProspectName(token[0] || '');
    if (!normalized || (!normalized.startsWith(localFirst) && !localFirst.startsWith(normalized))) continue;
    return searchStart + (token.index || 0);
  }
  return null;
}

function contactMatchTrimOffset(matchedText: string): number {
  const matches = Array.from(String(matchedText || '').matchAll(/[.!?]\s+/g));
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const index = match.index ?? -1;
    if (index < 0) continue;
    const lastWord = matchedText.slice(0, index).trim().split(/\s+/).pop() || '';
    if (/^[A-Z]$/.test(lastWord)) continue;
    return index + match[0].length;
  }
  return 0;
}

function rowStartBeforeContactEmail(text: string, emailStart: number): number {
  const source = String(text || '');
  const searchStart = Math.max(0, emailStart - 260);
  const beforeEmail = source.slice(searchStart, emailStart);
  const contactMatches = Array.from(beforeEmail.matchAll(/([A-Z][A-Za-z.'’/-]+(?:\s+[A-Z][A-Za-z.'’/-]+){0,3},?\s+(?:CEO|CTO|CFO|COO|VP|Founder|Co[-\s]?Founder|President|Director|Head|Chief|Managing\s+Partner|General\s+Manager)\b[^@]{0,80})/g));
  const contactMatch = contactMatches.at(-1);
  if (contactMatch?.[1]) {
    const matchedText = contactMatch[1];
    return searchStart + (contactMatch.index || 0) + contactMatch[0].indexOf(matchedText) + contactMatchTrimOffset(matchedText);
  }
  const contactNameStart = contactNameStartBeforeEmail(source, emailStart);
  if (contactNameStart != null) return contactNameStart;
  return Math.max(0, emailStart - 450);
}

function nextContactTitleStart(text: string, afterIndex: number, searchChars = 2400): number | null {
  const source = String(text || '');
  const start = Math.max(0, afterIndex);
  const slice = source.slice(start, Math.min(source.length, start + searchChars));
  const match = /[A-Z][A-Za-z.'’/-]+(?:\s+[A-Z][A-Za-z.'’/-]+){0,3},?\s+(?:CEO|CTO|CFO|COO|VP|Founder|Co[-\s]?Founder|President|Director|Head|Chief|Managing\s+Partner|General\s+Manager)\b/g.exec(slice);
  if (match?.index == null) return null;
  const matchedText = match[0] || '';
  return start + match.index + contactMatchTrimOffset(matchedText);
}

function previousContactTitleStart(text: string, beforeIndex: number, searchChars = 700): number | null {
  const source = String(text || '');
  const start = Math.max(0, beforeIndex - searchChars);
  const slice = source.slice(start, Math.max(0, beforeIndex));
  const matches = Array.from(slice.matchAll(/[A-Z][A-Za-z.'’/-]+(?:\s+[A-Z][A-Za-z.'’/-]+){0,4},?\s+(?:CEO|CTO|CFO|COO|VP|Founder|Co[-\s]?Founder|President|Director|Head|Chief|Managing\s+Partner|General\s+Manager)\b/g));
  const match = matches.at(-1);
  if (match?.index == null) return null;
  const matchedText = match[0] || '';
  return start + match.index + contactMatchTrimOffset(matchedText);
}

function rowContextAroundAnchor(
  text: string,
  anchor: number,
  rawLength: number,
  targetChars = 2200
): string | null {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return null;
  if (!Number.isFinite(anchor) || anchor < 0) return null;
  const emails = emailMatchesInText(source);
  const previousContactStart = previousContactTitleStart(source, anchor);
  if (previousContactStart != null && anchor - previousContactStart <= 650) {
    const nextContactStart = nextContactTitleStart(source, anchor + rawLength + 1);
    const rowEnd = nextContactStart != null && nextContactStart > previousContactStart + 40
      ? nextContactStart
      : Math.min(source.length, previousContactStart + targetChars);
    return source.slice(previousContactStart, rowEnd).trim() || null;
  }
  if (emails.length === 0) {
    return prospectContextWindow(source, anchor, anchor + rawLength, targetChars);
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const distance = anchor >= email.start && anchor <= email.end
      ? 0
      : Math.min(Math.abs(anchor - email.start), Math.abs(anchor - email.end));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || bestDistance > 650) {
    return prospectContextWindow(source, anchor, anchor + rawLength, targetChars);
  }

  const currentEmail = emails[bestIndex];
  const nextEmail = emails[bestIndex + 1] || null;
  const rowStart = rowStartBeforeContactEmail(source, currentEmail.start);
  const nextRowStart = nextEmail ? rowStartBeforeContactEmail(source, nextEmail.start) : -1;
  const nextContactStart = nextContactTitleStart(source, currentEmail.end + 1);
  const rowEndCandidates = [
    nextRowStart > rowStart ? nextRowStart : null,
    nextContactStart != null && nextContactStart > rowStart + 40 ? nextContactStart : null,
    Math.min(source.length, rowStart + targetChars),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  let rowEnd = Math.min(...rowEndCandidates);
  rowEnd = Math.max(rowStart + 1, Math.min(source.length, rowEnd));
  let row = source.slice(rowStart, rowEnd).trim();
  if (row.length > targetChars) {
    const localAnchor = Math.max(0, anchor - rowStart);
    row = prospectContextWindow(row, localAnchor, localAnchor + rawLength, targetChars);
  }
  return row || null;
}

function rowContextWindowForListMention(
  text: string,
  mention: MentionCandidate,
  targetChars = 2200
): string | null {
  if (!mention.isListEntry && !mention.listFields) return null;
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return null;
  const anchorCandidates = [
    typeof mention.spanStart === 'number' && Number.isFinite(mention.spanStart) ? mention.spanStart : -1,
    findCaseInsensitive(source, mention.raw),
    findCaseInsensitive(source, mention.canonicalName),
    mention.listFields?.website ? findCaseInsensitive(source, mention.listFields.website) : -1,
    mention.listFields?.poc ? findCaseInsensitive(source, mention.listFields.poc) : -1,
  ].filter(index => index >= 0);
  if (anchorCandidates.length === 0) return null;
  const anchor = anchorCandidates[0];
  return rowContextAroundAnchor(source, anchor, (mention.raw || mention.canonicalName).length, targetChars);
}

function stripEmailScaffoldingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^(?:from|sent|to|cc|bcc|date|subject)\s*:/i.test(trimmed)) return true;
  if (/^(?:fwd?|re)\s*:\s*$/i.test(trimmed)) return true;
  if (/^(?:fwd?|re)\s*:\s*(?:from|sent|to|cc|bcc|date)\b/i.test(trimmed)) return true;
  if (/^[-_]{2,}\s*(?:original|forwarded)\s+message\s*[-_]{2,}$/i.test(trimmed)) return true;
  if (/^on\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[, ]/i.test(trimmed)) return true;
  if (/^on\s+.+\s+wrote:$/i.test(trimmed)) return true;
  if (/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!.\s]*$/i.test(trimmed)) return true;
  if (/^(?:best|thanks|thank you|regards|sincerely|cheers|warmly)[,!.\s]*$/i.test(trimmed)) return true;
  if (/^(?:get outlook for ios|sent from my iphone|sent from my ipad)$/i.test(trimmed)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}(?:,\s*\d{1,2}:\d{2}\s*(?:am|pm)?)?$/i.test(trimmed)) return true;
  return false;
}

export function cleanProspectSourceText(rawText: string): { cleanedText: string } {
  const normalizedText = repairBrokenDomainWhitespace(String(rawText || ''))
    .replace(/&nbsp;|&#160;|&#65279;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+(Begin forwarded message:)/gi, '\n$1')
    .replace(/\s+((?:From|Sent|To|Cc|Bcc|Date|Subject):)/gi, '\n$1')
    .replace(/\s+(On\s+(?:mon|tue|wed|thu|fri|sat|sun)[^.\n]{0,200}\s+wrote:?)/gi, '\n$1');
  const lines = normalizedText.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^>\s?/.test(line)) continue;
    if (stripEmailScaffoldingLine(line)) continue;
    const trimmed = line.trim();
    if (/^(?:lucas|tony|anthony|alicia)\b(?:\s+[A-Z][A-Za-z.'-]+)?\s*$/i.test(trimmed)) continue;
    const pairedMedinaTitle = /^(?:re|fw|fwd)?\s*:?\s*[A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5}\s*(?:<>|<->|x|\/|&|\band\b)\s*Medina(?:\s+Ventures)?\b/i.test(trimmed);
    if (
      /\bmedina\s+(?:ventures|vc|capital)\b/i.test(trimmed) &&
      trimmed.length < 80 &&
      !pairedMedinaTitle &&
      !/\b(?:intro|introduction|meet|deck|update|fundrais|pitch|demo)\b|\([^)]+\)/i.test(trimmed)
    ) continue;
    kept.push(line);
  }
  return { cleanedText: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function domainLabelToCompany(domain: string): string {
  let first = domain.toLowerCase().replace(/^www\./, '').split('.')[0] || '';
  first = first.replace(/(?:inc|llc|ltd|corp|pbc|cpa|management)$/i, '');
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

const DOMAIN_BRAND_PREFIXES = [
  'hello',
  'get',
  'try',
  'use',
  'go',
  'join',
  'ask',
  'app',
  'my',
  'with',
];

const PROSPECT_IDENTITY_ALIAS_GROUPS = [
  ['subq', 'subquadratic'],
  ['rvr', 'rivervalleyranch'],
  ['aliro', 'aliroquantum', 'aleroderquantum', 'aliroderquantum'],
  ['btw', 'breaktheweb'],
  ['blaze', 'blazetech'],
  ['sovereign', 'sovereignai'],
];

const COMPANY_SUFFIX_ALIAS_WORDS = [
  'therapeutics',
  'therapeutic',
  'semiconductors',
  'semiconductor',
  'technologies',
  'technology',
  'security',
  'systems',
  'system',
  'software',
  'robotics',
  'compute',
  'health',
  'biotech',
  'ventures',
  'capital',
  'labs',
  'lab',
  'bio',
  'ai',
  'semi',
];

const KNOWN_PROSPECT_ALIAS_CANONICAL_NAMES: Record<string, string> = {
  aleroderquantum: 'Aliro Quantum Technologies',
  aleroderquantumtechnologies: 'Aliro Quantum Technologies',
  aliroderquantum: 'Aliro Quantum Technologies',
  aliroderquantumtechnologies: 'Aliro Quantum Technologies',
  btw: 'Breaktheweb',
  breaktheweb: 'Breaktheweb',
  ciphertech: 'Cipher Tech Solutions',
  fallom: 'Fallom Labs',
  farview: 'Farview.ai',
  flovisionsolutions: 'FloVision Solutions',
  helloabra: 'Abra',
  hummingbirds: 'Hummingbirds AI',
  industrialmind: 'IndustrialMind',
  rvrrivervalleyranch: 'River Valley Ranch',
  servescale: 'Servescale',
  subqsubquadratic: 'Subquadratic',
};

function canonicalizeKnownProspectAliasDisplay(name: string): string {
  const normalized = normalizeProspectName(name);
  return KNOWN_PROSPECT_ALIAS_CANONICAL_NAMES[normalized] || name;
}

function identityAliasVariants(normalized: string): Set<string> {
  const aliases = new Set<string>();
  const clean = String(normalized || '').replace(/[^a-z0-9]/g, '');
  if (!clean || clean.length < 3) return aliases;
  aliases.add(clean);
  const spellingVariant = clean.replace(/grey/g, 'gray');
  if (spellingVariant !== clean && spellingVariant.length >= 3) aliases.add(spellingVariant);
  const inverseSpellingVariant = clean.replace(/gray/g, 'grey');
  if (inverseSpellingVariant !== clean && inverseSpellingVariant.length >= 3) aliases.add(inverseSpellingVariant);
  for (const prefix of DOMAIN_BRAND_PREFIXES) {
    if (!clean.startsWith(prefix)) continue;
    const remainder = clean.slice(prefix.length);
    if (remainder.length >= 4 && !isGenericFragmentCandidate(remainder)) aliases.add(remainder);
  }
  for (const suffix of COMPANY_SUFFIX_ALIAS_WORDS) {
    if (!clean.endsWith(suffix)) continue;
    const base = clean.slice(0, -suffix.length);
    if (base.length >= 4 && !isGenericFragmentCandidate(base)) aliases.add(base);
  }
  for (const group of PROSPECT_IDENTITY_ALIAS_GROUPS) {
    if (!group.includes(clean)) continue;
    for (const alias of group) aliases.add(alias);
  }
  return aliases;
}

function prospectIdentityAliasesForName(value: string | null | undefined): Set<string> {
  const aliases = identityAliasVariants(normalizeProspectName(value));
  const acronym = prospectIdentityAcronymAlias(value);
  if (acronym) aliases.add(acronym);
  return aliases;
}

function prospectIdentityAcronymAlias(value: string | null | undefined): string | null {
  const words = normalizeWhitespace(value || '')
    .replace(/&/g, ' and ')
    .split(/[^A-Za-z0-9]+/g)
    .map(word => word.trim())
    .filter(Boolean)
    .filter(word => !/^(?:the|and|of|for|to|in|on|at|inc|llc|ltd|corp|co|company|technologies|technology|systems|solutions|labs|lab|capital|ventures|partners)$/i.test(word));
  if (words.length < 2) return null;
  const acronym = words.map(word => word[0]).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (acronym.length < 3 || acronym.length > 6) return null;
  return acronym;
}

function domainsInText(text: string, env?: Env): string[] {
  const domains: string[] = [];
  for (const match of String(text || '').matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:ai|com|io|co|vc|capital|org|net|gov|mil|edu|health|tech|dev|finance|xyz|systems))\b/gi)) {
    const rawDomain = match[1]?.toLowerCase().replace(/^www\./, '') || '';
    const domain = rawDomain ? registrableDomain(rawDomain) : '';
    if (!domain || shouldIgnoreDomain(domain, env)) continue;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function firstProspectDomainForMention(mention: MentionCandidate, env?: Env): string | null {
  const fields = [
    mention.listFields?.website || '',
    mention.raw,
    mention.lineText,
    mention.contextText,
  ];
  for (const field of fields) {
    const value = String(field || '').trim();
    const direct = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z0-9.-]+/i.test(value) ? domainFromUrl(value) : null;
    if (direct && !shouldIgnoreDomain(direct, env)) return direct;
    const [domain] = domainsInText(value, env);
    if (domain) return domain;
  }
  return null;
}

function prospectIdentityAliasesForMention(mention: MentionCandidate, env?: Env): Set<string> {
  const aliases = prospectIdentityAliasesForName(mention.canonicalName);
  const domain = firstProspectDomainForMention(mention, env);
  if (domain) {
    for (const alias of prospectIdentityAliasesForName(domainLabelToCompany(domain))) aliases.add(alias);
  }
  return aliases;
}

export type EntityIdentityAliasKind = 'normalized_name' | 'domain' | 'domain_brand' | 'product' | 'stealth' | 'manual';

export interface EntityIdentityAliasValue {
  aliasKind: EntityIdentityAliasKind;
  aliasValue: string;
  confidence: number;
}

function entityIdentityDomain(input: { domain?: string | null; website?: string | null }, env?: Env): string | null {
  const domain = domainFromUrl(input.domain || input.website || '') || String(input.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!domain) return null;
  const normalized = registrableDomain(domain);
  return normalized && !shouldIgnoreDomain(normalized, env) ? normalized : null;
}

export function buildEntityIdentityAliasValues(input: {
  name?: string | null;
  normalizedName?: string | null;
  domain?: string | null;
  website?: string | null;
  env?: Env;
}): EntityIdentityAliasValue[] {
  const aliases = new Map<string, EntityIdentityAliasValue>();
  const add = (aliasKind: EntityIdentityAliasKind, value: string | null | undefined, confidence: number): void => {
    const aliasValue = aliasKind === 'domain'
      ? entityIdentityDomain({ domain: value }, input.env)
      : normalizeProspectName(value);
    if (!aliasValue || aliasValue.length < 3) return;
    const key = `${aliasKind}:${aliasValue}`;
    const existing = aliases.get(key);
    if (!existing || confidence > existing.confidence) aliases.set(key, { aliasKind, aliasValue, confidence });
  };

  add('normalized_name', input.normalizedName || input.name, 1);
  for (const alias of prospectIdentityAliasesForName(input.name)) {
    add('normalized_name', alias, alias === normalizeProspectName(input.name) ? 1 : 0.92);
  }

  const domain = entityIdentityDomain(input, input.env);
  if (domain) {
    add('domain', domain, 1);
    add('domain_brand', domainLabelToCompany(domain), 0.92);
    for (const alias of prospectIdentityAliasesForName(domainLabelToCompany(domain))) {
      add('domain_brand', alias, 0.9);
    }
  }

  return Array.from(aliases.values());
}

function isMissingIdentityAliasTableError(error: unknown): boolean {
  return /entity_identity_aliases|no such table|D1_ERROR/i.test(error instanceof Error ? error.message : String(error || ''));
}

export async function upsertEntityIdentityAliases(args: {
  orgId: string;
  entityType: 'company' | 'prospect';
  entityId: string;
  name?: string | null;
  normalizedName?: string | null;
  domain?: string | null;
  website?: string | null;
  sourceKind?: 'system' | 'classifier' | 'enrichment' | 'manual' | 'migration';
  evidence?: Record<string, unknown>;
}, env: Env): Promise<number> {
  const values = buildEntityIdentityAliasValues({
    name: args.name,
    normalizedName: args.normalizedName,
    domain: args.domain,
    website: args.website,
    env,
  });
  if (values.length === 0) return 0;
  let written = 0;
  for (const value of values) {
    try {
      await env.D1.prepare(
        `INSERT INTO entity_identity_aliases (
           org_id, entity_type, entity_id, alias_kind, alias_value, confidence, source_kind, evidence_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(org_id, entity_type, entity_id, alias_kind, alias_value) DO UPDATE SET
           confidence = MAX(entity_identity_aliases.confidence, excluded.confidence),
           source_kind = excluded.source_kind,
           evidence_json = excluded.evidence_json,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      ).bind(
        args.orgId,
        args.entityType,
        args.entityId,
        value.aliasKind,
        value.aliasValue,
        value.confidence,
        args.sourceKind || 'system',
        JSON.stringify(args.evidence || {})
      ).run();
      written++;
    } catch (error) {
      if (isMissingIdentityAliasTableError(error)) return written;
      throw error;
    }
  }
  return written;
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function mentionLooksDomainDerived(mention: MentionCandidate, env?: Env): boolean {
  return /\.[a-z]{2,}\b/i.test(mention.raw) || /@[^@\s]+\.[a-z]{2,}\b/i.test(mention.raw);
}

function mentionNameMatchesOwnDomain(mention: MentionCandidate, env?: Env): boolean {
  const domain = firstProspectDomainForMention(mention, env);
  if (!domain) return false;
  return identityAliasSetsCompatible(
    prospectIdentityAliasesForName(mention.canonicalName),
    prospectIdentityAliasesForName(domainLabelToCompany(domain))
  );
}

function prospectDisplayNameScore(mention: MentionCandidate, env?: Env): number {
  let score = 0;
  const clean = normalizeWhitespace(mention.canonicalName);
  const domain = firstProspectDomainForMention(mention, env);
  const nameMatchesDomain = mentionNameMatchesOwnDomain(mention, env);
  if (mention.isListEntry) score += 8;
  if (hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) score += 6;
  if (/^[A-Z0-9][A-Za-z0-9&.'’/-]*(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]*){0,4}$/.test(clean)) score += 5;
  if (mention.listFields?.website) score += 4;
  if (nameMatchesDomain) score += 8;
  if (domain && mention.isListEntry && !nameMatchesDomain) score -= 8;
  if (mentionLooksDomainDerived(mention, env)) score -= 12;
  if (/\.[a-z]{2,}\b/i.test(mention.raw)) score -= 8;
  if (clean.length > 2 && clean.length <= 40) score += Math.max(0, 6 - Math.floor(clean.length / 12));
  return score;
}

function betterProspectMention(left: MentionCandidate, right: MentionCandidate, env?: Env): MentionCandidate {
  const leftScore = prospectDisplayNameScore(left, env);
  const rightScore = prospectDisplayNameScore(right, env);
  if (rightScore > leftScore) return right;
  if (leftScore > rightScore) return left;
  const leftStart = left.spanStart ?? Number.MAX_SAFE_INTEGER;
  const rightStart = right.spanStart ?? Number.MAX_SAFE_INTEGER;
  return rightStart < leftStart ? right : left;
}

function shouldMergeMentionIdentity(left: MentionCandidate, right: MentionCandidate, env?: Env): boolean {
  if (left.normalizedName === right.normalizedName) return true;
  const leftAliases = prospectIdentityAliasesForMention(left, env);
  const rightAliases = prospectIdentityAliasesForMention(right, env);
  if (!setsIntersect(leftAliases, rightAliases)) return false;
  if (mentionLooksDomainDerived(left, env) || mentionLooksDomainDerived(right, env)) return true;
  const leftDomain = firstProspectDomainForMention(left, env);
  const rightDomain = firstProspectDomainForMention(right, env);
  if (leftDomain && rightDomain && leftDomain === rightDomain) return true;
  return false;
}

function dedupeMentionIdentityCandidates(candidates: MentionCandidate[], env?: Env): MentionCandidate[] {
  const groups: MentionCandidate[] = [];
  for (const candidate of candidates) {
    const matchIndex = groups.findIndex(existing => shouldMergeMentionIdentity(existing, candidate, env));
    if (matchIndex < 0) {
      groups.push(candidate);
      continue;
    }
    const winner = betterProspectMention(groups[matchIndex], candidate, env);
    groups[matchIndex] = {
      ...winner,
      products: Array.from(new Set([...(groups[matchIndex].products || []), ...(candidate.products || [])])),
      listFields: winner.listFields || groups[matchIndex].listFields || candidate.listFields,
    };
  }
  return groups;
}

function shouldIgnoreDomain(domain: string, env?: Env): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  const first = normalized.split('.')[0];
  if (/medina|mediavc/.test(normalized)) return true;
  const common = new Set([
    'gmail.com', 'google.com', 'outlook.com', 'office.com', 'office365.com',
    'microsoft.com', 'icloud.com', 'yahoo.com', 'hotmail.com', 'aol.com',
    'zoom.us', 'linkedin.com', 'x.com', 'twitter.com', 'facebook.com',
    'instagram.com', 'youtube.com', 'substack.com', 'mailchimp.com',
    'sendgrid.net', 'hubspot.com', 'salesforce.com', 'dropbox.com',
    'box.com', 'docusign.net', 'calendly.com',
  ]);
  if (common.has(normalized)) return true;
  if (['zoom', 'zoomcrc', 'googlemeet', 'teams', 'webex'].includes(first)) return true;
  if (first.length < 3) return true;
  return env ? isInternalEmailDomain(`noreply@${normalized}`, getConfiguredInternalDomains(env)) : false;
}

function findCaseInsensitive(text: string, needle: string, fromIndex = 0): number {
  if (!needle.trim()) return -1;
  return text.toLowerCase().indexOf(needle.toLowerCase(), fromIndex);
}

function stripJsonCodeFence(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return text;
}

function matchingJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJsonObject(raw: string, errorCode = 'INVALID_JSON_OBJECT'): Record<string, unknown> {
  const text = stripJsonCodeFence(raw);
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Fall through to matching-object extraction for responses with prose after the object.
    }
  }
  const start = text.indexOf('{');
  const end = start >= 0 ? matchingJsonObjectEnd(text, start) : -1;
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${errorCode}: ${message}`);
    }
  }
  throw new Error(errorCode);
}

function parseOrgExtractionResponse(raw: string): ProspectOrgExtractionLlmOutput[] {
  const parsed = parseJsonObject(raw, 'INVALID_ORG_EXTRACTION_JSON');
  const rows = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  const out: ProspectOrgExtractionLlmOutput[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? normalizeWhitespace(entry.name) : '';
    if (!name) continue;
    out.push({
      name,
      raw: typeof entry.raw === 'string' ? normalizeWhitespace(entry.raw) : null,
      context: typeof entry.context === 'string' ? normalizeWhitespace(entry.context).slice(0, 300) : null,
    });
  }
  return out;
}

function orgExtractionModel(env: Env): string {
  return env.PROSPECT_ORG_EXTRACTOR_MODEL || env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || PROSPECT_CLASSIFIER_DEFAULT_MODEL;
}

function buildOrgExtractionPrompt(input: ProspectOrgExtractionLlmInput): { system: ClaudeSystemPrompt; user: string } {
  const targetRecoveryMode = input.mode === 'target_recovery';
  const staticSystem = targetRecoveryMode
    ? `Find the actual target company or companies being pitched, introduced, demoed, diligence-reviewed, or presented as possible investment opportunities in one cleaned source item.
Return strict JSON only. Prefer the startup/company whose product, business, fundraise, diligence, demo, pitch, or opportunity is being discussed.
Do not return the source, intro channel, advisor, investor, customer, event host, meeting participant, government buyer, or Medina Ventures unless that exact entity is clearly the investment target.
Do not include people, greetings, dates, email headers, person/participant bundles, section headings, filenames, markup/schema/CSS artifacts, calendar or meeting-link scaffolding, or generic words.
Only include names whose exact text appears in the source so the caller can anchor a deterministic span.
Output: {"organizations":[{"name":"Target Company","raw":"exact source span","context":"short local context"}]}`
    : `Extract organization names from one cleaned source item for a venture-fund prospect-intelligence pipeline.
Return strict JSON only. Include real organizations of any role: startups, known deals, customers,
vendors, law firms, accelerators, government channels, investors, and companies in news.
	Do not include people, greetings, dates, email headers, quoted-reply scaffolding, personal names,
	person/participant bundles, section headings, filenames, markup/schema/CSS artifacts,
	calendar or meeting-link scaffolding, DocReq/doc-request labels, Medina Ventures / Medina VC, or
	generic words. Do not classify the mention_type, direction, or sector.
Only include names whose exact text appears in the source so the caller can anchor a deterministic span.
Output: {"organizations":[{"name":"Organization Name","raw":"exact source span","context":"short local context"}]}`;
  const system: ClaudeSystemPrompt = [
    { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
  const user = `SOURCE CONTEXT:
${input.sourceContext}

CLEANED SOURCE:
${input.cleanedText.slice(0, 7000)}`;
  return { system, user };
}

async function defaultLlmExtractOrganizations(
  input: ProspectOrgExtractionLlmInput,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites' | 'stats'> = {}
): Promise<ProspectOrgExtractionLlmOutput[]> {
  const prompt = buildOrgExtractionPrompt(input);
  const model = orgExtractionModel(env);
  const stage = input.mode === 'target_recovery' ? 'target_recovery' : 'org_extraction';
  const hashes = await prospectLlmCacheKey({
    orgId: input.orgId,
    stage,
    promptVersion: `${PROSPECT_CLASSIFIER_VERSION}:org-extract-v1`,
    model,
    source: { cleanedText: input.cleanedText, sourceContext: input.sourceContext },
    candidate: { mode: input.mode || 'all_organizations' },
  });
  if (!options.dryRunNoBudgetWrites) {
    const cached = await readD1ProspectLlmCache<ProspectOrgExtractionLlmOutput[]>(env, hashes.cacheKey);
    if (cached) {
      recordLlmStageUsage(options.stats, stage, { cacheHit: true });
      return cached.value_json;
    }
  }
  const result = await callClaudeWithUsage(
    {
      system: prompt.system,
      user: prompt.user,
      max_tokens: 900,
      orgId: input.orgId,
      model,
      dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
    },
    'low',
    env
  );
  recordLlmStageUsage(options.stats, stage, { usage: result.usage, paidCall: true });
  let parsed: ProspectOrgExtractionLlmOutput[];
  try {
    parsed = parseOrgExtractionResponse(result.text);
  } catch (error) {
    if (stage !== 'org_extraction') throw error;
    recordLlmStageUsage(options.stats, stage, { cacheHit: false });
    return [];
  }
  if (!options.dryRunNoBudgetWrites) {
    await writeD1ProspectLlmCache(env, {
      cache_key: hashes.cacheKey,
      org_id: input.orgId,
      stage,
      prompt_version: `${PROSPECT_CLASSIFIER_VERSION}:org-extract-v1`,
      model: result.model,
      source_hash: hashes.sourceHash,
      candidate_hash: hashes.candidateHash,
      context_hash: hashes.contextHash,
      decision_hash: hashes.decisionHash,
      value_json: parsed,
      usage: result.usage,
      created_at: new Date().toISOString(),
    });
  }
  return parsed;
}

function sectorHintForText(text: string): { key: SectorKey; confidence: number } {
  const s = text.toLowerCase();
  const checks: Array<{ key: SectorKey; confidence: number; terms: RegExp[] }> = [
    { key: 'cybersecurity', confidence: 0.86, terms: [/\bcybersecurity\b/, /\bsecurity\b/, /\bthreat\b/, /\bsiem\b/, /\bidentity\b/, /\bzero trust\b/, /\bvulnerability\b/, /\bmalware\b/, /\bfortilayer\b/, /\bbinlens\b/] },
    { key: 'quantum', confidence: 0.86, terms: [/\bquantum\b/, /\bqubit\b/, /\bphotonic\b/, /\bpost-quantum\b/] },
    { key: 'ai_data', confidence: 0.86, terms: [/\bai\b/, /\bartificial intelligence\b/, /\bmachine learning\b/, /\bmlops\b/, /\bgpu\b/, /\binference\b/, /\bvector database\b/, /\bdata infrastructure\b/, /\bllm\b/] },
    { key: 'dev_cloud_infra', confidence: 0.82, terms: [/\bdeveloper tool/, /\bdevtools?\b/, /\bcloud infrastructure\b/, /\bkubernetes\b/, /\bserverless\b/, /\bobservability\b/, /\bdata infrastructure\b/] },
    { key: 'enterprise_software', confidence: 0.78, terms: [/\bsaas\b/, /\bworkflow\b/, /\benterprise\b/, /\bplatform\b/, /\bcrm\b/, /\berp\b/] },
    { key: 'fintech', confidence: 0.84, terms: [/\bfintech\b/, /\bpayments?\b/, /\bbanking\b/, /\bcredit\b/, /\binsurtech\b/, /\bfraud\b/] },
    { key: 'healthcare', confidence: 0.8, terms: [/\bhealthcare\b/, /\bbiotech\b/, /\bpharma\b/, /\bclinical\b/, /\bmedical\b/] },
    { key: 'aerospace_defense', confidence: 0.82, terms: [/\baerospace\b/, /\bdefen[cs]e\b/, /\barmy\b/, /\bnavy\b/, /\bair force\b/, /\bmilitary\b/, /\bdod\b/, /\bdual-use\b/, /\buav\b/, /\bsbir\b/] },
    { key: 'hardware_semis', confidence: 0.78, terms: [/\bhardware\b/, /\bsemiconductor\b/, /\bchips?\b/, /\bsensor\b/, /\bdevice\b/, /\bsilicon\b/] },
    { key: 'robotics', confidence: 0.82, terms: [/\brobotics?\b/, /\bautonomous robot\b/, /\bdrone\b/, /\brover\b/] },
    { key: 'energy_climate', confidence: 0.8, terms: [/\bclimate\b/, /\bcarbon\b/, /\benergy\b/, /\bbattery\b/, /\bsolar\b/, /\bgrid\b/] },
    { key: 'materials_manufacturing', confidence: 0.8, terms: [/\bmaterials?\b/, /\bmanufactur/, /\bhempcrete\b/, /\bcomposite\b/, /\bcement\b/, /\bfactory\b/] },
    { key: 'mobility_logistics', confidence: 0.78, terms: [/\bmobility\b/, /\blogistics\b/, /\bsupply chain\b/, /\bfreight\b/, /\bfleet\b/, /\bshipping\b/] },
    { key: 'real_estate_built_env', confidence: 0.74, terms: [/\breal estate\b/, /\bproptech\b/, /\bconstruction\b/, /\bbuilt environment\b/, /\bbuilding\b/] },
    { key: 'consumer', confidence: 0.65, terms: [/\bconsumer\b/, /\bcreator\b/, /\bmarketplace\b/, /\bcommerce\b/] },
    { key: 'agri_food', confidence: 0.76, terms: [/\bagricultur/, /\bfood\b/, /\bfarm\b/, /\bcrop\b/, /\bprotein\b/] },
    { key: 'education', confidence: 0.76, terms: [/\beducation\b/, /\bedtech\b/, /\blearning\b/, /\bschool\b/, /\btraining\b/] },
  ];
  for (const check of checks) {
    if (check.terms.some(re => re.test(s))) return { key: check.key, confidence: check.confidence };
  }
  return { key: 'uncategorized', confidence: 0.2 };
}

function hasDeckSignal(item: ClassifiedItem): boolean {
  const text = `${item.subject || ''}\n${item.bodyText || ''}\n${item.bodyPreview || ''}`.toLowerCase();
  if (/\b(pitch deck|deck attached|attached deck|data room|cim|memo|one[-_\s]?pager|1[-_\s]?pager|two[-_\s]?pager|2[-_\s]?pager)\b/.test(text)) return true;
  return (item.attachments || []).some(att =>
    /\b(deck|pitch|memo|cim|data[-_\s]?room|teaser|one[-_\s]?pager|1[-_\s]?pager|two[-_\s]?pager|2[-_\s]?pager)\b/i.test(att.name) ||
    /\.(pptx?|pdf)$/i.test(att.name)
  );
}

function hasMeetingSignal(item: ClassifiedItem): boolean {
  const haystack = `${item.subject || ''}\n${item.bodyText || ''}`.toLowerCase();
  return item.type === 'calendar_event' || /\b(meeting|met with|call|zoom|intro call|demo)\b/.test(haystack);
}

function isNewsletterLike(item: ClassifiedItem): boolean {
  const from = `${item.fromEmail || ''} ${item.fromName || ''}`.toLowerCase();
  const subject = (item.subject || '').toLowerCase();
  if (/\b(newsletter|digest|news|weekly|daily brief|nvca|substack|mailchimp)\b/.test(from)) return true;
  if (/\b(newsletter|news digest|weekly digest|daily digest|market update|nvca)\b/.test(subject)) return true;
  return item.type === 'news';
}

function inferDirection(item: ClassifiedItem, env: Env, companyDomain?: string | null): DeterministicDirection {
  if (item.direction) return item.direction;
  if (item.type === 'news') return 'news';
  const internalDomains = getConfiguredInternalDomains(env);
  const fromInternal = isInternalEmailDomain(item.fromEmail, internalDomains);
  const fromDomain = emailDomain(item.fromEmail);
  const recipients = [...(item.toEmails || []), ...(item.ccEmails || [])].filter(Boolean);
  const recipientDomains = recipients.map(email => emailDomain(email)).filter(Boolean) as string[];
  const normalizedCompanyDomain = companyDomain?.trim().toLowerCase() || null;
  if (normalizedCompanyDomain && fromDomain === normalizedCompanyDomain) return 'inbound';
  if (normalizedCompanyDomain && fromInternal && recipientDomains.includes(normalizedCompanyDomain)) return 'outbound';
  if (fromInternal && recipients.length > 0 && recipients.every(email => isInternalEmailDomain(email, internalDomains))) return 'internal';
  if (fromInternal) return 'outbound';
  if (item.type === 'slack_message') return 'internal';
  return 'inbound';
}

function signalKindFor(item: ClassifiedItem, mention: MentionCandidate, hasDeck: boolean, hasMeeting: boolean): SignalKind {
  const haystack = `${item.subject || ''}\n${mention.contextText || mention.lineText}\n${item.bodyPreview || ''}`.toLowerCase();
  if (hasDeck) return 'deck';
  if (hasMeeting) return 'meeting';
  if (isWarmIntroSignal(item, mention)) return 'intro';
  if (/\b(raise|raising|round|seed|series [abc]|allocation|term sheet)\b/.test(haystack)) return 'raise';
  if (mention.isListEntry) return 'list_entry';
  return 'cold_mention';
}

function isWarmIntroSignal(item: ClassifiedItem, mention: MentionCandidate): boolean {
  const haystack = `${item.subject || ''}\n${mention.contextText || mention.lineText}\n${item.bodyPreview || ''}`.toLowerCase();
  return /\b(intro|introducing|introduction|warm intro|meet\s+\w+)/.test(haystack);
}

function confidenceFor(kind: SignalKind, direction: DeterministicDirection, newsletter: boolean): { confidence: number; tier: ConfidenceTier; provisional: boolean } {
  if (newsletter) return { confidence: 0.25, tier: 'low', provisional: true };
  let confidence = 0.62;
  if (kind === 'meeting') confidence += 0.18;
  if (kind === 'deck') confidence += 0.16;
  if (kind === 'intro') confidence += 0.14;
  if (kind === 'raise') confidence += 0.1;
  if (kind === 'list_entry') confidence -= 0.08;
  if (kind === 'cold_mention') confidence -= 0.12;
  if (direction === 'outbound' || direction === 'internal') confidence -= 0.25;
  confidence = clamp(confidence, 0.05, 0.98);
  return {
    confidence,
    tier: confidence >= 0.82 ? 'high' : confidence >= 0.55 ? 'medium' : 'low',
    provisional: confidence < 0.82,
  };
}

function confidenceTierFor(confidence: number): ConfidenceTier {
  return confidence >= 0.82 ? 'high' : confidence >= 0.55 ? 'medium' : 'low';
}

function prospectClassifierModel(env: Env, input?: ProspectClassifierInput): string {
  const isListEntry = Boolean((input?.prefilterHints as any)?.mention?.parse_dealflow_list);
  if (isListEntry && env.PROSPECT_LIST_CLASSIFIER_MODEL) return env.PROSPECT_LIST_CLASSIFIER_MODEL;
  return env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || PROSPECT_CLASSIFIER_DEFAULT_MODEL;
}

function prospectReasoningJudgeModel(env: Env): string {
  return env.PROSPECT_REASONING_JUDGE_MODEL || env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || PROSPECT_CLASSIFIER_DEFAULT_MODEL;
}

function prospectFinalQualityGateModel(env: Env): string {
  return env.PROSPECT_FINAL_QUALITY_MODEL || prospectReasoningJudgeModel(env);
}

export function prospectClassifierBudgetUpstreams(env: Env): string[] {
  const models = [
    env.PROSPECT_CLASSIFIER_MODEL,
    env.PROSPECT_LIST_CLASSIFIER_MODEL,
    env.PROSPECT_ORG_EXTRACTOR_MODEL,
    env.PROSPECT_REASONING_JUDGE_MODEL,
    env.PROSPECT_FINAL_QUALITY_MODEL,
    env.MARTY_LAB_HAIKU_MODEL,
    PROSPECT_CLASSIFIER_DEFAULT_MODEL,
  ].filter(Boolean) as string[];
  return [...new Set(['claude', ...models.map(model => budgetUpstreamForClaudeModel(model))])];
}

const prospectPromptPrewarmKeys = new Set<string>();

function shouldPrewarmProspectPromptCache(env: Env): boolean {
  return String(env.PROSPECT_PREWARM_PROMPT_CACHE || '').toLowerCase() === 'true';
}

function compactClassifierText(value: string | undefined, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sourceTextForClassifierCache(item: ClassifiedItem): string {
  return normalizeWhitespace([
    item.subject || '',
    item.fromEmail || '',
    item.fromName || '',
    item.bodyText || '',
    item.text || '',
    item.bodyPreview || '',
  ].filter(Boolean).join('\n'));
}

function isMissingClassifierCacheTableError(error: unknown): boolean {
  return /prospect_classifier_cache|no such table|D1_ERROR/i.test(error instanceof Error ? error.message : String(error || ''));
}

function isMissingProspectLlmCacheTableError(error: unknown): boolean {
  return /prospect_llm_cache|no such table|D1_ERROR/i.test(error instanceof Error ? error.message : String(error || ''));
}

async function readD1ProspectClassifierCache(env: Env, cacheKey: string): Promise<ProspectClassifierCacheValue | null> {
  try {
    const row = await env.D1.prepare(
      `SELECT value_json
         FROM prospect_classifier_cache
        WHERE cache_key = ?
          AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        LIMIT 1`
    ).bind(cacheKey).first<{ value_json: string }>();
    if (!row?.value_json) return null;
    return JSON.parse(row.value_json) as ProspectClassifierCacheValue;
  } catch (error) {
    if (isMissingClassifierCacheTableError(error)) return null;
    throw error;
  }
}

async function writeD1ProspectClassifierCache(env: Env, value: ProspectClassifierCacheValue): Promise<void> {
  try {
    await env.D1.prepare(
      `INSERT INTO prospect_classifier_cache (
         cache_key, org_id, source_type, source_id, classifier_version, model,
         source_hash, candidate_hash, context_hash, value_json, usage_json,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
       ON CONFLICT(cache_key) DO UPDATE SET
         value_json = excluded.value_json,
         usage_json = excluded.usage_json,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         expires_at = NULL`
    ).bind(
      value.cache_key,
      value.org_id,
      value.source_type,
      value.source_id,
      value.version,
      value.model,
      value.source_hash,
      value.candidate_hash,
      value.context_hash,
      JSON.stringify(value),
      JSON.stringify(value.usage || null)
    ).run();
  } catch (error) {
    if (isMissingClassifierCacheTableError(error)) return;
    throw error;
  }
}

async function prospectLlmCacheKey(input: {
  orgId: string;
  stage: string;
  promptVersion: string;
  model: string;
  source: unknown;
  candidate?: unknown;
  context?: unknown;
  decision?: unknown;
}): Promise<{
  cacheKey: string;
  sourceHash: string;
  candidateHash: string;
  contextHash: string;
  decisionHash: string | null;
}> {
  const sourceHash = await sha256Hex(stableJson(input.source || null));
  const candidateHash = await sha256Hex(stableJson(input.candidate || null));
  const contextHash = await sha256Hex(stableJson(input.context || null));
  const decisionHash = input.decision == null ? null : await sha256Hex(stableJson(input.decision));
  const cacheKey = await sha256Hex(stableJson({
    org_id: input.orgId,
    stage: input.stage,
    prompt_version: input.promptVersion,
    model: input.model,
    source_hash: sourceHash,
    candidate_hash: candidateHash,
    context_hash: contextHash,
    decision_hash: decisionHash,
  }));
  return { cacheKey, sourceHash, candidateHash, contextHash, decisionHash };
}

async function readD1ProspectLlmCache<T>(env: Env, cacheKey: string): Promise<ProspectLlmCacheValue<T> | null> {
  try {
    const row = await env.D1.prepare(
      `SELECT value_json, usage_json
         FROM prospect_llm_cache
        WHERE cache_key = ?
          AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        LIMIT 1`
    ).bind(cacheKey).first<{ value_json: string; usage_json: string | null }>();
    if (!row?.value_json) return null;
    return JSON.parse(row.value_json) as ProspectLlmCacheValue<T>;
  } catch (error) {
    if (isMissingProspectLlmCacheTableError(error)) return null;
    throw error;
  }
}

async function writeD1ProspectLlmCache<T>(env: Env, value: ProspectLlmCacheValue<T>): Promise<void> {
  try {
    await env.D1.prepare(
      `INSERT INTO prospect_llm_cache (
         cache_key, org_id, stage, prompt_version, model,
         source_hash, candidate_hash, context_hash, decision_hash,
         value_json, usage_json, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
       ON CONFLICT(cache_key) DO UPDATE SET
         value_json = excluded.value_json,
         usage_json = excluded.usage_json,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         expires_at = NULL`
    ).bind(
      value.cache_key,
      value.org_id,
      value.stage,
      value.prompt_version,
      value.model,
      value.source_hash,
      value.candidate_hash,
      value.context_hash,
      value.decision_hash || null,
      JSON.stringify(value),
      JSON.stringify(value.usage || null)
    ).run();
  } catch (error) {
    if (isMissingProspectLlmCacheTableError(error)) return;
    throw error;
  }
}

function isFatalClaudeClassifierError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /CLAUDE_MONTHLY_QUOTA_EXHAUSTED/i.test(message) || isClaudeHardQuotaErrorMessage(message);
}

function parseDirection(value: unknown): Direction {
  const v = String(value || '').trim().toLowerCase();
  if (PROSPECT_DIRECTION_SET.has(v)) return v as Direction;
  throw new Error(`INVALID_LLM_DIRECTION:${v || 'empty'}`);
}

function parseMentionType(value: unknown): MentionType {
  const v = String(value || '').trim().toLowerCase();
  if (PROSPECT_MENTION_TYPE_SET.has(v)) return v as MentionType;
  throw new Error(`INVALID_LLM_MENTION_TYPE:${v || 'empty'}`);
}

function parseNullableClassifierString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = normalizeWhitespace(value);
  if (!text || /^null$/i.test(text)) return null;
  return text.slice(0, 180);
}

function actionFromLegacyFields(mentionType: MentionType, legacySignalDisposition: unknown): ProspectAction {
  const disposition = String(legacySignalDisposition || '').trim().toLowerCase();
  if (disposition === 'create_prospect') return 'create_prospect';
  if (disposition === 'attach_known_deal' || disposition === 'attach_existing_deal') return 'record_context';
  if (disposition === 'relationship_signal' || disposition === 'meeting_signal') return 'record_context';
  if (disposition === 'admin_noise' || disposition === 'news_only' || disposition === 'web_analytics') return 'ignore';
  if (mentionType === 'inbound_prospect') return 'create_prospect';
  if (mentionType === 'known_deal') return 'record_context';
  if (mentionType === 'intro_source') return 'record_context';
  return 'ignore';
}

function parseProspectAction(value: unknown, mentionType: MentionType, legacySignalDisposition?: unknown): ProspectAction {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return actionFromLegacyFields(mentionType, legacySignalDisposition);
  if (v === 'attach_existing_deal' || v === 'attach_known_deal') return 'record_context';
  if (PROSPECT_ACTION_SET.has(v)) return v as ProspectAction;
  throw new Error(`INVALID_LLM_PROSPECT_ACTION:${v}`);
}

function mentionTypeForAction(action: ProspectAction): MentionType {
  if (action === 'create_prospect') return 'inbound_prospect';
  if (action === 'attach_existing_deal') return 'known_deal';
  return 'noise';
}

const VETO_LINK_OR_ADMIN_NAMES = new Set([
  'googlemeet',
  'meetinglink',
  'joinwithgooglemeet',
  'joinby',
  'joinbyphone',
  'videocall',
  'conferencecall',
  'calendarinvite',
]);

const VETO_TOOL_OR_LINK_HOSTS = new Set([
  'vimeo',
  'docsend',
  'google',
  'microsoft',
  'microsoftteams',
  'teams',
  'zoom',
  'slack',
  'calendly',
  'docusign',
  'dropbox',
  'box',
  'read',
  'readai',
]);

const VETO_GOVERNMENT_OR_BUYER_ENTITIES = new Set([
  'army',
  'usarmy',
  'airforceresearchlab',
  'unitedstatesarmy',
  'dod',
  'departmentofdefense',
  'southcom',
  'ussouthcom',
  'navy',
  'usnavy',
  'airforce',
  'usairforce',
  'spaceforce',
  'marines',
  'usmarines',
  'nasa',
  'nist',
  'cern',
  'montanastateuniversity',
  'millerschoolofmedicine',
]);

const VETO_SERVICE_PROVIDER_NAMES = new Set([
  'cjwquantum',
  'cjwquantumconsulting',
  'deloitte',
  'finalis',
  'finalissecurities',
  'ksdt',
  'lazard',
  'sheehanfinance',
  'woodyravine',
  'orrick',
  'greenbergtraurig',
  'gtlaw',
  'goodkindandflorio',
  'goodkindflorio',
]);

const VETO_PARTNER_CHANNEL_NAMES = new Set([
  'emerge',
  'emergeamericas',
  'emergeamericaspartners',
  'emergeamericaspartnersllc',
]);

const VETO_MAJOR_CUSTOMER_OR_BUYER_NAMES = new Set([
  'carahsoft',
  'ibm',
  'jpmorganchase',
]);

const VETO_FUND_OR_LP_NAMES = new Set([
  'bldholdings',
  'frontporch',
  'quantonation',
]);

const VETO_WEAK_KNOWN_DEAL_ATTACH_NAMES = new Set([
  'cantos',
  'lightsync',
  'maestro',
  'mergeit',
  'spookstock',
  'terramarc',
]);

const VETO_SINGLE_PERSON_NAMES = new Set([
  'apollo',
  'bea',
  'patrick',
  'lloyd',
  'craig',
  'manny',
  'raul',
  'chuck',
]);

function currentCompanyPattern(company: string): string | null {
  const compactCompany = normalizeWhitespace(company);
  if (!compactCompany) return null;
  return escapeRegExp(compactCompany)
    .replace(/\s+/g, '\\s+')
    .replace(/Venture\\s\+Capital/gi, '(?:Venture\\s+Capital|VC)');
}

function hasDifferentActualTarget(context: string, currentNormalizedName: string): boolean {
  if (!currentNormalizedName) return false;
  const targetPatterns = [
    /\b(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?)\s+(?:is|was|appears to be|seems to be|:)\s+([A-Za-z0-9&.'’ -]{2,80})/i,
    /\bactual\s+target\s+company\s+(?:is|was|appears to be|seems to be|:)\s+([A-Za-z0-9&.'’ -]{2,80})/i,
    /\bactual\s+company\s+being\s+pitched\s+(?:is|was|appears to be|seems to be|:)\s+([A-Za-z0-9&.'’ -]{2,80})/i,
    /\b([A-Za-z0-9&.'’ -]{2,80})\s+(?:is|was|appears to be|seems to be)\s+(?:the\s+)?(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?)/i,
  ];
  for (const pattern of targetPatterns) {
    const match = context.match(pattern);
    if (!match?.[1]) continue;
    const target = normalizeWhitespace(match[1])
      .replace(/[.;:,].*$/g, '')
      .replace(/\s+\b(?:not|rather|instead|while|but|because|with|for|as|and|that|which)\b.*$/i, '')
      .trim();
    const targetNormalized = normalizeProspectName(target);
    if (
      targetNormalized &&
      targetNormalized !== currentNormalizedName &&
      !targetNormalized.includes(currentNormalizedName) &&
      !currentNormalizedName.includes(targetNormalized)
    ) {
      return true;
    }
  }
  return false;
}

function classifierReasoningSaysMentionIsNotTarget(reasoning: string | null | undefined, company: string): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text) return false;
  const normalized = normalizeProspectName(company);
  const mentionsCompany = sourceMentionsName(text, company) ||
    (normalized ? new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i').test(normalizeProspectName(text)) : false);
  if (!mentionsCompany) return false;
  if (hasDifferentActualTarget(text, normalized)) return true;
  if (/\b(?:known|existing)\s+(?:open\s+)?deal\b/i.test(text)) return true;
  return new RegExp([
    String.raw`\b(?:not|isn['’]?t|is\s+not|are\s+not)\s+(?:itself\s+)?(?:the\s+|a\s+|an\s+)?(?:actual\s+|real\s+)?(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched|company\s+being\s+presented|deal\s+company|company\s+name)\b`,
    String.raw`\bnot\s+as\s+(?:the\s+|a\s+|an\s+)?(?:actual\s+|real\s+)?(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched)\b`,
    String.raw`\b(?:not|isn['’]?t|is\s+not|are\s+not)\s+(?:being\s+)?(?:pitched|presented|introduced|shared)\s+as\s+(?:a\s+|an\s+)?(?:investment\s+)?(?:opportunity|prospect|target)\b`,
    String.raw`\bnot\s+(?:presenting|pitching|introducing|sharing)\b[^.]{0,120}\bas\s+(?:a\s+|an\s+)?(?:investment\s+)?(?:opportunity|prospect|target)\b`,
    String.raw`\b(?:not|isn['’]?t|is\s+not|are\s+not)\s+(?:a\s+|an\s+)?(?:pitch|investment\s+pitch)\s+of\b[^.]{0,120}\b(?:itself\s+)?as\s+(?:a\s+|an\s+)?(?:investment\s+)?(?:opportunity|prospect|target)\b`,
    String.raw`\b(?:not|isn['’]?t|is\s+not|are\s+not)\s+(?:a\s+)?(?:startup|venture\s+prospect|new\s+prospect|deal\s+target)\b`,
    String.raw`\b(?:is|was|appears\s+to\s+be)\s+(?:a\s+|an\s+)?(?:person\s+name|person|follow[-\s]?up\s+phrase|section|heading|source|advisor|adviser|intermediary|messenger|facilitator|broker|backer|investor|customer|participant|attendee|program|channel)\b`,
    String.raw`\b(?:is|was)\s+(?:the\s+)?(?:intermediary|advisor|adviser|messenger|facilitator|source|broker)\b[^.]{0,180}\b(?:actual|real)\s+(?:capital[-\s]?raise\s+)?(?:target|prospect|opportunity|company)\b`,
    String.raw`\b(?:backer|investor|strategic\s+investor|existing\s+investor|fund|vc|family\s+office|bank|investment\s+bank|advisor|adviser|intermediary|intro\s+source|source|dealmaker|channel|partner|customer|buyer|design\s+partner|participant|attendee|guest\s+speaker|speaker|sponsor|organizer|event\s+host|program|government\s+agency|commercial\s+partner|employer|prior\s+employer|affiliation)\b[^.]{0,180}\b(?:not|rather\s+than|instead\s+of)\b[^.]{0,140}\b(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched)\b`,
    String.raw`\b(?:not|rather\s+than|instead\s+of)\b[^.]{0,160}\b(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched)\b[^.]{0,180}\b(?:backer|investor|fund|advisor|intermediary|intro\s+source|source|channel|partner|customer|buyer|participant|attendee|sponsor|organizer|event\s+host|program|government\s+agency|employer|affiliation)\b`,
    String.raw`\b(?:mention|entity|name)\s+(?:field\s+)?(?:is|was|appears\s+to\s+be)\s+(?:a\s+)?(?:person|follow[-\s]?up\s+phrase|section|heading|source|advisor|backer|investor|customer|participant|attendee|program|channel)\b`,
  ].join('|'), 'i').test(text);
}

function classifierReasoningHasHardNegativeRole(reasoning: string | null | undefined): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text) return false;
  return /\b(?:known\s+(?:open\s+)?deal|known\s+deal\s+company|known\s+portfolio\/deal\s+company|known\s+crm\s+company\b[^.]{0,160}\b(?:attach|outbound|customer|partner|existing|known)|matched[_\s-]*open[_\s-]*deal[_\s-]*id|attach\s+to\s+existing\s+deal|known\s+(?:current\s+)?portfolio\s+company|current\s+portfolio\s+company|existing\s+(?:open\s+)?deal|portfolio\s+company)\b/i.test(text) ||
    /\b(?:administrative|admin|billing|invoice|regulatory|operational)\b[^.]{0,120}\b(?:noise|artifact|context|notification|confirmation|only)\b/i.test(text) ||
    /\b(?:historical|prior)\b[^.]{0,140}\b(?:reference|exit|co[-\s]?investment|investment|relationship|background)\b/i.test(text) ||
    /\b(?:internal\s+(?:fund\s+)?discussion|internal\s+(?:division|team)|no\s+company\s+being\s+pitched|no\s+company\s+or\s+investment\s+opportunity)\b/i.test(text) ||
    /\b(?:generic\s+domain\s+fragment|partial\s+name\s+fragment|malformed\s+mention|malformed\s+duplicate|formatting\s+error|document[-\s]?share\s+title\s+artifact|document\s+title\s+artifact|title\s+fragment|subject\s+fragment|date\s+prefix(?:\s+['’]?\d{4}['’]?)?\s+with\s+company\s+name|date\s+prefix\s+artifact|vague\s+phrase)\b/i.test(text) ||
    /\b(?:duplicate\/variant|duplicate\s+or\s+variant|same\s+company\s+as\s+mention|already\s+classified\s+as|not\s+a\s+distinct\s+company|not\s+a\s+distinct\s+company\s+mention|not\s+a\s+separate\s+(?:investment\s+)?target|not\s+separate\s+investment\s+target)\b/i.test(text) ||
    /\b(?:source\s+firm|investment\s+banker|lender|financing\s+provider|advisor|intermediary|broker|source\/broker)\b[^.]{0,180}\b(?:not|rather\s+than)\b[^.]{0,140}\b(?:target|investment\s+target|borrower|company|opportunity)\b/i.test(text) ||
    /\b(?:intermediary|advisor|adviser|messenger|facilitator|source|broker)\b[^.]{0,180}\b(?:actual|real)\s+(?:capital[-\s]?raise\s+)?(?:target|prospect|opportunity|company)\b/i.test(text) ||
    /\bnot\b[^.]{0,80}\bas\s+(?:the\s+|an?\s+)?(?:investment\s+)?target\b/i.test(text) ||
    /\b(?:appears|is|was)\s+(?:as\s+)?(?:relationship\/context|relationship\s+context|context\/relationship|context\s+entity|context\s+only|educational\s+context|resume\s+education|service\/product\s+component|technology\/protocol|standards\/governance\s+body)\b/i.test(text) ||
    /\b(?:technology\/protocol|protocol|component|underlying\s+(?:technology|protocol|infrastructure))\b[^.]{0,180}\bnot\b[^.]{0,140}\b(?:independent|standalone|investment)\s+(?:target|opportunity|prospect)\b/i.test(text) ||
    /\b(?:context\s+for|context\s+around|appears\s+in\s+subject\s+line\s+as\s+context|context\/relationship\s+entity)\b[^.]{0,160}\bnot\b[^.]{0,120}\b(?:primary\s+)?(?:investment\s+)?target\b/i.test(text) ||
    /\b(?:tax\s+authority|university|business\s+school|secondary\s+school|school\s+listed|individual\s+advisor|individual\s+expert|person\s+not\s+a\s+company|public\s+market\s+news|public\s+financing\s+news|newsletter\/public\s+financing\s+news|macro\s+strategy\s+firm|research\s+firm)\b/i.test(text) ||
    /\b(?:real[-\s]?estate|hospitality|golf\s+course|venue|asset|acquisition\s+target\/asset)\b[^.]{0,180}\bnot\b[^.]{0,140}\b(?:software|tech|fund(?:'s)?\s+investment|investment\s+opportunity|prospect)\b/i.test(text) ||
    /\boutside\s+(?:the\s+)?fund\s+scope\b/i.test(text) ||
    /\bnot\s+(?:a\s+|an\s+)?(?:startup|company\s+prospect|investment\s+prospect|current\s+prospect|current\s+deal|private\s+dealflow|investment\s+target)\b/i.test(text);
}

function cleanCorrectedTargetName(value: string | null | undefined): string | null {
  const cleaned = normalizeWhitespace(value || '')
    .replace(/^["'“”‘’]+|["'“”‘’.,;:]+$/g, '')
    .replace(/["'“”‘’]\s+per\b[\s\S]*$/i, '')
    .replace(/\s+per\s+(?:prospect[_\s-]*company[_\s-]*name|(?:the\s+)?(?:field|metadata|deterministic|canonical|known)\b)[\s\S]*$/i, '')
    .replace(/^(?:confidential|private)\s+/i, '')
    .replace(/\s+(?:series\s+[a-c]|seed|pre[-\s]?seed)\b[\s\S]*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:k|m|mm|bn|b|vc)\b[\s\S]*$/i, '')
    .replace(/\s+i\s+lead\b[\s\S]*$/i, '')
    .replace(/\s+(?:as|with|and|for|via|from)\b[\s\S]*$/i, '')
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return null;
  if (isGenericFragmentCandidate(cleaned) || isStandaloneDocumentHeading(cleaned) || isMarkupArtifactCandidate(cleaned)) return null;
  if (/^(?:investor|pitch|teaser|deck|memo|summary|presentation|document|materials?|opportunity)$/i.test(cleaned)) return null;
  if (looksLikePersonName(cleaned) || looksLikePersonOrParticipantBundle(cleaned)) return null;
  if (!/[A-Za-z]/.test(cleaned)) return null;
  return canonicalizeMention(cleaned).canonicalName;
}

function cleanSourceTitleTargetName(value: string | null | undefined): string | null {
  const cleaned = cleanCorrectedTargetName(value);
  if (cleaned) return cleaned;
  const raw = normalizeWhitespace(value || '').replace(/^["'“”‘’]+|["'“”‘’.,;:]+$/g, '');
  if (/^[A-Z0-9]{2,8}$/.test(raw)) return canonicalizeMention(raw).canonicalName;
  return null;
}

function sourceTitleTargetName(title: string | null | undefined): string | null {
  const explicitTitle = normalizeWhitespace(title || '')
    .replace(/^(?:document|file|source|subject)\s*:\s*/i, '')
    .replace(/^(?:meeting\s+summary|call\s+summary|transcript\s+summary)\s*:\s*/i, '')
    .replace(/\.[A-Za-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ');
  const medinaPairTarget = cleanSourceTitleTargetName(
    explicitTitle.match(/^([A-Z0-9][A-Za-z0-9.'’ -]{1,60}?)\s*(?:&|and|x|<>|<->|↔|\/|\/\/)\s*Medina\b/i)?.[1]
  );
  if (medinaPairTarget) return medinaPairTarget;
  const explicitSubject = explicitTitle.match(/\b(?:co[-\s]?investment\s+opportunity|investment\s+opportunity|investment\s+request|investment\s+summary|investment\s+memo|pitch\s+deck|investor\s+deck|teaser)\s*\|\s*([A-Z][A-Za-z0-9&.'’ -]{2,80})/i);
  const subjectTarget = cleanCorrectedTargetName(explicitSubject?.[1]);
  if (subjectTarget) return subjectTarget;
  const colonOpportunity = explicitTitle.match(/\b(?:co[-\s]?investment\s+opportunity|investment\s+opportunity|opportunity|deal\s+flow)\s*:\s*([A-Z][A-Za-z0-9&.'’ -]{2,80}?)(?:\s+(?:series\s+[a-c]|seed|pre[-\s]?seed|round|confidential|deck|memo|teaser|opportunity)\b|$)/i);
  const colonOpportunityTarget = cleanCorrectedTargetName(colonOpportunity?.[1]);
  if (colonOpportunityTarget) return colonOpportunityTarget;
  const introTarget = explicitTitle.match(/\b(?:intro|introduction|connecting(?:\s+w\/)?|meeting)\s*:\s*([A-Z][A-Za-z0-9&.'’ -]{2,60}?)\s*(?:x|<>|<->|↔|and|\/|\/\/)\s*Medina\b/i) ||
    explicitTitle.match(/\b(?:meeting|intro|connecting(?:\s+w\/)?)\s+([A-Z][A-Za-z0-9&.'’ -]{2,60}?)\s*(?:x|<>|<->|↔|and|\/|\/\/)\s*Medina\b/i);
  const introCleanTarget = cleanCorrectedTargetName(introTarget?.[1]);
  if (introCleanTarget) return introCleanTarget;
  const intermediaryTeaser = explicitTitle.match(/^[A-Z][A-Za-z0-9&.'’ -]{2,80}\s+-\s+([A-Z][A-Za-z0-9&.'’ -]{2,80}?)\s+(?:teaser|pitch|deck|cim|memo|investor)\b/i);
  const teaserTarget = cleanCorrectedTargetName(intermediaryTeaser?.[1]);
  if (teaserTarget) return teaserTarget;
  const datedRoundMaterial = explicitTitle.match(/^([A-Z][A-Za-z0-9&.'’ -]{2,80}?)\s*[-–—]\s*(?:q[1-4]\s*)?20\d{2}[^A-Za-z0-9]{0,6}(?:seed|pre[-\s]?seed|series\s+[abc]|investor|deck|memo|overview)\b/i);
  const datedRoundTarget = cleanCorrectedTargetName(datedRoundMaterial?.[1]);
  if (datedRoundTarget) return datedRoundTarget;
  const cleanTitle = explicitTitle.replace(/-/g, ' ');
  const dashedFinancingTarget = explicitTitle.match(/^([A-Z0-9][A-Za-z0-9&.'’ .-]{1,80}?)\s*[-–—]\s*(?:series\s+[a-c]|seed|pre[-\s]?seed|safe|financing|fundrais(?:e|ing)|round|investment|investor|documents?|materials?)\b/i);
  const dashedFinancingCleanTarget = cleanCorrectedTargetName(dashedFinancingTarget?.[1]);
  if (dashedFinancingCleanTarget) return dashedFinancingCleanTarget;
  const leadingDocumentWrapper = cleanTitle.match(/^([A-Z0-9][A-Za-z0-9&.'’ -]{1,60}?)\s+(?:bridge\s+summary|ai\s+analysis|investment\s+analysis|diligence\s+analysis|confidentiality\s+(?:and|&)\s+nda|nda|confidentiality)\b/i);
  const leadingDocumentWrapperTarget = cleanSourceTitleTargetName(leadingDocumentWrapper?.[1]);
  if (leadingDocumentWrapperTarget) return leadingDocumentWrapperTarget;
  const leadingStageMaterial = cleanTitle.match(/^([A-Z0-9][A-Za-z0-9&.'’ -]{1,60}?)\s+(?:seed|pre[-\s]?seed|series\s+[a-c]|pipe)\b/i);
  const stageMaterialTarget = cleanCorrectedTargetName(leadingStageMaterial?.[1]);
  if (stageMaterialTarget) return stageMaterialTarget;
  const leadingInvestorMaterial = cleanTitle.match(/^([A-Z0-9][A-Za-z0-9&.'’ -]{1,60}?)\s+(?:(?:investors?|investor)\s+(?:overview|read\s+ahead|presentation|deck|pitch\s+deck)|read\s+ahead|company\s+overview|(?:company\s+)?(?:one|1|two|2)\s+pager)\b/i);
  const investorMaterialTarget = cleanCorrectedTargetName(leadingInvestorMaterial?.[1]);
  if (investorMaterialTarget) return investorMaterialTarget;
  const leadingDeck = cleanTitle.match(/^([A-Z0-9][A-Za-z0-9&.'’ -]{1,60}?)\s+(?:investor|pitch|investment|teaser|deck|memo|materials?)\b/i);
  return cleanCorrectedTargetName(leadingDeck?.[1]);
}

function sourceInvestorUpdateTitleTargetName(title: string | null | undefined, context: string): string | null {
  const cleanTitle = normalizeWhitespace(title || '')
    .replace(/^(?:re|fw|fwd)\s*:\s*/i, '')
    .replace(/\.[A-Za-z0-9]{2,5}$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  if (!cleanTitle) return null;
  const match = cleanTitle.match(/^([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:investor|financing|shareholder|lender|portfolio)\s+(?:update|report|letter|memo|communication)s?(?:\s*#?\d+)?(?:\s*[-–—].*)?$/i);
  const candidate = cleanCorrectedTargetName(match?.[1]);
  if (!candidate) return null;
  const support = normalizeWhitespace(String(context || '').replace(cleanTitle, ' '));
  if (!/\b(?:investor\s+(?:update|report|letter|memo|communication)|financing\s+(?:update|report|memo)|shareholder\s+(?:letter|update)|portfolio\s+update|fundrais(?:e|ing)|raising|round|seed|series\s+[abc]|safe|valuation|runway|revenue|arr|mrr|traction|customers?|pipeline|diligence|capital)\b/i.test(support)) {
    return null;
  }
  return candidate;
}

function sourceTitleTargetNameForOrgExtraction(item: ClassifiedItem, cleanedText: string): string | null {
  return sourceTitleTargetName(item.subject) ||
    sourceInvestorUpdateTitleTargetName(item.subject, cleanedText) ||
    sourceTitleTargetName(item.metadata?.entity_name);
}

function correctedProspectCompanyNameFromEvidence(
  currentCompanyName: string,
  proposedCompanyName: string | null | undefined,
  classifierInput: ProspectClassifierInput,
  reasoning: string | null | undefined
): string | null {
  if (proposedCompanyName && normalizeProspectName(proposedCompanyName) !== normalizeProspectName(currentCompanyName)) {
    const text = normalizeWhitespace(`${classifierInput.senderAndContext}\n${classifierInput.rawExcerpt}\n${reasoning || ''}`);
    const currentTarget = cleanCorrectedTargetName(currentCompanyName);
    if (
      currentTarget &&
      finalQualityNameLooksLikeSourceOrIntermediary(proposedCompanyName) &&
      sourceMentionsName(text, currentTarget) &&
      finalQualityTargetHasInvestmentEvidence(text, currentTarget)
    ) {
      return currentTarget;
    }
    return cleanCorrectedTargetName(proposedCompanyName);
  }
  const currentNormalized = normalizeProspectName(currentCompanyName);
  const text = normalizeWhitespace(`${classifierInput.senderAndContext}\n${classifierInput.rawExcerpt}\n${reasoning || ''}`);
  if (finalQualityNameLooksLikeSourceOrIntermediary(currentCompanyName) || finalQualityNameLooksLikeSourceOrIntermediary(proposedCompanyName)) {
    for (const targetName of finalQualityReasoningTargetCandidates(text)) {
      const normalizedTarget = normalizeProspectName(targetName);
      if (!normalizedTarget || normalizedTarget === currentNormalized) continue;
      if (sourceMentionsName(text, targetName) && finalQualityTargetHasInvestmentEvidence(text, targetName)) {
        return targetName;
      }
    }
  }
  const titleTarget = sourceTitleTargetName(classifierInput.senderAndContext) || sourceTitleTargetName(classifierInput.rawExcerpt);
  const isWrapperOrGeneric =
    !currentNormalized ||
    currentNormalized.length <= 5 ||
    GENERIC_FRAGMENT_NAMES.has(currentNormalized) ||
    /\b(?:mobile|aircraft|startup|platform|company|document|deck|materials?|opportunity|investment|coinvestment|co[-\s]?investment)\b/i.test(currentCompanyName) ||
    /[:|]/.test(currentCompanyName);
  if (titleTarget && (isWrapperOrGeneric || !sourceMentionsName(currentCompanyName, titleTarget))) {
    return titleTarget;
  }
  const patterns = [
    /\b(?:investor|pitch|investment)\s+deck\s+for\s+([A-Z][A-Za-z0-9&.'’ -]{2,80})(?:,|\s+(?:an?|the|with|is)\b)/i,
    /\b(?:target|actual)\s+company\s+(?:is|was|:)\s+([A-Z][A-Za-z0-9&.'’ -]{2,80})/i,
    /\b(?:actual|real)\s+(?:investment\s+)?target\s+(?:is|was|:)\s+([A-Z][A-Za-z0-9&.'’ -]{2,80})/i,
    /\b(?:presenting|presents|sharing|pitching)\s+([A-Z][A-Za-z0-9&.'’ -]{2,80})\s+as\s+(?:an?\s+)?(?:co[-\s]?)?investment\s+opportunity/i,
  ];
  for (const pattern of patterns) {
    const candidate = cleanCorrectedTargetName(text.match(pattern)?.[1]);
    if (!candidate || normalizeProspectName(candidate) === currentNormalized) continue;
    if (isWrapperOrGeneric || /\b(?:not\s+the\s+(?:sender|broker|source|intermediary)|target\s+company|actual\s+target|deck\s+for)\b/i.test(text)) {
      return candidate;
    }
  }
  return null;
}

function cleanPotentialCompanyName(raw: string): string {
  return normalizeWhitespace(raw)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\b(?:Company\s+URL|Website|URL|Founder(?:s|\(s\))?|Short\s+Description|Location|Industry|Round\s+Stage|Contact|Email)\b.*$/i, '')
    .replace(/\s+(?:is|was|has|have|with|and|but|while|because|that|which|who|from|by|for|as)\b.*$/i, '')
    .replace(/[.;:,]+$/g, '')
    .trim();
}

function companyNamesEquivalent(left: string, right: string): boolean {
  const a = normalizeProspectName(left);
  const b = normalizeProspectName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function collectPrimaryTargetNames(context: string): string[] {
  const text = String(context || '');
  const candidates: string[] = [];
  const push = (raw: string | undefined): void => {
    const clean = cleanPotentialCompanyName(raw || '');
    if (!clean || clean.length < 3 || clean.length > 90) return;
    if (isGenericCandidate(clean) || isOwnFundEntity(clean) || looksLikePersonName(clean) || looksLikePersonOrParticipantBundle(clean)) return;
    if (!/[A-Za-z]/.test(clean)) return;
    const normalized = normalizeProspectName(clean);
    if (!normalized || candidates.some(existing => companyNamesEquivalent(existing, clean))) return;
    candidates.push(clean);
  };

  const patterns = [
    /\b(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?|opportunity)\s+(?:is|was|appears to be|seems to be|:)\s+["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})/gi,
    /\b["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})["”]?\s+(?:is|was|appears to be|seems to be)\s+(?:the\s+)?(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?|opportunity)\b/gi,
    /\b["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})["”]?\s+is\s+being\s+(?:actively\s+)?(?:introduced|presented|pitched|shared|sent)\s+(?:to\s+\w+\s+)?(?:as|for|by)\s+(?:an?\s+)?(?:investment\s+)?(?:opportunity|prospect|deal|target)\b/gi,
    /\b(?:investment\s+)?(?:opportunity|prospect|target)\s+(?:here\s+)?(?:is|was|should be)\s+["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})/gi,
    /\b(?:customer|buyer|design\s+partner|channel\s+partner|commercial\s+partner|deployment|validation|standard|regulator|government\s+agency)\s+(?:of|for)\s+["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})/gi,
    /\bMeeting\s+([A-Z0-9][A-Za-z0-9&.'’ -]{2,60})\s+<>\s+Medina\b/g,
    /\blearn\s+more\s+about\s+([A-Z0-9][A-Za-z0-9&.'’ -]{2,60})\b/gi,
    /\b(?:About|Company|Target company)\s+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})(?=\s+(?:is|has|have|helps|offers|builds|develops|developed|provides|raised|raises|will|$))/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) push(match[1]);
  }

  return candidates;
}

function hasDifferentPrimaryTargetEvidence(context: string, currentNormalizedName: string): boolean {
  if (!currentNormalizedName) return false;
  for (const target of collectPrimaryTargetNames(context)) {
    const targetNormalized = normalizeProspectName(target);
    if (
      targetNormalized &&
      targetNormalized !== currentNormalizedName &&
      !targetNormalized.includes(currentNormalizedName) &&
      !currentNormalizedName.includes(targetNormalized)
    ) {
      return true;
    }
  }
  return false;
}

function senderDomainCompanyMatches(context: string, company: string): boolean {
  const companyNormalized = normalizeProspectName(company);
  if (!companyNormalized) return false;
  for (const match of context.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const domain = String(match[1] || '').toLowerCase().replace(/^www\./, '');
    if (!domain || shouldIgnoreDomain(domain)) continue;
    const domainCompany = domainLabelToCompany(domain);
    const domainNormalized = normalizeProspectName(domainCompany);
    if (domainNormalized && (companyNormalized === domainNormalized || companyNormalized.includes(domainNormalized) || domainNormalized.includes(companyNormalized))) {
      return true;
    }
  }
  return false;
}

function hasCurrentCompanyServiceProviderRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    `\\b${companyPattern}\\b\\s+(?:is|was|serves\\s+as|served\\s+as|acting\\s+as|acted\\s+as)\\s+(?:the\\s+)?(?:exclusive\\s+)?(?:financial\\s+advisor|investment\\s+bank(?:er)?|accounting\\s+(?:and\\s+)?advisory\\s+firm|consulting\\s+firm|broker[-\\s]?dealer|placement\\s+agent|legal\\s+counsel|law\\s+firm)\\b`,
    'i'
  ).test(context);
}

function hasCurrentCompanyIntroSourceRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    [
      `\\b(?:introduced|referred|sent|forwarded|shared)\\s+(?:by|from|via)\\s+${companyPattern}\\b`,
      `\\b(?:presented|pitched|shared|sourced|sent|forwarded|introduced)\\s+(?:by|from|via)\\s+${companyPattern}\\b`,
      `\\bby\\s+${companyPattern}\\b[^.\\n]{0,120}\\b(?:intro|source|advisor|broker|banker|presenting|dealmaker|partner)\\b`,
      `\\b${companyPattern}\\b\\s+(?:introduced|referred|sent|forwarded|shared)\\b`,
      `\\b${companyPattern}\\b\\s+(?:is|was)\\s+(?:the\\s+)?(?:intro\\s+source|introducer|referrer|source|channel|dealmaker|sourcing\\s+partner|presenting\\s+firm|firm\\s+presenting|investment\\s+bank(?:er)?|advisor)\\b`,
    ].join('|'),
    'i'
  ).test(context);
}

function hasCurrentCompanyInvestorBackingRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    [
      `\\b(?:backed|funded|financed)\\s+by\\s+[^.\\n]{0,180}\\b${companyPattern}\\b`,
      `\\b(?:led|co[-\\s]?led)\\s+by\\s+[^.\\n]{0,180}\\b${companyPattern}\\b`,
      `\\b(?:investors?|backers?|cap\\s+table)\\s+(?:include|includes|included|including|with)\\s+[^.\\n]{0,180}\\b${companyPattern}\\b`,
    ].join('|'),
    'i'
  ).test(context);
}

function hasCurrentCompanyCustomerPartnerRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    [
      `\\b${companyPattern}\\b[^.\\n]{0,80}\\b(?:is|was|appears\\s+as|mentioned\\s+as)\\s+(?:a\\s+)?(?:customer|buyer|design\\s+partner|channel\\s+partner|commercial\\s+partner|deployment|standard|regulator|government\\s+agency)\\b`,
      `\\b(?:customer|buyer|design\\s+partner|channel\\s+partner|commercial\\s+partner|deployment|validation|standard|regulator|government\\s+agency)\\b[^.\\n]{0,140}\\b${companyPattern}\\b`,
      `\\b(?:pitched|sold|introduced)\\s+(?:to|into)\\s+${companyPattern}\\b`,
    ].join('|'),
    'i'
  ).test(context);
}

function hasCurrentCompanyFundOrLpRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  const normalized = normalizeProspectName(company);
  if (!companyPattern) return false;
  if (VETO_FUND_OR_LP_NAMES.has(normalized)) {
    return true;
  }
  if (/\b(?:medina\s+lp|lp\s+reference|prospective\s+lp|feeder\s+fund|minimum\s+units|fund\s+investor|fundraising\s+update)\b/i.test(context)) {
    return true;
  }
  if (
    /\b(?:venture\s+fund|investment\s+fund|fund\s+of\s+funds|hybrid\s+venture\s+fund|hybrid\s+venture\s+vehicle|feeder\s+fund|investing\s+in\s+funds)\b/i.test(context) &&
    (/\b(?:capital|ventures|fund|holdings|partners)\b/i.test(company) || /(?:capital|ventures|fund|holdings|partners)$/.test(normalized))
  ) {
    return true;
  }
  return new RegExp(`\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:prospective\\s+lp|limited\\s+partner|fund\\s+investor|feeder\\s+fund|investment\\s+fund|venture\\s+fund|hybrid\\s+venture\\s+vehicle|investing\\s+in\\s+funds)\\b`, 'i').test(context);
}

function compactCompanyEvidenceValue(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function currentCompanyEvidencePatterns(company: string): string[] {
  const clean = normalizeWhitespace(company);
  const patterns: string[] = [];
  const push = (source: string): void => {
    if (!source || patterns.includes(source)) return;
    patterns.push(source);
  };
  if (clean) {
    push(escapeRegExp(clean).replace(/(?:\\\s|\\\.)+/g, '[\\s.-]*').replace(/\s+/g, '[\\s.-]*'));
  }
  const compactCompany = compactCompanyEvidenceValue(company);
  const suffix = compactCompany.match(/^([a-z0-9]{3,})(ai|io|co|com|labs|systems|technologies|technology)$/);
  if (suffix?.[1] && suffix[2]) {
    push(`${escapeRegExp(suffix[1])}[\\s.-]*${escapeRegExp(suffix[2])}`);
    if (suffix[2] === 'ai') push(escapeRegExp(suffix[1]));
  }
  const normalizedCompany = normalizeProspectName(company);
  if (normalizedCompany && normalizedCompany !== compactCompany) push(escapeRegExp(normalizedCompany));
  return patterns.filter(pattern => pattern.length >= 4);
}

function hasCurrentCompanyDirectTargetAssertion(context: string, company: string): boolean {
  if (!normalizeProspectName(company)) return false;
  const evidencePatterns = currentCompanyEvidencePatterns(company);
  if (evidencePatterns.length === 0) return false;
  const positiveTargetLanguage = /\b(?:(?:is|was|itself|company)?\s*(?:being\s+)?(?:introduced|pitched|presented|shared|sent)\b[^.\n]{0,140}\b(?:Medina|fund|investment\s+opportunity|inbound\s+prospect|prospect|target|deal)\b|(?:introduced|pitched|presented|shared|sent)\s+to\s+Medina\b|warm\s+intro\b[^.\n]{0,120}\b(?:Medina|deck|pitch|raise|raising|investment\s+opportunity)\b|share\s+what\s+(?:we|they)(?:'|’)?re\s+building|following\s+up\s+(?:on|about)\b[^.\n]{0,120}\b(?:deck|pitch|raise|raising|investment\s+opportunity))\b/i;
  const negativeOrRedirectLanguage =
    /\b(?:not\s+(?:the|an)\s+(?:investment\s+)?(?:target|prospect|company)|not\s+itself|source\s+context|sender\s+context|intro\s+source|reaching\s+out,\s+but|but\s+[A-Z0-9][A-Za-z0-9&.'’ -]{1,80}\s+(?:is|was|appears)|actual\s+(?:company|target|prospect)\s+(?:is|was))\b/i;

  for (const chunk of String(context || '').split(/(?<=[.!?])\s+|\n+/)) {
    const clean = normalizeWhitespace(chunk);
    if (!clean || clean.length > 800) continue;
    if (negativeOrRedirectLanguage.test(clean)) continue;
    for (const pattern of evidencePatterns) {
      const mention = new RegExp(`\\b${pattern}\\b`, 'i').exec(clean);
      if (!mention) continue;
      const afterMention = clean.slice(mention.index, mention.index + 260);
      if (positiveTargetLanguage.test(afterMention)) return true;
    }
  }
  return false;
}

function hasCurrentCompanyInvestmentTargetEvidence(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return hasCurrentCompanyDirectTargetAssertion(context, company);
  const targetLanguage = new RegExp(
    [
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:actual|real)\\s+(?:investment\\s+)?(?:prospect|target|company\\s+being\\s+pitched)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:being\\s+)?(?:pitched|presented|sent|shared)\\s+(?:as|for)\\s+(?:an?\\s+)?(?:investment\\s+)?(?:opportunity|prospect|target)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,220}\\b(?:introduced|warm\\s+intro|pitched|presented)[^.\\n]{0,140}\\b(?:Medina|fund|investment\\s+opportunity|inbound\\s+prospect)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,240}\\b(?:round|term\\s+sheet|investment\\s+memo|co[-\\s]?lead|lead\\s+investment|firm\\s+commitments?|valuation|board\\s+(?:observer|director)|series\\s+[a-z]|raise|raising|fundrais(?:e|ing)|data\\s+room|diligence|financial\\s+model|p&l|nda)\\b`,
      `\\b(?:intro(?:duction)?|meet|meeting|call)\\s+(?:to|with|for)?\\s+[^.\\n]{0,100}\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:raising|fundrais(?:e|ing)|investment\\s+opportunity|data\\s+room|diligence|financial\\s+model|p&l|nda)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:founders?|co[-\\s]?founders?|ceo|team)\\b[^.\\n]{0,160}\\b(?:raising|fundrais(?:e|ing)|investment\\s+opportunity|data\\s+room|diligence|financial\\s+model|p&l|nda)\\b`,
      `\\b(?:mention\\s+itself|company\\s+shown|company\\s+in\\s+question)\\s+[^.\\n]{0,120}\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:pitched|presented|investment\\s+opportunity)\\b`,
    ].join('|'),
    'i'
  );
  return targetLanguage.test(context) || hasCurrentCompanyDirectTargetAssertion(context, company);
}

function hasWeakKnownDealAttachContext(context: string, company: string): boolean {
  const normalized = normalizeProspectName(company);
  if (!VETO_WEAK_KNOWN_DEAL_ATTACH_NAMES.has(normalized)) return false;
  return (
    /\b(?:internal|meeting\s+summary|generated\s+meeting\s+summary|financial\s+diligence|closing\s+coordination|thank\s+you|invitation|event|conference|agenda|portfolio\s+update|relationship\s+context|stale|historical|not\s+a\s+new\s+(?:prospect|investment|deal))\b/i.test(context) ||
    /\b(?:known|existing)\s+(?:portfolio|deal)\s+(?:company|investment|context)\b/i.test(context)
  );
}

function hasCurrentCompanyInvestorParticipantRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  if (!/\b(?:capital|ventures|vc|fund|investors?|partners)\b/i.test(company)) return false;
  return new RegExp(
    `\\b${companyPattern}\\b\\s+(?:is\\s+mentioned\\s+as|was\\s+mentioned\\s+as|is|was|appears\\s+as|appears\\s+to\\s+be|mentioned\\s+as)\\s+(?:a\\s+)?(?:meeting\\s+)?(?:participant|attendee|investor|co[-\\s]?investor|vc|fund|capital\\s+partner)\\b|\\b(?:participant|attendee|investor|co[-\\s]?investor|vc)\\s+(?:at|in|on)\\s+[^.\\n]{0,120}\\b${companyPattern}\\b`,
    'i'
  ).test(context);
}

function hasStrongSourceInvestmentIntent(context: string): boolean {
  if (hasNonInvestmentEventFundraisingContext(context)) return false;
  return /\b(?:deal\s*flow|data\s+room|diligence|financial\s+model|p&l|nda|business\s+plan|term\s+sheet|(?:deal|investment)[-_\s]?pitch|investment\s+(?:memo|request|proposal)|investor\s+(?:deck|presentation)|investor\s+review\s+(?:material|materials|packet|deck|memo|document|one[-\s]?pager|two[-\s]?pager)|raise|raising|fundrais(?:e|ing)|funding\s+round|round|seed|series\s+[abc](?:\s+discussion)?|safe|allocation|valuation|co[-\s]?lead|lead\s+(?:investor|investment)|pitch\s+form|submitted\s+a\s+pitch|website\s+pitch\s+submission|shared\s+as\s+(?:an?\s+)?(?:deal|investment)[-_\s]?pitch|investment\s+(?:opportunit(?:y|ies)|target|prospect|consideration)|being\s+(?:pitched|presented|shared|sent)\s+(?:as|for)\s+(?:an?\s+)?(?:investment\s+)?(?:opportunity|prospect|target|deal))\b/i.test(context);
}

function listFieldEvidenceText(mention: MentionCandidate | null | undefined): string {
  if (!mention?.listFields) return '';
  return [
    mention.listFields.stage,
    mention.listFields.amount,
    mention.listFields.website,
    mention.listFields.poc,
    mention.listFields.problem,
    mention.listFields.approach,
  ].filter(Boolean).join(' ');
}

function candidateEvidenceText(
  sourceText: string,
  reasoning: string | null | undefined,
  mention: MentionCandidate | null | undefined
): string {
  return normalizeWhitespace([
    sourceText,
    mention?.lineText,
    mention?.contextText,
    listFieldEvidenceText(mention),
    reasoning || '',
  ].filter(Boolean).join(' '));
}

function hasCandidateFundraisingListRowEvidence(
  sourceText: string,
  reasoning: string | null | undefined,
  mention: MentionCandidate
): boolean {
  const text = candidateEvidenceText(sourceText, reasoning, mention);
  if (!text || !sourceMentionsName(text, mention.canonicalName)) return false;
  const fields = mention.listFields || {};
  const fieldValues = listFieldEvidenceText(mention);
  const strongFieldCount = [
    fields.stage,
    fields.amount,
    fields.website,
    fields.poc,
    fields.problem,
    fields.approach,
  ].filter(value => normalizeWhitespace(value || '').length > 0).length;
  const hasListFrame = mention.isListEntry ||
    /\b(?:list|table|cohort|packet|pipeline\s+report|dealflow\s+list|road\s*show|roadshow|showcase|company\s+row|companies?\s+fund\s*raising|fund\s*raising\s+companies|fundraising\s+companies|sbir|sttr)\b/i.test(text);
  const hasRowInvestmentLanguage =
    /\b(?:fund\s*raising|fundraising|raising|raise|round|stage|ask|seeking|investment\s+ask|seed|pre[-\s]?seed|series\s+[abc]|safe|valuation|\$\s?\d|\d+(?:\.\d+)?\s*(?:m|mm|million|k)\b)\b/i.test(text) ||
    /\b(?:fund\s*raising|fundraising|raising|raise|round|stage|ask|seed|pre[-\s]?seed|series\s+[abc]|safe|valuation|\$)\b/i.test(fieldValues);
  const hasCompanyDetails = /\b(?:founder|ceo|poc|contact|problem|approach|website|description|product|platform|solution|technology|location|revenue|traction|arr|mrr|bookings|pipeline)\b/i.test(text);
  const rowHasEnoughDetail =
    Boolean(fields.stage || fields.amount) ||
    strongFieldCount >= 2 ||
    hasCompanyDetails && hasRowInvestmentLanguage;
  return hasListFrame && hasRowInvestmentLanguage && rowHasEnoughDetail;
}

function hasStructuredPipelineRowEvidence(context: string, company: string): boolean {
  const text = normalizeWhitespace(context || '');
  const companyPattern = currentCompanyPattern(company);
  if (!text || !companyPattern) return false;
  const tableFrame = /\b(?:pipeline\s+(?:status\s+update|industry\s+pie|tracker|report)|company\s+priority\s+status\s+industry|internal\s+pipeline\s+report|fundraising\s+list|dealflow\s+list|deal\s+flow\s+list|pipeline\s+fields?)\b/i.test(text);
  if (!tableFrame) return false;
  const companyIndex = text.search(new RegExp(`\\b${companyPattern}\\b`, 'i'));
  if (companyIndex < 0) return false;
  const rowWindow = text.slice(Math.max(0, companyIndex - 180), Math.min(text.length, companyIndex + 720));
  const rowHasStatusOrIntent =
    /\b(?:LOW|MEDIUM|HIGH)\b[^.\n]{0,180}\b(?:Radar|Initial\s+Meeting|Preliminary|Diligence|Term\s*Sheet|IC|Active|New)\b/i.test(rowWindow) ||
    /\b(?:assigned\s+to|owner|status|prospect|pipeline|investment\s+opportunit(?:y|ies)|deal\s*flow|reviewing|presented|shared)\b/i.test(rowWindow);
  const rowHasCompanyDetails =
    /\b(?:https?:\/\/|www\.|website|\.ai\b|\.com\b|\.io\b|\.co\b|\.tech\b|location|description|product|platform|solution|technology|founder|ceo|contact|poc|revenue|arr|mrr|bookings|traction|customers?|pipeline)\b/i.test(rowWindow);
  const rowHasInvestmentLanguage =
    /\b(?:raise|raising|fundrais(?:e|ing)|seed|pre[-\s]?seed|series\s+[abc]|safe|term\s*sheet|diligence|initial\s+meeting|radar|\$\s?\d|investment\s+(?:round|opportunit(?:y|ies)|ask)|round|valuation|prospect|pipeline)\b/i.test(rowWindow);
  return rowHasStatusOrIntent && rowHasCompanyDetails && rowHasInvestmentLanguage;
}

function hasStandoutInboundIntroEvidence(context: string, company: string): boolean {
  const text = normalizeWhitespace(context || '');
  const companyPattern = currentCompanyPattern(company);
  if (!text || !companyPattern) return false;
  const candidateWindow = new RegExp(
    `\\b${companyPattern}\\b[\\s\\S]{0,360}\\b(?:Standout\\s+Inbound|unsolicited\\s+feedback|scheduled\\s+intro\\s+call|intro\\s+call\\s+scheduled|active\\s+prospect\\s+engagement)\\b`,
    'i'
  );
  const inboundWindow = new RegExp(
    `\\b(?:Standout\\s+Inbound|unsolicited\\s+feedback|scheduled\\s+intro\\s+call|intro\\s+call\\s+scheduled|active\\s+prospect\\s+engagement)\\b[\\s\\S]{0,360}\\b${companyPattern}\\b`,
    'i'
  );
  return (candidateWindow.test(text) || inboundWindow.test(text)) &&
    /\b(?:Standout\s+Inbound|scheduled\s+intro\s+call|intro\s+call\s+scheduled)\b/i.test(text);
}

function hasProductPitchParentCompanyEvidence(
  sourceText: string,
  reasoning: string | null | undefined,
  company: string
): boolean {
  const source = normalizeWhitespace(sourceText || '');
  const fullText = normalizeWhitespace([sourceText, reasoning || ''].join(' '));
  if (!sourceMentionsName(fullText, company)) return false;
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  const sourceNamesParentProduct =
    new RegExp(`\\b(?:major\\s+investor|board\\s+member|investor|founder|team)\\b[\\s\\S]{0,180}\\b${companyPattern}\\b[\\s\\S]{0,220}\\b(?:invented|built|developed|created|launched|behind)\\b[\\s\\S]{0,120}\\b[A-Z][A-Za-z0-9&.'’/-]+`, 'i').test(source) ||
    new RegExp(`\\b${companyPattern}\\b[\\s\\S]{0,220}\\b(?:invented|built|developed|created|launched|behind)\\b[\\s\\S]{0,120}\\b(?:product|technology|robot|platform|device)\\b`, 'i').test(source);
  const reasoningConfirmsParentProduct = /\b(?:parent|inventor|company\s+behind|invented|built|developed|created)\b[^.\n]{0,180}\b(?:product|technology|robot|platform|device|being\s+pitched)\b/i.test(fullText);
  const pitchFrame = /\b(?:medina|tony|raul|manny|watch|demo|ted|deck|pitch|run\s+it\s+by|review|investment|micro[-\s]?robot|disrupting)\b/i.test(source);
  const notMerelySender = !new RegExp(`\\b${companyPattern}\\b[^.\\n]{0,120}\\b(?:is\\s+the\\s+sender|sender\\s+only|context\\s+entity\\s+only)\\b`, 'i').test(fullText);
  return sourceNamesParentProduct && (reasoningConfirmsParentProduct || pitchFrame) && pitchFrame && notMerelySender;
}

function hasParentCompanyProductRedirect(context: string, productName: string): boolean {
  const text = normalizeWhitespace(context || '');
  const productPattern = currentCompanyPattern(productName);
  if (!text || !productPattern) return false;
  if (hasCompanyToken(productName)) return false;
  const parentBeforeProduct = new RegExp(
    `\\b(?:major\\s+investor|board\\s+member|investor|founder|team)\\b[\\s\\S]{0,220}\\b[A-Z][A-Za-z0-9&.'’/-]{2,}(?:\\s+[A-Z][A-Za-z0-9&.'’/-]{2,}){0,4}\\b[\\s\\S]{0,200}\\b(?:invented|built|developed|created|launched)\\b[\\s\\S]{0,100}\\b${productPattern}\\b`,
    'i'
  );
  const productKind = new RegExp(`\\b${productPattern}\\b[\\s\\S]{0,120}\\b(?:product|micro[-\\s]?robot|robot|device|platform|technology|demo|video)\\b`, 'i');
  return parentBeforeProduct.test(text) && productKind.test(text);
}

function hasCandidateWarmIntroTargetEvidence(
  text: string,
  reasoning: string | null | undefined,
  company: string
): boolean {
  const fullText = normalizeWhitespace([text, reasoning || ''].join(' '));
  if (!sourceMentionsName(fullText, company)) return false;
  if (/\b(?:scheduling\s+only|calendar\s+confirmation|calendar\s+scaffold|relationship\s+maintenance|no\s+(?:company\s+)?deck|no\s+(?:investment\s+)?pitch|no\b[^.\n]{0,140}\b(?:round|diligence|investment\s+ask|fundrais(?:e|ing)|raise)|not\s+(?:an?\s+)?(?:investment\s+)?opportunity)\b/i.test(fullText)) {
    return false;
  }
  const hasFundRecipient = /\b(?:medina\s+ventures|medina\s+vc|medina|the\s+fund)\b/i.test(fullText);
  const hasIntro = /\b(?:warm\s+intro|intro(?:duction)?|introduced|introducing|referred|forwarded|shared|sent|connect(?:ing)?|meet(?:ing)?|call)\b/i.test(fullText);
  const hasTargetSignal = /\b(?:founder|ceo|company|deck|investor\s+(?:deck|presentation|overview)|board\s+deck|pitch|demo|investment\s+opportunit(?:y|ies)|dealflow|raise|raising|fundrais(?:e|ing)|round|seed|series\s+[abc]|safe|data\s+room|diligence)\b/i.test(fullText);
  const hasRealAnchor = /\b(?:founder|ceo|co[-\s]?founder|contact|email|@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/|www\.|domain|deck|traction|arr|revenue|customers?|raise|raising|round|seed|series\s+[abc]|safe|deal\s*flow|dealflow|investment\s+opportunit(?:y|ies))\b/i.test(fullText);
  return hasFundRecipient && hasIntro && hasTargetSignal && hasRealAnchor;
}

function hasCandidatePitchDocumentTargetEvidence(
  text: string,
  reasoning: string | null | undefined,
  company: string
): boolean {
  const fullText = normalizeWhitespace([text, reasoning || ''].join(' '));
  if (!sourceMentionsName(fullText, company)) return false;
  if (/\b(?:document\s+(?:wrapper|title|heading)|file\s+name\s+only|folder\s+label|schema|html|css|copied\s+scaffolding)\b/i.test(fullText)) {
    return false;
  }
  const hasCompanyMaterial = /\b(?:investor\s+(?:deck|presentation|overview)|pitch\s+deck|company\s+deck|teaser|cim|investment\s+(?:summary|memo|request|proposal)|road\s*show|roadshow|one[-\s]?pager|two[-\s]?pager|pre[-\s]?read|financial\s+model|data\s+room|diligence\s+(?:summary|memo|request|materials?))\b/i.test(fullText);
  const hasInvestmentFrame = /\b(?:investment\s+opportunit(?:y|ies)|dealflow|fundrais(?:e|ing)|raising|raise|round|seed|series\s+[abc]|safe|valuation|allocation|diligence|review|Medina)\b/i.test(fullText);
  return hasCompanyMaterial && hasInvestmentFrame;
}

function hasCandidateMeetingInvestmentEvidence(
  text: string,
  reasoning: string | null | undefined,
  company: string
): boolean {
  const fullText = normalizeWhitespace([text, reasoning || ''].join(' '));
  if (!sourceMentionsName(fullText, company)) return false;
  if (/\b(?:calendar\s+(?:invite|confirmation|scaffold)|scheduling\s+only|relationship\s+maintenance|partnership\s+exploration|customer\s+conversation)\b/i.test(fullText)) {
    return false;
  }
  const hasMeeting = /\b(?:meeting|meet|call|zoom|demo|transcript|summary|recap|next\s+steps)\b/i.test(fullText);
  const hasInvestmentContent = /\b(?:investment\s+(?:discussion|opportunity|review|committee|next\s+steps)|diligence|financial\s+model|p&l|fundrais(?:e|ing)|raising|round|seed|series\s+[abc]|deck|founder|ceo|product\s+demo)\b/i.test(fullText);
  return hasMeeting && hasInvestmentContent;
}

function hasSubjectLineTargetInvestmentEvidence(text: string, company: string): boolean {
  const fullText = normalizeWhitespace(text || '');
  const companyPattern = currentCompanyPattern(company);
  if (!fullText || !companyPattern) return false;
  const subjectMatches = [
    ...fullText.matchAll(/\bsubject\s*:\s*([^;\n]{0,240})/gi),
    ...fullText.matchAll(/\bsource\s+entity\s+name\s*:\s*([^;\n]{0,240})/gi),
  ];
  for (const match of subjectMatches) {
    const subject = normalizeWhitespace(match[1] || '');
    if (!subject || !new RegExp(`\\b${companyPattern}\\b`, 'i').test(subject)) continue;
    if (/\b(?:co[-\s]?investment\s+opportunit(?:y|ies)|investment\s+opportunit(?:y|ies)|deal\s*flow|dealflow|fundrais(?:e|ing)|raising|raise|seed|series\s+[abc]|safe|investor\s+(?:deck|presentation|overview)|pitch\s+deck|investment\s+(?:summary|memo|request|proposal))\b/i.test(subject)) {
      return true;
    }
    if (new RegExp(`(?:\\b${companyPattern}\\b[^\\n]{0,90}<>\\s*Medina|Medina[^\\n]{0,90}<>[^\\n]{0,90}\\b${companyPattern}\\b)`, 'i').test(subject)) {
      return true;
    }
  }
  return false;
}

function hasSubjectTargetInvestmentEvidence(item: ClassifiedItem, mention: MentionCandidate): boolean {
  const subject = normalizeWhitespace(item.subject || '');
  if (!subject) return false;
  return hasSubjectLineTargetInvestmentEvidence(`subject: ${subject}`, mention.canonicalName);
}

function hasNamedCandidatePitchMaterialTitle(text: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  const titleMaterialPattern = '(?:investor\\s+(?:deck|presentation|overview)|pitch\\s+deck|company\\s+deck|investment\\s+(?:summary|memo|request|proposal)|road\\s*show|roadshow|teaser|cim|data\\s+room|financial\\s+model|diligence\\s+(?:summary|memo|materials?))';
  return new RegExp(`\\b${companyPattern}\\b[^.\\n|;]{0,90}\\b${titleMaterialPattern}\\b|\\b${titleMaterialPattern}\\b[^.\\n|;]{0,90}\\b(?:for\\s+)?${companyPattern}\\b`, 'i')
    .test(normalizeWhitespace(text || ''));
}

function hasStrongCandidatePitchMaterialEvidence(context: string, company: string): boolean {
  const text = normalizeWhitespace(context || '');
  if (!text || !sourceMentionsName(text, company)) return false;
  if (classifierReasoningExplicitlyRejectsProspect(text) || classifierReasoningSaysMentionIsNotTarget(text, company)) {
    return false;
  }
  const hasInvestmentFrame = /\b(?:investment\s+opportunit(?:y|ies)|dealflow|fundrais(?:e|ing)|raising|raise|round|seed|series\s+[abc]|safe|valuation|allocation|diligence|review|Medina)\b/i.test(text);
  if (hasNamedCandidatePitchMaterialTitle(text, company) && hasInvestmentFrame) return true;
  return hasCandidatePitchDocumentTargetEvidence(text, null, company) &&
    hasCurrentCompanyInvestmentTargetEvidence(text, company);
}

function classifierReasoningAffirmsTargetInvestment(
  reasoning: string | null | undefined,
  company: string
): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text || !sourceMentionsName(text, company)) return false;
  if (classifierReasoningExplicitlyRejectsProspect(text) || classifierReasoningSaysMentionIsNotTarget(text, company)) {
    return false;
  }
  return /\b(?:is|was|appears|shown|listed|included|presented|pitched|introduced|shared|sent|forwarded|framed)\b[^.\n]{0,180}\b(?:investment\s+opportunit(?:y|ies)|dealflow|fundrais(?:e|ing)|fund\s*raising|raise|raising|round|ask|seed|series\s+[abc]|safe|valuation|data\s+room|diligence|investor\s+(?:deck|presentation|overview)|company\s+deck|pitch\s+deck|financial\s+model|teaser|road\s*show|roadshow|founder|ceo)\b/i.test(text) ||
    /\b(?:investment\s+opportunit(?:y|ies)|dealflow|fundrais(?:e|ing)|fund\s*raising|raise|raising|round|ask|seed|series\s+[abc]|data\s+room|diligence|deck|teaser)\b[^.\n]{0,180}\b(?:for|from|with|by)\b[^.\n]{0,80}\b/i.test(text);
}

function hasCandidateProspectTargetEvidence(
  sourceText: string,
  reasoning: string | null | undefined,
  mention: MentionCandidate
): boolean {
  const text = candidateEvidenceText(sourceText, reasoning, mention);
  if (
    /\bno\b[^.\n]{0,140}\b(?:company\s+deck|deck|round|diligence|investment\s+ask|pitch|fundrais(?:e|ing)|raise)\b/i.test(text) ||
    /\bnot\s+clearly\s+(?:the\s+|an?\s+)?(?:investment\s+)?(?:target|prospect|opportunity)\b/i.test(String(reasoning || ''))
  ) {
    return false;
  }
  if (hasCurrentCompanyInvestmentTargetEvidence(text, mention.canonicalName)) return true;
  if (hasCandidateFundraisingListRowEvidence(sourceText, reasoning, mention)) return true;
  if (hasProductPitchParentCompanyEvidence(sourceText, reasoning, mention.canonicalName)) return true;
  if (hasMedinaOutboundProspectInterestEvidence(text, mention.canonicalName)) return true;
  if (hasStandoutInboundIntroEvidence(text, mention.canonicalName)) return true;
  if (hasCandidateWarmIntroTargetEvidence(text, reasoning, mention.canonicalName)) return true;
  if (hasCandidatePitchDocumentTargetEvidence(text, reasoning, mention.canonicalName)) return true;
  if (hasCandidateMeetingInvestmentEvidence(text, reasoning, mention.canonicalName)) return true;
  if (hasSubjectLineTargetInvestmentEvidence(text, mention.canonicalName)) return true;
  if (hasStrongCandidatePitchMaterialEvidence(text, mention.canonicalName)) return true;
  if (classifierReasoningAffirmsTargetInvestment(reasoning, mention.canonicalName)) return true;
  return false;
}

function candidateProspectTargetEvidenceReasons(
  sourceText: string,
  reasoning: string | null | undefined,
  mention: MentionCandidate
): string[] {
  const text = candidateEvidenceText(sourceText, reasoning, mention);
  if (
    /\bno\b[^.\n]{0,140}\b(?:company\s+deck|deck|round|diligence|investment\s+ask|pitch|fundrais(?:e|ing)|raise)\b/i.test(text) ||
    /\bnot\s+clearly\s+(?:the\s+|an?\s+)?(?:investment\s+)?(?:target|prospect|opportunity)\b/i.test(String(reasoning || ''))
  ) {
    return [];
  }
  const reasons: string[] = [];
  if (hasCurrentCompanyInvestmentTargetEvidence(text, mention.canonicalName)) reasons.push('current_company_investment_target_evidence');
  if (hasCandidateFundraisingListRowEvidence(sourceText, reasoning, mention)) reasons.push('fundraising_list_row');
  if (hasProductPitchParentCompanyEvidence(sourceText, reasoning, mention.canonicalName)) reasons.push('product_pitch_parent_company');
  if (hasMedinaOutboundProspectInterestEvidence(text, mention.canonicalName)) reasons.push('medina_outbound_prospect_interest');
  if (hasStandoutInboundIntroEvidence(text, mention.canonicalName)) reasons.push('standout_inbound_intro');
  if (hasCandidateWarmIntroTargetEvidence(text, reasoning, mention.canonicalName)) reasons.push('warm_intro_target');
  if (hasCandidatePitchDocumentTargetEvidence(text, reasoning, mention.canonicalName)) reasons.push('pitch_or_investment_document_target');
  if (hasCandidateMeetingInvestmentEvidence(text, reasoning, mention.canonicalName)) reasons.push('meeting_or_diligence_target');
  if (hasSubjectLineTargetInvestmentEvidence(text, mention.canonicalName)) reasons.push('subject_line_target_opportunity');
  if (hasStrongCandidatePitchMaterialEvidence(text, mention.canonicalName)) reasons.push('candidate_pitch_material_target');
  if (classifierReasoningAffirmsTargetInvestment(reasoning, mention.canonicalName)) reasons.push('classifier_reasoning_affirms_target_investment');
  if (hasSecurityQuarantineOrSenderWarningContext(text, mention.canonicalName) && reasons.length > 0) reasons.push('security_wrapped_target_opportunity');
  return Array.from(new Set(reasons));
}

function hasExplicitInvestmentTargetLanguage(context: string, company: string): boolean {
  return hasCurrentCompanyInvestmentTargetEvidence(context, company) ||
    /\b(?:data\s+room|diligence|financial\s+model|p&l|nda|term\s+sheet|cap\s+table|series\s+[abc]|seed\s+round|safe|valuation|allocation|lead\s+investor|co[-\s]?lead)\b/i.test(context) ||
    /\b(?:submitted\s+a\s+pitch|pitch\s+submission|website\s+pitch\s+submission|shared\s+as\s+(?:an?\s+)?(?:deal|investment)[-_\s]?pitch|being\s+(?:pitched|presented|shared|sent)\s+(?:as|for)\s+(?:an?\s+)?(?:investment\s+)?(?:opportunity|prospect|target|deal))\b/i.test(context);
}

function hasSecurityQuarantineOrSenderWarningContext(context: string, company: string): boolean {
  const text = normalizeWhitespace(context || '');
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasQuarantineOrWarning =
    /\b(?:quarantined|safely\s+quarantined|security\s+quarantine|suspected\s+(?:to\s+be\s+)?(?:phishing|malicious)|phishing\s+email|verify\s+the\s+sender\s+identity|sender\s+details\s+look\s+similar|secured\s+by\s+check\s+point|caution:\s*the\s+sender)\b/i.test(text);
  if (!hasQuarantineOrWarning) return false;
  if (/\b(?:suspected\s+(?:to\s+be\s+)?(?:phishing|malicious)|safely\s+quarantined|security\s+quarantine|sender\s+details\s+look\s+similar|verify\s+the\s+sender\s+identity|secured\s+by\s+check\s+point|caution:\s*the\s+sender)\b/i.test(text)) {
    return true;
  }
  const warningWords = (lower.match(/\b(?:quarantined|phishing|caution|sender|identity|secured|check\s+point|warning|malicious)\b/g) || []).length;
  const investmentWords = (lower.match(/\b(?:raising|raise|safe|series|diligence|data\s+room|financial\s+model|term\s+sheet|pitch\s+deck|investment\s+opportunity)\b/g) || []).length;
  return warningWords >= Math.max(2, investmentWords + 1) && !hasCurrentCompanyInvestmentTargetEvidence(text, company);
}

function hasNonInvestmentEventFundraisingContext(context: string): boolean {
  const text = normalizeWhitespace(context || '').toLowerCase();
  if (!text) return false;
  const hasEventProgramFrame = /\b(?:nonprofit|non-profit|501\(c\)|foundation|charity|charitable|beneficiary|beneficiaries|concert|artist|venue|event|conference|program|postmortem|sponsor|sponsorship|donor|fundraiser)\b/.test(text);
  if (!hasEventProgramFrame) return false;
  const hasEventMoneyLanguage = /\b(?:budget|deficit|raised\s+(?:approximately|approx\.?|about|~)?\s*\$|donation|donations|sponsor|sponsorship|ticket|artist\s+fee|fundraising\s+(?:event|concert|benefit)|benefit\s+(?:event|concert))\b/.test(text);
  if (!hasEventMoneyLanguage) return false;
  return !/\b(?:equity|safe|valuation|cap\s+table|term\s+sheet|series\s+[abc]|seed\s+round|priced\s+round|convertible\s+note|lead\s+investor|co[-\s]?lead|ownership|shares?)\b/.test(text);
}

function hasCompanyMaterialsOnlyContext(context: string): boolean {
  return /\b(?:pitch\s+deck|deck\s+attached|deck|teaser|cim|company\s+materials|materials|company\s+2[-\s]?pager|2[-\s]?pager|pre[-\s]?read|overview|one[-\s]?liner|demo\s+link|bio)\b/i.test(context) &&
    !hasStrongSourceInvestmentIntent(context);
}

function meaningfulCompanyContextTokens(company: string): string[] {
  const stop = new Set([
    'company', 'companies', 'capital', 'ventures', 'venture', 'partners', 'partner',
    'labs', 'lab', 'technologies', 'technology', 'systems', 'solutions', 'group',
    'inc', 'llc', 'ltd', 'corp', 'corporation', 'the',
  ]);
  return normalizeWhitespace(company)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 4 && !stop.has(token));
}

function is_event_channel_context(context: string, company: string): boolean {
  if (hasCurrentCompanyInvestmentTargetEvidence(context, company)) return false;
  const eventPattern = /\b(?:conference|showcase|demo\s+day|road\s+show|roadshow|vc\s+briefing|briefing|program|cohort|accelerator|event\s+host|event\s+organizer|startup\s+showcase|government\s+briefing|ecosystem|summit|forum|expo|festival)\b/i;
  const channelPattern = /\b(?:channel|source|partner|winner|attended|hosted|organized|presented\s+by|sponsored\s+by|event|ecosystem|program|community)\b/i;
  if (eventPattern.test(company)) return true;
  if (!eventPattern.test(context) || !channelPattern.test(context)) return false;
  const tokens = meaningfulCompanyContextTokens(company);
  return tokens.some(token => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(context));
}

function is_partnership_support_context(context: string, company: string): boolean {
  if (hasCurrentCompanyInvestmentTargetEvidence(context, company)) return false;
  return (
    /\b(?:seeking|exploring|requesting|requested|looking\s+for|interested\s+in)\s+(?:a\s+)?(?:strategic\s+|commercial\s+|ecosystem\s+|community\s+)?(?:partnership|partner|collaboration|support|introduction|introductions|intro|intros|sponsor|sponsorship)\b/i.test(context) ||
    /\b(?:partnership|partner|collaboration|support|introductions?|intros?|sponsor|sponsorship)\b[^.\n]{0,160}\b(?:mature\s+company|enterprise\s+company|event|conference|showcase|expo|festival|community|channel|commercial\s+relationship|ecosystem)\b/i.test(context) ||
    /\b(?:mature\s+company|event\s+organizer|conference\s+organizer|show\s+organizer|trade\s+show|expo\s+operator|festival\s+organizer|community\s+organizer)\b/i.test(context) ||
    /\bcongratulations\s+and\s+thank\s+you\b/i.test(context)
  );
}

function hasProgramOrEcosystemBusinessModelContext(context: string, company: string): boolean {
  if (hasExplicitInvestmentTargetLanguage(context, company)) return false;
  const text = normalizeWhitespace(context || '');
  if (!text) return false;
  const programTerms = (text.match(/\b(?:ecosystem|program|initiative|community|demo\s+day|hackathon|accelerator|showcase|briefing|workshop|membership|memberships|sponsor(?:ship|s)?|government\s+partnerships?|dual[-\s]?use\s+(?:ecosystem|programming|pathway)|co[-\s]?location|office\s+space|phase\s+\d|business\s+model|pathway|partners?|conference|event)\b/gi) || []).length;
  if (programTerms < 3) return false;
  if (/\b(?:business\s+model|phase\s+\d|ecosystem|program|initiative|membership|sponsor(?:ship|s)?|co[-\s]?location|office\s+space|demo\s+days?|hackathon|accelerator|government\s+partnerships?|dual[-\s]?use\s+(?:ecosystem|programming|pathway))\b/i.test(text)) {
    return true;
  }
  const tokens = meaningfulCompanyContextTokens(company);
  return tokens.some(token => new RegExp(`\\b${escapeRegExp(token)}\\b[^.\\n]{0,160}\\b(?:ecosystem|program|initiative|community|event|conference|showcase|demo\\s+day|hackathon|membership|sponsor|partner)\\b`, 'i').test(text));
}

function is_demo_scheduling_only_context(context: string, company: string): boolean {
  if (hasExplicitInvestmentTargetLanguage(context, company)) return false;
  const text = normalizeWhitespace(context || '');
  if (!text) return false;
  if (!/\b(?:demo|demonstration)\b/i.test(text)) return false;
  if (/\b(?:pitch\s+deck|investor\s+deck|data\s+room|diligence|financial\s+model|p&l|term\s+sheet|safe|series\s+[abc]|seed\s+round|valuation|allocation|investment\s+opportunity|fund\s+investment)\b/i.test(text)) return false;
  return /\b(?:calendar\s+invite|meeting\s+invite|you\s+have\s+been\s+invited|accepted\s+the\s+(?:calendar|meeting|zoom)\s+invite|scheduled|google\s+meet|zoom|teams\s+meeting|when:|where:|location:|will\s+explain\s+more\s+when\s+i\s+see\s+you|demo\s+logistics|mail-editor-reference-message-container|appointment-buttons|google\s+material\s+icons|body-container)\b|<html\b/i.test(text);
}

function is_collaboration_fundraising_activation_context(context: string, company: string): boolean {
  if (hasExplicitInvestmentTargetLanguage(context, company)) return false;
  const text = normalizeWhitespace(context || '');
  if (!text) return false;
  const hasCollaborationFrame = /\b(?:work\s+together|collaborat(?:e|ion)|partnership|partnering|market\s+activation|commercial\s+relationship|support|introductions?|intros?|hop\s+on\s+a\s+call|explore\s+how\s+we\s+might)\b/i.test(text);
  if (!hasCollaborationFrame) return false;
  if (/\boverlap\s+between\s+fundraising\s+and\s+market\s+activation\b/i.test(text)) return true;
  return /\b(?:eMerge|ecosystem|community|market\s+activation|commercial\s+relationship|partnership|support|sponsorship|program|event|conference)\b/i.test(text) &&
    !/\b(?:raising\s+\$|raise\s+\$|safe|series\s+[abc]|term\s+sheet|data\s+room|diligence|financial\s+model|p&l|valuation|allocation|lead\s+investor|co[-\s]?lead)\b/i.test(text);
}

function hasPrivatePitchDocumentTargetEvidence(context: string, company: string, prospectCompanyName?: string | null): boolean {
  const text = normalizeWhitespace(context || '');
  if (!text) return false;
  const names = [company, prospectCompanyName || ''].map(name => normalizeWhitespace(name)).filter(Boolean);
  const mentionsTarget = names.some(name => {
    if (sourceMentionsName(text, name)) return true;
    const a = normalizeProspectName(name);
    return Boolean(a && a.length >= 7 && normalizeProspectName(text).includes(a));
  });
  if (!mentionsTarget) return false;
  const hasPitchDocumentFrame =
    /\b(?:document_type\s*=\s*deal_pitch|investor\s+(?:overview|deck|roadshow|presentation)|investment\s+(?:summary|memo|teaser|overview)|pitch\s+deck|company\s+deck|overview\s+document|confidential\s+(?:information\s+)?memorandum|CIM)\b/i.test(text);
  const hasPrivateFinancingDocumentFrame =
    /\b(?:letter\s+of\s+(?:interest|intent)|LOI|financing\s+(?:proposal|document|package|opportunity|summary|request)|loan\s+(?:agreement|request|summary|proposal)|credit\s+(?:agreement|facility)|borrower|issuer|seller|acquisition\s+target|purchase\s+(?:agreement|price)|debt\s+financing)\b/i.test(text);
  const candidateIsLenderOrProvider = names.some(name => {
    const pattern = currentCompanyPattern(name);
    return Boolean(pattern && new RegExp(`\\b${pattern}\\b[^.\\n]{0,180}\\b(?:lender|financing\\s+provider|loan\\s+provider|capital\\s+provider)\\b`, 'i').test(text));
  });
  if (candidateIsLenderOrProvider) return false;
  const centralFinancingRole = names.some(name => {
    const pattern = currentCompanyPattern(name);
    if (!pattern) return false;
    return new RegExp(
      [
        `\\b${pattern}\\b[^.\\n]{0,220}\\b(?:borrower|issuer|seller|acquisition\\s+target|target\\s+company|company\\s+being\\s+financed|financing\\s+recipient|loan\\s+recipient)\\b`,
        `\\b(?:borrower|issuer|seller|acquisition\\s+target|target\\s+company|company\\s+being\\s+financed|financing\\s+recipient|loan\\s+recipient)\\b[^.\\n]{0,220}\\b${pattern}\\b`,
      ].join('|'),
      'i'
    ).test(text);
  });
  const centralFinancingDocumentSubject = names.some(name => {
    const pattern = currentCompanyPattern(name);
    if (!pattern) return false;
    const earlySubject =
      new RegExp(`\\b(?:letter\\s+of\\s+(?:interest|intent)|LOI)\\b[\\s\\S]{0,180}\\b${pattern}\\b`, 'i').test(text) ||
      new RegExp(`^[\\s\\S]{0,180}\\b${pattern}\\b`, 'i').test(text);
    return earlySubject &&
      /\b(?:provide\s+financing|non[-\s]?binding\s+expression\s+of\s+interest|commitment\s+to\s+lend|lender\s+credit\s+approval|customary\s+and\s+required\s+due\s+diligence|principal|maturity|interest[-\s]?rate|loan|debt\s+financing)\b/i.test(text);
  });
  if (hasPrivateFinancingDocumentFrame && centralFinancingDocumentSubject) return true;
  if (hasPrivateFinancingDocumentFrame && centralFinancingRole) return true;
  if (!hasPitchDocumentFrame) return false;
  return /\b(?:raising|fundrais(?:e|ing)|investor\s+(?:support|solicitation)|valuation|TAM\/SAM\/SOM|TAM|SAM|SOM|commercialization|founding\s+team|IP\s+(?:position|portfolio)|market|roadmap|capital|round|series\s+[abc]|seed|safe)\b/i.test(text);
}

function hasDirectInvestorForwardedRoundEvidence(
  item: ClassifiedItem,
  mention: MentionCandidate,
  classifierInput: ProspectClassifierInput,
  reasoning?: string | null
): boolean {
  const sourceText = normalizeWhitespace([
    classifierInput.senderAndContext,
    classifierInput.rawExcerpt,
    reasoning || '',
  ].filter(Boolean).join(' '));
  if (!sourceText || !sourceMentionsName(sourceText, mention.canonicalName)) return false;
  if (/\b(?:newsletter|digest|press\s+release|public\s+news|market\s+update|smartbrief|roundup|security\s+quarantine|phishing|sender\s+warning|billing|invoice|auth|login)\b/i.test(sourceText)) {
    return false;
  }
  const directToFund = [
    ...(item.toEmails || []),
    ...(item.ccEmails || []),
  ].some(email => /@(?:medinavc|mediavc)\.com$/i.test(String(email || ''))) ||
    /\bto:\s*[^|;\n]*(?:@(?:medinavc|mediavc)\.com|Medina|Tony|Lucas|Raul)\b/i.test(classifierInput.senderAndContext) ||
    /\b(?:Medina\s+Ventures|Medina\s+VC|the\s+fund)\b/i.test(sourceText);
  if (!directToFund) return false;
  const companyPattern = currentCompanyPattern(mention.canonicalName);
  if (!companyPattern) return false;
  const investorAnnouncementTarget = new RegExp(
    [
      `\\b(?:our|we(?:'|’)?re|we\\s+are|we)\\b[^.\\n]{0,120}\\b(?:latest\\s+)?investment\\s+in\\s+${companyPattern}\\b`,
      `\\b(?:invested|co[-\\s]?led|co[-\\s]?leading|led|leading)\\b[^.\\n]{0,160}\\b(?:round|investment)\\b[^.\\n]{0,160}\\b(?:in|for)\\s+${companyPattern}\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,220}\\b(?:SAFE|post[-\\s]?money|valuation|round|investment|co[-\\s]?led|co[-\\s]?leading|lead\\s+investor|raise|raising|fundrais(?:e|ing)|\\$\\s?\\d)\\b`,
    ].join('|'),
    'i'
  ).test(sourceText);
  const roundTerms = /\b(?:SAFE|post[-\s]?money|valuation|round|co[-\s]?led|co[-\s]?leading|lead\s+investor|seed|series\s+[abc]|raise|raising|fundrais(?:e|ing)|\$\s?\d|\d+(?:\.\d+)?\s*(?:m|mm|million|k)\b)\b/i.test(sourceText);
  return investorAnnouncementTarget && roundTerms;
}

function is_calendar_only_context(context: string, company: string): boolean {
  if (hasStrongSourceInvestmentIntent(context) || hasCurrentCompanyInvestmentTargetEvidence(context, company)) return false;
  return /\b(?:accepted\s+(?:the\s+)?(?:zoom|calendar|meeting)\s+invite|calendar\s+invite|zoom\s+(?:invite|link|meeting)|google\s+meet|meet\.google\.com|will\s+circulate\s+(?:a\s+)?calendar|send\s+(?:a\s+)?calendar|confirm(?:ing)?\s+(?:the\s+)?(?:time|date|zoom|meeting)|scheduled\s+(?:call|meeting|zoom)|introductory\s+zoom\s+scheduled|meeting\s+on\s+(?:the\s+)?calendar|availability|are\s+you\s+available)\b/i.test(context);
}

function is_relationship_only_context(context: string, company: string): boolean {
  if (hasStrongSourceInvestmentIntent(context) || hasCurrentCompanyInvestmentTargetEvidence(context, company)) return false;
  return /\b(?:political|campaign|candidate|election|constituent|personal\s+relationship|relationship\s+meeting|relationship\s+building|family\s+friend|friend\s+of|brother|shared\s+values|nonprofit\s+board|community\s+relationship)\b/i.test(context) &&
    /\b(?:meeting|call|intro|introduction|connect|conversation)\b/i.test(context);
}

function is_coordination_only_context(context: string, company: string): boolean {
  if (hasStrongSourceInvestmentIntent(context) || hasCurrentCompanyInvestmentTargetEvidence(context, company)) return false;
  return /\b(?:wanted\s+to\s+introduce|mutual\s+introduction|intro(?:duction)?\s+to|connecting\s+you|making\s+an\s+introduction|great\s+meeting\s+you|thanks?\s+for\s+(?:the\s+)?intro|following\s+up\s+to\s+(?:schedule|coordinate|connect)|coordinate\s+(?:a\s+)?(?:call|meeting)|set\s+up\s+(?:a\s+)?(?:call|meeting)|let(?:'|’)?s\s+find\s+(?:a\s+)?time|will\s+circle\s+back|circulate\s+(?:a\s+)?calendar|contact\s+info|put\s+you\s+in\s+touch)\b/i.test(context);
}

function isThinAcronymIntroOrSchedulingContext(context: string, company: string): boolean {
  const cleanCompany = normalizeWhitespace(company);
  const normalized = normalizeProspectName(cleanCompany);
  const compact = cleanCompany.replace(/[^A-Za-z0-9]/g, '');
  const isShortAcronymLike = Boolean(
    normalized &&
    normalized.length <= 5 &&
    (compact.length <= 5 || /^[A-Z0-9]{2,6}$/.test(compact))
  );
  if (!isShortAcronymLike) return false;
  if (hasStrongSourceInvestmentIntent(context) || hasCurrentCompanyInvestmentTargetEvidence(context, company)) return false;
  if (/\b(?:builds?|platform|product|solution|customers?|traction|revenue|arr|mrr|valuation|website|about\s+(?:the\s+)?company)\b/i.test(context)) return false;
  return /\b(?:intro|introduction|introduce|introduced|connect|meeting|calendar|invite|zoom|scheduling|availability|reconnect|catch\s+up|speak\s+then|confirm(?:ing)?|warm\s+intro)\b/i.test(context);
}

function hasPartnershipOrMatureCompanyNonProspectContext(context: string, company: string): boolean {
  return is_partnership_support_context(context, company);
}

function hasProductivityToolingNonProspectContext(context: string): boolean {
  return /\b(?:add\s+profiles\s+to\s+gmail|gmail\s+(?:add[-\s]?on|extension|profile)|chrome\s+extension|browser\s+(?:add[-\s]?on|extension)|email\s+workflow|profile\s+enrichment|contact\s+enrichment|add\s+profiles)\b/i.test(context);
}

function hasEventOrProgramChannelContext(context: string, company: string): boolean {
  return is_event_channel_context(context, company);
}

function classifierReasoningExplicitlyRejectsProspect(reasoning: string | null | undefined): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text) return false;
  return classifierReasoningHasHardNegativeRole(text) ||
    /\bno\s+(?:company\s+)?prospect\s+signal\b/i.test(text) ||
    /\b(?:security\s+quarantine|quarantine\s+notice|suspected\s+phishing|phishing\s+email|sender\s+warning|sender\s+identity\s+warning)\b/i.test(text) ||
    /\bno\s+(?:clear\s+|new\s+|fresh\s+)?(?:investment\s+)?(?:opportunity|pitch|fundrais(?:e|ing)|diligence(?:\s+signal)?|dealflow|prospect)\b/i.test(text) ||
    /\bno\s+(?:active\s+)?(?:pitch|diligence|investment\s+ask)\b/i.test(text) ||
    /\bno\s+evidence\b[^.]{0,140}\b(?:pitched|presented|introduced|shared)\b[^.]{0,100}\b(?:investment\s+)?(?:opportunity|prospect|target)\b/i.test(text) ||
    /\bnot\s+(?:a\s+|an\s+)?(?:new\s+|fresh\s+|actual\s+|clear\s+)?(?:investment\s+)?(?:prospect|opportunity|pitch|fundrais(?:e|ing)|diligence\s+signal)\b/i.test(text) ||
    /\bnot\s+the\s+(?:investment\s+)?(?:opportunity|prospect|target)(?:\s+itself)?\b/i.test(text) ||
    /\bnot\s+(?:a\s+|the\s+)?separate\s+(?:company\s+)?prospect\b/i.test(text) ||
    /\bnot\s+(?:a\s+|the\s+)?company\b/i.test(text) ||
    /\b(?:document|deck|page|footer|header|copyright|scaffolding|text)\s+(?:fragment|artifact|scaffolding)\b/i.test(text) ||
    /\bnot\s+(?:a\s+|an\s+)?commercial\s+company\s+being\s+pitched\b/i.test(text) ||
    /\bnot\s+(?:a\s+|the\s+)?fund\s+investment\s+opportunity\b/i.test(text) ||
    /\bnot\s+being\s+pitched(?:\s+as)?\s+(?:a\s+|an\s+|the\s+)?(?:new\s+|investment\s+)?prospect\b/i.test(text) ||
    /\b(?:mentioned|included)\s+(?:for|as)\s+(?:useful\s+)?context\b[^.]{0,160}\bnot\s+being\s+pitched\b/i.test(text) ||
    /\buseful\s+context\b[^.]{0,120}\bnot\s+being\s+pitched\b/i.test(text) ||
    /\bunderlying\s+infrastructure\b[^.]{0,160}\bnot\b[^.]{0,120}\binvestment\s+opportunity\b/i.test(text) ||
    /\bgovernment\s+(?:military\s+)?(?:command|agency|buyer)\b[^.]{0,160}\bnot\b[^.]{0,120}\b(?:commercial\s+)?company\b/i.test(text) ||
    /\bnot\s+(?:being\s+)?(?:presented|pitched|introduced|shared)\s+as\s+(?:a\s+|an\s+)?(?:investment\s+)?(?:opportunity|prospect|target)\b/i.test(text) ||
    /\b(?:relationship\s+maintenance|meeting\s+scheduling|scheduling\s+follow[-\s]?up|calendar\s+meeting|contact\s+logistics|coordination\s+only)\b/i.test(text) ||
    /\b(?:product\s+update|internal\s+radar|pipeline\s+status\s+report|crm\s+entry)\b[^.]{0,120}\bnot\s+(?:a\s+|an\s+)?(?:new\s+|fresh\s+)?(?:investment\s+)?(?:pitch|prospect|opportunity|inbound)\b/i.test(text);
}

function classifierReasoningSaysMentionIsNotCompanyOrListChannel(reasoning: string | null | undefined): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text) return false;
  return /\b(?:market\s+segment|segment\s+definition|not\s+a\s+company\s+name|not\s+a\s+company\s+mention|filename(?:\/document)?\s+(?:artifact|title)|section\s+heading|document\s+title\s+artifact)\b/i.test(text) ||
    /\bnot\s+(?:a\s+|the\s+)?separate\s+(?:company\s+)?(?:prospect|company)\b/i.test(text) ||
    /\b(?:government\s+)?program\/channel\b/i.test(text) ||
    /\b(?:government\s+program|ecosystem|channel)\b[^.]{0,160}\bnot\b[^.]{0,120}\binvestment\s+target\b/i.test(text) ||
    /\bcurated\s+list\s+of\s+companies\b/i.test(text);
}

function looksLikeGovernmentProgramOrListWrapper(company: string, context: string): boolean {
  const name = normalizeWhitespace(company || '').toLowerCase();
  const text = normalizeWhitespace(context || '').toLowerCase();
  if (!name || !text) return false;
  const hasGovernmentOrProgramName = /\b(?:army|navy|air\s+force|space\s+force|socom|devcom|dod|department\s+of\s+defense|federal|government|sbir|sttr|accelerator|showcase|program)\b/.test(name);
  if (!hasGovernmentOrProgramName) return false;
  const hasCompanyLikeQualifier = /\b(?:labs?|ai|technolog(?:y|ies)|systems?|software|robotics|compute|security|energy|bio|health|therapeutics|quantum|aerospace|defense|ventures|capital)\b/.test(name);
  if (hasCompanyLikeQualifier && !/\b(?:army|navy|air\s+force|space\s+force|socom|devcom|dod|sbir|sttr|program|government|federal)\b/.test(name)) return false;
  return /\b(?:companies|company\s+list|fund\s*raising|fundraising|demo\s+day|briefing|road\s+show|cohort|showcase|challenge|accelerator|program|sbir|sttr|host(?:s|ed)?|sponsored\s+by|organized\s+by)\b/.test(text);
}

function serviceProviderRoleClearlyPointsElsewhere(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  const text = normalizeWhitespace(context || '');
  return new RegExp(
    [
      `\\b${companyPattern}\\b[^.\\n]{0,180}\\b(?:advisor|advisory\\s+firm|accounting\\s+(?:and\\s+)?advisory\\s+firm|investment\\s+bank(?:er)?|placement\\s+agent|broker[-\\s]?dealer|legal\\s+counsel|law\\s+firm|consulting\\s+firm)\\b[^.\\n]{0,180}\\b(?:for|on\\s+behalf\\s+of|representing|conducting|arranging|marketing|reviewing|supporting)\\b[^.\\n]{0,120}\\b(?:another|other|target|client|issuer|borrower|seller|company|deal)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,180}\\b(?:advisor|advisory\\s+firm|accounting\\s+(?:and\\s+)?advisory\\s+firm|investment\\s+bank(?:er)?|placement\\s+agent|broker[-\\s]?dealer|securities|legal\\s+counsel|law\\s+firm|consulting\\s+firm)\\b[^.\\n]{0,180}\\bfor\\s+(?!Medina\\b)[A-Z0-9][A-Za-z0-9&.'’/-]+(?:\\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5}\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,180}\\bconducting\\b[^.\\n]{0,120}\\b(?:raise|fundrais(?:e|ing)|financing)\\b[^.\\n]{0,80}\\bfor\\s+(?!Medina\\b)[A-Z0-9]`,
      `\\b${companyPattern}\\b(?:\\.com)?[^.\\n]{0,120}\\badvisor\\s+domain\\b[^.\\n]{0,120}\\bfacilitating\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\bconsulting\\s+firm\\b[^.\\n]{0,120}\\badvising\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,180}\\b(?:reviewing|advising|representing|conducting|arranging|marketing|supporting)\\b[^.\\n]{0,120}\\b(?:another|other|target|client|issuer|borrower|seller)\\b`,
      `\\b(?:actual|real)\\s+(?:target|prospect|company|deal)\\s+(?:is|was)\\s+(?!${companyPattern}\\b)`,
    ].join('|'),
    'i'
  ).test(text);
}

function prospectValuableActionVetoForMention(input: ProspectValuableActionVetoInput): ProspectValuableActionVetoDecision {
  if (input.prospectAction !== 'create_prospect' && input.prospectAction !== 'attach_existing_deal') {
    return { applied: false, reason: null, confidence: null, nonValuableAction: null };
  }
  const company = normalizeWhitespace(input.companyName || input.rawMention || '');
  const rawMention = normalizeWhitespace(input.rawMention || company);
  const normalized = normalizeProspectName(company);
  const nameHaystack = `${company}\n${rawMention}`.toLowerCase();
  const contextText = [
    input.senderAndContext || '',
    input.rawExcerpt || '',
    input.llmReasoning || '',
  ].join('\n');
  const sourceEvidenceText = [
    input.senderAndContext || '',
    input.rawExcerpt || '',
  ].join('\n');
  const contextHaystack = contextText.toLowerCase();
  const isCreate = input.prospectAction === 'create_prospect';
  const isAttach = input.prospectAction === 'attach_existing_deal';
  const prospectCompanyNormalized = normalizeProspectName(input.prospectCompanyName || '');
  const prospectCompanyPointsElsewhere = Boolean(
    prospectCompanyNormalized &&
    normalized &&
    prospectCompanyNormalized !== normalized &&
    !prospectCompanyNormalized.includes(normalized) &&
    !normalized.includes(prospectCompanyNormalized)
  );
  const directTargetAssertion = hasCurrentCompanyDirectTargetAssertion(contextText, company);
  const reasoningAffirmsTargetInvestment = classifierReasoningAffirmsTargetInvestment(input.llmReasoning, company);
  const subjectLineTargetInvestmentEvidence = hasSubjectLineTargetInvestmentEvidence(contextText, company);
  const strongCandidatePitchMaterialEvidence = hasStrongCandidatePitchMaterialEvidence(contextText, company);
  const structuredPipelineRowEvidence = hasStructuredPipelineRowEvidence(contextText, company);
  const productPitchParentCompanyEvidence = hasProductPitchParentCompanyEvidence(sourceEvidenceText, input.llmReasoning, company);
  const earlyTargetSpecificInvestmentEvidence =
    hasCurrentCompanyInvestmentTargetEvidence(contextText, company) ||
    hasCandidateWarmIntroTargetEvidence(contextText, input.llmReasoning, company) ||
    hasCandidatePitchDocumentTargetEvidence(contextText, input.llmReasoning, company) ||
    hasCandidateMeetingInvestmentEvidence(contextText, input.llmReasoning, company) ||
    subjectLineTargetInvestmentEvidence ||
    strongCandidatePitchMaterialEvidence ||
    structuredPipelineRowEvidence ||
    productPitchParentCompanyEvidence;
  const hasServiceProviderNameOrKind =
    VETO_SERVICE_PROVIDER_NAMES.has(normalized) ||
    /\b(?:securities|broker[-\s]?dealer|financial advisor|exclusive financial advisor|investment bank(?:er)?|placement agent|law firm|legal counsel|attorneys?|cpa|fund admin|capital markets|accounting|advisory|consulting)\b/i.test(company);
  const serviceProviderPointsElsewhere = serviceProviderRoleClearlyPointsElsewhere(contextText, company);
  const hasExplicitServiceProviderRole =
    serviceProviderPointsElsewhere ||
    hasCurrentCompanyServiceProviderRole(contextText, company) ||
    (/\b(?:exclusive financial advisor|investment bank(?:er)?|broker[-\s]?dealer|placement agent|legal counsel|law firm|accounting and advisory firm|consulting firm)\b/i.test(contextHaystack) &&
      /\b(?:securities|advisor|advisory|law|legal|llp|p\.a\.)\b/i.test(company));
  const centralServiceProviderTargetEvidence = !serviceProviderPointsElsewhere &&
    (
      directTargetAssertion ||
      reasoningAffirmsTargetInvestment ||
      subjectLineTargetInvestmentEvidence ||
      hasCurrentCompanyInvestmentTargetEvidence(contextText, company) ||
      hasCandidateMeetingInvestmentEvidence(contextText, input.llmReasoning, company) ||
      strongCandidatePitchMaterialEvidence
    ) &&
    /\b(?:Medina|meeting|quick\s+call|diligence|financial\s+review|investment\s+review|ARR|MRR|gross\s+margin|revenue|valuation|data\s+room|financial\s+model|P&L|fundrais(?:e|ing)|raising|round|investment\s+opportunit(?:y|ies))\b/i.test(contextText);

  const veto = (reason: string, nonValuableAction: 'ignore' | 'record_context' = 'ignore'): ProspectValuableActionVetoDecision => ({
    applied: true,
    reason,
    confidence: 0.97,
    nonValuableAction,
  });

  if (isStandaloneDocumentHeading(company) || isGenericFragmentCandidate(company)) {
    return veto('section_heading_or_document_outline');
  }

  if (isMarkupArtifactCandidate(company)) {
    return veto('html_schema_or_markup_artifact');
  }

  if (
    VETO_LINK_OR_ADMIN_NAMES.has(normalized) ||
    /\b(?:google meet|meet\.google\.com|join with google meet|meeting link|join by phone|dial[-\s]?in|video call|calendar invite)\b/i.test(nameHaystack)
  ) {
    return veto('admin_link_or_calendar_scaffolding');
  }

  if (
    VETO_TOOL_OR_LINK_HOSTS.has(normalized) ||
    /\b(?:vimeo|docsend|zoom|calendly|docusign|dropbox|google drive|microsoft teams|slack)\.com\b/i.test(nameHaystack)
  ) {
    return veto('tool_vendor_or_link_host');
  }

  if (
    /\b(?:stadium|arena|hotel|airport|conference center|convention center|restaurant|resort|auditorium|theat(?:er|re)|club|school of medicine|research lab|university)\b/i.test(company)
  ) {
    return veto('venue_or_physical_location');
  }

  if (VETO_GOVERNMENT_OR_BUYER_ENTITIES.has(normalized)) {
    return veto('government_customer_or_buyer_entity');
  }

  if (VETO_MAJOR_CUSTOMER_OR_BUYER_NAMES.has(normalized)) {
    return veto('government_customer_or_buyer_entity', 'record_context');
  }

  if (VETO_PARTNER_CHANNEL_NAMES.has(normalized)) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (
    (
      (hasExplicitServiceProviderRole && !strongCandidatePitchMaterialEvidence && !centralServiceProviderTargetEvidence) ||
      (hasServiceProviderNameOrKind && !directTargetAssertion && !strongCandidatePitchMaterialEvidence && !centralServiceProviderTargetEvidence)
    )
  ) {
    return veto('service_provider_or_intermediary');
  }

  if (looksLikePersonName(company) || looksLikePersonOrParticipantBundle(company) || VETO_SINGLE_PERSON_NAMES.has(normalized)) {
    return veto('person_or_participant_bundle');
  }

  if (/\b[A-Z][A-Za-z.'’ -]{1,40}['’]s\s+(?:florida\s+)?quantum\b/i.test(company)) {
    return veto('person_or_participant_bundle');
  }

  const strongSourceInvestmentIntent = hasStrongSourceInvestmentIntent(sourceEvidenceText);
  const targetSpecificInvestmentEvidence =
    earlyTargetSpecificInvestmentEvidence ||
    directTargetAssertion ||
    reasoningAffirmsTargetInvestment;
  const sourceTargetSpecificInvestmentEvidence =
    hasCurrentCompanyInvestmentTargetEvidence(sourceEvidenceText, company) ||
    hasCandidateWarmIntroTargetEvidence(sourceEvidenceText, null, company) ||
    hasCandidatePitchDocumentTargetEvidence(sourceEvidenceText, null, company) ||
    hasCandidateMeetingInvestmentEvidence(sourceEvidenceText, null, company) ||
    subjectLineTargetInvestmentEvidence ||
    strongCandidatePitchMaterialEvidence ||
    structuredPipelineRowEvidence ||
    hasStandoutInboundIntroEvidence(sourceEvidenceText, company) ||
    productPitchParentCompanyEvidence ||
    hasPrivatePitchDocumentTargetEvidence(sourceEvidenceText, company, input.prospectCompanyName);
  const sourceHasConcreteCreateOverride =
    structuredPipelineRowEvidence ||
    productPitchParentCompanyEvidence ||
    hasStandoutInboundIntroEvidence(sourceEvidenceText, company) ||
    strongCandidatePitchMaterialEvidence ||
    subjectLineTargetInvestmentEvidence ||
    hasPrivatePitchDocumentTargetEvidence(sourceEvidenceText, company, input.prospectCompanyName) ||
    hasCandidatePitchDocumentTargetEvidence(sourceEvidenceText, null, company) ||
    (
      sourceMentionsName(sourceEvidenceText, company) &&
      /\binvestor\s+(?:report|update)\b/i.test(sourceEvidenceText) &&
      /\b(?:Medina|medinavc\.com|to:)\b/i.test(sourceEvidenceText) &&
      /\b(?:fundrais(?:e|ing)|investor\s+communication|traction|ARR|MRR|round|seed|active\s+investor)\b/i.test(sourceEvidenceText)
    );

  if (isCreate && hasSecurityQuarantineOrSenderWarningContext(contextText, company) && !targetSpecificInvestmentEvidence) {
    return veto('security_quarantine_or_sender_warning_artifact', 'record_context');
  }

  if (
    isCreate &&
    /\b(?:document|deck|page|footer|header|copyright|scaffolding|text)\s+(?:fragment|artifact|scaffolding)\b|\ball\s+rights\s+reserved\b/i.test(`${company}\n${input.llmReasoning || ''}`)
  ) {
    return veto('classifier_reasoning_explicitly_rejects_prospect', 'record_context');
  }

  if (
    isCreate &&
    /\b(?:table\s+column|column\s+header|header\s+label|field\s+label|table\s+label|not\s+a\s+company\s+name|not\s+a\s+company\s+or\s+prospect)\b/i.test(input.llmReasoning || '')
  ) {
    return veto('classifier_reasoning_explicitly_rejects_prospect', 'record_context');
  }

  if (
    isCreate &&
    hasParentCompanyProductRedirect(sourceEvidenceText, company) &&
    !hasPrivatePitchDocumentTargetEvidence(sourceEvidenceText, company, input.prospectCompanyName) &&
    !structuredPipelineRowEvidence
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    isCreate &&
    /\b(?:existing|known|current)\s+portfolio\s+(?:company|investment)\b/i.test(input.llmReasoning || '') &&
    /\bnot\b[^.\n]{0,160}\b(?:new|fresh|currently)\s+(?:investment\s+)?(?:pitch|prospect|opportunity)|\bnot\s+(?:being\s+)?(?:newly\s+)?(?:pitched|introduced|presented)\b/i.test(input.llmReasoning || '') &&
    !sourceHasConcreteCreateOverride
  ) {
    return veto('classifier_reasoning_explicitly_rejects_prospect', 'record_context');
  }

  if (isCreate && classifierReasoningExplicitlyRejectsProspect(input.llmReasoning) && !sourceHasConcreteCreateOverride) {
    return veto('classifier_reasoning_explicitly_rejects_prospect', 'record_context');
  }

  if ((isCreate || isAttach) && classifierReasoningSaysMentionIsNotCompanyOrListChannel(input.llmReasoning) && !targetSpecificInvestmentEvidence) {
    return veto('classifier_reasoning_says_mention_is_not_company_or_list_channel', 'record_context');
  }

  if ((isCreate || isAttach) && looksLikeGovernmentProgramOrListWrapper(company, contextText)) {
    return veto('government_program_or_list_wrapper_not_target_company', 'record_context');
  }

  if (isCreate && hasNonInvestmentEventFundraisingContext(contextText)) {
    return veto('non_investment_event_fundraising_or_postmortem_context', 'record_context');
  }

  if (
    isCreate &&
    /\b(?:intermediary|advisor|adviser|source|messenger|facilitator|broker)\b[^.\n]{0,220}\b(?:actual|real)\s+(?:capital[-\s]?raise\s+)?(?:target|prospect|opportunity|company)\b/i.test(input.llmReasoning || '') &&
    !hasCurrentCompanyDirectTargetAssertion(sourceEvidenceText, company) &&
    !productPitchParentCompanyEvidence
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (isCreate && classifierReasoningSaysMentionIsNotTarget(input.llmReasoning, company) && !sourceHasConcreteCreateOverride) {
    return veto('classifier_reasoning_says_mention_is_not_target', 'record_context');
  }

  if (isCreate && isThinAcronymIntroOrSchedulingContext(sourceEvidenceText, company)) {
    return veto('thin_acronym_intro_or_scheduling_without_investment_intent', 'record_context');
  }

  if (isCreate && is_demo_scheduling_only_context(sourceEvidenceText, company)) {
    return veto('demo_scheduling_only_without_investment_target', 'record_context');
  }

  if (isCreate && is_calendar_only_context(sourceEvidenceText, company)) {
    return veto('calendar_only_context_without_investment_target', 'record_context');
  }

  if (isCreate && !strongSourceInvestmentIntent && !targetSpecificInvestmentEvidence && hasEventOrProgramChannelContext(sourceEvidenceText, company)) {
    return veto('event_or_program_channel_without_investment_target', 'record_context');
  }

  if (isCreate && !sourceTargetSpecificInvestmentEvidence && !(directTargetAssertion || reasoningAffirmsTargetInvestment) && hasProgramOrEcosystemBusinessModelContext(sourceEvidenceText, company)) {
    return veto('program_or_ecosystem_business_model_not_company_target', 'record_context');
  }

  if (isCreate && !strongSourceInvestmentIntent && hasPartnershipOrMatureCompanyNonProspectContext(sourceEvidenceText, company)) {
    return veto('partnership_or_mature_company_without_investment_target', 'record_context');
  }

  if (
    isCreate &&
    !strongCandidatePitchMaterialEvidence &&
    !structuredPipelineRowEvidence &&
    !hasCandidatePitchDocumentTargetEvidence(sourceEvidenceText, null, company) &&
    !hasPrivatePitchDocumentTargetEvidence(contextText, company, input.prospectCompanyName) &&
    /\boverlap\s+between\s+fundraising\s+and\s+market\s+activation\b/i.test(sourceEvidenceText)
  ) {
    return veto('collaboration_fundraising_activation_without_investment_target', 'record_context');
  }

  if (
    isCreate &&
    !sourceHasConcreteCreateOverride &&
    !strongCandidatePitchMaterialEvidence &&
    !hasPrivatePitchDocumentTargetEvidence(contextText, company, input.prospectCompanyName) &&
    is_collaboration_fundraising_activation_context(sourceEvidenceText, company)
  ) {
    return veto('collaboration_fundraising_activation_without_investment_target', 'record_context');
  }

  if (isCreate && !strongSourceInvestmentIntent && hasProductivityToolingNonProspectContext(sourceEvidenceText)) {
    return veto('productivity_tooling_context_without_investment_target', 'record_context');
  }

  if (isCreate && !strongSourceInvestmentIntent && hasCompanyMaterialsOnlyContext(sourceEvidenceText)) {
    return veto('materials_without_investment_intent', 'record_context');
  }

  if (isCreate && !targetSpecificInvestmentEvidence && is_relationship_only_context(sourceEvidenceText, company)) {
    return veto('relationship_only_context_without_investment_target', 'record_context');
  }

  if (isCreate && !targetSpecificInvestmentEvidence && is_coordination_only_context(sourceEvidenceText, company)) {
    return veto('coordination_only_context_without_investment_target', 'record_context');
  }

  if (isAttach && hasWeakKnownDealAttachContext(contextText, company)) {
    return veto('weak_known_deal_context_without_target_signal', 'record_context');
  }

  const attachReasoningSaysKnownDealTarget = isAttach &&
    /\b(?:known|existing)\s+(?:portfolio|deal)\s+(?:company|investment|structure|target)?\b|\bportfolio\s+company\b|\bknown\s+(?:deal\s+company|operating\s+entity)\b|\bexisting\s+(?:deal|portfolio\s+investment)\s+structure\b/i.test(contextHaystack);

  if (attachReasoningSaysKnownDealTarget) {
    return { applied: false, reason: null, confidence: null, nonValuableAction: null };
  }

  if (
    isCreate &&
    /\b(?:newsletter|digest|smartbrief|nvca|press\s+roundup|market\s+update|generated\s+meeting\s+summary)\b/i.test(contextHaystack) &&
    (/\b(?:reported|reporting|news|roundup|digest|only)\b/i.test(contextHaystack) || !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)) &&
    !/\b(?:introduced|introducing|warm intro|sent|shared|forwarded)\b[^.\n]{0,160}\b(?:deck|pitch|raise|raising|fundrais|investment opportunity)\b/i.test(contextText)
  ) {
    return veto('news_or_digest_only');
  }

  if (isCreate && /\bweekly\s+meeting\s+recap\b/i.test(contextHaystack) && /\b4degrees\b/i.test(contextHaystack)) {
    return veto('news_or_digest_only');
  }

  if (
    isCreate &&
    senderDomainCompanyMatches(contextText, company) &&
    hasDifferentPrimaryTargetEvidence(contextText, normalized) &&
    !directTargetAssertion &&
    !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    prospectCompanyPointsElsewhere &&
    !productPitchParentCompanyEvidence &&
    (
      isCreate ||
      hasCurrentCompanyIntroSourceRole(contextText, company) ||
      hasCurrentCompanyInvestorBackingRole(contextText, company) ||
      hasCurrentCompanyCustomerPartnerRole(contextText, company) ||
      VETO_FUND_OR_LP_NAMES.has(normalized) ||
      VETO_PARTNER_CHANNEL_NAMES.has(normalized)
    )
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    hasCurrentCompanyIntroSourceRole(contextText, company) &&
    !productPitchParentCompanyEvidence &&
    !directTargetAssertion &&
    !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)
  ) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (
    (hasCurrentCompanyInvestorParticipantRole(contextText, company) || hasCurrentCompanyInvestorBackingRole(contextText, company)) &&
    !(hasCurrentCompanyInvestorParticipantRole(contextText, company) && /\b(?:participant|attendee)\b/i.test(contextHaystack)) &&
    !productPitchParentCompanyEvidence &&
    !directTargetAssertion &&
    !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)
  ) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (hasCurrentCompanyInvestorParticipantRole(contextText, company) && /\b(?:participant|attendee)\b/i.test(contextHaystack)) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (
    hasCurrentCompanyCustomerPartnerRole(contextText, company) &&
    !strongCandidatePitchMaterialEvidence &&
    (isCreate || hasDifferentPrimaryTargetEvidence(contextText, normalized) || VETO_MAJOR_CUSTOMER_OR_BUYER_NAMES.has(normalized))
  ) {
    return veto('customer_partner_or_buyer_context', 'record_context');
  }

  if (isCreate && !strongCandidatePitchMaterialEvidence && hasCurrentCompanyFundOrLpRole(contextText, company)) {
    return veto('lp_or_fund_context_not_prospect');
  }

  if (
    hasDifferentPrimaryTargetEvidence(contextText, normalized) &&
    !productPitchParentCompanyEvidence &&
    !directTargetAssertion &&
    (
      hasCurrentCompanyIntroSourceRole(contextText, company) ||
      hasCurrentCompanyInvestorBackingRole(contextText, company) ||
      hasCurrentCompanyCustomerPartnerRole(contextText, company) ||
      (currentCompanyPattern(company) ? new RegExp(`\\bby\\s+${currentCompanyPattern(company)}\\b`, 'i').test(contextText) : false)
    )
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    /\b(?:merely|just|only)\s+(?:a\s+)?(?:video|link|host|venue|customer|deployment|source|advisor|broker|law|legal|meeting)\b/i.test(contextHaystack) ||
    (!productPitchParentCompanyEvidence && /\b(?:not\s+(?:the|an)\s+(?:investment\s+)?(?:target|prospect)|not itself (?:an? )?investment prospect)\b/i.test(contextHaystack)) ||
    hasDifferentActualTarget(contextText, normalized)
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  return { applied: false, reason: null, confidence: null, nonValuableAction: null };
}

function prospectCreateVetoForMention(input: ProspectCreateVetoInput): ProspectCreateVetoDecision {
  if (input.prospectAction !== 'create_prospect') {
    return { applied: false, reason: null, confidence: null };
  }
  const veto = prospectValuableActionVetoForMention(input);
  return { applied: veto.applied, reason: veto.reason, confidence: veto.confidence };
}

function parseSectorKey(value: unknown): SectorKey {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (PROSPECT_SECTOR_KEYS.has(normalized as any)) return normalized as SectorKey;
  throw new Error(`INVALID_LLM_SECTOR_KEY:${normalized || 'empty'}`);
}

function prospectSectorKeyFromCompanySector(value: unknown): { key: SectorKey; confidence: number } {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (PROSPECT_SECTOR_KEYS.has(normalized as any)) return { key: normalized as SectorKey, confidence: 0.8 };
  return { key: 'uncategorized', confidence: 0 };
}

function strictRegistrableDomain(value: string | null | undefined): string | null {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[),.;:]+$/g, '');
  if (!host || !host.includes('.')) return null;
  const labels = host.split('.').filter(Boolean);
  const tld = labels[labels.length - 1] || '';
  if (!/^[a-z]{2,24}$/.test(tld)) return null;
  const domain = registrableDomain(host);
  if (!domain || /^\d+(?:\.\d+)+$/.test(domain)) return null;
  return domain;
}

function domainFromUrl(value: string | null | undefined): string | null {
  const raw = String(value || '').trim().replace(/[),.;:]+$/g, '');
  if (!raw) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
    return strictRegistrableDomain(host);
  } catch {
    return null;
  }
}

function parseOptionalJsonObject(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function companyAuditDomain(row: { domain?: string | null; website?: string | null }): string | null {
  return strictRegistrableDomain(row.domain) || domainFromUrl(row.website);
}

function limitedInfoCompanyReason(row: { domain?: string | null; website?: string | null; custom_fields?: string | null } | null | undefined): string | null {
  if (!row) return null;
  const custom = parseOptionalJsonObject(row.custom_fields);
  const prospectOrigin = custom.prospect_origin && typeof custom.prospect_origin === 'object' ? custom.prospect_origin as Record<string, any> : {};
  const enrichmentGuard = custom.enrichment_guard && typeof custom.enrichment_guard === 'object' ? custom.enrichment_guard as Record<string, any> : {};
  if (custom.limited_info_prospect) return 'limited_info_prospect_company';
  if (prospectOrigin.limited_info === true || prospectOrigin.evidence_quality === 'limited_info') return 'limited_info_prospect_origin';
  if (enrichmentGuard.status === 'blocked_insufficient_anchor') return 'blocked_insufficient_anchor';
  if (!companyAuditDomain(row) && prospectOrigin.created_by_prospect_pipeline === true) return 'prospect_pipeline_company_without_verified_domain';
  return null;
}

function parseUnitConfidence(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`INVALID_LLM_${field.toUpperCase()}`);
  return n;
}

function productionSampleRate(env: Env): number {
  const n = Number(env.PROSPECT_PRODUCTION_SAMPLE_RATE);
  if (!Number.isFinite(n)) return DEFAULT_PROSPECT_PRODUCTION_SAMPLE_RATE;
  return clamp(n, 0, 1);
}

function stableSampleBucket(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function productionSamplingDecision(args: {
  orgId: string;
  item: ClassifiedItem;
  mention: MentionCandidate;
  confidenceTier: ConfidenceTier;
  directionUncertain: boolean;
  env: Env;
}): { sampled: boolean; reason: string | null } {
  if (args.directionUncertain) return { sampled: true, reason: 'direction_uncertain' };
  if (args.confidenceTier === 'medium') return { sampled: true, reason: 'medium_confidence' };
  if (args.confidenceTier === 'low') return { sampled: true, reason: 'low_confidence' };
  const key = `${args.orgId}:${args.item.entityType}:${args.item.entityId}:${args.mention.mentionOrdinal}:${PROSPECT_CLASSIFIER_VERSION}`;
  return stableSampleBucket(key) < productionSampleRate(args.env)
    ? { sampled: true, reason: 'random_live_sample' }
    : { sampled: false, reason: null };
}

export function extractMentionCandidatesFromText(text: string, fallbackName?: string | null, maxCandidates = 12): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  const { cleanedText } = cleanProspectSourceText(text);

  function push(raw: string, canonicalRaw: string, spanStart: number | null, isListEntry: boolean, listFields?: ParsedDealflowListFields): void {
    const { canonicalName, products } = canonicalizeMention(canonicalRaw);
    if (isGenericCandidate(canonicalName)) return;
    if (isOwnFundEntity(canonicalName)) return;
    if (looksLikePersonName(canonicalName)) return;
    const normalizedName = normalizeProspectName(canonicalName);
    if (!normalizedName || seen.has(normalizedName)) return;
    seen.add(normalizedName);
    const end = spanStart == null ? null : spanStart + raw.length;
    const contextText = prospectContextWindow(cleanedText, spanStart, end);
    candidates.push({
      raw,
      canonicalName,
      normalizedName,
      mentionOrdinal: 0,
      spanStart,
      spanEnd: end,
      lineText: spanStart == null ? canonicalName : lineExcerptAt(cleanedText, spanStart, end || spanStart),
      contextText,
      isListEntry,
      products,
      listFields,
    });
  }

  const pushTarget = (raw: string, indexHint = 0): void => {
    const clean = cleanPotentialCompanyName(raw)
      .replace(/\b([A-Z][A-Za-z0-9&.'’-]{2,})\s+\1\b/g, '$1');
    if (!clean || !/^[A-Z0-9]/.test(clean)) return;
    const start = findCaseInsensitive(cleanedText, raw, indexHint);
    push(raw, clean, start < 0 ? null : start, false);
  };

  const pushFieldTarget = (raw: string, indexHint = 0): void => {
    const clean = cleanPotentialCompanyName(raw)
      .replace(/\b([A-Z][A-Za-z0-9&.'’-]{2,})\s+\1\b/g, '$1');
    if (!clean || !/[A-Za-z]/.test(clean)) return;
    const canonical = /^[a-z]/.test(clean) ? clean[0].toUpperCase() + clean.slice(1) : clean;
    const start = findCaseInsensitive(cleanedText, raw, indexHint);
    push(raw, canonical, start < 0 ? null : start, false);
  };

  const leadLines = cleanedText.split(/\n+/).slice(0, 12);
  for (const line of leadLines) {
    const normalizedLine = normalizeWhitespace(line);
    const projectOpportunity = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*(?:exclusive\s+)?investment\s+opportunit(?:y|ies)\s*[:\-]\s*(Project\s+[A-Z0-9][A-Za-z0-9&.'’/-]+)/i);
    if (projectOpportunity?.[1]) pushTarget(projectOpportunity[1], cleanedText.indexOf(line));
    const namedOpportunity = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*(?:exclusive\s+)?investment\s+opportunit(?:y|ies)\s*[:\-]\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,3})(?=\s+(?:series|seed|safe|round|deck|pitch|raise|raising|fundrais|data\s+room|diligence|intro|lab|company|platform|opportunity)\b|$)/i);
    if (namedOpportunity?.[1]) pushTarget(namedOpportunity[1], cleanedText.indexOf(line));
    const introParen = normalizedLine.match(/\b(?:intro(?:duction)?|meet|connecting|connect)\b[^()\n]{0,100}\(([^)]+)\)/i);
    if (introParen?.[1]) pushTarget(introParen[1], cleanedText.indexOf(line));
    const domainSubject = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([a-z0-9-]+\.(?:ai|com|io|co|vc|capital|org|net|health|tech|dev|finance|xyz|systems))\b/i);
    if (domainSubject?.[1]) pushTarget(domainSubject[1], cleanedText.indexOf(line));
    const titleTarget = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s+(?:update|deck|demo|diligence|fundrais(?:e|ing)|series\s+[A-Z]|pitch|follow[-\s]?up|materials)\b/);
    if (titleTarget?.[1]) pushTarget(titleTarget[1], cleanedText.indexOf(line));
    const ampersandMedinaPair = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([A-Z0-9][A-Za-z0-9.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9.'’/-]+){0,4})\s*&\s*Medina(?:\s+Ventures)?\b/i);
    if (ampersandMedinaPair?.[1]) pushTarget(ampersandMedinaPair[1], cleanedText.indexOf(line));
    const medinaPair = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s*(?:<>|<->|x|\/|\band\b)\s*Medina(?:\s+Ventures)?\b/i);
    if (medinaPair?.[1]) pushTarget(medinaPair[1], cleanedText.indexOf(line));
    if (candidates.length >= maxCandidates) break;
  }

  for (const match of cleanedText.matchAll(/\bCompany[ \t]+Name[ \t:=-]+([A-Za-z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Za-z0-9][A-Za-z0-9&.'’/-]+){0,5}?)(?=[ \t]+(?:Company[ \t]+URL|Website|Founder(?:s|\(s\))?|Short[ \t]+Description|Location|Industry|Round[ \t]+Stage)\b)/gi)) {
    pushFieldTarget(match[1] || '', match.index || 0);
    if (candidates.length >= maxCandidates) break;
  }

  for (const match of cleanedText.matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:ai|com|io|co|vc|capital|org|net|gov|mil|edu|health|tech|dev|finance|xyz|systems))\b/gi)) {
    const domain = match[1].toLowerCase();
    if (shouldIgnoreDomain(domain)) continue;
    const raw = match[0];
    push(raw, domainLabelToCompany(domain), match.index ?? null, false);
    if (candidates.length >= maxCandidates) break;
  }

  const highSignalPatterns = [
    /^(?:[-*•]|\d+[.)])?[ \t]*([A-Z][A-Za-z0-9&.'’-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’-]+){0,3}(?:[ \t]*\/[ \t]*[A-Z][A-Za-z0-9&.'’-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’-]+){0,3})+)(?:[ \t]*(?:[-—–:|,]|\(|$))/gm,
    /\bAbout[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})(?=[ \t]+(?:is|has|have|helps|offers|builds|develops|developed|provides|raised|raises|will|was|the|a|an)\b)/g,
    /\b(?:intro(?:ducing)?|meet|warm intro to|introduction to)[ \t]+(?:to[ \t]+|for[ \t]+)?([A-Z][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’/-]+){0,4})\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’/-]+){0,4})[ \t]+(?:is|are|has|have)[ \t]+(?:raising|building|launching|looking|seeking|developing)\b/g,
    /\b(?:deck|memo|diligence|investment|demo|pilot)[ \t]+(?:for|from|with)[ \t]+([A-Z][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’/-]+){0,4})\b/gi,
  ];
  for (const pattern of highSignalPatterns) {
    for (const match of cleanedText.matchAll(pattern)) {
      const raw = normalizeWhitespace(match[1] || '');
      if (!raw) continue;
      if (!/^[A-Z0-9]/.test(raw)) continue;
      const start = findCaseInsensitive(cleanedText, raw, match.index || 0);
      push(raw, raw, start < 0 ? null : start, false);
      if (candidates.length >= maxCandidates) break;
    }
    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length === 0 && fallbackName && !isOwnFundEntity(fallbackName)) {
    push(fallbackName, fallbackName, null, false);
  }

  return candidates
    .sort((a, b) => (a.spanStart ?? Number.MAX_SAFE_INTEGER) - (b.spanStart ?? Number.MAX_SAFE_INTEGER))
    .map((candidate, index) => ({ ...candidate, mentionOrdinal: index + 1 }));
}

function isDealflowListText(text: string): boolean {
  const lines = text.split(/\n+/);
  const listLines = lines
    .filter(line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line) && /[A-Z][A-Za-z0-9&.'’/-]+/.test(line));
  const domainRows = lines.filter(line =>
    /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.(?:ai|com|io|co|health|tech|dev|finance|xyz|systems)\b/i.test(line) &&
    /\b(?:raise|raising|capital|series|seed|safe|round|diligence|pipeline|pre[-\s]?seed|preliminary|radar|prospect|company|problem|approach|solution)\b/i.test(line)
  );
  const distinctDomainRows = new Set(domainRows.flatMap(line => domainMatchesInText(line).map(match => match.value)).filter(Boolean));
  const allDomains = new Set(domainMatchesInText(text).map(match => match.value).filter(Boolean));
  if (listLines.length >= 3) return true;
  if (distinctDomainRows.size >= 3) return true;
  if (
    isInternalPipelineReportText(text) &&
    /\b(?:company\s+fields?|company\s+priority|prospect|pipeline\s+fields?|investment\s+opportunit(?:y|ies)|assigned\s+to|owner|assignee)\b/i.test(text)
  ) {
    return true;
  }
  return /\b(army\s*fuze|armyfuze|cohort|batch|portfolio day|demo day|dealflow list|companies below|shortlist|pipeline status update|pipeline industry pie|internal pipeline report|fund raising packet|fundraising packet|private capital network|raise capital in the next 6 months|investor review)\b/i.test(text) &&
    (listLines.length >= 2 || distinctDomainRows.size >= 2 || allDomains.size >= 3);
}

function fieldAfter(label: string, line: string): string | null {
  const match = line.match(new RegExp(`\\b(?:${label})\\s*[:=-]\\s*([^|;]+)`, 'i'));
  return match ? normalizeWhitespace(match[1]).slice(0, 160) : null;
}

function parseListFields(line: string): ParsedDealflowListFields {
  const amount = line.match(/\$[0-9][0-9.,]*(?:\s?(?:k|m|mm|million|b))?/i)?.[0] || null;
  const website = domainMatchesInText(line)[0]?.value || null;
  const poc = emailInText(line) || fieldAfter('poc|contact|founder', line);
  const stage = line.match(/\b(pre[-\s]?seed|seed|series\s+[abc]|growth|pilot|pre[-\s]?revenue)\b/i)?.[0] || null;
  return {
    stage,
    amount,
    website,
    poc,
    problem: fieldAfter('problem', line),
    approach: fieldAfter('approach|solution', line),
  };
}

function prospectListCandidateFromName(
  text: string,
  raw: string,
  canonicalRaw: string,
  offset: number,
  ordinal: number,
  line: string,
  seen: Set<string>,
  listFields?: ParsedDealflowListFields,
  spanStartOverride?: number | null
): MentionCandidate | null {
  const { canonicalName, products } = canonicalizeMention(canonicalRaw);
  const normalizedName = normalizeProspectName(canonicalName);
  if (!normalizedName || seen.has(normalizedName) || isGenericCandidate(canonicalName) || isOwnFundEntity(canonicalName) || looksLikePersonName(canonicalName)) {
    return null;
  }
  seen.add(normalizedName);
  const localIndex = line.indexOf(raw);
  const spanStart = spanStartOverride != null
    ? spanStartOverride
    : localIndex < 0 ? text.indexOf(raw, Math.max(0, offset)) : offset + localIndex;
  const safeSpanStart = spanStart < 0 ? null : spanStart;
  const spanEnd = safeSpanStart == null ? null : safeSpanStart + raw.length;
  return {
    raw,
    canonicalName,
    normalizedName,
    mentionOrdinal: ordinal,
    spanStart: safeSpanStart,
    spanEnd,
    lineText: line.slice(0, 900),
    contextText: prospectContextWindow(text, safeSpanStart, spanEnd),
    isListEntry: true,
    products,
    listFields,
  };
}

const PIPELINE_REPORT_SOURCE_PREFIX_WORDS = new Set([
  'ad',
  'alumni',
  'accelerator',
  'automatic',
  'berkeley',
  'coast',
  'company',
  'date',
  'description',
  'details',
  'emerge',
  'external',
  'fou',
  'foun',
  'founder',
  'gold',
  'he',
  'in',
  'industry',
  'internal',
  'investment',
  'jim',
  'jimenez',
  'pitch',
  'pdf',
  'priority',
  'ra',
  'radar',
  'report',
  'revenue',
  'round',
  'sm',
  'so',
  'source',
  'status',
  'team',
  'to',
  'tony',
  'uc',
  'update',
  'website',
]);

function isInternalPipelineReportText(text: string): boolean {
  return /\b(?:pipeline\s+(?:status\s+update|industry\s+pie)|automatic_report|company\s+priority\s+status\s+industry)\b/i.test(text);
}

function isGeneratedPipelineReportArtifact(text: string): boolean {
  return /\bautomatic_report\b/i.test(text);
}

function pipelineReportRowNameFromPrefix(rawPrefix: string, rowSeed: string): { raw: string; canonicalRaw: string } | null {
  let prefix = normalizeWhitespace(rawPrefix.replace(/[|•]/g, ' '));
  if (!prefix) return null;
  if (/\b(?:automatic_report|\.pdf|\.docx?|\.xlsx?)\b/i.test(prefix)) return null;
  const domainToken = prefix.match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:ai|com|io|co|health|tech|dev|finance|xyz|systems))\b/i)?.[1];
  if (domainToken && !shouldIgnoreDomain(domainToken)) {
    const canonicalRaw = domainLabelToCompany(domainToken);
    return { raw: domainToken, canonicalRaw };
  }
  let tokens = prefix.split(/\s+/).filter(Boolean);
  const lastSourcePrefixIndex = tokens.reduce((last, token, index) => {
    const key = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    return PIPELINE_REPORT_SOURCE_PREFIX_WORDS.has(key) ? index : last;
  }, -1);
  if (lastSourcePrefixIndex >= 0 && lastSourcePrefixIndex < tokens.length - 1) {
    tokens = tokens.slice(lastSourcePrefixIndex + 1);
  }
  while (tokens.length > 1 && PIPELINE_REPORT_SOURCE_PREFIX_WORDS.has(tokens[0].toLowerCase().replace(/[^a-z0-9]/g, ''))) {
    tokens = tokens.slice(1);
  }
  while (tokens.length > 1 && PIPELINE_REPORT_SOURCE_PREFIX_WORDS.has(tokens[tokens.length - 1].toLowerCase().replace(/[^a-z0-9]/g, ''))) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length > 5) tokens = tokens.slice(-5);
  while (tokens.length > 1 && PIPELINE_REPORT_SOURCE_PREFIX_WORDS.has(tokens[0].toLowerCase().replace(/[^a-z0-9]/g, ''))) {
    tokens = tokens.slice(1);
  }
  while (tokens.length > 1 && PIPELINE_REPORT_SOURCE_PREFIX_WORDS.has(tokens[tokens.length - 1].toLowerCase().replace(/[^a-z0-9]/g, ''))) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length > 2) {
    let trailingAcronymStart = -1;
    for (let index = tokens.length - 1; index >= 0; index--) {
      const token = tokens[index].replace(/[^A-Za-z0-9]/g, '');
      if (!/^[A-Z0-9]{2,}$/.test(token)) continue;
      const previous = index > 0 ? tokens[index - 1].replace(/[^A-Za-z0-9]/g, '') : '';
      if (index === 0 || !/^[A-Z0-9]{2,}$/.test(previous)) {
        trailingAcronymStart = index;
        break;
      }
    }
    if (trailingAcronymStart > 0 && tokens.slice(trailingAcronymStart).length >= 2) {
      tokens = tokens.slice(trailingAcronymStart);
    }
  }
  let raw = normalizeWhitespace(tokens.join(' '));
  if (!raw) return null;
  const website = domainMatchesInText(rowSeed)[0]?.value || null;
  if (website && !shouldIgnoreDomain(website)) {
    const domainAliases = prospectIdentityAliasesForName(domainLabelToCompany(website));
    const suffixes: string[] = [];
    const rawTokens = raw.split(/\s+/).filter(Boolean);
    for (let length = Math.min(4, rawTokens.length); length >= 1; length--) {
      suffixes.push(rawTokens.slice(-length).join(' '));
    }
    const compatibleSuffix = suffixes.find(suffix => identityAliasSetsCompatible(prospectIdentityAliasesForName(suffix), domainAliases));
    if (compatibleSuffix) raw = compatibleSuffix;
  }
  raw = cleanPotentialCompanyName(raw);
  if (/[.!?]\s+[A-Z0-9]/.test(raw)) {
    const lastSegment = normalizeWhitespace(raw.split(/[.!?]\s+/).pop() || '');
    if (lastSegment && !looksLikePersonName(lastSegment)) raw = lastSegment;
  }
  if (website && !shouldIgnoreDomain(website)) {
    const rawTokens = raw.split(/\s+/).filter(Boolean);
    const lastToken = rawTokens[rawTokens.length - 1] || '';
    if (
      rawTokens.length > 1 &&
      /^[A-Z0-9]{2,6}$/.test(lastToken.replace(/[^A-Za-z0-9]/g, '')) &&
      identityAliasSetsCompatible(prospectIdentityAliasesForName(lastToken), prospectIdentityAliasesForName(domainLabelToCompany(website)))
    ) {
      raw = lastToken;
    }
  }
  if (!raw || looksLikePersonName(raw) || isGenericFragmentCandidate(raw)) return null;
  const normalizedRawWords = raw.split(/\s+/).map(token => token.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (
    normalizedRawWords.length > 0 &&
    normalizedRawWords.every(token => PIPELINE_REPORT_SOURCE_PREFIX_WORDS.has(token) || /^(?:name|url|field|fields|owner|assignee|added|rounds?)$/.test(token))
  ) {
    return null;
  }
  const extension = rowSeed.match(new RegExp(`\\b${escapeRegExp(raw)}\\s+(?:Solutions|Technologies|Technology|Systems|Labs|AI|Core|Tech)\\b`, 'i'))?.[0];
  const canonicalRaw = cleanCorrectedTargetName(extension || raw) || raw;
  return { raw, canonicalRaw };
}

function addInternalPipelineReportRows(
  source: string,
  candidates: MentionCandidate[],
  seen: Set<string>,
  startingOrdinal: number
): number {
  if (!isInternalPipelineReportText(source)) return startingOrdinal;
  const rowPattern = /\b([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,7})\s+(?:\([^)]{1,32}\)\s+)?(LOW|MEDIUM|HIGH)\s+(?:Radar|Initial\s+Meeting|Preliminary(?:\s+(?:IC\s*\/\s*Term\s*Sheet|Diligence))?|Diligence|Term\s*Sheet|IC|Active|New)\b/g;
  const fieldLabelPattern = String.raw`(?:[Aa]ssigned\s+[Tt]o|[Oo]wner|[Aa]ssignee|[Ss]tatus|[Ii]ndustry|[Ii]nvestment\s+[Rr]ound|[Rr]ound\s+[Dd]etails|[Rr]evenue|[Ll]ocation|[Ww]ebsite|[Dd]ate\s+[Aa]dded|[Dd]escription|[Ss]ource|[Ii]nternal\s+[Ss]ource|[Ee]xternal\s+[Ss]ource|[Ff]ounder\/[Tt]eam|[Pp]rospect\s+[Ss]tatus)`;
  const fieldAnchoredPattern = new RegExp(String.raw`\b([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){1,7}?)\s+(?=${fieldLabelPattern}\b)`, 'g');
  const priorityMatches = Array.from(source.matchAll(rowPattern));
  const fieldMatches = Array.from(source.matchAll(fieldAnchoredPattern))
    .filter(match => {
      if (!/^[A-Z0-9]/.test(match[1] || '')) return false;
      const start = match.index || 0;
      const rowWindow = source.slice(start, Math.min(source.length, start + 520));
      return /\b(?:assigned\s+to|owner|assignee|prospect|pipeline|investment\s+opportunit(?:y|ies)|product|platform|technology|description|revenue|traction|company\s+fields?)\b/i.test(rowWindow) &&
        /\b(?:prospect|pipeline|investment|deal\s*flow|product|platform|technology|review|assignment|assigned)\b/i.test(rowWindow);
    })
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .filter((match, index, allMatches) => index === 0 || (match.index || 0) !== (allMatches[index - 1].index || 0));
  let ordinal = startingOrdinal;
  const parseMatches = (matches: RegExpMatchArray[]) => matches.map((match, index) => {
      const rawPrefix = normalizeWhitespace(match[1] || '');
      const nextStart = matches[index + 1]?.index ?? source.length;
      const rowSeed = source.slice(match.index || 0, Math.min(source.length, nextStart));
      const name = pipelineReportRowNameFromPrefix(rawPrefix, rowSeed);
      if (!name) return null;
      const localNameIndex = findCaseInsensitive(rawPrefix, name.raw, 0);
      const nameStart = (match.index || 0) + (localNameIndex >= 0 ? localNameIndex : 0);
      return {
        nameStart,
        nextMatchStart: nextStart,
        raw: name.raw,
        canonicalRaw: name.canonicalRaw,
      };
    }).filter((entry): entry is { nameStart: number; nextMatchStart: number; raw: string; canonicalRaw: string } => Boolean(entry));
  const parsed = [...parseMatches(priorityMatches), ...parseMatches(fieldMatches)]
    .sort((a, b) => a.nameStart - b.nameStart);

  for (const entry of parsed) {
    const line = source.slice(entry.nameStart, entry.nextMatchStart).trim();
    const candidate = prospectListCandidateFromName(source, entry.raw, entry.canonicalRaw, entry.nameStart, ordinal, line, seen, parseListFields(line), entry.nameStart);
    if (candidate) {
      candidates.push(candidate);
      ordinal++;
    }
  }
  return ordinal;
}

function leadingCompanyNameBeforeDomain(line: string, domain: string): string | null {
  const structuredCompanyName = line.match(/\bCompany\s+Name\s+([A-Za-z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Za-z0-9][A-Za-z0-9&.'’/-]+){0,5}?)(?=\s+(?:Company\s+URL|Website|URL|Founder(?:s|\(s\))?|Short\s+Description|Location|Industry|Round\s+Stage|Contact|Email)\b)/i)?.[1];
  const cleanedStructuredCompanyName = cleanCorrectedTargetName(structuredCompanyName || '');
  if (cleanedStructuredCompanyName) return cleanedStructuredCompanyName;
  const domainBrand = domainLabelToCompany(domain);
  const domainBrandAliases = prospectIdentityAliasesForName(domainBrand);
  const domainIndex = line.toLowerCase().indexOf(domain.toLowerCase());
  const beforeDomain = line.slice(0, Math.max(0, domainIndex));
  const nearbyBeforeDomain = domainIndex >= 0 ? line.slice(Math.max(0, domainIndex - 220), domainIndex) : beforeDomain.slice(-220);
  const companyBeforeTitle = nearbyBeforeDomain.match(/([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z][A-Za-z0-9&.'’/-]+){0,5})\s+(?:CEO|CTO|CFO|COO|VP|Founder|Co[-\s]?Founder|President|Director|Head|Chief)\b/i)?.[1];
  const cleanedCompanyBeforeTitle = companyBeforeTitle ? cleanPotentialCompanyName(companyBeforeTitle) : null;
  if (
    cleanedCompanyBeforeTitle &&
    /^[A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5}$/.test(cleanedCompanyBeforeTitle) &&
    !looksLikePersonName(cleanedCompanyBeforeTitle) &&
    (
      hasCompanyToken(cleanedCompanyBeforeTitle) ||
      /\b(?:ai|labs?|systems?|technolog(?:y|ies)|energy|aircraft|micro|semiconductor|robotics|health|bio|therapeutics|aerospace|defense|solutions|analytics|cyber|security)\b/i.test(cleanedCompanyBeforeTitle)
    )
  ) {
    if (identityAliasSetsCompatible(prospectIdentityAliasesForName(cleanedCompanyBeforeTitle), domainBrandAliases)) {
      return domainBrand;
    }
    return cleanedCompanyBeforeTitle;
  }
  const withoutEmail = beforeDomain.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ');
  const segments = withoutEmail
    .split(/\s{2,}|[|;•]/g)
    .map(segment => normalizeWhitespace(segment))
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = cleanPotentialCompanyName(segments[i]);
    if (/^[A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5}$/.test(segment) && !looksLikePersonName(segment)) {
      return segment;
    }
  }
  for (const match of line.matchAll(/\b[A-Z][A-Za-z0-9&.'’/-]{2,60}(?:['’]s)?\b/g)) {
    const clean = normalizeWhitespace(String(match[0] || '').replace(/['’]s$/i, ''));
    if (!clean || looksLikePersonName(clean)) continue;
    const cleanAliases = prospectIdentityAliasesForName(clean);
    if (cleanAliases.has(normalizeProspectName(domainBrand))) return clean;
    if (normalizeProspectName(clean).length >= normalizeProspectName(domainBrand).length && identityAliasSetsCompatible(cleanAliases, domainBrandAliases)) return clean;
  }
  return null;
}

export function parseDealflowList(text: string, fallbackName?: string | null): MentionCandidate[] {
  const source = repairBrokenDomainWhitespace(String(text || ''));
  if (!isDealflowListText(source)) {
    return extractMentionCandidatesFromText(source, fallbackName);
  }
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  let ordinal = 1;
  let offset = 0;
  for (const line of source.split(/\n+/)) {
    const trimmed = line.trim();
    const isListEntry = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    if (!isListEntry) {
      offset += line.length + 1;
      continue;
    }
    const name = trimmed.match(/^(?:[-*•]|\d+[.)])\s*([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z][A-Za-z0-9&.'’/-]+){0,4})(?:\s*(?:[-—–:|,]|\s\/\s|\(|$))/)?.[1];
    if (!name) {
      offset += line.length + 1;
      continue;
    }
    const candidate = prospectListCandidateFromName(source, name, name, offset, ordinal, line, seen, parseListFields(line));
    if (candidate) {
      candidates.push(candidate);
      ordinal++;
    }
    offset += line.length + 1;
  }

  ordinal = addInternalPipelineReportRows(source, candidates, seen, ordinal);

  offset = 0;
  for (const line of source.split(/\n+/)) {
    const domainMatches = domainMatchesInText(line);
    const hasDealflowFields = /\b(?:raise|raising|capital|series|seed|safe|round|diligence|pipeline|pre[-\s]?seed|preliminary|radar|prospect|company|problem|approach|solution|valuation|allocation)\b/i.test(line);
    if (domainMatches.length > 0 && hasDealflowFields) {
      const domainsSeenOnLine = new Set<string>();
      for (const domainMatch of domainMatches) {
        const domain = domainMatch.value;
        if (!domain || shouldIgnoreDomain(domain) || domainsSeenOnLine.has(domain)) continue;
        const domainLabel = domain.split('.')[0].replace(/[^a-z0-9]+/g, '');
        const isNearbySuffixFragment = domainLabel.length <= 8 && domainMatches.some(other => {
          if (other === domainMatch) return false;
          const otherLabel = other.value.split('.')[0].replace(/[^a-z0-9]+/g, '');
          return Math.abs(other.start - domainMatch.start) <= 120 &&
            otherLabel.length >= domainLabel.length + 3 &&
            otherLabel.endsWith(domainLabel);
        });
        if (isNearbySuffixFragment) continue;
        domainsSeenOnLine.add(domain);
        const absoluteDomainStart = offset + domainMatch.start;
        const rowLine = rowContextAroundAnchor(source, absoluteDomainStart, domain.length, 2200) || line;
        const rowOffset = source.indexOf(rowLine);
        const raw = leadingCompanyNameBeforeDomain(rowLine, domain) || domain;
        const canonicalRaw = raw === domain ? domainLabelToCompany(domain) : raw;
        const rawIndexInRow = rowLine.indexOf(raw);
        const spanOverride = raw === domain
          ? absoluteDomainStart
          : rowOffset >= 0 && rawIndexInRow >= 0 ? rowOffset + rawIndexInRow : null;
        const candidate = prospectListCandidateFromName(source, raw, canonicalRaw, rowOffset >= 0 ? rowOffset : offset, ordinal, rowLine, seen, {
        ...parseListFields(rowLine),
        website: domain,
      }, spanOverride);
        if (candidate) {
          candidates.push(candidate);
          ordinal++;
        }
      }
    }
    offset += line.length + 1;
  }

  for (const match of source.matchAll(/\bCompany[ \t]+Name[ \t:=-]+([A-Za-z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Za-z0-9][A-Za-z0-9&.'’/-]+){0,5}?)(?=[ \t]+(?:Company[ \t]+URL|Website|Founder(?:s|\(s\))?|Short[ \t]+Description|Location|Industry|Round[ \t]+Stage|Contact|Email)\b)/gi)) {
    const raw = normalizeWhitespace(match[1] || '');
    const lineStart = source.lastIndexOf('\n', match.index || 0) + 1;
    const lineEnd = source.indexOf('\n', match.index || 0);
    const line = source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const candidate = prospectListCandidateFromName(source, raw, raw, lineStart, ordinal, line, seen, parseListFields(line));
    if (candidate) {
      candidates.push(candidate);
      ordinal++;
    }
  }

  if (candidates.length === 0 && fallbackName) {
    return extractMentionCandidatesFromText(source, fallbackName);
  }
  return candidates;
}

function mentionFromAnchoredRaw(
  cleanedText: string,
  raw: string,
  canonicalRaw: string,
  spanStart: number | null,
  isListEntry: boolean,
  listFields?: ParsedDealflowListFields
): MentionCandidate | null {
  const { canonicalName, products } = canonicalizeMention(canonicalRaw);
  if (isGenericCandidate(canonicalName) || isOwnFundEntity(canonicalName)) return null;
  if (looksLikePersonName(canonicalName)) return null;
  const normalizedName = normalizeProspectName(canonicalName);
  if (!normalizedName) return null;
  const spanEnd = spanStart == null ? null : spanStart + raw.length;
  return {
    raw,
    canonicalName,
    normalizedName,
    mentionOrdinal: 0,
    spanStart,
    spanEnd,
    lineText: spanStart == null ? canonicalName : lineExcerptAt(cleanedText, spanStart, spanEnd || spanStart),
    contextText: prospectContextWindow(cleanedText, spanStart, spanEnd),
    isListEntry,
    products,
    listFields,
  };
}

function sourceTextForOrgExtraction(item: ClassifiedItem): string {
  const seen = new Set<string>();
  return [
    item.subject || '',
    item.bodyText || '',
    item.text || '',
  ].filter(Boolean).filter(part => {
    const key = normalizeWhitespace(part).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n');
}

function sourceEvidenceDomainsForOrgExtraction(item: ClassifiedItem, env?: Env): string[] {
  const emails = [
    (item as any).fromEmail,
    ...(((item as any).toEmails || []) as unknown[]),
    ...(((item as any).ccEmails || []) as unknown[]),
  ].map(value => String(value || '')).filter(Boolean);
  const domains: string[] = [];
  for (const email of emails) {
    const match = email.match(/@([a-z0-9.-]+\.[a-z]{2,})\b/i);
    const domain = match?.[1]?.toLowerCase().replace(/^www\./, '') || '';
    if (!domain || shouldIgnoreDomain(domain, env)) continue;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function sourceEvidenceNamesForOrgExtraction(item: ClassifiedItem, cleanedText: string, env?: Env): string[] {
  const names: string[] = [];
  const push = (raw: string | null | undefined): void => {
    const clean = cleanCorrectedTargetName(raw);
    if (!clean) return;
    const normalized = normalizeProspectName(clean);
    if (!normalized || names.some(name => normalizeProspectName(name) === normalized)) return;
    names.push(clean);
  };
  push(sourceTitleTargetNameForOrgExtraction(item, cleanedText));
  push(sourceTitleTargetName(item.metadata?.entity_name));
  for (const domain of sourceEvidenceDomainsForOrgExtraction(item, env)) {
    push(domainLabelToCompany(domain));
  }
  for (const match of cleanedText.matchAll(/\b([A-Z][A-Za-z0-9&.'’/-]{2,60})[_\s-]+(?:one|1|two|2)[-\s]?pager\b/gi)) {
    push(match[1]);
  }
  return names;
}

function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  const a = normalizeProspectName(left);
  const b = normalizeProspectName(right);
  if (a === b) return 0;
  if (!a || !b) return maxDistance + 1;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length] ?? maxDistance + 1;
}

function sourceEvidenceCanCorrectMentionName(mentionName: string, evidenceName: string): boolean {
  const mention = normalizeProspectName(mentionName);
  const evidence = normalizeProspectName(evidenceName);
  if (!mention || !evidence || mention === evidence) return false;
  if (mention.length < 5 || evidence.length < 5) return false;
  if (mention.includes(evidence) || evidence.includes(mention)) return true;
  const maxDistance = Math.max(1, Math.min(2, Math.floor(Math.max(mention.length, evidence.length) / 5)));
  return boundedEditDistance(mention, evidence, maxDistance) <= maxDistance;
}

function embeddedSourceTokenCorrection(mention: MentionCandidate, cleanedText: string): string | null {
  const current = stripTrailingMaterialWrapper(stripFounderPersonWrapper(mention.canonicalName));
  const currentNormalized = normalizeProspectName(current);
  if (!currentNormalized || currentNormalized.length < 5 || currentNormalized.length > 14) return null;
  if (typeof mention.spanStart !== 'number' || typeof mention.spanEnd !== 'number') return null;
  const text = String(cleanedText || '');
  if (!text) return null;
  let left = Math.max(0, Math.min(text.length, mention.spanStart));
  let right = Math.max(left, Math.min(text.length, mention.spanEnd));
  while (left > 0 && /[A-Za-z0-9&.'’/-]/.test(text[left - 1] || '')) left--;
  while (right < text.length && /[A-Za-z0-9&.'’/-]/.test(text[right] || '')) right++;
  const fullToken = normalizeWhitespace(text.slice(left, right).replace(/['’]s$/i, ''));
  const fullNormalized = normalizeProspectName(fullToken);
  if (!fullNormalized || fullNormalized === currentNormalized) return null;
  if (!fullNormalized.endsWith(currentNormalized) || fullNormalized.length < currentNormalized.length + 3) return null;
  if (isGenericCandidate(fullToken) || isOwnFundEntity(fullToken) || looksLikePersonName(fullToken)) return null;
  const canonical = canonicalizeMention(fullToken).canonicalName;
  const canonicalNormalized = normalizeProspectName(canonical);
  if (!canonicalNormalized || canonicalNormalized === currentNormalized) return null;
  return canonicalizeKnownProspectAliasDisplay(canonical);
}

function correctMentionNameFromSourceEvidence(
  mention: MentionCandidate,
  item: ClassifiedItem,
  cleanedText: string,
  env?: Env
): MentionCandidate {
  const evidenceNames = sourceEvidenceNamesForOrgExtraction(item, cleanedText, env);
  const current = stripTrailingMaterialWrapper(stripFounderPersonWrapper(mention.canonicalName));
  const currentNormalized = normalizeProspectName(current);
  const exactEvidence = evidenceNames.find(name => normalizeProspectName(name) === currentNormalized);
  const closeEvidence = exactEvidence || evidenceNames.find(name => sourceEvidenceCanCorrectMentionName(current, name));
  const embeddedCorrection = embeddedSourceTokenCorrection(mention, cleanedText);
  const canonicalName = embeddedCorrection || closeEvidence || current;
  const normalizedName = normalizeProspectName(canonicalName);
  if (!normalizedName || isGenericCandidate(canonicalName) || isOwnFundEntity(canonicalName) || looksLikePersonName(canonicalName)) {
    return mention;
  }
  if (canonicalName === mention.canonicalName && normalizedName === mention.normalizedName) return mention;
  return {
    ...mention,
    canonicalName,
    normalizedName,
  };
}

function orgExtractionKindForItem(item: ClassifiedItem): 'meeting' | 'document' | 'email' {
  if (item.type === 'calendar_event' || item.entityType === 'event') return 'meeting';
  if ((item as any).entityType === 'document') return 'document';
  return 'email';
}

function exactAnchoredMention(
  cleanedText: string,
  raw: string,
  canonicalRaw = raw,
  indexHint = 0,
  isListEntry = false,
  listFields?: ParsedDealflowListFields
): MentionCandidate | null {
  const sourceRaw = normalizeWhitespace(raw);
  if (!sourceRaw) return null;
  const start = findCaseInsensitive(cleanedText, sourceRaw, Math.max(0, indexHint));
  return mentionFromAnchoredRaw(cleanedText, sourceRaw, canonicalRaw, start < 0 ? null : start, isListEntry, listFields);
}

function extractTargetNamesFromPatterns(text: string, patterns: RegExp[]): Array<{ raw: string; index: number }> {
  const out: Array<{ raw: string; index: number }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = cleanPotentialCompanyName(match[1] || '');
      if (!raw || raw.length < 3 || raw.length > 90) continue;
      const index = typeof match.index === 'number' ? match.index : 0;
      out.push({ raw, index });
    }
  }
  return out;
}

function extractMeetingStructuredMentions(
  item: ClassifiedItem,
  cleanedText: string,
  recoveryMode: boolean
): MentionCandidate[] {
  const title = normalizeWhitespace(item.subject || '').replace(/^(?:re|fw|fwd)\s*:\s*/i, '');
  const candidates: MentionCandidate[] = [];
  const push = (raw: string, indexHint = 0, canonicalRaw = raw): void => {
    const mention = exactAnchoredMention(cleanedText, raw, canonicalRaw, indexHint, false);
    if (mention) candidates.push(mention);
  };

  const titlePatterns = [
    /^(?:intro\s+call|intro(?:duction)?|meeting|call|demo|pitch|diligence)\s*[:\-]\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\b/i,
    /^([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:intro|demo|pitch|diligence|fundrais(?:e|ing)|update|overview)\b/i,
    /^([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s*(?:<>|<->|x|\/|\band\b)\s*Medina(?:\s+Ventures)?\b/i,
    /^Medina(?:\s+Ventures)?\s*(?:<>|<->|x|\/|\band\b)\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\b/i,
  ];
  for (const pattern of titlePatterns) {
    const match = title.match(pattern);
    if (match?.[1]) push(match[1], 0);
  }

  const lead = cleanedText.split(/\n+/).slice(0, recoveryMode ? 80 : 40).join('\n');
  const meetingPatterns = [
    /\b(?:founder|co[-\s]?founder|ceo|chief[ \t]+executive|president)[ \t]+(?:of|at|from)[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\b/gi,
    /\b(?:we|we're|we[ \t]+are|our[ \t]+company)[ \t]+(?:at|from)[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\b/gi,
    /\b(?:demo|pitch|overview|presentation|diligence|data[ \t]+room|financial[ \t]+model|fundrais(?:e|ing)|raise|round)[ \t]+(?:for|from|with|by|on)[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\b/gi,
    /\b([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})[ \t]+(?:is|are|has|have)[ \t]+(?:raising|fundraising|building|developing|launching|seeking|looking[ \t]+for|selling[ \t]+into|piloting|deploying)\b/g,
    /\b(?:introduced|introducing|presented|presenting|pitched|pitching|shared|sharing)[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})[ \t]+(?:to|with|for)[ \t]+(?:Medina|the[ \t]+fund)\b/gi,
  ];
  for (const { raw, index } of extractTargetNamesFromPatterns(lead, meetingPatterns)) {
    push(raw, index);
  }
  for (const target of collectPrimaryTargetNames(lead)) {
    push(target, findCaseInsensitive(cleanedText, target));
  }
  return candidates;
}

function extractDocumentStructuredMentions(
  item: ClassifiedItem,
  cleanedText: string,
  recoveryMode: boolean,
  env?: Env
): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  const push = (raw: string, indexHint = 0, canonicalRaw = raw, listFields?: ParsedDealflowListFields): void => {
    const mention = exactAnchoredMention(cleanedText, raw, canonicalRaw, indexHint, false, listFields);
    if (mention) candidates.push(mention);
  };

  const titleish = [
    item.subject || '',
    (item as any).fileName || '',
    (item as any).file_name || '',
  ].filter(Boolean).join('\n');
  for (const line of titleish.split(/\n+/).slice(0, 4)) {
    const clean = normalizeWhitespace(line)
      .replace(/\.(?:pdf|pptx?|docx?|xlsx?|csv|zip)$/i, '')
      .replace(/\b(?:confidential|pitch\s+deck|deck|pitch|memo|overview|teaser|cim|investment\s+memo|data\s+room)\b/gi, ' ')
      .replace(/[_-]+/g, ' ')
      .trim();
    if (clean && clean !== line && clean.length >= 3 && clean.length <= 80) push(line, 0, clean);
  }

  const lead = cleanedText.split(/\n+/).slice(0, recoveryMode ? 300 : 180).join('\n');
  const headerTarget = lead.match(/\b([A-Z][A-Z0-9&.'’/-]+(?:\s+[A-Z][A-Z0-9&.'’/-]+){0,5})\s+(?:Introduction|Overview|Investor\s+Overview|Roadshow)\b[\s\S]{0,260}\b(?:Capitalization|Equity|Funding|Valuation|Clinical[-\s]?Stage|Commercial\s+Revenues?|Shareholder|Investment|Round)\b/)?.[1];
  if (headerTarget) push(headerTarget, findCaseInsensitive(cleanedText, headerTarget));
  const nextDocumentFieldLabel = String.raw`Company\s+URL|Website|URL|Founder(?:s|\(s\))?|Short\s+Description|Location|Industry|Round\s+Stage|Contact|Email`;
  const documentPatterns = [
    new RegExp(String.raw`\b(?:Company\s+Name|Target\s+Company|Issuer|Business)\s*[:=-]?\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+(?!(?:${nextDocumentFieldLabel})\b)[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})(?=\s+(?:${nextDocumentFieldLabel})\b|[\n.;,]|$)`, 'gi'),
    /\b(?:About|Overview[ \t]+of|Profile[ \t]+of)[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})(?=[ \t]+(?:is|has|have|helps|offers|builds|develops|provides|raised|raises|$))/g,
    /\b([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})[ \t]+(?:is|has|builds|develops|offers|provides|raised|raises|is[ \t]+raising|seeks|is[ \t]+seeking)\b/g,
    /\b(?:deck|memo|teaser|cim|investment[ \t]+memo|data[ \t]+room|diligence[ \t]+package)[ \t]+(?:for|from|on)[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})\b/gi,
  ];
  for (const { raw, index } of extractTargetNamesFromPatterns(lead, documentPatterns)) {
    push(raw, index);
  }
  for (const match of lead.matchAll(/\b(?:Website|URL|Company\s+URL|Domain)\s*[:=-]\s*((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z0-9.-]+)\b/gi)) {
    const raw = match[1] || '';
    const domain = domainFromUrl(raw);
    if (domain && !shouldIgnoreDomain(domain, env)) push(raw, match.index || 0, domainLabelToCompany(domain), { website: raw });
  }
  for (const target of collectPrimaryTargetNames(lead)) {
    push(target, findCaseInsensitive(cleanedText, target));
  }
  return candidates;
}

function sourceCanUseStructuredRecovery(item: ClassifiedItem): boolean {
  const kind = orgExtractionKindForItem(item);
  if (kind === 'meeting' || kind === 'document') return true;
  const text = `${item.subject || ''}\n${item.bodyPreview || ''}\n${item.bodyText || ''}\n${item.text || ''}`;
  return hasStrongSourceInvestmentIntent(text) ||
    /\b(?:investment\s+opportunit(?:y|ies)|exclusive\s+investment|investor\s+(?:update|report|letter|memo|communication)|financing\s+(?:update|report|memo)|shareholder\s+(?:letter|update)|data\s+room|diligence|financial\s+model|term\s+sheet|pitch\s+deck|deck\s+attached|founder\s+intro|warm\s+intro|fundrais(?:e|ing)|raising|series\s+[abc]|seed\s+round|safe)\b/i.test(text);
}

export function extractStructuredTargetMentionsFromSource(
  item: ClassifiedItem,
  cleanedText: string,
  options: { recoveryMode?: boolean; env?: Env; existingMentions?: MentionCandidate[] } = {}
): MentionCandidate[] {
  const kind = orgExtractionKindForItem(item);
  if (kind === 'email' && (options.recoveryMode !== true || !sourceCanUseStructuredRecovery(item))) return [];
  const raw = kind === 'meeting'
    ? extractMeetingStructuredMentions(item, cleanedText, options.recoveryMode === true)
    : extractDocumentStructuredMentions(item, cleanedText, options.recoveryMode === true, options.env);
  const existing = new Set((options.existingMentions || []).map(mention => mention.normalizedName));
  return renumberMentionCandidates(dedupeMentionIdentityCandidates(raw, options.env))
    .filter(mention => !existing.has(mention.normalizedName));
}

function sourceContextForOrgExtraction(item: ClassifiedItem): string {
  const parts = [
    `source_type: ${sourceTypeForPrompt(item)}`,
    item.fromName || item.fromEmail ? `from: ${normalizeWhitespace(`${item.fromName || ''} ${item.fromEmail || ''}`)}` : '',
    item.subject ? `subject: ${item.subject}` : '',
    item.toEmails?.length ? `to: ${item.toEmails.slice(0, 8).join(', ')}` : '',
    item.ccEmails?.length ? `cc: ${item.ccEmails.slice(0, 8).join(', ')}` : '',
    item.direction ? `source direction field: ${item.direction}` : '',
  ].filter(Boolean);
  return compactClassifierText(parts.join(' | '), 900);
}

function shouldRunOrgExtractionLlm(cleanedText: string, deterministicMentionCount: number): boolean {
  const compact = normalizeWhitespace(cleanedText);
  if (compact.length < 40) return false;
  if (!/[A-Z][A-Za-z0-9&.'’-]{2,}/.test(cleanedText)) return false;
  if (/^(?:sent|from|to|cc|subject|date|fwd|re)\b/i.test(compact)) return false;
  if (deterministicMentionCount > 0 && !/\b(?:also|with|from|including|includes|customer|vendor|partner|law firm|counsel|accelerator|cohort|portfolio|introduced by|via)\b/i.test(compact)) {
    return false;
  }
  return true;
}

function anchorLlmOrganization(cleanedText: string, org: ProspectOrgExtractionLlmOutput): { raw: string; canonicalRaw: string; spanStart: number } | null {
  const candidates = [
    typeof org.raw === 'string' ? normalizeWhitespace(org.raw) : '',
    normalizeWhitespace(org.name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const start = findCaseInsensitive(cleanedText, candidate);
    if (start >= 0) return { raw: cleanedText.slice(start, start + candidate.length), canonicalRaw: org.name, spanStart: start };
  }
  return null;
}

function addMentionCandidate(target: Map<string, MentionCandidate>, candidate: MentionCandidate | null): void {
  if (!candidate) return;
  const existing = target.get(candidate.normalizedName);
  if (!existing) {
    target.set(candidate.normalizedName, candidate);
    return;
  }
  const existingStart = existing.spanStart ?? Number.MAX_SAFE_INTEGER;
  const nextStart = candidate.spanStart ?? Number.MAX_SAFE_INTEGER;
  if (nextStart < existingStart) target.set(candidate.normalizedName, candidate);
}

function renumberMentionCandidates(candidates: MentionCandidate[]): MentionCandidate[] {
  return candidates
    .sort((a, b) => (a.spanStart ?? Number.MAX_SAFE_INTEGER) - (b.spanStart ?? Number.MAX_SAFE_INTEGER))
    .map((candidate, index) => ({ ...candidate, mentionOrdinal: index + 1 }));
}

function addKnownContextMentions(
  mentions: Map<string, MentionCandidate>,
  cleanedText: string,
  knownContext: ProspectClassifierKnownContext | undefined,
  env: Env
): void {
  if (!knownContext) return;
  for (const entity of knownContext.knownDeals) {
    const name = normalizeWhitespace(entity.name || '');
    if (name) {
      const start = findCaseInsensitive(cleanedText, name);
      if (start >= 0) addMentionCandidate(mentions, mentionFromAnchoredRaw(cleanedText, cleanedText.slice(start, start + name.length), name, start, false));
    }
    const domain = String(entity.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (domain && !shouldIgnoreDomain(domain, env)) {
      const start = findCaseInsensitive(cleanedText, domain);
      if (start >= 0) addMentionCandidate(mentions, mentionFromAnchoredRaw(cleanedText, cleanedText.slice(start, start + domain.length), name || domainLabelToCompany(domain), start, false));
    }
  }
  for (const entity of knownContext.knownDealmakers) {
    const domain = String(entity.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (!domain || shouldIgnoreDomain(domain, env)) continue;
    const start = findCaseInsensitive(cleanedText, domain);
    if (start >= 0) addMentionCandidate(mentions, mentionFromAnchoredRaw(cleanedText, cleanedText.slice(start, start + domain.length), domainLabelToCompany(domain), start, false));
  }
}

export async function extractOrganizationMentionsFromSource(
  item: ClassifiedItem,
  orgId: string,
  env: Env,
  options: ProspectOrganizationExtractionOptions = {}
): Promise<MentionCandidate[]> {
  const rawText = sourceTextForOrgExtraction(item);
  const { cleanedText } = cleanProspectSourceText(rawText);
  if (!cleanedText) return [];

  const mentions = new Map<string, MentionCandidate>();
  if (isDealflowListText(cleanedText)) {
    for (const mention of parseDealflowList(cleanedText, options.fallbackName)) {
      addMentionCandidate(mentions, { ...mention, mentionOrdinal: 0 });
    }
  }
  for (const mention of extractStructuredTargetMentionsFromSource(item, cleanedText, {
    recoveryMode: options.recoveryMode === true,
    existingMentions: options.existingMentions,
    env,
  })) {
    addMentionCandidate(mentions, { ...mention, mentionOrdinal: 0 });
  }
  const titleTarget = sourceTitleTargetNameForOrgExtraction(item, cleanedText);
  if (titleTarget) {
    const titleMention = exactAnchoredMention(cleanedText, titleTarget, titleTarget, 0, false);
    if (titleMention) addMentionCandidate(mentions, { ...titleMention, mentionOrdinal: 0 });
  }
  for (const mention of extractMentionCandidatesFromText(cleanedText, options.fallbackName, 24)) {
    addMentionCandidate(mentions, { ...mention, mentionOrdinal: 0 });
  }
  addKnownContextMentions(mentions, cleanedText, options.knownContext, env);

  if (options.allowLlm !== false && (options.forceLlm || shouldRunOrgExtractionLlm(cleanedText, mentions.size))) {
    const llmExtract = options.llmExtractor || ((input: ProspectOrgExtractionLlmInput) => defaultLlmExtractOrganizations(input, env, {
      dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
      stats: options.stats,
    }));
    const llmRows = await llmExtract({
      cleanedText,
      sourceContext: sourceContextForOrgExtraction(item),
      orgId,
      mode: options.recoveryMode === true ? 'target_recovery' : 'all_organizations',
    });
    for (const org of llmRows.slice(0, options.maxLlmOrganizations || 24)) {
      if (isOwnFundEntity(org.name)) continue;
      const anchored = anchorLlmOrganization(cleanedText, org);
      if (!anchored) continue;
      addMentionCandidate(mentions, mentionFromAnchoredRaw(
        cleanedText,
        anchored.raw,
        anchored.canonicalRaw,
        anchored.spanStart,
        false
      ));
    }
  }

  const evidenceCorrected = new Map<string, MentionCandidate>();
  for (const mention of mentions.values()) {
    addMentionCandidate(evidenceCorrected, correctMentionNameFromSourceEvidence(mention, item, cleanedText, env));
  }

  const existingNormalized = new Set((options.existingMentions || []).map(mention => mention.normalizedName));
  const deduped = dedupeMentionIdentityCandidates([...evidenceCorrected.values()], env)
    .filter(mention => !existingNormalized.has(mention.normalizedName));
  return renumberMentionCandidates(deduped);
}

async function companyNameFor(id: string | undefined, orgId: string, env: Env): Promise<string | null> {
  if (!id) return null;
  const row = await env.D1.prepare(
    `SELECT name FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(id, orgId).first<{ name: string }>();
  return row?.name || null;
}

async function lookupExistingContext(
  mention: MentionCandidate,
  item: ClassifiedItem,
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'allowPartialSchema'> = {}
): Promise<ExistingContext> {
  const mentionDomain = domainFromMention(item, mention);
  try {
  type CompanyIdentityRow = {
    id: string;
    name: string;
    domain: string | null;
    website?: string | null;
    custom_fields?: string | null;
    is_internal_entity: number | null;
  };
  type ProspectIdentityLookupRow = {
    id: string;
    canonical_name: string;
    normalized_name: string;
    domain: string | null;
    website: string | null;
    company_id: string | null;
    deal_id: string | null;
    possible_company_id: string | null;
    possible_deal_id: string | null;
  };
  const candidates = new Map<string, ExistingIdentityCandidateAudit & { is_internal_entity?: number | null }>();
  const addCandidate = (candidate: ExistingIdentityCandidateAudit & { is_internal_entity?: number | null }): void => {
    const existing = candidates.get(`${candidate.entity_type}:${candidate.entity_id}`);
    if (!existing || candidate.score > existing.score) {
      candidates.set(`${candidate.entity_type}:${candidate.entity_id}`, candidate);
      return;
    }
    if (existing.score === candidate.score) {
      existing.reasons = [...new Set([...existing.reasons, ...candidate.reasons])];
    }
  };
  const normalizeDomain = (value: string | null | undefined) => strictRegistrableDomain(value);
  const companyIdentityCompatibleWithMention = (row: CompanyIdentityRow, rowDomain: string | null): boolean => {
    const normalizedCompanyName = normalizeProspectName(row.name);
    if (normalizedCompanyName && normalizedCompanyName === mention.normalizedName) return true;
    if (identityAliasSetsCompatible(prospectIdentityAliasesForName(row.name), prospectIdentityAliasesForMention(mention, env))) return true;
    if (mentionDomain && rowDomain && mentionDomain === rowDomain) return true;
    return false;
  };
  const scoreCompany = (row: CompanyIdentityRow, baseScore: number, method: string, reasons: string[]): void => {
    let score = baseScore;
    const candidateReasons = [...reasons];
    const rowDomain = normalizeDomain(row.domain) || domainFromUrl(row.website);
    const limitedInfoReason = limitedInfoCompanyReason(row);
    const sourceItemCompanyMismatch = method === 'direct_company_id' && !companyIdentityCompatibleWithMention(row, rowDomain);
    if (mentionDomain && rowDomain && rowDomain !== mentionDomain) score -= 20;
    if (row.is_internal_entity === 1) score -= 20;
    if (mention.normalizedName.length < 5 && !mentionDomain && method.includes('name')) score -= 15;
    if (companyNameMatchConflictsWithSourceDomain(row, mention, mentionDomain)) score -= 25;
    if (sourceItemCompanyMismatch) {
      score = Math.min(score - 16, 84);
      candidateReasons.push('source_item_company_id_mismatch_candidate_name', 'source_company_context_audit_only');
    }
    if (limitedInfoReason) {
      score = Math.min(score - 10, 84);
      candidateReasons.push(limitedInfoReason, 'audit_only_limited_info_company_match');
    }
    if (!rowDomain && method.includes('name')) {
      score = Math.min(score, 84);
      candidateReasons.push('name_only_company_without_verified_domain');
    }
    score = Math.max(0, Math.round(score));
    if (score < 75) return;
    addCandidate({
      entity_type: 'company',
      entity_id: row.id,
      company_id: row.id,
      deal_id: null,
      name: row.name,
      domain: rowDomain || row.domain || null,
      score,
      method,
      reasons: candidateReasons,
      is_internal_entity: row.is_internal_entity,
    });
  };
  const scoreProspect = (row: ProspectIdentityLookupRow, baseScore: number, method: string, reasons: string[]): void => {
    let score = baseScore;
    const rowDomain = normalizeDomain(row.domain || domainFromUrl(row.website));
    if (mentionDomain && rowDomain && rowDomain !== mentionDomain) score -= 20;
    if (mention.normalizedName.length < 5 && !mentionDomain && method.includes('name')) score -= 15;
    score = Math.max(0, Math.round(score));
    if (score < 75) return;
    addCandidate({
      entity_type: 'prospect',
      entity_id: row.id,
      company_id: row.company_id || row.possible_company_id || null,
      deal_id: row.deal_id || row.possible_deal_id || null,
      name: row.canonical_name,
      domain: row.domain || rowDomain,
      score,
      method,
      reasons,
    });
  };

  if (item.companyId) {
    const direct = await env.D1.prepare(
      `SELECT id, name, domain, website, custom_fields, is_internal_entity
         FROM companies
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(item.companyId, orgId).first<CompanyIdentityRow>();
    if (direct) scoreCompany(direct, 100, 'direct_company_id', ['source_item_company_id']);
  }

  if (mentionDomain) {
    const byDomain = await env.D1.prepare(
      `SELECT id, name, domain, website, custom_fields, is_internal_entity
         FROM companies
        WHERE org_id = ? AND deleted_at IS NULL AND lower(domain) = lower(?)
        LIMIT 5`
    ).bind(orgId, mentionDomain).all<CompanyIdentityRow>();
    for (const row of byDomain.results || []) scoreCompany(row, 98, 'exact_domain', ['company_domain_exact_match']);
  }

  const token = mention.canonicalName.split(/\s+/)[0]?.toLowerCase();
  if (token && token.length >= 3) {
    const rows = await env.D1.prepare(
      `SELECT id, name, domain, website, custom_fields, is_internal_entity
         FROM companies
        WHERE org_id = ? AND deleted_at IS NULL AND lower(name) LIKE ?
        LIMIT 25`
    ).bind(orgId, `%${token}%`).all<CompanyIdentityRow>();
    for (const row of rows.results || []) {
      const normalized = normalizeProspectName(row.name);
      if (normalized === mention.normalizedName) scoreCompany(row, 90, 'exact_normalized_name', ['company_name_exact_normalized_match']);
      else if (identityAliasVariants(normalized).has(mention.normalizedName) || identityAliasVariants(mention.normalizedName).has(normalized)) {
        scoreCompany(row, 86, 'domain_brand_alias', ['company_name_alias_match']);
      }
    }
  }

  const aliasValues = new Set<string>([
    mention.normalizedName,
    ...Array.from(identityAliasVariants(mention.normalizedName)),
  ]);
  if (mentionDomain) {
    aliasValues.add(mentionDomain);
    aliasValues.add(normalizeProspectName(domainLabelToCompany(mentionDomain)));
  }
  try {
    const aliasList = Array.from(aliasValues).filter(Boolean).slice(0, 20);
    if (aliasList.length > 0) {
      const aliasRows = await env.D1.prepare(
        `SELECT entity_type, entity_id, alias_kind, alias_value, confidence
           FROM entity_identity_aliases
          WHERE org_id = ?
            AND alias_value IN (${aliasList.map(() => '?').join(', ')})
          LIMIT 50`
      ).bind(orgId, ...aliasList).all<{
        entity_type: 'company' | 'prospect';
        entity_id: string;
        alias_kind: string;
        alias_value: string;
        confidence: number | null;
      }>();
      const companyIds = aliasRows.results.filter(row => row.entity_type === 'company').map(row => row.entity_id);
      const prospectIds = aliasRows.results.filter(row => row.entity_type === 'prospect').map(row => row.entity_id);
      if (companyIds.length > 0) {
        const rows = await env.D1.prepare(
          `SELECT id, name, domain, website, custom_fields, is_internal_entity
             FROM companies
            WHERE org_id = ? AND deleted_at IS NULL
              AND id IN (${companyIds.map(() => '?').join(', ')})
            LIMIT 50`
        ).bind(orgId, ...companyIds).all<CompanyIdentityRow>();
        for (const company of rows.results || []) {
          const alias = aliasRows.results.find(row => row.entity_type === 'company' && row.entity_id === company.id);
          const base = alias?.alias_kind === 'domain' ? 96 : alias?.alias_kind === 'manual' ? 94 : 88;
          scoreCompany(company, base * Number(alias?.confidence || 1), `alias_${alias?.alias_kind || 'unknown'}`, [`alias_${alias?.alias_kind || 'unknown'}_match`]);
        }
      }
      if (prospectIds.length > 0) {
        const rows = await env.D1.prepare(
          `SELECT id, canonical_name, normalized_name, domain, website, company_id, deal_id, possible_company_id, possible_deal_id
             FROM prospects
            WHERE org_id = ? AND deleted_at IS NULL
              AND id IN (${prospectIds.map(() => '?').join(', ')})
            LIMIT 50`
        ).bind(orgId, ...prospectIds).all<ProspectIdentityLookupRow>();
        for (const prospect of rows.results || []) {
          const alias = aliasRows.results.find(row => row.entity_type === 'prospect' && row.entity_id === prospect.id);
          const base = alias?.alias_kind === 'domain' ? 96 : alias?.alias_kind === 'manual' ? 94 : 88;
          scoreProspect(prospect, base * Number(alias?.confidence || 1), `alias_${alias?.alias_kind || 'unknown'}`, [`alias_${alias?.alias_kind || 'unknown'}_match`]);
        }
      }
    }
  } catch (error) {
    if (!options.allowPartialSchema && !/entity_identity_aliases|no such table|D1_ERROR/i.test(error instanceof Error ? error.message : String(error || ''))) throw error;
  }

  const prospectRows = await env.D1.prepare(
    `SELECT id, canonical_name, normalized_name, domain, website, company_id, deal_id, possible_company_id, possible_deal_id
       FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND status IN ('active','provisional','converted')
        AND normalized_name = ?
      LIMIT 10`
  ).bind(orgId, mention.normalizedName).all<ProspectIdentityLookupRow>().catch(error => {
    if (isMissingSqlTableError(error, 'prospects')) return { results: [] as ProspectIdentityLookupRow[] };
    throw error;
  });
  for (const row of prospectRows.results || []) scoreProspect(row, 90, 'existing_prospect_normalized_name', ['existing_prospect_name_match']);

  const sorted = Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = sorted[0];
  if (!top) return emptyExistingContext(mentionDomain);
  const second = sorted[1];
  const identityAmbiguous = Boolean(second && top.score - second.score <= 5 && second.entity_id !== top.entity_id);
  const identityStrength = identityAmbiguous
    ? 'ambiguous'
    : top.score >= 95 ? 'hard' : top.score >= 85 ? 'soft' : top.score >= 75 ? 'weak' : 'none';
  if (identityAmbiguous || identityStrength === 'weak' || identityStrength === 'none') {
    return {
      ...emptyExistingContext(mentionDomain),
      companyDomain: top.domain || mentionDomain || null,
      identityScore: top.score,
      identityStrength,
      identityMethod: top.method,
      identityAmbiguous,
      identityCandidates: sorted.slice(0, 5).map(({ is_internal_entity: _internal, ...row }) => row),
    };
  }

  const companyId = top.company_id;
  const relationships = companyId ? await env.D1.prepare(
    `SELECT relationship_state
       FROM firm_company_relationships
      WHERE org_id = ? AND company_id = ? AND ended_at IS NULL`
  ).bind(orgId, companyId).all<{ relationship_state: string }>().catch(error => {
    if (options.allowPartialSchema && isMissingSqlTableError(error, 'firm_company_relationships')) {
      return { results: [] as Array<{ relationship_state: string }> };
    }
    throw error;
  }) : { results: [] as Array<{ relationship_state: string }> };

  const deal = companyId ? await env.D1.prepare(
    `SELECT id
       FROM deals
      WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL AND stage != 'closed'
      LIMIT 1`
  ).bind(orgId, companyId).first<{ id: string }>() : null;

  return {
    companyId,
    dealId: top.deal_id || deal?.id || null,
    companyDomain: top.domain || mentionDomain || null,
    relationshipStates: relationships.results.map(r => r.relationship_state),
    isInternal: top.is_internal_entity === 1,
    matchStrength: top.method.includes('company_id') ? 'company_id' : top.method.includes('domain') ? 'domain' : 'name',
    identityScore: top.score,
    identityStrength,
    identityMethod: top.method,
    identityAmbiguous,
    identityCandidates: sorted.slice(0, 5).map(({ is_internal_entity: _internal, ...row }) => row),
  };
  } catch (error) {
    if (options.allowPartialSchema && isOptionalReadContextError(error)) {
      return emptyExistingContext(mentionDomain);
    }
    throw error;
  }
}

export function emptyProspectClassifierKnownContext(): ProspectClassifierKnownContext {
  return { knownDeals: [], knownDealmakers: [] };
}

function isMissingSqlTableError(error: unknown, tableName: string): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return new RegExp(`no such table:\\s*${escapeRegExp(tableName)}`, 'i').test(message);
}

function isOptionalReadContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Command failed:\s*npx\s+wrangler\s+d1\s+execute\b|D1_ERROR|database is locked|SQLITE_BUSY|network|fetch failed|ETIMEDOUT|ECONNRESET/i.test(message);
}

function entityListForPrompt(rows: ProspectClassifierKnownEntity[]): string {
  if (rows.length === 0) return '(none)';
  return rows
    .slice(0, 200)
    .map(row => row.domain ? `${row.name} <${row.domain}>` : row.name)
    .join('; ');
}

export async function loadProspectClassifierKnownContext(
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'allowPartialSchema'> = {}
): Promise<ProspectClassifierKnownContext> {
  const dealRowsPromise = env.D1.prepare(
    `SELECT DISTINCT c.name, c.domain
       FROM companies c
       LEFT JOIN deals d
         ON d.org_id = c.org_id
        AND d.company_id = c.id
        AND d.deleted_at IS NULL
        AND d.stage != 'closed'
       LEFT JOIN firm_company_relationships f
         ON f.org_id = c.org_id
        AND f.company_id = c.id
        AND f.ended_at IS NULL
        AND f.relationship_state IN ('current_portfolio','exited')
      WHERE c.org_id = ? AND c.deleted_at IS NULL
        AND (d.id IS NOT NULL OR f.company_id IS NOT NULL)
      ORDER BY lower(c.name)
      LIMIT 250`
  ).bind(orgId).all<{ name: string; domain: string | null }>().catch(error => {
    if (!options.allowPartialSchema || !isMissingSqlTableError(error, 'firm_company_relationships')) throw error;
    return env.D1.prepare(
      `SELECT DISTINCT c.name, c.domain
         FROM companies c
         JOIN deals d
           ON d.org_id = c.org_id
          AND d.company_id = c.id
          AND d.deleted_at IS NULL
          AND d.stage != 'closed'
        WHERE c.org_id = ? AND c.deleted_at IS NULL
        ORDER BY lower(c.name)
        LIMIT 250`
    ).bind(orgId).all<{ name: string; domain: string | null }>();
  });
  const [dealRows, dealmakerRows] = await Promise.all([
    dealRowsPromise,
    env.D1.prepare(
      `SELECT name,
              CASE
                WHEN domain IS NOT NULL AND trim(domain) != '' THEN lower(domain)
                WHEN normalized_email IS NOT NULL AND instr(normalized_email, '@') > 0
                THEN lower(substr(normalized_email, instr(normalized_email, '@') + 1))
                ELSE NULL
              END AS domain
         FROM dealmakers
        WHERE org_id = ? AND name IS NOT NULL AND trim(name) != ''
        ORDER BY last_seen_at DESC NULLS LAST, lower(name)
        LIMIT 250`
    ).bind(orgId).all<{ name: string; domain: string | null }>().catch(error => {
      if (!options.allowPartialSchema || !isMissingSqlTableError(error, 'dealmakers')) throw error;
      return { results: [] as Array<{ name: string; domain: string | null }> };
    }),
  ]);

  return {
    knownDeals: (dealRows.results || []).map(row => ({ name: row.name, domain: row.domain })),
    knownDealmakers: (dealmakerRows.results || []).map(row => ({ name: row.name, domain: row.domain })),
  };
}

interface CrossD1CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  company_type: string | null;
  investment_status: string | null;
  stage: string | null;
  sector: string | null;
  is_internal_entity: number | null;
  last_news_summary: string | null;
  custom_fields: string | null;
}

function emptyCrossD1CompanyRoleCheck(reason: string): CrossD1CompanyRoleCheck {
  return {
    checked: false,
    eligible: false,
    role: 'unknown',
    confidence: 'low',
    evidence: [],
    action_override: null,
    matched_company_id: null,
    matched_deal_id: null,
    reason,
  };
}

function checkedCrossD1CompanyRoleCheck(input: Partial<CrossD1CompanyRoleCheck> & Pick<CrossD1CompanyRoleCheck, 'role' | 'confidence' | 'evidence'>): CrossD1CompanyRoleCheck {
  return {
    checked: true,
    eligible: true,
    role: input.role,
    confidence: input.confidence,
    evidence: input.evidence.slice(0, 12),
    action_override: input.action_override ?? null,
    matched_company_id: input.matched_company_id ?? null,
    matched_deal_id: input.matched_deal_id ?? null,
    reason: input.reason ?? null,
  };
}

function crossD1RoleTextForCompany(row: CrossD1CompanyRow | null): string {
  if (!row) return '';
  const fields = [
    row.description,
    row.last_news_summary,
    row.custom_fields,
    row.sector,
    row.stage,
  ];
  return normalizeWhitespace(fields.filter(Boolean).join(' ')).slice(0, 5000);
}

function crossD1TextRoleEvidence(text: string): Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }> {
  const compact = normalizeWhitespace(text).toLowerCase();
  if (!compact) return [];
  const hits: Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }> = [];
  const add = (role: CrossD1CompanyRole, evidence: string, weight = 1) => hits.push({ role, evidence, weight });

  if (/\b(?:investment bank|merchant bank|commercial bank|banking institution|financial institution|broker[-\s]?dealer|wealth management|asset management firm)\b/.test(compact)) {
    add('bank', 'company brief describes bank/financial institution', 2);
  }
  if (/\b(?:venture capital|private equity|investment firm|investment fund|vc firm|growth equity|family office|asset manager|fund manager)\b/.test(compact)) {
    add(/\bfamily office\b/.test(compact) ? 'lp_or_family_office' : 'vc_firm', 'company brief describes investor/fund firm', 2);
  }
  if (/\b(?:nonprofit|non-profit|not[-\s]?for[-\s]?profit|501\(c\)|foundation|charitable organization|university|research institute)\b/.test(compact)) {
    add('nonprofit', 'company brief describes nonprofit/foundation/academic institution', 2);
  }
  if (/\b(?:government agency|federal agency|department of|u\.s\. army|us army|devcom|dod|department of defense|municipality|public sector buyer|event host|conference organizer|showcase|accelerator program)\b/.test(compact)) {
    add('government_or_event_channel', 'company brief describes government/event/channel entity', 2);
  }
  if (/\b(?:law firm|legal services|accounting firm|consulting firm|advisory firm|insurance broker|insurance brokerage|brokerage firm|risk management firm|investment banking services|placement agent|recruiting firm|marketing agency|service provider|systems integrator)\b/.test(compact)) {
    add('vendor_or_service_provider', 'company brief describes service provider/advisor', 2);
  }
  if (/\b(?:partner(?:s|ed)? with medina|frequent partner|strategic partner|ecosystem partner|intro source|referral partner|channel partner)\b/.test(compact)) {
    add('frequent_partner_or_source', 'company brief describes partner/source relationship', 2);
  }
  if (/\b(?:customer|buyer|procurement|end customer|public sector customer|strategic customer)\b/.test(compact)) {
    add('customer_or_buyer', 'company brief describes customer/buyer role', 1);
  }
  if (/\b(?:startup|start-up|early[-\s]?stage|seed[-\s]?stage|series\s+[abc]|venture-backed|saas|software platform|ai platform|cybersecurity platform|founder-led)\b/.test(compact)) {
    add('startup_or_private_company', 'company brief describes startup/private software company', 1);
  }
  if (/\b(?:public company|publicly traded|listed company|acquired by|subsidiary of|fortune 500)\b/.test(compact)) {
    add('public_or_acquired_company', 'company brief describes public/acquired/large incumbent', 2);
  }
  return hits;
}

function chooseWeightedCrossD1Role(scores: Map<CrossD1CompanyRole, number>): CrossD1CompanyRole {
  const priority: CrossD1CompanyRole[] = [
    'known_deal',
    'internal_entity',
    'portfolio_company',
    'bank',
    'vc_firm',
    'lp_or_family_office',
    'nonprofit',
    'government_or_event_channel',
    'vendor_or_service_provider',
    'advisor_or_intro_source',
    'frequent_partner_or_source',
    'customer_or_buyer',
    'public_or_acquired_company',
    'startup_or_private_company',
    'unknown',
  ];
  let best: CrossD1CompanyRole = 'unknown';
  let bestScore = 0;
  for (const role of priority) {
    const score = scores.get(role) || 0;
    if (score > bestScore) {
      best = role;
      bestScore = score;
    }
  }
  return best;
}

function confidenceForCrossD1Role(score: number, authoritative: boolean): CrossD1RoleConfidence {
  if (authoritative) return 'authoritative';
  if (score >= 3) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function actionForCrossD1Role(role: CrossD1CompanyRole, confidence: CrossD1RoleConfidence, dealId: string | null): CrossD1RoleActionOverride {
  if (role === 'internal_entity') return 'ignore';
  if (confidence === 'low') return null;
  if ([
    'bank',
    'vc_firm',
    'lp_or_family_office',
    'nonprofit',
    'government_or_event_channel',
    'vendor_or_service_provider',
    'advisor_or_intro_source',
    'customer_or_buyer',
    'portfolio_company',
    'frequent_partner_or_source',
    'public_or_acquired_company',
  ].includes(role)) return 'record_context';
  if (role === 'known_deal') return null;
  return null;
}

async function loadCrossD1CompanyRow(
  orgId: string,
  mention: MentionCandidate,
  existing: ExistingContext,
  item: ClassifiedItem,
  env: Env
): Promise<CrossD1CompanyRow | null> {
  if (existing.companyId) {
    const byId = await env.D1.prepare(
      `SELECT id, name, domain, website, description, company_type, investment_status, stage, sector,
              is_internal_entity, last_news_summary, custom_fields
         FROM companies
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
        LIMIT 1`
    ).bind(existing.companyId, orgId).first<CrossD1CompanyRow>();
    if (byId) return byId;
  }

  const domain = existing.companyDomain || domainFromMention(item, mention) || firstProspectDomainForMention(mention, env);
  if (domain) {
    const byDomain = await env.D1.prepare(
      `SELECT id, name, domain, website, description, company_type, investment_status, stage, sector,
              is_internal_entity, last_news_summary, custom_fields
         FROM companies
        WHERE org_id = ? AND deleted_at IS NULL
          AND (lower(domain) = lower(?) OR lower(website) LIKE ?)
        LIMIT 1`
    ).bind(orgId, domain, `%${domain.toLowerCase()}%`).first<CrossD1CompanyRow>();
    if (byDomain) return byDomain;
  }

  const token = mention.canonicalName.split(/\s+/)[0]?.toLowerCase();
  if (token && token.length >= 3) {
    const rows = await env.D1.prepare(
      `SELECT id, name, domain, website, description, company_type, investment_status, stage, sector,
              is_internal_entity, last_news_summary, custom_fields
         FROM companies
        WHERE org_id = ? AND deleted_at IS NULL AND lower(name) LIKE ?
        LIMIT 20`
    ).bind(orgId, `%${token}%`).all<CrossD1CompanyRow>();
    let best: CrossD1CompanyRow | null = null;
    let bestScore = 0;
    const mentionAliases = prospectIdentityAliasesForMention(mention, env);
    for (const row of rows.results || []) {
      const rowNormalized = normalizeProspectName(row.name);
      const rowAliases = prospectIdentityAliasesForRow({
        canonical_name: row.name,
        normalized_name: rowNormalized,
        domain: row.domain,
        website: row.website,
      });
      const containsMentionName = Boolean(
        mention.normalizedName &&
        mention.normalizedName.length >= 5 &&
        rowNormalized.includes(mention.normalizedName)
      );
      const score = setsIntersect(mentionAliases, rowAliases) ? 2 : rowNormalized === mention.normalizedName ? 2 : containsMentionName ? 1 : 0;
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }
    if (best) return best;
  }

  return null;
}

async function crossD1ContactRoleEvidence(orgId: string, companyId: string | null, env: Env): Promise<Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }>> {
  if (!companyId) return [];
  const rows = await env.D1.prepare(
    `SELECT contact_type, relationship_status, job_title, email
       FROM contacts
      WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL AND merged_into IS NULL
      LIMIT 25`
  ).bind(orgId, companyId).all<{ contact_type: string | null; relationship_status: string | null; job_title: string | null; email: string | null }>().catch(error => {
    if (isMissingSqlTableError(error, 'contacts')) return { results: [] as Array<{ contact_type: string | null; relationship_status: string | null; job_title: string | null; email: string | null }> };
    throw error;
  });
  const evidence: Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }> = [];
  for (const row of rows.results || []) {
    const text = `${row.contact_type || ''} ${row.relationship_status || ''} ${row.job_title || ''}`.toLowerCase();
    if (/\b(?:lp|institutional_investor|investor)\b/.test(text)) evidence.push({ role: 'lp_or_family_office', evidence: 'contact relationship indicates LP/investor', weight: 1 });
    if (/\b(?:advisor|vendor)\b/.test(text)) evidence.push({ role: 'vendor_or_service_provider', evidence: 'contact relationship indicates advisor/vendor', weight: 1 });
    if (/\b(?:portfolio_founder)\b/.test(text)) evidence.push({ role: 'portfolio_company', evidence: 'contact relationship indicates portfolio founder', weight: 1 });
  }
  return evidence;
}

async function crossD1DealmakerEvidence(orgId: string, mention: MentionCandidate, company: CrossD1CompanyRow | null, env: Env): Promise<Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }>> {
  const domain = String(company?.domain || firstProspectDomainForMention(mention, env) || '').toLowerCase().replace(/^www\./, '');
  const normalizedName = normalizeProspectName(company?.name || mention.canonicalName);
  if (!domain && !normalizedName) return [];
  const clauses: string[] = [];
  const binds: unknown[] = [orgId];
  if (domain) {
    clauses.push(`lower(domain) = lower(?)`);
    binds.push(domain);
  }
  if (normalizedName) {
    clauses.push(`normalized_name = ?`);
    binds.push(normalizedName);
  }
  const rows = await env.D1.prepare(
    `SELECT dealmaker_type, COUNT(*) AS n
       FROM dealmakers
      WHERE org_id = ? AND (${clauses.join(' OR ')})
      GROUP BY dealmaker_type`
  ).bind(...binds).all<{ dealmaker_type: string | null; n: number }>().catch(error => {
    if (isMissingSqlTableError(error, 'dealmakers')) return { results: [] as Array<{ dealmaker_type: string | null; n: number }> };
    throw error;
  });
  return (rows.results || []).map(row => ({
    role: row.dealmaker_type === 'gov_channel' ? 'government_or_event_channel' : 'advisor_or_intro_source',
    evidence: `dealmaker history as ${row.dealmaker_type || 'unknown'} (${row.n})`,
    weight: Number(row.n || 0) >= 2 ? 2 : 1,
  }));
}

async function crossD1PriorSignalEvidence(orgId: string, mention: MentionCandidate, env: Env): Promise<Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }>> {
  const rows = await env.D1.prepare(
    `SELECT mention_type, metadata_json
       FROM prospect_signals
      WHERE org_id = ? AND normalized_mention = ?
      ORDER BY created_at DESC
      LIMIT 25`
  ).bind(orgId, mention.normalizedName).all<{ mention_type: string | null; metadata_json: string | null }>().catch(error => {
    if (isMissingSqlTableError(error, 'prospect_signals')) return { results: [] as Array<{ mention_type: string | null; metadata_json: string | null }> };
    throw error;
  });
  const counts = new Map<string, number>();
  for (const row of rows.results || []) {
    const key = String(row.mention_type || 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
    try {
      const action = JSON.parse(row.metadata_json || '{}')?.prospect_action;
      if (typeof action === 'string') counts.set(action, (counts.get(action) || 0) + 1);
    } catch {}
  }
  const evidence: Array<{ role: CrossD1CompanyRole; evidence: string; weight: number }> = [];
  const contextNoise = Number(counts.get('noise') || 0) + Number(counts.get('record_context') || 0) + Number(counts.get('ignore') || 0);
  if (contextNoise >= 2) evidence.push({ role: 'frequent_partner_or_source', evidence: `prior prospect signals were context/noise (${contextNoise})`, weight: 1 });
  if (Number(counts.get('known_deal') || 0) > 0) evidence.push({ role: 'known_deal', evidence: 'prior prospect signals include known_deal', weight: 1 });
  if (Number(counts.get('inbound_prospect') || 0) >= 2) evidence.push({ role: 'startup_or_private_company', evidence: 'prior prospect signals include repeated inbound prospect', weight: 1 });
  return evidence;
}

export async function classifyCompanyRoleFromD1(
  orgId: string,
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  env: Env,
  options: { prospectAction: ProspectAction; confidence: number; provisional: boolean; directionUncertain: boolean }
): Promise<CrossD1CompanyRoleCheck> {
  if (options.prospectAction !== 'create_prospect') {
    return emptyCrossD1CompanyRoleCheck('not_create_prospect');
  }
  if (
    options.confidence >= LOW_CONFIDENCE_VERIFICATION_EXEMPT_CONFIDENCE &&
    !options.provisional &&
    !options.directionUncertain
  ) {
    return emptyCrossD1CompanyRoleCheck('high_confidence_create_exempt');
  }

  try {
    const company = await loadCrossD1CompanyRow(orgId, mention, existing, item, env);
    const evidence: string[] = [];
    const scores = new Map<CrossD1CompanyRole, number>();
    let authoritative = false;
    let matchedDealId = existing.dealId;
    const addScore = (role: CrossD1CompanyRole, weight: number, reason: string) => {
      scores.set(role, (scores.get(role) || 0) + weight);
      evidence.push(reason);
    };

    if (existing.isInternal || company?.is_internal_entity === 1) {
      return checkedCrossD1CompanyRoleCheck({
        role: 'internal_entity',
        confidence: 'authoritative',
        action_override: 'ignore',
        evidence: ['company is marked internal in D1'],
        matched_company_id: company?.id || existing.companyId,
        matched_deal_id: matchedDealId,
        reason: 'authoritative_internal_entity',
      });
    }

    if (existing.dealId && (existing.matchStrength === 'domain' || existing.matchStrength === 'company_id')) {
      return checkedCrossD1CompanyRoleCheck({
        role: 'known_deal',
        confidence: 'authoritative',
        action_override: null,
        evidence: ['matched open deal in D1'],
        matched_company_id: company?.id || existing.companyId,
        matched_deal_id: existing.dealId,
        reason: 'matched_open_deal',
      });
    } else if (existing.dealId) {
      matchedDealId = existing.dealId;
      addScore('known_deal', 1, 'possible open deal by name only');
    }

    const relationshipStates = new Set(existing.relationshipStates.map(state => state.toLowerCase()));
    const sourceItemCompanyMismatchReason = company && (existing.identityCandidates || []).some(candidate =>
      candidate.entity_type === 'company' &&
      candidate.entity_id === company.id &&
      candidate.reasons.some(reason => /source_item_company_id_mismatch_candidate_name|source_company_context_audit_only/i.test(reason))
    ) ? 'source_item_company_id_mismatch_candidate_name' : null;
    const limitedInfoReason = limitedInfoCompanyReason(company);
    const auditOnlyCompanyReason = limitedInfoReason || sourceItemCompanyMismatchReason;
    if (relationshipStates.has('current_portfolio') || relationshipStates.has('exited')) {
      authoritative = true;
      addScore('portfolio_company', 4, `firm relationship state: ${relationshipStates.has('current_portfolio') ? 'current_portfolio' : 'exited'}`);
    }
    if (relationshipStates.has('passed')) {
      authoritative = true;
      addScore('frequent_partner_or_source', 3, 'firm relationship state: passed');
    }
    if (relationshipStates.has('active_pipeline') || relationshipStates.has('watchlist')) {
      addScore('startup_or_private_company', 2, `firm relationship state supports prospect identity: ${relationshipStates.has('active_pipeline') ? 'active_pipeline' : 'watchlist'}`);
    }

    if (company) {
      if (auditOnlyCompanyReason) {
        evidence.push(`${auditOnlyCompanyReason}: audit-only company identity support`);
      }
      const companyType = String(company.company_type || '').toLowerCase();
      const investmentStatus = String(company.investment_status || '').toLowerCase();
      if (companyType === 'vc_firm') addScore('vc_firm', 4, 'company_type=vc_firm');
      if (companyType === 'family_office' || companyType === 'lp') addScore('lp_or_family_office', 4, `company_type=${companyType}`);
      if (companyType === 'portfolio') addScore('portfolio_company', 3, 'company_type=portfolio');
      if (companyType === 'startup' && !auditOnlyCompanyReason) addScore('startup_or_private_company', 1, 'company_type=startup');
      if (investmentStatus === 'invested' || investmentStatus === 'exited') addScore('portfolio_company', 3, `investment_status=${investmentStatus}`);
      if (investmentStatus === 'passed') addScore('frequent_partner_or_source', 2, 'investment_status=passed');
      if (['prospect', 'due_diligence', 'term_sheet'].includes(investmentStatus) && !auditOnlyCompanyReason) addScore('startup_or_private_company', 2, `investment_status supports prospect identity: ${investmentStatus}`);

      const deal = await env.D1.prepare(
        `SELECT id
           FROM deals
          WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL AND stage != 'closed'
          LIMIT 1`
      ).bind(orgId, company.id).first<{ id: string }>().catch(error => {
        if (isMissingSqlTableError(error, 'deals')) return null;
        throw error;
      });
      if (deal?.id) {
        matchedDealId = deal.id;
        if (existing.matchStrength === 'domain' || existing.matchStrength === 'company_id') {
          authoritative = true;
          addScore('known_deal', 4, 'matched open deal by company id');
        } else {
          addScore('known_deal', 1, 'matched open deal by name only');
        }
      }

      for (const hit of crossD1TextRoleEvidence(crossD1RoleTextForCompany(company))) {
        addScore(hit.role, hit.weight, hit.evidence);
      }
    }

    for (const hit of await crossD1ContactRoleEvidence(orgId, company?.id || existing.companyId, env)) {
      addScore(hit.role, hit.weight, hit.evidence);
    }
    for (const hit of await crossD1DealmakerEvidence(orgId, mention, company, env)) {
      addScore(hit.role, hit.weight, hit.evidence);
    }
    for (const hit of await crossD1PriorSignalEvidence(orgId, mention, env)) {
      addScore(hit.role, hit.weight, hit.evidence);
    }

    const role = chooseWeightedCrossD1Role(scores);
    const score = scores.get(role) || 0;
    const confidence = confidenceForCrossD1Role(score, authoritative);
    const action = actionForCrossD1Role(role, confidence, matchedDealId);
    const candidatePitchOverridesAmbiguousRole =
      action === 'record_context' &&
      ['lp_or_family_office', 'customer_or_buyer', 'frequent_partner_or_source'].includes(role) &&
      (hasStrongCandidatePitchMaterialEvidence(lowConfidenceSourceText(item, mention), mention.canonicalName) ||
        hasSubjectTargetInvestmentEvidence(item, mention));
    const finalAction = candidatePitchOverridesAmbiguousRole ? null : action;
    return checkedCrossD1CompanyRoleCheck({
      role,
      confidence,
      action_override: finalAction,
      evidence: candidatePitchOverridesAmbiguousRole
        ? [...(evidence.length ? evidence : ['no disqualifying D1 role evidence found']), 'candidate-specific pitch material overrides ambiguous CRM role label']
        : evidence.length ? evidence : ['no disqualifying D1 role evidence found'],
      matched_company_id: company?.id || existing.companyId,
      matched_deal_id: matchedDealId,
      reason: finalAction ? `cross_d1_${role}` : candidatePitchOverridesAmbiguousRole ? `cross_d1_${role}_overridden_by_candidate_pitch_evidence` : null,
    });
  } catch (error) {
    return {
      ...emptyCrossD1CompanyRoleCheck('cross_d1_role_check_error'),
      checked: true,
      eligible: true,
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function emptyLowConfidenceProspectVerification(reason: string): LowConfidenceProspectVerification {
  return {
    checked: false,
    eligible: false,
    verdict: 'not_applicable',
    action_override: null,
    reason,
    scores: {
      identity: 0,
      intent: 0,
      source_quality: 0,
      d1_support: 0,
      extraction_risk: 0,
      total: 0,
    },
    identity_signals: [],
    intent_signals: [],
    source_quality_signals: [],
    d1_signals: [],
    extraction_flags: [],
  };
}

function lowConfidenceSourceText(item: ClassifiedItem, mention: MentionCandidate): string {
  return normalizeWhitespace([
    item.subject,
    item.metadata?.entity_name,
    item.metadata?.document_type,
    item.bodyPreview,
    item.bodyText,
    item.text,
    mention.raw,
    mention.lineText,
    mention.contextText,
    mention.listFields?.problem,
    mention.listFields?.approach,
    mention.listFields?.stage,
    mention.listFields?.amount,
    mention.listFields?.poc,
  ].filter(Boolean).join(' '));
}

function isSourceSupportedDealPitchDocument(item: ClassifiedItem, mention: MentionCandidate): boolean {
  const sourceKind = `${(item as any).entityType || ''} ${(item as any).type || ''}`;
  if (!/\bdocument\b/.test(sourceKind)) return false;
  const metadata = (item.metadata || {}) as unknown as Record<string, unknown>;
  const documentType = String(metadata.document_type || '').toLowerCase();
  if (!/\b(?:deal|investment)[-_ ]?pitch\b|\binvestor[-_ ]?(?:deck|presentation|one[-_ ]?pager|two[-_ ]?pager)\b/.test(documentType)) {
    return false;
  }
  const titleCandidates = [
    item.subject,
    typeof metadata.entity_name === 'string' ? metadata.entity_name : '',
    typeof metadata.r2_key === 'string' ? metadata.r2_key.split('/').pop() : '',
  ]
    .map(value => sourceTitleTargetName(value))
    .filter(Boolean) as string[];
  const mentionAliases = prospectIdentityAliasesForName(mention.canonicalName);
  const titleMatchesMention = titleCandidates.some(candidate =>
    identityAliasSetsCompatible(mentionAliases, prospectIdentityAliasesForName(candidate))
  );
  if (!titleMatchesMention) return false;
  const textSource = String(metadata.text_source || '').toLowerCase();
  const bodyLength = normalizeWhitespace(`${item.bodyText || ''} ${item.text || ''}`).length;
  return textSource === 'r2_full_text' || bodyLength >= 120;
}

function appendUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function sourceMentionsName(text: string, name: string): boolean {
  const cleanName = normalizeWhitespace(name);
  if (!cleanName || cleanName.length < 3) return false;
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function hasMedinaOutboundProspectInterestEvidence(text: string, candidateName: string): boolean {
  if (!sourceMentionsName(text, candidateName)) return false;
  const compact = normalizeWhitespace(text);
  if (!/\b(?:Medina|Medina Ventures|we|we'd|we would|I|I'd|I would|our)\b/i.test(compact)) return false;
  const candidateEscaped = normalizeWhitespace(candidateName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidateThenInterest = new RegExp(`\\b${candidateEscaped}\\b[^.]{0,180}\\b(?:fits?\\s+(?:very\\s+much\\s+)?(?:in\\s+)?(?:our\\s+)?wheelhouse|learn\\s+more|interesting|interested|investment\\s+fit|go[-\\s]?to[-\\s]?market|national\\s+security\\s+opportunities)\\b`, 'i');
  const interestThenCandidate = new RegExp(`\\b(?:love\\s+to\\s+learn\\s+more\\s+about|interested\\s+in|fits?\\s+(?:very\\s+much\\s+)?(?:in\\s+)?(?:our\\s+)?wheelhouse[^.]{0,80})\\b[^.]{0,180}\\b${candidateEscaped}\\b`, 'i');
  return candidateThenInterest.test(compact) || interestThenCandidate.test(compact);
}

function hasThirdPartyAllocationContext(text: string): boolean {
  const compact = normalizeWhitespace(text).toLowerCase();
  if (!/\b(?:secured|received|got|landed|has|had|confirmed)\s+(?:an?\s+)?allocation(?:s)?\b/.test(compact)) return false;
  return /\b(?:they|he|she|pablo|oso|onesixone|one\s*six\s*one|another\s+(?:party|fund|investor|firm))\b.{0,100}\b(?:secured|received|got|landed|has|had|confirmed)\s+(?:an?\s+)?allocation(?:s)?\b/.test(compact);
}

function hasLimitedInfoAuditSupport(roleCheck: CrossD1CompanyRoleCheck): boolean {
  return roleCheck.evidence.some(evidence =>
    /\b(?:limited_info|blocked_insufficient_anchor|audit-only company identity|prospect_pipeline_company_without_verified_domain)\b/i.test(evidence)
  );
}

function crossD1RoleSupportsCreate(roleCheck: CrossD1CompanyRoleCheck): number {
  if (!roleCheck.checked || !roleCheck.eligible) return 0;
  if (roleCheck.role === 'startup_or_private_company') return roleCheck.confidence === 'low' ? 1 : 2;
  if (roleCheck.role === 'known_deal') return roleCheck.confidence === 'low' ? 0 : 2;
  if (roleCheck.role === 'unknown') return 0;
  if (roleCheck.confidence === 'authoritative' || roleCheck.confidence === 'high') return -3;
  if (roleCheck.confidence === 'medium') return -2;
  return -1;
}

function identityAliasSetsCompatible(left: Set<string>, right: Set<string>): boolean {
  if (setsIntersect(left, right)) return true;
  for (const a of left) {
    for (const b of right) {
      if (a.length < 4 || b.length < 4) continue;
      if (b.startsWith(a) && b.length - a.length <= 8) return true;
      if (a.startsWith(b) && a.length - b.length <= 8) return true;
    }
  }
  return false;
}

export function verifyLowConfidenceProspect(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  prefilter: ClassifierPrefilter,
  crossD1RoleCheck: CrossD1CompanyRoleCheck,
  env: Env,
  options: { prospectAction: ProspectAction; confidence: number; provisional: boolean; directionUncertain: boolean }
): LowConfidenceProspectVerification {
  if (options.prospectAction !== 'create_prospect') {
    return emptyLowConfidenceProspectVerification('not_create_prospect');
  }

  const text = lowConfidenceSourceText(item, mention);

  if (
    options.confidence >= LOW_CONFIDENCE_VERIFICATION_EXEMPT_CONFIDENCE &&
    !options.provisional &&
    !options.directionUncertain
  ) {
    return emptyLowConfidenceProspectVerification('not_low_confidence');
  }

  const identitySignals: string[] = [];
  const intentSignals: string[] = [];
  const sourceQualitySignals: string[] = [];
  const d1Signals: string[] = [];
  const extractionFlags: string[] = [];
  let identity = 0;
  let intent = 0;
  let sourceQuality = 0;
  let extractionRisk = 0;

  const compact = text.toLowerCase();
  const strongSourceInvestmentIntent = hasStrongSourceInvestmentIntent(text);
  const mentionDomain = firstProspectDomainForMention(mention, env);
  const bodyDomain = domainFromMention(item, mention);
  const candidateDomain = mentionDomain || bodyDomain || existing.companyDomain;
  const fromDomain = emailDomain(item.fromEmail);
  const internalDomains = getConfiguredInternalDomains(env);
  const fromInternal = isInternalEmailDomain(item.fromEmail, internalDomains);
  const sourceSupportedDealPitchDocument = isSourceSupportedDealPitchDocument(item, mention);
  const subjectTargetInvestmentEvidence = hasSubjectTargetInvestmentEvidence(item, mention);
  const strongCandidatePitchMaterialEvidence = hasStrongCandidatePitchMaterialEvidence(text, mention.canonicalName);
  const productPitchParentCompanyEvidence = hasProductPitchParentCompanyEvidence(text, null, mention.canonicalName);
  const medinaOutboundProspectInterestEvidence = hasMedinaOutboundProspectInterestEvidence(text, mention.canonicalName);
  const nameAliases = prospectIdentityAliasesForName(mention.canonicalName);
  const domainAliases = candidateDomain
    ? prospectIdentityAliasesForName(domainLabelToCompany(candidateDomain))
    : new Set<string>();
  const domainMatchesMention = candidateDomain ? identityAliasSetsCompatible(nameAliases, domainAliases) : false;

  if (mention.listFields?.website) {
    identity += 2;
    appendUnique(identitySignals, 'structured_company_website');
  }
  if (mention.isListEntry || mention.listFields) {
    identity += 1;
    appendUnique(identitySignals, 'structured_dealflow_row');
  }
  if (candidateDomain && domainMatchesMention) {
    identity += 2;
    appendUnique(identitySignals, 'company_name_matches_domain');
  }
  if (fromDomain && candidateDomain && fromDomain === candidateDomain) {
    identity += 2;
    appendUnique(identitySignals, 'sender_domain_matches_company');
  }
  if (sourceMentionsName(text, mention.canonicalName)) {
    identity += 1;
    appendUnique(identitySignals, 'source_names_company');
  }
  if (subjectTargetInvestmentEvidence) {
    identity += 2;
    appendUnique(identitySignals, 'subject_names_target_opportunity');
  }
  if (sourceSupportedDealPitchDocument) {
    identity += 3;
    appendUnique(identitySignals, 'deal_pitch_document_title_matches_company');
  }
  if (existing.matchStrength === 'domain' || existing.matchStrength === 'company_id') {
    identity += 2;
    appendUnique(identitySignals, `existing_${existing.matchStrength}_match`);
  } else if (existing.matchStrength === 'name') {
    identity += 1;
    appendUnique(identitySignals, 'existing_name_match');
  }

  if (prefilter.hasDeck) {
    intent += 2;
    appendUnique(intentSignals, 'deck_or_materials_present');
  }
  if (strongSourceInvestmentIntent) {
    intent += 3;
    appendUnique(intentSignals, 'strong_investment_intent');
  }
  if (subjectTargetInvestmentEvidence) {
    intent += 4;
    sourceQuality += 1;
    appendUnique(intentSignals, 'subject_line_target_opportunity');
    appendUnique(sourceQualitySignals, 'subject_line_explicit_target');
  }
  if (strongCandidatePitchMaterialEvidence) {
    intent += 3;
    appendUnique(intentSignals, 'candidate_pitch_material_target');
  }
  if (productPitchParentCompanyEvidence) {
    identity += 1;
    intent += 3;
    sourceQuality += 1;
    appendUnique(identitySignals, 'product_parent_company_named');
    appendUnique(intentSignals, 'product_parent_company_pitch');
    appendUnique(sourceQualitySignals, 'product_pitch_parent_company');
  }
  if (medinaOutboundProspectInterestEvidence) {
    identity += 1;
    intent += 4;
    sourceQuality += 1;
    appendUnique(identitySignals, 'medina_interest_names_candidate');
    appendUnique(intentSignals, 'medina_outbound_prospect_interest');
    appendUnique(sourceQualitySignals, 'medina_partner_interest');
  }
  if (sourceSupportedDealPitchDocument) {
    intent += 4;
    sourceQuality += 1;
    appendUnique(intentSignals, 'source_document_type_deal_pitch');
    appendUnique(sourceQualitySignals, 'full_text_deal_pitch_document');
  }
  if (prefilter.hasWarmIntro) {
    intent += 2;
    appendUnique(intentSignals, 'warm_intro_language');
  }
  if (prefilter.hasMeeting) {
    intent += 1;
    appendUnique(intentSignals, 'meeting_or_call_signal');
  }
  if (['deck', 'intro', 'raise'].includes(prefilter.signalKind)) {
    intent += 2;
    appendUnique(intentSignals, `signal_kind_${prefilter.signalKind}`);
  } else if (['meeting', 'list_entry'].includes(prefilter.signalKind)) {
    intent += 1;
    appendUnique(intentSignals, `signal_kind_${prefilter.signalKind}`);
  }
  if (/\b(?:raising|raise|fundrais|round|seed|series\s+[abc]|safe|term sheet|allocation)\b/.test(compact)) {
    intent += 2;
    appendUnique(intentSignals, 'financing_language');
  }
  if (/\b(?:pitch|deck|teaser|cim|data room|diligence|financial model|p&l|nda|demo|business plan|company materials|pre-read)\b/.test(compact)) {
    intent += 2;
    appendUnique(intentSignals, 'investment_materials_or_diligence_language');
  }
  if (/\b(?:founder|ceo|co-founder|introduced|intro|meet)\b/.test(compact)) {
    intent += 1;
    appendUnique(intentSignals, 'founder_or_intro_context');
  }
  if (mention.listFields?.problem || mention.listFields?.approach || mention.listFields?.amount || mention.listFields?.stage) {
    intent += 1;
    appendUnique(intentSignals, 'structured_company_profile_fields');
  }

  if (prefilter.newsletterLikely) {
    sourceQuality -= 2;
    appendUnique(sourceQualitySignals, 'newsletter_like_source');
  }
  if (fromDomain && candidateDomain && fromDomain === candidateDomain) {
    sourceQuality += 2;
    appendUnique(sourceQualitySignals, 'company_sent_from_own_domain');
  } else if (fromDomain && !fromInternal) {
    sourceQuality += 1;
    appendUnique(sourceQualitySignals, 'external_sender');
  }
  if (fromInternal && prefilter.deterministicDirection === 'internal') {
    sourceQuality -= 1;
    appendUnique(sourceQualitySignals, 'internal_only_source');
  }
  if (/\b(?:generated meeting summary|meeting notes|transcript|weekly digest|newsletter|market update)\b/.test(compact)) {
    sourceQuality -= 1;
    appendUnique(sourceQualitySignals, 'summary_or_digest_source');
  }
  if (/\b(?:government briefing|road show|conference|showcase|webinar|venue|panel)\b/.test(compact) && !/\b(?:company name|pitch|deck|founder|raising|diligence)\b/.test(compact)) {
    sourceQuality -= 2;
    appendUnique(sourceQualitySignals, 'channel_or_event_context_without_target');
  }
  if (!strongSourceInvestmentIntent && hasEventOrProgramChannelContext(text, mention.canonicalName)) {
    sourceQuality -= 2;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'event_or_program_channel_without_investment_target');
    appendUnique(extractionFlags, 'event_or_program_channel_context');
  }
  if (!strongSourceInvestmentIntent && hasPartnershipOrMatureCompanyNonProspectContext(text, mention.canonicalName)) {
    sourceQuality -= 3;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'partnership_or_mature_company_without_investment_target');
    appendUnique(extractionFlags, 'partnership_or_mature_company_context');
  }
  if (!strongSourceInvestmentIntent && hasProductivityToolingNonProspectContext(text)) {
    sourceQuality -= 3;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'productivity_tooling_context_without_investment_target');
    appendUnique(extractionFlags, 'productivity_tooling_context');
  }
  if (!strongSourceInvestmentIntent && hasCompanyMaterialsOnlyContext(text)) {
    sourceQuality -= 2;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'materials_without_investment_intent');
    appendUnique(extractionFlags, 'materials_only_context');
  }
  if (is_calendar_only_context(text, mention.canonicalName)) {
    sourceQuality -= 3;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'calendar_only_without_investment_target');
    appendUnique(extractionFlags, 'calendar_only_context');
  }
  if (is_relationship_only_context(text, mention.canonicalName)) {
    sourceQuality -= 3;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'relationship_only_without_investment_target');
    appendUnique(extractionFlags, 'relationship_only_context');
  }
  if (is_coordination_only_context(text, mention.canonicalName)) {
    sourceQuality -= 2;
    extractionRisk += 1;
    appendUnique(sourceQualitySignals, 'coordination_only_without_investment_target');
    appendUnique(extractionFlags, 'coordination_only_context');
  }

  if (candidateDomain && !domainMatchesMention && existing.matchStrength !== 'domain' && existing.matchStrength !== 'company_id') {
    extractionRisk += 3;
    appendUnique(extractionFlags, 'domain_name_mismatch');
  }
  if (fromDomain && candidateDomain && fromDomain !== candidateDomain && !fromInternal && !prefilter.hasWarmIntro && !/\b(?:introduced|intro|referr|forwarded)\b/.test(compact)) {
    extractionRisk += 1;
    appendUnique(extractionFlags, 'sender_domain_differs_without_intro_context');
  }
  if (mention.normalizedName.length <= 4 && !candidateDomain && existing.matchStrength === 'none') {
    extractionRisk += 1;
    appendUnique(extractionFlags, 'short_name_without_domain_or_d1_match');
  }
  if (/\b(?:bank|capital|ventures|partners|advisory|consulting|government|army|event|conference|foundation)\b/i.test(mention.canonicalName) && crossD1RoleCheck.role !== 'startup_or_private_company') {
    extractionRisk += 1;
    appendUnique(extractionFlags, 'role_like_company_name');
  }

  const d1Support = crossD1RoleSupportsCreate(crossD1RoleCheck);
  if (crossD1RoleCheck.checked && crossD1RoleCheck.eligible) {
    appendUnique(d1Signals, `cross_d1_role_${crossD1RoleCheck.role}_${crossD1RoleCheck.confidence}`);
    for (const evidence of crossD1RoleCheck.evidence.slice(0, 4)) appendUnique(d1Signals, evidence);
  }
  const limitedInfoAuditSupport = hasLimitedInfoAuditSupport(crossD1RoleCheck);
  const internalGeneratedMeeting =
    fromInternal &&
    prefilter.deterministicDirection === 'internal' &&
    (prefilter.hasMeeting || /\b(?:generated meeting summary|meeting notes|meeting recap|transcript|catch up|sync)\b/.test(compact));
  const cleanInternalMeetingAnchor = Boolean(
    sourceSupportedDealPitchDocument ||
    subjectTargetInvestmentEvidence ||
    strongCandidatePitchMaterialEvidence ||
    productPitchParentCompanyEvidence ||
    (candidateDomain && domainMatchesMention) ||
    (existing.dealId && !limitedInfoAuditSupport) ||
    ((existing.matchStrength === 'domain' || existing.matchStrength === 'company_id') && !limitedInfoAuditSupport)
  );
  if (internalGeneratedMeeting && limitedInfoAuditSupport && !cleanInternalMeetingAnchor) {
    extractionRisk += 2;
    appendUnique(sourceQualitySignals, 'internal_meeting_limited_info_identity_only');
    appendUnique(extractionFlags, 'internal_meeting_without_clean_anchor');
  }
  const thirdPartyAllocationContext = internalGeneratedMeeting && hasThirdPartyAllocationContext(text);
  if (thirdPartyAllocationContext) {
    extractionRisk += 3;
    appendUnique(sourceQualitySignals, 'third_party_allocation_context');
    appendUnique(extractionFlags, 'third_party_allocation_context');
  }

  const total = identity + intent + sourceQuality + d1Support - extractionRisk;
  const severeMismatch = extractionFlags.includes('domain_name_mismatch') &&
    crossD1RoleCheck.role !== 'startup_or_private_company' &&
    existing.matchStrength !== 'domain' &&
    existing.matchStrength !== 'company_id';
  const nonProspectContextRisk = extractionFlags.some(flag => [
    'event_or_program_channel_context',
    'partnership_or_mature_company_context',
    'productivity_tooling_context',
    'materials_only_context',
    'calendar_only_context',
    'relationship_only_context',
    'coordination_only_context',
  ].includes(flag));
  const verifiedInvestmentIntent =
    sourceSupportedDealPitchDocument ||
    subjectTargetInvestmentEvidence ||
    strongCandidatePitchMaterialEvidence ||
    productPitchParentCompanyEvidence ||
    medinaOutboundProspectInterestEvidence ||
    strongSourceInvestmentIntent ||
    hasCurrentCompanyInvestmentTargetEvidence(text, mention.canonicalName);

  let verdict: LowConfidenceVerificationVerdict = 'provisional_create';
  let actionOverride: LowConfidenceVerificationActionOverride = 'mark_provisional';
  let reason = 'low_confidence_needs_confirmation';

  if (crossD1RoleCheck.role === 'known_deal' && crossD1RoleCheck.matched_deal_id && crossD1RoleCheck.confidence !== 'low') {
    verdict = 'verified_create';
    actionOverride = null;
    reason = 'known_deal_handled_by_cross_d1';
  } else if (
    crossD1RoleCheck.role === 'known_deal' &&
    crossD1RoleCheck.confidence === 'low' &&
    crossD1RoleCheck.evidence.some(evidence => /(?:possible\s+)?open deal by name only|matched open deal by name only/i.test(evidence))
  ) {
    verdict = 'record_context';
    actionOverride = 'record_context';
    reason = 'low_confidence_name_only_deal_match';
  } else if (thirdPartyAllocationContext) {
    verdict = 'record_context';
    actionOverride = 'record_context';
    reason = 'low_confidence_third_party_allocation_context';
  } else if (internalGeneratedMeeting && limitedInfoAuditSupport && !cleanInternalMeetingAnchor) {
    verdict = 'record_context';
    actionOverride = 'record_context';
    reason = 'low_confidence_internal_meeting_without_clean_anchor';
  } else if (severeMismatch && intent < 4) {
    verdict = 'record_context';
    actionOverride = 'record_context';
    reason = 'low_confidence_identity_domain_mismatch';
  } else if (identity <= 1 && intent <= 2 && d1Support <= 0) {
    verdict = nonProspectContextRisk ? 'record_context' : sourceQuality <= -1 || extractionRisk >= 2 ? 'ignore' : 'record_context';
    actionOverride = verdict === 'ignore' ? 'ignore' : 'record_context';
    reason = 'low_confidence_insufficient_identity_and_intent';
  } else if (nonProspectContextRisk && !verifiedInvestmentIntent) {
    verdict = 'record_context';
    actionOverride = 'record_context';
    reason = 'low_confidence_context_without_investment_intent';
  } else if (productPitchParentCompanyEvidence && total >= 4 && extractionRisk <= 1) {
    verdict = 'verified_create';
    actionOverride = null;
    reason = 'low_confidence_verified_by_product_parent_pitch';
  } else if (verifiedInvestmentIntent && ((identity >= 4 && intent >= 4 && total >= 5 && extractionRisk <= 2) || (intent >= 5 && total >= 5 && extractionRisk === 0))) {
    verdict = 'verified_create';
    actionOverride = null;
    reason = 'low_confidence_verified_by_identity_and_intent';
  } else if ((d1Support >= 2 && identity >= 3 && total >= 4 && extractionRisk <= 1) || (identity >= 5 && total >= 4 && extractionRisk <= 1) || (identity >= 3 && intent >= 2 && total >= 3) || (intent >= 4 && total >= 3)) {
    verdict = 'provisional_create';
    actionOverride = 'mark_provisional';
    reason = 'low_confidence_plausible_but_not_fully_verified';
  } else {
    verdict = 'record_context';
    actionOverride = 'record_context';
    reason = 'low_confidence_unverified';
  }

  return {
    checked: true,
    eligible: true,
    verdict,
    action_override: actionOverride,
    reason,
    scores: {
      identity,
      intent,
      source_quality: sourceQuality,
      d1_support: d1Support,
      extraction_risk: extractionRisk,
      total,
    },
    identity_signals: identitySignals,
    intent_signals: intentSignals,
    source_quality_signals: sourceQualitySignals,
    d1_signals: d1Signals,
    extraction_flags: extractionFlags,
  };
}

function emailInText(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function domainInText(text: string): string | null {
  const email = emailInText(text);
  if (email) {
    const domain = emailDomain(email);
    return strictRegistrableDomain(domain);
  }
  const [domain] = domainsInText(text);
  return domain || null;
}

function domainFromMention(item: ClassifiedItem, mention: MentionCandidate): string | null {
  return domainInText([
    mention.listFields?.website || '',
    mention.raw,
    mention.lineText,
    mention.contextText,
  ].filter(Boolean).join('\n'));
}

async function upsertDealmakerIdentity(
  orgId: string,
  input: { name: string | null; email?: string | null; domain?: string | null },
  occurredAt: string,
  env: Env
): Promise<{ id: string | null; name: string | null }> {
  const name = normalizeWhitespace(input.name || input.email || input.domain || '');
  if (!name) return { id: null, name: null };
  const normalizedEmail = input.email?.trim().toLowerCase() || null;
  const normalizedName = normalizeProspectName(name);
  const domain = (input.domain || (normalizedEmail ? emailDomain(normalizedEmail) : null) || '').trim().toLowerCase() || null;

  const existing = normalizedEmail
    ? await env.D1.prepare(
      `SELECT id, name FROM dealmakers WHERE org_id = ? AND normalized_email = ? LIMIT 1`
    ).bind(orgId, normalizedEmail).first<{ id: string; name: string | null }>()
    : await env.D1.prepare(
      `SELECT id, name FROM dealmakers
        WHERE org_id = ? AND normalized_email IS NULL AND normalized_name = ?
        LIMIT 1`
    ).bind(orgId, normalizedName).first<{ id: string; name: string | null }>();

  if (existing?.id) {
    await env.D1.prepare(
      `UPDATE dealmakers
          SET name = COALESCE(?, name),
              normalized_name = COALESCE(?, normalized_name),
              domain = COALESCE(?, domain),
              last_seen_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(name, normalizedName || null, domain, occurredAt, existing.id, orgId).run();
    return { id: existing.id, name: existing.name || name };
  }

  await env.D1.prepare(
    `INSERT INTO dealmakers
       (id, org_id, name, email, normalized_email, normalized_name, domain, warmth_level, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'warm', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(crypto.randomUUID(), orgId, name, normalizedEmail, normalizedEmail, normalizedName || null, domain, occurredAt, occurredAt).run();

  const row = normalizedEmail
    ? await env.D1.prepare(
      `SELECT id, name FROM dealmakers WHERE org_id = ? AND normalized_email = ? LIMIT 1`
    ).bind(orgId, normalizedEmail).first<{ id: string; name: string | null }>()
    : await env.D1.prepare(
      `SELECT id, name FROM dealmakers
        WHERE org_id = ? AND normalized_email IS NULL AND normalized_name = ?
        ORDER BY created_at DESC LIMIT 1`
    ).bind(orgId, normalizedName).first<{ id: string; name: string | null }>();
  return { id: row?.id || null, name: row?.name || name };
}

async function upsertSenderDealmaker(item: ClassifiedItem, orgId: string, occurredAt: string, env: Env): Promise<{ id: string | null; name: string | null }> {
  const fromEmail = item.fromEmail?.trim().toLowerCase() || '';
  const internalDomains = getConfiguredInternalDomains(env);
  if (!fromEmail || isInternalEmailDomain(fromEmail, internalDomains)) {
    return { id: null, name: null };
  }
  return upsertDealmakerIdentity(
    orgId,
    { name: item.fromName || fromEmail, email: fromEmail, domain: emailDomain(fromEmail) },
    occurredAt,
    env
  );
}

async function upsertMentionDealmaker(
  item: ClassifiedItem,
  mention: MentionCandidate,
  orgId: string,
  occurredAt: string,
  env: Env
): Promise<{ id: string | null; name: string | null }> {
  const lineEmail = emailInText(mention.lineText);
  const lineDomain = domainInText(mention.lineText);
  return upsertDealmakerIdentity(
    orgId,
    { name: mention.canonicalName, email: lineEmail, domain: lineDomain },
    occurredAt,
    env
  );
}

function buildClassifierPrefilter(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  env: Env
): ClassifierPrefilter {
  const deterministicDirection = inferDirection(item, env, existing.companyDomain || domainFromMention(item, mention));
  const newsletter = isNewsletterLike(item);
  const hasDeck = hasDeckSignal(item);
  const hasMeeting = hasMeetingSignal(item);
  const hasWarmIntro = isWarmIntroSignal(item, mention);
  const signalKind = signalKindFor(item, mention, hasDeck, hasMeeting);
  const sectorHint = sectorHintForText(`${mention.canonicalName}\n${mention.contextText || mention.lineText}\n${item.subject || ''}\n${item.bodyPreview || ''}`);
  const confidenceHint = confidenceFor(signalKind, deterministicDirection, newsletter);
  const reasons: string[] = [];
  if (newsletter) reasons.push('newsletter_like_source');
  if (existing.isInternal) reasons.push('matched_internal_company');
  if (existing.relationshipStates.includes('current_portfolio') || existing.relationshipStates.includes('exited')) reasons.push('portfolio_relationship_match');
  if (existing.dealId) reasons.push(existing.matchStrength === 'company_id' ? 'direct_existing_deal_match' : 'soft_existing_deal_match');
  if (hasDeck) reasons.push('deck_signal');
  if (hasMeeting) reasons.push('meeting_or_call_signal');
  if (hasWarmIntro) reasons.push('warm_intro_language');
  if (mention.isListEntry) reasons.push('list_entry_shape');
  if (signalKind === 'cold_mention') reasons.push('cold_mention_shape');

  return {
    shouldClassify: Boolean(mention.normalizedName && mention.normalizedName.length >= 3),
    reasons,
    deterministicDirection,
    newsletterLikely: newsletter,
    hasDeck,
    hasMeeting,
    hasWarmIntro,
    signalKind,
    sectorHint,
    confidenceHint,
  };
}

function sourcePrefilter(item: ClassifiedItem, env: Env): { shouldScan: boolean; reasons: string[] } {
  const from = `${item.fromEmail || ''} ${item.fromName || ''}`.toLowerCase();
  const subject = (item.subject || '').toLowerCase();
  const body = `${item.bodyPreview || ''}\n${item.bodyText || ''}\n${item.text || ''}`.toLowerCase();
  const haystack = `${from}\n${subject}\n${body}`;
  if (isGeneratedPipelineReportArtifact(haystack)) {
    if (isInternalPipelineReportText(haystack) && isDealflowListText(`${item.subject || ''}\n${item.bodyText || ''}\n${item.text || ''}`)) {
      return { shouldScan: true, reasons: ['generated_pipeline_report_dealflow_allow_signal'] };
    }
    return { shouldScan: false, reasons: ['generated_pipeline_report_artifact'] };
  }
  const allowSignals = [
    /\b(intro|introduc|deal\s?flow|pitch deck|deck attached|cim|teaser|data room|raising|fundraise|series [abc]|seed round|demo day|armyfuze)\b/,
    /#dealflow-pipeline/i,
  ];
  if (allowSignals.some(re => re.test(haystack))) {
    return { shouldScan: true, reasons: ['dealflow_allow_signal'] };
  }
  if (hasDeckSignal(item) || isDealflowListText(`${item.subject || ''}\n${item.bodyText || ''}\n${item.text || ''}`)) {
    return { shouldScan: true, reasons: ['deck_or_list_allow_signal'] };
  }
  const dropChecks: Array<[RegExp, string]> = [
    [/\b(invoice|receipt|bill|billing|payment due|statement)\b/, 'billing_or_invoice'],
    [/\b(fund admin|capital call|tax document|k-1|schedule k|trustserve|ramp)\b/, 'fund_admin_or_expense'],
    [/\b(counsel|legal notice|engagement letter|gtlaw\.com)\b/, 'legal_or_counsel'],
    [/\b(website visit|visitors?|analytics|utm_|page views?|services@)\b/, 'web_analytics_summary'],
    [/\b(4th grade|school trip|birthday|dinner reservation|personal)\b/, 'personal_or_family'],
  ];
  const matched = dropChecks.find(([re]) => re.test(haystack));
  if (matched) return { shouldScan: false, reasons: [matched[1]] };

  const internalDomains = getConfiguredInternalDomains(env);
  if (item.type === 'slack_message' && !/#dealflow-pipeline/i.test(`${item.subject || ''}\n${item.bodyText || ''}`)) {
    return { shouldScan: true, reasons: ['slack_internal_pass_to_classifier'] };
  }
  if (item.fromEmail && isInternalEmailDomain(item.fromEmail, internalDomains) && /\b(customer|bd|sales|partnership)\b/.test(haystack)) {
    return { shouldScan: true, reasons: ['outbound_bd_pass_to_classifier'] };
  }
  return { shouldScan: true, reasons: [] };
}

function sourceTypeForPrompt(item: ClassifiedItem): string {
  if (item.type === 'email') return 'email';
  if (item.type === 'slack_message') return 'Slack';
  if (item.type === 'calendar_event') return 'meeting';
  if (item.type === 'news') return 'news';
  return item.entityType;
}

function senderAndContextForPrompt(item: ClassifiedItem, existing: ExistingContext): string {
  const parts = [
    item.fromName || item.fromEmail ? `from ${normalizeWhitespace(`${item.fromName || ''} ${item.fromEmail || ''}`)}` : '',
    item.subject ? `subject: ${item.subject}` : '',
    item.toEmails?.length ? `to: ${item.toEmails.slice(0, 8).join(', ')}` : '',
    item.ccEmails?.length ? `cc: ${item.ccEmails.slice(0, 8).join(', ')}` : '',
    item.direction ? `source direction field: ${item.direction}` : '',
    existing.relationshipStates.length ? `matched firm relationship states: ${existing.relationshipStates.join(', ')}` : '',
    existing.dealId ? `matched open deal id: ${existing.dealId}` : '',
    existing.companyId ? `matched CRM company for identity/dedupe only: ${existing.companyId}` : '',
    existing.companyDomain ? `matched CRM company domain for identity/dedupe only: ${existing.companyDomain}` : '',
  ].filter(Boolean);
  return compactClassifierText(parts.join(' | '), 900);
}

function deterministicGateContextForSource(item: ClassifiedItem): string {
  const metadata = (item.metadata || {}) as unknown as Record<string, unknown>;
  const entityName = typeof metadata.entity_name === 'string' ? normalizeWhitespace(metadata.entity_name) : '';
  const documentType = typeof metadata.document_type === 'string' ? normalizeWhitespace(metadata.document_type) : '';
  const textSource = typeof metadata.text_source === 'string' ? normalizeWhitespace(metadata.text_source) : '';
  return [
    entityName ? `source entity name: ${entityName}` : '',
    documentType ? `source document type: ${documentType}` : '',
    textSource ? `source text source: ${textSource}` : '',
  ].filter(Boolean).join(' | ');
}

function senderAndContextForDeterministicGates(item: ClassifiedItem, senderAndContext: string): string {
  return normalizeWhitespace([
    deterministicGateContextForSource(item),
    senderAndContext,
  ].filter(Boolean).join(' | '));
}

function rawExcerptForPrompt(item: ClassifiedItem, mention: MentionCandidate): string {
  const fullSourceContext = repairBrokenDomainWhitespace(item.bodyText || item.text || mention.contextText || mention.lineText || '');
  const sourceContext = mention.contextText || mention.lineText || fullSourceContext;
  const listRowContext = rowContextWindowForListMention(fullSourceContext, mention, 2200);
  const promptAnchor = findCaseInsensitive(sourceContext, mention.raw) >= 0
    ? findCaseInsensitive(sourceContext, mention.raw)
    : findCaseInsensitive(sourceContext, mention.canonicalName);
  const mentionContext = listRowContext || (promptAnchor >= 0
    ? prospectContextWindow(sourceContext, promptAnchor, promptAnchor + (mention.raw || mention.canonicalName).length, 3000)
    : sourceContext);
  const preview = !listRowContext && item.bodyPreview && !mentionContext.includes(item.bodyPreview)
    ? `Preview: ${item.bodyPreview}`
    : '';
  const mentionLineForPrompt = listRowContext ? '' : mention.lineText;
  const excerpt = [
    item.subject ? `Subject: ${item.subject}` : '',
    mentionLineForPrompt ? `Mention line: ${mentionLineForPrompt}` : '',
    mentionContext ? `${listRowContext ? `Candidate row context for ${mention.canonicalName}` : 'Mention context'}:\n${mentionContext}` : '',
    preview,
  ].filter(Boolean).join('\n');
  return compactClassifierText(excerpt, 3500);
}

function classifierInputForRuntime(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  prefilter: ClassifierPrefilter,
  knownContext: ProspectClassifierKnownContext,
  orgId: string
): ProspectClassifierInput {
  return {
    sourceType: sourceTypeForPrompt(item),
    senderAndContext: senderAndContextForPrompt(item, existing),
    companyName: mention.canonicalName,
    rawExcerpt: rawExcerptForPrompt(item, mention),
    knownContext,
    orgId,
    sectorHints: prefilter.sectorHint,
    prefilterHints: {
      should_classify: prefilter.shouldClassify,
      reasons: prefilter.reasons,
      deterministic_direction: prefilter.deterministicDirection,
      newsletter_likely: prefilter.newsletterLikely,
      signal_kind_hint: prefilter.signalKind,
      has_deck: prefilter.hasDeck,
      has_meeting_or_call: prefilter.hasMeeting,
      has_warm_intro_language: prefilter.hasWarmIntro,
      sector_hint: prefilter.sectorHint,
      confidence_hint: prefilter.confidenceHint,
      mention: {
        mention_ordinal: mention.mentionOrdinal,
        raw: mention.raw,
        normalized_name: mention.normalizedName,
        is_list_entry: mention.isListEntry,
        products: mention.products,
        parse_dealflow_list: Boolean(mention.listFields),
        list_fields: mention.listFields || null,
      },
      crm_context: {
        matched_company_id: existing.companyId,
        matched_open_deal_id: existing.dealId,
        matched_company_domain: existing.companyDomain,
        relationship_states: existing.relationshipStates,
        matched_internal_company: existing.isInternal,
        match_strength: existing.matchStrength,
      },
    },
  };
}

function buildProspectClassifierPrompt(input: ProspectClassifierInput): { system: string; systemForApi: ClaudeSystemPrompt; user: string } {
  const knownDeals = entityListForPrompt(input.knownContext.knownDeals);
  const knownDealmakers = entityListForPrompt(input.knownContext.knownDealmakers);
  const prefilterHints = JSON.stringify(input.prefilterHints);
  const sectorHints = JSON.stringify(input.sectorHints);

  const staticSystem = `You review one candidate company mention extracted from a source item for Medina Ventures,
a venture capital firm. You output strict JSON and nothing else.

Primary mission:
Your only job is to decide whether the candidate is the company actually being put in
front of Medina Ventures as a possible investment. Answer is_prospect=true only when
the candidate itself is the investment prospect.

Fund context -- for SECTOR judgment only, NEVER for deciding prospect status:
Medina Ventures invests at seed and Series A in enterprise and government backend
software -- AI, quantum, and cybersecurity.

Critical prospect-status rules:
- Thesis fit does not determine prospect status. Off-thesis, unusual, mature, early,
  late, consumer, hardware, or defense companies still count if they are being
  presented as investment opportunities.
- The candidate name is the object being judged. Do not answer true for the sender,
  broker, investor, advisor, customer, event host, program, calendar host, document
  wrapper, participant, university, government channel, service provider, or buyer
  unless that exact candidate is clearly the investment target.
- Strong prospect evidence includes a direct pitch submission, explicit fundraise or
  round language, SAFE, valuation, allocation, data room, diligence request, financial
  model, NDA, term sheet, investor deck, company deck, one-pager, memo, acquisition
  opportunity, founder intro, or an explicit statement that the company is being shared
  as an investment opportunity.
- If your reasoning says the candidate is introduced, pitched, raising, shown with an
  investor deck, listed with a funding ask/stage/contact, or central to a diligence or
  investment review, the verdict should usually be is_prospect=true. Use confidence
  for thin evidence; do not demote the actual target just because the source arrived
  through an advisor, government channel, program, or messy forwarded packet.
- Existing CRM, company, portfolio, prospect, deal, domain, and relationship hints are
  identity/dedupe evidence only. They do not by themselves prove prospect status or
  disprove prospect status.
- If an existing company is being newly pitched to Medina as an investment opportunity,
  answer is_prospect=true; downstream dedupe can connect it to the right entity.
- If the candidate is merely an existing entity being discussed, and not currently
  being pitched as an investment opportunity, answer is_prospect=false.

Multi-company source rules:
- Preserve the actual target. If Company A introduces, funds, advises, hosts, sells to,
  buys from, or routes Company B, Company A is not the prospect and Company B may be.
- In lists, cohorts, pipeline reports, roadshows, packets, tables, and deck indexes,
  judge each actual company row independently. Many rows can be prospects. Do not
  promote the packet title, program name, event name, sender, or first row.
- A government, university, accelerator, conference, or program packet can be a false
  wrapper while multiple listed company rows in the same source are true prospects.
  A row with a company name plus stage, amount, ask, contact, problem, approach,
  website, or description should be judged as the company row, not as the wrapper.
- In meeting summaries or transcripts, answer true only for the company whose product,
  demo, pitch, fundraising, diligence, founder conversation, investment discussion, or
  next steps are central.
- Meeting participants, attendees, hosts, transcript tooling, calendar invitees, and
  relationship-maintenance entities are not prospects just because they appear in a
  meeting source.

False-positive traps:
- Attachments help only when the candidate is also being pitched, introduced, raising,
  reviewed, or shared as an opportunity. File names, folder labels, section headings,
  generic document titles, HTML/CSS/schema fragments, and copied scaffolding are not
  prospects.
- Public news, newsletters, market digests, website analytics, auth notices, billing or
  admin emails, quarantine/security warnings, phishing notices, sender identity
  warnings, calendar shells, demo scheduling shells, and generic fragments are not
  prospects unless the candidate itself is explicitly being put forward as an investment
  opportunity.
- A person, slash/comma/plus/ampersand joined participant list, or "person of company"
  phrase is not a prospect company.

Reasoning rules:
- Reasoning must be short and concrete.
- Name the candidate when possible.
- Cite the strongest evidence for why it is or is not a prospect.
- Do not classify the non-prospect universe into categories. Only explain the verdict.

direction -- choose exactly one:
  inbound   -- an external party is presenting a company to the fund.
  outbound  -- the fund is reaching out.
  internal  -- fund-internal communication.
  news      -- informational, no pitch.

sector_key -- choose exactly one by the candidate company's PRIMARY value proposition;
if genuinely unclear or not a prospect, use "uncategorized":
  ${PROSPECT_SECTOR_LABELS}
Also output sector_confidence in [0,1].

Rubric examples (generic; apply as rules, not source facts):
Target Cybersecurity Company with intro + deck -> {"is_prospect":true,"prospect_company_name":"Target Cybersecurity Company","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Target Cybersecurity Company is introduced with an investor deck for Medina review."}
Advisor Firm presenting Target Quantum Company -> {"is_prospect":false,"prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Advisor Firm is routing another company, not itself as the investment target."}
Target Quantum Company in an advisor-presented pitch -> {"is_prospect":true,"prospect_company_name":"Target Quantum Company","direction":"inbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.94,"reasoning":"Target Quantum Company is the company being presented as an investment opportunity."}
Investor Firm named as a backer near a target -> {"is_prospect":false,"prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.92,"reasoning":"Investor Firm is a backer of another company, not the candidate being pitched."}
Customer Company in a commercial thread -> {"is_prospect":false,"prospect_company_name":null,"direction":"outbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Customer Company is a buyer or design partner context, not an investment prospect."}
Government Program forwarding dealflow -> {"is_prospect":false,"prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Government Program is the source channel, not a company being pitched."}
Listed Dual-Use Company in that packet -> {"is_prospect":true,"prospect_company_name":"Listed Dual-Use Company","direction":"inbound","sector_key":"aerospace_defense","sector_confidence":0.8,"confidence":0.9,"reasoning":"Listed Dual-Use Company appears as a fundraising row with stage, ask, and contact."}
Off-Thesis Materials Company in a fundraising list -> {"is_prospect":true,"prospect_company_name":"Off-Thesis Materials Company","direction":"inbound","sector_key":"materials_manufacturing","sector_confidence":0.85,"confidence":0.9,"reasoning":"Off-Thesis Materials Company appears as a fundraising company row with stage and ask."}
Known Dealmaker forwarding Target AI Company -> {"is_prospect":false,"prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.92,"reasoning":"Known Dealmaker is the source, not the company being pitched."}
Target AI Company from that warm intro -> {"is_prospect":true,"prospect_company_name":"Target AI Company","direction":"inbound","sector_key":"ai_data","sector_confidence":0.85,"confidence":0.9,"reasoning":"Target AI Company is introduced to Medina with investor materials."}
Central Company in an investment summary -> {"is_prospect":true,"prospect_company_name":"Central Company","direction":"inbound","sector_key":"enterprise_software","sector_confidence":0.75,"confidence":0.88,"reasoning":"Central Company is the subject of an investment summary for review."}
Existing CRM Company discussed as context -> {"is_prospect":false,"prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Existing CRM Company is only being discussed as existing context, not newly pitched."}
Existing Company newly pitched as an opportunity -> {"is_prospect":true,"prospect_company_name":"Existing Company","direction":"inbound","sector_key":"enterprise_software","sector_confidence":0.8,"confidence":0.9,"reasoning":"Existing Company is newly shared with investment materials for Medina review."}
Calendar or demo shell without investment evidence -> {"is_prospect":false,"prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"The source only contains scheduling or calendar details, not an investment pitch."}
Security quarantine or sender warning -> {"is_prospect":false,"prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.95,"reasoning":"The source is a security warning or quarantine artifact, not a prospect pitch."}
Newsletter or public fundraise news only -> {"is_prospect":false,"prospect_company_name":null,"direction":"news","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.92,"reasoning":"The source is informational public news, not a company being put to Medina."}

Output ONLY this JSON object, no prose, no code fences:
{"is_prospect":true,"prospect_company_name":"...","direction":"...","sector_key":"...","sector_confidence":0.0,"confidence":0.0,"reasoning":"one short sentence"}
For non-prospects, set is_prospect=false and prospect_company_name=null.
confidence is your overall confidence in the is_prospect + direction verdict, in [0,1].`;

  const policyLens = input.policyLens
    ? `\n\nPOLICY LENS FOR THIS QUARANTINED EVALUATION RUN:\n${input.policyLens.name} (${input.policyLens.id})\n${input.policyLens.instructions}\nUse this lens only to resolve borderline cases inside the schema. Do not violate the hard rules above.`
    : '';

  const dynamicSystem = `KNOWN open deals / true portfolio companies (names + domains): ${knownDeals}
KNOWN dealmakers / intro sources (names + domains): ${knownDealmakers}
CRM context note: matched_company_id/domain in the JSON are for identity and deduplication.
They do not by themselves prove or disprove prospect status.

Hints (heuristic pre-filter and sector hints -- WEAK signals, not ground truth; override
them when the content disagrees): ${prefilterHints} ${sectorHints}${policyLens}`;

  const system = `${staticSystem}\n\n${dynamicSystem}`;
  const systemForApi: ClaudeSystemPrompt = [
    { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: dynamicSystem },
  ];

  const user = `SOURCE_TYPE: ${input.sourceType}
FROM / CONTEXT: ${input.senderAndContext}
MENTION (the company in question): ${input.companyName}
EXCERPT:
${input.rawExcerpt}`;

  return { system, systemForApi, user };
}

function parseProspectClassifierDecisionObject(
  parsed: Record<string, unknown>,
  model: string,
  usage?: ClaudeUsage
): LlmClassifierDecision {
  const hasProspectVerdict = Object.prototype.hasOwnProperty.call(parsed, 'is_prospect');
  if (hasProspectVerdict && typeof parsed.is_prospect !== 'boolean') {
    throw new Error('INVALID_LLM_IS_PROSPECT');
  }
  const legacyMentionType = parsed.mention_type ? parseMentionType(parsed.mention_type) : 'noise';
  const legacyProspectAction = parseProspectAction(parsed.prospect_action, legacyMentionType, parsed.signal_disposition);
  const isProspect = hasProspectVerdict
    ? parsed.is_prospect === true
    : legacyProspectAction === 'create_prospect';
  const prospectAction: ProspectAction = isProspect ? 'create_prospect' : legacyProspectAction === 'record_context' ? 'record_context' : 'ignore';
  const prospectCompanyName = isProspect ? parseNullableClassifierString(parsed.prospect_company_name) : null;
  return {
    isProspect,
    mentionType: mentionTypeForAction(prospectAction),
    direction: parseDirection(parsed.direction),
    sectorKey: parseSectorKey(parsed.sector_key),
    sectorConfidence: parseUnitConfidence(parsed.sector_confidence, 'sector_confidence'),
    confidence: parseUnitConfidence(parsed.confidence, 'confidence'),
    prospectAction,
    prospectCompanyName,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : null,
    model,
    usage,
  };
}

function parseProspectClassifierResponse(
  raw: string,
  model: string,
  usage?: ClaudeUsage
): LlmClassifierDecision {
  const parsed = parseJsonObject(raw, 'INVALID_PROSPECT_CLASSIFIER_JSON');
  return parseProspectClassifierDecisionObject(parsed, model, usage);
}

function hasClassifierContradictoryTargetIntent(
  llm: LlmClassifierDecision,
  classifierInput: ProspectClassifierInput,
  mention: MentionCandidate
): boolean {
  if (llm.prospectAction !== 'record_context' && llm.prospectAction !== 'ignore') return false;
  if (llm.direction !== 'inbound' && llm.direction !== 'internal') return false;
  const normalizedMention = mention.normalizedName || normalizeProspectName(mention.canonicalName);
  if (
    looksLikePersonName(mention.canonicalName) ||
    looksLikePersonOrParticipantBundle(mention.canonicalName) ||
    VETO_SINGLE_PERSON_NAMES.has(normalizedMention)
  ) {
    return false;
  }
  const text = normalizeWhitespace([
    classifierInput.senderAndContext,
    classifierInput.rawExcerpt,
    llm.reasoning || '',
  ].join(' '));
  const reasoning = String(llm.reasoning || '');
  const targetEvidence = hasCandidateProspectTargetEvidence(text, reasoning, mention);
  if (llm.confidence < 0.88 && !targetEvidence) return false;
  if (llm.confidence < 0.68) return false;
  if (classifierReasoningExplicitlyRejectsProspect(reasoning) && !targetEvidence) {
    return false;
  }
  if (
    /\b(?:known\s+(?:open\s+)?deal|known\s+portfolio|portfolio\s+company|existing\s+(?:portfolio|deal|relationship|engagement)|current\s+portfolio|not\s+the\s+new\s+prospect|not\s+the\s+prospect\s+being\s+(?:introduced|pitched)|complementary\s+solution\s+context)\b/i.test(reasoning) &&
    !targetEvidence
  ) {
    return false;
  }
  if (classifierReasoningSaysMentionIsNotTarget(reasoning, mention.canonicalName) && !targetEvidence) {
    return false;
  }
  if (/\b(?:not\s+the\s+investment\s+target|not\s+the\s+target\s+itself|mention\s+(?:field\s+)?is\s+a\s+person|person,\s+not\s+the\s+company|co[-\s]?founder\s+of\s+[A-Z][A-Za-z0-9&.'’-]+)/i.test(reasoning)) {
    return false;
  }
  if (
    /\b(?:not\s+the\s+company\s+being\s+pitched|not\s+the\s+actual\s+(?:prospect|target)|actual\s+(?:prospect\s+)?company\s+is|actual\s+target\s+is)\b/i.test(reasoning) &&
    !hasCompanyToken(mention.canonicalName)
  ) {
    return false;
  }
  const saysTarget = targetEvidence || /\b(?:being\s+(?:directly\s+)?(?:presented|pitched|introduced)|presented\s+as|pitched\s+as|investment\s+opportunity|inbound\s+(?:investment\s+)?opportunity|clear\s+inbound|clear\s+(?:investment\s+)?pitch|funding\s+round|active\s+(?:fundrais|investment)|series\s+[abc]\s+(?:discussion|opportunity)|data\s+room|diligence|fund\s*raising\s+list|fundraising\s+list|listed\s+(?:in|on)\s+(?:a\s+)?fundrais(?:e|ing))\b/i.test(reasoning);
  if (!saysTarget) return false;
  const reasoningDirectlyNamesTarget = (sourceMentionsName(reasoning, mention.canonicalName) &&
    /\b(?:investment\s+opportunity|inbound\s+(?:investment\s+)?opportunity|formal\s+pitch|pitch\s+meeting|being\s+(?:directly\s+)?(?:presented|pitched|introduced)|fundrais(?:e|ing)|fund\s*raising|raising|round|ask|data\s+room|diligence|deck\s+attached|warm\s+intro)\b/i.test(reasoning)) ||
    (targetEvidence && sourceMentionsName(reasoning, mention.canonicalName));
  if (
    !reasoningDirectlyNamesTarget &&
    !hasStrongSourceInvestmentIntent(text) &&
    !hasCurrentCompanyInvestmentTargetEvidence(text, mention.canonicalName) &&
    !targetEvidence
  ) {
    return false;
  }
  const veto = prospectValuableActionVetoForMention({
    prospectAction: 'create_prospect',
    companyName: mention.canonicalName,
    rawMention: mention.raw,
    rawExcerpt: classifierInput.rawExcerpt,
    senderAndContext: classifierInput.senderAndContext,
    prospectCompanyName: mention.canonicalName,
    llmReasoning: llm.reasoning,
  });
  if (!veto.applied) return true;
  const hardVetoReasons = new Set([
    'section_heading_or_document_outline',
    'html_schema_or_markup_artifact',
    'admin_link_or_calendar_scaffolding',
    'tool_vendor_or_link_host',
    'venue_or_physical_location',
    'government_customer_or_buyer_entity',
    'service_provider_or_intermediary',
    'person_or_participant_bundle',
    'event_or_program_channel_without_investment_target',
    'non_investment_event_fundraising_or_postmortem_context',
    'partnership_or_mature_company_without_investment_target',
    'productivity_tooling_context_without_investment_target',
    'relationship_only_context_without_investment_target',
    'coordination_only_context_without_investment_target',
    'news_or_digest_only',
    'customer_partner_or_buyer_context',
    'lp_or_fund_context_not_prospect',
  ]);
  if (
    reasoningDirectlyNamesTarget &&
    !hardVetoReasons.has(veto.reason || '') &&
    !VETO_PARTNER_CHANNEL_NAMES.has(normalizedMention) &&
    !is_event_channel_context(text, mention.canonicalName)
  ) {
    return true;
  }
  if (
    veto.reason === 'source_or_intro_entity_not_target' &&
    !VETO_PARTNER_CHANNEL_NAMES.has(normalizedMention) &&
    !is_event_channel_context(text, mention.canonicalName) &&
    (reasoningDirectlyNamesTarget || hasCurrentCompanyInvestmentTargetEvidence(text, mention.canonicalName) || targetEvidence)
  ) {
    return true;
  }
  return false;
}

function hasFinalSelfContradictoryCreateSignal(
  llm: LlmClassifierDecision,
  classifierInput: ProspectClassifierInput,
  mention: MentionCandidate
): boolean {
  if (llm.confidence < 0.88) return false;
  if (llm.direction !== 'inbound' && llm.direction !== 'internal') return false;
  const normalizedMention = mention.normalizedName || normalizeProspectName(mention.canonicalName);
  if (
    VETO_PARTNER_CHANNEL_NAMES.has(normalizedMention) ||
    looksLikePersonName(mention.canonicalName) ||
    looksLikePersonOrParticipantBundle(mention.canonicalName) ||
    VETO_SINGLE_PERSON_NAMES.has(normalizedMention)
  ) {
    return false;
  }
  const reasoning = String(llm.reasoning || '');
  if (classifierReasoningExplicitlyRejectsProspect(reasoning)) {
    return false;
  }
  if (/\b(?:known\s+(?:open\s+)?deal|known\s+portfolio|portfolio\s+company|existing\s+(?:portfolio|deal|relationship|engagement)|current\s+portfolio|not\s+the\s+new\s+prospect|not\s+the\s+prospect\s+being\s+(?:introduced|pitched)|complementary\s+solution\s+context)\b/i.test(reasoning)) {
    return false;
  }
  if (classifierReasoningSaysMentionIsNotTarget(reasoning, mention.canonicalName)) {
    return false;
  }
  if (/\b(?:not\s+the\s+investment\s+target|not\s+the\s+target\s+itself|mention\s+(?:field\s+)?is\s+a\s+person|person,\s+not\s+the\s+company|co[-\s]?founder\s+of\s+[A-Z][A-Za-z0-9&.'’-]+)/i.test(reasoning)) {
    return false;
  }
  const reasoningDirectlyNamesTarget = sourceMentionsName(reasoning, mention.canonicalName) &&
    /\b(?:investment\s+opportunity|inbound\s+(?:investment\s+)?opportunity|formal\s+pitch|pitch\s+meeting|being\s+(?:directly\s+)?(?:presented|pitched|introduced)|fundrais(?:e|ing)|data\s+room|diligence|deck\s+attached|warm\s+intro)\b/i.test(reasoning);
  if (!reasoningDirectlyNamesTarget) return false;
  const text = normalizeWhitespace([
    classifierInput.senderAndContext,
    classifierInput.rawExcerpt,
    reasoning,
  ].join(' '));
  if (is_event_channel_context(text, mention.canonicalName)) return false;
  const veto = prospectValuableActionVetoForMention({
    prospectAction: 'create_prospect',
    companyName: mention.canonicalName,
    rawMention: mention.raw,
    rawExcerpt: classifierInput.rawExcerpt,
    senderAndContext: classifierInput.senderAndContext,
    prospectCompanyName: mention.canonicalName,
    llmReasoning: llm.reasoning,
  });
  if (!veto.applied) return true;
  const hardVetoReasons = new Set([
    'section_heading_or_document_outline',
    'html_schema_or_markup_artifact',
    'admin_link_or_calendar_scaffolding',
    'tool_vendor_or_link_host',
    'venue_or_physical_location',
    'government_customer_or_buyer_entity',
    'service_provider_or_intermediary',
    'person_or_participant_bundle',
    'event_or_program_channel_without_investment_target',
    'non_investment_event_fundraising_or_postmortem_context',
    'partnership_or_mature_company_without_investment_target',
    'productivity_tooling_context_without_investment_target',
    'relationship_only_context_without_investment_target',
    'coordination_only_context_without_investment_target',
    'news_or_digest_only',
    'customer_partner_or_buyer_context',
    'lp_or_fund_context_not_prospect',
  ]);
  return !hardVetoReasons.has(veto.reason || '');
}

function hasExplicitTargetInvestmentSignal(
  llm: LlmClassifierDecision,
  classifierInput: ProspectClassifierInput,
  mention: MentionCandidate
): boolean {
  if (llm.direction !== 'inbound' && llm.direction !== 'internal' && llm.direction !== 'outbound') return false;
  const normalizedMention = mention.normalizedName || normalizeProspectName(mention.canonicalName);
  if (
    VETO_PARTNER_CHANNEL_NAMES.has(normalizedMention) ||
    looksLikePersonName(mention.canonicalName) ||
    looksLikePersonOrParticipantBundle(mention.canonicalName) ||
    VETO_SINGLE_PERSON_NAMES.has(normalizedMention)
  ) {
    return false;
  }

  const reasoning = String(llm.reasoning || '');
  const sourceText = normalizeWhitespace([
    classifierInput.senderAndContext,
    classifierInput.rawExcerpt,
  ].join(' '));
  const fullText = normalizeWhitespace([sourceText, reasoning].join(' '));
  const productParentEvidence = hasProductPitchParentCompanyEvidence(sourceText, reasoning, mention.canonicalName);
  const candidateTargetEvidence = hasCandidateProspectTargetEvidence(sourceText, reasoning, mention);
  if (classifierReasoningHasHardNegativeRole(reasoning) && !candidateTargetEvidence) return false;
  if (
    !candidateTargetEvidence &&
    !productParentEvidence &&
    (
      /\bnot\s+(?:a\s+|an\s+|the\s+)?(?:new\s+|fresh\s+|actual\s+|clear\s+|current\s+)?(?:investment\s+)?(?:prospect|opportunity|pitch|investment\s+pitch|investment\s+target|venture\s+target|inbound\s+pitch)\b/i.test(reasoning) ||
      /\bnot\s+(?:being\s+)?(?:pitched|presented|introduced|shared)\s+as\s+(?:a\s+|an\s+|the\s+)?(?:investment\s+)?(?:prospect|opportunity|target|pitch)\b/i.test(reasoning) ||
      /\bno\s+(?:clear\s+|new\s+|fresh\s+|active\s+)?(?:investment\s+)?(?:opportunity|pitch|fundrais(?:e|ing)|diligence|dealflow|prospect|investment\s+ask)\b/i.test(reasoning) ||
      /\b(?:calendar|meeting)\s+(?:confirmation|acceptance|scaffold(?:ing)?|scheduling)\b[^.]{0,160}\b(?:not|no)\b[^.]{0,120}\b(?:pitch|opportunity|prospect|dealflow)\b/i.test(reasoning) ||
      /\b(?:relationship|lunch|contact|coordination|scheduling)\b[^.]{0,140}\b(?:not|no)\b[^.]{0,120}\b(?:pitch|investment|opportunity|prospect|dealflow)\b/i.test(reasoning) ||
      /\b(?:bank|financial\s+institution|military\s+command|government\s+(?:command|agency|buyer))\b[^.]{0,180}\bnot\b[^.]{0,140}\b(?:startup|investment\s+prospect|investment\s+opportunity|commercial\s+company|company\s+being\s+pitched)\b/i.test(reasoning) ||
      /\binternal\s+(?:fundrais(?:e|ing)|fund|investor[-\s]?tracking|investor\s+tracking|fund\s+product)\b[^.]{0,180}\bnot\b[^.]{0,140}\b(?:pitch|opportunity|prospect|dealflow)\b/i.test(reasoning)
    )
  ) {
    return false;
  }
  const reasoningNamesTarget = sourceMentionsName(reasoning, mention.canonicalName);
  const sourceNamesTarget = sourceMentionsName(sourceText, mention.canonicalName);
  const reasoningHasExplicitIntent =
    /\b(?:explicit(?:ly)?\s+(?:pitched|presented|shared|sent|framed)\s+as\s+(?:an?\s+)?(?:investment\s+)?opportunity|investment\s+opportunity\s+pitch|subject\s+(?:line\s+)?frames\b[^.]{0,120}\binvestment\s+opportunity|investment[-_\s]+(?:request|summary|proposal|memo|deck)|inbound\s+(?:investment\s+)?opportunity|dealflow\s+opportunity|pitch(?:ed|ing)?\s+(?:an?\s+)?investment\s+round|pitch[-_\s]+deck|investor[-_\s]+(?:deck|presentation)|deck\s+(?:attached|sent|shared)|sent\s+slides|demo\s+offer|deeper\s+dive|fund\s*raising\s+list|fundraising\s+list|listed\s+(?:in|on)\s+(?:a\s+)?fundrais(?:e|ing)|series\s+[abc]\s+(?:pitch|discussion|round|meeting)|seed\s+round|safe|valuation|data\s+room|diligence|financial\s+model|p&l|nda|term\s+sheet|acquisition\s+opportunit(?:y|ies))\b/i.test(reasoning);
  const sourceHasDirectTitleIntent =
    sourceNamesTarget &&
    /\b(?:investment[-_\s]+(?:opportunity|request|summary|proposal|memo|deck)|co[-\s]?investment|pitch[-_\s]+deck|investor[-_\s]+(?:deck|presentation)|series\s+[abc]|seed\s+round|safe|data\s+room|term\s+sheet|teaser|acquisition\s+opportunit(?:y|ies))\b/i.test(sourceText) &&
    !/\b(?:internal\s+fundrais(?:e|ing)|#fundraising|fundraising\s+status\s+reminder|portfolio\s+manager|factsheet|fund\s+product|online\s+access|security\s+manager\s+guide)\b/i.test(sourceText);
  const sourceHasTargetMeetingWithFirm =
    sourceNamesTarget &&
    /\b(?:medina\s+ventures|medina\s+vc|medina)\b/i.test(fullText) &&
    (/\b(?:intro|introduction|exploratory|zoom|meeting|call|connect(?:ing)?|follow[-\s]?up|accepted)\b/i.test(fullText) ||
      /(?:&|<>|\/\/)\s*(?:medina\s+ventures|medina\s+vc|medina)\b/i.test(sourceText)) &&
    /\b(?:warm\s+intro|exploratory\s+conversation|active\s+engagement|meeting\s+held|round\s+discussion|founder|ceo|pitch|demo|investment\s+opportunit(?:y|ies)|fundrais(?:e|ing)|raising|series\s+[abc]|safe|data\s+room|diligence|deck|investor\s+(?:overview|deck|presentation))\b/i.test(fullText) &&
    !/\b(?:postmortem|office\s+hours|team\s+meeting|standing\s+meeting|internal\s+meeting|meeting\s+acceptance|calendar\s+confirmation|calendar\s+scaffold(?:ing)?|scheduling\s+only|no\s+pitch|no\s+investment\s+pitch|not\s+an?\s+inbound\s+investment\s+pitch)\b/i.test(fullText);
  const knownProspectActiveContext =
    sourceNamesTarget &&
    /\b(?:known\s+open\s+deal|known\s+(?:crm\s+)?(?:company|prospect)|matched\s+(?:crm\s+)?(?:company|domain|id)|active\s+(?:deal|engagement|discussion)|existing\s+crm\s+company)\b/i.test(reasoning) &&
    /\b(?:series\s+[abc]|fundrais(?:e|ing)|raising|data\s+room|diligence|progress\s+update|founder\s+(?:sending|sharing)|ceo\s+scheduling|investment\s+round|investor\s+(?:overview|deck|presentation)|milestone\s+directly\s+to\s+fund|meeting\s+held|round\s+discussion|exploratory\s+conversation|warm\s+intro)\b/i.test(fullText);

  if (
    (classifierReasoningSaysMentionIsNotTarget(reasoning, mention.canonicalName) && !candidateTargetEvidence && !productParentEvidence) ||
    (classifierReasoningSaysMentionIsNotCompanyOrListChannel(reasoning) && !candidateTargetEvidence) ||
    (/\bnot\s+clearly\s+(?:the\s+|an?\s+)?(?:investment\s+)?(?:target|prospect|opportunity)\b/i.test(reasoning) && !candidateTargetEvidence && !productParentEvidence) ||
    /\bno\b[^.\n]{0,120}\b(?:company\s+deck|deck|round|diligence|investment\s+ask|pitch|fundrais(?:e|ing))\b/i.test(sourceText)
  ) {
    return false;
  }
  if (
    classifierReasoningExplicitlyRejectsProspect(reasoning) &&
    !/\boff[-\s]?thesis\b/i.test(reasoning) &&
    !knownProspectActiveContext &&
    !candidateTargetEvidence &&
    !productParentEvidence
  ) {
    return false;
  }
  if (
    /\b(?:source|intro\s+source|dealmaker|advisor|investor|backer|customer|partner|vendor|service\s+provider|event|program|channel|organizer|government\s+agency|person|participant)\b[^.]{0,180}\b(?:not|rather\s+than|instead\s+of)\b[^.]{0,140}\b(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched)\b/i.test(reasoning) &&
    !candidateTargetEvidence &&
    !productParentEvidence
  ) {
    return false;
  }
  if (
    /\b(?:from|by|via)\s+(?:a\s+)?known\s+(?:dealmaker|intro\s+source|source|channel|partner)\b/i.test(reasoning) &&
    !sourceHasTargetMeetingWithFirm &&
    !knownProspectActiveContext &&
    !candidateTargetEvidence
  ) {
    return false;
  }

  if (
    /\b(?:no\s+company\s+or\s+investment\s+opportunity|administrative\s+artifact|not\s+(?:a\s+|an\s+)?(?:company|company\s+prospect|startup|investment\s+opportunity|current\s+investment\s+opportunity|investment\s+target|prospect)|not\s+(?:being\s+)?pitched|not\s+pitching\s+itself|person,\s+not\s+a\s+company|document\s+(?:filename|title|wrapper|outline)|file\s+name|title\s+artifact|scaffold|news\s+publication|newsletter|fund\s+product|vc\s+fund|government\s+(?:entity|agency)|venue\/location|metric,\s+not\s+a\s+company|recipient\s+names)\b/i.test(reasoning) &&
    !/\boff[-\s]?thesis\b/i.test(reasoning) &&
    !candidateTargetEvidence &&
    !productParentEvidence
  ) {
    return false;
  }
  if (hasCurrentCompanyInvestmentTargetEvidence(fullText, mention.canonicalName)) return true;
  if (candidateTargetEvidence) return true;
  if ((reasoningNamesTarget || sourceNamesTarget) && reasoningHasExplicitIntent) return true;
  if (sourceHasDirectTitleIntent) return true;
  if (knownProspectActiveContext) return true;
  if (sourceHasTargetMeetingWithFirm) return true;
  return false;
}

function hasFounderBriefFollowupCreateEvidence(text: string, company: string): boolean {
  const fullText = normalizeWhitespace(text || '');
  if (!fullText || !sourceMentionsName(fullText, company)) return false;
  if (!/\b(?:Medina|medinavc\.com|tony@medinavc\.com|lucas@medinavc\.com)\b/i.test(fullText)) return false;
  if (!/\b(?:founder|co[-\s]?founder|ceo|chief\s+executive)\b/i.test(fullText)) return false;
  if (!/\b(?:platform|product|solution|software|technology|company|building|supply\s+and\s+demand)\b/i.test(fullText)) return false;
  return /\b(?:i(?:'|’)?ll|i\s+will|we(?:'|’)?ll|we\s+will|can|happy\s+to)\b[^.\n]{0,100}\b(?:send|share|get|forward|provide)\b[^.\n]{0,100}\b(?:brief|deck|one[-\s]?pager|overview|materials?|memo|presentation)\b/i.test(fullText) ||
    /\b(?:send|share|get|forward|provide)\b[^.\n]{0,100}\b(?:brief|deck|one[-\s]?pager|overview|materials?|memo|presentation)\b[^.\n]{0,100}\b(?:for|to|with)\b[^.\n]{0,80}\b(?:Medina|Tony|Lucas|the\s+fund)\b/i.test(fullText);
}

function hasExplicitFinalCreateEvidence(
  item: ClassifiedItem,
  mention: MentionCandidate,
  llm: LlmClassifierDecision,
  classifierInput: ProspectClassifierInput,
  lowConfidenceVerification: LowConfidenceProspectVerification
): boolean {
  if (lowConfidenceVerification.verdict === 'verified_create') return true;
  const sourceText = normalizeWhitespace([
    deterministicGateContextForSource(item),
    item.subject,
    item.bodyPreview,
    item.bodyText,
    item.text,
    mention.lineText,
    classifierInput.rawExcerpt,
    classifierInput.senderAndContext,
    llm.reasoning,
  ].filter(Boolean).join(' '));
  const reasoningTarget = sourceMentionsName(String(llm.reasoning || ''), mention.canonicalName) &&
    /\b(?:investment\s+opportunit(?:y|ies)|inbound\s+(?:investment\s+)?opportunity|formal\s+pitch|(?:deal|investment)[-\s]?pitch|pitch(?:es|ed|ing)?|being\s+(?:directly\s+)?(?:presented|pitched|introduced|shared)|fundrais(?:e|ing)|raising|round|series\s+[abc]|seed|safe|data\s+room|diligence|financial\s+model|deck\s+attached|term\s+sheet|acquisition\s+opportunit(?:y|ies))\b/i.test(String(llm.reasoning || ''));
  const candidateTargetEvidence = hasCandidateProspectTargetEvidence(sourceText, llm.reasoning, mention);
  if (classifierReasoningHasHardNegativeRole(llm.reasoning) && !candidateTargetEvidence) return false;
  if (reasoningTarget) return true;
  if (candidateTargetEvidence) return true;
  if (hasCurrentCompanyInvestmentTargetEvidence(sourceText, mention.canonicalName)) return true;
  if (hasExplicitTargetInvestmentSignal(llm, classifierInput, mention)) return true;
  if (hasPrivatePitchDocumentTargetEvidence(sourceText, mention.canonicalName, llm.prospectCompanyName)) return true;
  if (hasDirectInvestorForwardedRoundEvidence(item, mention, classifierInput, llm.reasoning)) return true;
  if (hasMedinaOutboundProspectInterestEvidence(sourceText, mention.canonicalName)) return true;
  if (hasFounderBriefFollowupCreateEvidence(sourceText, mention.canonicalName)) return true;
  if (mention.isListEntry && hasStrongSourceInvestmentIntent(sourceText)) return true;
  if (
    lowConfidenceVerification.verdict === 'provisional_create' &&
    /\b(?:investment\s+opportunit(?:y|ies)|(?:deal|investment)[-\s]?pitch|pitch\s+submission|submitted\s+(?:a\s+)?pitch|fundrais(?:e|ing)|raising|series\s+[abc]|seed\s+round|safe|data\s+room|diligence|financial\s+model|term\s+sheet|direct\s+pitch|being\s+(?:presented|pitched|introduced)|acquisition\s+opportunit(?:y|ies))\b/i.test(sourceText)
  ) {
    return true;
  }
  return false;
}

function isSecondLookHardNonProspectReason(reasoning: string | null | undefined): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text) return false;
  return /\b(?:lead|participating|co[-\s]?lead)\s+investor\b[^.\n]{0,180}\bnot\b[^.\n]{0,120}\b(?:prospect|target|opportunity)\b/i.test(text) ||
    /\b(?:lender|financing\s+source|capital\s+provider)\b[^.\n]{0,180}\bnot\b[^.\n]{0,120}\b(?:prospect|target|opportunity)\b/i.test(text) ||
    /\b(?:event\s+host|organizer|program|channel|wrapper|filename|document\s+title|calendar|meeting\s+link|service\s+provider|vendor|customer|buyer)\b[^.\n]{0,180}\bnot\b[^.\n]{0,120}\b(?:prospect|target|opportunity)\b/i.test(text) ||
    /\bnot\s+(?:the|an?)\s+(?:new\s+)?(?:investment\s+)?(?:prospect|target|opportunity)\b/i.test(text) ||
    /\bnot\s+(?:the|an?)\s+(?:company|candidate|entity)\s+(?:being\s+)?(?:pitched|presented|introduced|shared|put\s+forward)\b/i.test(text) ||
    /\bnot\s+(?:being\s+)?(?:newly\s+)?(?:pitched|introduced|presented|shared)\b/i.test(text);
}

function splitReasoningFragments(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+|[;\n]+/g)
    .map(fragment => normalizeWhitespace(fragment))
    .filter(Boolean);
}

function fragmentMentionsCandidate(fragment: string, company: string): boolean {
  const normalized = normalizeProspectName(company);
  if (sourceMentionsName(fragment, company)) return true;
  if (!normalized || normalized.length < 3) return false;
  const normalizedFragment = normalizeProspectName(fragment);
  return new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i').test(normalizedFragment);
}

function candidateSpecificExistingContextOnly(fragment: string, company: string): boolean {
  const candidatePattern = currentCompanyPattern(company);
  if (!candidatePattern) return false;
  return new RegExp(
    `\\b${candidatePattern}\\b[^.\\n]{0,180}\\b(?:existing|known|current)\\s+(?:crm\\s+)?(?:company|relationship|portfolio|deal|investment)\\b[^.\\n]{0,220}\\b(?:not\\s+(?:being\\s+)?(?:newly\\s+)?(?:pitched|introduced|presented|shared)|context\\s+only|not\\s+(?:an?\\s+)?new\\s+(?:investment\\s+)?(?:prospect|opportunity))\\b`,
    'i'
  ).test(fragment);
}

function candidateSpecificHardNonTargetLanguage(reasoning: string | null | undefined, company: string): boolean {
  const text = normalizeWhitespace(reasoning || '');
  const candidatePattern = currentCompanyPattern(company);
  const normalized = normalizeProspectName(company);
  if (!text || !candidatePattern || !normalized) return false;

  for (const fragment of splitReasoningFragments(text)) {
    if (!fragmentMentionsCandidate(fragment, company)) continue;
    if (hasDifferentActualTarget(fragment, normalized)) return true;
    if (/\b(?:known|existing)\s+(?:open\s+)?deal\b/i.test(fragment)) return true;

    const candidateSubjectPrefix = `\\b${candidatePattern}\\b[^.\\n]{0,80}\\b(?:is|isn['’]?t|is\\s+not|was|wasn['’]?t|was\\s+not|appears\\s+to\\s+be|seems\\s+to\\s+be|serves\\s+as|acts\\s+as)\\b`;
    const candidateThenNegative = new RegExp(
      `\\b${candidatePattern}\\b[^.\\n]{0,180}\\b(?:not|isn['’]?t|is\\s+not|wasn['’]?t|was\\s+not|rather\\s+than|instead\\s+of)\\b[^.\\n]{0,140}\\b(?:investment\\s+)?(?:target|prospect|opportunity|company\\s+being\\s+(?:pitched|presented)|deal\\s+company|company\\s+name)\\b`,
      'i'
    );
    const candidateAsNonTargetRole = new RegExp(
      `${candidateSubjectPrefix}[^.\\n]{0,180}\\b(?:advisor|adviser|intermediary|messenger|facilitator|broker|backer|investor|fund|vc|family\\s+office|bank|investment\\s+bank|intro\\s+source|source|dealmaker|channel|partner|customer|buyer|design\\s+partner|participant|attendee|guest\\s+speaker|speaker|sponsor|organizer|event\\s+host|program|government\\s+agency|commercial\\s+partner|employer|prior\\s+employer|affiliation|service\\s+provider|vendor)\\b[^.\\n]{0,220}\\b(?:not|rather\\s+than|instead\\s+of)\\b[^.\\n]{0,140}\\b(?:investment\\s+)?(?:target|prospect|opportunity|company\\s+being\\s+(?:pitched|presented))\\b`,
      'i'
    );
    const candidateNotBeingPitched = new RegExp(
      `\\b${candidatePattern}\\b[^.\\n]{0,180}\\b(?:not|isn['’]?t|is\\s+not|wasn['’]?t|was\\s+not)\\s+(?:being\\s+)?(?:newly\\s+)?(?:pitched|presented|introduced|shared)\\b[^.\\n]{0,120}\\b(?:as\\s+)?(?:an?\\s+)?(?:investment\\s+)?(?:opportunity|prospect|target)?\\b`,
      'i'
    );
    const candidateGenericNonProspect = new RegExp(
      `${candidateSubjectPrefix}[^.\\n]{0,120}\\b(?:not\\s+(?:an?\\s+)?(?:new\\s+)?(?:investment\\s+)?(?:prospect|target|opportunity)|context\\s+entity|context\\s+only|relationship\\s+context)\\b`,
      'i'
    );

    if (
      candidateThenNegative.test(fragment) ||
      candidateAsNonTargetRole.test(fragment) ||
      candidateNotBeingPitched.test(fragment) ||
      candidateGenericNonProspect.test(fragment)
    ) {
      return true;
    }
  }
  return false;
}

function acceptedSecondLookHasStrongCandidateSupport(input: {
  secondLook: ProspectSecondLookPacket;
  mention: MentionCandidate;
  reasoningJudge: ProspectReasoningJudgeDecision | null;
}): boolean {
  const packet = input.secondLook.packet || {} as ProspectSecondLookPacket['packet'];
  const targetEvidence = packet.target_evidence_reasons || [];
  const sourceTitle = normalizeWhitespace(packet.source_title || '');
  const excerpt = normalizeWhitespace(packet.excerpt || '');
  const originalReasoning = normalizeWhitespace(packet.original_reasoning || '');
  const judgeReason = normalizeWhitespace(input.reasoningJudge?.reason || '');
  const sourceText = normalizeWhitespace([sourceTitle, excerpt].filter(Boolean).join(' '));
  const fullText = normalizeWhitespace([sourceText, originalReasoning, judgeReason].filter(Boolean).join(' '));
  const candidate = input.mention.canonicalName;

  if (acceptedSecondLookCandidateNameRiskReason(candidate)) return false;
  if (acceptedSecondLookHardSourceRiskReason(sourceTitle, excerpt, candidate)) return false;
  if (
    candidateSpecificExistingContextOnly(originalReasoning, candidate) ||
    candidateSpecificExistingContextOnly(judgeReason, candidate) ||
    candidateSpecificHardNonTargetLanguage(originalReasoning, candidate) ||
    candidateSpecificHardNonTargetLanguage(judgeReason, candidate)
  ) {
    return false;
  }

  const sourceNamesTarget = sourceMentionsName(sourceText, candidate);
  const reasoningNamesTarget = sourceMentionsName(originalReasoning, candidate);
  const judgeNamesTarget = sourceMentionsName(judgeReason, candidate);
  const hasCandidateRowDetails =
    sourceNamesTarget &&
    /\b(?:https?:\/\/|www\.|\.com\b|website|stage|seed|series\s+[abc]|pre[-\s]?seed|raise|raising|ask|valuation|safe|round|arr|mrr|revenue|traction|founder|ceo|contact|poc|problem|approach|product|platform|solution|technology|description)\b/i.test(sourceText);
  const hasNamedInvestmentTitle =
    sourceNamesTarget &&
    /\b(?:investment[-_\s]+(?:opportunity|request|summary|proposal|memo|deck)|co[-\s]?investment|pitch[-_\s]+deck|investor[-_\s]+(?:deck|presentation)|series\s+[abc]|seed\s+round|safe|data\s+room|term\s+sheet|teaser|acquisition\s+opportunit(?:y|ies))\b/i.test(sourceTitle);
  const hasDirectTargetLanguage =
    (sourceNamesTarget || reasoningNamesTarget || judgeNamesTarget) &&
    /\b(?:central\s+(?:issuer|subject|target)|investment\s+target|candidate\s+itself|direct\s+(?:pitch|intro|inbound)|warm\s+intro|shared\s+(?:with|to)\s+Medina|sent\s+(?:to\s+)?Medina|data\s+room|diligence|term\s+sheet|safe|valuation|allocation|fundrais(?:e|ing)|raising|round|series\s+[abc]|seed\s+round|investor\s+(?:deck|presentation|overview)|pitch\s+deck|company\s+deck)\b/i.test(fullText);
  const hasMeetingTargetLanguage =
    sourceNamesTarget &&
    /\b(?:meeting|call|zoom|demo|summary|recap|next\s+steps)\b/i.test(sourceText) &&
    /\b(?:pitch|diligence|investment\s+(?:discussion|opportunity|review)|fundrais(?:e|ing)|raising|round|series\s+[abc]|safe|data\s+room|deck|founder|ceo|product\s+demo|next\s+steps)\b/i.test(fullText);

  if (targetEvidence.includes('fundraising_list_row') && hasCandidateRowDetails) return true;
  if (targetEvidence.includes('pitch_or_investment_document_target') && (hasNamedInvestmentTitle || hasDirectTargetLanguage)) return true;
  if (targetEvidence.includes('candidate_pitch_material_target') && (hasNamedInvestmentTitle || hasDirectTargetLanguage)) return true;
  if (targetEvidence.includes('subject_line_target_opportunity') && (hasNamedInvestmentTitle || hasDirectTargetLanguage)) return true;
  if (hasStructuredPipelineRowEvidence(fullText, candidate)) return true;
  if (hasCandidateFundraisingListRowEvidence(sourceText, originalReasoning, input.mention)) return true;
  if (hasCandidateWarmIntroTargetEvidence(sourceText, originalReasoning, candidate)) return true;
  if (targetEvidence.includes('classifier_reasoning_affirms_target_investment') && hasDirectTargetLanguage) return true;
  if (input.secondLook.evidence.includes('final_create_evidence') && (hasCandidateRowDetails || hasNamedInvestmentTitle || hasDirectTargetLanguage || hasMeetingTargetLanguage)) return true;
  if (hasCandidateProspectTargetEvidence(sourceText, originalReasoning, input.mention)) return true;
  return input.reasoningJudge?.action === 'allow_create' &&
    input.reasoningJudge.reasoning_valid !== false &&
    judgeNamesTarget &&
    /\b(?:named\s+row|row\s+entry|central\s+(?:subject|issuer)|investment\s+target|candidate\s+itself)\b/i.test(judgeReason) &&
    /\b(?:stage|ask|raise|raising|fundrais(?:e|ing)|valuation|safe|round|website|contact|founder|ceo|traction|arr|mrr|revenue|company\s+details|deck|data\s+room|diligence|term\s+sheet)\b/i.test(judgeReason);
}

function acceptedSecondLookGenericJudgeAllowReason(reason: string | null | undefined): boolean {
  return /\b(?:Structured list-row evidence names the candidate|Private financing document names the candidate|Direct investor-forwarded round evidence|parent\/inventor company|explicit Medina-send language is not required)\b/i
    .test(normalizeWhitespace(reason || ''));
}

function acceptedSecondLookCandidateNameRiskReason(candidate: string | null | undefined): string | null {
  const name = normalizeWhitespace(candidate || '');
  if (!name) return 'accepted_second_look_bad_identity_empty_candidate';
  const normalized = normalizeProspectName(name);
  if (!normalized) return 'accepted_second_look_bad_identity_empty_candidate';
  const domainStyleStartupName = /^[a-z0-9][a-z0-9-]{1,62}\.(?:ai|com|io|co|tech|dev|health|bio|xyz|app|software|energy|finance|cloud|systems|network|net|org)$/i.test(name);
  if (/[.!?]/.test(name) || /\b(?:we|our|you|your|they|their)\b/i.test(name.split(/\s+/)[0] || '')) {
    if (domainStyleStartupName) return null;
    return 'accepted_second_look_bad_identity_text_fragment';
  }
  if (/\b(?:so\s+you\s+can|you\s+can\s+review|review\s+it\s+thoroughly)\b/i.test(name)) {
    return 'accepted_second_look_bad_identity_text_fragment';
  }
  if (/^(?:known\s+company\s+match|pipe\s+investor)$/i.test(name)) {
    return 'accepted_second_look_bad_identity_document_heading';
  }
  if (/^(?:re|fw|fwd|updated invitation|canceled|cancelled|meeting summary|automatic_report|source entity name|subject)\s*[:|-]/i.test(name)) {
    return 'accepted_second_look_bad_identity_document_wrapper';
  }
  if (/^(?:go[-\s]?to[-\s]?market|investment\s+opportunity|transaction\s+document\s+comment|document\s+comment|executive\s+summary|investor\s+presentation|pitch\s+deck|data\s+room|term\s+sheet)\b/i.test(name)) {
    return 'accepted_second_look_bad_identity_document_heading';
  }
  if (/^(?:vc|investor|lp|fund|contact|candidate|company|target|prospect|pipeline)\s+(?:list|directory|row|table|tracker|report)$/i.test(name)) {
    return 'accepted_second_look_bad_identity_list_wrapper';
  }
  if (/^medina\s+ventures$/i.test(name)) {
    return 'accepted_second_look_internal_firm_entity';
  }
  if (/^[A-Z]\s+AI$/i.test(name) || /^[A-Z]\s+[A-Z]{1,3}$/i.test(name)) {
    return 'accepted_second_look_bad_identity_short_extracted_fragment';
  }
  return null;
}

function acceptedSecondLookHardSourceRiskReason(
  sourceTitle: string | null | undefined,
  excerpt: string | null | undefined,
  candidate: string
): string | null {
  const title = normalizeWhitespace(sourceTitle || '');
  const context = normalizeWhitespace([title, excerpt || ''].filter(Boolean).join(' '));
  if (!context) return null;
  if (/\b(?:resume|curriculum\s+vitae|cv)\b/i.test(title)) {
    return 'accepted_second_look_resume_or_personal_background_context';
  }
  if (/\b(?:vc\s+list|investor\s+list|vc\s+reference\s+list|south\s+florida\s+vc\s+list|lp\s+list|contact\s+list|investor\s+contacts?|fundraising\s+targets?|2nd\s+close\s+output|second\s+close\s+output)\b/i.test(title)) {
    return 'accepted_second_look_investor_or_fund_directory_context';
  }
  if (/\b(?:security\s+alert|account\s+settings|activate\s+your\s+(?:free\s+)?plan|billing|invoice|receipt|order\s+(?:confirmation|comes)|cashback|unsubscribe|password|login|auth(?:entication)?|desktop\s+app\s+is\s+here|product\s+update)\b/i.test(title)) {
    return 'accepted_second_look_admin_or_marketing_artifact';
  }
  if (
    /\b(?:bests|beats|announces?|announced|reported|news|newsletter|digest|valuation\s+race|headline|article)\b/i.test(title) &&
    !/\b(?:co[-\s]?investment\s+opportunity|investment\s+opportunity|data\s+room|deck|teaser|safe|term\s+sheet|allocation|diligence)\b/i.test(title)
  ) {
    return 'accepted_second_look_public_news_or_digest_context';
  }
  if (/\b(?:please\s+sign|signature\s+request|docusign|document\s+routing)\b/i.test(title) && /\b(?:amendment|admin|operational|signature)\b/i.test(context)) {
    return 'accepted_second_look_admin_or_document_routing_context';
  }
  if (/\b(?:canceled|cancelled)\s*:/i.test(title) || /\b(?:calendar\s+(?:invite|shell|notice|confirmation)|updated invitation)\b/i.test(title)) {
    return 'accepted_second_look_calendar_shell_context';
  }
  if (
    /\b(?:briefing|cohort|program|event|webinar|town\s+hall|conference|showcase|demo\s+day|ecosystem|government)\b/i.test(title) &&
    /\b(?:government|devcom|army|university|college|center|programme|program|cohort|briefing|event|webinar|town\s+hall|conference|foundation|academy)\b/i.test(candidate)
  ) {
    return 'accepted_second_look_program_or_event_wrapper_context';
  }
  return null;
}

function acceptedSecondLookNonTargetRoleRiskReason(
  text: string,
  candidate: string
): string | null {
  const candidatePattern = currentCompanyPattern(candidate);
  if (!candidatePattern) return null;
  const normalizedText = normalizeWhitespace(text || '');
  if (!normalizedText) return null;
  const nameLooksLikeCapitalProvider = /\b(?:capital|ventures?|partners?|fund|vc|advisors?|advisory|bank|law|legal|securities|wealth|family\s+office)\b/i.test(candidate);
  for (const fragment of splitReasoningFragments(normalizedText)) {
    if (!fragmentMentionsCandidate(fragment, candidate)) continue;
    if (
      /\b(?:known\s+)?(?:dealmaker|intro\s+source|source|advisor|adviser|intermediary|broker|investor|vc\s+firm|fund|capital\s+provider|lender|bank|law\s+firm|legal\s+advisor|customer|buyer|vendor|service\s+provider|partner|acquirer|revenue\s+partner|commission\s+source|meeting\s+participant|participant|attendee|employer|school|academy|nonprofit|charity|government\s+entity|event\s+host|program\s+host)\b/i.test(fragment) &&
      /\b(?:not|rather\s+than|instead\s+of|context|mentioned\s+only|appears\s+only|listed\s+only|nearby|beside|not\s+being\s+(?:pitched|presented|shared|introduced)|not\s+(?:an?\s+)?(?:investment\s+)?(?:target|prospect|opportunity))\b/i.test(fragment)
    ) {
      return 'accepted_second_look_non_target_role_context';
    }
    if (
      nameLooksLikeCapitalProvider &&
      /\b(?:investor|vc\s+firm|fund|capital\s+provider|intro\s+source|dealmaker|advisor|source|feeder\s+fund|fund\s+terms|investor\s+contact|contact\s+domain)\b/i.test(fragment) &&
      !/\b(?:portfolio\s+company|company\s+being\s+(?:pitched|financed)|investment\s+target|central\s+(?:issuer|subject)|raising|fundrais(?:e|ing)|series\s+[abc]|seed\s+round|safe|valuation)\b/i.test(fragment)
    ) {
      return 'accepted_second_look_non_target_role_context';
    }
  }
  if (
    nameLooksLikeCapitalProvider &&
    /\b(?:investor\s+(?:list|directory|contacts?)|vc\s+list|known\s+(?:source|dealmaker|advisor|investor)|intro\s+source|feeder\s+fund|fund\s+terms)\b/i.test(normalizedText) &&
    !/\b(?:portfolio\s+company|company\s+being\s+(?:pitched|financed)|investment\s+target|central\s+(?:issuer|subject)|raising|fundrais(?:e|ing)|series\s+[abc]|seed\s+round|safe|valuation)\b/i.test(normalizedText)
  ) {
    return 'accepted_second_look_non_target_role_context';
  }
  return null;
}

function secondLookEvidenceReasons(reasons: string[]): string[] {
  const strong = new Set([
    'fundraising_list_row',
    'pitch_or_investment_document_target',
    'candidate_pitch_material_target',
    'subject_line_target_opportunity',
    'classifier_reasoning_affirms_target_investment',
    'standout_inbound_intro',
  ]);
  return reasons.filter(reason => strong.has(reason));
}

function reasoningDirectlySupportsRejectedProspect(reasoning: string | null | undefined, company: string): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text || !sourceMentionsName(text, company)) return false;
  if (isSecondLookHardNonProspectReason(text)) return false;
  return /\b(?:directly\s+to\s+Medina|to\s+Medina|sent\s+Medina|shared\s+with\s+Medina|put\s+in\s+front\s+of\s+Medina)\b/i.test(text) &&
    /\b(?:investor\s+(?:update|report|communication)|fundrais(?:e|ing)|raising|round|seed|series\s+[abc]|safe|valuation|traction|ARR|MRR|diligence|deck|pitch|investment\s+opportunity)\b/i.test(text);
}

function reasoningDirectlySupportsRejectedOpportunity(reasoning: string | null | undefined, company: string): boolean {
  const text = normalizeWhitespace(reasoning || '');
  if (!text || !sourceMentionsName(text, company)) return false;
  if (isSecondLookHardNonProspectReason(text)) return false;
  const opportunityLanguage = /\b(?:acquisition\s+opportunit(?:y|ies)|investment\s+opportunit(?:y|ies)|financing\s+(?:opportunit(?:y|ies)|package|request|review)|full\s+package|deal\s+package|diligence\s+package|data\s+room|letter\s+of\s+(?:interest|intent)|LOI|fundrais(?:e|ing)|raising|round|seed|series\s+[abc]|safe|valuation|allocation|term\s+sheet)\b/i.test(text);
  const routingLanguage = /\b(?:shared|sent|forwarded|introduced|presented|pitched|routed|review|reviewed|opportunity|package|dealflow|to\s+Medina|with\s+Medina)\b/i.test(text);
  return opportunityLanguage && routingLanguage;
}

function buildProspectSecondLookPacket(input: {
  item: ClassifiedItem;
  mention: MentionCandidate;
  classifierInput: ProspectClassifierInput;
  existing: ExistingContext;
  llm: LlmClassifierDecision;
  prospectAction: ProspectAction;
  shouldCreateProspect: boolean;
  finalProspectCompanyName: string | null;
  effectiveConfidence: number;
  confidenceTier: ConfidenceTier;
  provisional: boolean;
  directionUncertain: boolean;
  hasCreateEvidence: boolean;
  targetEvidenceReasons: string[];
  createProspectVetoReason: string | null;
  valuableActionVetoReason: string | null;
  finalizationBlocked: boolean;
  finalizationBlockReasons: string[];
  reasoningJudge: ProspectReasoningJudgeDecision | null;
  contextTargetRepairApplied: boolean;
  lowConfidenceVerification: LowConfidenceProspectVerification;
  crossD1RoleCheck: CrossD1CompanyRoleCheck;
}): ProspectSecondLookPacket {
  const reasons: string[] = [];
  const evidence: string[] = [];
  const warnings: string[] = [];
  const targetEvidence = Array.from(new Set(input.targetEvidenceReasons));
  const strongRejectedEvidence = secondLookEvidenceReasons(targetEvidence);
  const reasoning = normalizeWhitespace(input.llm.reasoning || '');
  const judgeAction = input.reasoningJudge?.action || 'not_evaluated';
  const judgeReason = input.reasoningJudge?.reason || null;
  const finalVetoReason = input.createProspectVetoReason || input.valuableActionVetoReason;
  const sourceType = input.classifierInput.sourceType as SourceType;

  for (const reason of strongRejectedEvidence) appendUnique(evidence, reason);
  if (input.hasCreateEvidence) appendUnique(evidence, 'final_create_evidence');
  if (input.lowConfidenceVerification.verdict === 'verified_create') appendUnique(evidence, 'low_confidence_verified_create');
  if (input.crossD1RoleCheck.role === 'known_deal') appendUnique(evidence, 'known_deal_identity_context');

  if (input.shouldCreateProspect) {
    const acceptedNameRisk = acceptedSecondLookCandidateNameRiskReason(input.mention.canonicalName);
    if (acceptedNameRisk) {
      appendUnique(reasons, acceptedNameRisk);
      appendUnique(warnings, 'bad_candidate_identity');
    }
    const acceptedSourceRisk = acceptedSecondLookHardSourceRiskReason(
      input.item.subject || null,
      input.classifierInput.rawExcerpt,
      input.mention.canonicalName
    );
    if (acceptedSourceRisk) {
      appendUnique(reasons, acceptedSourceRisk);
      appendUnique(warnings, 'risky_source_context');
    }
    const acceptedRoleRisk = acceptedSecondLookNonTargetRoleRiskReason(
      [input.llm.reasoning, judgeReason, input.classifierInput.rawExcerpt, input.item.subject].filter(Boolean).join('. '),
      input.mention.canonicalName
    );
    if (acceptedRoleRisk) {
      appendUnique(reasons, acceptedRoleRisk);
      appendUnique(warnings, 'non_target_role_context');
    }
    if (!input.llm.isProspect) {
      appendUnique(reasons, 'original_model_said_not_prospect');
      appendUnique(warnings, 'model_pipeline_disagreement');
    }
    if (input.llm.prospectAction !== 'create_prospect') {
      appendUnique(reasons, 'promoted_from_non_create_action');
      appendUnique(warnings, `original_action_${input.llm.prospectAction}`);
    }
    if (input.contextTargetRepairApplied) {
      appendUnique(reasons, 'context_target_repair_promoted_create');
      appendUnique(warnings, 'promotion_after_context_repair');
    }
    if (input.provisional && !input.hasCreateEvidence && !targetEvidence.includes('fundraising_list_row')) {
      appendUnique(reasons, 'accepted_create_is_provisional');
      appendUnique(warnings, 'pending_confidence_or_identity');
    }
    if (input.directionUncertain) {
      appendUnique(reasons, 'accepted_create_direction_uncertain');
      appendUnique(warnings, 'direction_disagreement');
    }
    if (input.effectiveConfidence < 0.82 && !input.hasCreateEvidence && !targetEvidence.includes('fundraising_list_row')) {
      appendUnique(reasons, 'accepted_create_low_confidence_non_list');
      appendUnique(warnings, 'low_confidence_create');
    }
    if (input.existing.identityAmbiguous) {
      appendUnique(reasons, 'known_identity_ambiguous');
      appendUnique(warnings, 'identity_ambiguous');
    }
    if (
      judgeAction === 'allow_create' &&
      acceptedSecondLookGenericJudgeAllowReason(judgeReason)
    ) {
      appendUnique(reasons, 'allowed_after_reasoning_judge_exception');
      appendUnique(warnings, 'judge_exception_allowed_create');
    }
    if (
      /\b(?:not\s+(?:a\s+)?(?:new\s+)?(?:prospect|investment\s+prospect|investment\s+opportunity)|existing\s+(?:portfolio|deal|relationship)|known\s+(?:portfolio|deal)|not\s+newly\s+pitched)\b/i.test(reasoning)
    ) {
      appendUnique(reasons, 'accepted_reasoning_contains_non_prospect_language');
      appendUnique(warnings, 'reasoning_contradiction');
    }
    if (input.reasoningJudge && (!input.reasoningJudge.reasoning_valid || input.reasoningJudge.action !== 'allow_create')) {
      appendUnique(reasons, 'reasoning_judge_not_clean_allow');
      appendUnique(warnings, `judge_${input.reasoningJudge.action}`);
    }

    if (reasons.length > 0) {
      return {
        required: true,
        lane: 'accepted_but_suspicious',
        recommended_action: 'keep_create_pending_recheck',
        reasons,
        evidence,
        warnings,
        packet: {
          candidate_name: input.mention.canonicalName,
          prospect_company_name: input.finalProspectCompanyName,
          source_title: input.item.subject || null,
          source_type: sourceType,
          excerpt: compactClassifierText(input.classifierInput.rawExcerpt, 900),
          original_reasoning: input.llm.reasoning,
          original_is_prospect: input.llm.isProspect,
          original_action: input.llm.prospectAction,
          final_action: input.prospectAction,
          final_should_create: input.shouldCreateProspect,
          final_veto_reason: finalVetoReason,
          reasoning_judge_action: judgeAction,
          reasoning_judge_reason: judgeReason,
          target_evidence_reasons: targetEvidence,
          known_entity: {
            company_id: input.existing.companyId,
            deal_id: input.existing.dealId,
            match_strength: input.existing.matchStrength,
            identity_score: input.existing.identityScore || 0,
            identity_strength: input.existing.identityStrength || 'none',
            identity_ambiguous: input.existing.identityAmbiguous === true,
          },
        },
      };
    }
  } else {
    const explicitRejectedEvidence = strongRejectedEvidence.length > 0 ||
      reasoningDirectlySupportsRejectedProspect(input.llm.reasoning, input.mention.canonicalName) ||
      reasoningDirectlySupportsRejectedOpportunity(input.llm.reasoning, input.mention.canonicalName);
    const blocker = finalVetoReason || input.prospectAction;
    const hardReject =
      judgeAction === 'block_create' ||
      isSecondLookHardNonProspectReason(input.llm.reasoning) ||
      [
        'section_heading_or_document_outline',
        'html_schema_or_markup_artifact',
        'admin_link_or_calendar_scaffolding',
        'tool_vendor_or_link_host',
        'venue_or_physical_location',
        'government_program_or_list_wrapper_not_target_company',
        'government_customer_or_buyer_entity',
        'service_provider_or_intermediary',
        'person_or_participant_bundle',
        'event_or_program_channel_without_investment_target',
        'news_or_digest_only',
        'lp_or_fund_context_not_prospect',
      ].includes(blocker || '');
    if (input.llm.isProspect) appendUnique(evidence, 'original_model_said_prospect');
    if (reasoningDirectlySupportsRejectedProspect(input.llm.reasoning, input.mention.canonicalName)) {
      appendUnique(evidence, 'reasoning_directly_supports_rejected_prospect');
    }
    if (reasoningDirectlySupportsRejectedOpportunity(input.llm.reasoning, input.mention.canonicalName)) {
      appendUnique(evidence, 'reasoning_directly_supports_rejected_opportunity');
    }
    if (input.finalizationBlocked) appendUnique(evidence, 'blocked_by_finalization_gate');
    for (const reason of input.finalizationBlockReasons) appendUnique(warnings, `finalization_${reason}`);
    if (finalVetoReason) appendUnique(warnings, finalVetoReason);

    if ((input.llm.isProspect || explicitRejectedEvidence) && explicitRejectedEvidence && !hardReject) {
      appendUnique(reasons, 'discarded_row_has_company_specific_prospect_signal');
      if (input.llm.isProspect) appendUnique(reasons, 'original_model_wanted_create_or_true');
      if (finalVetoReason) appendUnique(reasons, `blocked_by_${finalVetoReason}`);
      return {
        required: true,
        lane: 'rejected_but_promising',
        recommended_action: 'rerun_original_pipeline',
        reasons,
        evidence,
        warnings,
        packet: {
          candidate_name: input.mention.canonicalName,
          prospect_company_name: input.finalProspectCompanyName,
          source_title: input.item.subject || null,
          source_type: sourceType,
          excerpt: compactClassifierText(input.classifierInput.rawExcerpt, 900),
          original_reasoning: input.llm.reasoning,
          original_is_prospect: input.llm.isProspect,
          original_action: input.llm.prospectAction,
          final_action: input.prospectAction,
          final_should_create: input.shouldCreateProspect,
          final_veto_reason: finalVetoReason,
          reasoning_judge_action: judgeAction,
          reasoning_judge_reason: judgeReason,
          target_evidence_reasons: targetEvidence,
          known_entity: {
            company_id: input.existing.companyId,
            deal_id: input.existing.dealId,
            match_strength: input.existing.matchStrength,
            identity_score: input.existing.identityScore || 0,
            identity_strength: input.existing.identityStrength || 'none',
            identity_ambiguous: input.existing.identityAmbiguous === true,
          },
        },
      };
    }

    if ((input.llm.isProspect || explicitRejectedEvidence) && hardReject) {
      appendUnique(reasons, 'promising_signal_blocked_by_hard_non_prospect_evidence');
      return {
        required: false,
        lane: null,
        recommended_action: 'hold_context',
        reasons,
        evidence,
        warnings,
        packet: {
          candidate_name: input.mention.canonicalName,
          prospect_company_name: input.finalProspectCompanyName,
          source_title: input.item.subject || null,
          source_type: sourceType,
          excerpt: compactClassifierText(input.classifierInput.rawExcerpt, 900),
          original_reasoning: input.llm.reasoning,
          original_is_prospect: input.llm.isProspect,
          original_action: input.llm.prospectAction,
          final_action: input.prospectAction,
          final_should_create: input.shouldCreateProspect,
          final_veto_reason: finalVetoReason,
          reasoning_judge_action: judgeAction,
          reasoning_judge_reason: judgeReason,
          target_evidence_reasons: targetEvidence,
          known_entity: {
            company_id: input.existing.companyId,
            deal_id: input.existing.dealId,
            match_strength: input.existing.matchStrength,
            identity_score: input.existing.identityScore || 0,
            identity_strength: input.existing.identityStrength || 'none',
            identity_ambiguous: input.existing.identityAmbiguous === true,
          },
        },
      };
    }
  }

  return {
    required: false,
    lane: null,
    recommended_action: 'none',
    reasons,
    evidence,
    warnings,
    packet: {
      candidate_name: input.mention.canonicalName,
      prospect_company_name: input.finalProspectCompanyName,
      source_title: input.item.subject || null,
      source_type: sourceType,
      excerpt: compactClassifierText(input.classifierInput.rawExcerpt, 500),
      original_reasoning: input.llm.reasoning,
      original_is_prospect: input.llm.isProspect,
      original_action: input.llm.prospectAction,
      final_action: input.prospectAction,
      final_should_create: input.shouldCreateProspect,
      final_veto_reason: finalVetoReason,
      reasoning_judge_action: judgeAction,
      reasoning_judge_reason: judgeReason,
      target_evidence_reasons: targetEvidence,
      known_entity: {
        company_id: input.existing.companyId,
        deal_id: input.existing.dealId,
        match_strength: input.existing.matchStrength,
        identity_score: input.existing.identityScore || 0,
        identity_strength: input.existing.identityStrength || 'none',
        identity_ambiguous: input.existing.identityAmbiguous === true,
      },
    },
  };
}

function acceptedSecondLookCreateBlockReason(input: {
  secondLook: ProspectSecondLookPacket;
  mention: MentionCandidate;
  llm: LlmClassifierDecision;
  reasoningJudge: ProspectReasoningJudgeDecision | null;
}): string | null {
  if (input.secondLook.required !== true || input.secondLook.lane !== 'accepted_but_suspicious') return null;
  const llmReasoning = normalizeWhitespace(input.llm.reasoning || '');
  const judgeReason = normalizeWhitespace(input.reasoningJudge?.reason || '');
  const sourceTitle = normalizeWhitespace(input.secondLook.packet?.source_title || '');
  const excerpt = normalizeWhitespace(input.secondLook.packet?.excerpt || '');
  const reasons = normalizeWhitespace(input.secondLook.reasons.join(' '));
  const warnings = normalizeWhitespace(input.secondLook.warnings.join(' '));
  const text = normalizeWhitespace([sourceTitle, excerpt, llmReasoning, judgeReason, reasons, warnings].filter(Boolean).join('. '));
  if (!text) return null;
  const hasStrongCandidateSupport = acceptedSecondLookHasStrongCandidateSupport({
    secondLook: input.secondLook,
    mention: input.mention,
    reasoningJudge: input.reasoningJudge,
  });
  const candidateNameRisk = acceptedSecondLookCandidateNameRiskReason(input.mention.canonicalName);
  if (candidateNameRisk && !hasStrongCandidateSupport) return candidateNameRisk;

  const hardSourceRisk = acceptedSecondLookHardSourceRiskReason(sourceTitle, excerpt, input.mention.canonicalName);
  if (hardSourceRisk && !hasStrongCandidateSupport) return hardSourceRisk;

  if (
    candidateSpecificExistingContextOnly(llmReasoning, input.mention.canonicalName) ||
    candidateSpecificExistingContextOnly(judgeReason, input.mention.canonicalName)
  ) {
    return 'accepted_second_look_existing_context_only';
  }
  if (
    candidateSpecificHardNonTargetLanguage(llmReasoning, input.mention.canonicalName) ||
    candidateSpecificHardNonTargetLanguage(judgeReason, input.mention.canonicalName)
  ) {
    return 'accepted_second_look_non_target_reasoning';
  }
  const nonTargetRoleRisk = acceptedSecondLookNonTargetRoleRiskReason(text, input.mention.canonicalName);
  if (nonTargetRoleRisk && !hasStrongCandidateSupport) return nonTargetRoleRisk;
  if (
    !hasStrongCandidateSupport &&
    /\b(?:participant|attendee|advisor|adviser|investor|lead\s+investor|co[-\s]?investor|lender|financing\s+source|capital\s+provider|venue|location|event\s+host|organizer|service\s+provider|vendor)\b[^.\n]{0,180}\b(?:not|rather\s+than|instead\s+of)\b[^.\n]{0,140}\b(?:target|prospect|opportunity|company\s+being\s+pitched)\b/i.test(text) &&
    fragmentMentionsCandidate(text, input.mention.canonicalName)
  ) {
    return 'accepted_second_look_non_target_role';
  }
  if (!hasStrongCandidateSupport && isSecondLookHardNonProspectReason(text) && candidateSpecificHardNonTargetLanguage(text, input.mention.canonicalName)) {
    return 'accepted_second_look_hard_non_prospect_reasoning';
  }
  if (!hasStrongCandidateSupport && acceptedSecondLookGenericJudgeAllowReason(judgeReason)) {
    return 'accepted_second_look_generic_judge_without_target_proof';
  }
  if (
    !hasStrongCandidateSupport &&
    /\b(?:original_model_said_not_prospect|promoted_from_non_create_action|context_target_repair_promoted_create|allowed_after_reasoning_judge_exception|model_pipeline_disagreement|original_action_(?:ignore|record_context)|promotion_after_context_repair|judge_exception_allowed_create|accepted_create_direction_uncertain|known_identity_ambiguous)\b/i.test(`${reasons} ${warnings}`)
  ) {
    return 'accepted_second_look_insufficient_candidate_proof';
  }
  return null;
}

export async function callProspectClassifier(
  input: ProspectClassifierInput,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites'> = {}
): Promise<LlmClassifierDecision> {
  if (input.prefilterHints.should_classify === false) {
    throw new Error('PREFILTER_REJECTED_CLASSIFIER_CALL');
  }
  const model = prospectClassifierModel(env, input);
  const prompt = buildProspectClassifierPrompt(input);
  const result = await callClaudeWithUsage(
    {
      system: prompt.systemForApi,
      user: prompt.user,
      max_tokens: 700,
      orgId: input.orgId,
      model,
      assistantPrefill: '{',
      temperature: 0,
      dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
    },
    'low',
    env
  );
  return parseProspectClassifierResponse(result.text, result.model, result.usage);
}

interface SourceMentionClassifierRuntime {
  mention: MentionCandidate;
  existing: ExistingContext;
  prefilter: ClassifierPrefilter;
  classifierInput: ProspectClassifierInput;
}

interface SourceLevelClassifierResult {
  decisions: Map<number, LlmClassifierDecision>;
  cacheHit: boolean;
  paidCall: boolean;
  partialReason: string | null;
  model: string | null;
  usage?: ClaudeUsage | null;
}

function buildProspectSourceClassifierPrompt(
  item: ClassifiedItem,
  inputs: ProspectClassifierInput[]
): { systemForApi: ClaudeSystemPrompt; user: string } {
  const base = buildProspectClassifierPrompt(inputs[0]);
  const multiCandidateInstruction = `SOURCE-LEVEL MODE:
Review every candidate company from this one source item. Apply the same prospect-verdict,
direction, sector, CRM-hint, and false-positive rules above to each candidate independently.
Return strict JSON only in this exact shape:
{"decisions":[{"mention_ordinal":1,"is_prospect":true,"prospect_company_name":"Candidate Company","direction":"inbound|outbound|internal|news","sector_key":"one allowed sector key","sector_confidence":0.0,"confidence":0.0,"reasoning":"20 words or fewer"}]}
Allowed sector_key values: ${PROSPECT_SECTOR_LABELS}.
The response must include exactly one concise decision for every candidate mention_ordinal. Do not invent new companies; target recovery emits new candidates separately.

Stable source-level review protocol:
Treat each candidate as a separate row in the same source. Use the shared source facts to understand role and intent, but never let one candidate's decision bleed into another candidate's decision. The candidate name is the object being judged. The sender, attachment owner, meeting organizer, calendar host, program name, customer, investor, advisor, service provider, university, government entity, or event channel is not the opportunity unless that exact candidate is clearly the investment target.

First ask: is this candidate the company being put in front of the fund as a potential investment? Strong evidence includes a direct pitch submission, explicit fundraise or round language, SAFE or valuation terms, a data room, diligence request, financial model, NDA, term sheet, investor deck, demo, founder intro, investment memo, acquisition opportunity, or a clear statement that the company is being shared as an investment opportunity. If the candidate has that role, answer is_prospect=true even when it is off thesis, early, late, mature, unusual, or only lightly described. If the evidence is explicit but thin, keep the verdict true and let confidence reflect uncertainty.

Existing entity rule: if this candidate is only an existing company, open deal, portfolio company, CRM card, prospect record, active-pipeline relationship, watchlist, or matched domain being discussed as existing context, answer is_prospect=false. If the same candidate is being newly pitched, reviewed, or shared to Medina as an investment opportunity, answer is_prospect=true.

If this candidate is useful context rather than the target, answer is_prospect=false. This includes intro sources, investment banks, advisors, VCs, LPs, accelerators, ecosystem programs, government channels, customers, design partners, vendors, service providers, co-investors, event organizers, relationship meetings, or commercial counterparties.

If this candidate is noise, answer is_prospect=false. This includes login codes, billing, auth, admin, vendor operations, public news with no action, analytics, newsletters without a direct opportunity, copied scaffolding, file extensions, section headings, agenda labels, CSS/HTML/schema fragments, personal names, participant bundles, and generic phrases.

When a source contains a list, table, cohort, packet, pipeline report, roadshow, showcase, memo, or deck index, review each actual company row independently. A source may legitimately produce many true prospect decisions. Do not collapse the whole list into the packet title, event name, program name, sender, or first row. If a candidate row includes a website, founder, problem, approach, round, amount, stage, description, traction, or ask, judge that candidate directly.

For fundraising lists and government/program dealflow packets, keep two ideas separate: the packet owner or program can be false, while the company rows can be true. If your short reasoning would say "this company is listed with a Seed/Series round, dollar ask, contact, problem, or approach," the verdict for that company row should usually be is_prospect=true.

When a source is a meeting transcript or summary, answer true only for the company whose product, demo, pitch, fundraising, diligence, next steps, or founder discussion is central. Meeting participants, hosts, attendees, calendar invitees, and transcript tooling are not prospects just because they were present. If the transcript only shows scheduling, relationship maintenance, partnership exploration, customer discussion, or general ecosystem conversation with no investment opportunity, answer false.

When a source is an email with attachments, the attachment name can strengthen evidence but is not enough by itself. A deck, two-pager, pre-read, memo, or PDF title supports a true verdict only when the candidate is also being pitched, introduced, raising, reviewed, or shared as an opportunity. Do not treat a document wrapper, file type, folder label, or section heading as a prospect.

For warm intros, judge the target company, not the introducer. If a trusted source, advisor, investor, or program forwards a named company to Medina with a founder, deck, raise, meeting, demo, diligence item, or explicit opportunity language, the target company may be true and the source remains false.

For investment summaries, teasers, investor decks, roadshow packets, and diligence materials, the central company in the material may be true even if the file or email wrapper is messy. The wrapper title, folder, sender, or document scaffolding remains false.

When evidence conflicts, preserve database integrity. A clear target company should not be lost because an advisor, investor, customer, or channel appears nearby. A context entity should not become a prospect because a real opportunity appears elsewhere in the same source. If the source mentions Company A as the channel and Company B as the target, Company A is false and Company B may be true.

Use confidence for the prospect/direction verdict, not for whether the company sounds exciting. High confidence means the verdict is clear. Lower confidence means the role is ambiguous or evidence is thin. Keep reasoning short and concrete: say why this candidate is or is not the prospect.

Consistency reminders for repeated backfill runs:
The same evidence should receive the same verdict even if it appears in a forwarded email, a calendar invite, a transcript summary, a PDF preview, or a pipeline report. A later duplicate source can strengthen evidence, but it should not change the verdict for a candidate unless the later source contains clearer facts. Candidate spelling variants, legal suffixes, domains, and capitalization are dedupe clues, not separate investment judgments. Do not penalize a valid target because the source is operationally messy, duplicated, forwarded, or partially summarized. Do not reward a context entity because the surrounding source has strong investment language for someone else.

For ambiguous single-signal cases, separate two questions. If the question is "is this definitely enough evidence to rely on?", express uncertainty with confidence. If the question is "is this candidate the investment target?", choose the prospect verdict from the evidence. A thin but explicit pitch, raise, data-room, diligence, or investment-opportunity signal can still be is_prospect=true. A warm relationship, meeting logistics, partner request, customer conversation, event attendance, channel briefing, or ecosystem update is is_prospect=false unless the candidate itself is presented as the investment target.

When in doubt, protect the main prospect table from source/channel/noise entities. True is preferable for a real company explicitly being reviewed as dealflow. False is preferable for relationship infrastructure, source entities, operational artifacts, or companies that are only adjacent to the actual opportunity.`;
  let systemForApi: ClaudeSystemPrompt;
  if (Array.isArray(base.systemForApi)) {
    const [staticBlock, ...dynamicBlocks] = base.systemForApi;
    systemForApi = [
      staticBlock,
      { type: 'text', text: multiCandidateInstruction, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ...dynamicBlocks,
    ];
  } else {
    systemForApi = [
      { type: 'text', text: base.systemForApi, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: multiCandidateInstruction, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
  }
  const candidates = inputs.map(input => ({
    mention_ordinal: (input.prefilterHints as any)?.mention?.mention_ordinal,
    company_name: input.companyName,
    sender_and_context: input.senderAndContext,
    excerpt: input.rawExcerpt,
    prefilter_hints: input.prefilterHints,
    sector_hints: input.sectorHints,
  }));
  const user = JSON.stringify({
    source_type: inputs[0].sourceType,
    source_id: item.entityId,
    source_title: item.subject || null,
    from_email: item.fromEmail || null,
    from_name: item.fromName || null,
    candidates,
  });
  return { systemForApi, user };
}

export async function prewarmProspectSourceClassifierPromptCache(
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites'> = {}
): Promise<{ usage: ClaudeUsage; model: string; stop_reason?: string }> {
  const warmupInput: ProspectClassifierInput = {
    sourceType: 'conversation',
    senderAndContext: 'Prompt cache warmup for Medina Ventures prospect source classification.',
    companyName: 'Warmup Company',
    rawExcerpt: 'Warmup Company is raising a seed round and sent a pitch deck.',
    prefilterHints: {
      mention: {
        mention_ordinal: 1,
        parse_dealflow_list: false,
      },
      source_type: 'conversation',
      warmup: true,
    },
    sectorHints: { key: 'ai_data', confidence: 0.8 },
    knownContext: emptyProspectClassifierKnownContext(),
    orgId,
  };
  const warmupItem = {
    type: 'email',
    entityType: 'conversation',
    entityId: 'prospect-source-classifier-cache-warmup',
    subject: 'Prospect classifier prompt cache warmup',
    fromEmail: 'warmup@medinavc.com',
    bodyText: 'Warmup Company is raising a seed round and sent a pitch deck.',
    bodyPreview: 'Warmup Company seed round.',
    sentAt: new Date(0).toISOString(),
  } as ClassifiedItem;
  const prompt = buildProspectSourceClassifierPrompt(warmupItem, [warmupInput]);
  return prewarmClaudePromptCache({
    system: prompt.systemForApi,
    user: 'warmup',
    orgId,
    model: prospectClassifierModel(env, warmupInput),
    dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
  }, 'low', env);
}

function parseProspectSourceClassifierResponse(
  raw: string,
  model: string,
  usage?: ClaudeUsage
): Map<number, LlmClassifierDecision> {
  const parsed = parseJsonObject(raw, 'INVALID_PROSPECT_SOURCE_CLASSIFIER_JSON');
  const rows = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const out = new Map<number, LlmClassifierDecision>();
  if (rows.length === 0 && (parsed.prospect_action || parsed.mention_type || parsed.signal_disposition)) {
    out.set(1, parseProspectClassifierDecisionObject({ ...parsed, mention_ordinal: 1 }, model, usage));
    return out;
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('INVALID_PROSPECT_SOURCE_CLASSIFIER_DECISIONS');
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('INVALID_PROSPECT_SOURCE_CLASSIFIER_ROW');
    const entry = row as Record<string, unknown>;
    const ordinal = Number(entry.mention_ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error('INVALID_PROSPECT_SOURCE_CLASSIFIER_ORDINAL');
    if (out.has(ordinal)) throw new Error(`INVALID_PROSPECT_SOURCE_CLASSIFIER_DUPLICATE:${ordinal}`);
    try {
      out.set(ordinal, parseProspectClassifierDecisionObject(entry, model, usage));
    } catch {
      // Treat a malformed row with a known ordinal as missing; the source-batch
      // repair path will retry only that candidate instead of dropping the source.
    }
  }
  return out;
}

function isProspectSourceClassifierParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /\bINVALID_PROSPECT_SOURCE_CLASSIFIER_(?:JSON|DECISIONS|ROW|ORDINAL|DUPLICATE)\b/i.test(message);
}

async function sourceClassifierCacheKey(input: {
  orgId: string;
  item: ClassifiedItem;
  model: string;
  runtime: SourceMentionClassifierRuntime[];
  knownContext: ProspectClassifierKnownContext;
}): Promise<{
  cacheKey: string;
  sourceHash: string;
  candidateHash: string;
  contextHash: string;
}> {
  const sourceHash = await sha256Hex(sourceTextForClassifierCache(input.item));
  const candidateHash = await sha256Hex(stableJson(input.runtime.map(row => ({
    mention_ordinal: row.mention.mentionOrdinal,
    canonical_name: row.mention.canonicalName,
    normalized_name: row.mention.normalizedName,
    raw: row.mention.raw,
    excerpt: row.classifierInput.rawExcerpt,
    sender_and_context: row.classifierInput.senderAndContext,
    prefilter_hints: row.classifierInput.prefilterHints,
    sector_hints: row.classifierInput.sectorHints,
  }))));
  const contextHash = await sha256Hex(stableJson({
    known_deals: input.knownContext.knownDeals,
    known_dealmakers: input.knownContext.knownDealmakers,
    crm_context: input.runtime.map(row => ({
      mention_ordinal: row.mention.mentionOrdinal,
      company_id: row.existing.companyId,
      deal_id: row.existing.dealId,
      company_domain: row.existing.companyDomain,
      relationship_states: row.existing.relationshipStates,
      is_internal: row.existing.isInternal,
      match_strength: row.existing.matchStrength,
    })),
  }));
  const cacheKey = await sha256Hex(stableJson({
    version: PROSPECT_SOURCE_CLASSIFIER_CACHE_VERSION,
    org_id: input.orgId,
    model: input.model,
    source_type: prospectSourceType(input.item),
    source_hash: sourceHash,
    candidate_hash: candidateHash,
    context_hash: contextHash,
  }));
  return { cacheKey, sourceHash, candidateHash, contextHash };
}

async function getSourceClassifierCache(
  cacheKey: string,
  env: Env,
  options: ProspectClassifierRuntimeOptions
): Promise<ProspectClassifierCacheValue | null> {
  if (options.classifierCache) {
    const cached = await options.classifierCache.get(cacheKey);
    if (cached) return cached;
  }
  if (!options.disableD1ClassifierCache && !options.dryRunNoBudgetWrites) {
    return readD1ProspectClassifierCache(env, cacheKey);
  }
  return null;
}

async function putSourceClassifierCache(
  value: ProspectClassifierCacheValue,
  env: Env,
  options: ProspectClassifierRuntimeOptions
): Promise<void> {
  if (options.classifierCache) await options.classifierCache.put(value);
  if (!options.disableD1ClassifierCache && !options.dryRunNoBudgetWrites) {
    await writeD1ProspectClassifierCache(env, value);
  }
}

async function callProspectSourceClassifier(
  item: ClassifiedItem,
  orgId: string,
  knownContext: ProspectClassifierKnownContext,
  runtime: SourceMentionClassifierRuntime[],
  env: Env,
  options: ProspectClassifierRuntimeOptions = {}
): Promise<SourceLevelClassifierResult> {
  if (runtime.length === 0) return { decisions: new Map(), cacheHit: false, paidCall: false, partialReason: null, model: null, usage: null };
  const inputs = runtime.map(row => row.classifierInput);
  const model = prospectClassifierModel(env, inputs.find(input => Boolean((input.prefilterHints as any)?.mention?.parse_dealflow_list)) || inputs[0]);
  const hashes = await sourceClassifierCacheKey({ orgId, item, model, runtime, knownContext });
  const cached = await getSourceClassifierCache(hashes.cacheKey, env, options);
  if (cached) {
    const decisions = new Map<number, LlmClassifierDecision>();
    for (const [ordinal, decision] of Object.entries(cached.result_json || {})) {
      decisions.set(Number(ordinal), decision);
    }
    return { decisions, cacheHit: true, paidCall: false, partialReason: null, model: cached.model, usage: cached.usage || null };
  }

  const prompt = buildProspectSourceClassifierPrompt(item, inputs);
  const result = await callClaudeWithUsage(
    {
      system: prompt.systemForApi,
      user: prompt.user,
      orgId,
      model,
      assistantPrefill: '{',
      temperature: 0,
      max_tokens: Math.min(4000, 700 + runtime.length * 260),
      dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
    },
    'low',
    env
  );
  const decisions = parseProspectSourceClassifierResponse(result.text, result.model, result.usage);
  const missing = runtime.filter(row => !decisions.has(row.mention.mentionOrdinal));
  const partialReason = missing.length > 0
    ? `missing_source_batch_decisions:${missing.map(row => row.mention.mentionOrdinal).join(',')}`
    : null;
  const resultJson: Record<string, LlmClassifierDecision> = {};
  for (const [ordinal, decision] of decisions.entries()) resultJson[String(ordinal)] = decision;
  if (!partialReason && !options.disableSourceClassifierCacheWrite) {
    await putSourceClassifierCache({
      cache_key: hashes.cacheKey,
      org_id: orgId,
      version: PROSPECT_SOURCE_CLASSIFIER_CACHE_VERSION,
      model: result.model,
      source_type: prospectSourceType(item) || 'conversation',
      source_id: item.entityId,
      source_hash: hashes.sourceHash,
      candidate_hash: hashes.candidateHash,
      context_hash: hashes.contextHash,
      result_json: resultJson,
      usage: result.usage,
      created_at: new Date().toISOString(),
    }, env, options);
  }
  return { decisions, cacheHit: false, paidCall: true, partialReason, model: result.model, usage: result.usage };
}

async function putCompleteSourceClassifierDecisionCache(
  item: ClassifiedItem,
  orgId: string,
  knownContext: ProspectClassifierKnownContext,
  runtime: SourceMentionClassifierRuntime[],
  decisions: Map<number, LlmClassifierDecision>,
  model: string,
  usage: ClaudeUsage | null | undefined,
  env: Env,
  options: ProspectClassifierRuntimeOptions
): Promise<void> {
  if (runtime.length === 0) return;
  if (runtime.some(row => !decisions.has(row.mention.mentionOrdinal))) return;
  const hashes = await sourceClassifierCacheKey({ orgId, item, model, runtime, knownContext });
  const resultJson: Record<string, LlmClassifierDecision> = {};
  for (const [ordinal, decision] of decisions.entries()) resultJson[String(ordinal)] = decision;
  await putSourceClassifierCache({
    cache_key: hashes.cacheKey,
    org_id: orgId,
    version: PROSPECT_SOURCE_CLASSIFIER_CACHE_VERSION,
    model,
    source_type: prospectSourceType(item) || 'conversation',
    source_id: item.entityId,
    source_hash: hashes.sourceHash,
    candidate_hash: hashes.candidateHash,
    context_hash: hashes.contextHash,
    result_json: resultJson,
    usage: usage || null,
    created_at: new Date().toISOString(),
  }, env, options);
}

function missingSourceBatchDecisionClassification(
  item: ClassifiedItem,
  row: SourceMentionClassifierRuntime,
  reason: string,
  cacheHit: boolean,
  paidCall: boolean
): Classification {
  const direction = row.prefilter.deterministicDirection === 'unknown'
    ? 'inbound'
    : row.prefilter.deterministicDirection;
  const auditReason = `Source-level classifier omitted this candidate after the missing-only retry (${reason}). Saved as audit context; no prospect was materialized.`;
  return {
    direction,
    directionUncertain: row.prefilter.deterministicDirection === 'unknown',
    mentionType: 'noise',
    prospectAction: 'record_context',
    shouldCreateProspect: false,
    prospectCompanyName: null,
    confidence: 0.12,
    confidenceTier: 'low',
    sectorKey: row.classifierInput.sectorHints.key,
    sectorConfidence: Math.min(row.classifierInput.sectorHints.confidence, 0.2),
    signalKind: row.prefilter.signalKind,
    hasDeck: row.prefilter.hasDeck,
    hasMeeting: row.prefilter.hasMeeting,
    hasWarmIntro: row.prefilter.hasWarmIntro,
    dealmakerName: row.prefilter.hasWarmIntro ? normalizeWhitespace(item.fromName || item.fromEmail || '') : null,
    possibleCompanyId: row.existing.companyId,
    possibleDealId: row.existing.dealId || null,
    linkedDealId: null,
    provisional: true,
    sampledForProduction: false,
    samplingReason: null,
    metadata: {
      classifier: 'source_batch_missing_decision',
      classifier_model: null,
      llm_is_prospect: null,
      llm_reasoning: auditReason,
      llm_confidence: null,
      original_llm_prospect_action: null,
      original_llm_is_prospect: null,
      prospect_action: 'record_context',
      should_create_prospect: false,
      context_signal: true,
      source_classifier: {
        mode: 'source_batch',
        missing_decision: true,
        missing_reason: reason,
        batch_cache_hit: cacheHit,
        batch_paid_call: paidCall,
        batch_partial_reason: reason,
        fallback_reason: null,
      },
      reasoning_judge: { action: 'not_evaluated' },
      target_evidence_reasons: [],
      list_fields: row.mention.listFields || null,
      known_entity_audit: {
        company_id: row.existing.companyId,
        deal_id: row.existing.dealId,
        match_strength: row.existing.matchStrength,
        identity_score: row.existing.identityScore || 0,
        identity_strength: row.existing.identityStrength || 'none',
        identity_ambiguous: row.existing.identityAmbiguous === true,
        identity_method: row.existing.identityMethod || null,
        identity_candidates: row.existing.identityCandidates || [],
      },
    },
  };
}

function acronymForCompanyName(name: string): string {
  return normalizeWhitespace(name)
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map(part => part.replace(/[^A-Za-z0-9]/g, ''))
    .filter(part => part && !/^(?:inc|llc|ltd|corp|corporation|company|co|the|and|of)$/i.test(part))
    .map(part => part[0]?.toLowerCase() || '')
    .join('');
}

function isShortAliasDuplicateOfCreate(
  row: SourceClassificationBatchRow,
  other: SourceClassificationBatchRow
): boolean {
  if (!row.cls?.shouldCreateProspect || !other.cls?.shouldCreateProspect) return false;
  if (row === other) return false;
  const alias = normalizeProspectName(row.mention.canonicalName);
  if (!alias || alias.length < 2 || alias.length > 5) return false;
  const fullNames = [
    other.mention.canonicalName,
    other.cls.prospectCompanyName,
    other.cls.metadata.corrected_prospect_company_name,
  ].map(value => normalizeWhitespace(String(value || ''))).filter(Boolean);
  if (fullNames.some(name => acronymForCompanyName(name) === alias)) return true;
  if (
    row.cls.possibleCompanyId &&
    other.cls.possibleCompanyId &&
    row.cls.possibleCompanyId === other.cls.possibleCompanyId &&
    fullNames.some(name => normalizeProspectName(name).length >= alias.length + 4)
  ) {
    return true;
  }
  return false;
}

function blockAliasDuplicateCreate(
  cls: Classification,
  duplicateOf: SourceClassificationBatchRow
): Classification {
  const reason = 'source_alias_duplicate_of_full_company_create';
  return {
    ...cls,
    mentionType: 'noise',
    prospectAction: 'record_context',
    shouldCreateProspect: false,
    prospectCompanyName: null,
    linkedDealId: null,
    provisional: false,
    metadata: {
      ...cls.metadata,
      create_prospect_veto_applied: true,
      create_prospect_veto_reason: reason,
      valuable_action_veto_applied: true,
      valuable_action_veto_reason: reason,
      prospect_action: 'record_context',
      should_create_prospect: false,
      context_signal: true,
      source_alias_duplicate: {
        reason,
        duplicate_of_company_name: duplicateOf.mention.canonicalName,
        duplicate_of_prospect_company_name: duplicateOf.cls?.prospectCompanyName || null,
        duplicate_of_possible_company_id: duplicateOf.cls?.possibleCompanyId || null,
      },
    },
  };
}

function suppressSourceAliasDuplicateCreates(
  rows: SourceClassificationBatchRow[]
): SourceClassificationBatchRow[] {
  return rows.map(row => {
    if (!row.cls?.shouldCreateProspect) return row;
    const duplicateOf = rows.find(other => isShortAliasDuplicateOfCreate(row, other));
    if (!duplicateOf) return row;
    return {
      ...row,
      cls: blockAliasDuplicateCreate(row.cls, duplicateOf),
    };
  });
}

async function classifySourceMentionBatch(
  item: ClassifiedItem,
  mentions: MentionCandidate[],
  orgId: string,
  knownContext: ProspectClassifierKnownContext,
  env: Env,
  options: ProspectClassifierRuntimeOptions = {}
): Promise<SourceClassificationBatchRow[]> {
  const runtime: SourceMentionClassifierRuntime[] = [];
  for (const mention of mentions) {
    const existing = await lookupExistingContext(mention, item, orgId, env, {
      allowPartialSchema: options.allowPartialSchema === true,
    });
    const prefilter = buildClassifierPrefilter(item, mention, existing, env);
    const classifierInput = classifierInputForRuntime(item, mention, existing, prefilter, knownContext, orgId);
    runtime.push({ mention, existing, prefilter, classifierInput });
  }
  let sourceResult: SourceLevelClassifierResult;
  let sourceParseRepairAttempted = false;
  try {
    sourceResult = await callProspectSourceClassifier(item, orgId, knownContext, runtime, env, options);
    recordLlmStageUsage(options.stats, 'source_classifier', {
      usage: sourceResult.usage,
      cacheHit: sourceResult.cacheHit,
      paidCall: sourceResult.paidCall,
    });
  } catch (error) {
    if (!isProspectSourceClassifierParseError(error)) throw error;
    sourceParseRepairAttempted = true;
    const repairedDecisions = new Map<number, LlmClassifierDecision>();
    let repairCacheHit = false;
    let repairPaidCall = false;
    let repairModel: string | null = null;
    let repairUsage: ClaudeUsage | null = null;
    const failedOrdinals: number[] = [];
    for (let index = 0; index < runtime.length; index += PROSPECT_SOURCE_CLASSIFIER_PARSE_RETRY_CHUNK_SIZE) {
      const chunk = runtime.slice(index, index + PROSPECT_SOURCE_CLASSIFIER_PARSE_RETRY_CHUNK_SIZE);
      try {
        const retryResult = await callProspectSourceClassifier(item, orgId, knownContext, chunk, env, {
          ...options,
          disableSourceClassifierCacheWrite: true,
        });
        recordLlmStageUsage(options.stats, 'source_classifier_repair', {
          usage: retryResult.usage,
          cacheHit: retryResult.cacheHit,
          paidCall: retryResult.paidCall,
        });
        repairCacheHit = repairCacheHit || retryResult.cacheHit;
        repairPaidCall = repairPaidCall || retryResult.paidCall;
        repairModel = repairModel || retryResult.model;
        repairUsage = repairUsage || retryResult.usage || null;
        for (const [ordinal, decision] of retryResult.decisions.entries()) {
          repairedDecisions.set(ordinal, decision);
        }
        for (const row of chunk) {
          if (!retryResult.decisions.has(row.mention.mentionOrdinal)) {
            failedOrdinals.push(row.mention.mentionOrdinal);
          }
        }
      } catch (retryError) {
        if (!isProspectSourceClassifierParseError(retryError)) throw retryError;
        failedOrdinals.push(...chunk.map(row => row.mention.mentionOrdinal));
      }
    }
    sourceResult = {
      decisions: repairedDecisions,
      cacheHit: repairCacheHit,
      paidCall: repairPaidCall,
      partialReason: failedOrdinals.length > 0
        ? `source_batch_parse_repair_missing:${Array.from(new Set(failedOrdinals)).sort((a, b) => a - b).join(',')}`
        : null,
      model: repairModel,
      usage: repairUsage,
    };
  }
  let combinedDecisions = sourceResult.decisions;
  let batchCacheHit = sourceResult.cacheHit;
  let batchPaidCall = sourceResult.paidCall;
  let batchPartialReason = sourceResult.partialReason;
  if (sourceResult.partialReason && !sourceParseRepairAttempted) {
    const missingRuntime = runtime.filter(row => !combinedDecisions.has(row.mention.mentionOrdinal));
    const retryResult = await callProspectSourceClassifier(item, orgId, knownContext, missingRuntime, env, {
      ...options,
      disableSourceClassifierCacheWrite: true,
    });
    recordLlmStageUsage(options.stats, 'source_classifier_repair', {
      usage: retryResult.usage,
      cacheHit: retryResult.cacheHit,
      paidCall: retryResult.paidCall,
    });
    batchCacheHit = batchCacheHit || retryResult.cacheHit;
    batchPaidCall = batchPaidCall || retryResult.paidCall;
    for (const [ordinal, decision] of retryResult.decisions.entries()) {
      combinedDecisions.set(ordinal, decision);
    }
    const stillMissing = runtime.filter(row => !combinedDecisions.has(row.mention.mentionOrdinal));
    batchPartialReason = stillMissing.length > 0
      ? `source_batch_repair_missing:${stillMissing.map(row => row.mention.mentionOrdinal).join(',')}`
      : null;
    if (!batchPartialReason && sourceResult.model) {
      await putCompleteSourceClassifierDecisionCache(
        item,
        orgId,
        knownContext,
        runtime,
        combinedDecisions,
        sourceResult.model,
        sourceResult.usage || retryResult.usage || null,
        env,
        options
      );
    }
  }
  const outcomes: SourceClassificationBatchRow[] = [];
  for (const row of runtime) {
    const llmDecision = combinedDecisions.get(row.mention.mentionOrdinal);
    if (!llmDecision) {
      const reason = batchPartialReason || `source_batch_missing:${row.mention.mentionOrdinal}`;
      outcomes.push({
        mention: row.mention,
        existing: row.existing,
        cls: missingSourceBatchDecisionClassification(item, row, reason, batchCacheHit, batchPaidCall),
        cacheHit: batchCacheHit,
        paidCall: batchPaidCall,
      });
      continue;
    }
    const fallbackReason = !llmDecision
      ? batchPartialReason || `missing_source_batch_decision:${row.mention.mentionOrdinal}`
      : null;
    const cls = await classifyMention(item, row.mention, row.existing, knownContext, orgId, env, {
      ...options,
      llmDecision,
      classifierInput: row.classifierInput,
      sourceClassifierMode: llmDecision ? 'source_batch' : 'single_fallback',
      sourceClassifierFallbackReason: fallbackReason,
      sourceClassifierBatchCacheHit: batchCacheHit,
      sourceClassifierBatchPaidCall: batchPaidCall,
      sourceClassifierBatchPartialReason: batchPartialReason,
    });
    outcomes.push({
      mention: row.mention,
      cls,
      existing: row.existing,
      cacheHit: batchCacheHit,
      paidCall: batchPaidCall,
    });
  }
  return suppressSourceAliasDuplicateCreates(outcomes);
}

function knownEntityAuditContext(input: {
  existing: ExistingContext;
  llm: LlmClassifierDecision;
  prospectAction: ProspectAction;
  mentionType: MentionType;
  shouldCreateProspect: boolean;
  possibleCompanyId: string | null;
  possibleDealId: string | null;
  linkedDealId: string | null;
  hasCreateEvidence: boolean;
  finalizationBlocked: boolean;
  finalizationBlockReasons: string[];
  createProspectVetoReason: string | null;
  valuableActionVetoReason: string | null;
}): Record<string, unknown> {
  const knownEntityPresent = Boolean(
    input.existing.companyId ||
    input.existing.dealId ||
    input.existing.isInternal ||
    input.existing.relationshipStates.length > 0 ||
    input.existing.matchStrength !== 'none' ||
    (input.existing.identityScore || 0) >= 75 ||
    (input.existing.identityCandidates || []).length > 0
  );
  let outcome = 'no_known_entity_match';
  if (knownEntityPresent && input.existing.isInternal) {
    outcome = 'known_internal_entity';
  } else if (knownEntityPresent && input.finalizationBlockReasons.includes('name_only_known_deal_match')) {
    outcome = 'known_deal_name_only_blocked';
  } else if (knownEntityPresent && input.shouldCreateProspect) {
    outcome = 'known_entity_new_pitch_allowed';
  } else if (knownEntityPresent && input.llm.isProspect) {
    outcome = 'known_entity_model_true_not_materialized';
  } else if (knownEntityPresent) {
    outcome = 'known_entity_non_prospect_audit_only';
  }

  return {
    saved: true,
    known_entity_present: knownEntityPresent,
    outcome,
    match_strength: input.existing.matchStrength,
    company_id: input.existing.companyId,
    deal_id: input.existing.dealId,
    company_domain: input.existing.companyDomain,
    relationship_states: input.existing.relationshipStates,
    is_internal: input.existing.isInternal,
    identity_score: input.existing.identityScore ?? 0,
    identity_strength: input.existing.identityStrength || 'none',
    identity_method: input.existing.identityMethod || null,
    identity_ambiguous: input.existing.identityAmbiguous === true,
    identity_candidates: (input.existing.identityCandidates || []).slice(0, 5),
    llm_is_prospect: input.llm.isProspect,
    llm_confidence: input.llm.confidence,
    final_should_create_prospect: input.shouldCreateProspect,
    final_prospect_action: input.prospectAction,
    final_mention_type: input.mentionType,
    possible_company_id: input.possibleCompanyId,
    possible_deal_id: input.possibleDealId,
    linked_deal_id: input.linkedDealId,
    has_create_evidence: input.hasCreateEvidence,
    finalization_blocked: input.finalizationBlocked,
    finalization_block_reasons: input.finalizationBlockReasons,
    create_prospect_veto_reason: input.createProspectVetoReason,
    valuable_action_veto_reason: input.valuableActionVetoReason,
  };
}

function candidateRowEvidenceForReasoningJudge(input: {
  mention: MentionCandidate;
  classifierInput: ProspectClassifierInput;
}): Record<string, unknown> | null {
  const fields = input.mention.listFields || {};
  const mentionHints = (input.classifierInput.prefilterHints as any)?.mention || {};
  const isListLike = input.mention.isListEntry === true ||
    mentionHints.parse_dealflow_list === true ||
    Boolean(fields.website || fields.poc || fields.stage || fields.amount || fields.problem || fields.approach);
  if (!isListLike) return null;
  return {
    is_list_entry: input.mention.isListEntry === true,
    parse_dealflow_list: mentionHints.parse_dealflow_list === true,
    row_text: compactClassifierText(input.mention.lineText || input.mention.contextText || input.classifierInput.rawExcerpt, 900),
    candidate_name_present_in_row: sourceMentionsName(input.mention.lineText || '', input.mention.canonicalName),
    website: fields.website || null,
    contact: fields.poc || null,
    stage: fields.stage || null,
    amount: fields.amount || null,
    problem: fields.problem || null,
    approach: fields.approach || null,
  };
}

function sourceEvidenceContextForReasoningJudge(input: {
  item: ClassifiedItem;
  mention: MentionCandidate;
  classifierInput: ProspectClassifierInput;
}): Record<string, unknown> {
  const sourceText = normalizeWhitespace([
    input.item.subject,
    (input.item as any).fileName,
    (input.item as any).file_name,
    input.classifierInput.rawExcerpt,
  ].filter(Boolean).join(' '));
  return {
    source_is_pipeline_evidence: true,
    source_visibility: (input.item as any).visibility || null,
    central_candidate_named: sourceMentionsName(sourceText, input.mention.canonicalName),
    has_direct_investor_forwarded_round_language: hasDirectInvestorForwardedRoundEvidence(input.item, input.mention, input.classifierInput),
    has_private_investment_or_financing_document_language:
      /\b(?:investment\s+(?:teaser|memo|summary|opportunity|request|proposal)|financing|loan|lender|borrower|issuer|acquisition|letter\s+of\s+intent|LOI|term\s+sheet|valuation|capitalization|cap\s+table|financial\s+model|data\s+room|diligence|investor\s+(?:deck|presentation|overview)|pitch\s+deck|company\s+deck|one[-\s]?pager|two[-\s]?pager|CIM)\b/i.test(sourceText),
    has_public_or_admin_wrapper_language:
      /\b(?:newsletter|digest|press\s+release|public\s+news|security\s+quarantine|phishing|sender\s+warning|billing|invoice|auth|login|calendar\s+invite|scheduling\s+only)\b/i.test(sourceText),
  };
}

function buildProspectReasoningJudgePrompt(input: {
  item: ClassifiedItem;
  mention: MentionCandidate;
  classifierInput: ProspectClassifierInput;
  existing: ExistingContext;
  llm: LlmClassifierDecision;
  hasCreateEvidence: boolean;
  confidenceTier: ConfidenceTier;
  finalProspectCompanyName: string | null;
  promotedToCreate: boolean;
  targetEvidenceReasons: string[];
}): { system: ClaudeSystemPrompt; user: string } {
  const staticSystem = `You are a lightweight validation judge for a VC prospect pipeline.
Your only job is to answer whether the classifier's create-prospect reasoning is valid for this exact candidate.

Allow create only when the reasoning is supported by target-specific source evidence that the candidate itself is being put in front of Medina Ventures as a possible investment.
Block create when the reasoning makes the sender, investor, advisor, customer, event, program, document wrapper, participant, existing-context entity, security/admin artifact, or public-news mention look like the prospect.
Use needs_review when evidence is too thin, contradictory, or the known-entity identity is ambiguous.

Important: sometimes the earlier classifier verdict is false/context, but the pipeline promotes the candidate because the classifier's own reasoning and the source evidence identify the candidate as the investment target. Do not block merely because original_verdict.is_prospect is false. Validate the promotion by checking whether the evidence categories and excerpt support the candidate itself.
For list, cohort, table, roadshow, and fundraising packet sources, judge the candidate row independently. Do not reject a real company row merely because the excerpt also contains neighboring rows, a program name, or a list wrapper.
For private investment, financing, acquisition, lender, diligence, or deck documents inside this pipeline's Medina evidence, do not require the document text itself to say "sent to Medina." If the candidate is the central issuer, borrower, seller, acquisition target, or company being financed/reviewed, the reasoning can be valid unless the source is public news, admin/security noise, or clearly about a different target.
For direct emails from another investor or source to Medina, an announced investment can still be valid prospect evidence when it names the candidate and includes concrete round terms such as SAFE, valuation, amount, co-lead, or post-money terms. Block newsletters, public digests, and generic press roundups; do not block a direct investor-forwarded round only because the sender is an investor.
If the candidate is only a clipped alias, acronym, domain fragment, sender, advisor, buyer, customer, or wrapper and the real target is a different company, block or send to review. If the candidate is the full real company and a duplicate alias appears nearby, do not reject it only because of the nearby duplicate.

Return strict JSON only:
{"reasoning_valid":true,"action":"allow_create|block_create|needs_review","confidence":0.0,"reason":"short concrete reason"}`;
  const user = JSON.stringify({
    candidate_name: input.mention.canonicalName,
    prospect_company_name: input.finalProspectCompanyName,
    source_type: input.classifierInput.sourceType,
    source_id: input.item.entityId,
    source_title: input.item.subject || null,
    excerpt: compactClassifierText(input.classifierInput.rawExcerpt, 1400),
    original_verdict: {
      is_prospect: input.llm.isProspect,
      confidence: input.llm.confidence,
      reasoning: input.llm.reasoning,
      direction: input.llm.direction,
    },
    pipeline_decision: {
      intended_action: 'create_prospect',
      promoted_from_action: input.llm.prospectAction,
      promoted_to_create: input.promotedToCreate,
      target_evidence_reasons: input.targetEvidenceReasons,
    },
    evidence_flags: {
      has_create_evidence: input.hasCreateEvidence,
      confidence_tier: input.confidenceTier,
      has_deck: input.classifierInput.prefilterHints?.has_deck === true,
      has_meeting_or_call: input.classifierInput.prefilterHints?.has_meeting_or_call === true,
      has_warm_intro_language: input.classifierInput.prefilterHints?.has_warm_intro_language === true,
      signal_kind_hint: input.classifierInput.prefilterHints?.signal_kind_hint || null,
    },
    candidate_row_evidence: candidateRowEvidenceForReasoningJudge(input),
    source_evidence_context: sourceEvidenceContextForReasoningJudge(input),
    known_entity: {
      company_id: input.existing.companyId,
      deal_id: input.existing.dealId,
      match_strength: input.existing.matchStrength,
      identity_score: input.existing.identityScore || 0,
      identity_strength: input.existing.identityStrength || 'none',
      identity_ambiguous: input.existing.identityAmbiguous === true,
      identity_method: input.existing.identityMethod || null,
    },
  });
  return {
    system: [{ type: 'text', text: staticSystem, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    user,
  };
}

function parseProspectReasoningJudgeObject(raw: string): Record<string, unknown> {
  try {
    return parseJsonObject(raw, 'INVALID_REASONING_JUDGE_JSON');
  } catch (error) {
    const text = stripJsonCodeFence(raw).trim();
    const jsonish = text.startsWith('{') ? text : text.includes('{') ? text.slice(text.indexOf('{')) : `{${text}`;
    const reasoningValid = jsonish.match(/"reasoning_valid"\s*:\s*(true|false)/i)?.[1];
    const action = jsonish.match(/"action"\s*:\s*"([^"]+)"/i)?.[1];
    const confidence = jsonish.match(/"confidence"\s*:\s*([0-9.]+)/i)?.[1];
    const reason = jsonish.match(/"reason"\s*:\s*"([^"]*)/i)?.[1];
    if (!reasoningValid || !action || !confidence || !reason) throw error;
    return {
      reasoning_valid: reasoningValid.toLowerCase() === 'true',
      action,
      confidence: Number(confidence),
      reason: reason.replace(/\\"/g, '"'),
    };
  }
}

function parseProspectReasoningJudgeResponse(
  raw: string,
  model: string,
  usage?: ClaudeUsage | null
): ProspectReasoningJudgeDecision {
  const parsed = parseProspectReasoningJudgeObject(raw);
  const action = String(parsed.action || '').trim().toLowerCase();
  if (!['allow_create', 'block_create', 'needs_review'].includes(action)) {
    throw new Error(`INVALID_REASONING_JUDGE_ACTION:${action || 'empty'}`);
  }
  if (typeof parsed.reasoning_valid !== 'boolean') throw new Error('INVALID_REASONING_JUDGE_VALID');
  const reason = normalizeWhitespace(String(parsed.reason || '')).slice(0, 300);
  if (!reason) throw new Error('INVALID_REASONING_JUDGE_REASON');
  return {
    reasoning_valid: parsed.reasoning_valid,
    action: action as ProspectReasoningJudgeAction,
    confidence: parseUnitConfidence(parsed.confidence, 'reasoning_judge_confidence'),
    reason,
    model,
    usage,
  };
}

async function callProspectReasoningJudge(
  input: {
    item: ClassifiedItem;
    mention: MentionCandidate;
    classifierInput: ProspectClassifierInput;
    existing: ExistingContext;
    llm: LlmClassifierDecision;
    hasCreateEvidence: boolean;
    confidenceTier: ConfidenceTier;
    finalProspectCompanyName: string | null;
    promotedToCreate: boolean;
    targetEvidenceReasons: string[];
  },
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites' | 'stats'> = {}
): Promise<ProspectReasoningJudgeDecision> {
  const model = prospectReasoningJudgeModel(env);
  const prompt = buildProspectReasoningJudgePrompt(input);
  const hashes = await prospectLlmCacheKey({
    orgId: input.classifierInput.orgId,
    stage: 'reasoning_judge',
    promptVersion: PROSPECT_REASONING_JUDGE_CACHE_VERSION,
    model,
    source: {
      source_type: input.classifierInput.sourceType,
      source_id: input.item.entityId,
      excerpt: input.classifierInput.rawExcerpt,
    },
    candidate: {
      mention_ordinal: input.mention.mentionOrdinal,
      candidate_name: input.mention.canonicalName,
      normalized_name: input.mention.normalizedName,
    },
    context: {
      existing_company_id: input.existing.companyId,
      existing_deal_id: input.existing.dealId,
      identity_score: input.existing.identityScore || 0,
      identity_strength: input.existing.identityStrength || 'none',
      identity_ambiguous: input.existing.identityAmbiguous === true,
      has_create_evidence: input.hasCreateEvidence,
      promoted_to_create: input.promotedToCreate,
      target_evidence_reasons: input.targetEvidenceReasons,
    },
    decision: {
      is_prospect: input.llm.isProspect,
      prospect_action: input.llm.prospectAction,
      confidence: input.llm.confidence,
      reasoning: input.llm.reasoning,
      prospect_company_name: input.finalProspectCompanyName,
    },
  });
  if (!options.dryRunNoBudgetWrites) {
    const cached = await readD1ProspectLlmCache<ProspectReasoningJudgeDecision>(env, hashes.cacheKey);
    if (cached) {
      recordLlmStageUsage(options.stats, 'reasoning_judge', { cacheHit: true });
      return { ...cached.value_json, cache_hit: true };
    }
  }
  try {
    const result = await callClaudeWithUsage(
      {
        system: prompt.system,
        user: prompt.user,
        max_tokens: 160,
        orgId: input.classifierInput.orgId,
        model,
        assistantPrefill: '{',
        temperature: 0,
        dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
      },
      'low',
      env
    );
    recordLlmStageUsage(options.stats, 'reasoning_judge', { usage: result.usage, paidCall: true });
    const parsed = parseProspectReasoningJudgeResponse(result.text, result.model, result.usage);
    if (!options.dryRunNoBudgetWrites) {
      await writeD1ProspectLlmCache(env, {
        cache_key: hashes.cacheKey,
        org_id: input.classifierInput.orgId,
        stage: 'reasoning_judge',
        prompt_version: PROSPECT_REASONING_JUDGE_CACHE_VERSION,
        model: result.model,
        source_hash: hashes.sourceHash,
        candidate_hash: hashes.candidateHash,
        context_hash: hashes.contextHash,
        decision_hash: hashes.decisionHash,
        value_json: parsed,
        usage: result.usage,
        created_at: new Date().toISOString(),
      });
    }
    return parsed;
  } catch (error) {
    return {
      reasoning_valid: false,
      action: 'needs_review',
      confidence: 0,
      reason: `reasoning_judge_error:${compactProspectBackfillError(error)}`,
      model,
      usage: null,
      cache_hit: false,
    };
  }
}

function finalQualityRecordKey(row: RecordableProspectOutcome): string {
  return `${row.sourceType}:${row.item.entityId}:${row.mention.mentionOrdinal}`;
}

function parseSignalMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function fetchFinalQualityKnownCompany(
  orgId: string,
  companyId: string | null,
  env: Env
): Promise<ProspectFinalQualityKnownEntity | null> {
  if (!companyId) return null;
  const row = await env.D1.prepare(
    `SELECT id, name, domain, website, company_type, description, investment_status,
            stage, sector, last_news_summary, custom_fields
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(companyId, orgId).first<{
    id: string;
    name?: string | null;
    domain?: string | null;
    website?: string | null;
    company_type?: string | null;
    description?: string | null;
    investment_status?: string | null;
    stage?: string | null;
    sector?: string | null;
    last_news_summary?: string | null;
    custom_fields?: string | null;
  }>().catch(() => null);
  return row
    ? {
        id: row.id,
        name: row.name || null,
        domain: row.domain || null,
        website: row.website || null,
        type: row.company_type || null,
        description: row.description || null,
        investment_status: row.investment_status || null,
        stage: row.stage || null,
        sector: row.sector || null,
        last_news_summary: row.last_news_summary || null,
        custom_fields: row.custom_fields || null,
      }
    : null;
}

function finalQualityKnownEntityFromCrossD1Row(row: CrossD1CompanyRow | null): ProspectFinalQualityKnownEntity | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || null,
    domain: row.domain || null,
    website: row.website || null,
    type: row.company_type || null,
    description: row.description || null,
    investment_status: row.investment_status || null,
    stage: row.stage || null,
    sector: row.sector || null,
    last_news_summary: row.last_news_summary || null,
    custom_fields: row.custom_fields || null,
  };
}

async function fetchFinalQualityKnownDeal(
  orgId: string,
  dealId: string | null,
  env: Env
): Promise<ProspectFinalQualityKnownDeal | null> {
  if (!dealId) return null;
  const row = await env.D1.prepare(
    `SELECT
        d.id AS deal_id,
        d.company_id,
        c.name AS company_name,
        c.domain AS company_domain,
        c.website AS company_website
       FROM deals d
       JOIN companies c ON c.id = d.company_id AND c.org_id = d.org_id
      WHERE d.org_id = ?
        AND d.id = ?
        AND d.deleted_at IS NULL
        AND c.deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{
    deal_id: string;
    company_id?: string | null;
    company_name?: string | null;
    company_domain?: string | null;
    company_website?: string | null;
  }>().catch(() => null);
  return row
    ? {
        id: row.deal_id,
        company_id: row.company_id || null,
        company_name: row.company_name || null,
        company_domain: row.company_domain || null,
        company_website: row.company_website || null,
      }
    : null;
}

async function fetchFinalQualityRecentSignals(
  orgId: string,
  normalizedName: string,
  env: Env
): Promise<ProspectFinalQualityHistoricalSignal[]> {
  if (!normalizedName) return [];
  const rows = await env.D1.prepare(
    `SELECT source_type, source_id, source_title, occurred_at,
            mention_type, prospect_id, company_id, deal_id, metadata_json
       FROM prospect_signals
      WHERE org_id = ?
        AND normalized_mention = ?
      ORDER BY occurred_at DESC
      LIMIT 12`
  ).bind(orgId, normalizedName).all<{
    source_type?: SourceType | null;
    source_id?: string | null;
    source_title?: string | null;
    occurred_at?: string | null;
    mention_type?: MentionType | string | null;
    prospect_id?: string | null;
    company_id?: string | null;
    deal_id?: string | null;
    metadata_json?: string | null;
  }>().then(result => result.results || []).catch(() => []);
  return rows.map(row => {
    const metadata = parseSignalMetadata(row.metadata_json);
    const finalQuality = metadata.prospect_final_quality_gate as Record<string, unknown> | undefined;
    return {
      source_type: row.source_type || null,
      source_id: row.source_id || null,
      source_title: row.source_title || null,
      occurred_at: row.occurred_at || null,
      mention_type: row.mention_type || null,
      prospect_action: typeof metadata.prospect_action === 'string' ? metadata.prospect_action : null,
      prospect_id: row.prospect_id || null,
      company_id: row.company_id || null,
      deal_id: row.deal_id || null,
      final_quality_decision: typeof finalQuality?.decision === 'string' ? finalQuality.decision : null,
    };
  });
}

function finalQualityDeterministicHint(
  row: RecordableProspectOutcome,
  existingProspect: ProspectIdentityMatch | null,
  knownCompany: ProspectFinalQualityKnownEntity | null,
  knownDeal: ProspectFinalQualityKnownDeal | null
): ProspectFinalQualityNeighborhood['deterministicHint'] {
  const reasons: string[] = [];
  const secondLook = row.cls.metadata.prospect_second_look as ProspectSecondLookPacket | undefined;
  const finalizationGate = row.cls.metadata.prospect_finalization_gate as Record<string, unknown> | undefined;
  if (secondLook?.required === true && secondLook.lane === 'accepted_but_suspicious') {
    reasons.push('safety net marked the accepted row suspicious');
  }
  if (finalizationGate?.blocked === true) {
    reasons.push('existing finalization guard already blocked this row');
  }
  if (reasons.length > 0) return { suggested_action: 'block_candidate', reasons };
  if (existingProspect) {
    return {
      suggested_action: 'merge_candidate',
      reasons: [`matched existing prospect ${existingProspect.prospect.canonical_name}`],
    };
  }
  const targetName = row.cls.prospectCompanyName || row.mention.canonicalName;
  if (normalizeProspectName(targetName) !== row.mention.normalizedName) {
    return {
      suggested_action: 'rename_candidate',
      reasons: [`pipeline target name differs from extracted name: ${targetName}`],
    };
  }
  if (knownCompany || knownDeal) {
    reasons.push('known company/deal context is available for identity checking');
  }
  return { suggested_action: 'clean_create', reasons };
}

async function buildProspectFinalQualityNeighborhood(
  orgId: string,
  row: RecordableProspectOutcome,
  env: Env
): Promise<ProspectFinalQualityNeighborhood> {
  const existingProspect = await findExistingProspectIdentityMatch(orgId, row.mention, env).catch(() => null);
  const identityCandidates = (row.existing.identityCandidates || [])
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const topCompanyCandidate = identityCandidates.find(candidate => candidate.company_id)?.company_id || null;
  const topDealCandidate = identityCandidates.find(candidate => candidate.deal_id)?.deal_id || null;
  const companyId = row.existing.companyId || topCompanyCandidate;
  const dealId = row.existing.dealId || topDealCandidate;
  const [knownCompanyById, knownDeal, recentSignals, variantCompany] = await Promise.all([
    fetchFinalQualityKnownCompany(orgId, companyId, env),
    fetchFinalQualityKnownDeal(orgId, dealId, env),
    fetchFinalQualityRecentSignals(orgId, row.mention.normalizedName, env),
    companyId
      ? Promise.resolve(null)
      : loadCrossD1CompanyRow(orgId, row.mention, row.existing, row.item, env).catch(() => null),
  ]);
  const knownCompany = knownCompanyById || finalQualityKnownEntityFromCrossD1Row(variantCompany);
  const aliases = Array.from(prospectIdentityAliasesForMention(row.mention, env)).slice(0, 12);
  const domain = firstProspectDomainForMention(row.mention, env);
  const duplicateGroupId = `fqg:${domain || aliases[0] || row.mention.normalizedName || finalQualityRecordKey(row)}`;
  return {
    existingProspect,
    knownCompany,
    knownDeal,
    identityCandidates,
    recentSignals,
    historicalContextCount: recentSignals.length,
    duplicateGroupId,
    aliasKeys: aliases,
    deterministicHint: finalQualityDeterministicHint(row, existingProspect, knownCompany, knownDeal),
  };
}

function finalQualityGatePacketForOutcome(
  row: RecordableProspectOutcome,
  recordOrdinal: number,
  neighborhood: ProspectFinalQualityNeighborhood,
  relatedRows: RecordableProspectOutcome[]
): Record<string, unknown> {
  const secondLook = row.cls.metadata.prospect_second_look as ProspectSecondLookPacket | undefined;
  const reasoningJudge = row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined;
  const finalizationGate = row.cls.metadata.prospect_finalization_gate as Record<string, unknown> | undefined;
  const targetEvidenceReasons = Array.isArray(row.cls.metadata.target_evidence_reasons)
    ? row.cls.metadata.target_evidence_reasons.map(reason => String(reason || '')).filter(Boolean).slice(0, 6)
    : [];
  const packet = secondLook?.packet;
  return {
    record_ordinal: recordOrdinal,
    record_key: finalQualityRecordKey(row),
    proposed_name: row.mention.canonicalName,
    prospect_company_name: row.cls.prospectCompanyName,
    normalized_name: row.mention.normalizedName,
    source_type: row.sourceType,
    source_id: row.item.entityId,
    source_title: row.item.subject || null,
    direction: row.cls.direction,
    confidence: row.cls.confidence,
    signal_kind: row.cls.signalKind,
    supporting_flags: {
      has_deck: row.cls.hasDeck,
      has_meeting: row.cls.hasMeeting,
      has_warm_intro: row.cls.hasWarmIntro,
      has_create_evidence: row.cls.metadata.has_create_evidence === true,
      target_evidence_reasons: targetEvidenceReasons,
      finalization_blocked: finalizationGate?.blocked === true,
      second_look_required: secondLook?.required === true,
      second_look_lane: secondLook?.lane || null,
      second_look_reasons: Array.isArray(secondLook?.reasons) ? secondLook.reasons.slice(0, 4) : [],
      second_look_warnings: Array.isArray(secondLook?.warnings) ? secondLook.warnings.slice(0, 4) : [],
    },
    existing_identity: {
      company_id: row.existing.companyId,
      deal_id: row.existing.dealId,
      match_strength: row.existing.matchStrength,
      identity_score: row.existing.identityScore || 0,
      identity_strength: row.existing.identityStrength || 'none',
      identity_ambiguous: row.existing.identityAmbiguous === true,
      existing_prospect_id: neighborhood.existingProspect?.prospect.id || null,
      existing_prospect_name: neighborhood.existingProspect?.prospect.canonical_name || null,
      existing_prospect_match_method: neighborhood.existingProspect?.method || null,
      existing_prospect_match_score: neighborhood.existingProspect?.score || null,
    },
    neighborhood: {
      duplicate_group_id: neighborhood.duplicateGroupId,
      alias_keys: neighborhood.aliasKeys.slice(0, 6),
      known_company: neighborhood.knownCompany,
      known_deal: neighborhood.knownDeal,
      existing_prospect: neighborhood.existingProspect
        ? {
            id: neighborhood.existingProspect.prospect.id,
            name: neighborhood.existingProspect.prospect.canonical_name,
            normalized_name: neighborhood.existingProspect.prospect.normalized_name,
            domain: neighborhood.existingProspect.prospect.domain || null,
            match_method: neighborhood.existingProspect.method,
            match_score: neighborhood.existingProspect.score,
          }
        : null,
      identity_candidates: neighborhood.identityCandidates.slice(0, 4).map(candidate => ({
        entity_type: candidate.entity_type,
        entity_id: candidate.entity_id,
        company_id: candidate.company_id,
        deal_id: candidate.deal_id,
        name: candidate.name,
        domain: candidate.domain,
        score: candidate.score,
        method: candidate.method,
        reasons: candidate.reasons.slice(0, 3),
      })),
      recent_signals: neighborhood.recentSignals.slice(0, 4),
      historical_context_count: neighborhood.historicalContextCount,
      deterministic_hint: neighborhood.deterministicHint,
      would_attach_to_existing_prospect: Boolean(neighborhood.existingProspect),
    },
    evidence_excerpt: compactClassifierText(
      [
        packet?.excerpt || '',
        row.mention.lineText || '',
        row.mention.contextText || '',
      ].filter(Boolean).join('\n'),
      PROSPECT_FINAL_QUALITY_GATE_EXCERPT_CHARS
    ),
    original_reasoning: typeof row.cls.metadata.original_llm_reasoning === 'string'
      ? row.cls.metadata.original_llm_reasoning
      : typeof row.cls.metadata.llm_reasoning === 'string'
        ? row.cls.metadata.llm_reasoning
        : null,
    judge_reasoning: typeof reasoningJudge?.reason === 'string' ? reasoningJudge.reason : null,
    related_rows: relatedRows
      .filter(other => other !== row)
      .slice(0, PROSPECT_FINAL_QUALITY_GATE_CONTEXT_SIZE)
      .map(other => ({
        proposed_name: other.mention.canonicalName,
        prospect_company_name: other.cls.prospectCompanyName,
        normalized_name: other.mention.normalizedName,
        source_title: other.item.subject || null,
        should_create: other.cls.shouldCreateProspect,
        action: other.cls.prospectAction,
      })),
  };
}

function buildProspectFinalQualityGatePrompt(input: {
  rows: Array<{ row: RecordableProspectOutcome; recordOrdinal: number; neighborhood: ProspectFinalQualityNeighborhood }>;
  relatedRows: RecordableProspectOutcome[];
}): { system: ClaudeSystemPrompt; user: string } {
  const staticSystem = `You are the final quality gate for a venture prospect pipeline.
Your job is to decide whether each proposed prospect row is safe and clean enough to
become a prospect record in the CRM.

Judge the exact proposed row, not just whether the source contains some investment signal.
A row can contain real prospect signal but still be a bad final record if the name is a
fragment, wrapper, investor, source, advisor, customer, program, government channel,
document heading, resume entity, admin artifact, or duplicate alias.

Allowed decisions, exactly:
- allow_create: create the prospect exactly as proposed. Do not use this if the name needs cleanup.
- rename_and_allow: create it under a cleaner canonical company/opportunity name; canonical_name must be the cleaned name.
- merge_into_record: merge it into another proposed row or existing prospect; merge_target_ordinal or merge_target_prospect_id must be populated.
- block_create: do not create a prospect; save only as context/audit.

No fuzzy states are allowed. Do not output maybe, potential, needs_review, or pending.
If the row is messy and you cannot choose a clean canonical target, block_create.
If a merge target is not explicit and safe, block_create.

Block common false positives:
- VC firms, investors, funds, sources, advisors, lenders, buyers, vendors, customers.
- Government, event, program, university, briefing, cohort, channel, or calendar wrappers.
- Resume employers, schools, nonprofits, charities, personal background entities.
- Nonprofit/foundation/event-host rows where the evidence is only meetings, financials,
  founders, follow-up, or diligence. Require direct for-profit investment terms to allow.
- Consulting/advisory/service-provider rows where the evidence is only financial review,
  kickoff, financials, diligence, or vendor-like work. Require direct investment terms to allow.
- Document headings, section labels, generic descriptors, copied markup, admin/security/billing artifacts.
- Rows where reasoning says the candidate is not the investment target.

Preserve true positives:
- Direct founder or dealmaker intros.
- Pitch decks, company decks, data rooms, fundraising rounds, SAFEs, term sheets, valuation, allocation, diligence.
- Real company rows in fundraising lists with their own stage, ask, website, contact, problem, approach, or description.
- Investment documents where the candidate is the central issuer, borrower, acquisition target, or company being reviewed.
- Existing companies newly pitched as fresh investment opportunities.

Clean duplicates when identity is clear:
- Company suffix variants.
- Exact or near-exact normalized names.
- Acronym/full-name variants supported by the evidence.
- Existing-prospect matches shown in the packet.
- Do not rename a source-backed candidate to a CRM source/company id merely because
  the packet contains source_item_company_id or direct_company_id context. Use a known
  company as the canonical name only when the candidate name, domain, or aliases match
  that company. If the source title, excerpt, classifier reasoning, and judge reasoning
  clearly name the candidate as the prospect and the known company name differs, keep
  the candidate as the new prospect record.

Use the neighborhood context:
- If existing_prospect is the same opportunity, prefer merge_into_record with merge_target_prospect_id.
- If another record in this packet is the same opportunity, use merge_into_record with merge_target_ordinal.
- Known company/deal matches and identity scores are identity context, not proof by themselves.
- Recent blocked/context rows should make you stricter about vague aliases and fragments.

Output ONLY strict JSON:
{"decisions":[{"record_ordinal":1,"decision":"allow_create","canonical_name":"Clean Company","merge_target_ordinal":null,"merge_target_prospect_id":null,"reason":"short concrete reason"}]}`;

  const user = JSON.stringify({
    records: input.rows.map(entry => finalQualityGatePacketForOutcome(
      entry.row,
      entry.recordOrdinal,
      entry.neighborhood,
      input.relatedRows
    )),
  });
  return {
    system: [{ type: 'text', text: staticSystem, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    user,
  };
}

function parseProspectFinalQualityGateResponse(
  raw: string,
  model: string,
  usage?: ClaudeUsage | null
): ProspectFinalQualityDecision[] {
  const parsed = parseJsonObject(raw, 'INVALID_FINAL_QUALITY_GATE_JSON');
  if (!Array.isArray(parsed.decisions)) throw new Error('INVALID_FINAL_QUALITY_GATE_DECISIONS');
  return parsed.decisions.map((entry: unknown): ProspectFinalQualityDecision => {
    if (!entry || typeof entry !== 'object') throw new Error('INVALID_FINAL_QUALITY_GATE_DECISION');
    const row = entry as Record<string, unknown>;
    const decision = String(row.decision || '').trim().toLowerCase();
    if (!['allow_create', 'rename_and_allow', 'merge_into_record', 'block_create'].includes(decision)) {
      throw new Error(`INVALID_FINAL_QUALITY_GATE_ACTION:${decision || 'empty'}`);
    }
    const recordOrdinal = Number(row.record_ordinal);
    if (!Number.isInteger(recordOrdinal) || recordOrdinal < 1) {
      throw new Error('INVALID_FINAL_QUALITY_GATE_ORDINAL');
    }
    const canonicalName = parseNullableClassifierString(row.canonical_name);
    const mergeTargetOrdinalRaw = row.merge_target_ordinal;
    const mergeTargetOrdinal = mergeTargetOrdinalRaw == null || mergeTargetOrdinalRaw === ''
      ? null
      : Number(mergeTargetOrdinalRaw);
    if (mergeTargetOrdinal != null && (!Number.isInteger(mergeTargetOrdinal) || mergeTargetOrdinal < 1)) {
      throw new Error('INVALID_FINAL_QUALITY_GATE_MERGE_ORDINAL');
    }
    const mergeTargetProspectId = parseNullableClassifierString(row.merge_target_prospect_id);
    const reason = normalizeWhitespace(String(row.reason || '')).slice(0, 300);
    if (!reason) throw new Error('INVALID_FINAL_QUALITY_GATE_REASON');
    return {
      record_ordinal: recordOrdinal,
      decision: decision as ProspectFinalQualityDecisionAction,
      canonical_name: canonicalName,
      merge_target_ordinal: mergeTargetOrdinal,
      merge_target_prospect_id: mergeTargetProspectId,
      reason,
      model,
      usage,
    };
  });
}

function finalQualityGateMaxTokens(rowCount: number): number {
  return Math.min(1700, Math.max(620, rowCount * 165 + 260));
}

function isFinalQualityGateParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /\bINVALID_FINAL_QUALITY_GATE_(?:JSON|DECISIONS|DECISION|ACTION|ORDINAL|MERGE_ORDINAL|REASON)\b/i.test(message);
}

function finalQualityReasoningJudgeDecision(row: RecordableProspectOutcome): ProspectReasoningJudgeDecision | null {
  const raw = row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const action = String(raw.action || '').trim();
  if (!['allow_create', 'block_create', 'needs_review'].includes(action)) return null;
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;
  return {
    reasoning_valid: raw.reasoning_valid === true,
    action: action as ProspectReasoningJudgeAction,
    confidence,
    reason: normalizeWhitespace(String(raw.reason || '')),
    model: typeof raw.model === 'string' ? raw.model : 'unknown',
    usage: null,
    cache_hit: raw.cache_hit === true,
  };
}

function finalQualityFallbackText(row: RecordableProspectOutcome): string {
  return compactClassifierText([
    row.item.subject ? `Subject: ${row.item.subject}` : '',
    row.item.bodyPreview ? `Preview: ${row.item.bodyPreview}` : '',
    row.item.bodyText ? `Body: ${row.item.bodyText}` : '',
    row.item.text ? `Text: ${row.item.text}` : '',
    row.mention.lineText ? `Line: ${row.mention.lineText}` : '',
    row.mention.contextText ? `Context: ${row.mention.contextText}` : '',
    typeof row.cls.metadata.llm_reasoning === 'string' ? `Classifier reasoning: ${row.cls.metadata.llm_reasoning}` : '',
    typeof row.cls.metadata.original_llm_reasoning === 'string' ? `Original reasoning: ${row.cls.metadata.original_llm_reasoning}` : '',
    typeof (row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined)?.reason === 'string'
      ? `Judge reasoning: ${(row.cls.metadata.reasoning_judge as Record<string, unknown>).reason}`
      : '',
  ].filter(Boolean).join('\n'), 5000);
}

function finalQualityKnownRoleText(neighborhood?: ProspectFinalQualityNeighborhood | null): string {
  const known = neighborhood?.knownCompany;
  const deal = neighborhood?.knownDeal;
  const identityCandidates = neighborhood?.identityCandidates || [];
  return normalizeWhitespace([
    known?.name,
    known?.domain,
    known?.website,
    known?.type,
    known?.description,
    known?.investment_status,
    known?.stage,
    known?.sector,
    known?.last_news_summary,
    known?.custom_fields,
    deal?.company_name,
    deal?.company_domain,
    deal?.company_website,
    ...identityCandidates.slice(0, 4).flatMap(candidate => [
      candidate.name,
      candidate.domain,
      candidate.method,
      ...candidate.reasons.slice(0, 2),
    ]),
  ].filter(Boolean).join(' '));
}

function finalQualityRoleRiskText(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): string {
  const crossD1 = row.cls.metadata.cross_d1_role_check as Record<string, unknown> | undefined;
  const crossD1Evidence = Array.isArray(crossD1?.evidence)
    ? crossD1.evidence.map(value => String(value || '')).join(' ')
    : '';
  return normalizeWhitespace([
    finalQualityFallbackText(row),
    finalQualityKnownRoleText(neighborhood),
    typeof crossD1?.role === 'string' ? `cross d1 role ${crossD1.role}` : '',
    typeof crossD1?.reason === 'string' ? crossD1.reason : '',
    crossD1Evidence,
  ].filter(Boolean).join(' '));
}

function finalQualityHasDirectForProfitInvestmentEvidence(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): boolean {
  const text = finalQualityRoleRiskText(row, neighborhood);
  const candidate = row.mention.canonicalName;
  const candidatePattern = currentCompanyPattern(candidate);
  if (!text || !candidatePattern || !sourceMentionsName(text, candidate)) return false;
  const directTerms = String.raw`(?:fundrais(?:e|ing)|capital\s+raise|raising|raise\s+(?:a\s+)?(?:seed|series|round|capital)|equity\s+(?:investment|financing|round)|selling\s+equity|priced\s+round|round|seed\s+round|series\s+[a-c]|safe|term\s+sheet|valuation|allocation|co[-\s]?investment|investment\s+opportunit(?:y|ies)|investor\s+(?:deck|presentation|overview)|pitch\s+deck|company\s+deck|data\s+room|diligence\s+(?:request|materials?|package|memo)|subscription\s+agreement)`;
  const candidateNearDirectTerms = new RegExp(
    `\\b${candidatePattern}\\b[\\s\\S]{0,260}\\b${directTerms}\\b|\\b${directTerms}\\b[\\s\\S]{0,260}\\b${candidatePattern}\\b`,
    'i'
  ).test(text);
  if (candidateNearDirectTerms) return true;
  const metadataReasons = Array.isArray(row.cls.metadata.target_evidence_reasons)
    ? row.cls.metadata.target_evidence_reasons.map(reason => String(reason || '').trim())
    : [];
  return metadataReasons.some(reason => [
    'fundraising_list_row',
    'pitch_or_investment_document_target',
    'candidate_pitch_material_target',
    'subject_line_target_opportunity',
  ].includes(reason));
}

function finalQualityHasExplicitForProfitInvestmentTerms(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): boolean {
  const text = finalQualityRoleRiskText(row, neighborhood);
  const candidate = row.mention.canonicalName;
  const candidatePattern = currentCompanyPattern(candidate);
  if (!text || !candidatePattern || !sourceMentionsName(text, candidate)) return false;
  const explicitTerms = String.raw`(?:fundrais(?:e|ing)|capital\s+raise|raising|raise\s+(?:a\s+)?(?:seed|series|round|capital)|equity\s+(?:investment|financing|round)|selling\s+equity|priced\s+round|seed\s+round|series\s+[a-c]|safe|term\s+sheet|valuation|allocation|co[-\s]?investment|investment\s+opportunit(?:y|ies)|investor\s+(?:deck|presentation|overview)|pitch\s+deck|company\s+deck|data\s+room|subscription\s+agreement)`;
  if (new RegExp(
    `\\b${candidatePattern}\\b[\\s\\S]{0,260}\\b${explicitTerms}\\b|\\b${explicitTerms}\\b[\\s\\S]{0,260}\\b${candidatePattern}\\b`,
    'i'
  ).test(text)) {
    return true;
  }
  const metadataReasons = Array.isArray(row.cls.metadata.target_evidence_reasons)
    ? row.cls.metadata.target_evidence_reasons.map(reason => String(reason || '').trim())
    : [];
  return metadataReasons.some(reason => [
    'fundraising_list_row',
    'candidate_pitch_material_target',
    'subject_line_target_opportunity',
  ].includes(reason));
}

function finalQualityNonprofitOrFoundationRisk(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): boolean {
  const text = finalQualityRoleRiskText(row, neighborhood);
  const knownText = finalQualityKnownRoleText(neighborhood);
  const candidate = row.mention.canonicalName;
  const candidatePattern = currentCompanyPattern(candidate);
  const knownNonprofit =
    /\b(?:non[-\s]?profit|not[-\s]?for[-\s]?profit|501\s*\(?c\)?|501\(c\)|charit(?:y|able)|foundation)\b/i.test(knownText) &&
    !/\bfoundation\s+model\b/i.test(knownText);
  const candidateNonprofit =
    /\b(?:foundation|charity|non[-\s]?profit|not[-\s]?for[-\s]?profit)\b/i.test(candidate) &&
    !/\bfoundation\s+model\b/i.test(candidate);
  const sourceNamesCandidateAsNonprofit = Boolean(
    candidatePattern &&
    new RegExp(
      `\\b${candidatePattern}\\b[\\s\\S]{0,180}\\b(?:foundation|non[-\\s]?profit|not[-\\s]?for[-\\s]?profit|501\\s*\\(?c\\)?|charit(?:y|able)|event\\s+(?:host|organizer)|organizer|beneficiar(?:y|ies)|donor|sponsor)\\b|\\b(?:foundation|non[-\\s]?profit|not[-\\s]?for[-\\s]?profit|charit(?:y|able)|event\\s+(?:host|organizer)|organizer)\\b[\\s\\S]{0,180}\\b${candidatePattern}\\b`,
      'i'
    ).test(text)
  );
  return knownNonprofit || candidateNonprofit || sourceNamesCandidateAsNonprofit;
}

function finalQualityServiceProviderRisk(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): boolean {
  const text = finalQualityRoleRiskText(row, neighborhood);
  const knownText = finalQualityKnownRoleText(neighborhood);
  const candidate = row.mention.canonicalName;
  const candidatePattern = currentCompanyPattern(candidate);
  const serviceTerms = String.raw`(?:consulting\s+firm|consultancy|consultants?|advisory\s+firm|accountants?\s*&\s*advisors?|accounting\s*(?:&|and)\s*advisory|advisor|adviser|professional\s+services|service\s+provider|fractional\s+(?:cfo|finance)|accounting\s+(?:firm|services)|financial\s+review\s+(?:provider|consultant)|finance\s+operations|outsourced\s+finance|vendor|implementation\s+partner)`;
  const knownServiceProvider = new RegExp(`\\b${serviceTerms}\\b`, 'i').test(knownText);
  const sourceNamesCandidateAsProvider = Boolean(
    candidatePattern &&
    new RegExp(
      `\\b${candidatePattern}\\b[\\s\\S]{0,180}\\b${serviceTerms}\\b|\\b${serviceTerms}\\b[\\s\\S]{0,180}\\b${candidatePattern}\\b`,
      'i'
    ).test(text)
  );
  const candidateIsTargetOfServiceProvider = Boolean(
    candidatePattern &&
    new RegExp(
      `\\b${serviceTerms}\\b[\\s\\S]{0,220}\\b(?:for|on\\s+behalf\\s+of|representing|conducting|arranging|marketing|supporting)\\b[\\s\\S]{0,180}\\b${candidatePattern}\\b`,
      'i'
    ).test(text)
  );
  if (candidateIsTargetOfServiceProvider && !knownServiceProvider) return false;
  return knownServiceProvider || sourceNamesCandidateAsProvider;
}

function finalQualityHasWeakFinancialReviewFrame(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): boolean {
  const text = finalQualityRoleRiskText(row, neighborhood);
  return /\b(?:financial\s+review|review(?:ed|ing)?\s+(?:event\s+)?financials|financials\s+(?:distributed|reviewed|sent|shared)|kickoff\s+meeting|review\s+kickoff|diligence\s+meeting|follow[-\s]?up\s+investment\s+discussion)\b/i.test(text);
}

function finalQualitySourceNamesDifferentTargetCompany(row: RecordableProspectOutcome): boolean {
  const text = [
    row.item.bodyText || '',
    row.item.text || '',
    row.item.bodyPreview || '',
    row.mention.contextText || '',
  ].filter(Boolean).join('\n');
  const candidate = row.mention.canonicalName;
  if (!text || !candidate) return false;
  const targetMatches = text.matchAll(/\btarget\s+company\s*:\s*([^\n\r]{2,220})/gi);
  for (const match of targetMatches) {
    const targetLine = normalizeWhitespace((match[1] || '').split(/(?:---|\*\*ACTION|\bACTION\s+ITEMS?\b|\bRELATIONSHIP\s+NOTES?\b)/i)[0] || '');
    if (!targetLine) continue;
    if (sourceMentionsName(targetLine, candidate)) continue;
    return true;
  }
  return false;
}

function finalQualitySurgicalRoleBlockReason(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): string | null {
  if (finalQualitySourceNamesDifferentTargetCompany(row)) {
    return 'source_names_different_target_company';
  }
  const hasDirectInvestmentEvidence = finalQualityHasDirectForProfitInvestmentEvidence(row, neighborhood);
  const hasExplicitInvestmentTerms = finalQualityHasExplicitForProfitInvestmentTerms(row, neighborhood);
  if (finalQualityNonprofitOrFoundationRisk(row, neighborhood)) {
    if (hasExplicitInvestmentTerms) return null;
    return finalQualityHasWeakFinancialReviewFrame(row, neighborhood)
      ? 'nonprofit_foundation_financial_review_without_for_profit_investment_terms'
      : 'nonprofit_foundation_without_for_profit_investment_terms';
  }
  if (finalQualityServiceProviderRisk(row, neighborhood)) {
    if (hasExplicitInvestmentTerms) return null;
    return finalQualityHasWeakFinancialReviewFrame(row, neighborhood)
      ? 'service_provider_financial_review_without_investment_terms'
      : 'service_provider_without_direct_investment_terms';
  }
  if (hasDirectInvestmentEvidence) return null;
  return null;
}

function finalQualityFallbackTargetProof(row: RecordableProspectOutcome): string[] {
  const sourceText = finalQualityFallbackText(row);
  const reasoning = typeof row.cls.metadata.llm_reasoning === 'string'
    ? row.cls.metadata.llm_reasoning
    : typeof row.cls.metadata.original_llm_reasoning === 'string'
      ? row.cls.metadata.original_llm_reasoning
      : null;
  const proof = new Set<string>();
  const metadataReasons = Array.isArray(row.cls.metadata.target_evidence_reasons)
    ? row.cls.metadata.target_evidence_reasons.map(reason => String(reason || '').trim()).filter(Boolean)
    : [];
  for (const reason of secondLookEvidenceReasons(metadataReasons)) proof.add(reason);
  for (const reason of candidateProspectTargetEvidenceReasons(sourceText, reasoning, row.mention)) proof.add(reason);
  if (hasCandidateFundraisingListRowEvidence(sourceText, reasoning, row.mention)) proof.add('fundraising_list_row_details');
  if (hasStructuredPipelineRowEvidence(sourceText, row.mention.canonicalName)) proof.add('structured_pipeline_row_details');
  if (hasPrivatePitchDocumentTargetEvidence(sourceText, row.mention.canonicalName, row.cls.prospectCompanyName)) {
    proof.add('private_pitch_document_target');
  }
  if (hasCandidatePitchDocumentTargetEvidence(sourceText, reasoning, row.mention.canonicalName)) {
    proof.add('candidate_pitch_document_target');
  }
  if (hasCandidateWarmIntroTargetEvidence(sourceText, reasoning, row.mention.canonicalName)) {
    proof.add('warm_intro_target');
  }
  if (hasCandidateMeetingInvestmentEvidence(sourceText, reasoning, row.mention.canonicalName)) {
    proof.add('meeting_or_diligence_target');
  }
  const secondLook = row.cls.metadata.prospect_second_look as ProspectSecondLookPacket | undefined;
  if (secondLook && acceptedSecondLookHasStrongCandidateSupport({
    secondLook,
    mention: row.mention,
    reasoningJudge: finalQualityReasoningJudgeDecision(row),
  })) {
    proof.add('accepted_second_look_strong_candidate_support');
  }
  if (row.cls.metadata.has_create_evidence === true && hasCandidateProspectTargetEvidence(sourceText, reasoning, row.mention)) {
    proof.add('final_create_evidence_with_target_support');
  }
  return Array.from(proof).slice(0, 8);
}

function finalQualityGenericDescriptorReason(name: string): string | null {
  const clean = normalizeWhitespace(name);
  if (!clean) return 'generic_descriptor_empty_name';
  const genericNoun = String.raw`(?:company|startup|business|platform|infrastructure|project|opportunity|target|issuer|borrower|development)`;
  const descriptor = String.raw`(?:u\.?s\.?|usa|american|israeli|european|latin\s+american|miami|new\s+york|nyc|bay\s+area|stealth|confidential|unnamed|unknown|early[-\s]?stage|ai|iot|data\s+center|cyber|cybersecurity|quantum|defense|dual[-\s]?use|healthcare|fintech|software|hardware|climate|energy|deeptech|infrastructure|ndaa[-\s]?compliant|compliant)`;
  if (new RegExp(`^(?:${descriptor}\\s+){1,5}${genericNoun}$`, 'i').test(clean)) return 'generic_descriptor_without_clean_company';
  if (new RegExp(`\\b${descriptor}\\b[\\s\\S]{0,60}\\b${genericNoun}\\b`, 'i').test(clean)) {
    return 'generic_descriptor_without_clean_company';
  }
  if (/\b(?:based|unnamed|unknown|confidential|stealth)\b/i.test(clean) && new RegExp(`\\b${genericNoun}\\b`, 'i').test(clean)) {
    return 'generic_descriptor_without_clean_company';
  }
  return null;
}

function finalQualityKnownNameSegmentLooksLikeTagline(segment: string): boolean {
  const clean = normalizeWhitespace(segment);
  if (!clean) return true;
  if (finalQualityGenericDescriptorReason(clean)) return true;
  if (/\b(?:for|employees?|training|simplified|reinvent|concept|luxury|living|powered|future|bringing|backed|breakthrough|gamechanger|platform\s+(?:turning|powering)|infrastructure\s+layer|opportunity\s+overview)\b/i.test(clean)) {
    return true;
  }
  if (/\b(?:cybersecurity|ai|quantum|defense|energy|food|supply\s+chain|radiology|blood\s+testing|steelmaking)\b/i.test(clean) && /\b(?:for|platform|play|layer|future|backed|breakthrough|training|employees?|simplified)\b/i.test(clean)) {
    return true;
  }
  return false;
}

function finalQualityDirtyKnownNameReason(name: string): string | null {
  const clean = normalizeWhitespace(name);
  if (!clean) return 'empty_known_identity_name';
  if (finalQualityGenericDescriptorReason(clean)) return 'generic_known_identity_name';
  if (/\b(?:central|actual|real|primary|direct|clean|known|hard|exact|active|private|internal)\s+(?:investment\s+)?(?:target|prospect|candidate|issuer|subject|company|opportunity|identity|memo|review|evidence)\b/i.test(clean)) {
    return 'explanation_fragment_known_identity_name';
  }
  if (/\b(?:the\s+candidate|proposed\s+name|canonical\s+form|clean\s+company\s+name|source\/intermediary)\b/i.test(clean)) {
    return 'explanation_fragment_known_identity_name';
  }
  if (/\b(?:the\s+)?(?:cleaner|clean|actual|known)\s+(?:company|entity|target)\s+name\b/i.test(clean)) {
    return 'explanation_fragment_known_identity_name';
  }
  if (/\b(?:is|was|being)\s+(?:explicitly\s+)?(?:presented|pitched|shared|introduced|reviewed)\b/i.test(clean)) {
    return 'explanation_fragment_known_identity_name';
  }
  if (/^(?:meeting|intro|introduction|re|fw|fwd|tentative)\b/i.test(clean)) return 'wrapper_known_identity_name';
  if (/^(?:shared\s+draft|draft|shared)\b/i.test(clean) || /\bfollow[-\s]?on\s+draft\b/i.test(clean)) {
    return 'document_or_round_known_identity_name';
  }
  if (/^(?:(?:co[-\s]?founder|founder|ceo|cco|cfo|cto|coo|president|partner|principal)(?:\s*&\s*)?)+\s+/i.test(clean)) {
    return 'role_prefixed_known_identity_name';
  }
  if (/\bquick\s+call(?:\s+preview)?\b/i.test(clean)) {
    return 'meeting_fragment_known_identity_name';
  }
  if (/\s+series(?:\s+(?:seed|extension|round|investment|investor|memo|draft|deck|opportunit(?:y|ies)|financing|fundrais(?:e|ing)|co[-\s]?investment))*$/i.test(clean)) {
    return 'document_or_round_known_identity_name';
  }
  if (/\b(?:deck|memo|teaser|presentation|summary|report|update|analysis|cap\s+table|data\s+room|opportunity|confidentiality|nda|financial\s+dd|dd\s+questions?|dd\s+questionnaire|diligence\s+(?:questions?|questionnaire|exhibit|memo|report)|questionnaire|series\s+[a-c]|seed|safe|term\s+sheet)\b/i.test(clean)) {
    return 'document_or_round_known_identity_name';
  }
  if (/^what\s+\S.{0,50}\s+is\s+\S/i.test(clean)) return 'explanation_fragment_known_identity_name';
  if (/^(?:known\s+company\s+match|existing\s+company\s+match|no\s+existing\s+company\s+match|no\s+known\s+company\s+identity|pipe\s+investor)$/i.test(clean) || /\b(?:so\s+you\s+can|you\s+can\s+review|review\s+it\s+thoroughly)\b/i.test(clean)) {
    return 'document_or_round_known_identity_name';
  }
  if (/^(?:vc|candidate|company|prospect|known\s+company\s+match)[.\s:;-]+/i.test(clean)) {
    return 'prefixed_dirty_known_identity_name';
  }
  if (/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+meeting\.\s+the\s+candidate\b/i.test(clean)) {
    return 'meeting_fragment_known_identity_name';
  }
  if (/\s+(?:\||[-–—])\s+/.test(clean)) {
    const parts = clean.split(/\s+(?:\||[-–—])\s+/).map(part => normalizeWhitespace(part)).filter(Boolean);
    if (parts.length >= 2 && parts.some(part => finalQualityKnownNameSegmentLooksLikeTagline(part))) {
      return 'tagline_known_identity_name';
    }
    if (/\|/.test(clean) && parts.some(part => /^[A-Z0-9]{2,6}$/.test(part))) {
      return 'composite_known_identity_name';
    }
  }
  return null;
}

function finalQualityGenericShortFinalNameReason(name: string | null | undefined): string | null {
  const clean = normalizeWhitespace(name || '');
  const normalized = normalizeProspectName(clean);
  if (!normalized) return 'generic_short_final_name_empty';
  if (/^(?:direct|strong|clear|better|grey|private|known|unknown|company|candidate|target|prospect|source|issuer|subject|portco)$/i.test(clean)) {
    return 'generic_short_final_name';
  }
  if (/^(?:goodwin)$/i.test(clean)) return 'source_or_service_provider_short_name';
  return null;
}

function finalQualityNameAppearsAsPersonInText(name: string | null | undefined, text: string): boolean {
  const clean = normalizeWhitespace(name || '');
  const pattern = currentCompanyPattern(clean);
  if (!clean || !pattern || !text) return false;
  const roleTerms = String.raw`(?:CEO|founder|co[-\s]?founder|partner|principal|investor|dealmaker|contact|participant|attendee|host|advisor|adviser|managing\s+partner)`;
  if (/^[A-Z][A-Za-z.'’-]{2,30}$/.test(clean)) {
    const appearsInFullPersonName = new RegExp(`\\b${pattern}\\s+[A-Z][a-zA-Z.'’-]+\\b|\\b[A-Z][a-zA-Z.'’-]+\\s+${pattern}\\b`, 'i').test(text);
    const appearsAfterRole = new RegExp(`\\b${roleTerms}\\s+${pattern}\\b`, 'i').test(text);
    const appearsInDotBundle = new RegExp(`[·•]\\s*${pattern}\\b|\\b${pattern}\\s*[·•]`, 'i').test(text);
    return appearsAfterRole ||
      appearsInDotBundle ||
      (isPersonSingleTokenSegment(clean) && appearsInFullPersonName && new RegExp(`\\b${roleTerms}\\b`, 'i').test(text));
  }
  if (/^[A-Z][A-Za-z.'’-]{2,30}\s+[A-Z][A-Za-z.'’-]{2,30}$/.test(clean)) {
    return new RegExp(`\\b${roleTerms}\\s+${pattern}\\b|\\b${pattern}\\s+\\([^)]*\\b${roleTerms}\\b[^)]*\\)`, 'i').test(text);
  }
  return false;
}

function finalQualityExtractedNameRiskReason(row: RecordableProspectOutcome, name: string | null | undefined): string | null {
  const clean = normalizeWhitespace(name || '');
  if (!clean) return 'final_record_empty_name';
  const text = normalizeWhitespace([
    row.item.subject || '',
    row.item.bodyPreview || '',
    row.item.bodyText || '',
    row.item.text || '',
    row.mention.lineText || '',
    row.mention.contextText || '',
    typeof row.cls.metadata.llm_reasoning === 'string' ? row.cls.metadata.llm_reasoning : '',
    typeof (row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined)?.reason === 'string'
      ? String((row.cls.metadata.reasoning_judge as Record<string, unknown>).reason)
      : '',
  ].filter(Boolean).join(' '));
  const pattern = currentCompanyPattern(clean);
  const hasCompanyLikeTechnicalTerm = /\b(?:ai|quantum|tech|technolog(?:y|ies)|labs?|systems?|data|cyber|bio|health|energy|robotics?|aerospace|networks?|software|compute|computing|cloud|defense)\b/i.test(clean);
  if (/^[A-Z][A-Za-z.'’-]{2,30}\s*[·•]\s*[A-Z][A-Za-z.'’-]{2,30}$/.test(clean) && !hasCompanyToken(clean)) {
    return 'person_or_firm_bundle_final_record';
  }
  if (
    isPersonSingleTokenSegment(clean) ||
    (!hasCompanyLikeTechnicalTerm && (looksLikePersonName(clean) || looksLikePersonOrParticipantBundle(clean)))
  ) {
    return 'person_name_final_record';
  }
  if (finalQualityNameAppearsAsPersonInText(clean, text) && /^[A-Z][A-Za-z.'’-]{2,30}$/.test(clean)) {
    return 'single_first_name_person_context_final_record';
  }
  if (
    !hasCompanyLikeTechnicalTerm &&
    finalQualityNameAppearsAsPersonInText(clean, text) &&
    /^[A-Z][A-Za-z.'’-]{2,30}\s+[A-Z][A-Za-z.'’-]{2,30}$/.test(clean)
  ) {
    return 'full_person_role_context_final_record';
  }
  if (
    !hasCompanyLikeTechnicalTerm &&
    pattern &&
    new RegExp(`\\b(?:CEO|founder|co[-\\s]?founder|partner|principal|investor|dealmaker|contact|participant|attendee|host|advisor|adviser|managing\\s+partner)\\s+${pattern}\\b|\\b${pattern}\\s+\\([^)]*(?:CEO|founder|co[-\\s]?founder|partner|principal|investor|dealmaker|contact|participant|attendee|host|advisor|adviser)[^)]*\\)`, 'i').test(text)
  ) {
    return 'person_role_context_final_record';
  }
  if (/\b(?:as[-\s]?a[-\s]?service|platform|infrastructure|agent|agents|workflow|workflows|model|models|tool|tools|device|drug|asset|demo|technology)\b/i.test(clean) && !hasCompanyToken(clean)) {
    return 'product_or_descriptor_final_record';
  }
  return null;
}

function finalQualityKnownNameAlternatives(name: string): string[] {
  const clean = normalizeWhitespace(name);
  if (!clean) return [];
  const alternatives: string[] = [];
  const add = (value: string | null | undefined): void => {
    const candidate = cleanCorrectedTargetName(value);
    if (!candidate) return;
    if (finalQualityGenericDescriptorReason(candidate)) return;
    if (finalQualityKnownNameSegmentLooksLikeTagline(candidate)) return;
    if (/^[a-z][a-z0-9-]{1,30}$/.test(candidate)) return;
    const normalized = normalizeProspectName(candidate);
    if (!normalized || alternatives.some(existing => normalizeProspectName(existing) === normalized)) return;
    alternatives.push(candidate);
  };

  const wrapperMatch = clean.match(/^(?:meeting|intro|introduction|tentative|re|fw|fwd)\s+(.+)$/i);
  if (wrapperMatch?.[1]) add(wrapperMatch[1]);
  const sharedDraftMatch = clean.match(/^(?:shared\s+draft|draft|shared)\s+(.+?)(?:\s+(?:memo|deck|draft))?$/i);
  if (sharedDraftMatch?.[1]) add(sharedDraftMatch[1]);
  const followOnDraftMatch = clean.match(/^(.+?)\s+follow[-\s]?on\s+draft\b/i);
  if (followOnDraftMatch?.[1]) add(followOnDraftMatch[1]);
  const rolePrefixMatch = clean.match(/^(?:(?:co[-\s]?founder|founder|ceo|cco|cfo|cto|coo|president|partner|principal)(?:\s*&\s*)?)+\s+(.+)$/i);
  if (rolePrefixMatch?.[1]) add(rolePrefixMatch[1]);
  const dirtyPrefixMatch = clean.match(/^(?:vc|candidate|company|prospect|known\s+company\s+match)[.\s:;-]+(.+)$/i);
  if (dirtyPrefixMatch?.[1]) add(dirtyPrefixMatch[1]);
  const trailingSiteMatch = clean.match(/^(.+?)\s+site$/i);
  if (trailingSiteMatch?.[1]) add(trailingSiteMatch[1]);
  add(finalQualityTrailingRoundWrapperBaseName(clean));

  const separatorParts = clean.split(/\s+(?:\||[-–—])\s+/).map(part => normalizeWhitespace(part)).filter(Boolean);
  if (separatorParts.length >= 2) {
    const [left, ...rest] = separatorParts;
    const right = rest[rest.length - 1];
    const leftTagline = finalQualityKnownNameSegmentLooksLikeTagline(left);
    const rightTagline = finalQualityKnownNameSegmentLooksLikeTagline(right);
    if (leftTagline && !rightTagline) add(right);
    if (!leftTagline) add(left);
    if (!rightTagline && !/^[A-Z0-9]{2,6}$/.test(right)) add(right);
  }
  add(clean);
  return alternatives;
}

function finalQualityTrailingRoundWrapperBaseName(value: string | null | undefined): string | null {
  const clean = normalizeWhitespace(value || '');
  if (!clean) return null;
  const match = clean.match(/^(.+?)\s+series(?:\s+(?:seed|extension|round|investment|investor|memo|draft|deck|opportunit(?:y|ies)|financing|fundrais(?:e|ing)|co[-\s]?investment))*$/i);
  const base = cleanCorrectedTargetName(match?.[1]);
  if (!base || normalizeProspectName(base) === normalizeProspectName(clean)) return null;
  return base;
}

function finalQualitySourceSignatureCanonicalName(row: RecordableProspectOutcome): string | null {
  const sourceText = finalQualityFallbackText(row);
  if (!sourceText) return null;
  const patterns = [
    /\b(?:CEO|Chief\s+Executive\s+Officer|Founder|Co[-\s]?Founder|President|Managing\s+Partner|Partner)\s*\|\s*([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\b/g,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s*\|\s*(?:CEO|Chief\s+Executive\s+Officer|Founder|Co[-\s]?Founder|President)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const candidate = cleanCorrectedTargetName(match[1]);
      if (!candidate) continue;
      if (finalQualityGenericDescriptorReason(candidate)) continue;
      if (finalQualityKnownNameSegmentLooksLikeTagline(candidate)) continue;
      if (finalQualityDirtyKnownNameReason(candidate)) continue;
      if (looksLikePersonName(candidate) || looksLikePersonOrParticipantBundle(candidate)) continue;
      if (!finalQualitySourceSupportsCanonicalName(row, candidate)) continue;
      return candidate;
    }
  }
  return null;
}

function finalQualitySourceAmpersandCanonicalName(row: RecordableProspectOutcome): string | null {
  const sourceText = finalQualityFallbackText(row).replace(/&amp;/gi, '&');
  if (!sourceText) return null;
  const currentNormalized = row.mention.normalizedName || normalizeProspectName(row.mention.canonicalName);
  if (!currentNormalized) return null;
  const currentDisplay = cleanCorrectedTargetName(row.mention.canonicalName);
  const currentPattern = currentDisplay ? currentCompanyPattern(currentDisplay) : null;
  if (currentDisplay && currentPattern && /^[A-Z][A-Za-z0-9.'’/-]{2,30}$/.test(currentDisplay)) {
    const repeatedBrandPattern = new RegExp(`\\b${currentPattern}\\s+(?:&|and)\\s+${currentPattern}\\b`, 'i');
    const repeatedBrandMatch = sourceText.match(repeatedBrandPattern);
    if (repeatedBrandMatch?.[0]) {
      const rawCandidate = normalizeWhitespace(repeatedBrandMatch[0].replace(/\s+and\s+/i, ' & '));
      const candidate = rawCandidate ? canonicalizeMention(rawCandidate).canonicalName : null;
      if (
        candidate &&
        normalizeProspectName(candidate) !== currentNormalized &&
        !finalQualityGenericDescriptorReason(candidate) &&
        !finalQualityKnownNameSegmentLooksLikeTagline(candidate) &&
        !finalQualityDirtyKnownNameReason(candidate) &&
        (
          finalQualityTargetHasInvestmentEvidence(sourceText, candidate) ||
          finalQualityTargetHasInvestmentEvidence(sourceText, currentDisplay) ||
          finalQualityFallbackTargetProof(row).length > 0
        )
      ) {
        return candidate;
      }
    }
  }
  const pattern = /\b([A-Z][A-Za-z0-9.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9.'’/-]+){0,3}\s+(?:&|and)\s+[A-Z][A-Za-z0-9.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9.'’/-]+){0,3})\b/g;
  for (const match of sourceText.matchAll(pattern)) {
    const candidate = cleanCorrectedTargetName(match[1]);
    if (!candidate) continue;
    const normalized = normalizeProspectName(candidate);
    if (!normalized || normalized === currentNormalized) continue;
    if (!normalized.includes(currentNormalized) && !currentNormalized.includes(normalized)) continue;
    if (finalQualityGenericDescriptorReason(candidate)) continue;
    if (finalQualityKnownNameSegmentLooksLikeTagline(candidate)) continue;
    if (finalQualityDirtyKnownNameReason(candidate)) continue;
    if (!finalQualityTargetHasInvestmentEvidence(sourceText, candidate)) continue;
    return candidate;
  }
  return null;
}

function finalQualitySourceSentenceCanonicalName(row: RecordableProspectOutcome): string | null {
  const sourceText = finalQualityFallbackText(row).replace(/&amp;/gi, '&');
  if (!sourceText) return null;
  const patterns = [
    /\b(?:About|Introducing|Meet)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\b/g,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s+is\s+(?:currently\s+)?(?:building|developing|creating|launching|commercializing|raising|fundraising|seeking)\b/g,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s+has\s+(?:built|developed|launched|raised|secured)\b/g,
  ];
  const evidenceTerms = /\b(?:intro|introduction|pitch|deck|safe|round|fundrais(?:e|ing)|raising|raise|arr|revenue|pipeline|customers?|traction|pilot|paid|conversion|investors?)\b/i;
  const currentNormalized = row.mention.normalizedName || normalizeProspectName(row.mention.canonicalName);
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const candidate = cleanCorrectedTargetName(match[1]);
      if (!candidate) continue;
      const normalized = normalizeProspectName(candidate);
      if (!normalized || normalized === currentNormalized) continue;
      if (finalQualityGenericDescriptorReason(candidate)) continue;
      if (finalQualityKnownNameSegmentLooksLikeTagline(candidate)) continue;
      if (finalQualityDirtyKnownNameReason(candidate)) continue;
      if (acceptedSecondLookCandidateNameRiskReason(candidate)) continue;
      if (looksLikePersonName(candidate) || looksLikePersonOrParticipantBundle(candidate)) continue;
      const start = Math.max(0, (match.index || 0) - 240);
      const end = Math.min(sourceText.length, (match.index || 0) + match[0].length + 360);
      const window = sourceText.slice(start, end);
      if (!evidenceTerms.test(window) && !finalQualityTargetHasInvestmentEvidence(sourceText, candidate)) continue;
      return candidate;
    }
  }
  return null;
}

function finalQualitySourceSupportsCanonicalName(row: RecordableProspectOutcome, name: string): boolean {
  const sourceText = finalQualityFallbackText(row);
  return sourceMentionsName(sourceText, name) ||
    sourceMentionsName(row.item.subject || '', name) ||
    normalizeProspectName(row.cls.prospectCompanyName || '') === normalizeProspectName(name) ||
    normalizeProspectName(row.mention.canonicalName) === normalizeProspectName(name);
}

function finalQualityNameLooksLikeSourceOrIntermediary(name: string | null | undefined): boolean {
  const clean = normalizeWhitespace(name || '');
  if (!clean) return false;
  return /\b(?:single\s+family\s+office|multi[-\s]?family\s+office|family\s+office|venture\s+capital|vc|capital|ventures?|partners?|fund|invest(?:or|ment)s?|asset\s+management|wealth|bank|securities|advis(?:or|ory|ers?)|lender|broker|source|syndicate|holdings|management|office|group)\b/i.test(clean) ||
    /\s+[|/]\s+/.test(clean);
}

function finalQualityTextNamesEntityAsSource(text: string, name: string | null | undefined): boolean {
  const clean = normalizeWhitespace(name || '');
  const pattern = currentCompanyPattern(clean);
  if (!pattern) return false;
  const roleTerms = String.raw`(?:intro(?:duction)?\s+source|source|intermediary|advisor|adviser|dealmaker|broker|investor|family\s+office|fund|vc|present(?:ed|ing)|introduc(?:ed|ing)|shared|forward(?:ed|ing))`;
  return new RegExp(
    `\\b${pattern}\\b[\\s\\S]{0,180}\\b${roleTerms}\\b|\\b${roleTerms}\\b[\\s\\S]{0,180}\\b${pattern}\\b`,
    'i'
  ).test(text);
}

function finalQualityTextNamesEntityAsIdentityOnly(text: string, name: string | null | undefined): boolean {
  const clean = normalizeWhitespace(name || '');
  const pattern = currentCompanyPattern(clean);
  if (!pattern) return false;
  const identityTerms = String.raw`(?:identity\s+(?:context|candidate|match)|known\s+company|existing\s+company|hard\s+match|strong\s+match|domain\s+match|score\s+\d{2,3}|match\s*\([^)]*score|neighborhood\s+identity)`;
  return new RegExp(
    `\\b${pattern}\\b[\\s\\S]{0,180}\\b${identityTerms}\\b|\\b${identityTerms}\\b[\\s\\S]{0,180}\\b${pattern}\\b`,
    'i'
  ).test(text);
}

function finalQualityReasoningTargetCandidates(text: string): string[] {
  const clean = normalizeWhitespace(text || '');
  if (!clean) return [];
  const patterns = [
    /\b(?:potential\s+investment\s+in|investment\s+in)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})\b/gi,
    /\b(?:document|memo|nda|source|title)\b[^.]{0,220}\b(?:potential\s+investment\s+in|investment\s+in)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})\b/gi,
    /\b(?:prospect\s+company\s+name|clean\s+canonical\s+target|clean\s+target|canonical\s+target|canonical\s+name|canonical\s+form)\s+['"“”]?([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})['"“”]?\s+(?:is|was)\b/gi,
    /\b(?:prospect\s+company\s+name|clean\s+canonical\s+target|clean\s+target|canonical\s+target|canonical\s+name|canonical\s+form)\s+(?:is|was|:)\s+['"“”]?([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})['"“”]?\b/gi,
    /\b(?:canonical\s+name|clean\s+company\s+name|known\s+company(?:\s+(?:identity|record))?)\s+['"“”(]?([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})['"“”)]?\b/gi,
    /\bproposed\s+name\s+['"“”]([^'"“”]{2,80})['"“”]\s+does\s+not\s+match\s+known\s+company\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})\s+(?:is|was)\s+(?:the\s+)?clean\s+canonical\s+target\b/gi,
    /\b(?:normalize\s+capitalization|canonical(?:ize)?\s+capitalization|match\s+known\s+company\s+record)\b[^()]{0,180}\(\s*([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})\s*,\s*not\b/gi,
    /\b(?:subject\s+line|email\s+subject|source\s+title|title)\s+(?:explicitly\s+)?(?:references|names|says|shows)\s+['"“”]([^'"“”]{2,90})['"“”]/gi,
    /\b(?:source\s+email|email|source)\s+(?:discusses|names|shows|references)\s+['"“”]([^'"“”]{2,90})['"“”]/gi,
    /\b(?:actual|real|central|investment)\s+(?:prospect|target|company|opportunity)\s+(?:is|was|appears to be|seems to be|:)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})/gi,
    /\b(?:company|target|prospect|opportunity)\s+being\s+(?:pitched|presented|introduced|shared|reviewed)\s+(?:is|was|appears to be|seems to be|:)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:is|was)\s+(?:explicitly\s+)?(?:the\s+central\s+)?(?:being\s+)?(?:pitched|presented|shared|introduced|reviewed)\b[^.]{0,220}\b(?:Medina|investment|prospect|opportunit|fundrais|raising|round|series|seed|deck|diligence|target)/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:is|was)\s+(?:the\s+)?(?:central\s+)?(?:investment\s+)?(?:target|prospect|opportunity)\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:is|was)\s+(?:the\s+)?(?:central\s+)?candidate\b[^.]{0,220}\b(?:private|inbound|intro|investment|prospect|opportunit|fundrais|raising|round|series|seed|deck|diligence|target|traction|pipeline)\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:is|was)\s+(?:the\s+)?(?:direct|clear|central|actual|real|primary)?[\w\s$.,-]{0,90}\b(?:investment\s+)?(?:target|prospect|opportunity)\b/gi,
    /\b(?:shows?|names|identifies|confirms)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s*\([^)]{0,120}\)\s+(?:is|was)\s+(?:the\s+)?(?:true|direct|clear|central|actual|real|primary)?[\w\s$.,-]{0,90}\b(?:investment\s+)?(?:target|prospect|opportunity)\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s*\([^)]{0,120}\)\s+(?:is|was)\s+(?:the\s+)?(?:true|direct|clear|central|actual|real|primary)?[\w\s$.,-]{0,90}\b(?:investment\s+)?(?:target|prospect|opportunity)\b/gi,
    /\b(?:actual|real|clean|canonical)\s+(?:company|target|prospect|name)\s+(?:is|was|:)\s+['"“”]([^'"“”]{2,80})['"“”]/gi,
    /\b(?:pitch(?:es|ed|ing)?|present(?:s|ed|ing)?|names|identifies|confirms)\s+['"“”]([^'"“”]{2,80})['"“”]/gi,
    /\b(?:actual|real|clean|canonical)\s+(?:company|target|prospect|name)\s+(?:is|was|:)\s+['"“”]?([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})['"“”]?\b/gi,
    /\b(?:pitch(?:es|ed|ing)?|present(?:s|ed|ing)?|names|identifies|confirms)\s+['"“”]([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,6})['"“”]/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:is|was)\s+(?:raising|fundraising|seeking\s+(?:a\s+)?(?:seed|series|round|capital)|in\s+(?:a\s+)?(?:seed|series\s+[a-c])\s+round)\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s+(?:CEO|Founder|Co[-\s]?Founder|President)\s+[A-Z][A-Za-z.'’/-]+(?:\s+[A-Z][A-Za-z.'’/-]+){0,3}\b[^.]{0,220}\b(?:pitch|intro|introduc|meeting|call|fundrais|raising|round|series|seed|deck|diligence|investment|opportunity)\b/gi,
    /\b(?:pitch(?:es|ed|ing)?|introduc(?:es|ed|ing)?|shared?|forward(?:s|ed|ing)?|names|identifies|confirms)\s+([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})(?:'s|’s)?\s+(?:pre[-\s]?seed|seed|series\s+[a-c]|round|fundrais(?:e|ing)|raise|deck|data\s+room)\b[^.]{0,220}\b(?:Medina|investment|prospect|opportunit|fundrais|raising|round|series|seed|deck|diligence|target)/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})(?:'s|’s)?\s+(?:pre[-\s]?seed|seed|series\s+[a-c]|round|fundrais(?:e|ing)|raise|deck|data\s+room)\b[^.]{0,220}\b(?:is|was|as|being|with|for)?[^.]{0,120}\b(?:investment\s+)?(?:target|prospect|opportunity|pitch|diligence|review)\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+(?:is|was)\s+(?:the\s+)?(?:central\s+)?(?:issuer|subject|company)\b[^.]{0,180}\b(?:private|investment|financing|fundrais|raising|round|series|seed|deck|diligence|target|prospect|opportunity)\b/gi,
    /\bcanonical\s+name\s+(?:is|:)\s+['"“”]?([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})['"“”]?\b/gi,
    /\bcanonical\s+form\s+(?:is|:)\s+['"“”]?([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})['"“”]?\b/gi,
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const invalidReasoningTarget = (value: string): boolean => {
    const candidate = normalizeWhitespace(value);
    if (!candidate) return true;
    if (/^(?:no\s+existing\s+company\s+match|known\s+company\s+match|existing\s+company\s+match|hard\s+identity\s+match|no\s+known\s+company\s+identity)$/i.test(candidate)) return true;
    if (/[.!?]/.test(candidate)) return true;
    if (finalQualityGenericShortFinalNameReason(candidate)) return true;
    if (/^[A-Z][A-Za-z.'’-]{2,30}$/.test(candidate) && new RegExp(`(?:[A-Z][A-Za-z.'’-]{2,30}\\s*[·•]\\s*${escapeRegExp(candidate)}|${escapeRegExp(candidate)}\\s*[·•]\\s*[A-Z][A-Za-z.'’-]{2,30})`).test(clean)) return true;
    if (/\b(?:as[-\s]?a[-\s]?service|platform|infrastructure|agent|agents|workflow|workflows|model|models|tool|tools|device|drug|asset|demo|solution|solutions|technology)\b/i.test(candidate) && !hasCompanyToken(candidate)) return true;
    if (finalQualityGenericDescriptorReason(candidate)) return true;
    if (finalQualityDirtyKnownNameReason(candidate)) return true;
    if (finalQualityKnownNameSegmentLooksLikeTagline(candidate)) return true;
    if (looksLikePersonName(candidate) || looksLikePersonOrParticipantBundle(candidate)) return true;
    if (/\b(?:central|actual|real|primary|direct|clean|known|hard|exact|active|private|internal|deterministic)\b/i.test(candidate) &&
        /\b(?:investment|target|prospect|candidate|issuer|subject|company|opportunity|identity|memo|review|evidence|meeting)\b/i.test(candidate)) {
      return true;
    }
    return false;
  };
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const rawCandidate = normalizeWhitespace(match[1] || '').replace(/(?:'s|’s)$/i, '');
      if (!/^[A-Z0-9]/.test(rawCandidate) && !/\b[a-z0-9.-]+\.(?:com|net|io|ai|co|org)\b|\b(?:corp|corporation|inc|llc|ltd)\b/i.test(rawCandidate)) continue;
      if (/^(?:and|or|but|the|this|that|it|itself|source|row|candidate|company|target|prospect|opportunity|presented|introduced|shared|reviewed|pre[-\s]?seed|seed|series\s+[a-c]|round|fundrais(?:e|ing)|raise|deck|data\s+room)\b/i.test(rawCandidate)) continue;
      if (/\b(?:medina|email|subject|source|intro|portco|pipeline|context|identity|neighborhood)\b/i.test(rawCandidate)) continue;
      const candidate = cleanCorrectedTargetName(rawCandidate);
      if (candidate && invalidReasoningTarget(candidate)) continue;
      const normalized = normalizeProspectName(candidate || '');
      if (!candidate || !normalized || seen.has(normalized)) continue;
      if (/^(?:medina|medina ventures|candidate|company|target|prospect|opportunity|source|investor|reasoning|judge)$/i.test(candidate)) continue;
      seen.add(normalized);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function finalQualityTargetHasInvestmentEvidence(text: string, targetName: string): boolean {
  const pattern = currentCompanyPattern(targetName);
  if (!pattern) return false;
  const directTerms = String.raw`(?:pitch(?:ed)?|presented|shared|introduced|reviewed|fundrais(?:e|ing)|raising|raise|round|seed|series\s+[a-c]|safe|term\s+sheet|valuation|allocation|co[-\s]?investment|investment\s+(?:target|prospect|opportunit(?:y|ies))|investor\s+deck|pitch\s+deck|company\s+deck|data\s+room|diligence|memo|teaser)`;
  return new RegExp(
    `\\b${pattern}\\b[\\s\\S]{0,260}\\b${directTerms}\\b|\\b${directTerms}\\b[\\s\\S]{0,260}\\b${pattern}\\b`,
    'i'
  ).test(text);
}

function finalQualityReasoningTargetCanonicalName(
  row: RecordableProspectOutcome,
  neighborhood: ProspectFinalQualityNeighborhood | null | undefined,
  decision?: ProspectFinalQualityDecision
): string | null {
  const proposedTargetName = decision ? finalQualityDecisionProposedTargetName(row, decision) : row.cls.prospectCompanyName || row.mention.canonicalName;
  const reasoningText = normalizeWhitespace([
    typeof row.cls.metadata.llm_reasoning === 'string' ? row.cls.metadata.llm_reasoning : '',
    typeof row.cls.metadata.original_llm_reasoning === 'string' ? row.cls.metadata.original_llm_reasoning : '',
    typeof (row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined)?.reason === 'string'
      ? String((row.cls.metadata.reasoning_judge as Record<string, unknown>).reason)
      : '',
    typeof decision?.reason === 'string' ? decision.reason : '',
  ].filter(Boolean).join('. '));
  if (!reasoningText) return null;
  const sourceText = finalQualityFallbackText(row);
  const proposedNormalized = normalizeProspectName(proposedTargetName);
  const classNameNormalized = normalizeProspectName(row.cls.prospectCompanyName || '');
  const mentionNameNormalized = normalizeProspectName(row.mention.canonicalName || '');
  const currentNames = [
    proposedTargetName,
    classNameNormalized === proposedNormalized ? row.cls.prospectCompanyName || '' : '',
    proposedNormalized === mentionNameNormalized
      ? row.mention.canonicalName
      : '',
  ].map(name => normalizeProspectName(name)).filter(Boolean);
  const currentNameSet = new Set(currentNames);
  const currentDisplayNames = [
    proposedTargetName,
    row.cls.prospectCompanyName || '',
    row.mention.canonicalName,
  ].map(name => normalizeWhitespace(name)).filter(Boolean);
  const currentReasoningSaysBadName = currentDisplayNames.some(name => {
    const pattern = currentCompanyPattern(name);
    if (!pattern) return false;
    return new RegExp(
      `\\b(?:proposed\\s+name|candidate\\s+name|current\\s+name|known\\s+company\\s+match|identity\\s+match)\\s+['"“”]?${pattern}['"“”]?[^.]{0,180}\\b(?:fragment|generic|descriptor|role\\s+label|source|service\\s+provider|law\\s+firm|not\\s+(?:the\\s+)?(?:target|company)|insufficient|dirty|wrapper)\\b|\\b${pattern}\\b[^.]{0,180}\\b(?:is|was)\\s+(?:only\\s+)?(?:a\\s+)?(?:fragment|generic\\s+descriptor|role\\s+label|source|service\\s+provider|law\\s+firm|identity\\s+label)\\b`,
      'i'
    ).test(reasoningText) ||
      new RegExp(`\\b${pattern}\\b[^.]{0,180}\\b(?:flagship\\s+product|product,?\\s+not\\s+(?:a\\s+)?(?:separate\\s+)?company|not\\s+(?:a\\s+)?separate\\s+company)\\b`, 'i').test(reasoningText);
  });
  const currentNameClearlyDirty = Boolean(finalQualityDirtyKnownNameReason(row.mention.canonicalName)) ||
    Boolean(finalQualityDirtyKnownNameReason(proposedTargetName)) ||
    Boolean(acceptedSecondLookCandidateNameRiskReason(row.mention.canonicalName)) ||
    Boolean(acceptedSecondLookCandidateNameRiskReason(proposedTargetName)) ||
    Boolean(finalQualityGenericShortFinalNameReason(row.mention.canonicalName)) ||
    Boolean(finalQualityGenericShortFinalNameReason(proposedTargetName)) ||
    Boolean(finalQualityExtractedNameRiskReason(row, row.mention.canonicalName)) ||
    Boolean(finalQualityExtractedNameRiskReason(row, proposedTargetName)) ||
    finalQualityNameAppearsAsPersonInText(row.mention.canonicalName, reasoningText) ||
    finalQualityNameAppearsAsPersonInText(proposedTargetName, reasoningText) ||
    currentReasoningSaysBadName;
  const currentLooksLikeSource = currentNameClearlyDirty ||
    finalQualityNameLooksLikeSourceOrIntermediary(row.mention.canonicalName) ||
    finalQualityNameLooksLikeSourceOrIntermediary(proposedTargetName) ||
    finalQualityNameLooksLikeSourceOrIntermediary(neighborhood?.knownCompany?.name) ||
    finalQualityNameLooksLikeSourceOrIntermediary(neighborhood?.knownDeal?.company_name) ||
    finalQualityTextNamesEntityAsSource(reasoningText, row.mention.canonicalName) ||
    finalQualityTextNamesEntityAsSource(reasoningText, proposedTargetName) ||
    finalQualityTextNamesEntityAsIdentityOnly(reasoningText, row.mention.canonicalName) ||
    finalQualityTextNamesEntityAsIdentityOnly(reasoningText, proposedTargetName);
  if (!currentLooksLikeSource) return null;
  for (const target of finalQualityReasoningTargetCandidates(reasoningText)) {
    const normalized = normalizeProspectName(target);
    if (!normalized || currentNameSet.has(normalized)) continue;
    if (!currentNameClearlyDirty && currentNames.some(name => normalized.includes(name) || name.includes(normalized))) continue;
    if (!sourceMentionsName(reasoningText, target) && !sourceMentionsName(sourceText, target)) continue;
    if (!finalQualityTargetHasInvestmentEvidence(reasoningText, target) && !finalQualityTargetHasInvestmentEvidence(sourceText, target)) continue;
    return target;
  }
  return null;
}

function finalQualityHardBlockReason(row: RecordableProspectOutcome): string | null {
  const sourceTitle = normalizeWhitespace(row.item.subject || '');
  const excerpt = finalQualityFallbackText(row);
  const candidate = row.mention.canonicalName;
  const reasoning = normalizeWhitespace([
    typeof row.cls.metadata.llm_reasoning === 'string' ? row.cls.metadata.llm_reasoning : '',
    typeof row.cls.metadata.original_llm_reasoning === 'string' ? row.cls.metadata.original_llm_reasoning : '',
    typeof (row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined)?.reason === 'string'
      ? String((row.cls.metadata.reasoning_judge as Record<string, unknown>).reason)
      : '',
  ].filter(Boolean).join('. '));
  if (
    candidateSpecificExistingContextOnly(reasoning, candidate) ||
    classifierReasoningSaysMentionIsNotTarget(reasoning, candidate)
  ) {
    return 'reasoning_says_candidate_is_not_target';
  }
  if (candidateSpecificHardNonTargetLanguage(reasoning, candidate)) return 'hard_non_target_reasoning';
  const sourceRisk = acceptedSecondLookHardSourceRiskReason(sourceTitle, excerpt, candidate);
  if (sourceRisk) return sourceRisk;
  const roleRisk = acceptedSecondLookNonTargetRoleRiskReason(`${sourceTitle}. ${excerpt}. ${reasoning}`, candidate);
  if (roleRisk) return roleRisk;
  const nameRisk = acceptedSecondLookCandidateNameRiskReason(candidate);
  if (nameRisk) return nameRisk;
  if (isStandaloneDocumentHeading(candidate)) return 'document_heading_candidate';
  if (isGenericFragmentCandidate(candidate) || isMarkupArtifactCandidate(candidate)) return 'fragment_or_markup_candidate';
  return null;
}

function finalQualityWrapperCanonicalName(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): string | null {
  const original = row.mention.canonicalName;
  const sourceText = finalQualityFallbackText(row);
  const candidates = [
    finalQualityTrailingRoundWrapperBaseName(original),
    finalQualityTrailingRoundWrapperBaseName(row.cls.prospectCompanyName || ''),
    finalQualityTrailingRoundWrapperBaseName(row.item.subject || ''),
    sourceTitleTargetName(row.item.subject),
    sourceInvestorUpdateTitleTargetName(row.item.subject, sourceText),
    finalQualitySourceSignatureCanonicalName(row),
    finalQualitySourceAmpersandCanonicalName(row),
    finalQualitySourceSentenceCanonicalName(row),
    ...finalQualityKnownNameAlternatives(row.cls.prospectCompanyName || ''),
    ...finalQualityKnownNameAlternatives(neighborhood?.existingProspect?.prospect.canonical_name || ''),
    ...finalQualityKnownNameAlternatives(neighborhood?.knownCompany?.name || ''),
    ...finalQualityKnownNameAlternatives(neighborhood?.knownDeal?.company_name || ''),
  ];
  for (const candidate of candidates) {
    const clean = cleanCorrectedTargetName(candidate || null);
    if (!clean || normalizeProspectName(clean) === row.mention.normalizedName) continue;
    if (
      sourceMentionsName(sourceText, clean) ||
      sourceMentionsName(row.item.subject || '', clean) ||
      normalizeProspectName(candidate || '').includes(row.mention.normalizedName) ||
      row.mention.normalizedName.includes(normalizeProspectName(clean))
    ) {
      return clean;
    }
  }
  const wrapperPattern = /\b(?:meeting|intro|introduction|co[-\s]?investment|investment\s+opportunit(?:y|ies)|series\s+[abc]|seed|safe|term\s+sheet|pitch\s+deck|investor\s+deck|data\s+room|financing|fundrais(?:e|ing)|round|opportunity)\b/i;
  if (!wrapperPattern.test(original)) return null;
  const stripped = cleanCorrectedTargetName(
    original
      .replace(/\b(?:meeting|intro(?:duction)?|co[-\s]?investment|investment\s+opportunit(?:y|ies)|series\s+[abc]|seed|safe|term\s+sheet|pitch\s+deck|investor\s+deck|data\s+room|financing|fundrais(?:e|ing)|round|opportunity)\b/gi, ' ')
      .replace(/\s+/g, ' ')
  );
  if (!stripped || normalizeProspectName(stripped) === row.mention.normalizedName) return null;
  if (finalQualityDirtyKnownNameReason(stripped) || acceptedSecondLookCandidateNameRiskReason(stripped)) return null;
  return stripped;
}

function finalQualityKnownIdentityCanonicalName(
  row: RecordableProspectOutcome,
  neighborhood?: ProspectFinalQualityNeighborhood | null
): string | null {
  const names: string[] = [];
  if (neighborhood?.existingProspect?.prospect.canonical_name) {
    names.push(neighborhood.existingProspect.prospect.canonical_name);
  }
  const knownCompanyId = neighborhood?.knownCompany?.id || null;
  const knownDealCompanyId = neighborhood?.knownDeal?.company_id || null;
  const hasHardCompanyIdentity = Boolean(
    (knownCompanyId && row.existing.companyId === knownCompanyId) ||
    (knownDealCompanyId && row.existing.companyId === knownDealCompanyId) ||
    row.existing.matchStrength === 'domain' ||
    row.existing.identityStrength === 'hard' ||
    (row.existing.identityScore || 0) >= 95 ||
    (row.existing.identityCandidates || []).some(candidate =>
      candidate.score >= 95 &&
      (
        (knownCompanyId && candidate.company_id === knownCompanyId) ||
        (knownDealCompanyId && candidate.company_id === knownDealCompanyId) ||
        (row.existing.dealId && candidate.deal_id === row.existing.dealId)
      )
    )
  );
  if (hasHardCompanyIdentity) {
    if (neighborhood?.knownCompany?.name) names.push(neighborhood.knownCompany.name);
    if (neighborhood?.knownDeal?.company_name) names.push(neighborhood.knownDeal.company_name);
  }
  for (const name of names) {
    const clean = normalizeWhitespace(name || '');
    if (!clean) continue;
    const dirtyReason = finalQualityDirtyKnownNameReason(clean);
    const alternatives = dirtyReason ? finalQualityKnownNameAlternatives(clean) : [clean];
    for (const alternative of alternatives) {
      if (!alternative || finalQualityGenericDescriptorReason(alternative)) continue;
      if (dirtyReason && !finalQualitySourceSupportsCanonicalName(row, alternative)) continue;
      return alternative;
    }
  }
  return null;
}

function finalQualityTopScoredIdentityCandidateName(row: RecordableProspectOutcome): string | null {
  if (row.existing.identityAmbiguous) return null;
  const sorted = [...(row.existing.identityCandidates || [])]
    .filter(candidate => candidate.score >= 85 && candidate.name)
    .sort((left, right) => right.score - left.score);
  for (const candidate of sorted) {
    const clean = cleanCorrectedTargetName(candidate.name);
    if (!clean) continue;
    if (finalQualityGenericDescriptorReason(clean)) continue;
    if (finalQualityDirtyKnownNameReason(clean)) continue;
    if (acceptedSecondLookCandidateNameRiskReason(clean)) continue;
    if (finalQualityNameLooksLikeSourceOrIntermediary(clean) && candidate.score < 95) continue;
    return clean;
  }
  return null;
}

function finalQualityDecisionProposedTargetName(
  row: RecordableProspectOutcome,
  decision: ProspectFinalQualityDecision
): string {
  if (decision.decision === 'allow_create') return row.mention.canonicalName;
  return decision.canonical_name || row.cls.prospectCompanyName || row.mention.canonicalName;
}

function finalQualityExplicitCanonicalCompanyName(reason: string | null | undefined): string | null {
  const text = normalizeWhitespace(reason || '');
  if (!text) return null;
  const patterns = [
    /\b(?:points?\s+to|identifies|names)\s+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})\s+as\s+(?:the\s+)?(?:clean\s+)?(?:canonical\s+)?company\s+name\b/i,
    /\b(?:rename\s+to|use)\s+(?:the\s+)?(?:clean\s+)?canonical\s+company\s+name\s+['"“”]([^'"“”]{2,90})['"“”]/i,
    /\b(?:canonical\s+company\s+name|canonical\s+name|clean\s+company\s+name)\s+(?:is|:)?\s*['"“”]([^'"“”]{2,90})['"“”]/i,
    /\b(?:rename\s+to|use)\s+(?:the\s+)?(?:clean\s+)?canonical\s+company\s+name\s+['"“”]?([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})['"“”]?\b/i,
    /\b(?:canonical\s+company\s+name|canonical\s+name|clean\s+company\s+name)\s+(?:is|:)?\s*['"“”]?([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})['"“”]?\b/i,
  ];
  for (const pattern of patterns) {
    const candidate = cleanCorrectedTargetName(text.match(pattern)?.[1] || '');
    if (!candidate) continue;
    if (finalQualityGenericDescriptorReason(candidate)) continue;
    if (finalQualityDirtyKnownNameReason(candidate)) continue;
    if (finalQualityKnownNameSegmentLooksLikeTagline(candidate)) continue;
    if (acceptedSecondLookCandidateNameRiskReason(candidate)) continue;
    if (/\b(?:as[-\s]?a[-\s]?service|platform|infrastructure|agent|workflow|model|tool|device|drug|asset|demo|solution|technology)\b/i.test(candidate) && !hasCompanyToken(candidate)) continue;
    return candidate;
  }
  const domain = text.match(/\b(?:domain|website)\s+([a-z0-9.-]+\.[a-z]{2,})\b/i)?.[1]?.toLowerCase().replace(/^www\./, '');
  if (domain && !shouldIgnoreDomain(domain)) {
    const candidate = cleanCorrectedTargetName(domainLabelToCompany(domain));
    if (
      candidate &&
      !finalQualityGenericDescriptorReason(candidate) &&
      !finalQualityDirtyKnownNameReason(candidate) &&
      !acceptedSecondLookCandidateNameRiskReason(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function enforcedFinalQualityReason(reason: string, suffix: string): string {
  return normalizeWhitespace(`${reason} ${suffix}`).slice(0, 300);
}

function finalQualityDecisionReasonBlockReason(
  decision: ProspectFinalQualityDecision,
  proposedTargetName: string
): string | null {
  const reason = normalizeWhitespace(decision.reason || '');
  if (!reason) return null;
  const namePattern = currentCompanyPattern(proposedTargetName);
  const scoped = namePattern
    ? new RegExp(`\\b${namePattern}\\b`, 'i').test(reason)
    : true;
  if (scoped && /\b(?:not|isn['’]?t|is\s+not|was\s+not)\s+(?:an?\s+|the\s+)?(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched)\b/i.test(reason)) {
    return 'final_quality_reason_says_not_target';
  }
  if (/\b(?:evidence\s+is\s+(?:file\s+management|admin(?:istrative)?|workflow)|file\s+(?:creation|management|update)|internal\s+administrative\s+email|not\s+(?:a\s+)?direct\s+investment\s+signal|not\s+(?:a\s+)?pitch|not\s+(?:an?\s+)?investment\s+(?:opportunity|target)|insufficient\s+direct\s+investment\s+terms|insufficient\s+(?:direct\s+)?company\s+evidence|meeting\s+summary\s+alone|deterministic_hint\s+(?:explicitly\s+)?(?:recommends|recommended|blocks?)\s+(?:block(?:ing)?|block_candidate)|deterministic\s+hint\s+to\s+block_candidate|person(?:al)?\s+name\s+fragment|person[-\s]?company\s+hybrid|fragment\/alias\s+(?:that\s+)?(?:lacks|insufficient)|too\s+generic\s+and\s+ambiguous\s+to\s+be\s+a\s+safe\s+prospect\s+record|could\s+collide\s+with\s+multiple\s+companies|lacks\s+specificity|insufficient\s+for\s+CRM\s+record\s+creation|no\s+(?:website|formal\s+company|clean\s+company|actual\s+company|concrete\s+company|clear\s+investment\s+terms|substantive\s+pitch\s+content)|does\s+not\s+clearly\s+establish[^.]{0,120}\b(?:fundraising|investment|prospect|company))\b/i.test(reason)) {
    return 'final_quality_reason_unscoped_block_language';
  }
  if (!scoped) return null;
  if (/\b(?:investor|vc|fund|wealth\s+management|sender|source|advisor|adviser|service\s+provider|vendor|event\s+(?:host|organizer)|directory)\b[^.]{0,180}\b(?:not\s+(?:an?\s+|the\s+)?(?:investment\s+)?(?:target|prospect|opportunity)|no\s+(?:pitch|fundraise|fundraising|round|investment\s+opportunity))\b/i.test(reason)) {
    return 'final_quality_reason_says_non_target_role';
  }
  if (/\boriginal\s+model\s+(?:correctly\s+)?(?:identified|said|classified)[^.]{0,140}\bnon[-\s]?prospect\b/i.test(reason)) {
    return 'final_quality_reason_agrees_non_prospect';
  }
  if (/\b(?:not\s+pitching|not\s+being\s+pitched|not\s+presenting|no\s+fundraising\s+opportunity|no\s+investment\s+opportunity|no\s+prospect\s+signal)\b/i.test(reason)) {
    return 'final_quality_reason_says_no_prospect_signal';
  }
  return null;
}

function enforceProspectFinalQualityDecision(
  entry: { row: RecordableProspectOutcome; neighborhood?: ProspectFinalQualityNeighborhood | null },
  decision: ProspectFinalQualityDecision
): ProspectFinalQualityDecision {
  if (decision.decision === 'block_create' || decision.decision === 'merge_into_record') return decision;
  const proposedTargetName = finalQualityDecisionProposedTargetName(entry.row, decision);
  const identityName = finalQualityKnownIdentityCanonicalName(entry.row, entry.neighborhood);
  const topIdentityCandidateName = finalQualityTopScoredIdentityCandidateName(entry.row);
  const cleanWrapperName = finalQualityWrapperCanonicalName(entry.row, entry.neighborhood);
  const identityNameIsDirty = Boolean(identityName && (
    finalQualityDirtyKnownNameReason(identityName) ||
    acceptedSecondLookCandidateNameRiskReason(identityName)
  ));
  const cleanKnownName = identityName && !identityNameIsDirty
    ? identityName
    : cleanWrapperName || topIdentityCandidateName || identityName;
  const explicitCanonicalName = finalQualityExplicitCanonicalCompanyName(decision.reason);
  const reasoningTargetName = finalQualityReasoningTargetCanonicalName(entry.row, entry.neighborhood, decision);
  const genericReason = finalQualityGenericDescriptorReason(proposedTargetName) ||
    finalQualityGenericDescriptorReason(entry.row.mention.canonicalName);
  const proposedNameRiskReason = finalQualityDirtyKnownNameReason(proposedTargetName) ||
    finalQualityGenericShortFinalNameReason(proposedTargetName) ||
    finalQualityExtractedNameRiskReason(entry.row, proposedTargetName) ||
    (finalQualityNameAppearsAsPersonInText(proposedTargetName, decision.reason || '') ? 'person_name_final_record' : null);
  const originalNameRiskReason = finalQualityDirtyKnownNameReason(entry.row.mention.canonicalName) ||
    finalQualityGenericShortFinalNameReason(entry.row.mention.canonicalName) ||
    finalQualityExtractedNameRiskReason(entry.row, entry.row.mention.canonicalName) ||
    (finalQualityNameAppearsAsPersonInText(entry.row.mention.canonicalName, decision.reason || '') ? 'person_name_final_record' : null);
  const dirtyKnownNameReason = proposedNameRiskReason ||
    (decision.decision === 'allow_create' ? originalNameRiskReason : null);
  const surgicalRoleBlockReason = finalQualitySurgicalRoleBlockReason(entry.row, entry.neighborhood);

  if (surgicalRoleBlockReason) {
    return {
      ...decision,
      decision: 'block_create',
      canonical_name: null,
      merge_target_ordinal: null,
      merge_target_prospect_id: null,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check blocked role-risky row (${surgicalRoleBlockReason}).`
      ),
      hard_block_reason: surgicalRoleBlockReason,
    };
  }

  const cleanWrapperNameIsUsable = Boolean(cleanWrapperName) &&
    !finalQualityDirtyKnownNameReason(cleanWrapperName || '') &&
    !acceptedSecondLookCandidateNameRiskReason(cleanWrapperName || '');
  const identityNameLooksLikeSource = Boolean(identityName && finalQualityNameLooksLikeSourceOrIntermediary(identityName));
  const rawSourceText = compactClassifierText([
    entry.row.item.subject || '',
    entry.row.item.bodyPreview || '',
    entry.row.item.bodyText || '',
    entry.row.item.text || '',
    entry.row.mention.lineText || '',
    entry.row.mention.contextText || '',
  ].filter(Boolean).join('\n'), 5000);
  const sourceBackedTargetProof = finalQualityFallbackTargetProof(entry.row);
  const hasStrongSourceBackedTargetProof = sourceBackedTargetProof.some(reason =>
    /(?:structured_pipeline_row_details|fundraising_list_row_details|warm_intro_target|medina_outbound_prospect_interest|private_pitch_document_target|candidate_pitch_document_target|meeting_or_diligence_target|final_create_evidence_with_target_support|accepted_second_look_strong_candidate_support)/i.test(reason)
  );
  const cleanWrapperNameIsSourceBacked = Boolean(cleanWrapperName && (
    sourceMentionsName(rawSourceText, cleanWrapperName) ||
    sourceMentionsName(entry.row.item.subject || '', cleanWrapperName)
  ));
  const rowBackedOriginalName = normalizeWhitespace(entry.row.cls.prospectCompanyName || entry.row.mention.canonicalName);
  const proposedDiffersFromRowBackedName = Boolean(rowBackedOriginalName) &&
    normalizeProspectName(proposedTargetName) !== normalizeProspectName(rowBackedOriginalName) &&
    !identityAliasSetsCompatible(prospectIdentityAliasesForName(proposedTargetName), prospectIdentityAliasesForName(rowBackedOriginalName));
  const sourceItemCompanyMismatchCandidate = (entry.row.existing.identityCandidates || []).some(candidate =>
    normalizeProspectName(candidate.name) === normalizeProspectName(proposedTargetName) &&
    candidate.reasons.some(reason => /source_item_company_id_mismatch_candidate_name|source_company_context_audit_only/i.test(reason))
  );
  const sourceBackedCandidateShouldWin = Boolean(
    decision.decision === 'rename_and_allow' &&
    proposedDiffersFromRowBackedName &&
    rowBackedOriginalName &&
    hasStrongSourceBackedTargetProof &&
    sourceMentionsName(rawSourceText, rowBackedOriginalName) &&
    (
      sourceItemCompanyMismatchCandidate ||
      /\b(?:source_item_company_id|direct_company_id|known\s+company|company_id|alias\s+or\s+working\s+name)\b/i.test(decision.reason || '')
    )
  );

  if (sourceBackedCandidateShouldWin) {
    return {
      ...decision,
      decision: 'allow_create',
      canonical_name: rowBackedOriginalName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check preserved source-backed candidate ${rowBackedOriginalName}; mismatched source-company context is audit-only.`
      ),
      hard_block_reason: null,
      target_proof: sourceBackedTargetProof,
    };
  }

  if (
    reasoningTargetName &&
    (dirtyKnownNameReason || identityNameLooksLikeSource || !identityName || identityNameIsDirty) &&
    normalizeWhitespace(reasoningTargetName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase()
  ) {
    return {
      ...decision,
      decision: 'rename_and_allow',
      canonical_name: reasoningTargetName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check replaced dirty final-record name with reasoning target ${reasoningTargetName}.`
      ),
      hard_block_reason: null,
    };
  }

  if (
    cleanWrapperName &&
    cleanWrapperNameIsUsable &&
    (!reasoningTargetName || cleanWrapperNameIsSourceBacked) &&
    (dirtyKnownNameReason || identityNameLooksLikeSource || !identityName || identityNameIsDirty) &&
    normalizeWhitespace(cleanWrapperName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase()
  ) {
    return {
      ...decision,
      decision: 'rename_and_allow',
      canonical_name: cleanWrapperName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check replaced dirty final-record name with clean target ${cleanWrapperName}.`
      ),
      hard_block_reason: null,
    };
  }

  const decisionReasonBlockReason = finalQualityDecisionReasonBlockReason(decision, proposedTargetName);
  if (decisionReasonBlockReason) {
    return {
      ...decision,
      decision: 'block_create',
      canonical_name: null,
      merge_target_ordinal: null,
      merge_target_prospect_id: null,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check blocked because the final-review reason itself says the row is not a clean prospect (${decisionReasonBlockReason}).`
      ),
      hard_block_reason: decisionReasonBlockReason,
    };
  }

  if (
    dirtyKnownNameReason &&
    explicitCanonicalName &&
    normalizeWhitespace(explicitCanonicalName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase()
  ) {
    return {
      ...decision,
      decision: 'rename_and_allow',
      canonical_name: explicitCanonicalName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check replaced dirty final-record name with explicit canonical company ${explicitCanonicalName}.`
      ),
      hard_block_reason: null,
    };
  }

  if (
    explicitCanonicalName &&
    normalizeWhitespace(explicitCanonicalName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase() &&
    !finalQualityGenericShortFinalNameReason(explicitCanonicalName) &&
    !finalQualityExtractedNameRiskReason(entry.row, explicitCanonicalName) &&
    (
      sourceMentionsName(rawSourceText, explicitCanonicalName) ||
      sourceMentionsName(decision.reason || '', explicitCanonicalName) ||
      sourceMentionsName(entry.row.item.subject || '', explicitCanonicalName)
    )
  ) {
    return {
      ...decision,
      decision: 'rename_and_allow',
      canonical_name: explicitCanonicalName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check used explicit canonical company ${explicitCanonicalName}.`
      ),
      hard_block_reason: null,
    };
  }

  if (dirtyKnownNameReason) {
    const sourceBackedOriginalNameIsUsable = Boolean(rowBackedOriginalName) &&
      !finalQualityDirtyKnownNameReason(rowBackedOriginalName) &&
      !acceptedSecondLookCandidateNameRiskReason(rowBackedOriginalName) &&
      !finalQualityExtractedNameRiskReason(entry.row, rowBackedOriginalName);
    if (
      rowBackedOriginalName &&
      sourceBackedOriginalNameIsUsable &&
      hasStrongSourceBackedTargetProof &&
      sourceMentionsName(rawSourceText, rowBackedOriginalName)
    ) {
      return {
        ...decision,
        decision: 'rename_and_allow',
        canonical_name: rowBackedOriginalName,
        reason: `Deterministic final check replaced dirty final-review name with source-backed row target ${rowBackedOriginalName}.`,
        hard_block_reason: null,
        target_proof: sourceBackedTargetProof,
      };
    }
    const cleanKnownNameIsUsable = Boolean(cleanKnownName) &&
      !finalQualityDirtyKnownNameReason(cleanKnownName || '') &&
      !acceptedSecondLookCandidateNameRiskReason(cleanKnownName || '') &&
      !finalQualityExtractedNameRiskReason(entry.row, cleanKnownName || '');
    if (
      cleanKnownName &&
      cleanKnownNameIsUsable &&
      normalizeWhitespace(cleanKnownName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase()
    ) {
      return {
        ...decision,
        decision: 'rename_and_allow',
        canonical_name: cleanKnownName,
        reason: enforcedFinalQualityReason(
          decision.reason,
          `Deterministic final check replaced dirty final-record name with known target ${cleanKnownName}.`
        ),
        hard_block_reason: null,
      };
    }
    return {
      ...decision,
      decision: 'block_create',
      canonical_name: null,
      merge_target_ordinal: null,
      merge_target_prospect_id: null,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check blocked dirty final-record name without a clean company replacement (${dirtyKnownNameReason}).`
      ),
      hard_block_reason: genericReason || dirtyKnownNameReason,
    };
  }

  if (genericReason) {
    if (cleanKnownName) {
      return {
        ...decision,
        decision: 'rename_and_allow',
        canonical_name: cleanKnownName,
        reason: enforcedFinalQualityReason(
          decision.reason,
          `Deterministic final check replaced an unresolved descriptor with known target ${cleanKnownName}.`
        ),
        hard_block_reason: null,
      };
    }
    return {
      ...decision,
      decision: 'block_create',
      canonical_name: null,
      merge_target_ordinal: null,
      merge_target_prospect_id: null,
      reason: enforcedFinalQualityReason(
        decision.reason,
        'Deterministic final check blocked unresolved generic descriptor without a clean company name.'
      ),
      hard_block_reason: genericReason,
    };
  }

  if (reasoningTargetName && normalizeWhitespace(reasoningTargetName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase()) {
    return {
      ...decision,
      decision: 'rename_and_allow',
      canonical_name: reasoningTargetName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check replaced source/intermediary name with reasoning target ${reasoningTargetName}.`
      ),
      hard_block_reason: null,
    };
  }

  if (
    identityName &&
    normalizeWhitespace(identityName).toLowerCase() !== normalizeWhitespace(proposedTargetName).toLowerCase() &&
    !(hasStrongSourceBackedTargetProof && sourceMentionsName(rawSourceText, proposedTargetName))
  ) {
    return {
      ...decision,
      decision: 'rename_and_allow',
      canonical_name: identityName,
      reason: enforcedFinalQualityReason(
        decision.reason,
        `Deterministic final check used known identity canonical name ${identityName}.`
      ),
    };
  }

  return decision;
}

function fallbackProspectFinalQualityDecision(
  row: RecordableProspectOutcome,
  recordOrdinal: number,
  reason: string,
  failedOpen = false,
  options: {
    model?: string;
    parseFailed?: boolean;
    retryUsed?: boolean;
    batchSize?: number;
    neighborhood?: ProspectFinalQualityNeighborhood | null;
  } = {}
): ProspectFinalQualityDecision {
  const secondLook = row.cls.metadata.prospect_second_look as ProspectSecondLookPacket | undefined;
  const suspicious = secondLook?.required === true && secondLook.lane === 'accepted_but_suspicious';
  const targetProof = finalQualityFallbackTargetProof(row);
  const hardBlockReason = finalQualitySurgicalRoleBlockReason(row, options.neighborhood) || finalQualityHardBlockReason(row);
  const reasoningTargetName = finalQualityReasoningTargetCanonicalName(row, options.neighborhood, {
    record_ordinal: recordOrdinal,
    decision: 'allow_create',
    canonical_name: row.cls.prospectCompanyName || row.mention.canonicalName,
    merge_target_ordinal: null,
    merge_target_prospect_id: null,
    reason,
    model: options.model || 'deterministic_fallback',
  });
  const canonicalName = finalQualityWrapperCanonicalName(row, options.neighborhood);
  const genericDescriptorReason = finalQualityGenericDescriptorReason(row.mention.canonicalName);
  const unoverridableHardBlock = hardBlockReason != null && (
    hardBlockReason === 'reasoning_says_candidate_is_not_target' ||
    hardBlockReason === 'hard_non_target_reasoning' ||
    hardBlockReason === 'accepted_second_look_non_target_role_context' ||
    hardBlockReason === 'accepted_second_look_existing_context_only' ||
    hardBlockReason === 'accepted_second_look_hard_non_prospect_reasoning'
  );
  let decision: ProspectFinalQualityDecisionAction = 'block_create';
  let fallbackBasis = 'insufficient_target_proof';
  let outputCanonicalName: string | null = null;
  let outputReason = `${reason}: blocked by evidence-aware fallback because target proof was insufficient.`;

  if (reasoningTargetName) {
    decision = 'rename_and_allow';
    fallbackBasis = 'reasoning_target_repair';
    outputCanonicalName = reasoningTargetName;
    outputReason = `${reason}: replaced source/intermediary name with reasoning target ${reasoningTargetName}.`;
    targetProof.push('reasoning_target_repair');
  } else if (unoverridableHardBlock || (hardBlockReason && targetProof.length === 0)) {
    fallbackBasis = 'hard_block';
    outputReason = `${reason}: blocked by evidence-aware fallback (${hardBlockReason}).`;
  } else if (canonicalName && targetProof.length > 0) {
    decision = 'rename_and_allow';
    fallbackBasis = 'wrapper_renamed_to_clean_target';
    outputCanonicalName = canonicalName;
    outputReason = `${reason}: renamed to ${canonicalName} by evidence-aware fallback using strong target proof.`;
  } else if (genericDescriptorReason && !canonicalName) {
    fallbackBasis = genericDescriptorReason;
    outputReason = `${reason}: blocked because the proposed name is a generic descriptor without a clean company name.`;
  } else if (targetProof.length > 0) {
    decision = 'allow_create';
    fallbackBasis = 'strong_target_proof';
    outputCanonicalName = row.cls.prospectCompanyName || row.mention.canonicalName;
    outputReason = `${reason}: allowed by evidence-aware fallback using strong target proof (${targetProof.slice(0, 3).join(', ')}).`;
  } else if (suspicious) {
    fallbackBasis = 'suspicious_without_target_proof';
    outputReason = `${reason}: suspicious accepted row was blocked by evidence-aware fallback.`;
  }

  return {
    record_ordinal: recordOrdinal,
    decision,
    canonical_name: outputCanonicalName,
    merge_target_ordinal: null,
    merge_target_prospect_id: null,
    reason: outputReason,
    model: options.model || prospectFinalQualityGateModel({} as Env),
    usage: null,
    cache_hit: false,
    fallback_used: true,
    failed_open: failedOpen && decision === 'allow_create' && targetProof.length === 0,
    parse_failed: options.parseFailed === true,
    retry_used: options.retryUsed === true,
    fallback_basis: fallbackBasis,
    target_proof: targetProof,
    hard_block_reason: hardBlockReason || genericDescriptorReason || null,
    batch_size: options.batchSize,
  };
}

async function callProspectFinalQualityGate(
  orgId: string,
  env: Env,
  batch: RecordableProspectOutcome[],
  allRows: RecordableProspectOutcome[],
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites' | 'stats'> = {}
): Promise<{ batchId: string; decisions: ProspectFinalQualityDecision[] }> {
  const model = prospectFinalQualityGateModel(env);
  const rows = await Promise.all(batch.map(async (row, index) => ({
    row,
    recordOrdinal: index + 1,
    neighborhood: await buildProspectFinalQualityNeighborhood(orgId, row, env),
  })));
  const relatedRows = finalQualityRelatedRows(batch, allRows);
  const hashes = await prospectLlmCacheKey({
    orgId,
    stage: 'final_quality_gate',
    promptVersion: PROSPECT_FINAL_QUALITY_GATE_CACHE_VERSION,
    model,
    source: rows.map(entry => ({
      source_type: entry.row.sourceType,
      source_id: entry.row.item.entityId,
      source_title: entry.row.item.subject || null,
    })),
    candidate: rows.map(entry => ({
      record_ordinal: entry.recordOrdinal,
      proposed_name: entry.row.mention.canonicalName,
      normalized_name: entry.row.mention.normalizedName,
      prospect_company_name: entry.row.cls.prospectCompanyName,
    })),
    context: {
      related_rows: relatedRows.map(row => ({
        source_id: row.item.entityId,
        proposed_name: row.mention.canonicalName,
        normalized_name: row.mention.normalizedName,
        should_create: row.cls.shouldCreateProspect,
      })),
      existing_prospects: rows.map(entry => ({
        record_ordinal: entry.recordOrdinal,
        prospect_id: entry.neighborhood.existingProspect?.prospect.id || null,
        prospect_name: entry.neighborhood.existingProspect?.prospect.canonical_name || null,
        method: entry.neighborhood.existingProspect?.method || null,
      })),
      neighborhoods: rows.map(entry => ({
        record_ordinal: entry.recordOrdinal,
        duplicate_group_id: entry.neighborhood.duplicateGroupId,
        known_company: entry.neighborhood.knownCompany,
        known_deal: entry.neighborhood.knownDeal,
        identity_candidates: entry.neighborhood.identityCandidates.map(candidate => ({
          entity_type: candidate.entity_type,
          entity_id: candidate.entity_id,
          company_id: candidate.company_id,
          deal_id: candidate.deal_id,
          score: candidate.score,
          method: candidate.method,
        })),
        historical_context_count: entry.neighborhood.historicalContextCount,
        deterministic_hint: entry.neighborhood.deterministicHint,
      })),
    },
    decision: rows.map(entry => ({
      record_ordinal: entry.recordOrdinal,
      action: entry.row.cls.prospectAction,
      should_create: entry.row.cls.shouldCreateProspect,
      reasoning: entry.row.cls.metadata.llm_reasoning || entry.row.cls.metadata.original_llm_reasoning || null,
      judge_reason: (entry.row.cls.metadata.reasoning_judge as Record<string, unknown> | undefined)?.reason || null,
    })),
  });
  const batchId = `fqg_${hashes.cacheKey.slice(0, 12)}`;
  if (!options.dryRunNoBudgetWrites) {
    const cached = await readD1ProspectLlmCache<ProspectFinalQualityDecision[]>(env, hashes.cacheKey);
    if (cached) {
      recordLlmStageUsage(options.stats, 'final_quality_gate', { cacheHit: true });
      if (options.stats) options.stats.final_quality_gate_cache_hits++;
      const entryByOrdinal = new Map(rows.map(entry => [entry.recordOrdinal, entry]));
      return {
        batchId,
        decisions: cached.value_json.map(decision => {
          const entry = entryByOrdinal.get(decision.record_ordinal);
          const hydrated = { ...decision, cache_hit: true };
          return entry ? enforceProspectFinalQualityDecision(entry, hydrated) : hydrated;
        }),
      };
    }
  }
  const callModelForRows = async (
    entries: typeof rows,
    retryUsed: boolean
  ): Promise<ProspectFinalQualityDecision[]> => {
    const chunkRelatedRows = finalQualityRelatedRows(entries.map(entry => entry.row), allRows);
    const chunkPrompt = buildProspectFinalQualityGatePrompt({ rows: entries, relatedRows: chunkRelatedRows });
    const result = await callClaudeWithUsage(
      {
        system: chunkPrompt.system,
        user: chunkPrompt.user,
        max_tokens: finalQualityGateMaxTokens(entries.length),
        orgId,
        model,
        assistantPrefill: '{',
        temperature: 0,
        dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
      },
      'low',
      env
    );
    recordLlmStageUsage(options.stats, 'final_quality_gate', { usage: result.usage, paidCall: true });
    const entryByOrdinal = new Map(entries.map(entry => [entry.recordOrdinal, entry]));
    return parseProspectFinalQualityGateResponse(result.text, result.model, result.usage).map(decision => {
      const hydrated = {
        ...decision,
        parse_failed: retryUsed,
        retry_used: retryUsed,
        batch_size: entries.length,
      };
      const entry = entryByOrdinal.get(decision.record_ordinal);
      return entry ? enforceProspectFinalQualityDecision(entry, hydrated) : hydrated;
    });
  };
  const completeWithFallbacks = (
    entries: typeof rows,
    parsed: ProspectFinalQualityDecision[],
    fallbackReason: string,
    parseFailed: boolean,
    retryUsed: boolean
  ): ProspectFinalQualityDecision[] => {
    const byOrdinal = new Map(parsed.map(decision => [decision.record_ordinal, decision]));
    return entries.map(entry => byOrdinal.get(entry.recordOrdinal) || fallbackProspectFinalQualityDecision(
      entry.row,
      entry.recordOrdinal,
      fallbackReason,
      true,
      {
        model,
        parseFailed,
        retryUsed,
        batchSize: entries.length,
        neighborhood: entry.neighborhood,
      }
    ));
  };
  const writeCacheIfSafe = async (decisions: ProspectFinalQualityDecision[], usage: ClaudeUsage | null): Promise<void> => {
    if (options.dryRunNoBudgetWrites || decisions.some(decision => decision.fallback_used === true)) return;
    await writeD1ProspectLlmCache(env, {
      cache_key: hashes.cacheKey,
      org_id: orgId,
      stage: 'final_quality_gate',
      prompt_version: PROSPECT_FINAL_QUALITY_GATE_CACHE_VERSION,
      model,
      source_hash: hashes.sourceHash,
      candidate_hash: hashes.candidateHash,
      context_hash: hashes.contextHash,
      decision_hash: hashes.decisionHash,
      value_json: decisions,
      usage,
      created_at: new Date().toISOString(),
    });
  };
  try {
    const parsed = await callModelForRows(rows, false);
    const decisions = completeWithFallbacks(rows, parsed, 'final_quality_gate_missing_decision', false, false);
    await writeCacheIfSafe(decisions, parsed[0]?.usage || null);
    return { batchId, decisions };
  } catch (error) {
    if (isFinalQualityGateParseError(error)) {
      const decisions: ProspectFinalQualityDecision[] = [];
      for (let index = 0; index < rows.length; index += PROSPECT_FINAL_QUALITY_GATE_RETRY_CHUNK_SIZE) {
        const chunk = rows.slice(index, index + PROSPECT_FINAL_QUALITY_GATE_RETRY_CHUNK_SIZE);
        try {
          const parsed = await callModelForRows(chunk, true);
          decisions.push(...completeWithFallbacks(
            chunk,
            parsed,
            'final_quality_gate_retry_missing_decision',
            true,
            true
          ));
        } catch (retryError) {
          const reason = `final_quality_gate_retry_error:${compactProspectBackfillError(retryError)}`;
          decisions.push(...chunk.map(entry => fallbackProspectFinalQualityDecision(
            entry.row,
            entry.recordOrdinal,
            reason,
            true,
            {
              model,
              parseFailed: isFinalQualityGateParseError(retryError),
              retryUsed: true,
              batchSize: chunk.length,
              neighborhood: entry.neighborhood,
            }
          )));
        }
      }
      await writeCacheIfSafe(decisions, null);
      return { batchId, decisions };
    }
    const reason = `final_quality_gate_error:${compactProspectBackfillError(error)}`;
    return {
      batchId,
      decisions: rows.map(entry => fallbackProspectFinalQualityDecision(
        entry.row,
        entry.recordOrdinal,
        reason,
        true,
        {
          model,
          parseFailed: false,
          retryUsed: false,
          batchSize: rows.length,
          neighborhood: entry.neighborhood,
        }
      )),
    };
  }
}

function finalQualityRelatedRows(
  batch: RecordableProspectOutcome[],
  allRows: RecordableProspectOutcome[]
): RecordableProspectOutcome[] {
  const batchSet = new Set(batch);
  const batchAliases = new Set<string>();
  for (const row of batch) {
    batchAliases.add(row.mention.normalizedName);
    for (const alias of prospectIdentityAliasesForMention(row.mention)) batchAliases.add(alias);
  }
  const scored = allRows
    .filter(row => !batchSet.has(row))
    .map(row => {
      let score = row.item.entityId && batch.some(current => current.item.entityId === row.item.entityId) ? 4 : 0;
      if (batchAliases.has(row.mention.normalizedName)) score += 5;
      for (const alias of prospectIdentityAliasesForMention(row.mention)) {
        if (batchAliases.has(alias)) score += 3;
      }
      if (row.cls.shouldCreateProspect) score += 1;
      return { row, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.mention.canonicalName.localeCompare(b.row.mention.canonicalName));
  return scored.slice(0, PROSPECT_FINAL_QUALITY_GATE_CONTEXT_SIZE).map(entry => entry.row);
}

function normalizedSourceTitleFamily(title: string | null | undefined): string | null {
  const normalized = normalizeProspectName(title || '');
  if (normalized.length < 8) return null;
  return normalized.slice(0, 80);
}

function finalQualityDuplicateKeys(row: RecordableProspectOutcome): Set<string> {
  const keys = new Set<string>();
  keys.add(`name:${row.mention.normalizedName}`);
  keys.add(`source:${row.sourceType}:${row.item.entityId}`);
  const titleFamily = normalizedSourceTitleFamily(row.item.subject);
  if (titleFamily) keys.add(`title:${titleFamily}`);
  const domain = firstProspectDomainForMention(row.mention);
  if (domain) keys.add(`domain:${domain}`);
  if (row.existing.companyId) keys.add(`company:${row.existing.companyId}`);
  if (row.existing.dealId) keys.add(`deal:${row.existing.dealId}`);
  for (const alias of prospectIdentityAliasesForMention(row.mention)) {
    if (alias.length >= 3) keys.add(`alias:${alias}`);
  }
  for (const candidate of row.existing.identityCandidates || []) {
    if (candidate.score < 75) continue;
    keys.add(`${candidate.entity_type}:${candidate.entity_id}`);
    if (candidate.company_id) keys.add(`company:${candidate.company_id}`);
    if (candidate.deal_id) keys.add(`deal:${candidate.deal_id}`);
    if (candidate.domain) keys.add(`domain:${candidate.domain.toLowerCase()}`);
  }
  return keys;
}

function finalQualityBatchRows(rows: RecordableProspectOutcome[]): RecordableProspectOutcome[][] {
  const createRows = rows
    .filter(row => row.cls.shouldCreateProspect)
    .sort((a, b) =>
      a.mention.normalizedName.localeCompare(b.mention.normalizedName) ||
      a.item.entityId.localeCompare(b.item.entityId) ||
      a.mention.mentionOrdinal - b.mention.mentionOrdinal
    );
  const parent = createRows.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const firstByKey = new Map<string, number>();
  createRows.forEach((row, index) => {
    for (const key of finalQualityDuplicateKeys(row)) {
      const existing = firstByKey.get(key);
      if (existing == null) firstByKey.set(key, index);
      else union(existing, index);
    }
  });
  const groups = new Map<number, RecordableProspectOutcome[]>();
  createRows.forEach((row, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(row);
    groups.set(root, group);
  });
  const orderedGroups = Array.from(groups.values()).sort((a, b) => {
    const left = a[0];
    const right = b[0];
    return left.mention.normalizedName.localeCompare(right.mention.normalizedName) ||
      left.item.entityId.localeCompare(right.item.entityId);
  });
  const batches: RecordableProspectOutcome[][] = [];
  let current: RecordableProspectOutcome[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
  };
  for (const group of orderedGroups) {
    if (group.length > PROSPECT_FINAL_QUALITY_GATE_BATCH_SIZE) {
      flush();
      for (let index = 0; index < group.length; index += PROSPECT_FINAL_QUALITY_GATE_BATCH_SIZE) {
        batches.push(group.slice(index, index + PROSPECT_FINAL_QUALITY_GATE_BATCH_SIZE));
      }
      continue;
    }
    if (current.length + group.length > PROSPECT_FINAL_QUALITY_GATE_BATCH_SIZE) flush();
    current.push(...group);
  }
  flush();
  return batches;
}

function mentionWithFinalQualityCanonicalName(mention: MentionCandidate, canonicalName: string): MentionCandidate {
  const clean = normalizeWhitespace(canonicalName);
  if (!clean || clean === mention.canonicalName) return mention;
  return {
    ...mention,
    canonicalName: clean,
    normalizedName: normalizeProspectName(clean),
  };
}

function finalQualityDecisionTargetName(
  decision: ProspectFinalQualityDecision,
  row: RecordableProspectOutcome,
  batchByOrdinal: Map<number, RecordableProspectOutcome>
): string | null {
  if (decision.decision === 'block_create') return null;
  if (decision.decision === 'allow_create') return row.mention.canonicalName;
  if (decision.canonical_name) return decision.canonical_name;
  if (decision.merge_target_ordinal) {
    const target = batchByOrdinal.get(decision.merge_target_ordinal);
    if (target) return target.cls.prospectCompanyName || target.mention.canonicalName;
  }
  return row.cls.prospectCompanyName || row.mention.canonicalName;
}

function finalQualityDecisionMergeKey(
  row: RecordableProspectOutcome,
  decision: ProspectFinalQualityDecision,
  batchByOrdinal: Map<number, RecordableProspectOutcome>
): string | null {
  if (decision.decision === 'block_create' || decision.decision === 'merge_into_record') return null;
  if (row.existing.companyId) return `company:${row.existing.companyId}`;
  if (row.existing.dealId) return `deal:${row.existing.dealId}`;
  const hardIdentity = (row.existing.identityCandidates || [])
    .slice()
    .sort((a, b) => b.score - a.score)
    .find(candidate => candidate.score >= 95 && (candidate.company_id || candidate.deal_id || candidate.domain));
  if (hardIdentity?.company_id) return `company:${hardIdentity.company_id}`;
  if (hardIdentity?.deal_id) return `deal:${hardIdentity.deal_id}`;
  const domain = firstProspectDomainForMention(row.mention);
  if (domain) return `domain:${domain.toLowerCase()}`;
  const targetName = finalQualityDecisionTargetName(decision, row, batchByOrdinal);
  if (!targetName || finalQualityGenericDescriptorReason(targetName)) return null;
  const normalized = normalizeProspectName(targetName);
  return normalized.length >= 3 ? `name:${normalized}` : null;
}

function mergeDuplicateFinalQualityBatchDecisions(
  batch: RecordableProspectOutcome[],
  decisions: ProspectFinalQualityDecision[],
  batchByOrdinal: Map<number, RecordableProspectOutcome>
): ProspectFinalQualityDecision[] {
  const byOrdinal = new Map(decisions.map(decision => [decision.record_ordinal, decision]));
  const firstCreateOrdinalByKey = new Map<string, number>();
  const out: ProspectFinalQualityDecision[] = [];
  for (const row of batch) {
    const ordinal = batch.findIndex(candidate => candidate === row) + 1;
    const decision = byOrdinal.get(ordinal);
    if (!decision) continue;
    const key = finalQualityDecisionMergeKey(row, decision, batchByOrdinal);
    const firstOrdinal = key ? firstCreateOrdinalByKey.get(key) : null;
    if (key && firstOrdinal == null) {
      firstCreateOrdinalByKey.set(key, ordinal);
      out.push(decision);
      continue;
    }
    if (key && firstOrdinal != null && firstOrdinal !== ordinal) {
      out.push({
        ...decision,
        decision: 'merge_into_record',
        canonical_name: null,
        merge_target_ordinal: firstOrdinal,
        merge_target_prospect_id: null,
        reason: enforcedFinalQualityReason(
          decision.reason,
          `Deterministic final check merged duplicate identity ${key} into record ${firstOrdinal}.`
        ),
      });
      continue;
    }
    out.push(decision);
  }
  return out;
}

function finalQualityPrimaryDuplicateGroupId(row: RecordableProspectOutcome): string {
  const keys = Array.from(finalQualityDuplicateKeys(row));
  return keys.find(key => key.startsWith('domain:')) ||
    keys.find(key => key.startsWith('company:')) ||
    keys.find(key => key.startsWith('deal:')) ||
    keys.find(key => key.startsWith('alias:')) ||
    keys[0] ||
    `row:${finalQualityRecordKey(row)}`;
}

function unresolvedMergeTargetDecision(
  decision: ProspectFinalQualityDecision,
  reason = 'unresolved_merge_target'
): ProspectFinalQualityDecision {
  return {
    ...decision,
    decision: 'block_create',
    canonical_name: null,
    merge_target_ordinal: decision.merge_target_ordinal,
    merge_target_prospect_id: decision.merge_target_prospect_id,
    reason,
  };
}

function applyFinalQualityDecisionToOutcome(
  row: RecordableProspectOutcome,
  decision: ProspectFinalQualityDecision,
  batchId: string,
  batchByOrdinal: Map<number, RecordableProspectOutcome>
): RecordableProspectOutcome {
  const initialDecision = enforceProspectFinalQualityDecision({ row, neighborhood: null }, decision);
  const identityConflictTargetProof = finalQualityFallbackTargetProof(row);
  const identityConflictHasDirectProof = finalQualityHasDirectForProfitInvestmentEvidence(row, null);
  const identityConflictHardBlockReason = finalQualityHardBlockReason(row);
  const identityConflictHardBlockAllowsPreserve = !identityConflictHardBlockReason ||
    (identityConflictHardBlockReason === 'accepted_second_look_non_target_role_context' &&
      (identityConflictTargetProof.length > 0 || identityConflictHasDirectProof));
  const identityConflictDecisionSaysDoNotPreserve = /\b(?:document\s+(?:heading|title|wrapper|descriptor)|wrapper\s+artifact|not\s+a\s+(?:company|prospect)|no\s+(?:actual\s+)?company\s+identity|no\s+(?:concrete\s+)?prospect\s+signal|no\s+(?:external\s+)?(?:pitch|fundraise|investment)|no\s+investment\s+terms|block(?:ed)?\s+(?:both|create)|block\s+as\s+context|context\s+only|internal\s+(?:memo|portfolio|fund)\s+(?:draft|review|management))\b/i
    .test(initialDecision.reason || '');
  const identityConflictBlock = initialDecision.decision === 'block_create' &&
    row.cls.shouldCreateProspect === true &&
    /\b(?:identity\s+conflict|conflicts\s+with\s+existing|known_company\s+record|resolves\s+to|alias\/duplicate|duplicate\s+alias|proposed\s+name|distinct\s+from|separate\s+company)\b/i.test(initialDecision.reason) &&
    (identityConflictTargetProof.length > 0 || identityConflictHasDirectProof) &&
    !finalQualitySurgicalRoleBlockReason(row, null) &&
    identityConflictHardBlockAllowsPreserve &&
    !identityConflictDecisionSaysDoNotPreserve;
  const strongPrivateDocumentBlock = initialDecision.decision === 'block_create' &&
    row.cls.shouldCreateProspect === true &&
    /\b(?:accepted_but_suspicious|second[_\s-]?look|suspicious|safety\s+net|deterministic\s+hint|pending)\b/i.test(initialDecision.reason || '') &&
    (
      identityConflictTargetProof.some(reason =>
        /(?:private_pitch_document_target|candidate_pitch_document_target|final_create_evidence_with_target_support|meeting_or_diligence_target|structured_pipeline_row_details|fundraising_list_row_details|warm_intro_target|accepted_second_look_strong_candidate_support)/i.test(reason)
      ) ||
      identityConflictHasDirectProof
    ) &&
    !finalQualitySurgicalRoleBlockReason(row, null) &&
    identityConflictHardBlockAllowsPreserve &&
    !identityConflictDecisionSaysDoNotPreserve;
  const rawReasoningTargetName = initialDecision.decision === 'allow_create' || initialDecision.decision === 'rename_and_allow' || identityConflictBlock || strongPrivateDocumentBlock
    ? finalQualityReasoningTargetCanonicalName(row, null, initialDecision)
    : null;
  const rowBackedTargetName = normalizeWhitespace(row.cls.prospectCompanyName || row.mention.canonicalName);
  const rowBackedSourceText = compactClassifierText([
    row.item.subject || '',
    row.item.bodyPreview || '',
    row.item.bodyText || '',
    row.item.text || '',
    row.mention.lineText || '',
    row.mention.contextText || '',
  ].filter(Boolean).join('\n'), 5000);
  const reasoningTargetConflictsWithSourceBackedRow = Boolean(rawReasoningTargetName && rowBackedTargetName) &&
    normalizeProspectName(rawReasoningTargetName) !== normalizeProspectName(rowBackedTargetName) &&
    !identityAliasSetsCompatible(prospectIdentityAliasesForName(rawReasoningTargetName), prospectIdentityAliasesForName(rowBackedTargetName)) &&
    identityConflictTargetProof.length > 0 &&
    sourceMentionsName(rowBackedSourceText, rowBackedTargetName);
  const reasoningTargetName = reasoningTargetConflictsWithSourceBackedRow ? null : rawReasoningTargetName;
  const identityConflictTargetName = identityConflictBlock
    ? finalQualityWrapperCanonicalName(row, null) || normalizeWhitespace(row.cls.prospectCompanyName || row.mention.canonicalName)
    : null;
  const strongPrivateDocumentTargetName = strongPrivateDocumentBlock
    ? finalQualityWrapperCanonicalName(row, null) || normalizeWhitespace(row.cls.prospectCompanyName || row.mention.canonicalName)
    : null;
  let effectiveDecision: ProspectFinalQualityDecision = reasoningTargetName
    ? {
        ...initialDecision,
        decision: 'rename_and_allow' as ProspectFinalQualityDecisionAction,
        canonical_name: reasoningTargetName,
        reason: enforcedFinalQualityReason(
          initialDecision.reason,
          `Deterministic final apply replaced source/intermediary name with reasoning target ${reasoningTargetName}.`
        ),
        hard_block_reason: null,
      }
      : identityConflictTargetName
        ? {
            ...initialDecision,
            decision: 'rename_and_allow' as ProspectFinalQualityDecisionAction,
            canonical_name: identityConflictTargetName,
            reason: `Deterministic final apply preserved target ${identityConflictTargetName} because identity conflict had strong candidate-specific proof.`,
            hard_block_reason: null,
            target_proof: identityConflictTargetProof,
          }
        : strongPrivateDocumentTargetName
          ? {
              ...initialDecision,
              decision: 'rename_and_allow' as ProspectFinalQualityDecisionAction,
              canonical_name: strongPrivateDocumentTargetName,
              reason: `Deterministic final apply preserved target ${strongPrivateDocumentTargetName} because candidate-specific proof outweighed a suspicious-only block.`,
              hard_block_reason: null,
              target_proof: identityConflictTargetProof,
            }
          : initialDecision;
  if (effectiveDecision.decision !== 'block_create' && effectiveDecision.decision !== 'merge_into_record') {
    const effectiveTargetName = finalQualityDecisionTargetName(effectiveDecision, row, batchByOrdinal) ||
      effectiveDecision.canonical_name ||
      row.cls.prospectCompanyName ||
      row.mention.canonicalName;
    const effectiveReasonBlockReason = finalQualityDecisionReasonBlockReason(effectiveDecision, effectiveTargetName);
    const effectiveTargetRiskReason = finalQualityGenericShortFinalNameReason(effectiveTargetName) ||
      finalQualityExtractedNameRiskReason(row, effectiveTargetName) ||
      (finalQualityNameAppearsAsPersonInText(effectiveTargetName, effectiveDecision.reason || '') ? 'person_name_final_record' : null);
    const effectiveExplicitCanonicalName = finalQualityExplicitCanonicalCompanyName(effectiveDecision.reason);
    if (
      effectiveTargetRiskReason &&
      effectiveExplicitCanonicalName &&
      normalizeProspectName(effectiveExplicitCanonicalName) !== normalizeProspectName(effectiveTargetName) &&
      !finalQualityGenericShortFinalNameReason(effectiveExplicitCanonicalName) &&
      !finalQualityExtractedNameRiskReason(row, effectiveExplicitCanonicalName)
    ) {
      effectiveDecision = {
        ...effectiveDecision,
        decision: 'rename_and_allow',
        canonical_name: effectiveExplicitCanonicalName,
        reason: enforcedFinalQualityReason(
          effectiveDecision.reason,
          `Deterministic final apply replaced dirty final-record name with explicit canonical company ${effectiveExplicitCanonicalName}.`
        ),
        hard_block_reason: null,
      };
    } else if (effectiveTargetRiskReason) {
      effectiveDecision = {
        ...effectiveDecision,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: enforcedFinalQualityReason(
          effectiveDecision.reason,
          `Deterministic final apply blocked dirty final-record name without a clean company replacement (${effectiveTargetRiskReason}).`
        ),
        hard_block_reason: effectiveTargetRiskReason,
      };
    } else if (effectiveReasonBlockReason) {
      effectiveDecision = {
        ...effectiveDecision,
        decision: 'block_create',
        canonical_name: null,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: enforcedFinalQualityReason(
          effectiveDecision.reason,
          `Deterministic final apply blocked because the final-review reason itself says the row is not a clean prospect (${effectiveReasonBlockReason}).`
        ),
        hard_block_reason: effectiveReasonBlockReason,
      };
    }
  }
  if (effectiveDecision.decision === 'merge_into_record') {
    const target = effectiveDecision.merge_target_ordinal ? batchByOrdinal.get(effectiveDecision.merge_target_ordinal) || null : null;
    const targetIsSelf = effectiveDecision.merge_target_ordinal != null && target === row;
    const rowTargetName = normalizeWhitespace(row.cls.prospectCompanyName || row.mention.canonicalName);
    const mergeTargetName = target
      ? normalizeWhitespace(target.cls.prospectCompanyName || target.mention.canonicalName)
      : '';
    const incompatibleMergeTarget = Boolean(rowTargetName && mergeTargetName) &&
      normalizeProspectName(rowTargetName) !== normalizeProspectName(mergeTargetName) &&
      !identityAliasSetsCompatible(prospectIdentityAliasesForName(rowTargetName), prospectIdentityAliasesForName(mergeTargetName));
    const sourceBackedMergeProof = identityConflictTargetProof.some(reason =>
        /(?:structured_pipeline_row_details|fundraising_list_row_details|warm_intro_target|medina_outbound_prospect_interest|private_pitch_document_target|candidate_pitch_document_target|meeting_or_diligence_target|final_create_evidence_with_target_support|accepted_second_look_strong_candidate_support)/i.test(reason)
    );
    if (
      target &&
      incompatibleMergeTarget &&
      sourceBackedMergeProof &&
      sourceMentionsName(compactClassifierText([
        row.item.subject || '',
        row.item.bodyPreview || '',
        row.item.bodyText || '',
        row.item.text || '',
        row.mention.lineText || '',
        row.mention.contextText || '',
      ].filter(Boolean).join('\n'), 5000), rowTargetName)
    ) {
      effectiveDecision = {
        ...effectiveDecision,
        decision: 'rename_and_allow',
        canonical_name: rowTargetName,
        merge_target_ordinal: null,
        merge_target_prospect_id: null,
        reason: `Deterministic final apply rejected incompatible merge target ${mergeTargetName} and preserved source-backed target ${rowTargetName}.`,
        hard_block_reason: null,
        target_proof: identityConflictTargetProof,
      };
    }
  }
  if (effectiveDecision.decision === 'merge_into_record') {
    const target = effectiveDecision.merge_target_ordinal ? batchByOrdinal.get(effectiveDecision.merge_target_ordinal) || null : null;
    const targetIsSelf = effectiveDecision.merge_target_ordinal != null && target === row;
    if ((!effectiveDecision.merge_target_prospect_id && !target) || targetIsSelf) {
      return applyFinalQualityDecisionToOutcome(
        row,
        unresolvedMergeTargetDecision(effectiveDecision),
        batchId,
        batchByOrdinal
      );
    }
  }
  const targetName = finalQualityDecisionTargetName(effectiveDecision, row, batchByOrdinal);
  const originalName = row.mention.canonicalName;
  const renamed = Boolean(targetName && normalizeProspectName(targetName) !== row.mention.normalizedName);
  const merged = effectiveDecision.decision === 'merge_into_record';
  const mergeTarget = merged && effectiveDecision.merge_target_ordinal ? batchByOrdinal.get(effectiveDecision.merge_target_ordinal) || null : null;
  const mergeTargetRecordKey = mergeTarget ? finalQualityRecordKey(mergeTarget) : null;
  const finalQualityGate = {
    applied: true,
    batch_id: batchId,
    decision: effectiveDecision.decision,
    reason: effectiveDecision.reason,
    canonical_name: targetName,
    original_name: originalName,
    merge_target_ordinal: effectiveDecision.merge_target_ordinal,
    merge_target_prospect_id: effectiveDecision.merge_target_prospect_id,
    merge_target_record_key: mergeTargetRecordKey,
    resolved_merge_target_prospect_id: effectiveDecision.merge_target_prospect_id,
    merge_target_resolved: Boolean(effectiveDecision.merge_target_prospect_id),
    blocked: effectiveDecision.decision === 'block_create',
    renamed,
    merged,
    attach_only: merged,
    fallback_used: effectiveDecision.fallback_used === true,
    failed_open: effectiveDecision.failed_open === true,
    parse_failed: effectiveDecision.parse_failed === true,
    retry_used: effectiveDecision.retry_used === true,
    fallback_basis: effectiveDecision.fallback_basis || null,
    target_proof: effectiveDecision.target_proof || [],
    hard_block_reason: effectiveDecision.hard_block_reason || null,
    batch_size: typeof effectiveDecision.batch_size === 'number' ? effectiveDecision.batch_size : null,
    duplicate_group_id: finalQualityPrimaryDuplicateGroupId(row),
    record_key: finalQualityRecordKey(row),
    model: effectiveDecision.model,
    usage: effectiveDecision.usage || null,
    cache_hit: effectiveDecision.cache_hit === true,
  };
  if (effectiveDecision.decision === 'block_create') {
    const finalizationGate = row.cls.metadata.prospect_finalization_gate as { reasons?: unknown } | undefined;
    const reasons = Array.isArray(finalizationGate?.reasons)
      ? finalizationGate.reasons.map(reason => String(reason || '')).filter(Boolean)
      : [];
    appendUnique(reasons, 'final_quality_gate_blocked');
    return {
      ...row,
      cls: {
        ...row.cls,
        mentionType: 'noise',
        prospectAction: 'record_context',
        shouldCreateProspect: false,
        prospectCompanyName: null,
        possibleCompanyId: null,
        possibleDealId: null,
        linkedDealId: null,
        provisional: false,
        directionUncertain: false,
        metadata: {
          ...row.cls.metadata,
          prospect_final_quality_gate: finalQualityGate,
          prospect_finalization_gate: {
            ...(row.cls.metadata.prospect_finalization_gate as Record<string, unknown> | undefined || {}),
            final: false,
            blocked: true,
            reasons,
          },
          prospect_action: 'record_context',
          should_create_prospect: false,
          prospect_company_name: null,
          context_signal: true,
          final_quality_block_reason: effectiveDecision.reason,
        },
      },
    };
  }

  const nextMention = targetName ? mentionWithFinalQualityCanonicalName(row.mention, targetName) : row.mention;
  const finalProspectCompanyName = targetName || row.cls.prospectCompanyName || nextMention.canonicalName;
  if (merged) {
    return {
      ...row,
      mention: nextMention,
      cls: {
        ...row.cls,
        mentionType: 'inbound_prospect',
        prospectAction: 'record_context',
        shouldCreateProspect: false,
        prospectCompanyName: finalProspectCompanyName,
        provisional: false,
        directionUncertain: false,
        metadata: {
          ...row.cls.metadata,
          prospect_final_quality_gate: finalQualityGate,
          prospect_company_name: finalProspectCompanyName,
          prospect_action: 'record_context',
          should_create_prospect: false,
          context_signal: true,
          final_quality_attach_only: true,
          corrected_prospect_company_name: finalProspectCompanyName !== (row.cls.metadata.original_llm_prospect_company_name || originalName)
            ? finalProspectCompanyName
            : row.cls.metadata.corrected_prospect_company_name || null,
        },
      },
    };
  }
  return {
    ...row,
    mention: nextMention,
    cls: {
      ...row.cls,
      prospectCompanyName: finalProspectCompanyName,
      metadata: {
        ...row.cls.metadata,
        prospect_final_quality_gate: finalQualityGate,
        prospect_company_name: finalProspectCompanyName,
        corrected_prospect_company_name: finalProspectCompanyName !== (row.cls.metadata.original_llm_prospect_company_name || originalName)
          ? finalProspectCompanyName
          : row.cls.metadata.corrected_prospect_company_name || null,
      },
    },
  };
}

async function applyProspectFinalQualityGate(
  orgId: string,
  env: Env,
  rows: RecordableProspectOutcome[],
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites' | 'stats'> = {}
): Promise<RecordableProspectOutcome[]> {
  if (!rows.some(row => row.cls.shouldCreateProspect)) return rows;
  const updated = new Map<RecordableProspectOutcome, RecordableProspectOutcome>();
  for (const batch of finalQualityBatchRows(rows)) {
    if (batch.length === 0) continue;
    if (options.stats) {
      options.stats.final_quality_gate_batches++;
      options.stats.final_quality_gate_reviewed += batch.length;
    }
    const result = await callProspectFinalQualityGate(orgId, env, batch, rows, options);
    const batchByOrdinal = new Map(batch.map((row, index) => [index + 1, row]));
    const decisions = mergeDuplicateFinalQualityBatchDecisions(batch, result.decisions, batchByOrdinal);
    for (const decision of decisions) {
      const row = batchByOrdinal.get(decision.record_ordinal);
      if (!row) continue;
      const applied = applyFinalQualityDecisionToOutcome(row, decision, result.batchId, batchByOrdinal);
      if (options.stats) {
        const appliedGate = applied.cls.metadata.prospect_final_quality_gate as Record<string, unknown> | undefined;
        const appliedDecision = typeof appliedGate?.decision === 'string' ? appliedGate.decision : decision.decision;
        if (appliedDecision === 'allow_create') options.stats.final_quality_gate_allowed++;
        if (appliedDecision === 'rename_and_allow') options.stats.final_quality_gate_renamed++;
        if (appliedDecision === 'merge_into_record') options.stats.final_quality_gate_merged++;
        if (appliedDecision === 'block_create') options.stats.final_quality_gate_blocked++;
        if (decision.decision === 'merge_into_record' && appliedDecision === 'block_create') {
          options.stats.final_quality_gate_merge_unresolved++;
        }
        if (decision.fallback_used) options.stats.final_quality_gate_fallback_used++;
        if (decision.failed_open) options.stats.final_quality_gate_failed_open++;
      }
      updated.set(row, applied);
    }
  }
  return rows.map(row => updated.get(row) || row);
}

export async function prewarmProspectOrgExtractionPromptCache(
  orgId: string,
  env: Env,
  mode: 'all_organizations' | 'target_recovery' = 'all_organizations',
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites'> = {}
): Promise<{ usage: ClaudeUsage; model: string; stop_reason?: string }> {
  const prompt = buildOrgExtractionPrompt({
    orgId,
    mode,
    sourceContext: mode === 'target_recovery'
      ? 'Prompt cache warmup for target recovery from a venture dealflow source.'
      : 'Prompt cache warmup for organization extraction from a venture dealflow source.',
    cleanedText: 'Warmup Company is raising a seed round and sent Medina Ventures a pitch deck for review.',
  });
  return prewarmClaudePromptCache({
    system: prompt.system,
    user: 'warmup',
    orgId,
    model: orgExtractionModel(env),
    dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
  }, 'low', env);
}

export async function prewarmProspectReasoningJudgePromptCache(
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites'> = {}
): Promise<{ usage: ClaudeUsage; model: string; stop_reason?: string }> {
  const item = {
    type: 'email',
    entityType: 'conversation',
    entityId: 'prospect-reasoning-judge-cache-warmup',
    subject: 'Warmup Company seed pitch',
    bodyText: 'Warmup Company is raising a seed round and sent a pitch deck.',
    bodyPreview: 'Warmup Company seed pitch.',
    sentAt: new Date(0).toISOString(),
  } as ClassifiedItem;
  const mention = {
    raw: 'Warmup Company',
    canonicalName: 'Warmup Company',
    normalizedName: 'warmupcompany',
    mentionOrdinal: 1,
    spanStart: null,
    spanEnd: null,
    lineText: 'Warmup Company is raising a seed round.',
    contextText: 'Warmup Company is raising a seed round and sent a pitch deck.',
    isListEntry: false,
    products: [],
  } as MentionCandidate;
  const classifierInput: ProspectClassifierInput = {
    sourceType: 'conversation',
    senderAndContext: 'Prompt cache warmup for prospect reasoning judge.',
    companyName: 'Warmup Company',
    rawExcerpt: 'Warmup Company is raising a seed round and sent a pitch deck.',
    prefilterHints: { mention: { mention_ordinal: 1 }, warmup: true },
    sectorHints: { key: 'ai_data', confidence: 0.8 },
    knownContext: emptyProspectClassifierKnownContext(),
    orgId,
  };
  const prompt = buildProspectReasoningJudgePrompt({
    item,
    mention,
    classifierInput,
    existing: emptyExistingContext('warmupcompany.ai'),
    llm: {
      mentionType: 'inbound_prospect',
      prospectAction: 'create_prospect',
      isProspect: true,
      prospectCompanyName: 'Warmup Company',
      direction: 'inbound',
      sectorKey: 'ai_data',
      sectorConfidence: 0.8,
      confidence: 0.95,
      reasoning: 'Warmup Company is raising a seed round and sent a pitch deck.',
      model: prospectReasoningJudgeModel(env),
    },
    hasCreateEvidence: true,
    confidenceTier: 'high',
    finalProspectCompanyName: 'Warmup Company',
    promotedToCreate: false,
    targetEvidenceReasons: ['current_company_investment_target_evidence'],
  });
  return prewarmClaudePromptCache({
    system: prompt.system,
    user: 'warmup',
    orgId,
    model: prospectReasoningJudgeModel(env),
    dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
  }, 'low', env);
}

export async function prewarmProspectFinalQualityGatePromptCache(
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites'> = {}
): Promise<{ usage: ClaudeUsage; model: string; stop_reason?: string }> {
  const item = {
    type: 'email',
    entityType: 'conversation',
    entityId: 'prospect-final-quality-gate-cache-warmup',
    subject: 'Warmup Company seed pitch',
    bodyText: 'Warmup Company is raising a seed round and sent Medina a pitch deck.',
    bodyPreview: 'Warmup Company seed pitch.',
    sentAt: new Date(0).toISOString(),
  } as ClassifiedItem;
  const mention = {
    raw: 'Warmup Company',
    canonicalName: 'Warmup Company',
    normalizedName: 'warmupcompany',
    mentionOrdinal: 1,
    spanStart: null,
    spanEnd: null,
    lineText: 'Warmup Company is raising a seed round.',
    contextText: 'Warmup Company is raising a seed round and sent Medina a pitch deck.',
    isListEntry: false,
    products: [],
  } as MentionCandidate;
  const cls: Classification = {
    direction: 'inbound',
    directionUncertain: false,
    mentionType: 'inbound_prospect',
    prospectAction: 'create_prospect',
    shouldCreateProspect: true,
    prospectCompanyName: 'Warmup Company',
    confidence: 0.95,
    confidenceTier: 'high',
    sectorKey: 'ai_data',
    sectorConfidence: 0.8,
    signalKind: 'deck',
    hasDeck: true,
    hasMeeting: false,
    hasWarmIntro: false,
    dealmakerName: null,
    possibleCompanyId: null,
    possibleDealId: null,
    linkedDealId: null,
    provisional: false,
    sampledForProduction: false,
    samplingReason: null,
    metadata: {
      llm_reasoning: 'Warmup Company is raising a seed round and sent Medina a pitch deck.',
      has_create_evidence: true,
      reasoning_judge: {
        action: 'allow_create',
        reason: 'Reasoning cites target-specific investment evidence present in the source.',
      },
      target_evidence_reasons: ['candidate_pitch_material_target'],
      prospect_second_look: {
        required: false,
        lane: null,
        recommended_action: 'none',
        reasons: [],
        evidence: ['candidate_pitch_material_target'],
        warnings: [],
        packet: {
          candidate_name: 'Warmup Company',
          prospect_company_name: 'Warmup Company',
          source_title: 'Warmup Company seed pitch',
          source_type: 'conversation',
          excerpt: 'Warmup Company is raising a seed round and sent Medina a pitch deck.',
          original_reasoning: 'Warmup Company is raising a seed round and sent Medina a pitch deck.',
          original_is_prospect: true,
          original_action: 'create_prospect',
          final_action: 'create_prospect',
          final_should_create: true,
          final_veto_reason: null,
          reasoning_judge_action: 'allow_create',
          reasoning_judge_reason: 'Reasoning cites target-specific investment evidence present in the source.',
          target_evidence_reasons: ['candidate_pitch_material_target'],
          known_entity: {
            company_id: null,
            deal_id: null,
            match_strength: 'none',
            identity_score: 0,
            identity_strength: 'none',
            identity_ambiguous: false,
          },
        },
      },
    },
  };
  const prompt = buildProspectFinalQualityGatePrompt({
    rows: [{
      row: {
        item,
        sourceType: 'conversation',
        mention,
        cls,
        existing: emptyExistingContext('warmupcompany.ai'),
        occurredAt: item.sentAt || new Date(0).toISOString(),
      },
      recordOrdinal: 1,
      neighborhood: {
        existingProspect: null,
        knownCompany: null,
        knownDeal: null,
        identityCandidates: [],
        recentSignals: [],
        historicalContextCount: 0,
        duplicateGroupId: 'fqg:warmupcompany',
        aliasKeys: ['warmupcompany'],
        deterministicHint: { suggested_action: 'clean_create', reasons: [] },
      },
    }],
    relatedRows: [],
  });
  return prewarmClaudePromptCache({
    system: prompt.system,
    user: 'warmup',
    orgId,
    model: prospectFinalQualityGateModel(env),
    dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
  }, 'low', env);
}

export async function prewarmProspectPipelinePromptCaches(
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites'> = {}
): Promise<void> {
  if (!shouldPrewarmProspectPromptCache(env)) return;
  const stages = [
    {
      name: 'source_classifier',
      model: prospectClassifierModel(env),
      run: () => prewarmProspectSourceClassifierPromptCache(orgId, env, options),
    },
    {
      name: 'org_extraction',
      model: orgExtractionModel(env),
      run: () => prewarmProspectOrgExtractionPromptCache(orgId, env, 'all_organizations', options),
    },
    {
      name: 'target_recovery',
      model: orgExtractionModel(env),
      run: () => prewarmProspectOrgExtractionPromptCache(orgId, env, 'target_recovery', options),
    },
    {
      name: 'reasoning_judge',
      model: prospectReasoningJudgeModel(env),
      run: () => prewarmProspectReasoningJudgePromptCache(orgId, env, options),
    },
    {
      name: 'final_quality_gate',
      model: prospectFinalQualityGateModel(env),
      run: () => prewarmProspectFinalQualityGatePromptCache(orgId, env, options),
    },
  ];
  for (const stage of stages) {
    const key = `${orgId}:${stage.name}:${stage.model}`;
    if (prospectPromptPrewarmKeys.has(key)) continue;
    prospectPromptPrewarmKeys.add(key);
    await stage.run().catch(error => {
      console.warn('[prospect-intelligence] prompt prewarm failed', {
        org_id: orgId,
        stage: stage.name,
        model: stage.model,
        error: compactProspectBackfillError(error),
      });
    });
  }
}

async function classifyMention(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  knownContext: ProspectClassifierKnownContext,
  orgId: string,
  env: Env,
  options: Pick<
    ProspectClassifierRuntimeOptions,
    | 'dryRunNoBudgetWrites'
    | 'llmDecision'
    | 'classifierInput'
    | 'sourceClassifierMode'
    | 'sourceClassifierFallbackReason'
    | 'sourceClassifierBatchCacheHit'
    | 'sourceClassifierBatchPaidCall'
    | 'sourceClassifierBatchPartialReason'
    | 'stats'
  > = {}
): Promise<Classification> {
  const prefilter = buildClassifierPrefilter(item, mention, existing, env);
  const classifierInput = options.classifierInput || classifierInputForRuntime(item, mention, existing, prefilter, knownContext, orgId);
  const deterministicGateSenderAndContext = senderAndContextForDeterministicGates(item, classifierInput.senderAndContext);
  const llm = options.llmDecision || await callProspectClassifier(classifierInput, env, {
    dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
  });
  const targetEvidenceReasons = candidateProspectTargetEvidenceReasons(
    [classifierInput.senderAndContext, classifierInput.rawExcerpt].join('\n'),
    llm.reasoning,
    mention
  );
  const llmValuableActionVeto = prospectValuableActionVetoForMention({
    prospectAction: llm.prospectAction,
    companyName: mention.canonicalName,
    rawMention: mention.raw,
    rawExcerpt: classifierInput.rawExcerpt,
    senderAndContext: deterministicGateSenderAndContext,
    prospectCompanyName: llm.prospectCompanyName,
    llmReasoning: llm.reasoning,
  });
  const portfolio = existing.relationshipStates.includes('current_portfolio') || existing.relationshipStates.includes('exited');
  let directionUncertain =
    prefilter.deterministicDirection !== 'unknown' &&
    prefilter.deterministicDirection !== llm.direction;
  let effectiveConfidence = directionUncertain
    ? Math.min(llm.confidence, 0.54)
    : llm.confidence;

  let possibleCompanyId: string | null = null;
  let possibleDealId: string | null = null;
  let linkedDealId: string | null = null;
  let mentionType = llm.mentionType;
  let prospectAction = llm.prospectAction;
  const contextTargetRepairApplied = hasClassifierContradictoryTargetIntent(llm, classifierInput, mention);
  if (contextTargetRepairApplied) {
    mentionType = 'inbound_prospect';
    prospectAction = 'create_prospect';
  }
  let shouldCreateProspect = prospectAction === 'create_prospect';
  let confidenceTier = confidenceTierFor(effectiveConfidence);
  let provisional = confidenceTier === 'low' || directionUncertain;
  let createProspectVetoApplied = false;
  let createProspectVetoReason: string | null = null;
  let valuableActionVetoApplied = false;
  let valuableActionVetoReason: string | null = null;
  let reasoningJudge: ProspectReasoningJudgeDecision | null = null;
  let reasoningJudgeBlockedProspectName: string | null = null;
  let crossD1RoleCheck: CrossD1CompanyRoleCheck = emptyCrossD1CompanyRoleCheck('not_evaluated');
  let lowConfidenceVerification: LowConfidenceProspectVerification = emptyLowConfidenceProspectVerification('not_evaluated');
  const exactDealDomainMatch = Boolean(existing.dealId && existing.matchStrength === 'domain');

  if (prospectAction === 'attach_existing_deal') {
    mentionType = 'noise';
    prospectAction = 'record_context';
    shouldCreateProspect = false;
    linkedDealId = existing.dealId && existing.matchStrength !== 'name' ? existing.dealId : null;
  }

  const valuableActionVeto = prospectValuableActionVetoForMention({
    prospectAction,
    companyName: mention.canonicalName,
    rawMention: mention.raw,
    rawExcerpt: classifierInput.rawExcerpt,
    senderAndContext: deterministicGateSenderAndContext,
    prospectCompanyName: llm.prospectCompanyName,
    llmReasoning: llm.reasoning,
  });
  const effectiveVeto = valuableActionVeto.applied ? valuableActionVeto : llmValuableActionVeto;

  if (prospectAction === 'create_prospect' && effectiveVeto.applied) {
    const vetoedProspectAction = prospectAction;
    mentionType = 'noise';
    prospectAction = effectiveVeto.nonValuableAction || 'ignore';
    shouldCreateProspect = false;
    possibleCompanyId = null;
    possibleDealId = null;
    linkedDealId = null;
    provisional = false;
    directionUncertain = false;
    effectiveConfidence = effectiveVeto.confidence || 0.97;
    valuableActionVetoApplied = true;
    valuableActionVetoReason = effectiveVeto.reason;
    if (llm.prospectAction === 'create_prospect' || vetoedProspectAction === 'create_prospect') {
      createProspectVetoApplied = true;
      createProspectVetoReason = effectiveVeto.reason;
    }
  }

  if (prospectAction === 'create_prospect') {
    crossD1RoleCheck = await classifyCompanyRoleFromD1(orgId, item, mention, existing, env, {
      prospectAction,
      confidence: effectiveConfidence,
      provisional,
      directionUncertain,
    });
    if (crossD1RoleCheck.action_override === 'record_context' || crossD1RoleCheck.action_override === 'ignore') {
      mentionType = 'noise';
      prospectAction = crossD1RoleCheck.action_override;
      shouldCreateProspect = false;
      possibleCompanyId = null;
      possibleDealId = null;
      linkedDealId = null;
      provisional = false;
      directionUncertain = false;
      effectiveConfidence = Math.max(effectiveConfidence, crossD1RoleCheck.confidence === 'authoritative' ? 0.96 : 0.88);
      createProspectVetoApplied = true;
      createProspectVetoReason = crossD1RoleCheck.reason;
      valuableActionVetoApplied = true;
      valuableActionVetoReason = crossD1RoleCheck.reason;
    } else if (crossD1RoleCheck.action_override === 'mark_provisional') {
      provisional = true;
      possibleCompanyId = crossD1RoleCheck.matched_company_id || possibleCompanyId;
      possibleDealId = crossD1RoleCheck.matched_deal_id || possibleDealId;
    }
  }

  if (prospectAction === 'create_prospect') {
    lowConfidenceVerification = verifyLowConfidenceProspect(item, mention, existing, prefilter, crossD1RoleCheck, env, {
      prospectAction,
      confidence: effectiveConfidence,
      provisional,
      directionUncertain,
    });

    if (lowConfidenceVerification.action_override === 'record_context' || lowConfidenceVerification.action_override === 'ignore') {
      mentionType = 'noise';
      prospectAction = lowConfidenceVerification.action_override;
      shouldCreateProspect = false;
      possibleCompanyId = null;
      possibleDealId = null;
      linkedDealId = null;
      provisional = false;
      directionUncertain = false;
      createProspectVetoApplied = true;
      createProspectVetoReason = lowConfidenceVerification.reason;
      valuableActionVetoApplied = true;
      valuableActionVetoReason = lowConfidenceVerification.reason;
    } else if (lowConfidenceVerification.action_override === 'mark_provisional') {
      provisional = true;
    }
  }

  if (
    prospectAction === 'record_context' &&
    !createProspectVetoApplied &&
    hasFinalSelfContradictoryCreateSignal(llm, classifierInput, mention)
  ) {
    mentionType = 'inbound_prospect';
    prospectAction = 'create_prospect';
    shouldCreateProspect = true;
    possibleCompanyId = null;
    possibleDealId = null;
    linkedDealId = null;
    provisional = false;
    directionUncertain = false;
    effectiveConfidence = Math.max(effectiveConfidence, llm.confidence);
    createProspectVetoApplied = false;
    createProspectVetoReason = null;
    valuableActionVetoApplied = false;
    valuableActionVetoReason = null;
  }

  if (
    (llm.prospectAction === 'record_context' || llm.prospectAction === 'ignore') &&
    (prospectAction === 'record_context' || prospectAction === 'ignore') &&
    !createProspectVetoApplied &&
    !valuableActionVetoApplied &&
    hasExplicitTargetInvestmentSignal(llm, classifierInput, mention)
  ) {
    mentionType = 'inbound_prospect';
    prospectAction = 'create_prospect';
    shouldCreateProspect = true;
    linkedDealId = null;
    possibleCompanyId = null;
    possibleDealId = null;
    provisional = effectiveConfidence < LOW_CONFIDENCE_VERIFICATION_EXEMPT_CONFIDENCE;
    directionUncertain = false;
    effectiveConfidence = Math.max(effectiveConfidence, Math.min(llm.confidence, 0.92));
    createProspectVetoApplied = false;
    createProspectVetoReason = null;
    valuableActionVetoApplied = false;
    valuableActionVetoReason = null;
  }

  confidenceTier = confidenceTierFor(effectiveConfidence);
  const sampling = productionSamplingDecision({
    orgId,
    item,
    mention,
    confidenceTier,
    directionUncertain,
    env,
  });

  if (shouldCreateProspect) {
    possibleCompanyId = existing.companyId;
    possibleDealId = existing.dealId || null;
    if (possibleDealId) provisional = true;
  }

  const hasCreateEvidence = shouldCreateProspect && hasExplicitFinalCreateEvidence(
    item,
    mention,
    llm,
    classifierInput,
    lowConfidenceVerification
  );
  const nameOnlyKnownDealConflict = Boolean(possibleDealId && existing.dealId && existing.matchStrength === 'name');
  const finalizationBlocked = shouldCreateProspect &&
    (nameOnlyKnownDealConflict || (!hasCreateEvidence && (provisional || directionUncertain || confidenceTier === 'low')));
  const finalizationBlockReasons: string[] = [];
  if (finalizationBlocked) {
    if (nameOnlyKnownDealConflict) finalizationBlockReasons.push('name_only_known_deal_match');
    if (provisional) finalizationBlockReasons.push('provisional_after_verification');
    if (directionUncertain) finalizationBlockReasons.push('direction_uncertain');
    if (confidenceTier === 'low') finalizationBlockReasons.push('low_confidence_tier');
    mentionType = 'noise';
    prospectAction = 'record_context';
    shouldCreateProspect = false;
    possibleCompanyId = null;
    possibleDealId = null;
    linkedDealId = null;
    provisional = false;
    createProspectVetoApplied = true;
    createProspectVetoReason = finalizationBlockReasons.join(',') || 'not_finalized';
    valuableActionVetoApplied = true;
    valuableActionVetoReason = createProspectVetoReason;
  }

  let finalProspectCompanyName = shouldCreateProspect
    ? (
        correctedProspectCompanyNameFromEvidence(mention.canonicalName, llm.prospectCompanyName, classifierInput, llm.reasoning) ||
        llm.prospectCompanyName ||
        mention.canonicalName
      )
    : null;

  if (shouldCreateProspect) {
    reasoningJudge = await callProspectReasoningJudge({
      item,
      mention,
      classifierInput,
      existing,
      llm,
      hasCreateEvidence,
      confidenceTier,
      finalProspectCompanyName,
      promotedToCreate: contextTargetRepairApplied || (llm.prospectAction !== 'create_prospect' && prospectAction === 'create_prospect'),
      targetEvidenceReasons,
    }, env, {
      dryRunNoBudgetWrites: options.dryRunNoBudgetWrites,
      stats: options.stats,
    });
    const privatePitchDocumentTargetEvidence = hasPrivatePitchDocumentTargetEvidence(
      [
        deterministicGateContextForSource(item),
        classifierInput.senderAndContext,
        classifierInput.rawExcerpt,
        llm.reasoning,
      ].join('\n'),
      mention.canonicalName,
      finalProspectCompanyName || llm.prospectCompanyName
    );
    const directInvestorForwardedRoundEvidence = hasDirectInvestorForwardedRoundEvidence(
      item,
      mention,
      classifierInput,
      llm.reasoning
    );
    const structuredRowCreateEvidence =
      hasCandidateFundraisingListRowEvidence(
        [
          deterministicGateContextForSource(item),
          classifierInput.senderAndContext,
          classifierInput.rawExcerpt,
          mention.lineText,
        ].join('\n'),
        llm.reasoning,
        mention
      ) ||
      hasStructuredPipelineRowEvidence(
        [
          deterministicGateContextForSource(item),
          classifierInput.senderAndContext,
          classifierInput.rawExcerpt,
          mention.lineText,
        ].join('\n'),
        mention.canonicalName
      );
    const productParentCreateEvidence = hasProductPitchParentCompanyEvidence(
      [
        deterministicGateContextForSource(item),
        classifierInput.senderAndContext,
        classifierInput.rawExcerpt,
        mention.lineText,
      ].join('\n'),
      llm.reasoning,
      mention.canonicalName
    );
    if (
      reasoningJudge.action === 'block_create' &&
      privatePitchDocumentTargetEvidence &&
      /\b(?:no\s+evidence|not\s+clear|does\s+not\s+show|not\s+explicit(?:ly)?)\b[^.]{0,180}\b(?:sent|shared|pitched|presented|forwarded)\b[^.]{0,120}\b(?:Medina|the\s+fund)\b/i.test(reasoningJudge.reason)
    ) {
      reasoningJudge = {
        ...reasoningJudge,
        reasoning_valid: true,
        action: 'allow_create',
        confidence: Math.max(reasoningJudge.confidence, 0.86),
        reason: 'Private pipeline investment document names the candidate as the central target; explicit Medina-send language is not required.',
      };
    }
    if (
      reasoningJudge.action === 'block_create' &&
      privatePitchDocumentTargetEvidence &&
      /\b(?:borrower|issuer|seller|acquisition\s+target|financing\s+applicant|financing\s+recipient|company\s+being\s+financed|loan\s+recipient|letter\s+of\s+(?:interest|intent)|LOI)\b/i.test(reasoningJudge.reason)
    ) {
      reasoningJudge = {
        ...reasoningJudge,
        reasoning_valid: true,
        action: 'allow_create',
        confidence: Math.max(reasoningJudge.confidence, 0.86),
        reason: 'Private financing document names the candidate as the central company being financed or reviewed.',
      };
    }
    if (
      reasoningJudge.action === 'block_create' &&
      directInvestorForwardedRoundEvidence &&
      /\b(?:investor|source|announcement|announced|public|news|not\s+clearly|does\s+not\s+show|not\s+explicit(?:ly)?|sent|shared|pitched|presented|forwarded)\b/i.test(reasoningJudge.reason)
    ) {
      reasoningJudge = {
        ...reasoningJudge,
        reasoning_valid: true,
        action: 'allow_create',
        confidence: Math.max(reasoningJudge.confidence, 0.86),
        reason: 'Direct investor-forwarded round evidence names the candidate and includes concrete financing terms.',
      };
    }
    if (
      reasoningJudge.action === 'block_create' &&
      structuredRowCreateEvidence &&
      /\b(?:does\s+not\s+appear|not\s+appear|missing|not\s+visible|visible\s+entries|different\s+companies|neighboring\s+rows|template|list|fundraising\s+form)\b/i.test(reasoningJudge.reason)
    ) {
      reasoningJudge = {
        ...reasoningJudge,
        reasoning_valid: true,
        action: 'allow_create',
        confidence: Math.max(reasoningJudge.confidence, 0.86),
        reason: 'Structured list-row evidence names the candidate with fundraising details; neighboring rows in the excerpt should not block the row.',
      };
    }
    if (
      reasoningJudge.action === 'block_create' &&
      productParentCreateEvidence &&
      /\b(?:parent|inventor|company\s+behind|invented|built|developed|created|product\s+being\s+(?:pitched|presented)|product\s+target)\b/i.test(reasoningJudge.reason)
    ) {
      reasoningJudge = {
        ...reasoningJudge,
        reasoning_valid: true,
        action: 'allow_create',
        confidence: Math.max(reasoningJudge.confidence, 0.86),
        reason: 'Source names the candidate as the parent/inventor company behind the product being pitched to Medina.',
      };
    }
    if (reasoningJudge.action !== 'allow_create' || !reasoningJudge.reasoning_valid) {
      reasoningJudgeBlockedProspectName = finalProspectCompanyName;
      mentionType = 'noise';
      prospectAction = 'record_context';
      shouldCreateProspect = false;
      finalProspectCompanyName = null;
      possibleCompanyId = null;
      possibleDealId = null;
      linkedDealId = null;
      provisional = reasoningJudge.action === 'needs_review';
      directionUncertain = false;
      createProspectVetoApplied = true;
      createProspectVetoReason = `reasoning_judge_${reasoningJudge.action}`;
      valuableActionVetoApplied = true;
      valuableActionVetoReason = createProspectVetoReason;
      effectiveConfidence = reasoningJudge.confidence > 0 ? Math.min(effectiveConfidence, reasoningJudge.confidence) : effectiveConfidence;
      confidenceTier = confidenceTierFor(effectiveConfidence);
    }
  }

  const secondLook = buildProspectSecondLookPacket({
    item,
    mention,
    classifierInput,
    existing,
    llm,
    prospectAction,
    shouldCreateProspect,
    finalProspectCompanyName,
    effectiveConfidence,
    confidenceTier,
    provisional,
    directionUncertain,
    hasCreateEvidence,
    targetEvidenceReasons,
    createProspectVetoReason,
    valuableActionVetoReason,
    finalizationBlocked,
    finalizationBlockReasons,
    reasoningJudge,
    contextTargetRepairApplied,
    lowConfidenceVerification,
    crossD1RoleCheck,
  });
  const secondLookCreateBlockReason = acceptedSecondLookCreateBlockReason({
    secondLook,
    mention,
    llm,
    reasoningJudge,
  });
  const secondLookCreateBlocked = Boolean(secondLookCreateBlockReason && shouldCreateProspect);
  if (secondLookCreateBlocked) {
    reasoningJudgeBlockedProspectName = finalProspectCompanyName;
    mentionType = 'noise';
    prospectAction = 'record_context';
    shouldCreateProspect = false;
    finalProspectCompanyName = null;
    possibleCompanyId = null;
    possibleDealId = null;
    linkedDealId = null;
    provisional = false;
    directionUncertain = false;
    createProspectVetoApplied = true;
    createProspectVetoReason = secondLookCreateBlockReason;
    valuableActionVetoApplied = true;
    valuableActionVetoReason = secondLookCreateBlockReason;
  }
  const lowConfidenceCreateBlocked = Boolean(
    !shouldCreateProspect &&
    lowConfidenceVerification.checked &&
    (lowConfidenceVerification.action_override === 'record_context' || lowConfidenceVerification.action_override === 'ignore') &&
    createProspectVetoReason === lowConfidenceVerification.reason
  );
  const effectiveFinalizationBlocked = finalizationBlocked || secondLookCreateBlocked || lowConfidenceCreateBlocked;
  const effectiveFinalizationBlockReasons = Array.from(new Set([
    ...finalizationBlockReasons,
    ...(secondLookCreateBlocked ? ['second_look_create_blocked'] : []),
    ...(lowConfidenceCreateBlocked ? [lowConfidenceVerification.reason] : []),
  ])).filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);

  return {
    direction: llm.direction,
    directionUncertain,
    mentionType,
    prospectAction,
    shouldCreateProspect,
    prospectCompanyName: finalProspectCompanyName,
    confidence: effectiveConfidence,
    confidenceTier,
    sectorKey: llm.sectorKey,
    sectorConfidence: llm.sectorConfidence,
    signalKind: prefilter.signalKind,
    hasDeck: prefilter.hasDeck,
    hasMeeting: prefilter.hasMeeting,
    hasWarmIntro: prefilter.hasWarmIntro,
    dealmakerName: prefilter.hasWarmIntro ? normalizeWhitespace(item.fromName || item.fromEmail || '') : null,
    possibleCompanyId,
    possibleDealId,
    linkedDealId,
    provisional,
    sampledForProduction: sampling.sampled,
    samplingReason: sampling.reason,
    metadata: {
      classifier: 'llm_req_cl',
      classifier_model: llm.model,
      llm_is_prospect: llm.isProspect,
      llm_reasoning: llm.reasoning,
      llm_confidence: llm.confidence,
      effective_confidence: effectiveConfidence,
      llm_usage: llm.usage || null,
      create_prospect_veto_applied: createProspectVetoApplied,
      create_prospect_veto_reason: createProspectVetoReason,
      valuable_action_veto_applied: valuableActionVetoApplied,
      valuable_action_veto_reason: valuableActionVetoReason,
      cross_d1_role_check: crossD1RoleCheck,
      low_confidence_verification: lowConfidenceVerification,
      prospect_finalization_gate: {
        final: shouldCreateProspect,
        blocked: effectiveFinalizationBlocked,
        reasons: effectiveFinalizationBlockReasons,
      },
      has_create_evidence: hasCreateEvidence,
      known_entity_audit: knownEntityAuditContext({
        existing,
        llm,
        prospectAction,
        mentionType,
        shouldCreateProspect,
        possibleCompanyId,
        possibleDealId,
        linkedDealId,
        hasCreateEvidence,
        finalizationBlocked: effectiveFinalizationBlocked,
        finalizationBlockReasons: effectiveFinalizationBlockReasons,
        createProspectVetoReason,
        valuableActionVetoReason,
      }),
      source_classifier: {
        mode: options.sourceClassifierMode || (options.llmDecision ? 'source_batch' : 'single'),
        batch_cache_hit: options.sourceClassifierBatchCacheHit ?? null,
        batch_paid_call: options.sourceClassifierBatchPaidCall ?? null,
        batch_partial_reason: options.sourceClassifierBatchPartialReason || null,
        fallback_reason: options.sourceClassifierFallbackReason || null,
      },
      reasoning_judge: reasoningJudge ? {
        reasoning_valid: reasoningJudge.reasoning_valid,
        action: reasoningJudge.action,
        confidence: reasoningJudge.confidence,
        reason: reasoningJudge.reason,
        model: reasoningJudge.model,
        usage: reasoningJudge.usage || null,
        cache_hit: reasoningJudge.cache_hit === true,
        blocked_prospect_company_name: reasoningJudgeBlockedProspectName,
      } : {
        action: 'not_evaluated',
      },
      prospect_second_look: secondLook,
      second_look_create_blocked: secondLookCreateBlocked,
      second_look_block_reason: secondLookCreateBlockReason,
      target_evidence_reasons: targetEvidenceReasons,
      context_target_repair_applied: contextTargetRepairApplied,
      original_llm_prospect_action: llm.prospectAction,
      original_llm_is_prospect: llm.isProspect,
      original_llm_reasoning: llm.reasoning,
      prospect_action: prospectAction,
      should_create_prospect: shouldCreateProspect,
      prospect_company_name: finalProspectCompanyName,
      corrected_prospect_company_name: finalProspectCompanyName !== (llm.prospectCompanyName || mention.canonicalName) ? finalProspectCompanyName : null,
      context_signal: prospectAction === 'record_context',
      prefilter,
      products: mention.products,
      list_fields: mention.listFields || null,
      from_domain: emailDomain(item.fromEmail),
      source_direction: item.direction || null,
      deterministic_direction: prefilter.deterministicDirection,
      deterministic_direction_disagreed: directionUncertain,
      deterministic_portfolio_hint: portfolio,
      firewall: {
        req: 'REQ-ID-5',
        exact_deal_domain_match: exactDealDomainMatch,
        linked_deal_id: linkedDealId,
        weak_deal_match_held_as_soft_link: Boolean(possibleDealId),
        original_llm_prospect_action: llm.prospectAction,
        derived_mention_type: mentionType,
      },
      confidence_tier_routing: {
        req: 'REQ-VAL-5',
        tier: confidenceTier,
        provisional,
        production_sampled: sampling.sampled,
        sampling_reason: sampling.reason,
      },
    },
  };
}

function prospectSourceType(item: ClassifiedItem): SourceType | null {
  if (item.entityType === 'event') return 'event';
  if (item.entityType === 'conversation') return 'conversation';
  if ((item as any).entityType === 'document') return 'document';
  return null;
}

interface ProspectIdentityRow {
  id: string;
  canonical_name: string;
  normalized_name: string;
  domain: string | null;
  website: string | null;
  status: string | null;
  signal_count: number | null;
  evidence_count: number | null;
  created_at: string | null;
  possible_duplicate_of?: string | null;
}

interface ProspectIdentityMatch {
  prospect: ProspectIdentityRow;
  score: number;
  method: string;
}

function prospectRowDomain(row: Pick<ProspectIdentityRow, 'domain' | 'website'>): string | null {
  return String(row.domain || '').trim().toLowerCase().replace(/^www\./, '') || domainFromUrl(row.website);
}

function prospectIdentityAliasesForRow(row: Pick<ProspectIdentityRow, 'canonical_name' | 'normalized_name' | 'domain' | 'website'>): Set<string> {
  const aliases = prospectIdentityAliasesForName(row.canonical_name);
  for (const alias of identityAliasVariants(row.normalized_name)) aliases.add(alias);
  const domain = prospectRowDomain(row);
  if (domain) {
    for (const alias of prospectIdentityAliasesForName(domainLabelToCompany(domain))) aliases.add(alias);
  }
  return aliases;
}

function scoreProspectIdentityMatch(mention: MentionCandidate, row: ProspectIdentityRow, env?: Env): ProspectIdentityMatch | null {
  const mentionDomain = firstProspectDomainForMention(mention, env);
  const rowDomain = prospectRowDomain(row);
  if (mention.normalizedName === row.normalized_name) {
    return { prospect: row, score: 1, method: 'exact_normalized_name' };
  }
  if (mentionDomain && rowDomain && mentionDomain === rowDomain) {
    return { prospect: row, score: 1, method: 'exact_domain' };
  }
  const mentionAliases = prospectIdentityAliasesForMention(mention, env);
  const rowAliases = prospectIdentityAliasesForRow(row);
  if (setsIntersect(mentionAliases, rowAliases)) {
    const score = mentionDomain || rowDomain || mentionLooksDomainDerived(mention, env) ? 0.94 : 0.92;
    return { prospect: row, score, method: mentionDomain || rowDomain ? 'domain_brand_alias' : 'aggressive_name_alias' };
  }
  const a = mention.normalizedName;
  const b = row.normalized_name;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 6 && (a.includes(b) || b.includes(a))) {
    return { prospect: row, score: 0.89, method: 'substring_name_alias' };
  }
  return null;
}

function prospectIdentityWinnerRank(row: ProspectIdentityRow): number {
  const statusScore = row.status === 'converted' ? 40 : row.status === 'active' ? 30 : row.status === 'provisional' ? 20 : 0;
  const duplicatePenalty = row.possible_duplicate_of ? -10 : 0;
  return statusScore + Number(row.signal_count || 0) * 3 + Number(row.evidence_count || 0) * 2 + duplicatePenalty;
}

function chooseBetterProspectIdentityMatch(left: ProspectIdentityMatch | null, right: ProspectIdentityMatch | null): ProspectIdentityMatch | null {
  if (!left) return right;
  if (!right) return left;
  if (right.score > left.score) return right;
  if (left.score > right.score) return left;
  const rankDiff = prospectIdentityWinnerRank(right.prospect) - prospectIdentityWinnerRank(left.prospect);
  if (rankDiff > 0) return right;
  if (rankDiff < 0) return left;
  const leftCreated = left.prospect.created_at || '';
  const rightCreated = right.prospect.created_at || '';
  return rightCreated && (!leftCreated || rightCreated < leftCreated) ? right : left;
}

function scoreProspectRowDuplicate(left: ProspectIdentityRow, right: ProspectIdentityRow): { score: number; method: string } | null {
  if (left.normalized_name === right.normalized_name) return { score: 1, method: 'exact_normalized_name' };
  const leftDomain = prospectRowDomain(left);
  const rightDomain = prospectRowDomain(right);
  if (leftDomain && rightDomain && leftDomain === rightDomain) return { score: 1, method: 'exact_domain' };
  const leftAliases = prospectIdentityAliasesForRow(left);
  const rightAliases = prospectIdentityAliasesForRow(right);
  if (setsIntersect(leftAliases, rightAliases)) {
    return { score: leftDomain || rightDomain ? 0.94 : 0.92, method: leftDomain || rightDomain ? 'domain_brand_alias' : 'aggressive_name_alias' };
  }
  const minLen = Math.min(left.normalized_name.length, right.normalized_name.length);
  if (minLen >= 6 && (left.normalized_name.includes(right.normalized_name) || right.normalized_name.includes(left.normalized_name))) {
    return { score: 0.89, method: 'substring_name_alias' };
  }
  return null;
}

function shouldPreferProspectIdentityWinner(candidate: ProspectIdentityRow, current: ProspectIdentityRow): boolean {
  const rankDiff = prospectIdentityWinnerRank(candidate) - prospectIdentityWinnerRank(current);
  if (rankDiff !== 0) return rankDiff > 0;
  const candidateCreated = candidate.created_at || '';
  const currentCreated = current.created_at || '';
  if (candidateCreated && currentCreated && candidateCreated !== currentCreated) return candidateCreated < currentCreated;
  return candidate.id < current.id;
}

function bestDuplicateWinnerForProspect(row: ProspectIdentityRow, rows: ProspectIdentityRow[]): { winner: ProspectIdentityRow; score: number; method: string } | null {
  let best: { winner: ProspectIdentityRow; score: number; method: string } | null = null;
  for (const candidate of rows) {
    if (candidate.id === row.id) continue;
    const score = scoreProspectRowDuplicate(row, candidate);
    if (!score || score.score < 0.92) continue;
    if (!shouldPreferProspectIdentityWinner(candidate, row)) continue;
    if (!best || score.score > best.score || (score.score === best.score && shouldPreferProspectIdentityWinner(candidate, best.winner))) {
      best = { winner: candidate, score: score.score, method: score.method };
    }
  }
  return best;
}

async function findExistingProspectIdentityMatch(
  orgId: string,
  mention: MentionCandidate,
  env: Env
): Promise<ProspectIdentityMatch | null> {
  const aliases = Array.from(prospectIdentityAliasesForMention(mention, env)).filter(alias => alias.length >= 3).slice(0, 8);
  const domain = firstProspectDomainForMention(mention, env);
  const clauses: string[] = [];
  const binds: unknown[] = [orgId];
  if (aliases.length > 0) {
    clauses.push(`normalized_name IN (${aliases.map(() => '?').join(', ')})`);
    binds.push(...aliases);
  }
  if (domain) {
    clauses.push(`lower(domain) = lower(?)`);
    binds.push(domain);
    clauses.push(`lower(website) LIKE ?`);
    binds.push(`%${domain.toLowerCase()}%`);
  }
  if (clauses.length === 0) return null;
  const rows = await env.D1.prepare(
    `SELECT id, canonical_name, normalized_name, domain, website, status, signal_count, evidence_count, created_at, possible_duplicate_of
       FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND status IN ('active','provisional','converted')
        AND (${clauses.join(' OR ')})
      ORDER BY signal_count DESC, evidence_count DESC, created_at ASC
      LIMIT 25`
  ).bind(...binds).all<ProspectIdentityRow>();

  const collected = new Map<string, ProspectIdentityRow>();
  const aliasMatchedIds = new Set<string>();
  for (const row of rows.results || []) collected.set(row.id, row);
  try {
    const aliasValues = new Set<string>(aliases);
    if (domain) {
      aliasValues.add(domain);
      aliasValues.add(normalizeProspectName(domainLabelToCompany(domain)));
    }
    const aliasList = Array.from(aliasValues).filter(value => value.length >= 3).slice(0, 16);
    if (aliasList.length > 0) {
      const aliasRows = await env.D1.prepare(
        `SELECT entity_id
           FROM entity_identity_aliases
          WHERE org_id = ?
            AND entity_type = 'prospect'
            AND alias_value IN (${aliasList.map(() => '?').join(', ')})
          ORDER BY confidence DESC, updated_at DESC
          LIMIT 25`
      ).bind(orgId, ...aliasList).all<{ entity_id: string }>();
      const prospectIds = Array.from(new Set((aliasRows.results || []).map(row => row.entity_id).filter(Boolean)));
      for (const id of prospectIds) aliasMatchedIds.add(id);
      if (prospectIds.length > 0) {
        const aliasProspects = await env.D1.prepare(
          `SELECT id, canonical_name, normalized_name, domain, website, status, signal_count, evidence_count, created_at, possible_duplicate_of
             FROM prospects
            WHERE org_id = ? AND deleted_at IS NULL
              AND status IN ('active','provisional','converted')
              AND id IN (${prospectIds.map(() => '?').join(', ')})
            LIMIT 25`
        ).bind(orgId, ...prospectIds).all<ProspectIdentityRow>();
        for (const row of aliasProspects.results || []) collected.set(row.id, row);
      }
    }
  } catch (error) {
    if (!/entity_identity_aliases|no such table|D1_ERROR/i.test(error instanceof Error ? error.message : String(error || ''))) throw error;
  }

  let best: ProspectIdentityMatch | null = null;
  for (const row of collected.values()) {
    const match = scoreProspectIdentityMatch(mention, row, env) ||
      (aliasMatchedIds.has(row.id) ? { prospect: row, score: 0.94, method: 'manual_identity_alias' } : null);
    if (match && match.score >= 0.92) best = chooseBetterProspectIdentityMatch(best, match);
  }
  return best;
}

function prospectIdentityWebsiteForDomain(domain: string | null): string | null {
  return domain ? `https://${domain}` : null;
}

function companyNameMatchConflictsWithSourceDomain(
  company: { name: string; domain: string | null },
  mention: MentionCandidate,
  mentionDomain: string | null
): boolean {
  if (!mentionDomain || !company.domain) return false;
  const companyDomain = company.domain.toLowerCase().replace(/^www\./, '');
  if (companyDomain === mentionDomain) return false;
  const normalized = normalizeProspectName(company.name);
  if (normalized.length >= 6) return false;
  return normalizeProspectName(company.name) === mention.normalizedName;
}

function chooseCanonicalProspectName(existingName: string, mention: MentionCandidate, env?: Env): string {
  if (mentionLooksDomainDerived(mention, env)) return existingName;
  const existingNormalized = normalizeProspectName(existingName);
  if (!existingNormalized || isGenericCandidate(existingName)) return mention.canonicalName;
  if (mention.canonicalName.length > existingName.length && !/\.[a-z]{2,}\b/i.test(mention.canonicalName)) {
    return mention.canonicalName;
  }
  return existingName;
}

async function updateProspectIdentityEvidence(
  orgId: string,
  prospectId: string,
  mention: MentionCandidate,
  cls: Classification,
  occurredAt: string,
  env: Env,
  match?: ProspectIdentityMatch | null
): Promise<void> {
  const domain = firstProspectDomainForMention(mention, env);
  const website = prospectIdentityWebsiteForDomain(domain);
  const metadata = {
    prospect_action: cls.prospectAction,
    prospect_company_name: cls.prospectCompanyName,
    identity_dedupe: {
      req: 'REQ-ID-8',
      domain,
      aliases: Array.from(prospectIdentityAliasesForMention(mention, env)).slice(0, 12),
      matched_existing_prospect_id: match?.prospect.id || null,
      method: match?.method || 'self',
      score: match?.score || null,
    },
  };

  await env.D1.prepare(
    `UPDATE prospects
        SET domain = COALESCE(domain, ?),
            website = COALESCE(website, ?),
            last_seen_at = CASE
              WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ?
              ELSE last_seen_at
            END,
            last_signal_at = CASE
              WHEN last_signal_at IS NULL OR ? > last_signal_at THEN ?
              ELSE last_signal_at
            END,
            confidence = MAX(confidence, ?),
            metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    domain,
    website,
    occurredAt,
    occurredAt,
    occurredAt,
    occurredAt,
    cls.confidence,
    JSON.stringify(metadata),
    prospectId,
    orgId
  ).run();

  await upsertEntityIdentityAliases({
    orgId,
    entityType: 'prospect',
    entityId: prospectId,
    name: mention.canonicalName,
    normalizedName: mention.normalizedName,
    domain,
    website,
    sourceKind: 'classifier',
    evidence: {
      source: 'prospect_identity_evidence',
      prospect_action: cls.prospectAction,
      occurred_at: occurredAt,
      match_method: match?.method || 'self',
      match_score: match?.score || null,
    },
  }, env);
}

async function upsertProspect(
  orgId: string,
  mention: MentionCandidate,
  cls: Classification,
  occurredAt: string,
  env: Env
): Promise<string> {
  const identityMatch = await findExistingProspectIdentityMatch(orgId, mention, env);
  if (identityMatch?.prospect.id) {
    const canonicalName = chooseCanonicalProspectName(identityMatch.prospect.canonical_name, mention, env);
    await env.D1.prepare(
      `UPDATE prospects
          SET canonical_name = ?,
              status = CASE
                WHEN status IN ('active','converted') THEN status
                WHEN ? = 0 THEN 'active'
                ELSE 'provisional'
              END,
              sector_key = CASE
                WHEN sector_key = 'uncategorized' OR ? > sector_confidence THEN ?
                ELSE sector_key
              END,
              sector_confidence = MAX(sector_confidence, ?),
              provisional = CASE
                WHEN status IN ('active','converted') THEN 0
                WHEN ? = 0 THEN 0
                ELSE 1
              END,
              direction_uncertain = CASE WHEN ? = 1 THEN 1 ELSE direction_uncertain END,
              possible_company_id = COALESCE(possible_company_id, ?),
              possible_deal_id = COALESCE(possible_deal_id, ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      canonicalName,
      cls.provisional ? 1 : 0,
      cls.sectorConfidence,
      cls.sectorKey,
      cls.sectorConfidence,
      cls.provisional ? 1 : 0,
      cls.directionUncertain ? 1 : 0,
      cls.possibleCompanyId,
      cls.possibleDealId,
      identityMatch.prospect.id,
      orgId
    ).run();
    await updateProspectIdentityEvidence(orgId, identityMatch.prospect.id, mention, cls, occurredAt, env, identityMatch);
    return identityMatch.prospect.id;
  }

  const id = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospects (
       id, org_id, canonical_name, normalized_name, status, visibility,
       sector_key, sector_confidence, first_seen_at, last_seen_at, last_signal_at,
       signal_strength_reasons, confidence, provisional, direction_uncertain,
       possible_company_id, possible_deal_id, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, 'firm',
       ?, ?, ?, ?, ?,
       '[]', ?, ?, ?,
       ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, normalized_name) WHERE deleted_at IS NULL DO UPDATE SET
       canonical_name = CASE
         WHEN length(excluded.canonical_name) > length(prospects.canonical_name) THEN excluded.canonical_name
         ELSE prospects.canonical_name
       END,
       status = CASE
         WHEN prospects.status IN ('active','converted') THEN prospects.status
         WHEN excluded.provisional = 0 THEN 'active'
         ELSE 'provisional'
       END,
       sector_key = CASE
         WHEN prospects.sector_key = 'uncategorized' OR excluded.sector_confidence > prospects.sector_confidence THEN excluded.sector_key
         ELSE prospects.sector_key
       END,
       sector_confidence = MAX(prospects.sector_confidence, excluded.sector_confidence),
       first_seen_at = CASE
         WHEN prospects.first_seen_at IS NULL OR excluded.first_seen_at < prospects.first_seen_at THEN excluded.first_seen_at
         ELSE prospects.first_seen_at
       END,
       last_seen_at = CASE
         WHEN prospects.last_seen_at IS NULL OR excluded.last_seen_at > prospects.last_seen_at THEN excluded.last_seen_at
         ELSE prospects.last_seen_at
       END,
       last_signal_at = CASE
         WHEN prospects.last_signal_at IS NULL OR excluded.last_signal_at > prospects.last_signal_at THEN excluded.last_signal_at
         ELSE prospects.last_signal_at
       END,
       confidence = MAX(prospects.confidence, excluded.confidence),
       provisional = CASE
         WHEN prospects.status IN ('active','converted') THEN 0
         WHEN excluded.provisional = 0 THEN 0
         ELSE 1
       END,
       direction_uncertain = CASE WHEN excluded.direction_uncertain = 1 THEN 1 ELSE prospects.direction_uncertain END,
       possible_company_id = COALESCE(prospects.possible_company_id, excluded.possible_company_id),
       possible_deal_id = COALESCE(prospects.possible_deal_id, excluded.possible_deal_id),
       metadata_json = json_patch(COALESCE(prospects.metadata_json, '{}'), excluded.metadata_json),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    id,
    orgId,
    mention.canonicalName,
    mention.normalizedName,
    cls.provisional ? 'provisional' : 'active',
    cls.sectorKey,
    cls.sectorConfidence,
    occurredAt,
    occurredAt,
    occurredAt,
    cls.confidence,
    cls.provisional ? 1 : 0,
    cls.directionUncertain ? 1 : 0,
    cls.possibleCompanyId,
    cls.possibleDealId,
    JSON.stringify({
      products: mention.products,
      prospect_action: cls.prospectAction,
      prospect_company_name: cls.prospectCompanyName,
    })
  ).run();

  const row = await env.D1.prepare(
    `SELECT id FROM prospects WHERE org_id = ? AND normalized_name = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(orgId, mention.normalizedName).first<{ id: string }>();
  if (!row?.id) throw new Error('PROSPECT_UPSERT_FAILED');
  await updateProspectIdentityEvidence(orgId, row.id, mention, cls, occurredAt, env, null);
  return row.id;
}

interface ProspectCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  sector: string | null;
  company_type: string | null;
  investment_status: string | null;
  enrichment_confidence: number | null;
  enrichment_last_run: string | null;
  custom_fields: string | null;
}

interface ProspectCompanyCandidate {
  company: ProspectCompanyRow;
  score: number;
  method: string;
  reasons: string[];
  exact: boolean;
}

interface ProspectCompanyResolution {
  action: 'linked_existing' | 'created' | 'needs_review' | 'skipped';
  companyId: string | null;
  matchMethod: string;
  matchScore: number | null;
  candidates: Array<{ company_id: string; name: string; score: number; method: string; reasons: string[] }>;
  enrichment: { status: string; reason: string | null };
}

function prospectCompanyDomainForMention(mention: MentionCandidate, env?: Env): string | null {
  const domain = firstProspectDomainForMention(mention, env);
  return strictRegistrableDomain(domain);
}

function companyRowDomain(row: Pick<ProspectCompanyRow, 'domain' | 'website'>): string | null {
  const domain = strictRegistrableDomain(row.domain);
  if (domain) return domain;
  return domainFromUrl(row.website);
}

function companyIdentityAliases(row: Pick<ProspectCompanyRow, 'name' | 'domain' | 'website'>): Set<string> {
  const aliases = prospectIdentityAliasesForName(row.name);
  const domain = companyRowDomain(row);
  if (domain) {
    for (const alias of prospectIdentityAliasesForName(domainLabelToCompany(domain))) aliases.add(alias);
  }
  return aliases;
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|group|holdings)\b\.?/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2));
}

function tokenOverlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / Math.max(left.size, right.size);
}

function scoreCompanyForProspect(mention: MentionCandidate, row: ProspectCompanyRow, env?: Env): ProspectCompanyCandidate | null {
  const prospectDomain = prospectCompanyDomainForMention(mention, env);
  const companyDomain = companyRowDomain(row);
  const domainConflict = Boolean(prospectDomain && companyDomain && prospectDomain !== companyDomain);
  const reasons: string[] = [];
  let score = 0;
  let method = 'no_match';
  let exact = false;

  if (prospectDomain && companyDomain && prospectDomain === companyDomain) {
    score = 1;
    method = 'exact_domain';
    exact = true;
    reasons.push(`domain:${prospectDomain}`);
  }

  const mentionAliases = prospectIdentityAliasesForMention(mention, env);
  const rowAliases = companyIdentityAliases(row);
  if (mention.normalizedName && normalizeProspectName(row.name) === mention.normalizedName && score < 0.97) {
    score = domainConflict ? 0.86 : 0.97;
    method = domainConflict ? 'exact_normalized_name_domain_conflict' : 'exact_normalized_name';
    exact = !domainConflict;
    reasons.push(domainConflict ? 'normalized_name_domain_conflict' : 'normalized_name');
  }
  if (!domainConflict && setsIntersect(mentionAliases, rowAliases) && score < 0.95) {
    score = prospectDomain || companyDomain ? 0.95 : 0.92;
    method = prospectDomain || companyDomain ? 'domain_brand_alias' : 'aggressive_name_alias';
    exact = score >= 0.95;
    reasons.push('identity_alias');
  }

  const mentionAlias = Array.from(mentionAliases).sort((a, b) => b.length - a.length)[0] || mention.normalizedName;
  const rowAlias = Array.from(rowAliases).sort((a, b) => b.length - a.length)[0] || normalizeProspectName(row.name);
  if (mentionAlias && rowAlias) {
    const jw = jaroWinkler(mentionAlias, rowAlias);
    if (jw >= 0.94 && score < 0.9) {
      score = 0.9;
      method = 'jaro_winkler_alias';
      reasons.push(`jw:${jw.toFixed(2)}`);
    }
    const minLen = Math.min(mentionAlias.length, rowAlias.length);
    if (minLen >= 6 && (mentionAlias.includes(rowAlias) || rowAlias.includes(mentionAlias)) && score < 0.88) {
      score = 0.88;
      method = 'substring_alias';
      reasons.push('substring_alias');
    }
  }

  const overlap = tokenOverlapScore(tokenSet(mention.canonicalName), tokenSet(row.name));
  if (overlap >= 0.67 && score < 0.86) {
    score = 0.86;
    method = 'token_overlap';
    reasons.push(`token_overlap:${overlap.toFixed(2)}`);
  }

  const limitedInfoReason = limitedInfoCompanyReason(row);
  if (limitedInfoReason) {
    score = Math.min(score, 0.88);
    exact = false;
    reasons.push(limitedInfoReason, 'audit_only_limited_info_company_match');
  }

  return score >= 0.7 ? { company: row, score, method, reasons, exact } : null;
}

async function loadCompanyResolutionCandidates(orgId: string, env: Env): Promise<ProspectCompanyRow[]> {
  const rows = await env.D1.prepare(
    `SELECT id, name, domain, website, description, sector, company_type, investment_status,
            enrichment_confidence, enrichment_last_run, custom_fields
       FROM companies
      WHERE org_id = ? AND deleted_at IS NULL
      LIMIT 5000`
  ).bind(orgId).all<ProspectCompanyRow>();
  return rows.results || [];
}

function chooseCompanyResolutionCandidate(candidates: ProspectCompanyCandidate[]): ProspectCompanyCandidate | null {
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.company.name.localeCompare(b.company.name));
  const top = candidates[0];
  const second = candidates[1] || null;
  if (top.exact && top.score >= 0.95) return top;
  if (top.score >= 0.92 && (!second || top.score - second.score >= 0.05)) return top;
  return null;
}

function prospectCompanyDescriptionFromMention(mention: MentionCandidate): string | null {
  const fields = mention.listFields;
  if (!fields) return null;
  const parts = [
    fields.problem ? `Problem: ${normalizeWhitespace(fields.problem)}` : '',
    fields.approach ? `Approach: ${normalizeWhitespace(fields.approach)}` : '',
  ].filter(Boolean);
  const description = normalizeWhitespace(parts.join(' '));
  return description || null;
}

export async function ensureInvestmentProspectTag(orgId: string, companyId: string, env: Env): Promise<string | null> {
  let tag = await env.D1.prepare(
    `SELECT id FROM tags
      WHERE org_id = ? AND entity_type = 'company' AND lower(name) = lower('Investment Prospect')
      LIMIT 1`
  ).bind(orgId).first<{ id: string }>().catch(error => {
    if (isMissingSqlTableError(error, 'tags')) return null;
    throw error;
  });

  if (!tag?.id) {
    const tagId = crypto.randomUUID();
    await env.D1.prepare(
      `INSERT INTO tags (id, org_id, name, color, entity_type, created_at)
       VALUES (?, ?, 'Investment Prospect', '#D946A8', 'company', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(org_id, name, entity_type) DO NOTHING`
    ).bind(tagId, orgId).run();
    tag = await env.D1.prepare(
      `SELECT id FROM tags
        WHERE org_id = ? AND entity_type = 'company' AND lower(name) = lower('Investment Prospect')
        LIMIT 1`
    ).bind(orgId).first<{ id: string }>();
  }
  if (!tag?.id) return null;

  await env.D1.prepare(
    `INSERT OR IGNORE INTO company_tags (company_id, tag_id, applied_by, applied_at)
     VALUES (?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(companyId, tag.id).run();
  return tag.id;
}

async function updateCompanyProspectProvenance(args: {
  orgId: string;
  companyId: string;
  prospectId: string;
  signalId: string;
  resolution: ProspectCompanyResolution;
  created: boolean;
}, env: Env): Promise<void> {
  const patch = {
    prospect_origin: {
      origin: 'prospect_signal',
      prospect_id: args.prospectId,
      signal_id: args.signalId,
      match_method: args.resolution.matchMethod,
      match_score: args.resolution.matchScore,
      created_by_prospect_pipeline: args.created,
      updated_at: new Date().toISOString(),
    },
  };
  await env.D1.prepare(
    `UPDATE companies
        SET investment_status = CASE
              WHEN investment_status IS NULL OR trim(investment_status) = '' OR investment_status = 'tracking' THEN 'prospect'
              ELSE investment_status
            END,
            custom_fields = json_patch(COALESCE(custom_fields, '{}'), ?),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(JSON.stringify(patch), args.companyId, args.orgId).run();
}

export interface ProspectOriginCompanyCreateInput {
  orgId: string;
  prospectId: string;
  signalId: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  description?: string | null;
  origin?: 'prospect_signal' | 'prospect_bridge_materialization';
  matchMethod?: string;
  matchScore?: number | null;
  limitedInfo?: boolean;
  limitedInfoReason?: string | null;
}

export async function createProspectOriginCompany(
  args: ProspectOriginCompanyCreateInput,
  env: Env
): Promise<string> {
  const companyId = crypto.randomUUID();
  const domain = domainFromUrl(args.domain || args.website || null) || args.domain || null;
  const website = args.website || (domain ? `https://${domain}` : null);
  const now = new Date().toISOString();
  const origin = args.origin || 'prospect_signal';
  const matchMethod = args.matchMethod || 'created_new_company';
  const limitedInfo = Boolean(args.limitedInfo);
  const limitedInfoReason = args.limitedInfoReason || (domain ? 'limited_info_prospect' : 'missing_verified_domain');
  const customFields = {
    prospect_origin: {
      origin,
      prospect_id: args.prospectId,
      signal_id: args.signalId,
      match_method: matchMethod,
      match_score: args.matchScore ?? null,
      created_by_prospect_pipeline: true,
      limited_info: limitedInfo,
      evidence_quality: limitedInfo ? 'limited_info' : 'verified',
      updated_at: now,
    },
    enrichment_guard: limitedInfo
      ? { status: domain ? 'limited_info' : 'blocked_insufficient_anchor', reason: limitedInfoReason }
      : domain
        ? { status: 'pending_domain_enrichment', reason: null }
        : { status: 'blocked_insufficient_anchor', reason: 'missing_verified_domain' },
  };
  if (limitedInfo) {
    (customFields as any).limited_info_prospect = {
      status: 'limited_info',
      reason: limitedInfoReason,
      created_at: now,
    };
  }

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, domain, website, description, company_type, investment_status, custom_fields, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'startup', 'prospect', ?, ?, ?)`
  ).bind(
    companyId,
    args.orgId,
    args.name,
    domain,
    website,
    args.description || null,
    JSON.stringify(customFields),
    now,
    now
  ).run();

  await emitAudit(env, {
    org_id: args.orgId,
    action: 'create',
    entity_type: 'company',
    entity_id: companyId,
    metadata: { auto_created: true, origin, prospect_id: args.prospectId, signal_id: args.signalId, domain },
    created_at: now,
  });
  try { await updateEntityInIndex(args.orgId, 'company', companyId, env); } catch {}
  await invalidateRagCache(args.orgId, env).catch(() => undefined);
  await upsertEntityIdentityAliases({
    orgId: args.orgId,
    entityType: 'company',
    entityId: companyId,
    name: args.name,
    domain,
    website,
    sourceKind: 'classifier',
    evidence: {
      source: 'prospect_origin_company',
      origin,
      prospect_id: args.prospectId,
      signal_id: args.signalId,
      match_method: matchMethod,
    },
  }, env);
  return companyId;
}

async function createCompanyForFinalProspect(args: {
  orgId: string;
  prospectId: string;
  signalId: string;
  mention: MentionCandidate;
  cls: Classification;
  matchMethod?: string;
  matchScore?: number | null;
  limitedInfoReason?: string | null;
}, env: Env): Promise<string> {
  const domain = prospectCompanyDomainForMention(args.mention, env);
  const website = domain ? `https://${domain}` : null;
  const description = prospectCompanyDescriptionFromMention(args.mention);
  const limitedInfo = !domain || Boolean(args.limitedInfoReason);
  return createProspectOriginCompany({
    orgId: args.orgId,
    prospectId: args.prospectId,
    signalId: args.signalId,
    name: args.mention.canonicalName,
    domain,
    website,
    description,
    origin: 'prospect_signal',
    matchMethod: args.matchMethod || 'created_new_company',
    matchScore: args.matchScore ?? null,
    limitedInfo,
    limitedInfoReason: args.limitedInfoReason || (domain ? null : 'missing_verified_domain'),
  }, env);
}

async function companyHasStoredBrief(orgId: string, company: ProspectCompanyRow, env: Env): Promise<boolean> {
  if (company.enrichment_last_run && Number(company.enrichment_confidence || 0) > 0) return true;
  const r2 = (env as any).R2;
  if (!r2?.get) return false;
  const obj = await r2.get(`${orgId}/enrichment/aggregated/${company.id}.json`).catch(() => null);
  if (!obj) return false;
  try {
    const raw = await obj.text();
    const parsed = JSON.parse(raw);
    return Boolean(String(parsed?.full_bio || raw || '').trim());
  } catch {
    return true;
  }
}

async function maybeRunProspectCompanyEnrichment(orgId: string, companyId: string, env: Env): Promise<{ status: string; reason: string | null }> {
  const company = await env.D1.prepare(
    `SELECT id, name, domain, website, description, sector, company_type, investment_status,
            enrichment_confidence, enrichment_last_run, custom_fields
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(companyId, orgId).first<ProspectCompanyRow>();
  if (!company) return { status: 'blocked', reason: 'company_not_found' };
  if (!companyRowDomain(company)) return { status: 'blocked_insufficient_anchor', reason: 'missing_verified_domain' };
  if (await companyHasStoredBrief(orgId, company, env)) return { status: 'skipped_existing_enrichment', reason: 'already_enriched' };
  if (!(env as any).R2?.get) return { status: 'blocked', reason: 'missing_r2_binding' };
  await triggerCompanyEnrichment(companyId, orgId, env);
  return { status: 'queued_domain_enrichment', reason: null };
}

function resolutionCandidateMetadata(candidates: ProspectCompanyCandidate[]): ProspectCompanyResolution['candidates'] {
  return candidates
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(candidate => ({
      company_id: candidate.company.id,
      name: candidate.company.name,
      score: Number(candidate.score.toFixed(3)),
      method: candidate.method,
      reasons: candidate.reasons,
    }));
}

async function persistProspectCompanyResolution(args: {
  orgId: string;
  prospectId: string;
  signalId: string;
  resolution: ProspectCompanyResolution;
}, env: Env): Promise<void> {
  const metadata = {
    company_resolution: {
      action: args.resolution.action,
      company_id: args.resolution.companyId,
      match_method: args.resolution.matchMethod,
      match_score: args.resolution.matchScore,
      candidates: args.resolution.candidates,
      enrichment: args.resolution.enrichment,
    },
  };
  if (args.resolution.companyId) {
    await env.D1.prepare(
      `UPDATE prospects
          SET company_id = ?,
              possible_company_id = NULL,
              metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(args.resolution.companyId, JSON.stringify(metadata), args.prospectId, args.orgId).run();
  } else if (args.resolution.candidates[0]?.company_id) {
    await env.D1.prepare(
      `UPDATE prospects
          SET possible_company_id = COALESCE(possible_company_id, ?),
              metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(args.resolution.candidates[0].company_id, JSON.stringify(metadata), args.prospectId, args.orgId).run();
  }

  await env.D1.prepare(
    `UPDATE prospect_signals
        SET company_id = ?,
            metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(args.resolution.companyId, JSON.stringify(metadata), args.signalId, args.orgId).run();
}

async function ensureCompanyForFinalProspect(args: {
  orgId: string;
  prospectId: string;
  signalId: string;
  mention: MentionCandidate;
  cls: Classification;
}, env: Env): Promise<ProspectCompanyResolution> {
  if (!args.cls.shouldCreateProspect || args.cls.provisional || args.cls.directionUncertain) {
    const resolution: ProspectCompanyResolution = {
      action: 'skipped',
      companyId: null,
      matchMethod: 'not_final_prospect',
      matchScore: null,
      candidates: [],
      enrichment: { status: 'blocked', reason: 'not_final_prospect' },
    };
    await persistProspectCompanyResolution({ orgId: args.orgId, prospectId: args.prospectId, signalId: args.signalId, resolution }, env);
    return resolution;
  }

  const rows = await loadCompanyResolutionCandidates(args.orgId, env);
  const scored = rows
    .map(row => scoreCompanyForProspect(args.mention, row, env))
    .filter((row): row is ProspectCompanyCandidate => Boolean(row));
  const selected = chooseCompanyResolutionCandidate(scored);
  const topWeakCandidate = scored.slice().sort((a, b) => b.score - a.score)[0] || null;
  let resolution: ProspectCompanyResolution;

  if (selected) {
    await ensureInvestmentProspectTag(args.orgId, selected.company.id, env);
    const enrichment = await maybeRunProspectCompanyEnrichment(args.orgId, selected.company.id, env);
    resolution = {
      action: 'linked_existing',
      companyId: selected.company.id,
      matchMethod: selected.method,
      matchScore: Number(selected.score.toFixed(3)),
      candidates: resolutionCandidateMetadata(scored),
      enrichment,
    };
    await updateCompanyProspectProvenance({
      orgId: args.orgId,
      companyId: selected.company.id,
      prospectId: args.prospectId,
      signalId: args.signalId,
      resolution,
      created: false,
    }, env);
    await upsertEntityIdentityAliases({
      orgId: args.orgId,
      entityType: 'company',
      entityId: selected.company.id,
      name: selected.company.name,
      domain: selected.company.domain,
      website: selected.company.website,
      sourceKind: 'classifier',
      evidence: {
        source: 'prospect_company_resolution',
        prospect_id: args.prospectId,
        signal_id: args.signalId,
        match_method: selected.method,
        match_score: Number(selected.score.toFixed(3)),
      },
    }, env);
  } else if (topWeakCandidate && topWeakCandidate.score >= 0.92) {
    resolution = {
      action: 'needs_review',
      companyId: null,
      matchMethod: 'ambiguous_strong_company_candidates',
      matchScore: Number(topWeakCandidate.score.toFixed(3)),
      candidates: resolutionCandidateMetadata(scored),
      enrichment: { status: 'blocked', reason: 'ambiguous_strong_company_candidates' },
    };
  } else {
    const ignoredWeakCandidates = scored.length > 0;
    const companyId = await createCompanyForFinalProspect({
      ...args,
      matchMethod: ignoredWeakCandidates ? 'created_new_company_weak_candidates_ignored' : 'created_new_company',
      matchScore: ignoredWeakCandidates && topWeakCandidate ? Number(topWeakCandidate.score.toFixed(3)) : null,
      limitedInfoReason: ignoredWeakCandidates ? 'weak_existing_company_candidates_ignored' : null,
    }, env);
    await ensureInvestmentProspectTag(args.orgId, companyId, env);
    const enrichment = await maybeRunProspectCompanyEnrichment(args.orgId, companyId, env);
    resolution = {
      action: 'created',
      companyId,
      matchMethod: ignoredWeakCandidates ? 'created_new_company_weak_candidates_ignored' : 'created_new_company',
      matchScore: ignoredWeakCandidates && topWeakCandidate ? Number(topWeakCandidate.score.toFixed(3)) : null,
      candidates: resolutionCandidateMetadata(scored),
      enrichment,
    };
  }

  await persistProspectCompanyResolution({ orgId: args.orgId, prospectId: args.prospectId, signalId: args.signalId, resolution }, env);
  return resolution;
}

export async function ensureProspectForDeal(
  orgId: string,
  dealId: string,
  env: Env
): Promise<EnsureProspectForDealResult> {
  const deal = await env.D1.prepare(
    `SELECT d.id AS deal_id, d.company_id, d.created_at, d.updated_at,
            c.name AS company_name, c.domain AS company_domain, c.website AS company_website,
            c.sector AS company_sector
       FROM deals d
       JOIN companies c ON c.id = d.company_id AND c.org_id = d.org_id
      WHERE d.org_id = ? AND d.id = ? AND d.deleted_at IS NULL
        AND d.stage != 'closed' AND c.deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{
    deal_id: string;
    company_id: string;
    created_at: string | null;
    updated_at: string | null;
    company_name: string;
    company_domain: string | null;
    company_website: string | null;
    company_sector: string | null;
  }>();

  if (!deal?.company_id || !deal.company_name) {
    return { prospectId: null, action: 'skipped_no_deal', dealId, companyId: deal?.company_id || null };
  }

  const normalizedName = normalizeProspectName(deal.company_name);
  if (!normalizedName) {
    return { prospectId: null, action: 'skipped_no_deal', dealId, companyId: deal.company_id };
  }

  const sector = prospectSectorKeyFromCompanySector(deal.company_sector);
  const seenAt = deal.created_at || deal.updated_at || new Date().toISOString();
  const domain = deal.company_domain || domainFromUrl(deal.company_website || null);
  const metadata = {
    source: 'known_deal_backlink',
    deal_id: dealId,
    company_id: deal.company_id,
  };

  const existingDealProspect = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND deal_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{ id: string }>();
  if (existingDealProspect?.id) {
    await env.D1.prepare(
      `UPDATE prospects
          SET canonical_name = CASE
                WHEN length(?) > length(canonical_name) THEN ?
                ELSE canonical_name
              END,
              domain = COALESCE(domain, ?),
              company_id = COALESCE(company_id, ?),
              status = 'converted',
              sector_key = CASE
                WHEN sector_key = 'uncategorized' OR sector_confidence < ? THEN ?
                ELSE sector_key
              END,
              sector_confidence = MAX(sector_confidence, ?),
              last_seen_at = CASE
                WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ?
                ELSE last_seen_at
              END,
              last_signal_at = CASE
                WHEN last_signal_at IS NULL OR ? > last_signal_at THEN ?
                ELSE last_signal_at
              END,
              signal_strength = MAX(signal_strength, 85),
              signal_strength_reasons = CASE
                WHEN signal_strength < 85 THEN ?
                ELSE signal_strength_reasons
              END,
              enrichment_priority = CASE
                WHEN enrichment_priority = 'eager' THEN enrichment_priority
                ELSE 'eager'
              END,
              confidence = MAX(confidence, 1.0),
              provisional = 0,
              direction_uncertain = 0,
              possible_deal_id = NULL,
              metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      deal.company_name,
      deal.company_name,
      domain,
      deal.company_id,
      sector.confidence,
      sector.key,
      sector.confidence,
      seenAt,
      seenAt,
      seenAt,
      seenAt,
      JSON.stringify(['known_deal_backlink']),
      JSON.stringify(metadata),
      existingDealProspect.id,
      orgId
    ).run();
    return {
      prospectId: existingDealProspect.id,
      action: 'already_linked',
      dealId,
      companyId: deal.company_id,
    };
  }

  const existingNameProspect = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND normalized_name = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, normalizedName).first<{ id: string }>();

  await env.D1.prepare(
    `INSERT INTO prospects (
       id, org_id, canonical_name, normalized_name, domain, company_id, deal_id,
       status, visibility, sector_key, sector_confidence,
       first_seen_at, last_seen_at, last_signal_at,
       signal_strength, signal_strength_reasons, enrichment_priority,
       confidence, provisional, direction_uncertain, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       'converted', 'firm', ?, ?,
       ?, ?, ?,
       85, ?, 'eager',
       1.0, 0, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, normalized_name) WHERE deleted_at IS NULL DO UPDATE SET
       canonical_name = CASE
         WHEN length(excluded.canonical_name) > length(prospects.canonical_name) THEN excluded.canonical_name
         ELSE prospects.canonical_name
       END,
       domain = COALESCE(prospects.domain, excluded.domain),
       company_id = COALESCE(prospects.company_id, excluded.company_id),
       deal_id = COALESCE(prospects.deal_id, excluded.deal_id),
       status = 'converted',
       sector_key = CASE
         WHEN prospects.sector_key = 'uncategorized' OR prospects.sector_confidence < excluded.sector_confidence THEN excluded.sector_key
         ELSE prospects.sector_key
       END,
       sector_confidence = MAX(prospects.sector_confidence, excluded.sector_confidence),
       first_seen_at = CASE
         WHEN prospects.first_seen_at IS NULL OR excluded.first_seen_at < prospects.first_seen_at THEN excluded.first_seen_at
         ELSE prospects.first_seen_at
       END,
       last_seen_at = CASE
         WHEN prospects.last_seen_at IS NULL OR excluded.last_seen_at > prospects.last_seen_at THEN excluded.last_seen_at
         ELSE prospects.last_seen_at
       END,
       last_signal_at = CASE
         WHEN prospects.last_signal_at IS NULL OR excluded.last_signal_at > prospects.last_signal_at THEN excluded.last_signal_at
         ELSE prospects.last_signal_at
       END,
       signal_strength = MAX(prospects.signal_strength, excluded.signal_strength),
       signal_strength_reasons = CASE
         WHEN prospects.signal_strength < excluded.signal_strength THEN excluded.signal_strength_reasons
         ELSE prospects.signal_strength_reasons
       END,
       enrichment_priority = CASE
         WHEN prospects.enrichment_priority = 'eager' THEN prospects.enrichment_priority
         ELSE excluded.enrichment_priority
       END,
       confidence = MAX(prospects.confidence, excluded.confidence),
       provisional = 0,
       direction_uncertain = 0,
       possible_deal_id = NULL,
       metadata_json = json_patch(COALESCE(prospects.metadata_json, '{}'), excluded.metadata_json),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    crypto.randomUUID(),
    orgId,
    deal.company_name,
    normalizedName,
    domain,
    deal.company_id,
    dealId,
    sector.key,
    sector.confidence,
    seenAt,
    seenAt,
    seenAt,
    JSON.stringify(['known_deal_backlink']),
    JSON.stringify(metadata)
  ).run();

  const row = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND deal_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{ id: string }>();
  if (!row?.id) throw new Error('DEAL_PROSPECT_UPSERT_FAILED');

  return {
    prospectId: row.id,
    action: existingDealProspect ? 'already_linked' : existingNameProspect ? 'updated' : 'created',
    dealId,
    companyId: deal.company_id,
  };
}

async function loadDealBackedProspectMap(orgId: string, env: Env): Promise<Map<string, string>> {
  const rows = await env.D1.prepare(
    `SELECT id, deal_id
       FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND deal_id IS NOT NULL
        AND status IN ('active','provisional','converted')`
  ).bind(orgId).all<{ id: string; deal_id: string }>();
  return new Map((rows.results || []).filter(row => row.deal_id).map(row => [row.deal_id, row.id]));
}

function classificationRequiresSecondLook(cls: Classification): boolean {
  const finalQualityGate = cls.metadata.prospect_final_quality_gate as { applied?: unknown; decision?: unknown } | undefined;
  if (finalQualityGate?.applied === true && typeof finalQualityGate.decision === 'string') return false;
  const secondLook = cls.metadata.prospect_second_look as { required?: unknown } | undefined;
  return secondLook?.required === true;
}

function classificationNeedsPendingResolution(cls: Classification): boolean {
  return classificationRequiresSecondLook(cls) || cls.provisional || cls.directionUncertain || cls.sectorKey === 'uncategorized';
}

async function upsertSignal(args: {
  orgId: string;
  prospectId: string | null;
  dealId: string | null;
  companyId: string | null;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string | null;
  occurredAt: string;
  mention: MentionCandidate;
  cls: Classification;
  dealmakerId: string | null;
  dealmakerName: string | null;
  ingestionMode: 'live' | 'backfill';
}, env: Env): Promise<{ signalId: string }> {
  const before = await env.D1.prepare(
    `SELECT id, mention_type, direction, sector_key, confidence, classifier_version, prospect_id, deal_id, company_id,
            classification_status, resolution_status, classification_attempts, error_message
       FROM prospect_signals
      WHERE org_id = ? AND source_type = ? AND source_id = ? AND mention_ordinal = ?
      LIMIT 1`
  ).bind(args.orgId, args.sourceType, args.sourceId, args.mention.mentionOrdinal).first<{
    id: string; mention_type: string; direction: string; sector_key: string; confidence: number; classifier_version: string; prospect_id: string | null; deal_id: string | null; company_id: string | null;
    classification_status: string; resolution_status: string; classification_attempts: number; error_message: string | null;
  }>();

  const signalId = before?.id || crypto.randomUUID();
  const resolutionStatus = classificationNeedsPendingResolution(args.cls)
    ? 'pending'
    : 'resolved';
  const attempts = Number(before?.classification_attempts || 0) + 1;
  const newClassification = {
    mention_type: args.cls.mentionType,
    direction: args.cls.direction,
    sector_key: args.cls.sectorKey,
    confidence: args.cls.confidence,
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    prospect_id: args.prospectId,
    deal_id: args.dealId,
    company_id: args.companyId,
    classification_status: 'classified',
    resolution_status: resolutionStatus,
  };

  await env.D1.prepare(
    `INSERT INTO prospect_signals (
       id, org_id, prospect_id, deal_id, company_id, source_type, source_id, mention_ordinal,
       span_start, span_end, raw_mention_text, normalized_mention, source_title,
       occurred_at, direction, direction_source, direction_uncertain,
       mention_type, classifier_version, confidence, confidence_tier,
       classification_status, resolution_status, error_message, classification_attempts, last_attempted_at,
       sector_key, sector_confidence, signal_kind, dealmaker_id, dealmaker_name,
       has_deck, has_meeting, ingestion_mode, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       prospect_id = excluded.prospect_id,
       deal_id = excluded.deal_id,
       company_id = excluded.company_id,
       span_start = excluded.span_start,
       span_end = excluded.span_end,
       raw_mention_text = excluded.raw_mention_text,
       normalized_mention = excluded.normalized_mention,
       source_title = excluded.source_title,
       occurred_at = excluded.occurred_at,
       direction = excluded.direction,
       direction_source = excluded.direction_source,
       direction_uncertain = excluded.direction_uncertain,
       mention_type = excluded.mention_type,
       classifier_version = excluded.classifier_version,
       confidence = excluded.confidence,
       confidence_tier = excluded.confidence_tier,
       classification_status = excluded.classification_status,
       resolution_status = excluded.resolution_status,
       error_message = excluded.error_message,
       classification_attempts = excluded.classification_attempts,
       last_attempted_at = excluded.last_attempted_at,
       sector_key = excluded.sector_key,
       sector_confidence = excluded.sector_confidence,
       signal_kind = excluded.signal_kind,
       dealmaker_id = excluded.dealmaker_id,
       dealmaker_name = excluded.dealmaker_name,
       has_deck = excluded.has_deck,
       has_meeting = excluded.has_meeting,
       ingestion_mode = excluded.ingestion_mode,
       metadata_json = excluded.metadata_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    signalId,
    args.orgId,
    args.prospectId,
    args.dealId,
    args.companyId,
    args.sourceType,
    args.sourceId,
    args.mention.mentionOrdinal,
    args.mention.spanStart,
    args.mention.spanEnd,
    args.mention.raw,
    args.mention.normalizedName,
    args.sourceTitle,
    args.occurredAt,
    args.cls.direction,
    args.cls.directionUncertain ? 'mixed' : 'llm',
    args.cls.directionUncertain ? 1 : 0,
    args.cls.mentionType,
    PROSPECT_CLASSIFIER_VERSION,
    args.cls.confidence,
    args.cls.confidenceTier,
    'classified',
    resolutionStatus,
    null,
    attempts,
    args.cls.sectorKey,
    args.cls.sectorConfidence,
    args.cls.signalKind,
    args.dealmakerId,
    args.dealmakerName,
    args.cls.hasDeck ? 1 : 0,
    args.cls.hasMeeting ? 1 : 0,
    args.ingestionMode,
    JSON.stringify(args.cls.metadata)
  ).run();

  if (before && (
    before.mention_type !== args.cls.mentionType ||
    before.direction !== args.cls.direction ||
    before.sector_key !== args.cls.sectorKey ||
    Number(before.confidence) !== args.cls.confidence ||
    before.classifier_version !== PROSPECT_CLASSIFIER_VERSION ||
    before.prospect_id !== args.prospectId ||
    before.deal_id !== args.dealId ||
    before.company_id !== args.companyId ||
    before.classification_status !== 'classified' ||
    before.resolution_status !== resolutionStatus
  )) {
    await env.D1.prepare(
      `INSERT INTO prospect_classification_history
         (id, org_id, prospect_signal_id, classifier_version, previous_classification_json, new_classification_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(
      crypto.randomUUID(),
      args.orgId,
      before.id,
      PROSPECT_CLASSIFIER_VERSION,
      JSON.stringify(before),
      JSON.stringify(newClassification)
    ).run();
  }

  return { signalId };
}

async function recordProductionSample(args: {
  orgId: string;
  signalId: string;
  sourceType: SourceType;
  sourceId: string;
  mention: MentionCandidate;
  cls: Classification;
}, env: Env): Promise<boolean> {
  if (!args.cls.sampledForProduction || !args.cls.samplingReason) return false;
  await env.D1.prepare(
    `INSERT INTO prospect_classifier_samples (
       id, org_id, prospect_signal_id, source_type, source_id, mention_ordinal,
       sample_reason, confidence_tier, predicted_mention_type, predicted_direction,
       predicted_sector_key, label_status, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, 'unlabeled', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       prospect_signal_id = excluded.prospect_signal_id,
       sample_reason = excluded.sample_reason,
       confidence_tier = excluded.confidence_tier,
       predicted_mention_type = excluded.predicted_mention_type,
       predicted_direction = excluded.predicted_direction,
       predicted_sector_key = excluded.predicted_sector_key,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    crypto.randomUUID(),
    args.orgId,
    args.signalId,
    args.sourceType,
    args.sourceId,
    args.mention.mentionOrdinal,
    args.cls.samplingReason,
    args.cls.confidenceTier,
    args.cls.mentionType,
    args.cls.direction,
    args.cls.sectorKey
  ).run();
  return true;
}

async function upsertFailedSignal(args: {
  orgId: string;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string | null;
  occurredAt: string;
  mention: MentionCandidate;
  ingestionMode: 'live' | 'backfill';
  error: unknown;
}, env: Env): Promise<void> {
  const message = (args.error instanceof Error ? args.error.message : String(args.error || 'unknown'))
    .slice(0, 1000);
  const before = await env.D1.prepare(
    `SELECT id, classification_attempts
       FROM prospect_signals
      WHERE org_id = ? AND source_type = ? AND source_id = ? AND mention_ordinal = ?
      LIMIT 1`
  ).bind(args.orgId, args.sourceType, args.sourceId, args.mention.mentionOrdinal).first<{
    id: string; classification_attempts: number;
  }>();
  const attempts = Number(before?.classification_attempts || 0) + 1;

  await env.D1.prepare(
    `INSERT INTO prospect_signals (
       id, org_id, prospect_id, source_type, source_id, mention_ordinal,
       span_start, span_end, raw_mention_text, normalized_mention, source_title,
       occurred_at, direction, direction_source, direction_uncertain,
       mention_type, classifier_version, confidence, confidence_tier,
       classification_status, resolution_status, error_message, classification_attempts, last_attempted_at,
       sector_key, sector_confidence, signal_kind, has_deck, has_meeting,
       ingestion_mode, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, NULL, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, 'inbound', 'llm', 0,
       'noise', ?, 0, 'low',
       'failed', 'pending', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       'uncategorized', 0, 'unknown', 0, 0,
       ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       span_start = excluded.span_start,
       span_end = excluded.span_end,
       raw_mention_text = excluded.raw_mention_text,
       normalized_mention = excluded.normalized_mention,
       source_title = excluded.source_title,
       occurred_at = excluded.occurred_at,
       classifier_version = excluded.classifier_version,
       classification_status = excluded.classification_status,
       resolution_status = excluded.resolution_status,
       error_message = excluded.error_message,
       classification_attempts = excluded.classification_attempts,
       last_attempted_at = excluded.last_attempted_at,
       ingestion_mode = excluded.ingestion_mode,
       metadata_json = json_patch(COALESCE(prospect_signals.metadata_json, '{}'), excluded.metadata_json),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    before?.id || crypto.randomUUID(),
    args.orgId,
    args.sourceType,
    args.sourceId,
    args.mention.mentionOrdinal,
    args.mention.spanStart,
    args.mention.spanEnd,
    args.mention.raw,
    args.mention.normalizedName,
    args.sourceTitle,
    args.occurredAt,
    PROSPECT_CLASSIFIER_VERSION,
    message,
    attempts,
    args.ingestionMode,
    JSON.stringify({
      classifier: 'llm_req_cl',
      classifier_error: message,
      retriable: true,
      req: 'REQ-AR-3',
    })
  ).run();
}

export function computeSignalStrength(input: {
  signalCount: number;
  hasMeeting: boolean;
  hasDeck: boolean;
  hasWarmIntro: boolean;
  hasOnlyListEntries: boolean;
  hasOnlyColdMentions: boolean;
}): { score: number; reasons: string[]; priority: 'eager' | 'lazy' } {
  const reasons: string[] = [];
  let score = 20;
  if (input.hasMeeting) { score += 35; reasons.push('meeting_or_call'); }
  if (input.hasDeck) { score += 30; reasons.push('attached_deck_or_data_room'); }
  if (input.hasWarmIntro) { score += 25; reasons.push('named_dealmaker_intro'); }
  if (input.signalCount > 1) {
    const bump = Math.min(30, (input.signalCount - 1) * 12);
    score += bump;
    reasons.push(`corroborated_${input.signalCount}_signals`);
  }
  if (input.hasOnlyListEntries) { score -= 15; reasons.push('single_or_list_email_entry'); }
  if (input.hasOnlyColdMentions) { score -= 10; reasons.push('cold_mention'); }
  score = clamp(Math.round(score), 0, 100);
  return { score, reasons, priority: score >= 60 ? 'eager' : 'lazy' };
}

async function refreshProspectAggregate(prospectId: string, orgId: string, env: Env): Promise<void> {
  const rows = await env.D1.prepare(
    `SELECT signal_kind, has_deck, has_meeting, dealmaker_id, confidence, occurred_at
       FROM prospect_signals
      WHERE prospect_id = ? AND org_id = ? AND mention_type = 'inbound_prospect'
      ORDER BY occurred_at ASC`
  ).bind(prospectId, orgId).all<{
    signal_kind: SignalKind; has_deck: number; has_meeting: number; dealmaker_id: string | null; confidence: number; occurred_at: string;
  }>();
  const signals = rows.results;
  if (signals.length === 0) return;
  const strength = computeSignalStrength({
    signalCount: signals.length,
    hasMeeting: signals.some(s => s.has_meeting === 1 || s.signal_kind === 'meeting'),
    hasDeck: signals.some(s => s.has_deck === 1 || s.signal_kind === 'deck'),
    hasWarmIntro: signals.some(s => !!s.dealmaker_id || s.signal_kind === 'intro'),
    hasOnlyListEntries: signals.every(s => s.signal_kind === 'list_entry'),
    hasOnlyColdMentions: signals.every(s => s.signal_kind === 'cold_mention'),
  });
  const avgConfidence = signals.reduce((sum, s) => sum + Number(s.confidence || 0), 0) / signals.length;
  await env.D1.prepare(
    `UPDATE prospects
        SET signal_count = ?,
            evidence_count = ?,
            first_seen_at = ?,
            last_seen_at = ?,
            last_signal_at = ?,
            signal_strength = ?,
            signal_strength_reasons = ?,
            enrichment_priority = ?,
            confidence = MAX(confidence, ?),
            status = CASE WHEN status = 'provisional' AND ? >= 60 THEN 'active' ELSE status END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    signals.length,
    signals.length,
    signals[0].occurred_at,
    signals[signals.length - 1].occurred_at,
    signals[signals.length - 1].occurred_at,
    strength.score,
    JSON.stringify(strength.reasons),
    strength.priority,
    avgConfidence,
    strength.score,
    prospectId,
    orgId
  ).run();
}

function sameCompanyForEnrichment(prospect: { canonical_name: string; domain: string | null }, candidate: ProspectEnrichmentCandidate): boolean {
  const prospectDomain = prospect.domain?.trim().toLowerCase() || null;
  const candidateDomain = candidate.domain?.trim().toLowerCase() || domainInText(candidate.sourceUrl);
  if (prospectDomain && candidateDomain && prospectDomain === candidateDomain) return true;
  if (candidate.sourceKind === 'own_domain' && prospectDomain && candidate.sourceUrl.toLowerCase().includes(prospectDomain)) return true;
  return normalizeProspectName(candidate.canonicalName) === normalizeProspectName(prospect.canonical_name);
}

function enrichmentCandidateIsCorroborated(candidate: ProspectEnrichmentCandidate): boolean {
  return candidate.sourceKind === 'own_domain' || Number(candidate.corroboratingSourceCount || 0) >= 2;
}

async function currentProspectFieldValue(
  orgId: string,
  prospectId: string,
  field: string,
  env: Env
): Promise<string | null> {
  if (!PROSPECT_ENRICHMENT_FIELDS.has(field)) return null;
  const row = await env.D1.prepare(
    `SELECT ${field} AS value FROM prospects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(prospectId, orgId).first<{ value: string | null }>();
  const value = row?.value == null ? null : String(row.value).trim();
  return value || null;
}

async function writeProspectFieldState(args: {
  orgId: string;
  prospectId: string;
  field: string;
  value: string;
  source: string;
  sourceUrl: string;
  applyToEntity: boolean;
}, env: Env): Promise<'applied' | 'held' | 'skipped'> {
  if (!PROSPECT_ENRICHMENT_FIELDS.has(args.field)) return 'skipped';
  const value = normalizeWhitespace(args.value);
  if (!value) return 'skipped';

  if (args.applyToEntity) {
    await env.D1.prepare(
      `UPDATE prospects
          SET ${args.field} = ?,
              enrichment_status = 'enriched',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(value, args.prospectId, args.orgId).run();
    await env.D1.prepare(
      `INSERT INTO entity_field_state
         (entity_type, entity_id, field_name, current_value, current_value_sources, pending_proposals, rejected_values)
       VALUES ('prospect', ?, ?, ?, ?, '{}', '{}')
       ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
         current_value = excluded.current_value,
         current_value_sources = excluded.current_value_sources,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(
      args.prospectId,
      args.field,
      value,
      JSON.stringify([{ source: args.source, source_url: args.sourceUrl, authority: 'web_enrichment', req: 'REQ-EN-4' }])
    ).run();
    return 'applied';
  }

  await env.D1.prepare(
    `INSERT INTO entity_field_state
       (entity_type, entity_id, field_name, current_value, current_value_sources, pending_proposals, rejected_values)
     VALUES ('prospect', ?, ?, NULL, '[]', json_object(?, json_array(?)), '{}')
     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
       pending_proposals = json_patch(COALESCE(entity_field_state.pending_proposals, '{}'), json_object(?, json_array(?))),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    args.prospectId,
    args.field,
    value,
    `${args.source}:${args.sourceUrl}`,
    value,
    `${args.source}:${args.sourceUrl}`
  ).run();
  await env.D1.prepare(
    `UPDATE prospects
        SET enrichment_status = CASE WHEN enrichment_status = 'not_started' THEN 'candidate' ELSE enrichment_status END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(args.prospectId, args.orgId).run();
  return 'held';
}

export async function applyProspectEnrichmentCandidate(
  orgId: string,
  candidate: ProspectEnrichmentCandidate,
  env: Env
): Promise<{ applied: string[]; held: string[]; discarded: string[] }> {
  const prospect = await env.D1.prepare(
    `SELECT id, canonical_name, domain, website, description, hq_location, founders_json
       FROM prospects
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(candidate.prospectId, orgId).first<any>();
  if (!prospect) throw new Error('PROSPECT_NOT_FOUND');

  const sameCompany = sameCompanyForEnrichment(prospect, candidate);
  const corroborated = enrichmentCandidateIsCorroborated(candidate);
  const result = { applied: [] as string[], held: [] as string[], discarded: [] as string[] };
  for (const [field, rawValue] of Object.entries(candidate.fields)) {
    if (!rawValue || !PROSPECT_ENRICHMENT_FIELDS.has(field)) continue;
    if (!sameCompany) {
      result.discarded.push(field);
      continue;
    }
    const current = await currentProspectFieldValue(orgId, candidate.prospectId, field, env);
    if (current) {
      result.discarded.push(field);
      continue;
    }
    const disposition = await writeProspectFieldState({
      orgId,
      prospectId: candidate.prospectId,
      field,
      value: rawValue,
      source: `web_enrichment:${candidate.sourceKind}`,
      sourceUrl: candidate.sourceUrl,
      applyToEntity: corroborated,
    }, env);
    if (disposition === 'applied') result.applied.push(field);
    else if (disposition === 'held') result.held.push(field);
    else result.discarded.push(field);
  }
  return result;
}

function extractMetaContent(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  return re.exec(html)?.[1]?.replace(/&amp;/g, '&') || null;
}

function titleFromHtml(html: string): string | null {
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

export async function runProspectEnrichmentCycle(
  orgId: string,
  env: Env,
  options: { limit?: number; fetcher?: typeof fetch } = {}
): Promise<{ scanned: number; applied: number; held: number; discarded: number }> {
  const limit = Math.min(Math.max(Number(options.limit || 10), 1), 50);
  const prospects = await env.D1.prepare(
    `SELECT id, canonical_name, domain, signal_strength, enrichment_status
      FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND status = 'active'
        AND provisional = 0
        AND direction_uncertain = 0
        AND enrichment_status IN ('not_started','candidate','failed')
      ORDER BY signal_strength DESC, last_seen_at DESC
      LIMIT ?`
  ).bind(orgId, limit).all<{ id: string; canonical_name: string; domain: string | null; signal_strength: number; enrichment_status: string }>();

  let applied = 0;
  let held = 0;
  let discarded = 0;
  const fetcher = options.fetcher || fetch;
  for (const prospect of prospects.results || []) {
    if (!prospect.domain) continue;
    const url = `https://${prospect.domain}`;
    try {
      const response = await fetcher(url, { cf: { cacheTtl: 3600 } } as any);
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const html = await response.text();
      const description = extractMetaContent(html, 'description') || extractMetaContent(html, 'og:description') || titleFromHtml(html);
      const candidate = await applyProspectEnrichmentCandidate(orgId, {
        prospectId: prospect.id,
        canonicalName: prospect.canonical_name,
        domain: prospect.domain,
        sourceKind: 'own_domain',
        sourceUrl: url,
        fields: {
          website: url,
          description: description || undefined,
        },
      }, env);
      applied += candidate.applied.length;
      held += candidate.held.length;
      discarded += candidate.discarded.length;
    } catch (e) {
      await env.D1.prepare(
        `UPDATE prospects
            SET enrichment_status = 'failed',
                metadata_json = json_patch(COALESCE(metadata_json, '{}'), json_object('enrichment_error', ?)),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(e instanceof Error ? e.message : String(e), prospect.id, orgId).run();
    }
  }
  return { scanned: prospects.results.length, applied, held, discarded };
}

async function recordSoftLinks(prospectId: string, orgId: string, cls: Classification, env: Env): Promise<void> {
  const links: Array<{ linkType: 'possible_company_match' | 'possible_deal_attach'; targetType: 'company' | 'deal'; targetId: string }> = [];
  if (cls.possibleCompanyId) links.push({ linkType: 'possible_company_match', targetType: 'company', targetId: cls.possibleCompanyId });
  if (cls.possibleDealId) links.push({ linkType: 'possible_deal_attach', targetType: 'deal', targetId: cls.possibleDealId });
  if (links.length === 0) return;
  await env.D1.batch(links.map(link =>
    env.D1.prepare(
      `INSERT INTO prospect_soft_links
         (id, org_id, prospect_id, link_type, target_type, target_id, score, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(org_id, prospect_id, link_type, target_type, target_id) DO UPDATE SET
         score = MAX(prospect_soft_links.score, excluded.score),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(crypto.randomUUID(), orgId, prospectId, link.linkType, link.targetType, link.targetId, cls.confidence, JSON.stringify({ classifier_version: PROSPECT_CLASSIFIER_VERSION }))
  ));
}

function hasSourceLevelTargetRecoveryIntent(item: ClassifiedItem): boolean {
  const kind = orgExtractionKindForItem(item);
  const text = `${item.bodyPreview || ''}\n${sourceTextForOrgExtraction(item)}`;
  if (hasStrongSourceInvestmentIntent(text)) return true;
  if (kind === 'email') {
    return /\b(?:investment\s+opportunit(?:y|ies)|exclusive\s+investment|warm\s+intro|founder\s+intro|introduced|introducing|forward(?:ed|ing).{0,80}(?:pitch|deck|opportunity|founder)|pitch\s+deck|deck\s+attached|data\s+room|diligence|financial\s+model|fundrais(?:e|ing)|raising|series\s+[abc]|seed\s+round|safe|acquisition\s+opportunit(?:y|ies))\b/i.test(text);
  }
  return /\b(?:intro\s+call|warm\s+intro|founder|co[-\s]?founder|ceo|demo|pitch|presentation|product\s+overview|company\s+overview|traction|pilot|customers?|term\s+sheet|data\s+room|diligence|financial\s+model|deck|pre[-\s]?read|raise|raising|round|series\s+[abc]|seed)\b/i.test(text);
}

function sourceLooksLikeMultiTargetDealflow(item: ClassifiedItem): boolean {
  const text = `${item.bodyPreview || ''}\n${sourceTextForOrgExtraction(item)}`;
  if (isDealflowListText(text)) return true;
  const lines = text.split(/\n+/);
  const domainDealflowRows = lines.filter(line =>
    /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.(?:ai|com|io|co|health|tech|dev|finance|xyz|systems)\b/i.test(line) &&
    /\b(?:raise|raising|capital|series|seed|safe|round|diligence|pipeline|pre[-\s]?seed|preliminary|radar|prospect|company|problem|approach|solution|valuation|allocation)\b/i.test(line)
  );
  const distinctDomains = new Set(domainDealflowRows.map(line => domainInText(line)).filter(Boolean));
  if (distinctDomains.size >= 2) return true;
  return /\b(?:companies|company\s+list|shortlist|cohort|batch|portfolio\s+day|demo\s+day|fund\s+raising\s+packet|fundraising\s+packet|investor\s+review|private\s+capital\s+network|capital\s+providers|companies\s+fund\s+raising|looking\s+to\s+round\s+out\s+their\s+diligence\s+teams)\b/i.test(text) &&
    distinctDomains.size >= 1;
}

function shouldRunSourceTargetRecovery(
  item: ClassifiedItem,
  outcomes: SourceClassificationOutcome[]
): boolean {
  if (!hasSourceLevelTargetRecoveryIntent(item)) return false;
  if (
    outcomes.some(outcome => outcome.cls.shouldCreateProspect || outcome.cls.prospectAction === 'create_prospect') &&
    !sourceLooksLikeMultiTargetDealflow(item)
  ) return false;
  return outcomes.length === 0 || outcomes.some(outcome =>
    outcome.cls.shouldCreateProspect ||
    outcome.cls.prospectAction === 'create_prospect' ||
    outcome.cls.prospectAction === 'record_context' ||
    outcome.cls.prospectAction === 'attach_existing_deal' ||
    outcome.cls.prospectAction === 'ignore'
  );
}

function targetRecoveryMetadata(
  item: ClassifiedItem,
  outcomes: SourceClassificationOutcome[],
  recoveredMention: MentionCandidate,
  cls: Classification
): Record<string, unknown> {
  const multiTargetSource = sourceLooksLikeMultiTargetDealflow(item);
  return {
    target_recovery: {
      applied: true,
      source_kind: orgExtractionKindForItem(item),
      recovered_company_name: recoveredMention.canonicalName,
      cost_gate: {
        multi_target_source: multiTargetSource,
        recovery_limit: multiTargetSource ? 8 : 3,
      },
      original_actions: outcomes.map(outcome => ({
        company_name: outcome.mention.canonicalName,
        prospect_action: outcome.cls.prospectAction,
        mention_type: outcome.cls.mentionType,
      })).slice(0, 12),
    },
    maybe_create_recovery_candidate: cls.prospectAction !== 'create_prospect',
  };
}

function withClassificationMetadata(cls: Classification, metadata: Record<string, unknown>): Classification {
  return {
    ...cls,
    metadata: {
      ...cls.metadata,
      ...metadata,
    },
  };
}

async function extractSourceTargetRecoveryMentions(
  item: ClassifiedItem,
  orgId: string,
  env: Env,
  knownContext: ProspectClassifierKnownContext,
  existingMentions: MentionCandidate[],
  options: Pick<ProspectClassifierRuntimeOptions, 'dryRunNoBudgetWrites' | 'stats'> = {}
): Promise<MentionCandidate[]> {
  const fallbackName = await companyNameFor(item.companyId, orgId, env);
  const deterministic = await extractOrganizationMentionsFromSource(item, orgId, env, {
    fallbackName,
    knownContext,
    allowLlm: false,
    recoveryMode: true,
    existingMentions,
    stats: options.stats,
  });
  const baseOrdinal = Math.max(0, ...existingMentions.map(mention => mention.mentionOrdinal || 0));
  const assignOrdinals = (mentions: MentionCandidate[]): MentionCandidate[] =>
    mentions.map((mention, index) => ({ ...mention, mentionOrdinal: baseOrdinal + index + 1 }));
  const recoveryLimit = sourceLooksLikeMultiTargetDealflow(item) ? 8 : 3;
  if (deterministic.length > 0) return assignOrdinals(deterministic.slice(0, recoveryLimit));

  const recovered = await extractOrganizationMentionsFromSource(item, orgId, env, {
    fallbackName,
    knownContext,
    forceLlm: true,
    maxLlmOrganizations: recoveryLimit,
    dryRunNoBudgetWrites: options.dryRunNoBudgetWrites === true,
    recoveryMode: true,
    existingMentions,
    stats: options.stats,
  });
  return assignOrdinals(recovered.slice(0, recoveryLimit));
}

async function recordClassifiedProspectMention(args: {
  item: ClassifiedItem;
  orgId: string;
  env: Env;
  sourceType: SourceType;
  mention: MentionCandidate;
  cls: Classification;
  existing: ExistingContext;
  occurredAt: string;
  ingestionMode: 'live' | 'backfill';
  dealBackedProspects: Map<string, string>;
  stats: ProspectDetectionStats;
}): Promise<{ prospectId: string | null; signalId: string | null }> {
  updateStatsForProspectClassification(args.stats, args.cls);
  let prospectId: string | null = null;
  let signalCompanyId: string | null = null;
  let dealmaker: { id: string | null; name: string | null } = { id: null, name: null };
  const finalQualityGate = args.cls.metadata.prospect_final_quality_gate as Record<string, unknown> | undefined;
  const finalQualityAttachProspectId = finalQualityGate?.attach_only === true &&
    typeof finalQualityGate.resolved_merge_target_prospect_id === 'string'
    ? finalQualityGate.resolved_merge_target_prospect_id
    : null;

  if (finalQualityAttachProspectId) {
    prospectId = finalQualityAttachProspectId;
  } else if (args.cls.shouldCreateProspect) {
    if (args.cls.hasWarmIntro) {
      dealmaker = await upsertSenderDealmaker(args.item, args.orgId, args.occurredAt, args.env);
    }
    prospectId = await upsertProspect(args.orgId, args.mention, args.cls, args.occurredAt, args.env);
    await recordSoftLinks(prospectId, args.orgId, args.cls, args.env);
    args.stats.prospects_upserted++;
  } else if (args.cls.mentionType === 'intro_source') {
    dealmaker = await upsertMentionDealmaker(args.item, args.mention, args.orgId, args.occurredAt, args.env);
    args.stats.skipped_intro_source++;
  } else if (args.cls.mentionType === 'known_deal') {
    prospectId = args.cls.linkedDealId ? args.dealBackedProspects.get(args.cls.linkedDealId) || null : null;
    signalCompanyId = args.existing.companyId;
    args.stats.skipped_known_deal++;
  } else if (args.cls.mentionType === 'news') {
    args.stats.skipped_news++;
  } else if (args.cls.mentionType === 'noise') {
    args.stats.skipped_noise++;
  } else if (args.cls.mentionType === 'web_analytics') {
    args.stats.skipped_web_analytics++;
  }

  if (!args.cls.shouldCreateProspect && args.existing.companyId) {
    signalCompanyId = args.existing.companyId;
  }
  const signalDealId = !args.cls.shouldCreateProspect && args.existing.dealId && args.existing.matchStrength !== 'name'
    ? args.existing.dealId
    : args.cls.linkedDealId;

  const signalResult = await upsertSignal({
    orgId: args.orgId,
    prospectId,
    dealId: signalDealId,
    companyId: signalCompanyId,
    sourceType: args.sourceType,
    sourceId: args.item.entityId,
    sourceTitle: args.item.subject || null,
    occurredAt: args.occurredAt,
    mention: args.mention,
    cls: args.cls,
    dealmakerId: dealmaker.id,
    dealmakerName: dealmaker.name || args.cls.dealmakerName,
    ingestionMode: args.ingestionMode,
  }, args.env);
  args.stats.signals_recorded++;
  if (classificationNeedsPendingResolution(args.cls)) {
    args.stats.classifications_pending++;
  }
  if (prospectId && args.cls.shouldCreateProspect) {
    try {
      await ensureCompanyForFinalProspect({
        orgId: args.orgId,
        prospectId,
        signalId: signalResult.signalId,
        mention: args.mention,
        cls: args.cls,
      }, args.env);
    } catch (e) {
      console.warn('[prospect-intelligence] company resolution failed', {
        org_id: args.orgId,
        source_type: args.sourceType,
        source_id: args.item.entityId,
        prospect_id: prospectId,
        error: compactProspectBackfillError(e),
      });
    }
  }
  const sampled = await recordProductionSample({
    orgId: args.orgId,
    signalId: signalResult.signalId,
    sourceType: args.sourceType,
    sourceId: args.item.entityId,
    mention: args.mention,
    cls: args.cls,
  }, args.env).catch(e => {
    console.warn('[prospect-intelligence] production sample recording failed', {
      org_id: args.orgId,
      source_type: args.sourceType,
      source_id: args.item.entityId,
      signal_id: signalResult.signalId,
      error: compactProspectBackfillError(e),
    });
    return false;
  });
  if (sampled) args.stats.production_samples_recorded++;

  if (prospectId) await refreshProspectAggregate(prospectId, args.orgId, args.env);
  return { prospectId, signalId: signalResult.signalId };
}

function prospectFinalQualityGateMetadata(cls: Classification): Record<string, unknown> | null {
  const value = cls.metadata.prospect_final_quality_gate;
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function finalQualityResolvedMergeProspectId(cls: Classification): string | null {
  const gate = prospectFinalQualityGateMetadata(cls);
  return gate?.attach_only === true && typeof gate.resolved_merge_target_prospect_id === 'string'
    ? gate.resolved_merge_target_prospect_id
    : null;
}

function finalQualityDeferredMergeRecordKey(cls: Classification): string | null {
  const gate = prospectFinalQualityGateMetadata(cls);
  return gate?.attach_only === true &&
    typeof gate.merge_target_record_key === 'string' &&
    typeof gate.resolved_merge_target_prospect_id !== 'string'
    ? gate.merge_target_record_key
    : null;
}

async function finalQualityMergeProspectExists(
  orgId: string,
  prospectId: string,
  env: Env
): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT id, canonical_name, normalized_name
       FROM prospects
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(prospectId, orgId).first<{ id: string }>().catch(() => null);
  return Boolean(row?.id);
}

function withResolvedFinalQualityMerge(
  outcome: RecordableProspectOutcome,
  prospectId: string
): RecordableProspectOutcome {
  const gate = prospectFinalQualityGateMetadata(outcome.cls) || {};
  return {
    ...outcome,
    cls: {
      ...outcome.cls,
      metadata: {
        ...outcome.cls.metadata,
        prospect_final_quality_gate: {
          ...gate,
          resolved_merge_target_prospect_id: prospectId,
          merge_target_resolved: true,
          merge_resolved_via: 'same_batch_target',
        },
      },
    },
  };
}

function withUnresolvedFinalQualityMergeBlocked(outcome: RecordableProspectOutcome): RecordableProspectOutcome {
  const gate = prospectFinalQualityGateMetadata(outcome.cls) || {};
  const finalizationGate = outcome.cls.metadata.prospect_finalization_gate as { reasons?: unknown } | undefined;
  const reasons = Array.isArray(finalizationGate?.reasons)
    ? finalizationGate.reasons.map(reason => String(reason || '')).filter(Boolean)
    : [];
  appendUnique(reasons, 'unresolved_merge_target');
  return {
    ...outcome,
    cls: {
      ...outcome.cls,
      mentionType: 'noise',
      prospectAction: 'record_context',
      shouldCreateProspect: false,
      prospectCompanyName: null,
      possibleCompanyId: null,
      possibleDealId: null,
      linkedDealId: null,
      provisional: false,
      directionUncertain: false,
      metadata: {
        ...outcome.cls.metadata,
        prospect_final_quality_gate: {
          ...gate,
          decision: 'block_create',
          reason: 'unresolved_merge_target',
          blocked: true,
          merged: false,
          attach_only: false,
          merge_target_resolved: false,
          merge_unresolved_reason: 'unresolved_merge_target',
        },
        prospect_finalization_gate: {
          ...(outcome.cls.metadata.prospect_finalization_gate as Record<string, unknown> | undefined || {}),
          final: false,
          blocked: true,
          reasons,
        },
        prospect_action: 'record_context',
        should_create_prospect: false,
        prospect_company_name: null,
        context_signal: true,
        final_quality_block_reason: 'unresolved_merge_target',
      },
    },
  };
}

async function recordFinalQualityOutcomes(args: {
  outcomes: RecordableProspectOutcome[];
  orgId: string;
  env: Env;
  ingestionMode: 'live' | 'backfill';
  dealBackedProspects: Map<string, string>;
  stats: ProspectDetectionStats;
}): Promise<void> {
  const recordedProspectIds = new Map<string, string | null>();
  const deferred: RecordableProspectOutcome[] = [];
  const recordOne = async (outcome: RecordableProspectOutcome): Promise<void> => {
    const result = await recordClassifiedProspectMention({
      item: outcome.item,
      orgId: args.orgId,
      env: args.env,
      sourceType: outcome.sourceType,
      mention: outcome.mention,
      cls: outcome.cls,
      existing: outcome.existing,
      occurredAt: outcome.occurredAt,
      ingestionMode: args.ingestionMode,
      dealBackedProspects: args.dealBackedProspects,
      stats: args.stats,
    });
    recordedProspectIds.set(finalQualityRecordKey(outcome), result.prospectId);
  };

  for (const outcome of args.outcomes) {
    if (finalQualityDeferredMergeRecordKey(outcome.cls)) {
      deferred.push(outcome);
      continue;
    }
    const resolvedMergeProspectId = finalQualityResolvedMergeProspectId(outcome.cls);
    if (resolvedMergeProspectId) {
      const exists = await finalQualityMergeProspectExists(args.orgId, resolvedMergeProspectId, args.env);
      if (!exists) {
        args.stats.final_quality_gate_merge_unresolved++;
        await recordOne(withUnresolvedFinalQualityMergeBlocked(outcome));
        continue;
      }
      args.stats.final_quality_gate_merge_resolved++;
    }
    await recordOne(outcome);
  }

  for (const outcome of deferred) {
    const targetKey = finalQualityDeferredMergeRecordKey(outcome.cls);
    const targetProspectId = targetKey ? recordedProspectIds.get(targetKey) || null : null;
    if (targetProspectId) {
      args.stats.final_quality_gate_merge_resolved++;
      await recordOne(withResolvedFinalQualityMerge(outcome, targetProspectId));
    } else {
      args.stats.final_quality_gate_merge_unresolved++;
      await recordOne(withUnresolvedFinalQualityMergeBlocked(outcome));
    }
  }
}

export async function detectAndRecordProspectSignals(
  items: ClassifiedItem[],
  orgId: string,
  env: Env,
  options: { ingestionMode?: 'live' | 'backfill' } = {}
): Promise<ProspectDetectionStats> {
  const stats = emptyStats(items.length);
  const ingestionMode = options.ingestionMode || 'live';
  await prewarmProspectPipelinePromptCaches(orgId, env);
  const knownContext = await loadProspectClassifierKnownContext(orgId, env);
  const dealBackedProspects = await loadDealBackedProspectMap(orgId, env);
  const pendingOutcomes: RecordableProspectOutcome[] = [];

  for (const item of items) {
    const sourceType = prospectSourceType(item);
    if (!sourceType) continue;
    try {
      const sourceGate = sourcePrefilter(item, env);
      if (!sourceGate.shouldScan) {
        stats.prefilter_dropped++;
        continue;
      }
      const fallbackName = await companyNameFor(item.companyId, orgId, env);
      const mentions = await extractOrganizationMentionsFromSource(item, orgId, env, { fallbackName, knownContext, stats });
      stats.mentions_seen += mentions.length;
      const outcomes: SourceClassificationOutcome[] = [];
      let hadClassificationError = false;
      try {
        const classifiedMentions = await classifySourceMentionBatch(item, mentions, orgId, knownContext, env, { stats });
        if (classifiedMentions.some(row => row.cacheHit)) {
          stats.classifier_cache_hits++;
          stats.classifier_paid_calls_saved++;
        } else if (classifiedMentions.some(row => row.paidCall)) {
          stats.classifier_cache_misses++;
          stats.classifier_paid_calls++;
        }
        for (const { mention, cls, existing, error } of classifiedMentions) {
          const occurredAt = item.sentAt || new Date().toISOString();
          if (error || !cls) {
            await upsertFailedSignal({
              orgId,
              sourceType,
              sourceId: item.entityId,
              sourceTitle: item.subject || null,
              occurredAt,
              mention,
              ingestionMode,
              error: error || 'source_classifier_missing_decision',
            }, env);
            stats.signals_recorded++;
            stats.classifications_pending++;
            stats.errors.push({ item_id: item.entityId, error: error || 'source_classifier_missing_decision' });
            continue;
          }
          outcomes.push({ mention, cls, existing });
        }
      } catch (e) {
        if (isFatalClaudeClassifierError(e)) throw e;
        hadClassificationError = true;
        for (const mention of mentions) {
          const occurredAt = item.sentAt || new Date().toISOString();
          await upsertFailedSignal({
            orgId,
            sourceType,
            sourceId: item.entityId,
            sourceTitle: item.subject || null,
            occurredAt,
            mention,
            ingestionMode,
            error: e,
          }, env);
          stats.signals_recorded++;
          stats.classifications_pending++;
        }
        stats.errors.push({ item_id: item.entityId, error: e instanceof Error ? e.message : String(e) });
      }
      if (!hadClassificationError && shouldRunSourceTargetRecovery(item, outcomes)) {
        let recoveredMentions: MentionCandidate[] = [];
        try {
          recoveredMentions = await extractSourceTargetRecoveryMentions(item, orgId, env, knownContext, mentions, { stats });
          stats.mentions_seen += recoveredMentions.length;
          const recoveredClassifications = await classifySourceMentionBatch(item, recoveredMentions, orgId, knownContext, env, { stats });
          if (recoveredClassifications.some(row => row.cacheHit)) {
            stats.classifier_cache_hits++;
            stats.classifier_paid_calls_saved++;
          } else if (recoveredClassifications.some(row => row.paidCall)) {
            stats.classifier_cache_misses++;
            stats.classifier_paid_calls++;
          }
          for (const { mention, cls: classified, existing, error } of recoveredClassifications) {
            const occurredAt = item.sentAt || new Date().toISOString();
            if (error || !classified) {
              await upsertFailedSignal({
                orgId,
                sourceType,
                sourceId: item.entityId,
                sourceTitle: item.subject || null,
                occurredAt,
                mention,
                ingestionMode,
                error: error || 'source_classifier_missing_decision',
              }, env);
              stats.signals_recorded++;
              stats.classifications_pending++;
              stats.errors.push({ item_id: item.entityId, error: error || 'source_classifier_missing_decision' });
              continue;
            }
            const cls = withClassificationMetadata(classified, targetRecoveryMetadata(item, outcomes, mention, classified));
            outcomes.push({ mention, cls, existing });
          }
        } catch (e) {
          if (isFatalClaudeClassifierError(e)) throw e;
          for (const mention of recoveredMentions) {
            const occurredAt = item.sentAt || new Date().toISOString();
            await upsertFailedSignal({
              orgId,
              sourceType,
              sourceId: item.entityId,
              sourceTitle: item.subject || null,
              occurredAt,
              mention,
              ingestionMode,
              error: e,
            }, env);
            stats.signals_recorded++;
            stats.classifications_pending++;
          }
          stats.errors.push({ item_id: item.entityId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      pendingOutcomes.push(...outcomes.map(outcome => ({
        item,
        sourceType,
        mention: outcome.mention,
        cls: outcome.cls,
        existing: outcome.existing,
        occurredAt: item.sentAt || new Date().toISOString(),
      })));
    } catch (e) {
      if (isFatalClaudeClassifierError(e)) throw e;
      stats.errors.push({ item_id: item.entityId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const recordableOutcomes = await applyProspectFinalQualityGate(orgId, env, pendingOutcomes, { stats });
  await recordFinalQualityOutcomes({
    outcomes: recordableOutcomes,
    orgId,
    env,
    ingestionMode,
    dealBackedProspects,
    stats,
  });

  return stats;
}

export async function classifyProspectSignalsDryRun(
  items: ClassifiedItem[],
  orgId: string,
  env: Env,
  options: Pick<ProspectClassifierRuntimeOptions, 'allowPartialSchema' | 'classifierCache' | 'disableD1ClassifierCache'> = {}
): Promise<ProspectDryRunResult> {
  const stats = emptyStats(items.length);
  const decisions: ProspectDryRunDecision[] = [];
  const pendingOutcomes: RecordableProspectOutcome[] = [];
  if (shouldPrewarmProspectPromptCache(env)) {
    await prewarmProspectPipelinePromptCaches(orgId, env, { dryRunNoBudgetWrites: true });
  }
  const knownContext = await loadProspectClassifierKnownContext(orgId, env, {
    allowPartialSchema: options.allowPartialSchema === true,
  }).catch(error => {
    if (options.allowPartialSchema === true && isOptionalReadContextError(error)) {
      return emptyProspectClassifierKnownContext();
    }
    throw error;
  });

  const appendDryRunDecision = (
    item: ClassifiedItem,
    sourceType: SourceType,
    mention: MentionCandidate,
    occurredAt: string,
    cls: Classification
  ): void => {
    const finalizationGate = cls.metadata.prospect_finalization_gate as { blocked?: unknown; reasons?: unknown } | undefined;
    const reasoningJudge = cls.metadata.reasoning_judge as {
      action?: unknown;
      reasoning_valid?: unknown;
      reason?: unknown;
      blocked_prospect_company_name?: unknown;
    } | undefined;
    const secondLook = cls.metadata.prospect_second_look as {
      required?: unknown;
      lane?: unknown;
      recommended_action?: unknown;
      reasons?: unknown;
      warnings?: unknown;
      evidence?: unknown;
    } | undefined;
    const finalQualityGate = cls.metadata.prospect_final_quality_gate as {
      applied?: unknown;
      batch_id?: unknown;
      decision?: unknown;
      reason?: unknown;
      canonical_name?: unknown;
      original_name?: unknown;
      merge_target_ordinal?: unknown;
      merge_target_prospect_id?: unknown;
      blocked?: unknown;
      renamed?: unknown;
      merged?: unknown;
      attach_only?: unknown;
      fallback_used?: unknown;
      failed_open?: unknown;
      parse_failed?: unknown;
      retry_used?: unknown;
      fallback_basis?: unknown;
      target_proof?: unknown;
      hard_block_reason?: unknown;
      batch_size?: unknown;
      merge_target_resolved?: unknown;
      resolved_merge_target_prospect_id?: unknown;
      duplicate_group_id?: unknown;
      record_key?: unknown;
    } | undefined;
    const targetEvidenceReasons = Array.isArray(cls.metadata.target_evidence_reasons)
      ? cls.metadata.target_evidence_reasons
        .map(reason => String(reason || '').trim())
        .filter(Boolean)
      : [];
    const finalizationBlockReasons = Array.isArray(finalizationGate?.reasons)
      ? finalizationGate.reasons.map(reason => String(reason || '').trim()).filter(Boolean)
      : [];
    updateStatsForProspectClassification(stats, cls);
    if (cls.shouldCreateProspect) {
      stats.prospects_upserted++;
    } else if (cls.mentionType === 'intro_source') {
      stats.skipped_intro_source++;
    } else if (cls.mentionType === 'known_deal') {
      stats.skipped_known_deal++;
    } else if (cls.mentionType === 'news') {
      stats.skipped_news++;
    } else if (cls.mentionType === 'noise') {
      stats.skipped_noise++;
    } else if (cls.mentionType === 'web_analytics') {
      stats.skipped_web_analytics++;
    }
    stats.signals_recorded++;
    if (classificationNeedsPendingResolution(cls)) {
      stats.classifications_pending++;
    }
    decisions.push({
      item_id: item.entityId,
      source_type: sourceType,
      source_id: item.entityId,
      source_title: item.subject || null,
      occurred_at: occurredAt,
      mention_ordinal: mention.mentionOrdinal,
      company_name: mention.canonicalName,
      normalized_company_name: mention.normalizedName,
      duplicate_key: prospectDryRunDuplicateKey(sourceType, item.entityId, mention),
      prospect_action: cls.prospectAction,
      mention_type: cls.mentionType,
      direction: cls.direction,
      confidence: cls.confidence,
      sector_key: cls.sectorKey,
      prospect_company_name: cls.prospectCompanyName,
      should_create_prospect: cls.shouldCreateProspect,
      linked_deal_id: cls.linkedDealId,
      possible_company_id: cls.possibleCompanyId,
      possible_deal_id: cls.possibleDealId,
      provisional: cls.provisional,
      reasoning: typeof cls.metadata.llm_reasoning === 'string' ? cls.metadata.llm_reasoning : null,
      error: null,
      original_llm_is_prospect: typeof cls.metadata.original_llm_is_prospect === 'boolean'
        ? cls.metadata.original_llm_is_prospect
        : typeof cls.metadata.llm_is_prospect === 'boolean'
          ? cls.metadata.llm_is_prospect
          : null,
      original_llm_prospect_action: typeof cls.metadata.original_llm_prospect_action === 'string'
        ? cls.metadata.original_llm_prospect_action as ProspectAction
        : null,
      create_prospect_veto_reason: typeof cls.metadata.create_prospect_veto_reason === 'string'
        ? cls.metadata.create_prospect_veto_reason
        : null,
      valuable_action_veto_reason: typeof cls.metadata.valuable_action_veto_reason === 'string'
        ? cls.metadata.valuable_action_veto_reason
        : null,
      finalization_blocked: typeof finalizationGate?.blocked === 'boolean' ? finalizationGate.blocked : null,
      finalization_block_reasons: finalizationBlockReasons.join(';') || null,
      has_create_evidence: typeof cls.metadata.has_create_evidence === 'boolean'
        ? cls.metadata.has_create_evidence
        : null,
      reasoning_judge_action: typeof reasoningJudge?.action === 'string'
        ? reasoningJudge.action as ProspectReasoningJudgeAction | 'not_evaluated'
        : null,
      reasoning_judge_valid: typeof reasoningJudge?.reasoning_valid === 'boolean' ? reasoningJudge.reasoning_valid : null,
      reasoning_judge_reason: typeof reasoningJudge?.reason === 'string' ? reasoningJudge.reason : null,
      reasoning_judge_blocked_company: typeof reasoningJudge?.blocked_prospect_company_name === 'string'
        ? reasoningJudge.blocked_prospect_company_name
        : null,
      target_evidence_reasons: targetEvidenceReasons.join(';') || null,
      corrected_prospect_company_name: typeof cls.metadata.corrected_prospect_company_name === 'string'
        ? cls.metadata.corrected_prospect_company_name
        : null,
      second_look_required: typeof secondLook?.required === 'boolean' ? secondLook.required : null,
      second_look_lane: typeof secondLook?.lane === 'string' ? secondLook.lane as ProspectSecondLookLane : null,
      second_look_recommended_action: typeof secondLook?.recommended_action === 'string'
        ? secondLook.recommended_action as ProspectSecondLookRecommendedAction
        : null,
      second_look_reasons: Array.isArray(secondLook?.reasons)
        ? secondLook.reasons.map(reason => String(reason || '').trim()).filter(Boolean).join(';') || null
        : null,
      second_look_warnings: Array.isArray(secondLook?.warnings)
        ? secondLook.warnings.map(reason => String(reason || '').trim()).filter(Boolean).join(';') || null
        : null,
      second_look_evidence: Array.isArray(secondLook?.evidence)
        ? secondLook.evidence.map(reason => String(reason || '').trim()).filter(Boolean).join(';') || null
        : null,
      second_look_create_blocked: typeof cls.metadata.second_look_create_blocked === 'boolean'
        ? cls.metadata.second_look_create_blocked
        : null,
      second_look_block_reason: typeof cls.metadata.second_look_block_reason === 'string'
        ? cls.metadata.second_look_block_reason
        : null,
      final_quality_decision: typeof finalQualityGate?.decision === 'string'
        ? finalQualityGate.decision as ProspectFinalQualityDecisionAction
        : null,
      final_quality_canonical_name: typeof finalQualityGate?.canonical_name === 'string'
        ? finalQualityGate.canonical_name
        : null,
      final_quality_merge_target: typeof finalQualityGate?.merge_target_prospect_id === 'string'
        ? finalQualityGate.merge_target_prospect_id
        : typeof finalQualityGate?.resolved_merge_target_prospect_id === 'string'
          ? finalQualityGate.resolved_merge_target_prospect_id
        : typeof finalQualityGate?.merge_target_ordinal === 'number'
          ? String(finalQualityGate.merge_target_ordinal)
          : null,
      final_quality_reason: typeof finalQualityGate?.reason === 'string'
        ? finalQualityGate.reason
        : null,
      final_quality_blocked: typeof finalQualityGate?.blocked === 'boolean' ? finalQualityGate.blocked : null,
      final_quality_renamed: typeof finalQualityGate?.renamed === 'boolean' ? finalQualityGate.renamed : null,
      final_quality_merged: typeof finalQualityGate?.merged === 'boolean' ? finalQualityGate.merged : null,
      final_quality_batch_id: typeof finalQualityGate?.batch_id === 'string' ? finalQualityGate.batch_id : null,
      final_quality_failed_open: typeof finalQualityGate?.failed_open === 'boolean' ? finalQualityGate.failed_open : null,
      final_quality_fallback_used: typeof finalQualityGate?.fallback_used === 'boolean' ? finalQualityGate.fallback_used : null,
      final_quality_parse_failed: typeof finalQualityGate?.parse_failed === 'boolean' ? finalQualityGate.parse_failed : null,
      final_quality_retry_used: typeof finalQualityGate?.retry_used === 'boolean' ? finalQualityGate.retry_used : null,
      final_quality_fallback_basis: typeof finalQualityGate?.fallback_basis === 'string'
        ? finalQualityGate.fallback_basis
        : null,
      final_quality_target_proof: Array.isArray(finalQualityGate?.target_proof)
        ? finalQualityGate.target_proof.map(reason => String(reason || '').trim()).filter(Boolean).join(';') || null
        : null,
      final_quality_hard_block_reason: typeof finalQualityGate?.hard_block_reason === 'string'
        ? finalQualityGate.hard_block_reason
        : null,
      final_quality_batch_size: typeof finalQualityGate?.batch_size === 'number' ? finalQualityGate.batch_size : null,
      final_quality_attach_only: typeof finalQualityGate?.attach_only === 'boolean' ? finalQualityGate.attach_only : null,
      final_quality_merge_resolved: typeof finalQualityGate?.merge_target_resolved === 'boolean'
        ? finalQualityGate.merge_target_resolved
        : null,
      final_quality_existing_prospect_id: typeof finalQualityGate?.resolved_merge_target_prospect_id === 'string'
        ? finalQualityGate.resolved_merge_target_prospect_id
        : null,
      final_quality_duplicate_group_id: typeof finalQualityGate?.duplicate_group_id === 'string'
        ? finalQualityGate.duplicate_group_id
        : null,
      final_quality_record_key: typeof finalQualityGate?.record_key === 'string' ? finalQualityGate.record_key : null,
    });
  };

  const appendDryRunError = (
    item: ClassifiedItem,
    sourceType: SourceType,
    mention: MentionCandidate,
    occurredAt: string,
    error: string
  ): void => {
    stats.classifications_pending++;
    stats.errors.push({ item_id: item.entityId, error });
    decisions.push({
      item_id: item.entityId,
      source_type: sourceType,
      source_id: item.entityId,
      source_title: item.subject || null,
      occurred_at: occurredAt,
      mention_ordinal: mention.mentionOrdinal,
      company_name: mention.canonicalName,
      normalized_company_name: mention.normalizedName,
      duplicate_key: prospectDryRunDuplicateKey(sourceType, item.entityId, mention),
      prospect_action: 'classifier_error',
      mention_type: 'classifier_error',
      direction: null,
      confidence: null,
      sector_key: null,
      prospect_company_name: null,
      should_create_prospect: false,
      linked_deal_id: null,
      possible_company_id: null,
      possible_deal_id: null,
      provisional: false,
      reasoning: null,
      error,
    });
  };

  for (const item of items) {
    const sourceType = prospectSourceType(item);
    if (!sourceType) continue;
    try {
      const sourceGate = sourcePrefilter(item, env);
      if (!sourceGate.shouldScan) {
        stats.prefilter_dropped++;
        continue;
      }
      const fallbackName = await companyNameFor(item.companyId, orgId, env);
      const mentions = await extractOrganizationMentionsFromSource(item, orgId, env, {
        fallbackName,
        knownContext,
        dryRunNoBudgetWrites: true,
        stats,
      });
      stats.mentions_seen += mentions.length;
      const outcomes: SourceClassificationOutcome[] = [];
      let hadClassificationError = false;
      try {
        const classifiedMentions = await classifySourceMentionBatch(item, mentions, orgId, knownContext, env, {
          allowPartialSchema: options.allowPartialSchema === true,
          dryRunNoBudgetWrites: true,
          classifierCache: options.classifierCache,
          disableD1ClassifierCache: true,
          stats,
        });
        if (classifiedMentions.some(row => row.cacheHit)) {
          stats.classifier_cache_hits++;
          stats.classifier_paid_calls_saved++;
        } else if (classifiedMentions.some(row => row.paidCall)) {
          stats.classifier_cache_misses++;
          stats.classifier_paid_calls++;
        }
        for (const { mention, cls, existing, error } of classifiedMentions) {
          const occurredAt = item.sentAt || new Date().toISOString();
          if (error || !cls) {
            appendDryRunError(item, sourceType, mention, occurredAt, error || 'source_classifier_missing_decision');
            continue;
          }
          outcomes.push({ mention, cls, existing });
        }
      } catch (e) {
        if (isFatalClaudeClassifierError(e)) throw e;
        hadClassificationError = true;
        const error = e instanceof Error ? e.message : String(e);
        for (const mention of mentions) {
          const occurredAt = item.sentAt || new Date().toISOString();
          appendDryRunError(item, sourceType, mention, occurredAt, error);
        }
      }
      if (!hadClassificationError && shouldRunSourceTargetRecovery(item, outcomes)) {
        let recoveredMentions: MentionCandidate[] = [];
        try {
          recoveredMentions = await extractSourceTargetRecoveryMentions(item, orgId, env, knownContext, mentions, {
            dryRunNoBudgetWrites: true,
            stats,
          });
          stats.mentions_seen += recoveredMentions.length;
          const recoveredClassifications = await classifySourceMentionBatch(item, recoveredMentions, orgId, knownContext, env, {
            allowPartialSchema: options.allowPartialSchema === true,
            dryRunNoBudgetWrites: true,
            classifierCache: options.classifierCache,
            disableD1ClassifierCache: true,
            stats,
          });
          if (recoveredClassifications.some(row => row.cacheHit)) {
            stats.classifier_cache_hits++;
            stats.classifier_paid_calls_saved++;
          } else if (recoveredClassifications.some(row => row.paidCall)) {
            stats.classifier_cache_misses++;
            stats.classifier_paid_calls++;
          }
          for (const { mention, cls: classified, existing, error } of recoveredClassifications) {
            const occurredAt = item.sentAt || new Date().toISOString();
            if (error || !classified) {
              appendDryRunError(item, sourceType, mention, occurredAt, error || 'source_classifier_missing_decision');
              continue;
            }
            const cls = withClassificationMetadata(classified, targetRecoveryMetadata(item, outcomes, mention, classified));
            outcomes.push({ mention, cls, existing });
          }
        } catch (e) {
          if (isFatalClaudeClassifierError(e)) throw e;
          for (const mention of recoveredMentions) {
            const occurredAt = item.sentAt || new Date().toISOString();
            appendDryRunError(item, sourceType, mention, occurredAt, e instanceof Error ? e.message : String(e));
          }
        }
      }
      pendingOutcomes.push(...outcomes.map(outcome => ({
        item,
        sourceType,
        mention: outcome.mention,
        cls: outcome.cls,
        existing: outcome.existing,
        occurredAt: item.sentAt || new Date().toISOString(),
      })));
    } catch (e) {
      if (isFatalClaudeClassifierError(e)) throw e;
      stats.errors.push({ item_id: item.entityId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const recordableOutcomes = await applyProspectFinalQualityGate(
    orgId,
    env,
    pendingOutcomes,
    { dryRunNoBudgetWrites: true, stats }
  );
  for (const outcome of recordableOutcomes) {
    appendDryRunDecision(outcome.item, outcome.sourceType, outcome.mention, outcome.occurredAt, outcome.cls);
  }

  return {
    dry_run: true,
    rows_written: 0,
    changed_db: false,
    stats,
    decision_counts: prospectDryRunDecisionCounts(decisions),
    decisions,
    duplicates: prospectDryRunDuplicates(decisions),
  };
}

export async function recordProspectBackfillCoverage(
  orgId: string,
  env: Env,
  input: {
    runId?: string | null;
    sourceFamily: string;
    windowStart: string;
    windowEnd: string;
    itemsScanned: number;
    signalsRecorded: number;
    prospectsUpserted: number;
    classificationsPending?: number;
    status: 'completed' | 'partial' | 'failed';
    error?: string | null;
	  }
): Promise<void> {
  await env.D1.prepare(
    `INSERT INTO prospect_backfill_coverage (
       id, org_id, run_id, source_family, window_start, window_end,
       status, items_scanned, signals_recorded, prospects_upserted, classifications_pending,
       started_at, completed_at, error_message, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_family, window_start, window_end) DO UPDATE SET
       run_id = COALESCE(excluded.run_id, prospect_backfill_coverage.run_id),
       status = CASE
         WHEN prospect_backfill_coverage.status = 'completed' THEN prospect_backfill_coverage.status
         ELSE excluded.status
       END,
       items_scanned = MAX(prospect_backfill_coverage.items_scanned, excluded.items_scanned),
       signals_recorded = MAX(prospect_backfill_coverage.signals_recorded, excluded.signals_recorded),
       prospects_upserted = MAX(prospect_backfill_coverage.prospects_upserted, excluded.prospects_upserted),
       classifications_pending = excluded.classifications_pending,
       completed_at = excluded.completed_at,
       error_message = excluded.error_message,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    crypto.randomUUID(),
    orgId,
    input.runId || null,
    input.sourceFamily,
    input.windowStart,
    input.windowEnd,
    input.status,
    input.itemsScanned,
    input.signalsRecorded,
    input.prospectsUpserted,
    input.classificationsPending || 0,
    input.error ? compactProspectBackfillError(input.error) : null
	  ).run();
	}

function parseEmailList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
  } catch {}
  return text.split(/[;,]/).map(part => part.trim()).filter(Boolean);
}

function estimateProspectBackfillCost(items: number, measuredCostPerItemUsd?: number | null): number | null {
  if (measuredCostPerItemUsd == null || !Number.isFinite(measuredCostPerItemUsd)) return null;
  return items * measuredCostPerItemUsd;
}

async function createProspectBackfillRun(
  orgId: string,
  env: Env,
  input: ProspectBackfillWindowInput,
  sourceFamilies: ProspectBackfillSourceFamily[]
): Promise<string> {
  if (input.runId) return input.runId;
  const runId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospect_backfill_runs (
       id, org_id, window_start, window_end, cursor, status, source_families,
       measured_cost_per_item, estimated_total_cost, started_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    runId,
    orgId,
    input.windowStart,
    input.windowEnd,
    input.windowEnd,
    JSON.stringify(sourceFamilies),
    input.measuredCostPerItemUsd ?? null
  ).run();
  return runId;
}

async function readProspectSourceR2Text(env: Env, key?: string | null, maxChars = PROSPECT_SOURCE_TEXT_MAX_CHARS): Promise<string | null> {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || !env.R2?.get) return null;
  try {
    const object = await env.R2.get(normalizedKey);
    if (!object) return null;
    const text = await object.text();
    return text ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

async function readProspectDocumentR2Text(
  env: Env,
  input: { key?: string | null; fileName?: string | null; title?: string | null; id?: string | null; mimeType?: string | null },
  maxChars = PROSPECT_SOURCE_TEXT_MAX_CHARS
): Promise<string | null> {
  const normalizedKey = String(input.key || '').trim();
  if (!normalizedKey || !env.R2?.get) return null;
  try {
    const object = await env.R2.get(normalizedKey);
    if (!object) return null;
    const buffer = await object.arrayBuffer();
    const { extractTextFromFile } = await import('./file-extraction');
    const fileName = input.fileName || input.title || input.id || normalizedKey.split('/').pop() || 'document';
    const text = await extractTextFromFile(new File([buffer], fileName, { type: input.mimeType || '' }));
    return text ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

const BACKFILL_SOURCE_POOL_MIN = 200;
const BACKFILL_SOURCE_POOL_MAX = 1000;
const BACKFILL_SOURCE_POOL_MULTIPLIER = 8;

type BackfillSourceRow = Record<string, any>;

function sourcePoolLimitForBatch(limit: number): number {
  return Math.min(
    BACKFILL_SOURCE_POOL_MAX,
    Math.max(BACKFILL_SOURCE_POOL_MIN, Math.floor(limit * BACKFILL_SOURCE_POOL_MULTIPLIER))
  );
}

function normalizeBackfillSourceText(value: unknown): string {
  return normalizeWhitespace(String(value || ''))
    .toLowerCase()
    .replace(/^(?:re|fw|fwd)\s*:\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function prospectBackfillSourceScore(row: BackfillSourceRow, family: ProspectBackfillSourceFamily): number {
  const text = normalizeBackfillSourceText([
    row.subject,
    row.title,
    row.body_preview,
    row.extracted_text_preview,
    row.description,
    row.summary,
    row.document_type,
    row.file_name,
    row.from_email,
  ].filter(Boolean).join('\n'));
  let score = 0;

  const strongSignals: Array<[RegExp, number]> = [
    [/\b(?:intro|introduction|introducing|connect(?:ing)?|warm intro)\b/, 18],
    [/\b(?:pitch|deck|teaser|cim|one[-\s]?pager|company\s+2\s+pager|company\s+one[-\s]?pager|pre[-\s]?read|background information)\b/, 18],
    [/\b(?:data room|diligence|financial model|p&l|profit and loss|term sheet|transaction document|investment memo)\b/, 16],
    [/\b(?:raising|fundrais(?:e|ing)|round|series\s+[abc]|seed round|safe|allocation)\b/, 14],
    [/\b(?:acquisition opportunity|acquisition opp|investment opportunity|opportunity)\b/, 12],
    [/\b(?:founder|co[-\s]?founder|ceo|chief executive)\b/, 8],
    [/\b(?:demo|pilot|materials|business plan)\b/, 8],
  ];
  for (const [pattern, weight] of strongSignals) {
    if (pattern.test(text)) score += weight;
  }

  const weakOpsSignals: Array<[RegExp, number]> = [
    [/\b(?:invoice|receipt|bank statement|deposit account|wire transfer|capital call|tax document|k-1|payroll|gusto)\b/, -18],
    [/\b(?:newsletter|webinar|roundtable|conference reminder|daily digest|meeting report is ready)\b/, -8],
    [/\b(?:phishing|quarantined|spam|payment due)\b/, -20],
  ];
  for (const [pattern, weight] of weakOpsSignals) {
    if (pattern.test(text)) score += weight;
  }

  if (Number(row.has_attachments || 0) > 0 || Number(row.attachment_count || 0) > 0) score += 6;
  if (family === 'document') score += 3;
  if (family === 'event' && /\b(?:intro|diligence|demo|ventures|medina)\b/.test(text)) score += 4;
  if (row.from_email && !isInternalEmailDomain(String(row.from_email), new Set(['medinavc.com', 'medinacapital.com']))) score += 4;
  return score;
}

function backfillSourceDedupeKey(row: BackfillSourceRow, family: ProspectBackfillSourceFamily): string {
  if (family === 'conversation') {
    const subject = normalizeBackfillSourceText(row.subject);
    const preview = normalizeBackfillSourceText(row.body_preview).slice(0, 240);
    return [
      'conversation',
      String(row.from_email || '').toLowerCase(),
      String(row.sent_at || ''),
      subject,
      preview,
    ].join('|');
  }
  if (family === 'event') {
    return [
      'event',
      String(row.start_time || ''),
      normalizeBackfillSourceText(row.title),
      normalizeBackfillSourceText(row.location),
    ].join('|');
  }
  return [
    'document',
    String(row.content_hash || '').toLowerCase(),
    normalizeBackfillSourceText(row.title || row.file_name),
    String(row.created_at || ''),
  ].join('|');
}

function rankAndDedupeBackfillSourceRows(
  rows: BackfillSourceRow[],
  family: ProspectBackfillSourceFamily,
  limit: number
): BackfillSourceRow[] {
  const seen = new Set<string>();
  return rows
    .map(row => ({
      row,
      score: prospectBackfillSourceScore(row, family),
      occurredAt: String(row.sent_at || row.start_time || row.created_at || ''),
      id: String(row.id || ''),
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.occurredAt.localeCompare(a.occurredAt) ||
      a.id.localeCompare(b.id)
    )
    .filter(entry => {
      const key = backfillSourceDedupeKey(entry.row, family);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(entry => entry.row);
}

async function loadBackfillItemsForFamily(
  orgId: string,
  env: Env,
  family: ProspectBackfillSourceFamily,
  windowStart: string,
  windowEnd: string,
  limit: number
): Promise<ClassifiedItem[]> {
  const poolLimit = sourcePoolLimitForBatch(limit);
  if (family === 'conversation') {
    const rows = await env.D1.prepare(
      `SELECT id, source, external_thread_id, external_message_id, subject, body_preview, sent_at,
              from_email, to_emails, cc_emails, direction, has_attachments, attachment_count,
              'private' AS visibility, participant_user_ids, body_r2_key
         FROM conversations
        WHERE org_id = ? AND sent_at >= ? AND sent_at < ?
        ORDER BY sent_at DESC
        LIMIT ?`
    ).bind(orgId, windowStart, windowEnd, poolLimit).all<any>();
    const selectedRows = rankAndDedupeBackfillSourceRows(rows.results || [], family, limit);
    return Promise.all(selectedRows.map(async row => {
      const bodyText = await readProspectSourceR2Text(env, row.body_r2_key) || row.body_preview || '';
      return {
        type: row.source === 'slack' ? 'slack_message' : 'email',
        source: row.source === 'slack' ? 'slack' : 'outlook',
        externalId: row.id,
        subject: row.subject || '',
        bodyText,
        bodyPreview: row.body_preview || bodyText.slice(0, 500),
        fromEmail: row.from_email || '',
        toEmails: parseEmailList(row.to_emails),
        ccEmails: parseEmailList(row.cc_emails),
        sentAt: row.sent_at,
        direction: row.direction || undefined,
        orgId,
        visibility: row.visibility || 'private',
        entityType: 'conversation',
        entityId: row.id,
        contactIds: [],
        participantUserIds: parseEmailList(row.participant_user_ids),
        metadata: {
          org_id: orgId,
          visibility: row.visibility || 'private',
          document_type: row.source === 'slack' ? 'slack' : 'email',
          source_table: 'conversations',
          source_id: row.id,
          r2_key: row.body_r2_key || '',
          created_at: row.sent_at,
          primary_entity_id: row.id,
        },
        text: bodyText,
      } as ClassifiedItem;
    }));
  }
  if (family === 'event') {
    const rows = await env.D1.prepare(
      `SELECT id, title, description, summary, start_time, created_at, location, source, transcript_r2_key
         FROM events
        WHERE org_id = ? AND deleted_at IS NULL
          AND (
            (start_time >= ? AND start_time < ?)
            OR (created_at >= ? AND created_at < ? AND start_time >= ? AND start_time < ?)
          )
        ORDER BY start_time DESC
        LIMIT ?`
    ).bind(orgId, windowStart, windowEnd, windowStart, windowEnd, windowStart, windowEnd, poolLimit).all<any>();
    const selectedRows = rankAndDedupeBackfillSourceRows(rows.results || [], family, limit);
    return Promise.all(selectedRows.map(async row => {
      const fallbackText = row.summary || row.description || '';
      const bodyText = await readProspectSourceR2Text(env, row.transcript_r2_key) || fallbackText;
      return {
        type: 'calendar_event',
        source: 'outlook',
        externalId: row.id,
        subject: row.title || '',
        bodyText,
        bodyPreview: fallbackText || bodyText.slice(0, 500),
        fromEmail: '',
        toEmails: [],
        ccEmails: [],
        sentAt: row.start_time,
        orgId,
        visibility: 'private',
        entityType: 'event',
        entityId: row.id,
        contactIds: [],
        metadata: {
          org_id: orgId,
          visibility: 'private',
          document_type: 'meeting',
          source_table: 'events',
          source_id: row.id,
          r2_key: row.transcript_r2_key || '',
          created_at: row.start_time,
          primary_entity_id: row.id,
        },
        text: bodyText,
      } as ClassifiedItem;
    }));
  }
  const rows = await env.D1.prepare(
    `SELECT id, title, extracted_text_preview, document_type, source, visibility,
            participant_user_ids, created_at, file_name, content_hash, r2_key, mime_type
       FROM documents
      WHERE org_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(orgId, windowStart, windowEnd, poolLimit).all<any>();
  const selectedRows = rankAndDedupeBackfillSourceRows(rows.results || [], family, limit);
  return Promise.all(selectedRows.map(async row => {
    const r2Text = await readProspectDocumentR2Text(env, {
      key: row.r2_key,
      fileName: row.file_name,
      title: row.title,
      id: row.id,
      mimeType: row.mime_type,
    });
    const bodyText = r2Text || row.extracted_text_preview || '';
    return {
      type: 'document',
      source: 'outlook',
      externalId: row.id,
      subject: row.title || '',
      bodyText,
      bodyPreview: row.extracted_text_preview || bodyText.slice(0, 500),
      fromEmail: '',
      toEmails: [],
      ccEmails: [],
      sentAt: row.created_at,
      orgId,
      visibility: row.visibility || 'private',
      entityType: 'document',
      entityId: row.id,
      contactIds: [],
      participantUserIds: parseEmailList(row.participant_user_ids),
      metadata: {
        org_id: orgId,
        visibility: row.visibility || 'private',
        document_type: row.document_type || row.source || 'document',
        source_table: 'documents',
        source_id: row.id,
        r2_key: row.r2_key || '',
        created_at: row.created_at,
        primary_entity_id: row.id,
        text_source: r2Text ? 'r2_full_text' : row.extracted_text_preview ? 'preview_fallback' : 'empty',
      },
      text: bodyText,
    } as any;
  }));
}

export async function runProspectBackfillWindow(
  orgId: string,
  env: Env,
  input: ProspectBackfillWindowInput
): Promise<ProspectBackfillWindowResult> {
  const sourceFamilies: ProspectBackfillSourceFamily[] = input.sourceFamilies && input.sourceFamilies.length > 0
    ? input.sourceFamilies
    : ['conversation', 'event', 'document'];
  const limit = Math.min(Math.max(Number(input.batchLimit || 100), 1), 500);
  const sliceSize = Math.min(
    Math.max(Number(input.sliceSize || PROSPECT_BACKFILL_DEFAULT_SLICE_SIZE), 1),
    PROSPECT_BACKFILL_MAX_SLICE_SIZE
  );
  const runId = await createProspectBackfillRun(orgId, env, input, sourceFamilies);
  let itemsFound = 0;
  let itemsProcessed = 0;
  let signalsRecorded = 0;
  let prospectsUpserted = 0;
  let classificationsPending = 0;
  let runStatus: 'completed' | 'partial' = 'completed';
  let runError: string | null = null;

  for (const family of sourceFamilies) {
    const items = await loadBackfillItemsForFamily(orgId, env, family, input.windowStart, input.windowEnd, limit);
    itemsFound += items.length;
    const stats = emptyStats(0);
    let familyDeferrableError: string | null = null;
    for (let offset = 0; offset < items.length; offset += sliceSize) {
      const slice = items.slice(offset, offset + sliceSize);
      const sliceStats = await detectAndRecordProspectSignals(slice, orgId, env, { ingestionMode: 'backfill' });
      mergeProspectDetectionStats(stats, sliceStats);
      const deferrable = sliceStats.errors.find(error => isProspectBackfillDeferrableError(error.error));
      if (deferrable) {
        familyDeferrableError = deferrable.error;
        break;
      }
    }
    itemsProcessed += stats.items_scanned;
    signalsRecorded += stats.signals_recorded;
    prospectsUpserted += stats.prospects_upserted;
    classificationsPending += stats.classifications_pending;
    const familyError = familyDeferrableError || stats.errors[0]?.error || null;
    if (familyError) {
      runStatus = 'partial';
      runError ||= compactProspectBackfillError(familyError);
    }
    try {
      await recordProspectBackfillCoverage(orgId, env, {
        runId,
        sourceFamily: family,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        itemsScanned: stats.items_scanned,
        signalsRecorded: stats.signals_recorded,
        prospectsUpserted: stats.prospects_upserted,
        classificationsPending: stats.classifications_pending,
        status: familyError ? 'partial' : 'completed',
        error: familyError,
      });
    } catch (e) {
      runStatus = 'partial';
      runError ||= `coverage_record_failed:${compactProspectBackfillError(e)}`;
      console.warn('[prospect-intelligence] backfill coverage recording failed', {
        org_id: orgId,
        run_id: runId,
        source_family: family,
        window_start: input.windowStart,
        window_end: input.windowEnd,
        error: compactProspectBackfillError(e),
      });
    }
    if (familyDeferrableError) break;
  }

  let reconciliation: Awaited<ReturnType<typeof runProspectReconciliation>>;
  try {
    reconciliation = await runProspectReconciliation(orgId, env);
  } catch (e) {
    runStatus = 'partial';
    runError ||= `reconciliation_failed:${compactProspectBackfillError(e)}`;
    console.warn('[prospect-intelligence] backfill reconciliation failed', {
      org_id: orgId,
      run_id: runId,
      window_start: input.windowStart,
      window_end: input.windowEnd,
      error: compactProspectBackfillError(e),
    });
    reconciliation = {
      scanned: 0,
      converted: 0,
      duplicate_links: 0,
      resolved_soft_states: 0,
      pending_classifications: 0,
    };
  }
  await env.D1.prepare(
    `UPDATE prospect_backfill_runs
        SET status = ?,
            cursor = ?,
            items_found = ?,
            items_processed = ?,
            signals_recorded = ?,
            estimated_total_cost = ?,
            last_error = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    runStatus,
    input.windowStart,
    itemsFound,
    itemsProcessed,
    signalsRecorded,
    estimateProspectBackfillCost(itemsFound, input.measuredCostPerItemUsd),
    runError,
    runId,
    orgId
  ).run();

  return {
    run_id: runId,
    window_start: input.windowStart,
    window_end: input.windowEnd,
    items_found: itemsFound,
    items_processed: itemsProcessed,
    signals_recorded: signalsRecorded,
    prospects_upserted: prospectsUpserted,
    classifications_pending: classificationsPending,
    source_families: sourceFamilies,
    reconciliation,
  };
}

export async function runProspectReconciliation(orgId: string, env: Env): Promise<{ scanned: number; converted: number; duplicate_links: number; resolved_soft_states: number; pending_classifications: number }> {
  const rows = await env.D1.prepare(
    `SELECT id, canonical_name, normalized_name, domain, website, status, signal_count, evidence_count, created_at, possible_deal_id, possible_duplicate_of
      FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND status IN ('active','provisional')
      ORDER BY updated_at ASC
      LIMIT 500`
  ).bind(orgId).all<{
    id: string; canonical_name: string; normalized_name: string; domain: string | null; website: string | null; status: string | null; signal_count: number | null; evidence_count: number | null; created_at: string | null; possible_deal_id: string | null; possible_duplicate_of: string | null;
  }>();

  let converted = 0;
  let duplicateLinks = 0;
  let resolvedSoftStates = 0;
  for (const p of rows.results) {
    if (p.domain) {
      const deal = await env.D1.prepare(
        `SELECT d.id
           FROM deals d
           JOIN companies c ON c.id = d.company_id
          WHERE d.org_id = ? AND d.deleted_at IS NULL AND d.stage != 'closed'
            AND lower(c.domain) = lower(?)
          LIMIT 1`
      ).bind(orgId, p.domain).first<{ id: string }>();
      if (deal?.id) {
        await env.D1.prepare(
          `UPDATE prospects
              SET status = 'converted',
                  deal_id = ?,
                  possible_deal_id = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND org_id = ?`
        ).bind(deal.id, deal.id, p.id, orgId).run();
        converted++;
        continue;
      }
    }

    const dup = bestDuplicateWinnerForProspect(p, rows.results);
    if (dup?.winner.id && p.possible_duplicate_of !== dup.winner.id) {
      await env.D1.prepare(
        `UPDATE prospects
            SET possible_duplicate_of = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(dup.winner.id, p.id, orgId).run();
      await env.D1.prepare(
        `INSERT OR IGNORE INTO prospect_soft_links
           (id, org_id, prospect_id, link_type, target_type, target_id, score, evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, 'possible_duplicate', 'prospect', ?, ?, ?,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(
        crypto.randomUUID(),
        orgId,
        p.id,
        dup.winner.id,
        dup.score,
        JSON.stringify({ method: dup.method, req: 'REQ-ID-8' })
      ).run();
      duplicateLinks++;
    }

    const unresolved = await env.D1.prepare(
      `SELECT
          SUM(CASE WHEN classification_status != 'classified' THEN 1 ELSE 0 END) AS pending_classifications,
          SUM(CASE WHEN resolution_status = 'pending' THEN 1 ELSE 0 END) AS pending_resolution,
          SUM(CASE WHEN direction_uncertain = 1 THEN 1 ELSE 0 END) AS direction_uncertain,
          SUM(CASE WHEN sector_key = 'uncategorized' THEN 1 ELSE 0 END) AS uncategorized,
          SUM(CASE WHEN COALESCE(json_extract(COALESCE(metadata_json, '{}'), '$.prospect_second_look.required'), 0) = 1 THEN 1 ELSE 0 END) AS second_look_pending,
          AVG(confidence) AS avg_confidence
         FROM prospect_signals
        WHERE org_id = ? AND prospect_id = ?`
    ).bind(orgId, p.id).first<{
      pending_classifications: number | null; pending_resolution: number | null; direction_uncertain: number | null; uncategorized: number | null; second_look_pending: number | null; avg_confidence: number | null;
    }>();
    const canResolve =
      Number(unresolved?.pending_classifications || 0) === 0 &&
      Number(unresolved?.direction_uncertain || 0) === 0 &&
      Number(unresolved?.uncategorized || 0) === 0 &&
      Number(unresolved?.second_look_pending || 0) === 0 &&
      Number(unresolved?.avg_confidence || 0) >= 0.82;
    if (canResolve) {
      await env.D1.prepare(
        `UPDATE prospects
            SET status = CASE WHEN status = 'provisional' THEN 'active' ELSE status END,
                provisional = 0,
                direction_uncertain = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?
            AND (status = 'provisional' OR provisional = 1 OR direction_uncertain = 1)`
      ).bind(p.id, orgId).run();
      await env.D1.prepare(
        `UPDATE prospect_signals
            SET resolution_status = 'resolved',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE org_id = ? AND prospect_id = ?
            AND classification_status = 'classified'
            AND direction_uncertain = 0
            AND sector_key != 'uncategorized'
            AND COALESCE(json_extract(COALESCE(metadata_json, '{}'), '$.prospect_second_look.required'), 0) != 1`
      ).bind(orgId, p.id).run();
      resolvedSoftStates++;
    }
  }

  const pending = await env.D1.prepare(
    `SELECT COUNT(*) AS n
       FROM prospect_signals
      WHERE org_id = ?
        AND (classification_status != 'classified' OR resolution_status = 'pending')`
  ).bind(orgId).first<{ n: number }>();

  return {
    scanned: rows.results.length,
    converted,
    duplicate_links: duplicateLinks,
    resolved_soft_states: resolvedSoftStates,
    pending_classifications: pending?.n || 0,
  };
}

export async function mergeProspects(
  orgId: string,
  winnerProspectId: string,
  loserProspectId: string,
  env: Env,
  options: { method: string; score: number; alternatives?: unknown[] }
): Promise<{ audit_id: string; moved_signals: number }> {
  if (winnerProspectId === loserProspectId) throw new Error('PROSPECT_MERGE_SELF');
  const [winner, loser, signals] = await Promise.all([
    env.D1.prepare(`SELECT * FROM prospects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).bind(winnerProspectId, orgId).first<any>(),
    env.D1.prepare(`SELECT * FROM prospects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).bind(loserProspectId, orgId).first<any>(),
    env.D1.prepare(`SELECT id FROM prospect_signals WHERE org_id = ? AND prospect_id = ?`).bind(orgId, loserProspectId).all<{ id: string }>(),
  ]);
  if (!winner || !loser) throw new Error('PROSPECT_MERGE_NOT_FOUND');

  const signalIds = (signals.results || []).map(row => row.id);
  await env.D1.prepare(
    `UPDATE prospect_signals
        SET prospect_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ? AND prospect_id = ?`
  ).bind(winnerProspectId, orgId, loserProspectId).run();
  await env.D1.prepare(
    `UPDATE prospects
        SET status = 'merged',
            possible_duplicate_of = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(winnerProspectId, loserProspectId, orgId).run();
  await env.D1.prepare(
    `INSERT OR IGNORE INTO prospect_soft_links
       (id, org_id, prospect_id, link_type, target_type, target_id, score, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, 'possible_duplicate', 'prospect', ?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    crypto.randomUUID(),
    orgId,
    loserProspectId,
    winnerProspectId,
    options.score,
    JSON.stringify({ method: options.method, req: 'REQ-ID-7' })
  ).run();
  await refreshProspectAggregate(winnerProspectId, orgId, env).catch(() => undefined);

  const auditId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospect_merge_audit (
       id, org_id, action, winner_prospect_id, loser_prospect_id, method, score,
       moved_signal_ids, alternatives_json, previous_loser_status,
       previous_winner_snapshot, previous_loser_snapshot, created_at
     ) VALUES (?, ?, 'merge', ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    auditId,
    orgId,
    winnerProspectId,
    loserProspectId,
    options.method,
    options.score,
    JSON.stringify(signalIds),
    JSON.stringify(options.alternatives || []),
    loser.status || null,
    JSON.stringify(winner),
    JSON.stringify(loser)
  ).run();

  return { audit_id: auditId, moved_signals: signalIds.length };
}

export async function reverseProspectMerge(
  orgId: string,
  auditId: string,
  env: Env
): Promise<{ audit_id: string; restored_signals: number }> {
  const audit = await env.D1.prepare(
    `SELECT winner_prospect_id, loser_prospect_id, moved_signal_ids, previous_loser_status, score, method
       FROM prospect_merge_audit
      WHERE id = ? AND org_id = ? AND action = 'merge'
      LIMIT 1`
  ).bind(auditId, orgId).first<{
    winner_prospect_id: string; loser_prospect_id: string; moved_signal_ids: string; previous_loser_status: string | null; score: number; method: string;
  }>();
  if (!audit) throw new Error('PROSPECT_MERGE_AUDIT_NOT_FOUND');
  let signalIds: string[] = [];
  try {
    const parsed = JSON.parse(audit.moved_signal_ids || '[]');
    if (Array.isArray(parsed)) signalIds = parsed.filter(id => typeof id === 'string');
  } catch {}
  if (signalIds.length > 0) {
    const ph = signalIds.map(() => '?').join(',');
    await env.D1.prepare(
      `UPDATE prospect_signals
          SET prospect_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE org_id = ? AND id IN (${ph})`
    ).bind(audit.loser_prospect_id, orgId, ...signalIds).run();
  }
  await env.D1.prepare(
    `UPDATE prospects
        SET status = COALESCE(?, 'active'),
            possible_duplicate_of = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(audit.previous_loser_status, audit.loser_prospect_id, orgId).run();
  await Promise.all([
    refreshProspectAggregate(audit.winner_prospect_id, orgId, env).catch(() => undefined),
    refreshProspectAggregate(audit.loser_prospect_id, orgId, env).catch(() => undefined),
  ]);

  const reverseAuditId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospect_merge_audit (
       id, org_id, action, winner_prospect_id, loser_prospect_id, method, score,
       moved_signal_ids, alternatives_json, previous_loser_status, created_at
     ) VALUES (?, ?, 'unmerge', ?, ?, ?, ?, ?, '[]', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    reverseAuditId,
    orgId,
    audit.winner_prospect_id,
    audit.loser_prospect_id,
    `reverse:${audit.method}`,
    audit.score,
    JSON.stringify(signalIds),
    audit.previous_loser_status
  ).run();
  return { audit_id: reverseAuditId, restored_signals: signalIds.length };
}

export const __prospectIntelligenceTestHooks = {
  normalizeProspectName,
  canonicalizeMention,
  cleanProspectSourceText,
  prospectContextWindow,
  extractMentionCandidatesFromText,
  extractStructuredTargetMentionsFromSource,
  extractOrganizationMentionsFromSource,
  parseDealflowList,
  firstProspectDomainForMention,
  prospectIdentityAliasesForName,
  dedupeMentionIdentityCandidates,
  scoreProspectRowDuplicate,
  prospectBackfillSourceScore,
  rankAndDedupeBackfillSourceRows,
  sourcePrefilter,
  hasSourceLevelTargetRecoveryIntent,
  shouldRunSourceTargetRecovery,
  productionSamplingDecision,
  sameCompanyForEnrichment,
  enrichmentCandidateIsCorroborated,
  computeSignalStrength,
  sectorHintForText,
  buildClassifierPrefilter,
  buildProspectClassifierPrompt,
  buildProspectSourceClassifierPrompt,
  buildProspectReasoningJudgePrompt,
  hasClassifierContradictoryTargetIntent,
  candidateProspectTargetEvidenceReasons,
  rawExcerptForPrompt,
  classifierInputForRuntime,
  classifierReasoningHasHardNegativeRole,
  sourceInvestorUpdateTitleTargetName,
  correctedProspectCompanyNameFromEvidence,
  hasSubjectLineTargetInvestmentEvidence,
  hasStrongCandidatePitchMaterialEvidence,
  hasPrivatePitchDocumentTargetEvidence,
  hasDirectInvestorForwardedRoundEvidence,
  hasFounderBriefFollowupCreateEvidence,
  buildProspectSecondLookPacket,
  acceptedSecondLookCreateBlockReason,
  classificationRequiresSecondLook,
  prospectValuableActionVetoForMention,
  classifyCompanyRoleFromD1,
  verifyLowConfidenceProspect,
  isProspectBackfillDeferrableError,
  prospectCreateVetoForMention,
  parseProspectClassifierResponse,
  parseProspectSourceClassifierResponse,
  parseProspectReasoningJudgeResponse,
  parseProspectFinalQualityGateResponse,
  finalQualityBatchRows,
  enforceProspectFinalQualityDecision,
  applyFinalQualityDecisionToOutcome,
  finalQualityReasoningTargetCanonicalName,
  finalQualityFallbackTargetProof,
  finalQualityHardBlockReason,
  finalQualitySurgicalRoleBlockReason,
  finalQualityHasDirectForProfitInvestmentEvidence,
  finalQualityGenericDescriptorReason,
  fallbackProspectFinalQualityDecision,
  suppressSourceAliasDuplicateCreates,
  parseDirection,
  parseMentionType,
  parseProspectAction,
  parseSectorKey,
};

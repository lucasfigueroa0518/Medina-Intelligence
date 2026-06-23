#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Papa from 'papaparse';

import {
  resolveCrmEntityNameWithEvidence,
  type BuildCrmNameEvidenceBundleInput,
  type CrmNameEvidenceCandidate,
  type CrmNameResolutionWithEvidence,
} from '../src/lib/crm-name-resolver';
import type { CrmEntityType } from '../src/lib/crm-quality-gate';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');
const DEFAULT_EXPERIMENT_DIR = join(
  DEFAULT_OUTPUT_ROOT,
  `crm-name-quality-experiment-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`
);
const GOLD_CONTRACT = join(DEFAULT_OUTPUT_ROOT, 'crm-quality-approved-gold-contract.csv');
const APPROVED_CANARY = join(DEFAULT_OUTPUT_ROOT, 'approved-baseline-canary-200.csv');
const LATEST_LOCAL_REPLAY = join(
  DEFAULT_OUTPUT_ROOT,
  'crm-quality-local-d1-replay-final-hardening-20260623',
  'crm-quality-name-resolution-decisions.csv'
);
const CLOUD_300_DIR = join(DEFAULT_OUTPUT_ROOT, 'crm-quality-cloud-canary-20260622-300-v1');
const CLOUD_300_CLEAN_REVIEW = join(CLOUD_300_DIR, 'cloud-canary-codex-name-validity-review.csv');
const CLOUD_300_BAD_VERIFIED = join(CLOUD_300_DIR, 'cloud-canary-bad-verified-names.csv');

type ExperimentCohort =
  | 'false_positive_regression'
  | 'uncertain_verified_regression'
  | 'approved_recall_suite'
  | 'clean_negative_controls'
  | 'fresh_blind_generalization';

type ProducedStatus = 'verified' | 'provisional' | 'domain_placeholder' | 'none' | 'timeout' | 'fail' | string;

interface Args {
  outputDir: string;
  experimentId: string;
  localReplayPath: string;
  approvedFullReplayPath?: string;
  cloudReviewPath: string;
  badVerifiedPath: string;
  freshReviewPath?: string;
  cleanControlTotal: number;
  runResolverForCleanControls: boolean;
}

export interface ExperimentManifestRow {
  experiment_id: string;
  cohort: ExperimentCohort;
  entity_type: CrmEntityType;
  entity_id: string;
  org_id: string;
  mode: string;
  trigger_codepath: string;
  source_snapshot_name_for_review: string;
  email: string;
  domain: string;
  website: string;
  company_context: string;
  expected_name: string;
  expected_status: string;
  gold_available: boolean;
  runtime_allowed_fields: string;
}

export interface ExperimentRuntimeRow extends ExperimentManifestRow {
  produced_name: string;
  produced_name_status: ProducedStatus;
  ui_tag_if_created: string;
  confidence: string;
  resolver_reason: string;
  semantic_class: string;
  risk_flags: string;
  verification_decision: string;
  firewall_block_reason: string;
  status_before_firewall: string;
  status_after_firewall: string;
  evidence_source_types: string;
  network_calls: number;
  gold_used_at_runtime: boolean;
  production_rows_written: number;
  runtime_source_channel: string;
  runtime_codepath: string;
  runtime_source_fields_used: string;
  runtime_metadata_fetched_live: boolean;
}

export interface CodexAdjudicationRow extends ExperimentRuntimeRow {
  codex_name_valid: 'yes' | 'no' | 'uncertain';
  codex_status_valid: 'yes' | 'no' | 'uncertain';
  codex_final_pass: 'yes' | 'no' | 'uncertain';
  codex_validity_class: string;
  codex_recommended_name_or_action: string;
  codex_review_reason: string;
  gap_cluster: string;
  fix_priority: 'P0' | 'P1' | 'P2' | 'P3';
}

interface GapMatrixRow {
  cohort: string;
  entity_type: string;
  gap_cluster: string;
  codex_validity_class: string;
  produced_name_status: string;
  count: number;
  example_entity_ids: string;
  example_produced_names: string;
  recommended_fix: string;
  fix_priority: string;
}

interface Summary {
  experiment_id: string;
  generated_at: string;
  output_dir: string;
  manifest_rows: number;
  runtime_rows: number;
  adjudicated_rows: number;
  production_rows_written: number;
  runtime_gold_contamination_rows: number;
  counts_by_cohort: Record<string, number>;
  pass_by_cohort: Record<string, { pass: number; fail: number; uncertain: number }>;
  status_counts: Record<string, number>;
  gap_counts: Record<string, number>;
  bad_verified_count: number;
  uncertain_verified_count: number;
  artifacts: Record<string, string>;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(value: unknown): string {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp|gmbh|spa|sgr|sa|sl|ag|bv)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function readCsv<T extends Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = Papa.parse<T>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) {
    throw new Error(`CSV_PARSE_FAILED:${path}:${parsed.errors.map(error => error.message).join('; ')}`);
  }
  return parsed.data;
}

function csv<T extends object>(rows: T[]): string {
  return `${Papa.unparse(rows as Record<string, unknown>[], { quotes: true, newline: '\n' })}\n`;
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      i += 1;
    }
  }
  const experimentId = clean(raw.get('experiment-id')) || `crm-name-quality-experiment-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
  return {
    experimentId,
    outputDir: resolve(raw.get('output-dir') || DEFAULT_EXPERIMENT_DIR),
    localReplayPath: resolve(raw.get('local-replay') || LATEST_LOCAL_REPLAY),
    approvedFullReplayPath: raw.get('approved-full-replay') ? resolve(raw.get('approved-full-replay')!) : undefined,
    cloudReviewPath: resolve(raw.get('cloud-review') || CLOUD_300_CLEAN_REVIEW),
    badVerifiedPath: resolve(raw.get('bad-verified') || CLOUD_300_BAD_VERIFIED),
    freshReviewPath: raw.get('fresh-review') ? resolve(raw.get('fresh-review')!) : undefined,
    cleanControlTotal: Math.max(0, Number(raw.get('clean-controls') || 300)),
    runResolverForCleanControls: raw.get('skip-clean-control-runtime') !== 'true',
  };
}

function looksLikeDomain(value: string): boolean {
  const text = clean(value).toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/.test(text.replace(/^https?:\/\//, '').replace(/^www\./, ''));
}

function sourceLooksCleanCompanyName(value: string): boolean {
  const text = clean(value);
  if (!text || looksLikeDomain(text)) return false;
  if (/^(home|index of|mysite|untitled|login|sign in|contact us|about us)$/i.test(text)) return false;
  if (/[|:–-]/.test(text) && /\b(for|with|to|at|home|platform|solutions|services|security|computing|everywhere)\b/i.test(text)) return false;
  return /[a-z]/i.test(text) && text.length >= 2 && text.length <= 90;
}

function titleSegmentLooksDescriptive(value: string): boolean {
  const text = clean(value);
  const tokenCount = (text.match(/[A-Za-z0-9&'.-]+/g) || []).length;
  return tokenCount >= 4
    || /\b(advisory|clarifying|developers?|funding|for|insurance\s+agency|inversiones|financiamiento|public\s+sector|resilient\s+founders|single-family\s+office|software|solutions?|services?|supporting|team|teams)\b/i.test(text);
}

function producedNameIsAcceptableTitleSegment(source: string, produced: string): boolean {
  if (!/[|:–—-]/.test(source)) return false;
  const parts = source
    .split(/\s+(?:[|\u2022\u00b7\u2013\u2014-])\s+|:/)
    .map(part => clean(part))
    .filter(Boolean);
  const producedKey = normalized(produced);
  const index = parts.findIndex(part => normalized(part) === producedKey);
  if (index < 0) return false;
  const before = parts.slice(0, index);
  const after = parts.slice(index + 1);
  if (index > 0 && before.some(titleSegmentLooksDescriptive)) return true;
  if (index === 0 && after.length && after.every(titleSegmentLooksDescriptive)) return true;
  return false;
}

function sourceLooksCleanContactName(value: string): boolean {
  const text = clean(value);
  if (!text || looksLikeDomain(text) || text.includes('@')) return false;
  if (/\b(service|support|desk|office|team|calendar|noreply|no-reply|info|sales|marketing|confirmation)\b/i.test(text)) return false;
  return /^[A-Za-z.'(), -]{2,80}$/.test(text) && /[a-z]/i.test(text);
}

function invalidCompanyReason(row: Pick<ExperimentRuntimeRow, 'produced_name' | 'produced_name_status' | 'source_snapshot_name_for_review' | 'semantic_class' | 'risk_flags' | 'resolver_reason'>): string {
  const name = clean(row.produced_name);
  const source = clean(row.source_snapshot_name_for_review);
  const nameLower = name.toLowerCase();
  if (!name) return 'blank_output';
  if (row.produced_name_status === 'domain_placeholder' && sourceLooksCleanCompanyName(source)) return 'domain_placeholder_over_clean_source';
  if (row.produced_name_status === 'verified' && looksLikeDomain(name)) return 'domain_verified_as_company_name';
  if (/\b(index of|mysite|untitled|not found|forbidden|privacy policy|terms of use|all rights reserved)\b/i.test(name)) return 'page_or_template_artifact';
  if (/\b(thank you for subscribing|receive our latest news|back to|powered by|learn more|get started|request a demo)\b/i.test(name)) return 'navigation_or_cta_artifact';
  if (/\b(intelligent computing everywhere|quantum powered security|capital & private debt)\b/i.test(name)) return 'tagline_or_descriptor_selected';
  if (/\band$/i.test(name) || /[,;:-]$/.test(name)) return 'broken_metadata_fragment';
  if (/\b(page_artifact|navigation_text|tagline_or_descriptor|compressed_neighbor|wrong_entity_conflict|directory_listing|template_artifact)\b/i.test(`${row.semantic_class} ${row.risk_flags}`)) {
    return 'resolver_flagged_semantic_risk';
  }
  const sourceTokens = source.split(/\s+/).filter(Boolean).length;
  if (
    row.produced_name_status === 'verified'
    && sourceTokens >= 2
    && /^[A-Za-z0-9]{13,}$/.test(name)
    && normalized(source).includes(normalized(name))
  ) return 'compressed_or_unspaced_name';
  if (
    row.produced_name_status === 'verified'
    && sourceLooksCleanCompanyName(source)
    && normalized(name).length < Math.max(4, normalized(source).length * 0.55)
    && !producedNameIsAcceptableTitleSegment(source, name)
  ) {
    return 'over_shortened_clean_source';
  }
  return '';
}

function invalidContactReason(row: Pick<ExperimentRuntimeRow, 'produced_name' | 'produced_name_status' | 'source_snapshot_name_for_review' | 'semantic_class' | 'risk_flags' | 'resolver_reason'>): string {
  const name = clean(row.produced_name);
  if (!name) return 'blank_output';
  if (/\b(service|support|desk|office|team|calendar|noreply|no-reply|confirmation|newsletter|events?)\b/i.test(name)) return 'non_person_or_service_contact';
  if (/\b(sent|get|from|reply|forwarded)\b$/i.test(name)) return 'email_header_action_word';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && normalized(parts[0]) && normalized(parts[0]) === normalized(parts[1])) return 'repeated_person_token';
  if (row.produced_name_status === 'verified' && (/^[A-Z]\.?\s+[A-Za-z-]+$/.test(name) || parts.length === 1)) return 'weak_person_name_marked_verified';
  if (/\b(non_person|email_header_action_word|service_or_shared_mailbox|company_as_contact|partial_person_name|repeated_person_token)\b/i.test(`${row.semantic_class} ${row.risk_flags}`)) {
    return 'resolver_flagged_semantic_risk';
  }
  return '';
}

function evidenceLooksAdmissible(row: ExperimentRuntimeRow): boolean {
  const evidence = clean(row.evidence_source_types);
  const reason = clean(row.resolver_reason);
  if (/\b(first_party_identity|email_signature|quoted_header|conversation_header|calendar_attendee|domain_metadata|source_payload|crm_neighbor|domain_owned_page)\b/i.test(evidence)) return true;
  return /\bevidence candidate resolved|clean source|page title stripped|domain stem corroborated\b/i.test(reason);
}

function recommendedFixFor(gapCluster: string, validityClass: string): string {
  if (gapCluster === 'semantic_firewall_gap') return 'Tighten semantic validation and verification firewall for this artifact/risk class.';
  if (gapCluster === 'status_assignment_gap') return 'Keep the selected name but downgrade status unless corroborating evidence satisfies the verification contract.';
  if (gapCluster === 'evidence_recall_gap') return 'Expand runtime evidence for this trigger before accepting placeholders or weak fallbacks.';
  if (gapCluster === 'source_extraction_gap') return 'Fix extraction/ranking so source payload clean names beat malformed metadata or neighbor strings.';
  if (gapCluster === 'scoring_contract_gap') return 'Review expected output/status contract and normalize allowed variants.';
  if (gapCluster === 'gold_disagreement') return 'Send to baseline contract review; runtime output may be more defensible than the expected label.';
  return `Investigate ${validityClass || 'unknown failure'} and add a regression fixture.`;
}

export function adjudicateExperimentRow(row: ExperimentRuntimeRow): CodexAdjudicationRow {
  const name = clean(row.produced_name);
  const expected = clean(row.expected_name);
  const source = clean(row.source_snapshot_name_for_review);
  const status = clean(row.produced_name_status);
  const isContact = row.entity_type === 'contact';
  const invalidReason = isContact ? invalidContactReason(row) : invalidCompanyReason(row);
  const expectedAvailable = row.gold_available && Boolean(expected);
  const nameMatchesExpected = expectedAvailable && normalized(name) === normalized(expected);
  const statusExpected = clean(row.expected_status);
  const expectedStatusOk = !statusExpected
    || statusExpected === 'none'
    || statusExpected === 'not_verified'
    || status === statusExpected
    || (statusExpected === 'verified' && status === 'provisional')
    || (statusExpected === 'provisional' && status === 'domain_placeholder');

  let codexNameValid: CodexAdjudicationRow['codex_name_valid'] = 'yes';
  let codexStatusValid: CodexAdjudicationRow['codex_status_valid'] = 'yes';
  let validityClass = isContact ? 'valid_contact_name' : 'valid_company_name';
  let recommended = name;
  let reason = 'Produced name is clean enough for the displayed status and source context.';
  let gapCluster = '';
  let priority: CodexAdjudicationRow['fix_priority'] = 'P3';

  if (row.production_rows_written !== 0 || row.gold_used_at_runtime) {
    codexNameValid = 'no';
    codexStatusValid = 'no';
    validityClass = 'invalid_experiment_safety_violation';
    recommended = 'rerun with production_rows_written=0 and gold_used_at_runtime=false';
    reason = 'Experiment safety contract was violated.';
    gapCluster = 'scoring_contract_gap';
    priority = 'P0';
  } else if (row.cohort === 'false_positive_regression' || row.cohort === 'uncertain_verified_regression') {
    if (status === 'verified' && invalidReason) {
      codexNameValid = 'no';
      codexStatusValid = 'no';
      validityClass = invalidReason;
      recommended = expected || 'downgrade or choose next safe candidate';
      reason = `Regression fixture still produced a verified unsafe name: ${invalidReason}.`;
      gapCluster = 'semantic_firewall_gap';
      priority = 'P0';
    } else if (status === 'verified' && expected && normalized(name) !== normalized(expected)) {
      codexNameValid = 'uncertain';
      codexStatusValid = 'uncertain';
      validityClass = 'regression_fixture_verified_clean_but_not_expected';
      recommended = expected;
      reason = 'The bad verified value appears fixed, but the verified replacement differs from the reviewed recommendation.';
      gapCluster = 'status_assignment_gap';
      priority = 'P2';
    } else {
      validityClass = status === 'verified'
        ? row.entity_type === 'contact' ? 'corrected_verified_contact_name' : 'corrected_verified_company_name'
        : status === 'provisional' || status === 'domain_placeholder'
          ? 'correctly_not_bad_verified'
          : 'bad_verified_blocked';
      reason = 'Regression fixture did not produce a bad verified name.';
    }
  } else if (expectedAvailable) {
    if (!nameMatchesExpected) {
      codexNameValid = 'no';
      validityClass = invalidReason || (status === 'domain_placeholder' ? 'expected_name_not_recovered_placeholder' : 'expected_name_not_recovered');
      recommended = expected;
      reason = `Expected "${expected}" but produced "${name || '(blank)'}".`;
      gapCluster = invalidReason ? 'semantic_firewall_gap' : 'evidence_recall_gap';
      priority = status === 'verified' && invalidReason ? 'P0' : 'P1';
    }
    if (!expectedStatusOk) {
      codexStatusValid = 'no';
      validityClass = validityClass === (isContact ? 'valid_contact_name' : 'valid_company_name') ? 'expected_status_mismatch' : validityClass;
      recommended = expected || recommended;
      reason = `${reason} Expected status ${statusExpected}, produced ${status || '(blank)'}.`;
      gapCluster = gapCluster || 'status_assignment_gap';
      priority = priority === 'P3' ? 'P1' : priority;
    }
  } else if (invalidReason) {
    const hardNonVerifiedFailure = invalidReason === 'domain_placeholder_over_clean_source';
    codexNameValid = status === 'verified' || hardNonVerifiedFailure ? 'no' : 'uncertain';
    codexStatusValid = status === 'verified' || hardNonVerifiedFailure ? 'no' : 'yes';
    validityClass = invalidReason;
    recommended = sourceLooksCleanContactName(source) || sourceLooksCleanCompanyName(source)
      ? source
      : 'downgrade/use tentative placeholder pending stronger evidence';
    reason = status === 'verified'
      ? `Name is semantically unsafe for verified status: ${invalidReason}.`
      : hardNonVerifiedFailure
        ? 'Domain placeholder was used even though the source snapshot contains a usable clean name.'
      : `Name has a weak/unsafe signal, but it is not marked verified.`;
    gapCluster = status === 'verified' ? 'semantic_firewall_gap' : hardNonVerifiedFailure ? 'source_extraction_gap' : 'evidence_recall_gap';
    priority = status === 'verified' ? 'P0' : hardNonVerifiedFailure ? 'P1' : 'P2';
  } else if (status === 'domain_placeholder') {
    if ((isContact && sourceLooksCleanContactName(source)) || (!isContact && sourceLooksCleanCompanyName(source))) {
      codexNameValid = 'no';
      codexStatusValid = 'no';
      validityClass = 'placeholder_over_clean_source';
      recommended = source;
      reason = 'Domain placeholder was used even though the source snapshot contains a usable clean name.';
      gapCluster = 'source_extraction_gap';
      priority = 'P1';
    } else {
      validityClass = 'valid_domain_placeholder';
      reason = 'No clean source name is available; domain placeholder is acceptable as tentative.';
    }
  } else if (status === 'provisional') {
    validityClass = isContact ? 'valid_tentative_contact_name' : 'valid_tentative_company_name';
    reason = 'Produced name is useful but correctly tagged tentative.';
  } else if (status === 'verified' && !evidenceLooksAdmissible(row)) {
    codexNameValid = 'uncertain';
    codexStatusValid = 'uncertain';
    validityClass = 'verified_without_visible_admissible_evidence';
    recommended = 'inspect evidence ledger; downgrade if no admissible source exists';
    reason = 'The name itself is plausible, but the shared schema does not expose enough admissible evidence to justify verified.';
    gapCluster = 'status_assignment_gap';
    priority = 'P2';
  }

  const finalPass = codexNameValid === 'yes' && codexStatusValid === 'yes'
    ? 'yes'
    : codexNameValid === 'no' || codexStatusValid === 'no'
      ? 'no'
      : 'uncertain';

  return {
    ...row,
    codex_name_valid: codexNameValid,
    codex_status_valid: codexStatusValid,
    codex_final_pass: finalPass,
    codex_validity_class: validityClass,
    codex_recommended_name_or_action: recommended,
    codex_review_reason: reason,
    gap_cluster: gapCluster || 'none',
    fix_priority: priority,
  };
}

function acceptedCandidateFields(result: CrmNameResolutionWithEvidence): Pick<ExperimentRuntimeRow, 'semantic_class' | 'risk_flags' | 'verification_decision' | 'firewall_block_reason' | 'status_before_firewall' | 'status_after_firewall' | 'evidence_source_types' | 'network_calls'> {
  const accepted = result.resolution.candidates.filter(candidate => candidate.accepted);
  return {
    semantic_class: [...new Set(accepted.map(candidate => candidate.semantic_class || '').filter(Boolean))].join('; '),
    risk_flags: [...new Set(accepted.flatMap(candidate => candidate.risk_flags || []))].join('; '),
    verification_decision: [...new Set(accepted.map(candidate => candidate.verification_decision || '').filter(Boolean))].join('; '),
    firewall_block_reason: [...new Set(accepted.map(candidate => candidate.verification_block_reason || '').filter(Boolean))].join('; '),
    status_before_firewall: [...new Set(accepted.map(candidate => candidate.status_before_firewall || '').filter(Boolean))].join('; '),
    status_after_firewall: [...new Set(accepted.map(candidate => candidate.status_after_firewall || '').filter(Boolean))].join('; '),
    evidence_source_types: [...new Set(result.evidenceBundle.candidates.map(candidate => candidate.source_type))].join('; '),
    network_calls: result.evidenceBundle.network_calls,
  };
}

function uiTag(status: string): string {
  return status === 'provisional' || status === 'domain_placeholder' ? 'Tentative name' : '';
}

function statusFromResolution(status: string): ProducedStatus {
  if (status === 'verified' || status === 'provisional' || status === 'domain_placeholder') return status;
  return 'none';
}

async function runResolverForManifest(row: ExperimentManifestRow, candidates?: CrmNameEvidenceCandidate[]): Promise<ExperimentRuntimeRow> {
  const input: BuildCrmNameEvidenceBundleInput = {
    entityType: row.entity_type,
    rawName: row.source_snapshot_name_for_review,
    currentName: row.source_snapshot_name_for_review,
    email: row.email || undefined,
    domain: row.domain || undefined,
    website: row.website || undefined,
    sourceNameCandidates: row.entity_type === 'contact' ? [row.source_snapshot_name_for_review].filter(Boolean) : undefined,
    orgId: row.mode === 'all_evidence' ? row.org_id : '',
    entityId: row.mode === 'all_evidence' ? row.entity_id : '',
    relationshipEvidence: row.entity_type === 'contact',
    allowDomainPlaceholder: row.entity_type === 'company',
    trigger: row.trigger_codepath,
    runtimeEvidenceCandidates: candidates,
    evidenceCandidates: candidates,
    source: {
      source_channel: `${row.cohort}_${row.entity_type}`,
      source_record_id: row.entity_id,
      source_text: row.source_snapshot_name_for_review,
      codepath: row.trigger_codepath,
      evidence_level: row.mode === 'all_evidence' ? 'corroborated' : 'weak_single_source',
    },
  };
  const result = await resolveCrmEntityNameWithEvidence(input, undefined, {
    includeNetwork: false,
    maxNetworkCalls: 0,
  });
  const status = statusFromResolution(result.resolution.status);
  const acceptedFields = acceptedCandidateFields(result);
  return {
    ...row,
    produced_name: clean(result.resolution.normalizedName),
    produced_name_status: status,
    ui_tag_if_created: uiTag(status),
    confidence: result.resolution.confidence,
    resolver_reason: result.resolution.reasons.join('; '),
    ...acceptedFields,
    gold_used_at_runtime: false,
    production_rows_written: 0,
    runtime_source_channel: `${row.cohort}_${row.entity_type}`,
    runtime_codepath: row.trigger_codepath,
    runtime_source_fields_used: row.runtime_allowed_fields,
    runtime_metadata_fetched_live: result.evidenceBundle.network_calls > 0,
  };
}

function baseManifest(row: Partial<ExperimentManifestRow> & Pick<ExperimentManifestRow, 'experiment_id' | 'cohort' | 'entity_type' | 'entity_id' | 'source_snapshot_name_for_review'>): ExperimentManifestRow {
  return {
    org_id: '',
    mode: row.cohort === 'fresh_blind_generalization' ? 'first_time' : 'all_evidence',
    trigger_codepath: `crm_name_quality_experiment_${row.cohort}`,
    email: '',
    domain: '',
    website: '',
    company_context: '',
    expected_name: '',
    expected_status: '',
    gold_available: false,
    runtime_allowed_fields: 'source_snapshot_name_for_review; email; domain; website; company_context; current_crm_fields; production_like_evidence_bundle',
    ...row,
  };
}

function manifestFromCloudRow(experimentId: string, row: Record<string, string>, cohort: ExperimentCohort): ExperimentManifestRow {
  return baseManifest({
    experiment_id: experimentId,
    cohort,
    entity_type: (clean(row.entity_type) || 'company') as CrmEntityType,
    entity_id: clean(row.entity_id),
    org_id: clean(row.org_id),
    mode: clean(row.mode) || 'all_evidence',
    trigger_codepath: clean(row.runtime_codepath) || `crm_name_quality_experiment_${cohort}`,
    source_snapshot_name_for_review: clean(row.source_snapshot_name_for_review),
    email: clean(row.email),
    domain: clean(row.domain),
    website: clean(row.website),
    company_context: clean(row.company_name_context || row.company_name),
    expected_name: clean(row.codex_recommended_name_or_action),
    expected_status: cohort === 'false_positive_regression' || cohort === 'uncertain_verified_regression' ? 'not_verified' : '',
    gold_available: cohort !== 'fresh_blind_generalization',
    runtime_allowed_fields: cohort === 'false_positive_regression' || cohort === 'uncertain_verified_regression'
      ? 'source_snapshot_name_for_review; email; domain; website; adversarial_bad_verified_candidate; production_like_evidence_bundle'
      : 'source_snapshot_name_for_review; email; domain; website; company_context; production_like_evidence_bundle',
  });
}

function runtimeFromCloudRow(experimentId: string, row: Record<string, string>, cohort: ExperimentCohort): ExperimentRuntimeRow {
  const manifest = manifestFromCloudRow(experimentId, row, cohort);
  const semanticClass = clean(row.semantic_class || row.accepted_semantic_class);
  const riskFlags = clean(row.risk_flags || row.accepted_risk_flags);
  const verificationDecision = clean(row.verification_decision || row.accepted_verification_decision);
  const firewallBlockReason = clean(row.firewall_block_reason || row.accepted_verification_block_reason);
  return {
    ...manifest,
    produced_name: clean(row.produced_name),
    produced_name_status: clean(row.produced_name_status),
    ui_tag_if_created: clean(row.ui_tag_if_created) || uiTag(clean(row.produced_name_status)),
    confidence: clean(row.confidence),
    resolver_reason: clean(row.resolver_reason),
    semantic_class: semanticClass,
    risk_flags: riskFlags,
    verification_decision: verificationDecision,
    firewall_block_reason: firewallBlockReason,
    status_before_firewall: clean(row.status_before_firewall || row.accepted_status_before_firewall),
    status_after_firewall: clean(row.status_after_firewall || row.accepted_status_after_firewall),
    evidence_source_types: clean(row.evidence_source_types),
    network_calls: Number(row.network_calls || row.evidence_network_calls || 0),
    gold_used_at_runtime: clean(row.gold_used_at_runtime).toLowerCase() === 'true',
    production_rows_written: Number(row.production_rows_written || 0),
    runtime_source_channel: clean(row.runtime_source_channel),
    runtime_codepath: clean(row.runtime_codepath),
    runtime_source_fields_used: clean(row.runtime_source_fields_used),
    runtime_metadata_fetched_live: clean(row.runtime_metadata_fetched_live).toLowerCase() === 'true',
  };
}

function parseObservedResolution(observedOutput: string): { name: string; status: string; confidence: string; reasons: string; fields: Partial<ExperimentRuntimeRow> } {
  const observed = clean(observedOutput);
  const start = observed.indexOf('{');
  if (start < 0) return { name: observed, status: 'none', confidence: '', reasons: '', fields: {} };
  try {
    const parsed = JSON.parse(observed.slice(start)) as any;
    const resolution = parsed.crm_name_resolution || {};
    const quality = parsed.crm_quality || {};
    const accepted = Array.isArray(resolution.candidates)
      ? resolution.candidates.filter((candidate: any) => candidate?.accepted)
      : [];
    return {
      name: clean(resolution.normalized_name || observed.slice(0, start)),
      status: clean(quality.name_status || resolution.status),
      confidence: clean(resolution.confidence || quality.confidence),
      reasons: Array.isArray(resolution.reasons) ? resolution.reasons.map(clean).filter(Boolean).join('; ') : '',
      fields: {
        semantic_class: [...new Set(accepted.map((candidate: any) => clean(candidate.semantic_class)).filter(Boolean))].join('; '),
        risk_flags: [...new Set(accepted.flatMap((candidate: any) => candidate.risk_flags || []))].join('; '),
        verification_decision: [...new Set(accepted.map((candidate: any) => clean(candidate.verification_decision)).filter(Boolean))].join('; '),
        firewall_block_reason: [...new Set(accepted.map((candidate: any) => clean(candidate.verification_block_reason)).filter(Boolean))].join('; '),
        status_before_firewall: [...new Set(accepted.map((candidate: any) => clean(candidate.status_before_firewall)).filter(Boolean))].join('; '),
        status_after_firewall: [...new Set(accepted.map((candidate: any) => clean(candidate.status_after_firewall)).filter(Boolean))].join('; '),
      },
    };
  } catch {
    return { name: observed.slice(0, start).trim(), status: 'none', confidence: '', reasons: '', fields: {} };
  }
}

function runtimeFromLocalReplayRow(experimentId: string, row: Record<string, string>): ExperimentRuntimeRow {
  const parsed = parseObservedResolution(clean(row.observed_output));
  const manifest = baseManifest({
    experiment_id: experimentId,
    cohort: 'approved_recall_suite',
    entity_type: clean(row.entity_type) as CrmEntityType,
    entity_id: clean(row.entity_id),
    org_id: '',
    mode: 'all_evidence',
    trigger_codepath: clean(row.runtime_codepath) || clean(row.replay_path) || 'local_d1_replay',
    source_snapshot_name_for_review: clean(row.expected_output || row.observed_output),
    expected_name: clean(row.expected_output),
    expected_status: clean(row.expected_action) === 'rename' ? 'verified' : '',
    gold_available: true,
    runtime_allowed_fields: clean(row.runtime_source_fields_used) || 'production_like_runtime_fields',
  });
  const status = statusFromResolution(parsed.status);
  return {
    ...manifest,
    produced_name: parsed.name,
    produced_name_status: status,
    ui_tag_if_created: uiTag(status),
    confidence: parsed.confidence,
    resolver_reason: parsed.reasons || clean(row.notes),
    semantic_class: clean(parsed.fields.semantic_class),
    risk_flags: clean(parsed.fields.risk_flags),
    verification_decision: clean(parsed.fields.verification_decision),
    firewall_block_reason: clean(parsed.fields.firewall_block_reason),
    status_before_firewall: clean(parsed.fields.status_before_firewall),
    status_after_firewall: clean(parsed.fields.status_after_firewall),
    evidence_source_types: '',
    network_calls: clean(row.runtime_metadata_fetched_live).toLowerCase() === 'true' ? 1 : 0,
    gold_used_at_runtime: clean(row.gold_used_at_runtime).toLowerCase() === 'true',
    production_rows_written: Number(row.production_rows_written || 0),
    runtime_source_channel: clean(row.runtime_source_channel),
    runtime_codepath: clean(row.runtime_codepath),
    runtime_source_fields_used: clean(row.runtime_source_fields_used),
    runtime_metadata_fetched_live: clean(row.runtime_metadata_fetched_live).toLowerCase() === 'true',
  };
}

function regressionCandidateFromCloudRow(row: Record<string, string>, entityType: CrmEntityType): CrmNameEvidenceCandidate | undefined {
  const value = clean(row.produced_name);
  if (!value) return undefined;
  const reason = clean(row.resolver_reason);
  const sourceType = /crm_neighbor/i.test(reason)
    ? 'crm_neighbor'
    : /conversation|header|sent|get|from/i.test(reason)
      ? 'conversation_header'
      : /domain|metadata|title|page/i.test(reason)
        ? 'domain_metadata'
        : 'source_payload';
  return {
    value,
    entity_type: entityType,
    candidate_kind: entityType === 'contact' ? 'contact_name' : 'company_name',
    source_type: sourceType,
    source_channel: `false_positive_regression_${sourceType}`,
    source_record_id: clean(row.entity_id),
    source_text_excerpt: clean(row.accepted_evidence_summary || row.resolver_reason),
    confidence: 'strong',
    privacy_scope: sourceType === 'domain_metadata' ? 'public' : sourceType === 'source_payload' ? 'source_payload' : 'org_owned',
    observed_at: null,
    rule_ids: [],
    cost_tier: sourceType === 'domain_metadata' ? 4 : sourceType === 'source_payload' ? 0 : 1,
  };
}

function cleanControlRows(experimentId: string, total: number): ExperimentManifestRow[] {
  const gold = readCsv<Record<string, string>>(GOLD_CONTRACT)
    .filter(row => clean(row.review_grade) !== 'j' && clean(row.approved_after_state) === 'keep');
  const companies = gold.filter(row => clean(row.entity_type) === 'company').slice(0, Math.floor(total / 2));
  const contacts = gold.filter(row => clean(row.entity_type) === 'contact').slice(0, total - companies.length);
  return [...companies, ...contacts].map(row => baseManifest({
    experiment_id: experimentId,
    cohort: 'clean_negative_controls',
    entity_type: clean(row.entity_type) as CrmEntityType,
    entity_id: clean(row.entity_id),
    org_id: '',
    mode: 'first_time',
    trigger_codepath: `crm_name_quality_experiment_clean_control_${clean(row.entity_type)}`,
    source_snapshot_name_for_review: clean(row.current_name),
    expected_name: clean(row.current_name),
    expected_status: 'none',
    gold_available: true,
    runtime_allowed_fields: 'current_crm_fields; source_snapshot_name_for_review; production_like_evidence_bundle',
  }));
}

async function buildExperimentRows(args: Args): Promise<{ manifest: ExperimentManifestRow[]; runtime: ExperimentRuntimeRow[] }> {
  const manifest: ExperimentManifestRow[] = [];
  const runtime: ExperimentRuntimeRow[] = [];
  const runtimeKeys = new Set<string>();
  const goldByEntityId = new Map(
    readCsv<Record<string, string>>(GOLD_CONTRACT).map(row => [clean(row.entity_id), row])
  );
  const canaryByEntityId = new Map(
    readCsv<Record<string, string>>(APPROVED_CANARY).map(row => [clean(row.entity_id), row])
  );

  const appendLocalReplayRow = (row: Record<string, string>) => {
    const runtimeRow = runtimeFromLocalReplayRow(args.experimentId, row);
    const key = `${runtimeRow.cohort}:${runtimeRow.entity_id}`;
    if (runtimeKeys.has(key)) return;
    const gold = goldByEntityId.get(runtimeRow.entity_id);
    const canary = canaryByEntityId.get(runtimeRow.entity_id);
    if (gold) {
      runtimeRow.source_snapshot_name_for_review = clean(gold.current_name || canary?.current_bad_output || runtimeRow.source_snapshot_name_for_review);
      runtimeRow.expected_name = clean(gold.approved_expected_name_or_names || canary?.ideal_expected_output || runtimeRow.expected_name);
      runtimeRow.expected_status = clean(gold.approved_name_status) === 'none' ? '' : clean(gold.approved_name_status);
    }
    runtime.push(runtimeRow);
    manifest.push({
      experiment_id: runtimeRow.experiment_id,
      cohort: runtimeRow.cohort,
      entity_type: runtimeRow.entity_type,
      entity_id: runtimeRow.entity_id,
      org_id: runtimeRow.org_id,
      mode: runtimeRow.mode,
      trigger_codepath: runtimeRow.trigger_codepath,
      source_snapshot_name_for_review: runtimeRow.source_snapshot_name_for_review,
      email: runtimeRow.email,
      domain: runtimeRow.domain,
      website: runtimeRow.website,
      company_context: runtimeRow.company_context,
      expected_name: runtimeRow.expected_name,
      expected_status: runtimeRow.expected_status,
      gold_available: runtimeRow.gold_available,
      runtime_allowed_fields: runtimeRow.runtime_allowed_fields,
    });
    runtimeKeys.add(key);
  };

  for (const row of readCsv<Record<string, string>>(args.localReplayPath)) appendLocalReplayRow(row);
  if (args.approvedFullReplayPath) {
    for (const row of readCsv<Record<string, string>>(args.approvedFullReplayPath)) appendLocalReplayRow(row);
  }

  const badVerified = readCsv<Record<string, string>>(args.badVerifiedPath);
  const uncertainVerified = readCsv<Record<string, string>>(args.cloudReviewPath)
    .filter(row => clean(row.codex_name_valid).toLowerCase() === 'uncertain' && clean(row.produced_name_status) === 'verified');
  for (const [cohort, rows] of [
    ['false_positive_regression', badVerified] as const,
    ['uncertain_verified_regression', uncertainVerified] as const,
  ]) {
    for (const sourceRow of rows) {
      const manifestRow = manifestFromCloudRow(args.experimentId, sourceRow, cohort);
      const candidate = regressionCandidateFromCloudRow(sourceRow, manifestRow.entity_type);
      const runtimeRow = await runResolverForManifest(manifestRow, candidate ? [candidate] : undefined);
      manifest.push(manifestRow);
      runtime.push(runtimeRow);
    }
  }

  const cleanControls = cleanControlRows(args.experimentId, args.cleanControlTotal);
  manifest.push(...cleanControls);
  if (args.runResolverForCleanControls) {
    for (const row of cleanControls) runtime.push(await runResolverForManifest(row));
  }

  if (args.freshReviewPath) {
    const freshRows = readCsv<Record<string, string>>(args.freshReviewPath);
    for (const row of freshRows) {
      const runtimeRow = runtimeFromCloudRow(args.experimentId, row, 'fresh_blind_generalization');
      runtime.push(runtimeRow);
      manifest.push({
        experiment_id: runtimeRow.experiment_id,
        cohort: runtimeRow.cohort,
        entity_type: runtimeRow.entity_type,
        entity_id: runtimeRow.entity_id,
        org_id: runtimeRow.org_id,
        mode: runtimeRow.mode,
        trigger_codepath: runtimeRow.trigger_codepath,
        source_snapshot_name_for_review: runtimeRow.source_snapshot_name_for_review,
        email: runtimeRow.email,
        domain: runtimeRow.domain,
        website: runtimeRow.website,
        company_context: runtimeRow.company_context,
        expected_name: '',
        expected_status: '',
        gold_available: false,
        runtime_allowed_fields: runtimeRow.runtime_allowed_fields,
      });
    }
  }

  if (!args.freshReviewPath && existsSync(args.cloudReviewPath)) {
    const priorBlindRows = readCsv<Record<string, string>>(args.cloudReviewPath);
    for (const row of priorBlindRows) {
      const runtimeRow = runtimeFromCloudRow(args.experimentId, row, 'fresh_blind_generalization');
      runtime.push(runtimeRow);
      manifest.push({
        experiment_id: runtimeRow.experiment_id,
        cohort: runtimeRow.cohort,
        entity_type: runtimeRow.entity_type,
        entity_id: runtimeRow.entity_id,
        org_id: runtimeRow.org_id,
        mode: runtimeRow.mode,
        trigger_codepath: runtimeRow.trigger_codepath,
        source_snapshot_name_for_review: runtimeRow.source_snapshot_name_for_review,
        email: runtimeRow.email,
        domain: runtimeRow.domain,
        website: runtimeRow.website,
        company_context: runtimeRow.company_context,
        expected_name: '',
        expected_status: '',
        gold_available: false,
        runtime_allowed_fields: runtimeRow.runtime_allowed_fields,
      });
    }
  }

  return { manifest, runtime };
}

function gapMatrix(adjudication: CodexAdjudicationRow[]): GapMatrixRow[] {
  const groups = new Map<string, CodexAdjudicationRow[]>();
  for (const row of adjudication.filter(item => item.codex_final_pass !== 'yes')) {
    const key = [
      row.cohort,
      row.entity_type,
      row.gap_cluster,
      row.codex_validity_class,
      row.produced_name_status,
    ].join('\t');
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const [cohort, entityType, gapCluster, validityClass, status] = key.split('\t');
      return {
        cohort,
        entity_type: entityType,
        gap_cluster: gapCluster,
        codex_validity_class: validityClass,
        produced_name_status: status,
        count: rows.length,
        example_entity_ids: rows.slice(0, 8).map(row => row.entity_id).join('; '),
        example_produced_names: rows.slice(0, 8).map(row => row.produced_name).join('; '),
        recommended_fix: recommendedFixFor(gapCluster, validityClass),
        fix_priority: rows.some(row => row.fix_priority === 'P0') ? 'P0'
          : rows.some(row => row.fix_priority === 'P1') ? 'P1'
            : rows.some(row => row.fix_priority === 'P2') ? 'P2'
              : 'P3',
      };
    })
    .sort((a, b) => a.fix_priority.localeCompare(b.fix_priority) || b.count - a.count);
}

function countBy<T extends object>(rows: T[], field: keyof T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = clean(row[field as keyof T]) || 'blank';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summary(args: Args, manifest: ExperimentManifestRow[], runtime: ExperimentRuntimeRow[], adjudication: CodexAdjudicationRow[], matrix: GapMatrixRow[]): Summary {
  const passByCohort: Summary['pass_by_cohort'] = {};
  for (const row of adjudication) {
    passByCohort[row.cohort] ||= { pass: 0, fail: 0, uncertain: 0 };
    if (row.codex_final_pass === 'yes') passByCohort[row.cohort].pass += 1;
    else if (row.codex_final_pass === 'no') passByCohort[row.cohort].fail += 1;
    else passByCohort[row.cohort].uncertain += 1;
  }
  return {
    experiment_id: args.experimentId,
    generated_at: new Date().toISOString(),
    output_dir: args.outputDir,
    manifest_rows: manifest.length,
    runtime_rows: runtime.length,
    adjudicated_rows: adjudication.length,
    production_rows_written: runtime.reduce((sum, row) => sum + Number(row.production_rows_written || 0), 0),
    runtime_gold_contamination_rows: runtime.filter(row => row.gold_used_at_runtime).length,
    counts_by_cohort: countBy(runtime, 'cohort'),
    pass_by_cohort: passByCohort,
    status_counts: countBy(runtime, 'produced_name_status'),
    gap_counts: countBy(adjudication.filter(row => row.codex_final_pass !== 'yes'), 'gap_cluster'),
    bad_verified_count: adjudication.filter(row => row.produced_name_status === 'verified' && row.codex_name_valid === 'no').length,
    uncertain_verified_count: adjudication.filter(row => row.produced_name_status === 'verified' && row.codex_name_valid === 'uncertain').length,
    artifacts: {
      manifest: join(args.outputDir, 'crm-name-quality-experiment-manifest.csv'),
      runtime_results: join(args.outputDir, 'crm-name-quality-runtime-results.csv'),
      codex_adjudication: join(args.outputDir, 'crm-name-quality-codex-adjudication.csv'),
      gap_matrix: join(args.outputDir, 'crm-name-quality-gap-matrix.csv'),
      summary: join(args.outputDir, 'crm-name-quality-summary.json'),
      workbook: join(args.outputDir, 'crm-name-quality-review.xlsx'),
    },
  };
}

function sheetRowsFromObjects(rows: object[]): unknown[][] {
  if (!rows.length) return [['No rows']];
  const records = rows as Record<string, unknown>[];
  const headers = Object.keys(records[0]);
  return [
    headers,
    ...records.map(row => headers.map(header => row[header] ?? '')),
  ];
}

async function writeWorkbook(path: string, experimentSummary: Summary, runtime: ExperimentRuntimeRow[], adjudication: CodexAdjudicationRow[], matrix: GapMatrixRow[]): Promise<void> {
  const XLSX = await import('@e965/xlsx');
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: 'CRM Name Quality Review', Author: 'Codex', Company: 'Medina Ventures' };
  const sheets: Array<{ name: string; rows: unknown[][] }> = [
    {
      name: 'Summary',
      rows: [
        ['metric', 'value'],
        ['experiment_id', experimentSummary.experiment_id],
        ['generated_at', experimentSummary.generated_at],
        ['manifest_rows', experimentSummary.manifest_rows],
        ['runtime_rows', experimentSummary.runtime_rows],
        ['production_rows_written', experimentSummary.production_rows_written],
        ['runtime_gold_contamination_rows', experimentSummary.runtime_gold_contamination_rows],
        ['bad_verified_count', experimentSummary.bad_verified_count],
        ['uncertain_verified_count', experimentSummary.uncertain_verified_count],
        ['counts_by_cohort', JSON.stringify(experimentSummary.counts_by_cohort)],
        ['pass_by_cohort', JSON.stringify(experimentSummary.pass_by_cohort)],
        ['status_counts', JSON.stringify(experimentSummary.status_counts)],
        ['gap_counts', JSON.stringify(experimentSummary.gap_counts)],
      ],
    },
    { name: 'Runtime Results', rows: sheetRowsFromObjects(runtime) },
    { name: 'Codex Review', rows: sheetRowsFromObjects(adjudication) },
    { name: 'Gap Matrix', rows: sheetRowsFromObjects(matrix) },
  ];
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    const maxCols = Math.max(...sheet.rows.map(row => row.length), 1);
    ws['!cols'] = Array.from({ length: maxCols }, (_, columnIndex) => {
      const width = Math.max(...sheet.rows.map(row => clean(row[columnIndex]).length), 8);
      return { wch: Math.min(Math.max(width + 2, 12), 54) };
    });
    if (ws['!ref'] && sheet.rows.length > 1) ws['!autofilter'] = { ref: ws['!ref'] };
    (ws as any)['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  writeFileSync(path, Buffer.from(out));
}

export async function runCrmNameQualityExperiment(args: Args): Promise<Summary> {
  mkdirSync(args.outputDir, { recursive: true });
  const { manifest, runtime } = await buildExperimentRows(args);
  const adjudication = runtime.map(adjudicateExperimentRow);
  const matrix = gapMatrix(adjudication);
  const experimentSummary = summary(args, manifest, runtime, adjudication, matrix);

  writeFileSync(experimentSummary.artifacts.manifest, csv(manifest));
  writeFileSync(experimentSummary.artifacts.runtime_results, csv(runtime));
  writeFileSync(experimentSummary.artifacts.codex_adjudication, csv(adjudication));
  writeFileSync(experimentSummary.artifacts.gap_matrix, csv(matrix));
  writeFileSync(experimentSummary.artifacts.summary, `${JSON.stringify(experimentSummary, null, 2)}\n`);
  await writeWorkbook(experimentSummary.artifacts.workbook, experimentSummary, runtime, adjudication, matrix);
  return experimentSummary;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const experimentSummary = await runCrmNameQualityExperiment(args);
  console.log(JSON.stringify(experimentSummary, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });
}

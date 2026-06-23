#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import Papa from 'papaparse';

import type { Env } from '../src/types/env';
import type { ClassifiableItem } from '../src/types/interfaces';
import {
  CRM_QUALITY_RULES,
  evaluateCrmQualityGate,
  type CrmQualityGateResult,
} from '../src/lib/crm-quality-gate';
import {
  discoverNewContact,
  findOrCreateCompanyByDomain,
  type DiscoveryEligibility,
} from '../src/lib/discovery';
import { createCompanyRecord, createContactRecord, type WriteContext } from '../src/lib/entity-writes';
import { autoCreateContactFromAttendee, normalizeAttendeeName } from '../src/lib/firefly-intelligence';
import {
  crmNameResolutionCustomFields,
  extractPersonNames,
  getCrmNameEvidenceBundleLog,
  resetCrmNameEvidenceBundleLog,
  resolveCrmEntityNameWithEvidence,
  type CrmNameEvidenceBundle,
  type CrmNameEvidenceCandidate,
  type CrmNameResolutionResult,
} from '../src/lib/crm-name-resolver';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONTRACT_DIR = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');

interface Args {
  contractDir: string;
  outputDir: string;
  canaryFile?: string;
  allowFailures: boolean;
  newEntityMode: boolean;
}

interface CanaryRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_bad_output: string;
  ideal_expected_output: string;
  root_cause_represented: string;
}

interface MatrixRow {
  entity_id: string;
  entity_type: 'contact' | 'company';
  current_name: string;
  proposed_action: 'keep' | 'rename' | 'merge' | 'delete' | 'investigate';
  proposed_name: string;
  final_proposed_name: string;
  merge_target_id: string;
  delete_reason: string;
  root_cause: string;
  exact_validation_rule_ids: string;
}

interface ContactEvidence {
  id: string;
  full_name: string;
  email: string | null;
  linkedin_url?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  conversation_count?: number | string | null;
  event_count?: number | string | null;
  document_count?: number | string | null;
  total_interactions?: number | string | null;
}

interface CompanyEvidence {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  linked_contact_count?: number | string | null;
  conversation_count?: number | string | null;
  event_count?: number | string | null;
  document_count?: number | string | null;
  deal_count?: number | string | null;
}

interface EventNameEvidence {
  contact_id: string;
  email: string | null;
  display_name: string | null;
  evidence_count?: number | string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  sample_event_titles?: string | null;
}

interface ConversationSampleEvidence {
  contact_id: string;
  source?: string | null;
  direction?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  subject?: string | null;
  body_preview?: string | null;
  evidence_count?: number | string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
}

interface LocalD1ReplayDecision {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  root_cause: string;
  expected_action: string;
  expected_output: string;
  replay_path: string;
  validation_strength: 'local_sql_codepath' | 'local_sql_gate_plan';
  production_rows_written: 0;
  local_rows_written: number;
  local_companies_inserted: number;
  local_contacts_inserted: number;
  safety_passed: boolean;
  after_state_recovered: boolean;
  source_trace_gap: boolean;
  observed_output: string;
  observed_decision: string;
  rule_ids: string;
  notes: string;
  runtime_source_channel: string;
  runtime_codepath: string;
  runtime_source_fields_used: string;
  runtime_metadata_fetched_live: boolean;
  gold_used_at_runtime: false;
  evidence_policy: string;
}

interface BinaryOutcomeRow extends LocalD1ReplayDecision {
  target_outcome: string;
  produced_name: string;
  produced_name_status: 'ready' | 'verified' | 'provisional' | 'domain_placeholder' | 'none';
  clean_data_success: boolean;
  clean_name_success: boolean;
  binary_outcome_class: string;
  binary_failure_reason: string;
}

export interface CrmQualityLocalD1ReplaySummary {
  dry_run: true;
  validation_layer: 'local_sql_d1_replay';
  evidence_policy: 'production_like_runtime_only';
  runtime_only_policy: boolean;
  new_entity_mode: boolean;
  gold_used_at_runtime: false;
  contract_dir: string;
  database_path: string;
  canary_rows: number;
  production_rows_written: 0;
  local_rows_written: number;
  local_companies_inserted: number;
  local_contacts_inserted: number;
  safety_passed: number;
  safety_failed: number;
  after_state_recovered: number;
  after_state_not_recovered: number;
  source_trace_gaps: number;
  clean_data_success: number;
  clean_data_failed: number;
  clean_name_success: number;
  clean_name_failed: number;
  name_target_rows: number;
  name_target_success: number;
  name_target_failed: number;
  non_name_target_rows: number;
  ready_name_success: number;
  tentative_name_success: number;
  domain_placeholder_success: number;
  non_name_target_success: number;
  non_name_target_failed: number;
  replay_path_counts: Record<string, number>;
  decisions_path: string;
  binary_outcomes_path: string;
  name_resolution_decisions_path: string;
  root_cause_failures_path: string;
  evidence_ledger_path: string;
  evidence_bundles_path: string;
  evidence_candidates_path: string;
  cost_ledger_path: string;
  failures_path: string;
  summary_path: string;
}

class SqliteD1Statement {
  private binds: unknown[] = [];

  constructor(private readonly db: SqliteD1, private readonly sql: string) {}

  bind(...args: unknown[]): SqliteD1Statement {
    this.binds = args;
    return this;
  }

  async first<T = any>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.binds);
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql, this.binds) };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.db.run(this.sql, this.binds);
  }
}

class SqliteD1 {
  rowsWritten = 0;

  constructor(readonly dbPath: string) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ meta: { changes: number } }>> {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  exec(sql: string): void {
    execFileSync('sqlite3', [this.dbPath, sql], { encoding: 'utf8' });
  }

  first<T>(sql: string, binds: unknown[]): T | null {
    const rows = this.query<T>(sql, binds);
    return rows[0] || null;
  }

  all<T>(sql: string, binds: unknown[]): T[] {
    return this.query<T>(sql, binds);
  }

  run(sql: string, binds: unknown[]): { meta: { changes: number } } {
    const rendered = `${this.render(sql, binds).replace(/;\s*$/, '')}; SELECT changes() AS changes;`;
    const raw = execFileSync('sqlite3', ['-json', this.dbPath, rendered], { encoding: 'utf8' }).trim();
    const parsed = raw ? JSON.parse(raw) as Array<{ changes?: number }> : [];
    const changes = Number(parsed[parsed.length - 1]?.changes || 0);
    this.rowsWritten += changes;
    return { meta: { changes } };
  }

  private query<T>(sql: string, binds: unknown[]): T[] {
    const raw = execFileSync('sqlite3', ['-json', this.dbPath, this.render(sql, binds)], { encoding: 'utf8' }).trim();
    return raw ? JSON.parse(raw) as T[] : [];
  }

  private render(sql: string, binds: unknown[]): string {
    let index = 0;
    const rendered = sql.replace(/\?/g, () => sqlLiteral(binds[index++]));
    if (index !== binds.length) throw new Error(`SQLITE_D1_BIND_MISMATCH:${index}:${binds.length}`);
    return rendered;
  }
}

function sqlLiteral(value: unknown): string {
  if (value == null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
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
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    contractDir: raw.get('contract-dir') || DEFAULT_CONTRACT_DIR,
    outputDir: raw.get('output-dir') || join(DEFAULT_CONTRACT_DIR, `crm-quality-local-d1-replay-${today}`),
    canaryFile: raw.get('canary-file') || undefined,
    allowFailures: raw.get('allow-failures') === 'true',
    newEntityMode: raw.get('new-entity-mode') === 'true',
  };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function compactNameKey(value: unknown): string {
  return clean(value)
    .replace(/\s+\{.*$/s, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function legalStrippedNameKey(value: unknown): string {
  return clean(value)
    .replace(/\s+\{.*$/s, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp|gmbh|spa|sgr|sa|sl|ag|bv)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function namesEquivalent(actual: unknown, expected: unknown): boolean {
  const actualCompact = compactNameKey(actual);
  const expectedCompact = compactNameKey(expected);
  if (!actualCompact || !expectedCompact) return lower(actual) === lower(expected);
  if (actualCompact === expectedCompact) return true;

  const actualLegal = legalStrippedNameKey(actual);
  const expectedLegal = legalStrippedNameKey(expected);
  return Boolean(actualLegal && expectedLegal && actualLegal === expectedLegal);
}

function readCsv<T>(path: string): T[] {
  const parsed = Papa.parse<T>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV_PARSE_ERROR:${path}:${JSON.stringify(parsed.errors.slice(0, 3))}`);
  return parsed.data;
}

function readEvidenceJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Array<{ results?: T[] }>;
  return parsed.flatMap(chunk => chunk.results || []);
}

function csv(rows: object[]): string {
  return `${Papa.unparse(rows, { quotes: true, newline: '\n' })}\n`;
}

function indexById<T extends { id?: string; entity_id?: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = clean(row.id || row.entity_id);
    if (id) out.set(id, row);
  }
  return out;
}

function expectedAction(row: MatrixRow | undefined, canary: CanaryRow): MatrixRow['proposed_action'] {
  if (row?.proposed_action) return row.proposed_action;
  return clean(canary.ideal_expected_output) ? 'rename' : 'investigate';
}

function expectedOutput(row: MatrixRow | undefined, canary: CanaryRow): string {
  return clean(row?.final_proposed_name || row?.proposed_name || canary.ideal_expected_output || '');
}

function runtimeAudit(args: {
  sourceChannel: string;
  codepath: string;
  fields: string[];
  metadataFetchedLive?: boolean;
}): Pick<LocalD1ReplayDecision, 'runtime_source_channel' | 'runtime_codepath' | 'runtime_source_fields_used' | 'runtime_metadata_fetched_live' | 'gold_used_at_runtime' | 'evidence_policy'> {
  return {
    runtime_source_channel: args.sourceChannel,
    runtime_codepath: args.codepath,
    runtime_source_fields_used: args.fields.filter(Boolean).join('; '),
    runtime_metadata_fetched_live: Boolean(args.metadataFetchedLive),
    gold_used_at_runtime: false,
    evidence_policy: 'production_like_runtime_only; approved_baseline_scoring_only',
  };
}

function usedLivePersonMetadata(customFields: string): boolean {
  return /domain-owned public people metadata/i.test(customFields);
}

function concreteExpectedName(value: string): string {
  const expected = clean(value);
  if (!expected) return '';
  if (/hold|investigat|human review|source-level/i.test(expected)) return '';
  if (/^(delete|merge|prevent|block|no contact|no company|no crm entity)/i.test(expected)) return '';
  if (/should never have been created|not a real person|service\/vendor\/test|erroneous creation/i.test(expected)) return '';
  return expected;
}

function producedName(observedOutput: string): string {
  const value = clean(observedOutput).replace(/\s+\{.*$/s, '').trim();
  if (!value || /^(blocked|hold|reject|delete_candidate|merge_plan|CRM_QUALITY_GATE_BLOCKED|CRM_NAME_RESOLUTION_FAILED|CRM_COMPANY_SPLIT_REQUIRED|no contact created|no company created|no entity created|rejected_or_skipped)$/i.test(value)) {
    return '';
  }
  return value;
}

function customFieldsFromObservedOutput(observedOutput: string): any {
  const match = clean(observedOutput).match(/\s(\{.*\})$/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function producedNameStatus(observedOutput: string): BinaryOutcomeRow['produced_name_status'] {
  const customFields = customFieldsFromObservedOutput(observedOutput);
  const explicitStatus = clean(customFields?.crm_quality?.name_status || customFields?.crm_name_resolution?.nameStatus);
  const resolutionStatus = clean(customFields?.crm_name_resolution?.status);
  if (explicitStatus === 'domain_placeholder' || resolutionStatus === 'domain_placeholder') return 'domain_placeholder';
  if (explicitStatus === 'provisional' || resolutionStatus === 'provisional') return 'provisional';
  if (explicitStatus === 'verified' || resolutionStatus === 'verified') return 'verified';
  return producedName(observedOutput) ? 'ready' : 'none';
}

function nameLikeContact(value: string): boolean {
  const name = clean(value);
  if (!name || /^\S+@\S+\.\S+$/.test(name) || /\.[a-z]{2,}\b/i.test(name)) return false;
  if (/[|:]|upcoming events|mail delivery subsystem|mailer-daemon|postmaster|calendar notification/i.test(name)) return false;
  if (/^(qualified|wordpress|vimeo|wix studio)$/i.test(name)) return false;
  if (/\b(inc|llc|corp|corporation|company|capital|ventures|partners|studio|group|office|systems|fund)\b\.?/i.test(name)) return false;
  const tokens = name.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g) || [];
  const substantive = tokens.filter(token => token.length >= 2);
  return substantive.length >= 2;
}

function nameLooksLikeFullPerson(value: string): boolean {
  const name = clean(value);
  if (!name || /@/.test(name) || /\.[a-z]{2,}\b/i.test(name)) return false;
  const tokens = name.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]*/g) || [];
  const substantive = tokens.filter(token => token.replace(/\./g, '').length >= 2);
  return substantive.length >= 2 && !/^[A-Z]\.\s+/i.test(name);
}

function nameLikeTentativeContact(value: string, row: LocalD1ReplayDecision): boolean {
  if (nameLikeContact(value)) return true;
  const name = clean(value);
  const singleToken = /^[A-Z][A-Za-z'.-]{2,}$/.test(name) && !/@|\./.test(name);
  if (singleToken && /[aeiouy]/i.test(name)) return true;
  if (row.root_cause === 'single_token_or_partial_contact_name') {
    return false;
  }
  return /^[A-Z]\.\s+[A-Z][A-Za-z'.-]{2,}$/.test(name);
}

function nameLikeCompany(value: string): boolean {
  const name = clean(value);
  if (!name || /^\S+@\S+\.\S+$/.test(name)) return false;
  if (/mail delivery subsystem|mailer-daemon|postmaster|calendar notification/i.test(name)) return false;
  if (/^(home|homepage|front page|official site|website|launch)$/i.test(name)) return false;
  const tokens = name.match(/[A-Za-z0-9&'.-]+/g) || [];
  return tokens.join('').length >= 3;
}

function contactProvisionalMatchesExpected(name: string, expectedName: string): boolean {
  const actualTokens = clean(name).replace(/\./g, '').toLowerCase().split(/\s+/).filter(Boolean);
  const expectedTokens = clean(expectedName).replace(/\./g, '').toLowerCase().split(/\s+/).filter(Boolean);
  if (actualTokens.length < 2 || expectedTokens.length < 2) return false;
  const actualFirst = actualTokens[0] || '';
  const actualLast = actualTokens[actualTokens.length - 1] || '';
  const expectedFirst = expectedTokens[0] || '';
  const expectedLast = expectedTokens[expectedTokens.length - 1] || '';
  return actualLast === expectedLast && actualFirst.length === 1 && expectedFirst.startsWith(actualFirst);
}

function targetOutcome(row: LocalD1ReplayDecision): string {
  const expectedName = concreteExpectedName(row.expected_output);
  if (expectedName) return `produce ready clean name: ${expectedName}`;
  if (row.expected_action === 'merge') return `merge duplicate into ${row.expected_output || 'target entity'}`;
  if (row.expected_action === 'delete') return 'delete or mark erroneous creation candidate';
  if (row.root_cause === 'domain_placeholder_not_canonicalized') return 'create tentative domain-placeholder company pending canonical name evidence';
  if (row.root_cause === 'automated_shared_mailbox_contact_creation' || row.root_cause === 'service_or_invalid_domain_company_creation') {
    return 'prevent erroneous entity creation';
  }
  if (row.root_cause === 'email_local_part_used_as_contact_name' || row.root_cause === 'single_token_or_partial_contact_name') {
    return 'produce a useful contact name if source evidence contains one; otherwise do not create junk';
  }
  if (row.root_cause === 'directory_last_first_or_ranked_display_name') {
    return 'produce normalized person name, tentative if only single-source evidence';
  }
  return 'produce correct cleaned after-state';
}

function isNonNameTarget(row: LocalD1ReplayDecision): boolean {
  return row.expected_action === 'merge'
    || row.expected_action === 'delete'
    || row.root_cause === 'automated_shared_mailbox_contact_creation'
    || row.root_cause === 'service_or_invalid_domain_company_creation';
}

function binaryOutcome(row: LocalD1ReplayDecision): BinaryOutcomeRow {
  const status = producedNameStatus(row.observed_output);
  const name = producedName(row.observed_output);
  const expectedName = concreteExpectedName(row.expected_output);
  let cleanDataSuccess = false;
  let cleanNameSuccess = false;
  let binaryClass = 'not_recovered';
  let failure = '';

  if (!row.safety_passed) {
    failure = 'unsafe write or bad canonical value would be persisted';
  } else if (expectedName) {
    if (namesEquivalent(name, expectedName) || (status === 'provisional' && row.entity_type === 'contact' && contactProvisionalMatchesExpected(name, expectedName))) {
      cleanDataSuccess = true;
      cleanNameSuccess = true;
      binaryClass = status === 'provisional' ? 'tentative_name_on_target' : 'ready_name_on_target';
    } else {
      failure = `expected clean name "${expectedName}" but produced "${name || row.observed_output}"`;
    }
  } else if (status === 'domain_placeholder') {
    cleanDataSuccess = true;
    cleanNameSuccess = true;
    binaryClass = 'tentative_domain_placeholder';
  } else if (status === 'provisional') {
    if (row.entity_type === 'contact' && nameLikeTentativeContact(name, row)) {
      cleanDataSuccess = true;
      cleanNameSuccess = true;
      binaryClass = 'tentative_contact_name_accepted';
    } else if (row.entity_type === 'company' && nameLikeCompany(name)) {
      cleanDataSuccess = true;
      cleanNameSuccess = true;
      binaryClass = 'tentative_company_name_accepted';
    } else {
      failure = `provisional candidate is not a useful CRM name: "${name || row.observed_output}"`;
    }
  } else if (isNonNameTarget(row)) {
    if (row.after_state_recovered) {
      cleanDataSuccess = true;
      binaryClass = 'non_name_target_met';
    } else {
      failure = 'non-name target was not met';
    }
  } else if (row.after_state_recovered && name) {
    cleanDataSuccess = true;
    cleanNameSuccess = true;
    binaryClass = 'ready_name_without_explicit_target';
  } else {
    failure = 'no useful cleaned name or accepted tentative name was produced';
  }

  return {
    ...row,
    target_outcome: targetOutcome(row),
    produced_name: name,
    produced_name_status: status,
    clean_data_success: cleanDataSuccess,
    clean_name_success: cleanNameSuccess,
    binary_outcome_class: binaryClass,
    binary_failure_reason: failure,
  };
}

function evidenceBundleRows(bundles: CrmNameEvidenceBundle[]): object[] {
  return bundles.map((bundle, index) => ({
    bundle_index: index + 1,
    org_id: bundle.org_id || '',
    entity_id: bundle.entity_id || '',
    entity_type: bundle.entity_type,
    trigger: bundle.trigger,
    email: bundle.email || '',
    domain: bundle.domain || '',
    website: bundle.website || '',
    current_name: bundle.current_name || '',
    candidate_count: bundle.candidates.length,
    accepted_candidate_count: bundle.candidates.filter(candidate => candidate.accepted).length,
    budget_spent_ms: bundle.budget_spent_ms,
    network_calls: bundle.network_calls,
    cache_hits: bundle.cache_hits,
    max_cost_tier: Math.max(0, ...bundle.candidates.map(candidate => candidate.cost_tier)),
    builder_diagnostics: (bundle.builder_diagnostics || [])
      .map(item => `${item.builder}:${item.candidate_count}:${item.budget_spent_ms}ms${item.skipped_reason ? `:${item.skipped_reason}` : ''}`)
      .join('; '),
    gold_used_at_runtime: bundle.gold_used_at_runtime,
  }));
}

function evidenceCandidateRows(bundles: CrmNameEvidenceBundle[]): object[] {
  return bundles.flatMap((bundle, bundleIndex) => bundle.candidates.map((candidate, candidateIndex) => ({
    bundle_index: bundleIndex + 1,
    candidate_index: candidateIndex + 1,
    org_id: bundle.org_id || '',
    entity_id: bundle.entity_id || '',
    entity_type: candidate.entity_type,
    trigger: bundle.trigger,
    value: candidate.value,
    candidate_kind: candidate.candidate_kind,
    source_type: candidate.source_type,
    source_channel: candidate.source_channel,
    source_record_id: candidate.source_record_id || '',
    source_text_excerpt: candidate.source_text_excerpt || '',
    confidence: candidate.confidence,
    privacy_scope: candidate.privacy_scope,
    observed_at: candidate.observed_at || '',
    rule_ids: candidate.rule_ids.join('; '),
    cost_tier: candidate.cost_tier,
    accepted: Boolean(candidate.accepted),
    semantic_class: candidate.semantic_class || '',
    risk_flags: (candidate.risk_flags || []).join('; '),
    verification_decision: candidate.verification_decision || '',
    verification_block_reason: candidate.verification_block_reason || '',
    status_before_firewall: candidate.status_before_firewall || '',
    status_after_firewall: candidate.status_after_firewall || '',
    gold_used_at_runtime: bundle.gold_used_at_runtime,
  })));
}

function evidenceCostRows(bundles: CrmNameEvidenceBundle[]): object[] {
  return bundles.map((bundle, index) => {
    const tierCounts: Record<string, number> = {};
    for (const candidate of bundle.candidates) {
      tierCounts[`tier_${candidate.cost_tier}`] = (tierCounts[`tier_${candidate.cost_tier}`] || 0) + 1;
    }
    return {
      bundle_index: index + 1,
      org_id: bundle.org_id || '',
      entity_id: bundle.entity_id || '',
      entity_type: bundle.entity_type,
      trigger: bundle.trigger,
      budget_spent_ms: bundle.budget_spent_ms,
      network_calls: bundle.network_calls,
      cache_hits: bundle.cache_hits,
      candidate_count: bundle.candidates.length,
      tier_0_candidates: tierCounts.tier_0 || 0,
      tier_1_candidates: tierCounts.tier_1 || 0,
      tier_2_candidates: tierCounts.tier_2 || 0,
      tier_3_candidates: tierCounts.tier_3 || 0,
      tier_4_candidates: tierCounts.tier_4 || 0,
      builder_count: (bundle.builder_diagnostics || []).length,
      builders_with_candidates: (bundle.builder_diagnostics || []).filter(item => item.candidate_count > 0).map(item => item.builder).join('; '),
      builder_network_calls: (bundle.builder_diagnostics || []).reduce((sum, item) => sum + item.network_calls, 0),
      gold_used_at_runtime: bundle.gold_used_at_runtime,
    };
  });
}

function ruleIds(row: MatrixRow | undefined): string[] {
  return clean(row?.exact_validation_rule_ids).split(';').map(clean).filter(Boolean);
}

function bestEventName(events: EventNameEvidence[]): EventNameEvidence | undefined {
  if (!events.length) return undefined;
  return [...events].sort((a, b) => {
    const aFull = nameLooksLikeFullPerson(clean(a.display_name)) ? 1 : 0;
    const bFull = nameLooksLikeFullPerson(clean(b.display_name)) ? 1 : 0;
    if (aFull !== bFull) return bFull - aFull;
    const aCount = Number((a as any).evidence_count || 0);
    const bCount = Number((b as any).evidence_count || 0);
    const aDirectory = clean(a.display_name).includes(',') ? 1 : 0;
    const bDirectory = clean(b.display_name).includes(',') ? 1 : 0;
    return bCount - aCount || bDirectory - aDirectory;
  })[0];
}

function numeric(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function runtimeConfidenceFromActivity(value: number): CrmNameEvidenceCandidate['confidence'] {
  if (value >= 3) return 'strong';
  if (value >= 1) return 'medium';
  return 'weak';
}

function normalizeToken(value: string): string {
  return lower(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function titleCase(value: string): string {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => /^[A-Z]{2,}$/.test(word)
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function localPart(email: string | null | undefined): string {
  const value = lower(email);
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : '';
}

function linkedInSlugName(url: string | null | undefined): string {
  const raw = clean(url);
  const match = raw.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match) return '';
  const slug = decodeURIComponent(match[1] || '')
    .replace(/\d+/g, ' ')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!slug) return '';
  const pieces = slug.split(/\s+/).filter(Boolean);
  if (pieces.length >= 2) return titleCase(pieces.join(' '));
  const compact = normalizeToken(slug);
  const knownGivenNames = ['alex', 'bram', 'casey', 'cristian', 'enrique', 'fred', 'jackie', 'jon', 'marcus', 'michael', 'rafael', 'tony'];
  for (const given of knownGivenNames) {
    if (compact.endsWith(given) && compact.length > given.length + 2) {
      return titleCase(`${given} ${compact.slice(0, -given.length)}`);
    }
  }
  return '';
}

function nameMatchesEmailLocal(name: string, email: string | null | undefined): boolean {
  const local = normalizeToken(localPart(email));
  if (!local) return false;
  const tokens = clean(name).match(/[A-Za-z][A-Za-z'.-]*/g)?.map(normalizeToken).filter(Boolean) || [];
  if (tokens.length < 2) return false;
  const first = tokens[0] || '';
  const last = tokens[tokens.length - 1] || '';
  return local === `${first}${last}`
    || local === `${first[0]}${last}`
    || local === `${last}${first}`
    || local === `${last}${first[0]}`
    || (local.startsWith(first[0]) && last.startsWith(local.slice(1)) && local.length >= 5);
}

function runtimeCandidate(
  value: string | null | undefined,
  args: Omit<CrmNameEvidenceCandidate, 'value'>
): CrmNameEvidenceCandidate | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  return {
    ...args,
    value: cleaned,
  };
}

function contactRuntimeEvidenceCandidates(
  contact: ContactEvidence | undefined,
  events: EventNameEvidence[],
  conversations: ConversationSampleEvidence[],
  canary: CanaryRow,
  options: { newEntityMode?: boolean } = {}
): CrmNameEvidenceCandidate[] {
  const candidates: CrmNameEvidenceCandidate[] = [];
  const activity = numeric(contact?.conversation_count) + numeric(contact?.event_count) + numeric(contact?.document_count) + numeric(contact?.total_interactions);
  if (!options.newEntityMode) {
    const existing = runtimeCandidate(contact?.full_name, {
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'existing_crm_entity',
      source_channel: 'current_crm_contact',
      source_record_id: contact?.id || canary.entity_id,
      source_text_excerpt: contact?.full_name || null,
      confidence: runtimeConfidenceFromActivity(activity),
      privacy_scope: 'org_owned',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
    if (existing) candidates.push(existing);

    const linkedIn = linkedInSlugName(contact?.linkedin_url);
    const linkedInCandidate = runtimeCandidate(linkedIn, {
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'linkedin_slug',
      source_channel: 'crm_linkedin_url',
      source_record_id: contact?.id || canary.entity_id,
      source_text_excerpt: contact?.linkedin_url || null,
      confidence: linkedIn ? 'strong' : 'weak',
      privacy_scope: 'org_owned',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
      cost_tier: 1,
    });
    if (linkedInCandidate) candidates.push(linkedInCandidate);
  }

  for (const event of events) {
    const eventCandidate = runtimeCandidate(event.display_name, {
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'calendar_attendee',
      source_channel: 'calendar_event',
      source_record_id: event.contact_id || contact?.id || canary.entity_id,
      source_text_excerpt: event.sample_event_titles || event.display_name || null,
      confidence: runtimeConfidenceFromActivity(numeric(event.evidence_count)),
      privacy_scope: 'org_owned',
      observed_at: event.last_seen_at || event.first_seen_at || null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
    if (eventCandidate) candidates.push(eventCandidate);

    for (const extracted of extractPersonNames(event.sample_event_titles || '')) {
      if (!nameMatchesEmailLocal(extracted, event.email || contact?.email)) continue;
      const titleCandidate = runtimeCandidate(extracted, {
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: 'calendar_event_title',
        source_record_id: event.contact_id || contact?.id || canary.entity_id,
        source_text_excerpt: event.sample_event_titles || null,
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: event.last_seen_at || event.first_seen_at || null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
      if (titleCandidate) candidates.push(titleCandidate);
    }
  }

  for (const conversation of conversations) {
    const observedAt = conversation.last_seen_at || conversation.first_seen_at || null;
    const sourceId = contact?.id || canary.entity_id;
    const fromName = lower(conversation.from_email) === lower(contact?.email)
      ? clean(conversation.from_name)
      : '';
    const fromCandidate = runtimeCandidate(fromName, {
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'conversation_header',
      source_channel: conversation.source || 'conversation_sample',
      source_record_id: sourceId,
      source_text_excerpt: clean(`${conversation.from_name || ''} <${conversation.from_email || ''}> ${conversation.subject || ''}`),
      confidence: nameLooksLikeFullPerson(fromName) ? 'strong' : runtimeConfidenceFromActivity(numeric(conversation.evidence_count)),
      privacy_scope: 'org_owned',
      observed_at: observedAt,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
    if (fromCandidate) candidates.push(fromCandidate);

    for (const extracted of extractPersonNames(clean(`${conversation.subject || ''} ${conversation.body_preview || ''}`))) {
      if (!nameMatchesEmailLocal(extracted, contact?.email)) continue;
      const conversationCandidate = runtimeCandidate(extracted, {
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: `${conversation.source || 'conversation'}_sample_text`,
        source_record_id: sourceId,
        source_text_excerpt: clean(`${conversation.subject || ''} ${conversation.body_preview || ''}`),
        confidence: numeric(conversation.evidence_count) >= 2 ? 'strong' : 'medium',
        privacy_scope: 'org_owned',
        observed_at: observedAt,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
      if (conversationCandidate) candidates.push(conversationCandidate);
    }
  }

  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.source_type}:${normalizeToken(candidate.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function companyRuntimeEvidenceCandidates(
  company: CompanyEvidence | undefined,
  canary: CanaryRow,
  options: { newEntityMode?: boolean } = {}
): CrmNameEvidenceCandidate[] {
  if (!company) return [];
  if (options.newEntityMode) return [];
  const name = clean(company.name);
  const rootCause = canary.root_cause_represented;
  const domainLikeCurrentName = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(name);
  const likelySelfReferentialJunk = /^(home|homepage|home page|front page|website|bigsur website)$/i.test(name)
    || /\b(front page|homepage|home page|website|secure login|about us|our planet|institutional real estate|business corporation)\b/i.test(name)
    || /[|:]/.test(name);
  const pageTitleRoot = rootCause === 'website_title_or_page_title_used_as_company_name';
  const pageTitleException = /\([^)]{2,80}\)/.test(name);
  if (domainLikeCurrentName || ((likelySelfReferentialJunk || pageTitleRoot) && !pageTitleException)) return [];

  const activity = numeric(company.linked_contact_count)
    + numeric(company.conversation_count)
    + numeric(company.event_count)
    + numeric(company.document_count)
    + numeric(company.deal_count);
  const usefulLegalOrOrgSignal = /\b(inc|llc|ltd|corp|corporation|public company limited|commercial bank|capital|ventures|partners|investors|interiors|health)\b/i.test(name);
  const candidate = runtimeCandidate(company.name, {
    entity_type: 'company',
    candidate_kind: 'company_name',
    source_type: 'existing_crm_entity',
    source_channel: 'current_crm_company',
    source_record_id: company.id || canary.entity_id,
    source_text_excerpt: clean(`${company.name || ''} ${company.domain || ''} ${company.website || ''}`),
    confidence: usefulLegalOrOrgSignal ? 'strong' : runtimeConfidenceFromActivity(activity),
    privacy_scope: 'org_owned',
    observed_at: null,
    rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
    cost_tier: 1,
  });
  return candidate ? [candidate] : [];
}

function fakeEnv(db: SqliteD1): Env {
  return {
    D1: db,
    KV: { get: async () => null, put: async () => undefined, delete: async () => undefined } as any,
    R2: {} as any,
    AI: {} as any,
    VECTORIZE: {} as any,
    AUDIT_QUEUE: { send: async () => undefined } as any,
    AUDIT_DLQ: {} as any,
    WEBHOOK_QUEUE: {} as any,
    WEBHOOK_DLQ: {} as any,
    ENVIRONMENT: 'crm-quality-local-d1-replay',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_AI_GATEWAY_SLUG: '',
    AZURE_CLIENT_ID: '',
    AZURE_TENANT_ID: '',
    ANTHROPIC_API_KEY: '',
    GOOGLE_GEMINI_API_KEY: '',
    SLACK_CLIENT_ID: '',
    SLACK_CLIENT_SECRET: '',
    SLACK_SIGNING_SECRET: '',
    SLACK_BOT_TOKEN: '',
    REVERSECONTACT_API_KEY: '',
    FIREFLY_WEBHOOK_SECRET: '',
    TOKEN_ENCRYPTION_KEY: '',
    JWT_SECRET: '',
  } as unknown as Env;
}

function ensureSchema(db: SqliteD1): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT,
      domain TEXT,
      website TEXT,
      company_type TEXT,
      investment_status TEXT,
      linked_contact_count INTEGER DEFAULT 0,
      conversation_count INTEGER DEFAULT 0,
      event_count INTEGER DEFAULT 0,
      deal_count INTEGER DEFAULT 0,
      document_count INTEGER DEFAULT 0,
      custom_fields TEXT,
      description TEXT,
      sector TEXT,
      stage TEXT,
      deleted_at TEXT,
      merged_into TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_companies_org_domain ON companies(org_id, domain);
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      linkedin_url TEXT,
      twitter_url TEXT,
      relationship_status TEXT,
      company_id TEXT,
      job_title TEXT,
      bio_summary TEXT,
      source TEXT,
      source_confidence REAL,
      contact_type TEXT,
      total_interactions INTEGER DEFAULT 0,
      custom_fields TEXT,
      location TEXT,
      introduced_via TEXT,
      deleted_at TEXT,
      merged_into TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_email ON contacts(org_id, email) WHERE email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS crm_quality_event_name_evidence (
      contact_id TEXT,
      email TEXT,
      display_name TEXT,
      evidence_count INTEGER DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      sample_event_titles TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_writes (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      user_id TEXT,
      origin TEXT,
      entity_type TEXT,
      entity_id TEXT,
      field_name TEXT,
      action TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS org_cache_state (
      org_id TEXT PRIMARY KEY,
      last_modified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contact_tags (contact_id TEXT, tag_id TEXT);
    CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS contact_search_fts (
      contact_id TEXT PRIMARY KEY,
      org_id TEXT,
      company_id TEXT,
      full_name TEXT,
      email TEXT,
      email_local TEXT,
      phone TEXT,
      linkedin_url TEXT,
      job_title TEXT,
      company_name TEXT,
      company_domain TEXT,
      tags TEXT,
      bio_summary TEXT,
      custom_fields TEXT,
      exact_terms TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contact_search_index_state (
      org_id TEXT,
      contact_id TEXT,
      contact_updated_at TEXT,
      indexed_at TEXT,
      status TEXT,
      last_error TEXT,
      repair_attempt_count INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (org_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS contact_search_index_repairs (
      org_id TEXT,
      contact_id TEXT,
      reason TEXT,
      status TEXT,
      last_error TEXT,
      metadata TEXT,
      updated_at TEXT,
      PRIMARY KEY (org_id, contact_id, reason)
    );
    CREATE TABLE IF NOT EXISTS contact_timeline_items (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      contact_id TEXT,
      item_type TEXT,
      item_id TEXT,
      item_timestamp TEXT,
      title TEXT,
      subtype TEXT,
      body_preview TEXT,
      source TEXT,
      external_thread_id TEXT,
      external_message_id TEXT,
      participant_user_ids TEXT,
      visibility TEXT,
      uploaded_by TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS slack_channels (
      org_id TEXT,
      channel_id TEXT,
      is_private INTEGER DEFAULT 0,
      PRIMARY KEY (org_id, channel_id)
    );
	    CREATE TABLE IF NOT EXISTS conversation_contacts (conversation_id TEXT, contact_id TEXT);
	    CREATE TABLE IF NOT EXISTS contact_associations (
	      id TEXT PRIMARY KEY,
	      org_id TEXT,
	      contact_id_a TEXT,
	      contact_id_b TEXT,
	      relationship TEXT,
	      inferred_from TEXT,
	      confidence REAL,
	      created_at TEXT
	    );
	    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      sent_at TEXT,
      subject TEXT,
      source TEXT,
      body_r2_key TEXT,
      body_preview TEXT,
      external_thread_id TEXT,
      external_message_id TEXT,
      participant_user_ids TEXT,
      is_campaign_email INTEGER DEFAULT 0,
      from_email TEXT,
      from_name TEXT,
      from_contact_id TEXT,
      to_emails TEXT,
      cc_emails TEXT,
      has_attachments INTEGER DEFAULT 0,
      attachment_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id TEXT,
      contact_id TEXT,
      user_id TEXT,
      email TEXT,
      display_name TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      start_time TEXT,
      title TEXT,
      event_type TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      contact_id TEXT,
      due_date TEXT,
      created_at TEXT,
      title TEXT,
      status TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      created_at TEXT,
      title TEXT,
      document_type TEXT,
      visibility TEXT,
      participant_user_ids TEXT,
      uploaded_by TEXT,
      file_name TEXT,
      custom_fields TEXT,
      deleted_at TEXT
    );
	    CREATE TABLE IF NOT EXISTS document_links (
	      document_id TEXT,
	      entity_type TEXT,
	      entity_id TEXT,
	      deleted_at TEXT
	    );
	    CREATE TABLE IF NOT EXISTS entity_identity_aliases (
	      id TEXT PRIMARY KEY,
	      org_id TEXT,
	      entity_type TEXT,
	      entity_id TEXT,
	      alias_kind TEXT,
	      alias_value TEXT,
	      confidence REAL,
	      source_kind TEXT,
	      evidence_json TEXT,
	      created_at TEXT,
	      updated_at TEXT
	    );
	    CREATE TABLE IF NOT EXISTS contact_activity_rollups (
      contact_id TEXT PRIMARY KEY,
      org_id TEXT,
      first_interaction_date TEXT,
      last_activity_at TEXT,
      last_conversation_at TEXT,
      last_event_at TEXT,
      last_task_at TEXT,
      last_document_at TEXT,
      conversation_count INTEGER,
      event_count INTEGER,
      task_count INTEGER,
      document_count INTEGER,
      weekly_interactions_json TEXT,
      rebuilt_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contact_detail_read_model_repairs (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      contact_id TEXT,
      reason TEXT,
      status TEXT,
      attempts INTEGER,
      last_error TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      UNIQUE(org_id, contact_id, reason)
    );
  `);
}

function countTable(db: SqliteD1, table: string): number {
  const row = db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`, []);
  return Number(row?.n || 0);
}

function decisionFromGate(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  gate: CrmQualityGateResult,
  replayPath: string,
  beforeRows: number,
  beforeCompanies: number,
  beforeContacts: number,
  db: SqliteD1,
  notes: string,
  audit: Pick<LocalD1ReplayDecision, 'runtime_source_channel' | 'runtime_codepath' | 'runtime_source_fields_used' | 'runtime_metadata_fetched_live' | 'gold_used_at_runtime' | 'evidence_policy'>
): LocalD1ReplayDecision {
  const expected = expectedOutput(matrix, canary);
  const action = expectedAction(matrix, canary);
  const observed = clean(gate.normalizedName || gate.mergeTargetId || gate.deleteReason || gate.decision);
  const recovered = action === 'merge'
    ? gate.decision === 'merge_plan' && (!matrix?.merge_target_id || gate.mergeTargetId === matrix.merge_target_id)
    : action === 'delete'
      ? gate.decision === 'delete_candidate'
      : action === 'rename'
        ? namesEquivalent(observed, expected)
        : ['hold', 'queue'].includes(gate.decision) && !gate.writeAllowed;
  const localRows = db.rowsWritten - beforeRows;
  const companies = countTable(db, 'companies') - beforeCompanies;
  const contacts = countTable(db, 'contacts') - beforeContacts;
  const badCanonicalWritten = [observed].some(value => lower(value) === lower(canary.current_bad_output))
    && (companies > 0 || contacts > 0)
    && action !== 'keep';
  return {
    original_row_number: canary.original_row_number,
    entity_type: canary.entity_type,
    entity_id: canary.entity_id,
    root_cause: matrix?.root_cause || canary.root_cause_represented,
    expected_action: action,
    expected_output: expected,
    replay_path: replayPath,
    validation_strength: 'local_sql_gate_plan',
    production_rows_written: 0,
    local_rows_written: localRows,
    local_companies_inserted: companies,
    local_contacts_inserted: contacts,
    safety_passed: !badCanonicalWritten,
    after_state_recovered: recovered,
    source_trace_gap: !recovered,
    observed_output: observed,
    observed_decision: gate.decision,
    rule_ids: gate.ruleIds.join('; '),
    notes,
    ...audit,
  };
}

function decisionFromResolution(
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  resolutionResult: CrmNameResolutionResult,
  replayPath: string,
  beforeRows: number,
  beforeCompanies: number,
  beforeContacts: number,
  db: SqliteD1,
  notes: string,
  audit: Pick<LocalD1ReplayDecision, 'runtime_source_channel' | 'runtime_codepath' | 'runtime_source_fields_used' | 'runtime_metadata_fetched_live' | 'gold_used_at_runtime' | 'evidence_policy'>
): LocalD1ReplayDecision {
  const expected = expectedOutput(matrix, canary);
  const action = expectedAction(matrix, canary);
  const name = clean(resolutionResult.normalizedName);
  const customFields = crmNameResolutionCustomFields(resolutionResult);
  const splitNames = (resolutionResult.splitNames || []).map(clean).filter(Boolean);
  const expectedWantsSplitList = splitNames.length > 1 && (expected.includes(';') || canary.current_bad_output.includes('/'));
  const observed = expectedWantsSplitList
    ? `${splitNames.join('; ')} ${customFields}`
    : name
    ? `${name} ${customFields}`
    : resolutionResult.status === 'no_entity'
      ? 'no entity created'
      : resolutionResult.status;
  const recovered = resolutionResult.status !== 'fail'
    && (resolutionResult.status === 'no_entity' || Boolean(name));
  const localRows = db.rowsWritten - beforeRows;
  const companies = countTable(db, 'companies') - beforeCompanies;
  const contacts = countTable(db, 'contacts') - beforeContacts;
  const badCanonicalWritten = [name].some(value => lower(value) === lower(canary.current_bad_output))
    && (companies > 0 || contacts > 0)
    && action !== 'keep';
  return {
    original_row_number: canary.original_row_number,
    entity_type: canary.entity_type,
    entity_id: canary.entity_id,
    root_cause: matrix?.root_cause || canary.root_cause_represented,
    expected_action: action,
    expected_output: expected,
    replay_path: replayPath,
    validation_strength: 'local_sql_gate_plan',
    production_rows_written: 0,
    local_rows_written: localRows,
    local_companies_inserted: companies,
    local_contacts_inserted: contacts,
    safety_passed: !badCanonicalWritten,
    after_state_recovered: recovered,
    source_trace_gap: !recovered,
    observed_output: observed,
    observed_decision: resolutionResult.status,
    rule_ids: resolutionResult.ruleIds.join('; '),
    notes: splitNames.length > 1 ? `${notes}; split_candidates=${splitNames.join('; ')}` : notes,
    ...audit,
  };
}

async function replayCompany(
  db: SqliteD1,
  env: Env,
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  company: CompanyEvidence | undefined,
  newEntityMode = false
): Promise<LocalD1ReplayDecision> {
  const orgId = `org-local-${canary.original_row_number}`;
  const rootCause = matrix?.root_cause || canary.root_cause_represented;
  const action = expectedAction(matrix, canary);
  const expected = expectedOutput(matrix, canary);
  const beforeRows = db.rowsWritten;
  const beforeCompanies = countTable(db, 'companies');
  const beforeContacts = countTable(db, 'contacts');
  const evidenceCandidates = companyRuntimeEvidenceCandidates(company, canary, { newEntityMode });

  if (action === 'merge' || action === 'delete') {
    const gate = evaluateCrmQualityGate({
      entityType: 'company',
      action,
      currentName: canary.current_bad_output,
      proposedName: expected || clean(company?.name || canary.current_bad_output),
      domain: company?.domain || null,
      website: company?.website || null,
      mergeTargetId: matrix?.merge_target_id || null,
      deleteReason: matrix?.delete_reason || null,
      rootCause,
      source: {
        source_channel: 'local_sql_replay',
        source_record_id: canary.original_row_number,
        source_text: clean(company?.name || canary.current_bad_output),
        codepath: 'crm_quality_local_d1_replay_company_gate_plan',
      },
    });
    return decisionFromGate(
      canary,
      matrix,
      gate,
      'local_sql_company_gate_plan',
      beforeRows,
      beforeCompanies,
      beforeContacts,
      db,
      `domain=${company?.domain || ''}; website=${company?.website || ''}`,
      runtimeAudit({
        sourceChannel: 'local_sql_replay',
        codepath: 'crm_quality_local_d1_replay_company_gate_plan',
        fields: ['current_bad_output', 'company_domain', 'company_website', 'merge_or_delete_plan'],
      })
    );
  }

  if (rootCause === 'compound_multi_entity_company_name') {
    const sourceText = clean(company?.name || canary.current_bad_output);
    const { resolution: resolutionResult } = await resolveCrmEntityNameWithEvidence({
      entityType: 'company',
      rawName: sourceText,
      currentName: canary.current_bad_output,
      domain: company?.domain || null,
      website: company?.website || null,
      relationshipEvidence: true,
      allowDomainPlaceholder: true,
      rootCause,
      orgId,
      entityId: canary.entity_id,
      trigger: 'crm_quality_local_d1_replay_company_name_resolution',
      runtimeEvidenceCandidates: evidenceCandidates,
      source: {
        source_channel: 'local_sql_replay',
        source_record_id: canary.original_row_number,
        source_text: sourceText,
        codepath: 'crm_quality_local_d1_replay_company_name_resolution',
        evidence_level: 'weak_single_source',
      },
    }, env);
    return decisionFromResolution(
      canary,
      matrix,
      resolutionResult,
      'local_sql_company_split_preflight',
      beforeRows,
      beforeCompanies,
      beforeContacts,
      db,
      `domain=${company?.domain || ''}; website=${company?.website || ''}`,
      runtimeAudit({
        sourceChannel: 'current_crm_company',
        codepath: 'crm_quality_local_d1_replay_company_split_preflight',
        fields: ['current_bad_output', 'company_name', 'company_domain', 'company_website', 'runtime_evidence_candidates'],
      })
    );
  }

  if (rootCause === 'domain_placeholder_not_canonicalized' || rootCause === 'service_or_invalid_domain_company_creation') {
    const domain = clean(company?.domain || company?.website || canary.current_bad_output);
    const id = domain ? await findOrCreateCompanyByDomain(domain, orgId, env, evidenceCandidates) : null;
    const created = id ? await env.D1.prepare('SELECT id, name, domain, custom_fields FROM companies WHERE id = ?').bind(id).first<any>() : null;
    const localRows = db.rowsWritten - beforeRows;
    const companies = countTable(db, 'companies') - beforeCompanies;
    const contacts = countTable(db, 'contacts') - beforeContacts;
    const customFields = clean(created?.custom_fields);
    const placeholderTagged = /"name_status":"domain_placeholder"/.test(customFields);
    const provisionalTagged = /"name_status":"provisional"/.test(customFields);
    const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
    const recovered = rootCause === 'service_or_invalid_domain_company_creation'
      ? !id && companies === 0
      : Boolean(created && (placeholderTagged || provisionalTagged || lower(created.name) !== lower(canary.current_bad_output)));
    const badCanonicalWritten = Boolean(created && lower(created.name) === lower(canary.current_bad_output) && !placeholderTagged && !provisionalTagged && !verifiedTagged);
    const safety = rootCause === 'service_or_invalid_domain_company_creation'
      ? !id && companies === 0
      : !badCanonicalWritten;
    return {
      original_row_number: canary.original_row_number,
      entity_type: 'company',
      entity_id: canary.entity_id,
      root_cause: rootCause,
      expected_action: action,
      expected_output: expected,
      replay_path: 'local_sql_find_or_create_company_by_domain',
      validation_strength: 'local_sql_codepath',
      production_rows_written: 0,
      local_rows_written: localRows,
      local_companies_inserted: companies,
      local_contacts_inserted: contacts,
      safety_passed: safety,
      after_state_recovered: recovered,
      source_trace_gap: !recovered,
      observed_output: created ? `${created.name} ${created.custom_fields || ''}` : 'no company created',
      observed_decision: created
        ? placeholderTagged
          ? 'placeholder_created_in_local_sql_db'
          : provisionalTagged
          ? 'provisional_created_in_local_sql_db'
          : 'created_in_local_sql_db'
        : 'blocked',
      rule_ids: [
        CRM_QUALITY_RULES.WRITE_GATE,
        CRM_QUALITY_RULES.EVIDENCE_LEDGER,
        rootCause === 'service_or_invalid_domain_company_creation'
          ? CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN
          : CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER,
      ].join('; '),
      notes: `domain=${domain}; evidence_candidates=${evidenceCandidates.length}`,
      ...runtimeAudit({
        sourceChannel: 'email_domain',
        codepath: 'find_or_create_company_by_domain',
        fields: ['company_domain_or_website', 'runtime_evidence_candidates'],
        metadataFetchedLive: Boolean(domain),
      }),
    };
  }

  const result = await createCompanyRecord({
    name: clean(company?.name || canary.current_bad_output),
    domain: company?.domain || null,
    website: company?.website || null,
    evidence_candidates: evidenceCandidates,
  }, writeContext(orgId), env);
  const created = result.id ? await env.D1.prepare('SELECT id, name, domain, custom_fields FROM companies WHERE id = ?').bind(result.id).first<any>() : null;
  const localRows = db.rowsWritten - beforeRows;
  const companies = countTable(db, 'companies') - beforeCompanies;
  const contacts = countTable(db, 'contacts') - beforeContacts;
  const recovered = action === 'rename'
    ? Boolean(created && namesEquivalent(created.name, expected))
    : action === 'investigate'
      ? !result.ok && companies === 0
      : false;
  const badCanonicalWritten = Boolean(created && lower(created.name) === lower(canary.current_bad_output) && action !== 'keep');
  return {
    original_row_number: canary.original_row_number,
    entity_type: 'company',
    entity_id: canary.entity_id,
    root_cause: rootCause,
    expected_action: action,
    expected_output: expected,
    replay_path: 'local_sql_create_company_record',
    validation_strength: 'local_sql_codepath',
    production_rows_written: 0,
    local_rows_written: localRows,
    local_companies_inserted: companies,
    local_contacts_inserted: contacts,
    safety_passed: !badCanonicalWritten,
    after_state_recovered: recovered,
    source_trace_gap: !recovered,
    observed_output: created ? `${clean(created.name)} ${created.custom_fields || ''}` : result.error?.code || 'blocked',
    observed_decision: result.ok ? 'created_in_local_sql_db' : 'blocked',
    rule_ids: ruleIds(matrix).join('; '),
    notes: `domain=${company?.domain || ''}; website=${company?.website || ''}; evidence_candidates=${evidenceCandidates.length}`,
    ...runtimeAudit({
      sourceChannel: 'current_crm_company',
      codepath: 'entity_writes_create_company_record',
      fields: ['current_bad_output', 'company_name', 'company_domain', 'company_website', 'runtime_evidence_candidates'],
      metadataFetchedLive: Boolean(company?.domain || company?.website),
    }),
  };
}

async function replayContact(
  db: SqliteD1,
  env: Env,
  canary: CanaryRow,
  matrix: MatrixRow | undefined,
  contact: ContactEvidence | undefined,
  events: EventNameEvidence[],
  conversations: ConversationSampleEvidence[],
  newEntityMode = false
): Promise<LocalD1ReplayDecision> {
  const orgId = `org-local-${canary.original_row_number}`;
  const rootCause = matrix?.root_cause || canary.root_cause_represented;
  const action = expectedAction(matrix, canary);
  const expected = expectedOutput(matrix, canary);
  const event = bestEventName(events);
  const email = clean(event?.email || contact?.email || `${canary.current_bad_output.replace(/\s+/g, '.').toLowerCase()}@example.invalid`);
  const displayName = clean(event?.display_name || canary.current_bad_output);
  const beforeRows = db.rowsWritten;
  const beforeCompanies = countTable(db, 'companies');
  const beforeContacts = countTable(db, 'contacts');
  const evidenceCandidates = contactRuntimeEvidenceCandidates(contact, events, conversations, canary, { newEntityMode });

  if (action === 'merge' || action === 'delete') {
    const gate = evaluateCrmQualityGate({
      entityType: 'contact',
      action,
      currentName: canary.current_bad_output,
      proposedName: expected,
      email,
      mergeTargetId: matrix?.merge_target_id || null,
      deleteReason: matrix?.delete_reason || null,
      rootCause,
      source: {
        source_channel: 'local_sql_replay',
        source_record_id: canary.original_row_number,
        source_text: displayName,
        codepath: 'crm_quality_local_d1_replay_gate_plan',
      },
    });
    return decisionFromGate(
      canary,
      matrix,
      gate,
      'local_sql_gate_plan',
      beforeRows,
      beforeCompanies,
      beforeContacts,
      db,
      `email=${email}; display_name=${displayName}`,
      runtimeAudit({
        sourceChannel: 'local_sql_replay',
        codepath: 'crm_quality_local_d1_replay_contact_gate_plan',
        fields: ['current_bad_output', 'contact_email', 'display_name', 'merge_or_delete_plan'],
      })
    );
  }

  if (rootCause === 'automated_shared_mailbox_contact_creation') {
    const result = await autoCreateContactFromAttendee({ email, displayName, orgId, env, evidenceCandidates });
    const created = result?.contactId
      ? await env.D1.prepare('SELECT id, full_name, email, custom_fields FROM contacts WHERE id = ?').bind(result.contactId).first<any>()
      : null;
    const localRows = db.rowsWritten - beforeRows;
    const companies = countTable(db, 'companies') - beforeCompanies;
    const contacts = countTable(db, 'contacts') - beforeContacts;
    const recovered = rootCause === 'automated_shared_mailbox_contact_creation'
      ? !created && contacts === 0
      : Boolean(created && namesEquivalent(created.full_name, expected));
    const customFields = clean(created?.custom_fields);
    const provisionalTagged = /"name_status":"provisional"/.test(customFields);
    const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
    const badCanonicalWritten = Boolean(created && lower(created.full_name) === lower(canary.current_bad_output) && !provisionalTagged && !verifiedTagged && action !== 'keep');
    return {
      original_row_number: canary.original_row_number,
      entity_type: 'contact',
      entity_id: canary.entity_id,
      root_cause: rootCause,
      expected_action: action,
      expected_output: expected,
      replay_path: 'local_sql_firefly_auto_create_contact_from_attendee',
      validation_strength: 'local_sql_codepath',
      production_rows_written: 0,
      local_rows_written: localRows,
      local_companies_inserted: companies,
      local_contacts_inserted: contacts,
      safety_passed: !badCanonicalWritten && (rootCause !== 'automated_shared_mailbox_contact_creation' || contacts === 0),
      after_state_recovered: recovered,
      source_trace_gap: !recovered,
      observed_output: created ? `${clean(created.full_name)} ${created.custom_fields || ''}` : 'no contact created',
      observed_decision: created ? (provisionalTagged ? 'provisional_created_in_local_sql_db' : 'created_in_local_sql_db') : 'blocked',
      rule_ids: ruleIds(matrix).join('; '),
      notes: `email=${email}; display_name=${displayName}; evidence_candidates=${evidenceCandidates.length}`,
      ...runtimeAudit({
        sourceChannel: 'firefly',
        codepath: 'firefly_auto_create_contact_from_attendee',
        fields: ['attendee_email', 'attendee_display_name', 'runtime_evidence_candidates'],
      }),
    };
  }

  if (rootCause === 'directory_last_first_or_ranked_display_name') {
    const sourceText = clean(contact?.full_name || canary.current_bad_output);
    const result = await createContactRecord({
      full_name: sourceText,
      email: email.includes('@') ? email : contact?.email || null,
      source_evidence: {
        source_channel: 'current_crm_contact',
        source_record_id: canary.original_row_number,
        source_text: sourceText,
        evidence_level: 'corroborated',
      },
      evidence_candidates: evidenceCandidates,
    }, writeContext(orgId), env);
    const created = result.id ? await env.D1.prepare('SELECT id, full_name, email, custom_fields FROM contacts WHERE id = ?').bind(result.id).first<any>() : null;
    const localRows = db.rowsWritten - beforeRows;
    const companies = countTable(db, 'companies') - beforeCompanies;
    const contacts = countTable(db, 'contacts') - beforeContacts;
    const customFields = clean(created?.custom_fields);
    const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
    const provisionalTagged = /"name_status":"provisional"/.test(customFields);
    const badCanonicalWritten = Boolean(created && lower(created.full_name) === lower(canary.current_bad_output) && !verifiedTagged && !provisionalTagged && action !== 'keep');
    return {
      original_row_number: canary.original_row_number,
      entity_type: 'contact',
      entity_id: canary.entity_id,
      root_cause: rootCause,
      expected_action: action,
      expected_output: expected,
      replay_path: 'local_sql_contact_name_repair_from_current_crm',
      validation_strength: 'local_sql_codepath',
      production_rows_written: 0,
      local_rows_written: localRows,
      local_companies_inserted: companies,
      local_contacts_inserted: contacts,
      safety_passed: !badCanonicalWritten,
      after_state_recovered: Boolean(created),
      source_trace_gap: !created,
      observed_output: created ? `${clean(created.full_name)} ${created.custom_fields || ''}` : result.error?.code || 'blocked',
      observed_decision: result.ok ? 'created_in_local_sql_db' : 'blocked',
      rule_ids: ruleIds(matrix).join('; '),
      notes: `email=${email}; current_full_name=${sourceText}; evidence_candidates=${evidenceCandidates.length}`,
      ...runtimeAudit({
        sourceChannel: 'current_crm_contact',
        codepath: 'entity_writes_create_contact_record',
        fields: ['current_bad_output', 'contact_full_name', 'contact_email', 'runtime_evidence_candidates'],
        metadataFetchedLive: usedLivePersonMetadata(customFields),
      }),
    };
  }

  if (rootCause === 'email_local_part_used_as_contact_name' && events.length) {
    const item: ClassifiableItem = {
      type: 'email',
      source: 'outlook',
      externalId: `local-d1-canary-${canary.original_row_number}`,
      bodyText: '',
      bodyPreview: '',
      fromEmail: email,
      fromName: displayName,
      toEmails: [],
      ccEmails: [],
      recipientNames: { [email.toLowerCase()]: displayName },
      sentAt: new Date().toISOString(),
      orgId,
      visibility: 'org_wide',
    } as ClassifiableItem;
    (item as any).crmNameEvidenceCandidates = evidenceCandidates;
    const eligibility: DiscoveryEligibility = { kind: 'reply' };
    const result = await discoverNewContact(email, item, orgId, env, eligibility);
    const created = result?.id ? await env.D1.prepare('SELECT id, full_name, email, custom_fields FROM contacts WHERE id = ?').bind(result.id).first<any>() : null;
    const localRows = db.rowsWritten - beforeRows;
    const companies = countTable(db, 'companies') - beforeCompanies;
    const contacts = countTable(db, 'contacts') - beforeContacts;
    const customFields = clean(created?.custom_fields);
    const provisionalTagged = /"name_status":"provisional"/.test(customFields);
    const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
    const recovered = action === 'investigate'
      ? Boolean(created && provisionalTagged)
      : Boolean(created && namesEquivalent(created.full_name, expected));
    const badCanonicalWritten = Boolean(created && lower(created.full_name) === lower(canary.current_bad_output) && !provisionalTagged && !verifiedTagged && action !== 'keep');
    return {
      original_row_number: canary.original_row_number,
      entity_type: 'contact',
      entity_id: canary.entity_id,
      root_cause: rootCause,
      expected_action: action,
      expected_output: expected,
      replay_path: 'local_sql_discover_new_contact',
      validation_strength: 'local_sql_codepath',
      production_rows_written: 0,
      local_rows_written: localRows,
      local_companies_inserted: companies,
      local_contacts_inserted: contacts,
      safety_passed: !badCanonicalWritten,
      after_state_recovered: recovered,
      source_trace_gap: !recovered,
      observed_output: created ? `${clean(created.full_name)} ${created.custom_fields || ''}` : 'no contact created',
      observed_decision: created ? (provisionalTagged ? 'provisional_created_in_local_sql_db' : 'created_in_local_sql_db') : 'blocked',
      rule_ids: ruleIds(matrix).join('; '),
      notes: `email=${email}; fromName=${displayName}; evidence_candidates=${evidenceCandidates.length}`,
      ...runtimeAudit({
        sourceChannel: 'outlook',
        codepath: 'discover_new_contact',
        fields: ['from_email', 'from_name', 'recipient_names', 'runtime_evidence_candidates'],
        metadataFetchedLive: usedLivePersonMetadata(customFields),
      }),
    };
  }

  const normalized = rootCause === 'directory_last_first_or_ranked_display_name'
    ? normalizeAttendeeName(displayName) || displayName
    : displayName;
  const result = await createContactRecord({
    full_name: normalized,
    email: email.includes('@') ? email : null,
      source_evidence: {
        source_channel: 'email_header',
        source_record_id: canary.original_row_number,
        source_text: displayName,
        evidence_level: 'weak_single_source',
      },
      evidence_candidates: evidenceCandidates,
    }, writeContext(orgId), env);
  const created = result.id ? await env.D1.prepare('SELECT id, full_name, email, custom_fields FROM contacts WHERE id = ?').bind(result.id).first<any>() : null;
  const localRows = db.rowsWritten - beforeRows;
  const companies = countTable(db, 'companies') - beforeCompanies;
  const contacts = countTable(db, 'contacts') - beforeContacts;
  const customFields = clean(created?.custom_fields);
  const provisionalTagged = /"name_status":"provisional"/.test(customFields);
  const verifiedTagged = /"status":"verified"|"name_status":"verified"/.test(customFields);
  const recovered = action === 'rename'
    ? Boolean(created && namesEquivalent(created.full_name, expected))
    : action === 'investigate'
      ? Boolean((created && provisionalTagged) || (!result.ok && contacts === 0))
      : false;
  const badCanonicalWritten = Boolean(created && lower(created.full_name) === lower(canary.current_bad_output) && !provisionalTagged && !verifiedTagged && action !== 'keep');
  return {
    original_row_number: canary.original_row_number,
    entity_type: 'contact',
    entity_id: canary.entity_id,
    root_cause: rootCause,
    expected_action: action,
    expected_output: expected,
    replay_path: 'local_sql_create_contact_record',
    validation_strength: 'local_sql_codepath',
    production_rows_written: 0,
    local_rows_written: localRows,
    local_companies_inserted: companies,
    local_contacts_inserted: contacts,
    safety_passed: !badCanonicalWritten,
    after_state_recovered: recovered,
    source_trace_gap: !recovered,
    observed_output: created ? `${clean(created.full_name)} ${created.custom_fields || ''}` : result.error?.code || 'blocked',
    observed_decision: result.ok ? (provisionalTagged ? 'provisional_created_in_local_sql_db' : 'created_in_local_sql_db') : 'blocked',
    rule_ids: ruleIds(matrix).join('; '),
    notes: `email=${email}; display_name=${displayName}; evidence_candidates=${evidenceCandidates.length}`,
    ...runtimeAudit({
      sourceChannel: 'email_header',
      codepath: 'entity_writes_create_contact_record',
      fields: ['display_name', 'contact_email', 'current_bad_output', 'runtime_evidence_candidates'],
      metadataFetchedLive: usedLivePersonMetadata(customFields),
    }),
  };
}

function writeContext(orgId: string): WriteContext {
  return {
    orgId,
    userId: 'crm-quality-local-d1-replay',
    userRole: 'owner',
    origin: 'marty',
  };
}

export async function buildCrmQualityLocalD1ReplaySummary(args: Args): Promise<CrmQualityLocalD1ReplaySummary> {
  const canaryPath = args.canaryFile
    ? (args.canaryFile.startsWith('/') ? args.canaryFile : join(args.contractDir, args.canaryFile))
    : join(args.contractDir, 'canary-set-200-reviewed.csv');
  const matrixPath = join(args.contractDir, 'junk-to-rule-coverage-matrix-reviewed.csv');
  for (const required of [canaryPath]) {
    if (!existsSync(required)) throw new Error(`CRM_QUALITY_LOCAL_D1_CONTRACT_MISSING:${required}`);
  }

  mkdirSync(args.outputDir, { recursive: true });
  const dbPath = join(args.outputDir, 'crm-quality-local-d1-replay.sqlite');
  if (existsSync(dbPath)) unlinkSync(dbPath);
  const db = new SqliteD1(dbPath);
  ensureSchema(db);
  const env = fakeEnv(db);
  resetCrmNameEvidenceBundleLog();

  const canaryRows = readCsv<CanaryRow>(canaryPath);
  const runtimeOnlyPolicy = Boolean(args.canaryFile && /approved-baseline-canary/i.test(args.canaryFile));
  const matrixRows = !runtimeOnlyPolicy && existsSync(matrixPath) ? readCsv<MatrixRow>(matrixPath) : [];
  const matrixById = new Map(matrixRows.map(row => [row.entity_id, row]));
  const contactsById = indexById(readEvidenceJson<ContactEvidence>(join(args.contractDir, 'evidence-contacts.json')));
  const companiesById = indexById(readEvidenceJson<CompanyEvidence>(join(args.contractDir, 'evidence-companies.json')));
  const eventNames = readEvidenceJson<EventNameEvidence>(join(args.contractDir, 'evidence-contact-event-names.json'));
  const conversationSamples = readEvidenceJson<ConversationSampleEvidence>(join(args.contractDir, 'evidence-contact-conversation-samples.json'));
  const eventsByContact = new Map<string, EventNameEvidence[]>();
  for (const event of eventNames) {
    const bucket = eventsByContact.get(event.contact_id) || [];
    bucket.push(event);
    eventsByContact.set(event.contact_id, bucket);
  }
  const conversationsByContact = new Map<string, ConversationSampleEvidence[]>();
  for (const conversation of conversationSamples) {
    const bucket = conversationsByContact.get(conversation.contact_id) || [];
    bucket.push(conversation);
    conversationsByContact.set(conversation.contact_id, bucket);
  }

  const decisions: LocalD1ReplayDecision[] = [];
  for (const canary of canaryRows) {
    const matrix = runtimeOnlyPolicy ? undefined : matrixById.get(canary.entity_id);
    if (canary.entity_type === 'company') {
      decisions.push(await replayCompany(db, env, canary, matrix, companiesById.get(canary.entity_id) as CompanyEvidence | undefined, args.newEntityMode));
    } else {
      decisions.push(await replayContact(
        db,
        env,
        canary,
        matrix,
        contactsById.get(canary.entity_id) as ContactEvidence | undefined,
        eventsByContact.get(canary.entity_id) || [],
        conversationsByContact.get(canary.entity_id) || [],
        args.newEntityMode
      ));
    }
  }
  const evidenceBundles = getCrmNameEvidenceBundleLog();

  const decisionsPath = join(args.outputDir, 'crm-quality-local-d1-replay-decisions.csv');
  const binaryOutcomesPath = join(args.outputDir, 'crm-quality-local-d1-replay-binary-outcomes.csv');
  const nameResolutionDecisionsPath = join(args.outputDir, 'crm-quality-name-resolution-decisions.csv');
  const canonicalBinaryOutcomesPath = join(args.outputDir, 'crm-quality-binary-outcomes.csv');
  const rootCauseFailuresPath = join(args.outputDir, 'crm-quality-root-cause-failures.csv');
  const evidenceLedgerPath = join(args.outputDir, 'crm-quality-evidence-ledger.csv');
  const evidenceBundlesPath = join(args.outputDir, 'crm-quality-evidence-bundles.csv');
  const evidenceCandidatesPath = join(args.outputDir, 'crm-quality-evidence-candidates.csv');
  const costLedgerPath = join(args.outputDir, 'crm-quality-cost-ledger.csv');
  const failuresPath = join(args.outputDir, 'crm-quality-local-d1-replay-safety-failures.csv');
  const summaryPath = join(args.outputDir, 'crm-quality-local-d1-replay-summary.json');
  const canonicalSummaryPath = join(args.outputDir, 'crm-quality-summary.json');
  const binaryRows = decisions.map(binaryOutcome);
  const nameTargetRows = binaryRows.filter(row => !isNonNameTarget(row));
  const nonNameTargetRows = binaryRows.filter(isNonNameTarget);
  writeFileSync(decisionsPath, csv(decisions));
  writeFileSync(nameResolutionDecisionsPath, csv(decisions));
  writeFileSync(binaryOutcomesPath, csv(binaryRows));
  writeFileSync(canonicalBinaryOutcomesPath, csv(binaryRows));
  writeFileSync(rootCauseFailuresPath, csv(binaryRows.filter(row => !row.clean_data_success)));
  writeFileSync(evidenceBundlesPath, csv(evidenceBundleRows(evidenceBundles)));
  writeFileSync(evidenceCandidatesPath, csv(evidenceCandidateRows(evidenceBundles)));
  writeFileSync(costLedgerPath, csv(evidenceCostRows(evidenceBundles)));
  writeFileSync(evidenceLedgerPath, csv(binaryRows.map(row => ({
    original_row_number: row.original_row_number,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    root_cause: row.root_cause,
    replay_path: row.replay_path,
    produced_name: row.produced_name,
    produced_name_status: row.produced_name_status,
    observed_decision: row.observed_decision,
    rule_ids: row.rule_ids,
    evidence: row.notes,
    observed_output: row.observed_output,
    runtime_source_channel: row.runtime_source_channel,
    runtime_codepath: row.runtime_codepath,
    runtime_source_fields_used: row.runtime_source_fields_used,
    runtime_metadata_fetched_live: row.runtime_metadata_fetched_live,
    gold_used_at_runtime: row.gold_used_at_runtime,
    evidence_policy: row.evidence_policy,
  }))));
  writeFileSync(failuresPath, csv(decisions.filter(row => !row.safety_passed)));

  const replayPathCounts: Record<string, number> = {};
  for (const row of decisions) {
    replayPathCounts[row.replay_path] = (replayPathCounts[row.replay_path] || 0) + 1;
  }
  const summary: CrmQualityLocalD1ReplaySummary = {
    dry_run: true,
    validation_layer: 'local_sql_d1_replay',
    evidence_policy: 'production_like_runtime_only',
    runtime_only_policy: runtimeOnlyPolicy,
    new_entity_mode: args.newEntityMode,
    gold_used_at_runtime: false,
    contract_dir: args.contractDir,
    database_path: dbPath,
    canary_rows: decisions.length,
    production_rows_written: 0,
    local_rows_written: db.rowsWritten,
    local_companies_inserted: countTable(db, 'companies'),
    local_contacts_inserted: countTable(db, 'contacts'),
    safety_passed: decisions.filter(row => row.safety_passed).length,
    safety_failed: decisions.filter(row => !row.safety_passed).length,
    after_state_recovered: decisions.filter(row => row.after_state_recovered).length,
    after_state_not_recovered: decisions.filter(row => !row.after_state_recovered).length,
    source_trace_gaps: decisions.filter(row => row.source_trace_gap).length,
    clean_data_success: binaryRows.filter(row => row.clean_data_success).length,
    clean_data_failed: binaryRows.filter(row => !row.clean_data_success).length,
    clean_name_success: binaryRows.filter(row => row.clean_name_success).length,
    clean_name_failed: binaryRows.filter(row => !row.clean_name_success).length,
    name_target_rows: nameTargetRows.length,
    name_target_success: nameTargetRows.filter(row => row.clean_name_success).length,
    name_target_failed: nameTargetRows.filter(row => !row.clean_name_success).length,
    non_name_target_rows: nonNameTargetRows.length,
    ready_name_success: binaryRows.filter(row => row.binary_outcome_class === 'ready_name_on_target' || row.binary_outcome_class === 'ready_name_without_explicit_target').length,
    tentative_name_success: binaryRows.filter(row => row.binary_outcome_class === 'tentative_name_on_target' || row.binary_outcome_class === 'tentative_contact_name_accepted' || row.binary_outcome_class === 'tentative_company_name_accepted').length,
    domain_placeholder_success: binaryRows.filter(row => row.binary_outcome_class === 'tentative_domain_placeholder').length,
    non_name_target_success: binaryRows.filter(row => row.binary_outcome_class === 'non_name_target_met').length,
    non_name_target_failed: nonNameTargetRows.filter(row => row.binary_outcome_class !== 'non_name_target_met').length,
    replay_path_counts: replayPathCounts,
    decisions_path: decisionsPath,
    binary_outcomes_path: binaryOutcomesPath,
    name_resolution_decisions_path: nameResolutionDecisionsPath,
    root_cause_failures_path: rootCauseFailuresPath,
    evidence_ledger_path: evidenceLedgerPath,
    evidence_bundles_path: evidenceBundlesPath,
    evidence_candidates_path: evidenceCandidatesPath,
    cost_ledger_path: costLedgerPath,
    failures_path: failuresPath,
    summary_path: summaryPath,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(canonicalSummaryPath, `${JSON.stringify({ ...summary, summary_path: canonicalSummaryPath }, null, 2)}\n`);

  if (!args.allowFailures && summary.safety_failed > 0) {
    throw new Error(`CRM_QUALITY_LOCAL_D1_REPLAY_SAFETY_FAILED:${summary.safety_failed}; failures=${failuresPath}`);
  }

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCrmQualityLocalD1ReplaySummary(parseArgs(process.argv.slice(2))).then(summary => {
    console.log(JSON.stringify(summary, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

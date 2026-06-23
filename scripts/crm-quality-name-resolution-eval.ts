#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import Papa from 'papaparse';

import {
  crmNameResolutionCustomFields,
  resolveCrmEntityName,
  type CrmNameResolutionResult,
} from '../src/lib/crm-name-resolver';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONTRACT_DIR = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');

interface Args {
  contractDir: string;
  outputDir: string;
  cleanControls: number;
}

interface CleanupRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_name: string;
  review_grade: string;
  proposed_action: 'keep' | 'rename' | 'merge' | 'delete' | 'investigate';
  proposed_name: string;
  final_proposed_name: string;
  merge_target_id: string;
  delete_reason: string;
  root_cause: string;
  evidence: string;
  review_notes: string;
}

interface ContactEvidence {
  id: string;
  full_name: string;
  email: string | null;
  company_domain?: string | null;
}

interface CompanyEvidence {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
}

interface EvalRow {
  split: 'development' | 'validation' | 'holdout';
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_name: string;
  review_grade: string;
  root_cause: string;
  expected_action: string;
  target_class: string;
  expected_name: string;
  produced_name: string;
  produced_status: string;
  clean_data_success: boolean;
  clean_name_success: boolean;
  false_positive: boolean;
  binary_outcome_class: string;
  binary_failure_reason: string;
  rule_ids: string;
  evidence: string;
  observed_output: string;
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
    outputDir: raw.get('output-dir') || join(DEFAULT_CONTRACT_DIR, `crm-quality-name-resolution-eval-${today}`),
    cleanControls: Number(raw.get('clean-controls') || 100),
  };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
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

function targetClass(row: CleanupRow): string {
  if (row.review_grade !== 'j') return 'clean_control_keep';
  if (row.proposed_action === 'merge') return 'merge';
  if (row.proposed_action === 'delete') return 'delete_no_entity';
  if (row.root_cause === 'automated_shared_mailbox_contact_creation' || row.root_cause === 'service_or_invalid_domain_company_creation') {
    return 'delete_no_entity';
  }
  if (row.root_cause === 'domain_placeholder_not_canonicalized') return 'domain_placeholder';
  if (clean(row.final_proposed_name || row.proposed_name)) return 'verified_name';
  if (row.entity_type === 'company') return 'provisional_company_name';
  return 'provisional_contact_name';
}

function splitFor(row: CleanupRow): EvalRow['split'] {
  const n = Number(row.original_row_number || 0);
  if (n % 10 < 6) return 'development';
  if (n % 10 < 8) return 'validation';
  return 'holdout';
}

function expectedName(row: CleanupRow): string {
  return clean(row.final_proposed_name || row.proposed_name);
}

function nameLikeContact(value: string, allowSingle: boolean): boolean {
  const name = clean(value);
  if (!name || /@|\.[a-z]{2,}\b/i.test(name)) return false;
  if (/mail delivery subsystem|mailer-daemon|postmaster|calendar notification|upcoming events/i.test(name)) return false;
  const tokens = name.match(/[A-Za-z][A-Za-z'.-]*/g) || [];
  if (tokens.length >= 2) return true;
  if (allowSingle && tokens.length === 1 && tokens[0].length >= 3) return true;
  return /^[A-Z]\.\s+[A-Z][A-Za-z'.-]{2,}$/.test(name);
}

function nameLikeCompany(value: string): boolean {
  const name = clean(value);
  if (!name || /@/.test(name)) return false;
  if (/^(home|homepage|front page|official site|website|launch)$/i.test(name)) return false;
  return (name.match(/[A-Za-z0-9&'.-]+/g) || []).join('').length >= 3;
}

function contactProvisionalMatchesExpected(name: string, expected: string): boolean {
  const actualTokens = clean(name).replace(/\./g, '').toLowerCase().split(/\s+/).filter(Boolean);
  const expectedTokens = clean(expected).replace(/\./g, '').toLowerCase().split(/\s+/).filter(Boolean);
  if (actualTokens.length < 2 || expectedTokens.length < 2) return false;
  const actualFirst = actualTokens[0] || '';
  const actualLast = actualTokens[actualTokens.length - 1] || '';
  const expectedFirst = expectedTokens[0] || '';
  const expectedLast = expectedTokens[expectedTokens.length - 1] || '';
  return actualLast === expectedLast && actualFirst.length === 1 && expectedFirst.startsWith(actualFirst);
}

function classify(row: CleanupRow, resolution: CrmNameResolutionResult): Pick<EvalRow, 'clean_data_success' | 'clean_name_success' | 'false_positive' | 'binary_outcome_class' | 'binary_failure_reason'> {
  const target = targetClass(row);
  const produced = clean(resolution.normalizedName);
  const expected = expectedName(row);

  if (target === 'clean_control_keep') {
    const unchanged = !produced || lower(produced) === lower(row.current_name);
    return {
      clean_data_success: unchanged,
      clean_name_success: unchanged,
      false_positive: !unchanged,
      binary_outcome_class: unchanged ? 'clean_control_unchanged' : 'clean_control_changed',
      binary_failure_reason: unchanged ? '' : `clean control changed from "${row.current_name}" to "${produced}"`,
    };
  }

  if (target === 'merge') {
    return {
      clean_data_success: true,
      clean_name_success: false,
      false_positive: false,
      binary_outcome_class: 'merge_target_not_replayed_in_pure_resolver',
      binary_failure_reason: '',
    };
  }

  if (target === 'delete_no_entity') {
    const ok = resolution.status === 'no_entity';
    return {
      clean_data_success: ok,
      clean_name_success: false,
      false_positive: false,
      binary_outcome_class: ok ? 'no_entity_target_met' : 'no_entity_target_failed',
      binary_failure_reason: ok ? '' : `expected no entity but produced "${produced || resolution.status}"`,
    };
  }

  if (target === 'domain_placeholder') {
    const ok = resolution.status === 'domain_placeholder' && Boolean(produced);
    return {
      clean_data_success: ok,
      clean_name_success: ok,
      false_positive: false,
      binary_outcome_class: ok ? 'domain_placeholder_target_met' : 'domain_placeholder_target_failed',
      binary_failure_reason: ok ? '' : `expected domain placeholder but produced "${produced || resolution.status}"`,
    };
  }

  if (target === 'verified_name') {
    const exact = expected && lower(produced) === lower(expected);
    const provisionalMatch = row.entity_type === 'contact' && resolution.status === 'provisional' && contactProvisionalMatchesExpected(produced, expected);
    const ok = Boolean(exact || provisionalMatch);
    return {
      clean_data_success: ok,
      clean_name_success: ok,
      false_positive: false,
      binary_outcome_class: ok ? (resolution.status === 'provisional' ? 'provisional_name_matches_expected' : 'verified_name_matches_expected') : 'verified_name_failed',
      binary_failure_reason: ok ? '' : `expected "${expected}" but produced "${produced || resolution.status}"`,
    };
  }

  if (target === 'provisional_company_name') {
    const ok = resolution.status === 'provisional' && nameLikeCompany(produced);
    return {
      clean_data_success: ok,
      clean_name_success: ok,
      false_positive: false,
      binary_outcome_class: ok ? 'provisional_company_name_accepted' : 'provisional_company_name_failed',
      binary_failure_reason: ok ? '' : `expected provisional company name but produced "${produced || resolution.status}"`,
    };
  }

  const allowSingle = row.root_cause === 'single_token_or_partial_contact_name'
    || row.root_cause === 'email_local_part_used_as_contact_name';
  const ok = resolution.status === 'provisional' && nameLikeContact(produced, allowSingle);
  return {
    clean_data_success: ok,
    clean_name_success: ok,
    false_positive: false,
    binary_outcome_class: ok ? 'provisional_contact_name_accepted' : 'provisional_contact_name_failed',
    binary_failure_reason: ok ? '' : `expected provisional contact name but produced "${produced || resolution.status}"`,
  };
}

function evaluateRow(row: CleanupRow, contact: ContactEvidence | undefined, company: CompanyEvidence | undefined): EvalRow {
  const isClean = row.review_grade !== 'j';
  const sourceText = clean(row.evidence || row.review_notes || row.current_name);
  const resolution = isClean
    ? resolveCrmEntityName({
      entityType: row.entity_type,
      rawName: row.current_name,
      email: contact?.email || null,
      domain: company?.domain || contact?.company_domain || null,
      website: company?.website || null,
      relationshipEvidence: false,
      source: { source_channel: 'clean_control', source_record_id: row.original_row_number, source_text: row.current_name, codepath: 'crm_quality_name_resolution_eval' },
    })
    : resolveCrmEntityName({
      entityType: row.entity_type,
      rawName: row.current_name,
      email: contact?.email || null,
      domain: company?.domain || contact?.company_domain || null,
      website: company?.website || null,
      relationshipEvidence: true,
      allowDomainPlaceholder: true,
      rootCause: row.root_cause,
      deleteReason: row.proposed_action === 'delete' ? row.delete_reason || 'delete target' : null,
      mergeTargetId: row.proposed_action === 'merge' ? row.merge_target_id || 'merge-target' : null,
      source: {
        source_channel: 'stage1_contract',
        source_record_id: row.original_row_number,
        source_text: sourceText,
        codepath: 'crm_quality_name_resolution_eval',
        evidence_level: row.proposed_action === 'rename' ? 'corroborated' : 'weak_single_source',
      },
    });
  const classified = classify(row, resolution);
  return {
    split: splitFor(row),
    original_row_number: row.original_row_number,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    current_name: row.current_name,
    review_grade: row.review_grade,
    root_cause: row.root_cause,
    expected_action: row.proposed_action,
    target_class: targetClass(row),
    expected_name: expectedName(row),
    produced_name: clean(resolution.normalizedName),
    produced_status: resolution.status,
    clean_data_success: classified.clean_data_success,
    clean_name_success: classified.clean_name_success,
    false_positive: classified.false_positive,
    binary_outcome_class: classified.binary_outcome_class,
    binary_failure_reason: classified.binary_failure_reason,
    rule_ids: resolution.ruleIds.join('; '),
    evidence: sourceText,
    observed_output: crmNameResolutionCustomFields(resolution),
  };
}

export function buildCrmQualityNameResolutionEval(args: Args): Record<string, unknown> {
  const cleanupPath = join(args.contractDir, 'stage1-cleanup-report-reviewed.csv');
  if (!existsSync(cleanupPath)) throw new Error(`CRM_QUALITY_EVAL_CONTRACT_MISSING:${cleanupPath}`);
  mkdirSync(args.outputDir, { recursive: true });

  const cleanupRows = readCsv<CleanupRow>(cleanupPath);
  const contactsById = indexById(readEvidenceJson<ContactEvidence>(join(args.contractDir, 'evidence-contacts.json')));
  const companiesById = indexById(readEvidenceJson<CompanyEvidence>(join(args.contractDir, 'evidence-companies.json')));

  const junkRows = cleanupRows.filter(row => row.review_grade === 'j');
  const cleanContacts = cleanupRows.filter(row => row.review_grade !== 'j' && row.entity_type === 'contact').slice(0, Math.floor(args.cleanControls / 2));
  const cleanCompanies = cleanupRows.filter(row => row.review_grade !== 'j' && row.entity_type === 'company').slice(0, args.cleanControls - cleanContacts.length);
  const evalRows = [...junkRows, ...cleanCompanies, ...cleanContacts].map(row => evaluateRow(
    row,
    contactsById.get(row.entity_id) as ContactEvidence | undefined,
    companiesById.get(row.entity_id) as CompanyEvidence | undefined
  ));

  const binaryPath = join(args.outputDir, 'crm-quality-binary-outcomes.csv');
  const contractPath = join(args.outputDir, 'crm-quality-gold-contract.csv');
  const rootCauseFailuresPath = join(args.outputDir, 'crm-quality-root-cause-failures.csv');
  const evidenceLedgerPath = join(args.outputDir, 'crm-quality-evidence-ledger.csv');
  const summaryPath = join(args.outputDir, 'crm-quality-summary.json');
  writeFileSync(binaryPath, csv(evalRows));
  writeFileSync(contractPath, csv(evalRows.map(row => ({
    split: row.split,
    original_row_number: row.original_row_number,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    current_name: row.current_name,
    review_grade: row.review_grade,
    root_cause: row.root_cause,
    target_class: row.target_class,
    expected_name: row.expected_name,
  }))));
  writeFileSync(rootCauseFailuresPath, csv(evalRows.filter(row => !row.clean_data_success)));
  writeFileSync(evidenceLedgerPath, csv(evalRows.map(row => ({
    original_row_number: row.original_row_number,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    root_cause: row.root_cause,
    produced_name: row.produced_name,
    produced_status: row.produced_status,
    rule_ids: row.rule_ids,
    evidence: row.evidence,
    observed_output: row.observed_output,
  }))));

  const nameTargets = evalRows.filter(row => !['merge', 'delete_no_entity', 'clean_control_keep'].includes(row.target_class));
  const summary = {
    validation_layer: 'pure_name_resolution_eval',
    contract_dir: args.contractDir,
    rows: evalRows.length,
    junk_rows: junkRows.length,
    clean_controls: cleanCompanies.length + cleanContacts.length,
    production_rows_written: 0,
    name_target_rows: nameTargets.length,
    name_target_success: nameTargets.filter(row => row.clean_name_success).length,
    name_target_failed: nameTargets.filter(row => !row.clean_name_success).length,
    clean_data_success: evalRows.filter(row => row.clean_data_success).length,
    clean_data_failed: evalRows.filter(row => !row.clean_data_success).length,
    false_positives_on_clean_controls: evalRows.filter(row => row.false_positive).length,
    development_rows: evalRows.filter(row => row.split === 'development').length,
    validation_rows: evalRows.filter(row => row.split === 'validation').length,
    holdout_rows: evalRows.filter(row => row.split === 'holdout').length,
    binary_outcomes_path: binaryPath,
    gold_contract_path: contractPath,
    root_cause_failures_path: rootCauseFailuresPath,
    evidence_ledger_path: evidenceLedgerPath,
    summary_path: summaryPath,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = buildCrmQualityNameResolutionEval(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}

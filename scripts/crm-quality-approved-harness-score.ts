#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import Papa from 'papaparse';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONTRACT_DIR = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');

interface Args {
  contractDir: string;
  replayDir: string;
  outputDir: string;
}

interface GoldRow {
  original_row_number: string;
  entity_type: string;
  entity_id: string;
  current_name: string;
  review_grade: string;
  root_cause: string;
  approved_after_state: string;
  approved_expected_name_or_names: string;
  approved_name_status: string;
  approved_gold_confidence: string;
  approved_gold_source: string;
  approved_evidence_basis: string;
  merge_target_id: string;
  delete_reason: string;
}

interface ReplayDecision {
  original_row_number: string;
  entity_type: string;
  entity_id: string;
  root_cause: string;
  replay_path: string;
  production_rows_written: string;
  observed_output: string;
  observed_decision: string;
  rule_ids: string;
  notes: string;
  runtime_source_channel?: string;
  runtime_codepath?: string;
  runtime_source_fields_used?: string;
  runtime_metadata_fetched_live?: string;
  gold_used_at_runtime?: string;
  evidence_policy?: string;
}

interface BinaryRow {
  original_row_number: string;
  produced_name: string;
  produced_name_status: string;
  clean_data_success: string;
  clean_name_success: string;
  binary_outcome_class: string;
  binary_failure_reason: string;
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      raw.set(key, next);
      i += 1;
    }
  }
  const replayDir = raw.get('replay-dir');
  if (!replayDir) throw new Error('APPROVED_HARNESS_SCORE_REQUIRES_REPLAY_DIR');
  return {
    contractDir: raw.get('contract-dir') || DEFAULT_CONTRACT_DIR,
    replayDir: replayDir.startsWith('/') ? replayDir : join(DEFAULT_CONTRACT_DIR, replayDir),
    outputDir: raw.get('output-dir')
      ? (raw.get('output-dir')!.startsWith('/') ? raw.get('output-dir')! : join(DEFAULT_CONTRACT_DIR, raw.get('output-dir')!))
      : join(replayDir.startsWith('/') ? replayDir : join(DEFAULT_CONTRACT_DIR, replayDir), 'approved-baseline-score'),
  };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(value: unknown): string {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function readCsv<T>(path: string): T[] {
  const parsed = Papa.parse<T>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV_PARSE_ERROR:${path}:${JSON.stringify(parsed.errors.slice(0, 3))}`);
  return parsed.data;
}

function csv(rows: object[]): string {
  return `${Papa.unparse(rows, { quotes: true, newline: '\n' })}\n`;
}

function producedNameFromDecision(row: ReplayDecision): string {
  const raw = clean(row.observed_output).replace(/\s+\{.*$/s, '').trim();
  if (/^(blocked|hold|reject|delete_candidate|merge_plan|CRM_QUALITY_GATE_BLOCKED|CRM_NAME_RESOLUTION_FAILED|CRM_COMPANY_SPLIT_REQUIRED|no contact created|no company created|no entity created|rejected_or_skipped)$/i.test(raw)) {
    return '';
  }
  return raw;
}

function nameMatches(produced: string, expected: string): boolean {
  return Boolean(produced && expected && normalized(produced) === normalized(expected));
}

function splitMatches(produced: string, expected: string): boolean {
  const expectedParts = expected.split(';').map(normalized).filter(Boolean);
  const actual = normalized(produced);
  return expectedParts.length > 1 && expectedParts.every(part => actual.includes(part));
}

function statusMatches(producedStatus: string, expectedStatus: string, afterState: string): boolean {
  if (afterState !== 'rename') return true;
  if (expectedStatus === 'provisional') return producedStatus === 'provisional';
  if (expectedStatus === 'verified') return producedStatus === 'ready' || producedStatus === 'verified';
  return true;
}

function scoreRow(gold: GoldRow, decision: ReplayDecision | undefined, binary: BinaryRow | undefined): Record<string, unknown> {
  const afterState = clean(gold.approved_after_state);
  const expected = clean(gold.approved_expected_name_or_names);
  const producedName = clean(binary?.produced_name) || (decision ? producedNameFromDecision(decision) : '');
  const producedStatus = clean(binary?.produced_name_status) || 'none';
  const observedDecision = clean(decision?.observed_decision);

  let nameOrActionMatch = false;
  let statusMatch = true;
  let inScope = true;
  let failure = '';

  if (afterState === 'rename') {
    nameOrActionMatch = nameMatches(producedName, expected);
    statusMatch = statusMatches(producedStatus, clean(gold.approved_name_status), afterState);
    if (!nameOrActionMatch) failure = `expected approved name "${expected}" but produced "${producedName || observedDecision || 'none'}"`;
    else if (!statusMatch) failure = `expected name_status ${gold.approved_name_status} but produced ${producedStatus}`;
  } else if (afterState === 'split') {
    nameOrActionMatch = splitMatches(producedName, expected);
    statusMatch = nameOrActionMatch;
    failure = nameOrActionMatch ? '' : `expected split names "${expected}" but produced "${producedName || observedDecision || 'none'}"`;
  } else if (afterState === 'merge') {
    nameOrActionMatch = observedDecision === 'merge_plan' && (!gold.merge_target_id || clean(decision?.observed_output) === clean(gold.merge_target_id));
    failure = nameOrActionMatch ? '' : `expected merge target ${gold.merge_target_id || expected || 'known duplicate'} but observed ${observedDecision || 'none'}`;
  } else if (afterState === 'no_entity') {
    nameOrActionMatch = ['blocked', 'delete_candidate', 'no_entity'].includes(observedDecision)
      || /no (?:contact|company|entity) created|CRM_NAME_RESOLUTION_FAILED|CRM_QUALITY_GATE_BLOCKED/i.test(clean(decision?.observed_output));
    failure = nameOrActionMatch ? '' : `expected no_entity/delete but observed ${observedDecision || decision?.observed_output || 'none'}`;
  } else if (afterState === 'keep') {
    nameOrActionMatch = !producedName || nameMatches(producedName, gold.current_name);
    failure = nameOrActionMatch ? '' : `clean control changed to "${producedName}"`;
  } else {
    inScope = false;
  }

  return {
    original_row_number: gold.original_row_number,
    entity_type: gold.entity_type,
    entity_id: gold.entity_id,
    root_cause: gold.root_cause,
    current_name: gold.current_name,
    approved_after_state: afterState,
    approved_expected_name_or_names: expected,
    approved_name_status: gold.approved_name_status,
    approved_gold_confidence: gold.approved_gold_confidence,
    produced_name: producedName,
    produced_name_status: producedStatus,
    observed_decision: observedDecision,
    replay_path: decision?.replay_path || '',
    production_rows_written: decision?.production_rows_written || '',
    approved_name_or_action_match: nameOrActionMatch,
    approved_status_match: statusMatch,
    approved_binary_success: inScope ? nameOrActionMatch && statusMatch : false,
    approved_eval_scope: inScope ? 'scored' : 'needs_source_excluded',
    failure_reason: inScope && !(nameOrActionMatch && statusMatch) ? failure : '',
    evidence_basis: gold.approved_evidence_basis,
    rule_ids: decision?.rule_ids || '',
    runtime_source_channel: decision?.runtime_source_channel || '',
    runtime_codepath: decision?.runtime_codepath || '',
    runtime_source_fields_used: decision?.runtime_source_fields_used || '',
    runtime_metadata_fetched_live: decision?.runtime_metadata_fetched_live || '',
    gold_used_at_runtime: decision?.gold_used_at_runtime || '',
    evidence_policy: decision?.evidence_policy || '',
  };
}

function build(args: Args): Record<string, unknown> {
  const goldPath = join(args.contractDir, 'crm-quality-approved-gold-contract.csv');
  const decisionsPath = join(args.replayDir, 'crm-quality-local-d1-replay-decisions.csv');
  const binaryPath = join(args.replayDir, 'crm-quality-binary-outcomes.csv');
  for (const required of [goldPath, decisionsPath, binaryPath]) {
    if (!existsSync(required)) throw new Error(`APPROVED_HARNESS_INPUT_MISSING:${required}`);
  }
  mkdirSync(args.outputDir, { recursive: true });
  const goldRows = readCsv<GoldRow>(goldPath);
  const decisionsByRow = new Map(readCsv<ReplayDecision>(decisionsPath).map(row => [clean(row.original_row_number), row]));
  const binaryByRow = new Map(readCsv<BinaryRow>(binaryPath).map(row => [clean(row.original_row_number), row]));

  const replayedRows = [...decisionsByRow.keys()];
  const outcomes = replayedRows
    .map(rowNumber => goldRows.find(row => clean(row.original_row_number) === rowNumber))
    .filter((row): row is GoldRow => Boolean(row))
    .map(row => scoreRow(row, decisionsByRow.get(clean(row.original_row_number)), binaryByRow.get(clean(row.original_row_number))));

  const scoredRows = outcomes.filter(row => row.approved_eval_scope === 'scored');
  const nameTargets = scoredRows.filter(row => ['rename', 'split'].includes(clean(row.approved_after_state)));
  const renameTargets = scoredRows.filter(row => clean(row.approved_after_state) === 'rename');
  const tentativeTargets = renameTargets.filter(row => row.approved_name_status === 'provisional');
  const cleanControls = scoredRows.filter(row => clean(row.approved_after_state) === 'keep');
  const noEntityTargets = scoredRows.filter(row => clean(row.approved_after_state) === 'no_entity');
  const mergeTargets = scoredRows.filter(row => clean(row.approved_after_state) === 'merge');

  const outcomesPath = join(args.outputDir, 'crm-quality-approved-baseline-outcomes.csv');
  const failuresPath = join(args.outputDir, 'crm-quality-approved-baseline-failures.csv');
  const summaryPath = join(args.outputDir, 'crm-quality-approved-baseline-summary.json');
  writeFileSync(outcomesPath, csv(outcomes));
  writeFileSync(failuresPath, csv(scoredRows.filter(row => row.approved_binary_success !== true)));

  const summary = {
    validation_layer: 'approved_gold_contract_scored_against_gold_blind_local_d1_replay',
    replay_dir: args.replayDir,
    gold_contract_path: goldPath,
    gold_contract_used_for_scoring_only: true,
    replay_source_gold_blind: true,
    runtime_gold_contamination_rows: outcomes.filter(row => clean(row.gold_used_at_runtime) !== 'false').length,
    production_rows_written: scoredRows.reduce((sum, row) => sum + Number(row.production_rows_written || 0), 0),
    replayed_rows_with_gold_contract: outcomes.length,
    scored_rows: scoredRows.length,
    excluded_needs_source_rows: outcomes.filter(row => row.approved_eval_scope !== 'scored').length,
    name_target_rows: nameTargets.length,
    name_target_success: nameTargets.filter(row => row.approved_binary_success === true).length,
    name_target_failed: nameTargets.filter(row => row.approved_binary_success !== true).length,
    rename_target_rows: renameTargets.length,
    rename_name_match: renameTargets.filter(row => row.approved_name_or_action_match === true).length,
    rename_status_match: renameTargets.filter(row => row.approved_status_match === true).length,
    rename_binary_success: renameTargets.filter(row => row.approved_binary_success === true).length,
    tentative_expected_rows: tentativeTargets.length,
    tentative_expected_success: tentativeTargets.filter(row => row.approved_binary_success === true).length,
    no_entity_rows: noEntityTargets.length,
    no_entity_success: noEntityTargets.filter(row => row.approved_binary_success === true).length,
    merge_rows: mergeTargets.length,
    merge_success: mergeTargets.filter(row => row.approved_binary_success === true).length,
    clean_control_rows: cleanControls.length,
    clean_control_success: cleanControls.filter(row => row.approved_binary_success === true).length,
    outcomes_path: outcomesPath,
    failures_path: failuresPath,
    summary_path: summaryPath,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(build(parseArgs(process.argv.slice(2))), null, 2));
}

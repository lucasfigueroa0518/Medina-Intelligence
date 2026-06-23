#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import Papa from 'papaparse';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONTRACT_DIR = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');
const TENTATIVE_NAMES = new Set(['FVS SGR SpA', 'Erhvervsinvest', 'imec.xpand']);

interface Args {
  contractDir: string;
}

interface CleanupRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_name: string;
  review_grade: string;
  review_notes: string;
  workstream: string;
  proposed_action: string;
  proposed_name: string;
  merge_target_id: string;
  delete_reason: string;
  evidence: string;
  confidence: string;
  inferred_reasoning: string;
  notes: string;
  root_cause: string;
  original_proposed_name: string;
  reviewer_corrected_name: string;
  final_proposed_name: string;
}

interface BaselineRow {
  original_row_number: string;
  proposed_after_state: string;
  proposed_baseline_name_or_names: string;
  confidence: string;
  evidence_basis: string;
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
  return { contractDir: raw.get('contract-dir') || DEFAULT_CONTRACT_DIR };
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function readCsv<T>(path: string): T[] {
  const parsed = Papa.parse<T>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(`CSV_PARSE_ERROR:${path}:${JSON.stringify(parsed.errors.slice(0, 3))}`);
  return parsed.data;
}

function csv(rows: object[]): string {
  return `${Papa.unparse(rows, { quotes: true, newline: '\n' })}\n`;
}

function approvedState(row: CleanupRow, baseline?: BaselineRow): string {
  if (row.review_grade !== 'j') return 'keep';
  if (baseline?.proposed_after_state) return baseline.proposed_after_state;
  if (row.proposed_action === 'rename' && clean(row.final_proposed_name)) return 'rename';
  if (row.proposed_action === 'merge') return 'merge';
  if (row.proposed_action === 'delete') return 'no_entity';
  return 'needs_source';
}

function expectedName(row: CleanupRow, baseline?: BaselineRow): string {
  const state = approvedState(row, baseline);
  if (baseline && ['rename', 'split'].includes(state)) return clean(baseline.proposed_baseline_name_or_names);
  if (row.proposed_action === 'rename') return clean(row.final_proposed_name || row.reviewer_corrected_name || row.proposed_name);
  if (state === 'merge') return clean(row.merge_target_id);
  return '';
}

function expectedStatus(name: string, state: string): string {
  if (!name) return 'none';
  if (state === 'split') return 'split_required';
  return TENTATIVE_NAMES.has(name) ? 'provisional' : 'verified';
}

function build(args: Args): Record<string, unknown> {
  mkdirSync(args.contractDir, { recursive: true });
  const cleanupPath = join(args.contractDir, 'stage1-cleanup-report-reviewed.csv');
  const baselinePath = join(args.contractDir, 'proposed-baseline-names-for-junk-no-final-name.csv');
  if (!existsSync(cleanupPath)) throw new Error(`APPROVED_BASELINE_MISSING:${cleanupPath}`);
  if (!existsSync(baselinePath)) throw new Error(`APPROVED_BASELINE_MISSING:${baselinePath}`);

  const cleanupRows = readCsv<CleanupRow>(cleanupPath);
  const baselineRows = readCsv<BaselineRow>(baselinePath);
  const baselineByRow = new Map(baselineRows.map(row => [clean(row.original_row_number), row]));

  const updatedCleanup = cleanupRows.map(row => {
    const baseline = baselineByRow.get(clean(row.original_row_number));
    const state = approvedState(row, baseline);
    const name = expectedName(row, baseline);
    const status = expectedStatus(name, state);
    const next: Record<string, unknown> = {
      ...row,
      approved_after_state: state,
      approved_expected_name_or_names: name,
      approved_name_status: status,
      approved_evidence_basis: baseline?.evidence_basis || row.evidence || row.notes,
      approved_gold_confidence: baseline?.confidence || row.confidence,
      approved_gold_source: baseline
        ? 'user_approved_baseline_2026-06-20'
        : row.final_proposed_name
          ? 'stage1_curated_name'
          : row.proposed_action === 'merge'
            ? 'stage1_merge_target'
            : row.proposed_action === 'delete'
              ? 'stage1_no_entity_target'
              : row.review_grade === 'j'
                ? 'unresolved_junk_row'
                : 'clean_control',
    };
    if (baseline && state === 'rename' && name) {
      next.proposed_action = 'rename';
      next.proposed_name = name;
      next.final_proposed_name = name;
      next.confidence = baseline.confidence || row.confidence;
      next.notes = `${row.notes || ''} | Approved baseline name added from user-approved no-final-name curation.`.trim();
    }
    if (baseline && state === 'no_entity') {
      next.proposed_action = 'delete';
      next.delete_reason = row.delete_reason || baseline.evidence_basis || 'approved no-entity baseline';
      next.notes = `${row.notes || ''} | Approved no-entity baseline added from no-final-name curation.`.trim();
    }
    return next;
  });

  const goldContract = updatedCleanup.map(row => ({
    original_row_number: row.original_row_number,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    current_name: row.current_name,
    review_grade: row.review_grade,
    root_cause: row.root_cause,
    approved_after_state: (row as any).approved_after_state,
    approved_expected_name_or_names: (row as any).approved_expected_name_or_names,
    approved_name_status: (row as any).approved_name_status,
    approved_gold_confidence: (row as any).approved_gold_confidence,
    approved_gold_source: (row as any).approved_gold_source,
    approved_evidence_basis: (row as any).approved_evidence_basis,
    merge_target_id: row.merge_target_id,
    delete_reason: row.delete_reason,
  }));

  const canaryNameRows = goldContract
    .filter(row => ['rename', 'split'].includes(clean(row.approved_after_state)) && clean(row.approved_expected_name_or_names))
    .slice(0, 200)
    .map(row => ({
      original_row_number: row.original_row_number,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      current_bad_output: row.current_name,
      ideal_expected_output: row.approved_expected_name_or_names,
      root_cause_represented: row.root_cause,
      why_selected: 'approved clean-name baseline canary',
      proposed_pipeline_behavior: row.approved_after_state === 'split' ? 'split into separate named entities' : `produce ${row.approved_name_status} clean name`,
      pass_fail_criteria: row.approved_after_state === 'split'
        ? `must represent all split names: ${row.approved_expected_name_or_names}`
        : `produced_name must match ${row.approved_expected_name_or_names} and status must be ${row.approved_name_status}`,
    }));

  const updatedCleanupPath = join(args.contractDir, 'stage1-cleanup-report-approved-baseline.csv');
  const goldContractPath = join(args.contractDir, 'crm-quality-approved-gold-contract.csv');
  const approvedBaselinePath = join(args.contractDir, 'proposed-baseline-names-for-junk-no-final-name-approved.csv');
  const canaryPath = join(args.contractDir, 'approved-baseline-canary-200.csv');
  const summaryPath = join(args.contractDir, 'crm-quality-approved-baseline-summary.json');

  writeFileSync(updatedCleanupPath, csv(updatedCleanup));
  writeFileSync(goldContractPath, csv(goldContract));
  writeFileSync(approvedBaselinePath, csv(baselineRows.map(row => ({
    ...row,
    approved_name_status: expectedStatus(clean(row.proposed_baseline_name_or_names), row.proposed_after_state),
    approved_by_user: 'yes',
    approved_at: '2026-06-20',
  }))));
  writeFileSync(canaryPath, csv(canaryNameRows));

  const summary = {
    updated_cleanup_path: updatedCleanupPath,
    gold_contract_path: goldContractPath,
    approved_baseline_path: approvedBaselinePath,
    approved_canary_path: canaryPath,
    rows: goldContract.length,
    approved_rename_or_split_name_targets: goldContract.filter(row => ['rename', 'split'].includes(clean(row.approved_after_state))).length,
    tentative_expected_names: goldContract.filter(row => row.approved_name_status === 'provisional').length,
    tentative_expected_name_values: [...TENTATIVE_NAMES],
    canary_rows: canaryNameRows.length,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(build(parseArgs(process.argv.slice(2))), null, 2));
}

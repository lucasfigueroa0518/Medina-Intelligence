#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import Papa from 'papaparse';

import {
  CRM_QUALITY_RULES,
  evaluateCrmQualityGate,
  type CrmQualityAction,
  type CrmQualityGateResult,
} from '../src/lib/crm-quality-gate';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONTRACT_DIR = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');

interface Args {
  contractDir: string;
  outputDir: string;
  minPassRate: number;
  allowFailures: boolean;
}

interface CanaryRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_bad_output: string;
  ideal_expected_output: string;
  root_cause_represented: string;
  why_selected: string;
  proposed_pipeline_behavior: string;
  pass_fail_criteria: string;
}

interface MatrixRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_name: string;
  proposed_action: 'keep' | 'rename' | 'merge' | 'delete' | 'investigate';
  proposed_name: string;
  final_proposed_name: string;
  merge_target_id: string;
  delete_reason: string;
  root_cause: string;
  exact_validation_rule_ids: string;
  coverage_status: string;
  canary_assertion: string;
  path_confidence: string;
  correction_confidence: string;
  stage1_evidence: string;
}

export interface CanaryDecisionRow {
  original_row_number: string;
  entity_type: 'contact' | 'company';
  entity_id: string;
  current_bad_output: string;
  expected_action: string;
  expected_output: string;
  root_cause: string;
  gate_decision: string;
  write_allowed: boolean;
  normalized_name: string;
  merge_target_id: string;
  delete_reason: string;
  rule_ids: string;
  reasons: string;
  passed: boolean;
  failure_reason: string;
}

export interface CrmQualityCanarySummary {
  dry_run: true;
  contract_dir: string;
  source_workbooks: string[];
  canary_rows: number;
  rows_written: 0;
  changed_db: false;
  passed: number;
  failed: number;
  pass_rate: number;
  min_pass_rate: number;
  rule_coverage: Record<string, number>;
  decision_counts: Record<string, number>;
  failures_path: string;
  decisions_path: string;
  summary_path: string;
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
  const minPassRate = Number(raw.get('min-pass-rate') || '1');
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    throw new Error('INVALID_MIN_PASS_RATE');
  }
  return {
    contractDir: raw.get('contract-dir') || DEFAULT_CONTRACT_DIR,
    outputDir: raw.get('output-dir') || join(DEFAULT_CONTRACT_DIR, `crm-quality-canary-${today}`),
    minPassRate,
    allowFailures: raw.get('allow-failures') === 'true',
  };
}

function readCsv<T>(path: string): T[] {
  const parsed = Papa.parse<T>(readFileSync(path, 'utf8'), {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    throw new Error(`CSV_PARSE_ERROR:${path}:${JSON.stringify(parsed.errors.slice(0, 3))}`);
  }
  return parsed.data;
}

function csv(rows: object[]): string {
  return `${Papa.unparse(rows, { quotes: true, newline: '\n' })}\n`;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function expectedAction(matrix: MatrixRow | undefined, row: CanaryRow): MatrixRow['proposed_action'] {
  if (matrix?.proposed_action) return matrix.proposed_action;
  if (/hold|investigation/i.test(row.ideal_expected_output)) return 'investigate';
  return 'rename';
}

function gateAction(action: MatrixRow['proposed_action']): CrmQualityAction {
  if (action === 'rename') return 'rename';
  if (action === 'merge') return 'merge';
  if (action === 'delete') return 'delete';
  if (action === 'investigate') return 'investigate';
  return 'update_name';
}

function expectedName(matrix: MatrixRow | undefined, row: CanaryRow): string {
  if (matrix?.final_proposed_name) return matrix.final_proposed_name;
  if (matrix?.proposed_name) return matrix.proposed_name;
  if (!/hold for human investigation/i.test(row.ideal_expected_output)) return row.ideal_expected_output;
  return '';
}

function ruleList(matrix: MatrixRow | undefined): string[] {
  return clean(matrix?.exact_validation_rule_ids)
    .split(';')
    .map(rule => clean(rule))
    .filter(Boolean);
}

function hasCoreRules(gate: CrmQualityGateResult): boolean {
  return gate.ruleIds.includes(CRM_QUALITY_RULES.WRITE_GATE)
    && gate.ruleIds.includes(CRM_QUALITY_RULES.EVIDENCE_LEDGER);
}

function evaluatePass(
  row: CanaryRow,
  matrix: MatrixRow | undefined,
  gate: CrmQualityGateResult
): { passed: boolean; reason: string } {
  const action = expectedAction(matrix, row);
  const name = expectedName(matrix, row);
  const expectedRules = ruleList(matrix);
  const coreRules = new Set<string>([
    CRM_QUALITY_RULES.WRITE_GATE,
    CRM_QUALITY_RULES.EVIDENCE_LEDGER,
  ]);
  const representedRules = expectedRules.filter(rule => !coreRules.has(rule));

  if (!hasCoreRules(gate)) return { passed: false, reason: 'missing core write-gate/evidence-ledger rules' };
  const missingRules = representedRules.filter(rule => !gate.ruleIds.includes(rule));
  if (missingRules.length) {
    return { passed: false, reason: `missing represented rule(s) ${missingRules.join(', ')}` };
  }

  if (action === 'investigate') {
    if ((gate.decision === 'hold' || gate.decision === 'queue') && !gate.writeAllowed) {
      return { passed: true, reason: '' };
    }
    return { passed: false, reason: `expected hold/queue without write, got ${gate.decision}` };
  }

  if (action === 'rename') {
    if (!name) return { passed: false, reason: 'rename row has no expected canonical name' };
    if (!['apply', 'queue'].includes(gate.decision)) {
      return { passed: false, reason: `expected apply/queue rename proposal, got ${gate.decision}` };
    }
    if (lower(gate.normalizedName) !== lower(name)) {
      return { passed: false, reason: `expected normalized name "${name}", got "${gate.normalizedName || ''}"` };
    }
    return { passed: true, reason: '' };
  }

  if (action === 'merge') {
    if (gate.decision !== 'merge_plan') return { passed: false, reason: `expected merge_plan, got ${gate.decision}` };
    if (matrix?.merge_target_id && gate.mergeTargetId !== matrix.merge_target_id) {
      return { passed: false, reason: `expected merge target ${matrix.merge_target_id}, got ${gate.mergeTargetId || ''}` };
    }
    return { passed: true, reason: '' };
  }

  if (action === 'delete') {
    if (gate.decision !== 'delete_candidate' || gate.writeAllowed) {
      return { passed: false, reason: `expected delete_candidate without write, got ${gate.decision}` };
    }
    return { passed: true, reason: '' };
  }

  return { passed: true, reason: '' };
}

function indexMatrix(rows: MatrixRow[]): Map<string, MatrixRow> {
  const index = new Map<string, MatrixRow>();
  for (const row of rows) {
    index.set(`${row.entity_id}:${row.original_row_number}`, row);
    index.set(row.entity_id, row);
  }
  return index;
}

export function buildCrmQualityCanarySummary(args: Args): CrmQualityCanarySummary {
  const canaryPath = join(args.contractDir, 'canary-set-200-reviewed.csv');
  const matrixPath = join(args.contractDir, 'junk-to-rule-coverage-matrix-reviewed.csv');
  const originalWorkbook = join(args.contractDir, 'crm-stage1-investigation.xlsx');
  const reviewedWorkbook = join(args.contractDir, 'crm-stage1-investigation-traceability-reviewed.xlsx');
  for (const required of [canaryPath, matrixPath, originalWorkbook, reviewedWorkbook]) {
    if (!existsSync(required)) throw new Error(`CRM_QUALITY_CANARY_CONTRACT_MISSING:${required}`);
  }

  const canaryRows = readCsv<CanaryRow>(canaryPath);
  const matrixRows = indexMatrix(readCsv<MatrixRow>(matrixPath));
  const decisions: CanaryDecisionRow[] = [];

  for (const row of canaryRows) {
    const matrix = matrixRows.get(`${row.entity_id}:${row.original_row_number}`) || matrixRows.get(row.entity_id);
    const action = expectedAction(matrix, row);
    const name = expectedName(matrix, row);
    const gate = evaluateCrmQualityGate({
      entityType: row.entity_type,
      action: gateAction(action),
      currentName: row.current_bad_output,
      proposedName: name || matrix?.proposed_name || row.current_bad_output,
      expectedAction: action,
      expectedName: name || null,
      rootCause: matrix?.root_cause || row.root_cause_represented,
      mergeTargetId: matrix?.merge_target_id || null,
      deleteReason: matrix?.delete_reason || null,
      source: {
        source_channel: 'stage1_reviewed_workbook',
        source_record_id: row.original_row_number,
        source_text: matrix?.stage1_evidence || row.why_selected,
        codepath: 'crm_quality_canary_fixture_replay',
      },
    });
    const pass = evaluatePass(row, matrix, gate);
    decisions.push({
      original_row_number: row.original_row_number,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      current_bad_output: row.current_bad_output,
      expected_action: action,
      expected_output: name || row.ideal_expected_output,
      root_cause: matrix?.root_cause || row.root_cause_represented,
      gate_decision: gate.decision,
      write_allowed: gate.writeAllowed,
      normalized_name: gate.normalizedName || '',
      merge_target_id: gate.mergeTargetId || '',
      delete_reason: gate.deleteReason || '',
      rule_ids: gate.ruleIds.join('; '),
      reasons: gate.reasons.join('; '),
      passed: pass.passed,
      failure_reason: pass.reason,
    });
  }

  mkdirSync(args.outputDir, { recursive: true });
  const decisionsPath = join(args.outputDir, 'crm-quality-canary-decisions.jsonl');
  const failuresPath = join(args.outputDir, 'crm-quality-canary-failures.csv');
  const summaryPath = join(args.outputDir, 'crm-quality-canary-summary.json');
  writeFileSync(decisionsPath, decisions.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(failuresPath, csv(decisions.filter(row => !row.passed)));

  const passed = decisions.filter(row => row.passed).length;
  const failed = decisions.length - passed;
  const ruleCoverage: Record<string, number> = {};
  const decisionCounts: Record<string, number> = {};
  for (const row of decisions) {
    decisionCounts[row.gate_decision] = (decisionCounts[row.gate_decision] || 0) + 1;
    for (const rule of row.rule_ids.split(';').map(rule => clean(rule)).filter(Boolean)) {
      ruleCoverage[rule] = (ruleCoverage[rule] || 0) + 1;
    }
  }

  const summary: CrmQualityCanarySummary = {
    dry_run: true,
    contract_dir: args.contractDir,
    source_workbooks: [originalWorkbook, reviewedWorkbook],
    canary_rows: decisions.length,
    rows_written: 0,
    changed_db: false,
    passed,
    failed,
    pass_rate: decisions.length ? passed / decisions.length : 0,
    min_pass_rate: args.minPassRate,
    rule_coverage: ruleCoverage,
    decision_counts: decisionCounts,
    failures_path: failuresPath,
    decisions_path: decisionsPath,
    summary_path: summaryPath,
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (!args.allowFailures && (summary.pass_rate < args.minPassRate || failed > 0)) {
    throw new Error(`CRM_QUALITY_CANARY_FAILED:${passed}/${decisions.length} passed; failures=${failuresPath}`);
  }

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = buildCrmQualityCanarySummary(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}

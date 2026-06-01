#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export interface ProspectClassifierGateThresholds {
  minExactCreatePrecision: number;
  minExactAttachPrecision: number;
  minValuablePrecision: number;
  minValuableRecall: number;
  minWrongEntityCorrectedOrSuppressed: number;
}

export interface ProspectClassifierGateCheck {
  name: string;
  actual: unknown;
  expected: string;
  passed: boolean;
}

export interface ProspectClassifierGateResult {
  passed: boolean;
  checks: ProspectClassifierGateCheck[];
}

export const DEFAULT_PROSPECT_CLASSIFIER_GATE_THRESHOLDS: ProspectClassifierGateThresholds = {
  minExactCreatePrecision: 0.98,
  minExactAttachPrecision: 0.951,
  minValuablePrecision: 0.968,
  minValuableRecall: 0.96,
  minWrongEntityCorrectedOrSuppressed: 6,
};

interface Args {
  summaryPath: string;
  manifestPath: string | null;
  thresholds: ProspectClassifierGateThresholds;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`INVALID_NUMERIC_THRESHOLD:${value}`);
  return n;
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
  const summaryPath = raw.get('summary') || raw.get('replay-benchmark-summary');
  if (!summaryPath) {
    throw new Error('Usage: tsx scripts/prospect-classifier-gate.ts --summary <replay-benchmark-summary.json> [--manifest <manifest.json>]');
  }
  const defaults = DEFAULT_PROSPECT_CLASSIFIER_GATE_THRESHOLDS;
  return {
    summaryPath,
    manifestPath: raw.get('manifest') || null,
    thresholds: {
      minExactCreatePrecision: parseNumber(raw.get('min-exact-create-precision'), defaults.minExactCreatePrecision),
      minExactAttachPrecision: parseNumber(raw.get('min-exact-attach-precision'), defaults.minExactAttachPrecision),
      minValuablePrecision: parseNumber(raw.get('min-valuable-precision'), defaults.minValuablePrecision),
      minValuableRecall: parseNumber(raw.get('min-valuable-recall'), defaults.minValuableRecall),
      minWrongEntityCorrectedOrSuppressed: parseNumber(raw.get('min-wrong-entity-corrected'), defaults.minWrongEntityCorrectedOrSuppressed),
    },
  };
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const n = Number(source[key]);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function evaluateProspectClassifierGate(input: {
  summary: Record<string, unknown>;
  manifest?: Record<string, unknown> | null;
  thresholds?: Partial<ProspectClassifierGateThresholds>;
}): ProspectClassifierGateResult {
  const thresholds = {
    ...DEFAULT_PROSPECT_CLASSIFIER_GATE_THRESHOLDS,
    ...(input.thresholds || {}),
  };
  const manifest = input.manifest || {};
  const remoteMeta = (manifest.remote_d1_meta && typeof manifest.remote_d1_meta === 'object')
    ? manifest.remote_d1_meta as Record<string, unknown>
    : {};
  const rowsWritten = manifest.rows_written ?? remoteMeta.rows_written;
  const changedDb = manifest.changed_db ?? remoteMeta.changed_db;
  const checks: ProspectClassifierGateCheck[] = [
    {
      name: 'exact_create_precision',
      actual: input.summary.exact_create_precision,
      expected: `>= ${thresholds.minExactCreatePrecision}`,
      passed: numberAt(input.summary, 'exact_create_precision') >= thresholds.minExactCreatePrecision,
    },
    {
      name: 'exact_attach_precision',
      actual: input.summary.exact_attach_precision,
      expected: `>= ${thresholds.minExactAttachPrecision}`,
      passed: numberAt(input.summary, 'exact_attach_precision') >= thresholds.minExactAttachPrecision,
    },
    {
      name: 'valuable_precision',
      actual: input.summary.valuable_precision,
      expected: `>= ${thresholds.minValuablePrecision}`,
      passed: numberAt(input.summary, 'valuable_precision') >= thresholds.minValuablePrecision,
    },
    {
      name: 'valuable_recall',
      actual: input.summary.valuable_recall,
      expected: `>= ${thresholds.minValuableRecall}`,
      passed: numberAt(input.summary, 'valuable_recall') >= thresholds.minValuableRecall,
    },
    {
      name: 'wrong_entity_corrected_or_suppressed',
      actual: input.summary.wrong_entity_corrected_or_suppressed,
      expected: `>= ${thresholds.minWrongEntityCorrectedOrSuppressed}`,
      passed: numberAt(input.summary, 'wrong_entity_corrected_or_suppressed') >= thresholds.minWrongEntityCorrectedOrSuppressed,
    },
  ];

  if (input.manifest) {
    checks.push(
      {
        name: 'rows_written',
        actual: rowsWritten,
        expected: '0',
        passed: Number(rowsWritten) === 0,
      },
      {
        name: 'changed_db',
        actual: changedDb,
        expected: 'false',
        passed: changedDb === false,
      }
    );
  }

  return { passed: checks.every(check => check.passed), checks };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await readJson(args.summaryPath);
  const manifest = args.manifestPath ? await readJson(args.manifestPath) : null;
  const result = evaluateProspectClassifierGate({ summary, manifest, thresholds: args.thresholds });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

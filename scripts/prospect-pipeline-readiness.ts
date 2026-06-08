#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  evaluateProspectClassifierGate,
  type ProspectClassifierGateResult,
} from './prospect-classifier-gate';

export type ProspectPipelineReadinessStatus = 'pass' | 'warn' | 'fail';

export interface ProspectPipelineReadinessCheck {
  name: string;
  status: ProspectPipelineReadinessStatus;
  detail: string;
}

export interface ProspectPipelineReadinessResult {
  passed: boolean;
  checks: ProspectPipelineReadinessCheck[];
}

export interface ProspectPipelineReadinessSources {
  packageJson: string;
  workQueueDriver: string;
  prospectDetectHandler: string;
  prospectPipelineCanary: string;
  prospectLiveCanary: string;
  prospectBackfillWindow: string;
  prospectPipelineHealth: string;
  prospectIntelligence: string;
  materializeKnownDeals: string;
  bridgeMaterialize: string;
  migrationReadinessCheck: string;
  migration0114: string;
  migration0115: string;
  migration0116: string;
}

interface Args {
  summaryPath: string | null;
  manifestPath: string | null;
}

const DEFAULT_FILES = {
  packageJson: 'package.json',
  workQueueDriver: 'src/lib/work-queue-driver.ts',
  prospectDetectHandler: 'src/lib/work-queue-handlers/prospect-detect.ts',
  prospectPipelineCanary: 'scripts/prospect-pipeline-canary.ts',
  prospectLiveCanary: 'scripts/prospect-live-canary.ts',
  prospectBackfillWindow: 'scripts/prospect-backfill-window.ts',
  prospectPipelineHealth: 'scripts/prospect-pipeline-health.ts',
  prospectIntelligence: 'src/lib/prospect-intelligence.ts',
  materializeKnownDeals: 'scripts/prospect-materialize-known-deals.ts',
  bridgeMaterialize: 'scripts/prospect-bridge-materialize.ts',
  migrationReadinessCheck: 'scripts/prospect-migration-readiness-check.ts',
  migration0114: 'migrations/0114_prospect_intelligence.sql',
  migration0115: 'migrations/0115_ingestion_evidence_hardening.sql',
  migration0116: 'migrations/0116_prospect_deal_backlinks.sql',
} as const;

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
  return {
    summaryPath: raw.get('summary') || raw.get('replay-benchmark-summary') || null,
    manifestPath: raw.get('manifest') || null,
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function readDefaultSources(): Promise<ProspectPipelineReadinessSources> {
  const entries = await Promise.all(
    Object.entries(DEFAULT_FILES).map(async ([key, path]) => [key, await readFile(path, 'utf8')] as const)
  );
  return Object.fromEntries(entries) as unknown as ProspectPipelineReadinessSources;
}

function check(
  name: string,
  passed: boolean,
  detail: string,
  statusOnFail: ProspectPipelineReadinessStatus = 'fail'
): ProspectPipelineReadinessCheck {
  return { name, status: passed ? 'pass' : statusOnFail, detail };
}

function gateChecksToReadiness(gate: ProspectClassifierGateResult): ProspectPipelineReadinessCheck[] {
  return gate.checks.map(entry => ({
    name: `classifier_gate.${entry.name}`,
    status: entry.passed ? 'pass' : 'fail',
    detail: `actual=${String(entry.actual)} expected=${entry.expected}`,
  }));
}

export function evaluateProspectPipelineReadiness(input: {
  sources: ProspectPipelineReadinessSources;
  summary?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
}): ProspectPipelineReadinessResult {
  const checks: ProspectPipelineReadinessCheck[] = [];
  const sources = input.sources;
  const packageJson = JSON.parse(sources.packageJson) as { scripts?: Record<string, string> };

  if (input.summary) {
    checks.push(...gateChecksToReadiness(evaluateProspectClassifierGate({
      summary: input.summary,
      manifest: input.manifest || null,
    })));
  } else {
    checks.push({
      name: 'classifier_gate.available',
      status: 'warn',
      detail: 'No replay summary supplied. Run with --summary and --manifest before GO.',
    });
  }

  checks.push(
    check(
      'package.pipeline_readiness_script',
      packageJson.scripts?.['prospect:pipeline-readiness'] === 'tsx scripts/prospect-pipeline-readiness.ts',
      'package.json exposes npm run prospect:pipeline-readiness'
    ),
    check(
      'package.classifier_gate_script',
      packageJson.scripts?.['prospect:classifier-gate'] === 'tsx scripts/prospect-classifier-gate.ts',
      'package.json exposes npm run prospect:classifier-gate'
    ),
    check(
      'package.pipeline_canary_script',
      packageJson.scripts?.['prospect:pipeline-canary'] === 'tsx scripts/prospect-pipeline-canary.ts',
      'package.json exposes npm run prospect:pipeline-canary'
    ),
    check(
      'package.live_canary_script',
      packageJson.scripts?.['prospect:live-canary'] === 'tsx scripts/prospect-live-canary.ts',
      'package.json exposes npm run prospect:live-canary'
    ),
    check(
      'package.backfill_window_script',
      packageJson.scripts?.['prospect:backfill-window'] === 'tsx scripts/prospect-backfill-window.ts',
      'package.json exposes npm run prospect:backfill-window'
    ),
    check(
      'package.pipeline_health_script',
      packageJson.scripts?.['prospect:pipeline-health'] === 'tsx scripts/prospect-pipeline-health.ts',
      'package.json exposes npm run prospect:pipeline-health'
    ),
    check(
      'package.migration_readiness_script',
      packageJson.scripts?.['prospect:migration-readiness'] === 'tsx scripts/prospect-migration-readiness-check.ts',
      'package.json exposes npm run prospect:migration-readiness'
    ),
    check(
      'work_queue.prospect_detect_registered',
      /prospectDetectHandler/.test(sources.workQueueDriver) &&
        /work-queue-handlers\/prospect-detect/.test(sources.workQueueDriver),
      'prospect_detect is registered in the shared work queue driver'
    ),
    check(
      'work_queue.prospect_detect_retry_safety',
      /deadLetterWork/.test(sources.prospectDetectHandler) &&
        /deferWork/.test(sources.prospectDetectHandler) &&
        /CLAUDE_RATE_LIMITED\|429/.test(sources.prospectDetectHandler),
      'prospect_detect dead-letters malformed/missing rows and defers Claude/rate-limit failures'
    ),
    check(
      'work_queue.prospect_detect_idempotency',
      /idempotency_key/.test(sources.prospectDetectHandler) &&
        /:prospect_detect:v1/.test(sources.prospectDetectHandler),
      'manual/canary prospect enqueue path uses stable idempotency keys'
    ),
    check(
      'work_queue.prospect_detect_telemetry',
      /prospect_detect_processed/.test(sources.prospectDetectHandler) &&
        /known_deals_attached/.test(sources.prospectDetectHandler) &&
        /record_context_skipped/.test(sources.prospectDetectHandler) &&
        /ignored_or_noise_skipped/.test(sources.prospectDetectHandler) &&
        /deferred_rate_limited/.test(sources.prospectDetectHandler),
      'prospect_detect emits structured source-level telemetry for created, attached, skipped, deferred, and errored signals'
    ),
    check(
      'work_queue.prospect_detect_budget_guard',
      /upstream_budget_ledger/.test(sources.prospectDetectHandler) &&
        /prospectClassifierBudgetUpstreams/.test(sources.prospectDetectHandler) &&
        /classifier circuit open/.test(sources.prospectDetectHandler),
      'prospect_detect checks the shared upstream budget ledger before classifier work'
    ),
    check(
      'canary.dry_run_only',
      /rows_written:\s*0/.test(sources.prospectPipelineCanary) &&
        /changed_db:\s*false/.test(sources.prospectPipelineCanary) &&
        !/enqueueProspectDetectSource/.test(sources.prospectPipelineCanary),
      'prospect pipeline canary reads source rows and emits payloads without enqueuing or writing'
    ),
    check(
      'canary.classify_only_available',
      /classifyProspectSignalsDryRun/.test(sources.prospectPipelineCanary) &&
        /CANARY_READ_ONLY_SQL_VIOLATION/.test(sources.prospectPipelineCanary) &&
        /CANARY_CLASSIFICATION_INCOMPLETE/.test(sources.prospectPipelineCanary) &&
        /hydration_status/.test(sources.prospectPipelineCanary) &&
        /classification_status/.test(sources.prospectPipelineCanary) &&
        /dry_run_counter_labels/.test(sources.prospectPipelineCanary) &&
        /canary-decisions\.jsonl/.test(sources.prospectPipelineCanary) &&
        /No queue rows, prospects, prospect signals/.test(sources.prospectPipelineCanary),
      'prospect pipeline canary can classify recent sources through a read-only dry-run path and write audit artifacts'
    ),
    check(
      'canary.remote_read_proof_available',
      /wrangler_d1_remote_select/.test(sources.prospectPipelineCanary) &&
        /remoteReadOnlyCanaryEnv/.test(sources.prospectPipelineCanary) &&
        /REMOTE_D1_READ_ONLY_VIOLATION/.test(sources.prospectPipelineCanary) &&
        /rows_written/.test(sources.prospectPipelineCanary) &&
        /changed_db/.test(sources.prospectPipelineCanary),
      'prospect pipeline canary can use wrangler D1 remote SELECTs and aborts unless rows_written=0 and changed_db=false'
    ),
    check(
      'canary.high_signal_mode_available',
      /highSignalPredicateSql/.test(sources.prospectPipelineCanary) &&
        /HIGH_SIGNAL_TERMS/.test(sources.prospectPipelineCanary) &&
        /CANARY_HIGH_SIGNAL_EMPTY_DECISIONS/.test(sources.prospectPipelineCanary) &&
        /allow-empty-decisions/.test(sources.prospectPipelineCanary),
      'prospect pipeline canary can target high-signal source rows and fails closed on empty classified decisions unless explicitly allowed'
    ),
    check(
      'live_canary.explicit_go_required',
      /PROSPECT_LIVE_CANARY_GO/.test(sources.prospectLiveCanary) &&
        /PROSPECT_LIVE_CANARY_REQUIRES_EXPLICIT_GO/.test(sources.prospectLiveCanary) &&
        /enqueueProspectDetectSource/.test(sources.prospectLiveCanary) &&
        /INVALID_LIMIT_MAX_10/.test(sources.prospectLiveCanary),
      'live prospect canary refuses production enqueue without exact Lucas GO token and caps source count'
    ),
    check(
      'backfill_window.explicit_go_required',
      /PROSPECT_BACKFILL_GO/.test(sources.prospectBackfillWindow) &&
        /PROSPECT_BACKFILL_REQUIRES_EXPLICIT_GO/.test(sources.prospectBackfillWindow) &&
        /PROSPECT_BACKFILL_WINDOW_TOO_LARGE/.test(sources.prospectBackfillWindow) &&
        /PROSPECT_BACKFILL_BATCH_TOO_LARGE/.test(sources.prospectBackfillWindow) &&
        /runProspectBackfillWindow/.test(sources.prospectBackfillWindow),
      'backfill window wrapper previews by default and refuses writes or broad windows without explicit GO'
    ),
    check(
      'pipeline_health.read_only_monitor',
      /read_only:\s*true/.test(sources.prospectPipelineHealth) &&
        /PIPELINE_HEALTH_READ_ONLY_VIOLATION/.test(sources.prospectPipelineHealth) &&
        /work_queue/.test(sources.prospectPipelineHealth) &&
        /upstream_budget_ledger/.test(sources.prospectPipelineHealth) &&
        /prospect_signals/.test(sources.prospectPipelineHealth) &&
        /prospects/.test(sources.prospectPipelineHealth),
      'pipeline health monitor is SELECT-only and reports queue, budget, prospect, and signal health'
    ),
    check(
      'classifier.runtime_hooks_available',
      /detectAndRecordProspectSignals/.test(sources.prospectIntelligence) &&
        /prospectSourceType/.test(sources.prospectIntelligence),
      'classifier exposes the shared source-to-signal runtime used by live and queued paths'
    ),
    check(
      'known_deal_materialization.explicit_go_required',
      /APPLY_REQUIRES_EXPLICIT_GO/.test(sources.materializeKnownDeals) &&
        /confirmProductionWrite/.test(sources.materializeKnownDeals),
      'known-deal materialization cannot apply from CLI without explicit production-write confirmation'
    ),
    check(
      'bridge_materialization.pipeline_ready',
      /PROSPECT_BRIDGE_MATERIALIZE_PRODUCTION_GO/.test(sources.bridgeMaterialize) &&
        /PROSPECT_BRIDGE_APPLY_REQUIRES_EXACT_CONFIRMATION/.test(sources.bridgeMaterialize) &&
        /create_company/.test(sources.bridgeMaterialize) &&
        /createProspectOriginCompany/.test(sources.bridgeMaterialize) &&
        /REMOTE_D1_READ_ONLY_VIOLATION/.test(sources.bridgeMaterialize) &&
        /prospect_signals s/.test(sources.bridgeMaterialize),
      'prospect bridge materialization is dry-run/read-only by default, supports create-company decisions, and shares prospect-origin company creation'
    ),
    check(
      'migration.readiness_script_available',
      /runProspectMigrationReadinessCheck/.test(sources.migrationReadinessCheck) &&
        /mkdtempSync/.test(sources.migrationReadinessCheck) &&
        /EXPECTED_INDEXES/.test(sources.migrationReadinessCheck),
      'migration readiness proof runs against throwaway SQLite databases and checks indexes/constraints'
    ),
    check(
      'migration.0114_prospect_tables',
      /CREATE TABLE IF NOT EXISTS prospects/.test(sources.migration0114) &&
        /CREATE TABLE IF NOT EXISTS prospect_signals/.test(sources.migration0114) &&
        /CREATE TABLE IF NOT EXISTS prospect_backfill_coverage/.test(sources.migration0114) &&
        /CREATE TABLE IF NOT EXISTS prospect_classifier_samples/.test(sources.migration0114),
      'prospect intelligence migration includes prospects, signals, coverage, and classifier audit tables'
    ),
    check(
      'migration.0114_rebuild_guard',
      /DROP TABLE IF EXISTS entity_field_state_new/.test(sources.migration0114),
      'prospect migration clears stale entity_field_state_new rebuild table before recreating it'
    ),
    check(
      'migration.0115_rebuild_guard',
      /DROP TABLE IF EXISTS progressive_backfill_jobs_new/.test(sources.migration0115) &&
        /CREATE INDEX IF NOT EXISTS idx_pbj_org_status/.test(sources.migration0115),
      'ingestion hardening rebuild migration clears stale temp table and recreates indexes idempotently'
    ),
    check(
      'migration.0116_known_deal_backlink_index',
      /CREATE UNIQUE INDEX IF NOT EXISTS uniq_prospects_org_deal_active/.test(sources.migration0116) &&
        /ON prospects\(org_id, deal_id\)/.test(sources.migration0116),
      'known-deal prospect backlinks enforce one live prospect per deal'
    )
  );

  checks.push({
    name: 'production_rollout.go_gate',
    status: 'warn',
    detail: 'Readiness check is read-only. Migration apply, materialization apply, backfills, deploys, and live production enablement still require Lucas GO.',
  });

  return {
    passed: checks.every(entry => entry.status !== 'fail'),
    checks,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [sources, summary, manifest] = await Promise.all([
    readDefaultSources(),
    args.summaryPath ? readJson(args.summaryPath) : Promise.resolve(null),
    args.manifestPath ? readJson(args.manifestPath) : Promise.resolve(null),
  ]);
  const result = evaluateProspectPipelineReadiness({ sources, summary, manifest });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

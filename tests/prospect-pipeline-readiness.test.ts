import { describe, expect, it } from 'vitest';
import { evaluateProspectPipelineReadiness, type ProspectPipelineReadinessSources } from '../scripts/prospect-pipeline-readiness';

function readySources(overrides: Partial<ProspectPipelineReadinessSources> = {}): ProspectPipelineReadinessSources {
  return {
    packageJson: JSON.stringify({
      scripts: {
        'prospect:classifier-gate': 'tsx scripts/prospect-classifier-gate.ts',
        'prospect:pipeline-readiness': 'tsx scripts/prospect-pipeline-readiness.ts',
        'prospect:pipeline-canary': 'tsx scripts/prospect-pipeline-canary.ts',
        'prospect:live-canary': 'tsx scripts/prospect-live-canary.ts',
        'prospect:backfill-window': 'tsx scripts/prospect-backfill-window.ts',
        'prospect:pipeline-health': 'tsx scripts/prospect-pipeline-health.ts',
        'prospect:migration-readiness': 'tsx scripts/prospect-migration-readiness-check.ts',
        'prospect:bridge-materialize': 'tsx scripts/prospect-bridge-materialize.ts',
      },
    }),
    workQueueDriver: "import { prospectDetectHandler } from './work-queue-handlers/prospect-detect';\nexport const WORK_QUEUE_HANDLERS = [prospectDetectHandler];",
    prospectDetectHandler: [
      'deadLetterWork(env, item.id, "bad")',
      'deferWork(env, item.id, next, item.payload)',
      '/CLAUDE_RATE_LIMITED|429|rate.?limit/',
      'idempotency_key: `${input.orgId}:${input.sourceType}:${input.sourceId}:prospect_detect:v1`',
      'prospect_detect_processed',
      'known_deals_attached',
      'record_context_skipped',
      'ignored_or_noise_skipped',
      'deferred_rate_limited',
      'upstream_budget_ledger',
      'prospectClassifierBudgetUpstreams',
      'classifier circuit open',
    ].join('\n'),
    prospectPipelineCanary: [
      'rows_written: 0',
      'changed_db: false',
      'read_mode: "wrangler_d1_remote_select"',
      'REMOTE_D1_READ_ONLY_VIOLATION',
      'remoteReadOnlyCanaryEnv',
      'classifyProspectSignalsDryRun',
      'CANARY_READ_ONLY_SQL_VIOLATION',
      'CANARY_CLASSIFICATION_INCOMPLETE',
      'hydration_status',
      'classification_status',
      'dry_run_counter_labels',
      'canary-decisions.jsonl',
      'No queue rows, prospects, prospect signals',
      'queue_payloads: sources.map(source => source)',
      'highSignalPredicateSql',
      'HIGH_SIGNAL_TERMS',
      'CANARY_HIGH_SIGNAL_EMPTY_DECISIONS',
      'allow-empty-decisions',
    ].join('\n'),
    prospectLiveCanary: [
      'PROSPECT_LIVE_CANARY_GO',
      'PROSPECT_LIVE_CANARY_REQUIRES_EXPLICIT_GO',
      'enqueueProspectDetectSource',
      'INVALID_LIMIT_MAX_10',
    ].join('\n'),
    prospectBackfillWindow: [
      'PROSPECT_BACKFILL_GO',
      'PROSPECT_BACKFILL_REQUIRES_EXPLICIT_GO',
      'PROSPECT_BACKFILL_WINDOW_TOO_LARGE',
      'PROSPECT_BACKFILL_BATCH_TOO_LARGE',
      'runProspectBackfillWindow',
    ].join('\n'),
    prospectPipelineHealth: [
      'read_only: true',
      'PIPELINE_HEALTH_READ_ONLY_VIOLATION',
      'work_queue',
      'upstream_budget_ledger',
      'prospect_signals',
      'prospects',
    ].join('\n'),
    prospectIntelligence: 'export async function detectAndRecordProspectSignals() {}\nfunction prospectSourceType() {}',
    materializeKnownDeals: 'confirmProductionWrite\nAPPLY_REQUIRES_EXPLICIT_GO',
    bridgeMaterialize: [
      'PROSPECT_BRIDGE_MATERIALIZE_PRODUCTION_GO',
      'PROSPECT_BRIDGE_APPLY_REQUIRES_EXACT_CONFIRMATION',
      'create_company',
      'createProspectOriginCompany',
      'REMOTE_D1_READ_ONLY_VIOLATION',
      'prospect_signals s',
    ].join('\n'),
    migrationReadinessCheck: [
      'export function runProspectMigrationReadinessCheck() {}',
      'mkdtempSync',
      'EXPECTED_INDEXES',
    ].join('\n'),
    migration0114: [
      'DROP TABLE IF EXISTS entity_field_state_new',
      'CREATE TABLE IF NOT EXISTS prospects',
      'CREATE TABLE IF NOT EXISTS prospect_signals',
      'CREATE TABLE IF NOT EXISTS prospect_backfill_coverage',
      'CREATE TABLE IF NOT EXISTS prospect_classifier_samples',
    ].join('\n'),
    migration0115: 'DROP TABLE IF EXISTS progressive_backfill_jobs_new;\nCREATE INDEX IF NOT EXISTS idx_pbj_org_status ON progressive_backfill_jobs(org_id, status);',
    migration0116: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_prospects_org_deal_active ON prospects(org_id, deal_id) WHERE deleted_at IS NULL;',
    ...overrides,
  };
}

const passingSummary = {
  exact_create_precision: 0.989,
  exact_attach_precision: 0.997,
  valuable_precision: 1,
  valuable_recall: 0.976,
  wrong_entity_corrected_or_suppressed: 6,
};

const readOnlyManifest = {
  rows_written: 0,
  changed_db: false,
};

describe('prospect pipeline readiness gate', () => {
  it('passes when classifier metrics, queue hooks, gates, and migrations are present', () => {
    const result = evaluateProspectPipelineReadiness({
      sources: readySources(),
      summary: passingSummary,
      manifest: readOnlyManifest,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.filter(check => check.status === 'fail')).toEqual([]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'classifier_gate.rows_written', status: 'pass' }),
      expect.objectContaining({ name: 'work_queue.prospect_detect_registered', status: 'pass' }),
      expect.objectContaining({ name: 'canary.remote_read_proof_available', status: 'pass' }),
      expect.objectContaining({ name: 'canary.high_signal_mode_available', status: 'pass' }),
      expect.objectContaining({ name: 'live_canary.explicit_go_required', status: 'pass' }),
      expect.objectContaining({ name: 'backfill_window.explicit_go_required', status: 'pass' }),
      expect.objectContaining({ name: 'pipeline_health.read_only_monitor', status: 'pass' }),
      expect.objectContaining({ name: 'known_deal_materialization.explicit_go_required', status: 'pass' }),
      expect.objectContaining({ name: 'bridge_materialization.pipeline_ready', status: 'pass' }),
      expect.objectContaining({ name: 'migration.readiness_script_available', status: 'pass' }),
      expect.objectContaining({ name: 'migration.0114_rebuild_guard', status: 'pass' }),
      expect.objectContaining({ name: 'production_rollout.go_gate', status: 'warn' }),
    ]));
  });

  it('fails closed when the replay benchmark drops below acceptance thresholds', () => {
    const result = evaluateProspectPipelineReadiness({
      sources: readySources(),
      summary: { ...passingSummary, exact_create_precision: 0.91 },
      manifest: readOnlyManifest,
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'classifier_gate.exact_create_precision', status: 'fail' }),
    ]));
  });

  it('warns rather than pretending rollout is approved when no replay summary is supplied', () => {
    const result = evaluateProspectPipelineReadiness({ sources: readySources() });

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'classifier_gate.available', status: 'warn' }),
      expect.objectContaining({ name: 'production_rollout.go_gate', status: 'warn' }),
    ]));
  });
});

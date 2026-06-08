#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

type CheckStatus = 'pass' | 'fail';

export interface ProspectMigrationReadinessCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ProspectMigrationReadinessResult {
  passed: boolean;
  checks: ProspectMigrationReadinessCheck[];
}

const MIGRATION_PATHS = [
  'migrations/0114_prospect_intelligence.sql',
  'migrations/0115_ingestion_evidence_hardening.sql',
  'migrations/0116_prospect_deal_backlinks.sql',
  'migrations/0117_prospect_signal_company_bridge.sql',
] as const;

const EXPECTED_INDEXES = [
  'idx_prospects_org_normalized_active',
  'idx_prospects_org_seen',
  'idx_prospects_org_sector',
  'idx_prospects_strength',
  'idx_prospects_deal',
  'idx_prospects_duplicate',
  'idx_prospect_signals_prospect',
  'idx_prospect_signals_deal',
  'idx_prospect_signals_source',
  'idx_prospect_signals_type',
  'idx_prospect_signals_pending',
  'idx_prospect_signals_company',
  'idx_prospects_company',
  'idx_prospects_possible_company',
  'idx_pbj_org_status',
  'idx_pbj_user',
  'idx_entity_field_state_unique',
  'idx_efs_entity',
  'idx_efs_pending',
  'idx_efs_pending_deletions',
  'uniq_prospects_org_deal_active',
] as const;

const EXPECTED_QUERY_PLAN_INDEXES = [
  'idx_prospects_org_normalized_active',
  'idx_prospects_deal',
  'idx_prospect_signals_source',
  'idx_prospect_signals_type',
  'idx_prospect_signals_company',
  'idx_pbj_org_status',
] as const;

function pass(name: string, detail: string): ProspectMigrationReadinessCheck {
  return { name, status: 'pass', detail };
}

function fail(name: string, detail: string): ProspectMigrationReadinessCheck {
  return { name, status: 'fail', detail };
}

function runSql(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
}

function runSqlAllowFailure(dbPath: string, sql: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: runSql(dbPath, sql) };
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      output: String(e.stderr || e.stdout || e.message || error),
    };
  }
}

function scalar(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-noheader', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function queryLines(dbPath: string, sql: string): string[] {
  const out = execFileSync('sqlite3', ['-noheader', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
  return out ? out.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

function columnExists(dbPath: string, table: string, column: string): boolean {
  return queryLines(dbPath, `PRAGMA table_info(${table});`)
    .some(line => line.split('|')[1] === column);
}

function bootstrapSql(input: { seeded?: boolean; staleEntityFieldStateNew?: boolean; staleProgressiveBackfillJobsNew?: boolean }): string {
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE contacts (id TEXT PRIMARY KEY, org_id TEXT, deleted_at TEXT, full_name TEXT);
CREATE TABLE companies (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, deleted_at TEXT);
CREATE TABLE deals (id TEXT PRIMARY KEY, org_id TEXT, company_id TEXT, title TEXT, stage TEXT, deleted_at TEXT, created_at TEXT);
CREATE TABLE entity_field_state (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company','deal')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  current_value TEXT,
  current_value_sources TEXT NOT NULL DEFAULT '[]',
  pending_proposals TEXT NOT NULL DEFAULT '{}',
  rejected_values TEXT NOT NULL DEFAULT '{}',
  last_human_edit_at TEXT,
  permanently_locked INTEGER NOT NULL DEFAULT 0 CHECK(permanently_locked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pending_deletions TEXT NOT NULL DEFAULT '[]',
  last_human_edit_user_id TEXT
);
CREATE TABLE progressive_backfill_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  window_size_days INTEGER NOT NULL DEFAULT 10,
  total_windows INTEGER NOT NULL DEFAULT 18,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
${input.staleEntityFieldStateNew ? 'CREATE TABLE entity_field_state_new (stale TEXT);' : ''}
${input.staleProgressiveBackfillJobsNew ? 'CREATE TABLE progressive_backfill_jobs_new (stale TEXT);' : ''}
${input.seeded ? `
INSERT INTO organizations(id, name) VALUES ('org-1', 'Org 1');
INSERT INTO contacts(id, org_id, full_name) VALUES ('contact-1', 'org-1', 'Alice');
INSERT INTO companies(id, org_id, name) VALUES ('company-1', 'org-1', 'Acme');
INSERT INTO deals(id, org_id, company_id, title, stage, created_at)
VALUES ('deal-1', 'org-1', 'company-1', 'Acme Seed', 'talking', '2026-06-01T00:00:00.000Z');
INSERT INTO entity_field_state(id, entity_type, entity_id, field_name, current_value)
VALUES ('efs-1', 'company', 'company-1', 'name', 'Acme'),
       ('efs-2', 'deal', 'deal-1', 'stage', 'talking');
INSERT INTO progressive_backfill_jobs(id, org_id, user_id, status)
VALUES ('pbj-1', 'org-1', 'user-1', 'active'),
       ('pbj-2', 'org-1', 'user-1', 'completed');
` : ''}
`;
}

function applyMigrations(dbPath: string): void {
  for (const path of MIGRATION_PATHS) {
    if (path.endsWith('0117_prospect_signal_company_bridge.sql')) {
      applyProspectBridgeMigration(dbPath);
      continue;
    }
    runSql(dbPath, readFileSync(path, 'utf8'));
  }
}

function applyProspectBridgeMigration(dbPath: string): void {
  const hasCompanyId = columnExists(dbPath, 'prospect_signals', 'company_id');
  const migration = readFileSync('migrations/0117_prospect_signal_company_bridge.sql', 'utf8');
  const statements = migration
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
    .filter(statement => hasCompanyId
      ? !/ALTER\s+TABLE\s+prospect_signals\s+ADD\s+COLUMN\s+company_id/i.test(statement)
      : true);
  for (const statement of statements) runSql(dbPath, `${statement};`);
}

function makeTempDb(prefix: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, dbPath: join(dir, 'readiness.sqlite') };
}

function withTempDb(prefix: string, fn: (dbPath: string) => ProspectMigrationReadinessCheck[]): ProspectMigrationReadinessCheck[] {
  const { dir, dbPath } = makeTempDb(prefix);
  try {
    return fn(dbPath);
  } catch (error) {
    return [fail(prefix, error instanceof Error ? error.message : String(error))];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertScalar(
  dbPath: string,
  name: string,
  sql: string,
  expected: string
): ProspectMigrationReadinessCheck {
  const actual = scalar(dbPath, sql);
  return actual === expected
    ? pass(name, `actual=${actual}`)
    : fail(name, `actual=${actual} expected=${expected}`);
}

function insertProspectAndSignalSql(): string {
  return `
INSERT INTO prospects(id, org_id, canonical_name, normalized_name, deal_id, sector_key)
VALUES ('prospect-1', 'org-1', 'Acme', 'acme', 'deal-1', 'uncategorized');
INSERT INTO prospect_signals(id, org_id, prospect_id, source_type, source_id, mention_ordinal, raw_mention_text, normalized_mention, occurred_at, classifier_version, sector_key)
VALUES ('signal-1', 'org-1', 'prospect-1', 'conversation', 'conv-1', 0, 'Acme', 'acme', '2026-06-01T00:00:00.000Z', 'test', 'uncategorized');
`;
}

function emptyScenario(): ProspectMigrationReadinessCheck[] {
  return withTempDb('prospect-migration-empty', dbPath => {
    runSql(dbPath, bootstrapSql({ seeded: false }));
    applyMigrations(dbPath);
    applyMigrations(dbPath);
    return [
      assertScalar(dbPath, 'empty.sectors_seeded', 'SELECT COUNT(*) FROM prospect_sectors;', '18'),
      assertScalar(dbPath, 'empty.prospects_empty', 'SELECT COUNT(*) FROM prospects;', '0'),
      assertScalar(dbPath, 'empty.progressive_jobs_empty', 'SELECT COUNT(*) FROM progressive_backfill_jobs;', '0'),
      assertScalar(dbPath, 'empty.prospect_signals_exists', "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='prospect_signals';", '1'),
      assertScalar(dbPath, 'empty.prospect_signals_company_id_exists', "SELECT COUNT(*) FROM pragma_table_info('prospect_signals') WHERE name='company_id';", '1'),
    ];
  });
}

function seededScenario(): ProspectMigrationReadinessCheck[] {
  return withTempDb('prospect-migration-seeded', dbPath => {
    runSql(dbPath, bootstrapSql({ seeded: true }));
    applyMigrations(dbPath);
    runSql(dbPath, insertProspectAndSignalSql());
    applyMigrations(dbPath);
    const checks = [
      assertScalar(dbPath, 'seeded.prospect_rows_survive_repeat_apply', 'SELECT COUNT(*) FROM prospects;', '1'),
      assertScalar(dbPath, 'seeded.signal_rows_survive_repeat_apply', 'SELECT COUNT(*) FROM prospect_signals;', '1'),
      assertScalar(dbPath, 'seeded.signal_company_id_column_survives_repeat_apply', "SELECT COUNT(*) FROM pragma_table_info('prospect_signals') WHERE name='company_id';", '1'),
      assertScalar(dbPath, 'seeded.entity_field_state_rows_survive_repeat_apply', 'SELECT COUNT(*) FROM entity_field_state;', '2'),
      assertScalar(dbPath, 'seeded.progressive_jobs_survive_repeat_apply', 'SELECT COUNT(*) FROM progressive_backfill_jobs;', '2'),
    ];
    runSql(dbPath, "INSERT INTO progressive_backfill_jobs(id, org_id, user_id, status) VALUES ('pbj-failed', 'org-1', 'user-1', 'failed');");
    checks.push(
      assertScalar(dbPath, 'seeded.failed_status_allowed_after_0115', "SELECT COUNT(*) FROM progressive_backfill_jobs WHERE status='failed';", '1'),
    );
    return checks;
  });
}

function staleTempScenario(): ProspectMigrationReadinessCheck[] {
  return withTempDb('prospect-migration-stale-temp', dbPath => {
    runSql(dbPath, bootstrapSql({
      seeded: true,
      staleEntityFieldStateNew: true,
      staleProgressiveBackfillJobsNew: true,
    }));
    applyMigrations(dbPath);
    applyMigrations(dbPath);
    return [
      assertScalar(dbPath, 'stale_temp.entity_field_state_survives', 'SELECT COUNT(*) FROM entity_field_state;', '2'),
      assertScalar(dbPath, 'stale_temp.progressive_jobs_survive', 'SELECT COUNT(*) FROM progressive_backfill_jobs;', '2'),
      assertScalar(dbPath, 'stale_temp.no_entity_field_state_new_leftover', "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entity_field_state_new';", '0'),
      assertScalar(dbPath, 'stale_temp.no_progressive_jobs_new_leftover', "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='progressive_backfill_jobs_new';", '0'),
    ];
  });
}

function indexAndConstraintScenario(): ProspectMigrationReadinessCheck[] {
  return withTempDb('prospect-migration-indexes', dbPath => {
    runSql(dbPath, bootstrapSql({ seeded: true }));
    applyMigrations(dbPath);
    runSql(dbPath, insertProspectAndSignalSql());

    const checks: ProspectMigrationReadinessCheck[] = [];
    const indexes = new Set(queryLines(dbPath, "SELECT name FROM sqlite_master WHERE type='index';"));
    const missing = EXPECTED_INDEXES.filter(name => !indexes.has(name));
    checks.push(missing.length === 0
      ? pass('indexes.expected_indexes_present', `count=${EXPECTED_INDEXES.length}`)
      : fail('indexes.expected_indexes_present', `missing=${missing.join(',')}`));

    const planChecks: Array<{ name: typeof EXPECTED_QUERY_PLAN_INDEXES[number]; sql: string }> = [
      {
        name: 'idx_prospects_org_normalized_active',
        sql: "EXPLAIN QUERY PLAN SELECT * FROM prospects WHERE org_id='org-1' AND normalized_name='acme' AND deleted_at IS NULL;",
      },
      {
        name: 'idx_prospects_deal',
        sql: "EXPLAIN QUERY PLAN SELECT * FROM prospects WHERE org_id='org-1' AND deal_id='deal-1';",
      },
      {
        name: 'idx_prospect_signals_source',
        sql: "EXPLAIN QUERY PLAN SELECT * FROM prospect_signals WHERE org_id='org-1' AND source_type='conversation' AND source_id='conv-1';",
      },
      {
        name: 'idx_prospect_signals_type',
        sql: "EXPLAIN QUERY PLAN SELECT * FROM prospect_signals WHERE org_id='org-1' AND mention_type='inbound_prospect' ORDER BY occurred_at DESC;",
      },
      {
        name: 'idx_prospect_signals_company',
        sql: "EXPLAIN QUERY PLAN SELECT * FROM prospect_signals WHERE org_id='org-1' AND company_id='company-1' ORDER BY occurred_at DESC;",
      },
      {
        name: 'idx_pbj_org_status',
        sql: "EXPLAIN QUERY PLAN SELECT * FROM progressive_backfill_jobs WHERE org_id='org-1' AND status='active';",
      },
    ];
    for (const plan of planChecks) {
      const out = queryLines(dbPath, plan.sql).join('\n');
      checks.push(out.includes(plan.name)
        ? pass(`query_plan.${plan.name}`, out)
        : fail(`query_plan.${plan.name}`, out));
    }

    const duplicateNormalized = runSqlAllowFailure(
      dbPath,
      "INSERT INTO prospects(id, org_id, canonical_name, normalized_name, sector_key) VALUES ('prospect-dup-name','org-1','Acme Again','acme','uncategorized');"
    );
    checks.push(!duplicateNormalized.ok
      ? pass('constraints.duplicate_live_normalized_rejected', duplicateNormalized.output.trim().slice(0, 200))
      : fail('constraints.duplicate_live_normalized_rejected', 'insert unexpectedly succeeded'));

    const duplicateDeal = runSqlAllowFailure(
      dbPath,
      "INSERT INTO prospects(id, org_id, canonical_name, normalized_name, sector_key, deal_id) VALUES ('prospect-dup-deal','org-1','Acme Deal','acme-deal','uncategorized','deal-1');"
    );
    checks.push(!duplicateDeal.ok
      ? pass('constraints.duplicate_live_deal_backlink_rejected', duplicateDeal.output.trim().slice(0, 200))
      : fail('constraints.duplicate_live_deal_backlink_rejected', 'insert unexpectedly succeeded'));

    const duplicateSignal = runSqlAllowFailure(
      dbPath,
      "INSERT INTO prospect_signals(id, org_id, prospect_id, source_type, source_id, mention_ordinal, raw_mention_text, normalized_mention, occurred_at, classifier_version, sector_key) VALUES ('signal-dup','org-1','prospect-1','conversation','conv-1',0,'Acme','acme','2026-06-01T00:00:00.000Z','test','uncategorized');"
    );
    checks.push(!duplicateSignal.ok
      ? pass('constraints.duplicate_source_mention_signal_rejected', duplicateSignal.output.trim().slice(0, 200))
      : fail('constraints.duplicate_source_mention_signal_rejected', 'insert unexpectedly succeeded'));

    const softDeletedDeal = runSqlAllowFailure(
      dbPath,
      "INSERT INTO prospects(id, org_id, canonical_name, normalized_name, sector_key, deal_id, deleted_at) VALUES ('prospect-deleted','org-1','Acme deleted','acme-deleted','uncategorized','deal-1','2026-06-01T00:00:00.000Z');"
    );
    checks.push(softDeletedDeal.ok
      ? pass('constraints.soft_deleted_duplicate_deal_backlink_allowed', 'insert succeeded')
      : fail('constraints.soft_deleted_duplicate_deal_backlink_allowed', softDeletedDeal.output.trim().slice(0, 200)));

    return checks;
  });
}

function sqliteAvailableCheck(): ProspectMigrationReadinessCheck {
  try {
    const version = execFileSync('sqlite3', ['--version'], { encoding: 'utf8' }).trim();
    return pass('sqlite.available', version);
  } catch (error) {
    return fail('sqlite.available', error instanceof Error ? error.message : String(error));
  }
}

export function runProspectMigrationReadinessCheck(): ProspectMigrationReadinessResult {
  const checks = [
    sqliteAvailableCheck(),
    ...emptyScenario(),
    ...seededScenario(),
    ...staleTempScenario(),
    ...indexAndConstraintScenario(),
  ];
  return {
    passed: checks.every(check => check.status === 'pass'),
    checks,
  };
}

async function main(): Promise<void> {
  const result = runProspectMigrationReadinessCheck();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

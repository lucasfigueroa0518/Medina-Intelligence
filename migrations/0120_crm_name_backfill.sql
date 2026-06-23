-- CRM name resolver production backfill.
--
-- Stores durable run/result state for a production-safe contact/company name
-- backfill. Execution is through work_queue domain='crm_name_backfill_shard';
-- dry-run rows write only these tables, while apply mode is additionally
-- guarded by env.CRM_NAME_BACKFILL_APPLY_ENABLED.

CREATE TABLE IF NOT EXISTS crm_name_backfill_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','cancelled','failed')),
  mode TEXT NOT NULL DEFAULT 'dry_run'
    CHECK(mode IN ('dry_run','apply')),
  shard_count INTEGER NOT NULL DEFAULT 24,
  requested_by TEXT,
  started_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  last_error TEXT,

  scanned_count INTEGER NOT NULL DEFAULT 0,
  no_op_count INTEGER NOT NULL DEFAULT 0,
  renamed_count INTEGER NOT NULL DEFAULT 0,
  status_only_count INTEGER NOT NULL DEFAULT 0,
  provisional_count INTEGER NOT NULL DEFAULT 0,
  domain_placeholder_count INTEGER NOT NULL DEFAULT 0,
  pending_proposal_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,

  local_only_rows INTEGER NOT NULL DEFAULT 0,
  network_rows INTEGER NOT NULL DEFAULT 0,
  provider_rows INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  estimated_llm_calls INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_name_backfill_runs_org_status
  ON crm_name_backfill_runs(org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_name_backfill_results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')),
  entity_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  shard_count INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('dry_run','apply')),

  before_name TEXT,
  before_status TEXT,
  proposed_name TEXT,
  proposed_status TEXT,
  action TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
  confidence TEXT,
  evidence_summary TEXT,
  rule_ids TEXT NOT NULL DEFAULT '[]',
  risk_flags TEXT NOT NULL DEFAULT '[]',
  cost_tier INTEGER NOT NULL DEFAULT 0,
  network_calls INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  error TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (run_id) REFERENCES crm_name_backfill_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_name_backfill_results_unique
  ON crm_name_backfill_results(run_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_crm_name_backfill_results_run_action
  ON crm_name_backfill_results(run_id, action);

CREATE INDEX IF NOT EXISTS idx_crm_name_backfill_results_entity
  ON crm_name_backfill_results(entity_type, entity_id);

-- Reviewed CRM name apply + entity cleanup rollout.
--
-- This migration is additive. It lets production apply use a reviewed dry-run
-- result set plus explicit overrides, and stores the reviewed merge/delete
-- cleanup plan separately from the name resolver/backfill audit tables.

ALTER TABLE crm_name_backfill_runs ADD COLUMN apply_strategy TEXT NOT NULL DEFAULT 'resolver'
  CHECK(apply_strategy IN ('resolver','reviewed_results'));

ALTER TABLE crm_name_backfill_runs ADD COLUMN source_run_id TEXT;

CREATE TABLE IF NOT EXISTS crm_name_backfill_review_overrides (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')),
  entity_id TEXT NOT NULL,
  corrected_action TEXT NOT NULL,
  corrected_name TEXT,
  corrected_status TEXT CHECK(corrected_status IN ('verified','provisional','domain_placeholder') OR corrected_status IS NULL),
  corrected_confidence TEXT CHECK(corrected_confidence IN ('high','medium','low') OR corrected_confidence IS NULL),
  rationale TEXT,
  source_artifact TEXT,
  apply_ready INTEGER NOT NULL DEFAULT 0 CHECK(apply_ready IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_name_review_overrides_unique
  ON crm_name_backfill_review_overrides(org_id, source_run_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_crm_name_review_overrides_source
  ON crm_name_backfill_review_overrides(org_id, source_run_id, apply_ready);

CREATE TABLE IF NOT EXISTS crm_entity_cleanup_plan (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  source_artifact TEXT NOT NULL,
  source_row_number INTEGER,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')),
  entity_id TEXT NOT NULL,
  current_name TEXT,
  cleanup_action TEXT NOT NULL CHECK(cleanup_action IN ('merge','delete')),
  merge_target_id TEXT,
  delete_reason TEXT,
  confidence TEXT CHECK(confidence IN ('high','medium','low') OR confidence IS NULL),
  approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
  apply_policy TEXT NOT NULL DEFAULT 'pending_review'
    CHECK(apply_policy IN ('apply','pending_review')),
  evidence TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_entity_cleanup_plan_unique
  ON crm_entity_cleanup_plan(org_id, entity_type, entity_id, cleanup_action);

CREATE INDEX IF NOT EXISTS idx_crm_entity_cleanup_plan_apply
  ON crm_entity_cleanup_plan(org_id, cleanup_action, apply_policy, approved);

CREATE TABLE IF NOT EXISTS crm_entity_cleanup_results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company')),
  entity_id TEXT NOT NULL,
  cleanup_action TEXT NOT NULL,
  result_action TEXT NOT NULL CHECK(result_action IN (
    'merge_applied',
    'merge_blocked',
    'soft_delete_applied',
    'delete_pending_review',
    'skip_missing',
    'skip_already_merged_or_deleted',
    'error'
  )),
  merge_target_id TEXT,
  before_name TEXT,
  after_name TEXT,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
  details TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES crm_entity_cleanup_plan(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_entity_cleanup_results_unique
  ON crm_entity_cleanup_results(org_id, plan_id);

CREATE INDEX IF NOT EXISTS idx_crm_entity_cleanup_results_action
  ON crm_entity_cleanup_results(org_id, result_action);

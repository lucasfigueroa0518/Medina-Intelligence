-- MAX mode set-builder telemetry.
--
-- These tables are intentionally diagnostic-only. They let us inspect broad
-- MAX roster/list runs that returned too few candidates without persisting the
-- private source bodies themselves.

CREATE TABLE IF NOT EXISTS max_mode_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  task_type TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  source_families TEXT NOT NULL DEFAULT '[]',
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  probable_count INTEGER NOT NULL DEFAULT 0,
  needs_review_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  deduped_count INTEGER NOT NULL DEFAULT 0,
  caps_hit TEXT NOT NULL DEFAULT '[]',
  artifact_document_id TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_max_mode_runs_org_created
  ON max_mode_runs (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS max_mode_run_sources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES max_mode_runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_family TEXT NOT NULL,
  rows_scanned INTEGER NOT NULL DEFAULT 0,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  candidates_added INTEGER NOT NULL DEFAULT 0,
  body_fetches INTEGER NOT NULL DEFAULT 0,
  documents_extracted INTEGER NOT NULL DEFAULT 0,
  cap_hit INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_max_mode_run_sources_run
  ON max_mode_run_sources (run_id, source_family);

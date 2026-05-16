-- MAX mode quality gate telemetry and anchor tracking.
--
-- These columns make broad MAX jobs debuggable without storing private source
-- bodies. They record the compiled plan, safety status, and source-role counts
-- that explain why an artifact was or was not safe to create.

ALTER TABLE max_mode_runs ADD COLUMN safety_status TEXT;
ALTER TABLE max_mode_runs ADD COLUMN quality_gate_passed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE max_mode_runs ADD COLUMN artifact_suppressed_reason TEXT;
ALTER TABLE max_mode_runs ADD COLUMN plan_json TEXT;
ALTER TABLE max_mode_runs ADD COLUMN anchor_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE max_mode_runs ADD COLUMN authoritative_candidate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE max_mode_runs ADD COLUMN supporting_candidate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE max_mode_runs ADD COLUMN enrichment_candidate_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS max_mode_run_anchors (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES max_mode_runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  anchor_type TEXT NOT NULL,
  source_family TEXT NOT NULL,
  source_id TEXT,
  label TEXT NOT NULL,
  confidence TEXT NOT NULL,
  why TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_max_mode_run_anchors_run
  ON max_mode_run_anchors (run_id, anchor_type);

-- Async MAX job scaffolding. The current runtime still executes small/medium
-- set builds synchronously, but these tables reserve the durable job shape for
-- long-running paginated sweeps.
CREATE TABLE IF NOT EXISTS max_mode_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES max_mode_runs(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  task_type TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  plan_json TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  artifact_document_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_max_mode_jobs_org_created
  ON max_mode_jobs (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS max_mode_job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES max_mode_jobs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_family TEXT,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  rows_scanned INTEGER NOT NULL DEFAULT 0,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  candidates_added INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_max_mode_job_steps_job
  ON max_mode_job_steps (job_id, step_name);

-- MARTy Lab baseline-relative optimization persistence.

CREATE TABLE IF NOT EXISTS marty_lab_artifact_reviews (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  required INTEGER NOT NULL DEFAULT 0,
  baseline_document_id TEXT,
  candidate_document_id TEXT,
  baseline_metrics_json TEXT NOT NULL DEFAULT '{}',
  candidate_metrics_json TEXT NOT NULL DEFAULT '{}',
  comparison_json TEXT NOT NULL DEFAULT '{}',
  preview_refs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_artifact_reviews_run
  ON marty_lab_artifact_reviews (org_id, run_id, experiment_id);

CREATE TABLE IF NOT EXISTS marty_lab_deep_work_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  cluster_key TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL,
  failure_type TEXT NOT NULL,
  lever_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  UNIQUE (org_id, run_id, cluster_key, status)
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_deep_work_items_run
  ON marty_lab_deep_work_items (org_id, run_id, status, updated_at);

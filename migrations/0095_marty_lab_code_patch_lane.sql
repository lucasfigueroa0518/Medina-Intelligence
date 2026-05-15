-- MARTy Lab isolated code-patch lane.
-- Deep Work items can request a real engineering patch, but the job remains
-- sandbox metadata until a human/Codex worktree produces and reviews code.

CREATE TABLE IF NOT EXISTS marty_lab_code_patch_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  deep_work_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT NOT NULL,
  priority TEXT NOT NULL,
  failure_type TEXT NOT NULL,
  model TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  patch_scope_json TEXT NOT NULL DEFAULT '{}',
  validation_plan_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_code_patch_jobs_run
  ON marty_lab_code_patch_jobs (org_id, run_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_marty_lab_code_patch_jobs_deep_work
  ON marty_lab_code_patch_jobs (org_id, deep_work_item_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marty_lab_code_patch_one_active_deep_work
  ON marty_lab_code_patch_jobs (org_id, deep_work_item_id)
  WHERE deep_work_item_id IS NOT NULL
    AND status IN ('queued', 'planning', 'ready_for_agent', 'in_agent_worktree', 'ready_for_review');

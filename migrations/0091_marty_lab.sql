-- MARTy Human Conversation Lab
-- Sandbox-only evaluation cockpit for goal-driven conversation experiments.

CREATE TABLE IF NOT EXISTS marty_lab_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'running', 'completed', 'cancelled', 'failed')),
  suite_name TEXT NOT NULL DEFAULT 'human_conversation_suite',
  baseline_label TEXT NOT NULL DEFAULT 'current_sandbox',
  candidate_label TEXT NOT NULL DEFAULT 'candidate_sandbox',
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  total_experiments INTEGER NOT NULL DEFAULT 0,
  completed_experiments INTEGER NOT NULL DEFAULT 0,
  average_baseline_score REAL,
  average_candidate_score REAL,
  winning_candidate_count INTEGER NOT NULL DEFAULT 0,
  privacy_failures INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  recent_events_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_runs_org_status_created
  ON marty_lab_runs(org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS marty_lab_experiments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL REFERENCES marty_lab_runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'graded', 'blocked', 'failed', 'cancelled')),
  persona_json TEXT NOT NULL,
  goal TEXT NOT NULL,
  starting_prompt TEXT NOT NULL,
  followup_policy_json TEXT NOT NULL DEFAULT '{}',
  rubric_json TEXT NOT NULL,
  baseline_transcript_json TEXT NOT NULL DEFAULT '[]',
  candidate_transcript_json TEXT NOT NULL DEFAULT '[]',
  tool_trace_json TEXT NOT NULL DEFAULT '{}',
  sources_json TEXT NOT NULL DEFAULT '{}',
  friction_json TEXT NOT NULL DEFAULT '[]',
  findings_json TEXT NOT NULL DEFAULT '[]',
  baseline_score REAL,
  candidate_score REAL,
  recommendation TEXT,
  privacy_failure INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_experiments_run_status
  ON marty_lab_experiments(run_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_marty_lab_experiments_org_created
  ON marty_lab_experiments(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marty_lab_upgrade_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES marty_lab_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'hypothesis' CHECK (status IN ('hypothesis', 'sandbox_applied', 'validated', 'rejected')),
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  change_summary TEXT,
  expected_benefit TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_upgrade_org_status
  ON marty_lab_upgrade_candidates(org_id, status, created_at DESC);

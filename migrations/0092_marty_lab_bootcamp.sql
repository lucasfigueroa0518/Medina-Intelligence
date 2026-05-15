-- MARTy Bootcamp progressive sandbox state.

ALTER TABLE marty_lab_runs ADD COLUMN baseline_version_id TEXT;
ALTER TABLE marty_lab_runs ADD COLUMN candidate_version_id TEXT;
ALTER TABLE marty_lab_runs ADD COLUMN upgrade_title TEXT;
ALTER TABLE marty_lab_runs ADD COLUMN upgrade_variable_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE marty_lab_runs ADD COLUMN bootcamp_phase TEXT NOT NULL DEFAULT 'suite';
ALTER TABLE marty_lab_runs ADD COLUMN discarded_at TEXT;
ALTER TABLE marty_lab_runs ADD COLUMN discard_reason TEXT;

ALTER TABLE marty_lab_experiments ADD COLUMN priority TEXT NOT NULL DEFAULT 'context_retrieval';
ALTER TABLE marty_lab_experiments ADD COLUMN replicate_group TEXT;
ALTER TABLE marty_lab_experiments ADD COLUMN variable_under_test TEXT;

CREATE TABLE IF NOT EXISTS marty_lab_versions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('accepted','candidate','rejected','archived')),
  label TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  parent_version_id TEXT,
  prompt_addendum TEXT NOT NULL DEFAULT '',
  applied_upgrades_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  source_run_id TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_versions_org_status_generation
  ON marty_lab_versions(org_id, status, generation DESC);

CREATE INDEX IF NOT EXISTS idx_marty_lab_versions_org_created
  ON marty_lab_versions(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marty_lab_upgrade_trials (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES marty_lab_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','inconclusive')),
  baseline_version_id TEXT,
  candidate_version_id TEXT,
  upgrade_key TEXT NOT NULL,
  title TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  valid_sample_size INTEGER NOT NULL DEFAULT 0,
  average_delta REAL,
  target_average_delta REAL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  ties INTEGER NOT NULL DEFAULT 0,
  privacy_failures INTEGER NOT NULL DEFAULT 0,
  severe_regressions INTEGER NOT NULL DEFAULT 0,
  conclusion TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_marty_lab_trials_org_created
  ON marty_lab_upgrade_trials(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marty_lab_trials_run
  ON marty_lab_upgrade_trials(org_id, run_id);

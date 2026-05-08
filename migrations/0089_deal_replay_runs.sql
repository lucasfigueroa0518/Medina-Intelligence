-- Safe six-week deal replay.
--
-- Tracks destructive hard-reset + conservative replay runs that repopulate
-- deals from existing internal evidence. The actual per-source work runs
-- through work_queue(domain='deal_replay_evidence') so Claude usage can be
-- paced and rate-limit deferrals are visible.

CREATE TABLE IF NOT EXISTS deal_replay_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','cancelled','failed')),

  days_back INTEGER NOT NULL DEFAULT 42,
  cutoff_at TEXT NOT NULL,
  reset_mode TEXT NOT NULL DEFAULT 'hard_delete'
    CHECK(reset_mode IN ('hard_delete')),
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL,

  enqueued_count INTEGER NOT NULL DEFAULT 0,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  evidence_recorded_count INTEGER NOT NULL DEFAULT 0,
  promoted_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,

  skip_reasons TEXT NOT NULL DEFAULT '{}',
  promoted_companies TEXT NOT NULL DEFAULT '[]',
  recent_evidence TEXT NOT NULL DEFAULT '[]',
  recent_errors TEXT NOT NULL DEFAULT '[]',
  last_event TEXT,

  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deal_replay_runs_org_created
  ON deal_replay_runs(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_replay_runs_org_status
  ON deal_replay_runs(org_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_deal_replay_active_org
  ON deal_replay_runs(org_id)
  WHERE status = 'running';

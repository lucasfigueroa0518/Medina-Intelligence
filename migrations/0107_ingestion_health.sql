-- Self-healing ingestion health.
--
-- Ingestion must never silently skip active sources. These tables make source
-- health and repair state durable so cron, UI, and MARTy all read the same
-- truth instead of scraping logs or KV counters.

CREATE TABLE IF NOT EXISTS ingestion_source_state (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'org',
  scope_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (status IN ('healthy','degraded','blocked','recovering')),
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info','warning','critical')),
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error TEXT,
  human_action_required INTEGER NOT NULL DEFAULT 0,
  recovery_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (recovery_status IN ('idle','repair_queued','repairing','blocked_on_auth')),
  recovery_window_start TEXT,
  recovery_window_end TEXT,
  recovery_enqueued_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, source, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_source_state_org_status
  ON ingestion_source_state(org_id, status, severity);

CREATE TABLE IF NOT EXISTS ingestion_incidents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'org',
  scope_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','recovering','blocked','resolved')),
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('warning','critical')),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  last_success_at TEXT,
  human_action_required INTEGER NOT NULL DEFAULT 0,
  recovery_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (recovery_status IN ('idle','repair_queued','repairing','blocked_on_auth')),
  recovery_window_start TEXT,
  recovery_window_end TEXT,
  repair_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_repair_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_incidents_active_unique
  ON ingestion_incidents(org_id, source, scope_type, scope_id, code)
  WHERE status IN ('open','recovering','blocked');

CREATE INDEX IF NOT EXISTS idx_ingestion_incidents_org_status
  ON ingestion_incidents(org_id, status, severity, last_seen_at);

CREATE TABLE IF NOT EXISTS ingestion_locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

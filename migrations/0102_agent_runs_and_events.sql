-- Durable MARTy run/event lifecycle.
--
-- A visible assistant message remains the transcript record. agent_runs is the
-- operational lifecycle record used for cancellation, resume, telemetry, and
-- stale-run repair across Agile and MAX.

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  assistant_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'agile',
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at TEXT,
  cancel_requested_at TEXT,
  cancelled_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created
  ON agent_runs (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_request
  ON agent_runs (request_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_running
  ON agent_runs (org_id, status, heartbeat_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_seq
  ON agent_run_events (run_id, seq);

ALTER TABLE max_mode_jobs ADD COLUMN session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE max_mode_jobs ADD COLUMN assistant_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL;
ALTER TABLE max_mode_jobs ADD COLUMN request_id TEXT;
ALTER TABLE max_mode_jobs ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE max_mode_jobs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE max_mode_jobs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE max_mode_jobs ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_max_mode_jobs_agent_run
  ON max_mode_jobs (agent_run_id);


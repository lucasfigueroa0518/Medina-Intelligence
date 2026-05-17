-- Durable deck production jobs.
--
-- Deck generation is moving from direct PPTX emission to an HTML-first,
-- QA-gated artifact bundle. These tables give the render/export system a
-- durable lifecycle that can later be picked up by the work_queue / Node
-- Playwright render worker without changing the user-facing Documents model.

CREATE TABLE IF NOT EXISTS deck_artifact_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  request_id TEXT,
  assistant_message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'planning',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  audience TEXT,
  objective TEXT,
  style_pack TEXT NOT NULL DEFAULT 'medina_default',
  quality_mode TEXT NOT NULL DEFAULT 'premium',
  output_formats_json TEXT,
  structured_content_json TEXT,
  source_document_ids_json TEXT,
  plan_json TEXT,
  fact_ledger_json TEXT,
  qa_report_json TEXT,
  render_result_json TEXT,
  pptx_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  html_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  pdf_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  screenshot_document_ids_json TEXT,
  qa_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  heartbeat_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deck_artifact_jobs_org_created
  ON deck_artifact_jobs (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deck_artifact_jobs_status
  ON deck_artifact_jobs (org_id, status, phase);

CREATE INDEX IF NOT EXISTS idx_deck_artifact_jobs_session
  ON deck_artifact_jobs (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deck_artifact_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES deck_artifact_jobs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(job_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_deck_artifact_job_events_job_seq
  ON deck_artifact_job_events (job_id, seq);

CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_type TEXT NOT NULL CHECK(workflow_type IN ('ingestion','enrichment','daily')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','completed','partial','failed')),
  started_at TEXT,
  completed_at TEXT,
  timeout_at TEXT,
  items_processed INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sync_jobs_org ON sync_jobs(org_id);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status, workflow_type);

ALTER TABLE import_jobs ADD COLUMN hidden_at TEXT;
ALTER TABLE import_jobs ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_import_jobs_org_visible
  ON import_jobs(org_id, hidden_at, deleted_at, created_at);

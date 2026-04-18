CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL
    CHECK(source_type IN ('csv','xlsx','four_degree','zip')),
  source_r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','mapping','preview','processing','completed','failed','cancelled')),
  column_mapping TEXT,
  preview_data TEXT,
  total_rows INTEGER DEFAULT 0,
  processed_rows INTEGER DEFAULT 0,
  created_rows INTEGER DEFAULT 0,
  updated_rows INTEGER DEFAULT 0,
  skipped_rows INTEGER DEFAULT 0,
  failed_rows INTEGER DEFAULT 0,
  error_log_r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_import_jobs_org ON import_jobs(org_id);
CREATE INDEX idx_import_jobs_status ON import_jobs(status);

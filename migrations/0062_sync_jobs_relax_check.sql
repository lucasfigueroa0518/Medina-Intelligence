-- Wave 3a: relax sync_jobs.workflow_type and sync_jobs.status CHECK constraints.
-- Mirrors the precedent in 0050_relax_check_constraints.sql — narrow status/type
-- enums kept silently breaking writes from new code paths. The Wave 3a
-- attachment-backfill orchestrator wants to insert workflow_type='attachment_backfill'
-- with a 'partial' status when failures occur; both are rejected by the current CHECK.
-- Validate in application code instead.
--
-- Existing rows are preserved verbatim; the new table has the same columns,
-- defaults, and indexes — only the CHECKs are dropped.

PRAGMA foreign_keys = OFF;

CREATE TABLE sync_jobs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_type TEXT NOT NULL,                          -- no CHECK
  status TEXT NOT NULL DEFAULT 'pending',               -- no CHECK
  started_at TEXT,
  completed_at TEXT,
  timeout_at TEXT,
  items_processed INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  metadata TEXT DEFAULT '{}'
);

INSERT INTO sync_jobs_new SELECT * FROM sync_jobs;
DROP TABLE sync_jobs;
ALTER TABLE sync_jobs_new RENAME TO sync_jobs;

PRAGMA foreign_keys = ON;

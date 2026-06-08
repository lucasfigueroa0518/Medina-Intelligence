-- Deal ingestion + evidence hardening.
--
-- Progressive Outlook backfill can now terminalize the parent as `failed`
-- when a child window hits a deterministic Graph error. The original parent
-- CHECK only allowed active/completed/cancelled, which forced failed windows
-- to leave the parent active and retryable.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS progressive_backfill_jobs_new;

CREATE TABLE progressive_backfill_jobs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  window_size_days INTEGER NOT NULL DEFAULT 10,
  total_windows INTEGER NOT NULL DEFAULT 18,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

INSERT INTO progressive_backfill_jobs_new
  SELECT id, org_id, user_id, window_size_days, total_windows, status,
         created_at, updated_at, completed_at
    FROM progressive_backfill_jobs;

DROP TABLE progressive_backfill_jobs;
ALTER TABLE progressive_backfill_jobs_new RENAME TO progressive_backfill_jobs;

CREATE INDEX IF NOT EXISTS idx_pbj_org_status ON progressive_backfill_jobs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_pbj_user ON progressive_backfill_jobs(user_id, status);

PRAGMA foreign_keys = ON;

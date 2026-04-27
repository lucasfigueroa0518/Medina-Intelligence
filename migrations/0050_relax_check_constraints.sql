-- Migration 0050: drop overly-narrow CHECK constraints that were silently
-- breaking writes from new code paths. These are status/type enums whose
-- allowed-value lists kept falling behind the application — every new
-- integration or feature triggered another schema migration. Validate in
-- application code instead.
--
-- Three documented breakage cases at the time of this migration:
--   1. import_jobs.source_type was ('csv','xlsx','four_degree','zip') —
--      rejected source_type='intelligent' from the new doc-intelligence path,
--      causing the analyze button to spin forever (handler threw a 500).
--   2. import_jobs.status was missing 'reverted' (added by the undo flow).
--   3. audit_log.action was missing 'intelligent_import',
--      'set_initial_password', 'admin_reset_password' that already exist in
--      types/audit.ts AuditAction. Audit writes for these actions were
--      silently dropped at the consumer.
--
-- Other CHECKs in the DB (deal stages, contact types, event types, etc.)
-- are intentional domain enums and are NOT touched.

PRAGMA foreign_keys = OFF;

-- ─── import_jobs ───────────────────────────────────────────────────────────
CREATE TABLE import_jobs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,                           -- no CHECK
  source_r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',              -- no CHECK
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
INSERT INTO import_jobs_new SELECT * FROM import_jobs;
DROP TABLE import_jobs;
ALTER TABLE import_jobs_new RENAME TO import_jobs;

-- ─── audit_log ─────────────────────────────────────────────────────────────
CREATE TABLE audit_log_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,                                -- no CHECK
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_data TEXT,
  after_data TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO audit_log_new SELECT * FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

PRAGMA foreign_keys = ON;

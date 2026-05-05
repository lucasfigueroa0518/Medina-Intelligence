-- Phase 5 hotfix (2026-05-05) — rebuild work_queue with correct FK target.
--
-- Migration 0083 declared:
--   FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
-- but the production org table is named `organizations`, not `orgs`.
-- SQLite's CREATE TABLE doesn't validate FK target existence at creation
-- time, so 0083 applied cleanly but every INSERT into work_queue fails
-- with "no such table: main.orgs" once D1's FK enforcement triggers.
--
-- Phase 5 shipped with an empty handler registry, so no rows were ever
-- written and the dangling FK stayed latent. Phase 6 1a's first writes
-- to work_queue (now live) AND Phase 6 1b's migration 0084 INSERT both
-- surface the bug.
--
-- Fix: rebuild work_queue with FK→organizations(id). Bundle this BEFORE
-- 0084 in the deploy sequence so 0084's INSERT lands clean.
--
-- ─── Why a rebuild (vs. ALTER TABLE DROP / ADD CONSTRAINT)? ──────────
-- SQLite doesn't support ALTER TABLE DROP CONSTRAINT or ADD CONSTRAINT
-- for foreign keys. Standard remedy is the table-rebuild dance: create
-- a new table with the correct shape, copy rows, drop the old, rename.
-- Production work_queue has 0 rows (verified 2026-05-05 pre-fix), so
-- the COPY step is a no-op. Indexes are dropped with the old table and
-- recreated against the new one.
--
-- ─── Idempotency ────────────────────────────────────────────────────
-- Re-running this migration with an already-correct schema is benign:
-- the rebuild produces an identical end state. Worst case: a redundant
-- table swap. No data loss because work_queue rows are copied into the
-- rebuild, regardless of how many exist at run time.

-- 1. Create rebuild target with the FIXED FK reference.
CREATE TABLE work_queue_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed','dead_letter')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT,
  last_error TEXT,
  locked_until TEXT,
  heartbeat_at TEXT,
  upstream TEXT,
  idempotency_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- 2. Copy any existing rows (typically 0; defense in depth).
INSERT INTO work_queue_new
  SELECT id, org_id, domain, payload, status, attempt, max_attempts,
         next_attempt_at, last_error, locked_until, heartbeat_at,
         upstream, idempotency_key, priority, created_at, started_at,
         completed_at
    FROM work_queue;

-- 3. Drop the old table (drops its indexes too).
DROP TABLE work_queue;

-- 4. Rename rebuild into place.
ALTER TABLE work_queue_new RENAME TO work_queue;

-- 5. Recreate the four indexes (identical to 0083's definitions).
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_idem
  ON work_queue (domain, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_queue_claim
  ON work_queue (domain, status, priority DESC, next_attempt_at)
  WHERE status IN ('pending','in_progress');

CREATE INDEX IF NOT EXISTS idx_work_queue_org_status
  ON work_queue (org_id, status);

CREATE INDEX IF NOT EXISTS idx_work_queue_stale
  ON work_queue (locked_until)
  WHERE status = 'in_progress';

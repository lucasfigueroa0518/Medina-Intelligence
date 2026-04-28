-- Idempotent chunk completion + once-only finalizer trigger.
--
-- Replaces the pre-existing arithmetic decrement on metadata.pending_chunks,
-- which double-decremented when CF retried decrement-and-finalize after a
-- deploy or transient error (audit 2026-04-28: jobs 62f51a55, 2df97c6a left
-- pending_chunks at -1 and finalizer never fired).
--
-- New flow: each chunk inserts a row here. INSERT OR IGNORE makes retries
-- a no-op. Completion is COUNT(sync_job_chunks) vs metadata.chunk_count.
-- The finalizer trigger uses sync_job_finalizers (PRIMARY KEY job_id) +
-- INSERT OR IGNORE to guarantee exactly-once spawn.

CREATE TABLE sync_job_chunks (
  job_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  items_in_chunk INTEGER NOT NULL DEFAULT 0,
  items_succeeded INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, chunk_id)
);
CREATE INDEX idx_sync_job_chunks_job ON sync_job_chunks(job_id);

CREATE TABLE sync_job_finalizers (
  job_id TEXT PRIMARY KEY,
  triggered_at TEXT NOT NULL
);

-- Migration 0049: import_lineage — track every entity created by an import
-- so it can be cleanly undone. We only track CREATES (not UPDATEs to existing
-- entities) because reverting an update would require snapshotting prior
-- field values and would also entangle with post-import enrichment proposals.

CREATE TABLE IF NOT EXISTS import_lineage (
  import_job_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('contact','company','deal','document')),
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (import_job_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_import_lineage_job
  ON import_lineage(import_job_id);

-- import_jobs.status was previously {pending|processing|completed|failed};
-- 'reverted' is the new terminal state set by the undo endpoint. SQLite has
-- no CHECK on this column today (verified at runtime) so no ALTER needed.

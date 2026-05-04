-- Phase 0 — workflow-state reconciler support.
--
-- Adds cf_instance_id to sync_jobs so the reconciler can map D1 rows to
-- Cloudflare Workflows instance IDs and reconcile state when the two
-- diverge.
--
-- Why this is needed:
--   When CF runtime errors a workflow with a hard error (subrequest cap,
--   memory cap, deploy interrupt) the worker invocation is terminated
--   BEFORE user code can run its catch block. trackedStep's failure-write
--   never fires; the outer run() catch block never fires; sync_jobs stays
--   at status='running' indefinitely.
--
--   Today the only reconciliation path is the next ingestion's
--   check-concurrency step (which marks any running >15min as failed).
--   That can leave D1 lying for up to an hour. Worse, until Phase 0a-4
--   the orphan got an outright misleading error message.
--
--   The reconciler closes this gap by polling CF Workflows REST API for
--   each running sync_jobs row and reconciling D1 to runtime truth. The
--   instance-id mapping is the precondition: without it we'd have to
--   correlate by time + workflow_type which is brittle.
--
-- Schema:
--   • Nullable column. Existing rows keep cf_instance_id IS NULL — the
--     reconciler skips those (it only sweeps rows whose ID it has). New
--     rows from any workflow that captures event.instanceId get the
--     value populated.
--   • Phase 0 ships the capture only in IngestionWorkflow.run() (the
--     workflow that's been actively misbehaving). Other workflows
--     (enrichment, ingestion-chunk, etc.) get instanceId capture as
--     follow-up work, one workflow at a time. The reconciler tolerates
--     missing IDs gracefully.
--
-- Index:
--   • Partial index on cf_instance_id IS NOT NULL — reconciler queries
--     filter by `cf_instance_id IS NOT NULL AND status='running'`, and
--     the partial form keeps the index small (legacy rows with NULL
--     don't bloat it).

ALTER TABLE sync_jobs ADD COLUMN cf_instance_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sync_jobs_cf_instance_id
  ON sync_jobs(cf_instance_id)
  WHERE cf_instance_id IS NOT NULL;

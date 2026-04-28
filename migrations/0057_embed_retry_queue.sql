-- Embed gap recovery (audit 2026-04-28 + scale-up batch).
--
-- When a chunk's embed step throws after retries, the chunk's outer catch
-- captures the error, sync_job_chunks records completion anyway, and the
-- items in that chunk are silently missing from Vectorize. The dedup guard
-- in chunkEmbedAndPersistAll then prevents retry on subsequent runs.
--
-- This table is the recovery lane: detect-embed-gaps (in the finalizer)
-- finds conversations / events / documents that were inserted into D1 but
-- never embedded, enqueues them here, and the daily cron drains the queue.
-- An admin endpoint can drain on demand for fast recovery.
CREATE TABLE embed_retry_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'failed_permanent')),
  UNIQUE (org_id, entity_id, source_table)
);
CREATE INDEX idx_embed_retry_queue_status ON embed_retry_queue(status, last_attempt_at);
CREATE INDEX idx_embed_retry_queue_org ON embed_retry_queue(org_id, status);

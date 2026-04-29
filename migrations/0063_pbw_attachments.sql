-- Progressive backfill windows — attachment telemetry columns.
--
-- Pre-fix: progressive_backfill_windows recorded emails_fetched +
-- conversations_added + embedded_count, but attachment counts (which
-- are produced by processClassifiedItems' phase-3 attachment-processor)
-- were only persisted into sync_jobs.metadata. The UI had to read both
-- tables to render a single window's stats.
--
-- Post-fix: closeSyncJob('completed', ...) inside runHistoricalBackfill
-- additionally stamps these four columns on the matching window row, so
-- the UI's per-window query is a single SELECT off progressive_backfill_windows.
--
-- Naming maps to the existing per-page stats produced by processClassifiedItems
-- (src/lib/ingestion-shared.ts). The names converge with attachment-backfill-orchestrator's
-- vocabulary so the four counters mean the same thing across paths:
--   attachments_processed = total attachments touched     (sync_jobs metadata `attachments_attempted`)
--   attachments_persisted = documents successfully written (sync_jobs metadata `attachments_processed`)
--   attachments_failed    = error count                    (sync_jobs metadata `attachments_failed`)
--   attachments_skipped   = idempotency / no-body skips    (sync_jobs metadata `attachments_skipped`)
--
-- Defaults of 0 (NEVER NULL) so SUM/aggregation queries don't need COALESCE.
-- Historical windows pre-dating this column stay at 0 — their attachment
-- counts remain readable from sync_jobs.metadata, but we don't backfill the
-- progressive_backfill_windows columns retroactively.

ALTER TABLE progressive_backfill_windows ADD COLUMN attachments_processed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE progressive_backfill_windows ADD COLUMN attachments_persisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE progressive_backfill_windows ADD COLUMN attachments_failed    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE progressive_backfill_windows ADD COLUMN attachments_skipped   INTEGER NOT NULL DEFAULT 0;

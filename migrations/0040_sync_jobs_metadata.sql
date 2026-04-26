-- F8: Add metadata column to sync_jobs so the workflow can record a structured
-- summary of what it did (counts of contacts created/skipped, deals staged,
-- enrichments triggered, etc.) instead of cramming everything into log lines.

ALTER TABLE sync_jobs ADD COLUMN metadata TEXT DEFAULT '{}';

-- Keep Outlook app-only health reads bounded.
--
-- The Settings integration status only needs user-scope Outlook/calendar
-- incidents. Backfill-window incidents can be numerous and should not be
-- scanned to render mailbox health.

CREATE INDEX IF NOT EXISTS idx_ingestion_incidents_org_scope_source_status_seen
  ON ingestion_incidents(org_id, scope_type, source, status, last_seen_at DESC)
  WHERE status IN ('open','recovering','blocked');

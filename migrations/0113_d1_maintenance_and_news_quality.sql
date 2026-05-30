-- D1 maintenance + news quality hardening.
--
-- This migration intentionally does NOT create the final UNIQUE guard on
-- event_attendees or news_articles. Production currently contains duplicates,
-- so those unique indexes are created by the owner-only maintenance runner
-- after it snapshots and reconciles the dirty rows.

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  kind TEXT NOT NULL DEFAULT 'd1_maintenance',
  mode TEXT NOT NULL CHECK (mode IN ('preview','run','scheduled')),
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  requested_by_user_id TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  r2_prefix TEXT,
  preview_json TEXT NOT NULL DEFAULT '{}',
  stats_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_created
  ON maintenance_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_runs_org_created
  ON maintenance_runs(org_id, created_at DESC);

ALTER TABLE news_articles ADD COLUMN source_url_normalized TEXT;
ALTER TABLE news_articles ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'usable'
  CHECK (quality_status IN ('usable','quarantined','duplicate','archived'));
ALTER TABLE news_articles ADD COLUMN quality_reason TEXT;
ALTER TABLE news_articles ADD COLUMN canonical_news_article_id TEXT;
ALTER TABLE news_articles ADD COLUMN quarantined_at TEXT;
ALTER TABLE news_articles ADD COLUMN archived_at TEXT;

UPDATE news_articles
   SET source_url_normalized = lower(trim(source_url))
 WHERE source_url IS NOT NULL
   AND trim(source_url) != ''
   AND source_url_normalized IS NULL;

CREATE INDEX IF NOT EXISTS idx_news_articles_quality
  ON news_articles(org_id, quality_status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_news_articles_url_norm
  ON news_articles(org_id, source_url_normalized)
  WHERE source_url_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_event_email_norm
  ON event_attendees(event_id, lower(trim(email)));

CREATE INDEX IF NOT EXISTS idx_work_queue_retention_completed
  ON work_queue(status, completed_at)
  WHERE status IN ('completed','dead_letter');

CREATE INDEX IF NOT EXISTS idx_sync_jobs_retention_completed
  ON sync_jobs(status, completed_at);

CREATE INDEX IF NOT EXISTS idx_task_runs_retention_ended
  ON task_runs(status, ended_at);

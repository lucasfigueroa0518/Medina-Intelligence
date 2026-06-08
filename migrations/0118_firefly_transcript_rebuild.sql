-- Fireflies transcript rebuild ledger.
--
-- This is an in-place repair surface for the transcript layer. Outlook events
-- remain canonical calendar rows; Fireflies is the source of transcript
-- availability. These tables let rebuild/backfill runs prove, per transcript,
-- whether the source was seen, staged to R2, linked to Outlook, left standalone,
-- embedded, and/or failed with an actionable reason.

CREATE TABLE IF NOT EXISTS firefly_transcript_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'rebuild'
    CHECK (mode IN ('progressive_backfill','rebuild','coverage_repair','webhook')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','partial','failed','cancelled','dry_run')),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  source_transcripts INTEGER NOT NULL DEFAULT 0,
  r2_staged INTEGER NOT NULL DEFAULT 0,
  linked_events INTEGER NOT NULL DEFAULT 0,
  standalone_transcripts INTEGER NOT NULL DEFAULT 0,
  embedding_queued INTEGER NOT NULL DEFAULT 0,
  prospect_queued INTEGER NOT NULL DEFAULT 0,
  missing_credentials INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_firefly_transcript_runs_org_status
  ON firefly_transcript_runs(org_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_firefly_transcript_runs_user
  ON firefly_transcript_runs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS firefly_transcript_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES firefly_transcript_runs(id) ON DELETE SET NULL,
  firefly_event_id TEXT NOT NULL,
  transcript_date TEXT NOT NULL,
  title TEXT NOT NULL,
  duration_minutes INTEGER,
  r2_key TEXT,
  source_hash TEXT,
  canonical_status TEXT NOT NULL DEFAULT 'staged'
    CHECK (canonical_status IN ('staged','linked','standalone','superseded','error','dry_run')),
  canonical_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  matched_event_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, firefly_event_id)
);

CREATE INDEX IF NOT EXISTS idx_firefly_transcript_items_org_date
  ON firefly_transcript_items(org_id, transcript_date DESC);
CREATE INDEX IF NOT EXISTS idx_firefly_transcript_items_status
  ON firefly_transcript_items(org_id, canonical_status, transcript_date DESC);
CREATE INDEX IF NOT EXISTS idx_firefly_transcript_items_run
  ON firefly_transcript_items(run_id);

CREATE TABLE IF NOT EXISTS firefly_transcript_event_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  firefly_event_id TEXT NOT NULL,
  transcript_item_id TEXT REFERENCES firefly_transcript_items(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  link_status TEXT NOT NULL DEFAULT 'linked'
    CHECK (link_status IN ('linked','superseded','rejected')),
  match_score REAL NOT NULL DEFAULT 0,
  match_reason TEXT NOT NULL DEFAULT '{}',
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, firefly_event_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_firefly_transcript_links_event
  ON firefly_transcript_event_links(org_id, event_id);
CREATE INDEX IF NOT EXISTS idx_firefly_transcript_links_firefly
  ON firefly_transcript_event_links(org_id, firefly_event_id);

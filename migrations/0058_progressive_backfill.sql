-- Progressive backfill: drive a date-range historical backfill in N small
-- windows over multiple cron ticks so it survives Worker CPU limits and
-- runs entirely server-side without operator presence.
--
-- One parent row per (user, trigger). N child windows per parent.
-- A new */2 minute cron picks up active parents, advances the next pending
-- window by one paginated batch (~25s of work), and moves on. When a window
-- completes, it stamps stats (emails fetched, conversations added,
-- embedding coverage) and the next window kicks off automatically.

CREATE TABLE progressive_backfill_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  window_size_days INTEGER NOT NULL DEFAULT 10,
  total_windows INTEGER NOT NULL DEFAULT 18,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX idx_pbj_org_status ON progressive_backfill_jobs(org_id, status);
CREATE INDEX idx_pbj_user ON progressive_backfill_jobs(user_id, status);

CREATE TABLE progressive_backfill_windows (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  parent_id TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  emails_fetched INTEGER NOT NULL DEFAULT 0,
  conversations_added INTEGER NOT NULL DEFAULT 0,
  embedded_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  UNIQUE (parent_id, window_index)
);
CREATE INDEX idx_pbw_parent ON progressive_backfill_windows(parent_id, window_index);
CREATE INDEX idx_pbw_status ON progressive_backfill_windows(status, parent_id);

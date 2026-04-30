-- Multi-day rate-limit-aware Firefly backfill queue.
--
-- Pre-existing Phase F design (migration 0064) ran all windows back-to-back
-- on the every-minute progressive cron. When a user's daily Fireflies quota
-- hit, every subsequent window cascade-failed within minutes (Tony 2026-04-30:
-- 4 of 9 windows failed in 4 minutes after windows 0-4 completed). PR #18
-- routed the rate-limit response to PAUSED-instead-of-FAILED but didn't add
-- proactive scheduling — paused windows just retried on the very next cron
-- tick and re-hit the same quota.
--
-- This migration adds:
--   1. Per-day scheduling on each window (earliest_run_at gates retry until
--      the day's quota window opens)
--   2. Per-user daily quota tracking (firefly_user_quotas) so the driver
--      can defer windows BEFORE hitting the rate limit
--   3. Per-window concurrency lock (lock_expires_at) so two cron ticks
--      racing on the same window don't double-process and inflate counters
--      (audit 2026-04-30: window 4 had persisted+dup+failed=27 vs last_skip=13)
--   4. 'partially_completed' parent status — parents that finish with some
--      FAILED windows now correctly reflect that, instead of marking
--      'completed' and hiding the failures.

-- ── 1. Multi-day scheduling on parent + window ────────────────────────────

-- D1 SQLite ALTER TABLE ADD COLUMN supports defaults; no rewrite needed.
ALTER TABLE firefly_progressive_backfill_jobs
  ADD COLUMN scheduled_days_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE firefly_progressive_backfill_jobs
  ADD COLUMN current_day_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE firefly_progressive_backfill_jobs
  ADD COLUMN daily_quota_target INTEGER;          -- discovered from rate-limit response; null until learned

ALTER TABLE firefly_progressive_backfill_windows
  ADD COLUMN scheduled_for_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE firefly_progressive_backfill_windows
  ADD COLUMN earliest_run_at TEXT;                -- ISO 8601; window won't be picked before this
ALTER TABLE firefly_progressive_backfill_windows
  ADD COLUMN lock_expires_at TEXT;                -- ISO 8601; concurrency guard

CREATE INDEX IF NOT EXISTS idx_fpbw_pickable
  ON firefly_progressive_backfill_windows (parent_id, status, earliest_run_at, lock_expires_at);

-- ── 2. Per-user daily quota tracking ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS firefly_user_quotas (
  user_id TEXT NOT NULL,
  quota_date TEXT NOT NULL,                       -- ISO date YYYY-MM-DD UTC
  api_calls_used INTEGER NOT NULL DEFAULT 0,      -- total Graph + Firefly API calls in this day
  backfill_calls INTEGER NOT NULL DEFAULT 0,      -- subset attributed to backfill driver
  webhook_deliveries INTEGER NOT NULL DEFAULT 0,  -- subset from real-time webhook ingest
  daily_limit INTEGER,                            -- discovered from rate-limit response, null = use default
  rate_limited_at TEXT,                           -- last time a 429-equivalent was observed
  PRIMARY KEY (user_id, quota_date)
);
CREATE INDEX IF NOT EXISTS idx_fuq_user_recent ON firefly_user_quotas (user_id, quota_date DESC);

-- ── 3. partially_completed parent status ──────────────────────────────────
--
-- The CHECK constraint on firefly_progressive_backfill_jobs.status was
-- ('active','completed','cancelled'). Add 'partially_completed' for parents
-- that have some FAILED windows (terminal failures, not paused). SQLite
-- doesn't support ALTER TABLE ADD CHECK, so we have to recreate the table.
-- Done in a transaction so a failure rolls back cleanly.

CREATE TABLE firefly_progressive_backfill_jobs_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  window_size_days INTEGER NOT NULL DEFAULT 10,
  total_windows INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','partially_completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  scheduled_days_count INTEGER NOT NULL DEFAULT 1,
  current_day_index INTEGER NOT NULL DEFAULT 0,
  daily_quota_target INTEGER
);

INSERT INTO firefly_progressive_backfill_jobs_new
  (id, org_id, user_id, api_key_encrypted, window_size_days, total_windows,
   status, created_at, updated_at, completed_at,
   scheduled_days_count, current_day_index, daily_quota_target)
SELECT
   id, org_id, user_id, api_key_encrypted, window_size_days, total_windows,
   status, created_at, updated_at, completed_at,
   scheduled_days_count, current_day_index, daily_quota_target
FROM firefly_progressive_backfill_jobs;

DROP TABLE firefly_progressive_backfill_jobs;
ALTER TABLE firefly_progressive_backfill_jobs_new RENAME TO firefly_progressive_backfill_jobs;

CREATE INDEX idx_fpbj_org_status ON firefly_progressive_backfill_jobs(org_id, status);
CREATE INDEX idx_fpbj_user ON firefly_progressive_backfill_jobs(user_id, status);

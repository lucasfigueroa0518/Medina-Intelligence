-- Phase 0a-3 — calendar progressive backfill.
--
-- Mirrors the Firefly progressive-backfill pattern (migration 0064) for
-- Outlook calendar sync. Replaces the prior all-at-once
-- fetchOutlookCalendarDelta which fetched 120 days × all users in a single
-- step.do invocation and blew the 1000-subrequest CF cap.
--
-- Why progressive instead of delta:
--   • Microsoft Graph /me/calendarView/delta was returning silent zeros
--     in production (audit 2026-04-30, hotfix ade54b4). Non-delta
--     /calendarView is the source of truth.
--   • Non-delta means every sync re-fetches the full window. With a
--     120-day window × N users, the cumulative subreqs blow past the
--     1000/invocation cap.
--   • Chunking into per-user-per-week rows + processing 2 per tick keeps
--     each invocation well under the cap (≤ 8 windows × ~50 subreqs each
--     = ≤ 400 subreqs/tick) while preserving full 120-day coverage over
--     ~15 hours.
--
-- Lifecycle for a row:
--   pending      — never synced (fresh bootstrap) OR retry-pending after a
--                  transient failure with next_attempt_at scheduled
--   in_progress  — a driver currently owns this row; locked_until is set
--                  to now + LOCK_DURATION_MS so a crashed driver's row is
--                  reclaimable after the lock expires
--   completed    — last sync succeeded; last_synced_at populated. Re-picked
--                  when last_synced_at < now − refresh_interval (refresh_
--                  interval varies: 4h for current/adjacent weeks, 24h for
--                  older weeks).
--   failed       — three attempts exhausted; dead-letter. Surfaced in
--                  System Status when Phase 0 ships. No auto-retry.
--                  Operator resets to 'pending' via admin endpoint.
--
-- Bootstrapping: the driver INSERT OR IGNOREs one row per (user, week) at
-- the top of every tick. Past-120d to future+90d → ~30 rows per user.
-- After bootstrap, no further row-creation work happens until time
-- advances (a new week starts; INSERT OR IGNORE adds the new row).
--
-- Idempotency: UNIQUE(org_id, user_id, window_start) collapses double-
-- bootstrap. ON CONFLICT semantics keep window state; only events flow
-- through upsertOutlookEvent's ON CONFLICT(outlook_event_id) which is
-- already idempotent for the underlying events table.
--
-- Self-healing: failed token refreshes don't poison the row — the per-
-- attempt error is logged in last_error, attempts increments, and
-- next_attempt_at backs off. After 3 attempts the row dead-letters but
-- doesn't block other windows for the same user.

CREATE TABLE IF NOT EXISTS calendar_progressive_backfill_windows (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  -- ISO timestamps. window_start is the UTC Monday 00:00 marking week
  -- boundary; window_end is +7 days. Stored explicitly (not derived) so
  -- a SELECT can pass them straight to /calendarView without computing.
  window_start    TEXT NOT NULL,
  window_end      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  -- Populated on first 'completed' transition; updated on every refresh.
  -- Drives the staleness check that re-promotes 'completed' rows back to
  -- pickable.
  last_synced_at  TEXT,
  -- Cumulative successful upserts across all completions for this row.
  -- Useful for "did this week genuinely have N events" sanity checks.
  events_upserted INTEGER NOT NULL DEFAULT 0,
  -- 0..MAX_ATTEMPTS. Resets to 0 on each successful completion; persists
  -- across the row's lifetime for failure attribution.
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  -- ISO timestamp; the driver only picks rows where this is NULL or in
  -- the past. Set by the driver on transient failure to enforce backoff
  -- between retries (5min after 1st fail, 30min after 2nd).
  next_attempt_at TEXT,
  -- ISO timestamp; while in_progress, set to now + LOCK_DURATION_MS. A
  -- driver finding an in_progress row with locked_until < now reclaims
  -- it (the previous owner died mid-flight).
  locked_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, user_id, window_start)
);

-- Hot path for the driver's pickNextWindow: filter by org+user+status
-- first, then evaluate next_attempt_at / locked_until / last_synced_at
-- in the WHERE clause.
CREATE INDEX IF NOT EXISTS idx_cpbw_org_user_status
  ON calendar_progressive_backfill_windows(org_id, user_id, status);

-- Sweep query for System Status: "find rows that are pickable RIGHT NOW
-- across all users". Sorted by next_attempt_at then last_synced_at so the
-- oldest stale row is picked first.
CREATE INDEX IF NOT EXISTS idx_cpbw_pickable
  ON calendar_progressive_backfill_windows(status, next_attempt_at, last_synced_at);

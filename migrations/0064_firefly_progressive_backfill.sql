-- Firefly progressive backfill — mirrors Outlook's progressive backfill
-- (migration 0058) for transcript pulls. Drives a multi-day Fireflies
-- backfill in 10-day windows over many cron ticks so it survives Worker
-- CPU limits, runs entirely server-side, no operator presence required.
--
-- Why a parallel implementation rather than reusing Outlook's tables:
--   - Different ingestion path (transcripts → events, not emails →
--     conversations)
--   - Per-tick budget tuned for transcripts (heavier per-item via
--     processTranscriptItems' chunking + per-attendee ACL stamp)
--   - Per-user Fireflies API keys are user-supplied transactional
--     secrets, NOT long-lived OAuth tokens — we encrypt and store on
--     the parent row, then nuke at completion (see Q(a) of Phase F
--     plan: least-privilege default, user re-supplies for any future
--     backfill).
--
-- Pagination is offset-based (Firefly GraphQL `transcripts(skip, limit)`
-- doesn't expose an opaque cursor) — `last_skip` on each window is the
-- resume offset. Windows mark `'completed'` when fetchTranscriptBatch
-- returns < PAGE_SIZE results within the window's date range.

CREATE TABLE firefly_progressive_backfill_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- AES-256-GCM ciphertext of {"api_key": "<user supplied>"} via
  -- src/lib/encryption.ts. Nuked to '' (empty) when status flips to
  -- 'completed' or 'cancelled' so the secret isn't retained beyond
  -- its useful life.
  api_key_encrypted TEXT NOT NULL,
  window_size_days INTEGER NOT NULL DEFAULT 10,
  total_windows INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX idx_fpbj_org_status ON firefly_progressive_backfill_jobs(org_id, status);
CREATE INDEX idx_fpbj_user ON firefly_progressive_backfill_jobs(user_id, status);

CREATE TABLE firefly_progressive_backfill_windows (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  parent_id TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  -- Offset-based resume cursor for Fireflies GraphQL pagination. The
  -- driver writes the last successfully-processed `skip` here at the
  -- end of every paused tick; the next tick reads it and continues from
  -- there. 0 means "start from the beginning of this window's range".
  last_skip INTEGER NOT NULL DEFAULT 0,
  -- Per-window counters. transcripts_fetched is "page hits"; the others
  -- are per-transcript outcomes from ingestSingleFireflyTranscript.
  transcripts_fetched INTEGER NOT NULL DEFAULT 0,
  transcripts_persisted INTEGER NOT NULL DEFAULT 0,
  transcripts_skipped_duplicate INTEGER NOT NULL DEFAULT 0,
  transcripts_failed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  UNIQUE (parent_id, window_index)
);
CREATE INDEX idx_fpbw_parent ON firefly_progressive_backfill_windows(parent_id, window_index);
CREATE INDEX idx_fpbw_status ON firefly_progressive_backfill_windows(status, parent_id);

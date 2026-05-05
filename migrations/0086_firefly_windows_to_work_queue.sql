-- Phase 6.2 1b (2026-05-05) — firefly_window reconciliation migration.
--
-- Completes the cutover from the legacy
-- firefly_progressive_backfill_windows-driven loop to work_queue
-- (domain='firefly_window'). Phase 6.2 1a (commit a2e7bfc, deploy
-- ce710608) shipped dual-write at parent-creation time so any backfill
-- triggered AFTER 1a deploy already has rows in both tables. This
-- migration:
--
--   • Op A: backfills work_queue rows for legacy windows that were
--     created BEFORE 1a's dual-write (e.g. Tony's 8 pending windows
--     from 2026-04-30, plus any in-flight from before 1a deployed).
--     Idempotency_key match (`${parent_id}:${window_index}`) collapses
--     INSERTs that already exist from 1a's dual-write.
--
--   • Op B: reconciles in-flight divergence — a window that the legacy
--     driver already marked terminal (completed/failed) in the gap
--     between 1a deploy and 1b deploy could have a stale 'pending'
--     work_queue row from the dual-write. Mark those terminal so the
--     handler doesn't re-process them when registered.
--
-- Live state at design time (2026-05-05): 0 work_queue:firefly_window
-- rows; 8 legacy pending + 4 legacy failed + 9 legacy completed.
-- Op A copies the 8 pending. Op B is currently a no-op but stays in
-- the migration for safety against any rows that materialize between
-- now and migration apply.
--
-- ─── Idempotency ─────────────────────────────────────────────────────
--
-- Re-running this migration is safe:
--   • Op A: INSERT OR IGNORE — second run is a no-op for already-
--     migrated rows (partial UNIQUE on (domain, idempotency_key)).
--   • Op B: idempotent UPDATE — second run finds no
--     pending/in_progress work_queue rows whose legacy is terminal
--     (because the first run already moved them).
--
-- ─── Status mapping ───────────────────────────────────────────────────
--
--   legacy.status             →   work_queue.status
--   ──────────────────────────────────────────────
--   'pending'                 →   'pending'
--   'in_progress'             →   'pending'  (treat as stale; the
--                                  legacy driver's lock_expires_at
--                                  is replaced by work_queue's
--                                  locked_until once handler claims)
--   'completed'               →   'completed' (Op B only)
--   'failed'                  →   'dead_letter' (Op B only)
--
-- ─── Parent table NOT touched ────────────────────────────────────────
--
-- firefly_progressive_backfill_jobs is the canonical orchestration
-- journal post-Phase-6.2 (per Lucas 2026-05-05 decision). Its rows
-- are unchanged by this migration. The handler reads parent.status
-- for cancel-mid-flight short-circuit and parent.api_key_encrypted
-- for legacy fallback (Phase 4 two-tier resolution).

-- ─── Op A: copy legacy pending/in_progress windows ───────────────────

INSERT OR IGNORE INTO work_queue (
  id, org_id, domain, payload, status, attempt, max_attempts,
  upstream, idempotency_key, created_at
)
SELECT
  lower(hex(randomblob(16))),
  p.org_id,
  'firefly_window',
  json_object(
    'parent_id',                     w.parent_id,
    'user_id',                       p.user_id,
    'window_index',                  w.window_index,
    'start_date',                    w.start_date,
    'end_date',                      w.end_date,
    'last_skip',                     COALESCE(w.last_skip, 0),
    'transcripts_fetched',           COALESCE(w.transcripts_fetched, 0),
    'transcripts_persisted',         COALESCE(w.transcripts_persisted, 0),
    'transcripts_skipped_duplicate', COALESCE(w.transcripts_skipped_duplicate, 0),
    'transcripts_failed',            COALESCE(w.transcripts_failed, 0)
  ),
  'pending',
  0,
  3,
  'firefly_api',
  p.id || ':' || w.window_index,
  w.created_at
FROM firefly_progressive_backfill_jobs p
JOIN firefly_progressive_backfill_windows w ON w.parent_id = p.id
WHERE p.status = 'active'
  AND w.status IN ('pending', 'in_progress');

-- ─── Op B: reconcile in-flight divergence ────────────────────────────
-- For any work_queue row whose corresponding legacy row is already
-- terminal (completed/failed), mark it terminal in work_queue too.
-- Prevents the handler from re-processing legacy-completed work.

UPDATE work_queue
   SET status = (
         SELECT CASE lw.status
                  WHEN 'completed' THEN 'completed'
                  WHEN 'failed'    THEN 'dead_letter'
                  ELSE 'pending'
                END
           FROM firefly_progressive_backfill_windows lw
          WHERE json_extract(work_queue.payload, '$.parent_id')    = lw.parent_id
            AND json_extract(work_queue.payload, '$.window_index') = lw.window_index
       ),
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       locked_until = NULL
 WHERE domain = 'firefly_window'
   AND status IN ('pending', 'in_progress')
   AND EXISTS (
         SELECT 1 FROM firefly_progressive_backfill_windows lw
          WHERE json_extract(work_queue.payload, '$.parent_id')    = lw.parent_id
            AND json_extract(work_queue.payload, '$.window_index') = lw.window_index
            AND lw.status IN ('completed', 'failed')
       );

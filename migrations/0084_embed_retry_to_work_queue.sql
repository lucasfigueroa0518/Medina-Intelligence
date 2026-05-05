-- Phase 6 1b (2026-05-05) — embed_retry_queue → work_queue data migration.
--
-- Pilot domain migration: copies all rows from embed_retry_queue into
-- work_queue with the canonical Phase 5 shape. After this migration:
--   • work_queue WHERE domain='embed_retry' is the authoritative surface
--   • embed_retry_queue table + rows are PRESERVED as a revert window
--     (per Lucas 2026-05-05; drop in Phase 6.x or 7 after work_queue
--     handles real traffic for several days)
--
-- Revert path: revert the merge commit + counter-migration to delete
-- the migrated work_queue rows by idempotency_key. embed_retry_queue
-- contents are untouched, so the old code paths can resume draining
-- them after revert.
--
-- ─── Status mapping ─────────────────────────────────────────────────
--
--   embed_retry_queue.status   →   work_queue.status
--   ────────────────────────────────────────────────
--   pending                    →   pending
--   in_progress                →   pending  (treat as stale; the old
--                                  drain's stale-claim reset already
--                                  did this on a 10-min window. Any
--                                  in_progress row at migration time
--                                  is by definition older than that.)
--   failed_permanent           →   dead_letter
--
-- ─── Idempotency ───────────────────────────────────────────────────
--
-- Every row gets idempotency_key = org_id || ':' || entity_id || ':'
-- || source_table — exactly mirrors 1a's enqueueWork keys at the
-- three writer sites. work_queue's partial UNIQUE on (domain,
-- idempotency_key) collapses re-inserts. So:
--   • Re-running this migration is a no-op (rows already exist)
--   • Rows enqueued by 1a between deploy and this migration are
--     deduplicated against the legacy rows being migrated here
--
-- ─── Per-row mapping ───────────────────────────────────────────────
--
--   id              → fresh ULID via lower(hex(randomblob(16)))
--   org_id          → embed_retry_queue.org_id
--   domain          → 'embed_retry'
--   payload         → json_object('entity_id', ..., 'source_table', ...)
--   status          → mapped per table above
--   attempt         → embed_retry_queue.attempts (preserved)
--   max_attempts    → 3 (matches handler's max + work_queue default)
--   last_error      → embed_retry_queue.last_error (preserved)
--   upstream        → 'bge' (matches 1a's enqueue keys + handler's
--                     recordRateLimit upstream)
--   idempotency_key → org_id || ':' || entity_id || ':' || source_table
--   created_at      → embed_retry_queue.created_at (preserves chronology;
--                     dead_letter rows surfaced in System Status keep
--                     their original first-failure timestamp)

INSERT OR IGNORE INTO work_queue (
  id,
  org_id,
  domain,
  payload,
  status,
  attempt,
  max_attempts,
  last_error,
  upstream,
  idempotency_key,
  created_at
)
SELECT
  lower(hex(randomblob(16))),
  org_id,
  'embed_retry',
  json_object('entity_id', entity_id, 'source_table', source_table),
  CASE status
    WHEN 'pending' THEN 'pending'
    WHEN 'in_progress' THEN 'pending'
    WHEN 'failed_permanent' THEN 'dead_letter'
    ELSE 'pending'
  END,
  COALESCE(attempts, 0),
  3,
  last_error,
  'bge',
  org_id || ':' || entity_id || ':' || source_table,
  created_at
FROM embed_retry_queue;

-- Note: embed_retry_queue table + rows intentionally preserved.
-- A separate phase (6.x or 7) drops them once work_queue has handled
-- real traffic for several days and revert window has elapsed.

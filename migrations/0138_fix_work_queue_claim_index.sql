-- 0138: the REAL claim-path index (audit F2, 2026-07-07).
--
-- 0137 tried to create this as idx_work_queue_claim, but an index with
-- that NAME already exists (0083/0085: (domain, status, priority DESC,
-- next_attempt_at) WHERE status IN ('pending','in_progress')), so
-- CREATE INDEX IF NOT EXISTS silently no-opped and the claim query kept
-- full-scanning ~161k rows per run. Remote EXPLAIN QUERY PLAN confirmed
-- SCAN + TEMP B-TREE. New NAME so the definition actually lands; the old
-- index stays (other paths may use its partial shape) — flagged for a
-- later redundancy review. Serves the claim subquery's exact shape
-- (equality domain+status, ORDER BY priority DESC, created_at) and the
-- in_progress COUNT.

CREATE INDEX IF NOT EXISTS idx_work_queue_claim_v2
  ON work_queue (domain, status, priority DESC, created_at);

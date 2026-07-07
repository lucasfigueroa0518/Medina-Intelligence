-- 0137: work_queue hot-path indexes (D1 CPU incident, 2026-07-06).
--
-- D1 insights showed the minute-tick claim query reading ~160k rows
-- (the whole table) per run, 17.5k runs/day = 2.79B rows read, and the
-- per-domain status rollup reading the whole table 3.1k times/day
-- (501M rows). The existing (domain, status, priority DESC,
-- next_attempt_at) index cannot serve the claim's ORDER BY
-- (priority DESC, created_at) so SQLite falls back to a scan.
-- Read-only workload change: identical results, indexed access paths.

CREATE INDEX IF NOT EXISTS idx_work_queue_claim
  ON work_queue (domain, status, priority DESC, created_at);

CREATE INDEX IF NOT EXISTS idx_work_queue_org_domain_status
  ON work_queue (org_id, domain, status);

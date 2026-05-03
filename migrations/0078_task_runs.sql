-- Phase 0 — task_runs: durable run records for every scheduled task that
-- executes OUTSIDE a Cloudflare Workflow.
--
-- Why this is distinct from sync_jobs:
--   sync_jobs   → one row per Workflow execution (ingestion, enrichment,
--                 daily-cron, etc.). Long-running, multi-step, paginated.
--   task_runs   → one row per discrete scheduled task that runs in a Worker
--                 invocation: every ctxExec.waitUntil block on cron triggers,
--                 every queue consumer batch, every self-healer pass.
--
-- Together they give "what did the system do in the last hour" full coverage:
-- sync_jobs answers "did the ingestion Workflow run", task_runs answers "did
-- the embed-retry-queue drain run, the deal-intelligence refresh, the
-- subscription renewal, the reconciliation healer, etc."
--
-- Standing properties this enables:
--   - Observability   → every task records start/end/result; never silent.
--   - Self-healing    → watchdog finds rows stuck in 'running' past a stale
--                       threshold (no heartbeat in N min) and resets them.
--   - Atomicity       → a task is either 'running' (open) or terminal
--                       ('success' / 'partial' / 'failed' / 'skipped'). No
--                       in-between states; the helper enforces this.
--   - Idempotency     → callers can use ON CONFLICT on a unique idempotency
--                       key when the same scheduled task fires twice in the
--                       same window (defensive against cron double-fire).
--
-- Status semantics:
--   running   - task is in flight; heartbeat_at updated by long-running tasks
--   success   - completed cleanly; items_processed reflects work done
--   partial   - completed but some items failed; items_failed > 0 expected
--   failed    - threw before completion; last_error populated
--   skipped   - intentionally did no work (e.g., budget gated, no items)
--
-- Wallclock note: D1 inserts are NOT free; a task running every minute that
-- writes a row each tick is 1,440 rows/day. Acceptable. Daily cleanup of
-- rows >30d (in cron) keeps this bounded.

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  duration_ms INTEGER,
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  items_skipped INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  heartbeat_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  -- Optional uniqueness key to collapse double-fires of the same scheduled
  -- task within the same window (e.g., '<task_name>:<bucket_start_iso>').
  -- NULL = no idempotency check (caller is fine with duplicate rows).
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Hot read path: "show me the recent runs of <task> for <org>".
CREATE INDEX IF NOT EXISTS idx_task_runs_org_task_started
  ON task_runs(org_id, task_name, started_at DESC);

-- Status sweep: "show me everything that failed in the last 24h".
CREATE INDEX IF NOT EXISTS idx_task_runs_status_started
  ON task_runs(status, started_at DESC);

-- Watchdog: "find rows stuck in running with no heartbeat".
-- Partial index — only the running rows we'd ever sweep. Tiny index size
-- since the running set is small at any moment.
CREATE INDEX IF NOT EXISTS idx_task_runs_running_heartbeat
  ON task_runs(heartbeat_at)
  WHERE status = 'running';

-- Idempotency: only enforced when caller supplies a key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_idempotency
  ON task_runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

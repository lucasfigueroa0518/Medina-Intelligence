-- Phase 5 (2026-05-05) — Universal Work Queue.
--
-- Single substrate that subsumes the per-domain "work table" pattern
-- proliferating in this codebase (embed_retry_queue, firefly_progressive
-- _backfill_*, calendar_progressive_backfill_windows, plus future
-- enrichment / outlook-progressive / webhook-derived domains). Each of
-- those reimplements some subset of {status state machine, retry/backoff,
-- lock/heartbeat, idempotency, dead-letter, circuit-breaker gating}.
-- This table absorbs all of those concerns into one shape — domains
-- carry their own data via the `payload` JSON column and register a
-- handler against the cron driver.
--
-- This phase ships the SUBSTRATE ONLY. No existing domain is migrated
-- in. First domain pilots arrive in Phase 5.1+ (likely embed_retry as
-- the smallest target). The substrate is provably useful even with zero
-- consumers because future phases plug in for one line.
--
-- ─── Lifecycle ────────────────────────────────────────────────────────
--
--   pending      — ready to be claimed. next_attempt_at is either NULL
--                  (claim immediately) or a future timestamp gating the
--                  next pickup (used for retry backoff).
--   in_progress  — a driver currently owns this row. locked_until is
--                  set to now + LOCK_TTL_MS so a crashed driver's row
--                  is reclaimable after the lock expires. heartbeat_at
--                  bumps periodically while the handler runs.
--   completed    — handler returned success. completed_at populated.
--                  No further action.
--   failed       — handler returned a non-final error AND attempt count
--                  has not yet hit max_attempts. Sets next_attempt_at
--                  via three-tier backoff (5min, 30min) then transitions
--                  to dead_letter on the third failure.
--                  NOTE: 'failed' is a transient state in the rotation
--                  pending → in_progress → failed → pending again. Rows
--                  in 'failed' for more than ~min are anomalous and the
--                  watchdog will reset them.
--   dead_letter  — attempt >= max_attempts AND last call still failed.
--                  Surfaced in System Status. No auto-retry. Operator
--                  resets to 'pending' via admin endpoint or D1 query.
--
-- ─── Standing properties (Phase 5 contract) ──────────────────────────
--
--   • Idempotency. (domain, idempotency_key) is UNIQUE. Enqueue idiom is
--     INSERT … ON CONFLICT(domain, idempotency_key) DO NOTHING. A second
--     enqueue with the same key collapses cleanly. Domains that don't
--     need this leave idempotency_key NULL — the partial unique index
--     allows arbitrarily many NULL keys.
--
--   • Atomicity. Claim is a single statement:
--       UPDATE work_queue SET status='in_progress', locked_until=?, …
--         WHERE id IN (
--           SELECT id FROM work_queue
--            WHERE status='pending'
--              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
--              AND domain = ?
--              AND (upstream IS NULL OR upstream NOT IN (open-circuit set))
--            ORDER BY priority DESC, created_at ASC
--            LIMIT ?
--         )
--         RETURNING *;
--     Two ticks racing for the same row will both filter on
--     status='pending'; D1 (SQLite) serializes writes so exactly one
--     transitions to in_progress and gets it back via RETURNING.
--
--   • Checkpointing. payload JSON carries domain checkpoint state
--     (e.g. last_skip for paginated APIs). Driver writes to payload
--     between attempts so a retry resumes from the checkpoint, not
--     from scratch.
--
--   • Rate-limit awareness. The optional `upstream` column is a key
--     into upstream_budget_ledger. Claim filters out rows whose
--     upstream's circuit is currently OPEN — those rows wait until
--     the breaker resets (re-checked on every tick). Per-item not
--     per-domain by deliberate design (2026-05-05): a single domain
--     may fan out to multiple upstreams (e.g. enrichment_item hitting
--     Apollo + Gemini + Claude), and per-item upstream avoids forcing
--     sub-domain proliferation.
--
--   • Three-tier retry. attempt + max_attempts + next_attempt_at.
--     Default schedule: attempt 1 fail → next_attempt_at = now + 5min;
--     attempt 2 fail → +30min; attempt 3 fail → dead_letter.
--     Domains can override max_attempts per-row.
--
--   • Circuit breaker integration. claimNextBatch() reads the open-
--     circuit set from upstream_budget_ledger before each batch and
--     filters claims accordingly. Re-eval happens every tick — when a
--     circuit closes, deferred rows become claimable on the next tick.
--
--   • Auto-tune-DOWN-only. work_queue does not mutate the ledger's
--     caps. It only READS circuit state. Cap auto-decay remains the
--     ledger's job, fed by upstream 429 responses recorded by the
--     domain handler via existing recordRateLimit().
--
--   • Observability. system-status.ts extensions (Phase 5 1b) surface
--     dead_letter rows grouped by domain in getDeadLetterItems and
--     stuck in_progress rows in getStuckTaskRuns.
--
--   • Self-healing. A watchdog in the minute-tick driver scans for
--     in_progress rows whose locked_until has elapsed AND heartbeat_at
--     is older than the stale threshold. These get their status reset
--     to 'pending' and attempt incremented (so a permanently-crashing
--     handler eventually dead-letters rather than looping forever).
--
-- ─── Capacity envelope ───────────────────────────────────────────────
--
--   • CF subrequest cap is 1000/invocation. The minute-tick driver
--     iterates the registered handler set; each handler must keep its
--     per-tick batch ≤10 items AND its per-handler subrequests at a
--     conservative ~50 to leave headroom. Heavier domains run on a
--     less frequent cadence (hourly tick) or chunk via next_attempt_at.
--   • D1 reads per tick for the substrate itself: 1 read for open-
--     circuit set + 1 UPDATE…RETURNING per domain claim + N writes
--     per item handled. Stays well under per-invocation budget.

CREATE TABLE IF NOT EXISTS work_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,                  -- 'embed_retry' | 'firefly_window' | 'enrichment_item' | …
  payload TEXT NOT NULL,                 -- JSON; domain owns the shape
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed','dead_letter')),

  -- Retry / backoff
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT,                  -- NULL = ready immediately
  last_error TEXT,

  -- Lock / heartbeat (claim TTL prevents stuck rows holding the slot)
  locked_until TEXT,
  heartbeat_at TEXT,

  -- Optional gate: rows whose upstream's circuit is OPEN are skipped
  -- by claimNextBatch and re-eligible once it closes.
  upstream TEXT,                         -- 'gemini' | 'firefly_api' | 'graph' | … | NULL

  -- Per-domain natural-key dedupe. Enqueue uses
  -- INSERT … ON CONFLICT(domain, idempotency_key) DO NOTHING.
  idempotency_key TEXT,

  -- Higher value claimed first within a domain.
  priority INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT,

  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);

-- Idempotency: per-domain unique only when a key is supplied. SQLite
-- partial UNIQUE index supports arbitrarily many NULL idempotency_keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_idem
  ON work_queue (domain, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Claim hot path: filtered by status, scoped to a single domain, ordered
-- by priority (desc) then FIFO. The WHERE clause matches the SELECT in
-- claimNextBatch so SQLite can use this for the inner subquery directly.
CREATE INDEX IF NOT EXISTS idx_work_queue_claim
  ON work_queue (domain, status, priority DESC, next_attempt_at)
  WHERE status IN ('pending','in_progress');

-- Org/status fan-out for the System Status surface (count-by-domain
-- and dead_letter inventory).
CREATE INDEX IF NOT EXISTS idx_work_queue_org_status
  ON work_queue (org_id, status);

-- Watchdog scan: in_progress rows whose locked_until has elapsed.
-- Partial index keeps it tiny (only the contended slice).
CREATE INDEX IF NOT EXISTS idx_work_queue_stale
  ON work_queue (locked_until)
  WHERE status = 'in_progress';

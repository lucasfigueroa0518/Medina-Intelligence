-- Phase 0 — upstream_budget_ledger: unified rate-limit + circuit-breaker
-- ledger for every external API the system talks to.
--
-- Today the project has five separate KV-backed rate-limit modules in
-- src/lib/rate-limit.ts (Claude, Gemini, Enrichment, Graph, embed slot).
-- Each has its own key shape, its own TTL, its own logic. None of them
-- track:
--   - per-user buckets (Firefly, Graph need this — quotas are per-user)
--   - circuit-breaker state (consecutive 429s → temp halt of all calls)
--   - durable cap (KV is TTL-bound; the 429-history is lost on TTL expiry)
--   - auto-tune-down (we should LOWER the cap when we see real 429s, never
--                    higher than the configured default)
--
-- This ledger replaces them with a single, queryable source of truth.
-- Phase 0 ADDS it; Phase 1+ migrates each existing rate-limit caller in.
-- The KV-backed functions stay as-is until their caller is migrated.
--
-- Per-user-or-org granularity: the user_id column is NOT NULL with a '*'
-- sentinel for org-wide budgets. Avoids NULL-in-PK quirks in SQLite while
-- keeping the per-user case clean. Caller-facing helpers accept `null`
-- for the user_id parameter and translate to '*'.
--
-- Auto-tune invariant (Lucas's hard rule, 2026-05-03):
--   The system NEVER raises a cap automatically. Caps may only be lowered
--   in response to evidence (consecutive 429s). The configured default
--   from the helper module is the ceiling; the ledger's `cap` column is a
--   floor that drifts down over time. To raise a cap, an operator must
--   manually update both the helper default AND any lowered ledger row.
--   This is intentional — auto-raising a cap that previously hit limits
--   would mask whether the upstream is actually healthier or whether
--   we're just about to hit limits again.
--
-- Window rollover semantics (encoded in the recordUsage helper):
--   Each bucket_window has a fixed length (daily=24h, hourly=1h,
--   ten_minute=10min, minute=1min, per_second=1s). When recordUsage fires
--   and `bucket_start` is older than the current window, the row is
--   atomically reset (`used=units, bucket_start=now`) instead of
--   incremented. Single UPSERT, no race.
--
-- Circuit breaker:
--   3 consecutive 429s within a window → cap drops by 10% (min cap=1) AND
--   circuit_open_until = now + 30 min. While circuit is open, checkBudget
--   returns 'circuit_open' for ALL calls to that upstream regardless of
--   used/cap. recordUsage on success resets consecutive_429s to 0 and
--   leaves the (now-lowered) cap in place.

CREATE TABLE IF NOT EXISTS upstream_budget_ledger (
  org_id TEXT NOT NULL,
  -- '*' sentinel for org-wide buckets (Anthropic, BGE, Gemini, Slack).
  -- Real user_id for per-user buckets (Firefly, Graph).
  user_id TEXT NOT NULL DEFAULT '*',
  upstream TEXT NOT NULL,
  bucket_window TEXT NOT NULL
    CHECK (bucket_window IN ('per_second', 'minute', 'ten_minute', 'hourly', 'daily')),
  -- ISO timestamp marking the start of the current accounting window.
  bucket_start TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  -- The current cap. Starts at the configured default; auto-tune lowers
  -- it on 429s; never auto-raised.
  cap INTEGER NOT NULL,
  last_429_at TEXT,
  -- Counter of consecutive 429s without an intervening successful call.
  -- Reset to 0 by recordUsage on success.
  consecutive_429s INTEGER NOT NULL DEFAULT 0,
  -- ISO timestamp; while in the future, all calls are refused with
  -- 'circuit_open'. NULL = circuit closed.
  circuit_open_until TEXT,
  -- Audit trail for cap-lowering events. cap_lowered_count is monotonic.
  cap_lowered_at TEXT,
  cap_lowered_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, user_id, upstream, bucket_window)
);

-- Sweep query: "any circuits open right now?" — used by System Status.
CREATE INDEX IF NOT EXISTS idx_budget_circuit_open
  ON upstream_budget_ledger(circuit_open_until)
  WHERE circuit_open_until IS NOT NULL;

-- Read query: per-org snapshot ordered by upstream.
CREATE INDEX IF NOT EXISTS idx_budget_org_upstream
  ON upstream_budget_ledger(org_id, upstream, bucket_window);

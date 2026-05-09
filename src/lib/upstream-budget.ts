// Phase 0 — upstream_budget_ledger helpers.
//
// One ledger, all upstreams. Replaces (eventually) the five fragmented
// rate-limit modules in src/lib/rate-limit.ts. Phase 0 adds the helpers
// without migrating existing callers; Phase 1+ migrates them one upstream
// at a time.
//
// Standing properties enforced here:
//   • Rate-limit awareness — every external call routes through checkBudget
//                            before hitting the wire.
//   • Circuit breakers     — 3 consecutive 429s opens a 30-min circuit;
//                            checkBudget returns 'circuit_open' regardless
//                            of cap utilization.
//   • Auto-tune DOWN ONLY  — caps lower by 10% on circuit trip; never
//                            raised by the system. (Lucas's hard rule
//                            2026-05-03; see migration 0079.)
//   • Atomicity            — every write is a single SQL statement with
//                            ON CONFLICT for window rollover; no
//                            check-then-write race.
//   • Observability        — every row queryable from System Status.

import type { Env } from '../types/env';

export type Upstream =
  | 'firefly'
  | 'graph'
  | 'anthropic_haiku'
  | 'anthropic_sonnet'
  | 'claude'
  | 'bge'
  | 'gemini'
  | 'gemini_web_search'
  | 'slack'
  | 'cloudflare_api';

export type BudgetWindow = 'per_second' | 'minute' | 'ten_minute' | 'hourly' | 'daily';

const WINDOW_LENGTH_MS: Record<BudgetWindow, number> = {
  per_second: 1_000,
  minute: 60_000,
  ten_minute: 600_000,
  hourly: 3_600_000,
  daily: 86_400_000,
};

/** Default seed caps. The ledger's `cap` column is initialized from this
 *  table on first use of a (org, user, upstream, window) tuple. Auto-tune
 *  may LOWER the row's cap from this seed; never raise it. To raise a cap,
 *  an operator must update both this map AND any rows already lowered.
 *
 *  Sources of these numbers:
 *  - firefly.daily 118: inferred from Tony 2026-04-30 backfill (124
 *    transcripts processed before 429 fired) − 6 buffer per Lucas's rule.
 *  - graph.ten_minute 8000: matches existing GRAPH_SOFT_LIMIT in
 *    src/lib/rate-limit.ts (80% of Microsoft's 10K / 10-min ceiling).
 *  - anthropic_*.minute: conservative Tier-4 buffers.
 *  - bge.per_second 10: matches existing acquireEmbedSlot config.
 *  - gemini.minute 500: matches GEMINI_MAX_RPM in wrangler.toml. */
const DEFAULT_CAPS: Partial<Record<Upstream, Partial<Record<BudgetWindow, number>>>> = {
  firefly: { daily: 118 },
  graph: { ten_minute: 8000 },
  anthropic_haiku: { minute: 50 },
  anthropic_sonnet: { minute: 30 },
  // claude.minute 60: matches the existing CLAUDE_MAX_RPM default in
  // src/lib/rate-limit.ts (line 28). Phase 3.3 (2026-05-04) routes
  // checkClaudeRateLimit through this entry. Distinct from
  // anthropic_haiku/anthropic_sonnet which are per-model granular
  // entries reserved for future model-specific gating; the existing
  // callClaude wrapper does not differentiate by model so it shares
  // one bucket here.
  claude: { minute: 60 },
  bge: { per_second: 10 },
  gemini: { minute: 500 },
  // MARTy chat web search uses Gemini grounding, but it must not share a
  // circuit with background enrichment/news/LinkedIn jobs. Keeping a separate
  // budget prevents noisy crawlers from making user-triggered search look
  // "rate limited" for hours.
  gemini_web_search: { minute: 60 },
  slack: { minute: 50 },
  // cloudflare_api.minute 200: CF's published platform limit is 1200
  // requests / 5 minutes globally per account. We cap at 200/min as a
  // conservative ceiling — the workflow-state reconciler sweeps ≤50
  // rows/tick × 1 GET each = ≤50 calls/tick (hourly), so this is ~4x
  // headroom. Any other consumer (future System Status route, manual
  // diagnostic) shares the same bucket since CF's limit is account-wide.
  cloudflare_api: { minute: 200 },
};

/** 30-minute circuit-open duration when 3 consecutive 429s trigger the
 *  breaker. Long enough to ride out a real upstream outage; short enough
 *  that operator-free recovery happens within an hour. */
const CIRCUIT_OPEN_MS = 30 * 60 * 1_000;

/** A circuit should never be open for days. If old rows or clock drift leave
 *  a far-future circuit_open_until, self-heal on the next read. */
const MAX_VALID_CIRCUIT_OPEN_MS = 2 * 60 * 60 * 1_000;

/** Number of consecutive 429s required to trip the circuit + lower the
 *  cap. Counter resets to 0 on any successful recordUsage. */
const CIRCUIT_TRIP_THRESHOLD = 3;

/** Cap-lowering ratio. On trip, new cap = max(1, floor(old cap * (1 -
 *  CAP_DECAY_RATIO))). 10% drift means a cap that's chronically wrong
 *  decays to a sane floor over a handful of trip events. */
const CAP_DECAY_RATIO = 0.10;

/** Internal: '*' sentinel translates a null user_id to a column-safe
 *  string for the org-wide bucket. The ledger's user_id column is NOT
 *  NULL DEFAULT '*' precisely so the PK doesn't have to deal with NULLs. */
const ORG_WIDE_USER = '*';

function userKey(userId: string | null | undefined): string {
  return userId ?? ORG_WIDE_USER;
}

function defaultCapFor(upstream: Upstream, window: BudgetWindow): number {
  const cap = DEFAULT_CAPS[upstream]?.[window];
  if (typeof cap !== 'number' || cap <= 0) {
    // Unknown upstream/window combo — fall back to a permissive but
    // observable cap. The intent is that callers always pass a configured
    // pair; an unknown combo is a code-config bug, not a runtime emergency.
    console.warn(`[upstream-budget] no default cap for ${upstream}.${window}, using 1000`);
    return 1000;
  }
  return cap;
}

export interface BudgetCheckResult {
  decision: 'ok' | 'over_cap' | 'circuit_open';
  used: number;
  cap: number;
  /** Effective remaining = max(0, cap − used). Useful for "headroom" UIs. */
  remaining: number;
  /** ISO of when the current bucket window ends. */
  window_ends_at: string;
  /** Set when decision === 'circuit_open'. */
  circuit_open_until?: string | null;
}

interface RawLedgerRow {
  org_id: string;
  user_id: string;
  upstream: string;
  bucket_window: string;
  bucket_start: string;
  used: number;
  cap: number;
  last_429_at: string | null;
  consecutive_429s: number;
  circuit_open_until: string | null;
  cap_lowered_at: string | null;
  cap_lowered_count: number;
  updated_at: string;
}

/** Check whether a call would be allowed RIGHT NOW. Read-only; does not
 *  reserve budget. Caller must follow with recordUsage on success or
 *  recordRateLimit on 429. The slight check-then-record race is bounded
 *  (next recordUsage either rolls over the window or increments cleanly). */
export async function checkBudget(
  env: Env,
  orgId: string,
  userId: string | null | undefined,
  upstream: Upstream,
  window: BudgetWindow,
  units = 1
): Promise<BudgetCheckResult> {
  const uid = userKey(userId);
  const row = await env.D1.prepare(
    `SELECT org_id, user_id, upstream, bucket_window, bucket_start, used, cap,
            last_429_at, consecutive_429s, circuit_open_until,
            cap_lowered_at, cap_lowered_count, updated_at
       FROM upstream_budget_ledger
      WHERE org_id = ? AND user_id = ? AND upstream = ? AND bucket_window = ?`
  ).bind(orgId, uid, upstream, window).first<RawLedgerRow>();

  const now = Date.now();
  const windowMs = WINDOW_LENGTH_MS[window];
  const cap = row?.cap ?? defaultCapFor(upstream, window);

  // Circuit check first — when open, deny regardless of cap utilization.
  if (row?.circuit_open_until) {
    const openUntilMs = Date.parse(row.circuit_open_until);
    if (Number.isFinite(openUntilMs) && openUntilMs - now > MAX_VALID_CIRCUIT_OPEN_MS) {
      console.warn(
        `[upstream-budget] clearing stale ${upstream}.${window} circuit for org=${orgId} user=${uid}; ` +
        `open_until=${row.circuit_open_until}`
      );
      await env.D1.prepare(
        `UPDATE upstream_budget_ledger
            SET circuit_open_until = NULL,
                consecutive_429s = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE org_id = ? AND user_id = ? AND upstream = ? AND bucket_window = ?`
      ).bind(orgId, uid, upstream, window).run();
    } else if (Number.isFinite(openUntilMs) && openUntilMs <= now) {
      await env.D1.prepare(
        `UPDATE upstream_budget_ledger
            SET circuit_open_until = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE org_id = ? AND user_id = ? AND upstream = ? AND bucket_window = ?`
      ).bind(orgId, uid, upstream, window).run();
    }
    if (
      Number.isFinite(openUntilMs) &&
      openUntilMs > now &&
      openUntilMs - now <= MAX_VALID_CIRCUIT_OPEN_MS
    ) {
      return {
        decision: 'circuit_open',
        used: row.used,
        cap,
        remaining: Math.max(0, cap - row.used),
        window_ends_at: new Date(Date.parse(row.bucket_start) + windowMs).toISOString(),
        circuit_open_until: row.circuit_open_until,
      };
    }
  }

  // Treat the row as fresh (used = 0) when bucket_start is older than
  // the window. recordUsage will atomically reset on next write.
  let effectiveUsed = 0;
  let effectiveBucketStart: number = now;
  if (row) {
    const startMs = Date.parse(row.bucket_start);
    if (Number.isFinite(startMs) && now - startMs < windowMs) {
      effectiveUsed = row.used;
      effectiveBucketStart = startMs;
    }
  }

  if (effectiveUsed + units > cap) {
    return {
      decision: 'over_cap',
      used: effectiveUsed,
      cap,
      remaining: Math.max(0, cap - effectiveUsed),
      window_ends_at: new Date(effectiveBucketStart + windowMs).toISOString(),
      circuit_open_until: row?.circuit_open_until ?? null,
    };
  }

  return {
    decision: 'ok',
    used: effectiveUsed,
    cap,
    remaining: Math.max(0, cap - effectiveUsed),
    window_ends_at: new Date(effectiveBucketStart + windowMs).toISOString(),
    circuit_open_until: null,
  };
}

/** Record a SUCCESSFUL upstream call (resets consecutive_429s, increments
 *  used, rolls over the window if expired). Atomic single-statement write. */
export async function recordUsage(
  env: Env,
  orgId: string,
  userId: string | null | undefined,
  upstream: Upstream,
  window: BudgetWindow,
  units = 1
): Promise<void> {
  const uid = userKey(userId);
  const cap = defaultCapFor(upstream, window);
  const windowMs = WINDOW_LENGTH_MS[window];
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const rolloverThresholdIso = new Date(now - windowMs).toISOString();

  // Atomic UPSERT with conditional rollover. SQLite evaluates ALL CASE
  // expressions against the pre-UPDATE row state (consistent reads), so
  // the three CASEs below see the same `bucket_start` value.
  await env.D1.prepare(
    `INSERT INTO upstream_budget_ledger
       (org_id, user_id, upstream, bucket_window, bucket_start, used, cap, consecutive_429s, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (org_id, user_id, upstream, bucket_window) DO UPDATE SET
       used = CASE
         WHEN bucket_start < ? THEN ?         -- window rolled: reset to units
         ELSE used + ?
       END,
       bucket_start = CASE
         WHEN bucket_start < ? THEN ?         -- window rolled: bump bucket_start
         ELSE bucket_start
       END,
       consecutive_429s = 0,                  -- success ALWAYS resets the breaker counter
       updated_at = ?`
  ).bind(
    // INSERT values
    orgId, uid, upstream, window, nowIso, units, cap, nowIso,
    // UPDATE: used = CASE WHEN bucket_start < ? THEN ? ELSE used + ? END
    rolloverThresholdIso, units, units,
    // UPDATE: bucket_start = CASE WHEN bucket_start < ? THEN ? ELSE bucket_start END
    rolloverThresholdIso, nowIso,
    // UPDATE: updated_at
    nowIso
  ).run();
}

/** Record a RATE-LIMIT response (HTTP 429 or upstream-equivalent). On the
 *  CIRCUIT_TRIP_THRESHOLD-th consecutive 429, lowers cap by CAP_DECAY_RATIO
 *  and opens the circuit for CIRCUIT_OPEN_MS.
 *
 *  Auto-tune DOWN ONLY: this helper NEVER raises the cap. The default cap
 *  from DEFAULT_CAPS is the ceiling; the row's `cap` column drifts down. */
export async function recordRateLimit(
  env: Env,
  orgId: string,
  userId: string | null | undefined,
  upstream: Upstream,
  window: BudgetWindow
): Promise<void> {
  const uid = userKey(userId);
  const seedCap = defaultCapFor(upstream, window);
  const nowIso = new Date().toISOString();
  const circuitOpenUntilIso = new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString();
  const decayMultiplier = 1 - CAP_DECAY_RATIO;

  // Atomic UPSERT. The CASE branches encode the auto-tune-down rule:
  //   - Below threshold: just bump consecutive_429s, leave cap alone.
  //   - At threshold:   lower cap, open circuit, reset counter to 0.
  // SQLite reads pre-UPDATE values for ALL CASE expressions, so the
  // (consecutive_429s + 1 >= threshold) checks are consistent.
  await env.D1.prepare(
    `INSERT INTO upstream_budget_ledger
       (org_id, user_id, upstream, bucket_window, bucket_start, used, cap,
        last_429_at, consecutive_429s, circuit_open_until, cap_lowered_at,
        cap_lowered_count, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, NULL, NULL, 0, ?)
     ON CONFLICT (org_id, user_id, upstream, bucket_window) DO UPDATE SET
       last_429_at = ?,
       cap = CASE
         WHEN consecutive_429s + 1 >= ?
           THEN MAX(1, CAST(cap * ? AS INTEGER))
         ELSE cap
       END,
       cap_lowered_at = CASE
         WHEN consecutive_429s + 1 >= ?
           THEN ?
         ELSE cap_lowered_at
       END,
       cap_lowered_count = CASE
         WHEN consecutive_429s + 1 >= ?
           THEN cap_lowered_count + 1
         ELSE cap_lowered_count
       END,
       circuit_open_until = CASE
         WHEN consecutive_429s + 1 >= ?
           THEN ?
         ELSE circuit_open_until
       END,
       consecutive_429s = CASE
         WHEN consecutive_429s + 1 >= ?
           THEN 0                              -- reset after tripping
         ELSE consecutive_429s + 1
       END,
       updated_at = ?`
  ).bind(
    // INSERT values (first observation of this bucket — 429 with no prior usage)
    orgId, uid, upstream, window, nowIso, seedCap, nowIso, nowIso,
    // UPDATE: last_429_at
    nowIso,
    // UPDATE: cap CASE
    CIRCUIT_TRIP_THRESHOLD, decayMultiplier,
    // UPDATE: cap_lowered_at CASE
    CIRCUIT_TRIP_THRESHOLD, nowIso,
    // UPDATE: cap_lowered_count CASE
    CIRCUIT_TRIP_THRESHOLD,
    // UPDATE: circuit_open_until CASE
    CIRCUIT_TRIP_THRESHOLD, circuitOpenUntilIso,
    // UPDATE: consecutive_429s CASE
    CIRCUIT_TRIP_THRESHOLD,
    // UPDATE: updated_at
    nowIso
  ).run();
}

/** Read the configured default cap for a (upstream, window) pair without
 *  hitting the database. Useful for diagnostics and tests. */
export function getDefaultCap(upstream: Upstream, window: BudgetWindow): number {
  return defaultCapFor(upstream, window);
}

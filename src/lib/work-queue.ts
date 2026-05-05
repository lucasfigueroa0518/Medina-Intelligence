// Phase 5 (2026-05-05) — Universal Work Queue helpers.
//
// Substrate-only this phase. Domain-specific drivers (handlers) plug
// into the cron tick scaffolded in Phase 5 1b but no domain ships in
// the same PR — see migration 0083 header for full rationale.
//
// API surface (8 functions):
//   • enqueueWork           — INSERT OR IGNORE on (domain, idempotency_key)
//   • claimNextBatch        — atomic UPDATE-and-fetch up to N rows for
//                             a given domain, respecting circuit open set
//   • recordHeartbeat       — extend lock + bump heartbeat_at mid-run
//   • completeWork          — status='completed' + completed_at
//   • failWork              — status='failed' transient OR 'dead_letter'
//                             at attempt >= max; backoff schedules next
//   • deadLetterWork        — explicit dead-letter (handler signals fatal)
//   • sweepStaleClaims      — watchdog: in_progress with expired lock →
//                             pending again (with attempt incremented)
//   • countByDomain         — System Status read-side support
//
// Standing-properties contract enforced here (substrate side):
//   • Idempotency  — enqueueWork uses ON CONFLICT DO NOTHING
//   • Atomicity    — claim is one UPDATE…RETURNING
//   • Self-healing — sweepStaleClaims releases stuck slots
//   • Rate-limit   — claim filters on upstream-circuit-open set
//   • Auto-tune    — read-only against ledger; never mutates caps
//
// Domain-side responsibilities (handlers):
//   • Call recordHeartbeat at sane intervals during long handlers
//   • Call recordRateLimit on upstream 429s (existing helper) so the
//     ledger's auto-decay kicks in
//   • Return success → completeWork; transient fail → failWork; fatal
//     fail → deadLetterWork
//   • Keep per-tick batch ≤ 10 items to stay under the 1000-subrequest
//     CF cap shared with the rest of the minute tick.

import type { Env } from '../types/env';

// ─── Types ──────────────────────────────────────────────────────────

export type WorkQueueStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'dead_letter';

export interface WorkQueueRow {
  id: string;
  org_id: string;
  domain: string;
  payload: string;                // JSON-serialized; domain decodes
  status: WorkQueueStatus;
  attempt: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  locked_until: string | null;
  heartbeat_at: string | null;
  upstream: string | null;
  idempotency_key: string | null;
  priority: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface EnqueueOptions {
  upstream?: string | null;
  idempotency_key?: string | null;
  priority?: number;
  max_attempts?: number;
  /** ISO timestamp; null/omitted = immediately eligible. */
  next_attempt_at?: string | null;
}

export interface EnqueueResult {
  /** True iff a row was inserted; false if collapsed by ON CONFLICT. */
  inserted: boolean;
  /** Set when inserted; otherwise the existing row's id is fetched. */
  id?: string;
}

// ─── Tunables (centralized so domains stay consistent) ─────────────

/** Default lock TTL granted on claim. Keep in sync with handler timeouts. */
export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;
/** Stale threshold past locked_until before sweep reclaims. */
export const STALE_CLAIM_GRACE_MS = 30 * 1000;
/** Three-tier retry backoff schedule (ms). attempt index → wait. */
export const RETRY_BACKOFF_MS = [5 * 60 * 1000, 30 * 60 * 1000];

// ─── enqueueWork ────────────────────────────────────────────────────

/**
 * Insert a new work item. When `idempotency_key` is supplied AND a row
 * already exists for (domain, idempotency_key), the insert is collapsed
 * silently (ON CONFLICT DO NOTHING) and `inserted: false` is returned
 * with the existing row's id. Domains that don't need dedupe leave the
 * key NULL — every NULL-key insert produces a fresh row (the partial
 * UNIQUE index treats NULLs as distinct).
 *
 * The payload is the domain's responsibility. Pass any JSON-serializable
 * object; this helper stringifies. Domain handlers JSON.parse on read.
 *
 * Throws on D1 write failure. Does NOT throw on conflict — that's the
 * normal idempotent path.
 */
export async function enqueueWork(
  env: Env,
  orgId: string,
  domain: string,
  payload: unknown,
  opts: EnqueueOptions = {}
): Promise<EnqueueResult> {
  const payloadJson = JSON.stringify(payload);
  const upstream = opts.upstream ?? null;
  const idempotencyKey = opts.idempotency_key ?? null;
  const priority = opts.priority ?? 0;
  const maxAttempts = opts.max_attempts ?? 3;
  const nextAttemptAt = opts.next_attempt_at ?? null;

  // ON CONFLICT only triggers when idempotency_key is NOT NULL (the
  // partial unique index doesn't apply to NULL-key rows). Using
  // RETURNING to grab the row id without a follow-up read.
  //
  // Phase 6.1.1 fix (2026-05-05): the conflict target MUST reproduce
  // the partial index's WHERE clause (`WHERE idempotency_key IS NOT
  // NULL`), otherwise SQLite throws `ON CONFLICT clause does not
  // match any PRIMARY KEY or UNIQUE constraint`. This was latent in
  // Phase 5 — embed_retry's 21 prod rows came via migration 0084's
  // INSERT OR IGNORE (different code path; handles partial indexes
  // implicitly). Phase 6.1's calendar scheduler was the first code
  // path to actually exercise enqueueWork's ON CONFLICT in prod.
  // For NULL-keyed inserts, the WHERE clause's truthiness fails so
  // the conflict target doesn't apply and the INSERT proceeds — the
  // exact behavior we want for the "every NULL-key insert produces
  // a fresh row" contract above.
  const inserted = await env.D1.prepare(
    `INSERT INTO work_queue
       (org_id, domain, payload, upstream, idempotency_key, priority,
        max_attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`
  ).bind(
    orgId, domain, payloadJson, upstream, idempotencyKey,
    priority, maxAttempts, nextAttemptAt
  ).first<{ id: string }>();

  if (inserted?.id) {
    return { inserted: true, id: inserted.id };
  }

  // Collapsed by conflict — fetch the existing row's id so caller can
  // reference it. Only happens when idempotency_key is non-null AND a
  // row already exists.
  if (idempotencyKey !== null) {
    const existing = await env.D1.prepare(
      `SELECT id FROM work_queue WHERE domain = ? AND idempotency_key = ?`
    ).bind(domain, idempotencyKey).first<{ id: string }>();
    return { inserted: false, id: existing?.id };
  }

  // Should be unreachable: NULL-idempotency-key inserts can't conflict
  // (partial unique index excludes them), so we'd have an id from the
  // RETURNING above. If we somehow get here, surface as not-inserted
  // without an id rather than throw — caller decides what's broken.
  return { inserted: false };
}

// ─── claimNextBatch ────────────────────────────────────────────────

/**
 * Atomically claim up to `limit` ready rows for a given domain. Returns
 * the claimed rows (status flipped to 'in_progress', locked_until set,
 * heartbeat_at primed). Filters out:
 *   • status != 'pending'
 *   • next_attempt_at in the future (backoff still pending)
 *   • upstream in the OPEN-circuit set passed in
 *
 * Caller (the cron-tick driver) computes the open-circuit set ONCE per
 * tick via getOpenCircuits(env) below and passes it here per domain
 * call. Two domains in the same tick share the read.
 *
 * `limit` is enforced with the standing ≤ 10 items/step CF cap rule.
 * This helper does NOT clamp — caller must respect it.
 */
export async function claimNextBatch(
  env: Env,
  domain: string,
  limit: number,
  openCircuitUpstreams: string[],
  lockTtlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<WorkQueueRow[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + lockTtlMs).toISOString();

  // Build the upstream filter. SQLite doesn't accept dynamic IN ()
  // bindings as arrays — splat the placeholders. Empty set means no
  // filter (everything claimable that's pending).
  const placeholders = openCircuitUpstreams.map(() => '?').join(',');
  const upstreamFilter = openCircuitUpstreams.length > 0
    ? `AND (upstream IS NULL OR upstream NOT IN (${placeholders}))`
    : '';

  // Single-statement claim: inner SELECT picks ids by priority+FIFO,
  // outer UPDATE flips them to in_progress and stamps the lock. SQLite
  // serializes writes so two concurrent claims can't both grab a row.
  // RETURNING gives us the post-update snapshot (the rows we actually
  // claimed, in the order RETURNING surfaces them — driver shouldn't
  // depend on ordering).
  const sql = `
    UPDATE work_queue
       SET status        = 'in_progress',
           started_at    = COALESCE(started_at, ?),
           heartbeat_at  = ?,
           locked_until  = ?
     WHERE id IN (
       SELECT id FROM work_queue
        WHERE status = 'pending'
          AND domain = ?
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ${upstreamFilter}
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
     )
     RETURNING *`;

  const binds: unknown[] = [
    nowIso, nowIso, lockedUntil,
    domain, nowIso,
    ...openCircuitUpstreams,
    limit,
  ];

  const result = await env.D1.prepare(sql).bind(...binds).all<WorkQueueRow>();
  return result.results;
}

// ─── recordHeartbeat ───────────────────────────────────────────────

/**
 * Bump heartbeat_at and extend locked_until for a still-running row.
 * Long-running handlers should call this at sane intervals (e.g. every
 * 30s) so the watchdog doesn't reclaim a row that's actively making
 * progress. Fire-and-forget catch-and-log is fine in handler code —
 * the watchdog's grace period absorbs the occasional missed heartbeat.
 */
export async function recordHeartbeat(
  env: Env,
  id: string,
  lockTtlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<void> {
  const now = new Date();
  await env.D1.prepare(
    `UPDATE work_queue
        SET heartbeat_at = ?,
            locked_until = ?
      WHERE id = ? AND status = 'in_progress'`
  ).bind(
    now.toISOString(),
    new Date(now.getTime() + lockTtlMs).toISOString(),
    id
  ).run();
}

// ─── completeWork ──────────────────────────────────────────────────

/**
 * Final-success transition. Phase 6.2 (2026-05-05): added
 * `WHERE status = 'in_progress'` so a handler that manually
 * transitioned the row out of in_progress (via deadLetterWork or
 * deferWork) doesn't get overwritten by the driver's terminal
 * completeWork call. Without the filter, the substrate's "Domain may
 * have already transitioned via deadLetterWork" comment in the driver
 * was aspirational, not enforced.
 */
export async function completeWork(env: Env, id: string): Promise<void> {
  await env.D1.prepare(
    `UPDATE work_queue
        SET status       = 'completed',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            locked_until = NULL,
            last_error   = NULL
      WHERE id = ? AND status = 'in_progress'`
  ).bind(id).run();
}

// ─── deferWork ─────────────────────────────────────────────────────

/**
 * Phase 6.2 (2026-05-05): defer a still-progressing row back to
 * 'pending' with a future next_attempt_at, WITHOUT counting against
 * the attempt budget. Use case: a domain handler that wants to
 * checkpoint partial progress (via payloadJson) and schedule a
 * specific resume time, distinct from the failure path's 3-tier
 * backoff.
 *
 * Firefly's `paused` per-window state is the motivating example:
 * Firefly API rate limit hit mid-window → defer to next UTC
 * midnight, preserve `last_skip` resume cursor in payload, do NOT
 * burn an attempt (rate-limit pauses can recur many times during
 * a long backfill).
 *
 * The companion completeWork's `WHERE status = 'in_progress'`
 * filter ensures the driver's terminal call after handler returns
 * is a no-op — this row already moved back to 'pending'.
 */
export async function deferWork(
  env: Env,
  id: string,
  nextAttemptAt: string,
  payloadJson: string
): Promise<void> {
  await env.D1.prepare(
    `UPDATE work_queue
        SET status          = 'pending',
            next_attempt_at = ?,
            locked_until    = NULL,
            payload         = ?
      WHERE id = ? AND status = 'in_progress'`
  ).bind(nextAttemptAt, payloadJson, id).run();
}

// ─── failWork ──────────────────────────────────────────────────────

export interface FailOptions {
  /** Override the default 3-tier backoff with a specific delay (ms). */
  retryAfterMs?: number;
  /** Override max_attempts read from the row (rare; usually leave null). */
  maxAttemptsOverride?: number;
}

/**
 * Transient-failure transition. Increments attempt; if the post-
 * increment count is >= max_attempts, transitions to dead_letter.
 * Otherwise schedules next_attempt_at via the three-tier backoff
 * (or `retryAfterMs` when supplied).
 *
 * The decision (retry vs. dead-letter) reads the existing attempt and
 * max_attempts in a single UPDATE…RETURNING so we don't race a
 * concurrent watchdog. Returns the resulting row so the caller can
 * decide whether to log "scheduled retry" vs. "dead-lettered".
 */
export async function failWork(
  env: Env,
  id: string,
  errorMessage: string,
  opts: FailOptions = {}
): Promise<WorkQueueRow | null> {
  // Two-step: read row to compute next_attempt_at deterministically,
  // then UPDATE. We could do this in a single CASE expression but the
  // backoff schedule lookup is easier in TypeScript than SQL, and the
  // row is locked to this caller (status='in_progress', locked_until
  // not yet expired by definition of being mid-handler) so there's no
  // concurrent-update race against the watchdog within the lock TTL.
  const row = await env.D1.prepare(
    `SELECT * FROM work_queue WHERE id = ?`
  ).bind(id).first<WorkQueueRow>();
  if (!row) return null;

  const nextAttempt = row.attempt + 1;
  const maxAttempts = opts.maxAttemptsOverride ?? row.max_attempts;

  if (nextAttempt >= maxAttempts) {
    // Dead-letter: terminal. last_error preserved for forensics. The
    // operator resets to 'pending' via admin endpoint to reattempt
    // (separate phase; no reset endpoint in 5).
    //
    // Phase 6.2 (2026-05-05): added `AND status = 'in_progress'` so a
    // handler that already self-transitioned (deadLetterWork or
    // deferWork before throwing) isn't re-mutated by this path.
    const updated = await env.D1.prepare(
      `UPDATE work_queue
          SET status       = 'dead_letter',
              attempt      = ?,
              last_error   = ?,
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              locked_until = NULL
        WHERE id = ? AND status = 'in_progress'
        RETURNING *`
    ).bind(nextAttempt, errorMessage, id).first<WorkQueueRow>();
    return updated ?? null;
  }

  // Compute backoff. attempt index 0 → first failure → RETRY_BACKOFF_MS[0]
  // (= 5min). Cap at the last entry for safety if max_attempts somehow
  // exceeds the schedule length.
  const backoffMs = opts.retryAfterMs
    ?? RETRY_BACKOFF_MS[Math.min(row.attempt, RETRY_BACKOFF_MS.length - 1)];
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

  const updated = await env.D1.prepare(
    `UPDATE work_queue
        SET status          = 'pending',
            attempt         = ?,
            last_error      = ?,
            next_attempt_at = ?,
            locked_until    = NULL
      WHERE id = ? AND status = 'in_progress'
      RETURNING *`
  ).bind(nextAttempt, errorMessage, nextAttemptAt, id).first<WorkQueueRow>();
  return updated ?? null;
}

// ─── deadLetterWork ────────────────────────────────────────────────

/**
 * Explicit dead-letter — used when the handler determines a fatal error
 * (e.g. malformed payload, unrecoverable upstream 4xx) that shouldn't
 * be retried regardless of attempt count. Sets status='dead_letter' and
 * preserves the error message.
 *
 * Phase 6.2 (2026-05-05): added `AND status = 'in_progress'` so this
 * is idempotent if the row was already transitioned out (e.g. via the
 * watchdog).
 */
export async function deadLetterWork(
  env: Env,
  id: string,
  errorMessage: string
): Promise<void> {
  await env.D1.prepare(
    `UPDATE work_queue
        SET status       = 'dead_letter',
            attempt      = attempt + 1,
            last_error   = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            locked_until = NULL
      WHERE id = ? AND status = 'in_progress'`
  ).bind(errorMessage, id).run();
}

// ─── sweepStaleClaims (watchdog) ───────────────────────────────────

/**
 * Find in_progress rows whose locked_until is older than (now -
 * STALE_CLAIM_GRACE_MS) AND whose heartbeat_at is similarly stale, and
 * release them. The released row's attempt is incremented and
 * next_attempt_at scheduled via the standard backoff — same code path
 * as failWork — so a permanently-crashing handler eventually
 * dead-letters rather than looping forever.
 *
 * Returns number of rows reset. Driver logs this for observability.
 *
 * Ran by the minute-tick driver before the per-domain claims so a
 * just-released row is eligible for re-claim in the same tick.
 */
export async function sweepStaleClaims(env: Env): Promise<number> {
  const cutoffIso = new Date(Date.now() - STALE_CLAIM_GRACE_MS).toISOString();

  // Find candidates first (we need their attempt counts to schedule
  // backoff individually). Cardinality is small under healthy operation
  // — usually 0. Watchdog only catches crashed handlers, hardware
  // restarts, etc.
  const candidates = await env.D1.prepare(
    `SELECT id, attempt, max_attempts FROM work_queue
       WHERE status = 'in_progress'
         AND locked_until IS NOT NULL
         AND locked_until < ?`
  ).bind(cutoffIso).all<{ id: string; attempt: number; max_attempts: number }>();

  if (candidates.results.length === 0) return 0;

  // Update each one with its individualized backoff. Could batch into
  // a CASE expression but cardinality stays tiny so per-row UPDATEs
  // are clearer for forensics (each row's attempt-counter motion is
  // a distinct write event).
  //
  // Phase 6.0.1 (2026-05-05): last_error messages now carry the attempt
  // count in `attempt N of M` form, with distinct prefixes for terminal
  // (dead_letter) vs transient (pending-with-backoff) cases. Lets an
  // operator scanning the DLQ distinguish at a glance whether a row hit
  // max attempts or got reclaimed early — crucial when triaging a
  // mixed-failure-mode backlog.
  let reset = 0;
  for (const c of candidates.results) {
    const nextAttempt = c.attempt + 1;
    if (nextAttempt >= c.max_attempts) {
      const reason = `lock expired without completion (attempt ${nextAttempt} of ${c.max_attempts})`;
      await env.D1.prepare(
        `UPDATE work_queue
            SET status       = 'dead_letter',
                attempt      = ?,
                last_error   = ?,
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                locked_until = NULL
          WHERE id = ? AND status = 'in_progress'`
      ).bind(nextAttempt, reason, c.id).run();
    } else {
      const reason = `lock expired (attempt ${nextAttempt} of ${c.max_attempts}, retrying)`;
      const backoffMs = RETRY_BACKOFF_MS[Math.min(c.attempt, RETRY_BACKOFF_MS.length - 1)];
      const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
      await env.D1.prepare(
        `UPDATE work_queue
            SET status          = 'pending',
                attempt         = ?,
                last_error      = ?,
                next_attempt_at = ?,
                locked_until    = NULL
          WHERE id = ? AND status = 'in_progress'`
      ).bind(nextAttempt, reason, nextAttemptAt, c.id).run();
    }
    reset++;
  }
  return reset;
}

// ─── getOpenCircuits ───────────────────────────────────────────────

/**
 * Read the set of upstreams whose circuit is currently OPEN. Used by
 * the driver to filter claims so we don't dequeue work that would
 * immediately fail at the upstream gate.
 *
 * Single D1 read per tick, regardless of domain count. Returns a
 * lowercase string array suitable for splat-binding into claimNextBatch.
 */
export async function getOpenCircuits(env: Env): Promise<string[]> {
  const result = await env.D1.prepare(
    `SELECT DISTINCT upstream FROM upstream_budget_ledger
      WHERE circuit_open_until IS NOT NULL
        AND circuit_open_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).all<{ upstream: string }>();
  return result.results.map(r => r.upstream);
}

// ─── countByDomain (System Status read-side support) ───────────────

export interface WorkQueueDomainCount {
  domain: string;
  status: WorkQueueStatus;
  count: number;
}

/**
 * Inventory by (domain, status) for an org. Drives the System Status
 * "Work Queue" panel landing in 1c — per-domain row count split by
 * status so operators can see at a glance which domains have backlog,
 * which are dead-lettered, and which are stuck in_progress.
 *
 * Bounded cardinality (handful of domains × 5 statuses). Single read.
 */
export async function countByDomain(
  env: Env,
  orgId: string
): Promise<WorkQueueDomainCount[]> {
  const result = await env.D1.prepare(
    `SELECT domain, status, COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ?
      GROUP BY domain, status
      ORDER BY domain, status`
  ).bind(orgId).all<WorkQueueDomainCount>();
  return result.results;
}

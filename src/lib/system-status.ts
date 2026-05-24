// Phase 0 — System Status read-side queries.
//
// Pure read functions over the observability tables (task_runs,
// upstream_budget_ledger, embed_retry_queue, sync_jobs). NO side effects.
// Designed to be called from a future System Status route handler with
// no further marshalling.
//
// Phase 0 ships these helpers; Phase 1+ adds the route + UI. Keeping them
// in their own module so the route is a thin pass-through later.
//
// Standing properties enforced here:
//   • Observability — single read surfaces every signal an operator
//                     would want without grepping logs.
//   • Self-healing  — getStuckTaskRuns is the watchdog input; the
//                     watchdog itself runs separately (Phase 1).

import type { Env } from '../types/env';
import { listFireflyKeyStatuses, type FireflyKeyStatus } from './firefly-credentials';
import { countByDomain, type WorkQueueDomainCount } from './work-queue';
import { listActiveIngestionIncidents, type IngestionIncident } from './ingestion-health';

// ─── Pipeline health ─────────────────────────────────────────────────────

export interface PipelineHealthRow {
  task_name: string;
  last_run_at: string | null;
  last_status: string | null;
  last_duration_ms: number | null;
  last_24h_runs: number;
  last_24h_success: number;
  last_24h_failed: number;
  last_24h_partial: number;
  last_24h_skipped: number;
  last_24h_items_processed: number;
  last_24h_items_failed: number;
}

/**
 * One row per distinct task_name seen in the org over the last 24h, plus
 * the most-recent run's status and timing. Drives the green/yellow/red
 * dot in the System Status header.
 */
export async function getPipelineHealth(
  env: Env,
  orgId: string
): Promise<PipelineHealthRow[]> {
  // Two-step: aggregate counts in 24h window, then enrich with the
  // most-recent run row. Single GROUP BY plus a LEFT JOIN against a
  // correlated MAX(started_at) is awkward in D1; two queries is cleaner
  // and the cardinality is small (≤ ~30 task_name values expected).
  const aggregates = await env.D1.prepare(
    `SELECT task_name,
            COUNT(*) AS last_24h_runs,
            SUM(CASE WHEN status = 'success'  THEN 1 ELSE 0 END) AS last_24h_success,
            SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS last_24h_failed,
            SUM(CASE WHEN status = 'partial'  THEN 1 ELSE 0 END) AS last_24h_partial,
            SUM(CASE WHEN status = 'skipped'  THEN 1 ELSE 0 END) AS last_24h_skipped,
            COALESCE(SUM(items_processed), 0) AS last_24h_items_processed,
            COALESCE(SUM(items_failed),    0) AS last_24h_items_failed
       FROM task_runs
      WHERE org_id = ?
        AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
      GROUP BY task_name
      ORDER BY task_name`
  ).bind(orgId).all<{
    task_name: string;
    last_24h_runs: number;
    last_24h_success: number;
    last_24h_failed: number;
    last_24h_partial: number;
    last_24h_skipped: number;
    last_24h_items_processed: number;
    last_24h_items_failed: number;
  }>();

  if (aggregates.results.length === 0) return [];

  // Per-task most-recent row. Use ORDER BY + LIMIT 1 per task; correlated
  // subqueries are slow in D1, so loop the small set.
  const rows: PipelineHealthRow[] = [];
  for (const a of aggregates.results) {
    const recent = await env.D1.prepare(
      `SELECT started_at, status, duration_ms
         FROM task_runs
        WHERE org_id = ? AND task_name = ?
        ORDER BY started_at DESC
        LIMIT 1`
    ).bind(orgId, a.task_name).first<{
      started_at: string;
      status: string;
      duration_ms: number | null;
    }>();
    rows.push({
      task_name: a.task_name,
      last_run_at: recent?.started_at ?? null,
      last_status: recent?.status ?? null,
      last_duration_ms: recent?.duration_ms ?? null,
      last_24h_runs: a.last_24h_runs,
      last_24h_success: a.last_24h_success,
      last_24h_failed: a.last_24h_failed,
      last_24h_partial: a.last_24h_partial,
      last_24h_skipped: a.last_24h_skipped,
      last_24h_items_processed: a.last_24h_items_processed,
      last_24h_items_failed: a.last_24h_items_failed,
    });
  }
  return rows;
}

// ─── Dead-letter inventory ───────────────────────────────────────────────

export interface DeadLetterRow {
  source: string;
  state: string;
  count: number;
  oldest: string | null;
  recent_error: string | null;
}

/**
 * Aggregates anything an operator should review:
 *   - task_runs in 'failed' status in the last 24h
 *   - work_queue rows in 'dead_letter' status (Phase 5 1b, 2026-05-05)
 *
 * Phase 6 1b (2026-05-05): the embed_retry_queue:failed_permanent branch
 * was REMOVED. The embed_retry domain migrated onto work_queue in Phase
 * 6 1a/1b — its dead-letter rows are now surfaced via the work_queue
 * branch below as `work_queue:embed_retry`. The embed_retry_queue table
 * + rows are preserved as a revert artifact (per Lucas 2026-05-05) but
 * no longer surfaced here to prevent double-counting against the
 * migrated work_queue rows.
 *
 * Phase 1 adds DLQ reads from `webhook-dlq` / `audit-log-dlq` (already
 * wired in wrangler.toml; they're CF Queues, not D1 — separate read API).
 */
export async function getDeadLetterItems(
  env: Env,
  orgId: string
): Promise<DeadLetterRow[]> {
  const rows: DeadLetterRow[] = [];

  // task_runs: failed in last 24h, grouped by task
  const tr = await env.D1.prepare(
    `SELECT task_name,
            COUNT(*) AS count,
            MIN(started_at) AS oldest,
            MAX(last_error) AS recent_error
       FROM task_runs
      WHERE org_id = ?
        AND status = 'failed'
        AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
      GROUP BY task_name
      ORDER BY count DESC`
  ).bind(orgId).all<{ task_name: string; count: number; oldest: string | null; recent_error: string | null }>();
  for (const r of tr.results) {
    rows.push({
      source: `task_runs:${r.task_name}`,
      state: 'failed_24h',
      count: r.count,
      oldest: r.oldest,
      recent_error: r.recent_error,
    });
  }

  // Phase 5 1b: work_queue dead-letter rows, grouped by domain. Surfaces
  // exhausted-retry items so an operator can investigate (last_error +
  // oldest entry timestamp) before deciding to reset to 'pending' for
  // re-attempt or hard-delete. No 24h window — dead-lettered rows
  // accumulate until explicitly cleared.
  const wq = await env.D1.prepare(
    `SELECT domain,
            COUNT(*) AS count,
            MIN(created_at) AS oldest,
            MAX(last_error) AS recent_error
       FROM work_queue
      WHERE org_id = ? AND status = 'dead_letter'
      GROUP BY domain
      ORDER BY count DESC`
  ).bind(orgId).all<{ domain: string; count: number; oldest: string | null; recent_error: string | null }>();
  for (const r of wq.results) {
    rows.push({
      source: `work_queue:${r.domain}`,
      state: 'dead_letter',
      count: r.count,
      oldest: r.oldest,
      recent_error: r.recent_error,
    });
  }

  return rows;
}

// ─── Stuck task watchdog input ───────────────────────────────────────────

export interface StuckTaskRunRow {
  id: string;
  org_id: string;
  task_name: string;
  started_at: string;
  heartbeat_at: string | null;
  /** Minutes since last activity (started_at if heartbeat_at NULL). */
  silent_for_minutes: number;
}

/**
 * Find task_runs in 'running' status whose heartbeat_at (or started_at if
 * never heartbeated) is older than `staleAfterMinutes` minutes ago. Input
 * for the watchdog reaper that flips them to 'failed' with a synthetic
 * error. Watchdog itself lands in Phase 1.
 */
export async function getStuckTaskRuns(
  env: Env,
  staleAfterMinutes = 10,
  limit = 100
): Promise<StuckTaskRunRow[]> {
  const cutoff = `-${staleAfterMinutes} minutes`;
  const result = await env.D1.prepare(
    `SELECT id, org_id, task_name, started_at, heartbeat_at,
            CAST((julianday('now') - julianday(COALESCE(heartbeat_at, started_at))) * 1440 AS INTEGER) AS silent_for_minutes
       FROM task_runs
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
      ORDER BY COALESCE(heartbeat_at, started_at) ASC
      LIMIT ?`
  ).bind(cutoff, limit).all<StuckTaskRunRow>();
  return result.results;
}

// ─── Stuck work_queue rows (Phase 5 1b) ─────────────────────────────────

export interface StuckWorkQueueRow {
  id: string;
  org_id: string;
  domain: string;
  started_at: string | null;
  heartbeat_at: string | null;
  /** Minutes since last heartbeat (or started_at if never heartbeated). */
  silent_for_minutes: number;
}

/**
 * Find work_queue rows in 'in_progress' status whose heartbeat_at (or
 * started_at if never heartbeated) is older than `staleAfterMinutes`
 * minutes ago. The work_queue's own watchdog (sweepStaleClaims) reclaims
 * these every minute-tick by resetting status to 'pending' OR flipping
 * to 'dead_letter' if attempt >= max_attempts; this read surfaces them
 * for operator visibility AHEAD of the sweep so genuinely-degraded
 * handlers don't disappear silently into the retry loop.
 *
 * Distinct from getStuckTaskRuns — task_runs is per-cron-task whereas
 * work_queue is per-item. Both surfaces matter; both are rendered in
 * the Settings UI as separate panels.
 */
export async function getStuckWorkQueueRows(
  env: Env,
  staleAfterMinutes = 10,
  limit = 100
): Promise<StuckWorkQueueRow[]> {
  const cutoff = `-${staleAfterMinutes} minutes`;
  const result = await env.D1.prepare(
    `SELECT id, org_id, domain, started_at, heartbeat_at,
            CAST((julianday('now') - julianday(COALESCE(heartbeat_at, started_at))) * 1440 AS INTEGER) AS silent_for_minutes
       FROM work_queue
      WHERE status = 'in_progress'
        AND COALESCE(heartbeat_at, started_at) < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
      ORDER BY COALESCE(heartbeat_at, started_at) ASC
      LIMIT ?`
  ).bind(cutoff, limit).all<StuckWorkQueueRow>();
  return result.results;
}

// ─── Budget snapshot ─────────────────────────────────────────────────────

export interface BudgetSnapshotRow {
  org_id: string;
  user_id: string;
  upstream: string;
  bucket_window: string;
  bucket_start: string;
  used: number;
  cap: number;
  utilization_pct: number;
  /** True iff circuit_open_until is set AND in the future. */
  circuit_open: boolean;
  circuit_open_until: string | null;
  consecutive_429s: number;
  cap_lowered_count: number;
  cap_lowered_at: string | null;
  last_429_at: string | null;
}

/**
 * One row per (user, upstream, window) tuple known to the org. Surfaces
 * current utilization %, circuit state, and how many times the cap has
 * auto-tuned downward. Phase 0 read-only; Phase 1 wires into a route.
 */
export async function getBudgetSnapshot(
  env: Env,
  orgId: string
): Promise<BudgetSnapshotRow[]> {
  const result = await env.D1.prepare(
    `SELECT org_id, user_id, upstream, bucket_window, bucket_start, used, cap,
            CAST(CASE WHEN cap > 0 THEN (used * 100.0 / cap) ELSE 0 END AS REAL) AS utilization_pct,
            CASE
              WHEN circuit_open_until IS NOT NULL
                AND circuit_open_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
              THEN 1 ELSE 0
            END AS circuit_open_int,
            circuit_open_until,
            consecutive_429s, cap_lowered_count, cap_lowered_at, last_429_at
       FROM upstream_budget_ledger
      WHERE org_id = ?
      ORDER BY upstream, bucket_window, user_id`
  ).bind(orgId).all<BudgetSnapshotRow & { circuit_open_int: number }>();

  return result.results.map(r => ({
    org_id: r.org_id,
    user_id: r.user_id,
    upstream: r.upstream,
    bucket_window: r.bucket_window,
    bucket_start: r.bucket_start,
    used: r.used,
    cap: r.cap,
    utilization_pct: Math.round(r.utilization_pct * 10) / 10,
    circuit_open: r.circuit_open_int === 1,
    circuit_open_until: r.circuit_open_until,
    consecutive_429s: r.consecutive_429s,
    cap_lowered_count: r.cap_lowered_count,
    cap_lowered_at: r.cap_lowered_at,
    last_429_at: r.last_429_at,
  }));
}

// ─── Aggregate one-shot for the System Status header ─────────────────────

export interface SystemStatusSnapshot {
  generated_at: string;
  pipelines: PipelineHealthRow[];
  dead_letter: DeadLetterRow[];
  stuck_runs: StuckTaskRunRow[];
  budgets: BudgetSnapshotRow[];
  // Phase 4 1b (2026-05-04): per-user Firefly credential metadata.
  // No plaintext, no ciphertext. Drives the Settings UI's
  // "credentials section" and gives operators visibility into which
  // users have keys (for "why is Tony's backfill failing?" forensics).
  firefly_credentials: FireflyKeyStatus[];
  // Phase 5 1b (2026-05-05): universal work_queue surface.
  //   • work_queue_inventory: per (domain, status) counts for the
  //     org. Drives the Settings UI's "Work Queue" panel (1c).
  //   • stuck_work_queue: in_progress rows whose heartbeat is stale
  //     past the threshold. Sibling to stuck_runs (task_runs scope)
  //     but distinct surface — work_queue items are per-item, task_runs
  //     is per-cron-task. Both rendered in the same UI section.
  // dead_letter already absorbs work_queue:dead_letter rows via
  // getDeadLetterItems; no separate field needed.
  work_queue_inventory: WorkQueueDomainCount[];
  stuck_work_queue: StuckWorkQueueRow[];
  ingestion_incidents: IngestionIncident[];
}

/**
 * Single call returning everything the System Status panel needs. Future
 * route handler is a thin pass-through over this. ~9 D1 reads worst case;
 * well under the per-invocation subrequest budget.
 */
export async function getSystemStatusSnapshot(
  env: Env,
  orgId: string
): Promise<SystemStatusSnapshot> {
  const [
    pipelines,
    dead_letter,
    stuck_runs,
    budgets,
    firefly_credentials,
    work_queue_inventory,
    stuck_work_queue,
    ingestion_incidents,
  ] = await Promise.all([
    getPipelineHealth(env, orgId),
    getDeadLetterItems(env, orgId),
    getStuckTaskRuns(env),
    getBudgetSnapshot(env, orgId),
    listFireflyKeyStatuses(orgId, env),
    countByDomain(env, orgId),
    getStuckWorkQueueRows(env),
    listActiveIngestionIncidents(env, orgId),
  ]);
  return {
    generated_at: new Date().toISOString(),
    pipelines,
    dead_letter,
    stuck_runs,
    budgets,
    firefly_credentials,
    work_queue_inventory,
    stuck_work_queue,
    ingestion_incidents,
  };
}

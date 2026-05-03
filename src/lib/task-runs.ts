// Phase 0 — task_runs helpers.
//
// Open / heartbeat / close lifecycle for any scheduled task that lives
// OUTSIDE a Cloudflare Workflow (which already gets sync_jobs coverage).
// Use case: every ctxExec.waitUntil block on cron triggers, every queue
// consumer batch, every self-healer pass, every ad-hoc admin trigger.
//
// Standing properties enforced here:
//   • Atomicity — a row is 'running' OR a terminal status; never both.
//   • Idempotency — optional unique key collapses double-fires of the
//                   same scheduled task within the same window.
//   • Self-healing — heartbeat_at lets a watchdog reset rows stuck in
//                    'running' past N min of silence (see system-status).
//   • Observability — never silent. Even 'skipped' is a recorded outcome.
//
// Phase 0 ships these helpers; Phase 1+ wires them into the existing
// waitUntil call sites. Helpers are SAFE to use today (no schema
// dependencies beyond migration 0078).

import type { Env } from '../types/env';

export type TaskRunStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped';

export interface TaskRunCounts {
  items_processed?: number;
  items_failed?: number;
  items_skipped?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskRunContext {
  /** The newly-created task_runs.id. */
  readonly id: string;
  /** Stamp heartbeat_at = now. Call periodically from long-running tasks. */
  heartbeat(): Promise<void>;
  /** Accumulate counts and metadata mid-flight. Last call wins for metadata
   *  keys; counts ADD across calls. */
  report(counts: TaskRunCounts): void;
}

export interface OpenTaskRunOpts {
  /** When set, INSERT collides with the unique index on idempotency_key
   *  and the helper returns the existing row's id (no new run opened).
   *  Use case: cron double-fire protection. Pattern:
   *    `${task_name}:${bucket_start_iso}` */
  idempotencyKey?: string;
  /** Initial metadata stored as JSON. Merged with reports on close. */
  initialMetadata?: Record<string, unknown>;
}

/**
 * Open a new task_run row in 'running' state. Returns the row id.
 *
 * If `idempotencyKey` is provided and a row with the same key already
 * exists, returns null (caller should skip — another invocation already
 * owns this task slot). Pattern is INSERT OR IGNORE checking
 * meta.changes; when changes=0 we fetch the existing row's id.
 */
export async function openTaskRun(
  env: Env,
  orgId: string,
  taskName: string,
  opts: OpenTaskRunOpts = {}
): Promise<{ id: string; deduped: boolean } | null> {
  const id = crypto.randomUUID();
  const metadataJson = JSON.stringify(opts.initialMetadata ?? {});

  try {
    const result = await env.D1.prepare(
      `INSERT OR IGNORE INTO task_runs
         (id, org_id, task_name, status, started_at, metadata, idempotency_key, created_at)
       VALUES (?, ?, ?, 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?,
               strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(id, orgId, taskName, metadataJson, opts.idempotencyKey ?? null).run();

    if ((result.meta?.changes ?? 0) > 0) {
      return { id, deduped: false };
    }

    // Idempotency collision: the row already exists. Return its id so the
    // caller knows *which* run slot they collided with, and `deduped: true`
    // so the caller can skip work.
    if (opts.idempotencyKey) {
      const existing = await env.D1.prepare(
        `SELECT id FROM task_runs WHERE idempotency_key = ?`
      ).bind(opts.idempotencyKey).first<{ id: string }>();
      if (existing?.id) return { id: existing.id, deduped: true };
    }

    return null;
  } catch (e) {
    // Failure to OPEN a task_run must not break the underlying task. Log
    // and signal the caller to proceed without observability for this run.
    console.error(`[task-runs] openTaskRun failed for ${taskName}:`, e);
    return null;
  }
}

export async function recordTaskHeartbeat(env: Env, taskRunId: string): Promise<void> {
  try {
    await env.D1.prepare(
      `UPDATE task_runs SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'running'`
    ).bind(taskRunId).run();
  } catch (e) {
    console.error(`[task-runs] heartbeat failed for ${taskRunId}:`, e);
  }
}

export interface CloseTaskRunInput {
  status: 'success' | 'partial' | 'failed' | 'skipped';
  itemsProcessed?: number;
  itemsFailed?: number;
  itemsSkipped?: number;
  lastError?: string;
  /** Replaces the metadata column entirely (caller has already merged). */
  metadata?: Record<string, unknown>;
}

export async function closeTaskRun(
  env: Env,
  taskRunId: string,
  input: CloseTaskRunInput
): Promise<void> {
  try {
    const sets: string[] = [
      `status = ?`,
      `ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      // duration_ms = ms between started_at and now. SQLite julianday math.
      `duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)`,
      `items_processed = ?`,
      `items_failed = ?`,
      `items_skipped = ?`,
    ];
    const binds: unknown[] = [
      input.status,
      input.itemsProcessed ?? 0,
      input.itemsFailed ?? 0,
      input.itemsSkipped ?? 0,
    ];
    if (input.lastError !== undefined) {
      sets.push(`last_error = ?`);
      binds.push(input.lastError.slice(0, 1000));
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = ?`);
      binds.push(JSON.stringify(input.metadata));
    }
    binds.push(taskRunId);

    await env.D1.prepare(
      `UPDATE task_runs SET ${sets.join(', ')} WHERE id = ? AND status = 'running'`
    ).bind(...binds).run();
  } catch (e) {
    console.error(`[task-runs] closeTaskRun failed for ${taskRunId}:`, e);
  }
}

/**
 * Convenience wrapper. Opens a task_run, runs the function, closes
 * automatically — success on resolve, failed on throw, skipped if the
 * function returns `{ skip: true }`. Aggregates counts across multiple
 * `report()` calls inside the function body.
 *
 * Returns the function's resolved value, OR null when:
 *   - openTaskRun failed (D1 down) — observability degrades, run still happens
 *     ... wait, we return null; the function is NOT called in that case.
 *     This is intentional: if we can't open a row, we don't run the work
 *     blind. Caller wraps in their own try if they want to proceed regardless.
 *   - idempotencyKey collided with an existing run — work is skipped.
 *
 * Pattern at call sites (Phase 1 will migrate the existing waitUntil
 * blocks into this shape):
 *
 *   ctxExec.waitUntil(withTaskRun(env, orgId, 'embed_retry_drain', async (ctx) => {
 *     const result = await processEmbedRetryQueue(orgId, env);
 *     ctx.report({ items_processed: result.processed, items_failed: result.failed });
 *     await ctx.heartbeat();
 *   }));
 */
export async function withTaskRun<T>(
  env: Env,
  orgId: string,
  taskName: string,
  fn: (ctx: TaskRunContext) => Promise<T | { skip: true; reason?: string }>,
  opts: OpenTaskRunOpts = {}
): Promise<T | null> {
  const opened = await openTaskRun(env, orgId, taskName, opts);
  if (!opened) return null;
  if (opened.deduped) {
    return null;
  }

  // Accumulators captured by closure for the report() callback.
  const acc: Required<TaskRunCounts> = {
    items_processed: 0,
    items_failed: 0,
    items_skipped: 0,
    metadata: { ...(opts.initialMetadata ?? {}) },
  };

  const ctx: TaskRunContext = {
    id: opened.id,
    heartbeat: async () => recordTaskHeartbeat(env, opened.id),
    report: (counts: TaskRunCounts) => {
      if (typeof counts.items_processed === 'number') acc.items_processed += counts.items_processed;
      if (typeof counts.items_failed === 'number') acc.items_failed += counts.items_failed;
      if (typeof counts.items_skipped === 'number') acc.items_skipped += counts.items_skipped;
      if (counts.metadata) Object.assign(acc.metadata, counts.metadata);
    },
  };

  try {
    const result = await fn(ctx);
    if (result && typeof result === 'object' && 'skip' in result && result.skip) {
      await closeTaskRun(env, opened.id, {
        status: 'skipped',
        itemsProcessed: acc.items_processed,
        itemsFailed: acc.items_failed,
        itemsSkipped: acc.items_skipped,
        metadata: { ...acc.metadata, skip_reason: result.reason ?? 'unspecified' },
      });
      return null;
    }
    // Successful completion. 'partial' if any items_failed > 0, else 'success'.
    const status: 'success' | 'partial' = acc.items_failed > 0 ? 'partial' : 'success';
    await closeTaskRun(env, opened.id, {
      status,
      itemsProcessed: acc.items_processed,
      itemsFailed: acc.items_failed,
      itemsSkipped: acc.items_skipped,
      metadata: acc.metadata,
    });
    return result as T;
  } catch (e: any) {
    await closeTaskRun(env, opened.id, {
      status: 'failed',
      itemsProcessed: acc.items_processed,
      itemsFailed: acc.items_failed,
      itemsSkipped: acc.items_skipped,
      lastError: String(e?.message ?? e),
      metadata: acc.metadata,
    });
    // Re-throw so the caller's own error handling still runs (logs,
    // surface-up, etc.). The task_run row is closed with status='failed'
    // before this throws.
    throw e;
  }
}

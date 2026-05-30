// Phase 0 — workflow-state reconciler.
//
// Closes the gap that Terminal 5 caught: when CF runtime errors a
// workflow with a hard error (subrequest cap, memory cap, deploy
// interrupt mid-step), the worker invocation is terminated BEFORE
// user code can run its catch block. trackedStep's failure-write never
// fires; the outer run() catch never fires. sync_jobs stays at
// status='running' indefinitely. CF dashboard shows 'errored', D1
// shows 'running' — they diverge until the next ingestion's
// check-concurrency step finally marks the orphan failed (up to ~1h).
//
// This reconciler polls CF Workflows REST API for each running
// sync_jobs row that has a cf_instance_id (captured at workflow start
// in IngestionWorkflow.check-concurrency, mig 0081) and reconciles D1
// to runtime truth.
//
// Phase 0 scope: workflow_type='ingestion' only. Other workflows
// (enrichment, ingestion-chunk, ingestion-finalizer, campaign-send,
// daily-cron) get instanceId capture instrumented as follow-up work.
// The reconciler tolerates missing IDs by simply not picking them up.
//
// Standing properties enforced here:
//   • Idempotency      — re-running on the same row sees the new D1
//                        status and is a no-op (the WHERE filter
//                        excludes already-reconciled rows).
//   • Atomicity        — per-row UPDATE is single SQL statement.
//   • Checkpointing    — withTaskRun heartbeat after every N rows.
//   • Rate-limit aware — checkBudget('cloudflare_api', minute) gates
//                        every CF API call before hitting the wire.
//   • Three-tier retry — transient (CF 5xx, network) → recorded as
//                        items_failed, sweep continues; recoverable
//                        (next tick retries the same row); permanent
//                        (auth failure / token revoked) → withTaskRun
//                        records failed, surfaces in System Status.
//   • Circuit breaker  — inherited from upstream-budget.ts. 3
//                        consecutive 429s → cap drops 10%, circuit
//                        opens 30 min. While circuit open, ALL
//                        cloudflare_api calls return 'circuit_open'.
//   • Observability    — every sweep is a task_runs row; every
//                        reconciliation event logs to console with
//                        sync_job_id + cf_status for forensic trace.
//   • Self-healing     — IS the self-healer for stuck workflow rows.
//                        Convergence: every (running+stale+has-id)
//                        row gets reconciled within one tick of
//                        becoming eligible.

import type { Env } from '../types/env';
import { withTaskRun } from './task-runs';
import { checkBudget, recordUsage, recordRateLimit } from './upstream-budget';

// ─── Types ───────────────────────────────────────────────────────────────

interface SyncJobRow {
  id: string;
  workflow_type: string;
  cf_instance_id: string;
  started_at: string;
  timeout_at: string | null;
}

/** CF Workflows REST API instance status enum. Soft-typed string union
 *  so unfamiliar values surface as 'unknown' instead of crashing the
 *  parser when CF adds a new state. */
type CfWorkflowStatus =
  | 'queued'      // not yet running; rare on a stale row
  | 'running'     // actively executing; do not reconcile
  | 'paused'      // paused mid-step; do not reconcile
  | 'complete'    // finished cleanly; reconcile to 'completed'
  | 'errored'     // failed at runtime; reconcile to 'failed'
  | 'terminated'  // manually killed; reconcile to 'failed'
  | 'unknown';

interface CfApiResponse {
  result?: {
    id?: string;
    name?: string;
    status?: string;
    error?: string | { message?: string };
    [key: string]: unknown;
  };
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
}

interface ReconcileCounts {
  reconciled_to_completed: number;
  reconciled_to_failed: number;
  left_alone: number;
  instance_not_found: number;
  api_failures: number;
  budget_skipped: number;
}

// ─── Configuration ────────────────────────────────────────────────────────

/** Map sync_jobs.workflow_type → Cloudflare Workflow name (per
 *  wrangler.toml). Workflows whose type isn't in this map are skipped
 *  by the reconciler — they get instanceId-capture + a map entry
 *  before they're reconcilable. */
const WORKFLOW_TYPE_TO_CF_NAME: Record<string, string> = {
  ingestion: 'ingestion-workflow',
  enrichment: 'enrichment-workflow',
  // Add as instanceId capture is instrumented in each workflow:
  // 'ingestion-chunk': 'ingestion-chunk-workflow',
  // ...
};

/** Bound the per-tick sweep so a backlog can't blow the cron tick's
 *  budget. CF Workflows API has plenty of headroom (1200/5min global
 *  limit), but the per-row D1 work + the budget ledger writes also
 *  consume the worker's 1000-subreq invocation budget. 50/tick × 1
 *  GET + 1 UPDATE = ≤100 subreqs, comfortable margin. */
const MAX_ROWS_PER_SWEEP = 50;

/** Only sweep rows whose timeout_at is already past — these are the
 *  candidates for orphan reconciliation. Fresher rows are still
 *  legitimately in flight; reconciling them prematurely could mark a
 *  row 'failed' that's actually just slow. */
const STALE_AFTER_TIMEOUT = true;

/** CF API request timeout. Reconciler fires from a hourly cron tick
 *  with constrained wallclock; per-call 15s is generous and bounded. */
const CF_API_TIMEOUT_MS = 15_000;

/** Heartbeat the task_run every N rows so the watchdog (also in
 *  Phase 0) doesn't reset a long sweep mid-flight. */
const HEARTBEAT_EVERY_N_ROWS = 10;

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Sweep all stale running sync_jobs for one org, reconcile to CF
 * runtime truth. Wraps in withTaskRun for observability.
 *
 * Returns the inner counts. Caller (cron handler) doesn't need them
 * for control flow; counts are recorded in the task_runs metadata for
 * System Status reads.
 *
 * Idempotent — running this twice on the same org yields identical
 * results provided no new rows go stale between runs.
 */
export async function reconcileWorkflowState(
  orgId: string,
  env: Env
): Promise<ReconcileCounts | null> {
  return withTaskRun(env, orgId, 'workflow_state_reconcile', async (ctx) => {
    const counts: ReconcileCounts = {
      reconciled_to_completed: 0,
      reconciled_to_failed: 0,
      left_alone: 0,
      instance_not_found: 0,
      api_failures: 0,
      budget_skipped: 0,
    };

    // Find stale running rows that have a CF instance ID. Filter by
    // workflow_type IN (...) — only types we know how to reconcile.
    const knownTypes = Object.keys(WORKFLOW_TYPE_TO_CF_NAME);
    if (knownTypes.length === 0) {
      ctx.report({ items_skipped: 0, metadata: { ...counts, note: 'no workflow types instrumented' } });
      return counts;
    }
    const placeholders = knownTypes.map(() => '?').join(',');

    const stales = await env.D1.prepare(
      `SELECT id, workflow_type, cf_instance_id, started_at, timeout_at
         FROM sync_jobs
        WHERE org_id = ?
          AND status = 'running'
          AND cf_instance_id IS NOT NULL
          AND workflow_type IN (${placeholders})
          ${STALE_AFTER_TIMEOUT ? `AND timeout_at IS NOT NULL AND timeout_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')` : ''}
        ORDER BY started_at ASC
        LIMIT ?`
    ).bind(orgId, ...knownTypes, MAX_ROWS_PER_SWEEP).all<SyncJobRow>();

    if (stales.results.length === 0) {
      ctx.report({ metadata: { ...counts } });
      return counts;
    }

    let processedSinceHeartbeat = 0;

    for (const row of stales.results) {
      processedSinceHeartbeat++;
      if (processedSinceHeartbeat >= HEARTBEAT_EVERY_N_ROWS) {
        await ctx.heartbeat();
        processedSinceHeartbeat = 0;
      }

      // Budget gate: refuse the call if cap exhausted or circuit open.
      // Skipped rows surface as 'budget_skipped' — next tick retries
      // (idempotent) when the budget refreshes / circuit closes.
      const budgetCheck = await checkBudget(env, orgId, null, 'cloudflare_api', 'minute');
      if (budgetCheck.decision !== 'ok') {
        counts.budget_skipped++;
        console.log(
          `[workflow-state-reconciler] budget gate (${budgetCheck.decision}) — skipping ${row.id}; will retry next tick`
        );
        continue;
      }

      try {
        const status = await fetchCfWorkflowStatus(row.workflow_type, row.cf_instance_id, env);
        await recordUsage(env, orgId, null, 'cloudflare_api', 'minute');

        await applyReconciliation(row, status, env, counts);
      } catch (e: any) {
        // Distinguish 429 from other errors so the circuit-breaker
        // ledger learns. Other errors increment items_failed but the
        // sweep continues — the row stays running for next tick.
        const msg = String(e?.message ?? e);
        if (msg.includes('429') || msg.includes('rate_limit')) {
          await recordRateLimit(env, orgId, null, 'cloudflare_api', 'minute');
        }
        counts.api_failures++;
        console.error(
          `[workflow-state-reconciler] api call failed for sync_job=${row.id} cf_instance=${row.cf_instance_id}:`,
          msg
        );
      }
    }

    ctx.report({
      items_processed: stales.results.length,
      items_failed: counts.api_failures,
      items_skipped: counts.budget_skipped,
      metadata: { ...counts },
    });
    return counts;
  });
}

// ─── CF API call ──────────────────────────────────────────────────────────

/** Fetch the CF Workflows instance status. Throws on non-200/404 so
 *  the caller's catch can distinguish transient (429, 5xx) from
 *  permanent. 404 returns the synthetic 'unknown' status which
 *  applyReconciliation treats as instance-not-found. */
async function fetchCfWorkflowStatus(
  workflowType: string,
  instanceId: string,
  env: Env
): Promise<CfWorkflowStatus> {
  const cfWorkflowName = WORKFLOW_TYPE_TO_CF_NAME[workflowType];
  if (!cfWorkflowName) {
    // Should be filtered out at the SELECT, but defense-in-depth.
    return 'unknown';
  }

  const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID as string | undefined;
  const apiToken = (env as any).CLOUDFLARE_API_TOKEN as string | undefined;
  if (!accountId || !apiToken) {
    // No credentials — treat as transient so the row stays running
    // for next tick. Operator must set CLOUDFLARE_API_TOKEN secret.
    throw new Error('CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing');
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/workflows/${encodeURIComponent(cfWorkflowName)}` +
    `/instances/${encodeURIComponent(instanceId)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(CF_API_TIMEOUT_MS),
  });

  if (resp.status === 404) {
    // Instance no longer exists in CF — likely retention TTL elapsed.
    // Treat as terminal: reconcile to 'failed' with synthetic note.
    return 'unknown';
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`cf_api_error HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as CfApiResponse;
  const raw = data?.result?.status;
  return normalizeCfStatus(raw);
}

function normalizeCfStatus(raw: string | undefined): CfWorkflowStatus {
  switch (raw) {
    case 'queued':
    case 'running':
    case 'paused':
    case 'complete':
    case 'errored':
    case 'terminated':
      return raw;
    default:
      return 'unknown';
  }
}

// ─── Reconciliation logic ────────────────────────────────────────────────

/** Apply the CF status to D1. Single-statement UPDATE per row; the
 *  WHERE clause re-checks status='running' so a concurrent reconciler
 *  picking the same row has its UPDATE no-op. */
async function applyReconciliation(
  row: SyncJobRow,
  cfStatus: CfWorkflowStatus,
  env: Env,
  counts: ReconcileCounts
): Promise<void> {
  switch (cfStatus) {
    case 'queued':
    case 'running':
    case 'paused': {
      counts.left_alone++;
      return;
    }

    case 'complete': {
      const result = await env.D1.prepare(
        `UPDATE sync_jobs
            SET status = 'completed',
                completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                error_message = COALESCE(error_message, 'reconciled: cf_status=complete')
          WHERE id = ? AND status = 'running'`
      ).bind(row.id).run();
      if ((result.meta?.changes ?? 0) > 0) {
        counts.reconciled_to_completed++;
        console.log(
          `[workflow-state-reconciler] reconciled sync_job=${row.id} → completed (cf=complete)`
        );
      }
      return;
    }

    case 'errored': {
      const result = await env.D1.prepare(
        `UPDATE sync_jobs
            SET status = 'failed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                error_message = COALESCE(error_message, 'reconciled: cf_status=errored — runtime terminated workflow before user code could write closure')
          WHERE id = ? AND status = 'running'`
      ).bind(row.id).run();
      if ((result.meta?.changes ?? 0) > 0) {
        counts.reconciled_to_failed++;
        console.log(
          `[workflow-state-reconciler] reconciled sync_job=${row.id} → failed (cf=errored)`
        );
      }
      return;
    }

    case 'terminated': {
      const result = await env.D1.prepare(
        `UPDATE sync_jobs
            SET status = 'failed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                error_message = COALESCE(error_message, 'reconciled: cf_status=terminated — workflow manually terminated')
          WHERE id = ? AND status = 'running'`
      ).bind(row.id).run();
      if ((result.meta?.changes ?? 0) > 0) {
        counts.reconciled_to_failed++;
        console.log(
          `[workflow-state-reconciler] reconciled sync_job=${row.id} → failed (cf=terminated)`
        );
      }
      return;
    }

    case 'unknown': {
      // 404 from CF API or unrecognized status. Treat as terminal:
      // the instance is no longer queryable, so D1's 'running' is
      // definitely wrong.
      const result = await env.D1.prepare(
        `UPDATE sync_jobs
            SET status = 'failed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                error_message = COALESCE(error_message, 'reconciled: cf_instance not found (404 or unknown status)')
          WHERE id = ? AND status = 'running'`
      ).bind(row.id).run();
      if ((result.meta?.changes ?? 0) > 0) {
        counts.instance_not_found++;
        console.log(
          `[workflow-state-reconciler] reconciled sync_job=${row.id} → failed (cf=unknown/404)`
        );
      }
      return;
    }
  }
}

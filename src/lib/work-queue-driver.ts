// Phase 5 1b (2026-05-05) — Universal Work Queue cron driver.
//
// Orchestrates the minute-tick run for every registered domain handler:
//   1. Sweep stale claims via watchdog (always — even with empty registry,
//      this keeps zombie in_progress rows from accumulating).
//   2. Read the OPEN-circuit upstream set ONCE per tick.
//   3. For each registered handler:
//      a. Claim up to handler.batchSize items via claimNextBatch.
//      b. Process each item via handler.process — try/catch wrapping:
//         - thrown → failWork (3-tier backoff or dead-letter at max)
//         - returned cleanly → completeWork
//         - explicit deadLetterWork inside the handler is also valid
//           (handler returns normally afterward; we treat the row as
//           already-final and skip the success transition).
//
// Phase 5 ships the driver wired into the minute tick (src/index.ts)
// with an EMPTY handler registry. No domain runs through here yet. The
// scaffold is live so future domain pilots plug in with one entry in
// WORK_QUEUE_HANDLERS without touching the cron dispatch code.
//
// Subrequest budget reminder for future domain authors:
//   • The minute tick at src/index.ts:917 already spends ~5–10
//     subrequests per org on enrichment + daily gates plus
//     progressive-backfill drivers. CF cap is 1000/invocation.
//   • Each registered domain handler should keep its per-tick batch
//     to ≤ 10 items AND its total subrequest spend to ~50 to leave
//     headroom. Heavier domains run on a less frequent cadence
//     (handler.cadence='hour') or chunk via next_attempt_at.
//   • The driver ITSELF spends 1 D1 read (open circuits) + 1 UPDATE
//     RETURNING per domain claim + N writes per item handled. Stays
//     well under budget.

import type { Env } from '../types/env';
import {
  claimNextBatch,
  completeWork,
  failWork,
  getOpenCircuits,
  recordHeartbeat,
  sweepStaleClaims,
  type WorkQueueRow,
} from './work-queue';

// ─── Handler contract ───────────────────────────────────────────────

export interface WorkQueueHandler {
  /** Must match the `domain` column on rows this handler processes. */
  domain: string;

  /**
   * Max items claimed per tick. Hard CF cap is 1000 subrequests per
   * invocation; combined with the existing minute-tick load, a sane
   * default is 10. Domains with cheap items can bump up; heavy items
   * should stay at or below 10.
   */
  batchSize: number;

  /**
   * Optional global concurrency cap for long-running domains. Without this,
   * batchSize=1 still permits a new row to be claimed on the next minute tick
   * while an earlier row is still in_progress. Heavy domains like intelligent
   * imports should set this to 1.
   */
  maxConcurrent?: number;

  /**
   * Optional within-tick processing concurrency for a claimed batch.
   * Default remains 1 so existing domains keep their sequential behavior.
   */
  processConcurrency?: number;

  /**
   * Optional vetted claim/processing cap for cheap, sharded operational
   * domains. The default stays 20 to preserve the historical safety rail.
   */
  claimBatchCap?: number;

  /**
   * 'minute' (default) runs every minute tick. 'hour' runs only when
   * the dispatching minute tick happens at minute :00 (caller decides).
   * Keeping the dispatch logic in src/index.ts means this field is
   * advisory documentation today — Phase 5.1+ may wire it in.
   */
  cadence?: 'minute' | 'hour';

  /**
   * Process a single claimed row. Throwing transitions the row via
   * failWork (3-tier backoff or dead-letter). Returning cleanly
   * transitions via completeWork.
   *
   * Heartbeat: Phase 6.0.1 (2026-05-05) made auto-heartbeat the FLOOR.
   * The driver wraps every handler invocation in withHeartbeat() so a
   * background loop bumps heartbeat_at + locked_until on
   * AUTO_HEARTBEAT_INTERVAL_MS cadence (60s default) for the duration
   * of process(). Handlers DO NOT need to call recordHeartbeat for
   * lock-keepalive purposes — the driver guarantees that.
   *
   * Handlers MAY still call recordHeartbeat(env, item.id) for FINER
   * checkpointing (e.g. after each chunk in a multi-chunk job, to
   * track within-item progress timestamps). That use is additive; the
   * driver's automatic heartbeat is the safety floor.
   *
   * For fatal errors that should NOT retry, call deadLetterWork(env,
   * item.id, message) explicitly inside this function and return
   * normally. The driver detects the row is already in a terminal
   * status and skips the completeWork transition.
   */
  process: (item: WorkQueueRow, env: Env) => Promise<void>;
}

// Re-export so domain modules can rely on a single import surface.
export { recordHeartbeat };

// ─── Auto-heartbeat (Phase 6.0.1, 2026-05-05) ──────────────────────
//
// Default interval at which the driver bumps heartbeat_at + extends
// locked_until during a handler's execution. Picked well below the
// 5-min default lock TTL so even a delayed heartbeat (D1 hiccup,
// unusual GC pause) keeps the lock alive. Fast handlers (<60s, e.g.
// embed_retry's ~5s/item) will never trigger a heartbeat write —
// the loop's first wait fires after the handler has already returned.
const AUTO_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Wrap a handler invocation with a periodic background heartbeat. The
 * heartbeat loop runs on AUTO_HEARTBEAT_INTERVAL_MS cadence and stops
 * cleanly when the wrapped function settles (via the `done` flag).
 *
 * Heartbeat failures are NON-fatal — logged + swallowed. The watchdog
 * grace window (STALE_CLAIM_GRACE_MS in work-queue.ts) absorbs the
 * occasional missed heartbeat, and `recordHeartbeat`'s WHERE clause
 * filters status='in_progress' so a heartbeat firing AFTER the
 * handler completes is a no-op (the row already moved to terminal).
 *
 * Why an interval loop instead of a single delayed bump:
 *   • Embed handlers and similar bursty work usually finish before
 *     60s, in which case zero heartbeats fire.
 *   • Multi-step handlers (Firefly window pagination, calendar week
 *     sync, enrichment chains) need keepalive across many minutes
 *     of work — one heartbeat per minute over a 5-min handler is
 *     fine.
 *   • Async/await + setTimeout is the simplest portable primitive
 *     in CF Workers; no setInterval lifecycle gotchas.
 */
async function withHeartbeat<T>(
  env: Env,
  itemId: string,
  intervalMs: number,
  fn: () => Promise<T>
): Promise<T> {
  let done = false;
  // Background loop. Not awaited — it self-terminates on `done`.
  // waitUntil holds the worker open long enough for the loop's
  // tail to clear after the wrapped function returns.
  (async () => {
    while (!done) {
      await new Promise(r => setTimeout(r, intervalMs));
      if (done) return;
      try {
        await recordHeartbeat(env, itemId);
      } catch (e) {
        console.error(
          `[work-queue] auto-heartbeat failed for ${itemId}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
  })();
  try {
    return await fn();
  } finally {
    done = true;
  }
}

// ─── Registry ───────────────────────────────────────────────────────

import { embedRetryHandler } from './work-queue-handlers/embed-retry';
import { attachmentBackfillHandler } from './work-queue-handlers/attachment-backfill';
import { calendarRefreshHandler } from './work-queue-handlers/calendar-refresh';
import { fireflyWindowHandler } from './work-queue-handlers/firefly-window';
import { dealReplayEvidenceHandler } from './work-queue-handlers/deal-replay-evidence';
import { dealEvidenceDetectHandler } from './work-queue-handlers/deal-evidence-detect';
import { prospectDetectHandler } from './work-queue-handlers/prospect-detect';
import { intelligentImportHandler } from './work-queue-handlers/intelligent-import';
import { contactEnrichmentHandler } from './work-queue-handlers/contact-enrichment';
import { ragReindexV2Handler } from './work-queue-handlers/rag-reindex-v2';
import { deckRenderHandler } from './work-queue-handlers/deck-render';
import { slackChannelBackfillHandler } from './work-queue-handlers/slack-channel-backfill';
import { maxModeJobHandler } from './work-queue-handlers/max-mode-job';
import { crmNameBackfillHandler } from './work-queue-handlers/crm-name-backfill';

/**
 * Phase 5 shipped with an empty registry. Domain pilots append entries
 * here. Order doesn't matter (each handler is independent); SQLite
 * serializes claim writes so two handlers in the same tick can't race
 * on the same row even hypothetically.
 *
 * Phase 6 1a (2026-05-05): first pilot — embed_retry. Replaces the
 * per-domain handcrafted drain at daily-cron.ts:processEmbedRetryQueue.
 *
 * Phase 6.1 (2026-05-05): second pilot — calendar_refresh. Replaces
 * the inline pick-and-sync loop inside driveCalendarProgressiveBackfill
 * (now bootstrap-only). enqueueCalendarRefreshes runs on every minute
 * tick before processWorkQueueTick to populate the queue based on the
 * calendar table's per-window staleness state.
 *
 * Phase 6.2 1b (2026-05-05): third pilot — firefly_window. Replaces
 * the inline pick-and-sync loop inside driveFireflyProgressiveBackfill
 * (now a thin parent-status monitor + finalizer). Windows are dual-
 * written into work_queue at parent-creation time (1a); migration
 * 0086 reconciles the in-flight set; this registration activates
 * processing. Handler uses Phase 6.2 1a's deferWork primitive for
 * paused-state checkpoint-resume (rate-limit defers to next UTC
 * midnight without consuming attempt budget).
 */
export const WORK_QUEUE_HANDLERS: WorkQueueHandler[] = [
  prospectDetectHandler,
  embedRetryHandler,
  attachmentBackfillHandler,
  calendarRefreshHandler,
  fireflyWindowHandler,
  dealReplayEvidenceHandler,
  dealEvidenceDetectHandler,
  intelligentImportHandler,
  contactEnrichmentHandler,
  maxModeJobHandler,
  crmNameBackfillHandler,
  // MARTy Sandbox handlers are intentionally not registered while the
  // sandbox is disabled; queued sandbox rows must not consume model credits.
  ragReindexV2Handler,
  deckRenderHandler,
  slackChannelBackfillHandler,
];

// ─── Driver ─────────────────────────────────────────────────────────

export interface ProcessTickResult {
  swept: number;            // rows reclaimed from stale claims
  deck_reconciled?: number; // active deck jobs terminalized from queue truth
  open_circuits: string[];  // upstreams skipped this tick
  sample_errors: Array<{ domain: string; work_queue_id: string | null; error: string }>;
  per_domain: Array<{
    domain: string;
    claimed: number;
    completed: number;
    failed: number;
    errors?: Array<{ work_queue_id: string | null; error: string }>;
  }>;
}

export interface ProcessClaimedWorkItemResult {
  completed: boolean;
  failed: boolean;
  error?: string;
}

export async function processClaimedWorkItem(
  env: Env,
  handler: WorkQueueHandler,
  item: WorkQueueRow
): Promise<ProcessClaimedWorkItemResult> {
  try {
    // Phase 6.0.1: wrap handler in auto-heartbeat. Lock keepalive is
    // the driver's responsibility; alternate dispatch paths such as
    // queue consumers use this same helper so long RAG jobs do not get
    // reclaimed while they are still actively writing.
    await withHeartbeat(env, item.id, AUTO_HEARTBEAT_INTERVAL_MS,
      () => handler.process(item, env));
    const completed = await completeWork(env, item.id);
    if (!completed) {
      const terminal = await env.D1.prepare(
        `SELECT status, last_error FROM work_queue WHERE id = ?`
      ).bind(item.id).first<{ status: string; last_error: string | null }>();
      if (terminal?.status === 'dead_letter') {
        try {
          const { reportWorkQueueOutcome } = await import('./ingestion-health');
          await reportWorkQueueOutcome(env, item, terminal.last_error || 'dead_letter');
        } catch (e) {
          console.error(
            `[work-queue] ingestion-health explicit dead-letter report failed for ${item.id}:`,
            e instanceof Error ? e.message : e
          );
        }
        return { completed: false, failed: true, error: terminal.last_error || 'dead_letter' };
      }
      return { completed: false, failed: false };
    }
    try {
      const { reportWorkQueueOutcome } = await import('./ingestion-health');
      await reportWorkQueueOutcome(env, item, null);
    } catch (e) {
      console.error(
        `[work-queue] ingestion-health success report failed for ${item.id}:`,
        e instanceof Error ? e.message : e
      );
    }
    return { completed: true, failed: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await failWork(env, item.id, msg);
      try {
        const { reportWorkQueueOutcome } = await import('./ingestion-health');
        await reportWorkQueueOutcome(env, item, msg);
      } catch (reportErr) {
        console.error(
          `[work-queue] ingestion-health failure report failed for ${item.id}:`,
          reportErr instanceof Error ? reportErr.message : reportErr
        );
      }
      return { completed: false, failed: true, error: msg };
    } catch (innerE) {
      console.error(
        `[work-queue] failWork failed for ${item.id} (original: ${msg}):`,
        innerE instanceof Error ? innerE.message : innerE
      );
      throw innerE;
    }
  }
}

/**
 * Single minute-tick pass. Idempotent: calling this twice in the same
 * minute with no new arrivals does nothing on the second call (claim
 * filters on status='pending' which the first pass cleared).
 *
 * Catches per-handler errors so one bad handler can't poison the
 * sibling handlers in the same tick. The driver itself logs but does
 * not throw — caller wraps in waitUntil + try/catch defensively.
 */
export async function processWorkQueueTick(env: Env): Promise<ProcessTickResult> {
  const result: ProcessTickResult = {
    swept: 0,
    open_circuits: [],
    sample_errors: [],
    per_domain: [],
  };

  // Watchdog: always run, even with zero registered handlers. Catches
  // rows orphaned by a previous handler crash or a worker restart
  // mid-process. Cheap when there's nothing stuck (single SELECT).
  try {
    result.swept = await sweepStaleClaims(env);
    if (result.swept > 0) {
      console.log(`[work-queue] watchdog reclaimed ${result.swept} stale rows`);
    }
  } catch (e) {
    console.error('[work-queue] sweepStaleClaims failed:', e instanceof Error ? e.message : e);
  }

  try {
    const { reconcileDeckArtifactJobs } = await import('./document-artifacts');
    const deckReconcile = await reconcileDeckArtifactJobs(env, { limit: 5 });
    result.deck_reconciled = deckReconcile.reconciled;
    if (deckReconcile.reconciled > 0) {
      console.log(`[work-queue] reconciled ${deckReconcile.reconciled} stale deck jobs`);
    }
  } catch (e) {
    console.error('[work-queue] reconcileDeckArtifactJobs failed:', e instanceof Error ? e.message : e);
  }

  // No handlers registered → fast-exit. The watchdog still ran above.
  if (WORK_QUEUE_HANDLERS.length === 0) return result;

  // Single read for the OPEN-circuit set; reused across every handler
  // claim this tick. If this read fails we surface an empty set rather
  // than block all handlers — the per-handler 429 recordRateLimit path
  // will re-trip circuits on actual upstream rejections.
  try {
    result.open_circuits = await getOpenCircuits(env);
  } catch (e) {
    console.error('[work-queue] getOpenCircuits failed:', e instanceof Error ? e.message : e);
    result.open_circuits = [];
  }

  // Iterate handlers sequentially. Concurrency across handlers is
  // possible (Promise.all) but sequential is safer for subrequest
  // budget — each handler runs to completion before the next claims.
  // Domains needing concurrency can implement it INSIDE handler.process.
  for (const handler of WORK_QUEUE_HANDLERS) {
    const stats: ProcessTickResult['per_domain'][number] = {
      domain: handler.domain,
      claimed: 0,
      completed: 0,
      failed: 0,
      errors: [],
    };
    let claimed: WorkQueueRow[] = [];
    try {
      const claimBatchCap = Math.max(1, Math.floor(handler.claimBatchCap || 20));
      let claimLimit = Math.min(handler.batchSize, claimBatchCap);
      if (handler.maxConcurrent !== undefined) {
        const active = await env.D1.prepare(
          `SELECT COUNT(*) AS count FROM work_queue
            WHERE domain = ? AND status = 'in_progress'`
        ).bind(handler.domain).first<{ count: number }>();
        const activeCount = active?.count ?? 0;
        const available = handler.maxConcurrent - activeCount;
        if (available <= 0) {
          result.per_domain.push(stats);
          continue;
        }
        claimLimit = Math.min(claimLimit, available);
      }

      claimed = await claimNextBatch(
        env,
        handler.domain,
        claimLimit,
        result.open_circuits
      );
      stats.claimed = claimed.length;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[work-queue] claim failed for ${handler.domain}:`, message);
      stats.errors?.push({ work_queue_id: null, error: message });
      result.sample_errors.push({ domain: handler.domain, work_queue_id: null, error: message });
      result.per_domain.push(stats);
      continue;
    }

    const processOne = async (item: WorkQueueRow) => {
      try {
        const itemResult = await processClaimedWorkItem(env, handler, item);
        if (itemResult.completed) stats.completed++;
        if (itemResult.failed) {
          stats.failed++;
          if (itemResult.error) {
            const entry = { work_queue_id: item.id, error: itemResult.error.slice(0, 500) };
            if ((stats.errors?.length || 0) < 5) stats.errors?.push(entry);
            if (result.sample_errors.length < 10) {
              result.sample_errors.push({ domain: handler.domain, ...entry });
            }
          }
        }
      } catch (e) {
        // Failure in failWork itself — processClaimedWorkItem already
        // logged the full chain. The row stays in_progress but the
        // watchdog's stale-lock sweep will reclaim it next tick once
        // locked_until elapses.
        stats.failed++;
        const message = e instanceof Error ? e.message : String(e);
        const entry = { work_queue_id: item.id, error: message.slice(0, 500) };
        if ((stats.errors?.length || 0) < 5) stats.errors?.push(entry);
        if (result.sample_errors.length < 10) {
          result.sample_errors.push({ domain: handler.domain, ...entry });
        }
      }
    };

    const claimBatchCap = Math.max(1, Math.floor(handler.claimBatchCap || 20));
    const processConcurrency = Math.min(Math.max(Math.floor(handler.processConcurrency || 1), 1), claimBatchCap);
    for (let i = 0; i < claimed.length; i += processConcurrency) {
      await Promise.all(claimed.slice(i, i + processConcurrency).map(processOne));
    }
    result.per_domain.push(stats);
  }

  return result;
}

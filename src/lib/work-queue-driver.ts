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
   * For long-running work, call recordHeartbeat(env, item.id) at sane
   * intervals so the watchdog doesn't reclaim while you're making
   * progress.
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

// ─── Registry ───────────────────────────────────────────────────────

import { embedRetryHandler } from './work-queue-handlers/embed-retry';

/**
 * Phase 5 shipped with an empty registry. Domain pilots append entries
 * here. Order doesn't matter (each handler is independent); SQLite
 * serializes claim writes so two handlers in the same tick can't race
 * on the same row even hypothetically.
 *
 * Phase 6 1a (2026-05-05): first pilot — embed_retry. Replaces the
 * per-domain handcrafted drain at daily-cron.ts:processEmbedRetryQueue.
 * Existing embed_retry_queue rows continue to drain via the old code
 * path during the 1a→1b transition; Phase 6 1b removes that path and
 * copies residual rows into work_queue via migration 0084.
 */
export const WORK_QUEUE_HANDLERS: WorkQueueHandler[] = [
  embedRetryHandler,
];

// ─── Driver ─────────────────────────────────────────────────────────

export interface ProcessTickResult {
  swept: number;            // rows reclaimed from stale claims
  open_circuits: string[];  // upstreams skipped this tick
  per_domain: Array<{
    domain: string;
    claimed: number;
    completed: number;
    failed: number;
  }>;
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
    const stats = { domain: handler.domain, claimed: 0, completed: 0, failed: 0 };
    let claimed: WorkQueueRow[] = [];
    try {
      claimed = await claimNextBatch(
        env,
        handler.domain,
        Math.min(handler.batchSize, 10),
        result.open_circuits
      );
      stats.claimed = claimed.length;
    } catch (e) {
      console.error(`[work-queue] claim failed for ${handler.domain}:`, e instanceof Error ? e.message : e);
      result.per_domain.push(stats);
      continue;
    }

    for (const item of claimed) {
      try {
        await handler.process(item, env);
        // Domain may have already transitioned via deadLetterWork; the
        // completeWork UPDATE is no-op idempotent on terminal statuses
        // (the WHERE clause matches by id only — completed status
        // self-overwrite is benign).
        await completeWork(env, item.id);
        stats.completed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        try {
          await failWork(env, item.id, msg);
          stats.failed++;
        } catch (innerE) {
          // Failure in failWork itself — surface BOTH errors so the
          // operator sees the full chain. The row stays in_progress
          // but the watchdog's stale-lock sweep will reclaim it next
          // tick once locked_until elapses.
          console.error(
            `[work-queue] failWork failed for ${item.id} (original: ${msg}):`,
            innerE instanceof Error ? innerE.message : innerE
          );
        }
      }
    }
    result.per_domain.push(stats);
  }

  return result;
}

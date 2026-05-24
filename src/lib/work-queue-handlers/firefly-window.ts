// Phase 6.2 1b (2026-05-05) — firefly_window domain handler.
//
// Third domain pilot for the universal work_queue substrate. Replaces
// the inline pick-and-sync loop that lived inside
// driveFireflyProgressiveBackfill. After 1b, that driver is reduced to
// a thin parent-status monitor + finalizer; this handler owns all per-
// window work: token resolution, runFireflyWindowBackfill invocation,
// result handling (completed / failed / paused-rate-limit / paused-
// other), and dual-writes to the legacy
// firefly_progressive_backfill_windows table for UI continuity.
//
// Why dual-write to legacy: the frontend's "Firefly Historical
// Backfill" panel polls getFireflyProgressiveStatus which still reads
// from the legacy windows table. Keeping that table current preserves
// the UI's progress pills + counters without any frontend rebuild.
// Future Phase 7+ may switch the frontend to read from work_queue
// directly; until then, legacy is the authoritative read surface.
//
// Subrequest budget per handler invocation:
//   • 1 D1 read (parent lookup for token fallback + cancel check)
//   • 1 token refresh (getFireflyKey or decryptToken)
//   • runFireflyWindowBackfill: 1 GraphQL fetch + N transcript ingests
//     (~20 subreqs each: BGE embed chunks + D1 inserts + R2 puts +
//      vector index inserts). 10 transcripts/window ≈ 200 subreqs.
//   • 1-2 D1 UPDATEs (work_queue via deferWork + legacy via raw UPDATE)
//   • 1 recordFireflyApiCall ledger write
// Worst case ~225 subreqs/window. batchSize=1 keeps total at ~225,
// leaving ~775 headroom for sibling work_queue handlers + base load.
// Daily Firefly quota is the throughput bottleneck anyway (~30-50
// transcripts/day per user); batchSize=1 doesn't slow real progress.

import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { deferWork } from '../work-queue';
import { getFireflyKey } from '../firefly-credentials';
import { decryptToken } from '../encryption';
import { runFireflyWindowBackfill } from '../firefly-ingest';
import {
  recordFireflyApiCall,
  nextUtcMidnightIso,
} from '../firefly-progressive-backfill';

interface FireflyWindowPayload {
  parent_id: string;
  user_id: string;
  window_index: number;
  start_date: string;
  end_date: string;
  last_skip: number;
  transcripts_fetched: number;
  transcripts_persisted: number;
  transcripts_skipped_duplicate: number;
  transcripts_failed: number;
}

interface ParentLookupRow {
  id: string;
  api_key_encrypted: string;
  status: 'active' | 'completed' | 'partially_completed' | 'cancelled';
}

export const fireflyWindowHandler: WorkQueueHandler = {
  domain: 'firefly_window',

  // Conservative per the Phase 6.2 audit subreq math: per-window can
  // hit ~225 subreqs (1 GraphQL + 10 transcripts × ~20 each + book-
  // keeping). batchSize=1 keeps Firefly's per-tick spend bounded;
  // daily Firefly quota throttles real throughput regardless.
  batchSize: 1,

  cadence: 'minute',

  process: async (item, env) => {
    let payload: FireflyWindowPayload;
    try {
      payload = JSON.parse(item.payload) as FireflyWindowPayload;
    } catch (e) {
      throw new Error(
        `malformed payload: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const {
      parent_id, user_id, window_index, start_date, end_date,
      last_skip, transcripts_fetched, transcripts_persisted,
      transcripts_skipped_duplicate, transcripts_failed,
    } = payload;
    if (!parent_id || !user_id || window_index === undefined ||
        !start_date || !end_date) {
      throw new Error(`payload missing required fields: ${item.payload}`);
    }

    // Look up parent for two reasons: (1) cancel-mid-flight short-
    // circuit — handler must not process windows of cancelled or
    // already-finalized parents, since the legacy cancel path UPDATEs
    // parent.status to 'cancelled' but leaves work_queue rows intact;
    // (2) api_key_encrypted fallback for the two-tier Phase 4 token
    // resolution below.
    const parent = await env.D1.prepare(
      `SELECT id, api_key_encrypted, status
         FROM firefly_progressive_backfill_jobs
         WHERE id = ?`
    ).bind(parent_id).first<ParentLookupRow>();

    if (!parent) {
      // Parent missing — orphan work_queue row. Throw so it dead-
      // letters after attempts; operator can inspect.
      throw new Error(`parent ${parent_id} not found`);
    }

    if (parent.status !== 'active') {
      // Parent cancelled or already finalized while this row sat
      // pending. Treat as clean completion — no work to do, driver's
      // completeWork transitions the work_queue row to 'completed'.
      // This is the cancel-propagation path: cancel updates only the
      // parent + legacy windows; orphaned work_queue rows for that
      // parent collapse cleanly here.
      //
      // Phase 7c (2026-05-05): mark the payload with
      // `parent_terminal_at_claim` BEFORE returning so an operator
      // running detailed forensics can distinguish rows that did
      // actual work (no marker) from rows that collapsed because
      // their parent was already terminal (marker present, value
      // 'cancelled'/'completed'/'partially_completed'). The driver's
      // completeWork still fires — UI/dashboard counts unchanged —
      // but a curiosity query like
      //   SELECT COUNT(*) FROM work_queue
      //    WHERE domain='firefly_window' AND status='completed'
      //      AND json_extract(payload, '$.parent_terminal_at_claim') IS NULL
      // gives the true "actual work performed" count. Best-effort:
      // a write failure here is logged and absorbed; the row still
      // transitions to completed via the driver's terminal call so
      // the forensic detail is the only thing lost.
      try {
        const markedPayload = JSON.stringify({
          ...payload,
          parent_terminal_at_claim: parent.status,
        });
        await env.D1.prepare(
          `UPDATE work_queue SET payload = ? WHERE id = ?`
        ).bind(markedPayload, item.id).run();
      } catch (e) {
        console.warn(
          `[firefly-window] failed to write parent_terminal_at_claim marker for ${item.id}:`,
          e instanceof Error ? e.message : e
        );
      }
      return;
    }

    // Two-tier token resolution (mirrors the legacy driver's lines
    // 646–693 exactly, preserved for behavior parity):
    //   Primary: getFireflyKey from user_firefly_credentials (Phase 4)
    //   Fallback: decryptToken(parent.api_key_encrypted) for legacy
    //     pre-Phase-4 jobs (api_key_encrypted=='' is the placeholder
    //     for new jobs that rely on persistent only).
    let apiKey: string | null = null;
    try {
      apiKey = await getFireflyKey(user_id, env);
    } catch (e) {
      console.error(
        '[firefly-handler] persistent key fetch error:',
        e instanceof Error ? e.message : e
      );
    }

    if (!apiKey && parent.api_key_encrypted && parent.api_key_encrypted.length > 0) {
      try {
        const decrypted = await decryptToken(parent.api_key_encrypted, env);
        apiKey = decrypted.api_key || null;
      } catch (e) {
        console.error(
          '[firefly-handler] legacy per-job decrypt failed:',
          e instanceof Error ? e.message : e
        );
      }
    }

    if (!apiKey) {
      // No credential available. Throw → driver's failWork applies
      // 3-tier backoff. After max_attempts the row dead-letters and
      // surfaces in System Status DLQ. Legacy window is NOT updated
      // here (don't write 'failed' status; the user may set
      // credentials before max_attempts elapses, and a transient
      // dead-letter doesn't justify marking the legacy window failed).
      throw new Error(
        'no firefly key (persistent credential missing or decrypt-failed; legacy per-job key unavailable). User must set Firefly credentials.'
      );
    }

    // Run the window. Same call shape as the legacy driver line 712.
    let result;
    try {
      result = await runFireflyWindowBackfill(
        {
          userId: user_id,
          orgId: item.org_id,
          fireflyApiKey: apiKey,
          startDate: start_date,
          endDate: end_date,
          initialSkip: last_skip ?? 0,
          progressiveWindowId: item.id,  // work_queue row id for log correlation
        },
        env
      );
    } catch (e: unknown) {
      // Hard failure inside runFireflyWindowBackfill (e.g. network
      // error after retries exhausted). Update legacy window 'failed'
      // for UI continuity, then throw → driver's failWork.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await env.D1.prepare(
        `UPDATE firefly_progressive_backfill_windows
            SET status = 'failed',
                last_error = ?,
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                lock_expires_at = NULL
          WHERE parent_id = ? AND window_index = ?`
      ).bind(msg, parent_id, window_index).run();
      throw new Error(msg);
    }

    // ─── Result branching ────────────────────────────────────────────

    if (result.status === 'completed' && result.failed > 0) {
      await env.D1.prepare(
        `UPDATE firefly_progressive_backfill_windows
            SET status = 'failed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                last_skip = ?,
                transcripts_fetched           = transcripts_fetched + ?,
                transcripts_persisted         = transcripts_persisted + ?,
                transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
                transcripts_failed            = transcripts_failed + ?,
                last_error = ?,
                lock_expires_at = NULL
          WHERE parent_id = ? AND window_index = ?
            AND (SELECT status FROM firefly_progressive_backfill_jobs WHERE id = parent_id) = 'active'`
      ).bind(
        result.last_skip,
        result.total_fetched,
        result.ingested,
        result.duplicates,
        result.failed,
        `${result.failed} per-transcript failures; retrying window`,
        parent_id,
        window_index
      ).run();

      throw new Error(`${result.failed} per-transcript failures; retrying firefly window`);
    }

    if (result.status === 'completed') {
      // Update legacy window for UI continuity. Counters are absolute-
      // delta from this run (the runFireflyWindowBackfill returns
      // counts for THIS invocation, not cumulative). Legacy row's
      // counters add the deltas.
      //
      // Phase 7b (2026-05-05): correlated subquery filter on
      // parent.status='active' protects against cancel-mid-handler.
      // If operator cancelled the parent during runFireflyWindowBackfill
      // (which runs tens of seconds), this UPDATE matches 0 rows —
      // the cancel path's `status='failed'` write on the legacy window
      // stands uncontested. recordFireflyApiCall(false) below still
      // fires (Phase 3.4.1 invariant: ledger reflects API-call reality
      // regardless of parent's terminal state). Driver's completeWork
      // on the work_queue row proceeds normally; on the next tick the
      // line-99 parent-status check short-circuits naturally.
      await env.D1.prepare(
        `UPDATE firefly_progressive_backfill_windows
            SET status = 'completed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                last_skip = ?,
                transcripts_fetched           = transcripts_fetched + ?,
                transcripts_persisted         = transcripts_persisted + ?,
                transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
                transcripts_failed            = transcripts_failed + ?,
                last_error = ?,
                lock_expires_at = NULL
          WHERE parent_id = ? AND window_index = ?
            AND (SELECT status FROM firefly_progressive_backfill_jobs WHERE id = parent_id) = 'active'`
      ).bind(
        result.last_skip,
        result.total_fetched,
        result.ingested,
        result.duplicates,
        result.failed,
        result.errors && result.errors.length > 0
          ? `${result.errors.length} per-transcript errors`
          : null,
        parent_id,
        window_index
      ).run();

      // Phase 3.4.1 (preserved exactly): post-success ledger write.
      // recordFireflyApiCall(rateLimited=false) resets consecutive_429
      // ONLY on confirmed window completion. The pre-Phase-3.4.1 bug
      // had this fire pre-call which structurally prevented the
      // breaker from ever tripping for sequential workloads.
      await recordFireflyApiCall(user_id, env, false, item.org_id);

      // Return clean → driver's completeWork (filtered to
      // status='in_progress') flips the work_queue row to completed.
      return;
    }

    if (result.status === 'failed') {
      // Hard window failure (e.g. transcripts repeatedly fail to
      // persist). Update legacy + counters, throw → driver's failWork
      // with 3-tier backoff or dead_letter at attempt >= 3.
      //
      // Phase 7b (2026-05-05): cancel-mid-handler guard via correlated
      // subquery — see completed branch above for full rationale. If
      // parent was cancelled, the UPDATE no-ops; throw still fires
      // (driver's failWork applies the work_queue retry path); on the
      // next tick the line-99 parent-status check short-circuits and
      // the work_queue row collapses to 'completed' cleanly.
      await env.D1.prepare(
        `UPDATE firefly_progressive_backfill_windows
            SET status = 'failed',
                completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                last_skip = ?,
                transcripts_fetched           = transcripts_fetched + ?,
                transcripts_persisted         = transcripts_persisted + ?,
                transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
                transcripts_failed            = transcripts_failed + ?,
                last_error = ?,
                lock_expires_at = NULL
          WHERE parent_id = ? AND window_index = ?
            AND (SELECT status FROM firefly_progressive_backfill_jobs WHERE id = parent_id) = 'active'`
      ).bind(
        result.last_skip,
        result.total_fetched,
        result.ingested,
        result.duplicates,
        result.failed,
        result.reason || 'window failed',
        parent_id,
        window_index
      ).run();

      throw new Error(result.reason || 'window failed');
    }

    // ─── Paused (rate-limit or per-tick budget cap) ────────────────

    const isRateLimitPause =
      result.reason === 'firefly_rate_limit' ||
      /rate.?limit/i.test(result.reason || '');

    const nextAttemptAt = isRateLimitPause
      ? nextUtcMidnightIso()           // daily quota → defer to UTC midnight
      : new Date().toISOString();      // wallclock cap → re-claim next tick

    // Build updated payload with checkpoint state. Counters here are
    // CUMULATIVE within the work_queue row (so a paused-then-resumed
    // window's payload tracks total progress across ticks).
    const updatedPayload = JSON.stringify({
      ...payload,
      last_skip: result.last_skip,
      transcripts_fetched:           transcripts_fetched           + result.total_fetched,
      transcripts_persisted:         transcripts_persisted         + result.ingested,
      transcripts_skipped_duplicate: transcripts_skipped_duplicate + result.duplicates,
      transcripts_failed:            transcripts_failed            + result.failed,
    });

    // Phase 7a (2026-05-05): legacy-first, then deferWork.
    //
    // Original ordering had deferWork() first, then legacy UPDATE. If
    // the legacy UPDATE failed (D1 transient, network), the work_queue
    // row carried the new last_skip + counters in payload but the
    // legacy table was frozen at the prior state. Operator UI reads
    // from legacy → stale counters; eventual reclaim resumed from
    // work_queue's new last_skip while UI lagged. The audit's P0
    // dual-write-drift finding.
    //
    // Inverted order — legacy UPDATE FIRST. If legacy UPDATE fails,
    // the await throws → driver's catch fires failWork (3-tier backoff
    // or dead-letter at attempt >= 3). Trade-off: a transient D1
    // failure on the paused path now consumes an attempt instead of
    // producing silent UI drift. Acceptable: D1 transients are rare;
    // visible failure is preferable to invisible drift; 3-attempt
    // buffer before dead-letter gives the storage layer recovery
    // room. If deferWork fails AFTER legacy is updated, watchdog
    // reclaims (Phase 7a's 90s grace window absorbs CF jitter) and
    // the next handler resumes from work_queue's last consistent
    // state — INSERT OR IGNORE on transcripts saves us from
    // re-persistence at the cost of duplicate BGE work over the
    // partial range.
    //
    // The 'completed' and 'failed' branches above already follow this
    // legacy-first pattern; this brings the 'paused' branch into
    // alignment. recordFireflyApiCall(true) for rate-limit signaling
    // moves to AFTER both writes succeed so the breaker counter
    // reflects only confirmed-paused-and-checkpointed runs.
    // Phase 7b (2026-05-05): cancel-mid-handler guard via correlated
    // subquery — see completed branch above for full rationale. If
    // parent was cancelled, the UPDATE no-ops; deferWork still moves
    // the work_queue row back to 'pending' with deferred next_attempt_at.
    // On the deferred re-claim, the line-99 parent-status check
    // short-circuits and the work_queue row collapses to 'completed'.
    // Net: one wasted claim cycle on the deferred next_attempt_at;
    // no data corruption.
    await env.D1.prepare(
      `UPDATE firefly_progressive_backfill_windows
          SET last_skip = ?,
              transcripts_fetched           = transcripts_fetched + ?,
              transcripts_persisted         = transcripts_persisted + ?,
              transcripts_skipped_duplicate = transcripts_skipped_duplicate + ?,
              transcripts_failed            = transcripts_failed + ?,
              earliest_run_at = ?,
              lock_expires_at = NULL
        WHERE parent_id = ? AND window_index = ?
          AND (SELECT status FROM firefly_progressive_backfill_jobs WHERE id = parent_id) = 'active'`
    ).bind(
      result.last_skip,
      result.total_fetched,
      result.ingested,
      result.duplicates,
      result.failed,
      isRateLimitPause ? nextAttemptAt : null,  // null preserves legacy "resume next tick" semantic for non-rate-limit pauses
      parent_id,
      window_index
    ).run();

    // deferWork transitions the work_queue row back to 'pending' with
    // the deferred next_attempt_at, WITHOUT incrementing attempt
    // (Phase 6.2 1a substrate enhancement). Rate-limit pauses can recur
    // many times during a long backfill — must not consume retry
    // budget. The driver's completeWork (filtered to in_progress) is
    // a no-op once this transitions out of in_progress.
    await deferWork(env, item.id, nextAttemptAt, updatedPayload);

    if (isRateLimitPause) {
      // Phase 3.4.1 (preserved): rate-limit signal feeds the breaker.
      // 3 consecutive 429s → ledger trips circuit (cap −10%, 30-min
      // cooldown). claimNextBatch's open-circuit filter then defers
      // ALL firefly_window claims until circuit closes.
      await recordFireflyApiCall(user_id, env, true, item.org_id);
    }

    // Return clean. Row is now 'pending' via deferWork; driver's
    // completeWork is a no-op (status filter).
    return;
  },
};

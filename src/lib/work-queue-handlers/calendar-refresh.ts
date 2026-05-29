// Phase 6.1 (2026-05-05) — calendar_refresh domain handler.
//
// Second domain pilot for the universal work_queue substrate, after
// embed_retry (Phase 6). Replaces the inline pick-and-sync loop that
// lived inside driveCalendarProgressiveBackfill, which ran during the
// hourly ingestion workflow's fetch-outlook-calendar step.
//
// Architecture (Option A from Phase 6.1 audit):
//   • calendar_progressive_backfill_windows table = window registry
//     + long-lived state (last_synced_at, events_upserted). The
//     per-cycle state columns (status, attempts, last_error,
//     next_attempt_at, locked_until) are now LEGACY — the substrate
//     tracks per-cycle state in work_queue rows.
//   • work_queue (domain='calendar_refresh') = transient sync work.
//     Each refresh cycle is a fresh enqueue; completed rows stay
//     terminal. Idempotency_key includes last_synced_at so concurrent
//     staleness scans collapse cleanly while a fresh refresh after
//     sync completes generates a new key.
//   • enqueueCalendarRefreshes(orgId, env) runs on every minute tick
//     before processWorkQueueTick — scans calendar table, enqueues
//     work for never-synced AND stale-completed windows.
//
// Subrequest budget per handler invocation (steady state):
//   • 1 app-only token lookup/cache hit
//   • N pages (1 per ~50 events; usually 1, occasionally 2)
//   • N events (1 D1 INSERT/UPSERT each via upsertOutlookEvent)
// Heavy exec week: ~103 subreqs/window. With batchSize=5, worst-case
// handler spend per minute tick: ~515 subreqs — comfortably under the
// 1000-subreq CF cap with ~480 subreqs of headroom.
//
// Behavior change vs. prior driver:
//   • Cadence: hourly (ingestion workflow) → minute (work_queue tick).
//     ~60× faster healing for never-synced and stale-completed paths.
//   • Failure tracking: per-row attempts on calendar_progressive_
//     backfill_windows → work_queue's three-tier backoff [5min, 30min]
//     then dead_letter. Failed cycles surface as work_queue:
//     calendar_refresh in System Status DLQ.
//   • Auth failures route through work_queue retry/dead-letter. Per-user
//     delegated refresh is only available when the emergency fallback is enabled.

import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { deadLetterWork } from '../work-queue';
import { getGraphMailboxAuthForUser } from '../graph-auth';
import { upsertOutlookEvent } from '../reconciliation';
import {
  fetchEventsForWindow,
  recordCalendarSyncSuccess,
} from '../calendar-progressive-backfill';

interface CalendarRefreshPayload {
  window_id: string;
  user_id: string;
  window_start: string;
  window_end: string;
}

export const calendarRefreshHandler: WorkQueueHandler = {
  domain: 'calendar_refresh',

  // Per Phase 6.1 design (2026-05-05): batchSize=5 keeps heavy-case
  // subreq spend at ~515/tick, leaving comfortable margin under the
  // 1000-subreq CF cap. Calendar windows can be expensive (up to ~100
  // subreqs each for 100-event exec weeks); 10 would exceed the cap.
  batchSize: 5,

  cadence: 'minute',

  process: async (item, env) => {
    let payload: CalendarRefreshPayload;
    try {
      payload = JSON.parse(item.payload) as CalendarRefreshPayload;
    } catch (e) {
      throw new Error(
        `malformed payload: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const { window_id, user_id, window_start, window_end } = payload;
    if (!window_id || !user_id || !window_start || !window_end) {
      throw new Error(`payload missing required fields: ${item.payload}`);
    }

    let auth: { token: string; mailbox: string };
    try {
      auth = await getGraphMailboxAuthForUser(user_id, item.org_id, env);
    } catch (e) {
      const message = `graph_auth_failed:${e instanceof Error ? e.message : String(e)}`;
      if (/missing app-only|not set|No Outlook mailbox/i.test(message)) {
        await deadLetterWork(env, item.id, message.slice(0, 500));
        return;
      }
      throw new Error(message);
    }

    // Fetch events for this single window. fetchEventsForWindow does
    // pagination internally with checkGraphRateLimit gating each page
    // (so a tripped Graph circuit halts the fetch loop early). It
    // throws on hard failures (non-2xx, network); we re-throw to let
    // the driver's failWork apply backoff. recordRateLimit / 429
    // tracking happens inside checkGraphRateLimit's downstream callers.
    const events = await fetchEventsForWindow(
      auth.token, auth.mailbox, user_id, window_start, window_end, item.org_id, env
    );

    // Per-event upsert. ON CONFLICT(outlook_event_id) makes this safe
    // to retry — the same window re-processed produces no duplicate
    // events. A per-event failure now fails the whole work item so the
    // window cannot be marked successfully synced with missing events.
    let upserted = 0;
    const upsertErrors: string[] = [];
    for (const event of events) {
      try {
        await upsertOutlookEvent(event, item.org_id, env);
        upserted++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[calendar-refresh] upsert failed for event=${event.id} user=${user_id}:`,
          msg
        );
        upsertErrors.push(`${event.id}:${msg.slice(0, 160)}`);
      }
    }
    if (upsertErrors.length > 0) {
      throw new Error(`calendar_upsert_failed count=${upsertErrors.length} sample=${upsertErrors.slice(0, 3).join('; ')}`);
    }

    // Update the calendar window's long-lived state. work_queue
    // tracks status/attempt/last_error itself; the calendar table
    // now only stores checkpoint state (last_synced_at +
    // events_upserted). The next staleness scan in
    // enqueueCalendarRefreshes computes a new idempotency_key from
    // the freshly bumped last_synced_at, so the next refresh cycle
    // creates a distinct work_queue row.
    await recordCalendarSyncSuccess(window_id, upserted, env);
  },
};

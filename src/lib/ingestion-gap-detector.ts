// Ingestion gap detector — finds days with missing email ingestion and
// kicks off targeted progressive backfills.
//
// Why this exists: 2026-05-09 incident. All Microsoft Graph push
// subscriptions expired and were not recreated (renewExpiringSubscriptions
// renews-or-deletes but never recreates). Push delivery stopped silently
// for 4 days. Delta-poll continued but underperformed at 0-25 items/run.
// The system reported sync_jobs status=completed throughout — classic
// substrate-vs-handler regression with no observability at the data-
// landed layer. This module closes the loop by inspecting actual
// conversations row counts per (user, day) and enqueueing a 1-day
// progressive backfill window for any day that looks dark.
//
// Scope: medina-ventures user pool today (~3 active mailboxes). Per-tick
// cost: 1 SELECT per user + 1 KV read + (if gap) 1 progressive_backfill_
// jobs INSERT + N window INSERTs. Idempotent — the progressive_backfill_
// jobs "one active parent per user" guard prevents double-enqueue, and
// the per-user KV cooldown prevents thrash.

import type { Env } from '../types/env';
import { createProgressiveBackfillRange } from './progressive-backfill';

// Floor for "is this day a gap" — even for low-baseline users we want
// at least this many rows. A user with median 4/day and a day with 0 is
// still a gap. Without this floor the relative threshold below would
// flag every quiet weekend even for users with steady volume.
const ABSOLUTE_FLOOR = 2;

// Relative gap threshold — a day below baseline_median × this fraction
// counts as a gap. 0.25 = "less than a quarter of typical volume".
// Tuned for Outlook: a working user typically has variance ~3x within
// a week (weekend dips), so 0.25 is below that natural floor — only
// fires on real silent-failure modes (push died, delta token bricked).
const GAP_THRESHOLD_FRACTION = 0.25;

// Lookback window. We don't check today (still landing rows) or anything
// older than this. 14 days is the practical re-ingestion ceiling for
// Microsoft Graph delta queries; beyond it, the historical backfill
// pipeline is the right tool.
const LOOKBACK_DAYS = 14;

// Cooldown between successive auto-backfill kick-offs for the same user.
// Keeps the detector from re-enqueueing the same range every hour while
// the previous job is still draining. The progressive_backfill_jobs
// "one active parent" guard already prevents double-creation, but this
// is a defense-in-depth marker that survives parent completion (so we
// don't oscillate between "completed but still 0 emails landed" → re-
// enqueue → completed → re-enqueue).
const COOLDOWN_HOURS = 6;

// Minimum baseline volume — skip detection for users whose entire 14-day
// window averages below this. Low-volume users don't have meaningful
// "gap" signal; their day-to-day variance dominates.
const MIN_USER_BASELINE = 30;

interface UserCheckResult {
  user_id: string;
  user_name: string;
  total_emails_14d: number;
  gap_days: string[];
  kicked_off: boolean;
  reason?: string;
}

export interface GapDetectionSummary {
  org_id: string;
  users_checked: number;
  users_with_gaps: number;
  backfills_kicked: number;
  per_user: UserCheckResult[];
}

export async function detectAndHealOutlookGaps(
  orgId: string,
  env: Env
): Promise<GapDetectionSummary> {
  // Active mailbox users — must have BOTH outlook_token and outlook_delta_token.
  // outlook_token alone isn't enough: it means OAuth completed but delta sync
  // never ran (e.g. Lucas). Such accounts have legitimately zero outbound
  // emails and would produce false-positive gaps on every day.
  const users = await env.D1.prepare(
    `SELECT id, full_name FROM users
       WHERE org_id = ? AND deleted_at IS NULL
         AND outlook_token IS NOT NULL
         AND outlook_delta_token IS NOT NULL`
  ).bind(orgId).all<{ id: string; full_name: string }>();

  const summary: GapDetectionSummary = {
    org_id: orgId,
    users_checked: 0,
    users_with_gaps: 0,
    backfills_kicked: 0,
    per_user: [],
  };

  for (const user of users.results) {
    summary.users_checked++;
    const result = await checkAndHealOneUser(orgId, user.id, user.full_name, env);
    summary.per_user.push(result);
    if (result.gap_days.length > 0) summary.users_with_gaps++;
    if (result.kicked_off) summary.backfills_kicked++;
  }

  return summary;
}

async function checkAndHealOneUser(
  orgId: string,
  userId: string,
  userName: string,
  env: Env
): Promise<UserCheckResult> {
  const result: UserCheckResult = {
    user_id: userId,
    user_name: userName,
    total_emails_14d: 0,
    gap_days: [],
    kicked_off: false,
  };

  // Daily counts for the user's emails over the lookback window.
  // We exclude today (sent_at > now-Nd AND sent_at < start_of_today)
  // because partial-day data would always look like a gap.
  const rows = await env.D1.prepare(
    `SELECT DATE(sent_at) AS day, COUNT(*) AS cnt
       FROM conversations
      WHERE org_id = ?
        AND source = 'outlook'
        AND participant_user_ids LIKE ?
        AND sent_at >= DATE('now', '-' || ? || ' days')
        AND sent_at < DATE('now')
      GROUP BY DATE(sent_at)`
  ).bind(orgId, `%${userId}%`, LOOKBACK_DAYS).all<{ day: string; cnt: number }>();

  const dayCounts = new Map<string, number>();
  for (const r of rows.results) {
    dayCounts.set(r.day, r.cnt);
    result.total_emails_14d += r.cnt;
  }

  // Skip low-volume users — their data is too noisy to detect gaps.
  if (result.total_emails_14d < MIN_USER_BASELINE) {
    result.reason = `baseline too low (${result.total_emails_14d} < ${MIN_USER_BASELINE})`;
    return result;
  }

  // Per-user adaptive threshold. Median of all 14 days' counts gives a
  // baseline that adapts to the user's natural volume. The relative
  // threshold catches "volume crashed but isn't literally zero" — the
  // 2026-05-09 incident showed Alvaro's volume drop 200/day → 2-5/day
  // when push died, which a hardcoded "< 2" rule would have missed.
  const sortedCounts = [...dayCounts.values()].sort((a, b) => a - b);
  const median = sortedCounts.length > 0
    ? sortedCounts[Math.floor(sortedCounts.length / 2)]
    : 0;
  const threshold = Math.max(ABSOLUTE_FLOOR, Math.floor(median * GAP_THRESHOLD_FRACTION));

  // Walk each day in the lookback window. Days entirely missing from
  // dayCounts are 0-email days; days present but below threshold also
  // count.
  const gapDays: string[] = [];
  const today = new Date();
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const dayStr = d.toISOString().slice(0, 10);
    const cnt = dayCounts.get(dayStr) || 0;
    if (cnt < threshold) gapDays.push(dayStr);
  }
  result.gap_days = gapDays;
  if (gapDays.length === 0) return result;

  // KV cooldown — don't re-kick within COOLDOWN_HOURS even if a previous
  // attempt didn't fully close the gap. Avoids enqueue thrash.
  const cooldownKey = `gap_detect_cooldown:outlook:${userId}`;
  const cooldown = await env.KV.get(cooldownKey);
  if (cooldown) {
    result.reason = 'cooldown active';
    return result;
  }

  // Compute a contiguous range covering all gap days. createProgressive
  // BackfillRange will fan into individual 1-day windows.
  const sorted = [...gapDays].sort();
  const startDate = sorted[0];
  // end_date is exclusive in our windowing convention; bump by 1 day.
  const endDate = new Date(new Date(sorted[sorted.length - 1] + 'T00:00:00Z').getTime() + 86400000)
    .toISOString().slice(0, 10);

  const created = await createProgressiveBackfillRange(
    orgId,
    userId,
    startDate,
    endDate,
    1, // 1-day windows — each gap day is its own backfill unit
    env
  );

  if (!created.created) {
    // Likely "user already has active parent" — that's the desired
    // idempotent behavior, the existing job will fill the gap.
    result.reason = created.reason || 'createProgressiveBackfillRange refused';
    return result;
  }

  await env.KV.put(cooldownKey, new Date().toISOString(), {
    expirationTtl: COOLDOWN_HOURS * 3600,
  });

  result.kicked_off = true;
  result.reason = `parent=${created.parent_id} windows=${created.total_windows}`;
  return result;
}

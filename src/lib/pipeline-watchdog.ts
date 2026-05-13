// Universal pipeline heartbeat watchdog — last-resort safety net for
// every ingestion source.
//
// Why: 2026-05-13 incident showed two simultaneous silent failures —
// Outlook (push subscriptions all expired, gap detector code committed
// but never shipped, 15-day dark window) and Firefly (transcripts
// stopped 8 days ago, no detector existed at all). The per-pipeline gap
// detectors are the first line of defense (baseline-relative, per-user,
// catches partial degradations). This watchdog is the absolute floor:
// for each pipeline check the SINGLE-MOST-RECENT row in its target
// table, and if that row is older than a per-pipeline staleness
// threshold, trigger heal actions.
//
// Pipelines covered:
//   • Outlook  — heartbeat = max(conversations.sent_at WHERE source='outlook')
//                heal = ensureSubscriptionsForActiveUsers + detectAndHealOutlookGaps
//   • Firefly  — heartbeat = max(events.created_at WHERE transcript_r2_key IS NOT NULL)
//                heal = createFireflyProgressiveBackfillRange for every user with
//                       stored credentials, 7-day range, 1-day windows
//   • Slack    — heartbeat = max(conversations.sent_at WHERE source='slack')
//                heal = log-only (org has low Slack volume, no automatic
//                recovery wired; presence of WARNING in logs surfaces it
//                to the operator)
//
// Per-pipeline KV cooldown (default 4h) prevents the watchdog from re-
// triggering heals every hour while a backfill is already draining.
// Stricter than the Outlook gap detector's per-user 6h cooldown because
// the watchdog fires WHOLE-pipeline heals (multiple parents) rather
// than per-user.

import type { Env } from '../types/env';

interface PipelineHealth {
  pipeline: 'outlook' | 'firefly' | 'slack';
  last_activity_at: string | null;
  hours_stale: number | null;
  status: 'healthy' | 'stale' | 'no_data';
  heal_triggered: boolean;
  heal_summary?: string;
}

export interface WatchdogSummary {
  org_id: string;
  pipelines: PipelineHealth[];
  generated_at: string;
}

// Staleness thresholds — past these, pipeline considered dark and heal
// fires. Tuned per-pipeline observed cadence.
//   Outlook: real-time push + delta-poll. 6h dark is severe (a normal
//   workday averages 100-200 emails/day; 0 in 6h on a weekday means push
//   is dead AND delta isn't recovering).
//   Firefly: webhook-driven, recordings batch-uploaded post-meeting. 36h
//   dark accommodates legitimate quiet days (weekend + Monday morning).
//   Slack: hourly poll, very low org volume. 48h dark.
const STALE_HOURS = {
  outlook: 6,
  firefly: 36,
  slack: 48,
};

const COOLDOWN_HOURS = 4;

export async function runPipelineWatchdog(
  orgId: string,
  env: Env
): Promise<WatchdogSummary> {
  const summary: WatchdogSummary = {
    org_id: orgId,
    pipelines: [],
    generated_at: new Date().toISOString(),
  };

  summary.pipelines.push(await checkOutlookPipeline(orgId, env));
  summary.pipelines.push(await checkFireflyPipeline(orgId, env));
  summary.pipelines.push(await checkSlackPipeline(orgId, env));

  return summary;
}

async function readHeartbeat(
  env: Env,
  query: string,
  binds: unknown[]
): Promise<{ last_activity_at: string | null; hours_stale: number | null }> {
  const row = await env.D1.prepare(query).bind(...binds).first<{ last: string | null }>();
  const last = row?.last || null;
  if (!last) return { last_activity_at: null, hours_stale: null };
  const ms = new Date(last).getTime();
  if (Number.isNaN(ms)) return { last_activity_at: last, hours_stale: null };
  return { last_activity_at: last, hours_stale: (Date.now() - ms) / 3_600_000 };
}

async function checkOutlookPipeline(orgId: string, env: Env): Promise<PipelineHealth> {
  const hb = await readHeartbeat(
    env,
    `SELECT MAX(sent_at) AS last FROM conversations WHERE org_id = ? AND source = 'outlook'`,
    [orgId]
  );

  const base: PipelineHealth = {
    pipeline: 'outlook',
    last_activity_at: hb.last_activity_at,
    hours_stale: hb.hours_stale,
    status: hb.hours_stale === null ? 'no_data' : hb.hours_stale < STALE_HOURS.outlook ? 'healthy' : 'stale',
    heal_triggered: false,
  };

  if (base.status !== 'stale') return base;

  const cooldownKey = `watchdog_cooldown:outlook:${orgId}`;
  if (await env.KV.get(cooldownKey)) {
    base.heal_summary = 'cooldown active';
    return base;
  }

  console.warn(
    `[watchdog] Outlook pipeline stale for ${orgId}: last activity ${hb.hours_stale?.toFixed(1)}h ago, triggering heal`
  );

  const healParts: string[] = [];
  try {
    const { ensureSubscriptionsForActiveUsers } = await import('./graph-subscriptions');
    await ensureSubscriptionsForActiveUsers(env);
    healParts.push('subscriptions ensured');
  } catch (e) {
    console.error(`[watchdog] outlook heal: ensureSubscriptionsForActiveUsers failed:`, e);
    healParts.push('subscriptions FAILED');
  }

  try {
    const { detectAndHealOutlookGaps } = await import('./ingestion-gap-detector');
    const gapSummary = await detectAndHealOutlookGaps(orgId, env);
    healParts.push(
      `gap-detector: checked=${gapSummary.users_checked} with_gaps=${gapSummary.users_with_gaps} kicked=${gapSummary.backfills_kicked}`
    );
  } catch (e) {
    console.error(`[watchdog] outlook heal: detectAndHealOutlookGaps failed:`, e);
    healParts.push('gap-detector FAILED');
  }

  await env.KV.put(cooldownKey, new Date().toISOString(), {
    expirationTtl: COOLDOWN_HOURS * 3600,
  });
  base.heal_triggered = true;
  base.heal_summary = healParts.join('; ');
  return base;
}

async function checkFireflyPipeline(orgId: string, env: Env): Promise<PipelineHealth> {
  const hb = await readHeartbeat(
    env,
    `SELECT MAX(created_at) AS last FROM events
       WHERE org_id = ? AND deleted_at IS NULL AND transcript_r2_key IS NOT NULL`,
    [orgId]
  );

  const base: PipelineHealth = {
    pipeline: 'firefly',
    last_activity_at: hb.last_activity_at,
    hours_stale: hb.hours_stale,
    status: hb.hours_stale === null ? 'no_data' : hb.hours_stale < STALE_HOURS.firefly ? 'healthy' : 'stale',
    heal_triggered: false,
  };

  if (base.status !== 'stale') return base;

  const cooldownKey = `watchdog_cooldown:firefly:${orgId}`;
  if (await env.KV.get(cooldownKey)) {
    base.heal_summary = 'cooldown active';
    return base;
  }

  console.warn(
    `[watchdog] Firefly pipeline stale for ${orgId}: last transcript ${hb.hours_stale?.toFixed(1)}h ago, triggering heal`
  );

  // Identify users with stored Firefly credentials. createFireflyProgressiveBackfillRange
  // resolves keys from user_firefly_credentials when fireflyApiKey arg is null, so we just
  // need the user IDs and a presence-check on the credentials table.
  let users: Array<{ id: string; full_name: string }> = [];
  try {
    const r = await env.D1.prepare(
      `SELECT u.id, u.full_name
         FROM users u
        WHERE u.org_id = ? AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM user_firefly_credentials ufc WHERE ufc.user_id = u.id)`
    ).bind(orgId).all<{ id: string; full_name: string }>();
    users = r.results;
  } catch (e) {
    console.error(`[watchdog] firefly heal: user query failed:`, e);
    base.heal_summary = 'user query failed';
    return base;
  }

  if (users.length === 0) {
    base.heal_summary = 'no users with stored firefly credentials';
    // Still set cooldown so we don't keep logging on every tick.
    await env.KV.put(cooldownKey, new Date().toISOString(), {
      expirationTtl: COOLDOWN_HOURS * 3600,
    });
    return base;
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  let enqueued = 0;
  const reasons: string[] = [];

  try {
    const { createFireflyProgressiveBackfillRange } = await import('./firefly-progressive-backfill');
    for (const u of users) {
      try {
        const r = await createFireflyProgressiveBackfillRange(
          orgId, u.id, startDate, endDate, 1, null, env
        );
        if (r.created) {
          enqueued++;
          console.log(`[watchdog] firefly heal: enqueued 7-day backfill for ${u.full_name} (parent=${r.parent_id} windows=${r.total_windows})`);
        } else {
          reasons.push(`${u.full_name}:${r.reason || 'refused'}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reasons.push(`${u.full_name}:throw ${msg.slice(0, 60)}`);
      }
    }
  } catch (e) {
    console.error(`[watchdog] firefly heal: import failed:`, e);
    base.heal_summary = 'firefly module import failed';
    return base;
  }

  await env.KV.put(cooldownKey, new Date().toISOString(), {
    expirationTtl: COOLDOWN_HOURS * 3600,
  });
  base.heal_triggered = enqueued > 0;
  base.heal_summary =
    enqueued > 0
      ? `enqueued ${enqueued}/${users.length} 7d backfills` + (reasons.length ? ` (skipped: ${reasons.join(', ')})` : '')
      : `0 backfills enqueued: ${reasons.join(', ')}`;
  return base;
}

async function checkSlackPipeline(orgId: string, env: Env): Promise<PipelineHealth> {
  const hb = await readHeartbeat(
    env,
    `SELECT MAX(sent_at) AS last FROM conversations WHERE org_id = ? AND source = 'slack'`,
    [orgId]
  );

  const base: PipelineHealth = {
    pipeline: 'slack',
    last_activity_at: hb.last_activity_at,
    hours_stale: hb.hours_stale,
    status: hb.hours_stale === null ? 'no_data' : hb.hours_stale < STALE_HOURS.slack ? 'healthy' : 'stale',
    heal_triggered: false,
  };

  if (base.status !== 'stale') return base;

  // Slack heal is log-only — there's no per-channel auto-recovery wired
  // (the webhook consumer ack's events without routing, so the hourly
  // fetchSlackMessages poller is the only ingestion path; if it's been
  // failing, an operator needs to investigate auth/permissions). The
  // KV cooldown still applies so we don't spam the log every hour.
  const cooldownKey = `watchdog_cooldown:slack:${orgId}`;
  if (await env.KV.get(cooldownKey)) {
    base.heal_summary = 'cooldown active (log-only pipeline)';
    return base;
  }

  console.warn(
    `[watchdog] Slack pipeline stale for ${orgId}: last activity ${hb.hours_stale?.toFixed(1)}h ago — no auto-heal wired, operator action required`
  );

  await env.KV.put(cooldownKey, new Date().toISOString(), {
    expirationTtl: COOLDOWN_HOURS * 3600,
  });
  base.heal_summary = 'logged (no auto-heal)';
  return base;
}

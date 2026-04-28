// Command Center backend — three endpoints powering the real-time dashboard.
// All read-only, no writes. Intentionally cheap: pulse uses one D1 query +
// a handful of KV reads; activity uses a few aggregate counts; sparklines
// buckets sync_jobs by hour. No per-call telemetry exists, so we estimate
// API volume from sync_jobs metadata.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse } from './utils';

// ────────────────────────────────────────────────────────────────────────────
// /api/dashboard/pulse — every 5s while the dashboard is open.
// ────────────────────────────────────────────────────────────────────────────

export interface ActiveProcess {
  id: string;
  type: 'ingestion' | 'enrichment' | 'daily_cron' | 'backfill' | 'import' | 'other';
  label: string;
  started_at: string;
  elapsed_seconds: number;
  progress?: { current: number; total?: number; percentage?: number };
  status: 'running' | 'finalizing';
}

export interface CapacityGauge {
  used: number;
  limit: number;
  percentage: number;
  label: string;
  status: 'low' | 'moderate' | 'high' | 'limited' | 'unknown';
}

export interface ServiceStatus {
  status: 'healthy' | 'rate_limited' | 'auth_failed' | 'circuit_open' | 'active' | 'unknown';
  label: string;
  blocked_until?: string;
}

export interface PulseResponse {
  system_status: 'healthy' | 'busy' | 'degraded' | 'error';
  status_message: string;
  active_processes: ActiveProcess[];
  capacity: {
    claude: CapacityGauge & { last_call_at?: string | null };
    gemini: CapacityGauge & { last_call_at?: string | null; window_resets_at?: string | null };
    graph: CapacityGauge & { window_resets_at?: string | null };
    slack: ServiceStatus & { last_sync_at?: string | null; messages_today?: number };
    reversecontact: ServiceStatus & { last_enrichment_at?: string | null; enriched_today?: number };
  };
  alerts: Array<{ type: 'warning' | 'error'; message: string; timestamp: string }>;
  // Idle-state context: next scheduled cron fires (ISO).
  next_runs: {
    ingestion: string;
    enrichment: string;
    daily: string;
  };
}

const WORKFLOW_LABEL: Record<string, { type: ActiveProcess['type']; label: string }> = {
  ingestion: { type: 'ingestion', label: 'Email, Slack & news sync' },
  enrichment: { type: 'enrichment', label: 'Contact & company enrichment' },
  daily: { type: 'daily_cron', label: 'Daily maintenance' },
  manual_date_range: { type: 'backfill', label: 'Custom date-range backfill' },
  intelligent: { type: 'import', label: 'Document import' },
};

function describeWorkflow(workflowType: string, metadata: any): { type: ActiveProcess['type']; label: string } {
  if (metadata?.trigger === 'manual_date_range') {
    return { type: 'backfill', label: 'Custom date-range backfill' };
  }
  return WORKFLOW_LABEL[workflowType] || { type: 'other', label: workflowType };
}

function progressFromMetadata(workflowType: string, metadata: any, itemsProcessed: number): ActiveProcess['progress'] {
  if (workflowType === 'ingestion' && metadata) {
    const fetched = (metadata.fetched_outlook || 0) +
      (metadata.fetched_slack || 0) +
      (metadata.fetched_news || 0) +
      (metadata.fetched_calendar || 0);
    if (fetched > 0) {
      const total = fetched;
      const current = itemsProcessed || 0;
      return { current, total, percentage: Math.min(100, Math.round((current / total) * 100)) };
    }
  }
  if (itemsProcessed > 0) {
    return { current: itemsProcessed };
  }
  return undefined;
}

function gaugeFor(used: number, limit: number, name: string): CapacityGauge {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  let status: CapacityGauge['status'];
  let label: string;
  if (pct >= 90) { status = 'limited'; label = `${name}: rate limited`; }
  else if (pct >= 70) { status = 'high'; label = `${name}: heavy usage`; }
  else if (pct >= 30) { status = 'moderate'; label = `${name}: moderate`; }
  else { status = 'low'; label = `${name}: light usage`; }
  return { used, limit, percentage: Math.round(pct), label, status };
}

// Compute the next firing time of a cron pattern. Supports our three
// schedules: '0 * * * *' (top of hour), '5 * * * *' (5 past hour), and
// '0 0 * * *' (midnight UTC).
function nextCronFire(pattern: string, now: Date = new Date()): string {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  if (pattern === '0 0 * * *') {
    next.setUTCHours(0, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  // Hourly patterns: 'M * * * *'
  const minute = parseInt(pattern.split(' ')[0], 10);
  if (Number.isFinite(minute)) {
    next.setUTCMinutes(minute, 0, 0);
    if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  // Fallback: 1 hour from now
  return new Date(now.getTime() + 3600_000).toISOString();
}

// Boundary of "today" in UTC — used for the "+N today" deltas in the stats
// bar and for messages_today / enriched_today on capacity cards.
function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function getDashboardPulse(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const orgId = ctx.orgId;
  const nowIso = new Date().toISOString();

  // ── Active workflows ────────────────────────────────────────────────────
  const running = await env.D1.prepare(
    `SELECT id, workflow_type, status, started_at, items_processed, metadata
       FROM sync_jobs
      WHERE org_id = ? AND status = 'running'
        AND (timeout_at IS NULL OR timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY started_at DESC`
  ).bind(orgId).all<{
    id: string; workflow_type: string; status: string; started_at: string;
    items_processed: number; metadata: string | null;
  }>();

  const active_processes: ActiveProcess[] = running.results.map(r => {
    let metadata: any = {};
    try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
    const { type, label } = describeWorkflow(r.workflow_type, metadata);
    const startedMs = new Date(r.started_at).getTime();
    const elapsed = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    return {
      id: r.id,
      type, label,
      started_at: r.started_at,
      elapsed_seconds: elapsed,
      progress: progressFromMetadata(r.workflow_type, metadata, r.items_processed),
      status: 'running',
    };
  });

  // ── Capacity gauges ─────────────────────────────────────────────────────
  // We don't track per-minute call counters in KV (they only get written when
  // the rate limiter backs off). Treat absence as "low usage". When a rate
  // limit IS active, pin the gauge at "limited".
  const claudeMax = parseInt((env as any).CLAUDE_MAX_RPM || '60', 10);
  const geminiMax = parseInt((env as any).GEMINI_MAX_RPM || '500', 10);
  const graphMax = 10000;

  const todayStart = startOfTodayUtc();

  const [
    claudeBackoff, geminiBackoff, geminiNewsBackoff, graphState,
    rcCircuitRaw, rcRateRaw, slackLastSyncRaw,
    lastEnrichmentRow, slackTodayRow, rcEnrichedTodayRow,
  ] = await Promise.all([
    env.KV.get(`rate_limit:claude:${orgId}`),
    env.KV.get(`rate_limit:gemini_enrichment:${orgId}`),
    env.KV.get(`rate_limit:gemini_news:${orgId}`),
    env.KV.get<{ count?: number; window_start?: string }>(`graph_rpm:${orgId}`, 'json'),
    env.KV.get(`rc_failures:${orgId}`),
    env.KV.get<{ blocked_until?: string }>(`rate_limit:reversecontact:${orgId}`, 'json'),
    env.KV.get(`slack_last_sync:${orgId}`),
    // Last enrichment cycle is our best proxy for "last Claude/Gemini call"
    // since we don't write per-call timestamps. Cheap single row read.
    env.D1.prepare(
      `SELECT MAX(completed_at) as t FROM sync_jobs WHERE org_id = ? AND workflow_type = 'enrichment' AND status = 'completed'`
    ).bind(orgId).first<{ t: string | null }>(),
    env.D1.prepare(
      `SELECT COUNT(*) as n FROM conversations WHERE org_id = ? AND source = 'slack' AND created_at >= ?`
    ).bind(orgId, todayStart).first<{ n: number }>(),
    env.D1.prepare(
      `SELECT COUNT(*) as n FROM contacts WHERE org_id = ? AND linkedin_data_r2_key IS NOT NULL AND updated_at >= ? AND deleted_at IS NULL`
    ).bind(orgId, todayStart).first<{ n: number }>(),
  ]);

  const lastEnrichmentAt = lastEnrichmentRow?.t || null;
  const slackLastSyncAt = slackLastSyncRaw || null;

  const claude = {
    ...(claudeBackoff
      ? gaugeFor(claudeMax, claudeMax, 'Claude')
      : gaugeFor(0, claudeMax, 'Claude')),
    last_call_at: lastEnrichmentAt,
  };
  const geminiLimited = !!(geminiBackoff || geminiNewsBackoff);
  const gemini = {
    ...(geminiLimited
      ? gaugeFor(geminiMax, geminiMax, 'Gemini')
      : gaugeFor(0, geminiMax, 'Gemini')),
    last_call_at: lastEnrichmentAt,
    // Rate-limit windows reset 60s after the backoff was set; we don't
    // store the exact timestamp, so estimate "soon" as 60s from now when
    // limited.
    window_resets_at: geminiLimited ? new Date(Date.now() + 60_000).toISOString() : null,
  };
  const graphUsed = graphState?.count || 0;
  // Graph soft limit is 10k per 10min — window resets 10min after start.
  const graphWindowStart = graphState?.window_start ? new Date(graphState.window_start).getTime() : 0;
  const graph = {
    ...gaugeFor(graphUsed, graphMax, 'Microsoft Graph'),
    window_resets_at: graphWindowStart > 0 ? new Date(graphWindowStart + 10 * 60_000).toISOString() : null,
  };

  const slack = {
    status: 'healthy' as const,
    label: 'Active',
    last_sync_at: slackLastSyncAt,
    messages_today: slackTodayRow?.n || 0,
  };

  const rcFailures = rcCircuitRaw ? parseInt(rcCircuitRaw, 10) : 0;
  let reversecontact: PulseResponse['capacity']['reversecontact'];
  const rcEnrichedToday = rcEnrichedTodayRow?.n || 0;
  if (rcFailures >= 3) {
    reversecontact = {
      status: 'circuit_open',
      label: 'Paused — auth issue, needs operator reset',
      enriched_today: rcEnrichedToday,
      last_enrichment_at: lastEnrichmentAt,
    };
  } else if (rcRateRaw?.blocked_until && new Date(rcRateRaw.blocked_until) > new Date()) {
    reversecontact = {
      status: 'rate_limited',
      label: 'Rate limited',
      blocked_until: rcRateRaw.blocked_until,
      enriched_today: rcEnrichedToday,
      last_enrichment_at: lastEnrichmentAt,
    };
  } else {
    reversecontact = {
      status: 'active',
      label: 'Active',
      enriched_today: rcEnrichedToday,
      last_enrichment_at: lastEnrichmentAt,
    };
  }

  // ── Alerts ──────────────────────────────────────────────────────────────
  const alerts: PulseResponse['alerts'] = [];
  if (rcFailures >= 3) {
    alerts.push({ type: 'error', message: 'ReverseContact API key rejected (3+ failures). Verify the key in Settings → Integrations.', timestamp: nowIso });
  } else if (rcRateRaw?.blocked_until && new Date(rcRateRaw.blocked_until) > new Date()) {
    const minsLeft = Math.ceil((new Date(rcRateRaw.blocked_until).getTime() - Date.now()) / 60000);
    alerts.push({ type: 'warning', message: `ReverseContact rate limited — resumes in ${minsLeft}m`, timestamp: nowIso });
  }
  if (claudeBackoff) {
    alerts.push({ type: 'warning', message: 'Claude API rate limit hit — enrichment paused briefly', timestamp: nowIso });
  }
  if (geminiBackoff || geminiNewsBackoff) {
    alerts.push({ type: 'warning', message: 'Gemini rate limit hit — web enrichment paused briefly', timestamp: nowIso });
  }

  // Stuck job check — running for > 30 min is suspicious
  const stuck = running.results.filter(r => Date.now() - new Date(r.started_at).getTime() > 30 * 60_000);
  if (stuck.length > 0) {
    alerts.push({ type: 'warning', message: `${stuck.length} long-running job${stuck.length === 1 ? '' : 's'} (>30 min). May be stuck.`, timestamp: nowIso });
  }

  // ── System status synthesis ─────────────────────────────────────────────
  let system_status: PulseResponse['system_status'];
  let status_message: string;
  if (alerts.some(a => a.type === 'error')) {
    system_status = 'error';
    status_message = `${alerts.filter(a => a.type === 'error').length} issue${alerts.filter(a => a.type === 'error').length === 1 ? '' : 's'} need attention`;
  } else if (alerts.length > 0) {
    system_status = 'degraded';
    status_message = alerts.length === 1
      ? alerts[0].message
      : `${alerts.length} services with limited capacity`;
  } else if (active_processes.length > 0) {
    system_status = 'busy';
    status_message = active_processes.length === 1
      ? `${active_processes[0].label} in progress`
      : `${active_processes.length} processes running`;
  } else {
    system_status = 'healthy';
    status_message = 'All systems operational';
  }

  // Cron schedule from wrangler.toml: 0 * * * * = ingestion, 5 * * * * =
  // enrichment, 0 0 * * * = daily maintenance.
  const next_runs = {
    ingestion: nextCronFire('0 * * * *'),
    enrichment: nextCronFire('5 * * * *'),
    daily: nextCronFire('0 0 * * *'),
  };

  return jsonResponse({
    system_status,
    status_message,
    active_processes,
    capacity: { claude, gemini, graph, slack, reversecontact },
    alerts,
    next_runs,
  } satisfies PulseResponse);
}

// ────────────────────────────────────────────────────────────────────────────
// /api/dashboard/activity — every 30s. Recent activity + 24h stats.
// ────────────────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  id: string;
  type: string;
  icon: 'email' | 'enrichment' | 'meeting' | 'import' | 'cron' | 'error' | 'news' | 'cleanup';
  label: string;
  description: string;
  timestamp: string;
  result?: { processed?: number; created?: number; enriched?: number; failed?: number };
}

export interface ActivityResponse {
  recent_activity: ActivityEntry[];
  stats_24h: {
    emails_synced: number;
    contacts_discovered: number;
    contacts_enriched: number;
    companies_enriched: number;
    meetings_ingested: number;
    slack_messages: number;
    documents_processed: number;
    approval_items_created: number;
    approval_items_resolved: number;
  };
  // Counts since UTC midnight today — used for "+N today" deltas in the
  // stats bar so users see momentum, not just the rolling 24h total.
  stats_today: {
    emails_synced: number;
    contacts_discovered: number;
    contacts_enriched: number;
    meetings_ingested: number;
    documents_processed: number;
  };
  // For each activity icon type, the most recent entry of that type
  // regardless of the 24h window. Used by the feed's filtered-empty state
  // to tell the user "Last X was Y ago" instead of leaving them with a
  // blank "no activity" panel.
  last_of_type: Partial<Record<ActivityEntry['icon'], { timestamp: string; description: string }>>;
}

function describeCompletedJob(workflowType: string, metadata: any, itemsProcessed: number, status: string): {
  icon: ActivityEntry['icon']; label: string; description: string;
} {
  if (status === 'failed') {
    return {
      icon: 'error',
      label: `${WORKFLOW_LABEL[workflowType]?.label || workflowType} failed`,
      description: 'Will retry on the next cycle.',
    };
  }
  if (workflowType === 'ingestion') {
    const o = metadata?.fetched_outlook || 0;
    const s = metadata?.fetched_slack || 0;
    const n = metadata?.fetched_news || 0;
    const failures = (metadata?.source_failures || []).length;
    const parts: string[] = [];
    if (o > 0) parts.push(`${o} email${o === 1 ? '' : 's'}`);
    if (s > 0) parts.push(`${s} Slack message${s === 1 ? '' : 's'}`);
    if (n > 0) parts.push(`${n} news article${n === 1 ? '' : 's'}`);
    const desc = parts.length > 0
      ? `Synced ${parts.join(', ')}.${failures > 0 ? ` ${failures} channel issue${failures === 1 ? '' : 's'}.` : ''}`
      : 'Completed — no new messages found, all up to date.';
    return { icon: 'email', label: 'Email & Slack sync', description: desc };
  }
  if (workflowType === 'enrichment') {
    return {
      icon: 'enrichment',
      label: 'Contact enrichment',
      description: itemsProcessed > 0
        ? `Enriched ${itemsProcessed} ${itemsProcessed === 1 ? 'entry' : 'entries'}.`
        : 'All contacts up to date — next batch in 30 days.',
    };
  }
  if (workflowType === 'daily') {
    return { icon: 'cleanup', label: 'Daily maintenance', description: 'News scores updated, caches refreshed, vector index reconciled.' };
  }
  return { icon: 'cron', label: workflowType, description: '' };
}

export async function getDashboardActivity(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const orgId = ctx.orgId;

  // ── Recent activity from sync_jobs ─────────────────────────────────────
  const recent = await env.D1.prepare(
    `SELECT id, workflow_type, status, items_processed, items_failed,
            started_at, completed_at, metadata
       FROM sync_jobs
      WHERE org_id = ? AND completed_at IS NOT NULL
        AND completed_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
      ORDER BY completed_at DESC
      LIMIT 50`
  ).bind(orgId).all<{
    id: string; workflow_type: string; status: string;
    items_processed: number; items_failed: number;
    started_at: string; completed_at: string; metadata: string | null;
  }>();

  const recent_activity: ActivityEntry[] = recent.results.map(r => {
    let metadata: any = {};
    try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
    const desc = describeCompletedJob(r.workflow_type, metadata, r.items_processed, r.status);
    return {
      id: r.id,
      type: r.workflow_type,
      icon: desc.icon,
      label: desc.label,
      description: desc.description,
      timestamp: r.completed_at,
      result: { processed: r.items_processed, failed: r.items_failed },
    };
  });

  // ── 24h stats + today-deltas ──────────────────────────────────────────
  const since24h = `strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')`;
  const todayStart = startOfTodayUtc();

  const [
    emailsRow, slackRow, contactsRow, contactsEnrichedRow,
    companiesEnrichedRow, meetingsRow, docsRow,
    apqCreatedRow, apqResolvedRow,
    emailsTodayRow, contactsTodayRow, contactsEnrichedTodayRow, meetingsTodayRow, docsTodayRow,
  ] = await Promise.all([
    env.D1.prepare(`SELECT COUNT(*) as n FROM conversations WHERE org_id=? AND source='outlook' AND created_at > ${since24h}`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM conversations WHERE org_id=? AND source='slack' AND created_at > ${since24h}`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM contacts WHERE org_id=? AND created_at > ${since24h} AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM contacts WHERE org_id=? AND enrichment_last_run > ${since24h} AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM companies WHERE org_id=? AND enrichment_last_run > ${since24h} AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM events WHERE org_id=? AND source='firefly' AND created_at > ${since24h} AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM documents WHERE org_id=? AND source='intelligent_import' AND created_at > ${since24h} AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM approval_queue WHERE org_id=? AND created_at > ${since24h}`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM approval_queue WHERE org_id=? AND status != 'pending' AND resolved_at > ${since24h}`).bind(orgId).first<{n:number}>(),
    // Today (since UTC midnight) variants for the "+N today" delta pills.
    env.D1.prepare(`SELECT COUNT(*) as n FROM conversations WHERE org_id=? AND source='outlook' AND created_at >= ?`).bind(orgId, todayStart).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM contacts WHERE org_id=? AND created_at >= ? AND deleted_at IS NULL`).bind(orgId, todayStart).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM contacts WHERE org_id=? AND enrichment_last_run >= ? AND deleted_at IS NULL`).bind(orgId, todayStart).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM events WHERE org_id=? AND source='firefly' AND created_at >= ? AND deleted_at IS NULL`).bind(orgId, todayStart).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM documents WHERE org_id=? AND source='intelligent_import' AND created_at >= ? AND deleted_at IS NULL`).bind(orgId, todayStart).first<{n:number}>(),
  ]);

  // ── Last-of-type fallback for the activity feed's filtered-empty state ──
  // When a user filters to e.g. "imports" and there's been no import in 24h,
  // we still want to tell them "Last import was 3 days ago — N transcripts
  // from Firefly" instead of leaving them with a blank panel.
  const last_of_type: ActivityResponse['last_of_type'] = {};
  const newest = await env.D1.prepare(
    `SELECT workflow_type, status, items_processed, completed_at, metadata
       FROM sync_jobs
      WHERE org_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 100`
  ).bind(orgId).all<{
    workflow_type: string; status: string; items_processed: number;
    completed_at: string; metadata: string | null;
  }>();
  for (const r of newest.results) {
    let metadata: any = {};
    try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
    const desc = describeCompletedJob(r.workflow_type, metadata, r.items_processed, r.status);
    if (!last_of_type[desc.icon]) {
      last_of_type[desc.icon] = { timestamp: r.completed_at, description: desc.description };
    }
  }

  return jsonResponse({
    recent_activity,
    stats_24h: {
      emails_synced: emailsRow?.n || 0,
      contacts_discovered: contactsRow?.n || 0,
      contacts_enriched: contactsEnrichedRow?.n || 0,
      companies_enriched: companiesEnrichedRow?.n || 0,
      meetings_ingested: meetingsRow?.n || 0,
      slack_messages: slackRow?.n || 0,
      documents_processed: docsRow?.n || 0,
      approval_items_created: apqCreatedRow?.n || 0,
      approval_items_resolved: apqResolvedRow?.n || 0,
    },
    stats_today: {
      emails_synced: emailsTodayRow?.n || 0,
      contacts_discovered: contactsTodayRow?.n || 0,
      contacts_enriched: contactsEnrichedTodayRow?.n || 0,
      meetings_ingested: meetingsTodayRow?.n || 0,
      documents_processed: docsTodayRow?.n || 0,
    },
    last_of_type,
  } satisfies ActivityResponse);
}

// ────────────────────────────────────────────────────────────────────────────
// /api/dashboard/sparklines — every 5min. Hourly buckets over the last 24h.
// No per-call telemetry → estimate from sync_jobs activity. Each enrichment
// cycle ≈ N Claude/Gemini calls; each ingestion cycle ≈ M Graph calls.
// ────────────────────────────────────────────────────────────────────────────

export interface SparklinesResponse {
  claude: number[];
  gemini: number[];
  graph: number[];
  slack: number[];
  hours: string[];          // ISO hour starts, 24 entries
  total_24h: number;        // sum across all four series — shown as a header line
}

export async function getDashboardSparklines(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const orgId = ctx.orgId;

  const rows = await env.D1.prepare(
    `SELECT workflow_type, status, items_processed, started_at, completed_at, metadata
       FROM sync_jobs
      WHERE org_id = ?
        AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')`
  ).bind(orgId).all<{
    workflow_type: string; status: string; items_processed: number;
    started_at: string; completed_at: string | null; metadata: string | null;
  }>();

  // 24 buckets keyed by hour-of-completion (or hour-of-start if not completed)
  const now = Date.now();
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    hourStart: new Date(now - (23 - i) * 3600_000).toISOString().slice(0, 13) + ':00:00.000Z',
    claude: 0, gemini: 0, graph: 0, slack: 0,
  }));

  function hourIndex(iso: string): number {
    const t = new Date(iso).getTime();
    const idx = 23 - Math.floor((now - t) / 3600_000);
    return idx >= 0 && idx < 24 ? idx : -1;
  }

  for (const r of rows.results) {
    const ts = r.completed_at || r.started_at;
    const idx = hourIndex(ts);
    if (idx < 0) continue;
    let metadata: any = {};
    try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
    const items = r.items_processed || 0;
    if (r.workflow_type === 'enrichment') {
      // ~3 Claude calls + 1 Gemini per enriched entity
      buckets[idx].claude += items * 3;
      buckets[idx].gemini += items * 1;
    } else if (r.workflow_type === 'ingestion') {
      const slackFetched = metadata.fetched_slack || 0;
      const outlookFetched = metadata.fetched_outlook || 0;
      const totalFetched = outlookFetched + slackFetched;
      buckets[idx].graph += outlookFetched;
      buckets[idx].claude += totalFetched; // classification + extraction
      // Slack API estimate: each ingestion that fetched Slack does
      // ~3 calls (auth.test + conversations.list + N×conversations.history).
      // With per-channel paging we approximate at slackFetched/200 + 2.
      if (slackFetched > 0) {
        buckets[idx].slack += Math.max(2, Math.ceil(slackFetched / 50));
      } else {
        // Even a no-message poll calls auth.test + conversations.list.
        buckets[idx].slack += 2;
      }
    } else if (r.workflow_type === 'daily') {
      buckets[idx].claude += 5;
    }
  }

  const total_24h = buckets.reduce(
    (s, b) => s + b.claude + b.gemini + b.graph + b.slack,
    0
  );

  return jsonResponse({
    claude: buckets.map(b => b.claude),
    gemini: buckets.map(b => b.gemini),
    graph: buckets.map(b => b.graph),
    slack: buckets.map(b => b.slack),
    hours: buckets.map(b => b.hourStart),
    total_24h,
  } satisfies SparklinesResponse);
}

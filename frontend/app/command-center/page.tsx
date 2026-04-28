'use client';

import React from 'react';
import {
  Mail, Brain, Calendar, FileText, Clock, AlertTriangle,
  Newspaper, Wrench, Activity,
  type LucideIcon,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import {
  api,
  type DashboardPulse,
  type DashboardActivity,
  type DashboardSparklines,
  type DashboardActivityEntry,
  type DashboardCapacityGauge,
  type DashboardServiceStatus,
} from '@/lib/api';

// ────────────────────────────────────────────────────────────────────────────
// Polling intervals
// ────────────────────────────────────────────────────────────────────────────
const PULSE_MS = 5_000;
const ACTIVITY_MS = 30_000;
const SPARKLINES_MS = 5 * 60_000;

// Per-service rate limits used for gauge labels. These mirror the backend's
// self-imposed ceilings (rate-limit.ts), not the upstream provider's max.
// Gemini self-limit is 500 RPM; Google Tier 1 actually allows 1000 — we
// throttle to half as a safety buffer. Surfaced in tooltips so users see
// both numbers.
const RATE_LIMITS = {
  claude: { perMinute: 60,    label: '60/min',  upstream: 'Anthropic AI Gateway' },
  gemini: { perMinute: 500,   label: '500/min', upstream: 'Google Gemini (Tier 1 max: 1,000/min)' },
  graph:  { per10min: 10000,  label: '10K/10m', upstream: 'Microsoft Graph (10K per 10-min window)' },
  slack:  { perMinute: 50,    label: '50/min',  upstream: 'Slack Web API' },
} as const;

// "Fresh enough" threshold — if the backend's generated_at is older than
// this many ms, surface an amber "stale data" warning so users don't trust
// numbers that haven't refreshed in a while (poll failure, tab background).
const STALE_THRESHOLD_MS = 5 * 60_000;

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function CommandCenterPage() {
  const [pulse, setPulse] = React.useState<DashboardPulse | null>(null);
  const [activity, setActivity] = React.useState<DashboardActivity | null>(null);
  const [sparks, setSparks] = React.useState<DashboardSparklines | null>(null);

  // Visibility-aware polling — pause when tab is backgrounded.
  React.useEffect(() => {
    let pulseTimer: number | null = null;
    let activityTimer: number | null = null;
    let sparksTimer: number | null = null;

    const start = () => {
      api.getDashboardPulse().then(setPulse).catch(() => {});
      api.getDashboardActivity().then(setActivity).catch(() => {});
      api.getDashboardSparklines().then(setSparks).catch(() => {});
      pulseTimer = window.setInterval(() => api.getDashboardPulse().then(setPulse).catch(() => {}), PULSE_MS);
      activityTimer = window.setInterval(() => api.getDashboardActivity().then(setActivity).catch(() => {}), ACTIVITY_MS);
      sparksTimer = window.setInterval(() => api.getDashboardSparklines().then(setSparks).catch(() => {}), SPARKLINES_MS);
    };
    const stop = () => {
      if (pulseTimer) window.clearInterval(pulseTimer);
      if (activityTimer) window.clearInterval(activityTimer);
      if (sparksTimer) window.clearInterval(sparksTimer);
      pulseTimer = activityTimer = sparksTimer = null;
    };
    const handleVis = () => { stop(); if (!document.hidden) start(); };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', handleVis);
    return () => { document.removeEventListener('visibilitychange', handleVis); stop(); };
  }, []);

  // The OLDEST generated_at across the three feeds drives the staleness
  // indicator — if any panel hasn't refreshed in >5min, the user sees amber.
  const oldestGeneratedAt = oldestTimestamp([
    pulse?.generated_at, activity?.generated_at, sparks?.generated_at,
  ]);
  const stale = oldestGeneratedAt
    ? Date.now() - new Date(oldestGeneratedAt).getTime() > STALE_THRESHOLD_MS
    : false;

  return (
    <div className="flex-1 flex flex-col">
      <TopBar title="Command Center" />
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
          {oldestGeneratedAt && (
            <div className={`flex items-center gap-2 text-xs ${stale ? 'text-semantic-warning' : 'text-text-muted'}`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${stale ? 'bg-semantic-warning' : 'bg-semantic-success animate-pulse'}`} />
              {stale
                ? `Data may be stale — last refreshed ${formatRelative(oldestGeneratedAt)} (polling may be paused or the backend isn't responding)`
                : `Live · last refreshed ${formatRelative(oldestGeneratedAt)}`}
            </div>
          )}

          {/* Section order: status first, then trends, then details. */}
          <SystemPulseHero pulse={pulse} />
          <CapacityGauges capacity={pulse?.capacity} />
          <Sparklines data={sparks} />
          <QuickStatsBar stats={activity?.stats_24h} today={activity?.stats_today} />
          <ActiveProcesses processes={pulse?.active_processes ?? []} />
          <ActivityFeed entries={activity?.recent_activity ?? []} lastOfType={activity?.last_of_type ?? {}} />
        </div>
      </div>
    </div>
  );
}

function oldestTimestamp(times: Array<string | undefined>): string | null {
  const valid = times.filter((t): t is string => !!t).map(t => ({ t, ms: new Date(t).getTime() }));
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.ms - b.ms);
  return valid[0].t;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. System Pulse — hero orb + idle/active context
// ────────────────────────────────────────────────────────────────────────────

function SystemPulseHero({ pulse }: { pulse: DashboardPulse | null }) {
  const status = pulse?.system_status ?? 'healthy';
  const color = {
    healthy:  { ring: 'rgba(34,197,94,0.6)',  core: '#22C55E', pulse: '4s' },
    busy:     { ring: 'rgba(139,92,246,0.6)', core: '#8B5CF6', pulse: '1.6s' },
    degraded: { ring: 'rgba(245,158,11,0.6)', core: '#F59E0B', pulse: '2.5s' },
    error:    { ring: 'rgba(239,68,68,0.7)',  core: '#EF4444', pulse: '0s' },
  }[status];

  return (
    <div className="flex flex-col items-center text-center py-6">
      <div className="relative w-32 h-32 mb-6">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `radial-gradient(circle, ${color.ring} 0%, transparent 70%)`,
            animation: status !== 'error' ? `pulse-ring ${color.pulse} ease-in-out infinite` : 'none',
          }}
        />
        <div
          className="absolute inset-6 rounded-full shadow-lg"
          style={{
            background: `radial-gradient(circle at 35% 35%, ${color.core}EE 0%, ${color.core}80 70%, ${color.core}30 100%)`,
            boxShadow: `0 0 40px ${color.ring}, inset 0 0 20px rgba(255,255,255,0.2)`,
            animation: status !== 'error' ? `orb-breathe ${color.pulse} ease-in-out infinite` : 'none',
          }}
        />
      </div>
      <div className="text-2xl font-medium text-text-primary mb-1">
        {pulse?.status_message || 'Loading…'}
      </div>
      <div className="text-xs text-text-muted uppercase tracking-widest">System Pulse</div>

      {/* When idle, surface upcoming cron times so the user knows the system
          is on schedule, not stuck. */}
      {status === 'healthy' && pulse?.next_runs && (
        <div className="text-xs text-text-muted mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1">
          <span>Next email sync in {minutesUntil(pulse.next_runs.ingestion)}</span>
          <span className="text-text-muted/60">·</span>
          <span>Next enrichment in {minutesUntil(pulse.next_runs.enrichment)}</span>
          <span className="text-text-muted/60">·</span>
          <span>Daily maintenance at midnight UTC</span>
        </div>
      )}

      <style jsx>{`
        @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:.7} 50%{transform:scale(1.15);opacity:.4} }
        @keyframes orb-breathe { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Capacity Gauges — better labels + last-call / countdown context
// ────────────────────────────────────────────────────────────────────────────

function CapacityGauges({ capacity }: { capacity: DashboardPulse['capacity'] | undefined }) {
  return (
    <Section title="Capacity" hint="Real-time usage of external APIs — green is healthy, yellow approaches limits, red means paused.">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {capacity ? (
          <>
            <GaugeCard
              name="Claude AI"
              gauge={capacity.claude}
              unitPerWindow="RPM"
              callsThisHour={capacity.claude.calls_this_hour}
              context={
                capacity.claude.rate_limited ? 'Rate limited — backoff active'
                : capacity.claude.window_resets_at ? `Window resets in ${secondsUntil(capacity.claude.window_resets_at)}s`
                : capacity.claude.last_call_at ? `Last call ${formatRelative(capacity.claude.last_call_at)}`
                : 'Idle — no recent calls'
              }
              tooltip={[
                'Claude AI requests per minute (current 60s window).',
                `Source: KV claude_rate:medina-ventures (count, resets_at).`,
                `Self-imposed limit: ${RATE_LIMITS.claude.label}. Upstream: ${RATE_LIMITS.claude.upstream}.`,
                'Hourly call count comes from KV bucket api_calls:claude:medina-ventures:{hour}, written on every Claude call.',
                'Note: per-minute counter is approximate during concurrent bursts.',
              ].join('\n')}
            />
            <GaugeCard
              name="Gemini"
              gauge={capacity.gemini}
              unitPerWindow="RPM"
              callsThisHour={capacity.gemini.calls_this_hour}
              context={
                capacity.gemini.rate_limited ? 'Rate limited — backoff active'
                : capacity.gemini.window_resets_at ? `Window resets in ${secondsUntil(capacity.gemini.window_resets_at)}s`
                : capacity.gemini.last_call_at ? `Last call ${formatRelative(capacity.gemini.last_call_at)}`
                : 'Idle — no recent calls'
              }
              tooltip={[
                'Gemini API requests per minute (current 60s window).',
                `Source: KV gemini_rate:medina-ventures (count, resets_at).`,
                `Self-imposed limit: ${RATE_LIMITS.gemini.label}. Upstream: ${RATE_LIMITS.gemini.upstream}.`,
                'Hourly call count from KV bucket api_calls:gemini:medina-ventures:{hour}.',
              ].join('\n')}
            />
            <GaugeCard
              name="MS Graph"
              gauge={capacity.graph}
              unitPerWindow="per 10m"
              callsThisHour={capacity.graph.calls_this_hour}
              context={
                capacity.graph.window_resets_at ? `Window resets in ${secondsUntil(capacity.graph.window_resets_at)}s`
                : 'Idle — no recent calls'
              }
              tooltip={[
                'Microsoft Graph API calls in the current 10-minute rolling window.',
                'Source: KV graph_rpm:medina-ventures (count, window_start).',
                `Soft cap: ${RATE_LIMITS.graph.label}. Upstream: ${RATE_LIMITS.graph.upstream}.`,
                'When window_start is older than 10min, current usage shown as 0 (window expired).',
              ].join('\n')}
            />
            <ServiceCard
              name="Slack"
              service={capacity.slack}
              line1={capacity.slack.last_sync_at ? `Last sync ${formatRelative(capacity.slack.last_sync_at)}` : 'Awaiting first sync'}
              line2={`${capacity.slack.messages_today ?? 0} messages today · ${capacity.slack.calls_this_hour ?? 0} calls this hour`}
              tooltip={[
                'Slack Web API status.',
                'Source: KV slack_last_sync:medina-ventures (last successful poll), conversations table (today\'s messages), and api_calls:slack KV bucket (hourly calls).',
                `Upstream: ${RATE_LIMITS.slack.upstream}.`,
                'No quantitative cap shown — Slack throttles per-method, we don\'t track aggregate.',
              ].join('\n')}
            />
            <ServiceCard
              name="ReverseContact"
              service={capacity.reversecontact}
              line1={
                capacity.reversecontact.status === 'circuit_open' ? 'Reset key in Settings'
                : capacity.reversecontact.status === 'rate_limited' && capacity.reversecontact.blocked_until
                  ? `Resumes ${formatRelative(capacity.reversecontact.blocked_until)}`
                  : capacity.reversecontact.last_enrichment_at
                    ? `Last enrichment ${formatRelative(capacity.reversecontact.last_enrichment_at)}`
                    : 'No recent activity'
              }
              line2={`${capacity.reversecontact.enriched_today ?? 0} enriched today · ${capacity.reversecontact.calls_this_hour ?? 0} calls this hour`}
              tooltip={[
                'ReverseContact LinkedIn enrichment.',
                'Source: KV rc_failures:medina-ventures (auth-failure circuit breaker), rate_limit:reversecontact:medina-ventures (429 backoff state).',
                'Today\'s enriched count from contacts table where linkedin_data_r2_key was set since UTC midnight.',
                'Hourly call count from api_calls:reversecontact KV bucket.',
              ].join('\n')}
            />
          </>
        ) : (
          <>{[0,1,2,3,4].map(i => <div key={i} className="card h-32 animate-pulse" />)}</>
        )}
      </div>
    </Section>
  );
}

function GaugeCard({ name, gauge, unitPerWindow, context, tooltip, callsThisHour }: {
  name: string;
  gauge: DashboardCapacityGauge;
  unitPerWindow: string;
  context: string;
  tooltip: string;
  callsThisHour?: number;
}) {
  const pct = gauge.percentage;
  const color = pct >= 80 ? '#EF4444' : pct >= 50 ? '#F59E0B' : '#22C55E';
  const radius = 38;
  const circumference = Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  return (
    <div className="card p-4 text-center" title={tooltip}>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2 flex items-center justify-center gap-1">
        <span>{name}</span>
        <InfoIcon />
      </div>
      <div className="relative w-24 h-14 mx-auto">
        <svg viewBox="0 0 100 60" className="w-full h-full">
          <path d="M 10 50 A 38 38 0 0 1 90 50" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="8" strokeLinecap="round" />
          <path
            d="M 10 50 A 38 38 0 0 1 90 50"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 600ms ease-out, stroke 400ms ease-out' }}
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-base font-semibold tabular-nums" style={{ color }}>
          {pct}%
        </div>
      </div>
      <div className="text-xs text-text-primary mt-1">{labelForStatus(gauge.status)}</div>
      <div className="text-[10px] text-text-muted">
        {gauge.used.toLocaleString()} / {gauge.limit.toLocaleString()} {unitPerWindow}
      </div>
      <div className="text-[10px] text-text-muted">
        {(callsThisHour ?? 0).toLocaleString()} calls this hour
      </div>
      <div className="text-[10px] text-text-muted mt-1 truncate" style={{ color: pct >= 80 ? color : undefined }}>
        {context}
      </div>
    </div>
  );
}

function InfoIcon() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center w-3 h-3 rounded-full border border-text-muted/40 text-text-muted/60 text-[8px] font-semibold leading-none cursor-help"
      style={{ paddingTop: '0.5px' }}
    >
      i
    </span>
  );
}

function labelForStatus(s: DashboardCapacityGauge['status']): string {
  if (s === 'limited') return 'Rate limited';
  if (s === 'high') return 'Heavy';
  if (s === 'moderate') return 'Moderate';
  if (s === 'low') return 'Light';
  return 'Unknown';
}

function ServiceCard({ name, service, line1, line2, tooltip }: {
  name: string; service: DashboardServiceStatus; line1: string; line2?: string; tooltip?: string;
}) {
  const color =
    service.status === 'rate_limited' ? '#F59E0B' :
    service.status === 'circuit_open' || service.status === 'auth_failed' ? '#EF4444' :
    '#22C55E';
  const breathe = service.status === 'active' || service.status === 'healthy';
  return (
    <div className="card p-4 text-center flex flex-col" title={tooltip}>
      <div className="text-[10px] uppercase tracking-wider text-text-muted flex items-center justify-center gap-1">
        <span>{name}</span>
        {tooltip && <InfoIcon />}
      </div>
      <div className="my-3 flex items-center justify-center">
        <div
          className="w-4 h-4 rounded-full"
          style={{
            background: color,
            boxShadow: `0 0 14px ${color}80`,
            animation: breathe ? 'service-breathe 3s ease-in-out infinite' : 'none',
          }}
        />
      </div>
      <div className="text-xs text-text-primary">{service.label}</div>
      <div className="text-[10px] text-text-muted truncate">{line1}</div>
      {line2 && <div className="text-[10px] text-text-muted truncate">{line2}</div>}
      <style jsx>{`
        @keyframes service-breathe { 0%,100%{transform:scale(1);opacity:.85} 50%{transform:scale(1.2);opacity:1} }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 3. API Activity Sparklines — Slack replaces Overall, units everywhere
// ────────────────────────────────────────────────────────────────────────────

function Sparklines({ data }: { data: DashboardSparklines | null }) {
  const services: Array<{ key: 'claude'|'gemini'|'graph'|'slack'; name: string; color: string; limit: string; tooltip: string }> = [
    {
      key: 'claude', name: 'Claude AI', color: '#8B5CF6', limit: RATE_LIMITS.claude.label,
      tooltip: `Real call counts. Source: KV bucket api_calls:claude:medina-ventures:{hour} (TTL 26h). Incremented on every Claude call via recordApiCall(). Self-imposed limit ${RATE_LIMITS.claude.label}; upstream ${RATE_LIMITS.claude.upstream}.`,
    },
    {
      key: 'gemini', name: 'Gemini', color: '#EC4899', limit: RATE_LIMITS.gemini.label,
      tooltip: `Real call counts. Source: KV bucket api_calls:gemini:medina-ventures:{hour}. Self-imposed ${RATE_LIMITS.gemini.label}; upstream ${RATE_LIMITS.gemini.upstream}.`,
    },
    {
      key: 'graph', name: 'MS Graph', color: '#3B82F6', limit: RATE_LIMITS.graph.label,
      tooltip: `Real call counts. Source: KV bucket api_calls:graph:medina-ventures:{hour}, mirrored from recordGraphApiCall(). Soft cap ${RATE_LIMITS.graph.label}; upstream ${RATE_LIMITS.graph.upstream}.`,
    },
    {
      key: 'slack', name: 'Slack', color: '#22C55E', limit: RATE_LIMITS.slack.label,
      tooltip: `Slack call counts (estimated per fetch cycle: 2 + channels + senders). Source: KV bucket api_calls:slack:medina-ventures:{hour}. Slack throttles per-method, no aggregate cap shown.`,
    },
  ];
  return (
    <Section
      title="API activity (last 24 hours)"
      hint="Volume of calls to external services — spikes indicate heavy processing. Real counts from KV hourly buckets, written on every API call."
      headerRight={data ? <span className="text-xs text-text-muted">Total: {data.total_24h.toLocaleString()} calls in last 24h</span> : null}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {services.map(s => (
          <SparklineCard
            key={s.key}
            name={s.name}
            series={data ? (data[s.key] as number[]) : undefined}
            color={s.color}
            limit={s.limit}
            tooltip={s.tooltip}
          />
        ))}
      </div>
    </Section>
  );
}

function SparklineCard({ name, series, color, limit, tooltip }: {
  name: string; series?: number[]; color: string; limit: string; tooltip: string;
}) {
  if (!series || series.length === 0) {
    return <div className="card p-4 h-32 animate-pulse" />;
  }
  const W = 220, H = 50;
  const max = Math.max(...series, 1);
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1 || 1)) * W;
    const y = H - (v / max) * (H - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${points.join(' L ')}`;
  const fillPath = `${linePath} L ${W},${H} L 0,${H} Z`;
  const total = series.reduce((a, b) => a + b, 0);
  const peak = Math.max(...series);

  return (
    <div className="card p-4" title={tooltip}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-text-muted uppercase tracking-wider flex items-center gap-1">
          <span>{name}</span>
          <InfoIcon />
        </div>
        <div className="text-sm font-medium text-text-primary tabular-nums">{total.toLocaleString()} <span className="text-[10px] text-text-muted">calls</span></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12">
        <defs>
          <linearGradient id={`g-${name}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fillPath} fill={`url(#g-${name})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="text-[10px] text-text-muted mt-1 flex justify-between">
        <span>Peak: {peak.toLocaleString()}/h</span>
        <span>Limit: {limit}</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Quick Stats Bar — non-clickable (no dead ends), today-deltas inline
// ────────────────────────────────────────────────────────────────────────────

function QuickStatsBar({
  stats, today,
}: { stats: DashboardActivity['stats_24h'] | undefined; today: DashboardActivity['stats_today'] | undefined }) {
  // Each stat carries its own provenance (the actual D1 query that produced
  // the number) so users can verify the dashboard isn't lying.
  const TIPS = {
    emails: "COUNT(*) FROM conversations WHERE source='outlook' AND created_at > now -24h. Real D1 count.",
    slack: "COUNT(*) FROM conversations WHERE source='slack' AND created_at > now -24h. Real D1 count.",
    contacts: "COUNT(*) FROM contacts WHERE created_at > now -24h AND deleted_at IS NULL. Real D1 count.",
    meetings: "COUNT(*) FROM events WHERE source='firefly' AND created_at > now -24h AND deleted_at IS NULL. Real D1 count.",
    docs: "COUNT(*) FROM documents WHERE source='intelligent_import' AND created_at > now -24h AND deleted_at IS NULL.",
    enriched: "COUNT(*) FROM contacts WHERE enrichment_last_run > now -24h AND deleted_at IS NULL.",
    proposals: "COUNT(*) FROM approval_queue WHERE created_at > now -24h.",
    approved: "COUNT(*) FROM approval_queue WHERE status != 'pending' AND resolved_at > now -24h.",
  };
  return (
    <Section title="Last 24 hours" hint="Everything the platform processed today across all data sources. All counts are direct D1 queries with a 24-hour created_at filter — hover any stat for the exact SQL.">
      <div className="card p-4 flex flex-wrap gap-x-5 gap-y-3 items-center">
        <Stat emoji="📧" value={stats?.emails_synced} delta={today?.emails_synced} label="emails" tooltip={TIPS.emails} />
        <Stat emoji="💬" value={stats?.slack_messages} label="Slack" tooltip={TIPS.slack} />
        <Stat emoji="👤" value={stats?.contacts_discovered} delta={today?.contacts_discovered} label="contacts" tooltip={TIPS.contacts} />
        <Stat emoji="🤝" value={stats?.meetings_ingested} delta={today?.meetings_ingested} label="meetings" tooltip={TIPS.meetings} />
        <Stat emoji="📄" value={stats?.documents_processed} delta={today?.documents_processed} label="docs" tooltip={TIPS.docs} />
        <Stat emoji="✅" value={stats?.contacts_enriched} delta={today?.contacts_enriched} label="enriched" tooltip={TIPS.enriched} />
        <Stat emoji="📋" value={stats?.approval_items_created} label="proposals" tooltip={TIPS.proposals} />
        <Stat emoji="✓"  value={stats?.approval_items_resolved} label="approved" tooltip={TIPS.approved} />
      </div>
    </Section>
  );
}

function Stat({ emoji, value, delta, label, tooltip }: {
  emoji: string; value?: number; delta?: number; label: string; tooltip?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 text-sm text-text-primary" title={tooltip}>
      <span>{emoji}</span>
      <AnimatedNumber value={value || 0} className="font-medium tabular-nums" />
      <span className="text-text-muted text-xs">{label}</span>
      {delta != null && delta > 0 && (
        <span className="text-[10px] text-semantic-success ml-1 tabular-nums">+{delta} today</span>
      )}
    </div>
  );
}

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = React.useState(value);
  React.useEffect(() => {
    if (shown === value) return;
    const start = shown;
    const delta = value - start;
    const dur = Math.min(800, 200 + Math.abs(delta) * 30);
    const t0 = performance.now();
    let raf: number;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(start + delta * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span className={className}>{shown.toLocaleString()}</span>;
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Active Processes
// ────────────────────────────────────────────────────────────────────────────

const PROCESS_ICONS: Record<DashboardPulse['active_processes'][number]['type'], LucideIcon> = {
  ingestion: Mail,
  enrichment: Brain,
  daily_cron: Wrench,
  backfill: Calendar,
  import: FileText,
  other: Activity,
};

function ActiveProcesses({ processes }: { processes: DashboardPulse['active_processes'] }) {
  return (
    <Section title="Active Processes" hint="Background tasks currently running — email sync, enrichment, imports.">
      {processes.length === 0 ? (
        <div className="card p-6">
          <div className="flex items-center gap-2 text-sm text-text-primary">
            <span className="inline-block w-2 h-2 rounded-full bg-semantic-success animate-pulse" />
            All clear — no background tasks running
          </div>
          <div className="text-xs text-text-muted mt-1">
            The system processes new data automatically. Email syncs run hourly, enrichment runs every hour at :05.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {processes.map(p => <ActiveProcessCard key={p.id} process={p} />)}
        </div>
      )}
    </Section>
  );
}

function ActiveProcessCard({ process: p }: { process: DashboardPulse['active_processes'][number] }) {
  const Icon = PROCESS_ICONS[p.type] || Activity;
  const [elapsed, setElapsed] = React.useState(p.elapsed_seconds);
  React.useEffect(() => {
    setElapsed(p.elapsed_seconds);
    const i = window.setInterval(() => setElapsed(e => e + 1), 1000);
    return () => window.clearInterval(i);
  }, [p.elapsed_seconds, p.id]);

  const pct = p.progress?.percentage;
  return (
    <div className="card p-4 relative overflow-hidden"
      style={{ boxShadow: '0 0 0 1px rgba(139,92,246,0.25), 0 0 20px rgba(139,92,246,0.08)' }}>
      <div
        className="absolute inset-0 rounded-lg pointer-events-none"
        style={{ border: '1px solid rgba(139,92,246,0.4)', animation: 'card-pulse 2s ease-in-out infinite' }}
      />
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-accent-magenta/10 flex items-center justify-center text-accent-magenta shrink-0">
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">{p.label}</div>
          <div className="text-[11px] text-text-muted">
            Running for {formatDuration(elapsed)}
            {p.progress?.current != null && (
              <> · {p.progress.current.toLocaleString()}{p.progress.total ? ` of ~${p.progress.total.toLocaleString()}` : ''} processed</>
            )}
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-bg-input overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: pct != null ? `${pct}%` : '40%',
                background: 'linear-gradient(90deg, #8B5CF6, #EC4899)',
                transition: 'width 600ms ease-out',
                animation: pct == null ? 'indeterminate-bar 2s linear infinite' : 'none',
              }}
            />
          </div>
        </div>
      </div>
      <style jsx>{`
        @keyframes card-pulse { 0%,100%{opacity:.4} 50%{opacity:.9} }
        @keyframes indeterminate-bar { 0%{transform:translateX(-100%)} 100%{transform:translateX(250%)} }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 6. Recent Activity — filterable, with last-of-type fallback
// ────────────────────────────────────────────────────────────────────────────

const ACTIVITY_FILTERS: Array<{ key: 'all' | DashboardActivityEntry['icon']; label: string }> = [
  { key: 'all',         label: 'All' },
  { key: 'email',       label: 'Emails' },
  { key: 'enrichment',  label: 'Enrichment' },
  { key: 'meeting',     label: 'Meetings' },
  { key: 'import',      label: 'Imports' },
  { key: 'error',       label: 'Errors' },
];

const ACTIVITY_ICON_COMPONENTS: Record<DashboardActivityEntry['icon'], LucideIcon> = {
  email: Mail, enrichment: Brain, meeting: Calendar, import: FileText,
  cron: Clock, error: AlertTriangle, news: Newspaper, cleanup: Wrench,
};
const ACTIVITY_ICON_COLORS: Record<DashboardActivityEntry['icon'], string> = {
  email: '#3B82F6', enrichment: '#8B5CF6', meeting: '#EC4899', import: '#22C55E',
  cron: '#94A3B8', error: '#EF4444', news: '#F59E0B', cleanup: '#06B6D4',
};

function ActivityFeed({
  entries, lastOfType,
}: { entries: DashboardActivityEntry[]; lastOfType: DashboardActivity['last_of_type'] }) {
  const [filter, setFilter] = React.useState<typeof ACTIVITY_FILTERS[number]['key']>('all');
  const filtered = filter === 'all' ? entries : entries.filter(e => e.icon === filter);

  return (
    <Section title="Recent activity" hint="Completed background tasks and their results.">
      <div className="flex gap-2 mb-3 text-xs">
        {ACTIVITY_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded-md transition-colors ${
              filter === f.key ? 'bg-accent-magenta/15 text-accent-magenta' : 'text-text-muted hover:text-text-primary hover:bg-bg-surface-hover'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="card p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <FilteredEmptyState filter={filter} lastOfType={lastOfType} />
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.slice(0, 50).map(e => <ActivityRow key={e.id} entry={e} />)}
          </ul>
        )}
      </div>
    </Section>
  );
}

function FilteredEmptyState({
  filter, lastOfType,
}: { filter: 'all' | DashboardActivityEntry['icon']; lastOfType: DashboardActivity['last_of_type'] }) {
  if (filter === 'all') {
    return <div className="p-8 text-center text-sm text-text-muted">No activity in the last 24 hours.</div>;
  }
  const last = lastOfType[filter];
  const friendly = {
    email: 'email sync', enrichment: 'enrichment cycle', meeting: 'meeting',
    import: 'import', error: 'error', news: 'news activity',
    cron: 'maintenance', cleanup: 'maintenance',
  }[filter];
  if (last) {
    return (
      <div className="p-6 text-sm text-text-secondary text-center">
        <div className="text-text-muted">No {friendly} activity in the last 24 hours.</div>
        <div className="text-text-primary mt-2">
          Last {friendly}: <span className="text-text-muted">{formatRelative(last.timestamp)}</span>
        </div>
        {last.description && <div className="text-xs text-text-muted mt-1">{last.description}</div>}
      </div>
    );
  }
  return (
    <div className="p-8 text-center text-sm text-text-muted">
      No {friendly} activity recorded yet.
    </div>
  );
}

function ActivityRow({ entry }: { entry: DashboardActivityEntry }) {
  const [open, setOpen] = React.useState(false);
  const Icon = ACTIVITY_ICON_COMPONENTS[entry.icon] || Activity;
  const color = ACTIVITY_ICON_COLORS[entry.icon] || '#94A3B8';
  return (
    <li
      className="px-4 py-3 hover:bg-bg-surface-hover/40 transition-colors cursor-pointer"
      onClick={() => setOpen(o => !o)}
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${color}1F`, color }}>
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm text-text-primary truncate">{entry.label}</div>
            <div className="text-[11px] text-text-muted shrink-0">{formatRelative(entry.timestamp)}</div>
          </div>
          {entry.description && <div className="text-xs text-text-secondary mt-0.5 truncate">{entry.description}</div>}
          {open && entry.result && (
            <div className="mt-2 text-[11px] text-text-muted grid grid-cols-2 gap-1 max-w-md">
              {entry.result.processed != null && <div>Processed: <span className="text-text-primary">{entry.result.processed}</span></div>}
              {entry.result.created != null && <div>Created: <span className="text-text-primary">{entry.result.created}</span></div>}
              {entry.result.enriched != null && <div>Enriched: <span className="text-text-primary">{entry.result.enriched}</span></div>}
              {entry.result.failed ? <div>Failed: <span className="text-semantic-error">{entry.result.failed}</span></div> : null}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function Section({
  title, hint, headerRight, children,
}: { title: string; hint?: string; headerRight?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-xs uppercase tracking-widest text-text-muted">{title}</div>
        {headerRight}
      </div>
      {hint && <div className="text-[11px] text-text-muted/80 mb-3">{hint}</div>}
      {children}
    </section>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function minutesUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const m = Math.ceil(diff / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function secondsUntil(iso: string): number {
  const diff = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 1000));
}

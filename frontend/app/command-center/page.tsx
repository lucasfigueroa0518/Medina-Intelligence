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

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

export default function CommandCenterPage() {
  const [pulse, setPulse] = React.useState<DashboardPulse | null>(null);
  const [activity, setActivity] = React.useState<DashboardActivity | null>(null);
  const [sparks, setSparks] = React.useState<DashboardSparklines | null>(null);
  const [filter, setFilter] = React.useState<string>('all');

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

  return (
    <div className="flex-1 flex flex-col">
      <TopBar title="Command Center" />
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-10">
          <SystemPulseHero pulse={pulse} />
          <ActiveProcesses processes={pulse?.active_processes ?? []} />
          <CapacityGauges capacity={pulse?.capacity} />
          <QuickStatsBar stats={activity?.stats_24h} onFilter={setFilter} active={filter} />
          <ActivityFeed entries={activity?.recent_activity ?? []} filter={filter} />
          <Sparklines data={sparks} />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 1. System Pulse — hero orb
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
        {/* Outer pulse */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `radial-gradient(circle, ${color.ring} 0%, transparent 70%)`,
            animation: status !== 'error' ? `pulse-ring ${color.pulse} ease-in-out infinite` : 'none',
          }}
        />
        {/* Core orb */}
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
      <div className="text-xs text-text-muted uppercase tracking-widest">
        System Pulse
      </div>
      <style jsx>{`
        @keyframes pulse-ring {
          0%, 100% { transform: scale(1); opacity: 0.7; }
          50%      { transform: scale(1.15); opacity: 0.4; }
        }
        @keyframes orb-breathe {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.04); }
        }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Active Processes
// ────────────────────────────────────────────────────────────────────────────

const PROCESS_ICONS = {
  ingestion: Mail,
  enrichment: Brain,
  daily_cron: Wrench,
  backfill: Calendar,
  import: FileText,
  other: Activity,
} as const;

function ActiveProcesses({ processes }: { processes: DashboardPulse['active_processes'] }) {
  if (processes.length === 0) {
    return (
      <section>
        <SectionTitle>Active Processes</SectionTitle>
        <div className="card p-8 text-center text-sm text-text-muted">
          <div className="inline-block w-2 h-2 rounded-full bg-semantic-success animate-pulse mr-2 align-middle" />
          No active processes — system is idle.
        </div>
      </section>
    );
  }
  return (
    <section>
      <SectionTitle>Active Processes</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {processes.map(p => <ActiveProcessCard key={p.id} process={p} />)}
      </div>
    </section>
  );
}

function ActiveProcessCard({ process: p }: { process: DashboardPulse['active_processes'][number] }) {
  const Icon = PROCESS_ICONS[p.type] || Activity;
  // Local elapsed timer that updates every second without re-polling the API.
  const [elapsed, setElapsed] = React.useState(p.elapsed_seconds);
  React.useEffect(() => {
    setElapsed(p.elapsed_seconds);
    const i = window.setInterval(() => setElapsed(e => e + 1), 1000);
    return () => window.clearInterval(i);
  }, [p.elapsed_seconds, p.id]);

  const pct = p.progress?.percentage;
  return (
    <div
      className="card p-4 relative overflow-hidden"
      style={{ boxShadow: '0 0 0 1px rgba(139,92,246,0.25), 0 0 20px rgba(139,92,246,0.08)' }}
    >
      {/* Pulse border accent */}
      <div
        className="absolute inset-0 rounded-lg pointer-events-none"
        style={{
          border: '1px solid rgba(139,92,246,0.4)',
          animation: 'card-pulse 2s ease-in-out infinite',
        }}
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
        @keyframes card-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.9; } }
        @keyframes indeterminate-bar {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Capacity Gauges
// ────────────────────────────────────────────────────────────────────────────

function CapacityGauges({ capacity }: { capacity: DashboardPulse['capacity'] | undefined }) {
  return (
    <section>
      <SectionTitle>Capacity</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {capacity ? (
          <>
            <GaugeCard name="Claude AI" gauge={capacity.claude} unit="RPM" />
            <GaugeCard name="Gemini" gauge={capacity.gemini} unit="RPM" />
            <GaugeCard name="MS Graph" gauge={capacity.graph} unit="req" />
            <ServiceCard name="Slack" service={capacity.slack} />
            <ServiceCard name="ReverseContact" service={capacity.reversecontact} />
          </>
        ) : (
          <>{[0,1,2,3,4].map(i => <div key={i} className="card h-32 animate-pulse" />)}</>
        )}
      </div>
    </section>
  );
}

function GaugeCard({ name, gauge, unit }: { name: string; gauge: DashboardCapacityGauge; unit: string }) {
  const pct = gauge.percentage;
  const color = pct >= 80 ? '#EF4444' : pct >= 50 ? '#F59E0B' : '#22C55E';
  // Half-circle gauge — strokeDashoffset based on percentage
  const radius = 38;
  const circumference = Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  return (
    <div className="card p-4 text-center">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">{name}</div>
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
        <div className="absolute inset-x-0 bottom-0 text-base font-semibold" style={{ color }}>
          {pct}%
        </div>
      </div>
      <div className="text-xs text-text-primary mt-1 capitalize">{labelForStatus(gauge.status)}</div>
      {gauge.limit > 0 && (
        <div className="text-[10px] text-text-muted">{gauge.used.toLocaleString()} / {gauge.limit.toLocaleString()} {unit}</div>
      )}
    </div>
  );
}

function labelForStatus(s: DashboardCapacityGauge['status']): string {
  if (s === 'limited') return 'Rate limited';
  if (s === 'high') return 'Heavy';
  if (s === 'moderate') return 'Moderate';
  if (s === 'low') return 'Light';
  return 'Unknown';
}

function ServiceCard({ name, service }: { name: string; service: DashboardServiceStatus }) {
  const color =
    service.status === 'rate_limited' ? '#F59E0B' :
    service.status === 'circuit_open' || service.status === 'auth_failed' ? '#EF4444' :
    '#22C55E';
  return (
    <div className="card p-4 text-center flex flex-col justify-between">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{name}</div>
      <div className="my-3 flex items-center justify-center">
        <div
          className="w-4 h-4 rounded-full"
          style={{
            background: color,
            boxShadow: `0 0 14px ${color}80`,
            animation: service.status === 'active' || service.status === 'healthy'
              ? 'service-breathe 3s ease-in-out infinite' : 'none',
          }}
        />
      </div>
      <div className="text-xs text-text-primary">{service.label}</div>
      <style jsx>{`
        @keyframes service-breathe {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50%      { transform: scale(1.2); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Quick Stats Bar
// ────────────────────────────────────────────────────────────────────────────

const STAT_FILTERS: Array<{ key: string; emoji: string; label: string; field: keyof NonNullable<DashboardActivity['stats_24h']> }> = [
  { key: 'all',      emoji: '✨',  label: 'All',          field: 'emails_synced' },
  { key: 'email',    emoji: '📧', label: 'emails',        field: 'emails_synced' },
  { key: 'enrichment', emoji: '🧠', label: 'enriched',    field: 'contacts_enriched' },
  { key: 'meeting',  emoji: '🤝', label: 'meetings',      field: 'meetings_ingested' },
  { key: 'import',   emoji: '📄', label: 'documents',     field: 'documents_processed' },
  { key: 'news',     emoji: '📰', label: 'news',          field: 'emails_synced' },
];

function QuickStatsBar({
  stats, onFilter, active,
}: { stats: DashboardActivity['stats_24h'] | undefined; onFilter: (k: string) => void; active: string }) {
  return (
    <section>
      <SectionTitle>Last 24 hours</SectionTitle>
      <div className="card p-4 flex flex-wrap gap-3 items-center">
        <Stat emoji="📧" value={stats?.emails_synced} label="emails" onClick={() => onFilter(active === 'email' ? 'all' : 'email')} active={active === 'email'} />
        <Stat emoji="💬" value={stats?.slack_messages} label="Slack" />
        <Stat emoji="👤" value={stats?.contacts_discovered} label="contacts" />
        <Stat emoji="🤝" value={stats?.meetings_ingested} label="meetings" onClick={() => onFilter(active === 'meeting' ? 'all' : 'meeting')} active={active === 'meeting'} />
        <Stat emoji="📄" value={stats?.documents_processed} label="docs" onClick={() => onFilter(active === 'import' ? 'all' : 'import')} active={active === 'import'} />
        <Stat emoji="✅" value={stats?.contacts_enriched} label="enriched" onClick={() => onFilter(active === 'enrichment' ? 'all' : 'enrichment')} active={active === 'enrichment'} />
        <Stat emoji="📋" value={stats?.approval_items_created} label="proposals" />
        <Stat emoji="✓"  value={stats?.approval_items_resolved} label="approved" />
      </div>
    </section>
  );
}

function Stat({ emoji, value, label, onClick, active }: { emoji: string; value?: number; label: string; onClick?: () => void; active?: boolean }) {
  const display = value == null ? '—' : value.toLocaleString();
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md transition-all ${
        active ? 'bg-accent-magenta/15 text-accent-magenta' : 'hover:bg-bg-surface-hover text-text-primary'
      } ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <span>{emoji}</span>
      <AnimatedNumber value={value || 0} className="font-medium tabular-nums" fallback={display} />
      <span className="text-text-muted text-xs">{label}</span>
    </button>
  );
}

function AnimatedNumber({ value, className, fallback }: { value: number; className?: string; fallback: string }) {
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
  return <span className={className}>{shown == null ? fallback : shown.toLocaleString()}</span>;
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Recent Activity Feed
// ────────────────────────────────────────────────────────────────────────────

const ACTIVITY_ICON_COMPONENTS: Record<DashboardActivityEntry['icon'], LucideIcon> = {
  email: Mail,
  enrichment: Brain,
  meeting: Calendar,
  import: FileText,
  cron: Clock,
  error: AlertTriangle,
  news: Newspaper,
  cleanup: Wrench,
};

const ACTIVITY_ICON_COLORS: Record<DashboardActivityEntry['icon'], string> = {
  email: '#3B82F6',
  enrichment: '#8B5CF6',
  meeting: '#EC4899',
  import: '#22C55E',
  cron: '#94A3B8',
  error: '#EF4444',
  news: '#F59E0B',
  cleanup: '#06B6D4',
};

function ActivityFeed({ entries, filter }: { entries: DashboardActivityEntry[]; filter: string }) {
  const filtered = filter === 'all' ? entries : entries.filter(e => e.icon === filter || e.type === filter);
  return (
    <section>
      <SectionTitle>Recent Activity (last 24h)</SectionTitle>
      <div className="card p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-muted">
            No activity {filter !== 'all' ? `matching "${filter}"` : 'yet'}.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.slice(0, 50).map(e => <ActivityRow key={e.id} entry={e} />)}
          </ul>
        )}
      </div>
    </section>
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
          {entry.icon === 'error' ? <AlertTriangle size={14} /> : <Icon size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm text-text-primary truncate">{entry.label}</div>
            <div className="text-[11px] text-text-muted shrink-0">{formatRelative(entry.timestamp)}</div>
          </div>
          {entry.description && (
            <div className="text-xs text-text-secondary mt-0.5 truncate">{entry.description}</div>
          )}
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
// 6. Sparklines
// ────────────────────────────────────────────────────────────────────────────

function Sparklines({ data }: { data: DashboardSparklines | null }) {
  return (
    <section>
      <SectionTitle>API activity (last 24 hours)</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SparklineCard name="Claude AI" series={data?.claude} color="#8B5CF6" />
        <SparklineCard name="Gemini" series={data?.gemini} color="#EC4899" />
        <SparklineCard name="MS Graph" series={data?.graph} color="#3B82F6" />
        <SparklineCard name="Overall" series={data?.overall} color="#22C55E" />
      </div>
    </section>
  );
}

function SparklineCard({ name, series, color }: { name: string; series?: number[]; color: string }) {
  if (!series || series.length === 0) {
    return <div className="card p-4 h-28 animate-pulse" />;
  }
  const W = 220, H = 60;
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
    <div className="card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs text-text-muted uppercase tracking-wider">{name}</div>
        <div className="text-sm font-medium text-text-primary tabular-nums">{total.toLocaleString()}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14">
        <defs>
          <linearGradient id={`g-${name}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.4" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fillPath} fill={`url(#g-${name})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="text-[10px] text-text-muted mt-1">Peak {peak.toLocaleString()}/h</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-xs uppercase tracking-widest text-text-muted mb-3">{children}</div>;
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
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

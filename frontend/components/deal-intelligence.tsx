// Deal Intelligence components — sentiment, topics, risk, momentum, freshness.
// Single source of truth for both the board card (compact) and detail page
// (full). Consumers pass in a DealIntelligence object (from useDealIntelligence)
// and per-component size variants pick layout.
//
// All components default to clean empty-state rendering when intelligence is
// null / fields are absent — so calling them with a fresh useDealIntelligence
// state on a deal with no computed row produces sensible UI (gray sentiment
// dash, hidden topic / risk chips, flat sparkline).
//
// Per Lucas's "computed-cached state, frontend reads, never writes" lock:
// these components have no edit affordances. RiskFlag's popover lists
// signals but doesn't expose dismiss / override.

'use client';

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { DealIntelligence } from '@/lib/use-deal-intelligence';

/* ─── Sentiment ───────────────────────────────────────────────────────── */

/** Single visual: directional arrow + signed score, color-tiered.
 *  Tiers (per Lucas's spec):
 *    score > 0.3        → positive (green) "positive trajectory"
 *    -0.3 ≤ score ≤ 0.3 → neutral (gray)
 *    score < -0.3       → negative (red) "concerning trajectory"
 *    null               → empty-state gray dash
 *  Direction (improving/stable/declining) overrides arrow shape; tier
 *  drives color. When direction is null but score is present, color from
 *  score, arrow from "→ steady" fallback. */
export function SentimentIndicator({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const score = intelligence?.sentiment_score ?? null;
  const direction = intelligence?.sentiment_direction ?? null;

  if (score === null && direction === null) {
    return (
      <span
        className={`inline-flex items-center gap-1 ${size === 'detail' ? 'text-xs' : 'text-[10px]'} text-text-muted font-accent`}
        title="Sentiment: insufficient data yet"
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#71717A' }} />
        —
      </span>
    );
  }

  // Tier color from score; falls back to direction-only when score is null.
  const tier: 'positive' | 'neutral' | 'negative' =
    score !== null
      ? (score > 0.3 ? 'positive' : score < -0.3 ? 'negative' : 'neutral')
      : (direction === 'improving' ? 'positive' : direction === 'declining' ? 'negative' : 'neutral');

  const color = tier === 'positive' ? '#22C55E'
    : tier === 'negative' ? '#EF4444'
    : '#A1A1AA';

  const arrow = direction === 'improving' ? '↑'
    : direction === 'declining' ? '↓'
    : '→';

  const tooltip = `Sentiment: ${
    tier === 'positive' ? 'positive trajectory' :
    tier === 'negative' ? 'concerning trajectory' :
    'steady'
  }${score !== null ? ` · score ${score >= 0 ? '+' : ''}${score.toFixed(2)}` : ''}${
    direction ? ` · ${direction}` : ''
  }`;

  const scoreLabel = score === null ? '' : ` ${score >= 0 ? '+' : ''}${score.toFixed(2)}`;

  // The "glow" for positive/negative is a soft text-shadow at detail size;
  // compact size keeps it as a pure color chip for density.
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-accent font-semibold ${size === 'detail' ? 'text-base' : 'text-[10px]'}`}
      style={{
        color,
        textShadow: size === 'detail' && tier !== 'neutral' ? `0 0 8px ${color}40` : undefined,
      }}
      title={tooltip}
    >
      {arrow}{scoreLabel}
    </span>
  );
}

/* ─── Topic Chips ────────────────────────────────────────────────────── */

/** Lavender chips, max 5 visible (compact: max 2 + overflow count).
 *  Hidden entirely when active_topics is empty. Truncates gracefully —
 *  the overflow chip's title attribute lists the hidden topics. */
export function TopicChips({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const topics = intelligence?.active_topics ?? [];
  if (topics.length === 0) return null;

  const visibleCap = size === 'detail' ? 5 : 2;
  const visible = topics.slice(0, visibleCap);
  const overflow = topics.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((topic, i) => (
        <span
          key={`${topic}-${i}`}
          className={`text-[10px] font-accent ${size === 'detail' ? 'px-2 py-0.5' : 'px-1.5 py-0.5'} rounded`}
          style={{ background: 'rgba(139,92,246,0.10)', color: '#A78BFA' }}
        >
          #{topic}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="text-[10px] text-text-muted font-accent px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(255,255,255,0.04)' }}
          title={topics.slice(visibleCap).map(t => `#${t}`).join(' ')}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

/* ─── Risk Flag ──────────────────────────────────────────────────────── */

/** Single icon + count when risk_signal_count > 0. Click opens a popover
 *  listing each example with severity color. Hidden entirely when count
 *  is 0.
 *
 *  Severity colors per Lucas's spec:
 *    critical → red
 *    warning  → amber (default for unclassified)
 *    info     → gray
 *
 *  The badge color follows the highest severity present in the examples
 *  array; if no severity is set on any example, falls back to amber
 *  ("warning"). */
export function RiskFlag({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const [open, setOpen] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  // Close popover on outside click. Lightweight; the popover is short-lived.
  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const count = intelligence?.risk_signal_count ?? 0;
  const examples = intelligence?.risk_signal_examples ?? [];
  if (count === 0) return null;

  // Highest-severity badge color drives the chip's tint.
  const severities = examples.map(e => e.severity ?? 'warning');
  const hasCritical = severities.includes('critical');
  const hasWarning = severities.includes('warning');
  const badgeColor = hasCritical ? '#EF4444'
    : hasWarning ? '#F59E0B'
    : '#A1A1AA';
  const badgeBg = hasCritical ? 'rgba(239,68,68,0.10)'
    : hasWarning ? 'rgba(245,158,11,0.10)'
    : 'rgba(161,161,170,0.10)';

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
        className={`inline-flex items-center gap-1 font-accent font-semibold rounded ${size === 'detail' ? 'text-xs px-2 py-1' : 'text-[10px] px-1.5 py-0.5'}`}
        style={{ background: badgeBg, color: badgeColor }}
        title={`${count} risk signal${count === 1 ? '' : 's'} — click for detail`}
      >
        <AlertCircle size={size === 'detail' ? 12 : 10} />
        {count} risk{count === 1 ? '' : 's'}
      </button>

      {open && examples.length > 0 && (
        <div
          ref={popoverRef}
          className="absolute z-30 mt-1.5 left-0 rounded-lg shadow-xl p-3 min-w-[280px] max-w-[400px]"
          style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">
            {count} risk signal{count === 1 ? '' : 's'}
            {count > examples.length && ` (${examples.length} shown)`}
          </div>
          <div className="space-y-2">
            {examples.map((ex, i) => {
              const sev = ex.severity ?? 'warning';
              const dotColor = sev === 'critical' ? '#EF4444'
                : sev === 'warning' ? '#F59E0B'
                : '#A1A1AA';
              return (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                    style={{ background: dotColor }}
                    title={sev}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-text-primary leading-snug">{ex.text}</div>
                    {ex.sent_at && (
                      <div className="text-[10px] text-text-muted mt-0.5">
                        {new Date(ex.sent_at).toLocaleDateString('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}

/* ─── Momentum Sparkline ────────────────────────────────────────────── */

/** 4-week sparkline + directional arrow.
 *
 *  Empty state (no buckets, no trend): dashed flat baseline at midpoint
 *  so card layout stays stable when data lands.
 *
 *  Directional arrow (per Lucas's spec):
 *    increasing → ↗ accelerating (green)
 *    stable     → → steady (gray)
 *    decreasing → ↘ stalled / ↓ declining (red)
 *      (single 'decreasing' covers both visual states; we use ↘ as the
 *       neutral down indicator since the schema doesn't differentiate
 *       stalled-vs-declining)
 *    null       → no arrow, dashed flat baseline */
export function MomentumSparkline({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const buckets = intelligence?.momentum_buckets ?? [];
  const trend = intelligence?.momentum_trend ?? null;

  const W = size === 'detail' ? 80 : 40;
  const H = size === 'detail' ? 28 : 14;
  const PAD = size === 'detail' ? 3 : 2;

  const color = trend === 'increasing' ? '#22C55E'
    : trend === 'decreasing' ? '#EF4444'
    : '#71717A';

  const tooltip = buckets.length === 0
    ? 'Momentum: insufficient data yet'
    : `Momentum: ${trend ?? 'unknown'}` + (buckets.length > 0
      ? '\n' + buckets.map(b => `${b.week_start.slice(0, 10)}: ${b.count}`).join('\n')
      : '');

  const arrow = trend === 'increasing' ? '↗'
    : trend === 'decreasing' ? '↘'
    : trend === 'stable' ? '→'
    : '';

  // Empty state: dashed flat baseline. Card height never shifts.
  if (buckets.length === 0) {
    return (
      <span className="inline-flex items-center gap-1">
        <svg width={W} height={H} className="shrink-0">
          <title>{tooltip}</title>
          <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2}
            stroke="#71717A" strokeWidth={1} strokeDasharray="2 2" opacity={0.4} />
        </svg>
      </span>
    );
  }

  const counts = buckets.map(b => b.count);
  const maxC = Math.max(...counts, 1);
  const stepX = (W - 2 * PAD) / Math.max(buckets.length - 1, 1);
  const points = counts.map((c, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((c / maxC) * (H - 2 * PAD));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <span className="inline-flex items-center gap-1">
      <svg width={W} height={H} className="shrink-0">
        <title>{tooltip}</title>
        <polyline points={points} fill="none" stroke={color}
          strokeWidth={size === 'detail' ? 2 : 1.5}
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {arrow && (
        <span
          className={`font-accent font-semibold ${size === 'detail' ? 'text-sm' : 'text-[10px]'}`}
          style={{ color }}
          aria-label={trend ?? 'momentum'}
        >
          {arrow}
        </span>
      )}
    </span>
  );
}

/* ─── Freshness Indicator ───────────────────────────────────────────── */

/** Small "computed N min ago" + refresh icon.
 *
 *  is_stale=true on the response means "row served but background recompute
 *  is queued" — show subtle indicator (pulsing refresh icon) but don't
 *  block UI on stale-read. Click triggers manual refresh; T3's endpoint
 *  may not honor force-refresh in v1 (refresh just re-fetches; if the
 *  backend hasn't recomputed yet, we'll see is_stale=true again — that's
 *  fine, the user knows they tried).
 *
 *  When last_computed_at is null (no row exists yet), the indicator shows
 *  "—" with a "no data yet" tooltip and does NOT show a refresh icon
 *  (nothing to refresh). */
export function IntelligenceFreshnessIndicator({
  intelligence, onRefresh, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  onRefresh?: () => void;
  size?: 'compact' | 'detail';
}) {
  const computedAt = intelligence?.last_computed_at ?? null;
  const isStale = !!intelligence?.is_stale;

  const relativeLabel = computedAt ? fmtRelative(computedAt) : null;

  const fontClass = size === 'detail' ? 'text-xs' : 'text-[9px]';
  const iconSize = size === 'detail' ? 11 : 9;

  if (!relativeLabel) {
    return (
      <span className={`inline-flex items-center gap-1 ${fontClass} text-text-muted/60 italic`}
        title="No intelligence computed yet">
        — not computed
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 ${fontClass} text-text-muted`}
      title={`computed ${relativeLabel}${isStale ? ' · recompute queued' : ''}`}
    >
      <span>computed {relativeLabel}</span>
      {onRefresh && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRefresh(); }}
          className="hover:text-text-primary transition-colors"
          aria-label="Refresh intelligence"
        >
          <RefreshCw
            size={iconSize}
            className={isStale ? 'animate-spin' : ''}
            style={{ animationDuration: isStale ? '2s' : undefined }}
          />
        </button>
      )}
    </span>
  );
}

/* ─── helpers ─────────────────────────────────────────────────────────── */

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleDateString();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

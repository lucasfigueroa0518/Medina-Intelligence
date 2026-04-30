// Deal Intelligence components — sentiment, topics, risk, momentum, freshness.
// Single source of truth for both the board card (compact) and detail page
// (full). Consumers pass in a DealIntelligence object (from useDealIntelligence)
// and per-component size variants pick layout.
//
// All components default to clean empty-state rendering when intelligence is
// null / fields are absent — so calling them with a fresh useDealIntelligence
// state on a deal with no computed row produces sensible UI (gray sentiment
// dash, hidden topic / risk chips, "no momentum" indicator).
//
// Per the architectural lock — "computed-cached state, frontend reads, never
// writes" — these components have no edit affordances. RiskFlag's popover
// lists signals but doesn't expose dismiss / override. If a user disagrees
// with computed intelligence, they edit underlying data (conversations or
// the deal record), which fires T3's invalidation hook → recompute.
//
// Field names match T3's actual schema (PR #15, migration 0069):
// sentiment + sentiment_score, topics, risk_signals (with severity in-band),
// momentum + momentum_score, conversation_count, computed_at, is_stale.

'use client';

import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { DealIntelligence } from '@/lib/use-deal-intelligence';

/* ─── Sentiment ───────────────────────────────────────────────────────── */

/** Single visual: arrow + signed score, color-tiered.
 *  Tiers (from categorical `sentiment` column, with score as tiebreaker):
 *    sentiment='positive' → green "positive trajectory"
 *    sentiment='neutral'  → gray "neutral / steady"
 *    sentiment='negative' → red "concerning trajectory"
 *    sentiment=null       → empty-state gray dash
 *
 *  When sentiment is null but sentiment_score is present (rare given T3's
 *  contract — they're produced together), we tier by score: >0.3 positive,
 *  <-0.3 negative, otherwise neutral. */
export function SentimentIndicator({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const sentiment = intelligence?.sentiment ?? null;
  const score = intelligence?.sentiment_score ?? null;

  if (sentiment === null && score === null) {
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

  // Tier from categorical sentiment first; fall back to score thresholds.
  const tier: 'positive' | 'neutral' | 'negative' =
    sentiment === 'positive' ? 'positive'
      : sentiment === 'negative' ? 'negative'
      : sentiment === 'neutral' ? 'neutral'
      : score !== null && score > 0.3 ? 'positive'
      : score !== null && score < -0.3 ? 'negative'
      : 'neutral';

  const color = tier === 'positive' ? '#22C55E'
    : tier === 'negative' ? '#EF4444'
    : '#A1A1AA';

  const arrow = tier === 'positive' ? '↑' : tier === 'negative' ? '↓' : '→';

  const tooltip = `Sentiment: ${
    tier === 'positive' ? 'positive trajectory' :
    tier === 'negative' ? 'concerning trajectory' :
    'neutral'
  }${score !== null ? ` · score ${score >= 0 ? '+' : ''}${score.toFixed(2)}` : ''}`;

  const scoreLabel = score === null ? '' : ` ${score >= 0 ? '+' : ''}${score.toFixed(2)}`;

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
 *  Hidden entirely when topics array is empty. T3 caps the array at 8 in
 *  the prompt design; we surface up to 5 in detail size before overflow. */
export function TopicChips({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const topics = intelligence?.topics ?? [];
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

/** Single icon + count when risk_signals.length > 0. Click opens a popover
 *  listing each signal with severity color + detail text. Hidden entirely
 *  when count is 0.
 *
 *  Severity colors (from T3's prompt design, severity is in-band):
 *    critical → red
 *    warning  → amber
 *    info     → gray
 *
 *  Badge tint follows the highest severity present in the array. */
export function RiskFlag({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const [open, setOpen] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

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

  const signals = intelligence?.risk_signals ?? [];
  const count = signals.length;
  if (count === 0) return null;

  // Highest severity drives badge color.
  const severities = signals.map(s => s.severity);
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

      {open && (
        <div
          ref={popoverRef}
          className="absolute z-30 mt-1.5 left-0 rounded-lg shadow-xl p-3 min-w-[280px] max-w-[420px]"
          style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">
            {count} risk signal{count === 1 ? '' : 's'}
          </div>
          <div className="space-y-2">
            {signals.map((s, i) => {
              const dotColor = s.severity === 'critical' ? '#EF4444'
                : s.severity === 'warning' ? '#F59E0B'
                : '#A1A1AA';
              return (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                    style={{ background: dotColor }}
                    title={s.severity}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-[10px] uppercase tracking-wider font-accent"
                        style={{ color: dotColor }}
                      >
                        {s.severity}
                      </span>
                      <span className="text-[10px] text-text-muted">{s.type}</span>
                    </div>
                    <div className="text-text-primary leading-snug mt-0.5">{s.detail}</div>
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

/* ─── Momentum ──────────────────────────────────────────────────────── */

/** Directional indicator from T3's 4-categorical momentum:
 *    accelerating → ↗ green
 *    steady       → → gray
 *    stalled      → → amber (visually distinct from steady — same arrow,
 *                            warning color signals "should be moving but
 *                            isn't")
 *    declining    → ↘ red
 *    null         → dashed flat baseline (insufficient data)
 *
 *  T3's schema doesn't return week-by-week buckets, so this is an
 *  arrow + label rather than a sparkline. momentum_score adjusts
 *  intensity (deeper color when more extreme); compact mode skips score
 *  for density. */
export function MomentumSparkline({
  intelligence, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  size?: 'compact' | 'detail';
}) {
  const momentum = intelligence?.momentum ?? null;
  const score = intelligence?.momentum_score ?? null;
  const W = size === 'detail' ? 32 : 18;
  const H = size === 'detail' ? 18 : 14;

  if (momentum === null) {
    return (
      <span className="inline-flex items-center gap-1" title="Momentum: insufficient data yet">
        <svg width={W} height={H} className="shrink-0">
          <line x1={2} y1={H / 2} x2={W - 2} y2={H / 2}
            stroke="#71717A" strokeWidth={1} strokeDasharray="2 2" opacity={0.4} />
        </svg>
      </span>
    );
  }

  const config: Record<NonNullable<DealIntelligence['momentum']>, { arrow: string; color: string; label: string }> = {
    accelerating: { arrow: '↗', color: '#22C55E', label: 'accelerating' },
    steady:       { arrow: '→', color: '#A1A1AA', label: 'steady' },
    stalled:      { arrow: '→', color: '#F59E0B', label: 'stalled' },
    declining:    { arrow: '↘', color: '#EF4444', label: 'declining' },
  };
  const { arrow, color, label } = config[momentum];

  const tooltip = `Momentum: ${label}${
    score !== null ? ` · score ${score >= 0 ? '+' : ''}${score.toFixed(2)}` : ''
  }`;

  return (
    <span
      className={`inline-flex items-center gap-1 font-accent font-semibold ${size === 'detail' ? 'text-base' : 'text-[10px]'}`}
      style={{ color }}
      title={tooltip}
    >
      {arrow}
      {size === 'detail' && (
        <span className="text-[10px] capitalize text-text-muted">{label}</span>
      )}
    </span>
  );
}

/* ─── Freshness Indicator ───────────────────────────────────────────── */

/** Small "computed N min ago" + refresh icon.
 *
 *  is_stale=true on the response means "row served from cache, recompute
 *  queued via ctxExec.waitUntil" — show subtle indicator (pulsing refresh
 *  icon) but don't block UI. Click triggers manual refresh; if backend
 *  hasn't recomputed yet, we'll see is_stale=true again — that's fine.
 *
 *  When intelligence is null (404 from endpoint, no row exists), shows
 *  "— not computed" with no refresh icon (nothing to refresh). */
export function IntelligenceFreshnessIndicator({
  intelligence, onRefresh, size = 'compact',
}: {
  intelligence: DealIntelligence | null;
  onRefresh?: () => void;
  size?: 'compact' | 'detail';
}) {
  const computedAt = intelligence?.computed_at ?? null;
  const isStale = !!intelligence?.is_stale;

  const fontClass = size === 'detail' ? 'text-xs' : 'text-[9px]';
  const iconSize = size === 'detail' ? 11 : 9;

  if (!computedAt) {
    return (
      <span
        className={`inline-flex items-center gap-1 ${fontClass} text-text-muted/60 italic`}
        title="No intelligence computed yet"
      >
        — not computed
      </span>
    );
  }

  const relativeLabel = fmtRelative(computedAt);

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

// Q12 — synthetic observations panel.
//
// Renders the entity's active (non-dismissed) synthetic observations
// from synthetic_observations. Observation classes (personal_update,
// follow_up_commitment, relationship_*, product_update, partnership)
// are NOT canonical entity fields — they're discoverable signals from
// LLM extraction over conversations the user can read. 1-channel =
// SHOW per the locked Wave 6 spec; multi-channel STRENGTHENS metadata
// (channels[] grows, last_observed_at advances).
//
// Drop-in usage:
//   <RecentObservations entityType="contact" entityId={id} />
//
// Self-contained — fetches its own data on mount, exposes per-row
// dismiss. Detail pages just need the import + one render line.

'use client';

import * as React from 'react';
import { api } from '@/lib/api';

type EntityType = 'contact' | 'company' | 'deal';

interface Observation {
  id: string;
  observation_type: string;
  observation_value: string;
  channels: string[];
  confidence: number;
  evidence: string | null;
  source_communication_id: string | null;
  first_observed_at: string;
  last_observed_at: string;
}

const OBSERVATION_LABELS: Record<string, string> = {
  personal_update: 'Personal update',
  follow_up_commitment: 'Follow-up commitment',
  product_update: 'Product update',
  partnership: 'Partnership',
  relationship_knows_person: 'Knows person',
  relationship_decision_maker: 'Decision maker',
  relationship_introduction_offer: 'Introduction offered',
};

function labelFor(type: string): string {
  return OBSERVATION_LABELS[type] || type.replace(/_/g, ' ');
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// Some observation values are JSON (relationship_* signals carry a
// structured object); others are plain strings. Best-effort render.
function renderValue(v: string): React.ReactNode {
  const trimmed = v.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Pull a few human-readable fields if present, fall back to
        // compact JSON otherwise.
        const desc = parsed.description || parsed.detail || parsed.summary;
        if (desc) return <span>{String(desc)}</span>;
        return <span className="font-mono text-[10px] text-text-muted/80">{JSON.stringify(parsed)}</span>;
      }
    } catch { /* fall through to raw string */ }
  }
  return <span>{v}</span>;
}

export function RecentObservations({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: string;
}) {
  const [observations, setObservations] = React.useState<Observation[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listEntityObservations(entityType, entityId);
      setObservations(res.observations || []);
    } catch (e: any) {
      // Tolerate the endpoint not being live yet (404) — section
      // simply doesn't render. Avoids breaking the detail page when
      // the producer side hasn't deployed.
      const msg = String(e?.message || '');
      if (!msg.includes('404')) setError(msg.slice(0, 200));
      setObservations([]);
    }
    setLoading(false);
  }, [entityType, entityId]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function dismiss(id: string) {
    try {
      await api.dismissObservation(id);
      // Optimistic remove — server confirmed by 200.
      setObservations(prev => prev.filter(o => o.id !== id));
    } catch (e) {
      console.error('[recent-observations] dismiss failed', e);
    }
  }

  // Hide entirely when there's nothing useful to render. Keeps the
  // detail page clean for entities that haven't been observed.
  if (loading) return null;
  if (error) return null;
  if (observations.length === 0) return null;

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: 'rgba(17,17,20,0.5)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Recent observations
          </span>
          <span
            className="px-2 py-0.5 rounded-full text-[9px] font-semibold"
            style={{ background: 'rgba(168,85,247,0.15)', color: '#C084FC' }}
          >
            {observations.length}
          </span>
        </div>
        <span className="text-[10px] text-text-muted/60 italic">
          LLM-extracted from conversations you can read · not editable fields
        </span>
      </div>
      <div>
        {observations.map(o => (
          <div
            key={o.id}
            className="grid grid-cols-[110px_1fr_72px_28px] gap-x-2 items-start px-4 py-2"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
          >
            <span className="text-[10px] font-semibold text-purple-400/80 uppercase tracking-wider truncate">
              {labelFor(o.observation_type)}
            </span>
            <div className="text-xs text-text-secondary">
              {renderValue(o.observation_value)}
              {o.evidence && (
                <div className="text-[10px] text-text-muted/60 italic mt-0.5 line-clamp-2">
                  evidence: {o.evidence}
                </div>
              )}
            </div>
            <div
              className="text-[10px] text-text-muted/70 text-right tabular-nums"
              title={`First: ${o.first_observed_at}\nLast: ${o.last_observed_at}\nChannels: ${o.channels.join(', ')}`}
            >
              <div>{timeAgo(o.last_observed_at)}</div>
              <div className="text-[9px] text-text-muted/60">
                {o.channels.length}ch · {Math.round(o.confidence * 100)}%
              </div>
            </div>
            <button
              onClick={() => dismiss(o.id)}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-red-500/20 transition-colors text-text-muted/70 hover:text-text-secondary"
              title="Dismiss this observation (re-sightings will re-surface it)"
              style={{ background: 'rgba(255,255,255,0.02)' }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

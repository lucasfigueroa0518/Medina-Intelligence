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
  personal_update: 'Personal Update',
  follow_up_commitment: 'Follow-Up',
  product_update: 'Product Update',
  partnership: 'Partnership',
  relationship_knows_person: 'Knows Person',
  relationship_decision_maker: 'Decision Maker',
  relationship_introduction_offer: 'Intro Offer',
};

function labelFor(type: string): string {
  return OBSERVATION_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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

interface ParsedObservationValue {
  speaker?: unknown;
  signal_type?: unknown;
  people_involved?: unknown;
  people?: unknown;
  value?: unknown;
  evidence?: unknown;
  description?: unknown;
  detail?: unknown;
  summary?: unknown;
  confidence?: unknown;
}

interface DisplayObservation {
  label: string;
  summary: string;
  evidence: string | null;
  speaker: string | null;
  people: string[];
  confidence: number;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  return normalized || null;
}

function normalizePeople(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const people: string[] = [];
  value.forEach(item => {
    const text = normalizeText(item);
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    people.push(text);
  });
  return people;
}

function mergePeople(primary: string[], secondary: string[]): string[] {
  const seen = new Set(primary.map(person => person.toLowerCase()));
  return primary.concat(secondary.filter(person => {
    const key = person.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function parseObservationValue(raw: string): ParsedObservationValue | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ParsedObservationValue;
    }
  } catch {
    return null;
  }
  return null;
}

function formatObservation(o: Observation): DisplayObservation {
  const parsed = parseObservationValue(o.observation_value);
  const primaryPeople = normalizePeople(parsed?.people_involved);
  const people = mergePeople(primaryPeople, normalizePeople(parsed?.people));
  const rawFallback = o.observation_value.trim().startsWith('{')
    ? null
    : normalizeText(o.observation_value);
  const summary = normalizeText(parsed?.value)
    || normalizeText(parsed?.summary)
    || normalizeText(parsed?.description)
    || normalizeText(parsed?.detail)
    || rawFallback
    || 'Observation captured from recent communications.';
  const parsedConfidence = typeof parsed?.confidence === 'number' ? parsed.confidence : null;
  return {
    label: labelFor(o.observation_type || normalizeText(parsed?.signal_type) || 'Observation'),
    summary,
    evidence: normalizeText(parsed?.evidence) || normalizeText(o.evidence),
    speaker: normalizeText(parsed?.speaker),
    people,
    confidence: parsedConfidence ?? o.confidence,
  };
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
        <span className="hidden text-[10px] text-text-muted/60 sm:inline">
          Signals from recent communications · dismiss anything no longer useful
        </span>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {observations.map(o => {
          const display = formatObservation(o);
          const visiblePeople = display.people.slice(0, 4);
          const hiddenPeople = Math.max(0, display.people.length - visiblePeople.length);

          return (
          <div
            key={o.id}
            className="grid grid-cols-[1fr_32px] gap-3 px-4 py-4 md:grid-cols-[150px_1fr_96px_28px] md:gap-x-4"
          >
            <div className="min-w-0">
              <span className="inline-flex max-w-full rounded-md bg-purple-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-purple-300">
                <span className="truncate">{display.label}</span>
              </span>
              {display.speaker && (
                <div className="mt-2 truncate text-[11px] text-text-muted">
                  Mentioned by {display.speaker}
                </div>
              )}
            </div>
            <div className="col-span-2 min-w-0 md:col-span-1 md:col-start-2">
              <p className="text-sm leading-relaxed text-text-secondary">
                {display.summary}
              </p>
              {visiblePeople.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {visiblePeople.map(person => (
                    <span
                      key={person}
                      className="max-w-[180px] truncate rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-text-muted"
                    >
                      {person}
                    </span>
                  ))}
                  {hiddenPeople > 0 && (
                    <span className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-text-muted">
                      +{hiddenPeople}
                    </span>
                  )}
                </div>
              )}
              {display.evidence && (
                <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[11px] leading-relaxed text-text-muted">
                  <span className="font-semibold uppercase tracking-wide text-text-muted/80">Evidence: </span>
                  <span className="line-clamp-2">{display.evidence}</span>
                </div>
              )}
            </div>
            <div
              className="col-span-2 text-left text-[10px] tabular-nums text-text-muted/70 md:col-span-1 md:text-right"
              title={`First: ${o.first_observed_at}\nLast: ${o.last_observed_at}\nChannels: ${o.channels.join(', ')}`}
            >
              <div>{timeAgo(o.last_observed_at)}</div>
              <div className="text-[9px] text-text-muted/60">
                {o.channels.length}ch · {Math.round(display.confidence * 100)}%
              </div>
            </div>
            <button
              onClick={() => dismiss(o.id)}
              className="w-7 h-7 md:w-5 md:h-5 rounded flex items-center justify-center hover:bg-red-500/20 transition-colors text-text-muted/70 hover:text-text-secondary row-start-1 col-start-2 md:row-auto md:col-auto justify-self-end"
              title="Dismiss this observation (re-sightings will re-surface it)"
              style={{ background: 'rgba(255,255,255,0.02)' }}
            >
              ×
            </button>
          </div>
          );
        })}
      </div>
    </div>
  );
}

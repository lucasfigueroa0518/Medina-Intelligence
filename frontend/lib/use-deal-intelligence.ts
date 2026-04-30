// useDealIntelligence — React hook for reading deal_intelligence from the
// future GET /api/deals/:id/intelligence endpoint. Returns mock empty state
// today; will swap to real fetch in Step 3 once T3's schema PR merges.
//
// ACL invariant (per docs/deal-intelligence-contract.md): the table's PK is
// (deal_id, computed_for_user_id) — sentiment / topics / risk are derived
// from conversation bodies the user can read, so each user gets their own
// row. The hook is scoped per (deal_id, current user via auth header), so
// each component instance owns its own state. No cross-user caching at the
// client layer — the auth header keys it server-side.
//
// Per Lucas's freshness policy (1h staleness acceptable, server does
// nightly batch + event-driven invalidation): we DON'T poll. Single fetch
// per mount + manual refresh on user action. is_stale=true from the server
// means "row served but background recompute is queued" — show subtle
// indicator, don't block UI.

'use client';

import React from 'react';

/** Shape returned by the future GET /api/deals/:id/intelligence endpoint.
 *  Mirrors the deal_intelligence schema in docs/deal-intelligence-contract.md.
 *  Fields decoded from JSON columns are typed as their parsed shape (not
 *  raw strings) — the API handler is expected to JSON.parse before
 *  returning. */
export interface DealIntelligence {
  deal_id: string;
  /** -1 .. +1, null when insufficient data */
  sentiment_score: number | null;
  /** improving / stable / declining, null when insufficient data */
  sentiment_direction: 'improving' | 'stable' | 'declining' | null;
  /** Lowercase kebab-case strings, max 5 entries per contract. */
  active_topics: string[];
  /** Count from risk_signal_count column (independent of array length —
   *  examples are capped at 5 but count may be higher). */
  risk_signal_count: number;
  /** Up to 5 examples per contract. severity is optional in case T3's v1
   *  schema doesn't classify; we default to 'warning' for unclassified
   *  signals so they always render visibly. */
  risk_signal_examples: Array<{
    text: string;
    source_id?: string;
    source_type?: 'conversation' | 'event';
    sent_at?: string;
    severity?: 'critical' | 'warning' | 'info';
  }>;
  /** increasing / decreasing / stable, null when insufficient data */
  momentum_trend: 'increasing' | 'decreasing' | 'stable' | null;
  /** 4-week sparkline data: { week_start: ISO, count: int } */
  momentum_buckets: Array<{ week_start: string; count: number }>;
  /** ISO timestamp; null only when never computed (UI fallback to "—") */
  last_computed_at: string | null;
  /** True when row served but a background recompute is queued. UI shows
   *  subtle indicator; doesn't block render on stale-read per Lucas's
   *  1h-staleness-acceptable freshness policy. */
  is_stale: boolean;
}

export interface UseDealIntelligenceState {
  /** The intelligence payload, or null when not yet loaded / no row exists yet. */
  intelligence: DealIntelligence | null;
  loading: boolean;
  error: string | null;
  /** Trigger a manual refresh. T3's endpoint may or may not support a
   *  force_refresh hint in v1 — refresh just re-fetches; if the row is
   *  still stale on the server, we'll see is_stale=true again. Manual
   *  refresh is mostly for "I just edited this deal, want fresh data
   *  before continuing." */
  refresh: () => void;
}

/** Mock empty state shape — matches what the hook returns when no row
 *  exists or the endpoint is mocked. Components render their empty-state
 *  paths against this shape today. */
function emptyIntelligence(dealId: string): DealIntelligence {
  return {
    deal_id: dealId,
    sentiment_score: null,
    sentiment_direction: null,
    active_topics: [],
    risk_signal_count: 0,
    risk_signal_examples: [],
    momentum_trend: null,
    momentum_buckets: [],
    last_computed_at: null,
    is_stale: false,
  };
}

/** Hook reading deal_intelligence for a single deal. Today returns mock
 *  empty state on every call (no API call yet). Step 3 of the consumer
 *  build replaces the mock body with a real fetch against
 *  GET /api/deals/:id/intelligence once T3's schema lands. The component
 *  consumer surface (return shape) is locked — flipping the implementation
 *  is a one-file change. */
export function useDealIntelligence(dealId: string | null | undefined): UseDealIntelligenceState {
  const [intelligence, setIntelligence] = React.useState<DealIntelligence | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!dealId) {
      setIntelligence(null);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);

    // STEP 1 mock: synchronously resolve to empty state. Replaced in STEP 3
    // with a real api.getDealIntelligence(dealId) call.
    Promise.resolve(emptyIntelligence(dealId)).then(intel => {
      if (!alive) return;
      setIntelligence(intel);
      setLoading(false);
    });

    return () => { alive = false; };
  }, [dealId, tick]);

  const refresh = React.useCallback(() => setTick(t => t + 1), []);

  return { intelligence, loading, error, refresh };
}

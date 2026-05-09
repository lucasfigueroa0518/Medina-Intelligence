// useDealIntelligence — React hook for reading deal_intelligence from
// GET /api/deals/:id/intelligence (T3 producer side, live on worker
// 82c62635 as of Day-5 deal_intelligence dispatch).
//
// ACL invariant: the table's PK is (deal_id, user_id) — sentiment / topics /
// risk are derived from conversation bodies the user can read, so each user
// gets their own row. The endpoint is scoped per (deal_id, current user via
// auth header), so each component instance owns its own state. No cross-
// user caching at the client layer — the auth header keys it server-side.
//
// Per Lucas's freshness policy (1h staleness acceptable, server does
// nightly batch + event-driven invalidation): we DON'T poll. Single fetch
// per mount + manual refresh on user action. is_stale=true from the server
// means "row served but background recompute is queued via ctxExec.waitUntil"
// — show subtle indicator, don't block UI.

'use client';

import React from 'react';
import { api, ApiError } from '@/lib/api';

/** Shape returned by GET /api/deals/:id/intelligence. Mirrors T3's schema
 *  (migration 0069_deal_intelligence.sql, PR #15 commit bf63166).
 *  Contract version v1.0 — locked in issue #4 ack thread.
 *
 *  All fields nullable when no signal could be extracted (deal has no
 *  readable conversations for the requesting user). The "no signal" path
 *  responds with all signal fields null/empty and `conversation_count: 0`. */
export interface DealIntelligence {
  deal_id: string;
  user_id: string;
  /** Categorical sentiment. Null when insufficient data. */
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  /** -1..+1 score. Null when insufficient data. */
  sentiment_score: number | null;
  /** Deal-relevant nouns, max 8 per T3's prompt design. Empty when none. */
  topics: string[];
  /** Up to 6 entries per T3's prompt design. Each cites concrete evidence
   *  via `detail`. */
  risk_signals: Array<{
    type: string;
    severity: 'info' | 'warning' | 'critical';
    detail: string;
  }>;
  /** 4-categorical momentum. Null when insufficient data. */
  momentum: 'accelerating' | 'steady' | 'stalled' | 'declining' | null;
  /** -1..+1 momentum score. Null when insufficient data. */
  momentum_score: number | null;
  /** Number of readable conversations contributing to the compute. */
  conversation_count: number;
  /** Wave 3 — 2-3 sentence prose "State of the Union" summary, recency-biased
   *  (last 14 days dominate). Null when no signal. ACL-filtered the same way
   *  as topics/risks — derived from the same readable conversation set. */
  brief_summary: string | null;
  /** ISO timestamp of last successful compute. */
  computed_at: string;
  /** True when the row served is from cache and a background recompute is
   *  queued. UI shows a subtle indicator; doesn't block render. */
  is_stale: boolean;
}

export interface UseDealIntelligenceState {
  intelligence: DealIntelligence | null;
  loading: boolean;
  error: string | null;
  /** Trigger a manual refresh — re-fetches the endpoint. The server
   *  decides whether to recompute or serve cache (it returns is_stale=true
   *  when serving cache + recompute-queued). Refresh is for "I just edited
   *  this deal, want fresher data" scenarios. */
  refresh: () => void;
}

/** Hook reading deal_intelligence for a single deal. Per-mount fetch + manual
 *  refresh. Each component instance owns its own state. */
export function useDealIntelligence(dealId: string | null | undefined): UseDealIntelligenceState {
  const [intelligence, setIntelligence] = React.useState<DealIntelligence | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!dealId || String(dealId).startsWith('demo-')) {
      setIntelligence(null);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);

    api.getDealIntelligence(dealId)
      .then(intel => {
        if (!alive) return;
        setIntelligence(intel);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // 404 = no row exists for this (deal, user) pair AND cold-path
        // compute didn't fire. Treat as "no data" rather than error so the
        // empty-state components render cleanly. Other errors surface as
        // text but components fall back to empty-state rendering anyway.
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 404) {
          setIntelligence(null);
        } else {
          const msg = e instanceof Error ? e.message : 'Intelligence unavailable';
          setError(msg);
          setIntelligence(null);
        }
        setLoading(false);
      });

    return () => { alive = false; };
  }, [dealId, tick]);

  const refresh = React.useCallback(() => setTick(t => t + 1), []);

  return { intelligence, loading, error, refresh };
}

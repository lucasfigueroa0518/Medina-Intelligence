# Deal Intelligence Data Contract — for T3 review

**Status:** proposed (not yet approved by T3)
**Owner of consumer code (read-side handler + UI scaffolding):** T1 (Day 5 deal card DNA redesign)
**Owner of producer code (evaluator + recompute):** T3 (Wave 6 evaluator extension)
**Filed:** 2026-04-30 (Day 5)

---

## What this is

The new deal card DNA renders four intelligence signals — **sentiment**, **active topics**, **risk flags**, **momentum** — that don't exist in the schema yet. T3 is building the Wave 6 evaluator that will produce these signals as proposals routing through the approval pipeline. This document specifies the storage shape and freshness contract that **both** sides build to, so neither has to wait on the other to make progress.

The card UI (T1's work, this branch) is shipping with empty-state scaffolding for these fields TODAY. When T3's evaluator lands and starts populating `deal_intelligence`, the UI fills in automatically. No coordination beyond this contract.

---

## Schema

```sql
CREATE TABLE deal_intelligence (
  -- COMPOSITE PK: (deal_id, computed_for_user_id) — see "Per-user storage" below.
  deal_id              TEXT NOT NULL,
  computed_for_user_id TEXT NOT NULL,
  org_id               TEXT NOT NULL,

  -- Sentiment: -1 (very negative) → +1 (very positive). NULL when insufficient data.
  sentiment_score      REAL,
  -- Direction over recent window (proposed: last 14d vs prior 14d). NULL when insufficient data.
  sentiment_direction  TEXT CHECK (sentiment_direction IS NULL OR
    sentiment_direction IN ('improving','stable','declining')),

  -- Active topics — JSON array of plain strings, lowercase, kebab-case, max 5 entries.
  -- Examples: ["term-sheet","legal-review","valuation-discussion"]
  active_topics        TEXT NOT NULL DEFAULT '[]',

  -- Risk signals.
  risk_signal_count    INTEGER NOT NULL DEFAULT 0,
  -- Capped at 5 examples to keep row size bounded. Each element:
  --   { text: string, source_id: string, source_type: 'conversation'|'event', sent_at: ISO }
  -- For a "full risk log" view we'll either expand the cap or move to a child table later.
  risk_signal_examples TEXT NOT NULL DEFAULT '[]',

  -- Momentum: trend in conversation+meeting volume.
  momentum_trend       TEXT CHECK (momentum_trend IS NULL OR
    momentum_trend IN ('increasing','decreasing','stable')),
  -- 4-week sparkline series: [{week_start: '2026-04-07', count: 5}, ...]
  -- Card uses momentum_trend; detail-page sparkline uses momentum_buckets.
  momentum_buckets     TEXT NOT NULL DEFAULT '[]',

  last_computed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Freshness flag. Event-driven invalidation flips this to 1; recompute clears it.
  is_stale             INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (deal_id, computed_for_user_id),
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
);
CREATE INDEX idx_deal_intel_user_org    ON deal_intelligence(computed_for_user_id, org_id);
CREATE INDEX idx_deal_intel_recompute   ON deal_intelligence(last_computed_at);
CREATE INDEX idx_deal_intel_stale       ON deal_intelligence(is_stale, last_computed_at)
  WHERE is_stale = 1;
```

---

## Per-user storage rationale (NON-NEGOTIABLE)

The same deal can have different `sentiment_score` / `active_topics` / `risk_signal_examples` for different users in the same org because:

1. Sentiment is computed from conversation **bodies** the user can read.
2. User A and User B may have different `canReadEmailContent(...)` results for the same conversation set (the existing helper at `src/lib/helpers.ts:219-234`).
3. A single "global" deal_intelligence row would either:
   - **Leak** — non-participants see derived signals from email bodies they can't read directly.
   - **Be wrong for owners** — global = lowest-common-denominator sees-everything-except-private-emails view, which is meaningless for owners who SHOULD see everything.
   - **Race + stale** — store the most-recent requesting-user's view, get inconsistency across users.

Per-user is the only correct architecture. T3's compute path:
1. For each `(deal_id, user_id)` pair where the user is in the deal's org
2. Fetch the conversation set linked to the deal via `deal_contacts → conversation_contacts → conversations`
3. **Apply `canReadEmailContent(...)` to filter the input set** (this is the load-bearing ACL invariant)
4. Run the evaluator on the filtered set
5. UPSERT one row per pair

---

## Freshness contract (set from above by Lucas, 2026-04-30)

### Acceptable staleness
**1 hour.** Reads can return data up to 1 hour old without recompute.

### Recompute strategy: nightly batch + event-driven invalidation

**Nightly batch:** T3 schedules a recompute job (cron, time TBD by T3) that walks all `(deal_id, user_id)` pairs and refreshes everything older than 24h. This guarantees a daily floor on staleness regardless of activity.

**Event-driven invalidation:** When a new conversation lands AND it's tied to a contact in any `deal_contacts` row, mark the corresponding `deal_intelligence` rows stale (`is_stale = 1`) for ALL users in that org (since each user's view may have shifted). Recompute fires either:
- Lazily on next read (read-side handler checks `is_stale=1` → triggers recompute → returns fresh)
- OR within 1 hour via a sweeper job (T3's call which mechanism)
- Whichever comes first.

### Read-side handler behavior (T1 builds this)

The handler (`GET /api/deals/:id/intelligence` or merged into `GET /api/deals/:id`) does:

```ts
1. SELECT * FROM deal_intelligence WHERE deal_id = ? AND computed_for_user_id = ctx.userId
2. If no row OR (now - last_computed_at) > 1h OR is_stale = 1:
     a. Trigger recompute (request-scoped; T3 exposes a function or queues a job)
     b. Return stale data with a `needs_refresh: true` flag (UI shows "updating...")
        OR block on recompute if T3's recompute is fast enough (< 500ms)
3. Else: return the row with `needs_refresh: false`
```

**T3 to confirm:** is the evaluator fast enough to block-on-read, or do we always show stale data with an async refresh?

---

## Surface area for T3

T3 owns:
1. The schema migration (this doc proposes 0067 number; T3 may renumber)
2. The evaluator that produces sentiment / topics / risk / momentum given an ACL-filtered conversation set
3. The compute path: `(deal_id, user_id) → fetch ACL-filtered conversations → evaluator → UPSERT`
4. The cron job for nightly recompute
5. The event-driven invalidation hook (probably in `processClassifiedItems` or the ingestion finalizer — fires when a new conversation has a deal_contact participant)
6. **ACL invariant:** the compute path MUST call `canReadEmailContent` to filter input. **Document this in the handler — it's the load-bearing invariant.**

T1 (this branch) owns:
1. Empty-state scaffolding on the deal card and detail page (today)
2. The new `GET /api/deals/:id/conversations` ACL-aware endpoint (today, Phase 2)
3. A future read-side handler that consumes `deal_intelligence` once T3 has populated it (next wave, post-T3-ack)

---

## Open questions for T3

1. **Schema fields/types:** anything you'd structure differently?
2. **`risk_signal_examples` cap of 5:** sufficient for card-level + detail card, or move to a child table now to avoid future migration?
3. **`momentum_buckets`:** belongs in this table, or break out into a separate `deal_momentum` table (it's not strictly "intelligence")?
4. **Sentiment scale -1..+1:** or do you prefer 0..100 / 0..1 / categorical?
5. **Block-on-read vs. async-refresh:** how fast is the evaluator? If <500ms per (deal,user), block-on-read is cleaner UX. If >500ms, async with `needs_refresh` flag.
6. **Recompute scope on event invalidation:** mark stale for all users in the org (broad, simple), or only for users who participate in that conversation (narrow, matches ACL exactly)? Broad is simpler and probably correct since the conversation may shift sentiment for participants AND for owners who can read all.
7. **Sweeper interval:** if you go async-refresh, how often does the sweeper walk `is_stale=1` rows? 5min? 15min? Lucas's freshness policy is 1h-acceptable so 15min sweeps with high headroom is plenty.

---

## Non-goals

- This contract does NOT include the Wave 6 evaluator's prompt design. T3 owns that entirely.
- This contract does NOT specify the approval-queue flow for sentiment/topics/risk proposals. T3's evaluator may stage proposals before writing to `deal_intelligence`, or write directly — T3's call.
- This contract does NOT include any compute-side caching (vector cache, etc). T3's optimization choices.

---

## Versioning

This is contract **v0.1**. T3 ack with no changes → v1.0. Any T3 push-back gets discussed and a v0.2 lands here before either side builds against it.

-- deal_intelligence — per-(deal, user) computed-cached intelligence
-- (sentiment, topics, risk signals, momentum). Producer: T3's compute
-- pipeline (src/lib/deal-intelligence.ts, separate PR). Consumer: T1's
-- card DNA frontend (separate PR, contract tracked in issue #4).
--
-- ARCHITECTURAL DELINEATION (locked, do not retrofit):
-- This is computed-cached state, NOT corroboration-gated entity-field
-- state. Direct UPSERT on each recompute. Does NOT route through
-- Wave 6's evaluateProposal — different shape, different problem:
--   • entity_field_state holds durable per-field truth gated by
--     channel corroboration (3+ channels to overwrite, human-edit
--     locks, etc.).
--   • deal_intelligence holds opinion-derived-from-evolving-state.
--     Latest computed values REPLACE prior values entirely. No held
--     proposals, no corroboration counting, no human-edit lock.
--
-- PER-(deal_id, user_id) PRIMARY KEY (non-negotiable per ACL layered
-- redaction principle): different users have different
-- canReadEmailContent outcomes for the same deal's conversation set,
-- so sentiment/topics/risks derived from those bodies must be
-- per-user. A single global row would either leak to non-participants
-- or be wrong for owners.
--
-- FRESHNESS CONTRACT (set by Lucas on 2026-04-30):
--   • 1-hour staleness acceptable for sentiment/topics/risk/momentum
--   • Nightly batch recompute (added as sibling waitUntil to the
--     hourly cron — daily-cron is degraded territory)
--   • Event-driven invalidation when a new conversation lands tied
--     to a deal_contact: invalidated_at gets stamped, recompute fires
--     either lazily on next read OR via the next batch tick
--
-- Schema decisions reflecting v1.0 ack on issue #4:
--   • sentiment: categorical for fast UI consumption, sentiment_score
--     for finer-grained rendering (-1.0..+1.0 per locked spec)
--   • momentum: same categorical + score split
--   • topics + risk_signals stored as JSON TEXT (D1 has no JSONB).
--     Topics are deal-relevant nouns ("term sheet revision"), not
--     generic ("meeting"). Risk signals carry { type, severity,
--     detail } so the UI renders specific evidence.
--   • conversation_count exposes the "computed from N conversations"
--     UI tooltip without re-counting.
--   • computed_at + invalidated_at together drive the is_stale flag
--     the read endpoint surfaces (computed_at < now-1h OR
--     invalidated_at IS NOT NULL).

CREATE TABLE IF NOT EXISTS deal_intelligence (
  deal_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  sentiment         TEXT
    CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
  sentiment_score   REAL,
  topics            TEXT NOT NULL DEFAULT '[]',
  risk_signals      TEXT NOT NULL DEFAULT '[]',
  momentum          TEXT
    CHECK (momentum IS NULL OR momentum IN ('accelerating','steady','stalled','declining')),
  momentum_score    REAL,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  computed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invalidated_at    TEXT,
  PRIMARY KEY (deal_id, user_id),
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
);

-- Lookup pattern: hourly batch sweeps "stale-or-invalidated rows for
-- this user." The composite index serves both the WHERE on user_id +
-- WHERE invalidated_at IS NOT NULL filter and the ORDER BY computed_at
-- for oldest-first dispatch.
CREATE INDEX IF NOT EXISTS idx_di_user_invalidated
  ON deal_intelligence (user_id, invalidated_at);

-- Lookup pattern: nightly batch finds "rows whose computed_at < now-1h"
-- regardless of user. Standalone index on computed_at supports that
-- ORDER BY without a sort.
CREATE INDEX IF NOT EXISTS idx_di_computed_at
  ON deal_intelligence (computed_at);

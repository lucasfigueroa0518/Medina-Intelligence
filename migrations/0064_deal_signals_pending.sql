-- Deal-detection corroboration staging.
--
-- Pre-fix: every LLM-detected deal signal produced an approval_queue row.
-- 2026-04-30 audit measured 303/307 = 98.7% reject rate on create_deal —
-- single-email signals are dominantly noise. Confidence (avg 0.83) was not
-- predictive of approval likelihood.
--
-- Post-fix: a signal lands here first. It only graduates to approval_queue
-- once a SECOND distinct inbound conversation produces a deal signal for the
-- same company (corroboration). Single-source signals stay parked here and
-- never pollute the user's queue. When promotion happens, the queue row's
-- proposed_value carries an array of corroborating source ids + a count, so
-- the UI can later surface "N sources agree" without joining back here.
--
-- Lifecycle:
--   1. detectAndStageDealSignals INSERTs here (UNIQUE on company+source so
--      reclassification of the same email is a no-op).
--   2. If COUNT(DISTINCT source_communication_id) for company ≥ 2, OR a
--      pending approval_queue create_deal row already exists for the
--      company, all unpromoted rows for that company are merged + their
--      promoted_to_approval_id stamped.
--   3. Resolved (approved/rejected) approval_queue rows are NOT swept here —
--      promoted_to_approval_id stays as historical lineage. Future signals
--      arriving after resolution start corroboration from zero (the prior
--      promoted rows are excluded by the IS NULL filter).
--
-- Why a separate table rather than approval_queue with a 'staged' status:
-- adding to approval_queue.status's CHECK constraint would require a
-- table-rebuild migration in SQLite. A purpose-built staging table is
-- cheaper, isolates the corroboration concern, and Wave 6 may generalize
-- this pattern to other noisy sources (LinkedIn-unverified, etc.).

CREATE TABLE IF NOT EXISTS deal_signals_pending (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  source_communication_id TEXT NOT NULL,
  proposed_value TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_visibility TEXT NOT NULL DEFAULT 'org_wide',
  detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  promoted_to_approval_id TEXT,
  UNIQUE(org_id, company_id, source_communication_id)
);

CREATE INDEX IF NOT EXISTS idx_dsp_company_unpromoted
  ON deal_signals_pending(org_id, company_id, promoted_to_approval_id);

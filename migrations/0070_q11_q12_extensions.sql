-- Wave 6 — Q11 (deletion proposals) + Q12 (synthetic observations).
--
-- Both were deferred during Wave 6 build per locked decision: the
-- corroboration model needed to ship + verify with live evidence
-- before extending it. Both shipped + verified; this migration unlocks
-- the deferred work.
--
-- ── Q11 — Deletion proposals ────────────────────────────────────────
-- The corroboration model already handles "set field to value X."
-- It does NOT yet handle "set field to null/empty." Deletions are a
-- real proposal class — e.g., a job_title becomes outdated when the
-- contact changes roles, and an LLM extraction from a recent email
-- could legitimately propose "this field should be cleared because
-- the person no longer holds that role."
--
-- We extend entity_field_state with a single column,
-- pending_deletions, modeled symmetrically to pending_proposals:
-- a JSON array of CHANNELS that have proposed deletion. Same
-- corroboration math (3 distinct channels = QUEUE for review),
-- same human-edit lock, same permanent-lock semantics.
--
-- Rejected deletions reuse the existing rejected_values map with
-- the sentinel key '__DELETE__' — no new column needed; the 90-day
-- no-re-ask rule applies symmetrically. Zero new state surfaces.
--
-- ── Q12 — Synthetic observations ────────────────────────────────────
-- Observation-class proposals (personal_update, follow_up_commitment,
-- relationship_*) have a fundamentally different shape from field
-- overwrites:
--   • No existing canonical value to corroborate against
--   • 1-channel observation is valuable on first sighting (SHOW, not
--     HOLD per Wave 6 spec). Multi-channel STRENGTHENS metadata
--     (channels[] grows, last_observed_at advances), not gates surface.
--   • Lifecycle: discoverable until dismissed by a user OR ages out.
--
-- Per the locked design: SEPARATE table — entity_field_state's
-- current/pending split is meaningless for observations. A dedicated
-- table matches the actual semantics (timestamped append-with-merge
-- of observation events).
--
-- UNIQUE(org, entity_type, entity_id, observation_type,
-- observation_value) means the same observation from a second
-- channel UPDATEs in place — channels[] gets appended via JSON
-- merge, last_observed_at advances. Different observations of the
-- same type produce separate rows.

-- Q11 — pending_deletions on entity_field_state.
ALTER TABLE entity_field_state ADD COLUMN
  pending_deletions TEXT NOT NULL DEFAULT '[]';

-- Q12 — synthetic_observations table.
CREATE TABLE IF NOT EXISTS synthetic_observations (
  id                       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id                   TEXT NOT NULL,
  entity_type              TEXT NOT NULL CHECK(entity_type IN ('contact','company','deal')),
  entity_id                TEXT NOT NULL,
  observation_type         TEXT NOT NULL,
  observation_value        TEXT NOT NULL,
  channels                 TEXT NOT NULL DEFAULT '[]',
  confidence               REAL NOT NULL,
  evidence                 TEXT,
  source_communication_id  TEXT,
  first_observed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_observed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dismissed_at             TEXT,
  dismissed_by             TEXT,
  UNIQUE(org_id, entity_type, entity_id, observation_type, observation_value)
);

-- Per-entity lookup (detail page "Recent observations" section).
-- Partial index — dismissed observations don't surface.
CREATE INDEX IF NOT EXISTS idx_synth_entity_active
  ON synthetic_observations(entity_type, entity_id)
  WHERE dismissed_at IS NULL;

-- Org-wide recent-observations sweep (admin/audit). Partial index for
-- the same active-only filter.
CREATE INDEX IF NOT EXISTS idx_synth_org_recent
  ON synthetic_observations(org_id, last_observed_at)
  WHERE dismissed_at IS NULL;

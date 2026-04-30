-- Wave 6 — corroboration-based quality model.
--
-- entity_field_state holds the per-field state that the proposal evaluator
-- reads and writes on every proposed change. The entity tables (contacts,
-- companies, deals) remain the source of truth for the live value; this
-- table holds the metadata needed to decide "should the next proposal
-- apply, hold for corroboration, or surface for human review."
--
-- Architectural commitment: corroboration is the only quality signal.
-- A new value never wins on its own — it wins when N independent CHANNELS
-- (not API calls; see src/lib/source-channels.ts) agree on it. Current is
-- preserved by default; pending alternatives accumulate in pending_proposals
-- until they cross the corroboration threshold.
--
-- Columns:
--   current_value          — mirrors the entity table's live value
--   current_value_sources  — JSON array of distinct channels that have
--                            corroborated the current value (incl. the one
--                            that originally set it)
--   pending_proposals      — JSON object keyed by proposed value:
--                              { "555-1234": ["email_signature_inbox_alvaro",
--                                             "linkedin_data"],
--                                "555-9999": ["transcript_mention"] }
--                            Each list is the set of distinct channels that
--                            have proposed THAT value. Same channel proposing
--                            the same value twice is a no-op (set semantics).
--   rejected_values        — JSON object: { "<value>": "<rejected_at_iso>" }
--                            Used for the 90-day no-re-ask rule.
--   last_human_edit_at     — gates auto-overwrite. 0-180 days = blocked,
--                            ≥180 days = corroboration rule resumes. A human
--                            edit RESETS corroboration history: past channel
--                            agreement does not carry forward against a fresh
--                            human decision.
--   permanently_locked     — never automated-overwrite, ever.
--
-- Indexes:
--   idx_efs_entity   — fast lookup by (entity_type, entity_id) for "show
--                      all fields' state for this entity."
--   idx_efs_pending  — fast scan of fields with non-empty pending proposals
--                      (e.g. for the "Show held proposals" UI toggle).

CREATE TABLE IF NOT EXISTS entity_field_state (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company','deal')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  current_value TEXT,
  current_value_sources TEXT NOT NULL DEFAULT '[]',
  pending_proposals TEXT NOT NULL DEFAULT '{}',
  rejected_values TEXT NOT NULL DEFAULT '{}',
  last_human_edit_at TEXT,
  permanently_locked INTEGER NOT NULL DEFAULT 0 CHECK(permanently_locked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entity_type, entity_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_efs_entity
  ON entity_field_state(entity_type, entity_id);

-- Partial index — only fields with non-empty pending_proposals get an entry.
-- Lets the "show held proposals" path scan a tiny slice instead of the whole
-- table.
CREATE INDEX IF NOT EXISTS idx_efs_pending
  ON entity_field_state(field_name)
  WHERE pending_proposals != '{}';

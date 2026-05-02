-- Wave 1 — "deal = startup Medina is evaluating" semantics enforcement.
--
-- Distinguish internal Medina-side companies (the org's own fund entities,
-- LP families, parent capital vehicles) from external companies that
-- Medina is evaluating for investment. Deals on internal entities are
-- non-sensical (a deal is by definition an external opportunity) so the
-- validator rejects them at create + approval-commit time.
--
-- Bool column rather than tag because:
--   • predicate is closed (yes/no) and load-bearing for validation
--   • tags table is currently advisory metadata and not gated by a CHECK
--   • column lets us put a partial index on it
--
-- Default 0 (external) to match prior behavior. Backfill flips internal
-- rows to 1 — see migration 0074_internal_entity_backfill.sql.

ALTER TABLE companies ADD COLUMN is_internal_entity INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_companies_internal
  ON companies(org_id, is_internal_entity)
  WHERE is_internal_entity = 1;

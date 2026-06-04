-- Link finalized prospect signals directly to CRM companies for auditability
-- and company-card evidence display.
--
-- Production note: D1 records applied migration versions, so the ALTER below is
-- expected to execute once in production. The readiness checker applies this
-- migration through a column-aware harness so repeat-apply and partial-schema
-- recovery are still proven before rollout without dropping any rows.

ALTER TABLE prospect_signals ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prospect_signals_company
  ON prospect_signals(org_id, company_id, occurred_at DESC)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_company
  ON prospects(org_id, company_id)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_possible_company
  ON prospects(org_id, possible_company_id)
  WHERE possible_company_id IS NOT NULL AND company_id IS NULL;

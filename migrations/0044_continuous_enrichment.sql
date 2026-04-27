-- Migration 0044: Continuous enrichment infrastructure
--   1. entity_field_provenance: per-field "last edited by a human" tracking
--      so progressive enrichment never auto-overwrites a recently-curated field.
--   2. news_articles.facts_extracted_at: marker so the cron only LLM-extracts
--      structured facts from each article once.
--   3. companies: add last_funding_* columns + hq_location + employee_count.
--      The hq_location/employee_count columns were already referenced in
--      src/lib/progressive-enrichment.ts COMPANY_FIELDS but never existed in
--      the schema (latent bug — propose paths would have failed). Adding here.

CREATE TABLE IF NOT EXISTS entity_field_provenance (
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('company','contact','deal')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  last_human_edit_at TEXT,
  last_human_edit_user_id TEXT,
  PRIMARY KEY (org_id, entity_type, entity_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_efp_entity
  ON entity_field_provenance(org_id, entity_type, entity_id);

ALTER TABLE news_articles ADD COLUMN facts_extracted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_news_facts_pending
  ON news_articles(org_id, published_at DESC)
  WHERE facts_extracted_at IS NULL AND company_id IS NOT NULL;

ALTER TABLE companies ADD COLUMN last_funding_amount REAL;
ALTER TABLE companies ADD COLUMN last_funding_round TEXT;
ALTER TABLE companies ADD COLUMN last_funding_date TEXT;
ALTER TABLE companies ADD COLUMN hq_location TEXT;
ALTER TABLE companies ADD COLUMN employee_count INTEGER;

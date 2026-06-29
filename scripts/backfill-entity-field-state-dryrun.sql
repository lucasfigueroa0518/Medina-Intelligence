-- Wave 6 Phase A backfill — DRY RUN.
--
-- Projects what the executable backfill would insert without writing a row.
-- Output is one row per (entity_type, field_name) with the count of entities
-- that have a non-NULL value for that field. The executable counterpart
-- (scripts/backfill-entity-field-state.sql) inserts exactly those rows into
-- entity_field_state with current_value mirrored from the entity table and
-- current_value_sources='["historical_unknown"]'.
--
-- Run via:
--   wrangler d1 execute medina-ventures-db --remote \
--     --file=scripts/backfill-entity-field-state-dryrun.sql
--
-- Idempotency note: the executable backfill uses INSERT OR IGNORE keyed on
-- UNIQUE(entity_type, entity_id, field_name). The dry-run counts every
-- non-NULL field regardless of whether it already exists in
-- entity_field_state — so the "would-insert" count is an upper bound. After
-- one execute, a re-run dry-run will still show identical counts; only the
-- subsequent execute will be a no-op. This is fine for our purposes (the
-- numbers tell us field-by-field coverage, not net-new-rows).
--
-- Field selection mirrors progressive-enrichment.ts CONTACT_FIELDS and
-- COMPANY_FIELDS sets verbatim plus a hand-picked set for deals (deals have
-- no historical progressive-enrichment path; we cover the human-managed
-- core fields).

-- ── Contacts ──────────────────────────────────────────────────────────────
SELECT 'contact' AS entity_type, 'full_name' AS field_name, COUNT(*) AS would_insert
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND full_name IS NOT NULL AND full_name != ''
UNION ALL
SELECT 'contact', 'job_title', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND job_title IS NOT NULL AND job_title != ''
UNION ALL
SELECT 'contact', 'phone', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND phone IS NOT NULL AND phone != ''
UNION ALL
SELECT 'contact', 'email', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND email IS NOT NULL AND email != ''
UNION ALL
SELECT 'contact', 'linkedin_url', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND linkedin_url IS NOT NULL AND linkedin_url != ''
UNION ALL
SELECT 'contact', 'twitter_url', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND twitter_url IS NOT NULL AND twitter_url != ''
UNION ALL
SELECT 'contact', 'location', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND location IS NOT NULL AND location != ''
UNION ALL
SELECT 'contact', 'company_id', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND company_id IS NOT NULL AND company_id != ''
UNION ALL
SELECT 'contact', 'bio_summary', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND bio_summary IS NOT NULL AND bio_summary != ''
UNION ALL
SELECT 'contact', 'investment_focus', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND investment_focus IS NOT NULL AND investment_focus != ''
UNION ALL
SELECT 'contact', 'check_size_range', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND check_size_range IS NOT NULL AND check_size_range != ''
UNION ALL
SELECT 'contact', 'introduced_via', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND introduced_via IS NOT NULL AND introduced_via != ''
UNION ALL
SELECT 'contact', 'topics_of_interest', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND topics_of_interest IS NOT NULL AND topics_of_interest != ''
UNION ALL
SELECT 'contact', 'pain_points', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND pain_points IS NOT NULL AND pain_points != ''
UNION ALL
SELECT 'contact', 'investment_thesis_tags', COUNT(*)
  FROM contacts WHERE org_id='medina-ventures' AND deleted_at IS NULL AND investment_thesis_tags IS NOT NULL AND investment_thesis_tags != ''
-- ── Companies ─────────────────────────────────────────────────────────────
UNION ALL
SELECT 'company', 'name', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND name IS NOT NULL AND name != ''
UNION ALL
SELECT 'company', 'sector', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND sector IS NOT NULL AND sector != ''
UNION ALL
SELECT 'company', 'website', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND website IS NOT NULL AND website != ''
UNION ALL
SELECT 'company', 'domain', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND domain IS NOT NULL AND domain != ''
UNION ALL
SELECT 'company', 'description', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND description IS NOT NULL AND description != ''
UNION ALL
SELECT 'company', 'location_mentioned', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND location_mentioned IS NOT NULL AND location_mentioned != ''
UNION ALL
SELECT 'company', 'employee_count', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND employee_count IS NOT NULL
UNION ALL
SELECT 'company', 'investment_status', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND investment_status IS NOT NULL AND investment_status != ''
UNION ALL
SELECT 'company', 'stage', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND stage IS NOT NULL AND stage != ''
UNION ALL
SELECT 'company', 'last_known_valuation', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND last_known_valuation IS NOT NULL
UNION ALL
SELECT 'company', 'linkedin_url', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND linkedin_url IS NOT NULL AND linkedin_url != ''
UNION ALL
SELECT 'company', 'last_funding_amount', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND last_funding_amount IS NOT NULL
UNION ALL
SELECT 'company', 'last_funding_round', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND last_funding_round IS NOT NULL AND last_funding_round != ''
UNION ALL
SELECT 'company', 'last_funding_date', COUNT(*)
  FROM companies WHERE org_id='medina-ventures' AND deleted_at IS NULL AND last_funding_date IS NOT NULL
-- ── Deals ─────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'deal', 'title', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND title IS NOT NULL AND title != ''
UNION ALL
SELECT 'deal', 'stage', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND stage IS NOT NULL AND stage != ''
UNION ALL
SELECT 'deal', 'amount', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND amount IS NOT NULL
UNION ALL
SELECT 'deal', 'valuation', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND valuation IS NOT NULL
UNION ALL
SELECT 'deal', 'expected_close', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND expected_close IS NOT NULL
UNION ALL
SELECT 'deal', 'lead_source', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND lead_source IS NOT NULL AND lead_source != ''
UNION ALL
SELECT 'deal', 'owner_id', COUNT(*)
  FROM deals WHERE org_id='medina-ventures' AND deleted_at IS NULL AND owner_id IS NOT NULL AND owner_id != ''
ORDER BY entity_type, field_name;

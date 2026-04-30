-- Wave 6 Phase A backfill — EXECUTE.
--
-- One row per (entity, field) into entity_field_state for every non-NULL
-- value in contacts/companies/deals. Mirrors the dry-run's field selection.
--
-- Idempotent: INSERT OR IGNORE on UNIQUE(entity_type, entity_id, field_name).
-- Re-running this is safe (and a no-op once the first run completes).
--
-- Defaults applied:
--   current_value          → entity table value (NULLs are filtered out)
--   current_value_sources  → '["historical_unknown"]'
--   pending_proposals      → '{}'
--   rejected_values        → '{}'
--   last_human_edit_at     → entity_field_provenance.last_human_edit_at
--                            (NULL if no human edit on record — most fields)
--   permanently_locked     → 0
--
-- Run AFTER applying migration 0066:
--   wrangler d1 execute medina-ventures-db --remote \
--     --file=scripts/backfill-entity-field-state.sql
--
-- Numeric columns (employee_count, current_valuation, amount, valuation,
-- expected_close, last_funding_amount, last_funding_date) are cast to TEXT
-- when written to current_value. The proposal evaluator reads current_value
-- as text and compares against the proposed text — no numeric path needed.

-- ── Contacts ──────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'full_name', c.full_name, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='full_name')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.full_name IS NOT NULL AND c.full_name != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'job_title', c.job_title, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='job_title')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.job_title IS NOT NULL AND c.job_title != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'phone', c.phone, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='phone')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.phone IS NOT NULL AND c.phone != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'email', c.email, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='email')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.email IS NOT NULL AND c.email != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'linkedin_url', c.linkedin_url, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='linkedin_url')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.linkedin_url IS NOT NULL AND c.linkedin_url != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'twitter_url', c.twitter_url, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='twitter_url')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.twitter_url IS NOT NULL AND c.twitter_url != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'location', c.location, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='location')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.location IS NOT NULL AND c.location != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'company_id', c.company_id, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='company_id')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.company_id IS NOT NULL AND c.company_id != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'bio_summary', c.bio_summary, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='bio_summary')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.bio_summary IS NOT NULL AND c.bio_summary != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'investment_focus', c.investment_focus, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='investment_focus')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.investment_focus IS NOT NULL AND c.investment_focus != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'check_size_range', c.check_size_range, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='check_size_range')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.check_size_range IS NOT NULL AND c.check_size_range != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'introduced_via', c.introduced_via, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='introduced_via')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.introduced_via IS NOT NULL AND c.introduced_via != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'topics_of_interest', c.topics_of_interest, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='topics_of_interest')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.topics_of_interest IS NOT NULL AND c.topics_of_interest != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'pain_points', c.pain_points, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='pain_points')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.pain_points IS NOT NULL AND c.pain_points != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'contact', c.id, 'investment_thesis_tags', c.investment_thesis_tags, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='contact' AND p.entity_id=c.id AND p.field_name='investment_thesis_tags')
  FROM contacts c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.investment_thesis_tags IS NOT NULL AND c.investment_thesis_tags != '';

-- ── Companies ─────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'name', c.name, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='name')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.name IS NOT NULL AND c.name != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'sector', c.sector, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='sector')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.sector IS NOT NULL AND c.sector != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'website', c.website, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='website')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.website IS NOT NULL AND c.website != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'domain', c.domain, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='domain')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.domain IS NOT NULL AND c.domain != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'description', c.description, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='description')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.description IS NOT NULL AND c.description != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'hq_location', c.hq_location, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='hq_location')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.hq_location IS NOT NULL AND c.hq_location != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'employee_count', CAST(c.employee_count AS TEXT), '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='employee_count')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.employee_count IS NOT NULL;

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'investment_status', c.investment_status, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='investment_status')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.investment_status IS NOT NULL AND c.investment_status != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'stage', c.stage, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='stage')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.stage IS NOT NULL AND c.stage != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'current_valuation', CAST(c.current_valuation AS TEXT), '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='current_valuation')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.current_valuation IS NOT NULL;

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'linkedin_url', c.linkedin_url, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='linkedin_url')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.linkedin_url IS NOT NULL AND c.linkedin_url != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'last_funding_amount', CAST(c.last_funding_amount AS TEXT), '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='last_funding_amount')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.last_funding_amount IS NOT NULL;

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'last_funding_round', c.last_funding_round, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='last_funding_round')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.last_funding_round IS NOT NULL AND c.last_funding_round != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'company', c.id, 'last_funding_date', c.last_funding_date, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=c.org_id AND p.entity_type='company' AND p.entity_id=c.id AND p.field_name='last_funding_date')
  FROM companies c WHERE c.org_id='medina-ventures' AND c.deleted_at IS NULL AND c.last_funding_date IS NOT NULL;

-- ── Deals ─────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'title', d.title, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='title')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.title IS NOT NULL AND d.title != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'stage', d.stage, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='stage')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.stage IS NOT NULL AND d.stage != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'amount', CAST(d.amount AS TEXT), '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='amount')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.amount IS NOT NULL;

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'valuation', CAST(d.valuation AS TEXT), '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='valuation')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.valuation IS NOT NULL;

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'expected_close', d.expected_close, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='expected_close')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.expected_close IS NOT NULL AND d.expected_close != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'lead_source', d.lead_source, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='lead_source')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.lead_source IS NOT NULL AND d.lead_source != '';

INSERT OR IGNORE INTO entity_field_state (entity_type, entity_id, field_name, current_value, current_value_sources, last_human_edit_at)
SELECT 'deal', d.id, 'owner_id', d.owner_id, '["historical_unknown"]',
       (SELECT last_human_edit_at FROM entity_field_provenance p WHERE p.org_id=d.org_id AND p.entity_type='deal' AND p.entity_id=d.id AND p.field_name='owner_id')
  FROM deals d WHERE d.org_id='medina-ventures' AND d.deleted_at IS NULL AND d.owner_id IS NOT NULL AND d.owner_id != '';

-- Prevent race-condition duplicate companies for the same domain within an org.
-- Partial index: only active rows with a non-NULL domain are constrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_domain_org_unique
  ON companies(domain, org_id)
  WHERE deleted_at IS NULL AND domain IS NOT NULL;

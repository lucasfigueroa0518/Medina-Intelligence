-- Reconcile Medina's current portfolio with forgiving name matching.
-- 0103 seeded exact normalized names; this catches aliases like "Hedgehog AI"
-- or "Neural Seek" so MARTy does not miss foundational portfolio companies.

INSERT OR IGNORE INTO firm_company_relationships (
  id,
  org_id,
  company_id,
  relationship_state,
  source,
  confidence,
  effective_date,
  notes
)
SELECT
  lower(hex(randomblob(16))),
  org_id,
  id,
  'current_portfolio',
  'foundational_alias_reconciliation',
  1.0,
  '2026-05-17',
  'Alias reconciliation for Medina current portfolio: Tier 4 AI, QNECT/Qunnect, Hedgehog, NeuralSeek.'
FROM companies
WHERE deleted_at IS NULL
  AND COALESCE(is_internal_entity, 0) = 0
  AND (
    lower(name) LIKE '%tier%4%ai%'
    OR lower(name) LIKE '%tier%four%ai%'
    OR lower(name) LIKE '%qnect%'
    OR lower(name) LIKE '%qunnect%'
    OR lower(name) LIKE '%hedgehog%'
    OR lower(name) LIKE '%neural%seek%'
  );

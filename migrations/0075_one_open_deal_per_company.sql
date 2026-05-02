-- Wave 2 — one-open-deal-per-company constraint.
--
-- A startup at any moment is in at most one active investment evaluation
-- with this fund. Sequential deals (closed_won → new round years later)
-- are allowed, since the closed deal exits the partial-index predicate.
-- Ditto closed_lost (we can revisit a passed startup later).
--
-- Wave 2A audit verified zero current violations after Wave 1's
-- soft-delete sweep. Migration is preventative.
--
-- The application-side validator in src/handlers/deals.ts createDeal
-- + src/handlers/approval.ts commitCreateDealApproval delivers a
-- structured 400 ('OPEN_DEAL_ALREADY_EXISTS') before reaching this
-- index, since the index's UNIQUE-constraint-violation message is
-- opaque to API callers.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_deals_open_per_company
  ON deals(org_id, company_id)
  WHERE deleted_at IS NULL
    AND stage NOT IN ('closed_won','closed_lost');

-- Ensure each live deal-backed prospect has a single canonical backlink.
--
-- This supports one-time materialization of existing known deals into the
-- prospect layer while preserving the deals table as the source of truth.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_prospects_org_deal_active
  ON prospects(org_id, deal_id)
  WHERE deleted_at IS NULL AND deal_id IS NOT NULL;

-- Premium deck QA lifecycle.
--
-- Deck jobs now distinguish visual QA blocking from infrastructure failure and
-- track bounded repair attempts before polished artifacts become user-visible.

ALTER TABLE deck_artifact_jobs ADD COLUMN revision_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deck_artifact_jobs ADD COLUMN max_revision_rounds INTEGER NOT NULL DEFAULT 3;
ALTER TABLE deck_artifact_jobs ADD COLUMN blocked_reason TEXT;
ALTER TABLE deck_artifact_jobs ADD COLUMN user_visible_document_ids_json TEXT;

CREATE INDEX IF NOT EXISTS idx_deck_artifact_jobs_revision
  ON deck_artifact_jobs (org_id, status, revision_round);

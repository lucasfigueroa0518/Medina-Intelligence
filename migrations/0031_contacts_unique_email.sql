-- Enforce one active contact per (org_id, email). Partial index so NULL emails
-- and soft-deleted rows do not collide.
-- Prereq: run the spam + duplicate cleanup (README in cleanup script) BEFORE applying,
-- otherwise this migration will fail on existing duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_email_unique
  ON contacts(org_id, LOWER(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;

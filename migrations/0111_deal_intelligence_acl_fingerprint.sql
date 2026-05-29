-- ACL fingerprint for deal_intelligence.
-- Prevents cached email-derived summaries from being served after a user's
-- readable source set changes, especially when share_emails_org_wide tightens.

ALTER TABLE deal_intelligence ADD COLUMN acl_fingerprint TEXT;
ALTER TABLE deal_intelligence ADD COLUMN acl_computed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_di_acl_fingerprint
  ON deal_intelligence(user_id, acl_fingerprint);

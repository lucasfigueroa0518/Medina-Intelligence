CREATE TABLE email_campaign_recipients (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id) ON DELETE RESTRICT,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sent','failed')),
  sent_at TEXT,
  error_message TEXT,
  UNIQUE(campaign_id, contact_id)
);
CREATE INDEX idx_ecr_campaign ON email_campaign_recipients(campaign_id);
CREATE INDEX idx_ecr_contact ON email_campaign_recipients(contact_id);

CREATE TABLE email_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_template TEXT NOT NULL,
  filter_criteria TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','scheduled','sending','sent','failed','cancelled')),
  scheduled_at TEXT,
  sent_at TEXT,
  total_recipients INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_campaigns_org ON email_campaigns(org_id);
CREATE INDEX idx_campaigns_status ON email_campaigns(status);

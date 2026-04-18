CREATE TABLE conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('outlook','slack','manual')),
  external_thread_id TEXT,
  external_message_id TEXT UNIQUE,
  subject TEXT,
  body_r2_key TEXT NOT NULL,
  body_preview TEXT,
  direction TEXT CHECK(direction IN ('inbound','outbound','internal')),
  sent_at TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  to_emails TEXT NOT NULL,
  cc_emails TEXT DEFAULT '[]',
  sentiment TEXT CHECK(sentiment IN ('positive','neutral','negative','urgent')),
  topics TEXT,
  action_items TEXT,
  participant_user_ids TEXT NOT NULL DEFAULT '[]',
  is_campaign_email INTEGER NOT NULL DEFAULT 0,
  vector_id TEXT,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_conversations_org_id ON conversations(org_id);
CREATE INDEX idx_conversations_sent_at ON conversations(sent_at);
CREATE INDEX idx_conversations_external_message_id ON conversations(external_message_id);
CREATE INDEX idx_conversations_from_contact ON conversations(from_contact_id);

-- Phase 1: Deals pipeline expansion — new columns + junction tables

ALTER TABLE deals ADD COLUMN valuation REAL;
ALTER TABLE deals ADD COLUMN our_allocation REAL;
ALTER TABLE deals ADD COLUMN instrument_type TEXT CHECK(instrument_type IN ('safe','convertible_note','equity','debt','other'));
ALTER TABLE deals ADD COLUMN actual_close_date TEXT;
ALTER TABLE deals ADD COLUMN lead_source TEXT;
ALTER TABLE deals ADD COLUMN thesis_fit TEXT;
ALTER TABLE deals ADD COLUMN deal_memo_r2_key TEXT;
ALTER TABLE deals ADD COLUMN last_activity_date TEXT;
ALTER TABLE deals ADD COLUMN stage_changed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
ALTER TABLE deals ADD COLUMN days_in_stage INTEGER DEFAULT 0;

CREATE TABLE deal_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  deal_id TEXT NOT NULL REFERENCES deals(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  role TEXT CHECK(role IN ('founder','ceo','cfo','cto','legal','deal_lead','analyst','co_investor','board_member','advisor','champion','blocker','other')),
  side TEXT CHECK(side IN ('theirs','ours','other')),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(deal_id, contact_id)
);
CREATE INDEX idx_dc_deal ON deal_contacts(deal_id);
CREATE INDEX idx_dc_contact ON deal_contacts(contact_id);

CREATE TABLE deal_action_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  deal_id TEXT NOT NULL REFERENCES deals(id),
  description TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','cancelled')),
  source TEXT DEFAULT 'manual' CHECK(source IN ('manual','ai_extracted','meeting','email')),
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_dai_deal ON deal_action_items(deal_id);
CREATE INDEX idx_dai_status ON deal_action_items(status);

CREATE TABLE deal_notes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  deal_id TEXT NOT NULL REFERENCES deals(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_dn_deal ON deal_notes(deal_id);

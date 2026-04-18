CREATE TABLE deals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'prospect'
    CHECK(stage IN ('prospect','first_contact','meeting_scheduled','due_diligence','term_sheet','closing','closed_won','closed_lost')),
  amount REAL,
  currency TEXT DEFAULT 'USD',
  probability REAL DEFAULT 0.0,
  expected_close TEXT,
  notes TEXT,
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_deals_org_id ON deals(org_id);
CREATE INDEX idx_deals_company_id ON deals(company_id);
CREATE INDEX idx_deals_stage ON deals(stage);

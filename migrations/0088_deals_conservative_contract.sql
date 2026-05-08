-- Conservative deals contract.
--
-- Pipeline stages are now exactly:
--   new, talking, due_diligence, term_sheet, closed
--
-- AI suggestions are not approval_queue rows anymore. They are only promoted
-- into deals.stage='new' after the evidence ledger has at least four strong,
-- company-tied evidence records across more than one source family.

PRAGMA foreign_keys = OFF;

DROP VIEW IF EXISTS active_deals;

CREATE TABLE deals_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'talking'
    CHECK(stage IN ('new','talking','due_diligence','term_sheet','closed')),
  amount REAL,
  currency TEXT DEFAULT 'USD',
  probability REAL DEFAULT 0.0,
  expected_close TEXT,
  notes TEXT,
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  valuation REAL,
  our_allocation REAL,
  instrument_type TEXT CHECK(instrument_type IN ('safe','convertible_note','equity','debt','other')),
  actual_close_date TEXT,
  lead_source TEXT,
  thesis_fit TEXT,
  deal_memo_r2_key TEXT,
  last_activity_date TEXT,
  stage_changed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  days_in_stage INTEGER DEFAULT 0,
  source_metadata TEXT DEFAULT '{}',
  funding_stage TEXT,
  evidence_first_seen_at TEXT,
  evidence_last_seen_at TEXT,
  suggestion_evidence_count INTEGER DEFAULT 0,
  suggestion_decided_at TEXT,
  suggestion_decided_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO deals_new (
  id, org_id, company_id, owner_id, title, stage, amount, currency,
  probability, expected_close, notes, custom_fields, created_at, updated_at,
  deleted_at, valuation, our_allocation, instrument_type, actual_close_date,
  lead_source, thesis_fit, deal_memo_r2_key, last_activity_date,
  stage_changed_at, days_in_stage, source_metadata
)
SELECT
  id,
  org_id,
  company_id,
  owner_id,
  title,
  CASE
    WHEN stage IN ('closed_won','closed_lost') THEN 'closed'
    WHEN stage = 'due_diligence' THEN 'due_diligence'
    WHEN stage IN ('term_sheet','closing') THEN 'term_sheet'
    ELSE 'talking'
  END AS stage,
  amount,
  currency,
  probability,
  expected_close,
  notes,
  custom_fields,
  created_at,
  updated_at,
  deleted_at,
  valuation,
  our_allocation,
  instrument_type,
  actual_close_date,
  lead_source,
  thesis_fit,
  deal_memo_r2_key,
  last_activity_date,
  stage_changed_at,
  days_in_stage,
  COALESCE(source_metadata, '{}')
FROM deals;

DROP TABLE deals;
ALTER TABLE deals_new RENAME TO deals;

CREATE INDEX idx_deals_org_id ON deals(org_id);
CREATE INDEX idx_deals_company_id ON deals(company_id);
CREATE INDEX idx_deals_stage ON deals(stage);

CREATE UNIQUE INDEX uniq_deals_open_per_company
  ON deals(org_id, company_id)
  WHERE deleted_at IS NULL
    AND stage != 'closed';

CREATE VIEW active_deals AS SELECT * FROM deals WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS deal_suggestion_evidence (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,

  source_type TEXT NOT NULL CHECK(source_type IN ('conversation','event','document')),
  source_id TEXT NOT NULL,
  source_title TEXT,
  source_excerpt TEXT,
  source_date TEXT,

  signal_kind TEXT,
  funding_stage TEXT,
  amount_usd REAL,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_note TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  promoted_at TEXT,

  UNIQUE(org_id, company_id, source_type, source_id)
);

CREATE INDEX idx_dse_company ON deal_suggestion_evidence(org_id, company_id, created_at);
CREATE INDEX idx_dse_deal ON deal_suggestion_evidence(deal_id);
CREATE INDEX idx_dse_source ON deal_suggestion_evidence(source_type, source_id);

PRAGMA foreign_keys = ON;

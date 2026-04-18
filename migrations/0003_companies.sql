CREATE TABLE companies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  website TEXT,
  logo_url TEXT,
  description TEXT,
  company_type TEXT NOT NULL DEFAULT 'startup'
    CHECK(company_type IN ('startup','vc_firm','family_office','portfolio','lp','other')),
  sector TEXT,
  stage TEXT CHECK(stage IN ('pre_seed','seed','series_a','series_b','series_c','growth','public','acquired','other')),
  investment_status TEXT DEFAULT 'tracking'
    CHECK(investment_status IN ('tracking','prospect','due_diligence','term_sheet','invested','passed','exited')),
  investment_amount REAL,
  investment_date TEXT,
  ownership_pct REAL,
  current_valuation REAL,
  currency TEXT DEFAULT 'USD',
  pitchbook_id TEXT,
  pitchbook_data_r2_key TEXT,
  linkedin_url TEXT,
  linkedin_data_r2_key TEXT,
  web_enrichment_r2_key TEXT,
  enrichment_confidence REAL DEFAULT 0.0,
  enrichment_last_run TEXT,
  news_relevance_score REAL DEFAULT 0.0,
  news_score_updated_at TEXT,
  last_news_summary TEXT,
  custom_fields TEXT DEFAULT '{}',
  vector_id TEXT,
  r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_companies_org_id ON companies(org_id);
CREATE INDEX idx_companies_investment_status ON companies(investment_status);
CREATE INDEX idx_companies_stage ON companies(stage);
CREATE INDEX idx_companies_pitchbook_id ON companies(pitchbook_id);
CREATE INDEX idx_companies_enrichment_last_run ON companies(enrichment_last_run);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  avatar_url TEXT,
  linkedin_url TEXT,
  twitter_url TEXT,
  contact_type TEXT NOT NULL DEFAULT 'individual'
    CHECK(contact_type IN ('individual','family','institutional_investor','company','other')),
  relationship_status TEXT
    CHECK(relationship_status IN ('lp','portfolio_founder','prospect','advisor','vendor','other')),
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  job_title TEXT,
  merged_into TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  pitchbook_id TEXT,
  linkedin_data_r2_key TEXT,
  pitchbook_data_r2_key TEXT,
  web_enrichment_r2_key TEXT,
  enrichment_confidence REAL DEFAULT 0.0,
  enrichment_last_run TEXT,
  topics_of_interest TEXT,
  pain_points TEXT,
  investment_thesis_tags TEXT,
  bio_summary TEXT,
  news_relevance_score REAL DEFAULT 0.0,
  news_score_updated_at TEXT,
  last_contact_date TEXT,
  total_interactions INTEGER DEFAULT 0,
  meetings_last_30d INTEGER DEFAULT 0,
  email_frequency_score REAL DEFAULT 0.0,
  next_followup_date TEXT,
  next_followup_note TEXT,
  investment_amount REAL,
  fund_commitment REAL,
  investment_currency TEXT DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK(source IN ('outlook','slack','firefly','linkedin','manual','four_degree','import')),
  source_confidence REAL DEFAULT 1.0,
  custom_fields TEXT DEFAULT '{}',
  vector_id TEXT,
  r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_contacts_org_id ON contacts(org_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_company_id ON contacts(company_id);
CREATE INDEX idx_contacts_contact_type ON contacts(contact_type);
CREATE INDEX idx_contacts_last_contact_date ON contacts(last_contact_date);
CREATE INDEX idx_contacts_deleted_at ON contacts(deleted_at);
CREATE INDEX idx_contacts_enrichment_last_run ON contacts(enrichment_last_run);
CREATE INDEX idx_contacts_merged_into ON contacts(merged_into);

-- Universal ingestion treatment receipts.
--
-- Every durable source row that enters the platform should either be routed
-- through each applicable treatment lane or carry an explicit skipped/error
-- reason. This table is the per-source audit surface for that invariant.

CREATE TABLE IF NOT EXISTS ingestion_treatment_receipts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL
    CHECK (source_table IN ('conversations','events','documents','news_articles')),
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'unknown',
  ingestion_mode TEXT NOT NULL DEFAULT 'live'
    CHECK (ingestion_mode IN ('live','backfill','repair')),
  origin TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','partial','failed','skipped')),
  crm_status TEXT NOT NULL DEFAULT 'pending',
  contact_enrichment_status TEXT NOT NULL DEFAULT 'pending',
  company_enrichment_status TEXT NOT NULL DEFAULT 'pending',
  embedding_status TEXT NOT NULL DEFAULT 'pending',
  rag_status TEXT NOT NULL DEFAULT 'pending',
  prospect_status TEXT NOT NULL DEFAULT 'pending',
  deal_status TEXT NOT NULL DEFAULT 'pending',
  contacts_touched INTEGER NOT NULL DEFAULT 0,
  companies_touched INTEGER NOT NULL DEFAULT 0,
  work_enqueued INTEGER NOT NULL DEFAULT 0,
  skipped_reasons TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  last_attempted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_treatment_org_status
  ON ingestion_treatment_receipts(org_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_treatment_source
  ON ingestion_treatment_receipts(org_id, source_table, source_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_treatment_origin
  ON ingestion_treatment_receipts(org_id, origin, updated_at DESC);

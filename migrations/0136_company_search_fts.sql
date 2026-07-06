-- 0136_company_search_fts.sql
--
-- Fast CRM company search. Mirrors 0108_contact_search_fts /
-- 0110_contact_search_state_conversation_fts, but for companies. The companies
-- list/search handler used a wide `name/domain/description LIKE %term%` scan;
-- this dedicated FTS5 index replaces that with a prefix-matched MATCH query,
-- with a graceful fallback to LIKE when the index is empty or errors (e.g. a
-- local DB that hasn't run this migration).

CREATE VIRTUAL TABLE IF NOT EXISTS company_search_fts USING fts5(
  name,
  domain,
  website,
  sector,
  location_mentioned,
  description,
  tags,
  custom_fields,
  exact_terms,
  company_id UNINDEXED,
  org_id UNINDEXED,
  updated_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Indexed sidecar for health checks / drift detection, matching the contact
-- search index_state shape.
CREATE TABLE IF NOT EXISTS company_search_index_state (
  org_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  company_updated_at TEXT,
  indexed_at TEXT,
  status TEXT NOT NULL DEFAULT 'indexed'
    CHECK (status IN ('indexed','stale','failed','deleted')),
  last_error TEXT,
  repair_attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_company_search_state_org_status
  ON company_search_index_state(org_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_company_search_state_org_indexed
  ON company_search_index_state(org_id, indexed_at);

CREATE TABLE IF NOT EXISTS company_search_index_repairs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, company_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_company_search_repairs_org_status
  ON company_search_index_repairs(org_id, status, updated_at);

-- Initial backfill from active companies.
INSERT INTO company_search_fts (
  company_id,
  org_id,
  name,
  domain,
  website,
  sector,
  location_mentioned,
  description,
  tags,
  custom_fields,
  exact_terms,
  updated_at
)
SELECT
  co.id,
  co.org_id,
  COALESCE(co.name, ''),
  COALESCE(co.domain, ''),
  COALESCE(co.website, ''),
  COALESCE(co.sector, ''),
  COALESCE(co.location_mentioned, ''),
  COALESCE(co.description, ''),
  COALESCE((
    SELECT group_concat(t.name, ' ')
      FROM company_tags ct
      JOIN tags t ON t.id = ct.tag_id
     WHERE ct.company_id = co.id
  ), ''),
  COALESCE(co.custom_fields, ''),
  -- exact_terms mirrors rebuildCompanySearchIndexForCompany: name + domain +
  -- website + sector + tags, lowercased. (The FTS5 unicode61 tokenizer already
  -- splits on punctuation, matching the runtime's normalization for search.)
  lower(
    COALESCE(co.name, '') || ' ' ||
    COALESCE(co.domain, '') || ' ' ||
    COALESCE(co.website, '') || ' ' ||
    COALESCE(co.sector, '') || ' ' ||
    COALESCE((
      SELECT group_concat(t.name, ' ')
        FROM company_tags ct
        JOIN tags t ON t.id = ct.tag_id
       WHERE ct.company_id = co.id
    ), '')
  ),
  COALESCE(co.updated_at, co.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
FROM companies co
WHERE co.deleted_at IS NULL
  AND co.merged_into IS NULL;

INSERT OR REPLACE INTO company_search_index_state
  (org_id, company_id, company_updated_at, indexed_at, status, updated_at)
SELECT
  org_id,
  company_id,
  updated_at,
  COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  'indexed',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM company_search_fts
WHERE org_id IS NOT NULL
  AND org_id != ''
  AND company_id IS NOT NULL
  AND company_id != '';

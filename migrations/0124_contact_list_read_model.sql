-- 0124_contact_list_read_model.sql
-- Fast contacts-list read model. The list page should read precomputed contact
-- rows instead of rebuilding company names, tags, active-deal flags, and
-- activity rollups on every request.

CREATE TABLE IF NOT EXISTS contact_list_entries (
  org_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  company_id TEXT,
  company_name TEXT,
  contact_type TEXT NOT NULL,
  engagement_status TEXT,
  relationship_status TEXT,
  job_title TEXT,
  next_followup_date TEXT,
  meetings_last_30d INTEGER NOT NULL DEFAULT 0,
  last_contact_date TEXT,
  total_interactions INTEGER NOT NULL DEFAULT 0,
  active_deal_count INTEGER NOT NULL DEFAULT 0,
  in_active_deals INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  contact_created_at TEXT NOT NULL,
  contact_updated_at TEXT NOT NULL,
  rebuilt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_last_contact
  ON contact_list_entries(org_id, last_contact_date DESC, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_name
  ON contact_list_entries(org_id, full_name COLLATE NOCASE, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_company
  ON contact_list_entries(org_id, company_name COLLATE NOCASE, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_company_id
  ON contact_list_entries(org_id, company_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_type
  ON contact_list_entries(org_id, contact_type, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_status
  ON contact_list_entries(org_id, engagement_status, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_interactions
  ON contact_list_entries(org_id, total_interactions DESC, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_active_deals
  ON contact_list_entries(org_id, in_active_deals, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_followup
  ON contact_list_entries(org_id, next_followup_date, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_list_org_updated
  ON contact_list_entries(org_id, contact_updated_at);

CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_contact
  ON contact_tags(tag_id, contact_id);

-- Backfill is intentionally not performed inside this migration. The contact
-- list row projection uses several correlated lookups; running it for every
-- contact in one D1 migration can exceed the per-request CPU limit on large
-- tenants. Use POST /api/admin/rebuild-contact-list-read-model or the daily
-- drift repair path to fill bounded batches after the schema is live.

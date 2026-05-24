-- Fast CRM contact search.
--
-- Dedicated FTS5 index for contact + company lookup. The contacts list and
-- MARTy contact tool use this instead of wide LIKE scans with correlated
-- company/deal/domain subqueries.

CREATE VIRTUAL TABLE IF NOT EXISTS contact_search_fts USING fts5(
  full_name,
  email,
  email_local,
  phone,
  linkedin_url,
  job_title,
  company_name,
  company_domain,
  tags,
  bio_summary,
  custom_fields,
  exact_terms,
  contact_id UNINDEXED,
  org_id UNINDEXED,
  company_id UNINDEXED,
  updated_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS contact_search_index_repairs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  contact_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, contact_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_contact_search_repairs_org_status
  ON contact_search_index_repairs(org_id, status, updated_at);

INSERT INTO contact_search_fts (
  contact_id,
  org_id,
  company_id,
  full_name,
  email,
  email_local,
  phone,
  linkedin_url,
  job_title,
  company_name,
  company_domain,
  tags,
  bio_summary,
  custom_fields,
  exact_terms,
  updated_at
)
SELECT
  c.id,
  c.org_id,
  COALESCE(co.id, ico.id),
  COALESCE(c.full_name, ''),
  COALESCE(c.email, ''),
  CASE
    WHEN c.email IS NOT NULL AND instr(c.email, '@') > 1
      THEN substr(c.email, 1, instr(c.email, '@') - 1)
    ELSE COALESCE(c.email, '')
  END,
  COALESCE(c.phone, ''),
  COALESCE(c.linkedin_url, ''),
  COALESCE(c.job_title, ''),
  COALESCE(co.name, ico.name, ''),
  COALESCE(co.domain, ico.domain, ''),
  COALESCE((
    SELECT group_concat(t.name, ' ')
      FROM contact_tags ct
      JOIN tags t ON t.id = ct.tag_id
     WHERE ct.contact_id = c.id
  ), ''),
  COALESCE(c.bio_summary, ''),
  COALESCE(c.custom_fields, ''),
  lower(
    COALESCE(c.full_name, '') || ' ' ||
    COALESCE(c.email, '') || ' ' ||
    COALESCE(co.name, ico.name, '') || ' ' ||
    COALESCE(co.domain, ico.domain, '')
  ),
  COALESCE(c.updated_at, c.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
FROM contacts c
LEFT JOIN companies co
  ON co.id = c.company_id
 AND co.org_id = c.org_id
 AND co.deleted_at IS NULL
 AND co.merged_into IS NULL
LEFT JOIN companies ico
  ON ico.id = (
    SELECT sco.id
      FROM companies sco
     WHERE sco.org_id = c.org_id
       AND sco.deleted_at IS NULL
       AND sco.merged_into IS NULL
       AND sco.domain IS NOT NULL
       AND sco.domain != ''
       AND c.email IS NOT NULL
       AND (
         lower(c.email) LIKE '%@' || lower(sco.domain)
         OR lower(c.email) LIKE '%@%.' || lower(sco.domain)
       )
     ORDER BY length(sco.domain) DESC
     LIMIT 1
  )
WHERE c.deleted_at IS NULL
  AND c.merged_into IS NULL;

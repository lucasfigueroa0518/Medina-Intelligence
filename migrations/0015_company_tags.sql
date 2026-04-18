CREATE TABLE company_tags (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  applied_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (company_id, tag_id)
);
CREATE INDEX idx_company_tags_company ON company_tags(company_id);
CREATE INDEX idx_company_tags_tag ON company_tags(tag_id);

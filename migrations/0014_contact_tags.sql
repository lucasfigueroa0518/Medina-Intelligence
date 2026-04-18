CREATE TABLE contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  applied_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE contact_associations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  contact_id_a TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  contact_id_b TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  relationship TEXT NOT NULL DEFAULT 'connected'
    CHECK(relationship IN ('co-meeting','co-email','colleague','family','introduced_by','other')),
  inferred_from TEXT,
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(contact_id_a, contact_id_b),
  CHECK(contact_id_a < contact_id_b)
);
CREATE INDEX idx_contact_assoc_a ON contact_associations(contact_id_a);
CREATE INDEX idx_contact_assoc_b ON contact_associations(contact_id_b);

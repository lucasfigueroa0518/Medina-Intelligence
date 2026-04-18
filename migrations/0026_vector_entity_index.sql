CREATE TABLE vector_entity_index (
  vector_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_vei_entity ON vector_entity_index(entity_id, source_table);
CREATE INDEX idx_vei_org ON vector_entity_index(org_id);

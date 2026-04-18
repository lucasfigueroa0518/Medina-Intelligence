CREATE TABLE duplicate_candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL DEFAULT 'contact' CHECK(entity_type IN ('contact','company')),
  entity_id_a TEXT NOT NULL,
  entity_id_b TEXT NOT NULL,
  similarity_score REAL NOT NULL,
  resolution TEXT DEFAULT 'pending' CHECK(resolution IN ('pending','merged','dismissed')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(entity_id_a, entity_id_b)
);
CREATE INDEX idx_dup_candidates_org ON duplicate_candidates(org_id);
CREATE INDEX idx_dup_candidates_resolution ON duplicate_candidates(resolution);

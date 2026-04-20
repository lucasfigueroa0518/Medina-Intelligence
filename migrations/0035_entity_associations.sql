-- Entity associations: unified cross-entity relationship graph
CREATE TABLE IF NOT EXISTS entity_associations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  entity_a_type TEXT NOT NULL CHECK(entity_a_type IN ('contact','company','deal')),
  entity_a_id TEXT NOT NULL,
  entity_b_type TEXT NOT NULL CHECK(entity_b_type IN ('contact','company','deal')),
  entity_b_id TEXT NOT NULL,
  association_type TEXT NOT NULL CHECK(association_type IN ('same_company','deal_involvement','co_meeting','co_email','direct_email','same_sector','shared_interests','investment_aligned','mentioned_together','introduced_by')),
  strength INTEGER NOT NULL DEFAULT 50,
  reason TEXT NOT NULL,
  evidence_count INTEGER DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(org_id, entity_a_type, entity_a_id, entity_b_type, entity_b_id, association_type)
);
CREATE INDEX IF NOT EXISTS idx_ea_entity_a ON entity_associations(entity_a_type, entity_a_id);
CREATE INDEX IF NOT EXISTS idx_ea_entity_b ON entity_associations(entity_b_type, entity_b_id);
CREATE INDEX IF NOT EXISTS idx_ea_org ON entity_associations(org_id);
CREATE INDEX IF NOT EXISTS idx_ea_strength ON entity_associations(strength DESC);

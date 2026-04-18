CREATE TABLE approval_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  field_name TEXT,
  proposed_value TEXT,
  source_communication_id TEXT,
  source_visibility TEXT DEFAULT 'org_wide'
    CHECK(source_visibility IN ('private','org_wide','confidential')),
  confidence REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','auto_approved')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_approval_queue_idempotency ON approval_queue(idempotency_key);
CREATE INDEX idx_approval_queue_org ON approval_queue(org_id);
CREATE INDEX idx_approval_queue_status ON approval_queue(status);
CREATE INDEX idx_approval_queue_entity ON approval_queue(entity_type, entity_id);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT,
  context_entity_type TEXT,
  context_entity_id TEXT,
  turn_count INTEGER DEFAULT 0,
  last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_agent_sessions_org ON agent_sessions(org_id);
CREATE INDEX idx_agent_sessions_user ON agent_sessions(user_id);

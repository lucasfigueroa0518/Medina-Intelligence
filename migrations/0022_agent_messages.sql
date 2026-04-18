CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',
  token_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);

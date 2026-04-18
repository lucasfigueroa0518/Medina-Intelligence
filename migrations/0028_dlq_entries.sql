CREATE TABLE dlq_entries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('firefly','slack','outlook')),
  webhook_event_type TEXT,
  payload_r2_key TEXT NOT NULL,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 3,
  original_received_at TEXT NOT NULL,
  failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolution_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK(resolution_status IN ('unresolved','replayed','discarded')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_dlq_source ON dlq_entries(source);
CREATE INDEX idx_dlq_status ON dlq_entries(resolution_status);
CREATE INDEX idx_dlq_org ON dlq_entries(org_id);

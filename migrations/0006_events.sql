CREATE TABLE events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'meeting'
    CHECK(event_type IN ('meeting','conference','call','email_thread','hosted_event','in_person','other')),
  start_time TEXT NOT NULL,
  end_time TEXT,
  location TEXT,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK(source IN ('outlook','firefly','manual')),
  outlook_event_id TEXT UNIQUE,
  firefly_event_id TEXT UNIQUE,
  reconciliation_status TEXT NOT NULL DEFAULT 'reconciled'
    CHECK(reconciliation_status IN ('reconciled','pending_reconciliation','orphaned','standalone')),
  transcript_r2_key TEXT,
  transcript_source TEXT CHECK(transcript_source IN ('firefly','manual')),
  summary TEXT,
  key_decisions TEXT,
  action_items TEXT,
  topics_discussed TEXT,
  followup_status TEXT DEFAULT 'pending'
    CHECK(followup_status IN ('pending','in_progress','completed','not_required')),
  followup_due_date TEXT,
  vector_id TEXT,
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_events_org_id ON events(org_id);
CREATE INDEX idx_events_start_time ON events(start_time);
CREATE INDEX idx_events_source ON events(source);
CREATE INDEX idx_events_outlook_id ON events(outlook_event_id);
CREATE INDEX idx_events_reconciliation_status ON events(reconciliation_status);

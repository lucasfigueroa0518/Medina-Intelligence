CREATE TABLE merge_locks (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE RESTRICT,
  locked_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  locked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE event_attendees (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'attendee' CHECK(role IN ('organizer','presenter','attendee','optional')),
  is_internal INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_event_attendees_event_id ON event_attendees(event_id);
CREATE INDEX idx_event_attendees_contact_id ON event_attendees(contact_id);

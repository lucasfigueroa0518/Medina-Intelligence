-- Performance indexes for Fireflies transcript rebuild matching.
-- The rebuild path repeatedly looks up Outlook events in a narrow time
-- window, then bulk-loads attendees/users for candidate scoring.

CREATE INDEX IF NOT EXISTS idx_events_firefly_match_window
  ON events(org_id, source, start_time)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_event_email
  ON event_attendees(event_id, email);

CREATE INDEX IF NOT EXISTS idx_users_org_lower_email_active
  ON users(org_id, LOWER(email))
  WHERE deleted_at IS NULL;

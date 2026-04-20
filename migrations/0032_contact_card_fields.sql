-- 0032: Contact card fields for relationship tracking and investor intelligence.
-- NOTE: "engagement_status" is used instead of modifying "relationship_status"
-- because the existing column has a CHECK constraint with role-based values
-- (lp, prospect, etc.) that cannot be altered in SQLite. engagement_status
-- tracks dynamic relationship health (new/active/warm/dormant/churning/close).

ALTER TABLE contacts ADD COLUMN engagement_status TEXT DEFAULT 'new'
  CHECK(engagement_status IN ('new','active','warm','dormant','churning','close'));
ALTER TABLE contacts ADD COLUMN engagement_status_manual INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN relationship_owner_id TEXT REFERENCES users(id);
ALTER TABLE contacts ADD COLUMN relationship_owner_manual INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN location TEXT;
ALTER TABLE contacts ADD COLUMN introduced_via TEXT;
ALTER TABLE contacts ADD COLUMN investment_focus TEXT;
ALTER TABLE contacts ADD COLUMN check_size_range TEXT;
ALTER TABLE contacts ADD COLUMN fund_name TEXT;
ALTER TABLE contacts ADD COLUMN commitment_status TEXT;
ALTER TABLE contacts ADD COLUMN communication_channel_preference TEXT;
ALTER TABLE contacts ADD COLUMN response_time_pattern TEXT;

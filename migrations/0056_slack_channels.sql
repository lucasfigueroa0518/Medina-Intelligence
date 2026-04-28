-- Slack channel tracking: which channels the bot has seen, whether it's a
-- member, and the outcome of the last sync / auto-join attempt. Audit
-- 2026-04-28 logged "not_in_channel" for #emerge in every run; without this
-- table we had no record of which channels are reachable, no auto-join, and
-- no way for System Status to surface the membership gap.
CREATE TABLE slack_channels (
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  is_member INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_join_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (org_id, channel_id)
);
CREATE INDEX idx_slack_channels_org ON slack_channels(org_id);

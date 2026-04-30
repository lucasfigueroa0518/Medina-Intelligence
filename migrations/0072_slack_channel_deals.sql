-- Phase E — Slack channel ↔ deal junction (background classifier).
--
-- When a Slack channel is identified as belonging to a specific deal
-- (channel name fuzzy-matches an open deal's company), all messages from
-- that channel inherit a conversation_deals link via source='inherited_channel'.
--
-- Soft-typed `source` (no CHECK) for forward compatibility:
--   'channel_name_match'  — token overlap between channel_name and company name
--   'manual'              — admin-tagged
--   'llm_classification'  — future: Haiku confirms ambiguous match
--
-- PK (org_id, channel_id, deal_id) lets a single channel point at multiple
-- deals (e.g. a co-investment channel covering two portfolios). Idempotent
-- via INSERT OR IGNORE.
--
-- No FK on channel_id because slack_channels is keyed (org_id, channel_id)
-- and SQLite composite-FK + ON DELETE CASCADE is brittle in D1; channel
-- deletes are rare and the orphan rows don't break read paths.

CREATE TABLE IF NOT EXISTS slack_channel_deals (
  org_id        TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  deal_id       TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.85,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by    TEXT,
  PRIMARY KEY (org_id, channel_id, deal_id),
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_slack_channel_deals_lookup
  ON slack_channel_deals(org_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_channel_deals_deal
  ON slack_channel_deals(deal_id);

-- Migration 0046: per-conversation extraction marker
--   The enrichment workflow's llm-extraction step re-reads every conversation
--   in the trailing 24h every cycle (twice an hour). Without a marker each
--   email got re-sent to Claude up to 48 times in 24h, producing a fresh
--   approval_queue row every time. Match the existing pattern used by
--   events.signals_extracted_at and news_articles.facts_extracted_at.

ALTER TABLE conversations ADD COLUMN signals_extracted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_signals_pending
  ON conversations(org_id, sent_at DESC)
  WHERE signals_extracted_at IS NULL;

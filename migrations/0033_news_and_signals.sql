-- Migration 0033: News articles table + transcript signal extraction tracking
-- Upgrade 1: Add signals_extracted_at to events for Firefly transcript intelligence
-- Upgrade 2: Create news_articles table for industry-wide news intelligence

ALTER TABLE events ADD COLUMN signals_extracted_at TEXT;

CREATE TABLE IF NOT EXISTS news_articles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  company_id TEXT REFERENCES companies(id),
  title TEXT NOT NULL,
  source_url TEXT,
  source_name TEXT,
  published_at TEXT,
  summary TEXT,
  relevance_tag TEXT CHECK(relevance_tag IN ('direct_mention','competitor','industry_trend','technology','regulatory')),
  relevance_score INTEGER DEFAULT 0,
  sector TEXT,
  vector_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_news_org ON news_articles(org_id);
CREATE INDEX IF NOT EXISTS idx_news_company ON news_articles(company_id);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_articles(published_at);

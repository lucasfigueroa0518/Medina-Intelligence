-- News-fetch scheduling. Without this column the news step queries up to 20
-- companies × 5 Gemini queries every hour serially — ~125 calls back-to-back,
-- which blew past the 300s step timeout (audit 2026-04-28). With this column,
-- the fetch-news step picks the 25 oldest-stamped companies (or never-fetched
-- ones), updates the timestamp on every attempt, and skips them for ~24h.
ALTER TABLE companies ADD COLUMN last_news_fetched_at TEXT;
CREATE INDEX idx_companies_news_staleness
  ON companies(org_id, last_news_fetched_at);

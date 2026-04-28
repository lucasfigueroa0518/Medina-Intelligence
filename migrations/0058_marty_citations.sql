-- MARTy citation support: store the numbered source list with each assistant
-- message so reloads can rehydrate the inline pills, plus lightweight metrics
-- for citation quality and click-through.

ALTER TABLE agent_messages ADD COLUMN sources_json TEXT;

CREATE TABLE IF NOT EXISTS marty_citation_metrics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sources_provided INTEGER NOT NULL DEFAULT 0,
  citations_used INTEGER NOT NULL DEFAULT 0,
  invalid_citations INTEGER NOT NULL DEFAULT 0,
  response_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_marty_citation_metrics_org ON marty_citation_metrics(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marty_citation_metrics_session ON marty_citation_metrics(session_id);

CREATE TABLE IF NOT EXISTS marty_citation_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT,
  source_id INTEGER NOT NULL,
  source_type TEXT,
  source_table TEXT,
  source_row_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_marty_citation_clicks_org ON marty_citation_clicks(org_id, created_at);

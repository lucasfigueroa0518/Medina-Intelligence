CREATE TABLE rag_query_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  turn_index INTEGER NOT NULL,
  original_query TEXT NOT NULL,
  processed_query TEXT NOT NULL,
  vectorize_internal_match_count INTEGER,
  vectorize_news_match_count INTEGER,
  post_filter_count INTEGER,
  hydration_summary TEXT,
  reranker_input_count INTEGER,
  reranker_output_count INTEGER,
  reranker_status TEXT CHECK(reranker_status IN (
    'success','fallback_rate_limited','fallback_parse_error','fallback_timeout','skipped_too_few'
  )),
  context_r2_key TEXT,
  token_counts TEXT,
  uploaded_document_summary TEXT,
  claude_model TEXT,
  claude_input_tokens INTEGER,
  claude_output_tokens INTEGER,
  latency_retrieval_ms INTEGER,
  latency_rerank_ms INTEGER,
  latency_hydration_ms INTEGER,
  latency_llm_ms INTEGER,
  latency_total_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_rag_logs_session ON rag_query_logs(session_id);
CREATE INDEX idx_rag_logs_org ON rag_query_logs(org_id);
CREATE INDEX idx_rag_logs_created ON rag_query_logs(created_at);

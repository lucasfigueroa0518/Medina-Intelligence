-- RAG V2 — parallel hybrid retrieval substrate.
--
-- Additive only: current RAG tables/indexes remain live until an org is cut
-- over through rag_retrieval_config. The V2 chunk table is the canonical
-- metadata sidecar for Vectorize and the lexical index, so retrieval can use
-- Vectorize returnMetadata='indexed' while hydrating and ACL-checking from D1.

CREATE TABLE IF NOT EXISTS rag_chunks_v2 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_family TEXT NOT NULL,
  document_type TEXT NOT NULL,

  chunk_index INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  parent_chunk_id TEXT,
  previous_chunk_id TEXT,
  next_chunk_id TEXT,
  section_path TEXT,
  title TEXT,

  text_r2_key TEXT NOT NULL,
  kv_key TEXT,
  text_preview TEXT,
  content_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,

  primary_entity_id TEXT NOT NULL,
  secondary_entity_ids TEXT,
  entity_names TEXT,
  exact_terms TEXT,

  visibility TEXT NOT NULL
    CHECK (visibility IN ('private','org_wide','confidential','public','org')),
  acl_mode TEXT NOT NULL DEFAULT 'metadata'
    CHECK (acl_mode IN ('metadata','source_authoritative','public')),
  participant_user_ids TEXT,
  uploaded_by TEXT,

  source_created_at TEXT,
  created_at_epoch INTEGER,
  chunk_config_version TEXT NOT NULL DEFAULT 'v3',

  vector_id_bge TEXT,
  vector_id_qwen3 TEXT,
  vector_id_minilm TEXT,
  vectorize_status_bge TEXT NOT NULL DEFAULT 'pending'
    CHECK (vectorize_status_bge IN ('pending','synced','failed','skipped')),
  vectorize_status_qwen3 TEXT NOT NULL DEFAULT 'pending'
    CHECK (vectorize_status_qwen3 IN ('pending','synced','failed','skipped')),
  vectorize_status_minilm TEXT NOT NULL DEFAULT 'pending'
    CHECK (vectorize_status_minilm IN ('pending','synced','failed','skipped')),

  lexical_doc_id TEXT,
  opensearch_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (opensearch_status IN ('pending','synced','failed','skipped')),

  last_error TEXT,
  indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  UNIQUE (org_id, source_table, source_id, chunk_index, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_source
  ON rag_chunks_v2 (org_id, source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_primary
  ON rag_chunks_v2 (org_id, primary_entity_id, source_family);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_doc_type
  ON rag_chunks_v2 (org_id, document_type, source_family);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_vector_bge
  ON rag_chunks_v2 (vector_id_bge);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_vector_qwen3
  ON rag_chunks_v2 (vector_id_qwen3);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_vector_minilm
  ON rag_chunks_v2 (vector_id_minilm);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_v2_sync
  ON rag_chunks_v2 (org_id, opensearch_status, vectorize_status_bge);

CREATE TABLE IF NOT EXISTS rag_source_index_state (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  chunk_config_version TEXT NOT NULL DEFAULT 'v3',
  selected_embedding_profile TEXT NOT NULL DEFAULT 'bge-base-en-v1.5:cls:v3',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  vectorized_bge_count INTEGER NOT NULL DEFAULT 0,
  vectorized_qwen3_count INTEGER NOT NULL DEFAULT 0,
  vectorized_minilm_count INTEGER NOT NULL DEFAULT 0,
  lexical_count INTEGER NOT NULL DEFAULT 0,
  backfill_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (backfill_status IN ('pending','in_progress','completed','failed','skipped')),
  cursor INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_source_index_state_status
  ON rag_source_index_state (org_id, backfill_status, source_table);

CREATE TABLE IF NOT EXISTS rag_retrieval_eval_cases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  expected_source_ids TEXT NOT NULL DEFAULT '[]',
  expected_answer_constraints TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  privacy_scope TEXT NOT NULL DEFAULT 'org_wide'
    CHECK (privacy_scope IN ('public','org_wide','private','confidential')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_cases_org_category
  ON rag_retrieval_eval_cases (org_id, enabled, category);

CREATE TABLE IF NOT EXISTS rag_retrieval_traces_v2 (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT,
  session_id TEXT,
  turn_index INTEGER,
  query TEXT NOT NULL,
  retrieval_version TEXT NOT NULL DEFAULT 'v2',
  embedding_profile TEXT NOT NULL,
  dense_count INTEGER NOT NULL DEFAULT 0,
  lexical_count INTEGER NOT NULL DEFAULT 0,
  fused_count INTEGER NOT NULL DEFAULT 0,
  acl_allowed_count INTEGER NOT NULL DEFAULT 0,
  reranker_input_count INTEGER NOT NULL DEFAULT 0,
  reranker_output_count INTEGER NOT NULL DEFAULT 0,
  hydration_summary TEXT,
  top_candidates_json TEXT,
  latency_dense_ms INTEGER,
  latency_lexical_ms INTEGER,
  latency_fusion_ms INTEGER,
  latency_hydration_ms INTEGER,
  latency_rerank_ms INTEGER,
  latency_total_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success'
    CHECK (status IN ('success','fallback','failed','shadow')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_rag_traces_v2_org_created
  ON rag_retrieval_traces_v2 (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rag_traces_v2_session
  ON rag_retrieval_traces_v2 (session_id, turn_index);

CREATE TABLE IF NOT EXISTS rag_retrieval_config (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  retrieval_version TEXT NOT NULL DEFAULT 'v1'
    CHECK (retrieval_version IN ('v1','v2','shadow')),
  embedding_profile TEXT NOT NULL DEFAULT 'bge-base-en-v1.5:cls:v3',
  shadow_enabled INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

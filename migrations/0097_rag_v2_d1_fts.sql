-- RAG V2 Cloudflare-native lexical index.
-- Uses D1 FTS5 for BM25-style keyword retrieval instead of an external
-- search service. Dense retrieval remains in Cloudflare Vectorize.

CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_v2_fts USING fts5(
  title,
  body,
  section_path,
  entity_names,
  exact_terms,
  chunk_id UNINDEXED,
  org_id UNINDEXED,
  source_table UNINDEXED,
  source_id UNINDEXED,
  document_type UNINDEXED,
  source_family UNINDEXED,
  primary_entity_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

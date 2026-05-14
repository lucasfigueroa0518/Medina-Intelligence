import type { HydratedChunk, VectorMatch } from './interfaces';

export type EmbeddingProfileId =
  | 'bge-base-en-v1.5:cls:v3'
  | 'qwen3-embedding-0.6b:v3'
  | 'all-MiniLM-L6-v2:v3';

export interface EmbeddingModelProfile {
  id: EmbeddingProfileId;
  provider: 'workers-ai' | 'external-http';
  model: string;
  dimensions: number;
  maxInputTokens: number;
  maxContentTokens: number;
  pooling?: 'cls' | 'mean';
  vectorBinding: 'VECTORIZE_RAG_V2_BGE' | 'VECTORIZE_RAG_V2_QWEN3' | 'VECTORIZE_RAG_V2_MINILM';
  vectorIndexName: string;
  vectorColumn: 'vector_id_bge' | 'vector_id_qwen3' | 'vector_id_minilm';
  vectorStatusColumn: 'vectorize_status_bge' | 'vectorize_status_qwen3' | 'vectorize_status_minilm';
  benchmarkOnly?: boolean;
}

export interface ChunkingProfile {
  version: 'v3';
  embeddingProfileId: EmbeddingProfileId;
  maxContentTokens: number;
  prefixBudgetTokens: number;
}

export interface RagV2Chunk {
  id?: string;
  text: string;
  title?: string;
  sectionPath?: string;
  chunkIndex: number;
  totalChunks: number;
  previousChunkId?: string | null;
  nextChunkId?: string | null;
  parentChunkId?: string | null;
  exactTerms: string[];
}

export interface RagChunkRecord {
  id: string;
  org_id: string;
  source_table: string;
  source_id: string;
  source_family: string;
  document_type: string;
  chunk_index: number;
  total_chunks: number;
  parent_chunk_id: string | null;
  previous_chunk_id: string | null;
  next_chunk_id: string | null;
  section_path: string | null;
  title: string | null;
  text_r2_key: string;
  kv_key: string | null;
  text_preview: string | null;
  content_hash: string;
  source_hash: string;
  primary_entity_id: string;
  secondary_entity_ids: string | null;
  entity_names: string | null;
  exact_terms: string | null;
  visibility: 'private' | 'org_wide' | 'confidential' | 'public' | 'org';
  acl_mode: 'metadata' | 'source_authoritative' | 'public';
  participant_user_ids: string | null;
  uploaded_by: string | null;
  source_created_at: string | null;
  created_at_epoch: number | null;
  chunk_config_version: string;
  vector_id_bge: string | null;
  vector_id_qwen3: string | null;
  vector_id_minilm: string | null;
  lexical_doc_id: string | null;
  opensearch_status: 'pending' | 'synced' | 'failed' | 'skipped';
  vectorize_status_bge: 'pending' | 'synced' | 'failed' | 'skipped';
  vectorize_status_qwen3: 'pending' | 'synced' | 'failed' | 'skipped';
  vectorize_status_minilm: 'pending' | 'synced' | 'failed' | 'skipped';
  last_error: string | null;
}

export interface LexicalCandidate {
  chunkId: string;
  score: number;
  rank: number;
  source: 'd1_fts';
  highlights?: string[];
  exactBoost?: number;
}

export interface DenseCandidate {
  chunkId: string;
  vectorId: string;
  score: number;
  rank: number;
  source: 'vectorize_broad' | 'vectorize_entity';
}

export interface HybridCandidate {
  chunkId: string;
  score: number;
  denseScore?: number;
  lexicalScore?: number;
  denseRank?: number;
  lexicalRank?: number;
  sources: Array<DenseCandidate['source'] | LexicalCandidate['source']>;
}

export interface RetrievalTraceV2 {
  denseCandidates: DenseCandidate[];
  lexicalCandidates: LexicalCandidate[];
  fusedCandidates: HybridCandidate[];
  hydratedChunks: HydratedChunk[];
  vectorMatches: VectorMatch[];
}

export interface RagV2RuntimeConfig {
  retrievalVersion: 'v1' | 'v2' | 'shadow';
  embeddingProfile: EmbeddingProfileId;
  shadowEnabled: boolean;
}

export interface RagReindexQueueMessage {
  work_queue_id: string;
  lease_heartbeat_at: string | null;
  dispatched_at: string;
}

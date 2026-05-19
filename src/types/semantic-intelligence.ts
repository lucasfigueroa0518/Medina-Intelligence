export const SEMANTIC_INTELLIGENCE_VERSION = 'v1.1';
export const SEMANTIC_INTELLIGENCE_DOMAIN = 'semantic_intelligence_v1';

export type SemanticSourceTable =
  | 'conversations'
  | 'events'
  | 'documents'
  | 'contacts'
  | 'companies'
  | 'deals'
  | 'news_articles';

export type SemanticSubjectType =
  | 'company'
  | 'contact'
  | 'deal'
  | 'document'
  | 'event'
  | 'conversation'
  | 'news_article'
  | 'observed_company'
  | 'observed_person'
  | 'observed_fund'
  | 'market'
  | 'topic';

export type SemanticLinkedEntityType =
  | 'company'
  | 'contact'
  | 'deal'
  | 'document'
  | 'event'
  | 'conversation'
  | 'news_article';

export type SemanticTargetType =
  | 'semantic_subject'
  | SemanticLinkedEntityType;

export type SemanticConfidenceLabel =
  | 'explicit'
  | 'strong_inference'
  | 'weak_inference'
  | 'computed'
  | 'human';

export type SemanticExtractionMethod =
  | 'deterministic'
  | 'llm_evidence'
  | 'llm_grounded'
  | 'human'
  | 'import';

export interface SemanticExtractionPayload {
  source_table: SemanticSourceTable;
  source_id: string;
  /** LLM extraction is opt-in so semantic backfill cannot accidentally
   * compete with a heavy RAG drain. Deterministic assertions still run. */
  use_llm?: boolean;
  /** Reprocess even when semantic_source_state has the same source_hash. */
  force?: boolean;
}

export interface SemanticAssertionInput {
  subject_name?: string;
  subject_type?: SemanticSubjectType;
  predicate: string;
  value: string;
  value_json?: unknown;
  confidence?: number;
  confidence_label?: SemanticConfidenceLabel;
  extraction_method?: SemanticExtractionMethod;
  evidence_quote: string;
  evidence_kind?: 'quote' | 'field_value' | 'table_cell' | 'derived_from_record' | 'human_note';
  source_field?: string;
  rag_chunk_id?: string | null;
}

export interface SemanticObservedEntityInput {
  name: string;
  subject_type: SemanticSubjectType;
  aliases?: string[];
  confidence?: number;
  evidence_quote: string;
}

export interface SemanticMaterial {
  org_id: string;
  source_table: SemanticSourceTable;
  source_id: string;
  source_hash: string;
  title: string;
  text: string;
  default_subject_name: string;
  default_subject_type: SemanticSubjectType;
  linked_entity_type: SemanticLinkedEntityType;
  linked_entity_id: string;
  rag_chunk_ids: string[];
  deterministic_assertions: SemanticAssertionInput[];
}

export interface SemanticProcessResult {
  status: 'completed' | 'skipped' | 'failed';
  source_table: SemanticSourceTable;
  source_id: string;
  source_hash?: string;
  subjects: number;
  assertions: number;
  evidence: number;
  errors: string[];
}

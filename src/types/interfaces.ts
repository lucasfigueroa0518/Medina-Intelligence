// Shared interfaces — TRD §3, §4, §7, §8, §11

// --- Domain entities (partial — mirrors D1 rows) ---

export interface Organization {
  id: string;
  name: string;
  domain: string;
  settings: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface OrgSettings {
  auto_approve_sync: boolean;
  sync_interval_minutes: number;
  linkedin_enrichment_enabled: boolean;
  news_feed_enabled: boolean;
  max_enrichments_per_cycle: number;
  outlook_backfill_days: number;
  reranker_enabled: boolean;
}

export interface User {
  id: string;
  org_id: string;
  email: string;
  full_name: string;
  avatar_url?: string | null;
  role: 'owner' | 'admin' | 'member';
  outlook_token?: string | null;
  slack_token?: string | null;
  outlook_delta_token?: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface Contact {
  id: string;
  org_id: string;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  contact_type: string;
  relationship_status?: string | null;
  company_id?: string | null;
  job_title?: string | null;
  merged_into?: string | null;
  topics_of_interest?: string | null;
  pain_points?: string | null;
  investment_thesis_tags?: string | null;
  bio_summary?: string | null;
  last_contact_date?: string | null;
  total_interactions: number;
  meetings_last_30d: number;
  email_frequency_score: number;
  next_followup_date?: string | null;
  next_followup_note?: string | null;
  investment_amount?: number | null;
  fund_commitment?: number | null;
  investment_currency?: string;
  source: string;
  source_confidence: number;
  enrichment_confidence?: number;
  enrichment_last_run?: string | null;
  custom_fields?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface Company {
  id: string;
  org_id: string;
  name: string;
  website?: string | null;
  logo_url?: string | null;
  description?: string | null;
  company_type: string;
  sector?: string | null;
  stage?: string | null;
  investment_status?: string | null;
  investment_amount?: number | null;
  investment_date?: string | null;
  ownership_pct?: number | null;
  current_valuation?: number | null;
  currency?: string;
  linkedin_url?: string | null;
  enrichment_confidence?: number;
  enrichment_last_run?: string | null;
  news_relevance_score?: number;
  last_news_summary?: string | null;
  custom_fields?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface Conversation {
  id: string;
  org_id: string;
  source: 'outlook' | 'slack' | 'manual';
  external_thread_id?: string | null;
  external_message_id?: string | null;
  subject?: string | null;
  body_r2_key: string;
  body_preview?: string | null;
  direction?: 'inbound' | 'outbound' | 'internal' | null;
  sent_at: string;
  from_email: string;
  from_contact_id?: string | null;
  to_emails: string;
  cc_emails?: string;
  sentiment?: string | null;
  topics?: string | null;
  action_items?: string | null;
  participant_user_ids: string;
  is_campaign_email: number;
  visibility?: 'private' | 'org_wide' | 'confidential';
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  org_id: string;
  title: string;
  event_type: string;
  start_time: string;
  end_time?: string | null;
  location?: string | null;
  description?: string | null;
  source: 'outlook' | 'firefly' | 'manual';
  outlook_event_id?: string | null;
  firefly_event_id?: string | null;
  reconciliation_status: 'reconciled' | 'pending_reconciliation' | 'orphaned' | 'standalone';
  transcript_r2_key?: string | null;
  transcript_source?: 'firefly' | 'manual' | null;
  summary?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface AgentSession {
  id: string;
  org_id: string;
  user_id: string;
  title?: string | null;
  context_entity_type?: string | null;
  context_entity_id?: string | null;
  turn_count: number;
  user_role?: string;
  last_activity_at: string;
  created_at: string;
}

// --- Filters ---

export interface ContactFilter {
  contact_types?: string[];
  tags?: string[];
  tag_logic?: 'and' | 'or';
  company_tags?: string[];
  company_id?: string;
  investment_status?: string;
  last_contact_before?: string;
  last_contact_after?: string;
  meetings_last_30d_min?: number;
  keyword?: string;
  deal_stage?: string;
  has_followup_overdue?: boolean;
  sector?: string[];
  sort_by?: 'last_contact_date' | 'total_interactions' | 'name' | 'created_at';
  sort_dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CompanyFilter {
  company_types?: string[];
  tags?: string[];
  tag_logic?: 'and' | 'or';
  investment_status?: string[];
  stage?: string[];
  sector?: string[];
  keyword?: string;
  sort_by?: 'name' | 'investment_status' | 'stage' | 'current_valuation' | 'created_at';
  sort_dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// --- Ingestion / Classification ---

export interface ClassifiableItem {
  type: 'email' | 'calendar_event' | 'slack_message' | 'news';
  source: 'outlook' | 'slack' | 'claude_search' | 'gemini_search';
  externalId: string;
  threadId?: string;
  subject?: string;
  bodyText: string;
  bodyPreview: string;
  fromEmail?: string;
  fromName?: string;
  toEmails?: string[];
  ccEmails?: string[];
  sentAt: string;
  direction?: 'inbound' | 'outbound' | 'internal';
  importance?: string;
  userId?: string | null;
  orgId: string;
  visibility: 'private' | 'org_wide' | 'confidential';
  relatedCompanyId?: string;
  relatedCompanyName?: string;
  metadata?: ChunkMetadata;
  text?: string;
}

export interface ClassifiedItem extends ClassifiableItem {
  entityType: 'conversation' | 'event' | 'news';
  entityId: string;
  contactIds: string[];
  companyId?: string;
  participantUserIds?: string[];
  metadata: ChunkMetadata;
  text: string;
}

// --- Chunk / Embedding ---

export interface ChunkMetadata {
  org_id: string;
  user_id?: string;
  visibility: 'private' | 'org_wide' | 'confidential';
  participant_user_ids?: string;
  document_type: string;
  source_table: string;
  source_id: string;
  r2_key: string;
  chunk_index?: number;
  total_chunks?: number;
  created_at: string;
  primary_entity_id: string;
  secondary_entity_ids?: string;
  text_preview?: string;
  embedding_model?: string;
  chunk_config_version?: string;
  reconciliation_status?: string;
  speakers?: string;
  primary_speaker?: string;
  entity_name?: string;
  deal_stage?: string;
  date?: string;
}

export interface VectorIndexEntry {
  vectorId: string;
  entityId: string;
  sourceTable: string;
  orgId: string;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata: {
    [key: string]: any;
    org_id: string;
    visibility?: 'private' | 'org_wide' | 'confidential';
    participant_user_ids?: string;
    user_id?: string;
    document_type?: string;
    source_table?: string;
    source_id?: string;
    r2_key?: string;
    chunk_index?: number;
    total_chunks?: number;
    primary_entity_id?: string;
    secondary_entity_ids?: string;
    text_preview?: string;
    embedding_model?: string;
    chunk_config_version?: string;
    reconciliation_status?: string;
    entity_name?: string;
    created_at?: string;
  };
}

export interface HydratedChunk extends VectorMatch {
  hydrated_text: string;
  hydration_source: 'kv' | 'r2_rechunk' | 'preview_fallback';
}

export interface HydrationSummary {
  kv: number;
  r2_rechunk: number;
  preview_fallback: number;
}

// --- RAG ---

export interface ProcessedQuery {
  originalQuery: string;
  embeddedQuery: number[];
  entityIds: string[];
  filters: Record<string, any>;
  orgId: string;
  postRetrievalFilter: (chunk: VectorMatch) => boolean;
}

// --- Speaker turns (transcripts) ---

export interface SpeakerTurn {
  speaker: string;
  affiliation: string;
  text: string;
  timestamp?: string;
}

export interface TranscriptChunk {
  text: string;
  speakers: string[];
  primary_speaker: string;
  start_timestamp?: string;
  end_timestamp?: string;
}

// --- Enrichment ---

export interface EnrichmentSourceContribution {
  source: 'reversecontact' | 'claude_web_search' | 'llm_extraction' | 'gemini_web_search' | 'transcript_extraction';
  text: string;
  sanitized_text?: string;
  visibility: 'private' | 'org_wide' | 'confidential';
  communication_id?: string;
}

// --- Merge ---

export interface MergeResult {
  success: boolean;
  error?: string;
  message?: string;
}

// --- Auth context (attached to Request by middleware) ---

export interface AuthContext {
  userId: string;
  orgId: string;
  userRole: 'owner' | 'admin' | 'member';
  email: string;
}

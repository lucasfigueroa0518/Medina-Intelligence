import type { Env } from '../types/env';
import type { HydratedChunk, VectorMatch } from '../types/interfaces';
import type {
  DenseCandidate,
  EmbeddingProfileId,
  HybridCandidate,
  LexicalCandidate,
  RagChunkRecord,
  RagV2RuntimeConfig,
} from '../types/rag-v2';
import {
  DEFAULT_RAG_V2_EMBEDDING_PROFILE,
  getEmbeddingProfile,
  RAG_V2_EMBEDDING_PROFILES,
  runEmbeddingsForProfile,
} from './embedding';
import { chunkTextForRagV2, RAG_V2_CHUNK_VERSION, RAG_V2_PREFIX_BUDGET_TOKENS } from './chunking';
import { truncateToTokens } from './tokens';
import { parseParticipantUserIds } from './helpers';
import { upsertRagChunksD1Fts } from './rag-v2-lexical';
import { enqueueWork } from './work-queue';

export const RAG_V2_WORK_QUEUE_DOMAIN = 'rag_reindex_v2';
const RRF_K = 60;
const MAX_SOURCE_CHUNKS_BEFORE_RERANK = 3;
const MAX_RAG_V2_CHUNKS_PER_JOB = 80;
const RAG_V2_RANGE_CHUNK_SIZE = 60;
const RAG_V2_EMBEDDING_BATCH_SIZE = 16;

export type RagV2SourceTable = 'conversations' | 'events' | 'documents' | 'contacts' | 'companies' | 'deals' | 'news_articles';

interface RagV2Source {
  orgId: string;
  sourceTable: RagV2SourceTable;
  sourceId: string;
  sourceFamily: string;
  documentType: string;
  title: string;
  text: string;
  sourceCreatedAt: string;
  visibility: 'private' | 'org_wide' | 'confidential' | 'public' | 'org';
  aclMode: 'metadata' | 'source_authoritative' | 'public';
  participantUserIds?: string;
  uploadedBy?: string | null;
  primaryEntityId: string;
  secondaryEntityIds?: string;
  entityNames?: string;
}

export interface RagV2ReindexPayload {
  source_table: RagV2SourceTable;
  source_id: string;
  profiles?: EmbeddingProfileId[];
  chunk_start?: number;
  chunk_end?: number;
  parent_source_hash?: string;
  expected_total_chunks?: number;
}

export interface RagV2ReindexResult {
  status: 'indexed' | 'missing' | 'skipped' | 'queued' | 'partial';
  chunks: number;
  profiles: EmbeddingProfileId[];
  lexical: 'synced' | 'skipped' | 'failed';
  errors: string[];
}

export interface RagV2EnqueueResult {
  status: 'enqueued' | 'already_queued' | 'missing' | 'skipped';
  source_table: RagV2SourceTable;
  source_id: string;
  source_family?: string;
  source_created_at?: string;
  source_hash?: string;
  work_queue_id?: string;
  idempotency_key?: string;
  reason?: string;
}

export interface RagV2FreshnessRow {
  source_family: string;
  source_table: RagV2SourceTable;
  total_sources: number;
  indexed_sources: number;
  missing_sources: number;
  incomplete_sources: number;
  skipped_sources: number;
  latest_source_at: string | null;
  latest_indexed_source_at: string | null;
  freshness_lag_ms: number | null;
  queue_pending: number;
  queue_in_progress: number;
  queue_failed: number;
  queue_dead_letter: number;
}

export interface RagV2CoverageRepairResult {
  scanned: number;
  candidates: number;
  enqueued: number;
  already_queued: number;
  skipped: number;
  missing: number;
  errors: string[];
  freshness: RagV2FreshnessRow[];
}

interface RagV2SourceSpec {
  sourceTable: RagV2SourceTable;
  sourceFamily: string;
  sourceSql: string;
  sourceWhere: string;
}

function fnv1a(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function sha256Short(text: string, length = 18): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

function epochSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function sourceFamilyForRagV2(documentType: string): string {
  if (documentType === 'email') return 'emails';
  if (documentType === 'transcript') return 'transcripts';
  if (documentType === 'conversation') return 'slack';
  if (documentType === 'enrichment') return 'entity_context';
  if (documentType === 'deal_record') return 'deal_records';
  if (documentType === 'news') return 'news';
  return 'documents';
}

const RAG_V2_SOURCE_SPECS: RagV2SourceSpec[] = [
  {
    sourceTable: 'conversations',
    sourceFamily: 'slack',
    sourceSql: `
      SELECT id, sent_at AS source_created_at
        FROM conversations
       WHERE org_id = ?
         AND source = 'slack'
         AND (body_r2_key IS NOT NULL OR length(COALESCE(body_preview, '')) >= 10)
    `,
    sourceWhere: "src.source_table = 'conversations' AND src.source_family = 'slack'",
  },
  {
    sourceTable: 'conversations',
    sourceFamily: 'emails',
    sourceSql: `
      SELECT id, sent_at AS source_created_at
        FROM conversations
       WHERE org_id = ?
         AND source = 'outlook'
         AND (body_r2_key IS NOT NULL OR length(COALESCE(body_preview, '')) >= 10)
    `,
    sourceWhere: "src.source_table = 'conversations' AND src.source_family = 'emails'",
  },
  {
    sourceTable: 'conversations',
    sourceFamily: 'transcripts',
    sourceSql: `
      SELECT id, sent_at AS source_created_at
        FROM conversations
       WHERE org_id = ?
         AND source = 'manual'
         AND (body_r2_key IS NOT NULL OR length(COALESCE(body_preview, '')) >= 10)
    `,
    sourceWhere: "src.source_table = 'conversations' AND src.source_family = 'transcripts'",
  },
  {
    sourceTable: 'events',
    sourceFamily: 'transcripts',
    sourceSql: `
      SELECT id, start_time AS source_created_at
        FROM events
       WHERE org_id = ?
         AND deleted_at IS NULL
         AND (transcript_r2_key IS NOT NULL OR length(COALESCE(summary, '')) >= 10)
    `,
    sourceWhere: "src.source_table = 'events' AND src.source_family = 'transcripts'",
  },
  {
    sourceTable: 'documents',
    sourceFamily: 'documents',
    sourceSql: `
      SELECT id, created_at AS source_created_at
        FROM documents
       WHERE org_id = ?
         AND deleted_at IS NULL
         AND processing_status = 'completed'
         AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1
         AND (r2_key IS NOT NULL OR length(COALESCE(extracted_text_preview, '')) >= 10)
    `,
    sourceWhere: "src.source_table = 'documents' AND src.source_family = 'documents'",
  },
  {
    sourceTable: 'contacts',
    sourceFamily: 'entity_context',
    sourceSql: `
      SELECT id, updated_at AS source_created_at
        FROM contacts
       WHERE org_id = ?
         AND deleted_at IS NULL
         AND merged_into IS NULL
         AND length(COALESCE(bio_summary, '')) >= 10
    `,
    sourceWhere: "src.source_table = 'contacts' AND src.source_family = 'entity_context'",
  },
  {
    sourceTable: 'companies',
    sourceFamily: 'entity_context',
    sourceSql: `
      SELECT id, updated_at AS source_created_at
        FROM companies
       WHERE org_id = ?
         AND deleted_at IS NULL
         AND merged_into IS NULL
         AND length(COALESCE(description, '')) >= 10
    `,
    sourceWhere: "src.source_table = 'companies' AND src.source_family = 'entity_context'",
  },
  {
    sourceTable: 'deals',
    sourceFamily: 'deal_records',
    sourceSql: `
      SELECT id, updated_at AS source_created_at
        FROM deals
       WHERE org_id = ?
         AND deleted_at IS NULL
    `,
    sourceWhere: "src.source_table = 'deals' AND src.source_family = 'deal_records'",
  },
  {
    sourceTable: 'news_articles',
    sourceFamily: 'news',
    sourceSql: `
      SELECT id, COALESCE(published_at, created_at) AS source_created_at
        FROM news_articles
       WHERE org_id = ?
         AND quality_status = 'usable'
         AND length(COALESCE(summary, '')) >= 10
    `,
    sourceWhere: "src.source_table = 'news_articles' AND src.source_family = 'news'",
  },
];

function vectorCountColumnForProfile(profileId: EmbeddingProfileId): 'vectorized_bge_count' | 'vectorized_qwen3_count' | 'vectorized_minilm_count' {
  if (profileId === 'qwen3-embedding-0.6b:v3') return 'vectorized_qwen3_count';
  if (profileId === 'all-MiniLM-L6-v2:v3') return 'vectorized_minilm_count';
  return 'vectorized_bge_count';
}

function specsForRagV2Coverage(options: {
  sourceTables?: RagV2SourceTable[];
  sourceFamilies?: string[];
} = {}): RagV2SourceSpec[] {
  const tables = options.sourceTables?.length ? new Set(options.sourceTables) : null;
  const families = options.sourceFamilies?.length ? new Set(options.sourceFamilies) : null;
  return RAG_V2_SOURCE_SPECS.filter(spec =>
    (!tables || tables.has(spec.sourceTable)) &&
    (!families || families.has(spec.sourceFamily))
  );
}

function compactParticipantIds(raw: string | null | undefined): string | undefined {
  const parsed = parseParticipantUserIds(raw);
  return parsed.length > 0 ? parsed.join(',') : undefined;
}

function getVectorBinding(env: Env, profileId: EmbeddingProfileId): VectorizeIndex | null {
  const profile = getEmbeddingProfile(profileId);
  return (env as any)[profile.vectorBinding] || null;
}

function vectorIdFor(profileId: EmbeddingProfileId, chunkId: string): string {
  const prefix =
    profileId.startsWith('bge') ? 'bge'
    : profileId.startsWith('qwen3') ? 'qwn'
    : 'mini';
  return `rv2_${prefix}_${fnv1a(chunkId).slice(0, 20)}`;
}

function prefixRagV2Chunk(source: RagV2Source, sectionPath?: string): string {
  const parts = [
    `[Type: ${source.documentType}]`,
    `[Source: ${source.sourceFamily}]`,
  ];
  if (source.entityNames) parts.push(`[Entity: ${source.entityNames}]`);
  if (source.sourceCreatedAt) parts.push(`[Date: ${source.sourceCreatedAt}]`);
  if (sectionPath) parts.push(`[Section: ${sectionPath}]`);
  return truncateToTokens(parts.join(' '), RAG_V2_PREFIX_BUDGET_TOKENS);
}

async function loadSourceTextFromR2(env: Env, r2Key: string | null | undefined): Promise<string> {
  if (!r2Key) return '';
  const obj = await env.R2.get(r2Key);
  return obj ? obj.text() : '';
}

async function loadRagV2Source(payload: RagV2ReindexPayload, orgId: string, env: Env): Promise<RagV2Source | null> {
  if (payload.source_table === 'conversations') {
    const row = await env.D1.prepare(
      `SELECT id, source, subject, body_r2_key, body_preview, sent_at,
              participant_user_ids, from_contact_id
         FROM conversations
        WHERE id = ? AND org_id = ?`
    ).bind(payload.source_id, orgId).first<{
      id: string; source: string; subject: string | null; body_r2_key: string | null;
      body_preview: string | null; sent_at: string | null; participant_user_ids: string | null;
      from_contact_id: string | null;
    }>();
    if (!row) return null;
    const text = (await loadSourceTextFromR2(env, row.body_r2_key)) || row.body_preview || '';
    const documentType = row.source === 'manual' ? 'transcript' : row.source === 'slack' ? 'conversation' : 'email';
    return {
      orgId,
      sourceTable: 'conversations',
      sourceId: row.id,
      sourceFamily: sourceFamilyForRagV2(documentType),
      documentType,
      title: row.subject || documentType,
      text,
      sourceCreatedAt: row.sent_at || new Date().toISOString(),
      visibility: row.source === 'manual' ? 'org_wide' : 'private',
      aclMode: 'source_authoritative',
      participantUserIds: compactParticipantIds(row.participant_user_ids),
      primaryEntityId: row.from_contact_id || row.id,
      entityNames: row.subject || undefined,
    };
  }

  if (payload.source_table === 'events') {
    const row = await env.D1.prepare(
      `SELECT id, title, summary, transcript_r2_key, start_time
         FROM events
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(payload.source_id, orgId).first<{
      id: string; title: string; summary: string | null; transcript_r2_key: string | null; start_time: string;
    }>();
    if (!row) return null;
    const transcript = await loadSourceTextFromR2(env, row.transcript_r2_key);
    const text = transcript || [row.title, row.summary].filter(Boolean).join('\n\n');
    const attendees = await env.D1.prepare(
      `SELECT user_id FROM event_attendees WHERE event_id = ? AND user_id IS NOT NULL`
    ).bind(row.id).all<{ user_id: string }>();
    const participantUserIds = attendees.results.map(r => r.user_id).filter(Boolean).join(',') || undefined;
    return {
      orgId,
      sourceTable: 'events',
      sourceId: row.id,
      sourceFamily: 'transcripts',
      documentType: 'transcript',
      title: row.title,
      text,
      sourceCreatedAt: row.start_time,
      visibility: transcript && participantUserIds ? 'private' : 'org_wide',
      aclMode: 'source_authoritative',
      participantUserIds,
      primaryEntityId: row.id,
      entityNames: row.title,
    };
  }

  if (payload.source_table === 'documents') {
    const row = await env.D1.prepare(
      `SELECT id, title, document_type, r2_key, extracted_text_preview, created_at,
              contact_id, company_id, deal_id, visibility, participant_user_ids, uploaded_by,
              custom_fields
         FROM documents
        WHERE id = ?
          AND org_id = ?
          AND deleted_at IS NULL
          AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1`
    ).bind(payload.source_id, orgId).first<{
      id: string; title: string; document_type: string; r2_key: string | null;
      extracted_text_preview: string | null; created_at: string; contact_id: string | null;
      company_id: string | null; deal_id: string | null; visibility: any; participant_user_ids: string | null;
      uploaded_by: string | null; custom_fields: string | null;
    }>();
    if (!row) return null;
    let text = row.extracted_text_preview || '';
    if (row.r2_key) {
      try {
        const { extractTextFromFile } = await import('./file-extraction');
        const obj = await env.R2.get(row.r2_key);
        if (obj) {
          const buffer = await obj.arrayBuffer();
          text = await extractTextFromFile(new File([buffer], row.title, { type: '' }));
        }
      } catch {
        // Keep the preview fallback. Full extraction can fail for binary docs.
      }
    }
    const documentType = row.document_type || 'document';
    return {
      orgId,
      sourceTable: 'documents',
      sourceId: row.id,
      sourceFamily: sourceFamilyForRagV2(documentType),
      documentType,
      title: row.title,
      text,
      sourceCreatedAt: row.created_at,
      visibility: row.visibility || 'private',
      aclMode: 'source_authoritative',
      participantUserIds: compactParticipantIds(row.participant_user_ids),
      uploadedBy: row.uploaded_by,
      primaryEntityId: row.contact_id || row.company_id || row.deal_id || row.id,
      secondaryEntityIds: [row.contact_id, row.company_id, row.deal_id].filter(Boolean).join(',') || undefined,
      entityNames: row.title,
    };
  }

  if (payload.source_table === 'contacts') {
    const row = await env.D1.prepare(
      `SELECT c.id, c.full_name, c.email, c.job_title, c.bio_summary, c.company_id, co.name AS company_name
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = ? AND c.org_id = ? AND c.deleted_at IS NULL`
    ).bind(payload.source_id, orgId).first<any>();
    if (!row || !row.bio_summary) return null;
    return {
      orgId,
      sourceTable: 'contacts',
      sourceId: row.id,
      sourceFamily: 'entity_context',
      documentType: 'enrichment',
      title: row.full_name,
      text: [row.full_name, row.email, row.job_title, row.company_name, row.bio_summary].filter(Boolean).join('\n'),
      sourceCreatedAt: new Date().toISOString(),
      visibility: 'org_wide',
      aclMode: 'metadata',
      primaryEntityId: row.id,
      secondaryEntityIds: row.company_id || undefined,
      entityNames: [row.full_name, row.company_name].filter(Boolean).join(', '),
    };
  }

  if (payload.source_table === 'companies') {
    const row = await env.D1.prepare(
      `SELECT id, name, sector, description, created_at
         FROM companies
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
    ).bind(payload.source_id, orgId).first<any>();
    if (!row || !row.description) return null;
    return {
      orgId,
      sourceTable: 'companies',
      sourceId: row.id,
      sourceFamily: 'entity_context',
      documentType: 'enrichment',
      title: row.name,
      text: [row.name, row.sector ? `Sector: ${row.sector}` : '', row.description].filter(Boolean).join('\n\n'),
      sourceCreatedAt: row.created_at || new Date().toISOString(),
      visibility: 'org_wide',
      aclMode: 'metadata',
      primaryEntityId: row.id,
      entityNames: row.name,
    };
  }

  if (payload.source_table === 'deals') {
    const row = await env.D1.prepare(
      `SELECT d.id, d.title, d.stage, d.amount, d.valuation, d.our_allocation,
              d.instrument_type, d.lead_source, d.thesis_fit, d.notes, d.expected_close,
              d.company_id, d.created_at, co.name AS company_name, co.sector, co.description
         FROM deals d
         LEFT JOIN companies co ON co.id = d.company_id
        WHERE d.id = ? AND d.org_id = ? AND d.deleted_at IS NULL`
    ).bind(payload.source_id, orgId).first<any>();
    if (!row) return null;
    const text = [
      `Deal: ${row.title || 'Untitled'}`,
      row.company_name ? `Company: ${row.company_name}` : '',
      row.sector ? `Sector: ${row.sector}` : '',
      row.description ? `Company description: ${row.description}` : '',
      row.stage ? `Stage: ${row.stage}` : '',
      row.amount ? `Round size: ${row.amount}` : '',
      row.valuation ? `Valuation: ${row.valuation}` : '',
      row.our_allocation ? `Our allocation: ${row.our_allocation}` : '',
      row.instrument_type ? `Instrument: ${row.instrument_type}` : '',
      row.lead_source ? `Lead source: ${row.lead_source}` : '',
      row.thesis_fit ? `Thesis fit: ${row.thesis_fit}` : '',
      row.notes ? `Notes: ${row.notes}` : '',
      row.expected_close ? `Expected close: ${row.expected_close}` : '',
    ].filter(Boolean).join('\n');
    return {
      orgId,
      sourceTable: 'deals',
      sourceId: row.id,
      sourceFamily: 'deal_records',
      documentType: 'deal_record',
      title: row.title || 'Untitled deal',
      text,
      sourceCreatedAt: row.created_at || new Date().toISOString(),
      visibility: 'org_wide',
      aclMode: 'metadata',
      primaryEntityId: row.company_id || row.id,
      entityNames: [row.title, row.company_name].filter(Boolean).join(', '),
    };
  }

  if (payload.source_table === 'news_articles') {
    const row = await env.D1.prepare(
      `SELECT id, company_id, title, source_name, published_at, summary, relevance_tag, sector
         FROM news_articles
        WHERE id = ? AND org_id = ? AND quality_status = 'usable'`
    ).bind(payload.source_id, orgId).first<any>();
    if (!row) return null;
    return {
      orgId,
      sourceTable: 'news_articles',
      sourceId: row.id,
      sourceFamily: 'news',
      documentType: 'news',
      title: row.title,
      text: [row.title, row.source_name, row.relevance_tag, row.sector, row.summary].filter(Boolean).join('\n\n'),
      sourceCreatedAt: row.published_at || new Date().toISOString(),
      visibility: 'org_wide',
      aclMode: 'metadata',
      primaryEntityId: row.company_id || row.id,
      entityNames: row.title,
    };
  }

  return null;
}

export async function getRagV2RuntimeConfig(env: Env, orgId: string): Promise<RagV2RuntimeConfig> {
  const envVersion = (env.RAG_RETRIEVAL_VERSION || '').toLowerCase();
  const envProfile = getEmbeddingProfile(env.RAG_EMBEDDING_PROFILE).id;
  try {
    const row = await env.D1.prepare(
      `SELECT retrieval_version, embedding_profile, shadow_enabled
         FROM rag_retrieval_config WHERE org_id = ?`
    ).bind(orgId).first<{ retrieval_version: string; embedding_profile: string; shadow_enabled: number }>();
    if (row) {
      const version = row.retrieval_version === 'v2' || row.retrieval_version === 'shadow' ? row.retrieval_version : 'v1';
      return {
        retrievalVersion: envVersion === 'v2' || envVersion === 'shadow' ? envVersion : version,
        embeddingProfile: getEmbeddingProfile(row.embedding_profile || envProfile).id,
        shadowEnabled: row.shadow_enabled === 1 || envVersion === 'shadow',
      };
    }
  } catch {
    // Migration may not be applied yet; fall back to env-only config.
  }
  return {
    retrievalVersion: envVersion === 'v2' || envVersion === 'shadow' ? envVersion : 'v1',
    embeddingProfile: envProfile,
    shadowEnabled: envVersion === 'shadow',
  };
}

export async function getRagV2SourceHash(
  env: Env,
  orgId: string,
  payload: Pick<RagV2ReindexPayload, 'source_table' | 'source_id'>
): Promise<{
  source: RagV2Source | null;
  sourceHash: string | null;
  reason?: string;
}> {
  const source = await loadRagV2Source(payload as RagV2ReindexPayload, orgId, env);
  if (!source) return { source: null, sourceHash: null, reason: 'source_not_found' };
  if (!source.text || source.text.trim().length < 10) {
    return { source, sourceHash: null, reason: 'source_text_too_short' };
  }
  return { source, sourceHash: await sha256Short(source.text, 32) };
}

export async function enqueueRagV2SourceReindex(
  env: Env,
  orgId: string,
  sourceTable: RagV2SourceTable,
  sourceId: string,
  options: {
    profiles?: EmbeddingProfileId[];
    priority?: number;
    maxAttempts?: number;
  } = {}
): Promise<RagV2EnqueueResult> {
  const profiles = options.profiles?.length ? options.profiles : [DEFAULT_RAG_V2_EMBEDDING_PROFILE];
  const { source, sourceHash, reason } = await getRagV2SourceHash(env, orgId, {
    source_table: sourceTable,
    source_id: sourceId,
  });
  if (!source || !sourceHash) {
    if (source && reason === 'source_text_too_short') {
      await markRagV2SourceSkipped(env, orgId, source, reason, profiles[0]);
    }
    return {
      status: reason === 'source_not_found' ? 'missing' : 'skipped',
      source_table: sourceTable,
      source_id: sourceId,
      source_family: source?.sourceFamily,
      source_created_at: source?.sourceCreatedAt,
      reason,
    };
  }

  const idempotencyKey = [
    orgId,
    sourceTable,
    sourceId,
    sourceHash,
    profiles.join('+'),
    RAG_V2_CHUNK_VERSION,
  ].join(':');
  const result = await enqueueWork(env, orgId, RAG_V2_WORK_QUEUE_DOMAIN, {
    source_table: sourceTable,
    source_id: sourceId,
    profiles,
  } satisfies RagV2ReindexPayload, {
    upstream: 'bge',
    idempotency_key: idempotencyKey,
    max_attempts: options.maxAttempts ?? 5,
    priority: options.priority ?? (source.sourceFamily === 'slack' ? 30 : 10),
  });

  return {
    status: result.inserted ? 'enqueued' : 'already_queued',
    source_table: sourceTable,
    source_id: sourceId,
    source_family: source.sourceFamily,
    source_created_at: source.sourceCreatedAt,
    source_hash: sourceHash,
    work_queue_id: result.id,
    idempotency_key: idempotencyKey,
  };
}

function ragV2CompletionPredicate(alias: string, vectorCountColumn: string): string {
  return `${alias}.backfill_status = 'completed'
    AND ${alias}.chunk_count > 0
    AND ${alias}.lexical_count >= ${alias}.chunk_count
    AND ${alias}.${vectorCountColumn} >= ${alias}.chunk_count`;
}

async function markRagV2SourceSkipped(
  env: Env,
  orgId: string,
  source: RagV2Source,
  reason: string,
  profileId: EmbeddingProfileId = DEFAULT_RAG_V2_EMBEDDING_PROFILE
): Promise<void> {
  const sourceHash = await sha256Short(source.text || `${source.sourceTable}:${source.sourceId}:skipped`, 32);
  await env.D1.prepare(
    `INSERT INTO rag_source_index_state
       (org_id, source_table, source_id, source_hash, selected_embedding_profile,
        chunk_count, vectorized_bge_count, vectorized_qwen3_count, vectorized_minilm_count,
        lexical_count, backfill_status, last_error, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'skipped', ?,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(org_id, source_table, source_id) DO UPDATE SET
       source_hash = excluded.source_hash,
       selected_embedding_profile = excluded.selected_embedding_profile,
       chunk_count = 0,
       vectorized_bge_count = 0,
       vectorized_qwen3_count = 0,
       vectorized_minilm_count = 0,
       lexical_count = 0,
       backfill_status = 'skipped',
       last_error = excluded.last_error,
       completed_at = excluded.completed_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    orgId,
    source.sourceTable,
    source.sourceId,
    sourceHash,
    profileId,
    reason
  ).run();
}

async function getRagV2QueueCounts(
  env: Env,
  orgId: string
): Promise<Record<string, number>> {
  const rows = await env.D1.prepare(
    `SELECT status, COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ? AND domain = ?
      GROUP BY status`
  ).bind(orgId, RAG_V2_WORK_QUEUE_DOMAIN).all<{ status: string; count: number }>();
  const counts: Record<string, number> = {};
  for (const row of rows.results || []) counts[row.status] = Number(row.count || 0);
  return counts;
}

async function getRagV2FreshnessForSpec(
  env: Env,
  orgId: string,
  spec: RagV2SourceSpec,
  profileId: EmbeddingProfileId,
  queueCounts: Record<string, number>
): Promise<RagV2FreshnessRow> {
  const vectorCountColumn = vectorCountColumnForProfile(profileId);
  const complete = ragV2CompletionPredicate('s', vectorCountColumn);
  const row = await env.D1.prepare(
    `WITH src AS (${spec.sourceSql})
     SELECT
       COUNT(*) AS total_sources,
       SUM(CASE WHEN ${complete} THEN 1 ELSE 0 END) AS indexed_sources,
       SUM(CASE WHEN s.source_id IS NULL THEN 1 ELSE 0 END) AS missing_sources,
       SUM(CASE WHEN s.backfill_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_sources,
       SUM(CASE WHEN s.source_id IS NOT NULL AND s.backfill_status != 'skipped' AND NOT (${complete}) THEN 1 ELSE 0 END) AS incomplete_sources,
       MAX(src.source_created_at) AS latest_source_at,
       MAX(CASE WHEN ${complete} THEN src.source_created_at ELSE NULL END) AS latest_indexed_source_at
      FROM src
      LEFT JOIN rag_source_index_state s
        ON s.org_id = ?
       AND s.source_table = ?
       AND s.source_id = src.id`
  ).bind(orgId, orgId, spec.sourceTable).first<{
    total_sources: number | null;
    indexed_sources: number | null;
    missing_sources: number | null;
    incomplete_sources: number | null;
    skipped_sources: number | null;
    latest_source_at: string | null;
    latest_indexed_source_at: string | null;
  }>();

  const latestSource = row?.latest_source_at || null;
  const latestIndexed = row?.latest_indexed_source_at || null;
  const sourceMs = latestSource ? Date.parse(latestSource) : NaN;
  const indexedMs = latestIndexed ? Date.parse(latestIndexed) : NaN;
  const freshnessLagMs = Number.isFinite(sourceMs)
    ? Number.isFinite(indexedMs) ? Math.max(0, sourceMs - indexedMs) : null
    : null;

  return {
    source_family: spec.sourceFamily,
    source_table: spec.sourceTable,
    total_sources: Number(row?.total_sources || 0),
    indexed_sources: Number(row?.indexed_sources || 0),
    missing_sources: Number(row?.missing_sources || 0),
    incomplete_sources: Number(row?.incomplete_sources || 0),
    skipped_sources: Number(row?.skipped_sources || 0),
    latest_source_at: latestSource,
    latest_indexed_source_at: latestIndexed,
    freshness_lag_ms: freshnessLagMs,
    queue_pending: queueCounts.pending || 0,
    queue_in_progress: queueCounts.in_progress || 0,
    queue_failed: queueCounts.failed || 0,
    queue_dead_letter: queueCounts.dead_letter || 0,
  };
}

export async function getRagV2FreshnessSummary(
  env: Env,
  orgId: string,
  options: {
    profile?: EmbeddingProfileId;
    sourceTables?: RagV2SourceTable[];
    sourceFamilies?: string[];
  } = {}
): Promise<RagV2FreshnessRow[]> {
  const profileId = options.profile || (await getRagV2RuntimeConfig(env, orgId)).embeddingProfile;
  const queueCounts = await getRagV2QueueCounts(env, orgId).catch(() => ({}));
  const specs = specsForRagV2Coverage(options);
  const rows: RagV2FreshnessRow[] = [];
  for (const spec of specs) {
    rows.push(await getRagV2FreshnessForSpec(env, orgId, spec, profileId, queueCounts));
  }
  return rows;
}

export async function getRagV2SourceFreshness(
  env: Env,
  orgId: string,
  sourceFamily: string,
  options: { profile?: EmbeddingProfileId; sourceTable?: RagV2SourceTable } = {}
): Promise<RagV2FreshnessRow | null> {
  const rows = await getRagV2FreshnessSummary(env, orgId, {
    profile: options.profile,
    sourceFamilies: [sourceFamily],
    sourceTables: options.sourceTable ? [options.sourceTable] : undefined,
  });
  return rows[0] || null;
}

export async function scanAndRepairRagV2Coverage(
  env: Env,
  orgId: string,
  options: {
    sourceTables?: RagV2SourceTable[];
    sourceFamilies?: string[];
    profiles?: EmbeddingProfileId[];
    limitPerSpec?: number;
    priority?: number;
  } = {}
): Promise<RagV2CoverageRepairResult> {
  const profiles = options.profiles?.length
    ? options.profiles
    : [(await getRagV2RuntimeConfig(env, orgId)).embeddingProfile];
  const profile = profiles[0];
  const vectorCountColumn = vectorCountColumnForProfile(profile);
  const specs = specsForRagV2Coverage(options);
  const limit = Math.max(1, Math.min(options.limitPerSpec ?? 50, 250));
  const errors: string[] = [];
  let scanned = 0;
  let candidates = 0;
  let enqueued = 0;
  let alreadyQueued = 0;
  let skipped = 0;
  let missing = 0;

  for (const spec of specs) {
    const complete = ragV2CompletionPredicate('s', vectorCountColumn);
    const rows = await env.D1.prepare(
      `WITH src AS (${spec.sourceSql})
       SELECT src.id
         FROM src
         LEFT JOIN rag_source_index_state s
           ON s.org_id = ?
          AND s.source_table = ?
          AND s.source_id = src.id
        WHERE s.source_id IS NULL
           OR (s.backfill_status != 'skipped' AND NOT (${complete}))
        ORDER BY src.source_created_at DESC
        LIMIT ?`
    ).bind(orgId, orgId, spec.sourceTable, limit).all<{ id: string }>();

    scanned += limit;
    candidates += rows.results.length;
    for (const row of rows.results) {
      try {
        const result = await enqueueRagV2SourceReindex(env, orgId, spec.sourceTable, row.id, {
          profiles,
          priority: options.priority ?? (spec.sourceFamily === 'slack' ? 30 : 10),
          maxAttempts: 6,
        });
        if (result.status === 'enqueued') enqueued++;
        else if (result.status === 'already_queued') alreadyQueued++;
        else if (result.status === 'missing') missing++;
        else skipped++;
      } catch (e) {
        errors.push(`${spec.sourceTable}:${row.id}:${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
      }
    }
  }

  const freshness = await getRagV2FreshnessSummary(env, orgId, {
    profile,
    sourceTables: options.sourceTables,
    sourceFamilies: options.sourceFamilies,
  }).catch((e) => {
    errors.push(`freshness:${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    return [] as RagV2FreshnessRow[];
  });

  return {
    scanned,
    candidates,
    enqueued,
    already_queued: alreadyQueued,
    skipped,
    missing,
    errors,
    freshness,
  };
}

function recordToVectorMatch(record: RagChunkRecord, vectorId: string, score: number): VectorMatch {
  return {
    id: vectorId,
    score,
    metadata: {
      org_id: record.org_id,
      visibility: record.visibility as any,
      participant_user_ids: record.participant_user_ids || undefined,
      user_id: record.uploaded_by || undefined,
      document_type: record.document_type,
      source_table: record.source_table,
      source_id: record.source_id,
      r2_key: record.text_r2_key,
      chunk_index: record.chunk_index,
      total_chunks: record.total_chunks,
      primary_entity_id: record.primary_entity_id,
      secondary_entity_ids: record.secondary_entity_ids || undefined,
      text_preview: record.text_preview || undefined,
      embedding_model: record.vector_id_bge === vectorId ? 'bge-base-en-v1.5:cls:v3' : undefined,
      chunk_config_version: record.chunk_config_version,
      entity_name: record.entity_names || record.title || undefined,
      created_at: record.source_created_at || undefined,
      source_family: record.source_family,
      acl_mode: record.acl_mode,
      rag_chunk_id: record.id,
    },
  };
}

export async function hydrateRagV2Matches(
  matches: VectorMatch[],
  env: Env
): Promise<{ chunks: HydratedChunk[]; summary: { kv: number; r2_chunk: number; preview_fallback: number } }> {
  const summary = { kv: 0, r2_chunk: 0, preview_fallback: 0 };
  const chunks = await Promise.all(matches.map(async match => {
    const kvKey = `chunk:${match.id}`;
    const kv = await env.KV.get(kvKey);
    if (kv) {
      summary.kv++;
      return { ...match, hydrated_text: kv, hydration_source: 'kv' as const };
    }
    const r2Key = match.metadata.r2_key;
    if (r2Key) {
      const obj = await env.R2.get(String(r2Key));
      if (obj) {
        const text = await obj.text();
        await env.KV.put(kvKey, text, { expirationTtl: 7776000 }).catch(() => {});
        summary.r2_chunk++;
        return { ...match, hydrated_text: text, hydration_source: 'r2_rechunk' as const };
      }
    }
    summary.preview_fallback++;
    return {
      ...match,
      hydrated_text: String(match.metadata.text_preview || ''),
      hydration_source: 'preview_fallback' as const,
    };
  }));
  return { chunks, summary };
}

export function fuseHybridCandidates(
  dense: DenseCandidate[],
  lexical: LexicalCandidate[],
  weights: { denseBroad?: number; denseEntity?: number; denseTargeted?: number; lexical?: number } = {}
): HybridCandidate[] {
  const byChunk = new Map<string, HybridCandidate>();
  const add = (
    chunkId: string,
    source: HybridCandidate['sources'][number],
    rank: number,
    score: number,
    weight: number,
    kind: 'dense' | 'lexical'
  ) => {
    const existing = byChunk.get(chunkId) || {
      chunkId,
      score: 0,
      sources: [],
    };
    existing.score += weight * (1 / (RRF_K + rank));
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (kind === 'dense') {
      existing.denseScore = Math.max(existing.denseScore || 0, score);
      existing.denseRank = Math.min(existing.denseRank || rank, rank);
    } else {
      existing.lexicalScore = Math.max(existing.lexicalScore || 0, score);
      existing.lexicalRank = Math.min(existing.lexicalRank || rank, rank);
    }
    byChunk.set(chunkId, existing);
  };

  for (const candidate of dense) {
    add(
      candidate.chunkId,
      candidate.source,
      candidate.rank,
      candidate.score,
      candidate.source === 'vectorize_targeted'
        ? weights.denseTargeted ?? 1.5
        : candidate.source === 'vectorize_entity'
          ? weights.denseEntity ?? 1.2
          : weights.denseBroad ?? 1.0,
      'dense'
    );
  }
  for (const candidate of lexical) {
    add(
      candidate.chunkId,
      candidate.source,
      candidate.rank,
      candidate.score + (candidate.exactBoost || 0),
      weights.lexical ?? 1.0,
      'lexical'
    );
  }

  return [...byChunk.values()].sort((a, b) => b.score - a.score);
}

export function applySourceDiversity(candidates: HybridCandidate[], limit: number): HybridCandidate[] {
  const selected: HybridCandidate[] = [];
  const bySource = new Map<string, number>();
  const overflow: HybridCandidate[] = [];

  for (const candidate of candidates) {
    const sourceKey = candidate.chunkId.split('_c')[0] || candidate.chunkId;
    const count = bySource.get(sourceKey) || 0;
    if (count < MAX_SOURCE_CHUNKS_BEFORE_RERANK) {
      selected.push(candidate);
      bySource.set(sourceKey, count + 1);
    } else {
      overflow.push(candidate);
    }
    if (selected.length >= limit) break;
  }
  for (const candidate of overflow) {
    if (selected.length >= limit) break;
    selected.push(candidate);
  }
  return selected.slice(0, limit);
}

export async function fetchRagV2ChunkRecords(
  env: Env,
  profileId: EmbeddingProfileId,
  candidates: HybridCandidate[]
): Promise<Map<string, { record: RagChunkRecord; vectorId: string }>> {
  if (candidates.length === 0) return new Map();
  const profile = getEmbeddingProfile(profileId);
  const ids = candidates.map(c => c.chunkId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.D1.prepare(
    `SELECT * FROM rag_chunks_v2 WHERE id IN (${placeholders})`
  ).bind(...ids).all<RagChunkRecord>();

  const result = new Map<string, { record: RagChunkRecord; vectorId: string }>();
  for (const row of rows.results) {
    const vectorId = (row as any)[profile.vectorColumn] as string | null;
    if (vectorId) result.set(row.id, { record: row, vectorId });
  }
  return result;
}

export async function queryDenseRagV2Candidates(
  env: Env,
  orgId: string,
  queryEmbedding: number[],
  profileId: EmbeddingProfileId,
  entityIds: string[],
  options: {
    entityLimit?: number;
    entityTopK?: number;
    broadTopK?: number;
    targetedTopK?: number;
    documentTypes?: string[];
    sourceFamilies?: string[];
  } = {}
): Promise<DenseCandidate[]> {
  const index = getVectorBinding(env, profileId);
  if (!index) return [];
  const scopedDocumentTypes = Array.from(new Set((options.documentTypes || []).filter(Boolean)));
  const scopedSourceFamilies = Array.from(new Set((options.sourceFamilies || []).filter(Boolean)));
  const hasScopedFilter = scopedDocumentTypes.length > 0 || scopedSourceFamilies.length > 0;
  const filter = { org_id: orgId } as any;
  if (scopedDocumentTypes.length === 1) filter.document_type = scopedDocumentTypes[0];
  else if (scopedDocumentTypes.length > 1) filter.document_type = { $in: scopedDocumentTypes };
  else filter.document_type = { $nin: ['news'] };
  if (scopedSourceFamilies.length === 1) filter.source_family = scopedSourceFamilies[0];
  else if (scopedSourceFamilies.length > 1) filter.source_family = { $in: scopedSourceFamilies };
  const broadTopK = Math.max(1, Math.min(options.broadTopK ?? 100, 100));
  const targetedTopK = Math.max(1, Math.min(options.targetedTopK ?? broadTopK, 100));
  const entityTopK = Math.max(1, Math.min(options.entityTopK ?? 50, 50));
  const entityLimit = Math.max(0, options.entityLimit ?? 10);

  const results = await Promise.all([
    index.query(queryEmbedding, {
      topK: hasScopedFilter ? targetedTopK : broadTopK,
      filter,
      returnValues: false,
      returnMetadata: 'indexed',
    } as any),
    ...entityIds.slice(0, entityLimit).map(entityId =>
      index.query(queryEmbedding, {
        topK: entityTopK,
        filter: { ...filter, primary_entity_id: entityId },
        returnValues: false,
        returnMetadata: 'indexed',
      } as any)
    ),
  ]);

  const candidates: DenseCandidate[] = [];
  const add = (matches: any[], source: DenseCandidate['source']) => {
    matches.forEach((match, index) => {
      const chunkId = String(match.metadata?.rag_chunk_id || '');
      if (!chunkId) return;
      candidates.push({
        chunkId,
        vectorId: String(match.id),
        score: Number(match.score || 0),
        rank: index + 1,
        source,
      });
    });
  };
  add(results[0]?.matches || [], hasScopedFilter ? 'vectorize_targeted' : 'vectorize_broad');
  for (const result of results.slice(1)) add(result?.matches || [], 'vectorize_entity');
  return candidates;
}

export async function queryDenseRagV2NewsCandidates(
  env: Env,
  orgId: string,
  queryEmbedding: number[],
  profileId: EmbeddingProfileId,
  topK = 20
): Promise<DenseCandidate[]> {
  const index = getVectorBinding(env, profileId);
  if (!index) return [];
  const result = await index.query(queryEmbedding, {
    topK: Math.max(1, Math.min(topK, 50)),
    filter: { org_id: orgId, document_type: 'news' },
    returnValues: false,
    returnMetadata: 'indexed',
  } as any);

  const candidates: DenseCandidate[] = [];
  ((result.matches || []) as any[]).forEach((match, index) => {
    const chunkId = String(match.metadata?.rag_chunk_id || '');
    if (!chunkId) return;
    candidates.push({
      chunkId,
      vectorId: String(match.id),
      score: Number(match.score || 0),
      rank: index + 1,
      source: 'vectorize_broad',
    });
  });
  return candidates;
}

export async function buildRagV2VectorMatches(
  env: Env,
  profileId: EmbeddingProfileId,
  fused: HybridCandidate[]
): Promise<VectorMatch[]> {
  const records = await fetchRagV2ChunkRecords(env, profileId, fused);
  const matches: VectorMatch[] = [];
  for (const candidate of fused) {
    const item = records.get(candidate.chunkId);
    if (!item) continue;
    matches.push(recordToVectorMatch(item.record, item.vectorId, candidate.score));
  }
  return matches;
}

export async function persistRagV2Trace(
  env: Env,
  args: {
    orgId: string;
    userId?: string;
    sessionId?: string;
    turnIndex?: number;
    query: string;
    embeddingProfile: EmbeddingProfileId;
    denseCount: number;
    lexicalCount: number;
    fusedCount: number;
    aclAllowedCount: number;
    rerankerInputCount: number;
    rerankerOutputCount: number;
    hydrationSummary?: unknown;
    topCandidates?: unknown;
    latencies?: Partial<Record<'dense' | 'lexical' | 'fusion' | 'hydration' | 'rerank' | 'total', number>>;
    status?: 'success' | 'fallback' | 'failed' | 'shadow';
    error?: string;
  }
): Promise<void> {
  try {
    await env.D1.prepare(
      `INSERT INTO rag_retrieval_traces_v2
         (org_id, user_id, session_id, turn_index, query, embedding_profile,
          dense_count, lexical_count, fused_count, acl_allowed_count,
          reranker_input_count, reranker_output_count, hydration_summary,
          top_candidates_json, latency_dense_ms, latency_lexical_ms,
          latency_fusion_ms, latency_hydration_ms, latency_rerank_ms,
          latency_total_ms, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      args.orgId,
      args.userId || null,
      args.sessionId || null,
      args.turnIndex ?? null,
      args.query,
      args.embeddingProfile,
      args.denseCount,
      args.lexicalCount,
      args.fusedCount,
      args.aclAllowedCount,
      args.rerankerInputCount,
      args.rerankerOutputCount,
      args.hydrationSummary ? JSON.stringify(args.hydrationSummary) : null,
      args.topCandidates ? JSON.stringify(args.topCandidates).slice(0, 8000) : null,
      args.latencies?.dense ?? null,
      args.latencies?.lexical ?? null,
      args.latencies?.fusion ?? null,
      args.latencies?.hydration ?? null,
      args.latencies?.rerank ?? null,
      args.latencies?.total ?? null,
      args.status || 'success',
      args.error || null
    ).run();
  } catch {
    // Trace writes must never break answer generation.
  }
}

// opensearch_status is deliberately ABSENT from the ON CONFLICT update
// list: chunk ids are content-addressed, so a same-id re-upsert carries
// identical searchable content and the prior lexical state must stick.
// Resetting it to 'pending' here defeated the FTS delete gate in
// upsertRagChunksD1Fts and duplicated FTS rows (audit 2026-07-07 F1).
// Status transitions happen only via the FTS batch / markLexicalStatuses.
function upsertRagChunkRecordStatement(env: Env, record: RagChunkRecord): D1PreparedStatement {
  return env.D1.prepare(
    `INSERT INTO rag_chunks_v2
       (id, org_id, source_table, source_id, source_family, document_type,
        chunk_index, total_chunks, parent_chunk_id, previous_chunk_id,
        next_chunk_id, section_path, title, text_r2_key, kv_key, text_preview,
        content_hash, source_hash, primary_entity_id, secondary_entity_ids,
        entity_names, exact_terms, visibility, acl_mode, participant_user_ids,
        uploaded_by, source_created_at, created_at_epoch, chunk_config_version,
        lexical_doc_id, opensearch_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       total_chunks = excluded.total_chunks,
       previous_chunk_id = excluded.previous_chunk_id,
       next_chunk_id = excluded.next_chunk_id,
       section_path = excluded.section_path,
       title = excluded.title,
       text_r2_key = excluded.text_r2_key,
       kv_key = excluded.kv_key,
       text_preview = excluded.text_preview,
       content_hash = excluded.content_hash,
       source_hash = excluded.source_hash,
       primary_entity_id = excluded.primary_entity_id,
       secondary_entity_ids = excluded.secondary_entity_ids,
       entity_names = excluded.entity_names,
       exact_terms = excluded.exact_terms,
       visibility = excluded.visibility,
       acl_mode = excluded.acl_mode,
       participant_user_ids = excluded.participant_user_ids,
       uploaded_by = excluded.uploaded_by,
       source_created_at = excluded.source_created_at,
       created_at_epoch = excluded.created_at_epoch,
       chunk_config_version = excluded.chunk_config_version,
       lexical_doc_id = excluded.lexical_doc_id,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    record.id,
    record.org_id,
    record.source_table,
    record.source_id,
    record.source_family,
    record.document_type,
    record.chunk_index,
    record.total_chunks,
    record.parent_chunk_id,
    record.previous_chunk_id,
    record.next_chunk_id,
    record.section_path,
    record.title,
    record.text_r2_key,
    record.kv_key,
    record.text_preview,
    record.content_hash,
    record.source_hash,
    record.primary_entity_id,
    record.secondary_entity_ids,
    record.entity_names,
    record.exact_terms,
    record.visibility,
    record.acl_mode,
    record.participant_user_ids,
    record.uploaded_by,
    record.source_created_at,
    record.created_at_epoch,
    record.chunk_config_version,
    record.lexical_doc_id,
    record.opensearch_status
  );
}

async function upsertRagChunkRecord(env: Env, record: RagChunkRecord): Promise<void> {
  await upsertRagChunkRecordStatement(env, record).run();
}

async function upsertRagChunkRecords(env: Env, records: RagChunkRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 50) {
    await env.D1.batch(records.slice(i, i + 50).map(record => upsertRagChunkRecordStatement(env, record)));
  }
}

async function markVectorStatus(
  env: Env,
  chunkId: string,
  profileId: EmbeddingProfileId,
  vectorId: string | null,
  status: 'synced' | 'failed' | 'skipped',
  error?: string
): Promise<void> {
  const profile = getEmbeddingProfile(profileId);
  const vectorColumn = profile.vectorColumn;
  const statusColumn = profile.vectorStatusColumn;
  await env.D1.prepare(
    `UPDATE rag_chunks_v2
        SET ${vectorColumn} = ?, ${statusColumn} = ?, last_error = ?, indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(vectorId, status, error || null, chunkId).run();
}

async function markVectorStatuses(
  env: Env,
  updates: Array<{
    chunkId: string;
    profileId: EmbeddingProfileId;
    vectorId: string | null;
    status: 'synced' | 'failed' | 'skipped';
    error?: string;
  }>
): Promise<void> {
  for (let i = 0; i < updates.length; i += 100) {
    const statements = updates.slice(i, i + 100).map(update => {
      const profile = getEmbeddingProfile(update.profileId);
      return env.D1.prepare(
        `UPDATE rag_chunks_v2
            SET ${profile.vectorColumn} = ?, ${profile.vectorStatusColumn} = ?, last_error = ?, indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(update.vectorId, update.status, update.error || null, update.chunkId);
    });
    await env.D1.batch(statements);
  }
}

async function markLexicalStatuses(
  env: Env,
  chunkIds: string[],
  status: 'synced' | 'failed' | 'skipped',
  error?: string
): Promise<void> {
  for (let i = 0; i < chunkIds.length; i += 100) {
    const statements = chunkIds.slice(i, i + 100).map(chunkId =>
      env.D1.prepare(
        `UPDATE rag_chunks_v2
            SET opensearch_status = ?,
                last_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END,
                indexed_at = CASE WHEN ? = 'synced' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE indexed_at END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      ).bind(status, error || null, error || null, status, chunkId)
    );
    await env.D1.batch(statements);
  }
}

async function deleteObsoleteRagV2Chunks(
  env: Env,
  orgId: string,
  source: RagV2Source,
  sourceHash: string
): Promise<void> {
  const obsolete = await env.D1.prepare(
    `SELECT id, text_r2_key, kv_key, vector_id_bge, vector_id_qwen3, vector_id_minilm
       FROM rag_chunks_v2
      WHERE org_id = ? AND source_table = ? AND source_id = ?
        AND (source_hash != ? OR chunk_config_version != ?)`
  ).bind(orgId, source.sourceTable, source.sourceId, sourceHash, RAG_V2_CHUNK_VERSION)
    .all<{
      id: string;
      text_r2_key: string;
      kv_key: string | null;
      vector_id_bge: string | null;
      vector_id_qwen3: string | null;
      vector_id_minilm: string | null;
    }>();
  if (!obsolete.results.length) return;

  const vectorDeletes: Array<[EmbeddingProfileId, string[]]> = [
    ['bge-base-en-v1.5:cls:v3', obsolete.results.map(r => r.vector_id_bge).filter(Boolean) as string[]],
    ['qwen3-embedding-0.6b:v3', obsolete.results.map(r => r.vector_id_qwen3).filter(Boolean) as string[]],
    ['all-MiniLM-L6-v2:v3', obsolete.results.map(r => r.vector_id_minilm).filter(Boolean) as string[]],
  ];
  await Promise.all(vectorDeletes.map(async ([profileId, ids]) => {
    if (ids.length === 0) return;
    const index = getVectorBinding(env, profileId);
    if (!index) return;
    for (let i = 0; i < ids.length; i += 1000) {
      await index.deleteByIds(ids.slice(i, i + 1000)).catch(() => undefined);
    }
  }));

  await Promise.all(obsolete.results.flatMap(row => [
    row.text_r2_key ? env.R2.delete(row.text_r2_key).catch(() => undefined) : Promise.resolve(),
    row.kv_key ? env.KV.delete(row.kv_key).catch(() => undefined) : Promise.resolve(),
  ]));

  for (let i = 0; i < obsolete.results.length; i += 500) {
    const batch = obsolete.results.slice(i, i + 500);
    const placeholders = batch.map(() => '?').join(',');
    const ids = batch.map(r => r.id);
    await env.D1.batch([
      env.D1.prepare(`DELETE FROM rag_chunks_v2_fts WHERE chunk_id IN (${placeholders})`).bind(...ids),
      env.D1.prepare(`DELETE FROM rag_chunks_v2 WHERE id IN (${placeholders})`).bind(...ids),
    ]);
  }
}

function isRagV2RangePayload(payload: RagV2ReindexPayload): boolean {
  return Number.isInteger(payload.chunk_start) || Number.isInteger(payload.chunk_end);
}

function normalizeRagV2Range(payload: RagV2ReindexPayload, totalChunks: number): { start: number; end: number } {
  const start = Number.isInteger(payload.chunk_start)
    ? Math.max(0, Math.min(totalChunks, Number(payload.chunk_start)))
    : 0;
  const end = Number.isInteger(payload.chunk_end)
    ? Math.max(start, Math.min(totalChunks, Number(payload.chunk_end)))
    : totalChunks;
  return { start, end };
}

async function enqueueRagV2ChunkRangeJobs(
  env: Env,
  orgId: string,
  source: RagV2Source,
  sourceHash: string,
  totalChunks: number,
  profiles: EmbeddingProfileId[]
): Promise<number> {
  let enqueued = 0;
  for (let start = 0; start < totalChunks; start += RAG_V2_RANGE_CHUNK_SIZE) {
    const end = Math.min(totalChunks, start + RAG_V2_RANGE_CHUNK_SIZE);
    const result = await enqueueWork(env, orgId, RAG_V2_WORK_QUEUE_DOMAIN, {
      source_table: source.sourceTable,
      source_id: source.sourceId,
      profiles,
      chunk_start: start,
      chunk_end: end,
      parent_source_hash: sourceHash,
      expected_total_chunks: totalChunks,
    } satisfies RagV2ReindexPayload, {
      upstream: 'bge',
      idempotency_key: [
        orgId,
        source.sourceTable,
        source.sourceId,
        sourceHash,
        profiles.join('+'),
        `${start}-${end}`,
        RAG_V2_CHUNK_VERSION,
      ].join(':'),
      max_attempts: 5,
      priority: 20,
    });
    if (result.inserted) enqueued++;
  }
  return enqueued;
}

async function readRagV2SourceSyncCounts(
  env: Env,
  orgId: string,
  source: RagV2Source
): Promise<{ bge: number; qwen3: number; minilm: number; lexical: number }> {
  const row = await env.D1.prepare(
    `SELECT
       SUM(CASE WHEN vectorize_status_bge = 'synced' THEN 1 ELSE 0 END) AS bge,
       SUM(CASE WHEN vectorize_status_qwen3 = 'synced' THEN 1 ELSE 0 END) AS qwen3,
       SUM(CASE WHEN vectorize_status_minilm = 'synced' THEN 1 ELSE 0 END) AS minilm,
       (SELECT COUNT(*)
          FROM rag_chunks_v2_fts f
          JOIN rag_chunks_v2 c ON c.id = f.chunk_id
         WHERE c.org_id = ? AND c.source_table = ? AND c.source_id = ?) AS lexical
     FROM rag_chunks_v2
    WHERE org_id = ? AND source_table = ? AND source_id = ?`
  ).bind(
    orgId, source.sourceTable, source.sourceId,
    orgId, source.sourceTable, source.sourceId
  ).first<{ bge: number | null; qwen3: number | null; minilm: number | null; lexical: number | null }>();
  return {
    bge: Number(row?.bge || 0),
    qwen3: Number(row?.qwen3 || 0),
    minilm: Number(row?.minilm || 0),
    lexical: Number(row?.lexical || 0),
  };
}

function profilesFullySynced(
  profiles: EmbeddingProfileId[],
  counts: { bge: number; qwen3: number; minilm: number; lexical: number },
  totalChunks: number
): boolean {
  return profiles.every(profile => {
    if (profile === 'bge-base-en-v1.5:cls:v3') return counts.bge >= totalChunks;
    if (profile === 'qwen3-embedding-0.6b:v3') return counts.qwen3 >= totalChunks;
    if (profile === 'all-MiniLM-L6-v2:v3') return counts.minilm >= totalChunks;
    return false;
  });
}

export async function reindexRagV2Item(
  env: Env,
  orgId: string,
  payload: RagV2ReindexPayload
): Promise<RagV2ReindexResult> {
  const source = await loadRagV2Source(payload, orgId, env);
  const profiles = payload.profiles?.length ? payload.profiles : [DEFAULT_RAG_V2_EMBEDDING_PROFILE];
  const isRangeJob = isRagV2RangePayload(payload);
  if (!source) {
    return { status: 'missing', chunks: 0, profiles, lexical: 'skipped', errors: [] };
  }
  if (!source.text || source.text.trim().length < 10) {
    await markRagV2SourceSkipped(env, orgId, source, 'source_text_too_short', profiles[0]);
    return { status: 'skipped', chunks: 0, profiles, lexical: 'skipped', errors: [] };
  }

  const sourceHash = await sha256Short(source.text, 32);
  await env.D1.prepare(
    `INSERT INTO rag_source_index_state
       (org_id, source_table, source_id, source_hash, selected_embedding_profile, backfill_status, started_at)
     VALUES (?, ?, ?, ?, ?, 'in_progress', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(org_id, source_table, source_id) DO UPDATE SET
       source_hash = excluded.source_hash,
       selected_embedding_profile = excluded.selected_embedding_profile,
       backfill_status = 'in_progress',
       started_at = COALESCE(rag_source_index_state.started_at, excluded.started_at),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(orgId, source.sourceTable, source.sourceId, sourceHash, profiles[0]).run();

  if (!isRangeJob) {
    await deleteObsoleteRagV2Chunks(env, orgId, source, sourceHash);
  } else if (payload.parent_source_hash && payload.parent_source_hash !== sourceHash) {
    return {
      status: 'skipped',
      chunks: 0,
      profiles,
      lexical: 'skipped',
      errors: [`STALE_RAG_V2_RANGE_JOB expected=${payload.parent_source_hash} actual=${sourceHash}`],
    };
  }

  const profileForChunking = getEmbeddingProfile(profiles[0]);
  const chunks = chunkTextForRagV2(source.text, source.documentType, {
    version: RAG_V2_CHUNK_VERSION,
    embeddingProfileId: profileForChunking.id,
    maxContentTokens: profileForChunking.maxContentTokens,
    prefixBudgetTokens: RAG_V2_PREFIX_BUDGET_TOKENS,
  });
  if (!isRangeJob && chunks.length > MAX_RAG_V2_CHUNKS_PER_JOB) {
    const enqueued = await enqueueRagV2ChunkRangeJobs(env, orgId, source, sourceHash, chunks.length, profiles);
    await env.D1.prepare(
      `UPDATE rag_source_index_state
          SET chunk_count = ?,
              backfill_status = 'in_progress',
              last_error = ?,
              completed_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE org_id = ? AND source_table = ? AND source_id = ?`
    ).bind(
      chunks.length,
      `QUEUED_RAG_V2_CHUNK_RANGES ranges=${Math.ceil(chunks.length / RAG_V2_RANGE_CHUNK_SIZE)} inserted=${enqueued}`,
      orgId,
      source.sourceTable,
      source.sourceId
    ).run();
    return { status: 'queued', chunks: chunks.length, profiles, lexical: 'skipped', errors: [] };
  }
  if (chunks.length === 0) {
    return { status: 'skipped', chunks: 0, profiles, lexical: 'skipped', errors: [] };
  }

  const range = normalizeRagV2Range(payload, chunks.length);
  if (range.end <= range.start) {
    return { status: 'skipped', chunks: 0, profiles, lexical: 'skipped', errors: [] };
  }
  if (range.end - range.start > MAX_RAG_V2_CHUNKS_PER_JOB) {
    return {
      status: 'partial',
      chunks: 0,
      profiles,
      lexical: 'skipped',
      errors: [`RAG_V2_RANGE_TOO_LARGE start=${range.start} end=${range.end} max=${MAX_RAG_V2_CHUNKS_PER_JOB}`],
    };
  }

  const errors: string[] = [];
  const recordsForSearch: Array<RagChunkRecord & { body: string }> = [];
  const embeddingInputs: Array<{ chunkId: string; prefixed: string }> = [];

  for (let i = range.start; i < range.end; i++) {
    const chunk = chunks[i];
    const contentHash = await sha256Short(chunk.text, 24);
    const chunkId = `r2_${fnv1a(`${orgId}:${source.sourceTable}:${source.sourceId}:${i}:${contentHash}`)}_c${i}`;
    const previousChunkId = i > 0 ? `r2_${fnv1a(`${orgId}:${source.sourceTable}:${source.sourceId}:${i - 1}:${await sha256Short(chunks[i - 1].text, 24)}`)}_c${i - 1}` : null;
    const nextChunkId = i < chunks.length - 1 ? `r2_${fnv1a(`${orgId}:${source.sourceTable}:${source.sourceId}:${i + 1}:${await sha256Short(chunks[i + 1].text, 24)}`)}_c${i + 1}` : null;
    const textR2Key = `${orgId}/rag_v2/chunks/${source.sourceTable}/${source.sourceId}/${chunkId}.txt`;
    const prefixed = `${prefixRagV2Chunk(source, chunk.sectionPath)}\n${chunk.text}`;
    await Promise.all([
      env.R2.put(textR2Key, prefixed),
      env.KV.put(`ragv2:chunk:${chunkId}`, prefixed, { expirationTtl: 7776000 }).catch(() => undefined),
    ]);

    const record: RagChunkRecord = {
      id: chunkId,
      org_id: orgId,
      source_table: source.sourceTable,
      source_id: source.sourceId,
      source_family: source.sourceFamily,
      document_type: source.documentType,
      chunk_index: i,
      total_chunks: chunks.length,
      parent_chunk_id: null,
      previous_chunk_id: previousChunkId,
      next_chunk_id: nextChunkId,
      section_path: chunk.sectionPath || null,
      title: source.title,
      text_r2_key: textR2Key,
      kv_key: `ragv2:chunk:${chunkId}`,
      text_preview: prefixed.slice(0, 300),
      content_hash: contentHash,
      source_hash: sourceHash,
      primary_entity_id: source.primaryEntityId,
      secondary_entity_ids: source.secondaryEntityIds || null,
      entity_names: source.entityNames || source.title || null,
      exact_terms: chunk.exactTerms.join(' '),
      visibility: source.visibility,
      acl_mode: source.aclMode,
      participant_user_ids: source.participantUserIds || null,
      uploaded_by: source.uploadedBy || null,
      source_created_at: source.sourceCreatedAt,
      created_at_epoch: epochSeconds(source.sourceCreatedAt),
      chunk_config_version: RAG_V2_CHUNK_VERSION,
      vector_id_bge: null,
      vector_id_qwen3: null,
      vector_id_minilm: null,
      vectorize_status_bge: 'pending',
      vectorize_status_qwen3: 'pending',
      vectorize_status_minilm: 'pending',
      lexical_doc_id: chunkId,
      opensearch_status: 'pending',
      last_error: null,
    };
    recordsForSearch.push({ ...record, body: chunk.text });
    embeddingInputs.push({ chunkId, prefixed });
  }

  await upsertRagChunkRecords(env, recordsForSearch);

  for (const profileId of profiles) {
    const profile = getEmbeddingProfile(profileId);
    const index = getVectorBinding(env, profile.id);
    if (!index) {
      await markVectorStatuses(env, embeddingInputs.map(input => ({
        chunkId: input.chunkId,
        profileId: profile.id,
        vectorId: null,
        status: 'skipped',
        error: `${profile.vectorBinding}_NOT_BOUND`,
      })));
      continue;
    }

    for (let i = 0; i < embeddingInputs.length; i += RAG_V2_EMBEDDING_BATCH_SIZE) {
      const batch = embeddingInputs.slice(i, i + RAG_V2_EMBEDDING_BATCH_SIZE);
      try {
        const embeddingTexts = batch.map(input => truncateToTokens(input.prefixed, profile.maxInputTokens));
        const vectors = await runEmbeddingsForProfile(env, embeddingTexts, orgId, profile.id);
        if (vectors.length !== batch.length) {
          throw new Error(`EMBEDDING_BATCH_SIZE_MISMATCH expected=${batch.length} actual=${vectors.length}`);
        }
        const upserts = vectors.map((values, idx) => {
          const input = batch[idx];
          if (values.length !== profile.dimensions) {
            throw new Error(`EMBEDDING_DIMENSION_MISMATCH expected=${profile.dimensions} actual=${values.length}`);
          }
          return {
            id: vectorIdFor(profile.id, input.chunkId),
            values,
            metadata: {
              org_id: orgId,
              document_type: source.documentType,
              source_table: source.sourceTable,
              source_family: source.sourceFamily,
              primary_entity_id: source.primaryEntityId,
              visibility: source.visibility,
              created_at_epoch: epochSeconds(source.sourceCreatedAt) || 0,
              chunk_config_version: RAG_V2_CHUNK_VERSION,
              acl_mode: source.aclMode,
              rag_chunk_id: input.chunkId,
            },
          };
        });
        await index.upsert(upserts);
        await Promise.all(batch.map((input) => {
          const vectorId = vectorIdFor(profile.id, input.chunkId);
          return env.KV.put(`chunk:${vectorId}`, input.prefixed, { expirationTtl: 7776000 }).catch(() => undefined);
        }));
        await markVectorStatuses(env, batch.map(input => ({
          chunkId: input.chunkId,
          profileId: profile.id,
          vectorId: vectorIdFor(profile.id, input.chunkId),
          status: 'synced',
        })));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${profile.id}:batch_${i}:${msg}`);
        await markVectorStatuses(env, batch.map(input => ({
          chunkId: input.chunkId,
          profileId: profile.id,
          vectorId: vectorIdFor(profile.id, input.chunkId),
          status: 'failed',
          error: msg.slice(0, 1000),
        })));
      }
    }
  }

  let lexical: RagV2ReindexResult['lexical'] = 'skipped';
  try {
    const result = await upsertRagChunksD1Fts(env, recordsForSearch);
    lexical = result.errors.length === 0 ? 'synced' : 'failed';
    errors.push(...result.errors);
  } catch (e) {
    lexical = 'failed';
    errors.push(e instanceof Error ? e.message : String(e));
  }
  await markLexicalStatuses(
    env,
    recordsForSearch.map(record => record.id),
    lexical === 'synced' ? 'synced' : lexical === 'failed' ? 'failed' : 'skipped',
    lexical === 'failed' ? errors.slice(-3).join('\n') || 'lexical_sync_failed' : undefined
  );

  const counts = await readRagV2SourceSyncCounts(env, orgId, source);
  const sourceComplete =
    counts.lexical >= chunks.length &&
    profilesFullySynced(profiles, counts, chunks.length);
  const status = errors.length > 0 ? 'partial' : 'indexed';
  const sourceBackfillStatus =
    errors.length > 0 ? 'failed'
    : sourceComplete ? 'completed'
    : 'in_progress';
  await env.D1.prepare(
    `UPDATE rag_source_index_state
        SET chunk_count = ?,
            vectorized_bge_count = ?,
            vectorized_qwen3_count = ?,
            vectorized_minilm_count = ?,
            lexical_count = ?,
            backfill_status = ?,
            last_error = ?,
            completed_at = CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ? AND source_table = ? AND source_id = ?`
  ).bind(
    chunks.length,
    counts.bge,
    counts.qwen3,
    counts.minilm,
    counts.lexical,
    sourceBackfillStatus,
    errors.slice(0, 3).join('\n') || null,
    sourceBackfillStatus,
    orgId, source.sourceTable, source.sourceId
  ).run();

  return { status, chunks: range.end - range.start, profiles, lexical, errors };
}

export async function getRagV2Status(env: Env, orgId: string): Promise<Record<string, unknown>> {
  const [sources, chunks, queue, freshness] = await Promise.all([
    env.D1.prepare(
      `SELECT source_table, backfill_status, COUNT(*) AS count,
              SUM(chunk_count) AS chunks,
              SUM(vectorized_bge_count) AS bge_vectors,
              SUM(vectorized_qwen3_count) AS qwen3_vectors,
              SUM(vectorized_minilm_count) AS minilm_vectors,
              SUM(lexical_count) AS lexical_docs
         FROM rag_source_index_state
        WHERE org_id = ?
        GROUP BY source_table, backfill_status
        ORDER BY source_table, backfill_status`
    ).bind(orgId).all(),
    env.D1.prepare(
      `SELECT COUNT(*) AS chunks,
              (SELECT COUNT(*)
                 FROM rag_chunks_v2_fts f
                 JOIN rag_chunks_v2 c2 ON c2.id = f.chunk_id
                WHERE c2.org_id = ?) AS lexical_synced,
              SUM(CASE WHEN vectorize_status_bge = 'synced' THEN 1 ELSE 0 END) AS bge_synced,
              SUM(CASE WHEN vectorize_status_qwen3 = 'synced' THEN 1 ELSE 0 END) AS qwen3_synced,
              SUM(CASE WHEN vectorize_status_minilm = 'synced' THEN 1 ELSE 0 END) AS minilm_synced
         FROM rag_chunks_v2
        WHERE org_id = ?`
    ).bind(orgId, orgId).first(),
    env.D1.prepare(
      `SELECT status, COUNT(*) AS count
         FROM work_queue
        WHERE org_id = ? AND domain = ?
        GROUP BY status`
    ).bind(orgId, RAG_V2_WORK_QUEUE_DOMAIN).all(),
    getRagV2FreshnessSummary(env, orgId).catch(() => []),
  ]);
  return {
    sources: sources.results,
    chunks,
    queue: queue.results,
    freshness,
    lexical_engine: 'd1_fts5',
    profiles: Object.values(RAG_V2_EMBEDDING_PROFILES).map(p => ({
      id: p.id,
      dimensions: p.dimensions,
      vector_index: p.vectorIndexName,
      bound: Boolean(getVectorBinding(env, p.id)),
      benchmark_only: !!p.benchmarkOnly,
    })),
  };
}

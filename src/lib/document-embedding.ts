import type { Env } from '../types/env';
import type { ChunkMetadata } from '../types/interfaces';
import { createSplitter } from './chunking';
import {
  buildVectorId,
  chunkEmbedAndPersist,
  prefixChunk,
} from './embedding';
import {
  extractTextFromFile,
  isTextExtractionSupported,
  textExtractionUnsupportedMessage,
} from './file-extraction';
import { kvPutWithRetry, parseParticipantUserIds } from './helpers';
import { enqueueWork } from './work-queue';

export const DOCUMENT_EMBEDDING_AUDIT_VERSION = 'document-embedding-v2';

const VECTORIZE_GET_BATCH_SIZE = 20;
const VECTOR_DELETE_BATCH_SIZE = 100;

type DocumentVectorVisibility = 'private' | 'org_wide' | 'confidential';

export interface DocumentEmbedResult {
  status: 'embedded' | 'skipped' | 'missing' | 'partial' | 'unembeddable';
  next_cursor?: number;
  total_chunks?: number;
  embedded_chunks?: number;
  repaired_kv_chunks?: number;
  stale_chunks_deleted?: number;
}

interface DocumentRow {
  id: string;
  org_id: string;
  title: string;
  file_name: string | null;
  mime_type: string | null;
  document_type: string | null;
  source: string | null;
  r2_key: string | null;
  created_at: string | null;
  visibility: string | null;
  participant_user_ids: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  conversation_id: string | null;
}

function normalizeVisibility(value: string | null | undefined): DocumentVectorVisibility {
  if (value === 'private' || value === 'confidential') return value;
  return 'org_wide';
}

function documentFileName(row: Pick<DocumentRow, 'file_name' | 'title' | 'id'>): string {
  return row.file_name || row.title || `${row.id}.bin`;
}

function documentPrimaryEntityId(row: DocumentRow): string {
  return row.contact_id || row.company_id || row.deal_id || row.conversation_id || row.id;
}

function documentSecondaryEntityIds(row: DocumentRow, primaryEntityId: string): string | undefined {
  const ids = [row.contact_id, row.company_id, row.deal_id, row.conversation_id]
    .filter((id): id is string => !!id && id !== primaryEntityId);
  return ids.length > 0 ? Array.from(new Set(ids)).join(',') : undefined;
}

function makeAuditKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function documentEmbeddingIdempotencyKey(
  orgId: string,
  documentId: string,
  cursor = 0,
  auditKey = makeAuditKey()
): string {
  return `${orgId}:${documentId}:documents:${DOCUMENT_EMBEDDING_AUDIT_VERSION}:${auditKey}:${cursor}`;
}

export async function enqueueDocumentEmbeddingRepair(
  env: Env,
  orgId: string,
  documentId: string,
  opts: { cursor?: number; auditKey?: string; priority?: number } = {}
): Promise<void> {
  const cursor = Math.max(0, opts.cursor || 0);
  const auditKey = opts.auditKey || makeAuditKey();
  await enqueueWork(
    env,
    orgId,
    'embed_retry',
    { entity_id: documentId, source_table: 'documents', cursor, audit_key: auditKey },
    {
      upstream: 'bge',
      idempotency_key: documentEmbeddingIdempotencyKey(orgId, documentId, cursor, auditKey),
      priority: opts.priority ?? 10,
      max_attempts: 3,
    }
  );
}

async function markDocumentEmbeddingAudit(
  env: Env,
  row: DocumentRow,
  status: 'ok',
  totalChunks: number,
  message?: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = json_set(
              CASE
                WHEN custom_fields IS NOT NULL AND json_valid(custom_fields) THEN custom_fields
                ELSE '{}'
              END,
              '$.embedding_audit_version', ?,
              '$.embedding_audit_at', ?,
              '$.embedding_audit_status', ?,
              '$.embedding_chunk_count', ?,
              '$.embedding_audit_message', ?
            ),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    DOCUMENT_EMBEDDING_AUDIT_VERSION,
    now,
    status,
    totalChunks,
    message ? message.slice(0, 250) : null,
    row.id,
    row.org_id,
  ).run();
}

async function fetchVectorizePresentIds(env: Env, ids: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < ids.length; i += VECTORIZE_GET_BATCH_SIZE) {
    const batch = ids.slice(i, i + VECTORIZE_GET_BATCH_SIZE);
    const vectors = await env.VECTORIZE.getByIds(batch);
    for (const vector of vectors) {
      if (vector?.id && Array.isArray((vector as any).values) && (vector as any).values.length > 0) {
        present.add(vector.id);
      }
    }
  }
  return present;
}

async function deleteStaleDocumentVectors(
  env: Env,
  row: DocumentRow,
  vectorIds: string[]
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < vectorIds.length; i += VECTOR_DELETE_BATCH_SIZE) {
    const batch = vectorIds.slice(i, i + VECTOR_DELETE_BATCH_SIZE);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    await env.D1.prepare(
      `DELETE FROM vector_entity_index
        WHERE entity_id = ?
          AND source_table = 'documents'
          AND org_id = ?
          AND vector_id IN (${placeholders})`
    ).bind(row.id, row.org_id, ...batch).run();
    await Promise.allSettled([
      env.VECTORIZE.deleteByIds(batch),
      ...batch.map(id => env.KV.delete(`chunk:${id}`)),
    ]);
    deleted += batch.length;
  }
  return deleted;
}

async function deleteAllDocumentVectors(env: Env, row: DocumentRow): Promise<number> {
  const rows = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index
      WHERE entity_id = ?
        AND source_table = 'documents'
        AND org_id = ?`
  ).bind(row.id, row.org_id).all<{ vector_id: string }>();
  const ids = rows.results.map(r => r.vector_id);
  return ids.length > 0 ? deleteStaleDocumentVectors(env, row, ids) : 0;
}

async function markDocumentUnembeddable(env: Env, row: DocumentRow, message: string): Promise<void> {
  await deleteAllDocumentVectors(env, row);
  await env.D1.prepare(
    `UPDATE documents
        SET processing_status = 'failed',
            error_message = ?,
            custom_fields = json_set(
              CASE
                WHEN custom_fields IS NOT NULL AND json_valid(custom_fields) THEN custom_fields
                ELSE '{}'
              END,
              '$.embedding_audit_version', ?,
              '$.embedding_audit_at', ?,
              '$.embedding_audit_status', 'unembeddable',
              '$.embedding_audit_message', ?
            ),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    message.slice(0, 500),
    DOCUMENT_EMBEDDING_AUDIT_VERSION,
    new Date().toISOString(),
    message.slice(0, 250),
    row.id,
    row.org_id,
  ).run();
}

export async function embedDocumentItem(
  entityId: string,
  orgId: string,
  env: Env,
  cursor = 0,
  maxChunks = Number.POSITIVE_INFINITY
): Promise<DocumentEmbedResult> {
  const row = await env.D1.prepare(
    `SELECT id, org_id, title, file_name, mime_type, document_type, source, r2_key, created_at,
            visibility, participant_user_ids, contact_id, company_id, deal_id, conversation_id
       FROM documents
      WHERE id = ?
        AND org_id = ?
        AND deleted_at IS NULL
        AND COALESCE(json_extract(
              CASE WHEN custom_fields IS NOT NULL AND json_valid(custom_fields)
                   THEN custom_fields ELSE '{}' END,
              '$.marty_lab_generated'
            ), 0) != 1`
  ).bind(entityId, orgId).first<DocumentRow>();
  if (!row) return { status: 'missing' };
  if (!row.r2_key) return { status: 'missing' };

  const obj = await env.R2.get(row.r2_key);
  if (!obj) return { status: 'missing' };

  const file = new File(
    [await obj.arrayBuffer()],
    documentFileName(row),
    { type: row.mime_type || '' }
  );

  if (!isTextExtractionSupported(file)) {
    const message = textExtractionUnsupportedMessage(file);
    await markDocumentUnembeddable(env, row, message);
    return { status: 'unembeddable' };
  }

  const text = await extractTextFromFile(file);
  if (!text || text.trim().length < 10) {
    const message = `No readable text could be extracted from ${file.name}. The original file was stored, but it is not searchable by MARTy.`;
    await markDocumentUnembeddable(env, row, message);
    return { status: 'unembeddable' };
  }

  const docType = row.document_type || 'document';
  const splitter = createSplitter(docType);
  const chunks = await splitter.splitText(text);
  if (chunks.length === 0) {
    const message = `No searchable chunks could be created from ${file.name}. The original file was stored, but it is not searchable by MARTy.`;
    await markDocumentUnembeddable(env, row, message);
    return { status: 'unembeddable' };
  }

  const primaryEntityId = documentPrimaryEntityId(row);
  const meta: ChunkMetadata = {
    org_id: orgId,
    visibility: normalizeVisibility(row.visibility),
    participant_user_ids: parseParticipantUserIds(row.participant_user_ids).join(',') || undefined,
    document_type: docType,
    source_table: 'documents',
    source_id: row.id,
    r2_key: row.r2_key,
    created_at: row.created_at || new Date().toISOString(),
    primary_entity_id: primaryEntityId,
    secondary_entity_ids: documentSecondaryEntityIds(row, primaryEntityId),
    entity_name: row.title || row.file_name || undefined,
  };

  const expectedIds = chunks.map((_, i) => buildVectorId(meta, i));
  const expectedIdSet = new Set(expectedIds);
  const existingRows = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index
      WHERE entity_id = ?
        AND source_table = 'documents'
        AND org_id = ?`
  ).bind(row.id, orgId).all<{ vector_id: string }>();
  const existingIds = new Set(existingRows.results.map(r => r.vector_id));
  const staleIds = existingRows.results
    .map(r => r.vector_id)
    .filter(id => !expectedIdSet.has(id));
  const staleDeleted = staleIds.length > 0
    ? await deleteStaleDocumentVectors(env, row, staleIds)
    : 0;

  const start = Math.max(0, cursor);
  const boundedMax = Number.isFinite(maxChunks) ? Math.max(1, maxChunks) : chunks.length;
  const end = Math.min(chunks.length, start + boundedMax);
  if (start >= chunks.length) {
    await markDocumentEmbeddingAudit(env, row, 'ok', chunks.length);
    return { status: 'skipped', total_chunks: chunks.length, stale_chunks_deleted: staleDeleted };
  }

  const windowIds = expectedIds.slice(start, end);
  const vectorizePresent = await fetchVectorizePresentIds(
    env,
    windowIds.filter(id => existingIds.has(id))
  );
  const kvPresence = await Promise.all(
    windowIds.map(id => env.KV.get(`chunk:${id}`).then(Boolean).catch(() => false))
  );

  let embeddedChunks = 0;
  let repairedKvChunks = 0;

  for (let offset = 0; offset < windowIds.length; offset++) {
    const chunkIndex = start + offset;
    const vectorId = windowIds[offset];
    const d1HasVector = existingIds.has(vectorId);
    const vectorizeHasVector = !d1HasVector || vectorizePresent.has(vectorId);
    const kvHasChunk = kvPresence[offset];

    if (!d1HasVector || !vectorizeHasVector) {
      const entry = await chunkEmbedAndPersist(chunks[chunkIndex], meta, chunkIndex, chunks.length, env);
      await env.D1.prepare(
        'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
      ).bind(entry.vectorId, entry.entityId, entry.sourceTable, entry.orgId).run();
      existingIds.add(vectorId);
      embeddedChunks++;
      continue;
    }

    if (!kvHasChunk) {
      await kvPutWithRetry(env, `chunk:${vectorId}`, prefixChunk(chunks[chunkIndex], meta));
      repairedKvChunks++;
    }
  }

  const hasUnprocessedFutureWindow = end < chunks.length;
  const hasMissingExpectedD1Rows = expectedIds.some(id => !existingIds.has(id));
  if (hasUnprocessedFutureWindow || hasMissingExpectedD1Rows) {
    return {
      status: 'partial',
      next_cursor: end,
      total_chunks: chunks.length,
      embedded_chunks: embeddedChunks,
      repaired_kv_chunks: repairedKvChunks,
      stale_chunks_deleted: staleDeleted,
    };
  }

  await markDocumentEmbeddingAudit(env, row, 'ok', chunks.length);
  return {
    status: embeddedChunks > 0 || repairedKvChunks > 0 || staleDeleted > 0 ? 'embedded' : 'skipped',
    total_chunks: chunks.length,
    embedded_chunks: embeddedChunks,
    repaired_kv_chunks: repairedKvChunks,
    stale_chunks_deleted: staleDeleted,
  };
}

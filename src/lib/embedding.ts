// TRD §4.3 — Chunk embed + persist to Vectorize + KV
import type { Env } from '../types/env';
import type { ChunkMetadata, VectorIndexEntry } from '../types/interfaces';
import { createSplitter, CURRENT_CHUNK_VERSION } from './chunking';
import { acquireEmbedSlot } from './rate-limit';

export function prefixChunk(text: string, meta: ChunkMetadata): string {
  const parts = [`[Type: ${meta.document_type}]`];
  if (meta.entity_name) parts.push(`[Entity: ${meta.entity_name}]`);
  if (meta.deal_stage) parts.push(`[Stage: ${meta.deal_stage}]`);
  if (meta.date) parts.push(`[Date: ${meta.date}]`);
  return `${parts.join(' ')}\n${text}`;
}

// Per-isolate concurrency cap (audit 2026-04-28 scale-up Fix 1, Step 3).
// KV-coordinated limiter handles cross-invocation pacing, but during a 1s
// window two requests can race and both pass — actual peak concurrency can
// exceed the configured RPS. This in-isolate semaphore bounds the burst to
// 4 concurrent BGE calls per Worker invocation as a defensive ceiling.
let inFlightEmbeds = 0;
const MAX_IN_FLIGHT_PER_ISOLATE = 4;

async function withInFlightCap<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlightEmbeds >= MAX_IN_FLIGHT_PER_ISOLATE) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  inFlightEmbeds += 1;
  try {
    return await fn();
  } finally {
    inFlightEmbeds -= 1;
  }
}

export async function runEmbedding(env: Env, text: string, orgId: string): Promise<number[]> {
  await acquireEmbedSlot(orgId, env);
  return withInFlightCap(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: [text],
          pooling: 'cls',
        } as any);
        return Array.isArray((result as any).data)
          ? (result as any).data[0]
          : (result as any).data;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw lastErr;
  });
}

export async function chunkEmbedAndPersist(
  text: string,
  meta: ChunkMetadata,
  chunkIndex: number,
  totalChunks: number,
  env: Env
): Promise<VectorIndexEntry> {
  const prefixedChunk = prefixChunk(text, meta);
  // Vectorize max ID is 64 bytes. Compact: strip UUID dashes, truncate org_id.
  const orgPrefix = meta.org_id.substring(0, 8);
  const compactSourceId = meta.source_id.replace(/-/g, '');
  const vectorId = `${orgPrefix}_${meta.source_table}_${compactSourceId}_${chunkIndex}`;

  const values = await runEmbedding(env, prefixedChunk, meta.org_id);

  await Promise.all([
    env.VECTORIZE.upsert([
      {
        id: vectorId,
        values,
        metadata: {
          ...meta,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
          text_preview: prefixedChunk.substring(0, 200),
          embedding_model: 'bge-base-en-v1.5',
          chunk_config_version: CURRENT_CHUNK_VERSION,
        },
      },
    ]),
    env.KV.put(`chunk:${vectorId}`, prefixedChunk),
  ]);

  return {
    vectorId,
    entityId: meta.source_id,
    sourceTable: meta.source_table,
    orgId: meta.org_id,
  };
}

/**
 * Splits `text` into chunks according to the current chunk config version
 * for meta.document_type, then embeds and persists each chunk.
 * Returns one VectorIndexEntry per chunk for batched D1 write by the caller.
 *
 * Dedup: if vector_entity_index already contains a row for this entity
 * (meta.source_table + meta.source_id + meta.org_id), we skip — the entity
 * has already been embedded by a prior run. Audit 2026-04-28 found 4,131
 * vector_entity_index rows for 565 conversations (731% inflation) caused by
 * re-embedding on every ingestion run; without dedup each run added a fresh
 * set of vectors with new IDs and accumulated forever.
 *
 * Tradeoff: when an email's content changes (subject/body edited), the old
 * embedding stays. To re-embed on edit, store a content_hash on the row and
 * compare here, deleting old vectors before re-embedding. Not implementing
 * that yet — edits to ingested email content are rare.
 */
export async function chunkEmbedAndPersistAll(
  text: string,
  meta: ChunkMetadata,
  env: Env
): Promise<VectorIndexEntry[]> {
  if (!text || text.trim().length < 10) return [];

  const existing = await env.D1.prepare(
    `SELECT 1 FROM vector_entity_index
       WHERE entity_id = ? AND source_table = ? AND org_id = ?
       LIMIT 1`
  ).bind(meta.source_id, meta.source_table, meta.org_id).first();
  if (existing) {
    return [];
  }

  const splitter = createSplitter(meta.document_type);
  const chunks = await splitter.splitText(text);
  if (chunks.length === 0) return [];

  const entries: VectorIndexEntry[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const entry = await chunkEmbedAndPersist(chunks[i], meta, i, chunks.length, env);
    entries.push(entry);
  }
  return entries;
}

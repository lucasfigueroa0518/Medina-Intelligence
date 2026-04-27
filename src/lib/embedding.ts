// TRD §4.3 — Chunk embed + persist to Vectorize + KV
import type { Env } from '../types/env';
import type { ChunkMetadata, VectorIndexEntry } from '../types/interfaces';
import { createSplitter, CURRENT_CHUNK_VERSION } from './chunking';

export function prefixChunk(text: string, meta: ChunkMetadata): string {
  const parts = [`[Type: ${meta.document_type}]`];
  if (meta.entity_name) parts.push(`[Entity: ${meta.entity_name}]`);
  if (meta.deal_stage) parts.push(`[Stage: ${meta.deal_stage}]`);
  if (meta.date) parts.push(`[Date: ${meta.date}]`);
  return `${parts.join(' ')}\n${text}`;
}

export async function runEmbedding(env: Env, text: string): Promise<number[]> {
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

  const values = await runEmbedding(env, prefixedChunk);

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
    entityId: meta.primary_entity_id,
    sourceTable: meta.source_table,
    orgId: meta.org_id,
  };
}

/**
 * Splits `text` into chunks according to the current chunk config version
 * for meta.document_type, then embeds and persists each chunk.
 * Returns one VectorIndexEntry per chunk for batched D1 write by the caller.
 */
export async function chunkEmbedAndPersistAll(
  text: string,
  meta: ChunkMetadata,
  env: Env
): Promise<VectorIndexEntry[]> {
  if (!text || text.trim().length < 10) return [];

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

// TRD §4.3 — 3-tier hydration: KV → R2 re-chunk → preview fallback
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { Env } from '../types/env';
import type { VectorMatch, HydratedChunk, HydrationSummary } from '../types/interfaces';
import { CHUNK_CONFIGS } from './chunking';

export async function hydrateChunks(
  chunks: VectorMatch[],
  env: Env
): Promise<{ chunks: HydratedChunk[]; summary: HydrationSummary }> {
  const summary: HydrationSummary = { kv: 0, r2_rechunk: 0, preview_fallback: 0 };

  const hydrated = await Promise.all(
    chunks.map(async (chunk): Promise<HydratedChunk> => {
      const kvText = await env.KV.get(`chunk:${chunk.id}`);
      if (kvText) {
        summary.kv++;
        return { ...chunk, hydrated_text: kvText, hydration_source: 'kv' };
      }

      try {
        const r2Key = chunk.metadata.r2_key as string | undefined;
        if (r2Key) {
          const fullDoc = await env.R2.get(r2Key);
          if (fullDoc) {
            const configVersion = (chunk.metadata.chunk_config_version as string) || 'v1';
            const docType = (chunk.metadata.document_type as string) || 'document';
            const rechunked = rechunkWithConfig(
              await fullDoc.text(),
              docType,
              configVersion
            );
            const idx = (chunk.metadata.chunk_index as number) ?? 0;
            const target = rechunked[idx];
            if (target) {
              // Backfill KV with 90-day TTL
              await env.KV.put(`chunk:${chunk.id}`, target, { expirationTtl: 7776000 });
              summary.r2_rechunk++;
              return { ...chunk, hydrated_text: target, hydration_source: 'r2_rechunk' };
            }
          }
        }
      } catch {
        // fall through
      }

      summary.preview_fallback++;
      return {
        ...chunk,
        hydrated_text: (chunk.metadata.text_preview as string) || '',
        hydration_source: 'preview_fallback',
      };
    })
  );

  const total = hydrated.length;
  if (total > 0 && summary.preview_fallback / total > 0.2) {
    console.warn(
      `Hydration degraded: ${summary.preview_fallback}/${total} chunks used preview fallback.`
    );
  }

  return { chunks: hydrated, summary };
}

export function rechunkWithConfig(
  text: string,
  docType: string,
  configVersion: string
): string[] {
  const config =
    CHUNK_CONFIGS[configVersion]?.[docType] ||
    CHUNK_CONFIGS.v1[docType] ||
    CHUNK_CONFIGS.v2.document;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.size,
    chunkOverlap: config.overlap || 0,
    separators: ['\n\n', '\n', '. ', '! ', '? ', ' ', ''],
  });
  // @ts-expect-error — splitText is sync at runtime per spec
  return splitter.splitText(text);
}

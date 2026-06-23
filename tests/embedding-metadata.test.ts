import { describe, expect, it } from 'vitest';
import {
  compactVectorizeMetadata,
  isDeterministicVectorizePayloadError,
  validateVectorizePayload,
  VECTORIZE_PAYLOAD_QUARANTINE_ERROR,
} from '../src/lib/embedding';
import type { ChunkMetadata } from '../src/types/interfaces';

describe('Vectorize metadata compaction', () => {
  it('keeps legacy oversized fields out of Vectorize metadata', () => {
    const meta: ChunkMetadata & Record<string, unknown> = {
      org_id: 'org-1',
      document_type: 'email',
      source_table: 'conversations',
      source_id: 'conv-1',
      r2_key: 'org-1/conversations/conv-1.txt',
      visibility: 'org_wide',
      primary_entity_id: 'contact-1',
      created_at: '2026-05-25T00:00:00.000Z',
      raw_provider_payload: 'x'.repeat(25_000),
      giant_nested_object: { impossible: 'to-index' },
    };

    const compact = compactVectorizeMetadata(meta, 2, 5, 'hello world');

    expect(compact.raw_provider_payload).toBeUndefined();
    expect(compact.giant_nested_object).toBeUndefined();
    expect(compact.org_id).toBe('org-1');
    expect(compact.source_id).toBe('conv-1');
    expect(compact.chunk_index).toBe('2');
    expect(JSON.stringify(compact).length).toBeLessThan(3000);
  });

  it('rejects malformed Vectorize payloads before upsert', () => {
    expect(() => validateVectorizePayload({
      id: 'vector-1',
      values: Array.from({ length: 767 }, () => 0),
      metadata: { org_id: 'org-1' },
    })).toThrow(VECTORIZE_PAYLOAD_QUARANTINE_ERROR);

    const values = Array.from({ length: 768 }, () => 0);
    values[10] = Number.NaN;
    expect(() => validateVectorizePayload({
      id: 'vector-1',
      values,
      metadata: { org_id: 'org-1' },
    })).toThrow(/non-finite vector value/);

    expect(() => validateVectorizePayload({
      id: 'x'.repeat(65),
      values: Array.from({ length: 768 }, () => 0),
      metadata: { org_id: 'org-1' },
    })).toThrow(/exceeds 64 bytes/);

    expect(() => validateVectorizePayload({
      id: 'vector-1',
      values: Array.from({ length: 768 }, () => 0),
      metadata: { nested: { no: 'objects' } as any },
    })).toThrow(/metadata value/);

    expect(() => validateVectorizePayload({
      id: 'vector-1',
      values: Array.from({ length: 768 }, () => 0),
      metadata: { chunk_index: 2 as any },
    })).toThrow(/must be string/);
  });

  it('classifies Cloudflare Vectorize 40023 parser errors as deterministic quarantine', () => {
    expect(isDeterministicVectorizePayloadError(
      new Error('VECTOR_UPSERT_ERROR (code = 40023): failed to parse upsert vectors request')
    )).toBe(true);
    expect(isDeterministicVectorizePayloadError(
      new Error(`${VECTORIZE_PAYLOAD_QUARANTINE_ERROR}: expected 768 dimensions, got 10`)
    )).toBe(true);
    expect(isDeterministicVectorizePayloadError(new Error('EMBED_RATE_LIMIT_TIMEOUT'))).toBe(false);
  });
});

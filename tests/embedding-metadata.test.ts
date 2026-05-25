import { describe, expect, it } from 'vitest';
import { compactVectorizeMetadata } from '../src/lib/embedding';
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
    expect(compact.chunk_index).toBe(2);
    expect(JSON.stringify(compact).length).toBeLessThan(3000);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fuseHybridCandidates, queryDenseRagV2Candidates } from '../src/lib/rag-v2';
import { __retrievalTestHooks } from '../src/lib/retrieval';

describe('RAG v2 source-scoped retrieval', () => {
  it('uses targeted Vectorize filters for forced Slack conversation retrieval', async () => {
    const query = vi.fn(async (_embedding: number[], _options: any) => ({
      matches: [
        {
          id: 'vec-slack-1',
          score: 0.91,
          metadata: { rag_chunk_id: 'chunk-slack-1' },
        },
      ],
    }));
    const env = {
      VECTORIZE_RAG_V2_BGE: { query },
    };

    const candidates = await queryDenseRagV2Candidates(
      env as any,
      'org-1',
      [0.1, 0.2, 0.3],
      'bge-base-en-v1.5:cls:v3',
      [],
      {
        broadTopK: 100,
        targetedTopK: 25,
        documentTypes: ['conversation'],
        sourceFamilies: ['slack'],
      }
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatchObject({
      topK: 25,
      filter: {
        org_id: 'org-1',
        document_type: 'conversation',
        source_family: 'slack',
      },
      returnValues: false,
      returnMetadata: 'indexed',
    });
    expect(candidates).toEqual([
      {
        chunkId: 'chunk-slack-1',
        vectorId: 'vec-slack-1',
        score: 0.91,
        rank: 1,
        source: 'vectorize_targeted',
      },
    ]);
  });

  it('keeps unscoped Vectorize retrieval broad but non-news', async () => {
    const query = vi.fn(async () => ({
      matches: [
        {
          id: 'vec-any-1',
          score: 0.75,
          metadata: { rag_chunk_id: 'chunk-any-1' },
        },
      ],
    }));
    const env = {
      VECTORIZE_RAG_V2_BGE: { query },
    };

    const candidates = await queryDenseRagV2Candidates(
      env as any,
      'org-1',
      [0.1],
      'bge-base-en-v1.5:cls:v3',
      []
    );

    expect(query.mock.calls[0][1].filter).toEqual({
      org_id: 'org-1',
      document_type: { $nin: ['news'] },
    });
    expect(candidates[0].source).toBe('vectorize_broad');
  });

  it('boosts targeted dense candidates during hybrid fusion', () => {
    const fused = fuseHybridCandidates(
      [
        { chunkId: 'broad', vectorId: 'v-broad', score: 0.99, rank: 1, source: 'vectorize_broad' },
        { chunkId: 'targeted', vectorId: 'v-targeted', score: 0.8, rank: 1, source: 'vectorize_targeted' },
      ],
      [],
      { denseBroad: 1.0, denseTargeted: 1.6 }
    );

    expect(fused[0].chunkId).toBe('targeted');
  });

  it('passes targeted v2 vector ids to the reranker floor bypass', () => {
    const ids = __retrievalTestHooks.targetedVectorIdsForRagV2(
      [
        { chunkId: 'chunk-slack-1', source: 'vectorize_targeted' },
        { chunkId: 'chunk-email-1', source: 'vectorize_broad' },
      ],
      [
        { id: 'rv2_bge_slack_1', score: 0.8, metadata: { rag_chunk_id: 'chunk-slack-1' } },
        { id: 'rv2_bge_email_1', score: 0.9, metadata: { rag_chunk_id: 'chunk-email-1' } },
      ] as any
    );

    expect(ids).toEqual(new Set(['rv2_bge_slack_1']));
  });
});

import { describe, expect, it } from 'vitest';
import { upsertRagChunksD1Fts } from '../src/lib/rag-v2-lexical';

// The FTS delete gate (D1 CPU incident 2026-07-06): DELETE FROM
// rag_chunks_v2_fts by UNINDEXED chunk_id full-scans the FTS table, so
// the upsert must only emit it for chunks whose base row could already
// have an FTS row ('synced'/'failed'), and must write status='synced'
// inside the SAME transactional batch.

function makeFakeD1(syncedIds: string[]) {
  const prepared: { sql: string; binds: unknown[] }[] = [];
  const batches: { sql: string; binds: unknown[] }[][] = [];
  const env = {
    D1: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            const statement = { sql, binds };
            return {
              ...statement,
              all: async () => ({
                results: syncedIds
                  .filter(id => binds.includes(id))
                  .map(id => ({ id })),
              }),
            };
          },
        };
      },
      async batch(statements: { sql: string; binds: unknown[] }[]) {
        batches.push(statements);
        return statements.map(() => ({ success: true }));
      },
    },
  } as never;
  return { env, prepared, batches };
}

function record(id: string) {
  return {
    id,
    org_id: 'org',
    source_table: 'conversations',
    source_id: 's1',
    document_type: 'email',
    source_family: 'conversation',
    primary_entity_id: null,
    title: 't',
    body: 'b',
    text_preview: 'b',
    section_path: '',
    entity_names: '',
    exact_terms: '',
  } as never;
}

describe('upsertRagChunksD1Fts delete gate', () => {
  it('emits NO FTS delete for first-time chunks (pending base rows)', async () => {
    const { env, batches } = makeFakeD1([]);
    const result = await upsertRagChunksD1Fts(env, [record('c1'), record('c2')]);
    expect(result.errors).toEqual([]);
    const flat = batches.flat();
    expect(flat.filter(s => s.sql.includes('DELETE FROM rag_chunks_v2_fts'))).toHaveLength(0);
    expect(flat.filter(s => s.sql.includes('INSERT INTO rag_chunks_v2_fts'))).toHaveLength(2);
    // status write rides the same atomic batch
    expect(flat.some(s => s.sql.includes("opensearch_status = 'synced'"))).toBe(true);
  });

  it('emits the FTS delete only for previously indexed chunks', async () => {
    const { env, batches } = makeFakeD1(['c-old']);
    await upsertRagChunksD1Fts(env, [record('c-old'), record('c-new')]);
    const deletes = batches.flat().filter(s => s.sql.includes('DELETE FROM rag_chunks_v2_fts'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].binds).toEqual(['c-old']);
  });
});

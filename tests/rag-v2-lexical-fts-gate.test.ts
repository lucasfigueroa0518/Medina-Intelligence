import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upsertRagChunksD1Fts } from '../src/lib/rag-v2-lexical';

// The FTS delete gate (D1 CPU incident 2026-07-06): DELETE FROM
// rag_chunks_v2_fts by UNINDEXED chunk_id full-scans the FTS table, so
// the upsert must only emit it for chunks whose base row could already
// have an FTS row ('synced'/'failed'), and must write status='synced'
// inside the SAME transactional batch.

function makeFakeD1(statusById: Record<string, string>) {
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
                results: binds
                  .filter((id): id is string => typeof id === 'string')
                  .map(id => ({ id, opensearch_status: statusById[id] ?? 'pending' })),
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

describe('upsertRagChunksD1Fts delete gate (v2 semantics)', () => {
  it('first-time chunks (pending): insert only, no delete, status in same batch', async () => {
    const { env, batches } = makeFakeD1({});
    const result = await upsertRagChunksD1Fts(env, [record('c1'), record('c2')]);
    expect(result.errors).toEqual([]);
    const flat = batches.flat();
    expect(flat.filter(s => s.sql.includes('DELETE FROM rag_chunks_v2_fts'))).toHaveLength(0);
    expect(flat.filter(s => s.sql.includes('INSERT INTO rag_chunks_v2_fts'))).toHaveLength(2);
    expect(flat.some(s => s.sql.includes("opensearch_status = 'synced'"))).toBe(true);
  });

  it("'synced' chunks are a FULL NO-OP — ids are content-addressed, the FTS row is already correct", async () => {
    const { env, batches } = makeFakeD1({ 'c-done': 'synced' });
    const result = await upsertRagChunksD1Fts(env, [record('c-done')]);
    expect(result.errors).toEqual([]);
    expect(batches.flat()).toHaveLength(0); // no delete, no insert, no status write
  });

  it("'failed' chunks get delete+insert; mixed batch only writes non-synced", async () => {
    const { env, batches } = makeFakeD1({ 'c-fail': 'failed', 'c-done': 'synced' });
    await upsertRagChunksD1Fts(env, [record('c-fail'), record('c-done'), record('c-new')]);
    const flat = batches.flat();
    const deletes = flat.filter(s => s.sql.includes('DELETE FROM rag_chunks_v2_fts'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].binds).toEqual(['c-fail']);
    expect(flat.filter(s => s.sql.includes('INSERT INTO rag_chunks_v2_fts'))).toHaveLength(2);
    const statusWrites = flat.filter(s => s.sql.includes("opensearch_status = 'synced'"));
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0].binds).toEqual(['c-fail', 'c-new']); // never touches the no-op row
  });
});

describe('base upsert keeps lexical status sticky (audit F1 regression pin)', () => {
  it('the ON CONFLICT update list must not reset opensearch_status', () => {
    // The duplication bug: upsertRagChunkRecordStatement reset status to
    // 'pending' on every re-upsert, defeating the gate. Pin the SQL.
    const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'rag-v2.ts'), 'utf8');
    const conflictBlock = src.slice(src.indexOf('ON CONFLICT(id) DO UPDATE'), src.indexOf('ON CONFLICT(id) DO UPDATE') + 1200);
    expect(conflictBlock).not.toContain('opensearch_status = excluded.opensearch_status');
  });
});

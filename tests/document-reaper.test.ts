import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueDocumentEmbeddingRepairMock = vi.hoisted(() => vi.fn());
const embedDocumentItemMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/document-embedding', () => ({
  embedDocumentItem: embedDocumentItemMock,
  enqueueDocumentEmbeddingRepair: enqueueDocumentEmbeddingRepairMock,
}));

import { reapStaleProcessingDocuments } from '../src/lib/daily-cron';

function makeD1Mock(rows: Array<{ id: string; r2_key: string | null; file_name?: string | null; title?: string | null }>) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const allCalls: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    runs,
    allCalls,
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async all() {
          allCalls.push({ sql, binds });
          return { results: rows };
        },
        async run() {
          runs.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
      };
    },
  };
}

describe('stale document reaper', () => {
  beforeEach(() => {
    enqueueDocumentEmbeddingRepairMock.mockReset().mockResolvedValue({ inserted: true, id: 'wq-1' });
    embedDocumentItemMock.mockReset();
  });

  it('fails stale processing documents and only enqueues recoverable embedding repair', async () => {
    const d1 = makeD1Mock([
      { id: 'doc-with-r2', r2_key: 'org-1/docs/doc-with-r2.pdf', file_name: 'deck.pdf', title: 'Deck' },
      { id: 'doc-missing-r2', r2_key: null, file_name: 'missing.pdf', title: 'Missing' },
    ]);

    const result = await reapStaleProcessingDocuments('org-1', { D1: d1 } as any, {
      limit: 10,
      olderThanMinutes: 180,
    });

    expect(result).toEqual({
      inspected: 2,
      failed: 2,
      embedding_repairs_enqueued: 1,
    });
    expect(d1.allCalls[0]?.binds).toEqual(['org-1', '-180 minutes', 10]);

    const updates = d1.runs.filter(r => r.sql.includes('UPDATE documents'));
    expect(updates).toHaveLength(2);
    expect(updates[0]?.binds).toEqual(expect.arrayContaining([1, 'doc-with-r2', 'org-1']));
    expect(String(updates[0]?.binds[0])).toContain('embedding repair queued');
    expect(updates[1]?.binds).toEqual(expect.arrayContaining([0, 'doc-missing-r2', 'org-1']));
    expect(String(updates[1]?.binds[0])).toContain('missing source R2 key');

    expect(enqueueDocumentEmbeddingRepairMock).toHaveBeenCalledTimes(1);
    expect(enqueueDocumentEmbeddingRepairMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'doc-with-r2',
      expect.objectContaining({
        auditKey: 'stale_document_reaper:doc-with-r2',
        priority: 20,
      })
    );
  });
});

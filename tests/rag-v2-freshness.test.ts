import { describe, expect, it } from 'vitest';
import {
  enqueueRagV2SourceReindex,
  scanAndRepairRagV2Coverage,
} from '../src/lib/rag-v2';

function makeD1Mock() {
  const firstCalls: Array<{ sql: string; binds: unknown[] }> = [];
  const allCalls: Array<{ sql: string; binds: unknown[] }> = [];

  return {
    firstCalls,
    allCalls,
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async first() {
          firstCalls.push({ sql, binds });
          if (sql.includes('FROM conversations') && sql.includes('WHERE id = ?')) {
            return {
              id: 'slack-1',
              source: 'slack',
              subject: null,
              body_r2_key: 'r2/slack-1.txt',
              body_preview: 'fresh slack preview',
              sent_at: '2026-05-29T18:06:06.959Z',
              participant_user_ids: '[]',
              from_contact_id: 'contact-1',
            };
          }
          if (sql.includes('INSERT INTO work_queue')) {
            return { id: 'work-1' };
          }
          if (sql.includes('WITH src')) {
            return {
              total_sources: 1,
              indexed_sources: 0,
              missing_sources: 1,
              incomplete_sources: 0,
              latest_source_at: '2026-05-29T18:06:06.959Z',
              latest_indexed_source_at: null,
            };
          }
          return null;
        },
        async all() {
          allCalls.push({ sql, binds });
          if (sql.includes('SELECT status, COUNT(*) AS count') && sql.includes("domain = ?")) {
            return { results: [] };
          }
          if (sql.includes('WITH src') && sql.includes('LEFT JOIN rag_source_index_state')) {
            return { results: [{ id: 'slack-1' }] };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

function makeEnv(d1: any): any {
  return {
    D1: d1,
    R2: {
      async get(key: string) {
        expect(key).toBe('r2/slack-1.txt');
        return {
          async text() {
            return 'This is a fresh Slack message body that should be hash-addressed for RAG v2 repair.';
          },
        };
      },
    },
    KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
    },
  };
}

describe('RAG v2 freshness repair', () => {
  it('enqueues source reindex work with a source-hash idempotency key', async () => {
    const d1 = makeD1Mock();
    const result = await enqueueRagV2SourceReindex(
      makeEnv(d1),
      'org-1',
      'conversations',
      'slack-1'
    );

    expect(result.status).toBe('enqueued');
    expect(result.source_family).toBe('slack');
    expect(result.idempotency_key).toContain('org-1:conversations:slack-1:');
    expect(result.idempotency_key).toContain('bge-base-en-v1.5:cls:v3');
    expect(result.idempotency_key).toContain(':v3');

    const insert = d1.firstCalls.find(call => call.sql.includes('INSERT INTO work_queue'));
    expect(insert?.binds[1]).toBe('rag_reindex_v2');
    expect(insert?.binds[4]).toBe(result.idempotency_key);
  });

  it('scans missing Slack RAG v2 coverage and queues repair', async () => {
    const d1 = makeD1Mock();
    const result = await scanAndRepairRagV2Coverage(makeEnv(d1), 'org-1', {
      sourceFamilies: ['slack'],
      limitPerSpec: 10,
    });

    expect(result.candidates).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.freshness[0]).toMatchObject({
      source_family: 'slack',
      missing_sources: 1,
      latest_source_at: '2026-05-29T18:06:06.959Z',
    });
  });
});

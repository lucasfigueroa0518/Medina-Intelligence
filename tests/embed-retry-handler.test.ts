import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedDocumentItemMock = vi.hoisted(() => vi.fn());
const embedSingleItemMock = vi.hoisted(() => vi.fn());
const enqueueDocumentEmbeddingRepairMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/daily-cron', () => ({
  embedDocumentItem: embedDocumentItemMock,
  embedSingleItem: embedSingleItemMock,
}));

vi.mock('../src/lib/document-embedding', () => ({
  enqueueDocumentEmbeddingRepair: enqueueDocumentEmbeddingRepairMock,
}));

import { embedRetryHandler } from '../src/lib/work-queue-handlers/embed-retry';
import type { WorkQueueRow } from '../src/lib/work-queue';

function makeItem(payload: unknown): WorkQueueRow {
  return {
    id: 'work-1',
    org_id: 'org-1',
    domain: 'embed_retry',
    payload: JSON.stringify(payload),
    status: 'in_progress',
    attempt: 0,
    max_attempts: 3,
    next_attempt_at: null,
    last_error: null,
    locked_until: null,
    heartbeat_at: null,
    upstream: 'bge',
    idempotency_key: null,
    priority: 0,
    created_at: '2026-05-31T00:00:00.000Z',
    started_at: null,
    completed_at: null,
  };
}

function makeD1Mock() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    runs,
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async run() {
          runs.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

describe('embed_retry work-queue handler', () => {
  beforeEach(() => {
    embedDocumentItemMock.mockReset();
    embedSingleItemMock.mockReset();
    enqueueDocumentEmbeddingRepairMock.mockReset();
  });

  it('dead-letters deterministic Vectorize payload failures and quarantines document rows', async () => {
    embedDocumentItemMock.mockRejectedValue(
      new Error('VECTOR_UPSERT_ERROR (code = 40023): failed to parse upsert vectors request')
    );
    const d1 = makeD1Mock();

    await embedRetryHandler.process(makeItem({
      entity_id: 'doc-1',
      source_table: 'documents',
    }), { D1: d1 } as any);

    const documentUpdate = d1.runs.find(r => r.sql.includes('UPDATE documents'));
    expect(documentUpdate?.binds).toEqual(expect.arrayContaining([
      'work-1',
      'doc-1',
      'org-1',
    ]));
    expect(documentUpdate?.binds.join(' ')).toContain('vectorize_payload_quarantined');

    const deadLetterUpdate = d1.runs.find(r =>
      r.sql.includes('UPDATE work_queue') &&
      r.sql.includes("status       = 'dead_letter'")
    );
    expect(deadLetterUpdate?.binds[0]).toContain('vectorize_payload_quarantined');
    expect(deadLetterUpdate?.binds[1]).toBe('work-1');
    expect(enqueueDocumentEmbeddingRepairMock).not.toHaveBeenCalled();
  });

  it('continues partial document embedding by enqueueing the next cursor', async () => {
    embedDocumentItemMock.mockResolvedValue({ status: 'partial', embedded_chunks: 25, next_cursor: 25 });
    const d1 = makeD1Mock();

    await embedRetryHandler.process(makeItem({
      entity_id: 'doc-2',
      source_table: 'documents',
      audit_key: 'audit-1',
      cursor: 0,
    }), { D1: d1 } as any);

    expect(enqueueDocumentEmbeddingRepairMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'doc-2',
      expect.objectContaining({ cursor: 25, auditKey: 'audit-1' })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueWorkMock = vi.hoisted(() => vi.fn());
const pickOrphanBatchMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/work-queue', () => ({
  enqueueWork: enqueueWorkMock,
}));

vi.mock('../src/lib/attachment-backfill-orchestrator', () => ({
  pickOrphanBatch: pickOrphanBatchMock,
}));

import {
  detectIngestionDivergence,
  enqueueDealEvidenceDocumentDetection,
} from '../src/lib/daily-cron';

function makeD1Mock(options: {
  orphanCount?: number;
  dealDocumentCandidates?: Array<{ source_id: string; company_id: string }>;
} = {}) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const allCalls: Array<{ sql: string; binds: unknown[] }> = [];
  const firstCalls: Array<{ sql: string; binds: unknown[] }> = [];

  return {
    runs,
    allCalls,
    firstCalls,
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async first() {
          firstCalls.push({ sql, binds });
          if (sql.includes('conversations c') && sql.includes('has_attachments = 1')) {
            return { n: options.orphanCount || 0 };
          }
          return null;
        },
        async all() {
          allCalls.push({ sql, binds });
          if (sql.includes('WITH candidates AS') && sql.includes('deal_suggestion_evidence')) {
            return { results: options.dealDocumentCandidates || [] };
          }
          return { results: [] };
        },
        async run() {
          runs.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

function makeEnv(d1: any): any {
  return {
    D1: d1,
    KV: { async get() { return null; }, async put() {}, async delete() {} },
  };
}

describe('ingestion hardening selectors', () => {
  beforeEach(() => {
    enqueueWorkMock.mockReset().mockResolvedValue({ inserted: true, id: 'wq-1' });
    pickOrphanBatchMock.mockReset().mockResolvedValue(['conv-1', 'conv-2']);
  });

  it('turns attachment divergence into an incident plus bounded backfill work', async () => {
    const d1 = makeD1Mock({ orphanCount: 2 });

    const result = await detectIngestionDivergence('org-1', makeEnv(d1));

    expect(result).toMatchObject({ orphan_attachment_conversations: 2, repairs_enqueued: 2 });
    expect(pickOrphanBatchMock).toHaveBeenCalledWith('org-1', 25, expect.anything());
    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'attachment_backfill',
      expect.objectContaining({ conversation_id: 'conv-1', origin: 'divergence_scan' }),
      expect.objectContaining({ upstream: 'graph', max_attempts: 6 })
    );
    expect(d1.runs.some((r: any) =>
      r.sql.includes('INSERT INTO ingestion_incidents') &&
      r.binds.includes('attachment_divergence_detected')
    )).toBe(true);
  });

  it('enqueues completed deal documents that have no evidence row', async () => {
    const d1 = makeD1Mock({
      dealDocumentCandidates: [{ source_id: 'doc-1', company_id: 'company-1' }],
    });

    const result = await enqueueDealEvidenceDocumentDetection('org-1', makeEnv(d1), {
      daysBack: 7,
      origin: 'test_scan',
    });

    expect(result).toMatchObject({ candidates: 1, enqueued: 1 });
    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'deal_evidence_detect',
      expect.objectContaining({
        source_type: 'document',
        source_id: 'doc-1',
        company_id: 'company-1',
        origin: 'test_scan',
      }),
      expect.objectContaining({ upstream: 'claude', max_attempts: 5 })
    );
    expect(d1.runs.some((r: any) =>
      r.sql.includes('INSERT INTO ingestion_incidents') &&
      r.binds.includes('deal_detection_coverage_lag')
    )).toBe(true);
    const candidateSql = d1.allCalls.find((r: any) => r.sql.includes('WITH candidates AS'))?.sql || '';
    expect(candidateSql).toContain("q.status = 'completed'");
    expect(candidateSql).toContain("q.idempotency_key = d.org_id || ':document:' || d.id || ':' || co.id || ':deal_evidence_detect:v1'");
  });

  it('resolves deal document coverage incidents when no unprocessed candidates remain', async () => {
    const d1 = makeD1Mock({ dealDocumentCandidates: [] });

    const result = await enqueueDealEvidenceDocumentDetection('org-1', makeEnv(d1), {
      daysBack: 7,
      origin: 'test_scan',
    });

    expect(result).toMatchObject({ candidates: 0, enqueued: 0 });
    expect(enqueueWorkMock).not.toHaveBeenCalled();
    expect(d1.runs.some((r: any) =>
      r.sql.includes('UPDATE ingestion_incidents') &&
      r.binds.includes('deal_evidence') &&
      r.binds.includes('org-1')
    )).toBe(true);
  });
});

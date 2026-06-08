import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifiedItem } from '../src/types/interfaces';
import type { ProcessClassifiedStats } from '../src/lib/ingestion-shared';

const callClaudeMock = vi.hoisted(() => vi.fn());
const enqueueWorkMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/claude', () => ({
  callClaude: callClaudeMock,
}));

vi.mock('../src/lib/work-queue', () => ({
  enqueueWork: enqueueWorkMock,
}));

import { detectAndStageDealSignalsDetailed } from '../src/lib/deal-detection';
import { persistClassifiedStats } from '../src/lib/ingestion-shared';

function makeD1Mock() {
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
        async all() {
          allCalls.push({ sql, binds });
          return { results: [] };
        },
        async first() {
          firstCalls.push({ sql, binds });
          if (sql.includes('SELECT name FROM companies')) return { name: 'Acme AI' };
          return null;
        },
        async run() {
          runs.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

function makeDealCandidate(index: number): ClassifiedItem {
  const bodyText = [
    'Acme AI is raising a seed round with allocation available.',
    'The pitch deck includes diligence materials, valuation cap, lead investor notes, and check size guidance.',
    'Closing this month with a data room and term sheet discussion.',
  ].join(' ');

  return {
    type: 'email',
    source: 'outlook',
    externalId: `msg-${index}`,
    threadId: `thread-${index}`,
    subject: `Acme AI seed round ${index}`,
    bodyText,
    bodyPreview: bodyText.slice(0, 200),
    fromEmail: 'founder@acme.ai',
    sentAt: '2026-05-31T00:00:00.000Z',
    direction: 'inbound',
    orgId: 'org-1',
    visibility: 'private',
    entityType: 'conversation',
    entityId: `conv-${index}`,
    contactIds: [],
    companyId: 'company-1',
    participantUserIds: ['user-1'],
    metadata: {
      org_id: 'org-1',
      visibility: 'private',
      document_type: 'email',
      source_table: 'conversations',
      source_id: `conv-${index}`,
      r2_key: `org-1/conversations/conv-${index}.txt`,
      created_at: '2026-05-31T00:00:00.000Z',
      primary_entity_id: 'company-1',
    },
    text: bodyText,
  };
}

describe('deal detection overflow and metadata counters', () => {
  beforeEach(() => {
    callClaudeMock.mockReset().mockResolvedValue(JSON.stringify({
      is_deal: false,
      startup_company_name: null,
      funding_stage: null,
      amount_usd: null,
      signal_kind: null,
      confidence: 0.8,
      evidence: '',
    }));
    enqueueWorkMock.mockReset().mockResolvedValue({ inserted: true, id: 'wq-overflow' });
  });

  it('queues candidates beyond the LLM cap and records skip counters', async () => {
    const d1 = makeD1Mock();
    const items = Array.from({ length: 21 }, (_, i) => makeDealCandidate(i + 1));

    const stats = await detectAndStageDealSignalsDetailed(items, 'org-1', { D1: d1 } as any);

    expect(stats.deal_signals_staged).toBe(0);
    expect(stats.deal_candidates_seen).toBe(21);
    expect(stats.deal_candidates_scanned).toBe(20);
    expect(stats.deal_candidates_deferred).toBe(1);
    expect(stats.deal_skip_reasons).toMatchObject({
      llm_budget_overflow_deferred: 1,
      llm_not_deal: 20,
    });
    expect(callClaudeMock).toHaveBeenCalledTimes(20);
    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'deal_evidence_detect',
      expect.objectContaining({
        source_type: 'conversation',
        source_id: 'conv-21',
        company_id: 'company-1',
        origin: 'llm_budget_overflow',
      }),
      expect.objectContaining({ upstream: 'claude', max_attempts: 5 })
    );

    const syncStats: ProcessClassifiedStats = {
      items_total: 21,
      items_staged: 21,
      items_embedded: 21,
      embed_failures: 0,
      attachments_attempted: 0,
      attachments_processed: 0,
      attachments_skipped: 0,
      attachments_failed: 0,
      deal_signals_staged: stats.deal_signals_staged,
      deal_candidates_seen: stats.deal_candidates_seen,
      deal_candidates_scanned: stats.deal_candidates_scanned,
      deal_candidates_deferred: stats.deal_candidates_deferred,
      deal_skip_reasons: stats.deal_skip_reasons,
      prospect_signals_recorded: 0,
      prospects_upserted: 0,
      prospect_classifications_pending: 0,
      errors: [],
    };
    await persistClassifiedStats(syncStats, 'sync-1', { D1: d1 } as any);

    expect(d1.runs.some(r =>
      r.sql.includes("$.deal_candidates_seen") &&
      r.sql.includes("$.deal_candidates_deferred") &&
      r.binds.includes(21) &&
      r.binds.includes(1) &&
      r.binds.includes('sync-1')
    )).toBe(true);

    const skipReasonUpdate = d1.runs.find(r => r.sql.includes("$.deal_skip_reasons"));
    expect(skipReasonUpdate?.binds[0]).toBe(JSON.stringify(stats.deal_skip_reasons));
    expect(skipReasonUpdate?.binds[1]).toBe('sync-1');
  });
});

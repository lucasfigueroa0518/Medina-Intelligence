import { describe, expect, it, vi, beforeEach } from 'vitest';

const enqueueProspectDetectSourceMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/work-queue-handlers/prospect-detect', () => ({
  enqueueProspectDetectSource: enqueueProspectDetectSourceMock,
  loadProspectDetectSource: vi.fn(),
}));

import { runProspectLiveCanary } from '../scripts/prospect-live-canary';

class LiveCanaryStatement {
  private binds: unknown[] = [];

  constructor(private readonly sql: string) {}

  bind(...args: unknown[]): LiveCanaryStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    const [orgId, , limit] = this.binds;
    if (orgId !== 'org-1') return { results: [] };
    if (!this.sql.includes('FROM conversations')) return { results: [] };
    return {
      results: [{
        source_type: 'conversation',
        source_id: 'conv-1',
        title: 'Intro to Auguria',
        occurred_at: '2026-06-01T10:00:00.000Z',
        source_label: 'outlook',
      }].slice(0, Number(limit || 1)) as T[],
    };
  }
}

class LiveCanaryFakeD1 {
  prepare(sql: string): LiveCanaryStatement {
    expect(sql).toMatch(/^\s*SELECT\b/i);
    return new LiveCanaryStatement(sql);
  }
}

describe('prospect live canary wrapper', () => {
  beforeEach(() => {
    enqueueProspectDetectSourceMock.mockReset().mockResolvedValue({ inserted: true, id: 'work-1' });
  });

  it('previews selected high-signal source rows without enqueuing by default', async () => {
    const summary = await runProspectLiveCanary({ D1: new LiveCanaryFakeD1() } as any, {
      orgId: 'org-1',
      sourceType: 'conversation',
      lookbackHours: 24,
      limit: 3,
      highSignal: true,
      enqueue: false,
      confirmProductionWrite: null,
    });

    expect(summary).toMatchObject({
      dry_run: true,
      source_count: 1,
      payload_count: 1,
      enqueued: 0,
      high_signal: true,
    });
    expect(summary.canary.rows_written).toBe(0);
    expect(summary.canary.changed_db).toBe(false);
    expect(enqueueProspectDetectSourceMock).not.toHaveBeenCalled();
  });

  it('refuses production enqueue without the exact GO token', async () => {
    await expect(runProspectLiveCanary({ D1: new LiveCanaryFakeD1() } as any, {
      orgId: 'org-1',
      sourceType: 'conversation',
      lookbackHours: 24,
      limit: 3,
      highSignal: true,
      enqueue: true,
      confirmProductionWrite: null,
    })).rejects.toThrow(/PROSPECT_LIVE_CANARY_REQUIRES_EXPLICIT_GO/);
    expect(enqueueProspectDetectSourceMock).not.toHaveBeenCalled();
  });

  it('enqueues only after the exact GO token is present', async () => {
    const summary = await runProspectLiveCanary({ D1: new LiveCanaryFakeD1() } as any, {
      orgId: 'org-1',
      sourceType: 'conversation',
      lookbackHours: 24,
      limit: 3,
      highSignal: true,
      enqueue: true,
      confirmProductionWrite: 'PROSPECT_LIVE_CANARY_GO',
    });

    expect(summary).toMatchObject({
      dry_run: false,
      source_count: 1,
      payload_count: 1,
      enqueued: 1,
      already_queued: 0,
    });
    expect(enqueueProspectDetectSourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        sourceType: 'conversation',
        sourceId: 'conv-1',
        origin: 'prospect_live_canary',
        ingestionMode: 'live',
        priority: 5,
      })
    );
  });
});

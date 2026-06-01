import { beforeEach, describe, expect, it, vi } from 'vitest';

const runProspectBackfillWindowMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/prospect-intelligence', () => ({
  runProspectBackfillWindow: runProspectBackfillWindowMock,
}));

import { runProspectBackfillWindowCli } from '../scripts/prospect-backfill-window';

class BackfillStatement {
  private binds: unknown[] = [];

  constructor(private readonly sql: string) {}

  bind(...args: unknown[]): BackfillStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    expect(this.sql).toMatch(/^\s*SELECT\b/i);
    const [orgId, , , limit] = this.binds;
    if (orgId !== 'org-1') return { results: [] };
    const prefix = this.sql.includes('FROM conversations')
      ? 'conv'
      : this.sql.includes('FROM events')
        ? 'event'
        : 'doc';
    return {
      results: Array.from({ length: Math.min(Number(limit || 1), 2) }, (_, index) => ({
        id: `${prefix}-${index + 1}`,
      })) as T[],
    };
  }
}

class BackfillFakeD1 {
  prepare(sql: string): BackfillStatement {
    return new BackfillStatement(sql);
  }
}

const smallWindow = {
  orgId: 'org-1',
  configPath: 'wrangler.toml',
  windowStart: '2026-06-01T00:00:00.000Z',
  windowEnd: '2026-06-01T12:00:00.000Z',
  sourceFamilies: ['conversation'] as Array<'conversation' | 'event' | 'document'>,
  batchLimit: 25,
  allowExpandedWindow: false,
};

describe('prospect backfill window wrapper', () => {
  beforeEach(() => {
    runProspectBackfillWindowMock.mockReset().mockResolvedValue({
      run_id: 'run-1',
      window_start: smallWindow.windowStart,
      window_end: smallWindow.windowEnd,
      items_found: 2,
      items_processed: 2,
      signals_recorded: 1,
      prospects_upserted: 1,
      classifications_pending: 0,
      source_families: ['conversation'],
      reconciliation: {
        scanned: 1,
        converted: 0,
        duplicate_links: 0,
        resolved_soft_states: 0,
        pending_classifications: 0,
      },
    });
  });

  it('previews candidate source rows without running the write backfill by default', async () => {
    const summary = await runProspectBackfillWindowCli({ D1: new BackfillFakeD1() } as any, {
      ...smallWindow,
      apply: false,
      confirmProductionWrite: null,
    });

    expect(summary).toMatchObject({
      dry_run: true,
      org_id: 'org-1',
      window_hours: 12,
      total_candidates: 2,
      result: null,
    });
    expect(summary.source_preview[0]).toMatchObject({
      source_family: 'conversation',
      candidate_count: 2,
      sample_source_ids: ['conv-1', 'conv-2'],
    });
    expect(runProspectBackfillWindowMock).not.toHaveBeenCalled();
  });

  it('refuses write mode without the exact GO token', async () => {
    await expect(runProspectBackfillWindowCli({ D1: new BackfillFakeD1() } as any, {
      ...smallWindow,
      apply: true,
      confirmProductionWrite: null,
    })).rejects.toThrow(/PROSPECT_BACKFILL_REQUIRES_EXPLICIT_GO/);
    expect(runProspectBackfillWindowMock).not.toHaveBeenCalled();
  });

  it('refuses broad write windows unless explicitly expanded', async () => {
    await expect(runProspectBackfillWindowCli({ D1: new BackfillFakeD1() } as any, {
      ...smallWindow,
      windowEnd: '2026-06-03T00:00:00.000Z',
      apply: true,
      confirmProductionWrite: 'PROSPECT_BACKFILL_GO',
    })).rejects.toThrow(/PROSPECT_BACKFILL_WINDOW_TOO_LARGE/);
    expect(runProspectBackfillWindowMock).not.toHaveBeenCalled();
  });

  it('refuses broad write batches unless explicitly expanded', async () => {
    await expect(runProspectBackfillWindowCli({ D1: new BackfillFakeD1() } as any, {
      ...smallWindow,
      batchLimit: 75,
      apply: true,
      confirmProductionWrite: 'PROSPECT_BACKFILL_GO',
    })).rejects.toThrow(/PROSPECT_BACKFILL_BATCH_TOO_LARGE/);
    expect(runProspectBackfillWindowMock).not.toHaveBeenCalled();
  });

  it('runs a small write window only with the exact GO token', async () => {
    const summary = await runProspectBackfillWindowCli({ D1: new BackfillFakeD1() } as any, {
      ...smallWindow,
      apply: true,
      confirmProductionWrite: 'PROSPECT_BACKFILL_GO',
    });

    expect(summary.dry_run).toBe(false);
    expect(summary.result).toMatchObject({ run_id: 'run-1' });
    expect(runProspectBackfillWindowMock).toHaveBeenCalledWith(
      'org-1',
      expect.anything(),
      expect.objectContaining({
        windowStart: smallWindow.windowStart,
        windowEnd: smallWindow.windowEnd,
        sourceFamilies: ['conversation'],
        batchLimit: 25,
      })
    );
  });
});

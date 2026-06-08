import { beforeEach, describe, expect, it, vi } from 'vitest';

const runHistoricalBackfillMock = vi.hoisted(() => vi.fn());

vi.mock('../src/integrations/outlook', () => ({
  runHistoricalBackfill: runHistoricalBackfillMock,
}));

import { driveProgressiveBackfill } from '../src/lib/progressive-backfill';

function makeEnv() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const firstCalls: Array<{ sql: string; binds: unknown[] }> = [];
  const kvDeletes: string[] = [];

  const env = {
    D1: {
      prepare(sql: string) {
        let binds: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            binds = args;
            return this;
          },
          async first() {
            firstCalls.push({ sql, binds });
            if (sql.includes('FROM progressive_backfill_jobs') && sql.includes("status = 'active'")) {
              return { id: 'parent-1', total_windows: 1 };
            }
            if (sql.includes('FROM progressive_backfill_windows') && sql.includes("status IN ('pending','in_progress')")) {
              return {
                id: 'window-1',
                parent_id: 'parent-1',
                window_index: 0,
                start_date: '2026-05-01T00:00:00.000Z',
                end_date: '2026-05-10T00:00:00.000Z',
                status: 'in_progress',
                emails_fetched: 0,
                conversations_added: 0,
                embedded_count: 0,
                started_at: '2026-05-01T00:00:00.000Z',
                completed_at: null,
                last_error: null,
              };
            }
            return null;
          },
          async run() {
            runs.push({ sql, binds });
            return { meta: { changes: 1 } };
          },
          async all() {
            return { results: [] };
          },
        };
      },
    },
    KV: {
      async delete(key: string) { kvDeletes.push(key); },
      async put() {},
      async get() { return null; },
    },
  };

  return { env: env as any, runs, firstCalls, kvDeletes };
}

describe('driveProgressiveBackfill', () => {
  beforeEach(() => {
    runHistoricalBackfillMock.mockReset();
  });

  it('marks a failed runHistoricalBackfill result terminal and clears resume state', async () => {
    runHistoricalBackfillMock.mockResolvedValue({
      status: 'failed',
      error: 'Graph API error: 400',
      total_fetched: 0,
      last_page_url: 'https://graph.example/bad-cursor',
    });
    const { env, runs, kvDeletes } = makeEnv();

    const result = await driveProgressiveBackfill('org-1', 'user-1', env);

    expect(result).toMatchObject({ advanced: true, status: 'failed', window_index: 0 });
    expect(kvDeletes).toContain('backfill_progress:user-1');
    expect(runs.some(r =>
      r.sql.includes('UPDATE progressive_backfill_windows') &&
      r.sql.includes("status = 'failed'") &&
      r.binds.includes('Graph API error: 400')
    )).toBe(true);
    expect(runs.some(r =>
      r.sql.includes('UPDATE progressive_backfill_jobs') &&
      r.sql.includes("status = 'failed'") &&
      r.binds.includes('parent-1')
    )).toBe(true);
    expect(runs.some(r =>
      r.sql.includes('INSERT INTO ingestion_incidents') &&
      r.binds.includes('progressive_backfill_terminal_graph_error')
    )).toBe(true);
  });
});

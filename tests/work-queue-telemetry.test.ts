import { describe, expect, it } from 'vitest';
import { withTaskRun } from '../src/lib/task-runs';

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
      };
    },
  };
}

describe('work queue task-run telemetry', () => {
  it('persists partial tick representative error and affected work item IDs', async () => {
    const d1 = makeD1Mock();

    const result = await withTaskRun(
      { D1: d1 } as any,
      'org-1',
      'work_queue_tick',
      async ctx => {
        ctx.report({
          items_processed: 3,
          items_failed: 1,
          last_error: 'attachment_backfill:work-42 graph 429: throttled',
          metadata: {
            top_failing_domain: 'attachment_backfill',
            sample_error: 'graph 429: throttled',
            affected_work_queue_ids: ['work-42', 'work-43'],
          },
        });
        return { ok: true };
      },
      { idempotencyKey: 'work_queue_tick:2026-05-31T12:00' }
    );

    expect(result).toEqual({ ok: true });
    const close = d1.runs.find(r =>
      r.sql.includes('UPDATE task_runs SET') &&
      r.sql.includes('last_error = ?') &&
      r.sql.includes('metadata = ?')
    );
    expect(close?.binds[0]).toBe('partial');
    expect(close?.binds[1]).toBe(3);
    expect(close?.binds[2]).toBe(1);
    expect(close?.binds[4]).toBe('attachment_backfill:work-42 graph 429: throttled');
    const metadata = JSON.parse(String(close?.binds[5]));
    expect(metadata).toMatchObject({
      top_failing_domain: 'attachment_backfill',
      sample_error: 'graph 429: throttled',
      affected_work_queue_ids: ['work-42', 'work-43'],
    });
  });
});

import { describe, expect, it } from 'vitest';

import { runProspectBackfillEnqueue } from '../scripts/prospect-backfill-enqueue';

class EnqueueFakeExecutor {
  meta = { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false };
  sqls: string[] = [];

  constructor(private readonly counts: Record<string, number> = {}) {}

  async execute<T = any>(sql: string): Promise<{ results: T[]; meta?: any }> {
    this.sqls.push(sql);
    this.meta.query_count += 1;
    if (/INSERT/i.test(sql)) {
      this.meta.changed_db = true;
      const inserted = sql.includes("'conversation'")
        ? Number(this.counts.conversationInsert ?? 0)
        : sql.includes("'event'")
          ? Number(this.counts.eventInsert ?? 0)
          : sql.includes("'document'")
            ? Number(this.counts.documentInsert ?? 0)
            : 1;
      this.meta.rows_written += inserted;
      return { results: [] as T[], meta: { rows_written: inserted, changed_db: true } };
    }
    if (/FROM work_queue[\s\S]*GROUP BY status/i.test(sql)) {
      return { results: [{ status: 'pending', count: 3 }] as T[], meta: { rows_written: 0, changed_db: false } };
    }
    if (/json_extract\(payload, '\$\.backfill_run_id'\)/i.test(sql)) {
      const family = sql.includes("'conversation'")
        ? 'conversation'
        : sql.includes("'event'")
          ? 'event'
          : 'document';
      return { results: [{ count: Number(this.counts[`${family}Inserted`] ?? 0) }] as T[], meta: { rows_written: 0, changed_db: false } };
    }
    const family = sql.includes('FROM conversations')
      ? 'conversation'
      : sql.includes('FROM events')
        ? 'event'
        : 'document';
    const isAlreadyQueued = /EXISTS\s*\(/i.test(sql);
    const key = `${family}${isAlreadyQueued ? 'Already' : 'Count'}`;
    return {
      results: [{ count: Number(this.counts[key] ?? 0) }] as T[],
      meta: { rows_written: 0, changed_db: false },
    };
  }
}

const baseArgs = {
  orgId: 'org-1',
  database: 'db-1',
  windowStart: '2026-05-26T00:00:00.000Z',
  windowEnd: '2026-06-02T00:00:00.000Z',
  sourceFamilies: ['conversation', 'event', 'document'],
  apply: false,
  confirmProductionWrite: null,
  maxSourceRows: 10_000,
  priority: 20,
  scheduleRatePerMinute: 3,
  origin: 'prospect_backfill_large',
} as const;

describe('prospect large backfill enqueue launcher', () => {
  it('previews the full source body without writing by default', async () => {
    const executor = new EnqueueFakeExecutor({
      conversationCount: 12,
      conversationAlready: 2,
      eventCount: 3,
      documentCount: 4,
    });

    const summary = await runProspectBackfillEnqueue(baseArgs as any, executor as any);

    expect(summary).toMatchObject({
      dry_run: true,
      total_candidates: 19,
      total_already_queued: 2,
      total_inserted: 0,
    });
    expect(executor.sqls.some(sql => /INSERT/i.test(sql))).toBe(false);
  });

  it('refuses production enqueue without the exact GO token', async () => {
    const executor = new EnqueueFakeExecutor({ conversationCount: 1 });

    await expect(runProspectBackfillEnqueue({
      ...baseArgs,
      sourceFamilies: ['conversation'],
      apply: true,
      confirmProductionWrite: null,
    } as any, executor as any)).rejects.toThrow(/PROSPECT_BACKFILL_ENQUEUE_REQUIRES_EXPLICIT_GO/);
  });

  it('refuses source bodies beyond the configured max row guard', async () => {
    const executor = new EnqueueFakeExecutor({ conversationCount: 101 });

    await expect(runProspectBackfillEnqueue({
      ...baseArgs,
      sourceFamilies: ['conversation'],
      apply: true,
      confirmProductionWrite: 'PROSPECT_BACKFILL_ENQUEUE_GO',
      maxSourceRows: 100,
    } as any, executor as any)).rejects.toThrow(/PROSPECT_BACKFILL_ENQUEUE_TOO_LARGE/);
  });

  it('bulk-enqueues with stable idempotency keys and scheduled pacing', async () => {
    const executor = new EnqueueFakeExecutor({
      conversationCount: 2,
      conversationInsert: 10,
      conversationInserted: 2,
    });

    const summary = await runProspectBackfillEnqueue({
      ...baseArgs,
      sourceFamilies: ['conversation'],
      apply: true,
      confirmProductionWrite: 'PROSPECT_BACKFILL_ENQUEUE_GO',
    } as any, executor as any);

    expect(summary.total_inserted).toBe(2);
    const insertSql = executor.sqls.find(sql => /INSERT OR IGNORE INTO work_queue/i.test(sql)) || '';
    expect(insertSql).toContain("'prospect_detect'");
    expect(insertSql).toContain("':conversation:'");
    expect(insertSql).toContain("':prospect_detect:v1'");
    expect(insertSql).toContain("'ingestion_mode', 'backfill'");
    expect(insertSql).toContain("'origin', 'prospect_backfill_large'");
    expect(insertSql).toContain("printf('+%d minutes'");
    expect(insertSql).toContain('/ 3');
  });
});

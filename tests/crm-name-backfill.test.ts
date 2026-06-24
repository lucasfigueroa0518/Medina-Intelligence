import { describe, expect, it } from 'vitest';

import {
  CRM_NAME_BACKFILL_DOMAIN,
  DEFAULT_CRM_NAME_BACKFILL_SHARDS,
  selectCrmNameBackfillShardPage,
  startCrmNameBackfillRun,
} from '../src/lib/crm-name-backfill';
import { crmNameBackfillHandler } from '../src/lib/work-queue-handlers/crm-name-backfill';

class FakePreparedStatement {
  constructor(private db: FakeD1, private sql: string) {}
  bind(...binds: unknown[]) {
    const db = this.db;
    const sql = this.sql;
    return {
      async first<T>() {
        return db.first<T>(sql, binds);
      },
      async run() {
        db.run(sql, binds);
        return { meta: { changes: 1 } };
      },
      async all<T>() {
        return { results: db.all<T>(sql, binds) };
      },
    };
  }
}

class FakeD1 {
  runs: any[] = [];
  work: any[] = [];

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }

  first<T>(sql: string, binds: unknown[]): T | null {
    if (/SELECT id FROM crm_name_backfill_runs/i.test(sql)) {
      return null;
    }
    if (/INSERT INTO work_queue/i.test(sql)) {
      const [orgId, domain, payload, upstream, idempotencyKey, priority, maxAttempts, nextAttemptAt] = binds;
      const existing = this.work.find(row => row.domain === domain && row.idempotency_key === idempotencyKey);
      if (existing) return null;
      const row = {
        id: `work-${this.work.length + 1}`,
        org_id: orgId,
        domain,
        payload,
        upstream,
        idempotency_key: idempotencyKey,
        priority,
        max_attempts: maxAttempts,
        next_attempt_at: nextAttemptAt,
      };
      this.work.push(row);
      return { id: row.id } as T;
    }
    if (/SELECT id FROM work_queue/i.test(sql)) {
      const [domain, idempotencyKey] = binds;
      const existing = this.work.find(row => row.domain === domain && row.idempotency_key === idempotencyKey);
      return existing ? ({ id: existing.id } as T) : null;
    }
    return null;
  }

  run(sql: string, binds: unknown[]) {
    if (/INSERT INTO crm_name_backfill_runs/i.test(sql)) {
      const [id, orgId, mode, shardCount, requestedBy] = binds;
      this.runs.push({ id, org_id: orgId, status: 'queued', mode, shard_count: shardCount, requested_by: requestedBy });
    }
  }

  all<T>(_sql: string, _binds: unknown[]): T[] {
    return [];
  }
}

describe('CRM name backfill rollout infrastructure', () => {
  it('registers a vetted 24-shard queue handler', () => {
    expect(crmNameBackfillHandler.domain).toBe(CRM_NAME_BACKFILL_DOMAIN);
    expect(crmNameBackfillHandler.batchSize).toBe(24);
    expect(crmNameBackfillHandler.maxConcurrent).toBe(24);
    expect(crmNameBackfillHandler.processConcurrency).toBe(24);
    expect(crmNameBackfillHandler.claimBatchCap).toBe(24);
  });

  it('starts a dry-run with 24 shards for both companies and contacts', async () => {
    const db = new FakeD1();
    const env = { D1: db } as any;
    const result = await startCrmNameBackfillRun({
      env,
      orgId: 'org-1',
      requestedBy: 'user-1',
      mode: 'dry_run',
      shardCount: DEFAULT_CRM_NAME_BACKFILL_SHARDS,
    });

    expect(result.shard_count).toBe(24);
    expect(result.enqueued).toBe(48);
    expect(db.runs).toHaveLength(1);
    expect(db.work).toHaveLength(48);
    const payloads = db.work.map(row => JSON.parse(row.payload));
    expect(payloads.filter(row => row.entity_type === 'company')).toHaveLength(24);
    expect(payloads.filter(row => row.entity_type === 'contact')).toHaveLength(24);
    expect(new Set(payloads.map(row => `${row.entity_type}:${row.shard_index}`)).size).toBe(48);
  });

  it('refuses apply mode unless the explicit apply flag is enabled', async () => {
    const env = { D1: new FakeD1(), CRM_NAME_BACKFILL_APPLY_ENABLED: 'false' } as any;
    await expect(startCrmNameBackfillRun({
      env,
      orgId: 'org-1',
      requestedBy: 'user-1',
      mode: 'apply',
    })).rejects.toThrow('CRM_NAME_BACKFILL_APPLY_DISABLED');
  });

  it('requires a source run for reviewed-results mode', async () => {
    const env = { D1: new FakeD1(), CRM_NAME_BACKFILL_APPLY_ENABLED: 'false' } as any;
    await expect(startCrmNameBackfillRun({
      env,
      orgId: 'org-1',
      requestedBy: 'user-1',
      mode: 'dry_run',
      applyStrategy: 'reviewed_results',
    })).rejects.toThrow('CRM_NAME_BACKFILL_SOURCE_RUN_REQUIRED');
  });

  it('threads reviewed-results source run metadata into every shard payload', async () => {
    const db = new FakeD1();
    const env = { D1: db } as any;
    const result = await startCrmNameBackfillRun({
      env,
      orgId: 'org-1',
      requestedBy: 'user-1',
      mode: 'dry_run',
      shardCount: 3,
      applyStrategy: 'reviewed_results',
      sourceRunId: 'source-run-1',
    });

    expect(result.apply_strategy).toBe('reviewed_results');
    expect(result.source_run_id).toBe('source-run-1');
    expect(db.work).toHaveLength(6);
    for (const row of db.work) {
      const payload = JSON.parse(row.payload);
      expect(payload.apply_strategy).toBe('reviewed_results');
      expect(payload.source_run_id).toBe('source-run-1');
    }
  });

  it('does not advance a shard cursor past uninspected rows when a chunk fills mid-page', () => {
    const candidates = Array.from({ length: 200 }, (_, i) => ({
      id: `entity-${String(i).padStart(4, '0')}`,
    }));

    const page = [0, 1, 2, 3]
      .map(shardIndex => selectCrmNameBackfillShardPage({
        candidates,
        shardIndex,
        shardCount: 4,
        remaining: 1,
      }))
      .find(result => result.selected.length === 1 && result.cursor !== candidates[candidates.length - 1].id);

    expect(page).toBeTruthy();
    expect(page!.cursor).toBe(page!.selected[0].id);
    expect(page!.inspected).toBeLessThan(candidates.length);
  });
});

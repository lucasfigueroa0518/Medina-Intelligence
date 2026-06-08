import { describe, expect, it } from 'vitest';
import { buildProspectPipelineHealth } from '../scripts/prospect-pipeline-health';

class HealthStatement {
  private binds: unknown[] = [];

  constructor(private readonly sql: string) {
    expect(sql).toMatch(/^\s*SELECT\b/i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|VACUUM)\b/i);
  }

  bind(...args: unknown[]): HealthStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    expect(this.binds[0]).toBe('org-1');
    if (this.sql.includes('FROM work_queue')) {
      return {
        results: [
          { status: 'dead_letter', count: 1 },
          { status: 'failed', count: 2 },
          { status: 'pending', count: 3 },
        ] as T[],
      };
    }
    if (this.sql.includes('FROM upstream_budget_ledger')) {
      return {
        results: [
          { upstream: 'claude', circuit_open_until: '2026-06-01T12:00:00.000Z' },
        ] as T[],
      };
    }
    return { results: [] };
  }

  async first<T = any>(): Promise<T | null> {
    if (this.sql.includes('FROM work_queue')) {
      return { count: 4 } as T;
    }
    if (this.sql.includes('FROM prospect_signals')) {
      return {
        pending_classifications: 5,
        classifier_errors: 2,
        known_deal_attaches: 7,
        context_signals: 11,
        ignored_or_noise_signals: 13,
      } as T;
    }
    if (this.sql.includes('FROM prospects')) {
      return {
        new_prospects: 17,
        provisional_prospects: 19,
      } as T;
    }
    return null;
  }
}

class HealthFakeD1 {
  prepare(sql: string): HealthStatement {
    return new HealthStatement(sql);
  }

  async batch(): Promise<never> {
    throw new Error('batch should never be called');
  }
}

describe('prospect pipeline health monitor', () => {
  it('uses SELECT-only queries and reports rollout health counters', async () => {
    const summary = await buildProspectPipelineHealth('org-1', { D1: new HealthFakeD1() } as any, {
      daysBack: 7,
    });

    expect(summary).toMatchObject({
      read_only: true,
      org_id: 'org-1',
      days_back: 7,
      dead_letters: 1,
      failed_or_pending: 5,
      rate_limit_deferrals: 4,
      classifier_errors: 2,
      pending_classifications: 5,
      new_prospects: 17,
      known_deal_attaches: 7,
      provisional_prospects: 19,
      context_signals: 11,
      ignored_or_noise_signals: 13,
    });
    expect(summary.open_classifier_circuits).toEqual([
      { upstream: 'claude', circuit_open_until: '2026-06-01T12:00:00.000Z' },
    ]);
    expect(summary.work_queue).toEqual([
      { status: 'dead_letter', count: 1 },
      { status: 'failed', count: 2 },
      { status: 'pending', count: 3 },
    ]);
  });
});

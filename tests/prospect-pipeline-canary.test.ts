import { describe, expect, it } from 'vitest';
import {
  buildProspectPipelineCanarySummary,
  buildProspectPipelineRemoteCanarySummary,
  buildProspectPipelineRemoteReadCommands,
} from '../scripts/prospect-pipeline-canary';

class CanaryStatement {
  private binds: unknown[] = [];

  constructor(private readonly db: CanaryFakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): CanaryStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.binds) as T[] };
  }
}

class CanaryFakeD1 {
  prepare(sql: string): CanaryStatement {
    return new CanaryStatement(this, sql);
  }

  all(sql: string, binds: unknown[]): any[] {
    const [orgId] = binds;
    if (sql.includes('FROM conversations')) {
      return [
        {
          source_type: 'conversation',
          source_id: 'conv-1',
          title: 'Intro to Auguria',
          occurred_at: '2026-06-01T10:00:00.000Z',
          source_label: 'outlook',
        },
      ].filter(row => orgId === 'org-1');
    }
    if (sql.includes('FROM events')) {
      return [
        {
          source_type: 'event',
          source_id: 'event-1',
          title: 'Qunnect diligence',
          occurred_at: '2026-06-01T11:00:00.000Z',
          source_label: 'firefly',
        },
      ].filter(row => orgId === 'org-1');
    }
    if (sql.includes('FROM documents')) {
      return [
        {
          source_type: 'document',
          source_id: 'doc-1',
          title: 'Sativa pitch deck',
          occurred_at: '2026-06-01T09:00:00.000Z',
          source_label: 'deal_pitch',
        },
      ].filter(row => orgId === 'org-1');
    }
    return [];
  }
}

describe('prospect pipeline canary dry run', () => {
  it('builds deterministic queue payloads without declaring any writes', async () => {
    const summary = await buildProspectPipelineCanarySummary(
      { D1: new CanaryFakeD1() } as any,
      { orgId: 'org-1', sourceType: 'all', lookbackHours: 24, limit: 5 }
    );

    expect(summary).toMatchObject({
      dry_run: true,
      read_mode: 'platform_proxy',
      rows_written: 0,
      changed_db: false,
      remote_d1_meta: null,
      org_id: 'org-1',
    });
    expect(summary.sources.map(row => row.source_id)).toEqual(['event-1', 'conv-1', 'doc-1']);
    expect(summary.queue_payloads).toEqual([
      expect.objectContaining({ source_type: 'event', source_id: 'event-1', origin: 'prospect_pipeline_canary', ingestion_mode: 'live' }),
      expect.objectContaining({ source_type: 'conversation', source_id: 'conv-1', origin: 'prospect_pipeline_canary', ingestion_mode: 'live' }),
      expect.objectContaining({ source_type: 'document', source_id: 'doc-1', origin: 'prospect_pipeline_canary', ingestion_mode: 'live' }),
    ]);
  });

  it('can scope the dry run to one source family', async () => {
    const summary = await buildProspectPipelineCanarySummary(
      { D1: new CanaryFakeD1() } as any,
      { orgId: 'org-1', sourceType: 'document', lookbackHours: 24, limit: 5 }
    );

    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0]).toMatchObject({ source_type: 'document', source_id: 'doc-1' });
  });

  it('builds remote SELECT commands only for the D1 proof mode', () => {
    const commands = buildProspectPipelineRemoteReadCommands({
      orgId: "org-1's team",
      sourceType: 'all',
      lookbackHours: 24,
      limit: 5,
    });

    expect(commands).toHaveLength(3);
    expect(commands.every(command => /^\s*SELECT\b/i.test(command))).toBe(true);
    expect(commands.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    expect(commands.join('\n')).toContain("org-1''s team");
  });

  it('includes Cloudflare D1 read metadata in the remote proof summary', () => {
    const summary = buildProspectPipelineRemoteCanarySummary({
      orgId: 'org-1',
      sourceType: 'conversation',
      lookbackHours: 24,
      limit: 5,
      sources: [{
        source_type: 'conversation',
        source_id: 'conv-1',
        title: 'Intro to Auguria',
        occurred_at: '2026-06-01T10:00:00.000Z',
        source_label: 'outlook',
      }],
      remoteMeta: {
        rows_read: 1,
        rows_written: 0,
        changed_db: false,
        query_count: 1,
      },
    });

    expect(summary).toMatchObject({
      dry_run: true,
      read_mode: 'wrangler_d1_remote_select',
      rows_written: 0,
      changed_db: false,
      remote_d1_meta: {
        rows_read: 1,
        rows_written: 0,
        changed_db: false,
        query_count: 1,
      },
    });
    expect(summary.queue_payloads[0]).toMatchObject({
      source_type: 'conversation',
      source_id: 'conv-1',
      origin: 'prospect_pipeline_canary',
      ingestion_mode: 'live',
    });
  });
});

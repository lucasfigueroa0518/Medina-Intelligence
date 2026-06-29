import { describe, expect, it } from 'vitest';
import {
  closeSyncJob,
  openSyncJob,
  patchSyncJobMetadata,
  reconcileStaleOperationalSyncJobs,
  touchSyncJob,
} from '../src/lib/sync-job-lifecycle';

function makeD1Mock(options: { staleRows?: unknown[]; updateChanges?: number } = {}) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const allCalls: Array<{ sql: string; binds: unknown[] }> = [];

  const d1 = {
    runs,
    allCalls,
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          return this;
        },
        async run() {
          runs.push({ sql, binds });
          return { meta: { changes: options.updateChanges ?? 1 } };
        },
        async all() {
          allCalls.push({ sql, binds });
          if (sql.includes('FROM sync_jobs')) return { results: options.staleRows || [] };
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
    },
  };
  return d1;
}

function makeEnv(d1: any): any {
  return {
    D1: d1,
    KV: { async get() { return null; }, async put() {}, async delete() {} },
  };
}

describe('sync job lifecycle', () => {
  it('opens, patches, and closes sync jobs with timeout and metadata semantics', async () => {
    const d1 = makeD1Mock();
    const env = makeEnv(d1);

    const id = await openSyncJob(env, {
      id: 'job-1',
      orgId: 'org-1',
      workflowType: 'webhook',
      timeoutMinutes: 7,
      metadata: { phase: 'start' },
    });
    await patchSyncJobMetadata(env, id, { phase: 'middle', pages: 2 });
    await touchSyncJob(env, id, { phase: 'still-working' }, 9);
    await closeSyncJob(env, id, {
      status: 'partial',
      metadata: { phase: 'done' },
      errorMessage: 'some attachment failures',
    });

    expect(id).toBe('job-1');
    const insert = d1.runs.find((r: any) => r.sql.includes('INSERT INTO sync_jobs'));
    expect(insert?.binds[0]).toBe('job-1');
    expect(insert?.binds[2]).toBe('webhook');
    expect(typeof insert?.binds[4]).toBe('string');
    expect(insert?.binds[5]).toContain('"phase":"start"');

    const patch = d1.runs.find((r: any) => r.sql.includes('json_patch') && r.sql.includes('WHERE id = ?') && r.binds.includes('job-1'));
    expect(patch?.binds[0]).toContain('"phase":"middle"');

    const touch = d1.runs.find((r: any) =>
      r.sql.includes('timeout_at = ?') &&
      r.sql.includes("status = 'running'") &&
      r.binds.includes('job-1')
    );
    expect(touch?.binds[1]).toContain('"phase":"still-working"');
    expect(touch?.binds[1]).toContain('"heartbeat_at"');

    const close = d1.runs.find((r: any) => r.sql.includes('timeout_at = NULL') && r.sql.includes('error_message = ?'));
    expect(close?.binds).toContain('partial');
    expect(close?.binds).toContain('some attachment failures');
    expect(close?.binds).toContain('job-1');
  });

  it('reconciles stale operational jobs and reports incidents with workflow-specific codes', async () => {
    const d1 = makeD1Mock({
      staleRows: [
        {
          id: 'webhook-job',
          org_id: 'org-1',
          workflow_type: 'webhook',
          started_at: '2026-05-31T12:00:00.000Z',
          created_at: '2026-05-31T12:00:00.000Z',
          timeout_at: '2026-05-31T12:10:00.000Z',
          metadata: '{}',
        },
        {
          id: 'progressive-job',
          org_id: 'org-1',
          workflow_type: 'progressive-backfill-window',
          started_at: '2026-05-31T12:00:00.000Z',
          created_at: '2026-05-31T12:00:00.000Z',
          timeout_at: '2026-05-31T12:10:00.000Z',
          metadata: '{}',
        },
        {
          id: 'attachment-job',
          org_id: 'org-1',
          workflow_type: 'attachment_backfill',
          started_at: '2026-05-31T12:00:00.000Z',
          created_at: '2026-05-31T12:00:00.000Z',
          timeout_at: '2026-05-31T12:10:00.000Z',
          metadata: '{}',
        },
      ],
    });

    const result = await reconcileStaleOperationalSyncJobs(makeEnv(d1), {
      maxAgeMinutes: 10,
      limit: 10,
    });

    expect(result).toEqual({
      reconciled: 3,
      sampled_ids: ['webhook-job', 'progressive-job', 'attachment-job'],
    });
    expect(d1.runs.filter((r: any) =>
      r.sql.includes('UPDATE sync_jobs') &&
      r.sql.includes("status = 'failed'")
    )).toHaveLength(3);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('INSERT INTO ingestion_incidents') &&
      r.binds.includes('webhook_sync_job_stale')
    )).toBe(true);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('INSERT INTO ingestion_incidents') &&
      r.binds.includes('progressive_backfill_terminal_graph_error')
    )).toBe(true);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('INSERT INTO ingestion_incidents') &&
      r.binds.includes('attachment_backfill_sync_job_stale')
    )).toBe(true);
  });
});

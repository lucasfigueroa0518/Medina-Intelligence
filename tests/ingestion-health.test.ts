import { describe, expect, it } from 'vitest';
import {
  incidentsToUserWarnings,
  reportIngestionFailure,
  scanAndRepairIngestion,
  type IngestionIncident,
} from '../src/lib/ingestion-health';

function makeD1Mock(options: {
  users?: unknown[];
  deadLetters?: unknown[];
  slackChannelErrors?: unknown[];
  activeIncidents?: unknown[];
} = {}) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const allCalls: Array<{ sql: string; binds: unknown[] }> = [];
  const firstCalls: Array<{ sql: string; binds: unknown[] }> = [];

  const d1 = {
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
        async run() {
          runs.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
        async all() {
          allCalls.push({ sql, binds });
          if (sql.includes('FROM users WHERE org_id')) return { results: options.users || [] };
          if (sql.includes("status = 'dead_letter'")) return { results: options.deadLetters || [] };
          if (sql.includes('FROM slack_channels') && sql.includes('last_error IS NOT NULL')) {
            return { results: options.slackChannelErrors || [] };
          }
          if (sql.includes('FROM ingestion_incidents')) return { results: options.activeIncidents || [] };
          return { results: [] };
        },
        async first() {
          firstCalls.push({ sql, binds });
          return null;
        },
      };
    },
  };
  return d1;
}

function makeEnv(d1: any, kvValues: Record<string, unknown> = {}): any {
  return {
    D1: d1,
    AZURE_CLIENT_ID: 'client-id',
    AZURE_TENANT_ID: 'tenant-id',
    AZURE_CLIENT_CERT_PRIVATE_KEY: 'pem',
    AZURE_CLIENT_CERT_THUMBPRINT: 'thumbprint',
    KV: {
      async get(key: string) { return kvValues[key] ?? null; },
      async put() {},
      async delete() {},
    },
  };
}

describe('ingestion health', () => {
  it('promotes critical incidents into non-dismissible user warnings', () => {
    const warning = incidentsToUserWarnings([
      {
        id: 'inc-1',
        org_id: 'org-1',
        source: 'calendar',
        scope_type: 'user',
        scope_id: 'user-1',
        status: 'blocked',
        severity: 'critical',
        code: 'outlook_reauth_required',
        title: 'Calendar reconnect required',
        message: 'Calendar ingestion is blocked.',
        first_seen_at: '2026-05-01T00:00:00.000Z',
        last_seen_at: '2026-05-23T00:00:00.000Z',
        resolved_at: null,
        last_success_at: null,
        human_action_required: 1,
        recovery_status: 'blocked_on_auth',
        recovery_window_start: null,
        recovery_window_end: null,
        repair_attempt_count: 0,
        last_repair_at: null,
        metadata: '{}',
      } satisfies IngestionIncident,
    ]);

    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({
      source: 'calendar',
      severity: 'critical',
      human_action_required: true,
      recovery_status: 'blocked_on_auth',
    });
  });

  it('records auth-blocked failures as human-action critical incidents', async () => {
    const d1 = makeD1Mock();
    await reportIngestionFailure(makeEnv(d1), {
      orgId: 'org-1',
      source: 'outlook_email',
      scopeType: 'user',
      scopeId: 'user-1',
      code: 'outlook_reauth_required',
      message: 'Outlook reconnect required',
      humanActionRequired: true,
    });

    const incidentInsert = d1.runs.find((r: any) => r.sql.includes('INSERT INTO ingestion_incidents'));
    expect(incidentInsert).toBeTruthy();
    expect(incidentInsert.binds).toContain('blocked');
    expect(incidentInsert.binds).toContain('critical');
    expect(incidentInsert.binds).toContain(1);
    expect(incidentInsert.binds).toContain('blocked_on_auth');
  });

  it('treats non-auth dead letters as repairable and requeues them automatically', async () => {
    const d1 = makeD1Mock({
      deadLetters: [{
        id: 'wq-1',
        org_id: 'org-1',
        domain: 'calendar_refresh',
        payload: JSON.stringify({ user_id: 'user-1', window_id: 'win-1' }),
        last_error: 'graph_api_error (HTTP 503)',
        created_at: '2026-05-23T00:00:00.000Z',
      }],
    });

    const result = await scanAndRepairIngestion('org-1', makeEnv(d1));

    expect(result.dead_letters_requeued).toBe(1);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('UPDATE work_queue') &&
      r.sql.includes("status = 'pending'") &&
      r.binds.includes('wq-1')
    )).toBe(true);
    expect(d1.runs.some((r: any) => r.sql.includes('INSERT INTO ingestion_incidents'))).toBe(true);
  });

  it('blocks repeated token refresh dead letters instead of requeueing forever', async () => {
    const d1 = makeD1Mock({
      deadLetters: [{
        id: 'wq-auth',
        org_id: 'org-1',
        domain: 'calendar_refresh',
        payload: JSON.stringify({ user_id: 'user-auth', window_id: 'win-1' }),
        last_error: 'token_refresh_failed',
        created_at: '2026-05-23T00:00:00.000Z',
      }],
    });

    const result = await scanAndRepairIngestion('org-1', makeEnv(d1, {
      'token_failed:user-auth:outlook': { count: 3, reason: 'reauth_required' },
    }));

    expect(result.dead_letters_requeued).toBe(0);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('UPDATE work_queue') &&
      r.sql.includes("status = 'pending'")
    )).toBe(false);
    const incidentInsert = d1.runs.find((r: any) => r.sql.includes('INSERT INTO ingestion_incidents'));
    expect(incidentInsert?.binds).toContain('calendar_reauth_required');
    expect(incidentInsert?.binds).toContain('critical');
    expect(incidentInsert?.binds).toContain(1);
  });

  it('does not auto-requeue deterministic Vectorize payload quarantines', async () => {
    const d1 = makeD1Mock({
      deadLetters: [{
        id: 'wq-vector',
        org_id: 'org-1',
        domain: 'embed_retry',
        payload: JSON.stringify({ entity_id: 'doc-1', source_table: 'documents' }),
        last_error: 'vectorize_payload_quarantined: VECTOR_UPSERT_ERROR (code = 40023): failed to parse upsert vectors request',
        created_at: '2026-05-23T00:00:00.000Z',
      }],
    });

    const result = await scanAndRepairIngestion('org-1', makeEnv(d1));

    expect(result.dead_letters_requeued).toBe(0);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('UPDATE work_queue') &&
      r.sql.includes("status = 'pending'")
    )).toBe(false);
    const incidentInsert = d1.runs.find((r: any) => r.sql.includes('INSERT INTO ingestion_incidents'));
    expect(incidentInsert?.binds).toContain('vectorize_payload_quarantined');
    expect(incidentInsert?.binds).toContain('embedding');
  });
});

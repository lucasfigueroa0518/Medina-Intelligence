import { beforeEach, describe, expect, it, vi } from 'vitest';

const createFireflyProgressiveBackfillRangeMock = vi.hoisted(() => vi.fn());
const findSlackRecentCoverageGapsMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/firefly-progressive-backfill', () => ({
  createFireflyProgressiveBackfillRange: createFireflyProgressiveBackfillRangeMock,
}));

vi.mock('../src/integrations/slack', () => ({
  findSlackRecentCoverageGaps: findSlackRecentCoverageGapsMock,
}));

import {
  incidentsToUserWarnings,
  reportIngestionFailure,
  reportIngestionSuccess,
  scanAndRepairIngestion,
  type IngestionIncident,
} from '../src/lib/ingestion-health';

function makeD1Mock(options: {
  users?: unknown[];
  deadLetters?: unknown[];
  newsTreatmentDeadLetters?: unknown[];
  slackChannelErrors?: unknown[];
  slackLatest?: unknown;
  slackActiveRepair?: unknown;
  activeIncidents?: unknown[];
  fireflyCredentialedUsers?: unknown[];
  fireflyLatestItem?: unknown;
  fireflyLatestWebhook?: unknown;
  fireflyActiveJob?: unknown;
  fireflyHydrateActive?: unknown;
  fireflyExistingIncident?: unknown;
  fireflyDeadLetters?: unknown;
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
          if (sql.includes('FROM user_firefly_credentials c')) return { results: options.fireflyCredentialedUsers || [] };
          if (sql.includes('FROM users WHERE org_id')) return { results: options.users || [] };
          if (sql.includes("domain = 'ingestion_treatment'")) return { results: options.newsTreatmentDeadLetters || [] };
          if (sql.includes("status = 'dead_letter'")) return { results: options.deadLetters || [] };
          if (sql.includes('FROM slack_channels') && sql.includes('last_error IS NOT NULL')) {
            return { results: options.slackChannelErrors || [] };
          }
          if (sql.includes('FROM ingestion_incidents')) return { results: options.activeIncidents || [] };
          return { results: [] };
        },
        async first() {
          firstCalls.push({ sql, binds });
          if (sql.includes('INSERT INTO work_queue')) {
            return { id: `work-${firstCalls.length}` };
          }
          if (sql.includes('FROM conversations') && sql.includes("source = 'slack'")) {
            return options.slackLatest || {
              total_rows: 0,
              latest_staged_at: new Date().toISOString(),
              latest_source_sent_at: new Date().toISOString(),
            };
          }
          if (sql.includes("domain = 'slack_channel_backfill'")) {
            return options.slackActiveRepair || { n: 0 };
          }
          if (sql.includes('FROM firefly_transcript_items')) {
            return options.fireflyLatestItem || { last_item_at: null, total_items: 0 };
          }
          if (sql.includes('FROM firefly_webhook_deliveries')) {
            return options.fireflyLatestWebhook || { last_webhook_at: null, last_hydrated_at: null };
          }
          if (sql.includes('FROM firefly_progressive_backfill_jobs')) {
            return options.fireflyActiveJob || null;
          }
          if (sql.includes("domain = 'firefly_transcript_hydrate'")) {
            return options.fireflyHydrateActive || { n: 0 };
          }
          if (sql.includes("code = 'firefly_ingestion_silent'")) {
            return options.fireflyExistingIncident || null;
          }
          if (sql.includes("domain IN ('firefly_window','firefly_transcript_hydrate')")) {
            return options.fireflyDeadLetters || { n: 0 };
          }
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
  beforeEach(() => {
    createFireflyProgressiveBackfillRangeMock.mockReset().mockResolvedValue({
      created: true,
      parent_id: 'firefly-parent',
      total_windows: 1,
    });
    findSlackRecentCoverageGapsMock.mockReset().mockResolvedValue({
      channels_scanned: 0,
      history_calls_ok: 0,
      messages_seen: 0,
      missing_messages: 0,
      channels_with_missing: [],
      channels_with_errors: 0,
      errors: [],
    });
  });

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

  it('keeps work-queue item incidents out of global user warnings', () => {
    const warnings = incidentsToUserWarnings([
      {
        id: 'inc-wq',
        org_id: 'org-1',
        source: 'work_queue',
        scope_type: 'conversation',
        scope_id: 'conv-1',
        status: 'blocked',
        severity: 'critical',
        code: 'work_queue_prospect_detect_failed',
        title: 'Prospect detector failed',
        message: 'work queue work item failed: Claude API error 403',
        first_seen_at: '2026-06-02T00:00:00.000Z',
        last_seen_at: '2026-06-02T00:00:00.000Z',
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

    expect(warnings).toEqual([]);
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

  it('resolves blocked incidents when the same source and scope succeeds', async () => {
    const d1 = makeD1Mock();
    await reportIngestionSuccess(makeEnv(d1), {
      orgId: 'org-1',
      source: 'work_queue',
      scopeType: 'conversation',
      scopeId: 'conv-1',
      successAt: '2026-06-03T00:00:00.000Z',
    });

    const incidentUpdate = d1.runs.find((r: any) => r.sql.includes('UPDATE ingestion_incidents'));
    expect(incidentUpdate).toBeTruthy();
    expect(incidentUpdate?.sql).toContain("status IN ('open','recovering','blocked')");
    expect(incidentUpdate?.binds).toContain('work_queue');
    expect(incidentUpdate?.binds).toContain('conversation');
    expect(incidentUpdate?.binds).toContain('conv-1');
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

  it('requeues only known news treatment dead letters from the source_url schema fix', async () => {
    const d1 = makeD1Mock({
      newsTreatmentDeadLetters: [{
        id: 'treat-news-1',
        org_id: 'org-1',
        domain: 'ingestion_treatment',
        payload: JSON.stringify({ source_table: 'news_articles', source_id: 'news-1' }),
        last_error: 'D1_ERROR: no such column: url at offset 39: SQLITE_ERROR',
        created_at: '2026-06-12T13:00:00.000Z',
      }],
    });

    const result = await scanAndRepairIngestion('org-1', makeEnv(d1));

    expect(result.dead_letters_requeued).toBe(1);
    expect(d1.runs.some((r: any) =>
      r.sql.includes('UPDATE work_queue') &&
      r.binds.includes('auto_repair_requeued after news_articles.source_url fix') &&
      r.binds.includes('treat-news-1')
    )).toBe(true);
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

  it('opens a Fireflies silence incident after 48 hours without staged transcripts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    try {
      const d1 = makeD1Mock({
        fireflyCredentialedUsers: [{
          user_id: 'user-tony',
          email: 'tony@medinavc.com',
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-01T00:00:00.000Z',
          last_used_at: '2026-06-08T00:00:00.000Z',
        }],
        fireflyLatestItem: { last_item_at: '2026-06-08T00:00:00.000Z', total_items: 196 },
      });

      await scanAndRepairIngestion('org-1', makeEnv(d1));

      const incidentInsert = d1.runs.find((r: any) =>
        r.sql.includes('INSERT INTO ingestion_incidents') &&
        r.binds.includes('firefly_ingestion_silent')
      );
      expect(incidentInsert).toBeTruthy();
      expect(incidentInsert?.binds).toContain('firefly');
      expect(incidentInsert?.binds).toContain('user-tony');
      expect(incidentInsert?.binds).toContain('2026-06-04T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-repairs Fireflies incidents with a bounded date-range backfill', async () => {
    const incident = {
      id: 'inc-firefly',
      org_id: 'org-1',
      source: 'firefly',
      scope_type: 'user',
      scope_id: 'user-tony',
      status: 'open',
      severity: 'warning',
      code: 'firefly_ingestion_silent',
      title: 'Fireflies silent',
      message: 'No transcripts',
      first_seen_at: '2026-06-11T00:00:00.000Z',
      last_seen_at: '2026-06-11T00:00:00.000Z',
      resolved_at: null,
      last_success_at: null,
      human_action_required: 0,
      recovery_status: 'idle',
      recovery_window_start: '2026-06-04T00:00:00.000Z',
      recovery_window_end: '2026-06-11T00:00:00.000Z',
      repair_attempt_count: 0,
      last_repair_at: null,
      metadata: '{}',
    } satisfies IngestionIncident;
    const d1 = makeD1Mock({ activeIncidents: [incident] });

    const result = await scanAndRepairIngestion('org-1', makeEnv(d1));

    expect(result.repairs_enqueued).toBe(1);
    expect(createFireflyProgressiveBackfillRangeMock).toHaveBeenCalledWith(
      'org-1',
      'user-tony',
      '2026-06-04T00:00:00.000Z',
      '2026-06-11T00:00:00.000Z',
      10,
      null,
      expect.anything()
    );
  });

  it('verifies stale Slack source coverage and backfills only channels with missing messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T16:00:00.000Z'));
    try {
      findSlackRecentCoverageGapsMock.mockResolvedValue({
        channels_scanned: 2,
        history_calls_ok: 2,
        messages_seen: 3,
        missing_messages: 2,
        channels_with_missing: [{
          channel_id: 'C1',
          channel_name: 'dealflow-pipeline',
          messages_seen: 2,
          missing_messages: 2,
        }],
        channels_with_errors: 0,
        errors: [],
      });
      const d1 = makeD1Mock({
        slackLatest: {
          total_rows: 350,
          latest_staged_at: '2026-06-09T23:03:51.062Z',
          latest_source_sent_at: '2026-06-09T22:30:38.024Z',
        },
      });

      await scanAndRepairIngestion('org-1', makeEnv(d1));

      expect(findSlackRecentCoverageGapsMock).toHaveBeenCalledWith(
        'org-1',
        expect.anything(),
        expect.objectContaining({ daysBack: 7, maxChannels: 25, perChannelLimit: 20 })
      );
      expect(d1.runs.some((r: any) =>
        r.sql.includes('INSERT INTO ingestion_incidents') &&
        r.binds.includes('slack_messages_stale')
      )).toBe(true);
      expect(d1.firstCalls.some((r: any) =>
        r.sql.includes('INSERT INTO work_queue') &&
        r.binds.some((bind: unknown) => String(bind).includes('C1'))
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

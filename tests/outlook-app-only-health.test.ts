import { describe, expect, it } from 'vitest';
import {
  expectedResourcesForMailbox,
  filterOutlookIncidentsForUserReports,
  getOutlookAppOnlyHealthSnapshot,
  type OutlookAppOnlyHealthSnapshot,
} from '../src/lib/outlook-app-only-health';
import type { IngestionIncident } from '../src/lib/ingestion-health';

function makeD1Mock(options: {
  users?: unknown[];
  subscriptions?: unknown[];
  states?: unknown[];
  incidents?: unknown[];
  conversationStats?: unknown[];
  workQueueStats?: unknown[];
} = {}) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          binds = args;
          void binds;
          return this;
        },
        async all() {
          if (sql.includes('FROM users')) return { results: options.users || [] };
          if (sql.includes('FROM graph_subscriptions')) return { results: options.subscriptions || [] };
          if (sql.includes('FROM ingestion_source_state')) return { results: options.states || [] };
          if (sql.includes('FROM ingestion_incidents')) return { results: options.incidents || [] };
          if (sql.includes('FROM conversation_participants')) return { results: options.conversationStats || [] };
          if (sql.includes('FROM work_queue')) return { results: options.workQueueStats || [] };
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

function makeEnv(d1: any): any {
  return {
    D1: d1,
    KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
    },
    AZURE_CLIENT_ID: 'client-id',
    AZURE_TENANT_ID: 'tenant-id',
    AZURE_CLIENT_CERT_PRIVATE_KEY: 'pem',
    AZURE_CLIENT_CERT_THUMBPRINT: '00112233445566778899aabbccddeeff00112233',
    OUTLOOK_AUTH_MODE: 'app_only',
    OUTLOOK_WEBHOOK_BASE_URL: 'https://example.com',
  };
}

function incident(id: string, code: string): IngestionIncident {
  return {
    id,
    org_id: 'org-1',
    source: 'calendar',
    scope_type: 'user',
    scope_id: 'user-1',
    status: 'blocked',
    severity: 'critical',
    code,
    title: 'Calendar issue',
    message: code,
    first_seen_at: '2026-05-01T00:00:00.000Z',
    last_seen_at: '2026-05-01T00:00:00.000Z',
    resolved_at: null,
    last_success_at: null,
    human_action_required: 1,
    recovery_status: 'blocked_on_auth',
    recovery_window_start: null,
    recovery_window_end: null,
    repair_attempt_count: 0,
    last_repair_at: null,
    metadata: '{}',
  };
}

describe('outlook app-only health', () => {
  it('expects exact users/{mailbox} subscriptions, never delegated /me resources', () => {
    expect(expectedResourcesForMailbox('Raul@MedinaVC.com')).toEqual([
      'users/raul%40medinavc.com/mailFolders/inbox/messages',
      'users/raul%40medinavc.com/mailFolders/sentitems/messages',
      'users/raul%40medinavc.com/events',
    ]);
  });

  it('classifies legacy /me subscriptions as repair work instead of valid app-only health', async () => {
    const env = makeEnv(makeD1Mock({
      users: [{
        id: 'user-1',
        email: 'raul@medinavc.com',
        full_name: 'Raul Medina',
        role: 'owner',
        outlook_mailbox: null,
      }],
      subscriptions: [{
        user_id: 'user-1',
        resource: 'me/events',
        expiration_at: '2099-01-01T00:00:00.000Z',
      }],
    }));

    const health = await getOutlookAppOnlyHealthSnapshot('org-1', env, {
      includeGraphProbes: false,
    });

    expect(health.status).toBe('degraded');
    expect(health.summary.legacy_subscriptions).toBe(1);
    expect(health.summary.missing_subscriptions).toBe(3);
    expect(health.mailboxes[0].subscriptions.current).toEqual([]);
    expect(health.mailboxes[0].subscriptions.legacy).toEqual(['me/events']);
    expect(health.mailboxes[0].subscriptions.expected.every(r => r.startsWith('users/'))).toBe(true);
  });

  it('suppresses stale delegated token incidents only when the health snapshot marks them safe', () => {
    const stale = incident('inc-stale', 'token_refresh_failed:missing_token');
    const unrelated = incident('inc-other', 'VECTOR_UPSERT_ERROR');
    const health = {
      suppressed_incident_ids: ['inc-stale'],
    } as OutlookAppOnlyHealthSnapshot;

    expect(filterOutlookIncidentsForUserReports([stale, unrelated], health)).toEqual([unrelated]);
    expect(filterOutlookIncidentsForUserReports([stale], null)).toEqual([stale]);
  });
});

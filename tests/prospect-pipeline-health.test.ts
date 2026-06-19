import { describe, expect, it } from 'vitest';
import {
  buildProspectPipelineHealth,
  renderProspectPipelineHealthMarkdown,
} from '../scripts/prospect-pipeline-health';

type HealthOptions = {
  prospectQueue?: unknown[];
  workQueueInventory?: unknown[];
  stuckWorkQueue?: unknown[];
  openClassifierCircuits?: unknown[];
  openIncidents?: unknown[];
  signalState?: Record<string, unknown>;
  prospectState?: Record<string, unknown>;
  freshness?: Record<string, { latest_ingested_at: string | null; records_lookback: number }>;
  lowCoverage?: boolean;
};

const FUTURE = '2099-01-01T00:00:00.000Z';

class HealthStatement {
  private binds: unknown[] = [];

  constructor(private readonly sql: string, private readonly options: HealthOptions) {
    expect(sql).toMatch(/^\s*SELECT\b/i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|VACUUM|PRAGMA)\b/i);
  }

  bind(...args: unknown[]): HealthStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    expect(this.binds).toContain('org-1');
    if (this.sql.includes('FROM work_queue') && this.sql.includes('GROUP BY domain, status')) {
      return { results: (this.options.workQueueInventory || []) as T[] };
    }
    if (this.sql.includes('FROM work_queue') && this.sql.includes("status = 'in_progress'")) {
      return { results: (this.options.stuckWorkQueue || []) as T[] };
    }
    if (this.sql.includes('FROM work_queue') && this.sql.includes("domain = 'deal_evidence_detect'")) {
      return { results: [] };
    }
    if (this.sql.includes('FROM work_queue') && this.sql.includes("domain = 'prospect_detect'") && this.sql.includes('GROUP BY status')) {
      return { results: (this.options.prospectQueue || []) as T[] };
    }
    if (this.sql.includes('FROM upstream_budget_ledger')) {
      return { results: (this.options.openClassifierCircuits || []) as T[] };
    }
    if (this.sql.includes('FROM ingestion_source_state')) {
      return { results: [] };
    }
    if (this.sql.includes('FROM ingestion_incidents')) {
      return { results: (this.options.openIncidents || []) as T[] };
    }
    if (this.sql.includes('FROM sync_jobs')) {
      return { results: [] };
    }
    return { results: [] };
  }

  async first<T = any>(): Promise<T | null> {
    expect(this.binds).toContain('org-1');
    if (this.sql.includes('FROM work_queue') && this.sql.includes('next_attempt_at')) {
      return { count: 4 } as T;
    }
    if (this.sql.includes('FROM prospect_signals') && this.sql.includes('old_classifier_signals')) {
      return {
        inbound_signals: 23,
        pending_classifications: 5,
        classifier_errors: 2,
        known_deal_attaches: 7,
        context_signals: 11,
        ignored_or_noise_signals: 13,
        final_gate_fallbacks: 1,
        final_gate_failed_open: 0,
        null_inbound_prospect_links: 0,
        old_classifier_signals: 0,
        ...(this.options.signalState || {}),
      } as T;
    }
    if (this.sql.includes('FROM prospects') && this.sql.includes('duplicate_active_normalized_names')) {
      return {
        new_prospects: 17,
        provisional_prospects: 19,
        duplicate_active_normalized_names: 0,
        ...(this.options.prospectState || {}),
      } as T;
    }
    if (this.sql.includes("source = 'outlook'") && this.sql.includes('FROM conversations')) return freshness('outlook_email', this.options) as T;
    if (this.sql.includes("source = 'slack'") && this.sql.includes('FROM conversations')) return freshness('slack', this.options) as T;
    if (this.sql.includes('transcript_r2_key IS NOT NULL')) return freshness('firefly', this.options) as T;
    if (this.sql.includes("source = 'outlook'") && this.sql.includes('FROM events')) return freshness('calendar', this.options) as T;
    if (this.sql.includes('FROM documents') && this.sql.includes('MAX(created_at)')) return freshness('documents', this.options) as T;
    if (this.sql.includes('FROM vector_entity_index') && this.sql.includes('MAX(created_at)')) return freshness('embeddings', this.options) as T;
    if (this.sql.includes("domain = 'rag_reindex_v2'")) return freshness('rag_v2', this.options) as T;
    if (this.sql.includes('COUNT(*) AS n') && this.sql.includes('FROM conversations')) return { n: 100 } as T;
    if (this.sql.includes("source_table = 'conversations'")) return { n: this.options.lowCoverage ? 50 : 95 } as T;
    if (this.sql.includes('FROM conversation_contacts')) return { n: this.options.lowCoverage ? 40 : 90 } as T;
    if (this.sql.includes('FROM documents') && this.sql.includes('processing_status')) return { n: 80 } as T;
    if (this.sql.includes("source_table = 'documents'")) return { n: this.options.lowCoverage ? 40 : 75 } as T;
    if (this.sql.includes('FROM events') && this.sql.includes('COUNT(*) AS n')) return { n: 60 } as T;
    if (this.sql.includes("source_table = 'events'")) return { n: this.options.lowCoverage ? 30 : 58 } as T;
    if (this.sql.includes('FROM event_attendees')) return { total: 120, linked: this.options.lowCoverage ? 50 : 110 } as T;
    if (this.sql.includes('FROM prospect_signals') && this.sql.includes('mention_type =')) return { total: 100, linked: 100 } as T;
    return null;
  }
}

function freshness(source: string, options: HealthOptions): any {
  return options.freshness?.[source] || { latest_ingested_at: FUTURE, records_lookback: 12 };
}

class HealthFakeD1 {
  constructor(private readonly options: HealthOptions = {}) {}

  prepare(sql: string): HealthStatement {
    return new HealthStatement(sql, this.options);
  }

  async batch(): Promise<never> {
    throw new Error('batch should never be called');
  }
}

describe('prospect pipeline health monitor', () => {
  it('uses SELECT-only queries and reports prospect plus ingestion health counters', async () => {
    const summary = await buildProspectPipelineHealth('org-1', { D1: new HealthFakeD1() } as any, {
      daysBack: 7,
    });

    expect(summary).toMatchObject({
      read_only: true,
      org_id: 'org-1',
      days_back: 7,
      dead_letters: 0,
      failed_or_pending: 0,
      rate_limit_deferrals: 4,
      classifier_errors: 2,
      pending_classifications: 5,
      new_prospects: 17,
      known_deal_attaches: 7,
      provisional_prospects: 19,
      context_signals: 11,
      ignored_or_noise_signals: 13,
    });
    expect(summary.prospect_activity).toMatchObject({
      inbound_signals: 23,
      final_gate_fallbacks: 1,
      final_gate_failed_open: 0,
      null_inbound_prospect_links: 0,
      duplicate_active_normalized_names: 0,
    });
    expect(summary.ingestion_freshness.map(row => row.source)).toEqual([
      'outlook_email',
      'slack',
      'firefly',
      'calendar',
      'documents',
      'embeddings',
      'rag_v2',
    ]);
    expect(summary.wiring_health.prospect_signal_linkage).toEqual({ current: 100, total: 100, percentage: 100 });
  });

  it('marks critical conditions from incidents, failed-open rows, duplicates, and dead letters', async () => {
    const summary = await buildProspectPipelineHealth('org-1', {
      D1: new HealthFakeD1({
        prospectQueue: [{ status: 'dead_letter', count: 1 }],
        workQueueInventory: [{ domain: 'deal_evidence_detect', status: 'dead_letter', count: 2 }],
        openClassifierCircuits: [{ upstream: 'claude', circuit_open_until: FUTURE }],
        openIncidents: [{
          source: 'outlook_email',
          status: 'open',
          severity: 'critical',
          code: 'outlook_reauth_required',
          title: 'Outlook needs reconnect',
          human_action_required: 1,
          last_seen_at: FUTURE,
          recovery_status: 'blocked_on_auth',
        }],
        signalState: { final_gate_failed_open: 1, null_inbound_prospect_links: 1 },
        prospectState: { duplicate_active_normalized_names: 1 },
      }),
    } as any, { daysBack: 7 });

    expect(summary.verdict).toBe('Critical');
    expect(summary.verdict_reasons.join('\n')).toMatch(/critical or human-action/i);
    expect(summary.verdict_reasons.join('\n')).toMatch(/failed-open/i);
    expect(summary.verdict_reasons.join('\n')).toMatch(/duplicate active prospect/i);
    expect(summary.verdict_reasons.join('\n')).toMatch(/deal evidence dead-letter/i);
  });

  it('renders a concise markdown report with verdict, freshness, wiring, and recommendations', async () => {
    const summary = await buildProspectPipelineHealth('org-1', {
      D1: new HealthFakeD1({
        lowCoverage: true,
        freshness: {
          outlook_email: { latest_ingested_at: null, records_lookback: 0 },
          slack: { latest_ingested_at: FUTURE, records_lookback: 5 },
        },
      }),
    } as any, { daysBack: 7 });
    const markdown = renderProspectPipelineHealthMarkdown(summary);

    expect(markdown).toContain('Weekly Prospect + Ingestion Health Report');
    expect(markdown).toContain('**Verdict:** Critical');
    expect(markdown).toContain('## Prospect Activity');
    expect(markdown).toContain('## Ingestion Freshness');
    expect(markdown).toContain('## Full Wiring Health');
    expect(markdown).toContain('Outlook emails');
    expect(markdown).toContain('Investigate:');
  });
});

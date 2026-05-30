import { describe, expect, it } from 'vitest';
import {
  __agentToolsTestHooks,
  getProspectDigest,
  getProspectEvidence,
  queryDealFlow,
  runProspectCleanupPassTool,
  searchConversations,
} from '../src/lib/agent-tools';
import type { AuthContext } from '../src/types/interfaces';

const ctx: AuthContext = {
  orgId: 'org-1',
  userId: 'user-1',
  userRole: 'member',
  email: 'user-1@medinavc.com',
};

describe('agent tool source contracts', () => {
  it('does not silently treat Firefly transcripts as conversation rows', async () => {
    const result = await searchConversations(
      ctx,
      { source: 'firefly', limit: 10 },
      {} as any
    );

    expect(result.error).toBe('SOURCE_NOT_IN_CONVERSATIONS');
    expect(result.message).toMatch(/events table/i);
  });

  it('keeps generic meeting-window words out of event keyword filters', () => {
    expect(__agentToolsTestHooks.deriveEventKeywordTerms('recent and upcoming meetings and events')).toEqual([]);
    expect(__agentToolsTestHooks.deriveEventKeywordTerms('NeuralSeek meeting transcript recap')).toEqual(['neuralseek']);
    expect(__agentToolsTestHooks.deriveEventKeywordTerms('Bank of America upcoming meetings')).toEqual(['bank', 'america']);
  });

  it('allows all-time conversation search and removes the old 365-day ceiling', () => {
    expect(__agentToolsTestHooks.conversationLookbackDays(0)).toBeNull();
    expect(__agentToolsTestHooks.conversationLookbackDays(1200)).toBe(1200);
    expect(__agentToolsTestHooks.conversationLookbackDays(9000)).toBe(3650);
  });

  it('uses conversation FTS for keyword recall instead of LIKE scans', () => {
    const sql = __agentToolsTestHooks.conversationSearchCteSql();
    expect(sql).toContain('conversation_search_fts');
    expect(sql).toContain('MATCH');
  });

  it('activates Slack freshness fallback when RAG v2 is behind the relational source', () => {
    expect(__agentToolsTestHooks.shouldCheckSlackFreshness({
      query: 'most recent messages',
      source_types: ['slack'],
    })).toBe(true);
    expect(__agentToolsTestHooks.queryAsksForRecent('what is the latest Slack message?')).toBe(true);
    expect(__agentToolsTestHooks.shouldUseDeterministicSlackRecentFallback({
      query: 'what is the most recent Slack message?',
      source_types: ['slack'],
    })).toBe(true);
    expect(__agentToolsTestHooks.shouldUseSlackFreshnessFallback({
      source_family: 'slack',
      source_table: 'conversations',
      total_sources: 319,
      indexed_sources: 187,
      missing_sources: 132,
      incomplete_sources: 0,
      skipped_sources: 0,
      latest_source_at: '2026-05-29T18:06:06.959Z',
      latest_indexed_source_at: '2026-05-14T16:02:24.817Z',
      freshness_lag_ms: 1_315_422_142,
      queue_pending: 0,
      queue_in_progress: 0,
      queue_failed: 0,
      queue_dead_letter: 0,
    })).toBe(true);
  });
});

class ProspectAgentStatement {
  private binds: unknown[] = [];

  constructor(private readonly db: ProspectAgentFakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): ProspectAgentStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.binds) as T[] };
  }

  async first<T = any>(): Promise<T | null> {
    return this.db.first(this.sql, this.binds) as T | null;
  }

  async run(): Promise<void> {
    this.db.run(this.sql, this.binds);
  }
}

class ProspectAgentFakeD1 {
  prospects: any[] = [];
  signals: any[] = [];
  coverage: any[] = [];
  conversations: any[] = [];
  users: any[] = [];

  prepare(sql: string): ProspectAgentStatement {
    return new ProspectAgentStatement(this, sql);
  }

  all(sql: string, binds: unknown[]): any[] {
    if (/SELECT id FROM users/i.test(sql)) {
      const [orgId] = binds;
      return this.users
        .filter(row => row.org_id === orgId && row.share_emails_org_wide === 1 && !row.deleted_at)
        .map(row => ({ id: row.id }));
    }

    if (/FROM prospect_backfill_coverage/i.test(sql)) {
      const [orgId] = binds;
      const rows = this.coverage.filter(row => row.org_id === orgId);
      if (/GROUP BY source_family/i.test(sql)) {
        const grouped = new Map<string, any>();
        for (const row of rows) {
          const current = grouped.get(row.source_family) || {
            source_family: row.source_family,
            earliest_window_start: row.window_start,
            latest_window_end: row.window_end,
            items_scanned: 0,
            signals_recorded: 0,
            classifications_pending: 0,
            latest_completed_at: row.completed_at,
          };
          current.items_scanned += Number(row.items_scanned || 0);
          current.signals_recorded += Number(row.signals_recorded || 0);
          current.classifications_pending += Number(row.classifications_pending || 0);
          current.earliest_window_start = String(current.earliest_window_start) < String(row.window_start) ? current.earliest_window_start : row.window_start;
          current.latest_window_end = String(current.latest_window_end) > String(row.window_end) ? current.latest_window_end : row.window_end;
          current.latest_completed_at = String(current.latest_completed_at || '') > String(row.completed_at || '') ? current.latest_completed_at : row.completed_at;
          grouped.set(row.source_family, current);
        }
        return [...grouped.values()];
      }
      return rows.slice(0, 12);
    }

    if (/FROM prospect_signals s\s+JOIN prospects p/i.test(sql)) {
      const [orgId] = binds;
      const grouped = new Map<string, { source_type: string; signal_count: number; prospectIds: Set<string> }>();
      for (const signal of this.signals.filter(row => row.org_id === orgId && row.mention_type === 'inbound_prospect')) {
        const prospect = this.prospects.find(row => row.id === signal.prospect_id && row.org_id === orgId);
        if (!prospect) continue;
        const current = grouped.get(signal.source_type) || { source_type: signal.source_type, signal_count: 0, prospectIds: new Set<string>() };
        current.signal_count++;
        current.prospectIds.add(String(prospect.possible_duplicate_of || prospect.id));
        grouped.set(signal.source_type, current);
      }
      return [...grouped.values()].map(row => ({
        source_type: row.source_type,
        signal_count: row.signal_count,
        prospect_count: row.prospectIds.size,
      }));
    }

    if (/FROM prospects p/i.test(sql) && /GROUP BY p\.sector_key/i.test(sql)) {
      const prospects = this.filteredProspects(binds[0]);
      const grouped = new Map<string, Set<string>>();
      for (const prospect of prospects) {
        const key = prospect.sector_key || 'uncategorized';
        const set = grouped.get(key) || new Set<string>();
        set.add(String(prospect.possible_duplicate_of || prospect.id));
        grouped.set(key, set);
      }
      return [...grouped.entries()].map(([sector_key, ids]) => ({
        sector_key,
        sector_label: sector_key,
        total: ids.size,
      }));
    }

    if (/FROM prospects p/i.test(sql) && /GROUP BY p\.enrichment_priority/i.test(sql)) {
      const prospects = this.filteredProspects(binds[0]);
      const grouped = new Map<string, Set<string>>();
      for (const prospect of prospects) {
        const key = prospect.enrichment_priority || 'lazy';
        const set = grouped.get(key) || new Set<string>();
        set.add(String(prospect.possible_duplicate_of || prospect.id));
        grouped.set(key, set);
      }
      return [...grouped.entries()].map(([enrichment_priority, ids]) => ({
        enrichment_priority,
        total: ids.size,
      }));
    }

    if (/FROM prospect_signals\s+WHERE org_id = \? AND prospect_id = \?/i.test(sql)) {
      const [orgId, prospectId, limit] = binds;
      return this.signals
        .filter(row => row.org_id === orgId && row.prospect_id === prospectId)
        .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
        .slice(0, Number(limit || 20));
    }

    if (/FROM prospects p/i.test(sql) && /ORDER BY p\.signal_strength DESC/i.test(sql)) {
      const [orgId] = binds;
      const limit = Number(binds[binds.length - 1] || 20);
      return this.filteredProspects(orgId)
        .sort((a, b) => Number(b.signal_strength || 0) - Number(a.signal_strength || 0))
        .slice(0, limit)
        .map(row => ({ ...row, sector_label: row.sector_key }));
    }

    if (/FROM prospects p/i.test(sql) && /ORDER BY p\.last_seen_at DESC/i.test(sql)) {
      const [orgId] = binds;
      const limit = Number(binds[binds.length - 1] || 20);
      return this.filteredProspects(orgId)
        .sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
        .slice(0, limit)
        .map(row => ({ ...row, sector_label: row.sector_key }));
    }

    return [];
  }

  first(sql: string, binds: unknown[]): any | null {
    if (/COUNT\(DISTINCT COALESCE\(p\.possible_duplicate_of, p\.id\)\) AS total/i.test(sql)) {
      const ids = new Set(this.filteredProspects(binds[0]).map(row => String(row.possible_duplicate_of || row.id)));
      return { total: ids.size };
    }

    if (/COUNT\(DISTINCT CASE WHEN p\.provisional = 1/i.test(sql)) {
      const prospects = this.filteredProspects(binds[0]);
      return {
        provisional_prospects: new Set(prospects.filter(row => row.provisional === 1).map(row => row.possible_duplicate_of || row.id)).size,
        direction_uncertain_prospects: new Set(prospects.filter(row => row.direction_uncertain === 1).map(row => row.possible_duplicate_of || row.id)).size,
        uncategorized_prospects: new Set(prospects.filter(row => row.sector_key === 'uncategorized').map(row => row.possible_duplicate_of || row.id)).size,
        possible_duplicate_prospects: prospects.filter(row => row.possible_duplicate_of).length,
      };
    }

    if (/SUM\(CASE WHEN s\.classification_status != 'classified'/i.test(sql)) {
      const [orgId] = binds;
      const rows = this.signals.filter(row => row.org_id === orgId);
      return {
        pending_or_failed_classifications: rows.filter(row => row.classification_status !== 'classified').length,
        pending_resolutions: rows.filter(row => row.resolution_status === 'pending').length,
      };
    }

    if (/FROM prospects p/i.test(sql) && /WHERE p\.id = \?/i.test(sql)) {
      const [prospectId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row, sector_label: row.sector_key } : null;
    }

    if (/FROM conversations c/i.test(sql)) {
      const [sourceId, orgId] = binds;
      const row = this.conversations.find(entry => entry.id === sourceId && entry.org_id === orgId);
      return row ? { ...row } : null;
    }

    return null;
  }

  run(_sql: string, _binds: unknown[]): void {}

  private filteredProspects(orgId: unknown): any[] {
    return this.prospects.filter(row =>
      row.org_id === orgId &&
      !row.deleted_at &&
      ['active', 'provisional'].includes(row.status)
    );
  }
}

function prospectAgentEnv(db: ProspectAgentFakeD1): any {
  return { D1: db };
}

describe('prospect MARTy tools', () => {
  it('returns dedup-aware firm-visible deal-flow counts that do not vary by user', async () => {
    const db = new ProspectAgentFakeD1();
    db.prospects.push(
      {
        id: 'prospect-auguria',
        org_id: 'org-1',
        canonical_name: 'Auguria',
        sector_key: 'cybersecurity',
        status: 'active',
        last_seen_at: '2026-05-29T00:00:00.000Z',
        signal_strength: 92,
        enrichment_priority: 'eager',
        confidence: 0.95,
        provisional: 0,
        direction_uncertain: 0,
        possible_duplicate_of: null,
        signal_strength_reasons: '["deck"]',
      },
      {
        id: 'prospect-auguria-dup',
        org_id: 'org-1',
        canonical_name: 'Auguria AI',
        sector_key: 'cybersecurity',
        status: 'active',
        last_seen_at: '2026-05-28T00:00:00.000Z',
        signal_strength: 45,
        enrichment_priority: 'lazy',
        confidence: 0.72,
        provisional: 1,
        direction_uncertain: 0,
        possible_duplicate_of: 'prospect-auguria',
        signal_strength_reasons: '[]',
      },
      {
        id: 'prospect-sativa',
        org_id: 'org-1',
        canonical_name: 'Sativa',
        sector_key: 'uncategorized',
        status: 'provisional',
        last_seen_at: '2026-05-27T00:00:00.000Z',
        signal_strength: 20,
        enrichment_priority: 'lazy',
        confidence: 0.55,
        provisional: 1,
        direction_uncertain: 1,
        possible_duplicate_of: null,
        signal_strength_reasons: '[]',
      },
    );
    db.signals.push(
      { id: 'sig-1', org_id: 'org-1', prospect_id: 'prospect-auguria', source_type: 'conversation', mention_type: 'inbound_prospect', classification_status: 'classified', resolution_status: 'resolved' },
      { id: 'sig-2', org_id: 'org-1', prospect_id: 'prospect-auguria-dup', source_type: 'document', mention_type: 'inbound_prospect', classification_status: 'classified', resolution_status: 'pending' },
      { id: 'sig-3', org_id: 'org-1', prospect_id: 'prospect-sativa', source_type: 'document', mention_type: 'inbound_prospect', classification_status: 'failed', resolution_status: 'pending' },
    );
    db.coverage.push({ org_id: 'org-1', source_family: 'document', window_start: '2026-05-01', window_end: '2026-05-30', status: 'partial', items_scanned: 3, signals_recorded: 2, classifications_pending: 1 });

    const memberResult = await queryDealFlow(ctx, { days_back: 30 }, prospectAgentEnv(db));
    const otherUserResult = await queryDealFlow(
      { ...ctx, userId: 'user-2', email: 'user-2@medinavc.com' },
      { days_back: 30 },
      prospectAgentEnv(db)
    );

    expect(memberResult.total_prospects).toBe(2);
    expect(otherUserResult.total_prospects).toBe(memberResult.total_prospects);
    expect(memberResult.by_source).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'conversation', prospect_count: 1 }),
      expect.objectContaining({ source_type: 'document', prospect_count: 2 }),
    ]));
    expect(memberResult.qualifiers.unresolved).toMatchObject({
      provisional_prospects: 2,
      direction_uncertain_prospects: 1,
      uncategorized_prospects: 1,
      possible_duplicate_prospects: 1,
      pending_or_failed_classifications: 1,
      pending_resolutions: 2,
    });
    expect(memberResult.qualifiers.source_content_acl).toMatch(/identical across users/i);
  });

  it('redacts prospect evidence snippets per source ACL while keeping evidence counts honest', async () => {
    const db = new ProspectAgentFakeD1();
    db.prospects.push({
      id: 'prospect-auguria',
      org_id: 'org-1',
      canonical_name: 'Auguria',
      sector_key: 'cybersecurity',
      status: 'active',
      signal_count: 1,
      signal_strength: 80,
      signal_strength_reasons: '["intro"]',
      enrichment_priority: 'eager',
      confidence: 0.95,
      provisional: 0,
      direction_uncertain: 0,
      possible_duplicate_of: null,
    });
    db.signals.push({
      id: 'sig-private',
      org_id: 'org-1',
      prospect_id: 'prospect-auguria',
      source_type: 'conversation',
      source_id: 'conv-private',
      source_title: 'Intro to Auguria',
      occurred_at: '2026-05-29T00:00:00.000Z',
      signal_kind: 'intro',
      raw_mention_text: 'Auguria',
      mention_type: 'inbound_prospect',
      direction: 'inbound',
      confidence: 0.95,
      confidence_tier: 'high',
      classification_status: 'classified',
      resolution_status: 'resolved',
      direction_uncertain: 0,
    });
    db.conversations.push({
      id: 'conv-private',
      org_id: 'org-1',
      source: 'outlook',
      subject: 'Intro to Auguria',
      from_email: 'alice@example.com',
      sent_at: '2026-05-29T00:00:00.000Z',
      body_preview: 'Private deck and founder notes.',
      participant_user_ids: '["user-owner"]',
      is_campaign_email: 0,
      slack_is_private: null,
    });

    const redacted = await getProspectEvidence(ctx, { prospect_id: 'prospect-auguria' }, prospectAgentEnv(db));
    const ownerVisible = await getProspectEvidence(
      { ...ctx, userRole: 'owner', userId: 'user-owner', email: 'owner@medinavc.com' },
      { prospect_id: 'prospect-auguria' },
      prospectAgentEnv(db)
    );

    expect(redacted.count).toBe(1);
    expect(redacted.restricted_evidence_count).toBe(1);
    expect(redacted.evidence[0]).toMatchObject({
      raw_mention_text: 'Auguria',
      can_read_content: false,
      snippet: null,
    });
    expect(ownerVisible.restricted_evidence_count).toBe(0);
    expect(ownerVisible.evidence[0].snippet).toContain('Private deck');
  });

  it('builds a confidence-qualified prospect digest and keeps cleanup admin-only', async () => {
    const db = new ProspectAgentFakeD1();
    db.prospects.push({
      id: 'prospect-max',
      org_id: 'org-1',
      canonical_name: 'MAX',
      sector_key: 'ai_data',
      status: 'active',
      last_seen_at: '2026-05-30T00:00:00.000Z',
      signal_strength: 88,
      signal_strength_reasons: '["meeting"]',
      enrichment_priority: 'eager',
      confidence: 0.9,
      provisional: 0,
      direction_uncertain: 0,
      possible_duplicate_of: null,
    });
    db.signals.push({ id: 'sig-max', org_id: 'org-1', prospect_id: 'prospect-max', source_type: 'document', mention_type: 'inbound_prospect', classification_status: 'classified', resolution_status: 'resolved' });

    const digest = await getProspectDigest(ctx, { days_back: 7, limit: 5 }, prospectAgentEnv(db));
    const cleanup = await runProspectCleanupPassTool(ctx, {}, prospectAgentEnv(db));

    expect(digest.headline_counts.total_prospects).toBe(1);
    expect(digest.prospects[0]).toMatchObject({
      canonical_name: 'MAX',
      answer_confidence: 'high',
    });
    expect(digest.marty_guidance).toMatch(/qualify summaries/i);
    expect(cleanup.error).toBe('AUTH_FORBIDDEN');
  });
});

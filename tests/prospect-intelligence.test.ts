import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const { callClaudeWithUsageMock } = vi.hoisted(() => ({
  callClaudeWithUsageMock: vi.fn(),
}));

vi.mock('../src/lib/claude', () => ({
  callClaudeWithUsage: callClaudeWithUsageMock,
}));

import {
  __prospectIntelligenceTestHooks,
  callProspectClassifier,
  computeSignalStrength,
  detectAndRecordProspectSignals,
  extractMentionCandidatesFromText,
  mergeProspects,
  normalizeProspectName,
  applyProspectEnrichmentCandidate,
  recordProspectBackfillCoverage,
  reverseProspectMerge,
  runProspectBackfillWindow,
  runProspectEnrichmentCycle,
} from '../src/lib/prospect-intelligence';

class FakeStatement {
  private binds: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): FakeStatement {
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

class FakeD1 {
  companies: any[] = [];
  deals: any[] = [];
  relationships: any[] = [];
  sourceConversations: any[] = [];
  sourceEvents: any[] = [];
  sourceDocuments: any[] = [];
  prospects: any[] = [];
  prospectSignals: any[] = [];
  softLinks: any[] = [];
  classificationHistory: any[] = [];
  classifierSamples: any[] = [];
  mergeAudit: any[] = [];
  entityFieldState: any[] = [];
  coverage: any[] = [];
  backfillRuns: any[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<void[]> {
    return Promise.all(statements.map(statement => statement.run()));
  }

  all(sql: string, binds: unknown[]): any[] {
    if (/FROM dealmakers/i.test(sql)) return [];
    if (/FROM companies c/i.test(sql)) {
      return this.companies
        .filter(company => company.org_id === binds[0] && this.deals.some(deal => deal.org_id === company.org_id && deal.company_id === company.id && deal.stage !== 'closed' && !deal.deleted_at))
        .map(company => ({ name: company.name, domain: company.domain || null }));
    }
    if (/FROM companies\s+WHERE/i.test(sql)) {
      const [orgId, pattern] = binds;
      const token = String(pattern || '').replace(/%/g, '').toLowerCase();
      return this.companies.filter(company =>
        company.org_id === orgId &&
        !company.deleted_at &&
        String(company.name || '').toLowerCase().includes(token)
      );
    }
    if (/FROM firm_company_relationships/i.test(sql)) {
      const [orgId, companyId] = binds;
      return this.relationships.filter(row => row.org_id === orgId && row.company_id === companyId && !row.ended_at);
    }
    if (/FROM prospect_signals/i.test(sql) && /SELECT signal_kind/i.test(sql)) {
      const [prospectId, orgId] = binds;
      return this.prospectSignals
        .filter(row => row.prospect_id === prospectId && row.org_id === orgId && row.mention_type === 'inbound_prospect')
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
    }
    if (/SELECT id FROM prospect_signals/i.test(sql)) {
      const [orgId, prospectId] = binds;
      return this.prospectSignals
        .filter(row => row.org_id === orgId && row.prospect_id === prospectId)
        .map(row => ({ id: row.id }));
    }
    if (/FROM prospects/i.test(sql) && /ORDER BY signal_strength DESC/i.test(sql)) {
      const [orgId, limit] = binds;
      return this.prospects
        .filter(row => row.org_id === orgId && !row.deleted_at && ['active', 'provisional'].includes(row.status) && ['not_started', 'candidate', 'failed'].includes(row.enrichment_status || 'not_started'))
        .sort((a, b) => Number(b.signal_strength || 0) - Number(a.signal_strength || 0))
        .slice(0, Number(limit))
        .map(row => ({ ...row }));
    }
    if (/FROM conversations/i.test(sql)) {
      const [orgId, start, end, limit] = binds;
      return this.sourceConversations
        .filter(row => row.org_id === orgId && row.sent_at >= start && row.sent_at < end)
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))
        .slice(0, Number(limit));
    }
    if (/FROM events/i.test(sql)) {
      const [orgId, start, end, limit] = binds;
      return this.sourceEvents
        .filter(row => row.org_id === orgId && !row.deleted_at && row.start_time >= start && row.start_time < end)
        .sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))
        .slice(0, Number(limit));
    }
    if (/FROM documents/i.test(sql)) {
      const [orgId, start, end, limit] = binds;
      return this.sourceDocuments
        .filter(row => row.org_id === orgId && !row.deleted_at && row.created_at >= start && row.created_at < end)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, Number(limit));
    }
    if (/FROM prospects/i.test(sql) && /ORDER BY updated_at ASC/i.test(sql)) {
      const [orgId] = binds;
      return this.prospects
        .filter(row => row.org_id === orgId && !row.deleted_at && ['active', 'provisional'].includes(row.status))
        .slice(0, 100);
    }
    return [];
  }

  first(sql: string, binds: unknown[]): any | null {
    if (/COUNT\(\*\) AS n/i.test(sql) && /FROM prospect_signals/i.test(sql)) {
      const [orgId] = binds;
      return {
        n: this.prospectSignals.filter(row =>
          row.org_id === orgId &&
          (row.classification_status !== 'classified' || row.resolution_status === 'pending')
        ).length,
      };
    }
    if (/SUM\(CASE WHEN classification_status/i.test(sql)) {
      const [orgId, prospectId] = binds;
      const rows = this.prospectSignals.filter(row => row.org_id === orgId && row.prospect_id === prospectId);
      return {
        pending_classifications: rows.filter(row => row.classification_status !== 'classified').length,
        pending_resolution: rows.filter(row => row.resolution_status === 'pending').length,
        direction_uncertain: rows.filter(row => row.direction_uncertain === 1).length,
        uncategorized: rows.filter(row => row.sector_key === 'uncategorized').length,
        avg_confidence: rows.length ? rows.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / rows.length : null,
      };
    }
    if (/FROM companies/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.companies.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/FROM companies/i.test(sql) && /lower\(domain\) = lower\(\?\)/i.test(sql)) {
      const [orgId, domain] = binds;
      const row = this.companies.find(entry =>
        entry.org_id === orgId &&
        !entry.deleted_at &&
        String(entry.domain || '').toLowerCase() === String(domain || '').toLowerCase()
      );
      return row ? { ...row } : null;
    }
    if (/FROM deals/i.test(sql) && /company_id = \?/i.test(sql)) {
      const [orgId, companyId] = binds;
      const row = this.deals.find(entry =>
        entry.org_id === orgId &&
        entry.company_id === companyId &&
        !entry.deleted_at &&
        entry.stage !== 'closed'
      );
      return row ? { ...row } : null;
    }
    if (/FROM prospect_signals/i.test(sql)) {
      const [orgId, sourceType, sourceId, mentionOrdinal] = binds;
      const row = this.prospectSignals.find(entry =>
        entry.org_id === orgId &&
        entry.source_type === sourceType &&
        entry.source_id === sourceId &&
        entry.mention_ordinal === mentionOrdinal
      );
      return row ? { ...row } : null;
    }
    if (/SELECT id FROM prospects/i.test(sql)) {
      const [orgId, normalizedName] = binds;
      const row = this.prospects.find(entry => entry.org_id === orgId && entry.normalized_name === normalizedName && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/SELECT \* FROM prospects/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/FROM prospects/i.test(sql) && /canonical_name/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { ...row } : null;
    }
    if (/SELECT\s+\w+\s+AS value FROM prospects/i.test(sql)) {
      const [id, orgId] = binds;
      const field = sql.match(/SELECT\s+(\w+)\s+AS value FROM prospects/i)?.[1] || '';
      const row = this.prospects.find(entry => entry.id === id && entry.org_id === orgId && !entry.deleted_at);
      return row ? { value: row[field] ?? null } : null;
    }
    if (/FROM prospect_merge_audit/i.test(sql)) {
      const [id, orgId] = binds;
      const row = this.mergeAudit.find(entry => entry.id === id && entry.org_id === orgId && entry.action === 'merge');
      return row ? { ...row } : null;
    }
    return null;
  }

  private storedSignalFor(orgId: unknown, sourceType: unknown, sourceId: unknown, mentionOrdinal: unknown): any | undefined {
    return this.prospectSignals.find(row =>
        row.org_id === orgId &&
        row.source_type === sourceType &&
        row.source_id === sourceId &&
        row.mention_ordinal === mentionOrdinal
      );
  }

  run(sql: string, binds: unknown[]): void {
    if (/INSERT INTO prospects/i.test(sql)) {
      const normalizedName = binds[3];
      const existing = this.prospects.find(row => row.org_id === binds[1] && row.normalized_name === normalizedName);
      if (existing) {
        existing.canonical_name = binds[2];
        existing.status = binds[4];
        existing.sector_key = binds[5];
        existing.sector_confidence = binds[6];
        existing.confidence = binds[10];
        existing.provisional = binds[11];
        existing.direction_uncertain = binds[12];
        existing.possible_company_id = binds[13];
        existing.possible_deal_id = binds[14];
        return;
      }
      this.prospects.push({
        id: binds[0],
        org_id: binds[1],
        canonical_name: binds[2],
        normalized_name: normalizedName,
        status: binds[4],
        visibility: 'firm',
        sector_key: binds[5],
        sector_confidence: binds[6],
        first_seen_at: binds[7],
        last_seen_at: binds[8],
        last_signal_at: binds[9],
        confidence: binds[10],
        provisional: binds[11],
        direction_uncertain: binds[12],
        possible_company_id: binds[13],
        possible_deal_id: binds[14],
        signal_count: 0,
        signal_strength: 0,
        signal_strength_reasons: '[]',
      });
      return;
    }

    if (/INSERT INTO prospect_signals/i.test(sql)) {
      if (/dealmaker_id/i.test(sql)) {
        this.upsertSuccessfulSignal(binds);
      } else {
        this.upsertFailedSignal(binds);
      }
      return;
    }

    if (/INSERT(?: OR IGNORE)? INTO prospect_soft_links/i.test(sql)) {
      this.softLinks.push({
        id: binds[0],
        org_id: binds[1],
        prospect_id: binds[2],
        link_type: /possible_duplicate/.test(sql) ? 'possible_duplicate' : binds[3],
        target_type: /'prospect'/.test(sql) ? 'prospect' : binds[4],
        target_id: /'prospect'/.test(sql) ? binds[3] : binds[5],
        score: /'prospect'/.test(sql) ? binds[4] : binds[6],
      });
      return;
    }

    if (/INSERT INTO prospect_classification_history/i.test(sql)) {
      this.classificationHistory.push({
        id: binds[0],
        org_id: binds[1],
        prospect_signal_id: binds[2],
        classifier_version: binds[3],
        previous_classification_json: binds[4],
        new_classification_json: binds[5],
      });
      return;
    }

    if (/INSERT INTO prospect_classifier_samples/i.test(sql)) {
      const existing = this.classifierSamples.find(row =>
        row.org_id === binds[1] &&
        row.source_type === binds[3] &&
        row.source_id === binds[4] &&
        row.mention_ordinal === binds[5]
      );
      const row = existing || {};
      Object.assign(row, {
        id: binds[0],
        org_id: binds[1],
        prospect_signal_id: binds[2],
        source_type: binds[3],
        source_id: binds[4],
        mention_ordinal: binds[5],
        sample_reason: binds[6],
        confidence_tier: binds[7],
        predicted_mention_type: binds[8],
        predicted_direction: binds[9],
        predicted_sector_key: binds[10],
        label_status: 'unlabeled',
      });
      if (!existing) this.classifierSamples.push(row);
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /signal_strength/i.test(sql)) {
      const prospect = this.prospects.find(row => row.id === binds[10] && row.org_id === binds[11]);
      if (prospect) {
        prospect.signal_count = binds[0];
        prospect.evidence_count = binds[1];
        prospect.first_seen_at = binds[2];
        prospect.last_seen_at = binds[3];
        prospect.last_signal_at = binds[4];
        prospect.signal_strength = binds[5];
        prospect.signal_strength_reasons = binds[6];
        prospect.enrichment_priority = binds[7];
        prospect.confidence = binds[8];
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /enrichment_status = 'enriched'/i.test(sql)) {
      const field = sql.match(/SET\s+(\w+)\s+= \?/i)?.[1] || '';
      const [value, prospectId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row && field) {
        row[field] = value;
        row.enrichment_status = 'enriched';
      }
      return;
    }

    if (/INSERT INTO entity_field_state/i.test(sql)) {
      const apply = /current_value = excluded.current_value/i.test(sql);
      if (apply) {
        const [entityId, fieldName, currentValue, sources] = binds;
        const existing = this.entityFieldState.find(row => row.entity_type === 'prospect' && row.entity_id === entityId && row.field_name === fieldName);
        const row = existing || { entity_type: 'prospect', entity_id: entityId, field_name: fieldName };
        Object.assign(row, {
          current_value: currentValue,
          current_value_sources: sources,
          pending_proposals: '{}',
        });
        if (!existing) this.entityFieldState.push(row);
      } else {
        const [entityId, fieldName, proposalValue, sourceKey] = binds;
        const existing = this.entityFieldState.find(row => row.entity_type === 'prospect' && row.entity_id === entityId && row.field_name === fieldName);
        const row = existing || { entity_type: 'prospect', entity_id: entityId, field_name: fieldName, current_value: null, current_value_sources: '[]' };
        row.pending_proposals = JSON.stringify({ [String(proposalValue)]: [String(sourceKey)] });
        if (!existing) this.entityFieldState.push(row);
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /enrichment_status = CASE/i.test(sql)) {
      const [prospectId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === prospectId && entry.org_id === orgId);
      if (row && (!row.enrichment_status || row.enrichment_status === 'not_started')) row.enrichment_status = 'candidate';
      return;
    }

    if (/UPDATE prospect_signals/i.test(sql) && /SET prospect_id/i.test(sql)) {
      if (/id IN/i.test(sql)) {
        const [prospectId, orgId, ...signalIds] = binds;
        for (const row of this.prospectSignals) {
          if (row.org_id === orgId && signalIds.includes(row.id)) row.prospect_id = prospectId;
        }
        return;
      }
      const [winnerId, orgId, loserId] = binds;
      for (const row of this.prospectSignals) {
        if (row.org_id === orgId && row.prospect_id === loserId) row.prospect_id = winnerId;
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /status = 'merged'/i.test(sql)) {
      const [winnerId, loserId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === loserId && entry.org_id === orgId);
      if (row) {
        row.status = 'merged';
        row.possible_duplicate_of = winnerId;
      }
      return;
    }

    if (/UPDATE prospects/i.test(sql) && /possible_duplicate_of = NULL/i.test(sql)) {
      const [status, loserId, orgId] = binds;
      const row = this.prospects.find(entry => entry.id === loserId && entry.org_id === orgId);
      if (row) {
        row.status = status || 'active';
        row.possible_duplicate_of = null;
      }
      return;
    }

    if (/INSERT INTO prospect_merge_audit/i.test(sql)) {
      this.mergeAudit.push({
        id: binds[0],
        org_id: binds[1],
        action: /'unmerge'/.test(sql) ? 'unmerge' : 'merge',
        winner_prospect_id: binds[2],
        loser_prospect_id: binds[3],
        method: binds[4],
        score: binds[5],
        moved_signal_ids: binds[6],
        previous_loser_status: binds[8] || null,
      });
      return;
    }

    if (/INSERT INTO prospect_backfill_coverage/i.test(sql)) {
      this.coverage.push({
        id: binds[0],
        org_id: binds[1],
        run_id: binds[2],
        source_family: binds[3],
        window_start: binds[4],
        window_end: binds[5],
        status: binds[6],
        items_scanned: binds[7],
        signals_recorded: binds[8],
        prospects_upserted: binds[9],
        classifications_pending: binds[10],
        error_message: binds[11],
      });
      return;
    }

    if (/INSERT INTO prospect_backfill_runs/i.test(sql)) {
      this.backfillRuns.push({
        id: binds[0],
        org_id: binds[1],
        window_start: binds[2],
        window_end: binds[3],
        cursor: binds[4],
        status: 'in_progress',
        source_families: binds[5],
        measured_cost_per_item: binds[6],
      });
      return;
    }

    if (/UPDATE prospect_backfill_runs/i.test(sql)) {
      const [cursor, itemsFound, itemsProcessed, signalsRecorded, estimatedCost, runId, orgId] = binds;
      const row = this.backfillRuns.find(entry => entry.id === runId && entry.org_id === orgId);
      if (row) {
        row.status = 'completed';
        row.cursor = cursor;
        row.items_found = itemsFound;
        row.items_processed = itemsProcessed;
        row.signals_recorded = signalsRecorded;
        row.estimated_total_cost = estimatedCost;
      }
    }
  }

  private upsertSuccessfulSignal(binds: unknown[]): void {
    const existing = this.storedSignalFor(binds[1], binds[4], binds[5], binds[6]);
    const row = existing || {};
    Object.assign(row, {
      id: binds[0],
      org_id: binds[1],
      prospect_id: binds[2],
      deal_id: binds[3],
      source_type: binds[4],
      source_id: binds[5],
      mention_ordinal: binds[6],
      span_start: binds[7],
      span_end: binds[8],
      raw_mention_text: binds[9],
      normalized_mention: binds[10],
      source_title: binds[11],
      occurred_at: binds[12],
      direction: binds[13],
      direction_source: binds[14],
      direction_uncertain: binds[15],
      mention_type: binds[16],
      classifier_version: binds[17],
      confidence: binds[18],
      confidence_tier: binds[19],
      classification_status: binds[20],
      resolution_status: binds[21],
      error_message: binds[22],
      classification_attempts: binds[23],
      sector_key: binds[24],
      sector_confidence: binds[25],
      signal_kind: binds[26],
      dealmaker_id: binds[27],
      dealmaker_name: binds[28],
      has_deck: binds[29],
      has_meeting: binds[30],
      ingestion_mode: binds[31],
      metadata_json: binds[32],
    });
    if (!existing) this.prospectSignals.push(row);
  }

  private upsertFailedSignal(binds: unknown[]): void {
    const existing = this.storedSignalFor(binds[1], binds[2], binds[3], binds[4]);
    const row = existing || {};
    Object.assign(row, {
      id: binds[0],
      org_id: binds[1],
      prospect_id: existing?.prospect_id || null,
      source_type: binds[2],
      source_id: binds[3],
      mention_ordinal: binds[4],
      span_start: binds[5],
      span_end: binds[6],
      raw_mention_text: binds[7],
      normalized_mention: binds[8],
      source_title: binds[9],
      occurred_at: binds[10],
      mention_type: existing?.mention_type || 'noise',
      classifier_version: binds[11],
      classification_status: 'failed',
      resolution_status: 'pending',
      error_message: binds[12],
      classification_attempts: binds[13],
      sector_key: existing?.sector_key || 'uncategorized',
      sector_confidence: existing?.sector_confidence || 0,
      ingestion_mode: binds[14],
      metadata_json: binds[15],
    });
    if (!existing) this.prospectSignals.push(row);
  }

}

describe('prospect intelligence deterministic signals', () => {
  it('normalizes prospect identity without thesis inputs', () => {
    expect(normalizeProspectName('NeuralSeek AI Inc.')).toBe('neuralseek');
    expect(normalizeProspectName('Qunnect Technologies, LLC')).toBe('qunnect');
  });

  it('keeps ObjectSecurity as one company and stores slash products as metadata', () => {
    const [candidate] = extractMentionCandidatesFromText(
      '- ObjectSecurity / FortiLayer AI / FortiLayer OT - data security products'
    );

    expect(candidate.canonicalName).toBe('ObjectSecurity');
    expect(candidate.normalizedName).toBe('objectsecurity');
    expect(candidate.products).toEqual(['FortiLayer AI', 'FortiLayer OT']);
  });

  it('does not strip leading digits from company names anchored by domains', () => {
    const [candidate] = extractMentionCandidatesFromText('Please coordinate with 8k-capital.com on closing items.');
    expect(candidate.canonicalName).toBe('8k Capital');
    expect(candidate.normalizedName).toBe('8kcapital');
  });

  it('suppresses meeting scaffolding and canonicalizes repeated adjacent names before classification', async () => {
    const { extractOrganizationMentionsFromSource } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-scaffold',
      subject: 'Intro to Auguria',
      bodyText: [
        'Join with Google Meet: meet.google.com/cya-yrux-nbm',
        'Meeting link meet.google.com/cya-yrux-nbm Join by phone.',
        'DocReq: please upload diligence files.',
        'Warm intro to Auguria and NeuralSeek for the diligence call.',
        'Qunnect Qunnect appears in the copied calendar title.',
        'Greenberg Traurig will handle counsel questions.',
        'Quantum Machines is a separate real organization in the same thread.',
      ].join('\n'),
      fromEmail: 'alice@example.com',
    };

    const mentions = await extractOrganizationMentionsFromSource(item, 'org-1', { INTERNAL_DOMAINS: 'medinavc.com' } as any, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Join with Google Meet', raw: 'Join with Google Meet', context: null },
        { name: 'Meeting link meet.google.com/cya-yrux-nbm Join by phone', raw: 'Meeting link meet.google.com/cya-yrux-nbm Join by phone', context: null },
        { name: 'DocReq', raw: 'DocReq', context: null },
        { name: 'Auguria', raw: 'Auguria', context: null },
        { name: 'NeuralSeek', raw: 'NeuralSeek', context: null },
        { name: 'Qunnect Qunnect', raw: 'Qunnect Qunnect', context: null },
        { name: 'Greenberg Traurig', raw: 'Greenberg Traurig', context: null },
        { name: 'Craig Abod', raw: 'Craig Abod', context: null },
        { name: 'Manny', raw: 'Manny', context: null },
        { name: 'Hi Tony', raw: 'Hi Tony', context: null },
        { name: 'Thursday after', raw: 'Thursday after', context: null },
        { name: 'Employee Search Endpoint', raw: 'Employee Search Endpoint', context: null },
        { name: 'Prospector Spreadsheets', raw: 'Prospector Spreadsheets', context: null },
        { name: 'Cyber Presentation', raw: 'Cyber Presentation', context: null },
        { name: 'Quantum', raw: 'Quantum', context: null },
        { name: 'Quantum Machines', raw: 'Quantum Machines', context: null },
      ],
    });

    const names = mentions.map(mention => mention.canonicalName);
    expect(names).toEqual(expect.arrayContaining(['Auguria', 'NeuralSeek', 'Qunnect', 'Greenberg Traurig', 'Quantum Machines']));
    expect(names).not.toContain('Join with Google Meet');
    expect(names).not.toContain('Meeting link meet.google.com/cya-yrux-nbm Join by phone');
    expect(names).not.toContain('DocReq');
    expect(names).not.toEqual(expect.arrayContaining(['Craig Abod', 'Manny', 'Hi Tony', 'Thursday after', 'Employee Search Endpoint', 'Prospector Spreadsheets', 'Cyber Presentation', 'Quantum']));
    expect(mentions.find(mention => mention.canonicalName === 'Qunnect')?.raw).toBe('Qunnect Qunnect');
  });

  it('keeps keyword sectoring as a prefilter hint only', () => {
    const { sectorHintForText } = __prospectIntelligenceTestHooks;

    expect(sectorHintForText('Auguria security data platform for threat teams').key).toBe('cybersecurity');
    expect(sectorHintForText('ArmyFUZE rugged hardware for Army field teams').key).toBe('aerospace_defense');
    expect(sectorHintForText('Sativa hempcrete materials for construction').key).toBe('materials_manufacturing');
    expect(sectorHintForText('A single uncategorized cold mention').key).toBe('uncategorized');
  });

  it('builds an LLM classifier prompt where the model decides mention type, direction, and sector', () => {
    const { buildClassifierPrefilter, buildProspectClassifierPrompt, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      subject: 'Intro to Auguria',
      bodyText: 'Warm intro to Auguria; deck attached for their security data product.',
      bodyPreview: 'Warm intro to Auguria',
      fromEmail: 'alicia@example.com',
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = buildClassifierPrefilter(item, mention, existing, {} as any);
    const input = classifierInputForRuntime(item, mention, existing, prefilter, {
      knownDeals: [{ name: 'Qunnect', domain: 'qunnect.io' }],
      knownDealmakers: [{ name: 'DIU', domain: 'diu.mil' }],
    }, 'org-1');
    const prompt = buildProspectClassifierPrompt(input);

    expect(prompt.system).toContain('Thesis fit does NOT determine prospect status');
    expect(prompt.system).toContain('KNOWN deals / portfolio (names + domains): Qunnect <qunnect.io>');
    expect(prompt.system).toContain('ai_data, cybersecurity, quantum');
    expect(prompt.system).toContain('"mention_type":"..."');
    expect(prompt.system).toContain('Never output outbound, internal, outbound_prospect');
    expect(prompt.system).toContain('Incidental background references in ordinary email threads');
    expect(prompt.system).toContain('financing/news/background sentence is not automatically an intro_source');
    expect(prompt.system).toContain('nearby companies; classify only the MENTION named in the user prompt');
    expect(prompt.system).toContain('Background entity inside a deal thread');
    expect(prompt.system).toContain('Operational artifact; not website traffic analytics');
    expect(prompt.system).toContain('Literal traffic analytics source row');
    expect(prompt.user).toContain('SOURCE_TYPE: email');
    expect(prompt.user).toContain('MENTION (the company in question): Auguria');
  });

  it('keeps mocked classifier flow on valid taxonomy boundaries for common hard cases', async () => {
    callClaudeWithUsageMock.mockReset();
    const outputs = [
      { mention_type: 'noise', direction: 'outbound', sector_key: 'fintech', sector_confidence: 0.7, confidence: 0.9, reasoning: 'Customer target, not deal flow.' },
      { mention_type: 'news', direction: 'news', sector_key: 'uncategorized', sector_confidence: 0.3, confidence: 0.88, reasoning: 'Reported round context only.' },
      { mention_type: 'known_deal', direction: 'outbound', sector_key: 'quantum', sector_confidence: 0.9, confidence: 0.95, reasoning: 'Exact known deal match.' },
      { mention_type: 'intro_source', direction: 'inbound', sector_key: 'uncategorized', sector_confidence: 0.2, confidence: 0.9, reasoning: 'Active channel forwarding deal flow.' },
    ];
    callClaudeWithUsageMock.mockImplementation(async () => ({
      text: JSON.stringify(outputs.shift()),
      usage: { input_tokens: 80, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    }));

    const baseInput = {
      sourceType: 'email',
      senderAndContext: 'from partner@example.com',
      prefilterHints: { should_classify: true, reasons: [], deterministic_direction: 'unknown' },
      sectorHints: { key: 'uncategorized', confidence: 0.2 },
      knownContext: { knownDeals: [{ name: 'Qunnect', domain: 'qunnect.io' }], knownDealmakers: [{ name: 'DIU', domain: 'diu.mil' }] },
      orgId: 'org-1',
    } as any;

    const customer = await callProspectClassifier({ ...baseInput, companyName: 'Mastercard', rawExcerpt: 'Qunnect is being pitched to Mastercard as a customer.' }, {} as any);
    const investorNews = await callProspectClassifier({ ...baseInput, companyName: 'Quantonation', rawExcerpt: 'Quantonation was named as an investor in a reported round.' }, {} as any);
    const knownDeal = await callProspectClassifier({ ...baseInput, companyName: 'Qunnect', rawExcerpt: 'Portfolio company Qunnect is being pitched outbound.' }, {} as any);
    const introSource = await callProspectClassifier({ ...baseInput, companyName: 'DIU', rawExcerpt: 'DIU is forwarding ArmyFUZE deal flow to the fund.' }, {} as any);

    expect(customer).toMatchObject({ mentionType: 'noise', direction: 'outbound' });
    expect(investorNews).toMatchObject({ mentionType: 'news', direction: 'news' });
    expect(knownDeal).toMatchObject({ mentionType: 'known_deal', direction: 'outbound' });
    expect(introSource).toMatchObject({ mentionType: 'intro_source', direction: 'inbound' });
    expect(callClaudeWithUsageMock.mock.calls.every(([request]) => request.assistantPrefill === '{')).toBe(true);
  });

  it('builds broad mention-centered context without changing deterministic ordinals', () => {
    const text = [
      'DIU sent this as an introduction channel after ArmyFUZE demo day.',
      'Auguria is raising a seed round for its security data platform.',
      'The follow-up asks Medina to review the deck and schedule diligence with the founder.',
    ].join('\n');

    const [mention] = extractMentionCandidatesFromText(text);

    expect(mention.canonicalName).toBe('Auguria');
    expect(mention.mentionOrdinal).toBe(1);
    expect(mention.lineText).toContain('Auguria is raising');
    expect(mention.contextText).toContain('DIU sent this as an introduction channel');
    expect(mention.contextText).toContain('schedule diligence with the founder');
    expect(mention.contextText.length).toBeGreaterThan(mention.lineText.length);
  });

  it('feeds the classifier nearby pre/post source context instead of only the mention line', () => {
    const { buildClassifierPrefilter, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const filler = Array.from({ length: 70 }, (_, index) => `Archive note ${index}: routine portfolio update with no new deal signal.`).join('\n');
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      subject: 'Forwarded ArmyFUZE follow-up',
      bodyText: [
        filler,
        'DIU sent this as an introduction channel after ArmyFUZE demo day.',
        'Auguria is raising a seed round for its security data platform.',
        'The follow-up asks Medina to review the deck and schedule diligence with the founder.',
      ].join('\n'),
      bodyPreview: 'Archive note 0',
      fromEmail: 'partner@diu.mil',
      sentAt: '2026-05-01T00:00:00.000Z',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = buildClassifierPrefilter(item, mention, existing, {} as any);
    const input = classifierInputForRuntime(item, mention, existing, prefilter, {
      knownDeals: [],
      knownDealmakers: [{ name: 'DIU', domain: 'diu.mil' }],
    }, 'org-1');

    expect(input.rawExcerpt).toContain('Mention context:');
    expect(input.rawExcerpt).toContain('DIU sent this as an introduction channel');
    expect(input.rawExcerpt).toContain('schedule diligence with the founder');
  });

  it('parses the gold-kit LLM JSON contract from raw, fenced, and prose-wrapped output', () => {
    const { parseProspectClassifierResponse, parseMentionType, parseDirection, parseSectorKey } = __prospectIntelligenceTestHooks;

    const parsed = parseProspectClassifierResponse(
      '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Deck attached."}',
      'claude-haiku-4-5-20251001'
    );

    expect(parsed.mentionType).toBe('inbound_prospect');
    expect(parsed.direction).toBe('inbound');
    expect(parsed.sectorKey).toBe('cybersecurity');
    expect(parseMentionType('news')).toBe('news');
    expect(parseDirection('news')).toBe('news');
    expect(parseSectorKey('aerospace defense')).toBe('aerospace_defense');
    expect(() => parseMentionType('news_only')).toThrow(/INVALID_LLM_MENTION_TYPE/);
    expect(() => parseDirection('unknown')).toThrow(/INVALID_LLM_DIRECTION/);

    const fenced = parseProspectClassifierResponse(
      '```json\n{"mention_type":"noise","direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.8,"reasoning":"Admin."}\n```',
      'claude-haiku-4-5-20251001'
    );
    expect(fenced.mentionType).toBe('noise');
    expect(fenced.direction).toBe('internal');

    const proseWrapped = parseProspectClassifierResponse(
      'Here is the JSON:\n{"mention_type":"known_deal","direction":"outbound","sector_key":"quantum","sector_confidence":0.7,"confidence":0.88,"reasoning":"Existing deal."}\nDone.',
      'claude-haiku-4-5-20251001'
    );
    expect(proseWrapped.mentionType).toBe('known_deal');
    expect(proseWrapped.direction).toBe('outbound');
  });

  it('ranks meeting/deck/warm-intro signals above single cold or list mentions', () => {
    const strong = computeSignalStrength({
      signalCount: 3,
      hasMeeting: true,
      hasDeck: true,
      hasWarmIntro: true,
      hasOnlyListEntries: false,
      hasOnlyColdMentions: false,
    });
    const listOnly = computeSignalStrength({
      signalCount: 1,
      hasMeeting: false,
      hasDeck: false,
      hasWarmIntro: false,
      hasOnlyListEntries: true,
      hasOnlyColdMentions: false,
    });
    const coldOnly = computeSignalStrength({
      signalCount: 1,
      hasMeeting: false,
      hasDeck: false,
      hasWarmIntro: false,
      hasOnlyListEntries: false,
      hasOnlyColdMentions: true,
    });

    expect(strong.priority).toBe('eager');
    expect(strong.score).toBeGreaterThan(listOnly.score);
    expect(strong.score).toBeGreaterThan(coldOnly.score);
    expect(listOnly.priority).toBe('lazy');
    expect(coldOnly.priority).toBe('lazy');
  });

  it('extracts intro subjects as prospect mentions', () => {
    const [candidate] = extractMentionCandidatesFromText('Intro to Auguria\nWarm intro from Alicia.');
    expect(candidate.canonicalName).toBe('Auguria');
  });

  it('uses the shared organization extractor without email scaffolding or fund people', async () => {
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-org-extract',
      source: 'email',
      subject: 'Fwd: Intro thread',
      bodyText: [
        'Sent: Wednesday, May 27, 2026 9:14 AM',
        'On Thu, Tony wrote:',
        'Hi Tony,',
        'I’m sorry if I missed the earlier calendar invite.',
        'About Auguria',
        'Auguria is raising a seed round for its security data platform.',
        'NeuralSeek is evaluating a partnership with Qunnect.',
        '#neuralseek We should sync on where we are with neural before asking more diligence questions.',
        'Greenberg Traurig is counsel on the matter.',
        'Lucas',
        'Medina Ventures',
      ].join('\n'),
      bodyPreview: 'Auguria is raising',
      fromEmail: 'alice@example.com',
      toEmails: ['tony@medinavc.com'],
      sentAt: '2026-05-27T09:14:00.000Z',
    };

    const mentions = await __prospectIntelligenceTestHooks.extractOrganizationMentionsFromSource(item, 'org-1', env, {
      forceLlm: true,
      llmExtractor: async () => [
        { name: 'Auguria', raw: 'Auguria' },
        { name: 'NeuralSeek', raw: 'NeuralSeek' },
        { name: 'Qunnect', raw: 'Qunnect' },
        { name: 'Greenberg Traurig', raw: 'Greenberg Traurig' },
        { name: 'About Auguria', raw: 'About Auguria' },
        { name: 'I’m sorry if', raw: 'I’m sorry if' },
        { name: 'Neural', raw: 'neural' },
        { name: 'Sent', raw: 'Sent' },
        { name: 'Tony', raw: 'Tony' },
        { name: 'Medina Ventures', raw: 'Medina Ventures' },
      ],
    });
    const names = mentions.map(mention => mention.canonicalName);

    expect(names).toEqual(expect.arrayContaining(['Auguria', 'NeuralSeek', 'Qunnect', 'Greenberg Traurig']));
    expect(names).not.toEqual(expect.arrayContaining(['Sent', 'Fwd', 'On Thu', 'Tony', 'Lucas', 'Medina Ventures', 'About Auguria', 'I’m sorry if', 'Neural']));
    expect(mentions.every(mention => typeof mention.spanStart === 'number')).toBe(true);
    expect(mentions.map(mention => mention.mentionOrdinal)).toEqual([1, 2, 3, 4]);
  });

  it('parses curated dealflow lists beyond the generic extractor cap and preserves per-company fields', () => {
    const { parseDealflowList } = __prospectIntelligenceTestHooks;
    const lines = Array.from({ length: 15 }, (_, index) =>
      `- ArmyCo${index + 1} - Seed - $${index + 1}M - website armyco${index + 1}.com - POC founder${index + 1}@armyco${index + 1}.com - Problem: rugged sensors - Approach: autonomy stack`
    );

    const candidates = parseDealflowList(`ArmyFUZE cohort shortlist\n${lines.join('\n')}`);

    expect(candidates).toHaveLength(15);
    expect(candidates[0]).toMatchObject({
      canonicalName: 'ArmyCo1',
      mentionOrdinal: 1,
      isListEntry: true,
      listFields: {
        stage: 'Seed',
        amount: '$1M',
        website: 'founder1@armyco1.com'.split('@')[1],
      },
    });
    expect(candidates[14].mentionOrdinal).toBe(15);
  });

  it('prefilter drops obvious non-dealflow sources before an LLM call', async () => {
    callClaudeWithUsageMock.mockReset();
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-ramp',
      source: 'email',
      subject: 'Ramp receipt',
      bodyText: 'Ramp bill and payment receipt for May.',
      bodyPreview: 'Ramp bill',
      fromEmail: 'receipts@ramp.com',
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.prefilter_dropped).toBe(1);
    expect(stats.signals_recorded).toBe(0);
    expect(callClaudeWithUsageMock).not.toHaveBeenCalled();
  });

  it('marks the static classifier context for Anthropic prompt caching', () => {
    const { buildClassifierPrefilter, buildProspectClassifierPrompt, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      bodyText: 'Auguria is raising a seed round.',
      fromEmail: 'alice@example.com',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, companyDomain: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
    const prefilter = buildClassifierPrefilter(item, mention, existing, {} as any);
    const prompt = buildProspectClassifierPrompt(classifierInputForRuntime(item, mention, existing, prefilter, {
      knownDeals: [],
      knownDealmakers: [],
    }, 'org-1'));

    expect(Array.isArray(prompt.systemForApi)).toBe(true);
    expect((prompt.systemForApi as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('persists errored classifications as pending signals and retries them by deterministic key', async () => {
    callClaudeWithUsageMock
      .mockRejectedValueOnce(new Error('INVALID_JSON'))
      .mockResolvedValueOnce({
        text: '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Raising in an investment context."}',
        usage: { input_tokens: 100, output_tokens: 20 },
        model: 'claude-haiku-4-5-20251001',
      });

    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-1',
      source: 'email',
      subject: 'Funding update',
      bodyText: 'Auguria is raising a seed round for its security data platform.',
      bodyPreview: 'Auguria is raising',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const first = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(first.signals_recorded).toBe(1);
    expect(first.classifications_pending).toBe(1);
    expect(db.prospectSignals).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      source_type: 'conversation',
      source_id: 'conv-1',
      mention_ordinal: 1,
      classification_status: 'failed',
      resolution_status: 'pending',
      error_message: 'INVALID_JSON',
      classification_attempts: 1,
    });

    await recordProspectBackfillCoverage('org-1', env, {
      sourceFamily: 'email',
      windowStart: item.sentAt,
      windowEnd: item.sentAt,
      itemsScanned: 1,
      signalsRecorded: first.signals_recorded,
      prospectsUpserted: first.prospects_upserted,
      classificationsPending: first.classifications_pending,
      status: 'partial',
      error: first.errors[0]?.error,
    });
    expect(db.coverage[0]).toMatchObject({
      classifications_pending: 1,
      status: 'partial',
      error_message: 'INVALID_JSON',
    });

    const retry = await detectAndRecordProspectSignals([item], 'org-1', env, { ingestionMode: 'backfill' });

    expect(retry.classifications_pending).toBe(0);
    expect(retry.prospects_upserted).toBe(1);
    expect(db.prospectSignals).toHaveLength(1);
    expect(db.prospectSignals[0]).toMatchObject({
      source_type: 'conversation',
      source_id: 'conv-1',
      mention_ordinal: 1,
      classification_status: 'classified',
      resolution_status: 'resolved',
      error_message: null,
      classification_attempts: 2,
      mention_type: 'inbound_prospect',
      prospect_id: db.prospects[0].id,
    });
    expect(db.classificationHistory).toHaveLength(1);
  });

  it('commits medium-confidence classifications as final metadata and samples them for monitoring', async () => {
    callClaudeWithUsageMock.mockReset();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.8,"confidence":0.7,"reasoning":"Potential investment context."}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-medium',
      source: 'email',
      subject: 'Intro to Auguria',
      bodyText: 'Warm intro to Auguria for a security platform.',
      bodyPreview: 'Warm intro to Auguria',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);
    expect(stats.classifications_pending).toBe(0);
    expect(stats.production_samples_recorded).toBe(1);
    expect(db.prospects[0]).toMatchObject({ status: 'active', provisional: 0 });
    expect(db.prospectSignals[0]).toMatchObject({
      confidence_tier: 'medium',
      resolution_status: 'resolved',
    });
    expect(db.classifierSamples[0]).toMatchObject({
      source_id: 'conv-medium',
      sample_reason: 'medium_confidence',
      label_status: 'unlabeled',
    });
  });

  it('downgrades LLM direction conflicts to provisional direction_uncertain metadata', async () => {
    callClaudeWithUsageMock.mockReset();
    callClaudeWithUsageMock
      .mockResolvedValueOnce({
        text: '{"organizations":[{"name":"Auguria","raw":"Auguria"}]}',
        usage: { input_tokens: 60, output_tokens: 12 },
        model: 'claude-haiku-4-5-20251001',
      })
      .mockResolvedValueOnce({
        text: '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.8,"confidence":0.95,"reasoning":"Looks like an intro."}',
        usage: { input_tokens: 90, output_tokens: 20 },
        model: 'claude-haiku-4-5-20251001',
      });
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-direction',
      source: 'email',
      subject: 'Intro to Auguria',
      bodyText: 'Auguria founder@auguria.com would be a good customer intro.',
      bodyPreview: 'Auguria customer intro',
      fromEmail: 'lucas@medinavc.com',
      toEmails: ['founder@auguria.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(db.prospects[0]).toMatchObject({ status: 'provisional', provisional: 1, direction_uncertain: 1 });
    expect(db.prospectSignals[0]).toMatchObject({
      confidence: 0.54,
      confidence_tier: 'low',
      direction_uncertain: 1,
      resolution_status: 'pending',
    });
    expect(db.classifierSamples[0].sample_reason).toBe('direction_uncertain');
  });

  it('firewalls exact-domain existing deals as known_deal signals without creating prospects', async () => {
    callClaudeWithUsageMock.mockReset();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.95,"reasoning":"Investment context."}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({ id: 'company-qunnect', org_id: 'org-1', name: 'Qunnect', domain: 'qunnect.io' });
    db.deals.push({ id: 'deal-qunnect', org_id: 'org-1', company_id: 'company-qunnect', stage: 'talking' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-qunnect',
      source: 'email',
      subject: 'Intro to Qunnect',
      bodyText: 'Qunnect founder@qunnect.io is raising and attached a deck.',
      bodyPreview: 'Qunnect founder@qunnect.io',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
      attachments: [{ id: 'a1', name: 'Qunnect Deck.pdf', size: 100, contentType: 'application/pdf' }],
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.skipped_known_deal).toBe(1);
    expect(stats.prospects_upserted).toBe(0);
    expect(db.prospects).toHaveLength(0);
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'known_deal',
      deal_id: 'deal-qunnect',
      prospect_id: null,
      resolution_status: 'resolved',
    });
  });

  it('holds weak name-only deal matches as separate prospects with soft deal links', async () => {
    callClaudeWithUsageMock.mockReset();
    callClaudeWithUsageMock.mockResolvedValueOnce({
      text: '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"aerospace_defense","sector_confidence":0.8,"confidence":0.9,"reasoning":"Investment intro."}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.companies.push({ id: 'company-portal', org_id: 'org-1', name: 'Portal Aircraft', domain: null });
    db.deals.push({ id: 'deal-portal', org_id: 'org-1', company_id: 'company-portal', stage: 'talking' });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      entityId: 'conv-portal',
      source: 'email',
      subject: 'Intro to Portal Aircraft',
      bodyText: 'Portal Aircraft is raising a seed round for defense aviation.',
      bodyPreview: 'Portal Aircraft is raising',
      fromEmail: 'alice@example.com',
      toEmails: ['lucas@medinavc.com'],
      sentAt: '2026-05-01T00:00:00.000Z',
    };

    const stats = await detectAndRecordProspectSignals([item], 'org-1', env);

    expect(stats.prospects_upserted).toBe(1);
    expect(db.prospects[0]).toMatchObject({
      canonical_name: 'Portal Aircraft',
      status: 'provisional',
      possible_deal_id: 'deal-portal',
    });
    expect(db.prospectSignals[0]).toMatchObject({
      mention_type: 'inbound_prospect',
      deal_id: null,
      prospect_id: db.prospects[0].id,
    });
    expect(db.softLinks.some(link =>
      link.link_type === 'possible_deal_attach' &&
      link.target_type === 'deal' &&
      link.target_id === 'deal-portal'
    )).toBe(true);
  });

  it('records reversible audited prospect merges', async () => {
    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    db.prospects.push(
      { id: 'prospect-winner', org_id: 'org-1', canonical_name: 'NeuralSeek', normalized_name: 'neuralseek', status: 'active', deleted_at: null },
      { id: 'prospect-loser', org_id: 'org-1', canonical_name: 'Neural Seek', normalized_name: 'neuralseek', status: 'provisional', deleted_at: null },
    );
    db.prospectSignals.push({
      id: 'signal-loser',
      org_id: 'org-1',
      prospect_id: 'prospect-loser',
      mention_type: 'inbound_prospect',
      signal_kind: 'intro',
      has_deck: 0,
      has_meeting: 0,
      confidence: 0.9,
      occurred_at: '2026-05-01T00:00:00.000Z',
    });

    const merge = await mergeProspects('org-1', 'prospect-winner', 'prospect-loser', env, {
      method: 'deterministic_normalized_name',
      score: 1,
    });

    expect(merge.moved_signals).toBe(1);
    expect(db.prospectSignals[0].prospect_id).toBe('prospect-winner');
    expect(db.prospects[1]).toMatchObject({ status: 'merged', possible_duplicate_of: 'prospect-winner' });
    expect(db.mergeAudit[0]).toMatchObject({ action: 'merge', loser_prospect_id: 'prospect-loser' });

    const reversed = await reverseProspectMerge('org-1', merge.audit_id, env);

    expect(reversed.restored_signals).toBe(1);
    expect(db.prospectSignals[0].prospect_id).toBe('prospect-loser');
    expect(db.prospects[1]).toMatchObject({ status: 'provisional', possible_duplicate_of: null });
    expect(db.mergeAudit[1]).toMatchObject({ action: 'unmerge', loser_prospect_id: 'prospect-loser' });
  });

  it('applies corroborated own-domain enrichment through entity_field_state without overwriting filled fields', async () => {
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-auguria',
      org_id: 'org-1',
      canonical_name: 'Auguria',
      normalized_name: 'auguria',
      domain: 'auguria.io',
      website: null,
      description: 'Deck-sourced description',
      status: 'active',
      enrichment_status: 'not_started',
      deleted_at: null,
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const result = await applyProspectEnrichmentCandidate('org-1', {
      prospectId: 'prospect-auguria',
      canonicalName: 'Auguria',
      domain: 'auguria.io',
      sourceKind: 'own_domain',
      sourceUrl: 'https://auguria.io',
      fields: {
        website: 'https://auguria.io',
        description: 'Website description should not overwrite.',
      },
    }, env);

    expect(result.applied).toEqual(['website']);
    expect(result.discarded).toContain('description');
    expect(db.prospects[0]).toMatchObject({
      website: 'https://auguria.io',
      description: 'Deck-sourced description',
      enrichment_status: 'enriched',
    });
    expect(db.entityFieldState[0]).toMatchObject({
      entity_type: 'prospect',
      entity_id: 'prospect-auguria',
      field_name: 'website',
      current_value: 'https://auguria.io',
    });
  });

  it('holds uncorroborated third-party enrichment candidates and discards wrong-company facts', async () => {
    const db = new FakeD1();
    db.prospects.push({
      id: 'prospect-portal',
      org_id: 'org-1',
      canonical_name: 'Portal Aircraft',
      normalized_name: 'portalaircraft',
      domain: 'portalaircraft.com',
      description: null,
      status: 'active',
      enrichment_status: 'not_started',
      deleted_at: null,
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const wrongCompany = await applyProspectEnrichmentCandidate('org-1', {
      prospectId: 'prospect-portal',
      canonicalName: 'Portal Software',
      domain: 'portalsoftware.com',
      sourceKind: 'duckduckgo',
      sourceUrl: 'https://portalsoftware.com/about',
      fields: { description: 'Wrong company.' },
    }, env);
    const held = await applyProspectEnrichmentCandidate('org-1', {
      prospectId: 'prospect-portal',
      canonicalName: 'Portal Aircraft',
      domain: 'portalaircraft.com',
      sourceKind: 'duckduckgo',
      sourceUrl: 'https://search.example/portal',
      fields: { description: 'Aerospace autonomy company.' },
      corroboratingSourceCount: 1,
    }, env);

    expect(wrongCompany.discarded).toEqual(['description']);
    expect(held.held).toEqual(['description']);
    expect(db.prospects[0].description).toBeNull();
    expect(db.prospects[0].enrichment_status).toBe('candidate');
    expect(db.entityFieldState[0]).toMatchObject({
      entity_type: 'prospect',
      field_name: 'description',
      current_value: null,
    });
    expect(JSON.parse(db.entityFieldState[0].pending_proposals)).toHaveProperty('Aerospace autonomy company.');
  });

  it('runs prospect enrichment in deterministic signal_strength priority order', async () => {
    const db = new FakeD1();
    db.prospects.push(
      {
        id: 'prospect-low',
        org_id: 'org-1',
        canonical_name: 'LowSignal',
        normalized_name: 'lowsignal',
        domain: 'low.example',
        website: null,
        description: null,
        signal_strength: 10,
        status: 'active',
        enrichment_status: 'not_started',
        deleted_at: null,
      },
      {
        id: 'prospect-high',
        org_id: 'org-1',
        canonical_name: 'HighSignal',
        normalized_name: 'highsignal',
        domain: 'high.example',
        website: null,
        description: null,
        signal_strength: 90,
        status: 'active',
        enrichment_status: 'not_started',
        deleted_at: null,
      },
    );
    const fetched: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      fetched.push(url);
      return {
        ok: true,
        text: async () => '<html><head><title>HighSignal</title><meta name="description" content="Signal description"></head></html>',
      } as any;
    });
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const result = await runProspectEnrichmentCycle('org-1', env, { limit: 2, fetcher: fetcher as any });

    expect(result.scanned).toBe(2);
    expect(fetched[0]).toBe('https://high.example');
    expect(fetched[1]).toBe('https://low.example');
  });

  it('runs a tiny local windowed backfill with coverage and idempotent signal keys', async () => {
    callClaudeWithUsageMock.mockReset();
    callClaudeWithUsageMock.mockResolvedValue({
      text: '{"mention_type":"inbound_prospect","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Investment intro."}',
      usage: { input_tokens: 90, output_tokens: 20 },
      model: 'claude-haiku-4-5-20251001',
    });
    const db = new FakeD1();
    db.sourceConversations.push(
      {
        id: 'hist-conv-1',
        org_id: 'org-1',
        source: 'outlook',
        subject: 'Funding update',
        body_preview: 'Auguria is raising a seed round for security data.',
        sent_at: '2026-04-10T12:00:00.000Z',
        from_email: 'alice@example.com',
        to_emails: '["lucas@medinavc.com"]',
        cc_emails: '[]',
        direction: null,
        visibility: 'private',
        participant_user_ids: '[]',
      },
      {
        id: 'hist-conv-2',
        org_id: 'org-1',
        source: 'outlook',
        subject: 'Deck follow-up',
        body_preview: 'Meet Auguria for the follow-up deck.',
        sent_at: '2026-04-11T12:00:00.000Z',
        from_email: 'alice@example.com',
        to_emails: '["lucas@medinavc.com"]',
        cc_emails: '[]',
        direction: null,
        visibility: 'private',
        participant_user_ids: '[]',
      },
    );
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;

    const first = await runProspectBackfillWindow('org-1', env, {
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-05-01T00:00:00.000Z',
      sourceFamilies: ['conversation'],
      batchLimit: 10,
      measuredCostPerItemUsd: 0.001,
    });
    const second = await runProspectBackfillWindow('org-1', env, {
      windowStart: '2026-04-01T00:00:00.000Z',
      windowEnd: '2026-05-01T00:00:00.000Z',
      sourceFamilies: ['conversation'],
      batchLimit: 10,
      measuredCostPerItemUsd: 0.001,
    });

    expect(first.items_found).toBe(2);
    expect(first.items_processed).toBe(2);
    expect(first.signals_recorded).toBe(2);
    expect(first.reconciliation.scanned).toBeGreaterThanOrEqual(1);
    expect(db.coverage[0]).toMatchObject({
      source_family: 'conversation',
      status: 'completed',
      items_scanned: 2,
      signals_recorded: 2,
      classifications_pending: 0,
    });
    expect(db.backfillRuns[0]).toMatchObject({
      status: 'completed',
      items_found: 2,
      estimated_total_cost: 0.002,
    });
    expect(second.items_found).toBe(2);
    expect(db.prospectSignals).toHaveLength(2);
    expect(new Set(db.prospectSignals.map(row => `${row.source_type}:${row.source_id}:${row.mention_ordinal}`)).size).toBe(2);
    expect(db.prospectSignals.every(row => row.ingestion_mode === 'backfill')).toBe(true);
  });

  it('runs the Phase 6 north-star fixtures end to end without duplicate prospects', async () => {
    callClaudeWithUsageMock.mockReset();
    callClaudeWithUsageMock.mockImplementation(async (request: any) => {
      const company = String(request.user || '').match(/MENTION \(the company in question\): ([^\n]+)/)?.[1] || '';
      const sectors: Record<string, string> = {
        MAX: 'ai_data',
        Auguria: 'cybersecurity',
        Sativa: 'materials_manufacturing',
        'Portal Aircraft': 'aerospace_defense',
      };
      return {
        text: JSON.stringify({
          mention_type: 'inbound_prospect',
          direction: 'inbound',
          sector_key: sectors[company] || 'uncategorized',
          sector_confidence: 0.9,
          confidence: 0.94,
          reasoning: `${company} is presented as an investment opportunity in the fixture.`,
        }),
        usage: { input_tokens: 110, output_tokens: 24 },
        model: 'claude-haiku-4-5-20251001',
      };
    });

    const db = new FakeD1();
    const env = { D1: db, INTERNAL_DOMAINS: 'medinavc.com' } as any;
    const fixtures: any[] = [
      {
        type: 'document',
        entityType: 'document',
        entityId: 'fixture-max-evidence-report',
        subject: 'MAX evidence report',
        bodyText: 'MAX is raising a seed round for an AI data workflow platform. Deck attached and diligence call scheduled.',
        bodyPreview: 'MAX is raising a seed round',
        fromEmail: 'alice@example.com',
        sentAt: '2026-05-21T12:00:00.000Z',
        attachments: [{ id: 'max-deck', name: 'MAX Deck.pdf', size: 1024, contentType: 'application/pdf' }],
      },
      {
        type: 'email',
        entityType: 'conversation',
        entityId: 'fixture-auguria-thread',
        source: 'email',
        subject: 'Intro to Auguria',
        bodyText: 'Warm intro to Auguria; deck attached for their security data platform and we should meet next week.',
        bodyPreview: 'Warm intro to Auguria',
        fromEmail: 'investor@example.com',
        toEmails: ['lucas@medinavc.com'],
        sentAt: '2026-05-22T12:00:00.000Z',
        attachments: [{ id: 'auguria-deck', name: 'Auguria Pitch Deck.pdf', size: 2048, contentType: 'application/pdf' }],
      },
      {
        type: 'document',
        entityType: 'document',
        entityId: 'fixture-armyfuze-list',
        subject: 'ArmyFUZE cohort shortlist',
        bodyText: [
          'ArmyFUZE cohort shortlist',
          '- Sativa - Seed - $1M - website sativa.example - Problem: hempcrete materials for deployable structures - Approach: manufacturing process',
          '- Portal Aircraft - Seed - $2M - website portalaircraft.example - Problem: defense aviation logistics - Approach: autonomous aircraft',
        ].join('\n'),
        bodyPreview: 'ArmyFUZE cohort shortlist',
        fromEmail: 'program@example.mil',
        sentAt: '2026-05-23T12:00:00.000Z',
      },
    ];

    const first = await detectAndRecordProspectSignals(fixtures, 'org-1', env, { ingestionMode: 'backfill' });
    await recordProspectBackfillCoverage('org-1', env, {
      sourceFamily: 'phase6_fixtures',
      windowStart: '2026-05-21T00:00:00.000Z',
      windowEnd: '2026-05-24T00:00:00.000Z',
      itemsScanned: fixtures.length,
      signalsRecorded: first.signals_recorded,
      prospectsUpserted: first.prospects_upserted,
      classificationsPending: first.classifications_pending,
      status: first.classifications_pending === 0 ? 'completed' : 'partial',
    });
    const second = await detectAndRecordProspectSignals(fixtures, 'org-1', env, { ingestionMode: 'backfill' });

    expect(first.items_scanned).toBe(3);
    expect(first.signals_recorded).toBe(4);
    expect(first.prospects_upserted).toBe(4);
    expect(first.classifications_pending).toBe(0);
    expect(db.coverage[0]).toMatchObject({
      source_family: 'phase6_fixtures',
      items_scanned: 3,
      signals_recorded: 4,
      prospects_upserted: 4,
      classifications_pending: 0,
      status: 'completed',
    });
    expect(db.prospects.map(row => row.canonical_name).sort()).toEqual([
      'Auguria',
      'MAX',
      'Portal Aircraft',
      'Sativa',
    ]);
    expect(db.prospectSignals).toHaveLength(4);
    expect(new Set(db.prospectSignals.map(row => `${row.source_type}:${row.source_id}:${row.mention_ordinal}`)).size).toBe(4);
    expect(second.signals_recorded).toBe(4);
    expect(db.prospects).toHaveLength(4);
    expect(db.prospectSignals).toHaveLength(4);
  });

  it('keeps migration 0114 aligned with the reconciled prospect contract', () => {
    const sql = readFileSync('migrations/0114_prospect_intelligence.sql', 'utf8');

    expect(sql).toContain('deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL');
    expect(sql).toContain('idx_prospect_signals_deal');
    expect(sql).toContain('prospect_merge_audit');
    expect(sql).toContain('idx_prospects_deal');
    expect(sql).toContain('ON prospects(org_id, deal_id)');
    expect(sql).toContain('signal_strength INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('description TEXT');
    expect(sql).toContain('founders_json TEXT NOT NULL DEFAULT');
    expect(sql).toContain('classification_status TEXT NOT NULL DEFAULT');
    expect(sql).toContain('resolution_status TEXT NOT NULL DEFAULT');
    expect(sql).toContain('classifications_pending INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('prospect_classifier_samples');
    expect(sql).not.toMatch(/thesis_score|thesis_band|review_queue/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+deals[\s\S]*prospect_id/i);
  });
});

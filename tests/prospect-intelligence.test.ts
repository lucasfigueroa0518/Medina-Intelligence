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
  computeSignalStrength,
  detectAndRecordProspectSignals,
  extractMentionCandidatesFromText,
  normalizeProspectName,
  recordProspectBackfillCoverage,
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
  prospects: any[] = [];
  prospectSignals: any[] = [];
  classificationHistory: any[] = [];
  coverage: any[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<void[]> {
    return Promise.all(statements.map(statement => statement.run()));
  }

  all(sql: string, binds: unknown[]): any[] {
    if (/FROM companies c/i.test(sql) || /FROM dealmakers/i.test(sql)) return [];
    if (/FROM companies\s+WHERE/i.test(sql)) return [];
    if (/FROM prospect_signals/i.test(sql) && /SELECT signal_kind/i.test(sql)) {
      const [prospectId, orgId] = binds;
      return this.prospectSignals
        .filter(row => row.prospect_id === prospectId && row.org_id === orgId && row.mention_type === 'inbound_prospect')
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
    }
    return [];
  }

  first(sql: string, binds: unknown[]): any | null {
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
    }
  }

  private upsertSuccessfulSignal(binds: unknown[]): void {
    const existing = this.storedSignalFor(binds[1], binds[3], binds[4], binds[5]);
    const row = existing || {};
    Object.assign(row, {
      id: binds[0],
      org_id: binds[1],
      prospect_id: binds[2],
      source_type: binds[3],
      source_id: binds[4],
      mention_ordinal: binds[5],
      span_start: binds[6],
      span_end: binds[7],
      raw_mention_text: binds[8],
      normalized_mention: binds[9],
      source_title: binds[10],
      occurred_at: binds[11],
      direction: binds[12],
      direction_source: binds[13],
      direction_uncertain: binds[14],
      mention_type: binds[15],
      classifier_version: binds[16],
      confidence: binds[17],
      confidence_tier: binds[18],
      classification_status: binds[19],
      resolution_status: binds[20],
      error_message: binds[21],
      classification_attempts: binds[22],
      sector_key: binds[23],
      sector_confidence: binds[24],
      signal_kind: binds[25],
      dealmaker_id: binds[26],
      dealmaker_name: binds[27],
      has_deck: binds[28],
      has_meeting: binds[29],
      ingestion_mode: binds[30],
      metadata_json: binds[31],
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
    const existing = { companyId: null, dealId: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
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
    expect(prompt.user).toContain('SOURCE_TYPE: email');
    expect(prompt.user).toContain('MENTION (the company in question): Auguria');
  });

  it('parses only the gold-kit LLM JSON contract and rejects fenced output', () => {
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
    expect(() => parseProspectClassifierResponse(
      '```json\n{"mention_type":"noise","direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.8,"reasoning":"Admin."}\n```',
      'claude-haiku-4-5-20251001'
    )).toThrow();
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

  it('marks the static classifier context for Anthropic prompt caching', () => {
    const { buildClassifierPrefilter, buildProspectClassifierPrompt, classifierInputForRuntime } = __prospectIntelligenceTestHooks;
    const item: any = {
      type: 'email',
      entityType: 'conversation',
      bodyText: 'Auguria is raising a seed round.',
      fromEmail: 'alice@example.com',
    };
    const [mention] = extractMentionCandidatesFromText(item.bodyText);
    const existing = { companyId: null, dealId: null, relationshipStates: [], isInternal: false, matchStrength: 'none' as const };
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

  it('keeps migration 0114 aligned with the reconciled prospect contract', () => {
    const sql = readFileSync('migrations/0114_prospect_intelligence.sql', 'utf8');

    expect(sql).toContain('deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL');
    expect(sql).toContain('idx_prospects_deal');
    expect(sql).toContain('ON prospects(org_id, deal_id)');
    expect(sql).toContain('signal_strength INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('classification_status TEXT NOT NULL DEFAULT');
    expect(sql).toContain('resolution_status TEXT NOT NULL DEFAULT');
    expect(sql).toContain('classifications_pending INTEGER NOT NULL DEFAULT 0');
    expect(sql).not.toMatch(/thesis_score|thesis_band|review_queue/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+deals[\s\S]*prospect_id/i);
  });
});

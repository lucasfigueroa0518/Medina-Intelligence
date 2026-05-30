import { describe, expect, it } from 'vitest';
import {
  __prospectIntelligenceTestHooks,
  computeSignalStrength,
  extractMentionCandidatesFromText,
  normalizeProspectName,
} from '../src/lib/prospect-intelligence';

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
});

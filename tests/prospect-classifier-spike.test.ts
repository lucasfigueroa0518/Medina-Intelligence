import { describe, expect, it } from 'vitest';
import { normalizedGoldLabel, parseGoldRecords, summarize, type PredictionRecord } from '../scripts/prospect-classifier-spike';
import {
  oldMentionTypeToAction,
  PROSPECT_CLASSIFIER_UNIVERSES,
  summarizeOldAnchorAlignment,
  summarizeUniverseDisagreement,
  type UniversePrediction,
} from '../scripts/prospect-classifier-universe-spike';

const basePrediction = {
  item_id: 'row',
  source_type: 'conversation',
  source_id: 'source',
  mention_ordinal: 1,
  company_name: 'ExampleCo',
  split: 'test',
  predicted_mention_type: 'inbound_prospect',
  predicted_prospect_action: 'create_prospect',
  predicted_direction: 'inbound',
  predicted_sector_key: 'cybersecurity',
  confidence: 0.9,
  sector_confidence: 0.8,
  reasoning: null,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  cost_usd: null,
};

function prediction(overrides: Partial<PredictionRecord>): PredictionRecord {
  return {
    ...basePrediction,
    gold_mention_type: 'inbound_prospect',
    gold_direction: 'inbound',
    gold_sector_key: 'cybersecurity',
    gold_label_exclusions: { mention_type: null, direction: null, sector_key: null },
    ...overrides,
  };
}

describe('prospect classifier spike scoring', () => {
  it('parses the human-labeling CSV columns used by the gold-set sheet', () => {
    const [record] = parseGoldRecords([
      'source_type,source_id,mention_ordinal,deterministic_key,company_as_mentioned,surrounding_context,sender_and_context,split,mention_type,direction,sector_key',
      'conversation,conv-1,2,conversation:conv-1:2,Auguria,"Intro context, with comma",from alice,test,inbound_prospect,inbound,cybersecurity',
    ].join('\n'), 'gold-candidates.human-labeling.csv');

    expect(record).toMatchObject({
      item_id: 'conversation:conv-1:2',
      company_name: 'Auguria',
      raw_excerpt: 'Intro context, with comma',
      gold_mention_type: 'inbound_prospect',
      gold_direction: 'inbound',
      gold_sector_key: 'cybersecurity',
    });
  });

  it('normalizes blank and adjudicate labels as excluded, not labels', () => {
    expect(normalizedGoldLabel('')).toEqual({ value: null, excluded_reason: 'blank' });
    expect(normalizedGoldLabel(' - ')).toEqual({ value: null, excluded_reason: 'blank' });
    expect(normalizedGoldLabel('adjudicate')).toEqual({ value: null, excluded_reason: 'adjudicate' });
    expect(normalizedGoldLabel('Needs adjudicate')).toEqual({ value: null, excluded_reason: 'adjudicate' });
    expect(normalizedGoldLabel('inbound_prospect')).toEqual({ value: 'inbound_prospect', excluded_reason: null });
  });

  it('scores each gold column only over rows with a human value and reports exclusions', () => {
    const summary = summarize([
      prediction({ item_id: 'fully-labeled' }),
      prediction({
        item_id: 'sector-blank-noise',
        gold_mention_type: 'noise',
        gold_direction: 'internal',
        gold_sector_key: null,
        gold_label_exclusions: { mention_type: null, direction: null, sector_key: 'blank' },
        predicted_mention_type: 'noise',
        predicted_direction: 'internal',
        predicted_sector_key: 'uncategorized',
      }),
      prediction({
        item_id: 'mention-blank-direction-scored',
        gold_mention_type: null,
        gold_direction: 'inbound',
        gold_sector_key: null,
        gold_label_exclusions: { mention_type: 'blank', direction: null, sector_key: 'blank' },
        predicted_mention_type: 'known_deal',
        predicted_direction: 'inbound',
      }),
      prediction({
        item_id: 'direction-adjudicate',
        gold_mention_type: 'news',
        gold_direction: null,
        gold_sector_key: null,
        gold_label_exclusions: { mention_type: null, direction: 'adjudicate', sector_key: 'blank' },
        predicted_mention_type: 'news',
        predicted_direction: 'outbound',
      }),
      prediction({
        item_id: 'mostly-adjudicate',
        gold_mention_type: null,
        gold_direction: null,
        gold_sector_key: null,
        gold_label_exclusions: { mention_type: 'adjudicate', direction: 'blank', sector_key: 'adjudicate' },
        predicted_mention_type: 'noise',
        predicted_direction: 'news',
      }),
    ], { split: 'test' } as any);

    expect(summary.scoring_coverage).toMatchObject({
      mention_type: {
        scored_rows: 3,
        excluded_rows: 2,
        excluded_by_reason: { blank: 1, adjudicate: 1 },
      },
      direction: {
        scored_rows: 3,
        excluded_rows: 2,
        excluded_by_reason: { blank: 1, adjudicate: 1 },
      },
      sector_key: {
        scored_rows: 1,
        excluded_rows: 4,
        excluded_by_reason: { blank: 3, adjudicate: 1 },
      },
    });
    expect((summary.metrics as any).mention_type.inbound_prospect.precision).toBe(1);
    expect((summary.metrics as any).direction_accuracy).toBe(1);
    expect((summary.metrics as any).sector_accuracy).toBe(1);
    expect(Object.keys((summary.confusion_matrices as any).mention_type)).not.toContain('');
    expect(Object.keys((summary.confusion_matrices as any).direction)).not.toContain('adjudicate');
    expect((summary.confusion_matrices as any).sector_key).toEqual({
      cybersecurity: { cybersecurity: 1 },
    });
  });
});

describe('prospect classifier universe spike', () => {
  const baseUniversePrediction: UniversePrediction = {
    item_id: 'row-1',
    source_type: 'conversation',
    source_id: 'conv-1',
    mention_ordinal: 1,
    company_name: 'MRAI Global',
    split: 'test',
    universe_id: 'balanced-signal-capture',
    universe_name: 'Balanced Signal Capture',
    predicted_mention_type: 'noise',
    prospect_action: 'record_context',
    should_create_prospect: false,
    prospect_company_name: null,
    predicted_direction: 'inbound',
    predicted_sector_key: 'uncategorized',
    confidence: 0.82,
    reasoning: null,
    classifier_error: null,
    raw_model_output: '{}',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    cost_usd: null,
  };

  it('defines three deterministic policy universes', () => {
    expect(PROSPECT_CLASSIFIER_UNIVERSES.map(universe => universe.id)).toEqual([
      'conservative-prospect-creator',
      'balanced-signal-capture',
      'broad-relationship-signal-capture',
    ]);
  });

  it('keeps universe policy text in the current prospect_action architecture', () => {
    const policyText = PROSPECT_CLASSIFIER_UNIVERSES.map(universe => universe.instructions).join(' ');
    expect(policyText).not.toMatch(/relationship_signal|meeting_signal|admin_noise/);
    expect(policyText).toContain('record_context');
    expect(policyText).toContain('create_prospect');
  });

  it('flags fuzzy rows when universes disagree on prospect creation or action', () => {
    const disagreements = summarizeUniverseDisagreement([
      { ...baseUniversePrediction, universe_id: 'conservative-prospect-creator', universe_name: 'Conservative Prospect Creator', should_create_prospect: false, prospect_action: 'record_context', confidence: 0.8 },
      { ...baseUniversePrediction, universe_id: 'balanced-signal-capture', universe_name: 'Balanced Signal Capture', should_create_prospect: false, prospect_action: 'record_context', confidence: 0.85 },
      { ...baseUniversePrediction, universe_id: 'broad-relationship-signal-capture', universe_name: 'Broad Relationship Signal Capture', predicted_mention_type: 'inbound_prospect', should_create_prospect: true, prospect_action: 'create_prospect', confidence: 0.93 },
    ], 0.25);

    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toMatchObject({
      item_id: 'row-1',
      fuzzy: true,
    });
    expect(disagreements[0].reasons).toEqual(expect.arrayContaining([
      'should_create_prospect_disagreement',
      'prospect_action_disagreement',
    ]));
    expect(disagreements[0].should_create_votes).toEqual({ false: 2, true: 1 });
  });

  it('maps old spike mention buckets into the new prospect_action anchor space', () => {
    expect(oldMentionTypeToAction('inbound_prospect')).toBe('create_prospect');
    expect(oldMentionTypeToAction('known_deal')).toBe('attach_existing_deal');
    expect(oldMentionTypeToAction('intro_source')).toBe('record_context');
    expect(oldMentionTypeToAction('noise')).toBe('ignore');
    expect(oldMentionTypeToAction('news')).toBe('ignore');
    expect(oldMentionTypeToAction('web_analytics')).toBe('ignore');
  });

  it('summarizes old-anchor alignment and Lucas-adjusted old-inbound rows', () => {
    const qusecureId = 'conversation:671d5aba-c1b5-4ee6-a013-4d4749a3faa5:1:101:113';
    const noisyId = 'row-old-noise';
    const predictions: UniversePrediction[] = [
      { ...baseUniversePrediction, item_id: qusecureId, company_name: 'Qusecure', universe_id: 'conservative-prospect-creator', universe_name: 'Conservative Prospect Creator', prospect_action: 'ignore' },
      { ...baseUniversePrediction, item_id: qusecureId, company_name: 'Qusecure', universe_id: 'balanced-signal-capture', universe_name: 'Balanced Signal Capture', prospect_action: 'ignore' },
      { ...baseUniversePrediction, item_id: qusecureId, company_name: 'Qusecure', universe_id: 'broad-relationship-signal-capture', universe_name: 'Broad Relationship Signal Capture', prospect_action: 'ignore' },
      { ...baseUniversePrediction, item_id: noisyId, company_name: 'NoiseCo', universe_id: 'conservative-prospect-creator', universe_name: 'Conservative Prospect Creator', prospect_action: 'create_prospect' },
      { ...baseUniversePrediction, item_id: noisyId, company_name: 'NoiseCo', universe_id: 'balanced-signal-capture', universe_name: 'Balanced Signal Capture', prospect_action: 'create_prospect' },
      { ...baseUniversePrediction, item_id: noisyId, company_name: 'NoiseCo', universe_id: 'broad-relationship-signal-capture', universe_name: 'Broad Relationship Signal Capture', prospect_action: 'record_context' },
    ];

    const summary = summarizeOldAnchorAlignment(predictions, [
      { item_id: qusecureId, company_name: 'Qusecure', predicted_mention_type: 'inbound_prospect', confidence: 0.92 },
      { item_id: noisyId, company_name: 'NoiseCo', predicted_mention_type: 'noise', confidence: 0.5 },
    ]);

    expect(summary.old_inbound_overlay).toHaveLength(1);
    expect(summary.old_inbound_overlay[0]).toMatchObject({
      company_name: 'Qusecure',
      lucas_expected_action: 'create_prospect',
      lucas_expected_match_count: 0,
      old_anchor_match_count: 0,
    });
    expect(summary.prospect_creation_risk.old_inbound_all_ignore_rows).toHaveLength(1);
    expect(summary.prospect_creation_risk.old_noise_two_plus_create_prospect_rows).toHaveLength(1);
  });
});

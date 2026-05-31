import { describe, expect, it } from 'vitest';
import { normalizedGoldLabel, parseGoldRecords, summarize, type PredictionRecord } from '../scripts/prospect-classifier-spike';

const basePrediction = {
  item_id: 'row',
  source_type: 'conversation',
  source_id: 'source',
  mention_ordinal: 1,
  company_name: 'ExampleCo',
  split: 'test',
  predicted_mention_type: 'inbound_prospect',
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

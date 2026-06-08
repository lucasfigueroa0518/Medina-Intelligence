import { describe, expect, it } from 'vitest';
import {
  dedupeCandidates,
  isInSourceShard,
  recallSample,
  scoreExperiment,
  sourceShardBucket,
  sourceKeysFromExperimentArtifact,
  type ExperimentPrediction,
} from '../scripts/prospect-large-classifier-experiment';

function prediction(overrides: Partial<ExperimentPrediction>): ExperimentPrediction {
  return {
    item_id: 'conversation:conv-1:1:0:7',
    deterministic_key: 'conversation:conv-1:1:0:7',
    source_type: 'conversation',
    source_channel: 'email',
    source_id: 'conv-1',
    mention_ordinal: 1,
    span_start: 0,
    span_end: 7,
    company_name: 'Auguria',
    normalized_company_name: 'auguria',
    raw_span: 'Auguria',
    raw_excerpt: 'Warm intro to Auguria with deck attached.',
    source_subject: 'Intro to Auguria',
    source_sender: 'alice@example.com',
    occurred_at: '2026-05-01T00:00:00.000Z',
    context_char_count: 42,
    sender_and_context: 'from alice@example.com; subject Intro to Auguria',
    stratum: 'enriched_inbound',
    stratum_reason: 'test',
    classifier_version: 'test-version',
    model: 'claude-haiku-4-5-20251001',
    predicted_prospect_action: 'create_prospect',
    predicted_mention_type: 'inbound_prospect',
    should_create_prospect: true,
    prospect_company_name: 'Auguria',
    predicted_direction: 'inbound',
    predicted_sector_key: 'cybersecurity',
    confidence: 0.95,
    sector_confidence: 0.9,
    reasoning: null,
    create_prospect_veto_applied: false,
    create_prospect_veto_reason: null,
    original_prospect_action: 'create_prospect',
    classifier_error: null,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    cost_usd: null,
    ...overrides,
  };
}

describe('prospect large classifier experiment helpers', () => {
  it('extracts prior source keys from CSV and JSONL artifacts', () => {
    const csvKeys = sourceKeysFromExperimentArtifact([
      'source_type,source_id,mention_ordinal,company_as_mentioned',
      'conversation,conv-prior,1,Auguria',
      'event,event-prior,2,Qunnect',
    ].join('\n'), 'gold-candidates.human-labeling.csv');
    const jsonlKeys = sourceKeysFromExperimentArtifact([
      JSON.stringify({ source_type: 'document', source_id: 'doc-prior', company_name: 'MemoCo' }),
      JSON.stringify({ deterministic_source_type: 'conversation', source_id: 'conv-from-legacy', company_name: 'LegacyCo' }),
    ].join('\n'), 'gold-candidates.all.jsonl');

    expect([...csvKeys].sort()).toEqual(['conversation:conv-prior', 'event:event-prior']);
    expect([...jsonlKeys].sort()).toEqual(['conversation:conv-from-legacy', 'document:doc-prior']);
  });

  it('builds a deterministic recall sample only from predicted non-valuable rows', () => {
    const rows = [
      prediction({ item_id: 'create', predicted_prospect_action: 'create_prospect' }),
      prediction({ item_id: 'attach', predicted_prospect_action: 'attach_existing_deal' }),
      prediction({ item_id: 'ignore-a', predicted_prospect_action: 'ignore', stratum: 'hard_negative' }),
      prediction({ item_id: 'ignore-b', predicted_prospect_action: 'ignore', stratum: 'representative' }),
      prediction({ item_id: 'context-a', predicted_prospect_action: 'record_context', stratum: 'enriched_inbound' }),
    ];

    const sample = recallSample(rows, 3);

    expect(sample).toHaveLength(3);
    expect(sample.every(row => row.predicted_prospect_action === 'ignore' || row.predicted_prospect_action === 'record_context')).toBe(true);
    expect(sample.map(row => row.item_id)).toEqual(recallSample(rows, 3).map(row => row.item_id));
  });

  it('scores valuable precision, exact action precision, confusions, and sampled misses', () => {
    const predictions = [
      prediction({ item_id: 'true-create', company_name: 'Auguria', predicted_prospect_action: 'create_prospect' }),
      prediction({ item_id: 'false-create', company_name: 'Vimeo', predicted_prospect_action: 'create_prospect' }),
      prediction({ item_id: 'true-attach', company_name: 'Qunnect', predicted_prospect_action: 'attach_existing_deal', original_prospect_action: 'attach_existing_deal' }),
      prediction({ item_id: 'confused-attach', company_name: 'Qunnect', predicted_prospect_action: 'attach_existing_deal', original_prospect_action: 'attach_existing_deal' }),
      prediction({ item_id: 'missed-create', company_name: 'Rendair', predicted_prospect_action: 'ignore', original_prospect_action: 'ignore' }),
      prediction({ item_id: 'true-ignore', company_name: 'DocuSign', predicted_prospect_action: 'ignore', original_prospect_action: 'ignore' }),
      prediction({ item_id: 'news-ignore', company_name: 'Helix Earth', predicted_prospect_action: 'ignore', original_prospect_action: 'ignore' }),
      prediction({ item_id: 'nist-ignore', company_name: 'NIST', predicted_prospect_action: 'ignore', original_prospect_action: 'attach_existing_deal' }),
      prediction({ item_id: 'freeform-create', company_name: 'Fendair.ai', predicted_prospect_action: 'create_prospect', original_prospect_action: 'create_prospect' }),
      prediction({
        item_id: 'vetoed-noise',
        company_name: 'Vimeo',
        predicted_prospect_action: 'ignore',
        original_prospect_action: 'create_prospect',
        create_prospect_veto_applied: true,
        create_prospect_veto_reason: 'tool_vendor_or_link_host',
      }),
    ];

    const summary = scoreExperiment(predictions, [
      { item_id: 'true-create', predicted_prospect_action: 'create_prospect', lucas_expected_action: 'inbound_prospect' },
      { item_id: 'false-create', predicted_prospect_action: 'create_prospect', lucas_expected_action: 'noise', error_type: 'artifact' },
      { item_id: 'true-attach', predicted_prospect_action: 'attach_existing_deal', lucas_expected_action: 'known_deal' },
      { item_id: 'confused-attach', predicted_prospect_action: 'attach_existing_deal', lucas_expected_action: 'inbound_prospect', error_type: 'direction_wrong' },
      { item_id: 'freeform-create', predicted_prospect_action: 'create_prospect', lucas_expected_action: '"Fendair.ai" is the company being pitched here.' },
      { item_id: 'blank-label', predicted_prospect_action: 'create_prospect', lucas_expected_action: '' },
    ], [
      { item_id: 'missed-create', predicted_prospect_action: 'ignore', lucas_expected_action: 'inbound_prospect', error_type: 'missed_inbound' },
      { item_id: 'true-ignore', predicted_prospect_action: 'ignore', lucas_expected_action: 'noise' },
      { item_id: 'news-ignore', predicted_prospect_action: 'ignore', lucas_expected_action: 'news' },
      { item_id: 'nist-ignore', predicted_prospect_action: 'ignore', lucas_expected_action: 'NIST' },
      { item_id: 'vetoed-noise', predicted_prospect_action: 'ignore', lucas_expected_action: 'noise' },
      { item_id: 'adjudicate-row', predicted_prospect_action: 'ignore', lucas_expected_action: 'adjudicate' },
    ]);

    expect(summary.valuable_scored_rows).toBe(5);
    expect(summary.valuable_result_precision).toBeCloseTo(4 / 5);
    expect(summary.exact_create_precision).toBeCloseTo(2 / 3);
    expect(summary.exact_attach_precision).toBeCloseTo(1 / 2);
    expect(summary.reviewed_set_valuable_recall).toBeCloseTo(4 / 5);
    expect(summary.create_gate_precision_including_correct_vetoes).toBeCloseTo(3 / 4);
    expect(summary.known_deal_vs_inbound_confusions).toHaveLength(1);
    expect(summary.artifact_false_create_count).toBe(1);
    expect(summary.false_create_rows).toMatchObject([{ item_id: 'false-create' }]);
    expect(summary.veto_wins).toMatchObject([{ item_id: 'vetoed-noise' }]);
    expect(summary.veto_losses).toHaveLength(0);
    expect(summary.estimated_missed_valuable_rate).toBeCloseTo(1 / 5);
    expect(summary.missed_valuable_rows).toMatchObject([{ item_id: 'missed-create' }]);
  });

  it('partitions sources by stable source key before extraction', () => {
    const bucket = sourceShardBucket('conversation', 'conv-1', 4);

    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(4);
    expect(isInSourceShard('conversation', 'conv-1', 4, bucket)).toBe(true);
    expect([
      0, 1, 2, 3,
    ].filter(index => isInSourceShard('conversation', 'conv-1', 4, index))).toEqual([bucket]);
  });

  it('dedupes merged shard rows by item id first, then deterministic mention identity', () => {
    const rows = [
      prediction({ item_id: 'same-item', source_id: 'conv-a', mention_ordinal: 1, normalized_company_name: 'alpha' }),
      prediction({ item_id: 'same-item', source_id: 'conv-a', mention_ordinal: 1, normalized_company_name: 'alpha-duplicate' }),
      prediction({ item_id: 'secondary-a', source_id: 'conv-b', mention_ordinal: 2, normalized_company_name: 'beta' }),
      prediction({ item_id: 'secondary-b', source_id: 'conv-b', mention_ordinal: 2, normalized_company_name: 'beta' }),
    ];

    const deduped = dedupeCandidates(rows);

    expect(deduped).toHaveLength(2);
    expect(deduped.map(row => row.item_id).sort()).toEqual(['same-item', 'secondary-a']);
  });
});

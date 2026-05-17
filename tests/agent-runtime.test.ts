import { describe, expect, it } from 'vitest';
import { planDeterministicSourceRouting } from '../src/lib/source-router';
import { TurnSourceRegistry } from '../src/lib/turn-source-registry';
import type { CitationSource } from '../src/lib/citations';

const initialSource: CitationSource = {
  id: 1,
  type: 'email',
  source_table: 'conversations',
  source_id: 'email-1',
  title: 'Initial email',
  url_path: '/conversations/email-1',
};

describe('MARTy turn runtime contracts', () => {
  it('keeps turn source IDs append-only when tools add evidence later', () => {
    const registry = new TurnSourceRegistry([initialSource]);
    const transformed = registry.appendToolResult('recall', {
      sources: [
        {
          id: 1,
          type: 'meeting',
          source_table: 'events',
          source_id: 'event-1',
          title: 'NeuralSeek meeting',
          citation_marker: '[^1]',
        },
        {
          id: 2,
          type: 'email',
          source_table: 'conversations',
          source_id: 'email-1',
          title: 'Duplicate initial email',
          citation_marker: '[^2]',
        },
      ],
      answer_hint: 'Use [^1] and [^2].',
    });

    expect(registry.all().map(s => `${s.id}:${s.source_table}:${s.source_id}`)).toEqual([
      '1:conversations:email-1',
      '2:events:event-1',
    ]);
    expect(transformed.delta.map(s => s.id)).toEqual([2]);
    expect(transformed.result.sources[0].citation_marker).toBe('[^2]');
    expect(transformed.result.sources[1].citation_marker).toBe('[^1]');
    expect(transformed.result.answer_hint).toContain('[^2]');
  });

  it('routes meeting and transcript requests to events plus meeting-scoped recall', () => {
    const plan = planDeterministicSourceRouting('Give me a window into recent and upcoming meetings and event transcripts');
    expect(plan.calls.map(call => call.tool)).toEqual(['search_events', 'recall']);
    expect(plan.calls[0].input.include_transcript_excerpt).toBe(true);
    expect(plan.calls[1].input.source_types).toEqual(['meeting']);
  });

  it('routes Slack/email/document questions only when the source intent is explicit', () => {
    expect(planDeterministicSourceRouting('What has been happening on Slack about NeuralSeek?').calls[0]).toMatchObject({
      tool: 'recall',
      input: { source_types: ['slack'] },
    });
    expect(planDeterministicSourceRouting('Find the memo and deck for NeuralSeek').calls[0]).toMatchObject({
      tool: 'recall',
      input: { source_types: ['document'] },
    });
    expect(planDeterministicSourceRouting('What should I do next?').calls).toHaveLength(0);
  });

  it('routes portfolio and pipeline questions through the firm-state snapshot first', () => {
    const plan = planDeterministicSourceRouting('rank our current portfolio companies by the strength of their financials');

    expect(plan.intent).toBe('firm_state');
    expect(plan.calls[0]).toMatchObject({
      tool: 'get_firm_relationship_snapshot',
      input: { include_pipeline: true },
    });

    expect(planDeterministicSourceRouting('Hedgehog is also a portco').calls[0]).toMatchObject({
      tool: 'get_firm_relationship_snapshot',
    });
  });
});

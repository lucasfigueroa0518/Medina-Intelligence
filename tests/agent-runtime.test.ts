import { describe, expect, it } from 'vitest';
import { planDeterministicSourceRouting } from '../src/lib/source-router';
import { TurnSourceRegistry } from '../src/lib/turn-source-registry';
import { __agentToolStateTestHooks } from '../src/handlers/agent';
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

  it('persists tool UI state as append-only runs', () => {
    const { upsertDurableToolEvent } = __agentToolStateTestHooks;
    let calls = upsertDurableToolEvent([], {
      type: 'tool_call',
      tool: 'recall',
      input: { query: 'NeuralSeek' },
      status: 'executing',
    });
    calls = upsertDurableToolEvent(calls, {
      type: 'tool_result',
      tool: 'recall',
      result: { count: 2, sources: [{ id: 1 }, { id: 2 }] },
      status: 'done',
    });
    calls = upsertDurableToolEvent(calls, {
      type: 'tool_call',
      tool: 'recall',
      input: { query: 'Tier4' },
      status: 'started',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('started');
    expect(calls[0].runs).toHaveLength(2);
    expect(calls[0].runs[0]).toMatchObject({
      input: { query: 'NeuralSeek' },
      result: { count: 2 },
      status: 'done',
    });
    expect(calls[0].runs[1]).toMatchObject({
      input: { query: 'Tier4' },
      status: 'started',
    });
  });

  it('sanitizes deck job hydration to user-safe fields', () => {
    const { safeDeckJobForMessage } = __agentToolStateTestHooks;
    const job = safeDeckJobForMessage({
      id: 'deck-job-1',
      status: 'qa_blocked',
      phase: 'qa_blocked',
      title: 'NeuralSeek deck',
      artifact_visibility: 'draft_review',
      status_label: 'QA blocked',
      qa_summary: { critical: 1 },
      qa_findings: [{ slideId: 's1', severity: 'critical', issue: 'overflow' }],
      visible_document_cards: [{ document_id: 'doc-1', title: 'Polished deck' }],
      diagnostic_document_cards: [{ document_id: 'qa-1', title: 'QA report' }],
      render_result: { screenshots: [{ base64: 'secret' }] },
      fact_ledger: [{ claim: 'private' }],
      last_event_seq: 7,
      last_event_message: 'QA found layout issues',
    });

    expect(job).toMatchObject({
      id: 'deck-job-1',
      status: 'qa_blocked',
      artifact_visibility: 'draft_review',
      last_event_seq: 7,
      last_event_message: 'QA found layout issues',
    });
    expect(job).not.toHaveProperty('render_result');
    expect(job).not.toHaveProperty('fact_ledger');
    expect(job?.diagnostic_document_cards).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { __claudeTestHooks } from '../src/lib/claude';

describe('Claude provider handoff safety', () => {
  it('compacts large tool results before returning them to the model', () => {
    const result = {
      rows: Array.from({ length: 45 }, (_, index) => ({
        id: `row-${index}`,
        summary: `candidate ${index}`,
        body: 'x'.repeat(5_000),
        raw: 'raw provider/body payload should not be re-injected',
      })),
      base64: 'deadbeef',
    };

    const modelPayload = __claudeTestHooks.stringifyToolResultForModel('recall', result);

    expect(modelPayload.length).toBeLessThan(90_000);
    expect(modelPayload).toContain('truncated_for_model_context');
    expect(modelPayload).not.toContain('x'.repeat(3_000));
    expect(modelPayload).not.toContain('raw provider/body payload should not be re-injected');
    expect(modelPayload).toContain('[omitted from model context]');
  });

  it('keeps array truncation visible when the compact result fits in context', () => {
    const compact = __claudeTestHooks.stringifyToolResultForModel(
      'search_contacts',
      { rows: Array.from({ length: 45 }, (_, index) => ({ id: index, name: `Person ${index}` })) }
    );

    expect(compact).toContain('"omitted_count":5');
    expect(compact).not.toContain('Person 44');
  });

  it('classifies token and context-size provider rejections as recoverable once', () => {
    expect(__claudeTestHooks.isRecoverableProviderRejection(
      400,
      'input messages exceed the model context window'
    )).toBe(true);
    expect(__claudeTestHooks.isRecoverableProviderRejection(
      413,
      'request entity too large: prompt tokens exceed maximum'
    )).toBe(true);
    expect(__claudeTestHooks.isRecoverableProviderRejection(
      400,
      'invalid tool schema: missing required property'
    )).toBe(false);
  });

  it('compacts prior oversized tool_result blocks for provider retry', () => {
    const [message] = __claudeTestHooks.compactMessagesForProviderRetry([
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: JSON.stringify({ rows: Array.from({ length: 100 }, () => 'z'.repeat(2_000)) }),
          },
        ],
      },
    ]);

    expect(message.content[0].content.length).toBeLessThan(85_000);
    expect(message.content[0].content).toContain('tool result truncated for provider retry');
  });
});

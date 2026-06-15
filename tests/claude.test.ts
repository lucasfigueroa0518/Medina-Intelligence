import { describe, expect, it } from 'vitest';
import { __claudeTestHooks } from '../src/lib/claude';

describe('Claude provider handoff safety', () => {
  it('preserves prompt cache controls on structured system blocks and tools', () => {
    const body = __claudeTestHooks.buildAnthropicRequestBody({
      model: 'claude-test',
      max_tokens: 123,
      system: [
        { type: 'text', text: 'stable block', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'dynamic block' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'recall',
          description: 'Stable schema',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    });

    expect(body.system).toEqual([
      { type: 'text', text: 'stable block', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'dynamic block' },
    ]);
    expect(body.tools).toEqual([
      {
        name: 'recall',
        description: 'Stable schema',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });

  it('marks the final user text block for active conversation cache writes', () => {
    const [message] = __claudeTestHooks.cloneWithMessageCacheControl(
      [{ role: 'user', content: 'history and current query' }],
      { type: 'ephemeral', ttl: '5m' }
    );

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'history and current query',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ]);

    const [, finalMessage] = __claudeTestHooks.cloneWithMessageCacheControl(
      [
        { role: 'user', content: [{ type: 'text', text: 'older block' }] },
        { role: 'assistant', content: 'assistant text' },
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
            { type: 'text', text: 'final query block' },
          ],
        },
      ],
      { type: 'ephemeral', ttl: '5m' }
    ).slice(1);

    expect(finalMessage.content[1]).toEqual({
      type: 'text',
      text: 'final query block',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
  });

  it('builds zero-token prewarm bodies and only classifies compatible fallback errors', () => {
    const system = [
      { type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ] as any;
    const tools = [
      {
        name: 'recall',
        description: 'Stable schema',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ] as any;

    expect(__claudeTestHooks.buildPrewarmAnthropicRequestBody(
      { system, user: 'warmup', model: 'claude-test', tools },
      0
    )).toMatchObject({ max_tokens: 0, system, tools });
    expect(__claudeTestHooks.buildPrewarmAnthropicRequestBody(
      { system, user: 'warmup', model: 'claude-test', tools },
      1
    )).toMatchObject({ max_tokens: 1, system, tools });
    expect(__claudeTestHooks.isZeroTokenPrewarmRejection(400, 'max_tokens must be greater than 0')).toBe(true);
    expect(__claudeTestHooks.isZeroTokenPrewarmRejection(400, 'invalid tool schema: missing input_schema')).toBe(false);
    expect(__claudeTestHooks.isZeroTokenPrewarmRejection(500, 'max_tokens must be greater than 0')).toBe(false);
  });

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

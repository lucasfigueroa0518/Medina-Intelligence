import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../src/types/interfaces';
import { GOD_MODE_SYSTEM_PROMPT } from '../src/prompts/god-mode';
import {
  MARTY_MAX_MODE_STATIC_PROMPT,
  buildMartySystemPromptBlocks,
} from '../src/lib/marty-runtime';

const ctx: AuthContext = {
  orgId: 'org-cache-test',
  userId: 'user-sensitive-123',
  userRole: 'member',
  email: 'sensitive.user@example.com',
};

function requireBlocks(system: ReturnType<typeof buildMartySystemPromptBlocks>) {
  expect(Array.isArray(system)).toBe(true);
  return system as Exclude<typeof system, string>;
}

describe('MARTy prompt cache layout', () => {
  it('keeps normal-mode identity and date data out of cached blocks', () => {
    const blocks = requireBlocks(buildMartySystemPromptBlocks(
      ctx,
      new Date('2026-06-15T12:00:00.000Z')
    ));

    expect(blocks[0]).toEqual({
      type: 'text',
      text: GOD_MODE_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(blocks[0].text).not.toContain('sensitive.user@example.com');
    expect(blocks[0].text).not.toContain('user-sensitive-123');
    expect(blocks[0].text).not.toContain('June 15, 2026');

    const dynamicText = blocks.slice(1).map(block => block.text).join('\n\n');
    expect(dynamicText).toContain('sensitive.user@example.com');
    expect(dynamicText).toContain('user-sensitive-123');
    expect(dynamicText).toContain('June 15, 2026');
  });

  it('caches only stable MAX instructions while keeping turn scope and forced data dynamic', () => {
    const forcedInstruction = 'FORCED MAX SET SOURCE DATA: Source Alpha roster is complete for this turn.';
    const blocks = requireBlocks(buildMartySystemPromptBlocks(
      ctx,
      new Date('2026-06-15T12:00:00.000Z'),
      {
        deepDive: true,
        stats: { emails: 7, meetings: 3, documents: 2, contacts: 11, companies: 5 },
        forcedMaxSetInstruction: forcedInstruction,
      }
    ));

    const cachedBlocks = blocks.filter(block => block.cache_control);
    expect(cachedBlocks).toHaveLength(2);
    expect(cachedBlocks[0].text).toBe(GOD_MODE_SYSTEM_PROMPT);
    expect(cachedBlocks[1].text).toBe(MARTY_MAX_MODE_STATIC_PROMPT);
    expect(cachedBlocks.every(block => block.cache_control?.ttl === '1h')).toBe(true);

    for (const block of cachedBlocks) {
      expect(block.text).not.toContain('sensitive.user@example.com');
      expect(block.text).not.toContain('user-sensitive-123');
      expect(block.text).not.toContain('June 15, 2026');
      expect(block.text).not.toContain('Source Alpha');
      expect(block.text).not.toContain('7 emails');
    }

    const dynamicText = blocks
      .filter(block => !block.cache_control)
      .map(block => block.text)
      .join('\n\n');
    expect(dynamicText).toContain('sensitive.user@example.com');
    expect(dynamicText).toContain('June 15, 2026');
    expect(dynamicText).toContain('7 emails');
    expect(dynamicText).toContain('Source Alpha');
  });
});

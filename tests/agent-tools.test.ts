import { describe, expect, it } from 'vitest';
import { __agentToolsTestHooks, searchConversations } from '../src/lib/agent-tools';
import type { AuthContext } from '../src/types/interfaces';

const ctx: AuthContext = {
  orgId: 'org-1',
  userId: 'user-1',
  userRole: 'member',
};

describe('agent tool source contracts', () => {
  it('does not silently treat Firefly transcripts as conversation rows', async () => {
    const result = await searchConversations(
      ctx,
      { source: 'firefly', limit: 10 },
      {} as any
    );

    expect(result.error).toBe('SOURCE_NOT_IN_CONVERSATIONS');
    expect(result.message).toMatch(/events table/i);
  });

  it('keeps generic meeting-window words out of event keyword filters', () => {
    expect(__agentToolsTestHooks.deriveEventKeywordTerms('recent and upcoming meetings and events')).toEqual([]);
    expect(__agentToolsTestHooks.deriveEventKeywordTerms('NeuralSeek meeting transcript recap')).toEqual(['neuralseek']);
    expect(__agentToolsTestHooks.deriveEventKeywordTerms('Bank of America upcoming meetings')).toEqual(['bank', 'america']);
  });
});

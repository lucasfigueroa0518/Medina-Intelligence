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

  it('allows all-time conversation search and removes the old 365-day ceiling', () => {
    expect(__agentToolsTestHooks.conversationLookbackDays(0)).toBeNull();
    expect(__agentToolsTestHooks.conversationLookbackDays(1200)).toBe(1200);
    expect(__agentToolsTestHooks.conversationLookbackDays(9000)).toBe(3650);
  });

  it('uses conversation FTS for keyword recall instead of LIKE scans', () => {
    const sql = __agentToolsTestHooks.conversationSearchCteSql();
    expect(sql).toContain('conversation_search_fts');
    expect(sql).toContain('MATCH');
  });
});

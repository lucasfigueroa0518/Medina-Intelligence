import type { Env } from '../../types/env';
import type { SemanticExtractionPayload } from '../../types/semantic-intelligence';
import type { WorkQueueHandler } from '../work-queue-driver';
import {
  SEMANTIC_INTELLIGENCE_DOMAIN,
  processSemanticIntelligenceItem,
} from '../semantic-intelligence';
import { recordRateLimit } from '../upstream-budget';

const RATE_LIMIT_PATTERNS = [
  'CLAUDE_RATE_LIMITED',
  '429',
  'rate_limit',
  'Too Many Requests',
  'throttl',
];

export const semanticIntelligenceHandler: WorkQueueHandler = {
  domain: SEMANTIC_INTELLIGENCE_DOMAIN,
  batchSize: 10,
  maxConcurrent: 64,
  cadence: 'minute',

  process: async (item, env: Env) => {
    let payload: SemanticExtractionPayload;
    try {
      payload = JSON.parse(item.payload) as SemanticExtractionPayload;
    } catch (e) {
      throw new Error(`malformed semantic_intelligence_v1 payload: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!payload.source_table || !payload.source_id) {
      throw new Error(`semantic_intelligence_v1 payload missing source_table/source_id: ${item.payload}`);
    }

    try {
      await processSemanticIntelligenceItem(env, item.org_id, payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (payload.use_llm && RATE_LIMIT_PATTERNS.some(pattern => msg.toLowerCase().includes(pattern.toLowerCase()))) {
        await recordRateLimit(env, item.org_id, null, 'claude', 'minute').catch(() => {});
      }
      throw e;
    }
  },
};

import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { recordRateLimit, recordUsage } from '../upstream-budget';
import {
  RAG_V2_WORK_QUEUE_DOMAIN,
  reindexRagV2Item,
  type RagV2ReindexPayload,
} from '../rag-v2';

const RATE_LIMIT_PATTERNS = [
  'Too Many Requests',
  '429',
  '40041',
  'rate_limit',
  'throttl',
];

export const ragReindexV2Handler: WorkQueueHandler = {
  domain: RAG_V2_WORK_QUEUE_DOMAIN,
  batchSize: 2,
  maxConcurrent: 4,
  cadence: 'minute',

  process: async (item, env: Env) => {
    let payload: RagV2ReindexPayload;
    try {
      payload = JSON.parse(item.payload) as RagV2ReindexPayload;
    } catch (e) {
      throw new Error(`malformed rag_reindex_v2 payload: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!payload.source_id || !payload.source_table) {
      throw new Error(`rag_reindex_v2 payload missing source_table/source_id: ${item.payload}`);
    }

    try {
      const result = await reindexRagV2Item(env, item.org_id, payload);
      if (result.status === 'partial') {
        throw new Error(`RAG_V2_PARTIAL_INDEX: ${result.errors.slice(0, 3).join('; ')}`);
      }
      if (result.status === 'indexed') {
        await recordUsage(env, item.org_id, null, 'bge', 'per_second').catch(() => {});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (RATE_LIMIT_PATTERNS.some(pattern => msg.toLowerCase().includes(pattern.toLowerCase()))) {
        await recordRateLimit(env, item.org_id, null, 'bge', 'per_second').catch(() => {});
      }
      throw e;
    }
  },
};

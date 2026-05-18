import type { Env } from '../../types/env';
import {
  DECK_RENDER_WORK_DOMAIN,
  markDeckRenderQueueFailure,
  processDeckRenderJob,
} from '../document-artifacts';
import type { WorkQueueHandler } from '../work-queue-driver';

interface DeckRenderWorkPayload {
  deck_job_id?: string;
}

export const deckRenderHandler: WorkQueueHandler = {
  domain: DECK_RENDER_WORK_DOMAIN,
  batchSize: 1,
  maxConcurrent: 1,
  cadence: 'minute',

  process: async (item, env: Env) => {
    let payload: DeckRenderWorkPayload;
    try {
      payload = JSON.parse(item.payload || '{}') as DeckRenderWorkPayload;
    } catch (e) {
      throw new Error(`malformed deck_render payload: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!payload.deck_job_id) {
      throw new Error(`deck_render payload missing deck_job_id: ${item.payload}`);
    }
    const nextAttempt = Number(item.attempt || 0) + 1;
    const maxAttempts = Number(item.max_attempts || 1);
    try {
      await processDeckRenderJob(env, payload.deck_job_id, {
        attempt: nextAttempt,
        maxAttempts,
      });
    } catch (error) {
      await markDeckRenderQueueFailure(env, payload.deck_job_id, error, {
        terminal: nextAttempt >= maxAttempts,
        attempt: nextAttempt,
        maxAttempts,
      }).catch(() => {});
      throw error;
    }
  },
};

import type { Env } from '../../types/env';
import {
  DECK_RENDER_WORK_DOMAIN,
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
    await processDeckRenderJob(env, payload.deck_job_id);
  },
};

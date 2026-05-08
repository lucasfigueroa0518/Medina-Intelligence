import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { DEAL_REPLAY_DOMAIN, processDealReplayWorkItem } from '../deal-replay';
import type { WorkQueueRow } from '../work-queue';

export const dealReplayEvidenceHandler: WorkQueueHandler = {
  domain: DEAL_REPLAY_DOMAIN,
  batchSize: 2,
  async process(item: WorkQueueRow, env: Env): Promise<void> {
    await processDealReplayWorkItem(item, env);
  },
};

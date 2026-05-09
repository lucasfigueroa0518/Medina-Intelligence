import type { Env } from '../../types/env';
import {
  MARTY_LAB_EXPERIMENT_DOMAIN,
  processMartyLabExperimentWorkItem,
} from '../marty-lab';
import type { WorkQueueHandler } from '../work-queue-driver';
import type { WorkQueueRow } from '../work-queue';

export const martyLabExperimentHandler: WorkQueueHandler = {
  domain: MARTY_LAB_EXPERIMENT_DOMAIN,
  batchSize: 1,
  maxConcurrent: 1,
  async process(item: WorkQueueRow, env: Env): Promise<void> {
    await processMartyLabExperimentWorkItem(item, env);
  },
};

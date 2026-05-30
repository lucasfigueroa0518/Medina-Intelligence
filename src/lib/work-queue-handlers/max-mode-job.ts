import type { Env } from '../../types/env';
import {
  MAX_MODE_WORK_QUEUE_DOMAIN,
  processMaxModeWorkItem,
} from '../max-orchestrator';
import type { WorkQueueHandler } from '../work-queue-driver';

export const maxModeJobHandler: WorkQueueHandler = {
  domain: MAX_MODE_WORK_QUEUE_DOMAIN,
  batchSize: 1,
  maxConcurrent: 1,
  cadence: 'minute',

  process: async (item, env: Env) => {
    await processMaxModeWorkItem(item, env);
  },
};

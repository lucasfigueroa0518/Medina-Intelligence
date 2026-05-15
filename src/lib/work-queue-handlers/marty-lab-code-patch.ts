import type { Env } from '../../types/env';
import {
  MARTY_LAB_CODE_PATCH_DOMAIN,
  processMartyLabCodePatchWorkItem,
} from '../marty-lab';
import type { WorkQueueHandler } from '../work-queue-driver';
import type { WorkQueueRow } from '../work-queue';

export const martyLabCodePatchHandler: WorkQueueHandler = {
  domain: MARTY_LAB_CODE_PATCH_DOMAIN,
  batchSize: 1,
  maxConcurrent: 1,
  async process(item: WorkQueueRow, env: Env): Promise<void> {
    await processMartyLabCodePatchWorkItem(item, env);
  },
};

import type { Env } from '../../types/env';
import {
  MARTY_LAB_ARTIFACT_REVIEW_DOMAIN,
  processMartyLabArtifactReviewWorkItem,
} from '../marty-lab';
import type { WorkQueueHandler } from '../work-queue-driver';
import type { WorkQueueRow } from '../work-queue';

export const martyLabArtifactReviewHandler: WorkQueueHandler = {
  domain: MARTY_LAB_ARTIFACT_REVIEW_DOMAIN,
  batchSize: 2,
  maxConcurrent: 1,
  async process(item: WorkQueueRow, env: Env): Promise<void> {
    await processMartyLabArtifactReviewWorkItem(item, env);
  },
};

import type { WorkQueueHandler } from '../work-queue-driver';
import {
  CRM_NAME_BACKFILL_DOMAIN,
  processCrmNameBackfillWorkItem,
} from '../crm-name-backfill';

export const crmNameBackfillHandler: WorkQueueHandler = {
  domain: CRM_NAME_BACKFILL_DOMAIN,
  batchSize: 24,
  maxConcurrent: 24,
  processConcurrency: 24,
  claimBatchCap: 24,
  process: processCrmNameBackfillWorkItem,
};

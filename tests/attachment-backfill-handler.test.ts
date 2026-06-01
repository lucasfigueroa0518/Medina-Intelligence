import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAttachmentBackfillBatchMock = vi.hoisted(() => vi.fn());
const deadLetterWorkMock = vi.hoisted(() => vi.fn());
const recordRateLimitMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/attachment-backfill-orchestrator', () => ({
  runAttachmentBackfillBatch: runAttachmentBackfillBatchMock,
}));

vi.mock('../src/lib/work-queue', () => ({
  deadLetterWork: deadLetterWorkMock,
}));

vi.mock('../src/lib/upstream-budget', () => ({
  recordRateLimit: recordRateLimitMock,
}));

import { attachmentBackfillHandler } from '../src/lib/work-queue-handlers/attachment-backfill';
import type { WorkQueueRow } from '../src/lib/work-queue';

function makeItem(payload: unknown): WorkQueueRow {
  return {
    id: 'work-1',
    org_id: 'org-1',
    domain: 'attachment_backfill',
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    status: 'in_progress',
    attempt: 0,
    max_attempts: 6,
    next_attempt_at: null,
    last_error: null,
    locked_until: null,
    heartbeat_at: null,
    upstream: 'graph',
    idempotency_key: null,
    priority: 25,
    created_at: '2026-05-31T00:00:00.000Z',
    started_at: null,
    completed_at: null,
  };
}

function makeEnv(userId = 'user-1'): any {
  return {
    D1: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return userId ? { id: userId } : null; },
        };
      },
    },
  };
}

describe('attachment_backfill work-queue handler', () => {
  beforeEach(() => {
    runAttachmentBackfillBatchMock.mockReset();
    deadLetterWorkMock.mockReset();
    recordRateLimitMock.mockReset();
  });

  it('dead-letters malformed payloads', async () => {
    await attachmentBackfillHandler.process(makeItem('{bad json'), makeEnv());

    expect(deadLetterWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      expect.stringContaining('malformed attachment_backfill payload')
    );
    expect(runAttachmentBackfillBatchMock).not.toHaveBeenCalled();
  });

  it('runs a single-conversation batch with preferred user and completes cleanly', async () => {
    runAttachmentBackfillBatchMock.mockResolvedValue({
      jobId: 'job-1',
      conversations_processed: 1,
      attachments_attempted: 1,
      attachments_persisted: 1,
      attachments_failed: 0,
      attachments_skipped_unrecoverable: 0,
      embeddings_queued: 1,
      errors: [],
    });

    await attachmentBackfillHandler.process(makeItem({
      conversation_id: 'conv-1',
      preferred_user_id: 'preferred-user',
      origin: 'manual',
      detected_at: '2026-05-31T00:00:00.000Z',
    }), makeEnv());

    expect(runAttachmentBackfillBatchMock).toHaveBeenCalledWith(
      {
        orgId: 'org-1',
        userId: 'preferred-user',
        conversationIds: ['conv-1'],
        concurrency: 1,
      },
      expect.anything()
    );
    expect(deadLetterWorkMock).not.toHaveBeenCalled();
  });

  it('records Graph 429s and throws for retry/backoff', async () => {
    runAttachmentBackfillBatchMock.mockResolvedValue({
      jobId: 'job-1',
      conversations_processed: 1,
      attachments_attempted: 1,
      attachments_persisted: 0,
      attachments_failed: 1,
      attachments_skipped_unrecoverable: 0,
      embeddings_queued: 0,
      errors: [{ conversation_id: 'conv-1', phase: 'list', error: 'graph 429: throttled' }],
    });

    await expect(attachmentBackfillHandler.process(makeItem({
      conversation_id: 'conv-1',
      origin: 'divergence_scan',
      detected_at: '2026-05-31T00:00:00.000Z',
    }), makeEnv())).rejects.toThrow(/attachment_backfill_graph_429/);

    expect(recordRateLimitMock).toHaveBeenCalledWith(expect.anything(), 'org-1', null, 'graph', 'ten_minute');
    expect(deadLetterWorkMock).not.toHaveBeenCalled();
  });

  it('dead-letters auth-blocked user failures', async () => {
    runAttachmentBackfillBatchMock.mockResolvedValue({
      jobId: 'job-1',
      conversations_processed: 1,
      attachments_attempted: 1,
      attachments_persisted: 0,
      attachments_failed: 1,
      attachments_skipped_unrecoverable: 0,
      embeddings_queued: 0,
      errors: [{ conversation_id: 'conv-1', phase: 'list', error: 'no valid token for originating user user-1' }],
    });

    await attachmentBackfillHandler.process(makeItem({
      conversation_id: 'conv-1',
      origin: 'divergence_scan',
      detected_at: '2026-05-31T00:00:00.000Z',
    }), makeEnv());

    expect(deadLetterWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      expect.stringContaining('missing_token')
    );
  });
});

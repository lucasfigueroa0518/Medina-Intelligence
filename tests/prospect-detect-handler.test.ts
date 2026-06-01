import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectAndRecordProspectSignalsMock = vi.hoisted(() => vi.fn());
const deadLetterWorkMock = vi.hoisted(() => vi.fn());
const deferWorkMock = vi.hoisted(() => vi.fn());
const enqueueWorkMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/prospect-intelligence', () => ({
  detectAndRecordProspectSignals: detectAndRecordProspectSignalsMock,
}));

vi.mock('../src/lib/work-queue', () => ({
  deadLetterWork: deadLetterWorkMock,
  deferWork: deferWorkMock,
  enqueueWork: enqueueWorkMock,
}));

import {
  enqueueProspectDetectSource,
  prospectDetectHandler,
  type ProspectDetectSourceType,
} from '../src/lib/work-queue-handlers/prospect-detect';

function makeItem(sourceType: ProspectDetectSourceType, sourceId = `${sourceType}-1`): any {
  return {
    id: 'work-1',
    org_id: 'org-1',
    domain: 'prospect_detect',
    payload: JSON.stringify({
      source_type: sourceType,
      source_id: sourceId,
      origin: 'test',
      detected_at: '2026-06-01T00:00:00.000Z',
      ingestion_mode: 'live',
    }),
    status: 'in_progress',
    attempt: 0,
    max_attempts: 5,
    next_attempt_at: null,
    last_error: null,
    locked_until: null,
    heartbeat_at: null,
    upstream: 'claude',
    idempotency_key: null,
    priority: 10,
    created_at: '2026-06-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
  };
}

function makeEnv(options: { missing?: boolean } = {}) {
  const firstCalls: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    D1: {
      firstCalls,
      prepare(sql: string) {
        let binds: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            binds = args;
            return this;
          },
          async first() {
            firstCalls.push({ sql, binds });
            if (options.missing) return null;
            if (sql.includes('FROM conversations')) {
              return {
                id: 'conversation-1',
                subject: 'Intro to Auguria',
                body_preview: 'Auguria seed round with deck attached.',
                body_r2_key: null,
                source: 'outlook',
                sent_at: '2026-05-30T00:00:00.000Z',
                from_email: 'founder@auguria.ai',
                from_name: 'Founder',
                to_emails: '["lucas@medinavc.com"]',
                cc_emails: '[]',
                direction: 'inbound',
                participant_user_ids: '["user-1"]',
                visibility: 'private',
              };
            }
            if (sql.includes('FROM events')) {
              return {
                id: 'event-1',
                title: 'Auguria diligence',
                description: 'Founder meeting and seed round diligence.',
                summary: 'Auguria deck and diligence discussion.',
                transcript_r2_key: null,
                source: 'firefly',
                start_time: '2026-05-30T00:00:00.000Z',
                participant_user_ids: '["user-1"]',
              };
            }
            if (sql.includes('FROM documents')) {
              return {
                id: 'document-1',
                title: 'Auguria pitch deck',
                file_name: 'auguria-deck.pdf',
                mime_type: 'application/pdf',
                document_type: 'deal_pitch',
                r2_key: null,
                extracted_text_preview: 'Auguria is raising a seed round and shared a pitch deck.',
                created_at: '2026-05-30T00:00:00.000Z',
                visibility: 'org_wide',
                participant_user_ids: '[]',
              };
            }
            return null;
          },
        };
      },
    },
    R2: {
      async get() {
        return null;
      },
    },
  };
}

describe('prospect_detect work-queue handler', () => {
  beforeEach(() => {
    detectAndRecordProspectSignalsMock.mockReset().mockResolvedValue({
      items_scanned: 1,
      mentions_seen: 1,
      signals_recorded: 1,
      prospects_upserted: 1,
      classifications_pending: 0,
      prefilter_dropped: 0,
      production_samples_recorded: 0,
      skipped_known_deal: 0,
      skipped_intro_source: 0,
      skipped_news: 0,
      skipped_noise: 0,
      skipped_web_analytics: 0,
      errors: [],
    });
    deadLetterWorkMock.mockReset();
    deferWorkMock.mockReset();
    enqueueWorkMock.mockReset().mockResolvedValue({ inserted: true, id: 'work-new' });
  });

  it('loads conversation, event, and document rows into prospect detection', async () => {
    for (const sourceType of ['conversation', 'event', 'document'] as ProspectDetectSourceType[]) {
      await prospectDetectHandler.process(makeItem(sourceType), makeEnv() as any);
    }

    expect(detectAndRecordProspectSignalsMock).toHaveBeenCalledTimes(3);
    expect(detectAndRecordProspectSignalsMock).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({
        entityType: 'conversation',
        entityId: 'conversation-1',
        subject: 'Intro to Auguria',
        direction: 'inbound',
      })],
      'org-1',
      expect.anything(),
      { ingestionMode: 'live' }
    );
    expect(detectAndRecordProspectSignalsMock).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({
        entityType: 'event',
        entityId: 'event-1',
        subject: 'Auguria diligence',
      })],
      'org-1',
      expect.anything(),
      { ingestionMode: 'live' }
    );
    expect(detectAndRecordProspectSignalsMock).toHaveBeenNthCalledWith(
      3,
      [expect.objectContaining({
        entityType: 'document',
        entityId: 'document-1',
        subject: 'Auguria pitch deck',
      })],
      'org-1',
      expect.anything(),
      { ingestionMode: 'live' }
    );
  });

  it('defers Claude/rate-limit errors without consuming an attempt', async () => {
    detectAndRecordProspectSignalsMock.mockRejectedValue(new Error('CLAUDE_RATE_LIMITED: 429'));
    const item = makeItem('conversation');

    await prospectDetectHandler.process(item, makeEnv() as any);

    expect(deferWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      expect.any(String),
      item.payload
    );
    expect(deadLetterWorkMock).not.toHaveBeenCalled();
  });

  it('defers when the detector reports a retryable classifier error in stats', async () => {
    detectAndRecordProspectSignalsMock.mockResolvedValue({
      items_scanned: 1,
      mentions_seen: 1,
      signals_recorded: 1,
      prospects_upserted: 0,
      classifications_pending: 1,
      prefilter_dropped: 0,
      production_samples_recorded: 0,
      skipped_known_deal: 0,
      skipped_intro_source: 0,
      skipped_news: 0,
      skipped_noise: 0,
      skipped_web_analytics: 0,
      errors: [{ item_id: 'conversation-1', error: 'timeout calling Claude' }],
    });
    const item = makeItem('conversation');

    await prospectDetectHandler.process(item, makeEnv() as any);

    expect(deferWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      expect.any(String),
      item.payload
    );
  });

  it('dead-letters malformed payloads and missing source rows', async () => {
    await prospectDetectHandler.process(
      { ...makeItem('conversation'), payload: JSON.stringify({ source_type: 'bad' }) },
      makeEnv() as any
    );
    await prospectDetectHandler.process(makeItem('conversation'), makeEnv({ missing: true }) as any);

    expect(deadLetterWorkMock).toHaveBeenCalledTimes(2);
    expect(deadLetterWorkMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'work-1',
      expect.stringContaining('malformed prospect_detect payload')
    );
    expect(deadLetterWorkMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'work-1',
      expect.stringContaining('prospect_detect source not found')
    );
  });

  it('enqueues source rows with a stable idempotency key and Claude upstream tag', async () => {
    const result = await enqueueProspectDetectSource({} as any, {
      orgId: 'org-1',
      sourceType: 'document',
      sourceId: 'doc-1',
      origin: 'canary',
      ingestionMode: 'backfill',
      priority: 25,
    });

    expect(result).toEqual({ inserted: true, id: 'work-new' });
    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'prospect_detect',
      expect.objectContaining({
        source_type: 'document',
        source_id: 'doc-1',
        origin: 'canary',
        ingestion_mode: 'backfill',
      }),
      expect.objectContaining({
        upstream: 'claude',
        priority: 25,
        max_attempts: 5,
        idempotency_key: 'org-1:document:doc-1:prospect_detect:v1',
      })
    );
  });
});

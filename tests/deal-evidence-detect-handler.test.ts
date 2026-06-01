import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectDealSignalForSourceMock = vi.hoisted(() => vi.fn());
const isCompanyInternalMock = vi.hoisted(() => vi.fn());
const deadLetterWorkMock = vi.hoisted(() => vi.fn());
const deferWorkMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/deal-detection', () => ({
  detectDealSignalForSource: detectDealSignalForSourceMock,
}));

vi.mock('../src/lib/internal-entity', () => ({
  isCompanyInternal: isCompanyInternalMock,
}));

vi.mock('../src/lib/work-queue', () => ({
  deadLetterWork: deadLetterWorkMock,
  deferWork: deferWorkMock,
}));

import { dealEvidenceDetectHandler } from '../src/lib/work-queue-handlers/deal-evidence-detect';

type SourceType = 'conversation' | 'event' | 'document';

function makeItem(sourceType: SourceType, sourceId = `${sourceType}-1`): any {
  return {
    id: 'work-1',
    org_id: 'org-1',
    domain: 'deal_evidence_detect',
    payload: JSON.stringify({
      source_type: sourceType,
      source_id: sourceId,
      company_id: 'company-1',
      origin: 'test',
      detected_at: '2026-05-31T00:00:00.000Z',
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
    priority: 15,
    created_at: '2026-05-31T00:00:00.000Z',
    started_at: null,
    completed_at: null,
  };
}

function makeEnv() {
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
            if (sql.includes('FROM companies')) {
              return { id: 'company-1', is_internal_entity: 0 };
            }
            if (sql.includes('FROM conversations')) {
              return {
                id: 'conversation-1',
                subject: 'Acme seed round',
                body_preview: 'Acme AI is raising a seed round with allocation and diligence.',
                body_r2_key: null,
                source: 'outlook',
                sent_at: '2026-05-30T00:00:00.000Z',
                from_email: 'founder@acme.ai',
                direction: 'inbound',
              };
            }
            if (sql.includes('FROM events')) {
              return {
                id: 'event-1',
                title: 'Acme diligence meeting',
                description: 'Discussing seed round data room and lead investor.',
                summary: 'Acme seed round diligence',
                transcript_r2_key: null,
                source: 'outlook',
                start_time: '2026-05-30T00:00:00.000Z',
              };
            }
            if (sql.includes('FROM documents')) {
              return {
                id: 'document-1',
                title: 'Acme pitch deck',
                file_name: 'acme-pitch.pdf',
                mime_type: 'application/pdf',
                document_type: 'deal_pitch',
                r2_key: null,
                extracted_text_preview: 'Acme AI is raising a seed round with allocation and term sheet details.',
                created_at: '2026-05-30T00:00:00.000Z',
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

describe('deal_evidence_detect work-queue handler', () => {
  beforeEach(() => {
    detectDealSignalForSourceMock.mockReset().mockResolvedValue({
      recorded: false,
      promoted: false,
      dealId: null,
      reason: 'llm_not_deal',
    });
    isCompanyInternalMock.mockReset().mockResolvedValue(false);
    deadLetterWorkMock.mockReset();
    deferWorkMock.mockReset();
  });

  it('loads conversation, event, and document sources into the conservative detector', async () => {
    for (const sourceType of ['conversation', 'event', 'document'] as SourceType[]) {
      await dealEvidenceDetectHandler.process(makeItem(sourceType), makeEnv() as any);
    }

    expect(detectDealSignalForSourceMock).toHaveBeenCalledTimes(3);
    expect(detectDealSignalForSourceMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceType: 'conversation',
        sourceId: 'conversation-1',
        companyId: 'company-1',
      }),
      expect.anything()
    );
    expect(detectDealSignalForSourceMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceType: 'event',
        sourceId: 'event-1',
        companyId: 'company-1',
      }),
      expect.anything()
    );
    expect(detectDealSignalForSourceMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        sourceType: 'document',
        sourceId: 'document-1',
        sourceLabel: 'deal_pitch',
      }),
      expect.anything()
    );
  });

  it('defers Claude rate-limit failures without burning the work item attempt', async () => {
    detectDealSignalForSourceMock.mockRejectedValue(new Error('CLAUDE_RATE_LIMITED: low tier'));
    const item = makeItem('conversation');

    await dealEvidenceDetectHandler.process(item, makeEnv() as any);

    expect(deferWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      expect.any(String),
      item.payload
    );
    expect(deadLetterWorkMock).not.toHaveBeenCalled();
  });

  it('dead-letters malformed payloads', async () => {
    const item = { ...makeItem('conversation'), payload: JSON.stringify({ source_type: 'bad' }) };

    await dealEvidenceDetectHandler.process(item, makeEnv() as any);

    expect(deadLetterWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'work-1',
      expect.stringContaining('malformed deal_evidence_detect payload')
    );
    expect(detectDealSignalForSourceMock).not.toHaveBeenCalled();
  });
});

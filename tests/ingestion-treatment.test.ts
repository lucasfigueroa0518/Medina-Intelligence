import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueWorkMock = vi.hoisted(() => vi.fn());
const autoCreateContactFromAttendeeMock = vi.hoisted(() => vi.fn());
const enqueueRagV2SourceReindexMock = vi.hoisted(() => vi.fn());
const enqueueProspectDetectSourceMock = vi.hoisted(() => vi.fn());
const enqueueDueContactEnrichmentMock = vi.hoisted(() => vi.fn());
const enqueueCompanyEnrichmentMock = vi.hoisted(() => vi.fn());
const enqueueDocumentEmbeddingRepairMock = vi.hoisted(() => vi.fn());
const timelineMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/work-queue', () => ({
  enqueueWork: enqueueWorkMock,
}));

vi.mock('../src/lib/firefly-intelligence', () => ({
  autoCreateContactFromAttendee: autoCreateContactFromAttendeeMock,
}));

vi.mock('../src/lib/rag-v2', () => ({
  enqueueRagV2SourceReindex: enqueueRagV2SourceReindexMock,
}));

vi.mock('../src/lib/work-queue-handlers/prospect-detect', () => ({
  enqueueProspectDetectSource: enqueueProspectDetectSourceMock,
}));

vi.mock('../src/lib/contact-enrichment-queue', () => ({
  enqueueDueContactEnrichment: enqueueDueContactEnrichmentMock,
}));

vi.mock('../src/lib/work-queue-handlers/company-enrichment', () => ({
  enqueueCompanyEnrichment: enqueueCompanyEnrichmentMock,
}));

vi.mock('../src/lib/document-embedding', () => ({
  enqueueDocumentEmbeddingRepair: enqueueDocumentEmbeddingRepairMock,
}));

vi.mock('../src/lib/contact-detail-read-model', () => ({
  safelyUpsertEventTimelineItemsForContacts: timelineMock,
}));

import {
  enqueueIngestionTreatment,
  processIngestionTreatment,
} from '../src/lib/ingestion-treatment';

function makeEnv() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const firsts: Array<{ sql: string; binds: unknown[] }> = [];
  const alls: Array<{ sql: string; binds: unknown[] }> = [];

  return {
    D1: {
      runs,
      firsts,
      alls,
      prepare(sql: string) {
        let binds: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            binds = args;
            return this;
          },
          async run() {
            runs.push({ sql, binds });
            return { meta: { changes: 1 } };
          },
          async first() {
            firsts.push({ sql, binds });
            if (sql.includes('FROM events')) {
              return {
                id: 'event-1',
                source: 'outlook',
                title: 'Acme intro',
                description: 'Seed round intro call',
                summary: 'Acme is raising a seed round.',
                transcript_r2_key: 'org/transcript.txt',
                start_time: '2026-06-01T12:00:00.000Z',
              };
            }
            if (sql.includes('FROM vector_entity_index')) return null;
            return null;
          },
          async all() {
            alls.push({ sql, binds });
            if (sql.includes('FROM event_attendees')) {
              return {
                results: [
                  {
                    id: 'ea-1',
                    email: 'founder@acme.ai',
                    display_name: 'Acme Founder',
                    contact_id: null,
                    user_id: null,
                  },
                ],
              };
            }
            if (sql.includes('FROM contacts') && sql.includes('company_id')) {
              return { results: [{ company_id: 'company-1' }] };
            }
            return { results: [] };
          },
        };
      },
    },
  };
}

describe('ingestion treatment', () => {
  beforeEach(() => {
    enqueueWorkMock.mockReset().mockResolvedValue({ inserted: true, id: 'work-1' });
    autoCreateContactFromAttendeeMock.mockReset().mockResolvedValue({
      contactId: 'contact-1',
      created: true,
      companyId: 'company-1',
    });
    enqueueRagV2SourceReindexMock.mockReset().mockResolvedValue({ status: 'enqueued' });
    enqueueProspectDetectSourceMock.mockReset().mockResolvedValue({ inserted: true, id: 'prospect-work' });
    enqueueDueContactEnrichmentMock.mockReset().mockResolvedValue({
      selected: 1,
      inserted: 1,
      existing: 0,
      active_backlog: 1,
    });
    enqueueCompanyEnrichmentMock.mockReset().mockResolvedValue({ inserted: true, id: 'company-work' });
    enqueueDocumentEmbeddingRepairMock.mockReset().mockResolvedValue(undefined);
    timelineMock.mockReset().mockResolvedValue(undefined);
  });

  it('enqueues treatment idempotently for source rows', async () => {
    await enqueueIngestionTreatment({} as any, {
      orgId: 'org-1',
      sourceTable: 'events',
      sourceId: 'event-1',
      sourceKind: 'firefly_transcript_event',
      ingestionMode: 'backfill',
      origin: 'test',
    });

    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'ingestion_treatment',
      expect.objectContaining({
        source_table: 'events',
        source_id: 'event-1',
        ingestion_mode: 'backfill',
      }),
      expect.objectContaining({
        idempotency_key: 'org-1:events:event-1:ingestion_treatment:v1',
        max_attempts: 5,
      })
    );
  });

  it('repairs event attendee CRM and fans out enrichment, embedding, RAG, prospect, and deal lanes', async () => {
    const result = await processIngestionTreatment(makeEnv() as any, 'org-1', {
      source_table: 'events',
      source_id: 'event-1',
      source_kind: 'firefly_transcript_event',
      ingestion_mode: 'backfill',
      origin: 'test',
    });

    expect(autoCreateContactFromAttendeeMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'founder@acme.ai',
      displayName: 'Acme Founder',
      orgId: 'org-1',
    }));
    expect(enqueueDueContactEnrichmentMock).toHaveBeenCalledWith(
      'org-1',
      expect.anything(),
      expect.objectContaining({ contactIds: ['contact-1'] })
    );
    expect(enqueueCompanyEnrichmentMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'company-1',
      expect.objectContaining({ origin: 'ingestion_treatment' })
    );
    expect(enqueueProspectDetectSourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceType: 'event', sourceId: 'event-1', ingestionMode: 'backfill' })
    );
    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'embed_retry',
      { entity_id: 'event-1', source_table: 'events' },
      expect.objectContaining({ idempotency_key: 'org-1:event-1:events' })
    );
    expect(enqueueWorkMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'deal_evidence_detect',
      expect.objectContaining({ source_type: 'event', source_id: 'event-1', company_id: 'company-1' }),
      expect.objectContaining({ idempotency_key: 'org-1:event:event-1:company-1:deal_evidence_detect:v1' })
    );
    expect(enqueueRagV2SourceReindexMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'events',
      'event-1',
      expect.any(Object)
    );
    expect(result.crm_status).toBe('completed');
    expect(result.prospect_status).toBe('queued');
    expect(result.deal_status).toBe('queued');
  });

  it('records explicit skipped reasons when a source is missing', async () => {
    const env = {
      D1: {
        prepare() {
          return {
            bind() { return this; },
            async first() { return null; },
          };
        },
      },
    };

    const result = await processIngestionTreatment(env as any, 'org-1', {
      source_table: 'events',
      source_id: 'missing-event',
      source_kind: 'event',
      ingestion_mode: 'repair',
      origin: 'test',
    });

    expect(result.skipped_reasons).toContain('source_missing');
    expect(result.prospect_status).toBe('skipped');
    expect(result.deal_status).toBe('skipped');
  });
});

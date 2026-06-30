import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueWorkMock = vi.hoisted(() => vi.fn());
const enqueueProspectDetectSourceMock = vi.hoisted(() => vi.fn());
const autoCreateContactFromAttendeeMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/work-queue', () => ({
  enqueueWork: enqueueWorkMock,
}));

vi.mock('../src/lib/work-queue-handlers/prospect-detect', () => ({
  enqueueProspectDetectSource: enqueueProspectDetectSourceMock,
}));

vi.mock('../src/lib/firefly-intelligence', () => ({
  autoCreateContactFromAttendee: autoCreateContactFromAttendeeMock,
}));

import { ingestSingleFireflyTranscript } from '../src/lib/firefly-ingest';
import { MAX_BACKFILL_DAYS } from '../src/lib/firefly-progressive-backfill';
import {
  __fireflyTranscriptRebuildTestHooks,
  sixCalendarMonthsRange,
  stableFireflyTranscriptR2Key,
} from '../src/lib/firefly-transcript-rebuild';

function makeEnv(options: { existingFireflyRow?: boolean } = {}) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const firsts: Array<{ sql: string; binds: unknown[] }> = [];
  const alls: Array<{ sql: string; binds: unknown[] }> = [];
  const r2Puts: Array<{ key: string; value: string }> = [];
  const attendeesByEvent: Record<string, Array<{ email: string }>> = {
    'outlook-1': [{ email: 'tony@medinavc.com' }, { email: 'founder@acme.ai' }],
    'outlook-2': [{ email: 'tony@medinavc.com' }, { email: 'founder@acme.ai' }],
    'outlook-cancelled': [{ email: 'tony@medinavc.com' }, { email: 'founder@acme.ai' }],
  };
  const outlookCandidates = [
    {
      id: 'outlook-1',
      title: 'Acme diligence call',
      start_time: '2026-05-20T16:00:00.000Z',
      end_time: '2026-05-20T16:30:00.000Z',
      location: 'Zoom',
      description: 'Join meeting',
      outlook_event_id: 'graph-1',
    },
    {
      id: 'outlook-2',
      title: 'Acme diligence call',
      start_time: '2026-05-20T16:00:00.000Z',
      end_time: '2026-05-20T16:30:00.000Z',
      location: 'Zoom',
      description: 'Join meeting',
      outlook_event_id: 'graph-2',
    },
    {
      id: 'outlook-cancelled',
      title: 'Canceled: Acme diligence call',
      start_time: '2026-05-20T16:00:00.000Z',
      end_time: '2026-05-20T16:30:00.000Z',
      location: 'Zoom',
      description: 'Canceled',
      outlook_event_id: 'graph-cancelled',
    },
  ];

  const d1 = {
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
          if (sql.includes('INSERT INTO firefly_transcript_items')) return { id: 'fti-1' };
          if (sql.includes('SELECT id FROM users')) {
            return binds[0] === 'tony@medinavc.com' ? { id: 'user-tony' } : null;
          }
          if (sql.includes('SELECT 1 FROM vector_entity_index')) return null;
          if (sql.includes('SELECT id, source, transcript_r2_key')) {
            return options.existingFireflyRow
              ? { id: 'firefly-existing', source: 'firefly', transcript_r2_key: 'old-key' }
              : null;
          }
          if (sql.includes("source = 'firefly'")) {
            return options.existingFireflyRow ? { id: 'firefly-existing' } : null;
          }
          return null;
        },
        async all() {
          alls.push({ sql, binds });
          if (sql.includes('FROM events') && sql.includes("source = 'outlook'")) {
            return { results: outlookCandidates };
          }
          if (sql.includes('FROM event_attendees')) {
            return { results: attendeesByEvent[String(binds[0])] || [] };
          }
          if (sql.includes('SELECT vector_id FROM vector_entity_index')) {
            return { results: [] };
          }
          return { results: [] };
        },
      };
    },
  };

  return {
    D1: d1,
    R2: {
      async put(key: string, value: string) {
        r2Puts.push({ key, value });
      },
    },
    VECTORIZE: {
      async deleteByIds() {},
    },
    __runs: runs,
    __firsts: firsts,
    __alls: alls,
    __r2Puts: r2Puts,
  };
}

describe('Fireflies transcript rebuild', () => {
  beforeEach(() => {
    enqueueWorkMock.mockReset().mockResolvedValue({ inserted: true, id: 'embed-work' });
    enqueueProspectDetectSourceMock.mockReset().mockResolvedValue({ inserted: true, id: 'prospect-work' });
    autoCreateContactFromAttendeeMock.mockReset().mockResolvedValue({ contactId: 'contact-1' });
  });

  it('uses a six-month-safe 190-day cap', () => {
    expect(MAX_BACKFILL_DAYS).toBe(190);
  });

  it('computes six calendar months back from run time', () => {
    const range = sixCalendarMonthsRange(new Date('2026-06-07T12:34:56.000Z'));
    expect(range).toEqual({
      startDate: '2025-12-07T12:34:56.000Z',
      endDate: '2026-06-07T12:34:56.000Z',
    });
  });

  it('builds deterministic stable R2 keys from Fireflies IDs', () => {
    expect(stableFireflyTranscriptR2Key('org-1', '2026-05-20T16:00:00.000Z', 'ff/123 abc')).toBe(
      'org-1/transcripts/fireflies/2026/05/ff_123_abc.txt'
    );
  });

  it('penalizes canceled Outlook rows during matching', () => {
    const candidate = {
      id: 'cancelled',
      title: 'Canceled: Acme diligence call',
      start_time: '2026-05-20T16:00:00.000Z',
      end_time: '2026-05-20T16:30:00.000Z',
      location: 'Zoom',
      description: 'Canceled by organizer',
      outlook_event_id: 'graph-cancelled',
    };
    const score = __fireflyTranscriptRebuildTestHooks.scoreOutlookCandidate(
      {
        fireflyEventId: 'ff-1',
        title: 'Acme diligence call',
        startTime: '2026-05-20T16:00:00.000Z',
        endTime: '2026-05-20T16:30:00.000Z',
        transcriptText: 'Tony: hello',
        participants: [{ displayName: 'Tony', email: 'tony@medinavc.com' }],
        summaryOverview: null,
        actionItems: [],
        topics: [],
        speakerTurns: [],
      },
      candidate,
      new Set(['tony@medinavc.com'])
    );
    expect(score.reason.cancelled).toBe(true);
    expect(score.score).toBeLessThan(0);
  });

  it('attaches fuzzy Fireflies transcript matches to all valid Outlook rows instead of skipping as duplicate', async () => {
    const env = makeEnv();

    const result = await ingestSingleFireflyTranscript(
      {
        id: 'ff-123',
        title: 'Acme diligence call',
        date: '2026-05-20T16:00:00.000Z',
        duration: 30,
        meeting_attendees: [
          { displayName: 'Tony Medina', email: 'tony@medinavc.com' },
          { displayName: 'Founder', email: 'founder@acme.ai' },
        ],
        summary: {
          overview: 'Discussed Acme seed round.',
          action_items: 'Review data room',
          keywords: ['seed', 'diligence'],
        },
        sentences: [
          { speaker_name: 'Tony Medina', text: 'Great to meet you.', start_time: 0 },
          { speaker_name: 'Founder', text: 'We are raising a seed round.', start_time: 10 },
        ],
      },
      'org-1',
      'firefly-progressive-backfill-window',
      env as any,
      { userId: 'user-tony', runId: 'run-1' }
    );

    expect(result.canonical_status).toBe('linked');
    expect(result.linked_events).toBe(2);
    expect(result.standalone_transcripts).toBe(0);
    expect(env.__r2Puts).toHaveLength(1);
    expect(env.__r2Puts[0].key).toBe('org-1/transcripts/fireflies/2026/05/ff-123.txt');

    const eventUpdates = env.__runs.filter(r =>
      r.sql.includes('UPDATE events') &&
      r.sql.includes("transcript_source = 'firefly'")
    );
    const updatedEventIds = eventUpdates.map(r => r.binds.at(-1));
    expect(updatedEventIds).toEqual(expect.arrayContaining(['outlook-1', 'outlook-2']));
    expect(updatedEventIds).not.toContain('outlook-cancelled');

    const linkWrites = env.__runs.filter(r => r.sql.includes('INSERT INTO firefly_transcript_event_links'));
    expect(linkWrites).toHaveLength(2);
    const queueDomains = enqueueWorkMock.mock.calls.map(call => call[2]);
    expect(queueDomains.filter(domain => domain === 'embed_retry')).toHaveLength(2);
    expect(queueDomains.filter(domain => domain === 'ingestion_treatment')).toHaveLength(2);
    expect(enqueueProspectDetectSourceMock).toHaveBeenCalledTimes(2);
  });

  it('supersedes an exact existing Fireflies row after linking to Outlook', async () => {
    const env = makeEnv({ existingFireflyRow: true });

    const result = await ingestSingleFireflyTranscript(
      {
        id: 'ff-123',
        title: 'Acme diligence call',
        date: '2026-05-20T16:00:00.000Z',
        duration: 30,
        meeting_attendees: [
          { displayName: 'Tony Medina', email: 'tony@medinavc.com' },
          { displayName: 'Founder', email: 'founder@acme.ai' },
        ],
        summary: { overview: 'Discussed Acme seed round.', action_items: null, keywords: [] },
        sentences: [
          { speaker_name: 'Tony Medina', text: 'Great to meet you.', start_time: 0 },
          { speaker_name: 'Founder', text: 'We are raising a seed round.', start_time: 10 },
        ],
      },
      'org-1',
      'firefly-progressive-backfill-window',
      env as any,
      { userId: 'user-tony', runId: 'run-1' }
    );

    expect(result.canonical_status).toBe('linked');
    const supersedeUpdate = env.__runs.find(r =>
      r.sql.includes('firefly_superseded_at') &&
      r.binds.includes('firefly-existing')
    );
    expect(supersedeUpdate).toBeTruthy();

    const droppedSignalUpdate = env.__runs.find(r =>
      r.sql.includes('UPDATE prospect_signals') &&
      r.binds.includes('firefly-existing')
    );
    expect(droppedSignalUpdate).toBeTruthy();
  });
});

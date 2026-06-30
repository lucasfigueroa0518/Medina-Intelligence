import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFireflyKeyMock = vi.hoisted(() => vi.fn());
const fetchTranscriptByIdMock = vi.hoisted(() => vi.fn());
const ingestSingleFireflyTranscriptMock = vi.hoisted(() => vi.fn());
const ingestFireflyTranscriptRecordMock = vi.hoisted(() => vi.fn());
const emitAuditMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/firefly-credentials', () => ({
  getFireflyKey: getFireflyKeyMock,
}));

vi.mock('../src/lib/firefly-ingest', () => ({
  fetchTranscriptById: fetchTranscriptByIdMock,
  ingestSingleFireflyTranscript: ingestSingleFireflyTranscriptMock,
}));

vi.mock('../src/lib/firefly-transcript-rebuild', () => ({
  ingestFireflyTranscriptRecord: ingestFireflyTranscriptRecordMock,
}));

vi.mock('../src/lib/audit', () => ({
  emitAudit: emitAuditMock,
}));

import { processFireflyWebhook } from '../src/integrations/firefly';

function makeEnv(users = [{ user_id: 'user-tony', email: 'tony@medinavc.com' }]) {
  return {
    D1: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: users };
          },
        };
      },
    },
  };
}

const transcript = {
  id: 'ff-123',
  title: 'Acme diligence call',
  date: '2026-06-08T16:00:00.000Z',
  duration: 30,
  meeting_attendees: [
    { displayName: 'Tony Medina', email: 'tony@medinavc.com' },
    { displayName: 'Founder', email: 'founder@acme.ai' },
  ],
  summary: {
    overview: 'Discussed Acme.',
    action_items: 'Review deck',
    keywords: ['seed'],
  },
  sentences: [
    { speaker_name: 'Tony Medina', text: 'Great to meet you.', start_time: 0 },
    { speaker_name: 'Founder', text: 'We are raising.', start_time: 10 },
  ],
};

const ingestResult = {
  outcome: 'ingested',
  canonical_status: 'linked',
  r2_staged: 1,
  linked_events: 1,
  standalone_transcripts: 0,
  embedding_queued: 1,
  prospect_queued: 1,
  event_ids: ['event-1'],
  transcript_item_id: 'fti-1',
};

describe('Fireflies live webhook ingestion', () => {
  beforeEach(() => {
    getFireflyKeyMock.mockReset().mockResolvedValue('firefly-key');
    fetchTranscriptByIdMock.mockReset().mockResolvedValue(transcript);
    ingestSingleFireflyTranscriptMock.mockReset().mockResolvedValue(ingestResult);
    ingestFireflyTranscriptRecordMock.mockReset().mockResolvedValue(ingestResult);
    emitAuditMock.mockReset().mockResolvedValue(undefined);
  });

  it('fetches and ingests a Fireflies v1 notification-only webhook', async () => {
    await processFireflyWebhook(
      { meetingId: 'ff-123', eventType: 'Transcription completed' },
      'org-1',
      makeEnv() as any
    );

    expect(getFireflyKeyMock).toHaveBeenCalledWith('user-tony', expect.anything());
    expect(fetchTranscriptByIdMock).toHaveBeenCalledWith('firefly-key', 'ff-123');
    expect(ingestSingleFireflyTranscriptMock).toHaveBeenCalledWith(
      transcript,
      'org-1',
      'firefly-webhook',
      expect.anything(),
      expect.objectContaining({
        userId: 'user-tony',
        repairEmbeddings: true,
        repairProspectSignals: true,
      })
    );
  });

  it('tries each stored credential until the transcript is readable', async () => {
    getFireflyKeyMock
      .mockResolvedValueOnce('wrong-owner-key')
      .mockResolvedValueOnce('owner-key');
    fetchTranscriptByIdMock
      .mockRejectedValueOnce(new Error('FIREFLY_TRANSCRIPT_NOT_FOUND'))
      .mockResolvedValueOnce(transcript);

    await processFireflyWebhook(
      { meeting_id: 'ff-123', event: 'meeting.transcribed' },
      'org-1',
      makeEnv([
        { user_id: 'user-alvaro', email: 'alvaro@medinavc.com' },
        { user_id: 'user-tony', email: 'tony@medinavc.com' },
      ]) as any
    );

    expect(fetchTranscriptByIdMock).toHaveBeenCalledTimes(2);
    expect(fetchTranscriptByIdMock).toHaveBeenNthCalledWith(1, 'wrong-owner-key', 'ff-123');
    expect(fetchTranscriptByIdMock).toHaveBeenNthCalledWith(2, 'owner-key', 'ff-123');
    expect(ingestSingleFireflyTranscriptMock).toHaveBeenCalledWith(
      transcript,
      'org-1',
      'firefly-webhook',
      expect.anything(),
      expect.objectContaining({ userId: 'user-tony' })
    );
  });

  it('still supports legacy embedded transcript webhook payloads', async () => {
    await processFireflyWebhook(
      {
        event_type: 'transcript_ready',
        event_id: 'ff-embedded',
        meeting_title: 'Embedded transcript',
        start_time: '2026-06-08T16:00:00.000Z',
        end_time: '2026-06-08T16:30:00.000Z',
        participants: [{ name: 'Tony Medina', email: 'tony@medinavc.com' }],
        transcript: { format: 'text', content: 'Tony Medina: Hello' },
      },
      'org-1',
      makeEnv() as any
    );

    expect(fetchTranscriptByIdMock).not.toHaveBeenCalled();
    expect(ingestFireflyTranscriptRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fireflyEventId: 'ff-embedded',
        transcriptText: 'Tony Medina: Hello',
      }),
      expect.objectContaining({
        orgId: 'org-1',
        sourcePath: 'firefly-webhook',
      }),
      expect.anything(),
      expect.objectContaining({
        repairEmbeddings: true,
        repairProspectSignals: true,
      })
    );
  });
});

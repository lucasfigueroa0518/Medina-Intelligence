// TRD §6.3 — Firefly webhook handler
//
// Wave 4 (Phase B): processFireflyWebhook delegates to processTranscriptItems
// — the converged helper that owns Phase 1 bail, per-attendee ACL, sync_jobs
// lifecycle, and errors_sample. Pre-Wave-4 the webhook open-coded events
// INSERT, attendee linking, embed, reconcile, and audit, missing the
// race-safe canonical-id read-back that ingestTranscript already had. After
// this commit both webhook + backfill (Phase C) route through one helper.

import type { Env } from '../types/env';
import type { SpeakerTurn } from '../types/interfaces';
import { emitAudit } from '../lib/audit';
import {
  ingestFireflyTranscriptRecord,
} from '../lib/firefly-transcript-rebuild';

interface FireflyWebhookPayload {
  event_type: 'meeting_completed' | 'meeting_started' | 'transcript_ready';
  event_id?: string;
  meeting_id?: string;
  meeting_title: string;
  start_time: string;
  end_time: string;
  duration_seconds?: number;
  participants: Array<{ name: string; email?: string }>;
  transcript?: { format: 'text' | 'json'; content: string };
  summary?: string;
  action_items?: string[];
  key_topics?: string[];
}

export async function verifyFireflySignature(
  secret: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `sha256=${hex}`;
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

function parseTranscriptToTurns(
  content: string,
  participants: Array<{ name: string; email?: string }>
): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  const emailByName = new Map<string, string>();
  for (const p of participants) {
    if (p.email) emailByName.set(p.name, p.email);
  }

  const lines = content.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    turns.push({
      speaker: match[1].trim(),
      affiliation: emailByName.get(match[1].trim()) || 'External',
      text: match[2].trim(),
    });
  }
  return turns;
}

export async function processFireflyWebhook(
  payload: FireflyWebhookPayload,
  orgId: string,
  env: Env
): Promise<void> {
  if (payload.event_type !== 'transcript_ready' && payload.event_type !== 'meeting_completed') {
    return;
  }

  const fireflyEventId = payload.event_id || payload.meeting_id || '';
  if (!fireflyEventId) {
    console.warn(
      `[firefly] webhook payload missing event_id and meeting_id; skipping (title="${payload.meeting_title}")`
    );
    return;
  }

  const transcriptText = payload.transcript?.content ?? null;
  const speakerTurns = transcriptText
    ? parseTranscriptToTurns(transcriptText, payload.participants)
    : [];

  const result = await ingestFireflyTranscriptRecord({
    fireflyEventId,
    title: payload.meeting_title,
    startTime: payload.start_time,
    endTime: payload.end_time,
    transcriptText,
    participants: payload.participants.map(p => ({
      displayName: p.name,
      email: p.email ?? null,
    })),
    summaryOverview: payload.summary ?? null,
    actionItems: payload.action_items ?? [],
    topics: payload.key_topics ?? [],
    speakerTurns,
  }, {
    orgId,
    sourcePath: 'firefly-webhook',
  }, env, {
    repairEmbeddings: true,
    repairProspectSignals: true,
  });

  const eventId = result.event_ids[0];
  if (eventId) {
    await emitAudit(env, {
      org_id: orgId,
      action: 'create',
      entity_type: 'event',
      entity_id: eventId,
      metadata: {
        source: 'firefly',
        title: payload.meeting_title,
        transcript_item_id: result.transcript_item_id,
        linked_events: result.linked_events,
        embedding_queued: result.embedding_queued,
        prospect_queued: result.prospect_queued,
      },
      created_at: new Date().toISOString(),
    });
  }

  console.log(
    `[firefly] webhook processed: firefly_event_id=${fireflyEventId} ` +
    `status=${result.canonical_status} linked_events=${result.linked_events} ` +
    `embedding_queued=${result.embedding_queued} prospect_queued=${result.prospect_queued}`
  );
}

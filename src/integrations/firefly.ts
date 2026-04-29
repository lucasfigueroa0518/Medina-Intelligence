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
  processTranscriptItems,
  type TranscriptItem,
} from '../lib/process-transcript-items';

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

  // Caller-side R2 PUT. The helper accepts an already-staged key — keeping
  // the upload here lets the webhook own its own R2 path scheme. We name the
  // object by a transient UUID; the canonical event id from Phase 1's
  // read-back may differ when a duplicate firefly_event_id wins the race
  // (in that case our R2 object becomes orphaned but the existing winner's
  // transcript_r2_key is preserved on its row).
  const transientId = crypto.randomUUID();
  const r2Stamp = new Date().toISOString().slice(0, 7);
  const r2Key = `${orgId}/transcript/${r2Stamp}/${transientId}.txt`;

  const transcriptText = payload.transcript?.content ?? null;
  if (transcriptText) {
    await env.R2.put(r2Key, transcriptText);
  }

  const speakerTurns = transcriptText
    ? parseTranscriptToTurns(transcriptText, payload.participants)
    : [];

  const item: TranscriptItem = {
    fireflyEventId,
    title: payload.meeting_title,
    startTime: payload.start_time,
    endTime: payload.end_time,
    transcriptR2Key: transcriptText ? r2Key : null,
    transcriptText,
    participants: payload.participants.map(p => ({
      displayName: p.name,
      email: p.email ?? null,
    })),
    summaryOverview: payload.summary ?? null,
    actionItems: payload.action_items ?? [],
    topics: payload.key_topics ?? [],
    speakerTurns,
  };

  const stats = await processTranscriptItems(
    [item],
    { orgId, sourcePath: 'firefly-webhook' },
    env
  );

  const eventId = stats.staged_event_ids[0];
  if (eventId) {
    await emitAudit(env, {
      org_id: orgId,
      action: 'create',
      entity_type: 'event',
      entity_id: eventId,
      metadata: {
        source: 'firefly',
        title: payload.meeting_title,
        sync_job_id: stats.sync_job_id,
        chunks_embedded: stats.chunks_embedded,
        signals_extracted: stats.signals_extracted,
        errors: stats.errors.length,
      },
      created_at: new Date().toISOString(),
    });
  }

  console.log(
    `[firefly] webhook processed: firefly_event_id=${fireflyEventId} ` +
    `staged=${stats.items_staged}/${stats.items_total} ` +
    `chunks=${stats.chunks_embedded} attendees=${stats.attendees_linked} ` +
    `signals=${stats.signals_extracted} errors=${stats.errors.length} ` +
    `sync_job=${stats.sync_job_id}`
  );
}

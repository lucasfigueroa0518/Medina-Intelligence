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
import { getFireflyKey } from '../lib/firefly-credentials';
import { fetchTranscriptById, ingestSingleFireflyTranscript } from '../lib/firefly-ingest';
import {
  ingestFireflyTranscriptRecord,
  type FireflyTranscriptIngestResult,
} from '../lib/firefly-transcript-rebuild';

interface FireflyWebhookPayload {
  event_type?: 'meeting_completed' | 'meeting_started' | 'transcript_ready' | string;
  eventType?: string;
  event?: string;
  event_id?: string;
  meeting_id?: string;
  meetingId?: string;
  transcript_id?: string;
  transcriptId?: string;
  meeting_title?: string;
  start_time?: string;
  end_time?: string;
  duration_seconds?: number;
  participants?: Array<{ name: string; email?: string }>;
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

function eventName(payload: FireflyWebhookPayload): string {
  return String(payload.event_type || payload.eventType || payload.event || '').trim();
}

function transcriptId(payload: FireflyWebhookPayload): string {
  return String(
    payload.event_id ||
    payload.meeting_id ||
    payload.meetingId ||
    payload.transcript_id ||
    payload.transcriptId ||
    ''
  ).trim();
}

function isTranscriptReadyEvent(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'transcript_ready' ||
    normalized === 'meeting_completed' ||
    normalized === 'transcription completed' ||
    normalized === 'meeting.transcribed' ||
    normalized === 'meeting.summarized' ||
    normalized.includes('transcription completed') ||
    normalized.includes('transcript')
  );
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

async function credentialedUsersForOrg(
  orgId: string,
  env: Env
): Promise<Array<{ user_id: string; email: string | null }>> {
  const rows = await env.D1.prepare(
    `SELECT u.id AS user_id, u.email
       FROM user_firefly_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE u.org_id = ?
        AND u.deleted_at IS NULL
        AND COALESCE(u.is_active, 1) = 1
      ORDER BY COALESCE(c.last_used_at, c.updated_at, c.created_at) DESC`
  ).bind(orgId).all<{ user_id: string; email: string | null }>();
  return rows.results;
}

async function fetchAndIngestWebhookTranscript(
  fireflyEventId: string,
  orgId: string,
  env: Env
): Promise<FireflyTranscriptIngestResult> {
  const credentialedUsers = await credentialedUsersForOrg(orgId, env);
  if (credentialedUsers.length === 0) {
    throw new Error('FIREFLY_WEBHOOK_NO_STORED_CREDENTIALS');
  }

  const errors: string[] = [];
  for (const user of credentialedUsers) {
    const key = await getFireflyKey(user.user_id, env);
    if (!key) {
      errors.push(`${user.user_id}:missing_or_decrypt_failed`);
      continue;
    }

    try {
      const transcript = await fetchTranscriptById(key, fireflyEventId);
      return ingestSingleFireflyTranscript(transcript, orgId, 'firefly-webhook', env, {
        userId: user.user_id,
        repairEmbeddings: true,
        repairProspectSignals: true,
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      errors.push(`${user.user_id}:${msg.slice(0, 120)}`);
      if (msg.includes('FIREFLY_RATE_LIMITED')) throw e;
      if (msg.includes('FIREFLY_AUTH_FAILED') || msg.includes('FIREFLY_TRANSCRIPT_NOT_FOUND')) continue;
      throw e;
    }
  }

  throw new Error(`FIREFLY_WEBHOOK_FETCH_FAILED:${errors.join('|').slice(0, 500)}`);
}

export async function processFireflyWebhook(
  payload: FireflyWebhookPayload,
  orgId: string,
  env: Env
): Promise<void> {
  const event = eventName(payload);
  if (!isTranscriptReadyEvent(event)) {
    return;
  }

  const fireflyEventId = transcriptId(payload);
  if (!fireflyEventId) {
    console.warn(
      `[firefly] webhook payload missing meeting/transcript id; skipping event="${event}"`
    );
    return;
  }

  const transcriptText = payload.transcript?.content ?? null;
  if (!transcriptText) {
    const result = await fetchAndIngestWebhookTranscript(fireflyEventId, orgId, env);
    console.log(
      `[firefly] webhook fetched+processed: firefly_event_id=${fireflyEventId} ` +
      `status=${result.canonical_status} linked_events=${result.linked_events} ` +
      `embedding_queued=${result.embedding_queued} prospect_queued=${result.prospect_queued}`
    );
    return;
  }

  const participants = payload.participants || [];
  const speakerTurns = transcriptText
    ? parseTranscriptToTurns(transcriptText, participants)
    : [];

  const result = await ingestFireflyTranscriptRecord({
    fireflyEventId,
    title: payload.meeting_title || '(untitled meeting)',
    startTime: payload.start_time || new Date().toISOString(),
    endTime: payload.end_time || null,
    transcriptText,
    participants: participants.map(p => ({
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

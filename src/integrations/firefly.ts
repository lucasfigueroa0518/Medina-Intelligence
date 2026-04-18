// TRD §6.3 — Firefly webhook handler
import type { Env } from '../types/env';
import { chunkTranscriptBySpeakerTurns, determineOverlapTurns } from '../lib/chunking';
import type { ChunkMetadata, SpeakerTurn } from '../types/interfaces';
import { chunkEmbedAndPersist } from '../lib/embedding';
import { reconcileFireflyWithoutId } from '../lib/reconciliation';
import { emitAudit } from '../lib/audit';

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

  // Store transcript in R2
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const r2Key = `${orgId}/transcript/${now.slice(0, 7)}/${eventId}.txt`;

  if (payload.transcript?.content) {
    await env.R2.put(r2Key, payload.transcript.content);
  }

  // Upsert event record
  await env.D1.prepare(
    `INSERT OR IGNORE INTO events
       (id, org_id, title, event_type, start_time, end_time, source, firefly_event_id,
        reconciliation_status, transcript_r2_key, transcript_source, summary, action_items, topics_discussed,
        created_at, updated_at)
     VALUES (?, ?, ?, 'meeting', ?, ?, 'firefly', ?, 'pending_reconciliation', ?, 'firefly', ?, ?, ?, ?, ?)`
  )
    .bind(
      eventId,
      orgId,
      payload.meeting_title,
      payload.start_time,
      payload.end_time,
      payload.event_id || payload.meeting_id || null,
      payload.transcript?.content ? r2Key : null,
      payload.summary || null,
      JSON.stringify(payload.action_items || []),
      JSON.stringify(payload.key_topics || []),
      now,
      now
    )
    .run();

  // Attempt Outlook reconciliation
  try {
    await reconcileFireflyWithoutId(
      {
        id: eventId,
        firefly_event_id: payload.event_id || payload.meeting_id || null,
        start_time: payload.start_time,
        transcript_r2_key: payload.transcript?.content ? r2Key : null,
      },
      orgId,
      env
    );
  } catch (e) {
    console.error('Firefly reconciliation failed:', e);
  }

  // Add attendees
  for (const p of payload.participants) {
    const email = p.email || '';
    if (!email) continue;

    const contact = await env.D1.prepare(
      'SELECT id FROM contacts WHERE email = ? AND org_id = ? AND deleted_at IS NULL'
    ).bind(email, orgId).first<{ id: string }>();

    const user = await env.D1.prepare(
      'SELECT id FROM users WHERE email = ? AND org_id = ?'
    ).bind(email, orgId).first<{ id: string }>();

    await env.D1.prepare(
      `INSERT OR IGNORE INTO event_attendees (event_id, contact_id, user_id, email, display_name, role, is_internal)
       VALUES (?, ?, ?, ?, ?, 'attendee', ?)`
    )
      .bind(
        eventId,
        contact?.id || null,
        user?.id || null,
        email,
        p.name,
        user ? 1 : 0
      )
      .run();
  }

  // Embed transcript chunks with speaker-turn-aware chunking
  if (payload.transcript?.content) {
    const turns = parseTranscriptToTurns(
      payload.transcript.content,
      payload.participants
    );
    if (turns.length > 0) {
      const overlapTurns = determineOverlapTurns(turns);
      const chunks = chunkTranscriptBySpeakerTurns(turns, 1024, overlapTurns);

      for (let i = 0; i < chunks.length; i++) {
        const meta: ChunkMetadata = {
          org_id: orgId,
          document_type: 'transcript',
          source_table: 'events',
          source_id: eventId,
          r2_key: r2Key,
          visibility: 'org_wide',
          primary_entity_id: eventId,
          created_at: now,
          entity_name: payload.meeting_title,
          date: payload.start_time,
          speakers: chunks[i].speakers.join(','),
          primary_speaker: chunks[i].primary_speaker,
        };

        const entry = await chunkEmbedAndPersist(
          chunks[i].text,
          meta,
          i,
          chunks.length,
          env
        );

        await env.D1.prepare(
          'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
        ).bind(entry.vectorId, entry.entityId, entry.sourceTable, entry.orgId).run();
      }
    }
  }

  await emitAudit(env, {
    org_id: orgId,
    action: 'create',
    entity_type: 'event',
    entity_id: eventId,
    metadata: { source: 'firefly', title: payload.meeting_title },
    created_at: now,
  });
}

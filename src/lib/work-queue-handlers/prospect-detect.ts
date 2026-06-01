import type { Env } from '../../types/env';
import type { ChunkMetadata, ClassifiedItem } from '../../types/interfaces';
import { detectAndRecordProspectSignals } from '../prospect-intelligence';
import { deadLetterWork, deferWork, enqueueWork } from '../work-queue';
import type { WorkQueueHandler } from '../work-queue-driver';

export type ProspectDetectSourceType = 'conversation' | 'event' | 'document';

export interface ProspectDetectPayload {
  source_type: ProspectDetectSourceType;
  source_id: string;
  origin: string;
  detected_at?: string;
  ingestion_mode?: 'live' | 'backfill';
}

export interface EnqueueProspectDetectInput {
  orgId: string;
  sourceType: ProspectDetectSourceType;
  sourceId: string;
  origin: string;
  ingestionMode?: 'live' | 'backfill';
  priority?: number;
}

interface ProspectSourceBundle {
  item: ClassifiedItem;
  sourceType: ProspectDetectSourceType;
  sourceId: string;
}

function parsePayload(payload: string): ProspectDetectPayload {
  const parsed = JSON.parse(payload) as ProspectDetectPayload;
  if (!['conversation', 'event', 'document'].includes(parsed.source_type)) {
    throw new Error(`invalid source_type: ${String(parsed.source_type)}`);
  }
  if (!parsed.source_id) {
    throw new Error(`payload missing source_id: ${payload}`);
  }
  if (parsed.ingestion_mode && !['live', 'backfill'].includes(parsed.ingestion_mode)) {
    throw new Error(`invalid ingestion_mode: ${String(parsed.ingestion_mode)}`);
  }
  return {
    source_type: parsed.source_type,
    source_id: parsed.source_id,
    origin: parsed.origin || 'work_queue',
    detected_at: parsed.detected_at,
    ingestion_mode: parsed.ingestion_mode || 'live',
  };
}

function normalizeDirection(value: string | null | undefined): 'inbound' | 'outbound' | 'internal' | undefined {
  if (value === 'inbound' || value === 'outbound' || value === 'internal') return value;
  return undefined;
}

function classifiedMetadata(input: {
  orgId: string;
  visibility: 'private' | 'org_wide' | 'confidential';
  participantUserIds?: string[] | null;
  documentType: string;
  sourceTable: string;
  sourceId: string;
  r2Key?: string | null;
  createdAt: string;
  primaryEntityId: string;
  textPreview?: string | null;
  entityName?: string | null;
}): ChunkMetadata {
  return {
    org_id: input.orgId,
    visibility: input.visibility,
    participant_user_ids: input.participantUserIds?.length ? input.participantUserIds.join(',') : undefined,
    document_type: input.documentType,
    source_table: input.sourceTable,
    source_id: input.sourceId,
    r2_key: input.r2Key || '',
    created_at: input.createdAt,
    primary_entity_id: input.primaryEntityId,
    text_preview: input.textPreview || undefined,
    entity_name: input.entityName || undefined,
  };
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map(entry => String(entry || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function loadConversation(env: Env, orgId: string, sourceId: string): Promise<ProspectSourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, subject, body_preview, body_r2_key, source, sent_at,
            from_email, fc.full_name AS from_name, to_emails, cc_emails,
            direction, participant_user_ids
       FROM conversations c
       LEFT JOIN contacts fc ON fc.id = c.from_contact_id AND fc.org_id = c.org_id
      WHERE c.id = ? AND c.org_id = ?`
  ).bind(sourceId, orgId).first<{
    id: string;
    subject: string | null;
    body_preview: string | null;
    body_r2_key: string | null;
    source: string | null;
    sent_at: string | null;
    from_email: string | null;
    from_name: string | null;
    to_emails: string | null;
    cc_emails: string | null;
    direction: string | null;
    participant_user_ids: string | null;
  }>();
  if (!row) return null;

  let bodyText = row.body_preview || '';
  if (row.body_r2_key) {
    const obj = await env.R2.get(row.body_r2_key);
    if (obj) bodyText = await obj.text();
  }

  const sentAt = row.sent_at || new Date().toISOString();
  const visibility: 'private' | 'org_wide' | 'confidential' = 'private';
  const participantUserIds = parseJsonStringArray(row.participant_user_ids);
  const metadata = classifiedMetadata({
    orgId,
    visibility,
    participantUserIds,
    documentType: 'email',
    sourceTable: 'conversations',
    sourceId: row.id,
    r2Key: row.body_r2_key,
    createdAt: sentAt,
    primaryEntityId: row.id,
    textPreview: row.body_preview,
    entityName: row.subject,
  });

  return {
    sourceType: 'conversation',
    sourceId: row.id,
    item: {
      type: 'email',
      source: row.source === 'slack' ? 'slack' : 'outlook',
      externalId: row.id,
      threadId: row.id,
      subject: row.subject || undefined,
      bodyText,
      bodyPreview: row.body_preview || bodyText.slice(0, 300),
      fromEmail: row.from_email || undefined,
      fromName: row.from_name || undefined,
      toEmails: parseJsonStringArray(row.to_emails),
      ccEmails: parseJsonStringArray(row.cc_emails),
      sentAt,
      direction: normalizeDirection(row.direction),
      orgId,
      visibility,
      entityType: 'conversation',
      entityId: row.id,
      contactIds: [],
      participantUserIds,
      metadata,
      text: bodyText,
    },
  };
}

async function loadEvent(env: Env, orgId: string, sourceId: string): Promise<ProspectSourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, title, description, summary, transcript_r2_key, source,
            start_time
       FROM events
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    title: string | null;
    description: string | null;
    summary: string | null;
    transcript_r2_key: string | null;
    source: string | null;
    start_time: string | null;
  }>();
  if (!row) return null;

  let bodyText = [row.title, row.summary, row.description].filter(Boolean).join('\n\n');
  if (row.transcript_r2_key) {
    const obj = await env.R2.get(row.transcript_r2_key);
    if (obj) bodyText = await obj.text();
  }

  const sentAt = row.start_time || new Date().toISOString();
  const participantUserIds: string[] = [];
  const metadata = classifiedMetadata({
    orgId,
    visibility: 'private',
    participantUserIds,
    documentType: 'meeting_transcript',
    sourceTable: 'events',
    sourceId: row.id,
    r2Key: row.transcript_r2_key,
    createdAt: sentAt,
    primaryEntityId: row.id,
    textPreview: row.summary || row.description,
    entityName: row.title,
  });

  return {
    sourceType: 'event',
    sourceId: row.id,
    item: {
      type: 'calendar_event',
      source: row.source === 'firefly' ? 'outlook' : 'outlook',
      externalId: row.id,
      subject: row.title || undefined,
      bodyText,
      bodyPreview: row.summary || bodyText.slice(0, 300),
      sentAt,
      direction: 'internal',
      orgId,
      visibility: 'private',
      entityType: 'event',
      entityId: row.id,
      contactIds: [],
      participantUserIds,
      metadata,
      text: bodyText,
    },
  };
}

async function loadDocument(env: Env, orgId: string, sourceId: string): Promise<ProspectSourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, title, file_name, mime_type, document_type, r2_key,
            extracted_text_preview, created_at, visibility, participant_user_ids
       FROM documents
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    title: string | null;
    file_name: string | null;
    mime_type: string | null;
    document_type: string | null;
    r2_key: string | null;
    extracted_text_preview: string | null;
    created_at: string | null;
    visibility: 'private' | 'org_wide' | 'public' | 'confidential' | null;
    participant_user_ids: string | null;
  }>();
  if (!row) return null;

  let bodyText = row.extracted_text_preview || '';
  if ((!bodyText || bodyText.length < 1200) && row.r2_key) {
    try {
      const obj = await env.R2.get(row.r2_key);
      if (obj) {
        const { extractTextFromFile } = await import('../file-extraction');
        const buffer = await obj.arrayBuffer();
        bodyText = await extractTextFromFile(new File([buffer], row.file_name || row.title || row.id, { type: row.mime_type || '' }));
      }
    } catch (e) {
      console.warn(`[prospect-detect] document extraction failed for ${sourceId}:`, e instanceof Error ? e.message : e);
    }
  }

  const createdAt = row.created_at || new Date().toISOString();
  const visibility: 'private' | 'org_wide' | 'confidential' =
    row.visibility === 'public' ? 'org_wide' : (row.visibility || 'private');
  const participantUserIds = parseJsonStringArray(row.participant_user_ids);
  const metadata = classifiedMetadata({
    orgId,
    visibility,
    participantUserIds,
    documentType: row.document_type || 'document',
    sourceTable: 'documents',
    sourceId: row.id,
    r2Key: row.r2_key,
    createdAt,
    primaryEntityId: row.id,
    textPreview: row.extracted_text_preview,
    entityName: row.title || row.file_name,
  });

  return {
    sourceType: 'document',
    sourceId: row.id,
    item: {
      type: 'document',
      source: 'outlook',
      externalId: row.id,
      subject: row.title || row.file_name || undefined,
      bodyText,
      bodyPreview: row.extracted_text_preview || undefined,
      sentAt: createdAt,
      orgId,
      visibility,
      entityType: 'document',
      entityId: row.id,
      contactIds: [],
      participantUserIds,
      metadata,
      text: bodyText,
    } as unknown as ClassifiedItem,
  };
}

async function loadSource(env: Env, orgId: string, payload: ProspectDetectPayload): Promise<ProspectSourceBundle | null> {
  if (payload.source_type === 'conversation') return loadConversation(env, orgId, payload.source_id);
  if (payload.source_type === 'event') return loadEvent(env, orgId, payload.source_id);
  return loadDocument(env, orgId, payload.source_id);
}

function isDeferrableClassifierError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /CLAUDE_RATE_LIMITED|429|rate.?limit|timeout|overloaded|529/i.test(message);
}

export async function enqueueProspectDetectSource(
  env: Env,
  input: EnqueueProspectDetectInput
): Promise<{ inserted: boolean; id?: string }> {
  return enqueueWork(
    env,
    input.orgId,
    prospectDetectHandler.domain,
    {
      source_type: input.sourceType,
      source_id: input.sourceId,
      origin: input.origin,
      detected_at: new Date().toISOString(),
      ingestion_mode: input.ingestionMode || 'live',
    } satisfies ProspectDetectPayload,
    {
      upstream: 'claude',
      priority: input.priority ?? 10,
      max_attempts: 5,
      idempotency_key: `${input.orgId}:${input.sourceType}:${input.sourceId}:prospect_detect:v1`,
    }
  );
}

export const prospectDetectHandler: WorkQueueHandler = {
  domain: 'prospect_detect',
  batchSize: 3,
  maxConcurrent: 3,
  cadence: 'minute',

  process: async (item, env) => {
    let payload: ProspectDetectPayload;
    try {
      payload = parsePayload(item.payload);
    } catch (e) {
      await deadLetterWork(env, item.id, `malformed prospect_detect payload: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const source = await loadSource(env, item.org_id, payload);
    if (!source) {
      await deadLetterWork(env, item.id, `prospect_detect source not found: ${payload.source_type}:${payload.source_id}`);
      return;
    }

    try {
      const stats = await detectAndRecordProspectSignals([source.item], item.org_id, env, {
        ingestionMode: payload.ingestion_mode || 'live',
      });
      const deferrable = stats.errors.find(error => isDeferrableClassifierError(error.error));
      if (deferrable) {
        await deferWork(
          env,
          item.id,
          new Date(Date.now() + 90_000).toISOString(),
          item.payload
        );
        return;
      }
      if (stats.errors.length > 0) {
        throw new Error(`prospect_detect_failed:${stats.errors[0].item_id}:${stats.errors[0].error}`);
      }
    } catch (e) {
      if (isDeferrableClassifierError(e)) {
        await deferWork(
          env,
          item.id,
          new Date(Date.now() + 90_000).toISOString(),
          item.payload
        );
        return;
      }
      throw e;
    }
  },
};

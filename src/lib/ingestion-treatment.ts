import type { Env } from '../types/env';
import { enqueueDocumentEmbeddingRepair } from './document-embedding';
import { autoCreateContactFromAttendee } from './firefly-intelligence';
import { enqueueRagV2SourceReindex } from './rag-v2';
import { enqueueWork } from './work-queue';
import { enqueueCompanyEnrichment } from './work-queue-handlers/company-enrichment';
import { enqueueProspectDetectSource } from './work-queue-handlers/prospect-detect';
import { enqueueDueContactEnrichment } from './contact-enrichment-queue';
import { safelyUpsertEventTimelineItemsForContacts } from './contact-detail-read-model';
import type { WorkQueueHandler } from './work-queue-driver';

export const INGESTION_TREATMENT_DOMAIN = 'ingestion_treatment';

export type IngestionTreatmentSourceTable =
  | 'conversations'
  | 'events'
  | 'documents'
  | 'news_articles';

export type IngestionTreatmentMode = 'live' | 'backfill' | 'repair';

export interface IngestionTreatmentPayload {
  source_table: IngestionTreatmentSourceTable;
  source_id: string;
  source_kind: string;
  ingestion_mode: IngestionTreatmentMode;
  origin: string;
}

export interface EnqueueIngestionTreatmentInput {
  orgId: string;
  sourceTable: IngestionTreatmentSourceTable;
  sourceId: string;
  sourceKind?: string | null;
  ingestionMode?: IngestionTreatmentMode;
  origin: string;
  priority?: number;
}

interface TreatmentResult {
  crm_status: string;
  contact_enrichment_status: string;
  company_enrichment_status: string;
  embedding_status: string;
  rag_status: string;
  prospect_status: string;
  deal_status: string;
  contacts_touched: number;
  companies_touched: number;
  work_enqueued: number;
  skipped_reasons: string[];
  errors: string[];
}

interface SourceContext {
  sourceTable: IngestionTreatmentSourceTable;
  sourceId: string;
  sourceKind: string;
  sourceType: 'conversation' | 'event' | 'document' | 'news_article';
  sourceDate: string | null;
  hasUsableText: boolean;
  contactIds: string[];
  companyIds: string[];
  participantEmails: string[];
}

const EMPTY_RESULT: TreatmentResult = {
  crm_status: 'pending',
  contact_enrichment_status: 'pending',
  company_enrichment_status: 'pending',
  embedding_status: 'pending',
  rag_status: 'pending',
  prospect_status: 'pending',
  deal_status: 'pending',
  contacts_touched: 0,
  companies_touched: 0,
  work_enqueued: 0,
  skipped_reasons: [],
  errors: [],
};

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))];
}

function normalizeEmail(email: string | null | undefined): string {
  return String(email || '').trim().toLowerCase();
}

function parsePayload(payload: string): IngestionTreatmentPayload {
  const parsed = JSON.parse(payload) as IngestionTreatmentPayload;
  if (!['conversations', 'events', 'documents', 'news_articles'].includes(parsed.source_table)) {
    throw new Error(`invalid source_table: ${String(parsed.source_table)}`);
  }
  if (!parsed.source_id) {
    throw new Error(`payload missing source_id: ${payload}`);
  }
  const ingestionMode = parsed.ingestion_mode || 'live';
  if (!['live', 'backfill', 'repair'].includes(ingestionMode)) {
    throw new Error(`invalid ingestion_mode: ${String(ingestionMode)}`);
  }
  return {
    source_table: parsed.source_table,
    source_id: parsed.source_id,
    source_kind: parsed.source_kind || 'unknown',
    ingestion_mode: ingestionMode,
    origin: parsed.origin || 'unknown',
  };
}

export async function enqueueIngestionTreatment(
  env: Env,
  input: EnqueueIngestionTreatmentInput
): Promise<{ inserted: boolean; id?: string }> {
  return enqueueWork(
    env,
    input.orgId,
    INGESTION_TREATMENT_DOMAIN,
    {
      source_table: input.sourceTable,
      source_id: input.sourceId,
      source_kind: input.sourceKind || input.sourceTable,
      ingestion_mode: input.ingestionMode || 'live',
      origin: input.origin,
    } satisfies IngestionTreatmentPayload,
    {
      upstream: null,
      priority: input.priority ?? 15,
      max_attempts: 5,
      idempotency_key: `${input.orgId}:${input.sourceTable}:${input.sourceId}:ingestion_treatment:v1`,
    }
  );
}

async function beginReceipt(
  env: Env,
  orgId: string,
  payload: IngestionTreatmentPayload
): Promise<void> {
  await env.D1.prepare(
    `INSERT INTO ingestion_treatment_receipts
       (org_id, source_table, source_id, source_kind, ingestion_mode, origin,
        status, last_attempted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending',
             strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(org_id, source_table, source_id) DO UPDATE SET
       source_kind = excluded.source_kind,
       ingestion_mode = excluded.ingestion_mode,
       origin = excluded.origin,
       status = 'pending',
       last_attempted_at = excluded.last_attempted_at,
       updated_at = excluded.updated_at`
  ).bind(
    orgId,
    payload.source_table,
    payload.source_id,
    payload.source_kind,
    payload.ingestion_mode,
    payload.origin
  ).run();
}

async function finishReceipt(
  env: Env,
  orgId: string,
  payload: IngestionTreatmentPayload,
  result: TreatmentResult
): Promise<void> {
  const hasErrors = result.errors.length > 0;
  const hasPending = [
    result.crm_status,
    result.contact_enrichment_status,
    result.company_enrichment_status,
    result.embedding_status,
    result.rag_status,
    result.prospect_status,
    result.deal_status,
  ].some(status => status === 'failed' || status === 'pending' || status === 'partial');
  const status = hasErrors ? 'failed' : hasPending ? 'partial' : 'completed';
  await env.D1.prepare(
    `UPDATE ingestion_treatment_receipts
        SET status = ?,
            crm_status = ?,
            contact_enrichment_status = ?,
            company_enrichment_status = ?,
            embedding_status = ?,
            rag_status = ?,
            prospect_status = ?,
            deal_status = ?,
            contacts_touched = ?,
            companies_touched = ?,
            work_enqueued = ?,
            skipped_reasons = ?,
            errors = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ? AND source_table = ? AND source_id = ?`
  ).bind(
    status,
    result.crm_status,
    result.contact_enrichment_status,
    result.company_enrichment_status,
    result.embedding_status,
    result.rag_status,
    result.prospect_status,
    result.deal_status,
    result.contacts_touched,
    result.companies_touched,
    result.work_enqueued,
    JSON.stringify(result.skipped_reasons),
    JSON.stringify(result.errors.slice(0, 10)),
    orgId,
    payload.source_table,
    payload.source_id
  ).run();
}

async function loadConversation(env: Env, orgId: string, sourceId: string): Promise<SourceContext | null> {
  const row = await env.D1.prepare(
    `SELECT id, source, subject, body_preview, body_r2_key, from_email, to_emails, cc_emails, sent_at
       FROM conversations
      WHERE id = ? AND org_id = ?`
  ).bind(sourceId, orgId).first<{
    id: string;
    source: string | null;
    subject: string | null;
    body_preview: string | null;
    body_r2_key: string | null;
    from_email: string | null;
    to_emails: string | null;
    cc_emails: string | null;
    sent_at: string | null;
  }>();
  if (!row) return null;

  const contacts = await env.D1.prepare(
    `SELECT DISTINCT c.id AS contact_id, c.company_id
       FROM conversation_contacts cc
       JOIN contacts c ON c.id = cc.contact_id AND c.org_id = ?
      WHERE cc.conversation_id = ? AND c.deleted_at IS NULL`
  ).bind(orgId, row.id).all<{ contact_id: string; company_id: string | null }>();

  let toEmails: string[] = [];
  let ccEmails: string[] = [];
  try { toEmails = JSON.parse(row.to_emails || '[]'); } catch {}
  try { ccEmails = JSON.parse(row.cc_emails || '[]'); } catch {}

  return {
    sourceTable: 'conversations',
    sourceId: row.id,
    sourceKind: row.source || 'conversation',
    sourceType: 'conversation',
    sourceDate: row.sent_at,
    hasUsableText: Boolean(row.body_r2_key || (row.body_preview && row.body_preview.trim().length >= 10)),
    contactIds: unique(contacts.results.map(c => c.contact_id)),
    companyIds: unique(contacts.results.map(c => c.company_id)),
    participantEmails: unique([row.from_email, ...toEmails, ...ccEmails].map(normalizeEmail)),
  };
}

async function loadEventAndRepairAttendees(
  env: Env,
  orgId: string,
  sourceId: string,
  result: TreatmentResult
): Promise<SourceContext | null> {
  const row = await env.D1.prepare(
    `SELECT id, source, title, description, summary, transcript_r2_key, start_time
       FROM events
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    source: string | null;
    title: string | null;
    description: string | null;
    summary: string | null;
    transcript_r2_key: string | null;
    start_time: string | null;
  }>();
  if (!row) return null;

  const attendees = await env.D1.prepare(
    `SELECT id, email, display_name, contact_id, user_id
       FROM event_attendees
      WHERE event_id = ?`
  ).bind(row.id).all<{
    id: string;
    email: string | null;
    display_name: string | null;
    contact_id: string | null;
    user_id: string | null;
  }>();

  const contactIds = new Set<string>();
  const companyIds = new Set<string>();

  for (const attendee of attendees.results) {
    if (attendee.contact_id) {
      contactIds.add(attendee.contact_id);
      continue;
    }
    if (attendee.user_id) continue;
    const email = normalizeEmail(attendee.email);
    if (!email) continue;
    try {
      const auto = await autoCreateContactFromAttendee({
        email,
        displayName: attendee.display_name,
        orgId,
        env,
      });
      if (!auto?.contactId) continue;
      contactIds.add(auto.contactId);
      if (auto.companyId) companyIds.add(auto.companyId);
      await env.D1.prepare(
        `UPDATE event_attendees
            SET contact_id = ?
          WHERE id = ? AND contact_id IS NULL`
      ).bind(auto.contactId, attendee.id).run();
      await safelyUpsertEventTimelineItemsForContacts(
        env,
        orgId,
        row.id,
        [auto.contactId],
        'ingestion_treatment_event_attendee'
      );
    } catch (e) {
      result.errors.push(`crm_event_attendee:${email}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (contactIds.size > 0) {
    const ids = [...contactIds];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await env.D1.prepare(
      `SELECT company_id
         FROM contacts
        WHERE org_id = ? AND id IN (${placeholders}) AND company_id IS NOT NULL`
    ).bind(orgId, ...ids).all<{ company_id: string }>();
    for (const company of rows.results) companyIds.add(company.company_id);
  }

  return {
    sourceTable: 'events',
    sourceId: row.id,
    sourceKind: row.source || 'event',
    sourceType: 'event',
    sourceDate: row.start_time,
    hasUsableText: Boolean(row.transcript_r2_key || row.summary || row.description || row.title),
    contactIds: [...contactIds],
    companyIds: [...companyIds],
    participantEmails: unique(attendees.results.map(a => normalizeEmail(a.email))),
  };
}

async function loadDocument(env: Env, orgId: string, sourceId: string): Promise<SourceContext | null> {
  const row = await env.D1.prepare(
    `SELECT id, source, document_type, title, file_name, extracted_text_preview,
            r2_key, contact_id, company_id, deal_id, conversation_id, created_at,
            processing_status
       FROM documents
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    source: string | null;
    document_type: string | null;
    title: string | null;
    file_name: string | null;
    extracted_text_preview: string | null;
    r2_key: string | null;
    contact_id: string | null;
    company_id: string | null;
    deal_id: string | null;
    conversation_id: string | null;
    created_at: string | null;
    processing_status: string | null;
  }>();
  if (!row) return null;

  const links = await env.D1.prepare(
    `SELECT entity_type, entity_id
       FROM document_links
      WHERE document_id = ? AND org_id = ?`
  ).bind(row.id, orgId).all<{ entity_type: string; entity_id: string }>();

  const linkedContactIds = links.results
    .filter(link => link.entity_type === 'contact')
    .map(link => link.entity_id);
  const linkedCompanyIds = links.results
    .filter(link => link.entity_type === 'company')
    .map(link => link.entity_id);

  return {
    sourceTable: 'documents',
    sourceId: row.id,
    sourceKind: row.document_type || row.source || 'document',
    sourceType: 'document',
    sourceDate: row.created_at,
    hasUsableText: row.processing_status === 'completed' && Boolean(row.r2_key || row.extracted_text_preview),
    contactIds: unique([row.contact_id, ...linkedContactIds]),
    companyIds: unique([row.company_id, ...linkedCompanyIds]),
    participantEmails: [],
  };
}

async function loadNews(env: Env, orgId: string, sourceId: string): Promise<SourceContext | null> {
  const row = await env.D1.prepare(
    `SELECT id, company_id, title, summary, source_url, published_at
       FROM news_articles
      WHERE id = ? AND org_id = ?`
  ).bind(sourceId, orgId).first<{
    id: string;
    company_id: string | null;
    title: string | null;
    summary: string | null;
    source_url: string | null;
    published_at: string | null;
  }>();
  if (!row) return null;
  return {
    sourceTable: 'news_articles',
    sourceId: row.id,
    sourceKind: 'news',
    sourceType: 'news_article',
    sourceDate: row.published_at,
    hasUsableText: Boolean(row.summary || row.title || row.source_url),
    contactIds: [],
    companyIds: unique([row.company_id]),
    participantEmails: [],
  };
}

async function loadSource(
  env: Env,
  orgId: string,
  payload: IngestionTreatmentPayload,
  result: TreatmentResult
): Promise<SourceContext | null> {
  if (payload.source_table === 'conversations') return loadConversation(env, orgId, payload.source_id);
  if (payload.source_table === 'events') return loadEventAndRepairAttendees(env, orgId, payload.source_id, result);
  if (payload.source_table === 'documents') return loadDocument(env, orgId, payload.source_id);
  return loadNews(env, orgId, payload.source_id);
}

async function enqueueEmbeddingIfMissing(
  env: Env,
  orgId: string,
  source: SourceContext,
  result: TreatmentResult
): Promise<void> {
  if (!['conversations', 'events', 'documents'].includes(source.sourceTable)) {
    result.embedding_status = 'skipped';
    result.skipped_reasons.push('embedding_not_applicable');
    return;
  }
  if (!source.hasUsableText) {
    result.embedding_status = 'skipped';
    result.skipped_reasons.push('embedding_no_usable_text');
    return;
  }
  const existing = await env.D1.prepare(
    `SELECT 1
       FROM vector_entity_index
      WHERE org_id = ? AND entity_id = ? AND source_table = ?
      LIMIT 1`
  ).bind(orgId, source.sourceId, source.sourceTable).first();
  if (existing) {
    result.embedding_status = 'present';
    return;
  }
  if (source.sourceTable === 'documents') {
    await enqueueDocumentEmbeddingRepair(env, orgId, source.sourceId, {
      auditKey: 'ingestion_treatment',
      priority: 30,
    });
    result.work_enqueued += 1;
    result.embedding_status = 'queued';
    return;
  }
  const queued = await enqueueWork(
    env,
    orgId,
    'embed_retry',
    { entity_id: source.sourceId, source_table: source.sourceTable },
    {
      upstream: 'bge',
      idempotency_key: `${orgId}:${source.sourceId}:${source.sourceTable}`,
      priority: 20,
      max_attempts: 4,
    }
  );
  if (queued.inserted) result.work_enqueued += 1;
  result.embedding_status = queued.inserted ? 'queued' : 'queued_existing';
}

async function enqueueRagIfPossible(
  env: Env,
  orgId: string,
  source: SourceContext,
  result: TreatmentResult
): Promise<void> {
  if (!source.hasUsableText) {
    result.rag_status = 'skipped';
    result.skipped_reasons.push('rag_no_usable_text');
    return;
  }
  const queued = await enqueueRagV2SourceReindex(env, orgId, source.sourceTable, source.sourceId, {
    priority: source.sourceTable === 'conversations' ? 30 : 20,
    maxAttempts: 5,
  });
  if (queued.status === 'enqueued') result.work_enqueued += 1;
  result.rag_status = queued.status === 'already_queued' ? 'queued_existing' : queued.status;
}

async function enqueueProspectIfPossible(
  env: Env,
  orgId: string,
  source: SourceContext,
  ingestionMode: IngestionTreatmentMode,
  result: TreatmentResult
): Promise<void> {
  if (source.sourceTable === 'news_articles') {
    result.prospect_status = 'skipped';
    result.skipped_reasons.push('prospect_source_not_supported');
    return;
  }
  if (!source.hasUsableText) {
    result.prospect_status = 'skipped';
    result.skipped_reasons.push('prospect_no_usable_text');
    return;
  }
  const sourceType =
    source.sourceTable === 'conversations' ? 'conversation'
    : source.sourceTable === 'events' ? 'event'
    : 'document';
  const queued = await enqueueProspectDetectSource(env, {
    orgId,
    sourceType,
    sourceId: source.sourceId,
    origin: 'ingestion_treatment',
    ingestionMode: ingestionMode === 'repair' ? 'backfill' : ingestionMode,
    priority: 20,
  });
  if (queued.inserted) result.work_enqueued += 1;
  result.prospect_status = queued.inserted ? 'queued' : 'queued_existing';
}

async function enqueueDealEvidenceIfPossible(
  env: Env,
  orgId: string,
  source: SourceContext,
  result: TreatmentResult
): Promise<void> {
  if (source.sourceTable === 'news_articles') {
    result.deal_status = source.companyIds.length > 0 ? 'skipped' : 'skipped';
    result.skipped_reasons.push(source.companyIds.length > 0 ? 'deal_news_source_not_supported' : 'deal_no_company_candidate');
    return;
  }
  if (!source.hasUsableText) {
    result.deal_status = 'skipped';
    result.skipped_reasons.push('deal_no_usable_text');
    return;
  }
  if (source.companyIds.length === 0) {
    result.deal_status = 'skipped';
    result.skipped_reasons.push('deal_no_company_candidate');
    return;
  }
  const sourceType =
    source.sourceTable === 'conversations' ? 'conversation'
    : source.sourceTable === 'events' ? 'event'
    : 'document';
  let inserted = 0;
  for (const companyId of source.companyIds) {
    const queued = await enqueueWork(
      env,
      orgId,
      'deal_evidence_detect',
      {
        source_type: sourceType,
        source_id: source.sourceId,
        company_id: companyId,
        origin: 'ingestion_treatment',
        detected_at: new Date().toISOString(),
      },
      {
        upstream: 'claude',
        idempotency_key: `${orgId}:${sourceType}:${source.sourceId}:${companyId}:deal_evidence_detect:v1`,
        priority: 15,
        max_attempts: 5,
      }
    );
    if (queued.inserted) inserted += 1;
  }
  result.work_enqueued += inserted;
  result.deal_status = inserted > 0 ? 'queued' : 'queued_existing';
}

async function enqueueEnrichment(
  env: Env,
  orgId: string,
  source: SourceContext,
  result: TreatmentResult
): Promise<void> {
  if (source.contactIds.length > 0) {
    const queued = await enqueueDueContactEnrichment(orgId, env, {
      contactIds: source.contactIds,
      limit: Math.max(1, source.contactIds.length),
      targetBacklog: Math.max(60, source.contactIds.length),
    });
    result.work_enqueued += queued.inserted;
    result.contact_enrichment_status = queued.inserted > 0 ? 'queued' : 'queued_existing_or_not_due';
  } else {
    result.contact_enrichment_status = 'skipped';
    result.skipped_reasons.push('contact_enrichment_no_contacts');
  }

  if (source.companyIds.length > 0) {
    let inserted = 0;
    for (const companyId of source.companyIds) {
      const queued = await enqueueCompanyEnrichment(env, orgId, companyId, {
        origin: 'ingestion_treatment',
        priority: 10,
      });
      if (queued.inserted) inserted += 1;
      if (queued.skipped) result.skipped_reasons.push(`company_enrichment_${queued.skipped}`);
    }
    result.work_enqueued += inserted;
    result.company_enrichment_status = inserted > 0 ? 'queued' : 'queued_existing_or_not_due';
  } else {
    result.company_enrichment_status = 'skipped';
    result.skipped_reasons.push('company_enrichment_no_companies');
  }
}

export async function processIngestionTreatment(
  env: Env,
  orgId: string,
  payload: IngestionTreatmentPayload
): Promise<TreatmentResult> {
  const result: TreatmentResult = {
    ...EMPTY_RESULT,
    skipped_reasons: [],
    errors: [],
  };

  const source = await loadSource(env, orgId, payload, result);
  if (!source) {
    result.crm_status = 'skipped';
    result.contact_enrichment_status = 'skipped';
    result.company_enrichment_status = 'skipped';
    result.embedding_status = 'skipped';
    result.rag_status = 'skipped';
    result.prospect_status = 'skipped';
    result.deal_status = 'skipped';
    result.skipped_reasons.push('source_missing');
    return result;
  }

  result.contacts_touched = source.contactIds.length;
  result.companies_touched = source.companyIds.length;
  result.crm_status =
    source.contactIds.length > 0 || source.companyIds.length > 0
      ? 'completed'
      : source.participantEmails.length > 0
        ? 'partial'
        : 'skipped';
  if (result.crm_status === 'partial') result.skipped_reasons.push('crm_no_contacts_or_companies_created');
  if (result.crm_status === 'skipped') result.skipped_reasons.push('crm_no_participants_or_entities');

  await enqueueEnrichment(env, orgId, source, result);
  await enqueueEmbeddingIfMissing(env, orgId, source, result);
  await enqueueRagIfPossible(env, orgId, source, result);
  await enqueueProspectIfPossible(env, orgId, source, payload.ingestion_mode, result);
  await enqueueDealEvidenceIfPossible(env, orgId, source, result);

  return result;
}

export const ingestionTreatmentHandler: WorkQueueHandler = {
  domain: INGESTION_TREATMENT_DOMAIN,
  batchSize: 20,
  maxConcurrent: 40,
  processConcurrency: 20,
  cadence: 'minute',

  process: async (item, env) => {
    const payload = parsePayload(item.payload);
    await beginReceipt(env, item.org_id, payload);
    const result = await processIngestionTreatment(env, item.org_id, payload);
    await finishReceipt(env, item.org_id, payload, result);
  },
};

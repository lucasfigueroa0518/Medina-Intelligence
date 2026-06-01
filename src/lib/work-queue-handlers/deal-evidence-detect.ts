import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { detectDealSignalForSource } from '../deal-detection';
import { isCompanyInternal } from '../internal-entity';
import { deadLetterWork, deferWork } from '../work-queue';

type DealEvidenceSourceType = 'conversation' | 'event' | 'document';

interface DealEvidenceDetectPayload {
  source_type: DealEvidenceSourceType;
  source_id: string;
  company_id: string;
  origin: string;
  detected_at: string;
}

interface SourceBundle {
  sourceType: DealEvidenceSourceType;
  sourceId: string;
  sourceTitle: string | null;
  sourceDate: string | null;
  bodyText: string;
  bodyPreview: string | null;
  fromEmail?: string | null;
  direction?: string | null;
  sourceLabel?: string | null;
}

function parsePayload(payload: string): DealEvidenceDetectPayload {
  const parsed = JSON.parse(payload) as DealEvidenceDetectPayload;
  if (!['conversation', 'event', 'document'].includes(parsed.source_type)) {
    throw new Error(`invalid source_type: ${parsed.source_type}`);
  }
  if (!parsed.source_id || !parsed.company_id) {
    throw new Error(`payload missing source_id or company_id: ${payload}`);
  }
  return parsed;
}

async function loadConversation(env: Env, orgId: string, sourceId: string): Promise<SourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, subject, body_preview, body_r2_key, source, sent_at, from_email, direction
       FROM conversations
      WHERE id = ? AND org_id = ?`
  ).bind(sourceId, orgId).first<{
    id: string;
    subject: string | null;
    body_preview: string | null;
    body_r2_key: string | null;
    source: string;
    sent_at: string | null;
    from_email: string | null;
    direction: string | null;
  }>();
  if (!row) return null;
  let bodyText = row.body_preview || '';
  if (row.body_r2_key) {
    const obj = await env.R2.get(row.body_r2_key);
    if (obj) bodyText = await obj.text();
  }
  return {
    sourceType: 'conversation',
    sourceId,
    sourceTitle: row.subject,
    sourceDate: row.sent_at,
    bodyText,
    bodyPreview: row.body_preview,
    fromEmail: row.from_email,
    direction: row.direction,
    sourceLabel: row.source,
  };
}

async function loadEvent(env: Env, orgId: string, sourceId: string): Promise<SourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, title, description, summary, transcript_r2_key, source, start_time
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
  return {
    sourceType: 'event',
    sourceId,
    sourceTitle: row.title,
    sourceDate: row.start_time,
    bodyText,
    bodyPreview: row.summary,
    sourceLabel: row.source,
  };
}

async function loadDocument(env: Env, orgId: string, sourceId: string): Promise<SourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, title, file_name, mime_type, document_type, r2_key,
            extracted_text_preview, created_at
       FROM documents
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    title: string;
    file_name: string | null;
    mime_type: string | null;
    document_type: string | null;
    r2_key: string | null;
    extracted_text_preview: string | null;
    created_at: string | null;
  }>();
  if (!row) return null;
  let bodyText = row.extracted_text_preview || '';
  if ((!bodyText || bodyText.length < 1200) && row.r2_key) {
    try {
      const obj = await env.R2.get(row.r2_key);
      if (obj) {
        const { extractTextFromFile } = await import('../file-extraction');
        const buffer = await obj.arrayBuffer();
        bodyText = await extractTextFromFile(new File([buffer], row.file_name || row.title, { type: row.mime_type || '' }));
      }
    } catch (e) {
      console.warn(`[deal-evidence-detect] document extraction failed for ${sourceId}:`, e instanceof Error ? e.message : e);
    }
  }
  return {
    sourceType: 'document',
    sourceId,
    sourceTitle: row.title,
    sourceDate: row.created_at,
    bodyText,
    bodyPreview: row.extracted_text_preview,
    sourceLabel: row.document_type || 'document',
  };
}

async function loadSource(env: Env, orgId: string, payload: DealEvidenceDetectPayload): Promise<SourceBundle | null> {
  if (payload.source_type === 'conversation') return loadConversation(env, orgId, payload.source_id);
  if (payload.source_type === 'event') return loadEvent(env, orgId, payload.source_id);
  return loadDocument(env, orgId, payload.source_id);
}

async function isEligibleCompany(env: Env, orgId: string, companyId: string): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT id, is_internal_entity
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<{ id: string; is_internal_entity: number | null }>();
  if (!row || row.is_internal_entity === 1) return false;
  return !(await isCompanyInternal(companyId, orgId, env));
}

function isDeferrableClaudeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /CLAUDE_RATE_LIMITED|429|rate.?limit|timeout/i.test(message);
}

export const dealEvidenceDetectHandler: WorkQueueHandler = {
  domain: 'deal_evidence_detect',
  batchSize: 5,
  maxConcurrent: 5,
  cadence: 'minute',

  process: async (item, env) => {
    let payload: DealEvidenceDetectPayload;
    try {
      payload = parsePayload(item.payload);
    } catch (e) {
      await deadLetterWork(env, item.id, `malformed deal_evidence_detect payload: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (!(await isEligibleCompany(env, item.org_id, payload.company_id))) return;

    const source = await loadSource(env, item.org_id, payload);
    if (!source) return;

    try {
      await detectDealSignalForSource({
        orgId: item.org_id,
        companyId: payload.company_id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceTitle: source.sourceTitle,
        sourceDate: source.sourceDate,
        bodyText: source.bodyText,
        bodyPreview: source.bodyPreview,
        fromEmail: source.fromEmail,
        direction: source.direction,
        sourceLabel: source.sourceLabel,
      }, env);
    } catch (e) {
      if (isDeferrableClaudeError(e)) {
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

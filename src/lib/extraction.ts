// TRD §7.8 — LLM extraction from communications
import type { Env } from '../types/env';
import type {
  Conversation,
  EnrichmentSourceContribution,
} from '../types/interfaces';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
import { hashShort, getOrgSettings, getCurrentSyncJobId } from './helpers';
import { LLM_PROMPTS } from '../prompts';

export interface ExtractionSignal {
  entity_type: 'contact' | 'company';
  entity_identifier: string;
  entity_id?: string;
  entityType?: 'contact' | 'company';
  field: string;
  value: unknown;
  confidence: number;
  evidence?: string;
}

export function parseExtractionResponse(response: string): ExtractionSignal[] {
  try {
    const cleaned = response
      .trim()
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ExtractionSignal =>
        s &&
        typeof s === 'object' &&
        (s.entity_type === 'contact' || s.entity_type === 'company') &&
        typeof s.field === 'string' &&
        typeof s.confidence === 'number'
    );
  } catch {
    return [];
  }
}

async function resolveEntityId(
  signal: ExtractionSignal,
  orgId: string,
  env: Env
): Promise<string | null> {
  if (signal.entity_type === 'contact') {
    const row = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(full_name) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, signal.entity_identifier).first<{ id: string }>();
    return row?.id || null;
  }
  const row = await env.D1.prepare(
    'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, signal.entity_identifier).first<{ id: string }>();
  return row?.id || null;
}

export async function getEntityFieldValue(
  entityId: string,
  field: string,
  env: Env
): Promise<unknown> {
  // Safe field whitelist
  const allowed = new Set([
    'job_title',
    'company_id',
    'stage',
    'current_valuation',
    'topics_of_interest',
    'pain_points',
    'investment_thesis_tags',
    'sector',
  ]);
  if (!allowed.has(field)) return null;

  // Try contacts first
  const contact = await env.D1.prepare(
    `SELECT ${field} as v FROM contacts WHERE id = ?`
  ).bind(entityId).first<{ v: unknown }>().catch(() => null);
  if (contact?.v !== undefined && contact.v !== null) return contact.v;

  const company = await env.D1.prepare(
    `SELECT ${field} as v FROM companies WHERE id = ?`
  ).bind(entityId).first<{ v: unknown }>().catch(() => null);
  return company?.v ?? null;
}

export async function extractEnrichmentSignals(
  conversation: Conversation,
  orgId: string,
  env: Env
): Promise<EnrichmentSourceContribution[]> {
  const body = await env.R2.get(conversation.body_r2_key);
  if (!body) return [];
  const text = await body.text();
  if (text.length < 50) return [];

  let response: string;
  try {
    response = await callClaude(
      {
        system: LLM_PROMPTS.EXTRACTION_SYSTEM,
        user: `${LLM_PROMPTS.EXTRACTION_USER_PREFIX}\n\n---\n\n${truncateToTokens(text, 3000)}`,
        max_tokens: 1000,
        orgId,
      },
      'low',
      env
    );
  } catch {
    return [];
  }

  const signals = parseExtractionResponse(response);
  const contributions: EnrichmentSourceContribution[] = [];

  for (const signal of signals) {
    const isStructured = [
      'job_title',
      'company_id',
      'stage',
      'current_valuation',
    ].includes(signal.field);
    const threshold = isStructured ? 0.95 : 0.8;
    if (signal.confidence < threshold) continue;

    const entityId = signal.entity_id || (await resolveEntityId(signal, orgId, env));
    if (!entityId) continue;

    const existing = await getEntityFieldValue(entityId, signal.field, env);
    const isOverwrite = existing !== null && existing !== undefined;

    const settings = await getOrgSettings(orgId, env);
    const autoApprove = !isOverwrite && !isStructured && settings.auto_approve_sync;

    const syncJobId = await getCurrentSyncJobId(orgId, 'enrichment', env);
    const idempotencyKey = `${orgId}:${entityId}:${signal.field}:${hashShort(
      JSON.stringify(signal.value)
    )}:${syncJobId}`;

    await env.D1.prepare(
      `INSERT OR IGNORE INTO approval_queue (idempotency_key, org_id, entity_type, entity_id, change_type, field_name, proposed_value, source_communication_id, source_visibility, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        idempotencyKey,
        orgId,
        signal.entity_type,
        entityId,
        isOverwrite ? 'update_contact' : 'new_association',
        signal.field,
        JSON.stringify(signal.value),
        conversation.id,
        conversation.source === 'outlook'
          ? 'private'
          : conversation.visibility || 'org_wide',
        signal.confidence,
        autoApprove ? 'auto_approved' : 'pending'
      )
      .run();

    const dateStr = conversation.sent_at
      ? new Date(conversation.sent_at).toISOString().slice(0, 7)
      : 'unknown date';

    contributions.push({
      source: 'llm_extraction',
      text: `${signal.field}: ${JSON.stringify(signal.value)} (evidence: ${signal.evidence || 'N/A'})`,
      sanitized_text: `${signal.field}: ${JSON.stringify(
        signal.value
      )} (source: email communication, ${dateStr}, confidence: ${signal.confidence})`,
      visibility: conversation.source === 'outlook' ? 'private' : 'org_wide',
      communication_id: conversation.id,
    });
  }

  return contributions;
}

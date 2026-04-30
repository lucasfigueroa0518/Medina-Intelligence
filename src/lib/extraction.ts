// TRD §7.8 — LLM extraction from communications
import type { Env } from '../types/env';
import type {
  Conversation,
  EnrichmentSourceContribution,
} from '../types/interfaces';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
import { hashShort } from './helpers';
import { proposeEntityUpdate, type SourceType } from './progressive-enrichment';
import { isSyntheticType, recordSyntheticObservation } from './synthetic-observations';
import { LLM_PROMPTS } from '../prompts';

// Fields that proposeEntityUpdate knows how to route. Anything outside this
// set is a synthetic LLM output (e.g. "company_name" on a contact, which has
// no matching column) — we still stage it for human review but via a manual
// INSERT keyed without any per-cycle component.
const PROGRESSIVE_CONTACT_FIELDS = new Set([
  'full_name', 'job_title', 'phone', 'email', 'linkedin_url', 'twitter_url',
  'location', 'company_id', 'bio_summary', 'investment_focus', 'check_size_range',
  'communication_channel_preference', 'introduced_via', 'fund_name',
  'topics_of_interest', 'pain_points', 'investment_thesis_tags',
]);
const PROGRESSIVE_COMPANY_FIELDS = new Set([
  'name', 'sector', 'website', 'domain', 'description', 'hq_location',
  'employee_count', 'investment_status', 'stage', 'current_valuation',
  'linkedin_url', 'last_funding_amount', 'last_funding_round', 'last_funding_date',
]);

function isProgressiveField(entityType: 'contact' | 'company', field: string): boolean {
  return entityType === 'contact'
    ? PROGRESSIVE_CONTACT_FIELDS.has(field)
    : PROGRESSIVE_COMPANY_FIELDS.has(field);
}

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
  const CONTACT_QUERIES: Record<string, string> = {
    job_title: 'SELECT job_title as v FROM contacts WHERE id = ?',
    company_id: 'SELECT company_id as v FROM contacts WHERE id = ?',
    topics_of_interest: 'SELECT topics_of_interest as v FROM contacts WHERE id = ?',
    pain_points: 'SELECT pain_points as v FROM contacts WHERE id = ?',
    investment_thesis_tags: 'SELECT investment_thesis_tags as v FROM contacts WHERE id = ?',
    location: 'SELECT location as v FROM contacts WHERE id = ?',
    investment_focus: 'SELECT investment_focus as v FROM contacts WHERE id = ?',
    check_size_range: 'SELECT check_size_range as v FROM contacts WHERE id = ?',
    communication_channel_preference: 'SELECT communication_channel_preference as v FROM contacts WHERE id = ?',
    full_name: 'SELECT full_name as v FROM contacts WHERE id = ?',
    linkedin_url: 'SELECT linkedin_url as v FROM contacts WHERE id = ?',
    phone: 'SELECT phone as v FROM contacts WHERE id = ?',
    email: 'SELECT email as v FROM contacts WHERE id = ?',
    bio_summary: 'SELECT bio_summary as v FROM contacts WHERE id = ?',
    twitter_url: 'SELECT twitter_url as v FROM contacts WHERE id = ?',
  };

  const COMPANY_QUERIES: Record<string, string> = {
    stage: 'SELECT stage as v FROM companies WHERE id = ?',
    current_valuation: 'SELECT current_valuation as v FROM companies WHERE id = ?',
    sector: 'SELECT sector as v FROM companies WHERE id = ?',
    location: 'SELECT location as v FROM companies WHERE id = ?',
    description: 'SELECT description as v FROM companies WHERE id = ?',
    name: 'SELECT name as v FROM companies WHERE id = ?',
  };

  const contactQuery = CONTACT_QUERIES[field];
  if (contactQuery) {
    const row = await env.D1.prepare(contactQuery).bind(entityId).first<{ v: unknown }>().catch(() => null);
    if (row?.v !== undefined && row.v !== null) return row.v;
  }

  const companyQuery = COMPANY_QUERIES[field];
  if (companyQuery) {
    const row = await env.D1.prepare(companyQuery).bind(entityId).first<{ v: unknown }>().catch(() => null);
    if (row?.v !== undefined && row.v !== null) return row.v;
  }

  return null;
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

    // Route through progressive enrichment so we get skip-if-equal-to-current,
    // update-existing-pending-row, NULL auto-fill, and the human-edit lockout
    // for free. Falls back to a manual no-syncJobId INSERT only for synthetic
    // LLM fields that don't map to a real column.
    const proposed =
      typeof signal.value === 'string'
        ? signal.value
        : JSON.stringify(signal.value);

    // Wave 6: pick a primary observer for channel attribution. A
    // conversation can appear in multiple inboxes; for now we attribute
    // to the first participant user. Phase C may broaden this when
    // multi-observer corroboration math matters.
    let observerUserId: string | null = null;
    try {
      const parsed = JSON.parse(conversation.participant_user_ids || '[]');
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        observerUserId = parsed[0];
      }
    } catch { /* leave null — resolveChannel falls back to 'unknown' */ }

    if (isProgressiveField(signal.entity_type, signal.field)) {
      await proposeEntityUpdate(
        orgId,
        signal.entity_type,
        entityId,
        signal.field,
        proposed,
        'llm_extraction' as SourceType,
        signal.confidence,
        env,
        {
          source_communication_id: conversation.id,
          source_description: 'llm_extraction',
          context: { userId: observerUserId, conversationId: conversation.id },
        }
      );
    } else if (isSyntheticType(signal.field)) {
      // Q12 — synthetic observation. Goes to synthetic_observations,
      // NOT approval_queue. Same channel resolution flows through;
      // append-with-merge means a second observation of the same value
      // strengthens the row instead of creating a new queue item.
      await recordSyntheticObservation({
        orgId,
        entityType: signal.entity_type,
        entityId,
        observationType: signal.field,
        observationValue: proposed,
        source: 'llm_extraction',
        context: { userId: observerUserId, conversationId: conversation.id },
        confidence: signal.confidence,
        evidence: signal.evidence || null,
        sourceCommunicationId: conversation.id,
      }, env);
    } else {
      const idempotencyKey = `${orgId}:${entityId}:${signal.field}:${hashShort(
        JSON.stringify(signal.value)
      )}`;
      // Pre-Q12 path — kept for any non-progressive non-synthetic field
      // the LLM might emit that doesn't fit either model. Emits the
      // same Wave 6 payload envelope so the existing UI renders cleanly.
      const proposedValue = JSON.stringify({
        value: signal.value,
        metadata: {
          source_type: 'llm_extraction',
          source_description: 'llm_extraction',
          evidence: signal.evidence || null,
          context: { userId: observerUserId, conversationId: conversation.id },
        },
      });
      await env.D1.prepare(
        `INSERT OR IGNORE INTO approval_queue (idempotency_key, org_id, entity_type, entity_id, change_type, field_name, proposed_value, source_communication_id, source_visibility, confidence, status)
         VALUES (?, ?, ?, ?, 'new_association', ?, ?, ?, ?, ?, 'pending')`
      )
        .bind(
          idempotencyKey,
          orgId,
          signal.entity_type,
          entityId,
          signal.field,
          proposedValue,
          conversation.id,
          conversation.source === 'outlook'
            ? 'private'
            : conversation.visibility || 'org_wide',
          signal.confidence
        )
        .run();
    }

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

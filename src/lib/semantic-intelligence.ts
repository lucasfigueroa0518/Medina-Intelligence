import type { Env } from '../types/env';
import { callClaude } from './claude';
import { enqueueWork } from './work-queue';
import {
  SEMANTIC_INTELLIGENCE_DOMAIN,
  SEMANTIC_INTELLIGENCE_VERSION,
  type SemanticAssertionInput,
  type SemanticExtractionPayload,
  type SemanticMaterial,
  type SemanticObservedEntityInput,
  type SemanticProcessResult,
  type SemanticSourceTable,
  type SemanticSubjectType,
  type SemanticLinkedEntityType,
} from '../types/semantic-intelligence';

export { SEMANTIC_INTELLIGENCE_DOMAIN, SEMANTIC_INTELLIGENCE_VERSION };

const MAX_RAG_CHUNKS_FOR_SEMANTIC_CONTEXT = 18;
const MAX_CONTEXT_CHARS = 22_000;
const MAX_ASSERTIONS_PER_SOURCE = 120;
const SEMANTIC_LLM_MODEL = 'claude-haiku-4-5-20251001';

export const SEMANTIC_SOURCE_TABLES: SemanticSourceTable[] = [
  'conversations',
  'events',
  'documents',
  'contacts',
  'companies',
  'deals',
  'news_articles',
];

const SEMANTIC_PREDICATES = new Set([
  'entity.kind',
  'entity.location',
  'entity.geography_focus',
  'company.sector',
  'company.subsector',
  'company.business_model',
  'company.customer_type',
  'company.stage',
  'company.traction_metric',
  'company.existing_investor',
  'investment.stage_focus',
  'investment.sector_focus',
  'investment.thesis',
  'investment.check_size',
  'investment.lead_or_follow',
  'deal.round_size',
  'deal.valuation',
  'deal.source',
  'deal.status',
  'deal.risk',
  'deal.next_step',
  'deal.pass_reason',
  'founder.background',
  'founder.market_fit',
  'event.attendee',
  'event.invited_by',
  'event.attendance_status',
  'event.topic',
  'document.category',
  'document.contains_entity',
  'market.trend',
  'market.signal',
]);

const SUBJECT_TYPES = new Set<SemanticSubjectType>([
  'company',
  'contact',
  'deal',
  'document',
  'event',
  'conversation',
  'news_article',
  'observed_company',
  'observed_person',
  'observed_fund',
  'market',
  'topic',
]);

interface RagChunkSemanticRow {
  id: string;
  source_table: SemanticSourceTable;
  source_id: string;
  title: string | null;
  text_r2_key: string | null;
  text_preview: string | null;
  content_hash: string;
  source_hash: string;
  primary_entity_id: string | null;
  secondary_entity_ids: string | null;
  entity_names: string | null;
  document_type: string;
  source_family: string;
}

interface LlmSemanticResult {
  observed_entities?: SemanticObservedEntityInput[];
  assertions?: SemanticAssertionInput[];
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}@._&+\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function normalizeValue(value: string): string {
  return normalizeName(value).slice(0, 400);
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function sha256Short(text: string, length = 24): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

function subjectTypeForSource(sourceTable: SemanticSourceTable): SemanticSubjectType {
  if (sourceTable === 'companies') return 'company';
  if (sourceTable === 'contacts') return 'contact';
  if (sourceTable === 'deals') return 'deal';
  if (sourceTable === 'documents') return 'document';
  if (sourceTable === 'events') return 'event';
  if (sourceTable === 'conversations') return 'conversation';
  return 'news_article';
}

function linkedTypeForSource(sourceTable: SemanticSourceTable): SemanticLinkedEntityType {
  if (sourceTable === 'companies') return 'company';
  if (sourceTable === 'contacts') return 'contact';
  if (sourceTable === 'deals') return 'deal';
  if (sourceTable === 'documents') return 'document';
  if (sourceTable === 'events') return 'event';
  if (sourceTable === 'conversations') return 'conversation';
  return 'news_article';
}

function validSubjectType(value: unknown, fallback: SemanticSubjectType): SemanticSubjectType {
  const raw = String(value || '').trim() as SemanticSubjectType;
  return SUBJECT_TYPES.has(raw) ? raw : fallback;
}

function fieldAssertion(
  predicate: string,
  value: unknown,
  sourceField: string,
  quotePrefix: string,
  label: SemanticAssertionInput['confidence_label'] = 'explicit',
  valueJson?: unknown
): SemanticAssertionInput | null {
  if (value === null || typeof value === 'undefined') return null;
  const textValue = String(value).trim();
  if (!textValue) return null;
  return {
    predicate,
    value: textValue,
    value_json: valueJson,
    confidence: label === 'computed' ? 0.8 : 0.92,
    confidence_label: label,
    extraction_method: 'deterministic',
    evidence_kind: 'field_value',
    source_field: sourceField,
    evidence_quote: `${quotePrefix}: ${textValue}`,
  };
}

function inferredAssertion(
  predicate: string,
  value: string,
  sourceField: string,
  evidenceQuote: string,
  confidence = 0.86
): SemanticAssertionInput | null {
  const textValue = String(value || '').trim();
  const quote = String(evidenceQuote || '').trim();
  if (!textValue || !quote) return null;
  return {
    predicate,
    value: textValue,
    confidence,
    confidence_label: 'strong_inference',
    extraction_method: 'deterministic',
    evidence_kind: 'field_value',
    source_field: sourceField,
    evidence_quote: quote,
  };
}

function appendAssertion(target: SemanticAssertionInput[], assertion: SemanticAssertionInput | null): void {
  if (!assertion) return;
  if (!SEMANTIC_PREDICATES.has(assertion.predicate)) return;
  target.push(assertion);
}

function sourceLinesToText(lines: Array<[string, unknown]>): string {
  return lines
    .filter(([, value]) => value !== null && typeof value !== 'undefined' && String(value).trim())
    .map(([label, value]) => `${label}: ${String(value).trim()}`)
    .join('\n');
}

function evidenceLineForTerms(text: string, terms: string[]): string | null {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (const term of terms) {
    const needle = term.toLowerCase();
    const line = lines.find(candidate => candidate.toLowerCase().includes(needle));
    if (line) return line;
  }
  return null;
}

function appendTermInference(
  target: SemanticAssertionInput[],
  text: string,
  predicate: string,
  value: string,
  terms: string[],
  sourceField = 'semantic_normalization',
  confidence = 0.86
): void {
  const quote = evidenceLineForTerms(text, terms);
  appendAssertion(target, inferredAssertion(predicate, value, sourceField, quote || '', confidence));
}

function appendVcSemanticInferences(target: SemanticAssertionInput[], text: string): void {
  const lower = text.toLowerCase();
  const hasAny = (terms: string[]) => terms.some(term => lower.includes(term));

  if (hasAny(['venture capital', 'vc firm', 'vc fund', 'venture fund', 'investor', 'investment firm', 'family office'])) {
    appendTermInference(target, text, 'entity.kind', 'vc_fund', ['venture capital', 'vc firm', 'vc fund', 'venture fund', 'investment firm', 'investor', 'family office'], 'semantic_normalization', 0.9);
  }
  if (hasAny(['cybersecurity', 'cyber security', 'cyber-security', 'national security', 'zero trust', 'identity security', 'cloud security'])) {
    appendTermInference(target, text, 'investment.sector_focus', 'cybersecurity', ['cybersecurity', 'cyber security', 'cyber-security', 'national security', 'zero trust', 'identity security', 'cloud security']);
    appendTermInference(target, text, 'company.subsector', 'cybersecurity', ['cybersecurity', 'cyber security', 'cyber-security', 'national security', 'zero trust', 'identity security', 'cloud security']);
  }
  if (hasAny(['defense tech', 'defensetech', 'defense technology', 'dual-use', 'dual use', 'national security'])) {
    appendTermInference(target, text, 'investment.sector_focus', 'defense tech', ['defense tech', 'defensetech', 'defense technology', 'dual-use', 'dual use', 'national security']);
    appendTermInference(target, text, 'company.subsector', 'defense tech', ['defense tech', 'defensetech', 'defense technology', 'dual-use', 'dual use', 'national security']);
  }
  if (hasAny(['ai infrastructure', 'artificial intelligence infrastructure', 'machine learning infrastructure', 'ml infrastructure'])) {
    appendTermInference(target, text, 'investment.sector_focus', 'AI infrastructure', ['ai infrastructure', 'artificial intelligence infrastructure', 'machine learning infrastructure', 'ml infrastructure']);
    appendTermInference(target, text, 'company.subsector', 'AI infrastructure', ['ai infrastructure', 'artificial intelligence infrastructure', 'machine learning infrastructure', 'ml infrastructure']);
  }
  if (hasAny(['martech', 'marketing technology', 'marketing automation'])) {
    appendTermInference(target, text, 'investment.sector_focus', 'MarTech', ['martech', 'marketing technology', 'marketing automation']);
    appendTermInference(target, text, 'company.subsector', 'MarTech', ['martech', 'marketing technology', 'marketing automation']);
  }
  if (hasAny(['fintech', 'financial technology', 'payments', 'banking infrastructure'])) {
    appendTermInference(target, text, 'investment.sector_focus', 'fintech', ['fintech', 'financial technology', 'payments', 'banking infrastructure']);
    appendTermInference(target, text, 'company.subsector', 'fintech', ['fintech', 'financial technology', 'payments', 'banking infrastructure']);
  }
  if (hasAny(['pre-seed', 'pre seed'])) appendTermInference(target, text, 'investment.stage_focus', 'pre-seed', ['pre-seed', 'pre seed']);
  if (hasAny(['seed stage', 'seed-stage', 'seed investor', ' seed ', 'seed/series a'])) appendTermInference(target, text, 'investment.stage_focus', 'seed', ['seed stage', 'seed-stage', 'seed investor', 'seed/series a']);
  if (hasAny(['series a'])) appendTermInference(target, text, 'investment.stage_focus', 'series_a', ['series a']);
  if (hasAny(['growth stage', 'growth equity'])) appendTermInference(target, text, 'investment.stage_focus', 'growth', ['growth stage', 'growth equity']);

  if (hasAny(['florida', 'south florida', 'miami', 'fort lauderdale', 'boca raton', 'palm beach', 'tampa', 'orlando', 'jacksonville'])) {
    appendTermInference(target, text, 'entity.location', 'Florida', ['florida', 'south florida', 'miami', 'fort lauderdale', 'boca raton', 'palm beach', 'tampa', 'orlando', 'jacksonville']);
    appendTermInference(target, text, 'entity.geography_focus', 'Florida', ['florida', 'south florida', 'miami', 'fort lauderdale', 'boca raton', 'palm beach', 'tampa', 'orlando', 'jacksonville']);
  }
}

async function loadR2Text(env: Env, key: string | null | undefined): Promise<string> {
  if (!key) return '';
  const obj = await env.R2.get(key);
  return obj ? obj.text() : '';
}

async function loadMaterialFromRagChunks(
  env: Env,
  orgId: string,
  sourceTable: SemanticSourceTable,
  sourceId: string
): Promise<SemanticMaterial | null> {
  const rows = await env.D1.prepare(
    `SELECT id, source_table, source_id, title, text_r2_key, text_preview,
            content_hash, source_hash, primary_entity_id, secondary_entity_ids,
            entity_names, document_type, source_family
       FROM rag_chunks_v2
      WHERE org_id = ? AND source_table = ? AND source_id = ?
      ORDER BY chunk_index ASC
      LIMIT ?`
  ).bind(orgId, sourceTable, sourceId, MAX_RAG_CHUNKS_FOR_SEMANTIC_CONTEXT)
   .all<RagChunkSemanticRow>();

  if (rows.results.length === 0) return null;

  const chunks: string[] = [];
  for (const row of rows.results) {
    let text = '';
    try { text = await loadR2Text(env, row.text_r2_key); } catch { /* preview fallback below */ }
    if (!text) text = row.text_preview || '';
    if (!text) continue;
    chunks.push(`[${row.id}]\n${truncate(text.trim(), 3000)}`);
    if (chunks.join('\n\n').length >= MAX_CONTEXT_CHARS) break;
  }

  const first = rows.results[0];
  const title = first.title || first.entity_names || `${sourceTable}:${sourceId}`;
  const text = truncate(chunks.join('\n\n'), MAX_CONTEXT_CHARS);
  if (!text.trim()) return null;

  const deterministic: SemanticAssertionInput[] = [];
  appendAssertion(deterministic, fieldAssertion('document.category', first.document_type, 'document_type', 'Document category'));
  appendAssertion(deterministic, fieldAssertion('document.contains_entity', first.entity_names, 'entity_names', 'Named entity'));

  const sourceHash = first.source_hash || await sha256Short(rows.results.map(r => r.content_hash).join('|'));
  return {
    org_id: orgId,
    source_table: sourceTable,
    source_id: sourceId,
    source_hash: sourceHash,
    title,
    text,
    default_subject_name: title,
    default_subject_type: subjectTypeForSource(sourceTable),
    linked_entity_type: linkedTypeForSource(sourceTable),
    linked_entity_id: sourceId,
    rag_chunk_ids: rows.results.map(r => r.id),
    deterministic_assertions: deterministic,
  };
}

async function loadCanonicalMaterial(
  env: Env,
  orgId: string,
  sourceTable: SemanticSourceTable,
  sourceId: string
): Promise<SemanticMaterial | null> {
  const assertions: SemanticAssertionInput[] = [];
  let title = '';
  let text = '';

  if (sourceTable === 'companies') {
    const row = await env.D1.prepare(
      `SELECT id, name, website, description, company_type, sector, stage,
              investment_status, current_valuation, custom_fields, updated_at
         FROM companies
        WHERE org_id = ? AND id = ? AND deleted_at IS NULL AND merged_into IS NULL`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.name;
    text = sourceLinesToText([
      ['Company', row.name],
      ['Website', row.website],
      ['Kind', row.company_type],
      ['Sector', row.sector],
      ['Stage', row.stage],
      ['Investment status', row.investment_status],
      ['Current valuation', row.current_valuation],
      ['Description', row.description],
      ['Custom fields', row.custom_fields],
    ]);
    if (row.company_type && row.company_type !== 'other') {
      appendAssertion(assertions, fieldAssertion('entity.kind', row.company_type, 'company_type', 'Kind'));
    }
    appendAssertion(assertions, fieldAssertion('company.sector', row.sector, 'sector', 'Sector'));
    appendAssertion(assertions, fieldAssertion('company.stage', row.stage, 'stage', 'Stage'));
    appendAssertion(assertions, fieldAssertion('deal.status', row.investment_status, 'investment_status', 'Investment status'));
    appendAssertion(assertions, fieldAssertion('deal.valuation', row.current_valuation, 'current_valuation', 'Current valuation', 'explicit'));
    if (row.company_type === 'vc_firm' || row.company_type === 'family_office' || row.company_type === 'lp') {
      appendAssertion(assertions, fieldAssertion('investment.sector_focus', row.sector, 'sector', 'Sector'));
    }
    appendVcSemanticInferences(assertions, text);
  } else if (sourceTable === 'contacts') {
    const row = await env.D1.prepare(
      `SELECT c.id, c.full_name, c.email, c.contact_type, c.relationship_status,
              c.job_title, c.topics_of_interest, c.pain_points, c.investment_thesis_tags,
              c.bio_summary, co.name AS company_name
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.org_id = ? AND c.id = ? AND c.deleted_at IS NULL AND c.merged_into IS NULL`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.full_name;
    text = sourceLinesToText([
      ['Contact', row.full_name],
      ['Email', row.email],
      ['Kind', row.contact_type],
      ['Relationship status', row.relationship_status],
      ['Job title', row.job_title],
      ['Company', row.company_name],
      ['Topics of interest', row.topics_of_interest],
      ['Pain points', row.pain_points],
      ['Investment thesis tags', row.investment_thesis_tags],
      ['Bio', row.bio_summary],
    ]);
    appendAssertion(assertions, fieldAssertion('entity.kind', row.contact_type, 'contact_type', 'Kind'));
    appendAssertion(assertions, fieldAssertion('founder.background', row.job_title, 'job_title', 'Job title'));
    appendAssertion(assertions, fieldAssertion('investment.thesis', row.investment_thesis_tags, 'investment_thesis_tags', 'Investment thesis tags'));
    appendVcSemanticInferences(assertions, text);
  } else if (sourceTable === 'deals') {
    const row = await env.D1.prepare(
      `SELECT d.id, d.title, d.stage, d.amount, d.valuation, d.lead_source,
              d.thesis_fit, d.notes, d.expected_close, co.name AS company_name,
              co.sector AS company_sector
         FROM deals d
         LEFT JOIN companies co ON co.id = d.company_id
        WHERE d.org_id = ? AND d.id = ? AND d.deleted_at IS NULL`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.title || row.company_name || 'Untitled deal';
    text = sourceLinesToText([
      ['Deal', title],
      ['Company', row.company_name],
      ['Company sector', row.company_sector],
      ['Stage', row.stage],
      ['Round size', row.amount],
      ['Valuation', row.valuation],
      ['Lead source', row.lead_source],
      ['Thesis fit', row.thesis_fit],
      ['Notes', row.notes],
      ['Expected close', row.expected_close],
    ]);
    appendAssertion(assertions, fieldAssertion('deal.status', row.stage, 'stage', 'Stage'));
    appendAssertion(assertions, fieldAssertion('deal.round_size', row.amount, 'amount', 'Round size'));
    appendAssertion(assertions, fieldAssertion('deal.valuation', row.valuation, 'valuation', 'Valuation'));
    appendAssertion(assertions, fieldAssertion('deal.source', row.lead_source, 'lead_source', 'Lead source'));
    appendAssertion(assertions, fieldAssertion('investment.thesis', row.thesis_fit, 'thesis_fit', 'Thesis fit'));
    appendAssertion(assertions, fieldAssertion('company.sector', row.company_sector, 'company_sector', 'Company sector'));
    appendVcSemanticInferences(assertions, text);
  } else if (sourceTable === 'documents') {
    const row = await env.D1.prepare(
      `SELECT id, title, file_name, document_type, extracted_text_preview,
              company_id, contact_id, deal_id, created_at
         FROM documents
        WHERE org_id = ? AND id = ? AND deleted_at IS NULL`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.title || row.file_name || 'Untitled document';
    text = sourceLinesToText([
      ['Document', title],
      ['File name', row.file_name],
      ['Document category', row.document_type],
      ['Preview', row.extracted_text_preview],
    ]);
    appendAssertion(assertions, fieldAssertion('document.category', row.document_type, 'document_type', 'Document category'));
    appendVcSemanticInferences(assertions, text);
  } else if (sourceTable === 'events') {
    const row = await env.D1.prepare(
      `SELECT id, title, event_type, start_time, location, description,
              summary, topics_discussed, key_decisions, action_items
         FROM events
        WHERE org_id = ? AND id = ? AND deleted_at IS NULL`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.title;
    text = sourceLinesToText([
      ['Event', row.title],
      ['Event type', row.event_type],
      ['Start time', row.start_time],
      ['Location', row.location],
      ['Description', row.description],
      ['Summary', row.summary],
      ['Topics discussed', row.topics_discussed],
      ['Key decisions', row.key_decisions],
      ['Action items', row.action_items],
    ]);
    appendAssertion(assertions, fieldAssertion('event.topic', row.topics_discussed || row.title, 'topics_discussed', 'Topics discussed'));
    appendVcSemanticInferences(assertions, text);
  } else if (sourceTable === 'conversations') {
    const row = await env.D1.prepare(
      `SELECT id, source, subject, body_r2_key, body_preview, sent_at, from_email,
              to_emails, topics, action_items
         FROM conversations
        WHERE org_id = ? AND id = ?`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.subject || `${row.source} conversation`;
    let body = row.body_preview || '';
    try { body = (await loadR2Text(env, row.body_r2_key)) || body; } catch { /* preview fallback */ }
    text = sourceLinesToText([
      ['Conversation', title],
      ['Source', row.source],
      ['From', row.from_email],
      ['To', row.to_emails],
      ['Sent at', row.sent_at],
      ['Topics', row.topics],
      ['Action items', row.action_items],
      ['Body', truncate(body, 10_000)],
    ]);
    appendAssertion(assertions, fieldAssertion('deal.next_step', row.action_items, 'action_items', 'Action items'));
    appendVcSemanticInferences(assertions, text);
  } else if (sourceTable === 'news_articles') {
    const row = await env.D1.prepare(
      `SELECT id, title, source_name, published_at, summary, relevance_tag,
              relevance_score, sector
         FROM news_articles
        WHERE org_id = ? AND id = ?`
    ).bind(orgId, sourceId).first<any>();
    if (!row) return null;
    title = row.title;
    text = sourceLinesToText([
      ['News', row.title],
      ['Source', row.source_name],
      ['Published', row.published_at],
      ['Relevance', row.relevance_tag],
      ['Sector', row.sector],
      ['Summary', row.summary],
    ]);
    appendAssertion(assertions, fieldAssertion('market.signal', row.relevance_tag, 'relevance_tag', 'Relevance'));
    appendAssertion(assertions, fieldAssertion('company.sector', row.sector, 'sector', 'Sector'));
    appendVcSemanticInferences(assertions, text);
  }

  if (!title || !text.trim()) return null;
  const sourceHash = await sha256Short(`${sourceTable}:${sourceId}:${text}`);
  return {
    org_id: orgId,
    source_table: sourceTable,
    source_id: sourceId,
    source_hash: sourceHash,
    title,
    text: truncate(text, MAX_CONTEXT_CHARS),
    default_subject_name: title,
    default_subject_type: subjectTypeForSource(sourceTable),
    linked_entity_type: linkedTypeForSource(sourceTable),
    linked_entity_id: sourceId,
    rag_chunk_ids: [],
    deterministic_assertions: assertions,
  };
}

async function loadSemanticMaterial(
  env: Env,
  orgId: string,
  payload: SemanticExtractionPayload
): Promise<SemanticMaterial | null> {
  // Prefer canonical CRM rows for deterministic semantic tagging. Those
  // materials include explicit field-label lines, so assertions such as
  // company.sector or founder.background can pass the evidence-grounding
  // check. RAG chunks remain the fallback for sources whose canonical row
  // lacks enough text or for document-style content where chunk text is the
  // richer source of truth.
  return (await loadCanonicalMaterial(env, orgId, payload.source_table, payload.source_id))
    || loadMaterialFromRagChunks(env, orgId, payload.source_table, payload.source_id);
}

function extractJsonObject<T>(raw: string): T {
  const cleaned = raw.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned) as T; } catch { /* scan below */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
  throw new Error('SEMANTIC_LLM_JSON_PARSE_FAILED');
}

function quoteIsGrounded(sourceText: string, quote: string): boolean {
  const q = compactText(quote);
  if (q.length < 3) return false;
  if (sourceText.includes(quote)) return true;
  return compactText(sourceText).toLowerCase().includes(q.toLowerCase());
}

const SEMANTIC_EXTRACTION_SYSTEM = `You extract evidence-backed semantic intelligence for a venture capital operating system.

Return ONLY valid JSON:
{
  "observed_entities": [
    {"name":"...","subject_type":"observed_company|observed_person|observed_fund|market|topic","aliases":["..."],"confidence":0.0,"evidence_quote":"exact quote from source"}
  ],
  "assertions": [
    {"subject_name":"...","subject_type":"observed_company|observed_person|observed_fund|market|topic|company|contact|deal|document|event|conversation|news_article","predicate":"...","value":"...","confidence":0.0,"confidence_label":"explicit|strong_inference|weak_inference","evidence_quote":"exact quote from source","source_field":"optional"}
  ]
}

Allowed predicates:
entity.kind, entity.location, entity.geography_focus,
company.sector, company.subsector, company.business_model, company.customer_type, company.stage, company.traction_metric, company.existing_investor,
investment.stage_focus, investment.sector_focus, investment.thesis, investment.check_size, investment.lead_or_follow,
deal.round_size, deal.valuation, deal.source, deal.status, deal.risk, deal.next_step, deal.pass_reason,
founder.background, founder.market_fit,
event.attendee, event.invited_by, event.attendance_status, event.topic,
document.category, document.contains_entity,
market.trend, market.signal.

Rules:
- Do not invent. Every assertion must have an evidence_quote copied exactly from the source text.
- If the evidence quote is not present in the source, omit the assertion.
- Prefer explicit facts. Use strong_inference only for direct phrases like "cybersecurity-focused", "based in Miami", "seed investor", or table columns that clearly imply the value.
- For venture funds, extract entity.kind=vc_fund, entity.location, entity.geography_focus, investment.sector_focus, investment.stage_focus, investment.thesis, and investment.check_size when evidence supports it.
- For attendee lists/webinars, extract event.attendee, event.invited_by, event.attendance_status, and event.topic when present.
- For startup/company deal flow, extract sector, subsector, stage, traction metrics, round size, valuation, existing investors, risks, and next steps when present.
- Keep values short and normalized enough for filtering, e.g. "Florida", "cybersecurity", "seed", "VC fund".`;

async function runLlmSemanticExtraction(
  env: Env,
  material: SemanticMaterial
): Promise<LlmSemanticResult> {
  const user = [
    `Source table: ${material.source_table}`,
    `Source id: ${material.source_id}`,
    `Title: ${material.title}`,
    `Default subject: ${material.default_subject_name}`,
    '',
    'Source text:',
    material.text,
  ].join('\n');

  const raw = await callClaude(
    {
      system: SEMANTIC_EXTRACTION_SYSTEM,
      user,
      max_tokens: 2200,
      orgId: material.org_id,
      model: SEMANTIC_LLM_MODEL,
    },
    'low',
    env
  );
  const parsed = extractJsonObject<LlmSemanticResult>(raw);
  return {
    observed_entities: Array.isArray(parsed.observed_entities) ? parsed.observed_entities : [],
    assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
  };
}

async function ensureSubject(
  env: Env,
  params: {
    orgId: string;
    subjectType: SemanticSubjectType;
    name: string;
    linkedEntityType?: SemanticLinkedEntityType | null;
    linkedEntityId?: string | null;
    aliases?: string[];
    confidence?: number;
  }
): Promise<string> {
  const normalized = normalizeName(params.name || `${params.linkedEntityType}:${params.linkedEntityId}`);
  const aliases = JSON.stringify((params.aliases || []).filter(Boolean).slice(0, 12));
  const row = await env.D1.prepare(
    `INSERT INTO semantic_subjects
       (org_id, subject_type, canonical_name, normalized_name,
        linked_entity_type, linked_entity_id, aliases_json, confidence, source_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(org_id, subject_type, normalized_name) DO UPDATE SET
       canonical_name = CASE
         WHEN length(excluded.canonical_name) > length(semantic_subjects.canonical_name)
         THEN excluded.canonical_name ELSE semantic_subjects.canonical_name END,
       linked_entity_type = COALESCE(semantic_subjects.linked_entity_type, excluded.linked_entity_type),
       linked_entity_id = COALESCE(semantic_subjects.linked_entity_id, excluded.linked_entity_id),
       aliases_json = CASE
         WHEN semantic_subjects.aliases_json = '[]' THEN excluded.aliases_json
         ELSE semantic_subjects.aliases_json END,
       confidence = MAX(semantic_subjects.confidence, excluded.confidence),
       source_count = semantic_subjects.source_count + 1,
       last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id`
  ).bind(
    params.orgId,
    params.subjectType,
    truncate(params.name, 240),
    normalized,
    params.linkedEntityType ?? null,
    params.linkedEntityId ?? null,
    aliases,
    clampConfidence(params.confidence, 0.5)
  ).first<{ id: string }>();
  if (!row?.id) throw new Error('SEMANTIC_SUBJECT_UPSERT_FAILED');
  return row.id;
}

async function upsertAssertion(
  env: Env,
  material: SemanticMaterial,
  subjectId: string,
  assertion: SemanticAssertionInput
): Promise<{ assertionId: string; evidenceInserted: boolean }> {
  const value = truncate(String(assertion.value || '').trim(), 1000);
  const valueNormalized = normalizeValue(value);
  if (!value || !valueNormalized) throw new Error('SEMANTIC_EMPTY_ASSERTION_VALUE');

  const confidence = clampConfidence(assertion.confidence, 0.5);
  const row = await env.D1.prepare(
    `INSERT INTO semantic_assertions
       (org_id, subject_id, target_type, target_id, predicate, value,
        value_normalized, value_json, confidence, confidence_label,
        extraction_method, source_hash, semantic_version)
     VALUES (?, ?, 'semantic_subject', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, target_type, target_id, predicate, value_normalized) DO UPDATE SET
       subject_id = excluded.subject_id,
       value = excluded.value,
       value_json = COALESCE(excluded.value_json, semantic_assertions.value_json),
       confidence = MAX(semantic_assertions.confidence, excluded.confidence),
       confidence_label = CASE
         WHEN excluded.confidence > semantic_assertions.confidence
         THEN excluded.confidence_label ELSE semantic_assertions.confidence_label END,
       extraction_method = excluded.extraction_method,
       source_count = semantic_assertions.source_count + 1,
       source_hash = excluded.source_hash,
       status = 'active',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id`
  ).bind(
    material.org_id,
    subjectId,
    subjectId,
    assertion.predicate,
    value,
    valueNormalized,
    assertion.value_json ? JSON.stringify(assertion.value_json) : null,
    confidence,
    assertion.confidence_label || 'weak_inference',
    assertion.extraction_method || 'deterministic',
    material.source_hash,
    SEMANTIC_INTELLIGENCE_VERSION
  ).first<{ id: string }>();

  if (!row?.id) throw new Error('SEMANTIC_ASSERTION_UPSERT_FAILED');

  const evidence = await env.D1.prepare(
    `INSERT OR IGNORE INTO semantic_evidence
       (org_id, assertion_id, source_table, source_id, rag_chunk_id,
        source_field, quote, evidence_kind, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    material.org_id,
    row.id,
    material.source_table,
    material.source_id,
    assertion.rag_chunk_id || material.rag_chunk_ids[0] || null,
    assertion.source_field || null,
    truncate(assertion.evidence_quote, 1200),
    assertion.evidence_kind || 'quote',
    confidence
  ).run();

  return { assertionId: row.id, evidenceInserted: (evidence.meta.changes ?? 0) > 0 };
}

function sanitizeLlmAssertions(material: SemanticMaterial, raw: SemanticAssertionInput[]): SemanticAssertionInput[] {
  const assertions: SemanticAssertionInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const predicate = String(item?.predicate || '').trim();
    const value = String(item?.value || '').trim();
    const quote = String(item?.evidence_quote || '').trim();
    if (!SEMANTIC_PREDICATES.has(predicate) || !value || !quote) continue;
    if (!quoteIsGrounded(material.text, quote)) continue;
    const key = `${normalizeName(item.subject_name || material.default_subject_name)}|${predicate}|${normalizeValue(value)}|${compactText(quote).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assertions.push({
      subject_name: item.subject_name || material.default_subject_name,
      subject_type: validSubjectType(item.subject_type, material.default_subject_type),
      predicate,
      value,
      value_json: item.value_json,
      confidence: clampConfidence(item.confidence, 0.55),
      confidence_label: item.confidence_label || 'weak_inference',
      extraction_method: 'llm_evidence',
      evidence_kind: item.evidence_kind || 'quote',
      source_field: item.source_field,
      evidence_quote: quote,
    });
    if (assertions.length >= MAX_ASSERTIONS_PER_SOURCE) break;
  }
  return assertions;
}

function sanitizeObservedEntities(material: SemanticMaterial, raw: SemanticObservedEntityInput[]): SemanticObservedEntityInput[] {
  const entities: SemanticObservedEntityInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = String(item?.name || '').trim();
    const quote = String(item?.evidence_quote || '').trim();
    if (!name || !quote || !quoteIsGrounded(material.text, quote)) continue;
    const subjectType = validSubjectType(item.subject_type, 'observed_company');
    const key = `${subjectType}:${normalizeName(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({
      name,
      subject_type: subjectType,
      aliases: Array.isArray(item.aliases) ? item.aliases.filter(a => typeof a === 'string') : [],
      confidence: clampConfidence(item.confidence, 0.55),
      evidence_quote: quote,
    });
  }
  return entities;
}

async function recomputeRollup(env: Env, orgId: string, subjectId: string): Promise<void> {
  const subject = await env.D1.prepare(
    `SELECT linked_entity_type, linked_entity_id FROM semantic_subjects
      WHERE org_id = ? AND id = ?`
  ).bind(orgId, subjectId).first<{ linked_entity_type: string | null; linked_entity_id: string | null }>();
  if (!subject) return;

  const rows = await env.D1.prepare(
    `SELECT predicate, value, confidence
       FROM semantic_assertions
      WHERE org_id = ? AND target_type = 'semantic_subject'
        AND target_id = ? AND status = 'active'
      ORDER BY confidence DESC, updated_at DESC`
  ).bind(orgId, subjectId).all<{ predicate: string; value: string; confidence: number }>();

  const facets: Record<string, string[]> = {};
  const tags = new Set<string>();
  let confidenceTotal = 0;
  for (const row of rows.results) {
    const normalizedValue = normalizeValue(row.value);
    const lowSignal = normalizedValue === 'other' || normalizedValue === 'tracking';
    if (!facets[row.predicate]) facets[row.predicate] = [];
    if (!facets[row.predicate].includes(row.value)) facets[row.predicate].push(row.value);
    confidenceTotal += row.confidence || 0;
    if (!lowSignal && (
      row.predicate === 'entity.kind' ||
      row.predicate === 'entity.location' ||
      row.predicate === 'entity.geography_focus' ||
      row.predicate === 'company.sector' ||
      row.predicate === 'company.subsector' ||
      row.predicate === 'company.stage' ||
      row.predicate === 'investment.sector_focus' ||
      row.predicate === 'investment.stage_focus'
    )) {
      tags.add(row.value);
    }
  }

  const evidence = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM semantic_evidence ev
       JOIN semantic_assertions sa ON sa.id = ev.assertion_id
      WHERE sa.org_id = ? AND sa.target_type = 'semantic_subject'
        AND sa.target_id = ? AND sa.status = 'active'`
  ).bind(orgId, subjectId).first<{ count: number }>();

  const vcProfile = {
    kind: (facets['entity.kind'] || []).filter(v => normalizeValue(v) !== 'other'),
    locations: facets['entity.location'] || [],
    geography_focus: facets['entity.geography_focus'] || [],
    sector_focus: facets['investment.sector_focus'] || facets['company.sector'] || [],
    stage_focus: facets['investment.stage_focus'] || facets['company.stage'] || [],
    thesis: facets['investment.thesis'] || [],
    check_size: facets['investment.check_size'] || [],
    lead_or_follow: facets['investment.lead_or_follow'] || [],
  };

  await env.D1.prepare(
    `INSERT INTO semantic_tag_rollups
       (org_id, subject_id, linked_entity_type, linked_entity_id,
        tags_json, facets_json, vc_profile_json, evidence_count, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, subject_id) DO UPDATE SET
       linked_entity_type = excluded.linked_entity_type,
       linked_entity_id = excluded.linked_entity_id,
       tags_json = excluded.tags_json,
       facets_json = excluded.facets_json,
       vc_profile_json = excluded.vc_profile_json,
       evidence_count = excluded.evidence_count,
       confidence = excluded.confidence,
       generated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    orgId,
    subjectId,
    subject.linked_entity_type,
    subject.linked_entity_id,
    JSON.stringify([...tags].slice(0, 80)),
    JSON.stringify(facets),
    JSON.stringify(vcProfile),
    evidence?.count ?? 0,
    rows.results.length > 0 ? confidenceTotal / rows.results.length : 0.5
  ).run();
}

async function markSourceState(
  env: Env,
  params: {
    orgId: string;
    sourceTable: SemanticSourceTable;
    sourceId: string;
    sourceHash: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
    useLlm: boolean;
    assertionCount?: number;
    evidenceCount?: number;
    subjectCount?: number;
    error?: string | null;
  }
): Promise<void> {
  await env.D1.prepare(
    `INSERT INTO semantic_source_state
       (org_id, source_table, source_id, source_hash, semantic_version, status,
        use_llm, assertion_count, evidence_count, subject_count, last_error,
        queued_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             CASE WHEN ? = 'in_progress' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
             CASE WHEN ? IN ('completed','skipped') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END)
     ON CONFLICT(org_id, source_table, source_id) DO UPDATE SET
       source_hash = excluded.source_hash,
       semantic_version = excluded.semantic_version,
       status = excluded.status,
       use_llm = excluded.use_llm,
       assertion_count = excluded.assertion_count,
       evidence_count = excluded.evidence_count,
       subject_count = excluded.subject_count,
       last_error = excluded.last_error,
       started_at = CASE WHEN excluded.status = 'in_progress' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE semantic_source_state.started_at END,
       completed_at = CASE WHEN excluded.status IN ('completed','skipped') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE semantic_source_state.completed_at END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    params.orgId,
    params.sourceTable,
    params.sourceId,
    params.sourceHash,
    SEMANTIC_INTELLIGENCE_VERSION,
    params.status,
    params.useLlm ? 1 : 0,
    params.assertionCount ?? 0,
    params.evidenceCount ?? 0,
    params.subjectCount ?? 0,
    params.error || null,
    params.status,
    params.status
  ).run();
}

export async function processSemanticIntelligenceItem(
  env: Env,
  orgId: string,
  payload: SemanticExtractionPayload
): Promise<SemanticProcessResult> {
  const material = await loadSemanticMaterial(env, orgId, payload);
  if (!material) {
    const syntheticHash = await sha256Short(`${payload.source_table}:${payload.source_id}:missing`);
    await markSourceState(env, {
      orgId,
      sourceTable: payload.source_table,
      sourceId: payload.source_id,
      sourceHash: syntheticHash,
      status: 'skipped',
      useLlm: !!payload.use_llm,
      error: 'No semantic material found',
    });
    return {
      status: 'skipped',
      source_table: payload.source_table,
      source_id: payload.source_id,
      source_hash: syntheticHash,
      subjects: 0,
      assertions: 0,
      evidence: 0,
      errors: ['No semantic material found'],
    };
  }

  const prior = await env.D1.prepare(
    `SELECT source_hash, semantic_version, status
       FROM semantic_source_state
      WHERE org_id = ? AND source_table = ? AND source_id = ?`
  ).bind(orgId, payload.source_table, payload.source_id)
   .first<{ source_hash: string; semantic_version: string; status: string }>();
  if (!payload.force && prior?.source_hash === material.source_hash && prior.semantic_version === SEMANTIC_INTELLIGENCE_VERSION && prior.status === 'completed') {
    return {
      status: 'skipped',
      source_table: payload.source_table,
      source_id: payload.source_id,
      source_hash: material.source_hash,
      subjects: 0,
      assertions: 0,
      evidence: 0,
      errors: [],
    };
  }

  await markSourceState(env, {
    orgId,
    sourceTable: payload.source_table,
    sourceId: payload.source_id,
    sourceHash: material.source_hash,
    status: 'in_progress',
    useLlm: !!payload.use_llm,
  });

  const subjectIds = new Map<string, string>();
  let assertionCount = 0;
  let evidenceCount = 0;
  const errors: string[] = [];

  try {
    const defaultSubjectId = await ensureSubject(env, {
      orgId,
      subjectType: material.default_subject_type,
      name: material.default_subject_name,
      linkedEntityType: material.linked_entity_type,
      linkedEntityId: material.linked_entity_id,
      confidence: 0.9,
    });
    subjectIds.set(`${material.default_subject_type}:${normalizeName(material.default_subject_name)}`, defaultSubjectId);

    let llmAssertions: SemanticAssertionInput[] = [];
    if (payload.use_llm) {
      const llm = await runLlmSemanticExtraction(env, material);
      const observed = sanitizeObservedEntities(material, llm.observed_entities || []);
      for (const entity of observed) {
        const id = await ensureSubject(env, {
          orgId,
          subjectType: entity.subject_type,
          name: entity.name,
          aliases: entity.aliases,
          confidence: entity.confidence,
        });
        subjectIds.set(`${entity.subject_type}:${normalizeName(entity.name)}`, id);
      }
      llmAssertions = sanitizeLlmAssertions(material, llm.assertions || []);
    }

    const assertions = [
      ...material.deterministic_assertions,
      ...llmAssertions,
    ].slice(0, MAX_ASSERTIONS_PER_SOURCE);

    const seen = new Set<string>();
    for (const assertion of assertions) {
      if (!SEMANTIC_PREDICATES.has(assertion.predicate)) continue;
      if (!assertion.evidence_quote || !quoteIsGrounded(material.text, assertion.evidence_quote)) continue;

      const subjectName = assertion.subject_name || material.default_subject_name;
      const subjectType = validSubjectType(assertion.subject_type, material.default_subject_type);
      const subjectKey = `${subjectType}:${normalizeName(subjectName)}`;
      let subjectId = subjectIds.get(subjectKey);
      if (!subjectId) {
        subjectId = await ensureSubject(env, {
          orgId,
          subjectType,
          name: subjectName,
          confidence: assertion.confidence,
        });
        subjectIds.set(subjectKey, subjectId);
      }

      const assertionKey = `${subjectId}:${assertion.predicate}:${normalizeValue(assertion.value)}:${compactText(assertion.evidence_quote).toLowerCase()}`;
      if (seen.has(assertionKey)) continue;
      seen.add(assertionKey);

      try {
        const result = await upsertAssertion(env, material, subjectId, assertion);
        assertionCount++;
        if (result.evidenceInserted) evidenceCount++;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    for (const subjectId of new Set(subjectIds.values())) {
      await recomputeRollup(env, orgId, subjectId);
    }

    await markSourceState(env, {
      orgId,
      sourceTable: payload.source_table,
      sourceId: payload.source_id,
      sourceHash: material.source_hash,
      status: 'completed',
      useLlm: !!payload.use_llm,
      assertionCount,
      evidenceCount,
      subjectCount: subjectIds.size,
      error: errors.length ? errors.slice(0, 5).join('; ') : null,
    });

    return {
      status: 'completed',
      source_table: payload.source_table,
      source_id: payload.source_id,
      source_hash: material.source_hash,
      subjects: subjectIds.size,
      assertions: assertionCount,
      evidence: evidenceCount,
      errors,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSourceState(env, {
      orgId,
      sourceTable: payload.source_table,
      sourceId: payload.source_id,
      sourceHash: material.source_hash,
      status: 'failed',
      useLlm: !!payload.use_llm,
      assertionCount,
      evidenceCount,
      subjectCount: subjectIds.size,
      error: msg,
    });
    throw e;
  }
}

export interface SemanticBackfillOptions {
  sourceTables?: SemanticSourceTable[];
  limitPerTable?: number;
  dryRun?: boolean;
  useLlm?: boolean;
  force?: boolean;
}

export interface SemanticBackfillResult {
  ok: true;
  dry_run: boolean;
  use_llm: boolean;
  semantic_version: string;
  enqueued_total: number;
  candidates_total: number;
  per_table: Array<{ source_table: SemanticSourceTable; candidates: number; enqueued: number; limit: number }>;
}

export async function enqueueSemanticIntelligenceBackfill(
  env: Env,
  orgId: string,
  options: SemanticBackfillOptions = {}
): Promise<SemanticBackfillResult> {
  const sourceTables = (options.sourceTables?.length ? options.sourceTables : SEMANTIC_SOURCE_TABLES)
    .filter((t): t is SemanticSourceTable => SEMANTIC_SOURCE_TABLES.includes(t as SemanticSourceTable));
  const limit = Math.max(1, Math.min(options.limitPerTable ?? 100, 5000));
  const useLlm = options.useLlm === true;
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const perTable: SemanticBackfillResult['per_table'] = [];
  for (const sourceTable of sourceTables) {
    const rows = await env.D1.prepare(
      `SELECT s.source_table, s.source_id, s.source_hash
         FROM rag_source_index_state s
         LEFT JOIN semantic_source_state ss
           ON ss.org_id = s.org_id
          AND ss.source_table = s.source_table
          AND ss.source_id = s.source_id
        WHERE s.org_id = ?
          AND s.source_table = ?
          AND s.backfill_status = 'completed'
          AND (
            ? = 1
            OR ss.source_id IS NULL
            OR ss.semantic_version != ?
            OR ss.status IN ('failed','pending')
          )
        ORDER BY s.updated_at DESC
        LIMIT ?`
    ).bind(orgId, sourceTable, force ? 1 : 0, SEMANTIC_INTELLIGENCE_VERSION, limit)
     .all<{ source_table: SemanticSourceTable; source_id: string; source_hash: string }>();

    let enqueued = 0;
    if (!dryRun) {
      for (const row of rows.results) {
        const payload: SemanticExtractionPayload = {
          source_table: row.source_table,
          source_id: row.source_id,
          use_llm: useLlm,
          force,
        };
        const result = await enqueueWork(env, orgId, SEMANTIC_INTELLIGENCE_DOMAIN, payload, {
          upstream: useLlm ? 'claude' : null,
          idempotency_key: `${orgId}:${row.source_table}:${row.source_id}:${row.source_hash}:${SEMANTIC_INTELLIGENCE_VERSION}:${useLlm ? 'llm' : 'det'}:${force ? 'force' : 'normal'}`,
          priority: ['documents', 'events', 'companies', 'deals'].includes(row.source_table) ? 5 : 0,
          max_attempts: useLlm ? 3 : 5,
        });
        if (result.inserted) {
          enqueued++;
          await markSourceState(env, {
            orgId,
            sourceTable: row.source_table,
            sourceId: row.source_id,
            sourceHash: row.source_hash,
            status: 'pending',
            useLlm,
          }).catch(() => {});
        }
      }
    }
    perTable.push({ source_table: sourceTable, candidates: rows.results.length, enqueued, limit });
  }

  return {
    ok: true,
    dry_run: dryRun,
    use_llm: useLlm,
    semantic_version: SEMANTIC_INTELLIGENCE_VERSION,
    enqueued_total: perTable.reduce((sum, row) => sum + row.enqueued, 0),
    candidates_total: perTable.reduce((sum, row) => sum + row.candidates, 0),
    per_table: perTable,
  };
}

export async function getSemanticIntelligenceStatus(env: Env, orgId: string): Promise<Record<string, unknown>> {
  try {
    const [sourceState, queue, counts, stale] = await Promise.all([
      env.D1.prepare(
        `SELECT source_table, status, use_llm, COUNT(*) AS count
           FROM semantic_source_state
          WHERE org_id = ?
          GROUP BY source_table, status, use_llm
          ORDER BY source_table, status, use_llm`
      ).bind(orgId).all(),
      env.D1.prepare(
        `SELECT status, COUNT(*) AS count
           FROM work_queue
          WHERE org_id = ? AND domain = ?
          GROUP BY status
          ORDER BY status`
      ).bind(orgId, SEMANTIC_INTELLIGENCE_DOMAIN).all(),
      env.D1.prepare(
        `SELECT
           (SELECT COUNT(*) FROM semantic_subjects WHERE org_id = ?) AS subjects,
           (SELECT COUNT(*) FROM semantic_assertions WHERE org_id = ? AND status = 'active') AS active_assertions,
           (SELECT COUNT(*) FROM semantic_evidence WHERE org_id = ?) AS evidence,
           (SELECT COUNT(*) FROM semantic_tag_rollups WHERE org_id = ?) AS rollups`
      ).bind(orgId, orgId, orgId, orgId).first(),
      env.D1.prepare(
        `SELECT COUNT(*) AS count
           FROM rag_source_index_state s
           LEFT JOIN semantic_source_state ss
             ON ss.org_id = s.org_id
            AND ss.source_table = s.source_table
            AND ss.source_id = s.source_id
          WHERE s.org_id = ?
            AND s.backfill_status = 'completed'
            AND (ss.source_id IS NULL OR ss.semantic_version != ? OR ss.status IN ('failed','pending'))`
      ).bind(orgId, SEMANTIC_INTELLIGENCE_VERSION).first<{ count: number }>(),
    ]);
    return {
      ok: true,
      semantic_version: SEMANTIC_INTELLIGENCE_VERSION,
      source_state: sourceState.results,
      queue: queue.results,
      counts,
      stale_or_missing_completed_rag_sources: stale?.count ?? 0,
    };
  } catch (e) {
    return {
      ok: false,
      not_migrated: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

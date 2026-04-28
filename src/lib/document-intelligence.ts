import type { Env } from '../types/env';
import type { ChunkMetadata } from '../types/interfaces';
import { callClaude } from './claude';
import { jaroWinkler, scoreSimilarity } from './dedup';
import { proposeMultipleUpdates, type SourceType } from './progressive-enrichment';
import { findOrCreateCompanyByDomain } from './discovery';
import { updateEntityInIndex } from './entity-index';
import { chunkEmbedAndPersistAll } from './embedding';
import { extractTextFromFile } from './file-extraction';
import { emitAudit } from './audit';
import { persistDocument } from './persist-document';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

// MECE category set — every document the firm touches fits one of these.
// `reference` is the safety net: anything the classifier can't confidently
// place lands here so it's still ingested, embedded, and discoverable by MARTy.
export type DocumentCategory =
  // DEAL FLOW
  | 'deal_pitch'              // Pitch decks, executive summaries, one-pagers, company overviews
  | 'deal_diligence'          // DD reports, background checks, technical assessments, market analyses
  | 'deal_terms'              // Term sheets, LOIs, side letters, investment agreements, cap tables
  | 'deal_financials'         // Financial models, projections, P&L, balance sheets, revenue reports
  // FUND OPERATIONS
  | 'fund_reporting'          // LP reports, quarterly updates, fund performance, distributions, K-1s
  | 'fund_legal'              // LPAs, subscription docs, compliance filings, regulatory docs, NDAs
  | 'fund_admin'              // Bank statements, wire confirmations, tax docs, EIN letters, formation docs
  // RELATIONSHIPS
  | 'contact_data'            // Contact lists, CRM exports, vCards, LinkedIn exports, attendee lists
  | 'correspondence'          // Email threads, letters, memos, thank-you notes, introductions
  | 'meeting_material'        // Meeting agendas, board decks, IC memos, presentation materials, minutes
  // MARKET INTELLIGENCE
  | 'research'                // Industry reports, market maps, competitive analyses, white papers, news
  | 'portfolio_update'        // Portfolio company updates, board packages, milestone reports, KPI dashboards
  // GENERAL
  | 'internal_ops'            // HR docs, policies, procedures, org charts, team docs, contracts, invoices
  | 'reference';              // Anything else — guides, templates, miscellaneous files (the safety net)

export interface ExtractedContact {
  full_name: string;
  email?: string;
  phone?: string;
  job_title?: string;
  linkedin_url?: string;
  company_name?: string;
  location?: string;
  confidence: number;
}

export interface ExtractedCompany {
  name: string;
  domain?: string;
  website?: string;
  sector?: string;
  company_type?: string;
  location?: string;
  description?: string;
  stage?: string;
  valuation?: number;
  confidence: number;
}

export interface ExtractedDeal {
  name: string;
  company_name?: string;
  stage?: string;
  amount?: number;
  description?: string;
  confidence: number;
}

export interface ExtractedRelationship {
  from_name: string;
  to_name: string;
  relationship_type: string;
  context?: string;
}

export interface ExtractedSignal {
  entity_name: string;
  signal_type: 'funding' | 'hiring' | 'product_launch' | 'partnership' | 'leadership_change' | 'other';
  summary: string;
  date?: string;
}

export interface ExtractionResult {
  category: DocumentCategory;
  contacts: ExtractedContact[];
  companies: ExtractedCompany[];
  deals: ExtractedDeal[];
  relationships: ExtractedRelationship[];
  signals: ExtractedSignal[];
  summary: string;
}

interface MatchedEntity {
  extracted_name: string;
  matched_id: string | null;
  match_type: 'exact' | 'fuzzy' | 'new';
  confidence: number;
}

export interface ImportResult {
  document_id: string;
  category: DocumentCategory;
  summary: string;
  contacts_created: number;
  contacts_updated: number;
  companies_created: number;
  companies_updated: number;
  deals_created: number;
  relationships_found: number;
  signals_found: number;
  entities_routed: number;
  errors: string[];
  extraction: {
    contacts: ExtractedContact[];
    companies: ExtractedCompany[];
    deals: ExtractedDeal[];
    relationships: ExtractedRelationship[];
    signals: ExtractedSignal[];
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Document Classifier
// ────────────────────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a document classifier for a venture capital CRM. You always pick the BEST fit from these 14 categories. There is no "none of these" option — pick the closest match. \`reference\` is a safety net for genuinely unclassifiable files; try harder before defaulting to it.

DEAL FLOW
- deal_pitch         Pitch decks, executive summaries, one-pagers, company overviews
- deal_diligence     DD reports, background checks, technical assessments, market analyses on a target
- deal_terms         Term sheets, LOIs, side letters, investment agreements, cap tables, SAFEs, convertibles
- deal_financials    Financial models, projections, P&L, balance sheets, revenue/burn/runway reports

FUND OPERATIONS
- fund_reporting     LP reports, quarterly updates, fund performance (TVPI/DPI/IRR), distributions, K-1s
- fund_legal         LPAs, subscription docs, compliance filings, regulatory docs, NDAs
- fund_admin         Bank statements, wire confirmations, tax docs, EIN letters, formation docs

RELATIONSHIPS
- contact_data       Contact lists, CRM exports, vCards, LinkedIn exports, event attendee lists
- correspondence     Email threads, letters, memos, thank-you notes, introductions
- meeting_material   Meeting agendas, board decks, IC memos, presentation materials, minutes

MARKET INTELLIGENCE
- research           Industry reports, market maps, competitive analyses, white papers, news articles
- portfolio_update   Portfolio company updates, board packages, milestone reports, KPI dashboards

GENERAL
- internal_ops       HR docs, policies, procedures, org charts, team docs, vendor contracts, invoices
- reference          Anything else — guides, templates, training material, miscellaneous files

Rules:
1. Always return a category. Even when confidence is low, pick the closest fit.
2. If genuinely ambiguous (e.g. a memo discussing multiple topics), pick the one most central to its purpose.
3. \`reference\` is the safety net but should never be your first choice. Try every other category first.
4. Confidence: 0.9+ for unambiguous, 0.7–0.9 for clear-but-not-certain, 0.5–0.7 for best guess, 0.3–0.5 for low-confidence fallback to \`reference\`.

Respond with ONLY a JSON object: {"category": "<category>", "confidence": <0.0-1.0>}`;

export async function classifyDocument(
  text: string,
  fileName: string,
  env: Env,
  orgId: string
): Promise<{ category: DocumentCategory; confidence: number }> {
  const preview = text.slice(0, 3000);
  const userPrompt = `File name: ${fileName}\n\nContent preview:\n${preview || '(no extractable text — classify based on filename and extension alone)'}`;

  try {
    const response = await callClaude(
      { system: CLASSIFIER_SYSTEM, user: userPrompt, max_tokens: 100, orgId, model: 'claude-haiku-4-5-20251001' },
      'low',
      env
    );
    const cleaned = response.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const cat = parsed.category as DocumentCategory;
    // Validate against the allow-list — never return an unknown string as a category.
    const valid: Set<DocumentCategory> = new Set([
      'deal_pitch','deal_diligence','deal_terms','deal_financials',
      'fund_reporting','fund_legal','fund_admin',
      'contact_data','correspondence','meeting_material',
      'research','portfolio_update',
      'internal_ops','reference',
    ]);
    return {
      category: valid.has(cat) ? cat : 'reference',
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
    };
  } catch (e) {
    console.error('[doc-intel] classification failed — defaulting to reference:', e);
    return { category: 'reference', confidence: 0.3 };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Entity Extractor
// ────────────────────────────────────────────────────────────────────────────

// Base extraction always runs — every document gets entity discovery, even
// `internal_ops` and `reference`. Category-specific hints are appended when
// applicable so the model gets richer context, never less.
const BASE_EXTRACTION_SYSTEM = `You are an entity extractor for a venture capital CRM. Extract any people, companies, financial figures, dates, or actionable intelligence from this document, regardless of document type. Even mundane operational documents often mention vendors, signatories, dates, or amounts worth capturing.

Respond with ONLY a JSON object matching this schema:
{
  "contacts": [{"full_name":"...","email":"...","phone":"...","job_title":"...","company_name":"...","location":"...","linkedin_url":"...","confidence":0.8}],
  "companies": [{"name":"...","domain":"...","website":"...","sector":"...","company_type":"...","location":"...","description":"...","stage":"...","valuation":null,"confidence":0.8}],
  "deals": [{"name":"...","company_name":"...","stage":"...","amount":null,"description":"...","confidence":0.7}],
  "relationships": [{"from_name":"...","to_name":"...","relationship_type":"investor|advisor|board_member|employee|partner","context":"..."}],
  "signals": [{"entity_name":"...","signal_type":"funding|hiring|product_launch|partnership|leadership_change|other","summary":"...","date":"..."}],
  "summary": "Brief 2-3 sentence summary of the document"
}

Rules:
- Extract every entity mentioned, even with partial data — a name alone is valid.
- Infer company names from email domains when no explicit company is listed.
- For amounts/valuations, normalize to USD numbers ($1.2M → 1200000). Never invent numbers.
- Confidence: 0.9+ for explicitly stated, 0.7–0.9 for strongly inferred, 0.5–0.7 for weakly inferred.
- Omit fields you cannot determine. Do NOT invent data.
- If the document has no extractable entities, return empty arrays and a brief summary.`;

// Category-specific add-ons appended after BASE_EXTRACTION_SYSTEM. Each fires
// only when the document was classified into that category.
const CATEGORY_HINTS: Partial<Record<DocumentCategory, string>> = {
  contact_data: `\n\nThis document is tabular (contact list / CRM export / attendee list). Treat every row as a separate \`contacts\` entry. Be exhaustive — extract every person, even with partial data. Preserve phone number formatting as-is.`,
  portfolio_update: `\n\nThis document is a portfolio company update or board package. Extract company KPIs (revenue, ARR, headcount, growth rate) into the \`signals\` array (signal_type: \`product_launch\` for product news, \`hiring\` for headcount, \`funding\` for financing events). Capture the reporting period in the summary.`,
  fund_reporting: `\n\nThis document is LP-facing fund reporting. Extract fund-level metrics (TVPI, DPI, IRR, distributions, capital calls) into \`signals\` with the fund name as \`entity_name\`. Extract every portfolio company mentioned with valuation/stage data.`,
  deal_terms: `\n\nThis document is a term sheet / LOI / investment agreement. Extract: investment amount (\`deals[].amount\`), pre-money/post-money valuation (\`companies[].valuation\`), security type (SAFE / preferred / convertible) into \`deals[].description\`, lead investor and co-investors as \`relationships\` (\`relationship_type: 'investor'\`), founders and signatories as \`contacts\`, key dates in the summary.`,
  deal_financials: `\n\nThis document is a financial model or report. Extract revenue, gross margin, burn, runway, headcount, and growth rates as \`signals\`. Capture forecast period and any funding amounts already raised.`,
  deal_pitch: `\n\nThis document is a pitch deck / one-pager. Extract: company name + sector + stage + valuation, founders + key team as \`contacts\`, raise amount as \`deals[].amount\`, market size mentions, traction metrics into \`signals\`, listed customers/partners as \`relationships\`.`,
  deal_diligence: `\n\nThis document is due-diligence material on a target company. Extract: the target company (rich detail), customer references and partners as \`relationships\`, any concerning findings as \`signals\` (signal_type: \`other\`), key personnel as \`contacts\`.`,
  fund_legal: `\n\nThis document is a legal/compliance document (LPA, NDA, subscription, regulatory). Extract: every legal entity name as \`companies\`, every signatory as \`contacts\` (job_title from their signature block), governing law and effective dates in the summary.`,
  fund_admin: `\n\nThis document is administrative (banking, tax, formation). Extract: counterparty entity names as \`companies\`, amounts and dates as \`signals\` (signal_type: \`other\`), any people referenced as \`contacts\`.`,
  correspondence: `\n\nThis document is correspondence (email thread, letter, memo). Extract every sender + recipient as \`contacts\`, follow-up commitments and dates as \`signals\`, introductions or referrals as \`relationships\`.`,
  meeting_material: `\n\nThis document is meeting material (agenda, board deck, IC memo, minutes). Extract attendees as \`contacts\`, decisions and action items as \`signals\` (signal_type: \`other\`), companies under discussion with stage/valuation context.`,
  research: `\n\nThis document is market research. Extract every company mentioned in the competitive landscape with sector tagging, market sizes (TAM/SAM/SOM) and trends in the summary, cited authors as \`contacts\`.`,
  internal_ops: `\n\nThis document is internal operational material. Extract people referenced (HR docs, org charts, vendor contracts) as \`contacts\` and any vendor/counterparty as \`companies\`. Even when sparse, surface what's there.`,
  // reference: no add-on — base prompt covers it.
};

// Tabular categories use the cheaper Haiku model and a larger char budget
// since they're typically long lists with low-density text per row.
const TABULAR_CATEGORIES = new Set<DocumentCategory>([
  'contact_data',
  'portfolio_update',
  'fund_reporting',
]);

// Tabular text larger than this gets line-chunked across multiple Claude
// calls so a 500-row XLSX doesn't get silently truncated at the 30k limit.
const TABULAR_CHUNK_THRESHOLD = 15000;
const TABULAR_LINES_PER_CHUNK = 80;
const TABULAR_HEADER_LINES = 5;
const TABULAR_MAX_CHUNKS = 12; // hard cap so a pathological file can't blow the LLM budget

export async function extractEntities(
  text: string,
  category: DocumentCategory,
  env: Env,
  orgId: string
): Promise<ExtractionResult> {
  // No text? Still return a valid empty result — extraction "ran" but found
  // nothing. The document is still ingested upstream.
  if (!text || text.trim().length < 20) {
    return { category, contacts: [], companies: [], deals: [], relationships: [], signals: [], summary: '' };
  }

  const isTabular = TABULAR_CATEGORIES.has(category);

  // Line-chunked path for large tabular text. Keeps the first few lines as
  // header context in every chunk so column meaning isn't lost. Results are
  // merged + deduped by (name, email/domain) so the same row appearing in two
  // chunks isn't double-routed.
  if (isTabular && text.length > TABULAR_CHUNK_THRESHOLD) {
    return extractTabularChunked(text, category, env, orgId);
  }

  const system = BASE_EXTRACTION_SYSTEM + (CATEGORY_HINTS[category] || '');
  const model = isTabular ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  const maxChars = isTabular ? 30000 : 20000;
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n[... truncated]' : text;

  try {
    const response = await callClaude(
      { system, user: truncated, max_tokens: 4000, orgId, model },
      'high',
      env
    );
    const cleaned = response.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      category,
      contacts: (parsed.contacts || []).filter((c: any) => c.full_name),
      companies: (parsed.companies || []).filter((c: any) => c.name),
      deals: parsed.deals || [],
      relationships: parsed.relationships || [],
      signals: parsed.signals || [],
      summary: parsed.summary || '',
    };
  } catch (e) {
    console.error('[doc-intel] extraction failed — returning empty result:', e);
    return { category, contacts: [], companies: [], deals: [], relationships: [], signals: [], summary: '' };
  }
}

// Splits long tabular text into header-prefixed chunks, runs the same
// extractor on each, and merges. Header (first ~5 lines) is repeated in every
// chunk so column meaning isn't lost. Output is deduped within the merge so
// the same row appearing in two adjacent chunks doesn't get double-routed.
async function extractTabularChunked(
  text: string,
  category: DocumentCategory,
  env: Env,
  orgId: string
): Promise<ExtractionResult> {
  const lines = text.split('\n');
  const headerEnd = Math.min(TABULAR_HEADER_LINES, lines.length);
  const header = lines.slice(0, headerEnd).join('\n');
  const dataLines = lines.slice(headerEnd);

  const chunks: string[] = [];
  for (let i = 0; i < dataLines.length && chunks.length < TABULAR_MAX_CHUNKS; i += TABULAR_LINES_PER_CHUNK) {
    chunks.push(header + '\n' + dataLines.slice(i, i + TABULAR_LINES_PER_CHUNK).join('\n'));
  }

  console.log(`[doc-intel] tabular chunked extraction: ${chunks.length} chunks (${text.length} chars total, capped at ${TABULAR_MAX_CHUNKS})`);

  const system = BASE_EXTRACTION_SYSTEM + (CATEGORY_HINTS[category] || '');
  const merged: ExtractionResult = {
    category,
    contacts: [], companies: [], deals: [], relationships: [], signals: [],
    summary: '',
  };

  for (let i = 0; i < chunks.length; i++) {
    try {
      const response = await callClaude(
        { system, user: chunks[i], max_tokens: 4000, orgId, model: 'claude-haiku-4-5-20251001' },
        'high',
        env
      );
      const cleaned = response.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      merged.contacts.push(...(parsed.contacts || []).filter((c: any) => c.full_name));
      merged.companies.push(...(parsed.companies || []).filter((c: any) => c.name));
      merged.deals.push(...(parsed.deals || []));
      merged.relationships.push(...(parsed.relationships || []));
      merged.signals.push(...(parsed.signals || []));
      if (!merged.summary && parsed.summary) merged.summary = parsed.summary;
    } catch (e) {
      console.error(`[doc-intel] chunk ${i + 1}/${chunks.length} failed:`, e);
      // Continue — partial extraction beats none.
    }
  }

  // Dedupe within the merge so the same row spanning two chunks doesn't
  // double-route. Cross-chunk dedup only — matchContact/matchCompany handle
  // pre-existing CRM entities downstream.
  const seenContacts = new Set<string>();
  merged.contacts = merged.contacts.filter(c => {
    const key = `${(c.full_name || '').toLowerCase()}|${(c.email || '').toLowerCase()}`;
    if (seenContacts.has(key)) return false;
    seenContacts.add(key);
    return true;
  });
  const seenCompanies = new Set<string>();
  merged.companies = merged.companies.filter(c => {
    const key = `${(c.name || '').toLowerCase()}|${(c.domain || '').toLowerCase()}`;
    if (seenCompanies.has(key)) return false;
    seenCompanies.add(key);
    return true;
  });

  console.log(`[doc-intel] tabular chunked merged: ${merged.contacts.length} contacts, ${merged.companies.length} companies`);
  return merged;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Entity Matcher
// ────────────────────────────────────────────────────────────────────────────

async function matchContact(
  extracted: ExtractedContact,
  orgId: string,
  env: Env
): Promise<MatchedEntity> {
  if (extracted.email) {
    const byEmail = await env.D1.prepare(
      'SELECT id, full_name FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, extracted.email.toLowerCase()).first<{ id: string; full_name: string }>();
    if (byEmail) {
      return { extracted_name: extracted.full_name, matched_id: byEmail.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  if (extracted.full_name) {
    const candidates = await env.D1.prepare(
      'SELECT id, full_name, email, phone, company_id FROM contacts WHERE org_id = ? AND deleted_at IS NULL LIMIT 500'
    ).bind(orgId).all<{ id: string; full_name: string; email: string | null; phone: string | null; company_id: string | null }>();

    let bestId: string | null = null;
    let bestScore = 0;

    for (const c of candidates.results) {
      const sim = scoreSimilarity(
        { full_name: extracted.full_name, email: extracted.email || undefined, phone: extracted.phone || undefined } as any,
        { full_name: c.full_name, email: c.email || undefined, phone: c.phone || undefined, company_id: c.company_id || undefined } as any
      );
      if (sim > bestScore) {
        bestScore = sim;
        bestId = c.id;
      }
    }

    if (bestScore >= 0.6 && bestId) {
      return { extracted_name: extracted.full_name, matched_id: bestId, match_type: 'fuzzy', confidence: bestScore };
    }
  }

  return { extracted_name: extracted.full_name, matched_id: null, match_type: 'new', confidence: 0 };
}

async function matchCompany(
  extracted: ExtractedCompany,
  orgId: string,
  env: Env
): Promise<MatchedEntity> {
  if (extracted.domain) {
    const domainLower = extracted.domain.toLowerCase().replace(/^www\./, '');
    const byDomain = await env.D1.prepare(
      'SELECT id, name FROM companies WHERE org_id = ? AND LOWER(domain) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, domainLower).first<{ id: string; name: string }>();
    if (byDomain) {
      return { extracted_name: extracted.name, matched_id: byDomain.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  const candidates = await env.D1.prepare(
    'SELECT id, name, domain FROM companies WHERE org_id = ? AND deleted_at IS NULL LIMIT 500'
  ).bind(orgId).all<{ id: string; name: string; domain: string | null }>();

  for (const c of candidates.results) {
    const nameA = extracted.name.toLowerCase().trim();
    const nameB = c.name.toLowerCase().trim();
    if (nameA === nameB) {
      return { extracted_name: extracted.name, matched_id: c.id, match_type: 'exact', confidence: 1.0 };
    }
    if (jaroWinkler(nameA, nameB) >= 0.85) {
      return { extracted_name: extracted.name, matched_id: c.id, match_type: 'fuzzy', confidence: jaroWinkler(nameA, nameB) };
    }
  }

  return { extracted_name: extracted.name, matched_id: null, match_type: 'new', confidence: 0 };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Entity Router
// ────────────────────────────────────────────────────────────────────────────

async function routeContact(
  extracted: ExtractedContact,
  match: MatchedEntity,
  orgId: string,
  documentId: string,
  env: Env
): Promise<{ created: boolean; updated: boolean; id: string }> {
  if (match.matched_id && match.match_type !== 'new') {
    const updates: { field: string; value: string; source: string; confidence: number; source_description: string }[] = [];

    if (extracted.job_title) updates.push({ field: 'job_title', value: extracted.job_title, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.phone) updates.push({ field: 'phone', value: extracted.phone, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.linkedin_url) updates.push({ field: 'linkedin_url', value: extracted.linkedin_url, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.location) updates.push({ field: 'location', value: extracted.location, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });

    if (updates.length > 0) {
      await proposeMultipleUpdates(orgId, 'contact', match.matched_id, updates, env, { policy: 'auto_if_confident' });
    }
    return { created: false, updated: updates.length > 0, id: match.matched_id };
  }

  const contactId = crypto.randomUUID();
  const now = new Date().toISOString();

  let companyId: string | null = null;
  if (extracted.email) {
    const domain = extracted.email.split('@')[1];
    if (domain) {
      companyId = await findOrCreateCompanyByDomain(domain, orgId, env);
    }
  }

  await env.D1.prepare(
    `INSERT INTO contacts
       (id, org_id, full_name, email, phone, job_title, linkedin_url, location, company_id,
        source, source_confidence, contact_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, 'individual', ?, ?)`
  ).bind(
    contactId, orgId,
    extracted.full_name,
    extracted.email || null,
    extracted.phone || null,
    extracted.job_title || null,
    extracted.linkedin_url || null,
    extracted.location || null,
    companyId,
    extracted.confidence,
    now, now
  ).run();

  return { created: true, updated: false, id: contactId };
}

async function routeCompany(
  extracted: ExtractedCompany,
  match: MatchedEntity,
  orgId: string,
  documentId: string,
  env: Env
): Promise<{ created: boolean; updated: boolean; id: string }> {
  if (match.matched_id && match.match_type !== 'new') {
    const updates: { field: string; value: string; source: string; confidence: number; source_description: string }[] = [];

    if (extracted.sector) updates.push({ field: 'sector', value: extracted.sector, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.website) updates.push({ field: 'website', value: extracted.website, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.description) updates.push({ field: 'description', value: extracted.description, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.location) updates.push({ field: 'hq_location', value: extracted.location, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.stage) updates.push({ field: 'stage', value: extracted.stage, source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });
    if (extracted.valuation) updates.push({ field: 'current_valuation', value: String(extracted.valuation), source: 'llm_extraction', confidence: extracted.confidence, source_description: `Document import ${documentId}` });

    if (updates.length > 0) {
      await proposeMultipleUpdates(orgId, 'company', match.matched_id, updates, env, { policy: 'auto_if_confident' });
    }
    return { created: false, updated: updates.length > 0, id: match.matched_id };
  }

  if (extracted.domain) {
    const companyId = await findOrCreateCompanyByDomain(extracted.domain, orgId, env);
    if (companyId) return { created: true, updated: false, id: companyId };
  }

  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, domain, website, sector, company_type, hq_location, description,
        stage, investment_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracking', ?, ?)`
  ).bind(
    companyId, orgId,
    extracted.name,
    extracted.domain || null,
    extracted.website || null,
    extracted.sector || null,
    extracted.company_type || 'other',
    extracted.location || null,
    extracted.description || null,
    extracted.stage || null,
    now, now
  ).run();

  try { await updateEntityInIndex(orgId, 'company', companyId, env); } catch {}

  return { created: true, updated: false, id: companyId };
}

async function routeDeal(
  extracted: ExtractedDeal,
  companyLookup: Map<string, string>,
  orgId: string,
  env: Env
): Promise<{ created: boolean; id: string }> {
  let companyId: string | null = null;
  if (extracted.company_name) {
    companyId = companyLookup.get(extracted.company_name.toLowerCase()) || null;
  }

  const dealId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO deals
       (id, org_id, name, company_id, stage, amount, description, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`
  ).bind(
    dealId, orgId,
    extracted.name,
    companyId,
    extracted.stage || 'prospect',
    extracted.amount || null,
    extracted.description || null,
    now, now
  ).run();

  return { created: true, id: dealId };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Main Pipeline Orchestrator
// ────────────────────────────────────────────────────────────────────────────

export async function processIntelligentImport(
  file: File,
  orgId: string,
  userId: string,
  env: Env,
  importJobId?: string
): Promise<ImportResult> {
  const errors: string[] = [];
  // Helper to log lineage so the undo endpoint can revert exactly what was
  // created. Only CREATEs are tracked; updates to pre-existing entities are
  // intentionally not undoable (they entangle with downstream enrichment).
  const logCreated = async (entityType: 'contact' | 'company' | 'deal' | 'document', entityId: string) => {
    if (!importJobId) return;
    try {
      await env.D1.prepare(
        `INSERT OR IGNORE INTO import_lineage (import_job_id, entity_type, entity_id) VALUES (?, ?, ?)`
      ).bind(importJobId, entityType, entityId).run();
    } catch (e) {
      console.error(`[doc-intel] lineage log failed for ${entityType}/${entityId}:`, e);
    }
  };

  // Try to extract text. If extraction fails or yields nothing, we still
  // ingest the file — it just lands as `reference` with no entity payload.
  let text = '';
  let extractionFailed = false;
  try {
    text = await extractTextFromFile(file);
  } catch (e: any) {
    extractionFailed = true;
    errors.push(`Text extraction: ${e?.message || e}`);
  }
  const hasUsableText = !!text && text.trim().length >= 20;
  if (!hasUsableText) extractionFailed = true;

  // Classify — even when text is empty, the classifier sees the filename and
  // returns a category (or `reference` on hard failure). Never throws.
  const { category, confidence: classConfidence } = await classifyDocument(
    text,
    file.name,
    env,
    orgId
  );
  console.log(
    `[doc-intel] classified "${file.name}" as ${category} (confidence: ${classConfidence}, text_extracted: ${hasUsableText})`
  );

  // Run base + category-specific extraction. Empty text → empty result, no Claude call wasted.
  const extraction = await extractEntities(text, category, env, orgId);
  console.log(
    `[doc-intel] extracted: ${extraction.contacts.length} contacts, ${extraction.companies.length} companies, ${extraction.deals.length} deals`
  );

  // Persist via the unified writer. Pre-extracted text + pre-classified
  // category short-circuit finalize()'s extract/classify steps so we don't
  // waste a second LLM call on the classifier.
  const persisted = await persistDocument({
    file,
    orgId,
    source: 'intelligent_import',
    visibility: 'org_wide',
    participantUserIds: null,
    uploadedBy: userId,
    links: [],  // intelligent_import creates entities; back-linking is a future feature
    documentType: category,
    preExtractedText: text,
    embed: true,
  }, env);
  const documentId = persisted.documentId;
  await logCreated('document', documentId);

  // Match + Route companies first (contacts may reference them)
  const companyLookup = new Map<string, string>();
  let companiesCreated = 0;
  let companiesUpdated = 0;

  for (const company of extraction.companies) {
    try {
      const match = await matchCompany(company, orgId, env);
      const result = await routeCompany(company, match, orgId, documentId, env);
      companyLookup.set(company.name.toLowerCase(), result.id);
      if (result.created) { companiesCreated++; await logCreated('company', result.id); }
      if (result.updated) companiesUpdated++;
    } catch (e: any) {
      errors.push(`Company "${company.name}": ${e.message}`);
    }
  }

  // Match + Route contacts
  let contactsCreated = 0;
  let contactsUpdated = 0;

  for (const contact of extraction.contacts) {
    try {
      const match = await matchContact(contact, orgId, env);
      const result = await routeContact(contact, match, orgId, documentId, env);
      if (result.created) { contactsCreated++; await logCreated('contact', result.id); }
      if (result.updated) contactsUpdated++;

      if (contact.company_name && result.id) {
        const companyId = companyLookup.get(contact.company_name.toLowerCase());
        if (companyId) {
          await env.D1.prepare(
            'UPDATE contacts SET company_id = ? WHERE id = ? AND company_id IS NULL'
          ).bind(companyId, result.id).run();
        }
      }
    } catch (e: any) {
      errors.push(`Contact "${contact.full_name}": ${e.message}`);
    }
  }

  // Route deals
  let dealsCreated = 0;
  for (const deal of extraction.deals) {
    try {
      const result = await routeDeal(deal, companyLookup, orgId, env);
      if (result.created) { dealsCreated++; await logCreated('deal', result.id); }
    } catch (e: any) {
      errors.push(`Deal "${deal.name}": ${e.message}`);
    }
  }

  // Embed + status='completed' via the helper's finalize step. preExtractedText
  // and documentType were passed to persistDocument, so finalize skips the
  // re-extract / re-classify and goes straight to chunking.
  try {
    await persisted.finalize();
  } catch (e: any) {
    errors.push(`Finalize: ${e?.message || e}`);
  }

  // Audit
  await emitAudit(env, {
    org_id: orgId,
    user_id: userId,
    action: 'intelligent_import',
    entity_type: 'document',
    entity_id: documentId,
    metadata: {
      category,
      file_name: file.name,
      extraction_failed: extractionFailed,
      contacts_created: contactsCreated,
      contacts_updated: contactsUpdated,
      companies_created: companiesCreated,
      companies_updated: companiesUpdated,
      deals_created: dealsCreated,
      relationships: extraction.relationships.length,
      signals: extraction.signals.length,
    },
    created_at: new Date().toISOString(),
  });

  const totalRouted = contactsCreated + contactsUpdated + companiesCreated + companiesUpdated + dealsCreated;

  return {
    document_id: documentId,
    category,
    summary: extraction.summary,
    contacts_created: contactsCreated,
    contacts_updated: contactsUpdated,
    companies_created: companiesCreated,
    companies_updated: companiesUpdated,
    deals_created: dealsCreated,
    relationships_found: extraction.relationships.length,
    signals_found: extraction.signals.length,
    entities_routed: totalRouted,
    errors,
    extraction: {
      contacts: extraction.contacts,
      companies: extraction.companies,
      deals: extraction.deals,
      relationships: extraction.relationships,
      signals: extraction.signals,
    },
  };
}

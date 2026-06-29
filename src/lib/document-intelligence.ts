import type { Env } from '../types/env';
import type { ChunkMetadata } from '../types/interfaces';
import Papa from 'papaparse';
import { callClaude } from './claude';
import { jaroWinkler, scoreSimilarity } from './dedup';
import { isCompanyInternal } from './internal-entity';
import { chunkEmbedAndPersistAll } from './embedding';
import { extractTextFromFile, isTextExtractionSupported, textExtractionUnsupportedMessage } from './file-extraction';
import { emitAudit } from './audit';
import { persistDocument } from './persist-document';
import { classifyByFilename } from './document-filename-classifier';
import { enqueueDocumentEmbeddingRepair } from './document-embedding';
import { isVerifiedContactCompanyAffiliation } from './contact-company-affiliation';
import { safelyMaintainContactReadModels } from './contact-maintenance';
import { CLAUDE_HAIKU_MODEL, resolveQualityExceptionClaudeModel } from './model-policy';
import { crmQualityCustomFieldsForGate, evaluateCrmQualityGate } from './crm-quality-gate';

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

interface ExistingContactRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
}

interface ExistingCompanyRow {
  id: string;
  name: string;
  domain: string | null;
}

function normalizeLookupName(value: string | null | undefined): string {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeLookupDomain(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

export interface ImportResult {
  document_id: string;
  category: DocumentCategory;
  summary: string;
  completed: boolean;
  next_start?: number;
  total_units?: number;
  contacts_created: number;
  contacts_updated: number;
  contacts_skipped: number;
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

interface ImportProgressRow {
  processed_rows: number | null;
  created_rows: number | null;
  updated_rows: number | null;
  skipped_rows: number | null;
  failed_rows: number | null;
}

interface ImportProcessingOptions {
  startAt?: number;
  maxUnits?: number;
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
  orgId: string,
  // Wave 5 Phase C: optional cheap-filename hint. When provided, the prompt
  // appends a one-liner with the filename classifier's medium-confidence
  // guess. The LLM is still authoritative — it can override — but biases
  // toward the cheap signal in ambiguous cases.
  hint?: { category: DocumentCategory; reason?: string } | null
): Promise<{ category: DocumentCategory; confidence: number }> {
  const preview = text.slice(0, 3000);
  const hintLine = hint
    ? `\n\nFilename hint: this looks like \`${hint.category}\` based on naming conventions${hint.reason ? ` (${hint.reason})` : ''}. Confirm or override.`
    : '';
  const userPrompt = `File name: ${fileName}\n\nContent preview:\n${preview || '(no extractable text — classify based on filename and extension alone)'}${hintLine}`;

  try {
    const response = await callClaude(
      { system: CLASSIFIER_SYSTEM, user: userPrompt, max_tokens: 100, orgId, model: CLAUDE_HAIKU_MODEL },
      'low',
      env
    );
    const parsed = parseJsonObject(response);
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

function parseJsonObject<T = any>(raw: string): T {
  const cleaned = raw.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (firstError) {
    const start = cleaned.indexOf('{');
    if (start < 0) throw firstError;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        }
      }
    }
    throw firstError;
  }
}

// Tabular text larger than this gets line-chunked across multiple Claude
// calls so a 500-row XLSX doesn't get silently truncated at the 30k limit.
const TABULAR_CHUNK_THRESHOLD = 15000;
const TABULAR_LINES_PER_CHUNK = 80;
const TABULAR_HEADER_LINES = 5;
const TABULAR_MAX_CHUNKS = 12; // hard cap so a pathological file can't blow the LLM budget

const EMPTY_CELL_VALUES = new Set([
  '',
  '-',
  '--',
  'n/a',
  'na',
  'none',
  'none found',
  'null',
  'unknown',
]);

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

type BaseSpreadsheetField =
  | 'company_name'
  | 'website'
  | 'location'
  | 'sector'
  | 'stage'
  | 'description'
  | 'key_people'
  | 'contact_name'
  | 'contact_title'
  | 'contact_email'
  | 'contact_linkedin'
  | 'contact_phone';

type PersonField = 'name' | 'title' | 'email' | 'linkedin_url' | 'phone';

interface SpreadsheetHeaderMap {
  base: Map<BaseSpreadsheetField, number>;
  descriptionIndexes: number[];
  people: Map<number, Partial<Record<PersonField, number>>>;
}

function cleanCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningful(value: unknown): value is string {
  const cleaned = cleanCell(value);
  return !!cleaned && !EMPTY_CELL_VALUES.has(cleaned.toLowerCase());
}

function normalizeHeader(value: unknown): string {
  return cleanCell(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[()]/g, '')
    .trim();
}

function baseFieldForHeader(header: string): BaseSpreadsheetField | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  if (/^(vc|firm|company|organization|fund)\s*name$/.test(h)) return 'company_name';
  if (h === 'name') return 'company_name';
  if (/\b(website|web site|url|domain)\b/.test(h)) return 'website';
  if (/\b(headquarters|hq|location|city|address|office)\b/.test(h)) return 'location';
  if (/\b(sector|industry|focus)\b/.test(h)) return 'sector';
  if (/\b(investment stage|stage|round)\b/.test(h)) return 'stage';
  if (/\b(thesis|description|notes|portfolio|miami connection|recent news|aum|assets under management)\b/.test(h)) return 'description';
  if (/\b(key people|team|principals|partners)\b/.test(h)) return 'key_people';
  if (/\b(contact name|person name|full name)\b/.test(h)) return 'contact_name';
  if (/\b(contact title|person title|job title|role|position)\b/.test(h)) return 'contact_title';
  if (/\b(contact email|person email|email address|e-mail|email)\b/.test(h)) return 'contact_email';
  if (/\b(contact linkedin|person linkedin|linkedin)\b/.test(h)) return 'contact_linkedin';
  if (/\b(contact phone|person phone|phone|mobile|cell)\b/.test(h)) return 'contact_phone';
  return null;
}

function personFieldForHeader(header: string): { index: number; field: PersonField } | null {
  const h = normalizeHeader(header);
  const match = h.match(/\b(?:person|contact)\s*#?\s*(\d+)\s*(name|title|email|e-mail|linkedin|phone|mobile|cell)\b/);
  if (!match) return null;
  const fieldRaw = match[2];
  const field: PersonField =
    fieldRaw === 'title' ? 'title'
      : fieldRaw === 'email' || fieldRaw === 'e-mail' ? 'email'
      : fieldRaw === 'linkedin' ? 'linkedin_url'
      : fieldRaw === 'phone' || fieldRaw === 'mobile' || fieldRaw === 'cell' ? 'phone'
      : 'name';
  return { index: Number(match[1]), field };
}

function scoreHeaderRow(row: unknown[]): number {
  let score = 0;
  for (const cell of row) {
    const h = normalizeHeader(cell);
    if (!h) continue;
    if (personFieldForHeader(h)) score += 2;
    if (baseFieldForHeader(h)) score += 1;
  }
  return score;
}

function buildHeaderMap(headerRow: unknown[]): SpreadsheetHeaderMap {
  const map: SpreadsheetHeaderMap = { base: new Map(), descriptionIndexes: [], people: new Map() };
  headerRow.forEach((cell, idx) => {
    const h = normalizeHeader(cell);
    const person = personFieldForHeader(h);
    if (person) {
      const existing = map.people.get(person.index) || {};
      existing[person.field] = idx;
      map.people.set(person.index, existing);
      return;
    }
    const base = baseFieldForHeader(h);
    if (base === 'description') map.descriptionIndexes.push(idx);
    if (base && !map.base.has(base)) map.base.set(base, idx);
  });
  return map;
}

function cellAt(row: unknown[], index: number | undefined): string {
  return index === undefined ? '' : cleanCell(row[index]);
}

function baseCell(row: unknown[], map: SpreadsheetHeaderMap, field: BaseSpreadsheetField): string {
  return cellAt(row, map.base.get(field));
}

function descriptionCells(row: unknown[], map: SpreadsheetHeaderMap): string[] {
  return map.descriptionIndexes
    .map(index => cellAt(row, index))
    .filter(isMeaningful);
}

function splitSheetText(text: string): Array<{ name: string; csv: string }> {
  const marker = /^--- Sheet: (.+?) ---\s*$/gm;
  const matches = Array.from(text.matchAll(marker));
  if (matches.length === 0) return [{ name: 'Sheet1', csv: text }];

  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return {
      name: cleanCell(match[1]) || `Sheet${index + 1}`,
      csv: text.slice(start, end).trim(),
    };
  }).filter(section => section.csv.length > 0);
}

function parseCsvRows(csv: string): string[][] {
  const parsed = Papa.parse<string[]>(csv, {
    skipEmptyLines: 'greedy',
  });
  return (parsed.data || [])
    .filter(row => Array.isArray(row) && row.some(isMeaningful))
    .map(row => row.map(cleanCell));
}

function extractEmail(value: string): string | undefined {
  const match = cleanCell(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase();
}

function normalizeWebsite(value: string): string | undefined {
  const cleaned = cleanCell(value);
  if (!isMeaningful(cleaned)) return undefined;
  const first = cleaned.split(/[,;\s]+/).find(part => /\./.test(part) && !part.includes('@'));
  if (!first) return undefined;
  const withScheme = /^https?:\/\//i.test(first) ? first : `https://${first}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.hostname}${url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : ''}`;
  } catch {
    return undefined;
  }
}

function domainFromWebsiteOrEmail(value: string): string | undefined {
  const email = extractEmail(value);
  if (email) {
    const domain = email.split('@')[1]?.toLowerCase().replace(/^www\./, '');
    return domain && !FREE_EMAIL_DOMAINS.has(domain) ? domain : undefined;
  }

  const website = normalizeWebsite(value);
  if (!website) return undefined;
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function normalizeLinkedIn(value: string): string | undefined {
  const cleaned = cleanCell(value);
  if (!isMeaningful(cleaned)) return undefined;
  if (!/linkedin/i.test(cleaned)) return undefined;
  const first = cleaned.split(/[,;\s]+/).find(part => /linkedin/i.test(part)) || cleaned;
  if (/^https?:\/\//i.test(first)) return first;
  if (first.startsWith('/')) return `https://www.linkedin.com${first}`;
  return `https://${first.replace(/^www\./i, 'www.')}`;
}

function titleCaseFromEmail(email: string): string {
  const local = email.split('@')[0] || '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function splitOutsideParens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (isMeaningful(current)) out.push(cleanCell(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (isMeaningful(current)) out.push(cleanCell(current));
  return out;
}

function truncateText(value: string, max = 1200): string | undefined {
  const cleaned = cleanCell(value);
  if (!isMeaningful(cleaned)) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function normalizeCompanyStage(value: string | undefined): string | undefined {
  const cleaned = cleanCell(value).toLowerCase();
  if (!isMeaningful(cleaned)) return undefined;

  if (/\bpre[-\s]?seed\b/.test(cleaned)) return 'pre_seed';
  if (/\bseed\b/.test(cleaned)) return 'seed';
  if (/\bseries\s*a\b|\bser\.?\s*a\b/.test(cleaned)) return 'series_a';
  if (/\bseries\s*b\b|\bser\.?\s*b\b/.test(cleaned)) return 'series_b';
  if (/\bseries\s*c\b|\bser\.?\s*c\b/.test(cleaned)) return 'series_c';
  if (/\bgrowth\b|\blate[-\s]?stage\b|\bexpansion\b|\bscale[-\s]?up\b/.test(cleaned)) return 'growth';
  if (/\bpublic\b|\bipo\b|\bnyse\b|\bnasdaq\b/.test(cleaned)) return 'public';
  if (/\bacquir/.test(cleaned)) return 'acquired';

  // Controlled CRM enum fallback. Keep the raw spreadsheet language in the
  // description so we don't lose detail, but never violate the DB CHECK.
  return 'other';
}

function dedupeContactKey(contact: ExtractedContact): string {
  if (contact.email) return `email:${contact.email.toLowerCase()}`;
  if (contact.linkedin_url) return `linkedin:${contact.linkedin_url.toLowerCase()}`;
  return `name:${contact.full_name.toLowerCase()}|${(contact.company_name || '').toLowerCase()}`;
}

function dedupeCompanyKey(company: ExtractedCompany): string {
  if (company.domain) return `domain:${company.domain.toLowerCase()}`;
  return `name:${company.name.toLowerCase()}`;
}

function inferCompanyType(map: SpreadsheetHeaderMap): string {
  return map.base.has('stage') || map.base.has('sector') || map.base.has('key_people')
    ? 'vc_firm'
    : 'other';
}

function findHeaderIndex(rows: string[][]): number {
  let bestIndex = -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    const score = scoreHeaderRow(rows[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestScore >= 2 ? bestIndex : -1;
}

function extractContactsFromKeyPeople(value: string, companyName: string): ExtractedContact[] {
  if (!isMeaningful(value)) return [];
  return splitOutsideParens(value).flatMap(entry => {
    const match = entry.match(/^(.+?)\s*\((.+?)\)$/);
    const name = cleanCell(match ? match[1] : entry);
    if (!isMeaningful(name) || name.length < 3) return [];
    const title = match ? truncateText(match[2], 160) : undefined;
    return [{
      full_name: name,
      company_name: companyName,
      job_title: title,
      confidence: 0.72,
    }];
  });
}

function extractStructuredContactData(text: string, category: DocumentCategory): ExtractionResult | null {
  const contacts: ExtractedContact[] = [];
  const companies: ExtractedCompany[] = [];
  const seenContacts = new Set<string>();
  const seenCompanies = new Set<string>();
  let parsedRows = 0;

  for (const section of splitSheetText(text)) {
    const rows = parseCsvRows(section.csv);
    if (rows.length < 2) continue;
    const headerIndex = findHeaderIndex(rows);
    if (headerIndex < 0) continue;

    const headerMap = buildHeaderMap(rows[headerIndex]);
    const companyType = inferCompanyType(headerMap);

    for (const row of rows.slice(headerIndex + 1)) {
      const companyName = baseCell(row, headerMap, 'company_name');
      if (!isMeaningful(companyName)) continue;
      parsedRows++;

      const website = normalizeWebsite(baseCell(row, headerMap, 'website'));
      const domain = domainFromWebsiteOrEmail(website || baseCell(row, headerMap, 'website'));
      const sector = truncateText(baseCell(row, headerMap, 'sector'), 500);
      const rawStage = truncateText(baseCell(row, headerMap, 'stage'), 240);
      const stage = normalizeCompanyStage(rawStage);
      const location = truncateText(baseCell(row, headerMap, 'location'), 240);
      const descriptionParts = [
        ...descriptionCells(row, headerMap),
        rawStage ? `Investment stage: ${rawStage}` : '',
        baseCell(row, headerMap, 'key_people') ? `Key people: ${baseCell(row, headerMap, 'key_people')}` : '',
      ].filter(isMeaningful);

      const company: ExtractedCompany = {
        name: companyName,
        website,
        domain,
        sector,
        company_type: companyType,
        location,
        description: truncateText(descriptionParts.join(' | ')),
        stage,
        confidence: domain ? 0.94 : 0.88,
      };
      const companyKey = dedupeCompanyKey(company);
      if (!seenCompanies.has(companyKey)) {
        seenCompanies.add(companyKey);
        companies.push(company);
      }

      const addContact = (contact: ExtractedContact) => {
        if (!isMeaningful(contact.full_name) || contact.full_name.length < 3) return;
        const key = dedupeContactKey(contact);
        if (seenContacts.has(key)) return;
        seenContacts.add(key);
        contacts.push(contact);
      };

      for (const person of headerMap.people.values()) {
        const rawEmail = cellAt(row, person.email);
        const email = extractEmail(rawEmail);
        const rawName = cellAt(row, person.name);
        const fullName = isMeaningful(rawName) ? rawName : (email ? titleCaseFromEmail(email) : '');
        const linkedinUrl = normalizeLinkedIn(cellAt(row, person.linkedin_url));
        const phone = truncateText(cellAt(row, person.phone), 80);
        const jobTitle = truncateText(cellAt(row, person.title), 180);
        if (!isMeaningful(fullName) && !email) continue;
        addContact({
          full_name: isMeaningful(fullName) ? fullName : email!,
          email,
          phone,
          job_title: jobTitle,
          linkedin_url: linkedinUrl,
          company_name: companyName,
          location,
          confidence: email && isMeaningful(rawName) ? 0.94 : email ? 0.82 : 0.76,
        });
      }

      const rowEmail = extractEmail(baseCell(row, headerMap, 'contact_email'));
      const rowName = baseCell(row, headerMap, 'contact_name') || (rowEmail ? titleCaseFromEmail(rowEmail) : '');
      if (isMeaningful(rowName) || rowEmail) {
        addContact({
          full_name: isMeaningful(rowName) ? rowName : rowEmail!,
          email: rowEmail,
          phone: truncateText(baseCell(row, headerMap, 'contact_phone'), 80),
          job_title: truncateText(baseCell(row, headerMap, 'contact_title'), 180),
          linkedin_url: normalizeLinkedIn(baseCell(row, headerMap, 'contact_linkedin')),
          company_name: companyName,
          location,
          confidence: rowEmail && isMeaningful(rowName) ? 0.92 : rowEmail ? 0.8 : 0.74,
        });
      }

      for (const keyContact of extractContactsFromKeyPeople(baseCell(row, headerMap, 'key_people'), companyName)) {
        addContact(keyContact);
      }
    }
  }

  if (parsedRows === 0) return null;
  return {
    category,
    contacts,
    companies,
    deals: [],
    relationships: [],
    signals: [],
    summary: `Parsed ${contacts.length} contacts and ${companies.length} companies from ${parsedRows} structured spreadsheet rows.`,
  };
}

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

  if (category === 'contact_data') {
    const structured = extractStructuredContactData(text, category);
    if (structured && (structured.contacts.length > 0 || structured.companies.length > 0)) {
      console.log(
        `[doc-intel] structured spreadsheet extracted: ${structured.contacts.length} contacts, ${structured.companies.length} companies`
      );
      return structured;
    }
  }

  // Line-chunked path for large tabular text. Keeps the first few lines as
  // header context in every chunk so column meaning isn't lost. Results are
  // merged + deduped by (name, email/domain) so the same row appearing in two
  // chunks isn't double-routed.
  if (isTabular && text.length > TABULAR_CHUNK_THRESHOLD) {
    return extractTabularChunked(text, category, env, orgId);
  }

  const system = BASE_EXTRACTION_SYSTEM + (CATEGORY_HINTS[category] || '');
  const model = resolveQualityExceptionClaudeModel(env, 'document_extraction');
  const maxChars = isTabular ? 30000 : 20000;
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n[... truncated]' : text;

  try {
    const response = await callClaude(
      { system, user: truncated, max_tokens: 4000, orgId, model },
      'high',
      env
    );
    const parsed = parseJsonObject(response);

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
        { system, user: chunks[i], max_tokens: 4000, orgId, model: resolveQualityExceptionClaudeModel(env, 'document_extraction') },
        'high',
        env
      );
      const parsed = parseJsonObject(response);
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

function matchContactFromCandidates(
  extracted: ExtractedContact,
  candidates: ExistingContactRow[]
): MatchedEntity {
  if (extracted.email) {
    const emailLower = extracted.email.toLowerCase();
    const byEmail = candidates.find(c => c.email?.toLowerCase() === emailLower);
    if (byEmail) {
      return { extracted_name: extracted.full_name, matched_id: byEmail.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  let bestId: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
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

  return { extracted_name: extracted.full_name, matched_id: null, match_type: 'new', confidence: 0 };
}

function matchContactFromIndexes(
  extracted: ExtractedContact,
  candidates: ExistingContactRow[],
  byEmail: Map<string, ExistingContactRow>,
  byName: Map<string, ExistingContactRow[]>,
  preferredCompanyId?: string | null
): MatchedEntity {
  const email = extracted.email?.toLowerCase().trim();
  if (email) {
    const match = byEmail.get(email);
    if (match) {
      return { extracted_name: extracted.full_name, matched_id: match.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  const name = normalizeLookupName(extracted.full_name);
  if (name) {
    const exactNameMatches = byName.get(name) || [];
    if (
      exactNameMatches.length === 1 &&
      preferredCompanyId &&
      exactNameMatches[0].company_id === preferredCompanyId
    ) {
      return { extracted_name: extracted.full_name, matched_id: exactNameMatches[0].id, match_type: 'exact', confidence: 0.94 };
    }
  }

  // Without email, name-only fuzzy matching is too risky for bulk document
  // imports. Keep these as skipped candidates unless we already matched the
  // same person at the same company above.
  if (!email) {
    return { extracted_name: extracted.full_name, matched_id: null, match_type: 'new', confidence: 0 };
  }

  return matchContactFromCandidates(extracted, candidates);
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

function matchCompanyFromCandidates(
  extracted: ExtractedCompany,
  candidates: ExistingCompanyRow[]
): MatchedEntity {
  if (extracted.domain) {
    const domainLower = extracted.domain.toLowerCase().replace(/^www\./, '');
    const byDomain = candidates.find(c => c.domain?.toLowerCase().replace(/^www\./, '') === domainLower);
    if (byDomain) {
      return { extracted_name: extracted.name, matched_id: byDomain.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  const nameA = extracted.name.toLowerCase().trim();
  for (const c of candidates) {
    const nameB = c.name.toLowerCase().trim();
    if (nameA === nameB) {
      return { extracted_name: extracted.name, matched_id: c.id, match_type: 'exact', confidence: 1.0 };
    }
    const score = jaroWinkler(nameA, nameB);
    if (score >= 0.85) {
      return { extracted_name: extracted.name, matched_id: c.id, match_type: 'fuzzy', confidence: score };
    }
  }

  return { extracted_name: extracted.name, matched_id: null, match_type: 'new', confidence: 0 };
}

function matchCompanyFromIndexes(
  extracted: ExtractedCompany,
  candidates: ExistingCompanyRow[],
  byDomain: Map<string, ExistingCompanyRow>,
  byName: Map<string, ExistingCompanyRow>
): MatchedEntity {
  const domain = normalizeLookupDomain(extracted.domain || extracted.website);
  if (domain) {
    const match = byDomain.get(domain);
    if (match) {
      return { extracted_name: extracted.name, matched_id: match.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  const name = normalizeLookupName(extracted.name);
  if (name) {
    const match = byName.get(name);
    if (match) {
      return { extracted_name: extracted.name, matched_id: match.id, match_type: 'exact', confidence: 1.0 };
    }
  }

  return matchCompanyFromCandidates(extracted, candidates);
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Entity Router
// ────────────────────────────────────────────────────────────────────────────

async function routeContact(
  extracted: ExtractedContact,
  match: MatchedEntity,
  orgId: string,
  documentId: string,
  env: Env,
  preferredCompanyId?: string | null
): Promise<{ created: boolean; updated: boolean; skipped: boolean; id: string | null; skip_reason?: string }> {
  const companyIdForAssignment = preferredCompanyId &&
    (await isVerifiedContactCompanyAffiliation(env, orgId, extracted.email || null, preferredCompanyId)).verified
      ? preferredCompanyId
      : null;

  if (match.matched_id && match.match_type !== 'new') {
    const hasUpdates = !!(
      extracted.job_title ||
      extracted.phone ||
      extracted.linkedin_url ||
      extracted.location ||
      companyIdForAssignment
    );
    if (hasUpdates) {
      await env.D1.prepare(
        `UPDATE contacts
            SET job_title = CASE WHEN (job_title IS NULL OR job_title = '') AND ? IS NOT NULL THEN ? ELSE job_title END,
                phone = CASE WHEN (phone IS NULL OR phone = '') AND ? IS NOT NULL THEN ? ELSE phone END,
                linkedin_url = CASE WHEN (linkedin_url IS NULL OR linkedin_url = '') AND ? IS NOT NULL THEN ? ELSE linkedin_url END,
                location = CASE WHEN (location IS NULL OR location = '') AND ? IS NOT NULL THEN ? ELSE location END,
                company_id = CASE WHEN company_id IS NULL AND ? IS NOT NULL THEN ? ELSE company_id END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(
        extracted.job_title || null, extracted.job_title || null,
        extracted.phone || null, extracted.phone || null,
        extracted.linkedin_url || null, extracted.linkedin_url || null,
        extracted.location || null, extracted.location || null,
        companyIdForAssignment, companyIdForAssignment,
        match.matched_id, orgId
      ).run();
      await safelyMaintainContactReadModels(env, orgId, match.matched_id, 'document_contact_updated');
    }
    return { created: false, updated: hasUpdates, skipped: false, id: match.matched_id };
  }

  const email = extracted.email?.trim();
  if (!email) {
    return {
      created: false,
      updated: false,
      skipped: true,
      id: null,
      skip_reason: 'missing_email_for_new_contact',
    };
  }

  const contactId = crypto.randomUUID();
  const now = new Date().toISOString();

  const companyId: string | null = companyIdForAssignment;
  const contactGate = evaluateCrmQualityGate({
    entityType: 'contact',
    action: 'create',
    proposedName: extracted.full_name,
    email,
    source: {
      source_channel: 'document_intelligence',
      source_record_id: documentId,
      source_text: extracted.full_name,
      codepath: 'document_intelligence_route_contact',
    },
  });
  if (!contactGate.writeAllowed || !contactGate.normalizedName) {
    return {
      created: false,
      updated: false,
      skipped: true,
      id: null,
      skip_reason: 'crm_quality_gate_blocked',
    };
  }
  const customFields = crmQualityCustomFieldsForGate(contactGate);

  await env.D1.prepare(
    `INSERT INTO contacts
       (id, org_id, full_name, email, phone, job_title, linkedin_url, location, company_id,
        source, source_confidence, contact_type, custom_fields, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, 'individual', ?, ?, ?)`
  ).bind(
    contactId, orgId,
    contactGate.normalizedName,
    email,
    extracted.phone || null,
    extracted.job_title || null,
    extracted.linkedin_url || null,
    extracted.location || null,
    companyId,
    extracted.confidence,
    customFields,
    now, now
  ).run();

  await safelyMaintainContactReadModels(env, orgId, contactId, 'document_contact_created');

  return { created: true, updated: false, skipped: false, id: contactId };
}

async function routeCompany(
  extracted: ExtractedCompany,
  match: MatchedEntity,
  orgId: string,
  documentId: string,
  env: Env
): Promise<{ created: boolean; updated: boolean; id: string }> {
  const normalizedStage = normalizeCompanyStage(extracted.stage);
  if (match.matched_id && match.match_type !== 'new') {
    const valuation = extracted.valuation ? String(extracted.valuation) : null;
    const nameGate = extracted.name ? evaluateCrmQualityGate({
      entityType: 'company',
      action: 'update_name',
      proposedName: extracted.name,
      domain: extracted.domain || null,
      website: extracted.website || null,
      source: {
        source_channel: 'document_intelligence',
        source_record_id: documentId,
        source_text: extracted.name,
        codepath: 'document_intelligence_route_company_update',
      },
    }) : null;
    const safeName = nameGate?.writeAllowed && nameGate.normalizedName ? nameGate.normalizedName : null;
    const hasUpdates = !!(
      safeName ||
      extracted.sector ||
      extracted.website ||
      extracted.description ||
      extracted.location ||
      normalizedStage ||
      valuation
    );
    if (hasUpdates) {
      await env.D1.prepare(
        `UPDATE companies
            SET name = CASE
                  WHEN ? IS NOT NULL
                   AND (
                     name IS NULL
                     OR name = ''
                     OR LOWER(name) = LOWER(COALESCE(domain, ''))
                     OR (name NOT LIKE '% %' AND name LIKE '%.%')
                   )
                  THEN ?
                  ELSE name
                END,
                sector = CASE WHEN (sector IS NULL OR sector = '') AND ? IS NOT NULL THEN ? ELSE sector END,
                website = CASE WHEN (website IS NULL OR website = '') AND ? IS NOT NULL THEN ? ELSE website END,
                description = CASE WHEN (description IS NULL OR description = '') AND ? IS NOT NULL THEN ? ELSE description END,
                location_mentioned = CASE WHEN (location_mentioned IS NULL OR location_mentioned = '') AND ? IS NOT NULL THEN ? ELSE location_mentioned END,
                stage = CASE WHEN (stage IS NULL OR stage = '') AND ? IS NOT NULL THEN ? ELSE stage END,
                last_known_valuation = CASE WHEN last_known_valuation IS NULL AND ? IS NOT NULL THEN ? ELSE last_known_valuation END,
                last_known_valuation_seen_at = CASE WHEN last_known_valuation IS NULL AND ? IS NOT NULL THEN ? ELSE last_known_valuation_seen_at END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(
        safeName, safeName,
        extracted.sector || null, extracted.sector || null,
        extracted.website || null, extracted.website || null,
        extracted.description || null, extracted.description || null,
        extracted.location || null, extracted.location || null,
        normalizedStage || null, normalizedStage || null,
        valuation, valuation,
        valuation, valuation ? new Date().toISOString() : null,
        match.matched_id, orgId
      ).run();
    }
    return { created: false, updated: hasUpdates, id: match.matched_id };
  }

  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();
  const domain = normalizeLookupDomain(extracted.domain || extracted.website) || null;
  const website = extracted.website || (domain ? `https://${domain}` : null);
  const companyGate = evaluateCrmQualityGate({
    entityType: 'company',
    action: 'create',
    proposedName: extracted.name,
    domain,
    website,
    source: {
      source_channel: 'document_intelligence',
      source_record_id: documentId,
      source_text: extracted.name,
      codepath: 'document_intelligence_route_company_create',
    },
  });
  if (!companyGate.writeAllowed || !companyGate.normalizedName) {
    throw new Error(`CRM_QUALITY_GATE_BLOCKED:${companyGate.reasons.join('; ')}`);
  }
  const customFields = crmQualityCustomFieldsForGate(companyGate);

  try {
    await env.D1.prepare(
      `INSERT INTO companies
         (id, org_id, name, domain, website, sector, company_type, location_mentioned, description,
          stage, investment_status, last_known_valuation, last_known_valuation_seen_at, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracking', ?, ?, ?, ?, ?)`
    ).bind(
      companyId, orgId,
      companyGate.normalizedName,
      domain,
      website,
      extracted.sector || null,
      extracted.company_type || 'other',
      extracted.location || null,
      extracted.description || null,
      normalizedStage || null,
      extracted.valuation || null,
      extracted.valuation ? now : null,
      customFields,
      now, now
    ).run();
  } catch (e: any) {
    if (domain && String(e?.message || e).includes('UNIQUE constraint failed')) {
      const existing = await env.D1.prepare(
        'SELECT id FROM companies WHERE org_id = ? AND LOWER(domain) = ? AND deleted_at IS NULL LIMIT 1'
      ).bind(orgId, domain).first<{ id: string }>();
      if (existing) return { created: false, updated: false, id: existing.id };
    }
    throw e;
  }

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

  // Wave 1: refuse to import deals targeting internal Medina-side entities.
  if (companyId && await isCompanyInternal(companyId, orgId, env)) {
    console.warn(`[doc-intel] skipping deal import targeting internal company ${companyId}: ${extracted.name}`);
    return { created: false, id: '' };
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
  importJobId?: string,
  options: ImportProcessingOptions = {}
): Promise<ImportResult> {
  const errors: string[] = [];
  const startAt = Math.max(0, options.startAt || 0);
  const maxUnits = Math.max(1, options.maxUnits || Number.POSITIVE_INFINITY);
  let processedThisRun = 0;
  let unitIndex = 0;
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

  // Try to extract text. If the parser throws, persist as `'failed'` with
  // the error captured in documents.error_message — Wave 5 Phase A closes
  // the silent-fail class. Empty-but-no-throw text is still ingested as
  // `reference` with no entity payload (legitimate case for image-only
  // PDFs etc).
  let text = '';
  let extractionFailed = false;
  let extractionError: string | undefined;
  try {
    text = await extractTextFromFile(file);
  } catch (e: any) {
    extractionFailed = true;
    extractionError = String(e?.message || e);
    errors.push(`Text extraction: ${extractionError}`);
  }
  const hasUsableText = !!text && text.trim().length >= 20;
  if (!hasUsableText) {
    extractionFailed = true;
    if (!extractionError) {
      extractionError = isTextExtractionSupported(file)
        ? 'No readable text could be extracted from this file. The original file was stored, but no CRM records were created from its contents.'
        : textExtractionUnsupportedMessage(file);
      errors.push(`Text extraction: ${extractionError}`);
    }
  }

  // Wave 5 Phase C: cheap filename classifier first. high → skip LLM,
  // medium → pass as hint to LLM, null → LLM-only path. Even when text
  // is empty, classifier sees the filename and returns a category (or
  // `reference` on hard failure). Never throws.
  const cheap = classifyByFilename(file.name);
  let category: DocumentCategory;
  let classConfidence: number;
  if (cheap?.confidence === 'high') {
    category = cheap.category;
    classConfidence = 0.9;
    console.log(`[doc-intel] cheap=${cheap.category} (high) skip-llm "${file.name}"`);
  } else {
    const result = await classifyDocument(text, file.name, env, orgId, cheap);
    category = result.category;
    classConfidence = result.confidence;
    console.log(
      `[doc-intel] llm=${category} cheap=${cheap?.category || 'null'} (confidence: ${classConfidence}, text_extracted: ${hasUsableText}) "${file.name}"`
    );
  }

  // Run base + category-specific extraction. Empty text → empty result, no Claude call wasted.
  const extraction = await extractEntities(text, category, env, orgId);
  console.log(
    `[doc-intel] extracted: ${extraction.contacts.length} contacts, ${extraction.companies.length} companies, ${extraction.deals.length} deals`
  );

  let companiesCreated = 0;
  let companiesUpdated = 0;
  let contactsCreated = 0;
  let contactsUpdated = 0;
  let contactsSkipped = 0;
  let dealsCreated = 0;
  let processedUnits = startAt;
  let lastProgressAt = 0;
  const totalUnits = extraction.companies.length + extraction.contacts.length + extraction.deals.length + 1;
  let baseCreated = 0;
  let baseUpdated = 0;
  let baseSkipped = 0;
  let baseFailed = 0;

  if (importJobId && startAt > 0) {
    const existingProgress = await env.D1.prepare(
      `SELECT processed_rows, created_rows, updated_rows, skipped_rows, failed_rows
         FROM import_jobs
        WHERE id = ? AND org_id = ?
        LIMIT 1`
    ).bind(importJobId, orgId).first<ImportProgressRow>();
    baseCreated = existingProgress?.created_rows || 0;
    baseUpdated = existingProgress?.updated_rows || 0;
    baseSkipped = existingProgress?.skipped_rows || 0;
    baseFailed = existingProgress?.failed_rows || 0;
  }

  const ensureImportStillActive = async () => {
    if (!importJobId) return;
    const active = await env.D1.prepare(
      `SELECT status
         FROM work_queue
        WHERE domain = 'intelligent_import'
          AND payload LIKE ?
        ORDER BY created_at DESC
        LIMIT 1`
    ).bind(`%${importJobId}%`).first<{ status: string }>();
    if (active && !['pending', 'in_progress'].includes(active.status)) {
      throw new Error('Import job was cancelled or superseded');
    }
  };

  const updateImportProgress = async (force = false) => {
    if (!importJobId) return;
    const nowMs = Date.now();
    if (!force && nowMs - lastProgressAt < 5000) return;
    lastProgressAt = nowMs;
    await env.D1.prepare(
      `UPDATE import_jobs
          SET total_rows = ?,
              processed_rows = ?,
              created_rows = ?,
              updated_rows = ?,
              skipped_rows = ?,
              failed_rows = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      totalUnits,
      Math.min(processedUnits, totalUnits),
      baseCreated + contactsCreated + companiesCreated + dealsCreated,
      baseUpdated + contactsUpdated + companiesUpdated,
      baseSkipped + contactsSkipped,
      baseFailed + errors.length,
      importJobId,
      orgId
    ).run();
  };

  const markUnitProcessed = async (forceProgress = false) => {
    processedUnits++;
    processedThisRun++;
    if (processedUnits % 50 === 0) await ensureImportStillActive();
    await updateImportProgress(forceProgress);
  };

  const shouldPause = () => processedThisRun >= maxUnits && processedUnits < totalUnits;

  const partialResult = (currentDocumentId: string): ImportResult => {
    const totalRouted = contactsCreated + contactsUpdated + companiesCreated + companiesUpdated + dealsCreated;
    return {
      document_id: currentDocumentId,
      category,
      summary: extraction.summary,
      completed: false,
      next_start: processedUnits,
      total_units: totalUnits,
      contacts_created: contactsCreated,
      contacts_updated: contactsUpdated,
      contacts_skipped: contactsSkipped,
      companies_created: companiesCreated,
      companies_updated: companiesUpdated,
      deals_created: dealsCreated,
      relationships_found: extraction.relationships.length,
      signals_found: extraction.signals.length,
      entities_routed: totalRouted,
      errors,
      extraction: {
        contacts: [],
        companies: [],
        deals: [],
        relationships: [],
        signals: [],
      },
    };
  };

  await updateImportProgress(true);

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
    extractionError,
    embed: true,
  }, env);
  const documentId = persisted.documentId;
  await logCreated('document', documentId);

  // Make the document visible and queued for embedding before the slower CRM
  // routing begins. Imports should behave like durable document uploads even
  // if contact/company routing takes several minutes or is later cancelled.
  try {
    if (extractionError) {
      await env.D1.prepare(
        `UPDATE documents
            SET processing_status = 'failed',
                error_message = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(extractionError, documentId, orgId).run();
    } else {
      await env.D1.prepare(
        `UPDATE documents
            SET document_type = ?,
                extracted_text_preview = CASE
                  WHEN extracted_text_preview IS NULL OR extracted_text_preview = '' THEN ?
                  ELSE extracted_text_preview
                END,
                processing_status = 'completed',
                error_message = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(category, text.slice(0, 4000), documentId, orgId).run();

      await enqueueDocumentEmbeddingRepair(env, orgId, documentId, { priority: 30 });
    }
  } catch (e: any) {
    errors.push(`Document store: ${e?.message || e}`);
  } finally {
    if (unitIndex >= startAt) {
      await markUnitProcessed(true);
      if (shouldPause()) return partialResult(documentId);
    }
    unitIndex++;
  }

  // Match + Route companies first (contacts may reference them)
  const companyLookup = new Map<string, string>();
  const companyDomainLookup = new Map<string, string>();
  const companyCandidates = (await env.D1.prepare(
    'SELECT id, name, domain FROM companies WHERE org_id = ? AND deleted_at IS NULL LIMIT 10000'
  ).bind(orgId).all<ExistingCompanyRow>()).results;
  const companyByDomain = new Map<string, ExistingCompanyRow>();
  const companyByName = new Map<string, ExistingCompanyRow>();
  for (const company of companyCandidates) {
    const domain = normalizeLookupDomain(company.domain);
    if (domain) companyByDomain.set(domain, company);
    const name = normalizeLookupName(company.name);
    if (name && !companyByName.has(name)) companyByName.set(name, company);
  }

  for (const company of extraction.companies) {
    if (unitIndex < startAt) {
      const existingMatch = matchCompanyFromIndexes(company, companyCandidates, companyByDomain, companyByName);
      if (existingMatch.matched_id) {
        companyLookup.set(company.name.toLowerCase(), existingMatch.matched_id);
        const domain = normalizeLookupDomain(company.domain || company.website);
        if (domain) companyDomainLookup.set(domain, existingMatch.matched_id);
      }
      unitIndex++;
      continue;
    }
    try {
      const match = matchCompanyFromIndexes(company, companyCandidates, companyByDomain, companyByName);
      const result = await routeCompany(company, match, orgId, documentId, env);
      companyLookup.set(company.name.toLowerCase(), result.id);
      const domain = normalizeLookupDomain(company.domain || company.website);
      if (domain) companyDomainLookup.set(domain, result.id);
      if (result.created) {
        companiesCreated++;
        const candidate = { id: result.id, name: company.name, domain: domain || null };
        companyCandidates.push(candidate);
        if (domain) companyByDomain.set(domain, candidate);
        const name = normalizeLookupName(company.name);
        if (name) companyByName.set(name, candidate);
        await logCreated('company', result.id);
      }
      if (result.updated) companiesUpdated++;
    } catch (e: any) {
      errors.push(`Company "${company.name}": ${e.message}`);
    } finally {
      await markUnitProcessed();
      unitIndex++;
      if (shouldPause()) return partialResult(documentId);
    }
  }

  // Match + Route contacts
  const contactCandidates = (await env.D1.prepare(
    'SELECT id, full_name, email, phone, company_id FROM contacts WHERE org_id = ? AND deleted_at IS NULL LIMIT 20000'
  ).bind(orgId).all<ExistingContactRow>()).results;
  const contactByEmail = new Map<string, ExistingContactRow>();
  const contactByName = new Map<string, ExistingContactRow[]>();
  for (const contact of contactCandidates) {
    const email = contact.email?.toLowerCase().trim();
    if (email) contactByEmail.set(email, contact);
    const name = normalizeLookupName(contact.full_name);
    if (name) {
      const bucket = contactByName.get(name) || [];
      bucket.push(contact);
      contactByName.set(name, bucket);
    }
  }

  for (const contact of extraction.contacts) {
    if (unitIndex < startAt) {
      unitIndex++;
      continue;
    }
    try {
      let candidateCompanyId = contact.company_name ? companyLookup.get(contact.company_name.toLowerCase()) : null;
      if (!candidateCompanyId && contact.email) {
        const emailDomain = normalizeLookupDomain(contact.email.split('@')[1]);
        candidateCompanyId = companyDomainLookup.get(emailDomain) || null;
      }
      const preferredCompanyId = candidateCompanyId &&
        (await isVerifiedContactCompanyAffiliation(env, orgId, contact.email || null, candidateCompanyId)).verified
          ? candidateCompanyId
          : null;
      const match = matchContactFromIndexes(contact, contactCandidates, contactByEmail, contactByName, preferredCompanyId);
      const result = await routeContact(contact, match, orgId, documentId, env, preferredCompanyId);
      if (result.skipped) {
        contactsSkipped++;
      }
      if (result.created) {
        contactsCreated++;
        const candidate = {
          id: result.id!,
          full_name: contact.full_name,
          email: contact.email || null,
          phone: contact.phone || null,
          company_id: preferredCompanyId || null,
        };
        contactCandidates.push(candidate);
        const email = contact.email?.toLowerCase().trim();
        if (email) contactByEmail.set(email, candidate);
        const name = normalizeLookupName(contact.full_name);
        if (name) {
          const bucket = contactByName.get(name) || [];
          bucket.push(candidate);
          contactByName.set(name, bucket);
        }
        await logCreated('contact', result.id!);
      }
      if (result.updated) contactsUpdated++;

      if (contact.company_name && result.id) {
        const companyId = companyLookup.get(contact.company_name.toLowerCase());
        const verified = companyId
          ? await isVerifiedContactCompanyAffiliation(env, orgId, contact.email || null, companyId)
          : null;
        if (companyId && verified?.verified) {
          const sql = result.created
            ? 'UPDATE contacts SET company_id = ? WHERE id = ?'
            : 'UPDATE contacts SET company_id = ? WHERE id = ? AND company_id IS NULL';
          const assignment = await env.D1.prepare(sql).bind(companyId, result.id).run();
          if (assignment.meta?.changes) {
            await safelyMaintainContactReadModels(env, orgId, result.id, 'document_contact_company_linked');
          }
        }
      }
    } catch (e: any) {
      errors.push(`Contact "${contact.full_name}": ${e.message}`);
    } finally {
      await markUnitProcessed();
      unitIndex++;
      if (shouldPause()) return partialResult(documentId);
    }
  }

  // Route deals
  for (const deal of extraction.deals) {
    if (unitIndex < startAt) {
      unitIndex++;
      continue;
    }
    try {
      const result = await routeDeal(deal, companyLookup, orgId, env);
      if (result.created) { dealsCreated++; await logCreated('deal', result.id); }
    } catch (e: any) {
      errors.push(`Deal "${deal.name}": ${e.message}`);
    } finally {
      await markUnitProcessed();
      unitIndex++;
      if (shouldPause()) return partialResult(documentId);
    }
  }

  // Audit
  await updateImportProgress(true);

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
      contacts_skipped: contactsSkipped,
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
    completed: true,
    total_units: totalUnits,
    contacts_created: contactsCreated,
    contacts_updated: contactsUpdated,
    contacts_skipped: contactsSkipped,
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

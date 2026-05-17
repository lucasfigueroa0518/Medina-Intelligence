import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { buildSourcesAndContext } from './citations';
import { extractTextFromFile } from './file-extraction';
import { getSharingFlags } from './helpers';
import { isDocumentAccessibleToUser } from './document-acl';
import { persistDocument, type DocumentLink, type DocumentVisibility } from './persist-document';
import { preprocessQuery, retrieveContext } from './retrieval';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
import { enqueueWork } from './work-queue';

export type MartyDocumentCardMode = 'compact' | 'dominant';
export type ArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'pdf';
export type DeckStylePackId = 'medina_default' | 'banker_clean' | 'consulting_editorial' | 'founder_story' | 'lp_report';
export type DeckObjective = 'inform' | 'persuade' | 'decide' | 'update' | 'sell';
export type DeckQaStatus = 'pass' | 'needs_revision' | 'failed';
export type DeckQaSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface DeckFact {
  id: string;
  claim: string;
  value?: string | number;
  sourceIds: string[];
  confidence: 'confirmed' | 'probable' | 'needs_review';
  use: 'headline' | 'chart' | 'table' | 'speaker_note' | 'appendix';
}

export interface DeckStylePack {
  id: DeckStylePackId;
  name: string;
  audienceFit: string[];
  palette: string[];
  typography: {
    display: string;
    body: string;
    mono?: string;
  };
  layoutGrid: 'editorial' | 'banker' | 'consulting' | 'product' | 'board';
  density: 'sparse' | 'balanced' | 'dense';
  motifs: string[];
}

export interface SlideSpec {
  id: string;
  role: string;
  headline: string;
  layout: string;
  facts: string[];
  visualIntent: string;
  speakerNotes?: string;
}

export interface DeckPlan {
  title: string;
  audience: string;
  objective: DeckObjective;
  storyline: string[];
  style_pack: DeckStylePackId;
  slides: SlideSpec[];
  facts: DeckFact[];
}

export interface DeckQaReport {
  status: DeckQaStatus;
  slideFindings: {
    slideId: string;
    severity: DeckQaSeverity;
    issue: string;
    requiredFix: string;
  }[];
  checks: {
    slide_count: number;
    visual_surface_count: number;
    average_words_per_slide: number;
    max_words_on_slide: number;
    accent_gutter_px: number;
    html_bytes: number;
  };
}

export type DeckJobStatus = 'queued' | 'running' | 'revising' | 'qa_blocked' | 'completed' | 'failed' | 'cancelled';
export type DeckJobPhase =
  | 'planning'
  | 'research'
  | 'narrative'
  | 'visual_direction'
  | 'html_render'
  | 'render_qa'
  | 'repair'
  | 'export'
  | 'complete'
  | 'qa_blocked'
  | 'failed';

export interface DeckScreenshot {
  slideId: string;
  index: number;
  fileName: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  base64?: string;
  document_id?: string;
}

export interface DeckVisualQaFinding {
  slideId: string;
  severity: DeckQaSeverity;
  issue: string;
  requiredFix: string;
}

export interface DeckRenderRequest {
  job_id: string;
  title: string;
  html: string;
  style_pack: DeckStylePackId;
  quality_mode: 'fast' | 'premium';
  output_formats: Array<'html' | 'pdf' | 'pptx'>;
  plan: DeckPlan;
  qa_report: DeckQaReport;
}

export interface DeckRenderResult {
  job_id: string;
  status: DeckQaStatus;
  qa_report: DeckQaReport;
  screenshots?: DeckScreenshot[];
  pdf_base64?: string;
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface DeckRepairPatch {
  slide_patches?: Array<{
    slideId: string;
    headline?: string;
    layout?: string;
    visualIntent?: string;
    body?: string;
    bullets?: string[];
  }>;
  style_patch?: Record<string, unknown>;
  rationale?: string;
}

export interface MartyDocumentCard {
  document_id: string;
  title: string;
  file_name: string | null;
  mime_type: string | null;
  document_type: string;
  mode: MartyDocumentCardMode;
  reason?: string;
  excerpt?: string;
  confidence?: number;
  source?: string | null;
  date?: string | null;
  actions: {
    preview: boolean;
    download: boolean;
    send_to_marty: boolean;
  };
  generated?: boolean;
}

interface DocumentRow {
  id: string;
  title: string;
  document_type: string;
  source: string | null;
  r2_key: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  extracted_text_preview: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  uploaded_by: string | null;
  visibility: string | null;
  participant_user_ids: string | null;
  parent_document_id: string | null;
  version_number: number | null;
  created_at: string | null;
}

type DocumentMatch = {
  doc: DocumentRow;
  confidence: number;
  reason: string;
  excerpt?: string;
};

const DOCUMENT_DOC_TYPES = [
  'document',
  'pitch_deck',
  'deal_pitch',
  'deal_terms',
  'deal_financials',
  'deal_diligence',
  'reference',
  'internal_ops',
  'meeting_material',
  'contact_data',
  'fund_legal',
  'memo',
  'report',
  'spreadsheet',
  'presentation',
  'legal',
  'financials',
  'other',
];

const MIME_BY_KIND: Record<ArtifactKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

const DECK_HTML_MIME = 'text/html; charset=utf-8';
export const DECK_RENDER_WORK_DOMAIN = 'deck_render';

const DECK_STYLE_PACKS: Record<DeckStylePackId, DeckStylePack> = {
  medina_default: {
    id: 'medina_default',
    name: 'Medina Ventures Default',
    audienceFit: ['internal IC', 'board', 'portfolio', 'diligence', 'weekly recap'],
    palette: ['#08080D', '#12121A', '#F8FAFC', '#D946A8', '#8B5CF6', '#38BDF8'],
    typography: { display: 'DM Sans', body: 'Inter', mono: 'JetBrains Mono' },
    layoutGrid: 'editorial',
    density: 'balanced',
    motifs: ['offset-magenta-rule', 'quiet-dark-panels', 'evidence-led-layouts'],
  },
  banker_clean: {
    id: 'banker_clean',
    name: 'Banker Clean',
    audienceFit: ['IC', 'board', 'LP', 'transaction committee'],
    palette: ['#FFFFFF', '#F4F5F7', '#111827', '#1D4ED8', '#64748B', '#A855F7'],
    typography: { display: 'Aptos Display', body: 'Aptos', mono: 'Aptos Mono' },
    layoutGrid: 'banker',
    density: 'dense',
    motifs: ['tight-exhibit-headlines', 'thin-rules', 'source-footers'],
  },
  consulting_editorial: {
    id: 'consulting_editorial',
    name: 'Consulting Editorial',
    audienceFit: ['strategy', 'operating review', 'market analysis', 'board'],
    palette: ['#FBFBFC', '#ECEFF3', '#101828', '#334155', '#2563EB', '#E11D48'],
    typography: { display: 'Aptos Display', body: 'Aptos' },
    layoutGrid: 'consulting',
    density: 'balanced',
    motifs: ['so-what-headlines', 'exhibit-labels', 'structured-white-space'],
  },
  founder_story: {
    id: 'founder_story',
    name: 'Founder Story',
    audienceFit: ['founder', 'sales', 'external narrative', 'pitch'],
    palette: ['#111827', '#192132', '#F8FAFC', '#22D3EE', '#F97316', '#FACC15'],
    typography: { display: 'DM Sans', body: 'Inter' },
    layoutGrid: 'product',
    density: 'sparse',
    motifs: ['hero-claims', 'product-panels', 'momentum-metrics'],
  },
  lp_report: {
    id: 'lp_report',
    name: 'LP Report',
    audienceFit: ['LP', 'quarterly update', 'investor update'],
    palette: ['#F8F7F4', '#E8E1D7', '#151515', '#6D28D9', '#0F766E', '#9A3412'],
    typography: { display: 'Aptos Display', body: 'Aptos' },
    layoutGrid: 'board',
    density: 'balanced',
    motifs: ['folio-markers', 'calm-evidence', 'portfolio-summary-bands'],
  },
};

const DECK_ACCENT_GUTTER_PX = 104;
const DECK_SAFE_MARGIN_PX = 64;
const DECK_GRID_GAP_PX = 40;
const DECK_TEXT_MAX_WIDTH_PX = 900;
const DECK_FOOTER_RESERVED_PX = 54;
const DECK_MIN_CONTRAST_RATIO = 3.8;
const DECK_RENDERER_TIMEOUT_MS = 90_000;
const DECK_RENDER_VIEWPORT = { width: 1920, height: 1080 };
const DECK_RENDER_MAX_REPAIR_PASSES = 3;
const MAX_DECK_REVISION_ROUNDS = 3;
const DECK_ALLOWED_OUTPUT_FORMATS = new Set(['html', 'pdf', 'pptx']);

const DOCX_PAGE_MARGIN_DXA = 1080;
const DOCX_TABLE_WIDTH_DXA = 9360;
const DOCX_CALLOUT_INDENT_DXA = 540;
const DOCX_CALLOUT_BORDER_SPACE = 14;

function clampLimit(limit: unknown, fallback = 8): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), 20);
}

function isDeckRendererEnabled(env: Env): boolean {
  if (env.DECK_RENDERER_ENABLED !== 'true') return false;
  if ((env.DECK_RENDERER_PROVIDER || '').toLowerCase() === 'cloudflare') return Boolean(env.BROWSER);
  return Boolean(env.DECK_RENDERER_URL && env.DECK_RENDERER_TOKEN);
}

function useCloudflareDeckRenderer(env: Env): boolean {
  return env.DECK_RENDERER_ENABLED === 'true'
    && (env.DECK_RENDERER_PROVIDER || '').toLowerCase() === 'cloudflare'
    && Boolean(env.BROWSER);
}

function normalizeDeckOutputFormats(value: unknown): Array<'html' | 'pdf' | 'pptx'> {
  const raw = Array.isArray(value) ? value : ['html', 'pdf', 'pptx'];
  const formats = raw
    .map(v => String(v || '').toLowerCase())
    .filter((v): v is 'html' | 'pdf' | 'pptx' => DECK_ALLOWED_OUTPUT_FORMATS.has(v));
  return formats.length > 0 ? [...new Set(formats)] : ['html', 'pdf', 'pptx'];
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed as T;
  } catch {
    return fallback;
  }
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function deckQaSeverityRank(severity: DeckQaSeverity): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[severity] || 0;
}

function mergeDeckQaReport(
  baseQa: DeckQaReport,
  findings: DeckQaReport['slideFindings'],
  metrics: Record<string, unknown>
): DeckQaReport {
  const seen = new Set<string>();
  const merged: DeckQaReport['slideFindings'] = [];
  for (const finding of [...(baseQa.slideFindings || []), ...findings]) {
    const key = `${finding.slideId}|${finding.severity}|${finding.issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  const maxSeverity = merged.reduce((max, item) => Math.max(max, deckQaSeverityRank(item.severity)), 0);
  return {
    status: maxSeverity >= 4 ? 'failed' : maxSeverity >= 3 ? 'needs_revision' : 'pass',
    slideFindings: merged,
    checks: {
      ...(baseQa.checks || {}),
      ...(metrics as any),
    },
  };
}

async function appendDeckJobEvent(
  env: Env,
  jobId: string,
  orgId: string,
  eventType: string,
  payload: unknown
): Promise<number> {
  const seqRow = await env.D1.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM deck_artifact_job_events
      WHERE job_id = ?`
  ).bind(jobId).first<{ next_seq: number }>();
  const seq = Number(seqRow?.next_seq || 1);
  await env.D1.prepare(
    `INSERT INTO deck_artifact_job_events
       (id, job_id, org_id, seq, event_type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    jobId,
    orgId,
    seq,
    eventType,
    JSON.stringify(payload ?? {})
  ).run();
  await env.D1.prepare(
    `UPDATE deck_artifact_jobs
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(jobId).run().catch(() => {});
  return seq;
}

async function updateDeckJobPhase(
  env: Env,
  jobId: string,
  orgId: string,
  phase: DeckJobPhase,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const status: DeckJobStatus =
    phase === 'repair' ? 'revising'
      : phase === 'qa_blocked' ? 'qa_blocked'
        : phase === 'failed' ? 'failed'
          : phase === 'complete' ? 'completed'
            : 'running';
  await env.D1.prepare(
    `UPDATE deck_artifact_jobs
        SET status = ?,
            phase = ?,
            heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(status, phase, jobId, orgId).run().catch(() => {});
  await appendDeckJobEvent(env, jobId, orgId, 'phase', {
    status,
    phase,
    max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
    ...payload,
  }).catch(() => {});
}

const DOCUMENT_QUERY_STOPWORDS = new Set([
  'pull', 'show', 'open', 'find', 'surface', 'preview', 'download', 'send',
  'please', 'need', 'want', 'give', 'bring', 'forward', 'from', 'with', 'into',
  'this', 'that', 'these', 'those', 'the', 'and', 'for', 'about', 'document',
  'documents', 'doc', 'docs', 'file', 'files',
]);

const DOCUMENT_KIND_TERMS = new Set([
  'deck', 'decks', 'presentation', 'presentations', 'ppt', 'pptx', 'powerpoint',
  'pdf', 'memo', 'model', 'spreadsheet', 'excel', 'xlsx', 'docx', 'word',
]);

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function wantsSingleDocument(query: string): boolean {
  const lower = query.toLowerCase();
  if (/\b(all|any|several|multiple|many|list|related|relevant|every|set|materials|packet|folder)\b/.test(lower)) return false;
  if (/\b(documents|docs|files|decks|presentations|attachments|materials)\b/.test(lower)) return false;
  return /\b(pull up|open|show me|preview|download|send)\b/.test(lower)
    && /\b(deck|document|doc|file|pdf|pptx|powerpoint|spreadsheet|xlsx|excel|memo)\b/.test(lower);
}

function normalizeMode(mode: unknown, query: string): MartyDocumentCardMode {
  if (mode === 'compact' || mode === 'dominant') return mode;
  return /\b(show|open|find|pull|surface|preview|download|send|work with|edit|create|prepare|deck|doc|document|pdf|spreadsheet|powerpoint|excel)\b/i.test(query)
    ? 'dominant'
    : 'compact';
}

function cardFromDoc(
  doc: DocumentRow,
  mode: MartyDocumentCardMode,
  opts: { reason?: string; excerpt?: string; confidence?: number; generated?: boolean } = {}
): MartyDocumentCard {
  const hasBinary = Boolean(doc.r2_key);
  const hasPreview = hasBinary || Boolean((doc.extracted_text_preview || opts.excerpt || '').trim());
  return {
    document_id: doc.id,
    title: doc.title || doc.file_name || 'Document',
    file_name: doc.file_name,
    mime_type: doc.mime_type,
    document_type: doc.document_type || 'other',
    mode,
    reason: opts.reason,
    excerpt: opts.excerpt || doc.extracted_text_preview || undefined,
    confidence: opts.confidence,
    source: doc.source,
    date: doc.created_at,
    actions: {
      preview: hasPreview,
      download: hasBinary,
      send_to_marty: hasBinary,
    },
    generated: opts.generated,
  };
}

export function normalizeDocumentCards(input: unknown): MartyDocumentCard[] {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Map<string, MartyDocumentCard>();
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const anyCard = c as Partial<MartyDocumentCard>;
    if (!anyCard.document_id || !anyCard.title) continue;
    const mode: MartyDocumentCardMode = anyCard.mode === 'dominant' ? 'dominant' : 'compact';
    const existing = seen.get(anyCard.document_id);
    const card: MartyDocumentCard = {
      document_id: anyCard.document_id,
      title: anyCard.title,
      file_name: anyCard.file_name ?? null,
      mime_type: anyCard.mime_type ?? null,
      document_type: anyCard.document_type || 'other',
      mode: existing?.mode === 'dominant' || mode === 'dominant' ? 'dominant' : 'compact',
      reason: anyCard.reason || existing?.reason,
      excerpt: anyCard.excerpt || existing?.excerpt,
      confidence: typeof anyCard.confidence === 'number' ? anyCard.confidence : existing?.confidence,
      source: anyCard.source ?? existing?.source ?? null,
      date: anyCard.date ?? existing?.date ?? null,
      actions: {
        preview: anyCard.actions?.preview !== false,
        download: anyCard.actions?.download !== false,
        send_to_marty: anyCard.actions?.send_to_marty !== false,
      },
      generated: Boolean(anyCard.generated || existing?.generated),
    };
    seen.set(card.document_id, card);
  }
  return [...seen.values()];
}

function mergeCards(cards: MartyDocumentCard[]): MartyDocumentCard[] {
  return normalizeDocumentCards(cards);
}

function tokenizeRaw(query: string): string[] {
  const base = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 3)
    .slice(0, 12);
  const joined: string[] = [];
  for (let i = 0; i < base.length - 1; i++) {
    const a = base[i];
    const b = base[i + 1];
    if (!DOCUMENT_QUERY_STOPWORDS.has(a) && !DOCUMENT_QUERY_STOPWORDS.has(b)) {
      joined.push(`${a}${b}`);
    }
  }
  return [...new Set([...base, ...joined])];
}

function tokenizeQuery(query: string): string[] {
  return tokenizeRaw(query)
    .filter(t => !DOCUMENT_QUERY_STOPWORDS.has(t))
    .slice(0, 10);
}

function importantQueryTerms(query: string): string[] {
  const terms = tokenizeQuery(query)
    .filter(t => !DOCUMENT_KIND_TERMS.has(t));
  return terms.length > 0 ? terms : tokenizeQuery(query);
}

function scoreTitleMatch(doc: DocumentRow, query: string, terms: string[]): number {
  const haystack = `${doc.title || ''} ${doc.file_name || ''}`.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!haystack || !q) return 0;
  const important = importantQueryTerms(query);
  const compactHaystack = compactText(haystack);
  const compactImportantQuery = important.map(compactText).join('');
  const compactFullQuery = compactText(terms.join(' '));
  if (compactImportantQuery && compactHaystack.includes(compactImportantQuery)) return 0.97;
  if (compactFullQuery && compactHaystack.includes(compactFullQuery)) return 0.95;

  const hits = important.filter(t => {
    const compactTerm = compactText(t);
    return haystack.includes(t) || (!!compactTerm && compactHaystack.includes(compactTerm));
  }).length;
  if (hits === 0) return 0;
  const coverage = hits / Math.max(important.length, 1);
  const asksForDeck = /\b(deck|presentation|ppt|pptx|powerpoint)\b/i.test(query);
  const looksLikeDeck = /\b(deck|presentation|pptx|powerpoint)\b/i.test(haystack)
    || ['pitch_deck', 'deal_pitch', 'meeting_material', 'presentation'].includes(doc.document_type || '');
  const kindBoost = asksForDeck && looksLikeDeck ? 0.06 : 0;
  const exactEntityBoost = coverage === 1 && important.length >= 2 ? 0.08 : 0;
  return Math.min(0.94, 0.42 + coverage * 0.38 + kindBoost + exactEntityBoost);
}

function canonicalDocumentKey(doc: DocumentRow): string {
  if (doc.parent_document_id) return `parent:${doc.parent_document_id}`;
  const raw = (doc.file_name || doc.title || doc.id)
    .toLowerCase()
    .replace(/\.(pdf|pptx?|docx?|xlsx?|csv)$/i, '')
    .replace(/\b(copy|final|draft|execution copy|redline|signed)\b/g, '')
    .replace(/\bv(?:ersion)?[\s_-]?\d+\b/g, '')
    .replace(/[_\-\s]*\(\d+\)\s*/g, ' ')
    .replace(/\b\d{4}[-_ ]?\d{2}[-_ ]?\d{2}\b/g, '')
    .replace(/\b\d{8}\b/g, '')
    .replace(/\b\d{1,2}[-_ ]\d{1,2}[-_ ]\d{2,4}\b/g, '');
  const compact = compactText(raw);
  return compact ? `title:${compact}` : `id:${doc.id}`;
}

function documentActionScore(doc: DocumentRow): number {
  let score = 0;
  if (doc.r2_key) score += 4;
  if ((doc.extracted_text_preview || '').trim()) score += 2;
  if (doc.mime_type?.includes('presentation') || /\.(pptx?|pdf)$/i.test(doc.file_name || '')) score += 1;
  return score;
}

function collapseNearDuplicateMatches(matches: DocumentMatch[]): { matches: DocumentMatch[]; collapsed: number } {
  const byKey = new Map<string, DocumentMatch>();
  let collapsed = 0;
  for (const match of matches) {
    const key = canonicalDocumentKey(match.doc);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, match);
      continue;
    }
    collapsed++;
    const existingScore = existing.confidence + documentActionScore(existing.doc) * 0.01;
    const nextScore = match.confidence + documentActionScore(match.doc) * 0.01;
    if (nextScore > existingScore) byKey.set(key, match);
  }
  return { matches: [...byKey.values()], collapsed };
}

async function sharingSetFor(ctx: AuthContext, env: Env): Promise<Set<string>> {
  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  return new Set(Object.keys(sharingFlags));
}

async function loadAccessibleDocuments(
  ids: string[],
  ctx: AuthContext,
  env: Env
): Promise<DocumentRow[]> {
  if (ids.length === 0) return [];
  const uniqueIds = [...new Set(ids)].slice(0, 50);
  const ph = uniqueIds.map(() => '?').join(',');
  const rows = await env.D1.prepare(
    `SELECT id, title, document_type, source, r2_key, file_name, file_size, mime_type,
            extracted_text_preview, contact_id, company_id, deal_id, uploaded_by,
            visibility, participant_user_ids, parent_document_id, version_number, created_at
       FROM documents
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND processing_status != 'excluded'
        AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1
        AND id IN (${ph})`
  ).bind(ctx.orgId, ...uniqueIds).all<DocumentRow>();
  const sharingSet = await sharingSetFor(ctx, env);
  return rows.results.filter(doc => isDocumentAccessibleToUser(doc, ctx.userId, ctx.userRole, sharingSet));
}

async function searchDocumentsByTitle(
  query: string,
  documentTypes: string[],
  entityIds: string[],
  limit: number,
  ctx: AuthContext,
  env: Env
): Promise<DocumentMatch[]> {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const where = [
    'd.org_id = ?',
    'd.deleted_at IS NULL',
    "d.processing_status != 'excluded'",
    "COALESCE(json_extract(d.custom_fields, '$.marty_lab_generated'), 0) != 1",
  ];
  const binds: any[] = [ctx.orgId];
  const likeClauses = terms.map(() => '(lower(d.title) LIKE ? OR lower(d.file_name) LIKE ?)');
  where.push(`(${likeClauses.join(' OR ')})`);
  for (const term of terms) {
    binds.push(`%${term}%`, `%${term}%`);
  }
  if (documentTypes.length > 0) {
    where.push(`d.document_type IN (${documentTypes.map(() => '?').join(',')})`);
    binds.push(...documentTypes);
  }
  if (entityIds.length > 0) {
    where.push(
      `EXISTS (
         SELECT 1 FROM document_links dl
          WHERE dl.document_id = d.id
            AND dl.org_id = d.org_id
            AND dl.deleted_at IS NULL
            AND dl.entity_id IN (${entityIds.map(() => '?').join(',')})
       )`
    );
    binds.push(...entityIds);
  }

  const rows = await env.D1.prepare(
    `SELECT d.id, d.title, d.document_type, d.source, d.r2_key, d.file_name, d.file_size, d.mime_type,
            d.extracted_text_preview, d.contact_id, d.company_id, d.deal_id, d.uploaded_by,
            d.visibility, d.participant_user_ids, d.parent_document_id, d.version_number, d.created_at
       FROM documents d
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT ?`
  ).bind(...binds, Math.max(limit * 3, 12)).all<DocumentRow>();

  const sharingSet = await sharingSetFor(ctx, env);
  return rows.results
    .filter(doc => isDocumentAccessibleToUser(doc, ctx.userId, ctx.userRole, sharingSet))
    .map(doc => ({
      doc,
      confidence: scoreTitleMatch(doc, query, terms),
      reason: 'Matched document title or filename',
    }))
    .filter(r => r.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

async function searchDocumentsByVector(
  query: string,
  documentTypes: string[],
  limit: number,
  ctx: AuthContext,
  env: Env
): Promise<DocumentMatch[]> {
  const session: AgentSession = {
    id: `find-docs-${ctx.userId}-${Date.now()}`,
    org_id: ctx.orgId,
    user_id: ctx.userId,
    user_role: ctx.userRole,
    turn_count: 0,
    last_activity_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
  const pq = await preprocessQuery(query, session, env, {});
  const forceDocTypes = documentTypes.length > 0 ? documentTypes : ['document'];
  const result = await retrieveContext(pq, env, { forceDocTypes });
  const { sources } = await buildSourcesAndContext(result.internal, [], undefined, ctx.orgId, env, query);
  const docSources = sources.filter(s => s.type === 'document').slice(0, Math.max(limit * 2, 8));
  const docs = await loadAccessibleDocuments(docSources.map(s => s.source_id), ctx, env);
  const byId = new Map(docs.map(d => [d.id, d]));
  return docSources
    .map<DocumentMatch | null>((source, index) => {
      const doc = byId.get(source.source_id);
      if (!doc) return null;
      return {
        doc,
        confidence: Math.max(0.55, 0.92 - index * 0.04),
        reason: 'Matched document content',
        excerpt: source.excerpt,
      };
    })
    .filter((x): x is DocumentMatch => Boolean(x));
}

export async function findDocumentsTool(
  ctx: AuthContext,
  input: {
    query: string;
    document_types?: string[];
    entity_ids?: string[];
    limit?: number;
    mode?: 'auto' | MartyDocumentCardMode;
  },
  env: Env
): Promise<any> {
  const query = String(input.query || '').trim();
  if (!query) return { count: 0, documents: [], document_cards: [], message: 'query is required' };

  const singleDocumentRequest = wantsSingleDocument(query);
  const limit = singleDocumentRequest
    ? 1
    : clampLimit(input.limit, 6);
  const requestedTypes = Array.isArray(input.document_types)
    ? input.document_types.filter(t => typeof t === 'string' && t.trim())
    : [];
  const documentTypes = requestedTypes.length > 0 ? requestedTypes : [];
  const entityIds = Array.isArray(input.entity_ids)
    ? input.entity_ids.filter(t => typeof t === 'string' && t.trim()).slice(0, 10)
    : [];
  const mode = normalizeMode(input.mode, query);
  const minConfidence = mode === 'dominant' ? 0.64 : 0.8;

  const [titleMatches, vectorMatches] = await Promise.all([
    searchDocumentsByTitle(query, documentTypes, entityIds, limit, ctx, env),
    searchDocumentsByVector(query, documentTypes.length > 0 ? documentTypes : DOCUMENT_DOC_TYPES, limit, ctx, env).catch(e => {
      console.warn('[find_documents] vector search failed:', e?.message || e);
      return [];
    }),
  ]);

  const merged = new Map<string, { doc: DocumentRow; confidence: number; reason: string; excerpt?: string }>();
  for (const match of [...titleMatches, ...vectorMatches]) {
    const existing = merged.get(match.doc.id);
    if (!existing || match.confidence > existing.confidence) merged.set(match.doc.id, match);
  }
  const filteredMatches = [...merged.values()]
    .filter(m => m.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
  const deduped = collapseNearDuplicateMatches(filteredMatches);
  const matches = deduped.matches
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  const cards = mergeCards(matches.map(m => cardFromDoc(m.doc, mode, {
    reason: m.reason,
    excerpt: m.excerpt,
    confidence: Number(m.confidence.toFixed(2)),
  })));

  console.log('[find_documents]', JSON.stringify({
    query,
    mode,
    single_document_request: singleDocumentRequest,
    requested_limit: input.limit ?? null,
    effective_limit: limit,
    title_matches: titleMatches.length,
    vector_matches: vectorMatches.length,
    above_threshold: filteredMatches.length,
    collapsed_duplicates: deduped.collapsed,
    returned: cards.length,
    returned_titles: cards.map(c => c.title).slice(0, 5),
  }));

  return {
    count: cards.length,
    documents: cards.map(c => ({
      document_id: c.document_id,
      title: c.title,
      file_name: c.file_name,
      mime_type: c.mime_type,
      document_type: c.document_type,
      source: c.source,
      date: c.date,
      excerpt: c.excerpt,
      confidence: c.confidence,
      actions: c.actions,
    })),
    document_cards: cards,
    diagnostics: {
      single_document_request: singleDocumentRequest,
      min_confidence: minConfidence,
      title_matches: titleMatches.length,
      vector_matches: vectorMatches.length,
      above_threshold: filteredMatches.length,
      collapsed_duplicates: deduped.collapsed,
    },
    note: cards.length === 0
      ? 'No sufficiently relevant accessible permanent Documents row found. The file may only exist as a cited source or chat/session attachment, may lack extraction or document embeddings, or may not have an original binary in Documents yet.'
      : undefined,
  };
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function cleanArtifactText(value: any): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeStructuredArtifactContent(content: any): any {
  if (typeof content === 'string') {
    return {
      summary: content,
      sections: [{ heading: 'Draft', paragraphs: [content] }],
    };
  }
  if (!content || typeof content !== 'object') return {};
  return content;
}

function firstNonEmpty(...values: any[]): string {
  for (const value of values) {
    const text = cleanArtifactText(value);
    if (text) return text;
  }
  return '';
}

function tableFromAny(value: any): { title?: string; headers: string[]; rows: any[][] } | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const rows = value.filter(Array.isArray);
    if (rows.length === 0) return null;
    return { headers: rows[0].map(cleanArtifactText), rows: rows.slice(1) };
  }
  const headers = asArray(value.headers || value.columns).map(cleanArtifactText).filter(Boolean);
  const rawRows = asArray(value.rows);
  if (headers.length === 0 && rawRows.length === 0) return null;
  const rows = rawRows.map(row => {
    if (Array.isArray(row)) return row;
    if (row && typeof row === 'object') {
      const keys = headers.length > 0 ? headers : Object.keys(row);
      return keys.map(k => row[k]);
    }
    return [row];
  });
  return {
    title: cleanArtifactText(value.title || value.caption) || undefined,
    headers: headers.length > 0 ? headers : rows[0]?.map((_, i) => `Column ${i + 1}`) || [],
    rows,
  };
}

function tablesFrom(value: any): Array<{ title?: string; headers: string[]; rows: any[][] }> {
  return asArray(value).map(tableFromAny).filter((t): t is { title?: string; headers: string[]; rows: any[][] } => Boolean(t));
}

function slideTables(slide: any): Array<{ title?: string; headers: string[]; rows: any[][] }> {
  return [
    ...tablesFrom(slide?.tables),
    ...tablesFrom(slide?.table ? [slide.table] : []),
  ];
}

function slideEvidenceBlocks(slide: any): string[] {
  return [
    ...asArray(slide?.evidence_blocks),
    ...asArray(slide?.evidence),
    ...asArray(slide?.proof_points),
  ].map((item: any) => {
    if (typeof item === 'string') return cleanArtifactText(item);
    if (item && typeof item === 'object') {
      return cleanArtifactText(firstNonEmpty(item.headline, item.title, item.label, item.value, item.text, item.detail));
    }
    return cleanArtifactText(item);
  }).filter(Boolean);
}

function plainTextFromStructured(content: any): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const parts: string[] = [];
  if (content.title) parts.push(String(content.title));
  if (content.subtitle) parts.push(String(content.subtitle));
  if (content.summary) parts.push(String(content.summary));
  for (const m of asArray(content.metadata)) {
    if (m?.label || m?.key || m?.value) parts.push(`${m.label || m.key || 'Field'}: ${m.value || ''}`);
  }
  for (const p of asArray(content.paragraphs)) parts.push(String(p));
  for (const b of asArray(content.bullets)) parts.push(`- ${String(b)}`);
  for (const b of asArray(content.key_points)) parts.push(`- ${String(b)}`);
  for (const b of asArray(content.recommendations)) parts.push(`- ${String(b)}`);
  for (const table of tablesFrom(content.tables)) {
    if (table.title) parts.push(table.title);
    if (table.headers.length > 0) parts.push(table.headers.join(' | '));
    for (const row of table.rows) parts.push(row.map(cleanArtifactText).join(' | '));
  }
  for (const s of asArray(content.sections)) {
    if (s?.heading) parts.push(String(s.heading));
    if (s?.summary) parts.push(String(s.summary));
    for (const p of asArray(s?.paragraphs)) parts.push(String(p));
    for (const b of asArray(s?.bullets)) parts.push(`- ${String(b)}`);
    for (const b of asArray(s?.numbered)) parts.push(String(b));
    for (const b of asArray(s?.checklist)) parts.push(`[ ] ${String(b)}`);
    for (const table of tablesFrom(s?.tables || s?.table)) {
      if (table.title) parts.push(table.title);
      if (table.headers.length > 0) parts.push(table.headers.join(' | '));
      for (const row of table.rows) parts.push(row.map(cleanArtifactText).join(' | '));
    }
  }
  for (const slide of asArray(content.slides)) {
    if (slide?.title) parts.push(String(slide.title));
    if (slide?.headline) parts.push(String(slide.headline));
    if (slide?.takeaway) parts.push(String(slide.takeaway));
    if (slide?.subtitle) parts.push(String(slide.subtitle));
    if (slide?.body) parts.push(String(slide.body));
    for (const b of asArray(slide?.bullets)) parts.push(`- ${String(b)}`);
    for (const e of slideEvidenceBlocks(slide)) parts.push(`Evidence: ${e}`);
    for (const table of slideTables(slide)) {
      if (table.title) parts.push(table.title);
      if (table.headers.length > 0) parts.push(table.headers.join(' | '));
      for (const row of table.rows) parts.push(row.map(cleanArtifactText).join(' | '));
    }
    if (slide?.speaker_notes) parts.push(String(slide.speaker_notes));
  }
  for (const sheet of asArray(content.sheets)) {
    if (sheet?.name) parts.push(`Sheet: ${sheet.name}`);
    if (sheet?.title) parts.push(String(sheet.title));
    for (const row of asArray(sheet?.rows)) parts.push(Array.isArray(row) ? row.join(', ') : JSON.stringify(row));
  }
  return parts.join('\n');
}

function countSheetRows(content: any): number {
  return asArray(content?.sheets).reduce((sum, sheet) => sum + asArray(sheet?.rows).length, 0)
    + asArray(content?.rows).length;
}

function meaningfulCellCount(rows: any[][]): number {
  let count = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (cleanArtifactText(cell)) count++;
    }
  }
  return count;
}

function allSheetRows(content: any): any[][] {
  const rows: any[][] = [];
  for (const sheet of asArray(content?.sheets)) rows.push(...rowsFromSheet(sheet));
  for (const row of asArray(content?.rows)) {
    if (Array.isArray(row)) rows.push(row.map(normalizeCellForXlsx));
    else if (row && typeof row === 'object') rows.push(Object.values(row).map(normalizeCellForXlsx));
    else rows.push([row]);
  }
  return rows;
}

function rawMarkupLeakDetected(text: string): boolean {
  return /<\/?(?:w|a|r|wp|xml|table|thead|tbody|tr|td|th):?\b/i.test(text)
    || /&lt;\/?(?:w|a|r|wp|xml|table|thead|tbody|tr|td|th):?\b/i.test(text);
}

function sectionTextParts(section: any): string[] {
  const parts: string[] = [];
  if (section?.summary) parts.push(String(section.summary));
  for (const p of asArray(section?.paragraphs)) parts.push(String(p));
  for (const b of asArray(section?.bullets)) parts.push(String(b));
  for (const n of asArray(section?.numbered)) parts.push(String(n));
  for (const c of asArray(section?.checklist)) parts.push(String(c));
  for (const table of tablesFrom(section?.tables || section?.table)) {
    if (table.title) parts.push(table.title);
    parts.push(...table.headers);
    for (const row of table.rows) parts.push(...row.map(cleanArtifactText));
  }
  return parts.map(cleanArtifactText).filter(Boolean);
}

function docLikeQualityIssues(kind: ArtifactKind, content: any, text: string): string[] {
  const issues: string[] = [];
  if (rawMarkupLeakDetected(text)) {
    issues.push(`${kind.toUpperCase()} contains raw markup instead of clean document content`);
  }
  const sections = asArray(content?.sections);
  const emptyHeadings: string[] = [];
  const promiseOnlyHeadings: string[] = [];
  for (const section of sections) {
    const heading = cleanArtifactText(section?.heading);
    if (!heading) continue;
    const parts = sectionTextParts(section);
    const bodyText = parts.join(' ');
    const tableCount = tablesFrom(section?.tables || section?.table).length;
    const listCount = asArray(section?.bullets).length
      + asArray(section?.numbered).length
      + asArray(section?.checklist).length;
    if (parts.length === 0 && tableCount === 0) {
      emptyHeadings.push(heading);
      continue;
    }
    const promisesSpecificList = /\b(these are|there are|below are|following are)\b.*\b(two|three|four|five|several|key|main|primary|critical)\b/i.test(bodyText);
    if (promisesSpecificList && listCount === 0 && tableCount === 0 && parts.length <= 1) {
      promiseOnlyHeadings.push(heading);
    }
  }
  if (emptyHeadings.length > 0) {
    issues.push(`${kind.toUpperCase()} has empty section headings: ${emptyHeadings.slice(0, 3).join(', ')}`);
  }
  if (promiseOnlyHeadings.length > 0) {
    issues.push(`${kind.toUpperCase()} has setup-only sections that promise details but do not list them: ${promiseOnlyHeadings.slice(0, 3).join(', ')}`);
  }
  const summary = cleanArtifactText(content?.summary);
  if (summary.length > 700) {
    issues.push(`${kind.toUpperCase()} lead summary is too long for the callout; move detail into the executive summary`);
  }
  return issues;
}

function contentQualityIssues(kind: ArtifactKind, content: any): string[] {
  const issues: string[] = [];
  const text = plainTextFromStructured(content).trim();
  if (kind === 'xlsx') {
    const sheets = asArray(content?.sheets);
    const rows = allSheetRows(content);
    const nonEmptyCells = meaningfulCellCount(rows);
    if (sheets.length === 0 && asArray(content?.rows).length === 0) issues.push('missing workbook sheets');
    if (rows.length < 5) issues.push('spreadsheet has too few rows');
    if (nonEmptyCells < 10) issues.push('spreadsheet has too few meaningful cells');
    const looksLikeTextDump = rows.length <= 2
      && cleanArtifactText(rows[0]?.[0]).toLowerCase() === 'title'
      && cleanArtifactText(rows[1]?.[0]).toLowerCase() === 'content';
    if (looksLikeTextDump) issues.push('spreadsheet is a title/content text dump');
    return issues;
  }
  if (kind === 'pptx') {
    const slides = asArray(content?.slides);
    const meaningfulSlides = slides.filter(s => {
      const slideText = [
        s?.title,
        s?.headline,
        s?.takeaway,
        s?.subtitle,
        s?.body,
        ...asArray(s?.bullets),
        ...slideEvidenceBlocks(s),
        ...slideTables(s).flatMap(t => [...t.headers, ...t.rows.flat()]),
      ].map(cleanArtifactText).filter(Boolean).join(' ');
      return firstNonEmpty(s?.title, s?.headline) && slideText.length >= 35;
    });
    const visualSurfaceCount = slides.reduce((sum, s) => (
      sum + slideTables(s).length + slideEvidenceBlocks(s).length + asArray(s?.metrics).length + asArray(s?.chart?.series).length
    ), 0);
    const noteCount = slides.filter(s => cleanArtifactText(s?.speaker_notes || s?.notes)).length;
    if (slides.length < 4) issues.push('presentation has too few slides');
    if (meaningfulSlides.length < 3) issues.push('presentation has too few content-rich slides');
    if (text.length < 300) issues.push('presentation content is too thin');
    if (slides.length >= 6 && visualSurfaceCount < 3) issues.push('presentation needs more visual evidence surfaces');
    if (slides.length >= 6 && noteCount < Math.max(3, Math.floor(slides.length / 2))) issues.push('presentation needs speaker notes');
    return issues;
  }
  const sectionCount = asArray(content?.sections).length;
  const paragraphCount = asArray(content?.paragraphs).length
    + asArray(content?.bullets).length
    + asArray(content?.key_points).length
    + asArray(content?.recommendations).length;
  const tableCount = tablesFrom(content?.tables).length
    + asArray(content?.sections).reduce((sum, section) => sum + tablesFrom(section?.tables || section?.table).length, 0);
  if (text.length < 450) issues.push(`${kind.toUpperCase()} content is too thin`);
  if (sectionCount + paragraphCount < 4) issues.push(`${kind.toUpperCase()} needs more structured sections or paragraphs`);
  if (kind === 'docx' && sectionCount === 0 && tableCount === 0) issues.push('DOCX needs sections or tables');
  issues.push(...docLikeQualityIssues(kind, content, text));
  return issues;
}

function isThinArtifactContent(kind: ArtifactKind, content: any): boolean {
  const text = plainTextFromStructured(content).trim();
  if (kind === 'pptx') return asArray(content?.slides).length < 4 || text.length < 500;
  if (kind === 'xlsx') return countSheetRows(content) < 6;
  return text.length < 700 || (asArray(content?.sections).length + asArray(content?.paragraphs).length) < 4;
}

function defaultArtifactContent(kind: ArtifactKind, title: string, seed: any): any {
  const seedText = plainTextFromStructured(seed).trim();
  const summary = seedText || `This artifact was prepared by MARTy as a polished working document for ${title}. It is structured for quick review, clear next steps, and easy editing.`;
  if (kind === 'xlsx') {
    return {
      sheets: [
        {
          name: 'Summary',
          rows: [
            ['Section', 'Detail', 'Owner', 'Status'],
            ['Purpose', title, 'MARTy', 'Draft'],
            ['Summary', summary.slice(0, 800), 'MARTy', 'Draft'],
            ['Next step', 'Review, refine owners, and add dates where needed.', '', 'Open'],
          ],
        },
        {
          name: 'Workplan',
          rows: [
            ['Workstream', 'Priority', 'Action', 'Success measure', 'Due date'],
            ['Strategy', 'High', 'Clarify the highest-impact recommendation.', 'Decision-ready memo or deck', ''],
            ['Execution', 'High', 'Turn recommendations into assigned next steps.', 'Named owner for each step', ''],
            ['Follow-up', 'Medium', 'Capture open questions and evidence gaps.', 'Clean issue list', ''],
          ],
        },
      ],
    };
  }
  if (kind === 'pptx') {
    return {
      subtitle: 'Prepared by MARTy',
      slides: [
        { layout: 'cover', title, subtitle: 'Prepared by MARTy', headline: summary.slice(0, 140), speaker_notes: `Open by framing why ${title} matters and what decision the deck should support.` },
        { layout: 'executive_summary', title: 'Executive Takeaway', headline: summary.slice(0, 150), bullets: ['Use this as a working draft.', 'Tighten details with source-specific inputs.', 'Keep each slide anchored to one decision-useful point.'], evidence_blocks: ['Decision-ready storyline', 'Editable PPTX output', 'Source-sensitive draft'], speaker_notes: 'Lead with the main conclusion, then identify which facts still need confirmation.' },
        { layout: 'matrix', title: 'Recommended Workstreams', headline: 'Three workstreams turn the draft into an operating artifact.', table: { headers: ['Workstream', 'Priority', 'Output'], rows: [['Strategy', 'High', 'Decision-ready narrative'], ['Evidence', 'High', 'Confirmed facts and sources'], ['Execution', 'Medium', 'Owners and timing']] }, speaker_notes: 'Explain how each workstream maps to the intended audience and review cycle.' },
        { layout: 'timeline', title: 'Execution Plan', headline: 'The first week should move from alignment to a reviewed draft.', bullets: ['Day 1: confirm objective', 'Days 2-3: fill evidence gaps', 'Days 4-5: review with stakeholders', 'Day 7: finalize and circulate'], speaker_notes: 'Use this slide to turn the recommendation into a concrete operating cadence.' },
        { layout: 'risk', title: 'Risks And Watchouts', headline: 'The main risk is distributing a polished artifact with unverified assumptions.', evidence_blocks: ['Fact uncertainty', 'Unclear ownership', 'Premature distribution'], bullets: ['Flag uncertain facts before distribution', 'Assign a single owner for final edits', 'Separate source-backed claims from assumptions'], speaker_notes: 'Call out the difference between presentation polish and evidence confidence.' },
        { layout: 'next_steps', title: 'Next Steps', headline: 'Move from MARTy draft to stakeholder-ready deck.', table: { headers: ['Step', 'Owner', 'Outcome'], rows: [['Review draft', 'Team', 'Corrections captured'], ['Add detail', 'Owner', 'Specific facts inserted'], ['Finalize', 'Owner', 'Ready to send']] }, speaker_notes: 'Close with a crisp ask: what should happen next and who owns it.' },
      ],
    };
  }
  return {
    subtitle: 'Prepared by MARTy',
    summary,
    sections: [
      { heading: 'Executive Summary', paragraphs: [summary] },
      {
        heading: 'Recommended Workstreams',
        bullets: [
          'Clarify the highest-impact objective and the audience for the artifact.',
          'Translate the objective into concrete workstreams with clear owners.',
          'Preserve evidence, open questions, and decisions in one working file.',
        ],
      },
      {
        heading: 'Execution Plan',
        tables: [{
          headers: ['Workstream', 'Action', 'Owner', 'Success Measure'],
          rows: [
            ['Strategy', 'Define the decision or output the document should support.', '', 'Reviewer can act without asking for context.'],
            ['Execution', 'Turn recommendations into a concrete sequence.', '', 'Next steps have owners and timing.'],
            ['Quality Control', 'Confirm facts, dates, and source-sensitive claims.', '', 'No unsupported claims remain.'],
          ],
        }],
      },
      {
        heading: 'Risks And Watchouts',
        bullets: [
          'Avoid generic recommendations that do not connect to a business outcome.',
          'Separate confirmed facts from working assumptions.',
          'Keep the final document short enough to be used, not just admired.',
        ],
      },
      {
        heading: 'Next Steps',
        checklist: ['Review the draft', 'Add missing owners or dates', 'Confirm source-sensitive facts', 'Finalize and circulate'],
      },
    ],
  };
}

async function enrichArtifactContent(
  kind: ArtifactKind,
  title: string,
  content: any,
  ctx: AuthContext,
  env: Env,
  sourceDocs: DocumentRow[]
): Promise<any> {
  if (!isThinArtifactContent(kind, content)) return content;
  const sourceContext = sourceDocs
    .map(d => `- ${d.title || d.file_name || d.id}: ${d.extracted_text_preview || ''}`.slice(0, 1200))
    .join('\n');
  const system = `You are MARTy's production artifact engine. Return strict JSON only, no markdown.
Your job is to turn a weak draft into a fully usable, polished business artifact.

Quality bar:
- No title-only or placeholder artifacts.
- No empty headings, placeholder sections, raw XML/HTML/markdown table markup, or section titles that promise detail without delivering it.
- Use concrete headings, useful body copy, and skimmable structure.
- Preserve any facts supplied by the draft or source context. Do not invent external facts.
- If source facts are limited, create a high-quality editable template with clear placeholders and next-step fields instead of a blank file.
- For investment, diligence, board, risk, or deal memos, include a decision-ready executive summary, evidence-backed key facts, risk/concern register, open questions, owners/actions, and a source/gaps note when possible.

Schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]}
- pptx: {"subtitle":"","slides":[{"layout":"cover|executive_summary|evidence|matrix|timeline|risk|next_steps","title":"","headline":"","subtitle":"","takeaway":"","body":"","bullets":[],"evidence_blocks":[],"metrics":[{"label":"","value":"","context":""}],"table":{"headers":[],"rows":[[]]},"speaker_notes":""}]}
- xlsx: {"sheets":[{"name":"","title":"","rows":[[]]}]}

Minimum richness:
- docx/pdf: 5-8 substantive sections, concise lead summary, at least one useful table or checklist when helpful, and every section must have body content.
- pptx: 6-10 slides, one idea per slide, Medina-dark executive style, speaker notes, and at least three visual evidence surfaces (tables, metrics, matrices, or evidence blocks).
- xlsx: 2-4 sheets with headers, usable rows, and formulas where natural.`;
  const user = `Artifact kind: ${kind}
Title: ${title}

Current draft JSON:
${JSON.stringify(content || {}, null, 2).slice(0, 18000)}

Source document context:
${sourceContext || '(none)'}`;
  const raw = await callClaude({ system, user, max_tokens: 7000, orgId: ctx.orgId }, 'low', env).catch(() => '');
  const parsed = parseJsonObject(raw);
  return parsed || defaultArtifactContent(kind, title, content);
}

async function repairArtifactContent(
  kind: ArtifactKind,
  title: string,
  content: any,
  ctx: AuthContext,
  env: Env,
  sourceDocs: DocumentRow[],
  issues: string[]
): Promise<any> {
  const sourceContext = sourceDocs
    .map(d => `- ${d.title || d.file_name || d.id}: ${d.extracted_text_preview || ''}`.slice(0, 1200))
    .join('\n');
  const system = `You are MARTy's Office artifact repair engine. Return strict JSON only, no markdown.
The previous artifact request failed validation. Repair it into a real structured artifact for the requested file type.

Hard requirements:
- Never return plain prose as the root object.
- Never return a title/content dump for spreadsheets.
- Never return empty headings, placeholder sections, raw XML/HTML/markdown table markup, or a section that says "these are the three..." without listing the actual items.
- Preserve user-provided facts; if facts are limited, create a polished editable template with useful fields.
- No unsupported external facts.
- For investment, diligence, board, risk, or deal memos, include a decision-ready executive summary, evidence-backed key facts, risk/concern register, open questions, owners/actions, and a source/gaps note when possible.

Required schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]} with every section populated.
- xlsx: {"sheets":[{"name":"","title":"","rows":[[]]}]} with 2-4 sheets, headers, meaningful rows, and formulas where useful.
- pptx: {"subtitle":"","slides":[{"layout":"cover|executive_summary|evidence|matrix|timeline|risk|next_steps","title":"","headline":"","subtitle":"","takeaway":"","body":"","bullets":[],"evidence_blocks":[],"metrics":[{"label":"","value":"","context":""}],"table":{"headers":[],"rows":[[]]},"speaker_notes":""}]} with 6-10 slides, at least three visual evidence surfaces, and speaker notes.`;
  const user = `Artifact kind: ${kind}
Title: ${title}
Validation issues:
${issues.map(i => `- ${i}`).join('\n')}

Current draft JSON:
${JSON.stringify(content || {}, null, 2).slice(0, 18000)}

Source document context:
${sourceContext || '(none)'}`;
  const raw = await callClaude({ system, user, max_tokens: 7000, orgId: ctx.orgId }, 'low', env).catch(() => '');
  return parseJsonObject(raw) || defaultArtifactContent(kind, title, content);
}

async function planPremiumPptxDeck(
  title: string,
  content: any,
  ctx: AuthContext,
  env: Env,
  sourceDocs: DocumentRow[]
): Promise<any> {
  const sourceContext = sourceDocs
    .map(d => `- ${d.title || d.file_name || d.id}: ${d.extracted_text_preview || ''}`.slice(0, 1400))
    .join('\n');
  const system = `You are MARTy's deck director. Return strict JSON only, no markdown.
Design an editable Medina-dark executive PowerPoint deck, not a bullet dump.

Requirements:
- 6-10 slides.
- One clear headline or takeaway per slide.
- Use Medina-dark polish: restrained, high-contrast, executive, no decorative fluff.
- Include at least three visual evidence surfaces: table, matrix, metrics, timeline, risk list, or proof blocks.
- Include speaker_notes on every substantive slide.
- Preserve supplied facts. If facts are limited, use clearly marked working assumptions and useful placeholders.

Schema:
{"subtitle":"","slides":[{"layout":"cover|executive_summary|evidence|matrix|timeline|risk|next_steps|section","title":"","headline":"","subtitle":"","takeaway":"","body":"","bullets":[],"evidence_blocks":[],"metrics":[{"label":"","value":"","context":""}],"table":{"headers":[],"rows":[[]]},"speaker_notes":"","source_note":""}]}`;
  const user = `Deck title: ${title}

Current structured content:
${JSON.stringify(content || {}, null, 2).slice(0, 18000)}

Source document context:
${sourceContext || '(none)'}`;
  const raw = await callClaude({ system, user, max_tokens: 7000, orgId: ctx.orgId }, 'high', env).catch(() => '');
  const planned = parseJsonObject(raw);
  if (!planned || asArray(planned?.slides).length < 4) return content;
  return planned;
}

async function prepareArtifactContent(
  kind: ArtifactKind,
  title: string,
  inputContent: any,
  ctx: AuthContext,
  env: Env,
  sourceDocs: DocumentRow[]
): Promise<any> {
  let structuredContent = await enrichArtifactContent(kind, title, inputContent, ctx, env, sourceDocs);
  let issues = contentQualityIssues(kind, structuredContent);
  if (issues.length > 0) {
    structuredContent = await repairArtifactContent(kind, title, structuredContent, ctx, env, sourceDocs, issues);
    issues = contentQualityIssues(kind, structuredContent);
  }
  if (issues.length > 0) {
    structuredContent = defaultArtifactContent(kind, title, structuredContent);
  }
  if (kind === 'pptx') {
    structuredContent = await planPremiumPptxDeck(title, structuredContent, ctx, env, sourceDocs);
    if (contentQualityIssues(kind, structuredContent).length > 0) {
      structuredContent = await repairArtifactContent(kind, title, structuredContent, ctx, env, sourceDocs, contentQualityIssues(kind, structuredContent));
    }
  }
  return structuredContent;
}

function fileTitle(title: string, kind: ArtifactKind): string {
  const clean = title.trim().replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').slice(0, 100) || 'MARTy artifact';
  return clean.toLowerCase().endsWith(`.${kind}`) ? clean : `${clean}.${kind}`;
}

function paragraphRuns(text: string, docx: any, opts: { bold?: boolean; color?: string; size?: number } = {}): any[] {
  return [new docx.TextRun({
    text: cleanArtifactText(text),
    bold: opts.bold,
    color: opts.color || '111827',
    size: opts.size,
  })];
}

function makeDocxParagraph(docx: any, text: string, opts: { style?: string; bullet?: boolean; numbered?: boolean; bold?: boolean } = {}): any {
  return new docx.Paragraph({
    style: opts.style || 'Body',
    children: paragraphRuns(text, docx, { bold: opts.bold }),
    bullet: opts.bullet ? { level: 0 } : undefined,
    numbering: opts.numbered ? { reference: 'marty-numbering', level: 0 } : undefined,
    spacing: { after: opts.style === 'Heading1' ? 120 : 170, line: 276 },
  });
}

function normalizeDocxTableRows(headers: string[], rows: any[][]): { headers: string[]; rows: any[][] } {
  const columnCount = Math.max(headers.length, ...rows.map(row => Array.isArray(row) ? row.length : 1), 0);
  const normalizedHeaders = Array.from({ length: columnCount }, (_, i) => cleanArtifactText(headers[i]) || `Column ${i + 1}`);
  const normalizedRows = rows.map(row => Array.from({ length: columnCount }, (_, i) => Array.isArray(row) ? row[i] : (i === 0 ? row : '')));
  return { headers: normalizedHeaders, rows: normalizedRows };
}

function docxTableColumnWidths(headers: string[], rows: any[][]): number[] {
  if (headers.length === 0) return [];
  const compactColumn = (header: string) => /^(#|id|no\.?|tier|status|owner|date|stage|size|probability|priority)$/i.test(header.trim());
  const weights = headers.map((header, index) => {
    const lower = header.toLowerCase();
    let weight = 2;
    if (/^(#|id|no\.?)$/.test(lower)) weight = 0.45;
    else if (/\b(tier|status|owner|date|stage|size|probability|priority)\b/.test(lower)) weight = 1.25;
    else if (/\b(concern|detail|summary|description|action|notes?|evidence|rationale|open question)\b/.test(lower)) weight = 3.7;
    const longest = Math.max(cleanArtifactText(header).length, ...rows.map(row => cleanArtifactText(row[index]).length));
    return weight + Math.min(2.4, Math.max(0, longest - 12) / 28);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const mins = headers.map(header => compactColumn(header) ? 520 : 820);
  const maxes = headers.map(header => compactColumn(header) ? 1500 : 4300);
  const widths = weights.map((weight, index) => Math.min(maxes[index], Math.max(mins[index], Math.round((weight / totalWeight) * DOCX_TABLE_WIDTH_DXA))));
  let delta = DOCX_TABLE_WIDTH_DXA - widths.reduce((sum, width) => sum + width, 0);
  let guard = 0;
  while (delta !== 0 && guard < 1000) {
    const direction = Math.sign(delta);
    const eligible = widths
      .map((width, index) => ({ width, index }))
      .filter(({ width, index }) => direction > 0 ? width < maxes[index] : width > mins[index]);
    if (eligible.length === 0) break;
    for (const { index } of eligible) {
      const capacity = direction > 0 ? maxes[index] - widths[index] : widths[index] - mins[index];
      const step = Math.min(Math.abs(delta), capacity, 40);
      widths[index] += direction * step;
      delta -= direction * step;
      if (delta === 0) break;
    }
    guard++;
  }
  return widths;
}

function makeDocxTable(docx: any, table: { title?: string; headers: string[]; rows: any[][] }): any[] {
  const rawHeaders = table.headers.length > 0 ? table.headers : table.rows[0]?.map((_, i) => `Column ${i + 1}`) || [];
  const rawRows = table.headers.length > 0 ? table.rows : table.rows.slice(1);
  if (rawHeaders.length === 0) return [];
  const { headers, rows } = normalizeDocxTableRows(rawHeaders.map(cleanArtifactText), rawRows);
  const columnWidths = docxTableColumnWidths(headers, rows);
  const cells = (values: any[], isHeader = false) => values.map((value, index) => {
    const header = headers[index] || '';
    const isCompact = columnWidths[index] <= 900 || /^(#|id|no\.?|tier|status|owner|date)$/i.test(header);
    return new docx.TableCell({
      width: { size: columnWidths[index] || Math.floor(DOCX_TABLE_WIDTH_DXA / headers.length), type: docx.WidthType.DXA },
      shading: isHeader ? { fill: 'F3E8FF' } : undefined,
      verticalAlign: docx.VerticalAlign.CENTER,
      margins: { top: 140, bottom: 140, left: 170, right: 170 },
      children: [new docx.Paragraph({
        children: [new docx.TextRun({
          text: cleanArtifactText(value) || ' ',
          bold: isHeader,
          color: isHeader ? '581C87' : '111827',
          size: 18,
        })],
        alignment: isCompact ? docx.AlignmentType.CENTER : docx.AlignmentType.LEFT,
        spacing: { after: 0, line: 240 },
      })],
    });
  });
  const out: any[] = [];
  if (table.title) out.push(makeDocxParagraph(docx, table.title, { style: 'Caption', bold: true }));
  out.push(new docx.Table({
    width: { size: DOCX_TABLE_WIDTH_DXA, type: docx.WidthType.DXA },
    layout: docx.TableLayoutType.FIXED,
    columnWidths,
    borders: {
      top: { style: docx.BorderStyle.SINGLE, size: 1, color: 'D1D5DB' },
      bottom: { style: docx.BorderStyle.SINGLE, size: 1, color: 'D1D5DB' },
      left: { style: docx.BorderStyle.SINGLE, size: 1, color: 'D1D5DB' },
      right: { style: docx.BorderStyle.SINGLE, size: 1, color: 'D1D5DB' },
      insideHorizontal: { style: docx.BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
      insideVertical: { style: docx.BorderStyle.SINGLE, size: 1, color: 'E5E7EB' },
    },
    rows: [
      new docx.TableRow({ tableHeader: true, children: cells(headers, true) }),
      ...rows.map(row => new docx.TableRow({ children: cells(row, false) })),
    ],
  }));
  out.push(new docx.Paragraph({ text: '', spacing: { after: 120 } }));
  return out;
}

async function makeDocx(title: string, content: any): Promise<Uint8Array> {
  const mod = await import('docx');
  const docx: any = mod;
  const children: any[] = [];
  children.push(new docx.Paragraph({
    style: 'Title',
    children: [new docx.TextRun({ text: title, bold: true, color: '111827', size: 38 })],
    spacing: { after: 160 },
  }));
  const subtitle = firstNonEmpty(content?.subtitle, 'Prepared by MARTy');
  if (subtitle) children.push(makeDocxParagraph(docx, subtitle, { style: 'Subtitle' }));
  for (const m of asArray(content?.metadata)) {
    const label = firstNonEmpty(m?.label, m?.key);
    const value = cleanArtifactText(m?.value);
    if (label || value) children.push(makeDocxParagraph(docx, `${label}: ${value}`, { style: 'Meta' }));
  }
  if (content?.summary) {
    children.push(new docx.Paragraph({
      style: 'Callout',
      children: paragraphRuns(String(content.summary), docx, { color: '374151' }),
      spacing: { before: 160, after: 260, line: 286 },
      border: { left: { color: 'A855F7', size: 16, space: DOCX_CALLOUT_BORDER_SPACE, style: docx.BorderStyle.SINGLE } },
      indent: { left: DOCX_CALLOUT_INDENT_DXA },
    }));
  }

  const addParagraph = (text: string) => cleanArtifactText(text) && children.push(makeDocxParagraph(docx, text));
  const addBullet = (text: string) => cleanArtifactText(text) && children.push(makeDocxParagraph(docx, text, { bullet: true }));
  const addNumbered = (text: string) => cleanArtifactText(text) && children.push(makeDocxParagraph(docx, text, { numbered: true }));

  if (typeof content === 'string') {
    content.split(/\n{2,}/).map(s => s.trim()).filter(Boolean).forEach(addParagraph);
  } else {
    for (const p of asArray(content?.paragraphs)) addParagraph(String(p));
    for (const b of asArray(content?.bullets || content?.key_points)) addBullet(String(b));
    for (const table of tablesFrom(content?.tables)) children.push(...makeDocxTable(docx, table));
    for (const section of asArray(content?.sections)) {
      if (section?.heading) children.push(makeDocxParagraph(docx, String(section.heading), { style: 'Heading1', bold: true }));
      if (section?.summary) children.push(makeDocxParagraph(docx, String(section.summary), { style: 'Lead' }));
      for (const p of asArray(section?.paragraphs)) addParagraph(String(p));
      for (const b of asArray(section?.bullets)) addBullet(String(b));
      for (const n of asArray(section?.numbered)) addNumbered(String(n));
      for (const c of asArray(section?.checklist)) addBullet(`[ ] ${String(c)}`);
      for (const table of tablesFrom(section?.tables || section?.table)) children.push(...makeDocxTable(docx, table));
    }
  }

  const document = new docx.Document({
    creator: 'MARTy',
    title,
    numbering: {
      config: [{
        reference: 'marty-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left', style: { paragraph: { indent: { left: 420, hanging: 220 } } } }],
      }],
    },
    styles: {
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: 'Aptos Display', size: 38, bold: true, color: '111827' }, paragraph: { spacing: { after: 140 } } },
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', run: { font: 'Aptos', size: 22, color: '6B7280' }, paragraph: { spacing: { after: 260 } } },
        { id: 'Meta', name: 'Meta', basedOn: 'Normal', run: { font: 'Aptos', size: 18, color: '6B7280' }, paragraph: { spacing: { after: 80 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Body', run: { font: 'Aptos Display', size: 27, bold: true, color: '111827' }, paragraph: { spacing: { before: 260, after: 100 }, keepNext: true } },
        { id: 'Lead', name: 'Lead', basedOn: 'Normal', run: { font: 'Aptos', size: 22, color: '374151' }, paragraph: { spacing: { after: 170, line: 288 } } },
        { id: 'Body', name: 'Body', basedOn: 'Normal', run: { font: 'Aptos', size: 21, color: '111827' }, paragraph: { spacing: { after: 170, line: 276 } } },
        { id: 'Caption', name: 'Caption', basedOn: 'Normal', run: { font: 'Aptos', size: 18, color: '6B7280' }, paragraph: { spacing: { before: 80, after: 80 } } },
        { id: 'Callout', name: 'Callout', basedOn: 'Normal', run: { font: 'Aptos', size: 21, color: '374151' }, paragraph: { spacing: { after: 220, line: 286 } } },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: DOCX_PAGE_MARGIN_DXA, right: DOCX_PAGE_MARGIN_DXA, bottom: DOCX_PAGE_MARGIN_DXA, left: DOCX_PAGE_MARGIN_DXA } } },
      children,
    }],
  });
  const buffer = await docx.Packer.toBuffer(document);
  return new Uint8Array(buffer);
}

function normalizeCellForXlsx(cell: any): any {
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    if (cell.formula || cell.f) {
      return { f: String(cell.formula || cell.f).replace(/^=/, ''), v: cell.value ?? cell.v ?? undefined };
    }
    if ('value' in cell) return cell.value;
  }
  return cell;
}

function rowsFromSheet(sheet: any): any[][] {
  return asArray(sheet?.rows).map(row => {
    if (Array.isArray(row)) return row.map(normalizeCellForXlsx);
    if (row && typeof row === 'object') return Object.values(row).map(normalizeCellForXlsx);
    return [row];
  });
}

function safeXlsxSheetName(value: unknown, fallback: string): string {
  const cleaned = cleanArtifactText(value || fallback)
    .replace(/[\[\]\*\/\\\?:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = cleaned || fallback || 'Sheet';
  return name.slice(0, 31) || 'Sheet';
}

function uniqueXlsxSheetName(value: unknown, usedNames: Set<string>, fallback = 'Sheet'): string {
  const base = safeXlsxSheetName(value, fallback);
  let name = base;
  let index = 2;
  while (usedNames.has(name.toLowerCase())) {
    const suffix = ` (${index})`;
    name = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    index += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

async function makeXlsx(title: string, content: any): Promise<Uint8Array> {
  const XLSX = await import('@e965/xlsx');
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: title, Author: 'MARTy', Company: 'Medina Ventures' };
  const safeContent = asArray(content?.sheets).length > 0 || asArray(content?.rows).length > 0
    ? content
    : defaultArtifactContent('xlsx', title, content);
  const sheets = asArray(safeContent?.sheets);
  const usedSheetNames = new Set<string>();
  if (sheets.length > 0) {
    for (const [index, sheet] of sheets.entries()) {
      const rows = rowsFromSheet(sheet);
      const aoa = rows.length > 0 ? rows : [[sheet?.title || title], ['No rows provided']];
      if (sheet?.title && cleanArtifactText(aoa[0]?.[0]) !== cleanArtifactText(sheet.title)) aoa.unshift([sheet.title]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const maxCols = Math.max(...aoa.map(row => row.length), 1);
      ws['!cols'] = Array.from({ length: maxCols }, (_, i) => {
        const max = Math.max(...aoa.map(row => cleanArtifactText(row[i]).length), i === 0 ? 18 : 10);
        return { wch: Math.min(Math.max(max + 2, i === 0 ? 18 : 12), 48) };
      });
      if (ws['!ref'] && aoa.length > 1) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: sheet?.title ? 1 : 0, c: 0 }, e: range.e }) };
      }
      (ws as any)['!freeze'] = { xSplit: 0, ySplit: sheet?.title ? 2 : 1 };
      XLSX.utils.book_append_sheet(wb, ws, uniqueXlsxSheetName(sheet?.name || sheet?.title, usedSheetNames, `Sheet ${index + 1}`));
    }
  } else {
    const rows = asArray(safeContent?.rows);
    const aoa = rows.length > 0
      ? rows.map(row => Array.isArray(row) ? row.map(normalizeCellForXlsx) : Object.values(row || {}).map(normalizeCellForXlsx))
      : rowsFromSheet(defaultArtifactContent('xlsx', title, safeContent).sheets[0]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws, uniqueXlsxSheetName('Summary', usedSheetNames));
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}

function inferPptxLayout(slide: any, index: number): string {
  const layout = cleanArtifactText(slide?.layout).toLowerCase();
  if (layout) return layout;
  if (index === 0) return 'cover';
  if (slideTables(slide).length > 0) return index <= 2 ? 'matrix' : 'evidence';
  if (slideEvidenceBlocks(slide).length >= 3) return 'evidence';
  if (/\b(risk|watchout|concern)\b/i.test(cleanArtifactText(slide?.title))) return 'risk';
  if (/\b(next|action|plan|step)\b/i.test(cleanArtifactText(slide?.title))) return 'next_steps';
  return index === 1 ? 'executive_summary' : 'evidence';
}

function normalizePptxSlide(title: string, slide: any, index: number): any {
  const bullets = [
    ...asArray(slide?.bullets),
    ...asArray(slide?.key_points),
    ...asArray(slide?.recommendations),
  ].map(cleanArtifactText).filter(Boolean).slice(0, 6);
  const tables = slideTables(slide);
  const headline = firstNonEmpty(slide?.headline, slide?.takeaway, slide?.callout, slide?.body, bullets[0]);
  const normalized = {
    ...slide,
    layout: inferPptxLayout(slide, index),
    title: firstNonEmpty(slide?.title, index === 0 ? title : `Slide ${index + 1}`),
    subtitle: firstNonEmpty(slide?.subtitle, index === 0 ? 'Prepared by MARTy' : ''),
    headline,
    body: cleanArtifactText(slide?.body),
    bullets,
    evidence_blocks: slideEvidenceBlocks(slide).slice(0, 6),
    metrics: asArray(slide?.metrics).filter(Boolean).slice(0, 4),
    table: tables[0] || null,
    source_note: cleanArtifactText(slide?.source_note || slide?.source),
    speaker_notes: cleanArtifactText(slide?.speaker_notes || slide?.notes),
  };
  if (!normalized.speaker_notes && index > 0) {
    normalized.speaker_notes = [
      normalized.headline,
      normalized.body,
      bullets.length ? `Talk track: ${bullets.join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }
  return normalized;
}

function slidesFromContent(title: string, content: any): any[] {
  const explicit = asArray(content?.slides);
  let slides: any[] = explicit.length > 0 ? explicit : [];
  if (slides.length === 0) {
    slides = [{ layout: 'cover', title, subtitle: content?.subtitle || 'Prepared by MARTy' }];
    if (content?.summary) slides.push({ layout: 'executive_summary', title: 'Executive Takeaway', headline: content.summary, body: content.summary });
    for (const section of asArray(content?.sections)) {
      slides.push({
        title: section?.heading || 'Section',
        headline: section?.summary || asArray(section?.paragraphs)[0] || '',
        body: section?.summary || '',
        bullets: [...asArray(section?.bullets), ...asArray(section?.numbered), ...asArray(section?.checklist)].slice(0, 6),
        table: tableFromAny(section?.table || asArray(section?.tables)[0]),
      });
    }
  }
  if (slides.length < 6) {
    const fallback = defaultArtifactContent('pptx', title, content).slides;
    slides = [...slides, ...fallback.slice(slides.length)];
  }
  return slides.slice(0, 12).map((slide, index) => normalizePptxSlide(title, slide, index));
}

function deckStylePackFrom(input: any, title: string): DeckStylePackId {
  const explicit = cleanArtifactText(input?.style_pack || input?.stylePack || input?.deck_style_pack).toLowerCase();
  if (explicit && explicit in DECK_STYLE_PACKS) return explicit as DeckStylePackId;
  const text = `${title} ${plainTextFromStructured(input)}`.toLowerCase();
  if (/\b(lp|limited partner|quarterly update|investor update)\b/.test(text)) return 'lp_report';
  if (/\b(founder|pitch|sales|customer|demo|product story)\b/.test(text)) return 'founder_story';
  if (/\b(board|ic|investment committee|committee|banker|financing|transaction)\b/.test(text)) return 'banker_clean';
  if (/\b(strategy|market map|operating review|recommendation|workstream)\b/.test(text)) return 'consulting_editorial';
  return 'medina_default';
}

function inferDeckObjective(input: any, title: string): DeckObjective {
  const explicit = cleanArtifactText(input?.objective).toLowerCase();
  if (explicit === 'inform' || explicit === 'persuade' || explicit === 'decide' || explicit === 'update' || explicit === 'sell') return explicit;
  const text = `${title} ${plainTextFromStructured(input)}`.toLowerCase();
  if (/\b(decide|decision|approve|approval|commit|go\/no-go|go no go)\b/.test(text)) return 'decide';
  if (/\b(sell|sales|pitch|convince|persuade|fundraise|raise)\b/.test(text)) return 'sell';
  if (/\b(update|weekly|monthly|quarterly|recap|status)\b/.test(text)) return 'update';
  if (/\b(recommend|should|case for|argument)\b/.test(text)) return 'persuade';
  return 'inform';
}

function escapeHtml(value: any): string {
  return cleanArtifactText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wordsIn(value: string): number {
  return cleanArtifactText(value).split(/\s+/).filter(Boolean).length;
}

function slideWordCount(slide: any): number {
  const text = [
    slide?.title,
    slide?.headline,
    slide?.subtitle,
    slide?.body,
    ...asArray(slide?.bullets),
    ...slideEvidenceBlocks(slide),
    ...slideTables(slide).flatMap(t => [...t.headers, ...t.rows.flat()]),
  ].map(cleanArtifactText).join(' ');
  return wordsIn(text);
}

function inferSlideRole(slide: any, index: number): string {
  const layout = cleanArtifactText(slide?.layout).toLowerCase();
  if (layout === 'cover' || index === 0) return 'cover';
  if (layout === 'executive_summary') return 'executive_summary';
  if (layout === 'risk') return 'risk_register';
  if (layout === 'timeline' || layout === 'next_steps') return 'action_plan';
  if (layout === 'matrix') return 'analysis_exhibit';
  return 'evidence_slide';
}

function deckFactsFromContent(title: string, content: any, slides: any[]): DeckFact[] {
  const facts: DeckFact[] = [];
  const addFact = (claim: string, use: DeckFact['use'], confidence: DeckFact['confidence'] = 'probable') => {
    const cleaned = cleanArtifactText(claim);
    if (!cleaned) return;
    const existing = facts.find(f => f.claim.toLowerCase() === cleaned.toLowerCase());
    if (existing) return;
    facts.push({
      id: `fact_${facts.length + 1}`,
      claim: cleaned.slice(0, 260),
      sourceIds: asArray(content?.source_document_ids).map(String),
      confidence,
      use,
    });
  };
  addFact(firstNonEmpty(content?.summary, title), 'headline', 'probable');
  for (const slide of slides) {
    addFact(slide?.headline || slide?.title, 'headline', 'probable');
    for (const metric of asArray(slide?.metrics).slice(0, 4)) {
      const value = firstNonEmpty(metric?.value, metric?.metric);
      const label = firstNonEmpty(metric?.label, metric?.name, metric?.context);
      if (value || label) {
        facts.push({
          id: `fact_${facts.length + 1}`,
          claim: `${label || 'Metric'}: ${value || ''}`.trim().slice(0, 260),
          value: value || undefined,
          sourceIds: asArray(content?.source_document_ids).map(String),
          confidence: 'probable',
          use: 'chart',
        });
      }
    }
    for (const evidence of slideEvidenceBlocks(slide).slice(0, 2)) addFact(evidence, 'speaker_note', 'needs_review');
  }
  return facts.slice(0, 80);
}

function deckPlanFromContent(title: string, content: any): DeckPlan {
  const slides = slidesFromContent(title, content);
  const stylePack = deckStylePackFrom(content, title);
  const objective = inferDeckObjective(content, title);
  const slideSpecs: SlideSpec[] = slides.map((slide, index) => ({
    id: `slide_${index + 1}`,
    role: inferSlideRole(slide, index),
    headline: firstNonEmpty(slide?.headline, slide?.title, `Slide ${index + 1}`),
    layout: cleanArtifactText(slide?.layout) || inferPptxLayout(slide, index),
    facts: [
      firstNonEmpty(slide?.headline, slide?.title),
      ...asArray(slide?.metrics).map((m: any) => `${firstNonEmpty(m?.label, m?.name)} ${firstNonEmpty(m?.value, m?.metric)}`.trim()),
      ...slideEvidenceBlocks(slide).slice(0, 3),
    ].map(cleanArtifactText).filter(Boolean).slice(0, 6),
    visualIntent: firstNonEmpty(slide?.visualIntent, slide?.visual_intent, slide?.layout, 'evidence-led executive slide'),
    speakerNotes: cleanArtifactText(slide?.speaker_notes || slide?.notes) || undefined,
  }));
  const explicitStoryline = asArray(content?.storyline).map(cleanArtifactText).filter(Boolean);
  const storyline = explicitStoryline.length > 0
    ? explicitStoryline.slice(0, 8)
    : slideSpecs
        .filter(s => s.role !== 'cover')
        .map(s => s.headline)
        .slice(0, 6);
  return {
    title,
    audience: firstNonEmpty(content?.audience, content?.target_audience, 'Medina Ventures internal stakeholders'),
    objective,
    storyline,
    style_pack: stylePack,
    slides: slideSpecs,
    facts: deckFactsFromContent(title, content, slides),
  };
}

function styleTokens(styleId: DeckStylePackId): Record<string, string> {
  const style = DECK_STYLE_PACKS[styleId] || DECK_STYLE_PACKS.medina_default;
  if (style.id === 'banker_clean') {
    return {
      bg: '#FFFFFF',
      panel: '#F4F5F7',
      panel2: '#FFFFFF',
      text: '#111827',
      muted: '#64748B',
      accent: '#1D4ED8',
      accent2: '#A855F7',
      border: '#D9DEE7',
    };
  }
  if (style.id === 'consulting_editorial') {
    return {
      bg: '#FBFBFC',
      panel: '#ECEFF3',
      panel2: '#FFFFFF',
      text: '#101828',
      muted: '#667085',
      accent: '#2563EB',
      accent2: '#E11D48',
      border: '#D0D5DD',
    };
  }
  if (style.id === 'founder_story') {
    return {
      bg: '#111827',
      panel: '#192132',
      panel2: '#243044',
      text: '#F8FAFC',
      muted: '#CBD5E1',
      accent: '#22D3EE',
      accent2: '#F97316',
      border: '#334155',
    };
  }
  if (style.id === 'lp_report') {
    return {
      bg: '#F8F7F4',
      panel: '#E8E1D7',
      panel2: '#FFFFFF',
      text: '#151515',
      muted: '#6B625A',
      accent: '#6D28D9',
      accent2: '#0F766E',
      border: '#D6CFC4',
    };
  }
  return {
    bg: '#08080D',
    panel: '#12121A',
    panel2: '#191923',
    text: '#F8FAFC',
    muted: '#A1A1AA',
    accent: '#D946A8',
    accent2: '#8B5CF6',
    border: '#2D2D36',
  };
}

function renderSlideTableHtml(table: any): string {
  const t = tableFromAny(table);
  if (!t || t.headers.length === 0) return '';
  const rows = t.rows.slice(0, 6);
  return `<div class="table-wrap">${t.title ? `<div class="table-title">${escapeHtml(t.title)}</div>` : ''}<table><thead><tr>${t.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${t.headers.map((_, i) => `<td>${escapeHtml(row[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderPremiumDeckHtml(title: string, content: any, qaReport?: DeckQaReport): string {
  const slides = slidesFromContent(title, content);
  const plan = deckPlanFromContent(title, content);
  const style = DECK_STYLE_PACKS[plan.style_pack];
  const T = styleTokens(plan.style_pack);
  const qa = qaReport || evaluatePremiumDeckQa(title, content);
  const slideHtml = slides.map((slide, index) => {
    const metrics = asArray(slide.metrics).slice(0, 4);
    const evidence = slideEvidenceBlocks(slide).slice(0, 4);
    const tableHtml = renderSlideTableHtml(slide.table);
    const bullets = asArray(slide.bullets).map(cleanArtifactText).filter(Boolean).slice(0, 4);
    const layout = cleanArtifactText(slide.layout || 'evidence');
    const body = cleanArtifactText(slide.body);
    const metricHtml = metrics.length
      ? `<div class="metrics">${metrics.map((m: any) => `<div class="metric"><div class="metric-value">${escapeHtml(firstNonEmpty(m?.value, m?.metric, m))}</div><div class="metric-label">${escapeHtml(firstNonEmpty(m?.label, m?.name, m?.context))}</div></div>`).join('')}</div>`
      : '';
    const evidenceHtml = evidence.length
      ? `<div class="evidence-grid">${evidence.map((e, i) => `<div class="evidence-card"><span>${String(i + 1).padStart(2, '0')}</span><strong>${escapeHtml(e)}</strong></div>`).join('')}</div>`
      : '';
    const bulletHtml = bullets.length
      ? `<ul>${bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
      : '';
    const mainVisual = tableHtml || evidenceHtml || metricHtml || bulletHtml;
    if (layout === 'cover' || index === 0) {
      return `<section class="slide cover" data-slide="${index + 1}">
        <div class="slide-accent" data-accent-line="true"></div>
        <div class="kicker">MEDINA VENTURES · ${escapeHtml(style.name)}</div>
        <h1>${escapeHtml(slide.title || title)}</h1>
        <p class="cover-subtitle">${escapeHtml(firstNonEmpty(slide.headline, slide.subtitle, content?.summary, 'Prepared by MARTy'))}</p>
        <div class="cover-proof">${evidenceHtml || metricHtml || '<div class="evidence-grid"><div class="evidence-card"><span>01</span><strong>Claim spine</strong></div><div class="evidence-card"><span>02</span><strong>Visual system</strong></div><div class="evidence-card"><span>03</span><strong>QA-gated export</strong></div></div>'}</div>
        <footer>${escapeHtml(firstNonEmpty(slide.subtitle, 'Prepared by MARTy'))}</footer>
      </section>`;
    }
    return `<section class="slide ${escapeHtml(layout)}" data-slide="${index + 1}">
      <div class="slide-accent" data-accent-line="true"></div>
      <div class="kicker">${escapeHtml(inferSlideRole(slide, index).replace(/_/g, ' '))}</div>
      <header>
        <h2>${escapeHtml(slide.title)}</h2>
        <p>${escapeHtml(firstNonEmpty(slide.headline, slide.takeaway))}</p>
      </header>
      <main class="${tableHtml ? 'with-table' : evidence.length ? 'with-evidence' : 'with-bullets'}">
        <div class="narrative">
          ${metricHtml}
          ${body ? `<p class="body">${escapeHtml(body)}</p>` : ''}
          ${bulletHtml}
        </div>
        <div class="visual">${mainVisual}</div>
      </main>
      ${slide.source_note ? `<div class="source-note">Source note: ${escapeHtml(slide.source_note)}</div>` : ''}
      <footer>${index + 1}/${slides.length}</footer>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: ${T.bg};
  --panel: ${T.panel};
  --panel-2: ${T.panel2};
  --text: ${T.text};
  --muted: ${T.muted};
  --accent: ${T.accent};
  --accent-2: ${T.accent2};
  --border: ${T.border};
  --accent-gutter: ${DECK_ACCENT_GUTTER_PX}px;
  --safe-margin: ${DECK_SAFE_MARGIN_PX}px;
  --grid-gap: ${DECK_GRID_GAP_PX}px;
  --text-max-width: ${DECK_TEXT_MAX_WIDTH_PX}px;
  --footer-reserved: ${DECK_FOOTER_RESERVED_PX}px;
  --slide-w: 1280px;
  --slide-h: 720px;
}
* { box-sizing: border-box; }
body { margin: 0; background: #050507; color: var(--text); font-family: Inter, Arial, sans-serif; }
.deck-frame { min-height: 100vh; padding: 32px; display: grid; gap: 32px; place-items: center; }
.deck-meta { width: min(1280px, 100%); color: #a1a1aa; display: flex; justify-content: space-between; gap: 16px; font-size: 12px; }
.slide { position: relative; width: min(var(--slide-w), calc(100vw - 64px)); aspect-ratio: 16 / 9; overflow: hidden; background: var(--bg); border: 1px solid color-mix(in srgb, var(--border) 72%, transparent); box-shadow: 0 24px 90px rgba(0,0,0,.36); padding: var(--safe-margin) 76px var(--footer-reserved) calc(var(--accent-gutter) + 48px); }
.slide-accent { position: absolute; left: 30px; top: var(--safe-margin); bottom: var(--safe-margin); width: 4px; border-radius: 999px; background: linear-gradient(180deg, var(--accent), var(--accent-2)); }
.kicker { color: var(--accent-2); text-transform: uppercase; letter-spacing: .16em; font-size: 12px; font-weight: 700; margin-bottom: 22px; }
h1, h2 { font-family: "DM Sans", Inter, Arial, sans-serif; letter-spacing: 0; margin: 0; color: var(--text); }
h1 { font-size: 56px; line-height: 1; max-width: 840px; }
h2 { font-size: 32px; line-height: 1.06; max-width: 760px; }
header p, .cover-subtitle { margin: 18px 0 0; color: color-mix(in srgb, var(--text) 90%, var(--accent-2)); font-size: 21px; line-height: 1.24; font-weight: 650; max-width: var(--text-max-width); }
main { display: grid; grid-template-columns: minmax(0, .92fr) minmax(0, 1.08fr); gap: var(--grid-gap); align-items: start; margin-top: 30px; }
.cover { display: grid; grid-template-rows: auto auto auto 1fr auto; }
.cover-proof { position: absolute; right: 76px; top: 152px; width: 360px; }
.cover footer, .slide footer { position: absolute; left: calc(var(--accent-gutter) + 48px); bottom: 30px; color: var(--muted); font-size: 12px; }
.slide footer { left: auto; right: 52px; }
.body { color: color-mix(in srgb, var(--text) 88%, var(--muted)); line-height: 1.4; font-size: 17px; margin: 0 0 18px; max-width: var(--text-max-width); }
ul { margin: 0; padding: 0; display: grid; gap: 11px; list-style: none; }
li { position: relative; padding-left: 22px; color: color-mix(in srgb, var(--text) 88%, var(--muted)); font-size: 16px; line-height: 1.32; }
li::before { content: ""; position: absolute; left: 0; top: .58em; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.metric, .evidence-card { background: color-mix(in srgb, var(--panel) 88%, transparent); border: 1px solid var(--border); border-radius: 12px; }
.metric { padding: 16px; }
.metric-value { font-size: 30px; line-height: 1; font-weight: 800; color: var(--text); }
.metric-label { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.25; text-transform: uppercase; letter-spacing: .08em; }
.evidence-grid { display: grid; gap: 12px; }
.evidence-card { min-height: 82px; padding: 15px 17px; display: grid; grid-template-columns: 38px 1fr; gap: 12px; align-items: start; }
.evidence-card span { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .1em; }
.evidence-card strong { color: var(--text); font-size: 17px; line-height: 1.25; }
.table-wrap { background: var(--panel-2); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.table-title { padding: 12px 14px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--border); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 12px 13px; border-bottom: 1px solid color-mix(in srgb, var(--border) 78%, transparent); text-align: left; vertical-align: top; line-height: 1.25; }
th { color: var(--accent-2); background: color-mix(in srgb, var(--panel) 90%, transparent); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; }
td { color: color-mix(in srgb, var(--text) 82%, var(--muted)); }
.source-note { position: absolute; left: calc(var(--accent-gutter) + 48px); right: 92px; bottom: 30px; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qa-panel { width: min(1280px, 100%); padding: 18px 20px; border: 1px solid #2d2d36; border-radius: 14px; background: #101014; color: #d4d4d8; font-size: 13px; }
.qa-panel strong { color: #fff; }
@media print { body { background: white; } .deck-frame { padding: 0; gap: 0; } .deck-meta, .qa-panel { display: none; } .slide { width: 100vw; height: 100vh; box-shadow: none; border: 0; page-break-after: always; } }
</style>
</head>
<body>
<div class="deck-frame">
  <div class="deck-meta"><span>${escapeHtml(style.name)} · HTML source of truth</span><span>QA: ${escapeHtml(qa.status)}</span></div>
  ${slideHtml}
  <aside class="qa-panel"><strong>Deck QA:</strong> ${escapeHtml(qa.status)} · ${qa.checks.slide_count} slides · ${qa.checks.visual_surface_count} visual surfaces · accent gutter ${qa.checks.accent_gutter_px}px.</aside>
</div>
</body>
</html>`;
}

function evaluatePremiumDeckQa(title: string, content: any, html?: string): DeckQaReport {
  const slides = slidesFromContent(title, content);
  const explicitSlideCount = asArray(content?.slides).length;
  const findings: DeckQaReport['slideFindings'] = [];
  let visualSurfaceCount = 0;
  let totalWords = 0;
  let maxWords = 0;
  slides.forEach((slide, index) => {
    const slideId = `slide_${index + 1}`;
    const wordCount = slideWordCount(slide);
    totalWords += wordCount;
    maxWords = Math.max(maxWords, wordCount);
    visualSurfaceCount += slideTables(slide).length + slideEvidenceBlocks(slide).length + asArray(slide?.metrics).length;
    if (!firstNonEmpty(slide?.title, slide?.headline)) {
      findings.push({ slideId, severity: 'critical', issue: 'Slide has no title or decision headline.', requiredFix: 'Add a clear decision headline before export.' });
    }
    if (index > 0 && !firstNonEmpty(slide?.headline, slide?.takeaway)) {
      findings.push({ slideId, severity: 'high', issue: 'Slide title is topical instead of making a point.', requiredFix: 'Add a so-what headline that states the conclusion.' });
    }
    if (wordCount > 155) {
      findings.push({ slideId, severity: 'high', issue: `Slide is too dense at ${wordCount} words.`, requiredFix: 'Split content into a proof object plus concise supporting copy.' });
    }
    if (asArray(slide?.bullets).length > 6) {
      findings.push({ slideId, severity: 'medium', issue: 'Slide has too many bullets.', requiredFix: 'Convert bullets into a table, matrix, timeline, or metric surface.' });
    }
  });
  if (explicitSlideCount > 0 && explicitSlideCount < 4) {
    findings.push({ slideId: 'deck', severity: 'critical', issue: 'Original deck content is a skeletal slide draft.', requiredFix: 'Build a complete claim spine before exporting a polished deck.' });
  }
  if (slides.length < 6) findings.push({ slideId: 'deck', severity: 'critical', issue: 'Deck has too few slides for a complete executive presentation.', requiredFix: 'Add enough slides to cover setup, evidence, recommendation, and next steps.' });
  if (visualSurfaceCount < 4) findings.push({ slideId: 'deck', severity: 'high', issue: 'Deck lacks enough visual evidence surfaces.', requiredFix: 'Add tables, metrics, matrices, timelines, or proof blocks.' });
  if (DECK_ACCENT_GUTTER_PX < 56) findings.push({ slideId: 'deck', severity: 'critical', issue: 'Accent line is too close to body text.', requiredFix: 'Increase the accent gutter before rendering.' });
  const htmlBytes = html ? new TextEncoder().encode(html).byteLength : 0;
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasHigh = findings.some(f => f.severity === 'high');
  return {
    status: hasCritical ? 'failed' : hasHigh ? 'needs_revision' : 'pass',
    slideFindings: findings,
    checks: {
      slide_count: slides.length,
      visual_surface_count: visualSurfaceCount,
      average_words_per_slide: Math.round(totalWords / Math.max(slides.length, 1)),
      max_words_on_slide: maxWords,
      accent_gutter_px: DECK_ACCENT_GUTTER_PX,
      html_bytes: htmlBytes,
    },
  };
}

function deckQaHasBlockingFindings(qa: DeckQaReport | null | undefined): boolean {
  return Boolean(qa?.slideFindings?.some(f => f.severity === 'critical' || f.severity === 'high'));
}

function wordsFromText(text: string, maxWords: number): string {
  const words = cleanArtifactText(text).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function findingSlideIndexes(qa: DeckQaReport): Set<number> {
  const indexes = new Set<number>();
  for (const finding of qa.slideFindings) {
    const match = String(finding.slideId || '').match(/slide_(\d+)/i);
    if (match) indexes.add(Math.max(0, Number(match[1]) - 1));
  }
  return indexes;
}

function deterministicDeckRepair(title: string, content: any, qa: DeckQaReport, round: number): any {
  const repaired = JSON.parse(JSON.stringify(content || {}));
  const slides = slidesFromContent(title, repaired);
  const targeted = findingSlideIndexes(qa);
  const repairAll = targeted.size === 0 || qa.slideFindings.some(f => f.slideId === 'deck');
  const aggressive = round >= MAX_DECK_REVISION_ROUNDS;

  repaired.slides = slides.map((slide, index) => {
    const shouldRepair = repairAll || targeted.has(index);
    if (!shouldRepair) return slide;

    const next = { ...slide };
    next.title = wordsFromText(firstNonEmpty(next.title, next.headline, `Slide ${index + 1}`), 12);
    next.headline = wordsFromText(firstNonEmpty(next.headline, next.takeaway, next.body, next.title), aggressive ? 14 : 18);
    next.body = wordsFromText(next.body, aggressive ? 28 : 45);
    next.speaker_notes = firstNonEmpty(next.speaker_notes, next.headline, next.body);

    const bullets = asArray(next.bullets).map(cleanArtifactText).filter(Boolean);
    const evidence = slideEvidenceBlocks(next);
    const allProof = [...evidence, ...bullets, cleanArtifactText(next.body)].filter(Boolean);
    const hasTable = Boolean(tableFromAny(next.table));

    if (bullets.length > 4 && !hasTable) {
      next.layout = 'matrix';
      next.table = {
        headers: ['Theme', 'Point'],
        rows: bullets.slice(0, aggressive ? 4 : 6).map((bullet, i) => [`${i + 1}`, wordsFromText(bullet, 16)]),
      };
      next.bullets = [];
    } else {
      next.bullets = bullets.slice(0, aggressive ? 3 : 4).map(b => wordsFromText(b, aggressive ? 12 : 16));
    }

    if (!hasTable && allProof.length > 0) {
      next.evidence_blocks = allProof.slice(0, aggressive ? 3 : 4).map(p => wordsFromText(p, aggressive ? 16 : 22));
    } else {
      next.evidence_blocks = evidence.slice(0, aggressive ? 3 : 4);
    }

    if (next.table) {
      const table = tableFromAny(next.table);
      if (table) {
        next.table = {
          title: table.title,
          headers: table.headers.slice(0, 5).map(h => wordsFromText(h, 6)),
          rows: table.rows.slice(0, aggressive ? 4 : 6).map(row => row.slice(0, 5).map(cell => wordsFromText(cell, aggressive ? 10 : 14))),
        };
      }
    }

    if (aggressive) {
      next.layout = index === 0 ? 'cover' : (next.table ? 'matrix' : 'evidence');
      next.body = '';
      next.metrics = asArray(next.metrics).slice(0, 2);
    }

    return next;
  });

  repaired.style_pack = repaired.style_pack || 'medina_default';
  repaired.deck_design_mode = round >= 2 ? 'safe_qa_repair' : 'qa_repair';
  return repaired;
}

async function applyDeckCriticPatch(
  title: string,
  content: any,
  qa: DeckQaReport,
  ctx: AuthContext,
  env: Env
): Promise<any | null> {
  const system = `You are MARTy's deck repair critic. Return strict JSON only.
You may compress copy, change layout, convert bullets to tables/proof cards, and improve hierarchy.
You must not invent facts, metrics, companies, dates, or claims.
Schema: {"slides":[{"index":1,"layout":"","title":"","headline":"","body":"","bullets":[],"evidence_blocks":[],"table":{"headers":[],"rows":[[]]},"speaker_notes":""}]}`;
  const user = `Deck title: ${title}

QA findings:
${qa.slideFindings.map(f => `- ${f.severity}: ${f.slideId}: ${f.issue} -> ${f.requiredFix}`).join('\n')}

Current deck JSON:
${JSON.stringify(content || {}, null, 2).slice(0, 16000)}`;
  const raw = await callClaude({ system, user, max_tokens: 4500, orgId: ctx.orgId }, 'low', env).catch(() => '');
  const patch = parseJsonObject(raw);
  if (!patch || !Array.isArray(patch.slides)) return null;

  const repaired = JSON.parse(JSON.stringify(content || {}));
  const slides = slidesFromContent(title, repaired);
  for (const item of patch.slides) {
    const index = Number(item?.index) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) continue;
    const current = slides[index];
    slides[index] = {
      ...current,
      layout: cleanArtifactText(item.layout) || current.layout,
      title: wordsFromText(firstNonEmpty(item.title, current.title), 12),
      headline: wordsFromText(firstNonEmpty(item.headline, current.headline), 18),
      body: wordsFromText(firstNonEmpty(item.body, current.body), 45),
      bullets: asArray(item.bullets).map((b: any) => wordsFromText(b, 16)).filter(Boolean).slice(0, 4),
      evidence_blocks: asArray(item.evidence_blocks).map((e: any) => wordsFromText(e, 22)).filter(Boolean).slice(0, 4),
      table: item.table ? tableFromAny(item.table) : current.table,
      speaker_notes: firstNonEmpty(item.speaker_notes, current.speaker_notes),
    };
  }
  repaired.slides = slides;
  repaired.deck_design_mode = 'critic_qa_repair';
  return repaired;
}

async function repairDeckSpecForQa(
  title: string,
  content: any,
  qa: DeckQaReport,
  round: number,
  ctx: AuthContext,
  env: Env
): Promise<any> {
  const deterministic = deterministicDeckRepair(title, content, qa, round);
  if (round === 2) {
    const critic = await applyDeckCriticPatch(title, deterministic, qa, ctx, env);
    return critic || deterministic;
  }
  return deterministic;
}

function pptxBulletText(items: string[]): string {
  return items.map(item => cleanArtifactText(item)).filter(Boolean).join('\n');
}

async function makePptx(title: string, content: any): Promise<Uint8Array> {
  const mod = await import('pptxgenjs');
  const PptxGen = (mod as any).default || mod;
  const pptx = new PptxGen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'MARTy';
  pptx.subject = title;
  pptx.title = title;
  pptx.company = 'Medina Ventures';
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };

  const C = {
    bg: '09090D',
    panel: '141419',
    panel2: '1C1C24',
    border: '2D2D36',
    magenta: 'D946A8',
    purple: '8B5CF6',
    cyan: '38BDF8',
    amber: 'FBBF24',
    text: 'F8FAFC',
    muted: 'A1A1AA',
    dim: '71717A',
  };
  const normalizedSlides = slidesFromContent(title, content);

  const addShell = (slide: any, idx: number, kicker?: string) => {
    slide.background = { color: C.bg };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: C.bg }, line: { color: C.bg } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.22, y: 0.48, w: 0.05, h: 6.54, fill: { color: C.magenta }, line: { color: C.magenta } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.29, y: 0.48, w: 0.025, h: 6.54, fill: { color: C.purple }, line: { color: C.purple } });
    if (idx > 0) {
      slide.addText(kicker || `SLIDE ${idx + 1}`, { x: 0.68, y: 0.34, w: 2.0, h: 0.22, fontSize: 8.5, color: C.purple, charSpace: 1.6, margin: 0 });
      slide.addText(`${idx + 1}/${normalizedSlides.length}`, { x: 12.0, y: 6.88, w: 0.72, h: 0.18, fontSize: 8, color: C.dim, align: 'right', margin: 0 });
    }
  };

  const addHeadline = (slide: any, s: any, y = 0.72, w = 7.2) => {
    slide.addText(s.title, { x: 0.68, y, w, h: 0.42, fontSize: 21, bold: true, color: C.text, margin: 0.01, fit: 'shrink' });
    if (s.headline) {
      slide.addText(s.headline, { x: 0.70, y: y + 0.62, w: Math.min(w + 1.6, 8.6), h: 0.72, fontSize: 14.5, bold: true, color: 'EDE9FE', margin: 0.02, fit: 'shrink' });
    }
  };

  const addBullets = (slide: any, items: string[], x: number, y: number, w: number, h: number, fontSize = 12.5) => {
    if (items.length === 0) return;
    slide.addText(pptxBulletText(items), {
      x, y, w, h,
      fontSize,
      color: 'D4D4D8',
      bullet: { type: 'bullet' },
      breakLine: false,
      fit: 'shrink',
      margin: 0.03,
      paraSpaceAfterPt: 7,
    });
  };

  const addEvidenceBlocks = (slide: any, blocks: string[], x: number, y: number, w: number, h: number) => {
    const visible = blocks.slice(0, 4);
    if (visible.length === 0) return;
    const gap = 0.13;
    const cardH = (h - gap * (visible.length - 1)) / visible.length;
    visible.forEach((block, i) => {
      const yy = y + i * (cardH + gap);
      slide.addShape(pptx.ShapeType.rect, { x, y: yy, w, h: cardH, fill: { color: C.panel2 }, line: { color: C.border, transparency: 10 } });
      slide.addShape(pptx.ShapeType.rect, { x, y: yy, w: 0.06, h: cardH, fill: { color: i % 2 ? C.purple : C.magenta }, line: { color: i % 2 ? C.purple : C.magenta } });
      slide.addText(block, { x: x + 0.22, y: yy + 0.14, w: w - 0.42, h: cardH - 0.24, fontSize: 12.5, bold: true, color: C.text, margin: 0.02, fit: 'shrink' });
    });
  };

  const addMetrics = (slide: any, metrics: any[], x: number, y: number, w: number) => {
    const visible = metrics.slice(0, 4);
    if (visible.length === 0) return;
    const cardW = (w - 0.18 * (visible.length - 1)) / visible.length;
    visible.forEach((metric, i) => {
      const xx = x + i * (cardW + 0.18);
      slide.addShape(pptx.ShapeType.rect, { x: xx, y, w: cardW, h: 0.92, fill: { color: C.panel }, line: { color: C.border } });
      slide.addText(firstNonEmpty(metric?.value, metric?.metric, metric), { x: xx + 0.16, y: y + 0.14, w: cardW - 0.28, h: 0.28, fontSize: 17, bold: true, color: C.text, margin: 0, fit: 'shrink' });
      slide.addText(firstNonEmpty(metric?.label, metric?.name, metric?.context), { x: xx + 0.16, y: y + 0.52, w: cardW - 0.28, h: 0.22, fontSize: 7.8, color: C.muted, margin: 0, fit: 'shrink' });
    });
  };

  const addTable = (slide: any, table: any, x: number, y: number, w: number, h: number) => {
    const t = tableFromAny(table);
    if (!t || t.headers.length === 0) return false;
    const rows = [t.headers, ...t.rows.slice(0, 6)].map(row => row.map(cleanArtifactText));
    if (t.title) slide.addText(t.title, { x, y: y - 0.3, w, h: 0.2, fontSize: 8.5, color: C.muted, margin: 0 });
    slide.addTable(rows, {
      x, y, w, h,
      fontSize: 8.5,
      color: C.text,
      border: { type: 'solid', color: C.border, pt: 0.45 },
      fill: { color: C.panel },
      margin: 0.06,
      fit: 'shrink',
    });
    return true;
  };

  const addNotes = (slide: any, s: any) => {
    const notes = cleanArtifactText(s.speaker_notes) || [s.headline, s.body, ...s.bullets].filter(Boolean).join('\n');
    if (notes && typeof slide.addNotes === 'function') slide.addNotes(notes);
  };

  normalizedSlides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    addShell(slide, idx, s.layout.replace(/_/g, ' ').toUpperCase());
    addNotes(slide, s);

    if (s.layout === 'cover') {
      slide.addText('MEDINA INTELLIGENCE', { x: 0.72, y: 0.62, w: 3.0, h: 0.22, fontSize: 8.5, color: C.purple, charSpace: 1.8, margin: 0 });
      slide.addText(s.title || title, { x: 0.74, y: 1.95, w: 8.6, h: 0.82, fontSize: 34, bold: true, color: C.text, margin: 0.01, fit: 'shrink' });
      slide.addText(s.headline || s.subtitle || 'Prepared by MARTy', { x: 0.78, y: 2.93, w: 7.8, h: 0.72, fontSize: 15, color: 'E9D5FF', margin: 0.02, fit: 'shrink' });
      addEvidenceBlocks(slide, s.evidence_blocks.length ? s.evidence_blocks : ['Executive storyline', 'Evidence-first structure', 'Editable PowerPoint'], 8.55, 1.48, 3.85, 3.1);
      slide.addText(s.subtitle || 'Prepared by MARTy', { x: 0.78, y: 6.65, w: 4.0, h: 0.24, fontSize: 9.5, color: C.muted, margin: 0 });
      return;
    }

    addHeadline(slide, s);
    const table = s.table;
    const metrics = s.metrics;
    if (metrics.length > 0) addMetrics(slide, metrics, 0.56, 1.86, 5.9);

    if (s.layout === 'matrix' || s.layout === 'evidence') {
      const hasTable = addTable(slide, table, 6.62, 1.2, 5.85, 4.85);
      if (!hasTable) addEvidenceBlocks(slide, s.evidence_blocks.length ? s.evidence_blocks : s.bullets, 6.82, 1.25, 5.35, 4.55);
      if (s.body) slide.addText(s.body, { x: 0.56, y: metrics.length ? 3.05 : 2.0, w: 5.7, h: 1.05, fontSize: 12.5, color: 'E5E7EB', margin: 0.03, fit: 'shrink' });
      addBullets(slide, s.bullets.slice(0, 4), 0.76, s.body ? 3.28 : (metrics.length ? 3.05 : 2.05), 5.5, 2.95);
    } else if (s.layout === 'timeline' || s.layout === 'next_steps') {
      const items: string[] = s.bullets.length ? s.bullets : s.evidence_blocks;
      const visible = items.slice(0, 5);
      visible.forEach((item: string, i: number) => {
        const x = 0.76 + i * 2.42;
        slide.addShape(pptx.ShapeType.rect, { x, y: 3.0, w: 2.02, h: 1.48, fill: { color: C.panel }, line: { color: i === 0 ? C.magenta : C.border } });
        slide.addText(String(i + 1).padStart(2, '0'), { x: x + 0.15, y: 3.16, w: 0.45, h: 0.22, fontSize: 8.5, bold: true, color: C.magenta, margin: 0 });
        slide.addText(item, { x: x + 0.15, y: 3.52, w: 1.68, h: 0.64, fontSize: 10.5, bold: true, color: C.text, margin: 0.02, fit: 'shrink' });
      });
      addTable(slide, table, 6.76, 1.35, 5.6, 1.2);
    } else if (s.layout === 'risk') {
      addEvidenceBlocks(slide, s.evidence_blocks.length ? s.evidence_blocks : ['Primary risk', 'Mitigation', 'Owner'], 0.72, 2.05, 5.35, 3.8);
      addBullets(slide, s.bullets, 7.0, 1.65, 5.05, 3.95, 13);
    } else {
      if (s.body) slide.addText(s.body, { x: 0.58, y: 1.95, w: 5.9, h: 1.2, fontSize: 12.5, color: 'E5E7EB', margin: 0.03, fit: 'shrink' });
      addBullets(slide, s.bullets, 0.78, s.body ? 3.3 : 2.0, 5.75, 3.1);
      addEvidenceBlocks(slide, s.evidence_blocks.length ? s.evidence_blocks : s.bullets.slice(0, 3), 6.85, 1.35, 5.25, 4.55);
    }

    if (s.source_note) {
      slide.addText(`Source note: ${s.source_note}`, { x: 0.58, y: 6.75, w: 9.7, h: 0.2, fontSize: 7.5, color: C.dim, margin: 0, fit: 'shrink' });
    }
  });
  const out = await pptx.write({ outputType: 'arraybuffer' });
  return new Uint8Array(out as ArrayBuffer);
}

function pdfSafeText(value: any): string {
  return cleanArtifactText(value).replace(/[^\x20-\x7E]/g, '-');
}

async function makePdf(title: string, content: any): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 724;
  const margin = 54;
  const contentWidth = 612 - margin * 2;
  const accent = rgb(0.75, 0.15, 0.83);
  const ink = rgb(0.10, 0.10, 0.12);
  const muted = rgb(0.42, 0.42, 0.48);
  const addPage = () => {
    page = pdf.addPage([612, 792]);
    y = 724;
  };
  const ensureSpace = (height: number) => {
    if (y - height < 58) addPage();
  };
  const linesFor = (text: string, size: number, f = font, maxWidth = contentWidth): string[] => {
    const words = pdfSafeText(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [''];
  };
  const addLine = (text: string, size = 11, isBold = false, color = ink, x = margin) => {
    ensureSpace(size + 9);
    page.drawText(pdfSafeText(text), { x, y, size, font: isBold ? bold : font, color });
    y -= size + 7;
  };
  const addWrapped = (text: string, size = 11, isBold = false, color = ink, x = margin, maxWidth = contentWidth, after = 8) => {
    const f = isBold ? bold : font;
    const lines = linesFor(text, size, f, maxWidth);
    ensureSpace(lines.length * (size + 5) + after);
    for (const line of lines) {
      page.drawText(line, { x, y, size, font: f, color });
      y -= size + 5;
    }
    y -= after;
  };
  const addTable = (table: { title?: string; headers: string[]; rows: any[][] }) => {
    const headers = table.headers.length > 0 ? table.headers : table.rows[0]?.map((_, i) => `Column ${i + 1}`) || [];
    const rows = table.headers.length > 0 ? table.rows : table.rows.slice(1);
    if (headers.length === 0) return;
    if (table.title) addWrapped(table.title, 10, true, muted, margin, contentWidth, 4);
    const colWidth = contentWidth / headers.length;
    const rowHeight = 26;
    ensureSpace(rowHeight * Math.min(rows.length + 1, 8) + 20);
    page.drawRectangle({ x: margin, y: y - rowHeight + 6, width: contentWidth, height: rowHeight, color: rgb(0.96, 0.91, 0.98), borderColor: rgb(0.86, 0.74, 0.92), borderWidth: 0.5 });
    headers.forEach((h, i) => page.drawText(pdfSafeText(h).slice(0, 28), { x: margin + i * colWidth + 6, y: y - 12, size: 8.5, font: bold, color: rgb(0.35, 0.11, 0.53) }));
    y -= rowHeight;
    for (const row of rows.slice(0, 12)) {
      ensureSpace(rowHeight + 8);
      page.drawRectangle({ x: margin, y: y - rowHeight + 6, width: contentWidth, height: rowHeight, borderColor: rgb(0.88, 0.88, 0.9), borderWidth: 0.5 });
      row.slice(0, headers.length).forEach((cell, i) => {
        const text = linesFor(cell, 8.5, font, colWidth - 12).slice(0, 2);
        text.forEach((line, j) => page.drawText(line, { x: margin + i * colWidth + 6, y: y - 10 - j * 10, size: 8.5, font, color: ink }));
      });
      y -= rowHeight;
    }
    y -= 12;
  };

  page.drawRectangle({ x: 0, y: 0, width: 8, height: 792, color: accent });
  addWrapped(title, 24, true, ink, margin, contentWidth, 6);
  const subtitle = firstNonEmpty(content?.subtitle, 'Prepared by MARTy');
  if (subtitle) addWrapped(subtitle, 10, false, muted, margin, contentWidth, 18);
  if (content?.summary) {
    ensureSpace(78);
    page.drawRectangle({ x: margin, y: y - 62, width: contentWidth, height: 62, color: rgb(0.98, 0.94, 0.99), borderColor: rgb(0.88, 0.73, 0.92), borderWidth: 0.5 });
    const summaryLines = linesFor(String(content.summary), 10.5, bold, contentWidth - 24).slice(0, 4);
    summaryLines.forEach((line, i) => page.drawText(line, { x: margin + 12, y: y - 18 - i * 13, size: 10.5, font: bold, color: rgb(0.35, 0.11, 0.53) }));
    y -= 78;
  }

  const addSection = (section: any) => {
    const heading = cleanArtifactText(section?.heading);
    if (heading) {
      ensureSpace(44);
      y -= 4;
      addLine(heading, 15, true, ink);
      page.drawLine({ start: { x: margin, y: y + 6 }, end: { x: margin + 64, y: y + 6 }, thickness: 1.4, color: accent });
      y -= 6;
    }
    if (section?.summary) addWrapped(String(section.summary), 11, true, rgb(0.23, 0.23, 0.28));
    for (const p of asArray(section?.paragraphs)) addWrapped(String(p), 10.5, false, ink);
    for (const b of asArray(section?.bullets)) addWrapped(`- ${String(b)}`, 10.2, false, ink, margin + 12, contentWidth - 12, 5);
    for (const n of asArray(section?.numbered)) addWrapped(String(n), 10.2, false, ink, margin + 12, contentWidth - 12, 5);
    for (const c of asArray(section?.checklist)) addWrapped(`[ ] ${String(c)}`, 10.2, false, ink, margin + 12, contentWidth - 12, 5);
    for (const table of tablesFrom(section?.tables || section?.table)) addTable(table);
  };

  if (typeof content === 'string') {
    for (const para of content.split(/\n{2,}/).filter(Boolean)) addWrapped(para, 10.5);
  } else {
    for (const p of asArray(content?.paragraphs)) addWrapped(String(p), 10.5);
    for (const b of asArray(content?.bullets || content?.key_points)) addWrapped(`- ${String(b)}`, 10.2, false, ink, margin + 12, contentWidth - 12, 5);
    for (const table of tablesFrom(content?.tables)) addTable(table);
    for (const section of asArray(content?.sections)) addSection(section);
  }

  const pages = pdf.getPages();
  pages.forEach((p, idx) => {
    p.drawText(pdfSafeText(`MARTy - ${title}`).slice(0, 80), { x: margin, y: 30, size: 7.5, font, color: muted });
    p.drawText(`${idx + 1}/${pages.length}`, { x: 548, y: 30, size: 7.5, font, color: muted });
  });
  return await pdf.save();
}

async function makeDeckPdf(title: string, content: any): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const slides = slidesFromContent(title, content);
  const styleId = deckStylePackFrom(content, title);
  const tokens = styleTokens(styleId);
  const hexToRgb = (hex: string) => {
    const clean = hex.replace('#', '');
    const n = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  const bg = hexToRgb(tokens.bg);
  const panel = hexToRgb(tokens.panel);
  const ink = hexToRgb(tokens.text);
  const muted = hexToRgb(tokens.muted);
  const accent = hexToRgb(tokens.accent);
  const accent2 = hexToRgb(tokens.accent2);
  const pageW = 960;
  const pageH = 540;
  const margin = 72;
  const lineHeight = (size: number) => size * 1.24;
  const wrap = (text: string, size: number, font = regular, width = 420) => {
    const words = pdfSafeText(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  slides.forEach((slide, index) => {
    const page = pdf.addPage([pageW, pageH]);
    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: bg });
    page.drawRectangle({ x: 30, y: 52, width: 5, height: pageH - 104, color: accent });
    page.drawRectangle({ x: 37, y: 52, width: 2, height: pageH - 104, color: accent2 });
    page.drawText(index === 0 ? 'MEDINA VENTURES' : inferSlideRole(slide, index).replace(/_/g, ' ').toUpperCase(), {
      x: margin,
      y: pageH - 64,
      size: 8.5,
      font: bold,
      color: accent2,
    });
    const titleLines = wrap(slide.title || title, index === 0 ? 31 : 22, bold, index === 0 ? 620 : 560).slice(0, index === 0 ? 3 : 2);
    let y = index === 0 ? pageH - 142 : pageH - 104;
    for (const line of titleLines) {
      page.drawText(line, { x: margin, y, size: index === 0 ? 31 : 22, font: bold, color: ink });
      y -= lineHeight(index === 0 ? 31 : 22);
    }
    const headline = firstNonEmpty(slide.headline, slide.takeaway, slide.subtitle);
    if (headline) {
      y -= 12;
      for (const line of wrap(headline, 14, bold, 700).slice(0, 3)) {
        page.drawText(line, { x: margin, y, size: 14, font: bold, color: accent2 });
        y -= lineHeight(14);
      }
    }
    const metrics = asArray(slide.metrics).slice(0, 4);
    if (metrics.length > 0) {
      const cardW = 162;
      metrics.forEach((m: any, i: number) => {
        const x = margin + i * (cardW + 14);
        page.drawRectangle({ x, y: 236, width: cardW, height: 72, color: panel, borderColor: accent2, borderWidth: 0.4 });
        page.drawText(pdfSafeText(firstNonEmpty(m?.value, m?.metric, m)).slice(0, 18), { x: x + 12, y: 278, size: 18, font: bold, color: ink });
        page.drawText(pdfSafeText(firstNonEmpty(m?.label, m?.name, m?.context)).slice(0, 30), { x: x + 12, y: 256, size: 8, font: regular, color: muted });
      });
    }
    const bullets = asArray(slide.bullets).map(cleanArtifactText).filter(Boolean).slice(0, 5);
    const evidence = slideEvidenceBlocks(slide).slice(0, 4);
    const list = evidence.length ? evidence : bullets;
    let listY = metrics.length > 0 ? 208 : Math.min(y - 18, 300);
    for (const item of list) {
      page.drawCircle({ x: margin + 3, y: listY + 4, size: 2.5, color: accent });
      for (const line of wrap(item, 11.5, regular, 650).slice(0, 2)) {
        page.drawText(line, { x: margin + 16, y: listY, size: 11.5, font: regular, color: ink });
        listY -= lineHeight(11.5);
      }
      listY -= 8;
    }
    page.drawText(`${index + 1}/${slides.length}`, { x: pageW - 82, y: 26, size: 8.5, font: regular, color: muted });
  });
  return pdf.save();
}

async function artifactBytes(kind: ArtifactKind, title: string, content: any): Promise<Uint8Array> {
  if (kind === 'docx') return makeDocx(title, content);
  if (kind === 'xlsx') return makeXlsx(title, content);
  if (kind === 'pptx') return makePptx(title, content);
  return makePdf(title, content);
}

async function validateGeneratedArtifact(kind: ArtifactKind, bytes: Uint8Array): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  if (bytes.byteLength < 800) issues.push('generated file is unexpectedly small');
  try {
    if (kind === 'pdf') {
      const { PDFDocument } = await import('pdf-lib');
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() < 1) issues.push('PDF has no pages');
      return { ok: issues.length === 0, issues };
    }

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.keys(zip.files);
    if (!entries.includes('[Content_Types].xml')) issues.push('missing Office content types manifest');

    if (kind === 'docx') {
      const xml = await zip.file('word/document.xml')?.async('string');
      if (!xml) issues.push('DOCX missing word/document.xml');
      else {
        if (xml.replace(/<[^>]+>/g, '').trim().length < 80) issues.push('DOCX contains too little readable content');
        const calloutBlocks = xml.match(/<w:p\b[\s\S]*?<w:pStyle[^>]+w:val="Callout"[\s\S]*?<\/w:p>/g) || [];
        for (const block of calloutBlocks) {
          const indent = Number(block.match(/<w:ind[^>]+w:left="(\d+)"/)?.[1] || 0);
          if (indent > 0 && indent < 420) issues.push('DOCX callout left border is too close to the text');
        }
        const gridMatches = [...xml.matchAll(/<w:tblGrid\b[\s\S]*?<\/w:tblGrid>/g)];
        for (const match of gridMatches) {
          const widths = [...match[0].matchAll(/<w:gridCol[^>]+w:w="(\d+)"/g)].map(m => Number(m[1]));
          if (widths.length > 1 && widths.every(w => w <= 200)) issues.push('DOCX table grid columns are too narrow to be readable');
        }
        if (/<w:tblW[^>]+w:type="pct"[^>]+w:w="100%"/.test(xml)) {
          issues.push('DOCX table uses ambiguous 100% percentage width instead of fixed page-safe geometry');
        }
        if (/&lt;\/?(?:w|a|r|wp|xml|table|thead|tbody|tr|td|th):?\b/i.test(xml)) {
          issues.push('DOCX contains escaped raw markup text');
        }
      }
    }

    if (kind === 'xlsx') {
      if (!zip.file('xl/workbook.xml')) issues.push('XLSX missing xl/workbook.xml');
      const worksheetEntries = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e));
      if (worksheetEntries.length < 1) issues.push('XLSX has no worksheets');
      const XLSX = await import('@e965/xlsx');
      const wb = XLSX.read(bytes, { type: 'array' });
      if (wb.SheetNames.length < 1) issues.push('XLSX workbook has no sheet names');
      let nonEmptyCells = 0;
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false }) as any[][];
        nonEmptyCells += meaningfulCellCount(rows);
      }
      if (nonEmptyCells < 10) issues.push('XLSX contains too few meaningful cells');
    }

    if (kind === 'pptx') {
      if (!zip.file('ppt/presentation.xml')) issues.push('PPTX missing ppt/presentation.xml');
      const slideEntries = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e));
      if (slideEntries.length < 6) issues.push('PPTX has too few slides');
      const notesEntries = entries.filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e));
      if (slideEntries.length >= 6 && notesEntries.length < Math.max(3, Math.floor(slideEntries.length / 2))) {
        issues.push('PPTX needs speaker notes');
      }
      let slideText = '';
      let tableSlideCount = 0;
      let denseBulletSlideCount = 0;
      for (const entry of slideEntries.slice(0, 12)) {
        const xml = await zip.file(entry)?.async('string');
        const raw = xml || '';
        slideText += ` ${raw.replace(/<[^>]+>/g, ' ')}`;
        if (raw.includes('<a:tbl')) tableSlideCount++;
        const bulletCount = (raw.match(/<a:bu/g) || []).length;
        if (bulletCount > 6) denseBulletSlideCount++;
      }
      if (slideText.trim().length < 120) issues.push('PPTX contains too little readable slide text');
      if (slideEntries.length >= 6 && tableSlideCount === 0 && notesEntries.length < slideEntries.length) {
        issues.push('PPTX needs stronger visual evidence surfaces');
      }
      if (denseBulletSlideCount > Math.ceil(slideEntries.length / 2)) issues.push('PPTX is too bullet-heavy');
    }
  } catch (e: any) {
    issues.push(`could not open generated ${kind.toUpperCase()} file: ${e?.message || e}`);
  }
  return { ok: issues.length === 0, issues };
}

function documentTypeForKind(kind: ArtifactKind): string {
  if (kind === 'xlsx') return 'spreadsheet';
  if (kind === 'pptx') return 'presentation';
  if (kind === 'pdf') return 'memo';
  return 'document';
}

function restrictiveVisibility(docs: DocumentRow[]): DocumentVisibility {
  if (docs.some(d => d.visibility === 'private')) return 'private';
  if (docs.some(d => d.visibility === 'confidential')) return 'confidential';
  return 'org_wide';
}

function participantUnion(docs: DocumentRow[], ctx: AuthContext, visibility: DocumentVisibility): string[] | null {
  if (visibility !== 'private') return null;
  const participants = new Set<string>([ctx.userId]);
  for (const doc of docs) {
    try {
      const raw = doc.participant_user_ids ? JSON.parse(doc.participant_user_ids) : [];
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') participants.add(id);
    } catch { /* ignore malformed legacy JSON */ }
    if (doc.uploaded_by) participants.add(doc.uploaded_by);
  }
  return [...participants];
}

function companionFileTitle(title: string, extension: 'html' | 'pdf' | 'json' | 'png'): string {
  const clean = title.trim().replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').slice(0, 100) || 'MARTy deck';
  return clean.toLowerCase().endsWith(`.${extension}`) ? clean : `${clean}.${extension}`;
}

async function persistGeneratedCompanion(
  ctx: AuthContext,
  env: Env,
  opts: {
    title: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array | string;
    extractedText: string;
    visibility: DocumentVisibility;
    participantUserIds: string[] | null;
    parentDocumentId: string;
    customFields: Record<string, unknown>;
  }
): Promise<{ documentId: string; r2Key: string; fileName: string }> {
  const file = new File([opts.bytes], opts.fileName, { type: opts.mimeType });
  const persisted = await persistDocument({
    file,
    orgId: ctx.orgId,
    source: 'marty_generated',
    visibility: opts.visibility,
    participantUserIds: opts.participantUserIds,
    uploadedBy: ctx.userId,
    links: [],
    title: opts.title,
    documentType: 'presentation',
    parentDocumentId: opts.parentDocumentId,
    preExtractedText: opts.extractedText,
    dedupOnContentHash: false,
    embed: false,
  }, env);
  await persisted.finalize();
  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = ?
      WHERE id = ? AND org_id = ?`
  ).bind(
    JSON.stringify({
      marty_generated: true,
      artifact_kind: opts.fileName.split('.').pop() || 'companion',
      artifact_schema_version: 4,
      parent_deck_document_id: opts.parentDocumentId,
      ...opts.customFields,
    }),
    persisted.documentId,
    ctx.orgId
  ).run().catch(() => {});
  return { documentId: persisted.documentId, r2Key: persisted.r2Key, fileName: opts.fileName };
}

async function persistDeckInternalHtmlDocument(
  ctx: AuthContext,
  env: Env,
  opts: {
    title: string;
    html: string;
    extractedText: string;
    customFields: Record<string, unknown>;
  }
): Promise<{ documentId: string; r2Key: string }> {
  const fileName = companionFileTitle(`${opts.title} - QA Draft HTML`, 'html');
  const file = new File([opts.html], fileName, { type: DECK_HTML_MIME });
  const persisted = await persistDocument({
    file,
    orgId: ctx.orgId,
    source: 'marty_generated',
    visibility: 'org_wide',
    participantUserIds: null,
    uploadedBy: ctx.userId,
    links: [],
    title: `${opts.title} - QA Draft HTML`,
    documentType: 'presentation',
    preExtractedText: opts.extractedText,
    dedupOnContentHash: false,
    embed: false,
  }, env);
  await persisted.finalize();
  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = ?
      WHERE id = ? AND org_id = ?`
  ).bind(
    JSON.stringify({
      marty_generated: true,
      artifact_kind: 'html',
      artifact_schema_version: 4,
      deck_companion_kind: 'qa_blocked_html_draft',
      html_source_of_truth: true,
      ...opts.customFields,
    }),
    persisted.documentId,
    ctx.orgId
  ).run().catch(() => {});
  return { documentId: persisted.documentId, r2Key: persisted.r2Key };
}

function deckQaSummary(qa: DeckQaReport | null | undefined): Record<string, unknown> | null {
  if (!qa) return null;
  const bySeverity = qa.slideFindings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] || 0) + 1;
    return acc;
  }, {});
  return {
    status: qa.status,
    findings: qa.slideFindings.length,
    critical: bySeverity.critical || 0,
    high: bySeverity.high || 0,
    medium: bySeverity.medium || 0,
    low: bySeverity.low || 0,
    checks: qa.checks,
  };
}

function deckBlockingFindings(qa: DeckQaReport | null | undefined, limit = 6): DeckQaReport['slideFindings'] {
  if (!qa) return [];
  return qa.slideFindings
    .filter(f => f.severity === 'critical' || f.severity === 'high')
    .slice(0, limit);
}

function deckVisibleDocumentIdsForQa(
  qaPassed: boolean,
  job: { pptx_document_id?: string | null; html_document_id?: string | null; pdf_document_id?: string | null },
  rendererPdfDocumentId?: string | null
): string[] {
  if (!qaPassed) return [];
  return [job.pptx_document_id, job.html_document_id, rendererPdfDocumentId || job.pdf_document_id]
    .filter(Boolean) as string[];
}

function deckDiagnosticDocumentIdsForStatus(
  status: string | null | undefined,
  screenshotDocumentIds: string[] = [],
  qaDocumentId?: string | null
): string[] {
  if (status !== 'qa_blocked') return [];
  return [...screenshotDocumentIds.slice(0, 8), qaDocumentId].filter(Boolean) as string[];
}

function deckStatusLabel(job: any, qa: DeckQaReport | null | undefined): string {
  const status = String(job?.status || '');
  const phase = String(job?.phase || '');
  const round = Number(job?.revision_round || 0);
  const maxRounds = Number(job?.max_revision_rounds || MAX_DECK_REVISION_ROUNDS);
  if (status === 'completed') return 'Deck ready';
  if (status === 'qa_blocked') return 'QA blocked: needs revision';
  if (status === 'failed') return 'Deck render failed';
  if (status === 'cancelled') return 'Deck cancelled';
  if (status === 'revising' || phase === 'repair') return `Revision ${Math.min(Math.max(round, 1), maxRounds)}/${maxRounds}: fixing layout`;
  if (phase === 'planning' || phase === 'narrative') return 'Planning story';
  if (phase === 'html_render') return 'Building HTML';
  if (phase === 'render_qa') return qa?.status && qa.status !== 'pass' ? 'QA found layout issues' : 'Rendering screenshots';
  if (phase === 'export') return 'Exporting PDF/PPTX';
  return 'Working on deck';
}

async function documentCardsForIds(
  ctx: AuthContext,
  env: Env,
  ids: string[],
  mode: MartyDocumentCardMode = 'dominant'
): Promise<MartyDocumentCard[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean))).slice(0, 12);
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await env.D1.prepare(
    `SELECT id, title, document_type, source, r2_key, file_name, file_size, mime_type,
            extracted_text_preview, contact_id, company_id, deal_id, uploaded_by,
            visibility, participant_user_ids, parent_document_id, version_number, created_at
       FROM documents
      WHERE org_id = ? AND id IN (${placeholders})`
  ).bind(ctx.orgId, ...uniqueIds).all<DocumentRow>();
  const byId = new Map((rows.results || []).map(row => [row.id, row]));
  return uniqueIds
    .map(id => byId.get(id))
    .filter((doc): doc is DocumentRow => Boolean(doc))
    .map(doc => cardFromDoc(doc, mode, { reason: 'QA-approved deck export', confidence: 1, generated: true }));
}

async function persistDeckVisibleCardsOnMessage(
  ctx: AuthContext,
  env: Env,
  assistantMessageId: string | null | undefined,
  cards: MartyDocumentCard[]
): Promise<void> {
  if (!assistantMessageId || cards.length === 0) return;
  const row = await env.D1.prepare(
    `SELECT metadata
       FROM agent_messages
      WHERE id = ? AND org_id = ?
      LIMIT 1`
  ).bind(assistantMessageId, ctx.orgId).first<{ metadata: string | null }>().catch(() => null);
  let metadata: Record<string, any> = {};
  try {
    metadata = row?.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  metadata.document_cards = normalizeDocumentCards([...(metadata.document_cards || []), ...cards]);
  await env.D1.prepare(
    `UPDATE agent_messages
        SET metadata = ?
      WHERE id = ? AND org_id = ?`
  ).bind(JSON.stringify(metadata), assistantMessageId, ctx.orgId).run().catch(() => {});
}

export async function getDeckJobSnapshot(
  ctx: AuthContext,
  env: Env,
  jobId: string
): Promise<any | null> {
  const job = await env.D1.prepare(
    `SELECT *
       FROM deck_artifact_jobs
      WHERE id = ? AND org_id = ?
        AND (user_id = ? OR ? IN (SELECT id FROM users WHERE role IN ('owner','admin','super_admin')))
      LIMIT 1`
  ).bind(jobId, ctx.orgId, ctx.userId, ctx.userId).first<any>();
  if (!job) return null;
  const qa = safeJsonParse<DeckQaReport | null>(job.qa_report_json, null);
  const visibleIds = safeJsonParse<string[]>(job.user_visible_document_ids_json, []);
  const screenshotIds = safeJsonParse<string[]>(job.screenshot_document_ids_json, []);
  const diagnosticIds = deckDiagnosticDocumentIdsForStatus(job.status, screenshotIds, job.qa_document_id);
  const visibleCards = await documentCardsForIds(ctx, env, visibleIds, 'dominant').catch(() => []);
  const diagnosticCards = await documentCardsForIds(ctx, env, diagnosticIds, 'compact').catch(() => []);
  const latestEvent = await env.D1.prepare(
    `SELECT seq, event_type, payload_json, created_at
       FROM deck_artifact_job_events
      WHERE job_id = ? AND org_id = ?
      ORDER BY seq DESC
      LIMIT 1`
  ).bind(jobId, ctx.orgId).first<any>().catch(() => null);
  const latestPayload = safeJsonParse<Record<string, any>>(latestEvent?.payload_json, {});
  return {
    ...job,
    plan: safeJsonParse(job.plan_json, null),
    fact_ledger: safeJsonParse(job.fact_ledger_json, null),
    qa_report: qa,
    qa_summary: deckQaSummary(qa),
    qa_findings: deckBlockingFindings(qa),
    render_result: safeJsonParse(job.render_result_json, null),
    output_formats: safeJsonParse(job.output_formats_json, []),
    screenshot_document_ids: screenshotIds,
    user_visible_document_ids: visibleIds,
    visible_document_cards: visibleCards,
    diagnostic_document_ids: diagnosticIds,
    diagnostic_document_cards: diagnosticCards,
    status_label: deckStatusLabel(job, qa),
    revision_round: Number(job.revision_round || 0),
    max_revision_rounds: Number(job.max_revision_rounds || MAX_DECK_REVISION_ROUNDS),
    blocked_reason: job.blocked_reason || null,
    last_event_seq: Number(latestEvent?.seq || 0),
    last_event_type: latestEvent?.event_type || null,
    last_event_message: cleanArtifactText(latestPayload.message || ''),
    last_event_created_at: latestEvent?.created_at || null,
  };
}

export async function getDeckJobEventsSnapshot(
  ctx: AuthContext,
  env: Env,
  jobId: string,
  afterSeq = 0
): Promise<{ job: any | null; events: any[] }> {
  const job = await getDeckJobSnapshot(ctx, env, jobId);
  if (!job) return { job: null, events: [] };
  const rows = await env.D1.prepare(
    `SELECT seq, event_type, payload_json, created_at
       FROM deck_artifact_job_events
      WHERE job_id = ? AND org_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT 200`
  ).bind(jobId, ctx.orgId, afterSeq).all<any>();
  return {
    job,
    events: rows.results.map(row => ({
      seq: row.seq,
      event_type: row.event_type,
      payload: safeJsonParse(row.payload_json, {}),
      created_at: row.created_at,
    })),
  };
}

export async function applyDeckRenderResult(
  ctx: AuthContext,
  env: Env,
  result: DeckRenderResult
): Promise<void> {
  const job = await env.D1.prepare(
    `SELECT *
       FROM deck_artifact_jobs
      WHERE id = ? AND org_id = ?
      LIMIT 1`
  ).bind(result.job_id, ctx.orgId).first<any>();
  if (!job) throw new Error('DECK_JOB_NOT_FOUND');

  const qa = result.qa_report || safeJsonParse<DeckQaReport | null>(job.qa_report_json, null);
  const screenshotDocumentIds: string[] = [];
  const participantUserIds = null;
  const visibility: DocumentVisibility = 'org_wide';
  const parentDocumentId = job.pptx_document_id || job.html_document_id || job.pdf_document_id;
  if (!parentDocumentId) {
    throw new Error('DECK_RENDER_PARENT_DOCUMENT_NOT_READY');
  }

  await updateDeckJobPhase(env, job.id, job.org_id, 'render_qa', {
    status: result.status,
    findings: qa?.slideFindings?.length || 0,
  });

  if (Array.isArray(result.screenshots)) {
    for (const screenshot of result.screenshots.slice(0, 40)) {
      if (!screenshot.base64) continue;
      const doc = await persistGeneratedCompanion(ctx, env, {
        title: `${job.title} - Slide ${screenshot.index}`,
        fileName: companionFileTitle(`${job.title} - slide-${String(screenshot.index).padStart(2, '0')}`, 'png'),
        mimeType: screenshot.mimeType || 'image/png',
        bytes: bytesFromBase64(screenshot.base64),
        extractedText: `Rendered screenshot for ${job.title}, slide ${screenshot.index}.`,
        visibility,
        participantUserIds,
        parentDocumentId,
        customFields: {
          deck_companion_kind: 'rendered_slide_screenshot',
          deck_job_id: job.id,
          slide_id: screenshot.slideId,
          slide_index: screenshot.index,
          width: screenshot.width,
          height: screenshot.height,
        },
      });
      screenshotDocumentIds.push(doc.documentId);
    }
  }

  let rendererPdfDocumentId: string | null = null;
  const qaPassed = (qa?.status || result.status) === 'pass' && !result.error;
  if (qaPassed && result.pdf_base64) {
    const pdfDoc = await persistGeneratedCompanion(ctx, env, {
      title: `${job.title} - Rendered PDF Export`,
      fileName: companionFileTitle(`${job.title} - Rendered PDF Export`, 'pdf'),
      mimeType: MIME_BY_KIND.pdf,
      bytes: bytesFromBase64(result.pdf_base64),
      extractedText: `Rendered PDF export for ${job.title}.`,
      visibility,
      participantUserIds,
      parentDocumentId,
      customFields: {
        deck_companion_kind: 'playwright_pdf_export',
        deck_job_id: job.id,
        deck_qa_status: result.status,
      },
    });
    rendererPdfDocumentId = pdfDoc.documentId;
  }

  let qaDocumentId: string | null = null;
  if (qa) {
    const qaDoc = await persistGeneratedCompanion(ctx, env, {
      title: `${job.title} - QA Report`,
      fileName: companionFileTitle(`${job.title} - QA Report`, 'json'),
      mimeType: 'application/json; charset=utf-8',
      bytes: JSON.stringify({ job_id: job.id, qa_report: qa, metrics: result.metrics || {} }, null, 2),
      extractedText: [
        `Deck QA status: ${qa.status}`,
        ...qa.slideFindings.map(f => `${f.severity}: ${f.slideId}: ${f.issue} -> ${f.requiredFix}`),
      ].join('\n').slice(0, 8000),
      visibility,
      participantUserIds,
      parentDocumentId,
      customFields: {
        deck_companion_kind: 'qa_report',
        deck_job_id: job.id,
        deck_qa_status: qa.status,
      },
    });
    qaDocumentId = qaDoc.documentId;
  }

  const status: DeckJobStatus = result.error ? 'failed' : (qaPassed ? 'completed' : 'qa_blocked');
  const phase: DeckJobPhase = result.error ? 'failed' : (qaPassed ? 'complete' : 'qa_blocked');
  const userVisibleIds = deckVisibleDocumentIdsForQa(qaPassed, job, rendererPdfDocumentId);
  const diagnosticIds = deckDiagnosticDocumentIdsForStatus(status, screenshotDocumentIds, qaDocumentId);
  const blockedReason = !qaPassed && !result.error
    ? deckBlockingFindings(qa, 3)
      .slice(0, 3)
      .map(f => `${f.slideId}: ${f.issue}`)
      .join('; ') || 'Screenshot QA found layout issues that must be revised before export.'
    : null;
  await env.D1.prepare(
    `UPDATE deck_artifact_jobs
        SET status = ?,
            phase = ?,
            qa_report_json = ?,
            render_result_json = ?,
            pdf_document_id = COALESCE(?, pdf_document_id),
            screenshot_document_ids_json = ?,
            qa_document_id = COALESCE(?, qa_document_id),
            blocked_reason = ?,
            user_visible_document_ids_json = ?,
            error_code = ?,
            error_message = ?,
            completed_at = CASE WHEN ? IN ('completed','failed','qa_blocked') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    status,
    phase,
    qa ? JSON.stringify(qa) : null,
    JSON.stringify({ ...result, screenshots: result.screenshots?.map(s => ({ ...s, base64: undefined })) || [] }),
    rendererPdfDocumentId,
    JSON.stringify(screenshotDocumentIds),
    qaDocumentId,
    blockedReason,
    qaPassed ? JSON.stringify(userVisibleIds) : null,
    result.error ? 'DECK_RENDER_FAILED' : null,
    result.error ? String(result.error).slice(0, 500) : null,
    status,
    job.id,
    job.org_id
  ).run();

  if (qaPassed && userVisibleIds.length > 0) {
    const visibleCards = await documentCardsForIds(ctx, env, userVisibleIds, 'dominant').catch(() => []);
    await persistDeckVisibleCardsOnMessage(ctx, env, job.assistant_message_id, visibleCards).catch(() => {});
  }

  await appendDeckJobEvent(env, job.id, job.org_id, status === 'completed' ? 'complete' : status, {
    status,
    phase,
    qa_status: qa?.status || result.status,
    status_label: deckStatusLabel({ ...job, status, phase, revision_round: job.revision_round, max_revision_rounds: job.max_revision_rounds }, qa),
    screenshot_document_ids: screenshotDocumentIds,
    pdf_document_id: rendererPdfDocumentId,
    qa_document_id: qaDocumentId,
    qa_findings: deckBlockingFindings(qa),
    user_visible_document_ids: userVisibleIds,
    visible_document_cards: qaPassed ? await documentCardsForIds(ctx, env, userVisibleIds, 'dominant').catch(() => []) : [],
    diagnostic_document_ids: diagnosticIds,
    diagnostic_document_cards: status === 'qa_blocked' ? await documentCardsForIds(ctx, env, diagnosticIds, 'compact').catch(() => []) : [],
    blocked_reason: blockedReason,
    error: result.error || null,
  }).catch(() => {});
}

async function persistArtifact(
  ctx: AuthContext,
  env: Env,
  opts: {
    kind: ArtifactKind;
    title: string;
    structuredContent: any;
    sourceDocs: DocumentRow[];
    parentDocumentId?: string | null;
    embed?: boolean;
    visibility?: DocumentVisibility;
    customFields?: Record<string, unknown>;
    prepared?: boolean;
  }
): Promise<{ card: MartyDocumentCard; document: { id: string; title: string; file_name: string; mime_type: string } }> {
  const inputContent = normalizeStructuredArtifactContent(opts.structuredContent);
  let structuredContent = opts.prepared
    ? inputContent
    : await prepareArtifactContent(opts.kind, opts.title, inputContent, ctx, env, opts.sourceDocs);
  let deckBundle: { plan: DeckPlan; html: string; qa: DeckQaReport } | null = null;
  if (opts.kind === 'pptx') {
    let html = renderPremiumDeckHtml(opts.title, structuredContent);
    let qa = evaluatePremiumDeckQa(opts.title, structuredContent, html);
    if (qa.status === 'failed') {
      structuredContent = await repairArtifactContent(
        opts.kind,
        opts.title,
        structuredContent,
        ctx,
        env,
        opts.sourceDocs,
        qa.slideFindings.map(f => `${f.severity}: ${f.issue} ${f.requiredFix}`)
      );
      html = renderPremiumDeckHtml(opts.title, structuredContent);
      qa = evaluatePremiumDeckQa(opts.title, structuredContent, html);
    }
    deckBundle = {
      plan: deckPlanFromContent(opts.title, structuredContent),
      html,
      qa,
    };
  }
  let bytes: Uint8Array | null = null;
  let validation: { ok: boolean; issues: string[] };
  try {
    bytes = await artifactBytes(opts.kind, opts.title, structuredContent);
    validation = await validateGeneratedArtifact(opts.kind, bytes);
  } catch (error: any) {
    validation = {
      ok: false,
      issues: [`artifact generation failed before validation: ${String(error?.message || error).slice(0, 220)}`],
    };
  }
  if (!validation.ok) {
    structuredContent = await repairArtifactContent(opts.kind, opts.title, structuredContent, ctx, env, opts.sourceDocs, validation.issues);
    if (contentQualityIssues(opts.kind, structuredContent).length > 0) {
      structuredContent = defaultArtifactContent(opts.kind, opts.title, structuredContent);
    }
    try {
      bytes = await artifactBytes(opts.kind, opts.title, structuredContent);
      validation = await validateGeneratedArtifact(opts.kind, bytes);
    } catch (error: any) {
      bytes = null;
      validation = {
        ok: false,
        issues: [`artifact generation failed after repair: ${String(error?.message || error).slice(0, 220)}`],
      };
    }
  }
  if (deckBundle?.qa.status === 'failed') {
    validation = {
      ok: false,
      issues: [
        ...validation.issues,
        ...deckBundle.qa.slideFindings
          .filter(f => f.severity === 'critical')
          .map(f => `deck QA critical: ${f.issue}`),
      ],
    };
  }
  if (!validation.ok || !bytes) {
    throw new Error(`MARTy could not create a valid ${opts.kind.toUpperCase()} file yet. ${validation.issues.join('; ')}`);
  }
  const fileName = fileTitle(opts.title, opts.kind);
  const file = new File([bytes], fileName, { type: MIME_BY_KIND[opts.kind] });
  const visibility = opts.visibility || restrictiveVisibility(opts.sourceDocs);
  const participantUserIds = participantUnion(opts.sourceDocs, ctx, visibility);
  const links: DocumentLink[] = [];
  const primarySource = opts.sourceDocs.find(d => d.deal_id || d.company_id || d.contact_id);
  if (primarySource?.deal_id) links.push({ entityType: 'deal', entityId: primarySource.deal_id, linkKind: 'derived', linkSource: 'llm_extracted' });
  else if (primarySource?.company_id) links.push({ entityType: 'company', entityId: primarySource.company_id, linkKind: 'derived', linkSource: 'llm_extracted' });
  else if (primarySource?.contact_id) links.push({ entityType: 'contact', entityId: primarySource.contact_id, linkKind: 'derived', linkSource: 'llm_extracted' });

  const extractedText = plainTextFromStructured(structuredContent);
  const persisted = await persistDocument({
    file,
    orgId: ctx.orgId,
    source: 'marty_generated',
    visibility,
    participantUserIds,
    uploadedBy: ctx.userId,
    links,
    title: opts.title,
    documentType: documentTypeForKind(opts.kind),
    parentDocumentId: opts.parentDocumentId || undefined,
    preExtractedText: extractedText,
    dedupOnContentHash: false,
    embed: opts.embed !== false,
  }, env);
  await persisted.finalize();

  const companionFields: Record<string, unknown> = {};
  if (deckBundle) {
    try {
      const htmlDoc = await persistGeneratedCompanion(ctx, env, {
        title: `${opts.title} - HTML Preview`,
        fileName: companionFileTitle(`${opts.title} - HTML Preview`, 'html'),
        mimeType: DECK_HTML_MIME,
        bytes: deckBundle.html,
        extractedText: [
          deckBundle.plan.title,
          deckBundle.plan.storyline.join('\n'),
          ...deckBundle.plan.slides.map(s => `${s.role}: ${s.headline}`),
        ].join('\n').slice(0, 8000),
        visibility,
        participantUserIds,
        parentDocumentId: persisted.documentId,
        customFields: {
          deck_companion_kind: 'html_source',
          html_source_of_truth: true,
          deck_style_pack: deckBundle.plan.style_pack,
          deck_qa_status: deckBundle.qa.status,
        },
      });
      const pdfBytes = await makeDeckPdf(opts.title, structuredContent);
      const pdfDoc = await persistGeneratedCompanion(ctx, env, {
        title: `${opts.title} - PDF Export`,
        fileName: companionFileTitle(`${opts.title} - PDF Export`, 'pdf'),
        mimeType: MIME_BY_KIND.pdf,
        bytes: pdfBytes,
        extractedText: [
          deckBundle.plan.title,
          deckBundle.plan.storyline.join('\n'),
          ...deckBundle.plan.slides.map(s => `${s.role}: ${s.headline}`),
        ].join('\n').slice(0, 8000),
        visibility,
        participantUserIds,
        parentDocumentId: persisted.documentId,
        customFields: {
          deck_companion_kind: 'pdf_export',
          deck_style_pack: deckBundle.plan.style_pack,
          deck_qa_status: deckBundle.qa.status,
        },
      });
      companionFields.deck_bundle = {
        html_source_of_truth: true,
        html_document_id: htmlDoc.documentId,
        html_r2_key: htmlDoc.r2Key,
        pdf_document_id: pdfDoc.documentId,
        pdf_r2_key: pdfDoc.r2Key,
        style_pack: deckBundle.plan.style_pack,
        qa_report: deckBundle.qa,
        plan: deckBundle.plan,
      };
    } catch (error: any) {
      companionFields.deck_bundle_error = String(error?.message || error).slice(0, 300);
      companionFields.deck_bundle = {
        html_source_of_truth: true,
        style_pack: deckBundle.plan.style_pack,
        qa_report: deckBundle.qa,
        plan: deckBundle.plan,
      };
    }
  }

  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = ?
      WHERE id = ? AND org_id = ?`
  ).bind(
    JSON.stringify({
      marty_generated: true,
      ...(opts.customFields || {}),
      ...companionFields,
      source_document_ids: opts.sourceDocs.map(d => d.id),
      artifact_kind: opts.kind,
      artifact_schema_version: opts.kind === 'pptx' ? 4 : 3,
      artifact_text_length: extractedText.length,
      artifact_validation: validation,
    }),
    persisted.documentId,
    ctx.orgId
  ).run().catch(() => {});

  const doc: DocumentRow = {
    id: persisted.documentId,
    title: opts.title,
    document_type: documentTypeForKind(opts.kind),
    source: 'marty_generated',
    r2_key: persisted.r2Key,
    file_name: fileName,
    file_size: bytes.byteLength,
    mime_type: MIME_BY_KIND[opts.kind],
    extracted_text_preview: extractedText.slice(0, 500),
    contact_id: primarySource?.contact_id || null,
    company_id: primarySource?.company_id || null,
    deal_id: primarySource?.deal_id || null,
    uploaded_by: ctx.userId,
    visibility,
    participant_user_ids: participantUserIds ? JSON.stringify(participantUserIds) : null,
    parent_document_id: opts.parentDocumentId || null,
    version_number: persisted.versionNumber,
    created_at: new Date().toISOString(),
  };
  const card = cardFromDoc(doc, 'dominant', {
    reason: opts.parentDocumentId ? 'Created edited copy' : 'Created by MARTy',
    confidence: 1,
    generated: true,
  });
  return {
    card,
    document: { id: doc.id, title: opts.title, file_name: fileName, mime_type: MIME_BY_KIND[opts.kind] },
  };
}

function normalizeArtifactKind(kind: unknown, fallback: ArtifactKind = 'docx'): ArtifactKind {
  return kind === 'xlsx' || kind === 'pptx' || kind === 'pdf' || kind === 'docx' ? kind : fallback;
}

export async function createDocumentArtifactTool(
  ctx: AuthContext,
  input: {
    kind: ArtifactKind;
    title: string;
    structured_content: any;
    source_document_ids?: string[];
    embed?: boolean;
    visibility?: DocumentVisibility;
    custom_fields?: Record<string, unknown>;
  },
  env: Env
): Promise<any> {
  const kind = normalizeArtifactKind(input.kind);
  const title = String(input.title || 'MARTy artifact').trim().slice(0, 140);
  const sourceIds = Array.isArray(input.source_document_ids)
    ? input.source_document_ids.filter(id => typeof id === 'string')
    : [];
  const sourceDocs = await loadAccessibleDocuments(sourceIds, ctx, env);
  const result = await persistArtifact(ctx, env, {
    kind,
    title,
    structuredContent: input.structured_content,
    sourceDocs,
    embed: input.embed,
    visibility: input.visibility,
    customFields: input.custom_fields,
  });
  return {
    ok: true,
    document: result.document,
    document_cards: [result.card],
    message: `Created ${result.document.file_name}`,
  };
}

export async function createDeckArtifactTool(
  ctx: AuthContext,
  input: {
    prompt: string;
    title?: string;
    audience?: string;
    objective?: DeckObjective;
    style_pack?: DeckStylePackId;
    output_formats?: Array<'html' | 'pdf' | 'pptx'>;
    quality_mode?: 'fast' | 'premium';
    structured_content?: any;
    source_document_ids?: string[];
  },
  env: Env,
  opts: {
    sessionId?: string | null;
    requestId?: string | null;
    assistantMessageId?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<any> {
  const prompt = String(input.prompt || '').trim();
  const title = String(input.title || prompt.split(/[.!?\n]/)[0] || 'MARTy deck').trim().slice(0, 140);
  const deckJobId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const qualityMode = input.quality_mode || 'premium';
  const outputFormats = normalizeDeckOutputFormats(input.output_formats);
  const structured = normalizeStructuredArtifactContent(input.structured_content || {
    title,
    subtitle: 'Prepared by MARTy',
    summary: prompt,
    audience: input.audience,
    objective: input.objective,
    style_pack: input.style_pack || 'medina_default',
    storyline: [
      'Clarify the decision or narrative the audience needs.',
      'Translate the strongest evidence into visual proof objects.',
      'Close with the recommendation, owner, or next action.',
    ],
    slides: [
      { layout: 'cover', title, subtitle: 'Prepared by MARTy', headline: prompt },
      { layout: 'executive_summary', title: 'Executive Takeaway', headline: prompt, evidence_blocks: ['Audience-ready claim spine', 'Evidence-first slide plan', 'QA-gated export'] },
      { layout: 'matrix', title: 'Narrative Spine', headline: 'The deck should move from context to evidence to action.', table: { headers: ['Section', 'Purpose', 'Proof object'], rows: [['Context', 'Set the stakes', 'Executive frame'], ['Evidence', 'Make the case', 'Metrics / table / map'], ['Action', 'Drive follow-through', 'Next-step owner list']] } },
      { layout: 'evidence', title: 'Evidence To Build Around', headline: 'Each substantive slide needs one proof object, not a paragraph dump.', evidence_blocks: ['Confirmed facts from source material', 'Decision-useful metrics', 'Clear caveats and gaps'] },
      { layout: 'risk', title: 'Open Questions And Risks', headline: 'Unverified claims should be visible before the deck is circulated.', bullets: ['Separate confirmed facts from assumptions', 'Move weak claims to notes or appendix', 'Flag missing source material'] },
      { layout: 'next_steps', title: 'Next Steps', headline: 'Finish by making the next decision easy.', table: { headers: ['Step', 'Owner', 'Output'], rows: [['Review', 'MARTy / team', 'Tightened storyline'], ['Verify', 'Source owner', 'Confirmed metrics'], ['Circulate', 'Deck owner', 'PDF + PPTX bundle']] } },
    ],
  });
  structured.audience = firstNonEmpty(input.audience, structured.audience);
  structured.objective = input.objective || structured.objective;
  structured.style_pack = input.style_pack || structured.style_pack || 'medina_default';
  structured.deck_request = prompt;
  const plan = deckPlanFromContent(title, structured);
  const facts = deckFactsFromContent(title, structured, slidesFromContent(title, structured));
  const asyncRenderer = qualityMode === 'premium' && isDeckRendererEnabled(env);

  await env.D1.prepare(
    `INSERT INTO deck_artifact_jobs
       (id, org_id, user_id, session_id, request_id, assistant_message_id,
        status, phase, title, prompt, audience, objective, style_pack,
        quality_mode, output_formats_json, structured_content_json,
        source_document_ids_json, plan_json, fact_ledger_json, started_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    deckJobId,
    ctx.orgId,
    ctx.userId,
    opts.sessionId || null,
    opts.requestId || null,
    opts.assistantMessageId || null,
    asyncRenderer ? 'queued' : 'running',
    title,
    prompt,
    input.audience || null,
    input.objective || null,
    input.style_pack || structured.style_pack || 'medina_default',
    qualityMode,
    JSON.stringify(outputFormats),
    JSON.stringify(structured),
    JSON.stringify(Array.isArray(input.source_document_ids) ? input.source_document_ids : []),
    JSON.stringify(plan),
    JSON.stringify(facts),
    startedAt,
    startedAt
  ).run().catch(() => {});
  await appendDeckJobEvent(env, deckJobId, ctx.orgId, 'created', {
    job_id: deckJobId,
    status: asyncRenderer ? 'queued' : 'running',
    phase: 'planning',
    title,
    quality_mode: qualityMode,
    renderer_enabled: asyncRenderer,
    revision_round: 0,
    max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
    message: 'Planning story',
  }).catch(() => {});

  if (asyncRenderer) {
    await enqueueWork(env, ctx.orgId, DECK_RENDER_WORK_DOMAIN, {
      deck_job_id: deckJobId,
    }, {
      upstream: 'deck-renderer',
      idempotency_key: `${ctx.orgId}:${deckJobId}:deck_render`,
      max_attempts: 2,
      priority: 8,
    });
    await appendDeckJobEvent(env, deckJobId, ctx.orgId, 'queued', {
      phase: 'planning',
      status: 'queued',
      revision_round: 0,
      max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
      message: 'Premium deck job queued for HTML render, screenshot QA, and export.',
    }).catch(() => {});
    return {
      ok: true,
      deck_job_id: deckJobId,
      deck_job: {
        id: deckJobId,
        status: 'queued',
        phase: 'planning',
        title,
        quality_mode: qualityMode,
        output_formats: outputFormats,
      },
      document_cards: [],
      message: 'Premium deck job queued. MARTy will render, QA, and export the deck before marking it complete.',
    };
  }

  try {
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET phase = 'visual_direction',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(deckJobId, ctx.orgId).run().catch(() => {});
    await appendDeckJobEvent(env, deckJobId, ctx.orgId, 'phase', {
      phase: 'visual_direction',
      message: 'Deck plan and style direction prepared.',
    }).catch(() => {});

    const result = await createDocumentArtifactTool(ctx, {
      kind: 'pptx',
      title,
      structured_content: structured,
      source_document_ids: input.source_document_ids,
      custom_fields: {
        deck_tool: 'create_deck_artifact',
        deck_job_id: deckJobId,
        deck_quality_mode: qualityMode,
        requested_output_formats: outputFormats,
        requested_audience: input.audience || null,
        requested_objective: input.objective || null,
        requested_style_pack: input.style_pack || 'medina_default',
      },
    }, env);

    const persisted = result?.document?.id
      ? await env.D1.prepare(
        `SELECT custom_fields FROM documents WHERE id = ? AND org_id = ?`
      ).bind(result.document.id, ctx.orgId).first<{ custom_fields: string | null }>().catch(() => null)
      : null;
    let deckBundle: any = null;
    try {
      deckBundle = persisted?.custom_fields ? JSON.parse(persisted.custom_fields)?.deck_bundle : null;
    } catch { deckBundle = null; }

    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET status = 'completed',
              phase = 'complete',
              pptx_document_id = ?,
              html_document_id = ?,
              pdf_document_id = ?,
              qa_report_json = ?,
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      result?.document?.id || null,
      deckBundle?.html_document_id || null,
      deckBundle?.pdf_document_id || null,
      deckBundle?.qa_report ? JSON.stringify(deckBundle.qa_report) : null,
      deckJobId,
      ctx.orgId
    ).run().catch(() => {});
    await appendDeckJobEvent(env, deckJobId, ctx.orgId, 'complete', {
      phase: 'complete',
      pptx_document_id: result?.document?.id || null,
      html_document_id: deckBundle?.html_document_id || null,
      pdf_document_id: deckBundle?.pdf_document_id || null,
      qa_status: deckBundle?.qa_report?.status || null,
    }).catch(() => {});

    return { ...result, deck_job_id: deckJobId };
  } catch (error: any) {
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET status = 'failed',
              phase = 'failed',
              error_code = 'DECK_ARTIFACT_FAILED',
              error_message = ?,
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(String(error?.message || error).slice(0, 500), deckJobId, ctx.orgId).run().catch(() => {});
    await appendDeckJobEvent(env, deckJobId, ctx.orgId, 'failed', {
      phase: 'failed',
      error_code: 'DECK_ARTIFACT_FAILED',
      error_message: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
    throw error;
  }
}

interface DeckArtifactJobRow {
  id: string;
  org_id: string;
  user_id: string | null;
  session_id: string | null;
  request_id: string | null;
  assistant_message_id: string | null;
  status: string;
  phase: string;
  revision_round?: number | null;
  max_revision_rounds?: number | null;
  blocked_reason?: string | null;
  user_visible_document_ids_json?: string | null;
  title: string;
  prompt: string;
  audience: string | null;
  objective: string | null;
  style_pack: DeckStylePackId | null;
  quality_mode: 'fast' | 'premium' | null;
  output_formats_json: string | null;
  structured_content_json: string | null;
  source_document_ids_json: string | null;
  plan_json: string | null;
  fact_ledger_json: string | null;
}

async function callDeckRendererService(
  env: Env,
  request: DeckRenderRequest
): Promise<DeckRenderResult> {
  if (!env.DECK_RENDERER_URL || !env.DECK_RENDERER_TOKEN) {
    throw new Error('DECK_RENDERER_NOT_CONFIGURED');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DECK_RENDERER_TIMEOUT_MS);
  try {
    const base = env.DECK_RENDERER_URL.replace(/\/+$/, '');
    const res = await fetch(`${base}/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DECK_RENDERER_TOKEN}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (!res.ok) {
      if (parsed?.job_id && parsed?.qa_report) return parsed as DeckRenderResult;
      throw new Error(parsed?.error || parsed?.message || `deck renderer returned ${res.status}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('deck renderer returned malformed JSON');
    }
    return parsed as DeckRenderResult;
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectRenderedDeckPage(page: any): Promise<{
  findings: DeckQaReport['slideFindings'];
  metrics: Record<string, unknown>;
}> {
  return page.evaluate(() => {
    const win = globalThis as any;
    const doc = win.document;
    const slides = Array.from(doc.querySelectorAll('.slide')) as any[];
    const findings: Array<{ slideId: string; severity: 'critical' | 'high' | 'medium' | 'low'; issue: string; requiredFix: string }> = [];
    const metrics: Record<string, number> = {
      slide_count: slides.length,
      blank_slide_count: 0,
      overflow_count: 0,
      overlap_count: 0,
      low_contrast_count: 0,
      tiny_type_count: 0,
      bad_margin_count: 0,
      excessive_bullet_slide_count: 0,
      accent_gutter_px: 0,
    };

    function luminance(rgb: string): number {
      const parts = String(rgb || '').match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) || [0, 0, 0];
      const [r, g, b] = parts.map(v => {
        const s = Math.max(0, Math.min(255, v)) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contrast(a: string, b: string): number {
      const l1 = luminance(a);
      const l2 = luminance(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    function rectFor(el: any): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }

    function intersects(a: ReturnType<typeof rectFor>, b: ReturnType<typeof rectFor>): boolean {
      const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const area = x * y;
      if (area < 64) return false;
      const smaller = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
      return area / smaller > 0.08;
    }

    slides.forEach((slide, index) => {
      const slideId = slide.id || `slide_${index + 1}`;
      const rect = rectFor(slide);
      const style = win.getComputedStyle(slide);
      const text = (slide.textContent || '').replace(/\s+/g, ' ').trim();
      const contentEls = Array.from(slide.querySelectorAll('h1,h2,h3,p,li,td,th,.headline,.takeaway,.evidence-card,.metric-card,.table-wrap'))
        .filter(el => {
          const r = (el as any).getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        });

      if (!text && slide.querySelectorAll('img,svg,canvas,table').length === 0) {
        metrics.blank_slide_count += 1;
        findings.push({ slideId, severity: 'critical', issue: 'Rendered slide appears blank.', requiredFix: 'Populate the slide or remove it from the deck.' });
      }

      if (slide.scrollWidth > slide.clientWidth + 3 || slide.scrollHeight > slide.clientHeight + 3) {
        metrics.overflow_count += 1;
        findings.push({ slideId, severity: 'critical', issue: 'Slide content overflows the canvas.', requiredFix: 'Compress copy, reduce density, or split the slide.' });
      }

      if (contentEls.length > 0) {
        const minMargin = Math.min(
          ...contentEls.map(el => {
            const r = rectFor(el);
            return Math.min(r.left - rect.left, rect.right - r.right, r.top - rect.top, rect.bottom - r.bottom);
          })
        );
        if (minMargin < 32) {
          metrics.bad_margin_count += 1;
          findings.push({ slideId, severity: 'high', issue: 'Slide has content too close to the edge.', requiredFix: 'Restore safe margins and rebalance the layout grid.' });
        }
      }

      const tiny = contentEls.filter(el => Number.parseFloat(win.getComputedStyle(el).fontSize || '16') < 11);
      if (tiny.length > 0) {
        metrics.tiny_type_count += 1;
        findings.push({ slideId, severity: 'high', issue: 'Slide contains tiny type below presentation-safe size.', requiredFix: 'Increase type size or move detail to appendix/notes.' });
      }

      const bullets = slide.querySelectorAll('li').length;
      if (bullets > 7) {
        metrics.excessive_bullet_slide_count += 1;
        findings.push({ slideId, severity: 'medium', issue: `Slide has ${bullets} bullets.`, requiredFix: 'Convert the list into a table, matrix, timeline, or proof surface.' });
      }

      const background = style.backgroundColor || 'rgb(15,15,20)';
      const lowContrast = contentEls.filter(el => contrast(win.getComputedStyle(el).color, background) < DECK_MIN_CONTRAST_RATIO);
      if (lowContrast.length > Math.max(2, contentEls.length * 0.15)) {
        metrics.low_contrast_count += 1;
        findings.push({ slideId, severity: 'high', issue: 'Slide has low-contrast text.', requiredFix: 'Increase foreground/background contrast before export.' });
      }

      const blocks = contentEls.slice(0, 60).map(el => rectFor(el));
      let overlap = false;
      for (let i = 0; i < blocks.length && !overlap; i += 1) {
        for (let j = i + 1; j < blocks.length; j += 1) {
          if (intersects(blocks[i], blocks[j])) {
            overlap = true;
            break;
          }
        }
      }
      if (overlap) {
        metrics.overlap_count += 1;
        findings.push({ slideId, severity: 'critical', issue: 'Slide elements appear to overlap.', requiredFix: 'Reflow the slide and increase spacing between elements.' });
      }

      const accent = slide.querySelector('.slide-accent,.accent-line,.purple-line,.callout-accent,[data-accent-line]');
      if (accent) {
        const accentRect = rectFor(accent);
        const textLefts = contentEls.map(el => rectFor(el).left).filter(v => Number.isFinite(v));
        const nearestTextLeft = textLefts.length ? Math.min(...textLefts) : rect.right;
        const gutter = nearestTextLeft - accentRect.right;
        metrics.accent_gutter_px = Math.max(metrics.accent_gutter_px || 0, Math.round(gutter));
        if (gutter < 48) {
          findings.push({ slideId, severity: 'critical', issue: 'Purple accent line is too close to body text.', requiredFix: 'Move the accent line left or increase the text gutter.' });
        }
      }
    });

    return { findings, metrics };
  });
}

async function applyDeckRenderRepairPass(page: any, pass: number): Promise<void> {
  await page.addStyleTag({
    content: `
      :root { --accent-gutter: ${88 + pass * 10}px !important; }
      .slide { overflow: hidden !important; }
      .slide * { box-sizing: border-box !important; }
      .slide-accent, .accent-line, .purple-line, [data-accent-line] { margin-right: ${42 + pass * 8}px !important; }
      .slide p, .slide li, .slide td, .slide th { line-height: ${pass >= 2 ? 1.18 : 1.22} !important; }
      .slide .body, .slide .content, .slide .evidence-grid, .slide .table-wrap { max-width: 100% !important; }
    `,
  });
}

async function renderDeckWithCloudflareBrowser(
  env: Env,
  request: DeckRenderRequest
): Promise<DeckRenderResult> {
  if (!env.BROWSER) throw new Error('CLOUDFLARE_BROWSER_BINDING_MISSING');
  const mod = await import('@cloudflare/puppeteer');
  const puppeteer = (mod as any).default || mod;
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...DECK_RENDER_VIEWPORT, deviceScaleFactor: 1 });
    await page.setContent(request.html, { waitUntil: 'networkidle0' });

    let inspection = await inspectRenderedDeckPage(page);
    let repairPasses = 0;
    while (
      repairPasses < DECK_RENDER_MAX_REPAIR_PASSES
      && inspection.findings.some(f => f.severity === 'critical' || f.severity === 'high')
    ) {
      repairPasses += 1;
      await applyDeckRenderRepairPass(page, repairPasses);
      inspection = await inspectRenderedDeckPage(page);
    }

    const slideHandles = await page.$$('.slide');
    const screenshots: DeckScreenshot[] = [];
    for (let i = 0; i < Math.min(slideHandles.length, 40); i += 1) {
      const handle = slideHandles[i];
      const bytes = await handle.screenshot({ type: 'png' });
      const slideId = await handle.evaluate((el: any, fallback: string) => el.id || fallback, `slide_${i + 1}`);
      screenshots.push({
        slideId,
        index: i + 1,
        fileName: `${request.job_id}-slide-${String(i + 1).padStart(2, '0')}.png`,
        mimeType: 'image/png',
        width: DECK_RENDER_VIEWPORT.width,
        height: DECK_RENDER_VIEWPORT.height,
        base64: bytesToBase64(bytes),
      });
    }

    let pdfBase64: string | undefined;
    if (request.output_formats.includes('pdf')) {
      const pdf = await page.pdf({
        printBackground: true,
        width: `${DECK_RENDER_VIEWPORT.width}px`,
        height: `${DECK_RENDER_VIEWPORT.height}px`,
        preferCSSPageSize: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
      pdfBase64 = bytesToBase64(pdf);
    }

    const qa = mergeDeckQaReport(request.qa_report, inspection.findings, {
      ...inspection.metrics,
      html_bytes: new TextEncoder().encode(request.html).byteLength,
      repair_passes: repairPasses,
    });

    return {
      job_id: request.job_id,
      status: qa.status,
      qa_report: qa,
      screenshots,
      pdf_base64: pdfBase64,
      metrics: {
        viewport: DECK_RENDER_VIEWPORT,
        repair_passes: repairPasses,
        renderer: 'cloudflare_browser_rendering',
        rendered_slide_count: screenshots.length,
      },
    };
  } finally {
    await browser.close();
  }
}

export async function processDeckRenderJob(
  env: Env,
  jobId: string
): Promise<void> {
  const job = await env.D1.prepare(
    `SELECT *
       FROM deck_artifact_jobs
      WHERE id = ?
      LIMIT 1`
  ).bind(jobId).first<DeckArtifactJobRow>();
  if (!job) throw new Error(`deck job ${jobId} not found`);
  if (job.status === 'completed' || job.status === 'cancelled') return;

  const user = job.user_id
    ? await env.D1.prepare(
      `SELECT id, email, role
         FROM users
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
        LIMIT 1`
    ).bind(job.user_id, job.org_id).first<{ id: string; email: string; role: AuthContext['userRole'] }>()
    : null;
  if (!user) throw new Error(`deck job ${job.id} has no accessible user`);

  const ctx: AuthContext = {
    orgId: job.org_id,
    userId: user.id,
    userRole: user.role || 'member',
    email: user.email,
  };
  const structured = safeJsonParse<Record<string, any>>(job.structured_content_json, {});
  const outputFormats = normalizeDeckOutputFormats(safeJsonParse(job.output_formats_json, ['html', 'pdf', 'pptx']));
  const sourceDocumentIds = safeJsonParse<string[]>(job.source_document_ids_json, []);
  const title = job.title || structured.title || 'MARTy deck';
  const sourceDocs = await loadAccessibleDocuments(sourceDocumentIds, ctx, env);

  await updateDeckJobPhase(env, job.id, job.org_id, 'narrative', {
    message: 'Planning story',
    revision_round: Number(job.revision_round || 0),
  });

  if (!isDeckRendererEnabled(env)) {
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET status = 'failed',
              phase = 'failed',
              error_code = 'DECK_RENDERER_UNAVAILABLE',
              error_message = 'Premium deck rendering is enabled for this job but no renderer binding/service is available.',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(job.id, job.org_id).run();
    await appendDeckJobEvent(env, job.id, job.org_id, 'failed', {
      status: 'failed',
      phase: 'failed',
      message: 'Deck renderer is unavailable.',
      renderer_enabled: false,
    }).catch(() => {});
    return;
  }

  let currentStructured: any = normalizeStructuredArtifactContent(structured);
  let latestHtml = '';
  let latestPlan: DeckPlan = deckPlanFromContent(title, currentStructured);
  let latestQa: DeckQaReport = evaluatePremiumDeckQa(title, currentStructured);
  let latestRenderResult: DeckRenderResult | null = null;
  let latestRevisionRound = Number(job.revision_round || 0);

  for (let round = Number(job.revision_round || 0); round <= MAX_DECK_REVISION_ROUNDS; round += 1) {
    latestRevisionRound = round;
    await updateDeckJobPhase(env, job.id, job.org_id, 'html_render', {
      message: round === 0 ? 'Building HTML' : `Revision ${round}/${MAX_DECK_REVISION_ROUNDS}: rebuilding HTML`,
      revision_round: round,
      max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
    });
    latestHtml = renderPremiumDeckHtml(title, currentStructured);
    latestPlan = deckPlanFromContent(title, currentStructured);
    latestQa = evaluatePremiumDeckQa(title, currentStructured, latestHtml);
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET structured_content_json = ?,
              plan_json = ?,
              fact_ledger_json = ?,
              qa_report_json = ?,
              revision_round = ?,
              max_revision_rounds = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      JSON.stringify(currentStructured),
      JSON.stringify(latestPlan),
      JSON.stringify(deckFactsFromContent(title, currentStructured, slidesFromContent(title, currentStructured))),
      JSON.stringify(latestQa),
      round,
      MAX_DECK_REVISION_ROUNDS,
      job.id,
      job.org_id
    ).run().catch(() => {});

    await updateDeckJobPhase(env, job.id, job.org_id, 'render_qa', {
      message: useCloudflareDeckRenderer(env)
        ? 'Rendering screenshots with Cloudflare Browser Rendering'
        : 'Rendering screenshots with the Playwright deck renderer',
      revision_round: round,
      max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
      qa_status: latestQa.status,
    });
    const renderRequest: DeckRenderRequest = {
      job_id: job.id,
      title,
      html: latestHtml,
      style_pack: latestPlan.style_pack,
      quality_mode: job.quality_mode || 'premium',
      output_formats: outputFormats,
      plan: latestPlan,
      qa_report: latestQa,
    };
    latestRenderResult = useCloudflareDeckRenderer(env)
      ? await renderDeckWithCloudflareBrowser(env, renderRequest)
      : await callDeckRendererService(env, renderRequest);
    latestQa = latestRenderResult.qa_report || latestQa;

    if (latestRenderResult.error) break;
    if (latestQa.status === 'pass' && !deckQaHasBlockingFindings(latestQa)) break;
    if (round >= MAX_DECK_REVISION_ROUNDS) break;

    const nextRound = round + 1;
    latestRevisionRound = nextRound;
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET status = 'revising',
              phase = 'repair',
              revision_round = ?,
              qa_report_json = ?,
              blocked_reason = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      nextRound,
      JSON.stringify(latestQa),
      latestQa.slideFindings.slice(0, 3).map(f => `${f.slideId}: ${f.issue}`).join('; '),
      job.id,
      job.org_id
    ).run().catch(() => {});
    await appendDeckJobEvent(env, job.id, job.org_id, 'repair', {
      status: 'revising',
      phase: 'repair',
      revision_round: nextRound,
      max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
      qa_status: latestQa.status,
      message: nextRound === 1
        ? 'Revision 1/3: fixing overlap and density'
        : nextRound === 2
          ? 'Revision 2/3: tightening copy and hierarchy'
          : 'Revision 3/3: switching to safe fallback layouts',
      findings: latestQa.slideFindings.slice(0, 8),
    }).catch(() => {});
    currentStructured = await repairDeckSpecForQa(title, currentStructured, latestQa, nextRound, ctx, env);
  }

  if (!latestRenderResult) {
    throw new Error('DECK_RENDER_DID_NOT_RETURN_RESULT');
  }

  if (latestRenderResult.error) {
    await updateDeckJobPhase(env, job.id, job.org_id, 'failed', {
      message: 'Deck render failed.',
      error: latestRenderResult.error,
    });
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET status = 'failed',
              phase = 'failed',
              render_result_json = ?,
              error_code = 'DECK_RENDER_FAILED',
              error_message = ?,
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      JSON.stringify({ ...latestRenderResult, screenshots: latestRenderResult.screenshots?.map(s => ({ ...s, base64: undefined })) || [] }),
      String(latestRenderResult.error).slice(0, 500),
      job.id,
      job.org_id
    ).run().catch(() => {});
    return;
  }

  if (latestQa.status === 'pass' && !deckQaHasBlockingFindings(latestQa)) {
    await updateDeckJobPhase(env, job.id, job.org_id, 'export', {
      message: 'Exporting PDF/PPTX',
      revision_round: latestRevisionRound,
      max_revision_rounds: MAX_DECK_REVISION_ROUNDS,
      qa_status: latestQa.status,
    });
    const artifact = await persistArtifact(ctx, env, {
      kind: 'pptx',
      title,
      structuredContent: currentStructured,
      sourceDocs,
      prepared: true,
      customFields: {
        deck_tool: 'create_deck_artifact',
        deck_job_id: job.id,
        deck_quality_mode: job.quality_mode || 'premium',
        requested_output_formats: outputFormats,
        requested_audience: job.audience,
        requested_objective: job.objective,
        requested_style_pack: job.style_pack || 'medina_default',
        async_deck_render_job: true,
        final_screenshot_qa_status: latestQa.status,
      },
    });
    const persisted = await env.D1.prepare(
      `SELECT custom_fields FROM documents WHERE id = ? AND org_id = ?`
    ).bind(artifact.document.id, job.org_id).first<{ custom_fields: string | null }>().catch(() => null);
    const deckBundle = safeJsonParse<any>(persisted?.custom_fields, {})?.deck_bundle || null;
    await env.D1.prepare(
      `UPDATE deck_artifact_jobs
          SET pptx_document_id = ?,
              html_document_id = ?,
              pdf_document_id = ?,
              structured_content_json = ?,
              plan_json = ?,
              fact_ledger_json = ?,
              qa_report_json = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      artifact.document.id,
      deckBundle?.html_document_id || null,
      deckBundle?.pdf_document_id || null,
      JSON.stringify(currentStructured),
      JSON.stringify(latestPlan),
      JSON.stringify(deckFactsFromContent(title, currentStructured, slidesFromContent(title, currentStructured))),
      JSON.stringify(latestQa),
      job.id,
      job.org_id
    ).run().catch(() => {});
    await appendDeckJobEvent(env, job.id, job.org_id, 'artifact_bundle_created', {
      status: 'running',
      phase: 'export',
      message: 'QA-approved deck artifacts created.',
      pptx_document_id: artifact.document.id,
      html_document_id: deckBundle?.html_document_id || null,
      pdf_document_id: deckBundle?.pdf_document_id || null,
    }).catch(() => {});
    await applyDeckRenderResult(ctx, env, latestRenderResult);
    return;
  }

  const draft = await persistDeckInternalHtmlDocument(ctx, env, {
    title,
    html: latestHtml,
    extractedText: [
      latestPlan.title,
      latestPlan.storyline.join('\n'),
      ...latestQa.slideFindings.map(f => `${f.severity}: ${f.slideId}: ${f.issue}`),
    ].join('\n').slice(0, 8000),
    customFields: {
      deck_job_id: job.id,
      deck_qa_status: latestQa.status,
      revision_round: MAX_DECK_REVISION_ROUNDS,
    },
  });
  await env.D1.prepare(
    `UPDATE deck_artifact_jobs
        SET html_document_id = ?,
            structured_content_json = ?,
            plan_json = ?,
            fact_ledger_json = ?,
            qa_report_json = ?,
            revision_round = ?,
            max_revision_rounds = ?,
            blocked_reason = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    draft.documentId,
    JSON.stringify(currentStructured),
    JSON.stringify(latestPlan),
    JSON.stringify(deckFactsFromContent(title, currentStructured, slidesFromContent(title, currentStructured))),
    JSON.stringify(latestQa),
    MAX_DECK_REVISION_ROUNDS,
    MAX_DECK_REVISION_ROUNDS,
    latestQa.slideFindings.slice(0, 3).map(f => `${f.slideId}: ${f.issue}`).join('; ') || 'Screenshot QA blocked deck export.',
    job.id,
    job.org_id
  ).run().catch(() => {});
  await applyDeckRenderResult(ctx, env, latestRenderResult);
}

async function extractFullDocumentText(doc: DocumentRow, env: Env): Promise<string> {
  if (!doc.r2_key) return doc.extracted_text_preview || '';
  const obj = await env.R2.get(doc.r2_key);
  if (!obj) return doc.extracted_text_preview || '';
  try {
    const buffer = await obj.arrayBuffer();
    const file = new File([buffer], doc.file_name || doc.title || 'document', { type: doc.mime_type || '' });
    const text = await extractTextFromFile(file);
    return text || doc.extracted_text_preview || '';
  } catch {
    return doc.extracted_text_preview || '';
  }
}

function inferKind(doc: DocumentRow, requested?: unknown): ArtifactKind {
  if (requested) return normalizeArtifactKind(requested);
  const name = `${doc.file_name || doc.title || ''}`.toLowerCase();
  const mime = `${doc.mime_type || ''}`.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel')) return 'xlsx';
  if (name.endsWith('.pptx') || mime.includes('presentation')) return 'pptx';
  if (name.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  return 'docx';
}

function parseJsonObject(text: string): any | null {
  const clean = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(clean); } catch { /* continue */ }
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export async function editDocumentArtifactTool(
  ctx: AuthContext,
  input: {
    source_document_id: string;
    instructions: string;
    output_kind?: ArtifactKind;
    title?: string;
  },
  env: Env
): Promise<any> {
  const [sourceDoc] = await loadAccessibleDocuments([String(input.source_document_id || '')], ctx, env);
  if (!sourceDoc) return { ok: false, error: 'Source document not found or not accessible' };

  const kind = inferKind(sourceDoc, input.output_kind);
  const sourceText = await extractFullDocumentText(sourceDoc, env);
  const title = String(input.title || `${(sourceDoc.title || sourceDoc.file_name || 'Document').replace(/\.[a-z0-9]+$/i, '')} - MARTy edit`).slice(0, 140);
  const sourceForModel = truncateToTokens(sourceText || sourceDoc.extracted_text_preview || '', 14000);
  const system = `You transform business documents into clean structured JSON for high-quality file generation.
Return JSON only. No markdown.
Preserve important facts, names, numbers, and ordering from the source unless the instructions say otherwise.
Do not return skeletal content. The edited copy must be useful as a standalone business document.

Schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]}
- xlsx: {"sheets":[{"name":"","title":"","rows":[[]]}]}
- pptx: {"subtitle":"","slides":[{"layout":"cover|executive_summary|evidence|matrix|timeline|risk|next_steps","title":"","headline":"","subtitle":"","takeaway":"","body":"","bullets":[],"evidence_blocks":[],"metrics":[{"label":"","value":"","context":""}],"table":{"headers":[],"rows":[[]]},"speaker_notes":""}]}

Quality bar:
- DOCX/PDF: create a polished memo/report with 5-8 sections, clear headings, and at least one table or checklist when useful.
- XLSX: create a usable workbook with 2-4 sheets, headers, clean rows, and formulas where natural.
- PPTX: create a 6-10 slide Medina-dark executive deck with a cover, executive takeaway, one idea per slide, visual evidence surfaces, and speaker notes.`;
  const user = `Output kind: ${kind}
New title: ${title}
Instructions: ${String(input.instructions || '').slice(0, 4000)}

SOURCE DOCUMENT (${sourceDoc.title || sourceDoc.file_name}):
${sourceForModel}`;

  let structured = parseJsonObject(await callClaude({ system, user, max_tokens: 3500, orgId: ctx.orgId }, 'low', env));
  if (!structured) {
    structured = {
      sections: [{
        heading: title,
        paragraphs: [
          `Edited copy of ${sourceDoc.title || sourceDoc.file_name}.`,
          String(input.instructions || ''),
          sourceText || sourceDoc.extracted_text_preview || '',
        ].filter(Boolean),
      }],
    };
  }

  const result = await persistArtifact(ctx, env, {
    kind,
    title,
    structuredContent: structured,
    sourceDocs: [sourceDoc],
    parentDocumentId: sourceDoc.parent_document_id || sourceDoc.id,
  });
  return {
    ok: true,
    document: result.document,
    source_document_id: sourceDoc.id,
    document_cards: [result.card],
    message: `Created edited copy ${result.document.file_name}`,
  };
}

export const __documentArtifactsTestHooks = {
  contentQualityIssues,
  docxTableColumnWidths,
  makeDocx,
  makePptx,
  deckPlanFromContent,
  renderPremiumDeckHtml,
  evaluatePremiumDeckQa,
  deckQaHasBlockingFindings,
  deterministicDeckRepair,
  deckVisibleDocumentIdsForQa,
  deckDiagnosticDocumentIdsForStatus,
  normalizeDeckOutputFormats,
  DECK_RENDER_WORK_DOMAIN,
  DECK_STYLE_PACKS,
  MAX_DECK_REVISION_ROUNDS,
};

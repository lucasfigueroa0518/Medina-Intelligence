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

export type MartyDocumentCardMode = 'compact' | 'dominant';
export type ArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'pdf';

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

function clampLimit(limit: unknown, fallback = 8): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), 20);
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
  if (/\b(documents|docs|files|decks|presentations|attachments)\b/.test(lower)) return false;
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
      WHERE org_id = ? AND deleted_at IS NULL AND id IN (${ph})`
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

  const where = ['d.org_id = ?', 'd.deleted_at IS NULL'];
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

function plainTextFromStructured(content: any): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const parts: string[] = [];
  if (content.title) parts.push(String(content.title));
  for (const p of asArray(content.paragraphs)) parts.push(String(p));
  for (const b of asArray(content.bullets)) parts.push(`- ${String(b)}`);
  for (const s of asArray(content.sections)) {
    if (s?.heading) parts.push(String(s.heading));
    for (const p of asArray(s?.paragraphs)) parts.push(String(p));
    for (const b of asArray(s?.bullets)) parts.push(`- ${String(b)}`);
  }
  for (const slide of asArray(content.slides)) {
    if (slide?.title) parts.push(String(slide.title));
    for (const b of asArray(slide?.bullets)) parts.push(`- ${String(b)}`);
  }
  for (const sheet of asArray(content.sheets)) {
    if (sheet?.name) parts.push(`Sheet: ${sheet.name}`);
    for (const row of asArray(sheet?.rows)) parts.push(Array.isArray(row) ? row.join(', ') : JSON.stringify(row));
  }
  return parts.join('\n');
}

function fileTitle(title: string, kind: ArtifactKind): string {
  const clean = title.trim().replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').slice(0, 100) || 'MARTy artifact';
  return clean.toLowerCase().endsWith(`.${kind}`) ? clean : `${clean}.${kind}`;
}

async function makeDocx(title: string, content: any): Promise<Uint8Array> {
  const mod = await import('docx');
  const docx: any = mod;
  const children: any[] = [
    new docx.Paragraph({ text: title, heading: docx.HeadingLevel.TITLE }),
  ];
  const addParagraph = (text: string) => children.push(new docx.Paragraph({ children: [new docx.TextRun(String(text))] }));
  const addBullet = (text: string) => children.push(new docx.Paragraph({ text: String(text), bullet: { level: 0 } }));

  if (typeof content === 'string') {
    content.split(/\n{2,}/).map(s => s.trim()).filter(Boolean).forEach(addParagraph);
  } else {
    for (const p of asArray(content?.paragraphs)) addParagraph(String(p));
    for (const b of asArray(content?.bullets)) addBullet(String(b));
    for (const section of asArray(content?.sections)) {
      if (section?.heading) children.push(new docx.Paragraph({ text: String(section.heading), heading: docx.HeadingLevel.HEADING_1 }));
      for (const p of asArray(section?.paragraphs)) addParagraph(String(p));
      for (const b of asArray(section?.bullets)) addBullet(String(b));
    }
  }

  const document = new docx.Document({ sections: [{ children }] });
  const buffer = await docx.Packer.toBuffer(document);
  return new Uint8Array(buffer);
}

async function makeXlsx(title: string, content: any): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const sheets = asArray(content?.sheets);
  if (sheets.length > 0) {
    for (const sheet of sheets) {
      const rows = asArray(sheet?.rows);
      const aoa = rows.map(row => Array.isArray(row) ? row : Object.values(row || {}));
      const ws = XLSX.utils.aoa_to_sheet(aoa.length > 0 ? aoa : [[title]]);
      XLSX.utils.book_append_sheet(wb, ws, String(sheet?.name || 'Sheet').slice(0, 31));
    }
  } else {
    const rows = asArray(content?.rows);
    const aoa = rows.length > 0
      ? rows.map(row => Array.isArray(row) ? row : Object.values(row || {}))
      : [['Title', title], ['Content', plainTextFromStructured(content)]];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}

async function makePptx(title: string, content: any): Promise<Uint8Array> {
  const mod = await import('pptxgenjs');
  const PptxGen = (mod as any).default || mod;
  const pptx = new PptxGen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'MARTy';
  pptx.subject = title;
  pptx.title = title;
  const slides = asArray(content?.slides);
  const normalizedSlides = slides.length > 0
    ? slides
    : [{ title, bullets: plainTextFromStructured(content).split('\n').filter(Boolean).slice(0, 8) }];
  for (const s of normalizedSlides) {
    const slide = pptx.addSlide();
    slide.background = { color: '111114' };
    slide.addText(String(s?.title || title), { x: 0.6, y: 0.45, w: 12, h: 0.5, fontSize: 26, bold: true, color: 'FFFFFF' });
    const bullets = asArray(s?.bullets).map(String);
    const body = bullets.length > 0 ? bullets.map(b => `• ${b}`).join('\n') : String(s?.body || '');
    slide.addText(body || ' ', { x: 0.8, y: 1.35, w: 11.8, h: 5.6, fontSize: 16, color: 'D4D4D8', breakLine: false, fit: 'shrink' });
  }
  const out = await pptx.write({ outputType: 'arraybuffer' });
  return new Uint8Array(out as ArrayBuffer);
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function makePdf(title: string, content: any): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 736;
  const margin = 54;
  const addLine = (text: string, size = 11, isBold = false) => {
    if (y < 64) {
      page = pdf.addPage([612, 792]);
      y = 736;
    }
    page.drawText(text, { x: margin, y, size, font: isBold ? bold : font, color: rgb(0.12, 0.12, 0.14) });
    y -= size + 7;
  };
  addLine(title, 20, true);
  y -= 12;
  for (const para of plainTextFromStructured(content).split(/\n+/).filter(Boolean)) {
    for (const line of wrapText(para, 88)) addLine(line, 11);
    y -= 6;
  }
  return await pdf.save();
}

async function artifactBytes(kind: ArtifactKind, title: string, content: any): Promise<Uint8Array> {
  if (kind === 'docx') return makeDocx(title, content);
  if (kind === 'xlsx') return makeXlsx(title, content);
  if (kind === 'pptx') return makePptx(title, content);
  return makePdf(title, content);
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

async function persistArtifact(
  ctx: AuthContext,
  env: Env,
  opts: {
    kind: ArtifactKind;
    title: string;
    structuredContent: any;
    sourceDocs: DocumentRow[];
    parentDocumentId?: string | null;
  }
): Promise<{ card: MartyDocumentCard; document: { id: string; title: string; file_name: string; mime_type: string } }> {
  const bytes = await artifactBytes(opts.kind, opts.title, opts.structuredContent);
  const fileName = fileTitle(opts.title, opts.kind);
  const file = new File([bytes], fileName, { type: MIME_BY_KIND[opts.kind] });
  const visibility = restrictiveVisibility(opts.sourceDocs);
  const participantUserIds = participantUnion(opts.sourceDocs, ctx, visibility);
  const links: DocumentLink[] = [];
  const primarySource = opts.sourceDocs.find(d => d.deal_id || d.company_id || d.contact_id);
  if (primarySource?.deal_id) links.push({ entityType: 'deal', entityId: primarySource.deal_id, linkKind: 'derived', linkSource: 'llm_extracted' });
  else if (primarySource?.company_id) links.push({ entityType: 'company', entityId: primarySource.company_id, linkKind: 'derived', linkSource: 'llm_extracted' });
  else if (primarySource?.contact_id) links.push({ entityType: 'contact', entityId: primarySource.contact_id, linkKind: 'derived', linkSource: 'llm_extracted' });

  const extractedText = plainTextFromStructured(opts.structuredContent);
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
    embed: true,
  }, env);
  await persisted.finalize();

  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = ?
      WHERE id = ? AND org_id = ?`
  ).bind(
    JSON.stringify({
      marty_generated: true,
      source_document_ids: opts.sourceDocs.map(d => d.id),
      artifact_kind: opts.kind,
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
  });
  return {
    ok: true,
    document: result.document,
    document_cards: [result.card],
    message: `Created ${result.document.file_name}`,
  };
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
  const system = `You transform business documents into clean structured JSON for file generation.
Return JSON only. No markdown.
For docx/pdf return: {"paragraphs":[],"sections":[{"heading":"","paragraphs":[],"bullets":[]}]}.
For xlsx return: {"sheets":[{"name":"Sheet1","rows":[["Header"],["Value"]]}]}.
For pptx return: {"slides":[{"title":"","bullets":[]}]}.
Preserve important facts, names, numbers, and ordering from the source unless the instructions say otherwise.`;
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

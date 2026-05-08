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
    if (slide?.subtitle) parts.push(String(slide.subtitle));
    if (slide?.body) parts.push(String(slide.body));
    for (const b of asArray(slide?.bullets)) parts.push(`- ${String(b)}`);
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
        { title, subtitle: 'Prepared by MARTy' },
        { title: 'Executive Takeaway', bullets: [summary.slice(0, 220), 'Use this as a working draft and tighten details with source-specific inputs.'] },
        { title: 'Recommended Workstreams', bullets: ['Define the highest-impact objective', 'Map ownership and sequencing', 'Identify data or source gaps', 'Prepare a concise follow-up package'] },
        { title: 'Execution Plan', bullets: ['Prioritize the first 7 days of work', 'Assign owners', 'Create checkpoints', 'Track outputs in a single place'] },
        { title: 'Risks And Watchouts', bullets: ['Avoid vague ownership', 'Do not overbuild before stakeholder review', 'Flag uncertain facts before distribution'] },
        { title: 'Next Steps', bullets: ['Review this draft', 'Add company-specific detail', 'Confirm owners and dates', 'Send the final version'] },
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
- Use concrete headings, useful body copy, and skimmable structure.
- Preserve any facts supplied by the draft or source context. Do not invent external facts.
- If source facts are limited, create a high-quality editable template with clear placeholders and next-step fields instead of a blank file.

Schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]}
- pptx: {"subtitle":"","slides":[{"title":"","subtitle":"","body":"","bullets":[],"table":{"headers":[],"rows":[[]]}}]}
- xlsx: {"sheets":[{"name":"","title":"","rows":[[]]}]}

Minimum richness:
- docx/pdf: 5-8 sections, include at least one table or checklist when useful.
- pptx: 6-10 slides, one idea per slide, no walls of text.
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

function makeDocxTable(docx: any, table: { title?: string; headers: string[]; rows: any[][] }): any[] {
  const headers = table.headers.length > 0 ? table.headers : table.rows[0]?.map((_, i) => `Column ${i + 1}`) || [];
  const rows = table.headers.length > 0 ? table.rows : table.rows.slice(1);
  if (headers.length === 0) return [];
  const cells = (values: any[], isHeader = false) => values.map(value => new docx.TableCell({
    shading: isHeader ? { fill: 'F3E8FF' } : undefined,
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    children: [new docx.Paragraph({
      children: [new docx.TextRun({
        text: cleanArtifactText(value) || ' ',
        bold: isHeader,
        color: isHeader ? '581C87' : '111827',
        size: 19,
      })],
      spacing: { after: 0, line: 240 },
    })],
  }));
  const out: any[] = [];
  if (table.title) out.push(makeDocxParagraph(docx, table.title, { style: 'Caption', bold: true }));
  out.push(new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
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
      children: paragraphRuns(String(content.summary), docx, { bold: true, color: '581C87' }),
      spacing: { before: 120, after: 220, line: 276 },
      border: { left: { color: 'C026D3', size: 18, style: docx.BorderStyle.SINGLE } },
      indent: { left: 220 },
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
        { id: 'Callout', name: 'Callout', basedOn: 'Normal', run: { font: 'Aptos', size: 21, color: '581C87' }, paragraph: { spacing: { after: 190, line: 276 } } },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
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

async function makeXlsx(title: string, content: any): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: title, Author: 'MARTy', Company: 'Medina Ventures' };
  const sheets = asArray(content?.sheets);
  if (sheets.length > 0) {
    for (const sheet of sheets) {
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
      XLSX.utils.book_append_sheet(wb, ws, String(sheet?.name || 'Sheet').slice(0, 31));
    }
  } else {
    const rows = asArray(content?.rows);
    const aoa = rows.length > 0
      ? rows.map(row => Array.isArray(row) ? row.map(normalizeCellForXlsx) : Object.values(row || {}).map(normalizeCellForXlsx))
      : [['Title', title], ['Content', plainTextFromStructured(content)]];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Summary');
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}

function slidesFromContent(title: string, content: any): any[] {
  const explicit = asArray(content?.slides);
  if (explicit.length > 0) return explicit;
  const slides: any[] = [{ title, subtitle: content?.subtitle || 'Prepared by MARTy' }];
  if (content?.summary) slides.push({ title: 'Executive Takeaway', body: content.summary });
  for (const section of asArray(content?.sections)) {
    slides.push({
      title: section?.heading || 'Section',
      body: section?.summary || asArray(section?.paragraphs)[0] || '',
      bullets: [...asArray(section?.bullets), ...asArray(section?.numbered), ...asArray(section?.checklist)].slice(0, 6),
      table: tableFromAny(section?.table || asArray(section?.tables)[0]),
    });
  }
  if (slides.length < 4) {
    slides.push(
      { title: 'Recommended Workstreams', bullets: ['Clarify the objective', 'Assign owners', 'Identify evidence gaps', 'Create a review cadence'] },
      { title: 'Risks And Watchouts', bullets: ['Separate facts from assumptions', 'Avoid vague ownership', 'Keep the output decision-ready'] },
      { title: 'Next Steps', bullets: ['Review the draft', 'Confirm dates and owners', 'Finalize and circulate'] },
    );
  }
  return slides.slice(0, 12);
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
  const normalizedSlides = slidesFromContent(title, content);
  normalizedSlides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: idx === 0 ? '0B0B10' : '111114' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.13, h: 7.5, fill: { color: 'C026D3' }, line: { color: 'C026D3' } });
    slide.addText(String(s?.title || title), { x: 0.55, y: idx === 0 ? 2.25 : 0.42, w: 11.8, h: idx === 0 ? 0.85 : 0.5, fontSize: idx === 0 ? 34 : 25, bold: true, color: 'FFFFFF', margin: 0.02, fit: 'shrink' });
    if (s?.subtitle) slide.addText(String(s.subtitle), { x: 0.58, y: idx === 0 ? 3.12 : 0.98, w: 10.8, h: 0.35, fontSize: idx === 0 ? 16 : 11, color: 'A1A1AA', margin: 0.02, fit: 'shrink' });
    if (idx === 0) {
      slide.addText('Prepared by MARTy', { x: 0.58, y: 6.65, w: 3.8, h: 0.3, fontSize: 10, color: 'A1A1AA', margin: 0.02 });
      return;
    }
    const bullets = asArray(s?.bullets).map(String);
    if (s?.body) slide.addText(String(s.body), { x: 0.62, y: 1.38, w: 5.8, h: bullets.length > 0 ? 1.05 : 4.85, fontSize: 15, color: 'E5E7EB', margin: 0.04, breakLine: false, fit: 'shrink' });
    if (bullets.length > 0) {
      slide.addText(bullets.join('\n'), {
        x: 0.76,
        y: s?.body ? 2.55 : 1.42,
        w: 5.75,
        h: 4.25,
        fontSize: 15,
        color: 'D4D4D8',
        bullet: { type: 'bullet' },
        breakLine: false,
        fit: 'shrink',
        paraSpaceAfterPt: 8,
      });
    }
    const table = tableFromAny(s?.table);
    if (table && table.headers.length > 0) {
      const pptRows = [table.headers, ...table.rows.slice(0, 6)].map(row => row.map(cleanArtifactText));
      slide.addTable(pptRows, {
        x: 6.9,
        y: 1.35,
        w: 5.75,
        h: 4.65,
        fontSize: 9.5,
        color: 'F4F4F5',
        border: { type: 'solid', color: '3F3F46', pt: 0.5 },
        fill: { color: '18181B' },
        margin: 0.08,
      });
    } else {
      slide.addShape(pptx.ShapeType.rect, { x: 7.0, y: 1.4, w: 5.3, h: 4.55, fill: { color: '18181B' }, line: { color: '27272A' } });
      const pull = firstNonEmpty(s?.callout, asArray(s?.bullets)[0], s?.body, 'Review this slide and refine with source-specific detail.');
      slide.addText(pull, { x: 7.35, y: 1.82, w: 4.65, h: 3.55, fontSize: 20, bold: true, color: 'F4F4F5', margin: 0.03, fit: 'shrink' });
    }
    slide.addText(`${idx + 1}/${normalizedSlides.length}`, { x: 11.9, y: 6.9, w: 0.7, h: 0.2, fontSize: 8.5, color: '71717A', align: 'right' });
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
  const inputContent = normalizeStructuredArtifactContent(opts.structuredContent);
  const structuredContent = await enrichArtifactContent(opts.kind, opts.title, inputContent, ctx, env, opts.sourceDocs);
  const bytes = await artifactBytes(opts.kind, opts.title, structuredContent);
  const fileName = fileTitle(opts.title, opts.kind);
  const file = new File([bytes], fileName, { type: MIME_BY_KIND[opts.kind] });
  const visibility = restrictiveVisibility(opts.sourceDocs);
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
      artifact_schema_version: 2,
      artifact_text_length: extractedText.length,
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
  const system = `You transform business documents into clean structured JSON for high-quality file generation.
Return JSON only. No markdown.
Preserve important facts, names, numbers, and ordering from the source unless the instructions say otherwise.
Do not return skeletal content. The edited copy must be useful as a standalone business document.

Schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]}
- xlsx: {"sheets":[{"name":"","title":"","rows":[[]]}]}
- pptx: {"subtitle":"","slides":[{"title":"","subtitle":"","body":"","bullets":[],"table":{"headers":[],"rows":[[]]}}]}

Quality bar:
- DOCX/PDF: create a polished memo/report with 5-8 sections, clear headings, and at least one table or checklist when useful.
- XLSX: create a usable workbook with 2-4 sheets, headers, clean rows, and formulas where natural.
- PPTX: create a 6-10 slide deck with a cover, executive takeaway, one idea per slide, and concise bullets or tables.`;
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

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
- Use concrete headings, useful body copy, and skimmable structure.
- Preserve any facts supplied by the draft or source context. Do not invent external facts.
- If source facts are limited, create a high-quality editable template with clear placeholders and next-step fields instead of a blank file.

Schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]}
- pptx: {"subtitle":"","slides":[{"layout":"cover|executive_summary|evidence|matrix|timeline|risk|next_steps","title":"","headline":"","subtitle":"","takeaway":"","body":"","bullets":[],"evidence_blocks":[],"metrics":[{"label":"","value":"","context":""}],"table":{"headers":[],"rows":[[]]},"speaker_notes":""}]}
- xlsx: {"sheets":[{"name":"","title":"","rows":[[]]}]}

Minimum richness:
- docx/pdf: 5-8 sections, include at least one table or checklist when useful.
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
- Preserve user-provided facts; if facts are limited, create a polished editable template with useful fields.
- No unsupported external facts.

Required schemas:
- docx/pdf: {"subtitle":"","summary":"","metadata":[{"label":"","value":""}],"sections":[{"heading":"","paragraphs":[],"bullets":[],"numbered":[],"checklist":[],"tables":[{"title":"","headers":[],"rows":[[]]}]}]}
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
  const XLSX = await import('xlsx');
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
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.1, h: 7.5, fill: { color: C.magenta }, line: { color: C.magenta } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.1, y: 0, w: 0.04, h: 7.5, fill: { color: C.purple }, line: { color: C.purple } });
    if (idx > 0) {
      slide.addText(kicker || `SLIDE ${idx + 1}`, { x: 0.52, y: 0.34, w: 2.0, h: 0.22, fontSize: 8.5, color: C.purple, charSpace: 1.6, margin: 0 });
      slide.addText(`${idx + 1}/${normalizedSlides.length}`, { x: 12.0, y: 6.88, w: 0.72, h: 0.18, fontSize: 8, color: C.dim, align: 'right', margin: 0 });
    }
  };

  const addHeadline = (slide: any, s: any, y = 0.72, w = 7.2) => {
    slide.addText(s.title, { x: 0.52, y, w, h: 0.42, fontSize: 21, bold: true, color: C.text, margin: 0.01, fit: 'shrink' });
    if (s.headline) {
      slide.addText(s.headline, { x: 0.54, y: y + 0.62, w: Math.min(w + 1.6, 8.6), h: 0.72, fontSize: 14.5, bold: true, color: 'EDE9FE', margin: 0.02, fit: 'shrink' });
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
      slide.addText('MEDINA INTELLIGENCE', { x: 0.56, y: 0.62, w: 3.0, h: 0.22, fontSize: 8.5, color: C.purple, charSpace: 1.8, margin: 0 });
      slide.addText(s.title || title, { x: 0.58, y: 1.95, w: 8.6, h: 0.82, fontSize: 34, bold: true, color: C.text, margin: 0.01, fit: 'shrink' });
      slide.addText(s.headline || s.subtitle || 'Prepared by MARTy', { x: 0.62, y: 2.93, w: 7.8, h: 0.72, fontSize: 15, color: 'E9D5FF', margin: 0.02, fit: 'shrink' });
      addEvidenceBlocks(slide, s.evidence_blocks.length ? s.evidence_blocks : ['Executive storyline', 'Evidence-first structure', 'Editable PowerPoint'], 8.55, 1.48, 3.85, 3.1);
      slide.addText(s.subtitle || 'Prepared by MARTy', { x: 0.62, y: 6.65, w: 4.0, h: 0.24, fontSize: 9.5, color: C.muted, margin: 0 });
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
      else if (xml.replace(/<[^>]+>/g, '').trim().length < 80) issues.push('DOCX contains too little readable content');
    }

    if (kind === 'xlsx') {
      if (!zip.file('xl/workbook.xml')) issues.push('XLSX missing xl/workbook.xml');
      const worksheetEntries = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e));
      if (worksheetEntries.length < 1) issues.push('XLSX has no worksheets');
      const XLSX = await import('xlsx');
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
  }
): Promise<{ card: MartyDocumentCard; document: { id: string; title: string; file_name: string; mime_type: string } }> {
  const inputContent = normalizeStructuredArtifactContent(opts.structuredContent);
  let structuredContent = await prepareArtifactContent(opts.kind, opts.title, inputContent, ctx, env, opts.sourceDocs);
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

  await env.D1.prepare(
    `UPDATE documents
        SET custom_fields = ?
      WHERE id = ? AND org_id = ?`
  ).bind(
    JSON.stringify({
      marty_generated: true,
      ...(opts.customFields || {}),
      source_document_ids: opts.sourceDocs.map(d => d.id),
      artifact_kind: opts.kind,
      artifact_schema_version: 3,
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

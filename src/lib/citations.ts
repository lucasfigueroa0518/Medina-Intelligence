// MARTy citations — turn hydrated retrieval chunks into a numbered source list
// that Claude can reference inline as [^N], plus a CitationSource[] payload the
// frontend can render as pills. The same shape is persisted alongside the
// assistant message so reloads keep their citations.
import type { Env } from '../types/env';
import type { HydratedChunk } from '../types/interfaces';
import { estimateTokens, truncateToTokens } from './tokens';

export type CitationSourceType =
  | 'email'
  | 'meeting'
  | 'document'
  | 'contact'
  | 'company'
  | 'slack'
  | 'news';

export interface CitationSource {
  id: number;
  type: CitationSourceType;
  source_table: string;
  source_id: string;
  entity_id?: string;
  title: string;
  subtitle?: string;
  date?: string;
  url_path: string;
  external_url?: string;

  // ---- Display fields populated for the side panel ----
  // Snippet of the chunk text that Claude actually saw — the "what was cited"
  // payload. ~400 chars, prefix metadata stripped. Optional because some
  // panels only need title + linked entity (e.g. contact/company sources).
  excerpt?: string;
  // Resolved name of the linked entity (for documents: contact/company/deal
  // human-readable name; for news: company name). Lets the panel render
  // "About: <name>" instead of a raw UUID.
  entity_name?: string;
  // Click target for the linked entity ("/contacts/<id>", "/companies/<id>",
  // "/deals/<id>"). Only set when entity_id resolves to something that has
  // a detail page in the app.
  entity_url_path?: string;
}

interface ChunkRef {
  chunk: HydratedChunk;
  sourceKey: string;
}

const CONTEXT_TOKEN_BUDGET = 60000;
const NEWS_TOKEN_BUDGET = 2000;
const UPLOAD_TOKEN_BUDGET = 20000;
const PER_CHUNK_MAX = 2000;

function sourceKeyFor(chunk: HydratedChunk): string {
  const table = String(chunk.metadata.source_table || 'unknown');
  const id = String(chunk.metadata.source_id || chunk.id);
  return `${table}::${id}`;
}

function classifyType(chunk: HydratedChunk): CitationSourceType {
  const docType = String(chunk.metadata.document_type || '');
  const sourceTable = String(chunk.metadata.source_table || '');
  if (docType === 'news' || sourceTable === 'news_articles') return 'news';
  if (docType === 'transcript' || sourceTable === 'events') return 'meeting';
  if (docType === 'email') return 'email';
  if (docType === 'conversation') return 'slack';
  if (sourceTable === 'documents') return 'document';
  return 'document';
}

function placeholderSource(id: number, chunk: HydratedChunk): CitationSource {
  const type = classifyType(chunk);
  const fallbackTitle =
    (chunk.metadata.entity_name as string | undefined) ||
    (chunk.metadata.text_preview as string | undefined)?.slice(0, 60) ||
    `Source ${id}`;
  return {
    id,
    type,
    source_table: String(chunk.metadata.source_table || 'unknown'),
    source_id: String(chunk.metadata.source_id || chunk.id),
    entity_id: chunk.metadata.primary_entity_id as string | undefined,
    title: fallbackTitle,
    date: chunk.metadata.created_at as string | undefined,
    url_path: '/',
  };
}

// Extract a clean excerpt from a hydrated chunk. The prefix block
// ("[Type: …] [Entity: …] [Date: …]\n") is internal context for retrieval
// and shouldn't appear in the side panel. Strip it, take the next ~400 chars,
// collapse runs of whitespace, and ellipsize. Returns undefined if the chunk
// is empty after stripping.
function extractExcerpt(hydratedText: string | undefined): string | undefined {
  if (!hydratedText) return undefined;
  let body = hydratedText;
  // Drop a leading "[Type: …] [Entity: …] [Date: …]" line if present.
  const newlineIdx = body.indexOf('\n');
  if (newlineIdx > 0 && body.slice(0, newlineIdx).match(/^\[Type:\s/)) {
    body = body.slice(newlineIdx + 1);
  }
  body = body.trim().replace(/\s+/g, ' ');
  if (!body) return undefined;
  if (body.length <= 400) return body;
  return body.slice(0, 400).trim() + '…';
}

function fmtDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

async function hydrateSources(
  refs: { id: number; chunk: HydratedChunk }[],
  orgId: string,
  env: Env
): Promise<CitationSource[]> {
  // Bucket by table for batched lookups.
  const byTable = new Map<string, { id: number; chunk: HydratedChunk; sourceId: string }[]>();
  for (const r of refs) {
    const table = String(r.chunk.metadata.source_table || 'unknown');
    const sourceId = String(r.chunk.metadata.source_id || r.chunk.id);
    const arr = byTable.get(table) || [];
    arr.push({ id: r.id, chunk: r.chunk, sourceId });
    byTable.set(table, arr);
  }

  // Initialize with placeholders so any failed lookup still produces a usable
  // source row.
  const out: Map<number, CitationSource> = new Map();
  for (const r of refs) out.set(r.id, placeholderSource(r.id, r.chunk));

  const lookups: Promise<void>[] = [];

  // Conversations (emails + slack messages share this table).
  const convRows = byTable.get('conversations');
  if (convRows && convRows.length > 0) {
    const ids = convRows.map(r => r.sourceId);
    const placeholders = ids.map(() => '?').join(',');
    lookups.push(
      env.D1.prepare(
        `SELECT id, source, subject, from_email, from_contact_id, sent_at, body_preview
         FROM conversations WHERE org_id = ? AND id IN (${placeholders})`
      )
        .bind(orgId, ...ids)
        .all<{
          id: string;
          source: string;
          subject: string | null;
          from_email: string | null;
          from_contact_id: string | null;
          sent_at: string | null;
          body_preview: string | null;
        }>()
        .then(async res => {
          const fromContactIds = Array.from(
            new Set(res.results.map(r => r.from_contact_id).filter(Boolean) as string[])
          );
          const contactNames = new Map<string, string>();
          if (fromContactIds.length > 0) {
            const cph = fromContactIds.map(() => '?').join(',');
            const c = await env.D1.prepare(
              `SELECT id, full_name FROM contacts WHERE org_id = ? AND id IN (${cph})`
            )
              .bind(orgId, ...fromContactIds)
              .all<{ id: string; full_name: string }>();
            for (const row of c.results) contactNames.set(row.id, row.full_name);
          }

          const byId = new Map(res.results.map(r => [r.id, r]));
          for (const ref of convRows) {
            const row = byId.get(ref.sourceId);
            if (!row) continue;
            const isSlack = row.source === 'slack';
            const senderName =
              (row.from_contact_id && contactNames.get(row.from_contact_id)) ||
              row.from_email ||
              'Unknown sender';
            const title =
              (row.subject && row.subject.trim()) ||
              (isSlack
                ? (row.body_preview?.slice(0, 60) || 'Slack message')
                : `Email from ${senderName}`);
            const subtitle = isSlack
              ? `Slack — ${senderName}`
              : `${senderName}`;
            out.set(ref.id, {
              id: ref.id,
              type: isSlack ? 'slack' : 'email',
              source_table: 'conversations',
              source_id: row.id,
              entity_id: ref.chunk.metadata.primary_entity_id as string | undefined,
              title,
              subtitle,
              date: row.sent_at || undefined,
              url_path: `/conversations/${row.id}`,
              excerpt: extractExcerpt(ref.chunk.hydrated_text),
            });
          }
        })
        .catch(e => console.error('[citations] conversations lookup failed:', e))
    );
  }

  const eventRows = byTable.get('events');
  if (eventRows && eventRows.length > 0) {
    const ids = eventRows.map(r => r.sourceId);
    const ph = ids.map(() => '?').join(',');
    lookups.push(
      env.D1.prepare(
        `SELECT id, title, event_type, start_time FROM events
         WHERE org_id = ? AND id IN (${ph})`
      )
        .bind(orgId, ...ids)
        .all<{ id: string; title: string; event_type: string; start_time: string }>()
        .then(res => {
          const byId = new Map(res.results.map(r => [r.id, r]));
          for (const ref of eventRows) {
            const row = byId.get(ref.sourceId);
            if (!row) continue;
            out.set(ref.id, {
              id: ref.id,
              type: 'meeting',
              source_table: 'events',
              source_id: row.id,
              entity_id: ref.chunk.metadata.primary_entity_id as string | undefined,
              title: row.title,
              subtitle: row.event_type === 'meeting' ? 'Meeting' : row.event_type,
              date: row.start_time,
              url_path: `/events/${row.id}`,
              excerpt: extractExcerpt(ref.chunk.hydrated_text),
            });
          }
        })
        .catch(e => console.error('[citations] events lookup failed:', e))
    );
  }

  const docRows = byTable.get('documents');
  if (docRows && docRows.length > 0) {
    const ids = docRows.map(r => r.sourceId);
    const ph = ids.map(() => '?').join(',');
    lookups.push(
      env.D1.prepare(
        `SELECT id, title, document_type, file_name, contact_id, company_id, deal_id, created_at,
                extracted_text_preview
         FROM documents WHERE org_id = ? AND id IN (${ph})`
      )
        .bind(orgId, ...ids)
        .all<{
          id: string;
          title: string;
          document_type: string;
          file_name: string | null;
          contact_id: string | null;
          company_id: string | null;
          deal_id: string | null;
          created_at: string;
          extracted_text_preview: string | null;
        }>()
        .then(async res => {
          // Collect distinct linked-entity IDs by table for batched name lookup.
          const contactIds: string[] = [];
          const companyIds: string[] = [];
          const dealIds: string[] = [];
          for (const r of res.results) {
            if (r.contact_id) contactIds.push(r.contact_id);
            if (r.company_id) companyIds.push(r.company_id);
            if (r.deal_id) dealIds.push(r.deal_id);
          }
          const contactNames = new Map<string, string>();
          const companyNames = new Map<string, string>();
          const dealTitles = new Map<string, string>();

          // KV chunk fetch — the citation excerpt should be the actual text
          // Claude saw, not the doc-level intro. KV is keyed by vector_id
          // (a.k.a. chunk.id). Older docs ingested before chunk caching may
          // miss; fall back to extracted_text_preview and log a warning so
          // we can track how often the fallback fires.
          const chunkTextByVectorId = new Map<string, string>();
          const kvChunkFetch = Promise.all(
            docRows.map(async ref => {
              try {
                const txt = await env.KV.get(`chunk:${ref.chunk.id}`);
                if (txt) chunkTextByVectorId.set(ref.chunk.id, txt);
              } catch { /* swallow — fallback will handle */ }
            })
          );

          await Promise.all([
            kvChunkFetch,
            contactIds.length > 0
              ? env.D1.prepare(
                  `SELECT id, full_name FROM contacts WHERE org_id = ? AND id IN (${contactIds.map(() => '?').join(',')})`
                ).bind(orgId, ...contactIds).all<{ id: string; full_name: string }>()
                  .then(r => { for (const row of r.results) contactNames.set(row.id, row.full_name); })
                  .catch(() => {})
              : Promise.resolve(),
            companyIds.length > 0
              ? env.D1.prepare(
                  `SELECT id, name FROM companies WHERE org_id = ? AND id IN (${companyIds.map(() => '?').join(',')})`
                ).bind(orgId, ...companyIds).all<{ id: string; name: string }>()
                  .then(r => { for (const row of r.results) companyNames.set(row.id, row.name); })
                  .catch(() => {})
              : Promise.resolve(),
            dealIds.length > 0
              ? env.D1.prepare(
                  `SELECT id, title FROM deals WHERE org_id = ? AND id IN (${dealIds.map(() => '?').join(',')})`
                ).bind(orgId, ...dealIds).all<{ id: string; title: string }>()
                  .then(r => { for (const row of r.results) dealTitles.set(row.id, row.title); })
                  .catch(() => {})
              : Promise.resolve(),
          ]);

          const byId = new Map(res.results.map(r => [r.id, r]));
          let kvMissCount = 0;
          for (const ref of docRows) {
            const row = byId.get(ref.sourceId);
            if (!row) continue;
            // Pick the most-specific linked entity (deal > company > contact)
            // and resolve to a human name + click target.
            let entityName: string | undefined;
            let entityUrl: string | undefined;
            if (row.deal_id && dealTitles.has(row.deal_id)) {
              entityName = dealTitles.get(row.deal_id);
              entityUrl = `/deals/${row.deal_id}`;
            } else if (row.company_id && companyNames.has(row.company_id)) {
              entityName = companyNames.get(row.company_id);
              entityUrl = `/companies/${row.company_id}`;
            } else if (row.contact_id && contactNames.has(row.contact_id)) {
              entityName = contactNames.get(row.contact_id);
              entityUrl = `/contacts/${row.contact_id}`;
            }

            // Excerpt resolution — the actual chunk text Claude saw, NOT the
            // doc-level intro. Order: KV chunk → extracted_text_preview → the
            // hydration-layer text (which already tries KV/R2-rechunk). The
            // last fallback exists so old docs still produce something useful.
            const kvChunk = chunkTextByVectorId.get(ref.chunk.id);
            let excerpt: string | undefined;
            if (kvChunk) {
              excerpt = extractExcerpt(kvChunk);
            } else {
              kvMissCount++;
              excerpt = row.extracted_text_preview
                ? extractExcerpt(row.extracted_text_preview)
                : extractExcerpt(ref.chunk.hydrated_text);
            }

            out.set(ref.id, {
              id: ref.id,
              type: 'document',
              source_table: 'documents',
              source_id: row.id,
              entity_id: row.deal_id || row.company_id || row.contact_id || undefined,
              title: row.title || row.file_name || 'Document',
              subtitle: row.document_type.replace(/_/g, ' '),
              date: row.created_at,
              url_path: `/documents/${row.id}`,
              excerpt,
              entity_name: entityName,
              entity_url_path: entityUrl,
            });
          }

          if (kvMissCount > 0) {
            console.warn(
              `[citations] KV chunk miss for ${kvMissCount}/${docRows.length} document citations — falling back to extracted_text_preview. Older docs likely uncached.`
            );
          }
        })
        .catch(e => console.error('[citations] documents lookup failed:', e))
    );
  }

  const newsRows = byTable.get('news_articles');
  if (newsRows && newsRows.length > 0) {
    const ids = newsRows.map(r => r.sourceId);
    const ph = ids.map(() => '?').join(',');
    lookups.push(
      env.D1.prepare(
        `SELECT id, title, source_name, source_url, published_at, company_id
         FROM news_articles WHERE org_id = ? AND id IN (${ph})`
      )
        .bind(orgId, ...ids)
        .all<{
          id: string;
          title: string;
          source_name: string | null;
          source_url: string | null;
          published_at: string | null;
          company_id: string | null;
        }>()
        .then(async res => {
          // Resolve linked company names so the panel can render
          // "About: <Company>" instead of a UUID.
          const companyIds = Array.from(
            new Set(res.results.map(r => r.company_id).filter(Boolean) as string[])
          );
          const companyNames = new Map<string, string>();
          if (companyIds.length > 0) {
            const cph = companyIds.map(() => '?').join(',');
            await env.D1.prepare(
              `SELECT id, name FROM companies WHERE org_id = ? AND id IN (${cph})`
            ).bind(orgId, ...companyIds).all<{ id: string; name: string }>()
              .then(r => { for (const row of r.results) companyNames.set(row.id, row.name); })
              .catch(() => {});
          }

          const byId = new Map(res.results.map(r => [r.id, r]));
          for (const ref of newsRows) {
            const row = byId.get(ref.sourceId);
            if (!row) continue;
            const entityName = row.company_id ? companyNames.get(row.company_id) : undefined;
            out.set(ref.id, {
              id: ref.id,
              type: 'news',
              source_table: 'news_articles',
              source_id: row.id,
              entity_id: row.company_id || undefined,
              title: row.title,
              subtitle: row.source_name || 'News',
              date: row.published_at || undefined,
              url_path: row.company_id ? `/companies/${row.company_id}` : '/',
              external_url: row.source_url || undefined,
              excerpt: extractExcerpt(ref.chunk.hydrated_text),
              entity_name: entityName,
              entity_url_path: row.company_id ? `/companies/${row.company_id}` : undefined,
            });
          }
        })
        .catch(e => console.error('[citations] news lookup failed:', e))
    );
  }

  await Promise.all(lookups);
  return Array.from(out.values()).sort((a, b) => a.id - b.id);
}

function formatSourceLine(s: CitationSource): string {
  const date = fmtDate(s.date);
  switch (s.type) {
    case 'email':
      return `[${s.id}] EMAIL — "${s.title}"${s.subtitle ? ` — ${s.subtitle}` : ''}${date ? ` — ${date}` : ''}`;
    case 'slack':
      return `[${s.id}] SLACK — ${s.subtitle || 'message'}: "${s.title}"${date ? ` — ${date}` : ''}`;
    case 'meeting':
      return `[${s.id}] MEETING — "${s.title}"${date ? ` — ${date}` : ''}`;
    case 'document':
      return `[${s.id}] DOCUMENT — "${s.title}"${s.subtitle ? ` (${s.subtitle})` : ''}${date ? ` — ${date}` : ''}`;
    case 'news':
      return `[${s.id}] NEWS — "${s.title}"${s.subtitle ? ` — ${s.subtitle}` : ''}${date ? ` — ${date}` : ''}`;
    case 'contact':
      return `[${s.id}] CONTACT — ${s.title}${s.subtitle ? ` (${s.subtitle})` : ''}`;
    case 'company':
      return `[${s.id}] COMPANY — ${s.title}${s.subtitle ? ` (${s.subtitle})` : ''}`;
  }
}

export interface BuildSourcesResult {
  sources: CitationSource[];
  contextBlock: string;
}

// Detect which source type(s) the user is asking about. Used to emit
// ALTERNATIVE-block sentinels when retrieval returned content of the wrong
// type (e.g. user asked "Slack" but only emails came back). Returns the set
// of explicitly-intended types — empty set = no specific type asked, all
// types fair game.
function detectIntendedSourceTypes(query: string): Set<CitationSourceType> {
  const lower = query.toLowerCase();
  const intended = new Set<CitationSourceType>();
  if (/\b(slack|channel|dm)\b/.test(lower)) intended.add('slack');
  // Only treat email as intended when "email" appears as a word; "thread" /
  // "message" are too broad — users say "email thread" but also "Slack
  // thread" / "any messages from X."
  if (/\b(email|emails|inbox)\b/.test(lower)) intended.add('email');
  if (/\b(meeting|meetings|transcript|call|calls)\b/.test(lower)) intended.add('meeting');
  if (/\b(document|documents|doc|docs|pdf|attachment|file|files)\b/.test(lower)) intended.add('document');
  return intended;
}

export async function buildSourcesAndContext(
  internal: HydratedChunk[],
  news: HydratedChunk[],
  uploadedDoc: string | undefined,
  orgId: string,
  env: Env,
  query?: string
): Promise<BuildSourcesResult> {
  // Assign one source number per unique (source_table, source_id) — multiple
  // chunks from the same email/meeting collapse to a single citation.
  const sourceIdByKey = new Map<string, number>();
  const refs: { id: number; chunk: HydratedChunk }[] = [];
  const orderedChunks: ChunkRef[] = [];

  let nextId = 1;
  for (const chunk of [...internal, ...news]) {
    const key = sourceKeyFor(chunk);
    if (!sourceIdByKey.has(key)) {
      sourceIdByKey.set(key, nextId);
      refs.push({ id: nextId, chunk });
      nextId++;
    }
    orderedChunks.push({ chunk, sourceKey: key });
  }

  const sources = await hydrateSources(refs, orgId, env);

  // SOURCES list at the top of the context — Claude reads this as the lookup
  // table for [^N] markers.
  let header = 'SOURCES (cite these by number using [^N] format — never with parentheticals):\n';
  for (const s of sources) header += formatSourceLine(s) + '\n';

  // Wave-fix Chunk 2 sentinels. Two failure modes the prompt-only fix in
  // Chunk 1 doesn't address structurally:
  //   (3A) Empty SOURCES — retrieval returned nothing usable. Without an
  //        explicit sentinel the model sees a bare "SOURCES:\n" header and
  //        an empty CONTEXT block, then has to infer "no data" from
  //        emptiness. Make it explicit.
  //   (3C) Type-mismatch — user asked about Slack (or emails or meetings),
  //        retrieval returned content of OTHER types. The model has real
  //        numbered sources to cite but they don't answer the type-scoped
  //        question. Surface the mismatch so the model leads with "I don't
  //        have <type> on this; here's what I do have."
  // Detection only fires when `query` is supplied (caller opts in).
  if (sources.length === 0) {
    header += '(no internal data matched this query — answer honestly with "I don\'t have data on that," or pivot to web_search/general knowledge if applicable.)\n';
  } else if (query) {
    const intended = detectIntendedSourceTypes(query);
    if (intended.size > 0) {
      const presentTypes = new Set(sources.map(s => s.type));
      const missing = [...intended].filter(t => !presentTypes.has(t));
      const presentList = [...presentTypes].filter(t => !intended.has(t));
      if (missing.length > 0) {
        const missingLabel = missing.map(t => t.toUpperCase()).join('/');
        const presentLabel = presentList.length > 0
          ? `the SOURCES below are all ${presentList.map(t => t.toUpperCase()).join('/')} content`
          : 'no relevant content of any other type was found either';
        header += `\nSOURCE-TYPE MISMATCH: the user asked about ${missingLabel} content but zero ${missingLabel} sources matched — ${presentLabel}. State this honestly: "No ${missing.join('/').toLowerCase()} messages/emails/etc on that." Then optionally surface the available content as adjacent context, framed clearly. Do NOT cite ${presentList.length > 0 ? presentList.map(t => t.toUpperCase()).join('/') : 'OTHER-TYPE'} sources to support claims about ${missingLabel}.\n`;
      }
    }
  }

  // Body: each chunk prefixed with its source number so Claude can match it
  // back. Truncated to PER_CHUNK_MAX tokens, hard-capped at CONTEXT_TOKEN_BUDGET
  // total.
  const docTokens = uploadedDoc
    ? Math.min(estimateTokens(uploadedDoc), UPLOAD_TOKEN_BUDGET)
    : 0;
  const retrievedBudget = CONTEXT_TOKEN_BUDGET - docTokens;

  let body = '\nCONTEXT FROM SOURCES:\n';
  let tokens = 0;
  for (const ref of orderedChunks) {
    const isNews = (ref.chunk.metadata.document_type as string) === 'news';
    if (isNews) continue; // news rendered separately below with UNVERIFIED tag
    const sourceId = sourceIdByKey.get(ref.sourceKey)!;
    const t = estimateTokens(ref.chunk.hydrated_text);
    if (tokens + t > retrievedBudget) break;
    const text =
      t > PER_CHUNK_MAX
        ? truncateToTokens(ref.chunk.hydrated_text, PER_CHUNK_MAX)
        : ref.chunk.hydrated_text;
    body += `\n[${sourceId}] ${text}\n`;
    tokens += estimateTokens(text);
  }

  if (uploadedDoc) {
    const truncated =
      docTokens >= UPLOAD_TOKEN_BUDGET
        ? truncateToTokens(uploadedDoc, UPLOAD_TOKEN_BUDGET) + '\n[DOCUMENT TRUNCATED]'
        : uploadedDoc;
    body += `\n\n--- UPLOADED DOCUMENT ---\n${truncated}`;
  }

  let newsBlock = '\n\n--- EXTERNAL NEWS CONTEXT [UNVERIFIED] ---\n';
  let nt = 0;
  for (const ref of orderedChunks) {
    const isNews = (ref.chunk.metadata.document_type as string) === 'news';
    if (!isNews) continue;
    const sourceId = sourceIdByKey.get(ref.sourceKey)!;
    const t = estimateTokens(ref.chunk.hydrated_text);
    if (nt + t > NEWS_TOKEN_BUDGET) break;
    newsBlock += `\n[${sourceId}] [EXTERNAL — UNVERIFIED | ${ref.chunk.metadata.created_at || ''}]\n${ref.chunk.hydrated_text}\n`;
    nt += t;
  }

  return {
    sources,
    contextBlock: header + body + newsBlock,
  };
}

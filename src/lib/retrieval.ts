// TRD §8.2-8.5 — preprocessQuery, retrieveContext, crossEncoderRerank
// (context assembly with citation sources lives in lib/citations.ts)
import type { Env } from '../types/env';
import type {
  AgentSession,
  HydratedChunk,
  ProcessedQuery,
  VectorMatch,
} from '../types/interfaces';
import { hydrateChunks } from './hydration';
import { runEmbedding } from './embedding';
import { truncateToTokens } from './tokens';
import { getOrgSettings, getSharingFlags, parseParticipantUserIds } from './helpers';
import { getEntityIndex } from './entity-index';

export interface RetrievalOptions {
  deepDive?: boolean;
}

function isAggregationQuery(query: string): boolean {
  return /\b(how many|count|total|tally|all the|every|list all|summarize all|aggregate|across all|compile|gather all)\b/i.test(query);
}

const DOC_TYPE_KEYWORDS: Record<string, string[]> = {
  pitch_deck: ['pitch deck', 'pitch decks', 'deck', 'decks', 'presentation'],
  email: ['email', 'emails', 'message', 'thread'],
  transcript: ['meeting', 'meetings', 'call', 'calls', 'transcript', 'discussion'],
  document: ['document', 'file', 'attachment', 'pdf', 'doc'],
};

function detectDocTypes(query: string): string[] {
  const lower = query.toLowerCase();
  const matched: string[] = [];
  for (const [docType, keywords] of Object.entries(DOC_TYPE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) matched.push(docType);
  }
  return matched;
}

export async function preprocessQuery(
  query: string,
  session: AgentSession,
  env: Env,
  options: RetrievalOptions = {}
): Promise<ProcessedQuery> {
  const queryLower = query.toLowerCase();
  const entityIds: string[] = [];
  const maxEntities = options.deepDive ? 20 : 5;

  if (options.deepDive) {
    const [contacts, companies] = await Promise.all([
      env.D1.prepare(
        `SELECT id, full_name, email, job_title, bio_summary, topics_of_interest,
                investment_focus, company_id
         FROM contacts WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
      ).bind(session.org_id).all<{
        id: string; full_name: string; email: string | null; job_title: string | null;
        bio_summary: string | null; topics_of_interest: string | null;
        investment_focus: string | null; company_id: string | null;
      }>(),
      env.D1.prepare(
        `SELECT id, name, domain, description, sector
         FROM companies WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
      ).bind(session.org_id).all<{
        id: string; name: string; domain: string | null; description: string | null; sector: string | null;
      }>(),
    ]);

    for (const c of contacts.results) {
      const searchable = [c.full_name, c.email, c.job_title, c.bio_summary, c.topics_of_interest, c.investment_focus]
        .filter(Boolean).join(' ').toLowerCase();
      if (queryLower.includes(c.full_name.toLowerCase()) || searchable.includes(queryLower)) {
        entityIds.push(c.id);
      }
    }
    for (const c of companies.results) {
      const searchable = [c.name, c.domain, c.description, c.sector]
        .filter(Boolean).join(' ').toLowerCase();
      if (queryLower.includes(c.name.toLowerCase()) || searchable.includes(queryLower)) {
        entityIds.push(c.id);
      }
    }

    if (options.deepDive && entityIds.length > 0) {
      const companyIds = new Set<string>();
      const contactCompanyIds = new Set<string>();
      for (const id of entityIds) {
        const company = companies.results.find(c => c.id === id);
        if (company) companyIds.add(company.id);
        const contact = contacts.results.find(c => c.id === id);
        if (contact?.company_id) contactCompanyIds.add(contact.company_id);
      }
      for (const cid of [...companyIds, ...contactCompanyIds]) {
        for (const contact of contacts.results) {
          if (contact.company_id === cid && !entityIds.includes(contact.id)) {
            entityIds.push(contact.id);
          }
        }
        if (!entityIds.includes(cid)) entityIds.push(cid);
      }
    }
  } else {
    try {
      const index = await getEntityIndex(session.org_id, env);
      type ScoredEntity = { id: string; score: number; interactions: number; recency: number };
      const scored: ScoredEntity[] = [];

      for (const c of index.contacts) {
        let score = 0;
        const nameLower = c.full_name.toLowerCase();
        if (queryLower.includes(nameLower)) score += 1.0;
        else if (nameLower.split(' ').some(part => part.length > 2 && queryLower.includes(part))) score += 0.4;
        if (c.email && queryLower.includes(c.email.toLowerCase())) score += 0.8;
        if (c.company_name && queryLower.includes(c.company_name.toLowerCase())) score += 0.3;
        if (c.job_title && queryLower.includes(c.job_title.toLowerCase())) score += 0.2;
        if (c.bio_keywords) {
          const kws = c.bio_keywords.split(',');
          const matched = kws.filter(kw => queryLower.includes(kw)).length;
          if (matched > 0) score += 0.15 * matched;
        }
        if (score > 0) {
          scored.push({
            id: c.id,
            score,
            interactions: c.total_interactions || 0,
            recency: c.last_contact_date ? new Date(c.last_contact_date).getTime() : 0,
          });
        }
      }

      for (const c of index.companies) {
        let score = 0;
        const nameLower = c.name.toLowerCase();
        if (queryLower.includes(nameLower)) score += 1.0;
        else if (nameLower.split(' ').some(part => part.length > 2 && queryLower.includes(part))) score += 0.4;
        if (c.domain && queryLower.includes(c.domain.toLowerCase())) score += 0.5;
        if (c.sector && queryLower.includes(c.sector.toLowerCase())) score += 0.2;
        if (c.description_keywords) {
          const kws = c.description_keywords.split(',');
          const matched = kws.filter(kw => queryLower.includes(kw)).length;
          if (matched > 0) score += 0.15 * matched;
        }
        if (score > 0) {
          scored.push({ id: c.id, score, interactions: c.contact_count || 0, recency: 0 });
        }
      }

      scored.sort((a, b) => {
        if (Math.abs(a.score - b.score) > a.score * 0.1) return b.score - a.score;
        if (a.recency !== b.recency) return b.recency - a.recency;
        return b.interactions - a.interactions;
      });

      for (const s of scored.slice(0, maxEntities)) entityIds.push(s.id);
    } catch (e) {
      console.error('[retrieval] entity index failed, falling back to D1:', e);
      const [contacts, companies] = await Promise.all([
        env.D1.prepare('SELECT id, full_name FROM contacts WHERE org_id = ? AND deleted_at IS NULL')
          .bind(session.org_id).all<{ id: string; full_name: string }>(),
        env.D1.prepare('SELECT id, name FROM companies WHERE org_id = ? AND deleted_at IS NULL')
          .bind(session.org_id).all<{ id: string; name: string }>(),
      ]);
      for (const c of contacts.results) {
        if (queryLower.includes(c.full_name.toLowerCase())) entityIds.push(c.id);
      }
      for (const c of companies.results) {
        if (queryLower.includes(c.name.toLowerCase())) entityIds.push(c.id);
      }
    }
  }

  const [values, sharingFlags] = await Promise.all([
    runEmbedding(env, query, session.org_id),
    getSharingFlags(session.org_id, env),
  ]);

  const userId = session.user_id;
  const userRole = session.user_role || 'member';
  const sharingSet = new Set(Object.keys(sharingFlags));

  // Post-retrieval ACL filter. Default-DENY on undefined / unknown visibility:
  // earlier versions fell open (no `visibility` field → treated as accessible),
  // which means a vector missing that metadata could leak. Owners always pass.
  // Audit hook: every denial that's not the obvious 'private-and-not-a-participant'
  // case gets a structured warn, so we can spot legitimate content being denied
  // due to data-integrity gaps and backfill the missing visibility.
  const postRetrievalFilter = (chunk: VectorMatch): boolean => {
    if (userRole === 'owner') return true;

    // The interface narrows visibility to a fixed union, but Vectorize stores
    // `unknown` per-field — treat it as a string at runtime in case a vector
    // was upserted with a stale or unrecognized value.
    const visibility = chunk.metadata.visibility as unknown as string | undefined | null;

    if (!visibility) {
      console.warn('[acl] denying chunk with missing visibility', {
        vector_id: (chunk as any).id,
        source_table: chunk.metadata.source_table,
        primary_entity_id: chunk.metadata.primary_entity_id,
      });
      return false;
    }

    if (visibility === 'private') {
      const participants = parseParticipantUserIds(chunk.metadata.participant_user_ids as any);
      if (participants.includes(userId)) return true;
      if (participants.some(pid => sharingSet.has(pid))) return true;
      // Legacy fallback: chunks stamped with a single user_id rather than a
      // participant list. Honor only if it matches the requester.
      if (chunk.metadata.user_id && chunk.metadata.user_id === userId) return true;
      return false;
    }

    if (visibility === 'confidential') {
      return userRole === 'admin';
    }

    if (visibility === 'org_wide' || visibility === 'public' || visibility === 'org') {
      if (chunk.metadata.reconciliation_status === 'orphaned') return false;
      return true;
    }

    // Unknown visibility value — deny and log so we can find it.
    console.warn('[acl] denying chunk with unknown visibility', {
      visibility,
      vector_id: (chunk as any).id,
      source_table: chunk.metadata.source_table,
    });
    return false;
  };

  return {
    originalQuery: query,
    embeddedQuery: values,
    entityIds: [...new Set(entityIds)].slice(0, maxEntities),
    filters: {},
    orgId: session.org_id,
    postRetrievalFilter,
  };
}

export async function retrieveContext(
  pq: ProcessedQuery,
  env: Env,
  options: RetrievalOptions = {}
): Promise<{ internal: HydratedChunk[]; news: HydratedChunk[]; stats?: { emails: number; meetings: number; documents: number; contacts: number; companies: number } }> {
  const filter: any = {
    org_id: pq.orgId,
    document_type: { $nin: ['news'] },
  };

  const aggregation = isAggregationQuery(pq.originalQuery);
  // Vectorize hard limit: topK > 50 requires returnMetadata='indexed' + returnValues=false.
  // We use returnMetadata='all' here for ACL filtering (visibility, participant_user_ids,
  // user_id, reconciliation_status — none of which are indexed) and for chunk hydration
  // (r2_key, chunk_index, text_preview — also not indexed). So 50 is our ceiling.
  // Deep Dive's real value comes from per-entity boosts (×20), document-type queries, and
  // cross-entity bridging — not raw broad topK. (See: VECTOR_QUERY_ERROR 40025)
  // TODO: to raise broad topK above 50, declare metadata indexes for the four ACL fields,
  // re-upsert all existing vectors (Vectorize indexes are not retroactive), refactor
  // hydration.ts to read r2_key/chunk_index/text_preview from D1, and move ACL filtering
  // from post-retrieval JS to a D1 join. Multi-day project, not a hotfix.
  const broadTopK = options.deepDive ? 50 : (aggregation ? 50 : 30);
  const hydrateLimit = options.deepDive ? 50 : (aggregation ? 30 : 20);

  let internalMatches: VectorMatch[];

  if (pq.entityIds.length > 0) {
    const [entityResults, broadResults] = await Promise.all([
      Promise.all(
        pq.entityIds.map(id =>
          env.VECTORIZE.query(pq.embeddedQuery, {
            topK: 15,
            filter: { ...filter, primary_entity_id: id },
            returnValues: false,
            returnMetadata: 'all',
          })
        )
      ),
      env.VECTORIZE.query(pq.embeddedQuery, {
        topK: broadTopK,
        filter,
        returnValues: false,
        returnMetadata: 'all',
      }),
    ]);

    const seen = new Set<string>();
    internalMatches = [];
    for (const r of entityResults) {
      for (const m of (r.matches || []) as VectorMatch[]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          internalMatches.push(m);
        }
      }
    }
    for (const m of ((broadResults.matches || []) as VectorMatch[])) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        internalMatches.push(m);
      }
    }
  } else {
    const result = await env.VECTORIZE.query(pq.embeddedQuery, {
      topK: broadTopK,
      filter,
      returnValues: false,
      returnMetadata: 'all',
    });
    internalMatches = (result.matches || []) as VectorMatch[];
  }

  // Doc-type-aware secondary queries: if the query mentions specific
  // document types, run targeted filtered queries and merge results.
  const docTypes = detectDocTypes(pq.originalQuery);
  if (docTypes.length > 0) {
    const seen = new Set(internalMatches.map(m => m.id));
    const docResults = await Promise.all(
      docTypes.map(dt =>
        env.VECTORIZE.query(pq.embeddedQuery, {
          topK: 20,
          filter: { org_id: pq.orgId, document_type: dt },
          returnValues: false,
          returnMetadata: 'all',
        })
      )
    );
    for (const r of docResults) {
      for (const m of (r.matches || []) as VectorMatch[]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          internalMatches.push(m);
        }
      }
    }
  }

  if (options.deepDive && pq.entityIds.length > 0) {
    const seen = new Set(internalMatches.map(m => m.id));
    const entityQueries = pq.entityIds.slice(0, 20).map(id =>
      env.VECTORIZE.query(pq.embeddedQuery, {
        topK: 10,
        filter: { ...filter, primary_entity_id: id },
        returnValues: false,
        returnMetadata: 'all',
      })
    );
    const entityResults = await Promise.all(entityQueries);
    for (const r of entityResults) {
      for (const m of (r.matches || []) as VectorMatch[]) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          internalMatches.push(m);
        }
      }
    }
  }

  const filtered = internalMatches
    .filter(pq.postRetrievalFilter)
    .filter(m => m.score >= 0.55);

  const { chunks: hydrated } = await hydrateChunks(filtered.slice(0, hydrateLimit), env);
  let reranked = await crossEncoderRerank(hydrated, pq.originalQuery, pq.orgId, env);

  const rerankedLimit = options.deepDive ? 20 : 10;
  if (pq.entityIds.length > 0) {
    const entitySet = new Set(pq.entityIds);
    const scoped = reranked.filter(c => {
      const primary = c.metadata.primary_entity_id as string | undefined;
      const secondary = (c.metadata.secondary_entity_ids as string | undefined) || '';
      return (
        (primary && entitySet.has(primary)) ||
        secondary.split(',').some(id => entitySet.has(id))
      );
    });
    const other = reranked.filter(c => !scoped.includes(c));
    reranked = [...scoped, ...other].slice(0, rerankedLimit);
  } else {
    reranked = reranked.slice(0, rerankedLimit);
  }

  const newsResult = await env.VECTORIZE.query(pq.embeddedQuery, {
    topK: 10,
    filter: { org_id: pq.orgId, document_type: 'news' },
    returnValues: false,
    returnMetadata: 'all',
  });
  const newsMatches = ((newsResult.matches || []) as VectorMatch[])
    .filter(m => m.score >= 0.55)
    .slice(0, 5);
  const { chunks: newsChunks } = await hydrateChunks(newsMatches, env);

  if (options.deepDive) {
    const allChunks = [...reranked, ...newsChunks];
    const entitySet = new Set<string>();
    let emails = 0, meetings = 0, documents = 0;
    for (const c of allChunks) {
      const dt = c.metadata.document_type as string;
      if (dt === 'email') emails++;
      else if (dt === 'transcript') meetings++;
      else if (dt !== 'news') documents++;
      if (c.metadata.primary_entity_id) entitySet.add(c.metadata.primary_entity_id as string);
    }
    return {
      internal: reranked,
      news: newsChunks,
      stats: { emails, meetings, documents, contacts: entitySet.size, companies: 0 },
    };
  }

  return { internal: reranked, news: newsChunks };
}

// Recency boost — applied to rerank scores when the query contains temporal
// cues. Half-life of 90 days: today=1.0, 90d ago=0.5, 365d ago≈0.06. Only
// activates for explicitly time-sensitive queries so neutral questions like
// "what does this contract say about IP rights" stay age-agnostic.
const RECENCY_KEYWORDS = [
  'latest', 'recent', 'today', 'yesterday', 'this week', 'this month',
  'now', 'currently', 'just', 'newest', 'most recent', 'happening',
  'going on', 'lately', 'so far this', 'past few',
];

function detectsRecencyIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_KEYWORDS.some(kw => lower.includes(kw));
}

function recencyMultiplier(ageInDays: number): number {
  if (!Number.isFinite(ageInDays) || ageInDays < 0) return 1;
  return Math.exp(-ageInDays / 90);
}

function chunkAgeInDays(chunk: HydratedChunk): number {
  const dateStr = (chunk.metadata.date as string | undefined)
    || (chunk.metadata.created_at as string | undefined);
  if (!dateStr) return Infinity; // unknown age → fully decayed (won't surface for "recent" queries)
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

// Cross-encoder rerank using @cf/baai/bge-reranker-base via Workers AI.
// Replaces the prior Claude-based reordering (was slow ~1s p50, expensive,
// non-deterministic). BGE reranker scores (query, chunk-text) pairs directly;
// purpose-built for this and ~10× faster.
//
// Flow:
//   1. Early-return on tiny candidate sets (<= 3 chunks).
//   2. Honor org settings.reranker_enabled — when false, pass through capped.
//   3. Send query + chunk previews to bge-reranker-base, get per-chunk scores.
//   4. Optionally apply recency multiplier when the query is temporal.
//   5. Sort by combined score, return topK.
//   6. Any failure path falls back to the input order capped at 10 — never
//      throws, retrieval must keep working.
export async function crossEncoderRerank(
  chunks: HydratedChunk[],
  query: string,
  orgId: string,
  env: Env
): Promise<HydratedChunk[]> {
  if (chunks.length <= 3) return chunks;

  const settings = await getOrgSettings(orgId, env);
  if (!settings.reranker_enabled) return chunks.slice(0, 10);

  try {
    // BGE reranker accepts up to ~16K tokens of context combined; cap each
    // chunk at ~500 tokens so 30+ chunks fit comfortably.
    const contexts = chunks.map(c => ({
      text: truncateToTokens(c.hydrated_text, 500),
    }));

    const response = await env.AI.run('@cf/baai/bge-reranker-base' as any, {
      query,
      contexts,
    } as any);

    // Workers AI shape: { response: [{ id: number, score: number }, ...] }
    // where id is the index into our `contexts` array.
    const scoresArr: Array<{ id: number; score: number }> =
      Array.isArray((response as any)?.response) ? (response as any).response : [];

    if (scoresArr.length === 0) {
      // Defensive: model returned nothing usable. Fall back.
      return chunks.slice(0, 10);
    }

    const scoreById = new Map<number, number>();
    for (const s of scoresArr) {
      if (typeof s.id === 'number' && typeof s.score === 'number') {
        scoreById.set(s.id, s.score);
      }
    }

    const recencyOn = detectsRecencyIntent(query);
    const scored = chunks.map((c, i) => {
      const baseScore = scoreById.get(i) ?? 0;
      const adjusted = recencyOn ? baseScore * recencyMultiplier(chunkAgeInDays(c)) : baseScore;
      return { chunk: c, score: adjusted };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map(x => x.chunk);
  } catch (e) {
    console.error('[rerank] BGE reranker fallback:', e);
    return chunks.slice(0, 10);
  }
}

// --- §8.5: dynamic token budget ---

export const TOKEN_BUDGET = {
  system_prompt: 2000,
  session_history: 8000,
  max_retrieved: 63000,
  max_upload: 20000,
  news: 2000,
  query: 1000,
  buffer: 4000,
};


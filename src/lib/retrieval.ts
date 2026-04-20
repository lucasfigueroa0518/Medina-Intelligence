// TRD §8.2-8.5 — preprocessQuery, retrieveContext, crossEncoderRerank, assembleContext
import type { Env } from '../types/env';
import type {
  AgentSession,
  HydratedChunk,
  ProcessedQuery,
  VectorMatch,
} from '../types/interfaces';
import { hydrateChunks } from './hydration';
import { estimateTokens, truncateToTokens } from './tokens';
import { callClaude } from './claude';
import { checkClaudeRateLimit } from './rate-limit';
import { getOrgSettings } from './helpers';
import { RERANKER_SYSTEM_PROMPT } from '../prompts/reranker';

export async function preprocessQuery(
  query: string,
  session: AgentSession,
  env: Env
): Promise<ProcessedQuery> {
  const entityIds: string[] = [];

  const contacts = await env.D1.prepare(
    'SELECT id, full_name FROM contacts WHERE org_id = ? AND deleted_at IS NULL'
  ).bind(session.org_id).all<{ id: string; full_name: string }>();
  for (const c of contacts.results) {
    if (query.toLowerCase().includes(c.full_name.toLowerCase())) {
      entityIds.push(c.id);
    }
  }

  const companies = await env.D1.prepare(
    'SELECT id, name FROM companies WHERE org_id = ? AND deleted_at IS NULL'
  ).bind(session.org_id).all<{ id: string; name: string }>();
  for (const c of companies.results) {
    if (query.toLowerCase().includes(c.name.toLowerCase())) {
      entityIds.push(c.id);
    }
  }

  const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [query],
    pooling: 'cls',
  } as any);

  const values = Array.isArray((embedding as any).data)
    ? (embedding as any).data[0]
    : (embedding as any).data;

  const userId = session.user_id;
  const userRole = session.user_role || 'member';

  const postRetrievalFilter = (chunk: VectorMatch): boolean => {
    if (chunk.metadata.visibility === 'private') {
      if (userRole === 'owner') {
        // bypass — fiduciary access
      } else if (chunk.metadata.participant_user_ids) {
        const participants = String(chunk.metadata.participant_user_ids).split(',');
        if (!participants.includes(userId)) return false;
      } else if (
        chunk.metadata.user_id &&
        chunk.metadata.user_id !== userId
      ) {
        return false;
      }
    }

    if (
      chunk.metadata.visibility === 'confidential' &&
      userRole !== 'owner' &&
      userRole !== 'admin'
    ) {
      return false;
    }

    if (chunk.metadata.reconciliation_status === 'orphaned') return false;

    return true;
  };

  return {
    originalQuery: query,
    embeddedQuery: values,
    entityIds: [...new Set(entityIds)],
    filters: {},
    orgId: session.org_id,
    postRetrievalFilter,
  };
}

export async function retrieveContext(
  pq: ProcessedQuery,
  env: Env
): Promise<{ internal: HydratedChunk[]; news: HydratedChunk[] }> {
  const filter: any = {
    org_id: pq.orgId,
    document_type: { $nin: ['news'] },
  };

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
        topK: 20,
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
      topK: 30,
      filter,
      returnValues: false,
      returnMetadata: 'all',
    });
    internalMatches = (result.matches || []) as VectorMatch[];
  }

  const filtered = internalMatches
    .filter(pq.postRetrievalFilter)
    .filter(m => m.score >= 0.55);

  const { chunks: hydrated } = await hydrateChunks(filtered.slice(0, 20), env);
  let reranked = await crossEncoderRerank(hydrated, pq.originalQuery, pq.orgId, env);

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
    reranked = [...scoped, ...other].slice(0, 10);
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

  return { internal: reranked, news: newsChunks };
}

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
    if (!(await checkClaudeRateLimit(env, orgId, 'high'))) {
      return chunks.slice(0, 10);
    }

    const chunkText = chunks
      .map((c, i) => `[${i}] ${truncateToTokens(c.hydrated_text, 500)}`)
      .join('\n');

    const response = await callClaude(
      {
        system: RERANKER_SYSTEM_PROMPT,
        user: `Query: "${query}"\n\nChunks:\n${chunkText}`,
        max_tokens: 200,
        orgId,
      },
      'high',
      env
    );

    const cleaned = response
      .trim()
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('Non-array');

    const valid = (parsed as unknown[]).filter(
      (i): i is number =>
        typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < chunks.length
    );

    if (valid.length < Math.min(5, chunks.length)) {
      const result = valid.map(i => chunks[i]);
      const used = new Set(valid);
      for (let i = 0; i < chunks.length && result.length < 10; i++) {
        if (!used.has(i)) result.push(chunks[i]);
      }
      return result;
    }

    return valid.map(i => chunks[i]).slice(0, 10);
  } catch (e) {
    console.error('Re-ranker fallback:', e);
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

export function assembleContext(
  internal: HydratedChunk[],
  news: HydratedChunk[],
  uploadedDoc?: string
): string {
  const docTokens = uploadedDoc
    ? Math.min(estimateTokens(uploadedDoc), TOKEN_BUDGET.max_upload)
    : 0;
  const retrievedBudget = TOKEN_BUDGET.max_retrieved - docTokens;

  let ctx = '';
  let tokens = 0;
  for (const chunk of internal) {
    const t = estimateTokens(chunk.hydrated_text);
    if (tokens + t > retrievedBudget) break;
    const text = t > 2000 ? truncateToTokens(chunk.hydrated_text, 2000) : chunk.hydrated_text;
    ctx += `\n\n[Source: ${chunk.metadata.document_type} | ${chunk.metadata.source_table} | ${chunk.metadata.created_at}]\n${text}`;
    tokens += estimateTokens(text);
  }

  if (uploadedDoc) {
    const truncated =
      docTokens >= TOKEN_BUDGET.max_upload
        ? truncateToTokens(uploadedDoc, TOKEN_BUDGET.max_upload) + '\n[DOCUMENT TRUNCATED]'
        : uploadedDoc;
    ctx += `\n\n--- UPLOADED DOCUMENT ---\n${truncated}`;
  }

  ctx += '\n\n--- EXTERNAL NEWS CONTEXT [UNVERIFIED] ---\n';
  let nt = 0;
  for (const n of news) {
    const t = estimateTokens(n.hydrated_text);
    if (nt + t > TOKEN_BUDGET.news) break;
    ctx += `\n[EXTERNAL - UNVERIFIED | ${n.metadata.created_at}]\n${n.hydrated_text}`;
    nt += t;
  }
  return ctx;
}

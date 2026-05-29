import type { Env } from '../types/env';
import type { LexicalCandidate, RagChunkRecord } from '../types/rag-v2';
import { hasOrgWidePrivateDataAccess } from './helpers';

interface LexicalSearchOptions {
  orgId: string;
  topK?: number;
  entityIds?: string[];
  documentTypes?: string[];
  sourceFamilies?: string[];
  sourceTable?: string;
  userId?: string;
  userRole?: string;
  sharedUserIds?: string[];
}

type SearchableChunk = RagChunkRecord & { body: string };

const MAX_FTS_TERMS = 16;

function extractFtsTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._@-]{1,}/gi) || [];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const term of terms) {
    const cleaned = term.replace(/"/g, '').trim();
    if (cleaned.length < 2 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    deduped.push(cleaned);
    if (deduped.length >= MAX_FTS_TERMS) break;
  }
  return deduped;
}

function buildFtsMatchQuery(query: string): string | null {
  const terms = extractFtsTerms(query);
  if (terms.length === 0) return null;
  return terms.map(term => `"${term}"`).join(' OR ');
}

function exactTermBoost(query: string): number {
  const tokens = extractFtsTerms(query);
  if (tokens.length === 0) return 0;
  const rawTokens = query.match(/[A-Za-z0-9][A-Za-z0-9._@-]{1,}/g) || [];
  const hasSpecificToken = rawTokens.some(token =>
    token.includes('@') ||
    token.includes('.') ||
    /^[A-Z]{2,6}$/.test(token) ||
    /\d/.test(token)
  );
  return hasSpecificToken ? 0.08 : 0;
}

function addInClause(
  where: string[],
  params: unknown[],
  column: string,
  values: string[] | undefined
): void {
  const filtered = values?.filter(Boolean) || [];
  if (filtered.length === 0) return;
  where.push(`${column} IN (${filtered.map(() => '?').join(',')})`);
  params.push(...filtered);
}

export async function searchRagChunksD1Fts(
  env: Env,
  query: string,
  options: LexicalSearchOptions
): Promise<LexicalCandidate[]> {
  const matchQuery = buildFtsMatchQuery(query);
  if (!matchQuery) return [];

  const topK = Math.max(1, Math.min(options.topK || 100, 200));
  const where = ['c.org_id = ?'];
  const params: unknown[] = [options.orgId];

  addInClause(where, params, 'c.document_type', options.documentTypes);
  addInClause(where, params, 'c.source_family', options.sourceFamilies);
  if (options.sourceTable) {
    where.push('c.source_table = ?');
    params.push(options.sourceTable);
  }
  if (options.userId && !hasOrgWidePrivateDataAccess(options.userRole)) {
    const readableUserIds = [options.userId, ...(options.sharedUserIds || [])];
    const placeholders = readableUserIds.map(() => '?').join(',');
    where.push(`(
      c.source_table != 'conversations'
      OR c.visibility IN ('org_wide', 'public', 'org')
      OR EXISTS (
        SELECT 1 FROM conversation_participants cp_fts
         WHERE cp_fts.org_id = c.org_id
           AND cp_fts.conversation_id = c.source_id
           AND cp_fts.user_id IN (${placeholders})
      )
    )`);
    params.push(...readableUserIds);
  }
  if (options.entityIds?.length) {
    const entityClauses = options.entityIds.flatMap(() => [
      'c.primary_entity_id = ?',
      "(',' || COALESCE(c.secondary_entity_ids, '') || ',') LIKE ?",
    ]);
    where.push(`(${entityClauses.join(' OR ')})`);
    for (const entityId of options.entityIds) {
      params.push(entityId, `%,${entityId},%`);
    }
  }

  const sql = `
    SELECT
      f.chunk_id AS chunk_id,
      bm25(rag_chunks_v2_fts, 5.0, 1.0, 2.0, 4.0, 4.0) AS rank_score
    FROM rag_chunks_v2_fts f
    JOIN rag_chunks_v2 c ON c.id = f.chunk_id
    WHERE rag_chunks_v2_fts MATCH ?
      AND ${where.join(' AND ')}
    ORDER BY rank_score ASC
    LIMIT ?`;

  const result = await env.D1.prepare(sql)
    .bind(matchQuery, ...params, topK)
    .all<{ chunk_id: string; rank_score: number }>();

  const boost = exactTermBoost(query);
  return (result.results || []).map((row, index) => ({
    chunkId: row.chunk_id,
    score: -Number(row.rank_score || 0),
    rank: index + 1,
    source: 'd1_fts' as const,
    exactBoost: boost,
  }));
}

export async function upsertRagChunksD1Fts(env: Env, records: SearchableChunk[]): Promise<{ errors: string[] }> {
  if (records.length === 0) return { errors: [] };
  const statements: D1PreparedStatement[] = [];
  for (const record of records) {
    statements.push(env.D1.prepare('DELETE FROM rag_chunks_v2_fts WHERE chunk_id = ?').bind(record.id));
    statements.push(
      env.D1.prepare(
        `INSERT INTO rag_chunks_v2_fts
           (chunk_id, org_id, source_table, source_id, document_type, source_family,
            primary_entity_id, title, body, section_path, entity_names, exact_terms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        record.id,
        record.org_id,
        record.source_table,
        record.source_id,
        record.document_type,
        record.source_family,
        record.primary_entity_id,
        record.title || '',
        record.body || record.text_preview || '',
        record.section_path || '',
        record.entity_names || '',
        record.exact_terms || ''
      )
    );
  }

  try {
    await env.D1.batch(statements);
    return { errors: [] };
  } catch (e) {
    return { errors: [e instanceof Error ? e.message : String(e)] };
  }
}

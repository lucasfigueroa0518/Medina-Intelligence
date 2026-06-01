// TRD §6.5 — Industry-wide news intelligence via lightweight RSS/DDG search.
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { getOrgSettings, chunkArray } from '../lib/helpers';
import { hashShort } from '../lib/helpers';
import { scoreArticle } from '../lib/news-scoring';
import { assessNewsQuality } from '../lib/news-quality';
import { lightweightWebSearchSources } from '../lib/agent-web-search';

interface NewsArticle {
  title: string;
  source: string;
  date: string;
  summary: string;
  url?: string;
  relevance_tag?: string;
}

type RelevanceTag = 'direct_mention' | 'competitor' | 'industry_trend' | 'technology' | 'regulatory';

interface SearchQuery {
  query: string;
  tag: RelevanceTag;
  description: string;
}

function buildSearchQueries(
  companyName: string,
  sector: string | null,
  techFocus: string | null
): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const year = new Date().getFullYear();

  queries.push({
    query: `"${companyName}" news funding announcement ${year}`,
    tag: 'direct_mention',
    description: 'Direct company news',
  });

  if (sector) {
    queries.push({
      query: `${sector} companies funding ${year} startup investment`,
      tag: 'competitor',
      description: 'Competitor intelligence',
    });

    queries.push({
      query: `${sector} industry trends ${year} market analysis`,
      tag: 'industry_trend',
      description: 'Industry trends',
    });
  }

  const techTerms = techFocus || (sector ? `${sector} technology` : 'technology');
  queries.push({
    query: `${techTerms} developments AI automation ${year}`,
    tag: 'technology',
    description: 'Technology developments',
  });

  if (sector) {
    queries.push({
      query: `${sector} regulation policy changes ${year}`,
      tag: 'regulatory',
      description: 'Regulatory landscape',
    });
  }

  return queries;
}

async function runSearchQuery(
  searchQuery: SearchQuery,
  orgId: string,
  env: Env
): Promise<NewsArticle[]> {
  const cacheKey = `news_cache:${hashShort(orgId + searchQuery.query)}`;
  const cached = await env.KV.get<NewsArticle[]>(cacheKey, 'json');
  if (cached) return cached;

  const sources = await lightweightWebSearchSources(searchQuery.query, 5);
  const result = sources.map(source => {
    let host = '';
    try {
      host = new URL(source.uri).hostname.replace(/^www\./, '');
    } catch {
      host = source.provider || 'web';
    }
    return {
      title: source.title,
      source: source.publisher || host,
      date: source.published_at || '',
      summary: source.snippet || '',
      url: source.uri,
      relevance_tag: searchQuery.tag,
    };
  });
  await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
  return result;
}

export interface NewsFetchTelemetry {
  companies_queried: number;
  succeeded: number;
  failed: number;
  articles_fetched: number;
  step_duration_ms: number;
}

export interface NewsFetchResult {
  items: ClassifiableItem[];
  telemetry: NewsFetchTelemetry;
}

interface CompanyRow {
  id: string;
  name: string;
  sector: string | null;
  description: string | null;
}

// Audit 2026-04-28: the historical implementation queried up to 20 companies
// and fired multiple model-grounded searches per company. The lightweight
// design keeps the same workload controls while using RSS/DDG fetches:
//
//   1. Staleness filter on companies.last_news_fetched_at — only fetch
//      companies untouched in the last 24h. Hourly cron + ~25/run covers the
//      whole portfolio every ~7-8 hours without ever revisiting the same row.
//   2. Hard cap MAX_PER_RUN = 25. Even if more are stale, never queue more.
//   3. Parallelize at the company level with Promise.allSettled. One slow or
//      failing company can't block the others.
//   4. Per-company wallclock budget. If a company's queries are taking too
//      long, abandon remaining queries for that company so the rest of the
//      run isn't held hostage.
//   5. UPDATE last_news_fetched_at for every attempted company, success or
//      failure. A consistently-broken company doesn't get retried every run.
const MAX_PER_RUN = 25;
const PER_COMPANY_BUDGET_MS = 25_000;

// Keep company-level search chunked and paced so RSS/DDG fetches do not
// synchronize into a noisy burst.
const NEWS_CHUNK_SIZE = 5;
const NEWS_INTER_BATCH_DELAY_MS = 1500;

export async function fetchNewsForActiveCompanies(
  orgId: string,
  env: Env
): Promise<NewsFetchResult> {
  const stepStart = Date.now();
  const zero: NewsFetchTelemetry = {
    companies_queried: 0,
    succeeded: 0,
    failed: 0,
    articles_fetched: 0,
    step_duration_ms: 0,
  };

  const settings = await getOrgSettings(orgId, env);
  if (!settings.news_feed_enabled) {
    return { items: [], telemetry: { ...zero, step_duration_ms: Date.now() - stepStart } };
  }

  // Staleness-ordered selection: never-fetched first, then oldest. The
  // staleness predicate (NULL OR < now-1day) guarantees we don't re-touch a
  // company within 24h. ORDER BY (NULL FIRST) ensures the never-fetched
  // backlog is cleared before we cycle through previously-fetched ones.
  const companies = await env.D1.prepare(
    `SELECT id, name, sector, description FROM companies
       WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL
         AND investment_status NOT IN ('passed', 'exited')
         AND (last_news_fetched_at IS NULL
              OR last_news_fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))
       ORDER BY (last_news_fetched_at IS NOT NULL),
                last_news_fetched_at ASC,
                news_relevance_score DESC
       LIMIT ?`
  ).bind(orgId, MAX_PER_RUN).all<CompanyRow>();

  if (companies.results.length === 0) {
    return { items: [], telemetry: { ...zero, step_duration_ms: Date.now() - stepStart } };
  }

  // Chunked dispatch with inter-batch pacing keeps the cheap search path
  // friendly to RSS/DDG endpoints. One slow / failing company in a batch
  // cannot poison the batch, and a slow batch cannot poison subsequent
  // batches.
  const chunks = chunkArray(companies.results, NEWS_CHUNK_SIZE);
  const items: ClassifiableItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (let batchIdx = 0; batchIdx < chunks.length; batchIdx++) {
    const batch = chunks[batchIdx];
    const batchResults = await Promise.allSettled(
      batch.map(c => fetchOneCompany(c, orgId, env))
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.ok) {
        items.push(...r.value.items);
        succeeded++;
      } else {
        failed++;
      }
    }
    // Pace between batches. Skip after the last batch — no work follows.
    if (batchIdx < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, NEWS_INTER_BATCH_DELAY_MS));
    }
  }

  // Stamp every attempted company — successes AND failures. Without this, a
  // company whose searches always fail would re-enter the staleness pool
  // every run forever.
  const attemptedIds = companies.results.map(c => c.id);
  if (attemptedIds.length > 0) {
    const placeholders = attemptedIds.map(() => '?').join(',');
    await env.D1.prepare(
      `UPDATE companies SET last_news_fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (${placeholders})`
    ).bind(...attemptedIds).run();
  }

  return {
    items,
    telemetry: {
      companies_queried: companies.results.length,
      succeeded,
      failed,
      articles_fetched: items.length,
      step_duration_ms: Date.now() - stepStart,
    },
  };
}

async function fetchOneCompany(
  company: CompanyRow,
  orgId: string,
  env: Env
): Promise<{ ok: boolean; items: ClassifiableItem[] }> {
  const start = Date.now();
  const items: ClassifiableItem[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();

  try {
    const techFocus = company.description ? company.description.substring(0, 100) : null;
    const queries = buildSearchQueries(company.name, company.sector, techFocus);

    for (const searchQuery of queries) {
      // Per-company wallclock budget. Skip remaining queries if we've spent
      // too long on this one — caller's step timeout is the hard ceiling.
      if (Date.now() - start > PER_COMPANY_BUDGET_MS) {
        console.warn(
          `[news] ${company.name} budget exceeded after ${Date.now() - start}ms — skipping ${queries.length - queries.indexOf(searchQuery)} remaining queries`
        );
        break;
      }
      try {
        const articles = await runSearchQuery(searchQuery, orgId, env);

        for (const article of articles) {
          const titleKey = article.title.toLowerCase().trim();
          if (seenTitles.has(titleKey)) continue;
          seenTitles.add(titleKey);

          const tag = (article.relevance_tag || searchQuery.tag) as RelevanceTag;
          const relevanceScore = scoreArticle({
            relevance_tag: tag,
            published_at: article.date,
          });
          const quality = assessNewsQuality({
            sourceUrl: article.url || null,
            publishedAt: article.date,
          });
          if (quality.normalizedUrl) {
            if (seenUrls.has(quality.normalizedUrl)) continue;
            seenUrls.add(quality.normalizedUrl);
          }

          if (quality.status === 'usable' && quality.normalizedUrl) {
            const existing = await env.D1.prepare(
              `SELECT id FROM news_articles
                WHERE org_id = ? AND source_url_normalized = ? AND quality_status = 'usable'
                LIMIT 1`
            ).bind(orgId, quality.normalizedUrl).first<{ id: string }>();
            if (existing?.id) continue;
          }

          const articleId = hashShort(article.title + article.date + company.id);
          const inserted = await env.D1.prepare(
            `INSERT OR IGNORE INTO news_articles
               (id, org_id, company_id, title, source_url, source_name, published_at,
                summary, relevance_tag, relevance_score, sector, source_url_normalized,
                quality_status, quality_reason, quarantined_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     CASE WHEN ? != 'usable' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
                     strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
          ).bind(
            articleId, orgId, company.id,
            article.title, article.url || null, article.source,
            article.date, article.summary,
            tag, relevanceScore, company.sector,
            quality.normalizedUrl,
            quality.status,
            quality.reason,
            quality.status
          ).run();

          if (quality.status !== 'usable' || !inserted.meta?.changes) continue;

          items.push({
            type: 'news',
            source: 'claude_search',
            externalId: `news:${hashShort(article.title + article.date)}`,
            // articleId === news_articles.id from the INSERT above. Used by
            // classification as entityId so vector_entity_index points at a
            // real row (was orphaned with a fresh UUID prior to 2026-04-28).
            articleId,
            subject: article.title,
            bodyText: `[${tag.toUpperCase()}] ${article.title}\n\n${article.summary}\n\nSource: ${article.source}${
              article.url ? ` (${article.url})` : ''
            }\nPublished: ${article.date}\nRelevance: ${tag.replace(/_/g, ' ')} (score: ${relevanceScore})`,
            bodyPreview: article.summary?.substring(0, 500) || '',
            sentAt: article.date || new Date().toISOString(),
            direction: 'inbound',
            orgId,
            visibility: 'org_wide',
            relatedCompanyId: company.id,
            relatedCompanyName: company.name,
          });
        }
      } catch (e) {
        console.error(`News search failed for ${company.name} [${searchQuery.description}]:`, e);
      }
    }

    try {
      const { recalculateCompanyNewsScore } = await import('../lib/news-scoring');
      await recalculateCompanyNewsScore(company.id, orgId, env);
    } catch (e) {
      console.error(`News score recalc failed for ${company.name}:`, e);
    }

    return { ok: true, items };
  } catch (e) {
    console.error(`[news] ${company.name} failed:`, e);
    return { ok: false, items };
  }
}

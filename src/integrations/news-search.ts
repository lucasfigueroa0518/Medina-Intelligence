// TRD §6.5 — Industry-wide news intelligence via Gemini web search (grounded).
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { callGemini } from '../lib/gemini';
import {
  checkGeminiRateLimit,
  checkEnrichmentRateLimit,
  recordEnrichmentRateLimit,
} from '../lib/rate-limit';
import { getOrgSettings } from '../lib/helpers';
import { hashShort } from '../lib/helpers';
import { scoreArticle } from '../lib/news-scoring';

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

  const newsPrompt = `Use Google Search to find recent news about: ${searchQuery.query}

Find 3-5 relevant articles from the past 30 days. For each article include:
- title
- source (publication name)
- date (ISO 8601)
- url (article URL)
- summary (2 sentences on key points)

Focus on: funding announcements, partnerships, product launches, leadership changes, acquisitions, regulatory developments, market analysis. Ignore purely promotional press releases.

Return ONLY a JSON array:
[{"title": "...", "source": "...", "date": "...", "url": "...", "summary": "..."}]

If no recent news found, return: []`;

  const { text } = await callGemini(
    {
      system:
        'You are a financial news researcher. Use Google Search grounding to find real, recent articles. Return only a valid JSON array. No preamble, no markdown, no code fences.',
      user: newsPrompt,
      max_tokens: 2000,
      orgId,
    },
    'low',
    env
  );

  try {
    const cleaned = text
      .trim()
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    const articles: NewsArticle[] = JSON.parse(match ? match[0] : cleaned);
    if (!Array.isArray(articles)) return [];
    const result = articles.map(a => ({
      ...a,
      url: a.url && !a.url.includes('vertexaisearch.cloud.google.com') ? a.url : undefined,
      relevance_tag: searchQuery.tag,
    }));
    await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 21600 });
    return result;
  } catch {
    return [];
  }
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

// Audit 2026-04-28: the prior implementation queried up to 20 companies and
// fired ~5 Gemini calls per company SERIALLY. With 187 active companies and
// each call taking 2–5s, the step routinely blew past 300s. The new design:
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

  // Run all selected companies concurrently. Promise.allSettled means a
  // single throw / rejection inside fetchOneCompany never poisons the batch.
  const results = await Promise.allSettled(
    companies.results.map(c => fetchOneCompany(c, orgId, env))
  );

  const items: ClassifiableItem[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) {
      items.push(...r.value.items);
      succeeded++;
    } else {
      failed++;
    }
  }

  // Stamp every attempted company — successes AND failures. Without this, a
  // company whose Gemini calls always fail would re-enter the staleness pool
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

  try {
    if (!(await checkGeminiRateLimit(env, orgId, 'low'))) {
      await recordEnrichmentRateLimit('gemini_news', orgId, env);
      return { ok: false, items };
    }
    if (!(await checkEnrichmentRateLimit('gemini_news', orgId, env))) {
      return { ok: false, items };
    }

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
      if (!(await checkGeminiRateLimit(env, orgId, 'low'))) break;

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

          const articleId = hashShort(article.title + article.date + company.id);
          await env.D1.prepare(
            `INSERT OR IGNORE INTO news_articles
               (id, org_id, company_id, title, source_url, source_name, published_at,
                summary, relevance_tag, relevance_score, sector, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
          ).bind(
            articleId, orgId, company.id,
            article.title, article.url || null, article.source,
            article.date, article.summary,
            tag, relevanceScore, company.sector
          ).run();

          items.push({
            type: 'news',
            source: 'claude_search',
            externalId: `news:${hashShort(article.title + article.date)}`,
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

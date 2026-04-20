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
    return articles.map(a => ({
      ...a,
      url: a.url && !a.url.includes('vertexaisearch.cloud.google.com') ? a.url : undefined,
      relevance_tag: searchQuery.tag,
    }));
  } catch {
    return [];
  }
}

export async function fetchNewsForActiveCompanies(
  orgId: string,
  env: Env
): Promise<ClassifiableItem[]> {
  const settings = await getOrgSettings(orgId, env);
  if (!settings.news_feed_enabled) return [];

  const companies = await env.D1.prepare(
    `SELECT id, name, sector, description FROM companies
     WHERE org_id = ? AND deleted_at IS NULL
       AND investment_status NOT IN ('passed', 'exited')
     ORDER BY news_relevance_score DESC LIMIT 20`
  ).bind(orgId).all<{ id: string; name: string; sector: string | null; description: string | null }>();

  const items: ClassifiableItem[] = [];
  const seenTitles = new Set<string>();

  for (const company of companies.results) {
    if (!(await checkGeminiRateLimit(env, orgId, 'low'))) {
      await recordEnrichmentRateLimit('gemini_news', orgId, env);
      break;
    }
    if (!(await checkEnrichmentRateLimit('gemini_news', orgId, env))) break;

    const techFocus = company.description
      ? company.description.substring(0, 100)
      : null;

    const queries = buildSearchQueries(company.name, company.sector, techFocus);

    for (const searchQuery of queries) {
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

          // Persist to news_articles table
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

    // Recalculate company news score after all queries
    try {
      const { recalculateCompanyNewsScore } = await import('../lib/news-scoring');
      await recalculateCompanyNewsScore(company.id, orgId, env);
    } catch (e) {
      console.error(`News score recalc failed for ${company.name}:`, e);
    }
  }

  return items;
}

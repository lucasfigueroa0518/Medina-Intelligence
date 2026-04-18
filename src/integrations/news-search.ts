// TRD §6.5 — News intelligence via Claude web search
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { callClaude } from '../lib/claude';
import {
  checkClaudeRateLimit,
  checkEnrichmentRateLimit,
  recordEnrichmentRateLimit,
} from '../lib/rate-limit';
import { getOrgSettings } from '../lib/helpers';
import { hashShort } from '../lib/helpers';

interface NewsArticle {
  title: string;
  source: string;
  date: string;
  summary: string;
}

export async function fetchNewsForActiveCompanies(
  orgId: string,
  env: Env
): Promise<ClassifiableItem[]> {
  const settings = await getOrgSettings(orgId, env);
  if (!settings.news_feed_enabled) return [];

  const companies = await env.D1.prepare(
    `SELECT id, name, sector FROM companies
     WHERE org_id = ? AND deleted_at IS NULL
       AND investment_status NOT IN ('passed', 'exited')
     ORDER BY news_relevance_score DESC LIMIT 20`
  ).bind(orgId).all<{ id: string; name: string; sector: string | null }>();

  const items: ClassifiableItem[] = [];

  for (const company of companies.results) {
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) {
      await recordEnrichmentRateLimit('claude_news', orgId, env);
      break;
    }
    if (!(await checkEnrichmentRateLimit('claude_news', orgId, env))) break;

    try {
      const newsPrompt = `Search for recent news about "${company.name}"${
        company.sector ? ` in the ${company.sector} sector` : ''
      }. Find the top 3-5 most relevant articles from the past 30 days. For each article, provide:
- Title
- Source name
- Publication date (ISO 8601)
- A 2-sentence summary of the article's key points

Focus on: funding announcements, partnerships, product launches, leadership changes, acquisitions, regulatory developments, and market analysis. Ignore press releases that are purely promotional.

Return your response as a JSON array:
[{"title": "...", "source": "...", "date": "...", "summary": "..."}]

If no recent news is found, return an empty array: []`;

      const response = await callClaude(
        {
          system:
            'You are a financial news researcher. Return only valid JSON arrays. No preamble, no markdown.',
          user: newsPrompt,
          max_tokens: 1500,
          orgId,
        },
        'low',
        env
      );

      let articles: NewsArticle[] = [];
      try {
        const cleaned = response
          .trim()
          .replace(/```json\s*/g, '')
          .replace(/```/g, '')
          .trim();
        articles = JSON.parse(cleaned);
        if (!Array.isArray(articles)) articles = [];
      } catch {
        articles = [];
      }

      for (const article of articles) {
        items.push({
          type: 'news',
          source: 'claude_search',
          externalId: `news:${hashShort(article.title + article.date)}`,
          subject: article.title,
          bodyText: `${article.title}\n\n${article.summary}\n\nSource: ${article.source}\nPublished: ${article.date}`,
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
      console.error(`News search failed for ${company.name}:`, e);
    }
  }

  return items;
}

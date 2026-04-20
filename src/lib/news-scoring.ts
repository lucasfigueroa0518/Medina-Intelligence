import type { Env } from '../types/env';

interface ScoringInput {
  relevance_tag: string;
  published_at: string | null;
}

const TAG_SCORE: Record<string, number> = {
  direct_mention: 3.0,
  competitor: 2.0,
  industry_trend: 1.5,
  technology: 1.0,
  regulatory: 1.0,
};

const TAG_CAP: Record<string, number> = {
  direct_mention: 6.0,
  competitor: 4.0,
  industry_trend: 3.0,
  technology: 2.0,
  regulatory: 2.0,
};

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 0;
  const published = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.max(0, (now - published) / (1000 * 60 * 60 * 24));
}

export function scoreArticle(article: ScoringInput): number {
  const base = TAG_SCORE[article.relevance_tag] ?? 0.5;
  const days = daysSince(article.published_at);
  const decay = Math.max(0, base - days * 0.05);
  return Math.round(decay * 10) / 10;
}

export async function recalculateCompanyNewsScore(
  companyId: string,
  orgId: string,
  env: Env
): Promise<number> {
  const articles = await env.D1.prepare(
    `SELECT relevance_tag, published_at FROM news_articles
     WHERE company_id = ? AND org_id = ?
     ORDER BY published_at DESC LIMIT 50`
  ).bind(companyId, orgId).all<ScoringInput>();

  const tagTotals: Record<string, number> = {};

  for (const article of articles.results) {
    const tag = article.relevance_tag || 'other';
    const score = scoreArticle(article);
    tagTotals[tag] = (tagTotals[tag] || 0) + score;
  }

  let total = 0;
  for (const [tag, sum] of Object.entries(tagTotals)) {
    const cap = TAG_CAP[tag] ?? 2.0;
    total += Math.min(sum, cap);
  }

  const capped = Math.round(Math.min(10.0, total) * 10) / 10;

  await env.D1.prepare(
    `UPDATE companies SET news_relevance_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND org_id = ?`
  ).bind(capped, companyId, orgId).run();

  return capped;
}

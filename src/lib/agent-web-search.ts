import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { callGemini } from './gemini';

interface WebSearchSource {
  title: string;
  uri: string;
  snippet?: string;
  provider?: 'duckduckgo' | 'google_news';
}

function clampResultLimit(numResults?: number): number {
  if (!Number.isFinite(numResults)) return 5;
  return Math.max(1, Math.min(10, Math.floor(numResults || 5)));
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(rawUrl: string): string {
  const decoded = decodeHtml(rawUrl).trim();
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return url.href;
  } catch {
    return decoded;
  }
}

async function fetchSearchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MedinaBot/1.0; +https://medinaventures.ai)',
      Accept: accept,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`search fallback returned ${res.status}`);
  }

  return await res.text();
}

async function searchDuckDuckGo(query: string, limit: number): Promise<WebSearchSource[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchSearchText(url, 'text/html,application/xhtml+xml');
  const blocks = html.match(/<div class="result[\s\S]*?(?=<div class="result|<\/body>)/gi) || [];
  const hits: WebSearchSource[] = [];

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const uri = normalizeUrl(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    if (!title || !uri || uri.includes('duckduckgo.com/y.js')) continue;

    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);

    hits.push({
      title,
      uri,
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : undefined,
      provider: 'duckduckgo',
    });

    if (hits.length >= limit) break;
  }

  return hits;
}

async function searchGoogleNewsRss(query: string, limit: number): Promise<WebSearchSource[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchSearchText(url, 'application/rss+xml,application/xml,text/xml');
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const hits: WebSearchSource[] = [];

  for (const item of itemBlocks) {
    const title = stripHtml((item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)
      || item.match(/<title>([\s\S]*?)<\/title>/i))?.[1] || '');
    const uri = stripHtml((item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim());
    const source = stripHtml((item.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || '').trim());
    const pubDate = stripHtml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '').trim());

    if (!title || !uri) continue;

    hits.push({
      title,
      uri,
      snippet: [source, pubDate].filter(Boolean).join(' · ') || undefined,
      provider: 'google_news',
    });

    if (hits.length >= limit) break;
  }

  return hits;
}

function dedupeSources(sources: WebSearchSource[], limit: number): WebSearchSource[] {
  const seen = new Set<string>();
  const deduped: WebSearchSource[] = [];

  for (const source of sources) {
    const key = source.uri.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

export async function fallbackWebSearch(query: string, numResults?: number): Promise<any> {
  const limit = clampResultLimit(numResults);
  const settled = await Promise.allSettled([
    searchGoogleNewsRss(query, limit),
    searchDuckDuckGo(query, limit),
  ]);

  const sources = dedupeSources(
    settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []),
    limit
  );

  if (!sources.length) {
    return {
      error: 'MARTy could not reach live web search right now after trying the primary and fallback search providers. Internal CRM retrieval still works; try live web again in a few minutes.',
      query,
    };
  }

  const summary = [
    'Fallback web/news search results:',
    '',
    ...sources.map((source, index) => {
      const detail = source.snippet ? ` — ${source.snippet}` : '';
      return `${index + 1}. ${source.title}${detail}`;
    }),
  ].join('\n');

  return {
    summary,
    sources: sources.map(({ title, uri }) => ({ title, uri })),
    query,
    search_mode: 'fallback',
  };
}

export async function webSearch(
  query: string,
  numResults: number | undefined,
  ctx: AuthContext,
  env: Env
): Promise<any> {
  try {
    const result = await callGemini(
      {
        system: 'You are a research assistant. Search the web for the given query and provide a comprehensive summary of the top results. Include key facts, dates, and sources. Be concise and factual.',
        user: query,
        max_tokens: 2000,
        orgId: ctx.orgId,
        userId: ctx.userId,
        budgetSource: 'gemini_web_search',
        grounding: true,
        temperature: 0.3,
      },
      'low',
      env
    );

    return {
      summary: result.text,
      sources: result.sources.slice(0, clampResultLimit(numResults)),
      query,
    };
  } catch (e: any) {
    if (e.message?.includes('GEMINI_RATE_LIMITED')) {
      return fallbackWebSearch(query, numResults);
    }
    if (e.message?.includes('GEMINI_CONFIG_ERROR')) {
      return fallbackWebSearch(query, numResults);
    }
    const fallback = await fallbackWebSearch(query, numResults);
    if (!fallback.error) return fallback;
    return { error: `MARTy web search failed: ${e.message}`, query };
  }
}

export async function readUrl(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MedinaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      return { error: `Failed to fetch URL: ${res.status} ${res.statusText}`, url };
    }

    const contentType = res.headers.get('content-type') || '';
    let text = await res.text();

    if (contentType.includes('text/html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const maxChars = 15000;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n[CONTENT TRUNCATED]';
    }

    const title = text.slice(0, 200).split(/[.\n]/)[0] || url;

    return { url, title: title.trim(), content: text };
  } catch (e: any) {
    return { error: `Failed to read URL: ${e.message}`, url };
  }
}

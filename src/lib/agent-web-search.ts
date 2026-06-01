import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';

export interface WebSearchSource {
  title: string;
  uri: string;
  snippet?: string;
  publisher?: string;
  published_at?: string;
  provider?: 'duckduckgo' | 'google_news';
}

export function clampResultLimit(numResults?: number): number {
  if (!Number.isFinite(numResults)) return 5;
  return Math.max(1, Math.min(10, Math.floor(numResults || 5)));
}

export function decodeHtml(value: string): string {
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

export function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
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

export async function searchDuckDuckGo(query: string, limit: number): Promise<WebSearchSource[]> {
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

export async function searchGoogleNewsRss(query: string, limit: number): Promise<WebSearchSource[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchSearchText(url, 'application/rss+xml,application/xml,text/xml');
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const hits: WebSearchSource[] = [];

  for (const item of itemBlocks) {
    const title = stripHtml((item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)
      || item.match(/<title>([\s\S]*?)<\/title>/i))?.[1] || '');
    const uri = stripHtml((item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim());
    const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = stripHtml((sourceMatch?.[1] || '').trim());
    const pubDate = stripHtml((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '').trim());
    const parsedPubDate = pubDate ? new Date(pubDate) : null;

    if (!title || !uri) continue;

    hits.push({
      title,
      uri,
      snippet: [source, pubDate].filter(Boolean).join(' · ') || undefined,
      publisher: source || undefined,
      published_at: parsedPubDate && !Number.isNaN(parsedPubDate.getTime()) ? parsedPubDate.toISOString() : undefined,
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

export async function lightweightWebSearchSources(query: string, numResults?: number): Promise<WebSearchSource[]> {
  const limit = clampResultLimit(numResults);
  const settled = await Promise.allSettled([
    searchGoogleNewsRss(query, limit),
    searchDuckDuckGo(query, limit),
  ]);

  return dedupeSources(
    settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []),
    limit
  );
}

export async function fallbackWebSearch(query: string, numResults?: number): Promise<any> {
  const sources = await lightweightWebSearchSources(query, numResults);

  if (!sources.length) {
    return {
      error: 'MARTy could not reach RSS/DDG web search right now. Internal CRM retrieval still works; try live web again in a few minutes.',
      query,
    };
  }

  const summary = [
    'RSS/DDG web/news search results:',
    '',
    ...sources.map((source, index) => {
      const detail = source.snippet ? ` — ${source.snippet}` : '';
      return `${index + 1}. ${source.title}${detail}`;
    }),
  ].join('\n');

  return {
    summary,
    sources: sources.map(({ title, uri, snippet, publisher, published_at, provider }) => ({
      title,
      uri,
      snippet,
      publisher,
      published_at,
      provider,
    })),
    query,
    search_mode: 'rss_ddg',
  };
}

export async function webSearch(
  query: string,
  numResults: number | undefined,
  _ctx: AuthContext,
  _env: Env
): Promise<any> {
  return fallbackWebSearch(query, numResults);
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

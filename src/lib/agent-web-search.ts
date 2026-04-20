import type { Env } from '../types/env';
import { callGemini } from './gemini';

export async function webSearch(
  query: string,
  numResults: number | undefined,
  env: Env
): Promise<any> {
  try {
    const result = await callGemini(
      {
        system: 'You are a research assistant. Search the web for the given query and provide a comprehensive summary of the top results. Include key facts, dates, and sources. Be concise and factual.',
        user: query,
        max_tokens: 2000,
        grounding: true,
        temperature: 0.3,
      },
      'high',
      env
    );

    return {
      summary: result.text,
      sources: result.sources.slice(0, numResults || 5),
      query,
    };
  } catch (e: any) {
    if (e.message?.includes('GEMINI_RATE_LIMITED')) {
      return { error: 'Web search is temporarily rate limited. Try again in a moment.', query };
    }
    if (e.message?.includes('GEMINI_CONFIG_ERROR')) {
      return { error: 'Web search is not configured. The Gemini API key needs to be set up.', query };
    }
    return { error: `Web search failed: ${e.message}`, query };
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

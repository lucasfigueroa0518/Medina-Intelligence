import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  searchDuckDuckGo,
  searchGoogleNewsRss,
  webSearch,
} from '../src/lib/agent-web-search';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RSS/DDG web search', () => {
  it('parses DuckDuckGo HTML result links and snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <html><body>
        <div class="result">
          <a class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fpost">Example &amp; Co</a>
          <a class="result__snippet">A useful &lt;b&gt;snippet&lt;/b&gt;.</a>
        </div>
      </body></html>
    `, { status: 200 })));

    const results = await searchDuckDuckGo('example query', 5);

    expect(results).toEqual([
      {
        title: 'Example & Co',
        uri: 'https://example.com/post',
        snippet: 'A useful snippet.',
        provider: 'duckduckgo',
      },
    ]);
  });

  it('parses Google News RSS metadata without Gemini', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <rss><channel>
        <item>
          <title><![CDATA[Funding round announced]]></title>
          <link>https://news.example.com/funding</link>
          <source url="https://news.example.com">Example News</source>
          <pubDate>Mon, 01 Jun 2026 09:30:00 GMT</pubDate>
        </item>
      </channel></rss>
    `, { status: 200 })));

    const results = await searchGoogleNewsRss('funding query', 5);

    expect(results[0]).toMatchObject({
      title: 'Funding round announced',
      uri: 'https://news.example.com/funding',
      publisher: 'Example News',
      published_at: '2026-06-01T09:30:00.000Z',
      provider: 'google_news',
    });
  });

  it('uses RSS/DDG as the MARTY web search path', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.includes('news.google.com')) {
        return new Response(`
          <rss><channel>
            <item>
              <title>Market update</title>
              <link>https://news.example.com/market</link>
              <source>Example News</source>
              <pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate>
            </item>
          </channel></rss>
        `, { status: 200 });
      }
      return new Response(`
        <html><body>
          <div class="result">
            <a class="result__a" href="https://example.com/company">Company page</a>
            <div class="result__snippet">Company snippet</div>
          </div>
        </body></html>
      `, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearch('company market', 5, {} as any, {} as any);

    expect(result.search_mode).toBe('rss_ddg');
    expect(result.summary).toContain('RSS/DDG web/news search results');
    expect(result.sources.map((source: any) => source.uri)).toContain('https://news.example.com/market');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('generativelanguage.googleapis.com'))).toBe(false);
  });
});

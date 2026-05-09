// Gemini API client with Google Search grounding.
// Used for any operation that needs *real* web pages fetched (enrichment
// dossiers, news lookup, LinkedIn URL discovery). Claude is kept for tasks
// that don't need live web I/O — RAG, re-ranker, extraction, structured JSON.

import type { Env } from '../types/env';
import { checkGeminiRateLimit } from './rate-limit';
import { recordRateLimit, type Upstream } from './upstream-budget';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiSource {
  title: string;
  uri: string;
}

export interface GeminiResult {
  text: string;
  sources: GeminiSource[];
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/**
 * Call Gemini with Google Search grounding enabled.
 *
 * Returns the generated text plus a deduped list of grounding source URLs,
 * which callers can append to the prose or store as separate citations.
 *
 * Throws 'GEMINI_RATE_LIMITED' when our per-org RPM limiter blocks the call,
 * or when the remote API returns 429.
 */
export async function callGemini(
  params: {
    system: string;
    user: string;
    max_tokens: number;
    orgId?: string;
    userId?: string | null;
    budgetSource?: Extract<Upstream, 'gemini' | 'gemini_web_search'>;
    grounding?: boolean; // default true
    temperature?: number;
  },
  priority: 'high' | 'low',
  env: Env
): Promise<GeminiResult> {
  const orgId = params.orgId || 'system';
  const userId = params.userId ?? null;
  const budgetSource = params.budgetSource || 'gemini';
  if (!(await checkGeminiRateLimit(env, orgId, priority, budgetSource, userId))) {
    throw new Error('GEMINI_RATE_LIMITED');
  }

  const apiKey = env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'GEMINI_CONFIG_ERROR: GOOGLE_GEMINI_API_KEY secret is not set. ' +
        'Run `wrangler secret put GOOGLE_GEMINI_API_KEY` to configure it.'
    );
  }

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: params.system }] },
    contents: [{ role: 'user', parts: [{ text: params.user }] }],
    generationConfig: {
      maxOutputTokens: params.max_tokens,
      temperature: params.temperature ?? 0.4,
    },
  };
  if (params.grounding !== false) {
    body.tools = [{ google_search: {} }];
  }

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // Per-request timeout. Without this, a single hung Gemini call blocks the
  // surrounding workflow step indefinitely — audit 2026-04-28 caught this
  // when the parallel news fetcher's 60s step timeout fired because a few
  // slow Gemini calls held up the parallel batch. 12s is generous for a
  // normal grounded response (typical p99 ~3-5s) and tight enough that a
  // hung tail can't poison the whole step.
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('GEMINI_TIMEOUT');
    }
    throw e;
  }

  if (!resp.ok) {
    const errTxt = await resp.text();
    if (resp.status === 429) {
      // Phase 3.2: feed the upstream_budget_ledger circuit breaker.
      // 3 consecutive 429s → cap drops 10%, circuit opens 30 min.
      // Pre-3.2 the KV-backed limiter could only observe its own
      // counter; the ledger gives us upstream-driven evidence.
      await recordRateLimit(env, orgId, userId, budgetSource, 'minute');
      throw new Error('GEMINI_RATE_LIMITED');
    }
    throw new Error(`Gemini API error ${resp.status}: ${errTxt.slice(0, 400)}`);
  }

  const data = (await resp.json()) as GeminiApiResponse;
  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message || data.error.status}`);
  }
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`);
  }

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  const rawChunks = cand?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  const sources: GeminiSource[] = [];
  for (const c of rawChunks) {
    const uri = c.web?.uri?.trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ uri, title: c.web?.title?.trim() || uri });
  }

  return { text, sources };
}

/**
 * Streaming variant. Each decoded server-sent chunk yields a delta of text.
 * Sources (grounding metadata) arrive on the final chunk and are returned
 * via a callback once the stream closes.
 *
 * This is wired the same way as callClaudeStreaming so the God Mode handler
 * could swap providers later if desired — but by default God Mode keeps
 * using Claude (it's RAG, not web search).
 */
export async function callGeminiStreaming(
  params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    max_tokens: number;
    grounding?: boolean;
    temperature?: number;
  },
  env: Env
): Promise<ReadableStream<Uint8Array>> {
  const apiKey = env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('GEMINI_CONFIG_ERROR: GOOGLE_GEMINI_API_KEY secret is not set.');
  }

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: params.system }] },
    contents: params.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: params.max_tokens,
      temperature: params.temperature ?? 0.4,
    },
  };
  if (params.grounding !== false) body.tools = [{ google_search: {} }];

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Gemini streaming error ${resp.status}: ${errTxt.slice(0, 400)}`);
  }
  if (!resp.body) throw new Error('Gemini returned no response body');

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const event = JSON.parse(jsonStr) as GeminiApiResponse;
          const delta = event.candidates?.[0]?.content?.parts?.[0]?.text;
          if (delta) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`));
          }
        } catch {
          // skip malformed lines
        }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });

  return resp.body.pipeThrough(transform);
}

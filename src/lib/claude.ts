// TRD §18.5 — callClaude + callClaudeStreaming via Cloudflare AI Gateway
import type { Env } from '../types/env';
import { checkClaudeRateLimit } from './rate-limit';

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

const ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Builds the Cloudflare AI Gateway URL for the Anthropic provider endpoint.
 * Format: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_slug}/anthropic/v1/messages
 */
function buildGatewayUrl(env: Env): string {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLAUDE_CONFIG_ERROR: CLOUDFLARE_ACCOUNT_ID is not set');
  }
  if (!env.CLOUDFLARE_AI_GATEWAY_SLUG) {
    throw new Error('CLAUDE_CONFIG_ERROR: CLOUDFLARE_AI_GATEWAY_SLUG is not set');
  }
  return `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY_SLUG}/anthropic/v1/messages`;
}

/**
 * Builds the headers for Anthropic requests via Cloudflare AI Gateway.
 *
 * Cloudflare AI Gateway error 2009 ("Unauthorized") is returned when:
 *   (a) the Anthropic API key is missing or malformed, or
 *   (b) "Authenticated Gateway" is enabled on the gateway but no `cf-aig-authorization`
 *       header is present.
 *
 * To cover both cases we:
 *   1. Fail loud if ANTHROPIC_API_KEY is empty (rather than silently sending an
 *      empty `x-api-key` header, which triggers 2009 at the gateway).
 *   2. Pass BOTH `x-api-key` and `Authorization: Bearer` — Cloudflare accepts either
 *      for Anthropic when forwarding through the provider endpoint.
 *   3. Optionally attach `cf-aig-authorization: Bearer <token>` when
 *      CLOUDFLARE_AI_GATEWAY_TOKEN is set (needed when Authenticated Gateway is on).
 */
function buildGatewayHeaders(env: Env): Record<string, string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'CLAUDE_CONFIG_ERROR: ANTHROPIC_API_KEY secret is not set on the Worker. ' +
        'Run `wrangler secret put ANTHROPIC_API_KEY` and paste the key from .env.local.'
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    Authorization: `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
  };

  const gatewayToken = (env as any).CLOUDFLARE_AI_GATEWAY_TOKEN as string | undefined;
  if (gatewayToken && gatewayToken.trim().length > 0) {
    headers['cf-aig-authorization'] = `Bearer ${gatewayToken}`;
  }

  return headers;
}

export async function callClaude(
  params: { system: string; user: string; max_tokens: number; orgId?: string },
  priority: 'high' | 'low',
  env: Env
): Promise<string> {
  const orgId = params.orgId || 'system';
  if (!(await checkClaudeRateLimit(env, orgId, priority))) {
    throw new Error('CLAUDE_RATE_LIMITED');
  }

  const response = await fetch(buildGatewayUrl(env), {
    method: 'POST',
    headers: buildGatewayHeaders(env),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: [{ role: 'user', content: params.user }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 429) throw new Error('CLAUDE_RATE_LIMITED');
    throw new Error(`Claude API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');
  return textBlock.text;
}

export async function callClaudeStreaming(
  params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    max_tokens: number;
  },
  env: Env
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(buildGatewayUrl(env), {
    method: 'POST',
    headers: buildGatewayHeaders(env),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: params.max_tokens,
      stream: true,
      system: params.system,
      messages: params.messages,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude streaming error ${response.status}: ${errorBody}`);
  }
  if (!response.body) throw new Error('Claude returned no response body');

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }
        try {
          const event = JSON.parse(jsonStr);
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta'
          ) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
            );
          } else if (event.type === 'message_stop') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
        } catch {
          // skip malformed
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        try {
          if (buffer.startsWith('data: ')) {
            const jsonStr = buffer.slice(6).trim();
            if (jsonStr !== '[DONE]') {
              const event = JSON.parse(jsonStr);
              if (
                event.type === 'content_block_delta' &&
                event.delta?.type === 'text_delta'
              ) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
                );
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });

  return response.body.pipeThrough(transformStream);
}

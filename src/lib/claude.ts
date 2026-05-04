import type { Env } from '../types/env';
import { checkClaudeRateLimit } from './rate-limit';
import { recordRateLimit } from './upstream-budget';

interface ClaudeResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: any }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

function buildGatewayUrl(env: Env): string {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLAUDE_CONFIG_ERROR: CLOUDFLARE_ACCOUNT_ID is not set');
  }
  if (!env.CLOUDFLARE_AI_GATEWAY_SLUG) {
    throw new Error('CLAUDE_CONFIG_ERROR: CLOUDFLARE_AI_GATEWAY_SLUG is not set');
  }
  return `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.CLOUDFLARE_AI_GATEWAY_SLUG}/anthropic/v1/messages`;
}

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
  params: { system: string; user: string; max_tokens: number; orgId?: string; model?: string },
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
      model: params.model || CLAUDE_MODEL,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: [{ role: 'user', content: params.user }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 429) {
      // Phase 3.3: feed the upstream_budget_ledger circuit breaker.
      // 3 consecutive 429s → cap drops 10%, circuit opens 30 min.
      // Pre-3.3 the KV-backed limiter could only observe its own
      // counter; the ledger gives us upstream-driven evidence.
      await recordRateLimit(env, orgId, null, 'claude', 'minute');
      throw new Error('CLAUDE_RATE_LIMITED');
    }
    throw new Error(`Claude API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');
  return textBlock.text!;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: any;
}

export type ToolExecutor = (name: string, input: any) => Promise<any>;

export async function callClaudeStreaming(
  params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: any }>;
    max_tokens: number;
    tools?: ToolDefinition[];
    onToolCall?: ToolExecutor;
    // Wave-1 cancellation: when this signal aborts, the streaming fetch is
    // interrupted and the run loop exits cleanly between iterations.
    signal?: AbortSignal;
  },
  env: Env
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const emit = (data: any) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  const emitDone = () => writer.write(encoder.encode('data: [DONE]\n\n'));

  const runLoop = async () => {
    const messages = [...params.messages];
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      // Cooperative cancellation between iterations: a Cmd+Backspace / stop
      // click that lands while the run loop is between fetches (e.g. while
      // a tool is executing) cleanly exits at this boundary.
      if (params.signal?.aborted) {
        console.log('[claude-stream] aborted by signal, exiting run loop');
        break;
      }
      iterations++;
      console.log(`[claude-stream] iteration ${iterations}/${maxIterations}, messages: ${messages.length}`);

      const body: any = {
        model: CLAUDE_MODEL,
        max_tokens: params.max_tokens,
        stream: true,
        system: params.system,
        messages,
      };
      if (params.tools?.length) body.tools = params.tools;

      let response: Response;
      try {
        response = await fetch(buildGatewayUrl(env), {
          method: 'POST',
          headers: buildGatewayHeaders(env),
          body: JSON.stringify(body),
          // AbortSignal threading: aborts the in-flight fetch + breaks the
          // SSE reader's next read with an error → caught by the outer try.
          signal: params.signal,
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError' || params.signal?.aborted) {
          console.log('[claude-stream] fetch aborted');
          break;
        }
        throw fetchErr;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[claude-stream] API error ${response.status}: ${errorBody.slice(0, 200)}`);
        await emit({ text: `\n\n[Error: Claude API ${response.status}]` });
        break;
      }
      if (!response.body) break;

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = '';
      let stopReason = '';
      let currentToolUseId = '';
      let currentToolName = '';
      let toolInputJson = '';
      const assistantContent: any[] = [];
      let currentTextBlock = '';
      let inToolUse = false;

      let aborted = false;
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (readErr: any) {
          // AbortSignal-triggered fetch closure surfaces as a read error.
          if (readErr?.name === 'AbortError' || params.signal?.aborted) {
            aborted = true;
            break;
          }
          throw readErr;
        }
        if (chunk.done) break;
        const value = chunk.value;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                if (currentTextBlock) {
                  assistantContent.push({ type: 'text', text: currentTextBlock });
                  currentTextBlock = '';
                }
                inToolUse = true;
                currentToolUseId = event.content_block.id;
                currentToolName = event.content_block.name;
                toolInputJson = '';
                await emit({ type: 'tool_call', tool: currentToolName, status: 'started' });
              } else if (event.content_block?.type === 'text') {
                inToolUse = false;
              }
            }

            if (event.type === 'content_block_delta') {
              if (inToolUse && event.delta?.type === 'input_json_delta') {
                toolInputJson += event.delta.partial_json || '';
              } else if (event.delta?.type === 'text_delta') {
                currentTextBlock += event.delta.text;
                await emit({ text: event.delta.text });
              }
            }

            if (event.type === 'content_block_stop' && inToolUse) {
              let toolInput: any = {};
              try { toolInput = JSON.parse(toolInputJson); } catch { /* empty input */ }

              assistantContent.push({
                type: 'tool_use',
                id: currentToolUseId,
                name: currentToolName,
                input: toolInput,
              });
              inToolUse = false;
            }

            if (event.type === 'message_delta') {
              stopReason = event.delta?.stop_reason || '';
            }

            if (event.type === 'message_stop') {
              if (!stopReason) stopReason = 'end_turn';
            }
          } catch {
            // skip malformed
          }
        }
      }

      if (currentTextBlock) {
        assistantContent.push({ type: 'text', text: currentTextBlock });
      }

      // If the SSE reader bailed because of an abort, exit the run loop
      // before pushing more messages or kicking off another iteration.
      if (aborted) break;

      if (stopReason === 'tool_use' && params.onToolCall) {
        messages.push({ role: 'assistant', content: assistantContent });

        const toolResults: any[] = [];
        for (const block of assistantContent) {
          if (block.type !== 'tool_use') continue;
          // Cooperative abort between tool calls — a cancel mid-tool-batch
          // skips remaining tools and exits the run loop on the next
          // iteration check above.
          if (params.signal?.aborted) break;

          await emit({ type: 'tool_call', tool: block.name, input: block.input, status: 'executing' });

          try {
            const result = await params.onToolCall(block.name, block.input);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

            await emit({ type: 'tool_result', tool: block.name, result, status: 'done' });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultStr,
            });
          } catch (e: any) {
            const errorResult = JSON.stringify({ error: e.message });
            await emit({ type: 'tool_result', tool: block.name, result: { error: e.message }, status: 'error' });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: errorResult,
              is_error: true,
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      break;
    }

    console.log(`[claude-stream] completed after ${iterations} iteration(s)`);
    await emitDone();
    await writer.close();
  };

  runLoop().catch(async (e) => {
    console.error(`[claude-stream] runLoop fatal error:`, e.message);
    try {
      await emit({ text: `\n\n[Error: ${e.message}]` });
      await emitDone();
      await writer.close();
    } catch { /* writer may be closed */ }
  });

  return readable;
}

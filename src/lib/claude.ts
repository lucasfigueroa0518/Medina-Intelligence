import type { Env } from '../types/env';
import { checkClaudeRateLimit } from './rate-limit';

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
    if (response.status === 429) throw new Error('CLAUDE_RATE_LIMITED');
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

      const response = await fetch(buildGatewayUrl(env), {
        method: 'POST',
        headers: buildGatewayHeaders(env),
        body: JSON.stringify(body),
      });

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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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

      if (stopReason === 'tool_use' && params.onToolCall) {
        messages.push({ role: 'assistant', content: assistantContent });

        const toolResults: any[] = [];
        for (const block of assistantContent) {
          if (block.type !== 'tool_use') continue;

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

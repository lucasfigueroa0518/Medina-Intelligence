import type { Env } from '../types/env';
import { checkClaudeRateLimit } from './rate-limit';
import { recordBudgetSuccess, recordRateLimit } from './upstream-budget';
import { NORMAL_MODE_LIMITS } from './max-mode';
import {
  budgetUpstreamForClaudeModel,
  CLAUDE_HAIKU_MODEL,
  resolveDefaultClaudeModel,
} from './model-policy';

interface ClaudeResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: any }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
}

const ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_MODEL = CLAUDE_HAIKU_MODEL;
const MODEL_TOOL_RESULT_JSON_LIMIT = 80_000;
const MODEL_TOOL_RESULT_ARRAY_LIMIT = 40;
const MODEL_TOOL_RESULT_STRING_LIMIT = 2_400;
const MODEL_RETRY_USER_TEXT_LIMIT = 65_000;

function isMaxTokenRejection(status: number, body: string): boolean {
  return status === 400 && /max_tokens|maximum.*tokens|tokens.*maximum|output.*tokens/i.test(body);
}

function isRecoverableProviderRejection(status: number, body: string): boolean {
  return (status === 400 || status === 413)
    && /prompt|token|tokens|too\s+long|exceed|maximum|messages?|content|tool_result|input/i.test(body);
}

function compactForModel(value: any, depth = 0): any {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MODEL_TOOL_RESULT_STRING_LIMIT
      ? `${value.slice(0, MODEL_TOOL_RESULT_STRING_LIMIT)}\n...[truncated ${value.length - MODEL_TOOL_RESULT_STRING_LIMIT} chars]`
      : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, MODEL_TOOL_RESULT_ARRAY_LIMIT).map(item => compactForModel(item, depth + 1));
    if (value.length > MODEL_TOOL_RESULT_ARRAY_LIMIT) {
      sliced.push({ omitted_count: value.length - MODEL_TOOL_RESULT_ARRAY_LIMIT });
    }
    return sliced;
  }
  if (depth > 6) return '[nested object truncated]';

  const out: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(raw|html|base64|binary|embedding|vector|blob|buffer)$/i.test(key)) {
      out[key] = '[omitted from model context]';
      continue;
    }
    out[key] = compactForModel(entry, depth + 1);
  }
  return out;
}

function stringifyToolResultForModel(toolName: string, result: any): string {
  const compact = compactForModel(result);
  const json = typeof compact === 'string' ? compact : JSON.stringify(compact);
  if (json.length <= MODEL_TOOL_RESULT_JSON_LIMIT) return json;
  return JSON.stringify({
    tool: toolName,
    truncated_for_model_context: true,
    original_chars: json.length,
    retained_chars: MODEL_TOOL_RESULT_JSON_LIMIT,
    note: 'The full tool result was streamed to the UI; this compact copy is for Claude synthesis only.',
    preview: json.slice(0, MODEL_TOOL_RESULT_JSON_LIMIT),
  });
}

function compactMessageContentForRetry(content: any): any {
  if (typeof content === 'string') {
    return content.length > MODEL_RETRY_USER_TEXT_LIMIT
      ? `${content.slice(0, MODEL_RETRY_USER_TEXT_LIMIT)}\n...[context truncated for provider retry]`
      : content;
  }
  if (!Array.isArray(content)) return compactForModel(content);
  return content.map(block => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'text' && typeof block.text === 'string') {
      return {
        ...block,
        text: block.text.length > MODEL_RETRY_USER_TEXT_LIMIT
          ? `${block.text.slice(0, MODEL_RETRY_USER_TEXT_LIMIT)}\n...[context truncated for provider retry]`
          : block.text,
      };
    }
    if (block.type === 'tool_result' && typeof block.content === 'string') {
      return {
        ...block,
        content: block.content.length > MODEL_TOOL_RESULT_JSON_LIMIT
          ? `${block.content.slice(0, MODEL_TOOL_RESULT_JSON_LIMIT)}\n...[tool result truncated for provider retry]`
          : block.content,
      };
    }
    return compactForModel(block);
  });
}

function compactMessagesForProviderRetry(
  messages: Array<{ role: 'user' | 'assistant'; content: any }>
): Array<{ role: 'user' | 'assistant'; content: any }> {
  return messages.map(message => ({
    role: message.role,
    content: compactMessageContentForRetry(message.content),
  }));
}

export const __claudeTestHooks = {
  compactForModel,
  stringifyToolResultForModel,
  compactMessagesForProviderRetry,
  isRecoverableProviderRejection,
};

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

export interface ClaudeCallResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export type ClaudeSystemPrompt =
  | string
  | Array<{
      type: 'text';
      text: string;
      cache_control?: { type: 'ephemeral' };
    }>;

export async function callClaudeWithUsage(
  params: {
    system: ClaudeSystemPrompt;
    user: string;
    max_tokens: number;
    orgId?: string;
    model?: string;
    assistantPrefill?: string;
  },
  priority: 'high' | 'low',
  env: Env
): Promise<ClaudeCallResult> {
  const orgId = params.orgId || 'system';
  const model = params.model || resolveDefaultClaudeModel();
  const budgetSource = budgetUpstreamForClaudeModel(model);
  if (!(await checkClaudeRateLimit(env, orgId, priority, budgetSource))) {
    throw new Error('CLAUDE_RATE_LIMITED');
  }
  const model = params.model || CLAUDE_MODEL;

  const response = await fetch(buildGatewayUrl(env), {
    method: 'POST',
    headers: buildGatewayHeaders(env),
    body: JSON.stringify({
      model,
      max_tokens: params.max_tokens,
      system: params.system,
      messages: params.assistantPrefill
        ? [
            { role: 'user', content: params.user },
            { role: 'assistant', content: params.assistantPrefill },
          ]
        : [{ role: 'user', content: params.user }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 429) {
      // Phase 3.3: feed the upstream_budget_ledger circuit breaker.
      // 3 consecutive 429s → cap drops 10%, circuit opens 30 min.
      // Pre-3.3 the KV-backed limiter could only observe its own
      // counter; the ledger gives us upstream-driven evidence.
      await recordRateLimit(env, orgId, null, budgetSource, 'minute');
      throw new Error('CLAUDE_RATE_LIMITED');
    }
    throw new Error(`Claude API error ${response.status}: ${errorBody}`);
  }
  await recordBudgetSuccess(env, orgId, null, budgetSource, 'minute');

  const data = (await response.json()) as ClaudeResponse;
  const textBlock = data.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');
  const text = params.assistantPrefill ? `${params.assistantPrefill}${textBlock.text!}` : textBlock.text!;
  return { text, usage: data.usage, model };
}

export async function callClaude(
  params: { system: ClaudeSystemPrompt; user: string; max_tokens: number; orgId?: string; model?: string },
  priority: 'high' | 'low',
  env: Env
): Promise<string> {
  const result = await callClaudeWithUsage(params, priority, env);
  return result.text;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: any;
}

export type ToolExecutor = (name: string, input: any) => Promise<any>;
export type ToolResultTransformer = (
  name: string,
  result: any
) => Promise<{ result: any; events?: any[] }> | { result: any; events?: any[] };

function abortError(): Error {
  const err = new Error('MARTy request cancelled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export async function callClaudeStreaming(
  params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: any }>;
    max_tokens: number;
    model?: string;
    orgId?: string;
    priority?: 'high' | 'low';
    fallbackMaxTokens?: number;
    maxIterations?: number;
    tools?: ToolDefinition[];
    onToolCall?: ToolExecutor;
    onToolResult?: ToolResultTransformer;
    preludeEvents?: any[];
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
    let messages = [...params.messages];
    let iterations = 0;
    const maxIterations = params.maxIterations ?? NORMAL_MODE_LIMITS.toolIterations;
    let activeMaxTokens = params.max_tokens;
    const orgId = params.orgId || 'system';
    const priority = params.priority || 'high';
    const model = params.model || resolveDefaultClaudeModel();
    const budgetSource = budgetUpstreamForClaudeModel(model);
    let usedMaxTokenFallback = false;
    let usedProviderContextFallback = false;
    if (params.preludeEvents?.length) {
      for (const event of params.preludeEvents) {
        await emit(event);
      }
    }

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

      const buildBody = (maxTokens: number): any => ({
        model,
        max_tokens: maxTokens,
        stream: true,
        system: params.system,
        messages,
      });
      const body = buildBody(activeMaxTokens);
      if (params.tools?.length) body.tools = params.tools;

      let response: Response;
      try {
        if (!(await checkClaudeRateLimit(env, orgId, priority, budgetSource))) {
          await emit({
            type: 'model_error',
            provider: 'claude',
            status: 429,
            retryable: true,
          });
          await emit({
            text: '\n\nMARTy hit a model budget limit. Retry is safe.',
          });
          break;
        }
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

      let finalErrorBody: string | null = null;
      if (!response.ok) {
        finalErrorBody = await response.text();
        if (response.status === 429) {
          await recordRateLimit(env, orgId, null, budgetSource, 'minute');
        }
        if (
          params.fallbackMaxTokens &&
          !usedMaxTokenFallback &&
          isMaxTokenRejection(response.status, finalErrorBody)
        ) {
          usedMaxTokenFallback = true;
          activeMaxTokens = params.fallbackMaxTokens;
          await emit({
            type: 'model_fallback',
            reason: 'max_tokens_rejected',
            requested_max_tokens: params.max_tokens,
            fallback_max_tokens: params.fallbackMaxTokens,
          });
          const fallbackBody = buildBody(activeMaxTokens);
          if (params.tools?.length) fallbackBody.tools = params.tools;
          try {
            if (!(await checkClaudeRateLimit(env, orgId, priority, budgetSource))) {
              await emit({
                type: 'model_error',
                provider: 'claude',
                status: 429,
                retryable: true,
              });
              await emit({
                text: '\n\nMARTy hit a model budget limit. Retry is safe.',
              });
              break;
            }
            response = await fetch(buildGatewayUrl(env), {
              method: 'POST',
              headers: buildGatewayHeaders(env),
              body: JSON.stringify(fallbackBody),
              signal: params.signal,
            });
            if (!response.ok) {
              finalErrorBody = await response.text();
              if (response.status === 429) {
                await recordRateLimit(env, orgId, null, budgetSource, 'minute');
              }
            } else {
              finalErrorBody = null;
            }
          } catch (fetchErr: any) {
            if (fetchErr?.name === 'AbortError' || params.signal?.aborted) {
              console.log('[claude-stream] fallback fetch aborted');
              break;
            }
            throw fetchErr;
          }
        }
      }

      if (!response.ok) {
        const errorBody = finalErrorBody ?? await response.text();
        console.error(`[claude-stream] API error ${response.status}: ${errorBody.slice(0, 1000)}`);
        if (!usedProviderContextFallback && isRecoverableProviderRejection(response.status, errorBody)) {
          usedProviderContextFallback = true;
          activeMaxTokens = Math.min(activeMaxTokens, params.fallbackMaxTokens || 4096);
          messages = compactMessagesForProviderRetry(messages);
          await emit({
            type: 'model_fallback',
            reason: 'provider_rejected_context_compacted',
            status: response.status,
            fallback_max_tokens: activeMaxTokens,
          });
          continue;
        }
        await emit({
          type: 'model_error',
          provider: 'claude',
          status: response.status,
          retryable: true,
        });
        await emit({
          text: '\n\nMARTy hit a model handoff issue. Retry is safe.',
        });
        break;
      }
      await recordBudgetSuccess(env, orgId, null, budgetSource, 'minute');
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
            throwIfAborted(params.signal);
            const rawResult = await abortable(params.onToolCall(block.name, block.input), params.signal);
            throwIfAborted(params.signal);
            const transformed = params.onToolResult
              ? await params.onToolResult(block.name, rawResult)
              : { result: rawResult };
            const result = transformed.result;
            const resultStr = stringifyToolResultForModel(block.name, result);

            if (result && typeof result === 'object' && Array.isArray((result as any).document_cards)) {
              await emit({ type: 'document_cards', document_cards: (result as any).document_cards });
            }
            for (const event of transformed.events || []) {
              await emit(event);
            }
            await emit({ type: 'tool_result', tool: block.name, result, status: 'done' });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultStr,
            });
          } catch (e: any) {
            if (e?.name === 'AbortError' || params.signal?.aborted) {
              console.log('[claude-stream] tool execution aborted');
              break;
            }
            const errorResult = JSON.stringify({
              error: 'TOOL_EXECUTION_FAILED',
              message: 'The tool failed before returning a safe result. Report this as an incomplete tool run; do not fabricate the missing data.',
            });
            await emit({
              type: 'tool_result',
              tool: block.name,
              result: { error: 'TOOL_EXECUTION_FAILED', retryable: true },
              status: 'error',
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: errorResult,
              is_error: true,
            });
          }
        }

        if (params.signal?.aborted) break;
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
      await emit({ type: 'model_error', retryable: true });
      await emit({ text: '\n\nMARTy hit a model handoff issue. Retry is safe.' });
      await emitDone();
      await writer.close();
    } catch { /* writer may be closed */ }
  });

  return readable;
}

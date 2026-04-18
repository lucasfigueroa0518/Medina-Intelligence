// TRD §5.1, §9 — God Mode agent endpoints
import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { preprocessQuery, retrieveContext, assembleContext, TOKEN_BUDGET } from '../lib/retrieval';
import { callClaude, callClaudeStreaming } from '../lib/claude';
import { extractTextFromFile } from '../lib/file-extraction';
import { GOD_MODE_SYSTEM_PROMPT } from '../prompts/god-mode';
import { SESSION_TITLE_PROMPT } from '../prompts/session-title';
import { estimateTokens, truncateToTokens } from '../lib/tokens';
import { emitAudit } from '../lib/audit';

export async function listSessions(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const rows = await env.D1.prepare(
    `SELECT * FROM agent_sessions WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
     ORDER BY last_activity_at DESC LIMIT 100`
  ).bind(ctx.orgId, ctx.userId).all();
  return jsonResponse({ sessions: rows.results });
}

export async function getSessionMessages(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const session = await env.D1.prepare(
    'SELECT * FROM agent_sessions WHERE id = ? AND org_id = ? AND user_id = ?'
  ).bind(id, ctx.orgId, ctx.userId).first();
  if (!session) return errorResponse('SESSION_NOT_FOUND', 404);

  const messages = await env.D1.prepare(
    'SELECT * FROM agent_messages WHERE session_id = ? ORDER BY turn_index ASC'
  ).bind(id).all();
  return jsonResponse({ session, messages: messages.results });
}

export async function deleteSession(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    `UPDATE agent_sessions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND org_id = ? AND user_id = ?`
  ).bind(id, ctx.orgId, ctx.userId).run();
  return jsonResponse({ ok: true });
}

export async function getSessionTrace(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const logs = await env.D1.prepare(
    `SELECT * FROM rag_query_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(id).all();
  return jsonResponse({ logs: logs.results });
}

// --- God Mode query (streaming SSE) ---

export async function queryAgent(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const contentType = request.headers.get('Content-Type') || '';

  let query: string;
  let sessionId: string | null;
  let contextEntityType: string | null = null;
  let contextEntityId: string | null = null;
  let uploadedText: string | undefined;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    query = (form.get('query') as string) || '';
    sessionId = (form.get('session_id') as string) || null;
    contextEntityType = (form.get('context_entity_type') as string) || null;
    contextEntityId = (form.get('context_entity_id') as string) || null;
    const file = form.get('file') as File | null;
    if (file && file.size > 0) {
      uploadedText = await extractTextFromFile(file);
    }
  } else {
    const body = await parseJsonBody<any>(request);
    if (!body?.query) return errorResponse('VALIDATION_ERROR', 400);
    query = body.query;
    sessionId = body.session_id || null;
    contextEntityType = body.context_entity_type || null;
    contextEntityId = body.context_entity_id || null;
  }

  if (!query) return errorResponse('VALIDATION_ERROR', 400);

  // --- Load or create session ---
  let session: AgentSession;
  if (sessionId) {
    const existing = await env.D1.prepare(
      'SELECT * FROM agent_sessions WHERE id = ? AND org_id = ? AND user_id = ?'
    ).bind(sessionId, ctx.orgId, ctx.userId).first<any>();
    if (!existing) return errorResponse('SESSION_NOT_FOUND', 404);
    session = existing;
  } else {
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.D1.prepare(
      `INSERT INTO agent_sessions (id, org_id, user_id, context_entity_type, context_entity_id, turn_count, last_activity_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(newId, ctx.orgId, ctx.userId, contextEntityType, contextEntityId, now, now)
      .run();
    session = {
      id: newId,
      org_id: ctx.orgId,
      user_id: ctx.userId,
      context_entity_type: contextEntityType,
      context_entity_id: contextEntityId,
      turn_count: 0,
      user_role: ctx.userRole,
      last_activity_at: now,
      created_at: now,
    };
  }
  session.user_role = ctx.userRole;

  // --- Pre-process query ---
  const t0 = Date.now();
  const pq = await preprocessQuery(query, session, env);

  // Apply session entity scoping
  if (session.context_entity_id && !pq.entityIds.includes(session.context_entity_id)) {
    pq.entityIds.push(session.context_entity_id);
  }

  const { internal, news } = await retrieveContext(pq, env);
  const tRetrieve = Date.now() - t0;

  // --- Load session history ---
  const historyMsgs = await env.D1.prepare(
    'SELECT role, content, turn_index FROM agent_messages WHERE session_id = ? ORDER BY turn_index DESC LIMIT 20'
  ).bind(session.id).all<{ role: string; content: string; turn_index: number }>();

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let historyTokens = 0;
  for (const m of historyMsgs.results.reverse()) {
    const t = estimateTokens(m.content);
    if (historyTokens + t > TOKEN_BUDGET.session_history) break;
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    historyTokens += t;
  }

  // --- Assemble context ---
  const contextBlock = assembleContext(internal, news, uploadedText);
  const userMessage = `${contextBlock}\n\n--- QUERY ---\n${query}`;
  messages.push({ role: 'user', content: userMessage });

  // --- Save user turn ---
  const turnIndex = session.turn_count;
  const userMessageId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO agent_messages (id, session_id, turn_index, role, content, created_at)
     VALUES (?, ?, ?, 'user', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(userMessageId, session.id, turnIndex, query).run();

  // --- Stream Claude response ---
  const stream = await callClaudeStreaming(
    {
      system: GOD_MODE_SYSTEM_PROMPT,
      messages,
      max_tokens: 4000,
    },
    env
  );

  // Tee stream so we can save the full assistant response
  const [clientStream, captureStream] = stream.tee();

  ctxExec.waitUntil(
    (async () => {
      const reader = captureStream.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const evt = JSON.parse(jsonStr);
            if (evt.text) fullText += evt.text;
          } catch {
            /* skip */
          }
        }
      }

      // Save assistant turn
      const assistantMessageId = crypto.randomUUID();
      await env.D1.prepare(
        `INSERT INTO agent_messages (id, session_id, turn_index, role, content, created_at)
         VALUES (?, ?, ?, 'assistant', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(assistantMessageId, session.id, turnIndex + 1, fullText).run();

      // Update session
      await env.D1.prepare(
        `UPDATE agent_sessions SET turn_count = turn_count + 2, last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(session.id).run();

      // Auto-generate title on first turn
      if (session.turn_count === 0 && !session.title) {
        try {
          const title = await callClaude(
            {
              system: SESSION_TITLE_PROMPT,
              user: query,
              max_tokens: 20,
              orgId: ctx.orgId,
            },
            'low',
            env
          );
          await env.D1.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
            .bind(title.trim().slice(0, 80), session.id)
            .run();
        } catch {
          /* ignore title generation failures */
        }
      }

      // Persist RAG trace
      const traceKey = `${ctx.orgId}/rag_traces/${new Date().toISOString().slice(0, 7)}/${session.id}_${turnIndex}.txt`;
      try {
        await env.R2.put(traceKey, contextBlock);
      } catch {
        /* ignore */
      }

      // Log to rag_query_logs
      try {
        await env.D1.prepare(
          `INSERT INTO rag_query_logs
             (id, org_id, user_id, session_id, turn_index, original_query, processed_query,
              vectorize_internal_match_count, vectorize_news_match_count, post_filter_count,
              context_r2_key, latency_retrieval_ms, latency_total_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        )
          .bind(
            crypto.randomUUID(),
            ctx.orgId,
            ctx.userId,
            session.id,
            turnIndex,
            query,
            JSON.stringify({ entity_ids: pq.entityIds }),
            internal.length,
            news.length,
            internal.length,
            traceKey,
            tRetrieve,
            Date.now() - t0
          )
          .run();
      } catch {
        /* ignore */
      }
    })()
  );

  return new Response(clientStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

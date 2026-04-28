import type { Env } from '../types/env';
import type { AgentSession, AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { preprocessQuery, retrieveContext, assembleContext, TOKEN_BUDGET, type RetrievalOptions } from '../lib/retrieval';
import { callClaude, callClaudeStreaming } from '../lib/claude';
import type { ToolDefinition } from '../lib/claude';
import { extractTextFromFile } from '../lib/file-extraction';
import { GOD_MODE_SYSTEM_PROMPT } from '../prompts/god-mode';
import { SESSION_TITLE_PROMPT } from '../prompts/session-title';
import { estimateTokens, truncateToTokens } from '../lib/tokens';
import { emitAudit } from '../lib/audit';
import {
  searchContacts, searchCompanies, searchDeals, searchConversations,
  getContactDetail, getCompanyDetail, getDealDetail,
  createContactTool, updateContactTool,
  createCompanyTool, updateCompanyTool,
  createDealTool, updateDealTool,
  addNoteTool, addDealActionItemTool,
  applyTagTool, deleteEntityTool,
} from '../lib/agent-tools';
import { webSearch, readUrl } from '../lib/agent-web-search';

// ---------------------------------------------------------------------------
// Tool definitions for Claude
// ---------------------------------------------------------------------------

const AGENT_TOOLS: ToolDefinition[] = [
  // READ TOOLS
  {
    name: 'search_contacts',
    description: 'Search contacts by keyword, filter by type or follow-up status. Use when asked about contacts broadly.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by name, email, or company name' },
        contact_type: { type: 'string', enum: ['individual', 'family', 'institutional_investor', 'company'] },
        has_followup_overdue: { type: 'boolean', description: 'Only show contacts with overdue follow-ups' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'search_companies',
    description: 'Search companies by keyword, type, or sector. Use when asked about companies broadly.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by name, domain, or description' },
        company_type: { type: 'string' },
        sector: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'search_deals',
    description: 'Search deals by keyword, stage, or company. Use when asked about the pipeline or deals broadly.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by title or company name' },
        stage: { type: 'string', description: 'Filter by stage: prospect, initial_contact, due_diligence, term_sheet, negotiation, closed_won, closed_lost, on_hold' },
        company_id: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'search_conversations',
    description: 'Search emails, Slack messages, and meeting transcripts stored in the CRM. Use this when the user asks about recent communications, email threads, Slack discussions, or wants to know what was discussed.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search by subject, body content, or participant name' },
        source: { type: 'string', enum: ['outlook', 'slack', 'firefly', 'all'], description: 'Filter by communication channel. Default: all' },
        contact_id: { type: 'string', description: 'Filter conversations involving a specific contact' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'all'], description: 'Filter by direction. Default: all' },
        days_back: { type: 'number', description: 'How many days back to search. Default: 30' },
        limit: { type: 'number', description: 'Max results. Default: 20' },
      },
    },
  },
  {
    name: 'get_contact_detail',
    description: 'Get full details for a specific contact including their conversations, deals, tags, and associations. Use when asked about a specific person.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact UUID' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_company_detail',
    description: 'Get full details for a specific company including contacts, deals, tags, and news.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
      },
      required: ['company_id'],
    },
  },
  {
    name: 'get_deal_detail',
    description: 'Get full details for a specific deal including contacts, action items, and notes.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
      },
      required: ['deal_id'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information about people, companies, markets, news, or any topic. Use when internal data is insufficient or when asked about external/current events.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        num_results: { type: 'number', description: 'Number of source links to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_url',
    description: 'Fetch and read the text content from a specific URL. Use to read articles, press releases, or web pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
  // WRITE TOOLS
  {
    name: 'create_contact',
    description: 'Create a new contact in the CRM. Use when asked to add a person.',
    input_schema: {
      type: 'object',
      properties: {
        full_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        contact_type: { type: 'string', enum: ['individual', 'family', 'institutional_investor', 'company'] },
        company_name: { type: 'string', description: 'Will link to existing company or create a new one' },
        job_title: { type: 'string' },
        linkedin_url: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['full_name'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update fields on an existing contact.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Key-value pairs of fields to update (full_name, email, phone, job_title, linkedin_url, bio_summary, contact_type, relationship_status, engagement_status, next_followup_date, location, etc.)',
        },
      },
      required: ['contact_id', 'fields'],
    },
  },
  {
    name: 'create_company',
    description: 'Create a new company in the CRM.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        domain: { type: 'string' },
        website: { type: 'string' },
        sector: { type: 'string' },
        company_type: { type: 'string' },
        location: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_company',
    description: 'Update fields on an existing company.',
    input_schema: {
      type: 'object',
      properties: {
        company_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Key-value pairs of fields to update',
        },
      },
      required: ['company_id', 'fields'],
    },
  },
  {
    name: 'create_deal',
    description: 'Create a new deal in the pipeline. Requires a company.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        company_name: { type: 'string', description: 'Name of an existing company' },
        company_id: { type: 'string', description: 'Or provide company ID directly' },
        stage: { type: 'string', description: 'prospect, initial_contact, due_diligence, term_sheet, negotiation, closed_won, closed_lost, on_hold' },
        amount: { type: 'number' },
        valuation: { type: 'number' },
        description: { type: 'string' },
        expected_close: { type: 'string', description: 'ISO 8601 date' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_deal',
    description: 'Update fields on an existing deal. Can change stage, amount, notes, etc.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Key-value pairs (title, stage, amount, valuation, probability, expected_close, notes, etc.)',
        },
      },
      required: ['deal_id', 'fields'],
    },
  },
  {
    name: 'add_note',
    description: 'Add a note to a contact or deal.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'deal'] },
        entity_id: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'content'],
    },
  },
  {
    name: 'add_deal_action_item',
    description: 'Add an action item / to-do to a deal.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string' },
        description: { type: 'string' },
        assignee_id: { type: 'string', description: 'Optional user ID to assign' },
        due_date: { type: 'string', description: 'Optional ISO 8601 date' },
      },
      required: ['deal_id', 'description'],
    },
  },
  {
    name: 'apply_tag',
    description: 'Apply a tag to a contact or company. Creates the tag if it does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company'] },
        entity_id: { type: 'string' },
        tag_name: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'tag_name'],
    },
  },
  {
    name: 'delete_entity',
    description: 'Delete a contact, company, or deal. Will ask for confirmation before proceeding.',
    input_schema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['contact', 'company', 'deal'] },
        entity_id: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Set to true to confirm deletion' },
      },
      required: ['entity_type', 'entity_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(
  toolName: string,
  toolInput: any,
  orgId: string,
  userId: string,
  env: Env
): Promise<any> {
  switch (toolName) {
    case 'search_contacts': return searchContacts(orgId, toolInput, env);
    case 'search_companies': return searchCompanies(orgId, toolInput, env);
    case 'search_deals': return searchDeals(orgId, toolInput, env);
    case 'search_conversations': return searchConversations(orgId, toolInput, env);
    case 'get_contact_detail': return getContactDetail(orgId, toolInput.contact_id, env);
    case 'get_company_detail': return getCompanyDetail(orgId, toolInput.company_id, env);
    case 'get_deal_detail': return getDealDetail(orgId, toolInput.deal_id, env);
    case 'web_search': return webSearch(toolInput.query, toolInput.num_results, env);
    case 'read_url': return readUrl(toolInput.url);
    case 'create_contact': return createContactTool(orgId, userId, toolInput, env);
    case 'update_contact': return updateContactTool(orgId, userId, toolInput, env);
    case 'create_company': return createCompanyTool(orgId, userId, toolInput, env);
    case 'update_company': return updateCompanyTool(orgId, userId, toolInput, env);
    case 'create_deal': return createDealTool(orgId, userId, toolInput, env);
    case 'update_deal': return updateDealTool(orgId, userId, toolInput, env);
    case 'add_note': return addNoteTool(orgId, userId, toolInput, env);
    case 'add_deal_action_item': return addDealActionItemTool(orgId, userId, toolInput, env);
    case 'apply_tag': return applyTagTool(orgId, toolInput, env);
    case 'delete_entity': return deleteEntityTool(orgId, userId, toolInput, env);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Session endpoints (unchanged)
// ---------------------------------------------------------------------------

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
  const session = await env.D1.prepare(
    'SELECT id FROM agent_sessions WHERE id = ? AND org_id = ? AND user_id = ?'
  ).bind(id, ctx.orgId, ctx.userId).first();
  if (!session) return errorResponse('SESSION_NOT_FOUND', 404);

  await env.D1.batch([
    env.D1.prepare('DELETE FROM agent_messages WHERE session_id = ?').bind(id),
    env.D1.prepare('DELETE FROM rag_query_logs WHERE session_id = ?').bind(id),
    env.D1.prepare('DELETE FROM agent_sessions WHERE id = ?').bind(id),
  ]);
  return jsonResponse({ ok: true });
}

export async function updateSessionTitle(
  request: Request,
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ title: string }>(request);
  if (!body?.title) return errorResponse('VALIDATION_ERROR', 400, 'title required');

  await env.D1.prepare(
    'UPDATE agent_sessions SET title = ? WHERE id = ? AND org_id = ? AND user_id = ?'
  ).bind(body.title.trim().slice(0, 80), id, ctx.orgId, ctx.userId).run();
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

// ---------------------------------------------------------------------------
// God Mode query (streaming SSE with tool use)
// ---------------------------------------------------------------------------

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
  let deepDive = false;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    query = (form.get('query') as string) || '';
    sessionId = (form.get('session_id') as string) || null;
    contextEntityType = (form.get('context_entity_type') as string) || null;
    contextEntityId = (form.get('context_entity_id') as string) || null;
    deepDive = (form.get('deep_dive') as string) === 'true';
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
    deepDive = !!body.deep_dive;
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

  // --- Deep Dive rate limiting ---
  const retrievalOptions: RetrievalOptions = { deepDive };
  if (deepDive) {
    const ddKey = `deep_dive:${ctx.userId}:${new Date().toISOString().slice(0, 13)}`;
    const ddCount = parseInt(await env.KV.get(ddKey) || '0');
    if (ddCount >= 10) {
      return errorResponse('Deep dive limit reached — try again next hour. Normal queries are still available.', 429);
    }
    await env.KV.put(ddKey, String(ddCount + 1), { expirationTtl: 7200 });
  }

  // --- Pre-process query & retrieve RAG context ---
  const t0 = Date.now();
  const pq = await preprocessQuery(query, session, env, retrievalOptions);

  if (session.context_entity_id && !pq.entityIds.includes(session.context_entity_id)) {
    pq.entityIds.push(session.context_entity_id);
  }

  const { internal, news, stats } = await retrieveContext(pq, env, retrievalOptions);
  const tRetrieve = Date.now() - t0;

  // --- Load session history ---
  // Fetch recent turns. We guarantee the last 3 complete exchanges (6 messages)
  // are always included so MARTy can resolve pronouns and references, then
  // fill remaining token budget with older context.
  const MIN_RECENT_MESSAGES = 6;
  const historyMsgs = await env.D1.prepare(
    'SELECT role, content, turn_index FROM agent_messages WHERE session_id = ? ORDER BY turn_index DESC LIMIT 20'
  ).bind(session.id).all<{ role: string; content: string; turn_index: number }>();

  const allHistory = historyMsgs.results.reverse();
  const recentCount = Math.min(MIN_RECENT_MESSAGES, allHistory.length);
  const olderMessages = allHistory.slice(0, allHistory.length - recentCount);
  const recentMessages = allHistory.slice(allHistory.length - recentCount);

  let recentTokens = 0;
  for (const m of recentMessages) recentTokens += estimateTokens(m.content);

  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  let historyTokens = 0;
  const olderBudget = TOKEN_BUDGET.session_history - recentTokens;
  for (const m of olderMessages) {
    const t = estimateTokens(m.content);
    if (historyTokens + t > olderBudget) break;
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    historyTokens += t;
  }
  for (const m of recentMessages) {
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
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

  // --- Stream Claude response with tool use ---
  const orgId = ctx.orgId;
  const userId = ctx.userId;

  let systemPrompt = GOD_MODE_SYSTEM_PROMPT;
  if (deepDive && stats) {
    systemPrompt += `\n\nYou are in Deep Dive mode. Begin your response with a single brief line summarizing the scope, formatted as:\n🔍 Deep dive: Searched ${stats.emails} emails, ${stats.meetings} meetings, ${stats.documents} documents across ${stats.contacts} contacts.\nThen proceed with your thorough analysis. Be exhaustive — reference every relevant piece of evidence you find. Cite specific emails, meetings, and documents by name and date. Don't summarize — be thorough.`;
  }

  const stream = await callClaudeStreaming(
    {
      system: systemPrompt,
      messages,
      max_tokens: deepDive ? 8192 : 4096,
      tools: AGENT_TOOLS,
      onToolCall: (name, input) => executeTool(name, input, orgId, userId, env),
    },
    env
  );

  // Tee stream to capture full response
  const [rawClientStream, captureStream] = stream.tee();

  // Prepend a session event so the frontend knows the session ID
  const encoder = new TextEncoder();
  const sessionEvent = encoder.encode(
    `data: ${JSON.stringify({ type: 'session', session_id: session.id })}\n\n`
  );
  const clientStream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sessionEvent);
      const reader = rawClientStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch { /* stream closed by client */ }
      finally { controller.close(); }
    },
  });

  ctxExec.waitUntil(
    (async () => {
      const reader = captureStream.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      try {
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
            } catch { /* skip */ }
          }
        }
      } catch (streamErr) {
        console.error('[Agent] stream capture error:', streamErr);
      }

      // Save assistant turn (full or partial)
      if (fullText) {
        const assistantMessageId = crypto.randomUUID();
        await env.D1.prepare(
          `INSERT INTO agent_messages (id, session_id, turn_index, role, content, created_at)
           VALUES (?, ?, ?, 'assistant', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(assistantMessageId, session.id, turnIndex + 1, fullText).run();
      }

      // Update session
      await env.D1.prepare(
        `UPDATE agent_sessions SET turn_count = turn_count + 2, last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(session.id).run();

      // Auto-generate title on first turn
      if (session.turn_count === 0 && !session.title) {
        try {
          const title = await callClaude(
            { system: SESSION_TITLE_PROMPT, user: query, max_tokens: 20, orgId: ctx.orgId, model: 'claude-haiku-4-5-20251001' },
            'low',
            env
          );
          await env.D1.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
            .bind(title.trim().slice(0, 80), session.id)
            .run();
        } catch { /* ignore */ }
      }

      // Persist RAG trace
      const traceKey = `${ctx.orgId}/rag_traces/${new Date().toISOString().slice(0, 7)}/${session.id}_${turnIndex}.txt`;
      try { await env.R2.put(traceKey, contextBlock); } catch { /* ignore */ }

      // Log to rag_query_logs
      try {
        await env.D1.prepare(
          `INSERT INTO rag_query_logs
             (id, org_id, user_id, session_id, turn_index, original_query, processed_query,
              vectorize_internal_match_count, vectorize_news_match_count, post_filter_count,
              context_r2_key, latency_retrieval_ms, latency_total_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        ).bind(
          crypto.randomUUID(), ctx.orgId, ctx.userId, session.id, turnIndex,
          query, JSON.stringify({ entity_ids: pq.entityIds }),
          internal.length, news.length, internal.length,
          traceKey, tRetrieve, Date.now() - t0
        ).run();
      } catch { /* ignore */ }
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

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { appendAgentRunEvent, isAgentRunCancellationRequested, updateAgentRunStatus } from './agent-runs';
import { wasCancelledIncludingKV } from './agent-cancellation';
import {
  searchCompanies,
  searchContacts,
  searchDeals,
  searchEvents,
  sweepConversations,
} from './agent-tools';
import {
  createDocumentArtifactTool,
  findDocumentsTool,
  normalizeDocumentCards,
  type MartyDocumentCard,
} from './document-artifacts';
import { buildMaxSetTool, compactMaxSetResultForContext } from './max-set-builder';
import { enqueueWork, recordHeartbeat, type WorkQueueRow } from './work-queue';

export const MAX_MODE_WORK_QUEUE_DOMAIN = 'max_mode_job';

export type MaxTaskShape =
  | 'set_builder'
  | 'evidence_report'
  | 'sample_corpus'
  | 'count_aggregation'
  | 'artifact_synthesis'
  | 'mixed';

export type MaxSourceFamily =
  | 'conversations'
  | 'email'
  | 'slack'
  | 'meetings'
  | 'documents'
  | 'crm'
  | 'tasks'
  | 'artifacts';

export interface MaxExecutionPlan {
  task_shape: MaxTaskShape;
  source_families: MaxSourceFamily[];
  target_output: 'answer' | 'report' | 'sample_set' | 'count_table' | 'artifact';
  artifact: {
    required: boolean;
    kind: 'docx' | 'pdf' | 'xlsx';
    title: string;
  };
  privacy_policy: {
    raw_conversation_bodies: 'allowed_when_acl_permits';
    meeting_transcripts: 'chunks_only';
    generated_visibility: 'private';
  };
  phase_budgets: Record<string, { row_limit: number; body_limit?: number }>;
  requested_counts: {
    emails: number;
    slack: number;
    meetings: number;
    documents: number;
  };
  search_query: string;
  max_set_input?: any;
}

export interface MaxModeWorkPayload {
  job_id: string;
  org_id: string;
  user_id: string;
  session_id: string;
  assistant_message_id: string;
  request_id: string;
  agent_run_id: string;
  query: string;
  plan: MaxExecutionPlan;
  max_set_input?: any;
  runtime_fingerprint?: any;
}

interface MaxSetIntentLike {
  shouldBuild?: boolean;
  input?: any;
  reason?: string | null;
}

interface MaxModeJobRow {
  id: string;
  org_id: string;
  user_id: string | null;
  query: string;
  task_type: string;
  entity_kind: string;
  status: string;
  plan_json: string | null;
  progress_json: string | null;
  result_json: string | null;
  artifact_document_id: string | null;
  error_message: string | null;
  session_id: string | null;
  assistant_message_id: string | null;
  request_id: string | null;
  agent_run_id: string | null;
  cancel_requested_at: string | null;
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function includesAny(text: string, words: string[]): boolean {
  return words.some(word => text.includes(word));
}

function extractRequestedCount(query: string, family: 'email' | 'slack' | 'meeting', fallback: number): number {
  const nounPattern = family === 'email'
    ? '(?:emails?|messages?)'
    : family === 'slack'
      ? '(?:slack\\s+messages?|slacks?)'
      : '(?:meetings?|calls?|transcripts?)';
  const after = new RegExp(`(\\d+)\\s*(?:[-–]\\s*(\\d+))?\\s*${nounPattern}`, 'i').exec(query);
  if (after) return Math.min(Math.max(Number(after[2] || after[1]) || fallback, 1), family === 'email' ? 50 : 20);
  const before = new RegExp(`${nounPattern}\\s*(?:where|that|with|:)?[^\\d]{0,30}(\\d+)\\s*(?:[-–]\\s*(\\d+))?`, 'i').exec(query);
  if (before) return Math.min(Math.max(Number(before[2] || before[1]) || fallback, 1), family === 'email' ? 50 : 20);
  return fallback;
}

function titleFromQuery(query: string): string {
  const cleaned = query
    .replace(/\s+/g, ' ')
    .replace(/^(please|can you|could you|i need you to|i need to|i want you to)\s+/i, '')
    .trim();
  if (!cleaned) return 'MAX Evidence Report';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 90);
}

function deriveEvidenceSearchQuery(query: string): string {
  const q = query.toLowerCase();
  if (/\b(startups?|prospects?|opportunit(?:y|ies)|invest(?:ment)?|pitch(?:es)?|deal flow|intro(?:duction)?s?)\b/i.test(query)) {
    return 'startup prospect opportunity investment pitch intro founder deal company deck';
  }
  if (/\bcustomers?|sales|pipeline|renewal|churn|contract\b/i.test(query)) {
    return 'customer sales pipeline renewal contract opportunity';
  }
  const stripped = query
    .replace(/\b(please|compile|report|document|doc|pull|find|examples?|raw|data|emails?|slack|meetings?|transcripts?|messages?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (stripped || q).slice(0, 220);
}

function selectSourceFamilies(query: string, shape: MaxTaskShape, maxSetIntent?: MaxSetIntentLike): MaxSourceFamily[] {
  if (shape === 'set_builder') return ['conversations', 'email', 'slack', 'meetings', 'documents', 'crm'];
  const q = query.toLowerCase();
  const explicit: MaxSourceFamily[] = [];
  if (/\b(email|emails|outlook|inbox)\b/.test(q)) explicit.push('email');
  if (/\bslack\b/.test(q)) explicit.push('slack');
  if (/\b(meeting|meetings|transcript|transcripts|calls?|events?)\b/.test(q)) explicit.push('meetings');
  if (/\b(document|documents|docx|pdf|deck|file|files|artifact)\b/.test(q)) explicit.push('documents');
  if (/\b(crm|deals?|companies|contacts?|prospects?|portfolio|pipeline)\b/.test(q)) explicit.push('crm');
  if (/\b(tasks?|action items?|todos?)\b/.test(q)) explicit.push('tasks');
  if (explicit.length > 0) return [...new Set(explicit)];
  if (maxSetIntent?.shouldBuild) return ['conversations', 'meetings', 'documents', 'crm'];
  return ['email', 'slack', 'meetings', 'documents', 'crm'];
}

export function classifyMaxRequest(query: string, maxSetIntent?: MaxSetIntentLike): {
  task_shape: MaxTaskShape;
  should_run_durably: boolean;
  reason: string;
} {
  const q = query.toLowerCase();
  const reportWords = ['report', 'doc', 'document', 'compile', 'artifact', 'pdf', 'xlsx', 'export'];
  const sampleWords = ['examples', 'sample', 'corpus', 'training set', 'raw data', 'signals', 'pull'];
  const countWords = ['how many', 'count', 'total', 'aggregate', 'breakdown'];
  const sourceWords = ['email', 'emails', 'slack', 'meeting', 'meetings', 'transcript', 'transcripts', 'documents', 'conversations'];
  const multiSource = sourceWords.filter(word => q.includes(word)).length >= 2;

  if (includesAny(q, countWords) && includesAny(q, sourceWords)) {
    return { task_shape: 'count_aggregation', should_run_durably: true, reason: 'max_count_aggregation' };
  }
  if (includesAny(q, sampleWords) && (multiSource || includesAny(q, sourceWords))) {
    return { task_shape: 'sample_corpus', should_run_durably: true, reason: 'max_sample_corpus' };
  }
  if (includesAny(q, reportWords) && (multiSource || includesAny(q, sourceWords))) {
    return { task_shape: 'evidence_report', should_run_durably: true, reason: 'max_evidence_report' };
  }
  if (includesAny(q, ['create', 'make', 'generate']) && includesAny(q, ['docx', 'pdf', 'xlsx', 'artifact', 'document'])) {
    return { task_shape: 'artifact_synthesis', should_run_durably: true, reason: 'max_artifact_synthesis' };
  }
  if (maxSetIntent?.shouldBuild && maxSetIntent.input) {
    return { task_shape: 'set_builder', should_run_durably: true, reason: 'max_set_builder' };
  }
  if (multiSource && includesAny(q, ['all', 'every', 'across', 'whole firm', 'firmwide', 'longer', 'throughout'])) {
    return { task_shape: 'mixed', should_run_durably: true, reason: 'max_mixed_broad_sweep' };
  }
  return { task_shape: 'mixed', should_run_durably: false, reason: 'max_not_broad_enough_for_queue' };
}

export function buildMaxExecutionPlan(query: string, taskShape: MaxTaskShape, maxSetIntent?: MaxSetIntentLike): MaxExecutionPlan {
  const requestedCounts = {
    emails: extractRequestedCount(query, 'email', taskShape === 'sample_corpus' ? 25 : 12),
    slack: extractRequestedCount(query, 'slack', taskShape === 'sample_corpus' ? 5 : 8),
    meetings: extractRequestedCount(query, 'meeting', taskShape === 'sample_corpus' ? 8 : 8),
    documents: 12,
  };
  const artifactRequired = taskShape === 'evidence_report'
    || taskShape === 'sample_corpus'
    || taskShape === 'artifact_synthesis'
    || /\b(docx|pdf|xlsx|report|document|artifact|export)\b/i.test(query);
  const kind: 'docx' | 'pdf' | 'xlsx' = /\bxlsx|spreadsheet|csv\b/i.test(query)
    ? 'xlsx'
    : /\bpdf\b/i.test(query)
      ? 'pdf'
      : 'docx';
  const targetOutput = taskShape === 'set_builder'
    ? 'artifact'
    : taskShape === 'sample_corpus'
      ? 'sample_set'
      : taskShape === 'count_aggregation'
        ? 'count_table'
        : artifactRequired
          ? 'report'
          : 'answer';
  return {
    task_shape: taskShape,
    source_families: selectSourceFamilies(query, taskShape, maxSetIntent),
    target_output: targetOutput,
    artifact: {
      required: artifactRequired || taskShape === 'set_builder',
      kind,
      title: taskShape === 'set_builder' ? titleFromQuery(query) : `${titleFromQuery(query)} - MAX Report`,
    },
    privacy_policy: {
      raw_conversation_bodies: 'allowed_when_acl_permits',
      meeting_transcripts: 'chunks_only',
      generated_visibility: 'private',
    },
    phase_budgets: {
      email: { row_limit: requestedCounts.emails, body_limit: requestedCounts.emails },
      slack: { row_limit: requestedCounts.slack, body_limit: requestedCounts.slack },
      meetings: { row_limit: requestedCounts.meetings },
      documents: { row_limit: requestedCounts.documents },
      crm: { row_limit: 15 },
    },
    requested_counts: requestedCounts,
    search_query: deriveEvidenceSearchQuery(query),
    max_set_input: maxSetIntent?.input || undefined,
  };
}

export async function createQueuedMaxModeJob(
  env: Env,
  ctx: AuthContext,
  input: {
    sessionId: string;
    assistantMessageId: string;
    requestId: string;
    agentRunId: string;
    query: string;
    plan: MaxExecutionPlan;
    maxSetInput?: any;
  }
): Promise<string> {
  const jobId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO max_mode_jobs
       (id, org_id, user_id, query, task_type, entity_kind, status,
        plan_json, progress_json, session_id, assistant_message_id, request_id,
        agent_run_id, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    jobId,
    ctx.orgId,
    ctx.userId,
    input.query,
    input.maxSetInput?.task_type || input.plan.task_shape,
    input.maxSetInput?.entity_kind || 'mixed',
    JSON.stringify(input.plan),
    JSON.stringify({ phase: 'queued', durable: true, queued_at: new Date().toISOString() }),
    input.sessionId,
    input.assistantMessageId,
    input.requestId,
    input.agentRunId
  ).run();
  return jobId;
}

export async function enqueueMaxModeJob(
  env: Env,
  ctx: AuthContext,
  payload: MaxModeWorkPayload
): Promise<{ workQueueId?: string; inserted: boolean }> {
  const result = await enqueueWork(env, ctx.orgId, MAX_MODE_WORK_QUEUE_DOMAIN, payload, {
    idempotency_key: payload.request_id,
    priority: 50,
    max_attempts: 2,
  });
  await updateMaxModeJobProgress(env, payload.job_id, {
    status: 'queued',
    phase: 'queued',
    work_queue_id: result.id || null,
    durable: true,
  });
  return { workQueueId: result.id, inserted: result.inserted };
}

export async function updateMaxModeJobProgress(
  env: Env,
  jobId: string | null | undefined,
  input: {
    status?: string;
    phase?: string;
    progress?: Record<string, unknown>;
    result?: any;
    artifactDocumentId?: string | null;
    errorMessage?: string | null;
    work_queue_id?: string | null;
    durable?: boolean;
  }
): Promise<void> {
  if (!jobId) return;
  const status = input.status || null;
  const progress = {
    ...(input.progress || {}),
    phase: input.phase || input.progress?.phase || status || 'running',
    updated_at: new Date().toISOString(),
    durable: input.durable ?? true,
    work_queue_id: input.work_queue_id ?? input.progress?.work_queue_id,
  };
  await env.D1.prepare(
    `UPDATE max_mode_jobs
        SET status = COALESCE(?, status),
            progress_json = ?,
            result_json = COALESCE(?, result_json),
            artifact_document_id = COALESCE(?, artifact_document_id),
            error_message = COALESCE(?, error_message),
            heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END
      WHERE id = ?`
  ).bind(
    status,
    JSON.stringify(progress),
    input.result ? JSON.stringify(input.result) : null,
    input.artifactDocumentId || null,
    input.errorMessage || null,
    status,
    jobId
  ).run();
}

async function emitMaxEvent(
  env: Env,
  payload: MaxModeWorkPayload,
  eventName: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  const body = {
    type: 'max_step',
    durable: true,
    job_id: payload.job_id,
    run_id: payload.agent_run_id,
    request_id: payload.request_id,
    session_id: payload.session_id,
    task_shape: payload.plan.task_shape,
    step: eventName,
    status: data.status || (TERMINAL_JOB_STATUSES.has(eventName) ? eventName : 'running'),
    message: data.message || maxEventMessage(eventName, payload.plan),
    ...data,
  };
  try {
    const seq = await appendAgentRunEvent(env, {
      runId: payload.agent_run_id,
      orgId: payload.org_id,
      sessionId: payload.session_id,
      eventType: eventName,
      payload: body,
    });
    await env.D1.prepare(
      `UPDATE max_mode_jobs SET last_event_seq = ? WHERE id = ?`
    ).bind(seq, payload.job_id).run().catch(() => {});
  } catch (error: any) {
    console.warn('[max-mode:event] append failed:', error?.message || error);
  }
}

function maxEventMessage(eventName: string, plan: MaxExecutionPlan): string {
  if (eventName === 'planned') return `Planned ${plan.task_shape.replace(/_/g, ' ')} across ${plan.source_families.join(', ')}.`;
  if (eventName === 'source_scan_started') return 'Scanning source families.';
  if (eventName === 'source_scan_progress') return 'Source scan is making progress.';
  if (eventName === 'source_scan_complete') return 'Source scan complete.';
  if (eventName === 'artifact_started') return 'Creating the artifact.';
  if (eventName === 'artifact_ready') return 'Artifact is ready.';
  if (eventName === 'completed') return 'MAX job completed.';
  if (eventName === 'failed') return 'MAX job failed.';
  if (eventName === 'cancelled') return 'MAX job stopped.';
  return 'MAX is still running.';
}

function makeToolState(payload: MaxModeWorkPayload, status: 'executing' | 'done' | 'error' | 'cancelled', result?: any): any[] {
  const tool = payload.plan.task_shape === 'set_builder' ? 'build_max_set' : 'max_evidence_report';
  const run = {
    id: payload.job_id,
    input: payload.plan.task_shape === 'set_builder' ? payload.max_set_input : { query: payload.query, plan: payload.plan },
    result,
    status,
    completed_at: status === 'executing' ? undefined : new Date().toISOString(),
  };
  return [{
    id: `${tool}:${payload.job_id}`,
    tool,
    input: run.input,
    result,
    status,
    collapsed: true,
    runs: [run],
    activeRunId: status === 'executing' ? run.id : undefined,
    updated_at: new Date().toISOString(),
  }];
}

async function persistAssistantMessage(
  env: Env,
  payload: MaxModeWorkPayload,
  input: {
    content: string;
    status: 'running' | 'done' | 'error' | 'cancelled';
    documentCards?: MartyDocumentCard[];
    error?: string | null;
    toolResult?: any;
  }
): Promise<void> {
  const row = await env.D1.prepare(
    `SELECT metadata FROM agent_messages WHERE id = ? AND session_id = ?`
  ).bind(payload.assistant_message_id, payload.session_id).first<{ metadata: string | null }>().catch(() => null);
  const metadata = safeParseJsonObject(row?.metadata);
  const cards = normalizeDocumentCards(input.documentCards || []);
  const toolStatus = input.status === 'done'
    ? 'done'
    : input.status === 'cancelled'
      ? 'cancelled'
      : input.status === 'error'
        ? 'error'
        : 'executing';
  metadata.status = input.status;
  metadata.request_id = payload.request_id;
  metadata.run_id = payload.agent_run_id;
  metadata.deep_dive = true;
  metadata.durable = true;
  metadata.runtime_fingerprint = payload.runtime_fingerprint || metadata.runtime_fingerprint;
  metadata.max_job = {
    id: payload.job_id,
    status: input.status,
    task_shape: payload.plan.task_shape,
    source_families: payload.plan.source_families,
  };
  metadata.tool_calls = makeToolState(payload, toolStatus, input.toolResult);
  if (cards.length > 0) metadata.document_cards = cards;
  if (input.error) {
    metadata.error = input.error;
    metadata.retryable = input.status === 'error';
  }
  await env.D1.prepare(
    `UPDATE agent_messages
        SET content = ?,
            sources_json = NULL,
            metadata = ?
      WHERE id = ? AND session_id = ?`
  ).bind(input.content, JSON.stringify(metadata), payload.assistant_message_id, payload.session_id).run();
  await env.D1.prepare(
    `UPDATE agent_sessions
        SET last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(payload.session_id).run().catch(() => {});
}

function safeParseJsonObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

async function loadAuthContextForJob(env: Env, payload: MaxModeWorkPayload): Promise<AuthContext> {
  const user = await env.D1.prepare(
    `SELECT id, org_id, email, role
       FROM users
      WHERE id = ? AND org_id = ?
      LIMIT 1`
  ).bind(payload.user_id, payload.org_id).first<{ id: string; org_id: string; email: string; role: string }>();
  if (!user) throw new Error('MAX_JOB_USER_NOT_FOUND');
  const role = ['owner', 'admin', 'member', 'super_admin'].includes(user.role) ? user.role : 'member';
  return {
    userId: user.id,
    orgId: user.org_id,
    email: user.email,
    userRole: role as AuthContext['userRole'],
  };
}

async function assertNotCancelled(env: Env, payload: MaxModeWorkPayload): Promise<void> {
  if (await isAgentRunCancellationRequested(env, payload.agent_run_id)) {
    throw new MaxJobCancelledError();
  }
  if (await wasCancelledIncludingKV(payload.request_id, env)) {
    throw new MaxJobCancelledError();
  }
}

class MaxJobCancelledError extends Error {
  constructor() {
    super('MAX job cancelled');
    this.name = 'MaxJobCancelledError';
  }
}

function formatMaxSetAnswer(result: any, elapsedMs: number): string {
  if (result?.error) {
    return [
      `MAX set-builder failed before it could complete: ${result.error}`,
      '',
      'I did not create an export because the deterministic set-builder did not return a safe result.',
    ].join('\n');
  }
  const confirmed = Array.isArray(result?.confirmed) ? result.confirmed.length : 0;
  const probable = Array.isArray(result?.probable) ? result.probable.length : 0;
  const needsReview = Array.isArray(result?.needs_review) ? result.needs_review.length : 0;
  const excluded = Array.isArray(result?.excluded) ? result.excluded.length : 0;
  const artifact = result?.artifact_card;
  const gate = result?.quality_gate || {};
  const lines = [
    `MAX set-builder finished in ${Math.round(elapsedMs / 1000)}s.`,
    '',
    `Status: **${result?.safety_status || 'unknown'}**`,
    `Counts: **${confirmed} confirmed**, **${probable} probable**, **${needsReview} needs review**, **${excluded} excluded**.`,
  ];
  if (artifact) lines.push('', `Workbook: **${artifact.title || 'MAX export'}** is ready in the card above.`);
  if (gate.reasons?.length) lines.push('', 'Quality gate:', ...gate.reasons.slice(0, 8).map((reason: string) => `- ${reason}`));
  return lines.join('\n');
}

function sourceCount(result: any, key: string): number {
  if (!result || typeof result !== 'object') return 0;
  if (typeof result.returned_count === 'number') return result.returned_count;
  if (typeof result.count === 'number') return result.count;
  if (Array.isArray(result[key])) return result[key].length;
  return 0;
}

async function runEvidenceSweep(ctx: AuthContext, payload: MaxModeWorkPayload, env: Env): Promise<{
  results: Record<string, any>;
  coverageRows: string[][];
}> {
  const results: Record<string, any> = {};
  const coverageRows: string[][] = [];
  const plan = payload.plan;
  const query = plan.search_query || payload.query;

  const runSource = async (family: MaxSourceFamily, fn: () => Promise<any>, resultKey: string) => {
    await assertNotCancelled(env, payload);
    await emitMaxEvent(env, payload, 'source_scan_progress', { source_family: family, status: 'running', message: `Scanning ${family}.` });
    await updateMaxModeJobProgress(env, payload.job_id, {
      status: 'running',
      phase: `scan_${family}`,
      progress: { source_family: family },
    });
    const result = await fn();
    results[family] = result;
    const returned = sourceCount(result, resultKey);
    coverageRows.push([family, String(returned), result?.has_more ? 'yes' : 'no', result?.note || '']);
    await emitMaxEvent(env, payload, 'source_scan_progress', {
      source_family: family,
      status: 'running',
      rows_returned: returned,
      message: `Scanned ${family}: ${returned} accessible rows returned.`,
    });
    return result;
  };

  if (plan.source_families.includes('email') || plan.source_families.includes('conversations')) {
    await runSource('email', () => sweepConversations(ctx, {
      query,
      source: 'outlook',
      include_body: true,
      body_fetch_limit: plan.requested_counts.emails,
      limit: plan.requested_counts.emails,
    }, env, { deepDive: true }), 'conversations');
  }

  if (plan.source_families.includes('slack') || plan.source_families.includes('conversations')) {
    await runSource('slack', () => sweepConversations(ctx, {
      query,
      source: 'slack',
      include_body: true,
      body_fetch_limit: plan.requested_counts.slack,
      limit: plan.requested_counts.slack,
    }, env, { deepDive: true }), 'conversations');
  }

  if (plan.source_families.includes('meetings')) {
    await runSource('meetings', () => searchEvents(ctx, {
      keyword: query,
      timeframe: 'all',
      has_transcript: true,
      include_transcript_excerpt: true,
      limit: plan.requested_counts.meetings,
    }, env, { deepDive: true }), 'events');
  }

  if (plan.source_families.includes('documents')) {
    await runSource('documents', () => findDocumentsTool(ctx, {
      query,
      limit: plan.requested_counts.documents,
      mode: 'auto',
    }, env), 'documents');
  }

  if (plan.source_families.includes('crm')) {
    await runSource('crm', async () => {
      const [companies, deals, contacts] = await Promise.all([
        searchCompanies(ctx, { keyword: query, limit: 8 }, env, { deepDive: true }).catch(error => ({ error: String(error?.message || error), companies: [], count: 0 })),
        searchDeals(ctx, { keyword: query, limit: 8 }, env, { deepDive: true }).catch(error => ({ error: String(error?.message || error), deals: [], count: 0 })),
        searchContacts(ctx, { keyword: query, limit: 8 }, env, { deepDive: true }).catch(error => ({ error: String(error?.message || error), contacts: [], count: 0 })),
      ]);
      return { companies, deals, contacts, count: (companies.count || 0) + (deals.count || 0) + (contacts.count || 0) };
    }, 'crm');
  }

  await emitMaxEvent(env, payload, 'source_scan_complete', {
    status: 'running',
    coverage: coverageRows,
    message: 'Source scan complete; preparing output.',
  });
  return { results, coverageRows };
}

function cleanCell(value: unknown, max = 900): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function conversationRows(result: any): string[][] {
  const rows = Array.isArray(result?.conversations) ? result.conversations : [];
  return rows.map((row: any) => [
    row.sent_at || '',
    row.source || '',
    row.from_name || row.from_email || '',
    row.subject || '',
    cleanCell(row.body_excerpt, 1600),
  ]);
}

function meetingRows(result: any): string[][] {
  const rows = Array.isArray(result?.events) ? result.events : [];
  return rows.map((row: any) => [
    row.start_time || '',
    row.title || '',
    String(row.attendee_count || 0),
    cleanCell(row.summary || row.topics_discussed || '', 700),
    cleanCell(row.transcript_excerpt || '', 1400),
  ]);
}

function documentRows(result: any): string[][] {
  const rows = Array.isArray(result?.documents) ? result.documents : [];
  return rows.map((row: any) => [
    row.title || '',
    row.document_type || '',
    row.date || '',
    cleanCell(row.excerpt || '', 1000),
  ]);
}

function crmRows(result: any): string[][] {
  const companies = Array.isArray(result?.companies?.companies) ? result.companies.companies : [];
  const deals = Array.isArray(result?.deals?.deals) ? result.deals.deals : [];
  const contacts = Array.isArray(result?.contacts?.contacts) ? result.contacts.contacts : [];
  return [
    ...companies.map((row: any) => ['company', row.name || '', row.sector || '', row.company_type || row.investment_status || '']),
    ...deals.map((row: any) => ['deal', row.title || '', row.stage || '', row.company_name || '']),
    ...contacts.map((row: any) => ['contact', row.full_name || '', row.email || '', row.company_name || '']),
  ];
}

function buildReportArtifactContent(payload: MaxModeWorkPayload, sweep: { results: Record<string, any>; coverageRows: string[][] }): any {
  const emailRows = conversationRows(sweep.results.email);
  const slackRows = conversationRows(sweep.results.slack);
  const eventRows = meetingRows(sweep.results.meetings);
  const docRows = documentRows(sweep.results.documents);
  const relatedCrmRows = crmRows(sweep.results.crm);
  const totalEvidence = emailRows.length + slackRows.length + eventRows.length + docRows.length;
  const coverageNote = totalEvidence > 0
    ? `Collected ${totalEvidence} accessible evidence packets across ${payload.plan.source_families.join(', ')}.`
    : 'No matching accessible evidence packets were returned by the first sweep.';

  return {
    subtitle: 'Durable MAX evidence sweep',
    summary: coverageNote,
    metadata: [
      { label: 'Task shape', value: payload.plan.task_shape },
      { label: 'Source policy', value: 'Email/Slack bodies only when ACL permits; meeting transcripts are excerpt chunks only.' },
      { label: 'Search query', value: payload.plan.search_query },
    ],
    sections: [
      {
        heading: 'Executive Summary',
        paragraphs: [
          coverageNote,
          'This artifact is generated from structured source adapters, not from a single request-bound browser stream.',
        ],
        bullets: [
          `Email examples: ${emailRows.length}`,
          `Slack examples: ${slackRows.length}`,
          `Meeting transcript chunks: ${eventRows.length}`,
          `Document matches: ${docRows.length}`,
        ],
      },
      {
        heading: 'Coverage',
        tables: [{
          title: 'Source scan coverage',
          headers: ['Source family', 'Rows returned', 'More available', 'Note'],
          rows: sweep.coverageRows.length ? sweep.coverageRows : [['none', '0', 'no', 'No source families returned evidence.']],
        }],
      },
      {
        heading: 'Emails',
        paragraphs: ['Accessible email bodies are included as raw excerpts where the conversation ACL allowed body retrieval.'],
        tables: [{
          title: 'Email evidence packets',
          headers: ['Date', 'Source', 'From', 'Subject', 'Raw excerpt'],
          rows: emailRows.length ? emailRows : [['', '', '', '', 'No matching accessible emails returned.']],
        }],
      },
      {
        heading: 'Slack Messages',
        paragraphs: ['Slack messages are kept separate from email so downstream ingestion can preserve source semantics.'],
        tables: [{
          title: 'Slack evidence packets',
          headers: ['Date', 'Source', 'From', 'Subject/channel', 'Raw excerpt'],
          rows: slackRows.length ? slackRows : [['', '', '', '', 'No matching accessible Slack messages returned.']],
        }],
      },
      {
        heading: 'Meeting Transcript Chunks',
        paragraphs: ['Meeting transcripts are excerpted only; full raw transcripts are intentionally not copied into this report.'],
        tables: [{
          title: 'Meeting evidence packets',
          headers: ['Date', 'Title', 'Attendees', 'Summary/signals', 'Transcript chunk'],
          rows: eventRows.length ? eventRows : [['', '', '', '', 'No matching accessible meeting transcript chunks returned.']],
        }],
      },
      {
        heading: 'Documents And CRM Context',
        tables: [
          {
            title: 'Document matches',
            headers: ['Title', 'Type', 'Date', 'Excerpt'],
            rows: docRows.length ? docRows : [['', '', '', 'No matching accessible documents returned.']],
          },
          {
            title: 'Related CRM records',
            headers: ['Type', 'Name/title', 'Signal', 'Context'],
            rows: relatedCrmRows.length ? relatedCrmRows : [['', '', '', 'No matching CRM context returned.']],
          },
        ],
      },
      {
        heading: 'Gaps And Follow Up',
        bullets: [
          'If returned counts are lower than requested, the missing items were not accessible or did not match the initial evidence query.',
          'Run a narrower follow-up with a company name, founder, source person, or date window to deepen a specific bucket.',
          'This MAX job is resumable through run events and the work queue; browser disconnects do not define job success.',
        ],
      },
    ],
  };
}

async function executeSetBuilderJob(ctx: AuthContext, payload: MaxModeWorkPayload, env: Env): Promise<void> {
  const started = Date.now();
  await emitMaxEvent(env, payload, 'source_scan_started', {
    status: 'running',
    source_families: payload.plan.source_families,
    message: 'Running durable MAX set-builder.',
  });
  await persistAssistantMessage(env, payload, {
    content: 'MAX is running in the background. I will keep this card updated and attach the artifact when it is ready.',
    status: 'running',
  });
  await assertNotCancelled(env, payload);
  const result: any = await buildMaxSetTool(ctx, payload.max_set_input || payload.plan.max_set_input, env, {
    deepDive: true,
    jobId: payload.job_id,
  });
  await assertNotCancelled(env, payload);
  const compact = compactMaxSetResultForContext(result);
  const documentCards = normalizeDocumentCards(result?.document_cards || []);
  if (documentCards.length > 0) {
    await emitMaxEvent(env, payload, 'artifact_ready', {
      status: 'running',
      document_cards: documentCards,
      message: 'MAX set-builder artifact is ready.',
    });
  }
  const finalText = formatMaxSetAnswer(result, Date.now() - started);
  await persistAssistantMessage(env, payload, {
    content: finalText,
    status: result?.error ? 'error' : 'done',
    documentCards,
    error: result?.error || null,
    toolResult: compact,
  });
  await updateMaxModeJobProgress(env, payload.job_id, {
    status: result?.error ? 'failed' : 'completed',
    phase: result?.error ? 'failed' : 'completed',
    result: compact,
    artifactDocumentId: documentCards[0]?.document_id || result?.artifact_card?.document_id || null,
    errorMessage: result?.error || null,
  });
  await updateAgentRunStatus(env, payload.agent_run_id, result?.error ? 'error' : 'completed', {
    errorCode: result?.error ? 'MAX_SET_ERROR' : null,
    errorJson: result?.error ? result : undefined,
  });
  await emitMaxEvent(env, payload, result?.error ? 'failed' : 'completed', {
    status: result?.error ? 'failed' : 'completed',
    result: compact,
    document_cards: documentCards,
  });
}

async function executeEvidenceReportJob(ctx: AuthContext, payload: MaxModeWorkPayload, env: Env): Promise<void> {
  await emitMaxEvent(env, payload, 'source_scan_started', {
    status: 'running',
    source_families: payload.plan.source_families,
    message: 'Starting durable MAX source sweep.',
  });
  await persistAssistantMessage(env, payload, {
    content: 'MAX is running a durable evidence sweep. I will attach the report here when it is ready.',
    status: 'running',
  });
  const sweep = await runEvidenceSweep(ctx, payload, env);
  await assertNotCancelled(env, payload);
  await emitMaxEvent(env, payload, 'artifact_started', {
    status: 'running',
    artifact_kind: payload.plan.artifact.kind,
    title: payload.plan.artifact.title,
  });
  await updateMaxModeJobProgress(env, payload.job_id, {
    status: 'running',
    phase: 'artifact_started',
    progress: { artifact_kind: payload.plan.artifact.kind },
  });
  const artifact = await createDocumentArtifactTool(ctx, {
    kind: payload.plan.artifact.kind,
    title: payload.plan.artifact.title,
    structured_content: buildReportArtifactContent(payload, sweep),
    visibility: 'private',
    custom_fields: {
      max_mode_job_id: payload.job_id,
      max_mode_task_shape: payload.plan.task_shape,
      max_mode_durable: true,
      source_families: payload.plan.source_families,
      privacy_policy: payload.plan.privacy_policy,
    },
  }, env);
  const documentCards = normalizeDocumentCards(artifact?.document_cards || []);
  const summary = [
    `MAX report completed across ${payload.plan.source_families.join(', ')}.`,
    '',
    documentCards.length > 0
      ? `Report: **${documentCards[0].title}** is ready in the card above.`
      : 'The report content was generated, but no document card was returned.',
  ].join('\n');
  await persistAssistantMessage(env, payload, {
    content: summary,
    status: 'done',
    documentCards,
    toolResult: {
      ok: true,
      coverage: sweep.coverageRows,
      document_cards: documentCards,
    },
  });
  await updateMaxModeJobProgress(env, payload.job_id, {
    status: 'completed',
    phase: 'completed',
    result: { coverage: sweep.coverageRows, artifact: artifact?.document || null },
    artifactDocumentId: documentCards[0]?.document_id || artifact?.document?.id || null,
  });
  await updateAgentRunStatus(env, payload.agent_run_id, 'completed');
  await emitMaxEvent(env, payload, 'artifact_ready', {
    status: 'running',
    document_cards: documentCards,
    message: 'MAX report artifact is ready.',
  });
  await emitMaxEvent(env, payload, 'completed', {
    status: 'completed',
    document_cards: documentCards,
    coverage: sweep.coverageRows,
  });
}

export async function processMaxModeWorkItem(item: WorkQueueRow, env: Env): Promise<void> {
  let payload: MaxModeWorkPayload;
  try {
    payload = JSON.parse(item.payload || '{}') as MaxModeWorkPayload;
  } catch (error: any) {
    throw new Error(`malformed max_mode_job payload: ${String(error?.message || error)}`);
  }
  if (!payload.job_id || !payload.agent_run_id || !payload.session_id || !payload.assistant_message_id) {
    throw new Error(`max_mode_job payload missing durable ids: ${item.payload}`);
  }

  const job = await env.D1.prepare(
    `SELECT * FROM max_mode_jobs WHERE id = ? AND org_id = ? LIMIT 1`
  ).bind(payload.job_id, item.org_id).first<MaxModeJobRow>();
  if (!job) throw new Error(`MAX job not found: ${payload.job_id}`);
  if (job.status === 'cancelled' || job.cancel_requested_at) return;
  if (TERMINAL_JOB_STATUSES.has(job.status)) return;

  const heartbeat = setInterval(() => {
    void updateMaxModeJobProgress(env, payload.job_id, {
      status: 'running',
      phase: 'heartbeat',
      progress: { heartbeat: true },
    }).catch(() => {});
    void recordHeartbeat(env, item.id).catch(() => {});
  }, 45_000);

  try {
    const ctx = await loadAuthContextForJob(env, payload);
    await assertNotCancelled(env, payload);
    await updateAgentRunStatus(env, payload.agent_run_id, 'running').catch(() => {});
    await updateMaxModeJobProgress(env, payload.job_id, {
      status: 'running',
      phase: 'started',
      progress: { work_queue_id: item.id },
    });
    await emitMaxEvent(env, payload, 'planned', {
      status: 'running',
      plan: payload.plan,
      message: maxEventMessage('planned', payload.plan),
    });

    if (payload.plan.task_shape === 'set_builder') {
      await executeSetBuilderJob(ctx, payload, env);
    } else {
      await executeEvidenceReportJob(ctx, payload, env);
    }
  } catch (error: any) {
    if (error instanceof MaxJobCancelledError || /cancelled/i.test(String(error?.message || error))) {
      await updateMaxModeJobProgress(env, payload.job_id, {
        status: 'cancelled',
        phase: 'cancelled',
        errorMessage: 'Stopped by user.',
      }).catch(() => {});
      await persistAssistantMessage(env, payload, {
        content: '_(stopped)_',
        status: 'cancelled',
        error: 'Stopped by user.',
      }).catch(() => {});
      await updateAgentRunStatus(env, payload.agent_run_id, 'cancelled').catch(() => {});
      await emitMaxEvent(env, payload, 'cancelled', { status: 'cancelled' }).catch(() => {});
      return;
    }
    const message = String(error?.message || error);
    await updateMaxModeJobProgress(env, payload.job_id, {
      status: 'failed',
      phase: 'failed',
      errorMessage: message,
    }).catch(() => {});
    await persistAssistantMessage(env, payload, {
      content: `MAX mode failed before it could complete the durable job: ${message}`,
      status: 'error',
      error: message,
      toolResult: { error: message },
    }).catch(() => {});
    await updateAgentRunStatus(env, payload.agent_run_id, 'error', {
      errorCode: 'MAX_MODE_JOB_ERROR',
      errorJson: { message },
    }).catch(() => {});
    await emitMaxEvent(env, payload, 'failed', { status: 'failed', message }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function cancelMaxModeJobs(
  env: Env,
  ctx: AuthContext,
  filters: { runId?: string | null; requestId?: string | null; sessionId?: string | null },
  reason = 'Stopped by user.'
): Promise<number> {
  if (!filters.runId && !filters.requestId && !filters.sessionId) return 0;
  const where = [
    'org_id = ?',
    "status IN ('queued','running','cancelling')",
    `(user_id = ? OR ? IN (SELECT id FROM users WHERE role IN ('owner','admin','super_admin')))`,
  ];
  const binds: unknown[] = [ctx.orgId, ctx.userId, ctx.userId];
  if (filters.runId) {
    where.push('agent_run_id = ?');
    binds.push(filters.runId);
  }
  if (filters.requestId) {
    where.push('request_id = ?');
    binds.push(filters.requestId);
  }
  if (filters.sessionId) {
    where.push('session_id = ?');
    binds.push(filters.sessionId);
  }
  const rows = await env.D1.prepare(
    `SELECT * FROM max_mode_jobs WHERE ${where.join(' AND ')} LIMIT 20`
  ).bind(...binds).all<MaxModeJobRow>();
  if (!rows.results.length) return 0;

  const ids = rows.results.map(row => row.id);
  const idPlaceholders = ids.map(() => '?').join(',');
  const result = await env.D1.prepare(
    `UPDATE max_mode_jobs
        SET status = 'cancelled',
            cancel_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            error_message = COALESCE(error_message, ?),
            progress_json = ?
      WHERE id IN (${idPlaceholders})`
  ).bind(
    reason,
    JSON.stringify({ phase: 'cancelled', durable: true, cancelled_at: new Date().toISOString(), reason }),
    ...ids
  ).run();

  await env.D1.prepare(
    `UPDATE work_queue
        SET status = 'completed',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            locked_until = NULL,
            last_error = ?
      WHERE domain = ?
        AND status IN ('pending','in_progress')
        AND json_extract(payload, '$.job_id') IN (${idPlaceholders})`
  ).bind(reason, MAX_MODE_WORK_QUEUE_DOMAIN, ...ids).run().catch(() => {});

  for (const row of rows.results) {
    const payload: MaxModeWorkPayload | null = row.plan_json ? {
      job_id: row.id,
      org_id: row.org_id,
      user_id: row.user_id || ctx.userId,
      session_id: row.session_id || filters.sessionId || '',
      assistant_message_id: row.assistant_message_id || '',
      request_id: row.request_id || filters.requestId || '',
      agent_run_id: row.agent_run_id || filters.runId || '',
      query: row.query,
      plan: safeParseJsonObject(row.plan_json) as MaxExecutionPlan,
    } : null;
    if (payload?.agent_run_id && payload.session_id) {
      await emitMaxEvent(env, payload, 'cancelled', { status: 'cancelled', message: reason }).catch(() => {});
    }
  }
  return Number(result.meta?.changes || 0);
}

export async function repairStaleMaxModeJobs(
  env: Env,
  ctx: AuthContext,
  sessionId?: string,
  staleMinutes = 10
): Promise<number> {
  const cutoffExpr = `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${staleMinutes} minutes')`;
  const where = [
    'j.org_id = ?',
    "j.status IN ('queued','running','cancelling')",
    `COALESCE(j.heartbeat_at, j.updated_at, j.created_at) < ${cutoffExpr}`,
    `(j.user_id = ? OR ? IN (SELECT id FROM users WHERE role IN ('owner','admin','super_admin')))`,
  ];
  const binds: unknown[] = [ctx.orgId, ctx.userId, ctx.userId];
  if (sessionId) {
    where.push('j.session_id = ?');
    binds.push(sessionId);
  }
  const rows = await env.D1.prepare(
    `SELECT j.*
       FROM max_mode_jobs j
      WHERE ${where.join(' AND ')}
      LIMIT 50`
  ).bind(...binds).all<MaxModeJobRow>().catch(() => ({ results: [] as MaxModeJobRow[] }));
  if (!rows.results.length) return 0;
  const ids = rows.results.map(row => row.id);
  const idPlaceholders = ids.map(() => '?').join(',');
  await env.D1.prepare(
    `UPDATE max_mode_jobs
        SET status = 'failed',
            error_message = COALESCE(error_message, 'REQUEST_STALE: MAX job heartbeat expired.'),
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            progress_json = ?
      WHERE id IN (${idPlaceholders})`
  ).bind(
    JSON.stringify({ phase: 'failed', durable: true, error: 'REQUEST_STALE', repaired_at: new Date().toISOString() }),
    ...ids
  ).run().catch(() => {});
  await env.D1.prepare(
    `UPDATE work_queue
        SET status = 'dead_letter',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            locked_until = NULL,
            last_error = 'REQUEST_STALE: MAX job heartbeat expired.'
      WHERE domain = ?
        AND status IN ('pending','in_progress','failed')
        AND json_extract(payload, '$.job_id') IN (${idPlaceholders})`
  ).bind(MAX_MODE_WORK_QUEUE_DOMAIN, ...ids).run().catch(() => {});
  for (const row of rows.results) {
    if (row.assistant_message_id && row.session_id) {
      await env.D1.prepare(
        `UPDATE agent_messages
            SET content = CASE WHEN trim(COALESCE(content, '')) = '' THEN ? ELSE content END,
                metadata = json_set(
                  CASE WHEN json_valid(COALESCE(metadata, '{}')) THEN COALESCE(metadata, '{}') ELSE '{}' END,
                  '$.status', 'error',
                  '$.error', 'REQUEST_STALE',
                  '$.retryable', 1
                )
          WHERE id = ? AND session_id = ?`
      ).bind(
        'This MAX job stopped heartbeating before completion. I marked it stale so the session can be used again.',
        row.assistant_message_id,
        row.session_id
      ).run().catch(() => {});
    }
    if (row.agent_run_id) {
      await updateAgentRunStatus(env, row.agent_run_id, 'stale_error', {
        errorCode: 'REQUEST_STALE',
        errorJson: { max_job_id: row.id },
      }).catch(() => {});
    }
  }
  return ids.length;
}

export const __maxOrchestratorTestHooks = {
  deriveEvidenceSearchQuery,
  extractRequestedCount,
  selectSourceFamilies,
};

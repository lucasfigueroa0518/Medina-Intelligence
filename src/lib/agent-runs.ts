import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';

export type AgentRunMode = 'agile' | 'max';
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'error'
  | 'stale_error';

export interface AgentRunRow {
  id: string;
  org_id: string;
  user_id: string | null;
  session_id: string;
  assistant_message_id: string | null;
  request_id: string;
  mode: AgentRunMode;
  status: AgentRunStatus;
  started_at: string;
  heartbeat_at: string | null;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_json: string | null;
}

export async function createAgentRun(
  env: Env,
  ctx: AuthContext,
  input: {
    id?: string;
    sessionId: string;
    assistantMessageId: string;
    requestId: string;
    mode: AgentRunMode;
    status?: AgentRunStatus;
  }
): Promise<string> {
  const runId = input.id || crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO agent_runs
       (id, org_id, user_id, session_id, assistant_message_id, request_id, mode, status, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    runId,
    ctx.orgId,
    ctx.userId,
    input.sessionId,
    input.assistantMessageId,
    input.requestId,
    input.mode,
    input.status || 'running'
  ).run();
  return runId;
}

export async function appendAgentRunEvent(
  env: Env,
  input: {
    runId: string;
    orgId: string;
    sessionId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const seqRow = await env.D1.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM agent_run_events
      WHERE run_id = ?`
  ).bind(input.runId).first<{ next_seq: number }>();
  const seq = Number(seqRow?.next_seq || 1);
  await env.D1.prepare(
    `INSERT INTO agent_run_events
       (id, run_id, org_id, session_id, seq, event_type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    input.runId,
    input.orgId,
    input.sessionId,
    seq,
    input.eventType,
    JSON.stringify(input.payload ?? {})
  ).run();
  await env.D1.prepare(
    `UPDATE agent_runs
        SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(input.runId).run().catch(() => {});
  return seq;
}

export async function updateAgentRunStatus(
  env: Env,
  runId: string | null | undefined,
  status: AgentRunStatus,
  opts: { errorCode?: string | null; errorJson?: unknown } = {}
): Promise<void> {
  if (!runId) return;
  const terminalColumn = status === 'completed'
    ? `completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),`
    : status === 'cancelled'
      ? `cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),`
      : '';
  await env.D1.prepare(
    `UPDATE agent_runs
        SET status = ?,
            ${terminalColumn}
            heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            error_code = COALESCE(?, error_code),
            error_json = COALESCE(?, error_json)
      WHERE id = ?`
  ).bind(
    status,
    opts.errorCode || null,
    opts.errorJson ? JSON.stringify(opts.errorJson) : null,
    runId
  ).run();
}

export async function markAgentRunCancelRequested(
  env: Env,
  ctx: AuthContext,
  filters: { runId?: string | null; requestId?: string | null; sessionId?: string | null }
): Promise<number> {
  const where = [
    'org_id = ?',
    '(user_id = ? OR ? IN (SELECT id FROM users WHERE role IN (\'owner\', \'admin\', \'super_admin\')))',
    "status IN ('queued', 'running')",
  ];
  const binds: unknown[] = [ctx.orgId, ctx.userId, ctx.userId];
  if (filters.runId) {
    where.push('id = ?');
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
  if (!filters.runId && !filters.requestId && !filters.sessionId) return 0;
  const result = await env.D1.prepare(
    `UPDATE agent_runs
        SET status = 'cancelling',
            cancel_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE ${where.join(' AND ')}`
  ).bind(...binds).run();
  return Number(result.meta?.changes || 0);
}

export async function isAgentRunCancellationRequested(
  env: Env,
  runId: string | null | undefined
): Promise<boolean> {
  if (!runId) return false;
  const row = await env.D1.prepare(
    `SELECT status, cancel_requested_at
       FROM agent_runs
      WHERE id = ?`
  ).bind(runId).first<{ status: string; cancel_requested_at: string | null }>();
  return row?.status === 'cancelling' || row?.status === 'cancelled' || !!row?.cancel_requested_at;
}

export async function fetchAgentRunEvents(
  env: Env,
  ctx: AuthContext,
  runId: string,
  afterSeq: number
): Promise<{ run: AgentRunRow | null; events: Array<{ seq: number; event_type: string; payload: any; created_at: string }> }> {
  const run = await env.D1.prepare(
    `SELECT r.*
       FROM agent_runs r
       JOIN agent_sessions s ON s.id = r.session_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE r.id = ?
        AND r.org_id = ?
        AND s.deleted_at IS NULL
        AND (s.user_id = ? OR lower(u.email) = lower(?))`
  ).bind(runId, ctx.orgId, ctx.userId, ctx.email || '').first<AgentRunRow>();
  if (!run) return { run: null, events: [] };
  const rows = await env.D1.prepare(
    `SELECT seq, event_type, payload_json, created_at
       FROM agent_run_events
      WHERE run_id = ?
        AND seq > ?
      ORDER BY seq ASC
      LIMIT 200`
  ).bind(runId, afterSeq).all<{ seq: number; event_type: string; payload_json: string; created_at: string }>();
  return {
    run,
    events: rows.results.map(row => ({
      seq: row.seq,
      event_type: row.event_type,
      payload: safeParse(row.payload_json),
      created_at: row.created_at,
    })),
  };
}

function safeParse(json: string): any {
  try { return JSON.parse(json); } catch { return {}; }
}


// GET /api/settings/system-status — single endpoint feeding the System Status
// tab in Settings. All numbers come from direct D1 queries; no KV counters,
// no estimates. Three sections in one response so the UI does one fetch.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse } from './utils';

export interface SystemStatusActiveTask {
  type: string;                  // human-readable
  items_processed: number;
  started_at: string;
  elapsed_seconds: number;
}

export interface SystemStatusRunHistoryEntry {
  id: string;
  type: string;
  status: 'completed' | 'failed' | 'timed_out';
  items_processed: number;
  items_failed: number;
  started_at: string;
  duration_seconds: number;
  error_message: string | null;
}

export interface CompletenessMetric {
  current: number;
  total: number;
  percentage: number;
}

export interface SystemStatusResponse {
  active_tasks: SystemStatusActiveTask[];
  run_history: SystemStatusRunHistoryEntry[];
  completeness: {
    email_embedding: CompletenessMetric;
    email_linkage: CompletenessMetric;
    contact_enrichment: CompletenessMetric;
    contact_company: CompletenessMetric;
    contact_linkedin: CompletenessMetric;
    company_enrichment: CompletenessMetric;
    company_linkedin: CompletenessMetric;
    meeting_embedding: CompletenessMetric;
    meeting_attendees: CompletenessMetric;
    connected_users: CompletenessMetric & { names_missing: string[] };
  };
  generated_at: string;
}

const WORKFLOW_LABEL: Record<string, string> = {
  ingestion: 'Email & Slack sync',
  enrichment: 'Contact enrichment',
  daily: 'Daily maintenance',
};

function workflowLabel(workflowType: string, metadata: any): string {
  if (metadata?.trigger === 'manual_date_range') return 'Date-range backfill';
  return WORKFLOW_LABEL[workflowType] || workflowType;
}

function pct(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((current / total) * 100);
}

function metric(current: number, total: number): CompletenessMetric {
  return { current, total, percentage: pct(current, total) };
}

export async function getSystemStatus(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const orgId = ctx.orgId;
  const nowMs = Date.now();

  // ── Active tasks: sync_jobs WHERE status='running' ──────────────────────
  const runningRows = await env.D1.prepare(
    `SELECT workflow_type, items_processed, started_at, metadata
       FROM sync_jobs
      WHERE org_id = ? AND status = 'running'
        AND (timeout_at IS NULL OR timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY started_at DESC`
  ).bind(orgId).all<{
    workflow_type: string; items_processed: number;
    started_at: string; metadata: string | null;
  }>();

  const active_tasks: SystemStatusActiveTask[] = runningRows.results.map(r => {
    let metadata: any = {};
    try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
    return {
      type: workflowLabel(r.workflow_type, metadata),
      items_processed: r.items_processed || 0,
      started_at: r.started_at,
      elapsed_seconds: Math.max(0, Math.floor((nowMs - new Date(r.started_at).getTime()) / 1000)),
    };
  });

  // ── Run history: last 20 completed/failed jobs ──────────────────────────
  const historyRows = await env.D1.prepare(
    `SELECT id, workflow_type, status, items_processed, items_failed,
            started_at, completed_at, error_message, metadata
       FROM sync_jobs
      WHERE org_id = ? AND status != 'running'
      ORDER BY created_at DESC
      LIMIT 20`
  ).bind(orgId).all<{
    id: string; workflow_type: string; status: string;
    items_processed: number; items_failed: number;
    started_at: string; completed_at: string | null;
    error_message: string | null; metadata: string | null;
  }>();

  const run_history: SystemStatusRunHistoryEntry[] = historyRows.results.map(r => {
    let metadata: any = {};
    try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* ignore */ }
    const startedMs = new Date(r.started_at).getTime();
    const endedMs = r.completed_at ? new Date(r.completed_at).getTime() : startedMs;
    const status: SystemStatusRunHistoryEntry['status'] =
      r.status === 'completed' ? 'completed'
      : r.status === 'failed' ? 'failed'
      : r.status === 'timed_out' ? 'timed_out'
      : 'completed';
    return {
      id: r.id,
      type: workflowLabel(r.workflow_type, metadata),
      status,
      items_processed: r.items_processed || 0,
      items_failed: r.items_failed || 0,
      started_at: r.started_at,
      duration_seconds: Math.max(0, Math.round((endedMs - startedMs) / 1000)),
      error_message: r.error_message,
    };
  });

  // ── Completeness metrics: 10 D1 aggregates parallelized ─────────────────
  // Each metric is a (current, total) pair from a single COUNT or pair of
  // COUNTs. No estimation, no fallbacks.
  const [
    convoTotalRow, convoEmbeddedRow, convoLinkedRow,
    contactRow,
    companyRow,
    eventTotalRow, eventEmbeddedRow, attendeeRow,
    userRow, userMissingRows,
  ] = await Promise.all([
    env.D1.prepare(`SELECT COUNT(*) as n FROM conversations WHERE org_id = ? AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(DISTINCT entity_id) as n FROM vector_entity_index WHERE source_table = 'conversations' AND org_id = ?`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(
      `SELECT COUNT(DISTINCT cc.conversation_id) as n
         FROM conversation_contacts cc
         JOIN conversations c ON c.id = cc.conversation_id
        WHERE c.org_id = ? AND c.deleted_at IS NULL`
    ).bind(orgId).first<{n:number}>(),
    env.D1.prepare(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN enrichment_last_run IS NOT NULL THEN 1 END) as enriched,
              COUNT(CASE WHEN company_id IS NOT NULL THEN 1 END) as has_company,
              COUNT(CASE WHEN linkedin_url IS NOT NULL THEN 1 END) as has_linkedin
         FROM contacts WHERE org_id = ? AND deleted_at IS NULL`
    ).bind(orgId).first<{ total: number; enriched: number; has_company: number; has_linkedin: number }>(),
    env.D1.prepare(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN enrichment_last_run IS NOT NULL THEN 1 END) as enriched,
              COUNT(CASE WHEN linkedin_url IS NOT NULL THEN 1 END) as has_linkedin
         FROM companies WHERE org_id = ? AND deleted_at IS NULL`
    ).bind(orgId).first<{ total: number; enriched: number; has_linkedin: number }>(),
    env.D1.prepare(`SELECT COUNT(*) as n FROM events WHERE org_id = ? AND deleted_at IS NULL`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(DISTINCT entity_id) as n FROM vector_entity_index WHERE source_table = 'events' AND org_id = ?`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN ea.contact_id IS NOT NULL OR ea.user_id IS NOT NULL THEN 1 END) as linked
         FROM event_attendees ea
         JOIN events e ON e.id = ea.event_id
        WHERE e.org_id = ? AND e.deleted_at IS NULL`
    ).bind(orgId).first<{ total: number; linked: number }>(),
    env.D1.prepare(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN outlook_token IS NOT NULL THEN 1 END) as connected
         FROM users WHERE org_id = ? AND deleted_at IS NULL`
    ).bind(orgId).first<{ total: number; connected: number }>(),
    env.D1.prepare(
      `SELECT full_name, email FROM users
        WHERE org_id = ? AND outlook_token IS NULL AND deleted_at IS NULL
        ORDER BY full_name`
    ).bind(orgId).all<{ full_name: string | null; email: string }>(),
  ]);

  const completeness: SystemStatusResponse['completeness'] = {
    email_embedding: metric(convoEmbeddedRow?.n || 0, convoTotalRow?.n || 0),
    email_linkage: metric(convoLinkedRow?.n || 0, convoTotalRow?.n || 0),
    contact_enrichment: metric(contactRow?.enriched || 0, contactRow?.total || 0),
    contact_company: metric(contactRow?.has_company || 0, contactRow?.total || 0),
    contact_linkedin: metric(contactRow?.has_linkedin || 0, contactRow?.total || 0),
    company_enrichment: metric(companyRow?.enriched || 0, companyRow?.total || 0),
    company_linkedin: metric(companyRow?.has_linkedin || 0, companyRow?.total || 0),
    meeting_embedding: metric(eventEmbeddedRow?.n || 0, eventTotalRow?.n || 0),
    meeting_attendees: metric(attendeeRow?.linked || 0, attendeeRow?.total || 0),
    connected_users: {
      ...metric(userRow?.connected || 0, userRow?.total || 0),
      names_missing: userMissingRows.results.map(u => u.full_name?.trim() || u.email),
    },
  };

  return jsonResponse({
    active_tasks,
    run_history,
    completeness,
    generated_at: new Date().toISOString(),
  } satisfies SystemStatusResponse);
}

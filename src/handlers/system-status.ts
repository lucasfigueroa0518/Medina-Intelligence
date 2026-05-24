// GET /api/settings/system-status — single endpoint feeding the System Status
// tab in Settings. All numbers come from direct D1 queries; no KV counters,
// no estimates.
//
// Phase 1 (2026-05-04) extension: response now also includes the Phase 0
// observability surface — pipelines (per-task last-run + 24h roll-up),
// dead_letter (failed_permanent + failed_24h items needing review),
// stuck_runs (running task_runs with stale heartbeats — watchdog input),
// and budgets (upstream-API utilization + circuit state). The four new
// fields are sourced from getSystemStatusSnapshot in src/lib/system-status,
// which itself fans out 4 D1 reads in parallel. Net cost grows from 10 to
// 14 reads per call — all indexed, all bounded.
//
// Existing fields (active_tasks, run_history, completeness) are unchanged
// — the UI keeps rendering them; new sections are additive.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse } from './utils';
import {
  getSystemStatusSnapshot,
  type PipelineHealthRow,
  type DeadLetterRow,
  type StuckTaskRunRow,
  type BudgetSnapshotRow,
  type StuckWorkQueueRow,
} from '../lib/system-status';
import type { IngestionIncident } from '../lib/ingestion-health';
import type { FireflyKeyStatus } from '../lib/firefly-credentials';
import type { WorkQueueDomainCount } from '../lib/work-queue';
import {
  getDealReplayStatusSnapshot,
  type DealReplayStatusSnapshot,
} from '../lib/deal-replay';
import {
  emptyMartyLabStatusSnapshot,
  getMartyLabStatusSnapshot,
  type MartyLabStatusSnapshot,
} from '../lib/marty-lab';
import { canViewMartySandbox } from '../lib/marty-sandbox-access';
import { getRagV2Status } from '../lib/rag-v2';

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
    document_embedding: CompletenessMetric;
    contact_enrichment: CompletenessMetric;
    contact_company: CompletenessMetric;
    contact_linkedin: CompletenessMetric;
    company_enrichment: CompletenessMetric;
    company_linkedin: CompletenessMetric;
    meeting_embedding: CompletenessMetric;
    meeting_attendees: CompletenessMetric;
    connected_users: CompletenessMetric & { names_missing: string[] };
  };
  // Phase 1 additions — observability surface from Phase 0 helpers.
  pipelines: PipelineHealthRow[];
  dead_letter: DeadLetterRow[];
  stuck_runs: StuckTaskRunRow[];
  budgets: BudgetSnapshotRow[];
  // Phase 4 1b (2026-05-04): per-user Firefly credential metadata.
  // No plaintext or ciphertext. Drives the Settings UI's "credentials
  // section" disabled-state logic and gives operators visibility into
  // which users have keys.
  firefly_credentials: FireflyKeyStatus[];
  // Phase 5 1b (2026-05-05): universal work_queue surface.
  //   • work_queue_inventory — per-(domain,status) counts; drives the
  //     Settings UI's "Work Queue" panel landing in 1c.
  //   • stuck_work_queue — in_progress rows with stale heartbeat;
  //     surfaced ahead of the watchdog sweep so degraded handlers
  //     don't disappear silently into the retry loop.
  // dead_letter already absorbs work_queue:dead_letter rows (no
  // separate field needed; getDeadLetterItems handles the merge).
  work_queue_inventory: WorkQueueDomainCount[];
  stuck_work_queue: StuckWorkQueueRow[];
  ingestion_incidents: IngestionIncident[];
  marty_lab: MartyLabStatusSnapshot;
  deal_replay: DealReplayStatusSnapshot;
  rag_v2: Record<string, unknown>;
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

function isMartySandboxWorkQueueDomain(domain: string | null | undefined): boolean {
  return domain === 'marty_lab_experiment'
    || domain === 'marty_lab_artifact_review'
    || domain === 'marty_lab_code_patch';
}

function isMartySandboxDeadLetter(row: DeadLetterRow): boolean {
  return row.source.startsWith('work_queue:marty_lab_');
}

export async function getSystemStatus(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const orgId = ctx.orgId;
  const showMartySandbox = canViewMartySandbox(ctx);
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

  // ── Completeness metrics + Phase 0 observability snapshot ─────────────
  // Each completeness metric is a (current, total) pair from a single
  // COUNT or pair of COUNTs. No estimation, no fallbacks.
  // The snapshot adds 4 D1 reads (its own internal Promise.all) for the
  // Phase 1 pipelines/dead_letter/stuck_runs/budgets sections.
  const [
    convoTotalRow, convoEmbeddedRow, convoLinkedRow,
    documentTotalRow, documentEmbeddedRow,
    contactRow,
    companyRow,
    eventTotalRow, eventEmbeddedRow, attendeeRow,
    userRow, userMissingRows,
    snapshot,
    martyLab,
    dealReplay,
  ] = await Promise.all([
    // conversations table has no deleted_at column (verified against live
    // schema). All conversations rows are considered live.
    env.D1.prepare(`SELECT COUNT(*) as n FROM conversations WHERE org_id = ?`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(`SELECT COUNT(DISTINCT entity_id) as n FROM vector_entity_index WHERE source_table = 'conversations' AND org_id = ?`).bind(orgId).first<{n:number}>(),
    env.D1.prepare(
      `SELECT COUNT(DISTINCT cc.conversation_id) as n
         FROM conversation_contacts cc
         JOIN conversations c ON c.id = cc.conversation_id
        WHERE c.org_id = ?`
    ).bind(orgId).first<{n:number}>(),
    env.D1.prepare(
      `SELECT COUNT(*) as n
         FROM documents
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND processing_status = 'completed'
          AND r2_key IS NOT NULL`
    ).bind(orgId).first<{n:number}>(),
    env.D1.prepare(
      `SELECT COUNT(DISTINCT d.id) as n
         FROM documents d
         JOIN vector_entity_index vei
           ON vei.entity_id = d.id
          AND vei.source_table = 'documents'
          AND vei.org_id = d.org_id
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.processing_status = 'completed'
          AND d.r2_key IS NOT NULL`
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
    // Phase 1: observability surface. Returns
    // { pipelines, dead_letter, stuck_runs, budgets, generated_at }.
    getSystemStatusSnapshot(env, orgId),
    // MARTy Human Conversation Lab cockpit. This is sandbox visibility
    // only: experiments and candidate upgrades are tracked here without
    // mutating the live assistant.
    showMartySandbox
      ? getMartyLabStatusSnapshot(env, orgId)
      : Promise.resolve(emptyMartyLabStatusSnapshot()),
    // Safe Six-Week Deals Rebuild cockpit. Keep this in System Status so
    // operators can monitor skips, deferrals, and promotions without
    // turning the Deals board itself into a log.
    ctx.userRole === 'owner'
      ? getDealReplayStatusSnapshot(env, orgId)
      : Promise.resolve({
        run: null,
        queue: { pending: 0, in_progress: 0, completed: 0, failed: 0, dead_letter: 0 },
        generated_at: new Date().toISOString(),
      }),
  ]);

  const completeness: SystemStatusResponse['completeness'] = {
    email_embedding: metric(convoEmbeddedRow?.n || 0, convoTotalRow?.n || 0),
    email_linkage: metric(convoLinkedRow?.n || 0, convoTotalRow?.n || 0),
    document_embedding: metric(documentEmbeddedRow?.n || 0, documentTotalRow?.n || 0),
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

  let ragV2: Record<string, unknown>;
  try {
    ragV2 = await getRagV2Status(env, orgId);
  } catch (e) {
    ragV2 = { error: e instanceof Error ? e.message : String(e) };
  }

  const workQueueInventory = showMartySandbox
    ? snapshot.work_queue_inventory
    : snapshot.work_queue_inventory.filter(row => !isMartySandboxWorkQueueDomain(row.domain));
  const stuckWorkQueue = showMartySandbox
    ? snapshot.stuck_work_queue
    : snapshot.stuck_work_queue.filter(row => !isMartySandboxWorkQueueDomain(row.domain));
  const deadLetter = showMartySandbox
    ? snapshot.dead_letter
    : snapshot.dead_letter.filter(row => !isMartySandboxDeadLetter(row));

  return jsonResponse({
    active_tasks,
    run_history,
    completeness,
    pipelines: snapshot.pipelines,
    dead_letter: deadLetter,
    stuck_runs: snapshot.stuck_runs,
    budgets: snapshot.budgets,
    firefly_credentials: snapshot.firefly_credentials,
    ingestion_incidents: snapshot.ingestion_incidents,
    work_queue_inventory: workQueueInventory,
    stuck_work_queue: stuckWorkQueue,
    marty_lab: martyLab,
    deal_replay: dealReplay,
    rag_v2: ragV2,
    generated_at: new Date().toISOString(),
  } satisfies SystemStatusResponse);
}

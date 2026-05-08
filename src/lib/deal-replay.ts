import type { Env } from '../types/env';
import { detectDealSignalForSource, type DealDetectionResult } from './deal-detection';
import { isCompanyInternal } from './internal-entity';
import {
  completeWork,
  deadLetterWork,
  deferWork,
  type WorkQueueRow,
} from './work-queue';

export const DEAL_REPLAY_DOMAIN = 'deal_replay_evidence';
export const DEAL_REPLAY_CONFIRMATION = 'DELETE_ALL_DEALS_AND_REPLAY';

export type DealReplayStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface DealReplayRunSnapshot {
  id: string;
  org_id: string;
  status: DealReplayStatus;
  days_back: number;
  cutoff_at: string;
  reset_mode: 'hard_delete';
  started_by: string | null;
  enqueued_count: number;
  scanned_count: number;
  processed_count: number;
  skipped_count: number;
  evidence_recorded_count: number;
  promoted_count: number;
  rate_limited_count: number;
  error_count: number;
  skip_reasons: Record<string, number>;
  promoted_companies: Array<{ deal_id: string | null; company_name: string; at: string }>;
  recent_evidence: Array<{
    company_name: string;
    source_type: string;
    source_title: string | null;
    evidence: string | null;
    confidence: number | null;
    at: string;
  }>;
  recent_errors: Array<{ source_type?: string; source_id?: string; error: string; at: string }>;
  last_event: string | null;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  elapsed_seconds: number;
  pace_per_minute: number;
}

export interface DealReplayStatusSnapshot {
  run: DealReplayRunSnapshot | null;
  queue: {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
    dead_letter: number;
  };
  generated_at: string;
}

interface DealReplayPayload {
  run_id: string;
  source_type: 'conversation' | 'event' | 'document';
  source_id: string;
  company_id: string;
}

interface SourceBundle {
  sourceType: 'conversation' | 'event' | 'document';
  sourceId: string;
  sourceTitle: string | null;
  sourceDate: string | null;
  bodyText: string;
  bodyPreview: string | null;
  fromEmail?: string | null;
  direction?: string | null;
  sourceLabel?: string | null;
}

interface RunCounterDelta {
  scanned?: number;
  processed?: number;
  skipped?: number;
  evidenceRecorded?: number;
  promoted?: number;
  rateLimited?: number;
  errors?: number;
  skipReason?: string;
  lastEvent: string;
  evidence?: {
    companyName: string;
    sourceType: string;
    sourceTitle: string | null;
    evidence: string | null;
    confidence: number | null;
  };
  promotedCompany?: { dealId: string | null; companyName: string };
  error?: { sourceType?: string; sourceId?: string; message: string };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function capRecent<T>(items: T[], limit = 8): T[] {
  return items.slice(0, limit);
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDeferrableClaudeError(e: unknown): boolean {
  const msg = stringifyError(e);
  return msg.includes('CLAUDE_RATE_LIMITED') || /Claude API error 5\d\d|overloaded/i.test(msg);
}

function replayKeyPrefix(runId: string): string {
  return `deal_replay:${runId}:`;
}

async function updateRunCounters(
  env: Env,
  orgId: string,
  runId: string,
  delta: RunCounterDelta
): Promise<void> {
  const row = await env.D1.prepare(
    `SELECT skip_reasons, promoted_companies, recent_evidence, recent_errors
       FROM deal_replay_runs
      WHERE id = ? AND org_id = ?`
  ).bind(runId, orgId).first<{
    skip_reasons: string | null;
    promoted_companies: string | null;
    recent_evidence: string | null;
    recent_errors: string | null;
  }>();
  if (!row) return;

  const skipReasons = parseJson<Record<string, number>>(row.skip_reasons, {});
  if (delta.skipReason) {
    skipReasons[delta.skipReason] = (skipReasons[delta.skipReason] || 0) + 1;
  }

  const now = new Date().toISOString();
  const promotedCompanies = parseJson<DealReplayRunSnapshot['promoted_companies']>(row.promoted_companies, []);
  if (delta.promotedCompany) {
    promotedCompanies.unshift({
      deal_id: delta.promotedCompany.dealId,
      company_name: delta.promotedCompany.companyName,
      at: now,
    });
  }

  const recentEvidence = parseJson<DealReplayRunSnapshot['recent_evidence']>(row.recent_evidence, []);
  if (delta.evidence) {
    recentEvidence.unshift({
      company_name: delta.evidence.companyName,
      source_type: delta.evidence.sourceType,
      source_title: delta.evidence.sourceTitle,
      evidence: delta.evidence.evidence,
      confidence: delta.evidence.confidence,
      at: now,
    });
  }

  const recentErrors = parseJson<DealReplayRunSnapshot['recent_errors']>(row.recent_errors, []);
  if (delta.error) {
    recentErrors.unshift({
      source_type: delta.error.sourceType,
      source_id: delta.error.sourceId,
      error: delta.error.message,
      at: now,
    });
  }

  await env.D1.prepare(
    `UPDATE deal_replay_runs
        SET scanned_count = scanned_count + ?,
            processed_count = processed_count + ?,
            skipped_count = skipped_count + ?,
            evidence_recorded_count = evidence_recorded_count + ?,
            promoted_count = promoted_count + ?,
            rate_limited_count = rate_limited_count + ?,
            error_count = error_count + ?,
            skip_reasons = ?,
            promoted_companies = ?,
            recent_evidence = ?,
            recent_errors = ?,
            last_event = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    delta.scanned ?? 0,
    delta.processed ?? 0,
    delta.skipped ?? 0,
    delta.evidenceRecorded ?? 0,
    delta.promoted ?? 0,
    delta.rateLimited ?? 0,
    delta.errors ?? 0,
    JSON.stringify(skipReasons),
    JSON.stringify(capRecent(promotedCompanies)),
    JSON.stringify(capRecent(recentEvidence)),
    JSON.stringify(capRecent(recentErrors)),
    delta.lastEvent,
    runId,
    orgId
  ).run();
}

async function hardResetDeals(orgId: string, env: Env): Promise<number> {
  const existing = await env.D1.prepare(
    `SELECT COUNT(*) AS n FROM deals WHERE org_id = ?`
  ).bind(orgId).first<{ n: number }>();

  const dealSubquery = `SELECT id FROM deals WHERE org_id = ?`;
  const stmts: D1PreparedStatement[] = [
    env.D1.prepare(`UPDATE work_queue
       SET status = 'dead_letter',
           last_error = 'Superseded by a new deal replay run',
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           locked_until = NULL
     WHERE org_id = ? AND domain = ? AND status IN ('pending','failed','in_progress')`).bind(orgId, DEAL_REPLAY_DOMAIN),
    env.D1.prepare(`DELETE FROM deal_intelligence WHERE deal_id IN (${dealSubquery})`).bind(orgId),
    env.D1.prepare(`DELETE FROM deal_contacts WHERE org_id = ?`).bind(orgId),
    env.D1.prepare(`DELETE FROM deal_action_items WHERE org_id = ?`).bind(orgId),
    env.D1.prepare(`DELETE FROM deal_notes WHERE org_id = ?`).bind(orgId),
    env.D1.prepare(`DELETE FROM conversation_deals WHERE deal_id IN (${dealSubquery})`).bind(orgId),
    env.D1.prepare(`DELETE FROM event_deals WHERE deal_id IN (${dealSubquery})`).bind(orgId),
    env.D1.prepare(`DELETE FROM slack_channel_deals WHERE org_id = ?`).bind(orgId),
    env.D1.prepare(`DELETE FROM document_links WHERE org_id = ? AND entity_type = 'deal'`).bind(orgId),
    env.D1.prepare(`UPDATE documents SET deal_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND deal_id IS NOT NULL`).bind(orgId),
    env.D1.prepare(`UPDATE tasks SET deal_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE org_id = ? AND deal_id IS NOT NULL`).bind(orgId),
    env.D1.prepare(`DELETE FROM entity_field_state WHERE entity_type = 'deal' AND entity_id IN (${dealSubquery})`).bind(orgId),
    env.D1.prepare(`DELETE FROM entity_associations WHERE org_id = ? AND (entity_a_type = 'deal' OR entity_b_type = 'deal')`).bind(orgId),
    env.D1.prepare(`DELETE FROM approval_queue WHERE org_id = ? AND entity_type = 'deal'`).bind(orgId),
    env.D1.prepare(`DELETE FROM vector_entity_index WHERE org_id = ? AND source_table = 'deals'`).bind(orgId),
    env.D1.prepare(`DELETE FROM deal_suggestion_evidence WHERE org_id = ?`).bind(orgId),
    env.D1.prepare(`DELETE FROM deals WHERE org_id = ?`).bind(orgId),
  ];
  await env.D1.batch(stmts);
  return existing?.n || 0;
}

async function enqueueConversationCandidates(env: Env, orgId: string, runId: string, cutoffAt: string): Promise<number> {
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO work_queue
       (org_id, domain, payload, upstream, idempotency_key, priority, max_attempts)
     WITH candidates AS (
       SELECT DISTINCT c.org_id AS org_id, c.id AS source_id, co.id AS company_id
         FROM conversations c
         JOIN conversation_contacts cc ON cc.conversation_id = c.id
         JOIN contacts ct ON ct.id = cc.contact_id AND ct.deleted_at IS NULL
         JOIN companies co ON co.id = ct.company_id AND co.deleted_at IS NULL
        WHERE c.org_id = ?
          AND c.source IN ('outlook','slack')
          AND c.sent_at >= ?
          AND ct.company_id IS NOT NULL
          AND COALESCE(co.is_internal_entity, 0) = 0
       UNION
       SELECT DISTINCT c.org_id AS org_id, c.id AS source_id, co.id AS company_id
         FROM conversations c
         JOIN contacts ct ON ct.id = c.from_contact_id AND ct.deleted_at IS NULL
         JOIN companies co ON co.id = ct.company_id AND co.deleted_at IS NULL
        WHERE c.org_id = ?
          AND c.source IN ('outlook','slack')
          AND c.sent_at >= ?
          AND ct.company_id IS NOT NULL
          AND COALESCE(co.is_internal_entity, 0) = 0
     )
     SELECT org_id,
            ?,
            json_object('run_id', ?, 'source_type', 'conversation', 'source_id', source_id, 'company_id', company_id),
            'claude',
            ? || source_id || ':' || company_id,
            -10,
            5
       FROM candidates`
  ).bind(
    orgId, cutoffAt,
    orgId, cutoffAt,
    DEAL_REPLAY_DOMAIN,
    runId,
    `${replayKeyPrefix(runId)}conversation:`
  ).run();
  return result.meta?.changes ?? 0;
}

async function enqueueEventCandidates(env: Env, orgId: string, runId: string, cutoffAt: string): Promise<number> {
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO work_queue
       (org_id, domain, payload, upstream, idempotency_key, priority, max_attempts)
     SELECT DISTINCT e.org_id,
            ?,
            json_object('run_id', ?, 'source_type', 'event', 'source_id', e.id, 'company_id', co.id),
            'claude',
            ? || e.id || ':' || co.id,
            -10,
            5
       FROM events e
       JOIN event_attendees ea ON ea.event_id = e.id
       JOIN contacts ct ON ct.id = ea.contact_id AND ct.deleted_at IS NULL
       JOIN companies co ON co.id = ct.company_id AND co.deleted_at IS NULL
      WHERE e.org_id = ?
        AND e.deleted_at IS NULL
        AND e.start_time >= ?
        AND ct.company_id IS NOT NULL
        AND COALESCE(co.is_internal_entity, 0) = 0`
  ).bind(
    DEAL_REPLAY_DOMAIN,
    runId,
    `${replayKeyPrefix(runId)}event:`,
    orgId,
    cutoffAt
  ).run();
  return result.meta?.changes ?? 0;
}

async function enqueueDocumentCandidates(env: Env, orgId: string, runId: string, cutoffAt: string): Promise<number> {
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO work_queue
       (org_id, domain, payload, upstream, idempotency_key, priority, max_attempts)
     WITH candidates AS (
       SELECT DISTINCT d.org_id AS org_id, d.id AS source_id, co.id AS company_id
         FROM documents d
         JOIN companies co ON co.id = d.company_id AND co.deleted_at IS NULL
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.created_at >= ?
          AND d.company_id IS NOT NULL
          AND COALESCE(co.is_internal_entity, 0) = 0
       UNION
       SELECT DISTINCT d.org_id AS org_id, d.id AS source_id, co.id AS company_id
         FROM documents d
         JOIN document_links dl ON dl.document_id = d.id
          AND dl.org_id = d.org_id
          AND dl.entity_type = 'company'
          AND dl.deleted_at IS NULL
         JOIN companies co ON co.id = dl.entity_id AND co.deleted_at IS NULL
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.created_at >= ?
          AND COALESCE(co.is_internal_entity, 0) = 0
       UNION
       SELECT DISTINCT d.org_id AS org_id, d.id AS source_id, co.id AS company_id
         FROM documents d
         JOIN conversations c ON c.id = d.conversation_id AND c.org_id = d.org_id
         JOIN conversation_contacts cc ON cc.conversation_id = c.id
         JOIN contacts ct ON ct.id = cc.contact_id AND ct.deleted_at IS NULL
         JOIN companies co ON co.id = ct.company_id AND co.deleted_at IS NULL
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.created_at >= ?
          AND d.conversation_id IS NOT NULL
          AND ct.company_id IS NOT NULL
          AND COALESCE(co.is_internal_entity, 0) = 0
     )
     SELECT org_id,
            ?,
            json_object('run_id', ?, 'source_type', 'document', 'source_id', source_id, 'company_id', company_id),
            'claude',
            ? || source_id || ':' || company_id,
            -10,
            5
       FROM candidates`
  ).bind(
    orgId, cutoffAt,
    orgId, cutoffAt,
    orgId, cutoffAt,
    DEAL_REPLAY_DOMAIN,
    runId,
    `${replayKeyPrefix(runId)}document:`
  ).run();
  return result.meta?.changes ?? 0;
}

export async function startDealReplayRun(args: {
  orgId: string;
  userId: string;
  daysBack?: number;
  confirmation: string;
  env: Env;
}): Promise<{ run: DealReplayRunSnapshot; deleted_deals: number; enqueued_count: number }> {
  if (args.confirmation !== DEAL_REPLAY_CONFIRMATION) {
    throw new Error(`confirmation must equal ${DEAL_REPLAY_CONFIRMATION}`);
  }

  const daysBack = Math.max(1, Math.min(90, Math.floor(args.daysBack || 42)));
  const active = await envHasActiveReplay(args.orgId, args.env);
  if (active) {
    throw new Error('A deal replay is already running for this org.');
  }

  const runId = crypto.randomUUID();
  const cutoffAt = new Date(Date.now() - daysBack * 86400000).toISOString();

  await args.env.D1.prepare(
    `INSERT INTO deal_replay_runs
       (id, org_id, status, days_back, cutoff_at, reset_mode, started_by, last_event)
     VALUES (?, ?, 'running', ?, ?, 'hard_delete', ?, 'Resetting stale deals before replay')`
  ).bind(runId, args.orgId, daysBack, cutoffAt, args.userId).run();

  try {
    const deletedDeals = await hardResetDeals(args.orgId, args.env);
    const conversationCount = await enqueueConversationCandidates(args.env, args.orgId, runId, cutoffAt);
    const eventCount = await enqueueEventCandidates(args.env, args.orgId, runId, cutoffAt);
    const documentCount = await enqueueDocumentCandidates(args.env, args.orgId, runId, cutoffAt);
    const enqueuedCount = conversationCount + eventCount + documentCount;

    await args.env.D1.prepare(
      `UPDATE deal_replay_runs
          SET enqueued_count = ?,
              last_event = ?,
              completed_at = CASE WHEN ? = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
              status = CASE WHEN ? = 0 THEN 'completed' ELSE 'running' END,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      enqueuedCount,
      enqueuedCount === 0
        ? `Deleted ${deletedDeals} deals; no replay candidates found in the last ${daysBack} days`
        : `Deleted ${deletedDeals} deals and queued ${enqueuedCount} replay candidates`,
      enqueuedCount,
      enqueuedCount,
      runId,
      args.orgId
    ).run();

    const snapshot = await getDealReplayStatusSnapshot(args.env, args.orgId, runId);
    return { run: snapshot.run!, deleted_deals: deletedDeals, enqueued_count: enqueuedCount };
  } catch (e) {
    await args.env.D1.prepare(
      `UPDATE deal_replay_runs
          SET status = 'failed',
              completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              last_event = ?,
              recent_errors = ?,
              error_count = error_count + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      `Replay start failed: ${stringifyError(e)}`,
      JSON.stringify([{ error: stringifyError(e), at: new Date().toISOString() }]),
      runId,
      args.orgId
    ).run();
    throw e;
  }
}

async function envHasActiveReplay(orgId: string, env: Env): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT id FROM deal_replay_runs WHERE org_id = ? AND status = 'running' LIMIT 1`
  ).bind(orgId).first<{ id: string }>();
  return !!row;
}

async function loadConversationSource(env: Env, orgId: string, sourceId: string): Promise<SourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, subject, body_preview, body_r2_key, source, sent_at, from_email, direction
       FROM conversations
      WHERE id = ? AND org_id = ?`
  ).bind(sourceId, orgId).first<{
    id: string;
    subject: string | null;
    body_preview: string | null;
    body_r2_key: string | null;
    source: string;
    sent_at: string;
    from_email: string | null;
    direction: string | null;
  }>();
  if (!row) return null;
  let bodyText = row.body_preview || '';
  if (row.body_r2_key) {
    const obj = await env.R2.get(row.body_r2_key);
    if (obj) bodyText = await obj.text();
  }
  return {
    sourceType: 'conversation',
    sourceId,
    sourceTitle: row.subject,
    sourceDate: row.sent_at,
    bodyText,
    bodyPreview: row.body_preview,
    fromEmail: row.from_email,
    direction: row.direction,
    sourceLabel: row.source,
  };
}

async function loadEventSource(env: Env, orgId: string, sourceId: string): Promise<SourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, title, description, summary, transcript_r2_key, source, start_time
       FROM events
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    title: string;
    description: string | null;
    summary: string | null;
    transcript_r2_key: string | null;
    source: string;
    start_time: string;
  }>();
  if (!row) return null;
  let bodyText = [row.title, row.summary, row.description].filter(Boolean).join('\n\n');
  if (row.transcript_r2_key) {
    const obj = await env.R2.get(row.transcript_r2_key);
    if (obj) bodyText = await obj.text();
  }
  return {
    sourceType: 'event',
    sourceId,
    sourceTitle: row.title,
    sourceDate: row.start_time,
    bodyText,
    bodyPreview: row.summary,
    sourceLabel: row.source,
  };
}

async function loadDocumentSource(env: Env, orgId: string, sourceId: string): Promise<SourceBundle | null> {
  const row = await env.D1.prepare(
    `SELECT id, title, file_name, mime_type, document_type, r2_key,
            extracted_text_preview, created_at
       FROM documents
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(sourceId, orgId).first<{
    id: string;
    title: string;
    file_name: string | null;
    mime_type: string | null;
    document_type: string | null;
    r2_key: string | null;
    extracted_text_preview: string | null;
    created_at: string;
  }>();
  if (!row) return null;

  let bodyText = row.extracted_text_preview || '';
  if ((!bodyText || bodyText.length < 1200) && row.r2_key) {
    try {
      const obj = await env.R2.get(row.r2_key);
      if (obj) {
        const buffer = await obj.arrayBuffer();
        const { extractTextFromFile } = await import('./file-extraction');
        bodyText = await extractTextFromFile(new File([buffer], row.file_name || row.title, { type: row.mime_type || '' }));
      }
    } catch (e) {
      console.warn(`[deal-replay] document text extraction failed for ${sourceId}:`, stringifyError(e));
    }
  }

  return {
    sourceType: 'document',
    sourceId,
    sourceTitle: row.title,
    sourceDate: row.created_at,
    bodyText,
    bodyPreview: row.extracted_text_preview,
    sourceLabel: row.document_type || 'document',
  };
}

async function loadSourceBundle(
  env: Env,
  orgId: string,
  payload: DealReplayPayload
): Promise<SourceBundle | null> {
  if (payload.source_type === 'conversation') return loadConversationSource(env, orgId, payload.source_id);
  if (payload.source_type === 'event') return loadEventSource(env, orgId, payload.source_id);
  return loadDocumentSource(env, orgId, payload.source_id);
}

async function isEligibleCompany(env: Env, orgId: string, companyId: string): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT id, is_internal_entity
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<{ id: string; is_internal_entity: number | null }>();
  if (!row || row.is_internal_entity === 1) return false;
  return !(await isCompanyInternal(companyId, orgId, env));
}

function parsePayload(row: WorkQueueRow): DealReplayPayload | null {
  try {
    const parsed = JSON.parse(row.payload);
    if (!parsed?.run_id || !parsed?.source_type || !parsed?.source_id || !parsed?.company_id) return null;
    if (!['conversation', 'event', 'document'].includes(parsed.source_type)) return null;
    return parsed as DealReplayPayload;
  } catch {
    return null;
  }
}

async function getRunStatus(env: Env, orgId: string, runId: string): Promise<DealReplayStatus | null> {
  const row = await env.D1.prepare(
    `SELECT status FROM deal_replay_runs WHERE id = ? AND org_id = ?`
  ).bind(runId, orgId).first<{ status: DealReplayStatus }>();
  return row?.status || null;
}

export async function processDealReplayWorkItem(item: WorkQueueRow, env: Env): Promise<void> {
  const payload = parsePayload(item);
  if (!payload) {
    await deadLetterWork(env, item.id, 'Malformed deal replay payload');
    return;
  }

  const status = await getRunStatus(env, item.org_id, payload.run_id);
  if (!status) {
    await deadLetterWork(env, item.id, `Deal replay run not found: ${payload.run_id}`);
    return;
  }
  if (status !== 'running') {
    await completeWork(env, item.id);
    return;
  }

  const source = await loadSourceBundle(env, item.org_id, payload);
  if (!source) {
    await updateRunCounters(env, item.org_id, payload.run_id, {
      scanned: 1,
      processed: 1,
      skipped: 1,
      skipReason: 'missing_source',
      lastEvent: `Skipped missing ${payload.source_type} source`,
    });
    await completeWork(env, item.id);
    await maybeFinalizeRun(env, item.org_id, payload.run_id);
    return;
  }

  if (!(await isEligibleCompany(env, item.org_id, payload.company_id))) {
    await updateRunCounters(env, item.org_id, payload.run_id, {
      scanned: 1,
      processed: 1,
      skipped: 1,
      skipReason: 'company_missing_or_internal',
      lastEvent: `Skipped ${source.sourceType} because the candidate company is internal or missing`,
    });
    await completeWork(env, item.id);
    await maybeFinalizeRun(env, item.org_id, payload.run_id);
    return;
  }

  let result: DealDetectionResult;
  try {
    result = await detectDealSignalForSource({
      orgId: item.org_id,
      companyId: payload.company_id,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceTitle: source.sourceTitle,
      sourceDate: source.sourceDate,
      bodyText: source.bodyText,
      bodyPreview: source.bodyPreview,
      fromEmail: source.fromEmail,
      direction: source.direction,
      sourceLabel: source.sourceLabel,
    }, env);
  } catch (e) {
    if (isDeferrableClaudeError(e)) {
      const nextAttemptAt = new Date(Date.now() + 90_000).toISOString();
      await updateRunCounters(env, item.org_id, payload.run_id, {
        rateLimited: 1,
        lastEvent: `Claude paused replay work; next retry ${nextAttemptAt}`,
      });
      await deferWork(env, item.id, nextAttemptAt, item.payload);
      return;
    }

    await updateRunCounters(env, item.org_id, payload.run_id, {
      errors: 1,
      lastEvent: `Replay worker error on ${source.sourceType}`,
      error: { sourceType: source.sourceType, sourceId: source.sourceId, message: stringifyError(e) },
    });
    throw e;
  }

  if (!result.recorded) {
    await updateRunCounters(env, item.org_id, payload.run_id, {
      scanned: 1,
      processed: 1,
      skipped: 1,
      skipReason: result.reason,
      lastEvent: `Skipped ${source.sourceType}: ${result.reason}`,
    });
    await completeWork(env, item.id);
    await maybeFinalizeRun(env, item.org_id, payload.run_id);
    return;
  }

  const companyName = result.companyName || payload.company_id;
  await updateRunCounters(env, item.org_id, payload.run_id, {
    scanned: 1,
    processed: 1,
    evidenceRecorded: 1,
    promoted: result.promoted ? 1 : 0,
    lastEvent: result.promoted
      ? `Promoted ${companyName} to New after corroborating evidence`
      : `Recorded strong evidence for ${companyName}`,
    evidence: {
      companyName,
      sourceType: source.sourceType,
      sourceTitle: source.sourceTitle,
      evidence: result.evidence || null,
      confidence: result.confidence ?? null,
    },
    promotedCompany: result.promoted ? { dealId: result.dealId, companyName } : undefined,
  });
  await completeWork(env, item.id);
  await maybeFinalizeRun(env, item.org_id, payload.run_id);
}

async function queueCountsForRun(
  env: Env,
  orgId: string,
  runId: string
): Promise<DealReplayStatusSnapshot['queue']> {
  const rows = await env.D1.prepare(
    `SELECT status, COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ?
        AND domain = ?
        AND idempotency_key LIKE ?
      GROUP BY status`
  ).bind(orgId, DEAL_REPLAY_DOMAIN, `${replayKeyPrefix(runId)}%`).all<{ status: string; count: number }>();

  const counts: DealReplayStatusSnapshot['queue'] = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    dead_letter: 0,
  };
  for (const row of rows.results) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
  }
  return counts;
}

async function maybeFinalizeRun(env: Env, orgId: string, runId: string): Promise<void> {
  const status = await getRunStatus(env, orgId, runId);
  if (status !== 'running') return;
  const counts = await queueCountsForRun(env, orgId, runId);
  if (counts.pending + counts.in_progress + counts.failed > 0) return;
  await env.D1.prepare(
    `UPDATE deal_replay_runs
        SET status = 'completed',
            completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            last_event = COALESCE(last_event, 'Deal replay completed'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ? AND status = 'running'`
  ).bind(runId, orgId).run();
}

function mapRun(row: any): DealReplayRunSnapshot {
  const startedMs = new Date(row.started_at).getTime();
  const endedMs = row.completed_at ? new Date(row.completed_at).getTime() : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((endedMs - startedMs) / 1000));
  const elapsedMinutes = Math.max(1 / 60, elapsedSeconds / 60);
  const processed = Number(row.processed_count || 0);
  return {
    id: row.id,
    org_id: row.org_id,
    status: row.status,
    days_back: Number(row.days_back || 42),
    cutoff_at: row.cutoff_at,
    reset_mode: 'hard_delete',
    started_by: row.started_by || null,
    enqueued_count: Number(row.enqueued_count || 0),
    scanned_count: Number(row.scanned_count || 0),
    processed_count: processed,
    skipped_count: Number(row.skipped_count || 0),
    evidence_recorded_count: Number(row.evidence_recorded_count || 0),
    promoted_count: Number(row.promoted_count || 0),
    rate_limited_count: Number(row.rate_limited_count || 0),
    error_count: Number(row.error_count || 0),
    skip_reasons: parseJson(row.skip_reasons, {}),
    promoted_companies: parseJson(row.promoted_companies, []),
    recent_evidence: parseJson(row.recent_evidence, []),
    recent_errors: parseJson(row.recent_errors, []),
    last_event: row.last_event || null,
    started_at: row.started_at,
    completed_at: row.completed_at || null,
    cancelled_at: row.cancelled_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    elapsed_seconds: elapsedSeconds,
    pace_per_minute: Math.round((processed / elapsedMinutes) * 10) / 10,
  };
}

export async function getDealReplayStatusSnapshot(
  env: Env,
  orgId: string,
  runId?: string
): Promise<DealReplayStatusSnapshot> {
  const row = runId
    ? await env.D1.prepare(
      `SELECT * FROM deal_replay_runs WHERE org_id = ? AND id = ? LIMIT 1`
    ).bind(orgId, runId).first<any>()
    : await env.D1.prepare(
      `SELECT * FROM deal_replay_runs
        WHERE org_id = ?
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1`
    ).bind(orgId).first<any>();

  if (!row) {
    return {
      run: null,
      queue: { pending: 0, in_progress: 0, completed: 0, failed: 0, dead_letter: 0 },
      generated_at: new Date().toISOString(),
    };
  }

  if (row.status === 'running') {
    await maybeFinalizeRun(env, orgId, row.id);
  }

  const fresh = await env.D1.prepare(
    `SELECT * FROM deal_replay_runs WHERE org_id = ? AND id = ?`
  ).bind(orgId, row.id).first<any>();
  const run = mapRun(fresh || row);
  const queue = await queueCountsForRun(env, orgId, run.id);
  return { run, queue, generated_at: new Date().toISOString() };
}

export async function cancelDealReplayRun(
  env: Env,
  orgId: string
): Promise<{ cancelled: boolean; run: DealReplayRunSnapshot | null; cancelled_work: number }> {
  const active = await env.D1.prepare(
    `SELECT id FROM deal_replay_runs WHERE org_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`
  ).bind(orgId).first<{ id: string }>();
  if (!active) {
    const snapshot = await getDealReplayStatusSnapshot(env, orgId);
    return { cancelled: false, run: snapshot.run, cancelled_work: 0 };
  }

  await env.D1.prepare(
    `UPDATE deal_replay_runs
        SET status = 'cancelled',
            cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_event = 'Deal replay cancelled by owner',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(active.id, orgId).run();

  const cancelled = await env.D1.prepare(
    `UPDATE work_queue
        SET status = 'dead_letter',
            last_error = 'Deal replay cancelled by owner',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            locked_until = NULL
      WHERE org_id = ?
        AND domain = ?
        AND idempotency_key LIKE ?
        AND status IN ('pending','failed')`
  ).bind(orgId, DEAL_REPLAY_DOMAIN, `${replayKeyPrefix(active.id)}%`).run();

  const snapshot = await getDealReplayStatusSnapshot(env, orgId, active.id);
  return { cancelled: true, run: snapshot.run, cancelled_work: cancelled.meta?.changes ?? 0 };
}

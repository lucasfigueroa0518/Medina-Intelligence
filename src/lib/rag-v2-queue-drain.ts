import type { Env } from '../types/env';
import type { RagReindexQueueMessage } from '../types/rag-v2';
import {
  DEFAULT_LOCK_TTL_MS,
  deferWork,
  getOpenCircuits,
  sweepStaleClaims,
  type WorkQueueRow,
} from './work-queue';
import { processClaimedWorkItem } from './work-queue-driver';
import { ragReindexV2Handler } from './work-queue-handlers/rag-reindex-v2';
import { RAG_V2_WORK_QUEUE_DOMAIN } from './rag-v2';

const DEFAULT_DISPATCH_BATCH = 500;
const DEFAULT_MAX_ACTIVE = 640;

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function activeRagV2Count(env: Env, orgId: string): Promise<number> {
  const row = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM work_queue
      WHERE org_id = ? AND domain = ? AND status = 'in_progress'`
  ).bind(orgId, RAG_V2_WORK_QUEUE_DOMAIN).first<{ count: number }>();
  return row?.count ?? 0;
}

async function fetchWorkQueueRow(env: Env, id: string): Promise<WorkQueueRow | null> {
  return env.D1.prepare(
    `SELECT * FROM work_queue WHERE id = ? AND domain = ?`
  ).bind(id, RAG_V2_WORK_QUEUE_DOMAIN).first<WorkQueueRow>();
}

async function claimRagV2BatchForOrg(
  env: Env,
  orgId: string,
  limit: number,
  openCircuitUpstreams: string[]
): Promise<WorkQueueRow[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + DEFAULT_LOCK_TTL_MS).toISOString();
  const placeholders = openCircuitUpstreams.map(() => '?').join(',');
  const upstreamFilter = openCircuitUpstreams.length > 0
    ? `AND (upstream IS NULL OR upstream NOT IN (${placeholders}))`
    : '';

  const result = await env.D1.prepare(
    `UPDATE work_queue
        SET status        = 'in_progress',
            started_at    = COALESCE(started_at, ?),
            heartbeat_at  = ?,
            locked_until  = ?
      WHERE id IN (
        SELECT id FROM work_queue
         WHERE org_id = ?
           AND status = 'pending'
           AND domain = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ${upstreamFilter}
         ORDER BY priority DESC, created_at ASC
         LIMIT ?
      )
      RETURNING *`
  ).bind(
    nowIso,
    nowIso,
    lockedUntil,
    orgId,
    RAG_V2_WORK_QUEUE_DOMAIN,
    nowIso,
    ...openCircuitUpstreams,
    limit
  ).all<WorkQueueRow>();
  return result.results;
}

export async function dispatchRagV2QueueBurst(
  env: Env,
  orgId: string
): Promise<{ claimed: number; dispatched: number; skipped: string | null }> {
  if (!env.RAG_REINDEX_QUEUE) {
    return { claimed: 0, dispatched: 0, skipped: 'RAG_REINDEX_QUEUE_NOT_BOUND' };
  }

  await sweepStaleClaims(env).catch(() => 0);

  const maxActive = positiveInt(env.RAG_V2_QUEUE_MAX_ACTIVE, DEFAULT_MAX_ACTIVE, 2000);
  const dispatchBatch = positiveInt(env.RAG_V2_QUEUE_DISPATCH_BATCH, DEFAULT_DISPATCH_BATCH, 1000);
  const active = await activeRagV2Count(env, orgId);
  const available = Math.max(0, maxActive - active);
  const claimLimit = Math.min(dispatchBatch, available);
  if (claimLimit <= 0) {
    return { claimed: 0, dispatched: 0, skipped: 'RAG_V2_ACTIVE_CAP_REACHED' };
  }

  const openCircuits = await getOpenCircuits(env).catch(() => []);
  const rows = await claimRagV2BatchForOrg(env, orgId, claimLimit, openCircuits);
  if (rows.length === 0) {
    return { claimed: 0, dispatched: 0, skipped: null };
  }

  try {
    const dispatchedAt = new Date().toISOString();
    for (let i = 0; i < rows.length; i += 100) {
      await env.RAG_REINDEX_QUEUE.sendBatch(rows.slice(i, i + 100).map(row => ({
        body: {
          work_queue_id: row.id,
          lease_heartbeat_at: row.heartbeat_at,
          dispatched_at: dispatchedAt,
        } satisfies RagReindexQueueMessage,
      })));
    }
    return { claimed: rows.length, dispatched: rows.length, skipped: null };
  } catch (e) {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await Promise.all(rows.map(row => deferWork(env, row.id, retryAt, row.payload).catch(() => undefined)));
    throw e;
  }
}

export async function handleRagV2QueueBatch(
  batch: MessageBatch<RagReindexQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const row = await fetchWorkQueueRow(env, message.body.work_queue_id);
      if (!row || row.status !== 'in_progress') {
        message.ack();
        continue;
      }
      if (row.heartbeat_at !== message.body.lease_heartbeat_at) {
        message.ack();
        continue;
      }

      await processClaimedWorkItem(env, ragReindexV2Handler, row);
      message.ack();
    } catch (e) {
      console.error(
        `[rag-v2-queue] failed message ${message.id}:`,
        e instanceof Error ? e.message : e
      );
      message.retry({ delaySeconds: Math.min(300, 30 * Math.max(1, message.attempts)) });
    }
  }
}

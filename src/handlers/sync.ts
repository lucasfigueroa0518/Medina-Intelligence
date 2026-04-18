// TRD §5.1 — Sync status
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse } from './utils';

export async function getSyncStatus(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const jobs = await env.D1.prepare(
    `SELECT workflow_type, status, started_at, completed_at, items_processed, items_failed, error_message
     FROM sync_jobs WHERE org_id = ?
     ORDER BY created_at DESC LIMIT 50`
  ).bind(ctx.orgId).all();

  const byType = new Map<string, any>();
  for (const j of jobs.results as any[]) {
    if (!byType.has(j.workflow_type)) byType.set(j.workflow_type, j);
  }

  return jsonResponse({
    ingestion: byType.get('ingestion') || null,
    enrichment: byType.get('enrichment') || null,
    daily: byType.get('daily') || null,
    recent: jobs.results,
  });
}

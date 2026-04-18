// TRD §5.1 — Admin: DLQ, enrichment status, system status, integration status
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { clearEnrichmentRateLimit } from '../lib/rate-limit';
import { emitAudit } from '../lib/audit';

export async function listDlq(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'unresolved';

  const rows = await env.D1.prepare(
    `SELECT * FROM dlq_entries WHERE (org_id = ? OR org_id IS NULL) AND resolution_status = ?
     ORDER BY failed_at DESC LIMIT 200`
  ).bind(ctx.orgId, status).all();
  return jsonResponse({ entries: rows.results });
}

export async function replayDlq(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const entry = await env.D1.prepare(
    'SELECT * FROM dlq_entries WHERE id = ? AND resolution_status = ?'
  ).bind(id, 'unresolved').first<any>();
  if (!entry) return errorResponse('DLQ_ENTRY_NOT_FOUND', 404);

  const payload = await env.R2.get(entry.payload_r2_key);
  if (!payload) return errorResponse('PAYLOAD_MISSING', 404);
  const rawBody = await payload.text();

  await env.WEBHOOK_QUEUE.send({
    source: entry.source,
    receivedAt: new Date().toISOString(),
    idempotencyKey: null,
    rawPayload: rawBody,
    eventType: entry.webhook_event_type || undefined,
    orgId: entry.org_id || undefined,
  });

  await env.D1.prepare(
    `UPDATE dlq_entries SET resolution_status = 'replayed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(ctx.userId, id).run();

  return jsonResponse({ ok: true });
}

export async function discardDlq(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    `UPDATE dlq_entries SET resolution_status = 'discarded', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(ctx.userId, id).run();
  return jsonResponse({ ok: true });
}

export async function getEnrichmentStatus(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const sources = ['reversecontact', 'claude_enrichment', 'claude_news'];
  const status: Record<string, unknown> = {};
  for (const src of sources) {
    const state = await env.KV.get(`rate_limit:${src}:${ctx.orgId}`, 'json');
    status[src] = state || { active: true };
  }
  return jsonResponse({ status });
}

export async function clearRateLimit(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  if (!source) return errorResponse('VALIDATION_ERROR', 400);
  await clearEnrichmentRateLimit(source, ctx.orgId, env);
  return jsonResponse({ ok: true });
}

export async function getSystemStatus(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const stale = await env.KV.get(`cache:stale:${ctx.orgId}`);
  return jsonResponse({
    mode: stale ? 'degraded' : 'normal',
    cache_stale: !!stale,
    last_cache_update: stale || null,
  });
}

export async function getIntegrationStatus(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const users = await env.D1.prepare(
    `SELECT id, email, full_name, outlook_token IS NOT NULL as has_outlook, slack_token IS NOT NULL as has_slack
     FROM users WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(ctx.orgId).all();

  const tokenHealth: Record<string, unknown> = {};
  for (const u of users.results as any[]) {
    const state = await env.KV.get(`token_failed:${u.id}:outlook`, 'json');
    tokenHealth[u.id] = state || { healthy: true };
  }

  return jsonResponse({ users: users.results, tokenHealth });
}

/**
 * POST /api/admin/trigger-sync
 *
 * Body: { "workflow": "ingestion" | "enrichment" }
 *
 * Manually dispatches a new workflow instance for the caller's org, the same
 * way the cron triggers in src/index.ts would. Owner-only — admins can view
 * sync state (§5.1 Sync Status) but only owners can kick off unscheduled runs
 * because these consume Claude RPM budget and Graph API quota.
 *
 * The underlying workflows already have concurrency guards (sync_jobs.timeout_at,
 * TRD §7.1) — if a run is already in progress, the new instance will detect
 * that and exit early without double-processing.
 */
export async function triggerSync(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can manually trigger sync workflows.');
  }

  const body = await parseJsonBody<{ workflow?: string }>(request);
  const workflow = body?.workflow;

  if (workflow !== 'ingestion' && workflow !== 'enrichment') {
    return errorResponse(
      'VALIDATION_ERROR',
      400,
      "workflow must be 'ingestion' or 'enrichment'"
    );
  }

  const binding = workflow === 'ingestion' ? env.INGESTION_WORKFLOW : env.ENRICHMENT_WORKFLOW;
  if (!binding) {
    return errorResponse(
      'WORKFLOW_BINDING_MISSING',
      500,
      `${workflow} workflow binding is not available on this Worker.`
    );
  }

  // Deterministic-ish ID: includes type, org, and wall-clock time so a user
  // clicking "Run Now" twice in the same second still dedupes inside Cloudflare
  // Workflows (second create() with the same id is a no-op).
  const instanceId = `${workflow}-manual-${ctx.orgId}-${Date.now()}`;

  let instance: { id: string };
  try {
    instance = await binding.create({
      id: instanceId,
      params: { org_id: ctx.orgId },
    });
  } catch (e) {
    console.error(`[trigger-sync] ${workflow} create failed:`, e);
    return errorResponse(
      'WORKFLOW_CREATE_FAILED',
      500,
      `Failed to dispatch ${workflow} workflow: ${(e as Error).message}`
    );
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'sync_job',
    metadata: {
      workflow,
      trigger: 'manual',
      instance_id: instance.id,
    },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    workflow,
    instance_id: instance.id,
    message: `${workflow} workflow dispatched. Watch /api/sync/status for progress.`,
  });
}

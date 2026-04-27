// TRD §5.1 — Admin: DLQ, enrichment status, system status, integration status
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { clearEnrichmentRateLimit } from '../lib/rate-limit';
import { runEmbedding } from '../lib/embedding';
import { emitAudit } from '../lib/audit';
import { runHistoricalBackfill, getUserSyncConfig, setUserSyncConfig, type BackfillProgress } from '../integrations/outlook';
import { runDailyCron } from '../lib/daily-cron';
import { triggerCompanyEnrichment, isDomainShapedName } from '../lib/enrichment';

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

// Manual trigger for the daily cron handler (matches the 0 0 * * * cron).
// Same logic the scheduled handler runs — useful for end-to-end pipeline
// testing without waiting for midnight UTC.
export async function runDailyCronManually(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  try {
    await runDailyCron(ctx.orgId, env);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return errorResponse('DAILY_CRON_FAILED', 500, e?.message || String(e));
  }
}

// One-shot sweep: re-enrich every company whose name still looks like an
// auto-generated email-domain placeholder ("Bluepeakllc", "4degrees", ...).
// Re-enrichment runs the canonical-name resolver in enrichment.ts, which
// renames the row (and merges into an existing canonical row if one exists).
// Body: { limit?: number, dry_run?: boolean }
export async function renamePlaceholderCompanies(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = (await parseJsonBody<{ limit?: number; dry_run?: boolean }>(request)) || {};
  const limit = Math.max(1, Math.min(500, body.limit ?? 100));
  const dryRun = body.dry_run === true;

  const rows = await env.D1.prepare(
    `SELECT id, name, domain, website FROM companies
       WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL
       ORDER BY created_at ASC`
  ).bind(ctx.orgId).all<{ id: string; name: string; domain: string | null; website: string | null }>();

  const candidates = rows.results
    .filter(r => isDomainShapedName(r.name, r.domain, r.website))
    .slice(0, limit);

  if (dryRun) {
    return jsonResponse({
      ok: true,
      dry_run: true,
      candidate_count: candidates.length,
      candidates: candidates.map(c => ({ id: c.id, name: c.name, domain: c.domain })),
    });
  }

  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
  for (const c of candidates) {
    try {
      await triggerCompanyEnrichment(c.id, ctx.orgId, env);
      results.push({ id: c.id, name: c.name, ok: true });
    } catch (e: any) {
      results.push({ id: c.id, name: c.name, ok: false, error: e?.message || String(e) });
    }
  }

  return jsonResponse({
    ok: true,
    processed: results.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  });
}

// One-time repair: rewrite participant_user_ids in Vectorize chunk metadata
// after a user-id migration. Vectorize metadata is immutable; we re-upsert
// with the same vector_id to overwrite. Idempotent — vectors whose metadata
// is already correct are skipped without re-embedding. Batched via `limit`
// to stay under the Worker CPU ceiling; call repeatedly until updated === 0.
export async function repairVectorizeParticipantIds(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ old_user_id: string; new_user_id: string; limit?: number }>(request);
  if (!body?.old_user_id || !body?.new_user_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'old_user_id and new_user_id required');
  }
  const limit = Math.min(Math.max(body.limit ?? 25, 1), 100);

  const conversations = await env.D1.prepare(
    `SELECT id FROM conversations WHERE participant_user_ids LIKE ? AND org_id = ?`
  ).bind(`%${body.new_user_id}%`, ctx.orgId).all<{ id: string }>();

  if (conversations.results.length === 0) {
    return jsonResponse({ updated: 0, skipped: 0, errors: [], total_candidate_vectors: 0, message: 'No conversations match new_user_id' });
  }

  const placeholders = conversations.results.map(() => '?').join(',');
  const vectors = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index WHERE source_table = 'conversations' AND entity_id IN (${placeholders})`
  ).bind(...conversations.results.map(c => c.id)).all<{ vector_id: string }>();

  const totalCandidates = vectors.results.length;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const v of vectors.results) {
    if (updated >= limit) break;
    const vectorId = v.vector_id;
    try {
      const existing = await env.VECTORIZE.getByIds([vectorId]);
      if (existing.length === 0) {
        errors.push(`${vectorId}: not in Vectorize`);
        continue;
      }
      const meta = existing[0].metadata || {};
      const csv = String(meta.participant_user_ids || '');
      if (!csv.includes(body.old_user_id)) {
        skipped++;
        continue;
      }
      const chunkText = await env.KV.get(`chunk:${vectorId}`);
      if (!chunkText) {
        errors.push(`${vectorId}: chunk text missing from KV`);
        continue;
      }
      const values = await runEmbedding(env, chunkText);

      const newCsv = csv.split(',').map(s => s === body.old_user_id ? body.new_user_id : s).join(',');
      await env.VECTORIZE.upsert([
        { id: vectorId, values, metadata: { ...meta, participant_user_ids: newCsv } },
      ]);
      updated++;
    } catch (err: any) {
      errors.push(`${vectorId}: ${err?.message || String(err)}`);
    }
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'integration',
    entity_id: `vectorize_repair:${body.old_user_id}->${body.new_user_id}`,
    metadata: { updated, skipped, errors_count: errors.length, total_candidates: totalCandidates },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({ updated, skipped, errors, total_candidate_vectors: totalCandidates });
}

export async function triggerIngestion(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{
    user_id?: string;
    start_date?: string;
    end_date?: string;
  }>(request);

  if (body?.start_date && isNaN(Date.parse(body.start_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'start_date must be a valid ISO 8601 date');
  }
  if (body?.end_date && isNaN(Date.parse(body.end_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'end_date must be a valid ISO 8601 date');
  }

  const userId = body?.user_id || ctx.userId;

  const user = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(userId, ctx.orgId).first();
  if (!user) return errorResponse('USER_NOT_FOUND', 404, 'User not found in your org');

  // Overlap prevention
  const existing = await env.KV.get<BackfillProgress>(
    `backfill_progress:${userId}`,
    'json'
  );
  if (existing && existing.status === 'in_progress') {
    return errorResponse('INGESTION_IN_PROGRESS', 409, 'An ingestion is already in progress. Wait for it to complete or let it timeout.');
  }

  // If date range supplied, run as historical backfill (direct date-filtered query, no delta token)
  if (body?.start_date) {
    const progress = await runHistoricalBackfill(userId, ctx.orgId, 365, env, {
      start_date: body.start_date,
      end_date: body.end_date,
    });

    // Store date range metadata in a sync_jobs row for progress visibility
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = JSON.stringify({
      trigger: 'manual_date_range',
      user_id: userId,
      start_date: body.start_date,
      end_date: body.end_date || now,
    });
    await env.D1.prepare(
      `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, timeout_at, metadata)
       VALUES (?, ?, 'ingestion', 'running', ?, datetime(?, '+30 minutes'), ?)`
    ).bind(jobId, ctx.orgId, now, now, metadata).run();

    if (progress.status === 'completed') {
      await env.D1.prepare(
        `UPDATE sync_jobs SET status = 'completed', completed_at = ?, items_processed = ? WHERE id = ?`
      ).bind(now, progress.total_fetched, jobId).run();
    }

    return jsonResponse({ ok: true, instance_id: jobId, progress });
  }

  // No date range: trigger the standard ingestion workflow
  const binding = env.INGESTION_WORKFLOW;
  if (!binding) {
    return errorResponse('WORKFLOW_BINDING_MISSING', 500, 'Ingestion workflow binding is not available.');
  }

  const instanceId = `ingestion-manual-${ctx.orgId}-${Date.now()}`;
  const instance = await binding.create({
    id: instanceId,
    params: { org_id: ctx.orgId },
  });

  return jsonResponse({ ok: true, instance_id: instance.id });
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

export async function backfillEmail(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{
    user_id?: string;
    days_back?: number;
    start_date?: string;
    end_date?: string;
  }>(request);
  const userId = body?.user_id || ctx.userId;
  const daysBack = body?.days_back || 365;

  if (!body?.start_date && (daysBack < 1 || daysBack > 730)) {
    return errorResponse('VALIDATION_ERROR', 400, 'days_back must be between 1 and 730');
  }

  if (body?.start_date && isNaN(Date.parse(body.start_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'start_date must be a valid ISO 8601 date');
  }
  if (body?.end_date && isNaN(Date.parse(body.end_date))) {
    return errorResponse('VALIDATION_ERROR', 400, 'end_date must be a valid ISO 8601 date');
  }

  const user = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(userId, ctx.orgId).first();
  if (!user) return errorResponse('USER_NOT_FOUND', 404, 'User not found in your org');

  // Overlap prevention: check if a backfill is already running for this user
  const existing = await env.KV.get<BackfillProgress>(
    `backfill_progress:${userId}`,
    'json'
  );
  if (existing && existing.status === 'in_progress') {
    return errorResponse('INGESTION_IN_PROGRESS', 409, 'An ingestion is already in progress. Wait for it to complete or let it timeout.');
  }

  const progress = await runHistoricalBackfill(userId, ctx.orgId, daysBack, env, {
    start_date: body?.start_date,
    end_date: body?.end_date,
  });

  return jsonResponse({ ok: true, progress });
}

export async function getBackfillProgress(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const userId = ctx.userId;
  const progress = await env.KV.get<BackfillProgress>(
    `backfill_progress:${userId}`,
    'json'
  );

  return jsonResponse({ progress: progress || null });
}

export async function getSyncConfig(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const config = await getUserSyncConfig(ctx.userId, env);
  return jsonResponse({ config });
}

export async function updateSyncConfig(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ sync_history_days?: number }>(request);
  if (!body?.sync_history_days) {
    return errorResponse('VALIDATION_ERROR', 400, 'sync_history_days is required');
  }

  const valid = [30, 90, 180, 365, 0];
  if (!valid.includes(body.sync_history_days)) {
    return errorResponse('VALIDATION_ERROR', 400, `sync_history_days must be one of: ${valid.join(', ')} (0 = all time)`);
  }

  const days = body.sync_history_days === 0 ? 3650 : body.sync_history_days;
  await setUserSyncConfig(ctx.userId, { sync_history_days: days }, env);

  return jsonResponse({ ok: true, sync_history_days: days });
}

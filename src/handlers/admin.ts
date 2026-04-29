// TRD §5.1 — Admin: DLQ, enrichment status, system status, integration status
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { clearEnrichmentRateLimit } from '../lib/rate-limit';
import { runEmbedding, chunkEmbedAndPersistAll } from '../lib/embedding';
import { emitAudit } from '../lib/audit';
import { runHistoricalBackfill, getUserSyncConfig, setUserSyncConfig, type BackfillProgress } from '../integrations/outlook';
import { runDailyCron } from '../lib/daily-cron';
import { triggerCompanyEnrichment, isDomainShapedName } from '../lib/enrichment';
import { rebuildEntityIndex } from '../lib/entity-index';
import { processEmbedRetryQueue } from '../lib/daily-cron';
import { parseParticipantUserIds } from '../lib/helpers';
import {
  createProgressiveBackfill as libCreateProgressiveBackfill,
  getProgressiveStatus,
  listProgressiveBackfills,
} from '../lib/progressive-backfill';

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
      const values = await runEmbedding(env, chunkText, ctx.orgId);

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

// One-time repair: walk every email/transcript chunk vector for this org and
// fix the two ACL bugs introduced by the daily-cron backfill paths
// (backfillUnembeddedConversations and embedEntityById):
//   1. visibility was hard-coded 'org_wide' for emails; it should be 'private'
//      to match the initial-ingest path (classification.ts:233).
//   2. participant_user_ids was passed through as the D1 JSON-string format
//      ('["a","b"]') instead of the canonical comma-joined form ('a,b'),
//      so the post-retrieval ACL filter couldn't parse it.
// Vectorize metadata is immutable; we re-upsert with the same vector_id and
// re-embed from the cached chunk text in KV. Only the broken vectors are
// touched — already-correct vectors are detected and skipped without
// re-embedding so the repair is idempotent. Batched via `limit` (default 50,
// max 200) to stay under the Worker CPU ceiling; call repeatedly until
// updated === 0 and skipped covers the remaining candidates.
export async function repairBackfilledAclMetadata(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ limit?: number; cursor?: number }>(request);
  const limit = Math.min(Math.max(body?.limit ?? 50, 1), 200);
  const cursor = Math.max(body?.cursor ?? 0, 0);

  const candidates = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index
       WHERE org_id = ? AND source_table = 'conversations'
       ORDER BY vector_id LIMIT ? OFFSET ?`
  ).bind(ctx.orgId, limit, cursor).all<{ vector_id: string }>();

  const totalScanned = candidates.results.length;
  let updated = 0;
  let alreadyCorrect = 0;
  let missingChunkText = 0;
  let notInVectorize = 0;
  const errors: string[] = [];

  // Batch the round-trips. Vectorize.getByIds is capped at 20 IDs per call
  // (VECTOR_GET_ERROR 40007), so chunk into windows of 20 in parallel.
  // KV.get has no batch API — parallelize via Promise.all. Upsert tolerates
  // larger batches so all repairs go in one call. The previous BGE re-embed
  // was redundant — the chunk text didn't change, so existing.values is
  // already the right embedding for the new metadata.
  const VEC_GET_MAX = 20;
  const candidateIds = candidates.results.map(r => r.vector_id);
  const idChunks: string[][] = [];
  for (let i = 0; i < candidateIds.length; i += VEC_GET_MAX) {
    idChunks.push(candidateIds.slice(i, i + VEC_GET_MAX));
  }
  const fetchedMap = new Map<string, { values: number[]; metadata: any }>();
  const getResults = await Promise.allSettled(
    idChunks.map(ids => env.VECTORIZE.getByIds(ids))
  );
  for (const r of getResults) {
    if (r.status === 'fulfilled') {
      for (const v of r.value) {
        fetchedMap.set(v.id, { values: v.values as number[], metadata: v.metadata || {} });
      }
    } else {
      errors.push(`getByIds_chunk: ${r.reason?.message || String(r.reason)}`);
    }
  }

  // Parallel KV chunk-text presence check (informational — doesn't block the
  // repair, since the metadata-only update doesn't depend on the chunk text).
  const kvPresence = await Promise.all(
    candidateIds.map(id => env.KV.get(`chunk:${id}`).then(v => !!v).catch(() => false))
  );
  const kvPresenceMap = new Map<string, boolean>();
  candidateIds.forEach((id, i) => kvPresenceMap.set(id, kvPresence[i]));

  const toUpsert: Array<{ id: string; values: number[]; metadata: any }> = [];

  for (const { vector_id: vectorId } of candidates.results) {
    const existing = fetchedMap.get(vectorId);
    if (!existing) { notInVectorize++; continue; }

    const meta: any = existing.metadata;
    const rawParticipants = meta.participant_user_ids;
    const isJsonFormat =
      typeof rawParticipants === 'string' && rawParticipants.trim().startsWith('[');
    const isOrgWideEmail =
      meta.document_type === 'email' && meta.visibility === 'org_wide';

    if (!isJsonFormat && !isOrgWideEmail) {
      alreadyCorrect++;
      continue;
    }

    if (!kvPresenceMap.get(vectorId)) {
      // Track the orphan but still repair the metadata — the metadata fix
      // is independent of chunk text. The orphan needs a full re-ingest from
      // R2 separately (Wave 2+ candidate).
      missingChunkText++;
    }

    const repairedParticipants = parseParticipantUserIds(rawParticipants).join(',');
    const repairedVisibility =
      meta.document_type === 'email' ? 'private' : meta.visibility || 'org_wide';

    toUpsert.push({
      id: vectorId,
      values: existing.values,
      metadata: {
        ...meta,
        visibility: repairedVisibility,
        participant_user_ids: repairedParticipants || undefined,
      },
    });
  }

  if (toUpsert.length > 0) {
    try {
      await env.VECTORIZE.upsert(toUpsert);
      updated = toUpsert.length;
    } catch (err: any) {
      errors.push(`upsert_batch: ${err?.message || String(err)} (falling back per-vector)`);
      for (const v of toUpsert) {
        try {
          await env.VECTORIZE.upsert([v]);
          updated++;
        } catch (perErr: any) {
          errors.push(`${v.id}: ${perErr?.message || String(perErr)}`);
        }
      }
    }
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'integration',
    entity_id: `acl_repair:cursor=${cursor}`,
    metadata: { scanned: totalScanned, updated, already_correct: alreadyCorrect, missing_chunk_text: missingChunkText, not_in_vectorize: notInVectorize, errors_count: errors.length },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    scanned: totalScanned,
    updated,
    already_correct: alreadyCorrect,
    missing_chunk_text: missingChunkText,
    not_in_vectorize: notInVectorize,
    errors,
    next_cursor: totalScanned === limit ? cursor + limit : null,
  });
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
    `SELECT id, email, full_name, role, share_emails_org_wide, outlook_token IS NOT NULL as has_outlook, slack_token IS NOT NULL as has_slack
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

export async function backfillUnembedded(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const orgId = ctx.orgId;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100);

  const unembedded = await env.D1.prepare(
    `SELECT c.id, c.body_r2_key, c.source, c.subject, c.from_email, c.sent_at,
            c.participant_user_ids
       FROM conversations c
       WHERE c.org_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index vei
            WHERE vei.source_table = 'conversations'
              AND vei.entity_id = c.id
         )
       ORDER BY c.sent_at DESC
       LIMIT ?`
  ).bind(orgId, limit).all<{
    id: string; body_r2_key: string | null; source: string; subject: string | null;
    from_email: string | null; sent_at: string | null; participant_user_ids: string | null;
  }>();

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  const BATCH_SIZE = 10;
  for (let b = 0; b < unembedded.results.length; b += BATCH_SIZE) {
    const batch = unembedded.results.slice(b, b + BATCH_SIZE);
    for (const row of batch) {
      if (!row.body_r2_key) { skipped++; continue; }
      try {
        const obj = await env.R2.get(row.body_r2_key);
        if (!obj) { skipped++; continue; }
        const body = await obj.text();

        const meta = {
          org_id: orgId,
          visibility: 'org_wide' as const,
          participant_user_ids: row.participant_user_ids || undefined,
          document_type: row.source === 'manual' ? 'transcript' : 'email',
          source_table: 'conversations',
          source_id: row.id,
          r2_key: row.body_r2_key,
          created_at: row.sent_at || new Date().toISOString(),
          primary_entity_id: row.id,
          entity_name: row.subject || undefined,
          date: row.sent_at || undefined,
        };

        const entries = await chunkEmbedAndPersistAll(body, meta, env);
        if (entries.length > 0) {
          await env.D1.batch(
            entries.map(e =>
              env.D1.prepare(
                'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
              ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
            )
          );
          embedded++;
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
        errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return jsonResponse({
    ok: true,
    total_unembedded: unembedded.results.length,
    embedded,
    skipped,
    failed,
    errors: errors.slice(0, 20),
  });
}

export async function rebuildEntityIndexEndpoint(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const index = await rebuildEntityIndex(ctx.orgId, env);
  return jsonResponse({
    ok: true,
    contacts: index.contacts.length,
    companies: index.companies.length,
    built_at: index.built_at,
    size_bytes: JSON.stringify(index).length,
  });
}

// One-time cleanup of vector_entity_index bloat (audit 2026-04-28).
//
// Findings: 4,131 index rows for 565 conversations (731% inflation).
//   - 2,064 orphaned (entity_id doesn't match any conversation)
//   - 1,185 of the orphans point to contact IDs (old entity_id bug)
//   - Top 20 conversations have 30–271 vectors each (re-embed bloat)
//
// Phase 1: orphans — delete from Vectorize and D1.
// Phase 2: duplicates (>5 rows for one conversation) — delete all vectors
//          for those entities. Next ingestion run re-embeds them once
//          (with the new dedup guard preventing future bloat).
//
// Owner-only — destructive. Idempotent: re-running after a clean run is a no-op.
export async function cleanupVectorBloat(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can run vector cleanup.');
  }

  const orgId = ctx.orgId;
  const stats = {
    orphaned_d1_rows_deleted: 0,
    duplicate_d1_rows_deleted: 0,
    vectors_deleted_from_vectorize: 0,
    duplicate_entities_cleaned: 0,
    vectorize_delete_errors: [] as string[],
  };

  // Helper: chunked Vectorize deleteByIds (Vectorize accepts up to 1000 IDs
  // per call but we keep batches at 100 to bound Worker CPU per subrequest).
  const deleteFromVectorize = async (vectorIds: string[]) => {
    for (let i = 0; i < vectorIds.length; i += 100) {
      const batch = vectorIds.slice(i, i + 100);
      try {
        await env.VECTORIZE.deleteByIds(batch);
        stats.vectors_deleted_from_vectorize += batch.length;
      } catch (e: any) {
        stats.vectorize_delete_errors.push(
          `batch[${i}-${i + batch.length - 1}]: ${e?.message || String(e)}`
        );
      }
    }
  };

  // Helper: chunked D1 DELETE ... WHERE vector_id IN (...) — SQLite caps
  // bound parameter count at 999, so we batch at 500 to leave headroom.
  const deleteFromD1ByVectorIds = async (vectorIds: string[]): Promise<number> => {
    let deleted = 0;
    for (let i = 0; i < vectorIds.length; i += 500) {
      const batch = vectorIds.slice(i, i + 500);
      const placeholders = batch.map(() => '?').join(',');
      const r = await env.D1.prepare(
        `DELETE FROM vector_entity_index WHERE vector_id IN (${placeholders})`
      ).bind(...batch).run();
      deleted += r.meta.changes || 0;
    }
    return deleted;
  };

  // ── Phase 1: orphaned rows ─────────────────────────────────────────
  const orphanRows = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index
       WHERE source_table = 'conversations' AND org_id = ?
         AND entity_id NOT IN (SELECT id FROM conversations WHERE org_id = ?)`
  ).bind(orgId, orgId).all<{ vector_id: string }>();
  const orphanedVectorIds = orphanRows.results.map(r => r.vector_id);

  if (orphanedVectorIds.length > 0) {
    await deleteFromVectorize(orphanedVectorIds);
    stats.orphaned_d1_rows_deleted = await deleteFromD1ByVectorIds(orphanedVectorIds);
  }

  // ── Phase 2: duplicates ────────────────────────────────────────────
  // For each entity with >5 vectors, drop ALL its vectors. Dedup at embed
  // time means the next ingestion run re-embeds it exactly once.
  const dupGroups = await env.D1.prepare(
    `SELECT entity_id, GROUP_CONCAT(vector_id) AS vector_ids, COUNT(*) AS cnt
       FROM vector_entity_index
      WHERE source_table = 'conversations' AND org_id = ?
        AND entity_id IN (SELECT id FROM conversations WHERE org_id = ?)
      GROUP BY entity_id
      HAVING cnt > 5`
  ).bind(orgId, orgId).all<{ entity_id: string; vector_ids: string; cnt: number }>();

  const dupVectorIds: string[] = [];
  for (const g of dupGroups.results) {
    if (!g.vector_ids) continue;
    const ids = g.vector_ids.split(',').filter(Boolean);
    dupVectorIds.push(...ids);
  }

  if (dupVectorIds.length > 0) {
    await deleteFromVectorize(dupVectorIds);
    stats.duplicate_d1_rows_deleted = await deleteFromD1ByVectorIds(dupVectorIds);
    stats.duplicate_entities_cleaned = dupGroups.results.length;
  }

  await emitAudit(env, {
    org_id: orgId,
    user_id: ctx.userId,
    action: 'hard_delete',
    entity_type: 'integration',
    entity_id: 'vector_entity_index_cleanup',
    metadata: stats,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    stats,
    next_steps:
      'Cleared entities will be re-embedded by the next ingestion run, then dedup prevents new bloat.',
  });
}

// Calendar OAuth health + recovery (audit 2026-04-28 Issue 1).
//
// 4 users have been failing token_refresh_failed every ingestion for >24h.
// Calendars.Read is in the requested scope (auth-oauth.ts:37) so the issue
// is stale refresh tokens — the user revoked access in Microsoft, changed
// their password with MFA enabled, or didn't grant the calendar consent on
// their original sign-in (pre-scope-addition).
//
// This endpoint:
//   GET   — surfaces who's affected and the count, so you know who to ask to
//           reconnect
//   POST  — clears KV failure state + calendar_delta for affected users; the
//           next sync after they re-OAuth will pick up calendar from scratch.
//
// Owner-only — destructive (clears state).
export async function getCalendarTokenHealth(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const users = await env.D1.prepare(
    `SELECT id, email, full_name, outlook_token IS NOT NULL AS has_token
       FROM users WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY email`
  ).bind(ctx.orgId).all<{ id: string; email: string; full_name: string | null; has_token: number }>();

  const report: Array<{
    user_id: string;
    email: string;
    full_name: string | null;
    has_outlook_token: boolean;
    consecutive_failures: number;
    last_failed: string | null;
    has_calendar_delta: boolean;
  }> = [];

  for (const u of users.results) {
    const failState = await env.KV.get<{ count: number; last_failed: string }>(
      `token_failed:${u.id}:outlook`,
      'json'
    );
    const calDelta = await env.KV.get(`calendar_delta:${u.id}`);
    report.push({
      user_id: u.id,
      email: u.email,
      full_name: u.full_name,
      has_outlook_token: !!u.has_token,
      consecutive_failures: failState?.count ?? 0,
      last_failed: failState?.last_failed ?? null,
      has_calendar_delta: !!calDelta,
    });
  }

  const affected = report.filter(r => r.consecutive_failures > 0);
  return jsonResponse({
    ok: true,
    total_users: report.length,
    affected_count: affected.length,
    affected,
    all_users: report,
  });
}

export async function invalidateStaleCalendarTokens(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can invalidate calendar tokens.');
  }

  const users = await env.D1.prepare(
    `SELECT id, email FROM users WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(ctx.orgId).all<{ id: string; email: string }>();

  const cleared: Array<{ user_id: string; email: string; consecutive_failures: number }> = [];
  for (const u of users.results) {
    const failState = await env.KV.get<{ count: number }>(`token_failed:${u.id}:outlook`, 'json');
    if (!failState || (failState.count ?? 0) === 0) continue;

    // Clear the calendar delta so the post-reconnect sync starts fresh
    // rather than trying to resume from a token issued under the bad
    // session. Keep the token_failed counter — clearing it would let the
    // worker burn through quota retrying still-broken tokens.
    await env.KV.delete(`calendar_delta:${u.id}`);
    cleared.push({
      user_id: u.id,
      email: u.email,
      consecutive_failures: failState.count ?? 0,
    });
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'hard_delete',
    entity_type: 'integration',
    entity_id: 'calendar_delta_invalidation',
    metadata: { cleared_count: cleared.length, cleared_users: cleared.map(c => c.email) },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    cleared_count: cleared.length,
    cleared,
    next_steps:
      'Affected users must reconnect Outlook in Settings → Sync & Integrations. After reconnect, their next ingestion run does a full calendar sync.',
  });
}

// On-demand embed retry queue drain (audit 2026-04-28 scale-up Fix 3).
//
// The daily cron also drains this queue, but during a bulk ingestion it's
// useful to process it immediately rather than waiting overnight. Owner-only
// because successive drains burn Workers AI quota.
export async function processEmbedQueue(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can process the embed queue.');
  }

  // Pre-drain snapshot for the response so the caller sees what was queued.
  const before = await env.D1.prepare(
    `SELECT status, COUNT(*) as n FROM embed_retry_queue WHERE org_id = ? GROUP BY status`
  ).bind(ctx.orgId).all<{ status: string; n: number }>();

  const result = await processEmbedRetryQueue(ctx.orgId, env);

  const after = await env.D1.prepare(
    `SELECT status, COUNT(*) as n FROM embed_retry_queue WHERE org_id = ? GROUP BY status`
  ).bind(ctx.orgId).all<{ status: string; n: number }>();

  return jsonResponse({
    ok: true,
    before: Object.fromEntries(before.results.map(r => [r.status, r.n])),
    after: Object.fromEntries(after.results.map(r => [r.status, r.n])),
    drain: result,
  });
}

// Progressive backfill: split a long historical pull into N small windows
// driven by cron, runs server-side without operator presence. Owner-only —
// triggers Workers AI / Graph budget across many cron ticks.

export async function createProgressiveBackfillHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can start a progressive backfill.');
  }
  const body = await parseJsonBody<{
    user_id?: string;
    total_days?: number;
    window_size_days?: number;
  }>(request);
  if (!body?.user_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'user_id required');
  }
  const totalDays = body.total_days ?? 180;
  const windowSize = body.window_size_days ?? 10;
  if (totalDays < 1 || totalDays > 730) {
    return errorResponse('VALIDATION_ERROR', 400, 'total_days must be 1-730');
  }
  if (windowSize < 1 || windowSize > totalDays) {
    return errorResponse('VALIDATION_ERROR', 400, 'window_size_days must be 1..total_days');
  }
  const userExists = await env.D1.prepare(
    'SELECT id FROM users WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(body.user_id, ctx.orgId).first();
  if (!userExists) return errorResponse('USER_NOT_FOUND', 404, 'User not in your org');

  const result = await libCreateProgressiveBackfill(
    ctx.orgId,
    body.user_id,
    totalDays,
    windowSize,
    env
  );
  if (!result.created) {
    return errorResponse('PROGRESSIVE_BACKFILL_BLOCKED', 409, result.reason || 'cannot create');
  }
  return jsonResponse({
    ok: true,
    parent_id: result.parent_id,
    total_days: totalDays,
    window_size_days: windowSize,
  });
}

export async function getProgressiveBackfillHandler(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) {
    const all = await listProgressiveBackfills(ctx.orgId, env);
    return jsonResponse({ ok: true, jobs: all });
  }
  const status = await getProgressiveStatus(ctx.orgId, userId, env);
  return jsonResponse({ ok: true, ...status });
}

// GET — for System Status to show pending / failed counts without a drain.
export async function getEmbedQueueHealth(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const counts = await env.D1.prepare(
    `SELECT status, COUNT(*) as n,
            ROUND(AVG(attempts), 2) as avg_attempts,
            MAX(last_attempt_at) as latest_attempt
       FROM embed_retry_queue WHERE org_id = ? GROUP BY status`
  ).bind(ctx.orgId).all<{ status: string; n: number; avg_attempts: number; latest_attempt: string | null }>();

  const failed = await env.D1.prepare(
    `SELECT entity_id, source_table, attempts, last_error, last_attempt_at
       FROM embed_retry_queue
      WHERE org_id = ? AND status = 'failed_permanent'
      ORDER BY last_attempt_at DESC LIMIT 50`
  ).bind(ctx.orgId).all();

  return jsonResponse({
    ok: true,
    by_status: Object.fromEntries(counts.results.map(r => [r.status, { count: r.n, avg_attempts: r.avg_attempts, latest_attempt: r.latest_attempt }])),
    failed_permanent: failed.results,
  });
}

// ---------------------------------------------------------------------------
// RAG Wave 2 backfills
// ---------------------------------------------------------------------------

// Recompute primary_entity_id on existing conversation vectors written by the
// pre-Wave-2 daily-cron paths. They stamped `primary_entity_id = conversation_id`
// instead of resolving to the from_contact_id (or first to-contact for outbound).
// Walk vectors, look up the conversation row, run resolvePrimaryEntityId, and
// re-upsert if the value changed. Idempotent — re-runs are no-ops once correct.
// Cursor-paginated to stay under Worker CPU.
export async function recomputePrimaryEntityIds(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ limit?: number; cursor?: number }>(request);
  const limit = Math.min(Math.max(body?.limit ?? 50, 1), 200);
  const cursor = Math.max(body?.cursor ?? 0, 0);

  const { resolvePrimaryEntityId } = await import('../lib/embedding');

  const candidates = await env.D1.prepare(
    `SELECT vei.vector_id, vei.entity_id, c.id AS conv_id, c.source AS conv_source,
            c.from_contact_id, c.from_email
       FROM vector_entity_index vei
       JOIN conversations c ON c.id = vei.entity_id AND c.org_id = vei.org_id
       WHERE vei.org_id = ? AND vei.source_table = 'conversations'
       ORDER BY vei.vector_id LIMIT ? OFFSET ?`
  ).bind(ctx.orgId, limit, cursor).all<{
    vector_id: string; entity_id: string; conv_id: string; conv_source: string;
    from_contact_id: string | null; from_email: string | null;
  }>();

  const totalScanned = candidates.results.length;
  let updated = 0;
  let alreadyCorrect = 0;
  let notInVectorize = 0;
  const errors: string[] = [];

  // Cache org users (one round-trip)
  const userRows = await env.D1.prepare(
    `SELECT email FROM users WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(ctx.orgId).all<{ email: string }>();
  const internalEmails = new Set<string>();
  for (const u of userRows.results) {
    if (u.email) internalEmails.add(u.email.toLowerCase());
  }

  // Cache to-contact lookups per conv_id within this batch
  const convIds = [...new Set(candidates.results.map(r => r.conv_id))];
  const toContactsByConv = new Map<string, string[]>();
  if (convIds.length > 0) {
    const placeholders = convIds.map(() => '?').join(',');
    const tcRows = await env.D1.prepare(
      `SELECT conversation_id, contact_id, role FROM conversation_contacts
         WHERE conversation_id IN (${placeholders}) AND role IN ('to','cc')
         ORDER BY role = 'to' DESC`
    ).bind(...convIds).all<{ conversation_id: string; contact_id: string; role: string }>();
    for (const r of tcRows.results) {
      const arr = toContactsByConv.get(r.conversation_id) || [];
      arr.push(r.contact_id);
      toContactsByConv.set(r.conversation_id, arr);
    }
  }

  // Batch the Vectorize round-trips. getByIds is capped at 20 IDs per call
  // (VECTOR_GET_ERROR 40007); we chunk candidates into windows of 20 and run
  // them in parallel. upsert tolerates much larger batches (~1000) so we send
  // one upsert at the end. Net: 50-vector batch → 3 parallel GETs + 1 UPSERT,
  // versus 50 sequential GETs + ~30 sequential UPSERTs in the prior code.
  const VEC_GET_MAX = 20;
  const candidateIds = candidates.results.map(r => r.vector_id);
  const idChunks: string[][] = [];
  for (let i = 0; i < candidateIds.length; i += VEC_GET_MAX) {
    idChunks.push(candidateIds.slice(i, i + VEC_GET_MAX));
  }
  const existingMap = new Map<string, { values: number[]; metadata: any }>();
  const getResults = await Promise.allSettled(
    idChunks.map(ids => env.VECTORIZE.getByIds(ids))
  );
  for (const r of getResults) {
    if (r.status === 'fulfilled') {
      for (const v of r.value) {
        existingMap.set(v.id, { values: v.values as number[], metadata: v.metadata || {} });
      }
    } else {
      errors.push(`getByIds_chunk: ${r.reason?.message || String(r.reason)}`);
    }
  }

  const toUpsert: Array<{ id: string; values: number[]; metadata: any }> = [];

  for (const row of candidates.results) {
    const existing = existingMap.get(row.vector_id);
    if (!existing) { notInVectorize++; continue; }

    const meta: any = existing.metadata;
    const docType = meta.document_type || 'email';

    const correctPrimary = resolvePrimaryEntityId({
      document_type: docType,
      source: row.conv_source,
      source_id: row.conv_id,
      from_contact_id: row.from_contact_id,
      from_email: row.from_email,
      to_contact_ids: toContactsByConv.get(row.conv_id) || [],
      internal_user_emails: internalEmails,
    });

    if (meta.primary_entity_id === correctPrimary) {
      alreadyCorrect++;
      continue;
    }

    toUpsert.push({
      id: row.vector_id,
      values: existing.values,
      metadata: { ...meta, primary_entity_id: correctPrimary },
    });
  }

  if (toUpsert.length > 0) {
    try {
      await env.VECTORIZE.upsert(toUpsert);
      updated = toUpsert.length;
    } catch (err: any) {
      // On batch upsert failure, fall back to per-vector upsert so we know
      // which one(s) caused the issue and don't lose the whole batch.
      errors.push(`upsert_batch: ${err?.message || String(err)} (falling back per-vector)`);
      for (const v of toUpsert) {
        try {
          await env.VECTORIZE.upsert([v]);
          updated++;
        } catch (perErr: any) {
          errors.push(`${v.id}: ${perErr?.message || String(perErr)}`);
        }
      }
    }
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'integration',
    entity_id: `recompute_primary_entity:cursor=${cursor}`,
    metadata: { scanned: totalScanned, updated, already_correct: alreadyCorrect, not_in_vectorize: notInVectorize, errors_count: errors.length },
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    scanned: totalScanned,
    updated,
    already_correct: alreadyCorrect,
    not_in_vectorize: notInVectorize,
    errors,
    next_cursor: totalScanned === limit ? cursor + limit : null,
  });
}

// Re-embed transcripts using the now-wired speaker-turn chunker. Walks events
// rows that have a transcript_r2_key, deletes existing vectors, then re-runs
// chunkEmbedAndPersistAll which will detect transcript content and use the
// speaker-turn splitter. Bounded to 10 transcripts per batch — each transcript
// can produce ~15 chunks, each requiring a BGE call.
export async function reembedTranscripts(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ limit?: number; cursor?: number }>(request);
  const limit = Math.min(Math.max(body?.limit ?? 10, 1), 30);
  const cursor = Math.max(body?.cursor ?? 0, 0);

  const { chunkEmbedAndPersistAll } = await import('../lib/embedding');

  const events = await env.D1.prepare(
    `SELECT id, title, summary, transcript_r2_key, start_time
       FROM events WHERE org_id = ? AND deleted_at IS NULL AND transcript_r2_key IS NOT NULL
       ORDER BY id LIMIT ? OFFSET ?`
  ).bind(ctx.orgId, limit, cursor).all<{
    id: string; title: string; summary: string | null;
    transcript_r2_key: string; start_time: string;
  }>();

  const stats = { scanned: 0, reembedded: 0, missing_r2: 0, errors: 0 };
  const errorList: string[] = [];

  for (const ev of events.results) {
    stats.scanned++;
    try {
      // Delete prior vectors for this event
      const existing = await env.D1.prepare(
        `SELECT vector_id FROM vector_entity_index WHERE entity_id = ? AND source_table = 'events' AND org_id = ?`
      ).bind(ev.id, ctx.orgId).all<{ vector_id: string }>();
      if (existing.results.length > 0) {
        const ids = existing.results.map(r => r.vector_id);
        await env.VECTORIZE.deleteByIds(ids).catch(() => {});
        const placeholders = ids.map(() => '?').join(',');
        await env.D1.prepare(
          `DELETE FROM vector_entity_index WHERE vector_id IN (${placeholders})`
        ).bind(...ids).run();
        await Promise.all(ids.map(id => env.KV.delete(`chunk:${id}`).catch(() => {})));
      }

      const obj = await env.R2.get(ev.transcript_r2_key);
      if (!obj) { stats.missing_r2++; continue; }
      const text = await obj.text();
      if (!text || text.trim().length < 10) { stats.missing_r2++; continue; }

      const entries = await chunkEmbedAndPersistAll(text, {
        org_id: ctx.orgId,
        visibility: 'org_wide',
        document_type: 'transcript',
        source_table: 'events',
        source_id: ev.id,
        r2_key: ev.transcript_r2_key,
        created_at: ev.start_time,
        primary_entity_id: ev.id,
        entity_name: ev.title,
        date: ev.start_time,
      }, env);

      if (entries.length > 0) {
        await env.D1.batch(entries.map(e =>
          env.D1.prepare(
            'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
          ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
        ));
        stats.reembedded++;
      }
    } catch (err: any) {
      stats.errors++;
      errorList.push(`${ev.id}: ${err?.message || String(err)}`);
    }
  }

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'update',
    entity_type: 'integration',
    entity_id: `reembed_transcripts:cursor=${cursor}`,
    metadata: stats,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ...stats,
    errors_list: errorList,
    next_cursor: stats.scanned === limit ? cursor + limit : null,
  });
}

// Backfill all deals into Vectorize. Pages through deals, calls embedDeal on
// each. Idempotent — embedDeal's chunkEmbedAndPersistAll dedup guard skips
// already-embedded deals.
export async function embedAllDeals(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const body = await parseJsonBody<{ limit?: number; cursor?: number }>(request);
  const limit = Math.min(Math.max(body?.limit ?? 25, 1), 100);
  const cursor = Math.max(body?.cursor ?? 0, 0);

  const { embedDeal } = await import('../lib/embedding');

  const deals = await env.D1.prepare(
    `SELECT id FROM deals WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY id LIMIT ? OFFSET ?`
  ).bind(ctx.orgId, limit, cursor).all<{ id: string }>();

  const stats = { scanned: 0, embedded: 0, skipped: 0, missing: 0, errors: 0 };
  const errorList: string[] = [];

  for (const d of deals.results) {
    stats.scanned++;
    try {
      const r = await embedDeal(d.id, ctx.orgId, env);
      if (r === 'embedded') stats.embedded++;
      else if (r === 'skipped') stats.skipped++;
      else if (r === 'missing') stats.missing++;
    } catch (err: any) {
      stats.errors++;
      errorList.push(`${d.id}: ${err?.message || String(err)}`);
    }
  }

  return jsonResponse({
    ...stats,
    errors_list: errorList,
    next_cursor: stats.scanned === limit ? cursor + limit : null,
  });
}

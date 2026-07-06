// Phase 8 (2026-05-06) — pipelines Worker entry point.
//
// This Worker handles all background ingestion + enrichment +
// work_queue handlers + workflow orchestration + audit queue
// consumption. User-facing API surface stays on the api Worker.
//
// Re-exports the 6 Workflow classes so the pipelines Worker owns
// their runtime execution after this deploy. Imports handleScheduled
// + handleQueue from src/index.ts (where they live as named exports
// alongside api's handleRequest); esbuild tree-shakes api-only paths
// like handleRequest from this bundle since we don't reference the
// default export.
//
// /health endpoint pings each binding type so a single curl confirms
// the Worker can reach D1, R2, KV, Vectorize, AI in one request.
// Used for Phase 1 verification (T2 runs against deployed pipelines).
//
// Webhook intake (`/webhooks/firefly`, `/slack`, `/outlook-mail`)
// stays on api Worker for this session; deferred to Stage 4
// (Session B) when external services get URL coordination.

import type { Env } from './types/env';
import type { AuditEvent } from './types/audit';
import type { WebhookQueueMessage } from './types/webhooks';
import { WorkerEntrypoint } from 'cloudflare:workers';

// Workflow class re-exports — declares pipelines as the runtime owner
// of these Workflow names. wrangler.pipelines.toml declares the
// matching [[workflows]] entries; CF binds the workflow name to this
// Worker's class implementations on deploy.
export { IngestionWorkflow } from './workflows/ingestion';
export { IngestionChunkWorkflow } from './workflows/ingestion-chunk';
export { IngestionFinalizerWorkflow } from './workflows/ingestion-finalizer';
export { EnrichmentWorkflow } from './workflows/enrichment';
export { CampaignSendWorkflow } from './workflows/campaign-send';
export { DailyCronWorkflow } from './workflows/daily-cron';
export { D1BackupWorkflow } from './workflows/d1-backup';

// Scheduled + queue handlers shared with api — Phase 8 added `export`
// to both so this entry point can dispatch the same code paths. The
// overlap window between pipelines deploy and api redeploy means both
// Workers run handleScheduled; work_queue claim arbitration covers
// the handlers, non-arbitrated paths (workflow create, daily cron)
// double-fire as accepted overhead.
import { handleScheduled, handleQueue } from './index';

export class PipelinesEntrypoint extends WorkerEntrypoint<Env> {
  async triggerWorkflow(input: {
    workflow: 'ingestion' | 'enrichment' | 'campaign';
    id?: string;
    params?: unknown;
  }): Promise<{ id: string }> {
    const binding =
      input.workflow === 'ingestion' ? this.env.INGESTION_WORKFLOW :
      input.workflow === 'enrichment' ? this.env.ENRICHMENT_WORKFLOW :
      this.env.CAMPAIGN_WORKFLOW;

    if (!binding) {
      throw new Error(`WORKFLOW_BINDING_MISSING:${input.workflow}`);
    }

    const instance = await binding.create({
      id: input.id,
      params: input.params,
    });
    return { id: instance.id };
  }
}

// /health endpoint — ping each binding type. Single curl test for
// Phase 1 verification.
async function handleHealth(env: Env): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  const startedAt = Date.now();

  // D1: SELECT 1 round-trip
  try {
    const r = await env.D1.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    checks.d1 = { ok: r?.ok === 1 };
  } catch (e) {
    checks.d1 = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // R2: HEAD on a known bucket key (or list with limit 1). list() is
  // safest since we don't know what keys exist; returns empty array
  // even if bucket is empty. Truncated to 1 result minimum cost.
  try {
    const list = await env.R2.list({ limit: 1 });
    checks.r2 = { ok: list !== null && Array.isArray(list.objects) };
  } catch (e) {
    checks.r2 = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // KV: get on a sentinel key. Return null is fine; we just need the
  // round-trip not to throw.
  try {
    await env.KV.get('phase8-health-sentinel');
    checks.kv = { ok: true };
  } catch (e) {
    checks.kv = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // Vectorize: describeIndex returns metadata about the index. Cheap.
  try {
    const desc = await env.VECTORIZE.describe();
    checks.vectorize = { ok: !!desc };
  } catch (e) {
    checks.vectorize = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // AI: cheap call — request the smallest possible inference. BGE
  // m3-multilingual is what we use elsewhere; embedding a single short
  // string is the cheapest verification.
  try {
    const r = (await env.AI.run('@cf/baai/bge-m3', { text: ['ping'] })) as {
      data?: number[][];
    };
    checks.ai = { ok: Array.isArray(r?.data) && r.data.length > 0 };
  } catch (e) {
    checks.ai = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const allOk = Object.values(checks).every(c => c.ok);
  const elapsedMs = Date.now() - startedAt;

  return new Response(
    JSON.stringify({
      ok: allOk,
      worker: 'medina-ventures-pipelines',
      env: env.ENVIRONMENT,
      elapsed_ms: elapsedMs,
      checks,
    }, null, 2),
    {
      status: allOk ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// --- Worker export ---
//
// fetch:    only /health (no user-facing routes on pipelines)
// scheduled: shared handleScheduled — runs all crons (hourly +
//            minute, including daily-cron gate at 02:10 UTC)
// queue:    shared handleQueue — handles audit-log-queue +
//            audit-log-dlq. Webhook queues NOT declared on pipelines
//            this session; Stage 4 (Session B) wires them.

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctxExec: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return handleHealth(env);
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'NOT_FOUND',
        worker: 'medina-ventures-pipelines',
        hint: 'pipelines Worker has no public routes; user-facing API is on medina-ventures-api',
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctxExec: ExecutionContext
  ): Promise<void> {
    return handleScheduled(event, env, ctxExec);
  },

  async queue(
    batch: MessageBatch<AuditEvent | WebhookQueueMessage>,
    env: Env
  ): Promise<void> {
    return handleQueue(batch, env);
  },
};

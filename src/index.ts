// Medina Ventures Intelligence Platform — main Worker entry
// TRD §2.2, §7.1, §17

import type { Env } from './types/env';
import type { AuthContext } from './types/interfaces';
import type { AuditEvent } from './types/audit';
import type { WebhookQueueMessage } from './types/webhooks';

import { requireAuth, requireRole } from './handlers/auth';
import { isTokenRevoked } from './handlers/auth-login';
import * as AuthLogin from './handlers/auth-login';
import { jsonResponse, errorResponse } from './handlers/utils';

import * as Contacts from './handlers/contacts';
import * as Companies from './handlers/companies';
import * as Deals from './handlers/deals';
import * as Events from './handlers/events';
import * as Conversations from './handlers/conversations';
import * as Tags from './handlers/tags';
import * as Tasks from './handlers/tasks';
import * as Documents from './handlers/documents';
import * as Approval from './handlers/approval';
import * as Observations from './handlers/observations';
import * as Sync from './handlers/sync';
import * as AuditLog from './handlers/audit-log';
import * as Admin from './handlers/admin';
import * as Cleanup from './handlers/cleanup';
import * as D1Maintenance from './handlers/d1-maintenance';
import { sweepApprovalQueue } from './handlers/sweep-approval-queue';
import * as Imports from './handlers/imports';
import * as IntelligentImport from './handlers/intelligent-import';
import * as Campaigns from './handlers/campaigns';
import * as Agent from './handlers/agent';
import * as DeckArtifacts from './handlers/deck-artifacts';
import * as ChatUploads from './handlers/chat-uploads';
import * as Webhooks from './handlers/webhooks';
import * as AuthOAuth from './handlers/auth-oauth';
import * as Users from './handlers/users';
import * as Integrations from './handlers/integrations';
import * as SystemStatusHandler from './handlers/system-status';
import * as Backfill from './handlers/backfill';
import * as FireflyCredentials from './handlers/firefly-credentials';
import * as MartyLab from './handlers/marty-lab';

import { handleAuditBatch } from './workers/audit-consumer';
import { handleWebhookBatch } from './workers/webhook-consumer';
import { handleDlqBatch, handleAuditDlqBatch } from './workers/dlq-consumer';

import { runDailyCron } from './lib/daily-cron';

// Phase 8 strip (2026-05-06): 6 Workflow class re-exports removed
// from api Worker. Class ownership lives on medina-ventures-pipelines
// (src/pipelines-index.ts re-exports from src/workflows/*.ts). The
// workflow class definition files themselves stay untouched —
// pipelines imports them, api just stops claiming ownership.
//
// Tomorrow's follow-up: add `[[services]] PIPELINES` service binding
// to wrangler.toml + refactor admin.ts:465, admin.ts:543,
// campaigns.ts:141 to trigger workflows via service binding instead
// of direct env.<WORKFLOW>.create() (those bindings no longer exist
// on api after this strip).

// --- CORS helpers ---

const DEFAULT_ORIGINS = ['http://localhost:3000'];

function getAllowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  return DEFAULT_ORIGINS;
}

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allowed = getAllowedOrigins(env);
  const resolved = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': resolved,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(res: Response, origin: string, env: Env): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin, env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

// --- Router ---

async function handleRequest(
  request: Request,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const reqOrigin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(reqOrigin, env) });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // --- Public routes ---
  if (path === '/' && method === 'GET') {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Medina Ventures API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    code { background: #f4f4f4; padding: 0.15em 0.4em; border-radius: 4px; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <h1>Medina Ventures API</h1>
  <p>This URL is the Cloudflare Worker API. There is no web app at the root path.</p>
  <ul>
    <li><a href="/health"><code>GET /health</code></a> — liveness check (JSON)</li>
    <li>Authenticated routes use <code>Authorization: Bearer &lt;JWT&gt;</code> under <code>/api/…</code></li>
  </ul>
</body>
</html>`;
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (path === '/favicon.ico' && method === 'GET') {
    return new Response(null, { status: 204 });
  }

  if (path === '/health') return jsonResponse({
    ok: true,
    env: env.ENVIRONMENT,
    build: {
      git_sha: env.MEDINA_BUILD_SHA || env.MARTY_RUNTIME_GIT_SHA || 'unknown',
      fireflies_pipeline_version: env.FIREFLIES_PIPELINE_VERSION || 'unknown',
    },
  });

  if (path === '/internal/firefly-credential' && method === 'POST') {
    return FireflyCredentials.getInternalFireflyCredential(request, env);
  }

  if (path === '/internal/work-queue-tick' && method === 'POST') {
    const expected = env.PIPELINES_INTERNAL_TOKEN;
    const supplied = request.headers.get('X-Medina-Internal-Token');
    if (!expected || supplied !== expected) {
      return errorResponse('AUTH_FORBIDDEN', 403, 'internal token required');
    }

    const { processWorkQueueTick } = await import('./lib/work-queue-driver');
    const result = await processWorkQueueTick(env);
    return jsonResponse({ ok: true, result });
  }

  if (path === '/internal/firefly-window-tick' && method === 'POST') {
    const expected = env.PIPELINES_INTERNAL_TOKEN;
    const supplied = request.headers.get('X-Medina-Internal-Token');
    if (!expected || supplied !== expected) {
      return errorResponse('AUTH_FORBIDDEN', 403, 'internal token required');
    }

    const requestedLimit = Number(url.searchParams.get('limit') || '2');
    const limit = Math.min(Math.max(Math.floor(requestedLimit) || 2, 1), 6);
    const { claimNextBatch, getOpenCircuits, sweepStaleClaims } = await import('./lib/work-queue');
    const { processClaimedWorkItem } = await import('./lib/work-queue-driver');
    const { fireflyWindowHandler } = await import('./lib/work-queue-handlers/firefly-window');
    const swept = await sweepStaleClaims(env);
    const openCircuits = await getOpenCircuits(env).catch(() => []);
    const claimed = await claimNextBatch(env, 'firefly_window', limit, openCircuits);
    const results = await Promise.all(
      claimed.map(item => processClaimedWorkItem(env, fireflyWindowHandler, item))
    );
    return jsonResponse({
      ok: true,
      swept,
      open_circuits: openCircuits,
      claimed: claimed.length,
      completed: results.filter(r => r.completed).length,
      failed: results.filter(r => r.failed).length,
      errors: results.map((r, i) => r.error ? {
        work_queue_id: claimed[i]?.id ?? null,
        error: r.error,
      } : null).filter(Boolean),
    });
  }

  if (path === '/internal/firefly-window-repair' && method === 'POST') {
    const expected = env.PIPELINES_INTERNAL_TOKEN;
    const supplied = request.headers.get('X-Medina-Internal-Token');
    if (!expected || supplied !== expected) {
      return errorResponse('AUTH_FORBIDDEN', 403, 'internal token required');
    }

    const body = await request.json().catch(() => null) as {
      parent_id?: string;
      window_index?: number;
      initial_skip?: number;
    } | null;
    const parentId = body?.parent_id?.trim();
    const windowIndex = Number(body?.window_index);
    const initialSkip = Math.max(0, Math.floor(Number(body?.initial_skip) || 0));
    if (!parentId || !Number.isFinite(windowIndex)) {
      return errorResponse('VALIDATION_ERROR', 400, 'parent_id and window_index are required');
    }

    const window = await env.D1.prepare(
      `SELECT j.org_id, j.user_id, w.start_date, w.end_date
         FROM firefly_progressive_backfill_jobs j
         JOIN firefly_progressive_backfill_windows w
           ON w.parent_id = j.id
        WHERE j.id = ? AND w.window_index = ?`
    ).bind(parentId, windowIndex).first<{
      org_id: string;
      user_id: string;
      start_date: string;
      end_date: string;
    }>();
    if (!window) {
      return errorResponse('NOT_FOUND', 404, 'firefly window not found');
    }

    const { getFireflyKey } = await import('./lib/firefly-credentials');
    const apiKey = await getFireflyKey(window.user_id, env);
    if (!apiKey) {
      return errorResponse('NOT_FOUND', 404, 'no usable Fireflies credential');
    }

    const { runFireflyWindowBackfill } = await import('./lib/firefly-ingest');
    const result = await runFireflyWindowBackfill({
      userId: window.user_id,
      orgId: window.org_id,
      fireflyApiKey: apiKey,
      startDate: window.start_date,
      endDate: window.end_date,
      initialSkip,
      progressiveWindowId: `repair:${parentId}:${windowIndex}:${initialSkip}`,
      runId: parentId,
    }, env);

    await env.D1.prepare(
      `UPDATE firefly_transcript_runs
          SET source_transcripts = source_transcripts + ?,
              r2_staged = r2_staged + ?,
              linked_events = linked_events + ?,
              standalone_transcripts = standalone_transcripts + ?,
              embedding_queued = embedding_queued + ?,
              prospect_queued = prospect_queued + ?,
              error_count = error_count + ?,
              last_error = COALESCE(?, last_error),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(
      result.total_processed,
      result.r2_staged,
      result.linked_events,
      result.standalone_transcripts,
      result.embedding_queued,
      result.prospect_queued,
      result.failed,
      result.reason || null,
      parentId
    ).run();

    return jsonResponse({ ok: true, result });
  }

if (path === '/webhooks/firefly' && method === 'POST') {
    return Webhooks.receiveFireflyWebhook(request, env);
  }
  if (path === '/webhooks/slack' && method === 'POST') {
    return Webhooks.receiveSlackWebhook(request, env);
  }
  if (path === '/webhooks/outlook-mail' && (method === 'POST' || method === 'GET')) {
    return Webhooks.receiveOutlookMailWebhook(request, env, ctxExec);
  }

  if (path === '/auth/outlook/callback' && method === 'GET') {
    return AuthOAuth.outlookOAuthCallback(request, env);
  }
  if (path === '/auth/outlook' && method === 'GET') {
    return AuthOAuth.outlookOAuthStart(request, env);
  }

  // --- Public auth endpoints ---
  if (path === '/api/auth/login' && method === 'POST') {
    return withCors(await AuthLogin.login(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/register' && method === 'POST') {
    return withCors(await AuthLogin.register(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/signup' && method === 'POST') {
    return withCors(await AuthLogin.signup(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/mfa/verify' && method === 'POST') {
    // Authenticated by short-lived purpose='mfa_challenge' JWT, not the session JWT.
    return withCors(await AuthLogin.mfaVerify(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/set-initial-password' && method === 'POST') {
    return withCors(await AuthLogin.setInitialPassword(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/verify' && method === 'GET') {
    return withCors(await AuthLogin.verifyEmail(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/resend-verification' && method === 'POST') {
    return withCors(await AuthLogin.resendVerification(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/forgot-password' && method === 'POST') {
    return withCors(await AuthLogin.forgotPassword(request, env), reqOrigin, env);
  }
  if (path === '/api/auth/reset-password' && method === 'POST') {
    return withCors(await AuthLogin.resetPassword(request, env), reqOrigin, env);
  }
  if (path === '/api/internal/deck-render-complete' && method === 'POST') {
    return withCors(await DeckArtifacts.internalDeckRenderComplete(request, env), reqOrigin, env);
  }

  // --- Authenticated routes ---
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const ctx = authResult;

  // Check token revocation. Mirrors requireAuth: header preferred, ?token= fallback
  // so the revocation check applies to browser-initiated GETs (e.g. <img> avatars) too.
  const authHeader = request.headers.get('Authorization') || '';
  let rawToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!rawToken) rawToken = url.searchParams.get('token') || '';
  if (rawToken) {
    const revoked = await isTokenRevoked(rawToken, env);
    if (revoked) {
      return new Response(
        JSON.stringify({ error: 'AUTH_TOKEN_REVOKED' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  return routeAuthenticated(path, method, url, request, ctx, env, ctxExec);
}

async function routeAuthenticated(
  path: string,
  method: string,
  url: URL,
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  // --- Auth (authenticated) ---
  if (path === '/api/auth/logout' && method === 'POST') {
    return AuthLogin.logout(request, ctx, env);
  }
  if (path === '/api/auth/me' && method === 'GET') {
    return AuthLogin.me(ctx, env);
  }

  // --- Users (self-service profile) ---
  if (path === '/api/users/me' && method === 'PATCH') {
    return Users.updateMyProfile(request, ctx, env);
  }
  if (path === '/api/users/me/avatar' && method === 'POST') {
    return Users.uploadMyAvatar(request, ctx, env);
  }
  if (path === '/api/users/me/avatar' && method === 'GET') {
    return Users.getAvatar(request, ctx, env);
  }
  if (path === '/api/users/me/change-password' && method === 'POST') {
    return AuthLogin.changePassword(request, ctx, env);
  }
  if (path === '/api/auth/mfa/status' && method === 'GET') {
    return AuthLogin.mfaStatus(ctx, env);
  }
  if (path === '/api/auth/mfa/enroll/start' && method === 'POST') {
    return AuthLogin.mfaEnrollStart(ctx, env);
  }
  if (path === '/api/auth/mfa/enroll/confirm' && method === 'POST') {
    return AuthLogin.mfaEnrollConfirm(request, ctx, env);
  }
  if (path === '/api/auth/mfa/disable' && method === 'POST') {
    return AuthLogin.mfaDisable(request, ctx, env);
  }
  if (path === '/api/users/me/sessions' && method === 'GET') {
    return AuthLogin.listMySessions(request, ctx, env);
  }
  if (path === '/api/users/me/sessions/logout-all' && method === 'POST') {
    return AuthLogin.revokeAllOtherSessions(request, ctx, env);
  }
  const sessionMatch = path.match(/^\/api\/users\/me\/sessions\/([^/]+)$/);
  if (sessionMatch && method === 'DELETE') return AuthLogin.revokeMySession(sessionMatch[1], ctx, env);

  // --- Contacts ---
  if (path === '/api/contacts') {
    if (method === 'GET') return Contacts.listContacts(request, ctx, env);
    if (method === 'POST') return Contacts.createContact(request, ctx, env, ctxExec);
  }
  if (path === '/api/contacts/filter-counts' && method === 'GET') {
    return Contacts.getContactFilterCounts(ctx, env);
  }
  if (path === '/api/contacts/companies' && method === 'GET') {
    return Contacts.listContactCompanies(ctx, env);
  }
  if (path === '/api/contacts/merge' && method === 'POST') {
    return Contacts.postContactMerge(request, ctx, env);
  }
  let m = path.match(/^\/api\/contacts\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') return Contacts.getContact(id, ctx, env, ctxExec);
    if (method === 'PATCH') return Contacts.updateContact(request, id, ctx, env);
    if (method === 'DELETE') return Contacts.deleteContact(id, ctx, env);
  }
  m = path.match(/^\/api\/contacts\/([^/]+)\/tags$/);
  if (m && method === 'POST') return Contacts.applyContactTags(request, m[1], ctx, env);
  m = path.match(/^\/api\/contacts\/([^/]+)\/tags\/([^/]+)$/);
  if (m && method === 'DELETE') return Contacts.removeContactTag(m[1], m[2], ctx, env);
  m = path.match(/^\/api\/contacts\/([^/]+)\/timeline$/);
  if (m && method === 'GET') return Contacts.getContactTimeline(request, m[1], ctx, env);
  m = path.match(/^\/api\/contacts\/([^/]+)\/associations$/);
  if (m && method === 'GET') return Contacts.getContactAssociations(m[1], ctx, env);
  m = path.match(/^\/api\/contacts\/([^/]+)\/pending-updates$/);
  if (m && method === 'GET') return Approval.getPendingUpdates('contact', m[1], ctx, env);
  m = path.match(/^\/api\/contacts\/([^/]+)\/enrich$/);
  if (m && method === 'POST') return Contacts.enrichContactEndpoint(m[1], ctx, env, ctxExec);
  m = path.match(/^\/api\/contacts\/([^/]+)\/enrichment$/);
  if (m && method === 'GET') return Contacts.getContactEnrichment(m[1], ctx, env);

  // --- Companies ---
  if (path === '/api/companies/filter-counts' && method === 'GET') {
    return Companies.getCompanyFilterCounts(ctx, env);
  }
  if (path === '/api/companies/cities' && method === 'GET') {
    return Companies.listCompanyCities(ctx, env);
  }
  if (path === '/api/companies') {
    if (method === 'GET') return Companies.listCompanies(request, ctx, env);
    if (method === 'POST') return Companies.createCompany(request, ctx, env, ctxExec);
  }
  m = path.match(/^\/api\/companies\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') return Companies.getCompany(id, ctx, env);
    if (method === 'PATCH') return Companies.updateCompany(request, id, ctx, env);
    if (method === 'DELETE') return Companies.deleteCompany(id, ctx, env);
  }
  m = path.match(/^\/api\/companies\/([^/]+)\/news$/);
  if (m && method === 'GET') return Companies.getCompanyNews(m[1], ctx, env);
  m = path.match(/^\/api\/companies\/([^/]+)\/tags$/);
  if (m && method === 'POST') return Companies.applyCompanyTags(request, m[1], ctx, env);
  m = path.match(/^\/api\/companies\/([^/]+)\/tags\/([^/]+)$/);
  if (m && method === 'DELETE') return Companies.removeCompanyTag(m[1], m[2], ctx, env);
  m = path.match(/^\/api\/companies\/([^/]+)\/associations$/);
  if (m && method === 'GET') return Companies.getCompanyAssociations(m[1], ctx, env);
  m = path.match(/^\/api\/companies\/([^/]+)\/enrich$/);
  if (m && method === 'POST') return Companies.enrichCompanyEndpoint(m[1], ctx, env, ctxExec);
  m = path.match(/^\/api\/companies\/([^/]+)\/enrichment$/);
  if (m && method === 'GET') return Companies.getCompanyEnrichment(m[1], ctx, env);

  // --- Deals ---
  if (path === '/api/deals/metrics' && method === 'GET')
    return Deals.getDealMetrics(ctx, env);
  if (path === '/api/deals') {
    if (method === 'GET') return Deals.listDeals(request, ctx, env);
    if (method === 'POST') return Deals.createDeal(request, ctx, env);
  }
  // Day-5 Phase C bulk operations endpoint. Note: registered before the
  // /api/deals/:id pattern below since '/bulk-update' would otherwise be
  // captured as a single-deal id.
  if (path === '/api/deals/bulk-update' && method === 'POST') {
    return Deals.bulkUpdateDeals(request, ctx, env);
  }
  if (path === '/api/deals/detected' && method === 'GET') {
    return Deals.listDetectedDealCandidates(request, ctx, env);
  }
  if (path === '/api/deals/detected/promote' && method === 'POST') {
    return Deals.promoteDetectedDeal(request, ctx, env);
  }
  if (path === '/api/deals/replay/start' && method === 'POST') {
    return Deals.startDealReplay(request, ctx, env);
  }
  if (path === '/api/deals/replay/status' && method === 'GET') {
    return Deals.getDealReplayStatus(ctx, env);
  }
  if (path === '/api/deals/replay/evidence' && method === 'GET') {
    return Deals.getDealReplayEvidence(request, ctx, env);
  }
  if (path === '/api/deals/replay/cancel' && method === 'POST') {
    return Deals.cancelDealReplay(ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/associations$/);
  if (m && method === 'GET') return Deals.getDealAssociations(m[1], ctx, env);
  m = path.match(/^\/api\/deals\/([^/]+)\/timeline$/);
  if (m && method === 'GET') return Deals.getDealTimeline(request, m[1], ctx, env);
  m = path.match(/^\/api\/deals\/([^/]+)\/conversations$/);
  if (m && method === 'GET') return Deals.getDealConversations(request, m[1], ctx, env);
  m = path.match(/^\/api\/deals\/([^/]+)\/intelligence$/);
  if (m && method === 'GET') return Deals.getDealIntelligence(m[1], ctx, env, ctxExec);

  // Phase F — evidence trail (read) + manual link/unlink (write).
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence$/);
  if (m && method === 'GET') {
    const { getDealEvidence } = await import('./handlers/deal-evidence');
    return getDealEvidence(m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/candidates$/);
  if (m && method === 'GET') {
    const { getDealEvidenceCandidates } = await import('./handlers/deal-evidence');
    return getDealEvidenceCandidates(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/conversation\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const { unlinkConversationFromDeal } = await import('./handlers/deal-evidence-manual');
    return unlinkConversationFromDeal(m[1], m[2], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/conversation$/);
  if (m && method === 'POST') {
    const { linkConversationToDealEndpoint } = await import('./handlers/deal-evidence-manual');
    return linkConversationToDealEndpoint(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/event\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const { unlinkEventFromDeal } = await import('./handlers/deal-evidence-manual');
    return unlinkEventFromDeal(m[1], m[2], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/event$/);
  if (m && method === 'POST') {
    const { linkEventToDealEndpoint } = await import('./handlers/deal-evidence-manual');
    return linkEventToDealEndpoint(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/slack-channel\/([^/]+)$/);
  if (m && method === 'DELETE') {
    const { unlinkSlackChannelFromDeal } = await import('./handlers/deal-evidence-manual');
    return unlinkSlackChannelFromDeal(m[1], m[2], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/evidence\/slack-channel$/);
  if (m && method === 'POST') {
    const { linkSlackChannelToDealEndpoint } = await import('./handlers/deal-evidence-manual');
    return linkSlackChannelToDealEndpoint(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/contacts\/([^/]+)$/);
  if (m && method === 'DELETE') return Deals.removeDealContact(m[1], m[2], ctx, env);
  m = path.match(/^\/api\/deals\/([^/]+)\/contacts$/);
  if (m) {
    if (method === 'GET') return Deals.listDealContacts(m[1], ctx, env);
    if (method === 'POST') return Deals.addDealContact(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/action-items\/([^/]+)$/);
  if (m) {
    if (method === 'PATCH') return Deals.updateDealActionItem(request, m[1], m[2], ctx, env);
    if (method === 'DELETE') return Deals.deleteDealActionItem(m[1], m[2], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/action-items$/);
  if (m) {
    if (method === 'GET') return Deals.listDealActionItems(m[1], ctx, env);
    if (method === 'POST') return Deals.createDealActionItem(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/notes\/([^/]+)$/);
  if (m) {
    if (method === 'PATCH') return Deals.updateDealNote(request, m[1], m[2], ctx, env);
    if (method === 'DELETE') return Deals.deleteDealNote(m[1], m[2], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)\/notes$/);
  if (m) {
    if (method === 'GET') return Deals.listDealNotes(m[1], ctx, env);
    if (method === 'POST') return Deals.createDealNote(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/deals\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') return Deals.getDeal(id, ctx, env);
    if (method === 'PATCH') return Deals.updateDeal(request, id, ctx, env);
    if (method === 'DELETE') return Deals.deleteDeal(id, ctx, env);
  }

  // --- Events ---
  if (path === '/api/events' && method === 'GET') {
    return Events.listEvents(request, ctx, env);
  }
  m = path.match(/^\/api\/events\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') return Events.getEvent(id, ctx, env);
    if (method === 'PATCH') return Events.updateEvent(request, id, ctx, env);
  }
  m = path.match(/^\/api\/events\/([^/]+)\/link-outlook$/);
  if (m && method === 'POST') return Events.linkEventToOutlook(request, m[1], ctx, env);

  // --- Conversations ---
  if (path === '/api/conversations' && method === 'GET') {
    return Conversations.listConversations(request, ctx, env);
  }
  m = path.match(/^\/api\/conversations\/([^/]+)\/thread$/);
  if (m && method === 'GET') return Conversations.getConversationThread(m[1], ctx, env);
  m = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (m && method === 'GET') return Conversations.getConversation(m[1], ctx, env);

  // --- Tags ---
  if (path === '/api/tags') {
    if (method === 'GET') return Tags.listTags(request, ctx, env);
    if (method === 'POST') return Tags.createTag(request, ctx, env);
  }
  m = path.match(/^\/api\/tags\/([^/]+)$/);
  if (m) {
    if (method === 'PATCH') return Tags.updateTag(request, m[1], ctx, env);
    if (method === 'DELETE') return Tags.deleteTag(m[1], ctx, env);
  }

  // --- Tasks ---
  if (path === '/api/tasks') {
    if (method === 'GET') return Tasks.listTasks(request, ctx, env);
    if (method === 'POST') return Tasks.createTask(request, ctx, env);
  }
  m = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (m) {
    if (method === 'PATCH') return Tasks.updateTask(request, m[1], ctx, env);
    if (method === 'DELETE') return Tasks.deleteTask(m[1], ctx, env);
  }

  // --- Documents ---
  if (path === '/api/documents') {
    if (method === 'GET') return Documents.listDocuments(request, ctx, env);
    if (method === 'POST') return Documents.uploadDocument(request, ctx, env, ctxExec);
  }
  if (path === '/api/documents/filter-counts' && method === 'GET') {
    return Documents.getDocumentFilterCounts(ctx, env);
  }
  m = path.match(/^\/api\/documents\/([^/]+)$/);
  if (m) {
    if (method === 'GET') return Documents.getDocument(m[1], ctx, env);
    if (method === 'DELETE') return Documents.deleteDocument(m[1], ctx, env);
  }
  m = path.match(/^\/api\/documents\/([^/]+)\/download$/);
  if (m && method === 'GET') return Documents.downloadDocument(m[1], ctx, env);

  // --- Sync & Approval ---
  if (path === '/api/sync/status' && method === 'GET') {
    return Sync.getSyncStatus(ctx, env);
  }
  if (path === '/api/sync/config' && method === 'GET') {
    return Admin.getSyncConfig(ctx, env);
  }
  if (path === '/api/sync/config' && method === 'PATCH') {
    return Admin.updateSyncConfig(request, ctx, env);
  }
  if (path === '/api/approval-queue' && method === 'GET') {
    return Approval.listApprovalQueue(request, ctx, env);
  }
  // Wave 6 UX — held-proposal endpoints MUST come before the regex
  // approve/reject routes below, otherwise the dynamic-id matcher
  // captures "held" as an id and short-circuits to approveItem with
  // an APPROVAL_ALREADY_RESOLVED error.
  if (path === '/api/approval-queue/held/approve' && method === 'POST') {
    return Approval.approveHeldProposal(request, ctx, env);
  }
  if (path === '/api/approval-queue/held/dismiss' && method === 'POST') {
    return Approval.dismissHeldProposal(request, ctx, env);
  }
  m = path.match(/^\/api\/approval-queue\/([^/]+)\/approve$/);
  if (m && method === 'POST') return Approval.approveItem(m[1], ctx, env);
  m = path.match(/^\/api\/approval-queue\/([^/]+)\/reject$/);
  if (m && method === 'POST') return Approval.rejectItem(m[1], ctx, env);
  if (path === '/api/approval-queue/bulk-approve' && method === 'POST') {
    return Approval.bulkApprove(request, ctx, env);
  }
  if (path === '/api/approval-queue/bulk-reject' && method === 'POST') {
    return Approval.bulkReject(request, ctx, env);
  }
  if (path === '/api/approval-queue/approve-all' && method === 'POST') {
    return Approval.approveAllForEntity(request, ctx, env);
  }
  if (path === '/api/approval-queue/reject-all' && method === 'POST') {
    return Approval.rejectAllForEntity(request, ctx, env);
  }
  if (path === '/api/approval-queue/dismiss-all' && method === 'POST') {
    return Approval.rejectAllPending(request, ctx, env);
  }
  if (path === '/api/approval-queue/grouped' && method === 'GET') {
    return Approval.listApprovalQueueGrouped(request, ctx, env);
  }
  // Wave 6 UX — held proposals visibility surface (entity_field_state.pending_proposals).
  if (path === '/api/approval-queue/held/approve' && method === 'POST') {
    return Approval.approveHeldProposal(request, ctx, env);
  }
  if (path === '/api/approval-queue/held/dismiss' && method === 'POST') {
    return Approval.dismissHeldProposal(request, ctx, env);
  }
  // Wave 6 UX — per-field permanent lock toggle + read.
  if (path === '/api/field-locks' && method === 'GET') {
    return Approval.listFieldLocks(request, ctx, env);
  }
  if (path === '/api/field-locks' && method === 'POST') {
    return Approval.toggleFieldLock(request, ctx, env);
  }

  // Q12 — synthetic observations (entity-scoped list + per-row dismiss).
  m = path.match(/^\/api\/entities\/(contact|company|deal)\/([^/]+)\/observations$/);
  if (m && method === 'GET') return Observations.listEntityObservations(m[1], m[2], ctx, env);
  m = path.match(/^\/api\/observations\/([^/]+)\/dismiss$/);
  if (m && method === 'POST') return Observations.dismissEntityObservation(m[1], ctx, env);

  // --- Agent ---
  if (path === '/api/agent/query' && method === 'POST') {
    return Agent.queryAgent(request, ctx, env, ctxExec);
  }
  if (path === '/api/agent/cancel' && method === 'POST') {
    return Agent.cancelAgentRequest(request, ctx, env);
  }
  m = path.match(/^\/api\/agent\/runs\/([^/]+)\/events$/);
  if (m && method === 'GET') return Agent.getAgentRunEvents(request, m[1], ctx, env);
  if (path === '/api/agent/sessions' && method === 'GET') {
    return Agent.listSessions(ctx, env);
  }
  if (path === '/api/agent/sessions' && method === 'POST') {
    return Agent.createSession(request, ctx, env);
  }
  m = path.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/);
  if (m && method === 'GET') return Agent.getSessionMessages(m[1], ctx, env);
  m = path.match(/^\/api\/agent\/sessions\/([^/]+)\/trace$/);
  if (m && method === 'GET') return Agent.getSessionTrace(m[1], ctx, env);
  m = path.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if (m && method === 'DELETE') return Agent.deleteSession(m[1], ctx, env);
  if (m && method === 'PATCH') return Agent.updateSessionTitle(request, m[1], ctx, env);
  if (path === '/api/agent/citation-click' && method === 'POST') {
    return Agent.logCitationClick(request, ctx, env);
  }
  if (path === '/api/agent/upload-file' && method === 'POST') {
    return ChatUploads.uploadChatFiles(request, ctx, env, ctxExec);
  }
  if (path === '/api/agent/attach-document' && method === 'POST') {
    return ChatUploads.attachDocumentToChat(request, ctx, env);
  }
  m = path.match(/^\/api\/agent\/uploads\/([^/]+)\/content$/);
  if (m && method === 'GET') return ChatUploads.getChatUploadContent(m[1], ctx, env);
  m = path.match(/^\/api\/agent\/sessions\/([^/]+)\/uploads$/);
  if (m && method === 'GET') return ChatUploads.listSessionUploads(m[1], ctx, env);

  // --- Deck production jobs ---
  m = path.match(/^\/api\/deck-jobs\/([^/]+)$/);
  if (m && method === 'GET') return DeckArtifacts.getDeckJob(m[1], ctx, env);
  m = path.match(/^\/api\/deck-jobs\/([^/]+)\/events$/);
  if (m && method === 'GET') return DeckArtifacts.getDeckJobEvents(request, m[1], ctx, env);

  // --- Audit log ---
  if (path === '/api/audit-log' && method === 'GET') {
    return AuditLog.listAuditLog(request, ctx, env);
  }
  m = path.match(/^\/api\/audit-log\/([^/]+)\/([^/]+)$/);
  if (m && method === 'GET') return AuditLog.getEntityHistory(m[1], m[2], ctx, env);

  // Progressive Firefly backfill (Phase F2) — self-service inside the handler.
  // Registered here above the /api/admin role check so members can view/start
  // their own import while owners can still manage org members.
  if (path === '/api/admin/firefly-progressive-backfill' && method === 'POST') {
    const { handleFireflyProgressiveBackfill } = await import('./handlers/firefly-backfill');
    return handleFireflyProgressiveBackfill(request, ctx, env);
  }
  if (path === '/api/admin/firefly-progressive-backfill' && method === 'GET') {
    const { handleFireflyProgressiveBackfillStatus } = await import('./handlers/firefly-backfill');
    return handleFireflyProgressiveBackfillStatus(request, ctx, env);
  }
  if (path === '/api/admin/firefly-progressive-backfill/cancel' && method === 'POST') {
    const { handleFireflyProgressiveBackfillCancel } = await import('./handlers/firefly-backfill');
    return handleFireflyProgressiveBackfillCancel(request, ctx, env);
  }

  // Custom date-range ingestion trigger — any authenticated user
  if (path === '/api/admin/trigger-ingestion' && method === 'POST') {
    return Admin.triggerIngestion(request, ctx, env);
  }

  // --- User-facing progressive backfill (any authenticated user can hit
  // these; authorization is enforced inside the handlers — members → self
  // only, owners → any user in their org).
  if (path === '/api/backfill/start' && method === 'POST') {
    return Backfill.startBackfill(request, ctx, env);
  }
  if (path === '/api/backfill/progress' && method === 'GET') {
    return Backfill.getBackfillProgress(request, ctx, env);
  }
  if (path === '/api/backfill/cancel' && method === 'POST') {
    return Backfill.cancelBackfill(request, ctx, env);
  }
  if (path === '/api/backfill/eligible-users' && method === 'GET') {
    return Backfill.listEligibleUsers(ctx, env);
  }

  // --- Admin (owner/admin only) ---
  if (path.startsWith('/api/admin')) {
    const forbidden = requireRole(ctx, ['owner', 'admin']);
    if (forbidden) return forbidden;

    if (path === '/api/admin/marty-lab' && method === 'GET')
      return MartyLab.getMartyLabStatus(ctx, env);
    if (path === '/api/admin/marty-lab/readiness' && method === 'GET')
      return MartyLab.getMartyLabReadiness(ctx, env);
    if (path === '/api/admin/marty-lab/repair-readiness' && method === 'POST')
      return MartyLab.repairMartyLabReadinessHandler(request, ctx, env);
    if (path === '/api/admin/marty-lab/runs' && method === 'POST')
      return MartyLab.startMartyLabRunHandler(request, ctx, env);
    m = path.match(/^\/api\/admin\/marty-lab\/runs\/([^/]+)$/);
    if (m && method === 'GET')
      return MartyLab.getMartyLabRunHandler(m[1], ctx, env);
    m = path.match(/^\/api\/admin\/marty-lab\/runs\/([^/]+)\/cancel$/);
    if (m && method === 'POST')
      return MartyLab.cancelMartyLabRunHandler(m[1], ctx, env);
    m = path.match(/^\/api\/admin\/marty-lab\/runs\/([^/]+)\/decision$/);
    if (m && method === 'POST')
      return MartyLab.decideMartyLabRunHandler(request, m[1], ctx, env);
    m = path.match(/^\/api\/admin\/marty-lab\/runs\/([^/]+)\/round-review$/);
    if (m && method === 'POST')
      return MartyLab.reviewInconclusiveMartyLabRoundHandler(request, m[1], ctx, env);
    m = path.match(/^\/api\/admin\/marty-lab\/runs\/([^/]+)\/deep-work\/([^/]+)\/code-patch$/);
    if (m && method === 'POST')
      return MartyLab.startMartyLabCodePatchJobHandler(request, m[1], m[2], ctx, env);
    m = path.match(/^\/api\/admin\/marty-lab\/runs\/([^/]+)\/experiments\/([^/]+)\/result$/);
    if (m && method === 'POST')
      return MartyLab.recordMartyLabExperimentResultHandler(request, m[1], m[2], ctx, env);

    if (path === '/api/admin/dlq' && method === 'GET') return Admin.listDlq(request, ctx, env);
    m = path.match(/^\/api\/admin\/dlq\/([^/]+)\/replay$/);
    if (m && method === 'POST') return Admin.replayDlq(m[1], ctx, env);
    m = path.match(/^\/api\/admin\/dlq\/([^/]+)\/discard$/);
    if (m && method === 'POST') return Admin.discardDlq(m[1], ctx, env);
    if (path === '/api/admin/enrichment-status' && method === 'GET')
      return Admin.getEnrichmentStatus(ctx, env);
    if (path === '/api/admin/clear-rate-limit' && method === 'POST')
      return Admin.clearRateLimit(request, ctx, env);
    if (path === '/api/admin/trigger-sync' && method === 'POST')
      return Admin.triggerSync(request, ctx, env);
    if (path === '/api/admin/repair-vectorize-participants' && method === 'POST')
      return Admin.repairVectorizeParticipantIds(request, ctx, env);
    if (path === '/api/admin/repair-acl-metadata' && method === 'POST')
      return Admin.repairBackfilledAclMetadata(request, ctx, env);
    if (path === '/api/admin/cleanup-transcript-acl' && method === 'POST') {
      const { handleCleanupTranscriptAcl } = await import('./handlers/cleanup-transcript-acl');
      return handleCleanupTranscriptAcl(ctx, env);
    }
    if (path === '/api/admin/d1-maintenance/preview' && method === 'POST')
      return D1Maintenance.preview(request, ctx, env);
    if (path === '/api/admin/d1-maintenance/run' && method === 'POST')
      return D1Maintenance.run(request, ctx, env);
    if (path === '/api/admin/d1-maintenance/runs' && method === 'GET')
      return D1Maintenance.getRun(request, null, ctx, env);
    m = path.match(/^\/api\/admin\/d1-maintenance\/runs\/([^/]+)$/);
    if (m && method === 'GET') return D1Maintenance.getRun(request, m[1], ctx, env);
    if (path === '/api/admin/recompute-primary-entity-ids' && method === 'POST')
      return Admin.recomputePrimaryEntityIds(request, ctx, env);
    if (path === '/api/admin/reembed-transcripts' && method === 'POST')
      return Admin.reembedTranscripts(request, ctx, env);
    if (path === '/api/admin/embed-all-deals' && method === 'POST')
      return Admin.embedAllDeals(request, ctx, env);
    if (path === '/api/admin/run-daily-cron' && method === 'POST')
      return Admin.runDailyCronManually(ctx, env);
    if (path === '/api/admin/ensure-graph-subscriptions' && method === 'POST') {
      const { handleEnsureGraphSubscriptions } = await import('./handlers/ensure-graph-subscriptions');
      return handleEnsureGraphSubscriptions(request, ctx, env);
    }
    if (path === '/api/admin/outlook-app-only-repair' && method === 'POST') {
      const { handleOutlookAppOnlyRepair } = await import('./handlers/outlook-app-only-repair');
      return handleOutlookAppOnlyRepair(request, ctx, env);
    }
    if (path === '/api/admin/reconcile-orphaned-fireflies' && method === 'POST') {
      const { handleReconcileOrphanedFireflies } = await import('./handlers/firefly-reconcile');
      return handleReconcileOrphanedFireflies(request, ctx, env);
    }
    if (path === '/api/admin/firefly-transcript-coverage' && method === 'GET') {
      const { handleFireflyTranscriptCoverage } = await import('./handlers/firefly-reconcile');
      return handleFireflyTranscriptCoverage(request, ctx, env);
    }
    if (path === '/api/admin/firefly-transcript-rebuild' && method === 'POST') {
      const { handleFireflyTranscriptRebuild } = await import('./handlers/firefly-reconcile');
      return handleFireflyTranscriptRebuild(request, ctx, env);
    }
    if (path === '/api/admin/firefly-transcript-source-verify' && method === 'POST') {
      const { handleFireflyTranscriptSourceVerify } = await import('./handlers/firefly-reconcile');
      return handleFireflyTranscriptSourceVerify(request, ctx, env);
    }
    if (path === '/api/admin/firefly-transcript-targeted-repair' && method === 'POST') {
      const { handleFireflyTranscriptTargetedRepair } = await import('./handlers/firefly-reconcile');
      return handleFireflyTranscriptTargetedRepair(request, ctx, env);
    }
    if (path === '/api/admin/ingestion-treatment-coverage' && method === 'GET') {
      const { handleIngestionTreatmentCoverage } = await import('./handlers/ingestion-treatment');
      return handleIngestionTreatmentCoverage(request, ctx, env);
    }
    if (path === '/api/admin/ingestion-treatment-repair' && method === 'POST') {
      const { handleIngestionTreatmentRepair } = await import('./handlers/ingestion-treatment');
      return handleIngestionTreatmentRepair(request, ctx, env);
    }
    if (path === '/api/admin/diagnose-calendar-sync' && method === 'POST') {
      const { handleDiagnoseCalendarSync } = await import('./handlers/firefly-reconcile');
      return handleDiagnoseCalendarSync(request, ctx, env);
    }
    if (path === '/api/admin/clear-calendar-delta' && method === 'POST') {
      const { handleClearCalendarDelta } = await import('./handlers/firefly-reconcile');
      return handleClearCalendarDelta(request, ctx, env);
    }
    if (path === '/api/admin/backfill-slack-channel-history' && method === 'POST') {
      const { handleBackfillSlackChannelHistory } = await import('./handlers/slack-backfill');
      return handleBackfillSlackChannelHistory(request, ctx, env);
    }
    if (path === '/api/admin/backfill-unembedded' && method === 'POST')
      return Admin.backfillUnembedded(request, ctx, env);
    if (path === '/api/admin/backfill-attachments' && method === 'POST')
      return Admin.backfillAttachments(request, ctx, env);
    if (path === '/api/admin/reclassify-documents' && method === 'POST')
      return Admin.reclassifyDocuments(request, ctx, env);

    // Wave 3 cleanup endpoints (owner-only enforced inside each handler).
    // Run order: evidence-preservation → d1-phase2 → dangling-vectors-batch (loop) → dangling-docs-batch (loop).
    if (path === '/api/admin/cleanup-evidence-preservation' && method === 'POST')
      return Cleanup.cleanupEvidencePreservation(request, ctx, env);
    if (path === '/api/admin/cleanup-d1-phase2' && method === 'POST')
      return Cleanup.cleanupD1Phase2(request, ctx, env);
    if (path === '/api/admin/cleanup-dangling-vectors-batch' && method === 'POST')
      return Cleanup.cleanupDanglingVectorsBatch(request, ctx, env);
    if (path === '/api/admin/cleanup-dangling-docs-batch' && method === 'POST')
      return Cleanup.cleanupDanglingDocsBatch(request, ctx, env);

    // Wave 6 Phase E — re-evaluate pending approval_queue rows through
    // the new corroboration model. Owner-only, batched, dry-run-able.
    if (path === '/api/admin/sweep-approval-queue' && method === 'POST')
      return sweepApprovalQueue(request, ctx, env);

    // Wave 1 — re-classify internal entities + soft-delete illegitimate deals.
    if (path === '/api/admin/reclassify-internal-deals' && method === 'POST') {
      const { handleReclassifyInternalDeals } = await import('./handlers/reclassify-internal-deals');
      return handleReclassifyInternalDeals(request, ctx, env);
    }

    // Wave 2 — explicit company merge (loser → survivor). Owner-only.
    if (path === '/api/admin/merge-companies' && method === 'POST') {
      const { handleMergeCompanies } = await import('./handlers/merge-companies');
      return handleMergeCompanies(request, ctx, env);
    }

    // Wave 4 — re-run hard-signal scan over existing conversations to
    // populate conversation_deals junctions for the timeline.
    if (path === '/api/admin/backfill-deal-timeline-junctions' && method === 'POST') {
      const { handleBackfillDealTimeline } = await import('./handlers/backfill-deal-timeline');
      return handleBackfillDealTimeline(request, ctx, env);
    }

    // Wave 5 — re-classify every deal_contacts.side via the new
    // domain-based rule. Picks up Medina-side participants who were
    // marked 'theirs' under the old default.
    if (path === '/api/admin/reclassify-deal-contact-sides' && method === 'POST') {
      const { handleReclassifyDealContactSides } = await import('./handlers/reclassify-deal-contact-sides');
      return handleReclassifyDealContactSides(request, ctx, env);
    }

    if (path === '/api/admin/companies/rename-placeholders' && method === 'POST')
      return Admin.renamePlaceholderCompanies(request, ctx, env);
    if (path === '/api/admin/rebuild-entity-index' && method === 'POST')
      return Admin.rebuildEntityIndexEndpoint(ctx, env);
    if (path === '/api/admin/rebuild-contact-search-index' && method === 'POST')
      return Contacts.rebuildContactSearchIndexEndpoint(ctx, env);
    if (path === '/api/admin/rebuild-contact-detail-read-model' && method === 'POST')
      return Contacts.rebuildContactDetailReadModelEndpoint(request, ctx, env);
    if (path === '/api/admin/cleanup-vector-bloat' && method === 'POST')
      return Admin.cleanupVectorBloat(ctx, env);
    if (path === '/api/admin/calendar-token-health' && method === 'GET')
      return Admin.getCalendarTokenHealth(ctx, env);
    if (path === '/api/admin/invalidate-stale-calendar-tokens' && method === 'POST')
      return Admin.invalidateStaleCalendarTokens(ctx, env);
    if (path === '/api/admin/embed-queue-health' && method === 'GET')
      return Admin.getEmbedQueueHealth(ctx, env);
    if (path === '/api/admin/process-embed-queue' && method === 'POST')
      return Admin.processEmbedQueue(ctx, env);
    if (path === '/api/admin/reconcile-deck-jobs' && method === 'POST')
      return Admin.reconcileDeckJobs(request, ctx, env);
    if (path === '/api/admin/rag-v2/backfill/start' && method === 'POST')
      return Admin.startRagV2Backfill(request, ctx, env);
    if (path === '/api/admin/rag-v2/backfill/status' && method === 'GET')
      return Admin.getRagV2BackfillStatus(ctx, env);
    if (path === '/api/admin/rag-v2/eval/run' && method === 'POST')
      return Admin.runRagV2Eval(request, ctx, env);
    if (path === '/api/admin/rag-v2/cutover' && method === 'POST')
      return Admin.cutoverRagV2(request, ctx, env);
    if (path === '/api/admin/rag-v2/rollback' && method === 'POST')
      return Admin.rollbackRagV2(request, ctx, env);
    if (path === '/api/admin/recover-deal-conversation-links' && method === 'POST')
      return Admin.recoverDealConversationLinks(request, ctx, env);
    if (path === '/api/admin/progressive-backfill' && method === 'POST')
      return Admin.createProgressiveBackfillHandler(request, ctx, env);
    if (path === '/api/admin/progressive-backfill' && method === 'GET')
      return Admin.getProgressiveBackfillHandler(request, ctx, env);
    m = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
    if (m && method === 'POST')
      return AuthLogin.adminResetPassword(m[1], request, ctx, env);
  }

  if (path === '/api/system/status' && method === 'GET') return Admin.getSystemStatus(ctx, env);
  if (path === '/api/me/integration-status' && method === 'GET')
    return Admin.getIntegrationStatus(ctx, env);
  if (path === '/api/integrations/status' && method === 'GET')
    return Integrations.getIntegrationsStatus(request, ctx, env);
  if (path === '/api/outlook/app-only-health' && method === 'GET') {
    const forbidden = requireRole(ctx, ['owner', 'admin', 'super_admin']);
    if (forbidden) return forbidden;
    const { handleOutlookAppOnlyHealth } = await import('./handlers/outlook-app-only-repair');
    return handleOutlookAppOnlyHealth(ctx, env);
  }

  // --- Settings → System Status tab ---
  if (path === '/api/settings/system-status' && method === 'GET') {
    const forbidden = requireRole(ctx, ['owner', 'admin', 'super_admin']);
    if (forbidden) return forbidden;
    return SystemStatusHandler.getSystemStatus(ctx, env);
  }
  if (path === '/api/integrations/firefly/webhook-secret' && method === 'GET')
    return Integrations.getFireflyWebhookSecret(ctx, env);

  // --- Settings → Firefly credential self-service (Phase 4 1b 2026-05-04) ---
  // Auth-gated to caller's own user_id via ctx.userId — no admin override.
  // Plaintext only flows IN (POST body); GET/DELETE responses contain
  // metadata only.
  if (path === '/api/settings/firefly-credentials' && method === 'POST')
    return FireflyCredentials.storeMyFireflyCredential(request, ctx, env);
  if (path === '/api/settings/firefly-credentials' && method === 'GET')
    return FireflyCredentials.getMyFireflyCredential(request, ctx, env);
  if (path === '/api/settings/firefly-credentials' && method === 'DELETE')
    return FireflyCredentials.revokeMyFireflyCredential(request, ctx, env);

  // --- Imports ---
  if (path === '/api/imports/intelligent' && method === 'POST') {
    return IntelligentImport.intelligentImport(request, ctx, env, ctxExec);
  }
  if (path === '/api/imports' && method === 'GET') {
    return Imports.listImports(ctx, env);
  }
  if (path === '/api/imports' && method === 'POST') {
    return Imports.uploadImport(request, ctx, env);
  }
  m = path.match(/^\/api\/imports\/([^/]+)\/undo$/);
  if (m && method === 'POST') return IntelligentImport.undoImport(m[1], ctx, env);
  m = path.match(/^\/api\/imports\/([^/]+)\/hide$/);
  if (m && method === 'POST') return Imports.hideImportJob(m[1], ctx, env);
  m = path.match(/^\/api\/imports\/([^/]+)$/);
  if (m && method === 'GET') return Imports.getImportJob(m[1], ctx, env);
  if (m && method === 'DELETE') return Imports.deleteImportJob(m[1], ctx, env);
  m = path.match(/^\/api\/imports\/([^/]+)\/mapping$/);
  if (m && method === 'POST') return Imports.setImportMapping(request, m[1], ctx, env);
  m = path.match(/^\/api\/imports\/([^/]+)\/confirm$/);
  if (m && method === 'POST') return Imports.confirmImport(m[1], ctx, env, ctxExec);
  m = path.match(/^\/api\/imports\/([^/]+)\/cancel$/);
  if (m && method === 'POST') return Imports.cancelImport(m[1], ctx, env);

  // --- Campaigns ---
  if (path === '/api/campaigns') {
    if (method === 'GET') return Campaigns.listCampaigns(ctx, env);
    if (method === 'POST') return Campaigns.createCampaign(request, ctx, env);
  }
  m = path.match(/^\/api\/campaigns\/([^/]+)$/);
  if (m) {
    if (method === 'GET') return Campaigns.getCampaign(m[1], ctx, env);
    if (method === 'PATCH') return Campaigns.updateCampaign(request, m[1], ctx, env);
  }
  m = path.match(/^\/api\/campaigns\/([^/]+)\/send$/);
  if (m && method === 'POST') return Campaigns.sendCampaign(m[1], ctx, env);

  return errorResponse('NOT_FOUND', 404);
}

// --- Cron handler ---

// Phase 8 (2026-05-06): exported so src/pipelines-index.ts can import +
// dispatch the same scheduled handler. During the bundled-deploy overlap
// window, BOTH api and pipelines run this handler. Post-api-redeploy,
// api removes its [triggers] from wrangler.toml so it never fires; only
// pipelines' cron triggers it. esbuild tree-shakes api-specific paths
// like handleRequest from the pipelines bundle since pipelines-index.ts
// doesn't reference the default export.
export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctxExec: ExecutionContext
): Promise<void> {
  const cron = event.cron;

  // Dispatch workflows per org
  const orgs = await env.D1.prepare(
    'SELECT id FROM organizations WHERE deleted_at IS NULL'
  ).all<{ id: string }>();

  for (const org of orgs.results) {
    try {
      if (cron === '0 * * * *') {
        // Ingestion
        await env.INGESTION_WORKFLOW.create({
          id: `ingestion-${org.id}-${Date.now()}`,
          params: { org_id: org.id },
        });
        // Hourly self-heal — enqueueBackfillConversations.
        //
        // Phase 8 1a (2026-05-05): swapped from the inline-embed
        // backfillUnembeddedConversations to the work_queue enqueuer.
        // Same scan shape (NOT EXISTS in vector_entity_index, LIMIT 200);
        // each detected gap now flows through work_queue domain
        // 'embed_retry' instead of being embedded inline. Net effects:
        //   • upstream_budget_ledger sees BGE traffic from this path
        //     (audit finding G — bypassed pre-Phase-8)
        //   • idempotency_key dedup makes this safe to run alongside
        //     Phase 6 1a's three reactive enqueue sites (ingestion-
        //     finalizer, outlook backfill, attachment orchestrator)
        //   • drain cadence shifts from "200/hour inline" to "minute-tick
        //     × batchSize=10 = 14,400/day" via the embed_retry handler
        //   • 685-row backlog (live) drains in ~3.4 hours
        //
        // Disjoint-population rationale unchanged: this catches gaps that
        // the reactive ingestion-finalizer enqueue MISSED (e.g. the
        // calendar-progressive-backfill rows from a separate cron). The
        // work_queue handler covers the enqueue-then-fail path; this
        // covers the never-enqueued path. Both still needed.
        ctxExec.waitUntil((async () => {
          const { enqueueBackfillConversations } = await import('./lib/daily-cron');
          try { await enqueueBackfillConversations(org.id, env); }
          catch (e) { console.error(`hourly self-heal: enqueueBackfillConversations failed for ${org.id}:`, e); }
        })());
        // Hourly Graph subscription renewal — back-stops the daily cron's
        // step 14, which has been observed not firing on its own schedule
        // (CF cron dispatch issue under investigation 2026-04-30). Idle
        // cost is one D1 SELECT (no-op when nothing within 24h cutoff);
        // active cost ~5 subreqs per renewing sub × LIMIT 50 cap.
        // Separate waitUntil so it races concurrently with the embed
        // self-heal — its tiny subrequest footprint always wins under
        // the per-invocation cap before the heavier embed work depletes it.
        ctxExec.waitUntil((async () => {
          const { renewExpiringSubscriptions } = await import('./lib/graph-subscriptions');
          try { await renewExpiringSubscriptions(env); }
          catch (e) { console.error(`hourly self-heal: renewExpiringSubscriptions failed:`, e); }
        })());
        // Hourly contact + company embed backfill — backfillUnembeddedEntities
        // is the SOLE callsite of embedContactBio + embedCompanyDescription
        // in the codebase (no other ingestion path embeds these). Originally
        // added when the 0 0 * * * daily cron went silent in 2026-04-28
        // (commit 58ea134's 4th-trigger registration broke CF dispatch).
        // Phase 2 (2026-05-04) folded daily into the minute-tick handler at
        // 02:10 UTC, so daily entity backfill is healed — but this hourly
        // backstop stays as a more-frequent self-heal: contacts/companies
        // created in the last hour become MARTy-visible without waiting for
        // the daily run. Cost: ~120 subreqs/hour worst case (20 contacts +
        // 20 companies × ~3 each + 2 SELECTs), well within the per-
        // invocation cap. Separate waitUntil so it races concurrently with
        // the embed self-heal + renewal blocks for the same subrequest-
        // budget rationale documented above.
        ctxExec.waitUntil((async () => {
          const { backfillUnembeddedEntities } = await import('./lib/daily-cron');
          try { await backfillUnembeddedEntities(org.id, env); }
          catch (e) { console.error(`hourly self-heal: backfillUnembeddedEntities failed for ${org.id}:`, e); }
        })());
        // Hourly events embed backfill — same migration as conversations
        // above. T4's hotfix introduced the inline-embed pattern; Phase
        // 8 1a routes through work_queue (domain='embed_retry') with
        // ledger integration + idempotent concurrency. The enqueuer's
        // SELECT shape (LIMIT 50, NOT EXISTS in vector_entity_index)
        // matches the legacy backfillUnembeddedEvents exactly — only
        // the per-row work changes (enqueueWork instead of inline
        // chunkEmbedAndPersistAll + INSERT vector rows).
        //
        // Critical correctness: embedSingleItem's events branch was
        // updated in Phase 8 1a-i to mirror backfillUnembeddedEvents's
        // T4 ACL logic (transcript-backed events with internal user
        // attendees → visibility='private' + participant_user_ids).
        // Without that fix, the 71 Outlook-with-transcript subgap
        // would silently regress on re-embed.
        //
        // 930-row backlog (live, audit'd 2026-05-05) drains in ~24
        // hours at minute-tick × batchSize=10 capacity, subject to
        // BGE rate limit (which the work_queue's open-circuit filter
        // now properly engages with).
        ctxExec.waitUntil((async () => {
          const { enqueueBackfillEvents } = await import('./lib/daily-cron');
          try { await enqueueBackfillEvents(org.id, env); }
          catch (e) { console.error(`hourly self-heal: enqueueBackfillEvents failed for ${org.id}:`, e); }
        })());
        // Hourly document embed self-heal — same work_queue path as
        // conversations/events, capped at 40 completed documents per org
        // per hour. This keeps MARTy's semantic document retrieval getting
        // healthier without a one-time quota spike.
        ctxExec.waitUntil((async () => {
          const { enqueueBackfillDocuments } = await import('./lib/daily-cron');
          try { await enqueueBackfillDocuments(org.id, env); }
          catch (e) { console.error(`hourly self-heal: enqueueBackfillDocuments failed for ${org.id}:`, e); }
        })());
        // Hourly deal evidence coverage for completed deal documents. The
        // ingestion path already detects conversations/events inline; this
        // covers deal_pitch/deal_terms/deal_financials/deal_diligence docs
        // that completed after attachment/upload processing.
        ctxExec.waitUntil((async () => {
          const { enqueueDealEvidenceDocumentDetection } = await import('./lib/daily-cron');
          try {
            const result = await enqueueDealEvidenceDocumentDetection(org.id, env);
            if (result.enqueued > 0) {
              console.warn(`[deal-evidence] org=${org.id} document_candidates=${result.candidates} enqueued=${result.enqueued}`);
            }
          } catch (e) {
            console.error(`hourly self-heal: enqueueDealEvidenceDocumentDetection failed for ${org.id}:`, e);
          }
        })());
        // Hourly RAG v2 source coverage self-heal. This is the primary
        // retrieval index Marty uses for v2 orgs; legacy vector coverage can
        // be healthy while rag_source_index_state is stale. The scanner is
        // bounded per source family and idempotent by source hash.
        ctxExec.waitUntil((async () => {
          const { scanAndRepairRagV2Coverage } = await import('./lib/rag-v2');
          try {
            const result = await scanAndRepairRagV2Coverage(env, org.id, { limitPerSpec: 75 });
            if (result.enqueued > 0 || result.errors.length > 0) {
              console.warn(
                `[rag-v2-self-heal] org=${org.id} candidates=${result.candidates} enqueued=${result.enqueued} already=${result.already_queued} skipped=${result.skipped} errors=${result.errors.length}`
              );
            }
          } catch (e) {
            console.error(`hourly self-heal: scanAndRepairRagV2Coverage failed for ${org.id}:`, e);
          }
        })());
        // Hourly Fireflies recent transcript safety net. This is deliberately
        // bounded to the last 7 days and only enqueues missing Fireflies IDs
        // through firefly_transcript_hydrate, so it cannot become a broad
        // database replay.
        ctxExec.waitUntil((async () => {
          const key = `firefly_recent_sweep:${org.id}:${new Date(event.scheduledTime ?? Date.now()).toISOString().slice(0, 13)}`;
          try {
            const seen = await env.KV.get(key);
            if (seen) return;
            await env.KV.put(key, '1', { expirationTtl: 7200 });
            const { runFireflyRecentSweeper } = await import('./lib/firefly-recent-sweeper');
            const result = await runFireflyRecentSweeper(org.id, env, { daysBack: 7, maxPagesPerUser: 2 });
            if (result.enqueued > 0 || result.errors.length > 0) {
              console.warn(
                `[firefly-recent-sweep] org=${org.id} users=${result.users_scanned} source=${result.source_transcripts} missing=${result.missing_transcripts} enqueued=${result.enqueued} errors=${result.errors.length}`
              );
            }
          } catch (e) {
            console.error(`hourly self-heal: runFireflyRecentSweeper failed for ${org.id}:`, e);
          }
        })());
        // deal_intelligence batch refresh — recompute the oldest 50
        // stale-or-invalidated rows for this org. Bounded subrequest
        // budget by HOURLY_BATCH_LIMIT (1 Claude call + ~3 D1 calls per
        // row = ~200 subreqs/tick worst case). Sibling waitUntil so it
        // races with the embed self-heal blocks above for the same
        // shared budget, per the established pattern.
        ctxExec.waitUntil((async () => {
          const { refreshStaleIntelligence } = await import('./lib/deal-intelligence');
          try {
            const result = await refreshStaleIntelligence(org.id, env);
            if (result.refreshed > 0) {
              console.log(`[deal-intelligence] hourly refresh org=${org.id} refreshed=${result.refreshed}`);
            }
          } catch (e) {
            console.error(`hourly refresh: refreshStaleIntelligence failed for ${org.id}:`, e);
          }
        })());
        // Phase 1 (2026-05-04): workflow-state reconciler. Polls CF
        // Workflows REST API for stale running sync_jobs rows that have
        // a captured cf_instance_id (currently ingestion-workflow only)
        // and reconciles D1 to runtime truth — closes the orphan-row
        // gap Terminal 5 caught where CF runtime errors a workflow with
        // a hard error before user code can write closure. The
        // reconciler self-wraps in withTaskRun (Phase 0); this caller
        // just kicks it off as a sibling waitUntil so it gets its own
        // ~30s wallclock allocation alongside the other hourly self-
        // heal blocks. Per-tick subreq cost: ≤50 sync_jobs reads × ≤50
        // CF API calls × ≤50 D1 UPDATEs + 1 task_runs row, well under
        // any cap. Steady-state with the system healthy: no-op task_run
        // with items_processed=0.
        ctxExec.waitUntil((async () => {
          const { reconcileWorkflowState } = await import('./lib/workflow-state-reconciler');
          try { await reconcileWorkflowState(org.id, env); }
          catch (e) { console.error(`hourly self-heal: reconcileWorkflowState failed for ${org.id}:`, e); }
        })());
      } else if (cron === '* * * * *') {
        // Progressive backfill driver — advances each active parent's
        // current window by one paginated batch. Bumped 2026-04-29 from
        // */2 to every-minute to cut total Tony backfill time once Alvaro
        // completed (no more parallel contention to coordinate around).
        ctxExec.waitUntil((async () => {
          const { driveAllActiveProgressive } = await import('./lib/progressive-backfill');
          try { await driveAllActiveProgressive(org.id, env); }
          catch (e) { console.error(`progressive backfill drive failed for ${org.id}:`, e); }
        })());
        // Firefly progressive backfill driver (Phase F2) — same cadence,
        // sibling invocation. Independent from Outlook's driver: different
        // tables, different per-tick budget, different pagination scheme.
        // Sequential per user inside the helper for the same BGE rate-limit
        // contention reason as Outlook's.
        ctxExec.waitUntil((async () => {
          const { driveAllActiveFireflyProgressive } = await import('./lib/firefly-progressive-backfill');
          try { await driveAllActiveFireflyProgressive(org.id, env); }
          catch (e) { console.error(`firefly progressive backfill drive failed for ${org.id}:`, e); }
        })());

        // Phase 6.1 (2026-05-05): calendar refresh scheduler.
        //
        // Scans calendar_progressive_backfill_windows for never-synced +
        // stale-completed rows and enqueues work_queue rows with an
        // idempotency_key keyed on last_synced_at, so concurrent staleness
        // scans collapse cleanly while a fresh refresh after sync completes
        // generates a new key. The global work_queue drain runs once after
        // the org loop below.
        //
        // Subrequest cost: 1 SELECT + up to ~30 enqueueWork calls per
        // user worst case (full bootstrap). Steady state with most
        // rows fresh: just the SELECT. Per-org scoped — runs once per
        // org per minute tick alongside the existing progressive
        // drivers. Errors caught here are non-fatal — the next tick
        // re-tries the scan.
        ctxExec.waitUntil((async () => {
          try {
            const { enqueueCalendarRefreshes } = await import('./lib/calendar-progressive-backfill');
            await enqueueCalendarRefreshes(org.id, env);
          } catch (e) {
            console.error(`calendar-refresh enqueue failed for ${org.id}:`, e);
          }
        })());

        ctxExec.waitUntil((async () => {
          try {
            const { enqueueDueContactEnrichment } = await import('./lib/contact-enrichment-queue');
            await enqueueDueContactEnrichment(org.id, env);
          } catch (e) {
            console.error(`contact-enrichment enqueue failed for ${org.id}:`, e);
          }
        })());

        ctxExec.waitUntil((async () => {
          try {
            const { dispatchRagV2QueueBurst } = await import('./lib/rag-v2-queue-drain');
            const result = await dispatchRagV2QueueBurst(env, org.id);
            if (result.dispatched > 0) {
              console.log(`[rag-v2-queue] dispatched org=${org.id} count=${result.dispatched}`);
            }
          } catch (e) {
            console.error(`rag-v2 queue dispatch failed for ${org.id}:`, e);
          }
        })());

        ctxExec.waitUntil((async () => {
          try {
            const { scanAndRepairIngestion } = await import('./lib/ingestion-health');
            const result = await scanAndRepairIngestion(org.id, env);
            if (result.repairs_enqueued > 0 || result.dead_letters_requeued > 0) {
              console.warn(
                `[ingestion-health] org=${org.id} incidents=${result.incidents} repairs=${result.repairs_enqueued} dead_letters_requeued=${result.dead_letters_requeued}`
              );
            }
          } catch (e) {
            console.error(`ingestion-health scan failed for ${org.id}:`, e);
          }
        })());

        // Phase 2 (2026-05-04): cron consolidation 4 → 2. The dedicated
        // `5 * * * *` and `0 0 * * *` triggers were removed from
        // wrangler.toml to eliminate the 4-trigger CF dispatch fragility
        // (commit 58ea134's 4th-trigger registration broke daily cron
        // dispatch back on 2026-04-28). Their work is folded here under
        // time-of-day gates, dispatched from the proven minute-tick.
        //
        // event.scheduledTime is the canonical CF-provided dispatch
        // timestamp; Date.now() fallback is defensive — should always be
        // present in a real scheduled invocation.
        const dt = new Date(event.scheduledTime ?? Date.now());
        const utcHour = dt.getUTCHours();
        const utcMinute = dt.getUTCMinutes();

        // MARTy Sandbox is canary-only and manually directed. Automatic lab
        // creation stays disabled so one human-reviewed improvement runs at a time.

        // Folded from `5 * * * *`: hourly enrichment workflow trigger.
        // Shifted from minute :05 → :04 to spread load away from the
        // hour-boundary stampede where the heavy `0 * * * *` cron also
        // fires (ingestion master + 6 self-heal waitUntil blocks).
        if (utcMinute === 4) {
          await env.ENRICHMENT_WORKFLOW.create({
            id: `enrichment-${org.id}-${Date.now()}`,
            params: { org_id: org.id },
          });
        }

        // Folded from `0 0 * * *`: daily cron at 02:10 UTC.
        //   • Hour 02 (not 00): avoid hour-zero stampede where the
        //     hourly heavy cron's 6 self-heal blocks already compete for
        //     subrequest budget.
        //   • Minute 10 (not 00): give the 02:00 hourly ingestion run
        //     ~10 min to clear before daily's heavy bulk recomputes
        //     (3 Phase 0a-4 calc functions + recalculateAllAssociations
        //     + ~16 other operations) start consuming D1 throughput.
        // Heals the "daily cron silently dead since 2026-04-28" concern
        // by giving daily work a path that runs through the proven
        // minute-tick dispatcher, regardless of whether the original
        // dedicated `0 0 * * *` trigger had been firing.
        if (utcHour === 2 && utcMinute === 10) {
          ctxExec.waitUntil(runDailyCron(org.id, env));
        }
      }
    } catch (e) {
      console.error(`Cron dispatch failed for org ${org.id}:`, e);
    }
  }

  if (cron === '* * * * *') {
    // Universal work_queue is a global table/driver, not an org-scoped
    // task. Run exactly once per minute tick after org-specific enqueuers
    // have been scheduled. The task_runs idempotency key also collapses
    // duplicate Cloudflare scheduled deliveries for the same minute; without
    // that, two global claim passes can overrun handler concurrency caps.
    ctxExec.waitUntil((async () => {
      try {
        const scheduledAt = Number.isFinite(event.scheduledTime)
          ? event.scheduledTime
          : Date.now();
        const minuteStart = new Date(Math.floor(scheduledAt / 60_000) * 60_000).toISOString();
        const { withTaskRun } = await import('./lib/task-runs');
        const { processWorkQueueTick } = await import('./lib/work-queue-driver');
        await withTaskRun(env, 'system', 'work_queue_tick', async (taskRun) => {
          const result = await processWorkQueueTick(env);
          const completed = result.per_domain.reduce((sum, d) => sum + d.completed, 0);
          const failed = result.per_domain.reduce((sum, d) => sum + d.failed, 0);
          const topFailingDomain = result.per_domain
            .filter(d => d.failed > 0)
            .sort((a, b) => b.failed - a.failed)[0] || null;
          const sampleError = result.sample_errors[0] || null;
          taskRun.report({
            items_processed: completed,
            items_failed: failed,
            items_skipped: result.swept,
            last_error: sampleError
              ? `${sampleError.domain}${sampleError.work_queue_id ? `:${sampleError.work_queue_id}` : ''}: ${sampleError.error}`
              : undefined,
            metadata: {
              swept: result.swept,
              open_circuits: result.open_circuits,
              top_failing_domain: topFailingDomain?.domain || null,
              sample_error: sampleError,
              sample_errors: result.sample_errors,
              per_domain: result.per_domain,
            },
          });
          return result;
        }, {
          idempotencyKey: `work_queue_tick:${minuteStart}`,
          initialMetadata: { cron, minute_start: minuteStart },
        });
        await withTaskRun(env, 'system', 'sync_job_stale_reconcile', async (taskRun) => {
          const { reconcileStaleOperationalSyncJobs } = await import('./lib/sync-job-lifecycle');
          const result = await reconcileStaleOperationalSyncJobs(env, { maxAgeMinutes: 10, limit: 50 });
          taskRun.report({
            items_processed: result.reconciled,
            metadata: {
              reconciled: result.reconciled,
              sampled_ids: result.sampled_ids,
            },
          });
          return result;
        }, {
          idempotencyKey: `sync_job_stale_reconcile:${minuteStart}`,
          initialMetadata: { cron, minute_start: minuteStart },
        });
        const tick = new Date(scheduledAt);
        if (tick.getUTCHours() === 2 && tick.getUTCMinutes() === 25) {
          const { runScheduledD1Maintenance } = await import('./lib/d1-maintenance');
          await withTaskRun(env, 'system', 'd1_maintenance', async (taskRun) => {
            const result = await runScheduledD1Maintenance(env);
            const numericStepTotal = Object.values(result.steps).reduce<number>((sum, step) => {
              const stepValues = Object.values(step as Record<string, unknown>);
              return sum + stepValues.reduce<number>((inner, value) => inner + (typeof value === 'number' ? value : 0), 0);
            }, 0);
            taskRun.report({
              items_processed: numericStepTotal,
              items_failed: result.status === 'failed' ? 1 : 0,
              metadata: {
                run_id: result.run_id,
                r2_prefix: result.r2_prefix,
                status: result.status,
                steps: result.steps,
              },
            });
            return result;
          }, {
            idempotencyKey: `d1_maintenance:${tick.toISOString().slice(0, 10)}`,
            initialMetadata: { cron, scheduled_date: tick.toISOString().slice(0, 10) },
          });
        }
      } catch (e) {
        console.error('work-queue tick failed:', e);
      }
    })());
  }
}

// --- Queue handler ---

// Phase 8 (2026-05-06): exported alongside handleScheduled. Pipelines
// claims the audit consumer per dispatch override; webhook intake queue
// consumer stays here on api until Stage 4 (Session B). After api
// redeploys, api's [[queues.consumers]] for audit-log-queue is removed
// from wrangler.toml so api no longer consumes audit events; pipelines
// declares the consumer in wrangler.pipelines.toml.
export async function handleQueue(
  batch: MessageBatch<AuditEvent | WebhookQueueMessage>,
  env: Env
): Promise<void> {
  const queueName = batch.queue;

  if (queueName === 'audit-log-queue') {
    await handleAuditBatch(batch as MessageBatch<AuditEvent>, env);
  } else if (queueName === 'rag-reindex-v2-queue') {
    const { handleRagV2QueueBatch } = await import('./lib/rag-v2-queue-drain');
    await handleRagV2QueueBatch(batch as any, env);
  } else if (queueName === 'webhook-intake-queue') {
    await handleWebhookBatch(batch as MessageBatch<WebhookQueueMessage>, env);
  } else if (queueName === 'webhook-dlq') {
    await handleDlqBatch(batch as MessageBatch<WebhookQueueMessage>, env);
  } else if (queueName === 'audit-log-dlq') {
    await handleAuditDlqBatch(batch as MessageBatch<AuditEvent>, env);
  } else {
    for (const m of batch.messages) m.ack();
  }
}

// --- Worker export ---

export default {
  async fetch(
    request: Request,
    env: Env,
    ctxExec: ExecutionContext
  ): Promise<Response> {
    const origin = request.headers.get('Origin') || '';
    try {
      const res = await handleRequest(request, env, ctxExec);
      return withCors(res, origin, env);
    } catch (e) {
      console.error('Unhandled error:', e);
      return withCors(errorResponse('INTERNAL_ERROR', 500, (e as Error).message), origin, env);
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctxExec: ExecutionContext
  ): Promise<void> {
    await handleScheduled(event, env, ctxExec);
  },

  async queue(
    batch: MessageBatch<AuditEvent | WebhookQueueMessage>,
    env: Env
  ): Promise<void> {
    await handleQueue(batch, env);
  },
};

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
import * as Sync from './handlers/sync';
import * as AuditLog from './handlers/audit-log';
import * as Admin from './handlers/admin';
import * as Cleanup from './handlers/cleanup';
import * as Imports from './handlers/imports';
import * as IntelligentImport from './handlers/intelligent-import';
import * as Campaigns from './handlers/campaigns';
import * as Agent from './handlers/agent';
import * as ChatUploads from './handlers/chat-uploads';
import * as Webhooks from './handlers/webhooks';
import * as AuthOAuth from './handlers/auth-oauth';
import * as Users from './handlers/users';
import * as Integrations from './handlers/integrations';
import * as SystemStatusHandler from './handlers/system-status';
import * as Backfill from './handlers/backfill';

import { handleAuditBatch } from './workers/audit-consumer';
import { handleWebhookBatch } from './workers/webhook-consumer';
import { handleDlqBatch, handleAuditDlqBatch } from './workers/dlq-consumer';

import { runDailyCron } from './lib/daily-cron';

export { IngestionWorkflow } from './workflows/ingestion';
export { IngestionChunkWorkflow } from './workflows/ingestion-chunk';
export { IngestionFinalizerWorkflow } from './workflows/ingestion-finalizer';
export { EnrichmentWorkflow } from './workflows/enrichment';
export { CampaignSendWorkflow } from './workflows/campaign-send';
export { DailyCronWorkflow } from './workflows/daily-cron';

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

  if (path === '/health') return jsonResponse({ ok: true, env: env.ENVIRONMENT });

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
    if (method === 'GET') return Contacts.getContact(id, ctx, env);
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
  m = path.match(/^\/api\/deals\/([^/]+)\/associations$/);
  if (m && method === 'GET') return Deals.getDealAssociations(m[1], ctx, env);
  m = path.match(/^\/api\/deals\/([^/]+)\/timeline$/);
  if (m && method === 'GET') return Deals.getDealTimeline(request, m[1], ctx, env);
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

  // --- Agent ---
  if (path === '/api/agent/query' && method === 'POST') {
    return Agent.queryAgent(request, ctx, env, ctxExec);
  }
  if (path === '/api/agent/cancel' && method === 'POST') {
    return Agent.cancelAgentRequest(request, ctx, env);
  }
  if (path === '/api/agent/sessions' && method === 'GET') {
    return Agent.listSessions(ctx, env);
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
  m = path.match(/^\/api\/agent\/uploads\/([^/]+)\/content$/);
  if (m && method === 'GET') return ChatUploads.getChatUploadContent(m[1], ctx, env);
  m = path.match(/^\/api\/agent\/sessions\/([^/]+)\/uploads$/);
  if (m && method === 'GET') return ChatUploads.listSessionUploads(m[1], ctx, env);

  // --- Audit log ---
  if (path === '/api/audit-log' && method === 'GET') {
    return AuditLog.listAuditLog(request, ctx, env);
  }
  m = path.match(/^\/api\/audit-log\/([^/]+)\/([^/]+)$/);
  if (m && method === 'GET') return AuditLog.getEntityHistory(m[1], m[2], ctx, env);

  // --- Firefly transcript backfill — auth-only, no role gate (each user
  // brings their own Firefly API key, transcripts ingest as org-wide data).
  // Registered above the /api/admin role check so the path is reachable for
  // any authenticated team member.
  if (path === '/api/admin/firefly-backfill' && method === 'POST') {
    const { handleFireflyBackfill } = await import('./handlers/firefly-backfill');
    return handleFireflyBackfill(request, ctx, env);
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
    if (path === '/api/admin/backfill-email' && method === 'POST')
      return Admin.backfillEmail(request, ctx, env);
    if (path === '/api/admin/backfill-progress' && method === 'GET')
      return Admin.getBackfillProgress(ctx, env);
    if (path === '/api/admin/repair-vectorize-participants' && method === 'POST')
      return Admin.repairVectorizeParticipantIds(request, ctx, env);
    if (path === '/api/admin/repair-acl-metadata' && method === 'POST')
      return Admin.repairBackfilledAclMetadata(request, ctx, env);
    if (path === '/api/admin/recompute-primary-entity-ids' && method === 'POST')
      return Admin.recomputePrimaryEntityIds(request, ctx, env);
    if (path === '/api/admin/reembed-transcripts' && method === 'POST')
      return Admin.reembedTranscripts(request, ctx, env);
    if (path === '/api/admin/embed-all-deals' && method === 'POST')
      return Admin.embedAllDeals(request, ctx, env);
    if (path === '/api/admin/run-daily-cron' && method === 'POST')
      return Admin.runDailyCronManually(ctx, env);
    if (path === '/api/admin/backfill-unembedded' && method === 'POST')
      return Admin.backfillUnembedded(request, ctx, env);
    if (path === '/api/admin/backfill-attachments' && method === 'POST')
      return Admin.backfillAttachments(request, ctx, env);

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

    if (path === '/api/admin/companies/rename-placeholders' && method === 'POST')
      return Admin.renamePlaceholderCompanies(request, ctx, env);
    if (path === '/api/admin/rebuild-entity-index' && method === 'POST')
      return Admin.rebuildEntityIndexEndpoint(ctx, env);
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

  // --- Settings → System Status tab ---
  if (path === '/api/settings/system-status' && method === 'GET')
    return SystemStatusHandler.getSystemStatus(ctx, env);
  if (path === '/api/integrations/firefly/webhook-secret' && method === 'GET')
    return Integrations.getFireflyWebhookSecret(ctx, env);

  // --- Imports ---
  if (path === '/api/imports/intelligent' && method === 'POST') {
    return IntelligentImport.intelligentImport(request, ctx, env, ctxExec);
  }
  if (path === '/api/imports' && method === 'POST') {
    return Imports.uploadImport(request, ctx, env);
  }
  m = path.match(/^\/api\/imports\/([^/]+)\/undo$/);
  if (m && method === 'POST') return IntelligentImport.undoImport(m[1], ctx, env);
  m = path.match(/^\/api\/imports\/([^/]+)$/);
  if (m && method === 'GET') return Imports.getImportJob(m[1], ctx, env);
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

async function handleScheduled(
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
        // Hourly self-heal pass — catches any conversations / events / docs
        // that landed in D1 but never got embedded (e.g. from the inline
        // historical backfill path which doesn't have detect-embed-gaps).
        // waitUntil so it doesn't block cron dispatch for other orgs.
        ctxExec.waitUntil((async () => {
          const { backfillUnembeddedConversations, processEmbedRetryQueue } = await import('./lib/daily-cron');
          try { await backfillUnembeddedConversations(org.id, env); }
          catch (e) { console.error(`hourly self-heal: backfillUnembedded failed for ${org.id}:`, e); }
          try { await processEmbedRetryQueue(org.id, env); }
          catch (e) { console.error(`hourly self-heal: processEmbedRetryQueue failed for ${org.id}:`, e); }
        })());
      } else if (cron === '5 * * * *') {
        // Enrichment
        await env.ENRICHMENT_WORKFLOW.create({
          id: `enrichment-${org.id}-${Date.now()}`,
          params: { org_id: org.id },
        });
      } else if (cron === '0 0 * * *') {
        // Daily cron — runs inline as a standard Worker
        ctxExec.waitUntil(runDailyCron(org.id, env));
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
      }
    } catch (e) {
      console.error(`Cron dispatch failed for org ${org.id}:`, e);
    }
  }
}

// --- Queue handler ---

async function handleQueue(
  batch: MessageBatch<AuditEvent | WebhookQueueMessage>,
  env: Env
): Promise<void> {
  const queueName = batch.queue;

  if (queueName === 'audit-log-queue') {
    await handleAuditBatch(batch as MessageBatch<AuditEvent>, env);
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

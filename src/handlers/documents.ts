// TRD §5.1 — Documents upload / list / detail / delete
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { emitAudit } from '../lib/audit';
import { getSharingFlags, parseParticipantUserIds } from '../lib/helpers';
import { isDocumentAccessibleToUser } from '../lib/document-acl';
import { persistDocument, type DocumentLink, type DocumentVisibility } from '../lib/persist-document';

const ALLOWED_VISIBILITIES: DocumentVisibility[] = ['private', 'org_wide', 'public', 'confidential'];

export async function listDocuments(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const contactId = url.searchParams.get('contact_id');
  const companyId = url.searchParams.get('company_id');
  const dealId = url.searchParams.get('deal_id');
  const conversationId = url.searchParams.get('conversation_id');
  const type = url.searchParams.get('document_type');

  // When an entity filter is supplied we route through document_links so a
  // doc linked via 'mentioned' or 'attached' shows up alongside 'primary'
  // links — the legacy scalar columns only ever held one entity per doc.
  const entityFilter =
    contactId      ? { type: 'contact', id: contactId }
    : companyId    ? { type: 'company', id: companyId }
    : dealId       ? { type: 'deal', id: dealId }
    : conversationId ? { type: 'conversation', id: conversationId }
    : null;

  const where: string[] = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  if (type) { where.push('d.document_type = ?'); binds.push(type); }

  const fromAndJoin = entityFilter
    ? `documents d
         JOIN document_links dl ON dl.document_id = d.id
        WHERE dl.entity_type = ? AND dl.entity_id = ?
          AND dl.deleted_at IS NULL
          AND ${where.join(' AND ')}`
    : `documents d WHERE ${where.join(' AND ')}`;

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const candidateBinds = entityFilter ? [entityFilter.type, entityFilter.id, ...binds] : binds;

  // ACL filter is applied in JS, not SQL: visibility/participant_user_ids
  // aren't structured for cheap SQL filtering (JSON-stringified array column),
  // and the documents corpus is small enough that an in-process filter is
  // cleaner than a CTE. Pull just IDs+ACL fields, filter+paginate, then fetch
  // full rows for the page.
  const [candidates, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT DISTINCT d.id, d.visibility, d.participant_user_ids, d.uploaded_by, d.created_at
         FROM ${fromAndJoin}
        ORDER BY d.created_at DESC`
    ).bind(...candidateBinds).all<{
      id: string;
      visibility: string | null;
      participant_user_ids: string | null;
      uploaded_by: string | null;
      created_at: string;
    }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const sharingSet = new Set(Object.keys(sharingFlags));
  const accessible = candidates.results.filter(doc =>
    isDocumentAccessibleToUser(doc, ctx.userId, ctx.userRole, sharingSet)
  );

  const total = accessible.length;
  const pageIds = accessible.slice(offset, offset + limit).map(d => d.id);

  if (pageIds.length === 0) {
    return jsonResponse({ documents: [], total, limit, offset, has_more: false });
  }

  const placeholders = pageIds.map(() => '?').join(',');
  const fullRows = await env.D1.prepare(
    `SELECT * FROM documents WHERE id IN (${placeholders}) ORDER BY created_at DESC`
  ).bind(...pageIds).all();

  return jsonResponse({
    documents: fullRows.results,
    total,
    limit,
    offset,
    has_more: offset + limit < total,
  });
}

export async function uploadDocument(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file') as File | null;
  if (!file) return errorResponse('VALIDATION_ERROR', 400, 'file required');

  const title = (form.get('title') as string) || file.name;
  const docType = (form.get('document_type') as string) || undefined;
  const contactId = form.get('contact_id') as string | null;
  const companyId = form.get('company_id') as string | null;
  const dealId = form.get('deal_id') as string | null;

  // ACL: caller may pass `visibility` and `participants`. Default flips to
  // 'private' for manual uploads (Wave 3a) — pre-Wave-3 the column-default
  // 'org_wide' silently made every uploaded file org-readable, including
  // confidential pitch decks. P3 (intelligent_import) and P4 (chat_save)
  // keep their org_wide defaults — different surfaces, different expectations.
  const rawVisibility = (form.get('visibility') as string) || 'private';
  if (!(ALLOWED_VISIBILITIES as string[]).includes(rawVisibility)) {
    return errorResponse('VALIDATION_ERROR', 400, `invalid visibility "${rawVisibility}" — allowed: ${ALLOWED_VISIBILITIES.join(', ')}`);
  }
  const visibility = rawVisibility as DocumentVisibility;

  const participantsRaw = form.get('participants') as string | null;
  let participantUserIds = participantsRaw ? parseParticipantUserIds(participantsRaw) : null;
  // For private/confidential uploads with no participants supplied, default
  // to the uploader so the row is readable by at least its creator at the
  // RAG layer (otherwise post-retrieval filter denies it). The full
  // participant picker is Wave 4.
  if ((visibility === 'private' || visibility === 'confidential') && (!participantUserIds || participantUserIds.length === 0)) {
    participantUserIds = [ctx.userId];
  }

  // Form fields → primary links. The first of these (contact ahead of company
  // ahead of deal) is what scalar contact_id/company_id/deal_id columns get.
  const links: DocumentLink[] = [];
  if (contactId) links.push({ entityType: 'contact', entityId: contactId, linkKind: 'primary', linkSource: 'manual' });
  if (companyId) links.push({ entityType: 'company', entityId: companyId, linkKind: 'primary', linkSource: 'manual' });
  if (dealId)    links.push({ entityType: 'deal',    entityId: dealId,    linkKind: 'primary', linkSource: 'manual' });

  const persisted = await persistDocument({
    file,
    orgId: ctx.orgId,
    source: 'manual_upload',
    visibility,
    participantUserIds,
    uploadedBy: ctx.userId,
    links,
    title,
    documentType: docType,
    embed: true,
  }, env);

  if (persisted.isExisting) {
    const dup = await env.D1.prepare('SELECT * FROM documents WHERE id = ?').bind(persisted.documentId).first();
    return jsonResponse({ document: dup, duplicate: true, message: 'Exact duplicate already exists' }, 200);
  }

  // Async finalize — extract + classify (if not user-provided) + embed + status='completed'.
  ctxExec.waitUntil(persisted.finalize());

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'document',
    entity_id: persisted.documentId,
    after_data: { title, file_name: file.name, document_type: docType || 'other' },
    created_at: new Date().toISOString(),
  });

  const doc = await env.D1.prepare('SELECT * FROM documents WHERE id = ?').bind(persisted.documentId).first();
  return jsonResponse({ document: doc }, 201);
}

async function loadDocumentForUser(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<any | null> {
  const doc = await env.D1.prepare(
    'SELECT * FROM documents WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first<any>();
  if (!doc) return null;

  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  const sharingSet = new Set(Object.keys(sharingFlags));
  if (!isDocumentAccessibleToUser(doc, ctx.userId, ctx.userRole, sharingSet)) {
    // Return 404, not 403 — don't disclose the existence of inaccessible docs.
    return null;
  }
  return doc;
}

export async function getDocument(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const doc = await loadDocumentForUser(id, ctx, env);
  if (!doc) return errorResponse('DOCUMENT_NOT_FOUND', 404);

  // R2 signed URL — Workers doesn't support native signed URLs, so return a
  // per-request proxy URL that the Worker will serve.
  const downloadUrl = `/api/documents/${id}/download`;

  return jsonResponse({ document: doc, downloadUrl });
}

export async function downloadDocument(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const doc = await loadDocumentForUser(id, ctx, env);
  if (!doc) return errorResponse('DOCUMENT_NOT_FOUND', 404);

  const obj = await env.R2.get(doc.r2_key);
  if (!obj) return errorResponse('DOCUMENT_NOT_FOUND', 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': doc.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${doc.file_name || 'document'}"`,
    },
  });
}

export async function deleteDocument(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  await env.D1.prepare(
    `UPDATE documents SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND org_id = ?`
  ).bind(id, ctx.orgId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'document',
    entity_id: id,
    created_at: new Date().toISOString(),
  });
  return jsonResponse({ ok: true });
}

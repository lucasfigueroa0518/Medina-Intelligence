// TRD §5.1 — Documents upload / list / detail / delete
import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { emitAudit } from '../lib/audit';
import { getSharingFlags, parseParticipantUserIds } from '../lib/helpers';
import { isDocumentAccessibleToUser } from '../lib/document-acl';
import { persistDocument, type DocumentLink, type DocumentVisibility } from '../lib/persist-document';
import { safelyRebuildContactDetailReadModelForContact } from '../lib/contact-detail-read-model';

const ALLOWED_VISIBILITIES: DocumentVisibility[] = ['private', 'org_wide', 'public', 'confidential'];

// Whitelisted sort columns. The list-page UI exposes file name + size + date;
// any other value falls back to created_at DESC. We can't bind a column name
// as a SQL parameter, so the keys here gate the user-supplied `sort` query
// param against an explicit allowlist before it reaches ORDER BY.
const SORT_COLUMN_MAP: Record<string, string> = {
  created_at: 'd.created_at',
  date: 'd.created_at',
  added: 'd.created_at',
  file_name: 'd.file_name',
  name: 'd.file_name',
  file_size: 'd.file_size',
  size: 'd.file_size',
};

function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export async function listDocuments(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const sp = url.searchParams;

  const contactId = sp.get('contact_id');
  const companyId = sp.get('company_id');
  const dealId = sp.get('deal_id');
  const conversationId = sp.get('conversation_id');

  // Multi-value filters: comma-separated CSV. parseList trims + drops empties.
  const sources = parseList(sp.get('source'));
  // document_type accepts both legacy single value and new CSV multi.
  const documentTypes = parseList(sp.get('document_type'));
  // mime_type CSV is matched as LIKE prefix patterns (each value gets a
  // '%' suffix). Drives the "PDFs"/"Images" quick filters which need to
  // span every variant of application/pdf, image/*, etc.
  const mimePrefixes = parseList(sp.get('mime_type'));

  // Wave 4 Q2 chose Option B — keyword LIKE on title + file_name only. No
  // full-text on extracted_text_preview (that's MARTy's job via vector search).
  const search = (sp.get('search') || '').trim();
  // ISO 8601 date strings. Compared lexicographically against created_at —
  // works because both sides are 'YYYY-MM-DDTHH:MM:fffZ' and same calendar.
  const dateFrom = sp.get('date_from');
  const dateTo = sp.get('date_to');
  // Convenience filter: uploaded_by = me. The "Mine" preset uses this rather
  // than asking the UI to know the current user's UUID.
  const minePreset = sp.get('mine') === 'true';

  // Wave 5 Phase B: junk-mime / placeholder rows are stamped
  // processing_status='excluded' (denylist applied at ingest pre-persist;
  // backfill via migration 0067). They're invisible to the list by default;
  // power-user / admin debug surfaces opt in via ?include_excluded=true.
  const includeExcluded = sp.get('include_excluded') === 'true';

  // Sort + order — whitelist column to prevent SQL injection. Default is
  // newest-added first (created_at DESC) which matches the contacts list UX.
  const sortKey = sp.get('sort') || 'created_at';
  const sortColumn = SORT_COLUMN_MAP[sortKey] || 'd.created_at';
  const sortDir = (sp.get('order') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // When an entity filter is supplied we route through document_links so a
  // doc linked via 'mentioned' or 'attached' shows up alongside 'primary'
  // links — the legacy scalar columns only ever held one entity per doc.
  const entityFilter =
    contactId      ? { type: 'contact', id: contactId }
    : companyId    ? { type: 'company', id: companyId }
    : dealId       ? { type: 'deal', id: dealId }
    : conversationId ? { type: 'conversation', id: conversationId }
    : null;

  const where: string[] = [
    'd.org_id = ?',
    'd.deleted_at IS NULL',
    "COALESCE(json_extract(d.custom_fields, '$.marty_lab_generated'), 0) != 1",
  ];
  const binds: unknown[] = [ctx.orgId];

  if (!includeExcluded) {
    where.push("d.processing_status != 'excluded'");
  }

  if (sources?.length) {
    where.push(`d.source IN (${sources.map(() => '?').join(',')})`);
    binds.push(...sources);
  }
  if (documentTypes?.length) {
    where.push(`d.document_type IN (${documentTypes.map(() => '?').join(',')})`);
    binds.push(...documentTypes);
  }
  if (mimePrefixes?.length) {
    where.push(`(${mimePrefixes.map(() => 'd.mime_type LIKE ?').join(' OR ')})`);
    binds.push(...mimePrefixes.map(p => `${p}%`));
  }
  if (search) {
    where.push('(d.title LIKE ? OR d.file_name LIKE ?)');
    const pat = `%${search}%`;
    binds.push(pat, pat);
  }
  if (dateFrom) {
    where.push('d.created_at >= ?');
    binds.push(dateFrom);
  }
  if (dateTo) {
    where.push('d.created_at < ?');
    binds.push(dateTo);
  }
  if (minePreset) {
    where.push('d.uploaded_by = ?');
    binds.push(ctx.userId);
  }

  const fromAndJoin = entityFilter
    ? `documents d
         JOIN document_links dl ON dl.document_id = d.id
        WHERE dl.entity_type = ? AND dl.entity_id = ?
          AND dl.deleted_at IS NULL
          AND ${where.join(' AND ')}`
    : `documents d WHERE ${where.join(' AND ')}`;

  const limit = Math.min(parseInt(sp.get('limit') || '100', 10), 500);
  const offset = parseInt(sp.get('offset') || '0', 10);

  const candidateBinds = entityFilter ? [entityFilter.type, entityFilter.id, ...binds] : binds;

  // ACL filter is applied in JS, not SQL: visibility/participant_user_ids
  // aren't structured for cheap SQL filtering (JSON-stringified array column),
  // and the documents corpus is small enough that an in-process filter is
  // cleaner than a CTE. Pull just IDs+ACL fields + sort columns, sort + filter
  // + paginate in JS, then fetch full rows for the page.
  //
  // SORT_COLUMN_MAP gates `sortColumn` against an allowlist so the
  // template-string interpolation is safe.
  const [candidates, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT DISTINCT d.id, d.visibility, d.participant_user_ids, d.uploaded_by,
                       d.created_at, d.file_name, d.file_size
         FROM ${fromAndJoin}
        ORDER BY ${sortColumn} ${sortDir}, d.id ${sortDir}`
    ).bind(...candidateBinds).all<{
      id: string;
      visibility: string | null;
      participant_user_ids: string | null;
      uploaded_by: string | null;
      created_at: string;
      file_name: string | null;
      file_size: number | null;
    }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  const sharingSet = new Set(Object.keys(sharingFlags));
  const accessible = candidates.results.filter(doc =>
    isDocumentAccessibleToUser(doc, ctx.userId, ctx.userRole, sharingSet)
  );

  const total = accessible.length;
  const pageOrder = accessible.slice(offset, offset + limit);
  const pageIds = pageOrder.map(d => d.id);

  if (pageIds.length === 0) {
    return jsonResponse({ documents: [], total, limit, offset, has_more: false });
  }

  // Fetch full rows by ID, then re-order to match the candidate sort. We
  // can't trust SQL ORDER BY on the IN-list query because SQLite doesn't
  // preserve the bind-order of an IN clause.
  //
  // LEFT JOIN to hydrate names of the legacy primary link (contact/company/
  // deal) so the list page can render "Linked entity" without a second round
  // trip. document_links junction is the truer source for multi-link docs,
  // but for Phase A the scalar primary-link columns are sufficient.
  const placeholders = pageIds.map(() => '?').join(',');
  const fullRows = await env.D1.prepare(
    `SELECT d.*,
            c.full_name  AS _contact_name,
            co.name      AS _company_name,
            de.title     AS _deal_title
       FROM documents d
       LEFT JOIN contacts  c  ON c.id  = d.contact_id  AND c.deleted_at  IS NULL
       LEFT JOIN companies co ON co.id = d.company_id  AND co.deleted_at IS NULL
       LEFT JOIN deals     de ON de.id = d.deal_id     AND de.deleted_at IS NULL
      WHERE d.id IN (${placeholders})`
  ).bind(...pageIds).all<{ id: string; [k: string]: unknown }>();
  const idIndex = new Map(pageIds.map((id, i) => [id, i]));
  const ordered = [...fullRows.results].sort(
    (a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0)
  );

  return jsonResponse({
    documents: ordered,
    total,
    limit,
    offset,
    has_more: offset + limit < total,
  });
}

// --- GET /api/documents/filter-counts ---
//
// Returns counts for every facet the /documents list page exposes. Mirrors
// the contacts/companies filter-counts pattern. Counts are NOT ACL-filtered
// — facet badges show org-level totals, which is consistent with how the
// contacts page works (showing "Investor (12)" even if the user can only
// access 8 of those 12).
export async function getDocumentFilterCounts(
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  // Wave 5 Phase B: facet counts exclude denylisted ('excluded') rows so
  // the badges reconcile with the default list view, which also hides them.
  const [sourceCounts, typeCounts, dateBucketRow, mineRow] = await Promise.all([
    env.D1.prepare(
      `SELECT source, COUNT(*) as cnt FROM documents
        WHERE org_id = ? AND deleted_at IS NULL AND processing_status != 'excluded'
          AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1
        GROUP BY source`
    ).bind(ctx.orgId).all<{ source: string; cnt: number }>(),

    env.D1.prepare(
      `SELECT document_type, COUNT(*) as cnt FROM documents
        WHERE org_id = ? AND deleted_at IS NULL AND processing_status != 'excluded'
          AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1
        GROUP BY document_type`
    ).bind(ctx.orgId).all<{ document_type: string; cnt: number }>(),

    env.D1.prepare(
      `SELECT
         SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')  THEN 1 ELSE 0 END) as last_7d,
         SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') THEN 1 ELSE 0 END) as last_30d,
         SUM(CASE WHEN created_at <  strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') THEN 1 ELSE 0 END) as older
       FROM documents
       WHERE org_id = ? AND deleted_at IS NULL AND processing_status != 'excluded'
         AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1`
    ).bind(ctx.orgId).first<{ last_7d: number; last_30d: number; older: number }>(),

    env.D1.prepare(
      `SELECT COUNT(*) as cnt FROM documents
        WHERE org_id = ? AND deleted_at IS NULL AND processing_status != 'excluded'
          AND COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1
          AND uploaded_by = ?`
    ).bind(ctx.orgId, ctx.userId).first<{ cnt: number }>(),
  ]);

  const source: Record<string, number> = {};
  for (const r of sourceCounts.results) source[r.source] = r.cnt;

  const document_type: Record<string, number> = {};
  for (const r of typeCounts.results) document_type[r.document_type] = r.cnt;

  return jsonResponse({
    source,
    document_type,
    date_bucket: {
      last_7d: dateBucketRow?.last_7d || 0,
      last_30d: dateBucketRow?.last_30d || 0,
      older: dateBucketRow?.older || 0,
    },
    mine: mineRow?.cnt || 0,
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
  if (contactId) {
    ctxExec.waitUntil(safelyRebuildContactDetailReadModelForContact(
      env,
      ctx.orgId,
      contactId,
      'document_uploaded'
    ));
  }

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

// Exported for Phase H Send-to-MARTy endpoint — same ACL gate (visibility +
// participant_user_ids + sharing flags) so an attach-document call can't
// bypass the access checks.
export async function loadDocumentForUser(
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
  const linkedContacts = await env.D1.prepare(
    `SELECT entity_id FROM document_links
      WHERE document_id = ? AND org_id = ? AND entity_type = 'contact' AND deleted_at IS NULL`
  ).bind(id, ctx.orgId).all<{ entity_id: string }>();

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
  await Promise.all(linkedContacts.results.map(row =>
    safelyRebuildContactDetailReadModelForContact(env, ctx.orgId, row.entity_id, 'document_deleted')
  ));
  return jsonResponse({ ok: true });
}

// TRD §5.1 — Documents upload / list / detail / delete
import type { Env } from '../types/env';
import type { AuthContext, ChunkMetadata } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { emitAudit } from '../lib/audit';
import { extractTextFromFile } from '../lib/file-extraction';
import { chunkEmbedAndPersistAll } from '../lib/embedding';
import { classifyDocument } from '../lib/document-intelligence';
import { getSharingFlags } from '../lib/helpers';
import { isDocumentAccessibleToUser } from '../lib/document-acl';

async function computeContentHash(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function stripVersionSuffix(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[\s_-]*(v\d+|draft|final|rev\d*|copy|revised|updated)$/i, '')
    .trim()
    .toLowerCase();
}

async function findExistingVersion(
  contentHash: string,
  fileName: string,
  orgId: string,
  contactId: string | null,
  companyId: string | null,
  env: Env
): Promise<{ type: 'exact_dup'; id: string } | { type: 'version'; parentId: string; nextVersion: number } | null> {
  const byHash = await env.D1.prepare(
    'SELECT id FROM documents WHERE org_id = ? AND content_hash = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, contentHash).first<{ id: string }>();
  if (byHash) return { type: 'exact_dup', id: byHash.id };

  const baseName = stripVersionSuffix(fileName);
  if (!baseName) return null;

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [orgId];
  if (contactId) { where.push('contact_id = ?'); binds.push(contactId); }
  else if (companyId) { where.push('company_id = ?'); binds.push(companyId); }

  const candidates = await env.D1.prepare(
    `SELECT id, file_name, version_number, parent_document_id
     FROM documents WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT 100`
  ).bind(...binds).all<{ id: string; file_name: string | null; version_number: number | null; parent_document_id: string | null }>();

  for (const c of candidates.results) {
    if (!c.file_name) continue;
    if (stripVersionSuffix(c.file_name) === baseName) {
      const parentId = c.parent_document_id || c.id;
      const currentVersion = c.version_number || 1;
      return { type: 'version', parentId, nextVersion: currentVersion + 1 };
    }
  }

  return null;
}

export async function listDocuments(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const contactId = url.searchParams.get('contact_id');
  const companyId = url.searchParams.get('company_id');
  const type = url.searchParams.get('document_type');

  const where: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  if (contactId) { where.push('contact_id = ?'); binds.push(contactId); }
  if (companyId) { where.push('company_id = ?'); binds.push(companyId); }
  if (type) { where.push('document_type = ?'); binds.push(type); }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const whereClause = where.join(' AND ');

  // ACL filter is applied in JS, not SQL: visibility/participant_user_ids
  // aren't structured for cheap SQL filtering (JSON-stringified array column),
  // and the documents corpus is small enough that an in-process filter is
  // cleaner than a CTE. Pull just IDs+ACL fields, filter+paginate, then fetch
  // full rows for the page.
  const [candidates, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT id, visibility, participant_user_ids, uploaded_by
       FROM documents WHERE ${whereClause} ORDER BY created_at DESC`
    ).bind(...binds).all<{
      id: string;
      visibility: string | null;
      participant_user_ids: string | null;
      uploaded_by: string | null;
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
  const docType = (form.get('document_type') as string) || 'other';
  const contactId = form.get('contact_id') as string | null;
  const companyId = form.get('company_id') as string | null;
  const dealId = form.get('deal_id') as string | null;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `${ctx.orgId}/document/${now.slice(0, 7)}/${id}_${file.name}`;

  const buffer = await file.arrayBuffer();
  const contentHash = await computeContentHash(buffer);

  const existing = await findExistingVersion(contentHash, file.name, ctx.orgId, contactId, companyId, env);
  if (existing?.type === 'exact_dup') {
    const dup = await env.D1.prepare('SELECT * FROM documents WHERE id = ?').bind(existing.id).first();
    return jsonResponse({ document: dup, duplicate: true, message: 'Exact duplicate already exists' }, 200);
  }

  const parentId = existing?.type === 'version' ? existing.parentId : null;
  const versionNum = existing?.type === 'version' ? existing.nextVersion : 1;

  await env.R2.put(r2Key, buffer);

  await env.D1.prepare(
    `INSERT INTO documents
       (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
        contact_id, company_id, deal_id, uploaded_by, processing_status,
        content_hash, parent_document_id, version_number,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      ctx.orgId,
      title,
      docType,
      r2Key,
      file.name,
      file.size,
      file.type || null,
      contactId,
      companyId,
      dealId,
      ctx.userId,
      contentHash,
      parentId,
      versionNum,
      now,
      now
    )
    .run();

  ctxExec.waitUntil(
    (async () => {
      try {
        await env.D1.prepare(
          `UPDATE documents SET processing_status = 'processing' WHERE id = ?`
        ).bind(id).run();

        const text = await extractTextFromFile(file);
        const preview = text.slice(0, 500);

        let classifiedType = docType;
        if (text.length > 20) {
          try {
            const cls = await classifyDocument(text, file.name, env, ctx.orgId);
            classifiedType = cls.category;
          } catch { /* keep user-provided type */ }
        }

        const meta: ChunkMetadata = {
          org_id: ctx.orgId,
          document_type: classifiedType,
          source_table: 'documents',
          source_id: id,
          r2_key: r2Key,
          visibility: 'org_wide',
          primary_entity_id: contactId || companyId || dealId || id,
          created_at: now,
          entity_name: title,
        };

        if (text.length > 10) {
          const entries = await chunkEmbedAndPersistAll(text, meta, env);
          if (entries.length > 0) {
            await env.D1.batch(
              entries.map(e =>
                env.D1
                  .prepare(
                    'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
                  )
                  .bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
              )
            );
          }
        }

        await env.D1.prepare(
          `UPDATE documents SET processing_status = 'completed', document_type = ?, extracted_text_preview = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).bind(classifiedType, preview, id).run();
      } catch (e) {
        await env.D1.prepare(
          `UPDATE documents SET processing_status = 'failed' WHERE id = ?`
        ).bind(id).run();
        console.error(`Document processing failed for ${id}:`, e);
      }
    })()
  );

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'create',
    entity_type: 'document',
    entity_id: id,
    after_data: { title, file_name: file.name, document_type: docType },
    created_at: now,
  });

  const doc = await env.D1.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
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

// TRD §5.1 — Documents upload / list / detail / delete
import type { Env } from '../types/env';
import type { AuthContext, ChunkMetadata } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { emitAudit } from '../lib/audit';
import { extractTextFromFile } from '../lib/file-extraction';
import { chunkEmbedAndPersistAll } from '../lib/embedding';

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

  const result = await env.D1.prepare(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`
  ).bind(...binds).all();
  return jsonResponse({ documents: result.results });
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
  await env.R2.put(r2Key, buffer);

  await env.D1.prepare(
    `INSERT INTO documents
       (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
        contact_id, company_id, deal_id, uploaded_by, processing_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
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
      now,
      now
    )
    .run();

  // Async processing: extract text, embed, update status
  ctxExec.waitUntil(
    (async () => {
      try {
        await env.D1.prepare(
          `UPDATE documents SET processing_status = 'processing' WHERE id = ?`
        ).bind(id).run();

        const text = await extractTextFromFile(file);
        const preview = text.slice(0, 500);

        const meta: ChunkMetadata = {
          org_id: ctx.orgId,
          document_type: 'document',
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
          `UPDATE documents SET processing_status = 'completed', extracted_text_preview = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).bind(preview, id).run();
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

export async function getDocument(
  id: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const doc = await env.D1.prepare(
    'SELECT * FROM documents WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first<any>();
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
  const doc = await env.D1.prepare(
    'SELECT * FROM documents WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.orgId).first<any>();
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

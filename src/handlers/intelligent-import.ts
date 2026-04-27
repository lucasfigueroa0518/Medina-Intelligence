import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { processIntelligentImport, type ImportResult } from '../lib/document-intelligence';

const SUPPORTED_TYPES = new Set([
  'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'application/json',
]);

const SUPPORTED_EXTENSIONS = new Set([
  '.csv', '.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.txt', '.md', '.json',
]);

export async function intelligentImport(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file') as File | null;
  if (!file) return errorResponse('VALIDATION_ERROR', 400, 'file required');

  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!SUPPORTED_TYPES.has(file.type) && !SUPPORTED_EXTENSIONS.has(ext)) {
    return errorResponse('UNSUPPORTED_FILE_TYPE', 400, `Unsupported file type: ${file.type || ext}`);
  }

  if (file.size > 25 * 1024 * 1024) {
    return errorResponse('FILE_TOO_LARGE', 400, 'Maximum file size is 25MB');
  }

  const sync = form.get('sync') === 'true';

  if (sync) {
    try {
      const result = await processIntelligentImport(file, ctx.orgId, ctx.userId, env);
      return jsonResponse({ result }, 200);
    } catch (e: any) {
      console.error('[intelligent-import] sync processing failed:', e);
      return errorResponse('PROCESSING_FAILED', 500, e.message);
    }
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `${ctx.orgId}/imports/${now.slice(0, 7)}/${jobId}_${file.name}`;

  const buffer = await file.arrayBuffer();
  await env.R2.put(r2Key, buffer);

  await env.D1.prepare(
    `INSERT INTO import_jobs (id, org_id, created_by, source_type, source_r2_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'intelligent', ?, 'processing', ?, ?)`
  ).bind(jobId, ctx.orgId, ctx.userId, r2Key, now, now).run();

  ctxExec.waitUntil(
    (async () => {
      try {
        const result = await processIntelligentImport(file, ctx.orgId, ctx.userId, env);

        await env.D1.prepare(
          `UPDATE import_jobs SET
             status = 'completed',
             total_rows = ?, created_rows = ?, updated_rows = ?,
             processed_rows = ?, skipped_rows = 0, failed_rows = ?
           WHERE id = ?`
        ).bind(
          result.contacts_created + result.companies_created + result.deals_created + result.contacts_updated + result.companies_updated,
          result.contacts_created + result.companies_created + result.deals_created,
          result.contacts_updated + result.companies_updated,
          result.entities_routed,
          result.errors.length,
          jobId
        ).run();
      } catch (e: any) {
        console.error('[intelligent-import] async processing failed:', e);
        await env.D1.prepare(
          `UPDATE import_jobs SET status = 'failed' WHERE id = ?`
        ).bind(jobId).run();
      }
    })()
  );

  return jsonResponse({
    job_id: jobId,
    status: 'processing',
    message: 'Document intelligence pipeline started. Poll GET /api/imports/:id for status.',
  }, 202);
}

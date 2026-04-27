import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse } from './utils';
import { processIntelligentImport } from '../lib/document-intelligence';
import { emitAudit } from '../lib/audit';

// Always async — the upload returns 202 with a job_id immediately so the UI
// is free to navigate away. Processing runs in waitUntil and the user polls
// GET /api/imports/:id (or sees the job in the listing on /imports) to find
// out when it completes.
export async function intelligentImport(
  request: Request,
  ctx: AuthContext,
  env: Env,
  ctxExec: ExecutionContext
): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file') as File | null;
  if (!file) return errorResponse('VALIDATION_ERROR', 400, 'file required');

  // No file-type filter — every file is accepted. Text-extractable formats
  // (PDF/DOCX/XLSX/CSV/TXT/MD/JSON) get LLM extraction; everything else is
  // still stored in R2, classified as `reference`, and made downloadable.
  if (file.size > 25 * 1024 * 1024) {
    return errorResponse('FILE_TOO_LARGE', 400, 'Maximum file size is 25MB');
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `${ctx.orgId}/imports/${now.slice(0, 7)}/${jobId}_${file.name}`;

  // Persist the raw upload + an import_jobs row before we return so the UI
  // can poll immediately.
  const buffer = await file.arrayBuffer();
  await env.R2.put(r2Key, buffer);

  await env.D1.prepare(
    `INSERT INTO import_jobs (id, org_id, created_by, source_type, source_r2_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'intelligent', ?, 'processing', ?, ?)`
  ).bind(jobId, ctx.orgId, ctx.userId, r2Key, now, now).run();

  // Re-create a File from the buffer for the background task — the original
  // request body is consumed by formData() above and isn't safe to pass into
  // waitUntil where the request lifetime has already ended.
  const fileForBg = new File([buffer], file.name, { type: file.type });

  ctxExec.waitUntil(
    (async () => {
      try {
        const result = await processIntelligentImport(
          fileForBg, ctx.orgId, ctx.userId, env, jobId
        );

        await env.D1.prepare(
          `UPDATE import_jobs SET
             status = 'completed',
             total_rows = ?, created_rows = ?, updated_rows = ?,
             processed_rows = ?, skipped_rows = 0, failed_rows = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
          `UPDATE import_jobs SET status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        ).bind(jobId).run();
      }
    })()
  );

  return jsonResponse({
    job_id: jobId,
    status: 'processing',
    file_name: file.name,
    message: 'Import started — you can navigate away. Poll GET /api/imports/:id for status.',
  }, 202);
}

// ────────────────────────────────────────────────────────────────────────────
// Undo — soft-deletes every entity the import CREATED and removes the
// document's Vectorize chunks. Updates to pre-existing entities are
// intentionally not reverted (they entangle with subsequent enrichment).
// ────────────────────────────────────────────────────────────────────────────

export async function undoImport(
  jobId: string,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  const job = await env.D1.prepare(
    `SELECT id, org_id, status FROM import_jobs WHERE id = ? AND org_id = ?`
  ).bind(jobId, ctx.orgId).first<{ id: string; org_id: string; status: string }>();
  if (!job) return errorResponse('NOT_FOUND', 404, 'Import job not found');
  if (job.status === 'reverted') {
    return errorResponse('ALREADY_REVERTED', 409, 'This import has already been reverted');
  }

  const lineage = await env.D1.prepare(
    `SELECT entity_type, entity_id FROM import_lineage WHERE import_job_id = ?`
  ).bind(jobId).all<{ entity_type: string; entity_id: string }>();

  const counts = { document: 0, contact: 0, company: 0, deal: 0, vectors: 0 };
  const now = new Date().toISOString();

  for (const row of lineage.results) {
    try {
      switch (row.entity_type) {
        case 'document': {
          await env.D1.prepare(
            `UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`
          ).bind(now, now, row.entity_id, ctx.orgId).run();

          // Drop Vectorize chunks for this document so it stops appearing
          // in MARTy retrieval immediately.
          const vectors = await env.D1.prepare(
            `SELECT vector_id FROM vector_entity_index WHERE entity_id = ? AND source_table = 'documents'`
          ).bind(row.entity_id).all<{ vector_id: string }>();
          const vectorIds = vectors.results.map(v => v.vector_id);
          if (vectorIds.length > 0) {
            try {
              await env.VECTORIZE.deleteByIds(vectorIds);
            } catch (e) {
              console.error('[undo] vectorize delete failed:', e);
            }
            await env.D1.batch(
              vectorIds.map(id =>
                env.D1.prepare(`DELETE FROM vector_entity_index WHERE vector_id = ?`).bind(id)
              )
            );
            // Best-effort KV cleanup for chunk text payloads.
            await Promise.all(vectorIds.map(id => env.KV.delete(`chunk:${id}`).catch(() => undefined)));
            counts.vectors += vectorIds.length;
          }
          counts.document++;
          break;
        }
        case 'contact':
          await env.D1.prepare(
            `UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`
          ).bind(now, now, row.entity_id, ctx.orgId).run();
          counts.contact++;
          break;
        case 'company':
          await env.D1.prepare(
            `UPDATE companies SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`
          ).bind(now, now, row.entity_id, ctx.orgId).run();
          counts.company++;
          break;
        case 'deal':
          await env.D1.prepare(
            `UPDATE deals SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`
          ).bind(now, now, row.entity_id, ctx.orgId).run();
          counts.deal++;
          break;
      }
    } catch (e: any) {
      console.error(`[undo] ${row.entity_type}/${row.entity_id} failed:`, e);
    }
  }

  await env.D1.prepare(
    `UPDATE import_jobs SET status = 'reverted', updated_at = ? WHERE id = ?`
  ).bind(now, jobId).run();

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'soft_delete',
    entity_type: 'import_job',
    entity_id: jobId,
    metadata: { reason: 'undo_import', ...counts },
    created_at: now,
  });

  return jsonResponse({
    ok: true,
    job_id: jobId,
    reverted: counts,
    note: 'Updates to pre-existing entities (e.g. enriched fields on a contact that already existed) are not reverted.',
  });
}

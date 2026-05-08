import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { processIntelligentImport } from '../document-intelligence';

interface IntelligentImportPayload {
  import_job_id: string;
  r2_key?: string;
  file_name?: string;
  mime_type?: string | null;
  user_id?: string | null;
}

interface ImportJobRow {
  id: string;
  org_id: string;
  created_by: string | null;
  source_r2_key: string;
  status: string;
}

function decodePayload(raw: string): IntelligentImportPayload {
  const parsed = JSON.parse(raw) as IntelligentImportPayload;
  if (!parsed.import_job_id) {
    throw new Error(`payload missing import_job_id: ${raw}`);
  }
  return parsed;
}

function fileNameFrom(job: ImportJobRow, payload: IntelligentImportPayload): string {
  if (payload.file_name) return payload.file_name;
  const keyName = job.source_r2_key.split('/').pop() || 'imported-file';
  const prefix = `${job.id}_`;
  return keyName.startsWith(prefix) ? keyName.slice(prefix.length) : keyName;
}

async function markImportFailed(env: Env, jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const key = `import-errors/${jobId}.txt`;
  try {
    await env.R2.put(key, message);
  } catch {
    // Keep the job status update as the source of truth if error-log storage fails.
  }
  await env.D1.prepare(
    `UPDATE import_jobs
        SET status = 'failed',
            error_log_r2_key = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(key, jobId).run();
}

export const intelligentImportHandler: WorkQueueHandler = {
  domain: 'intelligent_import',
  batchSize: 1,
  maxConcurrent: 1,
  cadence: 'minute',

  process: async (item, env) => {
    const payload = decodePayload(item.payload);
    const job = await env.D1.prepare(
      `SELECT id, org_id, created_by, source_r2_key, status
         FROM import_jobs
        WHERE id = ? AND org_id = ?`
    ).bind(payload.import_job_id, item.org_id).first<ImportJobRow>();

    if (!job) {
      console.warn(`[intelligent-import] job ${payload.import_job_id} not found; completing orphaned work row`);
      return;
    }

    if (['completed', 'reverted', 'cancelled'].includes(job.status)) {
      console.log(`[intelligent-import] job ${job.id} already ${job.status}; skipping`);
      return;
    }

    if (job.status === 'failed') {
      console.log(`[intelligent-import] job ${job.id} already failed; skipping`);
      return;
    }

    const object = await env.R2.get(payload.r2_key || job.source_r2_key);
    if (!object) {
      await markImportFailed(env, job.id, 'source file missing from R2');
      throw new Error(`source file missing for import ${job.id}`);
    }

    const fileName = fileNameFrom(job, payload);
    const arrayBuffer = await object.arrayBuffer();
    const file = new File([arrayBuffer], fileName, {
      type: payload.mime_type || object.httpMetadata?.contentType || 'application/octet-stream',
    });

    await env.D1.prepare(
      `UPDATE import_jobs
          SET status = 'processing',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(job.id).run();

    try {
      console.log(`[intelligent-import] processing job=${job.id} file="${fileName}"`);
      const result = await processIntelligentImport(
        file,
        job.org_id,
        job.created_by || payload.user_id || '',
        env,
        job.id
      );

      const created = result.contacts_created + result.companies_created + result.deals_created;
      const updated = result.contacts_updated + result.companies_updated;
      const total = created + updated;

      await env.D1.prepare(
        `UPDATE import_jobs SET
           status = 'completed',
           total_rows = ?,
           created_rows = ?,
           updated_rows = ?,
           processed_rows = ?,
           skipped_rows = 0,
           failed_rows = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      ).bind(
        total,
        created,
        updated,
        result.entities_routed,
        result.errors.length,
        job.id
      ).run();

      console.log(
        `[intelligent-import] completed job=${job.id} created=${created} updated=${updated} routed=${result.entities_routed} errors=${result.errors.length}`
      );
    } catch (e) {
      if (item.attempt + 1 >= item.max_attempts) {
        await markImportFailed(env, job.id, e);
      } else {
        await env.D1.prepare(
          `UPDATE import_jobs
              SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`
        ).bind(job.id).run();
      }
      throw e;
    }
  },
};

import type { Env } from '../../types/env';
import type { WorkQueueHandler } from '../work-queue-driver';
import { enqueueWork } from '../work-queue';
import { processIntelligentImport } from '../document-intelligence';

interface IntelligentImportPayload {
  import_job_id: string;
  r2_key?: string;
  file_name?: string;
  mime_type?: string | null;
  user_id?: string | null;
  cursor?: number | null;
}

interface ImportJobRow {
  id: string;
  org_id: string;
  created_by: string | null;
  source_r2_key: string;
  status: string;
  processed_rows: number | null;
  created_rows: number | null;
  updated_rows: number | null;
  failed_rows: number | null;
}

interface ImportProgressRow {
  processed_rows: number | null;
  created_rows: number | null;
  updated_rows: number | null;
  failed_rows: number | null;
}

const IMPORT_UNITS_PER_WORK_ITEM = 500;

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
      `SELECT id, org_id, created_by, source_r2_key, status,
              processed_rows, created_rows, updated_rows, failed_rows
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
      const startAt = Math.max(0, payload.cursor || job.processed_rows || 0);
      const result = await processIntelligentImport(
        file,
        job.org_id,
        job.created_by || payload.user_id || '',
        env,
        job.id,
        {
          startAt,
          maxUnits: IMPORT_UNITS_PER_WORK_ITEM,
        }
      );

      if (!result.completed) {
        const nextStart = result.next_start ?? startAt;
        await enqueueWork(
          env,
          job.org_id,
          'intelligent_import',
          {
            import_job_id: job.id,
            r2_key: payload.r2_key || job.source_r2_key,
            file_name: fileName,
            mime_type: payload.mime_type || object.httpMetadata?.contentType || null,
            user_id: job.created_by || payload.user_id || null,
            cursor: nextStart,
          },
          {
            upstream: 'claude',
            idempotency_key: `${job.org_id}:${job.id}:intelligent_import:${nextStart}`,
            max_attempts: 3,
            priority: 5,
          }
        );
        console.log(
          `[intelligent-import] paused job=${job.id} cursor=${nextStart}/${result.total_units ?? '?'}; continuation queued`
        );
        return;
      }

      const finalProgress = await env.D1.prepare(
        `SELECT processed_rows, created_rows, updated_rows, failed_rows
           FROM import_jobs
          WHERE id = ? AND org_id = ?
          LIMIT 1`
      ).bind(job.id, job.org_id).first<ImportProgressRow>();

      const chunkCreated = result.contacts_created + result.companies_created + result.deals_created;
      const chunkUpdated = result.contacts_updated + result.companies_updated;
      const created = Math.max(finalProgress?.created_rows || 0, chunkCreated);
      const updated = Math.max(finalProgress?.updated_rows || 0, chunkUpdated);
      const failed = Math.max(finalProgress?.failed_rows || 0, result.errors.length);
      const processed = result.total_units || finalProgress?.processed_rows || result.entities_routed;

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
        processed,
        created,
        updated,
        processed,
        failed,
        job.id
      ).run();

      console.log(
        `[intelligent-import] completed job=${job.id} created=${created} updated=${updated} processed=${processed} errors=${failed}`
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

import type { WorkQueueHandler } from '../work-queue-driver';
import { runAttachmentBackfillBatch } from '../attachment-backfill-orchestrator';
import { recordRateLimit } from '../upstream-budget';
import { deadLetterWork } from '../work-queue';

interface AttachmentBackfillPayload {
  conversation_id: string;
  preferred_user_id?: string | null;
  origin: 'divergence_scan' | 'manual' | 'graph_webhook';
  detected_at: string;
}

function parsePayload(payload: string): AttachmentBackfillPayload {
  const parsed = JSON.parse(payload) as AttachmentBackfillPayload;
  if (!parsed.conversation_id) throw new Error(`payload missing conversation_id: ${payload}`);
  return parsed;
}

export const attachmentBackfillHandler: WorkQueueHandler = {
  domain: 'attachment_backfill',
  batchSize: 3,
  maxConcurrent: 3,
  cadence: 'minute',

  process: async (item, env) => {
    let payload: AttachmentBackfillPayload;
    try {
      payload = parsePayload(item.payload);
    } catch (e) {
      await deadLetterWork(env, item.id, `malformed attachment_backfill payload: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const user = payload.preferred_user_id
      ? { id: payload.preferred_user_id }
      : await env.D1.prepare(
          `SELECT id FROM users
            WHERE org_id = ? AND deleted_at IS NULL
            ORDER BY created_at ASC
            LIMIT 1`
        ).bind(item.org_id).first<{ id: string }>();

    if (!user?.id) {
      await deadLetterWork(env, item.id, 'missing_token: no active org user available for attachment backfill');
      return;
    }

    const result = await runAttachmentBackfillBatch({
      orgId: item.org_id,
      userId: user.id,
      conversationIds: [payload.conversation_id],
      concurrency: 1,
    }, env);

    if (result.errors.length === 0) return;

    const sample = result.errors.map(e => `${e.phase}:${e.error}`).join(' | ');
    if (/\bgraph\s+429\b|rate.?limit/i.test(sample)) {
      await recordRateLimit(env, item.org_id, null, 'graph', 'ten_minute');
      throw new Error(`attachment_backfill_graph_429: ${sample.slice(0, 500)}`);
    }

    if (/no valid token|missing_token|invalid_grant|reauth|required|revoked/i.test(sample)) {
      await deadLetterWork(env, item.id, `missing_token: attachment backfill auth blocked for ${payload.conversation_id}: ${sample.slice(0, 500)}`);
      return;
    }

    if (result.attachments_persisted === 0 && result.attachments_skipped_unrecoverable === 0 && result.attachments_failed > 0) {
      throw new Error(`attachment_backfill_failed: ${sample.slice(0, 500)}`);
    }
  },
};

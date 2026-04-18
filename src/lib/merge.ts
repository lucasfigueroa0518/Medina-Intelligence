// TRD §7.6 — Contact merge (atomic batch, lock guard, vector cleanup)
import type { Env } from '../types/env';
import type { MergeResult } from '../types/interfaces';
import { chunkArray } from './helpers';
import { emitAudit } from './audit';
import { invalidateRagCache } from './cache';

export async function mergeContacts(
  keepId: string,
  discardId: string,
  userId: string,
  orgId: string,
  env: Env
): Promise<MergeResult> {
  const lockExpiry = new Date(Date.now() + 300000).toISOString();

  try {
    await env.D1.batch([
      env.D1.prepare(
        'INSERT INTO merge_locks (contact_id, locked_by, expires_at) VALUES (?,?,?)'
      ).bind(keepId, userId, lockExpiry),
      env.D1.prepare(
        'INSERT INTO merge_locks (contact_id, locked_by, expires_at) VALUES (?,?,?)'
      ).bind(discardId, userId, lockExpiry),
    ]);
  } catch {
    return { success: false, error: 'MERGE_LOCK_CONFLICT' };
  }

  const activeCampaign = await env.D1.prepare(
    `SELECT ecr.campaign_id FROM email_campaign_recipients ecr
     JOIN email_campaigns ec ON ecr.campaign_id = ec.id
     WHERE ecr.contact_id IN (?, ?)
       AND ec.status IN ('sending','scheduled')
       AND ec.deleted_at IS NULL`
  ).bind(keepId, discardId).first();

  if (activeCampaign) {
    await releaseMergeLocks(keepId, discardId, env);
    return { success: false, error: 'ACTIVE_CAMPAIGN' };
  }

  const snapshot = await env.D1.prepare('SELECT * FROM contacts WHERE id = ?')
    .bind(discardId)
    .first();

  try {
    await env.D1.batch([
      env.D1.prepare(
        'UPDATE OR IGNORE email_campaign_recipients SET contact_id = ? WHERE contact_id = ?'
      ).bind(keepId, discardId),
      env.D1.prepare(
        'DELETE FROM email_campaign_recipients WHERE contact_id = ?'
      ).bind(discardId),
      env.D1.prepare(
        'UPDATE OR IGNORE conversation_contacts SET contact_id = ? WHERE contact_id = ?'
      ).bind(keepId, discardId),
      env.D1.prepare(
        'DELETE FROM conversation_contacts WHERE contact_id = ?'
      ).bind(discardId),
      env.D1.prepare(
        'UPDATE event_attendees SET contact_id = ? WHERE contact_id = ?'
      ).bind(keepId, discardId),
      env.D1.prepare(
        'UPDATE OR IGNORE contact_associations SET contact_id_a = ? WHERE contact_id_a = ?'
      ).bind(keepId, discardId),
      env.D1.prepare(
        'UPDATE OR IGNORE contact_associations SET contact_id_b = ? WHERE contact_id_b = ?'
      ).bind(keepId, discardId),
      env.D1.prepare(
        'DELETE FROM contact_associations WHERE contact_id_a = ? OR contact_id_b = ?'
      ).bind(discardId, discardId),
      env.D1.prepare(
        'UPDATE OR IGNORE contact_tags SET contact_id = ? WHERE contact_id = ?'
      ).bind(keepId, discardId),
      env.D1.prepare('DELETE FROM contact_tags WHERE contact_id = ?').bind(discardId),
      env.D1.prepare('UPDATE tasks SET contact_id = ? WHERE contact_id = ?').bind(
        keepId,
        discardId
      ),
      env.D1.prepare('UPDATE documents SET contact_id = ? WHERE contact_id = ?').bind(
        keepId,
        discardId
      ),
      env.D1.prepare(
        `UPDATE contacts SET merged_into = ?, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(keepId, discardId),
      env.D1.prepare(
        `UPDATE contacts SET total_interactions = total_interactions + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind((snapshot as any)?.total_interactions || 0, keepId),
    ]);
  } catch (e) {
    await releaseMergeLocks(keepId, discardId, env);
    return { success: false, error: 'MERGE_FAILED', message: (e as Error).message };
  }

  try {
    await cleanupVectorsForEntity(discardId, 'contacts', env);
  } catch (e) {
    console.error('Vector cleanup failed, daily sweep will catch:', e);
  }

  await releaseMergeLocks(keepId, discardId, env);

  await emitAudit(env, {
    org_id: orgId,
    user_id: userId,
    action: 'merge',
    entity_type: 'contact',
    entity_id: keepId,
    before_data: snapshot,
    metadata: { keep_id: keepId, discard_id: discardId },
    created_at: new Date().toISOString(),
  });

  await invalidateRagCache(orgId, env);
  return { success: true };
}

export async function resolveMergedContact(
  contactId: string,
  env: Env
): Promise<string> {
  let id = contactId;
  let depth = 0;
  while (depth < 5) {
    const c = await env.D1.prepare('SELECT merged_into FROM contacts WHERE id = ?')
      .bind(id)
      .first<{ merged_into: string | null }>();
    if (!c?.merged_into) break;
    id = c.merged_into;
    depth++;
  }
  return id;
}

export async function releaseMergeLocks(
  keepId: string,
  discardId: string,
  env: Env
): Promise<void> {
  try {
    await env.D1.batch([
      env.D1.prepare('DELETE FROM merge_locks WHERE contact_id = ?').bind(keepId),
      env.D1.prepare('DELETE FROM merge_locks WHERE contact_id = ?').bind(discardId),
    ]);
  } catch {
    /* ignore */
  }
}

export async function cleanupVectorsForEntity(
  entityId: string,
  sourceTable: string,
  env: Env
): Promise<void> {
  const vectors = await env.D1.prepare(
    'SELECT vector_id FROM vector_entity_index WHERE entity_id = ? AND source_table = ?'
  ).bind(entityId, sourceTable).all<{ vector_id: string }>();

  const ids = vectors.results.map(r => r.vector_id);
  if (ids.length === 0) return;

  const batches = chunkArray(ids, 50);
  for (const batch of batches) {
    await Promise.all([
      env.VECTORIZE.deleteByIds(batch),
      ...batch.map(id => env.KV.delete(`chunk:${id}`)),
    ]);
  }

  await env.D1.prepare(
    'DELETE FROM vector_entity_index WHERE entity_id = ? AND source_table = ?'
  ).bind(entityId, sourceTable).run();
}

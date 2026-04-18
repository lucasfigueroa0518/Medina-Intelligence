// TRD §7.1, §10.4-10.7 — Daily cron operations
import type { Env } from '../types/env';
import { chunkArray } from './helpers';
import { promoteToStandalone, flagStaleOrphanedEvents } from './reconciliation';
import { triggerContactEnrichment, triggerCompanyEnrichment } from './enrichment';
import { checkClaudeRateLimit } from './rate-limit';

export async function runDailyCron(orgId: string, env: Env): Promise<void> {
  try { await applyNewsScoreDecay(orgId, env); } catch (e) { console.error('Score decay:', e); }
  try { await scheduleReEnrichment(orgId, env); } catch (e) { console.error('Re-enrichment:', e); }
  try { await reconcileVectorIndex(orgId, env); } catch (e) { console.error('Vector reconciliation:', e); }
  try { await archiveOldAuditLogs(orgId, env); } catch (e) { console.error('Audit archival:', e); }
  try { await cleanupExpiredMergeLocks(env); } catch (e) { console.error('Lock cleanup:', e); }
  try { await warmCrmCache(orgId, env); } catch (e) { console.error('Cache warming:', e); }
  try { await checkWebhookHealth(orgId, env); } catch (e) { console.error('Webhook health:', e); }
  try { await promoteToStandalone(orgId, env); } catch (e) { console.error('Standalone promotion:', e); }
  try { await flagStaleOrphanedEvents(orgId, env); } catch (e) { console.error('Orphan flagging:', e); }
}

export async function applyNewsScoreDecay(orgId: string, env: Env): Promise<void> {
  await env.D1.prepare(
    `UPDATE companies SET news_relevance_score = news_relevance_score * 0.95,
       news_score_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND news_relevance_score > 0.01 AND deleted_at IS NULL`
  ).bind(orgId).run();

  await env.D1.prepare(
    `UPDATE contacts SET news_relevance_score = news_relevance_score * 0.95,
       news_score_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND news_relevance_score > 0.01 AND deleted_at IS NULL`
  ).bind(orgId).run();
}

export async function scheduleReEnrichment(orgId: string, env: Env): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 2592000000).toISOString();

  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts WHERE org_id = ? AND deleted_at IS NULL
       AND (enrichment_last_run IS NULL OR enrichment_last_run < ?)
       AND total_interactions > 0
     ORDER BY total_interactions DESC LIMIT 100`
  ).bind(orgId, thirtyDaysAgo).all<{ id: string }>();

  const companies = await env.D1.prepare(
    `SELECT id FROM companies WHERE org_id = ? AND deleted_at IS NULL
       AND (enrichment_last_run IS NULL OR enrichment_last_run < ?)
       AND investment_status NOT IN ('passed','exited')
     ORDER BY news_relevance_score DESC LIMIT 50`
  ).bind(orgId, thirtyDaysAgo).all<{ id: string }>();

  for (const c of contacts.results) {
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) break;
    await triggerContactEnrichment(c.id, orgId, env);
  }
  for (const c of companies.results) {
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) break;
    await triggerCompanyEnrichment(c.id, orgId, env);
  }
}

export async function reconcileVectorIndex(orgId: string, env: Env): Promise<void> {
  const orphaned = await env.D1.prepare(
    `SELECT vei.vector_id FROM vector_entity_index vei WHERE vei.org_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM contacts WHERE id = vei.entity_id AND vei.source_table = 'contacts' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM companies WHERE id = vei.entity_id AND vei.source_table = 'companies' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM events WHERE id = vei.entity_id AND vei.source_table = 'events' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM conversations WHERE id = vei.entity_id AND vei.source_table = 'conversations'
         UNION ALL SELECT 1 FROM documents WHERE id = vei.entity_id AND vei.source_table = 'documents' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM deals WHERE id = vei.entity_id AND vei.source_table = 'deals' AND deleted_at IS NULL
       ) LIMIT 200`
  ).bind(orgId).all<{ vector_id: string }>();

  const ids = orphaned.results.map(r => r.vector_id);
  if (ids.length === 0) return;

  for (const batch of chunkArray(ids, 50)) {
    await Promise.all([
      env.VECTORIZE.deleteByIds(batch),
      ...batch.map(id => env.KV.delete(`chunk:${id}`)),
    ]);
    await env.D1.batch(
      batch.map(id =>
        env.D1.prepare('DELETE FROM vector_entity_index WHERE vector_id = ?').bind(id)
      )
    );
  }
}

export async function archiveOldAuditLogs(orgId: string, env: Env): Promise<void> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const batchId = crypto.randomUUID();

  const entries = await env.D1.prepare(
    `SELECT * FROM audit_log WHERE org_id = ? AND created_at < ? LIMIT 5000`
  ).bind(orgId, ninetyDaysAgo).all();

  if (entries.results.length === 0) return;

  const yearMonth = new Date().toISOString().slice(0, 7);
  const r2Key = `${orgId}/audit_archive/${yearMonth.slice(0, 4)}/${yearMonth.slice(5)}/${batchId}.ndjson`;
  const ndjson = entries.results.map(e => JSON.stringify(e)).join('\n');
  await env.R2.put(r2Key, ndjson);

  // HEAD verify before D1 delete
  const head = await env.R2.head(r2Key);
  if (!head) {
    console.error('Audit archive R2 HEAD check failed, skipping D1 delete');
    return;
  }

  const ids = entries.results.map(e => (e as any).id as string);
  for (const batch of chunkArray(ids, 50)) {
    await env.D1.batch(
      batch.map(id =>
        env.D1.prepare('DELETE FROM audit_log WHERE id = ?').bind(id)
      )
    );
  }
}

export async function cleanupExpiredMergeLocks(env: Env): Promise<void> {
  await env.D1.prepare(
    `DELETE FROM merge_locks WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run();
}

export async function warmCrmCache(orgId: string, env: Env): Promise<void> {
  try {
    const contacts = await env.D1.prepare(
      `SELECT id, full_name, email, company_id, job_title, last_contact_date, total_interactions
       FROM contacts WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY last_contact_date DESC NULLS LAST LIMIT 500`
    ).bind(orgId).all();

    const companies = await env.D1.prepare(
      `SELECT id, name, sector, stage, investment_status, current_valuation
       FROM companies WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY news_relevance_score DESC LIMIT 500`
    ).bind(orgId).all();

    await env.KV.put(
      `cache:contacts:${orgId}`,
      JSON.stringify(contacts.results),
      { expirationTtl: 14400 }
    );
    await env.KV.put(
      `cache:companies:${orgId}`,
      JSON.stringify(companies.results),
      { expirationTtl: 14400 }
    );
    await env.KV.delete(`cache:stale:${orgId}`);
  } catch (e) {
    // D1 down — extend existing cache by 2h and flag stale
    const existingContacts = await env.KV.get(`cache:contacts:${orgId}`);
    const existingCompanies = await env.KV.get(`cache:companies:${orgId}`);
    if (existingContacts) {
      await env.KV.put(`cache:contacts:${orgId}`, existingContacts, {
        expirationTtl: 7200,
      });
    }
    if (existingCompanies) {
      await env.KV.put(`cache:companies:${orgId}`, existingCompanies, {
        expirationTtl: 7200,
      });
    }
    await env.KV.put(`cache:stale:${orgId}`, new Date().toISOString(), {
      expirationTtl: 7200,
    });
    throw e;
  }
}

export async function checkWebhookHealth(orgId: string, env: Env): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const fireflyEvents = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM events WHERE org_id = ? AND source = 'firefly' AND created_at > ?`
  ).bind(orgId, oneDayAgo).first<{ n: number }>();

  if ((fireflyEvents?.n || 0) === 0) {
    // No Firefly events in last 24h — non-fatal warning
    console.warn(`[webhook-health] No Firefly webhooks received in 24h for org ${orgId}`);
  }
}

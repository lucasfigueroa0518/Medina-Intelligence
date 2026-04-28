// TRD §7.1, §10.4-10.7 — Daily cron operations
import type { Env } from '../types/env';
import { chunkArray } from './helpers';
import { promoteToStandalone, flagStaleOrphanedEvents } from './reconciliation';
import { triggerContactEnrichment, triggerCompanyEnrichment, isDomainShapedName } from './enrichment';
import { checkClaudeRateLimit } from './rate-limit';
import { recalculateAllAssociations } from './associations';
import { renewExpiringSubscriptions } from './graph-subscriptions';
import { proposeMultipleUpdates } from './progressive-enrichment';
import { callClaude } from './claude';
import { rebuildEntityIndex } from './entity-index';

export async function runDailyCron(orgId: string, env: Env): Promise<void> {
  try { await applyNewsScoreDecay(orgId, env); } catch (e) { console.error('Score decay:', e); }
  try { await scheduleReEnrichment(orgId, env); } catch (e) { console.error('Re-enrichment:', e); }
  try { await backfillDomainShapedCompanyNames(orgId, env); } catch (e) { console.error('Domain-shaped name backfill:', e); }
  try { await extractFactsFromRecentNews(orgId, env); } catch (e) { console.error('News fact extraction:', e); }
  try { await reconcileVectorIndex(orgId, env); } catch (e) { console.error('Vector reconciliation:', e); }
  try { await archiveOldAuditLogs(orgId, env); } catch (e) { console.error('Audit archival:', e); }
  try { await cleanupExpiredMergeLocks(env); } catch (e) { console.error('Lock cleanup:', e); }
  try { await warmCrmCache(orgId, env); } catch (e) { console.error('Cache warming:', e); }
  try { await checkWebhookHealth(orgId, env); } catch (e) { console.error('Webhook health:', e); }
  try { await promoteToStandalone(orgId, env); } catch (e) { console.error('Standalone promotion:', e); }
  try { await flagStaleOrphanedEvents(orgId, env); } catch (e) { console.error('Orphan flagging:', e); }
  try { await recalculateAllAssociations(orgId, env); } catch (e) { console.error('Association recalc:', e); }
  try { await renewExpiringSubscriptions(env); } catch (e) { console.error('Graph subscription renewal:', e); }
  try { await backfillUnembeddedConversations(orgId, env); } catch (e) { console.error('Unembedded backfill:', e); }
  try { await rebuildEntityIndex(orgId, env); } catch (e) { console.error('Entity index rebuild:', e); }
  try { await cleanupExpiredResetTokens(env); } catch (e) { console.error('Reset token cleanup:', e); }
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

  // Signal-driven cadence for companies. Hot companies (active deals or news
  // velocity) get re-enriched faster; cold passed/exited get re-enriched
  // rarely. The CASE expression computes a per-row "stale-by" cutoff that
  // enrichment_last_run must precede to be picked up.
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 86400000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 86400000).toISOString();
  const ninetyDaysAgo = new Date(now - 90 * 86400000).toISOString();

  const companies = await env.D1.prepare(
    `SELECT c.id FROM companies c
       LEFT JOIN (
         SELECT company_id, COUNT(*) AS recent_news
         FROM news_articles
         WHERE org_id = ? AND published_at > ?
         GROUP BY company_id
       ) n ON n.company_id = c.id
       LEFT JOIN (
         SELECT company_id, MAX(updated_at) AS last_deal_activity
         FROM deals
         WHERE org_id = ? AND deleted_at IS NULL
         GROUP BY company_id
       ) d ON d.company_id = c.id
       LEFT JOIN (
         SELECT company_id, MAX(last_contact_date) AS last_interaction
         FROM contacts
         WHERE org_id = ? AND deleted_at IS NULL AND last_contact_date > ?
         GROUP BY company_id
       ) e ON e.company_id = c.id
       WHERE c.org_id = ? AND c.deleted_at IS NULL AND c.merged_into IS NULL
         AND (
           c.enrichment_last_run IS NULL
           OR (
             c.investment_status IN ('passed','exited')
               AND c.enrichment_last_run < ?
           )
           OR (
             (d.last_deal_activity IS NOT NULL AND d.last_deal_activity > ?
               OR COALESCE(n.recent_news, 0) >= 3)
             AND c.enrichment_last_run < ?
           )
           OR (
             (e.last_interaction IS NOT NULL OR c.news_relevance_score >= 5)
             AND c.enrichment_last_run < ?
           )
           OR c.enrichment_last_run < ?
         )
       ORDER BY c.news_relevance_score DESC, c.updated_at DESC
       LIMIT 50`
  ).bind(
    // recent_news join
    orgId, sevenDaysAgo,
    // recent deals join
    orgId,
    // recent interactions join
    orgId, fourteenDaysAgo,
    // outer WHERE
    orgId,
    /* passed/exited cutoff */ ninetyDaysAgo,
    /* hot deal-activity cutoff (30d) */ new Date(now - 30 * 86400000).toISOString(),
    /* hot 7-day stale cutoff */ sevenDaysAgo,
    /* warm 14-day stale cutoff */ fourteenDaysAgo,
    /* default 30-day stale cutoff */ thirtyDaysAgo,
  ).all<{ id: string }>();

  for (const c of contacts.results) {
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) break;
    await triggerContactEnrichment(c.id, orgId, env);
  }
  for (const c of companies.results) {
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) break;
    await triggerCompanyEnrichment(c.id, orgId, env);
  }
}

// Find companies still carrying their auto-discovery placeholder name (e.g.
// "emergeamericas.com") and run them through enrichment so resolveCompanyName
// can replace the name with the canonical form ("Emerge Americas") and merge
// any duplicate that already has the canonical name.
export async function backfillDomainShapedCompanyNames(orgId: string, env: Env): Promise<void> {
  const candidates = await env.D1.prepare(
    `SELECT id, name, domain, website FROM companies
       WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL
         AND name LIKE '%.%' AND name NOT LIKE '% %'
       ORDER BY news_relevance_score DESC, updated_at DESC
       LIMIT 25`
  ).bind(orgId).all<{ id: string; name: string; domain: string | null; website: string | null }>();

  for (const c of candidates.results) {
    if (!isDomainShapedName(c.name, c.domain, c.website)) continue;
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) break;
    await triggerCompanyEnrichment(c.id, orgId, env);
  }
}

export async function reconcileVectorIndex(orgId: string, env: Env): Promise<void> {
  // Audit 2026-04-28: news_articles was missing from this UNION, so news
  // vectors (after the source_table='news_articles' fix) would have been
  // wrongly flagged as orphans on the next daily cron. Also widening the LIMIT
  // because a single bad ingestion can create dozens of orphans we want
  // cleared in one pass.
  const orphaned = await env.D1.prepare(
    `SELECT vei.vector_id FROM vector_entity_index vei WHERE vei.org_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM contacts WHERE id = vei.entity_id AND vei.source_table = 'contacts' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM companies WHERE id = vei.entity_id AND vei.source_table = 'companies' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM events WHERE id = vei.entity_id AND vei.source_table = 'events' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM conversations WHERE id = vei.entity_id AND vei.source_table = 'conversations'
         UNION ALL SELECT 1 FROM documents WHERE id = vei.entity_id AND vei.source_table = 'documents' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM deals WHERE id = vei.entity_id AND vei.source_table = 'deals' AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM news_articles WHERE id = vei.entity_id AND vei.source_table = 'news_articles'
       ) LIMIT 500`
  ).bind(orgId).all<{ vector_id: string }>();

  if (orphaned.results.length > 0) {
    console.warn(`[daily-cron] reconcileVectorIndex: ${orphaned.results.length} orphaned vectors found in org ${orgId}`);
  }

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

// Pull structured facts (funding round, valuation, leadership, location, etc.)
// out of recent news articles and feed them through progressive enrichment so
// the company row stays current. Each article is processed at most once.
export async function extractFactsFromRecentNews(orgId: string, env: Env): Promise<void> {
  const articles = await env.D1.prepare(
    `SELECT id, company_id, title, summary, source_url, published_at
       FROM news_articles
       WHERE org_id = ? AND company_id IS NOT NULL
         AND facts_extracted_at IS NULL
         AND summary IS NOT NULL AND LENGTH(summary) > 60
       ORDER BY published_at DESC
       LIMIT 25`
  ).bind(orgId).all<{
    id: string; company_id: string; title: string; summary: string | null;
    source_url: string | null; published_at: string | null;
  }>();

  if (articles.results.length === 0) return;

  for (const a of articles.results) {
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) break;
    try {
      const facts = await extractFactsFromArticle(a, env, orgId);
      if (facts.length > 0) {
        await proposeMultipleUpdates(
          orgId, 'company', a.company_id,
          facts.map(f => ({
            field: f.field,
            value: f.value,
            source: 'news_article',
            confidence: f.confidence,
            source_description: a.source_url || a.title,
            source_communication_id: a.id,
          })),
          env,
          { policy: 'auto_if_confident' }
        );
      }
    } catch (e) {
      console.error(`[news-facts] extraction failed for article ${a.id}:`, e);
    } finally {
      // Mark processed regardless of outcome to avoid re-charging the LLM for
      // the same article on every cron run. A future re-extraction would need
      // to clear this column intentionally.
      await env.D1.prepare(
        `UPDATE news_articles SET facts_extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(a.id).run().catch(() => undefined);
    }
  }
}

interface ArticleFact { field: string; value: string; confidence: number }

async function extractFactsFromArticle(
  article: { id: string; title: string; summary: string | null; published_at: string | null },
  env: Env,
  orgId: string
): Promise<ArticleFact[]> {
  const system = `You extract verifiable company facts from a single news article. Return ONLY raw JSON, no markdown. Schema:
{
  "stage": {"value": "pre_seed"|"seed"|"series_a"|"series_b"|"series_c"|"growth"|"public"|"acquired"|"other", "confidence": "high"|"medium"|"low"} | null,
  "current_valuation": {"value": number, "confidence": "high"|"medium"|"low"} | null,
  "last_funding_amount": {"value": number, "confidence": "high"|"medium"|"low"} | null,
  "last_funding_round": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "last_funding_date": {"value": "YYYY-MM-DD", "confidence": "high"|"medium"|"low"} | null,
  "hq_location": {"value": string, "confidence": "high"|"medium"|"low"} | null,
  "employee_count": {"value": number, "confidence": "high"|"medium"|"low"} | null
}

Rules:
- Omit (null) any field not stated in the article. Never guess.
- Numeric fields must be raw numbers. "$50M" → 50000000. "1.2 billion" → 1200000000.
- last_funding_date defaults to the article's published_at if a recent round is announced without an explicit date.
- "high" confidence = direct quote / press release / explicit announcement.`;

  const user = `Title: ${article.title}
Published: ${article.published_at || 'unknown'}
Summary: ${article.summary?.slice(0, 2500) || ''}`;

  let raw: string;
  try {
    raw = await callClaude(
      { system, user, max_tokens: 500, orgId, model: 'claude-haiku-4-5-20251001' },
      'low',
      env
    );
  } catch {
    return [];
  }

  let parsed: Record<string, { value: unknown; confidence: string } | null>;
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const confMap: Record<string, number> = { high: 0.9, medium: 0.65, low: 0.4 };
  const fields = ['stage','current_valuation','last_funding_amount','last_funding_round','last_funding_date','hq_location','employee_count'];
  const out: ArticleFact[] = [];
  for (const field of fields) {
    const f = parsed[field];
    if (!f || f.value === null || f.value === undefined) continue;
    const conf = confMap[String(f.confidence).toLowerCase()] ?? 0.4;
    if (conf < 0.5) continue;
    const value = typeof f.value === 'number' ? String(f.value) : String(f.value).trim();
    if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'unknown') continue;
    out.push({ field, value, confidence: conf });
  }
  return out;
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

export async function backfillUnembeddedConversations(orgId: string, env: Env): Promise<number> {
  const { chunkEmbedAndPersistAll } = await import('./embedding');

  const rows = await env.D1.prepare(
    `SELECT c.id, c.body_r2_key, c.source, c.subject, c.from_email, c.sent_at, c.participant_user_ids
       FROM conversations c
       WHERE c.org_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index vei
            WHERE vei.source_table = 'conversations'
              AND vei.entity_id = c.id
         )
       ORDER BY c.sent_at DESC
       LIMIT 20`
  ).bind(orgId).all<{
    id: string; body_r2_key: string | null; source: string; subject: string | null;
    from_email: string | null; sent_at: string | null; participant_user_ids: string | null;
  }>();

  if (rows.results.length === 0) return 0;

  let embedded = 0;
  for (const row of rows.results) {
    if (!row.body_r2_key) continue;
    try {
      const obj = await env.R2.get(row.body_r2_key);
      if (!obj) continue;
      const body = await obj.text();

      const meta = {
        org_id: orgId,
        visibility: 'org_wide' as const,
        participant_user_ids: row.participant_user_ids || undefined,
        document_type: row.source === 'manual' ? 'transcript' : 'email',
        source_table: 'conversations',
        source_id: row.id,
        r2_key: row.body_r2_key,
        created_at: row.sent_at || new Date().toISOString(),
        primary_entity_id: row.id,
        entity_name: row.subject || undefined,
        date: row.sent_at || undefined,
      };

      const entries = await chunkEmbedAndPersistAll(body, meta, env);
      if (entries.length > 0) {
        await env.D1.batch(
          entries.map(e =>
            env.D1.prepare(
              'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
            ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
          )
        );
        embedded++;
      }
    } catch (e) {
      console.error(`[daily-cron] embed backfill failed for conv ${row.id}:`, e);
    }
  }

  if (embedded > 0) {
    console.log(`[daily-cron] backfilled ${embedded} unembedded conversations for org ${orgId}`);
  }
  return embedded;
}

async function cleanupExpiredResetTokens(env: Env): Promise<void> {
  await env.D1.prepare(
    `DELETE FROM password_reset_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`
  ).run();
  await env.D1.prepare(
    `DELETE FROM email_verification_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`
  ).run();
}

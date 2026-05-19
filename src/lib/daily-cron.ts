// TRD §7.1, §10.4-10.7 — Daily cron operations
import type { Env } from '../types/env';
import { chunkArray, parseParticipantUserIds } from './helpers';
import { promoteToStandalone, flagStaleOrphanedEvents } from './reconciliation';
import { triggerCompanyEnrichment, isDomainShapedName } from './enrichment';
import { checkClaudeRateLimit } from './rate-limit';
import { recalculateAllAssociations } from './associations';
import { calculateAllRelationshipStatuses } from './relationship-status';
import { calculateAllRelationshipOwners } from './relationship-owner';
import { analyzeAllCommsPatterns } from './communication-patterns';
import { renewExpiringSubscriptions } from './graph-subscriptions';
import { withTaskRun } from './task-runs';
import { checkBudget, recordUsage, recordRateLimit } from './upstream-budget';
import { proposeMultipleUpdates } from './progressive-enrichment';
import { callClaude } from './claude';
import { rebuildEntityIndex } from './entity-index';
import { enqueueDueContactEnrichment } from './contact-enrichment-queue';
import { embedDocumentItem as embedDocumentItemForRepair } from './document-embedding';

// Mirrors the visibility logic in classification.ts:233 — emails are always
// 'private' regardless of source-side hint, transcripts/manual notes are
// 'org_wide'. Daily-cron backfill previously hard-coded 'org_wide' for both,
// which silently downgraded ingested emails to org-wide-readable.
function visibilityForBackfill(source: string): 'private' | 'org_wide' {
  return source === 'manual' ? 'org_wide' : 'private';
}

// D1 stores participant_user_ids as JSON-stringified array; vector metadata
// stores it as comma-joined string. Daily-cron previously passed the D1 value
// straight through, leaving vectors with an unparseable JSON string.
function participantsForVectorMeta(rawFromD1: string | null): string | undefined {
  const ids = parseParticipantUserIds(rawFromD1);
  return ids.length > 0 ? ids.join(',') : undefined;
}

// Cache one round-trip per cron run for internal user-email lookup. Used by
// the primary_entity_id resolver to detect outbound vs inbound mail.
async function loadInternalUserEmails(orgId: string, env: Env): Promise<Set<string>> {
  const rows = await env.D1.prepare(
    `SELECT email FROM users WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(orgId).all<{ email: string }>();
  const set = new Set<string>();
  for (const r of rows.results) {
    if (r.email) set.add(r.email.toLowerCase());
  }
  return set;
}

export async function runDailyCron(orgId: string, env: Env): Promise<void> {
  try { await applyNewsScoreDecay(orgId, env); } catch (e) { console.error('Score decay:', e); }
  try { await scheduleReEnrichment(orgId, env); } catch (e) { console.error('Re-enrichment:', e); }
  try { await backfillDomainShapedCompanyNames(orgId, env); } catch (e) { console.error('Domain-shaped name backfill:', e); }
  try { await extractFactsFromRecentNews(orgId, env); } catch (e) { console.error('News fact extraction:', e); }
  try { await reconcileVectorIndex(orgId, env); } catch (e) { console.error('Vector reconciliation:', e); }
  try { await archiveOldAuditLogs(orgId, env); } catch (e) { console.error('Audit archival:', e); }
  try { await cleanupExpiredMergeLocks(env); } catch (e) { console.error('Lock cleanup:', e); }
  try { await cleanupExpiredChatUploads(env); } catch (e) { console.error('Chat upload cleanup:', e); }
  try { await warmCrmCache(orgId, env); } catch (e) { console.error('Cache warming:', e); }
  try { await checkWebhookHealth(orgId, env); } catch (e) { console.error('Webhook health:', e); }
  try { await promoteToStandalone(orgId, env); } catch (e) { console.error('Standalone promotion:', e); }
  try { await flagStaleOrphanedEvents(orgId, env); } catch (e) { console.error('Orphan flagging:', e); }
  try { await recalculateAllAssociations(orgId, env); } catch (e) { console.error('Association recalc:', e); }
  // Phase 0a-4 (2026-05-04): three org-wide bulk calcs migrated from
  // ingestion-finalizer to daily-cron after Terminal 5 confirmed the
  // finalizer was hitting the 1000-subreq cap consistently. Each is
  // wrapped in its own try/catch — partial failure of one calc does
  // not poison the rest, matching the established daily-cron pattern.
  try { await calculateAllRelationshipStatuses(orgId, env); } catch (e) { console.error('Relationship status calc:', e); }
  try { await calculateAllRelationshipOwners(orgId, env); } catch (e) { console.error('Relationship owner calc:', e); }
  try { await analyzeAllCommsPatterns(orgId, env); } catch (e) { console.error('Comms patterns calc:', e); }
  try { await renewExpiringSubscriptions(env); } catch (e) { console.error('Graph subscription renewal:', e); }
  // Phase 8 1a (2026-05-05): backfillUnembeddedConversations replaced
  // by enqueueBackfillConversations — inline embed loop migrated to
  // work_queue domain='embed_retry' for ledger integration + idempotency.
  // backfillUnembeddedEntities stays in-place (different handler shape:
  // calls embedContactBio/embedCompanyDescription, not chunkEmbedAndPersistAll;
  // backlog has been zero in production — not worth migrating).
  try { await enqueueBackfillConversations(orgId, env); } catch (e) { console.error('Conversation embed enqueue:', e); }
  try { await backfillUnembeddedEntities(orgId, env); } catch (e) { console.error('Entity backfill:', e); }
  // Phase 7c (2026-05-05): backfillUnembeddedEvents removed from
  // daily-cron orchestration. T4's hotfix wired it both hourly
  // (src/index.ts:887) AND here, but at 02:10 UTC the hourly run
  // (02:00 + waitUntil) and the daily run could overlap in two
  // concurrent Worker invocations both SELECTing the same 50
  // unembedded events and embedding each twice — INSERT OR IGNORE
  // saved DB integrity but BGE quota was wasted. Hourly cadence
  // alone drains 50 events × 24 = 1200/day, well above the audit's
  // 22-hour drain projection. The work_queue migration for the
  // embed-self-heal trio (deferred separate workstream) is the
  // proper home for budget-aware concurrency; until then, hourly-
  // only is the lightest fix.
  // Phase 6 1b (2026-05-05): processEmbedRetryQueue removed from daily
  // orchestration. Replaced by Phase 5's minute-tick driver running the
  // embed_retry domain handler via WORK_QUEUE_HANDLERS. The function body
  // is preserved at line ~696 below for the revert window per Lucas
  // 2026-05-05; it has zero callers post-1b (admin endpoints repurposed
  // to processWorkQueueTick) but stays exported so a single-revert
  // restores it without code-resurrection.
  try { await rebuildEntityIndex(orgId, env); } catch (e) { console.error('Entity index rebuild:', e); }
  try { await cleanupExpiredResetTokens(env); } catch (e) { console.error('Reset token cleanup:', e); }
  try { await detectIngestionDivergence(orgId, env); } catch (e) { console.error('Ingestion divergence:', e); }
}

// Wave 2 self-heal: detect when conversations claim attachments but no
// email_attachment documents exist for them. Pre-Wave-2 this gap could open
// silently (the inline-backfill path skipped processEmailAttachments). After
// Wave 2 both ingestion paths run the same helper, so this query should
// trend to zero. If it stays nonzero for a sustained window, a future
// regression has reopened the divergence — surface it loud.
export async function detectIngestionDivergence(
  orgId: string,
  env: Env
): Promise<{ orphan_attachment_conversations: number }> {
  // `conversations` has no deleted_at column — soft-delete is not modeled
  // for emails. Just guard against soft-deleted documents on the inner side.
  const row = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM conversations c
       WHERE c.org_id = ?
         AND c.has_attachments = 1
         AND NOT EXISTS (
           SELECT 1 FROM documents d
            WHERE d.conversation_id = c.id
              AND d.source = 'email_attachment'
              AND d.deleted_at IS NULL
         )`
  ).bind(orgId).first<{ n: number }>();

  const count = row?.n || 0;
  if (count > 0) {
    console.warn(
      `[cron:divergence-detect] org=${orgId} ${count} conversations declare attachments but have no email_attachment documents — ingestion divergence (or pending Wave 3 backfill)`
    );
  } else {
    console.log(`[cron:divergence-detect] org=${orgId} clean — no orphan attachment conversations`);
  }
  return { orphan_attachment_conversations: count };
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

  await enqueueDueContactEnrichment(orgId, env, { limit: 100, targetBacklog: 200 });

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

export async function cleanupExpiredChatUploads(env: Env): Promise<{ candidates: number; r2_deleted: number; r2_failed: number; rows_deleted: number }> {
  const stats = { candidates: 0, r2_deleted: 0, r2_failed: 0, rows_deleted: 0 };

  // Skip rows where the file was promoted to permanent Documents — those are
  // owned by the documents pipeline now and have a different retention policy.
  const rows = await env.D1.prepare(
    `SELECT id, r2_key FROM chat_uploads
     WHERE saved_to_documents = 0
       AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
     LIMIT 500`
  ).all<{ id: string; r2_key: string }>();
  stats.candidates = rows.results.length;

  for (const row of rows.results) {
    // R2 first — if this fails we leave the D1 row for retry next run, so a
    // stale row never points at a missing R2 object (and an R2 leak is at
    // most a few extra cron cycles).
    try {
      await env.R2.delete(row.r2_key);
      stats.r2_deleted += 1;
    } catch (e) {
      console.error(`[chat-uploads] R2 delete failed for ${row.id}:`, e);
      stats.r2_failed += 1;
      continue;
    }
    const del = await env.D1.prepare(`DELETE FROM chat_uploads WHERE id = ?`).bind(row.id).run().catch(() => null);
    if (del?.meta.changes) stats.rows_deleted += del.meta.changes;
  }

  if (stats.candidates > 0) {
    console.log(`[chat-uploads] TTL sweep: candidates=${stats.candidates} r2_deleted=${stats.r2_deleted} r2_failed=${stats.r2_failed} rows_deleted=${stats.rows_deleted}`);
  }
  return stats;
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

// Phase 8 1a (2026-05-05) — embed self-heal trio onto work_queue.
//
// enqueueBackfillConversations + enqueueBackfillEvents replace
// backfillUnembeddedConversations + backfillUnembeddedEvents in the
// hourly self-heal + daily-cron call sites. The legacy functions stay
// exported for revert window (Phase 8 1b removes them after ~5 days
// of stable operation) and as the manual-trigger admin endpoint
// fallback (handlers/admin.ts:622 — separate scope; potential 1c/1b).
//
// Behavior shift:
//   • OLD: scan NOT-EXISTS, fetch text inline, call chunkEmbedAndPersistAll,
//          INSERT vector_entity_index. Bypasses upstream_budget_ledger
//          (audit finding G). Hourly cadence (50/hr events, 200/hr conv).
//   • NEW: scan NOT-EXISTS, enqueue per-row into work_queue (domain
//          'embed_retry'). The existing embed_retry handler (Phase 6 1a)
//          dispatches to embedSingleItem at minute-tick × batchSize=10
//          → 14,400/day capacity. ledger integration via upstream='bge'
//          on the row + claimNextBatch's open-circuit filter. Audit
//          findings G + H both resolved.
//
// Idempotency: keys mirror Phase 6 1a's three existing enqueue sites
// exactly (`${orgId}:${entity_id}:${source_table}`). Concurrent scans
// (e.g. hourly + a hypothetical second trigger) collapse cleanly via
// the partial UNIQUE on (domain, idempotency_key) — same gap detected
// twice produces ONE work_queue row.
//
// embedSingleItem (events branch) was updated in 1a-i to mirror
// backfillUnembeddedEvents's T4 ACL logic (transcript-backed events
// with internal attendees → private + participant_user_ids). Without
// this fix, Phase 8 would silently regress 71 Outlook-with-transcript
// vectors from 'private' → 'org_wide' on re-embed.

/**
 * Phase 8 1a: scan conversations missing from vector_entity_index and
 * enqueue per-row into work_queue (domain='embed_retry'). Best-effort
 * per-row enqueue with try/catch — a partial scan failure doesn't
 * abort the loop; next tick re-scans.
 */
export async function enqueueBackfillConversations(orgId: string, env: Env): Promise<number> {
  const { enqueueWork } = await import('./work-queue');
  const rows = await env.D1.prepare(
    `SELECT c.id
       FROM conversations c
       WHERE c.org_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index vei
            WHERE vei.source_table = 'conversations'
              AND vei.entity_id = c.id
         )
       ORDER BY c.sent_at DESC
       LIMIT 200`
  ).bind(orgId).all<{ id: string }>();
  if (rows.results.length === 0) return 0;

  let enqueued = 0;
  for (const row of rows.results) {
    try {
      await enqueueWork(env, orgId, 'embed_retry',
        { entity_id: row.id, source_table: 'conversations' },
        {
          upstream: 'bge',
          idempotency_key: `${orgId}:${row.id}:conversations`,
        }
      );
      enqueued++;
    } catch (e) {
      console.error(`[daily-cron:enqueueBackfillConversations] failed for ${row.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (enqueued > 0) {
    console.log(`[daily-cron] enqueued ${enqueued} conversation embed-retry rows for org ${orgId}`);
  }
  return enqueued;
}

/**
 * Phase 8 1a: scan events missing from vector_entity_index and enqueue
 * per-row. Mirror's enqueueBackfillConversations exactly with events as
 * the source_table. The handler's events branch (embedSingleItem,
 * updated 1a-i) handles the T4 ACL logic.
 */
export async function enqueueBackfillEvents(orgId: string, env: Env): Promise<number> {
  const { enqueueWork } = await import('./work-queue');
  const rows = await env.D1.prepare(
    `SELECT id FROM events
       WHERE org_id = ?
         AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index vei
            WHERE vei.source_table = 'events'
              AND vei.entity_id = events.id
              AND vei.org_id = events.org_id
         )
       ORDER BY start_time DESC
       LIMIT 50`
  ).bind(orgId).all<{ id: string }>();
  if (rows.results.length === 0) return 0;

  let enqueued = 0;
  for (const row of rows.results) {
    try {
      await enqueueWork(env, orgId, 'embed_retry',
        { entity_id: row.id, source_table: 'events' },
        {
          upstream: 'bge',
          idempotency_key: `${orgId}:${row.id}:events`,
        }
      );
      enqueued++;
    } catch (e) {
      console.error(`[daily-cron:enqueueBackfillEvents] failed for ${row.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (enqueued > 0) {
    console.log(`[daily-cron] enqueued ${enqueued} event embed-retry rows for org ${orgId}`);
  }
  return enqueued;
}

/**
 * Continuous document embedding health: completed documents with original
 * binaries should be searchable by MARTy. This scanner prioritizes missing
 * vectors, then trickles through stale/unaudited documents so D1, Vectorize,
 * and KV can be checked against the actual extracted chunk set.
 */
export async function enqueueBackfillDocuments(orgId: string, env: Env): Promise<number> {
  const {
    DOCUMENT_EMBEDDING_AUDIT_VERSION,
    enqueueDocumentEmbeddingRepair,
  } = await import('./document-embedding');
  const auditKey = new Date().toISOString().slice(0, 10);
  const rows = await env.D1.prepare(
    `SELECT d.id, COUNT(vei.vector_id) AS vector_count
       FROM documents d
       LEFT JOIN vector_entity_index vei
         ON vei.source_table = 'documents'
        AND vei.entity_id = d.id
        AND vei.org_id = d.org_id
      WHERE d.org_id = ?
        AND d.deleted_at IS NULL
        AND d.processing_status = 'completed'
        AND COALESCE(json_extract(
              CASE WHEN d.custom_fields IS NOT NULL AND json_valid(d.custom_fields)
                   THEN d.custom_fields ELSE '{}' END,
              '$.marty_lab_generated'
            ), 0) != 1
        AND d.r2_key IS NOT NULL
      GROUP BY d.id
      HAVING COUNT(vei.vector_id) = 0
          OR COALESCE(json_extract(
               CASE WHEN d.custom_fields IS NOT NULL AND json_valid(d.custom_fields)
                    THEN d.custom_fields ELSE '{}' END,
               '$.embedding_audit_version'
             ), '') != ?
          OR COALESCE(json_extract(
               CASE WHEN d.custom_fields IS NOT NULL AND json_valid(d.custom_fields)
                    THEN d.custom_fields ELSE '{}' END,
               '$.embedding_audit_at'
             ), '') < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
      ORDER BY CASE WHEN COUNT(vei.vector_id) = 0 THEN 0 ELSE 1 END,
               d.created_at DESC
      LIMIT 40`
  ).bind(orgId, DOCUMENT_EMBEDDING_AUDIT_VERSION).all<{ id: string; vector_count: number }>();
  if (rows.results.length === 0) return 0;

  let enqueued = 0;
  for (const row of rows.results) {
    try {
      await enqueueDocumentEmbeddingRepair(env, orgId, row.id, {
        auditKey,
        priority: Number(row.vector_count || 0) === 0 ? 20 : 5,
      });
      enqueued++;
    } catch (e) {
      console.error(`[daily-cron:enqueueBackfillDocuments] failed for ${row.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (enqueued > 0) {
    console.log(`[daily-cron] enqueued ${enqueued} document embed-retry rows for org ${orgId}`);
  }
  return enqueued;
}

/**
 * @deprecated Phase 8 1a (2026-05-05) — replaced by enqueueBackfillConversations.
 * Inline embedding bypasses upstream_budget_ledger (audit finding G).
 * Kept exported for revert window; deleted in 1b after ~5 days of
 * stable operation. Manual-trigger admin endpoint at
 * handlers/admin.ts:622 still calls this; that endpoint moves to the
 * enqueuer pattern in 1b/1c.
 */
export async function backfillUnembeddedConversations(orgId: string, env: Env): Promise<number> {
  const { chunkEmbedAndPersistAll, resolvePrimaryEntityId } = await import('./embedding');

  const rows = await env.D1.prepare(
    `SELECT c.id, c.body_r2_key, c.source, c.subject, c.from_email, c.from_contact_id,
            c.sent_at, c.participant_user_ids
       FROM conversations c
       WHERE c.org_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index vei
            WHERE vei.source_table = 'conversations'
              AND vei.entity_id = c.id
         )
       ORDER BY c.sent_at DESC
       LIMIT 200`
  ).bind(orgId).all<{
    id: string; body_r2_key: string | null; source: string; subject: string | null;
    from_email: string | null; from_contact_id: string | null;
    sent_at: string | null; participant_user_ids: string | null;
  }>();

  if (rows.results.length === 0) return 0;

  const internalEmails = await loadInternalUserEmails(orgId, env);

  let embedded = 0;
  for (const row of rows.results) {
    if (!row.body_r2_key) continue;
    try {
      const obj = await env.R2.get(row.body_r2_key);
      if (!obj) continue;
      const body = await obj.text();

      // Resolve recipient contact_ids via the conversation_contacts join. Lets
      // the resolver pick a real to-contact for outbound mail when from is
      // internal (without this, outbound mail falls back to source_id).
      const toContacts = await env.D1.prepare(
        `SELECT contact_id FROM conversation_contacts WHERE conversation_id = ?
           AND role IN ('to','cc') ORDER BY role = 'to' DESC`
      ).bind(row.id).all<{ contact_id: string }>();

      const docType = row.source === 'manual' ? 'transcript'
        : row.source === 'slack' ? 'conversation'
        : 'email';

      const meta = {
        org_id: orgId,
        visibility: visibilityForBackfill(row.source),
        participant_user_ids: participantsForVectorMeta(row.participant_user_ids),
        document_type: docType,
        source_table: 'conversations',
        source_id: row.id,
        r2_key: row.body_r2_key,
        created_at: row.sent_at || new Date().toISOString(),
        primary_entity_id: resolvePrimaryEntityId({
          document_type: docType,
          source: row.source,
          source_id: row.id,
          from_contact_id: row.from_contact_id,
          from_email: row.from_email,
          to_contact_ids: toContacts.results.map(r => r.contact_id),
          internal_user_emails: internalEmails,
        }),
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

// Backfill embeddings for contacts/companies that have content-bearing fields
// but no Vectorize coverage. The full enrichment.ts pipeline only embeds when
// it runs (re-)enrichment; entities that were ingested with an existing
// bio_summary or description but never re-enriched fall through. This loop
// closes that gap incrementally — 20 contacts + 20 companies per cron run.
export async function backfillUnembeddedEntities(orgId: string, env: Env): Promise<{ contacts: number; companies: number }> {
  const { embedContactBio, embedCompanyDescription } = await import('./embedding');
  const stats = { contacts: 0, companies: 0 };

  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts c
       WHERE c.org_id = ? AND c.deleted_at IS NULL AND c.merged_into IS NULL
         AND c.bio_summary IS NOT NULL AND length(trim(c.bio_summary)) > 30
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index
            WHERE entity_id = c.id AND source_table = 'contacts' AND org_id = c.org_id
         )
       ORDER BY c.total_interactions DESC, c.last_contact_date DESC
       LIMIT 20`
  ).bind(orgId).all<{ id: string }>();

  for (const c of contacts.results) {
    try {
      const r = await embedContactBio(c.id, orgId, env);
      if (r === 'embedded') stats.contacts++;
    } catch (e) {
      console.error(`[daily-cron:backfill] embed contact ${c.id} failed:`, e);
    }
  }

  const companies = await env.D1.prepare(
    `SELECT id FROM companies co
       WHERE co.org_id = ? AND co.deleted_at IS NULL AND co.merged_into IS NULL
         AND co.description IS NOT NULL AND length(trim(co.description)) > 30
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index
            WHERE entity_id = co.id AND source_table = 'companies' AND org_id = co.org_id
         )
       ORDER BY co.news_relevance_score DESC, co.updated_at DESC
       LIMIT 20`
  ).bind(orgId).all<{ id: string }>();

  for (const c of companies.results) {
    try {
      const r = await embedCompanyDescription(c.id, orgId, env);
      if (r === 'embedded') stats.companies++;
    } catch (e) {
      console.error(`[daily-cron:backfill] embed company ${c.id} failed:`, e);
    }
  }

  if (stats.contacts > 0 || stats.companies > 0) {
    console.log(`[daily-cron] entity backfill org=${orgId} contacts=${stats.contacts} companies=${stats.companies}`);
  }
  return stats;
}

// Backfill embeddings for events (calendar + transcripts) that have no
// vector_entity_index coverage. Closes a structural gap surfaced by the
// 2026-05-05 meeting-embed audit:
//
//   • upsertOutlookEvent (the SOLE Outlook calendar ingest path) writes
//     the events row but never enqueues for embed. Both callers
//     (calendar-progressive-backfill every-minute cron, syncOutlookCalendars
//     hourly cron) end at upsertOutlookEvent and stop. Pre-this-function
//     the only events that ever got embedded were Firefly meetings via
//     processTranscriptItems (inline) — calendar-only Outlook events
//     accumulated forever as silent RAG misses.
//
//   • The ingestion-finalizer detect-embed-gaps does enqueue events into
//     work_queue, but only those with `created_at >= startedAt` of the
//     CURRENT ingestion-workflow run. Events from calendar-progressive-
//     backfill (separate cron) fall outside any finalizer's window.
//
//   • Audit numbers (2026-05-05): 1,069 of 1,122 Outlook events
//     unembedded (95% gap). 998 with no transcript (just title/summary),
//     71 with transcript that lost the embed step somewhere in
//     reconciliation.
//
// This function mirrors backfillUnembeddedConversations: paginate by
// LIMIT, fetch text (transcript R2 → fallback to title+summary), apply
// per-attendee ACL when transcript-backed, chunk-embed, write
// vector_entity_index rows. Per-row try/catch so one bad event doesn't
// kill the loop.
//
// LIMIT 50: chosen lower than conversations' 200 because the 71
// transcript-backed events have ~10-15 chunks each and could otherwise
// blow the per-invocation subrequest cap. Mix realistically (mostly
// 1-chunk calendar events plus occasional transcripts) → ~400-2400
// subreqs/run, generally fits.
//
// ACL decision (per Wave 4 doctrine):
//   • Transcript-backed event with internal attendees in event_attendees
//     → visibility='private' + participant_user_ids
//     (matches the metadata processTranscriptItems writes for fresh
//     Firefly transcripts; closes the 71-Outlook-with-transcript subgap
//     by giving them the SAME ACL their Firefly twin would have)
//   • Otherwise (calendar-only or transcript with no internal attendees)
//     → visibility='org_wide'
//     (calendar metadata is org-wide-readable; better findable than
//     invisible for the rare zero-internal-attendee transcript case)
//
// Drain projection: 1,069 stranded events / 50 per hour ≈ 22 hours to
// fully clear. NOT EXISTS filter naturally advances each run.
/**
 * @deprecated Phase 8 1a (2026-05-05) — replaced by enqueueBackfillEvents.
 * Inline embedding bypasses upstream_budget_ledger (audit finding G).
 * Kept exported for revert window; deleted in 1b after ~5 days of
 * stable operation.
 */
export async function backfillUnembeddedEvents(orgId: string, env: Env): Promise<number> {
  const { chunkEmbedAndPersistAll } = await import('./embedding');

  const rows = await env.D1.prepare(
    `SELECT id, title, summary, transcript_r2_key, start_time
       FROM events
       WHERE org_id = ?
         AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM vector_entity_index vei
            WHERE vei.source_table = 'events'
              AND vei.entity_id = events.id
              AND vei.org_id = events.org_id
         )
       ORDER BY start_time DESC
       LIMIT 50`
  ).bind(orgId).all<{
    id: string;
    title: string;
    summary: string | null;
    transcript_r2_key: string | null;
    start_time: string;
  }>();

  if (rows.results.length === 0) return 0;

  let embedded = 0;
  for (const row of rows.results) {
    try {
      // Prefer transcript text when available; fall back to title+summary
      // for calendar-only events. Mirrors embedSingleItem's events branch
      // (daily-cron.ts ~line 990) for shape consistency.
      let text = '';
      let r2Key = '';
      let isTranscript = false;

      if (row.transcript_r2_key) {
        const obj = await env.R2.get(row.transcript_r2_key);
        if (obj) {
          text = await obj.text();
          r2Key = row.transcript_r2_key;
          isTranscript = true;
        }
      }

      if (!isTranscript) {
        const titleText = (row.title || '').trim();
        const summaryText = (row.summary || '').trim();
        text = summaryText
          ? (titleText ? `${titleText}\n\n${summaryText}` : summaryText)
          : titleText;
      }

      // Skip rows with too little text — embedding noise. Threshold
      // matches embedSingleItem's events branch.
      if (!text || text.trim().length < 10) continue;

      // ACL: per-attendee for transcript-backed events with internal
      // user attendees; org_wide otherwise. Matches the metadata shape
      // processTranscriptItems writes for fresh Firefly transcripts —
      // critical for the 71-Outlook-with-transcript subgap so reconciled
      // events get the same ACL their Firefly twin would have had.
      let visibility: 'private' | 'org_wide' = 'org_wide';
      let participantUserIds: string | undefined = undefined;

      if (isTranscript) {
        const attendees = await env.D1.prepare(
          `SELECT user_id FROM event_attendees
             WHERE event_id = ? AND user_id IS NOT NULL`
        ).bind(row.id).all<{ user_id: string }>();
        const internalIds = attendees.results
          .map(a => a.user_id)
          .filter(Boolean);
        if (internalIds.length > 0) {
          visibility = 'private';
          participantUserIds = internalIds.join(',');
        }
      }

      const entries = await chunkEmbedAndPersistAll(text, {
        org_id: orgId,
        visibility,
        participant_user_ids: participantUserIds,
        document_type: 'transcript',
        source_table: 'events',
        source_id: row.id,
        r2_key: r2Key,
        created_at: row.start_time,
        primary_entity_id: row.id,
        entity_name: row.title,
        date: row.start_time,
      }, env);

      if (entries.length > 0) {
        await env.D1.batch(
          entries.map(e =>
            env.D1.prepare(
              'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
            ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
          )
        );
        embedded += 1;
      }
    } catch (e) {
      console.error(`[daily-cron] embed backfill failed for event ${row.id}:`, e);
    }
  }

  if (embedded > 0) {
    console.log(`[daily-cron] backfilled ${embedded} unembedded events for org ${orgId}`);
  }
  return embedded;
}

// Embed retry queue processor (audit 2026-04-28 scale-up Fix 3;
// Phase 1 2026-05-04 wired into withTaskRun + upstream-budget ledger).
//
// Drains embed_retry_queue: conversations / events / documents that
// detect-embed-gaps detected as missing from vector_entity_index after a
// failed embed step. Each entry tracks attempts; after MAX_ATTEMPTS the
// entry is marked failed_permanent and surfaced in System Status.
//
// Called by the daily cron AND by POST /api/admin/process-embed-queue
// for on-demand drains.
//
// Two layers of integration with Phase 0 helpers:
//
//   Layer A — sweep observability via withTaskRun:
//     The whole drain runs inside withTaskRun(env, orgId,
//     'embed_retry_drain', ...). One task_runs row per sweep with
//     structured counts (items_processed, items_failed, items_skipped)
//     plus metadata { succeeded, stale_reset, budget_skipped } for
//     System Status reads. Heartbeat every HEARTBEAT_EVERY_N_ROWS
//     items keeps the watchdog (Phase 1.1) from reaping a long drain.
//
//   Layer B — per-item BGE budget gating via checkBudget:
//     Before each embedSingleItem call, checkBudget('bge', 'per_second')
//     reads the upstream_budget_ledger. circuit_open → hard skip the
//     row (counts as items_skipped; row stays pending; next tick
//     retries when circuit closes). over_cap is treated as 'ok' here
//     because acquireEmbedSlot inside bgeWithTimeout already handles
//     the per-second wait via exponential backoff — only circuit_open
//     is a meaningful hard skip at this layer. recordUsage on success;
//     recordRateLimit on 429-style errors so the auto-tune-down rule
//     (3 consecutive 429s → cap drops 10%, circuit opens 30 min) fires.
//
// Existing per-row state machine preserved exactly: status='in_progress'
// lock during processing, attempts counter, failed_permanent at 3
// attempts. All UPDATEs single-statement.
export async function processEmbedRetryQueue(
  orgId: string,
  env: Env
): Promise<{ processed: number; succeeded: number; failed: number; stale_reset: number }> {
  const MAX_PER_RUN = 200;
  const MAX_ATTEMPTS = 3;
  const STALE_AFTER_MINUTES = 10;
  const HEARTBEAT_EVERY_N_ROWS = 25;
  // Phase 1.1 (2026-05-04): per-item wallclock cap on embedSingleItem.
  // extractTextFromFile (used by the documents source-table path) has no
  // internal timeout for PDFs — Wave 5.6 restored pdfjs extraction in-
  // worker, and a complex/malformed PDF can hang the whole drain
  // indefinitely (Terminal 5 forensic 2026-05-04: LPA-signed.pdf hang
  // blocked the entire drain at 17:00:59, no progress for 30 min until
  // CF reaped the worker). 60s is generous: typical embedSingleItem
  // returns <2s; legitimate big-PDF / DOCX extraction completes in
  // 5-30s. On timeout: throws into the existing catch block →
  // attempts++ → eventually failed_permanent at MAX_ATTEMPTS →
  // surfaces in System Status dead_letter view (Phase 1).
  //
  // Mirrors the bgeWithTimeout pattern at src/lib/embedding.ts:140-161
  // (Promise.race + clearTimeout in finally to avoid leaking timer
  // handles on the success path).
  const EMBED_ITEM_TIMEOUT_MS = 60_000;

  const result = await withTaskRun<{ processed: number; succeeded: number; failed: number; stale_reset: number }>(
    env,
    orgId,
    'embed_retry_drain',
    async (ctx) => {
      // Reset rows stuck in 'in_progress' from a prior drain that died mid-flight
      // (Worker isolate eviction, ungraceful shutdown, or external script crash).
      // Without this, a stalled row stays in_progress forever and never retries.
      // STALE_AFTER_MINUTES gives a healthy drain plenty of time to finish a row;
      // anything beyond that is genuinely stuck.
      const staleReset = await env.D1.prepare(
        `UPDATE embed_retry_queue
            SET status = 'pending'
          WHERE org_id = ?
            AND status = 'in_progress'
            AND (last_attempt_at IS NULL
                 OR last_attempt_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`
      ).bind(orgId, `-${STALE_AFTER_MINUTES} minutes`).run();
      const stale_reset = staleReset.meta.changes ?? 0;
      if (stale_reset > 0) {
        console.log(`[embed-retry-queue] reset ${stale_reset} stale in_progress rows for org ${orgId}`);
      }

      const queued = await env.D1.prepare(
        `SELECT id, entity_id, source_table, attempts
           FROM embed_retry_queue
          WHERE org_id = ? AND status = 'pending' AND attempts < ?
          ORDER BY created_at ASC
          LIMIT ?`
      ).bind(orgId, MAX_ATTEMPTS, MAX_PER_RUN).all<{
        id: string; entity_id: string; source_table: string; attempts: number;
      }>();

      if (queued.results.length === 0) {
        ctx.report({ metadata: { stale_reset, succeeded: 0, budget_skipped: 0 } });
        return { processed: 0, succeeded: 0, failed: 0, stale_reset };
      }

      let succeeded = 0;
      let failed = 0;
      let budget_skipped = 0;
      let processedSinceHeartbeat = 0;

      for (const item of queued.results) {
        processedSinceHeartbeat++;
        if (processedSinceHeartbeat >= HEARTBEAT_EVERY_N_ROWS) {
          await ctx.heartbeat();
          processedSinceHeartbeat = 0;
        }

        // Layer B: budget gate. acquireEmbedSlot inside bgeWithTimeout
        // already handles per-second pacing for over_cap via backoff; only
        // circuit_open is a hard skip here. The row stays pending — next
        // tick will retry when the circuit closes (30 min default).
        const budget = await checkBudget(env, orgId, null, 'bge', 'per_second');
        if (budget.decision === 'circuit_open') {
          budget_skipped++;
          console.log(
            `[embed-retry-queue] BGE circuit open until ${budget.circuit_open_until} — skipping ${item.id}; will retry next tick`
          );
          continue;
        }

        await env.D1.prepare(
          `UPDATE embed_retry_queue
              SET status = 'in_progress',
                  attempts = attempts + 1,
                  last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`
        ).bind(item.id).run();

        try {
          // Per-item wallclock cap. Promise.race against a setTimeout
          // bounds the worst-case extraction hang; clearTimeout in
          // finally prevents timer-handle leaks on the success path.
          // On timeout: throws 'EMBED_ITEM_TIMEOUT' into the catch
          // block below — distinct from 'EMBED_RATE_LIMIT_TIMEOUT' and
          // 429-shaped errors so the catch's substring detection does
          // NOT mistakenly fire recordRateLimit. The hung underlying
          // promise continues running in the background until the
          // worker isolate is reaped — bounded by CF runtime.
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('EMBED_ITEM_TIMEOUT after 60s')),
              EMBED_ITEM_TIMEOUT_MS
            );
          });
          let ok: 'embedded' | 'skipped' | 'missing';
          try {
            ok = await Promise.race([
              embedSingleItem(item.entity_id, item.source_table, orgId, env),
              timeoutPromise,
            ]);
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          }
          // Record usage on every BGE call attempt that didn't throw —
          // bgeWithTimeout fired the actual embedding API, so the per-
          // second bucket bumps regardless of whether the source row
          // turned out 'missing' (deleted before retry) or genuinely
          // 'embedded' / 'skipped'. Conservative attribution.
          await recordUsage(env, orgId, null, 'bge', 'per_second');
          if (ok === 'missing') {
            // Source row was deleted between enqueue and retry — clean up.
            await env.D1.prepare(`DELETE FROM embed_retry_queue WHERE id = ?`).bind(item.id).run();
          } else {
            await env.D1.prepare(`DELETE FROM embed_retry_queue WHERE id = ?`).bind(item.id).run();
            succeeded += 1;
          }
        } catch (e: any) {
          const errMsg = String(e?.message || e).slice(0, 500);
          // Detect rate-limit-shaped errors so the ledger's circuit-
          // breaker auto-tune-down learns. EMBED_RATE_LIMIT_TIMEOUT is
          // thrown by acquireEmbedSlot when the per-second slot waits
          // >30s; HTTP 429 / 'rate_limit' surface from CF Workers AI
          // when BGE itself is overloaded. Either signal counts as a
          // 429 against the bucket.
          if (
            errMsg.includes('EMBED_RATE_LIMIT_TIMEOUT') ||
            errMsg.includes('429') ||
            errMsg.includes('rate_limit')
          ) {
            await recordRateLimit(env, orgId, null, 'bge', 'per_second');
          }
          const newAttempts = item.attempts + 1;
          const newStatus = newAttempts >= MAX_ATTEMPTS ? 'failed_permanent' : 'pending';
          await env.D1.prepare(
            `UPDATE embed_retry_queue SET status = ?, last_error = ? WHERE id = ?`
          ).bind(newStatus, errMsg, item.id).run();
          failed += 1;
        }

        // 100ms pacing — the limiter handles cross-org pacing, this just keeps
        // a single drain from monopolizing the BGE slot.
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(
        `[embed-retry-queue] org=${orgId} processed=${queued.results.length} succeeded=${succeeded} failed=${failed} budget_skipped=${budget_skipped}`
      );

      ctx.report({
        items_processed: queued.results.length,
        items_failed: failed,
        items_skipped: budget_skipped,
        metadata: { succeeded, stale_reset, budget_skipped },
      });

      return {
        processed: queued.results.length,
        succeeded,
        failed,
        stale_reset,
      };
    }
  );

  // Fallback when withTaskRun returned null (openTaskRun's D1 INSERT
  // failed, or — vanishingly rare — an idempotency collision happened).
  // Caller (cron try/catch + admin endpoint) is unaffected; the next
  // tick re-runs and converges. Returning zero counts preserves the
  // existing return-shape contract.
  return result ?? { processed: 0, succeeded: 0, failed: 0, stale_reset: 0 };
}

export type { DocumentEmbedResult } from './document-embedding';
export { embedDocumentItemForRepair as embedDocumentItem };

// Re-embed a single item from its source table. Returns:
//   'embedded' — vectors written to vector_entity_index
//   'skipped'  — item already has vectors (dedup guard hit), nothing to do
//   'missing'  — source row gone (deleted since enqueue)
// Exported in Phase 6 1a (2026-05-05) so the work_queue embed_retry
// handler at src/lib/work-queue-handlers/embed-retry.ts can call it
// directly. Function is otherwise unchanged from the prior in-house
// drain — only the calling surface widened.
export async function embedSingleItem(
  entityId: string,
  sourceTable: string,
  orgId: string,
  env: Env
): Promise<'embedded' | 'skipped' | 'missing'> {
  const { chunkEmbedAndPersistAll } = await import('./embedding');

  if (sourceTable === 'conversations') {
    const { resolvePrimaryEntityId } = await import('./embedding');
    const row = await env.D1.prepare(
      `SELECT id, body_r2_key, source, subject, sent_at, participant_user_ids,
              from_email, from_contact_id
         FROM conversations WHERE id = ? AND org_id = ?`
    ).bind(entityId, orgId).first<{
      id: string; body_r2_key: string | null; source: string;
      subject: string | null; sent_at: string | null; participant_user_ids: string | null;
      from_email: string | null; from_contact_id: string | null;
    }>();
    if (!row) return 'missing';
    if (!row.body_r2_key) throw new Error('conversation has no body_r2_key');

    const obj = await env.R2.get(row.body_r2_key);
    if (!obj) throw new Error(`R2 body missing: ${row.body_r2_key}`);
    const body = await obj.text();

    const internalEmails = await loadInternalUserEmails(orgId, env);
    const toContacts = await env.D1.prepare(
      `SELECT contact_id FROM conversation_contacts WHERE conversation_id = ?
         AND role IN ('to','cc') ORDER BY role = 'to' DESC`
    ).bind(row.id).all<{ contact_id: string }>();

    const docType = row.source === 'manual' ? 'transcript'
      : row.source === 'slack' ? 'conversation'
      : 'email';

    const entries = await chunkEmbedAndPersistAll(body, {
      org_id: orgId,
      visibility: visibilityForBackfill(row.source),
      participant_user_ids: participantsForVectorMeta(row.participant_user_ids),
      document_type: docType,
      source_table: 'conversations',
      source_id: row.id,
      r2_key: row.body_r2_key,
      created_at: row.sent_at || new Date().toISOString(),
      primary_entity_id: resolvePrimaryEntityId({
        document_type: docType,
        source: row.source,
        source_id: row.id,
        from_contact_id: row.from_contact_id,
        from_email: row.from_email,
        to_contact_ids: toContacts.results.map(r => r.contact_id),
        internal_user_emails: internalEmails,
      }),
      entity_name: row.subject || undefined,
      date: row.sent_at || undefined,
    }, env);

    if (entries.length === 0) return 'skipped';
    await env.D1.batch(
      entries.map(e =>
        env.D1.prepare(
          'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
        ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
      )
    );
    return 'embedded';
  }

  if (sourceTable === 'events') {
    const row = await env.D1.prepare(
      `SELECT id, title, summary, transcript_r2_key, start_time
         FROM events WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(entityId, orgId).first<{
      id: string; title: string; summary: string | null;
      transcript_r2_key: string | null; start_time: string;
    }>();
    if (!row) return 'missing';

    let text = '';
    let r2Key = '';
    let isTranscript = false;
    if (row.transcript_r2_key) {
      const obj = await env.R2.get(row.transcript_r2_key);
      if (obj) {
        text = await obj.text();
        r2Key = row.transcript_r2_key;
        isTranscript = true;
      }
    }
    if (!isTranscript) {
      const titleText = (row.title || '').trim();
      const summaryText = (row.summary || '').trim();
      text = summaryText
        ? (titleText ? `${titleText}\n\n${summaryText}` : summaryText)
        : titleText;
    }
    if (!text || text.trim().length < 10) return 'missing';

    // Phase 8 1a (2026-05-05): events ACL — mirror
    // backfillUnembeddedEvents's T4 hotfix logic. Transcript-backed
    // events with internal user attendees get visibility='private' +
    // participant_user_ids; calendar-only events stay 'org_wide'. This
    // closes the 71-Outlook-with-transcript subgap so reconciled
    // events get the SAME ACL their Firefly twin would have. Pre-Phase-8,
    // embedSingleItem hardcoded 'org_wide' for all events — meaning any
    // event re-embedded via the embed_retry handler would silently
    // regress its ACL. Phase 8's enqueuer migration depends on this
    // correctness fix shipping in the same sub-stage.
    let visibility: 'private' | 'org_wide' = 'org_wide';
    let participantUserIds: string | undefined = undefined;
    if (isTranscript) {
      const attendees = await env.D1.prepare(
        `SELECT user_id FROM event_attendees
           WHERE event_id = ? AND user_id IS NOT NULL`
      ).bind(row.id).all<{ user_id: string }>();
      const internalIds = attendees.results.map(a => a.user_id).filter(Boolean);
      if (internalIds.length > 0) {
        visibility = 'private';
        participantUserIds = internalIds.join(',');
      }
    }

    const entries = await chunkEmbedAndPersistAll(text, {
      org_id: orgId,
      visibility,
      participant_user_ids: participantUserIds,
      document_type: 'transcript',
      source_table: 'events',
      source_id: row.id,
      r2_key: r2Key,
      created_at: row.start_time,
      primary_entity_id: row.id,
      entity_name: row.title,
      date: row.start_time,
    }, env);

    if (entries.length === 0) return 'skipped';
    await env.D1.batch(
      entries.map(e =>
        env.D1.prepare(
          'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
        ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
      )
    );
    return 'embedded';
  }

  if (sourceTable === 'documents') {
    const result = await embedDocumentItemForRepair(entityId, orgId, env);
    if (result.status === 'partial') return 'embedded';
    if (result.status === 'unembeddable') return 'skipped';
    return result.status;
  }

  throw new Error(`unknown source_table: ${sourceTable}`);
}

async function cleanupExpiredResetTokens(env: Env): Promise<void> {
  await env.D1.prepare(
    `DELETE FROM password_reset_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`
  ).run();
  await env.D1.prepare(
    `DELETE FROM email_verification_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`
  ).run();
}

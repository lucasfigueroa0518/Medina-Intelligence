// Wave 2 — admin company-merge endpoint.
//
// When a duplicate company entity is identified (same conceptual company
// resolved as two rows due to name/domain divergence), this endpoint
// repoints all dependent rows from the loser → survivor, soft-deletes
// the loser with merged_into pointing at the survivor.
//
// Reuses the same shape as the in-process resolveCompanyName helper in
// src/lib/enrichment.ts:1068 — extracted here so it can be triggered
// explicitly without firing enrichment.
//
// Tables touched:
//   • contacts.company_id          → survivor
//   • deals.company_id             → survivor (then dedup is your problem
//                                    via Wave 2's UNIQUE INDEX — caller
//                                    should soft-delete loser-side deals
//                                    or close-won them BEFORE merging if
//                                    both companies have open deals)
//   • documents.company_id         → survivor
//   • tasks.company_id             → survivor
//   • news_articles.company_id     → survivor
//   • company_tags(company_id=loser) → DELETE (tags are usually identical
//                                    on both rows; survivor keeps its own)
//   • companies.merged_into        → survivor on loser, deleted_at stamped
//
// Tables NOT touched (intentional):
//   • deal_contacts, conversation_deals, event_deals — keyed by deal_id
//     which doesn't change; the deals.company_id update is sufficient.
//   • deal_intelligence — keyed by deal_id, unaffected.
//   • approval_queue — left in place; entity_id may still point at loser
//     for company-typed proposals but that's harmless (resolver follows
//     merged_into transitively in retrieval.ts queries).
//
// Owner-only. dry_run mode reports the row counts without applying.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { emitAudit } from '../lib/audit';

interface MergeBody {
  loser_id: string;
  survivor_id: string;
  dry_run?: boolean;
}

export async function handleMergeCompanies(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') return errorResponse('FORBIDDEN', 403, 'owner-only');

  const body = await parseJsonBody<MergeBody>(request);
  if (!body?.loser_id || !body?.survivor_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'loser_id and survivor_id required');
  }
  if (body.loser_id === body.survivor_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'loser_id == survivor_id');
  }
  const dryRun = body.dry_run !== false;

  // Verify both rows exist in the org and aren't already merged.
  const loser = await env.D1.prepare(
    `SELECT id, name, domain, deleted_at, merged_into FROM companies
       WHERE id = ? AND org_id = ?`
  ).bind(body.loser_id, ctx.orgId).first<{ id: string; name: string; domain: string | null; deleted_at: string | null; merged_into: string | null }>();
  const survivor = await env.D1.prepare(
    `SELECT id, name, domain, deleted_at, merged_into FROM companies
       WHERE id = ? AND org_id = ?`
  ).bind(body.survivor_id, ctx.orgId).first<{ id: string; name: string; domain: string | null; deleted_at: string | null; merged_into: string | null }>();
  if (!loser) return errorResponse('NOT_FOUND', 404, 'loser company not found');
  if (!survivor) return errorResponse('NOT_FOUND', 404, 'survivor company not found');
  if (loser.merged_into) return errorResponse('CONFLICT', 409, `loser already merged into ${loser.merged_into}`);
  if (survivor.deleted_at) return errorResponse('CONFLICT', 409, 'survivor is soft-deleted');

  // Pre-flight: would the merge violate the open-deal-per-company unique
  // index? If both rows have open deals, abort with a clear message —
  // caller must close one side first.
  const openDealConflict = await env.D1.prepare(
    `SELECT 1 FROM deals
       WHERE org_id = ?
         AND company_id IN (?, ?)
         AND deleted_at IS NULL
         AND stage != 'closed'
       GROUP BY company_id HAVING COUNT(*) >= 1
       LIMIT 2`
  ).bind(ctx.orgId, loser.id, survivor.id).all<{ '1': number }>();
  if (openDealConflict.results.length > 1) {
    return errorResponse(
      'OPEN_DEAL_CONFLICT', 409,
      `Both companies have open deals. Close one side before merging, or run /api/admin/dedup-deals first.`
    );
  }

  // Count rows that will be repointed.
  const counts = {
    contacts: await countWhere(env, 'contacts', loser.id, ctx.orgId),
    deals: await countWhere(env, 'deals', loser.id, ctx.orgId),
    documents: await countWhere(env, 'documents', loser.id, ctx.orgId),
    tasks: await countWhere(env, 'tasks', loser.id, ctx.orgId),
    news_articles: await countWhere(env, 'news_articles', loser.id, ctx.orgId),
    company_tags: await env.D1.prepare(
      `SELECT COUNT(*) AS n FROM company_tags WHERE company_id = ?`
    ).bind(loser.id).first<{ n: number }>().then(r => r?.n || 0),
  };

  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      loser: { id: loser.id, name: loser.name, domain: loser.domain },
      survivor: { id: survivor.id, name: survivor.name, domain: survivor.domain },
      would_repoint: counts,
    });
  }

  // Apply.
  const now = new Date().toISOString();
  await env.D1.batch([
    env.D1.prepare(`UPDATE contacts SET company_id = ?, updated_at = ? WHERE company_id = ?`).bind(survivor.id, now, loser.id),
    env.D1.prepare(`UPDATE deals SET company_id = ?, updated_at = ? WHERE company_id = ?`).bind(survivor.id, now, loser.id),
    env.D1.prepare(`UPDATE documents SET company_id = ? WHERE company_id = ?`).bind(survivor.id, loser.id),
    env.D1.prepare(`UPDATE tasks SET company_id = ? WHERE company_id = ?`).bind(survivor.id, loser.id),
    env.D1.prepare(`UPDATE news_articles SET company_id = ? WHERE company_id = ?`).bind(survivor.id, loser.id),
    env.D1.prepare(`DELETE FROM company_tags WHERE company_id = ?`).bind(loser.id),
    env.D1.prepare(`UPDATE companies SET merged_into = ?, deleted_at = ?, updated_at = ? WHERE id = ?`).bind(survivor.id, now, now, loser.id),
  ]);

  await emitAudit(env, {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    action: 'merge',
    entity_type: 'company',
    entity_id: loser.id,
    after_data: { merged_into: survivor.id, repointed: counts },
    created_at: now,
  });

  return jsonResponse({
    dry_run: false,
    loser: { id: loser.id, name: loser.name },
    survivor: { id: survivor.id, name: survivor.name },
    repointed: counts,
  });
}

async function countWhere(env: Env, table: string, companyId: string, orgId: string): Promise<number> {
  const r = await env.D1.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ? AND org_id = ?`
  ).bind(companyId, orgId).first<{ n: number }>();
  return r?.n || 0;
}

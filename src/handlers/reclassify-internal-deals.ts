// Wave 1 — admin recovery sweep: classify internal Medina-side companies
// + soft-delete deals targeting them.
//
// Two passes per invocation:
//   PASS 1 — for every company in the org, re-evaluate is_internal_entity
//     against the rule (domain match user emails ∪ known fund-family
//     domains ∪ name patterns). Updates flag where it diverges from rule.
//   PASS 2 — for every deal whose target company is now flagged internal,
//     soft-delete (set deleted_at + audit) so the /deals board no longer
//     surfaces them. Companion approval_queue rows of change_type
//     'create_deal' targeting internal companies are also rejected.
//
// dry_run: returns the counts without applying mutations. Default true.
// Owner-only.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { resolveInternalDomains, classifyCompanyInternal } from '../lib/internal-entity';
import { emitAudit } from '../lib/audit';

interface SweepBody {
  dry_run?: boolean;
  limit?: number;
}

export async function handleReclassifyInternalDeals(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') return errorResponse('FORBIDDEN', 403, 'owner-only');

  const body = (await parseJsonBody<SweepBody>(request)) || {};
  const dryRun = body.dry_run !== false; // default true
  const limit = Math.max(1, Math.min(body.limit ?? 5000, 10000));

  const internalDomains = await resolveInternalDomains(ctx.orgId, env);
  const now = new Date().toISOString();

  // ── PASS 1: re-classify companies ────────────────────────────────────
  const companies = await env.D1.prepare(
    `SELECT id, name, domain, is_internal_entity FROM companies
       WHERE org_id = ? AND deleted_at IS NULL
       LIMIT ?`
  ).bind(ctx.orgId, limit).all<{ id: string; name: string; domain: string | null; is_internal_entity: number }>();

  let companiesScanned = companies.results.length;
  let companiesFlippedInternal = 0;
  let companiesFlippedExternal = 0;
  const newlyInternalIds: string[] = [];
  const cache = new Map<string, Set<string>>();
  cache.set(ctx.orgId, internalDomains);

  for (const c of companies.results) {
    if (dryRun) {
      // Compute target without mutating.
      const domainLower = (c.domain || '').toLowerCase();
      const byDomain = !!domainLower && internalDomains.has(domainLower);
      const byName = /^medina (ventures|capital|partners|fund)\b|^gryphon capital\b|^jfg family\b/i.test(c.name || '');
      const target = byDomain || byName ? 1 : 0;
      if (target !== c.is_internal_entity) {
        if (target === 1) { companiesFlippedInternal++; newlyInternalIds.push(c.id); }
        else companiesFlippedExternal++;
      } else if (c.is_internal_entity === 1) {
        newlyInternalIds.push(c.id); // still internal — relevant to pass 2
      }
    } else {
      const r = await classifyCompanyInternal(c.id, ctx.orgId, env, cache);
      if (r.changed) {
        if (r.is_internal) companiesFlippedInternal++;
        else companiesFlippedExternal++;
      }
      if (r.is_internal) newlyInternalIds.push(c.id);
    }
  }

  // ── PASS 2: soft-delete deals targeting internal companies ──────────
  let dealsAffected = 0;
  const dealsAffectedRows: Array<{ id: string; title: string; company_name: string | null }> = [];
  let approvalQueueRejected = 0;

  if (newlyInternalIds.length > 0) {
    const placeholders = newlyInternalIds.map(() => '?').join(',');
    const deals = await env.D1.prepare(
      `SELECT d.id, d.title, c.name AS company_name
         FROM deals d LEFT JOIN companies c ON c.id = d.company_id
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.company_id IN (${placeholders})`
    ).bind(ctx.orgId, ...newlyInternalIds).all<{ id: string; title: string; company_name: string | null }>();

    dealsAffected = deals.results.length;
    dealsAffectedRows.push(...deals.results);

    if (!dryRun) {
      for (const d of deals.results) {
        await env.D1.prepare(
          `UPDATE deals
              SET deleted_at = ?, updated_at = ?
            WHERE id = ? AND org_id = ?`
        ).bind(now, now, d.id, ctx.orgId).run();
        await emitAudit(env, {
          org_id: ctx.orgId,
          user_id: ctx.userId,
          action: 'soft_delete',
          entity_type: 'deal',
          entity_id: d.id,
          before_data: { title: d.title, company_name: d.company_name },
          after_data: { reason: 'wave_1_internal_entity_reclassify' },
          created_at: now,
        });
      }
    }

    // Reject pending create_deal proposals for internal companies. They
    // can't be committed anyway (commitCreateDealApproval skips them post-
    // Wave-1), but explicit rejection cleans up the inbox UI.
    const aq = await env.D1.prepare(
      `SELECT id, proposed_value FROM approval_queue
         WHERE org_id = ? AND status = 'pending'
           AND change_type = 'create_deal'`
    ).bind(ctx.orgId).all<{ id: string; proposed_value: string }>();
    const internalSet = new Set(newlyInternalIds);
    for (const q of aq.results) {
      try {
        const payload = JSON.parse(q.proposed_value);
        if (payload?.company_id && internalSet.has(payload.company_id)) {
          approvalQueueRejected++;
          if (!dryRun) {
            await env.D1.prepare(
              `UPDATE approval_queue
                  SET status = 'rejected', resolved_at = ?, resolved_by = ?
                WHERE id = ?`
            ).bind(now, ctx.userId, q.id).run();
          }
        }
      } catch { /* skip malformed */ }
    }
  }

  return jsonResponse({
    dry_run: dryRun,
    companies_scanned: companiesScanned,
    companies_flipped_internal: companiesFlippedInternal,
    companies_flipped_external: companiesFlippedExternal,
    companies_internal_total: newlyInternalIds.length,
    deals_soft_deleted: dryRun ? 0 : dealsAffected,
    deals_to_soft_delete: dryRun ? dealsAffected : undefined,
    deals_affected: dealsAffectedRows,
    approval_queue_rejected: dryRun ? 0 : approvalQueueRejected,
    approval_queue_to_reject: dryRun ? approvalQueueRejected : undefined,
  });
}

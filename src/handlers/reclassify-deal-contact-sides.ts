// Wave 5 — admin recovery: re-classify every existing deal_contacts.side
// using the new domain-based rule.
//
// Old logic: deal_contacts inserts always defaulted to side='theirs'
// regardless of contact email or relation. Internal-domain contacts could
// therefore appear on the counterparty side until this recovery ran.
//
// New rule (mirrors classifyContactSide):
//   1. ours   — contact email domain in internal_domains
//   2. theirs — contact.company_id == deal.company_id
//   3. other  — neither
//
// Owner-only. dry_run=true returns the would-change count without
// applying. Idempotent — re-running yields the same flag distribution.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { resolveInternalDomains, classifyContactSideSync } from '../lib/internal-entity';
import { emitAudit } from '../lib/audit';

interface SweepBody { dry_run?: boolean }

export async function handleReclassifyDealContactSides(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') return errorResponse('FORBIDDEN', 403, 'owner-only');

  const body = (await parseJsonBody<SweepBody>(request)) || {};
  const dryRun = body.dry_run !== false;

  const internalDomains = await resolveInternalDomains(ctx.orgId, env);

  // Pull every active deal_contacts row joined with the deal's company_id
  // and the contact's email + company_id. One round-trip; per-row work
  // happens in-memory.
  const rows = await env.D1.prepare(
    `SELECT dc.id AS deal_contact_id, dc.deal_id, dc.contact_id, dc.side AS current_side,
            d.company_id AS deal_company_id,
            c.email AS contact_email, c.company_id AS contact_company_id,
            c.full_name
       FROM deal_contacts dc
       JOIN deals d ON d.id = dc.deal_id
       JOIN contacts c ON c.id = dc.contact_id
      WHERE d.org_id = ? AND d.deleted_at IS NULL AND c.deleted_at IS NULL`
  ).bind(ctx.orgId).all<{
    deal_contact_id: string;
    deal_id: string;
    contact_id: string;
    current_side: string | null;
    deal_company_id: string | null;
    contact_email: string | null;
    contact_company_id: string | null;
    full_name: string | null;
  }>();

  let scanned = 0;
  let changed = 0;
  const flips: Record<string, number> = {};
  const sample: Array<{ deal_id: string; contact_name: string | null; from: string | null; to: string }> = [];

  const updates: Array<{ id: string; side: string }> = [];
  for (const r of rows.results) {
    scanned++;
    const target = classifyContactSideSync(
      r.contact_email, r.contact_company_id, r.deal_company_id, internalDomains
    );
    if (target === r.current_side) continue;
    changed++;
    const key = `${r.current_side ?? 'null'}_to_${target}`;
    flips[key] = (flips[key] ?? 0) + 1;
    if (sample.length < 25) {
      sample.push({ deal_id: r.deal_id, contact_name: r.full_name, from: r.current_side, to: target });
    }
    updates.push({ id: r.deal_contact_id, side: target });
  }

  if (!dryRun && updates.length > 0) {
    const stmts = updates.map(u =>
      env.D1.prepare(`UPDATE deal_contacts SET side = ? WHERE id = ?`).bind(u.side, u.id)
    );
    // Batch — D1 chunks internally if oversized.
    await env.D1.batch(stmts);
    await emitAudit(env, {
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: 'update',
      entity_type: 'deal',
      entity_id: 'side_reclassify_sweep',
      metadata: { sub_action: 'reclassify_deal_contact_sides', changed, flips },
      created_at: new Date().toISOString(),
    });
  }

  return jsonResponse({
    dry_run: dryRun,
    scanned,
    changed: dryRun ? 0 : changed,
    would_change: dryRun ? changed : undefined,
    flip_distribution: flips,
    sample,
  });
}

// Wave 1 — "deal = startup Medina is evaluating" semantics enforcement.
//
// A deal MUST point at a company that is not one of the org's own internal
// entities (fund vehicles, LP families, parent-capital companies). This
// module provides:
//
//   1. isCompanyInternal — read-side check, used by validators.
//   2. assertExternalCompanyForDeal — throw when caller tries to deal-bind
//      an internal entity. Wired into both the manual createDeal handler
//      and commitCreateDealApproval (proposal commit path).
//   3. classifyCompanyInternal — write-side: re-evaluate the flag for a
//      single company given the org's authoritative internal-domain set.
//      Called at company create + on demand from admin tooling.
//   4. resolveInternalDomains — pull the org's internal-domain set from
//      users.email + companies.is_internal_entity.
//
// The classification rule (mirrors migration 0074):
//   • domain matches a user email domain at this org → internal.
//   • catch-all name patterns: 'Medina Ventures', 'Medina Capital',
//     'Medina Partners', 'Medina Fund', 'Gryphon Capital', 'JFG Family'.
//   • known fund-family domains: medinacapital.com, gryphcap.com,
//     jfgfamilyoffice.com.
//
// All three signals are independent — any one fires and the company is
// internal. Enforcement is at write (deal create / proposal commit) and
// at the LLM-detection pre-filter (deal-detection.ts skips internal
// companies before spending a Claude call).

import type { Env } from '../types/env';

const INTERNAL_NAME_PATTERNS = [
  /^medina ventures\b/i,
  /^medina capital\b/i,
  /^medina partners\b/i,
  /^medina fund\b/i,
  /^gryphon capital\b/i,
  /^jfg family\b/i,
];

const KNOWN_INTERNAL_DOMAINS = new Set([
  'medinacapital.com',
  'gryphcap.com',
  'jfgfamilyoffice.com',
]);

/** Pull the org's authoritative internal-domain set: every user email
 *  domain at the org. Cached per request via a Map (caller passes one
 *  in to avoid re-querying when classifying a batch). */
export async function resolveInternalDomains(
  orgId: string,
  env: Env,
  cache?: Map<string, Set<string>>
): Promise<Set<string>> {
  if (cache?.has(orgId)) return cache.get(orgId)!;
  const rows = await env.D1.prepare(
    `SELECT DISTINCT lower(substr(email, instr(email,'@')+1)) AS domain
       FROM users
      WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(orgId).all<{ domain: string }>();
  const set = new Set<string>();
  for (const r of rows.results) {
    if (r.domain) set.add(r.domain);
  }
  for (const d of KNOWN_INTERNAL_DOMAINS) set.add(d);
  cache?.set(orgId, set);
  return set;
}

/** True if a company should be treated as an internal Medina-side entity.
 *  Hot path — relies on the cached is_internal_entity column. */
export async function isCompanyInternal(
  companyId: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  const row = await env.D1.prepare(
    `SELECT is_internal_entity FROM companies
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<{ is_internal_entity: number }>();
  return row?.is_internal_entity === 1;
}

/** Validation-side throw: rejects deal binding to internal entities. */
export class InternalDealError extends Error {
  status = 400;
  code = 'INTERNAL_ENTITY_NOT_DEAL_ELIGIBLE';
  constructor(public companyId: string, public companyName?: string) {
    super(
      `Cannot create deal for internal entity${companyName ? ` "${companyName}"` : ''}. ` +
      `A deal represents a startup Medina is evaluating for investment.`
    );
  }
}

/** Throws InternalDealError if the company is internal. Caller catches
 *  and maps to a 400 (handler) or skip (proposal commit). */
export async function assertExternalCompanyForDeal(
  companyId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const row = await env.D1.prepare(
    `SELECT id, name, is_internal_entity FROM companies
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<{ id: string; name: string; is_internal_entity: number }>();
  if (!row) return; // Different error path (company missing); caller handles.
  if (row.is_internal_entity === 1) {
    throw new InternalDealError(companyId, row.name);
  }
}

/** Wave 2 — refuse to create a second open deal at the same company.
 *  Surfaces a structured 409 before the partial UNIQUE INDEX
 *  uniq_deals_open_per_company throws an opaque constraint error.
 *  excludeDealId lets the validator be re-used during stage updates. */
export class OpenDealConflictError extends Error {
  status = 409;
  code = 'OPEN_DEAL_ALREADY_EXISTS';
  constructor(public companyId: string, public existingDealId: string, public existingTitle: string) {
    super(
      `An open deal already exists for this company ("${existingTitle}", id ${existingDealId}). ` +
      `Close the existing deal (closed_won or closed_lost) before creating a new one, ` +
      `or update the existing deal in place.`
    );
  }
}

export async function assertNoOpenDealForCompany(
  companyId: string,
  orgId: string,
  env: Env,
  excludeDealId?: string
): Promise<void> {
  const existing = await env.D1.prepare(
    `SELECT id, title FROM deals
       WHERE org_id = ? AND company_id = ?
         AND deleted_at IS NULL
         AND stage NOT IN ('closed_won','closed_lost')
         AND id != ?
       LIMIT 1`
  ).bind(orgId, companyId, excludeDealId || '').first<{ id: string; title: string }>();
  if (existing) {
    throw new OpenDealConflictError(companyId, existing.id, existing.title);
  }
}

/** Re-classify a single company against the rule. Returns whether the
 *  flag changed. Idempotent. Used at company create time + admin recovery. */
export async function classifyCompanyInternal(
  companyId: string,
  orgId: string,
  env: Env,
  domainCache?: Map<string, Set<string>>
): Promise<{ changed: boolean; is_internal: boolean }> {
  const company = await env.D1.prepare(
    `SELECT name, domain, is_internal_entity FROM companies
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<{ name: string; domain: string | null; is_internal_entity: number }>();
  if (!company) return { changed: false, is_internal: false };

  const internalDomains = await resolveInternalDomains(orgId, env, domainCache);
  const domainLower = (company.domain || '').toLowerCase();
  const nameRaw = company.name || '';

  const byDomain = !!domainLower && internalDomains.has(domainLower);
  const byName = INTERNAL_NAME_PATTERNS.some(re => re.test(nameRaw));
  const target = byDomain || byName ? 1 : 0;

  if (target !== company.is_internal_entity) {
    await env.D1.prepare(
      `UPDATE companies
          SET is_internal_entity = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(target, companyId).run();
    return { changed: true, is_internal: target === 1 };
  }
  return { changed: false, is_internal: target === 1 };
}

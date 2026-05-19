import type { Env } from '../types/env';
import { PERSONAL_DOMAINS, registrableDomain } from './discovery';

export interface CompanyDomainCandidate {
  id?: string;
  name?: string | null;
  domain?: string | null;
  website?: string | null;
}

export interface ContactCompanyAffiliationEvidence {
  verified: boolean;
  reason:
    | 'domain_match'
    | 'missing_contact_email'
    | 'personal_email_domain'
    | 'missing_company_domain'
    | 'domain_mismatch';
  contact_domain?: string;
  company_domains: string[];
}

export interface CompanyAffiliationRepairStats {
  scanned: number;
  unlinked: number;
  associations_deleted: number;
}

export function normalizeDomain(value: string | null | undefined): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const withoutProtocol = raw
    .replace(/^mailto:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
  const host = withoutProtocol.includes('@')
    ? withoutProtocol.split('@').pop() || ''
    : withoutProtocol.split('/')[0];
  const cleaned = host.split(':')[0].replace(/^www\./, '').trim();
  if (!cleaned || !cleaned.includes('.')) return null;
  return registrableDomain(cleaned);
}

export function emailDomain(email: string | null | undefined): string | null {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw.includes('@')) return null;
  return normalizeDomain(raw);
}

export function companyDomainCandidates(company: CompanyDomainCandidate): string[] {
  const domains = [
    normalizeDomain(company.domain),
    normalizeDomain(company.website),
  ].filter((d): d is string => !!d && !PERSONAL_DOMAINS.has(d));
  return Array.from(new Set(domains));
}

export function evaluateContactCompanyAffiliation(
  contact: { email?: string | null },
  company: CompanyDomainCandidate
): ContactCompanyAffiliationEvidence {
  const contactDomain = emailDomain(contact.email);
  const companyDomains = companyDomainCandidates(company);

  if (!contactDomain) {
    return { verified: false, reason: 'missing_contact_email', company_domains: companyDomains };
  }
  if (PERSONAL_DOMAINS.has(contactDomain)) {
    return {
      verified: false,
      reason: 'personal_email_domain',
      contact_domain: contactDomain,
      company_domains: companyDomains,
    };
  }
  if (companyDomains.length === 0) {
    return {
      verified: false,
      reason: 'missing_company_domain',
      contact_domain: contactDomain,
      company_domains: [],
    };
  }
  if (companyDomains.includes(contactDomain)) {
    return {
      verified: true,
      reason: 'domain_match',
      contact_domain: contactDomain,
      company_domains: companyDomains,
    };
  }
  return {
    verified: false,
    reason: 'domain_mismatch',
    contact_domain: contactDomain,
    company_domains: companyDomains,
  };
}

export async function isVerifiedContactCompanyAffiliation(
  env: Env,
  orgId: string,
  contactEmail: string | null | undefined,
  companyId: string | null | undefined
): Promise<ContactCompanyAffiliationEvidence & { company_id: string | null }> {
  if (!companyId) {
    return { verified: false, reason: 'missing_company_domain', company_domains: [], company_id: null };
  }
  const company = await env.D1.prepare(
    `SELECT id, name, domain, website
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<CompanyDomainCandidate>();
  if (!company) {
    return { verified: false, reason: 'missing_company_domain', company_domains: [], company_id: null };
  }
  return {
    ...evaluateContactCompanyAffiliation({ email: contactEmail }, company),
    company_id: companyId,
  };
}

export async function deleteSameCompanyAssociationsForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<number> {
  const result = await env.D1.prepare(
    `DELETE FROM entity_associations
      WHERE org_id = ?
        AND association_type = 'same_company'
        AND (
          (entity_a_type = 'contact' AND entity_a_id = ?)
          OR (entity_b_type = 'contact' AND entity_b_id = ?)
        )`
  ).bind(orgId, contactId, contactId).run();
  return result.meta?.changes || 0;
}

export async function repairInvalidCompanyAffiliations(
  orgId: string,
  env: Env,
  opts: { companyId?: string; contactId?: string; limit?: number } = {}
): Promise<CompanyAffiliationRepairStats> {
  const where = [
    'c.org_id = ?',
    'c.deleted_at IS NULL',
    'c.company_id IS NOT NULL',
    'co.deleted_at IS NULL',
  ];
  const binds: unknown[] = [orgId];
  if (opts.companyId) {
    where.push('c.company_id = ?');
    binds.push(opts.companyId);
  }
  if (opts.contactId) {
    where.push('c.id = ?');
    binds.push(opts.contactId);
  }
  const limit = Math.max(1, Math.min(opts.limit || 500, 1000));
  const rows = await env.D1.prepare(
    `SELECT c.id, c.email, c.company_id, co.name AS company_name,
            co.domain AS company_domain, co.website AS company_website
       FROM contacts c
       JOIN companies co ON co.id = c.company_id AND co.org_id = c.org_id
      WHERE ${where.join(' AND ')}
      LIMIT ?`
  ).bind(...binds, limit).all<{
    id: string;
    email: string | null;
    company_id: string;
    company_name: string | null;
    company_domain: string | null;
    company_website: string | null;
  }>();

  let unlinked = 0;
  let associationsDeleted = 0;
  for (const row of rows.results) {
    const evidence = evaluateContactCompanyAffiliation(
      { email: row.email },
      {
        id: row.company_id,
        name: row.company_name,
        domain: row.company_domain,
        website: row.company_website,
      }
    );

    // Only unlink on contradictory evidence. Missing email/domain is not proof
    // of a wrong employer, but a different corporate domain is.
    if (
      evidence.reason !== 'domain_mismatch' &&
      !(evidence.reason === 'personal_email_domain' && evidence.company_domains.length > 0)
    ) {
      continue;
    }

    await env.D1.prepare(
      `UPDATE contacts
          SET company_id = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ? AND company_id = ?`
    ).bind(row.id, orgId, row.company_id).run();
    unlinked++;
    associationsDeleted += await deleteSameCompanyAssociationsForContact(env, orgId, row.id);
  }

  return {
    scanned: rows.results.length,
    unlinked,
    associations_deleted: associationsDeleted,
  };
}

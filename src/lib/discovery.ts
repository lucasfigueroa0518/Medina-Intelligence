// TRD §7.3 — New contact discovery with company auto-association
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { emitAudit } from './audit';
import { triggerContactEnrichment } from './enrichment';

// Domains whose mail is always automated/transactional — never discover as contacts.
export const AUTOMATED_DOMAINS = new Set<string>([
  'slack.com',
  'anthropic.com',
  'godaddy.com',
  'fireflies.ai',
  'google.com',
  'microsoft.com',
  'github.com',
  'stripe.com',
  'notion.so',
  'linear.app',
  'figma.com',
  'vercel.com',
  'cloudflare.com',
  'amazonaws.com',
]);

// Local-part keywords that indicate an automated/shared mailbox.
export const AUTOMATED_LOCAL_KEYWORDS: string[] = [
  'noreply',
  'no-reply',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'digest',
  'newsletter',
  'unsubscribe',
  'automated',
  'mailer',
  'mailer-daemon',
  'postmaster',
  'system',
  'updates',
  'billing',
  'receipt',
  'invoice',
  'support',
  'help',
  'info',
  'team',
  'hello',
];

export const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'protonmail.com',
  'mail.com',
  'live.com',
  'msn.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'optonline.net',
  'me.com',
  'mac.com',
  'ymail.com',
  'rocketmail.com',
  'fastmail.com',
  'zoho.com',
  'tutanota.com',
  'hey.com',
  'pm.me',
  'proton.me',
  'googlemail.com',
]);

export type DiscoveryEligibility =
  | { kind: 'outbound' }            // we sent an email TO this address
  | { kind: 'reply' }               // we replied to this sender in the thread
  | { kind: 'meeting_attendee' };   // attendee on a calendar meeting with us

export function isAutomatedEmail(email: string): { blocked: boolean; reason?: string } {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.indexOf('@');
  if (atIdx <= 0 || atIdx === lower.length - 1) {
    return { blocked: true, reason: 'malformed_email' };
  }
  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  if (isAutomatedDomain(domain)) {
    return { blocked: true, reason: `automated_domain:${domain}` };
  }

  for (const kw of AUTOMATED_LOCAL_KEYWORDS) {
    if (local === kw || local.includes(kw)) {
      return { blocked: true, reason: `automated_keyword:${kw}` };
    }
  }
  return { blocked: false };
}

function domainToCompanyName(domain: string): string {
  const base = domain.split('.')[0];
  return base
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function normalizeDomain(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

export async function findDuplicateCompany(
  name: string,
  domain: string | null,
  orgId: string,
  env: Env
): Promise<string | null> {
  // 1. Exact domain match
  if (domain) {
    const byDomain = await env.D1.prepare(
      'SELECT id FROM companies WHERE org_id = ? AND LOWER(domain) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, domain.toLowerCase()).first<{ id: string }>();
    if (byDomain) return byDomain.id;
  }

  // 2. Exact name match (case-insensitive)
  const byName = await env.D1.prepare(
    'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, name.toLowerCase()).first<{ id: string }>();
  if (byName) return byName.id;

  // 3. Contains match for common suffixes (e.g. "Helios Marketing" matches "Helios Marketing Inc")
  const baseName = name.toLowerCase().replace(/\s+(inc|llc|ltd|corp|co|company|group|holdings)\.?$/i, '').trim();
  if (baseName.length >= 3 && baseName !== name.toLowerCase()) {
    const byFuzzy = await env.D1.prepare(
      'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) LIKE ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, `%${baseName}%`).first<{ id: string }>();
    if (byFuzzy) return byFuzzy.id;
  }

  return null;
}

export async function findCompanyByDomain(
  emailDomain: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const domain = emailDomain.toLowerCase();

  // 1. Match by domain column
  const byDomain = await env.D1.prepare(
    'SELECT id FROM companies WHERE org_id = ? AND LOWER(domain) = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, domain).first<{ id: string }>();
  if (byDomain) return byDomain.id;

  // 2. Match by website containing the domain
  const byWebsite = await env.D1.prepare(
    'SELECT id FROM companies WHERE org_id = ? AND LOWER(website) LIKE ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, `%${domain}%`).first<{ id: string }>();
  if (byWebsite) return byWebsite.id;

  // 3. Match by derived company name (fuzzy)
  const derivedName = domainToCompanyName(domain).toLowerCase();
  if (derivedName.length >= 3) {
    const byName = await env.D1.prepare(
      'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) LIKE ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, `%${derivedName}%`).first<{ id: string }>();
    if (byName) return byName.id;
  }

  return null;
}

export function isAutomatedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (AUTOMATED_DOMAINS.has(d)) return true;
  for (const blocked of AUTOMATED_DOMAINS) {
    if (d.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

export async function findOrCreateCompanyByDomain(
  emailDomain: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const domainLower = emailDomain.toLowerCase();
  if (PERSONAL_DOMAINS.has(domainLower)) return null;
  if (isAutomatedDomain(domainLower)) return null;

  const existing = await findCompanyByDomain(emailDomain, orgId, env);
  if (existing) return existing;

  const companyName = domainToCompanyName(emailDomain);
  if (companyName.length < 2) return null;

  // Dedup: check for existing company with similar name before creating
  const dupCheck = await findDuplicateCompany(companyName, emailDomain.toLowerCase(), orgId, env);
  if (dupCheck) return dupCheck;

  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.D1.prepare(
    `INSERT INTO companies
       (id, org_id, name, domain, website, company_type, investment_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'other', 'tracking', ?, ?)`
  ).bind(
    companyId, orgId, companyName,
    emailDomain.toLowerCase(),
    `https://${emailDomain.toLowerCase()}`,
    now, now
  ).run();

  console.log(`[discovery] auto-created company "${companyName}" (domain: ${emailDomain}) id=${companyId}`);

  await emitAudit(env, {
    org_id: orgId,
    action: 'create',
    entity_type: 'company',
    entity_id: companyId,
    metadata: { auto_created: true, domain: emailDomain, derived_name: companyName },
    created_at: now,
  });

  return companyId;
}

export async function linkContactToCompanyByEmail(
  contactId: string,
  email: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const domain = email.toLowerCase().split('@')[1];
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;

  const companyId = await findCompanyByDomain(domain, orgId, env);
  if (!companyId) return null;

  await env.D1.prepare(
    `UPDATE contacts SET company_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND company_id IS NULL`
  ).bind(companyId, contactId).run();

  console.log(`[discovery] linked contact ${contactId} to company ${companyId} via domain ${domain}`);
  return companyId;
}

export async function discoverNewContact(
  email: string,
  sourceItem: ClassifiableItem,
  orgId: string,
  env: Env,
  eligibility: DiscoveryEligibility | null
): Promise<{ id: string; created: boolean } | null> {
  if (!eligibility) {
    console.log(`[discovery] skip ${email}: not eligible (no outbound/reply/meeting signal)`);
    return null;
  }

  const spam = isAutomatedEmail(email);
  if (spam.blocked) {
    console.log(`[discovery] skip ${email}: ${spam.reason}`);
    return null;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await env.D1.prepare(
    'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, normalizedEmail).first<{ id: string }>();
  if (existing) {
    // Backfill: if existing contact has no company, try to link now
    const hasCompany = await env.D1.prepare(
      'SELECT company_id FROM contacts WHERE id = ? AND company_id IS NOT NULL'
    ).bind(existing.id).first();
    if (!hasCompany) {
      await linkContactToCompanyByEmail(existing.id, normalizedEmail, orgId, env);
    }

    return { id: existing.id, created: false };
  }

  const displayName =
    sourceItem.fromEmail?.toLowerCase() === normalizedEmail && sourceItem.fromName
      ? sourceItem.fromName
      : normalizedEmail
          .split('@')[0]
          .replace(/[._-]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

  const domain = normalizedEmail.split('@')[1];
  let companyId: string | null = null;

  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    companyId = await findCompanyByDomain(domain, orgId, env);
  }

  // Dedup by full_name + company when email-match missed
  if (companyId) {
    const nameCompanyDup = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(full_name) = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, displayName.toLowerCase(), companyId).first<{ id: string }>();
    if (nameCompanyDup) {
      return { id: nameCompanyDup.id, created: false };
    }
  }

  const contactId = crypto.randomUUID();

  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO contacts (id, org_id, full_name, email, company_id, source, source_confidence, contact_type, total_interactions)
     VALUES (?, ?, ?, ?, ?, ?, 0.6, 'individual', 0)`
  ).bind(contactId, orgId, displayName, normalizedEmail, companyId, sourceItem.source).run();

  if (!result.meta?.changes) {
    const raced = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, normalizedEmail).first<{ id: string }>();
    if (raced) {
      return { id: raced.id, created: false };
    }
    return null;
  }

  if (companyId) {
    console.log(`[discovery] created contact ${contactId} (${displayName}) auto-linked to company ${companyId}`);
  }

  await emitAudit(env, {
    org_id: orgId,
    action: 'create',
    entity_type: 'contact',
    entity_id: contactId,
    metadata: {
      discovered_from: sourceItem.source,
      email: normalizedEmail,
      eligibility: eligibility.kind,
      auto_linked_company: companyId || undefined,
    },
    created_at: new Date().toISOString(),
  });

  triggerContactEnrichment(contactId, orgId, env).catch(e =>
    console.error(`[discovery] auto-enrich failed for ${contactId}:`, e)
  );

  return { id: contactId, created: true };
}

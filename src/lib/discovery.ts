// TRD §7.3 — New contact discovery with company auto-association
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { emitAudit } from './audit';
import { isValidContactName, resolveContactName } from './name-quality';
import { jaroWinkler } from './dedup';
import { updateEntityInIndex } from './entity-index';
import { safelyMaintainContactReadModels } from './contact-maintenance';

// Domains whose mail is always automated/transactional — never discover as contacts.
// Includes platform-noreply senders (slack.com, github.com), SaaS billing/notice
// hosts (godaddy, stripe, notion), and well-known calendar/meeting bridges.
export const AUTOMATED_DOMAINS = new Set<string>([
  // Communication / collaboration platforms
  'slack.com',
  'slackmail.com',
  'notifications.slack.com',
  'fireflies.ai',
  'fathom.video',
  'otter.ai',
  'zoom.us',
  'us02web.zoom.us',
  'us04web.zoom.us',
  'webex.com',
  'gotomeeting.com',
  'calendly.com',
  'savvycal.com',
  'cal.com',

  // Big platforms whose @-domain mail is always automated
  'anthropic.com',
  'google.com',
  'accounts.google.com',
  'mail.google.com',
  'docs.google.com',
  'microsoft.com',
  'outlook.com',
  'office.com',
  'office365.com',
  'microsoftonline.com',
  'github.com',
  'noreply.github.com',
  'gitlab.com',
  'bitbucket.org',

  // SaaS billing / accounts
  'godaddy.com',
  'namecheap.com',
  'stripe.com',
  'paypal.com',
  'square.com',
  'quickbooks.com',
  'intuit.com',
  'docusign.net',
  'docusign.com',
  'hellosign.com',
  'pandadoc.com',

  // Productivity SaaS
  'notion.so',
  'notion.com',
  'linear.app',
  'figma.com',
  'vercel.com',
  'cloudflare.com',
  'amazonaws.com',
  'aws.amazon.com',
  'amazon.com',
  'asana.com',
  'monday.com',
  'trello.com',
  'atlassian.com',
  'jira.com',
  'confluence.com',
  'mailchimp.com',
  'sendgrid.net',
  'mandrillapp.com',
  'amazonses.com',
  'postmarkapp.com',
  'mailgun.com',
  'mailgun.net',
  'klaviyo.com',
  'hubspot.com',
  'salesforce.com',
  'pipedrive.com',
  'intercom.io',
  'zendesk.com',
  'freshdesk.com',

  // Job boards / recruiting noise
  'linkedin.com',
  'indeed.com',
  'ziprecruiter.com',
  'glassdoor.com',
  'monster.com',
  'wellfound.com',
  'angel.co',

  // News / digest senders
  'substack.com',
  'medium.com',
  'beehiiv.com',
  'morningbrew.com',
  'theinformation.com',
]);

// Local-part patterns that indicate an automated/shared mailbox. Anchored to
// the start of the email so "donotreply@marriott.com" is caught but
// "tom-team@x.com" isn't accidentally blocked.
export const AUTOMATED_LOCAL_PATTERNS: RegExp[] = [
  /^noreply@/i,
  /^no-reply@/i,
  /^no_reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^do_not_reply@/i,
  /^notifications?@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^bounce[sd]?@/i,
  /^automated@/i,
  /^system@/i,
  /^alerts?@/i,
  /^digest@/i,
  /^newsletter@/i,
  /^marketing@/i,
  /^news@/i,
  /^updates?@/i,
  /^feedback@/i,
  /^hello@/i,
  /^team@/i,
  /^support@/i,
  /^help@/i,
  /^info@/i,
  /^admin@/i,
  /^billing@/i,
  /^sales@/i,
  /^contact@/i,
  /^service@/i,
  /^webmaster@/i,
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
  const domain = lower.slice(atIdx + 1);

  if (isAutomatedDomain(domain)) {
    return { blocked: true, reason: `automated_domain:${domain}` };
  }

  for (const re of AUTOMATED_LOCAL_PATTERNS) {
    if (re.test(lower)) {
      return { blocked: true, reason: `automated_pattern:${re.source}` };
    }
  }
  return { blocked: false };
}

// Common subdomains that should be stripped before deriving a company name.
// e.g. "mail.helios.com" → "helios", "email.bain.com" → "bain".
const SUBDOMAIN_STRIP = new Set([
  'mail', 'email', 'em', 'send', 'sender', 'sendmail', 'smtp',
  'news', 'newsletter', 'newsletters', 'updates', 'notify', 'notifications',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'reply', 'bounce', 'bounces',
  'invite', 'invites', 'invitation', 'invitations', 'rsvp',
  'support', 'help', 'helpdesk', 'service', 'services', 'info',
  'auto', 'autoreply', 'autoresponse', 'system', 'sys', 'admin',
  'marketing', 'mkt', 'campaigns', 'campaign', 'promo',
  'transactional', 'tx', 'tr', 'noreply2', 'd', 'r',
  'www', 'web', 'app', 'apps', 'api', 'cdn',
  'amazonses', 'mailgun', 'sendgrid',
]);

// Multi-label suffixes that should be treated as a single TLD.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'com.br', 'net.br', 'org.br',
  'co.in', 'org.in', 'net.in',
  'com.mx', 'com.sg', 'com.hk', 'com.tw',
  'co.za', 'org.za',
]);

// Extract the registrable domain ("helios.com" from "mail.helios.com",
// "bain.co.uk" from "news.bain.co.uk"). Falls back to the input on weird shapes.
export function registrableDomain(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(l => l.length > 0);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }

  return labels.slice(-2).join('.');
}

function domainToCompanyName(domain: string): string {
  const reg = registrableDomain(domain);
  // Walk the labels of the registrable form, then drop generic subdomains
  // before falling back on the leftmost non-stripped label.
  const labels = reg.split('.');
  const candidates = labels.slice(0, labels.length - 1).filter(l => !SUBDOMAIN_STRIP.has(l));
  const base = candidates[0] || labels[0];

  return base
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map(w => w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function normalizeDomain(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function domainStem(domain: string): string {
  const reg = registrableDomain(domain);
  return reg.split('.')[0].replace(/[-_]/g, '').toLowerCase();
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

  // 4. Fuzzy domain-prefix match (catches acme-corp.com vs acmecorp.com)
  const incomingStem = domainStem(domain);
  if (incomingStem.length >= 4) {
    const candidates = await env.D1.prepare(
      'SELECT id, domain FROM companies WHERE org_id = ? AND domain IS NOT NULL AND deleted_at IS NULL'
    ).bind(orgId).all<{ id: string; domain: string }>();
    for (const c of candidates.results) {
      const existingStem = domainStem(c.domain);
      if (existingStem.length >= 4 && jaroWinkler(incomingStem, existingStem) >= 0.92) {
        return c.id;
      }
    }
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

  // Always store/lookup by the registrable domain so subdomains
  // (mail.foo.com, news.foo.com) collapse onto a single company.
  const regDomain = registrableDomain(domainLower);
  if (PERSONAL_DOMAINS.has(regDomain)) return null;
  if (isAutomatedDomain(regDomain)) return null;

  const existing = await findCompanyByDomain(regDomain, orgId, env);
  if (existing) return existing;

  if (regDomain.length < 2) return null;

  // Use the domain as the placeholder name. Real human-readable name resolution
  // is the enrichment pipeline's job — don't fabricate one from the URL stem.
  const placeholderName = regDomain;

  const dupCheck = await findDuplicateCompany(placeholderName, regDomain, orgId, env);
  if (dupCheck) return dupCheck;

  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await env.D1.prepare(
      `INSERT INTO companies
         (id, org_id, name, domain, website, company_type, investment_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'other', 'tracking', ?, ?)`
    ).bind(
      companyId, orgId, placeholderName,
      regDomain,
      `https://${regDomain}`,
      now, now
    ).run();
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE constraint failed')) {
      const raced = await env.D1.prepare(
        'SELECT id FROM companies WHERE org_id = ? AND LOWER(domain) = ? AND deleted_at IS NULL LIMIT 1'
      ).bind(orgId, regDomain).first<{ id: string }>();
      if (raced) return raced.id;
    }
    throw e;
  }

  console.log(`[discovery] auto-created company "${placeholderName}" (domain: ${emailDomain}) id=${companyId}`);

  await emitAudit(env, {
    org_id: orgId,
    action: 'create',
    entity_type: 'company',
    entity_id: companyId,
    metadata: { auto_created: true, domain: regDomain, placeholder_name: placeholderName },
    created_at: now,
  });

  try { await updateEntityInIndex(orgId, 'company', companyId, env); } catch {}

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

  const result = await env.D1.prepare(
    `UPDATE contacts SET company_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND company_id IS NULL`
  ).bind(companyId, contactId).run();

  if (result.meta?.changes) {
    await safelyMaintainContactReadModels(env, orgId, contactId, 'contact_company_linked');
  }

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

  // Resolve a real display name from fromName / recipientNames.
  // If we cannot find a valid one, do NOT create the contact — we will revisit
  // it when a future message in the thread brings a usable name.
  const resolvedName = resolveContactName(
    normalizedEmail,
    sourceItem.fromEmail,
    sourceItem.fromName,
    sourceItem.recipientNames
  );

  if (!resolvedName) {
    console.log(
      `[discovery] skip ${normalizedEmail}: no valid display name (fromName=${sourceItem.fromName || 'null'}, recipientNames keys=${
        sourceItem.recipientNames ? Object.keys(sourceItem.recipientNames).length : 0
      })`
    );
    return null;
  }

  const displayName = resolvedName;

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
    user_id: sourceItem.userId || undefined,
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

  try { await updateEntityInIndex(orgId, 'contact', contactId, env); } catch {}
  await safelyMaintainContactReadModels(env, orgId, contactId, 'contact_discovered');

  return { id: contactId, created: true };
}

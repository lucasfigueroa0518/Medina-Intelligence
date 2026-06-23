// TRD §7.3 — New contact discovery with company auto-association
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { emitAudit } from './audit';
import { resolveContactName } from './name-quality';
import { crmQualityCustomFieldsForGate, evaluateCrmQualityGate } from './crm-quality-gate';
import {
  crmNameResolutionCustomFields,
  resolveCrmEntityNameWithEvidence,
  type CrmNameEvidenceCandidate,
} from './crm-name-resolver';
import { reconcileMatchedEntityName } from './crm-name-promotion';
import { jaroWinkler } from './dedup';
import { updateEntityInIndex } from './entity-index';
import { safelyMaintainContactReadModels } from './contact-maintenance';
import { getConfiguredInternalDomains, internalEmailVariants } from './internal-domains';

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

function serviceBridgePersonDisplay(value: string | null | undefined): string {
  const stripped = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:via|from)\s+(?:read\s*ai|qualified|calendly|zoom|fireflies|otter|luma|lu\.ma)\b.*$/i, '')
    .trim();
  if (!stripped || stripped === String(value || '').trim()) return '';
  const tokens = stripped.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]*/g) || [];
  const substantive = tokens.filter(token => token.replace(/\./g, '').length >= 2);
  if (substantive.length < 2) return '';
  if (/\b(service|support|desk|office|team|calendar|noreply|no-reply|info|sales|marketing|confirmation)\b/i.test(stripped)) return '';
  return stripped;
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

function normalizeCompanyIdentityName(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|group|holdings)\b\.?/g, ' ')
    .replace(/&/g, 'and')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(ai|lab|labs|system|systems|technology|technologies|tech)\b$/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function companyIdentityAliases(name: string | null | undefined, domain?: string | null, website?: string | null): Set<string> {
  const aliases = new Set<string>();
  const normalized = normalizeCompanyIdentityName(name);
  if (normalized.length >= 3) aliases.add(normalized);
  const domainValue = domain || (website ? normalizeDomain(website) : null);
  if (domainValue) {
    const stem = domainStem(domainValue);
    if (stem.length >= 3) aliases.add(normalizeCompanyIdentityName(stem));
    for (const prefix of ['get', 'try', 'use', 'join', 'hello', 'go', 'ask']) {
      if (stem.startsWith(prefix) && stem.length - prefix.length >= 4) {
        aliases.add(normalizeCompanyIdentityName(stem.slice(prefix.length)));
      }
    }
  }
  return aliases;
}

function companyAliasSetsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

export async function findDuplicateCompany(
  name: string,
  domain: string | null,
  orgId: string,
  env: Env
): Promise<string | null> {
  const normalizedDomain = domain ? registrableDomain(domain.toLowerCase().replace(/^www\./, '')) : null;
  const incomingAliases = companyIdentityAliases(name, normalizedDomain);

  // 1. Exact domain match
  if (normalizedDomain) {
    const byDomain = await env.D1.prepare(
      `SELECT id FROM companies
        WHERE org_id = ? AND deleted_at IS NULL
          AND (LOWER(domain) = ? OR LOWER(website) LIKE ?)
        LIMIT 1`
    ).bind(orgId, normalizedDomain, `%${normalizedDomain}%`).first<{ id: string }>();
    if (byDomain) return byDomain.id;
  }

  const candidates = await env.D1.prepare(
    `SELECT id, name, domain, website
       FROM companies
      WHERE org_id = ? AND deleted_at IS NULL
      LIMIT 5000`
  ).bind(orgId).all<{ id: string; name: string; domain: string | null; website: string | null }>();

  let best: { id: string; score: number } | null = null;
  let second: { id: string; score: number } | null = null;
  for (const candidate of candidates.results || []) {
    const candidateAliases = companyIdentityAliases(candidate.name, candidate.domain, candidate.website);
    let score = 0;
    if (companyAliasSetsIntersect(incomingAliases, candidateAliases)) score = normalizedDomain || candidate.domain || candidate.website ? 0.95 : 0.92;
    const incomingBest = Array.from(incomingAliases).sort((a, b) => b.length - a.length)[0] || '';
    const candidateBest = Array.from(candidateAliases).sort((a, b) => b.length - a.length)[0] || '';
    if (incomingBest && candidateBest) {
      const jw = jaroWinkler(incomingBest, candidateBest);
      if (jw >= 0.94) score = Math.max(score, 0.9);
      const minLen = Math.min(incomingBest.length, candidateBest.length);
      if (minLen >= 6 && (incomingBest.includes(candidateBest) || candidateBest.includes(incomingBest))) score = Math.max(score, 0.88);
    }
    if (score < 0.86) continue;
    if (!best || score > best.score) {
      second = best;
      best = { id: candidate.id, score };
    } else if (!second || score > second.score) {
      second = { id: candidate.id, score };
    }
  }
  if (best && (best.score >= 0.95 || !second || best.score - second.score >= 0.05)) return best.id;

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
  env: Env,
  runtimeEvidenceCandidates: CrmNameEvidenceCandidate[] | null = null
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
  if (existing) {
    await reconcileMatchedEntityName({
      entityType: 'company',
      entityId: existing,
      orgId,
      rawName: regDomain,
      domain: regDomain,
      website: `https://${regDomain}`,
      trigger: 'find_or_create_company_by_domain_existing_match',
      runtimeEvidenceCandidates,
      source: {
        source_channel: 'email_domain',
        source_text: emailDomain,
        codepath: 'find_or_create_company_by_domain_existing_match',
        evidence_level: 'unknown',
      },
    }, env).catch(e => console.error(`[discovery] company name reconciliation failed for ${existing}:`, e));
    return existing;
  }

  if (regDomain.length < 2) return null;

  // Use the domain as the placeholder name. Real human-readable name resolution
  // is the enrichment pipeline's job; the quality gate records this as a
  // placeholder-only decision and blocks service/public-suffix-like domains.
  const companySource = {
    source_channel: 'email_domain',
    source_text: emailDomain,
    codepath: 'find_or_create_company_by_domain',
  };
  const { resolution: companyResolution } = await resolveCrmEntityNameWithEvidence({
    entityType: 'company',
    rawName: regDomain,
    domain: regDomain,
    allowDomainPlaceholder: true,
    relationshipEvidence: true,
    orgId,
    trigger: 'find_or_create_company_by_domain',
    runtimeEvidenceCandidates,
    source: companySource,
  }, env);
  if (!companyResolution.normalizedName || companyResolution.status === 'no_entity' || companyResolution.status === 'fail') {
    console.log(`[discovery] skip company auto-create for ${emailDomain}: ${companyResolution.reasons.join('; ')}`);
    return null;
  }
  const companyGate = evaluateCrmQualityGate({
    entityType: 'company',
    action: 'create',
    proposedName: companyResolution.normalizedName,
    domain: regDomain,
    allowDomainPlaceholder: companyResolution.status === 'domain_placeholder',
    nameStatus: companyResolution.nameStatus,
    source: companySource,
  });
  if (!companyGate.writeAllowed || !companyGate.normalizedName) {
    console.log(`[discovery] skip company auto-create for ${emailDomain}: ${companyGate.reasons.join('; ')}`);
    return null;
  }
  const placeholderName = companyGate.normalizedName;

  const dupCheck = await findDuplicateCompany(placeholderName, regDomain, orgId, env);
  if (dupCheck) return dupCheck;

  const companyId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await env.D1.prepare(
      `INSERT INTO companies
         (id, org_id, name, domain, website, company_type, investment_status, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'other', 'tracking', ?, ?, ?)`
    ).bind(
      companyId, orgId, placeholderName,
      regDomain,
      `https://${regDomain}`,
      crmNameResolutionCustomFields(companyResolution, crmQualityCustomFieldsForGate(companyGate)),
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

  const normalizedEmail = email.toLowerCase().trim();
  const incomingDisplayName = sourceItem.fromName || sourceItem.recipientNames?.[normalizedEmail] || normalizedEmail;
  const spam = isAutomatedEmail(email);
  const serviceBridgeDisplay = serviceBridgePersonDisplay(incomingDisplayName);
  if (spam.blocked && !serviceBridgeDisplay) {
    console.log(`[discovery] skip ${email}: ${spam.reason}`);
    return null;
  }

  const emailVariants = internalEmailVariants(normalizedEmail, getConfiguredInternalDomains(env));
  const runtimeEvidenceCandidates = Array.isArray((sourceItem as any).crmNameEvidenceCandidates)
    ? (sourceItem as any).crmNameEvidenceCandidates as CrmNameEvidenceCandidate[]
    : null;
  const existing = await env.D1.prepare(
    `SELECT id FROM contacts
      WHERE org_id = ? AND LOWER(email) IN (${emailVariants.map(() => '?').join(',')})
        AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, ...emailVariants).first<{ id: string }>();
  if (existing) {
    // Backfill: if existing contact has no company, try to link now
    const hasCompany = await env.D1.prepare(
      'SELECT company_id FROM contacts WHERE id = ? AND company_id IS NOT NULL'
    ).bind(existing.id).first();
    if (!hasCompany) {
      await linkContactToCompanyByEmail(existing.id, normalizedEmail, orgId, env);
    }

    await reconcileMatchedEntityName({
      entityType: 'contact',
      entityId: existing.id,
      orgId,
      rawName: incomingDisplayName,
      email: normalizedEmail,
      trigger: 'discover_new_contact_existing_match',
      runtimeEvidenceCandidates,
      channelSource: 'display_name',
      channelContext: { userId: sourceItem.userId || null, conversationId: sourceItem.externalId || null },
      source: {
        source_channel: sourceItem.source,
        source_record_id: sourceItem.externalId,
        source_text: incomingDisplayName,
        codepath: 'discover_new_contact_existing_match',
        evidence_level: 'corroborated',
      },
    }, env).catch(e => console.error(`[discovery] contact name reconciliation failed for ${existing.id}:`, e));

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

  const contactSource = {
    source_channel: sourceItem.source,
    source_record_id: sourceItem.externalId,
    source_text: sourceItem.fromName || sourceItem.recipientNames?.[normalizedEmail] || resolvedName,
    codepath: 'discover_new_contact',
    evidence_level: 'weak_single_source' as const,
  };
  const { resolution: contactResolution } = await resolveCrmEntityNameWithEvidence({
    entityType: 'contact',
    rawName: contactSource.source_text,
    email: normalizedEmail,
    relationshipEvidence: true,
    orgId,
    trigger: 'discover_new_contact',
    runtimeEvidenceCandidates,
    source: contactSource,
  }, env);
  if (!contactResolution.normalizedName || contactResolution.status === 'no_entity' || contactResolution.status === 'fail') {
    console.log(`[discovery] skip ${normalizedEmail}: ${contactResolution.reasons.join('; ')}`);
    return null;
  }
  const contactGate = evaluateCrmQualityGate({
    entityType: 'contact',
    action: 'create',
    proposedName: contactResolution.normalizedName,
    email: normalizedEmail,
    nameStatus: contactResolution.nameStatus,
    source: contactSource,
  });
  if (!contactGate.writeAllowed || !contactGate.normalizedName) {
    console.log(`[discovery] skip ${normalizedEmail}: ${contactGate.reasons.join('; ')}`);
    return null;
  }

  const displayName = contactGate.normalizedName;

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
  const customFields = crmNameResolutionCustomFields(contactResolution, crmQualityCustomFieldsForGate(contactGate));

  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO contacts (id, org_id, full_name, email, company_id, source, source_confidence, contact_type, total_interactions, custom_fields)
     VALUES (?, ?, ?, ?, ?, ?, 0.6, 'individual', 0, ?)`
  ).bind(contactId, orgId, displayName, normalizedEmail, companyId, sourceItem.source, customFields).run();

  if (!result.meta?.changes) {
    const raced = await env.D1.prepare(
      `SELECT id FROM contacts
        WHERE org_id = ? AND LOWER(email) IN (${emailVariants.map(() => '?').join(',')})
          AND deleted_at IS NULL
        LIMIT 1`
    ).bind(orgId, ...emailVariants).first<{ id: string }>();
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

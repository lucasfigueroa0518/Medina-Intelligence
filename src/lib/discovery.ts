// TRD §7.3 — New contact discovery
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import { emitAudit } from './audit';

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

const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
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

  if (AUTOMATED_DOMAINS.has(domain)) {
    return { blocked: true, reason: `automated_domain:${domain}` };
  }
  // Match subdomains of blocked roots (e.g. email.godaddy.com)
  for (const d of AUTOMATED_DOMAINS) {
    if (domain.endsWith(`.${d}`)) {
      return { blocked: true, reason: `automated_domain:${d}` };
    }
  }

  for (const kw of AUTOMATED_LOCAL_KEYWORDS) {
    if (local === kw || local.includes(kw)) {
      return { blocked: true, reason: `automated_keyword:${kw}` };
    }
  }
  return { blocked: false };
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

  // Dedup by email (unique within org).
  const existing = await env.D1.prepare(
    'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, normalizedEmail).first<{ id: string }>();
  if (existing) {
    await env.D1.prepare(
      'UPDATE contacts SET total_interactions = COALESCE(total_interactions, 0) + 1, updated_at = ? WHERE id = ?'
    ).bind(new Date().toISOString(), existing.id).run();
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
    const company = await env.D1.prepare(
      'SELECT id FROM companies WHERE org_id = ? AND website LIKE ? AND deleted_at IS NULL'
    ).bind(orgId, `%${domain}%`).first<{ id: string }>();
    if (company) companyId = company.id;
  }

  // Dedup by full_name + company when email-match missed (different address, same person).
  if (companyId) {
    const nameCompanyDup = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(full_name) = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, displayName.toLowerCase(), companyId).first<{ id: string }>();
    if (nameCompanyDup) {
      await env.D1.prepare(
        'UPDATE contacts SET total_interactions = COALESCE(total_interactions, 0) + 1, updated_at = ? WHERE id = ?'
      ).bind(new Date().toISOString(), nameCompanyDup.id).run();
      return { id: nameCompanyDup.id, created: false };
    }
  }

  const contactId = crypto.randomUUID();

  // INSERT OR IGNORE relies on the UNIQUE(org_id, email) partial index added in migration 0031.
  // It is a no-op when the index is absent, so we re-check by SELECT below to handle races.
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO contacts (id, org_id, full_name, email, company_id, source, source_confidence, contact_type, total_interactions)
     VALUES (?, ?, ?, ?, ?, ?, 0.6, 'individual', 1)`
  ).bind(contactId, orgId, displayName, normalizedEmail, companyId, sourceItem.source).run();

  if (!result.meta?.changes) {
    const raced = await env.D1.prepare(
      'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, normalizedEmail).first<{ id: string }>();
    if (raced) {
      await env.D1.prepare(
        'UPDATE contacts SET total_interactions = COALESCE(total_interactions, 0) + 1, updated_at = ? WHERE id = ?'
      ).bind(new Date().toISOString(), raced.id).run();
      return { id: raced.id, created: false };
    }
    return null;
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
    },
    created_at: new Date().toISOString(),
  });

  return { id: contactId, created: true };
}

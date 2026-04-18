// LinkedIn URL discovery — multi-strategy search before ReverseContact.
//
// Strategies tried IN ORDER (stops at first URL found):
//   1. "{full_name} {company_name} LinkedIn"
//   2. "{full_name} {email_domain} LinkedIn"
//   3. "{full_name} {derived_company_name} site:linkedin.com/in"
//   4. "{full_name} {job_title} LinkedIn" (if title known)
//
// When Claude says "not confident" but still surfaces a URL, we EXTRACT IT
// anyway and let ReverseContact's identity scoring verify the match. The
// discovery step is about recall; ReverseContact is about precision.

import type { Env } from '../types/env';
import { callClaude } from './claude';
import {
  checkClaudeRateLimit,
  checkEnrichmentRateLimit,
  recordEnrichmentRateLimit,
} from './rate-limit';
import { hashShort } from './helpers';
import { emitAudit } from './audit';

// ── Types ────────────────────────────────────────────────────────────

export type LinkedInDiscoveryStatus =
  | 'found'
  | 'multiple'
  | 'not_found'
  | 'skipped';

export interface LinkedInDiscoveryResult {
  status: LinkedInDiscoveryStatus;
  linkedin_url?: string;
  candidates?: string[];
  confidence?: number;
  reason?: string;
}

export interface DiscoveryContactInput {
  id: string;
  full_name: string;
  email?: string | null;
  linkedin_url?: string | null;
  company_id?: string | null;
  job_title?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'aol.com', 'protonmail.com', 'proton.me',
  'me.com', 'mac.com', 'live.com', 'msn.com',
]);

function extractBusinessDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/**
 * Derive a human-friendly company name from a bare domain.
 * "heliosmarketing.org" → "Helios Marketing"
 * "acme-corp.com"       → "Acme Corp"
 * "bigdataio.ai"        → "Bigdataio"
 */
function deriveCompanyFromDomain(domain: string): string {
  // Strip TLD (everything after last dot)
  const base = domain.replace(/\.[^.]+$/, '');
  // Split on hyphens, dots, underscores
  let parts = base.split(/[-._]+/);
  // Try camelCase split if we got a single-word slug
  if (parts.length === 1 && parts[0].length > 6) {
    parts = parts[0]
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')
      .split(/\s+/);
  }
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

function normalizeLinkedInUrl(raw: string): string | null {
  if (!raw) return null;
  const match = raw.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%.]+?)(?:[\/?#]|$)/i);
  if (!match) return null;
  const slug = match[1].replace(/\/+$/, '');
  if (slug.length === 0 || slug.length > 120) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const n = normalizeLinkedInUrl(u);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** Extract ALL linkedin.com/in/ URLs from any text Claude returned. */
function extractLinkedInUrls(text: string): string[] {
  const matches = text.match(
    /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%.]+\/?/gi
  );
  return matches ? dedupeUrls(matches) : [];
}

async function stageDiscoveryForReview(
  contactId: string,
  candidates: string[],
  orgId: string,
  contactName: string,
  env: Env
): Promise<void> {
  const key = `${orgId}:${contactId}:linkedin_discovery:${hashShort(candidates.join('|'))}`;
  await env.D1.prepare(
    `INSERT OR IGNORE INTO approval_queue
       (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
        proposed_value, source_visibility, confidence, status)
     VALUES (?, ?, 'contact', ?, 'linkedin_discovery', 'linkedin_url', ?, 'org_wide', 0.5, 'pending')`
  ).bind(key, orgId, contactId, JSON.stringify({ candidates, contact_name: contactName })).run();
}

// ── Multi-strategy search ────────────────────────────────────────────

interface SearchStrategy {
  label: string;
  query: string;
}

function buildSearchStrategies(
  name: string,
  companyName: string | null,
  domain: string | null,
  derivedCompany: string | null,
  jobTitle: string | null,
): SearchStrategy[] {
  const strategies: SearchStrategy[] = [];

  if (companyName) {
    strategies.push({
      label: 'name+company',
      query: `${name} ${companyName} LinkedIn`,
    });
  }

  if (domain) {
    strategies.push({
      label: 'name+domain',
      query: `${name} ${domain} LinkedIn`,
    });
  }

  if (derivedCompany && derivedCompany !== companyName) {
    strategies.push({
      label: 'name+derived',
      query: `${name} "${derivedCompany}" site:linkedin.com/in`,
    });
  }

  if (jobTitle) {
    const anchor = companyName || derivedCompany || domain || '';
    strategies.push({
      label: 'name+title',
      query: `${name} ${jobTitle} ${anchor} LinkedIn`,
    });
  }

  // Broad fallback — just the name
  if (strategies.length === 0) {
    strategies.push({ label: 'name-only', query: `${name} LinkedIn` });
  }

  return strategies;
}

// ── Main entry point ─────────────────────────────────────────────────

export async function discoverLinkedInUrl(
  contact: DiscoveryContactInput,
  orgId: string,
  env: Env
): Promise<LinkedInDiscoveryResult> {
  if (contact.linkedin_url?.trim()) {
    return { status: 'skipped', reason: 'already_has_url' };
  }
  if (!contact.full_name || contact.full_name.trim().length < 3) {
    return { status: 'skipped', reason: 'no_name' };
  }

  // Resolve anchors
  let companyName: string | null = null;
  if (contact.company_id) {
    const row = await env.D1
      .prepare('SELECT name FROM companies WHERE id = ? AND deleted_at IS NULL')
      .bind(contact.company_id)
      .first<{ name: string | null }>();
    companyName = row?.name || null;
  }

  const emailDomain = extractBusinessDomain(contact.email);
  const derivedCompany = emailDomain ? deriveCompanyFromDomain(emailDomain) : null;

  // Identity anchoring: need at least ONE anchor beyond just the name
  if (!companyName && !emailDomain) {
    return { status: 'skipped', reason: 'insufficient_context' };
  }

  // Rate limits
  if (!(await checkClaudeRateLimit(env, orgId, 'low'))) {
    return { status: 'skipped', reason: 'claude_rate_limited' };
  }
  if (!(await checkEnrichmentRateLimit('claude_enrichment', orgId, env))) {
    return { status: 'skipped', reason: 'enrichment_backoff' };
  }

  const strategies = buildSearchStrategies(
    contact.full_name,
    companyName,
    emailDomain,
    derivedCompany,
    contact.job_title || null,
  );

  console.log(
    `[linkedin-discovery] ${contact.id}: trying ${strategies.length} strategies for "${contact.full_name}" (company=${companyName || 'none'} domain=${emailDomain || 'none'} derived=${derivedCompany || 'none'})`
  );

  // Try each strategy; stop at first URL found
  for (const strategy of strategies) {
    // Check rate limit before each call — we may exhaust RPM partway through
    if (!(await checkClaudeRateLimit(env, orgId, 'low'))) {
      console.log(`[linkedin-discovery] ${contact.id}: rate limited after strategy "${strategy.label}"`);
      break;
    }

    const prompt = `Search for: ${strategy.query}

Find the LinkedIn profile URL (linkedin.com/in/...) for this person. Even if you are not 100% certain, return the best-match URL — we have a separate verification system that will confirm the identity.

If you find a URL, return it on its own line prefixed with URL:
If you find multiple possible matches, return each on its own line prefixed with URL:
If you truly find nothing, return NONE.

Example response:
URL: https://www.linkedin.com/in/johndoe`;

    let response: string;
    try {
      response = await callClaude(
        {
          system: 'You are a LinkedIn profile finder. Search and return profile URLs. Be thorough — try multiple search approaches before giving up.',
          user: prompt,
          max_tokens: 300,
          orgId,
        },
        'low',
        env
      );
    } catch (e: any) {
      if (String(e?.message).includes('CLAUDE_RATE_LIMITED')) {
        await recordEnrichmentRateLimit('claude_enrichment', orgId, env);
        return { status: 'skipped', reason: 'claude_rate_limited' };
      }
      console.error(`[linkedin-discovery] ${contact.id}: Claude error on strategy "${strategy.label}":`, e);
      continue;
    }

    console.log(
      `[linkedin-discovery] ${contact.id}: strategy "${strategy.label}" response (${response.length} chars): ${response.slice(0, 200).replace(/\n/g, ' ')}`
    );

    // Extract ANY linkedin.com/in/ URL from the response — regardless of
    // whether Claude said "confident" or wrapped it in caveats.
    const urls = extractLinkedInUrls(response);

    if (urls.length === 1) {
      const url = urls[0];
      console.log(`[linkedin-discovery] ${contact.id}: FOUND via "${strategy.label}" → ${url}`);

      await env.D1
        .prepare(
          `UPDATE contacts SET linkedin_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        )
        .bind(url, contact.id)
        .run();

      await emitAudit(env, {
        org_id: orgId,
        action: 'update',
        entity_type: 'contact',
        entity_id: contact.id,
        metadata: { field: 'linkedin_url', value: url, source: 'claude_linkedin_discovery', strategy: strategy.label },
        created_at: new Date().toISOString(),
      });

      return { status: 'found', linkedin_url: url, confidence: 0.8 };
    }

    if (urls.length > 1) {
      console.log(`[linkedin-discovery] ${contact.id}: ${urls.length} candidates via "${strategy.label}" → staging for review`);
      await stageDiscoveryForReview(contact.id, urls, orgId, contact.full_name, env);
      return { status: 'multiple', candidates: urls };
    }

    // No URLs in this response — try next strategy
    console.log(`[linkedin-discovery] ${contact.id}: strategy "${strategy.label}" returned no URLs — trying next`);
  }

  console.log(`[linkedin-discovery] ${contact.id}: all ${strategies.length} strategies exhausted — not found`);
  return { status: 'not_found' };
}

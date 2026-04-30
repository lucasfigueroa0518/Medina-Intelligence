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
import { callGemini } from './gemini';
import {
  checkGeminiRateLimit,
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

/** Extract ALL linkedin.com/in/ URLs from any text returned by the LLM. */
function extractLinkedInUrls(text: string): string[] {
  const matches = text.match(
    /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%.]+\/?/gi
  );
  return matches ? dedupeUrls(matches) : [];
}

/**
 * Detect whether a LinkedIn URL was likely fabricated by an LLM.
 *
 * Real LinkedIn URLs have an alphanumeric disambiguation suffix assigned by
 * LinkedIn: linkedin.com/in/john-smith-a1b2c3d4 or linkedin.com/in/jsmith-1234567
 *
 * Fabricated URLs are just the person's name jammed together:
 *   linkedin.com/in/thomaspozo, linkedin.com/in/lucas-figueroa-helios
 */
export function assessLinkedInUrlAuthenticity(
  url: string,
  personName?: string
): { likelyFabricated: boolean; confidence: number; reason: string } {
  const match = url.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%.]+?)(?:[\/?#]|$)/i);
  if (!match) return { likelyFabricated: true, confidence: 0, reason: 'invalid_url' };

  const slug = match[1].toLowerCase().replace(/%[0-9a-f]{2}/gi, '');

  // Has LinkedIn's alphanumeric ID suffix (e.g., -b07671239, -4b7b2b137, -a1b2c3)
  if (/[-_][a-f0-9]{6,}$/i.test(slug) || /[-_]\d{5,}$/.test(slug)) {
    return { likelyFabricated: false, confidence: 0.9, reason: 'has_linkedin_id_suffix' };
  }

  if (personName) {
    const nameParts = personName.toLowerCase().split(/\s+/).filter(p => p.length > 1);
    const nameSlug = nameParts.join('-');
    const nameCombined = nameParts.join('');
    const slugClean = slug.replace(/[-_]/g, '');

    if (slugClean === nameCombined || slug === nameSlug) {
      return { likelyFabricated: true, confidence: 0.3, reason: 'slug_is_exact_name' };
    }

    if (slug.startsWith(nameSlug + '-') || slugClean.startsWith(nameCombined)) {
      const suffix = slug.slice(nameSlug.length + 1);
      if (suffix && !/[a-f0-9]{4,}/i.test(suffix) && !/\d{3,}/.test(suffix)) {
        return { likelyFabricated: true, confidence: 0.3, reason: 'slug_is_name_plus_words' };
      }
    }
  }

  if (!/\d/.test(slug)) {
    return { likelyFabricated: false, confidence: 0.5, reason: 'no_numbers_uncertain' };
  }

  return { likelyFabricated: false, confidence: 0.7, reason: 'has_numbers' };
}

async function stageDiscoveryForReview(
  contactId: string,
  candidates: string[],
  orgId: string,
  contactName: string,
  env: Env
): Promise<void> {
  const key = `${orgId}:${contactId}:linkedin_discovery:${hashShort(candidates.join('|'))}`;
  // Wave 6 payload contract: top candidate becomes the proposed_value,
  // rest of the candidates ride in metadata.alternatives so the UI can
  // surface them as a "or maybe one of these" picker. Channel:
  // 'linkedin_data' (web-search-derived discoveries are a LinkedIn data
  // path — same channel as direct LinkedIn pulls, so they don't
  // double-corroborate against ReverseContact or each other).
  const [topCandidate, ...alternatives] = candidates;
  const proposedValue = JSON.stringify({
    value: topCandidate || '',
    metadata: {
      source_type: 'linkedin_discovery',
      source_description: `Web search discovered ${candidates.length} LinkedIn candidate${candidates.length === 1 ? '' : 's'} for ${contactName}`,
      alternatives,
      contact_name: contactName,
      context: {},
    },
  });
  await env.D1.prepare(
    `INSERT OR IGNORE INTO approval_queue
       (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
        proposed_value, source_visibility, confidence, status)
     VALUES (?, ?, 'contact', ?, 'linkedin_discovery', 'linkedin_url', ?, 'org_wide', 0.5, 'pending')`
  ).bind(key, orgId, contactId, proposedValue).run();
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
  if (!(await checkGeminiRateLimit(env, orgId, 'low'))) {
    return { status: 'skipped', reason: 'gemini_rate_limited' };
  }
  if (!(await checkEnrichmentRateLimit('gemini_linkedin', orgId, env))) {
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
    if (!(await checkGeminiRateLimit(env, orgId, 'low'))) {
      console.log(`[linkedin-discovery] ${contact.id}: rate limited after strategy "${strategy.label}"`);
      break;
    }

    const prompt = `Search for: ${strategy.query}

Find the LinkedIn profile URL (linkedin.com/in/...) for this person.

CRITICAL RULES:
- Return ONLY LinkedIn URLs you actually found in real search results.
- DO NOT construct or guess URLs by combining the person's name (e.g., do NOT return linkedin.com/in/firstname-lastname just because the person's name is "Firstname Lastname").
- A real LinkedIn URL has an alphanumeric suffix assigned by LinkedIn, like: linkedin.com/in/john-smith-a1b2c3d4 or linkedin.com/in/jdoe-1234567. If the URL you found is just the person's name without such a suffix, you likely fabricated it.
- If you cannot find a real LinkedIn profile URL in search results, return NONE. Returning a fabricated URL is worse than returning NONE.

If you find a URL, return it on its own line prefixed with URL:
If you find multiple possible matches, return each on its own line prefixed with URL:
If you truly find nothing, return NONE.

Example response:
URL: https://www.linkedin.com/in/johndoe-a1b2c3d4`;

    let response: string;
    try {
      const result = await callGemini(
        {
          system: 'You are a LinkedIn profile finder. Use Google Search to locate the correct linkedin.com/in/ URL for the person described. IMPORTANT: Only return URLs you actually found in search results. NEVER construct or guess a URL from the person\'s name — if you cannot find a real profile, say NONE.',
          user: prompt,
          max_tokens: 400,
          orgId,
        },
        'low',
        env
      );
      response = result.text;
    } catch (e: any) {
      if (String(e?.message).includes('GEMINI_RATE_LIMITED')) {
        await recordEnrichmentRateLimit('gemini_linkedin', orgId, env);
        return { status: 'skipped', reason: 'gemini_rate_limited' };
      }
      console.error(`[linkedin-discovery] ${contact.id}: Gemini error on strategy "${strategy.label}":`, e);
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
      const auth = assessLinkedInUrlAuthenticity(url, contact.full_name);

      console.log(
        `[linkedin-discovery] ${contact.id}: FOUND via "${strategy.label}" → ${url} ` +
        `(fabricated=${auth.likelyFabricated}, confidence=${auth.confidence}, reason=${auth.reason})`
      );

      if (auth.likelyFabricated) {
        console.log(
          `[linkedin-discovery] ${contact.id}: URL appears fabricated (${auth.reason}) — ` +
          `slug matches name pattern without LinkedIn ID suffix. Discarding.`
        );
        continue; // try next strategy — this one fabricated
      }

      await emitAudit(env, {
        org_id: orgId,
        action: 'update',
        entity_type: 'contact',
        entity_id: contact.id,
        metadata: { field: 'linkedin_url', value: url, source: 'gemini_linkedin_discovery', strategy: strategy.label, authenticity: auth },
        created_at: new Date().toISOString(),
      });

      return { status: 'found', linkedin_url: url, confidence: auth.confidence };
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

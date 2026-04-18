// TRD §6.4 — ReverseContact LinkedIn enrichment with identity disambiguation.
// API: POST https://api.reversecontact.com/enrichment
//   Headers: Authorization: Bearer {apiKey}
//   Body:    {"linkedin_url": "..."} or {"email": "..."}
import type { Env } from '../types/env';
import type { Contact } from '../types/interfaces';
import { recordRcFailure, resetRcFailures } from '../lib/rc-circuit-breaker';

const API_BASE = 'https://api.reversecontact.com';
const ENDPOINT = '/enrichment';

interface ReverseContactPersonProfile {
  firstName: string;
  lastName: string;
  fullName: string;
  headline: string;
  summary: string;
  location: string;
  industry: string;
  currentCompany?: string;
  currentTitle?: string;
  experiences: Array<{
    company: string;
    title: string;
    startDate?: string;
    endDate?: string | null;
    description?: string;
    location?: string;
  }>;
  education: Array<{
    school: string;
    degree?: string;
    fieldOfStudy?: string;
    startYear?: number;
    endYear?: number;
  }>;
  skills: string[];
  linkedinUrl: string;
}

export interface IdentityScore {
  score: number;
  details: string[];
  candidate?: ReverseContactPersonProfile;
}

export function scoreIdentity(
  contact: Partial<Contact>,
  candidate: ReverseContactPersonProfile
): IdentityScore {
  const details: string[] = [];
  let score = 0;

  if (contact.email) {
    const contactDomain = contact.email.split('@')[1]?.toLowerCase();
    const candidateCompany = (candidate.currentCompany || '').toLowerCase();
    if (contactDomain && candidateCompany.includes(contactDomain.split('.')[0])) {
      score += 0.4;
      details.push('email_domain_match (+0.4)');
    }
  }

  if (contact.full_name) {
    const [cFirst, ...cRest] = contact.full_name.toLowerCase().split(' ');
    const nameOverlap =
      (candidate.firstName || '').toLowerCase() === cFirst ||
      (candidate.lastName || '').toLowerCase() === cRest.join(' ').trim();
    if (nameOverlap) {
      score += 0.3;
      details.push('name_match (+0.3)');
    }
  }

  if (contact.job_title && candidate.currentTitle) {
    const titleOverlap = contact.job_title
      .toLowerCase()
      .split(/\s+/)
      .some(w => candidate.currentTitle!.toLowerCase().includes(w));
    if (titleOverlap) {
      score += 0.2;
      details.push('title_match (+0.2)');
    }
  }

  return { score, details, candidate };
}

export async function enrichContactFromLinkedIn(
  contact: Partial<Contact>,
  orgId: string,
  env: Env
): Promise<{ text: string; score: number } | null> {
  if (!contact.email && !contact.linkedin_url) {
    console.warn(`[reversecontact] skip ${contact.id}: insufficient data`);
    return null;
  }

  const apiKey = env.REVERSECONTACT_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error('[reversecontact] REVERSECONTACT_API_KEY secret is empty — skipping');
    return null;
  }

  const trimmedKey = apiKey.trim();
  const keyPrefix = trimmedKey.slice(0, 8);

  // ReverseContact API is GET with query params — NOT POST with JSON body.
  // POST /enrichment returns 404 "Endpoint not found".
  // GET /enrichment?linkedin_url=... or ?email=... with Authorization: Bearer header.
  const lookupParam = contact.linkedin_url
    ? `linkedin_url=${encodeURIComponent(contact.linkedin_url)}`
    : `email=${encodeURIComponent(contact.email!)}`;
  const url = `${API_BASE}${ENDPOINT}?${lookupParam}`;

  console.log(
    `[reversecontact] ${contact.id}: GET ${ENDPOINT}?${contact.linkedin_url ? 'linkedin_url' : 'email'}=... key=${keyPrefix}…`
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${trimmedKey}`,
    Accept: 'application/json',
  };

  const resp = await fetch(url, { method: 'GET', headers });

  if (!resp.ok) {
    const respBody = await resp.text().catch(() => '(unreadable)');
    console.error(
      `[reversecontact] ${contact.id}: HTTP ${resp.status} ${resp.statusText}\n` +
        `  url=${ENDPOINT}?${contact.linkedin_url ? 'linkedin_url' : 'email'}=…\n` +
        `  key=${keyPrefix}…(${trimmedKey.length} chars)\n` +
        `  response: ${respBody.slice(0, 800)}`
    );

    if (resp.status === 429) throw new Error('REVERSECONTACT_RATE_LIMITED: 429');
    if (resp.status === 403 && respBody.includes('TRIAL_ENDPOINT_RESTRICTED')) {
      console.error(
        `[reversecontact] TRIAL_ENDPOINT_RESTRICTED — the API key is on the free trial plan. ` +
          `Upgrade to PAYG at https://app.reversecontact.com/billing to enable live enrichment.`
      );
    }
    if (resp.status === 401) {
      let count = 0;
      try { count = await recordRcFailure(orgId, env); } catch { /* ignore */ }
      console.error(
        `[reversecontact] 401 Unauthorized — key prefix=${keyPrefix} consecutive_failures=${count}. ` +
          `Verify REVERSECONTACT_API_KEY is the correct Bearer token from https://app.reversecontact.com.`
      );
    }
    return null;
  }

  // Any non-401 success — reset the circuit breaker.
  await resetRcFailures(orgId, env);

  const data = (await resp.json()) as {
    success?: boolean;
    person?: ReverseContactPersonProfile;
  };
  if (!data.person) return null;

  const identity = scoreIdentity(contact, data.person);
  if (identity.score < 0.8) {
    if (contact.id) {
      await env.D1.prepare(
        `INSERT OR IGNORE INTO approval_queue
           (idempotency_key, org_id, entity_type, entity_id, change_type, field_name, proposed_value, confidence, status)
         VALUES (?, ?, 'contact', ?, 'update_contact', 'linkedin_profile', ?, ?, 'pending')`
      ).bind(
        `${orgId}:${contact.id}:linkedin_identity:${identity.score.toFixed(2)}`,
        orgId,
        contact.id,
        JSON.stringify(data.person),
        identity.score
      ).run();
    }
    throw new Error('LINKEDIN_IDENTITY_UNVERIFIED');
  }

  if (contact.id) {
    await env.R2.put(
      `${orgId}/enrichment/reversecontact/${contact.id}.json`,
      JSON.stringify(data)
    );
    await env.D1.prepare(
      `UPDATE contacts SET linkedin_data_r2_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(`${orgId}/enrichment/reversecontact/${contact.id}.json`, contact.id).run();
  }

  const textParts = [
    `Name: ${data.person.fullName}`,
    `Title: ${data.person.currentTitle || 'Unknown'}`,
    `Company: ${data.person.currentCompany || 'Unknown'}`,
    `Location: ${data.person.location || 'Unknown'}`,
    `Headline: ${data.person.headline || ''}`,
    `Summary: ${data.person.summary || ''}`,
    `Skills: ${(data.person.skills || []).join(', ')}`,
    `Experience: ${(data.person.experiences || [])
      .slice(0, 3)
      .map(e => `${e.title} at ${e.company}`)
      .join('; ')}`,
  ];

  return { text: textParts.join('\n'), score: identity.score };
}

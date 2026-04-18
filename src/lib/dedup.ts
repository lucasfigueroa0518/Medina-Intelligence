// TRD §7.5 — Blocking-key duplicate detection
import type { Contact } from '../types/interfaces';

export function generateBlockingKeys(contact: Partial<Contact>): string[] {
  const keys: string[] = [];

  if (contact.email) {
    const d = contact.email.split('@')[1]?.toLowerCase();
    if (d) keys.push(`domain:${d}`);
  }

  if (contact.full_name) {
    const norm = contact.full_name
      .toLowerCase()
      .replace(/\b(de la|del|van der|von|di)\b/g, '')
      .replace(/[^a-z]/g, '');
    if (norm.length >= 3) keys.push(`name:${norm.substring(0, 4)}`);
  }

  if (contact.company_id) keys.push(`company:${contact.company_id}`);

  if (contact.phone) {
    const d = contact.phone.replace(/\D/g, '');
    if (d.length >= 7) keys.push(`phone:${d.slice(-7)}`);
  }

  if (contact.linkedin_url) {
    const h = contact.linkedin_url
      .replace(/^.*linkedin\.com\/in\//i, '')
      .replace(/\/$/, '')
      .toLowerCase();
    if (h) keys.push(`linkedin:${h}`);
  }

  return keys;
}

export const SIMILARITY_WEIGHTS = {
  exact_email_match: 1.0,
  fuzzy_name_score: 0.4,
  same_domain: 0.3,
  same_phone: 0.8,
  same_company: 0.2,
};

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const m1 = a.length;
  const m2 = b.length;
  if (m1 === 0 || m2 === 0) return 0;

  const matchDistance = Math.floor(Math.max(m1, m2) / 2) - 1;
  const aMatches = new Array(m1).fill(false);
  const bMatches = new Array(m2).fill(false);

  let matches = 0;
  for (let i = 0; i < m1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, m2);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let t = 0;
  let k = 0;
  for (let i = 0; i < m1; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;

  const jaro = (matches / m1 + matches / m2 + (matches - t) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, m1, m2); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

export function scoreSimilarity(a: Partial<Contact>, b: Partial<Contact>): number {
  let score = 0;

  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) {
    score += SIMILARITY_WEIGHTS.exact_email_match;
  }

  if (a.full_name && b.full_name) {
    const jw = jaroWinkler(a.full_name.toLowerCase(), b.full_name.toLowerCase());
    score += jw * SIMILARITY_WEIGHTS.fuzzy_name_score;
  }

  if (a.email && b.email) {
    const da = a.email.split('@')[1]?.toLowerCase();
    const db = b.email.split('@')[1]?.toLowerCase();
    if (da && db && da === db) score += SIMILARITY_WEIGHTS.same_domain;
  }

  if (a.phone && b.phone) {
    const pa = a.phone.replace(/\D/g, '').slice(-7);
    const pb = b.phone.replace(/\D/g, '').slice(-7);
    if (pa && pa === pb) score += SIMILARITY_WEIGHTS.same_phone;
  }

  if (a.company_id && b.company_id && a.company_id === b.company_id) {
    score += SIMILARITY_WEIGHTS.same_company;
  }

  return Math.min(1.0, score);
}

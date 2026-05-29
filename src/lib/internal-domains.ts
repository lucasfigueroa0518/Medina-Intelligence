import type { Env } from '../types/env';

const DEFAULT_INTERNAL_DOMAINS = [
  'medinavc.com',
  'medinacapital.com',
];

function parseDomains(raw?: string | null): string[] {
  return (raw || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

export function getConfiguredInternalDomains(env?: Pick<Env, 'INTERNAL_DOMAINS'> | null): Set<string> {
  const configured = parseDomains(env?.INTERNAL_DOMAINS);
  return new Set(configured.length > 0 ? configured : DEFAULT_INTERNAL_DOMAINS);
}

export function getAllowedSignupDomains(
  env?: Pick<Env, 'INTERNAL_DOMAINS' | 'ALLOWED_SIGNUP_DOMAINS'> | null
): Set<string> {
  const internal = getConfiguredInternalDomains(env);
  const explicitSignup = parseDomains(env?.ALLOWED_SIGNUP_DOMAINS);
  return explicitSignup.length > 0
    ? new Set([...internal, ...explicitSignup])
    : internal;
}

export function emailDomain(email: string | null | undefined): string {
  const lower = (email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  return at >= 0 ? lower.slice(at + 1) : '';
}

export function emailLocalPart(email: string | null | undefined): string {
  const lower = (email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  return at >= 0 ? lower.slice(0, at) : '';
}

export function isInternalEmailDomain(
  emailOrDomain: string | null | undefined,
  domains: Set<string>
): boolean {
  const raw = (emailOrDomain || '').trim().toLowerCase();
  if (!raw) return false;
  const domain = raw.includes('@') ? emailDomain(raw) : raw;
  return domains.has(domain);
}

export function internalEmailVariants(
  email: string,
  domains: Set<string>
): string[] {
  const normalized = email.trim().toLowerCase();
  const local = emailLocalPart(normalized);
  const domain = emailDomain(normalized);
  if (!local || !domain || !domains.has(domain)) return [normalized];
  return Array.from(domains)
    .map(d => `${local}@${d}`)
    .sort();
}

export function internalEmailAliasKey(
  email: string | null | undefined,
  domains: Set<string>
): string | null {
  const local = emailLocalPart(email);
  const domain = emailDomain(email);
  if (!local || !domain) return null;
  return domains.has(domain) ? `internal:${local}` : `external:${local}@${domain}`;
}

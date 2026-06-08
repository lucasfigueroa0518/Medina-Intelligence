#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const DEFAULT_OUTPUT = 'outputs/crm-quality-review-2026-06-03.csv';
const DEFAULT_SEED = 'crm-quality-review-2026-06-03';
const SUSPECT_LIMIT = 250;
const RANDOM_LIMIT = 250;

export const CSV_COLUMNS = [
  'review_grade',
  'review_notes',
  'record_type',
  'sample_type',
  'sample_rank',
  'candidate_score',
  'candidate_reasons',
  'duplicate_group_id',
  'duplicate_group_size',
  'possible_duplicate_ids',
  'id',
  'name',
  'email',
  'domain',
  'website',
  'company_id',
  'company_name',
  'source',
  'entity_type',
  'status',
  'created_at',
  'updated_at',
  'interaction_count',
  'conversation_count',
  'event_count',
  'deal_count',
  'document_count',
  'tag_count',
  'linked_contact_count',
  'audit_origin',
  'audit_auto_created',
  'crm_url',
] as const;

export type CsvColumn = typeof CSV_COLUMNS[number];
export type RecordType = 'contact' | 'company';
export type SampleType = 'suspect' | 'random';

interface Args {
  orgId: string;
  database: string;
  output: string;
  seed: string;
  remote: boolean;
}

interface D1ExecuteResult<T = any> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

interface BaseRecord {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  merged_into?: string | null;
  conversation_count: number;
  event_count: number;
  deal_count: number;
  document_count: number;
  tag_count: number;
  audit_origin: string | null;
  audit_auto_created: string | number | boolean | null;
}

export interface ContactReviewRecord extends BaseRecord {
  record_type: 'contact';
  full_name?: string;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  domain: string | null;
  company_id: string | null;
  company_name: string | null;
  source: string | null;
  entity_type: string | null;
  status: string | null;
  interaction_count: number;
  linked_contact_count?: number;
}

export interface CompanyReviewRecord extends BaseRecord {
  record_type: 'company';
  domain: string | null;
  website: string | null;
  source: string | null;
  entity_type: string | null;
  status: string | null;
  interaction_count: number;
  linked_contact_count: number;
  email?: null;
  company_id?: null;
  company_name?: null;
}

export type ReviewSourceRecord = ContactReviewRecord | CompanyReviewRecord;

export type ReviewCsvRow = Record<CsvColumn, string>;

export interface DuplicateGroup {
  id: string;
  reason: string;
  memberIds: string[];
  score: number;
}

export interface DuplicateInfo {
  groupId: string;
  groupSize: number;
  possibleDuplicateIds: string[];
  reasons: string[];
}

export interface CandidateScore {
  score: number;
  reasons: string[];
}

interface ScoredCandidate<T extends ReviewSourceRecord> {
  record: T;
  score: number;
  reasons: string[];
  duplicateInfo: DuplicateInfo | null;
}

interface SegmentResult<T extends ReviewSourceRecord> {
  suspects: ScoredCandidate<T>[];
  randoms: ScoredCandidate<T>[];
}

export interface BuildReviewInput {
  contacts: ContactReviewRecord[];
  companies: CompanyReviewRecord[];
  seed?: string;
  suspectLimit?: number;
  randomLimit?: number;
}

const GENERIC_CONTACT_NAMES = new Set([
  'unknown',
  'general information',
  'general info',
  'service',
  'services',
  'billing',
  'do not respond',
  'do not reply',
  'do not email',
  'no reply',
  'noreply',
  'no-reply',
  'support',
  'help',
  'info',
  'admin',
  'administrator',
  'team',
  'hello',
  'contact',
  'sales',
  'marketing',
  'newsletter',
  'news',
  'system',
  'alerts',
  'notification',
  'notifications',
  'postmaster',
  'mailer daemon',
  'mailer-daemon',
  'registration',
  'privacy',
  'legal',
  'careers',
  'jobs',
  'hr',
]);

const GENERIC_COMPANY_WORDS = new Set([
  'mail',
  'email',
  'newsletter',
  'newsletters',
  'notifications',
  'notification',
  'noreply',
  'no reply',
  'support',
  'help',
  'billing',
  'accounts',
  'admin',
  'service',
  'services',
  'mailer',
  'system',
  'marketing',
  'sales',
  'contact',
]);

const AUTOMATED_LOCAL_PARTS = [
  /^noreply$/i,
  /^no[-_]?reply$/i,
  /^do[-_]?not[-_]?reply$/i,
  /^donotreply$/i,
  /^notifications?$/i,
  /^mailer[-_]?daemon$/i,
  /^postmaster$/i,
  /^bounce[sd]?$/i,
  /^automated$/i,
  /^system$/i,
  /^alerts?$/i,
  /^digest$/i,
  /^newsletter$/i,
  /^marketing$/i,
  /^news$/i,
  /^updates?$/i,
  /^feedback$/i,
  /^hello$/i,
  /^team$/i,
  /^support$/i,
  /^help$/i,
  /^info$/i,
  /^admin$/i,
  /^billing$/i,
  /^sales$/i,
  /^contact$/i,
  /^service$/i,
  /^webmaster$/i,
  /^accounts?$/i,
  /^payments?$/i,
  /^security$/i,
  /^legal$/i,
  /^privacy$/i,
  /^jobs$/i,
  /^careers$/i,
];

const AUTOMATED_OR_VENDOR_DOMAINS = new Set([
  'slack.com',
  'slackmail.com',
  'notifications.slack.com',
  'fireflies.ai',
  'fathom.video',
  'otter.ai',
  'zoom.us',
  'webex.com',
  'gotomeeting.com',
  'calendly.com',
  'savvycal.com',
  'cal.com',
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
  'linkedin.com',
  'indeed.com',
  'ziprecruiter.com',
  'glassdoor.com',
  'monster.com',
  'wellfound.com',
  'angel.co',
  'substack.com',
  'medium.com',
  'beehiiv.com',
  'morningbrew.com',
  'theinformation.com',
]);

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      i += 1;
    }
  }

  return {
    orgId: raw.get('org-id') || DEFAULT_ORG_ID,
    database: raw.get('database') || DEFAULT_DATABASE,
    output: raw.get('output') || DEFAULT_OUTPUT,
    seed: raw.get('seed') || DEFAULT_SEED,
    remote: raw.get('local') !== 'true',
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function boolish(value: string | number | boolean | null | undefined): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.toLowerCase());
  return false;
}

function normalizeSpaces(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeToken(value: string | null | undefined): string {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[''.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePersonName(value: string | null | undefined): string {
  return normalizeToken(value)
    .replace(/\b(de la|del|van der|von|di)\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeCompanyName(value: string | null | undefined): string {
  return normalizeToken(value)
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|plc|gmbh|sa|ag)\b/g, ' ')
    .replace(/\b(ai|lab|labs|system|systems|technology|technologies|tech)\b$/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

function emailLocalPart(email: string | null | undefined): string {
  const at = String(email || '').indexOf('@');
  if (at <= 0) return '';
  return String(email).slice(0, at).toLowerCase().trim();
}

function emailDomain(email: string | null | undefined): string {
  const at = String(email || '').lastIndexOf('@');
  if (at <= 0 || at === String(email || '').length - 1) return '';
  return String(email).slice(at + 1).toLowerCase().trim();
}

function normalizeDomain(raw: string | null | undefined): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function domainStem(raw: string | null | undefined): string {
  const domain = normalizeDomain(raw);
  if (!domain) return '';
  const parts = domain.split('.').filter(Boolean);
  if (parts.length === 0) return '';
  return parts[0].replace(/[-_]/g, '').toLowerCase();
}

function linkedinHandle(raw: string | null | undefined): string {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const host = url.hostname.replace(/^www\./, '');
    if (!host.endsWith('linkedin.com')) return '';
    const segments = url.pathname.split('/').map(segment => segment.trim()).filter(Boolean);
    const markerIndex = segments.findIndex(segment => ['in', 'pub', 'company'].includes(segment));
    if (markerIndex < 0 || !segments[markerIndex + 1]) return '';
    return `${segments[markerIndex]}:${segments.slice(markerIndex + 1).join('/')}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function phoneLastSeven(raw: string | null | undefined): string {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-7) : '';
}

function isAutomatedDomain(domain: string | null | undefined): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  if (AUTOMATED_OR_VENDOR_DOMAINS.has(normalized)) return true;
  for (const blocked of AUTOMATED_OR_VENDOR_DOMAINS) {
    if (normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

function isAutomatedLocalPart(local: string): boolean {
  if (!local) return false;
  return AUTOMATED_LOCAL_PARTS.some(pattern => pattern.test(local));
}

function isEmailLikeName(name: string, email: string | null | undefined): boolean {
  const normalizedName = normalizeSpaces(name).toLowerCase();
  const lowerEmail = String(email || '').toLowerCase().trim();
  const local = emailLocalPart(email);
  if (!normalizedName) return false;
  if (normalizedName.includes('@')) return true;
  if (lowerEmail && normalizedName === lowerEmail) return true;
  if (local && normalizedName === local) return true;
  return !normalizedName.includes(' ') && /[._-]/.test(normalizedName) && normalizedName.length >= 5;
}

function isDomainPlaceholderName(name: string | null | undefined, domain: string | null | undefined): boolean {
  const n = normalizeDomain(name);
  const d = normalizeDomain(domain);
  if (!n || !d) return false;
  return n === d || normalizeCompanyName(name) === normalizeCompanyName(domainStem(d));
}

function websiteIsJustDomain(website: string | null | undefined, domain: string | null | undefined): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  const w = normalizeDomain(website);
  return w === d;
}

function rowEvidenceCount(record: ReviewSourceRecord): number {
  return (
    numberValue(record.conversation_count)
    + numberValue(record.event_count)
    + numberValue(record.deal_count)
    + numberValue(record.document_count)
    + numberValue(record.tag_count)
    + (record.record_type === 'company' ? numberValue(record.linked_contact_count) : 0)
  );
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const m1 = a.length;
  const m2 = b.length;
  if (m1 === 0 || m2 === 0) return 0;

  const matchDistance = Math.floor(Math.max(m1, m2) / 2) - 1;
  const aMatches = new Array<boolean>(m1).fill(false);
  const bMatches = new Array<boolean>(m2).fill(false);

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

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < m1; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro = (matches / m1 + matches / m2 + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, m1, m2); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const l = this.find(left);
    const r = this.find(right);
    if (l !== r) this.parent.set(r, l);
  }

  groups(): string[][] {
    const grouped = new Map<string, string[]>();
    for (const value of this.parent.keys()) {
      const root = this.find(value);
      const list = grouped.get(root) || [];
      list.push(value);
      grouped.set(root, list);
    }
    return Array.from(grouped.values()).filter(group => group.length > 1);
  }
}

function mergeDuplicateGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  const merged = new Map<string, DuplicateGroup>();
  for (const group of groups) {
    const key = group.memberIds.slice().sort().join('|');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...group, memberIds: group.memberIds.slice().sort() });
      continue;
    }
    existing.reason = Array.from(new Set([...existing.reason.split('+'), group.reason])).join('+');
    existing.score = Math.max(existing.score, group.score);
  }
  return Array.from(merged.values())
    .map((group, index) => ({
      ...group,
      id: `${group.id.split(':')[0]}:${String(index + 1).padStart(4, '0')}`,
    }));
}

function exactGroups<T extends ReviewSourceRecord>(
  prefix: string,
  rows: T[],
  reason: string,
  keyFn: (row: T) => string
): DuplicateGroup[] {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(row.id);
    map.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, memberIds] of map.entries()) {
    if (memberIds.length <= 1) continue;
    groups.push({
      id: `${prefix}:${reason}:${key}`,
      reason,
      memberIds: memberIds.slice().sort(),
      score: 100 + memberIds.length,
    });
  }
  return groups;
}

function duplicateIndex(groups: DuplicateGroup[]): Map<string, DuplicateInfo> {
  const byId = new Map<string, DuplicateInfo>();
  for (const group of groups) {
    for (const id of group.memberIds) {
      const existing = byId.get(id);
      const peers = group.memberIds.filter(memberId => memberId !== id);
      if (!existing || group.memberIds.length > existing.groupSize) {
        byId.set(id, {
          groupId: group.id,
          groupSize: group.memberIds.length,
          possibleDuplicateIds: peers,
          reasons: [group.reason],
        });
        continue;
      }
      if (existing.groupSize === group.memberIds.length) {
        existing.reasons = Array.from(new Set([...existing.reasons, group.reason])).sort();
        existing.possibleDuplicateIds = Array.from(new Set([...existing.possibleDuplicateIds, ...peers])).sort();
      }
    }
  }
  return byId;
}

export function buildContactDuplicateGroups(contacts: ContactReviewRecord[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  groups.push(...exactGroups('contact', contacts, 'exact_email', row => String(row.email || '').toLowerCase().trim()));
  groups.push(...exactGroups('contact', contacts, 'linkedin_handle', row => linkedinHandle(row.linkedin_url)));
  groups.push(...exactGroups('contact', contacts, 'phone_last7', row => {
    const phone = phoneLastSeven(row.phone);
    const name = normalizePersonName(row.name);
    return phone && name.length >= 3 ? `${phone}:${name}` : '';
  }));
  groups.push(...exactGroups('contact', contacts, 'name_company', row => {
    const name = normalizePersonName(row.name);
    return name.length >= 3 && row.company_id ? `${name}:${row.company_id}` : '';
  }));
  groups.push(...exactGroups('contact', contacts, 'name_domain', row => {
    const name = normalizePersonName(row.name);
    const domain = row.domain || emailDomain(row.email);
    return name.length >= 3 && domain ? `${name}:${normalizeDomain(domain)}` : '';
  }));

  const buckets = new Map<string, ContactReviewRecord[]>();
  for (const contact of contacts) {
    const bucket = contact.company_id || normalizeDomain(contact.domain || emailDomain(contact.email));
    const name = normalizePersonName(contact.name);
    if (!bucket || name.length < 5) continue;
    const list = buckets.get(bucket) || [];
    list.push(contact);
    buckets.set(bucket, list);
  }

  let fuzzyIndex = 1;
  for (const bucketRows of buckets.values()) {
    if (bucketRows.length < 2) continue;
    const dsu = new DisjointSet();
    for (const row of bucketRows) dsu.add(row.id);
    for (let i = 0; i < bucketRows.length; i++) {
      for (let j = i + 1; j < bucketRows.length; j++) {
        const left = normalizePersonName(bucketRows[i].name);
        const right = normalizePersonName(bucketRows[j].name);
        if (left === right) continue;
        if (Math.abs(left.length - right.length) > 6) continue;
        if (jaroWinkler(left, right) >= 0.94) dsu.union(bucketRows[i].id, bucketRows[j].id);
      }
    }
    for (const memberIds of dsu.groups()) {
      groups.push({
        id: `contact:fuzzy_name_bucket:${fuzzyIndex++}`,
        reason: 'fuzzy_name_bucket',
        memberIds: memberIds.slice().sort(),
        score: 95 + memberIds.length,
      });
    }
  }

  return mergeDuplicateGroups(groups);
}

function companyAliases(row: CompanyReviewRecord): string[] {
  const aliases = new Set<string>();
  const name = normalizeCompanyName(row.name);
  if (name.length >= 3) aliases.add(name);

  const stem = domainStem(row.domain || row.website);
  if (stem.length >= 3) {
    aliases.add(normalizeCompanyName(stem));
    for (const prefix of ['get', 'try', 'use', 'join', 'hello', 'go', 'ask']) {
      if (stem.startsWith(prefix) && stem.length - prefix.length >= 4) {
        aliases.add(normalizeCompanyName(stem.slice(prefix.length)));
      }
    }
  }

  return Array.from(aliases).filter(alias => alias.length >= 3).sort();
}

export function buildCompanyDuplicateGroups(companies: CompanyReviewRecord[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  groups.push(...exactGroups('company', companies, 'exact_domain', row => normalizeDomain(row.domain)));
  groups.push(...exactGroups('company', companies, 'normalized_name', row => normalizeCompanyName(row.name)));
  groups.push(...exactGroups('company', companies, 'domain_stem', row => domainStem(row.domain || row.website)));

  const aliasMap = new Map<string, string[]>();
  const aliasByCompany = new Map<string, string[]>();
  for (const company of companies) {
    const aliases = companyAliases(company);
    aliasByCompany.set(company.id, aliases);
    for (const alias of aliases) {
      const list = aliasMap.get(alias) || [];
      list.push(company.id);
      aliasMap.set(alias, list);
    }
  }
  for (const [alias, memberIds] of aliasMap.entries()) {
    if (memberIds.length <= 1) continue;
    groups.push({
      id: `company:alias:${alias}`,
      reason: 'alias',
      memberIds: memberIds.slice().sort(),
      score: 98 + memberIds.length,
    });
  }

  const dsu = new DisjointSet();
  for (const company of companies) dsu.add(company.id);
  const sorted = companies
    .map(company => ({
      id: company.id,
      alias: (aliasByCompany.get(company.id) || []).sort((a, b) => b.length - a.length)[0] || '',
    }))
    .filter(item => item.alias.length >= 5)
    .sort((a, b) => a.alias.localeCompare(b.alias));

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const left = sorted[i].alias;
      const right = sorted[j].alias;
      if (left[0] !== right[0]) break;
      if (Math.abs(left.length - right.length) > 8) continue;
      const minLen = Math.min(left.length, right.length);
      const containment = minLen >= 6 && (left.includes(right) || right.includes(left));
      if (containment || jaroWinkler(left, right) >= 0.93) dsu.union(sorted[i].id, sorted[j].id);
    }
  }
  let fuzzyIndex = 1;
  for (const memberIds of dsu.groups()) {
    groups.push({
      id: `company:fuzzy_alias:${fuzzyIndex++}`,
      reason: 'fuzzy_alias',
      memberIds: memberIds.slice().sort(),
      score: 95 + memberIds.length,
    });
  }

  return mergeDuplicateGroups(groups);
}

export function scoreContactCandidate(
  contact: ContactReviewRecord,
  duplicateInfo: DuplicateInfo | null = null
): CandidateScore {
  let score = 0;
  const reasons: string[] = [];
  const name = normalizeSpaces(contact.name);
  const nameToken = normalizeToken(name);
  const local = emailLocalPart(contact.email);

  if (duplicateInfo) {
    score += 95 + Math.min(25, duplicateInfo.groupSize * 3);
    reasons.push(`possible_duplicate:${duplicateInfo.reasons.join('+')}`);
  }
  if (GENERIC_CONTACT_NAMES.has(nameToken)) {
    score += 85;
    reasons.push('generic_non_person_name');
  }
  if (isEmailLikeName(name, contact.email)) {
    score += 70;
    reasons.push('email_like_name');
  }
  if (contact.email && (isAutomatedLocalPart(local) || isAutomatedDomain(emailDomain(contact.email)))) {
    score += 85;
    reasons.push('automated_or_shared_mailbox_email');
  }
  if ((contact.source === 'import' || contact.source === 'manual') && (nameToken === 'unknown' || isEmailLikeName(name, contact.email))) {
    score += 40;
    reasons.push('placeholder_import_or_manual_name');
  }
  if (!contact.email && rowEvidenceCount(contact) === 0) {
    score += 45;
    reasons.push('no_email_and_no_evidence');
  }
  if (numberValue(contact.interaction_count) === 0 || rowEvidenceCount(contact) === 0) {
    score += 35;
    reasons.push('zero_or_no_linked_activity');
  }
  if (!name.includes(' ') && name.length > 15) {
    score += 25;
    reasons.push('single_long_token_name');
  }
  if (/^\w{1,2}$/.test(name)) {
    score += 45;
    reasons.push('too_short_to_be_person_name');
  }
  if (/\d{3,}/.test(name)) {
    score += 40;
    reasons.push('name_contains_id_like_number');
  }

  return { score, reasons: Array.from(new Set(reasons)).sort() };
}

export function scoreCompanyCandidate(
  company: CompanyReviewRecord,
  duplicateInfo: DuplicateInfo | null = null
): CandidateScore {
  let score = 0;
  const reasons: string[] = [];
  const domain = normalizeDomain(company.domain || company.website);
  const nameToken = normalizeToken(company.name);

  if (duplicateInfo) {
    score += 100 + Math.min(25, duplicateInfo.groupSize * 3);
    reasons.push(`possible_duplicate:${duplicateInfo.reasons.join('+')}`);
  }
  if (boolish(company.audit_auto_created)) {
    score += 45;
    reasons.push('auto_created_from_email_domain');
  }
  if (isDomainPlaceholderName(company.name, domain)) {
    score += 45;
    reasons.push('domain_placeholder_name');
  }
  if (websiteIsJustDomain(company.website, domain)) {
    score += 20;
    reasons.push('website_is_bare_domain');
  }
  if (!company.entity_type || company.entity_type === 'other') {
    score += 15;
    reasons.push('company_type_other');
  }
  if (!company.status || company.status === 'tracking') {
    score += 15;
    reasons.push('status_tracking');
  }
  if (rowEvidenceCount(company) === 0) {
    score += 60;
    reasons.push('no_contacts_deals_docs_or_tags');
  } else if (numberValue(company.linked_contact_count) === 0) {
    score += 20;
    reasons.push('no_linked_contacts');
  }
  if (isAutomatedDomain(domain)) {
    score += 80;
    reasons.push('vendor_or_automated_domain');
  }
  if (GENERIC_COMPANY_WORDS.has(nameToken) || GENERIC_COMPANY_WORDS.has(domainStem(domain))) {
    score += 55;
    reasons.push('generic_service_or_mailbox_company_name');
  }
  if (!company.website && !company.domain && rowEvidenceCount(company) === 0) {
    score += 35;
    reasons.push('no_domain_website_or_evidence');
  }

  return { score, reasons: Array.from(new Set(reasons)).sort() };
}

function scoreRecord<T extends ReviewSourceRecord>(record: T, duplicateInfo: DuplicateInfo | null): CandidateScore {
  return record.record_type === 'contact'
    ? scoreContactCandidate(record as ContactReviewRecord, duplicateInfo)
    : scoreCompanyCandidate(record as CompanyReviewRecord, duplicateInfo);
}

function scoredCandidates<T extends ReviewSourceRecord>(
  records: T[],
  duplicateInfoById: Map<string, DuplicateInfo>
): ScoredCandidate<T>[] {
  return records.map(record => {
    const duplicateInfo = duplicateInfoById.get(record.id) || null;
    const scored = scoreRecord(record, duplicateInfo);
    return { record, duplicateInfo, score: scored.score, reasons: scored.reasons };
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableCandidateSort<T extends ReviewSourceRecord>(left: ScoredCandidate<T>, right: ScoredCandidate<T>): number {
  if (right.score !== left.score) return right.score - left.score;
  const leftEvidence = rowEvidenceCount(left.record);
  const rightEvidence = rowEvidenceCount(right.record);
  if (leftEvidence !== rightEvidence) return leftEvidence - rightEvidence;
  return left.record.id.localeCompare(right.record.id);
}

function selectSegment<T extends ReviewSourceRecord>(
  records: T[],
  duplicateGroups: DuplicateGroup[],
  duplicateInfoById: Map<string, DuplicateInfo>,
  suspectLimit: number,
  randomLimit: number,
  seed: string
): SegmentResult<T> {
  const scored = scoredCandidates(records, duplicateInfoById);
  const byId = new Map(scored.map(candidate => [candidate.record.id, candidate]));
  const selectedIds = new Set<string>();
  const suspects: ScoredCandidate<T>[] = [];

  const sortedGroups = duplicateGroups
    .slice()
    .sort((a, b) => b.score - a.score || b.memberIds.length - a.memberIds.length || a.id.localeCompare(b.id));

  for (const group of sortedGroups) {
    const members = group.memberIds
      .map(id => byId.get(id))
      .filter((candidate): candidate is ScoredCandidate<T> => Boolean(candidate))
      .filter(candidate => !selectedIds.has(candidate.record.id));
    if (members.length <= 1) continue;
    if (suspects.length + members.length > suspectLimit) continue;
    members.sort(stableCandidateSort);
    for (const member of members) {
      selectedIds.add(member.record.id);
      suspects.push(member);
    }
  }

  for (const candidate of scored.slice().sort(stableCandidateSort)) {
    if (suspects.length >= suspectLimit) break;
    if (selectedIds.has(candidate.record.id)) continue;
    selectedIds.add(candidate.record.id);
    suspects.push(candidate);
  }

  const randomCandidates = scored
    .filter(candidate => !selectedIds.has(candidate.record.id))
    .sort((a, b) => {
      const left = hashString(`${seed}:${a.record.record_type}:${a.record.id}`);
      const right = hashString(`${seed}:${b.record.record_type}:${b.record.id}`);
      return left - right || a.record.id.localeCompare(b.record.id);
    })
    .slice(0, randomLimit);

  if (suspects.length !== suspectLimit) {
    throw new Error(`CRM_QUALITY_REVIEW_SUSPECT_LIMIT_UNMET:${records[0]?.record_type || 'unknown'}:${suspects.length}/${suspectLimit}`);
  }
  if (randomCandidates.length !== randomLimit) {
    throw new Error(`CRM_QUALITY_REVIEW_RANDOM_LIMIT_UNMET:${records[0]?.record_type || 'unknown'}:${randomCandidates.length}/${randomLimit}`);
  }

  return { suspects, randoms: randomCandidates };
}

function rowFromCandidate<T extends ReviewSourceRecord>(
  candidate: ScoredCandidate<T>,
  sampleType: SampleType,
  sampleRank: number
): ReviewCsvRow {
  const record = candidate.record;
  const duplicate = candidate.duplicateInfo;
  const isCompany = record.record_type === 'company';
  const source = isCompany
    ? (boolish(record.audit_auto_created) ? 'auto_domain_stub' : record.source || '')
    : (record as ContactReviewRecord).source || '';

  return {
    review_grade: '',
    review_notes: '',
    record_type: record.record_type,
    sample_type: sampleType,
    sample_rank: String(sampleRank),
    candidate_score: String(Math.round(candidate.score)),
    candidate_reasons: candidate.reasons.join('; '),
    duplicate_group_id: duplicate?.groupId || '',
    duplicate_group_size: duplicate ? String(duplicate.groupSize) : '',
    possible_duplicate_ids: duplicate?.possibleDuplicateIds.join('|') || '',
    id: record.id,
    name: record.name,
    email: record.record_type === 'contact' ? (record as ContactReviewRecord).email || '' : '',
    domain: record.domain || '',
    website: record.record_type === 'company' ? (record as CompanyReviewRecord).website || '' : '',
    company_id: record.record_type === 'contact' ? (record as ContactReviewRecord).company_id || '' : '',
    company_name: record.record_type === 'contact' ? (record as ContactReviewRecord).company_name || '' : '',
    source,
    entity_type: record.entity_type || '',
    status: record.status || '',
    created_at: record.created_at,
    updated_at: record.updated_at,
    interaction_count: String(numberValue(record.interaction_count)),
    conversation_count: String(numberValue(record.conversation_count)),
    event_count: String(numberValue(record.event_count)),
    deal_count: String(numberValue(record.deal_count)),
    document_count: String(numberValue(record.document_count)),
    tag_count: String(numberValue(record.tag_count)),
    linked_contact_count: String(record.record_type === 'company' ? numberValue((record as CompanyReviewRecord).linked_contact_count) : 0),
    audit_origin: record.audit_origin || '',
    audit_auto_created: boolish(record.audit_auto_created) ? 'true' : '',
    crm_url: `https://medinaventures.ai/${record.record_type === 'contact' ? 'contacts' : 'companies'}/${record.id}`,
  };
}

export function buildQualityReviewRows(input: BuildReviewInput): ReviewCsvRow[] {
  const suspectLimit = input.suspectLimit ?? SUSPECT_LIMIT;
  const randomLimit = input.randomLimit ?? RANDOM_LIMIT;
  const seed = input.seed || DEFAULT_SEED;

  const activeContacts = input.contacts.filter(row => !row.deleted_at && !row.merged_into);
  const activeCompanies = input.companies.filter(row => !row.deleted_at && !row.merged_into);

  const contactDuplicateGroups = buildContactDuplicateGroups(activeContacts);
  const companyDuplicateGroups = buildCompanyDuplicateGroups(activeCompanies);
  const contactDuplicateInfo = duplicateIndex(contactDuplicateGroups);
  const companyDuplicateInfo = duplicateIndex(companyDuplicateGroups);

  const contactSegment = selectSegment(
    activeContacts,
    contactDuplicateGroups,
    contactDuplicateInfo,
    suspectLimit,
    randomLimit,
    seed
  );
  const companySegment = selectSegment(
    activeCompanies,
    companyDuplicateGroups,
    companyDuplicateInfo,
    suspectLimit,
    randomLimit,
    seed
  );

  return [
    ...contactSegment.suspects.map((candidate, index) => rowFromCandidate(candidate, 'suspect', index + 1)),
    ...contactSegment.randoms.map((candidate, index) => rowFromCandidate(candidate, 'random', index + 1)),
    ...companySegment.suspects.map((candidate, index) => rowFromCandidate(candidate, 'suspect', index + 1)),
    ...companySegment.randoms.map((candidate, index) => rowFromCandidate(candidate, 'random', index + 1)),
  ];
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: ReviewCsvRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(column => csvEscape(row[column] || '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function contactSql(orgId: string): string {
  const org = sqlString(orgId);
  return `
WITH active_contacts AS (
  SELECT *
    FROM contacts
   WHERE org_id = ${org}
     AND deleted_at IS NULL
     AND merged_into IS NULL
),
conv_counts AS (
  SELECT contact_id, COUNT(*) AS count
    FROM conversation_contacts
   GROUP BY contact_id
),
event_counts AS (
  SELECT ea.contact_id, COUNT(*) AS count
    FROM event_attendees ea
    JOIN events e ON e.id = ea.event_id
   WHERE ea.contact_id IS NOT NULL
     AND e.org_id = ${org}
     AND e.deleted_at IS NULL
   GROUP BY ea.contact_id
),
deal_counts AS (
  SELECT contact_id, COUNT(*) AS count
    FROM deal_contacts
   WHERE org_id = ${org}
   GROUP BY contact_id
),
doc_counts AS (
  SELECT contact_id, COUNT(*) AS count
    FROM documents
   WHERE org_id = ${org}
     AND deleted_at IS NULL
     AND contact_id IS NOT NULL
   GROUP BY contact_id
),
tag_counts AS (
  SELECT contact_id, COUNT(*) AS count
    FROM contact_tags
   GROUP BY contact_id
),
audit_ranked AS (
  SELECT entity_id,
         metadata,
         ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY created_at ASC, id ASC) AS rn
    FROM audit_log
   WHERE org_id = ${org}
     AND entity_type = 'contact'
     AND action = 'create'
)
SELECT
  'contact' AS record_type,
  c.id,
  c.full_name AS name,
  c.full_name,
  c.email,
  CASE
    WHEN c.email IS NOT NULL AND instr(c.email, '@') > 0
    THEN lower(substr(c.email, instr(c.email, '@') + 1))
    ELSE NULL
  END AS domain,
  c.phone,
  c.linkedin_url,
  c.company_id,
  co.name AS company_name,
  c.source,
  c.contact_type AS entity_type,
  c.relationship_status AS status,
  c.created_at,
  c.updated_at,
  c.deleted_at,
  c.merged_into,
  COALESCE(c.total_interactions, 0) AS interaction_count,
  COALESCE(conv_counts.count, 0) AS conversation_count,
  COALESCE(event_counts.count, 0) AS event_count,
  COALESCE(deal_counts.count, 0) AS deal_count,
  COALESCE(doc_counts.count, 0) AS document_count,
  COALESCE(tag_counts.count, 0) AS tag_count,
  COALESCE(json_extract(audit_ranked.metadata, '$.origin'), json_extract(audit_ranked.metadata, '$.discovered_from')) AS audit_origin,
  json_extract(audit_ranked.metadata, '$.auto_created') AS audit_auto_created
FROM active_contacts c
LEFT JOIN companies co ON co.id = c.company_id AND co.org_id = c.org_id
LEFT JOIN conv_counts ON conv_counts.contact_id = c.id
LEFT JOIN event_counts ON event_counts.contact_id = c.id
LEFT JOIN deal_counts ON deal_counts.contact_id = c.id
LEFT JOIN doc_counts ON doc_counts.contact_id = c.id
LEFT JOIN tag_counts ON tag_counts.contact_id = c.id
LEFT JOIN audit_ranked ON audit_ranked.entity_id = c.id AND audit_ranked.rn = 1
ORDER BY c.id ASC`;
}

function companySql(orgId: string): string {
  const org = sqlString(orgId);
  return `
WITH active_companies AS (
  SELECT *
    FROM companies
   WHERE org_id = ${org}
     AND deleted_at IS NULL
     AND merged_into IS NULL
),
contact_counts AS (
  SELECT company_id, COUNT(*) AS count
    FROM contacts
   WHERE org_id = ${org}
     AND deleted_at IS NULL
     AND merged_into IS NULL
     AND company_id IS NOT NULL
   GROUP BY company_id
),
conv_counts AS (
  SELECT c.company_id, COUNT(DISTINCT cc.conversation_id) AS count
    FROM contacts c
    JOIN conversation_contacts cc ON cc.contact_id = c.id
   WHERE c.org_id = ${org}
     AND c.deleted_at IS NULL
     AND c.merged_into IS NULL
     AND c.company_id IS NOT NULL
   GROUP BY c.company_id
),
event_counts AS (
  SELECT c.company_id, COUNT(DISTINCT ea.event_id) AS count
    FROM contacts c
    JOIN event_attendees ea ON ea.contact_id = c.id
    JOIN events e ON e.id = ea.event_id
   WHERE c.org_id = ${org}
     AND c.deleted_at IS NULL
     AND c.merged_into IS NULL
     AND c.company_id IS NOT NULL
     AND e.org_id = ${org}
     AND e.deleted_at IS NULL
   GROUP BY c.company_id
),
deal_counts AS (
  SELECT company_id, COUNT(*) AS count
    FROM deals
   WHERE org_id = ${org}
     AND deleted_at IS NULL
     AND company_id IS NOT NULL
   GROUP BY company_id
),
doc_counts AS (
  SELECT company_id, COUNT(*) AS count
    FROM documents
   WHERE org_id = ${org}
     AND deleted_at IS NULL
     AND company_id IS NOT NULL
   GROUP BY company_id
),
tag_counts AS (
  SELECT company_id, COUNT(*) AS count
    FROM company_tags
   GROUP BY company_id
),
audit_ranked AS (
  SELECT entity_id,
         metadata,
         ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY created_at ASC, id ASC) AS rn
    FROM audit_log
   WHERE org_id = ${org}
     AND entity_type = 'company'
     AND action = 'create'
)
SELECT
  'company' AS record_type,
  co.id,
  co.name,
  co.domain,
  co.website,
  NULL AS source,
  co.company_type AS entity_type,
  co.investment_status AS status,
  co.created_at,
  co.updated_at,
  co.deleted_at,
  co.merged_into,
  COALESCE(conv_counts.count, 0) + COALESCE(event_counts.count, 0) AS interaction_count,
  COALESCE(conv_counts.count, 0) AS conversation_count,
  COALESCE(event_counts.count, 0) AS event_count,
  COALESCE(deal_counts.count, 0) AS deal_count,
  COALESCE(doc_counts.count, 0) AS document_count,
  COALESCE(tag_counts.count, 0) AS tag_count,
  COALESCE(contact_counts.count, 0) AS linked_contact_count,
  json_extract(audit_ranked.metadata, '$.origin') AS audit_origin,
  json_extract(audit_ranked.metadata, '$.auto_created') AS audit_auto_created
FROM active_companies co
LEFT JOIN contact_counts ON contact_counts.company_id = co.id
LEFT JOIN conv_counts ON conv_counts.company_id = co.id
LEFT JOIN event_counts ON event_counts.company_id = co.id
LEFT JOIN deal_counts ON deal_counts.company_id = co.id
LEFT JOIN doc_counts ON doc_counts.company_id = co.id
LEFT JOIN tag_counts ON tag_counts.company_id = co.id
LEFT JOIN audit_ranked ON audit_ranked.entity_id = co.id AND audit_ranked.rn = 1
ORDER BY co.id ASC`;
}

function runD1Query<T>(args: Args, sql: string): T[] {
  const wranglerArgs = [
    'wrangler',
    'd1',
    'execute',
    args.database,
    args.remote ? '--remote' : '--local',
    '--json',
    '--command',
    sql,
  ];
  const output = execFileSync('npx', wranglerArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output) as Array<D1ExecuteResult<T>>;
  const first = parsed[0];
  if (!first?.success) throw new Error(`D1_QUERY_FAILED:${output.slice(0, 500)}`);
  return first.results || [];
}

function normalizeContactRow(row: any): ContactReviewRecord {
  return {
    record_type: 'contact',
    id: String(row.id),
    name: String(row.name || row.full_name || ''),
    full_name: textValue(row.full_name) || undefined,
    email: textValue(row.email),
    domain: textValue(row.domain),
    phone: textValue(row.phone),
    linkedin_url: textValue(row.linkedin_url),
    company_id: textValue(row.company_id),
    company_name: textValue(row.company_name),
    source: textValue(row.source),
    entity_type: textValue(row.entity_type),
    status: textValue(row.status),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    deleted_at: textValue(row.deleted_at),
    merged_into: textValue(row.merged_into),
    interaction_count: numberValue(row.interaction_count),
    conversation_count: numberValue(row.conversation_count),
    event_count: numberValue(row.event_count),
    deal_count: numberValue(row.deal_count),
    document_count: numberValue(row.document_count),
    tag_count: numberValue(row.tag_count),
    audit_origin: textValue(row.audit_origin),
    audit_auto_created: row.audit_auto_created ?? null,
  };
}

function normalizeCompanyRow(row: any): CompanyReviewRecord {
  return {
    record_type: 'company',
    id: String(row.id),
    name: String(row.name || ''),
    domain: textValue(row.domain),
    website: textValue(row.website),
    source: textValue(row.source),
    entity_type: textValue(row.entity_type),
    status: textValue(row.status),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    deleted_at: textValue(row.deleted_at),
    merged_into: textValue(row.merged_into),
    interaction_count: numberValue(row.interaction_count),
    conversation_count: numberValue(row.conversation_count),
    event_count: numberValue(row.event_count),
    deal_count: numberValue(row.deal_count),
    document_count: numberValue(row.document_count),
    tag_count: numberValue(row.tag_count),
    linked_contact_count: numberValue(row.linked_contact_count),
    audit_origin: textValue(row.audit_origin),
    audit_auto_created: row.audit_auto_created ?? null,
  };
}

export async function runCrmQualityReviewExport(args: Args): Promise<{
  output: string;
  rows: number;
  counts: Record<string, number>;
}> {
  const contacts = runD1Query<any>(args, contactSql(args.orgId)).map(normalizeContactRow);
  const companies = runD1Query<any>(args, companySql(args.orgId)).map(normalizeCompanyRow);
  const rows = buildQualityReviewRows({ contacts, companies, seed: args.seed });
  const csv = toCsv(rows);
  const output = resolve(args.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, csv, 'utf8');

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.record_type}:${row.sample_type}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { output, rows: rows.length, counts };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCrmQualityReviewExport(parseArgs(process.argv.slice(2)))
    .then(summary => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch(error => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    });
}

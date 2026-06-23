import {
  CRM_QUALITY_RULES,
  type CrmEntityType,
  type CrmQualityConfidence,
  type CrmQualityNameStatus,
  type CrmQualitySourceEvidence,
} from './crm-quality-gate';
import { getAppOnlyGraphAccessToken } from './graph-auth';
import { checkGraphRateLimit, recordGraphApiCall } from './rate-limit';
import type { Env } from '../types/env';

export type CrmNameResolutionStatus =
  | 'verified'
  | 'provisional'
  | 'domain_placeholder'
  | 'merge'
  | 'no_entity'
  | 'fail';

export type CrmNameCandidateSemanticClass =
  | 'clean_name'
  | 'weak_name'
  | 'artifact'
  | 'wrong_entity_risk'
  | 'non_person'
  | 'domain_placeholder'
  | 'invalid';

export type CrmNameCandidateRiskFlag =
  | 'page_artifact'
  | 'navigation_text'
  | 'tagline_or_descriptor'
  | 'sentence_fragment'
  | 'trailing_conjunction'
  | 'logo_artifact'
  | 'directory_listing'
  | 'template_artifact'
  | 'compressed_neighbor'
  | 'wrong_entity_conflict'
  | 'domain_placeholder_over_clean_source'
  | 'domain_stem_only'
  | 'email_header_action_word'
  | 'service_or_shared_mailbox'
  | 'company_as_contact'
  | 'automated_sender'
  | 'partial_person_name'
  | 'repeated_person_token';

export type CrmNameVerificationDecision =
  | 'verify'
  | 'downgrade_provisional'
  | 'accept_domain_placeholder'
  | 'reject'
  | 'no_entity';

export interface CrmNameVerificationContract {
  semantic_class: CrmNameCandidateSemanticClass;
  risk_flags: CrmNameCandidateRiskFlag[];
  verification_decision: CrmNameVerificationDecision;
  verification_block_reason?: string;
  status_before_firewall: CrmNameResolutionStatus;
  status_after_firewall: CrmNameResolutionStatus;
}

export interface CrmCompanyWebsiteMetadata {
  fetchUrl?: string | null;
  finalUrl?: string | null;
  fetchedLive?: boolean;
  ok?: boolean;
  title?: string | null;
  ogSiteName?: string | null;
  applicationName?: string | null;
  schemaNames?: string[] | string | null;
  confidence?: 'strong' | 'weak' | 'unknown' | null;
}

export interface CrmContactPublicNameCandidate {
  name: string;
  sourceUrl?: string | null;
  sourceText?: string | null;
  sourceType?: 'domain_owned_page' | 'domain_sitemap' | 'profile_metadata' | null;
  confidence?: 'strong' | 'weak' | 'unknown' | null;
}

export interface CrmContactPublicNameMetadata {
  fetchedLive?: boolean;
  ok?: boolean;
  candidates?: CrmContactPublicNameCandidate[] | null;
  confidence?: 'strong' | 'weak' | 'unknown' | null;
}

export interface CrmNameResolutionInput {
  entityType: CrmEntityType;
  rawName?: string | null;
  currentName?: string | null;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  sourceNameCandidates?: string[] | null;
  websiteMetadata?: CrmCompanyWebsiteMetadata | null;
  contactPublicMetadata?: CrmContactPublicNameMetadata | null;
  source?: CrmQualitySourceEvidence;
  rootCause?: string | null;
  relationshipEvidence?: boolean;
  allowDomainPlaceholder?: boolean;
  mergeTargetId?: string | null;
  deleteReason?: string | null;
  evidenceCandidates?: CrmNameEvidenceCandidate[] | null;
}

export type CrmNameEvidenceCandidateKind =
  | 'contact_name'
  | 'company_name'
  | 'company_alias'
  | 'domain_placeholder'
  | 'split_candidate';

export type CrmNameEvidenceSourceType =
  | 'source_payload'
  | 'existing_crm_entity'
  | 'crm_neighbor'
  | 'calendar_attendee'
  | 'conversation_header'
  | 'email_signature'
  | 'quoted_header'
  | 'linkedin_slug'
  | 'domain_surname'
  | 'domain_owned_page'
  | 'domain_metadata'
  | 'first_party_identity'
  | 'local_parser';

export interface CrmNameEvidenceCandidate {
  value: string;
  entity_type: CrmEntityType;
  candidate_kind: CrmNameEvidenceCandidateKind;
  source_type: CrmNameEvidenceSourceType;
  source_channel: string;
  source_record_id?: string | null;
  source_text_excerpt?: string | null;
  confidence: 'strong' | 'medium' | 'weak';
  privacy_scope: 'org_owned' | 'public' | 'provider_identity' | 'source_payload';
  observed_at?: string | null;
  rule_ids: string[];
  cost_tier: 0 | 1 | 2 | 3 | 4;
  accepted?: boolean;
  semantic_class?: CrmNameCandidateSemanticClass;
  risk_flags?: CrmNameCandidateRiskFlag[];
  verification_decision?: CrmNameVerificationDecision;
  verification_block_reason?: string;
  status_before_firewall?: CrmNameResolutionStatus;
  status_after_firewall?: CrmNameResolutionStatus;
}

export interface CrmNameEvidenceBuilderDiagnostic {
  builder: string;
  candidate_count: number;
  skipped_reason?: string | null;
  budget_spent_ms: number;
  network_calls: number;
  cache_hits: number;
}

export interface CrmNameEvidenceBundle {
  org_id?: string | null;
  entity_id?: string | null;
  entity_type: CrmEntityType;
  trigger: string;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  current_name?: string | null;
  candidates: CrmNameEvidenceCandidate[];
  budget_spent_ms: number;
  network_calls: number;
  cache_hits: number;
  builder_diagnostics?: CrmNameEvidenceBuilderDiagnostic[];
  gold_used_at_runtime: false;
}

export interface BuildCrmNameEvidenceBundleInput extends CrmNameResolutionInput {
  orgId?: string | null;
  entityId?: string | null;
  trigger?: string | null;
  runtimeEvidenceCandidates?: CrmNameEvidenceCandidate[] | null;
}

export interface BuildCrmNameEvidenceBundleOptions {
  includeNetwork?: boolean;
  networkTimeoutMs?: number;
  maxNetworkCalls?: number;
  startTimeMs?: number;
}

export interface CrmNameResolutionWithEvidence {
  resolution: CrmNameResolutionResult;
  evidenceBundle: CrmNameEvidenceBundle;
}

export interface CrmNameCandidate {
  candidateName: string;
  normalizedName: string;
  status: Exclude<CrmNameResolutionStatus, 'merge' | 'no_entity' | 'fail'>;
  confidence: CrmQualityConfidence;
  score: number;
  ruleIds: string[];
  reason: string;
  sourceText: string;
  accepted: boolean;
  semantic_class?: CrmNameCandidateSemanticClass;
  risk_flags?: CrmNameCandidateRiskFlag[];
  verification_decision?: CrmNameVerificationDecision;
  verification_block_reason?: string;
  status_before_firewall?: CrmNameResolutionStatus;
  status_after_firewall?: CrmNameResolutionStatus;
}

export interface CrmNameResolutionResult {
  status: CrmNameResolutionStatus;
  normalizedName?: string;
  nameStatus?: CrmQualityNameStatus;
  confidence: CrmQualityConfidence;
  ruleIds: string[];
  reasons: string[];
  candidates: CrmNameCandidate[];
  splitNames?: string[];
  evidence: Required<CrmQualitySourceEvidence>;
}

const AUTOMATED_LOCAL_NAMES = new Set([
  'abuse',
  'admin',
  'administrator',
  'alerts',
  'app',
  'billing',
  'bounce',
  'bounces',
  'calendar',
  'contact',
  'daemon',
  'digest',
  'do-not-reply',
  'donotreply',
  'email',
  'executiveassistant',
  'feedback',
  'hello',
  'help',
  'info',
  'invite',
  'invites',
  'mail',
  'mailer',
  'mailer-daemon',
  'mailerdaemon',
  'marketing',
  'messenger',
  'mobilesolutions',
  'news',
  'newsletter',
  'notifications',
  'notify',
  'no-reply',
  'noreply',
  'postmaster',
  'registration',
  'registrations',
  'sales',
  'security',
  'service',
  'support',
  'system',
  'team',
  'updates',
  'vimeo',
  'webmaster',
  'wix-team',
  'wordpress',
  'qubits',
]);

const AUTOMATED_DOMAINS = new Set([
  'adobesign.com',
  'amazonses.com',
  'atlassian.com',
  'calendar.luma-mail.com',
  'calendly.com',
  'docsend.com',
  'docs.google.com',
  'docusign.net',
  'e.read.ai',
  'fireflies.ai',
  'github.com',
  'google.com',
  'hubspot.com',
  'luma-mail.com',
  'lu.ma',
  'mailchimp.com',
  'mailgun.net',
  'microsoft.com',
  'office.com',
  'office365.com',
  'otter.ai',
  'sendgrid.net',
  'slack.com',
  'slackmail.com',
  'stripe.com',
  'surveymonkeyuser.com',
  'wix.com',
  'zoom.us',
]);

const PERSONAL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

const KNOWN_GIVEN_NAME_LOCALS = new Set([
  'adam',
  'alex',
  'bram',
  'dennis',
  'danny',
  'darian',
  'elias',
  'gabe',
  'guti',
  'jacqueline',
  'kelly',
  'michelle',
  'nat',
  'nico',
  'philip',
  'sam',
  'tony',
  'vic',
  'vijoy',
  'wade',
]);

const KNOWN_COMPANY_ACRONYMS = new Set(['ACA', 'AIF', 'CSC', 'DARPA', 'FVS', 'GOB', 'GS', 'MBF', 'N1I', 'PEF', 'RCCL', 'SGR', 'SSMB', 'TPG', 'VT', 'ZWC']);
const COMPANY_SUFFIX_RE = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|plc|s\.?a\.?|s\.?p\.?a\.?)\b\.?/gi;
const PAGE_TITLE_BOILERPLATE_RE = /\b(home|homepage|front page|official site|official website|welcome|website|upcoming events|wealth management services|coming soon|you need to|enable javascript|field admin tool|redirect page|introduction this)\b/i;
const COMPANY_INDICATOR_RE = /\b(capital|ventures|partners|advisors|management|investments|investment|fund|funds|equity|bank|university|network|health|healthcare|space|group|holdings|commercial|securities|wealth|law|llp|studio|rail|mutual|forum|leap|labs?|technolog(?:y|ies))\b/i;
const CONTACT_CONTEXT_RE = /\b(ltg|ltc|maj|col|capt|cpt|ses|osd|ousd|ussocom|socom|usarmy|usa|hq|t2com|citd|civ|ctr|contr|contractor|ret|retired|gen|brig|mr|mrs|ms)\b\.?/gi;
const SERVICE_SUFFIX_RE = /\s+(?:via|from)\s+(?:read\s*ai|qualified|calendly|zoom|fireflies|otter|luma|lu\.ma)\b.*$/i;
const METADATA_REJECT_RE = /\b(default|nav|social\s*share\w*|facebook|linkedin|twitter|youtube|instagram|google\s*site\s*id|googlesiteid|visitor_lang|planning|timezone|time zone|timezones?|pacific time|central time|eastern time|mountain time|central european time|centraleuropæisk tid|united states|central oregon|los angeles|aland islands|austin texas|texas business|afghanistan|albania|algeria|american samoa|andorra|angola|anguilla|antigua|argentina|armenia|aruba|ascension island|ascensionøen|australia|austria|azerbaijan|about us|contact us|our history|corporate governance|financial strength|culture and impact|careers|retirement income|income gap|financial reports|disclosures?|nmls|how we collect|collect your info|skip to main content|how much|what is|privacy policy|terms|hugedomains?|for sale|parked domain|coming soon|content only with link|link to form|link-to-form|value proposition|co-?founder|session has ended|you need to|enable javascript|field admin tool|redirect page|introduction this)\b/i;
const METADATA_LOCATION_ONLY_RE = /^[A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}(?:,\s*(?:USA|United States))?|[A-Za-z .'-]+,\s*(?:USA|United States))$/i;
const METADATA_DATE_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s*20\d{2}\b/i;
const METADATA_PREFIX_RE = /^(?:about|by|visit|a\s+recap\s+of|latest\s+investment)\b/i;
const METADATA_ADDRESS_RE = /\b(?:[A-Z]{2}\s+)?\d{5}(?:-\d{4})?\b|greenwich office park/i;
const GENERIC_SINGLE_TOKEN_METADATA_RE = /^(actions?|home|menu|blog|news|events?|services?|solutions?|platform|software|support|contact|insurance)$/i;
const GENERIC_METADATA_PHRASE_RE = /^(life insurance|insurance center|family office|home page|front page)$/i;
const COMPANY_PAGE_ARTIFACT_RE = /\b(thank\s+you|subscrib(?:e|ing)|sign\s+up|read\s+more|learn\s+more|contact\s+(?:us|investment|professionals?)|why\s+choose|practice\s+solutions|join\s+(?:our|the)?|launched\s+in|capital\s+creation\s+company|financial reports|index\s+of|my\s*site|template|back\s+to|skip\s+to|logo)\b/i;
const COMPANY_DESCRIPTOR_RE = /\b(powered|fund\s+advisory|intelligent\s+computing|computing\s+everywhere|login|security|private\s+debt|private\s+wealth|real\s+estate|business\s+corporation|business\s+line|magnetic[-\s]*field|sensing|software|platform|solutions?|services?|extension|outsourcing|development|productivity|resort\s*&?\s*residences|agencias?\s+aduanales?)\b/i;
const HARD_COMPANY_DESCRIPTOR_RE = /\b(?:institutional\s+)?real\s+estate\s+for\s+private\s+wealth\b|\bagencias?\s+aduanales?\b|\bbusiness\s+corporation\b/i;
const EMBEDDED_COMPANY_WORD_RE = /(capital|ventures?|partners?|advisors?|companies|network|group|construction|enterprises|financial|cybersecurity|simplified|whitehawk|holdings?|investments?|management|development|board|bank|global|gramusa)/i;
const CONTACT_NON_PERSON_RE = /\b(annual\s+report\s+service|service\s+desk|help\s*desk|counseling\s+office|college\s+counseling|office|department|mailbox|support|notification|confirm(?:ation)?|event|webinar|prep|school|academy|university|capital|ventures?|partners?|company|group|holdings?|americas|signatures?|adobe\s+acrobat\s+sign)\b|^team\s+/i;
const CONTACT_HEADER_ACTION_WORD_RE = /\b(sent|from|get|via|on\s+behalf)\b/i;
const TITLE_SEPARATOR_RE = /\s+(?:[|\u2022\u00b7\u2013\u2014-])\s+|:/;
const PERSON_PAGE_LINK_RE = /team|people|about|contact|leadership|staff|bio|profile|professionals?|attorneys?|lawyers?|members?/i;
const PUBLIC_TEXT_PAGE_CACHE = new Map<string, Promise<{ url: string; html: string } | null>>();
const CRM_NAME_EVIDENCE_BUNDLE_LOG: CrmNameEvidenceBundle[] = [];
const CRM_NAME_EVIDENCE_CACHE = new Map<string, CrmNameEvidenceBundle>();

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function evidence(input: CrmNameResolutionInput): Required<CrmQualitySourceEvidence> {
  return {
    source_channel: input.source?.source_channel || 'unknown',
    source_record_id: input.source?.source_record_id || 'unknown',
    source_text: input.source?.source_text || input.rawName || input.currentName || 'unknown',
    codepath: input.source?.codepath || 'unknown',
    evidence_level: input.source?.evidence_level || 'unknown',
  };
}

function evidenceCacheKey(input: BuildCrmNameEvidenceBundleInput, includeNetwork: boolean): string {
  return [
    includeNetwork ? 'network' : 'local',
    input.entityType,
    clean(input.orgId),
    clean(input.entityId),
    normalizeDomain(input.email || input.domain || input.website || ''),
    normalizeToken(input.rawName || input.currentName || ''),
  ].join('|');
}

export function resetCrmNameEvidenceBundleLog(): void {
  CRM_NAME_EVIDENCE_BUNDLE_LOG.length = 0;
}

export function getCrmNameEvidenceBundleLog(): CrmNameEvidenceBundle[] {
  return CRM_NAME_EVIDENCE_BUNDLE_LOG.map(bundle => ({
    ...bundle,
    candidates: bundle.candidates.map(candidate => ({ ...candidate })),
    builder_diagnostics: (bundle.builder_diagnostics || []).map(diagnostic => ({ ...diagnostic })),
  }));
}

function addEvidenceCandidate(
  candidates: CrmNameEvidenceCandidate[],
  candidate: Omit<CrmNameEvidenceCandidate, 'value'> & { value?: string | null }
): void {
  const value = clean(candidate.value);
  if (!value) return;
  const key = `${candidate.entity_type}:${candidate.candidate_kind}:${candidate.source_type}:${normalizeToken(value)}`;
  if (candidates.some(existing => `${existing.entity_type}:${existing.candidate_kind}:${existing.source_type}:${normalizeToken(existing.value)}` === key)) return;
  candidates.push({
    ...candidate,
    value,
  });
}

function evidenceConfidenceFromCount(count: unknown): 'strong' | 'medium' | 'weak' {
  const n = Number(count || 0);
  if (n >= 3) return 'strong';
  if (n >= 1) return 'medium';
  return 'weak';
}

function existingEntityConfidence(row: Record<string, any> | null | undefined): 'strong' | 'medium' | 'weak' {
  if (!row) return 'weak';
  const activity = Number(row.conversation_count || 0) + Number(row.event_count || 0) + Number(row.document_count || 0) + Number(row.deal_count || 0);
  if (activity >= 3) return 'strong';
  if (activity >= 1) return 'medium';
  if (clean(row.linkedin_url)) return 'medium';
  return 'weak';
}

function companyEvidenceConfidence(row: Record<string, any> | null | undefined): 'strong' | 'medium' | 'weak' {
  if (!row) return 'weak';
  const name = clean(row.name);
  const activity = Number(row.linked_contact_count || 0) + Number(row.conversation_count || 0) + Number(row.event_count || 0) + Number(row.document_count || 0) + Number(row.deal_count || 0);
  if (/\b(inc|llc|ltd|corp|corporation|public company limited|commercial bank|capital|ventures|partners|investors|interiors)\b/i.test(name)) return 'strong';
  if (activity >= 2) return 'strong';
  if (activity >= 1) return 'medium';
  return 'weak';
}

function linkedInSlugCandidate(url: string | null | undefined): string | null {
  const raw = clean(url);
  if (!raw) return null;
  const match = raw.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match) return null;
  const slug = decodeURIComponent(match[1] || '').replace(/[-_]+/g, ' ').replace(/\d+/g, ' ').trim();
  if (!slug) return null;
  const compact = normalizeToken(slug);
  for (const given of KNOWN_GIVEN_NAME_LOCALS) {
    if (compact.endsWith(given) && compact.length > given.length + 2) {
      return titleCase(`${given} ${compact.slice(0, -given.length)}`);
    }
  }
  const pieces = slug.split(/\s+/).filter(Boolean);
  if (pieces.length >= 2 && pieces.length <= 4) return titleCase(pieces.join(' '));
  return null;
}

function firstNameDomainCandidate(email: string | null | undefined, domainHint?: string | null): string | null {
  const emailValue = clean(email);
  const first = knownGivenNameFromLocal(localPart(emailValue));
  if (!first) return null;
  const domain = normalizeDomain(domainHint || emailDomain(emailValue));
  if (!domain || isAutomatedDomain(domain) || isInvalidPublicSuffixLike(domain)) return null;
  const stem = domain.split('.')[0] || '';
  const tld = domain.split('.').pop() || '';
  if (!/^[a-z]{4,18}$/i.test(stem)) return null;
  if (!['llc', 'mc', 'us'].includes(tld)) return null;
  if (DOMAIN_WORDS.some(word => stem.includes(word))) return null;
  if (['com', 'org', 'net', 'edu', 'vc', 'co'].includes(tld) && stem.length > 10) return null;
  if (normalizeToken(first) === normalizeToken(stem)) return null;
  return titleCase(`${first} ${stem}`);
}

async function allD1<T>(env: Env | undefined, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    if (!env?.D1) return [];
    const result = await env.D1.prepare(sql).bind(...binds).all<T>();
    return result.results || [];
  } catch {
    return [];
  }
}

async function firstD1<T>(env: Env | undefined, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    if (!env?.D1) return null;
    return await env.D1.prepare(sql).bind(...binds).first<T>();
  } catch {
    return null;
  }
}

async function readR2TextExcerpt(env: Env | undefined, key: string | null | undefined, maxChars = 5000): Promise<string> {
  try {
    const cleanKey = clean(key);
    if (!env?.R2 || !cleanKey) return '';
    const object = await env.R2.get(cleanKey);
    if (!object) return '';
    const text = await object.text();
    return clean(text).slice(0, maxChars);
  } catch {
    return '';
  }
}

function builderDiagnostic(
  builder: string,
  started: number,
  beforeCount: number,
  afterCount: number,
  args: { skippedReason?: string | null; networkCalls?: number; cacheHits?: number } = {}
): CrmNameEvidenceBuilderDiagnostic {
  return {
    builder,
    candidate_count: Math.max(0, afterCount - beforeCount),
    skipped_reason: args.skippedReason || null,
    budget_spent_ms: Date.now() - started,
    network_calls: args.networkCalls || 0,
    cache_hits: args.cacheHits || 0,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function decodeEscapedUnicode(value: string): string {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => {
    const codePoint = Number.parseInt(hex, 16);
    return Number.isFinite(codePoint) ? String.fromCharCode(codePoint) : _;
  });
}

function decodeMetadataText(value: string): string {
  return decodeHtmlEntities(decodeEscapedUnicode(value)).replace(/\u00a0/g, ' ');
}

function titleCase(value: string): string {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(' ')
    .map(word => {
      const knownAcronym = word.replace(/\./g, '').toUpperCase();
      if (KNOWN_COMPANY_ACRONYMS.has(knownAcronym)) return knownAcronym;
      if (/^(ai|iq|vc)$/i.test(word)) return word.toUpperCase();
      if (/^(?:[A-Z]\.){2,}$/i.test(word)) return word.toUpperCase();
      if (/^[A-Z]{2,}\.[a-z0-9]{2,}$/i.test(word) || /^[a-z0-9]+\.[a-z0-9]+$/i.test(word)) return word;
      if (/^[A-Z]-[A-Za-z][A-Za-z0-9]*$/.test(word)) return `${word.slice(0, 2)}${titleCase(word.slice(2))}`;
      if (/^[A-Z0-9&]{2,6}$/.test(word) && (word.length <= 3 || /[0-9&]/.test(word) || KNOWN_COMPANY_ACRONYMS.has(word))) return word;
      if (/^[A-Z]\.$/.test(word)) return word;
      if (/^mc[a-z]/i.test(word)) {
        const rest = word.slice(2);
        return `Mc${rest.charAt(0).toUpperCase()}${rest.slice(1).toLowerCase()}`;
      }
      if (/^[a-z]?[A-Z][A-Za-z0-9]*$/.test(word) && /[a-z]/.test(word) && /[A-Z].*[A-Z]/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function normalizeDomain(raw: string | null | undefined): string {
  return lower(raw)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function domainFromInput(input: CrmNameResolutionInput): string {
  return normalizeDomain(input.domain || input.website || clean(input.email).split('@')[1] || '');
}

function localPart(email: string | null | undefined): string {
  const e = lower(email);
  const at = e.indexOf('@');
  return at > 0 ? e.slice(0, at) : '';
}

function normalizeToken(value: string): string {
  return lower(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function isAutomatedDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  return Boolean(d && (AUTOMATED_DOMAINS.has(d) || [...AUTOMATED_DOMAINS].some(blocked => d.endsWith(`.${blocked}`))));
}

function isInvalidPublicSuffixLike(domain: string): boolean {
  return /^(co|com|org|net|edu|gov)\.[a-z]{2}$/i.test(normalizeDomain(domain));
}

function looksLikeDomain(value: string): boolean {
  const v = normalizeDomain(value);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) && /\.[a-z]{2,}$/i.test(v);
}

function stripCompanyDecorators(value: string): string {
  return clean(decodeMetadataText(value))
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCompactCompanyIndicatorWords(value: string): string {
  return value
    .replace(/\b([A-Za-z]{2,})(Capital|Partners|Holdings|Investments|Investment|Healthcare|Technologies|Technology|Ventures|Advisors|Management|Securities|Futures|Labs|Systems|Fund|Funds)\b/g, '$1 $2')
    .replace(/\b(Impact|Growth|Private|Health|Energy|Financial|Snapper|First|Enclave)(Capital|Partners|Holdings|Investments|Investment|Healthcare|Technologies|Technology|Ventures|Advisors|Management|Securities|Futures|Labs|Systems|Fund|Funds|Creek|Serve|Semi|Guide)\b/g, '$1 $2');
}

function normalizeCompanyName(value: string): string {
  const decorated = stripCompanyDecorators(value);
  const latinParenthetical = /[\u3040-\u30ff\u3400-\u9fff]/.test(decorated)
    ? (decorated.match(/[（(]([^）)]*[A-Za-z][^）)]*)[）)]/) || [])[1]
    : '';
  const raw = splitCompactCompanyIndicatorWords(stripCompanyDecorators(latinParenthetical || decorated))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/株式会社/g, ' Inc.')
    .replace(/\s*,\s*inc\.{2,}$/i, ' Inc.')
    .replace(/\s*,?\s*Inc\.?$/i, latinParenthetical ? '' : '$&')
    .replace(/^i[-\s]+(.+?),?\s*inc\.{1,}$/i, '$1')
    .replace(/^i[-\s]+(?=[a-z])/i, '')
    .replace(/\s*,?\s*LLC\.?$/i, '')
    .replace(/\bS\.?\s*G\.?\s*R\.?/gi, 'SGR')
    .replace(/\bS\.?\s*P\.?\s*A\.?/gi, 'SpA')
    .replace(/\bPublic Company Limited\b\.?/gi, '')
    .replace(/\s*\([^)]{2,80}\)\s*$/g, '')
    .replace(COMPANY_SUFFIX_RE, match => match)
    .replace(/\s+/g, ' ')
    .trim();
  return titleCase(raw)
    .replace(/\bSgr\.?\b/gi, 'SGR')
    .replace(/\bSpa\.?\b/g, 'SpA')
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bFor\b/g, 'for');
}

function pageTitleCandidate(value: string): string | null {
  const cleaned = stripCompanyDecorators(value);
  if (looksLikeDomain(cleaned)) return null;

  const officialSite = cleaned.match(/^(?:official\s+(?:site|website)\s+(?:of|for)\s+)(.+)$/i);
  if (officialSite) {
    const officialCandidate = clean(officialSite[1]);
    return officialCandidate && !metadataRejected(officialCandidate) ? normalizeCompanyName(officialCandidate) : null;
  }

  const welcome = cleaned.match(/^welcome\s+to\s+(.+)$/i);
  if (welcome) {
    const welcomeCandidate = clean(welcome[1]);
    return welcomeCandidate && !metadataRejected(welcomeCandidate) ? normalizeCompanyName(welcomeCandidate) : null;
  }

  const declarativeBrand = cleaned.match(/^([A-Za-z0-9&.'.-]{2,60})\s+(?:is|are)\s+(?:the|a|an)\b/i);
  if (declarativeBrand) {
    const declarativeCandidate = clean(declarativeBrand[1]);
    return declarativeCandidate && !metadataRejected(declarativeCandidate) ? normalizeCompanyName(declarativeCandidate) : null;
  }

  if (!TITLE_SEPARATOR_RE.test(cleaned) && !PAGE_TITLE_BOILERPLATE_RE.test(cleaned)) return null;
  if (PAGE_TITLE_BOILERPLATE_RE.test(cleaned) && !TITLE_SEPARATOR_RE.test(cleaned)) return null;
  const parts = cleaned
    .split(TITLE_SEPARATOR_RE)
    .map(part => clean(part))
    .filter(Boolean);
  const nonBoilerplate = parts.filter(part => !PAGE_TITLE_BOILERPLATE_RE.test(part) && !metadataRejected(part));
  const first = nonBoilerplate[0] || parts[0];
  const last = nonBoilerplate[nonBoilerplate.length - 1] || parts[parts.length - 1];
  const lastTokenCount = (last.match(/[A-Za-z0-9&]+/g) || []).length;
  const firstTokenCount = (first.match(/[A-Za-z0-9&]+/g) || []).length;
  const firstLooksLikeBrand = COMPANY_INDICATOR_RE.test(first) && firstTokenCount <= 4;
  const firstLooksDescriptive = firstTokenCount >= 5 || /\b(advisory|clarifying|developers?|funding|for|inversiones|financiamiento|insurance\s+agency|public\s+sector|resilient\s+founders|single-family\s+office|solution|solutions|service|services|platform|software|team|teams|extension|nearshore|network)\b/i.test(first);
  const firstLooksConciseBrand = firstTokenCount > 0 && firstTokenCount <= 4 && !PAGE_TITLE_BOILERPLATE_RE.test(first);
  const lastLooksDescriptive = lastTokenCount >= 5 || /\b(advisory|clarifying|developers?|funding|for|inversiones|financiamiento|insurance\s+agency|public\s+sector|resilient\s+founders|single-family\s+office|solution|solutions|service|services|platform|software|team|teams|extension|nearshore|productivity|humans|brighter together|intelligent computing|computing everywhere)\b/i.test(last);
  const lastLooksConciseBrand = lastTokenCount > 0 && lastTokenCount <= 4 && !PAGE_TITLE_BOILERPLATE_RE.test(last);
  const chosen = firstLooksConciseBrand && lastLooksDescriptive
    ? first
    : lastLooksConciseBrand && firstLooksDescriptive
    ? last
    : firstLooksLikeBrand && firstTokenCount >= 2
    ? first
    : last;
  if (!chosen || PAGE_TITLE_BOILERPLATE_RE.test(chosen) || metadataRejected(chosen)) return null;
  return normalizeCompanyName(chosen);
}

function pageTitleHasCompetingNameBeforeSelection(value: string, selectedName: string): boolean {
  const cleaned = stripCompanyDecorators(value);
  const selectedCompact = normalizedCompact(selectedName);
  if (!selectedCompact || !TITLE_SEPARATOR_RE.test(cleaned)) return false;

  const parts = cleaned
    .split(TITLE_SEPARATOR_RE)
    .map(part => clean(part))
    .filter(Boolean)
    .filter(part => !PAGE_TITLE_BOILERPLATE_RE.test(part) && !metadataRejected(part));
  const normalizedParts = parts
    .map(part => normalizeCompanyName(part))
    .filter(Boolean);
  const selectedIndex = normalizedParts.findIndex(part => normalizedCompact(part) === selectedCompact);
  if (selectedIndex <= 0) return false;

  return normalizedParts.slice(0, selectedIndex).some(part => {
    const compact = normalizedCompact(part);
    if (!compact || compact === selectedCompact || selectedCompact.includes(compact) || compact.includes(selectedCompact)) return false;
    const tokenCount = (part.match(/[A-Za-z0-9&+.-]+/g) || []).length;
    if (tokenCount < 2 || tokenCount > 7) return false;
    if (/\b(for|solution|solutions|service|services|software|platform|team|teams|home|about|contact|austin|texas|tx)\b/i.test(part)) return false;
    return COMPANY_INDICATOR_RE.test(part)
      || /\b(accelerator|agency|institute|research|development|laborator(?:y|ies)|labs?)\b/i.test(part)
      || /[+&]/.test(part);
  });
}

function pageTitleSelectionFollowsDescriptor(value: string, selectedName: string): boolean {
  const cleaned = stripCompanyDecorators(value);
  const selectedCompact = normalizedCompact(selectedName);
  if (!selectedCompact || !TITLE_SEPARATOR_RE.test(cleaned)) return false;
  const parts = cleaned
    .split(TITLE_SEPARATOR_RE)
    .map(part => clean(part))
    .filter(Boolean);
  const normalizedParts = parts.map(part => normalizeCompanyName(part));
  const selectedIndex = normalizedParts.findIndex(part => normalizedCompact(part) === selectedCompact);
  if (selectedIndex <= 0) return false;
  return parts.slice(0, selectedIndex).every(part => {
    const tokenCount = (part.match(/[A-Za-z0-9&'.-]+/g) || []).length;
    return COMPANY_DESCRIPTOR_RE.test(part)
      || tokenCount >= 4
      || /\b(advisory|clarifying|developers?|funding|for|insurance\s+agency|public\s+sector|supporting)\b/i.test(part);
  });
}

function companyStringLooksLikeCompetingIdentity(value: string, selectedName: string): boolean {
  const normalized = normalizeCompanyName(stripCompanyDecorators(value));
  const selectedCompact = normalizedCompact(selectedName);
  const compact = normalizedCompact(normalized);
  if (!normalized || !selectedCompact || !compact) return false;
  if (looksLikeDomain(value) || PAGE_TITLE_BOILERPLATE_RE.test(normalized) || metadataRejected(normalized)) return false;
  if (compact === selectedCompact || compact.includes(selectedCompact) || selectedCompact.includes(compact)) return false;
  const tokenCount = (normalized.match(/[A-Za-z0-9&+.-]+/g) || []).length;
  if (tokenCount < 2 || tokenCount > 7) return false;
  return COMPANY_INDICATOR_RE.test(normalized)
    || /\b(accelerator|agency|institute|research|development|laborator(?:y|ies)|labs?)\b/i.test(normalized)
    || /[+&]/.test(normalized);
}

function pageTitleDomainFusionCandidate(value: string, domain: string): string | null {
  const domainBrand = domainBrandCandidate(domain);
  const cleaned = stripCompanyDecorators(value);
  if (!domainBrand || !TITLE_SEPARATOR_RE.test(cleaned)) return null;
  const parts = cleaned
    .split(TITLE_SEPARATOR_RE)
    .map(part => clean(part))
    .filter(Boolean);
  if (parts.length < 2) return null;
  const first = normalizeCompanyName(parts[0]);
  const tail = normalizeCompanyName(parts.slice(1).join(' - '));
  if (!first || !tail || metadataRejected(first) || metadataRejected(tail)) return null;
  const firstCompact = normalizedCompact(first);
  const tailCompact = normalizedCompact(tail);
  const domainCompact = normalizedCompact(domainBrand);
  if (!firstCompact || !domainCompact || firstCompact === domainCompact) return null;
  if (tailCompact && (firstCompact === tailCompact || firstCompact.includes(tailCompact) || tailCompact.includes(firstCompact))) return null;
  if (!domainCompact.startsWith(firstCompact) || !COMPANY_INDICATOR_RE.test(domainBrand)) return null;
  const tailTokenCount = (tail.match(/[A-Za-z0-9&'.-]+/g) || []).length;
  if (tailTokenCount < 2 || tailTokenCount > 6) return null;
  return `${domainBrand} - ${tail}`;
}

function pageTitleDomainSegmentCandidate(value: string, domain: string): string | null {
  const domainBrand = domainBrandCandidate(domain);
  const cleaned = stripCompanyDecorators(value);
  if (!domainBrand || !TITLE_SEPARATOR_RE.test(cleaned)) return null;
  const domainCompact = normalizedCompact(domainBrand);
  if (!domainCompact) return null;
  const parts = cleaned
    .split(TITLE_SEPARATOR_RE)
    .map(part => clean(part))
    .filter(Boolean);
  for (const part of parts) {
    const normalized = normalizeCompanyName(part);
    if (!normalized || metadataRejected(normalized)) continue;
    const compact = normalizedCompact(normalized);
    if (compact && compact === domainCompact) {
      const shortAcronymLikeSegment = compact.length <= 5 && companyNameTokenCount(normalized) <= 1;
      const fullerBrandPart = parts
        .map(otherPart => normalizeCompanyName(otherPart))
        .find(other => other && normalizedCompact(other) !== compact && companyNameTokenCount(other) >= 2 && COMPANY_INDICATOR_RE.test(other));
      if (shortAcronymLikeSegment && fullerBrandPart) return null;
      return normalized;
    }
  }
  return null;
}

const DOMAIN_WORDS = [
  'ventures',
  'venture',
  'capital',
  'partners',
  'partner',
  'advisors',
  'advisor',
  'investors',
  'investor',
  'invest',
  'investments',
  'investment',
  'holdings',
  'holding',
  'healthcare',
  'technologies',
  'technology',
  'funds',
  'fund',
  'equity',
  'wealth',
  'health',
  'space',
  'orchid',
  'lambda',
  'rail',
  'leap',
  'light',
  'labs',
  'lab',
  'private',
  'serve',
  'curve',
  'semi',
  'energy',
  'wireless',
  'financial',
  'guide',
  'snapper',
  'creek',
  'futures',
  'future',
  'grupo',
  'coen',
  'ai',
  'aif',
  'mbf',
  'ev',
  'iq',
  'bank',
  'commercial',
  'network',
  'university',
  'group',
  'systems',
  'planet',
  'spheres',
  'sphere',
  'sequential',
  'connect',
  'ocean',
  'azul',
  'norges',
  'moises',
  'cosio',
  'street',
  'family',
  'office',
  'management',
  'interiors',
  'kendall',
  'south',
  'forum',
  'valley',
  'hill',
  'heat',
  'mass',
  'nest',
  'physicians',
  'miami',
  'mutual',
  'cx',
].sort((a, b) => b.length - a.length);

const DOMAIN_SEGMENT_WORDS = [...new Set([
  'the',
  'and',
  ...DOMAIN_WORDS,
])].sort((a, b) => b.length - a.length);

function formatDomainStemBase(value: string): string {
  const leadingNumber = value.match(/^(\d+)([a-z]{2,})$/i);
  if (leadingNumber) return `${leadingNumber[1]} ${titleCase(leadingNumber[2])}`;
  const trailingNumber = value.match(/^([a-z]{2,})(\d+)$/i);
  if (trailingNumber) return `${titleCase(trailingNumber[1])} ${trailingNumber[2]}`;
  if (/^[a-z]+\d/i.test(value)) return value.toUpperCase();
  return titleCase(value);
}

function formatDomainWord(value: string): string {
  if (/^(and)$/i.test(value)) return 'and';
  if (/^(cx)$/i.test(value)) return value.toUpperCase();
  return titleCase(value);
}

function segmentDomainStem(value: string): string[] {
  const lowerStem = lower(value).replace(/[^a-z0-9]/g, '');
  const memo = new Map<number, string[] | null>();
  function walk(index: number): string[] | null {
    if (index === lowerStem.length) return [];
    if (memo.has(index)) return memo.get(index) || null;
    for (const word of DOMAIN_SEGMENT_WORDS) {
      if (!lowerStem.startsWith(word, index)) continue;
      const rest = walk(index + word.length);
      if (rest) {
        const out = [word, ...rest];
        memo.set(index, out);
        return out;
      }
    }
    memo.set(index, null);
    return null;
  }
  const segmented = walk(0) || [];
  return segmented.length >= 2 ? segmented : [];
}

function domainBrandCandidate(domain: string): string | null {
  const normalized = normalizeDomain(domain);
  if (!normalized || isAutomatedDomain(normalized) || isInvalidPublicSuffixLike(normalized)) return null;
  const stem = normalized.split('.')[0];
  const tld = normalized.split('.').pop() || '';
  if (!stem || stem.length < 2) return null;
  if (stem.includes('-')) {
    const pieces = stem.split('-').filter(Boolean);
    if (pieces[0] === 'i' && pieces.length === 2) {
      const nested = domainBrandCandidate(`${pieces[1]}.${tld || 'com'}`);
      if (nested) return nested;
    }
    const compactHyphenLength = pieces.join('').length;
    if (
      pieces.length >= 2
      && pieces.length <= 4
      && pieces.every(piece => /^[a-z0-9]{1,24}$/i.test(piece))
      && (pieces[0].length === 1 || compactHyphenLength <= 18)
    ) {
      const separator = pieces[0].length === 1 ? '-' : ' ';
      return pieces.map(formatDomainWord).join(separator);
    }
    return null;
  }
  if (/^[a-z]{2,3}$/.test(stem) && ['me', 'io'].includes(tld)) return `${stem.toUpperCase()}.${tld}`;
  if (
    tld === 'io'
    && /^[a-z][a-z0-9]{3,20}$/i.test(stem)
    && !segmentDomainStem(stem).length
    && !DOMAIN_WORDS.some(word => stem.endsWith(word) && stem.length > word.length)
  ) {
    return `${titleCase(stem)}.io`;
  }
  if (/^[a-z]{2,4}$/i.test(stem)) return stem.toUpperCase();
  const leadingNumber = stem.match(/^(\d+)([a-z]{2,})$/i);
  if (leadingNumber) {
    const segmentedTail = segmentDomainStem(leadingNumber[2]);
    return [leadingNumber[1], ...(segmentedTail.length ? segmentedTail : [leadingNumber[2]]).map(formatDomainWord)].join(' ');
  }
  const trailingNumber = stem.match(/^([a-z]{2,})(\d+)$/i);
  if (trailingNumber) {
    const segmentedHead = segmentDomainStem(trailingNumber[1]);
    return [...(segmentedHead.length ? segmentedHead : [trailingNumber[1]]).map(formatDomainWord), trailingNumber[2]].join(' ');
  }
  const santaPrefix = stem.match(/^(santa)([a-z]{3,})$/i);
  if (santaPrefix) return `Santa ${titleCase(santaPrefix[2])}`;
  const grupoPrefix = stem.match(/^(grupo)([a-z]{3,})$/i);
  if (grupoPrefix) return `Grupo ${titleCase(grupoPrefix[2])}`;
  const compactSuffix = stem.match(/^([a-z]{2,})(inc|llc|ltd|corp|co|cap)$/i);
  if (compactSuffix) {
    const prefix = compactSuffix[1].length <= 4 ? compactSuffix[1].toUpperCase() : titleCase(compactSuffix[1]);
    const suffix = compactSuffix[2].toLowerCase() === 'cap' ? 'Capital' : titleCase(compactSuffix[2]);
    return `${prefix} ${suffix}`;
  }
  const equityPartnersAbbrev = stem.match(/^([a-z]{4,})ep$/i);
  if (equityPartnersAbbrev) return `${formatDomainStemBase(equityPartnersAbbrev[1])} Equity Partners`;
  const capitalPartnersAbbrev = stem.match(/^([a-z]{4,})cp$/i);
  if (capitalPartnersAbbrev) return `${formatDomainStemBase(capitalPartnersAbbrev[1])} Capital Partners`;
  const investorAbbrev = stem.match(/^([a-z0-9]{3,})inv$/i);
  if (investorAbbrev) return `${formatDomainStemBase(investorAbbrev[1])} Investors`;
  const segmented = segmentDomainStem(stem);
  if (segmented.length >= 2) {
    return segmented.map(formatDomainWord).join(' ');
  }
  const suffixes: string[] = [];
  let rest = stem;
  while (rest) {
    const word = DOMAIN_WORDS.find(item => rest.endsWith(item) && rest.length > item.length);
    if (!word) break;
    suffixes.unshift(word);
    rest = rest.slice(0, -word.length);
  }
  const pieces = [rest ? formatDomainStemBase(rest) : '', ...suffixes.map(formatDomainWord)].filter(Boolean);
  return titleCase(pieces.join(' '));
}

function splitCompoundCompanies(value: string): string[] {
  const raw = stripCompanyDecorators(value);
  if (raw.includes('/')) {
    return raw.split('/').map(part => normalizeCompoundCompanyPart(part)).filter(Boolean);
  }
  const andMatch = raw.match(/^(.+?)\s+(?:and|&)\s+(.+)$/i);
  if (andMatch && /\b(inc|bank|capital|corp|corporation|ventures|partners|crystals|securities|community|health)\b/i.test(raw)) {
    return [normalizeCompanyName(andMatch[1]), normalizeCompanyName(andMatch[2])].filter(Boolean);
  }
  const parenthetical = raw.match(/^(.+?)\s+\(([^)]+)\)$/);
  if (parenthetical && /\b(bank|capital|commercial|ventures|partners|group|corp|corporation)\b/i.test(raw)) {
    return [normalizeCompanyName(parenthetical[1])].filter(Boolean);
  }
  return [];
}

function splitCompoundCompany(value: string): string | null {
  return splitCompoundCompanies(value)[0] || null;
}

function normalizeCompoundCompanyPart(value: string): string {
  const raw = stripCompanyDecorators(value);
  const acronym = (raw.match(/\(([A-Z0-9&.-]{2,12})\)\s*$/) || [])[1];
  const withoutAcronym = acronym ? raw.replace(/\s*\([^)]+\)\s*$/, '') : raw;
  const normalized = normalizeCompanyName(withoutAcronym);
  return acronym ? `${normalized} (${acronym})` : normalized;
}

function domainPlaceholderName(domain: string): string {
  return normalizeDomain(domain);
}

function personTokens(value: string): string[] {
  return clean(value).match(/[A-Za-z][A-Za-z'.-]*/g) || [];
}

function contactNameLooksUseful(value: string, allowSingleToken: boolean): boolean {
  const name = clean(value);
  if (!name || /^\S+@\S+\.\S+$/.test(name) || looksLikeDomain(name)) return false;
  if (SERVICE_SUFFIX_RE.test(name)) return false;
  if (/\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(name)) return false;
  if (/[|:]|upcoming events|mail delivery subsystem|mailer-daemon|postmaster|calendar notification/i.test(name)) return false;
  if (/^(qualified|wordpress|vimeo|wix studio|read ai)$/i.test(name)) return false;
  if (/\b(inc|llc|corp|corporation|company|capital|ventures|partners|studio|group|office|systems|fund)\b\.?/i.test(name)) return false;
  const tokens = personTokens(name);
  const substantive = tokens.filter(token => token.replace(/\./g, '').length >= 2);
  if (substantive.length >= 2) return true;
  if (allowSingleToken && substantive.length === 1 && name.length >= 3 && !AUTOMATED_LOCAL_NAMES.has(lower(name))) return true;
  return /^[A-Z]\.\s+[A-Z][A-Za-z'.-]{2,}$/.test(name);
}

function contactNameIsFullPerson(value: string): boolean {
  const tokens = personTokens(value).filter(token => token.replace(/\./g, '').length >= 2);
  return tokens.length >= 2 && !/^[A-Z]\.\s+/i.test(clean(value));
}

function stripContactContext(value: string): string {
  return clean(value)
    .replace(SERVICE_SUFFIX_RE, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\/]/g, ' ')
    .replace(CONTACT_CONTEXT_RE, ' ')
    .replace(/\bR[&-]?E\b/gi, ' ')
    .replace(/\bEOP\b|\bOSTP\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function directoryContactCandidate(value: string): string | null {
  const raw = clean(value);
  const preferred = (raw.match(/\(([^)]{2,40})\)/) || [])[1];
  const withoutContext = stripContactContext(raw);
  const match = withoutContext.match(/^([^,]{2,}),\s*([^,]{2,})(?:\s+(.+))?$/);
  if (!match) return null;
  const last = clean(match[1]);
  const firstRest = clean(`${match[2]} ${match[3] || ''}`);
  const rawFirstParts = firstRest.split(/\s+/).filter(Boolean);
  const dropMiddleInitialContext = /\b(ses|civ|eop|ostp|ousd)\b/i.test(raw);
  const keepMiddleInitial = !dropMiddleInitialContext && rawFirstParts.length === 2 && /^[A-Z]\.?$/i.test(rawFirstParts[1]);
  const firstParts = keepMiddleInitial
    ? rawFirstParts
    : rawFirstParts.filter(part => !/^[A-Z]\.?$/i.test(part));
  const preferredClean = preferred
    && /^[A-Za-z]{2,30}$/.test(preferred)
    && !/^(usa|citd|hq|osd|ousd|contr|contractor|ctr|civ|ret|retired)$/i.test(preferred)
    ? clean(preferred)
    : '';
  const parts = preferredClean
    ? [preferredClean, ...firstParts.filter(part => normalizeToken(part) !== normalizeToken(preferredClean)), last]
    : [...firstParts, last];
  const candidate = titleCase(parts.filter(Boolean).join(' '));
  return contactNameLooksUseful(candidate, false) ? candidate : null;
}

function isPersonLikeSingleLocal(value: string): boolean {
  return /^[a-z]{3,12}$/i.test(value)
    && /[aeiouy]/i.test(value)
    && !AUTOMATED_LOCAL_NAMES.has(lower(value));
}

function knownGivenNameFromLocal(value: string): string | null {
  const local = lower(value).replace(/[^a-z]+/g, '');
  if (KNOWN_GIVEN_NAME_LOCALS.has(local)) return titleCase(local);
  const trailingInitial = local.match(/^([a-z]{3,})([a-z])$/);
  if (trailingInitial && KNOWN_GIVEN_NAME_LOCALS.has(trailingInitial[1])) {
    return titleCase(trailingInitial[1]);
  }
  return null;
}

function localPartContactCandidate(
  email: string | null | undefined,
  rawName?: string | null,
  options: { preferSingleToken?: boolean } = {}
): string | null {
  const raw = clean(rawName);
  const local = localPart(email) || (raw.includes('@') ? localPart(raw) : raw);
  const normalizedLocal = lower(local).replace(/[^a-z0-9._-]+/g, '');
  if (!normalizedLocal || AUTOMATED_LOCAL_NAMES.has(normalizedLocal.replace(/[._-]+/g, ''))) return null;
  if (/\d{2,}/.test(normalizedLocal)) return null;

  const pieces = normalizedLocal.split(/[._-]+/).filter(Boolean);
  if (pieces.length >= 2) {
    const rendered = pieces
      .map((piece, index) => piece.length === 1 && index === 0 ? `${piece.toUpperCase()}.` : titleCase(piece))
      .join(' ');
    return contactNameLooksUseful(rendered, false) ? rendered : null;
  }

  const rawLooksLikeOnlyThisLocal = normalizeToken(raw) === normalizeToken(normalizedLocal)
    || (raw.includes('@') && normalizeToken(localPart(raw)) === normalizeToken(normalizedLocal));
  const knownGivenName = (options.preferSingleToken || rawLooksLikeOnlyThisLocal)
    ? knownGivenNameFromLocal(normalizedLocal)
    : null;
  if (knownGivenName) {
    return contactNameLooksUseful(knownGivenName, true) ? knownGivenName : null;
  }

  if (options.preferSingleToken && isPersonLikeSingleLocal(normalizedLocal)) {
    const single = titleCase(normalizedLocal);
    return contactNameLooksUseful(single, true) ? single : null;
  }

  const initialLast = normalizedLocal.match(/^([a-z])([a-z]{4,})$/);
  if (initialLast) {
    const rendered = `${initialLast[1].toUpperCase()}. ${titleCase(initialLast[2])}`;
    return contactNameLooksUseful(rendered, false) ? rendered : null;
  }

  const single = titleCase(normalizedLocal);
  return contactNameLooksUseful(single, true) ? single : null;
}

function displayContactCandidate(value: string, allowSingleToken: boolean): string | null {
  const withoutEmail = clean(value)
    .replace(/<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>/g, ' ')
    .replace(/\b\S+@\S+\.\S+\b/g, ' ');
  const stripped = stripContactContext(withoutEmail
    .replace(/\b([A-Za-z])\.([A-Za-z]{2,})\b/g, '$1. $2')
    .replace(/^([A-Za-z])\.\s+([A-Za-z]{2,})\s+/i, '$2 ')
    .replace(SERVICE_SUFFIX_RE, ''));
  if (!stripped || stripped.includes('@')) return null;
  const candidate = titleCase(stripped).replace(/\s+[A-Z]$/, '');
  return contactNameLooksUseful(candidate, allowSingleToken) ? candidate : null;
}

function serviceStrippedContactCandidate(value: string): string | null {
  const raw = clean(value);
  const stripped = raw.replace(SERVICE_SUFFIX_RE, '');
  if (stripped === raw) return null;
  return displayContactCandidate(stripped, false);
}

function localPartNameCorroboratedByDisplay(candidateName: string, emailLocal: string, displayInputs: string[]): boolean {
  if (!/[._-]/.test(emailLocal) || personTokens(candidateName).length < 2) return false;
  const candidateTokens = personTokens(candidateName).map(normalizeToken).filter(Boolean);
  const first = candidateTokens[0] || '';
  const last = candidateTokens[candidateTokens.length - 1] || '';
  if (!first || !last) return false;
  return displayInputs.some(input => {
    if (normalizeToken(input) === normalizeToken(emailLocal) || /@/.test(input)) return false;
    const rawDisplayTokens = personNameTokens(input).map(normalizeToken).filter(Boolean);
    const rawFirst = rawDisplayTokens[0] || '';
    const rawLast = rawDisplayTokens[rawDisplayTokens.length - 1] || '';
    if (rawFirst === first && rawLast.length === 1 && last.startsWith(rawLast)) return true;
    const display = displayContactCandidate(input, true);
    if (!display) return false;
    const displayTokens = personTokens(display).map(normalizeToken).filter(Boolean);
    if (displayTokens.length < 1) return false;
    const displayFirst = displayTokens[0] || '';
    const displayLast = displayTokens[displayTokens.length - 1] || '';
    return displayFirst === first && (displayLast === last || (displayLast.length === 1 && last.startsWith(displayLast)));
  });
}

function candidate(
  input: CrmNameResolutionInput,
  args: Omit<CrmNameCandidate, 'accepted' | 'sourceText'>
): CrmNameCandidate {
  return {
    ...args,
    sourceText: clean(input.source?.source_text || input.rawName || input.currentName || args.candidateName),
    accepted: false,
  };
}

function resolution(
  input: CrmNameResolutionInput,
  status: CrmNameResolutionStatus,
  args: {
    normalizedName?: string;
    confidence?: CrmQualityConfidence;
    ruleIds?: string[];
    reasons?: string[];
    candidates?: CrmNameCandidate[];
    splitNames?: string[];
  } = {}
): CrmNameResolutionResult {
  const selected = args.normalizedName;
  const candidates = (args.candidates || []).map(item => ({
    ...item,
    accepted: Boolean(selected && lower(item.normalizedName) === lower(selected)),
  }));
  const nameStatus: CrmQualityNameStatus | undefined = status === 'provisional' || status === 'domain_placeholder'
    ? status
    : status === 'verified'
      ? 'verified'
      : undefined;
  return {
    status,
    normalizedName: selected,
    nameStatus,
    confidence: args.confidence || (status === 'verified' ? 'high' : status === 'fail' ? 'low' : 'medium'),
    ruleIds: unique([CRM_QUALITY_RULES.WRITE_GATE, CRM_QUALITY_RULES.EVIDENCE_LEDGER, ...(args.ruleIds || [])]),
    reasons: args.reasons || [],
    candidates,
    splitNames: args.splitNames,
    evidence: evidence(input),
  };
}

function best(candidates: CrmNameCandidate[]): CrmNameCandidate | undefined {
  return [...candidates].sort((a, b) => b.score - a.score || confidenceScore(b.confidence) - confidenceScore(a.confidence))[0];
}

function selectedCandidate(result: CrmNameResolutionResult): CrmNameCandidate | undefined {
  return best(result.candidates.filter(item => item.accepted))
    || result.candidates.find(item => result.normalizedName && lower(item.normalizedName) === lower(result.normalizedName))
    || best(result.candidates);
}

function selectedScore(result: CrmNameResolutionResult): number {
  return selectedCandidate(result)?.score ?? 0;
}

function selectedReasonMatches(result: CrmNameResolutionResult, pattern: RegExp): boolean {
  const selected = selectedCandidate(result);
  return Boolean(selected && pattern.test(selected.reason));
}

function candidateEvidenceSource(candidate: CrmNameCandidate): CrmNameEvidenceSourceType | 'page_title' | 'domain_brand' | 'public_people_metadata' | 'unknown' {
  const reason = lower(candidate.reason);
  const evidenceMatch = candidate.reason.match(/^([a-z_]+) evidence candidate/i);
  const source = evidenceMatch?.[1] as CrmNameEvidenceSourceType | undefined;
  if (source) return source;
  if (/domain stem|domain retained|domain placeholder/i.test(candidate.reason)) return 'domain_brand';
  if (/page title|website metadata|metadata/i.test(candidate.reason)) return 'page_title';
  if (/domain-owned public people/i.test(candidate.reason)) return 'public_people_metadata';
  if (reason.includes('local-part')) return 'local_parser';
  return 'unknown';
}

function cleanSourceCompanyFallback(input: CrmNameResolutionInput): string | null {
  const domain = domainFromInput(input);
  const raw = clean(input.rawName || input.currentName || input.source?.source_text);
  if (!raw || looksLikeDomain(raw)) return null;
  const rawLetters = raw.replace(/[^A-Za-z0-9]+/g, '');
  const rawAllCapsBrand = rawLetters
    && rawLetters.length >= 2
    && rawLetters.length <= 12
    && rawLetters === rawLetters.toUpperCase()
    && !GENERIC_SINGLE_TOKEN_METADATA_RE.test(raw);
  if (rawAllCapsBrand) {
    const normalizedRaw = normalizeCompanyName(raw);
    if (normalizedRaw && !COMPANY_PAGE_ARTIFACT_RE.test(normalizedRaw)) return normalizedRaw;
  }
  const hasStructuralSeparator = TITLE_SEPARATOR_RE.test(raw) || raw.includes('/');
  const sourceParts = raw
    .split(TITLE_SEPARATOR_RE)
    .flatMap(part => part.split('/'))
    .map(part => clean(part))
    .filter(Boolean);
  const candidates = unique([
    ...sourceParts,
    ...(hasStructuralSeparator ? [] : [raw.replace(/\blogo\b/ig, ' ')]),
    ...(hasStructuralSeparator ? [] : [raw]),
  ])
    .map(value => normalizeCompanyName(value))
    .filter(value => value && sourceCompanyNameLooksUseful(value, domain))
    .filter(value => !COMPANY_PAGE_ARTIFACT_RE.test(value))
    .filter(value => !(COMPANY_DESCRIPTOR_RE.test(value) && !COMPANY_INDICATOR_RE.test(value)));
  return candidates[0] || null;
}

function compactMatchesOrOverlaps(a: string, b: string): boolean {
  const left = normalizedCompact(a);
  const right = normalizedCompact(b);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function sourceHasArtifactMetadata(input: CrmNameResolutionInput): boolean {
  const metadataValues = [
    ...(input.evidenceCandidates || [])
      .filter(candidate => candidate.entity_type === 'company')
      .filter(candidate => candidate.source_type === 'domain_metadata' || candidate.source_type === 'crm_neighbor')
      .map(candidate => candidate.value),
    ...parseMetadataNames(input.websiteMetadata),
  ];
  return metadataValues.some(value => {
    const normalized = normalizeCompanyName(value);
    return COMPANY_PAGE_ARTIFACT_RE.test(value)
      || COMPANY_PAGE_ARTIFACT_RE.test(normalized)
      || (COMPANY_DESCRIPTOR_RE.test(normalized) && !COMPANY_INDICATOR_RE.test(normalized));
  });
}

function sourceCompanyCandidateIsCleanButSingleSource(input: CrmNameResolutionInput, candidateItem: CrmNameCandidate): boolean {
  const sourceType = candidateEvidenceSource(candidateItem);
  if (sourceType !== 'source_payload' && sourceType !== 'unknown') return false;
  if (candidateItem.status !== 'verified') return false;
  if (!/clean source company name retained|company string normalized/i.test(candidateItem.reason)) return false;
  const tokenCount = companyNameTokenCount(candidateItem.normalizedName);
  return tokenCount <= 1 && sourceHasArtifactMetadata(input);
}

function companyCandidateLosesSourceSpacing(candidateName: string, cleanSource: string | null): boolean {
  if (!cleanSource) return false;
  const candidate = clean(candidateName);
  const source = clean(cleanSource);
  if (!candidate || !source || lower(candidate) === lower(source)) return false;
  if (normalizedCompact(candidate) !== normalizedCompact(source)) return false;
  return companyNameTokenCount(source) > companyNameTokenCount(candidate);
}

function companyCandidateDropsCleanSourceTail(candidateName: string, cleanSource: string | null): boolean {
  if (!cleanSource) return false;
  const candidateCompact = normalizedCompact(candidateName);
  const sourceCompact = normalizedCompact(cleanSource);
  if (!candidateCompact || !sourceCompact || candidateCompact === sourceCompact) return false;
  if (!sourceCompact.startsWith(candidateCompact)) return false;
  if (companyNameTokenCount(cleanSource) <= companyNameTokenCount(candidateName)) return false;
  const candidateTokens = new Set((candidateName.match(/[A-Za-z0-9]+/g) || []).map(token => normalizeToken(token)));
  const missingSourceTokens = (cleanSource.match(/[A-Za-z0-9]+/g) || [])
    .map(token => normalizeToken(token))
    .filter(token => token && !candidateTokens.has(token));
  return missingSourceTokens.some(token =>
    /^(advisors?|capital|company|co|corp|corporation|inc|ltd|llc|enterprises?|equity|foundation|funds?|group|holdings?|management|partners?|ventures?|board|development|bank)$/.test(token)
  );
}

function companyCandidateTruncatesDomainBrand(candidateName: string, domain: string): boolean {
  const stem = compactDomainStem(domain);
  const candidateCompact = normalizedCompact(candidateName);
  if (!stem || !candidateCompact || candidateCompact.length < 5) return false;
  if (candidateCompact === stem) return false;
  if (stem.startsWith(candidateCompact) && stem.length - candidateCompact.length >= 3) return true;
  if (candidateCompact.startsWith(stem) && candidateCompact.length - stem.length === 1) return true;
  return false;
}

function inputRawIsAllCapsBrand(input: CrmNameResolutionInput, candidateName: string): boolean {
  const raw = clean(input.rawName || input.currentName);
  if (!raw || !candidateName) return false;
  const letters = raw.replace(/[^A-Za-z0-9]+/g, '');
  if (!letters || letters.length > 12) return false;
  return letters === letters.toUpperCase() && normalizedCompact(raw) === normalizedCompact(candidateName);
}

function companyCandidateLooksCompressedToken(candidateName: string): boolean {
  const normalized = normalizeCompanyName(candidateName);
  const compact = normalizedCompact(normalized);
  if (!normalized || /\s/.test(normalized) || isAcronymCompanyName(normalized)) return false;
  if (compact.endsWith('com') && compact.length >= 8) return true;
  if (compact.length >= 6 && !/[aeiouy]/i.test(compact)) return true;
  if (compact.length >= 10 && EMBEDDED_COMPANY_WORD_RE.test(compact)) return true;
  return false;
}

function companyCandidateHasSuspiciousInternalCaps(candidateName: string): boolean {
  const commonWords = new Set([
    'space',
    'holding',
    'holdings',
    'capital',
    'partners',
    'group',
    'value',
    'recover',
    'create',
    'protect',
  ]);
  return clean(candidateName).split(/\s+/).some(word => {
    const letters = word.replace(/[^A-Za-z]/g, '');
    if (!letters || !/[a-z][A-Z][a-z]/.test(letters)) return false;
    if (/^[a-z][A-Z][a-z]+$/.test(letters)) return false; // iPhone-style brands
    if (/[A-Z]{2,}$/.test(letters)) return false; // OpenAI-style brands
    return commonWords.has(letters.toLowerCase());
  });
}

function companyCandidateSemanticContract(
  input: CrmNameResolutionInput,
  candidateItem: CrmNameCandidate
): CrmNameVerificationContract {
  const name = clean(candidateItem.normalizedName);
  const sourceType = candidateEvidenceSource(candidateItem);
  const domain = domainFromInput(input);
  const domainBrand = domainBrandCandidate(domain);
  const cleanSource = cleanSourceCompanyFallback(input);
  const riskFlags: CrmNameCandidateRiskFlag[] = [];
  const dottedBrand = /^[a-z0-9]+\.[a-z0-9]+$/i.test(name);
  const cleanSourceBlocksDottedBrand = Boolean(cleanSource && normalizedCompact(name) !== normalizedCompact(cleanSource));
  const rawHasExactDottedBrand = dottedBrand
    && lower(input.rawName || input.currentName || input.source?.source_text).includes(lower(name));
  const dottedBrandCanVerify = dottedBrand
    && !cleanSourceBlocksDottedBrand
    && candidateItem.status === 'verified'
    && (
      (sourceType === 'page_title' && rawHasExactDottedBrand)
      || (sourceType === 'domain_brand' && /\.(?:io|me)$/i.test(name))
    );
  const dottedBrandCanStayTentative = dottedBrand
    && !cleanSourceBlocksDottedBrand
    && candidateItem.status !== 'domain_placeholder'
    && !dottedBrandCanVerify;

  if (candidateItem.status === 'domain_placeholder' || (looksLikeDomain(name) && !dottedBrandCanVerify && !dottedBrandCanStayTentative)) {
    if (cleanSource && normalizedCompact(name) !== normalizedCompact(cleanSource)) {
      riskFlags.push('domain_placeholder_over_clean_source');
      return {
        semantic_class: 'wrong_entity_risk',
        risk_flags: riskFlags,
        verification_decision: 'reject',
        verification_block_reason: 'domain placeholder lost a clean source company name',
        status_before_firewall: candidateItem.status,
        status_after_firewall: 'fail',
      };
    }
    return {
      semantic_class: 'domain_placeholder',
      risk_flags: riskFlags,
      verification_decision: 'accept_domain_placeholder',
      status_before_firewall: candidateItem.status,
      status_after_firewall: 'domain_placeholder',
    };
  }

  if (dottedBrandCanStayTentative) {
    riskFlags.push('domain_stem_only');
    return {
      semantic_class: 'weak_name',
      risk_flags: riskFlags,
      verification_decision: candidateItem.status === 'verified' ? 'downgrade_provisional' : 'verify',
      verification_block_reason: 'dotted brand requires stronger corroboration before verification',
      status_before_firewall: candidateItem.status,
      status_after_firewall: 'provisional',
    };
  }

  if (COMPANY_PAGE_ARTIFACT_RE.test(name) || COMPANY_PAGE_ARTIFACT_RE.test(candidateItem.candidateName)) {
    if (/\blogo\b/i.test(name)) riskFlags.push('logo_artifact');
    else if (/\bindex\s+of\b/i.test(name)) riskFlags.push('directory_listing');
    else if (/\bmy\s*site\b/i.test(name)) riskFlags.push('template_artifact');
    else if (/\bback\s+to|contact\s+investment|why\s+choose|practice\s+solutions|join\b/i.test(name)) riskFlags.push('navigation_text');
    else if (/\bthank\s+you|subscrib/i.test(name)) riskFlags.push('page_artifact');
    else riskFlags.push('sentence_fragment');
  }
  if (/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2},?$/i.test(name)) {
    riskFlags.push('sentence_fragment');
  }
  if (companyCandidateHasSuspiciousInternalCaps(name)) {
    riskFlags.push('sentence_fragment');
  }
  if (/\band\b/i.test(name) && /\bholdings?\b/i.test(name) && companyNameTokenCount(name) >= 5) {
    riskFlags.push('wrong_entity_conflict');
  }
  const fusedPageTitleWithRetainedTagline = /retained tagline/i.test(candidateItem.reason);
  if (TITLE_SEPARATOR_RE.test(name) && sourceType !== 'source_payload' && !fusedPageTitleWithRetainedTagline) {
    riskFlags.push('page_artifact');
  }
  if (/\b(?:and|or|&)\s*$/i.test(name)) riskFlags.push('trailing_conjunction');
  const officialBrandPageCandidate = /^official\s+(?:site|website)\s+(?:of|for)\b/i.test(candidateItem.candidateName)
    && /page title stripped to brand segment/i.test(candidateItem.reason);
  if (
    HARD_COMPANY_DESCRIPTOR_RE.test(name)
    || (COMPANY_DESCRIPTOR_RE.test(name) && !COMPANY_INDICATOR_RE.test(name) && companyNameTokenCount(name) >= 2 && !officialBrandPageCandidate)
  ) {
    riskFlags.push('tagline_or_descriptor');
  }
  if (COMPANY_DESCRIPTOR_RE.test(name) && /[,|]\s*/.test(candidateItem.candidateName) && cleanSource && compactMatchesOrOverlaps(name, cleanSource)) {
    riskFlags.push('tagline_or_descriptor');
  }
  if (officialBrandPageCandidate) {
    const descriptorIndex = riskFlags.indexOf('tagline_or_descriptor' as CrmNameCandidateRiskFlag);
    if (descriptorIndex >= 0) riskFlags.splice(descriptorIndex, 1);
  }
  if (companyCandidateLosesSourceSpacing(name, cleanSource) || companyCandidateDropsCleanSourceTail(name, cleanSource)) {
    riskFlags.push('compressed_neighbor');
  }
  if (companyCandidateTruncatesDomainBrand(name, domain) && !inputRawIsAllCapsBrand(input, name)) {
    riskFlags.push('compressed_neighbor');
  }
  if (
    domainBrand
    && normalizedCompact(name).endsWith(normalizedCompact(domainBrand))
    && normalizedCompact(name) !== normalizedCompact(domainBrand)
    && /^(agricola|agricultural|agro)\s+/i.test(name)
  ) {
    riskFlags.push('tagline_or_descriptor');
  }
  if (
    (sourceType === 'crm_neighbor' || sourceType === 'existing_crm_entity' || sourceType === 'source_payload')
    && !/\s/.test(name)
    && !isAcronymCompanyName(name)
    && companyCandidateLooksCompressedToken(name)
  ) {
    riskFlags.push('compressed_neighbor');
  }

  const cleanSourceConflicts = cleanSource
    && !compactMatchesOrOverlaps(name, cleanSource)
    && !compactMatchesOrOverlaps(name, domainBrand || '');
  if (
    cleanSourceConflicts
    && (sourceType === 'domain_metadata' || sourceType === 'page_title' || sourceType === 'crm_neighbor')
    && !(sourceType === 'page_title' && pageTitleSelectionFollowsDescriptor(input.rawName || input.currentName || input.source?.source_text || candidateItem.candidateName, name))
  ) {
    riskFlags.push('wrong_entity_conflict');
  }

  const domainStemOnly = domain
    && plainDomainStemCandidate(name, domain, false)
    && !COMPANY_INDICATOR_RE.test(name)
    && !isAcronymCompanyName(name)
    && !(candidateItem.status === 'verified' && (sourceType === 'domain_metadata' || sourceType === 'page_title'));
  if (domainStemOnly) riskFlags.push('domain_stem_only');

  const fatal = riskFlags.some(flag => [
    'page_artifact',
    'navigation_text',
    'tagline_or_descriptor',
    'sentence_fragment',
    'trailing_conjunction',
    'logo_artifact',
    'directory_listing',
    'template_artifact',
    'compressed_neighbor',
    'wrong_entity_conflict',
  ].includes(flag));
  if (fatal) {
    return {
      semantic_class: riskFlags.includes('wrong_entity_conflict') ? 'wrong_entity_risk' : 'artifact',
      risk_flags: unique(riskFlags) as CrmNameCandidateRiskFlag[],
      verification_decision: 'reject',
      verification_block_reason: `company candidate failed semantic verification: ${unique(riskFlags).join(', ')}`,
      status_before_firewall: candidateItem.status,
      status_after_firewall: 'fail',
    };
  }

  const weakSourceOnly = sourceType === 'local_parser'
    || (sourceType === 'domain_brand' && candidateItem.status !== 'verified')
    || sourceCompanyCandidateIsCleanButSingleSource(input, candidateItem);
  if (riskFlags.length || weakSourceOnly) {
    return {
      semantic_class: 'weak_name',
      risk_flags: unique(riskFlags) as CrmNameCandidateRiskFlag[],
      verification_decision: candidateItem.status === 'verified' ? 'downgrade_provisional' : 'verify',
      verification_block_reason: riskFlags.length ? `company candidate is weak: ${unique(riskFlags).join(', ')}` : undefined,
      status_before_firewall: candidateItem.status,
      status_after_firewall: 'provisional',
    };
  }

  return {
    semantic_class: 'clean_name',
    risk_flags: [],
    verification_decision: 'verify',
    status_before_firewall: candidateItem.status,
    status_after_firewall: candidateItem.status,
  };
}

function rawPersonNameTokens(input: CrmNameResolutionInput): string[] {
  return personTokens(stripContactContext(clean(input.rawName || input.currentName || input.source?.source_text)))
    .map(normalizeToken)
    .filter(Boolean);
}

function contactCandidateSemanticContract(
  input: CrmNameResolutionInput,
  candidateItem: CrmNameCandidate
): CrmNameVerificationContract {
  const name = clean(candidateItem.normalizedName);
  const sourceType = candidateEvidenceSource(candidateItem);
  const riskFlags: CrmNameCandidateRiskFlag[] = [];
  const tokens = personTokens(name).map(normalizeToken).filter(Boolean);
  const rawTokens = rawPersonNameTokens(input);
  const local = localPart(input.email || '');

  if (CONTACT_NON_PERSON_RE.test(name) || CONTACT_NON_PERSON_RE.test(candidateItem.candidateName)) {
    riskFlags.push('company_as_contact');
  }
  const assistantBridgeHumanDisplay = /service suffix stripped from full display name|service suffix stripped from display name/i.test(candidateItem.reason)
    && contactNameIsFullPerson(name);
  if ((AUTOMATED_LOCAL_NAMES.has(local.replace(/[._-]+/g, '')) || isAutomatedDomain(domainFromInput(input))) && !assistantBridgeHumanDisplay) {
    riskFlags.push('service_or_shared_mailbox');
  }
  if (
    sourceType === 'conversation_header'
    && tokens.some((token, index) => index > 0 && ['sent', 'from', 'get', 'via'].includes(token))
  ) {
    riskFlags.push('email_header_action_word');
  }
  if (CONTACT_HEADER_ACTION_WORD_RE.test(name) && sourceType === 'conversation_header') {
    riskFlags.push('email_header_action_word');
  }
  if (tokens.length >= 2 && tokens[0] === tokens[tokens.length - 1]) {
    riskFlags.push('repeated_person_token');
  }
  if (/\s+-\s+/.test(candidateItem.candidateName) || /\blaw\s+firm\b/i.test(name)) {
    riskFlags.push('company_as_contact');
  }
  if (
    rawTokens.length >= 3
    && tokens.length >= 2
    && rawTokens[0] === tokens[0]
    && ['da', 'de', 'del', 'della', 'di', 'dos', 'das', 'van', 'von'].includes(tokens[tokens.length - 1])
    && rawTokens.length > tokens.length
  ) {
    riskFlags.push('partial_person_name');
  }

  const fatal = riskFlags.some(flag => [
    'company_as_contact',
    'service_or_shared_mailbox',
    'automated_sender',
    'email_header_action_word',
    'repeated_person_token',
    'partial_person_name',
  ].includes(flag));
  if (fatal) {
    return {
      semantic_class: riskFlags.includes('company_as_contact') || riskFlags.includes('service_or_shared_mailbox') ? 'non_person' : 'artifact',
      risk_flags: unique(riskFlags) as CrmNameCandidateRiskFlag[],
      verification_decision: riskFlags.includes('company_as_contact') || riskFlags.includes('service_or_shared_mailbox') ? 'no_entity' : 'reject',
      verification_block_reason: `contact candidate failed semantic verification: ${unique(riskFlags).join(', ')}`,
      status_before_firewall: candidateItem.status,
      status_after_firewall: riskFlags.includes('company_as_contact') || riskFlags.includes('service_or_shared_mailbox') ? 'no_entity' : 'fail',
    };
  }

  const localPartOnly = sourceType === 'local_parser'
    || /email local-part parsed into tentative|single-token contact name derived/i.test(candidateItem.reason);
  if (riskFlags.length || localPartOnly) {
    return {
      semantic_class: 'weak_name',
      risk_flags: unique(riskFlags) as CrmNameCandidateRiskFlag[],
      verification_decision: candidateItem.status === 'verified' ? 'downgrade_provisional' : 'verify',
      verification_block_reason: riskFlags.length ? `contact candidate is weak: ${unique(riskFlags).join(', ')}` : undefined,
      status_before_firewall: candidateItem.status,
      status_after_firewall: 'provisional',
    };
  }

  return {
    semantic_class: 'clean_name',
    risk_flags: [],
    verification_decision: 'verify',
    status_before_firewall: candidateItem.status,
    status_after_firewall: candidateItem.status,
  };
}

function applyVerificationContract(candidateItem: CrmNameCandidate, contract: CrmNameVerificationContract): CrmNameCandidate {
  const statusAfter = contract.status_after_firewall === 'verified' || contract.status_after_firewall === 'provisional' || contract.status_after_firewall === 'domain_placeholder'
    ? contract.status_after_firewall
    : candidateItem.status;
  return {
    ...candidateItem,
    status: statusAfter,
    confidence: contract.verification_decision === 'downgrade_provisional' ? 'low' : candidateItem.confidence,
    ruleIds: contract.verification_decision === 'downgrade_provisional'
      ? unique([...candidateItem.ruleIds, CRM_QUALITY_RULES.PROVISIONAL_NAME])
      : candidateItem.ruleIds,
    semantic_class: contract.semantic_class,
    risk_flags: contract.risk_flags,
    verification_decision: contract.verification_decision,
    verification_block_reason: contract.verification_block_reason,
    status_before_firewall: contract.status_before_firewall,
    status_after_firewall: contract.status_after_firewall,
  };
}

function verifyCandidate(input: CrmNameResolutionInput, candidateItem: CrmNameCandidate): CrmNameCandidate {
  const contract = input.entityType === 'company'
    ? companyCandidateSemanticContract(input, candidateItem)
    : contactCandidateSemanticContract(input, candidateItem);
  return applyVerificationContract(candidateItem, contract);
}

function verifiedSelectable(candidateItem: CrmNameCandidate): boolean {
  return candidateItem.verification_decision !== 'reject' && candidateItem.verification_decision !== 'no_entity';
}

function confidenceScore(confidence: CrmQualityConfidence): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
}

function evidenceQualityConfidence(confidence: CrmNameEvidenceCandidate['confidence']): CrmQualityConfidence {
  if (confidence === 'strong') return 'high';
  if (confidence === 'medium') return 'medium';
  return 'low';
}

function evidenceBaseScore(candidate: CrmNameEvidenceCandidate): number {
  const confidenceScore = candidate.confidence === 'strong' ? 108 : candidate.confidence === 'medium' ? 98 : 62;
  const sourceBonus = candidate.source_type === 'existing_crm_entity' ? 6
    : candidate.source_type === 'first_party_identity' ? 18
    : candidate.source_type === 'email_signature' ? 12
    : candidate.source_type === 'quoted_header' ? 12
    : candidate.source_type === 'crm_neighbor' ? 9
    : candidate.source_type === 'calendar_attendee' ? 5
    : candidate.source_type === 'linkedin_slug' ? 5
    : candidate.source_type === 'domain_owned_page' ? 5
    : candidate.source_type === 'domain_metadata' ? 3
    : candidate.source_type === 'source_payload' ? -8
    : 0;
  const kindBonus = candidate.candidate_kind === 'split_candidate' ? 4 : 0;
  return confidenceScore + sourceBonus + kindBonus;
}

function evidenceCandidateRuleIds(candidate: CrmNameEvidenceCandidate, extra: string[] = []): string[] {
  return unique([
    CRM_QUALITY_RULES.EVIDENCE_LEDGER,
    ...candidate.rule_ids,
    ...extra,
  ]);
}

function parseMetadataNames(metadata: CrmCompanyWebsiteMetadata | null | undefined): string[] {
  if (!metadata) return [];
  const schemaNames = Array.isArray(metadata.schemaNames)
    ? metadata.schemaNames
    : clean(metadata.schemaNames).split('|');
  return unique([
    clean(metadata.ogSiteName),
    clean(metadata.applicationName),
    clean(metadata.title),
    ...schemaNames.map(clean),
  ]).filter(Boolean);
}

function hostnameFromUrl(value: string | null | undefined): string {
  const raw = clean(value);
  if (!raw) return '';
  try {
    return normalizeDomain(new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname);
  } catch {
    return normalizeDomain(raw);
  }
}

function metadataHostMatchesInput(metadata: CrmCompanyWebsiteMetadata | null | undefined, domain: string): boolean {
  const expectedHost = normalizeDomain(domain);
  const finalHost = hostnameFromUrl(metadata?.finalUrl || metadata?.fetchUrl || '');
  if (!expectedHost || !finalHost) return true;
  const expectedStem = expectedHost.split('.')[0] || '';
  const finalStem = finalHost.replace(/^www\./, '').split('.')[0] || '';
  return finalHost === expectedHost
    || finalHost.endsWith(`.${expectedHost}`)
    || Boolean(expectedStem && finalStem && expectedStem === finalStem);
}

function metadataSourceHostMatchesDomain(sourceUrl: string | null | undefined, domain: string): boolean {
  const expectedHost = normalizeDomain(domain);
  const sourceHost = hostnameFromUrl(sourceUrl || '');
  if (!expectedHost || !sourceHost) return true;
  const expectedStem = expectedHost.split('.')[0] || '';
  const sourceStem = sourceHost.replace(/^www\./, '').split('.')[0] || '';
  return sourceHost === expectedHost
    || sourceHost.endsWith(`.${expectedHost}`)
    || Boolean(expectedStem && sourceStem && expectedStem === sourceStem);
}

function normalizedCompact(value: string): string {
  return lower(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function companyNameTokenCount(value: string): number {
  return (clean(value).match(/[A-Za-z0-9&'.-]+/g) || []).length;
}

function isAcronymCompanyName(value: string): boolean {
  const normalized = clean(value).replace(/\./g, '');
  return /^[A-Z0-9&]{2,8}$/.test(normalized) || KNOWN_COMPANY_ACRONYMS.has(normalized);
}

function metadataNameIsStrongExplicitField(
  metadataName: string,
  metadata: CrmCompanyWebsiteMetadata | null | undefined
): boolean {
  const target = normalizedCompact(metadataName);
  if (!target || !metadata) return false;
  const schemaNames = Array.isArray(metadata.schemaNames)
    ? metadata.schemaNames
    : clean(metadata.schemaNames).split('|');
  return [
    metadata.ogSiteName,
    metadata.applicationName,
    ...schemaNames,
  ].some(value => normalizedCompact(clean(value)) === target);
}

function metadataCorroboratesCompanyName(
  companyName: string,
  metadata: CrmCompanyWebsiteMetadata | null | undefined,
  domain: string
): boolean {
  if (!metadata?.ok) return false;
  const target = normalizedCompact(companyName);
  if (!target) return false;
  const names = parseMetadataNames(metadata)
    .map(name => metadataBrandCandidate(name, domain) || normalizeCompanyName(name))
    .filter(Boolean);
  return names.some(name => {
    const compact = normalizedCompact(name);
    return compact === target || compact.includes(target) || target.includes(compact);
  });
}

function sourceCompanyNameLooksUseful(value: string, domain = ''): boolean {
  const normalized = normalizeCompanyName(value);
  if (!normalized || looksLikeDomain(normalized) || metadataRejected(normalized) || PAGE_TITLE_BOILERPLATE_RE.test(normalized)) return false;
  const tokenCount = companyNameTokenCount(normalized);
  if (normalizedCompact(normalized) === normalizedCompact(normalizeDomain(domain).split('.')[0] || '') && tokenCount <= 1) return false;
  if (tokenCount >= 4 && /\b(research|development|accelerator|solution|solutions|services|platform|software|extension|digitally mirrored)\b/i.test(normalized)) return false;
  return (tokenCount >= 2 && tokenCount <= 4)
    || COMPANY_INDICATOR_RE.test(normalized)
    || isAcronymCompanyName(normalized)
    || /[&.]/.test(normalized)
    || (tokenCount === 1 && /^[A-Z][A-Za-z0-9'.-]{2,}$/.test(normalized) && !GENERIC_SINGLE_TOKEN_METADATA_RE.test(normalized));
}

function compactDomainStem(value: string): string {
  return normalizedCompact(normalizeDomain(value).split('.')[0] || '');
}

function compressedDomainStemVariant(candidateName: string, domain: string): boolean {
  const normalized = normalizeCompanyName(candidateName);
  const domainBrand = domainBrandCandidate(domain);
  if (!normalized || !domainBrand) return false;
  if (normalized.includes(' ') || normalized.includes('.') || isAcronymCompanyName(normalized)) return false;
  const candidateCompact = normalizedCompact(normalized);
  if (!candidateCompact || candidateCompact !== normalizedCompact(domainBrand)) return false;
  return domainBrand.includes(' ') && normalizedCompact(domainBrand) === candidateCompact;
}

function plainDomainStemCandidate(candidateName: string, domain: string, strongExplicitMetadata = false): boolean {
  const normalized = normalizeCompanyName(candidateName);
  if (!normalized || !domain) return false;
  if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(normalized) || isAcronymCompanyName(normalized)) return false;
  const candidateCompact = normalizedCompact(normalized);
  const stemCompact = compactDomainStem(domain);
  if (!candidateCompact || !stemCompact || candidateCompact !== stemCompact) return false;
  if (compressedDomainStemVariant(normalized, domain)) return true;
  if (companyNameTokenCount(normalized) >= 2) return false;
  return !strongExplicitMetadata;
}

function weakMetadataCompanyName(
  candidateName: string,
  rawValue: string,
  domain: string,
  strongExplicitMetadata = false
): boolean {
  if (metadataRejected(candidateName) || metadataRejected(rawValue)) return true;
  if (compressedDomainStemVariant(candidateName, domain)) return true;
  if (plainDomainStemCandidate(candidateName, domain, strongExplicitMetadata)) return true;
  return false;
}

function metadataDomainFusionCandidate(rawValue: string, domain: string): string | null {
  const raw = stripCompanyDecorators(rawValue);
  const stem = normalizeDomain(domain).split('.')[0] || '';
  const domainBrand = domainBrandCandidate(domain);
  if (!raw || !stem || stem.length < 5) return null;
  if (domainBrand && normalizedCompact(normalizeCompanyName(raw)) === normalizedCompact(domainBrand)) return null;
  const words = raw.match(/[A-Za-z][A-Za-z0-9]+/g) || [];
  for (const word of words) {
    const compactWord = normalizedCompact(word);
    if (compactWord.length < 4) continue;
    if (!stem.endsWith(compactWord) || stem === compactWord) continue;
    const prefix = stem.slice(0, -compactWord.length);
    if (prefix.length < 2 || prefix.length > 5) continue;
    const prefixText = prefix.length <= 3 ? titleCase(prefix) : titleCase(prefix);
    const wordText = titleCase(word);
    return COMPANY_INDICATOR_RE.test(wordText) ? `${prefixText} ${wordText}` : `${prefixText}${wordText}`;
  }
  return null;
}

function metadataBrandCandidate(rawValue: string, domain = ''): string | null {
  const raw = stripCompanyDecorators(rawValue).replace(/\.+$/g, '');
  if (!raw) return null;
  const stem = normalizeDomain(domain).split('.')[0] || '';
  const domainBrand = domainBrandCandidate(domain);
  const page = pageTitleCandidate(raw);
  if (metadataRejected(raw)) {
    if (!page) return null;
    const pageCompact = normalizedCompact(page);
    const domainCompact = normalizedCompact(domainBrand || '');
    const stemCompact = normalizedCompact(stem);
    if (
      !pageCompact
      || !domainCompact
      || (
        !domainCompact.includes(pageCompact)
        && !pageCompact.includes(domainCompact)
        && !stemCompact.includes(pageCompact)
        && !pageCompact.includes(stemCompact)
      )
    ) {
      return null;
    }
  }
  if (/^[a-z0-9]+(?:\.[a-z0-9]+)+$/i.test(raw) && normalizedCompact(raw) === stem) {
    return raw;
  }
  if (/^[a-z]{2,8}com$/i.test(raw) && domainBrand && normalizedCompact(raw) !== normalizedCompact(stem)) {
    return null;
  }
  const fusion = page ? null : metadataDomainFusionCandidate(raw, domain);
  if (fusion) return fusion;
  const initialCandidateName = page || normalizeCompanyName(raw);
  if (
    domainBrand
    && !page
    && /^[a-z0-9]+\.[a-z0-9]+$/i.test(domainBrand)
    && normalizedCompact(initialCandidateName) === normalizedCompact(domainBrand.split('.')[0] || '')
  ) {
    return /^[a-z0-9]+(?:\.[a-z0-9]+)+$/i.test(raw) ? domainBrand : initialCandidateName;
  }
  let candidateName = domainBrand
    && normalizedCompact(initialCandidateName) === normalizedCompact(domainBrand)
    && /[\s.]/.test(domainBrand)
    && /[\s.]/.test(initialCandidateName)
    ? domainBrand
    : domainBrand
    && normalizedCompact(initialCandidateName).startsWith(normalizedCompact(domainBrand))
    && /\b(foundation|inc|llc|ltd|corp|corporation)\b\.?$/i.test(initialCandidateName)
    ? domainBrand
    : domainBrand
    && /^i[-\s]/i.test(raw)
    && normalizedCompact(initialCandidateName).includes(normalizedCompact(domainBrand))
    ? domainBrand
    : initialCandidateName;
  if (stem.includes('and') && /\s+&\s+/.test(candidateName)) {
    candidateName = candidateName.replace(/\s+&\s+/g, ' and ');
  }
  if (!candidateName || PAGE_TITLE_BOILERPLATE_RE.test(candidateName) || metadataRejected(candidateName)) return null;
  if (candidateName.length < 2 || candidateName.length > 80) return null;
  const tokenCount = (candidateName.match(/[A-Za-z0-9&'.-]+/g) || []).length;
  if (tokenCount === 1 && GENERIC_SINGLE_TOKEN_METADATA_RE.test(candidateName)) return null;
  if (GENERIC_METADATA_PHRASE_RE.test(candidateName)) return null;
  if (!page && domainBrand && tokenCount === 1 && normalizedCompact(candidateName) !== normalizedCompact(domainBrand)) return null;
  if (tokenCount >= 6 && !COMPANY_INDICATOR_RE.test(candidateName)) return null;
  return candidateName;
}

function metadataRejected(value: string): boolean {
  const raw = stripCompanyDecorators(value);
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
  return METADATA_REJECT_RE.test(raw)
    || METADATA_REJECT_RE.test(ascii)
    || METADATA_LOCATION_ONLY_RE.test(raw)
    || METADATA_DATE_RE.test(raw)
    || METADATA_PREFIX_RE.test(raw)
    || METADATA_ADDRESS_RE.test(raw)
    || /&[a-z]+;|www\.[a-z0-9.-]+|about growthcap|brighter futures|faster\.?\s+farther\.?\s+forward|call center|production\s+ai\s+systems|participates\s+as\s+a\s+significant/i.test(raw);
}

function metadataStatus(
  candidateName: string,
  metadata: CrmCompanyWebsiteMetadata | null | undefined,
  options: { rawValue?: string; domain?: string; strongExplicitMetadata?: boolean } = {}
): Exclude<CrmNameResolutionStatus, 'merge' | 'no_entity' | 'fail'> {
  if (
    options.domain
    && weakMetadataCompanyName(candidateName, options.rawValue || candidateName, options.domain, options.strongExplicitMetadata)
  ) {
    return 'provisional';
  }
  if (metadata?.confidence === 'weak') return 'provisional';
  if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(candidateName)) return 'provisional';
  if (/\b[A-Z]{2,}\s+[A-Z]{2,}\s+SpA\b/.test(candidateName)) return 'provisional';
  return 'verified';
}

function metadataCandidateScore(args: {
  normalized: string;
  raw: string;
  index: number;
  rawInput: string;
  domainBrand: string | null;
  hostMatches: boolean;
  weakMetadata?: boolean;
}): number {
  let score = 95 - args.index;
  const normalizedName = normalizedCompact(args.normalized);
  const rawName = normalizedCompact(args.raw);
  const inputName = normalizedCompact(args.rawInput);
  const domainName = normalizedCompact(args.domainBrand || '');
  if (!args.hostMatches) score -= 45;
  if (domainName && normalizedName === domainName) score += 2;
  if (domainName && domainName.startsWith(normalizedName) && normalizedName !== domainName) score -= 18;
  if (domainName && normalizedName.startsWith(domainName) && normalizedName !== domainName) {
    score += /\b(inc|llc|ltd|corp|corporation|spa|sgr|foundation)\b/i.test(args.normalized) ? 10 : -10;
  }
  if (
    /^[a-z0-9]+\.[a-z0-9]+$/i.test(args.domainBrand || '')
    && domainName
    && normalizedName.startsWith(normalizedCompact((args.domainBrand || '').split('.')[0] || ''))
    && normalizedName !== domainName
    && /\b(gmbh|inc|llc|ltd|limited|corp|corporation|sarl|bv|ag)\b/i.test(args.normalized)
  ) {
    score -= 16;
  }
  if (/^[a-z0-9]+\.[a-z0-9]+$/i.test(args.normalized)) score += 20;
  if (/\b[A-Z]{2,}\s+[A-Z]{2,}\s+SpA\b/.test(args.normalized)) score += 14;
  const rawTitleBrand = pageTitleCandidate(args.rawInput);
  const rawTitleBrandName = normalizedCompact(rawTitleBrand || '');
  if (
    rawTitleBrandName
    && normalizedName.startsWith(rawTitleBrandName)
    && normalizedName !== rawTitleBrandName
    && /\b(inc|llc|ltd|corp|corporation)\b/i.test(args.normalized)
  ) {
    score -= 14;
  }
  if (inputName && normalizedName === inputName && !domainName) score -= 20;
  if (GENERIC_SINGLE_TOKEN_METADATA_RE.test(args.normalized)) score -= 35;
  if (rawName && rawName !== normalizedName && domainName && normalizedName === domainName) score += 4;
  if (args.weakMetadata) score -= 36;
  return score;
}

function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeMetadataText(match[1]);
  }
  return '';
}

function titleFromHtml(html: string): string {
  return decodeMetadataText(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<[^>]+>/g, ' '));
}

function schemaOrganizationNames(html: string): string[] {
  return [...html.matchAll(/"name"\s*:\s*"([^"]{2,100})"/gi)]
    .map(match => {
      const context = html.slice(Math.max(0, (match.index || 0) - 900), (match.index || 0) + 700);
      const hasOrganizationType = /"@type"\s*:\s*(?:"(?:Organization|Corporation|LocalBusiness|FinancialService|InvestmentFund|NGO|EducationalOrganization)"|\[[^\]]*"(?:Organization|Corporation|LocalBusiness|FinancialService|InvestmentFund|NGO|EducationalOrganization)"[^\]]*\])/i.test(context);
      if (!hasOrganizationType || /"@type"\s*:\s*"(?:Country|ListItem|BreadcrumbList|ItemList|Person|PostalAddress)"|countries|countryOptions|socialShare|sameAs/i.test(context)) {
        return '';
      }
      return decodeMetadataText(match[1] || '');
    })
    .filter(name => name && !metadataRejected(name))
    .slice(0, 12);
}

function footerLegalNames(text: string, domain: string): string[] {
  const names: string[] = [];
  const domainBrand = domainBrandCandidate(domain);
  const cleanFooterName = (value: string): string => clean(value)
    .replace(/\b(?:all rights reserved|privacy policy|terms(?: of (?:use|service))?|cookie policy|copyright)\b.*$/i, '')
    .replace(/\s*[|•·–—-]\s*$/, '')
    .trim();
  const copyright = text.match(/(?:copyright|©|\(c\))\s*(?:20\d{2})?\s*([A-Z][A-Za-z0-9&.,' -]{2,80})/i);
  if (copyright?.[1]) names.push(cleanFooterName(copyright[1]));
  const rights = text.match(/([A-Z][A-Za-z0-9&.,' -]{2,80})\s+all rights reserved/i);
  if (rights?.[1]) names.push(cleanFooterName(rights[1]));
  if (domainBrand) {
    const escaped = domainBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`\\b([A-Z][A-Za-z0-9&.,' -]{0,50}${escaped}[A-Za-z0-9&.,' -]{0,30})\\b`, 'i'));
    if (match?.[1]) names.push(cleanFooterName(match[1]));
  }
  return unique(names.map(name => normalizeCompanyName(name)).filter(name => name && !metadataRejected(name))).slice(0, 6);
}

function companyCandidateUrls(homeHtml: string, homeUrl: string, domain: string): string[] {
  const urls = new Set<string>([homeUrl]);
  for (const path of ['/about', '/about-us', '/team', '/people', '/contact', '/legal', '/privacy']) {
    urls.add(`https://${domain}${path}`);
  }
  const hrefPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(homeHtml))) {
    const url = sameSiteUrl(match[1] || '', homeUrl, domain);
    if (!url) continue;
    if (/\b(about|company|team|people|contact|legal|privacy|who-we-are|firm)\b/i.test(url)) urls.add(url);
  }
  return [...urls].slice(0, 12);
}

async function sitemapCompanyUrls(domain: string, timeoutMs: number): Promise<string[]> {
  const root = await fetchTextPage(`https://${domain}/sitemap.xml`, timeoutMs);
  if (!root) return [];
  const rootLocs = [...root.html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(match => decodeMetadataText(match[1] || ''));
  const selected = new Set<string>();
  for (const url of rootLocs) {
    if (/\b(about|company|team|people|contact|legal|privacy|firm|who-we-are)\b/i.test(url)) selected.add(url);
  }
  for (const sitemapUrl of rootLocs.filter(url => /sitemap/i.test(url)).slice(0, 3)) {
    const page = await fetchTextPage(sitemapUrl, timeoutMs);
    if (!page) continue;
    for (const match of page.html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      const url = decodeMetadataText(match[1] || '');
      if (/\b(about|company|team|people|contact|legal|privacy|firm|who-we-are)\b/i.test(url)) selected.add(url);
      if (selected.size >= 12) break;
    }
  }
  return [...selected].slice(0, 12);
}

export async function fetchCompanyWebsiteMetadata(input: {
  domain?: string | null;
  website?: string | null;
  timeoutMs?: number;
}): Promise<CrmCompanyWebsiteMetadata | null> {
  if (
    typeof process !== 'undefined'
    && process.env.NODE_ENV === 'test'
    && process.env.CRM_QUALITY_ENABLE_LIVE_METADATA_IN_TESTS !== 'true'
  ) {
    return null;
  }
  const domain = normalizeDomain(input.domain || input.website || '');
  const rawWebsite = clean(input.website);
  const fetchUrl = rawWebsite
    ? (/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`)
    : domain
      ? `https://${domain}`
      : '';
  if (!fetchUrl || isAutomatedDomain(domain) || isInvalidPublicSuffixLike(domain)) return null;

  const timeoutMs = input.timeoutMs ?? 1800;
  try {
    const home = await fetchTextPage(fetchUrl, timeoutMs);
    if (!home) return { fetchUrl, fetchedLive: true, ok: false, confidence: 'unknown' };
    const pages = [home];
    const urls = unique([
      ...companyCandidateUrls(home.html, home.url, domain),
      ...(await sitemapCompanyUrls(domain, timeoutMs)),
    ]).slice(0, 14);
    for (const url of urls) {
      if (url === home.url) continue;
      const page = await fetchTextPage(url, Math.max(650, Math.floor(timeoutMs * 0.7)));
      if (page) pages.push(page);
      if (pages.length >= 8) break;
    }
    const title = titleFromHtml(home.html);
    const ogSiteName = metaContent(home.html, 'og:site_name');
    const applicationName = metaContent(home.html, 'application-name');
    const schemaNames = unique(pages.flatMap(page => schemaOrganizationNames(page.html)));
    const footerNames = unique(pages.flatMap(page => footerLegalNames(htmlToText(page.html).slice(-8000), domain)));
    const strongSignals = [ogSiteName, applicationName, title, ...schemaNames, ...footerNames].filter(Boolean).length;
    return {
      fetchUrl,
      finalUrl: home.url,
      fetchedLive: true,
      ok: true,
      title,
      ogSiteName,
      applicationName,
      schemaNames: unique([...schemaNames, ...footerNames]).slice(0, 18),
      confidence: strongSignals >= 2 || pages.length >= 3 ? 'strong' : 'weak',
    };
  } catch {
    return { fetchUrl, fetchedLive: true, ok: false, confidence: 'unknown' };
  }
}

function emailDomain(email: string | null | undefined): string {
  return normalizeDomain(clean(email).split('@')[1] || '');
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function emailEntries(value: string | null | undefined): Array<{ email: string; displayName: string }> {
  const raw = clean(value);
  if (!raw) return [];
  const out: Array<{ email: string; displayName: string }> = [];
  const parsed = safeJsonParse(raw);
  const visit = (item: unknown): void => {
    if (!item) return;
    if (typeof item === 'string') {
      out.push(...emailEntriesFromText(item));
      return;
    }
    if (typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const email = clean(row.email || row.address || row.mail || row.userPrincipalName);
      const displayName = clean(row.name || row.displayName || row.display_name || row.label);
      if (email || displayName) out.push({ email, displayName });
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(visit);
  else if (parsed) visit(parsed);
  else out.push(...emailEntriesFromText(raw));
  const seen = new Set<string>();
  return out.filter(entry => {
    const key = `${lower(entry.email)}:${normalizeToken(entry.displayName)}`;
    if (!entry.email && !entry.displayName) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emailEntriesFromText(value: string): Array<{ email: string; displayName: string }> {
  const out: Array<{ email: string; displayName: string }> = [];
  const anglePattern = /"?([^"<>,;]{2,100})"?\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = anglePattern.exec(value))) {
    out.push({ displayName: clean(match[1]), email: lower(match[2]) });
  }
  const barePattern = /\b([^,;"<>()]{0,80}?)\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  while ((match = barePattern.exec(value))) {
    const email = lower(match[2]);
    if (out.some(entry => lower(entry.email) === email)) continue;
    out.push({ displayName: clean(match[1]), email });
  }
  if (!out.length && /^\S+@\S+\.\S+$/.test(value)) out.push({ displayName: '', email: lower(value) });
  return out;
}

function displayNameForEmail(value: string | null | undefined, targetEmail: string): string | null {
  const target = lower(targetEmail);
  if (!target) return null;
  for (const entry of emailEntries(value)) {
    if (lower(entry.email) === target && entry.displayName) return entry.displayName;
  }
  return null;
}

function extractQuotedHeaderNames(text: string, targetEmail: string): string[] {
  const target = lower(targetEmail);
  if (!target || !text) return [];
  const names: string[] = [];
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerPattern = new RegExp(`(?:^|\\n)\\s*(?:from|to|cc|sender):\\s*"?([^"<>\\n]{2,100})"?\\s*<${escaped}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(text))) {
    const display = displayContactCandidate(match[1] || '', false);
    if (display) names.push(display);
  }
  return unique(names);
}

function extractSignatureNames(text: string, targetEmail: string): string[] {
  const target = lower(targetEmail);
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(line => clean(line)).filter(Boolean);
  const names: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const nearTargetEmail = target && lines.slice(index, Math.min(lines.length, index + 5)).some(item => lower(item).includes(target));
    const afterSignoff = index > 0 && /^(best|best regards|regards|thanks|thank you|sincerely|cheers|warmly)[,!-]?$/i.test(lines[index - 1]);
    if (!nearTargetEmail && !afterSignoff) continue;
    const display = displayContactCandidate(line, false);
    if (display) names.push(display);
  }
  return unique(names).slice(0, 4);
}

function matchedTextNamesForEmail(text: string, email: string, rawName = ''): string[] {
  return extractPersonNames(text)
    .filter(name => contactNameScoreForEmail(name, email, rawName) >= 76)
    .slice(0, 8);
}

function personNameTokens(value: string): string[] {
  return personTokens(value)
    .filter(token => !/^(dr|mr|mrs|ms)$/i.test(token.replace(/\./g, '')))
    .map(token => token.replace(/\.$/, ''));
}

function contactLocalHints(email: string, rawName = ''): {
  firstHints: string[];
  lastHints: string[];
  firstInitial?: string;
  local: string;
} {
  const local = localPart(email).replace(/\d+$/g, '').replace(/[^a-z._-]+/gi, '').toLowerCase();
  const collapsed = local.replace(/[^a-z]+/g, '');
  const rawTokens = personNameTokens(rawName).map(normalizeToken).filter(Boolean);
  const firstHints = new Set<string>();
  const lastHints = new Set<string>();

  if (rawTokens.length === 1 && rawTokens[0].length >= 3) firstHints.add(rawTokens[0]);
  if (rawTokens.length >= 2) {
    firstHints.add(rawTokens[0]);
    lastHints.add(rawTokens[rawTokens.length - 1]);
  }

  const pieces = local.split(/[._-]+/).map(normalizeToken).filter(Boolean);
  if (pieces.length >= 2) {
    if (pieces[0].length >= 2) firstHints.add(pieces[0]);
    if (pieces[pieces.length - 1].length >= 2) lastHints.add(pieces[pieces.length - 1]);
  }

  const initialLast = collapsed.match(/^([a-z])([a-z]{3,})$/);
  if (initialLast) lastHints.add(initialLast[2]);

  const lastInitial = collapsed.match(/^([a-z]{3,})([a-z])$/);
  if (lastInitial) {
    firstHints.add(lastInitial[1]);
    lastHints.add(lastInitial[1]);
  }

  for (const given of KNOWN_GIVEN_NAME_LOCALS) {
    if (collapsed === given || collapsed.startsWith(given)) firstHints.add(given);
    if (collapsed.endsWith(given) && collapsed.length > given.length + 2) firstHints.add(given);
  }

  return {
    firstHints: [...firstHints],
    lastHints: [...lastHints],
    firstInitial: collapsed[0],
    local: collapsed,
  };
}

function contactNameScoreForEmail(name: string, email: string, rawName = ''): number {
  const tokens = personNameTokens(name).map(normalizeToken).filter(Boolean);
  if (tokens.length < 2) return 0;
  const first = tokens[0] || '';
  const last = tokens[tokens.length - 1] || '';
  const middleInitials = tokens.slice(1).map(token => token[0]).join('');
  const local = localPart(email).replace(/\d+$/g, '').replace(/[^a-z]+/gi, '').toLowerCase();
  const raw = normalizeToken(rawName);
  const hints = contactLocalHints(email, rawName);

  if (!first || !last || !local) return 0;
  if (local === `${first}${last}`) return 100;
  if (local === `${first[0]}${last}`) return 96;
  if (local === `${first}${last[0]}`) return 94;
  if (local === `${last}${first}`) return 94;
  if (local === `${last}${first[0]}`) return 94;
  if (local === `${first}${middleInitials}` && tokens.length >= 3) return 92;
  if (local.startsWith(first[0]) && last.startsWith(local.slice(1)) && local.length >= 5) return 90;
  if (hints.firstHints.includes(first) && hints.lastHints.includes(last)) return 88;
  if (hints.firstHints.includes(first) && raw === first) return 82;
  if (hints.firstHints.includes(first) && local === first) return 82;
  if (hints.firstHints.includes(first) && hints.firstInitial === first[0]) return 76;
  return 0;
}

function displayEmailCorroboratedCandidate(displayName: string, email: string): string | null {
  const tokens = personNameTokens(displayName);
  if (tokens.length < 3) return null;
  const normalized = tokens.map(normalizeToken).filter(Boolean);
  const first = normalized[0] || '';
  const last = normalized[normalized.length - 1] || '';
  const middle = normalized[1] || '';
  const local = localPart(email).replace(/\d+$/g, '').replace(/[^a-z]+/gi, '').toLowerCase();
  if (!first || !last || !local) return null;

  if (middle === last) return null;

  const initialsAfterFirst = normalized.slice(1).map(token => token[0]).join('');
  if (local === `${first}${initialsAfterFirst}` && tokens.length >= 3) {
    return titleCase(`${tokens[0]} ${tokens[1]}`);
  }

  return null;
}

function isSingleFirstNamePublicMatch(args: {
  candidate: CrmContactPublicNameCandidate;
  candidateName: string;
  email: string;
  allCandidates: CrmContactPublicNameCandidate[];
}): boolean {
  if (args.allCandidates.length !== 1) return false;
  if (args.candidate.sourceType !== 'domain_owned_page' && args.candidate.sourceType !== 'domain_sitemap') return false;
  const tokens = personNameTokens(args.candidateName).map(normalizeToken).filter(Boolean);
  if (tokens.length < 2) return false;
  const local = localPart(args.email).replace(/\d+$/g, '').replace(/[^a-z]+/gi, '').toLowerCase();
  return Boolean(local && local === tokens[0]);
}

function firstLastVariantKey(name: string): string {
  const tokens = personNameTokens(name).map(normalizeToken).filter(Boolean);
  if (tokens.length < 2) return '';
  return `${tokens[0]}:${tokens[tokens.length - 1]}`;
}

function hasSimplerPublicNameVariant(name: string, candidates: CrmContactPublicNameCandidate[]): boolean {
  const key = firstLastVariantKey(name);
  const tokens = personNameTokens(name);
  if (!key || tokens.length <= 2) return false;
  return candidates.some(candidate => {
    const candidateTokens = personNameTokens(candidate.name);
    return candidateTokens.length === 2 && firstLastVariantKey(candidate.name) === key;
  });
}

function htmlToText(html: string): string {
  return decodeMetadataText(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPersonNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /\b(?:Dr\.\s+)?[A-Z][A-Za-z'.-]{2,}(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'.-]{2,}\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const nextStart = (match.index || 0) + 1;
    const name = clean(match[0]);
    if (!/\b(Privacy Policy|Terms Conditions|Contact Us|Read More|Chief Executive|Vice President|General Partner|Managing Partner|Cookie Policy|United States)\b/i.test(name)) {
      names.push(titleCase(name));
    }
    pattern.lastIndex = nextStart;
  }
  return unique(names);
}

async function fetchTextPage(url: string, timeoutMs: number): Promise<{ url: string; html: string } | null> {
  const cacheKey = url.replace(/#.*$/, '');
  const cached = PUBLIC_TEXT_PAGE_CACHE.get(cacheKey);
  if (cached) return cached;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchPromise = (async () => {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'MedinaCRMNameResolver/1.0' },
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/html|text|xml|json/i.test(contentType)) return null;
    return { url: response.url, html: (await response.text()).slice(0, 300_000) };
  })().catch(() => null).finally(() => clearTimeout(timeout));
  PUBLIC_TEXT_PAGE_CACHE.set(cacheKey, fetchPromise);
  return fetchPromise;
}

function sameSiteUrl(raw: string, baseUrl: string, domain: string): string | null {
  try {
    const url = new URL(raw, baseUrl);
    const host = normalizeDomain(url.hostname);
    return host === domain || host.endsWith(`.${domain}`) ? url.toString() : null;
  } catch {
    return null;
  }
}

function publicPersonCandidateUrls(homeHtml: string, homeUrl: string, domain: string, email: string, rawName: string): string[] {
  const urls = new Set<string>([homeUrl]);
  const hints = contactLocalHints(email, rawName);
  const hintFragments = unique([
    ...hints.firstHints,
    ...hints.lastHints,
    hints.local,
  ]).filter(value => value.length >= 3);

  const standardPaths = [
    '/team',
    '/our-team',
    '/people',
    '/about/team',
    '/company/team',
    '/leadership',
    '/professionals',
    '/attorneys',
    '/lawyers',
    '/members',
  ];
  for (const path of standardPaths) urls.add(`https://${domain}${path}`);

  const hrefPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(homeHtml))) {
    const href = match[1] || '';
    const url = sameSiteUrl(href, homeUrl, domain);
    if (!url) continue;
    const normalizedHref = decodeMetadataText(href).toLowerCase();
    if (PERSON_PAGE_LINK_RE.test(normalizedHref) || hintFragments.some(fragment => normalizedHref.includes(fragment))) {
      urls.add(url);
    }
  }

  return [...urls].slice(0, 10);
}

async function sitemapPersonUrls(domain: string, email: string, rawName: string, timeoutMs: number): Promise<string[]> {
  const sitemap = await fetchTextPage(`https://${domain}/sitemap.xml`, timeoutMs);
  if (!sitemap) return [];
  const hints = contactLocalHints(email, rawName);
  const hintFragments = unique([
    ...hints.firstHints,
    ...hints.lastHints,
    hints.local,
  ]).filter(value => value.length >= 3);
  const locs = [...sitemap.html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(match => decodeMetadataText(match[1] || ''));
  const selected = new Set(locs.filter(url => {
    const lowerUrl = lower(url);
    return PERSON_PAGE_LINK_RE.test(lowerUrl) || hintFragments.some(fragment => lowerUrl.includes(fragment));
  }));
  for (const sitemapUrl of locs.filter(url => /sitemap/i.test(url)).slice(0, 4)) {
    const page = await fetchTextPage(sitemapUrl, timeoutMs);
    if (!page) continue;
    for (const match of page.html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      const url = decodeMetadataText(match[1] || '');
      const lowerUrl = lower(url);
      if (PERSON_PAGE_LINK_RE.test(lowerUrl) || hintFragments.some(fragment => lowerUrl.includes(fragment))) selected.add(url);
      if (selected.size >= 18) break;
    }
  }
  return [...selected].slice(0, 18);
}

export async function fetchContactPublicNameMetadata(input: {
  email?: string | null;
  displayName?: string | null;
  timeoutMs?: number;
}): Promise<CrmContactPublicNameMetadata | null> {
  if (
    typeof process !== 'undefined'
    && process.env.NODE_ENV === 'test'
    && process.env.CRM_QUALITY_ENABLE_LIVE_PERSON_METADATA_IN_TESTS !== 'true'
  ) {
    return null;
  }
  const email = clean(input.email).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return null;
  const domain = emailDomain(email);
  if (!domain || PERSONAL_DOMAINS.has(domain) || isAutomatedDomain(domain) || isInvalidPublicSuffixLike(domain)) return null;

  const timeoutMs = input.timeoutMs ?? 850;
  const home = await fetchTextPage(`https://${domain}`, timeoutMs);
  if (!home) return { fetchedLive: true, ok: false, candidates: [], confidence: 'unknown' };

  const urls = unique([
    ...publicPersonCandidateUrls(home.html, home.url, domain, email, clean(input.displayName)),
    ...(await sitemapPersonUrls(domain, email, clean(input.displayName), timeoutMs)),
  ]).slice(0, 10);

  const candidates: CrmContactPublicNameCandidate[] = [];
  for (const url of urls) {
    const page = url === home.url ? home : await fetchTextPage(url, timeoutMs);
    if (!page) continue;
    const text = htmlToText(page.html);
    const names = extractPersonNames(text);
    for (const name of names) {
      const score = contactNameScoreForEmail(name, email, clean(input.displayName));
      if (score < 76) continue;
      candidates.push({
        name,
        sourceUrl: page.url,
        sourceText: truncate(text, 220),
        sourceType: url.includes('sitemap') ? 'domain_sitemap' : 'domain_owned_page',
        confidence: score >= 90 ? 'strong' : 'weak',
      });
    }
  }

  const ranked = unique(candidates.map(item => item.name))
    .map(name => candidates.find(item => item.name === name)!)
    .sort((a, b) => contactNameScoreForEmail(b.name, email, clean(input.displayName)) - contactNameScoreForEmail(a.name, email, clean(input.displayName)))
    .slice(0, 8);

  return {
    fetchedLive: true,
    ok: true,
    candidates: ranked,
    confidence: ranked.some(item => item.confidence === 'strong') ? 'strong' : ranked.length ? 'weak' : 'unknown',
  };
}

export function shouldFetchContactPublicNameMetadata(input: {
  email?: string | null;
  displayName?: string | null;
}): boolean {
  const email = clean(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) return false;
  const domain = emailDomain(email);
  if (!domain || PERSONAL_DOMAINS.has(domain) || isAutomatedDomain(domain) || isInvalidPublicSuffixLike(domain)) return false;

  const display = clean(input.displayName);
  if (!display) return true;
  if (SERVICE_SUFFIX_RE.test(display)) return true;
  if (isRawEmailLike(display)) return true;
  if (normalizeToken(display) === normalizeToken(localPart(email))) return true;
  const useful = displayContactCandidate(display, false);
  if (!useful) return true;
  const tokens = personNameTokens(useful);
  if (tokens.length <= 1) return true;
  if (/^[A-Z]\.\s+/i.test(useful)) return true;
  return false;
}

function isRawEmailLike(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(clean(value));
}

async function addContactInteractionHistoryCandidates(args: {
  candidates: CrmNameEvidenceCandidate[];
  input: BuildCrmNameEvidenceBundleInput;
  env?: Env;
  orgId: string;
  entityId: string;
  email: string;
  currentName: string;
  includeBodies: boolean;
}): Promise<void> {
  const { candidates, input, env, orgId, entityId, email, currentName, includeBodies } = args;
  if (!orgId || (!entityId && !email)) return;
  const likeEmail = email ? `%${email.replace(/[%_]/g, '')}%` : '';
  const rows = await allD1<Record<string, any>>(
    env,
    `SELECT c.id, c.source, c.subject, c.body_preview, c.body_r2_key,
            c.from_email, c.from_name, c.to_emails, c.cc_emails, c.sent_at, c.from_contact_id
       FROM conversations c
       LEFT JOIN conversation_contacts cc ON cc.conversation_id = c.id
      WHERE c.org_id = ?
        AND (
          (? != '' AND (cc.contact_id = ? OR c.from_contact_id = ?))
          OR (? != '' AND (
            LOWER(c.from_email) = LOWER(?)
            OR LOWER(COALESCE(c.to_emails, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(c.cc_emails, '')) LIKE LOWER(?)
          ))
        )
      ORDER BY c.sent_at DESC
      LIMIT 24`,
    orgId,
    entityId,
    entityId,
    entityId,
    email,
    email,
    likeEmail,
    likeEmail
  );
  for (const row of rows) {
    const sourceId = row.id || input.source?.source_record_id || entityId || null;
    const observedAt = row.sent_at || null;
    const fromName = lower(row.from_email) === lower(email) ? clean(row.from_name) : '';
    addEvidenceCandidate(candidates, {
      value: fromName,
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'conversation_header',
      source_channel: row.source || 'conversation',
      source_record_id: sourceId,
      source_text_excerpt: truncate(`${row.from_name || ''} <${row.from_email || ''}> ${row.subject || ''}`, 220),
      confidence: contactNameIsFullPerson(fromName) ? 'strong' : 'medium',
      privacy_scope: 'org_owned',
      observed_at: observedAt,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
    for (const display of unique([
      displayNameForEmail(row.to_emails, email) || '',
      displayNameForEmail(row.cc_emails, email) || '',
    ])) {
      addEvidenceCandidate(candidates, {
        value: display,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: row.source || 'conversation_recipient',
        source_record_id: sourceId,
        source_text_excerpt: truncate(`${row.to_emails || ''} ${row.cc_emails || ''}`, 220),
        confidence: contactNameIsFullPerson(display) ? 'strong' : 'medium',
        privacy_scope: 'org_owned',
        observed_at: observedAt,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
    }
    for (const name of matchedTextNamesForEmail(row.subject || '', email, currentName)) {
      addEvidenceCandidate(candidates, {
        value: name,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: `${row.source || 'conversation'}_subject`,
        source_record_id: sourceId,
        source_text_excerpt: truncate(row.subject || '', 220),
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: observedAt,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
    }
    const bodyPreview = clean(row.body_preview);
    for (const name of extractQuotedHeaderNames(bodyPreview, email)) {
      addEvidenceCandidate(candidates, {
        value: name,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'quoted_header',
        source_channel: `${row.source || 'conversation'}_body_preview`,
        source_record_id: sourceId,
        source_text_excerpt: truncate(bodyPreview, 220),
        confidence: 'strong',
        privacy_scope: 'org_owned',
        observed_at: observedAt,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 2,
      });
    }
    for (const name of extractSignatureNames(bodyPreview, email)) {
      addEvidenceCandidate(candidates, {
        value: name,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'email_signature',
        source_channel: `${row.source || 'conversation'}_body_preview`,
        source_record_id: sourceId,
        source_text_excerpt: truncate(bodyPreview, 220),
        confidence: contactNameScoreForEmail(name, email, currentName) >= 88 ? 'strong' : 'medium',
        privacy_scope: 'org_owned',
        observed_at: observedAt,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 2,
      });
    }
    if (includeBodies && row.body_r2_key) {
      const body = await readR2TextExcerpt(env, row.body_r2_key, 7000);
      for (const name of unique([...extractQuotedHeaderNames(body, email), ...extractSignatureNames(body, email)])) {
        addEvidenceCandidate(candidates, {
          value: name,
          entity_type: 'contact',
          candidate_kind: 'contact_name',
          source_type: extractQuotedHeaderNames(body, email).includes(name) ? 'quoted_header' : 'email_signature',
          source_channel: `${row.source || 'conversation'}_r2_body`,
          source_record_id: sourceId,
          source_text_excerpt: truncate(body, 220),
          confidence: 'strong',
          privacy_scope: 'org_owned',
          observed_at: observedAt,
          rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
          cost_tier: 2,
        });
      }
    }
  }

  const timelineRows = await allD1<Record<string, any>>(
    env,
    `SELECT id, title, body_preview, source, item_timestamp, metadata
       FROM contact_timeline_items
      WHERE org_id = ?
        AND (? != '' AND contact_id = ?)
      ORDER BY item_timestamp DESC
      LIMIT 12`,
    orgId,
    entityId,
    entityId
  );
  for (const row of timelineRows) {
    const text = clean(`${row.title || ''} ${row.body_preview || ''} ${row.metadata || ''}`);
    for (const name of matchedTextNamesForEmail(text, email, currentName)) {
      addEvidenceCandidate(candidates, {
        value: name,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'conversation_header',
        source_channel: row.source || 'contact_timeline',
        source_record_id: row.id || entityId || null,
        source_text_excerpt: truncate(text, 220),
        confidence: 'medium',
        privacy_scope: 'org_owned',
        observed_at: row.item_timestamp || null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
    }
  }
}

async function addContactNeighborCandidates(args: {
  candidates: CrmNameEvidenceCandidate[];
  input: BuildCrmNameEvidenceBundleInput;
  env?: Env;
  orgId: string;
  entityId: string;
  email: string;
  domain: string;
}): Promise<void> {
  const { candidates, input, env, orgId, entityId, email, domain } = args;
  if (!orgId || (!entityId && !email && !domain)) return;
  const local = localPart(email);
  const rows = await allD1<Record<string, any>>(
    env,
    `SELECT c.id, c.full_name, c.email, c.linkedin_url, c.company_id,
            c.total_interactions, co.name AS company_name, co.domain AS company_domain
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id AND co.org_id = c.org_id
      WHERE c.org_id = ?
        AND c.deleted_at IS NULL
        AND c.id != ?
        AND (
          (? != '' AND LOWER(c.email) = LOWER(?))
          OR (? != '' AND LOWER(substr(c.email, instr(c.email, '@') + 1)) = LOWER(?))
          OR (? != '' AND c.company_id IN (
            SELECT company_id FROM contacts WHERE org_id = ? AND id = ? AND company_id IS NOT NULL
          ))
        )
      LIMIT 24`,
    orgId,
    entityId || '',
    email,
    email,
    domain,
    domain,
    entityId,
    orgId,
    entityId
  );
  for (const row of rows) {
    const neighborEmail = clean(row.email);
    const sameEmail = email && lower(neighborEmail) === lower(email);
    const sameLocal = local && localPart(neighborEmail) === local;
    const name = clean(row.full_name);
    if (!sameEmail && !sameLocal) continue;
    if (!contactNameLooksUseful(name, false)) continue;
    addEvidenceCandidate(candidates, {
      value: name,
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'crm_neighbor',
      source_channel: sameEmail ? 'crm_duplicate_email_neighbor' : 'crm_same_local_neighbor',
      source_record_id: row.id || null,
      source_text_excerpt: truncate(`${name} <${neighborEmail}> ${row.company_name || ''}`, 220),
      confidence: sameEmail || Number(row.total_interactions || 0) >= 3 ? 'strong' : 'medium',
      privacy_scope: 'org_owned',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
  }

  const associatedRows = await allD1<Record<string, any>>(
    env,
    `SELECT c.id, c.full_name, c.email, ca.relationship, ca.confidence
       FROM contact_associations ca
       JOIN contacts c ON c.id = CASE WHEN ca.contact_id_a = ? THEN ca.contact_id_b ELSE ca.contact_id_a END
      WHERE ca.org_id = ?
        AND (? != '' AND (ca.contact_id_a = ? OR ca.contact_id_b = ?))
        AND c.deleted_at IS NULL
      LIMIT 12`,
    entityId,
    orgId,
    entityId,
    entityId,
    entityId
  );
  for (const row of associatedRows) {
    const sameLocal = local && localPart(row.email) === local;
    if (!sameLocal) continue;
    addEvidenceCandidate(candidates, {
      value: row.full_name,
      entity_type: 'contact',
      candidate_kind: 'contact_name',
      source_type: 'crm_neighbor',
      source_channel: `contact_association_${row.relationship || 'connected'}`,
      source_record_id: row.id || null,
      source_text_excerpt: truncate(`${row.full_name || ''} <${row.email || ''}>`, 180),
      confidence: Number(row.confidence || 0) >= 0.8 ? 'strong' : 'medium',
      privacy_scope: 'org_owned',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
  }
}

async function addFirstPartyIdentityCandidates(args: {
  candidates: CrmNameEvidenceCandidate[];
  input: BuildCrmNameEvidenceBundleInput;
  env?: Env;
  orgId: string;
  email: string;
}): Promise<number> {
  const { candidates, input, env, orgId, email } = args;
  if (!env || !orgId || !email || !env.AZURE_CLIENT_ID || !env.AZURE_TENANT_ID || !env.AZURE_CLIENT_CERT_PRIVATE_KEY || !env.AZURE_CLIENT_CERT_THUMBPRINT) {
    return 0;
  }
  try {
    const allowed = await checkGraphRateLimit(orgId, env).catch(() => false);
    if (!allowed) return 0;
    const token = await getAppOnlyGraphAccessToken(env);
    const filter = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}' or userPrincipalName eq '${email.replace(/'/g, "''")}'`);
    const response = await fetch(`https://graph.microsoft.com/v1.0/users?$filter=${filter}&$select=displayName,mail,userPrincipalName&$top=2`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await recordGraphApiCall(orgId, env).catch(() => undefined);
    if (!response.ok) return 1;
    const json = await response.json() as { value?: Array<{ displayName?: string; mail?: string; userPrincipalName?: string }> };
    for (const row of json.value || []) {
      const returnedEmail = lower(row.mail || row.userPrincipalName || '');
      if (returnedEmail !== lower(email)) continue;
      addEvidenceCandidate(candidates, {
        value: row.displayName,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'first_party_identity',
        source_channel: 'microsoft_graph_users_exact_email',
        source_record_id: returnedEmail,
        source_text_excerpt: truncate(`${row.displayName || ''} <${returnedEmail}>`, 180),
        confidence: 'strong',
        privacy_scope: 'provider_identity',
        observed_at: null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 3,
      });
    }
    return 1;
  } catch {
    return 0;
  }
}

async function addCompanyNeighborCandidates(args: {
  candidates: CrmNameEvidenceCandidate[];
  input: BuildCrmNameEvidenceBundleInput;
  env?: Env;
  orgId: string;
  entityId: string;
  domain: string;
}): Promise<void> {
  const { candidates, input, env, orgId, entityId, domain } = args;
  if (!orgId || (!entityId && !domain)) return;
  const domainBrand = domainBrandCandidate(domain);
  const rows = await allD1<Record<string, any>>(
    env,
    `SELECT id, name, domain, website, linked_contact_count, conversation_count, event_count, deal_count, document_count
       FROM companies
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND id != ?
        AND (
          (? != '' AND (LOWER(domain) = LOWER(?) OR LOWER(website) LIKE LOWER(?)))
          OR (? != '' AND LOWER(name) LIKE LOWER(?))
        )
      LIMIT 24`,
    orgId,
    entityId || '',
    domain,
    domain,
    domain ? `%${domain}%` : '',
    domainBrand || '',
    domainBrand ? `%${domainBrand.split(' ')[0]}%` : ''
  );
  for (const row of rows) {
    const name = clean(row.name);
    if (!name || metadataRejected(name) || looksLikeDomain(name) || PAGE_TITLE_BOILERPLATE_RE.test(name)) continue;
    const confidence = companyEvidenceConfidence(row);
    addEvidenceCandidate(candidates, {
      value: name,
      entity_type: 'company',
      candidate_kind: 'company_name',
      source_type: 'crm_neighbor',
      source_channel: 'crm_company_neighbor',
      source_record_id: row.id || null,
      source_text_excerpt: truncate(`${name} ${row.domain || ''} ${row.website || ''}`, 220),
      confidence,
      privacy_scope: 'org_owned',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
  }

  const aliases = await allD1<Record<string, any>>(
    env,
    `SELECT entity_id, alias_kind, alias_value, confidence, source_kind
       FROM entity_identity_aliases
      WHERE org_id = ?
        AND entity_type = 'company'
        AND (
          (? != '' AND alias_kind IN ('domain', 'domain_brand') AND LOWER(alias_value) = LOWER(?))
          OR (? != '' AND alias_kind = 'normalized_name' AND LOWER(alias_value) LIKE LOWER(?))
        )
      LIMIT 12`,
    orgId,
    domain,
    domain,
    domainBrand || '',
    domainBrand ? `%${domainBrand}%` : ''
  );
  for (const row of aliases) {
    addEvidenceCandidate(candidates, {
      value: row.alias_value,
      entity_type: 'company',
      candidate_kind: row.alias_kind === 'domain' ? 'domain_placeholder' : 'company_alias',
      source_type: 'crm_neighbor',
      source_channel: `identity_alias_${row.source_kind || 'system'}`,
      source_record_id: row.entity_id || null,
      source_text_excerpt: truncate(`${row.alias_kind}: ${row.alias_value}`, 180),
      confidence: Number(row.confidence || 0) >= 0.85 ? 'strong' : 'medium',
      privacy_scope: 'org_owned',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 1,
    });
  }
}

export async function buildCrmNameEvidenceBundle(
  input: BuildCrmNameEvidenceBundleInput,
  env?: Env,
  options: BuildCrmNameEvidenceBundleOptions = {}
): Promise<CrmNameEvidenceBundle> {
  const started = options.startTimeMs ?? Date.now();
  const includeNetwork = Boolean(options.includeNetwork);
  const cacheKey = evidenceCacheKey(input, includeNetwork);
  const cached = CRM_NAME_EVIDENCE_CACHE.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cache_hits: cached.cache_hits + 1,
      budget_spent_ms: Date.now() - started,
      candidates: cached.candidates.map(candidate => ({ ...candidate })),
      builder_diagnostics: (cached.builder_diagnostics || []).map(diagnostic => ({ ...diagnostic })),
    };
  }

  const candidates: CrmNameEvidenceCandidate[] = [];
  const builderDiagnostics: CrmNameEvidenceBuilderDiagnostic[] = [];
  const orgId = clean(input.orgId);
  const entityId = clean(input.entityId);
  const email = clean(input.email);
  const domain = domainFromInput(input);
  const currentName = clean(input.currentName || input.rawName);
  const trigger = clean(input.trigger || input.source?.codepath || 'crm_name_resolution');
  let networkCalls = 0;

  let builderStarted = Date.now();
  let beforeBuilderCount = candidates.length;
  for (const runtimeCandidate of input.runtimeEvidenceCandidates || []) {
    addEvidenceCandidate(candidates, runtimeCandidate);
  }
  builderDiagnostics.push(builderDiagnostic('runtime_evidence_candidates', builderStarted, beforeBuilderCount, candidates.length));

  builderStarted = Date.now();
  beforeBuilderCount = candidates.length;
  for (const value of unique([
    clean(input.rawName),
    clean(input.currentName),
    clean(input.source?.source_text),
    ...(input.sourceNameCandidates || []).map(clean),
  ])) {
    addEvidenceCandidate(candidates, {
      value,
      entity_type: input.entityType,
      candidate_kind: input.entityType === 'contact' ? 'contact_name' : 'company_name',
      source_type: 'source_payload',
      source_channel: input.source?.source_channel || 'unknown',
      source_record_id: input.source?.source_record_id || null,
      source_text_excerpt: truncate(value, 160),
      confidence: input.source?.evidence_level === 'corroborated' ? 'medium' : 'weak',
      privacy_scope: 'source_payload',
      observed_at: null,
      rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
      cost_tier: 0,
    });
  }
  builderDiagnostics.push(builderDiagnostic('source_payload', builderStarted, beforeBuilderCount, candidates.length));

  if (input.entityType === 'contact') {
    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    const contactRows = orgId
      ? await allD1<Record<string, any>>(
        env,
        `SELECT id, full_name, email, linkedin_url, company_id, job_title, source,
                total_interactions, custom_fields, deleted_at, merged_into
           FROM contacts
          WHERE org_id = ?
            AND deleted_at IS NULL
            AND (? = '' OR id = ? OR LOWER(email) = LOWER(?))
          LIMIT 6`,
        orgId,
        entityId || email,
        entityId,
        email
      )
      : [];
    for (const row of contactRows) {
      const confidence = existingEntityConfidence(row);
      addEvidenceCandidate(candidates, {
        value: row.full_name,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'existing_crm_entity',
        source_channel: row.source || 'crm',
        source_record_id: row.id || null,
        source_text_excerpt: truncate(row.full_name, 160),
        confidence,
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
      const linkedInName = linkedInSlugCandidate(row.linkedin_url);
      if (linkedInName) {
        addEvidenceCandidate(candidates, {
          value: linkedInName,
          entity_type: 'contact',
          candidate_kind: 'contact_name',
          source_type: 'linkedin_slug',
          source_channel: 'crm_linkedin_url',
          source_record_id: row.id || null,
          source_text_excerpt: truncate(row.linkedin_url, 160),
          confidence: confidence === 'weak' ? 'medium' : 'strong',
          privacy_scope: 'org_owned',
          observed_at: null,
          rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
          cost_tier: 1,
        });
      }
    }
    builderDiagnostics.push(builderDiagnostic('existing_contact_entity', builderStarted, beforeBuilderCount, candidates.length));

    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    const eventRows = orgId
      ? await allD1<Record<string, any>>(
        env,
        `SELECT display_name, email, evidence_count, first_seen_at, last_seen_at, sample_event_titles, contact_id
           FROM crm_quality_event_name_evidence
          WHERE (? = '' OR contact_id = ? OR LOWER(email) = LOWER(?))
          LIMIT 12`,
        entityId || email,
        entityId,
        email
      )
      : [];
    for (const row of eventRows) {
      addEvidenceCandidate(candidates, {
        value: row.display_name,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'calendar_attendee',
        source_channel: 'calendar_event',
        source_record_id: row.contact_id || entityId || null,
        source_text_excerpt: truncate(row.sample_event_titles || row.display_name, 180),
        confidence: evidenceConfidenceFromCount(row.evidence_count),
        privacy_scope: 'org_owned',
        observed_at: row.last_seen_at || row.first_seen_at || null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
    }
    builderDiagnostics.push(builderDiagnostic('calendar_event_name_evidence', builderStarted, beforeBuilderCount, candidates.length));

    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    await addContactInteractionHistoryCandidates({
      candidates,
      input,
      env,
      orgId,
      entityId,
      email,
      currentName,
      includeBodies: includeNetwork,
    });
    builderDiagnostics.push(builderDiagnostic(
      includeNetwork ? 'contact_interaction_history_with_body_excerpt' : 'contact_interaction_history',
      builderStarted,
      beforeBuilderCount,
      candidates.length
    ));

    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    await addContactNeighborCandidates({ candidates, input, env, orgId, entityId, email, domain });
    builderDiagnostics.push(builderDiagnostic('contact_crm_neighbors', builderStarted, beforeBuilderCount, candidates.length));

    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    const surnameCandidate = firstNameDomainCandidate(email, domain);
    if (surnameCandidate) {
      addEvidenceCandidate(candidates, {
        value: surnameCandidate,
        entity_type: 'contact',
        candidate_kind: 'contact_name',
        source_type: 'domain_surname',
        source_channel: 'email_domain',
        source_record_id: input.source?.source_record_id || null,
        source_text_excerpt: email,
        confidence: 'medium',
        privacy_scope: 'source_payload',
        observed_at: null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
        cost_tier: 1,
      });
    }
    builderDiagnostics.push(builderDiagnostic('domain_surname', builderStarted, beforeBuilderCount, candidates.length));

    if (includeNetwork) {
      builderStarted = Date.now();
      beforeBuilderCount = candidates.length;
      const providerCalls = await addFirstPartyIdentityCandidates({ candidates, input, env, orgId, email });
      networkCalls += providerCalls;
      builderDiagnostics.push(builderDiagnostic(
        'first_party_identity',
        builderStarted,
        beforeBuilderCount,
        candidates.length,
        { networkCalls: providerCalls, skippedReason: providerCalls ? null : 'not_configured_or_unavailable' }
      ));
    }

    if (includeNetwork && shouldFetchContactPublicNameMetadata({ email, displayName: currentName || input.source?.source_text })) {
      builderStarted = Date.now();
      beforeBuilderCount = candidates.length;
      networkCalls += 1;
      const metadata = await fetchContactPublicNameMetadata({
        email,
        displayName: currentName || input.source?.source_text,
        timeoutMs: options.networkTimeoutMs ?? 2200,
      });
      for (const publicCandidate of metadata?.candidates || []) {
        addEvidenceCandidate(candidates, {
          value: publicCandidate.name,
          entity_type: 'contact',
          candidate_kind: 'contact_name',
          source_type: 'domain_owned_page',
          source_channel: 'public_domain_metadata',
          source_record_id: publicCandidate.sourceUrl || null,
          source_text_excerpt: truncate(publicCandidate.sourceText || publicCandidate.sourceUrl || '', 220),
          confidence: publicCandidate.confidence === 'strong' ? 'strong' : 'medium',
          privacy_scope: 'public',
          observed_at: null,
          rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
          cost_tier: 4,
        });
      }
      builderDiagnostics.push(builderDiagnostic('contact_public_domain_metadata', builderStarted, beforeBuilderCount, candidates.length, { networkCalls: 1 }));
    }
  } else {
    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    const companyRows = orgId
      ? await allD1<Record<string, any>>(
        env,
        `SELECT id, name, domain, website, company_type, investment_status,
                custom_fields, linked_contact_count, conversation_count, event_count, deal_count, document_count
           FROM companies
          WHERE org_id = ?
            AND deleted_at IS NULL
            AND (? = '' OR id = ? OR LOWER(domain) = LOWER(?) OR LOWER(website) LIKE LOWER(?))
          LIMIT 6`,
        orgId,
        entityId || domain,
        entityId,
        domain,
        domain ? `%${domain}%` : ''
      )
      : [];
    for (const row of companyRows) {
      addEvidenceCandidate(candidates, {
        value: row.name,
        entity_type: 'company',
        candidate_kind: 'company_name',
        source_type: 'existing_crm_entity',
        source_channel: 'crm_company',
        source_record_id: row.id || null,
        source_text_excerpt: truncate(`${row.name} ${row.domain || ''} ${row.website || ''}`, 180),
        confidence: companyEvidenceConfidence(row),
        privacy_scope: 'org_owned',
        observed_at: null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER],
        cost_tier: 1,
      });
    }
    builderDiagnostics.push(builderDiagnostic('existing_company_entity', builderStarted, beforeBuilderCount, candidates.length));

    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    await addCompanyNeighborCandidates({ candidates, input, env, orgId, entityId, domain });
    builderDiagnostics.push(builderDiagnostic('company_crm_neighbors', builderStarted, beforeBuilderCount, candidates.length));

    builderStarted = Date.now();
    beforeBuilderCount = candidates.length;
    const splitNames = splitCompoundCompanies(currentName);
    for (const splitName of splitNames) {
      addEvidenceCandidate(candidates, {
        value: splitName,
        entity_type: 'company',
        candidate_kind: 'split_candidate',
        source_type: 'local_parser',
        source_channel: input.source?.source_channel || 'compound_parser',
        source_record_id: input.source?.source_record_id || entityId || null,
        source_text_excerpt: truncate(currentName, 180),
        confidence: input.rootCause === 'compound_multi_entity_company_name' ? 'medium' : 'weak',
        privacy_scope: 'source_payload',
        observed_at: null,
        rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.COMPANY_COMPOUND],
        cost_tier: 0,
      });
    }
    builderDiagnostics.push(builderDiagnostic('company_compound_parser', builderStarted, beforeBuilderCount, candidates.length));

    if (includeNetwork && (domain || input.website)) {
      builderStarted = Date.now();
      beforeBuilderCount = candidates.length;
      networkCalls += 1;
      const metadata = await fetchCompanyWebsiteMetadata({
        domain: domain || null,
        website: input.website || null,
        timeoutMs: options.networkTimeoutMs ?? 1800,
      });
      for (const metadataName of parseMetadataNames(metadata)) {
        addEvidenceCandidate(candidates, {
          value: metadataName,
          entity_type: 'company',
          candidate_kind: 'company_name',
          source_type: 'domain_metadata',
          source_channel: 'public_domain_metadata',
          source_record_id: metadata?.finalUrl || metadata?.fetchUrl || domain || null,
          source_text_excerpt: truncate(metadataName, 180),
          confidence: metadata?.confidence === 'strong' ? 'strong' : 'medium',
          privacy_scope: 'public',
          observed_at: null,
          rule_ids: [CRM_QUALITY_RULES.EVIDENCE_LEDGER, CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
          cost_tier: 4,
        });
      }
      builderDiagnostics.push(builderDiagnostic('company_public_domain_metadata', builderStarted, beforeBuilderCount, candidates.length, { networkCalls: 1 }));
    }
  }

  const bundle: CrmNameEvidenceBundle = {
    org_id: orgId || null,
    entity_id: entityId || null,
    entity_type: input.entityType,
    trigger,
    email: email || null,
    domain: domain || null,
    website: input.website || null,
    current_name: currentName || null,
    candidates,
    budget_spent_ms: Date.now() - started,
    network_calls: networkCalls,
    cache_hits: 0,
    builder_diagnostics: builderDiagnostics,
    gold_used_at_runtime: false,
  };
  CRM_NAME_EVIDENCE_CACHE.set(cacheKey, {
    ...bundle,
    candidates: bundle.candidates.map(candidate => ({ ...candidate })),
    builder_diagnostics: (bundle.builder_diagnostics || []).map(diagnostic => ({ ...diagnostic })),
  });
  return bundle;
}

function inputWithEvidenceBundle(
  input: BuildCrmNameEvidenceBundleInput,
  bundle: CrmNameEvidenceBundle
): CrmNameResolutionInput {
  const sourceNames = bundle.candidates
    .filter(candidate => candidate.entity_type === input.entityType)
    .filter(candidate => candidate.candidate_kind === 'contact_name' || candidate.candidate_kind === 'company_name' || candidate.candidate_kind === 'split_candidate')
    .sort((a, b) => confidenceScore(b.confidence === 'strong' ? 'high' : b.confidence === 'medium' ? 'medium' : 'low') - confidenceScore(a.confidence === 'strong' ? 'high' : a.confidence === 'medium' ? 'medium' : 'low'))
    .map(candidate => candidate.value);
  return {
    ...input,
    sourceNameCandidates: unique([...(input.sourceNameCandidates || []), ...sourceNames]),
    evidenceCandidates: [...(input.evidenceCandidates || []), ...bundle.candidates],
  };
}

function resolutionNeedsEvidenceEscalation(
  input: BuildCrmNameEvidenceBundleInput,
  result: CrmNameResolutionResult
): boolean {
  if (result.status === 'provisional' || result.status === 'domain_placeholder' || result.status === 'fail') return true;

  if (input.entityType === 'company' && (input.domain || input.website)) {
    const raw = clean(input.rawName || input.currentName || input.source?.source_text);
    const weakCompanyInput = input.allowDomainPlaceholder
      || input.source?.evidence_level === 'weak_single_source'
      || looksLikeDomain(raw)
      || PAGE_TITLE_BOILERPLATE_RE.test(raw)
      || TITLE_SEPARATOR_RE.test(raw)
      || result.ruleIds.includes(CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER)
      || result.ruleIds.includes(CRM_QUALITY_RULES.COMPANY_PAGE_TITLE);
    const alreadyHasLiveMetadata = Boolean(input.websiteMetadata?.fetchedLive || input.websiteMetadata?.ok);
    if (weakCompanyInput && !alreadyHasLiveMetadata) return true;
  }

  return false;
}

function preferredProvisionalNetworkResult(result: CrmNameResolutionResult): boolean {
  if (result.status !== 'provisional' || !result.normalizedName) return false;
  return /^[a-z0-9]+\.[a-z0-9]+$/i.test(result.normalizedName)
    || /\b[A-Z]{2,}\s+[A-Z]{2,}\s+SpA\b/.test(result.normalizedName);
}

function annotateEvidenceCandidateFromResolution(
  evidenceCandidate: CrmNameEvidenceCandidate,
  resolutionResult: CrmNameResolutionResult
): CrmNameEvidenceCandidate {
  const evidenceValue = normalizeToken(evidenceCandidate.value);
  const matched = resolutionResult.candidates.find(candidateItem => {
    const sameValue = evidenceValue === normalizeToken(candidateItem.candidateName)
      || evidenceValue === normalizeToken(candidateItem.normalizedName)
      || normalizeToken(candidateItem.normalizedName) === normalizeToken(evidenceCandidate.value);
    if (!sameValue) return false;
    const sourceType = candidateEvidenceSource(candidateItem);
    return sourceType === evidenceCandidate.source_type
      || sourceType === 'unknown'
      || candidateItem.reason.includes(evidenceCandidate.source_type);
  }) || resolutionResult.candidates.find(candidateItem =>
    evidenceValue === normalizeToken(candidateItem.candidateName)
    || evidenceValue === normalizeToken(candidateItem.normalizedName)
  );
  return {
    ...evidenceCandidate,
    semantic_class: matched?.semantic_class,
    risk_flags: matched?.risk_flags,
    verification_decision: matched?.verification_decision,
    verification_block_reason: matched?.verification_block_reason,
    status_before_firewall: matched?.status_before_firewall,
    status_after_firewall: matched?.status_after_firewall,
  };
}

function shouldAdoptNetworkResolution(
  input: BuildCrmNameEvidenceBundleInput,
  localResult: CrmNameResolutionResult,
  networkResult: CrmNameResolutionResult
): boolean {
  if (networkResult.status === 'fail' || networkResult.status === 'no_entity' || !networkResult.normalizedName) return false;
  if (localResult.status !== 'verified') {
    return confidenceScore(networkResult.confidence) >= confidenceScore(localResult.confidence);
  }

  const localScore = selectedScore(localResult);
  const networkScore = selectedScore(networkResult);
  const localIsWeakCompanyFallback = input.entityType === 'company' && (
    selectedReasonMatches(localResult, /domain stem|page title|placeholder|company string normalized/i)
    || localResult.ruleIds.includes(CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER)
    || localResult.ruleIds.includes(CRM_QUALITY_RULES.COMPANY_PAGE_TITLE)
  );

  if (networkResult.status === 'verified') {
    if (networkScore > localScore) return true;
    return localIsWeakCompanyFallback && networkScore >= localScore;
  }

  if (preferredProvisionalNetworkResult(networkResult)) {
    return localIsWeakCompanyFallback && networkScore >= localScore + 5;
  }

  return false;
}

export async function resolveCrmEntityNameWithEvidence(
  input: BuildCrmNameEvidenceBundleInput,
  env?: Env,
  options: BuildCrmNameEvidenceBundleOptions = {}
): Promise<CrmNameResolutionWithEvidence> {
  const started = options.startTimeMs ?? Date.now();
  const localBundle = await buildCrmNameEvidenceBundle(input, env, {
    ...options,
    includeNetwork: false,
    startTimeMs: started,
  });
  let resolutionResult = resolveCrmEntityName(inputWithEvidenceBundle(input, localBundle));
  let finalBundle = localBundle;

  if (options.includeNetwork !== false && resolutionNeedsEvidenceEscalation(input, resolutionResult)) {
    const networkBundle = await buildCrmNameEvidenceBundle(input, env, {
      ...options,
      includeNetwork: true,
      startTimeMs: started,
    });
    const networkResult = resolveCrmEntityName(inputWithEvidenceBundle(input, networkBundle));
    if (shouldAdoptNetworkResolution(input, resolutionResult, networkResult)) {
      resolutionResult = networkResult;
      finalBundle = networkBundle;
    }
  }

  finalBundle = {
    ...finalBundle,
    candidates: finalBundle.candidates.map(candidate => ({
      ...annotateEvidenceCandidateFromResolution(candidate, resolutionResult),
      accepted: Boolean(
        resolutionResult.normalizedName
        && normalizeToken(candidate.value) === normalizeToken(resolutionResult.normalizedName)
      ),
    })),
    budget_spent_ms: Date.now() - started,
  };
  CRM_NAME_EVIDENCE_BUNDLE_LOG.push(finalBundle);
  return { resolution: resolutionResult, evidenceBundle: finalBundle };
}

function resolveCompany(input: CrmNameResolutionInput): CrmNameResolutionResult {
  const raw = clean(input.rawName || input.currentName);
  const domain = domainFromInput(input) || (looksLikeDomain(raw) ? normalizeDomain(raw) : '');
  if (input.mergeTargetId) {
    return resolution(input, 'merge', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.DEDUP],
      reasons: ['duplicate company target already identified'],
    });
  }
  if (input.deleteReason || input.rootCause === 'service_or_invalid_domain_company_creation') {
    return resolution(input, 'no_entity', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN],
      reasons: [input.deleteReason || 'service/vendor/test company should not be created'],
    });
  }
  if (domain && (isAutomatedDomain(domain) || isInvalidPublicSuffixLike(domain))) {
    return resolution(input, 'no_entity', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN],
      reasons: [`service or invalid domain cannot create canonical company: ${domain}`],
    });
  }

  const candidates: CrmNameCandidate[] = [];
  const shouldTryDomainBrand = Boolean(input.rootCause)
    || Boolean(input.allowDomainPlaceholder)
    || Boolean(raw && (!looksLikeDomain(raw) || PAGE_TITLE_BOILERPLATE_RE.test(raw)))
    || Boolean(input.websiteMetadata?.ok);
  const domainBrand = shouldTryDomainBrand ? domainBrandCandidate(domain) : null;
  const metadataHostTrusted = metadataHostMatchesInput(input.websiteMetadata, domain);
  const domainBrandHasCompanySignal = domainBrand
    ? COMPANY_INDICATOR_RE.test(domainBrand) || /\b(inc|llc|ltd|corp|corporation|co|plc|group)\b/i.test(domainBrand)
    : false;
  const domainBrandIsDottedBrand = Boolean(domainBrand && /^[a-z0-9]+\.[a-z0-9]+$/i.test(domainBrand));
  const domainBrandShortAcronymFund = Boolean(domainBrand && /^[A-Z]{2,3}\s+Funds?$/i.test(domainBrand));
  const domainBrandVerified = Boolean(domainBrand && (
    (domainBrandIsDottedBrand && !input.rootCause)
    || (
      !domainBrandIsDottedBrand
      && domainBrandHasCompanySignal
      && !domainBrandShortAcronymFund
      && !plainDomainStemCandidate(domainBrand, domain, false)
      && !compressedDomainStemVariant(domainBrand, domain)
    )
  ));
  const domainTld = normalizeDomain(domain).split('.').pop() || '';
  const domainBrandShouldBeProvisional = Boolean(
    domainBrand
    && !['com', 'io', 'me'].includes(domainTld)
    && /\bInvest\b/.test(domainBrand)
    && !input.websiteMetadata?.ok
  );
  const metadataNames = parseMetadataNames(input.websiteMetadata);
  const dottedDomainStem = domainBrandIsDottedBrand ? (domainBrand || '').split('.')[0] || '' : '';
  const dottedDomainHasUndottedMetadata = Boolean(
    dottedDomainStem
    && [
      ...metadataNames,
      ...(input.evidenceCandidates || [])
        .filter(candidate => candidate.entity_type === 'company' && candidate.source_type === 'domain_metadata')
        .map(candidate => candidate.value),
    ].some(value => {
      const normalized = metadataBrandCandidate(clean(value), domain) || normalizeCompanyName(clean(value));
      return normalized && normalizedCompact(normalized) === normalizedCompact(dottedDomainStem);
    })
  );
  const ambiguousPageTitleSelections = new Set<string>();
  const rememberAmbiguousSelection = (value: string): void => {
    const normalized = metadataBrandCandidate(value, domain);
    if (normalized && pageTitleHasCompetingNameBeforeSelection(value, normalized)) {
      ambiguousPageTitleSelections.add(normalizedCompact(normalized));
    }
  };
  for (const evidenceCandidate of input.evidenceCandidates || []) {
    if (evidenceCandidate.entity_type === 'company' && evidenceCandidate.source_type === 'domain_metadata') {
      rememberAmbiguousSelection(clean(evidenceCandidate.value));
    }
  }
  metadataNames.forEach(rememberAmbiguousSelection);
  if (domainBrand && !input.rootCause && companyStringLooksLikeCompetingIdentity(raw, domainBrand)) {
    ambiguousPageTitleSelections.add(normalizedCompact(domainBrand));
  }

  for (const evidenceCandidate of input.evidenceCandidates || []) {
    if (evidenceCandidate.entity_type !== 'company') continue;
    if (!['company_name', 'company_alias', 'split_candidate', 'domain_placeholder'].includes(evidenceCandidate.candidate_kind)) continue;
    const value = clean(evidenceCandidate.value);
    if (!value) continue;

    let normalized = evidenceCandidate.candidate_kind === 'domain_placeholder'
      ? domainPlaceholderName(value)
      : evidenceCandidate.source_type === 'domain_metadata'
        ? metadataBrandCandidate(value, domain)
      : evidenceCandidate.source_type === 'existing_crm_entity' || evidenceCandidate.source_type === 'crm_neighbor'
        ? splitCompoundCompany(value) || pageTitleCandidate(value) || normalizeCompanyName(value)
        : splitCompoundCompany(value)
          || metadataBrandCandidate(value, domain)
          || pageTitleCandidate(value)
          || normalizeCompanyName(value);
    if (
      normalized
      && domainBrand
      && /\s+&\s+/.test(normalized)
      && normalizedCompact(normalized.replace(/\s+&\s+/g, ' and ')) === normalizedCompact(domainBrand)
    ) {
      normalized = domainBrand;
    }
    if (!normalized || normalized.length < 2 || metadataRejected(normalized)) continue;

    const dottedBrand = /^[a-z0-9]+\.[a-z0-9]+$/i.test(normalized);
    const looksDomainOnly = looksLikeDomain(normalized) && !dottedBrand;
    if (looksDomainOnly && evidenceCandidate.candidate_kind !== 'domain_placeholder') continue;

    const cleanSourcePayload = evidenceCandidate.source_type === 'source_payload'
      && !input.rootCause
      && sourceCompanyNameLooksUseful(normalized, domain);
    const sourcePayloadCorroborated = cleanSourcePayload
      && metadataCorroboratesCompanyName(normalized, input.websiteMetadata, domain);
    const weakMetadataCandidate = evidenceCandidate.source_type === 'domain_metadata'
      && weakMetadataCompanyName(normalized, value, domain, false);
    const forceProvisional = (
      evidenceCandidate.source_type === 'source_payload'
      && evidenceCandidate.confidence === 'weak'
      && input.source?.evidence_level === 'weak_single_source'
      && !sourcePayloadCorroborated
    ) || (
      evidenceCandidate.candidate_kind === 'split_candidate'
      && input.rootCause === 'compound_multi_entity_company_name'
    ) || (
      evidenceCandidate.source_type === 'domain_metadata'
      && ambiguousPageTitleSelections.has(normalizedCompact(normalized))
    ) || (
      weakMetadataCandidate
    );
    const legalAcronymProvisional = /\b[A-Z]{2,}\s+[A-Z]{2,}\s+SpA\b/.test(normalized);
    let metadataDerivedStatus = evidenceCandidate.source_type === 'domain_metadata'
      ? metadataStatus(normalized, {
        confidence: evidenceCandidate.confidence === 'weak' ? 'weak' : 'strong',
      }, {
        rawValue: value,
        domain,
      })
      : null;
    if (metadataDerivedStatus && dottedBrand && lower(normalized) === normalizeDomain(domain)) {
      metadataDerivedStatus = 'verified';
    }
    if (
      metadataDerivedStatus
      && evidenceCandidate.source_type === 'domain_metadata'
      && !dottedBrand
      && !normalized.includes('-')
      && (normalized.match(/[A-Za-z0-9&'.-]+/g) || []).length === 1
      && !COMPANY_INDICATOR_RE.test(normalized)
      && !['com', 'io', 'me'].includes(normalizeDomain(domain).split('.').pop() || '')
    ) {
      metadataDerivedStatus = 'provisional';
    }
    const status: Exclude<CrmNameResolutionStatus, 'merge' | 'no_entity' | 'fail'> = evidenceCandidate.candidate_kind === 'domain_placeholder'
      ? 'domain_placeholder'
      : sourcePayloadCorroborated
        ? 'verified'
      : forceProvisional
        ? 'provisional'
      : metadataDerivedStatus
        ? metadataDerivedStatus
      : evidenceCandidate.confidence === 'weak'
        || legalAcronymProvisional
        ? 'provisional'
        : 'verified';
    const metadataSourceHostTrusted = evidenceCandidate.source_type !== 'domain_metadata'
      || metadataSourceHostMatchesDomain(evidenceCandidate.source_record_id, domain);
    const normalizedDomainBrand = normalizedCompact(domainBrand || '');
    const normalizedCandidate = normalizedCompact(normalized);
    const existingCrmDescriptorPenalty = evidenceCandidate.source_type === 'existing_crm_entity'
      && normalizedDomainBrand
      && normalizedCandidate.endsWith(normalizedDomainBrand)
      && normalizedCandidate !== normalizedDomainBrand
      && !/\b(inc|llc|ltd|corp|corporation|spA|sgr|foundation)\b/i.test(normalized)
      ? -28
      : 0;
    const baseScore = evidenceCandidate.source_type === 'domain_metadata'
      ? metadataCandidateScore({
        normalized,
        raw: value,
        index: 0,
        rawInput: raw,
        domainBrand,
        hostMatches: metadataSourceHostTrusted,
        weakMetadata: weakMetadataCandidate,
      })
      : evidenceBaseScore(evidenceCandidate);
    const undottedDottedBrandBoost = dottedDomainStem && normalizedCompact(normalized) === normalizedCompact(dottedDomainStem) ? 48 : 0;
    const exactDomainBrandMetadataBoost = evidenceCandidate.source_type === 'domain_metadata'
      && domainBrand
      && !domainBrandIsDottedBrand
      && !domainBrandShortAcronymFund
      && normalizedCompact(normalized) === normalizedCompact(domainBrand)
      ? 42
      : 0;
    const score = baseScore
      + (evidenceCandidate.candidate_kind === 'split_candidate' && input.rootCause === 'compound_multi_entity_company_name' ? 8 : 0)
      + (legalAcronymProvisional ? 52 : 0)
      + (cleanSourcePayload ? (sourcePayloadCorroborated ? 48 : 38) : 0)
      + undottedDottedBrandBoost
      + exactDomainBrandMetadataBoost
      + existingCrmDescriptorPenalty
      + (status === 'verified' ? 0 : -8);
    candidates.push(candidate(input, {
      candidateName: value,
      normalizedName: normalized,
      status,
      confidence: evidenceQualityConfidence(evidenceCandidate.confidence),
      score,
      ruleIds: evidenceCandidateRuleIds(evidenceCandidate, status === 'provisional' ? [CRM_QUALITY_RULES.PROVISIONAL_NAME] : []),
      reason: `${evidenceCandidate.source_type} evidence candidate resolved company name`,
    }));
  }

  const schemaMetadataNames = new Set(
    (Array.isArray(input.websiteMetadata?.schemaNames)
      ? input.websiteMetadata?.schemaNames || []
      : clean(input.websiteMetadata?.schemaNames).split('|'))
      .map(name => clean(name))
      .filter(Boolean)
  );
  metadataNames.forEach((metadataName, index) => {
    const normalized = metadataBrandCandidate(metadataName, domain);
    if (!normalized) return;
    const metadataMatchesDomainBrand = Boolean(domainBrand && normalizedCompact(normalized) === normalizedCompact(domainBrand));
    const dottedBrand = /^[a-z0-9]+\.[a-z0-9]+$/i.test(normalized);
    const pageDerived = normalizedCompact(pageTitleCandidate(metadataName) || '') === normalizedCompact(normalized);
    const strongExplicitMetadata = metadataNameIsStrongExplicitField(metadataName, input.websiteMetadata);
    const weakMetadataCandidate = weakMetadataCompanyName(normalized, metadataName, domain, strongExplicitMetadata);
    const baseStatus = metadataStatus(normalized, input.websiteMetadata, {
      rawValue: metadataName,
      domain,
      strongExplicitMetadata,
    });
    const ambiguousPageTitleSelection = ambiguousPageTitleSelections.has(normalizedCompact(normalized));
    const status = ambiguousPageTitleSelection
      ? 'provisional'
      : metadataMatchesDomainBrand && domainBrandVerified && !dottedBrand && !weakMetadataCandidate
      ? 'verified'
      : baseStatus === 'provisional' && pageDerived && metadataHostTrusted && !dottedBrand && !weakMetadataCandidate && !/\b[A-Z]{2,}\s+[A-Z]{2,}\s+SpA\b/.test(normalized)
      ? 'verified'
      : baseStatus;
    candidates.push(candidate(input, {
      candidateName: metadataName,
      normalizedName: normalized,
      status,
      confidence: status === 'verified' ? 'medium' : 'low',
      score: metadataCandidateScore({
        normalized,
        raw: metadataName,
        index,
        rawInput: raw,
        domainBrand,
        hostMatches: metadataHostTrusted,
        weakMetadata: weakMetadataCandidate,
      })
        + (schemaMetadataNames.has(metadataName) && !metadataMatchesDomainBrand && COMPANY_INDICATOR_RE.test(normalized) ? 8 : 0)
        + (dottedDomainStem && normalizedCompact(normalized) === normalizedCompact(dottedDomainStem) ? 48 : 0)
        + (domainBrand && !domainBrandIsDottedBrand && !domainBrandShortAcronymFund && normalizedCompact(normalized) === normalizedCompact(domainBrand) ? 42 : 0),
      ruleIds: [
        CRM_QUALITY_RULES.COMPANY_PAGE_TITLE,
        ...(status === 'provisional' ? [CRM_QUALITY_RULES.PROVISIONAL_NAME] : []),
      ],
      reason: 'website metadata resolved to organization brand candidate',
    }));
  });

  const fusedPage = pageTitleDomainFusionCandidate(raw, domain);
  if (fusedPage) {
    candidates.push(candidate(input, {
      candidateName: raw,
      normalizedName: fusedPage,
      status: 'verified',
      confidence: 'medium',
      score: 102,
      ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
      reason: 'page title brand fragment fused with domain brand and retained tagline',
    }));
  }

  const domainSegmentPage = pageTitleDomainSegmentCandidate(raw, domain);
  if (domainSegmentPage) {
    candidates.push(candidate(input, {
      candidateName: raw,
      normalizedName: domainSegmentPage,
      status: 'verified',
      confidence: 'medium',
      score: 112,
      ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
      reason: 'page title segment matched domain brand',
    }));
  }

  const page = pageTitleCandidate(raw);
  if (page) {
    candidates.push(candidate(input, {
      candidateName: raw,
      normalizedName: page,
      status: 'verified',
      confidence: 'medium',
      score: 96,
      ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
      reason: 'page title stripped to brand segment',
    }));
  }

  const splitNames = splitCompoundCompanies(raw);
  const compound = splitNames[0] || '';
  if (compound) {
    candidates.push(candidate(input, {
      candidateName: raw,
      normalizedName: compound,
      status: 'provisional',
      confidence: 'low',
      score: 70,
      ruleIds: [CRM_QUALITY_RULES.COMPANY_COMPOUND, CRM_QUALITY_RULES.PROVISIONAL_NAME],
      reason: 'compound company string split to first plausible organization pending corroboration',
    }));
  }

  if (domainBrand && lower(domainBrand) !== lower(raw)) {
    const rawHasExactDomainBrand = lower(input.rawName || input.currentName || input.source?.source_text).includes(lower(domainBrand));
    const outputDomainBrand = domainBrandIsDottedBrand && !domainBrandVerified && !rawHasExactDomainBrand && !dottedDomainHasUndottedMetadata
      ? titleCase((domainBrand.split('.')[0] || domainBrand))
      : domainBrand;
    const domainBrandAmbiguous = ambiguousPageTitleSelections.has(normalizedCompact(domainBrand));
    const domainBrandStatus = domainBrandVerified && !domainBrandShouldBeProvisional && !domainBrandAmbiguous && !dottedDomainHasUndottedMetadata ? 'verified' : 'provisional';
    const domainBrandScore = domainBrandVerified
      ? dottedDomainHasUndottedMetadata ? 58 : 92
      : domainBrandHasCompanySignal || domainBrandIsDottedBrand
        ? 68
        : 62;
    candidates.push(candidate(input, {
      candidateName: domain,
      normalizedName: outputDomainBrand,
      status: domainBrandStatus,
      confidence: domainBrandStatus === 'verified' ? 'medium' : 'low',
      score: domainBrandScore,
      ruleIds: [
        CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER,
        ...(domainBrandStatus === 'verified' ? [] : [CRM_QUALITY_RULES.PROVISIONAL_NAME]),
      ],
      reason: domainBrandStatus === 'verified'
        ? 'domain stem corroborated by reachable website metadata'
        : 'domain stem converted into tentative company brand candidate',
    }));
  }

  if (domain && (looksLikeDomain(raw) || input.allowDomainPlaceholder || input.rootCause === 'domain_placeholder_not_canonicalized')) {
    candidates.push(candidate(input, {
      candidateName: domain,
      normalizedName: domainPlaceholderName(domain),
      status: 'domain_placeholder',
      confidence: 'medium',
      score: 60,
      ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER],
      reason: 'domain retained as tentative placeholder pending canonical evidence',
    }));
  }

  if (raw && !looksLikeDomain(raw) && !PAGE_TITLE_BOILERPLATE_RE.test(raw) && !splitCompoundCompany(raw)) {
    const normalized = normalizeCompanyName(raw);
    if (normalized && normalized.length >= 2) {
      const legalAcronymProvisional = /\b[A-Z]{2,}\s+[A-Z]{2,}\s+SpA\b/.test(normalized);
      const sourceSingleTokenBrand = companyNameTokenCount(normalized) === 1
        && /^[A-Z][A-Za-z0-9'.-]{2,}$/.test(normalized)
        && !GENERIC_SINGLE_TOKEN_METADATA_RE.test(normalized)
        && !metadataRejected(normalized);
      const usefulSourceName = !input.rootCause && sourceCompanyNameLooksUseful(normalized, domain);
      const sourceCorroborated = (usefulSourceName || sourceSingleTokenBrand) && metadataCorroboratesCompanyName(normalized, input.websiteMetadata, domain);
      const weakSourceProvisional = input.source?.evidence_level === 'weak_single_source' && !sourceCorroborated && !input.websiteMetadata?.ok;
      const uncorroboratedRootCauseSource = Boolean(input.rootCause && !sourceCorroborated);
      const sourcePreferenceScore = usefulSourceName
        ? sourceCorroborated
          ? 104
          : input.websiteMetadata?.ok
            ? 96
            : 88
        : sourceSingleTokenBrand
          ? sourceCorroborated
            ? 94
            : 72
        : input.rootCause === 'domain_placeholder_not_canonicalized'
          ? 84
          : 50;
      candidates.push(candidate(input, {
        candidateName: raw,
        normalizedName: normalized,
        status: legalAcronymProvisional || sourceSingleTokenBrand || weakSourceProvisional || uncorroboratedRootCauseSource ? 'provisional' : 'verified',
        confidence: legalAcronymProvisional || sourceSingleTokenBrand || weakSourceProvisional || uncorroboratedRootCauseSource ? 'low' : 'medium',
        score: legalAcronymProvisional ? 105 : sourcePreferenceScore,
        ruleIds: legalAcronymProvisional || sourceSingleTokenBrand || weakSourceProvisional || uncorroboratedRootCauseSource ? [CRM_QUALITY_RULES.PROVISIONAL_NAME] : [],
        reason: usefulSourceName
          ? 'clean source company name retained over weaker metadata candidates'
          : sourceSingleTokenBrand
            ? 'single-token source company brand retained as tentative name'
          : 'company string normalized without root-cause-specific rewrite',
      }));
    }
  }

  const firewalledCandidates = candidates.map(item => verifyCandidate(input, item));
  const selected = best(firewalledCandidates.filter(verifiedSelectable));
  if (!selected) {
    return resolution(input, 'fail', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.SAFE_HOLD],
      reasons: ['no useful company name candidate could be resolved'],
      candidates: firewalledCandidates,
    });
  }
  const splitSelectionHasStrongCorroboration = input.rootCause === 'compound_multi_entity_company_name'
    && splitNames.length > 1
    && selected.status === 'verified'
    && selected.score >= 92
    && splitNames.some(name => normalizedCompact(name) === normalizedCompact(selected.normalizedName))
    && /(domain_metadata|existing_crm_entity|crm_neighbor|website metadata)/i.test(selected.reason);
  const splitOutputShouldStayProvisional = input.rootCause === 'compound_multi_entity_company_name'
    && splitNames.length > 1
    && !splitSelectionHasStrongCorroboration;
  return resolution(input, splitOutputShouldStayProvisional ? 'provisional' : selected.status, {
    normalizedName: selected.normalizedName,
    confidence: splitOutputShouldStayProvisional ? 'low' : selected.confidence,
    ruleIds: splitOutputShouldStayProvisional ? unique([...selected.ruleIds, CRM_QUALITY_RULES.PROVISIONAL_NAME]) : selected.ruleIds,
    reasons: [
      splitOutputShouldStayProvisional
        ? 'compound company string has multiple organizations; split output remains tentative/provisional'
        : selected.verification_block_reason
          ? `${selected.reason}; ${selected.verification_block_reason}`
          : selected.reason,
    ],
    candidates: firewalledCandidates,
    splitNames: splitNames.length > 1 ? splitNames : undefined,
  });
}

function resolveContact(input: CrmNameResolutionInput): CrmNameResolutionResult {
  const raw = clean(input.rawName || input.currentName);
  const email = clean(input.email);
  const domain = domainFromInput(input);
  const local = localPart(email);
  const sourceText = clean(input.source?.source_text);
  const displayInputs = unique([raw, sourceText, input.currentName || '', ...(input.sourceNameCandidates || [])]);

  const automatedLocal = local && AUTOMATED_LOCAL_NAMES.has(local.replace(/[._-]+/g, ''));
  const automatedDomain = domain && isAutomatedDomain(domain);
  const candidates: CrmNameCandidate[] = [];
  const hasRelationshipEvidence = Boolean(
    input.relationshipEvidence
    || input.source?.evidence_level === 'weak_single_source'
    || input.source?.evidence_level === 'corroborated'
  );
  const independentEvidenceSourcesByName = new Map<string, Set<CrmNameEvidenceSourceType>>();
  for (const evidenceCandidate of input.evidenceCandidates || []) {
    if (evidenceCandidate.entity_type !== 'contact' || evidenceCandidate.candidate_kind !== 'contact_name') continue;
    const display = displayContactCandidate(evidenceCandidate.value, false) || displayContactCandidate(evidenceCandidate.value, true);
    if (!display || !contactNameIsFullPerson(display) || evidenceCandidate.confidence === 'weak') continue;
    const key = normalizeToken(display);
    const bucket = independentEvidenceSourcesByName.get(key) || new Set<CrmNameEvidenceSourceType>();
    bucket.add(evidenceCandidate.source_type);
    independentEvidenceSourcesByName.set(key, bucket);
  }

  if (input.rootCause === 'automated_shared_mailbox_contact_creation') {
    return resolution(input, 'no_entity', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_AUTOMATED],
      reasons: ['automated/shared-mailbox root cause should not create a person contact'],
    });
  }

  for (const evidenceCandidate of input.evidenceCandidates || []) {
    if (evidenceCandidate.entity_type !== 'contact' || evidenceCandidate.candidate_kind !== 'contact_name') continue;
    const value = clean(evidenceCandidate.value);
    if (!value) continue;
    const directory = directoryContactCandidate(value);
    const display = directory || displayContactCandidate(value, false) || displayContactCandidate(value, true);
    if (!display) continue;

    const fullPerson = contactNameIsFullPerson(display);
    const emailCorroborated = fullPerson && email ? displayEmailCorroboratedCandidate(display, email) : null;
    const normalizedName = emailCorroborated || display;
    if (!contactNameLooksUseful(normalizedName, true)) continue;

    const singleToken = personTokens(normalizedName).filter(token => token.replace(/\./g, '').length >= 2).length === 1;
    const sameAsRawOrLocal = normalizeToken(value) === normalizeToken(raw)
      || normalizeToken(normalizedName) === normalizeToken(raw)
      || (local && normalizeToken(value) === normalizeToken(local))
      || (local && normalizeToken(normalizedName) === normalizeToken(local));
    const existingCrmSelfEvidence = evidenceCandidate.source_type === 'existing_crm_entity'
      && sameAsRawOrLocal
      && (!fullPerson || contactNameScoreForEmail(normalizedName, email, raw) < 76);
    const independentSourceCount = independentEvidenceSourcesByName.get(normalizeToken(normalizedName))?.size || 0;
    const simplerVariantAvailable = evidenceCandidate.source_type === 'domain_owned_page'
      && hasSimplerPublicNameVariant(normalizedName, (input.evidenceCandidates || [])
        .filter(candidate => candidate.source_type === 'domain_owned_page' && candidate.entity_type === 'contact')
        .map(candidate => ({
          name: candidate.value,
          sourceUrl: candidate.source_record_id || null,
          sourceText: candidate.source_text_excerpt || null,
          sourceType: 'domain_owned_page',
          confidence: candidate.confidence === 'strong' ? 'strong' : 'weak',
        })));
    const verifiedByEvidence = !singleToken
      && !existingCrmSelfEvidence
      && (
        evidenceCandidate.confidence === 'strong'
        || independentSourceCount >= 2
        || evidenceCandidate.confidence === 'medium'
        || evidenceCandidate.source_type === 'email_signature'
        || evidenceCandidate.source_type === 'quoted_header'
        || evidenceCandidate.source_type === 'first_party_identity'
        || evidenceCandidate.source_type === 'linkedin_slug'
        || evidenceCandidate.source_type === 'domain_owned_page'
      );
    const status: Exclude<CrmNameResolutionStatus, 'merge' | 'no_entity' | 'fail'> = verifiedByEvidence ? 'verified' : 'provisional';
    const score = evidenceBaseScore(evidenceCandidate)
      + (emailCorroborated ? 9 : 0)
      + (directory ? 7 : 0)
      + (singleToken ? -18 : 0)
      + (existingCrmSelfEvidence ? -28 : 0)
      + (independentSourceCount >= 2 ? 12 : 0)
      + (simplerVariantAvailable ? -4 : 0)
      + (status === 'verified' ? 0 : -6);
    candidates.push(candidate(input, {
      candidateName: value,
      normalizedName,
      status,
      confidence: evidenceQualityConfidence(evidenceCandidate.confidence),
      score,
      ruleIds: evidenceCandidateRuleIds(evidenceCandidate, [
        ...(emailCorroborated || evidenceCandidate.source_type === 'domain_surname' ? [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART] : []),
        ...(directory ? [CRM_QUALITY_RULES.CONTACT_DIRECTORY_NAME] : []),
        ...(status === 'provisional' ? [CRM_QUALITY_RULES.PROVISIONAL_NAME] : []),
      ]),
      reason: `${evidenceCandidate.source_type} evidence candidate resolved contact name`,
    }));
  }

  const publicCandidates = input.contactPublicMetadata?.candidates || [];
  for (const publicCandidate of publicCandidates) {
    const publicName = displayContactCandidate(publicCandidate.name, false);
    if (!publicName) continue;
    const score = contactNameScoreForEmail(publicName, email, raw);
    if (score < 76) continue;
    const simplerVariantAvailable = hasSimplerPublicNameVariant(publicName, publicCandidates);
    const verifiedByPublicEvidence = score >= 88
      || publicCandidate.confidence === 'strong'
      || isSingleFirstNamePublicMatch({
        candidate: publicCandidate,
        candidateName: publicName,
        email,
        allCandidates: publicCandidates,
      });
    candidates.push(candidate(input, {
      candidateName: publicCandidate.name,
      normalizedName: publicName,
      status: verifiedByPublicEvidence ? 'verified' : 'provisional',
      confidence: verifiedByPublicEvidence ? 'medium' : 'low',
      score: Math.min(99, 88 + Math.floor(score / 10)) - (simplerVariantAvailable ? 1 : 0),
      ruleIds: [
        CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART,
        ...(verifiedByPublicEvidence ? [] : [CRM_QUALITY_RULES.PROVISIONAL_NAME]),
      ],
      reason: 'domain-owned public people metadata corroborated the contact name',
    }));
  }

  for (const value of displayInputs) {
    const serviceStripped = serviceStrippedContactCandidate(value);
    if (serviceStripped) {
      candidates.push(candidate(input, {
        candidateName: value,
        normalizedName: serviceStripped,
        status: 'verified',
        confidence: 'medium',
        score: 94,
        ruleIds: [],
        reason: 'service suffix stripped from full display name',
      }));
    }

    const viaStripped = displayContactCandidate(value, false);
    if (viaStripped) {
      const fullPerson = contactNameIsFullPerson(viaStripped);
      const emailCorroborated = fullPerson ? displayEmailCorroboratedCandidate(viaStripped, email) : null;
      if (emailCorroborated && emailCorroborated !== viaStripped) {
        candidates.push(candidate(input, {
          candidateName: value,
          normalizedName: emailCorroborated,
          status: 'verified',
          confidence: 'medium',
          score: 97,
          ruleIds: [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
          reason: 'full display name collapsed to email-corroborated first/last name',
        }));
      }
      candidates.push(candidate(input, {
        candidateName: value,
        normalizedName: viaStripped,
        status: fullPerson ? 'verified' : 'provisional',
        confidence: fullPerson ? 'medium' : 'low',
        score: fullPerson ? 92 : 55,
        ruleIds: fullPerson ? [] : [CRM_QUALITY_RULES.PROVISIONAL_NAME],
        reason: SERVICE_SUFFIX_RE.test(value)
          ? 'service suffix stripped from display name'
          : 'person-like display name retained',
      }));
    }

    const directory = directoryContactCandidate(value);
    if (directory) {
      candidates.push(candidate(input, {
        candidateName: value,
        normalizedName: directory,
        status: 'verified',
        confidence: 'medium',
        score: 98,
        ruleIds: [CRM_QUALITY_RULES.CONTACT_DIRECTORY_NAME],
        reason: 'directory last-first/rank display name normalized',
      }));
    }
  }

  const rawAlreadyUseful = displayInputs.some(value => contactNameLooksUseful(clean(value).replace(SERVICE_SUFFIX_RE, ''), false));
  const localAllowedByShape = hasRelationshipEvidence && (
    !rawAlreadyUseful
    || input.rootCause === 'email_local_part_used_as_contact_name'
    || input.rootCause === 'single_token_or_partial_contact_name'
    || displayInputs.some(value => /^[A-Za-z]\.[A-Za-z]{2,}\b/.test(clean(value)))
    || displayInputs.some(value => /@|^[a-z0-9._-]+$/i.test(clean(value)))
  );
  const fromLocal = localAllowedByShape ? localPartContactCandidate(email, raw, {
    preferSingleToken: input.rootCause === 'single_token_or_partial_contact_name',
  }) : null;
  if (fromLocal && !automatedLocal) {
    const singleToken = personTokens(fromLocal).length === 1;
    const localCorroborated = localPartNameCorroboratedByDisplay(fromLocal, local, displayInputs);
    candidates.push(candidate(input, {
      candidateName: local || raw,
      normalizedName: fromLocal,
      status: localCorroborated ? 'verified' : 'provisional',
      confidence: localCorroborated ? 'medium' : 'low',
      score: localCorroborated ? 91 : singleToken ? 45 : 75,
      ruleIds: [
        CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART,
        ...(localCorroborated ? [] : [CRM_QUALITY_RULES.PROVISIONAL_NAME]),
      ],
      reason: singleToken
        ? 'single-token contact name derived from relationship email and marked tentative'
        : localCorroborated
        ? 'email local-part parsed into person name corroborated by source display'
        : 'email local-part parsed into tentative person name',
    }));
  }

  const firewalledCandidates = candidates.map(item => verifyCandidate(input, item));
  const selected = best(firewalledCandidates.filter(item => verifiedSelectable(item) && contactNameLooksUseful(item.normalizedName, true)));
  if (selected) {
    return resolution(input, selected.status, {
      normalizedName: selected.normalizedName,
      confidence: selected.confidence,
      ruleIds: selected.ruleIds,
      reasons: [selected.verification_block_reason ? `${selected.reason}; ${selected.verification_block_reason}` : selected.reason],
      candidates: firewalledCandidates,
    });
  }

  if (automatedLocal || automatedDomain || firewalledCandidates.some(item => item.verification_decision === 'no_entity')) {
    return resolution(input, 'no_entity', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_AUTOMATED],
      reasons: ['automated, platform, shared-mailbox, or non-person contact should not be created'],
      candidates: firewalledCandidates,
    });
  }

  return resolution(input, 'fail', {
    confidence: 'low',
    ruleIds: [CRM_QUALITY_RULES.SAFE_HOLD],
    reasons: ['no useful contact name candidate could be resolved'],
    candidates: firewalledCandidates,
  });
}

export function resolveCrmEntityName(input: CrmNameResolutionInput): CrmNameResolutionResult {
  return input.entityType === 'company' ? resolveCompany(input) : resolveContact(input);
}

function safeJson(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function truncate(value: string, max = 180): string {
  const cleaned = clean(value);
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

export function crmNameResolutionCustomFields(
  resolutionResult: CrmNameResolutionResult,
  baseCustomFields = '{}'
): string {
  const fields = safeJson(baseCustomFields);
  fields.crm_name_resolution = {
    status: resolutionResult.status,
    normalized_name: resolutionResult.normalizedName || null,
    confidence: resolutionResult.confidence,
    rule_ids: resolutionResult.ruleIds,
    reasons: resolutionResult.reasons,
    evidence: {
      source_channel: resolutionResult.evidence.source_channel,
      source_record_id: resolutionResult.evidence.source_record_id,
      codepath: resolutionResult.evidence.codepath,
      evidence_level: resolutionResult.evidence.evidence_level,
      source_text: truncate(resolutionResult.evidence.source_text || ''),
    },
    candidates: resolutionResult.candidates.slice(0, 5).map(item => ({
      candidate_name: item.candidateName,
      normalized_name: item.normalizedName,
      status: item.status,
      confidence: item.confidence,
      score: item.score,
      rule_ids: item.ruleIds,
      reason: item.reason,
      accepted: item.accepted,
    })),
  };

  if (resolutionResult.nameStatus && resolutionResult.nameStatus !== 'verified') {
    fields.crm_quality = {
      ...(fields.crm_quality || {}),
      name_status: resolutionResult.nameStatus,
      label: 'Tentative name',
      canonical_name: null,
      confidence: resolutionResult.confidence,
      rule_ids: resolutionResult.ruleIds,
      reasons: resolutionResult.reasons,
      source: {
        source_channel: resolutionResult.evidence.source_channel,
        source_record_id: resolutionResult.evidence.source_record_id,
        codepath: resolutionResult.evidence.codepath,
        evidence_level: resolutionResult.evidence.evidence_level,
      },
      promotion_policy: 'promote when corroborated or manually reviewed canonical name evidence is available',
    };
  }

  return JSON.stringify(fields);
}

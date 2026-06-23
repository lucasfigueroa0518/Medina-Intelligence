export type CrmEntityType = 'contact' | 'company';
export type CrmQualityAction =
  | 'create'
  | 'update_name'
  | 'rename'
  | 'merge'
  | 'delete'
  | 'investigate';

export type CrmQualityDecision =
  | 'apply'
  | 'queue'
  | 'hold'
  | 'reject'
  | 'merge_plan'
  | 'delete_candidate';

export type CrmQualityConfidence = 'high' | 'medium' | 'low';
export type CrmQualityNameStatus = 'verified' | 'provisional' | 'domain_placeholder';

export interface CrmQualitySourceEvidence {
  source_channel?: string | null;
  source_record_id?: string | null;
  source_text?: string | null;
  codepath?: string | null;
  evidence_level?: 'manual' | 'corroborated' | 'weak_single_source' | 'unknown' | null;
}

export interface CrmQualityInput {
  entityType: CrmEntityType;
  action: CrmQualityAction;
  currentName?: string | null;
  proposedName?: string | null;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  source?: CrmQualitySourceEvidence;
  mergeTargetId?: string | null;
  deleteReason?: string | null;
  expectedAction?: 'keep' | 'rename' | 'merge' | 'delete' | 'investigate' | null;
  expectedName?: string | null;
  rootCause?: string | null;
  allowDomainPlaceholder?: boolean;
  nameStatus?: CrmQualityNameStatus | null;
  manualOverride?: boolean;
}

export interface CrmQualityGateResult {
  decision: CrmQualityDecision;
  writeAllowed: boolean;
  normalizedName?: string;
  mergeTargetId?: string;
  deleteReason?: string;
  nameStatus?: CrmQualityNameStatus;
  confidence: CrmQualityConfidence;
  ruleIds: string[];
  reasons: string[];
  evidence: Required<CrmQualitySourceEvidence>;
}

export const CRM_QUALITY_RULES = {
  WRITE_GATE: 'RULE-WRITE-GATE-000',
  EVIDENCE_LEDGER: 'RULE-EVIDENCE-LEDGER-001',
  COMPANY_PAGE_TITLE: 'RULE-COMPANY-NAME-010',
  COMPANY_DOMAIN_PLACEHOLDER: 'RULE-COMPANY-NAME-020',
  COMPANY_COMPOUND: 'RULE-COMPANY-NAME-030',
  COMPANY_SERVICE_DOMAIN: 'RULE-COMPANY-CREATE-040',
  CONTACT_EMAIL_LOCAL_PART: 'RULE-CONTACT-NAME-050',
  CONTACT_SINGLE_TOKEN: 'RULE-CONTACT-NAME-060',
  CONTACT_DIRECTORY_NAME: 'RULE-CONTACT-NAME-070',
  CONTACT_AUTOMATED: 'RULE-CONTACT-CREATE-080',
  DEDUP: 'RULE-DEDUP-090',
  SAFE_HOLD: 'RULE-SAFE-HOLD-100',
  PROVISIONAL_NAME: 'RULE-PROVISIONAL-NAME-110',
} as const;

const AUTOMATED_LOCAL_NAMES = new Set([
  'abuse',
  'admin',
  'administrator',
  'alerts',
  'billing',
  'bounce',
  'bounces',
  'calendar',
  'calendar-invite',
  'contact',
  'daemon',
  'digest',
  'do-not-reply',
  'donotreply',
  'email',
  'ecosystem',
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
  'qubits',
  'registration',
  'registrations',
  'sales',
  'security',
  'service',
  'studio-team',
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
  'amazonses.com',
  'atlassian.com',
  'bizzabo.com',
  'calendly.com',
  'chime.live',
  'cloudflare.com',
  'calendar.luma-mail.com',
  'docsend.com',
  'docs.google.com',
  'docusign.net',
  'e.read.ai',
  'fireflies.ai',
  'flcorpfiling.com',
  'github.com',
  'godaddy.com',
  'google.com',
  'hubspot.com',
  'luma-mail.com',
  'lu.ma',
  'mailchimp.com',
  'mailgun.net',
  'microsoft.com',
  'myflcorpfilingusa.com',
  'notion.so',
  'office.com',
  'office365.com',
  'otter.ai',
  'sendtestemail.com',
  'sendgrid.net',
  'slack.com',
  'slackmail.com',
  'squareup.com',
  'stripe.com',
  'surveymonkeyuser.com',
  'trustserve.net',
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

const RANK_AND_CONTEXT_TOKENS = /\b(ltg|ltc|maj|col|capt|cpt|ses|osd|ousd|ussocom|socom|usarmy|usa|hq|t2com|citd|civ|ctr|ret|retired|gen|brig|dr|mr|mrs|ms)\b\.?/gi;
const COMPANY_SUFFIX_RE = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|plc|s\.?a\.?|s\.?p\.?a\.?)\b\.?/gi;
const PAGE_TITLE_BOILERPLATE_RE = /\b(home|homepage|front page|official site|official website|welcome|upcoming events|website)\b/i;

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function evidence(input: CrmQualityInput): Required<CrmQualitySourceEvidence> {
  return {
    source_channel: input.source?.source_channel || 'unknown',
    source_record_id: input.source?.source_record_id || 'unknown',
    source_text: input.source?.source_text || input.currentName || input.proposedName || 'unknown',
    codepath: input.source?.codepath || 'unknown',
    evidence_level: input.source?.evidence_level || 'unknown',
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function result(
  input: CrmQualityInput,
  decision: CrmQualityDecision,
  args: {
    normalizedName?: string;
    mergeTargetId?: string | null;
    deleteReason?: string | null;
    nameStatus?: CrmQualityNameStatus;
    confidence?: CrmQualityConfidence;
    ruleIds?: string[];
    reasons?: string[];
  } = {}
): CrmQualityGateResult {
  const ruleIds = unique([
    CRM_QUALITY_RULES.WRITE_GATE,
    CRM_QUALITY_RULES.EVIDENCE_LEDGER,
    ...(args.ruleIds || []),
  ]);
  return {
    decision,
    writeAllowed: decision === 'apply',
    normalizedName: args.normalizedName,
    mergeTargetId: args.mergeTargetId || undefined,
    deleteReason: args.deleteReason || undefined,
    nameStatus: args.nameStatus,
    confidence: args.confidence || 'medium',
    ruleIds,
    reasons: args.reasons || [],
    evidence: evidence(input),
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

function titleCase(value: string): string {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(' ')
    .map(word => {
      if (/^[A-Z]-[A-Za-z][A-Za-z0-9]*$/.test(word)) return `${word.slice(0, 2)}${titleCase(word.slice(2))}`;
      if (/^[A-Z0-9&]{2,6}$/.test(word)) return word;
      if (/^[a-z]?[A-Z][A-Za-z0-9]*$/.test(word) && /[A-Z].*[A-Z]/.test(word)) return word;
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

export function looksLikeDomain(value: string): boolean {
  const v = normalizeDomain(value);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) && /\.[a-z]{2,}$/i.test(v);
}

function domainFromInput(input: CrmQualityInput): string {
  return normalizeDomain(input.domain || input.website || '');
}

function isAutomatedDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  if (AUTOMATED_DOMAINS.has(d)) return true;
  return [...AUTOMATED_DOMAINS].some(blocked => d.endsWith(`.${blocked}`));
}

function hasHumanDisplayViaAssistantBridge(input: CrmQualityInput, raw: string): boolean {
  if (input.nameStatus !== 'verified') return false;
  if (isRawEmail(raw) || !raw.includes(' ')) return false;
  const sourceText = clean(input.source?.source_text);
  if (!/\s+(?:via|from)\s+(?:read\s*ai|qualified|calendly|zoom|fireflies|otter|luma|lu\.ma)\b/i.test(sourceText)) return false;
  const stripped = sourceText
    .replace(/\s+(?:via|from)\s+(?:read\s*ai|qualified|calendly|zoom|fireflies|otter|luma|lu\.ma)\b.*$/i, '')
    .trim();
  return normalizeToken(stripped) === normalizeToken(raw);
}

function isInvalidPublicSuffixLike(domain: string): boolean {
  const d = normalizeDomain(domain);
  return /^(co|com|org|net|edu|gov)\.[a-z]{2}$/i.test(d);
}

function localPart(email: string | null | undefined): string {
  const e = lower(email);
  const at = e.indexOf('@');
  return at > 0 ? e.slice(0, at) : '';
}

function normalizeToken(value: string): string {
  return lower(value).replace(/[^a-z0-9]+/g, '');
}

function isRawEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(clean(value));
}

function isLocalPartName(name: string, email?: string | null): boolean {
  const raw = clean(name);
  const rawLower = lower(raw);
  const n = normalizeToken(raw);
  if (!n) return false;
  const local = normalizeToken(localPart(email));
  if (local && n === local) return true;
  if (/^[a-z][a-z0-9._-]{2,}$/.test(rawLower) && !raw.includes(' ')) {
    return raw === rawLower || /[._\d-]/.test(rawLower);
  }
  return false;
}

function weakSingleSourceEvidence(input: CrmQualityInput): boolean {
  if (input.manualOverride) return false;
  if (input.source?.evidence_level === 'weak_single_source') return true;
  const channel = lower(input.source?.source_channel);
  const codepath = lower(input.source?.codepath);
  return (
    (channel === 'email_header' || channel === 'outlook_display_name') ||
    (channel === 'display_name' && /resolve_contact_name|discover_new_contact/.test(codepath))
  );
}

function contactNameNeedsCorroboration(input: CrmQualityInput, name: string): boolean {
  if (input.nameStatus === 'verified') return false;
  if (!weakSingleSourceEvidence(input)) return false;
  if (!clean(input.email)) return true;

  const nameTokens: string[] = clean(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  if (nameTokens.length === 0) return true;

  const local = localPart(input.email)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const localTokens: string[] = local.match(/[a-z0-9]+/g) || [];
  const localCollapsed = localTokens.join('');
  const domainStem = normalizeDomain(clean(input.email).split('@')[1] || '')
    .split('.')[0]
    .replace(/[^a-z0-9]+/g, '');

  if (!localCollapsed) return true;

  const nameCollapsed = nameTokens.join('');
  if (nameCollapsed === localCollapsed) return true;
  if (nameTokens.length >= 2 && nameTokens.every(token => localTokens.includes(token))) return true;

  const initials = nameTokens.map(token => token[0]).join('');
  if (initials && initials === localCollapsed) return true;

  const first = nameTokens[0] || '';
  const last = nameTokens[nameTokens.length - 1] || '';
  if (first && first === localCollapsed) return true;
  if (first.length >= 4 && localCollapsed.length >= 4 && first.startsWith(localCollapsed)) return true;
  if (last && localCollapsed === `${first[0] || ''}${last}`) return true;
  if (last && localCollapsed.endsWith(last) && localCollapsed.startsWith(first[0] || '\u0000')) return true;
  if (domainStem && first && localCollapsed === first && domainStem.startsWith(last)) return true;

  return true;
}

function isAutomatedContactName(name: string, email?: string | null): boolean {
  const n = lower(name).replace(/[_\s]+/g, '-');
  if (AUTOMATED_LOCAL_NAMES.has(n)) return true;
  if (/mail delivery subsystem|mailer-daemon|postmaster|calendar notification|upcoming events/i.test(name)) return true;
  if (/[|:]|\.com\b/i.test(name)) return true;
  if (/\b(inc|llc|corp|corporation|company|capital|ventures|partners|space|systems|studio|americas)\b\.?/i.test(name)) return true;
  const local = lower(localPart(email)).replace(/[_\s]+/g, '-');
  return Boolean(local && AUTOMATED_LOCAL_NAMES.has(local));
}

function isLocalPartDerivedPersonName(name: string): boolean {
  const raw = clean(name);
  if (/^[A-Z]\.\s+[A-Z][A-Za-z'.-]{2,}$/.test(raw)) return true;
  const tokens = raw.match(/[A-Za-z][A-Za-z'.-]*/g) || [];
  if (tokens.length < 2) return false;
  if (tokens.some(token => token.length < 2 && !/^[A-Z]\.?$/.test(token))) return false;
  return !/\b(inc|llc|corp|corporation|company|capital|ventures|partners|studio|group|office|systems|fund)\b\.?/i.test(raw);
}

function isSingleTokenLocalPartPersonName(name: string, email?: string | null): boolean {
  const raw = clean(name);
  const normalized = normalizeToken(raw);
  const local = normalizeToken(localPart(email));
  return Boolean(
    normalized
    && local
    && normalized === local
    && /^[a-z]{3,12}$/i.test(normalized)
    && /[aeiouy]/i.test(normalized)
    && !AUTOMATED_LOCAL_NAMES.has(normalized)
  );
}

function parseDirectoryName(name: string): string | null {
  const withoutContext = clean(name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(RANK_AND_CONTEXT_TOKENS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = withoutContext.match(/^([^,]{2,}),\s*([^,]{2,})(?:\s+(.+))?$/);
  if (!match) return null;
  const last = clean(match[1]);
  const firstAndRest = clean(`${match[2]} ${match[3] || ''}`);
  const parts = `${firstAndRest} ${last}`.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return titleCase(parts.join(' '));
}

function stripCompanyDecorators(value: string): string {
  return clean(decodeHtmlEntities(value))
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageTitleCandidate(value: string): string | null {
  const cleaned = stripCompanyDecorators(value);
  const titleSeparator = /\s+(?:[|\u2013\u2014-])\s+|:/;
  if (PAGE_TITLE_BOILERPLATE_RE.test(cleaned) && !titleSeparator.test(cleaned)) return null;
  if (!titleSeparator.test(cleaned) && !PAGE_TITLE_BOILERPLATE_RE.test(cleaned)) return null;
  const parts = cleaned
    .split(titleSeparator)
    .map(part => clean(part))
    .filter(Boolean);
  if (parts.length === 0) return null;
  const nonBoilerplate = parts.filter(part => !PAGE_TITLE_BOILERPLATE_RE.test(part));
  const chosen = nonBoilerplate.length ? nonBoilerplate[nonBoilerplate.length - 1] : parts[parts.length - 1];
  if (!chosen || PAGE_TITLE_BOILERPLATE_RE.test(chosen)) return null;
  return titleCase(chosen);
}

function isCompoundCompanyName(value: string): boolean {
  const v = clean(value);
  if (v.includes('/')) return true;
  if (/\b(and|&)\b/i.test(v) && /\b(inc|bank|capital|corp|corporation|ventures|partners|crystals|securities)\b/i.test(v)) return true;
  return /\([^)]+\)/.test(v) && /\b(inc|bank|capital|corp|corporation|ventures|partners|group)\b/i.test(v);
}

function normalizeCompanyNameFromProposal(name: string): string {
  return titleCase(
    stripCompanyDecorators(name)
      .replace(COMPANY_SUFFIX_RE, match => match)
      .replace(/\s+/g, ' ')
      .trim()
  )
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bFor\b/g, 'for');
}

function rulesForRootCause(rootCause: string | null | undefined): string[] {
  switch (rootCause) {
    case 'website_title_or_page_title_used_as_company_name':
      return [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE];
    case 'domain_placeholder_not_canonicalized':
      return [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER];
    case 'compound_multi_entity_company_name':
      return [CRM_QUALITY_RULES.COMPANY_COMPOUND];
    case 'service_or_invalid_domain_company_creation':
      return [CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN];
    case 'email_local_part_used_as_contact_name':
      return [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART];
    case 'single_token_or_partial_contact_name':
      return [CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN];
    case 'directory_last_first_or_ranked_display_name':
      return [CRM_QUALITY_RULES.CONTACT_DIRECTORY_NAME];
    case 'automated_shared_mailbox_contact_creation':
      return [CRM_QUALITY_RULES.CONTACT_AUTOMATED];
    case 'duplicate_identity_resolution_gap':
      return [CRM_QUALITY_RULES.DEDUP];
    default:
      return [];
  }
}

function evaluateCompany(input: CrmQualityInput): CrmQualityGateResult {
  const raw = clean(input.proposedName || input.currentName);
  const domain = domainFromInput(input) || (looksLikeDomain(raw) ? normalizeDomain(raw) : '');

  if (input.action === 'merge' && input.mergeTargetId) {
    return result(input, 'merge_plan', {
      mergeTargetId: input.mergeTargetId,
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.DEDUP],
      reasons: ['duplicate company relationship resolved before durable write'],
    });
  }

  if (input.action === 'delete') {
    return result(input, 'delete_candidate', {
      deleteReason: input.deleteReason || 'entity should not have been created',
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN],
      reasons: ['company marked as erroneous creation candidate'],
    });
  }

  if (input.action === 'investigate' || input.expectedAction === 'investigate') {
    return result(input, 'hold', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.SAFE_HOLD, ...rulesForRootCause(input.rootCause)],
      reasons: ['low-confidence company row requires human/source-level investigation'],
    });
  }

  if (!raw) {
    return result(input, 'reject', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.SAFE_HOLD],
      reasons: ['company name is blank'],
    });
  }

  if (domain && (isAutomatedDomain(domain) || isInvalidPublicSuffixLike(domain))) {
    return result(input, 'reject', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_SERVICE_DOMAIN],
      reasons: [`service or invalid domain cannot create canonical company: ${domain}`],
    });
  }

  if (PAGE_TITLE_BOILERPLATE_RE.test(raw) && !input.expectedName) {
    return result(input, 'hold', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE, CRM_QUALITY_RULES.SAFE_HOLD, ...rulesForRootCause(input.rootCause)],
      reasons: ['homepage/front-page boilerplate cannot become a canonical company name without source evidence'],
    });
  }

  if (input.expectedAction === 'rename' && input.expectedName) {
    if (input.rootCause === 'website_title_or_page_title_used_as_company_name') {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
        reasons: ['workbook root-cause evidence maps this company value to page-title normalization'],
      });
    }
    if (input.rootCause === 'domain_placeholder_not_canonicalized') {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER],
        reasons: ['workbook root-cause evidence maps this company value to domain-placeholder canonicalization'],
      });
    }
    if (input.rootCause === 'compound_multi_entity_company_name') {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_COMPOUND],
        reasons: ['workbook root-cause evidence maps this company value to compound-name handling'],
      });
    }
  }

  if (isCompoundCompanyName(raw)) {
    if (input.expectedAction === 'rename' && input.expectedName) {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_COMPOUND],
        reasons: ['compound company string requires evidence-backed canonical proposal'],
      });
    }
    return result(input, 'hold', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_COMPOUND, CRM_QUALITY_RULES.SAFE_HOLD],
      reasons: ['compound multi-organization company string must not be persisted as one company'],
    });
  }

  if (looksLikeDomain(raw)) {
    if (input.nameStatus === 'verified' && /^[A-Za-z0-9-]{2,24}\.(?:io|me)$/i.test(raw)) {
      return result(input, 'apply', {
        normalizedName: raw,
        nameStatus: 'verified',
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER],
        reasons: ['resolver-verified dotted brand accepted as canonical company name'],
      });
    }
    if (input.nameStatus === 'provisional') {
      return result(input, 'apply', {
        normalizedName: raw,
        nameStatus: 'provisional',
        confidence: input.source?.evidence_level === 'weak_single_source' ? 'low' : 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER, CRM_QUALITY_RULES.PROVISIONAL_NAME],
        reasons: ['dotted brand-like name accepted only as provisional pending corroboration'],
      });
    }
    if (input.allowDomainPlaceholder) {
      return result(input, 'apply', {
        normalizedName: normalizeDomain(raw),
        nameStatus: 'domain_placeholder',
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER],
        reasons: ['domain can be retained only as a placeholder pending canonical evidence'],
      });
    }
    if (input.expectedAction === 'rename' && input.expectedName) {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER],
        reasons: ['domain placeholder has reviewer/source-backed canonical proposal'],
      });
    }
    return result(input, 'hold', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER, CRM_QUALITY_RULES.SAFE_HOLD],
      reasons: ['domain-derived company name cannot be final canonical value without corroboration'],
    });
  }

  const pageCandidate = pageTitleCandidate(raw);
  if (pageCandidate) {
    const normalized = input.expectedName || pageCandidate;
    if (input.nameStatus === 'verified') {
      return result(input, 'apply', {
        normalizedName: normalizeCompanyNameFromProposal(raw),
        nameStatus: 'verified',
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
        reasons: ['resolver-verified page-title-derived company name accepted after quality validation'],
      });
    }
    return result(input, input.expectedAction === 'rename' || input.action === 'rename' ? 'queue' : 'hold', {
      normalizedName: normalized,
      confidence: input.expectedAction === 'rename' ? 'medium' : 'low',
      ruleIds: [CRM_QUALITY_RULES.COMPANY_PAGE_TITLE],
      reasons: ['website/page title was stripped to a canonical company proposal'],
    });
  }

  if (input.nameStatus === 'provisional') {
    return result(input, 'apply', {
      normalizedName: normalizeCompanyNameFromProposal(raw),
      nameStatus: 'provisional',
      confidence: input.source?.evidence_level === 'weak_single_source' ? 'low' : 'medium',
      ruleIds: [CRM_QUALITY_RULES.PROVISIONAL_NAME],
      reasons: ['resolver-provisional company name accepted with tentative-name status'],
    });
  }

  return result(input, 'apply', {
    normalizedName: input.expectedName || normalizeCompanyNameFromProposal(raw),
    confidence: 'high',
    reasons: ['company name passed quality gate'],
  });
}

function evaluateContact(input: CrmQualityInput): CrmQualityGateResult {
  const raw = clean(input.proposedName || input.currentName);
  const email = clean(input.email);
  const domain = normalizeDomain(email.split('@')[1] || '');

  if (input.action === 'merge' && input.mergeTargetId) {
    return result(input, 'merge_plan', {
      mergeTargetId: input.mergeTargetId,
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.DEDUP],
      reasons: ['duplicate contact relationship resolved before durable write'],
    });
  }

  if (input.action === 'delete') {
    return result(input, 'delete_candidate', {
      deleteReason: input.deleteReason || 'contact should not have been created',
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_AUTOMATED],
      reasons: ['contact marked as erroneous creation candidate'],
    });
  }

  if (input.action === 'investigate' || input.expectedAction === 'investigate') {
    return result(input, 'hold', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.SAFE_HOLD, ...rulesForRootCause(input.rootCause)],
      reasons: ['low-confidence contact row requires human/source-level investigation'],
    });
  }

  if (!raw) {
    return result(input, 'reject', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.SAFE_HOLD],
      reasons: ['contact name is blank'],
    });
  }

  const assistantBridgeHumanDisplay = hasHumanDisplayViaAssistantBridge(input, raw);
  if ((isAutomatedDomain(domain) || isAutomatedContactName(raw, email)) && !assistantBridgeHumanDisplay) {
    return result(input, 'reject', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_AUTOMATED],
      reasons: ['automated, platform, or shared-mailbox contact blocked'],
    });
  }

  if (input.nameStatus === 'verified' && !isRawEmail(raw) && raw.includes(' ')) {
    return result(input, 'apply', {
      normalizedName: titleCase(raw),
      nameStatus: 'verified',
      confidence: 'medium',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
      reasons: ['resolver-verified person display name accepted despite email-local-part similarity'],
    });
  }

  if (input.expectedAction === 'rename' && input.expectedName) {
    if (input.rootCause === 'email_local_part_used_as_contact_name') {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
        reasons: ['workbook root-cause evidence maps this contact value to local-part normalization'],
      });
    }
    if (input.rootCause === 'single_token_or_partial_contact_name') {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN],
        reasons: ['workbook root-cause evidence maps this contact value to partial-name handling'],
      });
    }
    if (input.rootCause === 'directory_last_first_or_ranked_display_name') {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_DIRECTORY_NAME],
        reasons: ['workbook root-cause evidence maps this contact value to directory-name parsing'],
      });
    }
  }

  if (isRawEmail(raw) || isLocalPartName(raw, email)) {
    if (!isRawEmail(raw) && weakSingleSourceEvidence(input) && isLocalPartDerivedPersonName(raw)) {
      return result(input, 'apply', {
        normalizedName: titleCase(raw),
        nameStatus: 'provisional',
        confidence: 'low',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART, CRM_QUALITY_RULES.PROVISIONAL_NAME],
        reasons: ['email local-part-derived person name created with a tentative name pending corroboration'],
      });
    }
    if (!isRawEmail(raw) && weakSingleSourceEvidence(input) && isSingleTokenLocalPartPersonName(raw, email)) {
      return result(input, 'apply', {
        normalizedName: titleCase(raw),
        nameStatus: 'provisional',
        confidence: 'low',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN, CRM_QUALITY_RULES.PROVISIONAL_NAME],
        reasons: ['single-token email identity created with a tentative name pending corroboration'],
      });
    }
    return result(input, 'reject', {
      confidence: 'high',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART],
      reasons: ['email local part or raw email cannot become contact name'],
    });
  }

  const directory = parseDirectoryName(raw);
  if (directory) {
    const weakSource = weakSingleSourceEvidence(input);
    return result(input, input.expectedAction === 'rename' || input.action === 'rename' ? 'queue' : 'apply', {
      normalizedName: input.expectedName || directory,
      nameStatus: weakSource ? 'provisional' : undefined,
      confidence: weakSource ? 'low' : 'medium',
      ruleIds: [
        CRM_QUALITY_RULES.CONTACT_DIRECTORY_NAME,
        ...(weakSource ? [CRM_QUALITY_RULES.PROVISIONAL_NAME] : []),
      ],
      reasons: [
        weakSource
          ? 'directory last-first/rank display name normalized and created with a tentative name pending corroboration'
          : 'directory last-first/rank display name normalized',
      ],
    });
  }

  if (contactNameNeedsCorroboration(input, raw)) {
    return result(input, 'apply', {
      normalizedName: titleCase(raw),
      nameStatus: 'provisional',
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART, CRM_QUALITY_RULES.PROVISIONAL_NAME, ...rulesForRootCause(input.rootCause)],
      reasons: ['weak single-source email identity created with a tentative name pending corroboration'],
    });
  }

  if (!raw.includes(' ')) {
    if (input.manualOverride) {
      return result(input, 'apply', {
        normalizedName: titleCase(raw),
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN],
        reasons: ['manual single-token contact name allowed with human override'],
      });
    }
    if (input.expectedAction === 'rename' && input.expectedName) {
      return result(input, 'queue', {
        normalizedName: input.expectedName,
        confidence: 'medium',
        ruleIds: [CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN],
        reasons: ['single-token contact name has source-backed canonical proposal'],
      });
    }
    return result(input, 'hold', {
      confidence: 'low',
      ruleIds: [CRM_QUALITY_RULES.CONTACT_SINGLE_TOKEN, CRM_QUALITY_RULES.SAFE_HOLD],
      reasons: ['single-token contact name requires corroboration before automatic creation'],
    });
  }

  return result(input, 'apply', {
    normalizedName: input.expectedName || titleCase(raw),
    confidence: 'high',
    reasons: ['contact name passed quality gate'],
  });
}

export function evaluateCrmQualityGate(input: CrmQualityInput): CrmQualityGateResult {
  if (input.entityType === 'company') return evaluateCompany(input);
  return evaluateContact(input);
}

export function assertCrmQualityGateAllowsWrite(input: CrmQualityInput): CrmQualityGateResult {
  const gate = evaluateCrmQualityGate(input);
  if (!gate.writeAllowed) {
    throw new Error(`CRM_QUALITY_GATE_BLOCKED:${gate.ruleIds.join(',')}:${gate.reasons.join('; ')}`);
  }
  return gate;
}

export function crmQualityCustomFieldsForGate(gate: CrmQualityGateResult): string {
  if (!gate.nameStatus || gate.nameStatus === 'verified') return '{}';
  const label = 'Tentative name';
  return JSON.stringify({
    crm_quality: {
      name_status: gate.nameStatus,
      label,
      canonical_name: null,
      confidence: gate.confidence,
      rule_ids: gate.ruleIds,
      reasons: gate.reasons,
      source: {
        source_channel: gate.evidence.source_channel,
        source_record_id: gate.evidence.source_record_id,
        codepath: gate.evidence.codepath,
        evidence_level: gate.evidence.evidence_level,
      },
      promotion_policy: 'promote when corroborated or manually reviewed canonical name evidence is available',
    },
  });
}

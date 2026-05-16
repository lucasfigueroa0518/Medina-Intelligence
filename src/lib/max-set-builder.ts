import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { canReadConversationContent, getSharingFlags, hasOrgWidePrivateDataAccess, parseParticipantUserIds } from './helpers';
import { isDocumentAccessibleToUser } from './document-acl';
import { createDocumentArtifactTool, type MartyDocumentCard } from './document-artifacts';
import { extractTextFromFile } from './file-extraction';
import { MAX_MODE_LIMITS } from './max-mode';
import { searchRagChunksD1Fts } from './rag-v2-lexical';

export type MaxSetTaskType =
  | 'invite_roster'
  | 'touchpoint_roster'
  | 'entity_theme_set'
  | 'funding_interest_gap'
  | 'firm_involvement'
  | 'open_loops'
  | 'account_map'
  | 'campaign_response_set'
  | 'document_list_reconstruction'
  | 'deal_process_history'
  | 'generic_set';

export type MaxSetEntityKind =
  | 'person'
  | 'company'
  | 'firm'
  | 'startup'
  | 'deal'
  | 'touchpoint'
  | 'mixed';

export type MaxSetSourceFamily =
  | 'communications'
  | 'events'
  | 'campaigns'
  | 'contacts'
  | 'companies'
  | 'deals'
  | 'documents'
  | 'tasks';

type MaxSetConfidence = 'confirmed' | 'probable' | 'needs_review';
export type MaxSetSafetyStatus = 'complete' | 'tiered_with_gaps' | 'unsafe_incomplete';
type MaxSetAnchorType =
  | 'event'
  | 'conversation_thread'
  | 'campaign'
  | 'document'
  | 'deal'
  | 'company'
  | 'date_window'
  | 'person'
  | 'domain';

type MaxSetEvidenceType =
  | 'direct_recipient'
  | 'campaign_recipient'
  | 'document_row'
  | 'event_attendee'
  | 'touchpoint'
  | 'task_action_item'
  | 'crm_record'
  | 'deal_record'
  | 'text_mention'
  | 'exclusion_record';

export interface BuildMaxSetInput {
  task_type?: MaxSetTaskType;
  entity_kind?: MaxSetEntityKind;
  query: string;
  include_terms?: string[];
  exclude_terms?: string[];
  aliases?: string[];
  domains?: string[];
  date_range?: { start?: string; end?: string };
  named_people?: string[];
  source_families?: MaxSetSourceFamily[];
  output_columns?: string[];
  artifact_kind?: 'xlsx' | 'none';
  create_artifact?: boolean;
}

interface SearchProfile {
  query: string;
  taskType: MaxSetTaskType;
  entityKind: MaxSetEntityKind;
  includeTerms: string[];
  excludeTerms: string[];
  aliases: string[];
  domains: string[];
  sourceFamilies: MaxSetSourceFamily[];
  dateRange: { start?: string; end?: string };
  wantsArtifact: boolean;
  outputColumns: string[];
  plan?: MaxSetJobPlan;
}

interface MaxSetEvidence {
  source_family: MaxSetSourceFamily;
  source_table: string;
  source_id: string;
  anchor_id?: string;
  evidence_type: MaxSetEvidenceType;
  title?: string | null;
  date?: string | null;
  detail: string;
  strength: MaxSetConfidence;
  satisfies_membership: boolean;
}

interface MaxSetCandidate {
  canonical_id: string;
  canonical_name: string;
  entity_kind: MaxSetEntityKind;
  email?: string | null;
  first_name?: string | null;
  company?: string | null;
  domain?: string | null;
  confidence: MaxSetConfidence;
  membership_predicate_satisfied: boolean;
  source_count: number;
  source_families: MaxSetSourceFamily[];
  evidence: MaxSetEvidence[];
  why_included: string[];
  why_excluded?: string[];
  unresolved_fields: string[];
}

interface SourceStat {
  source_family: MaxSetSourceFamily;
  role?: 'authoritative' | 'supporting' | 'enrichment' | 'disallowed';
  rows_scanned: number;
  rows_returned: number;
  candidates_added: number;
  cap_hit: boolean;
  errors: string[];
  body_fetches?: number;
  documents_extracted?: number;
}

interface CandidateDraft {
  entityKind?: MaxSetEntityKind;
  id?: string | null;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  domain?: string | null;
  confidence: MaxSetConfidence;
  why: string;
  evidence: MaxSetEvidence;
  exclude?: boolean;
  exclusionReason?: string;
}

interface MaxSetNamedPerson {
  name?: string;
  email?: string;
  role: 'inviter' | 'target' | 'excluded' | 'unknown';
}

interface MaxSetAnchor {
  type: MaxSetAnchorType;
  id?: string;
  label: string;
  confidence: MaxSetConfidence;
  source_family: MaxSetSourceFamily;
  why: string;
}

interface MaxSetSourcePolicy {
  authoritative: MaxSetSourceFamily[];
  supporting: MaxSetSourceFamily[];
  enrichment: MaxSetSourceFamily[];
  disallowed_candidate_sources: MaxSetSourceFamily[];
  required_success_any_of: MaxSetSourceFamily[][];
}

interface MaxSetArtifactPolicy {
  wants_artifact: boolean;
  artifact_kind: 'xlsx' | 'none';
  require_quality_gate: boolean;
}

interface MaxSetQualityPolicy {
  block_on_authoritative_errors: boolean;
  block_on_caps: boolean;
  require_authoritative_candidates: boolean;
  suppress_generated_artifact_sources: boolean;
}

export interface MaxSetJobPlan {
  task_type: MaxSetTaskType;
  entity_kind: MaxSetEntityKind;
  original_query: string;
  target_scope: {
    title_terms: string[];
    date_range?: { start?: string; end?: string };
    named_people: MaxSetNamedPerson[];
    domains: string[];
    aliases: string[];
  };
  anchors: MaxSetAnchor[];
  membership_predicate: string;
  source_policy: MaxSetSourcePolicy;
  artifact_policy: MaxSetArtifactPolicy;
  quality_policy: MaxSetQualityPolicy;
}

export interface MaxSetQualityGateResult {
  passed: boolean;
  status: MaxSetSafetyStatus;
  reasons: string[];
  artifact_allowed: boolean;
  artifact_suppressed_reason?: string;
}

interface CommunicationLinkedContact {
  conversation_id: string;
  contact_id: string;
  full_name: string | null;
  email: string | null;
  company_name: string | null;
  company_domain: string | null;
}

const CONFIDENCE_RANK: Record<MaxSetConfidence, number> = {
  needs_review: 1,
  probable: 2,
  confirmed: 3,
};

const MAX_TEXT_TERMS = 14;
const INTERNAL_DOMAINS = new Set(['medinavc.com', 'medinaventures.ai', 'medinaventures.com']);
const DOCUMENT_TEXT_EXTRACT_LIMIT = 25;
const D1_IN_BATCH_SIZE = 50;
const SOURCE_FAMILIES: MaxSetSourceFamily[] = [
  'communications',
  'events',
  'campaigns',
  'contacts',
  'companies',
  'deals',
  'documents',
  'tasks',
];
const STOP_WORDS = new Set([
  'about', 'across', 'all', 'also', 'and', 'any', 'are', 'around', 'been',
  'build', 'can', 'come', 'could', 'did', 'does', 'every', 'ever', 'export',
  'file', 'find', 'for', 'from', 'funding', 'give', 'had', 'has', 'have',
  'into', 'invited', 'involved', 'list', 'mail', 'make', 'merge', 'mode', 'needs', 'people',
  'pull', 'show', 'that', 'the', 'their', 'them', 'this', 'touch', 'touchpoint',
  'touchpoints', 'want', 'were', 'what', 'with', 'you',
  'company', 'companies', 'startup', 'startups', 'firm', 'firms', 'vc', 'venture',
]);

function chunkArray<T>(values: T[], size = D1_IN_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

async function queryRowsInBatches<T>(
  env: Env,
  ids: string[],
  makeSql: (placeholders: string) => string,
  bindPrefix: unknown[] = [],
  bindSuffix: unknown[] = []
): Promise<T[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const rows: T[] = [];
  for (const batch of chunkArray(uniqueIds)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const res = await env.D1.prepare(makeSql(placeholders))
      .bind(...bindPrefix, ...batch, ...bindSuffix)
      .all<T>();
    rows.push(...(res.results || []));
  }
  return rows;
}

function sourcePolicyForTask(taskType: MaxSetTaskType): MaxSetSourcePolicy {
  switch (taskType) {
    case 'invite_roster':
      return {
        authoritative: ['communications', 'campaigns', 'documents'],
        supporting: ['events'],
        enrichment: ['contacts', 'companies'],
        disallowed_candidate_sources: ['events', 'contacts'],
        required_success_any_of: [['communications', 'campaigns', 'documents']],
      };
    case 'touchpoint_roster':
      return {
        authoritative: ['communications', 'events', 'tasks'],
        supporting: ['documents'],
        enrichment: ['contacts', 'companies', 'deals'],
        disallowed_candidate_sources: [],
        required_success_any_of: [['communications', 'events', 'tasks']],
      };
    case 'entity_theme_set':
      return {
        authoritative: ['companies', 'deals', 'documents'],
        supporting: ['communications', 'events'],
        enrichment: ['contacts'],
        disallowed_candidate_sources: [],
        required_success_any_of: [['companies', 'deals', 'documents']],
      };
    case 'firm_involvement':
      return {
        authoritative: ['deals', 'communications', 'documents'],
        supporting: ['events'],
        enrichment: ['contacts', 'companies'],
        disallowed_candidate_sources: [],
        required_success_any_of: [['deals', 'communications', 'documents']],
      };
    case 'funding_interest_gap':
      return {
        authoritative: ['communications', 'events', 'tasks', 'contacts', 'documents'],
        supporting: ['companies', 'deals'],
        enrichment: [],
        disallowed_candidate_sources: [],
        required_success_any_of: [['communications', 'events', 'tasks', 'contacts', 'documents']],
      };
    case 'open_loops':
      return {
        authoritative: ['tasks', 'events', 'communications'],
        supporting: ['documents'],
        enrichment: ['contacts', 'companies'],
        disallowed_candidate_sources: [],
        required_success_any_of: [['tasks', 'events', 'communications']],
      };
    case 'account_map':
      return {
        authoritative: ['contacts', 'communications', 'events'],
        supporting: ['companies', 'deals', 'documents'],
        enrichment: [],
        disallowed_candidate_sources: [],
        required_success_any_of: [['contacts', 'communications', 'events']],
      };
    case 'campaign_response_set':
      return {
        authoritative: ['campaigns', 'communications'],
        supporting: ['contacts', 'companies'],
        enrichment: [],
        disallowed_candidate_sources: [],
        required_success_any_of: [['campaigns'], ['communications']],
      };
    case 'document_list_reconstruction':
      return {
        authoritative: ['documents'],
        supporting: ['communications'],
        enrichment: ['contacts', 'companies', 'deals'],
        disallowed_candidate_sources: [],
        required_success_any_of: [['documents']],
      };
    case 'deal_process_history':
      return {
        authoritative: ['deals', 'communications', 'events', 'tasks'],
        supporting: ['documents'],
        enrichment: ['contacts', 'companies'],
        disallowed_candidate_sources: [],
        required_success_any_of: [['deals'], ['communications', 'events', 'tasks']],
      };
    default:
      return {
        authoritative: ['communications', 'events', 'campaigns', 'contacts', 'companies', 'deals', 'documents', 'tasks'],
        supporting: [],
        enrichment: [],
        disallowed_candidate_sources: [],
        required_success_any_of: [['communications', 'events', 'campaigns', 'contacts', 'companies', 'deals', 'documents', 'tasks']],
      };
  }
}

function sourceRole(plan: MaxSetJobPlan | undefined, family: MaxSetSourceFamily): SourceStat['role'] {
  if (!plan) return undefined;
  if (plan.source_policy.disallowed_candidate_sources.includes(family)) return 'disallowed';
  if (plan.source_policy.authoritative.includes(family)) return 'authoritative';
  if (plan.source_policy.supporting.includes(family)) return 'supporting';
  if (plan.source_policy.enrichment.includes(family)) return 'enrichment';
  return undefined;
}

function cleanText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function compactText(value: unknown): string {
  return normalizeText(value).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanTerm(value: unknown): string | null {
  const term = compactText(value);
  if (!term || term.length < 2) return null;
  return term.slice(0, 140);
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanTerm(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function normalizeEmail(value: unknown): string | null {
  const match = cleanText(value).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const domain = email.split('@')[1]?.toLowerCase().replace(/^www\./, '');
  return domain || null;
}

function firstNameFrom(fullName: string | null | undefined, email?: string | null): string | null {
  const name = cleanText(fullName);
  if (name) return name.split(/\s+/)[0] || null;
  if (!email) return null;
  const local = email.split('@')[0] || '';
  const part = local.split(/[._+-]+/).find(x => x.length > 0);
  return part ? part.replace(/^\w/, c => c.toUpperCase()) : null;
}

function parseMaybeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function collectEmailEntries(value: unknown): Array<{ email: string; display_name?: string }> {
  if (value == null) return [];
  if (typeof value === 'string') {
    const parsed = value.trim().startsWith('[') || value.trim().startsWith('{') ? parseMaybeJson(value) : value;
    if (parsed !== value) return collectEmailEntries(parsed);
    const entries: Array<{ email: string; display_name?: string }> = [];
    const re = /(?:"?([^"<,;]+?)"?\s*)?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      const email = normalizeEmail(match[2]);
      if (!email) continue;
      const display = cleanText(match[1]).replace(/^"|"$/g, '');
      entries.push({ email, display_name: display || undefined });
    }
    return entries;
  }
  if (Array.isArray(value)) return value.flatMap(collectEmailEntries);
  if (typeof value === 'object') {
    const record = value as Record<string, any>;
    const email =
      normalizeEmail(record.email) ||
      normalizeEmail(record.address) ||
      normalizeEmail(record.emailAddress?.address) ||
      normalizeEmail(record.email_address);
    if (!email) return [];
    const display = cleanText(record.name || record.displayName || record.emailAddress?.name);
    return [{ email, display_name: display || undefined }];
  }
  const email = normalizeEmail(value);
  return email ? [{ email }] : [];
}

function termsFromQuery(query: string): string[] {
  const tokens = (query.toLowerCase().match(/[a-z0-9][a-z0-9._@-]{2,}/gi) || [])
    .map(t => t.replace(/^[-_.]+|[-_.]+$/g, ''))
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
  const phrases: string[] = [];
  const words = query.match(/[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){1,4}/g) || [];
  for (const phrase of words) phrases.push(phrase);
  return unique([...phrases, ...tokens]).slice(0, MAX_TEXT_TERMS);
}

function expandAliases(query: string, aliases: string[], domains: string[]): { aliases: string[]; domains: string[] } {
  const lower = query.toLowerCase();
  const aliasOut = [...aliases];
  const domainOut = [...domains];
  if (/\bbank of america\b|\bbofa\b|\bmerrill\b/.test(lower)) {
    aliasOut.push('Bank of America', 'BofA', 'Merrill', 'Merrill Lynch');
    domainOut.push('bankofamerica.com', 'bofa.com', 'ml.com');
  }
  if (/\bquantum\b/.test(lower)) {
    aliasOut.push('quantum computing', 'quantum', 'post-quantum');
  }
  if (/\bai infra\b|\bai infrastructure\b|\bintelligent infrastructure\b/.test(lower)) {
    aliasOut.push('AI infrastructure', 'intelligent infrastructure', 'infrastructure');
  }
  return {
    aliases: unique(aliasOut),
    domains: unique(domainOut.map(d => d.replace(/^@/, '').replace(/^www\./, ''))),
  };
}

function defaultSourceFamilies(taskType: MaxSetTaskType): MaxSetSourceFamily[] {
  if (taskType === 'invite_roster') return ['communications', 'campaigns', 'documents'];
  if (taskType === 'touchpoint_roster') return ['communications', 'events', 'tasks', 'documents', 'contacts', 'companies'];
  if (taskType === 'entity_theme_set') return ['companies', 'deals', 'documents', 'communications', 'events'];
  if (taskType === 'funding_interest_gap') return ['communications', 'events', 'tasks', 'contacts', 'documents', 'companies', 'deals'];
  if (taskType === 'firm_involvement') return ['deals', 'communications', 'documents', 'events', 'contacts', 'companies'];
  if (taskType === 'open_loops') return ['tasks', 'communications', 'events'];
  if (taskType === 'account_map') return ['contacts', 'communications', 'events', 'companies'];
  if (taskType === 'campaign_response_set') return ['campaigns', 'communications', 'contacts', 'companies'];
  if (taskType === 'document_list_reconstruction') return ['documents', 'communications'];
  if (taskType === 'deal_process_history') return ['deals', 'communications', 'events', 'tasks', 'documents'];
  return SOURCE_FAMILIES;
}

function inferTaskType(query: string): MaxSetTaskType {
  const lower = query.toLowerCase();
  if (/\b(invite|invited|attendee|attendees|registrant|webinar|town hall|dinner|mail merge)\b/.test(lower)) return 'invite_roster';
  if (/\b(touchpoint|touch point|ever talked|interactions|relationship history)\b/.test(lower)) return 'touchpoint_roster';
  if (/\b(showed interest|interested|funding|fund the funds|committed|invested money|never.*invest)\b/.test(lower)) return 'funding_interest_gap';
  if (/\b(vc firm|venture firm|coinvestor|co-investor|firm involved|firms involved)\b/.test(lower)) return 'firm_involvement';
  if (/\b(open loop|follow up|follow-up|action item|promised|owed)\b/.test(lower)) return 'open_loops';
  if (/\b(account map|everyone we know at|all people at|all contacts at|who do we know at)\b/.test(lower)) return 'account_map';
  if (/\b(campaign|blast|mailing list|replied positively|positive replies)\b/.test(lower)) return 'campaign_response_set';
  if (/\b(source workbook|source spreadsheet|find the list|reconstruct.*list|document list)\b/.test(lower)) return 'document_list_reconstruction';
  if (/\b(deal process|deal history|who touched|touched this deal)\b/.test(lower)) return 'deal_process_history';
  if (/\b(startup|company|companies|sector|theme|quantum|robotics|defense|infrastructure)\b/.test(lower)) return 'entity_theme_set';
  return 'generic_set';
}

function inferEntityKind(query: string, taskType: MaxSetTaskType): MaxSetEntityKind {
  const lower = query.toLowerCase();
  if (taskType === 'invite_roster' || /\bpeople|person|everyone|everybody|contacts?\b/.test(lower)) return 'person';
  if (taskType === 'firm_involvement' || /\bvc firm|firm|firms|investor|investors\b/.test(lower)) return 'firm';
  if (/\bstartup|startups\b/.test(lower)) return 'startup';
  if (/\bcompany|companies\b/.test(lower)) return 'company';
  if (/\bdeal|deals\b/.test(lower)) return 'deal';
  if (taskType === 'touchpoint_roster') return 'touchpoint';
  return 'mixed';
}

function inferDateRangeFromQuery(query: string, taskType: MaxSetTaskType): { start?: string; end?: string } {
  const lower = query.toLowerCase();
  const monthMap: Record<string, number> = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
    may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  };
  const match = lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (!match) return {};
  const month = monthMap[match[1]];
  const day = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return {};
  const year = match[3] ? Number(match[3]) : new Date().getUTCFullYear();
  const target = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(target.getTime())) return {};
  const start = new Date(target);
  const end = new Date(target);
  if (taskType === 'invite_roster') {
    start.setUTCDate(start.getUTCDate() - 45);
    end.setUTCDate(end.getUTCDate() + 2);
  } else {
    start.setUTCDate(start.getUTCDate() - 7);
    end.setUTCDate(end.getUTCDate() + 7);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function titleTermsForTask(query: string, taskType: MaxSetTaskType, namedPeople: string[]): string[] {
  const namedParts = new Set(namedPeople.flatMap(person => compactText(person).split(/\s+/)).filter(Boolean));
  return termsFromQuery(query)
    .filter(term => {
      const compact = compactText(term);
      if (!compact || namedParts.has(compact)) return false;
      if (taskType === 'invite_roster' && /^(raul|henriquez|tony|jimenez|myself|invited|invite|webinar|mail|merge|emails?|names?|excel)$/.test(compact)) return false;
      return true;
    })
    .slice(0, MAX_TEXT_TERMS);
}

function namedPeopleForPlan(input: BuildMaxSetInput, taskType: MaxSetTaskType): MaxSetNamedPerson[] {
  const role: MaxSetNamedPerson['role'] = taskType === 'invite_roster' ? 'inviter' : 'target';
  return unique(input.named_people || []).map(value => ({
    email: normalizeEmail(value) || undefined,
    name: normalizeEmail(value) ? undefined : cleanText(value),
    role,
  })).filter(person => person.email || person.name);
}

export function planMaxSetJob(input: BuildMaxSetInput, profile: SearchProfile): MaxSetJobPlan {
  const inferredDateRange = input.date_range || inferDateRangeFromQuery(profile.query, profile.taskType);
  const titleTerms = titleTermsForTask(profile.query, profile.taskType, input.named_people || []);
  const sourcePolicy = sourcePolicyForTask(profile.taskType);
  const anchors: MaxSetAnchor[] = [];
  if (inferredDateRange.start || inferredDateRange.end) {
    anchors.push({
      type: 'date_window',
      label: [inferredDateRange.start, inferredDateRange.end].filter(Boolean).join(' to '),
      confidence: 'probable',
      source_family: 'communications',
      why: 'Date window inferred from the user request',
    });
  }
  for (const domain of profile.domains) {
    anchors.push({
      type: 'domain',
      label: domain,
      confidence: 'confirmed',
      source_family: 'contacts',
      why: 'Domain supplied or inferred as an entity alias',
    });
  }
  for (const person of namedPeopleForPlan(input, profile.taskType)) {
    anchors.push({
      type: 'person',
      label: person.email || person.name || 'Named person',
      confidence: person.email ? 'confirmed' : 'probable',
      source_family: 'contacts',
      why: profile.taskType === 'invite_roster' ? 'Named inviter constraint' : 'Named person/entity constraint',
    });
  }
  return {
    task_type: profile.taskType,
    entity_kind: profile.entityKind,
    original_query: profile.query,
    target_scope: {
      title_terms: titleTerms.length > 0 ? titleTerms : profile.includeTerms.slice(0, 5),
      date_range: inferredDateRange.start || inferredDateRange.end ? inferredDateRange : undefined,
      named_people: namedPeopleForPlan(input, profile.taskType),
      domains: profile.domains,
      aliases: profile.aliases,
    },
    anchors,
    membership_predicate: membershipPredicateForTask(profile.taskType),
    source_policy: sourcePolicy,
    artifact_policy: {
      wants_artifact: profile.wantsArtifact,
      artifact_kind: profile.wantsArtifact ? 'xlsx' : 'none',
      require_quality_gate: true,
    },
    quality_policy: {
      block_on_authoritative_errors: true,
      block_on_caps: true,
      require_authoritative_candidates: true,
      suppress_generated_artifact_sources: true,
    },
  };
}

function membershipPredicateForTask(taskType: MaxSetTaskType): string {
  if (taskType === 'invite_roster') return 'Candidate was a recipient of an anchored outbound invite, campaign recipient, or row in an authoritative invite/registrant spreadsheet for the target event.';
  if (taskType === 'touchpoint_roster') return 'Candidate is a communication, event, task, or note touchpoint tied to the requested account/entity scope.';
  if (taskType === 'funding_interest_gap') return 'Candidate has positive funding-interest evidence and no investment/commitment exclusion evidence.';
  if (taskType === 'firm_involvement') return 'Firm is directly involved through deal, communication, document, or meeting evidence tied to the requested process.';
  if (taskType === 'open_loops') return 'Candidate is an unresolved action item, task, promise, or follow-up tied to the requested scope.';
  return 'Candidate is included by direct structured evidence or strong anchored evidence tied to the requested set.';
}

async function discoverAnchors(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  plan: MaxSetJobPlan
): Promise<void> {
  const terms = unique([...(plan.target_scope.title_terms || []), ...profile.includeTerms]).slice(0, 8);
  if (terms.length === 0 && !plan.target_scope.date_range && plan.target_scope.domains.length === 0) return;
  const pushAnchor = (anchor: MaxSetAnchor) => {
    const key = `${anchor.type}:${anchor.source_family}:${anchor.id || anchor.label}`;
    if (plan.anchors.some(existing => `${existing.type}:${existing.source_family}:${existing.id || existing.label}` === key)) return;
    plan.anchors.push(anchor);
  };

  if (profile.sourceFamilies.includes('communications')) {
    const sharingFlags = await getSharingFlags(ctx.orgId, env);
    const where = ['org_id = ?'];
    const binds: unknown[] = [ctx.orgId];
    addLikeTermClauses(where, binds, ['subject', 'body_preview'], terms);
    if (profile.taskType === 'invite_roster') {
      const inviterEmails = plan.target_scope.named_people.filter(p => p.role === 'inviter' && p.email).map(p => p.email!.toLowerCase());
      where.push("source = 'outlook'");
      if (inviterEmails.length > 0) {
        where.push(`LOWER(from_email) IN (${inviterEmails.map(() => '?').join(',')})`);
        binds.push(...inviterEmails);
      }
    }
    addDateRange(where, binds, 'sent_at', profile);
    const rows = await env.D1.prepare(
      `SELECT c.id, c.external_thread_id, c.subject, c.sent_at, c.from_email, c.source,
              c.participant_user_ids, c.is_campaign_email, c.external_message_id,
              sc.is_private AS slack_is_private
         FROM conversations c
         LEFT JOIN slack_channels sc
           ON c.source = 'slack'
          AND sc.org_id = c.org_id
          AND sc.channel_id = CASE
            WHEN instr(c.external_message_id, ':') > 0
            THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
            ELSE c.external_message_id
          END
        WHERE ${where.map(clause => clause.replace(/\borg_id\b/g, 'c.org_id').replace(/\bsubject\b/g, 'c.subject').replace(/\bbody_preview\b/g, 'c.body_preview').replace(/\bsource\b/g, 'c.source').replace(/\bfrom_email\b/g, 'c.from_email').replace(/\bsent_at\b/g, 'c.sent_at')).join(' AND ')}
        ORDER BY c.sent_at DESC
        LIMIT 30`
    ).bind(...binds).all<any>().catch(() => ({ results: [] as any[] }));
    const seenThreads = new Set<string>();
    for (const row of rows.results || []) {
      const canRead = canReadConversationContent({
        source: row.source,
        participant_user_ids: row.participant_user_ids,
        is_campaign_email: row.is_campaign_email,
        slack_is_private: row.slack_is_private,
      }, ctx.userId, ctx.userRole, sharingFlags);
      if (!canRead) continue;
      const id = row.external_thread_id || row.id;
      if (seenThreads.has(id)) continue;
      seenThreads.add(id);
      pushAnchor({
        type: 'conversation_thread',
        id,
        label: cleanText(row.subject || row.from_email || id).slice(0, 160),
        confidence: row.external_thread_id ? 'confirmed' : 'probable',
        source_family: 'communications',
        why: profile.taskType === 'invite_roster' ? 'Matching outbound invite-thread candidate' : 'Matching communication thread candidate',
      });
    }
  }

  if (profile.sourceFamilies.includes('campaigns')) {
    const where = ['org_id = ?', 'deleted_at IS NULL'];
    const binds: unknown[] = [ctx.orgId];
    addLikeTermClauses(where, binds, ['title', 'subject', 'body_template'], terms);
    addDateRange(where, binds, 'COALESCE(sent_at, scheduled_at, created_at)', profile);
    const rows = await env.D1.prepare(
      `SELECT id, title, subject, created_at
         FROM email_campaigns
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 20`
    ).bind(...binds).all<any>().catch(() => ({ results: [] as any[] }));
    for (const row of rows.results || []) {
      pushAnchor({
        type: 'campaign',
        id: row.id,
        label: cleanText(row.title || row.subject || row.id).slice(0, 160),
        confidence: 'confirmed',
        source_family: 'campaigns',
        why: 'Matching campaign anchor',
      });
    }
  }

  if (profile.sourceFamilies.includes('documents')) {
    const sharingSet = new Set(Object.keys(await getSharingFlags(ctx.orgId, env)));
    const where = [
      'org_id = ?',
      'deleted_at IS NULL',
      "processing_status != 'excluded'",
      "COALESCE(source, '') != 'marty_generated'",
      "COALESCE(json_extract(custom_fields, '$.marty_generated'), 0) != 1",
      "COALESCE(json_extract(custom_fields, '$.marty_lab_generated'), 0) != 1",
      "COALESCE(json_extract(custom_fields, '$.max_mode_set_builder'), 0) != 1",
    ];
    const binds: unknown[] = [ctx.orgId];
    addLikeTermClauses(where, binds, ['title', 'file_name', 'document_type', 'extracted_text_preview'], [
      ...terms,
      ...(profile.taskType === 'invite_roster' ? ['invite', 'attendee', 'registrant', 'webinar'] : []),
    ]);
    addDateRange(where, binds, 'created_at', profile);
    const rows = await env.D1.prepare(
      `SELECT id, title, file_name, document_type, created_at, visibility, participant_user_ids, uploaded_by
         FROM documents
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 20`
    ).bind(...binds).all<any>().catch(() => ({ results: [] as any[] }));
    for (const row of rows.results || []) {
      if (!isDocumentAccessibleToUser(row, ctx.userId, ctx.userRole, sharingSet)) continue;
      pushAnchor({
        type: 'document',
        id: row.id,
        label: cleanText(row.title || row.file_name || row.id).slice(0, 160),
        confidence: /invite|attendee|registrant|spreadsheet|xlsx|csv/i.test([row.title, row.file_name, row.document_type].join(' ')) ? 'confirmed' : 'probable',
        source_family: 'documents',
        why: 'Matching document/list anchor',
      });
    }
  }
}

function wantsArtifact(query: string, artifactKind: unknown, createArtifact: unknown): boolean {
  if (artifactKind === 'none' || createArtifact === false) return false;
  if (createArtifact === true || artifactKind === 'xlsx') return true;
  return /\b(export|xlsx|excel|spreadsheet|file|mail merge|csv|download)\b/i.test(query);
}

function buildProfile(input: BuildMaxSetInput): SearchProfile {
  const query = cleanText(input.query);
  const taskType = input.task_type || inferTaskType(query);
  const entityKind = input.entity_kind || inferEntityKind(query, taskType);
  const expanded = expandAliases(query, input.aliases || [], input.domains || []);
  const namedPersonParts = new Set((input.named_people || [])
    .flatMap(value => compactText(value).split(/\s+/))
    .filter(Boolean));
  const includeTerms = unique([
    ...(input.include_terms || []),
    ...expanded.aliases,
    ...termsFromQuery(query),
    ...(taskType === 'invite_roster' ? [] : (input.named_people || [])),
  ]).filter(term => {
    if (taskType !== 'invite_roster') return true;
    const compact = compactText(term);
    return !namedPersonParts.has(compact) && !/^raul$|^henriquez$|^tony$|^jimenez$|^raul medinavc com$/.test(compact);
  }).slice(0, MAX_TEXT_TERMS);
  const excludeTerms = unique(input.exclude_terms || []);
  const families = Array.isArray(input.source_families) && input.source_families.length > 0
    ? input.source_families.filter((f): f is MaxSetSourceFamily => SOURCE_FAMILIES.includes(f as MaxSetSourceFamily))
    : defaultSourceFamilies(taskType);
  const defaultColumns = taskType === 'invite_roster' || /\bmail merge\b/i.test(query)
    ? ['first_name', 'full_name', 'email', 'company', 'confidence', 'source_count', 'evidence_summary']
    : ['canonical_name', 'email', 'company', 'domain', 'confidence', 'source_count', 'source_families', 'evidence_summary'];
  return {
    query,
    taskType,
    entityKind,
    includeTerms,
    excludeTerms,
    aliases: expanded.aliases,
    domains: expanded.domains,
    sourceFamilies: families,
    dateRange: input.date_range || inferDateRangeFromQuery(query, taskType),
    wantsArtifact: wantsArtifact(query, input.artifact_kind, input.create_artifact),
    outputColumns: Array.isArray(input.output_columns) && input.output_columns.length > 0
      ? input.output_columns.map(cleanText).filter(Boolean)
      : defaultColumns,
  };
}

function textMatchesProfile(text: string, profile: SearchProfile): boolean {
  const haystack = compactText(text);
  if (!haystack) return false;
  if (profile.domains.some(domain => haystack.includes(compactText(domain)))) return true;
  return profile.includeTerms.length === 0 || profile.includeTerms.some(term => haystack.includes(compactText(term)));
}

function hasExcludedText(text: string, profile: SearchProfile): boolean {
  const haystack = compactText(text);
  return profile.excludeTerms.some(term => haystack.includes(compactText(term)));
}

function addLikeTermClauses(where: string[], binds: unknown[], columns: string[], terms: string[]): void {
  const cleanTerms = unique(terms).slice(0, MAX_TEXT_TERMS);
  if (cleanTerms.length === 0) return;
  const clauses: string[] = [];
  for (const term of cleanTerms) {
    clauses.push(`(${columns.map(col => `LOWER(COALESCE(${col}, '')) LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < columns.length; i++) binds.push(`%${term.toLowerCase()}%`);
  }
  where.push(`(${clauses.join(' OR ')})`);
}

function addDateRange(where: string[], binds: unknown[], column: string, profile: SearchProfile): void {
  if (profile.dateRange.start) {
    where.push(`${column} >= ?`);
    binds.push(profile.dateRange.start);
  }
  if (profile.dateRange.end) {
    where.push(`${column} <= ?`);
    binds.push(profile.dateRange.end);
  }
}

function candidateKey(draft: CandidateDraft, profile: SearchProfile): string {
  const kind = draft.entityKind || profile.entityKind;
  if (draft.id) return `${kind}:id:${draft.id}`;
  const email = normalizeEmail(draft.email);
  if (kind === 'person' && email) return `person:email:${email}`;
  const domain = cleanTerm(draft.domain || domainFromEmail(email) || '');
  if ((kind === 'company' || kind === 'firm' || kind === 'startup') && domain) return `${kind}:domain:${domain}`;
  const name = compactText(draft.name || email || draft.domain || 'unknown');
  const company = compactText(draft.company || '');
  return `${kind}:name:${name}:${company}`;
}

function findExistingCandidateKey(
  target: Map<string, MaxSetCandidate>,
  draft: CandidateDraft,
  profile: SearchProfile,
  preferredKey: string
): string {
  if (target.has(preferredKey)) return preferredKey;
  const kind = draft.entityKind || profile.entityKind;
  const email = normalizeEmail(draft.email);
  const domain = cleanTerm(draft.domain || domainFromEmail(email) || '');
  const name = compactText(draft.name || '');
  const company = compactText(draft.company || '');
  for (const [key, candidate] of target.entries()) {
    if ((kind === 'person' || candidate.entity_kind === 'person') && email && candidate.email && normalizeEmail(candidate.email) === email) {
      return key;
    }
    if (
      (kind === 'company' || kind === 'firm' || kind === 'startup' ||
        candidate.entity_kind === 'company' || candidate.entity_kind === 'firm' || candidate.entity_kind === 'startup') &&
      domain &&
      candidate.domain &&
      compactText(candidate.domain) === domain
    ) {
      return key;
    }
    if (
      name &&
      compactText(candidate.canonical_name) === name &&
      (!company || compactText(candidate.company || '') === company)
    ) {
      return key;
    }
  }
  return preferredKey;
}

function confidenceMax(a: MaxSetConfidence, b: MaxSetConfidence): MaxSetConfidence {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a;
}

function safeEvidence(evidence: MaxSetEvidence): MaxSetEvidence {
  return {
    source_family: evidence.source_family,
    source_table: evidence.source_table,
    source_id: evidence.source_id,
    anchor_id: evidence.anchor_id || undefined,
    evidence_type: evidence.evidence_type || 'text_mention',
    title: evidence.title || undefined,
    date: evidence.date || undefined,
    detail: cleanText(evidence.detail).slice(0, 500),
    strength: evidence.strength,
    satisfies_membership: Boolean(evidence.satisfies_membership),
  };
}

function addCandidate(
  map: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>,
  draft: CandidateDraft,
  profile: SearchProfile
): void {
  const target = draft.exclude ? excluded : map;
  const key = findExistingCandidateKey(target, draft, profile, candidateKey(draft, profile));
  const email = normalizeEmail(draft.email);
  const domain = cleanTerm(draft.domain || domainFromEmail(email) || '');
  const name = cleanText(draft.name || draft.email || draft.domain || 'Unknown');
  const kind = draft.entityKind || profile.entityKind;
  const existing = target.get(key);
  const evidence = safeEvidence(draft.evidence);
  const satisfiesMembership = Boolean(evidence.satisfies_membership);
  if (!existing) {
    target.set(key, {
      canonical_id: key,
      canonical_name: name,
      entity_kind: kind,
      email,
      first_name: firstNameFrom(name, email),
      company: cleanText(draft.company) || null,
      domain: domain || null,
      confidence: satisfiesMembership ? draft.confidence : draft.confidence === 'confirmed' ? 'probable' : draft.confidence,
      membership_predicate_satisfied: satisfiesMembership,
      source_count: 1,
      source_families: [evidence.source_family],
      evidence: [evidence],
      why_included: [draft.exclude ? (draft.exclusionReason || draft.why) : draft.why],
      why_excluded: draft.exclude ? [draft.exclusionReason || draft.why] : undefined,
      unresolved_fields: [
        kind === 'person' && !email ? 'email' : '',
        !name || name === 'Unknown' ? 'name' : '',
      ].filter(Boolean),
    });
    return;
  }
  existing.confidence = confidenceMax(existing.confidence, satisfiesMembership ? draft.confidence : draft.confidence === 'confirmed' ? 'probable' : draft.confidence);
  existing.membership_predicate_satisfied = existing.membership_predicate_satisfied || satisfiesMembership;
  const sourceKey = `${evidence.source_table}:${evidence.source_id}:${evidence.evidence_type}`;
  const existingSourceKeys = new Set(existing.evidence.map(e => `${e.source_table}:${e.source_id}:${e.evidence_type}`));
  if (!existingSourceKeys.has(sourceKey)) existing.source_count += 1;
  if (!existing.email && email) existing.email = email;
  if (!existing.first_name) existing.first_name = firstNameFrom(existing.canonical_name, existing.email);
  if (!existing.company && draft.company) existing.company = cleanText(draft.company);
  if (!existing.domain && domain) existing.domain = domain;
  if (!existing.source_families.includes(evidence.source_family)) existing.source_families.push(evidence.source_family);
  if (existing.evidence.length < MAX_MODE_LIMITS.setBuilderEvidencePerCandidate && !existingSourceKeys.has(sourceKey)) existing.evidence.push(evidence);
  const why = draft.exclude ? (draft.exclusionReason || draft.why) : draft.why;
  if (why && !existing.why_included.includes(why)) existing.why_included.push(why);
  if (draft.exclude) {
    existing.why_excluded = existing.why_excluded || [];
    if (why && !existing.why_excluded.includes(why)) existing.why_excluded.push(why);
  }
  if (kind === 'person' && email) existing.unresolved_fields = existing.unresolved_fields.filter(f => f !== 'email');
  if (name && name !== 'Unknown') existing.unresolved_fields = existing.unresolved_fields.filter(f => f !== 'name');
}

function companyFromEmail(email: string | null, displayName?: string | null): string | null {
  const domain = domainFromEmail(email);
  if (!domain || INTERNAL_DOMAINS.has(domain)) return null;
  if (displayName && displayName.includes('@')) return null;
  return domain.split('.')[0]?.replace(/^\w/, c => c.toUpperCase()) || domain;
}

function evidenceSummary(candidate: MaxSetCandidate): string {
  return candidate.evidence
    .slice(0, 3)
    .map(e => `${e.source_family}: ${e.title || e.detail}`.slice(0, 160))
    .join(' | ');
}

function bucketRows(candidates: MaxSetCandidate[], columns: string[]): any[][] {
  const header = columns;
  const rows = candidates.map(candidate => columns.map(column => {
    if (column === 'first_name') return candidate.first_name || '';
    if (column === 'full_name' || column === 'canonical_name') return candidate.canonical_name;
    if (column === 'email') return candidate.email || '';
    if (column === 'company') return candidate.company || '';
    if (column === 'domain') return candidate.domain || '';
    if (column === 'confidence') return candidate.confidence;
    if (column === 'source_count') return candidate.source_count;
    if (column === 'source_families') return candidate.source_families.join(', ');
    if (column === 'evidence_summary') return evidenceSummary(candidate);
    if (column === 'why_included') return candidate.why_included.join('; ');
    return (candidate as any)[column] ?? '';
  }));
  return [header, ...rows];
}

function isInternalEmail(email: string | null | undefined): boolean {
  const domain = domainFromEmail(email || null);
  return Boolean(domain && INTERNAL_DOMAINS.has(domain));
}

function fundingInterestTerms(): string[] {
  return ['interest', 'interested', 'commit', 'commitment', 'invest', 'investment', 'allocation', 'subscribe', 'subscription', 'lp', 'fund'];
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(cleanText(current));
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(cleanText(current));
  return cells;
}

function splitTabularText(text: string): Array<{ name: string; csv: string }> {
  const marker = /^--- Sheet: (.+?) ---\s*$/gm;
  const matches = Array.from(text.matchAll(marker));
  if (matches.length === 0) return [{ name: 'Document', csv: text }];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return {
      name: cleanText(match[1]) || `Sheet ${index + 1}`,
      csv: text.slice(start, end).trim(),
    };
  }).filter(section => section.csv.length > 0);
}

function normalizeHeaderCell(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function headerKind(value: unknown): 'email' | 'full_name' | 'first_name' | 'last_name' | 'company' | 'title' | null {
  const h = normalizeHeaderCell(value);
  if (!h) return null;
  if (/^(e[- ]?mail|email address|contact email|person email|recipient email|to|to email)$/.test(h)) return 'email';
  if (/^(full name|name|contact name|person name|recipient name|invitee|attendee)$/.test(h)) return 'full_name';
  if (/^(first name|firstname|given name)$/.test(h)) return 'first_name';
  if (/^(last name|lastname|surname|family name)$/.test(h)) return 'last_name';
  if (/^(company|company name|organization|organisation|firm|fund|employer|account)$/.test(h)) return 'company';
  if (/^(title|job title|role|position)$/.test(h)) return 'title';
  return null;
}

function findTabularHeader(rows: string[][]): { index: number; columns: Partial<Record<ReturnType<typeof headerKind> & string, number>> } | null {
  let best: { index: number; score: number; columns: Partial<Record<string, number>> } | null = null;
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const columns: Partial<Record<string, number>> = {};
    let score = 0;
    rows[i].forEach((cell, idx) => {
      const kind = headerKind(cell);
      if (!kind || columns[kind] !== undefined) return;
      columns[kind] = idx;
      score += kind === 'email' ? 3 : kind === 'full_name' || kind === 'first_name' ? 2 : 1;
    });
    if (score > (best?.score || 0)) best = { index: i, score, columns };
  }
  if (!best || best.score < 3 || best.columns.email === undefined && best.columns.full_name === undefined && best.columns.first_name === undefined) {
    return null;
  }
  return { index: best.index, columns: best.columns as any };
}

function tabularCell(row: string[], index: number | undefined): string {
  return index === undefined ? '' : cleanText(row[index]);
}

function nameFromTabularRow(row: string[], columns: Partial<Record<string, number>>, email: string | null): string {
  const full = tabularCell(row, columns.full_name);
  if (full && !normalizeEmail(full)) return full;
  const first = tabularCell(row, columns.first_name);
  const last = tabularCell(row, columns.last_name);
  const combined = [first, last].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  const displayed = collectEmailEntries(row.join(' ')).find(entry => entry.email === email)?.display_name;
  return displayed || email || '';
}

function extractPersonRowsFromTabularText(text: string): Array<{
  name: string;
  email: string | null;
  company: string | null;
  confidence: MaxSetConfidence;
  detail: string;
}> {
  const candidates: Array<{ name: string; email: string | null; company: string | null; confidence: MaxSetConfidence; detail: string }> = [];
  const seen = new Set<string>();
  for (const section of splitTabularText(text)) {
    const rows = section.csv
      .split(/\r?\n/)
      .map(line => parseCsvLine(line))
      .filter(row => row.some(cell => cleanText(cell)));
    if (rows.length === 0) continue;
    const header = findTabularHeader(rows);
    if (header) {
      for (let i = header.index + 1; i < rows.length; i++) {
        const row = rows[i];
        const explicitEmail = normalizeEmail(tabularCell(row, header.columns.email));
        const anyEmail = explicitEmail || collectEmailEntries(row.join(' '))[0]?.email || null;
        const name = nameFromTabularRow(row, header.columns, anyEmail);
        const company = tabularCell(row, header.columns.company) || companyFromEmail(anyEmail);
        if (!anyEmail && (!name || name.length < 2)) continue;
        const key = anyEmail ? `email:${anyEmail}` : `name:${compactText(name)}:${compactText(company || '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          name: name || anyEmail || 'Unknown',
          email: anyEmail,
          company: company || null,
          confidence: anyEmail && name ? 'confirmed' : anyEmail ? 'probable' : 'needs_review',
          detail: `Tabular document row from ${section.name}`,
        });
      }
      continue;
    }

    for (const row of rows) {
      const entries = collectEmailEntries(row.join(' '));
      for (const entry of entries) {
        if (isInternalEmail(entry.email)) continue;
        const beforeEmail = row.slice(0, Math.max(0, row.findIndex(cell => cell.includes(entry.email))));
        const name = entry.display_name || beforeEmail.reverse().find(cell => cell && !normalizeEmail(cell) && !/@/.test(cell)) || entry.email;
        const key = `email:${entry.email}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          name,
          email: entry.email,
          company: companyFromEmail(entry.email, name),
          confidence: entry.display_name ? 'probable' : 'needs_review',
          detail: `Unstructured tabular email from ${section.name}`,
        });
      }
    }
  }
  return candidates;
}

async function loadR2TextExcerpt(env: Env, key: string | null | undefined, maxChars = 12000): Promise<string> {
  if (!key) return '';
  try {
    const obj = await env.R2.get(key);
    if (!obj) return '';
    return (await obj.text()).slice(0, maxChars);
  } catch {
    return '';
  }
}

async function extractDocumentText(row: any, env: Env): Promise<string> {
  if (!row.r2_key) return row.extracted_text_preview || '';
  try {
    const obj = await env.R2.get(row.r2_key);
    if (!obj) return row.extracted_text_preview || '';
    const buffer = await obj.arrayBuffer();
    const file = new File([buffer], row.file_name || row.title || 'document', { type: row.mime_type || '' });
    const text = await extractTextFromFile(file);
    return text || row.extracted_text_preview || '';
  } catch {
    return row.extracted_text_preview || '';
  }
}

async function loadConversationContactMap(
  env: Env,
  conversationIds: string[]
): Promise<Map<string, CommunicationLinkedContact[]>> {
  const ids = [...new Set(conversationIds.filter(Boolean))];
  const out = new Map<string, CommunicationLinkedContact[]>();
  if (ids.length === 0) return out;
  const rows = await queryRowsInBatches<CommunicationLinkedContact>(
    env,
    ids,
    placeholders => `SELECT cc.conversation_id, cc.contact_id, c.full_name, c.email,
            co.name AS company_name, co.domain AS company_domain
       FROM conversation_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE cc.conversation_id IN (${placeholders})`
  );
  for (const row of rows) {
    const list = out.get(row.conversation_id) || [];
    list.push(row);
    out.set(row.conversation_id, list);
  }
  return out;
}

function domainConfirmed(domain: string | null | undefined, profile: SearchProfile): boolean {
  if (!domain) return false;
  const normalized = compactText(domain);
  return profile.domains.some(d => compactText(d) === normalized);
}

function addCommunicationCandidatesFromMatch(
  row: any,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>,
  evidence: MaxSetEvidence,
  matchText: string,
  linkedContacts: CommunicationLinkedContact[],
  bodyText = ''
): number {
  const before = candidates.size + excluded.size;
  const excludedByText = hasExcludedText(matchText, profile);
  if (profile.taskType === 'invite_roster' || profile.entityKind === 'person') {
    const headerEntries = [
      ...collectEmailEntries(row.to_emails),
      ...collectEmailEntries(row.cc_emails),
    ];
    const headerEmails = new Set(headerEntries.map(entry => entry.email));
    const entries = [...headerEntries];
    if (profile.taskType !== 'invite_roster' && row.from_email && !isInternalEmail(row.from_email)) {
      entries.push({ email: row.from_email, display_name: row.from_name });
    }
    for (const entry of entries) {
      if (isInternalEmail(entry.email)) continue;
      addCandidate(candidates, excluded, {
        entityKind: 'person',
        name: entry.display_name || entry.email,
        email: entry.email,
        company: companyFromEmail(entry.email, entry.display_name),
        confidence: profile.taskType === 'invite_roster' ? 'confirmed' : 'probable',
        why: profile.taskType === 'invite_roster' ? 'Appeared as an email recipient on a matching invite/thread' : 'Appeared in a matching communication',
        evidence,
        exclude: excludedByText,
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    }
    for (const contact of linkedContacts) {
      if (isInternalEmail(contact.email)) continue;
      const linkedSatisfiesInvite = Boolean(contact.email && headerEmails.has(contact.email.toLowerCase()));
      addCandidate(candidates, excluded, {
        entityKind: 'person',
        id: contact.contact_id,
        name: contact.full_name || contact.email,
        email: contact.email,
        company: contact.company_name || companyFromEmail(contact.email),
        domain: contact.company_domain || domainFromEmail(contact.email || undefined),
        confidence: linkedSatisfiesInvite ? 'confirmed' : 'probable',
        why: 'Linked through conversation_contacts on a matching communication',
        evidence: profile.taskType === 'invite_roster'
          ? { ...evidence, satisfies_membership: linkedSatisfiesInvite, evidence_type: linkedSatisfiesInvite ? 'direct_recipient' : 'text_mention', strength: linkedSatisfiesInvite ? 'confirmed' : 'probable' }
          : evidence,
        exclude: excludedByText,
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    }
    if (profile.taskType === 'invite_roster' && bodyText) {
      for (const entry of collectEmailEntries(bodyText)) {
        if (isInternalEmail(entry.email) || headerEmails.has(entry.email)) continue;
        addCandidate(candidates, excluded, {
          entityKind: 'person',
          name: entry.display_name || entry.email,
          email: entry.email,
          company: companyFromEmail(entry.email, entry.display_name),
          confidence: 'needs_review',
          why: 'Email address appeared in the full body of a matching invite/thread',
          evidence: { ...evidence, strength: 'needs_review', evidence_type: 'text_mention', satisfies_membership: false },
          exclude: excludedByText,
          exclusionReason: 'Matched explicit exclusion terms',
        }, profile);
      }
    }
  } else if (profile.entityKind === 'touchpoint') {
    addCandidate(candidates, excluded, {
      entityKind: 'touchpoint',
      id: row.id,
      name: row.subject || `${row.source} touchpoint`,
      confidence: 'confirmed',
      why: 'Matching communication touchpoint',
      evidence,
      exclude: excludedByText,
      exclusionReason: 'Matched explicit exclusion terms',
    }, profile);
  } else {
    const emails = [
      row.from_email,
      ...collectEmailEntries(row.to_emails).map(e => e.email),
      ...collectEmailEntries(row.cc_emails).map(e => e.email),
      ...collectEmailEntries(bodyText).map(e => e.email),
    ];
    for (const email of emails) {
      const domain = domainFromEmail(email);
      if (!domain || INTERNAL_DOMAINS.has(domain)) continue;
      addCandidate(candidates, excluded, {
        entityKind: profile.entityKind === 'startup' ? 'startup' : profile.entityKind === 'firm' ? 'firm' : 'company',
        name: companyFromEmail(email) || domain,
        domain,
        confidence: domainConfirmed(domain, profile) ? 'confirmed' : 'needs_review',
        why: 'Domain appeared in matching communications',
        evidence,
        exclude: excludedByText,
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    }
    for (const contact of linkedContacts) {
      const domain = contact.company_domain || domainFromEmail(contact.email || undefined);
      if (!contact.company_name && (!domain || INTERNAL_DOMAINS.has(domain))) continue;
      addCandidate(candidates, excluded, {
        entityKind: profile.entityKind === 'startup' ? 'startup' : profile.entityKind === 'firm' ? 'firm' : 'company',
        name: contact.company_name || companyFromEmail(contact.email) || domain,
        domain,
        confidence: contact.company_name ? 'probable' : 'needs_review',
        why: 'Linked contact organization appeared on a matching communication',
        evidence,
        exclude: excludedByText,
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    }
  }
  return Math.max(0, candidates.size + excluded.size - before);
}

async function scanCommunications(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'communications', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['c.org_id = ?'];
  const binds: unknown[] = [ctx.orgId];
  const inviterEmails = profile.plan?.target_scope.named_people
    .filter(person => person.role === 'inviter' && person.email)
    .map(person => person.email!.toLowerCase()) || [];
  const communicationTerms = profile.taskType === 'invite_roster'
    ? unique([...(profile.plan?.target_scope.title_terms || []), ...profile.includeTerms]).slice(0, 8)
    : [
        ...profile.includeTerms,
        ...profile.domains,
        ...(profile.taskType === 'funding_interest_gap' ? fundingInterestTerms() : []),
      ];
  addLikeTermClauses(
    where,
    binds,
    profile.taskType === 'invite_roster'
      ? ['c.subject', 'c.body_preview']
      : ['c.subject', 'c.body_preview', 'c.from_email', 'c.to_emails', 'c.cc_emails'],
    communicationTerms
  );
  if (profile.taskType === 'invite_roster') {
    where.push("c.source = 'outlook'");
    if (inviterEmails.length > 0) {
      where.push(`LOWER(c.from_email) IN (${inviterEmails.map(() => '?').join(',')})`);
      binds.push(...inviterEmails);
    } else {
      where.push("(c.direction = 'outbound' OR LOWER(c.from_email) LIKE '%@medinavc.com')");
    }
  }
  addDateRange(where, binds, 'c.sent_at', profile);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const [rows, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, c.subject, c.from_email, c.from_contact_id, c.to_emails, c.cc_emails,
              c.body_preview, c.body_r2_key, c.source, c.direction, c.sent_at,
              c.participant_user_ids, c.is_campaign_email, c.external_message_id,
              sc.is_private AS slack_is_private, fc.full_name AS from_name, co.name AS from_company
         FROM conversations c
         LEFT JOIN contacts fc ON fc.id = c.from_contact_id
         LEFT JOIN companies co ON co.id = fc.company_id
         LEFT JOIN slack_channels sc
           ON c.source = 'slack'
          AND sc.org_id = c.org_id
          AND sc.channel_id = CASE
            WHEN instr(c.external_message_id, ':') > 0
            THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
            ELSE c.external_message_id
          END
        WHERE ${where.join(' AND ')}
        ORDER BY c.sent_at DESC
        LIMIT ?`
    ).bind(...binds, limit).all<any>(),
    getSharingFlags(ctx.orgId, env),
  ]);
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  const linkedContactMap = await loadConversationContactMap(env, rows.results.map(row => row.id));
  let bodyFetches = 0;
  for (const row of rows.results) {
    const canRead = canReadConversationContent({
      source: row.source,
      participant_user_ids: row.participant_user_ids,
      is_campaign_email: row.is_campaign_email,
      slack_is_private: row.slack_is_private,
    }, ctx.userId, ctx.userRole, sharingFlags);
    if (!canRead) continue;
    const text = [row.subject, row.body_preview, row.from_email, row.to_emails, row.cc_emails].join(' ');
    let bodyText = '';
    let matches = textMatchesProfile(text, profile) || profile.taskType === 'funding_interest_gap';
    if (!matches && row.body_r2_key && bodyFetches < MAX_MODE_LIMITS.setBuilderBodyFetchMax) {
      bodyText = await loadR2TextExcerpt(env, row.body_r2_key);
      bodyFetches += bodyText ? 1 : 0;
      matches = textMatchesProfile(bodyText, profile);
    }
    if (!matches) continue;
    if (!bodyText && row.body_r2_key && bodyFetches < MAX_MODE_LIMITS.setBuilderBodyFetchMax &&
      (profile.taskType === 'invite_roster' || profile.taskType === 'entity_theme_set' || profile.taskType === 'firm_involvement')) {
      bodyText = await loadR2TextExcerpt(env, row.body_r2_key);
      bodyFetches += bodyText ? 1 : 0;
    }
    const matchText = [text, bodyText].join(' ');
    stat.rows_returned += 1;
    const evidence: MaxSetEvidence = {
      source_family: 'communications',
      source_table: 'conversations',
      source_id: row.id,
      evidence_type: profile.taskType === 'invite_roster' ? 'direct_recipient' : profile.entityKind === 'touchpoint' ? 'touchpoint' : 'text_mention',
      title: row.subject,
      date: row.sent_at,
      detail: `${row.source} ${row.direction || ''} ${row.subject || ''}${bodyText ? ' (full body checked)' : ''}`.trim(),
      strength: profile.taskType === 'invite_roster' ? 'confirmed' : 'probable',
      satisfies_membership: true,
    };
    stat.candidates_added += addCommunicationCandidatesFromMatch(
      row,
      profile,
      candidates,
      excluded,
      evidence,
      matchText,
      linkedContactMap.get(row.id) || [],
      bodyText
    );
  }
  stat.body_fetches = bodyFetches;

  const ragQuery = profile.includeTerms.length > 0 ? profile.includeTerms.join(' ') : profile.query;
  const ragCandidates = await searchRagChunksD1Fts(env, ragQuery, {
    orgId: ctx.orgId,
    topK: 200,
    sourceTable: 'conversations',
  }).catch(error => {
    stat.errors.push(`rag_chunks_v2_fts: ${String(error?.message || error).slice(0, 220)}`);
    return [];
  });
  if (ragCandidates.length > 0 && profile.taskType !== 'invite_roster') {
    stat.cap_hit = stat.cap_hit || ragCandidates.length >= 200;
    const chunkIds = ragCandidates.map(c => c.chunkId).slice(0, 200);
    const chunkRows = await queryRowsInBatches<any>(
      env,
      chunkIds,
      placeholders => `SELECT rc.id AS chunk_id, rc.text_preview,
              c.id, c.subject, c.from_email, c.from_contact_id, c.to_emails, c.cc_emails,
              c.body_preview, c.source, c.direction, c.sent_at, c.participant_user_ids,
              c.is_campaign_email, c.external_message_id,
              sc.is_private AS slack_is_private, fc.full_name AS from_name, co.name AS from_company
         FROM rag_chunks_v2 rc
         JOIN conversations c ON c.id = rc.source_id AND c.org_id = rc.org_id
         LEFT JOIN contacts fc ON fc.id = c.from_contact_id
         LEFT JOIN companies co ON co.id = fc.company_id
         LEFT JOIN slack_channels sc
           ON c.source = 'slack'
          AND sc.org_id = c.org_id
          AND sc.channel_id = CASE
            WHEN instr(c.external_message_id, ':') > 0
            THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
            ELSE c.external_message_id
          END
        WHERE rc.org_id = ?
          AND rc.id IN (${placeholders})`,
      [ctx.orgId]
    );
    const ragLinkedMap = await loadConversationContactMap(env, chunkRows.map(row => row.id));
    stat.rows_scanned += chunkRows.length;
    for (const row of chunkRows) {
      const canRead = canReadConversationContent({
        source: row.source,
        participant_user_ids: row.participant_user_ids,
        is_campaign_email: row.is_campaign_email,
        slack_is_private: row.slack_is_private,
      }, ctx.userId, ctx.userRole, sharingFlags);
      if (!canRead) continue;
      const matchText = [row.subject, row.body_preview, row.text_preview, row.from_email, row.to_emails, row.cc_emails].join(' ');
      if (!textMatchesProfile(matchText, profile) && profile.taskType !== 'funding_interest_gap') continue;
      stat.rows_returned += 1;
      const evidence: MaxSetEvidence = {
        source_family: 'communications',
        source_table: 'rag_chunks_v2',
        source_id: row.chunk_id,
        evidence_type: profile.entityKind === 'touchpoint' ? 'touchpoint' : 'text_mention',
        title: row.subject,
        date: row.sent_at,
        detail: `Conversation content match: ${cleanText(row.text_preview).slice(0, 220)}`,
        strength: 'probable',
        satisfies_membership: true,
      };
      stat.candidates_added += addCommunicationCandidatesFromMatch(
        row,
        profile,
        candidates,
        excluded,
        evidence,
        matchText,
        ragLinkedMap.get(row.id) || [],
        row.text_preview || ''
      );
    }
  }
  return stat;
}

async function scanEvents(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'events', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['e.org_id = ?', 'e.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeTermClauses(where, binds, ['e.title', 'e.description', 'e.summary', 'e.topics_discussed', 'e.action_items'], profile.includeTerms);
  addDateRange(where, binds, 'e.start_time', profile);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT e.id, e.title, e.event_type, e.start_time, e.summary, e.action_items,
            GROUP_CONCAT(ea.user_id) AS participant_user_ids
       FROM events e
       LEFT JOIN event_attendees ea ON ea.event_id = e.id
      WHERE ${where.join(' AND ')}
      GROUP BY e.id
      ORDER BY e.start_time DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  for (const event of rows.results) {
    const participants = parseParticipantUserIds(event.participant_user_ids);
    const canRead = hasOrgWidePrivateDataAccess(ctx.userRole) ||
      participants.length === 0 ||
      participants.includes(ctx.userId) ||
      participants.some(pid => sharingFlags[pid]);
    if (!canRead) continue;
    const attendeeRows = await env.D1.prepare(
      `SELECT ea.contact_id, ea.email, ea.display_name, ea.role, ea.is_internal,
              c.full_name, co.name AS company_name
         FROM event_attendees ea
         LEFT JOIN contacts c ON c.id = ea.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE ea.event_id = ?`
    ).bind(event.id).all<any>();
    stat.rows_returned += 1;
    const excludedByText = hasExcludedText([event.title, event.summary, event.action_items].join(' '), profile);
    for (const attendee of attendeeRows.results) {
      if (attendee.is_internal || isInternalEmail(attendee.email)) continue;
      const evidence: MaxSetEvidence = {
        source_family: 'events',
        source_table: 'events',
        source_id: event.id,
        evidence_type: 'event_attendee',
        title: event.title,
        date: event.start_time,
        detail: `Event attendee (${attendee.role || 'attendee'})`,
        strength: 'confirmed',
        satisfies_membership: profile.taskType !== 'invite_roster',
      };
      const before = candidates.size + excluded.size;
      if (profile.entityKind === 'person' || profile.entityKind === 'mixed') {
        addCandidate(candidates, excluded, {
          entityKind: 'person',
          id: attendee.contact_id,
          name: attendee.full_name || attendee.display_name || attendee.email,
          email: attendee.email,
          company: attendee.company_name || companyFromEmail(attendee.email, attendee.display_name),
          confidence: 'confirmed',
          why: 'Appeared as an attendee on a matching event',
          evidence,
          exclude: excludedByText,
          exclusionReason: 'Matched explicit exclusion terms',
        }, profile);
      } else {
        const domain = domainFromEmail(attendee.email);
        if (domain && !INTERNAL_DOMAINS.has(domain)) {
          addCandidate(candidates, excluded, {
            entityKind: profile.entityKind === 'firm' ? 'firm' : profile.entityKind === 'startup' ? 'startup' : 'company',
            name: attendee.company_name || companyFromEmail(attendee.email, attendee.display_name) || domain,
            domain,
            confidence: attendee.company_name ? 'confirmed' : 'needs_review',
            why: 'Organization inferred from attendee on matching event',
            evidence,
            exclude: excludedByText,
            exclusionReason: 'Matched explicit exclusion terms',
          }, profile);
        }
      }
      stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
    }
  }
  return stat;
}

async function scanCampaigns(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'campaigns', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['ec.org_id = ?', 'ec.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeTermClauses(where, binds, ['ec.title', 'ec.subject', 'ec.body_template'], profile.includeTerms);
  addDateRange(where, binds, 'COALESCE(ec.sent_at, ec.scheduled_at, ec.created_at)', profile);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT ecr.id AS recipient_row_id, ecr.contact_id, ecr.email, ecr.status, ecr.sent_at,
            ec.id AS campaign_id, ec.title, ec.subject, ec.created_at, c.full_name, co.name AS company_name
       FROM email_campaigns ec
       JOIN email_campaign_recipients ecr ON ecr.campaign_id = ec.id
       LEFT JOIN contacts c ON c.id = ecr.contact_id
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY ec.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  for (const row of rows.results) {
    if (isInternalEmail(row.email)) continue;
    stat.rows_returned += 1;
    const evidence: MaxSetEvidence = {
      source_family: 'campaigns',
      source_table: 'email_campaigns',
      source_id: row.campaign_id,
      evidence_type: 'campaign_recipient',
      title: row.title || row.subject,
      date: row.sent_at || row.created_at,
      detail: `Campaign recipient (${row.status || 'pending'})`,
      strength: 'confirmed',
      satisfies_membership: true,
    };
    const before = candidates.size + excluded.size;
    addCandidate(candidates, excluded, {
      entityKind: 'person',
      id: row.contact_id,
      name: row.full_name || row.email,
      email: row.email,
      company: row.company_name || companyFromEmail(row.email),
      confidence: 'confirmed',
      why: 'Appeared as a campaign recipient for a matching campaign',
      evidence,
      exclude: hasExcludedText([row.title, row.subject].join(' '), profile),
      exclusionReason: 'Matched explicit exclusion terms',
    }, profile);
    stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
  }
  return stat;
}

async function scanContacts(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'contacts', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['c.org_id = ?', 'c.deleted_at IS NULL', 'c.merged_into IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeTermClauses(where, binds, ['c.full_name', 'c.email', 'c.job_title', 'c.topics_of_interest', 'c.investment_thesis_tags', 'c.bio_summary', 'co.name'], [
    ...profile.includeTerms,
    ...profile.domains,
    ...(profile.taskType === 'funding_interest_gap' ? fundingInterestTerms() : []),
  ]);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT c.id, c.full_name, c.email, c.contact_type, c.relationship_status,
            c.job_title, c.topics_of_interest, c.investment_thesis_tags, c.bio_summary,
            c.investment_amount, c.fund_commitment, co.name AS company_name, co.domain AS company_domain
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_contact_date DESC NULLS LAST
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  for (const row of rows.results) {
    const text = [row.full_name, row.email, row.job_title, row.topics_of_interest, row.investment_thesis_tags, row.bio_summary, row.company_name].join(' ');
    if (!textMatchesProfile(text, profile) && profile.taskType !== 'funding_interest_gap') continue;
    stat.rows_returned += 1;
    const invested = Number(row.investment_amount || 0) > 0 || Number(row.fund_commitment || 0) > 0;
    const evidence: MaxSetEvidence = {
      source_family: 'contacts',
      source_table: 'contacts',
      source_id: row.id,
      evidence_type: invested && profile.taskType === 'funding_interest_gap' ? 'exclusion_record' : 'crm_record',
      title: row.full_name,
      detail: `Contact record: ${[row.contact_type, row.relationship_status, row.job_title].filter(Boolean).join(', ')}`,
      strength: invested && profile.taskType === 'funding_interest_gap' ? 'confirmed' : 'probable',
      satisfies_membership: profile.taskType === 'funding_interest_gap' ? !invested : profile.taskType === 'account_map',
    };
    const before = candidates.size + excluded.size;
    addCandidate(candidates, excluded, {
      entityKind: 'person',
      id: row.id,
      name: row.full_name,
      email: row.email,
      company: row.company_name,
      domain: row.company_domain || domainFromEmail(row.email),
      confidence: row.email ? 'confirmed' : 'probable',
      why: profile.taskType === 'funding_interest_gap' ? 'Contact profile shows funding/investment interest signals' : 'Contact profile matched the set query',
      evidence,
      exclude: invested || hasExcludedText(text, profile),
      exclusionReason: invested ? 'Already has investment/fund commitment recorded' : 'Matched explicit exclusion terms',
    }, profile);
    stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
  }
  return stat;
}

async function scanCompanies(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'companies', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['org_id = ?', 'deleted_at IS NULL', 'merged_into IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeTermClauses(where, binds, ['name', 'domain', 'description', 'sector', 'company_type', 'investment_status'], [...profile.includeTerms, ...profile.domains]);
  if (profile.entityKind === 'firm') where.push("(company_type = 'vc_firm' OR company_type = 'family_office' OR company_type = 'lp' OR company_type = 'other')");
  if (profile.entityKind === 'startup') where.push("company_type = 'startup'");
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT id, name, domain, company_type, sector, investment_status, description,
            investment_amount, current_valuation
       FROM companies
      WHERE ${where.join(' AND ')}
      ORDER BY name ASC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  for (const row of rows.results) {
    const text = [row.name, row.domain, row.company_type, row.sector, row.investment_status, row.description].join(' ');
    if (!textMatchesProfile(text, profile)) continue;
    stat.rows_returned += 1;
    const evidence: MaxSetEvidence = {
      source_family: 'companies',
      source_table: 'companies',
      source_id: row.id,
      evidence_type: 'crm_record',
      title: row.name,
      detail: `Company record: ${[row.company_type, row.sector, row.investment_status].filter(Boolean).join(', ')}`,
      strength: row.domain || row.company_type ? 'confirmed' : 'probable',
      satisfies_membership: profile.taskType === 'entity_theme_set' || profile.taskType === 'account_map',
    };
    const before = candidates.size + excluded.size;
    addCandidate(candidates, excluded, {
      entityKind: row.company_type === 'vc_firm' || profile.entityKind === 'firm' ? 'firm' : row.company_type === 'startup' ? 'startup' : 'company',
      id: row.id,
      name: row.name,
      domain: row.domain,
      confidence: 'confirmed',
      why: 'Company record matched the set query',
      evidence,
      exclude: hasExcludedText(text, profile),
      exclusionReason: 'Matched explicit exclusion terms',
    }, profile);
    stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
  }
  return stat;
}

async function scanDeals(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'deals', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['d.org_id = ?', 'd.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeTermClauses(where, binds, ['d.title', 'd.stage', 'd.notes', 'co.name', 'co.description', 'co.sector'], [...profile.includeTerms, ...profile.domains]);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT d.id, d.title, d.stage, d.notes, d.company_id, co.name AS company_name,
            co.domain AS company_domain, co.company_type, co.sector, co.investment_status
       FROM deals d
       LEFT JOIN companies co ON co.id = d.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.updated_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  for (const row of rows.results) {
    const text = [row.title, row.stage, row.notes, row.company_name, row.company_domain, row.company_type, row.sector, row.investment_status].join(' ');
    if (!textMatchesProfile(text, profile)) continue;
    stat.rows_returned += 1;
    const evidence: MaxSetEvidence = {
      source_family: 'deals',
      source_table: 'deals',
      source_id: row.id,
      evidence_type: 'deal_record',
      title: row.title,
      detail: `Deal record: ${[row.stage, row.company_name].filter(Boolean).join(', ')}`,
      strength: 'confirmed',
      satisfies_membership: true,
    };
    const before = candidates.size + excluded.size;
    if (profile.entityKind === 'deal') {
      addCandidate(candidates, excluded, {
        entityKind: 'deal',
        id: row.id,
        name: row.title,
        company: row.company_name,
        confidence: 'confirmed',
        why: 'Deal matched the set query',
        evidence,
        exclude: hasExcludedText(text, profile),
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    } else {
      addCandidate(candidates, excluded, {
        entityKind: row.company_type === 'vc_firm' || profile.entityKind === 'firm' ? 'firm' : row.company_type === 'startup' ? 'startup' : 'company',
        id: row.company_id,
        name: row.company_name || row.title,
        domain: row.company_domain,
        confidence: 'confirmed',
        why: 'Linked company appeared in a matching deal',
        evidence,
        exclude: hasExcludedText(text, profile) || (profile.taskType === 'funding_interest_gap' && row.stage === 'closed_won'),
        exclusionReason: row.stage === 'closed_won' ? 'Deal is already closed won' : 'Matched explicit exclusion terms',
      }, profile);
    }
    stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
  }
  return stat;
}

async function scanDocuments(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'documents', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = [
    'd.org_id = ?',
    'd.deleted_at IS NULL',
    "d.processing_status != 'excluded'",
    "COALESCE(d.source, '') != 'marty_generated'",
    "COALESCE(json_extract(d.custom_fields, '$.marty_generated'), 0) != 1",
    "COALESCE(json_extract(d.custom_fields, '$.marty_lab_generated'), 0) != 1",
    "COALESCE(json_extract(d.custom_fields, '$.max_mode_set_builder'), 0) != 1",
  ];
  const binds: unknown[] = [ctx.orgId];
  const documentMatchWhere: string[] = [];
  const documentMatchBinds: unknown[] = [];
  addLikeTermClauses(documentMatchWhere, documentMatchBinds, ['d.title', 'd.file_name', 'd.document_type', 'd.extracted_text_preview'], [...profile.includeTerms, ...profile.domains]);
  if (profile.taskType === 'invite_roster') {
    where.push(`(${documentMatchWhere.join(' AND ') || '0'} OR LOWER(COALESCE(d.document_type, '')) IN ('contact_data','spreadsheet') OR LOWER(COALESCE(d.file_name, '')) LIKE '%attendee%' OR LOWER(COALESCE(d.file_name, '')) LIKE '%invite%' OR LOWER(COALESCE(d.file_name, '')) LIKE '%registrant%' OR LOWER(COALESCE(d.title, '')) LIKE '%attendee%' OR LOWER(COALESCE(d.title, '')) LIKE '%invite%' OR LOWER(COALESCE(d.title, '')) LIKE '%registrant%')`);
    binds.push(...documentMatchBinds);
  } else {
    where.push(...documentMatchWhere);
    binds.push(...documentMatchBinds);
  }
  addDateRange(where, binds, 'd.created_at', profile);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT d.id, d.title, d.file_name, d.mime_type, d.r2_key, d.document_type, d.extracted_text_preview, d.created_at,
            d.contact_id, d.company_id, d.deal_id, d.visibility, d.participant_user_ids, d.uploaded_by,
            c.full_name AS contact_name, c.email AS contact_email,
            co.name AS company_name, co.domain AS company_domain,
            dl.title AS deal_title
       FROM documents d
       LEFT JOIN contacts c ON c.id = d.contact_id
       LEFT JOIN companies co ON co.id = d.company_id
       LEFT JOIN deals dl ON dl.id = d.deal_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  const sharingSet = new Set(Object.keys(await getSharingFlags(ctx.orgId, env)));
  let documentsExtracted = 0;
  for (const row of rows.results) {
    if (!isDocumentAccessibleToUser(row, ctx.userId, ctx.userRole, sharingSet)) continue;
    const text = [row.title, row.file_name, row.document_type, row.extracted_text_preview, row.contact_name, row.company_name, row.deal_title].join(' ');
    const looksTabular = profile.entityKind === 'person' || profile.entityKind === 'mixed' || profile.taskType === 'invite_roster';
    const docKind = `${row.document_type || ''} ${row.mime_type || ''} ${row.file_name || ''} ${row.title || ''}`.toLowerCase();
    const tabularDoc = docKind.includes('spreadsheet') || docKind.includes('excel') || docKind.includes('csv') ||
      docKind.includes('contact_data') || docKind.includes('attendee') || docKind.includes('invite') ||
      docKind.includes('registrant') || docKind.includes('xlsx');
    let fullText = '';
    let matchesDocument = textMatchesProfile(text, profile);
    if (!matchesDocument && looksTabular && tabularDoc && documentsExtracted < DOCUMENT_TEXT_EXTRACT_LIMIT) {
      fullText = await extractDocumentText(row, env);
      documentsExtracted += fullText ? 1 : 0;
      matchesDocument = textMatchesProfile(fullText, profile) ||
        (profile.taskType === 'invite_roster' && /\b(attendee|invite|registrant|mail merge|webinar|town hall)\b/.test(docKind));
    }
    if (!matchesDocument) continue;
    stat.rows_returned += 1;
    const evidence: MaxSetEvidence = {
      source_family: 'documents',
      source_table: 'documents',
      source_id: row.id,
      evidence_type: 'text_mention',
      title: row.title || row.file_name,
      date: row.created_at,
      detail: `Document match (${row.document_type || 'document'})`,
      strength: row.company_id || row.contact_id || row.deal_id ? 'probable' : 'needs_review',
      satisfies_membership: profile.taskType === 'document_list_reconstruction',
    };
    const before = candidates.size + excluded.size;
    if ((profile.entityKind === 'person' || profile.entityKind === 'mixed') && row.contact_id) {
      addCandidate(candidates, excluded, {
        entityKind: 'person',
        id: row.contact_id,
        name: row.contact_name,
        email: row.contact_email,
        confidence: 'probable',
        why: 'Linked contact on a matching document',
        evidence,
        exclude: hasExcludedText(text, profile),
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    } else if (row.company_id || row.company_name) {
      addCandidate(candidates, excluded, {
        entityKind: profile.entityKind === 'firm' ? 'firm' : profile.entityKind === 'startup' ? 'startup' : 'company',
        id: row.company_id,
        name: row.company_name || row.title,
        domain: row.company_domain,
        confidence: row.company_id ? 'probable' : 'needs_review',
        why: 'Linked company or company evidence on a matching document',
        evidence,
        exclude: hasExcludedText(text, profile),
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    } else {
      addCandidate(candidates, excluded, {
        entityKind: 'mixed',
        id: row.id,
        name: row.title || row.file_name,
        confidence: 'needs_review',
        why: 'Matching document requires entity review',
        evidence,
        exclude: hasExcludedText(text, profile),
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    }
    stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);

    if (looksTabular && tabularDoc) {
      if (!fullText && documentsExtracted < DOCUMENT_TEXT_EXTRACT_LIMIT) {
        fullText = await extractDocumentText(row, env);
        documentsExtracted += fullText ? 1 : 0;
      }
      const extractedRows = extractPersonRowsFromTabularText(fullText).slice(0, MAX_MODE_LIMITS.setBuilderCandidateCap);
      for (const person of extractedRows) {
        if (isInternalEmail(person.email)) continue;
        addCandidate(candidates, excluded, {
          entityKind: 'person',
          name: person.name,
          email: person.email,
          company: person.company,
          confidence: person.confidence,
          why: 'Extracted from a matching tabular document/spreadsheet row',
          evidence: {
            source_family: 'documents',
            source_table: 'documents',
            source_id: row.id,
            evidence_type: 'document_row',
            title: row.title || row.file_name,
            date: row.created_at,
            detail: person.detail,
            strength: person.confidence,
            satisfies_membership: true,
          },
          exclude: hasExcludedText([text, person.name, person.email, person.company].join(' '), profile),
          exclusionReason: 'Matched explicit exclusion terms',
        }, profile);
      }
    }
  }
  stat.documents_extracted = documentsExtracted;

  const ragQuery = profile.includeTerms.length > 0 ? profile.includeTerms.join(' ') : profile.query;
  const ragCandidates = await searchRagChunksD1Fts(env, ragQuery, {
    orgId: ctx.orgId,
    topK: 200,
    sourceTable: 'documents',
  }).catch(error => {
    stat.errors.push(`rag_chunks_v2_fts: ${String(error?.message || error).slice(0, 220)}`);
    return [];
  });
  if (ragCandidates.length > 0 && profile.taskType !== 'invite_roster') {
    stat.cap_hit = stat.cap_hit || ragCandidates.length >= 200;
    const ids = ragCandidates.map(c => c.chunkId).slice(0, 200);
    const chunkRows = await queryRowsInBatches<any>(
      env,
      ids,
      ph => `SELECT rc.id AS chunk_id, rc.source_id, rc.title AS chunk_title, rc.text_preview,
              d.id, d.title, d.file_name, d.document_type, d.created_at,
              d.contact_id, d.company_id, d.deal_id, d.visibility, d.participant_user_ids, d.uploaded_by,
              c.full_name AS contact_name, c.email AS contact_email,
              co.name AS company_name, co.domain AS company_domain,
              dl.title AS deal_title
         FROM rag_chunks_v2 rc
         JOIN documents d ON d.id = rc.source_id AND d.org_id = rc.org_id
         LEFT JOIN contacts c ON c.id = d.contact_id
         LEFT JOIN companies co ON co.id = d.company_id
         LEFT JOIN deals dl ON dl.id = d.deal_id
        WHERE rc.org_id = ?
          AND rc.id IN (${ph})
          AND d.deleted_at IS NULL
          AND d.processing_status != 'excluded'
          AND COALESCE(d.source, '') != 'marty_generated'
          AND COALESCE(json_extract(d.custom_fields, '$.marty_generated'), 0) != 1
          AND COALESCE(json_extract(d.custom_fields, '$.marty_lab_generated'), 0) != 1
          AND COALESCE(json_extract(d.custom_fields, '$.max_mode_set_builder'), 0) != 1`,
      [ctx.orgId]
    );
    stat.rows_scanned += chunkRows.length;
    for (const row of chunkRows) {
      if (!isDocumentAccessibleToUser(row, ctx.userId, ctx.userRole, sharingSet)) continue;
      const text = [row.title, row.file_name, row.document_type, row.chunk_title, row.text_preview, row.contact_name, row.company_name, row.deal_title].join(' ');
      if (!textMatchesProfile(text, profile)) continue;
      stat.rows_returned += 1;
      const evidence: MaxSetEvidence = {
        source_family: 'documents',
        source_table: 'rag_chunks_v2',
        source_id: row.chunk_id,
        evidence_type: 'text_mention',
        title: row.title || row.file_name || row.chunk_title,
        date: row.created_at,
        detail: `Document content match: ${cleanText(row.text_preview).slice(0, 220)}`,
        strength: row.company_id || row.contact_id || row.deal_id ? 'probable' : 'needs_review',
        satisfies_membership: false,
      };
      const before = candidates.size + excluded.size;
      if ((profile.entityKind === 'person' || profile.entityKind === 'mixed') && row.contact_id) {
        addCandidate(candidates, excluded, {
          entityKind: 'person',
          id: row.contact_id,
          name: row.contact_name,
          email: row.contact_email,
          confidence: 'probable',
          why: 'Linked contact on matching document content',
          evidence,
          exclude: hasExcludedText(text, profile),
          exclusionReason: 'Matched explicit exclusion terms',
        }, profile);
      } else if (row.company_id || row.company_name) {
        addCandidate(candidates, excluded, {
          entityKind: profile.entityKind === 'firm' ? 'firm' : profile.entityKind === 'startup' ? 'startup' : 'company',
          id: row.company_id,
          name: row.company_name || row.title,
          domain: row.company_domain,
          confidence: row.company_id ? 'probable' : 'needs_review',
          why: 'Linked company on matching document content',
          evidence,
          exclude: hasExcludedText(text, profile),
          exclusionReason: 'Matched explicit exclusion terms',
        }, profile);
      } else {
        addCandidate(candidates, excluded, {
          entityKind: 'mixed',
          id: row.id,
          name: row.title || row.file_name,
          confidence: 'needs_review',
          why: 'Matching document content requires entity review',
          evidence,
          exclude: hasExcludedText(text, profile),
          exclusionReason: 'Matched explicit exclusion terms',
        }, profile);
      }
      if (profile.entityKind === 'person' || profile.entityKind === 'mixed') {
        for (const person of extractPersonRowsFromTabularText(row.text_preview || '')) {
          if (isInternalEmail(person.email)) continue;
          addCandidate(candidates, excluded, {
            entityKind: 'person',
            name: person.name,
            email: person.email,
            company: person.company,
            confidence: person.confidence === 'confirmed' ? 'probable' : person.confidence,
            why: 'Extracted from matching document content',
            evidence,
            exclude: hasExcludedText([text, person.name, person.email, person.company].join(' '), profile),
            exclusionReason: 'Matched explicit exclusion terms',
          }, profile);
        }
      }
      stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
    }
  }
  return stat;
}

async function scanTasks(
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const stat: SourceStat = { source_family: 'tasks', rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: [] };
  const where = ['t.org_id = ?', 't.deleted_at IS NULL'];
  const binds: unknown[] = [ctx.orgId];
  addLikeTermClauses(where, binds, ['t.title', 't.description', 't.status', 't.priority', 'c.full_name', 'co.name', 'd.title'], [
    ...profile.includeTerms,
    ...(profile.taskType === 'open_loops' ? ['pending', 'follow up', 'send', 'introduce', 'schedule'] : []),
  ]);
  addDateRange(where, binds, 't.created_at', profile);
  const limit = MAX_MODE_LIMITS.setBuilderRowCap;
  const rows = await env.D1.prepare(
    `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.created_at,
            t.contact_id, t.company_id, t.deal_id, c.full_name AS contact_name, c.email AS contact_email,
            co.name AS company_name, co.domain AS company_domain, d.title AS deal_title
       FROM tasks t
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN companies co ON co.id = t.company_id
       LEFT JOIN deals d ON d.id = t.deal_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all<any>();
  stat.rows_scanned = rows.results.length;
  stat.cap_hit = rows.results.length >= limit;
  for (const row of rows.results) {
    const text = [row.title, row.description, row.status, row.priority, row.contact_name, row.company_name, row.deal_title].join(' ');
    if (!textMatchesProfile(text, profile) && profile.taskType !== 'open_loops') continue;
    stat.rows_returned += 1;
    const evidence: MaxSetEvidence = {
      source_family: 'tasks',
      source_table: 'tasks',
      source_id: row.id,
      evidence_type: 'task_action_item',
      title: row.title,
      date: row.created_at,
      detail: `Task ${row.status || ''}${row.due_date ? ` due ${row.due_date}` : ''}`,
      strength: row.status === 'pending' || row.status === 'in_progress' ? 'confirmed' : 'probable',
      satisfies_membership: profile.taskType === 'open_loops' || profile.entityKind === 'touchpoint',
    };
    const before = candidates.size + excluded.size;
    if (profile.taskType === 'open_loops' || profile.entityKind === 'touchpoint') {
      addCandidate(candidates, excluded, {
        entityKind: 'touchpoint',
        id: row.id,
        name: row.title,
        company: row.company_name,
        confidence: row.status === 'pending' || row.status === 'in_progress' ? 'confirmed' : 'probable',
        why: 'Open-loop/task candidate matched the query',
        evidence,
        exclude: row.status === 'completed' || row.status === 'cancelled' || hasExcludedText(text, profile),
        exclusionReason: row.status === 'completed' || row.status === 'cancelled' ? `Task status is ${row.status}` : 'Matched explicit exclusion terms',
      }, profile);
    } else if (profile.entityKind === 'person' && row.contact_id) {
      addCandidate(candidates, excluded, {
        entityKind: 'person',
        id: row.contact_id,
        name: row.contact_name,
        email: row.contact_email,
        confidence: 'probable',
        why: 'Linked contact on a matching task',
        evidence,
        exclude: hasExcludedText(text, profile),
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    } else if (row.company_id || row.company_name) {
      addCandidate(candidates, excluded, {
        entityKind: profile.entityKind === 'firm' ? 'firm' : profile.entityKind === 'startup' ? 'startup' : 'company',
        id: row.company_id,
        name: row.company_name,
        domain: row.company_domain,
        confidence: 'probable',
        why: 'Linked company on a matching task',
        evidence,
        exclude: hasExcludedText(text, profile),
        exclusionReason: 'Matched explicit exclusion terms',
      }, profile);
    }
    stat.candidates_added += Math.max(0, candidates.size + excluded.size - before);
  }
  return stat;
}

function sortCandidates(candidates: MaxSetCandidate[]): MaxSetCandidate[] {
  return candidates.sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (byConfidence !== 0) return byConfidence;
    if (b.source_count !== a.source_count) return b.source_count - a.source_count;
    return a.canonical_name.localeCompare(b.canonical_name);
  });
}

function partitionCandidates(candidates: MaxSetCandidate[]): Record<MaxSetConfidence, MaxSetCandidate[]> {
  return {
    confirmed: sortCandidates(candidates.filter(c => c.confidence === 'confirmed')),
    probable: sortCandidates(candidates.filter(c => c.confidence === 'probable')),
    needs_review: sortCandidates(candidates.filter(c => c.confidence === 'needs_review')),
  };
}

export function evaluateMaxSetQuality(
  plan: MaxSetJobPlan,
  stats: SourceStat[],
  buckets: Record<MaxSetConfidence, MaxSetCandidate[]>,
  excluded: MaxSetCandidate[]
): MaxSetQualityGateResult {
  const reasons: string[] = [];
  const all = [...buckets.confirmed, ...buckets.probable, ...buckets.needs_review];
  const authoritative = new Set(plan.source_policy.authoritative);
  const attemptedAuthoritative = stats.filter(s => authoritative.has(s.source_family));
  const authoritativeErrors = attemptedAuthoritative.filter(s => s.errors.length > 0);
  const capHits = stats.filter(s => s.cap_hit);
  const authoritativeCandidateCount = all.filter(c => c.evidence.some(e => authoritative.has(e.source_family) && e.satisfies_membership)).length;
  const membershipSatisfiedCount = all.filter(c => c.membership_predicate_satisfied).length;
  const needsReviewRatio = all.length > 0 ? buckets.needs_review.length / all.length : 0;

  if (plan.quality_policy.block_on_authoritative_errors && authoritativeErrors.length > 0) {
    reasons.push(`Authoritative source errors: ${authoritativeErrors.map(s => `${s.source_family}: ${s.errors.join('; ')}`).join(' | ')}`);
  }

  if (plan.quality_policy.block_on_caps && capHits.length > 0) {
    reasons.push(`Caps hit before exhaustive coverage: ${capHits.map(s => s.source_family).join(', ')}`);
  }

  if (plan.quality_policy.require_authoritative_candidates && authoritativeCandidateCount === 0) {
    reasons.push('No authoritative source produced candidates satisfying the membership predicate.');
  }

  for (const group of plan.source_policy.required_success_any_of) {
    const groupSucceeded = group.some(family => {
      const stat = stats.find(s => s.source_family === family);
      return stat && stat.errors.length === 0 && stat.candidates_added > 0;
    });
    if (!groupSucceeded) reasons.push(`Required source group did not produce a clean candidate set: ${group.join(' or ')}`);
  }

  if (plan.task_type === 'invite_roster') {
    const contaminating = all.filter(c => c.evidence.some(e =>
      (e.source_family === 'events' || e.source_family === 'contacts') && !e.satisfies_membership
    ));
    if (contaminating.length > 0) reasons.push(`Invite roster contains ${contaminating.length} candidates from non-authoritative event/contact evidence.`);
    if (all.length > 1000) reasons.push(`Invite roster candidate count (${all.length}) is implausibly broad for a targeted mail-merge request.`);
  }

  if (all.length > 0 && membershipSatisfiedCount / all.length < 0.5) {
    reasons.push('Most candidates do not satisfy the explicit membership predicate.');
  }

  if (all.length > 0 && needsReviewRatio > 0.6) {
    reasons.push('Most candidates are weak or unresolved matches.');
  }

  const hasGaps = reasons.length > 0 || excluded.length > 0 || buckets.probable.length > 0 || buckets.needs_review.length > 0;
  const status: MaxSetSafetyStatus = reasons.length > 0
    ? 'unsafe_incomplete'
    : hasGaps
      ? 'tiered_with_gaps'
      : 'complete';
  const artifactAllowed = status !== 'unsafe_incomplete';
  return {
    passed: status === 'complete',
    status,
    reasons,
    artifact_allowed: artifactAllowed,
    artifact_suppressed_reason: artifactAllowed ? undefined : reasons[0] || 'MAX quality gate suppressed artifact creation.',
  };
}

function buildArtifactContent(
  profile: SearchProfile,
  buckets: Record<MaxSetConfidence, MaxSetCandidate[]>,
  excluded: MaxSetCandidate[],
  coverageRows: any[][]
): any {
  const columns = profile.outputColumns;
  return {
    sheets: [
      { name: 'Confirmed', rows: bucketRows(buckets.confirmed, columns) },
      { name: 'Probable', rows: bucketRows(buckets.probable, columns) },
      { name: 'Needs Review', rows: bucketRows(buckets.needs_review, columns) },
      { name: 'Excluded', rows: bucketRows(excluded, [...columns, 'why_included']) },
      { name: 'Coverage & Gaps', rows: coverageRows },
    ],
  };
}

function titleForArtifact(profile: SearchProfile): string {
  const base = profile.taskType.replace(/_/g, ' ');
  const topic = profile.includeTerms.slice(0, 3).join(' ');
  return `MAX ${base}${topic ? ` - ${topic}` : ''}`.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 120);
}

async function persistTelemetry(
  env: Env,
  ctx: AuthContext,
  runId: string,
  profile: SearchProfile,
  plan: MaxSetJobPlan,
  stats: SourceStat[],
  buckets: Record<MaxSetConfidence, MaxSetCandidate[]>,
  excluded: MaxSetCandidate[],
  qualityGate: MaxSetQualityGateResult,
  artifactDocumentId: string | null,
  latencyMs: number
): Promise<void> {
  const capsHit = stats.filter(s => s.cap_hit).map(s => s.source_family);
  const candidateCount = buckets.confirmed.length + buckets.probable.length + buckets.needs_review.length;
  const authoritative = new Set(plan.source_policy.authoritative);
  const supporting = new Set(plan.source_policy.supporting);
  const enrichment = new Set(plan.source_policy.enrichment);
  const countByRole = (families: Set<MaxSetSourceFamily>) =>
    [...buckets.confirmed, ...buckets.probable, ...buckets.needs_review]
      .filter(candidate => candidate.evidence.some(e => families.has(e.source_family)))
      .length;
  try {
    await env.D1.prepare(
      `INSERT INTO max_mode_runs
         (id, org_id, user_id, query, task_type, entity_kind, source_families,
          confirmed_count, probable_count, needs_review_count, excluded_count,
          candidate_count, deduped_count, caps_hit, artifact_document_id, latency_ms,
          safety_status, quality_gate_passed, artifact_suppressed_reason, plan_json,
          anchor_count, authoritative_candidate_count, supporting_candidate_count, enrichment_candidate_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      runId,
      ctx.orgId,
      ctx.userId,
      profile.query,
      profile.taskType,
      profile.entityKind,
      JSON.stringify(profile.sourceFamilies),
      buckets.confirmed.length,
      buckets.probable.length,
      buckets.needs_review.length,
      excluded.length,
      candidateCount,
      candidateCount,
      JSON.stringify(capsHit),
      artifactDocumentId,
      latencyMs,
      qualityGate.status,
      qualityGate.passed ? 1 : 0,
      qualityGate.artifact_suppressed_reason || null,
      JSON.stringify(plan),
      plan.anchors.length,
      countByRole(authoritative),
      countByRole(supporting),
      countByRole(enrichment)
    ).run();
  } catch {
    await env.D1.prepare(
      `INSERT INTO max_mode_runs
         (id, org_id, user_id, query, task_type, entity_kind, source_families,
          confirmed_count, probable_count, needs_review_count, excluded_count,
          candidate_count, deduped_count, caps_hit, artifact_document_id, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      runId,
      ctx.orgId,
      ctx.userId,
      profile.query,
      profile.taskType,
      profile.entityKind,
      JSON.stringify(profile.sourceFamilies),
      buckets.confirmed.length,
      buckets.probable.length,
      buckets.needs_review.length,
      excluded.length,
      candidateCount,
      candidateCount,
      JSON.stringify(capsHit),
      artifactDocumentId,
      latencyMs
    ).run();
  }

  if (stats.length > 0) {
    await env.D1.batch(stats.map(stat =>
      env.D1.prepare(
        `INSERT INTO max_mode_run_sources
           (id, run_id, org_id, source_family, rows_scanned, rows_returned,
            candidates_added, body_fetches, documents_extracted, cap_hit, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        runId,
        ctx.orgId,
        stat.source_family,
        stat.rows_scanned,
        stat.rows_returned,
        stat.candidates_added,
        stat.body_fetches || 0,
        stat.documents_extracted || 0,
        stat.cap_hit ? 1 : 0,
        JSON.stringify(stat.errors)
      )
    ));
  }

  if (plan.anchors.length > 0) {
    try {
      await env.D1.batch(plan.anchors.map(anchor =>
        env.D1.prepare(
          `INSERT INTO max_mode_run_anchors
             (id, run_id, org_id, anchor_type, source_family, source_id, label, confidence, why)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          runId,
          ctx.orgId,
          anchor.type,
          anchor.source_family,
          anchor.id || null,
          anchor.label,
          anchor.confidence,
          anchor.why
        )
      ));
    } catch {
      // Older deployments may not have the anchor table yet; the main run
      // telemetry above is still enough to debug safely.
    }
  }
}

async function runAdapter(
  family: MaxSetSourceFamily,
  ctx: AuthContext,
  env: Env,
  profile: SearchProfile,
  candidates: Map<string, MaxSetCandidate>,
  excluded: Map<string, MaxSetCandidate>
): Promise<SourceStat> {
  const role = sourceRole(profile.plan, family);
  if (role === 'disallowed' || role === 'enrichment' && profile.taskType === 'invite_roster') {
    return {
      source_family: family,
      role,
      rows_scanned: 0,
      rows_returned: 0,
      candidates_added: 0,
      cap_hit: false,
      errors: [`${family} is ${role} for ${profile.taskType}; it cannot generate candidates for this MAX job.`],
    };
  }
  try {
    let stat: SourceStat;
    if (family === 'communications') stat = await scanCommunications(ctx, env, profile, candidates, excluded);
    else if (family === 'events') stat = await scanEvents(ctx, env, profile, candidates, excluded);
    else if (family === 'campaigns') stat = await scanCampaigns(ctx, env, profile, candidates, excluded);
    else if (family === 'contacts') stat = await scanContacts(ctx, env, profile, candidates, excluded);
    else if (family === 'companies') stat = await scanCompanies(ctx, env, profile, candidates, excluded);
    else if (family === 'deals') stat = await scanDeals(ctx, env, profile, candidates, excluded);
    else if (family === 'documents') stat = await scanDocuments(ctx, env, profile, candidates, excluded);
    else if (family === 'tasks') stat = await scanTasks(ctx, env, profile, candidates, excluded);
    else stat = { source_family: family, rows_scanned: 0, rows_returned: 0, candidates_added: 0, cap_hit: false, errors: ['unknown source family'] };
    stat.role = role;
    return stat;
  } catch (error: any) {
    return {
      source_family: family,
      role,
      rows_scanned: 0,
      rows_returned: 0,
      candidates_added: 0,
      cap_hit: false,
      errors: [String(error?.message || error).slice(0, 500)],
    };
  }
}

export function detectMaxSetIntent(
  query: string,
  opts: { currentUserEmail?: string | null } = {}
): { shouldBuild: boolean; reason: string | null; input: BuildMaxSetInput | null } {
  const cleanQuery = cleanText(query);
  const lower = cleanQuery.toLowerCase();
  const exhaustive =
    /\b(all|every|everyone|everybody|list|roster|export|xlsx|excel|spreadsheet|file|mail merge|count|how many|touchpoints?|ever talked|ever showed|ever involved|all firms|all startups|all people)\b/.test(lower);
  const setNoun =
    /\b(invite|invited|attendee|attendees|registrant|webinar|town hall|names?|emails?|people|contacts?|companies|startups?|firms?|vc|touchpoints?|interested|funding|invested|open loops?|account map|campaign|deal history|who touched|source spreadsheet|source workbook)\b/.test(lower);
  const shouldBuild = exhaustive && setNoun;
  if (!shouldBuild) return { shouldBuild: false, reason: null, input: null };

  const taskType = inferTaskType(cleanQuery);
  const entityKind = inferEntityKind(cleanQuery, taskType);
  const wantsFile = wantsArtifact(cleanQuery, undefined, undefined) || /\b(names?.*emails?|emails?.*names?|mail merge)\b/.test(lower);
  const aliases: string[] = [];
  const namedPeople: string[] = [];
  const domains: string[] = [];
  if (opts.currentUserEmail && /\b(myself|me|i invited|i sent|from me|my invites?)\b/.test(lower)) {
    namedPeople.push(opts.currentUserEmail);
  }
  if (/\braul\b/.test(lower)) {
    if (taskType !== 'invite_roster') aliases.push('Raul', 'Henriquez', 'Raul Henriquez', 'raul@medinavc.com');
    namedPeople.push('Raul Henriquez', 'raul@medinavc.com');
  }
  return {
    shouldBuild,
    reason: 'MAX exhaustive set query detected',
    input: {
      query: cleanQuery,
      task_type: taskType,
      entity_kind: entityKind,
      aliases,
      named_people: namedPeople,
      domains: domains.filter(Boolean),
      artifact_kind: wantsFile ? 'xlsx' : undefined,
      create_artifact: wantsFile ? true : undefined,
    },
  };
}

function compactCandidateForContext(candidate: MaxSetCandidate): Record<string, unknown> {
  return {
    name: candidate.canonical_name,
    email: candidate.email || undefined,
    company: candidate.company || undefined,
    domain: candidate.domain || undefined,
    confidence: candidate.confidence,
    source_count: candidate.source_count,
    evidence: evidenceSummary(candidate),
  };
}

export function compactMaxSetResultForContext(result: any): Record<string, unknown> {
  const confirmed = Array.isArray(result?.confirmed) ? result.confirmed : [];
  const probable = Array.isArray(result?.probable) ? result.probable : [];
  const needsReview = Array.isArray(result?.needs_review) ? result.needs_review : [];
  const excluded = Array.isArray(result?.excluded) ? result.excluded : [];
  return {
    run_id: result?.run_id,
    task_type: result?.task_type,
    entity_kind: result?.entity_kind,
    safety_status: result?.safety_status,
    quality_gate: result?.quality_gate,
    plan: result?.plan ? {
      membership_predicate: result.plan.membership_predicate,
      anchors: result.plan.anchors,
      source_policy: result.plan.source_policy,
      target_scope: result.plan.target_scope,
    } : undefined,
    counts: {
      confirmed: confirmed.length,
      probable: probable.length,
      needs_review: needsReview.length,
      excluded: excluded.length,
      total_candidates: result?.coverage?.total_candidates,
    },
    coverage: {
      source_families: result?.coverage?.source_families,
      stats: result?.coverage?.stats,
      caps_hit: result?.coverage?.caps_hit,
      include_terms: result?.coverage?.include_terms,
      domains: result?.coverage?.domains,
    },
    artifact_card: result?.artifact_card || null,
    gaps: result?.gaps || [],
    samples: {
      confirmed: confirmed.slice(0, 30).map(compactCandidateForContext),
      probable: probable.slice(0, 20).map(compactCandidateForContext),
      needs_review: needsReview.slice(0, 20).map(compactCandidateForContext),
      excluded: excluded.slice(0, 15).map(compactCandidateForContext),
    },
    instruction: result?.safety_status === 'unsafe_incomplete'
      ? 'The deterministic MAX set-builder marked this run unsafe/incomplete. Do not claim the set is complete and do not create a duplicate workbook from recall snippets; explain the quality gate reasons and real gaps.'
      : 'Use this deterministic MAX set-builder result as the source of truth. If an artifact_card exists, do not create a duplicate roster workbook from recall snippets.',
  };
}

export async function buildMaxSetTool(
  ctx: AuthContext,
  input: BuildMaxSetInput,
  env: Env,
  opts: { deepDive?: boolean } = {}
): Promise<any> {
  if (!opts.deepDive) {
    return {
      error: 'build_max_set is only available in MAX mode',
      message: 'Use MAX mode for exhaustive all/every/list/export/count set-building tasks.',
    };
  }
  const profile = buildProfile(input);
  const plan = planMaxSetJob(input, profile);
  profile.plan = plan;
  if (!profile.query && profile.includeTerms.length === 0 && profile.domains.length === 0) {
    return { error: 'query is required' };
  }

  const t0 = Date.now();
  const runId = crypto.randomUUID();
  const candidates = new Map<string, MaxSetCandidate>();
  const excludedMap = new Map<string, MaxSetCandidate>();
  const stats: SourceStat[] = [];
  await discoverAnchors(ctx, env, profile, plan);

  for (const family of profile.sourceFamilies) {
    if (candidates.size >= MAX_MODE_LIMITS.setBuilderCandidateCap) {
      stats.push({
        source_family: family,
        role: sourceRole(plan, family),
        rows_scanned: 0,
        rows_returned: 0,
        candidates_added: 0,
        cap_hit: true,
        errors: ['candidate cap reached before adapter ran'],
      });
      continue;
    }
    stats.push(await runAdapter(family, ctx, env, profile, candidates, excludedMap));
  }

  const allCandidates = sortCandidates([...candidates.values()]).slice(0, MAX_MODE_LIMITS.setBuilderCandidateCap);
  const buckets = partitionCandidates(allCandidates);
  const excluded = sortCandidates([...excludedMap.values()]).slice(0, MAX_MODE_LIMITS.setBuilderCandidateCap);
  const qualityGate = evaluateMaxSetQuality(plan, stats, buckets, excluded);
  const capFamilies = stats.filter(s => s.cap_hit).map(s => s.source_family);
  const gaps = [
    ...qualityGate.reasons,
    ...capFamilies.map(f => `${f} hit the MAX row cap; rerun with narrower filters or pagination for full certainty.`),
    ...stats.flatMap(s => s.errors.map(e => `${s.source_family}: ${e}`)),
  ];
  const coverageRows = [
    ['quality_status', qualityGate.status],
    ['quality_gate_passed', qualityGate.passed ? 'yes' : 'no'],
    ['artifact_allowed', qualityGate.artifact_allowed ? 'yes' : 'no'],
    ['artifact_suppressed_reason', qualityGate.artifact_suppressed_reason || ''],
    ['quality_reasons', qualityGate.reasons.join(' | ')],
    [],
    ['source_family', 'role', 'rows_scanned', 'rows_returned', 'candidates_added', 'body_fetches', 'documents_extracted', 'cap_hit', 'errors'],
    ...stats.map(s => [s.source_family, s.role || '', s.rows_scanned, s.rows_returned, s.candidates_added, s.body_fetches || 0, s.documents_extracted || 0, s.cap_hit ? 'yes' : 'no', s.errors.join('; ')]),
    [],
    ['run_id', runId],
    ['query', profile.query],
    ['task_type', profile.taskType],
    ['entity_kind', profile.entityKind],
    ['membership_predicate', plan.membership_predicate],
    ['anchors', plan.anchors.map(a => `${a.type}:${a.label}`).join(' | ')],
    ['include_terms', profile.includeTerms.join(', ')],
    ['domains', profile.domains.join(', ')],
  ];

  let artifactCard: MartyDocumentCard | null = null;
  let artifactDocumentId: string | null = null;
  const totalReturned = buckets.confirmed.length + buckets.probable.length + buckets.needs_review.length;
  const shouldCreateArtifact = profile.wantsArtifact || totalReturned > 50;
  if (shouldCreateArtifact && qualityGate.artifact_allowed) {
    try {
      const artifact = await createDocumentArtifactTool(ctx, {
        kind: 'xlsx',
        title: titleForArtifact(profile),
        structured_content: buildArtifactContent(profile, buckets, excluded, coverageRows),
        embed: false,
        visibility: 'private',
        custom_fields: {
          max_mode_set_builder: true,
          max_mode_run_id: runId,
          task_type: profile.taskType,
          entity_kind: profile.entityKind,
        },
      }, env);
      artifactCard = artifact.document_cards?.[0] || null;
      artifactDocumentId = artifact.document?.id || artifactCard?.document_id || null;
    } catch (error: any) {
      gaps.push(`artifact creation failed: ${String(error?.message || error).slice(0, 220)}`);
    }
  }

  const latencyMs = Date.now() - t0;
  await persistTelemetry(env, ctx, runId, profile, plan, stats, buckets, excluded, qualityGate, artifactDocumentId, latencyMs)
    .catch(error => console.warn('[max-set-builder] telemetry failed:', error?.message || error));

  return {
    run_id: runId,
    task_type: profile.taskType,
    entity_kind: profile.entityKind,
    plan,
    safety_status: qualityGate.status,
    quality_gate: qualityGate,
    coverage: {
      source_families: profile.sourceFamilies,
      stats,
      include_terms: profile.includeTerms,
      aliases: profile.aliases,
      domains: profile.domains,
      caps_hit: capFamilies,
      total_candidates: totalReturned,
      excluded_count: excluded.length,
      latency_ms: latencyMs,
      authoritative_candidate_count: [...buckets.confirmed, ...buckets.probable, ...buckets.needs_review]
        .filter(c => c.evidence.some(e => plan.source_policy.authoritative.includes(e.source_family) && e.satisfies_membership)).length,
    },
    confirmed: buckets.confirmed,
    probable: buckets.probable,
    needs_review: buckets.needs_review,
    excluded,
    gaps,
    artifact_card: artifactCard,
    document_cards: artifactCard ? [artifactCard] : [],
    note: shouldCreateArtifact
      ? artifactCard
        ? 'Created an XLSX workbook with Confirmed, Probable, Needs Review, Excluded, and Coverage & Gaps tabs.'
        : qualityGate.artifact_allowed
          ? 'Attempted to create an XLSX workbook, but artifact creation failed; see gaps.'
          : `No XLSX workbook was created because MAX marked this run ${qualityGate.status}: ${qualityGate.artifact_suppressed_reason || 'quality gate failed.'}`
      : 'No artifact was created because the result set was small and no export/mail-merge intent was detected.',
  };
}

export const __maxSetTestHooks = {
  buildProfile,
  chunkArray,
  collectEmailEntries,
  defaultSourceFamilies,
  evaluateMaxSetQuality,
  expandAliases,
  extractPersonRowsFromTabularText,
  planMaxSetJob,
  sourcePolicyForTask,
};

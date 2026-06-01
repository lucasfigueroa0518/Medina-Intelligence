import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { callClaudeWithUsage, type ClaudeSystemPrompt } from './claude';
import { emailDomain, getConfiguredInternalDomains, isInternalEmailDomain } from './internal-domains';
import { CLAUDE_HAIKU_MODEL } from './model-policy';

export const PROSPECT_CLASSIFIER_VERSION = 'prospect-v1-llm-req-cl-veto-calibrated-2026-06-01';
const PROSPECT_CLASSIFIER_DEFAULT_MODEL = CLAUDE_HAIKU_MODEL;
const DEFAULT_PROSPECT_PRODUCTION_SAMPLE_RATE = 0.02;
export const PROSPECT_CONTEXT_WINDOW_CHARS = 4000;
const PROSPECT_SOURCE_TEXT_MAX_CHARS = 12000;

export const PROSPECT_SECTOR_TAXONOMY = [
  { key: 'ai_data', label: 'AI / Data' },
  { key: 'cybersecurity', label: 'Cybersecurity' },
  { key: 'quantum', label: 'Quantum' },
  { key: 'dev_cloud_infra', label: 'Developer / Cloud Infrastructure' },
  { key: 'enterprise_software', label: 'Enterprise Software' },
  { key: 'fintech', label: 'Fintech' },
  { key: 'healthcare', label: 'Healthcare' },
  { key: 'aerospace_defense', label: 'Aerospace / Defense' },
  { key: 'hardware_semis', label: 'Hardware / Semiconductors' },
  { key: 'robotics', label: 'Robotics' },
  { key: 'energy_climate', label: 'Energy / Climate' },
  { key: 'materials_manufacturing', label: 'Materials / Manufacturing' },
  { key: 'mobility_logistics', label: 'Mobility / Logistics' },
  { key: 'real_estate_built_env', label: 'Real Estate / Built Environment' },
  { key: 'consumer', label: 'Consumer' },
  { key: 'agri_food', label: 'Agriculture / Food' },
  { key: 'education', label: 'Education' },
  { key: 'uncategorized', label: 'Uncategorized' },
] as const;
const PROSPECT_SECTOR_KEYS = new Set(PROSPECT_SECTOR_TAXONOMY.map(s => s.key));
const PROSPECT_SECTOR_LABELS = PROSPECT_SECTOR_TAXONOMY.map(s => s.key).join(', ');

export const PROSPECT_MENTION_TYPES = [
  'inbound_prospect',
  'known_deal',
  'intro_source',
  'news',
  'noise',
  'web_analytics',
] as const;
const PROSPECT_MENTION_TYPE_SET = new Set<string>(PROSPECT_MENTION_TYPES);

export const PROSPECT_ACTIONS = [
  'create_prospect',
  'attach_existing_deal',
  'record_context',
  'ignore',
] as const;
const PROSPECT_ACTION_SET = new Set<string>(PROSPECT_ACTIONS);

export const PROSPECT_DIRECTIONS = ['inbound', 'outbound', 'internal', 'news'] as const;
const PROSPECT_DIRECTION_SET = new Set<string>(PROSPECT_DIRECTIONS);

type SourceType = 'conversation' | 'event' | 'document';
type Direction = typeof PROSPECT_DIRECTIONS[number];
type DeterministicDirection = Direction | 'unknown';
type MentionType = typeof PROSPECT_MENTION_TYPES[number];
type ProspectAction = typeof PROSPECT_ACTIONS[number];
type SectorKey = typeof PROSPECT_SECTOR_TAXONOMY[number]['key'];
type SignalKind = 'intro' | 'raise' | 'deck' | 'meeting' | 'list_entry' | 'cold_mention' | 'unknown';
type ConfidenceTier = 'high' | 'medium' | 'low';

export interface ProspectDetectionStats {
  items_scanned: number;
  mentions_seen: number;
  signals_recorded: number;
  prospects_upserted: number;
  classifications_pending: number;
  prefilter_dropped: number;
  production_samples_recorded: number;
  skipped_known_deal: number;
  skipped_intro_source: number;
  skipped_news: number;
  skipped_noise: number;
  skipped_web_analytics: number;
  errors: Array<{ item_id: string; error: string }>;
}

export interface MentionCandidate {
  raw: string;
  canonicalName: string;
  normalizedName: string;
  mentionOrdinal: number;
  spanStart: number | null;
  spanEnd: number | null;
  lineText: string;
  contextText: string;
  isListEntry: boolean;
  products: string[];
  listFields?: ParsedDealflowListFields;
}

interface ExistingContext {
  companyId: string | null;
  dealId: string | null;
  companyDomain: string | null;
  relationshipStates: string[];
  isInternal: boolean;
  matchStrength: 'none' | 'name' | 'domain' | 'company_id';
}

interface Classification {
  direction: Direction;
  directionUncertain: boolean;
  mentionType: MentionType;
  prospectAction: ProspectAction;
  shouldCreateProspect: boolean;
  prospectCompanyName: string | null;
  confidence: number;
  confidenceTier: ConfidenceTier;
  sectorKey: SectorKey;
  sectorConfidence: number;
  signalKind: SignalKind;
  hasDeck: boolean;
  hasMeeting: boolean;
  hasWarmIntro: boolean;
  dealmakerName: string | null;
  possibleCompanyId: string | null;
  possibleDealId: string | null;
  linkedDealId: string | null;
  provisional: boolean;
  sampledForProduction: boolean;
  samplingReason: string | null;
  metadata: Record<string, unknown>;
}

interface ClassifierPrefilter {
  shouldClassify: boolean;
  reasons: string[];
  deterministicDirection: DeterministicDirection;
  newsletterLikely: boolean;
  hasDeck: boolean;
  hasMeeting: boolean;
  hasWarmIntro: boolean;
  signalKind: SignalKind;
  sectorHint: { key: SectorKey; confidence: number };
  confidenceHint: { confidence: number; tier: ConfidenceTier; provisional: boolean };
}

interface LlmClassifierDecision {
  mentionType: MentionType;
  direction: Direction;
  sectorKey: SectorKey;
  sectorConfidence: number;
  confidence: number;
  prospectAction: ProspectAction;
  prospectCompanyName: string | null;
  reasoning: string | null;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface ProspectCreateVetoInput {
  prospectAction: string;
  companyName: string;
  rawMention?: string | null;
  rawExcerpt?: string | null;
  senderAndContext?: string | null;
  llmReasoning?: string | null;
}

interface ProspectCreateVetoDecision {
  applied: boolean;
  reason: string | null;
  confidence: number | null;
}

interface ProspectValuableActionVetoInput extends ProspectCreateVetoInput {
  prospectAction: string;
  prospectCompanyName?: string | null;
}

interface ProspectValuableActionVetoDecision extends ProspectCreateVetoDecision {
  nonValuableAction: 'ignore' | 'record_context' | null;
}

export interface ProspectClassifierKnownEntity {
  name: string;
  domain?: string | null;
}

export interface ProspectClassifierKnownContext {
  knownDeals: ProspectClassifierKnownEntity[];
  knownDealmakers: ProspectClassifierKnownEntity[];
}

export interface ProspectClassifierInput {
  sourceType: string;
  senderAndContext: string;
  companyName: string;
  rawExcerpt: string;
  prefilterHints: Record<string, unknown>;
  sectorHints: { key: SectorKey; confidence: number };
  knownContext: ProspectClassifierKnownContext;
  orgId: string;
  policyLens?: ProspectClassifierPolicyLens | null;
}

export interface ProspectClassifierPolicyLens {
  id: string;
  name: string;
  instructions: string;
}

export interface ParsedDealflowListFields {
  stage?: string | null;
  amount?: string | null;
  website?: string | null;
  poc?: string | null;
  problem?: string | null;
  approach?: string | null;
}

export interface ProspectOrgExtractionLlmInput {
  cleanedText: string;
  sourceContext: string;
  orgId: string;
}

export interface ProspectOrgExtractionLlmOutput {
  name: string;
  raw?: string | null;
  context?: string | null;
}

export type ProspectOrgExtractionLlm = (input: ProspectOrgExtractionLlmInput) => Promise<ProspectOrgExtractionLlmOutput[]>;

export interface ProspectOrganizationExtractionOptions {
  fallbackName?: string | null;
  knownContext?: ProspectClassifierKnownContext;
  allowLlm?: boolean;
  forceLlm?: boolean;
  maxLlmOrganizations?: number;
  llmExtractor?: ProspectOrgExtractionLlm;
}

export interface ProspectEnrichmentCandidate {
  prospectId: string;
  canonicalName: string;
  domain?: string | null;
  sourceKind: 'own_domain' | 'google_news' | 'duckduckgo';
  sourceUrl: string;
  fields: Partial<Record<'website' | 'domain' | 'description' | 'hq_location' | 'founders_json', string>>;
  corroboratingSourceCount?: number;
}

export interface EnsureProspectForDealResult {
  prospectId: string | null;
  action: 'created' | 'updated' | 'already_linked' | 'skipped_no_deal';
  dealId: string;
  companyId: string | null;
}

const PROSPECT_ENRICHMENT_FIELDS = new Set(['website', 'domain', 'description', 'hq_location', 'founders_json']);

type ProspectBackfillSourceFamily = 'conversation' | 'event' | 'document';

export interface ProspectBackfillWindowInput {
  windowStart: string;
  windowEnd: string;
  sourceFamilies?: ProspectBackfillSourceFamily[];
  batchLimit?: number;
  measuredCostPerItemUsd?: number | null;
  runId?: string | null;
}

export interface ProspectBackfillWindowResult {
  run_id: string;
  window_start: string;
  window_end: string;
  items_found: number;
  items_processed: number;
  signals_recorded: number;
  prospects_upserted: number;
  classifications_pending: number;
  source_families: string[];
  reconciliation: Awaited<ReturnType<typeof runProspectReconciliation>>;
}

function emptyStats(items: number): ProspectDetectionStats {
  return {
    items_scanned: items,
    mentions_seen: 0,
    signals_recorded: 0,
    prospects_upserted: 0,
    classifications_pending: 0,
    prefilter_dropped: 0,
    production_samples_recorded: 0,
    skipped_known_deal: 0,
    skipped_intro_source: 0,
    skipped_news: 0,
    skipped_noise: 0,
    skipped_web_analytics: 0,
    errors: [],
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PERSON_FIRST_NAMES = new Set([
  'adam', 'albert', 'alex', 'alicia', 'alvaro', 'andrew', 'anthony', 'apollo',
  'bea', 'ben', 'brad', 'brian', 'chris', 'christian', 'chuck', 'craig',
  'dan', 'daniel', 'david', 'dylan', 'eric', 'james', 'javier',
  'jennifer', 'john', 'josh', 'kevin', 'laura', 'leonardo', 'lloyd',
  'lucas', 'manny', 'maria', 'melissa', 'michael', 'mike', 'nick',
  'nicholas', 'noah', 'patrick', 'paul', 'peter', 'phil', 'philip',
  'raul', 'robert', 'sam', 'sarah', 'shirley', 'steve', 'tony', 'victor', 'wes',
  'william', 'yesha',
]);

const PERSON_CONTACT_SINGLE_NAMES = new Set([
  'khizroev',
]);

const KNOWN_CONNECTOR_COMPANY_NAMES = new Set([
  'boozallenhamilton',
  'johnsonandjohnson',
  'procterandgamble',
]);

const STANDALONE_DOCUMENT_HEADINGS = new Set([
  'companyoverview',
  'companyprofile',
  'executivesummary',
  'keytakeaways',
  'overview',
  'problem',
  'risks',
  'solution',
  'team',
  'traction',
  'market',
  'whattheydo',
  'whynow',
]);

const SAFE_DOCUMENT_HEADING_PREFIXES = [
  'company overview',
  'company profile',
  'executive summary',
  'initial analysis',
  'investment memo',
  'investment overview',
  'target company',
];

const GENERIC_FRAGMENT_NAMES = new Set([
  'aprilwe',
  'bea',
  'both',
  'ceothey',
  'goto',
  'non',
  'sub',
  'target',
  'two',
  'you',
]);

const MARKUP_ARTIFACT_NAMES = new Set([
  'bodycontainer',
  'columnper',
  'datasets',
  'html',
  'locale',
  'schema',
  'schemaorg',
  'stylesheet',
  'template',
  'xdp',
  'xfa',
  'xhtml',
  'xml',
]);

function hasCompanyToken(name: string): boolean {
  return /\b(?:ai|bank|capital|co|company|corp|corporation|foundation|fund|group|holdings|inc|industries|labs|llc|llp|ltd|management|partners|securities|software|systems|technologies|technology|university|ventures)\b/i.test(name);
}

function isKnownConnectorCompanyName(name: string): boolean {
  return KNOWN_CONNECTOR_COMPANY_NAMES.has(normalizeProspectName(name));
}

export function normalizeProspectName(value: string | null | undefined): string {
  let text = (value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co)\b\.?/g, ' ')
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  text = text.replace(/\b(ai|technologies|technology|labs|systems)\b$/g, '').trim();
  return text.replace(/\s+/g, '');
}

function isStandaloneDocumentHeading(name: string): boolean {
  return STANDALONE_DOCUMENT_HEADINGS.has(normalizeProspectName(name));
}

function isGenericFragmentCandidate(name: string): boolean {
  return GENERIC_FRAGMENT_NAMES.has(normalizeProspectName(name));
}

function isMarkupArtifactCandidate(name: string): boolean {
  if (hasCompanyToken(name) || isKnownConnectorCompanyName(name)) return false;
  const normalized = normalizeProspectName(name);
  if (MARKUP_ARTIFACT_NAMES.has(normalized)) return true;
  return /\b(?:schema\.org|xhtml|xfa|stylesheet|body-container|column-per|xmlns|doctype|css|html)\b/i.test(name);
}

function isPlausibleCompanyStemAfterFileStrip(stem: string): boolean {
  if (!stem || stem.length > 80) return false;
  if (!/[A-Za-z]/.test(stem)) return false;
  if (/[_/@\\]/.test(stem)) return false;
  const normalized = normalizeProspectName(stem);
  if (!normalized || normalized.length < 3) return false;
  if (isStandaloneDocumentHeading(stem) || isMarkupArtifactCandidate(stem) || isGenericFragmentCandidate(stem)) return false;
  if (/\b(?:q[1-4]|fy\d{2,4}|20\d{2}|v\d+)\b/i.test(stem) && /\b(?:analysis|deck|memo|report|update)\b/i.test(stem)) return false;
  return true;
}

function stripTrailingAttachmentExtension(name: string): string {
  const match = name.match(/^(.*?)(?:\s*\.\s*(?:zip|pdf|pptx?|docx?|xlsx?|csv))$/i);
  if (!match?.[1]) return name;
  const stem = normalizeWhitespace(match[1]).replace(/[._-]+$/g, '').trim();
  return isPlausibleCompanyStemAfterFileStrip(stem) ? stem : name;
}

function isPlausibleCompanyRemainder(name: string): boolean {
  const clean = normalizeWhitespace(name);
  if (!clean || clean.length > 100) return false;
  if (!/[A-Za-z]/.test(clean)) return false;
  if (isStandaloneDocumentHeading(clean) || isMarkupArtifactCandidate(clean) || isGenericFragmentCandidate(clean)) return false;
  if (looksLikePersonName(clean) || looksLikePersonOrParticipantBundle(clean)) return false;
  if (hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return true;
  return /^[A-Z0-9][A-Za-z0-9&.'’/-]*(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]*){0,5}$/.test(clean);
}

function stripLeadingDocumentHeadingPrefix(name: string): string {
  const clean = normalizeWhitespace(name);
  for (const prefix of SAFE_DOCUMENT_HEADING_PREFIXES) {
    const match = clean.match(new RegExp(`^${escapeRegExp(prefix)}\\s*(?:[:\\-|–—])?\\s+(.+)$`, 'i'));
    const remainder = normalizeWhitespace(match?.[1] || '');
    if (remainder && isPlausibleCompanyRemainder(remainder)) return remainder;
  }
  return clean;
}

function canonicalizeMention(raw: string): { canonicalName: string; products: string[] } {
  let cleaned = normalizeWhitespace(raw)
    .replace(/^\s*(?:[-*•]\s*|\d+[.)]\s*)/, '')
    .replace(/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!.\s]*$/i, '')
    .replace(/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!\s]+/i, '')
    .replace(/^(?:about|regarding|subject|re|fw|fwd)\s*[:\-]?\s+/i, '')
    .replace(/\b([A-Z][A-Za-z0-9&.'’-]{2,})\s+\1\b/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[,:;]+$/g, '')
    .replace(/\s+\b(?:for|to|from|with|and|the|at)\b$/i, '')
    .trim();
  cleaned = stripTrailingAttachmentExtension(cleaned);
  cleaned = stripLeadingDocumentHeadingPrefix(cleaned);
  cleaned = collapseRepeatedAdjacentName(cleaned);
  if (looksLikePersonOrParticipantBundle(cleaned)) {
    return { canonicalName: cleaned, products: [] };
  }
  const parts = cleaned.split(/\s+\/\s+/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    return { canonicalName: parts[0], products: parts.slice(1) };
  }
  return { canonicalName: cleaned, products: [] };
}

function collapseRepeatedAdjacentName(name: string): string {
  const tokens = normalizeWhitespace(name).split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length % 2 !== 0) return name;
  const mid = tokens.length / 2;
  const left = normalizeProspectName(tokens.slice(0, mid).join(' '));
  const right = normalizeProspectName(tokens.slice(mid).join(' '));
  if (left && left === right) return tokens.slice(0, mid).join(' ');
  return name;
}

function isGenericCandidate(name: string): boolean {
  const clean = normalizeWhitespace(name);
  if (isStandaloneDocumentHeading(clean) || isMarkupArtifactCandidate(clean) || isGenericFragmentCandidate(clean)) return true;
  if (looksLikePersonOrParticipantBundle(clean)) return true;
  if (/^(?:i['’]?m|i\s+am|we|they|it|there|please|sorry|no worries|sounds great|great|thanks)\b/i.test(clean)) return true;
  if (/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!.\s]*$/i.test(clean)) return true;
  if (/^(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/i.test(clean)) return true;
  if (/^(?:quantum|cyber|ai|ml|data|security|healthcare|fintech|aerospace|defense)$/i.test(clean)) return true;
  if (/\b(?:employee search endpoint|search endpoint|prospector spreadsheets?|spreadsheet|spreadsheets|presentation|verification code|calendar artifact)\b/i.test(clean)) return true;
  if (/\b(?:google meet|meet\.google\.com|join by phone|meeting link|calendar invite)\b/i.test(clean)) return true;
  if (/^(?:join with|join by|joining info|meeting link|video call|conference call|docreq)\b/i.test(clean)) return true;
  if (/^(?:about|regarding|subject|re|fw|fwd)\s*[:\-]?\s*$/i.test(clean)) return true;
  const normalized = normalizeProspectName(name);
  if (!normalized || normalized.length < 3) return true;
  return new Set([
    'hi', 'hello', 'thanks', 'thankyou', 'best', 'regards', 'forwarded',
    'subject', 'from', 'to', 'cc', 'date', 'team', 'fund', 'company',
    'meeting', 'call', 'deck', 'memo', 'newsletter', 'update', 'funding', 'claude',
    'sent', 'fwd', 'fw', 're', 'on', 'thu', 'thursday', 'wednesday',
    'monday', 'tuesday', 'friday', 'saturday', 'sunday', 'jan', 'january',
    'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun',
    'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
    'oct', 'october', 'nov', 'november', 'dec', 'december', 'lucas',
    'tony', 'anthony', 'alicia', 'michael', 'mike', 'john', 'david',
    'andrew', 'alex', 'sam', 'chris', 'leonardo', 'craig', 'manny', 'raul',
    'chuck', 'dylan', 'javier', 'kevin', 'melissa', 'nick', 'nicholas', 'wes',
    'yesha', 'khizroev', 'medina',
    'medinaventures', 'medinavc', 'mediavc', 'claudeopus', 'googlemeet',
    'meetinglink', 'joinwithgooglemeet', 'joinby', 'docreq', 'hitony',
    'employeeendpoint', 'employeesearchendpoint', 'prospectorspreadsheets',
    'cyberpresentation', 'thursdayafter', 'hco',
    'japaneseendowment', 'britishcolumbia', 'gables', 'neural',
  ]).has(normalized);
}

function isOwnFundEntity(name: string): boolean {
  const normalized = normalizeProspectName(name);
  if (!normalized) return true;
  if (/^(lucas|tony|anthony|alicia|medina|medinaventures|medinavc|mediavc)$/.test(normalized)) return true;
  return /\bmedina\s+(ventures|vc|capital)\b/i.test(name);
}

function looksLikePersonName(name: string): boolean {
  const clean = normalizeWhitespace(name).replace(/[,.]+$/g, '');
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return false;
  return PERSON_FIRST_NAMES.has(tokens[0].toLowerCase()) && tokens.every(token => /^[A-Z][a-zA-Z.'’-]+$/.test(token));
}

function isPersonSingleTokenSegment(segment: string): boolean {
  const clean = normalizeWhitespace(segment).replace(/[,.]+$/g, '');
  const normalized = clean.toLowerCase().replace(/[^a-z]/g, '');
  return /^[A-Z][a-zA-Z.'’-]+$/.test(clean) &&
    (PERSON_FIRST_NAMES.has(normalized) || PERSON_CONTACT_SINGLE_NAMES.has(normalized));
}

function isPersonSegmentLike(segment: string): boolean {
  let clean = normalizeWhitespace(segment).replace(/^[([{]+|[)\]}]+$/g, '').replace(/[,.]+$/g, '');
  clean = clean.replace(/^(?:dr|mr|mrs|ms)\.?\s+/i, '');
  if (!clean || hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return false;
  if (isPersonSingleTokenSegment(clean) || looksLikePersonName(clean)) return true;
  return /^(?:[A-Z]\.?\s*){1,3}[A-Z][a-zA-Z.'’-]+$/.test(clean);
}

function personBundleSegments(name: string): string[] {
  const clean = normalizeWhitespace(name);
  if (!clean || isKnownConnectorCompanyName(clean)) return [];
  let normalized = clean
    .replace(/\s+(?:and|with)\s+/gi, ' / ')
    .replace(/\s*[\/+;,]\s*/g, ' / ');
  if (!isKnownConnectorCompanyName(clean)) normalized = normalized.replace(/\s*&\s*/g, ' / ');
  return normalized.split(/\s+\/\s+/).map(part => part.trim()).filter(Boolean);
}

function looksLikePersonOrParticipantBundle(name: string): boolean {
  const clean = normalizeWhitespace(name);
  if (!clean || hasCompanyToken(clean) || isKnownConnectorCompanyName(clean)) return false;
  const descriptor = clean.match(/^(.+?)\s+of\s+(.+)$/i);
  if (descriptor?.[1] && isPersonSegmentLike(descriptor[1])) return true;
  const segments = personBundleSegments(clean);
  if (segments.length < 2 || segments.length > 5) return false;
  return segments.every(isPersonSegmentLike);
}

function lineExcerptAt(text: string, start: number, end: number): string {
  const before = text.lastIndexOf('\n', Math.max(0, start - 1));
  const after = text.indexOf('\n', end);
  return text.slice(before < 0 ? 0 : before + 1, after < 0 ? text.length : after).slice(0, 500);
}

export function prospectContextWindow(
  text: string,
  spanStart?: number | null,
  spanEnd?: number | null,
  targetChars = PROSPECT_CONTEXT_WINDOW_CHARS
): string {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return '';
  const limit = Math.max(200, Math.floor(targetChars || PROSPECT_CONTEXT_WINDOW_CHARS));
  if (source.length <= limit) return source;

  const start = typeof spanStart === 'number' && Number.isFinite(spanStart)
    ? Math.max(0, Math.min(source.length, Math.floor(spanStart)))
    : null;
  const end = typeof spanEnd === 'number' && Number.isFinite(spanEnd)
    ? Math.max(start ?? 0, Math.min(source.length, Math.floor(spanEnd)))
    : start;

  if (start == null || end == null) {
    const prefix = source.slice(0, limit).trim();
    return `${prefix}...`;
  }

  const center = Math.floor((start + end) / 2);
  let windowStart = Math.max(0, center - Math.floor(limit / 2));
  let windowEnd = Math.min(source.length, windowStart + limit);
  windowStart = Math.max(0, windowEnd - limit);

  const excerpt = source.slice(windowStart, windowEnd).trim();
  return `${windowStart > 0 ? '...' : ''}${excerpt}${windowEnd < source.length ? '...' : ''}`;
}

function stripEmailScaffoldingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^(?:from|sent|to|cc|bcc|date|subject)\s*:/i.test(trimmed)) return true;
  if (/^(?:fwd?|re)\s*:\s*$/i.test(trimmed)) return true;
  if (/^(?:fwd?|re)\s*:\s*(?:from|sent|to|cc|bcc|date)\b/i.test(trimmed)) return true;
  if (/^[-_]{2,}\s*(?:original|forwarded)\s+message\s*[-_]{2,}$/i.test(trimmed)) return true;
  if (/^on\s+(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[, ]/i.test(trimmed)) return true;
  if (/^on\s+.+\s+wrote:$/i.test(trimmed)) return true;
  if (/^(?:hi|hello|hey|dear)\s+[A-Z][A-Za-z.'-]{1,30}[,!.\s]*$/i.test(trimmed)) return true;
  if (/^(?:best|thanks|thank you|regards|sincerely|cheers|warmly)[,!.\s]*$/i.test(trimmed)) return true;
  if (/^(?:get outlook for ios|sent from my iphone|sent from my ipad)$/i.test(trimmed)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}(?:,\s*\d{1,2}:\d{2}\s*(?:am|pm)?)?$/i.test(trimmed)) return true;
  return false;
}

export function cleanProspectSourceText(rawText: string): { cleanedText: string } {
  const normalizedText = String(rawText || '')
    .replace(/&nbsp;|&#160;|&#65279;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+(Begin forwarded message:)/gi, '\n$1')
    .replace(/\s+((?:From|Sent|To|Cc|Bcc|Date|Subject):)/gi, '\n$1')
    .replace(/\s+(On\s+(?:mon|tue|wed|thu|fri|sat|sun)[^.\n]{0,200}\s+wrote:?)/gi, '\n$1');
  const lines = normalizedText.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^>\s?/.test(line)) continue;
    if (stripEmailScaffoldingLine(line)) continue;
    const trimmed = line.trim();
    if (/^(?:lucas|tony|anthony|alicia)\b(?:\s+[A-Z][A-Za-z.'-]+)?\s*$/i.test(trimmed)) continue;
    if (
      /\bmedina\s+(?:ventures|vc|capital)\b/i.test(trimmed) &&
      trimmed.length < 80 &&
      !/\b(?:intro|introduction|meet|deck|update|fundrais|pitch|demo)\b|\([^)]+\)/i.test(trimmed)
    ) continue;
    kept.push(line);
  }
  return { cleanedText: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function domainLabelToCompany(domain: string): string {
  let first = domain.toLowerCase().replace(/^www\./, '').split('.')[0] || '';
  first = first.replace(/(?:inc|llc|ltd|corp|cpa|management)$/i, '');
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function shouldIgnoreDomain(domain: string, env?: Env): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  const first = normalized.split('.')[0];
  if (/medina|mediavc/.test(normalized)) return true;
  const common = new Set([
    'gmail.com', 'google.com', 'outlook.com', 'office.com', 'office365.com',
    'microsoft.com', 'icloud.com', 'yahoo.com', 'hotmail.com', 'aol.com',
    'zoom.us', 'linkedin.com', 'x.com', 'twitter.com', 'facebook.com',
    'instagram.com', 'youtube.com', 'substack.com', 'mailchimp.com',
    'sendgrid.net', 'hubspot.com', 'salesforce.com', 'dropbox.com',
    'box.com', 'docusign.net', 'calendly.com',
  ]);
  if (common.has(normalized)) return true;
  if (['zoom', 'zoomcrc', 'googlemeet', 'teams', 'webex'].includes(first)) return true;
  if (first.length < 3) return true;
  return env ? isInternalEmailDomain(`noreply@${normalized}`, getConfiguredInternalDomains(env)) : false;
}

function findCaseInsensitive(text: string, needle: string, fromIndex = 0): number {
  if (!needle.trim()) return -1;
  return text.toLowerCase().indexOf(needle.toLowerCase(), fromIndex);
}

function stripJsonCodeFence(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return text;
}

function matchingJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJsonObject(raw: string, errorCode = 'INVALID_JSON_OBJECT'): Record<string, unknown> {
  const text = stripJsonCodeFence(raw);
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Fall through to matching-object extraction for responses with prose after the object.
    }
  }
  const start = text.indexOf('{');
  const end = start >= 0 ? matchingJsonObjectEnd(text, start) : -1;
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${errorCode}: ${message}`);
    }
  }
  throw new Error(errorCode);
}

function parseOrgExtractionResponse(raw: string): ProspectOrgExtractionLlmOutput[] {
  const parsed = parseJsonObject(raw, 'INVALID_ORG_EXTRACTION_JSON');
  const rows = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  const out: ProspectOrgExtractionLlmOutput[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? normalizeWhitespace(entry.name) : '';
    if (!name) continue;
    out.push({
      name,
      raw: typeof entry.raw === 'string' ? normalizeWhitespace(entry.raw) : null,
      context: typeof entry.context === 'string' ? normalizeWhitespace(entry.context).slice(0, 300) : null,
    });
  }
  return out;
}

function orgExtractionModel(env: Env): string {
  return env.PROSPECT_ORG_EXTRACTOR_MODEL || env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || PROSPECT_CLASSIFIER_DEFAULT_MODEL;
}

function buildOrgExtractionPrompt(input: ProspectOrgExtractionLlmInput): { system: ClaudeSystemPrompt; user: string } {
  const staticSystem = `Extract organization names from one cleaned source item for a venture-fund prospect-intelligence pipeline.
Return strict JSON only. Include real organizations of any role: startups, known deals, customers,
vendors, law firms, accelerators, government channels, investors, and companies in news.
	Do not include people, greetings, dates, email headers, quoted-reply scaffolding, personal names,
	person/participant bundles, section headings, filenames, markup/schema/CSS artifacts,
	calendar or meeting-link scaffolding, DocReq/doc-request labels, Medina Ventures / Medina VC, or
	generic words. Do not classify the mention_type, direction, or sector.
Only include names whose exact text appears in the source so the caller can anchor a deterministic span.
Output: {"organizations":[{"name":"Organization Name","raw":"exact source span","context":"short local context"}]}`;
  const system: ClaudeSystemPrompt = [
    { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral' } },
  ];
  const user = `SOURCE CONTEXT:
${input.sourceContext}

CLEANED SOURCE:
${input.cleanedText.slice(0, 7000)}`;
  return { system, user };
}

async function defaultLlmExtractOrganizations(
  input: ProspectOrgExtractionLlmInput,
  env: Env
): Promise<ProspectOrgExtractionLlmOutput[]> {
  const prompt = buildOrgExtractionPrompt(input);
  const result = await callClaudeWithUsage(
    { system: prompt.system, user: prompt.user, max_tokens: 900, orgId: input.orgId, model: orgExtractionModel(env) },
    'low',
    env
  );
  return parseOrgExtractionResponse(result.text);
}

function sectorHintForText(text: string): { key: SectorKey; confidence: number } {
  const s = text.toLowerCase();
  const checks: Array<{ key: SectorKey; confidence: number; terms: RegExp[] }> = [
    { key: 'cybersecurity', confidence: 0.86, terms: [/\bcybersecurity\b/, /\bsecurity\b/, /\bthreat\b/, /\bsiem\b/, /\bidentity\b/, /\bzero trust\b/, /\bvulnerability\b/, /\bmalware\b/, /\bfortilayer\b/, /\bbinlens\b/] },
    { key: 'quantum', confidence: 0.86, terms: [/\bquantum\b/, /\bqubit\b/, /\bphotonic\b/, /\bpost-quantum\b/] },
    { key: 'ai_data', confidence: 0.86, terms: [/\bai\b/, /\bartificial intelligence\b/, /\bmachine learning\b/, /\bmlops\b/, /\bgpu\b/, /\binference\b/, /\bvector database\b/, /\bdata infrastructure\b/, /\bllm\b/] },
    { key: 'dev_cloud_infra', confidence: 0.82, terms: [/\bdeveloper tool/, /\bdevtools?\b/, /\bcloud infrastructure\b/, /\bkubernetes\b/, /\bserverless\b/, /\bobservability\b/, /\bdata infrastructure\b/] },
    { key: 'enterprise_software', confidence: 0.78, terms: [/\bsaas\b/, /\bworkflow\b/, /\benterprise\b/, /\bplatform\b/, /\bcrm\b/, /\berp\b/] },
    { key: 'fintech', confidence: 0.84, terms: [/\bfintech\b/, /\bpayments?\b/, /\bbanking\b/, /\bcredit\b/, /\binsurtech\b/, /\bfraud\b/] },
    { key: 'healthcare', confidence: 0.8, terms: [/\bhealthcare\b/, /\bbiotech\b/, /\bpharma\b/, /\bclinical\b/, /\bmedical\b/] },
    { key: 'aerospace_defense', confidence: 0.82, terms: [/\baerospace\b/, /\bdefen[cs]e\b/, /\barmy\b/, /\bnavy\b/, /\bair force\b/, /\bmilitary\b/, /\bdod\b/, /\bdual-use\b/, /\buav\b/, /\bsbir\b/] },
    { key: 'hardware_semis', confidence: 0.78, terms: [/\bhardware\b/, /\bsemiconductor\b/, /\bchips?\b/, /\bsensor\b/, /\bdevice\b/, /\bsilicon\b/] },
    { key: 'robotics', confidence: 0.82, terms: [/\brobotics?\b/, /\bautonomous robot\b/, /\bdrone\b/, /\brover\b/] },
    { key: 'energy_climate', confidence: 0.8, terms: [/\bclimate\b/, /\bcarbon\b/, /\benergy\b/, /\bbattery\b/, /\bsolar\b/, /\bgrid\b/] },
    { key: 'materials_manufacturing', confidence: 0.8, terms: [/\bmaterials?\b/, /\bmanufactur/, /\bhempcrete\b/, /\bcomposite\b/, /\bcement\b/, /\bfactory\b/] },
    { key: 'mobility_logistics', confidence: 0.78, terms: [/\bmobility\b/, /\blogistics\b/, /\bsupply chain\b/, /\bfreight\b/, /\bfleet\b/, /\bshipping\b/] },
    { key: 'real_estate_built_env', confidence: 0.74, terms: [/\breal estate\b/, /\bproptech\b/, /\bconstruction\b/, /\bbuilt environment\b/, /\bbuilding\b/] },
    { key: 'consumer', confidence: 0.65, terms: [/\bconsumer\b/, /\bcreator\b/, /\bmarketplace\b/, /\bcommerce\b/] },
    { key: 'agri_food', confidence: 0.76, terms: [/\bagricultur/, /\bfood\b/, /\bfarm\b/, /\bcrop\b/, /\bprotein\b/] },
    { key: 'education', confidence: 0.76, terms: [/\beducation\b/, /\bedtech\b/, /\blearning\b/, /\bschool\b/, /\btraining\b/] },
  ];
  for (const check of checks) {
    if (check.terms.some(re => re.test(s))) return { key: check.key, confidence: check.confidence };
  }
  return { key: 'uncategorized', confidence: 0.2 };
}

function hasDeckSignal(item: ClassifiedItem): boolean {
  const text = `${item.subject || ''}\n${item.bodyText || ''}\n${item.bodyPreview || ''}`.toLowerCase();
  if (/\b(pitch deck|deck attached|attached deck|data room|cim|memo)\b/.test(text)) return true;
  return (item.attachments || []).some(att =>
    /\b(deck|pitch|memo|cim|data[-_\s]?room|teaser)\b/i.test(att.name) ||
    /\.(pptx?|pdf)$/i.test(att.name)
  );
}

function hasMeetingSignal(item: ClassifiedItem): boolean {
  const haystack = `${item.subject || ''}\n${item.bodyText || ''}`.toLowerCase();
  return item.type === 'calendar_event' || /\b(meeting|met with|call|zoom|intro call|demo)\b/.test(haystack);
}

function isNewsletterLike(item: ClassifiedItem): boolean {
  const from = `${item.fromEmail || ''} ${item.fromName || ''}`.toLowerCase();
  const subject = (item.subject || '').toLowerCase();
  if (/\b(newsletter|digest|news|weekly|daily brief|nvca|substack|mailchimp)\b/.test(from)) return true;
  if (/\b(newsletter|news digest|weekly digest|daily digest|market update|nvca)\b/.test(subject)) return true;
  return item.type === 'news';
}

function inferDirection(item: ClassifiedItem, env: Env, companyDomain?: string | null): DeterministicDirection {
  if (item.direction) return item.direction;
  if (item.type === 'news') return 'news';
  const internalDomains = getConfiguredInternalDomains(env);
  const fromInternal = isInternalEmailDomain(item.fromEmail, internalDomains);
  const fromDomain = emailDomain(item.fromEmail);
  const recipients = [...(item.toEmails || []), ...(item.ccEmails || [])].filter(Boolean);
  const recipientDomains = recipients.map(email => emailDomain(email)).filter(Boolean) as string[];
  const normalizedCompanyDomain = companyDomain?.trim().toLowerCase() || null;
  if (normalizedCompanyDomain && fromDomain === normalizedCompanyDomain) return 'inbound';
  if (normalizedCompanyDomain && fromInternal && recipientDomains.includes(normalizedCompanyDomain)) return 'outbound';
  if (fromInternal && recipients.length > 0 && recipients.every(email => isInternalEmailDomain(email, internalDomains))) return 'internal';
  if (fromInternal) return 'outbound';
  if (item.type === 'slack_message') return 'internal';
  return 'inbound';
}

function signalKindFor(item: ClassifiedItem, mention: MentionCandidate, hasDeck: boolean, hasMeeting: boolean): SignalKind {
  const haystack = `${item.subject || ''}\n${mention.contextText || mention.lineText}\n${item.bodyPreview || ''}`.toLowerCase();
  if (hasDeck) return 'deck';
  if (hasMeeting) return 'meeting';
  if (isWarmIntroSignal(item, mention)) return 'intro';
  if (/\b(raise|raising|round|seed|series [abc]|allocation|term sheet)\b/.test(haystack)) return 'raise';
  if (mention.isListEntry) return 'list_entry';
  return 'cold_mention';
}

function isWarmIntroSignal(item: ClassifiedItem, mention: MentionCandidate): boolean {
  const haystack = `${item.subject || ''}\n${mention.contextText || mention.lineText}\n${item.bodyPreview || ''}`.toLowerCase();
  return /\b(intro|introducing|introduction|warm intro|meet\s+\w+)/.test(haystack);
}

function confidenceFor(kind: SignalKind, direction: DeterministicDirection, newsletter: boolean): { confidence: number; tier: ConfidenceTier; provisional: boolean } {
  if (newsletter) return { confidence: 0.25, tier: 'low', provisional: true };
  let confidence = 0.62;
  if (kind === 'meeting') confidence += 0.18;
  if (kind === 'deck') confidence += 0.16;
  if (kind === 'intro') confidence += 0.14;
  if (kind === 'raise') confidence += 0.1;
  if (kind === 'list_entry') confidence -= 0.08;
  if (kind === 'cold_mention') confidence -= 0.12;
  if (direction === 'outbound' || direction === 'internal') confidence -= 0.25;
  confidence = clamp(confidence, 0.05, 0.98);
  return {
    confidence,
    tier: confidence >= 0.82 ? 'high' : confidence >= 0.55 ? 'medium' : 'low',
    provisional: confidence < 0.82,
  };
}

function confidenceTierFor(confidence: number): ConfidenceTier {
  return confidence >= 0.82 ? 'high' : confidence >= 0.55 ? 'medium' : 'low';
}

function prospectClassifierModel(env: Env, input?: ProspectClassifierInput): string {
  const isListEntry = Boolean((input?.prefilterHints as any)?.mention?.parse_dealflow_list);
  if (isListEntry && env.PROSPECT_LIST_CLASSIFIER_MODEL) return env.PROSPECT_LIST_CLASSIFIER_MODEL;
  return env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || PROSPECT_CLASSIFIER_DEFAULT_MODEL;
}

function compactClassifierText(value: string | undefined, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function parseDirection(value: unknown): Direction {
  const v = String(value || '').trim().toLowerCase();
  if (PROSPECT_DIRECTION_SET.has(v)) return v as Direction;
  throw new Error(`INVALID_LLM_DIRECTION:${v || 'empty'}`);
}

function parseMentionType(value: unknown): MentionType {
  const v = String(value || '').trim().toLowerCase();
  if (PROSPECT_MENTION_TYPE_SET.has(v)) return v as MentionType;
  throw new Error(`INVALID_LLM_MENTION_TYPE:${v || 'empty'}`);
}

function parseNullableClassifierString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = normalizeWhitespace(value);
  if (!text || /^null$/i.test(text)) return null;
  return text.slice(0, 180);
}

function actionFromLegacyFields(mentionType: MentionType, legacySignalDisposition: unknown): ProspectAction {
  const disposition = String(legacySignalDisposition || '').trim().toLowerCase();
  if (disposition === 'create_prospect') return 'create_prospect';
  if (disposition === 'attach_known_deal' || disposition === 'attach_existing_deal') return 'attach_existing_deal';
  if (disposition === 'relationship_signal' || disposition === 'meeting_signal') return 'record_context';
  if (disposition === 'admin_noise' || disposition === 'news_only' || disposition === 'web_analytics') return 'ignore';
  if (mentionType === 'inbound_prospect') return 'create_prospect';
  if (mentionType === 'known_deal') return 'attach_existing_deal';
  if (mentionType === 'intro_source') return 'record_context';
  return 'ignore';
}

function parseProspectAction(value: unknown, mentionType: MentionType, legacySignalDisposition?: unknown): ProspectAction {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return actionFromLegacyFields(mentionType, legacySignalDisposition);
  if (PROSPECT_ACTION_SET.has(v)) return v as ProspectAction;
  throw new Error(`INVALID_LLM_PROSPECT_ACTION:${v}`);
}

function mentionTypeForAction(action: ProspectAction): MentionType {
  if (action === 'create_prospect') return 'inbound_prospect';
  if (action === 'attach_existing_deal') return 'known_deal';
  return 'noise';
}

const VETO_LINK_OR_ADMIN_NAMES = new Set([
  'googlemeet',
  'meetinglink',
  'joinwithgooglemeet',
  'joinby',
  'joinbyphone',
  'videocall',
  'conferencecall',
  'calendarinvite',
]);

const VETO_TOOL_OR_LINK_HOSTS = new Set([
  'vimeo',
  'docsend',
  'google',
  'microsoft',
  'microsoftteams',
  'teams',
  'zoom',
  'slack',
  'calendly',
  'docusign',
  'dropbox',
  'box',
  'read',
  'readai',
]);

const VETO_GOVERNMENT_OR_BUYER_ENTITIES = new Set([
  'army',
  'usarmy',
  'airforceresearchlab',
  'unitedstatesarmy',
  'dod',
  'departmentofdefense',
  'southcom',
  'ussouthcom',
  'navy',
  'usnavy',
  'airforce',
  'usairforce',
  'spaceforce',
  'marines',
  'usmarines',
  'nasa',
  'nist',
  'cern',
  'montanastateuniversity',
  'millerschoolofmedicine',
]);

const VETO_SERVICE_PROVIDER_NAMES = new Set([
  'cjwquantum',
  'cjwquantumconsulting',
  'deloitte',
  'finalis',
  'finalissecurities',
  'ksdt',
  'lazard',
  'sheehanfinance',
  'woodyravine',
  'orrick',
  'greenbergtraurig',
  'gtlaw',
  'goodkindandflorio',
  'goodkindflorio',
]);

const VETO_PARTNER_CHANNEL_NAMES = new Set([
  'emergeamericas',
]);

const VETO_MAJOR_CUSTOMER_OR_BUYER_NAMES = new Set([
  'carahsoft',
  'ibm',
  'jpmorganchase',
]);

const VETO_FUND_OR_LP_NAMES = new Set([
  'bldholdings',
  'frontporch',
  'quantonation',
]);

const VETO_WEAK_KNOWN_DEAL_ATTACH_NAMES = new Set([
  'cantos',
  'lightsync',
  'maestro',
  'mergeit',
  'spookstock',
  'terramarc',
]);

const VETO_SINGLE_PERSON_NAMES = new Set([
  'apollo',
  'bea',
  'patrick',
  'lloyd',
  'craig',
  'manny',
  'raul',
  'chuck',
]);

function currentCompanyPattern(company: string): string | null {
  const compactCompany = normalizeWhitespace(company);
  if (!compactCompany) return null;
  return escapeRegExp(compactCompany)
    .replace(/\s+/g, '\\s+')
    .replace(/Venture\\s\+Capital/gi, '(?:Venture\\s+Capital|VC)');
}

function hasDifferentActualTarget(context: string, currentNormalizedName: string): boolean {
  if (!currentNormalizedName) return false;
  const targetPatterns = [
    /\b(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?)\s+(?:is|was|appears to be|seems to be|:)\s+([A-Za-z0-9&.'’ -]{2,80})/i,
    /\b([A-Za-z0-9&.'’ -]{2,80})\s+(?:is|was|appears to be|seems to be)\s+(?:the\s+)?(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?)/i,
  ];
  for (const pattern of targetPatterns) {
    const match = context.match(pattern);
    if (!match?.[1]) continue;
    const target = normalizeWhitespace(match[1])
      .replace(/[.;:,].*$/g, '')
      .replace(/\s+\b(?:not|rather|instead|while|but|because|with|for|as|and|that|which)\b.*$/i, '')
      .trim();
    const targetNormalized = normalizeProspectName(target);
    if (
      targetNormalized &&
      targetNormalized !== currentNormalizedName &&
      !targetNormalized.includes(currentNormalizedName) &&
      !currentNormalizedName.includes(targetNormalized)
    ) {
      return true;
    }
  }
  return false;
}

function cleanPotentialCompanyName(raw: string): string {
  return normalizeWhitespace(raw)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+(?:is|was|has|have|with|and|but|while|because|that|which|who|from|by|for|as)\b.*$/i, '')
    .replace(/[.;:,]+$/g, '')
    .trim();
}

function companyNamesEquivalent(left: string, right: string): boolean {
  const a = normalizeProspectName(left);
  const b = normalizeProspectName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function collectPrimaryTargetNames(context: string): string[] {
  const text = String(context || '');
  const candidates: string[] = [];
  const push = (raw: string | undefined): void => {
    const clean = cleanPotentialCompanyName(raw || '');
    if (!clean || clean.length < 3 || clean.length > 90) return;
    if (isGenericCandidate(clean) || isOwnFundEntity(clean) || looksLikePersonName(clean) || looksLikePersonOrParticipantBundle(clean)) return;
    if (!/[A-Za-z]/.test(clean)) return;
    const normalized = normalizeProspectName(clean);
    if (!normalized || candidates.some(existing => companyNamesEquivalent(existing, clean))) return;
    candidates.push(clean);
  };

  const patterns = [
    /\b(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?|opportunity)\s+(?:is|was|appears to be|seems to be|:)\s+["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})/gi,
    /\b["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})["”]?\s+(?:is|was|appears to be|seems to be)\s+(?:the\s+)?(?:actual|real)\s+(?:investment\s+)?(?:prospect|target|company(?:\s+being\s+pitched)?|opportunity)\b/gi,
    /\b["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})["”]?\s+is\s+being\s+(?:actively\s+)?(?:introduced|presented|pitched|shared|sent)\s+(?:to\s+\w+\s+)?(?:as|for|by)\s+(?:an?\s+)?(?:investment\s+)?(?:opportunity|prospect|deal|target)\b/gi,
    /\b(?:investment\s+)?(?:opportunity|prospect|target)\s+(?:here\s+)?(?:is|was|should be)\s+["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})/gi,
    /\b(?:customer|buyer|design\s+partner|channel\s+partner|commercial\s+partner|deployment|validation|standard|regulator|government\s+agency)\s+(?:of|for)\s+["“]?([A-Za-z0-9][A-Za-z0-9&.'’ -]{2,90})/gi,
    /\bMeeting\s+([A-Z0-9][A-Za-z0-9&.'’ -]{2,60})\s+<>\s+Medina\b/g,
    /\blearn\s+more\s+about\s+([A-Z0-9][A-Za-z0-9&.'’ -]{2,60})\b/gi,
    /\b(?:About|Company|Target company)\s+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})(?=\s+(?:is|has|have|helps|offers|builds|develops|developed|provides|raised|raises|will|$))/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) push(match[1]);
  }

  return candidates;
}

function hasDifferentPrimaryTargetEvidence(context: string, currentNormalizedName: string): boolean {
  if (!currentNormalizedName) return false;
  for (const target of collectPrimaryTargetNames(context)) {
    const targetNormalized = normalizeProspectName(target);
    if (
      targetNormalized &&
      targetNormalized !== currentNormalizedName &&
      !targetNormalized.includes(currentNormalizedName) &&
      !currentNormalizedName.includes(targetNormalized)
    ) {
      return true;
    }
  }
  return false;
}

function senderDomainCompanyMatches(context: string, company: string): boolean {
  const companyNormalized = normalizeProspectName(company);
  if (!companyNormalized) return false;
  for (const match of context.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const domain = String(match[1] || '').toLowerCase().replace(/^www\./, '');
    if (!domain || shouldIgnoreDomain(domain)) continue;
    const domainCompany = domainLabelToCompany(domain);
    const domainNormalized = normalizeProspectName(domainCompany);
    if (domainNormalized && (companyNormalized === domainNormalized || companyNormalized.includes(domainNormalized) || domainNormalized.includes(companyNormalized))) {
      return true;
    }
  }
  return false;
}

function hasCurrentCompanyServiceProviderRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    `\\b${companyPattern}\\b\\s+(?:is|was|serves\\s+as|served\\s+as|acting\\s+as|acted\\s+as)\\s+(?:the\\s+)?(?:exclusive\\s+)?(?:financial\\s+advisor|investment\\s+bank(?:er)?|accounting\\s+(?:and\\s+)?advisory\\s+firm|consulting\\s+firm|broker[-\\s]?dealer|placement\\s+agent|legal\\s+counsel|law\\s+firm)\\b`,
    'i'
  ).test(context);
}

function hasCurrentCompanyIntroSourceRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    [
      `\\b(?:introduced|referred|sent|forwarded|shared)\\s+(?:by|from|via)\\s+${companyPattern}\\b`,
      `\\b(?:presented|pitched|shared|sourced|sent|forwarded|introduced)\\s+(?:by|from|via)\\s+${companyPattern}\\b`,
      `\\bby\\s+${companyPattern}\\b[^.\\n]{0,120}\\b(?:intro|source|advisor|broker|banker|presenting|dealmaker|partner)\\b`,
      `\\b${companyPattern}\\b\\s+(?:introduced|referred|sent|forwarded|shared)\\b`,
      `\\b${companyPattern}\\b\\s+(?:is|was)\\s+(?:the\\s+)?(?:intro\\s+source|introducer|referrer|source|channel|dealmaker|sourcing\\s+partner|presenting\\s+firm|firm\\s+presenting|investment\\s+bank(?:er)?|advisor)\\b`,
    ].join('|'),
    'i'
  ).test(context);
}

function hasCurrentCompanyInvestorBackingRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    [
      `\\b(?:backed|funded|financed)\\s+by\\s+[^.\\n]{0,180}\\b${companyPattern}\\b`,
      `\\b(?:led|co[-\\s]?led)\\s+by\\s+[^.\\n]{0,180}\\b${companyPattern}\\b`,
      `\\b(?:investors?|backers?|cap\\s+table)\\s+(?:include|includes|included|including|with)\\s+[^.\\n]{0,180}\\b${companyPattern}\\b`,
    ].join('|'),
    'i'
  ).test(context);
}

function hasCurrentCompanyCustomerPartnerRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  return new RegExp(
    [
      `\\b${companyPattern}\\b[^.\\n]{0,80}\\b(?:is|was|appears\\s+as|mentioned\\s+as)\\s+(?:a\\s+)?(?:customer|buyer|design\\s+partner|channel\\s+partner|commercial\\s+partner|deployment|standard|regulator|government\\s+agency)\\b`,
      `\\b(?:customer|buyer|design\\s+partner|channel\\s+partner|commercial\\s+partner|deployment|validation|standard|regulator|government\\s+agency)\\b[^.\\n]{0,140}\\b${companyPattern}\\b`,
      `\\b(?:pitched|sold|introduced)\\s+(?:to|into)\\s+${companyPattern}\\b`,
    ].join('|'),
    'i'
  ).test(context);
}

function hasCurrentCompanyFundOrLpRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  const normalized = normalizeProspectName(company);
  if (!companyPattern) return false;
  if (VETO_FUND_OR_LP_NAMES.has(normalized)) {
    return true;
  }
  if (/\b(?:medina\s+lp|lp\s+reference|prospective\s+lp|feeder\s+fund|minimum\s+units|fund\s+investor|fundraising\s+update)\b/i.test(context)) {
    return true;
  }
  if (
    /\b(?:venture\s+fund|investment\s+fund|fund\s+of\s+funds|hybrid\s+venture\s+fund|hybrid\s+venture\s+vehicle|feeder\s+fund|investing\s+in\s+funds)\b/i.test(context) &&
    (/\b(?:capital|ventures|fund|holdings|partners)\b/i.test(company) || /(?:capital|ventures|fund|holdings|partners)$/.test(normalized))
  ) {
    return true;
  }
  return new RegExp(`\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:prospective\\s+lp|limited\\s+partner|fund\\s+investor|feeder\\s+fund|investment\\s+fund|venture\\s+fund|hybrid\\s+venture\\s+vehicle|investing\\s+in\\s+funds)\\b`, 'i').test(context);
}

function compactCompanyEvidenceValue(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function currentCompanyEvidencePatterns(company: string): string[] {
  const clean = normalizeWhitespace(company);
  const patterns: string[] = [];
  const push = (source: string): void => {
    if (!source || patterns.includes(source)) return;
    patterns.push(source);
  };
  if (clean) {
    push(escapeRegExp(clean).replace(/(?:\\\s|\\\.)+/g, '[\\s.-]*').replace(/\s+/g, '[\\s.-]*'));
  }
  const compactCompany = compactCompanyEvidenceValue(company);
  const suffix = compactCompany.match(/^([a-z0-9]{3,})(ai|io|co|com|labs|systems|technologies|technology)$/);
  if (suffix?.[1] && suffix[2]) {
    push(`${escapeRegExp(suffix[1])}[\\s.-]*${escapeRegExp(suffix[2])}`);
    if (suffix[2] === 'ai') push(escapeRegExp(suffix[1]));
  }
  const normalizedCompany = normalizeProspectName(company);
  if (normalizedCompany && normalizedCompany !== compactCompany) push(escapeRegExp(normalizedCompany));
  return patterns.filter(pattern => pattern.length >= 4);
}

function hasCurrentCompanyDirectTargetAssertion(context: string, company: string): boolean {
  if (!normalizeProspectName(company)) return false;
  const evidencePatterns = currentCompanyEvidencePatterns(company);
  if (evidencePatterns.length === 0) return false;
  const positiveTargetLanguage = /\b(?:(?:is|was|itself|company)?\s*(?:being\s+)?(?:introduced|pitched|presented|shared|sent)\b[^.\n]{0,140}\b(?:Medina|fund|investment\s+opportunity|inbound\s+prospect|prospect|target|deal)\b|(?:introduced|pitched|presented|shared|sent)\s+to\s+Medina\b|warm\s+intro\b[^.\n]{0,120}\b(?:Medina|deck|pitch|raise|raising|investment\s+opportunity)\b|share\s+what\s+(?:we|they)(?:'|’)?re\s+building|following\s+up\s+(?:on|about)\b[^.\n]{0,120}\b(?:deck|pitch|raise|raising|investment\s+opportunity))\b/i;
  const negativeOrRedirectLanguage =
    /\b(?:not\s+(?:the|an)\s+(?:investment\s+)?(?:target|prospect|company)|not\s+itself|source\s+context|sender\s+context|intro\s+source|reaching\s+out,\s+but|but\s+[A-Z0-9][A-Za-z0-9&.'’ -]{1,80}\s+(?:is|was|appears)|actual\s+(?:company|target|prospect)\s+(?:is|was))\b/i;

  for (const chunk of String(context || '').split(/(?<=[.!?])\s+|\n+/)) {
    const clean = normalizeWhitespace(chunk);
    if (!clean || clean.length > 800) continue;
    if (negativeOrRedirectLanguage.test(clean)) continue;
    for (const pattern of evidencePatterns) {
      const mention = new RegExp(`\\b${pattern}\\b`, 'i').exec(clean);
      if (!mention) continue;
      const afterMention = clean.slice(mention.index, mention.index + 260);
      if (positiveTargetLanguage.test(afterMention)) return true;
    }
  }
  return false;
}

function hasCurrentCompanyInvestmentTargetEvidence(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return hasCurrentCompanyDirectTargetAssertion(context, company);
  const targetLanguage = new RegExp(
    [
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:actual|real)\\s+(?:investment\\s+)?(?:prospect|target|company\\s+being\\s+pitched)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:being\\s+)?(?:pitched|presented|sent|shared)\\s+(?:as|for)\\s+(?:an?\\s+)?(?:investment\\s+)?(?:opportunity|prospect|target)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,220}\\b(?:introduced|warm\\s+intro|pitched|presented)[^.\\n]{0,140}\\b(?:Medina|fund|investment\\s+opportunity|inbound\\s+prospect)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,240}\\b(?:round|term\\s+sheet|investment\\s+memo|co[-\\s]?lead|lead\\s+investment|firm\\s+commitments?|valuation|board\\s+(?:observer|director)|series\\s+[a-z]|raise|raising|fundrais(?:e|ing)|deck|pitch)\\b`,
      `\\b(?:intro(?:duction)?|meet|meeting|call)\\s+(?:to|with|for)?\\s+[^.\\n]{0,100}\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:founders?|co[-\\s]?founders?|ceo|team|deck|pitch|raising|fundrais(?:e|ing)|investment\\s+opportunity)\\b`,
      `\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:founders?|co[-\\s]?founders?|ceo|team)\\b[^.\\n]{0,160}\\b(?:intro|meeting|call|deck|pitch|raising|fundrais(?:e|ing)|investment\\s+opportunity)\\b`,
      `\\b(?:mention\\s+itself|company\\s+shown|company\\s+in\\s+question)\\s+[^.\\n]{0,120}\\b${companyPattern}\\b[^.\\n]{0,160}\\b(?:pitched|presented|investment\\s+opportunity)\\b`,
    ].join('|'),
    'i'
  );
  return targetLanguage.test(context) || hasCurrentCompanyDirectTargetAssertion(context, company);
}

function hasWeakKnownDealAttachContext(context: string, company: string): boolean {
  const normalized = normalizeProspectName(company);
  if (!VETO_WEAK_KNOWN_DEAL_ATTACH_NAMES.has(normalized)) return false;
  return (
    /\b(?:internal|meeting\s+summary|generated\s+meeting\s+summary|financial\s+diligence|closing\s+coordination|thank\s+you|invitation|event|conference|agenda|portfolio\s+update|relationship\s+context|stale|historical|not\s+a\s+new\s+(?:prospect|investment|deal))\b/i.test(context) ||
    /\b(?:known|existing)\s+(?:portfolio|deal)\s+(?:company|investment|context)\b/i.test(context)
  );
}

function hasCurrentCompanyInvestorParticipantRole(context: string, company: string): boolean {
  const companyPattern = currentCompanyPattern(company);
  if (!companyPattern) return false;
  if (!/\b(?:capital|ventures|vc|fund|investors?|partners)\b/i.test(company)) return false;
  return new RegExp(
    `\\b${companyPattern}\\b\\s+(?:is\\s+mentioned\\s+as|was\\s+mentioned\\s+as|is|was|appears\\s+as|appears\\s+to\\s+be|mentioned\\s+as)\\s+(?:a\\s+)?(?:meeting\\s+)?(?:participant|attendee|investor|co[-\\s]?investor|vc|fund|capital\\s+partner)\\b|\\b(?:participant|attendee|investor|co[-\\s]?investor|vc)\\s+(?:at|in|on)\\s+[^.\\n]{0,120}\\b${companyPattern}\\b`,
    'i'
  ).test(context);
}

function prospectValuableActionVetoForMention(input: ProspectValuableActionVetoInput): ProspectValuableActionVetoDecision {
  if (input.prospectAction !== 'create_prospect' && input.prospectAction !== 'attach_existing_deal') {
    return { applied: false, reason: null, confidence: null, nonValuableAction: null };
  }
  const company = normalizeWhitespace(input.companyName || input.rawMention || '');
  const rawMention = normalizeWhitespace(input.rawMention || company);
  const normalized = normalizeProspectName(company);
  const nameHaystack = `${company}\n${rawMention}`.toLowerCase();
  const contextText = [
    input.senderAndContext || '',
    input.rawExcerpt || '',
    input.llmReasoning || '',
  ].join('\n');
  const contextHaystack = contextText.toLowerCase();
  const isCreate = input.prospectAction === 'create_prospect';
  const isAttach = input.prospectAction === 'attach_existing_deal';
  const prospectCompanyNormalized = normalizeProspectName(input.prospectCompanyName || '');
  const prospectCompanyPointsElsewhere = Boolean(
    prospectCompanyNormalized &&
    normalized &&
    prospectCompanyNormalized !== normalized &&
    !prospectCompanyNormalized.includes(normalized) &&
    !normalized.includes(prospectCompanyNormalized)
  );

  const veto = (reason: string, nonValuableAction: 'ignore' | 'record_context' = 'ignore'): ProspectValuableActionVetoDecision => ({
    applied: true,
    reason,
    confidence: 0.97,
    nonValuableAction,
  });

  if (isStandaloneDocumentHeading(company) || isGenericFragmentCandidate(company)) {
    return veto('section_heading_or_document_outline');
  }

  if (isMarkupArtifactCandidate(company)) {
    return veto('html_schema_or_markup_artifact');
  }

  if (
    VETO_LINK_OR_ADMIN_NAMES.has(normalized) ||
    /\b(?:google meet|meet\.google\.com|join with google meet|meeting link|join by phone|dial[-\s]?in|video call|calendar invite)\b/i.test(nameHaystack)
  ) {
    return veto('admin_link_or_calendar_scaffolding');
  }

  if (
    VETO_TOOL_OR_LINK_HOSTS.has(normalized) ||
    /\b(?:vimeo|docsend|zoom|calendly|docusign|dropbox|google drive|microsoft teams|slack)\.com\b/i.test(nameHaystack)
  ) {
    return veto('tool_vendor_or_link_host');
  }

  if (
    /\b(?:stadium|arena|hotel|airport|conference center|convention center|restaurant|resort|auditorium|theat(?:er|re)|club|school of medicine|research lab|university)\b/i.test(company)
  ) {
    return veto('venue_or_physical_location');
  }

  if (VETO_GOVERNMENT_OR_BUYER_ENTITIES.has(normalized)) {
    return veto('government_customer_or_buyer_entity');
  }

  if (VETO_MAJOR_CUSTOMER_OR_BUYER_NAMES.has(normalized)) {
    return veto('government_customer_or_buyer_entity', 'record_context');
  }

  if (VETO_PARTNER_CHANNEL_NAMES.has(normalized)) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (
    VETO_SERVICE_PROVIDER_NAMES.has(normalized) ||
    /\b(?:securities|broker[-\s]?dealer|financial advisor|exclusive financial advisor|investment bank(?:er)?|placement agent|law firm|legal counsel|attorneys?|cpa|fund admin|capital markets|accounting|advisory|consulting)\b/i.test(company) ||
    hasCurrentCompanyServiceProviderRole(contextText, company) ||
    (/\b(?:exclusive financial advisor|investment bank(?:er)?|broker[-\s]?dealer|placement agent|legal counsel|law firm|accounting and advisory firm|consulting firm)\b/i.test(contextHaystack) &&
      /\b(?:securities|advisor|advisory|law|legal|llp|p\.a\.)\b/i.test(company))
  ) {
    return veto('service_provider_or_intermediary');
  }

  if (looksLikePersonName(company) || looksLikePersonOrParticipantBundle(company) || VETO_SINGLE_PERSON_NAMES.has(normalized)) {
    return veto('person_or_participant_bundle');
  }

  if (/\b[A-Z][A-Za-z.'’ -]{1,40}['’]s\s+(?:florida\s+)?quantum\b/i.test(company)) {
    return veto('person_or_participant_bundle');
  }

  const directTargetAssertion = hasCurrentCompanyDirectTargetAssertion(contextText, company);

  if (isAttach && hasWeakKnownDealAttachContext(contextText, company)) {
    return veto('weak_known_deal_context_without_target_signal', 'record_context');
  }

  const attachReasoningSaysKnownDealTarget = isAttach &&
    /\b(?:known|existing)\s+(?:portfolio|deal)\s+(?:company|investment|structure|target)?\b|\bportfolio\s+company\b|\bknown\s+(?:deal\s+company|operating\s+entity)\b|\bexisting\s+(?:deal|portfolio\s+investment)\s+structure\b/i.test(contextHaystack);

  if (attachReasoningSaysKnownDealTarget) {
    return { applied: false, reason: null, confidence: null, nonValuableAction: null };
  }

  if (
    isCreate &&
    /\b(?:newsletter|digest|smartbrief|nvca|press\s+roundup|market\s+update|generated\s+meeting\s+summary)\b/i.test(contextHaystack) &&
    (/\b(?:reported|reporting|news|roundup|digest|only)\b/i.test(contextHaystack) || !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)) &&
    !/\b(?:introduced|introducing|warm intro|sent|shared|forwarded)\b[^.\n]{0,160}\b(?:deck|pitch|raise|raising|fundrais|investment opportunity)\b/i.test(contextText)
  ) {
    return veto('news_or_digest_only');
  }

  if (isCreate && /\bweekly\s+meeting\s+recap\b/i.test(contextHaystack) && /\b4degrees\b/i.test(contextHaystack)) {
    return veto('news_or_digest_only');
  }

  if (
    isCreate &&
    senderDomainCompanyMatches(contextText, company) &&
    hasDifferentPrimaryTargetEvidence(contextText, normalized) &&
    !directTargetAssertion &&
    !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    prospectCompanyPointsElsewhere &&
    (
      isCreate ||
      hasCurrentCompanyIntroSourceRole(contextText, company) ||
      hasCurrentCompanyInvestorBackingRole(contextText, company) ||
      hasCurrentCompanyCustomerPartnerRole(contextText, company) ||
      VETO_FUND_OR_LP_NAMES.has(normalized) ||
      VETO_PARTNER_CHANNEL_NAMES.has(normalized)
    )
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    hasCurrentCompanyIntroSourceRole(contextText, company) &&
    !directTargetAssertion &&
    !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)
  ) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (
    (hasCurrentCompanyInvestorParticipantRole(contextText, company) || hasCurrentCompanyInvestorBackingRole(contextText, company)) &&
    !(hasCurrentCompanyInvestorParticipantRole(contextText, company) && /\b(?:participant|attendee)\b/i.test(contextHaystack)) &&
    !directTargetAssertion &&
    !hasCurrentCompanyInvestmentTargetEvidence(contextText, company)
  ) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (hasCurrentCompanyInvestorParticipantRole(contextText, company) && /\b(?:participant|attendee)\b/i.test(contextHaystack)) {
    return veto('source_or_intro_entity_not_target', 'record_context');
  }

  if (
    hasCurrentCompanyCustomerPartnerRole(contextText, company) &&
    (isCreate || hasDifferentPrimaryTargetEvidence(contextText, normalized) || VETO_MAJOR_CUSTOMER_OR_BUYER_NAMES.has(normalized))
  ) {
    return veto('customer_partner_or_buyer_context', 'record_context');
  }

  if (isCreate && hasCurrentCompanyFundOrLpRole(contextText, company)) {
    return veto('lp_or_fund_context_not_prospect');
  }

  if (
    hasDifferentPrimaryTargetEvidence(contextText, normalized) &&
    !directTargetAssertion &&
    (
      hasCurrentCompanyIntroSourceRole(contextText, company) ||
      hasCurrentCompanyInvestorBackingRole(contextText, company) ||
      hasCurrentCompanyCustomerPartnerRole(contextText, company) ||
      (currentCompanyPattern(company) ? new RegExp(`\\bby\\s+${currentCompanyPattern(company)}\\b`, 'i').test(contextText) : false)
    )
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  if (
    /\b(?:merely|just|only)\s+(?:a\s+)?(?:video|link|host|venue|customer|deployment|source|advisor|broker|law|legal|meeting)\b/i.test(contextHaystack) ||
    /\b(?:not\s+(?:the|an)\s+(?:investment\s+)?(?:target|prospect)|not itself (?:an? )?investment prospect)\b/i.test(contextHaystack) ||
    hasDifferentActualTarget(contextText, normalized)
  ) {
    return veto('nearby_company_hallucination_or_non_target_role', 'record_context');
  }

  return { applied: false, reason: null, confidence: null, nonValuableAction: null };
}

function prospectCreateVetoForMention(input: ProspectCreateVetoInput): ProspectCreateVetoDecision {
  if (input.prospectAction !== 'create_prospect') {
    return { applied: false, reason: null, confidence: null };
  }
  const veto = prospectValuableActionVetoForMention(input);
  return { applied: veto.applied, reason: veto.reason, confidence: veto.confidence };
}

function parseSectorKey(value: unknown): SectorKey {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (PROSPECT_SECTOR_KEYS.has(normalized as any)) return normalized as SectorKey;
  throw new Error(`INVALID_LLM_SECTOR_KEY:${normalized || 'empty'}`);
}

function prospectSectorKeyFromCompanySector(value: unknown): { key: SectorKey; confidence: number } {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (PROSPECT_SECTOR_KEYS.has(normalized as any)) return { key: normalized as SectorKey, confidence: 0.8 };
  return { key: 'uncategorized', confidence: 0 };
}

function domainFromUrl(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function parseUnitConfidence(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`INVALID_LLM_${field.toUpperCase()}`);
  return n;
}

function productionSampleRate(env: Env): number {
  const n = Number(env.PROSPECT_PRODUCTION_SAMPLE_RATE);
  if (!Number.isFinite(n)) return DEFAULT_PROSPECT_PRODUCTION_SAMPLE_RATE;
  return clamp(n, 0, 1);
}

function stableSampleBucket(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function productionSamplingDecision(args: {
  orgId: string;
  item: ClassifiedItem;
  mention: MentionCandidate;
  confidenceTier: ConfidenceTier;
  directionUncertain: boolean;
  env: Env;
}): { sampled: boolean; reason: string | null } {
  if (args.directionUncertain) return { sampled: true, reason: 'direction_uncertain' };
  if (args.confidenceTier === 'medium') return { sampled: true, reason: 'medium_confidence' };
  if (args.confidenceTier === 'low') return { sampled: true, reason: 'low_confidence' };
  const key = `${args.orgId}:${args.item.entityType}:${args.item.entityId}:${args.mention.mentionOrdinal}:${PROSPECT_CLASSIFIER_VERSION}`;
  return stableSampleBucket(key) < productionSampleRate(args.env)
    ? { sampled: true, reason: 'random_live_sample' }
    : { sampled: false, reason: null };
}

export function extractMentionCandidatesFromText(text: string, fallbackName?: string | null, maxCandidates = 12): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  const { cleanedText } = cleanProspectSourceText(text);

  function push(raw: string, canonicalRaw: string, spanStart: number | null, isListEntry: boolean, listFields?: ParsedDealflowListFields): void {
    const { canonicalName, products } = canonicalizeMention(canonicalRaw);
    if (isGenericCandidate(canonicalName)) return;
    if (isOwnFundEntity(canonicalName)) return;
    if (looksLikePersonName(canonicalName)) return;
    const normalizedName = normalizeProspectName(canonicalName);
    if (!normalizedName || seen.has(normalizedName)) return;
    seen.add(normalizedName);
    const end = spanStart == null ? null : spanStart + raw.length;
    const contextText = prospectContextWindow(cleanedText, spanStart, end);
    candidates.push({
      raw,
      canonicalName,
      normalizedName,
      mentionOrdinal: 0,
      spanStart,
      spanEnd: end,
      lineText: spanStart == null ? canonicalName : lineExcerptAt(cleanedText, spanStart, end || spanStart),
      contextText,
      isListEntry,
      products,
      listFields,
    });
  }

  const pushTarget = (raw: string, indexHint = 0): void => {
    const clean = cleanPotentialCompanyName(raw)
      .replace(/\b([A-Z][A-Za-z0-9&.'’-]{2,})\s+\1\b/g, '$1');
    if (!clean || !/^[A-Z0-9]/.test(clean)) return;
    const start = findCaseInsensitive(cleanedText, raw, indexHint);
    push(raw, clean, start < 0 ? null : start, false);
  };

  const pushFieldTarget = (raw: string, indexHint = 0): void => {
    const clean = cleanPotentialCompanyName(raw)
      .replace(/\b([A-Z][A-Za-z0-9&.'’-]{2,})\s+\1\b/g, '$1');
    if (!clean || !/[A-Za-z]/.test(clean)) return;
    const canonical = /^[a-z]/.test(clean) ? clean[0].toUpperCase() + clean.slice(1) : clean;
    const start = findCaseInsensitive(cleanedText, raw, indexHint);
    push(raw, canonical, start < 0 ? null : start, false);
  };

  const leadLines = cleanedText.split(/\n+/).slice(0, 12);
  for (const line of leadLines) {
    const normalizedLine = normalizeWhitespace(line);
    const introParen = normalizedLine.match(/\b(?:intro(?:duction)?|meet|connecting|connect)\b[^()\n]{0,100}\(([^)]+)\)/i);
    if (introParen?.[1]) pushTarget(introParen[1], cleanedText.indexOf(line));
    const domainSubject = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([a-z0-9-]+\.(?:ai|com|io|co|vc|capital|org|net|health|tech|dev|finance|xyz))\b/i);
    if (domainSubject?.[1]) pushTarget(domainSubject[1], cleanedText.indexOf(line));
    const titleTarget = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s+(?:update|deck|demo|diligence|fundrais(?:e|ing)|series\s+[A-Z]|pitch|follow[-\s]?up|materials)\b/);
    if (titleTarget?.[1]) pushTarget(titleTarget[1], cleanedText.indexOf(line));
    const medinaPair = normalizedLine.match(/^(?:re|fw|fwd)?\s*:?\s*([A-Z0-9][A-Za-z0-9&.'’/-]+(?:\s+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,4})\s*(?:<>|<->|x|\/)\s*Medina\b/i);
    if (medinaPair?.[1]) pushTarget(medinaPair[1], cleanedText.indexOf(line));
    if (candidates.length >= maxCandidates) break;
  }

  for (const match of cleanedText.matchAll(/\bCompany[ \t]+Name[ \t]+([A-Za-z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Za-z0-9][A-Za-z0-9&.'’/-]+){0,5})(?=[ \t]+(?:Company[ \t]+URL|Founder(?:s|\(s\))?|Short[ \t]+Description|Location|Industry|Round[ \t]+Stage)\b)/gi)) {
    pushFieldTarget(match[1] || '', match.index || 0);
    if (candidates.length >= maxCandidates) break;
  }

  for (const match of cleanedText.matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:ai|com|io|co|vc|capital|org|net|gov|mil|edu|health|tech|dev|finance|xyz))\b/gi)) {
    const domain = match[1].toLowerCase();
    if (shouldIgnoreDomain(domain)) continue;
    const raw = match[0];
    push(raw, domainLabelToCompany(domain), match.index ?? null, false);
    if (candidates.length >= maxCandidates) break;
  }

  const highSignalPatterns = [
    /^(?:[-*•]|\d+[.)])?[ \t]*([A-Z][A-Za-z0-9&.'’-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’-]+){0,3}(?:[ \t]*\/[ \t]*[A-Z][A-Za-z0-9&.'’-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’-]+){0,3})+)(?:[ \t]*(?:[-—–:|,]|\(|$))/gm,
    /\bAbout[ \t]+([A-Z0-9][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z0-9][A-Za-z0-9&.'’/-]+){0,5})(?=[ \t]+(?:is|has|have|helps|offers|builds|develops|developed|provides|raised|raises|will|was|the|a|an)\b)/g,
    /\b(?:intro(?:ducing)?|meet|warm intro to|introduction to)[ \t]+(?:to[ \t]+|for[ \t]+)?([A-Z][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’/-]+){0,4})\b/gi,
    /\b([A-Z][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’/-]+){0,4})[ \t]+(?:is|are|has|have)[ \t]+(?:raising|building|launching|looking|seeking|developing)\b/g,
    /\b(?:deck|memo|diligence|investment|demo|pilot)[ \t]+(?:for|from|with)[ \t]+([A-Z][A-Za-z0-9&.'’/-]+(?:[ \t]+[A-Z][A-Za-z0-9&.'’/-]+){0,4})\b/gi,
  ];
  for (const pattern of highSignalPatterns) {
    for (const match of cleanedText.matchAll(pattern)) {
      const raw = normalizeWhitespace(match[1] || '');
      if (!raw) continue;
      if (!/^[A-Z0-9]/.test(raw)) continue;
      const start = findCaseInsensitive(cleanedText, raw, match.index || 0);
      push(raw, raw, start < 0 ? null : start, false);
      if (candidates.length >= maxCandidates) break;
    }
    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length === 0 && fallbackName && !isOwnFundEntity(fallbackName)) {
    push(fallbackName, fallbackName, null, false);
  }

  return candidates
    .sort((a, b) => (a.spanStart ?? Number.MAX_SAFE_INTEGER) - (b.spanStart ?? Number.MAX_SAFE_INTEGER))
    .map((candidate, index) => ({ ...candidate, mentionOrdinal: index + 1 }));
}

function isDealflowListText(text: string): boolean {
  const listLines = text
    .split(/\n+/)
    .filter(line => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line) && /[A-Z][A-Za-z0-9&.'’/-]+/.test(line));
  if (listLines.length >= 3) return true;
  return /\b(armyfuze|cohort|batch|portfolio day|demo day|dealflow list|companies below|shortlist)\b/i.test(text) && listLines.length >= 2;
}

function fieldAfter(label: string, line: string): string | null {
  const match = line.match(new RegExp(`\\b(?:${label})\\s*[:=-]\\s*([^|;]+)`, 'i'));
  return match ? normalizeWhitespace(match[1]).slice(0, 160) : null;
}

function parseListFields(line: string): ParsedDealflowListFields {
  const amount = line.match(/\$[0-9][0-9.,]*(?:\s?(?:k|m|mm|million|b))?/i)?.[0] || null;
  const website = domainInText(line);
  const poc = emailInText(line) || fieldAfter('poc|contact|founder', line);
  const stage = line.match(/\b(pre[-\s]?seed|seed|series\s+[abc]|growth|pilot|pre[-\s]?revenue)\b/i)?.[0] || null;
  return {
    stage,
    amount,
    website,
    poc,
    problem: fieldAfter('problem', line),
    approach: fieldAfter('approach|solution', line),
  };
}

export function parseDealflowList(text: string, fallbackName?: string | null): MentionCandidate[] {
  if (!isDealflowListText(text)) {
    return extractMentionCandidatesFromText(text, fallbackName);
  }
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  let ordinal = 1;
  let offset = 0;
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    const isListEntry = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    if (!isListEntry) {
      offset += line.length + 1;
      continue;
    }
    const name = trimmed.match(/^(?:[-*•]|\d+[.)])\s*([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z][A-Za-z0-9&.'’/-]+){0,4})(?:\s*(?:[-—–:|,]|\s\/\s|\(|$))/)?.[1];
    if (!name) {
      offset += line.length + 1;
      continue;
    }
    const { canonicalName, products } = canonicalizeMention(name);
    const normalizedName = normalizeProspectName(canonicalName);
    if (!normalizedName || seen.has(normalizedName) || isGenericCandidate(canonicalName) || isOwnFundEntity(canonicalName) || looksLikePersonName(canonicalName)) {
      offset += line.length + 1;
      continue;
    }
    seen.add(normalizedName);
    const localIndex = line.indexOf(name);
    const spanStart = localIndex < 0 ? null : offset + localIndex;
    const spanEnd = spanStart == null ? null : spanStart + name.length;
    candidates.push({
      raw: name,
      canonicalName,
      normalizedName,
      mentionOrdinal: ordinal++,
      spanStart,
      spanEnd,
      lineText: line.slice(0, 500),
      contextText: prospectContextWindow(text, spanStart, spanEnd),
      isListEntry: true,
      products,
      listFields: parseListFields(line),
    });
    offset += line.length + 1;
  }
  if (candidates.length === 0 && fallbackName) {
    return extractMentionCandidatesFromText(text, fallbackName);
  }
  return candidates;
}

function mentionFromAnchoredRaw(
  cleanedText: string,
  raw: string,
  canonicalRaw: string,
  spanStart: number | null,
  isListEntry: boolean,
  listFields?: ParsedDealflowListFields
): MentionCandidate | null {
  const { canonicalName, products } = canonicalizeMention(canonicalRaw);
  if (isGenericCandidate(canonicalName) || isOwnFundEntity(canonicalName)) return null;
  if (looksLikePersonName(canonicalName)) return null;
  const normalizedName = normalizeProspectName(canonicalName);
  if (!normalizedName) return null;
  const spanEnd = spanStart == null ? null : spanStart + raw.length;
  return {
    raw,
    canonicalName,
    normalizedName,
    mentionOrdinal: 0,
    spanStart,
    spanEnd,
    lineText: spanStart == null ? canonicalName : lineExcerptAt(cleanedText, spanStart, spanEnd || spanStart),
    contextText: prospectContextWindow(cleanedText, spanStart, spanEnd),
    isListEntry,
    products,
    listFields,
  };
}

function sourceTextForOrgExtraction(item: ClassifiedItem): string {
  return [
    item.subject || '',
    item.bodyText || '',
    item.text || '',
  ].filter(Boolean).join('\n');
}

function sourceContextForOrgExtraction(item: ClassifiedItem): string {
  const parts = [
    `source_type: ${sourceTypeForPrompt(item)}`,
    item.fromName || item.fromEmail ? `from: ${normalizeWhitespace(`${item.fromName || ''} ${item.fromEmail || ''}`)}` : '',
    item.subject ? `subject: ${item.subject}` : '',
    item.toEmails?.length ? `to: ${item.toEmails.slice(0, 8).join(', ')}` : '',
    item.ccEmails?.length ? `cc: ${item.ccEmails.slice(0, 8).join(', ')}` : '',
    item.direction ? `source direction field: ${item.direction}` : '',
  ].filter(Boolean);
  return compactClassifierText(parts.join(' | '), 900);
}

function shouldRunOrgExtractionLlm(cleanedText: string, deterministicMentionCount: number): boolean {
  const compact = normalizeWhitespace(cleanedText);
  if (compact.length < 40) return false;
  if (!/[A-Z][A-Za-z0-9&.'’-]{2,}/.test(cleanedText)) return false;
  if (/^(?:sent|from|to|cc|subject|date|fwd|re)\b/i.test(compact)) return false;
  if (deterministicMentionCount > 0 && !/\b(?:also|with|from|including|includes|customer|vendor|partner|law firm|counsel|accelerator|cohort|portfolio|introduced by|via)\b/i.test(compact)) {
    return false;
  }
  return true;
}

function anchorLlmOrganization(cleanedText: string, org: ProspectOrgExtractionLlmOutput): { raw: string; canonicalRaw: string; spanStart: number } | null {
  const candidates = [
    typeof org.raw === 'string' ? normalizeWhitespace(org.raw) : '',
    normalizeWhitespace(org.name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const start = findCaseInsensitive(cleanedText, candidate);
    if (start >= 0) return { raw: cleanedText.slice(start, start + candidate.length), canonicalRaw: org.name, spanStart: start };
  }
  return null;
}

function addMentionCandidate(target: Map<string, MentionCandidate>, candidate: MentionCandidate | null): void {
  if (!candidate) return;
  const existing = target.get(candidate.normalizedName);
  if (!existing) {
    target.set(candidate.normalizedName, candidate);
    return;
  }
  const existingStart = existing.spanStart ?? Number.MAX_SAFE_INTEGER;
  const nextStart = candidate.spanStart ?? Number.MAX_SAFE_INTEGER;
  if (nextStart < existingStart) target.set(candidate.normalizedName, candidate);
}

function renumberMentionCandidates(candidates: MentionCandidate[]): MentionCandidate[] {
  return candidates
    .sort((a, b) => (a.spanStart ?? Number.MAX_SAFE_INTEGER) - (b.spanStart ?? Number.MAX_SAFE_INTEGER))
    .map((candidate, index) => ({ ...candidate, mentionOrdinal: index + 1 }));
}

function addKnownContextMentions(
  mentions: Map<string, MentionCandidate>,
  cleanedText: string,
  knownContext: ProspectClassifierKnownContext | undefined,
  env: Env
): void {
  if (!knownContext) return;
  for (const entity of knownContext.knownDeals) {
    const name = normalizeWhitespace(entity.name || '');
    if (name) {
      const start = findCaseInsensitive(cleanedText, name);
      if (start >= 0) addMentionCandidate(mentions, mentionFromAnchoredRaw(cleanedText, cleanedText.slice(start, start + name.length), name, start, false));
    }
    const domain = String(entity.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (domain && !shouldIgnoreDomain(domain, env)) {
      const start = findCaseInsensitive(cleanedText, domain);
      if (start >= 0) addMentionCandidate(mentions, mentionFromAnchoredRaw(cleanedText, cleanedText.slice(start, start + domain.length), name || domainLabelToCompany(domain), start, false));
    }
  }
  for (const entity of knownContext.knownDealmakers) {
    const domain = String(entity.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (!domain || shouldIgnoreDomain(domain, env)) continue;
    const start = findCaseInsensitive(cleanedText, domain);
    if (start >= 0) addMentionCandidate(mentions, mentionFromAnchoredRaw(cleanedText, cleanedText.slice(start, start + domain.length), domainLabelToCompany(domain), start, false));
  }
}

export async function extractOrganizationMentionsFromSource(
  item: ClassifiedItem,
  orgId: string,
  env: Env,
  options: ProspectOrganizationExtractionOptions = {}
): Promise<MentionCandidate[]> {
  const rawText = sourceTextForOrgExtraction(item);
  const { cleanedText } = cleanProspectSourceText(rawText);
  if (!cleanedText) return [];

  const mentions = new Map<string, MentionCandidate>();
  if (isDealflowListText(cleanedText)) {
    for (const mention of parseDealflowList(cleanedText, options.fallbackName)) {
      addMentionCandidate(mentions, { ...mention, mentionOrdinal: 0 });
    }
  }
  for (const mention of extractMentionCandidatesFromText(cleanedText, options.fallbackName, 24)) {
    addMentionCandidate(mentions, { ...mention, mentionOrdinal: 0 });
  }
  addKnownContextMentions(mentions, cleanedText, options.knownContext, env);

  if (options.allowLlm !== false && (options.forceLlm || shouldRunOrgExtractionLlm(cleanedText, mentions.size))) {
    const llmExtract = options.llmExtractor || ((input: ProspectOrgExtractionLlmInput) => defaultLlmExtractOrganizations(input, env));
    const llmRows = await llmExtract({
      cleanedText,
      sourceContext: sourceContextForOrgExtraction(item),
      orgId,
    });
    for (const org of llmRows.slice(0, options.maxLlmOrganizations || 24)) {
      if (isOwnFundEntity(org.name)) continue;
      const anchored = anchorLlmOrganization(cleanedText, org);
      if (!anchored) continue;
      addMentionCandidate(mentions, mentionFromAnchoredRaw(
        cleanedText,
        anchored.raw,
        anchored.canonicalRaw,
        anchored.spanStart,
        false
      ));
    }
  }

  return renumberMentionCandidates([...mentions.values()]);
}

async function companyNameFor(id: string | undefined, orgId: string, env: Env): Promise<string | null> {
  if (!id) return null;
  const row = await env.D1.prepare(
    `SELECT name FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(id, orgId).first<{ name: string }>();
  return row?.name || null;
}

async function lookupExistingContext(
  mention: MentionCandidate,
  item: ClassifiedItem,
  orgId: string,
  env: Env
): Promise<ExistingContext> {
  const candidates: Array<{ id: string; name: string; domain: string | null; is_internal_entity: number | null }> = [];
  const mentionDomain = domainFromMention(item, mention);

  if (item.companyId) {
    const direct = await env.D1.prepare(
      `SELECT id, name, domain, is_internal_entity
         FROM companies
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(item.companyId, orgId).first<{ id: string; name: string; domain: string | null; is_internal_entity: number | null }>();
    if (direct) candidates.push(direct);
  }

  if (mentionDomain) {
    const byDomain = await env.D1.prepare(
      `SELECT id, name, domain, is_internal_entity
         FROM companies
        WHERE org_id = ? AND deleted_at IS NULL AND lower(domain) = lower(?)
        LIMIT 1`
    ).bind(orgId, mentionDomain).first<{ id: string; name: string; domain: string | null; is_internal_entity: number | null }>();
    if (byDomain) candidates.push(byDomain);
  }

  const token = mention.canonicalName.split(/\s+/)[0]?.toLowerCase();
  if (token && token.length >= 3) {
    const rows = await env.D1.prepare(
      `SELECT id, name, domain, is_internal_entity
         FROM companies
        WHERE org_id = ? AND deleted_at IS NULL AND lower(name) LIKE ?
        LIMIT 25`
    ).bind(orgId, `%${token}%`).all<{ id: string; name: string; domain: string | null; is_internal_entity: number | null }>();
    candidates.push(...rows.results);
  }

  const deduped = new Map(candidates.map(c => [c.id, c]));
  const allCandidates = Array.from(deduped.values());
  const domainMatch = mentionDomain
    ? allCandidates.find(c => c.domain && c.domain.toLowerCase() === mentionDomain)
    : null;
  const nameMatch = allCandidates.find(c => normalizeProspectName(c.name) === mention.normalizedName);
  const match = domainMatch || nameMatch;
  if (!match) return { companyId: null, dealId: null, companyDomain: mentionDomain, relationshipStates: [], isInternal: false, matchStrength: 'none' };

  const relationships = await env.D1.prepare(
    `SELECT relationship_state
       FROM firm_company_relationships
      WHERE org_id = ? AND company_id = ? AND ended_at IS NULL`
  ).bind(orgId, match.id).all<{ relationship_state: string }>().catch(() => ({ results: [] as Array<{ relationship_state: string }> }));

  const deal = await env.D1.prepare(
    `SELECT id
       FROM deals
      WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL AND stage != 'closed'
      LIMIT 1`
  ).bind(orgId, match.id).first<{ id: string }>();

  return {
    companyId: match.id,
    dealId: deal?.id || null,
    companyDomain: match.domain || mentionDomain || null,
    relationshipStates: relationships.results.map(r => r.relationship_state),
    isInternal: match.is_internal_entity === 1,
    matchStrength: item.companyId === match.id ? 'company_id' : domainMatch ? 'domain' : 'name',
  };
}

export function emptyProspectClassifierKnownContext(): ProspectClassifierKnownContext {
  return { knownDeals: [], knownDealmakers: [] };
}

function entityListForPrompt(rows: ProspectClassifierKnownEntity[]): string {
  if (rows.length === 0) return '(none)';
  return rows
    .slice(0, 200)
    .map(row => row.domain ? `${row.name} <${row.domain}>` : row.name)
    .join('; ');
}

export async function loadProspectClassifierKnownContext(orgId: string, env: Env): Promise<ProspectClassifierKnownContext> {
  const [dealRows, dealmakerRows] = await Promise.all([
    env.D1.prepare(
      `SELECT DISTINCT c.name, c.domain
         FROM companies c
         LEFT JOIN deals d
           ON d.org_id = c.org_id
          AND d.company_id = c.id
          AND d.deleted_at IS NULL
          AND d.stage != 'closed'
         LEFT JOIN firm_company_relationships f
           ON f.org_id = c.org_id
          AND f.company_id = c.id
          AND f.ended_at IS NULL
          AND f.relationship_state IN ('current_portfolio','active_pipeline','exited')
        WHERE c.org_id = ? AND c.deleted_at IS NULL
          AND (d.id IS NOT NULL OR f.company_id IS NOT NULL)
        ORDER BY lower(c.name)
        LIMIT 250`
    ).bind(orgId).all<{ name: string; domain: string | null }>(),
    env.D1.prepare(
      `SELECT name,
              CASE
                WHEN domain IS NOT NULL AND trim(domain) != '' THEN lower(domain)
                WHEN normalized_email IS NOT NULL AND instr(normalized_email, '@') > 0
                THEN lower(substr(normalized_email, instr(normalized_email, '@') + 1))
                ELSE NULL
              END AS domain
         FROM dealmakers
        WHERE org_id = ? AND name IS NOT NULL AND trim(name) != ''
        ORDER BY last_seen_at DESC NULLS LAST, lower(name)
        LIMIT 250`
    ).bind(orgId).all<{ name: string; domain: string | null }>(),
  ]);

  return {
    knownDeals: (dealRows.results || []).map(row => ({ name: row.name, domain: row.domain })),
    knownDealmakers: (dealmakerRows.results || []).map(row => ({ name: row.name, domain: row.domain })),
  };
}

function emailInText(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function domainInText(text: string): string | null {
  const email = emailInText(text);
  if (email) return emailDomain(email);
  const match = text.match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function domainFromMention(item: ClassifiedItem, mention: MentionCandidate): string | null {
  return domainInText(`${mention.contextText || mention.lineText}\n${item.bodyPreview || ''}\n${item.bodyText || ''}`);
}

async function upsertDealmakerIdentity(
  orgId: string,
  input: { name: string | null; email?: string | null; domain?: string | null },
  occurredAt: string,
  env: Env
): Promise<{ id: string | null; name: string | null }> {
  const name = normalizeWhitespace(input.name || input.email || input.domain || '');
  if (!name) return { id: null, name: null };
  const normalizedEmail = input.email?.trim().toLowerCase() || null;
  const normalizedName = normalizeProspectName(name);
  const domain = (input.domain || (normalizedEmail ? emailDomain(normalizedEmail) : null) || '').trim().toLowerCase() || null;

  const existing = normalizedEmail
    ? await env.D1.prepare(
      `SELECT id, name FROM dealmakers WHERE org_id = ? AND normalized_email = ? LIMIT 1`
    ).bind(orgId, normalizedEmail).first<{ id: string; name: string | null }>()
    : await env.D1.prepare(
      `SELECT id, name FROM dealmakers
        WHERE org_id = ? AND normalized_email IS NULL AND normalized_name = ?
        LIMIT 1`
    ).bind(orgId, normalizedName).first<{ id: string; name: string | null }>();

  if (existing?.id) {
    await env.D1.prepare(
      `UPDATE dealmakers
          SET name = COALESCE(?, name),
              normalized_name = COALESCE(?, normalized_name),
              domain = COALESCE(?, domain),
              last_seen_at = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(name, normalizedName || null, domain, occurredAt, existing.id, orgId).run();
    return { id: existing.id, name: existing.name || name };
  }

  await env.D1.prepare(
    `INSERT INTO dealmakers
       (id, org_id, name, email, normalized_email, normalized_name, domain, warmth_level, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'warm', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(crypto.randomUUID(), orgId, name, normalizedEmail, normalizedEmail, normalizedName || null, domain, occurredAt, occurredAt).run();

  const row = normalizedEmail
    ? await env.D1.prepare(
      `SELECT id, name FROM dealmakers WHERE org_id = ? AND normalized_email = ? LIMIT 1`
    ).bind(orgId, normalizedEmail).first<{ id: string; name: string | null }>()
    : await env.D1.prepare(
      `SELECT id, name FROM dealmakers
        WHERE org_id = ? AND normalized_email IS NULL AND normalized_name = ?
        ORDER BY created_at DESC LIMIT 1`
    ).bind(orgId, normalizedName).first<{ id: string; name: string | null }>();
  return { id: row?.id || null, name: row?.name || name };
}

async function upsertSenderDealmaker(item: ClassifiedItem, orgId: string, occurredAt: string, env: Env): Promise<{ id: string | null; name: string | null }> {
  const fromEmail = item.fromEmail?.trim().toLowerCase() || '';
  const internalDomains = getConfiguredInternalDomains(env);
  if (!fromEmail || isInternalEmailDomain(fromEmail, internalDomains)) {
    return { id: null, name: null };
  }
  return upsertDealmakerIdentity(
    orgId,
    { name: item.fromName || fromEmail, email: fromEmail, domain: emailDomain(fromEmail) },
    occurredAt,
    env
  );
}

async function upsertMentionDealmaker(
  item: ClassifiedItem,
  mention: MentionCandidate,
  orgId: string,
  occurredAt: string,
  env: Env
): Promise<{ id: string | null; name: string | null }> {
  const lineEmail = emailInText(mention.lineText);
  const lineDomain = domainInText(mention.lineText);
  return upsertDealmakerIdentity(
    orgId,
    { name: mention.canonicalName, email: lineEmail, domain: lineDomain },
    occurredAt,
    env
  );
}

function buildClassifierPrefilter(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  env: Env
): ClassifierPrefilter {
  const deterministicDirection = inferDirection(item, env, existing.companyDomain || domainFromMention(item, mention));
  const newsletter = isNewsletterLike(item);
  const hasDeck = hasDeckSignal(item);
  const hasMeeting = hasMeetingSignal(item);
  const hasWarmIntro = isWarmIntroSignal(item, mention);
  const signalKind = signalKindFor(item, mention, hasDeck, hasMeeting);
  const sectorHint = sectorHintForText(`${mention.canonicalName}\n${mention.contextText || mention.lineText}\n${item.subject || ''}\n${item.bodyPreview || ''}`);
  const confidenceHint = confidenceFor(signalKind, deterministicDirection, newsletter);
  const reasons: string[] = [];
  if (newsletter) reasons.push('newsletter_like_source');
  if (existing.isInternal) reasons.push('matched_internal_company');
  if (existing.relationshipStates.includes('current_portfolio') || existing.relationshipStates.includes('exited')) reasons.push('portfolio_relationship_match');
  if (existing.dealId) reasons.push(existing.matchStrength === 'company_id' ? 'direct_existing_deal_match' : 'soft_existing_deal_match');
  if (hasDeck) reasons.push('deck_signal');
  if (hasMeeting) reasons.push('meeting_or_call_signal');
  if (hasWarmIntro) reasons.push('warm_intro_language');
  if (mention.isListEntry) reasons.push('list_entry_shape');
  if (signalKind === 'cold_mention') reasons.push('cold_mention_shape');

  return {
    shouldClassify: Boolean(mention.normalizedName && mention.normalizedName.length >= 3),
    reasons,
    deterministicDirection,
    newsletterLikely: newsletter,
    hasDeck,
    hasMeeting,
    hasWarmIntro,
    signalKind,
    sectorHint,
    confidenceHint,
  };
}

function sourcePrefilter(item: ClassifiedItem, env: Env): { shouldScan: boolean; reasons: string[] } {
  const from = `${item.fromEmail || ''} ${item.fromName || ''}`.toLowerCase();
  const subject = (item.subject || '').toLowerCase();
  const body = `${item.bodyPreview || ''}\n${item.bodyText || ''}\n${item.text || ''}`.toLowerCase();
  const haystack = `${from}\n${subject}\n${body}`;
  const allowSignals = [
    /\b(intro|introduc|deal\s?flow|pitch deck|deck attached|cim|teaser|data room|raising|fundraise|series [abc]|seed round|demo day|armyfuze)\b/,
    /#dealflow-pipeline/i,
  ];
  if (allowSignals.some(re => re.test(haystack))) {
    return { shouldScan: true, reasons: ['dealflow_allow_signal'] };
  }
  if (hasDeckSignal(item) || isDealflowListText(`${item.subject || ''}\n${item.bodyText || ''}\n${item.text || ''}`)) {
    return { shouldScan: true, reasons: ['deck_or_list_allow_signal'] };
  }
  const dropChecks: Array<[RegExp, string]> = [
    [/\b(invoice|receipt|bill|billing|payment due|statement)\b/, 'billing_or_invoice'],
    [/\b(fund admin|capital call|tax document|k-1|schedule k|trustserve|ramp)\b/, 'fund_admin_or_expense'],
    [/\b(counsel|legal notice|engagement letter|gtlaw\.com)\b/, 'legal_or_counsel'],
    [/\b(website visit|visitors?|analytics|utm_|page views?|services@)\b/, 'web_analytics_summary'],
    [/\b(4th grade|school trip|birthday|dinner reservation|personal)\b/, 'personal_or_family'],
  ];
  const matched = dropChecks.find(([re]) => re.test(haystack));
  if (matched) return { shouldScan: false, reasons: [matched[1]] };

  const internalDomains = getConfiguredInternalDomains(env);
  if (item.type === 'slack_message' && !/#dealflow-pipeline/i.test(`${item.subject || ''}\n${item.bodyText || ''}`)) {
    return { shouldScan: true, reasons: ['slack_internal_pass_to_classifier'] };
  }
  if (item.fromEmail && isInternalEmailDomain(item.fromEmail, internalDomains) && /\b(customer|bd|sales|partnership)\b/.test(haystack)) {
    return { shouldScan: true, reasons: ['outbound_bd_pass_to_classifier'] };
  }
  return { shouldScan: true, reasons: [] };
}

function sourceTypeForPrompt(item: ClassifiedItem): string {
  if (item.type === 'email') return 'email';
  if (item.type === 'slack_message') return 'Slack';
  if (item.type === 'calendar_event') return 'meeting';
  if (item.type === 'news') return 'news';
  return item.entityType;
}

function senderAndContextForPrompt(item: ClassifiedItem, existing: ExistingContext): string {
  const parts = [
    item.fromName || item.fromEmail ? `from ${normalizeWhitespace(`${item.fromName || ''} ${item.fromEmail || ''}`)}` : '',
    item.subject ? `subject: ${item.subject}` : '',
    item.toEmails?.length ? `to: ${item.toEmails.slice(0, 8).join(', ')}` : '',
    item.ccEmails?.length ? `cc: ${item.ccEmails.slice(0, 8).join(', ')}` : '',
    item.direction ? `source direction field: ${item.direction}` : '',
    existing.relationshipStates.length ? `matched firm relationship states: ${existing.relationshipStates.join(', ')}` : '',
    existing.dealId ? `matched existing deal id: ${existing.dealId}` : '',
    existing.companyId ? `matched company id: ${existing.companyId}` : '',
    existing.companyDomain ? `matched company domain: ${existing.companyDomain}` : '',
  ].filter(Boolean);
  return compactClassifierText(parts.join(' | '), 900);
}

function rawExcerptForPrompt(item: ClassifiedItem, mention: MentionCandidate): string {
  const sourceContext = mention.contextText || mention.lineText || item.bodyText || item.text || '';
  const promptAnchor = findCaseInsensitive(sourceContext, mention.raw) >= 0
    ? findCaseInsensitive(sourceContext, mention.raw)
    : findCaseInsensitive(sourceContext, mention.canonicalName);
  const mentionContext = promptAnchor >= 0
    ? prospectContextWindow(sourceContext, promptAnchor, promptAnchor + (mention.raw || mention.canonicalName).length, 3000)
    : sourceContext;
  const preview = item.bodyPreview && !mentionContext.includes(item.bodyPreview)
    ? `Preview: ${item.bodyPreview}`
    : '';
  const excerpt = [
    item.subject ? `Subject: ${item.subject}` : '',
    mention.lineText ? `Mention line: ${mention.lineText}` : '',
    mentionContext ? `Mention context:\n${mentionContext}` : '',
    preview,
  ].filter(Boolean).join('\n');
  return compactClassifierText(excerpt, 3500);
}

function classifierInputForRuntime(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  prefilter: ClassifierPrefilter,
  knownContext: ProspectClassifierKnownContext,
  orgId: string
): ProspectClassifierInput {
  return {
    sourceType: sourceTypeForPrompt(item),
    senderAndContext: senderAndContextForPrompt(item, existing),
    companyName: mention.canonicalName,
    rawExcerpt: rawExcerptForPrompt(item, mention),
    knownContext,
    orgId,
    sectorHints: prefilter.sectorHint,
    prefilterHints: {
      should_classify: prefilter.shouldClassify,
      reasons: prefilter.reasons,
      deterministic_direction: prefilter.deterministicDirection,
      newsletter_likely: prefilter.newsletterLikely,
      signal_kind_hint: prefilter.signalKind,
      has_deck: prefilter.hasDeck,
      has_meeting_or_call: prefilter.hasMeeting,
      has_warm_intro_language: prefilter.hasWarmIntro,
      sector_hint: prefilter.sectorHint,
      confidence_hint: prefilter.confidenceHint,
      mention: {
        raw: mention.raw,
        normalized_name: mention.normalizedName,
        is_list_entry: mention.isListEntry,
        products: mention.products,
        parse_dealflow_list: Boolean(mention.listFields),
        list_fields: mention.listFields || null,
      },
      crm_context: {
        matched_company_id: existing.companyId,
        matched_open_deal_id: existing.dealId,
        matched_company_domain: existing.companyDomain,
        relationship_states: existing.relationshipStates,
        matched_internal_company: existing.isInternal,
        match_strength: existing.matchStrength,
      },
    },
  };
}

function buildProspectClassifierPrompt(input: ProspectClassifierInput): { system: string; systemForApi: ClaudeSystemPrompt; user: string } {
  const knownDeals = entityListForPrompt(input.knownContext.knownDeals);
  const knownDealmakers = entityListForPrompt(input.knownContext.knownDealmakers);
  const prefilterHints = JSON.stringify(input.prefilterHints);
  const sectorHints = JSON.stringify(input.sectorHints);

  const staticSystem = `You classify one company-mention extracted from a single source item (an email, Slack
message, meeting-transcript chunk, or document) for Medina Ventures, a venture capital
firm. You output strict JSON and nothing else.

Fund context -- for SECTOR judgment only, NEVER for deciding whether something is a
prospect: Medina Ventures invests at seed and Series A in enterprise and government
backend software -- AI, quantum, and cybersecurity.

CRITICAL: Thesis fit does NOT determine prospect status. A company that is off-thesis
(consumer, hardware, defense hardware, etc.) is STILL an inbound_prospect if it is being
presented to the fund as an investment opportunity. Never downgrade or drop a prospect
for being off-thesis. Sector is captured separately.

Choose exactly one prospect_action. This is the only model-facing action bucket:

  create_prospect       -- MENTION is the startup/company being newly presented to the
                           fund as an investment opportunity and should become a canonical
                           prospect counted in deal-flow aggregates. The MENTION itself
                           must be the target company, not a nearby heading, filename, person,
                           participant bundle, intro source, investor, advisor, or customer.
                           "MENTION" means the company shown in the MENTION field below, not
                           the email sender. If a broker or source presents Company X and
                           the MENTION is Company X, classify Company X as create_prospect.
  attach_existing_deal  -- MENTION is an existing deal/portfolio company. Do not create a
                           prospect; deterministic firewall logic will attach if safe.
  record_context        -- MENTION is useful dealflow context but is not itself the company
                           to count: intro source, accelerator/channel, investor/advisor,
                           customer/partner, relationship org, meeting participant, or a
                           weak signal worth retaining without creating a prospect.
  ignore                -- admin/vendor/legal/billing/personal noise, public news only,
                           website analytics, auth notices, calendar/link scaffolding, or
                           ordinary background with no useful dealflow value. Also ignore
                           extracted document outline labels, markup/schema/CSS artifacts,
                           and generic fragments that are not organization names.

Never encode the reason as a separate category. If in doubt between relationship vs meeting
vs intro vs customer context, choose record_context. If in doubt between news/web analytics/
admin/vendor noise, choose ignore.

prospect_company_name -- the canonical prospect company name when prospect_action is
create_prospect; otherwise null. Never put a nearby company here unless the MENTION itself
is that company. If the source clearly pitches Company B but the MENTION is the sender,
broker, VC, investor, accelerator, customer, standard, university, accounting firm, or
participant, do NOT repair it by setting prospect_company_name to Company B. Classify the
MENTION as record_context or ignore; the extraction layer must emit Company B separately.

False-positive traps to avoid:
  - A filename or attachment title is not the company unless the stem itself is clearly the
    company name.
  - Section headings like "Company Overview", "What They Do", "Why Now", "Problem",
    "Solution", "Market", "Traction", "Team", and "Risks" are not companies.
  - A person, slash/comma/plus/ampersand joined participant list, or "person of company"
    phrase is not a prospect company.
  - Intro sources, investors, VCs, advisors, customers, partners, accelerators, channels,
    and government/buyer entities are context unless they themselves are the company being
    pitched as the investment target.
  - A sender/broker/advisor presenting a deal is not the deal. If Ligo/Lazard/Ascendo-like
    context says another company is being pitched, the sender/broker/advisor mention is
    record_context or ignore. But when the MENTION field is the company being pitched by
    that sender/broker/advisor, classify that company as create_prospect.
  - A backer/investor in a subject line ("backed by X", "led by X", "investors include X")
    is not the target company.
  - For known-deal attachment, attach only when the MENTION is the existing deal/portfolio
    company itself. Customers, design partners, standards bodies, accounting/advisory firms,
    universities, research labs, and team members mentioned around a known deal are not
    attach_existing_deal.
  - Generated meeting summaries (for example Fireflies/meeting-summary emails) may contain
    copied or duplicate evidence; classify the actual target company only, not every named
    participant or source in the summary.

direction -- choose exactly one:
  inbound   -- an external party is presenting a company to the fund.
  outbound  -- the fund is reaching out (e.g., pitching a portfolio company to a customer).
  internal  -- fund-internal communication.
  news      -- informational, no pitch.

sector_key -- choose exactly one by the company's PRIMARY value proposition; if genuinely
unclear, "uncategorized":
  ${PROSPECT_SECTOR_LABELS}
Also output sector_confidence in [0,1].

Rubric examples (sanitized; apply as rules, not source facts):
Auguria with intro + deck -> {"prospect_action":"create_prospect","prospect_company_name":"Auguria","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Introduced as an investment opportunity with a deck."}
Qunnect pitched to Mastercard -> {"prospect_action":"attach_existing_deal","prospect_company_name":null,"direction":"outbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.95,"reasoning":"Known portfolio/deal company being pitched outbound."}
Mastercard in the Qunnect customer thread -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"outbound","sector_key":"fintech","sector_confidence":0.75,"confidence":0.9,"reasoning":"Commercial customer target, useful context but not an investment prospect."}
Fifth Wall in a subject saying a different company is backed by Fifth Wall -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.3,"confidence":0.92,"reasoning":"Investor/backer context, not the company being pitched."}
Lazard presenting Universal Quantum -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.3,"confidence":0.9,"reasoning":"Intermediary presenting another company as the opportunity."}
Universal Quantum in a Lazard-presented pitch -> {"prospect_action":"create_prospect","prospect_company_name":"Universal Quantum","direction":"inbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.94,"reasoning":"The mention itself is the company being presented as an investment opportunity."}
KSDT in an internal diligence meeting for another company -> {"prospect_action":"ignore","prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.92,"reasoning":"Accounting/advisory participant, not the deal company."}
DIU sending ArmyFUZE deal flow -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Government channel forwarding deal flow."}
Sativa hempcrete in an ArmyFUZE list -> {"prospect_action":"create_prospect","prospect_company_name":"Sativa","direction":"inbound","sector_key":"materials_manufacturing","sector_confidence":0.85,"confidence":0.9,"reasoning":"Off-thesis but presented as an investment opportunity."}
MRAI Global in scheduling/follow-up context with no investment ask -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.25,"confidence":0.82,"reasoning":"Useful meeting evidence but not enough to create a prospect."}
Apollo Lee named as a person or relationship participant -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.88,"reasoning":"Relationship context, not a prospect company mention."}
Cedar Pine named around another company's commercial relationship -> {"prospect_action":"record_context","prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.3,"confidence":0.86,"reasoning":"Useful relationship context but not the investment target."}
Anthropic in an NVCA fundraise newsletter -> {"prospect_action":"ignore","prospect_company_name":null,"direction":"news","sector_key":"ai_data","sector_confidence":0.85,"confidence":0.92,"reasoning":"Informational fundraise news only."}
Verification-code, login, billing, or admin email from a vendor -> {"prospect_action":"ignore","prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.95,"reasoning":"Operational artifact, not deal flow."}
Explicit website-visitor analytics row saying Company X visited medinavc.com -> {"prospect_action":"ignore","prospect_company_name":null,"direction":"internal","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Website traffic analytics is not a prospect signal."}

Output ONLY this JSON object, no prose, no code fences:
{"prospect_action":"...","prospect_company_name":null,"direction":"...","sector_key":"...","sector_confidence":0.0,"confidence":0.0,"reasoning":"one short sentence"}
confidence is your overall confidence in the prospect_action + direction call, in [0,1].`;

  const policyLens = input.policyLens
    ? `\n\nPOLICY LENS FOR THIS QUARANTINED EVALUATION RUN:\n${input.policyLens.name} (${input.policyLens.id})\n${input.policyLens.instructions}\nUse this lens only to resolve borderline cases inside the schema. Do not violate the hard rules above.`
    : '';

  const dynamicSystem = `KNOWN deals / portfolio (names + domains): ${knownDeals}
KNOWN dealmakers / intro sources (names + domains): ${knownDealmakers}

Hints (heuristic pre-filter and sector hints -- WEAK signals, not ground truth; override
them when the content disagrees): ${prefilterHints} ${sectorHints}${policyLens}`;

  const system = `${staticSystem}\n\n${dynamicSystem}`;
  const systemForApi: ClaudeSystemPrompt = [
    { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicSystem },
  ];

  const user = `SOURCE_TYPE: ${input.sourceType}
FROM / CONTEXT: ${input.senderAndContext}
MENTION (the company in question): ${input.companyName}
EXCERPT:
${input.rawExcerpt}`;

  return { system, systemForApi, user };
}

function parseProspectClassifierResponse(
  raw: string,
  model: string,
  usage?: { input_tokens: number; output_tokens: number }
): LlmClassifierDecision {
  const parsed = parseJsonObject(raw, 'INVALID_PROSPECT_CLASSIFIER_JSON');
  const legacyMentionType = parsed.mention_type ? parseMentionType(parsed.mention_type) : 'noise';
  const prospectAction = parseProspectAction(parsed.prospect_action, legacyMentionType, parsed.signal_disposition);
  return {
    mentionType: mentionTypeForAction(prospectAction),
    direction: parseDirection(parsed.direction),
    sectorKey: parseSectorKey(parsed.sector_key),
    sectorConfidence: parseUnitConfidence(parsed.sector_confidence, 'sector_confidence'),
    confidence: parseUnitConfidence(parsed.confidence, 'confidence'),
    prospectAction,
    prospectCompanyName: parseNullableClassifierString(parsed.prospect_company_name),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : null,
    model,
    usage,
  };
}

export async function callProspectClassifier(
  input: ProspectClassifierInput,
  env: Env
): Promise<LlmClassifierDecision> {
  if (input.prefilterHints.should_classify === false) {
    throw new Error('PREFILTER_REJECTED_CLASSIFIER_CALL');
  }
  const model = prospectClassifierModel(env, input);
  const prompt = buildProspectClassifierPrompt(input);
  const result = await callClaudeWithUsage(
    { system: prompt.systemForApi, user: prompt.user, max_tokens: 700, orgId: input.orgId, model, assistantPrefill: '{', temperature: 0 },
    'low',
    env
  );
  return parseProspectClassifierResponse(result.text, result.model, result.usage);
}

async function classifyMention(
  item: ClassifiedItem,
  mention: MentionCandidate,
  existing: ExistingContext,
  knownContext: ProspectClassifierKnownContext,
  orgId: string,
  env: Env
): Promise<Classification> {
  const prefilter = buildClassifierPrefilter(item, mention, existing, env);
  const classifierInput = classifierInputForRuntime(item, mention, existing, prefilter, knownContext, orgId);
  const llm = await callProspectClassifier(classifierInput, env);
  const llmValuableActionVeto = prospectValuableActionVetoForMention({
    prospectAction: llm.prospectAction,
    companyName: mention.canonicalName,
    rawMention: mention.raw,
    rawExcerpt: classifierInput.rawExcerpt,
    senderAndContext: classifierInput.senderAndContext,
    prospectCompanyName: llm.prospectCompanyName,
    llmReasoning: llm.reasoning,
  });
  const portfolio = existing.relationshipStates.includes('current_portfolio') || existing.relationshipStates.includes('exited');
  let directionUncertain =
    prefilter.deterministicDirection !== 'unknown' &&
    prefilter.deterministicDirection !== llm.direction;
  let effectiveConfidence = directionUncertain
    ? Math.min(llm.confidence, 0.54)
    : llm.confidence;

  let possibleCompanyId: string | null = null;
  let possibleDealId: string | null = null;
  let linkedDealId: string | null = null;
  let mentionType = llm.mentionType;
  let prospectAction = llm.prospectAction;
  let shouldCreateProspect = prospectAction === 'create_prospect';
  let confidenceTier = confidenceTierFor(effectiveConfidence);
  let provisional = confidenceTier === 'low' || directionUncertain;
  let createProspectVetoApplied = false;
  let createProspectVetoReason: string | null = null;
  let valuableActionVetoApplied = false;
  let valuableActionVetoReason: string | null = null;
  const exactDealDomainMatch = Boolean(existing.dealId && existing.matchStrength === 'domain');

  if (exactDealDomainMatch && (prospectAction === 'create_prospect' || prospectAction === 'attach_existing_deal')) {
    mentionType = 'known_deal';
    prospectAction = 'attach_existing_deal';
    shouldCreateProspect = false;
    linkedDealId = existing.dealId;
    provisional = false;
  } else if (prospectAction === 'attach_existing_deal' && existing.dealId && existing.matchStrength !== 'name') {
    mentionType = 'known_deal';
    linkedDealId = existing.dealId;
  } else if (prospectAction === 'attach_existing_deal') {
    mentionType = 'noise';
    prospectAction = 'record_context';
  }

  const valuableActionVeto = prospectValuableActionVetoForMention({
    prospectAction,
    companyName: mention.canonicalName,
    rawMention: mention.raw,
    rawExcerpt: classifierInput.rawExcerpt,
    senderAndContext: classifierInput.senderAndContext,
    prospectCompanyName: llm.prospectCompanyName,
    llmReasoning: llm.reasoning,
  });
  const effectiveVeto = valuableActionVeto.applied ? valuableActionVeto : llmValuableActionVeto;

  if ((prospectAction === 'create_prospect' || prospectAction === 'attach_existing_deal') && effectiveVeto.applied) {
    const vetoedProspectAction = prospectAction;
    mentionType = 'noise';
    prospectAction = effectiveVeto.nonValuableAction || 'ignore';
    shouldCreateProspect = false;
    possibleCompanyId = null;
    possibleDealId = null;
    linkedDealId = null;
    provisional = false;
    directionUncertain = false;
    effectiveConfidence = effectiveVeto.confidence || 0.97;
    valuableActionVetoApplied = true;
    valuableActionVetoReason = effectiveVeto.reason;
    if (llm.prospectAction === 'create_prospect' || vetoedProspectAction === 'create_prospect') {
      createProspectVetoApplied = true;
      createProspectVetoReason = effectiveVeto.reason;
    }
  }

  confidenceTier = confidenceTierFor(effectiveConfidence);
  const sampling = productionSamplingDecision({
    orgId,
    item,
    mention,
    confidenceTier,
    directionUncertain,
    env,
  });

  if (shouldCreateProspect) {
    possibleCompanyId = existing.companyId;
    possibleDealId = existing.dealId && existing.matchStrength === 'name' ? existing.dealId : null;
    if (possibleDealId) provisional = true;
  }

  return {
    direction: llm.direction,
    directionUncertain,
    mentionType,
    prospectAction,
    shouldCreateProspect,
    prospectCompanyName: shouldCreateProspect ? (llm.prospectCompanyName || mention.canonicalName) : null,
    confidence: effectiveConfidence,
    confidenceTier,
    sectorKey: llm.sectorKey,
    sectorConfidence: llm.sectorConfidence,
    signalKind: prefilter.signalKind,
    hasDeck: prefilter.hasDeck,
    hasMeeting: prefilter.hasMeeting,
    hasWarmIntro: prefilter.hasWarmIntro,
    dealmakerName: prefilter.hasWarmIntro ? normalizeWhitespace(item.fromName || item.fromEmail || '') : null,
    possibleCompanyId,
    possibleDealId,
    linkedDealId,
    provisional,
    sampledForProduction: sampling.sampled,
    samplingReason: sampling.reason,
    metadata: {
      classifier: 'llm_req_cl',
      classifier_model: llm.model,
      llm_reasoning: llm.reasoning,
      llm_confidence: llm.confidence,
      effective_confidence: effectiveConfidence,
      llm_usage: llm.usage || null,
      create_prospect_veto_applied: createProspectVetoApplied,
      create_prospect_veto_reason: createProspectVetoReason,
      valuable_action_veto_applied: valuableActionVetoApplied,
      valuable_action_veto_reason: valuableActionVetoReason,
      original_llm_prospect_action: llm.prospectAction,
      original_llm_reasoning: llm.reasoning,
      prospect_action: prospectAction,
      should_create_prospect: shouldCreateProspect,
      prospect_company_name: shouldCreateProspect ? (llm.prospectCompanyName || mention.canonicalName) : null,
      context_signal: prospectAction === 'record_context',
      prefilter,
      products: mention.products,
      list_fields: mention.listFields || null,
      from_domain: emailDomain(item.fromEmail),
      source_direction: item.direction || null,
      deterministic_direction: prefilter.deterministicDirection,
      deterministic_direction_disagreed: directionUncertain,
      deterministic_portfolio_hint: portfolio,
      firewall: {
        req: 'REQ-ID-5',
        exact_deal_domain_match: exactDealDomainMatch,
        linked_deal_id: linkedDealId,
        weak_deal_match_held_as_soft_link: Boolean(possibleDealId),
        original_llm_prospect_action: llm.prospectAction,
        derived_mention_type: mentionType,
      },
      confidence_tier_routing: {
        req: 'REQ-VAL-5',
        tier: confidenceTier,
        provisional,
        production_sampled: sampling.sampled,
        sampling_reason: sampling.reason,
      },
    },
  };
}

function prospectSourceType(item: ClassifiedItem): SourceType | null {
  if (item.entityType === 'event') return 'event';
  if (item.entityType === 'conversation') return 'conversation';
  if ((item as any).entityType === 'document') return 'document';
  return null;
}

async function upsertProspect(
  orgId: string,
  mention: MentionCandidate,
  cls: Classification,
  occurredAt: string,
  env: Env
): Promise<string> {
  const id = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospects (
       id, org_id, canonical_name, normalized_name, status, visibility,
       sector_key, sector_confidence, first_seen_at, last_seen_at, last_signal_at,
       signal_strength_reasons, confidence, provisional, direction_uncertain,
       possible_company_id, possible_deal_id, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, 'firm',
       ?, ?, ?, ?, ?,
       '[]', ?, ?, ?,
       ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, normalized_name) WHERE deleted_at IS NULL DO UPDATE SET
       canonical_name = CASE
         WHEN length(excluded.canonical_name) > length(prospects.canonical_name) THEN excluded.canonical_name
         ELSE prospects.canonical_name
       END,
       status = CASE WHEN prospects.status = 'active' THEN prospects.status ELSE excluded.status END,
       sector_key = CASE
         WHEN prospects.sector_key = 'uncategorized' OR excluded.sector_confidence > prospects.sector_confidence THEN excluded.sector_key
         ELSE prospects.sector_key
       END,
       sector_confidence = MAX(prospects.sector_confidence, excluded.sector_confidence),
       first_seen_at = CASE
         WHEN prospects.first_seen_at IS NULL OR excluded.first_seen_at < prospects.first_seen_at THEN excluded.first_seen_at
         ELSE prospects.first_seen_at
       END,
       last_seen_at = CASE
         WHEN prospects.last_seen_at IS NULL OR excluded.last_seen_at > prospects.last_seen_at THEN excluded.last_seen_at
         ELSE prospects.last_seen_at
       END,
       last_signal_at = CASE
         WHEN prospects.last_signal_at IS NULL OR excluded.last_signal_at > prospects.last_signal_at THEN excluded.last_signal_at
         ELSE prospects.last_signal_at
       END,
       confidence = MAX(prospects.confidence, excluded.confidence),
       provisional = CASE WHEN excluded.provisional = 1 THEN 1 ELSE prospects.provisional END,
       direction_uncertain = CASE WHEN excluded.direction_uncertain = 1 THEN 1 ELSE prospects.direction_uncertain END,
       possible_company_id = COALESCE(prospects.possible_company_id, excluded.possible_company_id),
       possible_deal_id = COALESCE(prospects.possible_deal_id, excluded.possible_deal_id),
       metadata_json = json_patch(COALESCE(prospects.metadata_json, '{}'), excluded.metadata_json),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    id,
    orgId,
    mention.canonicalName,
    mention.normalizedName,
    cls.provisional ? 'provisional' : 'active',
    cls.sectorKey,
    cls.sectorConfidence,
    occurredAt,
    occurredAt,
    occurredAt,
    cls.confidence,
    cls.provisional ? 1 : 0,
    cls.directionUncertain ? 1 : 0,
    cls.possibleCompanyId,
    cls.possibleDealId,
    JSON.stringify({
      products: mention.products,
      prospect_action: cls.prospectAction,
      prospect_company_name: cls.prospectCompanyName,
    })
  ).run();

  const row = await env.D1.prepare(
    `SELECT id FROM prospects WHERE org_id = ? AND normalized_name = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(orgId, mention.normalizedName).first<{ id: string }>();
  if (!row?.id) throw new Error('PROSPECT_UPSERT_FAILED');
  return row.id;
}

export async function ensureProspectForDeal(
  orgId: string,
  dealId: string,
  env: Env
): Promise<EnsureProspectForDealResult> {
  const deal = await env.D1.prepare(
    `SELECT d.id AS deal_id, d.company_id, d.created_at, d.updated_at,
            c.name AS company_name, c.domain AS company_domain, c.website AS company_website,
            c.sector AS company_sector
       FROM deals d
       JOIN companies c ON c.id = d.company_id AND c.org_id = d.org_id
      WHERE d.org_id = ? AND d.id = ? AND d.deleted_at IS NULL
        AND d.stage != 'closed' AND c.deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{
    deal_id: string;
    company_id: string;
    created_at: string | null;
    updated_at: string | null;
    company_name: string;
    company_domain: string | null;
    company_website: string | null;
    company_sector: string | null;
  }>();

  if (!deal?.company_id || !deal.company_name) {
    return { prospectId: null, action: 'skipped_no_deal', dealId, companyId: deal?.company_id || null };
  }

  const normalizedName = normalizeProspectName(deal.company_name);
  if (!normalizedName) {
    return { prospectId: null, action: 'skipped_no_deal', dealId, companyId: deal.company_id };
  }

  const sector = prospectSectorKeyFromCompanySector(deal.company_sector);
  const seenAt = deal.created_at || deal.updated_at || new Date().toISOString();
  const domain = deal.company_domain || domainFromUrl(deal.company_website || null);
  const metadata = {
    source: 'known_deal_backlink',
    deal_id: dealId,
    company_id: deal.company_id,
  };

  const existingDealProspect = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND deal_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{ id: string }>();
  if (existingDealProspect?.id) {
    await env.D1.prepare(
      `UPDATE prospects
          SET canonical_name = CASE
                WHEN length(?) > length(canonical_name) THEN ?
                ELSE canonical_name
              END,
              domain = COALESCE(domain, ?),
              company_id = COALESCE(company_id, ?),
              status = 'converted',
              sector_key = CASE
                WHEN sector_key = 'uncategorized' OR sector_confidence < ? THEN ?
                ELSE sector_key
              END,
              sector_confidence = MAX(sector_confidence, ?),
              last_seen_at = CASE
                WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ?
                ELSE last_seen_at
              END,
              last_signal_at = CASE
                WHEN last_signal_at IS NULL OR ? > last_signal_at THEN ?
                ELSE last_signal_at
              END,
              signal_strength = MAX(signal_strength, 85),
              signal_strength_reasons = CASE
                WHEN signal_strength < 85 THEN ?
                ELSE signal_strength_reasons
              END,
              enrichment_priority = CASE
                WHEN enrichment_priority = 'eager' THEN enrichment_priority
                ELSE 'eager'
              END,
              confidence = MAX(confidence, 1.0),
              provisional = 0,
              direction_uncertain = 0,
              possible_deal_id = NULL,
              metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      deal.company_name,
      deal.company_name,
      domain,
      deal.company_id,
      sector.confidence,
      sector.key,
      sector.confidence,
      seenAt,
      seenAt,
      seenAt,
      seenAt,
      JSON.stringify(['known_deal_backlink']),
      JSON.stringify(metadata),
      existingDealProspect.id,
      orgId
    ).run();
    return {
      prospectId: existingDealProspect.id,
      action: 'already_linked',
      dealId,
      companyId: deal.company_id,
    };
  }

  const existingNameProspect = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND normalized_name = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, normalizedName).first<{ id: string }>();

  await env.D1.prepare(
    `INSERT INTO prospects (
       id, org_id, canonical_name, normalized_name, domain, company_id, deal_id,
       status, visibility, sector_key, sector_confidence,
       first_seen_at, last_seen_at, last_signal_at,
       signal_strength, signal_strength_reasons, enrichment_priority,
       confidence, provisional, direction_uncertain, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       'converted', 'firm', ?, ?,
       ?, ?, ?,
       85, ?, 'eager',
       1.0, 0, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, normalized_name) WHERE deleted_at IS NULL DO UPDATE SET
       canonical_name = CASE
         WHEN length(excluded.canonical_name) > length(prospects.canonical_name) THEN excluded.canonical_name
         ELSE prospects.canonical_name
       END,
       domain = COALESCE(prospects.domain, excluded.domain),
       company_id = COALESCE(prospects.company_id, excluded.company_id),
       deal_id = COALESCE(prospects.deal_id, excluded.deal_id),
       status = 'converted',
       sector_key = CASE
         WHEN prospects.sector_key = 'uncategorized' OR prospects.sector_confidence < excluded.sector_confidence THEN excluded.sector_key
         ELSE prospects.sector_key
       END,
       sector_confidence = MAX(prospects.sector_confidence, excluded.sector_confidence),
       first_seen_at = CASE
         WHEN prospects.first_seen_at IS NULL OR excluded.first_seen_at < prospects.first_seen_at THEN excluded.first_seen_at
         ELSE prospects.first_seen_at
       END,
       last_seen_at = CASE
         WHEN prospects.last_seen_at IS NULL OR excluded.last_seen_at > prospects.last_seen_at THEN excluded.last_seen_at
         ELSE prospects.last_seen_at
       END,
       last_signal_at = CASE
         WHEN prospects.last_signal_at IS NULL OR excluded.last_signal_at > prospects.last_signal_at THEN excluded.last_signal_at
         ELSE prospects.last_signal_at
       END,
       signal_strength = MAX(prospects.signal_strength, excluded.signal_strength),
       signal_strength_reasons = CASE
         WHEN prospects.signal_strength < excluded.signal_strength THEN excluded.signal_strength_reasons
         ELSE prospects.signal_strength_reasons
       END,
       enrichment_priority = CASE
         WHEN prospects.enrichment_priority = 'eager' THEN prospects.enrichment_priority
         ELSE excluded.enrichment_priority
       END,
       confidence = MAX(prospects.confidence, excluded.confidence),
       provisional = 0,
       direction_uncertain = 0,
       possible_deal_id = NULL,
       metadata_json = json_patch(COALESCE(prospects.metadata_json, '{}'), excluded.metadata_json),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    crypto.randomUUID(),
    orgId,
    deal.company_name,
    normalizedName,
    domain,
    deal.company_id,
    dealId,
    sector.key,
    sector.confidence,
    seenAt,
    seenAt,
    seenAt,
    JSON.stringify(['known_deal_backlink']),
    JSON.stringify(metadata)
  ).run();

  const row = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND deal_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, dealId).first<{ id: string }>();
  if (!row?.id) throw new Error('DEAL_PROSPECT_UPSERT_FAILED');

  return {
    prospectId: row.id,
    action: existingDealProspect ? 'already_linked' : existingNameProspect ? 'updated' : 'created',
    dealId,
    companyId: deal.company_id,
  };
}

async function loadDealBackedProspectMap(orgId: string, env: Env): Promise<Map<string, string>> {
  const rows = await env.D1.prepare(
    `SELECT id, deal_id
       FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND deal_id IS NOT NULL
        AND status IN ('active','provisional','converted')`
  ).bind(orgId).all<{ id: string; deal_id: string }>();
  return new Map((rows.results || []).filter(row => row.deal_id).map(row => [row.deal_id, row.id]));
}

async function upsertSignal(args: {
  orgId: string;
  prospectId: string | null;
  dealId: string | null;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string | null;
  occurredAt: string;
  mention: MentionCandidate;
  cls: Classification;
  dealmakerId: string | null;
  dealmakerName: string | null;
  ingestionMode: 'live' | 'backfill';
}, env: Env): Promise<{ signalId: string }> {
  const before = await env.D1.prepare(
    `SELECT id, mention_type, direction, sector_key, confidence, classifier_version, prospect_id, deal_id,
            classification_status, resolution_status, classification_attempts, error_message
       FROM prospect_signals
      WHERE org_id = ? AND source_type = ? AND source_id = ? AND mention_ordinal = ?
      LIMIT 1`
  ).bind(args.orgId, args.sourceType, args.sourceId, args.mention.mentionOrdinal).first<{
    id: string; mention_type: string; direction: string; sector_key: string; confidence: number; classifier_version: string; prospect_id: string | null; deal_id: string | null;
    classification_status: string; resolution_status: string; classification_attempts: number; error_message: string | null;
  }>();

  const signalId = before?.id || crypto.randomUUID();
  const resolutionStatus = args.cls.provisional || args.cls.directionUncertain || args.cls.sectorKey === 'uncategorized'
    ? 'pending'
    : 'resolved';
  const attempts = Number(before?.classification_attempts || 0) + 1;
  const newClassification = {
    mention_type: args.cls.mentionType,
    direction: args.cls.direction,
    sector_key: args.cls.sectorKey,
    confidence: args.cls.confidence,
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    prospect_id: args.prospectId,
    deal_id: args.dealId,
    classification_status: 'classified',
    resolution_status: resolutionStatus,
  };

  await env.D1.prepare(
    `INSERT INTO prospect_signals (
       id, org_id, prospect_id, deal_id, source_type, source_id, mention_ordinal,
       span_start, span_end, raw_mention_text, normalized_mention, source_title,
       occurred_at, direction, direction_source, direction_uncertain,
       mention_type, classifier_version, confidence, confidence_tier,
       classification_status, resolution_status, error_message, classification_attempts, last_attempted_at,
       sector_key, sector_confidence, signal_kind, dealmaker_id, dealmaker_name,
       has_deck, has_meeting, ingestion_mode, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       prospect_id = excluded.prospect_id,
       deal_id = excluded.deal_id,
       span_start = excluded.span_start,
       span_end = excluded.span_end,
       raw_mention_text = excluded.raw_mention_text,
       normalized_mention = excluded.normalized_mention,
       source_title = excluded.source_title,
       occurred_at = excluded.occurred_at,
       direction = excluded.direction,
       direction_source = excluded.direction_source,
       direction_uncertain = excluded.direction_uncertain,
       mention_type = excluded.mention_type,
       classifier_version = excluded.classifier_version,
       confidence = excluded.confidence,
       confidence_tier = excluded.confidence_tier,
       classification_status = excluded.classification_status,
       resolution_status = excluded.resolution_status,
       error_message = excluded.error_message,
       classification_attempts = excluded.classification_attempts,
       last_attempted_at = excluded.last_attempted_at,
       sector_key = excluded.sector_key,
       sector_confidence = excluded.sector_confidence,
       signal_kind = excluded.signal_kind,
       dealmaker_id = excluded.dealmaker_id,
       dealmaker_name = excluded.dealmaker_name,
       has_deck = excluded.has_deck,
       has_meeting = excluded.has_meeting,
       ingestion_mode = excluded.ingestion_mode,
       metadata_json = excluded.metadata_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    signalId,
    args.orgId,
    args.prospectId,
    args.dealId,
    args.sourceType,
    args.sourceId,
    args.mention.mentionOrdinal,
    args.mention.spanStart,
    args.mention.spanEnd,
    args.mention.raw,
    args.mention.normalizedName,
    args.sourceTitle,
    args.occurredAt,
    args.cls.direction,
    args.cls.directionUncertain ? 'mixed' : 'llm',
    args.cls.directionUncertain ? 1 : 0,
    args.cls.mentionType,
    PROSPECT_CLASSIFIER_VERSION,
    args.cls.confidence,
    args.cls.confidenceTier,
    'classified',
    resolutionStatus,
    null,
    attempts,
    args.cls.sectorKey,
    args.cls.sectorConfidence,
    args.cls.signalKind,
    args.dealmakerId,
    args.dealmakerName,
    args.cls.hasDeck ? 1 : 0,
    args.cls.hasMeeting ? 1 : 0,
    args.ingestionMode,
    JSON.stringify(args.cls.metadata)
  ).run();

  if (before && (
    before.mention_type !== args.cls.mentionType ||
    before.direction !== args.cls.direction ||
    before.sector_key !== args.cls.sectorKey ||
    Number(before.confidence) !== args.cls.confidence ||
    before.classifier_version !== PROSPECT_CLASSIFIER_VERSION ||
    before.prospect_id !== args.prospectId ||
    before.deal_id !== args.dealId ||
    before.classification_status !== 'classified' ||
    before.resolution_status !== resolutionStatus
  )) {
    await env.D1.prepare(
      `INSERT INTO prospect_classification_history
         (id, org_id, prospect_signal_id, classifier_version, previous_classification_json, new_classification_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(
      crypto.randomUUID(),
      args.orgId,
      before.id,
      PROSPECT_CLASSIFIER_VERSION,
      JSON.stringify(before),
      JSON.stringify(newClassification)
    ).run();
  }

  return { signalId };
}

async function recordProductionSample(args: {
  orgId: string;
  signalId: string;
  sourceType: SourceType;
  sourceId: string;
  mention: MentionCandidate;
  cls: Classification;
}, env: Env): Promise<boolean> {
  if (!args.cls.sampledForProduction || !args.cls.samplingReason) return false;
  await env.D1.prepare(
    `INSERT INTO prospect_classifier_samples (
       id, org_id, prospect_signal_id, source_type, source_id, mention_ordinal,
       sample_reason, confidence_tier, predicted_mention_type, predicted_direction,
       predicted_sector_key, label_status, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, 'unlabeled', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       prospect_signal_id = excluded.prospect_signal_id,
       sample_reason = excluded.sample_reason,
       confidence_tier = excluded.confidence_tier,
       predicted_mention_type = excluded.predicted_mention_type,
       predicted_direction = excluded.predicted_direction,
       predicted_sector_key = excluded.predicted_sector_key,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    crypto.randomUUID(),
    args.orgId,
    args.signalId,
    args.sourceType,
    args.sourceId,
    args.mention.mentionOrdinal,
    args.cls.samplingReason,
    args.cls.confidenceTier,
    args.cls.mentionType,
    args.cls.direction,
    args.cls.sectorKey
  ).run();
  return true;
}

async function upsertFailedSignal(args: {
  orgId: string;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string | null;
  occurredAt: string;
  mention: MentionCandidate;
  ingestionMode: 'live' | 'backfill';
  error: unknown;
}, env: Env): Promise<void> {
  const message = (args.error instanceof Error ? args.error.message : String(args.error || 'unknown'))
    .slice(0, 1000);
  const before = await env.D1.prepare(
    `SELECT id, classification_attempts
       FROM prospect_signals
      WHERE org_id = ? AND source_type = ? AND source_id = ? AND mention_ordinal = ?
      LIMIT 1`
  ).bind(args.orgId, args.sourceType, args.sourceId, args.mention.mentionOrdinal).first<{
    id: string; classification_attempts: number;
  }>();
  const attempts = Number(before?.classification_attempts || 0) + 1;

  await env.D1.prepare(
    `INSERT INTO prospect_signals (
       id, org_id, prospect_id, source_type, source_id, mention_ordinal,
       span_start, span_end, raw_mention_text, normalized_mention, source_title,
       occurred_at, direction, direction_source, direction_uncertain,
       mention_type, classifier_version, confidence, confidence_tier,
       classification_status, resolution_status, error_message, classification_attempts, last_attempted_at,
       sector_key, sector_confidence, signal_kind, has_deck, has_meeting,
       ingestion_mode, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, NULL, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, 'inbound', 'llm', 0,
       'noise', ?, 0, 'low',
       'failed', 'pending', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       'uncategorized', 0, 'unknown', 0, 0,
       ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       span_start = excluded.span_start,
       span_end = excluded.span_end,
       raw_mention_text = excluded.raw_mention_text,
       normalized_mention = excluded.normalized_mention,
       source_title = excluded.source_title,
       occurred_at = excluded.occurred_at,
       classifier_version = excluded.classifier_version,
       classification_status = excluded.classification_status,
       resolution_status = excluded.resolution_status,
       error_message = excluded.error_message,
       classification_attempts = excluded.classification_attempts,
       last_attempted_at = excluded.last_attempted_at,
       ingestion_mode = excluded.ingestion_mode,
       metadata_json = json_patch(COALESCE(prospect_signals.metadata_json, '{}'), excluded.metadata_json),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    before?.id || crypto.randomUUID(),
    args.orgId,
    args.sourceType,
    args.sourceId,
    args.mention.mentionOrdinal,
    args.mention.spanStart,
    args.mention.spanEnd,
    args.mention.raw,
    args.mention.normalizedName,
    args.sourceTitle,
    args.occurredAt,
    PROSPECT_CLASSIFIER_VERSION,
    message,
    attempts,
    args.ingestionMode,
    JSON.stringify({
      classifier: 'llm_req_cl',
      classifier_error: message,
      retriable: true,
      req: 'REQ-AR-3',
    })
  ).run();
}

export function computeSignalStrength(input: {
  signalCount: number;
  hasMeeting: boolean;
  hasDeck: boolean;
  hasWarmIntro: boolean;
  hasOnlyListEntries: boolean;
  hasOnlyColdMentions: boolean;
}): { score: number; reasons: string[]; priority: 'eager' | 'lazy' } {
  const reasons: string[] = [];
  let score = 20;
  if (input.hasMeeting) { score += 35; reasons.push('meeting_or_call'); }
  if (input.hasDeck) { score += 30; reasons.push('attached_deck_or_data_room'); }
  if (input.hasWarmIntro) { score += 25; reasons.push('named_dealmaker_intro'); }
  if (input.signalCount > 1) {
    const bump = Math.min(30, (input.signalCount - 1) * 12);
    score += bump;
    reasons.push(`corroborated_${input.signalCount}_signals`);
  }
  if (input.hasOnlyListEntries) { score -= 15; reasons.push('single_or_list_email_entry'); }
  if (input.hasOnlyColdMentions) { score -= 10; reasons.push('cold_mention'); }
  score = clamp(Math.round(score), 0, 100);
  return { score, reasons, priority: score >= 60 ? 'eager' : 'lazy' };
}

async function refreshProspectAggregate(prospectId: string, orgId: string, env: Env): Promise<void> {
  const rows = await env.D1.prepare(
    `SELECT signal_kind, has_deck, has_meeting, dealmaker_id, confidence, occurred_at
       FROM prospect_signals
      WHERE prospect_id = ? AND org_id = ? AND mention_type = 'inbound_prospect'
      ORDER BY occurred_at ASC`
  ).bind(prospectId, orgId).all<{
    signal_kind: SignalKind; has_deck: number; has_meeting: number; dealmaker_id: string | null; confidence: number; occurred_at: string;
  }>();
  const signals = rows.results;
  if (signals.length === 0) return;
  const strength = computeSignalStrength({
    signalCount: signals.length,
    hasMeeting: signals.some(s => s.has_meeting === 1 || s.signal_kind === 'meeting'),
    hasDeck: signals.some(s => s.has_deck === 1 || s.signal_kind === 'deck'),
    hasWarmIntro: signals.some(s => !!s.dealmaker_id || s.signal_kind === 'intro'),
    hasOnlyListEntries: signals.every(s => s.signal_kind === 'list_entry'),
    hasOnlyColdMentions: signals.every(s => s.signal_kind === 'cold_mention'),
  });
  const avgConfidence = signals.reduce((sum, s) => sum + Number(s.confidence || 0), 0) / signals.length;
  await env.D1.prepare(
    `UPDATE prospects
        SET signal_count = ?,
            evidence_count = ?,
            first_seen_at = ?,
            last_seen_at = ?,
            last_signal_at = ?,
            signal_strength = ?,
            signal_strength_reasons = ?,
            enrichment_priority = ?,
            confidence = MAX(confidence, ?),
            status = CASE WHEN status = 'provisional' AND ? >= 60 THEN 'active' ELSE status END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    signals.length,
    signals.length,
    signals[0].occurred_at,
    signals[signals.length - 1].occurred_at,
    signals[signals.length - 1].occurred_at,
    strength.score,
    JSON.stringify(strength.reasons),
    strength.priority,
    avgConfidence,
    strength.score,
    prospectId,
    orgId
  ).run();
}

function sameCompanyForEnrichment(prospect: { canonical_name: string; domain: string | null }, candidate: ProspectEnrichmentCandidate): boolean {
  const prospectDomain = prospect.domain?.trim().toLowerCase() || null;
  const candidateDomain = candidate.domain?.trim().toLowerCase() || domainInText(candidate.sourceUrl);
  if (prospectDomain && candidateDomain && prospectDomain === candidateDomain) return true;
  if (candidate.sourceKind === 'own_domain' && prospectDomain && candidate.sourceUrl.toLowerCase().includes(prospectDomain)) return true;
  return normalizeProspectName(candidate.canonicalName) === normalizeProspectName(prospect.canonical_name);
}

function enrichmentCandidateIsCorroborated(candidate: ProspectEnrichmentCandidate): boolean {
  return candidate.sourceKind === 'own_domain' || Number(candidate.corroboratingSourceCount || 0) >= 2;
}

async function currentProspectFieldValue(
  orgId: string,
  prospectId: string,
  field: string,
  env: Env
): Promise<string | null> {
  if (!PROSPECT_ENRICHMENT_FIELDS.has(field)) return null;
  const row = await env.D1.prepare(
    `SELECT ${field} AS value FROM prospects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(prospectId, orgId).first<{ value: string | null }>();
  const value = row?.value == null ? null : String(row.value).trim();
  return value || null;
}

async function writeProspectFieldState(args: {
  orgId: string;
  prospectId: string;
  field: string;
  value: string;
  source: string;
  sourceUrl: string;
  applyToEntity: boolean;
}, env: Env): Promise<'applied' | 'held' | 'skipped'> {
  if (!PROSPECT_ENRICHMENT_FIELDS.has(args.field)) return 'skipped';
  const value = normalizeWhitespace(args.value);
  if (!value) return 'skipped';

  if (args.applyToEntity) {
    await env.D1.prepare(
      `UPDATE prospects
          SET ${args.field} = ?,
              enrichment_status = 'enriched',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(value, args.prospectId, args.orgId).run();
    await env.D1.prepare(
      `INSERT INTO entity_field_state
         (entity_type, entity_id, field_name, current_value, current_value_sources, pending_proposals, rejected_values)
       VALUES ('prospect', ?, ?, ?, ?, '{}', '{}')
       ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
         current_value = excluded.current_value,
         current_value_sources = excluded.current_value_sources,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(
      args.prospectId,
      args.field,
      value,
      JSON.stringify([{ source: args.source, source_url: args.sourceUrl, authority: 'web_enrichment', req: 'REQ-EN-4' }])
    ).run();
    return 'applied';
  }

  await env.D1.prepare(
    `INSERT INTO entity_field_state
       (entity_type, entity_id, field_name, current_value, current_value_sources, pending_proposals, rejected_values)
     VALUES ('prospect', ?, ?, NULL, '[]', json_object(?, json_array(?)), '{}')
     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
       pending_proposals = json_patch(COALESCE(entity_field_state.pending_proposals, '{}'), json_object(?, json_array(?))),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    args.prospectId,
    args.field,
    value,
    `${args.source}:${args.sourceUrl}`,
    value,
    `${args.source}:${args.sourceUrl}`
  ).run();
  await env.D1.prepare(
    `UPDATE prospects
        SET enrichment_status = CASE WHEN enrichment_status = 'not_started' THEN 'candidate' ELSE enrichment_status END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(args.prospectId, args.orgId).run();
  return 'held';
}

export async function applyProspectEnrichmentCandidate(
  orgId: string,
  candidate: ProspectEnrichmentCandidate,
  env: Env
): Promise<{ applied: string[]; held: string[]; discarded: string[] }> {
  const prospect = await env.D1.prepare(
    `SELECT id, canonical_name, domain, website, description, hq_location, founders_json
       FROM prospects
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(candidate.prospectId, orgId).first<any>();
  if (!prospect) throw new Error('PROSPECT_NOT_FOUND');

  const sameCompany = sameCompanyForEnrichment(prospect, candidate);
  const corroborated = enrichmentCandidateIsCorroborated(candidate);
  const result = { applied: [] as string[], held: [] as string[], discarded: [] as string[] };
  for (const [field, rawValue] of Object.entries(candidate.fields)) {
    if (!rawValue || !PROSPECT_ENRICHMENT_FIELDS.has(field)) continue;
    if (!sameCompany) {
      result.discarded.push(field);
      continue;
    }
    const current = await currentProspectFieldValue(orgId, candidate.prospectId, field, env);
    if (current) {
      result.discarded.push(field);
      continue;
    }
    const disposition = await writeProspectFieldState({
      orgId,
      prospectId: candidate.prospectId,
      field,
      value: rawValue,
      source: `web_enrichment:${candidate.sourceKind}`,
      sourceUrl: candidate.sourceUrl,
      applyToEntity: corroborated,
    }, env);
    if (disposition === 'applied') result.applied.push(field);
    else if (disposition === 'held') result.held.push(field);
    else result.discarded.push(field);
  }
  return result;
}

function extractMetaContent(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  return re.exec(html)?.[1]?.replace(/&amp;/g, '&') || null;
}

function titleFromHtml(html: string): string | null {
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

export async function runProspectEnrichmentCycle(
  orgId: string,
  env: Env,
  options: { limit?: number; fetcher?: typeof fetch } = {}
): Promise<{ scanned: number; applied: number; held: number; discarded: number }> {
  const limit = Math.min(Math.max(Number(options.limit || 10), 1), 50);
  const prospects = await env.D1.prepare(
    `SELECT id, canonical_name, domain, signal_strength, enrichment_status
       FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND status IN ('active','provisional')
        AND enrichment_status IN ('not_started','candidate','failed')
      ORDER BY signal_strength DESC, last_seen_at DESC
      LIMIT ?`
  ).bind(orgId, limit).all<{ id: string; canonical_name: string; domain: string | null; signal_strength: number; enrichment_status: string }>();

  let applied = 0;
  let held = 0;
  let discarded = 0;
  const fetcher = options.fetcher || fetch;
  for (const prospect of prospects.results || []) {
    if (!prospect.domain) continue;
    const url = `https://${prospect.domain}`;
    try {
      const response = await fetcher(url, { cf: { cacheTtl: 3600 } } as any);
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const html = await response.text();
      const description = extractMetaContent(html, 'description') || extractMetaContent(html, 'og:description') || titleFromHtml(html);
      const candidate = await applyProspectEnrichmentCandidate(orgId, {
        prospectId: prospect.id,
        canonicalName: prospect.canonical_name,
        domain: prospect.domain,
        sourceKind: 'own_domain',
        sourceUrl: url,
        fields: {
          website: url,
          description: description || undefined,
        },
      }, env);
      applied += candidate.applied.length;
      held += candidate.held.length;
      discarded += candidate.discarded.length;
    } catch (e) {
      await env.D1.prepare(
        `UPDATE prospects
            SET enrichment_status = 'failed',
                metadata_json = json_patch(COALESCE(metadata_json, '{}'), json_object('enrichment_error', ?)),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(e instanceof Error ? e.message : String(e), prospect.id, orgId).run();
    }
  }
  return { scanned: prospects.results.length, applied, held, discarded };
}

async function recordSoftLinks(prospectId: string, orgId: string, cls: Classification, env: Env): Promise<void> {
  const links: Array<{ linkType: 'possible_company_match' | 'possible_deal_attach'; targetType: 'company' | 'deal'; targetId: string }> = [];
  if (cls.possibleCompanyId) links.push({ linkType: 'possible_company_match', targetType: 'company', targetId: cls.possibleCompanyId });
  if (cls.possibleDealId) links.push({ linkType: 'possible_deal_attach', targetType: 'deal', targetId: cls.possibleDealId });
  if (links.length === 0) return;
  await env.D1.batch(links.map(link =>
    env.D1.prepare(
      `INSERT INTO prospect_soft_links
         (id, org_id, prospect_id, link_type, target_type, target_id, score, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(org_id, prospect_id, link_type, target_type, target_id) DO UPDATE SET
         score = MAX(prospect_soft_links.score, excluded.score),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(crypto.randomUUID(), orgId, prospectId, link.linkType, link.targetType, link.targetId, cls.confidence, JSON.stringify({ classifier_version: PROSPECT_CLASSIFIER_VERSION }))
  ));
}

export async function detectAndRecordProspectSignals(
  items: ClassifiedItem[],
  orgId: string,
  env: Env,
  options: { ingestionMode?: 'live' | 'backfill' } = {}
): Promise<ProspectDetectionStats> {
  const stats = emptyStats(items.length);
  const ingestionMode = options.ingestionMode || 'live';
  const knownContext = await loadProspectClassifierKnownContext(orgId, env);
  const dealBackedProspects = await loadDealBackedProspectMap(orgId, env);

  for (const item of items) {
    const sourceType = prospectSourceType(item);
    if (!sourceType) continue;
    try {
      const sourceGate = sourcePrefilter(item, env);
      if (!sourceGate.shouldScan) {
        stats.prefilter_dropped++;
        continue;
      }
      const fallbackName = await companyNameFor(item.companyId, orgId, env);
      const mentions = await extractOrganizationMentionsFromSource(item, orgId, env, { fallbackName, knownContext });
      stats.mentions_seen += mentions.length;
      for (const mention of mentions) {
        const occurredAt = item.sentAt || new Date().toISOString();
        const existing = await lookupExistingContext(mention, item, orgId, env);
        let cls: Classification;
        try {
          cls = await classifyMention(item, mention, existing, knownContext, orgId, env);
        } catch (e) {
          await upsertFailedSignal({
            orgId,
            sourceType,
            sourceId: item.entityId,
            sourceTitle: item.subject || null,
            occurredAt,
            mention,
            ingestionMode,
            error: e,
          }, env);
          stats.signals_recorded++;
          stats.classifications_pending++;
          stats.errors.push({ item_id: item.entityId, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        let prospectId: string | null = null;
        let dealmaker: { id: string | null; name: string | null } = { id: null, name: null };

        if (cls.shouldCreateProspect) {
          if (cls.hasWarmIntro) {
            dealmaker = await upsertSenderDealmaker(item, orgId, occurredAt, env);
          }
          prospectId = await upsertProspect(orgId, mention, cls, occurredAt, env);
          await recordSoftLinks(prospectId, orgId, cls, env);
          stats.prospects_upserted++;
        } else if (cls.mentionType === 'intro_source') {
          dealmaker = await upsertMentionDealmaker(item, mention, orgId, occurredAt, env);
          stats.skipped_intro_source++;
        } else if (cls.mentionType === 'known_deal') {
          prospectId = cls.linkedDealId ? dealBackedProspects.get(cls.linkedDealId) || null : null;
          stats.skipped_known_deal++;
        } else if (cls.mentionType === 'news') {
          stats.skipped_news++;
        } else if (cls.mentionType === 'noise') {
          stats.skipped_noise++;
        } else if (cls.mentionType === 'web_analytics') {
          stats.skipped_web_analytics++;
        }

        const signalResult = await upsertSignal({
          orgId,
          prospectId,
          dealId: cls.linkedDealId,
          sourceType,
          sourceId: item.entityId,
          sourceTitle: item.subject || null,
          occurredAt,
          mention,
          cls,
          dealmakerId: dealmaker.id,
          dealmakerName: dealmaker.name || cls.dealmakerName,
          ingestionMode,
        }, env);
        stats.signals_recorded++;
        const sampled = await recordProductionSample({
          orgId,
          signalId: signalResult.signalId,
          sourceType,
          sourceId: item.entityId,
          mention,
          cls,
        }, env).catch(e => {
          stats.errors.push({ item_id: item.entityId, error: `production_sample_failed:${e instanceof Error ? e.message : String(e)}` });
          return false;
        });
        if (sampled) stats.production_samples_recorded++;

        if (prospectId) await refreshProspectAggregate(prospectId, orgId, env);
      }
    } catch (e) {
      stats.errors.push({ item_id: item.entityId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return stats;
}

export async function recordProspectBackfillCoverage(
  orgId: string,
  env: Env,
  input: {
    runId?: string | null;
    sourceFamily: string;
    windowStart: string;
    windowEnd: string;
	    itemsScanned: number;
	    signalsRecorded: number;
	    prospectsUpserted: number;
	    classificationsPending?: number;
	    status: 'completed' | 'partial' | 'failed';
	    error?: string | null;
	  }
): Promise<void> {
  await env.D1.prepare(
	    `INSERT INTO prospect_backfill_coverage (
	       id, org_id, run_id, source_family, window_start, window_end,
	       status, items_scanned, signals_recorded, prospects_upserted, classifications_pending,
	       started_at, completed_at, error_message, created_at, updated_at
	     ) VALUES (
	       ?, ?, ?, ?, ?, ?,
	       ?, ?, ?, ?, ?,
	       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?,
	       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
	     )
     ON CONFLICT(org_id, source_family, window_start, window_end) DO UPDATE SET
       run_id = COALESCE(excluded.run_id, prospect_backfill_coverage.run_id),
       status = CASE
         WHEN prospect_backfill_coverage.status = 'completed' THEN prospect_backfill_coverage.status
         ELSE excluded.status
       END,
	       items_scanned = MAX(prospect_backfill_coverage.items_scanned, excluded.items_scanned),
	       signals_recorded = MAX(prospect_backfill_coverage.signals_recorded, excluded.signals_recorded),
	       prospects_upserted = MAX(prospect_backfill_coverage.prospects_upserted, excluded.prospects_upserted),
	       classifications_pending = excluded.classifications_pending,
	       completed_at = excluded.completed_at,
       error_message = excluded.error_message,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    crypto.randomUUID(),
    orgId,
    input.runId || null,
    input.sourceFamily,
    input.windowStart,
    input.windowEnd,
    input.status,
	    input.itemsScanned,
	    input.signalsRecorded,
	    input.prospectsUpserted,
	    input.classificationsPending || 0,
	    input.error || null
	  ).run();
	}

function parseEmailList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(v => typeof v === 'string');
  } catch {}
  return text.split(/[;,]/).map(part => part.trim()).filter(Boolean);
}

function estimateProspectBackfillCost(items: number, measuredCostPerItemUsd?: number | null): number | null {
  if (measuredCostPerItemUsd == null || !Number.isFinite(measuredCostPerItemUsd)) return null;
  return items * measuredCostPerItemUsd;
}

async function createProspectBackfillRun(
  orgId: string,
  env: Env,
  input: ProspectBackfillWindowInput,
  sourceFamilies: ProspectBackfillSourceFamily[]
): Promise<string> {
  if (input.runId) return input.runId;
  const runId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospect_backfill_runs (
       id, org_id, window_start, window_end, cursor, status, source_families,
       measured_cost_per_item, estimated_total_cost, started_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    runId,
    orgId,
    input.windowStart,
    input.windowEnd,
    input.windowEnd,
    JSON.stringify(sourceFamilies),
    input.measuredCostPerItemUsd ?? null
  ).run();
  return runId;
}

async function readProspectSourceR2Text(env: Env, key?: string | null, maxChars = PROSPECT_SOURCE_TEXT_MAX_CHARS): Promise<string | null> {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || !env.R2?.get) return null;
  try {
    const object = await env.R2.get(normalizedKey);
    if (!object) return null;
    const text = await object.text();
    return text ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

async function loadBackfillItemsForFamily(
  orgId: string,
  env: Env,
  family: ProspectBackfillSourceFamily,
  windowStart: string,
  windowEnd: string,
  limit: number
): Promise<ClassifiedItem[]> {
  if (family === 'conversation') {
    const rows = await env.D1.prepare(
      `SELECT id, source, subject, body_preview, sent_at, from_email, to_emails, cc_emails,
              direction, visibility, participant_user_ids, body_r2_key
         FROM conversations
        WHERE org_id = ? AND sent_at >= ? AND sent_at < ?
        ORDER BY sent_at DESC
        LIMIT ?`
    ).bind(orgId, windowStart, windowEnd, limit).all<any>();
    return Promise.all((rows.results || []).map(async row => {
      const bodyText = await readProspectSourceR2Text(env, row.body_r2_key) || row.body_preview || '';
      return {
        type: row.source === 'slack' ? 'slack_message' : 'email',
        source: row.source === 'slack' ? 'slack' : 'outlook',
        externalId: row.id,
        subject: row.subject || '',
        bodyText,
        bodyPreview: row.body_preview || bodyText.slice(0, 500),
        fromEmail: row.from_email || '',
        toEmails: parseEmailList(row.to_emails),
        ccEmails: parseEmailList(row.cc_emails),
        sentAt: row.sent_at,
        direction: row.direction || undefined,
        orgId,
        visibility: row.visibility || 'private',
        entityType: 'conversation',
        entityId: row.id,
        contactIds: [],
        participantUserIds: parseEmailList(row.participant_user_ids),
        metadata: {
          org_id: orgId,
          visibility: row.visibility || 'private',
          document_type: row.source === 'slack' ? 'slack' : 'email',
          source_table: 'conversations',
          source_id: row.id,
          r2_key: row.body_r2_key || '',
          created_at: row.sent_at,
          primary_entity_id: row.id,
        },
        text: bodyText,
      } as ClassifiedItem;
    }));
  }
  if (family === 'event') {
    const rows = await env.D1.prepare(
      `SELECT id, title, description, summary, start_time, source, transcript_r2_key
         FROM events
        WHERE org_id = ? AND deleted_at IS NULL AND start_time >= ? AND start_time < ?
        ORDER BY start_time DESC
        LIMIT ?`
    ).bind(orgId, windowStart, windowEnd, limit).all<any>();
    return Promise.all((rows.results || []).map(async row => {
      const fallbackText = row.summary || row.description || '';
      const bodyText = await readProspectSourceR2Text(env, row.transcript_r2_key) || fallbackText;
      return {
        type: 'calendar_event',
        source: 'outlook',
        externalId: row.id,
        subject: row.title || '',
        bodyText,
        bodyPreview: fallbackText || bodyText.slice(0, 500),
        fromEmail: '',
        toEmails: [],
        ccEmails: [],
        sentAt: row.start_time,
        orgId,
        visibility: 'private',
        entityType: 'event',
        entityId: row.id,
        contactIds: [],
        metadata: {
          org_id: orgId,
          visibility: 'private',
          document_type: 'meeting',
          source_table: 'events',
          source_id: row.id,
          r2_key: row.transcript_r2_key || '',
          created_at: row.start_time,
          primary_entity_id: row.id,
        },
        text: bodyText,
      } as ClassifiedItem;
    }));
  }
  const rows = await env.D1.prepare(
    `SELECT id, title, extracted_text_preview, document_type, source, visibility,
            participant_user_ids, created_at
       FROM documents
      WHERE org_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(orgId, windowStart, windowEnd, limit).all<any>();
  return (rows.results || []).map(row => ({
    type: 'email',
    source: 'outlook',
    externalId: row.id,
    subject: row.title || '',
    bodyText: row.extracted_text_preview || '',
    bodyPreview: row.extracted_text_preview || '',
    fromEmail: '',
    toEmails: [],
    ccEmails: [],
    sentAt: row.created_at,
    orgId,
    visibility: row.visibility || 'private',
    entityType: 'document',
    entityId: row.id,
    contactIds: [],
    participantUserIds: parseEmailList(row.participant_user_ids),
    metadata: {
      org_id: orgId,
      visibility: row.visibility || 'private',
      document_type: row.document_type || row.source || 'document',
      source_table: 'documents',
      source_id: row.id,
      r2_key: '',
      created_at: row.created_at,
      primary_entity_id: row.id,
    },
    text: row.extracted_text_preview || '',
  } as any));
}

export async function runProspectBackfillWindow(
  orgId: string,
  env: Env,
  input: ProspectBackfillWindowInput
): Promise<ProspectBackfillWindowResult> {
  const sourceFamilies: ProspectBackfillSourceFamily[] = input.sourceFamilies && input.sourceFamilies.length > 0
    ? input.sourceFamilies
    : ['conversation', 'event', 'document'];
  const limit = Math.min(Math.max(Number(input.batchLimit || 100), 1), 500);
  const runId = await createProspectBackfillRun(orgId, env, input, sourceFamilies);
  let itemsFound = 0;
  let itemsProcessed = 0;
  let signalsRecorded = 0;
  let prospectsUpserted = 0;
  let classificationsPending = 0;

  for (const family of sourceFamilies) {
    const items = await loadBackfillItemsForFamily(orgId, env, family, input.windowStart, input.windowEnd, limit);
    itemsFound += items.length;
    const stats = await detectAndRecordProspectSignals(items, orgId, env, { ingestionMode: 'backfill' });
    itemsProcessed += stats.items_scanned;
    signalsRecorded += stats.signals_recorded;
    prospectsUpserted += stats.prospects_upserted;
    classificationsPending += stats.classifications_pending;
    await recordProspectBackfillCoverage(orgId, env, {
      runId,
      sourceFamily: family,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      itemsScanned: stats.items_scanned,
      signalsRecorded: stats.signals_recorded,
      prospectsUpserted: stats.prospects_upserted,
      classificationsPending: stats.classifications_pending,
      status: stats.errors.length > 0 ? 'partial' : 'completed',
      error: stats.errors[0]?.error || null,
    });
  }

  const reconciliation = await runProspectReconciliation(orgId, env);
  await env.D1.prepare(
    `UPDATE prospect_backfill_runs
        SET status = 'completed',
            cursor = ?,
            items_found = ?,
            items_processed = ?,
            signals_recorded = ?,
            estimated_total_cost = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    input.windowStart,
    itemsFound,
    itemsProcessed,
    signalsRecorded,
    estimateProspectBackfillCost(itemsFound, input.measuredCostPerItemUsd),
    runId,
    orgId
  ).run();

  return {
    run_id: runId,
    window_start: input.windowStart,
    window_end: input.windowEnd,
    items_found: itemsFound,
    items_processed: itemsProcessed,
    signals_recorded: signalsRecorded,
    prospects_upserted: prospectsUpserted,
    classifications_pending: classificationsPending,
    source_families: sourceFamilies,
    reconciliation,
  };
}

export async function runProspectReconciliation(orgId: string, env: Env): Promise<{ scanned: number; converted: number; duplicate_links: number; resolved_soft_states: number; pending_classifications: number }> {
  const rows = await env.D1.prepare(
    `SELECT id, canonical_name, normalized_name, domain, possible_deal_id, possible_duplicate_of
       FROM prospects
      WHERE org_id = ? AND deleted_at IS NULL
        AND status IN ('active','provisional')
      ORDER BY updated_at ASC
      LIMIT 100`
  ).bind(orgId).all<{
    id: string; canonical_name: string; normalized_name: string; domain: string | null; possible_deal_id: string | null; possible_duplicate_of: string | null;
  }>();

  let converted = 0;
  let duplicateLinks = 0;
  let resolvedSoftStates = 0;
  for (const p of rows.results) {
    if (p.domain) {
      const deal = await env.D1.prepare(
        `SELECT d.id
           FROM deals d
           JOIN companies c ON c.id = d.company_id
          WHERE d.org_id = ? AND d.deleted_at IS NULL AND d.stage != 'closed'
            AND lower(c.domain) = lower(?)
          LIMIT 1`
      ).bind(orgId, p.domain).first<{ id: string }>();
      if (deal?.id) {
        await env.D1.prepare(
          `UPDATE prospects
              SET status = 'converted',
                  deal_id = ?,
                  possible_deal_id = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND org_id = ?`
        ).bind(deal.id, deal.id, p.id, orgId).run();
        converted++;
        continue;
      }
    }

    const dup = await env.D1.prepare(
      `SELECT id FROM prospects
        WHERE org_id = ? AND deleted_at IS NULL AND id != ? AND normalized_name = ?
        ORDER BY signal_count DESC, created_at ASC
        LIMIT 1`
    ).bind(orgId, p.id, p.normalized_name).first<{ id: string }>();
    if (dup?.id && p.possible_duplicate_of !== dup.id) {
      await env.D1.prepare(
        `UPDATE prospects
            SET possible_duplicate_of = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?`
      ).bind(dup.id, p.id, orgId).run();
      await env.D1.prepare(
        `INSERT OR IGNORE INTO prospect_soft_links
           (id, org_id, prospect_id, link_type, target_type, target_id, score, evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, 'possible_duplicate', 'prospect', ?, 1.0, '{}',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(crypto.randomUUID(), orgId, p.id, dup.id).run();
      duplicateLinks++;
    }

    const unresolved = await env.D1.prepare(
      `SELECT
          SUM(CASE WHEN classification_status != 'classified' THEN 1 ELSE 0 END) AS pending_classifications,
          SUM(CASE WHEN resolution_status = 'pending' THEN 1 ELSE 0 END) AS pending_resolution,
          SUM(CASE WHEN direction_uncertain = 1 THEN 1 ELSE 0 END) AS direction_uncertain,
          SUM(CASE WHEN sector_key = 'uncategorized' THEN 1 ELSE 0 END) AS uncategorized,
          AVG(confidence) AS avg_confidence
         FROM prospect_signals
        WHERE org_id = ? AND prospect_id = ?`
    ).bind(orgId, p.id).first<{
      pending_classifications: number | null; pending_resolution: number | null; direction_uncertain: number | null; uncategorized: number | null; avg_confidence: number | null;
    }>();
    const canResolve =
      Number(unresolved?.pending_classifications || 0) === 0 &&
      Number(unresolved?.direction_uncertain || 0) === 0 &&
      Number(unresolved?.uncategorized || 0) === 0 &&
      Number(unresolved?.avg_confidence || 0) >= 0.82;
    if (canResolve) {
      await env.D1.prepare(
        `UPDATE prospects
            SET status = CASE WHEN status = 'provisional' THEN 'active' ELSE status END,
                provisional = 0,
                direction_uncertain = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND org_id = ?
            AND (status = 'provisional' OR provisional = 1 OR direction_uncertain = 1)`
      ).bind(p.id, orgId).run();
      await env.D1.prepare(
        `UPDATE prospect_signals
            SET resolution_status = 'resolved',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE org_id = ? AND prospect_id = ?
            AND classification_status = 'classified'
            AND direction_uncertain = 0
            AND sector_key != 'uncategorized'`
      ).bind(orgId, p.id).run();
      resolvedSoftStates++;
    }
  }

  const pending = await env.D1.prepare(
    `SELECT COUNT(*) AS n
       FROM prospect_signals
      WHERE org_id = ?
        AND (classification_status != 'classified' OR resolution_status = 'pending')`
  ).bind(orgId).first<{ n: number }>();

  return {
    scanned: rows.results.length,
    converted,
    duplicate_links: duplicateLinks,
    resolved_soft_states: resolvedSoftStates,
    pending_classifications: pending?.n || 0,
  };
}

export async function mergeProspects(
  orgId: string,
  winnerProspectId: string,
  loserProspectId: string,
  env: Env,
  options: { method: string; score: number; alternatives?: unknown[] }
): Promise<{ audit_id: string; moved_signals: number }> {
  if (winnerProspectId === loserProspectId) throw new Error('PROSPECT_MERGE_SELF');
  const [winner, loser, signals] = await Promise.all([
    env.D1.prepare(`SELECT * FROM prospects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).bind(winnerProspectId, orgId).first<any>(),
    env.D1.prepare(`SELECT * FROM prospects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`).bind(loserProspectId, orgId).first<any>(),
    env.D1.prepare(`SELECT id FROM prospect_signals WHERE org_id = ? AND prospect_id = ?`).bind(orgId, loserProspectId).all<{ id: string }>(),
  ]);
  if (!winner || !loser) throw new Error('PROSPECT_MERGE_NOT_FOUND');

  const signalIds = (signals.results || []).map(row => row.id);
  await env.D1.prepare(
    `UPDATE prospect_signals
        SET prospect_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE org_id = ? AND prospect_id = ?`
  ).bind(winnerProspectId, orgId, loserProspectId).run();
  await env.D1.prepare(
    `UPDATE prospects
        SET status = 'merged',
            possible_duplicate_of = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(winnerProspectId, loserProspectId, orgId).run();
  await env.D1.prepare(
    `INSERT OR IGNORE INTO prospect_soft_links
       (id, org_id, prospect_id, link_type, target_type, target_id, score, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, 'possible_duplicate', 'prospect', ?, ?, ?,
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    crypto.randomUUID(),
    orgId,
    loserProspectId,
    winnerProspectId,
    options.score,
    JSON.stringify({ method: options.method, req: 'REQ-ID-7' })
  ).run();
  await refreshProspectAggregate(winnerProspectId, orgId, env).catch(() => undefined);

  const auditId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospect_merge_audit (
       id, org_id, action, winner_prospect_id, loser_prospect_id, method, score,
       moved_signal_ids, alternatives_json, previous_loser_status,
       previous_winner_snapshot, previous_loser_snapshot, created_at
     ) VALUES (?, ?, 'merge', ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    auditId,
    orgId,
    winnerProspectId,
    loserProspectId,
    options.method,
    options.score,
    JSON.stringify(signalIds),
    JSON.stringify(options.alternatives || []),
    loser.status || null,
    JSON.stringify(winner),
    JSON.stringify(loser)
  ).run();

  return { audit_id: auditId, moved_signals: signalIds.length };
}

export async function reverseProspectMerge(
  orgId: string,
  auditId: string,
  env: Env
): Promise<{ audit_id: string; restored_signals: number }> {
  const audit = await env.D1.prepare(
    `SELECT winner_prospect_id, loser_prospect_id, moved_signal_ids, previous_loser_status, score, method
       FROM prospect_merge_audit
      WHERE id = ? AND org_id = ? AND action = 'merge'
      LIMIT 1`
  ).bind(auditId, orgId).first<{
    winner_prospect_id: string; loser_prospect_id: string; moved_signal_ids: string; previous_loser_status: string | null; score: number; method: string;
  }>();
  if (!audit) throw new Error('PROSPECT_MERGE_AUDIT_NOT_FOUND');
  let signalIds: string[] = [];
  try {
    const parsed = JSON.parse(audit.moved_signal_ids || '[]');
    if (Array.isArray(parsed)) signalIds = parsed.filter(id => typeof id === 'string');
  } catch {}
  if (signalIds.length > 0) {
    const ph = signalIds.map(() => '?').join(',');
    await env.D1.prepare(
      `UPDATE prospect_signals
          SET prospect_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE org_id = ? AND id IN (${ph})`
    ).bind(audit.loser_prospect_id, orgId, ...signalIds).run();
  }
  await env.D1.prepare(
    `UPDATE prospects
        SET status = COALESCE(?, 'active'),
            possible_duplicate_of = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(audit.previous_loser_status, audit.loser_prospect_id, orgId).run();
  await Promise.all([
    refreshProspectAggregate(audit.winner_prospect_id, orgId, env).catch(() => undefined),
    refreshProspectAggregate(audit.loser_prospect_id, orgId, env).catch(() => undefined),
  ]);

  const reverseAuditId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO prospect_merge_audit (
       id, org_id, action, winner_prospect_id, loser_prospect_id, method, score,
       moved_signal_ids, alternatives_json, previous_loser_status, created_at
     ) VALUES (?, ?, 'unmerge', ?, ?, ?, ?, ?, '[]', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).bind(
    reverseAuditId,
    orgId,
    audit.winner_prospect_id,
    audit.loser_prospect_id,
    `reverse:${audit.method}`,
    audit.score,
    JSON.stringify(signalIds),
    audit.previous_loser_status
  ).run();
  return { audit_id: reverseAuditId, restored_signals: signalIds.length };
}

export const __prospectIntelligenceTestHooks = {
  normalizeProspectName,
  canonicalizeMention,
  cleanProspectSourceText,
  prospectContextWindow,
  extractMentionCandidatesFromText,
  extractOrganizationMentionsFromSource,
  parseDealflowList,
  sourcePrefilter,
  productionSamplingDecision,
  sameCompanyForEnrichment,
  enrichmentCandidateIsCorroborated,
  computeSignalStrength,
  sectorHintForText,
  buildClassifierPrefilter,
  buildProspectClassifierPrompt,
  classifierInputForRuntime,
  prospectValuableActionVetoForMention,
  prospectCreateVetoForMention,
  parseProspectClassifierResponse,
  parseDirection,
  parseMentionType,
  parseProspectAction,
  parseSectorKey,
};

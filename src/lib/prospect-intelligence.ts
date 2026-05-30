import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { callClaudeWithUsage } from './claude';
import { emailDomain, getConfiguredInternalDomains, isInternalEmailDomain } from './internal-domains';

export const PROSPECT_CLASSIFIER_VERSION = 'prospect-v1-llm-req-cl-2026-05-30';
const PROSPECT_CLASSIFIER_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

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

export const PROSPECT_DIRECTIONS = ['inbound', 'outbound', 'internal', 'news'] as const;
const PROSPECT_DIRECTION_SET = new Set<string>(PROSPECT_DIRECTIONS);

type SourceType = 'conversation' | 'event' | 'document';
type Direction = typeof PROSPECT_DIRECTIONS[number];
type DeterministicDirection = Direction | 'unknown';
type MentionType = typeof PROSPECT_MENTION_TYPES[number];
type SectorKey = typeof PROSPECT_SECTOR_TAXONOMY[number]['key'];
type SignalKind = 'intro' | 'raise' | 'deck' | 'meeting' | 'call' | 'list_entry' | 'cold_mention' | 'unknown';
type ConfidenceTier = 'high' | 'medium' | 'low';

export interface ProspectDetectionStats {
  items_scanned: number;
  mentions_seen: number;
  signals_recorded: number;
  prospects_upserted: number;
  skipped_known_deal: number;
  skipped_intro_source: number;
  skipped_news: number;
  skipped_noise: number;
  skipped_web_analytics: number;
  errors: Array<{ item_id: string; error: string }>;
}

interface MentionCandidate {
  raw: string;
  canonicalName: string;
  normalizedName: string;
  mentionOrdinal: number;
  spanStart: number | null;
  spanEnd: number | null;
  lineText: string;
  isListEntry: boolean;
  products: string[];
}

interface ExistingContext {
  companyId: string | null;
  dealId: string | null;
  relationshipStates: string[];
  isInternal: boolean;
  matchStrength: 'none' | 'name' | 'company_id';
}

interface Classification {
  direction: Direction;
  directionUncertain: boolean;
  mentionType: MentionType;
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
  provisional: boolean;
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
  reasoning: string | null;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
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
}

function emptyStats(items: number): ProspectDetectionStats {
  return {
    items_scanned: items,
    mentions_seen: 0,
    signals_recorded: 0,
    prospects_upserted: 0,
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

function canonicalizeMention(raw: string): { canonicalName: string; products: string[] } {
  const cleaned = normalizeWhitespace(raw)
    .replace(/^[\-*•\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[,:;]+$/g, '')
    .trim();
  const parts = cleaned.split(/\s+\/\s+/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    return { canonicalName: parts[0], products: parts.slice(1) };
  }
  return { canonicalName: cleaned, products: [] };
}

function isGenericCandidate(name: string): boolean {
  const normalized = normalizeProspectName(name);
  if (!normalized || normalized.length < 3) return true;
  return new Set([
    'hi', 'hello', 'thanks', 'thankyou', 'best', 'regards', 'forwarded',
    'subject', 'from', 'to', 'cc', 'date', 'team', 'fund', 'company',
    'meeting', 'call', 'deck', 'memo', 'newsletter', 'update',
  ]).has(normalized);
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

function inferDirection(item: ClassifiedItem, env: Env): DeterministicDirection {
  if (item.direction) return item.direction;
  if (item.type === 'news') return 'news';
  const internalDomains = getConfiguredInternalDomains(env);
  const fromInternal = isInternalEmailDomain(item.fromEmail, internalDomains);
  const recipients = [...(item.toEmails || []), ...(item.ccEmails || [])].filter(Boolean);
  if (fromInternal && recipients.length > 0 && recipients.every(email => isInternalEmailDomain(email, internalDomains))) return 'internal';
  if (fromInternal) return 'outbound';
  if (item.type === 'slack_message') return 'internal';
  return 'inbound';
}

function signalKindFor(item: ClassifiedItem, mention: MentionCandidate, hasDeck: boolean, hasMeeting: boolean): SignalKind {
  const haystack = `${item.subject || ''}\n${mention.lineText}\n${item.bodyPreview || ''}`.toLowerCase();
  if (hasDeck) return 'deck';
  if (hasMeeting) return item.type === 'calendar_event' ? 'meeting' : 'call';
  if (isWarmIntroSignal(item, mention)) return 'intro';
  if (/\b(raise|raising|round|seed|series [abc]|allocation|term sheet)\b/.test(haystack)) return 'raise';
  if (mention.isListEntry) return 'list_entry';
  return 'cold_mention';
}

function isWarmIntroSignal(item: ClassifiedItem, mention: MentionCandidate): boolean {
  const haystack = `${item.subject || ''}\n${mention.lineText}\n${item.bodyPreview || ''}`.toLowerCase();
  return /\b(intro|introducing|introduction|warm intro|meet\s+\w+)/.test(haystack);
}

function confidenceFor(kind: SignalKind, direction: DeterministicDirection, newsletter: boolean): { confidence: number; tier: ConfidenceTier; provisional: boolean } {
  if (newsletter) return { confidence: 0.25, tier: 'low', provisional: true };
  let confidence = 0.62;
  if (kind === 'meeting' || kind === 'call') confidence += 0.18;
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

function prospectClassifierModel(env: Env): string {
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

function parseSectorKey(value: unknown): SectorKey {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (PROSPECT_SECTOR_KEYS.has(normalized as any)) return normalized as SectorKey;
  throw new Error(`INVALID_LLM_SECTOR_KEY:${normalized || 'empty'}`);
}

function parseUnitConfidence(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`INVALID_LLM_${field.toUpperCase()}`);
  return n;
}

export function extractMentionCandidatesFromText(text: string, fallbackName?: string | null): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  let ordinal = 1;

  function push(raw: string, lineText: string, lineOffset: number | null, isListEntry: boolean): void {
    const { canonicalName, products } = canonicalizeMention(raw);
    if (isGenericCandidate(canonicalName)) return;
    const normalizedName = normalizeProspectName(canonicalName);
    if (!normalizedName || seen.has(normalizedName)) return;
    seen.add(normalizedName);
    const localIndex = lineText.indexOf(raw);
    const spanStart = lineOffset == null || localIndex < 0 ? null : lineOffset + localIndex;
    candidates.push({
      raw,
      canonicalName,
      normalizedName,
      mentionOrdinal: ordinal++,
      spanStart,
      spanEnd: spanStart == null ? null : spanStart + raw.length,
      lineText: lineText.slice(0, 500),
      isListEntry,
      products,
    });
  }

  const lines = text.split(/\n+/);
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 3) {
      offset += line.length + 1;
      continue;
    }
    const isListEntry = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    const slashName = trimmed.match(/^(?:[-*•]|\d+[.)])?\s*([A-Z][A-Za-z0-9&.'’-]+(?:\s+[A-Z][A-Za-z0-9&.'’-]+){0,3}(?:\s*\/\s*[A-Z][A-Za-z0-9&.'’-]+(?:\s+[A-Z][A-Za-z0-9&.'’-]+){0,3})+)(?:\s*(?:[-—–:|,]|\(|$))/);
    if (slashName) push(slashName[1], line, offset, isListEntry);

    const leading = trimmed.match(/^(?:[-*•]|\d+[.)])?\s*([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z][A-Za-z0-9&.'’/-]+){0,4})(?:\s*(?:[-—–:|,]|\s\/\s|\()\s*)/);
    if (leading) push(leading[1], line, offset, isListEntry);

    const raising = trimmed.match(/\b([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z][A-Za-z0-9&.'’/-]+){0,4})\s+(?:is|are|has|have)\s+(?:raising|building|launching|looking|seeking)\b/);
    if (raising) push(raising[1], line, offset, isListEntry);

    const intro = trimmed.match(/\b(?:intro(?:ducing)?|meet)\s+(?:to\s+|for\s+)?([A-Z][A-Za-z0-9&.'’/-]+(?:\s+[A-Z][A-Za-z0-9&.'’/-]+){0,4})\b/i);
    if (intro) push(intro[1], line, offset, isListEntry);

    if (candidates.length >= 12) break;
    offset += line.length + 1;
  }

  if (candidates.length === 0 && fallbackName) {
    push(fallbackName, fallbackName, null, false);
  }

  return candidates;
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

  if (item.companyId) {
    const direct = await env.D1.prepare(
      `SELECT id, name, domain, is_internal_entity
         FROM companies
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
    ).bind(item.companyId, orgId).first<{ id: string; name: string; domain: string | null; is_internal_entity: number | null }>();
    if (direct) candidates.push(direct);
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
  const match = Array.from(deduped.values()).find(c => normalizeProspectName(c.name) === mention.normalizedName);
  if (!match) return { companyId: null, dealId: null, relationshipStates: [], isInternal: false, matchStrength: 'none' };

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
    relationshipStates: relationships.results.map(r => r.relationship_state),
    isInternal: match.is_internal_entity === 1,
    matchStrength: item.companyId === match.id ? 'company_id' : 'name',
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
  const deterministicDirection = inferDirection(item, env);
  const newsletter = isNewsletterLike(item);
  const hasDeck = hasDeckSignal(item);
  const hasMeeting = hasMeetingSignal(item);
  const hasWarmIntro = isWarmIntroSignal(item, mention);
  const signalKind = signalKindFor(item, mention, hasDeck, hasMeeting);
  const sectorHint = sectorHintForText(`${mention.canonicalName}\n${mention.lineText}\n${item.subject || ''}\n${item.bodyPreview || ''}`);
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
  ].filter(Boolean);
  return compactClassifierText(parts.join(' | '), 900);
}

function rawExcerptForPrompt(item: ClassifiedItem, mention: MentionCandidate): string {
  const excerpt = [
    item.subject ? `Subject: ${item.subject}` : '',
    mention.lineText ? `Mention line: ${mention.lineText}` : '',
    item.bodyPreview ? `Preview: ${item.bodyPreview}` : '',
    item.bodyText || item.text || '',
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
      },
      crm_context: {
        matched_company_id: existing.companyId,
        matched_open_deal_id: existing.dealId,
        relationship_states: existing.relationshipStates,
        matched_internal_company: existing.isInternal,
        match_strength: existing.matchStrength,
      },
    },
  };
}

function buildProspectClassifierPrompt(input: ProspectClassifierInput): { system: string; user: string } {
  const knownDeals = entityListForPrompt(input.knownContext.knownDeals);
  const knownDealmakers = entityListForPrompt(input.knownContext.knownDealmakers);
  const prefilterHints = JSON.stringify(input.prefilterHints);
  const sectorHints = JSON.stringify(input.sectorHints);

  const system = `You classify one company-mention extracted from a single source item (an email, Slack
message, meeting-transcript chunk, or document) for Medina Ventures, a venture capital
firm. You output strict JSON and nothing else.

Fund context -- for SECTOR judgment only, NEVER for deciding whether something is a
prospect: Medina Ventures invests at seed and Series A in enterprise and government
backend software -- AI, quantum, and cybersecurity.

CRITICAL: Thesis fit does NOT determine prospect status. A company that is off-thesis
(consumer, hardware, defense hardware, etc.) is STILL an inbound_prospect if it is being
presented to the fund as an investment opportunity. Never downgrade or drop a prospect
for being off-thesis. Sector is captured separately.

Classify on three axes.

mention_type -- choose exactly one, using this decision order (first match wins):
  1. news          -- company named only informationally (newsletter, press, market
                     commentary); no one is proposing the fund engage it.
  2. intro_source  -- the person, firm, accelerator, or government channel making an
                     introduction or sending deal flow (NOT the company introduced).
  3. noise         -- vendor, fund admin, legal, internal ops, personal, OR a company
                     that is a commercial/customer/BD target rather than an investment
                     target.
     web_analytics -- a website-traffic or analytics record (a noise subtype).
  4. The named entity is a company in an investment context:
       known_deal       -- it is in the KNOWN list below (even if pitched outbound).
       inbound_prospect -- otherwise (regardless of thesis fit).

direction -- choose exactly one:
  inbound   -- an external party is presenting a company to the fund.
  outbound  -- the fund is reaching out (e.g., pitching a portfolio company to a customer).
  internal  -- fund-internal communication.
  news      -- informational, no pitch.

sector_key -- choose exactly one by the company's PRIMARY value proposition; if genuinely
unclear, "uncategorized":
  ${PROSPECT_SECTOR_LABELS}
Also output sector_confidence in [0,1].

KNOWN deals / portfolio (names + domains): ${knownDeals}
KNOWN dealmakers / intro sources (names + domains): ${knownDealmakers}

Hints (heuristic pre-filter and sector hints -- WEAK signals, not ground truth; override
them when the content disagrees): ${prefilterHints} ${sectorHints}

Provisional examples until the gold-set dev split exists:
Auguria with intro + deck -> {"mention_type":"inbound_prospect","direction":"inbound","sector_key":"cybersecurity","sector_confidence":0.9,"confidence":0.95,"reasoning":"Introduced as an investment opportunity with a deck."}
Qunnect pitched to Mastercard -> {"mention_type":"known_deal","direction":"outbound","sector_key":"quantum","sector_confidence":0.9,"confidence":0.95,"reasoning":"Known portfolio/deal company being pitched outbound."}
Mastercard in the Qunnect customer thread -> {"mention_type":"noise","direction":"outbound","sector_key":"fintech","sector_confidence":0.75,"confidence":0.9,"reasoning":"Commercial customer target, not an investment prospect."}
Anthropic in an NVCA fundraise newsletter -> {"mention_type":"news","direction":"news","sector_key":"ai_data","sector_confidence":0.85,"confidence":0.92,"reasoning":"Informational fundraise news only."}
DIU sending ArmyFUZE deal flow -> {"mention_type":"intro_source","direction":"inbound","sector_key":"uncategorized","sector_confidence":0.2,"confidence":0.9,"reasoning":"Government channel forwarding deal flow."}
Sativa hempcrete in an ArmyFUZE list -> {"mention_type":"inbound_prospect","direction":"inbound","sector_key":"materials_manufacturing","sector_confidence":0.85,"confidence":0.9,"reasoning":"Off-thesis but presented as an investment opportunity."}

Output ONLY this JSON object, no prose, no code fences:
{"mention_type":"...","direction":"...","sector_key":"...","sector_confidence":0.0,"confidence":0.0,"reasoning":"one short sentence"}
confidence is your overall confidence in the mention_type + direction call, in [0,1].`;

  const user = `SOURCE_TYPE: ${input.sourceType}
FROM / CONTEXT: ${input.senderAndContext}
MENTION (the company in question): ${input.companyName}
EXCERPT:
${input.rawExcerpt}`;

  return { system, user };
}

function parseProspectClassifierResponse(
  raw: string,
  model: string,
  usage?: { input_tokens: number; output_tokens: number }
): LlmClassifierDecision {
  const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
  return {
    mentionType: parseMentionType(parsed.mention_type),
    direction: parseDirection(parsed.direction),
    sectorKey: parseSectorKey(parsed.sector_key),
    sectorConfidence: parseUnitConfidence(parsed.sector_confidence, 'sector_confidence'),
    confidence: parseUnitConfidence(parsed.confidence, 'confidence'),
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
  const model = prospectClassifierModel(env);
  const prompt = buildProspectClassifierPrompt(input);
  const result = await callClaudeWithUsage(
    { system: prompt.system, user: prompt.user, max_tokens: 500, orgId: input.orgId, model },
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
  const portfolio = existing.relationshipStates.includes('current_portfolio') || existing.relationshipStates.includes('exited');
  const directionUncertain =
    prefilter.deterministicDirection !== 'unknown' &&
    prefilter.deterministicDirection !== llm.direction;

  let possibleCompanyId: string | null = null;
  let possibleDealId: string | null = null;
  let provisional = llm.confidence < 0.82 || directionUncertain;

  if (llm.mentionType === 'inbound_prospect') {
    possibleCompanyId = existing.companyId;
    possibleDealId = existing.dealId && existing.matchStrength !== 'company_id' ? existing.dealId : null;
    if (possibleDealId) provisional = true;
  }

  return {
    direction: llm.direction,
    directionUncertain,
    mentionType: llm.mentionType,
    confidence: llm.confidence,
    confidenceTier: confidenceTierFor(llm.confidence),
    sectorKey: llm.sectorKey,
    sectorConfidence: llm.sectorConfidence,
    signalKind: prefilter.signalKind,
    hasDeck: prefilter.hasDeck,
    hasMeeting: prefilter.hasMeeting,
    hasWarmIntro: prefilter.hasWarmIntro,
    dealmakerName: prefilter.hasWarmIntro ? normalizeWhitespace(item.fromName || item.fromEmail || '') : null,
    possibleCompanyId,
    possibleDealId,
    provisional,
    metadata: {
      classifier: 'llm_req_cl',
      classifier_model: llm.model,
      llm_reasoning: llm.reasoning,
      llm_usage: llm.usage || null,
      prefilter,
      products: mention.products,
      from_domain: emailDomain(item.fromEmail),
      source_direction: item.direction || null,
      deterministic_direction: prefilter.deterministicDirection,
      deterministic_direction_disagreed: directionUncertain,
      deterministic_portfolio_hint: portfolio,
    },
  };
}

function prospectSourceType(item: ClassifiedItem): SourceType | null {
  if (item.entityType === 'event') return 'event';
  if (item.entityType === 'conversation') return 'conversation';
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
    JSON.stringify({ products: mention.products })
  ).run();

  const row = await env.D1.prepare(
    `SELECT id FROM prospects WHERE org_id = ? AND normalized_name = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(orgId, mention.normalizedName).first<{ id: string }>();
  if (!row?.id) throw new Error('PROSPECT_UPSERT_FAILED');
  return row.id;
}

async function upsertSignal(args: {
  orgId: string;
  prospectId: string | null;
  sourceType: SourceType;
  sourceId: string;
  sourceTitle: string | null;
  occurredAt: string;
  mention: MentionCandidate;
  cls: Classification;
  dealmakerId: string | null;
  dealmakerName: string | null;
  ingestionMode: 'live' | 'backfill';
}, env: Env): Promise<{ insertedOrUpdated: boolean }> {
  const before = await env.D1.prepare(
    `SELECT id, mention_type, direction, sector_key, confidence, classifier_version, prospect_id
       FROM prospect_signals
      WHERE org_id = ? AND source_type = ? AND source_id = ? AND mention_ordinal = ?
      LIMIT 1`
  ).bind(args.orgId, args.sourceType, args.sourceId, args.mention.mentionOrdinal).first<{
    id: string; mention_type: string; direction: string; sector_key: string; confidence: number; classifier_version: string; prospect_id: string | null;
  }>();

  const signalId = before?.id || crypto.randomUUID();
  const newClassification = {
    mention_type: args.cls.mentionType,
    direction: args.cls.direction,
    sector_key: args.cls.sectorKey,
    confidence: args.cls.confidence,
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    prospect_id: args.prospectId,
  };

  await env.D1.prepare(
    `INSERT INTO prospect_signals (
       id, org_id, prospect_id, source_type, source_id, mention_ordinal,
       span_start, span_end, raw_mention_text, normalized_mention, source_title,
       occurred_at, direction, direction_source, direction_uncertain,
       mention_type, classifier_version, confidence, confidence_tier,
       sector_key, sector_confidence, signal_kind, dealmaker_id, dealmaker_name,
       has_deck, has_meeting, ingestion_mode, metadata_json, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
       prospect_id = excluded.prospect_id,
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
    before.prospect_id !== args.prospectId
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

  return { insertedOrUpdated: true };
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
    hasMeeting: signals.some(s => s.has_meeting === 1 || s.signal_kind === 'meeting' || s.signal_kind === 'call'),
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
            signal_strength_score = ?,
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

  for (const item of items) {
    const sourceType = prospectSourceType(item);
    if (!sourceType) continue;
    try {
      const fallbackName = await companyNameFor(item.companyId, orgId, env);
      const mentions = extractMentionCandidatesFromText(`${item.subject || ''}\n${item.bodyText || ''}`, fallbackName);
      stats.mentions_seen += mentions.length;
      for (const mention of mentions) {
        const existing = await lookupExistingContext(mention, item, orgId, env);
        const cls = await classifyMention(item, mention, existing, knownContext, orgId, env);
        const occurredAt = item.sentAt || new Date().toISOString();
        let prospectId: string | null = null;
        let dealmaker: { id: string | null; name: string | null } = { id: null, name: null };

        if (cls.mentionType === 'inbound_prospect') {
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
          stats.skipped_known_deal++;
        } else if (cls.mentionType === 'news') {
          stats.skipped_news++;
        } else if (cls.mentionType === 'noise') {
          stats.skipped_noise++;
        } else if (cls.mentionType === 'web_analytics') {
          stats.skipped_web_analytics++;
        }

        await upsertSignal({
          orgId,
          prospectId,
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
    status: 'completed' | 'partial' | 'failed';
    error?: string | null;
  }
): Promise<void> {
  await env.D1.prepare(
    `INSERT INTO prospect_backfill_coverage (
       id, org_id, run_id, source_family, window_start, window_end,
       status, items_scanned, signals_recorded, prospects_upserted,
       started_at, completed_at, error_message, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
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
    input.error || null
  ).run();
}

export async function runProspectReconciliation(orgId: string, env: Env): Promise<{ scanned: number; converted: number; duplicate_links: number }> {
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
  }

  return { scanned: rows.results.length, converted, duplicate_links: duplicateLinks };
}

export const __prospectIntelligenceTestHooks = {
  normalizeProspectName,
  extractMentionCandidatesFromText,
  computeSignalStrength,
  sectorHintForText,
  buildClassifierPrefilter,
  buildProspectClassifierPrompt,
  classifierInputForRuntime,
  parseProspectClassifierResponse,
  parseDirection,
  parseMentionType,
  parseSectorKey,
};

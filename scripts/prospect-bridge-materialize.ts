#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import { mergeContacts } from '../src/lib/merge';
import {
  createProspectOriginCompany,
  ensureInvestmentProspectTag as ensureProspectCompanyTag,
  mergeProspects,
  normalizeProspectName,
  upsertEntityIdentityAliases,
} from '../src/lib/prospect-intelligence';
import { registrableDomain } from '../src/lib/discovery';
import type { Env } from '../src/types/env';

export const PROSPECT_BRIDGE_CONFIRMATION_TOKEN = 'PROSPECT_BRIDGE_MATERIALIZE_PRODUCTION_GO';

const ALIAS_PREFIXES = ['hello', 'get', 'try', 'use', 'join', 'go', 'ask'];
const STRONG_STATUSES = new Set(['due_diligence', 'term_sheet', 'invested', 'passed', 'exited']);
const PLACEHOLDER_STATUSES = new Set(['', 'tracking', 'placeholder', 'unknown', 'none', 'null']);

interface Args {
  orgId: string;
  configPath: string;
  windowDays: number;
  since: string | null;
  until: string | null;
  prospectIds: string[];
  apply: boolean;
  confirmProductionWrite: string | null;
  outDir: string | null;
  limit: number;
  remoteD1: boolean;
  d1Database: string;
}

export interface BridgeProspectRow {
  id: string;
  org_id: string;
  canonical_name: string;
  normalized_name: string;
  domain: string | null;
  website?: string | null;
  status: string;
  confidence: number | null;
  provisional: number | null;
  direction_uncertain?: number | null;
  company_id: string | null;
  possible_company_id: string | null;
  deal_id: string | null;
  possible_deal_id: string | null;
  metadata_json: string | null;
  custom_fields?: string | null;
  signal_count?: number | null;
  evidence_count?: number | null;
  last_signal_at?: string | null;
  first_seen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
}

export interface BridgeSignalRow {
  id: string;
  org_id: string;
  prospect_id: string | null;
  company_id?: string | null;
  deal_id: string | null;
  source_type: string;
  source_id: string;
  source_title: string | null;
  raw_mention_text: string | null;
  normalized_mention: string | null;
  occurred_at: string;
  mention_type: string;
  signal_kind: string | null;
  confidence: number | null;
  metadata_json: string | null;
}

export interface BridgeCompanyRow {
  id: string;
  org_id: string;
  name: string;
  domain: string | null;
  website: string | null;
  investment_status: string | null;
  custom_fields: string | null;
  deleted_at?: string | null;
  merged_into?: string | null;
  total_interactions?: number | null;
  contacts_count?: number | null;
  deals_count?: number | null;
  documents_count?: number | null;
  tags_count?: number | null;
  human_edits_count?: number | null;
}

export interface BridgeDealRow {
  id: string;
  org_id: string;
  company_id: string | null;
  title: string | null;
  stage: string | null;
  deleted_at?: string | null;
}

export interface ContactRow {
  id: string;
  org_id: string;
  full_name: string;
  email: string | null;
  company_id: string | null;
  deleted_at?: string | null;
}

export interface CandidateDecision {
  company: BridgeCompanyRow;
  score: number;
  method: string;
  reasons: string[];
  blocked: boolean;
  block_reason: string | null;
}

export interface ProspectMaterializationDecision {
  prospect_id: string;
  prospect_name: string;
  action: 'finalize' | 'create_company' | 'already_finalized' | 'dedupe_pending' | 'needs_review' | 'skip';
  selected_company_id: string | null;
  selected_company_name: string | null;
  score: number;
  method: string | null;
  reasons: string[];
  evidence: {
    prospect_domain: string | null;
    repaired_domain: string | null;
    signal_count: number;
    source_titles: string[];
    confidence: number;
    possible_company_id: string | null;
    possible_deal_id: string | null;
    deal_id: string | null;
    target_company_kind: 'existing' | 'new' | null;
    company_card_quality?: 'verified' | 'limited_info' | null;
  };
  rejected_candidates: Array<{ company_id: string; name: string; score: number; method: string; reasons: string[] }>;
  review_reason: string | null;
}

export interface DedupeDecision {
  entity_type: 'prospect' | 'company' | 'contact' | 'deal';
  action: 'merge' | 'flag';
  winner_id: string | null;
  loser_id: string | null;
  score: number;
  method: string;
  reason: string;
  applied: boolean;
  rollback_pointer?: string | null;
}

export interface ProspectBridgeSummary {
  dry_run: boolean;
  org_id: string;
  window_start: string;
  window_end: string;
  scanned_prospects: number;
  materialized_links: number;
  existing_company_links: number;
  created_companies: number;
  signal_backfills: number;
  repaired_domains: number;
  company_updates: number;
  prospect_merges: number;
  company_merges: number;
  contact_merges: number;
  deal_conflicts: number;
  needs_review: number;
  artifact_dir: string;
}

export interface ProspectBridgeRunResult {
  manifest: ProspectBridgeSummary;
  materializationDecisions: ProspectMaterializationDecision[];
  dedupeDecisions: DedupeDecision[];
  needsReview: ProspectMaterializationDecision[];
}

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
  const windowDays = Number(raw.get('window-days') || raw.get('days') || 7);
  const limit = Number(raw.get('limit') || 10_000);
  if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 30) throw new Error('INVALID_WINDOW_DAYS');
  if (!Number.isFinite(limit) || limit < 1) throw new Error('INVALID_LIMIT');
  const prospectIds = (raw.get('prospect-ids') || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    windowDays: Math.floor(windowDays),
    since: raw.get('since') || null,
    until: raw.get('until') || null,
    prospectIds,
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
    outDir: raw.get('out-dir') || null,
    limit: Math.floor(limit),
    remoteD1: raw.get('remote-d1') === 'true',
    d1Database: raw.get('d1-database') || 'medina-ventures-db',
  };
}

class RemoteD1Statement {
  private binds: unknown[] = [];

  constructor(
    private readonly database: string,
    private readonly sql: string,
    private readonly allowWrites: boolean
  ) {}

  bind(...args: unknown[]): RemoteD1Statement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    const payload = runRemoteD1(this.database, bindSql(this.sql, this.binds), this.allowWrites);
    return { results: (payload?.results || []) as T[] };
  }

  async first<T = any>(): Promise<T | null> {
    const rows = await this.all<T>();
    return rows.results[0] || null;
  }

  async run(): Promise<any> {
    return runRemoteD1(this.database, bindSql(this.sql, this.binds), this.allowWrites);
  }
}

function remoteD1Env(database: string, allowWrites = false): Env {
  return {
    D1: {
      prepare(sql: string) {
        return new RemoteD1Statement(database, sql, allowWrites);
      },
      async batch(statements: Array<{ run: () => Promise<any> }>) {
        const results: any[] = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    },
  } as unknown as Env;
}

function bindSql(sql: string, binds: unknown[]): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    if (index >= binds.length) throw new Error('REMOTE_D1_BIND_UNDERFLOW');
    return sqlLiteral(binds[index++]);
  });
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('REMOTE_D1_INVALID_NUMBER_BIND');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runRemoteD1(database: string, sql: string, allowWrites = false): any {
  if (!allowWrites && !/^\s*SELECT\b/i.test(sql) && !/^\s*PRAGMA\s+table_info\b/i.test(sql)) {
    throw new Error(`REMOTE_D1_READ_ONLY_VIOLATION:${sql.slice(0, 120)}`);
  }
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.success) throw new Error(`REMOTE_D1_QUERY_FAILED:${out.slice(0, 500)}`);
  return first;
}

function readOnlyEnv(env: Env): Env {
  return {
    ...(env as any),
    D1: {
      ...(env.D1 as any),
      prepare(sql: string) {
        if (!/^\s*SELECT\b/i.test(sql) && !/^\s*PRAGMA\s+table_info\b/i.test(sql)) {
          throw new Error(`PROSPECT_BRIDGE_DRY_RUN_READ_ONLY_VIOLATION:${sql.slice(0, 120)}`);
        }
        return env.D1.prepare(sql);
      },
      async batch() {
        throw new Error('PROSPECT_BRIDGE_DRY_RUN_READ_ONLY_VIOLATION:batch');
      },
    },
  } as Env;
}

function normalizeDomain(raw: string | null | undefined): string | null {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  const withoutScheme = text.replace(/^https?:\/\//, '').replace(/^mailto:/, '').replace(/^www\./, '');
  const host = withoutScheme.split(/[/?#]/)[0].replace(/^www\./, '').trim();
  if (!host || !host.includes('.') || host.includes('@')) return null;
  return registrableDomain(host);
}

function domainStem(domain: string | null | undefined): string {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  return normalized.split('.')[0].replace(/[^a-z0-9]+/g, '');
}

function aliasSet(name: string | null | undefined, domain?: string | null, website?: string | null): Set<string> {
  const aliases = new Set<string>();
  const normalizedName = normalizeProspectName(name || '');
  if (normalizedName.length >= 3) aliases.add(normalizedName);
  const stem = domainStem(domain || website || null);
  if (stem.length >= 3) {
    aliases.add(normalizeProspectName(stem));
    for (const prefix of ALIAS_PREFIXES) {
      if (stem.startsWith(prefix) && stem.length - prefix.length >= 4) {
        aliases.add(normalizeProspectName(stem.slice(prefix.length)));
      }
    }
  }
  return aliases;
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function safeJson(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function metadataDomain(prospect: BridgeProspectRow): string | null {
  const metadata = safeJson(prospect.metadata_json);
  return normalizeDomain(
    metadata?.identity_dedupe?.domain ||
    metadata?.company_identity?.domain ||
    metadata?.domain ||
    null
  );
}

function isPlaceholderDomainForProspect(prospect: BridgeProspectRow, domain: string | null, signalTitles: string[]): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return true;
  const metaDomain = metadataDomain(prospect);
  if (metaDomain && metaDomain !== normalized) return true;
  const prospectAlias = aliasSet(prospect.canonical_name, metaDomain || prospect.website || null);
  const domainAlias = aliasSet(null, normalized);
  if (prospectAlias.size > 0 && !setsIntersect(prospectAlias, domainAlias)) return true;
  const joinedTitles = signalTitles.join(' ').toLowerCase();
  if (joinedTitles && !joinedTitles.includes(domainStem(normalized)) && metaDomain) return true;
  return false;
}

function candidateForCompany(
  prospect: BridgeProspectRow,
  company: BridgeCompanyRow,
  signals: BridgeSignalRow[],
  possibleCompanyIds: Set<string>,
  dealCompanyIds: Set<string>
): CandidateDecision | null {
  const prospectDomain = metadataDomain(prospect) || normalizeDomain(prospect.domain || prospect.website || null);
  const companyDomain = normalizeDomain(company.domain || company.website);
  const prospectAliases = aliasSet(prospect.canonical_name, prospectDomain);
  const companyAliases = aliasSet(company.name, companyDomain, company.website);
  const reasons: string[] = [];
  let score = 0;
  let method = '';

  if (possibleCompanyIds.has(company.id)) {
    score = Math.max(score, 0.86);
    method = 'prior_possible_company';
    reasons.push('prior possible company link');
  }
  if (dealCompanyIds.has(company.id)) {
    score = Math.max(score, 0.96);
    method = 'deal_company_link';
    reasons.push('deal-backed company link');
  }
  if (prospectDomain && companyDomain && prospectDomain === companyDomain) {
    score = 1;
    method = 'exact_domain';
    reasons.push('exact domain');
  }
  if (prospect.normalized_name && normalizeProspectName(company.name) === prospect.normalized_name) {
    const nameScore = companyDomain && prospectDomain && companyDomain !== prospectDomain ? 0.82 : 0.94;
    if (nameScore > score) {
      score = nameScore;
      method = 'exact_normalized_name';
    }
    reasons.push('exact normalized name');
  }
  if (setsIntersect(prospectAliases, companyAliases)) {
    const aliasScore = companyDomain || prospectDomain ? 0.95 : 0.92;
    if (aliasScore > score) {
      score = aliasScore;
      method = 'domain_brand_alias';
    }
    reasons.push('domain-brand alias');
  }

  if (score === 0) return null;

  const sourceTitles = signals.map(s => s.source_title || '').filter(Boolean);
  const conflictingDomains = Boolean(
    prospectDomain &&
    companyDomain &&
    prospectDomain !== companyDomain &&
    !isPlaceholderDomainForProspect(prospect, prospectDomain, sourceTitles)
  );
  const blocked = conflictingDomains;
  return {
    company,
    score,
    method,
    reasons,
    blocked,
    block_reason: blocked ? `conflicting domains prospect=${prospectDomain} company=${companyDomain}` : null,
  };
}

function candidateRank(candidate: CandidateDecision): number {
  const c = candidate.company;
  let rank = candidate.score * 100;
  rank += Number(c.deals_count || 0) * 4;
  rank += Number(c.contacts_count || 0) * 3;
  rank += Number(c.documents_count || 0) * 2;
  rank += Number(c.tags_count || 0);
  rank += Number(c.human_edits_count || 0) * 5;
  if (normalizeDomain(c.domain || c.website)) rank += 8;
  if (!c.deleted_at && !c.merged_into) rank += 4;
  return rank;
}

export function decideProspectMaterialization(
  prospect: BridgeProspectRow,
  signals: BridgeSignalRow[],
  companies: BridgeCompanyRow[],
  deals: BridgeDealRow[]
): ProspectMaterializationDecision {
  if (prospect.company_id) {
    const company = companies.find(c => c.id === prospect.company_id) || null;
    return {
      prospect_id: prospect.id,
      prospect_name: prospect.canonical_name,
      action: 'already_finalized',
      selected_company_id: prospect.company_id,
      selected_company_name: company?.name || null,
      score: 1,
      method: 'existing_company_id',
      reasons: ['prospect already has finalized company_id'],
      evidence: decisionEvidence(prospect, signals, null, 'existing'),
      rejected_candidates: [],
      review_reason: null,
    };
  }

  const possibleCompanyIds = new Set<string>();
  const dealCompanyIds = new Set<string>();
  if (prospect.possible_company_id) possibleCompanyIds.add(prospect.possible_company_id);
  for (const id of [prospect.deal_id, prospect.possible_deal_id]) {
    const deal = deals.find(row => row.id === id);
    if (deal?.company_id) dealCompanyIds.add(deal.company_id);
  }

  const candidates = companies
    .map(company => candidateForCompany(prospect, company, signals, possibleCompanyIds, dealCompanyIds))
    .filter((candidate): candidate is CandidateDecision => Boolean(candidate))
    .sort((a, b) => candidateRank(b) - candidateRank(a));

  const selected = candidates.find(candidate => !candidate.blocked && candidate.score >= 0.92) || null;
  const repairedDomain = domainRepairForProspect(prospect, selected?.company || null, signals);
  if (!selected) {
    const createDecision = createCompanyDecisionForProspect(prospect, signals, candidates, repairedDomain);
    if (createDecision) return createDecision;
    return {
      prospect_id: prospect.id,
      prospect_name: prospect.canonical_name,
      action: 'needs_review',
      selected_company_id: null,
      selected_company_name: null,
      score: candidates[0]?.score || 0,
      method: candidates[0]?.method || null,
      reasons: candidates[0]?.reasons || [],
      evidence: decisionEvidence(prospect, signals, repairedDomain, null),
      rejected_candidates: candidates.map(rejectedCandidate),
      review_reason: candidates[0]?.block_reason || 'no high-confidence unblocked company match',
    };
  }

  return {
    prospect_id: prospect.id,
    prospect_name: prospect.canonical_name,
    action: 'finalize',
    selected_company_id: selected.company.id,
    selected_company_name: selected.company.name,
    score: selected.score,
    method: selected.method,
    reasons: selected.reasons,
    evidence: decisionEvidence(prospect, signals, repairedDomain, 'existing'),
    rejected_candidates: candidates.filter(c => c.company.id !== selected.company.id).map(rejectedCandidate),
    review_reason: null,
  };
}

function createCompanyDecisionForProspect(
  prospect: BridgeProspectRow,
  signals: BridgeSignalRow[],
  candidates: CandidateDecision[],
  repairedDomain: string | null
): ProspectMaterializationDecision | null {
  const gate = createCompanyGate(prospect, signals);
  const strongCandidate = candidates.find(candidate => candidate.score >= 0.92);
  if (strongCandidate) return null;
  const targetDomain = repairedDomain || metadataDomain(prospect) || normalizeDomain(prospect.domain || prospect.website || null);
  if (!gate.allowed) {
    const limitedGate = createLimitedInfoCompanyGate(prospect, signals, gate);
    if (!limitedGate.allowed) return null;
    return {
      prospect_id: prospect.id,
      prospect_name: prospect.canonical_name,
      action: 'create_company',
      selected_company_id: null,
      selected_company_name: prospect.canonical_name,
      score: limitedGate.score,
      method: targetDomain ? 'create_company_limited_info_domain' : 'create_company_limited_info',
      reasons: candidates.length > 0
        ? [...limitedGate.reasons, 'ignored weak existing-company candidates']
        : limitedGate.reasons,
      evidence: decisionEvidence(
        prospect,
        signals,
        targetDomain && targetDomain !== normalizeDomain(prospect.domain) ? targetDomain : repairedDomain,
        'new',
        'limited_info'
      ),
      rejected_candidates: candidates.map(rejectedCandidate),
      review_reason: null,
    };
  }
  return {
    prospect_id: prospect.id,
    prospect_name: prospect.canonical_name,
    action: 'create_company',
    selected_company_id: null,
    selected_company_name: prospect.canonical_name,
    score: gate.score,
    method: targetDomain ? 'create_company_own_domain' : 'create_company_clean_signals',
    reasons: candidates.length > 0
      ? [...gate.reasons, 'ignored weak existing-company candidates']
      : gate.reasons,
    evidence: decisionEvidence(
      prospect,
      signals,
      targetDomain && targetDomain !== normalizeDomain(prospect.domain) ? targetDomain : repairedDomain,
      'new',
      'verified'
    ),
    rejected_candidates: candidates.map(rejectedCandidate),
    review_reason: null,
  };
}

function createCompanyGate(prospect: BridgeProspectRow, signals: BridgeSignalRow[]): { allowed: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const confidence = Number(prospect.confidence || 0);
  if (!['active', 'converted'].includes(String(prospect.status || ''))) return { allowed: false, score: 0, reasons: ['not active/converted'] };
  if (Number(prospect.provisional || 0) === 1) return { allowed: false, score: 0, reasons: ['provisional prospect'] };
  if (Number(prospect.direction_uncertain || 0) === 1) return { allowed: false, score: 0, reasons: ['direction uncertain'] };
  if (signals.length === 0) return { allowed: false, score: confidence, reasons: ['no linked prospect signals'] };
  if (confidence < 0.85) return { allowed: false, score: confidence, reasons: ['confidence below create-company threshold'] };

  const normalizedName = normalizeProspectName(prospect.canonical_name);
  if (normalizedName.length < 3) return { allowed: false, score: confidence, reasons: ['weak company name'] };

  const metaDomain = metadataDomain(prospect);
  const domain = metaDomain || normalizeDomain(prospect.domain || prospect.website || null);
  const hasOwnDomain = Boolean(domain && (metaDomain === domain || setsIntersect(aliasSet(prospect.canonical_name), aliasSet(null, domain))));
  if (hasOwnDomain) reasons.push('own-domain identity anchor');

  const cleanSignals = signals.filter(signal => signalIsCleanCompanyEvidence(signal));
  if (cleanSignals.length >= 2) reasons.push('multiple clean prospect signals');
  const listOnly = signals.length > 0 && signals.every(signal => signalIsListOrReportOnly(signal));
  if (listOnly) return { allowed: false, score: confidence, reasons: ['list/report-only evidence'] };

  const allowed = hasOwnDomain || cleanSignals.length >= 2;
  return { allowed, score: allowed ? Math.max(confidence, hasOwnDomain ? 0.93 : 0.9) : confidence, reasons };
}

function createLimitedInfoCompanyGate(
  prospect: BridgeProspectRow,
  signals: BridgeSignalRow[],
  strictGate: { allowed: boolean; score: number; reasons: string[] }
): { allowed: boolean; score: number; reasons: string[] } {
  const confidence = Number(prospect.confidence || 0);
  if (!['active', 'converted'].includes(String(prospect.status || ''))) {
    return { allowed: false, score: 0, reasons: ['not active/converted'] };
  }
  const provenProspectWithoutLinkedSignal = signals.length === 0 && isProvenProspectRecord(prospect);
  if (signals.length === 0 && !provenProspectWithoutLinkedSignal) {
    return { allowed: false, score: confidence, reasons: ['no linked prospect signals'] };
  }
  if (confidence < 0.85) return { allowed: false, score: confidence, reasons: ['confidence below limited-info threshold'] };

  const normalizedName = normalizeProspectName(prospect.canonical_name);
  if (normalizedName.length < 3) return { allowed: false, score: confidence, reasons: ['weak company name'] };

  const domain = metadataDomain(prospect) || normalizeDomain(prospect.domain || prospect.website || null);
  const sourceTitles = signals.map(signal => signal.source_title || '').filter(Boolean);
  const hasSourceEvidence = sourceTitles.length > 0 || signals.some(signal => String(signal.raw_mention_text || '').trim());
  if (!domain && !hasSourceEvidence && !provenProspectWithoutLinkedSignal) {
    return { allowed: false, score: confidence, reasons: ['no domain or source evidence'] };
  }

  const reasons = [
    'limited-info prospect card',
    ...strictGate.reasons.filter(reason => !['provisional prospect', 'direction uncertain', 'no linked prospect signals'].includes(reason)),
  ];
  if (domain) reasons.push('domain/name available but not enough for verified match');
  if (Number(prospect.provisional || 0) === 1) reasons.push('provisional prospect');
  if (Number(prospect.direction_uncertain || 0) === 1) reasons.push('direction uncertain');
  if (signals.length > 0 && signals.every(signal => signalIsListOrReportOnly(signal))) {
    reasons.push('list/report-only evidence retained as limited info');
  }
  if (provenProspectWithoutLinkedSignal) reasons.push('proven prospect row without linked signal');

  return {
    allowed: true,
    score: Math.max(confidence, domain ? 0.86 : 0.84),
    reasons: [...new Set(reasons)],
  };
}

function isProvenProspectRecord(prospect: BridgeProspectRow): boolean {
  const confidence = Number(prospect.confidence || 0);
  if (confidence < 0.9) return false;
  if (Number(prospect.provisional || 0) === 1) return false;
  if (Number(prospect.direction_uncertain || 0) === 1) return false;
  const metadata = safeJson(prospect.metadata_json);
  if (metadata?.prospect_action !== 'create_prospect') return false;
  return Number(prospect.signal_count || 0) > 0 ||
    Number(prospect.evidence_count || 0) > 0 ||
    Boolean(prospect.last_signal_at);
}

function signalIsCleanCompanyEvidence(signal: BridgeSignalRow): boolean {
  const title = String(signal.source_title || '').toLowerCase();
  if (signalIsListOrReportOnly(signal)) return false;
  if (!['inbound_prospect', 'known_deal'].includes(String(signal.mention_type || ''))) return false;
  if (Number(signal.confidence || 0) < 0.82) return false;
  return ['deck', 'intro', 'meeting', 'raise'].includes(String(signal.signal_kind || ''));
}

function signalIsListOrReportOnly(signal: BridgeSignalRow): boolean {
  const title = String(signal.source_title || '').toLowerCase();
  return String(signal.signal_kind || '') === 'list_entry' ||
    title.includes('automatic_report') ||
    title.includes('pipeline status update') ||
    title.includes('pipeline industry pie') ||
    title.includes('claim your seat');
}

function rejectedCandidate(candidate: CandidateDecision): ProspectMaterializationDecision['rejected_candidates'][number] {
  return {
    company_id: candidate.company.id,
    name: candidate.company.name,
    score: candidate.score,
    method: candidate.method,
    reasons: candidate.block_reason ? [...candidate.reasons, candidate.block_reason] : candidate.reasons,
  };
}

function domainRepairForProspect(
  prospect: BridgeProspectRow,
  selectedCompany: BridgeCompanyRow | null,
  signals: BridgeSignalRow[]
): string | null {
  const current = normalizeDomain(prospect.domain);
  const meta = metadataDomain(prospect);
  const companyDomain = normalizeDomain(selectedCompany?.domain || selectedCompany?.website || null);
  const titles = signals.map(s => s.source_title || '').filter(Boolean);
  const best = meta || companyDomain;
  if (!best) return null;
  if (!current) return best;
  if (current === best) return null;
  return isPlaceholderDomainForProspect(prospect, current, titles) ? best : null;
}

function decisionEvidence(
  prospect: BridgeProspectRow,
  signals: BridgeSignalRow[],
  repairedDomain: string | null,
  targetCompanyKind: 'existing' | 'new' | null,
  companyCardQuality: 'verified' | 'limited_info' | null = targetCompanyKind ? 'verified' : null
): ProspectMaterializationDecision['evidence'] {
  return {
    prospect_domain: normalizeDomain(prospect.domain),
    repaired_domain: repairedDomain,
    signal_count: signals.length,
    source_titles: [...new Set(signals.map(s => s.source_title || '').filter(Boolean))].slice(0, 10),
    confidence: Number(prospect.confidence || 0),
    possible_company_id: prospect.possible_company_id,
    possible_deal_id: prospect.possible_deal_id,
    deal_id: prospect.deal_id,
    target_company_kind: targetCompanyKind,
    company_card_quality: companyCardQuality,
  };
}

export function shouldPromoteInvestmentStatus(status: string | null | undefined): boolean {
  const normalized = String(status || '').trim().toLowerCase();
  return PLACEHOLDER_STATUSES.has(normalized) && !STRONG_STATUSES.has(normalized);
}

function customFieldsWithProspectOrigin(raw: string | null | undefined, decision: ProspectMaterializationDecision): string {
  const custom = safeJson(raw);
  const limitedInfo = decision.evidence.company_card_quality === 'limited_info';
  custom.prospect_origin = {
    source: 'prospect_bridge_materialization',
    prospect_id: decision.prospect_id,
    method: decision.method,
    score: decision.score,
    limited_info: limitedInfo,
    signal_count: decision.evidence.signal_count,
    source_titles: decision.evidence.source_titles.slice(0, 5),
    evidence_quality: decision.evidence.company_card_quality || null,
    materialized_at: new Date().toISOString(),
  };
  if (limitedInfo) {
    custom.limited_info_prospect = {
      status: 'limited_info',
      reason: 'picked_up_as_prospect_without_strong_existing_company_match',
      source_titles: decision.evidence.source_titles.slice(0, 5),
      created_at: new Date().toISOString(),
    };
    custom.enrichment_guard = custom.enrichment_guard || {
      status: decision.evidence.prospect_domain || decision.evidence.repaired_domain
        ? 'limited_info'
        : 'blocked_insufficient_anchor',
      reason: decision.evidence.prospect_domain || decision.evidence.repaired_domain
        ? 'limited_info_prospect'
        : 'missing_verified_domain',
    };
  }
  return jsonString(custom);
}

function metadataWithResolution(raw: string | null | undefined, decision: ProspectMaterializationDecision): string {
  const metadata = safeJson(raw);
  metadata.company_resolution = {
    action: decision.action,
    selected_company_id: decision.selected_company_id,
    match_method: decision.method,
    match_score: decision.score,
    reasons: decision.reasons,
    rejected_candidates: decision.rejected_candidates,
    evidence: decision.evidence,
    rollback_pointer: ['finalize', 'create_company'].includes(decision.action) ? 'prospects.company_id + prospect_signals.company_id' : null,
    resolved_at: new Date().toISOString(),
  };
  return jsonString(metadata);
}

async function loadProspects(env: Env, args: Args, windowStart: string, windowEnd: string): Promise<BridgeProspectRow[]> {
  const where = [
    'org_id = ?',
    'deleted_at IS NULL',
    "status IN ('active','converted')",
  ];
  const binds: unknown[] = [args.orgId];
  if (args.prospectIds.length > 0) {
    where.push(`id IN (${args.prospectIds.map(() => '?').join(',')})`);
    binds.push(...args.prospectIds);
  } else {
    where.push(`(
      (created_at >= ? AND created_at <= ?)
      OR (updated_at >= ? AND updated_at <= ?)
      OR EXISTS (
        SELECT 1
          FROM prospect_signals s
         WHERE s.org_id = prospects.org_id
           AND s.prospect_id = prospects.id
           AND (
             (s.created_at >= ? AND s.created_at <= ?)
             OR (s.updated_at >= ? AND s.updated_at <= ?)
             OR (s.occurred_at >= ? AND s.occurred_at <= ?)
           )
      )
    )`);
    binds.push(
      windowStart, windowEnd,
      windowStart, windowEnd,
      windowStart, windowEnd,
      windowStart, windowEnd,
      windowStart, windowEnd
    );
  }
  const rows = await env.D1.prepare(
    `SELECT *
       FROM prospects
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(updated_at, created_at, last_signal_at, last_seen_at) DESC
      LIMIT ?`
  ).bind(...binds, args.limit).all<BridgeProspectRow>();
  return rows.results || [];
}

async function loadSignals(env: Env, orgId: string, prospectIds: string[]): Promise<BridgeSignalRow[]> {
  if (prospectIds.length === 0) return [];
  const ph = prospectIds.map(() => '?').join(',');
  const rows = await env.D1.prepare(
    `SELECT *
       FROM prospect_signals
      WHERE org_id = ?
        AND prospect_id IN (${ph})
        AND mention_type IN ('inbound_prospect','known_deal')
      ORDER BY occurred_at DESC`
  ).bind(orgId, ...prospectIds).all<BridgeSignalRow>();
  return rows.results || [];
}

async function loadDeals(env: Env, orgId: string, dealIds: string[]): Promise<BridgeDealRow[]> {
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await env.D1.prepare(
    `SELECT id, org_id, company_id, title, stage, deleted_at
       FROM deals
      WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`
  ).bind(orgId, ...ids).all<BridgeDealRow>();
  return rows.results || [];
}

async function loadCompanies(env: Env, orgId: string): Promise<BridgeCompanyRow[]> {
  const rows = await env.D1.prepare(
    `SELECT co.*,
            COALESCE(contact_counts.n, 0) AS contacts_count,
            COALESCE(deal_counts.n, 0) AS deals_count,
            COALESCE(document_counts.n, 0) AS documents_count,
            COALESCE(tag_counts.n, 0) AS tags_count,
            COALESCE(human_counts.n, 0) AS human_edits_count
       FROM companies co
       LEFT JOIN (SELECT company_id, COUNT(*) AS n FROM contacts WHERE org_id = ? AND deleted_at IS NULL GROUP BY company_id) contact_counts
         ON contact_counts.company_id = co.id
       LEFT JOIN (SELECT company_id, COUNT(*) AS n FROM deals WHERE org_id = ? AND deleted_at IS NULL GROUP BY company_id) deal_counts
         ON deal_counts.company_id = co.id
       LEFT JOIN (SELECT company_id, COUNT(*) AS n FROM documents WHERE org_id = ? AND deleted_at IS NULL GROUP BY company_id) document_counts
         ON document_counts.company_id = co.id
       LEFT JOIN (SELECT company_id, COUNT(*) AS n FROM company_tags GROUP BY company_id) tag_counts
         ON tag_counts.company_id = co.id
       LEFT JOIN (SELECT entity_id, COUNT(*) AS n FROM entity_field_state WHERE entity_type = 'company' AND last_human_edit_at IS NOT NULL GROUP BY entity_id) human_counts
         ON human_counts.entity_id = co.id
      WHERE co.org_id = ?
        AND co.deleted_at IS NULL
        AND COALESCE(co.merged_into, '') = ''`
  ).bind(orgId, orgId, orgId, orgId).all<BridgeCompanyRow>();
  return rows.results || [];
}

async function ensureInvestmentProspectTag(env: Env, orgId: string, companyId: string): Promise<void> {
  await ensureProspectCompanyTag(orgId, companyId, env);
}

async function applyMaterializationDecision(
  env: Env,
  orgId: string,
  decision: ProspectMaterializationDecision,
  prospect: BridgeProspectRow,
  signals: BridgeSignalRow[],
  company: BridgeCompanyRow
): Promise<{ signal_backfills: number; repaired_domain: boolean; company_updated: boolean }> {
  const repairedDomain = decision.evidence.repaired_domain;
  await env.D1.prepare(
    `UPDATE prospects
        SET company_id = ?,
            possible_company_id = COALESCE(possible_company_id, ?),
            domain = COALESCE(?, domain),
            metadata_json = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(
    decision.selected_company_id,
    decision.selected_company_id,
    repairedDomain,
    metadataWithResolution(prospect.metadata_json, decision),
    decision.prospect_id,
    orgId
  ).run();

  for (const signal of signals) {
    await env.D1.prepare(
      `UPDATE prospect_signals
          SET company_id = ?,
              metadata_json = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND org_id = ?`
    ).bind(
      decision.selected_company_id,
      metadataWithResolution(signal.metadata_json, decision),
      signal.id,
      orgId
    ).run();
  }

  await env.D1.prepare(
    `UPDATE companies
        SET custom_fields = ?,
            investment_status = CASE
              WHEN investment_status IS NULL OR lower(investment_status) IN ('', 'tracking', 'placeholder', 'unknown', 'none', 'null')
              THEN 'prospect'
              ELSE investment_status
            END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ?`
  ).bind(customFieldsWithProspectOrigin(company.custom_fields, decision), company.id, orgId).run();
  await ensureInvestmentProspectTag(env, orgId, company.id);
  await upsertEntityIdentityAliases({
    orgId,
    entityType: 'prospect',
    entityId: prospect.id,
    name: prospect.canonical_name,
    normalizedName: prospect.normalized_name,
    domain: decision.evidence.repaired_domain || prospect.domain,
    website: prospect.website || null,
    sourceKind: 'migration',
    evidence: {
      source: 'prospect_bridge_materialization',
      action: decision.action,
      selected_company_id: decision.selected_company_id,
      method: decision.method,
      score: decision.score,
    },
  }, env);
  await upsertEntityIdentityAliases({
    orgId,
    entityType: 'company',
    entityId: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    sourceKind: 'migration',
    evidence: {
      source: 'prospect_bridge_materialization',
      prospect_id: prospect.id,
      action: decision.action,
      method: decision.method,
      score: decision.score,
    },
  }, env);

  return {
    signal_backfills: signals.length,
    repaired_domain: Boolean(repairedDomain),
    company_updated: shouldPromoteInvestmentStatus(company.investment_status) || true,
  };
}

function prospectDedupeKey(prospect: BridgeProspectRow): string | null {
  const domain = normalizeDomain(prospect.domain || prospect.website || metadataDomain(prospect));
  if (domain) return `domain:${domain}`;
  const name = normalizeProspectName(prospect.canonical_name);
  return name ? `name:${name}` : null;
}

function winnerProspect(left: BridgeProspectRow, right: BridgeProspectRow): BridgeProspectRow {
  const score = (row: BridgeProspectRow) =>
    (row.company_id ? 20 : 0) +
    (row.deal_id ? 15 : 0) +
    Number(row.signal_count || 0) * 3 +
    Number(row.evidence_count || 0) * 2 +
    Number(row.confidence || 0) * 10 +
    (row.status === 'converted' ? 6 : 0);
  return score(left) >= score(right) ? left : right;
}

export function buildProspectDedupeDecisions(prospects: BridgeProspectRow[]): DedupeDecision[] {
  const byKey = new Map<string, BridgeProspectRow[]>();
  for (const prospect of prospects) {
    const key = prospectDedupeKey(prospect);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) || []), prospect]);
  }
  const decisions: DedupeDecision[] = [];
  for (const [key, rows] of byKey) {
    if (rows.length < 2) continue;
    let winner = rows[0];
    for (const row of rows.slice(1)) winner = winnerProspect(winner, row);
    for (const row of rows) {
      if (row.id === winner.id) continue;
      decisions.push({
        entity_type: 'prospect',
        action: 'merge',
        winner_id: winner.id,
        loser_id: row.id,
        score: key.startsWith('domain:') ? 1 : 0.94,
        method: key.startsWith('domain:') ? 'exact_domain' : 'exact_normalized_name',
        reason: `duplicate prospect ${key}`,
        applied: false,
      });
    }
  }
  return decisions;
}

export function buildCompanyDedupeDecisions(companies: BridgeCompanyRow[]): DedupeDecision[] {
  const decisions: DedupeDecision[] = [];
  for (let i = 0; i < companies.length; i++) {
    for (let j = i + 1; j < companies.length; j++) {
      const left = companies[i];
      const right = companies[j];
      const leftDomain = normalizeDomain(left.domain || left.website);
      const rightDomain = normalizeDomain(right.domain || right.website);
      const aliasMatch = setsIntersect(aliasSet(left.name, leftDomain), aliasSet(right.name, rightDomain));
      if (!leftDomain || !rightDomain || leftDomain !== rightDomain || !aliasMatch) continue;
      const winner = candidateRank({ company: left, score: 1, method: 'exact_domain', reasons: [], blocked: false, block_reason: null }) >=
        candidateRank({ company: right, score: 1, method: 'exact_domain', reasons: [], blocked: false, block_reason: null })
        ? left
        : right;
      const loser = winner.id === left.id ? right : left;
      decisions.push({
        entity_type: 'company',
        action: 'merge',
        winner_id: winner.id,
        loser_id: loser.id,
        score: 1,
        method: 'exact_domain',
        reason: `duplicate company domain ${leftDomain}`,
        applied: false,
      });
    }
  }
  return decisions;
}

async function openDealConflict(env: Env, orgId: string, leftCompanyId: string, rightCompanyId: string): Promise<boolean> {
  const rows = await env.D1.prepare(
    `SELECT company_id, COUNT(*) AS n
       FROM deals
      WHERE org_id = ?
        AND company_id IN (?, ?)
        AND deleted_at IS NULL
        AND stage NOT IN ('closed','closed_won','closed_lost')
      GROUP BY company_id`
  ).bind(orgId, leftCompanyId, rightCompanyId).all<{ company_id: string; n: number }>();
  return (rows.results || []).length > 1;
}

async function applyCompanyMerge(env: Env, orgId: string, winnerId: string, loserId: string): Promise<string> {
  if (await openDealConflict(env, orgId, winnerId, loserId)) throw new Error('OPEN_DEAL_CONFLICT');
  const now = new Date().toISOString();
  await env.D1.batch([
    env.D1.prepare(`UPDATE contacts SET company_id = ?, updated_at = ? WHERE company_id = ? AND org_id = ?`).bind(winnerId, now, loserId, orgId),
    env.D1.prepare(`UPDATE deals SET company_id = ?, updated_at = ? WHERE company_id = ? AND org_id = ?`).bind(winnerId, now, loserId, orgId),
    env.D1.prepare(`UPDATE documents SET company_id = ? WHERE company_id = ? AND org_id = ?`).bind(winnerId, loserId, orgId),
    env.D1.prepare(`UPDATE tasks SET company_id = ? WHERE company_id = ? AND org_id = ?`).bind(winnerId, loserId, orgId),
    env.D1.prepare(`UPDATE news_articles SET company_id = ? WHERE company_id = ? AND org_id = ?`).bind(winnerId, loserId, orgId),
    env.D1.prepare(`DELETE FROM company_tags WHERE company_id = ?`).bind(loserId),
    env.D1.prepare(`UPDATE companies SET merged_into = ?, deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(winnerId, now, now, loserId, orgId),
  ]);
  const auditId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO audit_log (id, org_id, user_id, action, entity_type, entity_id, after_data, metadata, created_at)
     VALUES (?, ?, 'system', 'merge', 'company', ?, ?, ?, ?)`
  ).bind(
    auditId,
    orgId,
    loserId,
    jsonString({ merged_into: winnerId }),
    jsonString({ source: 'prospect_bridge_materialization', rollback_pointer: 'companies.merged_into/deleted_at' }),
    now
  ).run().catch(() => undefined);
  return auditId;
}

async function loadContactsForCompanies(env: Env, orgId: string, companyIds: string[]): Promise<ContactRow[]> {
  const ids = [...new Set(companyIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await env.D1.prepare(
    `SELECT id, org_id, full_name, email, company_id, deleted_at
       FROM contacts
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND company_id IN (${ids.map(() => '?').join(',')})`
  ).bind(orgId, ...ids).all<ContactRow>();
  return rows.results || [];
}

export function buildContactDedupeDecisions(contacts: ContactRow[]): DedupeDecision[] {
  const byEmail = new Map<string, ContactRow[]>();
  for (const contact of contacts) {
    const email = String(contact.email || '').trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) || []), contact]);
  }
  const decisions: DedupeDecision[] = [];
  for (const [email, rows] of byEmail) {
    if (rows.length < 2) continue;
    const winner = rows[0];
    for (const row of rows.slice(1)) {
      decisions.push({
        entity_type: 'contact',
        action: 'merge',
        winner_id: winner.id,
        loser_id: row.id,
        score: 1,
        method: 'exact_email',
        reason: `duplicate contact email ${email}`,
        applied: false,
      });
    }
  }
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const left = contacts[i];
      const right = contacts[j];
      if (left.email || right.email) continue;
      if (left.company_id !== right.company_id) continue;
      if (normalizeProspectName(left.full_name) !== normalizeProspectName(right.full_name)) continue;
      decisions.push({
        entity_type: 'contact',
        action: 'flag',
        winner_id: left.id,
        loser_id: right.id,
        score: 0.92,
        method: 'exact_name_same_company',
        reason: 'same company/name but no exact email; review before merge',
        applied: false,
      });
    }
  }
  return decisions;
}

export function buildDealConflictDecisions(deals: BridgeDealRow[]): DedupeDecision[] {
  const byCompany = new Map<string, BridgeDealRow[]>();
  for (const deal of deals) {
    if (!deal.company_id || deal.deleted_at) continue;
    if (['closed', 'closed_won', 'closed_lost'].includes(String(deal.stage || ''))) continue;
    byCompany.set(deal.company_id, [...(byCompany.get(deal.company_id) || []), deal]);
  }
  const decisions: DedupeDecision[] = [];
  for (const [companyId, rows] of byCompany) {
    if (rows.length < 2) continue;
    decisions.push({
      entity_type: 'deal',
      action: 'flag',
      winner_id: null,
      loser_id: null,
      score: 0,
      method: 'open_deal_conflict',
      reason: `company ${companyId} has ${rows.length} open deals; deals are never auto-merged`,
      applied: false,
    });
  }
  return decisions;
}

function outputDir(raw: string | null): string {
  if (raw) return resolve(raw);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(homedir(), 'Downloads', `medina-prospect-bridge-materialization-${stamp}`);
}

function writeArtifacts(result: ProspectBridgeRunResult): void {
  mkdirSync(result.manifest.artifact_dir, { recursive: true });
  writeFileSync(join(result.manifest.artifact_dir, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`);
  writeFileSync(
    join(result.manifest.artifact_dir, 'materialization-decisions.jsonl'),
    result.materializationDecisions.map(row => JSON.stringify(row)).join('\n') + '\n'
  );
  writeFileSync(
    join(result.manifest.artifact_dir, 'dedupe-decisions.jsonl'),
    result.dedupeDecisions.map(row => JSON.stringify(row)).join('\n') + '\n'
  );
  const csv = [
    'prospect_id,prospect_name,review_reason,score,method,possible_company_id,prospect_domain,repaired_domain,source_titles',
    ...result.needsReview.map(row => [
      row.prospect_id,
      row.prospect_name,
      row.review_reason || '',
      row.score,
      row.method || '',
      row.evidence.possible_company_id || '',
      row.evidence.prospect_domain || '',
      row.evidence.repaired_domain || '',
      row.evidence.source_titles.join(' | '),
    ].map(csvCell).join(',')),
  ].join('\n');
  writeFileSync(join(result.manifest.artifact_dir, 'needs-review.csv'), `${csv}\n`);
  writeFileSync(join(result.manifest.artifact_dir, 'report.md'), reportMarkdown(result));
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportMarkdown(result: ProspectBridgeRunResult): string {
  const m = result.manifest;
  return `# Prospect Bridge Materialization

- Dry run: ${m.dry_run}
- Org: ${m.org_id}
- Window: ${m.window_start} to ${m.window_end}
- Scanned prospects: ${m.scanned_prospects}
- Materialized links: ${m.materialized_links}
- Existing-company links: ${m.existing_company_links}
- Would/create companies: ${m.created_companies}
- Signal backfills: ${m.signal_backfills}
- Repaired domains: ${m.repaired_domains}
- Prospect merges: ${m.prospect_merges}
- Company merges: ${m.company_merges}
- Contact merges: ${m.contact_merges}
- Deal conflicts flagged: ${m.deal_conflicts}
- Needs review: ${m.needs_review}

Permanent writes require --apply true --confirm-production-write ${PROSPECT_BRIDGE_CONFIRMATION_TOKEN}.
`;
}

export async function runProspectBridgeMaterialization(
  env: Env,
  args: Args
): Promise<ProspectBridgeRunResult> {
  if (args.apply && args.confirmProductionWrite !== PROSPECT_BRIDGE_CONFIRMATION_TOKEN) {
    throw new Error(`PROSPECT_BRIDGE_APPLY_REQUIRES_EXACT_CONFIRMATION: pass --apply true --confirm-production-write ${PROSPECT_BRIDGE_CONFIRMATION_TOKEN}`);
  }
  const effectiveEnv = args.apply ? env : readOnlyEnv(env);
  const windowEnd = args.until || new Date().toISOString();
  const windowStart = args.since || new Date(Date.parse(windowEnd) - args.windowDays * 24 * 60 * 60 * 1000).toISOString();
  const artifactDir = outputDir(args.outDir);

  const prospects = await loadProspects(effectiveEnv, args, windowStart, windowEnd);
  const prospectIds = prospects.map(row => row.id);
  const [signals, companies] = await Promise.all([
    loadSignals(effectiveEnv, args.orgId, prospectIds),
    loadCompanies(effectiveEnv, args.orgId),
  ]);
  const dealIds = prospects.flatMap(row => [row.deal_id, row.possible_deal_id]).filter((id): id is string => Boolean(id));
  const deals = await loadDeals(effectiveEnv, args.orgId, dealIds);
  const signalsByProspect = new Map<string, BridgeSignalRow[]>();
  for (const signal of signals) {
    if (!signal.prospect_id) continue;
    signalsByProspect.set(signal.prospect_id, [...(signalsByProspect.get(signal.prospect_id) || []), signal]);
  }

  const prospectDedupeDecisions = buildProspectDedupeDecisions(prospects);
  const prospectMergeLosers = new Set(
    prospectDedupeDecisions
      .filter(decision => decision.action === 'merge' && decision.entity_type === 'prospect' && decision.loser_id)
      .map(decision => decision.loser_id as string)
  );
  const materializationDecisions = prospects.map(prospect =>
    decideProspectMaterialization(prospect, signalsByProspect.get(prospect.id) || [], companies, deals)
  );
  for (const decision of materializationDecisions) {
    if (decision.action !== 'create_company' || !prospectMergeLosers.has(decision.prospect_id)) continue;
    decision.action = 'dedupe_pending';
    decision.method = 'duplicate_prospect_pending_merge';
    decision.score = 0;
    decision.reasons = ['duplicate prospect should merge before company creation'];
    decision.evidence.target_company_kind = null;
    decision.review_reason = 'duplicate prospect pending merge; merge into winner before company creation';
  }
  const needsReview = materializationDecisions.filter(decision => decision.action === 'needs_review');

  const selectedCompanyIds = materializationDecisions
    .map(decision => decision.selected_company_id)
    .filter((id): id is string => Boolean(id));
  const contacts = await loadContactsForCompanies(effectiveEnv, args.orgId, selectedCompanyIds);
  const dedupeDecisions = [
    ...prospectDedupeDecisions,
    ...buildCompanyDedupeDecisions(companies.filter(c => selectedCompanyIds.includes(c.id))),
    ...buildContactDedupeDecisions(contacts),
    ...buildDealConflictDecisions(deals),
  ];
  const finalizeDecisions = materializationDecisions.filter(decision => decision.action === 'finalize');
  const createCompanyDecisions = materializationDecisions.filter(decision => decision.action === 'create_company');
  const materializingDecisions = [...finalizeDecisions, ...createCompanyDecisions];

  const manifest: ProspectBridgeSummary = {
    dry_run: !args.apply,
    org_id: args.orgId,
    window_start: windowStart,
    window_end: windowEnd,
    scanned_prospects: prospects.length,
    materialized_links: materializingDecisions.length,
    existing_company_links: finalizeDecisions.length,
    created_companies: createCompanyDecisions.length,
    signal_backfills: args.apply ? 0 : materializingDecisions.reduce((sum, decision) => sum + decision.evidence.signal_count, 0),
    repaired_domains: materializationDecisions.filter(decision => decision.evidence.repaired_domain).length,
    company_updates: args.apply ? 0 : materializingDecisions.length,
    prospect_merges: dedupeDecisions.filter(d => d.entity_type === 'prospect' && d.action === 'merge').length,
    company_merges: dedupeDecisions.filter(d => d.entity_type === 'company' && d.action === 'merge').length,
    contact_merges: dedupeDecisions.filter(d => d.entity_type === 'contact' && d.action === 'merge').length,
    deal_conflicts: dedupeDecisions.filter(d => d.entity_type === 'deal').length,
    needs_review: needsReview.length,
    artifact_dir: artifactDir,
  };

  if (args.apply) {
    for (const decision of materializationDecisions) {
      if (!['finalize', 'create_company'].includes(decision.action)) continue;
      const prospect = prospects.find(row => row.id === decision.prospect_id);
      if (!prospect) continue;
      let company = companies.find(row => row.id === decision.selected_company_id) || null;
      if (decision.action === 'create_company') {
        const prospectSignals = signalsByProspect.get(prospect.id) || [];
        const createdCompanyId = await createProspectOriginCompany({
          orgId: args.orgId,
          prospectId: prospect.id,
          signalId: prospectSignals[0]?.id || prospect.id,
          name: prospect.canonical_name,
          domain: decision.evidence.repaired_domain || metadataDomain(prospect) || prospect.domain || prospect.website || null,
          website: decision.evidence.repaired_domain ? `https://${decision.evidence.repaired_domain}` : prospect.website || null,
          description: decision.evidence.source_titles.length
            ? `${decision.evidence.company_card_quality === 'limited_info' ? 'Limited-information prospect card' : 'Prospect-origin company'} from ${decision.evidence.source_titles[0]}`
            : null,
          origin: 'prospect_bridge_materialization',
          matchMethod: decision.method || 'created_new_company',
          matchScore: decision.score,
        }, env);
        decision.selected_company_id = createdCompanyId;
        decision.selected_company_name = prospect.canonical_name;
        company = {
          id: createdCompanyId,
          org_id: args.orgId,
          name: prospect.canonical_name,
          domain: decision.evidence.repaired_domain || metadataDomain(prospect) || normalizeDomain(prospect.domain || prospect.website || null),
          website: decision.evidence.repaired_domain ? `https://${decision.evidence.repaired_domain}` : prospect.website || null,
          investment_status: 'prospect',
          custom_fields: '{}',
        };
      }
      if (!decision.selected_company_id || !company) continue;
      const applied = await applyMaterializationDecision(
        env,
        args.orgId,
        decision,
        prospect,
        signalsByProspect.get(prospect.id) || [],
        company
      );
      manifest.signal_backfills += applied.signal_backfills;
      if (applied.company_updated) manifest.company_updates++;
    }

    for (const decision of dedupeDecisions) {
      if (decision.action !== 'merge' || !decision.winner_id || !decision.loser_id) continue;
      if (decision.entity_type === 'prospect') {
        const audit = await mergeProspects(args.orgId, decision.winner_id, decision.loser_id, env, {
          method: decision.method,
          score: decision.score,
          alternatives: [{ reason: decision.reason }],
        });
        decision.applied = true;
        decision.rollback_pointer = audit.audit_id;
      } else if (decision.entity_type === 'company') {
        const auditId = await applyCompanyMerge(env, args.orgId, decision.winner_id, decision.loser_id);
        decision.applied = true;
        decision.rollback_pointer = auditId;
      } else if (decision.entity_type === 'contact' && decision.method === 'exact_email') {
        const result = await mergeContacts(decision.winner_id, decision.loser_id, 'system', args.orgId, env);
        if (result.success) {
          decision.applied = true;
          decision.rollback_pointer = 'contact merge audit_log';
        } else {
          decision.reason = `${decision.reason}; apply failed: ${result.error || 'unknown'}`;
        }
      }
    }
  }

  const result = { manifest, materializationDecisions, dedupeDecisions, needsReview };
  writeArtifacts(result);
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = args.remoteD1 ? null : await getPlatformProxy({ configPath: args.configPath });
  try {
    const env = args.remoteD1 ? remoteD1Env(args.d1Database, args.apply) : proxy!.env as unknown as Env;
    const result = await runProspectBridgeMaterialization(env, args);
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
  } finally {
    if (proxy) await proxy.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

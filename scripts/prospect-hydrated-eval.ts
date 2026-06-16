#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import type { ClassifiedItem } from '../src/types/interfaces';
import {
  classifyProspectSignalsDryRun,
  type ProspectDetectionStats,
  type ProspectDryRunDecision,
  type ProspectDryRunDuplicate,
  type ProspectDryRunResult,
} from '../src/lib/prospect-intelligence';
import { isClaudeHardQuotaErrorMessage } from '../src/lib/claude';

const DEFAULT_INPUT_DIR = '/Users/lucasfigueroa/Downloads/prospect-30-day-full-document-hydration-eval-2026-06-11-pareto-fix';

type SourceFamily = 'conversation' | 'event' | 'document';

interface Args {
  orgId: string;
  configPath: string;
  hydratedItemsPath: string;
  contextSnapshotPath: string;
  previousManifestPath: string;
  sourceScopePath: string | null;
  outputDir: string;
  batchSize: number;
  maxItems: number | null;
  offset: number;
  prewarmPromptCache: boolean;
  allowPartialSchema: boolean;
  resume: boolean;
  fetchTimeoutMs: number;
}

interface PreviousManifest {
  org_id?: string;
  database?: string;
  window_start?: string;
  window_end?: string;
  source_families?: SourceFamily[];
  source_count?: number;
  hydratable_sources?: number;
  transcript_sources?: number;
  decision_counts?: Record<string, number>;
  raw_decision_count?: number;
  rows_written?: number;
  changed_db?: boolean;
  artifacts?: Record<string, string>;
}

interface SnapshotData {
  companies?: any[];
  contacts?: any[];
  dealmakers?: any[];
  deals?: any[];
  knownDeals?: any[];
  prospectSignals?: any[];
  relationships?: any[];
}

interface EvalSummary {
  dry_run: true;
  run_kind: 'prospect_hydrated_eval';
  status: 'running' | 'completed' | 'failed';
  org_id: string;
  database: string | null;
  input_hydrated_items: string;
  input_context_snapshot: string;
  input_previous_manifest: string;
  input_source_scope: string | null;
  hydrated_items_sha256: string;
  context_snapshot_sha256: string;
  previous_manifest_sha256: string;
  output_dir: string;
  window_start: string | null;
  window_end: string | null;
  source_families: SourceFamily[];
  source_count: number;
  hydratable_sources: number;
  selected_items: number;
  offset: number;
  max_items: number | null;
  batch_size: number;
  batches_total: number;
  batches_completed: number;
  prompt_prewarm_requested: boolean;
  context_mode: 'd1_context_snapshot_read_only';
  rows_written: 0;
  changed_db: false;
  d1_snapshot_meta: {
    query_count: number;
    rows_read: number;
    rows_written: 0;
    changed_db: false;
    unsupported_query_count: number;
    unsupported_queries: Array<{ sql: string; binds: unknown[] }>;
  };
  classifier: {
    stats: ProspectDetectionStats;
    decision_counts: Record<string, number>;
    raw_decision_count: number;
    duplicate_count: number;
    errors: Array<{ item_id: string; error: string }>;
  };
  prior_run: {
    input_dir: string;
    decision_counts: Record<string, number>;
    raw_decision_count: number;
    rows_written: number;
    changed_db: boolean;
  };
  git: {
    head: string | null;
    status_short: string;
  };
  started_at: string;
  completed_at: string | null;
  error: string | null;
  fatal_error_kind: 'claude_monthly_quota_exhausted' | null;
  artifacts: Record<string, string>;
}

interface SnapshotQueryMeta {
  query_count: number;
  rows_read: number;
  rows_written: 0;
  changed_db: false;
  unsupportedQueries: Array<{ sql: string; binds: unknown[] }>;
}

class SnapshotStatement {
  private binds: unknown[] = [];

  constructor(private readonly db: SnapshotD1, private readonly sql: string) {}

  bind(...args: unknown[]): SnapshotStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.binds) as T[] };
  }

  async first<T = any>(): Promise<T | null> {
    return this.db.first(this.sql, this.binds) as T | null;
  }

  async run(): Promise<never> {
    throw new Error(`HYDRATED_EVAL_READ_ONLY_SQL_VIOLATION:${compactSql(this.sql)}`);
  }
}

class SnapshotD1 {
  readonly meta: SnapshotQueryMeta = {
    query_count: 0,
    rows_read: 0,
    rows_written: 0,
    changed_db: false,
    unsupportedQueries: [],
  };

  readonly companies: any[];
  readonly contacts: any[];
  readonly dealmakers: any[];
  readonly deals: any[];
  readonly knownDeals: any[];
  readonly prospectSignals: any[];
  readonly relationships: any[];

  constructor(snapshot: SnapshotData, private readonly orgId: string) {
    this.companies = (snapshot.companies || []).map(row => normalizeSnapshotRow(row, orgId));
    this.contacts = (snapshot.contacts || []).map(row => normalizeSnapshotRow(row, orgId));
    this.dealmakers = (snapshot.dealmakers || []).map(row => normalizeSnapshotRow(row, orgId));
    this.deals = (snapshot.deals || []).map(row => ({
      ...normalizeSnapshotRow(row, orgId),
      stage: row.stage || 'open',
    }));
    this.knownDeals = (snapshot.knownDeals || []).map(row => normalizeSnapshotRow(row, orgId));
    this.prospectSignals = (snapshot.prospectSignals || []).map(row => normalizeSnapshotRow(row, orgId));
    this.relationships = (snapshot.relationships || []).map(row => normalizeSnapshotRow(row, orgId));
  }

  prepare(sql: string): SnapshotStatement {
    return new SnapshotStatement(this, sql);
  }

  async batch(): Promise<never> {
    throw new Error('HYDRATED_EVAL_READ_ONLY_SQL_VIOLATION:batch');
  }

  all(sql: string, binds: unknown[]): any[] {
    assertReadOnlySql(sql);
    this.meta.query_count++;
    const rows = this.routeAll(sql, binds);
    this.meta.rows_read += rows.length;
    return rows.map(row => ({ ...row }));
  }

  first(sql: string, binds: unknown[]): any | null {
    return this.all(sql, binds)[0] || null;
  }

  private routeAll(sql: string, binds: unknown[]): any[] {
    if (/FROM prospect_classifier_cache/i.test(sql) || /FROM prospect_llm_cache/i.test(sql)) return [];
    if (/FROM entity_identity_aliases/i.test(sql)) return [];
    if (/FROM prospects/i.test(sql) && !/FROM prospect_signals/i.test(sql)) return [];

    if (/FROM companies c/i.test(sql)) {
      return this.knownDeals.map(row => ({ name: row.name, domain: row.domain || null }));
    }

    if (/FROM dealmakers/i.test(sql) && /GROUP BY dealmaker_type/i.test(sql)) {
      return this.groupDealmakers(sql, binds);
    }

    if (/FROM dealmakers/i.test(sql)) {
      return this.dealmakers
        .filter(row => row.org_id === binds[0])
        .map(row => ({ name: row.name, domain: row.domain || domainFromEmail(row.normalized_email) || null }));
    }

    if (/FROM contacts/i.test(sql)) {
      const [orgId, companyId] = binds;
      return this.contacts.filter(row =>
        row.org_id === orgId &&
        row.company_id === companyId &&
        !row.deleted_at &&
        !row.merged_into
      );
    }

    if (/FROM firm_company_relationships/i.test(sql)) {
      const [orgId, companyId] = binds;
      return this.relationships
        .filter(row => row.org_id === orgId && row.company_id === companyId && !row.ended_at)
        .map(row => ({ relationship_state: row.relationship_state }));
    }

    if (/FROM deals d\s+JOIN companies c/i.test(sql) && /d\.id\s*=\s*\?/i.test(sql)) {
      const [orgId, dealId] = binds;
      const deal = this.deals.find(row =>
        row.org_id === orgId &&
        row.id === dealId &&
        !row.deleted_at &&
        row.stage !== 'closed'
      );
      if (!deal) return [];
      const company = this.companies.find(row =>
        row.org_id === orgId &&
        row.id === deal.company_id &&
        !row.deleted_at
      );
      if (!company) return [];
      return [{
        deal_id: deal.id,
        company_id: deal.company_id,
        company_name: company.name || null,
        company_domain: company.domain || null,
        company_website: company.website || null,
      }];
    }

    if (/FROM deals/i.test(sql) && /company_id\s*=\s*\?/i.test(sql)) {
      const [orgId, companyId] = binds;
      return this.deals.filter(row =>
        row.org_id === orgId &&
        row.company_id === companyId &&
        !row.deleted_at &&
        row.stage !== 'closed'
      );
    }

    if (/FROM prospect_signals/i.test(sql) && /normalized_mention\s*=\s*\?/i.test(sql)) {
      const [orgId, normalizedMention] = binds;
      return this.prospectSignals
        .filter(row => row.org_id === orgId && row.normalized_mention === normalizedMention)
        .map(row => ({ mention_type: row.mention_type, metadata_json: row.metadata_json || '{}' }));
    }

    if (/FROM companies/i.test(sql) && /id IN/i.test(sql)) {
      const [orgId, ...ids] = binds;
      const allowed = new Set(ids.map(value => String(value)));
      return this.companies.filter(row => row.org_id === orgId && allowed.has(String(row.id)) && !row.deleted_at);
    }

    if (/FROM companies/i.test(sql) && /WHERE id\s*=\s*\?\s+AND org_id\s*=\s*\?/i.test(sql)) {
      const [id, orgId] = binds;
      return this.companies.filter(row => row.id === id && row.org_id === orgId && !row.deleted_at);
    }

    if (/FROM companies/i.test(sql) && /lower\(domain\)\s*=\s*lower\(\?\)/i.test(sql)) {
      const [orgId, domain] = binds;
      const normalizedDomain = normalizeDomain(domain);
      return this.companies.filter(row => {
        if (row.org_id !== orgId || row.deleted_at) return false;
        const rowDomain = normalizeDomain(row.domain);
        const rowWebsite = String(row.website || '').toLowerCase();
        return rowDomain === normalizedDomain || (normalizedDomain && rowWebsite.includes(normalizedDomain));
      });
    }

    if (/FROM companies/i.test(sql) && /lower\(website\)\s+LIKE\s+\?/i.test(sql)) {
      const [orgId, domain] = binds;
      const normalizedDomain = normalizeDomain(domain);
      return this.companies.filter(row => {
        if (row.org_id !== orgId || row.deleted_at) return false;
        return normalizeDomain(row.domain) === normalizedDomain || String(row.website || '').toLowerCase().includes(normalizedDomain || '');
      });
    }

    if (/FROM companies/i.test(sql) && /lower\(name\)\s+LIKE\s+\?/i.test(sql)) {
      const [orgId, pattern] = binds;
      const needle = String(pattern || '').replace(/%/g, '').toLowerCase();
      return this.companies.filter(row =>
        row.org_id === orgId &&
        !row.deleted_at &&
        String(row.name || '').toLowerCase().includes(needle)
      );
    }

    this.meta.unsupportedQueries.push({ sql: compactSql(sql), binds: binds.slice(0, 12) });
    return [];
  }

  private groupDealmakers(sql: string, binds: unknown[]): Array<{ dealmaker_type: string | null; n: number }> {
    const [orgId, ...criteria] = binds;
    const domainCriteria = new Set(
      criteria
        .filter(value => typeof value === 'string' && String(value).includes('.'))
        .map(value => normalizeDomain(value))
        .filter(Boolean) as string[]
    );
    const normalizedCriteria = new Set(
      criteria
        .filter(value => typeof value === 'string' && !String(value).includes('.'))
        .map(value => String(value))
    );
    const grouped = new Map<string, number>();
    for (const row of this.dealmakers) {
      if (row.org_id !== orgId) continue;
      const domain = normalizeDomain(row.domain || domainFromEmail(row.normalized_email));
      const normalizedName = String(row.normalized_name || '');
      const matches = (domain && domainCriteria.has(domain)) || normalizedCriteria.has(normalizedName);
      if (!matches) continue;
      const key = row.dealmaker_type || 'unknown';
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }
    return Array.from(grouped.entries()).map(([dealmaker_type, n]) => ({ dealmaker_type, n }));
  }
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

  const inputDir = resolve(raw.get('input-dir') || DEFAULT_INPUT_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const batchSize = Number(raw.get('batch-size') || 100);
  const maxItemsRaw = raw.get('max-items') || raw.get('limit') || '';
  const maxItems = maxItemsRaw ? Number(maxItemsRaw) : null;
  const offset = Number(raw.get('offset') || 0);
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('INVALID_BATCH_SIZE');
  if (maxItems != null && (!Number.isFinite(maxItems) || maxItems < 1)) throw new Error('INVALID_MAX_ITEMS');
  if (!Number.isFinite(offset) || offset < 0) throw new Error('INVALID_OFFSET');

  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    hydratedItemsPath: resolve(raw.get('hydrated-items') || join(inputDir, 'hydrated-items.jsonl')),
    contextSnapshotPath: resolve(raw.get('context-snapshot') || join(inputDir, 'd1-context-snapshot.json')),
    previousManifestPath: resolve(raw.get('previous-manifest') || join(inputDir, 'manifest.json')),
    sourceScopePath: raw.has('source-scope')
      ? resolve(raw.get('source-scope') || '')
      : existsSync(join(inputDir, 'source-scope.json')) ? resolve(join(inputDir, 'source-scope.json')) : null,
    outputDir: resolve(raw.get('output-dir') || join(homedir(), 'Downloads', `prospect-30-day-new-pipeline-baseline-${today}`)),
    batchSize: Math.floor(batchSize),
    maxItems: maxItems == null ? null : Math.floor(maxItems),
    offset: Math.floor(offset),
    prewarmPromptCache: raw.get('prewarm-prompt-cache') !== 'false',
    allowPartialSchema: raw.get('allow-partial-schema') !== 'false',
    resume: raw.get('resume') === 'true',
    fetchTimeoutMs: Number(raw.get('fetch-timeout-ms') || 240_000),
  };
}

function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
    throw new Error(`HYDRATED_EVAL_READ_ONLY_SQL_VIOLATION:${compactSql(sql)}`);
  }
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|TRUNCATE)\b/i.test(trimmed)) {
    throw new Error(`HYDRATED_EVAL_READ_ONLY_SQL_VIOLATION:${compactSql(sql)}`);
  }
}

function normalizeSnapshotRow(row: any, orgId: string): any {
  return {
    ...row,
    org_id: row?.org_id || orgId,
    deleted_at: row?.deleted_at || null,
  };
}

function normalizeDomain(value: unknown): string | null {
  const raw = String(value || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const domain = raw.split('/')[0] || '';
  return domain || null;
}

function domainFromEmail(value: unknown): string | null {
  const email = String(value || '');
  const at = email.lastIndexOf('@');
  return at >= 0 ? normalizeDomain(email.slice(at + 1)) : null;
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readHydratedItems(path: string): ClassifiedItem[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as ClassifiedItem);
}

function readJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T);
}

function gitValue(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function emptyLlmStageUsage() {
  return {
    cache_hits: 0,
    cache_misses: 0,
    paid_calls: 0,
    paid_calls_saved: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function emptyStats(): ProspectDetectionStats {
  return {
    items_scanned: 0,
    mentions_seen: 0,
    signals_recorded: 0,
    prospects_upserted: 0,
    classifications_pending: 0,
    classifier_cache_hits: 0,
    classifier_cache_misses: 0,
    classifier_paid_calls: 0,
    classifier_paid_calls_saved: 0,
    llm_stage_usage: {},
    prefilter_dropped: 0,
    production_samples_recorded: 0,
    known_deals_attached: 0,
    record_context_skipped: 0,
    ignored_or_noise_skipped: 0,
    skipped_known_deal: 0,
    skipped_intro_source: 0,
    skipped_news: 0,
    skipped_noise: 0,
    skipped_web_analytics: 0,
    final_quality_gate_reviewed: 0,
    final_quality_gate_allowed: 0,
    final_quality_gate_renamed: 0,
    final_quality_gate_merged: 0,
    final_quality_gate_blocked: 0,
    final_quality_gate_batches: 0,
    final_quality_gate_cache_hits: 0,
    final_quality_gate_failed_open: 0,
    final_quality_gate_fallback_used: 0,
    final_quality_gate_merge_resolved: 0,
    final_quality_gate_merge_unresolved: 0,
    errors: [],
  };
}

function mergeStats(target: ProspectDetectionStats, next: ProspectDetectionStats): void {
  target.items_scanned += next.items_scanned;
  target.mentions_seen += next.mentions_seen;
  target.signals_recorded += next.signals_recorded;
  target.prospects_upserted += next.prospects_upserted;
  target.classifications_pending += next.classifications_pending;
  target.classifier_cache_hits += next.classifier_cache_hits;
  target.classifier_cache_misses += next.classifier_cache_misses;
  target.classifier_paid_calls += next.classifier_paid_calls;
  target.classifier_paid_calls_saved += next.classifier_paid_calls_saved;
  target.prefilter_dropped += next.prefilter_dropped;
  target.production_samples_recorded += next.production_samples_recorded;
  target.known_deals_attached += next.known_deals_attached;
  target.record_context_skipped += next.record_context_skipped;
  target.ignored_or_noise_skipped += next.ignored_or_noise_skipped;
  target.skipped_known_deal += next.skipped_known_deal;
  target.skipped_intro_source += next.skipped_intro_source;
  target.skipped_news += next.skipped_news;
  target.skipped_noise += next.skipped_noise;
  target.skipped_web_analytics += next.skipped_web_analytics;
  target.final_quality_gate_reviewed += next.final_quality_gate_reviewed || 0;
  target.final_quality_gate_allowed += next.final_quality_gate_allowed || 0;
  target.final_quality_gate_renamed += next.final_quality_gate_renamed || 0;
  target.final_quality_gate_merged += next.final_quality_gate_merged || 0;
  target.final_quality_gate_blocked += next.final_quality_gate_blocked || 0;
  target.final_quality_gate_batches += next.final_quality_gate_batches || 0;
  target.final_quality_gate_cache_hits += next.final_quality_gate_cache_hits || 0;
  target.final_quality_gate_failed_open += next.final_quality_gate_failed_open || 0;
  target.final_quality_gate_fallback_used += next.final_quality_gate_fallback_used || 0;
  target.final_quality_gate_merge_resolved += next.final_quality_gate_merge_resolved || 0;
  target.final_quality_gate_merge_unresolved += next.final_quality_gate_merge_unresolved || 0;
  target.errors.push(...next.errors);
  for (const [stage, usage] of Object.entries(next.llm_stage_usage || {})) {
    const current = target.llm_stage_usage[stage] || emptyLlmStageUsage();
    current.cache_hits += usage.cache_hits;
    current.cache_misses += usage.cache_misses;
    current.paid_calls += usage.paid_calls;
    current.paid_calls_saved += usage.paid_calls_saved;
    current.input_tokens += usage.input_tokens;
    current.output_tokens += usage.output_tokens;
    current.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    current.cache_read_input_tokens += usage.cache_read_input_tokens;
    target.llm_stage_usage[stage] = current;
  }
}

function mergeDecisionCounts(target: Record<string, number>, next: Record<string, number>): void {
  for (const [key, value] of Object.entries(next)) target[key] = (target[key] || 0) + Number(value || 0);
}

function computeDuplicates(decisions: ProspectDryRunDecision[]): ProspectDryRunDuplicate[] {
  const grouped = new Map<string, ProspectDryRunDecision[]>();
  for (const decision of decisions) {
    if (!decision.duplicate_key) continue;
    const rows = grouped.get(decision.duplicate_key) || [];
    rows.push(decision);
    grouped.set(decision.duplicate_key, rows);
  }
  return Array.from(grouped.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([duplicate_key, rows]) => ({
      duplicate_key,
      count: rows.length,
      item_ids: rows.map(row => row.item_id),
      company_name: rows[0]?.company_name || '',
    }))
    .sort((a, b) => b.count - a.count || a.duplicate_key.localeCompare(b.duplicate_key));
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

const DECISION_CSV_COLUMNS = [
  'source_type',
  'source_id',
  'occurred_at',
  'mention_ordinal',
  'company_name',
  'normalized_company_name',
  'prospect_action',
  'mention_type',
  'should_create_prospect',
  'prospect_company_name',
  'direction',
  'confidence',
  'sector_key',
  'possible_company_id',
  'possible_deal_id',
  'linked_deal_id',
  'provisional',
  'reasoning',
  'error',
  'source_title',
  'original_llm_is_prospect',
  'original_llm_prospect_action',
  'create_prospect_veto_reason',
  'valuable_action_veto_reason',
  'finalization_blocked',
  'finalization_block_reasons',
  'has_create_evidence',
  'reasoning_judge_action',
  'reasoning_judge_valid',
  'reasoning_judge_reason',
  'reasoning_judge_blocked_company',
  'target_evidence_reasons',
  'corrected_prospect_company_name',
  'second_look_required',
  'second_look_lane',
  'second_look_recommended_action',
  'second_look_reasons',
  'second_look_warnings',
  'second_look_evidence',
  'second_look_create_blocked',
  'second_look_block_reason',
  'final_quality_decision',
  'final_quality_canonical_name',
  'final_quality_merge_target',
  'final_quality_reason',
  'final_quality_blocked',
  'final_quality_renamed',
  'final_quality_merged',
  'final_quality_batch_id',
  'final_quality_failed_open',
  'final_quality_fallback_used',
  'final_quality_parse_failed',
  'final_quality_retry_used',
  'final_quality_fallback_basis',
  'final_quality_target_proof',
  'final_quality_hard_block_reason',
  'final_quality_batch_size',
  'final_quality_attach_only',
  'final_quality_merge_resolved',
  'final_quality_existing_prospect_id',
  'final_quality_duplicate_group_id',
  'final_quality_record_key',
] as const satisfies readonly (keyof ProspectDryRunDecision)[];

function decisionCsvHeader(): string {
  return DECISION_CSV_COLUMNS.join(',') + '\n';
}

function decisionCsvLine(row: ProspectDryRunDecision): string {
  return DECISION_CSV_COLUMNS.map(column => csvEscape(row[column])).join(',');
}

function renderReport(summary: EvalSummary): string {
  const stageRows = Object.entries(summary.classifier.stats.llm_stage_usage || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, usage]) => `| ${stage} | ${usage.paid_calls} | ${usage.cache_hits} | ${usage.cache_misses} | ${usage.input_tokens} | ${usage.output_tokens} | ${usage.cache_creation_input_tokens} | ${usage.cache_read_input_tokens} |`);
  const counts = summary.classifier.decision_counts;
  return [
    '# Prospect 30-Day Hydrated Baseline',
    '',
    `- Status: ${summary.status}`,
    `- Dry run: ${summary.dry_run}`,
    `- Window: ${summary.window_start || '(unknown)'} to ${summary.window_end || '(unknown)'}`,
    `- Frozen hydrated sources: ${summary.hydratable_sources}`,
    `- Selected items: ${summary.selected_items}`,
    `- Batches: ${summary.batches_completed}/${summary.batches_total}`,
    `- Prompt prewarm requested: ${summary.prompt_prewarm_requested}`,
    `- Rows written: ${summary.rows_written}`,
    `- Changed DB: ${summary.changed_db}`,
    `- Context mode: ${summary.context_mode}`,
    `- Snapshot D1 queries: ${summary.d1_snapshot_meta.query_count}`,
    `- Snapshot D1 unsupported reads: ${summary.d1_snapshot_meta.unsupported_query_count}`,
    '',
    '## Classifier Decisions',
    '',
    `- would_create: ${counts.create_prospect || 0}`,
    `- would_record_context: ${counts.record_context || 0}`,
    `- would_ignore: ${counts.ignore || 0}`,
    `- classifier_error: ${counts.classifier_error || 0}`,
    `- raw decisions: ${summary.classifier.raw_decision_count}`,
    `- duplicate keys: ${summary.classifier.duplicate_count}`,
    '',
    '## LLM Stage Usage',
    '',
    '| Stage | Paid Calls | Cache Hits | Cache Misses | Input Tokens | Output Tokens | Cache Create Tokens | Cache Read Tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(stageRows.length ? stageRows : ['| (none) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |']),
    '',
    '## Prior Baseline',
    '',
    `- Prior raw decisions: ${summary.prior_run.raw_decision_count}`,
    `- Prior create_prospect: ${summary.prior_run.decision_counts.create_prospect || 0}`,
    `- Prior record_context: ${summary.prior_run.decision_counts.record_context || 0}`,
    `- Prior ignore: ${summary.prior_run.decision_counts.ignore || 0}`,
    '',
    '## Read-Only Proof',
    '',
    'This run consumed frozen hydrated evidence and a read-only D1 context snapshot. The D1 adapter throws on writes, and the classifier returned rows_written=0 and changed_db=false.',
    '',
  ].join('\n');
}

function writeSummary(paths: Record<string, string>, summary: EvalSummary): void {
  summary.d1_snapshot_meta = {
    ...summary.d1_snapshot_meta,
    unsupported_query_count: summary.d1_snapshot_meta.unsupported_queries.length,
  };
  writeFileSync(paths.manifest, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(paths.report, renderReport(summary));
}

function selectedItems(allItems: ClassifiedItem[], args: Args): ClassifiedItem[] {
  const sliced = allItems.slice(args.offset);
  return args.maxItems == null ? sliced : sliced.slice(0, args.maxItems);
}

function sourceFamiliesFor(items: ClassifiedItem[]): SourceFamily[] {
  return Array.from(new Set(items.map(item => String((item as any).entityType || '')).filter((type): type is SourceFamily =>
    type === 'conversation' || type === 'event' || type === 'document'
  ))).sort();
}

function buildArtifacts(outputDir: string): Record<string, string> {
  return {
    manifest: join(outputDir, 'manifest.json'),
    report: join(outputDir, 'report.md'),
    progress: join(outputDir, 'progress.json'),
    decisions: join(outputDir, 'dry-run-decisions.jsonl'),
    rawSignals: join(outputDir, 'raw-source-signal-results.csv'),
    duplicates: join(outputDir, 'duplicates.json'),
    errors: join(outputDir, 'classifier-errors.json'),
    unsupportedQueries: join(outputDir, 'unsupported-d1-snapshot-queries.json'),
    contextSnapshotCopy: join(outputDir, 'd1-context-snapshot.json'),
  };
}

function installFetchTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`HYDRATED_EVAL_FETCH_TIMEOUT:${timeoutMs}`));
    }, timeoutMs);
    const upstreamSignal = init?.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) abortFromUpstream();
    else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    try {
      return await originalFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener('abort', abortFromUpstream);
    }
  };
}

async function classifyBatch(
  items: ClassifiedItem[],
  orgId: string,
  env: Env,
  allowPartialSchema: boolean
): Promise<ProspectDryRunResult> {
  return classifyProspectSignalsDryRun(items, orgId, env, {
    allowPartialSchema,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.hydratedItemsPath)) throw new Error(`MISSING_HYDRATED_ITEMS:${args.hydratedItemsPath}`);
  if (!existsSync(args.contextSnapshotPath)) throw new Error(`MISSING_CONTEXT_SNAPSHOT:${args.contextSnapshotPath}`);
  if (!existsSync(args.previousManifestPath)) throw new Error(`MISSING_PREVIOUS_MANIFEST:${args.previousManifestPath}`);
  mkdirSync(args.outputDir, { recursive: true });

  const paths = buildArtifacts(args.outputDir);
  const previousManifest = readJsonFile<PreviousManifest>(args.previousManifestPath);
  const snapshot = readJsonFile<SnapshotData>(args.contextSnapshotPath);
  const snapshotD1 = new SnapshotD1(snapshot, args.orgId);
  const allItems = readHydratedItems(args.hydratedItemsPath);
  const items = selectedItems(allItems, args);
  const batchesTotal = Math.ceil(items.length / args.batchSize);
  let stats = emptyStats();
  let decisionCounts: Record<string, number> = {};
  let decisions: ProspectDryRunDecision[] = [];
  let startedAt = new Date().toISOString();
  let startBatch = 0;
  const hydratedItemsSha256 = sha256File(args.hydratedItemsPath);
  const contextSnapshotSha256 = sha256File(args.contextSnapshotPath);
  const previousManifestSha256 = sha256File(args.previousManifestPath);

  if (args.resume && existsSync(paths.manifest)) {
    const previousSummary = readJsonFile<EvalSummary>(paths.manifest);
    if (previousSummary.hydrated_items_sha256 !== hydratedItemsSha256) throw new Error('HYDRATED_EVAL_RESUME_INPUT_HASH_MISMATCH');
    if (previousSummary.context_snapshot_sha256 !== contextSnapshotSha256) throw new Error('HYDRATED_EVAL_RESUME_CONTEXT_HASH_MISMATCH');
    if (previousSummary.selected_items !== items.length) throw new Error('HYDRATED_EVAL_RESUME_SELECTED_ITEM_MISMATCH');
    if (previousSummary.batch_size !== args.batchSize) throw new Error('HYDRATED_EVAL_RESUME_BATCH_SIZE_MISMATCH');
    startBatch = previousSummary.batches_completed || 0;
    stats = previousSummary.classifier?.stats || emptyStats();
    decisionCounts = { ...(previousSummary.classifier?.decision_counts || {}) };
    decisions = readJsonlFile<ProspectDryRunDecision>(paths.decisions);
    startedAt = previousSummary.started_at || startedAt;
    snapshotD1.meta.query_count = previousSummary.d1_snapshot_meta?.query_count || 0;
    snapshotD1.meta.rows_read = previousSummary.d1_snapshot_meta?.rows_read || 0;
    snapshotD1.meta.unsupportedQueries = previousSummary.d1_snapshot_meta?.unsupported_queries || [];
    if (!existsSync(paths.rawSignals)) {
      writeFileSync(paths.rawSignals, decisionCsvHeader());
      appendFileSync(paths.rawSignals, decisions.map(decisionCsvLine).join('\n') + (decisions.length ? '\n' : ''));
    }
  } else {
    copyFileSync(args.contextSnapshotPath, paths.contextSnapshotCopy);
    writeFileSync(paths.decisions, '');
    writeFileSync(paths.rawSignals, decisionCsvHeader());
  }

  const summary: EvalSummary = {
    dry_run: true,
    run_kind: 'prospect_hydrated_eval',
    status: 'running',
    org_id: args.orgId,
    database: previousManifest.database || null,
    input_hydrated_items: args.hydratedItemsPath,
    input_context_snapshot: args.contextSnapshotPath,
    input_previous_manifest: args.previousManifestPath,
    input_source_scope: args.sourceScopePath,
    hydrated_items_sha256: hydratedItemsSha256,
    context_snapshot_sha256: contextSnapshotSha256,
    previous_manifest_sha256: previousManifestSha256,
    output_dir: args.outputDir,
    window_start: previousManifest.window_start || null,
    window_end: previousManifest.window_end || null,
    source_families: previousManifest.source_families || sourceFamiliesFor(items),
    source_count: previousManifest.source_count || allItems.length,
    hydratable_sources: previousManifest.hydratable_sources || allItems.length,
    selected_items: items.length,
    offset: args.offset,
    max_items: args.maxItems,
    batch_size: args.batchSize,
    batches_total: batchesTotal,
    batches_completed: startBatch,
    prompt_prewarm_requested: args.prewarmPromptCache,
    context_mode: 'd1_context_snapshot_read_only',
    rows_written: 0,
    changed_db: false,
    d1_snapshot_meta: {
      query_count: 0,
      rows_read: 0,
      rows_written: 0,
      changed_db: false,
      unsupported_query_count: 0,
      unsupported_queries: [],
    },
    classifier: {
      stats,
      decision_counts: decisionCounts,
      raw_decision_count: decisions.length,
      duplicate_count: 0,
      errors: [],
    },
    prior_run: {
      input_dir: resolve(args.previousManifestPath, '..'),
      decision_counts: previousManifest.decision_counts || {},
      raw_decision_count: previousManifest.raw_decision_count || 0,
      rows_written: previousManifest.rows_written || 0,
      changed_db: previousManifest.changed_db === true,
    },
    git: {
      head: gitValue(['rev-parse', 'HEAD']),
      status_short: gitValue(['status', '--short']) || '',
    },
    started_at: startedAt,
    completed_at: null,
    error: null,
    fatal_error_kind: null,
    artifacts: paths,
  };

  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    installFetchTimeout(args.fetchTimeoutMs);
    const baseEnv = proxy.env as unknown as Env;
    const evalEnv = {
      ...(baseEnv as any),
      AI: undefined,
      D1: snapshotD1 as unknown as D1Database,
      PROSPECT_PREWARM_PROMPT_CACHE: args.prewarmPromptCache ? 'true' : 'false',
    } as Env;

    for (let batchIndex = startBatch; batchIndex < batchesTotal; batchIndex++) {
      const start = batchIndex * args.batchSize;
      const batch = items.slice(start, start + args.batchSize);
      const batchStartedAt = new Date().toISOString();
      process.stdout.write(`[prospect-hydrated-eval] batch ${batchIndex + 1}/${batchesTotal} items=${batch.length} started_at=${batchStartedAt}\n`);
      const result = await classifyBatch(batch, args.orgId, evalEnv, args.allowPartialSchema);
      if (result.rows_written !== 0 || result.changed_db) {
        throw new Error(`HYDRATED_EVAL_CLASSIFIER_WRITE_VIOLATION rows_written=${result.rows_written} changed_db=${result.changed_db}`);
      }
      mergeStats(stats, result.stats);
      mergeDecisionCounts(decisionCounts, result.decision_counts);
      decisions.push(...result.decisions);
      appendFileSync(paths.decisions, result.decisions.map(row => `${JSON.stringify(row)}\n`).join(''));
      appendFileSync(paths.rawSignals, result.decisions.map(decisionCsvLine).join('\n') + (result.decisions.length ? '\n' : ''));
      summary.batches_completed = batchIndex + 1;
      summary.classifier.raw_decision_count = decisions.length;
      summary.classifier.errors = stats.errors;
      summary.d1_snapshot_meta.query_count = snapshotD1.meta.query_count;
      summary.d1_snapshot_meta.rows_read = snapshotD1.meta.rows_read;
      summary.d1_snapshot_meta.unsupported_queries = snapshotD1.meta.unsupportedQueries.slice(0, 50);
      writeFileSync(paths.progress, `${JSON.stringify({
        status: 'running',
        batch: batchIndex + 1,
        batches_total: batchesTotal,
        decisions: decisions.length,
        stats,
        d1_snapshot_meta: summary.d1_snapshot_meta,
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`);
      writeSummary(paths, summary);
      process.stdout.write(`[prospect-hydrated-eval] batch ${batchIndex + 1}/${batchesTotal} decisions=${result.decisions.length} cumulative_decisions=${decisions.length}\n`);
    }

    const duplicates = computeDuplicates(decisions);
    summary.status = 'completed';
    summary.completed_at = new Date().toISOString();
    summary.classifier.raw_decision_count = decisions.length;
    summary.classifier.duplicate_count = duplicates.length;
    summary.classifier.errors = stats.errors;
    summary.d1_snapshot_meta.query_count = snapshotD1.meta.query_count;
    summary.d1_snapshot_meta.rows_read = snapshotD1.meta.rows_read;
    summary.d1_snapshot_meta.unsupported_queries = snapshotD1.meta.unsupportedQueries.slice(0, 50);
    writeFileSync(paths.duplicates, `${JSON.stringify(duplicates, null, 2)}\n`);
    writeFileSync(paths.errors, `${JSON.stringify(stats.errors, null, 2)}\n`);
    writeFileSync(paths.unsupportedQueries, `${JSON.stringify(snapshotD1.meta.unsupportedQueries, null, 2)}\n`);
    writeSummary(paths, summary);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    summary.status = 'failed';
    summary.completed_at = new Date().toISOString();
    summary.error = error instanceof Error ? error.message : String(error);
    summary.fatal_error_kind = isClaudeHardQuotaErrorMessage(summary.error) ? 'claude_monthly_quota_exhausted' : null;
    summary.d1_snapshot_meta.query_count = snapshotD1.meta.query_count;
    summary.d1_snapshot_meta.rows_read = snapshotD1.meta.rows_read;
    summary.d1_snapshot_meta.unsupported_queries = snapshotD1.meta.unsupportedQueries.slice(0, 50);
    writeFileSync(paths.errors, `${JSON.stringify(stats.errors, null, 2)}\n`);
    writeFileSync(paths.unsupportedQueries, `${JSON.stringify(snapshotD1.meta.unsupportedQueries, null, 2)}\n`);
    writeSummary(paths, summary);
    throw error;
  } finally {
    await proxy.dispose();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

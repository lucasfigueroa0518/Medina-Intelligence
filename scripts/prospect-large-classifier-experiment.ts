#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';

import {
  __prospectIntelligenceTestHooks,
  callProspectClassifier,
  extractOrganizationMentionsFromSource,
  PROSPECT_CLASSIFIER_VERSION,
  type ProspectClassifierKnownContext,
} from '../src/lib/prospect-intelligence';
import type { Env } from '../src/types/env';

type SourceType = 'conversation' | 'event' | 'document';
type SourceChannel = 'email' | 'slack' | 'meeting' | 'document';
type ExperimentStratum = 'enriched_inbound' | 'enriched_known_deal' | 'hard_negative' | 'representative';
type ProspectAction = 'create_prospect' | 'attach_existing_deal' | 'record_context' | 'ignore' | 'classifier_error';
type ReviewAction =
  | 'create_prospect'
  | 'attach_existing_deal'
  | 'record_context'
  | 'ignore'
  | 'adjudicate'
  | 'inbound_prospect'
  | 'known_deal'
  | 'intro_source'
  | 'news'
  | 'noise'
  | '';

const DEFAULT_OUTPUT_DIR = '/Users/lucasfigueroa/Downloads/prospect-large-experiment-2026-06-01';
const DEFAULT_WINDOW_START = '2025-12-01T00:00:00.000Z';
const DEFAULT_WINDOW_END = '2026-06-01T00:00:00.000Z';
const REVIEW_ACTIONS = new Set([
  'create_prospect',
  'attach_existing_deal',
  'record_context',
  'ignore',
  'adjudicate',
  'inbound_prospect',
  'known_deal',
  'intro_source',
  'news',
  'noise',
]);
const REVIEW_LABEL_TO_ACTION: Record<string, Exclude<ReviewAction, 'adjudicate' | ''>> = {
  create_prospect: 'create_prospect',
  attach_existing_deal: 'attach_existing_deal',
  record_context: 'record_context',
  ignore: 'ignore',
  inbound_prospect: 'create_prospect',
  known_deal: 'attach_existing_deal',
  intro_source: 'record_context',
  news: 'ignore',
  noise: 'ignore',
};
const VALUABLE_ACTIONS = new Set(['create_prospect', 'attach_existing_deal']);
const STRATA: ExperimentStratum[] = ['enriched_inbound', 'enriched_known_deal', 'hard_negative', 'representative'];
const VALIDATED_KNOWN_DEAL_ALIASES = new Set([
  'dwave',
  'gevernova',
  'hedgehog',
  'helloabra',
  'ionq',
  'neuralseek',
  'neuralseq',
  'qunnect',
  'techd',
  'tier4ai',
  'ziggurat',
]);
const ERROR_TYPES = [
  'artifact',
  'news',
  'service_provider',
  'customer_or_buyer',
  'nearby_company',
  'missed_inbound',
  'missed_known_deal',
  'direction_wrong',
  'other',
];

interface Args {
  mode: 'run' | 'score' | 'merge' | 'replay_review';
  orgId: string;
  outputDir: string;
  reviewInputPath: string | null;
  configPath: string;
  database: string;
  bucket: string;
  windowStart: string;
  windowEnd: string;
  targetRows: number;
  recallSampleRows: number;
  maxTextChars: number;
  callDelayMs: number;
  retryAttempts: number;
  classifierConcurrency: number;
  reverseClassifierConcurrency: number;
  sourceShardCount: number;
  sourceShardIndex: number;
  shardDirs: string[];
  allowLlmExtraction: boolean;
  r2Fallback: boolean;
  reuseInput: boolean;
  resume: boolean;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

interface RemoteMeta {
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  query_count: number;
}

interface RemoteQueryResult<T> {
  results: T[];
  meta?: Partial<RemoteMeta>;
}

interface KnownEntity {
  name: string;
  domain: string | null;
}

interface SourceCandidate {
  source_type: SourceType;
  source_channel: SourceChannel;
  source_id: string;
  source_title: string;
  occurred_at: string;
  sender_and_context: string;
  body_text: string;
  body_preview: string | null;
  from_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  direction: 'inbound' | 'outbound' | 'internal' | null;
  stratum: ExperimentStratum;
  stratum_reason: string;
  r2_key: string | null;
  rank: number;
}

export interface ExperimentCandidate {
  item_id: string;
  deterministic_key: string;
  source_type: SourceType;
  source_channel: SourceChannel;
  source_id: string;
  mention_ordinal: number;
  span_start: number | null;
  span_end: number | null;
  company_name: string;
  normalized_company_name: string;
  raw_span: string;
  raw_excerpt: string;
  source_subject: string;
  source_sender: string;
  occurred_at: string;
  context_char_count: number;
  sender_and_context: string;
  stratum: ExperimentStratum;
  stratum_reason: string;
}

export interface ExperimentPrediction extends ExperimentCandidate {
  classifier_version: string;
  model: string;
  predicted_prospect_action: ProspectAction;
  predicted_mention_type: string;
  should_create_prospect: boolean | null;
  prospect_company_name: string | null;
  predicted_direction: string;
  predicted_sector_key: string;
  confidence: number;
  sector_confidence: number;
  reasoning: string | null;
  create_prospect_veto_applied: boolean;
  create_prospect_veto_reason: string | null;
  valuable_action_veto_applied?: boolean;
  valuable_action_veto_reason?: string | null;
  original_prospect_action: string | null;
  classifier_error: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  cost_usd: number | null;
}

export interface ReviewRow {
  item_id: string;
  predicted_prospect_action: ProspectAction | string;
  lucas_expected_action: ReviewAction | string;
  error_type?: string;
  lucas_notes?: string;
}

export interface ExperimentScoreSummary {
  valuable_review_rows: number;
  valuable_scored_rows: number;
  valuable_result_precision: number | null;
  exact_create_precision: number | null;
  exact_attach_precision: number | null;
  reviewed_set_valuable_recall: number | null;
  create_gate_precision_including_correct_vetoes: number | null;
  false_create_rows: Array<{
    item_id: string;
    company_name: string;
    predicted_prospect_action: string;
    original_prospect_action: string | null;
    lucas_expected_action: string;
    create_prospect_veto_applied: boolean;
    create_prospect_veto_reason: string | null;
    error_type: string | null;
  }>;
  veto_wins: Array<{
    item_id: string;
    company_name: string;
    lucas_expected_action: string;
    create_prospect_veto_reason: string | null;
  }>;
  veto_losses: Array<{
    item_id: string;
    company_name: string;
    lucas_expected_action: string;
    create_prospect_veto_reason: string | null;
  }>;
  known_deal_vs_inbound_confusions: Array<{
    item_id: string;
    company_name: string;
    predicted_prospect_action: string;
    lucas_expected_action: string;
  }>;
  false_valuable_error_type_counts: Record<string, number>;
  artifact_false_create_count: number;
  recall_sample_rows: number;
  recall_sample_scored_rows: number;
  estimated_missed_valuable_rate: number | null;
  missed_valuable_rows: Array<{
    item_id: string;
    company_name: string;
    predicted_prospect_action: string;
    lucas_expected_action: string;
    error_type: string | null;
  }>;
  veto_breakdown: Record<string, number>;
}

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args.set(key, 'true');
    else {
      args.set(key, next);
      i += 1;
    }
  }
  const mode: Args['mode'] = args.get('score') === 'true'
    ? 'score'
    : args.get('merge-shards') === 'true'
    ? 'merge'
    : args.has('replay-review-csv')
    ? 'replay_review'
    : 'run';
  const numberArg = (key: string, fallback: number): number => {
    const raw = args.get(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`INVALID_${key.toUpperCase()}`);
    return Math.floor(n);
  };
  const priceArg = (key: string): number | undefined => {
    const raw = args.get(key);
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`INVALID_${key.toUpperCase()}`);
    return n;
  };
  const sourceShardCount = Math.max(1, numberArg('source-shard-count', mode === 'merge' ? 4 : 1));
  const sourceShardIndex = numberArg('source-shard-index', 0);
  if (sourceShardIndex >= sourceShardCount) {
    throw new Error(`INVALID_SOURCE_SHARD_INDEX index=${sourceShardIndex} count=${sourceShardCount}`);
  }
  const outputDir = args.get('output-dir') || DEFAULT_OUTPUT_DIR;
  const shardDirs = (args.get('shard-dirs') || '')
    .split(',')
    .map(dir => dir.trim())
    .filter(Boolean);
  return {
    mode,
    orgId: args.get('org-id') || 'medina-ventures',
    outputDir,
    reviewInputPath: args.get('replay-review-csv') || null,
    configPath: args.get('config') || 'wrangler.toml',
    database: args.get('database') || 'medina-ventures-db',
    bucket: args.get('bucket') || 'medina-ventures-storage',
    windowStart: args.get('window-start') || DEFAULT_WINDOW_START,
    windowEnd: args.get('window-end') || DEFAULT_WINDOW_END,
    targetRows: numberArg('target-rows', 2000),
    recallSampleRows: numberArg('recall-sample-rows', 200),
    maxTextChars: numberArg('max-text-chars', 6000),
    callDelayMs: numberArg('call-delay-ms', 250),
    retryAttempts: numberArg('retry-attempts', 6),
    classifierConcurrency: Math.max(1, numberArg('classifier-concurrency', 4)),
    reverseClassifierConcurrency: numberArg('reverse-classifier-concurrency', 0),
    sourceShardCount,
    sourceShardIndex,
    shardDirs: shardDirs.length
      ? shardDirs
      : Array.from({ length: sourceShardCount }, (_, index) => join(outputDir, 'shards', String(index).padStart(2, '0'))),
    allowLlmExtraction: args.get('allow-llm-extraction') === 'true',
    r2Fallback: args.get('r2-fallback') === 'true',
    reuseInput: args.get('reuse-input') === 'true',
    resume: args.get('resume') === 'true',
    inputUsdPerMillion: priceArg('input-usd-per-million'),
    outputUsdPerMillion: priceArg('output-usd-per-million'),
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

export function sourceShardBucket(sourceType: string, sourceId: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  const hashPrefix = stableHash(stableSourceKey(sourceType, sourceId)).slice(0, 12);
  return parseInt(hashPrefix, 16) % shardCount;
}

export function isInSourceShard(sourceType: string, sourceId: string, shardCount: number, shardIndex: number): boolean {
  return sourceShardBucket(sourceType, sourceId, shardCount) === shardIndex;
}

function normalizeWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value: unknown, max = 500): string {
  const text = normalizeWhitespace(value);
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function parseEmailList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return text.split(/[;,]/).map(v => v.trim()).filter(Boolean);
}

function csv(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function parseCsv(raw: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter(r => r.some(cell => cell.trim()));
  if (!header) return [];
  return body.map(record => Object.fromEntries(header.map((key, index) => [key, record[index] || ''])));
}

function parseJsonl(raw: string): Record<string, any>[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, any>);
}

export function sourceKeysFromExperimentArtifact(raw: string, path = ''): Set<string> {
  const rows = /\.csv$/i.test(path) ? parseCsv(raw) : parseJsonl(raw);
  const keys = new Set<string>();
  for (const row of rows) {
    const sourceType = String(row.source_type || row.deterministic_source_type || '').trim();
    const sourceId = String(row.source_id || '').trim();
    if (sourceType && sourceId) keys.add(stableSourceKey(sourceType, sourceId));
  }
  return keys;
}

async function walkFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(path));
    else out.push(path);
  }
  return out;
}

async function loadExcludedSourceKeys(): Promise<Set<string>> {
  const paths = [
    ...(await walkFiles(resolve('.prospect-gold-set'))),
    ...(await walkFiles('/Users/lucasfigueroa/Downloads/prospect-large-experiment-2026-06-01')),
    ...(await walkFiles('/Users/lucasfigueroa/Downloads/prospect-large-experiment-2026-06-01/hardened-rerun-review-valuable-2026-06-01')),
    '/Users/lucasfigueroa/Downloads/gold-candidates.human-labeling.qa-clean.csv',
    '/Users/lucasfigueroa/Downloads/gold-candidates.human-labeling.csv',
  ].filter(path => /\.(jsonl|csv)$/i.test(path) && existsSync(path));
  const keys = new Set<string>();
  for (const path of paths) {
    try {
      for (const key of sourceKeysFromExperimentArtifact(await readFile(path, 'utf8'), path)) keys.add(key);
    } catch {
      // Ignore non-row CSV/JSONL artifacts in the experiment directories.
    }
  }
  return keys;
}

function runWranglerJson<T>(args: string[]): RemoteQueryResult<T> {
  const stdout = execFileSync('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 80 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Array<{ results?: T[]; meta?: Partial<RemoteMeta>; success?: boolean }>;
  const first = parsed[0] || {};
  if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
  return { results: first.results || [], meta: first.meta || {} };
}

function recordRemoteMeta(total: RemoteMeta, meta: Partial<RemoteMeta> | undefined): void {
  total.query_count += 1;
  total.rows_read += Number(meta?.rows_read || 0);
  total.rows_written += Number(meta?.rows_written || 0);
  total.changed_db = Boolean(total.changed_db || meta?.changed_db);
  if (Number(meta?.rows_written || 0) !== 0 || meta?.changed_db) {
    throw new Error(`REMOTE_D1_READ_ONLY_VIOLATION rows_written=${meta?.rows_written || 0} changed_db=${Boolean(meta?.changed_db)}`);
  }
}

function remoteSelect<T>(args: Args, meta: RemoteMeta, command: string): T[] {
  const result = runWranglerJson<T>(['d1', 'execute', args.database, '--remote', '--json', '--command', command]);
  recordRemoteMeta(meta, result.meta);
  return result.results;
}

function r2Get(args: Args, key: string | null | undefined): string | null {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  const path = join(tmpdir(), `prospect-large-${stableHash(normalizedKey).slice(0, 16)}.txt`);
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${args.bucket}/${normalizedKey}`, '--remote', '--file', path], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return readFileSync(path, 'utf8').slice(0, args.maxTextChars);
  } catch {
    return null;
  }
}

function platformProxyOptions(args: Args) {
  return {
    configPath: args.configPath,
    persist: { path: join(args.outputDir, '.wrangler-state') },
  };
}

async function ensureLocalBudgetLedger(env: Env): Promise<void> {
  await env.D1.prepare(`
    CREATE TABLE IF NOT EXISTS upstream_budget_ledger (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '*',
      upstream TEXT NOT NULL,
      bucket_window TEXT NOT NULL,
      bucket_start TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      cap INTEGER NOT NULL,
      last_429_at TEXT,
      consecutive_429s INTEGER NOT NULL DEFAULT 0,
      circuit_open_until TEXT,
      cap_lowered_at TEXT,
      cap_lowered_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id, upstream, bucket_window)
    )
  `).run();
}

function sourceText(row: any): string {
  return [row.subject, row.title, row.body_preview, row.summary, row.description, row.extracted_text_preview]
    .filter(Boolean)
    .join('\n');
}

function likeAny(columns: string[], terms: string[]): string {
  const clauses: string[] = [];
  for (const term of terms) {
    const clean = term.toLowerCase().trim();
    if (!clean) continue;
    const pattern = sqlString(`%${clean}%`);
    for (const column of columns) clauses.push(`lower(COALESCE(${column}, '')) LIKE ${pattern}`);
  }
  return clauses.length ? `(${clauses.join(' OR ')})` : '(1=0)';
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function toConversation(row: any, stratum: ExperimentStratum, reason: string, rank: number, args: Args): SourceCandidate {
  const sourceChannel: SourceChannel = row.source === 'slack' ? 'slack' : 'email';
  return {
    source_type: 'conversation',
    source_channel: sourceChannel,
    source_id: row.id,
    source_title: row.subject || row.source || '',
    occurred_at: row.sent_at || row.created_at || '',
    sender_and_context: compactText(`from ${row.from_email || 'unknown'}; subject ${row.subject || '(none)'}; channel ${row.source || sourceChannel}; sent ${row.sent_at || row.created_at || ''}`),
    body_text: sourceText(row).slice(0, args.maxTextChars),
    body_preview: row.body_preview || null,
    from_email: row.from_email || null,
    to_emails: parseEmailList(row.to_emails),
    cc_emails: parseEmailList(row.cc_emails),
    direction: row.direction || null,
    stratum,
    stratum_reason: reason,
    r2_key: row.body_r2_key || null,
    rank,
  };
}

function toEvent(row: any, stratum: ExperimentStratum, reason: string, rank: number, args: Args): SourceCandidate {
  return {
    source_type: 'event',
    source_channel: 'meeting',
    source_id: row.id,
    source_title: row.title || '',
    occurred_at: row.start_time || row.created_at || '',
    sender_and_context: compactText(`event ${row.title || '(untitled)'}; type ${row.event_type || '(none)'}; source ${row.source || '(none)'}; start ${row.start_time || row.created_at || ''}`),
    body_text: sourceText(row).slice(0, args.maxTextChars),
    body_preview: row.summary || row.description || null,
    from_email: null,
    to_emails: [],
    cc_emails: [],
    direction: null,
    stratum,
    stratum_reason: reason,
    r2_key: row.transcript_r2_key || null,
    rank,
  };
}

function toDocument(row: any, stratum: ExperimentStratum, reason: string, rank: number, args: Args): SourceCandidate {
  const text = sourceText(row).slice(0, args.maxTextChars);
  return {
    source_type: 'document',
    source_channel: 'document',
    source_id: row.id,
    source_title: row.title || row.file_name || '',
    occurred_at: row.created_at || '',
    sender_and_context: compactText(`document ${row.title || row.file_name || '(untitled)'}; type ${row.document_type || '(none)'}; source ${row.source || '(none)'}; created ${row.created_at || ''}`),
    body_text: text,
    body_preview: row.extracted_text_preview || null,
    from_email: null,
    to_emails: [],
    cc_emails: [],
    direction: null,
    stratum,
    stratum_reason: reason,
    r2_key: null,
    rank,
  };
}

function queryConversations(args: Args, meta: RemoteMeta, where: string, limit: number, stratum: ExperimentStratum, reason: string, random = false): SourceCandidate[] {
  const rows = remoteSelect<any>(args, meta, `
    SELECT id, source, subject, body_r2_key, body_preview, from_email, to_emails, cc_emails, direction, sent_at, created_at
      FROM conversations
     WHERE org_id = ${sqlString(args.orgId)}
       AND COALESCE(sent_at, created_at) >= ${sqlString(args.windowStart)}
       AND COALESCE(sent_at, created_at) < ${sqlString(args.windowEnd)}
       AND ${where}
     ORDER BY ${random ? 'random()' : 'COALESCE(sent_at, created_at) DESC, id ASC'}
     LIMIT ${Math.max(0, limit)}
  `);
  return rows.map((row, index) => toConversation(row, stratum, reason, index, args));
}

function queryEvents(args: Args, meta: RemoteMeta, where: string, limit: number, stratum: ExperimentStratum, reason: string, random = false): SourceCandidate[] {
  const rows = remoteSelect<any>(args, meta, `
    SELECT id, title, event_type, start_time, source, description, summary, transcript_r2_key, created_at
      FROM events
     WHERE org_id = ${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND COALESCE(start_time, created_at) >= ${sqlString(args.windowStart)}
       AND COALESCE(start_time, created_at) < ${sqlString(args.windowEnd)}
       AND ${where}
     ORDER BY ${random ? 'random()' : 'COALESCE(start_time, created_at) DESC, id ASC'}
     LIMIT ${Math.max(0, limit)}
  `);
  return rows.map((row, index) => toEvent(row, stratum, reason, index, args));
}

function queryDocuments(args: Args, meta: RemoteMeta, where: string, limit: number, stratum: ExperimentStratum, reason: string, random = false): SourceCandidate[] {
  const rows = remoteSelect<any>(args, meta, `
    SELECT id, title, file_name, document_type, source, extracted_text_preview, created_at
      FROM documents
     WHERE org_id = ${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND created_at >= ${sqlString(args.windowStart)}
       AND created_at < ${sqlString(args.windowEnd)}
       AND ${where}
     ORDER BY ${random ? 'random()' : 'created_at DESC, id ASC'}
     LIMIT ${Math.max(0, limit)}
  `);
  return rows.map((row, index) => toDocument(row, stratum, reason, index, args));
}

function loadKnownContextFromRemote(args: Args, meta: RemoteMeta): ProspectClassifierKnownContext {
  const knownDeals = remoteSelect<KnownEntity>(args, meta, `
    SELECT DISTINCT c.name AS name, COALESCE(c.domain, c.website) AS domain
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
     WHERE c.org_id = ${sqlString(args.orgId)}
       AND c.deleted_at IS NULL
       AND (d.id IS NOT NULL OR f.company_id IS NOT NULL)
     ORDER BY lower(c.name)
     LIMIT 250
  `).filter(row => row.name).map(row => ({ name: row.name, domain: row.domain }));
  const knownDealmakers = remoteSelect<KnownEntity>(args, meta, `
    SELECT name,
           CASE
             WHEN domain IS NOT NULL AND trim(domain) != '' THEN lower(domain)
             WHEN normalized_email IS NOT NULL AND instr(normalized_email, '@') > 0
             THEN lower(substr(normalized_email, instr(normalized_email, '@') + 1))
             ELSE NULL
           END AS domain
      FROM dealmakers
     WHERE org_id = ${sqlString(args.orgId)}
       AND name IS NOT NULL
       AND trim(name) != ''
     ORDER BY last_seen_at DESC NULLS LAST, lower(name)
     LIMIT 250
  `).filter(row => row.name).map(row => ({ name: row.name, domain: row.domain }));
  return { knownDeals, knownDealmakers };
}

function knownSearchTerms(knownContext: ProspectClassifierKnownContext): string[] {
  const terms = new Set<string>();
  for (const row of knownContext.knownDeals) {
    const name = normalizeWhitespace(row.name);
    if (name.length >= 4) terms.add(name);
    const domain = String(row.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const first = domain.split('.')[0];
    if (first.length >= 4) terms.add(first);
  }
  return [...terms].slice(0, 80);
}

function candidateMatchesKnownDeal(candidate: ExperimentCandidate, knownContext: ProspectClassifierKnownContext): boolean {
  const candidateName = __prospectIntelligenceTestHooks.normalizeProspectName(candidate.company_name);
  if (!candidateName || candidateName.length < 4) return false;
  if (VALIDATED_KNOWN_DEAL_ALIASES.has(candidateName)) return true;
  for (const row of knownContext.knownDeals) {
    const knownName = __prospectIntelligenceTestHooks.normalizeProspectName(row.name);
    if (
      knownName &&
      knownName.length >= 4 &&
      (knownName === candidateName || knownName.includes(candidateName) || candidateName.includes(knownName))
    ) {
      return true;
    }
    const domain = String(row.domain || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
    const domainLabel = domain.split('.')[0] || '';
    const knownDomainName = __prospectIntelligenceTestHooks.normalizeProspectName(domainLabel);
    if (
      knownDomainName &&
      knownDomainName.length >= 4 &&
      (knownDomainName === candidateName || knownDomainName.includes(candidateName) || candidateName.includes(knownDomainName))
    ) {
      return true;
    }
  }
  return false;
}

function loadSources(args: Args, meta: RemoteMeta, knownContext: ProspectClassifierKnownContext): SourceCandidate[] {
  const sourceBudget = Math.max(args.targetRows * 5, 120);
  const inboundTerms = ['introducing', 'introduction', 'connect you with', 'warm intro', 'deck', 'pitch', 'raising', 'fundraise', 'diligence', 'demo'];
  const hardNegativeTerms = ['invoice', 'billing', 'docusign', 'greenberg', 'ramp', 'mastercard', 'investor', 'led by', 'newsletter', 'press', 'salesforce', 'verification', 'reseller', 'customer', 'partner', 'finalis', 'securities'];
  const sources: SourceCandidate[] = [];
  sources.push(...queryConversations(args, meta, `source != 'slack' AND lower(COALESCE(from_email, '')) NOT LIKE '%medinavc.com%' AND ${likeAny(['subject', 'body_preview'], inboundTerms)}`, Math.ceil(sourceBudget * 0.30), 'enriched_inbound', 'inbound_terms'));
  sources.push(...queryEvents(args, meta, likeAny(['title', 'summary', 'description'], inboundTerms), Math.ceil(sourceBudget * 0.06), 'enriched_inbound', 'inbound_event_terms'));
  sources.push(...queryDocuments(args, meta, likeAny(['title', 'extracted_text_preview'], inboundTerms), Math.ceil(sourceBudget * 0.06), 'enriched_inbound', 'inbound_document_terms'));

  const knownTerms = knownSearchTerms(knownContext);
  for (const [index, terms] of chunk(knownTerms, 25).entries()) {
    const limit = Math.ceil((sourceBudget * 0.22) / Math.max(1, Math.ceil(knownTerms.length / 25)));
    sources.push(...queryConversations(args, meta, likeAny(['subject', 'body_preview', 'from_email'], terms), limit, 'enriched_known_deal', `known_context_terms_${index + 1}`));
    sources.push(...queryEvents(args, meta, likeAny(['title', 'summary', 'description'], terms), Math.ceil(limit / 3), 'enriched_known_deal', `known_context_events_${index + 1}`));
    sources.push(...queryDocuments(args, meta, likeAny(['title', 'extracted_text_preview'], terms), Math.ceil(limit / 3), 'enriched_known_deal', `known_context_documents_${index + 1}`));
  }

  sources.push(...queryConversations(args, meta, likeAny(['subject', 'body_preview', 'from_email'], hardNegativeTerms), Math.ceil(sourceBudget * 0.20), 'hard_negative', 'hard_negative_terms'));
  sources.push(...queryDocuments(args, meta, likeAny(['title', 'extracted_text_preview'], hardNegativeTerms), Math.ceil(sourceBudget * 0.06), 'hard_negative', 'hard_negative_documents'));
  sources.push(...queryConversations(args, meta, '1=1', Math.ceil(sourceBudget * 0.08), 'representative', 'random_conversation', true));
  sources.push(...queryEvents(args, meta, '1=1', Math.ceil(sourceBudget * 0.04), 'representative', 'random_event', true));
  sources.push(...queryDocuments(args, meta, '1=1', Math.ceil(sourceBudget * 0.04), 'representative', 'random_document', true));

  const seen = new Set<string>();
  return sources.filter(source => {
    const key = `${source.source_type}:${source.source_id}:${source.stratum}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(source.body_text.trim() || source.source_title.trim());
  });
}

function balancedSourceOrder(sources: SourceCandidate[], targetRows: number): SourceCandidate[] {
  const targets: Record<ExperimentStratum, number> = {
    enriched_inbound: Math.round(targetRows * 0.40),
    enriched_known_deal: Math.round(targetRows * 0.25),
    hard_negative: Math.round(targetRows * 0.20),
    representative: Math.max(0, targetRows - Math.round(targetRows * 0.40) - Math.round(targetRows * 0.25) - Math.round(targetRows * 0.20)),
  };
  const queues = Object.fromEntries(STRATA.map(stratum => [
    stratum,
    sources.filter(source => source.stratum === stratum).sort((a, b) => a.rank - b.rank || a.source_id.localeCompare(b.source_id)),
  ])) as Record<ExperimentStratum, SourceCandidate[]>;
  const emitted: Record<ExperimentStratum, number> = { enriched_inbound: 0, enriched_known_deal: 0, hard_negative: 0, representative: 0 };
  const out: SourceCandidate[] = [];
  while (STRATA.some(stratum => queues[stratum].length > 0)) {
    const next = STRATA
      .filter(stratum => queues[stratum].length > 0)
      .sort((a, b) => (emitted[a] / Math.max(1, targets[a])) - (emitted[b] / Math.max(1, targets[b])))[0];
    const source = queues[next].shift();
    if (!source) break;
    emitted[next] += 1;
    out.push(source);
  }
  return out;
}

async function extractMentionsForSource(
  args: Args,
  env: Env,
  knownContext: ProspectClassifierKnownContext,
  source: SourceCandidate
) {
  const extractFrom = (bodyText: string, allowLlm: boolean) => extractOrganizationMentionsFromSource({
    type: source.source_channel === 'email' ? 'email' : source.source_channel === 'slack' ? 'slack_message' : source.source_channel === 'meeting' ? 'calendar_event' : 'news',
    entityType: source.source_type,
    entityId: source.source_id,
    subject: source.source_title,
    bodyText,
    bodyPreview: source.body_preview || undefined,
    fromEmail: source.from_email || undefined,
    toEmails: source.to_emails,
    ccEmails: source.cc_emails,
    direction: source.direction || undefined,
    sentAt: source.occurred_at,
    text: bodyText,
  } as any, args.orgId, env, {
    knownContext,
    maxLlmOrganizations: 16,
    allowLlm,
    forceLlm: false,
  });
  const previewMentions = await extractFrom(source.body_text, false);
  if (previewMentions.length > 0 || !source.r2_key || !args.r2Fallback) return previewMentions;
  const hydrated = r2Get(args, source.r2_key);
  if (!hydrated || hydrated === source.body_text) return previewMentions;
  try {
    return await extractFrom(hydrated, args.allowLlmExtraction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`source extraction failed ${source.source_type}:${source.source_id}; falling back to preview mentions; error=${message.slice(0, 240)}\n`);
    return previewMentions;
  }
}

async function extractCandidates(
  args: Args,
  env: Env,
  knownContext: ProspectClassifierKnownContext,
  sources: SourceCandidate[],
  excludedSourceKeys: Set<string>
): Promise<ExperimentCandidate[]> {
  const records: ExperimentCandidate[] = [];
  const seenMentions = new Set<string>();
  const orderedSources = balancedSourceOrder(sources, args.targetRows);
  let nextProgress = 100;
  for (const source of orderedSources) {
    if (records.length >= args.targetRows) break;
    if (excludedSourceKeys.has(stableSourceKey(source.source_type, source.source_id))) continue;
    const mentions = await extractMentionsForSource(args, env, knownContext, source);
    for (const mention of mentions) {
      if (records.length >= args.targetRows) break;
      const deterministicKey = `${source.source_type}:${source.source_id}:${mention.mentionOrdinal}:${mention.spanStart ?? 'na'}:${mention.spanEnd ?? 'na'}`;
      const dedupeKey = `${deterministicKey}:${mention.normalizedName}`;
      if (seenMentions.has(dedupeKey)) continue;
      seenMentions.add(dedupeKey);
      const context = mention.contextText || mention.lineText || source.body_text;
      records.push({
        item_id: deterministicKey,
        deterministic_key: deterministicKey,
        source_type: source.source_type,
        source_channel: source.source_channel,
        source_id: source.source_id,
        mention_ordinal: mention.mentionOrdinal,
        span_start: mention.spanStart,
        span_end: mention.spanEnd,
        company_name: mention.canonicalName,
        normalized_company_name: mention.normalizedName,
        raw_span: mention.raw,
        raw_excerpt: compactText(context, 4000),
        source_subject: source.source_title,
        source_sender: source.from_email || '',
        occurred_at: source.occurred_at,
        context_char_count: context.length,
        sender_and_context: source.sender_and_context,
        stratum: source.stratum,
        stratum_reason: source.stratum_reason,
      });
    }
    if (records.length >= nextProgress) {
      process.stderr.write(`selected ${records.length}/${args.targetRows} candidate rows\n`);
      nextProgress += 100;
    }
  }
  if (records.length < args.targetRows) {
    throw new Error(`INSUFFICIENT_CANDIDATES selected=${records.length} target=${args.targetRows}; rerun with --allow-llm-extraction true or a larger source window`);
  }
  return records;
}

function requireTokenedGateway(env: Env): Env {
  const token = String((env as any).CLOUDFLARE_AI_GATEWAY_TOKEN || process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '').trim();
  if (!token) throw new Error('ZDR_GATEWAY_REQUIRED: CLOUDFLARE_AI_GATEWAY_TOKEN missing; refusing non-tokened classifier run');
  if (!env.CLOUDFLARE_AI_GATEWAY_SLUG) throw new Error('ZDR_GATEWAY_REQUIRED: CLOUDFLARE_AI_GATEWAY_SLUG missing');
  return { ...(env as any), CLOUDFLARE_AI_GATEWAY_TOKEN: token } as Env;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|CLAUDE_RATE_LIMITED|429/i.test(message);
}

function isRetryableClassifierError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isRateLimitError(error) || /\b(fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|503|504)\b/i.test(message);
}

function prefilterHintsForCandidate(record: ExperimentCandidate, sectorHint: { key: string; confidence: number }): Record<string, unknown> {
  const text = `${record.sender_and_context}\n${record.raw_excerpt}`.toLowerCase();
  const reasons: string[] = [];
  if (/\b(newsletter|digest|nvca|market update|press|smartbrief)\b/.test(text)) reasons.push('newsletter_like_source');
  if (/\b(deck|pitch deck|data room|memo|cim)\b/.test(text)) reasons.push('deck_signal');
  if (/\b(meeting|met with|call|zoom|demo)\b/.test(text)) reasons.push('meeting_or_call_signal');
  if (/\b(intro|introducing|warm intro|referred|forwarding)\b/.test(text)) reasons.push('warm_intro_language');
  if (/^\s*(?:[-*]|\d+[.)])\s+/m.test(record.raw_excerpt)) reasons.push('list_entry_shape');
  return {
    should_classify: true,
    large_experiment_harness: true,
    reasons,
    deterministic_direction: 'unknown',
    newsletter_likely: reasons.includes('newsletter_like_source'),
    signal_kind_hint: reasons.includes('deck_signal')
      ? 'deck'
      : reasons.includes('meeting_or_call_signal')
      ? 'meeting'
      : reasons.includes('warm_intro_language')
      ? 'intro'
      : reasons.includes('list_entry_shape')
      ? 'list_entry'
      : 'cold_mention',
    has_deck: reasons.includes('deck_signal'),
    has_meeting_or_call: reasons.includes('meeting_or_call_signal'),
    has_warm_intro_language: reasons.includes('warm_intro_language'),
    sector_hint: sectorHint,
  };
}

function costFor(usage: { input_tokens: number; output_tokens: number }, args: Args): number | null {
  if (args.inputUsdPerMillion == null || args.outputUsdPerMillion == null) return null;
  return (usage.input_tokens / 1_000_000) * args.inputUsdPerMillion +
    (usage.output_tokens / 1_000_000) * args.outputUsdPerMillion;
}

async function classifyCandidate(
  candidate: ExperimentCandidate,
  knownContext: ProspectClassifierKnownContext,
  env: Env,
  args: Args
): Promise<ExperimentPrediction> {
  const sectorHint = __prospectIntelligenceTestHooks.sectorHintForText(`${candidate.company_name}\n${candidate.raw_excerpt}`);
  const classifierInput = {
    sourceType: candidate.source_channel,
    senderAndContext: candidate.sender_and_context,
    companyName: candidate.company_name,
    rawExcerpt: candidate.raw_excerpt,
    prefilterHints: prefilterHintsForCandidate(candidate, sectorHint),
    sectorHints: sectorHint,
    knownContext,
    orgId: args.orgId,
  };
  const usage = { input_tokens: 0, output_tokens: 0 };
  try {
    let decision: Awaited<ReturnType<typeof callProspectClassifier>> | null = null;
    for (let attempt = 1; attempt <= args.retryAttempts; attempt++) {
      try {
        decision = await callProspectClassifier(classifierInput, env);
        break;
      } catch (error) {
        if (!isRetryableClassifierError(error) || attempt >= args.retryAttempts) throw error;
        const backoffMs = Math.max(args.callDelayMs, attempt * 2_000);
        const retryKind = isRateLimitError(error) ? 'rate limited' : 'transient classifier failure';
        process.stderr.write(`${retryKind} ${candidate.item_id}; retry ${attempt + 1}/${args.retryAttempts} after ${backoffMs}ms\n`);
        await sleep(backoffMs);
      }
    }
    if (!decision) throw new Error('CLASSIFIER_RETRY_EXHAUSTED');
    usage.input_tokens = decision.usage?.input_tokens || 0;
    usage.output_tokens = decision.usage?.output_tokens || 0;
    const veto = __prospectIntelligenceTestHooks.prospectValuableActionVetoForMention({
      prospectAction: decision.prospectAction,
      companyName: candidate.company_name,
      rawMention: candidate.raw_span,
      rawExcerpt: candidate.raw_excerpt,
      senderAndContext: candidate.sender_and_context,
      prospectCompanyName: decision.prospectCompanyName,
      llmReasoning: decision.reasoning,
    });
    const knownDealMatch = candidateMatchesKnownDeal(candidate, knownContext);
    const action = (
      veto.applied
        ? (veto.nonValuableAction || 'ignore')
        : knownDealMatch && (decision.prospectAction === 'create_prospect' || decision.prospectAction === 'record_context')
          ? 'attach_existing_deal'
          : decision.prospectAction
    ) as ProspectAction;
    return {
      ...candidate,
      classifier_version: PROSPECT_CLASSIFIER_VERSION,
      model: decision.model,
      predicted_prospect_action: action,
      predicted_mention_type: veto.applied ? 'noise' : action === 'attach_existing_deal' ? 'known_deal' : decision.mentionType,
      should_create_prospect: action === 'create_prospect',
      prospect_company_name: action === 'create_prospect' ? (decision.prospectCompanyName || candidate.company_name) : null,
      predicted_direction: decision.direction,
      predicted_sector_key: decision.sectorKey,
      confidence: veto.applied ? (veto.confidence || 0.97) : decision.confidence,
      sector_confidence: decision.sectorConfidence,
      reasoning: decision.reasoning,
      create_prospect_veto_applied: decision.prospectAction === 'create_prospect' && veto.applied,
      create_prospect_veto_reason: decision.prospectAction === 'create_prospect' ? veto.reason : null,
      valuable_action_veto_applied: veto.applied,
      valuable_action_veto_reason: veto.reason,
      original_prospect_action: decision.prospectAction,
      classifier_error: null,
      usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
      cost_usd: costFor(usage, args),
    };
  } catch (error) {
    return {
      ...candidate,
      classifier_version: PROSPECT_CLASSIFIER_VERSION,
      model: String(env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || 'claude-haiku-4-5-20251001'),
      predicted_prospect_action: 'classifier_error',
      predicted_mention_type: 'classifier_error',
      should_create_prospect: null,
      prospect_company_name: null,
      predicted_direction: 'classifier_error',
      predicted_sector_key: 'classifier_error',
      confidence: 0,
      sector_confidence: 0,
      reasoning: null,
      create_prospect_veto_applied: false,
      create_prospect_veto_reason: null,
      original_prospect_action: null,
      classifier_error: error instanceof Error ? error.message : String(error),
      usage: { ...usage, total_tokens: 0 },
      cost_usd: costFor(usage, args),
    };
  }
}

function countBy<T>(rows: T[], getKey: (row: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = getKey(row);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function recallSample(predictions: ExperimentPrediction[], targetRows: number): ExperimentPrediction[] {
  const eligible = predictions
    .filter(row => row.predicted_prospect_action === 'ignore' || row.predicted_prospect_action === 'record_context')
    .sort((a, b) => stableHash(a.item_id).localeCompare(stableHash(b.item_id)));
  const groups = new Map<string, ExperimentPrediction[]>();
  for (const row of eligible) {
    const key = `${row.predicted_prospect_action}:${row.stratum}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const out: ExperimentPrediction[] = [];
  const keys = [...groups.keys()].sort();
  const perGroup = Math.max(1, Math.floor(targetRows / Math.max(1, keys.length)));
  for (const key of keys) {
    for (const row of (groups.get(key) || []).slice(0, perGroup)) {
      if (out.length < targetRows) out.push(row);
    }
  }
  for (const row of eligible) {
    if (out.length >= targetRows) break;
    if (!out.some(selected => selected.item_id === row.item_id)) out.push(row);
  }
  return out;
}

function reviewCsv(rows: ExperimentPrediction[]): string {
  const header = [
    'item_id',
    'source_type',
    'source_id',
    'mention_ordinal',
    'company_name',
    'prospect_company_name',
    'predicted_prospect_action',
    'predicted_mention_type',
    'predicted_direction',
    'predicted_sector_key',
    'confidence',
    'create_prospect_veto_applied',
    'create_prospect_veto_reason',
    'valuable_action_veto_applied',
    'valuable_action_veto_reason',
    'source_subject',
    'source_sender',
    'occurred_at',
    'sender_and_context',
    'raw_excerpt',
    'reasoning',
    'lucas_expected_action',
    'lucas_notes',
    'error_type',
  ];
  return [
    header.map(csv).join(','),
    ...rows.map(row => [
      row.item_id,
      row.source_type,
      row.source_id,
      row.mention_ordinal,
      row.company_name,
      row.prospect_company_name || '',
      row.predicted_prospect_action,
      row.predicted_mention_type,
      row.predicted_direction,
      row.predicted_sector_key,
      row.confidence,
      row.create_prospect_veto_applied,
      row.create_prospect_veto_reason || '',
      row.valuable_action_veto_applied || false,
      row.valuable_action_veto_reason || '',
      row.source_subject,
      row.source_sender,
      row.occurred_at,
      row.sender_and_context,
      row.raw_excerpt,
      row.reasoning || '',
      '',
      '',
      '',
    ].map(csv).join(',')),
  ].join('\n') + '\n';
}

function markdownTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' |')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ];
}

function experimentReport(args: Args, predictions: ExperimentPrediction[], recallRows: ExperimentPrediction[], meta: RemoteMeta): string {
  const valuable = predictions.filter(row => VALUABLE_ACTIONS.has(row.predicted_prospect_action));
  const usage = predictions.reduce((acc, row) => ({
    input_tokens: acc.input_tokens + row.usage.input_tokens,
    output_tokens: acc.output_tokens + row.usage.output_tokens,
    total_tokens: acc.total_tokens + row.usage.total_tokens,
    cost_usd: acc.cost_usd + (row.cost_usd || 0),
  }), { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 });
  const lines = [
    '# Prospect Large Classifier Experiment',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Window: ${args.windowStart} through ${args.windowEnd}`,
    `- Source shard: ${args.sourceShardIndex}/${args.sourceShardCount}`,
    `- Classifier version: ${PROSPECT_CLASSIFIER_VERSION}`,
    `- Rows: ${predictions.length}`,
    `- Valuable review rows: ${valuable.length}`,
    `- Recall sample rows: ${recallRows.length}`,
    `- Remote D1 rows_written: ${meta.rows_written}`,
    `- Remote D1 changed_db: ${meta.changed_db}`,
    `- Cost estimate: ${usage.cost_usd ? `$${usage.cost_usd.toFixed(6)}` : '(not priced; pass --input-usd-per-million and --output-usd-per-million)'}`,
    '',
    '## Predicted Actions',
    ...markdownTable([
      ['action', 'count'],
      ...Object.entries(countBy(predictions, row => row.predicted_prospect_action)).map(([key, value]) => [key, String(value)]),
    ]),
    '',
    '## Veto Breakdown',
    ...markdownTable([
      ['reason', 'count'],
      ...Object.entries(countBy(predictions.filter(row => row.create_prospect_veto_applied), row => row.create_prospect_veto_reason || 'unknown')).map(([key, value]) => [key, String(value)]),
    ]),
    '',
    '## Review Instructions',
    `1. Label ${join(args.outputDir, 'review-valuable.csv')} for predicted create_prospect and attach_existing_deal rows.`,
    `2. Label ${join(args.outputDir, 'review-recall-sample.csv')} for the sampled non-valuable rows.`,
    '3. Use lucas_expected_action values: create_prospect, attach_existing_deal, record_context, ignore, or adjudicate. Legacy labels known_deal, inbound_prospect, intro_source, and noise are also accepted by the scorer.',
    `4. Score after labeling: npm run prospect:large-experiment -- --score --output-dir ${args.outputDir}`,
  ];
  return `${lines.join('\n')}\n`;
}

function scoreLabel(value: string | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === '-') return null;
  if (normalized === 'nist') return 'ignore';
  if (
    normalized.includes('company being pitched') ||
    normalized.includes('company name here') ||
    normalized.includes('investment opportunity here') ||
    normalized.includes('opportunity here')
  ) return 'create_prospect';
  if (!REVIEW_ACTIONS.has(normalized)) return null;
  if (normalized === 'adjudicate') return null;
  return REVIEW_LABEL_TO_ACTION[normalized] || null;
}

export function scoreExperiment(
  predictions: ExperimentPrediction[],
  valuableReviews: ReviewRow[],
  recallReviews: ReviewRow[]
): ExperimentScoreSummary {
  const byId = new Map(predictions.map(row => [row.item_id, row]));
  const valuableScored = valuableReviews
    .map(row => ({ row, prediction: byId.get(row.item_id), label: scoreLabel(String(row.lucas_expected_action || '')) }))
    .filter(entry => entry.prediction && entry.label);
  const valuableCorrect = valuableScored.filter(entry => VALUABLE_ACTIONS.has(entry.label!)).length;
  const createRows = valuableScored.filter(entry => entry.prediction!.predicted_prospect_action === 'create_prospect');
  const attachRows = valuableScored.filter(entry => entry.prediction!.predicted_prospect_action === 'attach_existing_deal');
  const falseValuable = valuableScored.filter(entry => !VALUABLE_ACTIONS.has(entry.label!));
  const falseCreateRows = valuableScored.filter(entry => entry.prediction!.predicted_prospect_action === 'create_prospect' && entry.label !== 'create_prospect');
  const errorTypeCounts = countBy(falseValuable, entry => String(entry.row.error_type || 'unlabeled_error_type').trim() || 'unlabeled_error_type');
  const recallScored = recallReviews
    .map(row => ({ row, prediction: byId.get(row.item_id), label: scoreLabel(String(row.lucas_expected_action || '')) }))
    .filter(entry => entry.prediction && entry.label);
  const missed = recallScored.filter(entry => VALUABLE_ACTIONS.has(entry.label!));
  const reviewedScoredByItem = new Map<string, typeof valuableScored[number]>();
  for (const entry of [...valuableScored, ...recallScored]) {
    if (!reviewedScoredByItem.has(entry.prediction!.item_id)) reviewedScoredByItem.set(entry.prediction!.item_id, entry);
  }
  const reviewedScored = [...reviewedScoredByItem.values()];
  const reviewedTrueValuable = reviewedScored.filter(entry => VALUABLE_ACTIONS.has(entry.label!));
  const reviewedTrueValuablePredictedValuable = reviewedTrueValuable.filter(entry =>
    VALUABLE_ACTIONS.has(entry.prediction!.predicted_prospect_action)
  );
  const createGateRows = reviewedScored.filter(entry =>
    entry.prediction!.predicted_prospect_action === 'create_prospect' ||
    entry.prediction!.original_prospect_action === 'create_prospect' ||
    entry.prediction!.create_prospect_veto_applied
  );
  const createGateCorrect = createGateRows.filter(entry => {
    const prediction = entry.prediction!;
    if (prediction.predicted_prospect_action === 'create_prospect') return entry.label === 'create_prospect';
    if (prediction.create_prospect_veto_applied && prediction.original_prospect_action === 'create_prospect') {
      return entry.label !== 'create_prospect';
    }
    return false;
  }).length;
  const vetoedRows = reviewedScored.filter(entry => entry.prediction!.create_prospect_veto_applied);
  const vetoWins = vetoedRows.filter(entry => entry.label !== 'create_prospect');
  const vetoLosses = vetoedRows.filter(entry => entry.label === 'create_prospect');
  return {
    valuable_review_rows: valuableReviews.length,
    valuable_scored_rows: valuableScored.length,
    valuable_result_precision: valuableScored.length ? valuableCorrect / valuableScored.length : null,
    exact_create_precision: createRows.length ? createRows.filter(entry => entry.label === 'create_prospect').length / createRows.length : null,
    exact_attach_precision: attachRows.length ? attachRows.filter(entry => entry.label === 'attach_existing_deal').length / attachRows.length : null,
    reviewed_set_valuable_recall: reviewedTrueValuable.length ? reviewedTrueValuablePredictedValuable.length / reviewedTrueValuable.length : null,
    create_gate_precision_including_correct_vetoes: createGateRows.length ? createGateCorrect / createGateRows.length : null,
    false_create_rows: falseCreateRows.map(entry => ({
      item_id: entry.prediction!.item_id,
      company_name: entry.prediction!.company_name,
      predicted_prospect_action: entry.prediction!.predicted_prospect_action,
      original_prospect_action: entry.prediction!.original_prospect_action,
      lucas_expected_action: entry.label!,
      create_prospect_veto_applied: entry.prediction!.create_prospect_veto_applied,
      create_prospect_veto_reason: entry.prediction!.create_prospect_veto_reason,
      error_type: entry.row.error_type || null,
    })),
    veto_wins: vetoWins.map(entry => ({
      item_id: entry.prediction!.item_id,
      company_name: entry.prediction!.company_name,
      lucas_expected_action: entry.label!,
      create_prospect_veto_reason: entry.prediction!.create_prospect_veto_reason,
    })),
    veto_losses: vetoLosses.map(entry => ({
      item_id: entry.prediction!.item_id,
      company_name: entry.prediction!.company_name,
      lucas_expected_action: entry.label!,
      create_prospect_veto_reason: entry.prediction!.create_prospect_veto_reason,
    })),
    known_deal_vs_inbound_confusions: valuableScored
      .filter(entry =>
        (entry.prediction!.predicted_prospect_action === 'create_prospect' && entry.label === 'attach_existing_deal') ||
        (entry.prediction!.predicted_prospect_action === 'attach_existing_deal' && entry.label === 'create_prospect')
      )
      .map(entry => ({
        item_id: entry.prediction!.item_id,
        company_name: entry.prediction!.company_name,
        predicted_prospect_action: entry.prediction!.predicted_prospect_action,
        lucas_expected_action: entry.label!,
      })),
    false_valuable_error_type_counts: errorTypeCounts,
    artifact_false_create_count: falseCreateRows.filter(entry => entry.row.error_type === 'artifact').length,
    recall_sample_rows: recallReviews.length,
    recall_sample_scored_rows: recallScored.length,
    estimated_missed_valuable_rate: recallScored.length ? missed.length / recallScored.length : null,
    missed_valuable_rows: missed.map(entry => ({
      item_id: entry.prediction!.item_id,
      company_name: entry.prediction!.company_name,
      predicted_prospect_action: entry.prediction!.predicted_prospect_action,
      lucas_expected_action: entry.label!,
      error_type: entry.row.error_type || null,
    })),
    veto_breakdown: countBy(predictions.filter(row => row.create_prospect_veto_applied), row => row.create_prospect_veto_reason || 'unknown'),
  };
}

function scoreReport(summary: ExperimentScoreSummary): string {
  const pct = (value: number | null) => value == null ? '(n/a)' : `${(value * 100).toFixed(1)}%`;
  return [
    '# Prospect Large Classifier Experiment Score',
    '',
    `- Valuable-result precision: ${pct(summary.valuable_result_precision)} (${summary.valuable_scored_rows} scored rows)`,
    `- Exact create_prospect precision: ${pct(summary.exact_create_precision)}`,
    `- Exact attach_existing_deal precision: ${pct(summary.exact_attach_precision)}`,
    `- Reviewed-set valuable recall: ${pct(summary.reviewed_set_valuable_recall)}`,
    `- Create gate precision including correct vetoes: ${pct(summary.create_gate_precision_including_correct_vetoes)}`,
    `- Estimated missed-valuable rate in recall sample: ${pct(summary.estimated_missed_valuable_rate)} (${summary.recall_sample_scored_rows} scored rows)`,
    `- Known-deal vs inbound confusions: ${summary.known_deal_vs_inbound_confusions.length}`,
    `- Artifact false-create count: ${summary.artifact_false_create_count}`,
    `- False create rows: ${summary.false_create_rows.length}`,
    `- Veto wins: ${summary.veto_wins.length}`,
    `- Veto losses: ${summary.veto_losses.length}`,
    '',
    '## False Valuable Error Types',
    ...markdownTable([
      ['error_type', 'count'],
      ...Object.entries(summary.false_valuable_error_type_counts).map(([key, value]) => [key, String(value)]),
    ]),
    '',
    '## False Create Rows',
    ...markdownTable([
      ['item_id', 'company', 'expected', 'error_type', 'veto'],
      ...summary.false_create_rows.map(row => [
        row.item_id,
        row.company_name,
        row.lucas_expected_action,
        row.error_type || '',
        row.create_prospect_veto_applied ? (row.create_prospect_veto_reason || 'vetoed') : '',
      ]),
    ]),
    '',
    '## Veto Wins',
    ...markdownTable([
      ['item_id', 'company', 'expected', 'reason'],
      ...summary.veto_wins.map(row => [row.item_id, row.company_name, row.lucas_expected_action, row.create_prospect_veto_reason || '']),
    ]),
    '',
    '## Veto Losses',
    ...markdownTable([
      ['item_id', 'company', 'expected', 'reason'],
      ...summary.veto_losses.map(row => [row.item_id, row.company_name, row.lucas_expected_action, row.create_prospect_veto_reason || '']),
    ]),
    '',
    '## Missed Valuable Rows',
    ...markdownTable([
      ['item_id', 'company', 'predicted', 'expected', 'error_type'],
      ...summary.missed_valuable_rows.map(row => [row.item_id, row.company_name, row.predicted_prospect_action, row.lucas_expected_action, row.error_type || '']),
    ]),
    '',
  ].join('\n') + '\n';
}

function actionIsValuable(action: string | null | undefined): boolean {
  return action === 'create_prospect' || action === 'attach_existing_deal';
}

function sourceTypeFromReview(value: unknown): SourceType {
  return value === 'event' || value === 'document' ? value : 'conversation';
}

function sourceChannelFromReview(row: Record<string, string>): SourceChannel {
  if (row.source_type === 'event') return 'meeting';
  if (row.source_type === 'document') return 'document';
  const context = `${row.sender_and_context || ''} ${row.source_sender || ''}`.toLowerCase();
  return context.includes('slack') ? 'slack' : 'email';
}

function candidateFromReviewRow(row: Record<string, string>, index: number): ExperimentCandidate {
  const company = normalizeWhitespace(row.company_name);
  const itemId = normalizeWhitespace(row.item_id) || `review-row:${index + 1}`;
  const rawExcerpt = compactText(row.raw_excerpt || '', 4000);
  return {
    item_id: itemId,
    deterministic_key: itemId,
    source_type: sourceTypeFromReview(row.source_type),
    source_channel: sourceChannelFromReview(row),
    source_id: normalizeWhitespace(row.source_id) || `review-source:${index + 1}`,
    mention_ordinal: Math.max(1, Number(row.mention_ordinal) || index + 1),
    span_start: null,
    span_end: null,
    company_name: company,
    normalized_company_name: __prospectIntelligenceTestHooks.normalizeProspectName(company),
    raw_span: company,
    raw_excerpt: rawExcerpt,
    source_subject: normalizeWhitespace(row.source_subject),
    source_sender: normalizeWhitespace(row.source_sender),
    occurred_at: normalizeWhitespace(row.occurred_at),
    context_char_count: rawExcerpt.length,
    sender_and_context: normalizeWhitespace(row.sender_and_context) || compactText(`from ${row.source_sender || 'unknown'}; subject ${row.source_subject || '(none)'}`),
    stratum: 'enriched_inbound',
    stratum_reason: 'replay_review_csv_without_predictions_or_labels',
  };
}

function expectedCompanyCorrection(row: ReviewRow): string | null {
  const text = `${(row as any).lucas_expected_action || ''}\n${row.lucas_notes || ''}`;
  const patterns = [
    /\bProspect name is\s+["“]([^"”]+)["”]/i,
    /\b["“]([^"”]+)["”]\s+(?:is|was)\s+(?:noted\s+as\s+)?(?:the\s+)?(?:company\s+(?:name|being\s+pitched)|investment\s+opportunity|opportunity)\b/i,
    /\b([A-Z0-9][A-Za-z0-9&.'’ -]{2,80})\s+is\s+(?:the\s+)?company\s+name\s+here\b/i,
    /\b([A-Z0-9][A-Za-z0-9&.'’ -]{2,80})\s+is\s+(?:the\s+)?(?:investment\s+)?opportunity\s+here\b/i,
    /\b([A-Z0-9][A-Za-z0-9&.'’ -]{2,80})\s+is\s+being\s+presented\s+as\s+an?\s+investment\s+opportunity\b/i,
    /\b(?:company\s+name|prospect|investment\s+opportunity|opportunity)\s+(?:here\s+)?(?:is|was|should\s+be)\s+["“]?([A-Z0-9][A-Za-z0-9&.'’ -]{2,80})/i,
    /\bthe\s+inbound\s+prospect\s+here\s+is\s+["“]([^"”]+)["”]/i,
    /\b([A-Z0-9][A-Za-z0-9&.'’ -]{2,80})\s+is\s+presented\s+as\s+an?\s+investment/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const clean = normalizeWhitespace(match?.[1] || '')
      .replace(/[.;:,].*$/g, '')
      .trim();
    if (clean) return clean;
  }
  return null;
}

function benchmarkReplayPredictions(predictions: ExperimentPrediction[], reviews: ReviewRow[]) {
  const byId = new Map(predictions.map(row => [row.item_id, row]));
  const scored = reviews
    .map(row => ({ row, prediction: byId.get(row.item_id), label: scoreLabel(String(row.lucas_expected_action || '')) }))
    .filter(entry => entry.prediction && entry.label);
  const predictedValuable = scored.filter(entry => actionIsValuable(entry.prediction!.predicted_prospect_action));
  const labeledValuable = scored.filter(entry => actionIsValuable(entry.label));
  const createRows = scored.filter(entry => entry.prediction!.predicted_prospect_action === 'create_prospect');
  const attachRows = scored.filter(entry => entry.prediction!.predicted_prospect_action === 'attach_existing_deal');
  const correctionRows = scored
    .map(entry => ({ ...entry, expectedCompany: expectedCompanyCorrection(entry.row) }))
    .filter(entry => entry.expectedCompany);
  const correctedOrSuppressed = correctionRows.filter(entry => {
    const prediction = entry.prediction!;
    if (!actionIsValuable(prediction.predicted_prospect_action)) return true;
    const predictedCompany = prediction.prospect_company_name || prediction.company_name;
    return __prospectIntelligenceTestHooks.normalizeProspectName(predictedCompany) ===
      __prospectIntelligenceTestHooks.normalizeProspectName(entry.expectedCompany!);
  });
  return {
    reviewed_rows: reviews.length,
    scored_rows: scored.length,
    exact_action_accuracy: scored.length
      ? scored.filter(entry => entry.prediction!.predicted_prospect_action === entry.label).length / scored.length
      : null,
    valuable_binary_accuracy: scored.length
      ? scored.filter(entry => actionIsValuable(entry.prediction!.predicted_prospect_action) === actionIsValuable(entry.label)).length / scored.length
      : null,
    valuable_precision: predictedValuable.length
      ? predictedValuable.filter(entry => actionIsValuable(entry.label)).length / predictedValuable.length
      : null,
    valuable_recall: labeledValuable.length
      ? labeledValuable.filter(entry => actionIsValuable(entry.prediction!.predicted_prospect_action)).length / labeledValuable.length
      : null,
    exact_create_precision: createRows.length
      ? createRows.filter(entry => entry.label === 'create_prospect').length / createRows.length
      : null,
    exact_attach_precision: attachRows.length
      ? attachRows.filter(entry => entry.label === 'attach_existing_deal').length / attachRows.length
      : null,
    predicted_action_counts: countBy(predictions, row => row.predicted_prospect_action),
    label_counts: countBy(scored, entry => entry.label),
    wrong_entity_correction_rows: correctionRows.length,
    wrong_entity_corrected_or_suppressed: correctedOrSuppressed.length,
    wrong_entity_corrected_or_suppressed_rate: correctionRows.length ? correctedOrSuppressed.length / correctionRows.length : null,
    mismatches: scored
      .filter(entry => entry.prediction!.predicted_prospect_action !== entry.label)
      .map(entry => ({
        item_id: entry.prediction!.item_id,
        company_name: entry.prediction!.company_name,
        prospect_company_name: entry.prediction!.prospect_company_name,
        predicted_prospect_action: entry.prediction!.predicted_prospect_action,
        original_prospect_action: entry.prediction!.original_prospect_action,
        expected_action: entry.label,
        lucas_expected_action: entry.row.lucas_expected_action,
        lucas_notes: entry.row.lucas_notes || '',
        valuable_action_veto_reason: entry.prediction!.valuable_action_veto_reason || entry.prediction!.create_prospect_veto_reason || null,
      })),
  };
}

function replayBenchmarkReport(summary: ReturnType<typeof benchmarkReplayPredictions>): string {
  const pct = (value: number | null) => value == null ? '(n/a)' : `${(value * 100).toFixed(1)}%`;
  return [
    '# Prospect Review Replay Benchmark',
    '',
    `- Scored rows: ${summary.scored_rows}/${summary.reviewed_rows}`,
    `- Exact action accuracy: ${pct(summary.exact_action_accuracy)}`,
    `- Valuable binary accuracy: ${pct(summary.valuable_binary_accuracy)}`,
    `- Valuable precision: ${pct(summary.valuable_precision)}`,
    `- Valuable recall: ${pct(summary.valuable_recall)}`,
    `- Exact create_prospect precision: ${pct(summary.exact_create_precision)}`,
    `- Exact attach_existing_deal precision: ${pct(summary.exact_attach_precision)}`,
    `- Wrong-company rows corrected or suppressed: ${summary.wrong_entity_corrected_or_suppressed}/${summary.wrong_entity_correction_rows} (${pct(summary.wrong_entity_corrected_or_suppressed_rate)})`,
    '',
    '## Predicted Actions',
    ...markdownTable([
      ['action', 'count'],
      ...Object.entries(summary.predicted_action_counts).map(([key, value]) => [key, String(value)]),
    ]),
    '',
    '## Human Labels',
    ...markdownTable([
      ['action', 'count'],
      ...Object.entries(summary.label_counts).map(([key, value]) => [key, String(value)]),
    ]),
    '',
    '## Mismatches',
    ...markdownTable([
      ['item_id', 'company', 'predicted', 'expected', 'veto'],
      ...summary.mismatches.slice(0, 120).map(row => [
        String(row.item_id),
        String(row.prospect_company_name || row.company_name || ''),
        String(row.predicted_prospect_action),
        String(row.expected_action || ''),
        row.valuable_action_veto_reason ? String(row.valuable_action_veto_reason) : '',
      ]),
    ]),
    '',
  ].join('\n') + '\n';
}

function deterministicCandidateCompare(a: ExperimentCandidate, b: ExperimentCandidate): number {
  return b.occurred_at.localeCompare(a.occurred_at) ||
    a.source_type.localeCompare(b.source_type) ||
    a.source_id.localeCompare(b.source_id) ||
    a.mention_ordinal - b.mention_ordinal ||
    a.normalized_company_name.localeCompare(b.normalized_company_name) ||
    a.item_id.localeCompare(b.item_id);
}

function secondaryCandidateKey(row: Pick<ExperimentCandidate, 'source_type' | 'source_id' | 'mention_ordinal' | 'normalized_company_name'>): string {
  return [
    row.source_type,
    row.source_id,
    row.mention_ordinal,
    row.normalized_company_name,
  ].join(':');
}

export function dedupeCandidates<T extends ExperimentCandidate>(rows: T[]): T[] {
  const seenItems = new Set<string>();
  const seenSecondary = new Set<string>();
  const out: T[] = [];
  for (const row of [...rows].sort(deterministicCandidateCompare)) {
    if (seenItems.has(row.item_id)) continue;
    seenItems.add(row.item_id);
    const secondary = secondaryCandidateKey(row);
    if (seenSecondary.has(secondary)) continue;
    seenSecondary.add(secondary);
    out.push(row);
  }
  return out;
}

function mergeRemoteMeta(shardManifests: Array<{ remote_d1_meta?: Partial<RemoteMeta>; rows_written?: number; changed_db?: boolean }>): RemoteMeta {
  const total: RemoteMeta = { rows_read: 0, rows_written: 0, changed_db: false, query_count: 0 };
  for (const manifest of shardManifests) {
    const meta = manifest.remote_d1_meta || {};
    total.rows_read += Number(meta.rows_read || 0);
    total.rows_written += Number(meta.rows_written ?? manifest.rows_written ?? 0);
    total.query_count += Number(meta.query_count || 0);
    total.changed_db = Boolean(total.changed_db || meta.changed_db || manifest.changed_db);
  }
  if (total.rows_written !== 0 || total.changed_db) {
    throw new Error(`MERGE_REFUSED_REMOTE_D1_WRITE rows_written=${total.rows_written} changed_db=${total.changed_db}`);
  }
  return total;
}

async function runMerge(args: Args): Promise<void> {
  await mkdir(args.outputDir, { recursive: true });
  const shardManifests: any[] = [];
  const allCandidates: ExperimentCandidate[] = [];
  const allPredictions: ExperimentPrediction[] = [];
  for (const shardDir of args.shardDirs) {
    const manifestPath = join(shardDir, 'manifest.json');
    const candidatesPath = join(shardDir, 'input-candidates.jsonl');
    const predictionsPath = join(shardDir, 'predictions.full.jsonl');
    if (!existsSync(manifestPath)) throw new Error(`MISSING_SHARD_MANIFEST:${manifestPath}`);
    if (!existsSync(candidatesPath)) throw new Error(`MISSING_SHARD_INPUT_CANDIDATES:${candidatesPath}`);
    if (!existsSync(predictionsPath)) throw new Error(`MISSING_SHARD_PREDICTIONS:${predictionsPath}`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    shardManifests.push({ ...manifest, shard_dir: shardDir });
    allCandidates.push(...parseJsonl(await readFile(candidatesPath, 'utf8')) as unknown as ExperimentCandidate[]);
    allPredictions.push(...parseJsonl(await readFile(predictionsPath, 'utf8')) as unknown as ExperimentPrediction[]);
  }

  const remoteMeta = mergeRemoteMeta(shardManifests);
  const candidates = dedupeCandidates(allCandidates);
  const predictions = dedupeCandidates(allPredictions);
  const valuable = predictions.filter(row => VALUABLE_ACTIONS.has(row.predicted_prospect_action));
  const recallRows = recallSample(predictions, args.recallSampleRows);

  await writeFile(join(args.outputDir, 'input-candidates.jsonl'), candidates.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  await writeFile(join(args.outputDir, 'predictions.full.jsonl'), predictions.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  await writeFile(join(args.outputDir, 'review-valuable.csv'), reviewCsv(valuable), 'utf8');
  await writeFile(join(args.outputDir, 'review-recall-sample.csv'), reviewCsv(recallRows), 'utf8');

  const usage = predictions.reduce((acc, row) => ({
    input_tokens: acc.input_tokens + row.usage.input_tokens,
    output_tokens: acc.output_tokens + row.usage.output_tokens,
    total_tokens: acc.total_tokens + row.usage.total_tokens,
    cost_usd: acc.cost_usd + (row.cost_usd || 0),
  }), { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 });
  const manifest = {
    generated_at: new Date().toISOString(),
    org_id: args.orgId,
    output_dir: args.outputDir,
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    model: shardManifests.find(m => m.model)?.model || 'claude-haiku-4-5-20251001',
    temperature: 0,
    gateway_path: 'cloudflare_ai_gateway_provider_native_tokened_zdr_required',
    window_start: args.windowStart,
    window_end: args.windowEnd,
    target_rows: args.targetRows,
    source_shard_count: args.sourceShardCount,
    merged_shard_dirs: args.shardDirs,
    merge_dedupe_order: [
      'item_id',
      'source_type/source_id/mention_ordinal/normalized_company_name',
    ],
    candidate_rows_before_dedupe: allCandidates.length,
    prediction_rows_before_dedupe: allPredictions.length,
    candidate_rows: candidates.length,
    prediction_rows: predictions.length,
    valuable_review_rows: valuable.length,
    recall_sample_rows: recallRows.length,
    predicted_action_counts: countBy(predictions, row => row.predicted_prospect_action),
    veto_counts: countBy(predictions.filter(row => row.create_prospect_veto_applied), row => row.create_prospect_veto_reason || 'unknown'),
    remote_d1_meta: remoteMeta,
    rows_written: remoteMeta.rows_written,
    changed_db: remoteMeta.changed_db,
    classifier_used: true,
    usage,
    shards: shardManifests.map(manifest => ({
      shard_dir: manifest.shard_dir,
      source_shard_index: manifest.source_shard_index,
      source_shard_count: manifest.source_shard_count,
      candidate_rows: manifest.candidate_rows,
      prediction_rows: manifest.prediction_rows,
      valuable_review_rows: manifest.valuable_review_rows,
      rows_written: manifest.rows_written,
      changed_db: manifest.changed_db,
    })),
    artifacts: {
      input_candidates: join(args.outputDir, 'input-candidates.jsonl'),
      predictions_full: join(args.outputDir, 'predictions.full.jsonl'),
      review_valuable: join(args.outputDir, 'review-valuable.csv'),
      review_recall_sample: join(args.outputDir, 'review-recall-sample.csv'),
      report: join(args.outputDir, 'report.md'),
    },
    notes: [
      'Merged deterministic shard outputs only; no D1 or production writes were performed by the merge.',
      'Each shard manifest was checked and merge aborts unless aggregate rows_written=0 and changed_db=false.',
      'Predictions were de-duped by item_id first, then source_type/source_id/mention_ordinal/normalized_company_name.',
    ],
  };
  await writeFile(join(args.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(args.outputDir, 'report.md'), experimentReport(args, predictions, recallRows, remoteMeta), 'utf8');
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function runScore(args: Args): Promise<void> {
  const predictions = parseJsonl(await readFile(join(args.outputDir, 'predictions.full.jsonl'), 'utf8')) as ExperimentPrediction[];
  const valuable = parseCsv(await readFile(join(args.outputDir, 'review-valuable.csv'), 'utf8')) as unknown as ReviewRow[];
  const recall = parseCsv(await readFile(join(args.outputDir, 'review-recall-sample.csv'), 'utf8')) as unknown as ReviewRow[];
  const summary = scoreExperiment(predictions, valuable, recall);
  await writeFile(join(args.outputDir, 'score-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(join(args.outputDir, 'score-report.md'), scoreReport(summary), 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function classifyCandidatesWithCheckpoint(
  args: Args,
  candidates: ExperimentCandidate[],
  knownContext: ProspectClassifierKnownContext,
  env: Env
): Promise<ExperimentPrediction[]> {
  const predictionSlots: Array<ExperimentPrediction | undefined> = new Array(candidates.length);
  const predictionsPath = join(args.outputDir, 'predictions.full.jsonl');
  if (args.resume && existsSync(predictionsPath)) {
    let skippedErrorRows = 0;
    for (const row of parseJsonl(await readFile(predictionsPath, 'utf8')) as unknown as ExperimentPrediction[]) {
      if (row.classifier_error || row.predicted_prospect_action === 'classifier_error') {
        skippedErrorRows += 1;
        continue;
      }
      const index = candidates.findIndex(candidate => candidate.item_id === row.item_id);
      if (index >= 0) predictionSlots[index] = row;
    }
    process.stderr.write(`resuming with ${predictionSlots.filter(Boolean).length}/${candidates.length} existing predictions; retrying_error_rows=${skippedErrorRows}\n`);
  }
  let nextForwardIndex = 0;
  let nextReverseIndex = candidates.length - 1;
  let completedPredictions = predictionSlots.filter(Boolean).length;
  let checkpointWrite = Promise.resolve();
  const checkpoint = async () => {
    const ready = predictionSlots.filter(Boolean) as ExperimentPrediction[];
    checkpointWrite = checkpointWrite.then(() =>
      writeFile(predictionsPath, ready.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    );
    await checkpointWrite;
    process.stderr.write(`classified ${ready.length}/${candidates.length}; valuable=${ready.filter(row => VALUABLE_ACTIONS.has(row.predicted_prospect_action)).length}\n`);
  };
  const claimIndex = (direction: 'forward' | 'reverse'): number | null => {
    while (true) {
      if (nextForwardIndex > nextReverseIndex) return null;
      const index = direction === 'forward' ? nextForwardIndex++ : nextReverseIndex--;
      if (predictionSlots[index]) continue;
      return index;
    }
  };
  const worker = async (direction: 'forward' | 'reverse') => {
    while (true) {
      const index = claimIndex(direction);
      if (index == null) return;
      predictionSlots[index] = await classifyCandidate(candidates[index], knownContext, env, args);
      completedPredictions += 1;
      if (completedPredictions % 25 === 0 || completedPredictions === candidates.length) await checkpoint();
      if (args.callDelayMs > 0) await sleep(args.callDelayMs);
    }
  };
  const forwardWorkerCount = Math.min(args.classifierConcurrency, candidates.length);
  const reverseWorkerCount = Math.min(args.reverseClassifierConcurrency, Math.max(0, candidates.length - forwardWorkerCount));
  await Promise.all([
    ...Array.from({ length: forwardWorkerCount }, () => worker('forward')),
    ...Array.from({ length: reverseWorkerCount }, () => worker('reverse')),
  ]);
  const predictions = predictionSlots.filter(Boolean) as ExperimentPrediction[];
  await writeFile(predictionsPath, predictions.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return predictions;
}

async function runReplayReview(args: Args): Promise<void> {
  if (!args.reviewInputPath) throw new Error('REPLAY_REVIEW_CSV_REQUIRED');
  const remoteMeta: RemoteMeta = { rows_read: 0, rows_written: 0, changed_db: false, query_count: 0 };
  await mkdir(args.outputDir, { recursive: true });
  const rawReviewCsv = await readFile(args.reviewInputPath, 'utf8');
  const reviewRows = parseCsv(rawReviewCsv);
  const candidates = reviewRows.map(candidateFromReviewRow);
  await writeFile(join(args.outputDir, 'input-candidates.jsonl'), candidates.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  await writeFile(join(args.outputDir, 'review-source-labels.csv'), rawReviewCsv, 'utf8');

  const knownContext = loadKnownContextFromRemote(args, remoteMeta);
  const proxy = await getPlatformProxy(platformProxyOptions(args));
  const env = requireTokenedGateway(proxy.env as unknown as Env);
  try {
    await ensureLocalBudgetLedger(env);
    const predictions = await classifyCandidatesWithCheckpoint(args, candidates, knownContext, env);
    const valuable = predictions.filter(row => VALUABLE_ACTIONS.has(row.predicted_prospect_action));
    const recallRows = recallSample(predictions, args.recallSampleRows);
    await writeFile(join(args.outputDir, 'review-valuable.csv'), reviewCsv(valuable), 'utf8');
    await writeFile(join(args.outputDir, 'review-recall-sample.csv'), reviewCsv(recallRows), 'utf8');
    const benchmark = benchmarkReplayPredictions(predictions, reviewRows as unknown as ReviewRow[]);
    await writeFile(join(args.outputDir, 'replay-benchmark-summary.json'), `${JSON.stringify(benchmark, null, 2)}\n`, 'utf8');
    await writeFile(join(args.outputDir, 'replay-benchmark-report.md'), replayBenchmarkReport(benchmark), 'utf8');
    const manifest = {
      generated_at: new Date().toISOString(),
      org_id: args.orgId,
      output_dir: args.outputDir,
      replay_review_csv: args.reviewInputPath,
      classifier_version: PROSPECT_CLASSIFIER_VERSION,
      model: String(env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || 'claude-haiku-4-5-20251001'),
      temperature: 0,
      gateway_path: 'cloudflare_ai_gateway_provider_native_tokened_zdr_required',
      candidate_rows: candidates.length,
      prediction_rows: predictions.length,
      valuable_review_rows: valuable.length,
      recall_sample_rows: recallRows.length,
      predicted_action_counts: countBy(predictions, row => row.predicted_prospect_action),
      veto_counts: countBy(predictions.filter(row => row.valuable_action_veto_applied || row.create_prospect_veto_applied), row => row.valuable_action_veto_reason || row.create_prospect_veto_reason || 'unknown'),
      remote_d1_meta: remoteMeta,
      rows_written: remoteMeta.rows_written,
      changed_db: remoteMeta.changed_db,
      classifier_used: true,
      label_leakage_guard: 'Replay candidates include only source fields, company_name, raw_excerpt, sender/context, and stable ids; previous predictions and Lucas labels/notes are copied only after classification for scoring.',
      artifacts: {
        input_candidates: join(args.outputDir, 'input-candidates.jsonl'),
        predictions_full: join(args.outputDir, 'predictions.full.jsonl'),
        source_labels: join(args.outputDir, 'review-source-labels.csv'),
        review_valuable: join(args.outputDir, 'review-valuable.csv'),
        review_recall_sample: join(args.outputDir, 'review-recall-sample.csv'),
        replay_benchmark_summary: join(args.outputDir, 'replay-benchmark-summary.json'),
        replay_benchmark_report: join(args.outputDir, 'replay-benchmark-report.md'),
      },
      benchmark,
    };
    await writeFile(join(args.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await proxy.dispose();
  }
}

async function runExperiment(args: Args): Promise<void> {
  const remoteMeta: RemoteMeta = { rows_read: 0, rows_written: 0, changed_db: false, query_count: 0 };
  await mkdir(args.outputDir, { recursive: true });
  const knownContext = loadKnownContextFromRemote(args, remoteMeta);
  const inputPath = join(args.outputDir, 'input-candidates.jsonl');
  let sources: SourceCandidate[] = [];
  let excludedCount = 0;
  let candidates: ExperimentCandidate[];
  if (args.reuseInput && existsSync(inputPath)) {
    excludedCount = (await loadExcludedSourceKeys()).size;
    candidates = parseJsonl(await readFile(inputPath, 'utf8')) as unknown as ExperimentCandidate[];
    if (candidates.length !== args.targetRows) {
      throw new Error(`REUSE_INPUT_ROW_COUNT_MISMATCH input_rows=${candidates.length} target=${args.targetRows}`);
    }
    process.stderr.write(`reusing ${candidates.length} input candidates from ${inputPath}; excluded prior sources=${excludedCount}; d1_rows_written=${remoteMeta.rows_written}\n`);
  } else {
    const excluded = await loadExcludedSourceKeys();
    excludedCount = excluded.size;
    const unshardedSources = loadSources(args, remoteMeta, knownContext);
    sources = unshardedSources.filter(source =>
      isInSourceShard(source.source_type, source.source_id, args.sourceShardCount, args.sourceShardIndex)
    );
    process.stderr.write(`loaded ${sources.length}/${unshardedSources.length} source candidates for shard ${args.sourceShardIndex}/${args.sourceShardCount}; excluded prior sources=${excluded.size}; d1_rows_written=${remoteMeta.rows_written}\n`);
    const proxyForExtraction = await getPlatformProxy(platformProxyOptions(args));
    const extractionEnv = requireTokenedGateway(proxyForExtraction.env as unknown as Env);
    try {
      await ensureLocalBudgetLedger(extractionEnv);
      candidates = await extractCandidates(args, extractionEnv, knownContext, sources, excluded);
      await writeFile(inputPath, candidates.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    } finally {
      await proxyForExtraction.dispose();
    }
  }

  const proxy = await getPlatformProxy(platformProxyOptions(args));
  const env = requireTokenedGateway(proxy.env as unknown as Env);
  try {
    await ensureLocalBudgetLedger(env);
    const predictionSlots: Array<ExperimentPrediction | undefined> = new Array(candidates.length);
    if (args.resume && existsSync(join(args.outputDir, 'predictions.full.jsonl'))) {
      let skippedErrorRows = 0;
      for (const row of parseJsonl(await readFile(join(args.outputDir, 'predictions.full.jsonl'), 'utf8')) as unknown as ExperimentPrediction[]) {
        if (row.classifier_error || row.predicted_prospect_action === 'classifier_error') {
          skippedErrorRows += 1;
          continue;
        }
        const index = candidates.findIndex(candidate => candidate.item_id === row.item_id);
        if (index >= 0) predictionSlots[index] = row;
      }
      process.stderr.write(`resuming with ${predictionSlots.filter(Boolean).length}/${candidates.length} existing predictions; retrying_error_rows=${skippedErrorRows}\n`);
    }
    let nextForwardIndex = 0;
    let nextReverseIndex = candidates.length - 1;
    let completedPredictions = predictionSlots.filter(Boolean).length;
    let checkpointWrite = Promise.resolve();
    const checkpoint = async () => {
      const ready = predictionSlots.filter(Boolean) as ExperimentPrediction[];
      checkpointWrite = checkpointWrite.then(() =>
        writeFile(join(args.outputDir, 'predictions.full.jsonl'), ready.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
      );
      await checkpointWrite;
      process.stderr.write(`classified ${ready.length}/${candidates.length}; valuable=${ready.filter(row => VALUABLE_ACTIONS.has(row.predicted_prospect_action)).length}\n`);
    };
    const claimIndex = (direction: 'forward' | 'reverse'): number | null => {
      while (true) {
        if (nextForwardIndex > nextReverseIndex) return null;
        const index = direction === 'forward' ? nextForwardIndex++ : nextReverseIndex--;
        if (predictionSlots[index]) continue;
        return index;
      }
    };
    const worker = async (direction: 'forward' | 'reverse') => {
      while (true) {
        const index = claimIndex(direction);
        if (index == null) return;
        predictionSlots[index] = await classifyCandidate(candidates[index], knownContext, env, args);
        completedPredictions += 1;
        if (completedPredictions % 25 === 0 || completedPredictions === candidates.length) await checkpoint();
        if (args.callDelayMs > 0) await sleep(args.callDelayMs);
      }
    };
    const forwardWorkerCount = Math.min(args.classifierConcurrency, candidates.length);
    const reverseWorkerCount = Math.min(args.reverseClassifierConcurrency, Math.max(0, candidates.length - forwardWorkerCount));
    await Promise.all([
      ...Array.from({ length: forwardWorkerCount }, () => worker('forward')),
      ...Array.from({ length: reverseWorkerCount }, () => worker('reverse')),
    ]);
    const predictions = predictionSlots.filter(Boolean) as ExperimentPrediction[];
    await writeFile(join(args.outputDir, 'predictions.full.jsonl'), predictions.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const valuable = predictions.filter(row => VALUABLE_ACTIONS.has(row.predicted_prospect_action));
    const recallRows = recallSample(predictions, args.recallSampleRows);
    await writeFile(join(args.outputDir, 'review-valuable.csv'), reviewCsv(valuable), 'utf8');
    await writeFile(join(args.outputDir, 'review-recall-sample.csv'), reviewCsv(recallRows), 'utf8');

    const usage = predictions.reduce((acc, row) => ({
      input_tokens: acc.input_tokens + row.usage.input_tokens,
      output_tokens: acc.output_tokens + row.usage.output_tokens,
      total_tokens: acc.total_tokens + row.usage.total_tokens,
      cost_usd: acc.cost_usd + (row.cost_usd || 0),
    }), { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 });
    const sourceRowsForManifest = sources.length
      ? sources
      : Array.from(new Map(candidates.map(row => [
        `${row.source_type}:${row.source_id}`,
        {
          source_type: row.source_type,
          source_channel: row.source_channel,
          source_id: row.source_id,
          stratum: row.stratum,
        },
      ])).values());
    const manifest = {
      generated_at: new Date().toISOString(),
      org_id: args.orgId,
      output_dir: args.outputDir,
      classifier_version: PROSPECT_CLASSIFIER_VERSION,
      model: String(env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || 'claude-haiku-4-5-20251001'),
      temperature: 0,
      gateway_path: 'cloudflare_ai_gateway_provider_native_tokened_zdr_required',
      window_start: args.windowStart,
      window_end: args.windowEnd,
      target_rows: args.targetRows,
      source_shard_count: args.sourceShardCount,
      source_shard_index: args.sourceShardIndex,
      source_shard_key_basis: 'stable sha256(source_type:source_id) modulo source_shard_count, applied before extraction/classification',
      candidate_rows: candidates.length,
      prediction_rows: predictions.length,
      valuable_review_rows: valuable.length,
      recall_sample_rows: recallRows.length,
      source_candidates_read: sourceRowsForManifest.length,
      classifier_concurrency: forwardWorkerCount,
      reverse_classifier_concurrency: reverseWorkerCount,
      excluded_prior_source_count: excludedCount,
      source_counts: countBy(sourceRowsForManifest, row => row.stratum),
      source_type_counts: countBy(sourceRowsForManifest, row => row.source_type),
      source_channel_counts: countBy(sourceRowsForManifest, row => row.source_channel),
      candidate_counts: countBy(candidates, row => row.stratum),
      predicted_action_counts: countBy(predictions, row => row.predicted_prospect_action),
      veto_counts: countBy(predictions.filter(row => row.create_prospect_veto_applied), row => row.create_prospect_veto_reason || 'unknown'),
      remote_d1_meta: remoteMeta,
      rows_written: remoteMeta.rows_written,
      changed_db: remoteMeta.changed_db,
      r2_fallback_enabled_for_source_hydration: args.r2Fallback,
      classifier_used: true,
      org_extractor_llm_used: args.allowLlmExtraction,
      usage,
      artifacts: {
        input_candidates: join(args.outputDir, 'input-candidates.jsonl'),
        predictions_full: join(args.outputDir, 'predictions.full.jsonl'),
        review_valuable: join(args.outputDir, 'review-valuable.csv'),
        review_recall_sample: join(args.outputDir, 'review-recall-sample.csv'),
        report: join(args.outputDir, 'report.md'),
      },
      notes: [
        'No migrations, backfill, deploy, production enablement, or production table writes were run.',
        'D1 access used SELECT-only wrangler d1 execute commands and aborts on rows_written or changed_db.',
        'Recall is not fully certified by this run; review-recall-sample.csv estimates missed valuable rows from sampled non-valuable predictions.',
      ],
    };
    await writeFile(join(args.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(join(args.outputDir, 'report.md'), experimentReport(args, predictions, recallRows, remoteMeta), 'utf8');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await proxy.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'score') await runScore(args);
  else if (args.mode === 'merge') await runMerge(args);
  else if (args.mode === 'replay_review') await runReplayReview(args);
  else await runExperiment(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

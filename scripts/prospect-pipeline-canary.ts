#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import type { ClassifiedItem } from '../src/types/interfaces';
import { classifyProspectSignalsDryRun, type ProspectDryRunResult } from '../src/lib/prospect-intelligence';
import {
  loadProspectDetectSource,
  type ProspectDetectPayload,
  type ProspectDetectSourceType,
} from '../src/lib/work-queue-handlers/prospect-detect';

type CanarySourceType = ProspectDetectSourceType | 'all';

interface Args {
  orgId: string;
  configPath: string;
  database: string;
  sourceType: CanarySourceType;
  lookbackHours: number;
  limit: number;
  remoteReadProof: boolean;
  classify: boolean;
  allowMissingSources: boolean;
  outputDir: string;
}

interface CanarySourceRow {
  source_type: ProspectDetectSourceType;
  source_id: string;
  title: string | null;
  occurred_at: string | null;
  source_label: string | null;
}

export interface ProspectPipelineCanarySummary {
  dry_run: true;
  read_mode: 'platform_proxy' | 'wrangler_d1_remote_select';
  source_read_status: 'selected' | 'empty';
  hydration_status: 'not_requested' | 'no_sources' | 'hydrated' | 'partial' | 'missing';
  classification_status: 'not_requested' | 'classified' | 'partial' | 'skipped_no_hydratable_sources';
  write_proof_status: 'platform_proxy_read_only_adapter' | 'remote_d1_read_only_proved';
  write_proof_statement: string;
  dry_run_counter_labels: Record<string, string>;
  org_id: string;
  source_type: CanarySourceType;
  lookback_hours: number;
  limit_per_source_type: number;
  rows_written: number;
  changed_db: boolean;
  remote_d1_meta: RemoteMeta | null;
  sources: CanarySourceRow[];
  queue_payloads: ProspectDetectPayload[];
  classifier?: ProspectDryRunResult | null;
  source_coverage?: SourceCoverageSummary | null;
  artifacts?: Record<string, string> | null;
}

interface SourceCoverageSummary {
  total_sources: number;
  hydratable_sources: number;
  by_source_type: Record<ProspectDetectSourceType, number>;
  missing_sources: Array<{ source_type: ProspectDetectSourceType; source_id: string }>;
}

interface RemoteMeta {
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  query_count: number;
}

interface RemoteQueryResult<T> {
  results: T[];
  meta: Partial<RemoteMeta>;
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
  const sourceType = (raw.get('source-type') || 'all') as CanarySourceType;
  if (!['all', 'conversation', 'event', 'document'].includes(sourceType)) {
    throw new Error('INVALID_SOURCE_TYPE: expected all, conversation, event, or document');
  }
  const lookbackHours = Number(raw.get('lookback-hours') || 24);
  const limit = Number(raw.get('limit') || 5);
  if (!Number.isFinite(lookbackHours) || lookbackHours < 1 || lookbackHours > 24 * 30) {
    throw new Error('INVALID_LOOKBACK_HOURS');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error('INVALID_LIMIT');
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    database: raw.get('database') || 'medina-ventures-db',
    sourceType,
    lookbackHours: Math.floor(lookbackHours),
    limit: Math.floor(limit),
    remoteReadProof: raw.get('remote-read-proof') === 'true',
    classify: raw.get('classify') === 'true',
    allowMissingSources: raw.get('allow-missing-sources') === 'true',
    outputDir: raw.get('output-dir') || join(homedir(), 'Downloads', `prospect-pipeline-canary-${today}`),
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runWranglerJson<T>(args: string[]): RemoteQueryResult<T> {
  const stdout = execFileSync('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
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

function remoteSelect<T>(database: string, meta: RemoteMeta, command: string): T[] {
  assertReadOnlySql(command);
  const result = runWranglerJson<T>(['d1', 'execute', database, '--remote', '--command', command, '--json']);
  recordRemoteMeta(meta, result.meta);
  return result.results;
}

function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed) && !/^PRAGMA\s+query_only\b/i.test(trimmed)) {
    throw new Error(`CANARY_READ_ONLY_SQL_VIOLATION:${sql.slice(0, 120)}`);
  }
  if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|TRUNCATE)\b/i.test(trimmed)) {
    throw new Error(`CANARY_READ_ONLY_SQL_VIOLATION:${sql.slice(0, 120)}`);
  }
  if (/;\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|TRUNCATE)\b/i.test(trimmed)) {
    throw new Error(`CANARY_READ_ONLY_SQL_VIOLATION:${sql.slice(0, 120)}`);
  }
}

function readOnlyCanaryEnv(env: Env): Env {
  return {
    ...(env as any),
    D1: {
      ...(env.D1 as any),
      prepare(sql: string) {
        assertReadOnlySql(sql);
        return env.D1.prepare(sql);
      },
      async batch() {
        throw new Error('CANARY_READ_ONLY_SQL_VIOLATION:batch');
      },
    },
  } as Env;
}

function sqlLiteral(value: unknown): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return sqlString(String(value));
}

function bindSql(sql: string, binds: unknown[]): string {
  let index = 0;
  const bound = sql.replace(/\?/g, () => {
    if (index >= binds.length) throw new Error('CANARY_REMOTE_BIND_MISMATCH');
    return sqlLiteral(binds[index++]);
  });
  if (index !== binds.length) throw new Error('CANARY_REMOTE_BIND_MISMATCH');
  return bound;
}

function remoteReadOnlyCanaryEnv(env: Env, database: string, meta: RemoteMeta): Env {
  const localR2 = (env as any).R2 || { get: async () => null };
  return {
    ...(env as any),
    R2: {
      ...localR2,
      async get() {
        return null;
      },
    },
    D1: {
      prepare(sql: string) {
        assertReadOnlySql(sql);
        let binds: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            binds = args;
            return this;
          },
          async all<T = any>() {
            return { results: remoteSelect<T>(database, meta, bindSql(sql, binds)) };
          },
          async first<T = any>() {
            return remoteSelect<T>(database, meta, bindSql(sql, binds))[0] || null;
          },
          async run() {
            throw new Error(`CANARY_READ_ONLY_SQL_VIOLATION:${sql.slice(0, 120)}`);
          },
        };
      },
      async batch() {
        throw new Error('CANARY_READ_ONLY_SQL_VIOLATION:batch');
      },
    },
  } as unknown as Env;
}

const CANARY_WRITE_PROOF_STATEMENT =
  'No queue rows, prospects, prospect signals, classifier samples, coverage rows, or budget telemetry rows were written by this canary.';
const CANARY_DRY_RUN_COUNTER_LABELS = {
  signals_recorded: 'would_record_signals',
  prospects_upserted: 'would_create_or_update_prospects',
  known_deals_attached: 'would_attach_known_deals',
  record_context_skipped: 'would_record_context',
  ignored_or_noise_skipped: 'would_ignore_or_skip_noise',
};

function emptyCoverage(): SourceCoverageSummary {
  return {
    total_sources: 0,
    hydratable_sources: 0,
    by_source_type: { conversation: 0, event: 0, document: 0 },
    missing_sources: [],
  };
}

function conversationSelectSql(orgId: string, lookbackHours: number, limit: number): string {
  return `SELECT 'conversation' AS source_type,
            id AS source_id,
            subject AS title,
            sent_at AS occurred_at,
            source AS source_label
       FROM conversations
      WHERE org_id = ${sqlString(orgId)}
        AND sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', '-${lookbackHours} hours')
        AND sent_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY sent_at DESC, id ASC
      LIMIT ${limit}`;
}

function eventSelectSql(orgId: string, lookbackHours: number, limit: number): string {
  return `SELECT 'event' AS source_type,
            id AS source_id,
            title,
            start_time AS occurred_at,
            source AS source_label
       FROM events
      WHERE org_id = ${sqlString(orgId)}
        AND deleted_at IS NULL
        AND start_time >= strftime('%Y-%m-%dT%H:%M:%fZ','now', '-${lookbackHours} hours')
        AND start_time <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY start_time DESC, id ASC
      LIMIT ${limit}`;
}

function documentSelectSql(orgId: string, lookbackHours: number, limit: number): string {
  return `SELECT 'document' AS source_type,
            id AS source_id,
            COALESCE(title, file_name) AS title,
            created_at AS occurred_at,
            document_type AS source_label
       FROM documents
      WHERE org_id = ${sqlString(orgId)}
        AND deleted_at IS NULL
        AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', '-${lookbackHours} hours')
        AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY created_at DESC, id ASC
      LIMIT ${limit}`;
}

async function selectConversations(env: Env, orgId: string, lookbackHours: number, limit: number): Promise<CanarySourceRow[]> {
  const rows = await env.D1.prepare(
    `SELECT 'conversation' AS source_type,
            id AS source_id,
            subject AS title,
            sent_at AS occurred_at,
            source AS source_label
      FROM conversations
      WHERE org_id = ?
        AND sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        AND sent_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY sent_at DESC, id ASC
      LIMIT ?`
  ).bind(orgId, `-${lookbackHours} hours`, limit).all<CanarySourceRow>();
  return rows.results || [];
}

async function selectEvents(env: Env, orgId: string, lookbackHours: number, limit: number): Promise<CanarySourceRow[]> {
  const rows = await env.D1.prepare(
    `SELECT 'event' AS source_type,
            id AS source_id,
            title,
            start_time AS occurred_at,
            source AS source_label
       FROM events
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND start_time >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        AND start_time <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY start_time DESC, id ASC
      LIMIT ?`
  ).bind(orgId, `-${lookbackHours} hours`, limit).all<CanarySourceRow>();
  return rows.results || [];
}

async function selectDocuments(env: Env, orgId: string, lookbackHours: number, limit: number): Promise<CanarySourceRow[]> {
  const rows = await env.D1.prepare(
    `SELECT 'document' AS source_type,
            id AS source_id,
            COALESCE(title, file_name) AS title,
            created_at AS occurred_at,
            document_type AS source_label
       FROM documents
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY created_at DESC, id ASC
      LIMIT ?`
  ).bind(orgId, `-${lookbackHours} hours`, limit).all<CanarySourceRow>();
  return rows.results || [];
}

export async function buildProspectPipelineCanarySummary(
  env: Env,
  args: Pick<Args, 'orgId' | 'sourceType' | 'lookbackHours' | 'limit'>
): Promise<ProspectPipelineCanarySummary> {
  const selectors: Array<Promise<CanarySourceRow[]>> = [];
  if (args.sourceType === 'all' || args.sourceType === 'conversation') {
    selectors.push(selectConversations(env, args.orgId, args.lookbackHours, args.limit));
  }
  if (args.sourceType === 'all' || args.sourceType === 'event') {
    selectors.push(selectEvents(env, args.orgId, args.lookbackHours, args.limit));
  }
  if (args.sourceType === 'all' || args.sourceType === 'document') {
    selectors.push(selectDocuments(env, args.orgId, args.lookbackHours, args.limit));
  }
  const sources = (await Promise.all(selectors))
    .flat()
    .sort((a, b) =>
      String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')) ||
      a.source_type.localeCompare(b.source_type) ||
      a.source_id.localeCompare(b.source_id)
    );

  return {
    dry_run: true,
    read_mode: 'platform_proxy',
    source_read_status: sources.length > 0 ? 'selected' : 'empty',
    hydration_status: 'not_requested',
    classification_status: 'not_requested',
    write_proof_status: 'platform_proxy_read_only_adapter',
    write_proof_statement: CANARY_WRITE_PROOF_STATEMENT,
    dry_run_counter_labels: CANARY_DRY_RUN_COUNTER_LABELS,
    org_id: args.orgId,
    source_type: args.sourceType,
    lookback_hours: args.lookbackHours,
    limit_per_source_type: args.limit,
    rows_written: 0,
    changed_db: false,
    remote_d1_meta: null,
    sources,
    queue_payloads: sources.map(source => ({
      source_type: source.source_type,
      source_id: source.source_id,
      origin: 'prospect_pipeline_canary',
      detected_at: source.occurred_at || new Date().toISOString(),
      ingestion_mode: 'live',
    })),
    classifier: null,
    source_coverage: null,
    artifacts: null,
  };
}

export function buildProspectPipelineRemoteCanarySummary(input: {
  orgId: string;
  sourceType: CanarySourceType;
  lookbackHours: number;
  limit: number;
  sources: CanarySourceRow[];
  remoteMeta: RemoteMeta;
}): ProspectPipelineCanarySummary {
  if (input.remoteMeta.rows_written !== 0 || input.remoteMeta.changed_db) {
    throw new Error(`REMOTE_D1_READ_ONLY_VIOLATION rows_written=${input.remoteMeta.rows_written} changed_db=${input.remoteMeta.changed_db}`);
  }
  const sources = input.sources.slice().sort((a, b) =>
    String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')) ||
    a.source_type.localeCompare(b.source_type) ||
    a.source_id.localeCompare(b.source_id)
  );
  return {
    dry_run: true,
    read_mode: 'wrangler_d1_remote_select',
    source_read_status: sources.length > 0 ? 'selected' : 'empty',
    hydration_status: 'not_requested',
    classification_status: 'not_requested',
    write_proof_status: 'remote_d1_read_only_proved',
    write_proof_statement: CANARY_WRITE_PROOF_STATEMENT,
    dry_run_counter_labels: CANARY_DRY_RUN_COUNTER_LABELS,
    org_id: input.orgId,
    source_type: input.sourceType,
    lookback_hours: input.lookbackHours,
    limit_per_source_type: input.limit,
    rows_written: input.remoteMeta.rows_written,
    changed_db: input.remoteMeta.changed_db,
    remote_d1_meta: input.remoteMeta,
    sources,
    queue_payloads: sources.map(source => ({
      source_type: source.source_type,
      source_id: source.source_id,
      origin: 'prospect_pipeline_canary',
      detected_at: source.occurred_at || new Date().toISOString(),
      ingestion_mode: 'live',
    })),
    classifier: null,
    source_coverage: null,
    artifacts: null,
  };
}

function buildRemoteCommands(args: Pick<Args, 'orgId' | 'sourceType' | 'lookbackHours' | 'limit'>): string[] {
  const commands: string[] = [];
  if (args.sourceType === 'all' || args.sourceType === 'conversation') {
    commands.push(conversationSelectSql(args.orgId, args.lookbackHours, args.limit));
  }
  if (args.sourceType === 'all' || args.sourceType === 'event') {
    commands.push(eventSelectSql(args.orgId, args.lookbackHours, args.limit));
  }
  if (args.sourceType === 'all' || args.sourceType === 'document') {
    commands.push(documentSelectSql(args.orgId, args.lookbackHours, args.limit));
  }
  return commands;
}

export function buildProspectPipelineRemoteReadCommands(args: Pick<Args, 'orgId' | 'sourceType' | 'lookbackHours' | 'limit'>): string[] {
  return buildRemoteCommands(args);
}

async function buildRemoteReadProofSummary(args: Args): Promise<ProspectPipelineCanarySummary> {
  const remoteMeta: RemoteMeta = { rows_read: 0, rows_written: 0, changed_db: false, query_count: 0 };
  const sources = buildRemoteCommands(args).flatMap(command =>
    remoteSelect<CanarySourceRow>(args.database, remoteMeta, command)
  );
  return buildProspectPipelineRemoteCanarySummary({
    orgId: args.orgId,
    sourceType: args.sourceType,
    lookbackHours: args.lookbackHours,
    limit: args.limit,
    sources,
    remoteMeta,
  });
}

export function assertCanaryClassificationComplete(
  summary: Pick<ProspectPipelineCanarySummary, 'source_coverage' | 'classification_status' | 'hydration_status'>,
  allowMissingSources: boolean
): void {
  const coverage = summary.source_coverage;
  const missing = coverage?.missing_sources.length || 0;
  if (!allowMissingSources && missing > 0) {
    throw new Error(`CANARY_CLASSIFICATION_INCOMPLETE hydration_status=${summary.hydration_status} missing_sources=${missing}`);
  }
  if (!allowMissingSources && coverage && coverage.total_sources > 0 && coverage.hydratable_sources === 0) {
    throw new Error(`CANARY_CLASSIFICATION_INCOMPLETE classification_status=${summary.classification_status} hydratable_sources=0`);
  }
}

function updateCanaryClassificationStatuses(summary: ProspectPipelineCanarySummary): void {
  const coverage = summary.source_coverage;
  if (!coverage) {
    summary.hydration_status = 'not_requested';
    summary.classification_status = 'not_requested';
    return;
  }
  if (coverage.total_sources === 0) {
    summary.hydration_status = 'no_sources';
    summary.classification_status = 'skipped_no_hydratable_sources';
    return;
  }
  if (coverage.hydratable_sources === 0) {
    summary.hydration_status = 'missing';
    summary.classification_status = 'skipped_no_hydratable_sources';
    return;
  }
  if (coverage.missing_sources.length > 0) {
    summary.hydration_status = 'partial';
    summary.classification_status = 'partial';
    return;
  }
  summary.hydration_status = 'hydrated';
  summary.classification_status = 'classified';
}

export async function classifyCanarySources(
  env: Env,
  summary: ProspectPipelineCanarySummary,
  options: { allowMissingSources?: boolean; allowPartialSchema?: boolean } = {}
): Promise<{ classifier: ProspectDryRunResult | null; sourceCoverage: SourceCoverageSummary }> {
  const readOnlyEnv = readOnlyCanaryEnv(env);
  const coverage = emptyCoverage();
  const items: ClassifiedItem[] = [];
  for (const source of summary.sources) {
    coverage.total_sources++;
    coverage.by_source_type[source.source_type]++;
    const payload: ProspectDetectPayload = {
      source_type: source.source_type,
      source_id: source.source_id,
      origin: 'prospect_pipeline_canary',
      detected_at: source.occurred_at || new Date().toISOString(),
      ingestion_mode: 'live',
    };
    const bundle = await loadProspectDetectSource(readOnlyEnv, summary.org_id, payload);
    if (!bundle) {
      coverage.missing_sources.push({ source_type: source.source_type, source_id: source.source_id });
      continue;
    }
    coverage.hydratable_sources++;
    items.push(bundle.item);
  }
  const classifier = items.length > 0
    ? await classifyProspectSignalsDryRun(items, summary.org_id, readOnlyEnv, {
      allowPartialSchema: options.allowPartialSchema === true,
    })
    : null;
  summary.classifier = classifier;
  summary.source_coverage = coverage;
  updateCanaryClassificationStatuses(summary);
  assertCanaryClassificationComplete(summary, options.allowMissingSources === true);
  return { classifier, sourceCoverage: coverage };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function renderCanaryReport(summary: ProspectPipelineCanarySummary): string {
  const classifier = summary.classifier;
  const coverage = summary.source_coverage;
  const decisions = classifier?.decisions || [];
  const sampleFor = (action: string) => decisions.find(row => row.prospect_action === action);
  const sampleRows = ['create_prospect', 'attach_existing_deal', 'record_context', 'ignore']
    .map(action => ({ action, row: sampleFor(action) }))
    .filter(entry => entry.row)
    .map(entry => `| ${entry.action} | ${entry.row?.company_name || ''} | ${entry.row?.source_type}:${entry.row?.source_id} | ${entry.row?.reasoning || entry.row?.error || ''} |`);

  return [
    '# Prospect Pipeline Canary',
    '',
    `- Dry run: ${summary.dry_run}`,
    `- Read mode: ${summary.read_mode}`,
    `- Source read status: ${summary.source_read_status}`,
    `- Hydration status: ${summary.hydration_status}`,
    `- Classification status: ${summary.classification_status}`,
    `- Write proof status: ${summary.write_proof_status}`,
    `- Org: ${summary.org_id}`,
    `- Source type: ${summary.source_type}`,
    `- Lookback hours: ${summary.lookback_hours}`,
    `- Limit per source type: ${summary.limit_per_source_type}`,
    `- Sources scanned: ${coverage?.total_sources ?? summary.sources.length}`,
    `- Source coverage: conversations=${coverage?.by_source_type.conversation ?? 0}, events=${coverage?.by_source_type.event ?? 0}, documents=${coverage?.by_source_type.document ?? 0}`,
    `- Missing sources: ${coverage?.missing_sources.length ?? 0}`,
    `- Rows written: ${summary.rows_written}`,
    `- Changed DB: ${summary.changed_db}`,
    `- Remote D1 rows_written: ${summary.remote_d1_meta?.rows_written ?? 0}`,
    `- Remote D1 changed_db: ${summary.remote_d1_meta?.changed_db ?? false}`,
    '',
    '## Classifier Decisions',
    '',
    `- would_create: ${classifier?.decision_counts.create_prospect ?? 0}`,
    `- would_attach: ${classifier?.decision_counts.attach_existing_deal ?? 0}`,
    `- would_record_context: ${classifier?.decision_counts.record_context ?? 0}`,
    `- would_ignore: ${classifier?.decision_counts.ignore ?? 0}`,
    `- classifier_error: ${classifier?.decision_counts.classifier_error ?? 0}`,
    `- duplicate keys: ${classifier?.duplicates.length ?? 0}`,
    '',
    '## Sane Decision Samples',
    '',
    '| Action | Company | Source | Reason |',
    '| --- | --- | --- | --- |',
    ...(sampleRows.length ? sampleRows : ['| (none) |  |  |  |']),
    '',
    '## Read-Only Proof',
    '',
    `${summary.write_proof_statement} The classify path uses a read-only D1 adapter and dry-run Claude calls suppress budget telemetry writes.`,
    '',
  ].join('\n');
}

export function writeProspectPipelineCanaryArtifacts(
  outputDir: string,
  summary: ProspectPipelineCanarySummary
): Record<string, string> {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const paths = {
    manifest: join(outputDir, 'manifest.json'),
    decisions: join(outputDir, 'canary-decisions.jsonl'),
    coverage: join(outputDir, 'source-coverage.json'),
    duplicates: join(outputDir, 'duplicates.json'),
    report: join(outputDir, 'report.md'),
  };
  writeFileSync(paths.manifest, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(paths.decisions, (summary.classifier?.decisions || []).map(jsonLine).join(''));
  writeFileSync(paths.coverage, `${JSON.stringify(summary.source_coverage || emptyCoverage(), null, 2)}\n`);
  writeFileSync(paths.duplicates, `${JSON.stringify(summary.classifier?.duplicates || [], null, 2)}\n`);
  writeFileSync(paths.report, renderCanaryReport(summary));
  return paths;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let summary = args.remoteReadProof
    ? await buildRemoteReadProofSummary(args)
    : null;
  if (summary && !args.classify) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    if (!summary) {
      summary = await buildProspectPipelineCanarySummary(proxy.env as unknown as Env, args);
    }
    if (args.classify) {
      const remoteMeta = summary.remote_d1_meta;
      const canaryEnv = args.remoteReadProof && remoteMeta
        ? remoteReadOnlyCanaryEnv(proxy.env as unknown as Env, args.database, remoteMeta)
        : proxy.env as unknown as Env;
      await classifyCanarySources(canaryEnv, summary, {
        allowMissingSources: args.allowMissingSources,
        allowPartialSchema: !args.remoteReadProof,
      });
      if (remoteMeta) {
        summary.rows_written = remoteMeta.rows_written;
        summary.changed_db = remoteMeta.changed_db;
      }
    }
    if (args.classify) {
      summary.artifacts = writeProspectPipelineCanaryArtifacts(args.outputDir, summary);
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

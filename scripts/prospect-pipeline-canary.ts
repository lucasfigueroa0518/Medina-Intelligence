#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import type { ProspectDetectPayload, ProspectDetectSourceType } from '../src/lib/work-queue-handlers/prospect-detect';

type CanarySourceType = ProspectDetectSourceType | 'all';

interface Args {
  orgId: string;
  configPath: string;
  database: string;
  sourceType: CanarySourceType;
  lookbackHours: number;
  limit: number;
  remoteReadProof: boolean;
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
  org_id: string;
  source_type: CanarySourceType;
  lookback_hours: number;
  limit_per_source_type: number;
  rows_written: number;
  changed_db: boolean;
  remote_d1_meta: RemoteMeta | null;
  sources: CanarySourceRow[];
  queue_payloads: ProspectDetectPayload[];
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
  const limit = Number(raw.get('limit') || 10);
  if (!Number.isFinite(lookbackHours) || lookbackHours < 1 || lookbackHours > 24 * 30) {
    throw new Error('INVALID_LOOKBACK_HOURS');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error('INVALID_LIMIT');
  }
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    database: raw.get('database') || 'medina-ventures-db',
    sourceType,
    lookbackHours: Math.floor(lookbackHours),
    limit: Math.floor(limit),
    remoteReadProof: raw.get('remote-read-proof') === 'true',
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
  const result = runWranglerJson<T>(['d1', 'execute', database, '--remote', '--command', command, '--json']);
  recordRemoteMeta(meta, result.meta);
  return result.results;
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
  const sources = input.sources.slice().sort((a, b) =>
    String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')) ||
    a.source_type.localeCompare(b.source_type) ||
    a.source_id.localeCompare(b.source_id)
  );
  return {
    dry_run: true,
    read_mode: 'wrangler_d1_remote_select',
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.remoteReadProof) {
    const summary = await buildRemoteReadProofSummary(args);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const summary = await buildProspectPipelineCanarySummary(proxy.env as unknown as Env, args);
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

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import {
  runProspectBackfillWindow,
  type ProspectBackfillWindowResult,
} from '../src/lib/prospect-intelligence';
import type { Env } from '../src/types/env';

type SourceFamily = 'conversation' | 'event' | 'document';

const BACKFILL_CONFIRMATION = 'PROSPECT_BACKFILL_GO';
const DEFAULT_WRITE_WINDOW_MAX_HOURS = 24;
const DEFAULT_WRITE_BATCH_MAX = 50;

interface Args {
  orgId: string;
  configPath: string;
  database: string;
  windowStart: string;
  windowEnd: string;
  sourceFamilies: SourceFamily[];
  batchLimit: number;
  apply: boolean;
  allowExpandedWindow: boolean;
  confirmProductionWrite: string | null;
  remoteD1: boolean;
}

interface BackfillPreviewRow {
  source_family: SourceFamily;
  candidate_count: number;
  sample_source_ids: string[];
}

export interface ProspectBackfillWindowCliSummary {
  dry_run: boolean;
  d1_mode: 'platform_proxy' | 'wrangler_remote';
  org_id: string;
  window_start: string;
  window_end: string;
  window_hours: number;
  source_families: SourceFamily[];
  batch_limit: number;
  source_preview: BackfillPreviewRow[];
  total_candidates: number;
  result: ProspectBackfillWindowResult | null;
  remote_d1_meta?: RemoteD1Meta | null;
}

interface RemoteD1Meta {
  query_count: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
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
  const sourceFamilies = String(raw.get('source-families') || 'conversation,event,document')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean) as SourceFamily[];
  if (sourceFamilies.length === 0 || sourceFamilies.some(value => !['conversation', 'event', 'document'].includes(value))) {
    throw new Error('INVALID_SOURCE_FAMILIES');
  }
  const batchLimit = Number(raw.get('batch-limit') || 25);
  if (!Number.isFinite(batchLimit) || batchLimit < 1 || batchLimit > 500) {
    throw new Error('INVALID_BATCH_LIMIT');
  }
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    database: raw.get('database') || 'medina-ventures-db',
    windowStart: raw.get('window-start') || '',
    windowEnd: raw.get('window-end') || '',
    sourceFamilies,
    batchLimit: Math.floor(batchLimit),
    apply: raw.get('apply') === 'true',
    allowExpandedWindow: raw.get('allow-expanded-window') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
    remoteD1: raw.get('remote-d1') === 'true',
  };
}

function parseIsoDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`INVALID_${label}`);
  return date;
}

function windowHours(windowStart: string, windowEnd: string): number {
  const start = parseIsoDate(windowStart, 'WINDOW_START');
  const end = parseIsoDate(windowEnd, 'WINDOW_END');
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  if (hours <= 0) throw new Error('INVALID_WINDOW_RANGE');
  return hours;
}

function assertBackfillWriteAllowed(args: Pick<Args, 'apply' | 'allowExpandedWindow' | 'confirmProductionWrite' | 'batchLimit' | 'windowStart' | 'windowEnd'>): void {
  if (!args.apply) return;
  if (args.confirmProductionWrite !== BACKFILL_CONFIRMATION) {
    throw new Error(`PROSPECT_BACKFILL_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${BACKFILL_CONFIRMATION} only after Lucas GO`);
  }
  const hours = windowHours(args.windowStart, args.windowEnd);
  if (!args.allowExpandedWindow && hours > DEFAULT_WRITE_WINDOW_MAX_HOURS) {
    throw new Error(`PROSPECT_BACKFILL_WINDOW_TOO_LARGE: max ${DEFAULT_WRITE_WINDOW_MAX_HOURS}h without --allow-expanded-window true`);
  }
  if (!args.allowExpandedWindow && args.batchLimit > DEFAULT_WRITE_BATCH_MAX) {
    throw new Error(`PROSPECT_BACKFILL_BATCH_TOO_LARGE: max ${DEFAULT_WRITE_BATCH_MAX} without --allow-expanded-window true`);
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
    if (index >= binds.length) throw new Error('REMOTE_D1_BIND_MISMATCH');
    return sqlLiteral(binds[index++]);
  });
  if (index !== binds.length) throw new Error('REMOTE_D1_BIND_MISMATCH');
  return bound;
}

function runWranglerD1<T>(database: string, command: string, meta: RemoteD1Meta): T[] {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--command', command, '--json'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 80 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout) as Array<{ results?: T[]; meta?: Partial<RemoteD1Meta>; success?: boolean }>;
      const first = parsed[0] || {};
      if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
      meta.query_count += 1;
      meta.rows_read += Number(first.meta?.rows_read || 0);
      meta.rows_written += Number(first.meta?.rows_written || 0);
      meta.changed_db = Boolean(meta.changed_db || first.meta?.changed_db);
      return first.results || [];
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/(7403|429|5\d\d|ETIMEDOUT|ECONNRESET|fetch failed|network)/i.test(message)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function remoteD1Env<TEnv extends Env>(env: TEnv, database: string, meta: RemoteD1Meta): TEnv {
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        binds = args;
        return this;
      },
      async all<T = any>() {
        return { results: runWranglerD1<T>(database, bindSql(sql, binds), meta) };
      },
      async first<T = any>() {
        return runWranglerD1<T>(database, bindSql(sql, binds), meta)[0] || null;
      },
      async run() {
        runWranglerD1(database, bindSql(sql, binds), meta);
      },
    };
  };

  return {
    ...(env as any),
    D1: {
      prepare,
      async batch(statements: Array<{ run: () => Promise<void> }>) {
        const results: void[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    },
  } as TEnv;
}

async function countBackfillFamily(
  env: Env,
  orgId: string,
  family: SourceFamily,
  windowStart: string,
  windowEnd: string,
  limit: number
): Promise<BackfillPreviewRow> {
  const table = family === 'conversation' ? 'conversations' : family === 'event' ? 'events' : 'documents';
  const timeColumn = family === 'conversation' ? 'sent_at' : family === 'event' ? 'start_time' : 'created_at';
  const deletedFilter = family === 'conversation' ? '' : 'AND deleted_at IS NULL';
  const rows = await env.D1.prepare(
    `SELECT id
       FROM ${table}
      WHERE org_id = ?
        ${deletedFilter}
        AND ${timeColumn} >= ?
        AND ${timeColumn} < ?
      ORDER BY ${timeColumn} DESC, id ASC
      LIMIT ?`
  ).bind(orgId, windowStart, windowEnd, limit).all<{ id: string }>();
  return {
    source_family: family,
    candidate_count: rows.results?.length || 0,
    sample_source_ids: (rows.results || []).slice(0, 10).map(row => row.id),
  };
}

export async function runProspectBackfillWindowCli(
  env: Env,
  args: Args
): Promise<ProspectBackfillWindowCliSummary> {
  const hours = windowHours(args.windowStart, args.windowEnd);
  assertBackfillWriteAllowed(args);
  const remoteMeta: RemoteD1Meta | null = args.remoteD1
    ? { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false }
    : null;
  const effectiveEnv = args.remoteD1 && remoteMeta ? remoteD1Env(env, args.database, remoteMeta) : env;
  const preview = await Promise.all(args.sourceFamilies.map(family =>
    countBackfillFamily(effectiveEnv, args.orgId, family, args.windowStart, args.windowEnd, args.batchLimit)
  ));
  const result = args.apply
    ? await runProspectBackfillWindow(args.orgId, effectiveEnv, {
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      sourceFamilies: args.sourceFamilies,
      batchLimit: args.batchLimit,
    })
    : null;
  return {
    dry_run: !args.apply,
    d1_mode: args.remoteD1 ? 'wrangler_remote' : 'platform_proxy',
    org_id: args.orgId,
    window_start: args.windowStart,
    window_end: args.windowEnd,
    window_hours: hours,
    source_families: args.sourceFamilies,
    batch_limit: args.batchLimit,
    source_preview: preview,
    total_candidates: preview.reduce((sum, row) => sum + row.candidate_count, 0),
    result,
    remote_d1_meta: remoteMeta,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const summary = await runProspectBackfillWindowCli(proxy.env as unknown as Env, args);
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

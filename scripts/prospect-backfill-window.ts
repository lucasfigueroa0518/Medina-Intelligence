#!/usr/bin/env node
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
  windowStart: string;
  windowEnd: string;
  sourceFamilies: SourceFamily[];
  batchLimit: number;
  apply: boolean;
  allowExpandedWindow: boolean;
  confirmProductionWrite: string | null;
}

interface BackfillPreviewRow {
  source_family: SourceFamily;
  candidate_count: number;
  sample_source_ids: string[];
}

export interface ProspectBackfillWindowCliSummary {
  dry_run: boolean;
  org_id: string;
  window_start: string;
  window_end: string;
  window_hours: number;
  source_families: SourceFamily[];
  batch_limit: number;
  source_preview: BackfillPreviewRow[];
  total_candidates: number;
  result: ProspectBackfillWindowResult | null;
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
    windowStart: raw.get('window-start') || '',
    windowEnd: raw.get('window-end') || '',
    sourceFamilies,
    batchLimit: Math.floor(batchLimit),
    apply: raw.get('apply') === 'true',
    allowExpandedWindow: raw.get('allow-expanded-window') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
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
  const preview = await Promise.all(args.sourceFamilies.map(family =>
    countBackfillFamily(env, args.orgId, family, args.windowStart, args.windowEnd, args.batchLimit)
  ));
  const result = args.apply
    ? await runProspectBackfillWindow(args.orgId, env, {
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      sourceFamilies: args.sourceFamilies,
      batchLimit: args.batchLimit,
    })
    : null;
  return {
    dry_run: !args.apply,
    org_id: args.orgId,
    window_start: args.windowStart,
    window_end: args.windowEnd,
    window_hours: hours,
    source_families: args.sourceFamilies,
    batch_limit: args.batchLimit,
    source_preview: preview,
    total_candidates: preview.reduce((sum, row) => sum + row.candidate_count, 0),
    result,
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

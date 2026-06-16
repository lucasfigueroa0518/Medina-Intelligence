#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

type Args = {
  inputDir: string;
  outputDir: string;
  shardCount: number;
  batchSize: number;
  fetchTimeoutMs: number;
  maxItems: number | null;
  offset: number;
  heartbeatMinutes: number;
  restartLimit: number;
  prewarmPromptCache: boolean;
};

type ShardState = {
  shard: number;
  offset: number;
  maxItems: number;
  outputDir: string;
  attempts: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
};

type OrchestratorAbort = {
  aborted: boolean;
  reason: string | null;
  children: Set<ChildProcess>;
};

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      index += 1;
    }
  }
  const inputDir = resolve(raw.get('input-dir') || '');
  if (!inputDir || inputDir === process.cwd()) throw new Error('MISSING_INPUT_DIR');
  const outputDir = resolve(raw.get('output-dir') || join(inputDir, '..', 'run-24-shard'));
  const shardCount = Number(raw.get('shard-count') || 24);
  const batchSize = Number(raw.get('batch-size') || 25);
  const fetchTimeoutMs = Number(raw.get('fetch-timeout-ms') || 240000);
  const maxItemsRaw = raw.get('max-items');
  const offset = Number(raw.get('offset') || 0);
  const heartbeatMinutes = Number(raw.get('heartbeat-minutes') || 5);
  const restartLimit = Number(raw.get('restart-limit') || 1);
  if (!Number.isFinite(shardCount) || shardCount < 1 || shardCount > 256) throw new Error('INVALID_SHARD_COUNT');
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('INVALID_BATCH_SIZE');
  if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs < 1000) throw new Error('INVALID_FETCH_TIMEOUT_MS');
  if (!Number.isFinite(offset) || offset < 0) throw new Error('INVALID_OFFSET');
  if (!Number.isFinite(heartbeatMinutes) || heartbeatMinutes <= 0) throw new Error('INVALID_HEARTBEAT_MINUTES');
  if (!Number.isFinite(restartLimit) || restartLimit < 0 || restartLimit > 5) throw new Error('INVALID_RESTART_LIMIT');
  return {
    inputDir,
    outputDir,
    shardCount: Math.floor(shardCount),
    batchSize: Math.floor(batchSize),
    fetchTimeoutMs: Math.floor(fetchTimeoutMs),
    maxItems: maxItemsRaw ? Math.floor(Number(maxItemsRaw)) : null,
    offset: Math.floor(offset),
    heartbeatMinutes,
    restartLimit: Math.floor(restartLimit),
    prewarmPromptCache: raw.get('prewarm-prompt-cache') !== 'false',
  };
}

function countJsonlRows(path: string): number {
  return readFileSync(path, 'utf8').split(/\n/).filter(line => line.trim()).length;
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isHardQuotaText(value: unknown): boolean {
  const text = String(value || '');
  return /\bCLAUDE_MONTHLY_QUOTA_EXHAUSTED\b|monthly[_\s-]*quota[_\s-]*exhausted|specified API usage limits|regain access on/i.test(text);
}

function manifestHasHardQuotaFailure(manifest: any | null): boolean {
  return manifest?.fatal_error_kind === 'claude_monthly_quota_exhausted' || isHardQuotaText(manifest?.error);
}

function abortAll(abort: OrchestratorAbort | undefined, reason: string): void {
  if (!abort || abort.aborted) return;
  abort.aborted = true;
  abort.reason = reason;
  for (const child of abort.children) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

function runCommand(label: string, args: string[], cwd = process.cwd(), abort?: OrchestratorAbort): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (abort?.aborted) {
      reject(new Error(`${label}_ABORTED:${abort.reason || 'orchestrator_abort'}`));
      return;
    }
    const child = spawn(args[0], args.slice(1), { cwd, stdio: 'inherit' });
    abort?.children.add(child);
    child.on('error', reject);
    child.on('exit', code => {
      abort?.children.delete(child);
      if (abort?.aborted) {
        reject(new Error(`${label}_ABORTED:${abort.reason || 'orchestrator_abort'}`));
        return;
      }
      if (code === 0) resolvePromise();
      else reject(new Error(`${label}_FAILED:${code}`));
    });
  });
}

function shardManifest(state: ShardState): any | null {
  return readJson(join(state.outputDir, 'manifest.json'));
}

function heartbeat(states: ShardState[], outputDir: string): Record<string, unknown> {
  const manifests = states.map(state => ({ state, manifest: shardManifest(state) }));
  const counts = {
    pending: states.filter(state => state.status === 'pending').length,
    running: states.filter(state => state.status === 'running').length,
    completed: states.filter(state => state.status === 'completed').length,
    failed: states.filter(state => state.status === 'failed').length,
  };
  const classifier = manifests.reduce((acc, entry) => {
    const stats = entry.manifest?.classifier?.stats || {};
    acc.raw_decisions += Number(entry.manifest?.classifier?.raw_decision_count || 0);
    acc.errors += Number(entry.manifest?.classifier?.errors?.length || 0);
    acc.final_quality_gate_fallback_used += Number(stats.final_quality_gate_fallback_used || 0);
    acc.final_quality_gate_failed_open += Number(stats.final_quality_gate_failed_open || 0);
    acc.rows_written += Number(entry.manifest?.rows_written || 0);
    acc.changed_db = Boolean(acc.changed_db || entry.manifest?.changed_db);
    return acc;
  }, {
    raw_decisions: 0,
    errors: 0,
    final_quality_gate_fallback_used: 0,
    final_quality_gate_failed_open: 0,
    rows_written: 0,
    changed_db: false,
  });
  const entry = {
    at: new Date().toISOString(),
    counts,
    classifier,
    shards: states.map(state => ({
      shard: state.shard,
      status: state.status,
      attempts: state.attempts,
      offset: state.offset,
      max_items: state.maxItems,
      exit_code: state.exitCode,
      batches_completed: shardManifest(state)?.batches_completed ?? null,
      batches_total: shardManifest(state)?.batches_total ?? null,
    })),
  };
  appendFileSync(join(outputDir, 'heartbeat.jsonl'), `${JSON.stringify(entry)}\n`);
  process.stdout.write(`[prospect-24-shard] heartbeat ${JSON.stringify({ at: entry.at, counts, classifier })}\n`);
  return entry;
}

async function runShard(state: ShardState, args: Args, abort: OrchestratorAbort): Promise<void> {
  while (state.attempts <= args.restartLimit && !abort.aborted) {
    state.attempts++;
    state.status = 'running';
    state.startedAt ||= new Date().toISOString();
    const command = [
      'npm',
      'run',
      'prospect:hydrated-eval',
      '--',
      '--input-dir',
      args.inputDir,
      '--output-dir',
      state.outputDir,
      '--offset',
      String(state.offset),
      '--max-items',
      String(state.maxItems),
      '--batch-size',
      String(args.batchSize),
      '--fetch-timeout-ms',
      String(args.fetchTimeoutMs),
      '--prewarm-prompt-cache',
      'false',
      '--resume',
      'true',
    ];
    try {
      await runCommand(`SHARD_${state.shard}`, command, process.cwd(), abort);
      state.status = 'completed';
      state.exitCode = 0;
      state.completedAt = new Date().toISOString();
      return;
    } catch (error) {
      state.exitCode = 1;
      const manifest = shardManifest(state);
      const message = error instanceof Error ? error.message : String(error);
      const hardQuota = manifestHasHardQuotaFailure(manifest) || isHardQuotaText(message);
      if (hardQuota) abortAll(abort, 'claude_monthly_quota_exhausted');
      state.status = hardQuota || abort.aborted || state.attempts > args.restartLimit ? 'failed' : 'pending';
      appendFileSync(join(args.outputDir, 'shard-errors.log'), `[${new Date().toISOString()}] shard=${state.shard} attempt=${state.attempts} ${message}${hardQuota ? ' hard_quota=true' : ''}\n`);
      if (state.status === 'failed') {
        state.completedAt = new Date().toISOString();
        throw hardQuota
          ? new Error('PROSPECT_24_SHARD_ABORTED_HARD_QUOTA:claude_monthly_quota_exhausted')
          : error;
      }
    }
  }
  if (abort.aborted) {
    state.status = 'failed';
    state.exitCode = 1;
    state.completedAt = new Date().toISOString();
    throw new Error(`PROSPECT_24_SHARD_ABORTED:${abort.reason || 'orchestrator_abort'}`);
  }
}

async function prewarm(args: Args): Promise<void> {
  if (!args.prewarmPromptCache) return;
  const outputDir = join(args.outputDir, 'prewarm');
  await runCommand('PREWARM', [
    'npm',
    'run',
    'prospect:hydrated-eval',
    '--',
    '--input-dir',
    args.inputDir,
    '--output-dir',
    outputDir,
    '--max-items',
    '1',
    '--batch-size',
    '1',
    '--fetch-timeout-ms',
    String(args.fetchTimeoutMs),
    '--prewarm-prompt-cache',
    'true',
  ]);
}

export async function runProspectHydratedEval24Shard(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });
  const hydratedItemsPath = join(args.inputDir, 'hydrated-items.jsonl');
  if (!existsSync(hydratedItemsPath)) throw new Error(`MISSING_HYDRATED_ITEMS:${hydratedItemsPath}`);
  const totalRows = countJsonlRows(hydratedItemsPath);
  const selectedRows = Math.max(0, Math.min(args.maxItems ?? totalRows - args.offset, totalRows - args.offset));
  const shardSize = Math.ceil(selectedRows / args.shardCount);
  const states: ShardState[] = [];
  for (let shard = 0; shard < args.shardCount; shard++) {
    const shardOffset = args.offset + shard * shardSize;
    const maxItems = Math.max(0, Math.min(shardSize, args.offset + selectedRows - shardOffset));
    if (maxItems <= 0) continue;
    const outputDir = join(args.outputDir, `shard-${String(shard).padStart(2, '0')}`);
    mkdirSync(outputDir, { recursive: true });
    states.push({
      shard,
      offset: shardOffset,
      maxItems,
      outputDir,
      attempts: 0,
      status: 'pending',
      exitCode: null,
      startedAt: null,
      completedAt: null,
    });
  }
  writeFileSync(join(args.outputDir, 'run-config.json'), JSON.stringify({
    ...args,
    total_rows: totalRows,
    selected_rows: selectedRows,
    shard_size: shardSize,
    started_at: new Date().toISOString(),
  }, null, 2));
  await prewarm(args);
  const abort: OrchestratorAbort = { aborted: false, reason: null, children: new Set() };
  heartbeat(states, args.outputDir);
  const interval = setInterval(() => heartbeat(states, args.outputDir), args.heartbeatMinutes * 60_000);
  try {
    await Promise.all(states.map(state => runShard(state, args, abort)));
  } finally {
    if (abort.aborted) {
      for (const child of abort.children) {
        if (!child.killed) child.kill('SIGTERM');
      }
    }
    clearInterval(interval);
    heartbeat(states, args.outputDir);
  }
  if (abort.aborted) throw new Error(`PROSPECT_24_SHARD_ABORTED:${abort.reason || 'orchestrator_abort'}`);
  if (states.some(state => state.status !== 'completed')) throw new Error('PROSPECT_24_SHARD_INCOMPLETE');
  const mergedDir = join(args.outputDir, 'merged');
  await runCommand('MERGE', [
    'npm',
    'run',
    'prospect:hydrated-eval-merge',
    '--',
    '--shards-dir',
    args.outputDir,
    '--output-dir',
    mergedDir,
    '--shard-count',
    String(args.shardCount),
  ]);
  const mergedManifest = readJson(join(mergedDir, 'manifest.json'));
  const summary = {
    status: 'completed',
    output_dir: args.outputDir,
    merged_dir: mergedDir,
    shard_count: args.shardCount,
    shards_completed: states.length,
    heartbeat_log: join(args.outputDir, 'heartbeat.jsonl'),
    merged_manifest: mergedManifest,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'orchestrator-summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

async function main(): Promise<void> {
  const summary = await runProspectHydratedEval24Shard(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

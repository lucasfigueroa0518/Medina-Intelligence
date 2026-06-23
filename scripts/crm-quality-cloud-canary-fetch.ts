#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');

interface Args {
  outputDir: string;
  workerUrl: string;
  token: string;
  runId: string;
  wait: boolean;
  pollSeconds: number;
  maxMinutes: number;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      i += 1;
    }
  }
  const runId = clean(raw.get('run-id'));
  const outputDir = resolve(raw.get('output-dir') || (runId ? join(DEFAULT_OUTPUT_ROOT, runId) : DEFAULT_OUTPUT_ROOT));
  const tokenFromFile = existsSync(join(outputDir, '.canary-token'))
    ? clean(readFileSync(join(outputDir, '.canary-token'), 'utf8'))
    : '';
  const workerUrl = clean(raw.get('worker-url'));
  const token = clean(raw.get('token') || process.env.CRM_CANARY_TOKEN || tokenFromFile);
  const wait = raw.get('wait') === 'true';
  const pollSeconds = Math.max(10, Number(raw.get('poll-seconds') || 60));
  const maxMinutes = Math.max(1, Number(raw.get('max-minutes') || 180));
  if (!runId) throw new Error('MISSING_RUN_ID');
  if (!workerUrl) throw new Error('MISSING_WORKER_URL');
  if (!token) throw new Error('MISSING_TOKEN');
  return { outputDir, workerUrl: workerUrl.replace(/\/$/, ''), token, runId, wait, pollSeconds, maxMinutes };
}

async function getText(url: string, token: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { headers: { 'x-canary-token': token } });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string, token: string): Promise<any> {
  const { status, text } = await getText(url, token);
  if (status < 200 || status >= 300) throw new Error(`REQUEST_FAILED:${status}:${text.slice(0, 1000)}`);
  return JSON.parse(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compactStatus(status: any): Record<string, unknown> {
  const shards = Array.isArray(status.shards) ? status.shards : [];
  const shardCounts = shards.reduce((acc: Record<string, number>, shard: any) => {
    const key = clean(shard?.status || 'pending') || 'pending';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    run_id: status.meta?.run_id,
    status: status.meta?.status,
    finalized_at: status.meta?.finalized_at || '',
    row_count: status.meta?.row_count,
    shard_count: status.meta?.shard_count,
    shard_status_counts: shardCounts,
    status_counts: status.meta?.status_counts || {},
    production_rows_written: status.meta?.production_rows_written,
    gold_used_at_runtime: status.meta?.gold_used_at_runtime,
  };
}

async function downloadArtifacts(args: Args, status: any): Promise<boolean> {
  if (!status.meta?.finalized_at) return false;
  mkdirSync(args.outputDir, { recursive: true });
  const cleanReview = await getText(`${args.workerUrl}/artifact?run_id=${encodeURIComponent(args.runId)}&file=clean-review.csv`, args.token);
  if (cleanReview.status < 200 || cleanReview.status >= 300) {
    throw new Error(`CLEAN_REVIEW_DOWNLOAD_FAILED:${cleanReview.status}:${cleanReview.text.slice(0, 1000)}`);
  }
  const summary = await getText(`${args.workerUrl}/artifact?run_id=${encodeURIComponent(args.runId)}&file=summary.json`, args.token);
  if (summary.status < 200 || summary.status >= 300) {
    throw new Error(`SUMMARY_DOWNLOAD_FAILED:${summary.status}:${summary.text.slice(0, 1000)}`);
  }
  writeFileSync(join(args.outputDir, 'cloud-canary-clean-review.csv'), cleanReview.text);
  writeFileSync(join(args.outputDir, 'cloud-canary-summary.json'), summary.text);
  writeFileSync(join(args.outputDir, 'cloud-canary-status.json'), `${JSON.stringify(status, null, 2)}\n`);
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + args.maxMinutes * 60_000;
  let status: any;
  while (true) {
    status = await getJson(`${args.workerUrl}/status?run_id=${encodeURIComponent(args.runId)}`, args.token);
    console.log(JSON.stringify(compactStatus(status), null, 2));
    if (status.meta?.finalized_at) break;
    const failedShards = (status.shards || []).filter((shard: any) => shard?.status === 'failed');
    if (failedShards.length) throw new Error(`SHARDS_FAILED:${JSON.stringify(failedShards, null, 2)}`);
    if (!args.wait || Date.now() > deadline) break;
    await sleep(args.pollSeconds * 1000);
  }
  const downloaded = await downloadArtifacts(args, status);
  console.log(JSON.stringify({
    downloaded,
    output_dir: args.outputDir,
    clean_review_csv: downloaded ? join(args.outputDir, 'cloud-canary-clean-review.csv') : '',
    summary_json: downloaded ? join(args.outputDir, 'cloud-canary-summary.json') : '',
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

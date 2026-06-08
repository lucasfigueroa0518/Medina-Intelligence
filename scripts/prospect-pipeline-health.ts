#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';

interface Args {
  orgId: string;
  configPath: string;
  daysBack: number;
}

export interface ProspectPipelineHealthSummary {
  read_only: true;
  org_id: string;
  days_back: number;
  work_queue: Array<{ status: string; count: number }>;
  dead_letters: number;
  failed_or_pending: number;
  rate_limit_deferrals: number;
  open_classifier_circuits: Array<{ upstream: string; circuit_open_until: string | null }>;
  classifier_errors: number;
  pending_classifications: number;
  new_prospects: number;
  known_deal_attaches: number;
  provisional_prospects: number;
  context_signals: number;
  ignored_or_noise_signals: number;
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
  const daysBack = Number(raw.get('days-back') || 7);
  if (!Number.isFinite(daysBack) || daysBack < 1 || daysBack > 365) {
    throw new Error('INVALID_DAYS_BACK');
  }
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    daysBack: Math.floor(daysBack),
  };
}

function assertSelectOnly(sql: string): void {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`PIPELINE_HEALTH_READ_ONLY_VIOLATION:${sql.slice(0, 120)}`);
}

function readOnlyEnv(env: Env): Env {
  return {
    ...(env as any),
    D1: {
      ...(env.D1 as any),
      prepare(sql: string) {
        assertSelectOnly(sql);
        return env.D1.prepare(sql);
      },
      async batch() {
        throw new Error('PIPELINE_HEALTH_READ_ONLY_VIOLATION:batch');
      },
    },
  } as Env;
}

export async function buildProspectPipelineHealth(
  orgId: string,
  env: Env,
  options: { daysBack?: number } = {}
): Promise<ProspectPipelineHealthSummary> {
  const safeEnv = readOnlyEnv(env);
  const daysBack = Math.min(Math.max(Math.floor(options.daysBack || 7), 1), 365);
  const lookback = `-${daysBack} days`;
  const [
    workQueue,
    rateLimitDeferrals,
    classifierCircuitRows,
    signalState,
    prospectState,
  ] = await Promise.all([
    safeEnv.D1.prepare(
      `SELECT status, COUNT(*) AS count
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'prospect_detect'
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        GROUP BY status
        ORDER BY status ASC`
    ).bind(orgId, lookback).all<{ status: string; count: number }>(),
    safeEnv.D1.prepare(
      `SELECT COUNT(*) AS count
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'prospect_detect'
          AND status = 'pending'
          AND upstream IN ('claude','anthropic_haiku','anthropic_sonnet','anthropic_opus')
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<{ count: number }>(),
    safeEnv.D1.prepare(
      `SELECT upstream, circuit_open_until
         FROM upstream_budget_ledger
        WHERE org_id = ?
          AND upstream IN ('claude','anthropic_haiku','anthropic_sonnet','anthropic_opus')
          AND circuit_open_until IS NOT NULL
          AND circuit_open_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ORDER BY circuit_open_until DESC`
    ).bind(orgId).all<{ upstream: string; circuit_open_until: string | null }>(),
    safeEnv.D1.prepare(
      `SELECT
          SUM(CASE WHEN classification_status != 'classified' THEN 1 ELSE 0 END) AS pending_classifications,
          SUM(CASE WHEN error_message IS NOT NULL AND trim(error_message) != '' THEN 1 ELSE 0 END) AS classifier_errors,
          SUM(CASE WHEN mention_type = 'known_deal' OR json_extract(metadata_json, '$.prospect_action') = 'attach_existing_deal' THEN 1 ELSE 0 END) AS known_deal_attaches,
          SUM(CASE WHEN json_extract(metadata_json, '$.prospect_action') = 'record_context' THEN 1 ELSE 0 END) AS context_signals,
          SUM(CASE WHEN mention_type IN ('noise','news','web_analytics') OR json_extract(metadata_json, '$.prospect_action') = 'ignore' THEN 1 ELSE 0 END) AS ignored_or_noise_signals
         FROM prospect_signals
        WHERE org_id = ?
          AND occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    safeEnv.D1.prepare(
      `SELECT
          SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) THEN 1 ELSE 0 END) AS new_prospects,
          SUM(CASE WHEN provisional = 1 THEN 1 ELSE 0 END) AS provisional_prospects
         FROM prospects
        WHERE org_id = ?
          AND deleted_at IS NULL`
    ).bind(lookback, orgId).first<any>(),
  ]);

  const queueRows = workQueue.results || [];
  const countStatus = (status: string) => queueRows
    .filter(row => row.status === status)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);

  return {
    read_only: true,
    org_id: orgId,
    days_back: daysBack,
    work_queue: queueRows.map(row => ({ status: row.status, count: Number(row.count || 0) })),
    dead_letters: countStatus('dead_letter'),
    failed_or_pending: countStatus('failed') + countStatus('pending') + countStatus('in_progress'),
    rate_limit_deferrals: Number(rateLimitDeferrals?.count || 0),
    open_classifier_circuits: classifierCircuitRows.results || [],
    classifier_errors: Number(signalState?.classifier_errors || 0),
    pending_classifications: Number(signalState?.pending_classifications || 0),
    new_prospects: Number(prospectState?.new_prospects || 0),
    known_deal_attaches: Number(signalState?.known_deal_attaches || 0),
    provisional_prospects: Number(prospectState?.provisional_prospects || 0),
    context_signals: Number(signalState?.context_signals || 0),
    ignored_or_noise_signals: Number(signalState?.ignored_or_noise_signals || 0),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const summary = await buildProspectPipelineHealth(args.orgId, proxy.env as unknown as Env, {
      daysBack: args.daysBack,
    });
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

#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import {
  buildProspectPipelineCanarySummary,
  type ProspectPipelineCanarySummary,
} from './prospect-pipeline-canary';
import type { Env } from '../src/types/env';
import {
  enqueueProspectDetectSource,
  type ProspectDetectSourceType,
} from '../src/lib/work-queue-handlers/prospect-detect';

type CanarySourceType = ProspectDetectSourceType | 'all';

const LIVE_CANARY_CONFIRMATION = 'PROSPECT_LIVE_CANARY_GO';

interface Args {
  orgId: string;
  configPath: string;
  sourceType: CanarySourceType;
  lookbackHours: number;
  limit: number;
  highSignal: boolean;
  enqueue: boolean;
  confirmProductionWrite: string | null;
}

export interface ProspectLiveCanarySummary {
  dry_run: boolean;
  org_id: string;
  source_type: CanarySourceType;
  lookback_hours: number;
  limit_per_source_type: number;
  high_signal: boolean;
  source_count: number;
  payload_count: number;
  enqueued: number;
  already_queued: number;
  enqueue_results: Array<{
    source_type: ProspectDetectSourceType;
    source_id: string;
    inserted: boolean;
    work_queue_id: string | null;
  }>;
  canary: ProspectPipelineCanarySummary;
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
    throw new Error('INVALID_SOURCE_TYPE');
  }
  const lookbackHours = Number(raw.get('lookback-hours') || 24);
  const limit = Number(raw.get('limit') || 3);
  if (!Number.isFinite(lookbackHours) || lookbackHours < 1 || lookbackHours > 24 * 30) {
    throw new Error('INVALID_LOOKBACK_HOURS');
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 10) {
    throw new Error('INVALID_LIMIT_MAX_10');
  }
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    sourceType,
    lookbackHours: Math.floor(lookbackHours),
    limit: Math.floor(limit),
    highSignal: raw.get('high-signal') !== 'false',
    enqueue: raw.get('enqueue') === 'true' || raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
  };
}

export async function runProspectLiveCanary(
  env: Env,
  args: Pick<Args, 'orgId' | 'sourceType' | 'lookbackHours' | 'limit' | 'highSignal' | 'enqueue' | 'confirmProductionWrite'>
): Promise<ProspectLiveCanarySummary> {
  if (args.enqueue && args.confirmProductionWrite !== LIVE_CANARY_CONFIRMATION) {
    throw new Error(`PROSPECT_LIVE_CANARY_REQUIRES_EXPLICIT_GO: pass --enqueue true --confirm-production-write ${LIVE_CANARY_CONFIRMATION} only after Lucas GO`);
  }

  const canary = await buildProspectPipelineCanarySummary(env, {
    orgId: args.orgId,
    sourceType: args.sourceType,
    lookbackHours: args.lookbackHours,
    limit: Math.min(Math.max(Math.floor(args.limit), 1), 10),
    highSignal: args.highSignal,
  });

  const enqueueResults: ProspectLiveCanarySummary['enqueue_results'] = [];
  if (args.enqueue) {
    for (const payload of canary.queue_payloads) {
      const result = await enqueueProspectDetectSource(env, {
        orgId: args.orgId,
        sourceType: payload.source_type,
        sourceId: payload.source_id,
        origin: 'prospect_live_canary',
        ingestionMode: 'live',
        priority: 5,
      });
      enqueueResults.push({
        source_type: payload.source_type,
        source_id: payload.source_id,
        inserted: result.inserted,
        work_queue_id: result.id || null,
      });
    }
  }

  return {
    dry_run: !args.enqueue,
    org_id: args.orgId,
    source_type: args.sourceType,
    lookback_hours: args.lookbackHours,
    limit_per_source_type: args.limit,
    high_signal: args.highSignal,
    source_count: canary.sources.length,
    payload_count: canary.queue_payloads.length,
    enqueued: enqueueResults.filter(row => row.inserted).length,
    already_queued: enqueueResults.filter(row => !row.inserted).length,
    enqueue_results: enqueueResults,
    canary,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const summary = await runProspectLiveCanary(proxy.env as unknown as Env, args);
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

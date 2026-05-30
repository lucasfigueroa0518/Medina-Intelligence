#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import {
  __prospectIntelligenceTestHooks,
  callProspectClassifier,
  loadProspectClassifierKnownContext,
  PROSPECT_DIRECTIONS,
  PROSPECT_MENTION_TYPES,
  PROSPECT_SECTOR_TAXONOMY,
  type ProspectClassifierKnownContext,
} from '../src/lib/prospect-intelligence';

type Split = 'dev' | 'test' | 'all';

interface GoldRecord {
  item_id: string;
  source_type: string;
  source_id: string;
  mention_ordinal: number;
  company_name: string;
  raw_excerpt: string;
  sender_and_context: string;
  gold_mention_type: string;
  gold_direction?: string | null;
  gold_sector_key?: string | null;
  split: 'dev' | 'test';
  notes?: string;
}

interface Args {
  goldSetPath: string;
  orgId: string;
  split: Split;
  configPath: string;
  knownContextPath?: string;
  outputPath?: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

interface PredictionRecord {
  item_id: string;
  source_type: string;
  source_id: string;
  mention_ordinal: number;
  company_name: string;
  split: string;
  gold_mention_type: string;
  gold_direction: string | null;
  gold_sector_key: string | null;
  predicted_mention_type: string;
  predicted_direction: string;
  predicted_sector_key: string;
  confidence: number;
  sector_confidence: number;
  reasoning: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args.set(key, 'true');
    } else {
      args.set(key, next);
      i++;
    }
  }

  const goldSetPath = args.get('gold-set') || args.get('input');
  const orgId = args.get('org-id');
  if (!goldSetPath || !orgId) {
    throw new Error(
      'Usage: npm run prospect:spike -- --gold-set /secure/path/gold.jsonl --org-id <org_id> [--split test] [--known-context /secure/path/context.json]'
    );
  }
  const splitRaw = args.get('split') || 'test';
  if (splitRaw !== 'dev' && splitRaw !== 'test' && splitRaw !== 'all') {
    throw new Error('INVALID_SPLIT: expected dev, test, or all');
  }

  const numberArg = (key: string): number | undefined => {
    const value = args.get(key);
    if (!value) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`INVALID_${key.toUpperCase()}`);
    return n;
  };

  return {
    goldSetPath,
    orgId,
    split: splitRaw,
    configPath: args.get('config') || 'wrangler.toml',
    knownContextPath: args.get('known-context'),
    outputPath: args.get('output'),
    inputUsdPerMillion: numberArg('input-usd-per-million'),
    outputUsdPerMillion: numberArg('output-usd-per-million'),
  };
}

function parseJsonl(raw: string): GoldRecord[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as GoldRecord;
      } catch (e) {
        throw new Error(`INVALID_JSONL line=${index + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
}

function normalizedGoldLabel(value: unknown): string | null {
  const text = String(value || '').trim();
  return text && text !== '-' ? text : null;
}

function prefilterHintsFor(record: GoldRecord, sectorHint: { key: string; confidence: number }): Record<string, unknown> {
  const text = `${record.sender_and_context}\n${record.raw_excerpt}`.toLowerCase();
  const reasons: string[] = [];
  if (/\b(newsletter|digest|nvca|market update|press)\b/.test(text)) reasons.push('newsletter_like_source');
  if (/\b(deck|pitch deck|data room|memo|cim)\b/.test(text)) reasons.push('deck_signal');
  if (/\b(meeting|met with|call|zoom|demo)\b/.test(text)) reasons.push('meeting_or_call_signal');
  if (/\b(intro|introducing|warm intro|referred|forwarding)\b/.test(text)) reasons.push('warm_intro_language');
  if (/^\s*(?:[-*]|\d+[.)])\s+/m.test(record.raw_excerpt)) reasons.push('list_entry_shape');

  return {
    should_classify: true,
    gold_set_harness: true,
    reasons,
    deterministic_direction: 'unknown',
    newsletter_likely: reasons.includes('newsletter_like_source'),
    signal_kind_hint: reasons.includes('deck_signal')
      ? 'deck'
      : reasons.includes('meeting_or_call_signal')
      ? 'call'
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

function incrementMatrix(matrix: Record<string, Record<string, number>>, gold: string, predicted: string): void {
  matrix[gold] ||= {};
  matrix[gold][predicted] = (matrix[gold][predicted] || 0) + 1;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function metricPass(value: number | null, threshold: number): boolean {
  return typeof value === 'number' && value >= threshold;
}

function summarize(
  predictions: PredictionRecord[],
  args: Args
): Record<string, unknown> {
  const mentionMatrix: Record<string, Record<string, number>> = {};
  const directionMatrix: Record<string, Record<string, number>> = {};
  const sectorMatrix: Record<string, Record<string, number>> = {};
  const perClass: Record<string, { precision: number | null; recall: number | null; tp: number; predicted: number; gold: number }> = {};

  for (const type of PROSPECT_MENTION_TYPES) {
    const tp = predictions.filter(p => p.gold_mention_type === type && p.predicted_mention_type === type).length;
    const predicted = predictions.filter(p => p.predicted_mention_type === type).length;
    const gold = predictions.filter(p => p.gold_mention_type === type).length;
    perClass[type] = { precision: ratio(tp, predicted), recall: ratio(tp, gold), tp, predicted, gold };
  }

  let directionCorrect = 0;
  let directionTotal = 0;
  let inboundDirectionCorrect = 0;
  let inboundDirectionTotal = 0;
  let sectorCorrect = 0;
  let sectorTotal = 0;

  for (const p of predictions) {
    incrementMatrix(mentionMatrix, p.gold_mention_type, p.predicted_mention_type);
    if (p.gold_direction) {
      incrementMatrix(directionMatrix, p.gold_direction, p.predicted_direction);
      directionTotal++;
      if (p.gold_direction === p.predicted_direction) directionCorrect++;
      if (p.gold_mention_type === 'inbound_prospect') {
        inboundDirectionTotal++;
        if (p.gold_direction === p.predicted_direction) inboundDirectionCorrect++;
      }
    }
    if (p.gold_sector_key) {
      incrementMatrix(sectorMatrix, p.gold_sector_key, p.predicted_sector_key);
      sectorTotal++;
      if (p.gold_sector_key === p.predicted_sector_key) sectorCorrect++;
    }
  }

  const directionAccuracy = ratio(directionCorrect, directionTotal);
  const inboundDirectionAccuracy = ratio(inboundDirectionCorrect, inboundDirectionTotal);
  const sectorAccuracy = ratio(sectorCorrect, sectorTotal);
  const inboundPrecision = perClass.inbound_prospect.precision;
  const inboundRecall = perClass.inbound_prospect.recall;
  const knownDealPrecision = perClass.known_deal.precision;
  const pass =
    metricPass(inboundPrecision, 0.95) &&
    metricPass(inboundRecall, 0.9) &&
    metricPass(directionAccuracy, 0.95) &&
    metricPass(knownDealPrecision, 0.95);

  const usage = predictions.reduce(
    (acc, p) => ({
      input_tokens: acc.input_tokens + p.usage.input_tokens,
      output_tokens: acc.output_tokens + p.usage.output_tokens,
      total_tokens: acc.total_tokens + p.usage.total_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  );
  const estimatedCostUsd =
    args.inputUsdPerMillion != null && args.outputUsdPerMillion != null
      ? (usage.input_tokens / 1_000_000) * args.inputUsdPerMillion +
        (usage.output_tokens / 1_000_000) * args.outputUsdPerMillion
      : null;

  const failingItems = predictions
    .filter(p =>
      p.gold_mention_type !== p.predicted_mention_type ||
      (!!p.gold_direction && p.gold_direction !== p.predicted_direction) ||
      (!!p.gold_sector_key && p.gold_sector_key !== p.predicted_sector_key)
    )
    .map(p => ({
      item_id: p.item_id,
      company_name: p.company_name,
      gold_mention_type: p.gold_mention_type,
      predicted_mention_type: p.predicted_mention_type,
      gold_direction: p.gold_direction,
      predicted_direction: p.predicted_direction,
      gold_sector_key: p.gold_sector_key,
      predicted_sector_key: p.predicted_sector_key,
      confidence: p.confidence,
      reasoning: p.reasoning,
    }));

  return {
    verdict: pass ? 'GO' : 'NO_GO',
    note: 'Only valid for a frozen human-labeled split. Do not run backfill unless verdict is GO on the held-out test split.',
    split: args.split,
    item_count: predictions.length,
    thresholds: {
      inbound_prospect_precision: 0.95,
      inbound_prospect_recall: 0.9,
      direction_accuracy: 0.95,
      known_deal_precision: 0.95,
    },
    metrics: {
      mention_type: perClass,
      direction_accuracy: directionAccuracy,
      inbound_prospect_direction_accuracy: inboundDirectionAccuracy,
      sector_accuracy: sectorAccuracy,
    },
    confusion_matrices: {
      mention_type: mentionMatrix,
      direction: directionMatrix,
      sector_key: sectorMatrix,
    },
    usage: {
      ...usage,
      per_item_avg_tokens: predictions.length > 0 ? usage.total_tokens / predictions.length : null,
      estimated_cost_usd: estimatedCostUsd,
    },
    failing_items: failingItems,
    predictions,
  };
}

async function loadKnownContext(args: Args, env: Env): Promise<ProspectClassifierKnownContext> {
  if (!args.knownContextPath) {
    return loadProspectClassifierKnownContext(args.orgId, env);
  }
  const parsed = JSON.parse(await readFile(args.knownContextPath, 'utf8')) as Partial<ProspectClassifierKnownContext>;
  return {
    knownDeals: Array.isArray(parsed.knownDeals) ? parsed.knownDeals : [],
    knownDealmakers: Array.isArray(parsed.knownDealmakers) ? parsed.knownDealmakers : [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  const env = proxy.env as unknown as Env;
  try {
    const knownContext = await loadKnownContext(args, env);
    const allRecords = parseJsonl(await readFile(args.goldSetPath, 'utf8'));
    const records = allRecords.filter(record => args.split === 'all' || record.split === args.split);
    if (records.length === 0) throw new Error(`NO_GOLD_RECORDS_FOR_SPLIT:${args.split}`);

    const predictions: PredictionRecord[] = [];
    for (const record of records) {
      const goldMentionType = normalizedGoldLabel(record.gold_mention_type);
      if (!goldMentionType || !PROSPECT_MENTION_TYPES.includes(goldMentionType as any)) {
        throw new Error(`INVALID_GOLD_MENTION_TYPE item_id=${record.item_id}`);
      }
      const goldDirection = normalizedGoldLabel(record.gold_direction);
      if (goldDirection && !PROSPECT_DIRECTIONS.includes(goldDirection as any)) {
        throw new Error(`INVALID_GOLD_DIRECTION item_id=${record.item_id}`);
      }
      const goldSectorKey = normalizedGoldLabel(record.gold_sector_key);
      if (goldSectorKey && !PROSPECT_SECTOR_TAXONOMY.some(sector => sector.key === goldSectorKey)) {
        throw new Error(`INVALID_GOLD_SECTOR_KEY item_id=${record.item_id}`);
      }
      const sectorHint = __prospectIntelligenceTestHooks.sectorHintForText(
        `${record.company_name}\n${record.raw_excerpt}`
      );
      const decision = await callProspectClassifier({
        sourceType: record.source_type,
        senderAndContext: record.sender_and_context,
        companyName: record.company_name,
        rawExcerpt: record.raw_excerpt,
        prefilterHints: prefilterHintsFor(record, sectorHint),
        sectorHints: sectorHint,
        knownContext,
        orgId: args.orgId,
      }, env);
      const inputTokens = decision.usage?.input_tokens || 0;
      const outputTokens = decision.usage?.output_tokens || 0;
      predictions.push({
        item_id: record.item_id,
        source_type: record.source_type,
        source_id: record.source_id,
        mention_ordinal: record.mention_ordinal,
        company_name: record.company_name,
        split: record.split,
        gold_mention_type: goldMentionType,
        gold_direction: goldDirection,
        gold_sector_key: goldSectorKey,
        predicted_mention_type: decision.mentionType,
        predicted_direction: decision.direction,
        predicted_sector_key: decision.sectorKey,
        confidence: decision.confidence,
        sector_confidence: decision.sectorConfidence,
        reasoning: decision.reasoning,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
      });
    }

    const summary = summarize(predictions, args);
    const output = `${JSON.stringify(summary, null, 2)}\n`;
    if (args.outputPath) await writeFile(args.outputPath, output, 'utf8');
    process.stdout.write(output);
    process.exitCode = summary.verdict === 'GO' ? 0 : 2;
  } finally {
    await proxy.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

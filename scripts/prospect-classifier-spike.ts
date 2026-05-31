#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
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
  type ProspectClassifierInput,
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
  gold_mention_type?: string | null;
  gold_direction?: string | null;
  gold_sector_key?: string | null;
  mention_type?: string | null;
  direction?: string | null;
  sector_key?: string | null;
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

interface SpikeClassifierDecision {
  mentionType: string;
  direction: string;
  sectorKey: string;
  sectorConfidence: number;
  confidence: number;
  reasoning: string | null;
  model: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens?: number };
  rawResponse?: string;
}

class SpikeClassifierError extends Error {
  usage?: { input_tokens: number; output_tokens: number; total_tokens?: number };
  model?: string;
  rawResponse?: string;

  constructor(
    message: string,
    options?: { usage?: { input_tokens: number; output_tokens: number; total_tokens?: number }; model?: string; rawResponse?: string }
  ) {
    super(message);
    this.name = 'SpikeClassifierError';
    this.usage = options?.usage;
    this.model = options?.model;
    this.rawResponse = options?.rawResponse;
  }
}

let forceDirectAnthropic = process.env.PROSPECT_SPIKE_DIRECT_ANTHROPIC === '1';

type LabelColumn = 'mention_type' | 'direction' | 'sector_key';
type LabelExclusionReason = 'blank' | 'adjudicate';

interface LabelStatus {
  value: string | null;
  excluded_reason: LabelExclusionReason | null;
}

export interface PredictionRecord {
  item_id: string;
  source_type: string;
  source_id: string;
  mention_ordinal: number;
  company_name: string;
  split: string;
  gold_mention_type: string | null;
  gold_direction: string | null;
  gold_sector_key: string | null;
  gold_label_exclusions: Record<LabelColumn, LabelExclusionReason | null>;
  predicted_mention_type: string;
  predicted_direction: string;
  predicted_sector_key: string;
  confidence: number;
  sector_confidence: number;
  reasoning: string | null;
  classifier_error?: string | null;
  raw_model_output?: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  cost_usd: number | null;
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
      'Usage: npm run prospect:spike -- --gold-set /secure/path/gold.jsonl-or.csv --org-id <org_id> [--split test] [--known-context /secure/path/context.json]'
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

function parseCsv(raw: string): GoldRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') {
        field += '"';
        i++;
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
  const keyFor = (name: string): number => header.indexOf(name);
  const valueAt = (record: string[], ...names: string[]): string => {
    for (const name of names) {
      const index = keyFor(name);
      if (index >= 0) return record[index] || '';
    }
    return '';
  };

  return body.map((record, index) => {
    const sourceType = valueAt(record, 'source_type');
    const sourceId = valueAt(record, 'source_id');
    const mentionOrdinal = Number(valueAt(record, 'mention_ordinal') || index + 1);
    const deterministicKey = valueAt(record, 'deterministic_key') || `${sourceType}:${sourceId}:${mentionOrdinal}`;
    const senderContext = valueAt(record, 'sender_and_context') || [
      valueAt(record, 'source_sender') ? `from ${valueAt(record, 'source_sender')}` : '',
      valueAt(record, 'source_subject') ? `subject ${valueAt(record, 'source_subject')}` : '',
      valueAt(record, 'occurred_at') ? `occurred ${valueAt(record, 'occurred_at')}` : '',
    ].filter(Boolean).join('; ');

    return {
      item_id: valueAt(record, 'item_id') || deterministicKey,
      source_type: sourceType,
      source_id: sourceId,
      mention_ordinal: mentionOrdinal,
      company_name: valueAt(record, 'company_name', 'company_as_mentioned'),
      raw_excerpt: valueAt(record, 'raw_excerpt', 'surrounding_context'),
      sender_and_context: senderContext,
      gold_mention_type: valueAt(record, 'gold_mention_type', 'mention_type'),
      gold_direction: valueAt(record, 'gold_direction', 'direction'),
      gold_sector_key: valueAt(record, 'gold_sector_key', 'sector_key'),
      split: (valueAt(record, 'split') || 'test') as 'dev' | 'test',
      notes: valueAt(record, 'notes'),
    };
  });
}

export function parseGoldRecords(raw: string, path = ''): GoldRecord[] {
  return /\.csv$/i.test(path) ? parseCsv(raw) : parseJsonl(raw);
}

export function normalizedGoldLabel(value: unknown): LabelStatus {
  const text = String(value || '').trim();
  if (!text || text === '-') return { value: null, excluded_reason: 'blank' };
  if (/\badjudicate\b/i.test(text)) return { value: null, excluded_reason: 'adjudicate' };
  return { value: text, excluded_reason: null };
}

function goldLabelInput(record: GoldRecord, goldKey: 'gold_mention_type' | 'gold_direction' | 'gold_sector_key', humanKey: 'mention_type' | 'direction' | 'sector_key'): unknown {
  const goldValue = record[goldKey];
  return String(goldValue ?? '').trim() ? goldValue : record[humanKey];
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

function spikeClassifierModel(env: Env): string {
  return env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
}

async function callDirectAnthropicClassifier(input: ProspectClassifierInput, env: Env): Promise<SpikeClassifierDecision> {
  const apiKey = (env as any).ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing for direct spike classifier fallback');
  const prompt = __prospectIntelligenceTestHooks.buildProspectClassifierPrompt(input);
  const model = spikeClassifierModel(env);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      temperature: 0,
      system: prompt.systemForApi,
      messages: [
        { role: 'user', content: prompt.user },
        { role: 'assistant', content: '{' },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DIRECT_ANTHROPIC_CLASSIFIER_FAILED ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json() as any;
  const text = `{${data.content?.find((block: any) => block.type === 'text')?.text || ''}`;
  try {
    return { ...__prospectIntelligenceTestHooks.parseProspectClassifierResponse(text, model, data.usage), rawResponse: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpikeClassifierError(message, { usage: data.usage, model, rawResponse: text });
  }
}

async function callClassifierForSpike(input: ProspectClassifierInput, env: Env): Promise<SpikeClassifierDecision> {
  if (forceDirectAnthropic) {
    return callDirectAnthropicClassifier(input, env);
  }
  try {
    return await callProspectClassifier(input, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Claude API error 401|Unauthorized|AiGatewayError/i.test(message)) {
      forceDirectAnthropic = true;
      return callDirectAnthropicClassifier(input, env);
    }
    throw error;
  }
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

function coverageFor(predictions: PredictionRecord[], column: LabelColumn): Record<string, unknown> {
  const field = column === 'mention_type'
    ? 'gold_mention_type'
    : column === 'direction'
    ? 'gold_direction'
    : 'gold_sector_key';
  const excludedByReason: Record<LabelExclusionReason, number> = { blank: 0, adjudicate: 0 };
  for (const prediction of predictions) {
    const reason = prediction.gold_label_exclusions[column];
    if (reason) excludedByReason[reason]++;
  }
  const scored = predictions.filter(prediction => prediction[field] != null).length;
  const excluded = predictions.length - scored;
  return {
    scored_rows: scored,
    excluded_rows: excluded,
    excluded_by_reason: excludedByReason,
  };
}

export function summarize(
  predictions: PredictionRecord[],
  args: Args
): Record<string, unknown> {
  const mentionMatrix: Record<string, Record<string, number>> = {};
  const directionMatrix: Record<string, Record<string, number>> = {};
  const sectorMatrix: Record<string, Record<string, number>> = {};
  const perClass: Record<string, { precision: number | null; recall: number | null; tp: number; predicted: number; gold: number }> = {};
  const mentionScored = predictions.filter(p => p.gold_mention_type);
  const directionScored = predictions.filter(p => p.gold_direction);
  const sectorScored = predictions.filter(p => p.gold_sector_key);

  for (const type of PROSPECT_MENTION_TYPES) {
    const tp = mentionScored.filter(p => p.gold_mention_type === type && p.predicted_mention_type === type).length;
    const predicted = mentionScored.filter(p => p.predicted_mention_type === type).length;
    const gold = mentionScored.filter(p => p.gold_mention_type === type).length;
    perClass[type] = { precision: ratio(tp, predicted), recall: ratio(tp, gold), tp, predicted, gold };
  }

  let directionCorrect = 0;
  let directionTotal = 0;
  let inboundDirectionCorrect = 0;
  let inboundDirectionTotal = 0;
  let sectorCorrect = 0;
  let sectorTotal = 0;

  for (const p of mentionScored) {
    incrementMatrix(mentionMatrix, p.gold_mention_type as string, p.predicted_mention_type);
  }
  for (const p of directionScored) {
    incrementMatrix(directionMatrix, p.gold_direction as string, p.predicted_direction);
    directionTotal++;
    if (p.gold_direction === p.predicted_direction) directionCorrect++;
    if (p.gold_mention_type === 'inbound_prospect') {
      inboundDirectionTotal++;
      if (p.gold_direction === p.predicted_direction) inboundDirectionCorrect++;
    }
  }
  for (const p of sectorScored) {
    incrementMatrix(sectorMatrix, p.gold_sector_key as string, p.predicted_sector_key);
    sectorTotal++;
    if (p.gold_sector_key === p.predicted_sector_key) sectorCorrect++;
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
  const estimatedCostPerItemUsd =
    estimatedCostUsd != null && predictions.length > 0
      ? estimatedCostUsd / predictions.length
      : null;
  const classifierErrorCount = predictions.filter(p => p.classifier_error).length;

  const failingItems = predictions
    .filter(p =>
      (!!p.gold_mention_type && p.gold_mention_type !== p.predicted_mention_type) ||
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
      classifier_error: p.classifier_error || null,
    }));

  return {
    verdict: pass ? 'GO' : 'NO_GO',
    note: 'Only valid for a frozen human-labeled split. Do not run backfill unless verdict is GO on the held-out test split.',
    split: args.split,
    item_count: predictions.length,
    classifier_error_count: classifierErrorCount,
    scoring_coverage: {
      mention_type: coverageFor(predictions, 'mention_type'),
      direction: coverageFor(predictions, 'direction'),
      sector_key: {
        ...coverageFor(predictions, 'sector_key'),
        note: 'Blank sector_key is expected and excluded for news, intro_source, noise, and web_analytics rows.',
      },
    },
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
      estimated_cost_per_item_usd: estimatedCostPerItemUsd,
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
    const allRecords = parseGoldRecords(await readFile(args.goldSetPath, 'utf8'), args.goldSetPath);
    const records = allRecords.filter(record => args.split === 'all' || record.split === args.split);
    if (records.length === 0) throw new Error(`NO_GOLD_RECORDS_FOR_SPLIT:${args.split}`);

    const predictions: PredictionRecord[] = [];
    for (const record of records) {
      const goldMentionType = normalizedGoldLabel(goldLabelInput(record, 'gold_mention_type', 'mention_type'));
      if (goldMentionType.value && !PROSPECT_MENTION_TYPES.includes(goldMentionType.value as any)) {
        throw new Error(`INVALID_GOLD_MENTION_TYPE item_id=${record.item_id}`);
      }
      const goldDirection = normalizedGoldLabel(goldLabelInput(record, 'gold_direction', 'direction'));
      if (goldDirection.value && !PROSPECT_DIRECTIONS.includes(goldDirection.value as any)) {
        throw new Error(`INVALID_GOLD_DIRECTION item_id=${record.item_id}`);
      }
      const goldSectorKey = normalizedGoldLabel(goldLabelInput(record, 'gold_sector_key', 'sector_key'));
      if (goldSectorKey.value && !PROSPECT_SECTOR_TAXONOMY.some(sector => sector.key === goldSectorKey.value)) {
        throw new Error(`INVALID_GOLD_SECTOR_KEY item_id=${record.item_id}`);
      }
      const sectorHint = __prospectIntelligenceTestHooks.sectorHintForText(
        `${record.company_name}\n${record.raw_excerpt}`
      );
      const classifierInput: ProspectClassifierInput = {
        sourceType: record.source_type,
        senderAndContext: record.sender_and_context,
        companyName: record.company_name,
        rawExcerpt: record.raw_excerpt,
        prefilterHints: prefilterHintsFor(record, sectorHint),
        sectorHints: sectorHint,
        knownContext,
        orgId: args.orgId,
      };
      let decision: SpikeClassifierDecision | null = null;
      let classifierError: string | null = null;
      let errorUsage: SpikeClassifierDecision['usage'] | null = null;
      let rawModelOutput: string | null = null;
      try {
        decision = await callClassifierForSpike(classifierInput, env);
        rawModelOutput = decision.rawResponse || null;
      } catch (error) {
        classifierError = error instanceof Error ? error.message : String(error);
        if (error instanceof SpikeClassifierError) {
          errorUsage = error.usage || null;
          rawModelOutput = error.rawResponse || null;
        }
      }
      const inputTokens = decision?.usage?.input_tokens ?? errorUsage?.input_tokens ?? 0;
      const outputTokens = decision?.usage?.output_tokens ?? errorUsage?.output_tokens ?? 0;
      const costUsd =
        args.inputUsdPerMillion != null && args.outputUsdPerMillion != null
          ? (inputTokens / 1_000_000) * args.inputUsdPerMillion +
            (outputTokens / 1_000_000) * args.outputUsdPerMillion
          : null;
      predictions.push({
        item_id: record.item_id,
        source_type: record.source_type,
        source_id: record.source_id,
        mention_ordinal: record.mention_ordinal,
        company_name: record.company_name,
        split: record.split,
        gold_mention_type: goldMentionType.value,
        gold_direction: goldDirection.value,
        gold_sector_key: goldSectorKey.value,
        gold_label_exclusions: {
          mention_type: goldMentionType.excluded_reason,
          direction: goldDirection.excluded_reason,
          sector_key: goldSectorKey.excluded_reason,
        },
        predicted_mention_type: decision?.mentionType || 'classifier_error',
        predicted_direction: decision?.direction || 'classifier_error',
        predicted_sector_key: decision?.sectorKey || 'classifier_error',
        confidence: decision?.confidence || 0,
        sector_confidence: decision?.sectorConfidence || 0,
        reasoning: decision?.reasoning || null,
        classifier_error: classifierError,
        raw_model_output: rawModelOutput,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        cost_usd: costUsd,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

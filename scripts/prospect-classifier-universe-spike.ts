#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { getPlatformProxy } from 'wrangler';

import { callClaudeWithUsage } from '../src/lib/claude';
import {
  __prospectIntelligenceTestHooks,
  loadProspectClassifierKnownContext,
  PROSPECT_CLASSIFIER_VERSION,
  type ProspectClassifierInput,
  type ProspectClassifierKnownContext,
  type ProspectClassifierPolicyLens,
} from '../src/lib/prospect-intelligence';
import type { Env } from '../src/types/env';
import { parseGoldRecords } from './prospect-classifier-spike';

type Split = 'dev' | 'test' | 'all';
type GoldRecord = ReturnType<typeof parseGoldRecords>[number];

interface Args {
  inputPath: string;
  orgId: string;
  split: Split;
  configPath: string;
  knownContextPath?: string;
  oldAnchorPath?: string;
  outputDir: string;
  confidenceSpreadThreshold: number;
  callDelayMs: number;
  retryAttempts: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

interface UniverseDefinition extends ProspectClassifierPolicyLens {
  risk_posture: 'precision' | 'balanced' | 'recall';
}

type NewProspectAction =
  | 'create_prospect'
  | 'attach_existing_deal'
  | 'record_context'
  | 'ignore'
  | 'classifier_error'
  | 'unknown';

export const PROSPECT_CLASSIFIER_UNIVERSES: UniverseDefinition[] = [
  {
    id: 'conservative-prospect-creator',
    name: 'Conservative Prospect Creator',
    risk_posture: 'precision',
    instructions: [
      'Optimize create_prospect precision.',
      'Borderline relationship, meeting, customer, investor, or channel context should be captured as signal-only.',
      'Choose create_prospect only when the named company is clearly being presented as an investment opportunity.',
    ].join(' '),
  },
  {
    id: 'balanced-signal-capture',
    name: 'Balanced Signal Capture',
    risk_posture: 'balanced',
    instructions: [
      'Capture useful dealflow and relationship signals broadly.',
      'Create a prospect when investment-target evidence is clear or strongly implied by intro/deck/raise language.',
      'Keep non-target entities as record_context rather than ignore when they are useful dealflow, meeting, or relationship context.',
    ].join(' '),
  },
  {
    id: 'broad-relationship-signal-capture',
    name: 'Broad Relationship Signal Capture',
    risk_posture: 'recall',
    instructions: [
      'Maximize visibility into weak relationship and meeting signals.',
      'Prefer record_context over ignore for useful weak context around deal flow.',
      'Still do not create a prospect unless the named company itself is the likely investment target.',
    ].join(' '),
  },
];

export interface UniversePrediction {
  item_id: string;
  source_type: string;
  source_id: string;
  mention_ordinal: number;
  company_name: string;
  split: string;
  universe_id: string;
  universe_name: string;
  predicted_mention_type: string;
  prospect_action: string;
  should_create_prospect: boolean | null;
  prospect_company_name: string | null;
  predicted_direction: string;
  predicted_sector_key: string;
  confidence: number;
  reasoning: string | null;
  create_prospect_veto_applied?: boolean;
  create_prospect_veto_reason?: string | null;
  original_prospect_action?: string | null;
  classifier_error: string | null;
  raw_model_output: string | null;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  cost_usd: number | null;
}

export interface UniverseRowDisagreement {
  item_id: string;
  company_name: string;
  fuzzy: boolean;
  reasons: string[];
  should_create_votes: Record<string, number>;
  action_votes: Record<string, number>;
  mention_type_votes: Record<string, number>;
  confidence_spread: number;
}

export interface OldAnchorPrediction {
  item_id: string;
  company_name?: string;
  predicted_mention_type?: string;
  predicted_prospect_action?: string | null;
  confidence?: number | null;
  reasoning?: string | null;
}

interface OldAnchorRow {
  item_id: string;
  company_name: string;
  predicted_mention_type: string;
  old_anchor_action: NewProspectAction;
  confidence: number | null;
  reasoning: string | null;
}

interface LucasAdjudication {
  expected_action: 'create_prospect' | 'record_context';
  note: string;
}

interface ConsensusInfo {
  consensus_action: string | null;
  consensus_count: number;
  stability: 'stable_3_3' | 'somewhat_fuzzy_2_3' | 'high_fuzziness';
}

interface OldInboundAnchorRow {
  item_id: string;
  company_name: string;
  old_predicted_mention_type: string;
  old_anchor_action: NewProspectAction;
  old_confidence: number | null;
  lucas_expected_action: string | null;
  lucas_note: string | null;
  universe_actions: Record<string, string>;
  consensus_action: string | null;
  consensus_count: number;
  stability: ConsensusInfo['stability'];
  old_anchor_match_count: number;
  lucas_expected_match_count: number | null;
}

interface RiskRow {
  item_id: string;
  company_name: string;
  actions: Record<string, string>;
  old_anchor_action?: NewProspectAction;
  old_predicted_mention_type?: string;
}

export interface OldAnchorAlignmentSummary {
  old_anchor_path: string | null;
  old_rows: number;
  matched_rows: number;
  missing_new_rows: number;
  old_inbound_rows: number;
  stability_counts: Record<ConsensusInfo['stability'], number>;
  old_anchor_alignment: {
    matches: number;
    comparisons: number;
    rate: number | null;
  };
  lucas_adjusted_alignment: {
    matches: number;
    comparisons: number;
    rate: number | null;
  };
  per_action_votes: Record<string, number>;
  prospect_creation_risk: {
    any_create_prospect_rows: RiskRow[];
    only_broad_create_prospect_rows: RiskRow[];
    old_inbound_all_ignore_rows: RiskRow[];
    old_noise_two_plus_create_prospect_rows: RiskRow[];
  };
  old_inbound_overlay: OldInboundAnchorRow[];
}

const LUCAS_ADJUDICATED_OLD_INBOUND_BY_ITEM_ID: Record<string, LucasAdjudication> = {
  'conversation:671d5aba-c1b5-4ee6-a013-4d4749a3faa5:1:101:113': {
    expected_action: 'create_prospect',
    note: 'Qusecure: Lucas-adjusted valid prospect signal.',
  },
  'conversation:26128598-89de-4d8b-8020-220cee7fe93d:1:177:183': {
    expected_action: 'create_prospect',
    note: 'Vulcan: Lucas-adjusted valid prospect signal.',
  },
  'conversation:672e3198-d362-4889-97ba-d5e0a49634b9:1:207:226': {
    expected_action: 'record_context',
    note: 'MRAI Global: acceptable signal/context unless all universes find clear investment-target evidence.',
  },
  'conversation:aaec07cb-b634-4493-b787-16083e32810e:1:207:226': {
    expected_action: 'record_context',
    note: 'MRAI Global: acceptable signal/context unless all universes find clear investment-target evidence.',
  },
  'event:01375085f217fdaf4589fbc4c43cd8d5:5:2303:2311': {
    expected_action: 'create_prospect',
    note: 'Togal: Lucas-adjusted valid prospect signal.',
  },
  'conversation:62d0b706-47da-472a-839f-10fc244f4c50:3:616:626': {
    expected_action: 'record_context',
    note: 'Apollo Lee: acceptable signal/context unless all universes find clear investment-target evidence.',
  },
  'conversation:a36322d7-bba1-490e-83d6-6953b2d9e5d7:2:830:845': {
    expected_action: 'create_prospect',
    note: 'Rendair: Lucas-adjusted valid prospect signal.',
  },
  'conversation:29d061e4-69bc-46f7-a43c-e0af4efc7602:1:447:462': {
    expected_action: 'record_context',
    note: 'Cedar Pine, LLC: acceptable signal/context unless all universes find clear investment-target evidence.',
  },
};

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
  const inputPath = args.get('input') || args.get('gold-set');
  const orgId = args.get('org-id');
  if (!inputPath || !orgId) {
    throw new Error('Usage: npm run prospect:universes -- --input /secure/path/labeled.csv --org-id <org_id> [--split test]');
  }
  const splitRaw = args.get('split') || 'test';
  if (splitRaw !== 'dev' && splitRaw !== 'test' && splitRaw !== 'all') {
    throw new Error('INVALID_SPLIT: expected dev, test, or all');
  }
  const confidenceSpreadThreshold = Number(args.get('confidence-spread-threshold') || 0.25);
  if (!Number.isFinite(confidenceSpreadThreshold) || confidenceSpreadThreshold < 0) {
    throw new Error('INVALID_CONFIDENCE_SPREAD_THRESHOLD');
  }
  const callDelayMs = Number(args.get('call-delay-ms') || 1500);
  if (!Number.isFinite(callDelayMs) || callDelayMs < 0) {
    throw new Error('INVALID_CALL_DELAY_MS');
  }
  const retryAttempts = Number(args.get('retry-attempts') || 6);
  if (!Number.isInteger(retryAttempts) || retryAttempts < 1) {
    throw new Error('INVALID_RETRY_ATTEMPTS');
  }
  const numberArg = (key: string): number | undefined => {
    const value = args.get(key);
    if (!value) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`INVALID_${key.toUpperCase()}`);
    return n;
  };
  return {
    inputPath,
    orgId,
    split: splitRaw,
    configPath: args.get('config') || 'wrangler.toml',
    knownContextPath: args.get('known-context'),
    oldAnchorPath: args.get('old-anchor'),
    outputDir: args.get('output-dir') || '.prospect-gold-set/universe-runs',
    confidenceSpreadThreshold,
    callDelayMs,
    retryAttempts,
    inputUsdPerMillion: numberArg('input-usd-per-million'),
    outputUsdPerMillion: numberArg('output-usd-per-million'),
  };
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
    universe_spike: true,
    reasons,
    deterministic_direction: 'unknown',
    newsletter_likely: reasons.includes('newsletter_like_source'),
    signal_kind_hint: reasons.includes('deck_signal')
      ? 'deck'
      : reasons.includes('meeting_or_call_signal')
      ? 'meeting'
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

function classifierModel(env: Env): string {
  return env.PROSPECT_CLASSIFIER_MODEL || env.MARTY_LAB_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
}

function costFor(
  usage: { input_tokens: number; output_tokens: number },
  args: Args
): number | null {
  if (args.inputUsdPerMillion == null || args.outputUsdPerMillion == null) return null;
  return (usage.input_tokens / 1_000_000) * args.inputUsdPerMillion +
    (usage.output_tokens / 1_000_000) * args.outputUsdPerMillion;
}

function inputHash(records: GoldRecord[]): string {
  const h = createHash('sha256');
  for (const record of records) {
    h.update(JSON.stringify({
      deterministic_key: record.item_id,
      source_type: record.source_type,
      company_as_mentioned: record.company_name,
      surrounding_context: record.raw_excerpt,
      sender_and_context: record.sender_and_context,
    }));
    h.update('\n');
  }
  return h.digest('hex');
}

interface InputHashManifest {
  input_hash: string;
  input_column_hash: string;
  input_hash_source: string;
  script_row_projection_hash: string;
  input_columns: string[];
}

async function inputHashManifest(inputPath: string, records: GoldRecord[]): Promise<InputHashManifest> {
  const scriptRowProjectionHash = inputHash(records);
  const inputColumns = [
    'deterministic_key',
    'source_type',
    'company_as_mentioned',
    'surrounding_context',
    'sender_and_context',
  ];
  const rebuildReportPath = inputPath.replace(/\.human-labeling\.rebuilt\.csv$/i, '.rebuild-report.json');
  if (rebuildReportPath !== inputPath) {
    try {
      const report = JSON.parse(await readFile(rebuildReportPath, 'utf8')) as {
        rebuilt_path?: string;
        rows?: number;
        rebuilt_input_hash?: string;
      };
      if (
        report.rebuilt_path === inputPath &&
        report.rows === records.length &&
        typeof report.rebuilt_input_hash === 'string' &&
        report.rebuilt_input_hash.length > 0
      ) {
        return {
          input_hash: report.rebuilt_input_hash,
          input_column_hash: report.rebuilt_input_hash,
          input_hash_source: rebuildReportPath,
          script_row_projection_hash: scriptRowProjectionHash,
          input_columns: inputColumns,
        };
      }
    } catch {
      // Fall back to the script-local projection hash when no rebuild report exists.
    }
  }
  return {
    input_hash: scriptRowProjectionHash,
    input_column_hash: scriptRowProjectionHash,
    input_hash_source: 'script_json_projection',
    script_row_projection_hash: scriptRowProjectionHash,
    input_columns: inputColumns,
  };
}

export function oldMentionTypeToAction(mentionType: string | null | undefined): NewProspectAction {
  switch (String(mentionType || '').trim()) {
    case 'inbound_prospect':
      return 'create_prospect';
    case 'known_deal':
      return 'attach_existing_deal';
    case 'intro_source':
      return 'record_context';
    case 'noise':
    case 'news':
    case 'web_analytics':
      return 'ignore';
    case 'classifier_error':
      return 'classifier_error';
    default:
      return 'unknown';
  }
}

function normalizeOldAnchorRow(row: OldAnchorPrediction): OldAnchorRow {
  const predictedMentionType = String(row.predicted_mention_type || '').trim();
  return {
    item_id: row.item_id,
    company_name: String(row.company_name || '').trim(),
    predicted_mention_type: predictedMentionType,
    old_anchor_action: oldMentionTypeToAction(predictedMentionType),
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    reasoning: row.reasoning || null,
  };
}

async function loadOldAnchorRows(path?: string): Promise<OldAnchorRow[]> {
  if (!path) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8')) as OldAnchorPrediction[] | { predictions?: OldAnchorPrediction[] };
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.predictions) ? parsed.predictions : [];
  return rows
    .filter(row => typeof row.item_id === 'string' && row.item_id.length > 0)
    .map(normalizeOldAnchorRow);
}

async function loadKnownContext(args: Args, env: Env): Promise<ProspectClassifierKnownContext> {
  if (!args.knownContextPath) return loadProspectClassifierKnownContext(args.orgId, env);
  const path = args.knownContextPath;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ProspectClassifierKnownContext>;
  return {
    knownDeals: Array.isArray(parsed.knownDeals) ? parsed.knownDeals : [],
    knownDealmakers: Array.isArray(parsed.knownDealmakers) ? parsed.knownDealmakers : [],
  };
}

function requireTokenedGateway(env: Env): Env {
  const token = String(env.CLOUDFLARE_AI_GATEWAY_TOKEN || process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '').trim();
  if (!token) {
    throw new Error('ZDR_GATEWAY_REQUIRED: CLOUDFLARE_AI_GATEWAY_TOKEN is missing; refusing non-ZDR universe run.');
  }
  if (!env.CLOUDFLARE_AI_GATEWAY_SLUG) {
    throw new Error('ZDR_GATEWAY_REQUIRED: CLOUDFLARE_AI_GATEWAY_SLUG is missing.');
  }
  return { ...(env as any), CLOUDFLARE_AI_GATEWAY_TOKEN: token } as Env;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|CLAUDE_RATE_LIMITED|429/i.test(message);
}

async function classifyUniverse(
  record: GoldRecord,
  universe: UniverseDefinition,
  knownContext: ProspectClassifierKnownContext,
  env: Env,
  args: Args
): Promise<UniversePrediction> {
  const sectorHint = __prospectIntelligenceTestHooks.sectorHintForText(`${record.company_name}\n${record.raw_excerpt}`);
  const input: ProspectClassifierInput = {
    sourceType: record.source_type,
    senderAndContext: record.sender_and_context,
    companyName: record.company_name,
    rawExcerpt: record.raw_excerpt,
    prefilterHints: prefilterHintsFor(record, sectorHint),
    sectorHints: sectorHint,
    knownContext,
    orgId: args.orgId,
    policyLens: universe,
    };
  const model = classifierModel(env);
  let rawModelOutput: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const prompt = __prospectIntelligenceTestHooks.buildProspectClassifierPrompt(input);
    let result: Awaited<ReturnType<typeof callClaudeWithUsage>> | null = null;
    for (let attempt = 1; attempt <= args.retryAttempts; attempt++) {
      try {
        result = await callClaudeWithUsage(
          { system: prompt.systemForApi, user: prompt.user, max_tokens: 700, orgId: args.orgId, model, assistantPrefill: '{', temperature: 0 },
          'low',
          env
        );
        break;
      } catch (error) {
        if (!isRateLimitError(error) || attempt >= args.retryAttempts) throw error;
        const backoffMs = Math.max(args.callDelayMs, 2_000 * attempt);
        process.stderr.write(`rate limited ${record.item_id} ${universe.id}; retry ${attempt + 1}/${args.retryAttempts} after ${backoffMs}ms\n`);
        await sleep(backoffMs);
      }
    }
    if (!result) throw new Error('CLASSIFIER_RETRY_EXHAUSTED');
    rawModelOutput = result.text;
    usage = result.usage;
    const parsed = __prospectIntelligenceTestHooks.parseProspectClassifierResponse(result.text, result.model, result.usage);
    const createProspectVeto = __prospectIntelligenceTestHooks.prospectCreateVetoForMention({
      prospectAction: parsed.prospectAction,
      companyName: record.company_name,
      rawMention: record.company_name,
      rawExcerpt: record.raw_excerpt,
      senderAndContext: record.sender_and_context,
      llmReasoning: parsed.reasoning,
    });
    const prospectAction = createProspectVeto.applied ? 'ignore' : parsed.prospectAction;
    const mentionType = createProspectVeto.applied ? 'noise' : parsed.mentionType;
    const confidence = createProspectVeto.applied ? (createProspectVeto.confidence || 0.97) : parsed.confidence;
    return {
      item_id: record.item_id,
      source_type: record.source_type,
      source_id: record.source_id,
      mention_ordinal: record.mention_ordinal,
      company_name: record.company_name,
      split: record.split,
      universe_id: universe.id,
      universe_name: universe.name,
      predicted_mention_type: mentionType,
      prospect_action: prospectAction,
      should_create_prospect: prospectAction === 'create_prospect',
      prospect_company_name: prospectAction === 'create_prospect' ? parsed.prospectCompanyName : null,
      predicted_direction: parsed.direction,
      predicted_sector_key: parsed.sectorKey,
      confidence,
      reasoning: parsed.reasoning,
      create_prospect_veto_applied: createProspectVeto.applied,
      create_prospect_veto_reason: createProspectVeto.reason,
      original_prospect_action: parsed.prospectAction,
      classifier_error: null,
      raw_model_output: rawModelOutput,
      usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
      cost_usd: costFor(usage, args),
    };
  } catch (error) {
    return {
      item_id: record.item_id,
      source_type: record.source_type,
      source_id: record.source_id,
      mention_ordinal: record.mention_ordinal,
      company_name: record.company_name,
      split: record.split,
      universe_id: universe.id,
      universe_name: universe.name,
      predicted_mention_type: 'classifier_error',
      prospect_action: 'classifier_error',
      should_create_prospect: null,
      prospect_company_name: null,
      predicted_direction: 'classifier_error',
      predicted_sector_key: 'classifier_error',
      confidence: 0,
      reasoning: null,
      classifier_error: error instanceof Error ? error.message : String(error),
      raw_model_output: rawModelOutput,
      usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
      cost_usd: costFor(usage, args),
    };
  }
}

function votes<T extends string | boolean | null>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function spread(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

function consensusFor(actions: string[]): ConsensusInfo {
  const actionVotes = votes(actions);
  const sorted = Object.entries(actionVotes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const consensusAction = sorted[0]?.[0] || null;
  const consensusCount = sorted[0]?.[1] || 0;
  const createCount = actionVotes.create_prospect || 0;
  let stability: ConsensusInfo['stability'];
  if (sorted.length <= 1) {
    stability = 'stable_3_3';
  } else if (sorted.length >= 3 || (createCount > 0 && createCount < actions.length)) {
    stability = 'high_fuzziness';
  } else {
    stability = 'somewhat_fuzzy_2_3';
  }
  return {
    consensus_action: consensusAction,
    consensus_count: consensusCount,
    stability,
  };
}

function universeActions(rows: UniversePrediction[]): Record<string, string> {
  return Object.fromEntries(rows.map(row => [row.universe_id, row.prospect_action]));
}

function riskRow(
  rows: UniversePrediction[],
  oldAnchor?: OldAnchorRow
): RiskRow {
  return {
    item_id: rows[0]?.item_id || oldAnchor?.item_id || '',
    company_name: rows[0]?.company_name || oldAnchor?.company_name || '',
    actions: universeActions(rows),
    old_anchor_action: oldAnchor?.old_anchor_action,
    old_predicted_mention_type: oldAnchor?.predicted_mention_type,
  };
}

export function summarizeUniverseDisagreement(
  predictions: UniversePrediction[],
  confidenceSpreadThreshold = 0.25
): UniverseRowDisagreement[] {
  const byRow = new Map<string, UniversePrediction[]>();
  for (const prediction of predictions) {
    const key = `${prediction.item_id}:${prediction.company_name}`;
    byRow.set(key, [...(byRow.get(key) || []), prediction]);
  }
  return [...byRow.values()].map(rows => {
    const shouldCreateVotes = votes(rows.map(row => row.should_create_prospect));
    const actionVotes = votes(rows.map(row => row.prospect_action));
    const mentionTypeVotes = votes(rows.map(row => row.predicted_mention_type));
    const confidenceSpread = spread(rows.map(row => row.confidence));
    const reasons: string[] = [];
    if (Object.keys(shouldCreateVotes).length > 1) reasons.push('should_create_prospect_disagreement');
    if (Object.keys(actionVotes).length > 1) reasons.push('prospect_action_disagreement');
    if (Object.keys(mentionTypeVotes).length > 1) reasons.push('mention_type_disagreement');
    if (confidenceSpread >= confidenceSpreadThreshold) reasons.push('confidence_spread');
    if (rows.some(row => row.classifier_error)) reasons.push('classifier_error');
    return {
      item_id: rows[0].item_id,
      company_name: rows[0].company_name,
      fuzzy: reasons.length > 0,
      reasons,
      should_create_votes: shouldCreateVotes,
      action_votes: actionVotes,
      mention_type_votes: mentionTypeVotes,
      confidence_spread: Number(confidenceSpread.toFixed(4)),
    };
  });
}

export function summarizeOldAnchorAlignment(
  predictions: UniversePrediction[],
  oldAnchorRows: OldAnchorPrediction[] | OldAnchorRow[],
  oldAnchorPath: string | null = null
): OldAnchorAlignmentSummary {
  const normalizedOldRows = oldAnchorRows.map(row =>
    'old_anchor_action' in row ? row as OldAnchorRow : normalizeOldAnchorRow(row as OldAnchorPrediction)
  );
  const oldById = new Map(normalizedOldRows.map(row => [row.item_id, row]));
  const predictionsById = new Map<string, UniversePrediction[]>();
  for (const prediction of predictions) {
    predictionsById.set(prediction.item_id, [...(predictionsById.get(prediction.item_id) || []), prediction]);
  }

  const stabilityCounts: Record<ConsensusInfo['stability'], number> = {
    stable_3_3: 0,
    somewhat_fuzzy_2_3: 0,
    high_fuzziness: 0,
  };
  const perActionVotes: Record<string, number> = {};
  const anyCreateRows: RiskRow[] = [];
  const onlyBroadCreateRows: RiskRow[] = [];
  const oldInboundAllIgnoreRows: RiskRow[] = [];
  const oldNoiseTwoPlusCreateRows: RiskRow[] = [];
  let oldAnchorMatches = 0;
  let oldAnchorComparisons = 0;
  let lucasMatches = 0;
  let lucasComparisons = 0;
  let matchedRows = 0;

  for (const [itemId, rows] of predictionsById) {
    const actions = rows.map(row => row.prospect_action);
    const actionVotes = votes(actions);
    const consensus = consensusFor(actions);
    stabilityCounts[consensus.stability] += 1;
    for (const [action, count] of Object.entries(actionVotes)) {
      perActionVotes[action] = (perActionVotes[action] || 0) + count;
    }
    const oldAnchor = oldById.get(itemId);
    if (oldAnchor) {
      matchedRows += 1;
      for (const action of actions) {
        oldAnchorComparisons += 1;
        if (action === oldAnchor.old_anchor_action) oldAnchorMatches += 1;
      }
      if (oldAnchor.predicted_mention_type === 'inbound_prospect' && actions.every(action => action === 'ignore')) {
        oldInboundAllIgnoreRows.push(riskRow(rows, oldAnchor));
      }
      if (oldAnchor.predicted_mention_type === 'noise' && (actionVotes.create_prospect || 0) >= 2) {
        oldNoiseTwoPlusCreateRows.push(riskRow(rows, oldAnchor));
      }
    }
    const lucas = LUCAS_ADJUDICATED_OLD_INBOUND_BY_ITEM_ID[itemId];
    if (lucas) {
      for (const action of actions) {
        lucasComparisons += 1;
        if (action === lucas.expected_action) lucasMatches += 1;
      }
    }
    if ((actionVotes.create_prospect || 0) > 0) anyCreateRows.push(riskRow(rows, oldAnchor));
    const broadCreate = rows.some(row => row.universe_id === 'broad-relationship-signal-capture' && row.prospect_action === 'create_prospect');
    const nonBroadCreate = rows.some(row => row.universe_id !== 'broad-relationship-signal-capture' && row.prospect_action === 'create_prospect');
    if (broadCreate && !nonBroadCreate) onlyBroadCreateRows.push(riskRow(rows, oldAnchor));
  }

  const oldInboundOverlay: OldInboundAnchorRow[] = normalizedOldRows
    .filter(row => row.predicted_mention_type === 'inbound_prospect')
    .map(oldAnchor => {
      const rows = predictionsById.get(oldAnchor.item_id) || [];
      const actions = rows.map(row => row.prospect_action);
      const consensus = consensusFor(actions);
      const lucas = LUCAS_ADJUDICATED_OLD_INBOUND_BY_ITEM_ID[oldAnchor.item_id] || null;
      return {
        item_id: oldAnchor.item_id,
        company_name: rows[0]?.company_name || oldAnchor.company_name,
        old_predicted_mention_type: oldAnchor.predicted_mention_type,
        old_anchor_action: oldAnchor.old_anchor_action,
        old_confidence: oldAnchor.confidence,
        lucas_expected_action: lucas?.expected_action || null,
        lucas_note: lucas?.note || null,
        universe_actions: universeActions(rows),
        consensus_action: consensus.consensus_action,
        consensus_count: consensus.consensus_count,
        stability: consensus.stability,
        old_anchor_match_count: actions.filter(action => action === oldAnchor.old_anchor_action).length,
        lucas_expected_match_count: lucas ? actions.filter(action => action === lucas.expected_action).length : null,
      };
    });

  return {
    old_anchor_path: oldAnchorPath,
    old_rows: normalizedOldRows.length,
    matched_rows: matchedRows,
    missing_new_rows: normalizedOldRows.length - matchedRows,
    old_inbound_rows: oldInboundOverlay.length,
    stability_counts: stabilityCounts,
    old_anchor_alignment: {
      matches: oldAnchorMatches,
      comparisons: oldAnchorComparisons,
      rate: oldAnchorComparisons ? oldAnchorMatches / oldAnchorComparisons : null,
    },
    lucas_adjusted_alignment: {
      matches: lucasMatches,
      comparisons: lucasComparisons,
      rate: lucasComparisons ? lucasMatches / lucasComparisons : null,
    },
    per_action_votes: perActionVotes,
    prospect_creation_risk: {
      any_create_prospect_rows: anyCreateRows,
      only_broad_create_prospect_rows: onlyBroadCreateRows,
      old_inbound_all_ignore_rows: oldInboundAllIgnoreRows,
      old_noise_two_plus_create_prospect_rows: oldNoiseTwoPlusCreateRows,
    },
    old_inbound_overlay: oldInboundOverlay,
  };
}

function formatRate(rate: number | null): string {
  return rate == null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function formatActions(actions: Record<string, string>): string {
  return PROSPECT_CLASSIFIER_UNIVERSES
    .map(universe => `${universe.id}: ${actions[universe.id] || 'missing'}`)
    .join('<br>');
}

function riskRowsTable(rows: RiskRow[], limit = 40): string[] {
  return rows.slice(0, limit).map(row =>
    `| ${row.company_name.replace(/\|/g, '\\|')} | ${row.item_id} | ${formatActions(row.actions)} | ${row.old_predicted_mention_type || ''} | ${row.old_anchor_action || ''} |`
  );
}

function markdownReport(
  args: Args,
  manifest: Record<string, unknown>,
  disagreements: UniverseRowDisagreement[],
  predictions: UniversePrediction[],
  anchorSummary: OldAnchorAlignmentSummary
): string {
  const fuzzy = disagreements.filter(row => row.fuzzy);
  const usage = predictions.reduce(
    (acc, row) => ({
      input_tokens: acc.input_tokens + row.usage.input_tokens,
      output_tokens: acc.output_tokens + row.usage.output_tokens,
      total_tokens: acc.total_tokens + row.usage.total_tokens,
      cost_usd: acc.cost_usd + (row.cost_usd || 0),
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }
  );
  const topFuzzy = fuzzy.slice(0, 40).map(row =>
    `| ${row.company_name.replace(/\|/g, '\\|')} | ${row.reasons.join(', ')} | ${JSON.stringify(row.should_create_votes)} | ${JSON.stringify(row.action_votes)} |`
  );
  const oldInboundRows = anchorSummary.old_inbound_overlay.map(row =>
    `| ${row.company_name.replace(/\|/g, '\\|')} | ${row.item_id} | ${row.lucas_expected_action || ''} | ${formatActions(row.universe_actions)} | ${row.consensus_action || ''} (${row.consensus_count}/3) | ${row.lucas_expected_match_count ?? 'n/a'}/3 | ${row.old_anchor_match_count}/3 |`
  );
  const risk = anchorSummary.prospect_creation_risk;
  return [
    '# Prospect Classifier Universe Spike',
    '',
    'This is a quarantined self-disagreement run. It measures stability, anchor agreement, and prospect-creation risk, not certified human-label accuracy.',
    '',
    '## Manifest',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
    '## Summary',
    '',
    `- Rows: ${manifest.rows}`,
    `- Universe calls: ${predictions.length}`,
    `- Fuzzy rows: ${fuzzy.length}`,
    `- Stability: ${anchorSummary.stability_counts.stable_3_3} stable 3/3, ${anchorSummary.stability_counts.somewhat_fuzzy_2_3} somewhat fuzzy 2/3, ${anchorSummary.stability_counts.high_fuzziness} high fuzziness`,
    `- Classifier errors: ${predictions.filter(row => row.classifier_error).length}`,
    `- Tokens: ${usage.total_tokens} total (${usage.input_tokens} input, ${usage.output_tokens} output)`,
    `- Estimated cost: ${args.inputUsdPerMillion != null && args.outputUsdPerMillion != null ? `$${usage.cost_usd.toFixed(6)}` : 'not computed'}`,
    `- Estimated cost per source row: ${args.inputUsdPerMillion != null && args.outputUsdPerMillion != null ? `$${(usage.cost_usd / Number(manifest.rows || 1)).toFixed(6)}` : 'not computed'}`,
    `- Estimated cost per model call: ${args.inputUsdPerMillion != null && args.outputUsdPerMillion != null ? `$${(usage.cost_usd / Math.max(predictions.length, 1)).toFixed(6)}` : 'not computed'}`,
    '',
    '## Old Anchor Alignment',
    '',
    `- Old anchor rows loaded: ${anchorSummary.old_rows}`,
    `- Matched to new run: ${anchorSummary.matched_rows}`,
    `- Old-anchor action agreement: ${formatRate(anchorSummary.old_anchor_alignment.rate)} (${anchorSummary.old_anchor_alignment.matches}/${anchorSummary.old_anchor_alignment.comparisons})`,
    `- Lucas-adjusted disputed-row agreement: ${formatRate(anchorSummary.lucas_adjusted_alignment.rate)} (${anchorSummary.lucas_adjusted_alignment.matches}/${anchorSummary.lucas_adjusted_alignment.comparisons})`,
    `- Per-action votes: ${JSON.stringify(anchorSummary.per_action_votes)}`,
    '',
    '## Old Inbound Overlay',
    '',
    '| Company | Item | Lucas expected action | New universe actions | New consensus | Lucas agreement | Old-anchor agreement |',
    '|---|---|---|---|---:|---:|---:|',
    ...(oldInboundRows.length ? oldInboundRows : ['| (none) |  |  |  |  |  |  |']),
    '',
    '## Prospect Creation Risk',
    '',
    `- Rows where any universe says create_prospect: ${risk.any_create_prospect_rows.length}`,
    `- Rows where only the broad universe says create_prospect: ${risk.only_broad_create_prospect_rows.length}`,
    `- Rows where old said inbound but all new universes say ignore: ${risk.old_inbound_all_ignore_rows.length}`,
    `- Rows where old said noise but at least two new universes say create_prospect: ${risk.old_noise_two_plus_create_prospect_rows.length}`,
    '',
    '### Any Create Prospect Rows',
    '',
    '| Company | Item | New universe actions | Old mention | Old action |',
    '|---|---|---|---|---|',
    ...(riskRowsTable(risk.any_create_prospect_rows).length ? riskRowsTable(risk.any_create_prospect_rows) : ['| (none) |  |  |  |  |']),
    '',
    '### Only Broad Create Prospect Rows',
    '',
    '| Company | Item | New universe actions | Old mention | Old action |',
    '|---|---|---|---|---|',
    ...(riskRowsTable(risk.only_broad_create_prospect_rows).length ? riskRowsTable(risk.only_broad_create_prospect_rows) : ['| (none) |  |  |  |  |']),
    '',
    '## Top Fuzzy Rows',
    '',
    '| Company | Reasons | should_create votes | action votes |',
    '|---|---|---:|---:|',
    ...(topFuzzy.length ? topFuzzy : ['| (none) |  |  |  |']),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const env = requireTokenedGateway(proxy.env as unknown as Env);
    const knownContext = await loadKnownContext(args, env);
    const oldAnchorRows = await loadOldAnchorRows(args.oldAnchorPath);
    const allRecords = parseGoldRecords(await readFile(args.inputPath, 'utf8'), args.inputPath);
    const records = allRecords.filter(record => args.split === 'all' || record.split === args.split);
    if (records.length === 0) throw new Error(`NO_RECORDS_FOR_SPLIT:${args.split}`);

    const predictions: UniversePrediction[] = [];
    for (const record of records) {
      const rowPredictions: UniversePrediction[] = [];
      for (const universe of PROSPECT_CLASSIFIER_UNIVERSES) {
        rowPredictions.push(await classifyUniverse(record, universe, knownContext, env, args));
        if (args.callDelayMs > 0) await sleep(args.callDelayMs);
      }
      predictions.push(...rowPredictions);
      process.stderr.write(`classified ${record.item_id} across ${PROSPECT_CLASSIFIER_UNIVERSES.length} universes\n`);
    }

    const disagreements = summarizeUniverseDisagreement(predictions, args.confidenceSpreadThreshold);
    const anchorSummary = summarizeOldAnchorAlignment(predictions, oldAnchorRows, args.oldAnchorPath || null);
    const inputHashInfo = await inputHashManifest(args.inputPath, records);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(args.outputDir, { recursive: true });
    const rawPath = join(args.outputDir, `prospect-universe-raw-${timestamp}.jsonl`);
    const summaryPath = join(args.outputDir, `prospect-universe-summary-${timestamp}.json`);
    const reportPath = join(args.outputDir, `prospect-universe-report-${timestamp}.md`);
    const manifest = {
      generated_at: new Date().toISOString(),
      input_path: args.inputPath,
      input_hash: inputHashInfo.input_hash,
      input_column_hash: inputHashInfo.input_column_hash,
      input_hash_source: inputHashInfo.input_hash_source,
      script_row_projection_hash: inputHashInfo.script_row_projection_hash,
      input_columns: inputHashInfo.input_columns,
      classifier_version: PROSPECT_CLASSIFIER_VERSION,
      model: classifierModel(env),
      temperature: 0,
      gateway_path: 'cloudflare_ai_gateway_provider_native_tokened_zdr_required',
      old_anchor_path: args.oldAnchorPath || null,
      old_anchor_rows: oldAnchorRows.length,
      split: args.split,
      rows: records.length,
      universes: PROSPECT_CLASSIFIER_UNIVERSES.map(({ id, name, risk_posture }) => ({ id, name, risk_posture })),
      confidence_spread_threshold: args.confidenceSpreadThreshold,
      call_delay_ms: args.callDelayMs,
      retry_attempts: args.retryAttempts,
    };
    const summary = { manifest, disagreements, anchorSummary, predictions };
    await writeFile(rawPath, predictions.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(reportPath, markdownReport(args, manifest, disagreements, predictions, anchorSummary), 'utf8');
    process.stdout.write(`${JSON.stringify({
      manifest,
      artifacts: { rawPath, summaryPath, reportPath },
      fuzzy_rows: disagreements.filter(row => row.fuzzy).length,
      stability_counts: anchorSummary.stability_counts,
      old_anchor_alignment: anchorSummary.old_anchor_alignment,
      lucas_adjusted_alignment: anchorSummary.lucas_adjusted_alignment,
      prospect_creation_risk_counts: {
        any_create_prospect_rows: anchorSummary.prospect_creation_risk.any_create_prospect_rows.length,
        only_broad_create_prospect_rows: anchorSummary.prospect_creation_risk.only_broad_create_prospect_rows.length,
        old_inbound_all_ignore_rows: anchorSummary.prospect_creation_risk.old_inbound_all_ignore_rows.length,
        old_noise_two_plus_create_prospect_rows: anchorSummary.prospect_creation_risk.old_noise_two_plus_create_prospect_rows.length,
      },
    }, null, 2)}\n`);
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

#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import type {
  ProspectDetectionStats,
  ProspectDryRunDecision,
  ProspectDryRunDuplicate,
} from '../src/lib/prospect-intelligence';

interface Args {
  shardsDir: string;
  outputDir: string;
  shardCount: number;
}

interface ShardManifest {
  dry_run: true;
  status: string;
  org_id: string;
  database: string | null;
  input_hydrated_items: string;
  input_context_snapshot: string;
  input_previous_manifest: string;
  hydrated_items_sha256: string;
  context_snapshot_sha256: string;
  previous_manifest_sha256: string;
  window_start: string | null;
  window_end: string | null;
  source_families: string[];
  source_count: number;
  hydratable_sources: number;
  selected_items: number;
  offset: number;
  max_items: number | null;
  batch_size: number;
  batches_total: number;
  batches_completed: number;
  prompt_prewarm_requested: boolean;
  rows_written: number;
  changed_db: boolean;
  d1_snapshot_meta: {
    query_count: number;
    rows_read: number;
    rows_written: number;
    changed_db: boolean;
    unsupported_query_count: number;
    unsupported_queries: Array<{ sql: string; binds: unknown[] }>;
  };
  classifier: {
    stats: ProspectDetectionStats;
    decision_counts: Record<string, number>;
    raw_decision_count: number;
    duplicate_count: number;
    errors: Array<{ item_id: string; error: string }>;
  };
  prior_run: {
    decision_counts: Record<string, number>;
    raw_decision_count: number;
    rows_written: number;
    changed_db: boolean;
  };
  git: {
    head: string | null;
    status_short: string;
  };
  started_at: string;
  completed_at: string | null;
  artifacts: Record<string, string>;
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
  const shardsDir = resolve(raw.get('shards-dir') || raw.get('input-dir') || '');
  if (!shardsDir || shardsDir === process.cwd()) throw new Error('MISSING_SHARDS_DIR');
  const outputDir = resolve(raw.get('output-dir') || shardsDir);
  const shardCount = Number(raw.get('shard-count') || 24);
  if (!Number.isFinite(shardCount) || shardCount < 1 || shardCount > 256) throw new Error('INVALID_SHARD_COUNT');
  return { shardsDir, outputDir, shardCount: Math.floor(shardCount) };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T);
}

function emptyLlmStageUsage() {
  return {
    cache_hits: 0,
    cache_misses: 0,
    paid_calls: 0,
    paid_calls_saved: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function emptyStats(): ProspectDetectionStats {
  return {
    items_scanned: 0,
    mentions_seen: 0,
    signals_recorded: 0,
    prospects_upserted: 0,
    classifications_pending: 0,
    classifier_cache_hits: 0,
    classifier_cache_misses: 0,
    classifier_paid_calls: 0,
    classifier_paid_calls_saved: 0,
    llm_stage_usage: {},
    prefilter_dropped: 0,
    production_samples_recorded: 0,
    known_deals_attached: 0,
    record_context_skipped: 0,
    ignored_or_noise_skipped: 0,
    skipped_known_deal: 0,
    skipped_intro_source: 0,
    skipped_news: 0,
    skipped_noise: 0,
    skipped_web_analytics: 0,
    final_quality_gate_reviewed: 0,
    final_quality_gate_allowed: 0,
    final_quality_gate_renamed: 0,
    final_quality_gate_merged: 0,
    final_quality_gate_blocked: 0,
    final_quality_gate_batches: 0,
    final_quality_gate_cache_hits: 0,
    final_quality_gate_failed_open: 0,
    final_quality_gate_fallback_used: 0,
    final_quality_gate_merge_resolved: 0,
    final_quality_gate_merge_unresolved: 0,
    errors: [],
  };
}

function mergeStats(target: ProspectDetectionStats, next: ProspectDetectionStats): void {
  target.items_scanned += next.items_scanned;
  target.mentions_seen += next.mentions_seen;
  target.signals_recorded += next.signals_recorded;
  target.prospects_upserted += next.prospects_upserted;
  target.classifications_pending += next.classifications_pending;
  target.classifier_cache_hits += next.classifier_cache_hits;
  target.classifier_cache_misses += next.classifier_cache_misses;
  target.classifier_paid_calls += next.classifier_paid_calls;
  target.classifier_paid_calls_saved += next.classifier_paid_calls_saved;
  target.prefilter_dropped += next.prefilter_dropped;
  target.production_samples_recorded += next.production_samples_recorded;
  target.known_deals_attached += next.known_deals_attached;
  target.record_context_skipped += next.record_context_skipped;
  target.ignored_or_noise_skipped += next.ignored_or_noise_skipped;
  target.skipped_known_deal += next.skipped_known_deal;
  target.skipped_intro_source += next.skipped_intro_source;
  target.skipped_news += next.skipped_news;
  target.skipped_noise += next.skipped_noise;
  target.skipped_web_analytics += next.skipped_web_analytics;
  target.final_quality_gate_reviewed += next.final_quality_gate_reviewed || 0;
  target.final_quality_gate_allowed += next.final_quality_gate_allowed || 0;
  target.final_quality_gate_renamed += next.final_quality_gate_renamed || 0;
  target.final_quality_gate_merged += next.final_quality_gate_merged || 0;
  target.final_quality_gate_blocked += next.final_quality_gate_blocked || 0;
  target.final_quality_gate_batches += next.final_quality_gate_batches || 0;
  target.final_quality_gate_cache_hits += next.final_quality_gate_cache_hits || 0;
  target.final_quality_gate_failed_open += next.final_quality_gate_failed_open || 0;
  target.final_quality_gate_fallback_used += next.final_quality_gate_fallback_used || 0;
  target.final_quality_gate_merge_resolved += next.final_quality_gate_merge_resolved || 0;
  target.final_quality_gate_merge_unresolved += next.final_quality_gate_merge_unresolved || 0;
  target.errors.push(...next.errors);
  for (const [stage, usage] of Object.entries(next.llm_stage_usage || {})) {
    const current = target.llm_stage_usage[stage] || emptyLlmStageUsage();
    current.cache_hits += usage.cache_hits;
    current.cache_misses += usage.cache_misses;
    current.paid_calls += usage.paid_calls;
    current.paid_calls_saved += usage.paid_calls_saved;
    current.input_tokens += usage.input_tokens;
    current.output_tokens += usage.output_tokens;
    current.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    current.cache_read_input_tokens += usage.cache_read_input_tokens;
    target.llm_stage_usage[stage] = current;
  }
}

function mergeCounts(target: Record<string, number>, next: Record<string, number>): void {
  for (const [key, value] of Object.entries(next)) target[key] = (target[key] || 0) + Number(value || 0);
}

function computeDuplicates(decisions: ProspectDryRunDecision[]): ProspectDryRunDuplicate[] {
  const grouped = new Map<string, ProspectDryRunDecision[]>();
  for (const decision of decisions) {
    if (!decision.duplicate_key) continue;
    const rows = grouped.get(decision.duplicate_key) || [];
    rows.push(decision);
    grouped.set(decision.duplicate_key, rows);
  }
  return Array.from(grouped.entries())
    .filter(([, rows]) => rows.length > 1)
    .map(([duplicate_key, rows]) => ({
      duplicate_key,
      count: rows.length,
      item_ids: rows.map(row => row.item_id),
      company_name: rows[0]?.company_name || '',
    }))
    .sort((a, b) => b.count - a.count || a.duplicate_key.localeCompare(b.duplicate_key));
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function decisionCsvLine(row: ProspectDryRunDecision): string {
  return [
    row.source_type,
    row.source_id,
    row.occurred_at,
    row.mention_ordinal,
    row.company_name,
    row.normalized_company_name,
    row.prospect_action,
    row.mention_type,
    row.should_create_prospect,
    row.prospect_company_name,
    row.direction,
    row.confidence,
    row.sector_key,
    row.possible_company_id,
    row.possible_deal_id,
    row.linked_deal_id,
    row.provisional,
    row.reasoning,
    row.error,
    row.source_title,
    row.original_llm_is_prospect,
    row.original_llm_prospect_action,
    row.create_prospect_veto_reason,
    row.valuable_action_veto_reason,
    row.finalization_blocked,
    row.finalization_block_reasons,
    row.has_create_evidence,
    row.reasoning_judge_action,
    row.reasoning_judge_valid,
    row.reasoning_judge_reason,
    row.reasoning_judge_blocked_company,
    row.target_evidence_reasons,
    row.corrected_prospect_company_name,
    row.second_look_required,
    row.second_look_lane,
    row.second_look_recommended_action,
    row.second_look_reasons,
    row.second_look_warnings,
    row.second_look_evidence,
    row.second_look_create_blocked,
    row.second_look_block_reason,
    row.final_quality_decision,
    row.final_quality_canonical_name,
    row.final_quality_merge_target,
    row.final_quality_reason,
    row.final_quality_blocked,
    row.final_quality_renamed,
    row.final_quality_merged,
    row.final_quality_batch_id,
    row.final_quality_failed_open,
    row.final_quality_fallback_used,
    row.final_quality_parse_failed,
    row.final_quality_retry_used,
    row.final_quality_fallback_basis,
    row.final_quality_target_proof,
    row.final_quality_hard_block_reason,
    row.final_quality_batch_size,
    row.final_quality_attach_only,
    row.final_quality_merge_resolved,
    row.final_quality_existing_prospect_id,
    row.final_quality_duplicate_group_id,
    row.final_quality_record_key,
  ].map(csvEscape).join(',');
}

function renderReport(summary: any): string {
  const stageRows = Object.entries(summary.classifier.stats.llm_stage_usage || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, raw]) => {
      const usage = raw as ReturnType<typeof emptyLlmStageUsage>;
      return `| ${stage} | ${usage.paid_calls} | ${usage.cache_hits} | ${usage.cache_misses} | ${usage.input_tokens} | ${usage.output_tokens} | ${usage.cache_creation_input_tokens} | ${usage.cache_read_input_tokens} |`;
    });
  const counts = summary.classifier.decision_counts;
  return [
    '# Prospect 30-Day Hydrated Baseline',
    '',
    `- Status: ${summary.status}`,
    `- Shards completed: ${summary.shards_completed}/${summary.shard_count}`,
    `- Dry run: ${summary.dry_run}`,
    `- Window: ${summary.window_start || '(unknown)'} to ${summary.window_end || '(unknown)'}`,
    `- Frozen hydrated sources: ${summary.hydratable_sources}`,
    `- Selected items: ${summary.selected_items}`,
    `- Rows written: ${summary.rows_written}`,
    `- Changed DB: ${summary.changed_db}`,
    `- Snapshot D1 unsupported reads: ${summary.d1_snapshot_meta.unsupported_query_count}`,
    '',
    '## Classifier Decisions',
    '',
    `- would_create: ${counts.create_prospect || 0}`,
    `- would_record_context: ${counts.record_context || 0}`,
    `- would_ignore: ${counts.ignore || 0}`,
    `- classifier_error: ${counts.classifier_error || 0}`,
    `- raw decisions: ${summary.classifier.raw_decision_count}`,
    `- duplicate keys: ${summary.classifier.duplicate_count}`,
    '',
    '## LLM Stage Usage',
    '',
    '| Stage | Paid Calls | Cache Hits | Cache Misses | Input Tokens | Output Tokens | Cache Create Tokens | Cache Read Tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(stageRows.length ? stageRows : ['| (none) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |']),
    '',
    '## Read-Only Proof',
    '',
    'All shards consumed frozen hydrated evidence and a read-only D1 context snapshot. Every shard reported rows_written=0 and changed_db=false.',
    '',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outputDir, { recursive: true });

  const manifests: ShardManifest[] = [];
  for (let i = 0; i < args.shardCount; i++) {
    const shardName = `shard-${String(i).padStart(2, '0')}`;
    const manifestPath = join(args.shardsDir, shardName, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`MISSING_SHARD_MANIFEST:${manifestPath}`);
    const manifest = readJson<ShardManifest>(manifestPath);
    if (manifest.status !== 'completed') throw new Error(`INCOMPLETE_SHARD:${shardName}:${manifest.status}`);
    if (manifest.rows_written !== 0 || manifest.changed_db) throw new Error(`SHARD_WRITE_VIOLATION:${shardName}`);
    manifests.push(manifest);
  }

  const [first] = manifests;
  const stats = emptyStats();
  const decisionCounts: Record<string, number> = {};
  const decisions: ProspectDryRunDecision[] = [];
  const shardSummaries: any[] = [];
  let rowsRead = 0;
  let queryCount = 0;
  const unsupportedQueries: Array<{ shard: number; sql: string; binds: unknown[] }> = [];

  manifests.forEach((manifest, index) => {
    if (manifest.hydrated_items_sha256 !== first.hydrated_items_sha256) throw new Error(`SHARD_INPUT_HASH_MISMATCH:${index}`);
    if (manifest.context_snapshot_sha256 !== first.context_snapshot_sha256) throw new Error(`SHARD_CONTEXT_HASH_MISMATCH:${index}`);
    mergeStats(stats, manifest.classifier.stats);
    mergeCounts(decisionCounts, manifest.classifier.decision_counts);
    rowsRead += manifest.d1_snapshot_meta.rows_read;
    queryCount += manifest.d1_snapshot_meta.query_count;
    for (const query of manifest.d1_snapshot_meta.unsupported_queries || []) unsupportedQueries.push({ shard: index, ...query });
    const shardDecisions = readJsonl<ProspectDryRunDecision>(join(args.shardsDir, `shard-${String(index).padStart(2, '0')}`, 'dry-run-decisions.jsonl'));
    if (shardDecisions.length !== manifest.classifier.raw_decision_count) {
      throw new Error(`SHARD_DECISION_COUNT_MISMATCH:${index}:${shardDecisions.length}:${manifest.classifier.raw_decision_count}`);
    }
    decisions.push(...shardDecisions);
    shardSummaries.push({
      shard: index,
      offset: manifest.offset,
      max_items: manifest.max_items,
      selected_items: manifest.selected_items,
      raw_decision_count: manifest.classifier.raw_decision_count,
      decision_counts: manifest.classifier.decision_counts,
      batches_completed: manifest.batches_completed,
      batches_total: manifest.batches_total,
      started_at: manifest.started_at,
      completed_at: manifest.completed_at,
    });
  });

  const selectedItems = manifests.reduce((sum, manifest) => sum + manifest.selected_items, 0);
  const duplicates = computeDuplicates(decisions);
  const summary = {
    dry_run: true,
    run_kind: 'prospect_hydrated_eval_sharded',
    status: 'completed',
    shard_count: args.shardCount,
    shards_completed: manifests.length,
    org_id: first.org_id,
    database: first.database,
    input_hydrated_items: first.input_hydrated_items,
    input_context_snapshot: first.input_context_snapshot,
    input_previous_manifest: first.input_previous_manifest,
    hydrated_items_sha256: first.hydrated_items_sha256,
    context_snapshot_sha256: first.context_snapshot_sha256,
    previous_manifest_sha256: first.previous_manifest_sha256,
    output_dir: args.outputDir,
    window_start: first.window_start,
    window_end: first.window_end,
    source_families: first.source_families,
    source_count: first.source_count,
    hydratable_sources: first.hydratable_sources,
    selected_items: selectedItems,
    rows_written: 0,
    changed_db: false,
    d1_snapshot_meta: {
      query_count: queryCount,
      rows_read: rowsRead,
      rows_written: 0,
      changed_db: false,
      unsupported_query_count: unsupportedQueries.length,
      unsupported_queries: unsupportedQueries.slice(0, 50),
    },
    classifier: {
      stats,
      decision_counts: decisionCounts,
      raw_decision_count: decisions.length,
      duplicate_count: duplicates.length,
      errors: stats.errors,
    },
    prior_run: first.prior_run,
    git: first.git,
    started_at: manifests.map(m => m.started_at).sort()[0] || null,
    completed_at: new Date().toISOString(),
    shards: shardSummaries,
    artifacts: {
      manifest: join(args.outputDir, 'manifest.json'),
      report: join(args.outputDir, 'report.md'),
      decisions: join(args.outputDir, 'dry-run-decisions.jsonl'),
      rawSignals: join(args.outputDir, 'raw-source-signal-results.csv'),
      duplicates: join(args.outputDir, 'duplicates.json'),
      errors: join(args.outputDir, 'classifier-errors.json'),
      unsupportedQueries: join(args.outputDir, 'unsupported-d1-snapshot-queries.json'),
      shardSummary: join(args.outputDir, 'shard-summary.json'),
    },
  };

  writeFileSync(summary.artifacts.decisions, decisions.map(row => `${JSON.stringify(row)}\n`).join(''));
  writeFileSync(summary.artifacts.rawSignals, [
    'source_type,source_id,occurred_at,mention_ordinal,company_name,normalized_company_name,prospect_action,mention_type,should_create_prospect,prospect_company_name,direction,confidence,sector_key,possible_company_id,possible_deal_id,linked_deal_id,provisional,reasoning,error,source_title,original_llm_is_prospect,original_llm_prospect_action,create_prospect_veto_reason,valuable_action_veto_reason,finalization_blocked,finalization_block_reasons,has_create_evidence,reasoning_judge_action,reasoning_judge_valid,reasoning_judge_reason,reasoning_judge_blocked_company,target_evidence_reasons,corrected_prospect_company_name,second_look_required,second_look_lane,second_look_recommended_action,second_look_reasons,second_look_warnings,second_look_evidence,second_look_create_blocked,second_look_block_reason,final_quality_decision,final_quality_canonical_name,final_quality_merge_target,final_quality_reason,final_quality_blocked,final_quality_renamed,final_quality_merged,final_quality_batch_id,final_quality_failed_open,final_quality_fallback_used,final_quality_parse_failed,final_quality_retry_used,final_quality_fallback_basis,final_quality_target_proof,final_quality_hard_block_reason,final_quality_batch_size,final_quality_attach_only,final_quality_merge_resolved,final_quality_existing_prospect_id,final_quality_duplicate_group_id,final_quality_record_key',
    ...decisions.map(decisionCsvLine),
  ].join('\n') + '\n');
  writeFileSync(summary.artifacts.duplicates, `${JSON.stringify(duplicates, null, 2)}\n`);
  writeFileSync(summary.artifacts.errors, `${JSON.stringify(stats.errors, null, 2)}\n`);
  writeFileSync(summary.artifacts.unsupportedQueries, `${JSON.stringify(unsupportedQueries, null, 2)}\n`);
  writeFileSync(summary.artifacts.shardSummary, `${JSON.stringify(shardSummaries, null, 2)}\n`);
  writeFileSync(summary.artifacts.manifest, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(summary.artifacts.report, renderReport(summary));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();

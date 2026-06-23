import {
  resolveCrmEntityNameWithEvidence,
  type CrmNameResolutionResult,
  type CrmNameEvidenceBundle,
} from './lib/crm-name-resolver';
import type { CrmEntityType } from './lib/crm-quality-gate';
import type { Env as BaseEnv } from './types/env';

type CanaryMode = 'first_time' | 'all_evidence';

interface Env extends Partial<BaseEnv> {
  D1: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  CANARY_QUEUE: Queue<CanaryShardMessage>;
  CANARY_TOKEN?: string;
}

interface CanarySourceRow {
  sample_index: number;
  entity_type: CrmEntityType;
  entity_id: string;
  org_id: string;
  source_snapshot_name_for_review: string;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  mode: CanaryMode;
}

interface CanaryShardMessage {
  run_id: string;
  shard: number;
  shard_count: number;
  rows: CanarySourceRow[];
  created_at: string;
}

interface CanaryResultRow {
  run_id: string;
  shard: number;
  sample_index: number;
  entity_type: CrmEntityType;
  entity_id: string;
  org_id: string;
  mode: CanaryMode;
  source_snapshot_name_for_review: string;
  email: string;
  domain: string;
  website: string;
  company_name: string;
  produced_name: string;
  produced_name_status: string;
  ui_tag_if_created: string;
  confidence: string;
  resolver_reason: string;
  accepted_evidence_summary: string;
  accepted_semantic_class: string;
  accepted_risk_flags: string;
  accepted_verification_decision: string;
  accepted_verification_block_reason: string;
  accepted_status_before_firewall: string;
  accepted_status_after_firewall: string;
  semantic_class: string;
  risk_flags: string;
  verification_decision: string;
  firewall_block_reason: string;
  status_before_firewall: string;
  status_after_firewall: string;
  evidence_candidate_count: number;
  evidence_source_types: string;
  network_calls: number;
  evidence_network_calls: number;
  evidence_cache_hits: number;
  runtime_source_channel: string;
  runtime_codepath: string;
  runtime_source_fields_used: string;
  runtime_metadata_fetched_live: boolean;
  production_rows_written: 0;
  gold_used_at_runtime: false;
  reviewer_grade_pass_fail: string;
  reviewer_correct_name_if_fail: string;
  reviewer_notes: string;
}

const ARTIFACT_PREFIX = 'crm-quality-cloud-canary';
const ROW_TIMEOUT_MS = 20_000;
const MAX_CANARY_ROWS = 5_000;
const MAX_ROWS_PER_QUEUE_MESSAGE = 5;

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function authOk(request: Request, env: Env): boolean {
  const expected = clean(env.CANARY_TOKEN);
  if (!expected) return false;
  const url = new URL(request.url);
  return request.headers.get('x-canary-token') === expected || url.searchParams.get('token') === expected;
}

function shardKey(runId: string, shard: number): string {
  return `${ARTIFACT_PREFIX}/${runId}/shard-${String(shard).padStart(2, '0')}.json`;
}

function cleanReviewKey(runId: string): string {
  return `${ARTIFACT_PREFIX}/${runId}/clean-review.csv`;
}

function summaryKey(runId: string): string {
  return `${ARTIFACT_PREFIX}/${runId}/summary.json`;
}

function kvMetaKey(runId: string): string {
  return `crm_canary:${runId}:meta`;
}

function kvShardKey(runId: string, shard: number): string {
  return `crm_canary:${runId}:shard:${shard}`;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: CanaryResultRow[]): string {
  const headers = [
    'run_id',
    'shard',
    'sample_index',
    'entity_type',
    'entity_id',
    'org_id',
    'mode',
    'source_snapshot_name_for_review',
    'email',
    'domain',
    'website',
    'company_name',
    'produced_name',
    'produced_name_status',
    'ui_tag_if_created',
    'confidence',
    'resolver_reason',
    'accepted_evidence_summary',
    'accepted_semantic_class',
    'accepted_risk_flags',
    'accepted_verification_decision',
    'accepted_verification_block_reason',
    'accepted_status_before_firewall',
    'accepted_status_after_firewall',
    'semantic_class',
    'risk_flags',
    'verification_decision',
    'firewall_block_reason',
    'status_before_firewall',
    'status_after_firewall',
    'evidence_candidate_count',
    'evidence_source_types',
    'network_calls',
    'evidence_network_calls',
    'evidence_cache_hits',
    'runtime_source_channel',
    'runtime_codepath',
    'runtime_source_fields_used',
    'runtime_metadata_fetched_live',
    'production_rows_written',
    'gold_used_at_runtime',
    'reviewer_grade_pass_fail',
    'reviewer_correct_name_if_fail',
    'reviewer_notes',
  ] as const;
  return [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n') + '\n';
}

function selectedCandidates(resolution: CrmNameResolutionResult) {
  return resolution.candidates.filter(candidate => candidate.accepted);
}

function producedStatus(resolution: CrmNameResolutionResult): string {
  if (resolution.status === 'verified') return 'verified';
  if (resolution.status === 'provisional') return 'provisional';
  if (resolution.status === 'domain_placeholder') return 'domain_placeholder';
  return 'none';
}

function uiTag(status: string): string {
  return status === 'provisional' || status === 'domain_placeholder' ? 'Tentative name' : '';
}

function sourceFields(row: CanarySourceRow): string {
  return [
    row.source_snapshot_name_for_review ? 'source_snapshot_name' : '',
    row.email ? 'email' : '',
    row.domain ? 'domain' : '',
    row.website ? 'website' : '',
    row.company_name ? 'company_name' : '',
    row.mode === 'all_evidence' ? 'entity_id' : '',
    row.mode === 'all_evidence' ? 'org_id' : '',
  ].filter(Boolean).join('; ');
}

function timeoutResult(row: CanarySourceRow, shard: number, runId: string): CanaryResultRow {
  const rawName = clean(row.source_snapshot_name_for_review);
  const isContact = row.entity_type === 'contact';
  const runtimeSourceChannel = isContact ? 'cloud_canary_contact' : 'cloud_canary_company';
  const runtimeCodepath = row.mode === 'first_time'
    ? `cloud_canary_${row.entity_type}_first_time_resolver`
    : `cloud_canary_${row.entity_type}_all_evidence_resolver`;
  return {
    run_id: runId,
    shard,
    sample_index: row.sample_index,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    org_id: row.org_id,
    mode: row.mode,
    source_snapshot_name_for_review: rawName,
    email: clean(row.email),
    domain: clean(row.domain || row.company_domain),
    website: clean(row.website),
    company_name: clean(row.company_name),
    produced_name: rawName,
    produced_name_status: 'timeout',
    ui_tag_if_created: 'Tentative name',
    confidence: 'low',
    resolver_reason: `row_timeout_after_${ROW_TIMEOUT_MS}ms`,
    accepted_evidence_summary: '',
    accepted_semantic_class: '',
    accepted_risk_flags: '',
    accepted_verification_decision: '',
    accepted_verification_block_reason: '',
    accepted_status_before_firewall: '',
    accepted_status_after_firewall: '',
    semantic_class: '',
    risk_flags: '',
    verification_decision: '',
    firewall_block_reason: '',
    status_before_firewall: '',
    status_after_firewall: '',
    evidence_candidate_count: 0,
    evidence_source_types: '',
    network_calls: 0,
    evidence_network_calls: 0,
    evidence_cache_hits: 0,
    runtime_source_channel: runtimeSourceChannel,
    runtime_codepath: runtimeCodepath,
    runtime_source_fields_used: sourceFields(row),
    runtime_metadata_fetched_live: false,
    production_rows_written: 0,
    gold_used_at_runtime: false,
    reviewer_grade_pass_fail: '',
    reviewer_correct_name_if_fail: '',
    reviewer_notes: '',
  };
}

async function resolveRowWithTimeout(row: CanarySourceRow, env: Env, shard: number, runId: string): Promise<CanaryResultRow> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      resolveRow(row, env, shard, runId),
      new Promise<CanaryResultRow>(resolve => {
        timeout = setTimeout(() => resolve(timeoutResult(row, shard, runId)), ROW_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveRow(row: CanarySourceRow, env: Env, shard: number, runId: string): Promise<CanaryResultRow> {
  const isContact = row.entity_type === 'contact';
  const runtimeSourceChannel = isContact ? 'cloud_canary_contact' : 'cloud_canary_company';
  const runtimeCodepath = row.mode === 'first_time'
    ? `cloud_canary_${row.entity_type}_first_time_resolver`
    : `cloud_canary_${row.entity_type}_all_evidence_resolver`;
  const rawName = clean(row.source_snapshot_name_for_review);
  const includeEntityEvidence = row.mode === 'all_evidence';
  const { resolution, evidenceBundle } = await resolveCrmEntityNameWithEvidence({
    entityType: row.entity_type,
    rawName,
    currentName: rawName,
    email: row.email || undefined,
    domain: row.domain || row.company_domain || undefined,
    website: row.website || undefined,
    sourceNameCandidates: isContact ? [rawName].filter(Boolean) : undefined,
    orgId: includeEntityEvidence ? row.org_id : '',
    entityId: includeEntityEvidence ? row.entity_id : '',
    relationshipEvidence: isContact,
    allowDomainPlaceholder: !isContact,
    trigger: runtimeCodepath,
    source: {
      source_channel: runtimeSourceChannel,
      source_record_id: row.entity_id,
      source_text: rawName,
      codepath: runtimeCodepath,
      evidence_level: row.mode === 'all_evidence' ? 'corroborated' : 'weak_single_source',
    },
  }, env as BaseEnv, {
    includeNetwork: true,
    networkTimeoutMs: row.mode === 'all_evidence' ? 2200 : 1600,
    maxNetworkCalls: row.mode === 'all_evidence' ? 4 : 1,
  });
  const accepted = selectedCandidates(resolution);
  const status = producedStatus(resolution);
  const acceptedSemanticClass = [...new Set(accepted.map(candidate => candidate.semantic_class || '').filter(Boolean))].join('; ');
  const acceptedRiskFlags = [...new Set(accepted.flatMap(candidate => candidate.risk_flags || []))].join('; ');
  const acceptedVerificationDecision = [...new Set(accepted.map(candidate => candidate.verification_decision || '').filter(Boolean))].join('; ');
  const acceptedVerificationBlockReason = [...new Set(accepted.map(candidate => candidate.verification_block_reason || '').filter(Boolean))].join('; ');
  const acceptedStatusBeforeFirewall = [...new Set(accepted.map(candidate => candidate.status_before_firewall || '').filter(Boolean))].join('; ');
  const acceptedStatusAfterFirewall = [...new Set(accepted.map(candidate => candidate.status_after_firewall || '').filter(Boolean))].join('; ');
  return {
    run_id: runId,
    shard,
    sample_index: row.sample_index,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    org_id: row.org_id,
    mode: row.mode,
    source_snapshot_name_for_review: rawName,
    email: clean(row.email),
    domain: clean(row.domain || row.company_domain),
    website: clean(row.website),
    company_name: clean(row.company_name),
    produced_name: clean(resolution.normalizedName),
    produced_name_status: status,
    ui_tag_if_created: uiTag(status),
    confidence: resolution.confidence,
    resolver_reason: resolution.reasons.join('; '),
    accepted_evidence_summary: accepted.map(candidate =>
      `${candidate.normalizedName} | ${candidate.status} | ${candidate.confidence} | ${candidate.reason}`
    ).join(' || '),
    accepted_semantic_class: acceptedSemanticClass,
    accepted_risk_flags: acceptedRiskFlags,
    accepted_verification_decision: acceptedVerificationDecision,
    accepted_verification_block_reason: acceptedVerificationBlockReason,
    accepted_status_before_firewall: acceptedStatusBeforeFirewall,
    accepted_status_after_firewall: acceptedStatusAfterFirewall,
    semantic_class: acceptedSemanticClass,
    risk_flags: acceptedRiskFlags,
    verification_decision: acceptedVerificationDecision,
    firewall_block_reason: acceptedVerificationBlockReason,
    status_before_firewall: acceptedStatusBeforeFirewall,
    status_after_firewall: acceptedStatusAfterFirewall,
    evidence_candidate_count: evidenceBundle.candidates.length,
    evidence_source_types: [...new Set(evidenceBundle.candidates.map(candidate => candidate.source_type))].join('; '),
    network_calls: evidenceBundle.network_calls,
    evidence_network_calls: evidenceBundle.network_calls,
    evidence_cache_hits: evidenceBundle.cache_hits,
    runtime_source_channel: runtimeSourceChannel,
    runtime_codepath: runtimeCodepath,
    runtime_source_fields_used: sourceFields(row),
    runtime_metadata_fetched_live: evidenceBundle.network_calls > 0,
    production_rows_written: 0,
    gold_used_at_runtime: false,
    reviewer_grade_pass_fail: '',
    reviewer_correct_name_if_fail: '',
    reviewer_notes: '',
  };
}

async function finalizeIfComplete(env: Env, runId: string): Promise<void> {
  const meta = await env.KV.get(kvMetaKey(runId), 'json') as any;
  if (!meta || meta.finalized_at) return;
  const shardCount = Number(meta.shard_count || 0);
  if (!shardCount) return;
  const statuses = await Promise.all(Array.from({ length: shardCount }, (_, shard) => env.KV.get(kvShardKey(runId, shard), 'json') as Promise<any>));
  if (statuses.some(status => status?.status !== 'completed')) return;
  const allRows: CanaryResultRow[] = [];
  for (let shard = 0; shard < shardCount; shard++) {
    const object = await env.R2.get(shardKey(runId, shard));
    if (!object) return;
    const shardRows = await object.json<CanaryResultRow[]>();
    allRows.push(...shardRows);
  }
  allRows.sort((a, b) => a.sample_index - b.sample_index);
  const statusCounts: Record<string, number> = {};
  const modeCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const row of allRows) {
    statusCounts[row.produced_name_status] = (statusCounts[row.produced_name_status] || 0) + 1;
    modeCounts[row.mode] = (modeCounts[row.mode] || 0) + 1;
    typeCounts[row.entity_type] = (typeCounts[row.entity_type] || 0) + 1;
  }
  const summary = {
    run_id: runId,
    status: 'completed',
    row_count: allRows.length,
    shard_count: shardCount,
    production_rows_written: 0,
    gold_used_at_runtime: false,
    status_counts: statusCounts,
    mode_counts: modeCounts,
    entity_type_counts: typeCounts,
    total_network_calls: allRows.reduce((sum, row) => sum + Number(row.evidence_network_calls || 0), 0),
    completed_at: new Date().toISOString(),
    clean_review_r2_key: cleanReviewKey(runId),
    summary_r2_key: summaryKey(runId),
  };
  await env.R2.put(cleanReviewKey(runId), csv(allRows), { httpMetadata: { contentType: 'text/csv; charset=utf-8' } });
  await env.R2.put(summaryKey(runId), JSON.stringify(summary, null, 2), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  await env.KV.put(kvMetaKey(runId), JSON.stringify({ ...meta, ...summary, finalized_at: summary.completed_at }), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function processShard(message: CanaryShardMessage, env: Env): Promise<void> {
  await env.KV.put(kvShardKey(message.run_id, message.shard), JSON.stringify({
    status: 'running',
    shard: message.shard,
    row_count: message.rows.length,
    started_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  const rows: CanaryResultRow[] = [];
  try {
    for (const row of message.rows) {
      await env.KV.put(kvShardKey(message.run_id, message.shard), JSON.stringify({
        status: 'running',
        shard: message.shard,
        row_count: message.rows.length,
        processed_count: rows.length,
        current_sample_index: row.sample_index,
        updated_at: new Date().toISOString(),
      }), { expirationTtl: 60 * 60 * 24 * 14 });
      rows.push(await resolveRowWithTimeout(row, env, message.shard, message.run_id));
    }
    await env.R2.put(shardKey(message.run_id, message.shard), JSON.stringify(rows, null, 2), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    await env.KV.put(kvShardKey(message.run_id, message.shard), JSON.stringify({
      status: 'completed',
      shard: message.shard,
      row_count: rows.length,
      completed_at: new Date().toISOString(),
      r2_key: shardKey(message.run_id, message.shard),
    }), { expirationTtl: 60 * 60 * 24 * 14 });
    await finalizeIfComplete(env, message.run_id);
  } catch (error) {
    await env.KV.put(kvShardKey(message.run_id, message.shard), JSON.stringify({
      status: 'failed',
      shard: message.shard,
      row_count: rows.length,
      failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }), { expirationTtl: 60 * 60 * 24 * 14 });
    throw error;
  }
}

async function startRun(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { run_id?: string; shard_count?: number; rows?: CanarySourceRow[] };
  const runId = clean(body.run_id) || crypto.randomUUID();
  const requestedShardCount = Math.max(1, Math.min(32, Math.floor(Number(body.shard_count || 8))));
  const rows = body.rows || [];
  if (!rows.length) return json({ ok: false, error: 'missing rows' }, { status: 400 });
  if (rows.length > MAX_CANARY_ROWS) return json({ ok: false, error: `too many rows, max ${MAX_CANARY_ROWS}` }, { status: 400 });
  const logicalShards = Array.from({ length: requestedShardCount }, (_, shard) => rows.filter((_, index) => index % requestedShardCount === shard));
  const queueShards: CanarySourceRow[][] = [];
  for (const logicalRows of logicalShards) {
    for (let index = 0; index < logicalRows.length; index += MAX_ROWS_PER_QUEUE_MESSAGE) {
      const chunk = logicalRows.slice(index, index + MAX_ROWS_PER_QUEUE_MESSAGE);
      if (chunk.length) queueShards.push(chunk);
    }
  }
  const queueShardCount = queueShards.length;
  await env.KV.put(kvMetaKey(runId), JSON.stringify({
    run_id: runId,
    status: 'queued',
    row_count: rows.length,
    shard_count: queueShardCount,
    requested_shard_count: requestedShardCount,
    queue_rows_per_message: MAX_ROWS_PER_QUEUE_MESSAGE,
    production_rows_written: 0,
    gold_used_at_runtime: false,
    queued_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  await Promise.all(queueShards.map((shardRows, shard) => env.CANARY_QUEUE.send({
    run_id: runId,
    shard,
    shard_count: queueShardCount,
    rows: shardRows,
    created_at: new Date().toISOString(),
  })));
  return json({
    ok: true,
    run_id: runId,
    row_count: rows.length,
    requested_shard_count: requestedShardCount,
    shard_count: queueShardCount,
    queue_rows_per_message: MAX_ROWS_PER_QUEUE_MESSAGE,
  });
}

async function enqueueShard(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { run_id?: string; shard?: number; shard_count?: number; rows?: CanarySourceRow[] };
  const runId = clean(body.run_id);
  const shard = Number(body.shard);
  const shardCount = Number(body.shard_count || 8);
  const rows = body.rows || [];
  if (!runId) return json({ ok: false, error: 'missing run_id' }, { status: 400 });
  if (!Number.isInteger(shard) || shard < 0 || shard >= shardCount) return json({ ok: false, error: 'invalid shard' }, { status: 400 });
  if (!rows.length) return json({ ok: false, error: 'missing rows' }, { status: 400 });
  const meta = await env.KV.get(kvMetaKey(runId), 'json') as any;
  if (!meta) return json({ ok: false, error: 'run not found' }, { status: 404 });
  await env.KV.put(kvShardKey(runId, shard), JSON.stringify({
    status: 'queued_recovery',
    shard,
    row_count: rows.length,
    queued_at: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 14 });
  await env.CANARY_QUEUE.send({
    run_id: runId,
    shard,
    shard_count: shardCount,
    rows,
    created_at: new Date().toISOString(),
  });
  return json({ ok: true, run_id: runId, shard, row_count: rows.length, shard_count: shardCount });
}

async function status(request: Request, env: Env): Promise<Response> {
  const runId = clean(new URL(request.url).searchParams.get('run_id'));
  if (!runId) return json({ ok: false, error: 'missing run_id' }, { status: 400 });
  const meta = await env.KV.get(kvMetaKey(runId), 'json') as any;
  if (!meta) return json({ ok: false, error: 'run not found' }, { status: 404 });
  const shardCount = Number(meta.shard_count || 0);
  const shards = await Promise.all(Array.from({ length: shardCount }, (_, shard) => env.KV.get(kvShardKey(runId, shard), 'json') as Promise<any>));
  return json({ ok: true, meta, shards });
}

async function artifact(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const runId = clean(url.searchParams.get('run_id'));
  const file = clean(url.searchParams.get('file') || 'clean-review.csv');
  const key = file === 'summary.json' ? summaryKey(runId) : cleanReviewKey(runId);
  const object = await env.R2.get(key);
  if (!object) return json({ ok: false, error: 'artifact not found', key }, { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': file === 'summary.json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${file}"`,
    },
  });
}

async function finalizeRun(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { run_id?: string };
  const runId = clean(body.run_id || new URL(request.url).searchParams.get('run_id'));
  if (!runId) return json({ ok: false, error: 'missing run_id' }, { status: 400 });
  await finalizeIfComplete(env, runId);
  const meta = await env.KV.get(kvMetaKey(runId), 'json') as any;
  return json({ ok: true, meta });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (!authOk(request, env)) return json({ ok: false, error: 'unauthorized' }, { status: 401 });
    if (url.pathname === '/start' && request.method === 'POST') return startRun(request, env);
    if (url.pathname === '/enqueue-shard' && request.method === 'POST') return enqueueShard(request, env);
    if (url.pathname === '/finalize' && request.method === 'POST') return finalizeRun(request, env);
    if (url.pathname === '/status') return status(request, env);
    if (url.pathname === '/artifact') return artifact(request, env);
    return json({ ok: false, error: 'not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<CanaryShardMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) await processShard(message.body, env);
  },
};

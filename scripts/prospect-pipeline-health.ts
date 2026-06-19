#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import { PROSPECT_CLASSIFIER_VERSION } from '../src/lib/prospect-intelligence';

type ReportFormat = 'json' | 'markdown';
type HealthVerdict = 'Healthy' | 'Warning' | 'Critical';

interface Args {
  orgId: string;
  configPath: string;
  database: string;
  daysBack: number;
  remote: boolean;
  format: ReportFormat;
}

export interface CountByStatus {
  status: string;
  count: number;
}

export interface SourceFreshness {
  source: string;
  label: string;
  latest_ingested_at: string | null;
  records_lookback: number;
  age_hours: number | null;
  status: HealthVerdict;
}

export interface CompletenessMetric {
  current: number;
  total: number;
  percentage: number;
}

export interface WorkQueueDomainCount {
  domain: string;
  status: string;
  count: number;
}

export interface IngestionIncidentSummary {
  source: string;
  status: string;
  severity: string;
  code: string;
  title: string;
  human_action_required: number;
  last_seen_at: string;
  recovery_status: string;
}

export interface ActiveSyncJobSummary {
  workflow_type: string;
  status: string;
  started_at: string | null;
  items_processed: number;
  items_failed: number;
}

export interface ProspectPipelineHealthSummary {
  read_only: true;
  org_id: string;
  generated_at: string;
  days_back: number;
  verdict: HealthVerdict;
  verdict_reasons: string[];
  work_queue: CountByStatus[];
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
  prospect_activity: {
    inbound_signals: number;
    context_signals: number;
    ignored_or_noise_signals: number;
    final_gate_fallbacks: number;
    final_gate_failed_open: number;
    null_inbound_prospect_links: number;
    duplicate_active_normalized_names: number;
    old_classifier_signals: number;
  };
  ingestion_freshness: SourceFreshness[];
  wiring_health: {
    email_embedding: CompletenessMetric;
    email_linkage: CompletenessMetric;
    document_embedding: CompletenessMetric;
    meeting_embedding: CompletenessMetric;
    meeting_attendees: CompletenessMetric;
    prospect_signal_linkage: CompletenessMetric;
  };
  ingestion_source_state: Array<{
    source: string;
    status: string;
    severity: string;
    last_success_at: string | null;
    last_failure_at: string | null;
    failure_count: number;
    human_action_required: number;
  }>;
  open_ingestion_incidents: IngestionIncidentSummary[];
  work_queue_inventory: WorkQueueDomainCount[];
  stuck_work_queue: Array<{
    id: string;
    domain: string;
    status: string;
    heartbeat_at: string | null;
    locked_until: string | null;
    last_error: string | null;
  }>;
  deal_evidence_queue: CountByStatus[];
  active_sync_jobs: ActiveSyncJobSummary[];
  recent_sync_jobs: ActiveSyncJobSummary[];
  remote_read_meta?: { query_count: number; rows_read: number; rows_written: number; changed_db: boolean };
}

type D1AllResult<T> = Promise<{ results: T[] }>;
type D1FirstResult<T> = Promise<T | null>;

interface ReadOnlyStatement {
  bind(...args: unknown[]): ReadOnlyStatement;
  all<T = any>(): D1AllResult<T>;
  first<T = any>(): D1FirstResult<T>;
}

interface ReadOnlyD1 {
  prepare(sql: string): ReadOnlyStatement;
  batch?: (...args: unknown[]) => Promise<never>;
}

const SOURCE_LABELS: Record<string, string> = {
  outlook_email: 'Outlook emails',
  slack: 'Slack messages',
  firefly: 'Fireflies transcripts',
  calendar: 'Calendar events',
  documents: 'Documents',
  embeddings: 'Embeddings',
  rag_v2: 'RAG indexing',
};

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
  const format = String(raw.get('format') || 'json').toLowerCase();
  if (format !== 'json' && format !== 'markdown') throw new Error('INVALID_FORMAT');
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    database: raw.get('database') || 'medina-ventures-db',
    daysBack: Math.floor(daysBack),
    remote: raw.get('remote') === 'true',
    format,
  };
}

function assertSelectOnly(sql: string): void {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`PIPELINE_HEALTH_READ_ONLY_VIOLATION:${sql.slice(0, 120)}`);
  if (/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|VACUUM|PRAGMA|ATTACH|DETACH)\b/i.test(sql)) {
    throw new Error(`PIPELINE_HEALTH_READ_ONLY_VIOLATION:${sql.slice(0, 120)}`);
  }
}

function sqlString(value: unknown): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
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

class WranglerD1ReadOnlyStatement implements ReadOnlyStatement {
  private binds: unknown[] = [];

  constructor(private readonly database: string, private readonly sql: string, private readonly meta: ProspectPipelineHealthSummary['remote_read_meta']) {
    assertSelectOnly(sql);
  }

  bind(...args: unknown[]): ReadOnlyStatement {
    this.binds = args;
    return this;
  }

  async all<T = any>(): D1AllResult<T> {
    return { results: this.execute<T>() };
  }

  async first<T = any>(): D1FirstResult<T> {
    return this.execute<T>()[0] || null;
  }

  private renderedSql(): string {
    let index = 0;
    return this.sql.replace(/\?/g, () => sqlString(this.binds[index++]));
  }

  private execute<T>(): T[] {
    const sql = this.renderedSql();
    assertSelectOnly(sql);
    const stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', this.database, '--remote', '--json', '--command', sql], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 120 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Array<{
      results?: T[];
      success?: boolean;
      meta?: { rows_read?: number; rows_written?: number; changed_db?: boolean };
    }>;
    const first = parsed[0] || {};
    if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
    if (this.meta) {
      this.meta.query_count += 1;
      this.meta.rows_read += Number(first.meta?.rows_read || 0);
      this.meta.rows_written += Number(first.meta?.rows_written || 0);
      this.meta.changed_db = Boolean(this.meta.changed_db || first.meta?.changed_db);
    }
    return first.results || [];
  }
}

class WranglerD1ReadOnly {
  readonly meta = { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false };

  constructor(private readonly database: string) {}

  prepare(sql: string): ReadOnlyStatement {
    return new WranglerD1ReadOnlyStatement(this.database, sql, this.meta);
  }

  async batch(): Promise<never> {
    throw new Error('PIPELINE_HEALTH_READ_ONLY_VIOLATION:batch');
  }
}

function num(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function pct(current: number, total: number): number {
  return total > 0 ? Math.round((current / total) * 100) : 100;
}

function metric(current: number, total: number): CompletenessMetric {
  return { current, total, percentage: pct(current, total) };
}

function hoursSince(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(((now - ms) / 3600000) * 10) / 10);
}

function sourceStatus(source: string, latest: string | null, now = Date.now()): HealthVerdict {
  const age = hoursSince(latest, now);
  if (age === null) return ['firefly', 'documents', 'embeddings', 'rag_v2'].includes(source) ? 'Warning' : 'Critical';
  if (['outlook_email', 'slack', 'calendar'].includes(source)) {
    if (age > 168) return 'Critical';
    if (age > 72) return 'Warning';
  }
  if (source === 'firefly') {
    if (age > 336) return 'Warning';
  }
  if (source === 'documents' || source === 'embeddings' || source === 'rag_v2') {
    if (age > 168) return 'Warning';
  }
  return 'Healthy';
}

function countStatus(rows: CountByStatus[], status: string): number {
  return rows
    .filter(row => row.status === status)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function countDomainStatus(rows: WorkQueueDomainCount[], domain: string, status: string): number {
  return rows
    .filter(row => row.domain === domain && row.status === status)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function statusRank(verdict: HealthVerdict): number {
  return verdict === 'Critical' ? 2 : verdict === 'Warning' ? 1 : 0;
}

function worstStatus(left: HealthVerdict, right: HealthVerdict): HealthVerdict {
  return statusRank(right) > statusRank(left) ? right : left;
}

function sourceFreshness(source: string, row: any, now = Date.now()): SourceFreshness {
  const latest = row?.latest_ingested_at || null;
  return {
    source,
    label: SOURCE_LABELS[source] || source,
    latest_ingested_at: latest,
    records_lookback: num(row?.records_lookback),
    age_hours: hoursSince(latest, now),
    status: sourceStatus(source, latest, now),
  };
}

export function renderProspectPipelineHealthMarkdown(summary: ProspectPipelineHealthSummary): string {
  const freshnessRows = summary.ingestion_freshness
    .map(row => `| ${row.label} | ${row.status} | ${row.records_lookback} | ${row.latest_ingested_at || 'none'} | ${row.age_hours ?? 'n/a'} |`)
    .join('\n');
  const wiringRows = Object.entries(summary.wiring_health)
    .map(([key, value]) => `| ${key.replace(/_/g, ' ')} | ${value.current}/${value.total} | ${value.percentage}% |`)
    .join('\n');
  const incidentRows = summary.open_ingestion_incidents.length
    ? summary.open_ingestion_incidents
      .slice(0, 12)
      .map(row => `| ${row.severity} | ${row.source} | ${row.code} | ${row.title.replace(/\|/g, '/')} | ${row.human_action_required ? 'yes' : 'no'} |`)
      .join('\n')
    : '| none | none | none | none | no |';
  const queueRows = summary.work_queue_inventory.length
    ? summary.work_queue_inventory
      .filter(row => row.count > 0)
      .slice(0, 16)
      .map(row => `| ${row.domain} | ${row.status} | ${row.count} |`)
      .join('\n')
    : '| none | none | 0 |';
  const reasons = summary.verdict_reasons.length
    ? summary.verdict_reasons.map(reason => `- ${reason}`).join('\n')
    : '- No blocking issues detected.';

  return `# Weekly Prospect + Ingestion Health Report

**Verdict:** ${summary.verdict}
**Window:** last ${summary.days_back} days
**Generated:** ${summary.generated_at}
**Read-only:** ${summary.read_only}${summary.remote_read_meta ? `; D1 changed_db=${summary.remote_read_meta.changed_db}; rows_written=${summary.remote_read_meta.rows_written}` : ''}

## Why
${reasons}

## Prospect Activity
| Metric | Count |
| --- | ---: |
| New prospects | ${summary.new_prospects} |
| Provisional prospects | ${summary.provisional_prospects} |
| Inbound prospect signals | ${summary.prospect_activity.inbound_signals} |
| Context signals | ${summary.context_signals} |
| Noise/ignored signals | ${summary.ignored_or_noise_signals} |
| Classifier errors | ${summary.classifier_errors} |
| Pending classifications | ${summary.pending_classifications} |
| Final gate fallbacks | ${summary.prospect_activity.final_gate_fallbacks} |
| Final gate failed-open | ${summary.prospect_activity.final_gate_failed_open} |
| Null inbound prospect links | ${summary.prospect_activity.null_inbound_prospect_links} |
| Duplicate active prospect names | ${summary.prospect_activity.duplicate_active_normalized_names} |
| Old classifier signals | ${summary.prospect_activity.old_classifier_signals} |

## Ingestion Freshness
| Source | Status | Records in window | Latest ingested | Age hours |
| --- | --- | ---: | --- | ---: |
${freshnessRows}

## Full Wiring Health
| Wiring check | Linked / total | Coverage |
| --- | ---: | ---: |
${wiringRows}

## Work Queue
| Domain | Status | Count |
| --- | --- | ---: |
${queueRows}

## Open Incidents
| Severity | Source | Code | Title | Human action |
| --- | --- | --- | --- | --- |
${incidentRows}

## Recommended Fixes
${summary.verdict === 'Healthy'
  ? '- Keep monitoring. No manual repair is recommended from this report.'
  : summary.verdict_reasons.map(reason => `- Investigate: ${reason}`).join('\n')}
`;
}

export async function buildProspectPipelineHealth(
  orgId: string,
  env: Env,
  options: { daysBack?: number } = {}
): Promise<ProspectPipelineHealthSummary> {
  const safeEnv = readOnlyEnv(env);
  const d1 = safeEnv.D1 as unknown as ReadOnlyD1;
  const daysBack = Math.min(Math.max(Math.floor(options.daysBack || 7), 1), 365);
  const lookback = `-${daysBack} days`;
  const now = Date.now();
  const [
    workQueue,
    rateLimitDeferrals,
    classifierCircuitRows,
    signalState,
    prospectState,
    freshnessOutlook,
    freshnessSlack,
    freshnessFirefly,
    freshnessCalendar,
    freshnessDocuments,
    freshnessEmbeddings,
    freshnessRag,
    emailTotalRow,
    emailEmbeddedRow,
    emailLinkedRow,
    documentTotalRow,
    documentEmbeddedRow,
    eventTotalRow,
    eventEmbeddedRow,
    attendeeRow,
    prospectSignalLinkRow,
    ingestionSourceState,
    openIncidents,
    workQueueInventory,
    stuckWorkQueue,
    dealEvidenceQueue,
    activeSyncJobs,
    recentSyncJobs,
  ] = await Promise.all([
    d1.prepare(
      `SELECT status, COUNT(*) AS count
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'prospect_detect'
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        GROUP BY status
        ORDER BY status ASC`
    ).bind(orgId, lookback).all<CountByStatus>(),
    d1.prepare(
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
    d1.prepare(
      `SELECT upstream, circuit_open_until
         FROM upstream_budget_ledger
        WHERE org_id = ?
          AND upstream IN ('claude','anthropic_haiku','anthropic_sonnet','anthropic_opus')
          AND circuit_open_until IS NOT NULL
          AND circuit_open_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ORDER BY circuit_open_until DESC`
    ).bind(orgId).all<{ upstream: string; circuit_open_until: string | null }>(),
    d1.prepare(
      `SELECT
          SUM(CASE WHEN mention_type = 'inbound_prospect' THEN 1 ELSE 0 END) AS inbound_signals,
          SUM(CASE WHEN classification_status != 'classified' THEN 1 ELSE 0 END) AS pending_classifications,
          SUM(CASE WHEN error_message IS NOT NULL AND trim(error_message) != '' THEN 1 ELSE 0 END) AS classifier_errors,
          SUM(CASE WHEN mention_type = 'known_deal' OR json_extract(metadata_json, '$.prospect_action') = 'attach_existing_deal' THEN 1 ELSE 0 END) AS known_deal_attaches,
          SUM(CASE WHEN json_extract(metadata_json, '$.prospect_action') = 'record_context' THEN 1 ELSE 0 END) AS context_signals,
          SUM(CASE WHEN mention_type IN ('noise','news','web_analytics') OR json_extract(metadata_json, '$.prospect_action') = 'ignore' THEN 1 ELSE 0 END) AS ignored_or_noise_signals,
          SUM(CASE WHEN json_extract(metadata_json, '$.prospect_final_quality_gate.fallback_used') = 1 THEN 1 ELSE 0 END) AS final_gate_fallbacks,
          SUM(CASE WHEN json_extract(metadata_json, '$.prospect_final_quality_gate.failed_open') = 1 THEN 1 ELSE 0 END) AS final_gate_failed_open,
          SUM(CASE WHEN mention_type = 'inbound_prospect' AND prospect_id IS NULL THEN 1 ELSE 0 END) AS null_inbound_prospect_links,
          SUM(CASE WHEN classifier_version != ? THEN 1 ELSE 0 END) AS old_classifier_signals
         FROM prospect_signals
        WHERE org_id = ?
          AND occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(PROSPECT_CLASSIFIER_VERSION, orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT
          SUM(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) THEN 1 ELSE 0 END) AS new_prospects,
          SUM(CASE WHEN provisional = 1 THEN 1 ELSE 0 END) AS provisional_prospects,
          (SELECT COUNT(*) FROM (
             SELECT normalized_name
               FROM prospects
              WHERE org_id = ?
                AND deleted_at IS NULL
                AND status IN ('active','provisional')
              GROUP BY normalized_name
             HAVING COUNT(*) > 1
           )) AS duplicate_active_normalized_names
         FROM prospects
        WHERE org_id = ?
          AND deleted_at IS NULL`
    ).bind(lookback, orgId, orgId).first<any>(),
    d1.prepare(
      `SELECT MAX(created_at) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM conversations
        WHERE org_id = ?
          AND source = 'outlook'
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT MAX(created_at) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM conversations
        WHERE org_id = ?
          AND source = 'slack'
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT MAX(created_at) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM events
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND (source = 'firefly' OR transcript_source = 'firefly' OR transcript_r2_key IS NOT NULL)
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT MAX(created_at) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM events
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND source = 'outlook'
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT MAX(created_at) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM documents
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT MAX(created_at) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM vector_entity_index
        WHERE org_id = ?
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(
      `SELECT MAX(COALESCE(completed_at, started_at, created_at)) AS latest_ingested_at, COUNT(*) AS records_lookback
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'rag_reindex_v2'
          AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    ).bind(orgId, lookback).first<any>(),
    d1.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE org_id = ?`).bind(orgId).first<{ n: number }>(),
    d1.prepare(`SELECT COUNT(DISTINCT entity_id) AS n FROM vector_entity_index WHERE source_table = 'conversations' AND org_id = ?`).bind(orgId).first<{ n: number }>(),
    d1.prepare(
      `SELECT COUNT(DISTINCT cc.conversation_id) AS n
         FROM conversation_contacts cc
         JOIN conversations c ON c.id = cc.conversation_id
        WHERE c.org_id = ?`
    ).bind(orgId).first<{ n: number }>(),
    d1.prepare(
      `SELECT COUNT(*) AS n
         FROM documents
        WHERE org_id = ?
          AND deleted_at IS NULL
          AND processing_status = 'completed'
          AND r2_key IS NOT NULL`
    ).bind(orgId).first<{ n: number }>(),
    d1.prepare(
      `SELECT COUNT(DISTINCT d.id) AS n
         FROM documents d
         JOIN vector_entity_index vei
           ON vei.entity_id = d.id
          AND vei.source_table = 'documents'
          AND vei.org_id = d.org_id
        WHERE d.org_id = ?
          AND d.deleted_at IS NULL
          AND d.processing_status = 'completed'
          AND d.r2_key IS NOT NULL`
    ).bind(orgId).first<{ n: number }>(),
    d1.prepare(`SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND deleted_at IS NULL`).bind(orgId).first<{ n: number }>(),
    d1.prepare(`SELECT COUNT(DISTINCT entity_id) AS n FROM vector_entity_index WHERE source_table = 'events' AND org_id = ?`).bind(orgId).first<{ n: number }>(),
    d1.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN ea.contact_id IS NOT NULL OR ea.user_id IS NOT NULL THEN 1 END) AS linked
         FROM event_attendees ea
         JOIN events e ON e.id = ea.event_id
        WHERE e.org_id = ? AND e.deleted_at IS NULL`
    ).bind(orgId).first<{ total: number; linked: number }>(),
    d1.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN prospect_id IS NOT NULL THEN 1 END) AS linked
         FROM prospect_signals
        WHERE org_id = ?
          AND mention_type = 'inbound_prospect'`
    ).bind(orgId).first<{ total: number; linked: number }>(),
    d1.prepare(
      `SELECT source, status, severity, last_success_at, last_failure_at, failure_count, human_action_required
         FROM ingestion_source_state
        WHERE org_id = ?
        ORDER BY source, scope_type, scope_id
        LIMIT 100`
    ).bind(orgId).all<any>(),
    d1.prepare(
      `SELECT source, status, severity, code, title, human_action_required, last_seen_at, recovery_status
         FROM ingestion_incidents
        WHERE org_id = ?
          AND status IN ('open','recovering','blocked')
        ORDER BY human_action_required DESC, severity DESC, last_seen_at DESC
        LIMIT 25`
    ).bind(orgId).all<IngestionIncidentSummary>(),
    d1.prepare(
      `SELECT domain, status, COUNT(*) AS count
         FROM work_queue
        WHERE org_id = ?
        GROUP BY domain, status
        ORDER BY domain, status`
    ).bind(orgId).all<WorkQueueDomainCount>(),
    d1.prepare(
      `SELECT id, domain, status, heartbeat_at, locked_until, last_error
         FROM work_queue
        WHERE org_id = ?
          AND status = 'in_progress'
          AND (
            heartbeat_at IS NULL
            OR heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')
            OR locked_until < strftime('%Y-%m-%dT%H:%M:%fZ','now')
          )
        ORDER BY COALESCE(heartbeat_at, locked_until, created_at) ASC
        LIMIT 25`
    ).bind(orgId).all<any>(),
    d1.prepare(
      `SELECT status, COUNT(*) AS count
         FROM work_queue
        WHERE org_id = ?
          AND domain = 'deal_evidence_detect'
        GROUP BY status
        ORDER BY status`
    ).bind(orgId).all<CountByStatus>(),
    d1.prepare(
      `SELECT workflow_type, status, started_at, items_processed, items_failed
         FROM sync_jobs
        WHERE org_id = ?
          AND status = 'running'
          AND (timeout_at IS NULL OR timeout_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ORDER BY started_at DESC
        LIMIT 12`
    ).bind(orgId).all<ActiveSyncJobSummary>(),
    d1.prepare(
      `SELECT workflow_type, status, started_at, items_processed, items_failed
         FROM sync_jobs
        WHERE org_id = ?
          AND status != 'running'
        ORDER BY created_at DESC
        LIMIT 8`
    ).bind(orgId).all<ActiveSyncJobSummary>(),
  ]);

  const queueRows = (workQueue.results || []).map(row => ({ status: row.status, count: Number(row.count || 0) }));
  const workQueueRows = (workQueueInventory.results || []).map(row => ({
    domain: row.domain,
    status: row.status,
    count: Number(row.count || 0),
  }));
  const signal = signalState || {};
  const prospect = prospectState || {};
  const ingestionFreshness = [
    sourceFreshness('outlook_email', freshnessOutlook, now),
    sourceFreshness('slack', freshnessSlack, now),
    sourceFreshness('firefly', freshnessFirefly, now),
    sourceFreshness('calendar', freshnessCalendar, now),
    sourceFreshness('documents', freshnessDocuments, now),
    sourceFreshness('embeddings', freshnessEmbeddings, now),
    sourceFreshness('rag_v2', freshnessRag, now),
  ];
  const wiringHealth = {
    email_embedding: metric(num(emailEmbeddedRow?.n), num(emailTotalRow?.n)),
    email_linkage: metric(num(emailLinkedRow?.n), num(emailTotalRow?.n)),
    document_embedding: metric(num(documentEmbeddedRow?.n), num(documentTotalRow?.n)),
    meeting_embedding: metric(num(eventEmbeddedRow?.n), num(eventTotalRow?.n)),
    meeting_attendees: metric(num(attendeeRow?.linked), num(attendeeRow?.total)),
    prospect_signal_linkage: metric(num(prospectSignalLinkRow?.linked), num(prospectSignalLinkRow?.total)),
  };

  let verdict: HealthVerdict = 'Healthy';
  const reasons: string[] = [];
  const addReason = (level: HealthVerdict, reason: string): void => {
    verdict = worstStatus(verdict, level);
    reasons.push(reason);
  };

  const criticalIncidents = (openIncidents.results || []).filter(row => row.human_action_required || row.severity === 'critical');
  if (criticalIncidents.length > 0) addReason('Critical', `${criticalIncidents.length} critical or human-action ingestion incident(s) are open`);
  else if ((openIncidents.results || []).length > 0) addReason('Warning', `${openIncidents.results.length} non-critical ingestion incident(s) are open`);

  if (countStatus(queueRows, 'dead_letter') > 0) addReason('Critical', `${countStatus(queueRows, 'dead_letter')} prospect_detect dead-letter item(s)`);
  if ((classifierCircuitRows.results || []).length > 0) addReason('Critical', `${classifierCircuitRows.results.length} classifier circuit(s) are open`);
  if (num(signal.final_gate_failed_open) > 0) addReason('Critical', `${num(signal.final_gate_failed_open)} final-gate failed-open prospect decision(s)`);
  if (num(signal.null_inbound_prospect_links) > 0) addReason('Critical', `${num(signal.null_inbound_prospect_links)} inbound prospect signal(s) have no prospect link`);
  if (num(prospect.duplicate_active_normalized_names) > 0) addReason('Critical', `${num(prospect.duplicate_active_normalized_names)} duplicate active prospect normalized name group(s)`);
  if ((stuckWorkQueue.results || []).length > 0) addReason('Critical', `${stuckWorkQueue.results.length} stale in-progress work queue item(s)`);
  const totalDeadLetters = workQueueRows.filter(row => row.status === 'dead_letter').reduce((sum, row) => sum + row.count, 0);
  if (totalDeadLetters > 0) addReason('Critical', `${totalDeadLetters} total work queue dead-letter item(s)`);
  const pendingProspect = countStatus(queueRows, 'pending') + countStatus(queueRows, 'in_progress');
  if (pendingProspect > 250) addReason('Critical', `${pendingProspect} prospect_detect item(s) pending or in progress`);
  else if (pendingProspect > 50) addReason('Warning', `${pendingProspect} prospect_detect item(s) pending or in progress`);
  if (num(signal.classifier_errors) > 0) addReason('Warning', `${num(signal.classifier_errors)} prospect classifier error(s) in the window`);
  if (num(signal.old_classifier_signals) > 0) addReason('Warning', `${num(signal.old_classifier_signals)} signal(s) used an older classifier version in the window`);
  for (const row of ingestionFreshness) {
    if (row.status === 'Critical') addReason('Critical', `${row.label} ingestion appears stale or absent`);
    else if (row.status === 'Warning') addReason('Warning', `${row.label} ingestion may be stale or quiet`);
  }
  for (const [key, value] of Object.entries(wiringHealth)) {
    if (value.total > 0 && value.percentage < 70) addReason('Warning', `${key.replace(/_/g, ' ')} coverage is ${value.percentage}%`);
  }
  if (countDomainStatus(workQueueRows, 'deal_evidence_detect', 'dead_letter') > 0) {
    addReason('Critical', `${countDomainStatus(workQueueRows, 'deal_evidence_detect', 'dead_letter')} deal evidence dead-letter item(s)`);
  }

  return {
    read_only: true,
    org_id: orgId,
    generated_at: new Date(now).toISOString(),
    days_back: daysBack,
    verdict,
    verdict_reasons: Array.from(new Set(reasons)),
    work_queue: queueRows,
    dead_letters: countStatus(queueRows, 'dead_letter'),
    failed_or_pending: countStatus(queueRows, 'failed') + countStatus(queueRows, 'pending') + countStatus(queueRows, 'in_progress'),
    rate_limit_deferrals: Number(rateLimitDeferrals?.count || 0),
    open_classifier_circuits: classifierCircuitRows.results || [],
    classifier_errors: num(signal.classifier_errors),
    pending_classifications: num(signal.pending_classifications),
    new_prospects: num(prospect.new_prospects),
    known_deal_attaches: num(signal.known_deal_attaches),
    provisional_prospects: num(prospect.provisional_prospects),
    context_signals: num(signal.context_signals),
    ignored_or_noise_signals: num(signal.ignored_or_noise_signals),
    prospect_activity: {
      inbound_signals: num(signal.inbound_signals),
      context_signals: num(signal.context_signals),
      ignored_or_noise_signals: num(signal.ignored_or_noise_signals),
      final_gate_fallbacks: num(signal.final_gate_fallbacks),
      final_gate_failed_open: num(signal.final_gate_failed_open),
      null_inbound_prospect_links: num(signal.null_inbound_prospect_links),
      duplicate_active_normalized_names: num(prospect.duplicate_active_normalized_names),
      old_classifier_signals: num(signal.old_classifier_signals),
    },
    ingestion_freshness: ingestionFreshness,
    wiring_health: wiringHealth,
    ingestion_source_state: (ingestionSourceState.results || []).map(row => ({
      source: row.source,
      status: row.status,
      severity: row.severity,
      last_success_at: row.last_success_at || null,
      last_failure_at: row.last_failure_at || null,
      failure_count: num(row.failure_count),
      human_action_required: num(row.human_action_required),
    })),
    open_ingestion_incidents: openIncidents.results || [],
    work_queue_inventory: workQueueRows,
    stuck_work_queue: stuckWorkQueue.results || [],
    deal_evidence_queue: dealEvidenceQueue.results || [],
    active_sync_jobs: activeSyncJobs.results || [],
    recent_sync_jobs: recentSyncJobs.results || [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.remote) {
    const d1 = new WranglerD1ReadOnly(args.database);
    const summary = await buildProspectPipelineHealth(args.orgId, { D1: d1 } as unknown as Env, {
      daysBack: args.daysBack,
    });
    summary.remote_read_meta = d1.meta;
    process.stdout.write(args.format === 'markdown'
      ? `${renderProspectPipelineHealthMarkdown(summary)}\n`
      : `${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const summary = await buildProspectPipelineHealth(args.orgId, proxy.env as unknown as Env, {
      daysBack: args.daysBack,
    });
    process.stdout.write(args.format === 'markdown'
      ? `${renderProspectPipelineHealthMarkdown(summary)}\n`
      : `${JSON.stringify(summary, null, 2)}\n`);
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

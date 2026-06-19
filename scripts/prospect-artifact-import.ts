#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { buildEntityIdentityAliasValues, PROSPECT_CLASSIFIER_VERSION } from '../src/lib/prospect-intelligence';

const IMPORT_CONFIRMATION = 'PROSPECT_IMPORT_GO';
const DEFAULT_DATABASE = 'medina-ventures-db';
const DEFAULT_ORG_ID = 'medina-ventures';
const DEFAULT_RUN_DIR = 'outputs/prospect-14-day-backfill-20260615-113716';
const SQL_CHUNK_SIZE = 100;
const DIRECT_SQL_CHUNK_SIZE = 10;
const MAX_D1_ATTEMPTS = 3;

type Args = {
  orgId: string;
  database: string;
  runDir: string;
  outputDir: string;
  apply: boolean;
  requireEmpty: boolean;
  confirmProductionWrite: string | null;
  expectProspects: number | null;
  expectSignals: number | null;
};

type D1Meta = {
  query_count: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
};

type DecisionRow = {
  item_id: string;
  source_type: 'conversation' | 'event' | 'document';
  source_id: string;
  source_title: string | null;
  occurred_at: string;
  mention_ordinal: number;
  company_name: string | null;
  normalized_company_name: string | null;
  prospect_action: string | null;
  mention_type: string | null;
  direction: string | null;
  confidence: number | null;
  sector_key: string | null;
  prospect_company_name: string | null;
  should_create_prospect: boolean | null;
  linked_deal_id: string | null;
  possible_company_id: string | null;
  possible_deal_id: string | null;
  provisional: boolean | null;
  reasoning: string | null;
  error: string | null;
  final_quality_decision?: string | null;
  final_quality_canonical_name?: string | null;
  final_quality_blocked?: boolean | null;
  final_quality_attach_only?: boolean | null;
  final_quality_reason?: string | null;
  final_quality_renamed?: boolean | null;
  final_quality_merged?: boolean | null;
  final_quality_merge_target?: string | null;
  reasoning_judge_action?: string | null;
  reasoning_judge_reason?: string | null;
  target_evidence_reasons?: string | null;
  second_look_lane?: string | null;
  second_look_reasons?: string | null;
  second_look_warnings?: string | null;
};

type ProspectProjection = {
  id: string;
  canonicalName: string;
  normalizedName: string;
  domain: string | null;
  website: string | null;
  description: string | null;
  sectorKey: string;
  sectorConfidence: number;
  signalCount: number;
  evidenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  confidence: number;
  provisional: boolean;
  directionUncertain: boolean;
  possibleCompanyId: string | null;
  possibleDealId: string | null;
  signalStrength: number;
  signalStrengthReasons: string[];
  enrichmentPriority: 'eager' | 'lazy';
  metadata: Record<string, unknown>;
};

type SnapshotCompany = {
  id: string;
  name?: string;
  domain?: string | null;
  website?: string | null;
  description?: string | null;
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
  const runDir = resolve(raw.get('run-dir') || DEFAULT_RUN_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    orgId: raw.get('org-id') || DEFAULT_ORG_ID,
    database: raw.get('database') || DEFAULT_DATABASE,
    runDir,
    outputDir: resolve(raw.get('output-dir') || join(runDir, `production-import-${stamp}`)),
    apply: raw.get('apply') === 'true',
    requireEmpty: raw.get('require-empty') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') || null,
    expectProspects: raw.has('expect-prospects') ? Number(raw.get('expect-prospects')) : null,
    expectSignals: raw.has('expect-signals') ? Number(raw.get('expect-signals')) : null,
  };
}

function sqlString(value: string | null | undefined): string {
  if (value === null || typeof value === 'undefined') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? String(value) : 'NULL';
}

function sqlBool(value: boolean): string {
  return value ? '1' : '0';
}

function normalizeProspectName(value: string | null | undefined): string {
  let text = String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|pbc)\b\.?/g, ' ')
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  text = text.replace(/\b(ai|technologies|technology|labs|systems)\b$/g, '').trim();
  return text.replace(/\s+/g, '');
}

function compactProspectName(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|company|co|pbc)\b\.?/g, ' ')
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function prospectImportGroupAliases(value: string | null | undefined): string[] {
  const aliases = new Set<string>();
  const normalized = normalizeProspectName(value);
  const compact = compactProspectName(value);
  if (normalized) aliases.add(normalized);
  if (compact && /\d/.test(compact) && compact.endsWith('ai')) {
    aliases.add(compact);
    aliases.add(compact.replace(/ai$/, ''));
  }
  return Array.from(aliases).filter(Boolean);
}

function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  const variant = Number.parseInt(hex[16], 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split(/\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T);
}

class WranglerD1 {
  meta: D1Meta = { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false };

  constructor(private readonly database: string, private readonly outputDir: string) {}

  execute<T = any>(sql: string): T[] {
    const stdout = this.execWrangler(['wrangler', 'd1', 'execute', this.database, '--remote', '--json', '--command', sql], sql);
    const parsed = JSON.parse(stdout) as Array<{ results?: T[]; success?: boolean; meta?: Partial<D1Meta> }>;
    const first = parsed[0] || {};
    if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
    this.meta.query_count += 1;
    this.meta.rows_read += Number(first.meta?.rows_read || 0);
    this.meta.rows_written += Number(first.meta?.rows_written || 0);
    this.meta.changed_db = Boolean(this.meta.changed_db || first.meta?.changed_db);
    return first.results || [];
  }

  runSqlFile(file: string): void {
    const stdout = this.execWrangler(['wrangler', 'd1', 'execute', this.database, '--remote', '--json', `--file=${file}`], file);
    const parsed = parseWranglerJson(stdout) as Array<{ success?: boolean; meta?: Partial<D1Meta> }>;
    for (const result of parsed) {
      if (result.success === false) throw new Error(`WRANGLER_D1_FILE_FAILED:${stdout.slice(0, 500)}`);
      this.meta.query_count += 1;
      this.meta.rows_read += Number(result.meta?.rows_read || 0);
      this.meta.rows_written += Number(result.meta?.rows_written || 0);
      this.meta.changed_db = Boolean(this.meta.changed_db || result.meta?.changed_db);
    }
  }

  runSqlCommand(label: string, sql: string): void {
    const stdout = this.execWrangler(['wrangler', 'd1', 'execute', this.database, '--remote', '--json', '--command', sql], label);
    const parsed = JSON.parse(stdout) as Array<{ success?: boolean; meta?: Partial<D1Meta> }>;
    for (const result of parsed) {
      if (result.success === false) throw new Error(`WRANGLER_D1_COMMAND_FAILED:${stdout.slice(0, 500)}`);
      this.meta.query_count += 1;
      this.meta.rows_read += Number(result.meta?.rows_read || 0);
      this.meta.rows_written += Number(result.meta?.rows_written || 0);
      this.meta.changed_db = Boolean(this.meta.changed_db || result.meta?.changed_db);
    }
  }

  runChunk(name: string, statements: string[]): void {
    if (statements.length === 0) return;
    const chunksDir = join(this.outputDir, 'sql-chunks');
    mkdirSync(chunksDir, { recursive: true });
    for (let index = 0; index < statements.length; index += DIRECT_SQL_CHUNK_SIZE) {
      const chunk = statements.slice(index, index + DIRECT_SQL_CHUNK_SIZE);
      const chunkNumber = index / DIRECT_SQL_CHUNK_SIZE;
      const file = join(chunksDir, `${name}-${String(chunkNumber).padStart(4, '0')}.sql`);
      writeFileSync(file, `${chunk.join('\n')}\n`);
      this.runSqlFile(file);
    }
  }

  private execWrangler(args: string[], label: string): string {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_D1_ATTEMPTS; attempt++) {
      try {
        return execFileSync('npx', args, {
          cwd: process.cwd(),
          encoding: 'utf8',
          maxBuffer: 120 * 1024 * 1024,
        });
      } catch (error) {
        lastError = error;
        if (attempt < MAX_D1_ATTEMPTS) sleepSync(1000 * attempt);
      }
    }
    throw new Error(formatWranglerError(lastError, label));
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function parseWranglerJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const jsonStart = stdout.lastIndexOf('\n[');
    if (jsonStart >= 0) return JSON.parse(stdout.slice(jsonStart + 1));
    const trimmed = stdout.trim();
    const bracketStart = trimmed.indexOf('[');
    if (bracketStart >= 0) return JSON.parse(trimmed.slice(bracketStart));
    throw new Error(`WRANGLER_JSON_PARSE_FAILED:${stdout.slice(0, 500)}`);
  }
}

function formatWranglerError(error: unknown, label: string): string {
  const maybe = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
  const stdout = typeof maybe.stdout === 'string' ? maybe.stdout : maybe.stdout?.toString('utf8') || '';
  const stderr = typeof maybe.stderr === 'string' ? maybe.stderr : maybe.stderr?.toString('utf8') || '';
  return [
    `WRANGLER_D1_COMMAND_FAILED status=${maybe.status ?? 'unknown'}`,
    maybe.message ? `message=${maybe.message}` : null,
    stderr ? `stderr=${stderr.slice(0, 2000)}` : null,
    stdout ? `stdout=${stdout.slice(0, 2000)}` : null,
    `label=${label.slice(0, 1000)}`,
  ].filter(Boolean).join('\n');
}

function finalName(row: DecisionRow): string {
  return String(
    row.final_quality_canonical_name ||
      row.prospect_company_name ||
      row.company_name ||
      ''
  ).replace(/\s+/g, ' ').trim();
}

function isFinalCreate(row: DecisionRow): boolean {
  const decision = row.final_quality_decision || '';
  return row.prospect_action === 'create_prospect' &&
    row.should_create_prospect === true &&
    row.final_quality_blocked !== true &&
    row.final_quality_attach_only !== true &&
    (decision === 'allow_create' || decision === 'rename_and_allow' || decision === '');
}

function decisionRowAuditText(row: DecisionRow): string {
  return [
    row.source_title,
    row.reasoning,
    row.reasoning_judge_reason,
    row.final_quality_reason,
    row.target_evidence_reasons,
    row.second_look_reasons,
    row.second_look_warnings,
  ].filter(Boolean).join(' ').toLowerCase();
}

function hasImportHardNonTargetRisk(row: DecisionRow): boolean {
  const text = decisionRowAuditText(row);
  return /\b(?:investor\s+list|vc\s+list|lp\s+list|fundraising\s+target(?:s)?|contact\s+directory|resume|curriculum\s+vitae|school|university|nonprofit|charity|foundation|philanthrop(?:y|ic)|consulting|consultant|advisor|adviser|service\s+provider|vendor|customer|buyer|lender|real\s+estate|property|calendar|security|billing|invoice|admin(?:istrative)?|document\s+(?:heading|wrapper)|text\s+fragment)\b/i.test(text) ||
    /\b(?:not|isn['’]?t|is\s+not)\s+(?:an?\s+|the\s+)?(?:investment\s+)?(?:target|prospect|opportunity|company\s+being\s+pitched)\b/i.test(text);
}

function hasImportStrongTargetEvidence(row: DecisionRow): boolean {
  const text = decisionRowAuditText(row);
  if (/\b(?:structured_pipeline_row_details|fundraising_list_row_details|warm_intro_target|private_pitch_document_target|candidate_pitch_document_target|meeting_or_diligence_target|final_create_evidence_with_target_support|accepted_second_look_strong_candidate_support)\b/i.test(text)) {
    return true;
  }
  const hasInvestment = /\b(?:pitch\s+deck|investor\s+deck|data\s+room|safe|term\s*sheet|valuation|allocation|diligence|raise|raising|fundrais(?:e|ing)|round|seed|series\s+[abc]|investment\s+opportunit(?:y|ies)|deal\s*flow|warm\s+intro)\b/i.test(text);
  const hasCandidateDetails = /\b(?:website|https?:\/\/|www\.|\.ai\b|\.com\b|\.io\b|\.co\b|\.tech\b|founder|ceo|contact|poc|description|product|platform|technology|revenue|arr|mrr|traction|bookings|pipeline|stage|amount|ask)\b/i.test(text);
  return hasInvestment && hasCandidateDetails;
}

function isMergeRecoveryCandidate(row: DecisionRow): boolean {
  return row.prospect_action === 'create_prospect' &&
    row.should_create_prospect === true &&
    row.final_quality_decision === 'merge_into_record' &&
    row.final_quality_blocked !== true &&
    Boolean(finalName(row)) &&
    hasImportStrongTargetEvidence(row) &&
    !hasImportHardNonTargetRisk(row);
}

function asDateValue(value: string | null | undefined): number {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function confidenceTier(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.65) return 'medium';
  return 'low';
}

function allowedDirection(direction: string | null | undefined): 'inbound' | 'outbound' | 'internal' | 'news' {
  return direction === 'outbound' || direction === 'internal' || direction === 'news' ? direction : 'inbound';
}

function allowedMentionType(value: string | null | undefined): 'inbound_prospect' | 'known_deal' | 'intro_source' | 'news' | 'noise' | 'web_analytics' {
  if (value === 'inbound_prospect' || value === 'known_deal' || value === 'intro_source' || value === 'news' || value === 'web_analytics') return value;
  return 'noise';
}

function derivedImportMentionType(row: DecisionRow, prospectId: string | null): ReturnType<typeof allowedMentionType> {
  const incoming = allowedMentionType(row.mention_type);
  const blocked = row.final_quality_blocked === true || row.final_quality_decision === 'block_create';
  if (prospectId && !blocked && incoming === 'inbound_prospect') return 'inbound_prospect';
  if (prospectId && !blocked && (isFinalCreate(row) || row.final_quality_decision === 'merge_into_record')) return 'inbound_prospect';
  if (incoming === 'known_deal' && (row.linked_deal_id || row.possible_deal_id)) return 'known_deal';
  if (!prospectId && (row.prospect_action === 'record_context' || row.prospect_action === 'ignore' || blocked || row.final_quality_attach_only === true)) return 'noise';
  if (!prospectId && incoming === 'inbound_prospect') return 'noise';
  return incoming;
}

function importSignalRole(row: DecisionRow, prospectId: string | null, mentionType: ReturnType<typeof allowedMentionType>): string {
  if (!prospectId) return mentionType === 'noise' ? 'context_or_noise' : 'unlinked_context';
  if (isFinalCreate(row)) return 'create_evidence';
  return 'supporting_context';
}

function signalText(row: DecisionRow): string {
  return [
    row.source_title,
    row.reasoning,
    row.reasoning_judge_reason,
    row.final_quality_reason,
    row.target_evidence_reasons,
  ].filter(Boolean).join(' ').toLowerCase();
}

function signalKind(row: DecisionRow): 'intro' | 'raise' | 'deck' | 'meeting' | 'list_entry' | 'cold_mention' | 'unknown' {
  const text = signalText(row);
  if (/\b(intro|introduced|warm intro|connect(?:ing)?)\b/.test(text)) return 'intro';
  if (/\b(deck|data room|memo|one[-\s]?pager|teaser)\b/.test(text)) return 'deck';
  if (/\b(raising|fundrais|round|safe|valuation|allocation|term sheet)\b/.test(text)) return 'raise';
  if (/\b(meeting|demo|call|diligence)\b/.test(text)) return 'meeting';
  if (/\b(list|pipeline|row|table|cohort)\b/.test(text)) return 'list_entry';
  if (/\b(cold|newsletter|news)\b/.test(text)) return 'cold_mention';
  return 'unknown';
}

function computeSignalStrength(rows: DecisionRow[]): { score: number; reasons: string[]; priority: 'eager' | 'lazy' } {
  const kinds = rows.map(signalKind);
  const reasons: string[] = [];
  let score = 20;
  if (kinds.includes('meeting')) { score += 35; reasons.push('meeting_or_call'); }
  if (kinds.includes('deck')) { score += 30; reasons.push('attached_deck_or_data_room'); }
  if (kinds.includes('intro')) { score += 25; reasons.push('named_dealmaker_intro'); }
  if (rows.length > 1) {
    score += Math.min(30, (rows.length - 1) * 12);
    reasons.push(`corroborated_${rows.length}_signals`);
  }
  if (kinds.every(kind => kind === 'list_entry')) { score -= 15; reasons.push('single_or_list_email_entry'); }
  if (kinds.every(kind => kind === 'cold_mention')) { score -= 10; reasons.push('cold_mention'); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, priority: score >= 60 ? 'eager' : 'lazy' };
}

function buildProspects(args: Args, rows: DecisionRow[], companiesById: Map<string, SnapshotCompany>): ProspectProjection[] {
  const groups = new Map<string, DecisionRow[]>();
  const aliasToGroup = new Map<string, string>();
  const mergeRecoveredGroups = new Set<string>();
  const addProjectionRow = (row: DecisionRow, recoveredMergeOnly = false) => {
    const aliases = prospectImportGroupAliases(finalName(row));
    const normalized = aliases.find(alias => aliasToGroup.has(alias))
      ? aliasToGroup.get(aliases.find(alias => aliasToGroup.has(alias)) || '') || aliases[0]
      : aliases[0];
    if (!normalized) return;
    const group = groups.get(normalized) || [];
    group.push(row);
    groups.set(normalized, group);
    for (const alias of aliases) aliasToGroup.set(alias, normalized);
    if (recoveredMergeOnly) mergeRecoveredGroups.add(normalized);
  };
  for (const row of rows.filter(isFinalCreate)) {
    addProjectionRow(row);
  }
  for (const row of rows.filter(isMergeRecoveryCandidate)) {
    const aliases = prospectImportGroupAliases(finalName(row));
    const existingGroup = aliases.map(alias => aliasToGroup.get(alias)).find(Boolean);
    if (existingGroup) {
      groups.get(existingGroup)?.push(row);
      continue;
    }
    addProjectionRow(row, true);
  }
  return Array.from(groups.entries()).map(([normalizedName, groupRows]) => {
    const sorted = [...groupRows].sort((a, b) => asDateValue(a.occurred_at) - asDateValue(b.occurred_at));
    const strongest = [...groupRows].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
    const companyId = groupRows.map(row => row.possible_company_id).find(Boolean) || null;
    const company = companyId ? companiesById.get(companyId) || null : null;
    const possibleDealId = groupRows.map(row => row.possible_deal_id).find(Boolean) || null;
    const sectorCounts = new Map<string, { count: number; confidence: number }>();
    for (const row of groupRows) {
      const key = row.sector_key || 'uncategorized';
      const current = sectorCounts.get(key) || { count: 0, confidence: 0 };
      current.count++;
      current.confidence = Math.max(current.confidence, Number(row.confidence || 0));
      sectorCounts.set(key, current);
    }
    const [sectorKey, sector] = Array.from(sectorCounts.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].confidence - a[1].confidence)[0] || ['uncategorized', { confidence: 0 }];
    const confidence = Math.max(...groupRows.map(row => Number(row.confidence || 0)).filter(Number.isFinite), 0);
    const strength = computeSignalStrength(groupRows);
    const canonicalName = finalName(strongest) || groupRows
      .map(finalName)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    return {
      id: stableUuid(`${args.orgId}:${normalizedName}`),
      canonicalName,
      normalizedName,
      domain: company?.domain || null,
      website: company?.website || (company?.domain ? `https://${company.domain}` : null),
      description: company?.description || null,
      sectorKey,
      sectorConfidence: sector.confidence,
      signalCount: groupRows.length,
      evidenceCount: groupRows.length,
      firstSeenAt: sorted[0]?.occurred_at || new Date().toISOString(),
      lastSeenAt: sorted[sorted.length - 1]?.occurred_at || sorted[0]?.occurred_at || new Date().toISOString(),
      confidence,
      provisional: !groupRows.some(row => row.provisional !== true),
      directionUncertain: false,
      possibleCompanyId: companyId,
      possibleDealId,
      signalStrength: strength.score,
      signalStrengthReasons: strength.reasons,
      enrichmentPriority: strength.priority,
      metadata: {
        imported_from_dry_run: true,
        import_run_dir: args.runDir,
        classifier_version: PROSPECT_CLASSIFIER_VERSION,
        create_signal_rows: groupRows.length,
        source_ids: Array.from(new Set(groupRows.map(row => row.source_id))).slice(0, 30),
        source_titles_sample: Array.from(new Set(groupRows.map(row => row.source_title).filter(Boolean))).slice(0, 10),
        representative_reasoning: strongest?.reasoning || null,
        representative_final_quality_reason: strongest?.final_quality_reason || null,
        import_recovered_merge_only_group: mergeRecoveredGroups.has(normalizedName),
      },
    };
  }).sort((a, b) => b.signalCount - a.signalCount || a.canonicalName.localeCompare(b.canonicalName));
}

function buildProspectInsert(prospect: ProspectProjection, orgId: string): string {
  return `INSERT INTO prospects (
  id, org_id, canonical_name, normalized_name, domain, company_id, deal_id,
  status, visibility, sector_key, sector_confidence, website, description, hq_location,
  founders_json, signal_count, evidence_count, first_seen_at, last_seen_at, last_signal_at,
  intro_source, signal_strength, signal_strength_reasons, enrichment_priority, enrichment_status,
  confidence, provisional, direction_uncertain, possible_duplicate_of, possible_company_id,
  possible_deal_id, metadata_json, custom_fields, created_at, updated_at, deleted_at
) VALUES (
  ${sqlString(prospect.id)}, ${sqlString(orgId)}, ${sqlString(prospect.canonicalName)}, ${sqlString(prospect.normalizedName)},
  ${sqlString(prospect.domain)}, NULL, NULL, ${sqlString(prospect.provisional ? 'provisional' : 'active')}, 'firm',
  ${sqlString(prospect.sectorKey)}, ${sqlNumber(prospect.sectorConfidence)}, ${sqlString(prospect.website)},
  ${sqlString(prospect.description)}, NULL, '[]', ${prospect.signalCount}, ${prospect.evidenceCount},
  ${sqlString(prospect.firstSeenAt)}, ${sqlString(prospect.lastSeenAt)}, ${sqlString(prospect.lastSeenAt)},
  NULL, ${prospect.signalStrength}, ${sqlString(JSON.stringify(prospect.signalStrengthReasons))},
  ${sqlString(prospect.enrichmentPriority)}, 'not_started', ${sqlNumber(prospect.confidence)},
  ${sqlBool(prospect.provisional)}, ${sqlBool(prospect.directionUncertain)}, NULL,
  ${sqlString(prospect.possibleCompanyId)}, ${sqlString(prospect.possibleDealId)},
  ${sqlString(JSON.stringify(prospect.metadata))}, '{}', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL
)
ON CONFLICT(org_id, normalized_name) WHERE deleted_at IS NULL DO UPDATE SET
  canonical_name = excluded.canonical_name,
  domain = COALESCE(prospects.domain, excluded.domain),
  website = COALESCE(prospects.website, excluded.website),
  description = COALESCE(prospects.description, excluded.description),
  sector_key = CASE WHEN prospects.sector_key = 'uncategorized' OR excluded.sector_confidence > prospects.sector_confidence THEN excluded.sector_key ELSE prospects.sector_key END,
  sector_confidence = MAX(prospects.sector_confidence, excluded.sector_confidence),
  first_seen_at = CASE WHEN prospects.first_seen_at IS NULL OR excluded.first_seen_at < prospects.first_seen_at THEN excluded.first_seen_at ELSE prospects.first_seen_at END,
  last_seen_at = CASE WHEN prospects.last_seen_at IS NULL OR excluded.last_seen_at > prospects.last_seen_at THEN excluded.last_seen_at ELSE prospects.last_seen_at END,
  last_signal_at = CASE WHEN prospects.last_signal_at IS NULL OR excluded.last_signal_at > prospects.last_signal_at THEN excluded.last_signal_at ELSE prospects.last_signal_at END,
  signal_count = MAX(prospects.signal_count, excluded.signal_count),
  evidence_count = MAX(prospects.evidence_count, excluded.evidence_count),
  signal_strength = MAX(prospects.signal_strength, excluded.signal_strength),
  signal_strength_reasons = CASE WHEN excluded.signal_strength > prospects.signal_strength THEN excluded.signal_strength_reasons ELSE prospects.signal_strength_reasons END,
  enrichment_priority = CASE WHEN prospects.enrichment_priority = 'eager' THEN prospects.enrichment_priority ELSE excluded.enrichment_priority END,
       confidence = MAX(prospects.confidence, excluded.confidence),
  status = CASE
    WHEN prospects.status IN ('active','converted') THEN prospects.status
    WHEN excluded.provisional = 0 THEN 'active'
    ELSE 'provisional'
  END,
  provisional = CASE
    WHEN prospects.status IN ('active','converted') THEN 0
    WHEN excluded.provisional = 0 THEN 0
    ELSE 1
  END,
  direction_uncertain = CASE WHEN excluded.direction_uncertain = 1 THEN 1 ELSE prospects.direction_uncertain END,
  possible_company_id = COALESCE(prospects.possible_company_id, excluded.possible_company_id),
  possible_deal_id = COALESCE(prospects.possible_deal_id, excluded.possible_deal_id),
  metadata_json = json_patch(COALESCE(prospects.metadata_json, '{}'), excluded.metadata_json),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
}

function buildIdentityAliasInserts(
  prospects: ProspectProjection[],
  prospectIds: Map<string, string>,
  orgId: string
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const prospect of prospects) {
    const prospectId = prospectIds.get(prospect.normalizedName) || prospect.id;
    for (const alias of buildEntityIdentityAliasValues({
      name: prospect.canonicalName,
      normalizedName: prospect.normalizedName,
      domain: prospect.domain,
      website: prospect.website,
    })) {
      const key = `prospect:${prospectId}:${alias.aliasKind}:${alias.aliasValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = {
        source: 'prospect_artifact_import',
        canonical_name: prospect.canonicalName,
        normalized_name: prospect.normalizedName,
      };
      out.push(`INSERT INTO entity_identity_aliases (
  org_id, entity_type, entity_id, alias_kind, alias_value, confidence, source_kind, evidence_json,
  created_at, updated_at
) VALUES (
  ${sqlString(orgId)}, 'prospect', ${sqlString(prospectId)}, ${sqlString(alias.aliasKind)}, ${sqlString(alias.aliasValue)},
  ${sqlNumber(alias.confidence)}, 'migration', ${sqlString(JSON.stringify(evidence))},
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(org_id, entity_type, entity_id, alias_kind, alias_value) DO UPDATE SET
  confidence = MAX(entity_identity_aliases.confidence, excluded.confidence),
  source_kind = excluded.source_kind,
  evidence_json = excluded.evidence_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`);
    }
  }
  return out;
}

function signalProspectNormalized(row: DecisionRow): string | null {
  if (isFinalCreate(row)) return normalizeProspectName(finalName(row));
  if (row.final_quality_decision === 'merge_into_record' && row.final_quality_canonical_name) {
    const normalized = normalizeProspectName(row.final_quality_canonical_name);
    return normalized || null;
  }
  return null;
}

function buildSignalInsert(row: DecisionRow, orgId: string, prospectIdByNormalized: Map<string, string>): string {
  const confidence = Number(row.confidence || 0);
  const normalized = normalizeProspectName(row.normalized_company_name || row.company_name || row.prospect_company_name || '');
  const prospectNormalized = signalProspectNormalized(row);
  const prospectId = prospectNormalized ? prospectIdByNormalized.get(prospectNormalized) || null : null;
  const mentionType = derivedImportMentionType(row, prospectId);
  const kind = signalKind(row);
  const errored = Boolean(row.error);
  const metadata = {
    imported_from_dry_run: true,
    classifier: 'llm_req_cl',
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    import_original_mention_type: row.mention_type,
    import_derived_mention_type: mentionType,
    import_signal_role: importSignalRole(row, prospectId, mentionType),
    prospect_action: row.prospect_action,
    should_create_prospect: row.should_create_prospect,
    prospect_company_name: row.prospect_company_name,
    llm_reasoning: row.reasoning,
    reasoning_judge_action: row.reasoning_judge_action,
    reasoning_judge_reason: row.reasoning_judge_reason,
    target_evidence_reasons: row.target_evidence_reasons,
    prospect_final_quality_gate: {
      decision: row.final_quality_decision || null,
      canonical_name: row.final_quality_canonical_name || null,
      blocked: row.final_quality_blocked || false,
      renamed: row.final_quality_renamed || false,
      merged: row.final_quality_merged || false,
      attach_only: row.final_quality_attach_only || false,
      merge_target: row.final_quality_merge_target || null,
      reason: row.final_quality_reason || null,
    },
    prospect_second_look: {
      lane: row.second_look_lane || null,
      reasons: row.second_look_reasons || null,
      warnings: row.second_look_warnings || null,
    },
  };
  const resolutionStatus = errored
    ? 'pending'
    : mentionType === 'noise' && row.prospect_action === 'ignore'
      ? 'dropped'
      : 'resolved';
  return `INSERT INTO prospect_signals (
  id, org_id, prospect_id, deal_id, company_id, source_type, source_id, mention_ordinal,
  span_start, span_end, raw_mention_text, normalized_mention, source_title,
  occurred_at, direction, direction_source, direction_uncertain,
  mention_type, classifier_version, confidence, confidence_tier,
  classification_status, resolution_status, error_message, classification_attempts, last_attempted_at,
  sector_key, sector_confidence, signal_kind, dealmaker_id, dealmaker_name,
  has_deck, has_meeting, ingestion_mode, metadata_json, created_at, updated_at
) VALUES (
  ${sqlString(stableUuid(`${orgId}:${row.source_type}:${row.source_id}:${row.mention_ordinal}`))},
  ${sqlString(orgId)}, ${sqlString(prospectId)}, ${sqlString(row.linked_deal_id || row.possible_deal_id)},
  ${sqlString(row.possible_company_id)}, ${sqlString(row.source_type)}, ${sqlString(row.source_id)}, ${Number(row.mention_ordinal || 0)},
  NULL, NULL, ${sqlString(row.company_name || row.prospect_company_name || row.source_title || row.source_id)},
  ${sqlString(normalized || normalizeProspectName(row.company_name || row.prospect_company_name || row.source_id))},
  ${sqlString(row.source_title)}, ${sqlString(row.occurred_at || new Date().toISOString())},
  ${sqlString(allowedDirection(row.direction))}, 'llm', 0, ${sqlString(mentionType)},
  ${sqlString(PROSPECT_CLASSIFIER_VERSION)}, ${sqlNumber(confidence)}, ${sqlString(confidenceTier(confidence))},
  ${sqlString(errored ? 'failed' : 'classified')}, ${sqlString(resolutionStatus)}, ${sqlString(row.error)},
  1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${sqlString(row.sector_key || 'uncategorized')},
  ${sqlNumber(confidence)}, ${sqlString(kind)}, NULL, NULL,
  ${/\b(deck|data room|memo|one[-\s]?pager|teaser)\b/.test(signalText(row)) ? 1 : 0},
  ${/\b(meeting|demo|call|diligence)\b/.test(signalText(row)) ? 1 : 0},
  'backfill', ${sqlString(JSON.stringify(metadata))}, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(org_id, source_type, source_id, mention_ordinal) DO UPDATE SET
  prospect_id = excluded.prospect_id,
  deal_id = excluded.deal_id,
  company_id = excluded.company_id,
  raw_mention_text = excluded.raw_mention_text,
  normalized_mention = excluded.normalized_mention,
  source_title = excluded.source_title,
  occurred_at = excluded.occurred_at,
  direction = excluded.direction,
  mention_type = excluded.mention_type,
  classifier_version = excluded.classifier_version,
  confidence = excluded.confidence,
  confidence_tier = excluded.confidence_tier,
  classification_status = excluded.classification_status,
  resolution_status = excluded.resolution_status,
  error_message = excluded.error_message,
  classification_attempts = excluded.classification_attempts,
  last_attempted_at = excluded.last_attempted_at,
  sector_key = excluded.sector_key,
  sector_confidence = excluded.sector_confidence,
  signal_kind = excluded.signal_kind,
  has_deck = excluded.has_deck,
  has_meeting = excluded.has_meeting,
  ingestion_mode = excluded.ingestion_mode,
  metadata_json = excluded.metadata_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
}

function tableCountSql(table: string, orgId: string): string {
  return `SELECT COUNT(*) AS count FROM ${table} WHERE org_id=${sqlString(orgId)}`;
}

function tableHasAnyRowsSql(table: string, orgId: string): string {
  return `SELECT id FROM ${table} WHERE org_id=${sqlString(orgId)} LIMIT 1`;
}

function countInsertedIds(db: WranglerD1, table: string, ids: string[]): number {
  let count = 0;
  const unique = Array.from(new Set(ids));
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const rows = db.execute<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM ${table}
        WHERE id IN (${chunk.map(sqlString).join(',')})`
    );
    count += Number(rows[0]?.count || 0);
  }
  return count;
}

function recomputeProspectAggregateSql(orgId: string): string {
  return `UPDATE prospects
     SET signal_count = COALESCE((
           SELECT COUNT(*)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
         ), 0),
         evidence_count = COALESCE((
           SELECT COUNT(*)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.classification_status = 'classified'
              AND s.resolution_status = 'resolved'
         ), 0),
         first_seen_at = COALESCE((
           SELECT MIN(s.occurred_at)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.occurred_at IS NOT NULL
         ), first_seen_at),
         last_seen_at = COALESCE((
           SELECT MAX(s.occurred_at)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.occurred_at IS NOT NULL
         ), last_seen_at),
         last_signal_at = COALESCE((
           SELECT MAX(s.occurred_at)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
              AND s.occurred_at IS NOT NULL
         ), last_signal_at),
         confidence = COALESCE((
           SELECT MAX(s.confidence)
             FROM prospect_signals s
            WHERE s.org_id = prospects.org_id
              AND s.prospect_id = prospects.id
         ), confidence),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE org_id = ${sqlString(orgId)}
     AND deleted_at IS NULL
     AND id IN (
       SELECT DISTINCT prospect_id
         FROM prospect_signals
        WHERE org_id = ${sqlString(orgId)}
          AND prospect_id IS NOT NULL
     );`;
}

function assertExpected(args: Args, prospects: ProspectProjection[], signals: DecisionRow[]): void {
  if (args.expectProspects !== null && prospects.length !== args.expectProspects) {
    throw new Error(`PROSPECT_IMPORT_EXPECTED_PROSPECTS:${args.expectProspects}:got:${prospects.length}`);
  }
  if (args.expectSignals !== null && signals.length !== args.expectSignals) {
    throw new Error(`PROSPECT_IMPORT_EXPECTED_SIGNALS:${args.expectSignals}:got:${signals.length}`);
  }
}

function loadCompanies(runDir: string): Map<string, SnapshotCompany> {
  const snapshotPath = join(runDir, 'input', 'd1-context-snapshot.json');
  if (!existsSync(snapshotPath)) return new Map();
  const snapshot = readJson<{ companies?: SnapshotCompany[] }>(snapshotPath);
  return new Map((snapshot.companies || []).map(company => [company.id, company]));
}

function loadDecisions(runDir: string): DecisionRow[] {
  const decisionsPath = join(runDir, 'merged', 'dry-run-decisions.jsonl');
  if (!existsSync(decisionsPath)) throw new Error(`MISSING_DRY_RUN_DECISIONS:${decisionsPath}`);
  return readJsonl<DecisionRow>(decisionsPath);
}

function queryProspectIds(db: WranglerD1, orgId: string, normalizedNames: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let index = 0; index < normalizedNames.length; index += 100) {
    const chunk = normalizedNames.slice(index, index + 100);
    const rows = db.execute<{ id: string; normalized_name: string }>(
      `SELECT id, normalized_name
         FROM prospects
        WHERE org_id=${sqlString(orgId)}
          AND deleted_at IS NULL
          AND normalized_name IN (${chunk.map(sqlString).join(',')})`
    );
    for (const row of rows) out.set(row.normalized_name, row.id);
  }
  return out;
}

export async function runProspectArtifactImport(args: Args): Promise<Record<string, unknown>> {
  mkdirSync(args.outputDir, { recursive: true });
  const decisions = loadDecisions(args.runDir);
  const companiesById = loadCompanies(args.runDir);
  const prospects = buildProspects(args, decisions, companiesById);
  assertExpected(args, prospects, decisions);
  const projection = {
    dry_run: !args.apply,
    org_id: args.orgId,
    database: args.database,
    run_dir: args.runDir,
    output_dir: args.outputDir,
    classifier_version: PROSPECT_CLASSIFIER_VERSION,
    projected_prospects: prospects.length,
    projected_signals: decisions.length,
    final_create_signals: decisions.filter(isFinalCreate).length,
    projected_prospect_names: prospects.map(row => row.canonicalName),
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'projection.json'), JSON.stringify(projection, null, 2));
  writeFileSync(join(args.outputDir, 'prospects-projection.jsonl'), prospects.map(row => JSON.stringify(row)).join('\n') + '\n');

  if (!args.apply) return projection;
  if (args.confirmProductionWrite !== IMPORT_CONFIRMATION) {
    throw new Error(`PROSPECT_IMPORT_REQUIRES_EXPLICIT_GO: pass --apply true --confirm-production-write ${IMPORT_CONFIRMATION}`);
  }

  const db = new WranglerD1(args.database, args.outputDir);
  if (args.requireEmpty) {
    const existingProspect = db.execute<{ id: string }>(tableHasAnyRowsSql('prospects', args.orgId))[0]?.id || null;
    const existingSignal = db.execute<{ id: string }>(tableHasAnyRowsSql('prospect_signals', args.orgId))[0]?.id || null;
    if (existingProspect || existingSignal) {
      throw new Error(`PROSPECT_IMPORT_TARGET_NOT_EMPTY:prospect_id=${existingProspect || 'none'}:signal_id=${existingSignal || 'none'}`);
    }
  }

  db.runChunk('prospects', prospects.map(row => buildProspectInsert(row, args.orgId)));
  const prospectIds = queryProspectIds(db, args.orgId, prospects.map(row => row.normalizedName));
  db.runChunk('identity-aliases', buildIdentityAliasInserts(prospects, prospectIds, args.orgId));
  db.runChunk('signals', decisions.map(row => buildSignalInsert(row, args.orgId, prospectIds)));
  db.runChunk('prospect-aggregates', [recomputeProspectAggregateSql(args.orgId)]);

  const projectedSignalIds = decisions.map(row => stableUuid(`${args.orgId}:${row.source_type}:${row.source_id}:${row.mention_ordinal}`));
  const after = {
    prospects: countInsertedIds(db, 'prospects', prospects.map(row => row.id)),
    prospect_signals: countInsertedIds(db, 'prospect_signals', projectedSignalIds),
  };
  const summary = {
    ...projection,
    dry_run: false,
    imported: true,
    after,
    d1_meta: db.meta,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(join(args.outputDir, 'manifest.json'), JSON.stringify(summary, null, 2));
  return summary;
}

async function main(): Promise<void> {
  const summary = await runProspectArtifactImport(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

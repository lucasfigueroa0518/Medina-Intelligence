#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Papa from 'papaparse';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, 'outputs', 'crm-stage1-investigation-20260619');
const ORIGINAL_REVIEW_CSV = '/Users/lucasfigueroa/HELIOS/AI CLIENTS/Medina/crm-quality-review-2026-06-03.csv';

interface Args {
  outputDir: string;
  workerUrl: string;
  token: string;
  runId: string;
  shardCount: number;
  companyCount: number;
  contactCount: number;
  companyFirstTimeCount: number;
  contactFirstTimeCount: number;
}

interface SourceRow {
  sample_index: number;
  entity_type: 'company' | 'contact';
  entity_id: string;
  org_id: string;
  source_snapshot_name_for_review: string;
  email?: string | null;
  domain?: string | null;
  website?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  mode: 'first_time' | 'all_evidence';
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
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
  const runId = raw.get('run-id') || `crm-quality-cloud-canary-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
  const outputDir = resolve(raw.get('output-dir') || join(DEFAULT_OUTPUT_ROOT, runId));
  const workerUrl = clean(raw.get('worker-url'));
  const token = clean(raw.get('token') || process.env.CRM_CANARY_TOKEN);
  const shardCount = Number(raw.get('shard-count') || 8);
  const companyCount = Number(raw.get('company-count') || raw.get('companies') || 150);
  const contactCount = Number(raw.get('contact-count') || raw.get('contacts') || 150);
  const companyFirstTimeCount = Number(raw.get('company-first-time-count') || raw.get('company-first-time') || Math.floor(companyCount / 2));
  const contactFirstTimeCount = Number(raw.get('contact-first-time-count') || raw.get('contact-first-time') || Math.floor(contactCount / 2));
  if (!workerUrl) throw new Error('MISSING_WORKER_URL');
  if (!token) throw new Error('MISSING_TOKEN');
  if (!Number.isFinite(shardCount) || shardCount < 1 || shardCount > 32) throw new Error('INVALID_SHARD_COUNT');
  if (!Number.isInteger(companyCount) || companyCount < 0 || companyCount > 2500) throw new Error('INVALID_COMPANY_COUNT');
  if (!Number.isInteger(contactCount) || contactCount < 0 || contactCount > 2500) throw new Error('INVALID_CONTACT_COUNT');
  if (companyCount + contactCount < 1 || companyCount + contactCount > 5000) throw new Error('INVALID_TOTAL_ROW_COUNT');
  if (!Number.isInteger(companyFirstTimeCount) || companyFirstTimeCount < 0 || companyFirstTimeCount > companyCount) throw new Error('INVALID_COMPANY_FIRST_TIME_COUNT');
  if (!Number.isInteger(contactFirstTimeCount) || contactFirstTimeCount < 0 || contactFirstTimeCount > contactCount) throw new Error('INVALID_CONTACT_FIRST_TIME_COUNT');
  return {
    outputDir,
    workerUrl: workerUrl.replace(/\/$/, ''),
    token,
    runId,
    shardCount,
    companyCount,
    contactCount,
    companyFirstTimeCount,
    contactFirstTimeCount,
  };
}

function collectCsvFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCsvFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.csv')) out.push(path);
  }
  return out;
}

function collectExcludedEntityIds(): Set<string> {
  const ids = new Set<string>();
  const files = [
    ...collectCsvFiles(DEFAULT_OUTPUT_ROOT),
    ...(existsSync(ORIGINAL_REVIEW_CSV) ? [ORIGINAL_REVIEW_CSV] : []),
  ];
  for (const file of files) {
    const parsed = Papa.parse<Record<string, string>>(readFileSync(file, 'utf8'), { header: true, skipEmptyLines: true });
    if (parsed.errors.length) continue;
    for (const row of parsed.data) {
      const id = clean(row.entity_id || row.id || row.contact_id || row.company_id);
      if (/^[a-f0-9-]{8,}$/i.test(id)) ids.add(id);
    }
  }
  return ids;
}

function d1Query<T>(sql: string): T[] {
  const stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', 'medina-ventures-db', '--remote', '--json', '--command', sql], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 64,
  });
  const parsed = JSON.parse(stdout) as Array<{ results?: T[]; success?: boolean }>;
  if (parsed.some(chunk => chunk.success === false)) throw new Error(`D1_QUERY_FAILED:${stdout.slice(0, 500)}`);
  return parsed.flatMap(chunk => chunk.results || []);
}

function normalizeDomain(value: string): string {
  return clean(value).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

function shuffle<T>(rows: T[], seed: string): T[] {
  return [...rows].map((row, index) => ({
    row,
    sort: crypto.createHash('sha256').update(`${seed}:${index}:${JSON.stringify(row)}`).digest('hex'),
  })).sort((a, b) => a.sort.localeCompare(b.sort)).map(item => item.row);
}

function selectCompanies(excluded: Set<string>, runId: string, count: number, firstTimeCount: number): SourceRow[] {
  if (count === 0) return [];
  const rows = d1Query<any>(`
    SELECT id, org_id, name, domain, website
      FROM companies
     WHERE deleted_at IS NULL
       AND merged_into IS NULL
       AND COALESCE(is_internal_entity, 0) = 0
       AND TRIM(name) != ''
       AND (TRIM(COALESCE(domain, '')) != '' OR TRIM(COALESCE(website, '')) != '')
     ORDER BY random()
     LIMIT ${Math.max(1200, count * 4)}
  `).filter(row => !excluded.has(clean(row.id)));
  const selected = shuffle(rows, `${runId}:companies`).slice(0, count);
  if (selected.length < count) throw new Error(`NOT_ENOUGH_UNTOUCHED_COMPANIES:${selected.length}`);
  return selected.map((row, index) => ({
    sample_index: index + 1,
    entity_type: 'company',
    entity_id: clean(row.id),
    org_id: clean(row.org_id),
    source_snapshot_name_for_review: clean(row.name),
    domain: normalizeDomain(row.domain || row.website),
    website: clean(row.website),
    mode: index < firstTimeCount ? 'first_time' : 'all_evidence',
  }));
}

function selectContacts(excluded: Set<string>, runId: string, count: number, firstTimeCount: number, sampleIndexOffset: number): SourceRow[] {
  if (count === 0) return [];
  const rows = d1Query<any>(`
    SELECT c.id, c.org_id, c.full_name, c.email, c.company_id,
           co.name AS company_name, co.domain AS company_domain, co.website AS company_website
      FROM contacts c
      LEFT JOIN companies co ON co.id = c.company_id AND co.org_id = c.org_id AND co.deleted_at IS NULL
     WHERE c.deleted_at IS NULL
       AND c.merged_into IS NULL
       AND TRIM(c.full_name) != ''
       AND TRIM(COALESCE(c.email, '')) != ''
     ORDER BY random()
     LIMIT ${Math.max(1200, count * 4)}
  `).filter(row => !excluded.has(clean(row.id)));
  const selected = shuffle(rows, `${runId}:contacts`).slice(0, count);
  if (selected.length < count) throw new Error(`NOT_ENOUGH_UNTOUCHED_CONTACTS:${selected.length}`);
  return selected.map((row, index) => ({
    sample_index: sampleIndexOffset + index + 1,
    entity_type: 'contact',
    entity_id: clean(row.id),
    org_id: clean(row.org_id),
    source_snapshot_name_for_review: clean(row.full_name),
    email: clean(row.email),
    company_id: clean(row.company_id),
    company_name: clean(row.company_name),
    company_domain: normalizeDomain(row.company_domain || row.company_website),
    mode: index < firstTimeCount ? 'first_time' : 'all_evidence',
  }));
}

function experimentManifestRows(runId: string, rows: SourceRow[]): Array<Record<string, unknown>> {
  return rows.map(row => ({
    experiment_id: runId,
    cohort: 'fresh_blind_generalization',
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    org_id: row.org_id,
    mode: row.mode,
    trigger_codepath: row.mode === 'first_time'
      ? `cloud_canary_${row.entity_type}_first_time_resolver`
      : `cloud_canary_${row.entity_type}_all_evidence_resolver`,
    source_snapshot_name_for_review: row.source_snapshot_name_for_review,
    email: row.email || '',
    domain: row.domain || row.company_domain || '',
    website: row.website || '',
    company_context: row.company_name || '',
    expected_name: '',
    expected_status: '',
    gold_available: false,
    runtime_allowed_fields: [
      row.source_snapshot_name_for_review ? 'source_snapshot_name_for_review' : '',
      row.email ? 'email' : '',
      row.domain || row.company_domain ? 'domain' : '',
      row.website ? 'website' : '',
      row.company_name ? 'company_context' : '',
      row.mode === 'all_evidence' ? 'existing_entity_evidence' : '',
      'production_like_evidence_bundle',
    ].filter(Boolean).join('; '),
  }));
}

async function postJson(url: string, token: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-canary-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WORKER_START_FAILED:${response.status}:${text.slice(0, 1000)}`);
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outputDir, { recursive: true });
  const excluded = collectExcludedEntityIds();
  const rows = [
    ...selectCompanies(excluded, args.runId, args.companyCount, args.companyFirstTimeCount),
    ...selectContacts(excluded, args.runId, args.contactCount, args.contactFirstTimeCount, args.companyCount),
  ];
  writeFileSync(join(args.outputDir, 'sample-manifest.csv'), `${Papa.unparse(rows, { quotes: true, newline: '\n' })}\n`);
  writeFileSync(join(args.outputDir, 'crm-name-quality-experiment-manifest.csv'), `${Papa.unparse(experimentManifestRows(args.runId, rows), { quotes: true, newline: '\n' })}\n`);
  writeFileSync(join(args.outputDir, 'start-request.json'), `${JSON.stringify({
    run_id: args.runId,
    shard_count: args.shardCount,
    row_count: rows.length,
    company_count: args.companyCount,
    contact_count: args.contactCount,
    company_first_time_count: args.companyFirstTimeCount,
    contact_first_time_count: args.contactFirstTimeCount,
    excluded_entity_ids: excluded.size,
    worker_url: args.workerUrl,
  }, null, 2)}\n`);
  const result = await postJson(`${args.workerUrl}/start`, args.token, {
    run_id: args.runId,
    shard_count: args.shardCount,
    rows,
  });
  writeFileSync(join(args.outputDir, 'start-response.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(args.outputDir, '.canary-token'), `${args.token}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...result, output_dir: args.outputDir }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

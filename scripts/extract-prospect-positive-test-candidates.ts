#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import { __prospectIntelligenceTestHooks, extractOrganizationMentionsFromSource } from '../src/lib/prospect-intelligence';
import { parseGoldRecords } from './prospect-classifier-spike';

type SourceType = 'conversation' | 'event' | 'document';
type SourceChannel = 'email' | 'slack' | 'meeting' | 'document';
type Stratum = 'enriched_inbound' | 'enriched_known_deal' | 'hard_negative' | 'representative' | 'best_effort_rare';
type ExpectedClass = 'inbound_prospect' | 'known_deal' | 'intro_source' | 'news' | 'noise';

interface Args {
  orgId: string;
  outputDir: string;
  existingGoldSetPath: string;
  database: string;
  bucket: string;
  configPath: string;
  maxTextChars: number;
  allowLlmExtraction: boolean;
}

interface RemoteMeta {
  rows_read?: number;
  rows_written?: number;
  changed_db?: boolean;
}

interface RemoteQueryResult<T> {
  results: T[];
  meta: RemoteMeta;
}

interface SourceCandidate {
  sourceType: SourceType;
  sourceChannel: SourceChannel;
  sourceId: string;
  sourceTitle: string;
  occurredAt: string;
  senderAndContext: string;
  bodyText: string;
  bodyPreview?: string | null;
  fromEmail?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  direction?: 'inbound' | 'outbound' | 'internal' | null;
  stratum: Stratum;
  expectedClass: ExpectedClass;
  r2Key?: string | null;
  rank: number;
}

interface KnownEntity {
  name: string;
  domain: string | null;
}

interface OutputRecord {
  source_type: SourceType;
  source_id: string;
  mention_ordinal: number;
  deterministic_key: string;
  company_as_mentioned: string;
  raw_span: string;
  surrounding_context: string;
  source_subject: string;
  source_sender: string;
  occurred_at: string;
  context_char_count: number;
  sender_and_context: string;
  stratum: Stratum;
  split: 'test';
  mention_type: '';
  direction: '';
  sector_key: '';
  notes: '';
  expected_class: ExpectedClass;
}

const TARGETS: Record<Stratum | 'best_effort_intro_source' | 'best_effort_news', number> = {
  enriched_inbound: 45,
  enriched_known_deal: 45,
  hard_negative: 55,
  representative: 30,
  best_effort_rare: 24,
  best_effort_intro_source: 12,
  best_effort_news: 12,
};

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args.set(key, 'true');
    else {
      args.set(key, next);
      i += 1;
    }
  }
  const orgId = args.get('org-id') || 'medina-ventures';
  const maxTextChars = Number(args.get('max-text-chars') || 6000);
  return {
    orgId,
    outputDir: args.get('output-dir') || '.prospect-gold-set/positive-enriched-test',
    existingGoldSetPath: args.get('existing-gold-set') || '/Users/lucasfigueroa/Downloads/gold-candidates.human-labeling.qa-clean.csv',
    database: args.get('database') || 'medina-ventures-db',
    bucket: args.get('bucket') || 'medina-ventures-storage',
    configPath: args.get('config') || 'wrangler.toml',
    maxTextChars: Number.isFinite(maxTextChars) ? maxTextChars : 6000,
    allowLlmExtraction: args.get('allow-llm-extraction') === 'true',
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value: string | null | undefined): string {
  return __prospectIntelligenceTestHooks.normalizeProspectName(value || '');
}

function compactText(value: unknown, max = 500): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trim()}...` : text;
}

function parseEmailList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return text.split(/[;,]/).map(v => v.trim()).filter(Boolean);
}

function runWranglerJson<T>(args: string[]): RemoteQueryResult<T> {
  const stdout = execFileSync('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Array<{ results?: T[]; meta?: RemoteMeta; success?: boolean }>;
  const first = parsed[0] || {};
  return { results: first.results || [], meta: first.meta || {} };
}

function remoteSelect<T>(db: string, command: string): RemoteQueryResult<T> {
  return runWranglerJson<T>(['d1', 'execute', db, '--remote', '--command', command, '--json']);
}

function r2Get(bucket: string, key: string, maxChars: number): string | null {
  const path = join(tmpdir(), `prospect-r2-${hash(key).slice(0, 16)}.txt`);
  try {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', path], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 5 * 1024 * 1024,
    });
    return readFileSync(path, 'utf8').slice(0, maxChars);
  } catch {
    return null;
  }
}

function recordRemoteMeta(total: RemoteMeta, meta: RemoteMeta): void {
  total.rows_read = (total.rows_read || 0) + Number(meta.rows_read || 0);
  total.rows_written = (total.rows_written || 0) + Number(meta.rows_written || 0);
  total.changed_db = Boolean(total.changed_db || meta.changed_db);
}

async function loadExistingSourceIds(path: string): Promise<Set<string>> {
  const text = await readFile(path, 'utf8');
  const rows = parseGoldRecords(text, path);
  return new Set(rows.map(row => `${row.source_type}:${row.source_id}`));
}

function sourceKey(row: SourceCandidate): string {
  return `${row.sourceType}:${row.sourceId}`;
}

function sourceText(row: any): string {
  return [row.subject, row.title, row.body_preview, row.summary, row.description, row.extracted_text_preview]
    .filter(Boolean)
    .join('\n');
}

async function hydrateSourceText(args: Args, row: any): Promise<string> {
  const r2Key = row.body_r2_key || row.transcript_r2_key || null;
  if (r2Key) {
    const text = r2Get(args.bucket, r2Key, args.maxTextChars);
    if (text) return text;
  }
  return sourceText(row).slice(0, args.maxTextChars);
}

function toConversation(row: any, stratum: Stratum, expectedClass: ExpectedClass, rank: number, text: string): SourceCandidate {
  const sourceChannel: SourceChannel = row.source === 'slack' ? 'slack' : 'email';
  return {
    sourceType: 'conversation',
    sourceChannel,
    sourceId: row.id,
    sourceTitle: row.subject || row.source || '',
    occurredAt: row.sent_at || row.created_at || '',
    senderAndContext: compactText(`from ${row.from_email || 'unknown'}; subject ${row.subject || '(none)'}; channel ${row.source}; sent ${row.sent_at || row.created_at || ''}`),
    bodyText: text,
    bodyPreview: row.body_preview,
    fromEmail: row.from_email,
    toEmails: parseEmailList(row.to_emails),
    ccEmails: parseEmailList(row.cc_emails),
    direction: row.direction || null,
    stratum,
    expectedClass,
    r2Key: row.body_r2_key || null,
    rank,
  };
}

function toEvent(row: any, stratum: Stratum, expectedClass: ExpectedClass, rank: number, text: string): SourceCandidate {
  return {
    sourceType: 'event',
    sourceChannel: 'meeting',
    sourceId: row.id,
    sourceTitle: row.title || '',
    occurredAt: row.start_time || row.created_at || '',
    senderAndContext: compactText(`event ${row.title}; type ${row.event_type}; source ${row.source}; start ${row.start_time}`),
    bodyText: text,
    bodyPreview: row.summary || row.description,
    stratum,
    expectedClass,
    r2Key: row.transcript_r2_key || null,
    rank,
  };
}

function toDocument(row: any, stratum: Stratum, expectedClass: ExpectedClass, rank: number, text: string): SourceCandidate {
  return {
    sourceType: 'document',
    sourceChannel: 'document',
    sourceId: row.id,
    sourceTitle: row.title || row.file_name || '',
    occurredAt: row.created_at || '',
    senderAndContext: compactText(`document ${row.title}; type ${row.document_type}; source ${row.source}; created ${row.created_at}`),
    bodyText: text,
    bodyPreview: row.extracted_text_preview,
    stratum,
    expectedClass,
    r2Key: null,
    rank,
  };
}

async function queryConversations(args: Args, meta: RemoteMeta, where: string, limit: number, stratum: Stratum, expectedClass: ExpectedClass): Promise<SourceCandidate[]> {
  const result = remoteSelect<any>(args.database, `
    SELECT id, source, subject, body_r2_key, body_preview, from_email, to_emails, cc_emails, direction, sent_at, created_at, has_attachments, attachment_count
      FROM conversations
     WHERE org_id = ${sqlString(args.orgId)}
       AND ${where}
     ORDER BY sent_at DESC, id ASC
     LIMIT ${limit}
  `);
  recordRemoteMeta(meta, result.meta);
  const out: SourceCandidate[] = [];
  let rank = 0;
  for (const row of result.results) out.push(toConversation(row, stratum, expectedClass, rank++, sourceText(row).slice(0, args.maxTextChars)));
  return out;
}

async function queryEvents(args: Args, meta: RemoteMeta, where: string, limit: number, stratum: Stratum, expectedClass: ExpectedClass): Promise<SourceCandidate[]> {
  const result = remoteSelect<any>(args.database, `
    SELECT id, title, event_type, start_time, source, description, summary, transcript_r2_key, created_at
      FROM events
     WHERE org_id = ${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND ${where}
     ORDER BY start_time DESC, id ASC
     LIMIT ${limit}
  `);
  recordRemoteMeta(meta, result.meta);
  const out: SourceCandidate[] = [];
  let rank = 0;
  for (const row of result.results) out.push(toEvent(row, stratum, expectedClass, rank++, sourceText(row).slice(0, args.maxTextChars)));
  return out;
}

async function queryDocuments(args: Args, meta: RemoteMeta, where: string, limit: number, stratum: Stratum, expectedClass: ExpectedClass): Promise<SourceCandidate[]> {
  const result = remoteSelect<any>(args.database, `
    SELECT id, title, document_type, source, extracted_text_preview, created_at, file_name
      FROM documents
     WHERE org_id = ${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND ${where}
     ORDER BY created_at DESC, id ASC
     LIMIT ${limit}
  `);
  recordRemoteMeta(meta, result.meta);
  return result.results.map((row, index) => toDocument(row, stratum, expectedClass, index, sourceText(row).slice(0, args.maxTextChars)));
}

function likeAny(columns: string[], terms: string[]): string {
  const clauses: string[] = [];
  for (const term of terms) {
    const pattern = sqlString(`%${term.toLowerCase()}%`);
    for (const column of columns) clauses.push(`lower(COALESCE(${column}, '')) LIKE ${pattern}`);
  }
  return `(${clauses.join(' OR ')})`;
}

async function loadKnownEntities(args: Args, meta: RemoteMeta): Promise<KnownEntity[]> {
  const result = remoteSelect<KnownEntity>(args.database, `
    SELECT DISTINCT c.name AS name, COALESCE(c.domain, c.website) AS domain
      FROM deals d
      JOIN companies c ON c.id = d.company_id
     WHERE d.org_id = ${sqlString(args.orgId)}
       AND d.deleted_at IS NULL
       AND c.deleted_at IS NULL
    UNION
    SELECT DISTINCT name, COALESCE(domain, website) AS domain
      FROM companies
     WHERE org_id = ${sqlString(args.orgId)}
       AND deleted_at IS NULL
       AND investment_status IN ('invested','exited')
  `);
  recordRemoteMeta(meta, result.meta);
  return result.results.filter(row => row.name);
}

async function loadSources(args: Args, meta: RemoteMeta, known: KnownEntity[]): Promise<SourceCandidate[]> {
  const sources: SourceCandidate[] = [];
  const inboundTerms = ['introducing', 'introduction', 'connect you with', 'warm intro', 'deck', 'pitch', 'raising', 'fundraise', 'diligence', 'demo'];
  const hardNegativeTerms = ['invoice', 'billing', 'docusign', 'greenberg', 'ramp', 'mastercard', 'investor', 'led by', 'newsletter', 'press', 'salesforce', 'verification', 'reseller', 'customer', 'partner'];
  const introTerms = ['introducing', 'introduction from', 'forwarding', 'deal flow', 'armyfuze', 'diu', 'accelerator', 'cohort'];
  const newsTerms = ['newsletter', 'smartbrief', 'press release', 'funding news', 'finsmes', 'nvca', 'announced', 'raised'];
  const knownTerms = [
    'qunnect',
    'neuralseek',
    'tier4',
    'tier4ai',
    'onid',
    'toluai',
    'critical materials',
    'critmatgroup',
    'technology dynamics',
    'techd',
    'doxx',
  ];

  sources.push(...await queryConversations(
    args,
    meta,
    `source != 'slack' AND lower(COALESCE(from_email, '')) NOT LIKE '%medinavc.com%' AND ${likeAny(['subject', 'body_preview'], inboundTerms)}`,
    180,
    'enriched_inbound',
    'inbound_prospect'
  ));
  sources.push(...await queryConversations(args, meta, likeAny(['subject', 'body_preview', 'from_email'], knownTerms), 180, 'enriched_known_deal', 'known_deal'));
  sources.push(...await queryEvents(args, meta, likeAny(['title', 'summary', 'description'], knownTerms), 80, 'enriched_known_deal', 'known_deal'));
  sources.push(...await queryDocuments(args, meta, likeAny(['title', 'extracted_text_preview'], knownTerms), 80, 'enriched_known_deal', 'known_deal'));
  sources.push(...await queryConversations(args, meta, likeAny(['subject', 'body_preview', 'from_email'], hardNegativeTerms), 180, 'hard_negative', 'noise'));
  sources.push(...await queryDocuments(args, meta, likeAny(['title', 'extracted_text_preview'], hardNegativeTerms), 80, 'hard_negative', 'noise'));
  sources.push(...await queryConversations(args, meta, '1=1', 80, 'representative', 'noise'));
  sources.push(...await queryEvents(args, meta, '1=1', 40, 'representative', 'noise'));
  sources.push(...await queryDocuments(args, meta, '1=1', 40, 'representative', 'noise'));
  sources.push(...await queryConversations(args, meta, likeAny(['subject', 'body_preview', 'from_email'], introTerms), 80, 'best_effort_rare', 'intro_source'));
  sources.push(...await queryEvents(args, meta, likeAny(['title', 'summary', 'description'], introTerms), 40, 'best_effort_rare', 'intro_source'));
  sources.push(...await queryConversations(args, meta, likeAny(['subject', 'body_preview', 'from_email'], newsTerms), 80, 'best_effort_rare', 'news'));
  sources.push(...await queryDocuments(args, meta, likeAny(['title', 'extracted_text_preview'], newsTerms), 80, 'best_effort_rare', 'news'));

  const seen = new Set<string>();
  const perTargetSeen: Record<string, number> = {};
  return sources.filter(source => {
    const key = `${sourceKey(source)}:${source.stratum}:${source.expectedClass}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!source.bodyText.trim() && !source.sourceTitle.trim()) return false;
    const tk = targetKey(source);
    const ceiling = Math.max(((TARGETS as any)[tk] || 24) * 4, 60);
    if ((perTargetSeen[tk] || 0) >= ceiling) return false;
    perTargetSeen[tk] = (perTargetSeen[tk] || 0) + 1;
    return true;
  });
}

function isKnownMention(mention: { normalizedName: string; raw: string; canonicalName: string }, known: KnownEntity[]): boolean {
  const name = mention.normalizedName;
  const raw = `${mention.raw} ${mention.canonicalName}`.toLowerCase();
  return known.some(entity => {
    const knownName = normalize(entity.name);
    const domain = (entity.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return Boolean((knownName && knownName === name) || (domain && raw.includes(domain)));
  });
}

function includeMentionForSource(source: SourceCandidate, mention: { normalizedName: string; raw: string; canonicalName: string }, known: KnownEntity[]): boolean {
  const knownMention = isKnownMention(mention, known);
  if (source.stratum === 'enriched_inbound') return !knownMention;
  if (source.stratum === 'enriched_known_deal') return knownMention;
  if (source.stratum === 'hard_negative') return !knownMention;
  if (source.stratum === 'best_effort_rare' && source.expectedClass === 'intro_source') {
    return /\b(capital|ventures?|partners?|accelerator|diu|armyfuze|sbir|advisors?|consultants?|syndicate)\b/i.test(mention.canonicalName);
  }
  return true;
}

function targetKey(source: SourceCandidate): string {
  if (source.stratum === 'best_effort_rare') return source.expectedClass === 'intro_source' ? 'best_effort_intro_source' : 'best_effort_news';
  return source.stratum;
}

async function extractMentionsForText(args: Args, env: Env, known: KnownEntity[], source: SourceCandidate, text: string, allowLlm: boolean) {
  return extractOrganizationMentionsFromSource({
    type: source.sourceChannel === 'email' ? 'email' : source.sourceChannel === 'slack' ? 'slack_message' : source.sourceChannel === 'meeting' ? 'calendar_event' : 'news',
    entityType: source.sourceType,
    entityId: source.sourceId,
    subject: source.sourceTitle,
    bodyText: text,
    bodyPreview: source.bodyPreview || undefined,
    fromEmail: source.fromEmail || undefined,
    toEmails: source.toEmails,
    ccEmails: source.ccEmails,
    direction: source.direction || undefined,
    sentAt: source.occurredAt,
    text,
  } as any, args.orgId, env, {
    knownContext: { knownDeals: known, knownDealmakers: [] },
    maxLlmOrganizations: 12,
    allowLlm,
  });
}

async function extractRecords(args: Args, env: Env, known: KnownEntity[], sources: SourceCandidate[], existingSources: Set<string>): Promise<OutputRecord[]> {
  const counts: Record<string, number> = {};
  const records: OutputRecord[] = [];
  const seen = new Set<string>();
  const sorted = [...sources].sort((a, b) => {
    const ta = targetKey(a);
    const tb = targetKey(b);
    if (ta !== tb) return ta.localeCompare(tb);
    return a.rank - b.rank || sourceKey(a).localeCompare(sourceKey(b));
  });

  for (const source of sorted) {
    const tk = targetKey(source);
    if ((counts[tk] || 0) >= (TARGETS as any)[tk]) continue;
    if (existingSources.has(sourceKey(source))) continue;
    const previewMentions = await extractMentionsForText(args, env, known, source, source.bodyText, false);
    if (!previewMentions.some(mention => includeMentionForSource(source, mention, known))) continue;

    let extractionText = source.bodyText;
    let mentions = previewMentions;
    if (source.r2Key) {
      const hydratedText = await hydrateSourceText(args, {
        body_r2_key: source.sourceType === 'conversation' ? source.r2Key : null,
        transcript_r2_key: source.sourceType === 'event' ? source.r2Key : null,
        body_preview: source.bodyPreview,
        summary: source.bodyPreview,
        subject: source.sourceTitle,
        title: source.sourceTitle,
      });
      if (hydratedText && hydratedText.trim()) {
        extractionText = hydratedText;
        mentions = await extractMentionsForText(args, env, known, source, extractionText, args.allowLlmExtraction);
      }
    } else if (args.allowLlmExtraction) {
      mentions = await extractMentionsForText(args, env, known, source, extractionText, true);
    }

    let addedForSource = 0;
    for (const mention of mentions) {
      if ((counts[tk] || 0) >= (TARGETS as any)[tk]) break;
      if (!includeMentionForSource(source, mention, known)) continue;
      const deterministicKey = `${source.sourceType}:${source.sourceId}:${mention.mentionOrdinal}:${mention.spanStart ?? 'na'}:${mention.spanEnd ?? 'na'}`;
      const dedupeKey = `${deterministicKey}:${mention.normalizedName}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const context = mention.contextText || mention.lineText || source.bodyText;
      records.push({
        source_type: source.sourceType,
        source_id: source.sourceId,
        mention_ordinal: mention.mentionOrdinal,
        deterministic_key: deterministicKey,
        company_as_mentioned: mention.canonicalName,
        raw_span: mention.raw,
        surrounding_context: compactText(context, 4000),
        source_subject: source.sourceTitle,
        source_sender: source.fromEmail || '',
        occurred_at: source.occurredAt,
        context_char_count: context.length,
        sender_and_context: source.senderAndContext,
        stratum: source.stratum,
        split: 'test',
        mention_type: '',
        direction: '',
        sector_key: '',
        notes: '',
        expected_class: source.expectedClass,
      });
      counts[tk] = (counts[tk] || 0) + 1;
      addedForSource += 1;
    }
    if (addedForSource > 0 && records.length % 25 === 0) {
      process.stderr.write(`selected ${records.length} rows; counts=${JSON.stringify(counts)}\n`);
    }
  }
  return records;
}

function csv(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function humanLabelingCsv(records: OutputRecord[]): string {
  const header = [
    'source_type', 'source_id', 'mention_ordinal', 'deterministic_key',
    'company_as_mentioned', 'raw_span', 'surrounding_context',
    'source_subject', 'source_sender', 'occurred_at', 'context_char_count',
    'sender_and_context', 'stratum', 'split',
    'mention_type', 'direction', 'sector_key', 'notes',
  ];
  const rows = [header.map(csv).join(',')];
  for (const record of records) {
    rows.push([
      record.source_type,
      record.source_id,
      record.mention_ordinal,
      record.deterministic_key,
      record.company_as_mentioned,
      record.raw_span,
      record.surrounding_context,
      record.source_subject,
      record.source_sender,
      record.occurred_at,
      record.context_char_count,
      record.sender_and_context,
      record.stratum,
      record.split,
      '',
      '',
      '',
      '',
    ].map(csv).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function countBy<T extends string>(records: OutputRecord[], get: (record: OutputRecord) => T): Record<T, number> {
  return records.reduce((acc, record) => {
    const key = get(record);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<T, number>);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const remoteMeta: RemoteMeta = { rows_read: 0, rows_written: 0, changed_db: false };
  const existingSources = await loadExistingSourceIds(args.existingGoldSetPath);
  const known = await loadKnownEntities(args, remoteMeta);
  const sources = await loadSources(args, remoteMeta, known);
  process.stderr.write(`sampled ${sources.length} source candidates; existing source exclusions=${existingSources.size}; allow_llm=${args.allowLlmExtraction}\n`);
  const proxy = args.allowLlmExtraction ? await getPlatformProxy({ configPath: args.configPath }) : null;
  const env = proxy ? proxy.env as unknown as Env : {} as Env;
  try {
    const records = await extractRecords(args, env, known, sources, existingSources);
    await mkdir(args.outputDir, { recursive: true });
    const csvPath = join(args.outputDir, 'positive-enriched-test.human-labeling.csv');
    const jsonlPath = join(args.outputDir, 'positive-enriched-test.candidates.jsonl');
    const manifestPath = join(args.outputDir, 'positive-enriched-test.manifest.json');
    await writeFile(csvPath, humanLabelingCsv(records), 'utf8');
    await writeFile(jsonlPath, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    const manifest = {
      generated_at: new Date().toISOString(),
      org_id: args.orgId,
      rows: records.length,
      csv_path: csvPath,
      jsonl_path: jsonlPath,
      split: 'test',
      existing_gold_set_deduped_sources: existingSources.size,
      source_candidates_read: sources.length,
      org_extractor_llm_used_after_deterministic_preview_gate: args.allowLlmExtraction,
      remote_d1_meta: remoteMeta,
      remote_source_tables_rows_written: remoteMeta.rows_written || 0,
      remote_source_tables_changed_db: Boolean(remoteMeta.changed_db),
      target_counts: TARGETS,
      stratum_counts: countBy(records, record => record.stratum),
      expected_class_counts: countBy(records, record => record.expected_class),
      representative_n_for_future_recall_gate: records.filter(record => record.stratum === 'representative').length,
      classifier_used: false,
      label_columns_blank: true,
      notes: [
        'Human labels are intentionally blank; no classifier labels were generated.',
        'Precision can be computed over the whole sheet after labeling.',
        'Recall for the eventual gate should be computed on representative stratum only; enriched-strata recall is optimistic/diagnostic.',
        'Remote access used SELECT-only D1 commands plus R2 object reads for source context.',
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    if (proxy) await proxy.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

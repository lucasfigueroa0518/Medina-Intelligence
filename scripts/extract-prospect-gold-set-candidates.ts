#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import type { Env } from '../src/types/env';
import { __prospectIntelligenceTestHooks, extractOrganizationMentionsFromSource } from '../src/lib/prospect-intelligence';

type Split = 'dev' | 'test';
type Stratum = 'stratified_random' | 'known_positive' | 'hard_case';

interface Args {
  orgId: string;
  outputDir: string;
  configPath: string;
  windowStart?: string;
  windowEnd?: string;
  targetTotal: number;
  randomTarget: number;
  knownPositiveTarget: number;
  hardCaseTarget: number;
  maxTextChars: number;
}

interface SourceCandidate {
  sourceType: 'conversation' | 'event' | 'document';
  sourceChannel: 'email' | 'slack' | 'meeting' | 'document';
  sourceId: string;
  sourceTitle: string | null;
  occurredAt: string;
  senderAndContext: string;
  bodyText: string;
  bodyPreview?: string | null;
  fromEmail?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  direction?: 'inbound' | 'outbound' | 'internal' | null;
  stratum: Stratum;
  stratumReason: string;
}

interface GoldCandidateRecord {
  item_id: string;
  deterministic_key: string;
  deterministic_source_type: SourceCandidate['sourceType'];
  source_type: SourceCandidate['sourceChannel'];
  source_id: string;
  mention_ordinal: number;
  span_start: number | null;
  span_end: number | null;
  company_name: string;
  normalized_company_name: string;
  raw_span: string;
  raw_excerpt: string;
  source_subject: string;
  source_sender: string;
  occurred_at: string;
  context_char_count: number;
  sender_and_context: string;
  stratum: Stratum;
  stratum_reason: string;
  split: Split;
  gold_mention_type: '';
  gold_direction: '';
  gold_sector_key: '';
  labeler: '';
  label_confidence: '';
  adjudicated: false;
  notes: '';
}

const CLASS_FLOORS = {
  inbound_prospect: 40,
  known_deal: 30,
  intro_source: 20,
  news: 40,
  noise: 40,
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
  const orgId = args.get('org-id');
  if (!orgId) {
    throw new Error('Usage: tsx scripts/extract-prospect-gold-set-candidates.ts --org-id <org_id> [--output-dir .prospect-gold-set]');
  }
  const numberArg = (key: string, fallback: number): number => {
    const value = args.get(key);
    if (!value) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`INVALID_${key.toUpperCase()}`);
    return Math.floor(n);
  };
  return {
    orgId,
    outputDir: args.get('output-dir') || '.prospect-gold-set',
    configPath: args.get('config') || 'wrangler.toml',
    windowStart: args.get('window-start'),
    windowEnd: args.get('window-end'),
    targetTotal: numberArg('target-total', 330),
    randomTarget: numberArg('random-target', 180),
    knownPositiveTarget: numberArg('known-positive-target', 100),
    hardCaseTarget: numberArg('hard-case-target', 50),
    maxTextChars: numberArg('max-text-chars', 6000),
  };
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSplit(key: string): Split {
  const bucket = parseInt(stableHash(key).slice(0, 8), 16) % 3;
  return bucket === 0 ? 'test' : 'dev';
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

async function loadR2Text(env: Env, key: string | null | undefined, fallback: string | null | undefined, maxChars: number): Promise<string> {
  if (key) {
    try {
      const obj = await env.R2.get(key);
      if (obj) return (await obj.text()).slice(0, maxChars);
    } catch {
      // Keep the D1 preview fallback; this script must not fail on one opaque binary.
    }
  }
  return String(fallback || '').slice(0, maxChars);
}

function sourcePrefilterAllows(source: SourceCandidate, env: Env): boolean {
  const result = __prospectIntelligenceTestHooks.sourcePrefilter({
    type: source.sourceChannel,
    entityType: source.sourceType,
    entityId: source.sourceId,
    subject: source.sourceTitle || undefined,
    bodyText: source.bodyText,
    bodyPreview: source.bodyPreview || undefined,
    fromEmail: source.fromEmail || undefined,
    toEmails: source.toEmails,
    ccEmails: source.ccEmails,
    direction: source.direction || undefined,
  } as any, env);
  return result.shouldScan;
}

async function loadConversations(env: Env, args: Args, query: string, limit: number, stratum: Stratum, reason: string): Promise<SourceCandidate[]> {
  const rows = await env.D1.prepare(
    `SELECT id, source, subject, body_r2_key, body_preview, from_email, to_emails, cc_emails,
            direction, sent_at
       FROM conversations
      WHERE org_id = ?
        AND (? IS NULL OR sent_at >= ?)
        AND (? IS NULL OR sent_at < ?)
        AND (
          ? = ''
          OR lower(COALESCE(subject, '')) LIKE ?
          OR lower(COALESCE(body_preview, '')) LIKE ?
          OR lower(COALESCE(from_email, '')) LIKE ?
        )
      ORDER BY random()
      LIMIT ?`
  ).bind(
    args.orgId,
    args.windowStart || null,
    args.windowStart || null,
    args.windowEnd || null,
    args.windowEnd || null,
    query,
    query,
    query,
    query,
    limit
  ).all<any>();
  const out: SourceCandidate[] = [];
  for (const row of rows.results || []) {
    const text = await loadR2Text(env, row.body_r2_key, row.body_preview, args.maxTextChars);
    out.push({
      sourceType: 'conversation',
      sourceChannel: row.source === 'slack' ? 'slack' : 'email',
      sourceId: row.id,
      sourceTitle: row.subject || row.source,
      occurredAt: row.sent_at,
      senderAndContext: compactText(`from ${row.from_email || 'unknown'}; subject ${row.subject || '(none)'}; channel ${row.source}; sent ${row.sent_at}`),
      bodyText: text,
      bodyPreview: row.body_preview,
      fromEmail: row.from_email,
      toEmails: parseEmailList(row.to_emails),
      ccEmails: parseEmailList(row.cc_emails),
      direction: row.direction || null,
      stratum,
      stratumReason: reason,
    });
  }
  return out;
}

async function loadEvents(env: Env, args: Args, query: string, limit: number, stratum: Stratum, reason: string): Promise<SourceCandidate[]> {
  const rows = await env.D1.prepare(
    `SELECT id, title, event_type, start_time, source, description, summary, transcript_r2_key
       FROM events
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND (? IS NULL OR start_time >= ?)
        AND (? IS NULL OR start_time < ?)
        AND (
          ? = ''
          OR lower(COALESCE(title, '')) LIKE ?
          OR lower(COALESCE(summary, '')) LIKE ?
          OR lower(COALESCE(description, '')) LIKE ?
        )
      ORDER BY random()
      LIMIT ?`
  ).bind(
    args.orgId,
    args.windowStart || null,
    args.windowStart || null,
    args.windowEnd || null,
    args.windowEnd || null,
    query,
    query,
    query,
    query,
    limit
  ).all<any>();
  const out: SourceCandidate[] = [];
  for (const row of rows.results || []) {
    const text = await loadR2Text(env, row.transcript_r2_key, [row.title, row.summary, row.description].filter(Boolean).join('\n'), args.maxTextChars);
    out.push({
      sourceType: 'event',
      sourceChannel: 'meeting',
      sourceId: row.id,
      sourceTitle: row.title,
      occurredAt: row.start_time,
      senderAndContext: compactText(`event ${row.title}; type ${row.event_type}; source ${row.source}; start ${row.start_time}`),
      bodyText: text,
      bodyPreview: row.summary || row.description,
      stratum,
      stratumReason: reason,
    });
  }
  return out;
}

async function loadDocuments(env: Env, args: Args, query: string, limit: number, stratum: Stratum, reason: string): Promise<SourceCandidate[]> {
  const rows = await env.D1.prepare(
    `SELECT id, title, document_type, source, extracted_text_preview, created_at, uploaded_by
       FROM documents
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND (? IS NULL OR created_at >= ?)
        AND (? IS NULL OR created_at < ?)
        AND (
          ? = ''
          OR lower(COALESCE(title, '')) LIKE ?
          OR lower(COALESCE(extracted_text_preview, '')) LIKE ?
        )
      ORDER BY random()
      LIMIT ?`
  ).bind(
    args.orgId,
    args.windowStart || null,
    args.windowStart || null,
    args.windowEnd || null,
    args.windowEnd || null,
    query,
    query,
    query,
    limit
  ).all<any>();
  return (rows.results || []).map(row => ({
    sourceType: 'document',
    sourceChannel: 'document',
    sourceId: row.id,
    sourceTitle: row.title,
    occurredAt: row.created_at,
    senderAndContext: compactText(`document ${row.title}; type ${row.document_type}; source ${row.source}; uploaded_by ${row.uploaded_by || 'unknown'}; created ${row.created_at}`),
    bodyText: String(row.extracted_text_preview || '').slice(0, args.maxTextChars),
    bodyPreview: row.extracted_text_preview,
    stratum,
    stratumReason: reason,
  }));
}

async function loadSources(env: Env, args: Args): Promise<SourceCandidate[]> {
  const fixtureQueries = ['%max%', '%auguria%', '%armyfuze%'];
  const hardQueries = ['%qunnect%', '%mastercard%', '%objectsecurity%', '%newsletter%', '%nvca%', '%website visit%', '%forward%'];
  const sources: SourceCandidate[] = [];

  for (const query of fixtureQueries) {
    sources.push(...await loadConversations(env, args, query, Math.ceil(args.knownPositiveTarget / 6), 'known_positive', `fixture_search:${query}`));
    sources.push(...await loadEvents(env, args, query, Math.ceil(args.knownPositiveTarget / 12), 'known_positive', `fixture_search:${query}`));
    sources.push(...await loadDocuments(env, args, query, Math.ceil(args.knownPositiveTarget / 6), 'known_positive', `fixture_search:${query}`));
  }
  for (const query of hardQueries) {
    sources.push(...await loadConversations(env, args, query, Math.ceil(args.hardCaseTarget / hardQueries.length), 'hard_case', `hard_case_search:${query}`));
    sources.push(...await loadEvents(env, args, query, Math.ceil(args.hardCaseTarget / (hardQueries.length * 2)), 'hard_case', `hard_case_search:${query}`));
    sources.push(...await loadDocuments(env, args, query, Math.ceil(args.hardCaseTarget / hardQueries.length), 'hard_case', `hard_case_search:${query}`));
  }

  const perFamily = Math.ceil(args.randomTarget / 3);
  sources.push(...await loadConversations(env, args, '', perFamily, 'stratified_random', 'random_conversation'));
  sources.push(...await loadEvents(env, args, '', perFamily, 'stratified_random', 'random_event'));
  sources.push(...await loadDocuments(env, args, '', perFamily, 'stratified_random', 'random_document'));

  const seen = new Set<string>();
  return sources.filter(source => {
    const key = `${source.sourceType}:${source.sourceId}:${source.stratum}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractRecords(sources: SourceCandidate[], env: Env, orgId: string, targetTotal: number): Promise<GoldCandidateRecord[]> {
  const records: GoldCandidateRecord[] = [];
  const seenMentions = new Set<string>();
  for (const source of sources) {
    if (!sourcePrefilterAllows(source, env)) continue;
    const mentions = await extractOrganizationMentionsFromSource({
      type: source.sourceChannel === 'email' ? 'email' : source.sourceChannel === 'slack' ? 'slack_message' : source.sourceChannel === 'meeting' ? 'calendar_event' : 'news',
      entityType: source.sourceType,
      entityId: source.sourceId,
      contactIds: [],
      subject: source.sourceTitle || undefined,
      bodyText: source.bodyText,
      bodyPreview: source.bodyPreview || undefined,
      fromEmail: source.fromEmail || undefined,
      toEmails: source.toEmails,
      ccEmails: source.ccEmails,
      direction: source.direction || undefined,
      sentAt: source.occurredAt,
      orgId,
      visibility: 'org_wide',
      metadata: {} as any,
      text: source.bodyText,
    } as any, orgId, env, { forceLlm: true, maxLlmOrganizations: 30 });
    for (const mention of mentions) {
      const deterministicKey = `${source.sourceType}:${source.sourceId}:${mention.mentionOrdinal}`;
      const dedupeKey = `${mention.normalizedName}:${compactText(mention.lineText, 220).toLowerCase()}`;
      if (seenMentions.has(dedupeKey)) continue;
      seenMentions.add(dedupeKey);
      const itemId = `gs_${stableHash(deterministicKey).slice(0, 12)}`;
      const contextText = mention.contextText || mention.lineText;
      records.push({
        item_id: itemId,
        deterministic_key: deterministicKey,
        deterministic_source_type: source.sourceType,
        source_type: source.sourceChannel,
        source_id: source.sourceId,
        mention_ordinal: mention.mentionOrdinal,
        span_start: mention.spanStart,
        span_end: mention.spanEnd,
        company_name: mention.canonicalName,
        normalized_company_name: mention.normalizedName,
        raw_span: mention.raw,
        raw_excerpt: compactText(contextText, 4000),
        source_subject: source.sourceTitle || '',
        source_sender: source.fromEmail || '',
        occurred_at: source.occurredAt,
        context_char_count: contextText.length,
        sender_and_context: source.senderAndContext,
        stratum: source.stratum,
        stratum_reason: source.stratumReason,
        split: stableSplit(deterministicKey),
        gold_mention_type: '',
        gold_direction: '',
        gold_sector_key: '',
        labeler: '',
        label_confidence: '',
        adjudicated: false,
        notes: '',
      });
      if (records.length >= targetTotal) return records;
    }
  }
  return records;
}

function jsonl(records: GoldCandidateRecord[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

function csv(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function humanLabelingCsv(records: GoldCandidateRecord[]): string {
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
      record.deterministic_source_type,
      record.source_id,
      record.mention_ordinal,
      record.deterministic_key,
      record.company_name,
      record.raw_span,
      record.raw_excerpt,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  const env = proxy.env as unknown as Env;
  try {
    const sources = await loadSources(env, args);
    const records = await extractRecords(sources, env, args.orgId, args.targetTotal);
    const dev = records.filter(record => record.split === 'dev');
    const test = records.filter(record => record.split === 'test');
    await mkdir(args.outputDir, { recursive: true });
    await writeFile(join(args.outputDir, 'gold-candidates.dev.jsonl'), jsonl(dev), 'utf8');
    await writeFile(join(args.outputDir, 'gold-candidates.test.jsonl'), jsonl(test), 'utf8');
    await writeFile(join(args.outputDir, 'gold-candidates.all.jsonl'), jsonl(records), 'utf8');
    await writeFile(join(args.outputDir, 'gold-candidates.human-labeling.csv'), humanLabelingCsv(records), 'utf8');
    const manifest = {
      generated_at: new Date().toISOString(),
      org_id: args.orgId,
      output_dir: args.outputDir,
      window_start: args.windowStart || null,
      window_end: args.windowEnd || null,
      target_total: args.targetTotal,
      strata_targets: {
        stratified_random: args.randomTarget,
        known_positive: args.knownPositiveTarget,
        hard_case: args.hardCaseTarget,
      },
      class_floors: CLASS_FLOORS,
      source_count: sources.length,
      record_count: records.length,
      split_counts: { dev: dev.length, test: test.length },
      stratum_counts: records.reduce((acc: Record<string, number>, record) => {
        acc[record.stratum] = (acc[record.stratum] || 0) + 1;
        return acc;
      }, {}),
      label_fields: 'intentionally_empty_for_human_labeling',
      classifier_used: false,
      notes: [
        'Run against local/granted data only; output is sensitive and gitignored.',
        'The human labeler must fill gold_mention_type, gold_direction, gold_sector_key, labeler, label_confidence, adjudicated, and notes before the spike harness is valid.',
        'Dev/test files are written separately. Few-shots may come from dev only; run the GO/NO-GO gate on test only.',
      ],
    };
    await writeFile(join(args.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await proxy.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

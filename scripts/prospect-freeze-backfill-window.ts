#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

type SourceFamily = 'conversation' | 'event' | 'document';

interface Args {
  orgId: string;
  database: string;
  bucket: string;
  windowStart: string;
  windowEnd: string;
  sourceFamilies: SourceFamily[];
  outputDir: string;
  pageSize: number;
  maxSources: number | null;
  hydrateR2: boolean;
  r2Mode: 'all' | 'signal' | 'none';
  r2TimeoutMs: number;
  maxTextChars: number;
}

interface RemoteMeta {
  query_count: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
}

interface FreezeStats {
  sources: number;
  by_family: Record<SourceFamily, number>;
  r2_attempted: number;
  r2_succeeded: number;
  r2_failed: number;
  preview_fallback: number;
  empty_text: number;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_TEXT_CHARS = 12000;

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
      index++;
    }
  }
  const sourceFamilies = String(raw.get('source-families') || 'conversation,event,document')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean) as SourceFamily[];
  if (sourceFamilies.length === 0 || sourceFamilies.some(value => !['conversation', 'event', 'document'].includes(value))) {
    throw new Error('INVALID_SOURCE_FAMILIES');
  }
  const maxSourcesRaw = raw.get('max-sources') || raw.get('limit') || '';
  const pageSize = Number(raw.get('page-size') || DEFAULT_PAGE_SIZE);
  const r2TimeoutMs = Number(raw.get('r2-timeout-ms') || 30000);
  const maxTextChars = Number(raw.get('max-text-chars') || DEFAULT_MAX_TEXT_CHARS);
  if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('INVALID_PAGE_SIZE');
  if (!Number.isFinite(r2TimeoutMs) || r2TimeoutMs < 1000) throw new Error('INVALID_R2_TIMEOUT_MS');
  if (!Number.isFinite(maxTextChars) || maxTextChars < 500 || maxTextChars > 200000) throw new Error('INVALID_MAX_TEXT_CHARS');
  const args = {
    orgId: raw.get('org-id') || 'medina-ventures',
    database: raw.get('database') || 'medina-ventures-db',
    bucket: raw.get('bucket') || 'medina-ventures-storage',
    windowStart: raw.get('window-start') || '',
    windowEnd: raw.get('window-end') || '',
    sourceFamilies,
    outputDir: resolve(raw.get('output-dir') || `outputs/prospect-freeze-${Date.now()}`),
    pageSize: Math.floor(pageSize),
    maxSources: maxSourcesRaw ? Math.floor(Number(maxSourcesRaw)) : null,
    hydrateR2: raw.get('hydrate-r2') !== 'false',
    r2Mode: (raw.get('r2-mode') || (raw.get('hydrate-r2') === 'false' ? 'none' : 'all')) as Args['r2Mode'],
    r2TimeoutMs: Math.floor(r2TimeoutMs),
    maxTextChars: Math.floor(maxTextChars),
  };
  assertWindow(args.windowStart, args.windowEnd);
  if (!['all', 'signal', 'none'].includes(args.r2Mode)) throw new Error('INVALID_R2_MODE');
  if (args.maxSources != null && (!Number.isFinite(args.maxSources) || args.maxSources < 1)) throw new Error('INVALID_MAX_SOURCES');
  return args;
}

function assertWindow(windowStart: string, windowEnd: string): void {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (!windowStart || Number.isNaN(start.getTime())) throw new Error('INVALID_WINDOW_START');
  if (!windowEnd || Number.isNaN(end.getTime())) throw new Error('INVALID_WINDOW_END');
  if (end.getTime() <= start.getTime()) throw new Error('INVALID_WINDOW_RANGE');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runD1<T>(args: Pick<Args, 'database'>, command: string, meta: RemoteMeta): T[] {
  const stdout = execFileSync('npx', ['wrangler', 'd1', 'execute', args.database, '--remote', '--json', '--command', command], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 120 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Array<{ results?: T[]; success?: boolean; meta?: Partial<RemoteMeta> }>;
  const first = parsed[0] || {};
  if (first.success === false) throw new Error(`WRANGLER_D1_FAILED:${stdout.slice(0, 500)}`);
  meta.query_count++;
  meta.rows_read += Number(first.meta?.rows_read || 0);
  meta.rows_written += Number(first.meta?.rows_written || 0);
  meta.changed_db = Boolean(meta.changed_db || first.meta?.changed_db);
  return first.results || [];
}

function r2GetText(args: Args, key: string): string | null {
  const normalizedKey = key.trim();
  if (!normalizedKey) return null;
  try {
    const buffer = execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${args.bucket}/${normalizedKey}`, '--remote', '--pipe'], {
      cwd: process.cwd(),
      timeout: args.r2TimeoutMs,
      maxBuffer: Math.max(args.maxTextChars * 4, 1024 * 1024),
    });
    return buffer.toString('utf8').slice(0, args.maxTextChars);
  } catch {
    return null;
  }
}

function parseEmailList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // fall through
  }
  return text.split(/[;,]/).map(part => part.trim()).filter(Boolean);
}

function compactText(value: unknown, maxChars: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function shouldFetchR2ForRow(args: Args, family: SourceFamily, row: any, fallback: string): boolean {
  if (!args.hydrateR2 || args.r2Mode === 'none') return false;
  if (args.r2Mode === 'all') return true;
  const text = compactText([
    row.subject,
    row.title,
    row.file_name,
    row.document_type,
    row.from_email,
    row.body_preview,
    row.extracted_text_preview,
    row.summary,
    row.description,
    fallback,
  ].filter(Boolean).join('\n'), 3000);
  if (family === 'document' && /\b(?:deck|pitch|memo|model|financial|term sheet|safe|valuation|diligence|cim|teaser|one[-\s]?pager|company overview|data room|series|seed|round|raise|fundrais)\b/i.test(text)) return true;
  if (family === 'event' && /\b(?:demo|pitch|diligence|founder|co[-\s]?founder|investment|raise|round|deck|intro|product review)\b/i.test(text)) return true;
  return /\b(?:intro|introduction|introducing|warm intro|pitch|deck|data room|diligence|financial model|term sheet|safe|valuation|allocation|raising|fundrais|round|series\s+[abc]|seed|acquisition opportunity|investment opportunity|company overview|one[-\s]?pager|demo)\b/i.test(text);
}

function sourceFamilyTimeColumn(family: SourceFamily): string {
  if (family === 'conversation') return 'sent_at';
  if (family === 'event') return 'start_time';
  return 'created_at';
}

function sourceSelectSql(args: Args, family: SourceFamily, after: string | null, limit: number): string {
  const org = sqlString(args.orgId);
  const start = sqlString(args.windowStart);
  const end = sqlString(args.windowEnd);
  const cursor = after ? `AND ${sourceFamilyTimeColumn(family)} < ${sqlString(after)}` : '';
  if (family === 'conversation') {
    return `SELECT id, source, external_thread_id, external_message_id, subject, body_r2_key, body_preview, direction,
                   sent_at, from_email, to_emails, cc_emails, participant_user_ids, has_attachments, attachment_count
              FROM conversations
             WHERE org_id = ${org}
               AND sent_at >= ${start}
               AND sent_at < ${end}
               ${cursor}
             ORDER BY sent_at DESC, id ASC
             LIMIT ${limit}`;
  }
  if (family === 'event') {
    return `SELECT id, title, event_type, start_time, created_at, location, source, description, summary, transcript_r2_key
              FROM events
             WHERE org_id = ${org}
               AND deleted_at IS NULL
               AND start_time >= ${start}
               AND start_time < ${end}
               ${cursor}
             ORDER BY start_time DESC, id ASC
             LIMIT ${limit}`;
  }
  return `SELECT id, title, document_type, source, r2_key, file_name, mime_type, extracted_text_preview,
                 visibility, participant_user_ids, created_at, content_hash
            FROM documents
           WHERE org_id = ${org}
             AND deleted_at IS NULL
             AND created_at >= ${start}
             AND created_at < ${end}
             ${cursor}
           ORDER BY created_at DESC, id ASC
           LIMIT ${limit}`;
}

function makeConversationItem(args: Args, row: any, text: string, textSource: string): any {
  return {
    type: row.source === 'slack' ? 'slack_message' : 'email',
    source: row.source === 'slack' ? 'slack' : 'outlook',
    externalId: row.id,
    threadId: row.external_thread_id || row.id,
    subject: row.subject || '',
    bodyText: text,
    bodyPreview: row.body_preview || text.slice(0, 500),
    fromEmail: row.from_email || '',
    toEmails: parseEmailList(row.to_emails),
    ccEmails: parseEmailList(row.cc_emails),
    sentAt: row.sent_at,
    direction: row.direction || undefined,
    orgId: args.orgId,
    visibility: 'private',
    entityType: 'conversation',
    entityId: row.id,
    contactIds: [],
    participantUserIds: parseEmailList(row.participant_user_ids),
    metadata: {
      org_id: args.orgId,
      visibility: 'private',
      participant_user_ids: row.participant_user_ids || '[]',
      document_type: row.source === 'slack' ? 'slack' : 'email',
      source_table: 'conversations',
      source_id: row.id,
      r2_key: row.body_r2_key || '',
      created_at: row.sent_at,
      primary_entity_id: row.id,
      text_source: textSource,
      text_preview: row.body_preview || text.slice(0, 500),
      entity_name: row.subject || '',
    },
    text,
  };
}

function makeEventItem(args: Args, row: any, text: string, textSource: string): any {
  const fallback = row.summary || row.description || '';
  return {
    type: 'calendar_event',
    source: 'outlook',
    externalId: row.id,
    subject: row.title || '',
    bodyText: text,
    bodyPreview: fallback || text.slice(0, 500),
    fromEmail: '',
    toEmails: [],
    ccEmails: [],
    sentAt: row.start_time,
    orgId: args.orgId,
    visibility: 'private',
    entityType: 'event',
    entityId: row.id,
    contactIds: [],
    metadata: {
      org_id: args.orgId,
      visibility: 'private',
      document_type: 'meeting',
      source_table: 'events',
      source_id: row.id,
      r2_key: row.transcript_r2_key || '',
      created_at: row.start_time,
      primary_entity_id: row.id,
      text_source: textSource,
      text_preview: fallback || text.slice(0, 500),
      entity_name: row.title || '',
    },
    text,
  };
}

function makeDocumentItem(args: Args, row: any, text: string, textSource: string): any {
  return {
    type: 'document',
    source: 'outlook',
    externalId: row.id,
    subject: row.title || row.file_name || '',
    bodyText: text,
    bodyPreview: row.extracted_text_preview || text.slice(0, 500),
    fromEmail: '',
    toEmails: [],
    ccEmails: [],
    sentAt: row.created_at,
    orgId: args.orgId,
    visibility: row.visibility || 'private',
    entityType: 'document',
    entityId: row.id,
    contactIds: [],
    participantUserIds: parseEmailList(row.participant_user_ids),
    metadata: {
      org_id: args.orgId,
      visibility: row.visibility || 'private',
      participant_user_ids: row.participant_user_ids || '[]',
      document_type: row.document_type || row.source || 'document',
      source_table: 'documents',
      source_id: row.id,
      r2_key: row.r2_key || '',
      created_at: row.created_at,
      primary_entity_id: row.id,
      text_source: textSource,
      text_preview: row.extracted_text_preview || text.slice(0, 500),
      entity_name: row.title || row.file_name || '',
    },
    text,
  };
}

function itemForRow(args: Args, family: SourceFamily, row: any, stats: FreezeStats): any {
  const key = family === 'conversation' ? row.body_r2_key : family === 'event' ? row.transcript_r2_key : row.r2_key;
  const fallback = family === 'conversation'
    ? row.body_preview || row.subject || ''
    : family === 'event'
      ? [row.summary, row.description, row.title].filter(Boolean).join('\n')
      : row.extracted_text_preview || row.title || row.file_name || '';
  let text = compactText(fallback, args.maxTextChars);
  let textSource = text ? 'preview_fallback' : 'empty';
  if (key && shouldFetchR2ForRow(args, family, row, fallback)) {
    stats.r2_attempted++;
    const r2Text = r2GetText(args, String(key));
    if (r2Text && compactText(r2Text, args.maxTextChars)) {
      text = compactText(r2Text, args.maxTextChars);
      textSource = 'r2_full_text';
      stats.r2_succeeded++;
    } else {
      stats.r2_failed++;
    }
  }
  if (textSource !== 'r2_full_text') stats.preview_fallback++;
  if (!text.trim()) stats.empty_text++;
  if (family === 'conversation') return makeConversationItem(args, row, text, textSource);
  if (family === 'event') return makeEventItem(args, row, text, textSource);
  return makeDocumentItem(args, row, text, textSource);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function contextSnapshotSql(table: string, orgId: string): string {
  const org = sqlString(orgId);
  if (table === 'knownDeals') {
    return `SELECT DISTINCT c.name AS name, COALESCE(c.domain, c.website) AS domain
              FROM deals d
              JOIN companies c ON c.id = d.company_id
             WHERE d.org_id = ${org}
               AND d.deleted_at IS NULL
               AND c.deleted_at IS NULL`;
  }
  if (table === 'relationships') {
    return `SELECT * FROM firm_company_relationships WHERE org_id = ${org}`;
  }
  if (table === 'prospectSignals') {
    return `SELECT * FROM prospect_signals WHERE org_id = ${org}`;
  }
  return `SELECT * FROM ${table} WHERE org_id = ${org}`;
}

function buildContextSnapshot(args: Args, meta: RemoteMeta): Record<string, any[]> {
  return {
    companies: runD1(args, contextSnapshotSql('companies', args.orgId), meta),
    relationships: runD1(args, contextSnapshotSql('relationships', args.orgId), meta),
    deals: runD1(args, contextSnapshotSql('deals', args.orgId), meta),
    dealmakers: runD1(args, contextSnapshotSql('dealmakers', args.orgId), meta),
    contacts: runD1(args, contextSnapshotSql('contacts', args.orgId), meta),
    prospectSignals: runD1(args, contextSnapshotSql('prospectSignals', args.orgId), meta),
    knownDeals: runD1(args, contextSnapshotSql('knownDeals', args.orgId), meta),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = join(args.outputDir, 'input');
  mkdirSync(inputDir, { recursive: true });
  const hydratedItemsPath = join(inputDir, 'hydrated-items.jsonl');
  const contextSnapshotPath = join(inputDir, 'd1-context-snapshot.json');
  const manifestPath = join(inputDir, 'manifest.json');
  const meta: RemoteMeta = { query_count: 0, rows_read: 0, rows_written: 0, changed_db: false };
  const stats: FreezeStats = {
    sources: 0,
    by_family: { conversation: 0, event: 0, document: 0 },
    r2_attempted: 0,
    r2_succeeded: 0,
    r2_failed: 0,
    preview_fallback: 0,
    empty_text: 0,
  };

  const lines: string[] = [];
  for (const family of args.sourceFamilies) {
    let cursor: string | null = null;
    for (;;) {
      const remaining = args.maxSources == null ? args.pageSize : Math.max(0, args.maxSources - stats.sources);
      if (remaining <= 0) break;
      const pageLimit = Math.min(args.pageSize, remaining);
      const rows: any[] = runD1<any>(args, sourceSelectSql(args, family, cursor, pageLimit), meta);
      if (rows.length === 0) break;
      for (const row of rows) {
        const item = itemForRow(args, family, row, stats);
        if (item.text.trim() || String(item.subject || '').trim()) {
          lines.push(JSON.stringify(item));
          stats.sources++;
          stats.by_family[family]++;
        }
      }
      process.stdout.write(`[prospect-freeze] page family=${family} rows=${rows.length} total_sources=${stats.sources} family_sources=${stats.by_family[family]} r2=${stats.r2_succeeded}/${stats.r2_attempted} fallback=${stats.preview_fallback} empty=${stats.empty_text}\n`);
      const last: any = rows[rows.length - 1];
      const nextCursor: string = String(last?.[sourceFamilyTimeColumn(family)] || '');
      if (!nextCursor || rows.length < pageLimit || nextCursor === cursor) break;
      cursor = nextCursor;
      if (args.maxSources != null && stats.sources >= args.maxSources) break;
    }
    process.stdout.write(`[prospect-freeze] family=${family} sources=${stats.sources} family_sources=${stats.by_family[family]} r2=${stats.r2_succeeded}/${stats.r2_attempted} fallback=${stats.preview_fallback} empty=${stats.empty_text}\n`);
  }

  const contextSnapshot = buildContextSnapshot(args, meta);
  const hydratedText = `${lines.join('\n')}${lines.length ? '\n' : ''}`;
  writeFileSync(hydratedItemsPath, hydratedText);
  writeFileSync(contextSnapshotPath, `${JSON.stringify(contextSnapshot, null, 2)}\n`);
  const manifest = {
    org_id: args.orgId,
    database: args.database,
    window_start: args.windowStart,
    window_end: args.windowEnd,
    source_families: args.sourceFamilies,
    source_count: stats.sources,
    hydratable_sources: stats.sources,
    transcript_sources: stats.by_family.event,
    decision_counts: {},
    raw_decision_count: 0,
    rows_written: 0,
    changed_db: false,
    freezer: {
      hydrate_r2: args.hydrateR2,
      r2_mode: args.r2Mode,
      max_text_chars: args.maxTextChars,
      r2_timeout_ms: args.r2TimeoutMs,
      stats,
      remote_d1_meta: meta,
      hydrated_items_sha256: sha256Text(hydratedText),
      context_snapshot_sha256: sha256Text(JSON.stringify(contextSnapshot)),
    },
    artifacts: {
      hydrated_items: hydratedItemsPath,
      context_snapshot: contextSnapshotPath,
    },
    created_at: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!existsSync(hydratedItemsPath) || !existsSync(contextSnapshotPath)) throw new Error('FREEZE_ARTIFACT_WRITE_FAILED');
  process.stdout.write(`${JSON.stringify({ input_dir: inputDir, ...manifest }, null, 2)}\n`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

// TRD §4.3 — Chunk embed + persist to Vectorize + KV
import type { Env } from '../types/env';
import type { ChunkMetadata, SpeakerTurn, VectorIndexEntry } from '../types/interfaces';
import {
  createSplitter,
  chunkTranscriptBySpeakerTurns,
  determineOverlapTurns,
  CURRENT_CHUNK_VERSION,
} from './chunking';
import { acquireEmbedSlot } from './rate-limit';

// Parse a "Speaker Name: text" formatted transcript into structured turns.
// Mirrors the parser in integrations/firefly.ts so re-embeds via the generic
// chunkEmbedAndPersistAll path produce the same shape as initial-ingest.
// Returns [] if the text doesn't match the speaker-prefixed format, in which
// case the caller falls back to the recursive splitter.
function parseSpeakerTurns(text: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  const lines = text.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const match = line.match(/^([^:]{2,80}):\s*(.+)$/);
    if (!match) continue;
    turns.push({
      speaker: match[1].trim(),
      affiliation: 'External',
      text: match[2].trim(),
    });
  }
  // Require at least 3 detected turns AND >50% of non-empty lines parsed as
  // turns — otherwise it's likely a body that contains stray "Subject: …"
  // style lines and isn't actually a transcript.
  const nonEmptyLines = lines.length;
  if (turns.length < 3 || turns.length / Math.max(nonEmptyLines, 1) < 0.5) return [];
  return turns;
}

// The "primary entity" of a chunk is the entity it's most about — what users
// query for and expect to see this content surface against. The per-entity
// boosted Vectorize query (retrieval.ts, topK=15, our most precise lever)
// filters by primary_entity_id, so a misset value tanks recall on
// entity-targeted questions ("show me emails from Patrick Dyer").
//
// For emails:
//   - Inbound (sender is external): the sender's contact_id
//   - Outbound (sender is internal): the most prominent external recipient
//   - All-internal or no contact match: fall back to the conversation_id
// For Slack: the sender's contact_id if they're a known external contact
// For meetings: the linked company_id, else the event_id
// For documents (attachments / uploads): the linked contact_id, else company,
//   else deal, else the document's own id.
export interface PrimaryEntityContext {
  document_type: string;
  source: 'outlook' | 'slack' | 'manual' | 'firefly' | 'document_upload' | string;
  source_id: string;
  from_contact_id?: string | null;
  from_email?: string | null;
  to_contact_ids?: string[];
  company_id?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  internal_user_emails?: Set<string>;
}

export function resolvePrimaryEntityId(ctx: PrimaryEntityContext): string {
  const internalSet = ctx.internal_user_emails;
  const senderIsInternal =
    !!ctx.from_email && !!internalSet && internalSet.has(ctx.from_email.toLowerCase());

  if (ctx.document_type === 'email') {
    if (senderIsInternal) {
      const firstExternal = (ctx.to_contact_ids || []).find(id => id);
      if (firstExternal) return firstExternal;
    } else if (ctx.from_contact_id) {
      return ctx.from_contact_id;
    }
    return ctx.source_id;
  }

  if (ctx.document_type === 'conversation' /* slack */) {
    if (ctx.from_contact_id) return ctx.from_contact_id;
    return ctx.source_id;
  }

  if (ctx.document_type === 'transcript') {
    if (ctx.company_id) return ctx.company_id;
    return ctx.source_id;
  }

  if (
    ctx.document_type === 'document' ||
    ctx.document_type === 'pdf' ||
    ctx.document_type === 'pitch_deck' ||
    ctx.source === 'document_upload'
  ) {
    if (ctx.contact_id) return ctx.contact_id;
    if (ctx.company_id) return ctx.company_id;
    if (ctx.deal_id) return ctx.deal_id;
    return ctx.source_id;
  }

  return ctx.source_id;
}

export function prefixChunk(text: string, meta: ChunkMetadata): string {
  const parts = [`[Type: ${meta.document_type}]`];
  if (meta.entity_name) parts.push(`[Entity: ${meta.entity_name}]`);
  if (meta.deal_stage) parts.push(`[Stage: ${meta.deal_stage}]`);
  if (meta.date) parts.push(`[Date: ${meta.date}]`);
  return `${parts.join(' ')}\n${text}`;
}

// Per-isolate concurrency cap (audit 2026-04-28 scale-up Fix 1, Step 3).
// KV-coordinated limiter handles cross-invocation pacing, but during a 1s
// window two requests can race and both pass — actual peak concurrency can
// exceed the configured RPS. This in-isolate semaphore bounds the burst to
// 4 concurrent BGE calls per Worker invocation as a defensive ceiling.
let inFlightEmbeds = 0;
const MAX_IN_FLIGHT_PER_ISOLATE = 4;

async function withInFlightCap<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlightEmbeds >= MAX_IN_FLIGHT_PER_ISOLATE) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  inFlightEmbeds += 1;
  try {
    return await fn();
  } finally {
    inFlightEmbeds -= 1;
  }
}

// Per-request timeout on env.AI.run. The binding API doesn't accept
// AbortSignal directly, so we race it against a setTimeout. Without this,
// a hung BGE call could pin one of the MAX_IN_FLIGHT_PER_ISOLATE = 4
// semaphore slots indefinitely (residual risk #12 from the v2 simulation).
// 20s is generous — typical p99 BGE latency is well under 2s.
const BGE_REQUEST_TIMEOUT_MS = 20_000;

async function bgeWithTimeout(env: Env, text: string): Promise<number[]> {
  const aiPromise = env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [text],
    pooling: 'cls',
  } as any).then((result: any) =>
    Array.isArray(result.data) ? result.data[0] : result.data
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('BGE_TIMEOUT')),
      BGE_REQUEST_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([aiPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function runEmbedding(env: Env, text: string, orgId: string): Promise<number[]> {
  await acquireEmbedSlot(orgId, env);
  return withInFlightCap(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await bgeWithTimeout(env, text);
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw lastErr;
  });
}

export async function chunkEmbedAndPersist(
  text: string,
  meta: ChunkMetadata,
  chunkIndex: number,
  totalChunks: number,
  env: Env
): Promise<VectorIndexEntry> {
  const prefixedChunk = prefixChunk(text, meta);
  // Vectorize max ID is 64 bytes. Compact: strip UUID dashes, truncate org_id.
  const orgPrefix = meta.org_id.substring(0, 8);
  const compactSourceId = meta.source_id.replace(/-/g, '');
  const vectorId = `${orgPrefix}_${meta.source_table}_${compactSourceId}_${chunkIndex}`;

  const values = await runEmbedding(env, prefixedChunk, meta.org_id);

  await Promise.all([
    env.VECTORIZE.upsert([
      {
        id: vectorId,
        values,
        metadata: {
          ...meta,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
          text_preview: prefixedChunk.substring(0, 200),
          embedding_model: 'bge-base-en-v1.5',
          chunk_config_version: CURRENT_CHUNK_VERSION,
        },
      },
    ]),
    env.KV.put(`chunk:${vectorId}`, prefixedChunk),
  ]);

  return {
    vectorId,
    entityId: meta.source_id,
    sourceTable: meta.source_table,
    orgId: meta.org_id,
  };
}

/**
 * Splits `text` into chunks according to the current chunk config version
 * for meta.document_type, then embeds and persists each chunk.
 * Returns one VectorIndexEntry per chunk for batched D1 write by the caller.
 *
 * Dedup: if vector_entity_index already contains a row for this entity
 * (meta.source_table + meta.source_id + meta.org_id), we skip — the entity
 * has already been embedded by a prior run. Audit 2026-04-28 found 4,131
 * vector_entity_index rows for 565 conversations (731% inflation) caused by
 * re-embedding on every ingestion run; without dedup each run added a fresh
 * set of vectors with new IDs and accumulated forever.
 *
 * Tradeoff: when an email's content changes (subject/body edited), the old
 * embedding stays. To re-embed on edit, store a content_hash on the row and
 * compare here, deleting old vectors before re-embedding. Not implementing
 * that yet — edits to ingested email content are rare.
 */
export async function chunkEmbedAndPersistAll(
  text: string,
  meta: ChunkMetadata,
  env: Env
): Promise<VectorIndexEntry[]> {
  if (!text || text.trim().length < 10) return [];

  const existing = await env.D1.prepare(
    `SELECT 1 FROM vector_entity_index
       WHERE entity_id = ? AND source_table = ? AND org_id = ?
       LIMIT 1`
  ).bind(meta.source_id, meta.source_table, meta.org_id).first();
  if (existing) {
    return [];
  }

  // Transcripts: parse the "Speaker: text" format and chunk by speaker turns
  // when possible. The Firefly webhook path already does this on initial
  // ingest (integrations/firefly.ts), but re-embeds via daily-cron and admin
  // backfills used to fall back to the recursive splitter, which buried
  // individual speakers' words mid-chunk and degraded "what did X say"
  // queries. Falls back to recursive when the text doesn't match the
  // speaker-prefixed format.
  if (meta.document_type === 'transcript') {
    const turns = parseSpeakerTurns(text);
    if (turns.length >= 3) {
      const overlapTurns = determineOverlapTurns(turns);
      const chunks = chunkTranscriptBySpeakerTurns(turns, 1024, overlapTurns);
      if (chunks.length === 0) return [];
      const entries: VectorIndexEntry[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkMeta: ChunkMetadata = {
          ...meta,
          speakers: chunks[i].speakers.join(','),
          primary_speaker: chunks[i].primary_speaker,
        };
        const entry = await chunkEmbedAndPersist(chunks[i].text, chunkMeta, i, chunks.length, env);
        entries.push(entry);
      }
      return entries;
    }
  }

  const splitter = createSplitter(meta.document_type);
  const chunks = await splitter.splitText(text);
  if (chunks.length === 0) return [];

  const entries: VectorIndexEntry[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const entry = await chunkEmbedAndPersist(chunks[i], meta, i, chunks.length, env);
    entries.push(entry);
  }
  return entries;
}

// Compose a structured-text representation of a deal that BGE can index well.
// Deals don't have rich freeform text by default, so we synthesize a single
// blob from the structured fields plus the linked company description and
// key contacts. The labeled "Field: value" lines double as semantic anchors
// that improve retrieval on pipeline-style queries ("what fintech deals are
// we tracking", "Series A in defense tech").
export function buildDealEmbeddingText(
  deal: any,
  company: { name?: string | null; sector?: string | null; description?: string | null } | null,
  contacts: Array<{ full_name: string; role?: string | null }>
): string {
  const parts: string[] = [];
  parts.push(`Deal: ${deal.title || deal.name || 'Untitled'}`);
  if (company?.name) parts.push(`Company: ${company.name}`);
  if (company?.sector) parts.push(`Sector: ${company.sector}`);
  if (company?.description) parts.push(`Company description: ${company.description}`);
  if (deal.stage) parts.push(`Stage: ${String(deal.stage).replace(/_/g, ' ')}`);
  if (deal.amount) parts.push(`Round size: ${deal.amount}`);
  if (deal.valuation) parts.push(`Valuation: ${deal.valuation}`);
  if (deal.our_allocation) parts.push(`Our allocation: ${deal.our_allocation}`);
  if (deal.instrument_type) parts.push(`Instrument: ${deal.instrument_type}`);
  if (deal.lead_source) parts.push(`Lead source: ${deal.lead_source}`);
  if (deal.thesis_fit) parts.push(`Thesis fit: ${deal.thesis_fit}`);
  if (deal.notes) parts.push(`Notes: ${deal.notes}`);
  if (deal.expected_close) parts.push(`Expected close: ${deal.expected_close}`);
  if (contacts.length > 0) {
    const list = contacts
      .map(c => (c.role ? `${c.full_name} (${c.role})` : c.full_name))
      .join(', ');
    parts.push(`Key contacts: ${list}`);
  }
  return parts.join('\n');
}

// Embed a single deal record into Vectorize. Idempotent — skips if a vector
// already exists for this deal. Visibility is org_wide (deals are inherently
// shared firm-internal artifacts). primary_entity_id is the linked
// company_id when present so "what's our exposure to X" queries pull the
// right deal alongside the company's enrichment vectors.
export async function embedDeal(dealId: string, orgId: string, env: Env): Promise<'embedded' | 'skipped' | 'missing'> {
  const deal = await env.D1.prepare(
    `SELECT id, title, stage, amount, currency, probability, expected_close, notes,
            valuation, our_allocation, instrument_type, lead_source, thesis_fit,
            company_id, deleted_at
       FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(dealId, orgId).first<any>();
  if (!deal) return 'missing';

  const company = deal.company_id
    ? await env.D1.prepare(
        `SELECT id, name, sector, description FROM companies
           WHERE id = ? AND deleted_at IS NULL`
      ).bind(deal.company_id).first<any>()
    : null;

  const contactsResult = await env.D1.prepare(
    `SELECT c.full_name, dc.role FROM deal_contacts dc
       JOIN contacts c ON c.id = dc.contact_id
       WHERE dc.deal_id = ? AND c.deleted_at IS NULL
       ORDER BY dc.added_at`
  ).bind(dealId).all<{ full_name: string; role: string | null }>();

  const text = buildDealEmbeddingText(deal, company, contactsResult.results);

  const meta: ChunkMetadata = {
    org_id: orgId,
    document_type: 'deal_record',
    source_table: 'deals',
    source_id: dealId,
    r2_key: `${orgId}/deals/${dealId}.txt`, // synthesized; deals don't have an R2 body
    visibility: 'org_wide',
    primary_entity_id: deal.company_id || dealId,
    secondary_entity_ids: contactsResult.results.length > 0
      ? contactsResult.results.map(c => (c as any).contact_id || '').filter(Boolean).join(',') || undefined
      : undefined,
    created_at: new Date().toISOString(),
    entity_name: deal.title || undefined,
    deal_stage: deal.stage || undefined,
  };

  const entries = await chunkEmbedAndPersistAll(text, meta, env);
  if (entries.length === 0) return 'skipped';

  await env.D1.batch(
    entries.map(e =>
      env.D1.prepare(
        'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
      ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
    )
  );
  return 'embedded';
}

// Lightweight bio backfill — embeds a contact's existing bio_summary as a
// single 'enrichment' chunk. Used by the daily-cron backfill loop to close
// the unembedded-but-has-bio gap (the full enrichment.ts pipeline only fires
// on enrichment, not on contacts that already had a bio when ingested).
// Idempotent — chunkEmbedAndPersistAll's dedup guard skips if a vector
// already exists for this entity.
export async function embedContactBio(
  contactId: string,
  orgId: string,
  env: Env
): Promise<'embedded' | 'skipped' | 'missing'> {
  const contact = await env.D1.prepare(
    `SELECT id, full_name, bio_summary FROM contacts
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{ id: string; full_name: string; bio_summary: string | null }>();
  if (!contact) return 'missing';
  if (!contact.bio_summary || contact.bio_summary.trim().length < 30) return 'missing';

  const text = `${contact.full_name}\n\n${contact.bio_summary}`;
  const meta: ChunkMetadata = {
    org_id: orgId,
    document_type: 'enrichment',
    source_table: 'contacts',
    source_id: contactId,
    r2_key: `${orgId}/contact-bio/${contactId}.txt`,
    visibility: 'org_wide',
    primary_entity_id: contactId,
    created_at: new Date().toISOString(),
    entity_name: contact.full_name,
  };

  const entries = await chunkEmbedAndPersistAll(text, meta, env);
  if (entries.length === 0) return 'skipped';

  await env.D1.batch(
    entries.map(e =>
      env.D1.prepare(
        'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
      ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
    )
  );
  return 'embedded';
}

export async function embedCompanyDescription(
  companyId: string,
  orgId: string,
  env: Env
): Promise<'embedded' | 'skipped' | 'missing'> {
  const company = await env.D1.prepare(
    `SELECT id, name, description, sector FROM companies
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND merged_into IS NULL`
  ).bind(companyId, orgId).first<{ id: string; name: string; description: string | null; sector: string | null }>();
  if (!company) return 'missing';
  if (!company.description || company.description.trim().length < 30) return 'missing';

  const parts = [company.name];
  if (company.sector) parts.push(`Sector: ${company.sector}`);
  parts.push(company.description);
  const text = parts.join('\n\n');

  const meta: ChunkMetadata = {
    org_id: orgId,
    document_type: 'enrichment',
    source_table: 'companies',
    source_id: companyId,
    r2_key: `${orgId}/company-desc/${companyId}.txt`,
    visibility: 'org_wide',
    primary_entity_id: companyId,
    created_at: new Date().toISOString(),
    entity_name: company.name,
  };

  const entries = await chunkEmbedAndPersistAll(text, meta, env);
  if (entries.length === 0) return 'skipped';

  await env.D1.batch(
    entries.map(e =>
      env.D1.prepare(
        'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
      ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
    )
  );
  return 'embedded';
}

// Re-embed a deal: deletes prior vectors first, then re-embeds. Use after a
// content-bearing field changes (title, stage, notes, thesis, etc).
export async function reembedDeal(dealId: string, orgId: string, env: Env): Promise<'embedded' | 'skipped' | 'missing'> {
  const existing = await env.D1.prepare(
    `SELECT vector_id FROM vector_entity_index WHERE entity_id = ? AND source_table = 'deals' AND org_id = ?`
  ).bind(dealId, orgId).all<{ vector_id: string }>();

  if (existing.results.length > 0) {
    const ids = existing.results.map(r => r.vector_id);
    await env.VECTORIZE.deleteByIds(ids).catch(() => {});
    const placeholders = ids.map(() => '?').join(',');
    await env.D1.prepare(
      `DELETE FROM vector_entity_index WHERE vector_id IN (${placeholders})`
    ).bind(...ids).run();
    await Promise.all(
      ids.map(id => env.KV.delete(`chunk:${id}`).catch(() => {}))
    );
  }

  return embedDeal(dealId, orgId, env);
}

// Wave 3 — parallel attachment backfill orchestrator.
//
// Drains the orphan-attachment conversations the Wave 2 divergence detector
// surfaces. Each conversation: list attachments via Graph (1 call) → download
// each non-inline non-reference attachment binary → persistDocument with
// embed:false (defers chunking + Vectorize to embed_retry_queue) → finalize
// with documentType='other' (cheap path: extract text for preview + status='completed',
// no LLM classify call) → INSERT into embed_retry_queue.
//
// Concurrency is bounded with a semaphore-style limiter — too many parallel
// Graph calls trip per-app rate limits. The default of 25 is conservative;
// the admin endpoint can override it.
//
// Failure isolation: per-attachment errors don't fail the conversation; per-
// conversation errors don't fail the batch. Stats are aggregated and surfaced
// to the caller; sync_jobs gets a row for observability.

import type { Env } from '../types/env';
import { parseParticipantUserIds, getDecryptedAccessToken } from './helpers';
import { refreshOutlookToken } from '../integrations/oauth';
import { persistDocument, type DocumentLink } from './persist-document';

export interface OrchestratorConfig {
  orgId: string;
  /** User whose Outlook token authorizes Graph. Should be an active org member. */
  userId: string;
  conversationIds: string[];
  /** Max parallel per-conversation workers. Default 25. Don't exceed 25 — Graph rate-limits. */
  concurrency?: number;
}

export interface OrchestratorError {
  conversation_id: string;
  phase: 'lookup' | 'list' | 'download' | 'persist' | 'queue';
  attachment_name?: string;
  error: string;
}

export interface OrchestratorResult {
  jobId: string;
  conversations_processed: number;
  attachments_attempted: number;
  attachments_persisted: number;
  attachments_failed: number;
  /** Inline (signature image), reference attachments, or messages deleted from mailbox. */
  attachments_skipped_unrecoverable: number;
  embeddings_queued: number;
  errors: OrchestratorError[];
}

interface ConversationStats {
  conversation_id: string;
  persisted: number;
  failed: number;
  skipped: number;
  errors: OrchestratorError[];
}

// Semaphore-style limiter — when N tasks are in flight, await one before
// starting the next. Order of completion isn't preserved; results array is
// pushed to in completion order. That's fine for our aggregator.
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const inFlight = new Set<Promise<void>>();

  for (const item of items) {
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
    const promise: Promise<void> = worker(item)
      .then(r => { results.push(r); })
      .catch(() => { /* worker reports its own errors via stats; don't reject the race */ })
      .finally(() => { inFlight.delete(promise); });
    inFlight.add(promise);
  }

  await Promise.all(inFlight);
  return results;
}

interface ConversationRow {
  id: string;
  external_message_id: string | null;
  from_email: string | null;
  from_contact_id: string | null;
  sent_at: string | null;
  participant_user_ids: string | null;
  attachment_count: number | null;
}

interface GraphAttachmentMeta {
  id: string;
  name: string;
  size: number;
  contentType: string;
  isInline?: boolean;
  '@odata.type'?: string;
}

// When the source message is gone or has no usable attachments, write a
// single placeholder document row (status='skipped', empty r2_key, error
// message) plus a conversation link. Without this, pickOrphanBatch would
// re-select the same conversation on every drain iteration — the NOT EXISTS
// query only sees email_attachment docs, not "we tried and failed" markers.
// Mirrors the oversize-skip pattern in P1 attachment-processor.ts.
async function writeUnrecoverableMarker(
  conversationId: string,
  ctx: { orgId: string; jobId: string },
  conv: ConversationRow,
  reason: string,
  env: Env
): Promise<void> {
  const docId = crypto.randomUUID();
  const now = new Date().toISOString();
  const participantsJson = conv.participant_user_ids || null;
  try {
    await env.D1.prepare(
      `INSERT INTO documents
         (id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
          contact_id, conversation_id, processing_status, error_message,
          visibility, participant_user_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'other', 'email_attachment', '', ?, 0, NULL,
               ?, ?, 'skipped', ?,
               'private', ?, ?, ?)`
    ).bind(
      docId, ctx.orgId, 'Attachment unavailable', 'unavailable',
      conv.from_contact_id, conversationId,
      reason,
      participantsJson,
      now, now
    ).run();

    // Link the placeholder to the conversation so contact/conversation queries
    // can surface "we tried" rather than silently omitting.
    const links = [
      { entityType: 'conversation', entityId: conversationId, kind: 'attached' },
    ];
    if (conv.from_contact_id) {
      links.push({ entityType: 'contact', entityId: conv.from_contact_id, kind: 'primary' });
    }
    await env.D1.batch(
      links.map(l =>
        env.D1.prepare(
          `INSERT OR IGNORE INTO document_links
             (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pipeline', ?)`
        ).bind(crypto.randomUUID(), docId, ctx.orgId, l.entityType, l.entityId, l.kind, now)
      )
    );
  } catch (e: any) {
    console.error(`[backfill-orchestrator] writeUnrecoverableMarker failed for ${conversationId}:`, e?.message || e);
  }
}

// Per-batch token resolver. Outlook's /me/messages is mailbox-scoped — a
// caller's token can only see messages in their OWN mailbox. Conversations
// ingested via different users' delta syncs need different tokens to refetch.
// We resolve candidate user IDs from conversations.participant_user_ids and
// try each in order; first 200 wins. Tokens are cached so we don't refresh +
// decrypt once per conversation.
type TokenResolver = (userId: string) => Promise<string | null>;

async function processOneConversation(
  conversationId: string,
  ctx: { orgId: string; jobId: string; getTokenForUser: TokenResolver },
  env: Env
): Promise<ConversationStats> {
  const stats: ConversationStats = {
    conversation_id: conversationId,
    persisted: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // 1. Look up the conversation row.
  const conv = await env.D1.prepare(
    `SELECT id, external_message_id, from_email, from_contact_id, sent_at,
            participant_user_ids, attachment_count
       FROM conversations
      WHERE id = ? AND org_id = ?`
  ).bind(conversationId, ctx.orgId).first<ConversationRow>();

  if (!conv) {
    stats.errors.push({ conversation_id: conversationId, phase: 'lookup', error: 'conversation not found' });
    return stats;
  }
  if (!conv.external_message_id) {
    stats.errors.push({ conversation_id: conversationId, phase: 'lookup', error: 'no external_message_id' });
    return stats;
  }

  // 2. Resolve which user's token to use. participant_user_ids holds every
  // org user who saw this email; any of them MIGHT have it in their mailbox.
  // Try them in order until one returns a non-404 list response. If all 404,
  // the message is genuinely gone everywhere.
  const candidateUserIds = parseParticipantUserIds(conv.participant_user_ids);
  if (candidateUserIds.length === 0) {
    stats.skipped += conv.attachment_count || 1;
    stats.errors.push({ conversation_id: conversationId, phase: 'lookup', error: 'no participant_user_ids — cannot determine mailbox owner' });
    await writeUnrecoverableMarker(conversationId, ctx, conv, 'no participant_user_ids', env);
    return stats;
  }

  // 3. List attachments via Graph. Try each candidate user's mailbox.
  let attachmentList: GraphAttachmentMeta[] = [];
  let resolvedToken: string | null = null;
  let last404 = false;
  let lastError: string | null = null;

  for (const candidateUserId of candidateUserIds) {
    const token = await ctx.getTokenForUser(candidateUserId);
    if (!token) {
      lastError = `no valid token for user ${candidateUserId}`;
      continue;
    }
    try {
      const listRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(conv.external_message_id)}/attachments?$select=id,name,size,contentType,isInline`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (listRes.status === 404) {
        last404 = true;
        lastError = `404 for user ${candidateUserId}`;
        continue;  // try next candidate
      }
      if (!listRes.ok) {
        const body = await listRes.text();
        lastError = `graph ${listRes.status}: ${body.slice(0, 200)}`;
        continue;  // try next candidate
      }
      const data = await listRes.json() as { value?: GraphAttachmentMeta[] };
      attachmentList = (data.value || []).filter(a => !a.isInline);
      resolvedToken = token;
      break;  // success — use this token for downloads too
    } catch (e: any) {
      lastError = e?.message || String(e);
      continue;
    }
  }

  if (!resolvedToken) {
    if (last404) {
      // Every candidate's mailbox returned 404 — message is genuinely gone.
      stats.skipped += conv.attachment_count || 1;
      stats.errors.push({ conversation_id: conversationId, phase: 'list', error: `message deleted from all mailboxes (404 across ${candidateUserIds.length} candidates)` });
      await writeUnrecoverableMarker(conversationId, ctx, conv, 'message deleted from all candidate mailboxes (404)', env);
    } else {
      // Transient — non-404 errors. Don't write marker; let next drain retry.
      stats.failed += conv.attachment_count || 1;
      stats.errors.push({ conversation_id: conversationId, phase: 'list', error: lastError || 'all candidates failed without 404' });
    }
    return stats;
  }

  // From here on, resolvedToken is the user whose mailbox contains the message.
  if (attachmentList.length === 0) {
    // Header said has_attachments=1 but Graph returns nothing usable (all
    // inline signature images, only reference attachments, or zero after
    // filter). Treat as unrecoverable so this conversation drops out of the
    // orphan set permanently.
    stats.skipped += conv.attachment_count || 0;
    await writeUnrecoverableMarker(conversationId, ctx, conv, 'no usable attachments after filter (all inline / reference)', env);
    return stats;
  }

  const participants = parseParticipantUserIds(conv.participant_user_ids);
  const baseLinks: DocumentLink[] = [];
  if (conv.from_contact_id) {
    baseLinks.push({ entityType: 'contact', entityId: conv.from_contact_id, linkKind: 'primary', linkSource: 'pipeline' });
  }
  baseLinks.push({ entityType: 'conversation', entityId: conv.id, linkKind: 'attached', linkSource: 'pipeline' });

  for (const att of attachmentList) {
    // Reference attachments link to OneDrive/SharePoint — different download
    // semantics, skip in this wave. Wave 4+ can add a dedicated path.
    const odata = att['@odata.type'] || '';
    if (odata.toLowerCase().includes('referenceattachment')) {
      stats.skipped += 1;
      continue;
    }

    try {
      // 3a. Download binary via $value endpoint.
      const dlRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(conv.external_message_id!)}/attachments/${encodeURIComponent(att.id)}/$value`,
        { headers: { Authorization: `Bearer ${resolvedToken}` } }
      );
      if (!dlRes.ok) {
        const body = await dlRes.text();
        stats.failed += 1;
        stats.errors.push({
          conversation_id: conversationId,
          phase: 'download',
          attachment_name: att.name,
          error: `graph ${dlRes.status}: ${body.slice(0, 200)}`,
        });
        continue;
      }
      const buffer = await dlRes.arrayBuffer();
      const file = new File([buffer], att.name, { type: att.contentType });

      // 3b. Persist via the unified writer. embed:false defers chunking +
      // Vectorize to embed_retry_queue. documentType:'other' short-circuits
      // the LLM classifier in finalize() so 2k+ attachments don't burn 2k+
      // Claude calls during the drain.
      const persisted = await persistDocument(
        {
          file,
          orgId: ctx.orgId,
          source: 'email_attachment',
          visibility: 'private',
          participantUserIds: participants.length > 0 ? participants : null,
          uploadedBy: null, // system-ingested
          links: baseLinks,
          documentType: 'other',
          embed: false,
        },
        env
      );

      if (persisted.isExisting) {
        // Same file already landed via another path (cross-pipeline dedup).
        // Don't queue another embed — the existing row owns it.
        stats.skipped += 1;
        continue;
      }

      // 3c. finalize() runs extract + sets status='completed' + skips
      // classify (documentType already set) + skips embed (embed:false).
      try {
        await persisted.finalize();
      } catch (e: any) {
        // Finalize failure shouldn't lose the row — it's persisted at status
        // 'pending', and the embed-retry-queue drain will re-extract from R2.
        stats.errors.push({
          conversation_id: conversationId,
          phase: 'persist',
          attachment_name: att.name,
          error: `finalize: ${e?.message || e}`,
        });
      }

      // 3d. Queue embed for deferred processing. UNIQUE on (org, entity, source)
      // means a re-run won't double-queue.
      try {
        await env.D1.prepare(
          `INSERT OR IGNORE INTO embed_retry_queue (org_id, entity_id, source_table, status)
             VALUES (?, ?, 'documents', 'pending')`
        ).bind(ctx.orgId, persisted.documentId).run();
      } catch (e: any) {
        stats.errors.push({
          conversation_id: conversationId,
          phase: 'queue',
          attachment_name: att.name,
          error: e?.message || String(e),
        });
      }

      stats.persisted += 1;
    } catch (e: any) {
      stats.failed += 1;
      stats.errors.push({
        conversation_id: conversationId,
        phase: 'persist',
        attachment_name: att.name,
        error: e?.message || String(e),
      });
    }
  }

  return stats;
}

export async function runAttachmentBackfillBatch(
  config: OrchestratorConfig,
  env: Env
): Promise<OrchestratorResult> {
  const jobId = crypto.randomUUID();
  const concurrency = Math.min(Math.max(1, config.concurrency || 25), 25);
  const startedAt = new Date().toISOString();

  // sync_jobs row for observability — searchable from the same SQL surface
  // operators use for ingestion runs.
  await env.D1.prepare(
    `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, metadata)
     VALUES (?, ?, 'attachment_backfill', 'running', ?, ?)`
  ).bind(
    jobId,
    config.orgId,
    startedAt,
    JSON.stringify({
      conversation_ids_count: config.conversationIds.length,
      concurrency,
      user_id: config.userId,
    })
  ).run();

  // Per-user token cache. /me/messages is mailbox-scoped, so we resolve a
  // token per candidate user (from each conversation's participant_user_ids)
  // and cache results across the whole batch — refresh + decrypt is expensive
  // and we'd otherwise pay it once per conversation. A failed lookup is
  // cached as null so we don't retry it for every conv on this user's behalf.
  const tokenCache = new Map<string, string | null>();
  const getTokenForUser: TokenResolver = async (userId: string) => {
    if (tokenCache.has(userId)) return tokenCache.get(userId) ?? null;
    try {
      await refreshOutlookToken(userId, config.orgId, env);
      const t = await getDecryptedAccessToken(userId, env);
      tokenCache.set(userId, t);
      return t;
    } catch (e: any) {
      console.warn(`[backfill-orchestrator] no valid token for user ${userId}: ${e?.message || e}`);
      tokenCache.set(userId, null);
      return null;
    }
  };

  const perConvResults = await runWithConcurrency(
    config.conversationIds,
    concurrency,
    convId => processOneConversation(convId, { orgId: config.orgId, jobId, getTokenForUser }, env)
  );

  const result: OrchestratorResult = {
    jobId,
    conversations_processed: perConvResults.length,
    attachments_attempted: 0,
    attachments_persisted: 0,
    attachments_failed: 0,
    attachments_skipped_unrecoverable: 0,
    embeddings_queued: 0,
    errors: [],
  };

  for (const r of perConvResults) {
    result.attachments_persisted += r.persisted;
    result.attachments_failed += r.failed;
    result.attachments_skipped_unrecoverable += r.skipped;
    result.embeddings_queued += r.persisted; // 1 embed-queue insert per persisted doc
    result.errors.push(...r.errors);
  }
  result.attachments_attempted =
    result.attachments_persisted + result.attachments_failed + result.attachments_skipped_unrecoverable;

  // Final job-row update. Trim errors to the first 50 to keep metadata small.
  // 'partial' is the existing sync_jobs status convention for "ran but had
  // errors" — same shape ingestion runs use when chunks fail.
  const errorsForMeta = result.errors.slice(0, 50);
  const finalStatus = result.attachments_failed > 0 ? 'partial' : 'completed';
  await env.D1.prepare(
    `UPDATE sync_jobs
        SET status = ?, completed_at = ?,
            metadata = json_patch(COALESCE(metadata, '{}'), ?)
      WHERE id = ?`
  ).bind(
    finalStatus,
    new Date().toISOString(),
    JSON.stringify({
      conversations_processed: result.conversations_processed,
      attachments_attempted: result.attachments_attempted,
      attachments_persisted: result.attachments_persisted,
      attachments_failed: result.attachments_failed,
      attachments_skipped_unrecoverable: result.attachments_skipped_unrecoverable,
      embeddings_queued: result.embeddings_queued,
      errors_count: result.errors.length,
      errors_sample: errorsForMeta,
    }),
    jobId
  ).run();

  return result;
}

/** Count conversations declaring attachments but with no email_attachment doc. */
export async function countOrphanAttachmentConversations(orgId: string, env: Env): Promise<number> {
  const row = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM conversations c
       WHERE c.org_id = ? AND c.has_attachments = 1
         AND NOT EXISTS (
           SELECT 1 FROM documents d
            WHERE d.conversation_id = c.id
              AND d.source = 'email_attachment'
              AND d.deleted_at IS NULL
         )`
  ).bind(orgId).first<{ n: number }>();
  return row?.n || 0;
}

/** Pick the next batch of orphan conversation IDs. Newest sent_at first. */
export async function pickOrphanBatch(orgId: string, batchSize: number, env: Env): Promise<string[]> {
  const rows = await env.D1.prepare(
    `SELECT c.id FROM conversations c
       WHERE c.org_id = ? AND c.has_attachments = 1
         AND NOT EXISTS (
           SELECT 1 FROM documents d
            WHERE d.conversation_id = c.id
              AND d.source = 'email_attachment'
              AND d.deleted_at IS NULL
         )
       ORDER BY c.sent_at DESC
       LIMIT ?`
  ).bind(orgId, batchSize).all<{ id: string }>();
  return rows.results.map(r => r.id);
}

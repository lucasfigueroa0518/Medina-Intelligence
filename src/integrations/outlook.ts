// TRD §6.1 — Microsoft Graph email + calendar delta sync
import type { Env } from '../types/env';
import type { ClassifiableItem, AttachmentMeta } from '../types/interfaces';
import {
  getActiveUsersForOrg,
  getOrgDomains,
  getOrgSettings,
  getDecryptedAccessToken,
} from '../lib/helpers';
import { stripHtml, stripQuotedReplies } from '../lib/helpers';
import { refreshOutlookToken, recordTokenFailure } from './oauth';
import { upsertOutlookEvent } from '../lib/reconciliation';
import { checkGraphRateLimit, recordGraphApiCall } from '../lib/rate-limit';

interface OutlookAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  isInline?: boolean;
}

// Fields from Microsoft Graph that LOOK guaranteed but aren't, in practice:
// drafts, calendar invites in mailbox, system notifications, and messages
// from external systems (no-reply / mailer-daemon) routinely come back with
// missing toRecipients, ccRecipients, from, or body. Marking everything that
// can be missing as optional matches reality and lets TypeScript catch unsafe
// reads at compile time.
interface OutlookMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: 'text' | 'html'; content: string };
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  sentDateTime: string;
  receivedDateTime: string;
  conversationId: string;
  importance?: 'low' | 'normal' | 'high';
  hasAttachments?: boolean;
  attachments?: OutlookAttachment[];
}

const MSG_SELECT = '$select=id,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,importance,hasAttachments&$expand=attachments($select=id,name,size,contentType,isInline)';

interface FolderDeltaConfig {
  folder: 'inbox' | 'sentitems';
  getDeltaToken: () => Promise<string | null>;
  setDeltaToken: (token: string) => Promise<void>;
  clearDeltaToken: () => Promise<void>;
  backfillFilter: string;
}

async function fetchFolderDelta(
  token: string,
  userId: string,
  config: FolderDeltaConfig,
  orgId: string,
  env: Env
): Promise<OutlookMessage[]> {
  const deltaToken = await config.getDeltaToken();

  let url: string;
  if (deltaToken) {
    url = deltaToken;
  } else {
    url = `https://graph.microsoft.com/v1.0/me/mailFolders/${config.folder}/messages/delta?${MSG_SELECT}&${config.backfillFilter}&$top=50`;
  }

  const messages: OutlookMessage[] = [];

  while (url) {
    if (!(await checkGraphRateLimit(orgId, env))) {
      console.log(`[outlook] Graph rate limit approaching for org ${orgId}, pausing sync`);
      break;
    }

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await recordGraphApiCall(orgId, env);

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error(`[outlook] Delta fetch failed for ${config.folder} user ${userId}: ${resp.status} ${errBody.slice(0, 300)}`);
      if (resp.status === 410) {
        await config.clearDeltaToken();
        console.warn(`[outlook] Delta token expired (410) for ${config.folder} user ${userId}, cleared for full re-sync`);
      } else if (resp.status === 401) {
        await recordTokenFailure(userId, 'outlook', env);
      }
      break;
    }

    const data = (await resp.json()) as {
      value: OutlookMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    messages.push(...data.value);

    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink'];
    } else {
      if (data['@odata.deltaLink']) {
        await config.setDeltaToken(data['@odata.deltaLink']);
      }
      url = '';
    }
  }

  return messages;
}

// Graph emails can be missing toRecipients / ccRecipients / from / body for
// drafts, calendar-invite-as-email, system notifications, and a few other
// states that Microsoft sends through the same /messages endpoint. The type
// declarations claim these fields are always present, but the audit
// 2026-04-28 captured "Cannot read properties of undefined (reading 'map')"
// from the Outlook fetcher in two distinct runs. All raw-Graph reads in this
// file null-coalesce defensively now.
function classifyDirection(
  msg: OutlookMessage,
  internalDomains: string[]
): 'inbound' | 'outbound' | 'internal' {
  const toAddrs = (msg.toRecipients ?? [])
    .map(r => r?.emailAddress?.address)
    .filter((a): a is string => Boolean(a));
  const ccAddrs = (msg.ccRecipients ?? [])
    .map(r => r?.emailAddress?.address)
    .filter((a): a is string => Boolean(a));
  const allRecipients = [...toAddrs, ...ccAddrs];

  const fromAddr = msg.from?.emailAddress?.address;
  const fromIsInternal = !!fromAddr && internalDomains.some(d => fromAddr.endsWith(`@${d}`));

  // No recipients (e.g. malformed draft) → no recipients to classify against;
  // treat as inbound so we don't drop the message but also don't wrongly tag
  // it as internal/outbound.
  if (allRecipients.length === 0) return 'inbound';

  const allRecipientsInternal = allRecipients.every(e =>
    internalDomains.some(d => e.endsWith(`@${d}`))
  );

  if (fromIsInternal && allRecipientsInternal) return 'internal';
  if (fromIsInternal) return 'outbound';
  return 'inbound';
}

function messageToClassifiableItem(
  msg: OutlookMessage,
  direction: 'inbound' | 'outbound' | 'internal',
  userId: string,
  orgId: string
): ClassifiableItem {
  const recipientNames: Record<string, string> = {};
  const fromAddr = msg.from?.emailAddress?.address;
  const fromName = msg.from?.emailAddress?.name;
  if (fromAddr && fromName) {
    recipientNames[fromAddr.toLowerCase()] = fromName;
  }
  for (const r of msg.toRecipients || []) {
    const addr = r.emailAddress?.address;
    const name = r.emailAddress?.name;
    if (addr && name && name.trim()) {
      recipientNames[addr.toLowerCase()] = name;
    }
  }
  for (const r of msg.ccRecipients || []) {
    const addr = r.emailAddress?.address;
    const name = r.emailAddress?.name;
    if (addr && name && name.trim()) {
      recipientNames[addr.toLowerCase()] = name;
    }
  }

  const attachments: AttachmentMeta[] | undefined = msg.hasAttachments && msg.attachments?.length
    ? msg.attachments
        .filter(a => !(a.isInline && a.size < 51200))
        .slice(0, 5)
        .map(a => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType, isInline: a.isInline }))
    : undefined;

  const bodyContent = msg.body?.content ?? msg.bodyPreview ?? '';
  const plainBody = msg.body?.contentType === 'html' ? stripHtml(bodyContent) : bodyContent;
  // Strip quoted reply chains so a 5-message thread doesn't embed 5× the same
  // content. Only affects new ingestions — existing email vectors keep their
  // bloated bodies (compute cost of a re-embed pass not justified for the
  // efficiency-only gain).
  const bodyText = stripQuotedReplies(plainBody);

  return {
    type: 'email',
    source: 'outlook',
    externalId: msg.id,
    threadId: msg.conversationId,
    subject: msg.subject ?? '(no subject)',
    bodyText,
    bodyPreview: (msg.bodyPreview || '').substring(0, 500),
    fromEmail: msg.from?.emailAddress?.address ?? '',
    fromName: msg.from?.emailAddress?.name ?? '',
    toEmails: (msg.toRecipients ?? [])
      .map(r => r?.emailAddress?.address)
      .filter((a): a is string => Boolean(a)),
    ccEmails: (msg.ccRecipients ?? [])
      .map(r => r?.emailAddress?.address)
      .filter((a): a is string => Boolean(a)),
    recipientNames,
    sentAt: msg.sentDateTime,
    direction,
    importance: msg.importance,
    userId,
    orgId,
    visibility: 'org_wide',
    attachments,
  };
}

export interface SyncConfig {
  sync_history_days: number;
}

export async function getUserSyncConfig(
  userId: string,
  env: Env
): Promise<SyncConfig> {
  const raw = await env.KV.get<SyncConfig>(`sync_config:${userId}`, 'json');
  return raw || { sync_history_days: 30 };
}

export async function setUserSyncConfig(
  userId: string,
  config: Partial<SyncConfig>,
  env: Env
): Promise<void> {
  const current = await getUserSyncConfig(userId, env);
  await env.KV.put(`sync_config:${userId}`, JSON.stringify({ ...current, ...config }));
}

export async function fetchOutlookDelta(
  orgId: string,
  env: Env
): Promise<ClassifiableItem[]> {
  const users = await getActiveUsersForOrg(orgId, env);
  const allItems: ClassifiableItem[] = [];

  for (const user of users) {
    const failState = await env.KV.get<{ count: number }>(
      `token_failed:${user.id}:outlook`,
      'json'
    );
    if (failState && failState.count >= 3) continue;

    const refreshResult = await refreshOutlookToken(user.id, orgId, env);
    if (!refreshResult.success) continue;

    let token: string;
    try {
      token = await getDecryptedAccessToken(user.id, env);
    } catch {
      continue;
    }

    const syncConfig = await getUserSyncConfig(user.id, env);
    const since = new Date(Date.now() - syncConfig.sync_history_days * 86400000).toISOString();

    console.log(`[outlook] Syncing user ${user.id}, window=${syncConfig.sync_history_days}d, hasDelta=${!!user.outlook_delta_token}`);

    // Fetch inbox (delta token stored in D1 users table)
    let inboxMessages: OutlookMessage[] = [];
    try {
      inboxMessages = await fetchFolderDelta(token, user.id, {
        folder: 'inbox',
        getDeltaToken: async () => user.outlook_delta_token || null,
        setDeltaToken: async (dt) => {
          await env.D1.prepare(
            'UPDATE users SET outlook_delta_token = ? WHERE id = ?'
          ).bind(dt, user.id).run();
        },
        clearDeltaToken: async () => {
          await env.D1.prepare(
            'UPDATE users SET outlook_delta_token = NULL WHERE id = ?'
          ).bind(user.id).run();
        },
        backfillFilter: `$filter=receivedDateTime ge ${since}`,
      }, orgId, env);
    } catch (e) {
      console.error(`Outlook inbox sync error for user ${user.id}:`, e);
    }

    // Fetch sent items (delta token stored in KV)
    let sentMessages: OutlookMessage[] = [];
    try {
      const sentDeltaKey = `sent_delta:${user.id}`;
      sentMessages = await fetchFolderDelta(token, user.id, {
        folder: 'sentitems',
        getDeltaToken: async () => await env.KV.get(sentDeltaKey),
        setDeltaToken: async (dt) => {
          await env.KV.put(sentDeltaKey, dt, { expirationTtl: 2592000 });
        },
        clearDeltaToken: async () => {
          await env.KV.delete(sentDeltaKey);
        },
        backfillFilter: `$filter=receivedDateTime ge ${since}`,
      }, orgId, env);
    } catch (e) {
      console.error(`Outlook sent sync error for user ${user.id}:`, e);
    }

    console.log(`[outlook] User ${user.id}: inbox=${inboxMessages.length}, sent=${sentMessages.length}`);

    const internalDomains = await getOrgDomains(orgId, env);

    for (const msg of inboxMessages) {
      const direction = classifyDirection(msg, internalDomains);
      allItems.push(messageToClassifiableItem(msg, direction, user.id, orgId));
    }
    for (const msg of sentMessages) {
      const direction = classifyDirection(msg, internalDomains);
      allItems.push(messageToClassifiableItem(msg, direction, user.id, orgId));
    }
  }

  return allItems;
}

// --- Historical backfill ---

export interface BackfillProgress {
  status: 'in_progress' | 'completed' | 'paused' | 'failed';
  total_fetched: number;
  last_page_url: string | null;
  error?: string;
  started_at: string;
  updated_at: string;
  target_start_date: string;
  target_end_date: string;
}

export async function runHistoricalBackfill(
  userId: string,
  orgId: string,
  daysBack: number,
  env: Env,
  opts?: { start_date?: string; end_date?: string; progressive_window_id?: string }
): Promise<BackfillProgress> {
  const progressKey = `backfill_progress:${userId}`;
  const existing = await env.KV.get<BackfillProgress>(progressKey, 'json');

  let backfillStart: Date;
  let backfillEnd: Date;

  if (opts?.start_date) {
    backfillStart = new Date(opts.start_date);
    backfillEnd = opts.end_date ? new Date(opts.end_date) : new Date();
  } else {
    // Bug fix 2026-04-28: previously this set backfillEnd = initialSyncCutoff
    // (now - sync_history_days). When daysBack === sync_history_days (e.g. user
    // has sync_history_days=90 and clicks "Last 90 days") the range collapsed
    // to zero and the backfill silently fetched 0 emails. The original intent
    // was to fill the gap BEFORE the standard delta sync covers, but that
    // gap is empty when the two windows match. Always use 'now' as the upper
    // bound. Dedup in stage-approvals (INSERT OR IGNORE on external_message_id)
    // makes any overlap with delta-sync results harmless.
    backfillStart = new Date(Date.now() - daysBack * 86400000);
    backfillEnd = new Date();
  }

  let progress: BackfillProgress;
  if (existing && existing.status === 'in_progress') {
    progress = existing;
  } else {
    progress = {
      status: 'in_progress',
      total_fetched: existing?.total_fetched || 0,
      last_page_url: existing?.last_page_url || null,
      started_at: existing?.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      target_start_date: backfillStart.toISOString(),
      target_end_date: backfillEnd.toISOString(),
    };
  }

  const failState = await env.KV.get<{ count: number }>(
    `token_failed:${userId}:outlook`,
    'json'
  );
  if (failState && failState.count >= 3) {
    progress.status = 'failed';
    progress.error = 'Token has too many failures — reconnect Outlook first';
    progress.updated_at = new Date().toISOString();
    await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
    return progress;
  }

  const refreshResult = await refreshOutlookToken(userId, orgId, env);
  if (!refreshResult.success) {
    progress.status = 'failed';
    progress.error = 'Token refresh failed';
    progress.updated_at = new Date().toISOString();
    await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
    return progress;
  }

  let token: string;
  try {
    token = await getDecryptedAccessToken(userId, env);
  } catch {
    progress.status = 'failed';
    progress.error = 'Cannot decrypt access token';
    progress.updated_at = new Date().toISOString();
    await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
    return progress;
  }

  // Wave 3: real sync_jobs row per runHistoricalBackfill invocation. Pre-fix
  // we passed `backfill-${userId}` as a synthetic syncJobId — persistClassifiedStats's
  // UPDATE silently no-op'd against the non-existent row, so Wave 2's phase 3
  // attachment-counter telemetry was invisible for this path. Now we INSERT
  // a real row before processing and UPDATE on every return.
  const userRow = await env.D1.prepare(
    'SELECT email FROM users WHERE id = ? AND org_id = ?'
  ).bind(userId, orgId).first<{ email: string | null }>();
  const userEmail = userRow?.email ?? null;

  const syncJobId = crypto.randomUUID();
  const syncJobStartedAt = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, metadata)
     VALUES (?, ?, 'progressive-backfill-window', 'running', ?, ?)`
  ).bind(
    syncJobId, orgId, syncJobStartedAt,
    JSON.stringify({
      user_id: userId,
      user_email: userEmail,
      window_start: progress.target_start_date,
      window_end: progress.target_end_date,
      resume_from_page: progress.last_page_url ? 'yes' : 'no',
      progressive_window_id: opts?.progressive_window_id ?? null,
    })
  ).run().catch(e => {
    console.error(`[backfill] sync_jobs insert failed for ${syncJobId}:`, (e as any)?.message || e);
  });

  // Helper: close out the sync_jobs row at any return point. Each invocation
  // owns one row; if a window pauses+resumes, each call gets its own row and
  // operators can SUM across them by metadata.user_id + window_start.
  //
  // When status='completed' AND opts.progressive_window_id is set, ALSO stamp
  // the matching progressive_backfill_windows row with attachment counters
  // SUMMED across every sync_jobs row that shares this progressive_window_id
  // (so multi-tick windows accumulate cleanly). Migration 0063 added the four
  // attachment columns; UI reads them directly off the windows table.
  const pwid = opts?.progressive_window_id ?? null;
  const closeSyncJob = async (status: 'completed' | 'failed' | 'paused', extra?: Record<string, unknown>) => {
    try {
      await env.D1.prepare(
        `UPDATE sync_jobs
            SET status = ?, completed_at = ?,
                metadata = json_patch(COALESCE(metadata, '{}'), ?)
          WHERE id = ?`
      ).bind(
        status, new Date().toISOString(),
        JSON.stringify({ ended_status: status, ...(extra || {}) }),
        syncJobId
      ).run();

      if (status === 'completed' && pwid) {
        // Aggregate attachment metadata across every sync_jobs row tied to
        // this progressive window (one per cron tick that touched the
        // window). The column rename below maps the per-page metadata
        // vocabulary onto the progressive_backfill_windows column names:
        //   metadata.attachments_attempted → windows.attachments_processed
        //   metadata.attachments_processed → windows.attachments_persisted
        //   metadata.attachments_failed    → windows.attachments_failed
        //   metadata.attachments_skipped   → windows.attachments_skipped
        // See migration 0063 for the rationale on the rename.
        await env.D1.prepare(
          `UPDATE progressive_backfill_windows
              SET attachments_processed = COALESCE((
                    SELECT SUM(CAST(json_extract(metadata, '$.attachments_attempted') AS INTEGER))
                      FROM sync_jobs
                     WHERE workflow_type = 'progressive-backfill-window'
                       AND json_extract(metadata, '$.progressive_window_id') = ?
                  ), 0),
                  attachments_persisted = COALESCE((
                    SELECT SUM(CAST(json_extract(metadata, '$.attachments_processed') AS INTEGER))
                      FROM sync_jobs
                     WHERE workflow_type = 'progressive-backfill-window'
                       AND json_extract(metadata, '$.progressive_window_id') = ?
                  ), 0),
                  attachments_failed = COALESCE((
                    SELECT SUM(CAST(json_extract(metadata, '$.attachments_failed') AS INTEGER))
                      FROM sync_jobs
                     WHERE workflow_type = 'progressive-backfill-window'
                       AND json_extract(metadata, '$.progressive_window_id') = ?
                  ), 0),
                  attachments_skipped = COALESCE((
                    SELECT SUM(CAST(json_extract(metadata, '$.attachments_skipped') AS INTEGER))
                      FROM sync_jobs
                     WHERE workflow_type = 'progressive-backfill-window'
                       AND json_extract(metadata, '$.progressive_window_id') = ?
                  ), 0)
            WHERE id = ?`
        ).bind(pwid, pwid, pwid, pwid, pwid).run();
      }
    } catch (e) {
      console.error(`[backfill] sync_jobs close failed for ${syncJobId}:`, (e as any)?.message || e);
    }
  };

  let url = progress.last_page_url;
  if (!url) {
    const startFilter = `$filter=receivedDateTime ge ${progress.target_start_date} and receivedDateTime lt ${progress.target_end_date}`;
    url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${MSG_SELECT}&${startFilter}&$top=50&$orderby=receivedDateTime asc`;
  }

  const internalDomains = await getOrgDomains(orgId, env);
  let pagesThisBatch = 0;
  // Bumped 2026-04-29: scheduled handler 15-min wallclock ceiling on paid
  // plan and runHistoricalBackfill is mostly network-bound, so larger
  // per-tick budgets cut total backfill duration without breaking limits.
  const MAX_PAGES_PER_CALL = 25;
  const startTime = Date.now();
  const MAX_RUNTIME_MS = 45_000;

  while (url) {
    if (pagesThisBatch >= MAX_PAGES_PER_CALL || Date.now() - startTime > MAX_RUNTIME_MS) {
      // Page batch / wallclock cap hit — function returns here. Use 'paused'
      // (NOT 'in_progress') so the frontend's auto-resume can kick in.
      // Previously this stayed at 'in_progress' with last_page_url set, but
      // nothing was actually processing — the polling UI just kept showing
      // "Importing..." indefinitely until the user manually clicked Resume.
      progress.status = 'paused';
      progress.last_page_url = url;
      progress.updated_at = new Date().toISOString();
      await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
      await closeSyncJob('paused', { reason: 'page_batch_cap', pages_processed: pagesThisBatch });
      return progress;
    }

    if (!(await checkGraphRateLimit(orgId, env))) {
      progress.status = 'paused';
      progress.last_page_url = url;
      progress.error = 'Graph API rate limit — will resume next call';
      progress.updated_at = new Date().toISOString();
      await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
      await closeSyncJob('paused', { reason: 'graph_rate_limit', pages_processed: pagesThisBatch });
      return progress;
    }

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await recordGraphApiCall(orgId, env);
    pagesThisBatch++;

    if (!resp.ok) {
      if (resp.status === 401) await recordTokenFailure(userId, 'outlook', env);
      progress.status = 'failed';
      progress.error = `Graph API error: ${resp.status}`;
      progress.last_page_url = url;
      progress.updated_at = new Date().toISOString();
      await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
      await closeSyncJob('failed', { reason: 'graph_error', http_status: resp.status, pages_processed: pagesThisBatch });
      return progress;
    }

    const data = (await resp.json()) as {
      value: OutlookMessage[];
      '@odata.nextLink'?: string;
    };

    const items: ClassifiableItem[] = [];
    for (const msg of data.value) {
      const direction = classifyDirection(msg, internalDomains);
      items.push(messageToClassifiableItem(msg, direction, userId, orgId));
    }

    // Wave 2 convergence: route through the same helper the chunk workflow
    // uses (classify → stage → embed → process-attachments → detect-deals).
    // Pre-Wave-2 this path inlined classify/stage/embed only and silently
    // skipped process-attachments + detect-deals — see Diagnostic 1, the bug
    // that caused 85 declared email attachments to produce 0 documents rows.
    let classified: any[] = [];
    if (items.length > 0) {
      try {
        const { classifyAndDeduplicate } = await import('../lib/classification');
        classified = await classifyAndDeduplicate(items, orgId, env);
      } catch (e) {
        console.error(`[backfill] classifyAndDeduplicate failed for batch (page ${pagesThisBatch}):`, e);
        classified = [];
      }
    }

    if (classified.length > 0) {
      const { processClassifiedItems, persistClassifiedStats } = await import('../lib/ingestion-shared');
      // Wrap in try/catch so an uncaught throw inside the helper (e.g. a
      // KV 429 cascading out of chunkEmbedAndPersistAll past its inner
      // catches, or an `await import` that fails between phases) doesn't
      // leave the sync_jobs row stuck in 'running' indefinitely. Without
      // this, diagnostic 2026-04-29 found dozens of progressive-backfill
      // rows dangling in 'running' for 30+ minutes after their owning
      // function had thrown — closeSyncJob is only called from clean
      // return points, never a catch.
      try {
        const stats = await processClassifiedItems(
          classified,
          { orgId, syncJobId },
          env
        );
        // Accumulate this page's counters into the sync_jobs metadata. Each
        // page does its own UPDATE — partial progress is recorded even if
        // a later page hits the rate-limit / page-cap return paths.
        await persistClassifiedStats(stats, syncJobId, env);
        console.log(
          `[backfill] page=${pagesThisBatch} ` +
          `staged=${stats.items_staged}/${stats.items_total} ` +
          `embedded=${stats.items_embedded} embed_fail=${stats.embed_failures} ` +
          `attachments(att/proc/skip/fail)=${stats.attachments_attempted}/${stats.attachments_processed}/${stats.attachments_skipped}/${stats.attachments_failed} ` +
          `deals_staged=${stats.deal_signals_staged} errors=${stats.errors.length}`
        );
        if (stats.errors.length > 0) {
          console.warn(`[backfill] page=${pagesThisBatch} errors:`, stats.errors.slice(0, 5));
        }
      } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 500);
        console.error(`[backfill] processClassifiedItems threw on page ${pagesThisBatch}: ${msg}`);
        progress.status = 'failed';
        progress.error = `processClassifiedItems threw: ${msg}`;
        progress.last_page_url = url;
        progress.updated_at = new Date().toISOString();
        await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
        await closeSyncJob('failed', {
          reason: 'process_classified_items_threw',
          error: msg,
          pages_processed: pagesThisBatch,
        });
        return progress;
      }
    }

    progress.total_fetched += data.value.length;

    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink'];
    } else {
      url = '';
    }
  }

  progress.status = 'completed';
  progress.last_page_url = null;
  progress.updated_at = new Date().toISOString();
  await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 * 7 });

  // Self-heal: enqueue any conversations created during this backfill that
  // didn't make it into vector_entity_index. The inline path doesn't have
  // detect-embed-gaps like the workflow finalizer does — a Workers AI hiccup
  // mid-batch would leave a conversation row without vectors. The hourly
  // self-heal cron also catches these, but enqueuing here means the retry
  // queue gets populated immediately without waiting up to an hour.
  try {
    const gaps = await env.D1.prepare(
      `SELECT c.id FROM conversations c
         LEFT JOIN vector_entity_index vei
                ON vei.entity_id = c.id
               AND vei.source_table = 'conversations'
               AND vei.org_id = c.org_id
        WHERE c.org_id = ?
          AND c.created_at >= ?
          AND vei.entity_id IS NULL`
    ).bind(orgId, progress.started_at).all<{ id: string }>();

    if (gaps.results.length > 0) {
      console.warn(
        `[backfill] enqueueing ${gaps.results.length} embed gaps from inline backfill for retry`
      );
      const enqueue = env.D1.prepare(
        `INSERT OR IGNORE INTO embed_retry_queue (org_id, entity_id, source_table) VALUES (?, ?, 'conversations')`
      );
      await env.D1.batch(gaps.results.map(g => enqueue.bind(orgId, g.id)));
    }
  } catch (e) {
    // Self-heal best-effort — don't fail the backfill response on enqueue
    // errors; the hourly self-heal cron will catch any missed gaps.
    console.error('[backfill] gap enqueue failed:', e);
  }

  await closeSyncJob('completed', { pages_processed: pagesThisBatch });
  return progress;
}

// --- Calendar delta sync ---

interface OutlookCalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName?: string };
  body?: { content?: string };
  attendees: Array<{
    emailAddress: { name?: string; address: string };
    type?: 'required' | 'optional' | 'resource';
    status?: { response?: string };
  }>;
  organizer: { emailAddress: { name?: string; address: string } };
}

export interface CalendarSyncResult {
  events_upserted: number;
  errors: Array<{ user_id: string; error: string; http_status?: number }>;
}

export async function fetchOutlookCalendarDelta(
  orgId: string,
  env: Env
): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = { events_upserted: 0, errors: [] };
  const users = await getActiveUsersForOrg(orgId, env);

  for (const user of users) {
    const failState = await env.KV.get<{ count: number }>(
      `token_failed:${user.id}:outlook`,
      'json'
    );
    if (failState && failState.count >= 3) {
      result.errors.push({ user_id: user.id, error: 'token_failed_threshold_exceeded' });
      continue;
    }

    const refreshResult = await refreshOutlookToken(user.id, orgId, env);
    if (!refreshResult.success) {
      result.errors.push({ user_id: user.id, error: 'token_refresh_failed' });
      continue;
    }

    let token: string;
    try {
      token = await getDecryptedAccessToken(user.id, env);
    } catch {
      result.errors.push({ user_id: user.id, error: 'token_decrypt_failed' });
      continue;
    }

    const start = new Date(Date.now() - 30 * 86400000).toISOString();
    const end = new Date(Date.now() + 90 * 86400000).toISOString();

    const deltaKey = `calendar_delta:${user.id}`;
    const storedDelta = await env.KV.get(deltaKey);
    let url: string = storedDelta
      ? storedDelta
      : `https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=${encodeURIComponent(
          start
        )}&endDateTime=${encodeURIComponent(end)}&$top=50`;

    const events: OutlookCalendarEvent[] = [];

    try {
      while (url) {
        if (!(await checkGraphRateLimit(orgId, env))) {
          console.log(`[outlook] Graph rate limit approaching for calendar sync, pausing`);
          break;
        }

        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: 'odata.maxpagesize=50, outlook.timezone="UTC"',
          },
        });
        await recordGraphApiCall(orgId, env);

        if (!resp.ok) {
          const status = resp.status;
          // 410 Gone is the documented signal for "delta token expired";
          // however Microsoft Graph also returns 400 with errors like
          // "Resync required" or "Bad delta link" when the delta is stale,
          // so treat 400 the same way: discard delta, log, retry next run
          // with a fresh full sync. Audit 2026-04-28: Lucas, Alvaro, and
          // Tony all sat with broken deltas for >24h because we only handled
          // 410.
          if (status === 410 || status === 400) {
            await env.KV.delete(deltaKey);
            console.warn(`[outlook] Calendar delta token rejected (HTTP ${status}) for user ${user.id}, cleared for full re-sync`);
          } else if (status === 401) {
            await recordTokenFailure(user.id, 'outlook', env);
          }
          result.errors.push({ user_id: user.id, error: `graph_api_error`, http_status: status });
          break;
        }

        const data = (await resp.json()) as {
          value: OutlookCalendarEvent[];
          '@odata.nextLink'?: string;
          '@odata.deltaLink'?: string;
        };
        events.push(...(data.value || []));

        if (data['@odata.nextLink']) {
          url = data['@odata.nextLink'];
        } else {
          if (data['@odata.deltaLink']) {
            await env.KV.put(deltaKey, data['@odata.deltaLink'], {
              expirationTtl: 2592000, // 30 days
            });
          }
          url = '';
        }
      }
    } catch (e) {
      console.error(`Outlook calendar sync error for user ${user.id}:`, e);
      result.errors.push({ user_id: user.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    for (const event of events) {
      try {
        await upsertOutlookEvent(event, orgId, env);
        result.events_upserted++;
      } catch (e) {
        console.error(`Upsert event failed for ${event.id}:`, e);
        result.errors.push({ user_id: user.id, error: `upsert_failed:${event.id}` });
      }
    }
  }

  return result;
}

// TRD §6.1 — Microsoft Graph email + calendar delta sync
import type { Env } from '../types/env';
import type { ClassifiableItem } from '../types/interfaces';
import {
  getActiveUsersForOrg,
  getOrgDomains,
  getOrgSettings,
  getDecryptedAccessToken,
} from '../lib/helpers';
import { stripHtml } from '../lib/helpers';
import { refreshOutlookToken, recordTokenFailure } from './oauth';
import { upsertOutlookEvent } from '../lib/reconciliation';
import { checkGraphRateLimit, recordGraphApiCall } from '../lib/rate-limit';

interface OutlookMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: 'text' | 'html'; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  sentDateTime: string;
  receivedDateTime: string;
  conversationId: string;
  importance?: 'low' | 'normal' | 'high';
  hasAttachments?: boolean;
}

const MSG_SELECT = '$select=id,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,importance,hasAttachments';

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

function classifyDirection(
  msg: OutlookMessage,
  internalDomains: string[]
): 'inbound' | 'outbound' | 'internal' {
  const allRecipients = [
    ...msg.toRecipients.map(r => r.emailAddress.address),
    ...msg.ccRecipients.map(r => r.emailAddress.address),
  ];
  const fromIsInternal = internalDomains.some(d =>
    msg.from.emailAddress.address.endsWith(`@${d}`)
  );
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

  return {
    type: 'email',
    source: 'outlook',
    externalId: msg.id,
    threadId: msg.conversationId,
    subject: msg.subject,
    bodyText:
      msg.body.contentType === 'html' ? stripHtml(msg.body.content) : msg.body.content,
    bodyPreview: (msg.bodyPreview || '').substring(0, 500),
    fromEmail: msg.from.emailAddress.address,
    fromName: msg.from.emailAddress.name,
    toEmails: msg.toRecipients.map(r => r.emailAddress.address),
    ccEmails: msg.ccRecipients.map(r => r.emailAddress.address),
    recipientNames,
    sentAt: msg.sentDateTime,
    direction,
    importance: msg.importance,
    userId,
    orgId,
    visibility: 'org_wide',
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
  env: Env
): Promise<BackfillProgress> {
  const progressKey = `backfill_progress:${userId}`;
  const existing = await env.KV.get<BackfillProgress>(progressKey, 'json');

  const syncConfig = await getUserSyncConfig(userId, env);
  const initialSyncCutoff = new Date(Date.now() - syncConfig.sync_history_days * 86400000);
  const backfillStart = new Date(Date.now() - daysBack * 86400000);

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
      target_end_date: initialSyncCutoff.toISOString(),
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

  let url = progress.last_page_url;
  if (!url) {
    const startFilter = `$filter=receivedDateTime ge ${progress.target_start_date} and receivedDateTime lt ${progress.target_end_date}`;
    url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${MSG_SELECT}&${startFilter}&$top=50&$orderby=receivedDateTime asc`;
  }

  const internalDomains = await getOrgDomains(orgId, env);
  let pagesThisBatch = 0;
  const MAX_PAGES_PER_CALL = 10;
  const startTime = Date.now();
  const MAX_RUNTIME_MS = 25_000; // leave headroom before Worker 30s limit

  while (url) {
    if (pagesThisBatch >= MAX_PAGES_PER_CALL || Date.now() - startTime > MAX_RUNTIME_MS) {
      progress.status = 'in_progress';
      progress.last_page_url = url;
      progress.updated_at = new Date().toISOString();
      await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
      return progress;
    }

    if (!(await checkGraphRateLimit(orgId, env))) {
      progress.status = 'paused';
      progress.last_page_url = url;
      progress.error = 'Graph API rate limit — will resume next call';
      progress.updated_at = new Date().toISOString();
      await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: 86400 });
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

    // Store each message as a conversation via the same ingestion path
    if (items.length > 0) {
      const { classifyAndDeduplicate } = await import('../lib/classification');
      const { stageAndCommitApprovals } = await import('../lib/stage-approvals');
      const classified = await classifyAndDeduplicate(items, orgId, env);
      await stageAndCommitApprovals(classified, orgId, `backfill-${userId}`, env);
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

export async function fetchOutlookCalendarDelta(
  orgId: string,
  env: Env
): Promise<void> {
  const users = await getActiveUsersForOrg(orgId, env);

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
          if (resp.status === 410) {
            await env.KV.delete(deltaKey);
            console.warn(`[outlook] Calendar delta token expired (410) for user ${user.id}, cleared for full re-sync`);
          } else if (resp.status === 401) {
            await recordTokenFailure(user.id, 'outlook', env);
          }
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
      continue;
    }

    for (const event of events) {
      try {
        await upsertOutlookEvent(event, orgId, env);
      } catch (e) {
        console.error(`Upsert event failed for ${event.id}:`, e);
      }
    }
  }
}

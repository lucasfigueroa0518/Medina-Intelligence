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

export async function fetchOutlookDelta(
  orgId: string,
  env: Env
): Promise<ClassifiableItem[]> {
  const users = await getActiveUsersForOrg(orgId, env);
  const allItems: ClassifiableItem[] = [];

  for (const user of users) {
    // Skip users with dead tokens
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

    const deltaToken = user.outlook_delta_token;

    let url: string;
    if (deltaToken) {
      url = deltaToken;
    } else {
      const backfillDays = (await getOrgSettings(orgId, env)).outlook_backfill_days || 180;
      const since = new Date(
        Date.now() - backfillDays * 86400000
      ).toISOString();
      url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,importance,hasAttachments&$filter=receivedDateTime ge ${since}&$top=50`;
    }

    const messages: OutlookMessage[] = [];

    try {
      while (url) {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          if (resp.status === 401) {
            await recordTokenFailure(user.id, 'outlook', env);
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
            await env.D1.prepare(
              'UPDATE users SET outlook_delta_token = ? WHERE id = ?'
            ).bind(data['@odata.deltaLink'], user.id).run();
          }
          url = '';
        }
      }
    } catch (e) {
      console.error(`Outlook sync error for user ${user.id}:`, e);
      continue;
    }

    const internalDomains = await getOrgDomains(orgId, env);

    for (const msg of messages) {
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

      let direction: 'inbound' | 'outbound' | 'internal';
      if (fromIsInternal && allRecipientsInternal) direction = 'internal';
      else if (fromIsInternal) direction = 'outbound';
      else direction = 'inbound';

      allItems.push({
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
        sentAt: msg.sentDateTime,
        direction,
        importance: msg.importance,
        userId: user.id,
        orgId,
        visibility: 'org_wide',
      });
    }
  }

  return allItems;
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
        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: 'odata.maxpagesize=50, outlook.timezone="UTC"',
          },
        });
        if (!resp.ok) {
          if (resp.status === 401) await recordTokenFailure(user.id, 'outlook', env);
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

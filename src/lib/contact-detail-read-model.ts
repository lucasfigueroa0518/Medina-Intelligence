import type { AuthContext } from '../types/interfaces';
import type { Env } from '../types/env';
import {
  canReadConversationContent,
  getSharingFlags,
  hasOrgWidePrivateDataAccess,
  parseParticipantUserIds,
} from './helpers';
import { isDocumentAccessibleToUser } from './document-acl';

export interface CanonicalContactResolution {
  contactId: string;
  redirectedFrom: string | null;
}

export interface ContactActivityRollup {
  first_interaction_date: string | null;
  last_activity_at: string | null;
  last_conversation_at: string | null;
  last_event_at: string | null;
  last_task_at: string | null;
  last_document_at: string | null;
  conversation_count: number;
  event_count: number;
  task_count: number;
  document_count: number;
  weekly_interactions: Array<{ week: string; week_start: string; cnt: number }>;
}

interface ContactRowForResolution {
  id: string;
  merged_into: string | null;
  deleted_at: string | null;
}

interface TimelineItemRow {
  id: string;
  org_id: string;
  contact_id: string;
  item_type: 'conversation' | 'event' | 'task' | 'document';
  item_id: string;
  item_timestamp: string;
  title: string | null;
  subtype: string | null;
  body_preview: string | null;
  source: string | null;
  external_thread_id: string | null;
  external_message_id: string | null;
  participant_user_ids: string | null;
  visibility: string | null;
  uploaded_by: string | null;
  metadata: string | null;
}

const MAX_MERGE_HOPS = 8;
const DEFAULT_REPAIR_LIMIT = 100;

export function contactTimelineItemId(contactId: string, itemType: string, itemId: string): string {
  return `${contactId}:${itemType}:${itemId}`;
}

export function parseWeeklyInteractions(raw: string | null | undefined): Array<{ week: string; week_start: string; cnt: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row: any) => ({
        week: String(row.week || ''),
        week_start: String(row.week_start || ''),
        cnt: Number(row.cnt || 0),
      }))
      .filter(row => row.week && row.week_start && Number.isFinite(row.cnt));
  } catch {
    return [];
  }
}

export async function resolveCanonicalContactId(
  env: Env,
  orgId: string,
  requestedId: string
): Promise<CanonicalContactResolution | null> {
  let currentId = requestedId;
  let redirectedFrom: string | null = null;
  const seen = new Set<string>();

  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);

    const row = await env.D1.prepare(
      `SELECT id, merged_into, deleted_at
         FROM contacts
        WHERE id = ? AND org_id = ?`
    ).bind(currentId, orgId).first<ContactRowForResolution>();

    if (!row) return null;
    if (row.merged_into) {
      redirectedFrom = redirectedFrom || requestedId;
      currentId = row.merged_into;
      continue;
    }
    if (row.deleted_at) return null;
    return { contactId: row.id, redirectedFrom };
  }

  return null;
}

export async function loadContactActivityRollup(
  env: Env,
  orgId: string,
  contactId: string
): Promise<ContactActivityRollup | null> {
  const row = await env.D1.prepare(
    `SELECT first_interaction_date, last_activity_at, last_conversation_at, last_event_at,
            last_task_at, last_document_at, conversation_count, event_count, task_count,
            document_count, weekly_interactions_json
       FROM contact_activity_rollups
      WHERE org_id = ? AND contact_id = ?`
  ).bind(orgId, contactId).first<any>();

  if (!row) return null;
  return {
    first_interaction_date: row.first_interaction_date || null,
    last_activity_at: row.last_activity_at || null,
    last_conversation_at: row.last_conversation_at || null,
    last_event_at: row.last_event_at || null,
    last_task_at: row.last_task_at || null,
    last_document_at: row.last_document_at || null,
    conversation_count: Number(row.conversation_count || 0),
    event_count: Number(row.event_count || 0),
    task_count: Number(row.task_count || 0),
    document_count: Number(row.document_count || 0),
    weekly_interactions: parseWeeklyInteractions(row.weekly_interactions_json),
  };
}

export async function recordContactDetailReadModelRepair(
  env: Env,
  orgId: string,
  contactId: string,
  reason: string,
  error?: unknown,
  metadata?: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  const id = `contact-detail-repair:${orgId}:${contactId}:${reason}`;
  const lastError = error instanceof Error ? error.message : error ? String(error) : null;
  await env.D1.prepare(
    `INSERT INTO contact_detail_read_model_repairs
       (id, org_id, contact_id, reason, status, attempts, last_error, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(org_id, contact_id, reason) DO UPDATE SET
       status = excluded.status,
       attempts = contact_detail_read_model_repairs.attempts + 1,
       last_error = excluded.last_error,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at,
       completed_at = NULL`
  ).bind(
    id,
    orgId,
    contactId,
    reason,
    lastError ? 'failed' : 'pending',
    lastError,
    JSON.stringify(metadata || {}),
    now,
    now
  ).run();
}

export async function deleteContactDetailReadModelForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  await env.D1.batch([
    env.D1.prepare(`DELETE FROM contact_timeline_items WHERE org_id = ? AND contact_id = ?`).bind(orgId, contactId),
    env.D1.prepare(`DELETE FROM contact_activity_rollups WHERE org_id = ? AND contact_id = ?`).bind(orgId, contactId),
  ]);
}

export async function safelyDeleteContactDetailReadModelForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  try {
    await deleteContactDetailReadModelForContact(env, orgId, contactId);
  } catch (error) {
    console.error('[contact-detail] delete failed', { orgId, contactId, error });
    await recordContactDetailReadModelRepair(env, orgId, contactId, 'delete_failed', error).catch(() => {});
  }
}

async function refreshContactActivityRollupFromTimeline(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  const now = new Date().toISOString();
  const [summary, weekly] = await Promise.all([
    env.D1.prepare(
      `SELECT
          MIN(CASE WHEN item_type IN ('conversation', 'event') THEN item_timestamp END) AS first_interaction_date,
          MAX(item_timestamp) AS last_activity_at,
          MAX(CASE WHEN item_type = 'conversation' THEN item_timestamp END) AS last_conversation_at,
          MAX(CASE WHEN item_type = 'event' THEN item_timestamp END) AS last_event_at,
          MAX(CASE WHEN item_type = 'task' THEN item_timestamp END) AS last_task_at,
          MAX(CASE WHEN item_type = 'document' THEN item_timestamp END) AS last_document_at,
          SUM(CASE WHEN item_type = 'conversation' THEN 1 ELSE 0 END) AS conversation_count,
          SUM(CASE WHEN item_type = 'event' THEN 1 ELSE 0 END) AS event_count,
          SUM(CASE WHEN item_type = 'task' THEN 1 ELSE 0 END) AS task_count,
          SUM(CASE WHEN item_type = 'document' THEN 1 ELSE 0 END) AS document_count
         FROM contact_timeline_items
        WHERE org_id = ? AND contact_id = ?`
    ).bind(orgId, contactId).first<any>(),
    env.D1.prepare(
      `SELECT strftime('%Y-%W', c.sent_at) AS week,
              MIN(c.sent_at) AS week_start,
              COUNT(*) AS cnt
         FROM conversation_contacts cc
         JOIN conversations c ON c.id = cc.conversation_id AND c.org_id = ?
        WHERE cc.contact_id = ? AND c.sent_at >= date('now', '-56 days')
        GROUP BY week
        ORDER BY week`
    ).bind(orgId, contactId).all<any>(),
  ]);

  const weeklyJson = JSON.stringify((weekly.results || []).map(row => ({
    week: row.week,
    week_start: row.week_start,
    cnt: Number(row.cnt || 0),
  })));

  await env.D1.prepare(
    `INSERT INTO contact_activity_rollups
       (contact_id, org_id, first_interaction_date, last_activity_at,
        last_conversation_at, last_event_at, last_task_at, last_document_at,
        conversation_count, event_count, task_count, document_count,
        weekly_interactions_json, rebuilt_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET
       org_id = excluded.org_id,
       first_interaction_date = excluded.first_interaction_date,
       last_activity_at = excluded.last_activity_at,
       last_conversation_at = excluded.last_conversation_at,
       last_event_at = excluded.last_event_at,
       last_task_at = excluded.last_task_at,
       last_document_at = excluded.last_document_at,
       conversation_count = excluded.conversation_count,
       event_count = excluded.event_count,
       task_count = excluded.task_count,
       document_count = excluded.document_count,
       weekly_interactions_json = excluded.weekly_interactions_json,
       rebuilt_at = excluded.rebuilt_at,
       updated_at = excluded.updated_at`
  ).bind(
    contactId,
    orgId,
    summary?.first_interaction_date || null,
    summary?.last_activity_at || null,
    summary?.last_conversation_at || null,
    summary?.last_event_at || null,
    summary?.last_task_at || null,
    summary?.last_document_at || null,
    Number(summary?.conversation_count || 0),
    Number(summary?.event_count || 0),
    Number(summary?.task_count || 0),
    Number(summary?.document_count || 0),
    weeklyJson,
    now,
    now
  ).run();
}

export async function upsertConversationTimelineItemsForContacts(
  env: Env,
  orgId: string,
  conversationId: string,
  contactIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(contactIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = uniqueIds.map(() => '?').join(',');

  await env.D1.prepare(
    `INSERT OR REPLACE INTO contact_timeline_items
       (id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
        body_preview, source, external_thread_id, external_message_id, participant_user_ids,
        metadata, created_at, updated_at)
     SELECT (cc.contact_id || ':conversation:' || c.id), c.org_id, cc.contact_id,
            'conversation', c.id, c.sent_at, c.subject, c.source, c.body_preview,
            c.source, c.external_thread_id, c.external_message_id, c.participant_user_ids,
            json_object(
              'is_campaign_email', COALESCE(c.is_campaign_email, 0),
              'from_email', c.from_email,
              'has_attachments', COALESCE(c.has_attachments, 0),
              'attachment_count', COALESCE(c.attachment_count, 0),
              'slack_is_private', COALESCE(sc.is_private, 0)
            ),
            ?, ?
       FROM conversation_contacts cc
       JOIN conversations c ON c.id = cc.conversation_id AND c.org_id = ?
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
      WHERE cc.conversation_id = ?
        AND cc.contact_id IN (${placeholders})
        AND c.sent_at IS NOT NULL`
  ).bind(now, now, orgId, conversationId, ...uniqueIds).run();

  await Promise.all(uniqueIds.map(contactId => refreshContactActivityRollupFromTimeline(env, orgId, contactId)));
}

export async function safelyUpsertConversationTimelineItemsForContacts(
  env: Env,
  orgId: string,
  conversationId: string,
  contactIds: string[],
  reason = 'conversation_linked'
): Promise<void> {
  try {
    await upsertConversationTimelineItemsForContacts(env, orgId, conversationId, contactIds);
  } catch (error) {
    console.error('[contact-detail] conversation upsert failed', { orgId, conversationId, contactIds, error });
    await Promise.all(contactIds.map(contactId =>
      recordContactDetailReadModelRepair(env, orgId, contactId, reason, error, { conversationId }).catch(() => {})
    ));
  }
}

export async function upsertEventTimelineItemsForContacts(
  env: Env,
  orgId: string,
  eventId: string,
  contactIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(contactIds.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = uniqueIds.map(() => '?').join(',');

  await env.D1.prepare(
    `INSERT OR REPLACE INTO contact_timeline_items
       (id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
        participant_user_ids, metadata, created_at, updated_at)
     SELECT (ea.contact_id || ':event:' || e.id), e.org_id, ea.contact_id,
            'event', e.id, e.start_time, e.title, e.event_type,
            GROUP_CONCAT(all_ea.user_id), '{}', ?, ?
       FROM event_attendees ea
       JOIN events e ON e.id = ea.event_id AND e.org_id = ? AND e.deleted_at IS NULL
       LEFT JOIN event_attendees all_ea ON all_ea.event_id = e.id
      WHERE ea.event_id = ?
        AND ea.contact_id IN (${placeholders})
        AND e.start_time IS NOT NULL
      GROUP BY e.id, ea.contact_id`
  ).bind(now, now, orgId, eventId, ...uniqueIds).run();

  await Promise.all(uniqueIds.map(contactId => refreshContactActivityRollupFromTimeline(env, orgId, contactId)));
}

export async function safelyUpsertEventTimelineItemsForContacts(
  env: Env,
  orgId: string,
  eventId: string,
  contactIds: string[],
  reason = 'event_linked'
): Promise<void> {
  try {
    await upsertEventTimelineItemsForContacts(env, orgId, eventId, contactIds);
  } catch (error) {
    console.error('[contact-detail] event upsert failed', { orgId, eventId, contactIds, error });
    await Promise.all(contactIds.map(contactId =>
      recordContactDetailReadModelRepair(env, orgId, contactId, reason, error, { eventId }).catch(() => {})
    ));
  }
}

export async function rebuildContactDetailReadModelForContact(
  env: Env,
  orgId: string,
  contactId: string
): Promise<void> {
  const now = new Date().toISOString();

  const contact = await env.D1.prepare(
    `SELECT id FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{ id: string }>();
  if (!contact) {
    await deleteContactDetailReadModelForContact(env, orgId, contactId);
    return;
  }

  const deleteTimeline = env.D1.prepare(
    `DELETE FROM contact_timeline_items WHERE org_id = ? AND contact_id = ?`
  ).bind(orgId, contactId);

  const insertConversations = env.D1.prepare(
    `INSERT OR REPLACE INTO contact_timeline_items
       (id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
        body_preview, source, external_thread_id, external_message_id, participant_user_ids,
        metadata, created_at, updated_at)
     SELECT (? || ':conversation:' || c.id), c.org_id, ?, 'conversation', c.id, c.sent_at,
            c.subject, c.source, c.body_preview, c.source, c.external_thread_id,
            c.external_message_id, c.participant_user_ids,
            json_object(
              'is_campaign_email', COALESCE(c.is_campaign_email, 0),
              'from_email', c.from_email,
              'has_attachments', COALESCE(c.has_attachments, 0),
              'attachment_count', COALESCE(c.attachment_count, 0),
              'slack_is_private', COALESCE(sc.is_private, 0)
            ),
            ?, ?
       FROM conversation_contacts cc
       JOIN conversations c ON c.id = cc.conversation_id AND c.org_id = ?
       LEFT JOIN slack_channels sc
         ON c.source = 'slack'
        AND sc.org_id = c.org_id
        AND sc.channel_id = CASE
          WHEN instr(c.external_message_id, ':') > 0
          THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
          ELSE c.external_message_id
        END
      WHERE cc.contact_id = ?
        AND c.sent_at IS NOT NULL`
  ).bind(contactId, contactId, now, now, orgId, contactId);

  const insertEvents = env.D1.prepare(
    `INSERT OR REPLACE INTO contact_timeline_items
       (id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
        participant_user_ids, metadata, created_at, updated_at)
     SELECT (? || ':event:' || e.id), e.org_id, ?, 'event', e.id, e.start_time,
            e.title, e.event_type, GROUP_CONCAT(all_ea.user_id), '{}', ?, ?
       FROM event_attendees ea
       JOIN events e ON e.id = ea.event_id AND e.org_id = ? AND e.deleted_at IS NULL
       LEFT JOIN event_attendees all_ea ON all_ea.event_id = e.id
      WHERE ea.contact_id = ?
        AND e.start_time IS NOT NULL
      GROUP BY e.id`
  ).bind(contactId, contactId, now, now, orgId, contactId);

  const insertTasks = env.D1.prepare(
    `INSERT OR REPLACE INTO contact_timeline_items
       (id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
        metadata, created_at, updated_at)
     SELECT (? || ':task:' || t.id), t.org_id, ?, 'task', t.id,
            COALESCE(t.due_date, t.created_at), t.title, t.status, '{}', ?, ?
       FROM tasks t
      WHERE t.contact_id = ?
        AND t.org_id = ?
        AND t.deleted_at IS NULL
        AND COALESCE(t.due_date, t.created_at) IS NOT NULL`
  ).bind(contactId, contactId, now, now, contactId, orgId);

  const insertDocuments = env.D1.prepare(
    `INSERT OR REPLACE INTO contact_timeline_items
       (id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
        visibility, participant_user_ids, uploaded_by, metadata, created_at, updated_at)
     SELECT (? || ':document:' || d.id), d.org_id, ?, 'document', d.id, d.created_at,
            d.title, d.document_type, d.visibility, d.participant_user_ids, d.uploaded_by,
            json_object('file_name', d.file_name), ?, ?
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id AND d.org_id = ? AND d.deleted_at IS NULL
      WHERE dl.entity_type = 'contact'
        AND dl.entity_id = ?
        AND dl.deleted_at IS NULL
        AND COALESCE(json_extract(d.custom_fields, '$.marty_lab_generated'), 0) != 1
        AND d.created_at IS NOT NULL`
  ).bind(contactId, contactId, now, now, orgId, contactId);

  await env.D1.batch([deleteTimeline, insertConversations, insertEvents, insertTasks, insertDocuments]);

  const [summary, weekly] = await Promise.all([
    env.D1.prepare(
      `SELECT
          MIN(CASE WHEN item_type IN ('conversation', 'event') THEN item_timestamp END) AS first_interaction_date,
          MAX(item_timestamp) AS last_activity_at,
          MAX(CASE WHEN item_type = 'conversation' THEN item_timestamp END) AS last_conversation_at,
          MAX(CASE WHEN item_type = 'event' THEN item_timestamp END) AS last_event_at,
          MAX(CASE WHEN item_type = 'task' THEN item_timestamp END) AS last_task_at,
          MAX(CASE WHEN item_type = 'document' THEN item_timestamp END) AS last_document_at,
          SUM(CASE WHEN item_type = 'conversation' THEN 1 ELSE 0 END) AS conversation_count,
          SUM(CASE WHEN item_type = 'event' THEN 1 ELSE 0 END) AS event_count,
          SUM(CASE WHEN item_type = 'task' THEN 1 ELSE 0 END) AS task_count,
          SUM(CASE WHEN item_type = 'document' THEN 1 ELSE 0 END) AS document_count
         FROM contact_timeline_items
        WHERE org_id = ? AND contact_id = ?`
    ).bind(orgId, contactId).first<any>(),
    env.D1.prepare(
      `SELECT strftime('%Y-%W', c.sent_at) AS week,
              MIN(c.sent_at) AS week_start,
              COUNT(*) AS cnt
         FROM conversation_contacts cc
         JOIN conversations c ON c.id = cc.conversation_id AND c.org_id = ?
        WHERE cc.contact_id = ? AND c.sent_at >= date('now', '-56 days')
        GROUP BY week
        ORDER BY week`
    ).bind(orgId, contactId).all<any>(),
  ]);

  const weeklyJson = JSON.stringify((weekly.results || []).map(row => ({
    week: row.week,
    week_start: row.week_start,
    cnt: Number(row.cnt || 0),
  })));

  await env.D1.prepare(
    `INSERT INTO contact_activity_rollups
       (contact_id, org_id, first_interaction_date, last_activity_at,
        last_conversation_at, last_event_at, last_task_at, last_document_at,
        conversation_count, event_count, task_count, document_count,
        weekly_interactions_json, rebuilt_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET
       org_id = excluded.org_id,
       first_interaction_date = excluded.first_interaction_date,
       last_activity_at = excluded.last_activity_at,
       last_conversation_at = excluded.last_conversation_at,
       last_event_at = excluded.last_event_at,
       last_task_at = excluded.last_task_at,
       last_document_at = excluded.last_document_at,
       conversation_count = excluded.conversation_count,
       event_count = excluded.event_count,
       task_count = excluded.task_count,
       document_count = excluded.document_count,
       weekly_interactions_json = excluded.weekly_interactions_json,
       rebuilt_at = excluded.rebuilt_at,
       updated_at = excluded.updated_at`
  ).bind(
    contactId,
    orgId,
    summary?.first_interaction_date || null,
    summary?.last_activity_at || null,
    summary?.last_conversation_at || null,
    summary?.last_event_at || null,
    summary?.last_task_at || null,
    summary?.last_document_at || null,
    Number(summary?.conversation_count || 0),
    Number(summary?.event_count || 0),
    Number(summary?.task_count || 0),
    Number(summary?.document_count || 0),
    weeklyJson,
    now,
    now
  ).run();

  await env.D1.prepare(
    `UPDATE contact_detail_read_model_repairs
        SET status = 'completed', last_error = NULL, updated_at = ?, completed_at = ?
      WHERE org_id = ? AND contact_id = ? AND status IN ('pending', 'running', 'failed')`
  ).bind(now, now, orgId, contactId).run();
}

export async function safelyRebuildContactDetailReadModelForContact(
  env: Env,
  orgId: string,
  contactId: string,
  reason = 'manual_or_write_through'
): Promise<void> {
  try {
    await rebuildContactDetailReadModelForContact(env, orgId, contactId);
  } catch (error) {
    console.error('[contact-detail] rebuild failed', { orgId, contactId, reason, error });
    await recordContactDetailReadModelRepair(env, orgId, contactId, reason, error).catch(() => {});
  }
}

export async function rebuildContactDetailReadModelForOrg(
  env: Env,
  orgId: string,
  limit = 500
): Promise<{ rebuilt: number; errors: number; has_more: boolean }> {
  const boundedLimit = Math.max(1, Math.min(limit, 2000));
  const rows = await env.D1.prepare(
    `SELECT id
       FROM contacts
      WHERE org_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ?`
  ).bind(orgId, boundedLimit + 1).all<{ id: string }>();

  let rebuilt = 0;
  let errors = 0;
  for (const row of rows.results.slice(0, boundedLimit)) {
    try {
      await rebuildContactDetailReadModelForContact(env, orgId, row.id);
      rebuilt++;
    } catch (error) {
      errors++;
      await recordContactDetailReadModelRepair(env, orgId, row.id, 'org_rebuild_failed', error).catch(() => {});
    }
  }

  return { rebuilt, errors, has_more: rows.results.length > boundedLimit };
}

export async function repairContactDetailReadModelDrift(
  orgId: string,
  env: Env,
  limit = DEFAULT_REPAIR_LIMIT
): Promise<{ scanned: number; repaired: number; errors: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const rows = await env.D1.prepare(
    `SELECT id FROM (
       SELECT c.id AS id
         FROM contacts c
         LEFT JOIN contact_activity_rollups r ON r.org_id = c.org_id AND r.contact_id = c.id
        WHERE c.org_id = ? AND c.deleted_at IS NULL
          AND (r.contact_id IS NULL OR c.updated_at > r.updated_at)
       UNION
       SELECT cc.contact_id AS id
         FROM conversation_contacts cc
         JOIN conversations conv ON conv.id = cc.conversation_id AND conv.org_id = ?
         JOIN contacts c ON c.id = cc.contact_id AND c.org_id = conv.org_id AND c.deleted_at IS NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM contact_timeline_items ti
           WHERE ti.org_id = conv.org_id AND ti.contact_id = cc.contact_id
             AND ti.item_type = 'conversation' AND ti.item_id = conv.id
        )
       UNION
       SELECT ea.contact_id AS id
         FROM event_attendees ea
         JOIN events e ON e.id = ea.event_id AND e.org_id = ? AND e.deleted_at IS NULL
         JOIN contacts c ON c.id = ea.contact_id AND c.org_id = e.org_id AND c.deleted_at IS NULL
        WHERE ea.contact_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM contact_timeline_items ti
             WHERE ti.org_id = e.org_id AND ti.contact_id = ea.contact_id
               AND ti.item_type = 'event' AND ti.item_id = e.id
          )
       UNION
       SELECT t.contact_id AS id
         FROM tasks t
         JOIN contacts c ON c.id = t.contact_id AND c.org_id = t.org_id AND c.deleted_at IS NULL
        WHERE t.org_id = ? AND t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM contact_timeline_items ti
             WHERE ti.org_id = t.org_id AND ti.contact_id = t.contact_id
               AND ti.item_type = 'task' AND ti.item_id = t.id
          )
       UNION
       SELECT dl.entity_id AS id
         FROM document_links dl
         JOIN documents d ON d.id = dl.document_id AND d.org_id = ?
         JOIN contacts c ON c.id = dl.entity_id AND c.org_id = d.org_id AND c.deleted_at IS NULL
        WHERE dl.entity_type = 'contact' AND dl.deleted_at IS NULL AND d.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM contact_timeline_items ti
             WHERE ti.org_id = d.org_id AND ti.contact_id = dl.entity_id
               AND ti.item_type = 'document' AND ti.item_id = d.id
          )
     )
     LIMIT ?`
  ).bind(orgId, orgId, orgId, orgId, orgId, boundedLimit).all<{ id: string }>();

  let repaired = 0;
  let errors = 0;
  for (const row of rows.results) {
    try {
      await rebuildContactDetailReadModelForContact(env, orgId, row.id);
      repaired++;
    } catch (error) {
      errors++;
      await recordContactDetailReadModelRepair(env, orgId, row.id, 'drift_repair_failed', error).catch(() => {});
    }
  }

  return { scanned: rows.results.length, repaired, errors };
}

function parseMetadata(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mapTimelineRow(row: TimelineItemRow, metadata: Record<string, any>): any {
  return {
    id: row.item_id,
    title: row.title,
    timestamp: row.item_timestamp,
    type: row.item_type,
    subtype: row.subtype,
    body_preview: row.body_preview,
    source: row.source,
    external_thread_id: row.external_thread_id,
    attachment_names: [],
    attachment_count: Number(metadata.attachment_count || 0),
    thread_count: undefined,
    occurrence_count: undefined,
  };
}

function dedupeTimelineEntries(entries: any[]): any[] {
  const threadGroups = new Map<string, any>();
  const standalone: any[] = [];

  for (const entry of entries) {
    if (entry.type !== 'conversation' || !entry.external_thread_id) {
      standalone.push(entry);
      continue;
    }
    const existing = threadGroups.get(entry.external_thread_id);
    const nextCount = (existing?.thread_count || 0) + 1;
    if (!existing || String(entry.timestamp) > String(existing.timestamp)) {
      threadGroups.set(entry.external_thread_id, { ...entry, thread_count: nextCount });
    } else {
      existing.thread_count = nextCount;
    }
  }

  const eventGroups = new Map<string, any>();
  const nonEvents: any[] = [];
  for (const entry of [...threadGroups.values(), ...standalone]) {
    if (entry.type !== 'event') {
      nonEvents.push(entry);
      continue;
    }
    const titleKey = String(entry.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const dayKey = String(entry.timestamp || '').slice(0, 10);
    const key = `${titleKey}|${dayKey}`;
    const existing = eventGroups.get(key);
    const nextCount = (existing?.occurrence_count || 0) + 1;
    if (!existing || String(entry.timestamp) > String(existing.timestamp)) {
      eventGroups.set(key, { ...entry, occurrence_count: nextCount });
    } else {
      existing.occurrence_count = nextCount;
    }
  }

  return [...eventGroups.values(), ...nonEvents]
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

export async function listContactTimelineItems(
  request: Request,
  env: Env,
  ctx: AuthContext,
  contactId: string
): Promise<{ entries: any[]; next_cursor: string | null; source_count: number }> {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200));
  const cursor = url.searchParams.get('cursor');
  const sourceLimit = Math.min(limit * 6, 800);

  const cursorClause = cursor ? 'AND item_timestamp < ?' : '';
  const binds = cursor
    ? [ctx.orgId, contactId, cursor, sourceLimit]
    : [ctx.orgId, contactId, sourceLimit];

  const rows = await env.D1.prepare(
    `SELECT id, org_id, contact_id, item_type, item_id, item_timestamp, title, subtype,
            body_preview, source, external_thread_id, external_message_id, participant_user_ids,
            visibility, uploaded_by, metadata
       FROM contact_timeline_items
      WHERE org_id = ? AND contact_id = ?
        ${cursorClause}
      ORDER BY item_timestamp DESC
      LIMIT ?`
  ).bind(...binds).all<TimelineItemRow>();

  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  const sharingSet = new Set(Object.keys(sharingFlags));
  const entries: any[] = [];

  for (const row of rows.results) {
    const metadata = parseMetadata(row.metadata);

    if (row.item_type === 'conversation') {
      const canRead = canReadConversationContent(
        {
          source: row.source,
          participant_user_ids: row.participant_user_ids,
          is_campaign_email: metadata.is_campaign_email,
          slack_is_private: metadata.slack_is_private,
        } as any,
        ctx.userId,
        ctx.userRole,
        sharingFlags
      );
      if (!canRead) continue;
    } else if (row.item_type === 'event') {
      if (!hasOrgWidePrivateDataAccess(ctx.userRole)) {
        const participants = parseParticipantUserIds(row.participant_user_ids);
        if (!participants.includes(ctx.userId) && !participants.some(pid => sharingSet.has(pid))) continue;
      }
    } else if (row.item_type === 'document') {
      if (!isDocumentAccessibleToUser(row, ctx.userId, ctx.userRole, sharingSet)) continue;
    }

    entries.push(mapTimelineRow(row, metadata));
    if (entries.length >= limit * 2) break;
  }

  const deduped = dedupeTimelineEntries(entries).slice(0, limit);
  const last = deduped[deduped.length - 1];
  return {
    entries: deduped,
    next_cursor: last ? String(last.timestamp) : null,
    source_count: rows.results.length,
  };
}

export const __contactDetailReadModelTestHooks = {
  contactTimelineItemId,
  parseWeeklyInteractions,
  dedupeTimelineEntries,
};

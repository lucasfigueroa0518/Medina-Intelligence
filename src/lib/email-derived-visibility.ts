import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import {
  canReadConversationContent,
  getSharingFlags,
  hasOrgWidePrivateDataAccess,
  parseParticipantUserIds,
} from './helpers';
import { conversationParticipantAclSql } from './conversation-participants';

export interface ConversationAclRow {
  id: string;
  source: 'outlook' | 'slack' | 'manual' | string;
  participant_user_ids: string | string[] | null;
  is_campaign_email?: number | boolean | null;
  slack_is_private?: number | boolean | null;
}

export interface SourceVisibility {
  source_id: string;
  can_read: boolean;
  exists: boolean;
}

type ViewerContext = Pick<AuthContext, 'orgId' | 'userId' | 'userRole'>;

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v))));
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',');
}

export async function loadConversationVisibilityMap(
  env: Env,
  ctx: ViewerContext,
  conversationIds: Array<string | null | undefined>
): Promise<Map<string, SourceVisibility>> {
  const ids = unique(conversationIds);
  const out = new Map<string, SourceVisibility>();
  for (const id of ids) out.set(id, { source_id: id, can_read: false, exists: false });
  if (ids.length === 0) return out;

  const [rows, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT c.id, c.source, c.participant_user_ids, c.is_campaign_email,
              sc.is_private AS slack_is_private
         FROM conversations c
         LEFT JOIN slack_channels sc
           ON c.source = 'slack'
          AND sc.org_id = c.org_id
          AND sc.channel_id = CASE
            WHEN instr(c.external_message_id, ':') > 0
            THEN substr(c.external_message_id, 1, instr(c.external_message_id, ':') - 1)
            ELSE c.external_message_id
          END
        WHERE c.org_id = ? AND c.id IN (${placeholders(ids)})`
    ).bind(ctx.orgId, ...ids).all<ConversationAclRow>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  for (const row of rows.results || []) {
    const canRead = canReadConversationContent(
      {
        source: row.source as any,
        participant_user_ids: row.participant_user_ids as any,
        is_campaign_email: row.is_campaign_email as any,
        slack_is_private: row.slack_is_private,
      },
      ctx.userId,
      ctx.userRole,
      sharingFlags
    );
    out.set(row.id, { source_id: row.id, can_read: canRead, exists: true });
  }

  return out;
}

export function conversationAclSql(
  conversationAlias: string,
  ctx: ViewerContext,
  sharingFlags: Record<string, boolean>,
  slackPrivateExpression = '0'
): { sql: string; binds: string[] } {
  if (hasOrgWidePrivateDataAccess(ctx.userRole)) return { sql: '1 = 1', binds: [] };
  const participantAcl = conversationParticipantAclSql(conversationAlias, ctx, sharingFlags, 'conversation_acl');
  return {
    sql: `(
      (${conversationAlias}.source = 'slack' AND COALESCE(${slackPrivateExpression}, 0) = 0)
      OR COALESCE(${conversationAlias}.is_campaign_email, 0) = 1
      OR ${participantAcl.sql}
    )`,
    binds: participantAcl.binds,
  };
}

export async function canViewerReadConversation(
  env: Env,
  ctx: ViewerContext,
  conversationId: string | null | undefined
): Promise<boolean> {
  if (!conversationId) return false;
  return (await loadConversationVisibilityMap(env, ctx, [conversationId])).get(conversationId)?.can_read === true;
}

export async function filterReadableConversationRows<T extends ConversationAclRow>(
  env: Env,
  ctx: ViewerContext,
  rows: T[]
): Promise<T[]> {
  if (rows.length === 0) return [];
  const sharingFlags = await getSharingFlags(ctx.orgId, env);
  return rows.filter(row => canReadConversationContent(
    {
      source: row.source as any,
      participant_user_ids: row.participant_user_ids as any,
      is_campaign_email: row.is_campaign_email as any,
      slack_is_private: row.slack_is_private,
    },
    ctx.userId,
    ctx.userRole,
    sharingFlags
  ));
}

export async function loadEventVisibilityMap(
  env: Env,
  ctx: ViewerContext,
  eventIds: Array<string | null | undefined>
): Promise<Map<string, SourceVisibility>> {
  const ids = unique(eventIds);
  const out = new Map<string, SourceVisibility>();
  for (const id of ids) out.set(id, { source_id: id, can_read: false, exists: false });
  if (ids.length === 0) return out;

  const [rows, sharingFlags] = await Promise.all([
    env.D1.prepare(
      `SELECT e.id, GROUP_CONCAT(ea.user_id) AS participant_user_ids
         FROM events e
         LEFT JOIN event_attendees ea ON ea.event_id = e.id
        WHERE e.org_id = ? AND e.deleted_at IS NULL AND e.id IN (${placeholders(ids)})
        GROUP BY e.id`
    ).bind(ctx.orgId, ...ids).all<{ id: string; participant_user_ids: string | null }>(),
    getSharingFlags(ctx.orgId, env),
  ]);

  for (const row of rows.results || []) {
    const participants = parseParticipantUserIds(row.participant_user_ids);
    const canRead = hasOrgWidePrivateDataAccess(ctx.userRole) ||
      participants.includes(ctx.userId) ||
      participants.some(pid => sharingFlags[pid]);
    out.set(row.id, { source_id: row.id, can_read: canRead, exists: true });
  }
  return out;
}

export function omitWhenUnreadable<T>(value: T, canRead: boolean): T | undefined {
  return canRead ? value : undefined;
}

const PRIVATE_AUDIT_FIELDS = new Set([
  'source_metadata',
  'custom_fields',
  'notes',
  'body_preview',
  'last_inferred_activity_subject',
  'last_inferred_activity_sender',
  'origin',
  'evidence',
]);

export function sanitizeEmailDerivedSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_AUDIT_FIELDS.has(key)) continue;
    out[key] = v;
  }
  return out;
}

export function changedFieldsFromSanitizedSnapshots(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const beforeObj = before as Record<string, unknown>;
  const afterObj = after as Record<string, unknown>;
  const skip = new Set(['updated_at', 'last_activity_date', 'stage_changed_at', 'days_in_stage']);
  const changed: string[] = [];
  for (const key of Object.keys(afterObj)) {
    if (skip.has(key) || PRIVATE_AUDIT_FIELDS.has(key)) continue;
    if (JSON.stringify(beforeObj[key]) !== JSON.stringify(afterObj[key])) changed.push(key);
  }
  return changed;
}

export async function readableConversationFingerprint(
  env: Env,
  ctx: ViewerContext,
  conversations: ConversationAclRow[]
): Promise<string> {
  const readable = await filterReadableConversationRows(env, ctx, conversations);
  const ids = readable.map(r => r.id).sort();
  const payload = JSON.stringify({
    user_id: ctx.userId,
    user_role: ctx.userRole,
    ids,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

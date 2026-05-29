import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { hasOrgWidePrivateDataAccess, parseParticipantUserIds } from './helpers';

type ViewerContext = Pick<AuthContext, 'orgId' | 'userId' | 'userRole'>;

export function conversationParticipantAclSql(
  conversationAlias: string,
  ctx: ViewerContext,
  sharingFlags: Record<string, boolean>,
  suffix = 'acl'
): { sql: string; binds: string[] } {
  if (hasOrgWidePrivateDataAccess(ctx.userRole)) return { sql: '1 = 1', binds: [] };
  const readableUserIds = [ctx.userId, ...Object.keys(sharingFlags).filter(id => sharingFlags[id])];
  if (readableUserIds.length === 0) return { sql: '0 = 1', binds: [] };
  const placeholders = readableUserIds.map(() => '?').join(',');
  return {
    sql: `EXISTS (
      SELECT 1
        FROM conversation_participants cp_${suffix}
       WHERE cp_${suffix}.org_id = ${conversationAlias}.org_id
         AND cp_${suffix}.conversation_id = ${conversationAlias}.id
         AND cp_${suffix}.user_id IN (${placeholders})
    )`,
    binds: readableUserIds,
  };
}

export async function syncConversationParticipants(
  env: Env,
  orgId: string,
  conversationId: string,
  participantUserIds: string | string[] | null | undefined
): Promise<void> {
  const participants = parseParticipantUserIds(participantUserIds as any);
  await env.D1.prepare(
    'DELETE FROM conversation_participants WHERE org_id = ? AND conversation_id = ?'
  ).bind(orgId, conversationId).run();
  for (const userId of participants) {
    await env.D1.prepare(
      `INSERT OR IGNORE INTO conversation_participants
        (org_id, conversation_id, user_id, source, created_at)
       VALUES (?, ?, ?, 'participant_user_ids', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, conversationId, userId).run();
  }
}

export async function syncConversationParticipantsForRows(
  env: Env,
  rows: Array<{ org_id?: string | null; id?: string | null; conversation_id?: string | null; participant_user_ids?: string | string[] | null }>
): Promise<void> {
  for (const row of rows) {
    const orgId = row.org_id;
    const conversationId = row.id || row.conversation_id;
    if (!orgId || !conversationId) continue;
    await syncConversationParticipants(env, orgId, conversationId, row.participant_user_ids);
  }
}

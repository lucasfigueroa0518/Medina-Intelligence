// TRD §18.4 + §18.7 — Shared helpers
import type { Env } from '../types/env';
import type { OrgSettings, User, Conversation } from '../types/interfaces';
import { decryptToken } from './encryption';

// --- §18.4: array / hash / html ---

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export function hashShort(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).substring(0, 12);
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- §18.7: OrgSettings ---

const DEFAULT_ORG_SETTINGS: OrgSettings = {
  auto_approve_sync: false,
  sync_interval_minutes: 20,
  linkedin_enrichment_enabled: true,
  news_feed_enabled: true,
  max_enrichments_per_cycle: 50,
  outlook_backfill_days: 180,
  reranker_enabled: true,
};

export async function getOrgSettings(orgId: string, env: Env): Promise<OrgSettings> {
  const row = await env.D1.prepare(
    'SELECT settings FROM organizations WHERE id = ?'
  ).bind(orgId).first<{ settings: string }>();

  if (!row?.settings) return { ...DEFAULT_ORG_SETTINGS };

  try {
    const parsed = JSON.parse(row.settings);
    return { ...DEFAULT_ORG_SETTINGS, ...parsed };
  } catch {
    console.error(`Failed to parse org settings for ${orgId}, using defaults`);
    return { ...DEFAULT_ORG_SETTINGS };
  }
}

// --- §18.7: Active Users ---

export async function getActiveUsersForOrg(orgId: string, env: Env): Promise<User[]> {
  const result = await env.D1.prepare(
    'SELECT id, org_id, email, full_name, role, outlook_token, outlook_delta_token, slack_token, is_active, created_at, updated_at FROM users WHERE org_id = ? AND is_active = 1 AND deleted_at IS NULL'
  ).bind(orgId).all<User>();
  return result.results;
}

// --- §18.7: Org Domains ---

export async function getOrgDomains(orgId: string, env: Env): Promise<string[]> {
  const org = await env.D1.prepare(
    'SELECT domain FROM organizations WHERE id = ?'
  ).bind(orgId).first<{ domain: string }>();

  if (!org?.domain) return [];
  return [org.domain];
}

// --- §18.7: Sync Job ID ---

export async function getCurrentSyncJobId(
  orgId: string,
  workflowType: string,
  env: Env
): Promise<string> {
  const row = await env.D1.prepare(
    'SELECT id FROM sync_jobs WHERE org_id = ? AND workflow_type = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(orgId, workflowType, 'running').first<{ id: string }>();

  if (!row?.id) {
    const hour = new Date().toISOString().slice(0, 13);
    return `fallback_${orgId}_${workflowType}_${hour}`;
  }
  return row.id;
}

// --- §18.7: decrypted token accessors ---

export async function getDecryptedAccessToken(userId: string, env: Env): Promise<string> {
  const user = await env.D1.prepare(
    'SELECT outlook_token FROM users WHERE id = ?'
  ).bind(userId).first<{ outlook_token: string | null }>();

  if (!user?.outlook_token) {
    throw new Error(`No Outlook token for user ${userId}`);
  }
  const tokens = await decryptToken(user.outlook_token, env);
  return tokens.access_token;
}

export async function getDecryptedSlackBotToken(orgId: string, env: Env): Promise<string> {
  const user = await env.D1.prepare(
    'SELECT slack_token FROM users WHERE org_id = ? AND slack_token IS NOT NULL AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId).first<{ slack_token: string | null }>();

  if (!user?.slack_token) {
    // Fall back to the global bot token (initial install)
    if (env.SLACK_BOT_TOKEN) return env.SLACK_BOT_TOKEN;
    throw new Error(`No Slack token for org ${orgId}`);
  }
  const tokens = await decryptToken(user.slack_token, env);
  return tokens.access_token;
}

// --- §3.12: email content access check ---

export function canReadEmailContent(
  conversation: Pick<Conversation, 'source' | 'participant_user_ids' | 'is_campaign_email'>,
  requestingUserId: string,
  userRole: string
): boolean {
  if (conversation.source === 'slack') return true;
  if ((conversation as any).is_campaign_email) return true;
  if (userRole === 'owner') return true;

  try {
    const participants: string[] = JSON.parse(conversation.participant_user_ids || '[]');
    return participants.includes(requestingUserId);
  } catch {
    return false;
  }
}

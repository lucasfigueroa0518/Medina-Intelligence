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

// Strip quoted reply chains from email body text. Outlook replies include
// the entire prior thread quoted below the new content ("On Mar 5, Patrick
// wrote:..."), which makes a 5-message thread embed 5× the same content
// across thread members. Run AFTER stripHtml so the patterns below match
// against plaintext.
//
// Patterns covered (any one truncates the body at its first occurrence):
//   • "On <date>, <person> wrote:" (Gmail/most clients)
//   • "On <date> at <time>, <person> wrote:" (alternate Gmail)
//   • "From: ... Sent: ..." block (Outlook forwarded format)
//   • "----- Original Message -----" (older Outlook)
//   • "________" horizontal-rule + "From:" (Outlook web)
// Plus a final pass to drop any residual "> " / ">> " line prefixes.
export function stripQuotedReplies(text: string): string {
  if (!text) return '';
  const replyMarkers: RegExp[] = [
    /\n+On .+, .+ wrote:/i,
    /\n+On .+ at .+, .+ wrote:/i,
    /\n+From: .+\nSent: /i,
    /\n+-{3,}\s*Original Message\s*-{3,}/i,
    /\n+_{3,}\s*\n+From: /i,
  ];
  let stripped = text;
  for (const marker of replyMarkers) {
    const match = stripped.match(marker);
    if (match && match.index !== undefined) {
      stripped = stripped.substring(0, match.index);
    }
  }
  stripped = stripped
    .split('\n')
    .filter(line => !/^\s*>+\s/.test(line))
    .join('\n');
  return stripped.trim();
}

// Retry env.KV.put on transient failures (429, 5xx, network blips). Pure
// retry wrapper — no rate limiting. Used by chunkEmbedAndPersist where bursty
// chunk-text writes (15 chunks × 1 KV.put each, in rapid succession) can
// outpace KV's per-namespace write rate. Attempts: 3, backoff 100ms→400ms
// with proportional jitter.
export async function kvPutWithRetry(
  env: Env,
  key: string,
  value: string,
  options?: KVNamespacePutOptions,
  maxAttempts: number = 3
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await env.KV.put(key, value, options);
      return;
    } catch (e) {
      lastErr = e;
      if (i === maxAttempts - 1) break;
      const base = 100 * Math.pow(2, i);
      const delay = base + (Math.random() - 0.5) * base;
      await new Promise(resolve => setTimeout(resolve, Math.max(50, delay)));
    }
  }
  throw lastErr;
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

// `participant_user_ids` is stored in TWO places with TWO formats:
//   • D1 conversations.participant_user_ids → JSON-stringified array '["a","b"]'
//   • Vector metadata participant_user_ids  → comma-joined string 'a,b'
// Defensive parser handles both so a reader can't silently break if it's
// pointed at the wrong source. Returns [] for null/undefined/parse errors.
export function parseParticipantUserIds(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(s => typeof s === 'string' && s.length > 0);
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string' && s.length > 0) : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

export function canReadEmailContent(
  conversation: Pick<Conversation, 'source' | 'participant_user_ids' | 'is_campaign_email'>,
  requestingUserId: string,
  userRole: string,
  participantSharingFlags?: Record<string, boolean>
): boolean {
  if (conversation.source === 'slack') return true;
  if ((conversation as any).is_campaign_email) return true;
  if (userRole === 'owner') return true;

  const participants = parseParticipantUserIds(conversation.participant_user_ids);
  if (participants.length === 0) return false;
  if (participants.includes(requestingUserId)) return true;
  if (participantSharingFlags && participants.some(pid => participantSharingFlags[pid])) return true;
  return false;
}

export async function getSharingFlags(orgId: string, env: Env): Promise<Record<string, boolean>> {
  const rows = await env.D1.prepare(
    'SELECT id FROM users WHERE org_id = ? AND share_emails_org_wide = 1 AND deleted_at IS NULL'
  ).bind(orgId).all<{ id: string }>();
  const flags: Record<string, boolean> = {};
  for (const r of rows.results) flags[r.id] = true;
  return flags;
}

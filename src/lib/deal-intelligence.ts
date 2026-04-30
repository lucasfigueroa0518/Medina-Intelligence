// deal_intelligence — per-(deal, user) computed-cached intelligence
// (sentiment, topics, risk signals, momentum) derived from the deal's
// conversation set, ACL-filtered to what the user can read.
//
// ARCHITECTURAL DELINEATION (locked per issue #4 v1.0 contract):
// This is computed-cached state, NOT corroboration-gated entity-field
// state. Direct UPSERT on each recompute. Latest computed values
// REPLACE prior values entirely. Does NOT route through Wave 6's
// evaluateProposal — different shape, different problem.
//
// Lifecycle:
//   • Cold-path read → synchronous compute (one-time cost on first
//     access for a given (deal, user) pair).
//   • Subsequent reads → serve from cache, marked is_stale when
//     computed_at < now-1h OR invalidated_at IS NOT NULL.
//   • Stale read → return cached row + queue async recompute (don't
//     block user-visible read).
//   • Hourly batch sweep refreshes stale-or-invalidated rows oldest-
//     first, capped per cron tick to stay inside Worker subrequest
//     budget.
//   • Event-driven invalidation: when a new conversation lands tied
//     to any contact in deal_contacts, mark invalidated_at on every
//     (deal_id, user_id) pair where the user can read the new
//     conversation per canReadEmailContent.

import type { Env } from '../types/env';
import { callClaude } from './claude';
import { canReadEmailContent, getSharingFlags, parseParticipantUserIds } from './helpers';

// Tunables. Stored as constants so behavior is auditable.
export const STALENESS_WINDOW_MS = 60 * 60 * 1000;            // 1h per locked freshness contract
const MAX_CONVERSATIONS_FOR_PROMPT = 30;                       // recent-first; older fall back to summarization
const MAX_BODY_PREVIEW_CHARS = 1500;                           // per-conversation cap; assembles to ~30 × 1500 ≈ 45kB ≤ ~10k tokens
const COMPUTE_MODEL = 'claude-haiku-4-5-20251001';             // locked: Haiku 4.5, NOT Sonnet/Opus
const HOURLY_BATCH_LIMIT = 50;                                  // rows refreshed per hourly cron tick

export type Sentiment = 'positive' | 'neutral' | 'negative' | null;
export type Momentum = 'accelerating' | 'steady' | 'stalled' | 'declining' | null;
export type RiskSeverity = 'info' | 'warning' | 'critical';

export interface RiskSignal {
  type: string;
  severity: RiskSeverity;
  detail: string;
}

export interface DealIntelligence {
  deal_id: string;
  user_id: string;
  sentiment: Sentiment;
  sentiment_score: number | null;
  topics: string[];
  risk_signals: RiskSignal[];
  momentum: Momentum;
  momentum_score: number | null;
  conversation_count: number;
  computed_at: string;
  is_stale: boolean;
}

interface RawRow {
  deal_id: string;
  user_id: string;
  sentiment: string | null;
  sentiment_score: number | null;
  topics: string;
  risk_signals: string;
  momentum: string | null;
  momentum_score: number | null;
  conversation_count: number;
  computed_at: string;
  invalidated_at: string | null;
}

/**
 * Convert a stored row into the API-shaped intelligence record. Parses
 * JSON columns and computes is_stale per the freshness contract.
 */
function shapeRow(row: RawRow): DealIntelligence {
  const topics = parseStringArray(row.topics);
  const risks = parseRiskArray(row.risk_signals);
  const computedTs = Date.parse(row.computed_at);
  const stale =
    !Number.isFinite(computedTs) ||
    Date.now() - computedTs >= STALENESS_WINDOW_MS ||
    row.invalidated_at !== null;
  return {
    deal_id: row.deal_id,
    user_id: row.user_id,
    sentiment: (row.sentiment as Sentiment) ?? null,
    sentiment_score: row.sentiment_score,
    topics,
    risk_signals: risks,
    momentum: (row.momentum as Momentum) ?? null,
    momentum_score: row.momentum_score,
    conversation_count: row.conversation_count,
    computed_at: row.computed_at,
    is_stale: stale,
  };
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}

function parseRiskArray(json: string): RiskSignal[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r: any) => r && typeof r === 'object' && typeof r.type === 'string' && typeof r.detail === 'string')
      .map((r: any) => ({
        type: String(r.type),
        severity: (['info', 'warning', 'critical'].includes(r.severity) ? r.severity : 'info') as RiskSeverity,
        detail: String(r.detail),
      }));
  } catch { return []; }
}

// ───────────────────────── ACL-filtered conversation fetch ─────────────────────────

interface ConversationRow {
  id: string;
  source: 'outlook' | 'slack' | 'manual';
  participant_user_ids: string;
  is_campaign_email: number;
  subject: string | null;
  body_preview: string | null;
  from_email: string | null;
  sent_at: string;
  direction: string | null;
}

/**
 * Pull the deal's conversation set. Phase B introduced direct links via
 * conversation_deals (and event_deals via fetchDealEvents); we prefer those
 * when present and fall back to the two-hop contact-overlap join from
 * PR #24's propagateContactToOpenDeals as a fallback evidence source.
 *
 * Why both paths: direct links are precise but incomplete during the
 * transition window — most existing deals have zero direct rows yet, only
 * contact-overlap. The UNION DISTINCT collapses dupes when a conversation
 * is reachable via both paths. Bounded by MAX_CONVERSATIONS_FOR_PROMPT so
 * a heavily-linked deal doesn't blow the prompt budget.
 *
 * conversations has no deleted_at column — every linked row is valid.
 * (Other entity tables soft-delete; conversations hard-delete via cleanup.)
 */
async function fetchDealConversations(
  dealId: string,
  orgId: string,
  env: Env
): Promise<ConversationRow[]> {
  const rows = await env.D1.prepare(
    `SELECT id, source, participant_user_ids, is_campaign_email, subject,
            body_preview, from_email, sent_at, direction
       FROM (
         -- Direct links (Phase B+). source='manual' / 'auto_high' /
         -- 'inherited_channel' / 'llm_classification' / etc.
         SELECT conv.id, conv.source, conv.participant_user_ids,
                conv.is_campaign_email, conv.subject, conv.body_preview,
                conv.from_email, conv.sent_at, conv.direction
           FROM conversation_deals cd
           JOIN conversations conv ON cd.conversation_id = conv.id
          WHERE cd.deal_id = ? AND conv.org_id = ?
         UNION
         -- Fallback: contact-overlap two-hop join via PR #24's
         -- propagateContactToOpenDeals. Stays as evidence source for
         -- deals that pre-date the direct-link era.
         SELECT conv.id, conv.source, conv.participant_user_ids,
                conv.is_campaign_email, conv.subject, conv.body_preview,
                conv.from_email, conv.sent_at, conv.direction
           FROM deal_contacts dc
           JOIN conversation_contacts cc ON dc.contact_id = cc.contact_id
           JOIN conversations conv       ON cc.conversation_id = conv.id
          WHERE dc.deal_id = ? AND dc.org_id = ? AND conv.org_id = ?
       )
      ORDER BY sent_at DESC
      LIMIT ?`
  ).bind(dealId, orgId, dealId, orgId, orgId, MAX_CONVERSATIONS_FOR_PROMPT)
   .all<ConversationRow>();
  return rows.results;
}

interface UserContext {
  userId: string;
  userRole: string;
  sharingFlags: Record<string, boolean>;
}

function filterConversationsByAcl(
  conversations: ConversationRow[],
  ctx: UserContext
): ConversationRow[] {
  return conversations.filter(c =>
    canReadEmailContent(
      {
        source: c.source,
        participant_user_ids: c.participant_user_ids,
        is_campaign_email: c.is_campaign_email as 0 | 1,
      },
      ctx.userId,
      ctx.userRole,
      ctx.sharingFlags
    )
  );
}

// ───────────────────────── Claude prompt + parse ─────────────────────────

const SYSTEM_PROMPT = `You analyze venture-capital deal flow conversations and produce structured intelligence about deal health.

You MUST return valid JSON matching this exact shape:
{
  "sentiment": "positive" | "neutral" | "negative" | null,
  "sentiment_score": number between -1.0 and 1.0 | null,
  "topics": string[] (deal-relevant nouns, max 8, e.g. "term sheet revision", "valuation discussion", "due diligence", NOT generic like "meeting" or "email"),
  "risk_signals": Array<{type: string, severity: "info"|"warning"|"critical", detail: string}> (max 6, each MUST cite specific evidence: "contact X has not responded in 14 days", NOT "communication issues"),
  "momentum": "accelerating" | "steady" | "stalled" | "declining" | null,
  "momentum_score": number between -1.0 and 1.0 | null
}

Rules:
- Use null when there is insufficient signal (e.g. only 1 short conversation).
- Topics must be deal-flow specific (legal, financial, diligence, scheduling for a closing milestone, etc.). Avoid generic conversation labels.
- Risk signals must cite concrete evidence from the conversation timeline. Quote partial dates, names, or quoted phrases from the messages.
- Momentum considers: message frequency trend, sentiment trajectory, decision-maker engagement (are senior contacts replying?). "accelerating" = increasing frequency + positive sentiment + decision-maker active. "stalled" = declining frequency for 14+ days. "declining" = active negative sentiment or explicit rejection language.

Return JSON ONLY. No prose, no markdown fences.`;

interface ClaudeIntelligence {
  sentiment: Sentiment;
  sentiment_score: number | null;
  topics: string[];
  risk_signals: RiskSignal[];
  momentum: Momentum;
  momentum_score: number | null;
}

function parseClaudeIntelligence(raw: string): ClaudeIntelligence | null {
  try {
    const cleaned = raw.trim().replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    const sentiment = ['positive', 'neutral', 'negative'].includes(parsed.sentiment) ? parsed.sentiment : null;
    const momentum = ['accelerating', 'steady', 'stalled', 'declining'].includes(parsed.momentum) ? parsed.momentum : null;
    return {
      sentiment: sentiment as Sentiment,
      sentiment_score: typeof parsed.sentiment_score === 'number' ? parsed.sentiment_score : null,
      topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t: unknown) => typeof t === 'string').slice(0, 8) : [],
      risk_signals: Array.isArray(parsed.risk_signals)
        ? parsed.risk_signals
            .filter((r: any) => r && typeof r.type === 'string' && typeof r.detail === 'string')
            .map((r: any) => ({
              type: String(r.type).slice(0, 60),
              severity: (['info', 'warning', 'critical'].includes(r.severity) ? r.severity : 'info') as RiskSeverity,
              detail: String(r.detail).slice(0, 280),
            }))
            .slice(0, 6)
        : [],
      momentum: momentum as Momentum,
      momentum_score: typeof parsed.momentum_score === 'number' ? parsed.momentum_score : null,
    };
  } catch { return null; }
}

interface DealMeta {
  id: string;
  org_id: string;
  title: string | null;
  stage: string | null;
  amount: number | null;
  contact_names: string[];
}

async function buildDealMeta(dealId: string, orgId: string, env: Env): Promise<DealMeta | null> {
  const deal = await env.D1.prepare(
    `SELECT id, org_id, title, stage, amount FROM deals
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(dealId, orgId).first<{
    id: string; org_id: string; title: string | null;
    stage: string | null; amount: number | null;
  }>();
  if (!deal) return null;

  const contacts = await env.D1.prepare(
    `SELECT c.full_name FROM deal_contacts dc
       JOIN contacts c ON c.id = dc.contact_id
      WHERE dc.deal_id = ? AND c.deleted_at IS NULL`
  ).bind(dealId).all<{ full_name: string | null }>();

  return {
    ...deal,
    contact_names: contacts.results.map(r => r.full_name).filter((n): n is string => !!n),
  };
}

/**
 * Build the user-message payload from the deal context + ACL-filtered
 * conversation excerpts. Most-recent-first; capped per-message and
 * total to fit within Haiku 4.5's input-cost discipline.
 */
function buildUserPrompt(meta: DealMeta, conversations: ConversationRow[]): string {
  const head: string[] = [];
  head.push(`DEAL: ${meta.title || meta.id}`);
  if (meta.stage) head.push(`STAGE: ${meta.stage}`);
  if (typeof meta.amount === 'number') head.push(`AMOUNT: $${meta.amount}`);
  if (meta.contact_names.length) head.push(`CONTACTS: ${meta.contact_names.slice(0, 8).join(', ')}`);

  const messages: string[] = [];
  for (const c of conversations) {
    const subject = (c.subject || '(no subject)').slice(0, 120);
    const date = c.sent_at.slice(0, 10);
    const sender = c.from_email || '(unknown)';
    const direction = c.direction || 'unknown';
    const body = (c.body_preview || '').slice(0, MAX_BODY_PREVIEW_CHARS);
    messages.push(
      `--- ${date} | ${direction} | ${subject}\nFrom: ${sender}\n${body}`
    );
  }

  return `${head.join('\n')}\n\nCONVERSATIONS (${conversations.length}, most recent first):\n\n${messages.join('\n\n')}\n\nReturn intelligence JSON.`;
}

// ───────────────────────── compute + UPSERT ─────────────────────────

interface ComputeResult {
  intelligence: DealIntelligence;
  reason: 'no_readable_conversations' | 'computed' | 'compute_failed_returned_null';
}

/**
 * Synchronously compute intelligence for (deal_id, user_id) and UPSERT
 * the result. Returns the shaped row.
 *
 * If the user can read 0 conversations (because the deal's conversation
 * set is entirely outside their ACL), writes a minimal "no signal" row
 * and returns it — so subsequent reads are instant cache hits and we
 * don't repeatedly burn LLM budget on impossible computations.
 */
export async function computeDealIntelligence(
  dealId: string,
  userId: string,
  userRole: string,
  orgId: string,
  env: Env
): Promise<ComputeResult> {
  const meta = await buildDealMeta(dealId, orgId, env);
  if (!meta) {
    throw new Error(`deal_intelligence: deal not found or wrong org (${dealId} / ${orgId})`);
  }

  const sharingFlags = await getSharingFlags(orgId, env);
  const allConvs = await fetchDealConversations(dealId, orgId, env);
  const readable = filterConversationsByAcl(allConvs, { userId, userRole, sharingFlags });

  if (readable.length === 0) {
    await upsertIntelligence({
      dealId, userId,
      sentiment: null, sentiment_score: null,
      topics: [], risk_signals: [],
      momentum: null, momentum_score: null,
      conversation_count: 0,
    }, env);
    return { reason: 'no_readable_conversations', intelligence: shapeRow(await readRow(dealId, userId, env)) };
  }

  const userPrompt = buildUserPrompt(meta, readable);

  let raw: string;
  try {
    raw = await callClaude(
      { system: SYSTEM_PROMPT, user: userPrompt, max_tokens: 800, orgId, model: COMPUTE_MODEL },
      'low',
      env
    );
  } catch (e) {
    console.error(`[deal-intelligence] claude call failed for ${dealId}/${userId}:`, e);
    // Persist a stub row so the cold-path read returns something and the
    // hourly batch will retry. Keeps the user out of perpetual cold-start
    // recompute on a transient Claude outage.
    await upsertIntelligence({
      dealId, userId,
      sentiment: null, sentiment_score: null,
      topics: [], risk_signals: [],
      momentum: null, momentum_score: null,
      conversation_count: readable.length,
    }, env);
    return { reason: 'compute_failed_returned_null', intelligence: shapeRow(await readRow(dealId, userId, env)) };
  }

  const parsed = parseClaudeIntelligence(raw);
  if (!parsed) {
    console.warn(`[deal-intelligence] claude returned unparseable output for ${dealId}/${userId}`);
    await upsertIntelligence({
      dealId, userId,
      sentiment: null, sentiment_score: null,
      topics: [], risk_signals: [],
      momentum: null, momentum_score: null,
      conversation_count: readable.length,
    }, env);
    return { reason: 'compute_failed_returned_null', intelligence: shapeRow(await readRow(dealId, userId, env)) };
  }

  await upsertIntelligence({
    dealId, userId,
    sentiment: parsed.sentiment, sentiment_score: parsed.sentiment_score,
    topics: parsed.topics, risk_signals: parsed.risk_signals,
    momentum: parsed.momentum, momentum_score: parsed.momentum_score,
    conversation_count: readable.length,
  }, env);

  return { reason: 'computed', intelligence: shapeRow(await readRow(dealId, userId, env)) };
}

interface UpsertInput {
  dealId: string;
  userId: string;
  sentiment: Sentiment;
  sentiment_score: number | null;
  topics: string[];
  risk_signals: RiskSignal[];
  momentum: Momentum;
  momentum_score: number | null;
  conversation_count: number;
}

async function upsertIntelligence(input: UpsertInput, env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO deal_intelligence
       (deal_id, user_id, sentiment, sentiment_score, topics, risk_signals,
        momentum, momentum_score, conversation_count, computed_at, invalidated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(deal_id, user_id) DO UPDATE SET
       sentiment = excluded.sentiment,
       sentiment_score = excluded.sentiment_score,
       topics = excluded.topics,
       risk_signals = excluded.risk_signals,
       momentum = excluded.momentum,
       momentum_score = excluded.momentum_score,
       conversation_count = excluded.conversation_count,
       computed_at = excluded.computed_at,
       invalidated_at = NULL`
  ).bind(
    input.dealId, input.userId,
    input.sentiment, input.sentiment_score,
    JSON.stringify(input.topics),
    JSON.stringify(input.risk_signals),
    input.momentum, input.momentum_score,
    input.conversation_count, now
  ).run();
}

async function readRow(dealId: string, userId: string, env: Env): Promise<RawRow> {
  const row = await env.D1.prepare(
    `SELECT deal_id, user_id, sentiment, sentiment_score, topics, risk_signals,
            momentum, momentum_score, conversation_count, computed_at, invalidated_at
       FROM deal_intelligence
       WHERE deal_id = ? AND user_id = ?`
  ).bind(dealId, userId).first<RawRow>();
  if (!row) {
    throw new Error(`deal_intelligence: row missing after UPSERT (${dealId}/${userId})`);
  }
  return row;
}

/**
 * Read-side helper used by the API handler. Returns null when no row
 * exists (caller decides whether to compute synchronously).
 */
export async function readDealIntelligence(
  dealId: string,
  userId: string,
  env: Env
): Promise<DealIntelligence | null> {
  const row = await env.D1.prepare(
    `SELECT deal_id, user_id, sentiment, sentiment_score, topics, risk_signals,
            momentum, momentum_score, conversation_count, computed_at, invalidated_at
       FROM deal_intelligence
       WHERE deal_id = ? AND user_id = ?`
  ).bind(dealId, userId).first<RawRow>();
  return row ? shapeRow(row) : null;
}

// ───────────────────────── invalidation ─────────────────────────

/**
 * Event-driven invalidation. Called from stage-approvals.ts after a
 * conversation gets linked to its contact set. For each (deal_id,
 * user_id) pair where the user can read this conversation per ACL,
 * stamps invalidated_at so the next batch tick (or read) recomputes.
 *
 * NOT a broadcast — only readable users are invalidated, per locked
 * spec. Users who can't read the new conversation see no change, so
 * their cached intelligence stays valid (the new conversation
 * wouldn't have contributed to their ACL-filtered compute anyway).
 */
export async function invalidateForConversation(
  conversationContactIds: string[],
  conversationParticipantUserIds: string,
  conversationSource: 'outlook' | 'slack' | 'manual',
  isCampaignEmail: boolean,
  orgId: string,
  env: Env
): Promise<{ invalidated: number }> {
  if (conversationContactIds.length === 0) return { invalidated: 0 };

  // Find affected deals via deal_contacts. Limit prevents pathological
  // contact-fan-out from blowing up the UPDATE size.
  const placeholders = conversationContactIds.map(() => '?').join(',');
  const dealRows = await env.D1.prepare(
    `SELECT DISTINCT deal_id FROM deal_contacts
       WHERE org_id = ? AND contact_id IN (${placeholders})
       LIMIT 500`
  ).bind(orgId, ...conversationContactIds).all<{ deal_id: string }>();

  if (dealRows.results.length === 0) return { invalidated: 0 };
  const dealIds = dealRows.results.map(r => r.deal_id);

  // Find users with existing deal_intelligence rows for those deals.
  // Per-user filtering happens here so we don't broadcast.
  const dealIdPh = dealIds.map(() => '?').join(',');
  const userRows = await env.D1.prepare(
    `SELECT DISTINCT di.user_id, u.role
       FROM deal_intelligence di
       JOIN users u ON u.id = di.user_id
      WHERE di.deal_id IN (${dealIdPh})
        AND u.org_id = ? AND u.deleted_at IS NULL`
  ).bind(...dealIds, orgId).all<{ user_id: string; role: string }>();

  if (userRows.results.length === 0) return { invalidated: 0 };

  const sharingFlags = await getSharingFlags(orgId, env);
  const readableUserIds: string[] = [];
  for (const u of userRows.results) {
    const ok = canReadEmailContent(
      {
        source: conversationSource,
        participant_user_ids: conversationParticipantUserIds,
        is_campaign_email: (isCampaignEmail ? 1 : 0) as 0 | 1,
      },
      u.user_id,
      u.role,
      sharingFlags
    );
    if (ok) readableUserIds.push(u.user_id);
  }
  if (readableUserIds.length === 0) return { invalidated: 0 };

  // Single bulk UPDATE.
  const userPh = readableUserIds.map(() => '?').join(',');
  const result = await env.D1.prepare(
    `UPDATE deal_intelligence
        SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE deal_id IN (${dealIdPh})
        AND user_id IN (${userPh})`
  ).bind(...dealIds, ...readableUserIds).run();

  // Reference unused parseParticipantUserIds for parseable input check
  // — keeping the import live for future code paths that need it.
  void parseParticipantUserIds;

  return { invalidated: result.meta.changes ?? 0 };
}

// ───────────────────────── batch refresh (hourly cron) ─────────────────────────

/**
 * Hourly batch sweep — recompute the oldest stale-or-invalidated rows.
 * Bounded by HOURLY_BATCH_LIMIT to stay within Worker subrequest
 * budget. Each row triggers one Claude call + a few D1 calls.
 *
 * Selection order: invalidated rows first (event-driven freshness),
 * then oldest computed_at rows (1h staleness floor).
 */
export async function refreshStaleIntelligence(orgId: string, env: Env): Promise<{ refreshed: number }> {
  // Find candidate (deal, user) pairs. Need user role for the per-user
  // recompute call. Filter on:
  //   • invalidated_at IS NOT NULL (event-driven priority), OR
  //   • computed_at older than 1h
  const candidates = await env.D1.prepare(
    `SELECT di.deal_id, di.user_id, u.role
       FROM deal_intelligence di
       JOIN users u ON u.id = di.user_id
       JOIN deals d ON d.id = di.deal_id
      WHERE u.org_id = ? AND u.deleted_at IS NULL
        AND d.org_id = ? AND d.deleted_at IS NULL
        AND (di.invalidated_at IS NOT NULL
             OR di.computed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-60 minutes'))
      ORDER BY (di.invalidated_at IS NOT NULL) DESC,
               di.computed_at ASC
      LIMIT ?`
  ).bind(orgId, orgId, HOURLY_BATCH_LIMIT).all<{
    deal_id: string; user_id: string; role: string;
  }>();

  let refreshed = 0;
  for (const c of candidates.results) {
    try {
      await computeDealIntelligence(c.deal_id, c.user_id, c.role, orgId, env);
      refreshed++;
    } catch (e) {
      console.error(`[deal-intelligence] hourly refresh failed for ${c.deal_id}/${c.user_id}:`, e);
    }
  }
  return { refreshed };
}

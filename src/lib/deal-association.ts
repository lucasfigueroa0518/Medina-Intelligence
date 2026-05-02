// Deal ↔ Contact association — auto-population of deal_contacts.
//
// Day-5 hotfix scope: deal_intelligence compute traverses
// deal_contacts → conversation_contacts → conversations and produces empty
// signal for every deal because deal_contacts had no auto-population path
// (only manual addDealContact). This module fills that gap.
//
// Three linkage signals — all evidence-based, no hallucination:
//
//   1. Company match: contact.company_id == deal.company_id
//      Strongest passive signal; safe to auto-insert because the contact
//      has already been resolved to that company through prior ingestion
//      (which itself uses email domain matching + LLM classification).
//
//   2. Source-conversation participants: when a `create_deal` proposal is
//      approved, the proposal's source_communication_id is the email that
//      triggered detection. Linking that conversation's participants to
//      the new deal is direct evidence — the sender literally pitched it.
//
//   3. Conversation-contact ingestion hook: when a NEW conversation_contacts
//      row is inserted (via stage-approvals.ts) AND that contact's
//      company_id matches an open deal's company_id, propagate to
//      deal_contacts. Idempotent (UNIQUE(deal_id, contact_id) drops dupes).
//
// All inserts use INSERT OR IGNORE — replays + concurrent runs collapse
// to no-ops. Default side='theirs', role='other' (UI lets users
// re-classify manually).
//
// ACL note: deal_contacts is NOT user-scoped (it's an org-wide
// many-to-many on contacts). The downstream deal_intelligence compute is
// what applies per-user canReadEmailContent against the conversation set
// reached via this junction. So linking a contact to a deal here doesn't
// create a leak — it just reveals that "this contact has an email
// relationship with this deal's company"; the contents of any specific
// conversation between that contact and a user remain gated.

import type { Env } from '../types/env';
import { resolveInternalDomains, classifyContactSideSync } from './internal-entity';

/** Insert deal_contacts rows for every contact whose company_id matches the
 *  given deal's company_id. Idempotent. Returns the count of newly-linked
 *  rows (for logging / dry-run reporting). */
export async function linkContactsByCompanyMatch(
  dealId: string,
  orgId: string,
  env: Env
): Promise<{ linked: number; matched_contact_count: number }> {
  // Fetch the deal's company_id first; bail if no deal or no company.
  const deal = await env.D1.prepare(
    `SELECT company_id FROM deals WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(dealId, orgId).first<{ company_id: string | null }>();
  if (!deal?.company_id) return { linked: 0, matched_contact_count: 0 };

  // Find all contacts at the company. Wave 5: pull email so we can
  // classify side per the new domain-based rule.
  const contacts = await env.D1.prepare(
    `SELECT id, email, company_id FROM contacts
       WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL`
  ).bind(orgId, deal.company_id).all<{ id: string; email: string | null; company_id: string | null }>();
  if (contacts.results.length === 0) return { linked: 0, matched_contact_count: 0 };

  const internalDomains = await resolveInternalDomains(orgId, env);
  const stmts = contacts.results.map(c => {
    const side = classifyContactSideSync(c.email, c.company_id, deal.company_id, internalDomains);
    return env.D1.prepare(
      `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'other', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, dealId, c.id, side);
  });
  const results = await env.D1.batch(stmts);
  const linked = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return { linked, matched_contact_count: contacts.results.length };
}

/** Link every participant of the given conversation to the given deal.
 *  Used by the create_deal commit path: the source email's participants
 *  are the strongest evidence of who's involved in this deal. Idempotent.
 *  Returns count newly-linked. */
export async function linkConversationParticipantsToDeal(
  dealId: string,
  conversationId: string,
  orgId: string,
  env: Env
): Promise<{ linked: number; participant_count: number }> {
  // Wave 5: pull email + company_id alongside id so side classification
  // uses the new domain-based rule.
  const participants = await env.D1.prepare(
    `SELECT DISTINCT c.id AS contact_id, c.email, c.company_id
       FROM conversation_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.conversation_id = ?
        AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(conversationId, orgId).all<{ contact_id: string; email: string | null; company_id: string | null }>();
  if (participants.results.length === 0) return { linked: 0, participant_count: 0 };

  const deal = await env.D1.prepare(
    `SELECT company_id FROM deals WHERE id = ? AND org_id = ?`
  ).bind(dealId, orgId).first<{ company_id: string | null }>();
  const dealCompanyId = deal?.company_id ?? null;

  const internalDomains = await resolveInternalDomains(orgId, env);
  const stmts = participants.results.map(p => {
    const side = classifyContactSideSync(p.email, p.company_id, dealCompanyId, internalDomains);
    return env.D1.prepare(
      `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'other', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, dealId, p.contact_id, side);
  });
  const results = await env.D1.batch(stmts);
  const linked = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return { linked, participant_count: participants.results.length };
}

/** Propagate: when a new conversation_contacts row was inserted for a
 *  given contactId, check if that contact's company_id matches any open
 *  deal's company_id. If so, INSERT OR IGNORE deal_contacts.
 *
 *  Called from stage-approvals.ts immediately after the conversation_contacts
 *  insert loop. Best-effort — failures swallowed, logged but never block
 *  the ingestion path. Idempotent: dupes collapse via UNIQUE constraint.
 *
 *  Returns count newly-linked across all matched deals (for telemetry). */
export async function propagateContactToOpenDeals(
  contactId: string,
  orgId: string,
  env: Env
): Promise<{ linked: number; deal_count: number }> {
  // Wave 5: fetch email alongside company_id for side classification.
  const contact = await env.D1.prepare(
    `SELECT email, company_id FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{ email: string | null; company_id: string | null }>();
  if (!contact?.company_id) return { linked: 0, deal_count: 0 };

  // Find all open deals at that company. Closed deals (won/lost) skip the
  // auto-link — historical lookback isn't useful, and a contact joining
  // post-close doesn't represent a live signal.
  const deals = await env.D1.prepare(
    `SELECT id, company_id FROM deals
       WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL
         AND stage NOT IN ('closed_won','closed_lost')`
  ).bind(orgId, contact.company_id).all<{ id: string; company_id: string }>();
  if (deals.results.length === 0) return { linked: 0, deal_count: 0 };

  const internalDomains = await resolveInternalDomains(orgId, env);
  const stmts = deals.results.map(d => {
    const side = classifyContactSideSync(contact.email, contact.company_id, d.company_id, internalDomains);
    return env.D1.prepare(
      `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'other', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, d.id, contactId, side);
  });
  const results = await env.D1.batch(stmts);
  const linked = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return { linked, deal_count: deals.results.length };
}

/** Org-wide one-time recovery: for every open deal, run linkContactsByCompanyMatch.
 *  Used by the admin /api/admin/recover-deal-conversation-links endpoint.
 *  Supports dry_run for eyeball-before-commit verification. */
export async function recoverDealContactLinks(
  orgId: string,
  env: Env,
  opts: { dry_run?: boolean } = {}
): Promise<{
  deals_processed: number;
  rows_inserted: number;
  per_deal: Array<{ deal_id: string; deal_title: string; matched: number; inserted: number }>;
}> {
  const deals = await env.D1.prepare(
    `SELECT id, title, company_id FROM deals
       WHERE org_id = ? AND deleted_at IS NULL`
  ).bind(orgId).all<{ id: string; title: string; company_id: string }>();

  const perDeal: Array<{ deal_id: string; deal_title: string; matched: number; inserted: number }> = [];
  let totalInserted = 0;

  for (const deal of deals.results) {
    if (!deal.company_id) {
      perDeal.push({ deal_id: deal.id, deal_title: deal.title, matched: 0, inserted: 0 });
      continue;
    }

    // Count would-be matches first (works in both dry_run and live mode for
    // reporting accuracy).
    const matchedRows = await env.D1.prepare(
      `SELECT COUNT(*) AS n FROM contacts
         WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL
           AND id NOT IN (
             SELECT contact_id FROM deal_contacts WHERE deal_id = ?
           )`
    ).bind(orgId, deal.company_id, deal.id).first<{ n: number }>();
    const matched = matchedRows?.n ?? 0;

    let inserted = 0;
    if (!opts.dry_run && matched > 0) {
      const r = await linkContactsByCompanyMatch(deal.id, orgId, env);
      inserted = r.linked;
      totalInserted += inserted;
    }

    perDeal.push({
      deal_id: deal.id,
      deal_title: deal.title,
      matched,
      inserted,
    });
  }

  return {
    deals_processed: deals.results.length,
    rows_inserted: totalInserted,
    per_deal: perDeal,
  };
}

// ─── Phase B/C/D direct-link helpers ─────────────────────────────────────
//
// conversation_deals + event_deals are the first-class deal pointers
// (migration 0071). These helpers wrap the INSERT OR IGNORE +
// deal_intelligence invalidation in one place so all callers (Phase C
// meeting-detection, Phase D confidence-ladder, Phase E Slack
// auto-link, Phase F manual UI) share consistent semantics.

/** Find an open deal for a company. Used by detection paths to decide
 *  "link to existing deal" vs "stage create_deal proposal." Returns the
 *  most-recently-touched open deal, or null. Mirrors the lookup pattern
 *  in src/lib/signal-router.ts:191. */
export async function findOpenDealForCompany(
  companyId: string,
  orgId: string,
  env: Env
): Promise<{ id: string; title: string } | null> {
  return env.D1.prepare(
    `SELECT id, title FROM deals
       WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
         AND stage NOT IN ('closed_won', 'closed_lost')
       ORDER BY updated_at DESC LIMIT 1`
  ).bind(companyId, orgId).first<{ id: string; title: string }>();
}

/** Insert a conversation_deals row + invalidate the deal's intelligence
 *  cache so a fresh recompute picks up the new evidence. Idempotent
 *  (UNIQUE(conversation_id, deal_id)). Source enum: see migration 0071
 *  comment block. */
export async function linkConversationToDeal(
  conversationId: string,
  dealId: string,
  source: string,
  confidence: number,
  orgId: string,
  env: Env,
  createdBy?: string
): Promise<{ inserted: boolean }> {
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO conversation_deals
       (conversation_id, deal_id, confidence, source, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(conversationId, dealId, confidence, source, createdBy ?? null).run();
  const inserted = (result.meta?.changes ?? 0) > 0;
  if (inserted) {
    await invalidateDealIntelligence(dealId, orgId, env);
  }
  return { inserted };
}

/** Insert an event_deals row + invalidate. Same shape as
 *  linkConversationToDeal. */
export async function linkEventToDeal(
  eventId: string,
  dealId: string,
  source: string,
  confidence: number,
  orgId: string,
  env: Env,
  createdBy?: string
): Promise<{ inserted: boolean }> {
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO event_deals
       (event_id, deal_id, confidence, source, created_by)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(eventId, dealId, confidence, source, createdBy ?? null).run();
  const inserted = (result.meta?.changes ?? 0) > 0;
  if (inserted) {
    await invalidateDealIntelligence(dealId, orgId, env);
  }
  return { inserted };
}

/** Stage an approval_queue row proposing to link a conversation OR event
 *  to a deal. Used by medium-confidence paths (LLM 0.7-0.9). On approve,
 *  commitApproval (Phase C/D) inserts the appropriate junction row.
 *
 *  Idempotency key keys on (orgId, sourceId, dealId) so the same proposal
 *  can't pile up across detection cycles. */
export async function proposeLinkToDeal(opts: {
  kind: 'conversation' | 'event';
  sourceId: string;
  dealId: string;
  orgId: string;
  confidence: number;
  /** The conversation/event id that produced the signal (for sourcing). */
  sourceCommunicationId: string;
  visibility?: 'private' | 'org_wide' | 'confidential';
}, env: Env): Promise<{ inserted: boolean }> {
  const idempotencyKey = `${opts.orgId}:link-to-deal:${opts.kind}:${opts.sourceId}:${opts.dealId}`;
  const proposedValue = JSON.stringify({
    deal_id: opts.dealId,
    source: 'approval_committed',
    confidence: opts.confidence,
  });
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO approval_queue
       (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
        proposed_value, source_communication_id, source_visibility, confidence, status)
     VALUES (?, ?, ?, ?, 'link_to_deal', 'deal_id', ?, ?, ?, ?, 'pending')`
  ).bind(
    idempotencyKey,
    opts.orgId,
    opts.kind,                              // entity_type='conversation' | 'event'
    opts.sourceId,
    proposedValue,
    opts.sourceCommunicationId,
    opts.visibility || 'org_wide',
    opts.confidence
  ).run();
  return { inserted: (result.meta?.changes ?? 0) > 0 };
}

// ─── Phase D: hard/medium-signal detection at ingest time ──────────────
//
// Confidence ladder per T6's framework:
//
//   HARD signals (auto-link, source='auto_high' or 'inherited_*'):
//     • inherited_thread: another conversation in the same external_thread_id
//       is already linked → new conv inherits.
//     • auto_high: subject contains an open-deal company name AND a
//       deal-language keyword (subject is high-precision metadata; "Acme
//       term sheet" effectively names the deal).
//
//   MEDIUM signals (propose via approval_queue):
//     • Meeting heuristic: event with internal + external attendees,
//       ≥30 min duration, attendee matches a deal_contact → propose.
//
//   WEAK signals: PR #24 contact-overlap fallback, untouched.
//
// Helpers run at stage-approvals.ts ingest time (best-effort). Idempotent
// via INSERT OR IGNORE on the junctions / approval_queue.
//
// Out of scope this phase:
//   • inherited_series — events table has no series_id column yet.
//   • inherited_channel — Phase E.
//   • Forwarded deal memo / data-room URL detection — body parsing.

const SUBJECT_DEAL_KEYWORDS = [
  'term sheet', 'data room', 'diligence', 'safe', 'investment',
  'allocation', 'check size', 'pre-seed', 'seed round', 'series a',
  'series b', 'series c', 'pitch', 'valuation', 'memo', 'closing',
];

/** Apply hard signals to a newly-staged conversation. Runs inline in
 *  stage-approvals.ts after conversation_contacts is populated. Returns
 *  count of new junction rows inserted. Best-effort — caller swallows. */
export async function applyHardSignalsToConversation(
  conversationId: string,
  externalThreadId: string | null,
  subject: string | null,
  orgId: string,
  env: Env
): Promise<{ inherited_thread: number; auto_high: number }> {
  let inheritedThread = 0;
  let autoHigh = 0;

  // (1) inherited_thread: any other conversation in the same external
  // thread already linked to a deal → this conversation inherits.
  if (externalThreadId) {
    const siblings = await env.D1.prepare(
      `SELECT cd.deal_id, MAX(cd.confidence) AS confidence
         FROM conversations sib
         JOIN conversation_deals cd ON cd.conversation_id = sib.id
        WHERE sib.external_thread_id = ?
          AND sib.org_id = ?
          AND sib.id != ?
        GROUP BY cd.deal_id
        LIMIT 10`
    ).bind(externalThreadId, orgId, conversationId).all<{ deal_id: string; confidence: number }>();
    for (const s of siblings.results) {
      const r = await linkConversationToDeal(
        conversationId, s.deal_id, 'inherited_thread', s.confidence, orgId, env
      );
      if (r.inserted) inheritedThread++;
    }
  }

  // (2) auto_high: subject names an open-deal company AND contains
  // deal-language. Cheap O(open_deals) scan; orgs rarely have >50
  // simultaneously-open deals.
  if (subject) {
    const subjectLower = subject.toLowerCase();
    const hasDealLanguage = SUBJECT_DEAL_KEYWORDS.some(kw => subjectLower.includes(kw));
    if (hasDealLanguage) {
      const openDeals = await env.D1.prepare(
        `SELECT d.id, c.name
           FROM deals d
           JOIN companies c ON c.id = d.company_id
          WHERE d.org_id = ?
            AND d.deleted_at IS NULL
            AND d.stage NOT IN ('closed_won','closed_lost')
          LIMIT 200`
      ).bind(orgId).all<{ id: string; name: string }>();
      for (const d of openDeals.results) {
        if (!d.name) continue;
        if (subjectLower.includes(d.name.toLowerCase())) {
          const r = await linkConversationToDeal(
            conversationId, d.id, 'auto_high', 0.95, orgId, env
          );
          if (r.inserted) autoHigh++;
          // Keep scanning — "Acme + Beta term sheet" can legitimately
          // reference both deals.
        }
      }
    }
  }

  return { inherited_thread: inheritedThread, auto_high: autoHigh };
}

/** Apply medium-signal heuristic to a newly-staged event. Proposes a
 *  link_to_deal in approval_queue when attendee profile + duration
 *  suggest deal involvement. Returns count proposed. */
export async function applyMeetingHeuristicToEvent(
  eventId: string,
  orgId: string,
  env: Env
): Promise<{ proposed: number }> {
  const event = await env.D1.prepare(
    `SELECT id, start_time, end_time
       FROM events
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(eventId, orgId).first<{ id: string; start_time: string; end_time: string | null }>();
  if (!event) return { proposed: 0 };

  // Duration filter — short standups don't pass the heuristic.
  const startMs = Date.parse(event.start_time);
  const endMs = event.end_time ? Date.parse(event.end_time) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { proposed: 0 };
  if ((endMs - startMs) / 60000 < 30) return { proposed: 0 };

  // Need at least one internal user AND one external contact.
  const attendees = await env.D1.prepare(
    `SELECT contact_id, is_internal FROM event_attendees WHERE event_id = ?`
  ).bind(eventId).all<{ contact_id: string | null; is_internal: number }>();
  const hasInternal = attendees.results.some(a => a.is_internal === 1);
  const externalContactIds = attendees.results
    .filter(a => a.is_internal !== 1 && a.contact_id)
    .map(a => a.contact_id!) as string[];
  if (!hasInternal || externalContactIds.length === 0) return { proposed: 0 };

  // Find any open deals whose deal_contacts intersect with external
  // attendees. Multi-deal match is allowed — propose for each.
  const placeholders = externalContactIds.map(() => '?').join(',');
  const deals = await env.D1.prepare(
    `SELECT DISTINCT d.id
       FROM deals d
       JOIN deal_contacts dc ON dc.deal_id = d.id
      WHERE d.org_id = ? AND d.deleted_at IS NULL
        AND d.stage NOT IN ('closed_won','closed_lost')
        AND dc.contact_id IN (${placeholders})
      LIMIT 5`
  ).bind(orgId, ...externalContactIds).all<{ id: string }>();

  let proposed = 0;
  for (const d of deals.results) {
    const r = await proposeLinkToDeal({
      kind: 'event', sourceId: eventId, dealId: d.id, orgId,
      confidence: 0.75, sourceCommunicationId: eventId,
    }, env);
    if (r.inserted) proposed++;
  }
  return { proposed };
}

/** Broadcast invalidate all deal_intelligence rows for a deal. Per-user
 *  ACL filtering still applies during the next recompute (compute calls
 *  filterConversationsByAcl), so over-invalidating is safe — at worst we
 *  spend an LLM call to produce the same output for users whose readable
 *  set didn't change.
 *
 *  Why broadcast vs the precision-filter pattern in
 *  invalidateForConversation: a new direct link doesn't carry the
 *  conversation's ACL fields handy at the link-write site, and the new
 *  link could span events (which use event_attendees, not
 *  participant_user_ids). Broadcast keeps the helper simple and the
 *  guardrail satisfied — recompute on next tick or read. */
async function invalidateDealIntelligence(
  dealId: string,
  orgId: string,
  env: Env
): Promise<void> {
  try {
    await env.D1.prepare(
      `UPDATE deal_intelligence
          SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE deal_id = ? AND user_id IN (
          SELECT id FROM users WHERE org_id = ? AND deleted_at IS NULL
        )`
    ).bind(dealId, orgId).run();
  } catch (e) {
    console.error(`[deal-association] invalidate failed for deal=${dealId}:`, e);
  }
}

// ─── Phase E: Slack channel ↔ deal background classifier ────────────────
//
// Problem: Slack channels named after a portfolio company (#acme-deal,
// "ACME — diligence", etc.) carry deal-relevant signal but never reach
// deal_intelligence because their participant_user_ids don't intersect
// with deal_contacts unless the same humans happen to also email each
// other. We can't gate Slack on contact-overlap.
//
// Approach: classify the channel itself, not each message.
//   • Signal 1 (v1): tokenize channel_name + open-deal company names,
//     compute Jaccard overlap, link if ≥0.5.
//   • Signal 2-5 (future): membership signals, body keywords, Haiku
//     adjudication on ambiguous matches.
//
// When a channel links to a deal:
//   • Backfill — every conversation in slack_channel for last 60 days
//     gets a conversation_deals row via source='inherited_channel'.
//   • Forward — at ingest time, stage-approvals.ts looks up
//     slack_channel_deals via (org, channel_id) and links the new
//     conversation automatically.

const STOP_WORDS = new Set([
  'the', 'and', 'inc', 'llc', 'ltd', 'co', 'corp', 'corporation',
  'company', 'group', 'holdings', 'partners', 'capital', 'ventures',
  'labs', 'tech', 'technologies', 'ai', 'app', 'apps', 'cloud',
  'deal', 'deals', 'diligence', 'investment', 'investments', 'round',
]);

/** Tokenize a string into normalized lowercase tokens with stop-words
 *  removed. Channel names use `-` and `_`; company names use spaces and
 *  punctuation; both collapse the same way. */
function tokenizeForChannelMatch(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** Backfill conversation_deals for every slack-source conversation in
 *  this channel from the last 60 days. Source='inherited_channel'.
 *  Idempotent (PK on conversation_deals). Returns inserted count.
 *
 *  Uses external_message_id LIKE '<channel>:%' as the channel filter —
 *  see slack.ts integration where externalId is built as
 *  `${channel.id}:${msg.ts}`. Bounded by LIMIT to keep subrequest count
 *  predictable; channels that exceed the cap will continue to be linked
 *  forward, just won't all backfill in a single classification pass. */
export async function backfillSlackChannelToDeal(
  channelId: string,
  dealId: string,
  orgId: string,
  env: Env,
  confidence: number = 0.85
): Promise<{ inserted: number; scanned: number }> {
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.D1.prepare(
    `SELECT id FROM conversations
       WHERE org_id = ?
         AND source = 'slack'
         AND external_message_id LIKE ?
         AND sent_at >= ?
       ORDER BY sent_at DESC
       LIMIT 500`
  ).bind(orgId, `${channelId}:%`, cutoff).all<{ id: string }>();

  let inserted = 0;
  for (const r of rows.results) {
    const ins = await env.D1.prepare(
      `INSERT OR IGNORE INTO conversation_deals
         (conversation_id, deal_id, confidence, source, created_by)
       VALUES (?, ?, ?, 'inherited_channel', NULL)`
    ).bind(r.id, dealId, confidence).run();
    if (ins.meta?.changes) inserted++;
  }

  if (inserted > 0) {
    await invalidateDealIntelligence(dealId, orgId, env);
  }
  return { inserted, scanned: rows.results.length };
}

/** Look up open deals that should auto-link based on the channel name.
 *  Returns deals scored above the threshold (default 0.5 Jaccard).
 *  Used by both the channel-upsert classifier and admin tooling. */
export async function findDealsByChannelNameMatch(
  channelName: string,
  orgId: string,
  env: Env,
  threshold: number = 0.5
): Promise<Array<{ deal_id: string; company_name: string; score: number }>> {
  const channelTokens = tokenizeForChannelMatch(channelName);
  if (channelTokens.size === 0) return [];

  const openDeals = await env.D1.prepare(
    `SELECT d.id AS deal_id, c.name AS company_name
       FROM deals d
       JOIN companies c ON c.id = d.company_id
      WHERE d.org_id = ?
        AND d.deleted_at IS NULL
        AND d.stage NOT IN ('closed_won','closed_lost')
      LIMIT 200`
  ).bind(orgId).all<{ deal_id: string; company_name: string }>();

  const matches: Array<{ deal_id: string; company_name: string; score: number }> = [];
  for (const d of openDeals.results) {
    if (!d.company_name) continue;
    const score = jaccard(channelTokens, tokenizeForChannelMatch(d.company_name));
    if (score >= threshold) {
      matches.push({ deal_id: d.deal_id, company_name: d.company_name, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/** Background classifier for a single Slack channel. Called from slack.ts
 *  after slack_channels upsert. Best-effort; per-channel failure swallowed.
 *
 *  On match: insert slack_channel_deals row + backfill last-60-days
 *  conversations into conversation_deals via inherited_channel. Idempotent
 *  via PKs on both tables. Skips channels already linked to the matched
 *  deal (saves the backfill scan). */
export async function classifySlackChannelForDeals(
  channelId: string,
  channelName: string,
  orgId: string,
  env: Env
): Promise<{ linked: number; backfilled: number }> {
  if (!channelName) return { linked: 0, backfilled: 0 };

  const matches = await findDealsByChannelNameMatch(channelName, orgId, env);
  if (matches.length === 0) return { linked: 0, backfilled: 0 };

  let linked = 0;
  let backfilled = 0;
  for (const m of matches) {
    const ins = await env.D1.prepare(
      `INSERT OR IGNORE INTO slack_channel_deals
         (org_id, channel_id, deal_id, confidence, source, created_by)
       VALUES (?, ?, ?, ?, 'channel_name_match', NULL)`
    ).bind(orgId, channelId, m.deal_id, m.score).run();
    if (!ins.meta?.changes) continue;

    linked++;
    console.log(
      `[slack-classifier] linked channel=${channelId} (${channelName}) → deal=${m.deal_id} (${m.company_name}) score=${m.score.toFixed(2)}`
    );
    const bf = await backfillSlackChannelToDeal(channelId, m.deal_id, orgId, env, m.score);
    backfilled += bf.inserted;
    if (bf.inserted > 0) {
      console.log(
        `[slack-classifier] backfilled ${bf.inserted}/${bf.scanned} messages from channel=${channelId} → deal=${m.deal_id}`
      );
    }
  }
  return { linked, backfilled };
}

/** Look up which deals are linked to a Slack channel. Used by the
 *  ingest-time hook in stage-approvals.ts when a slack-source
 *  conversation arrives. Returns [] when channel isn't classified. */
export async function getDealsForSlackChannel(
  channelId: string,
  orgId: string,
  env: Env
): Promise<Array<{ deal_id: string; confidence: number }>> {
  const rows = await env.D1.prepare(
    `SELECT deal_id, confidence FROM slack_channel_deals
      WHERE org_id = ? AND channel_id = ?`
  ).bind(orgId, channelId).all<{ deal_id: string; confidence: number }>();
  return rows.results;
}

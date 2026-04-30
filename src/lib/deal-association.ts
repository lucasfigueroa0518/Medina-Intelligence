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

  // Find all contacts at the company.
  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts
       WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL`
  ).bind(orgId, deal.company_id).all<{ id: string }>();
  const contactIds = contacts.results.map(c => c.id);
  if (contactIds.length === 0) return { linked: 0, matched_contact_count: 0 };

  // INSERT OR IGNORE one row per contact. Default role='other', side='theirs'
  // — the contact's at the deal's company, so they're on the founder/team
  // side until a human re-classifies via the UI.
  const stmts = contactIds.map(cid =>
    env.D1.prepare(
      `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'other', 'theirs', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, dealId, cid)
  );
  const results = await env.D1.batch(stmts);
  const linked = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return { linked, matched_contact_count: contactIds.length };
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
  const participants = await env.D1.prepare(
    `SELECT DISTINCT cc.contact_id
       FROM conversation_contacts cc
       JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.conversation_id = ?
        AND c.org_id = ? AND c.deleted_at IS NULL`
  ).bind(conversationId, orgId).all<{ contact_id: string }>();
  const contactIds = participants.results.map(r => r.contact_id);
  if (contactIds.length === 0) return { linked: 0, participant_count: 0 };

  const stmts = contactIds.map(cid =>
    env.D1.prepare(
      `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'other', 'theirs', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, dealId, cid)
  );
  const results = await env.D1.batch(stmts);
  const linked = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return { linked, participant_count: contactIds.length };
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
  const contact = await env.D1.prepare(
    `SELECT company_id FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{ company_id: string | null }>();
  if (!contact?.company_id) return { linked: 0, deal_count: 0 };

  // Find all open deals at that company. Closed deals (won/lost) skip the
  // auto-link — historical lookback isn't useful, and a contact joining
  // post-close doesn't represent a live signal.
  const deals = await env.D1.prepare(
    `SELECT id FROM deals
       WHERE org_id = ? AND company_id = ? AND deleted_at IS NULL
         AND stage NOT IN ('closed_won','closed_lost')`
  ).bind(orgId, contact.company_id).all<{ id: string }>();
  const dealIds = deals.results.map(d => d.id);
  if (dealIds.length === 0) return { linked: 0, deal_count: 0 };

  const stmts = dealIds.map(did =>
    env.D1.prepare(
      `INSERT OR IGNORE INTO deal_contacts (id, org_id, deal_id, contact_id, role, side, added_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'other', 'theirs', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).bind(orgId, did, contactId)
  );
  const results = await env.D1.batch(stmts);
  const linked = results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return { linked, deal_count: dealIds.length };
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

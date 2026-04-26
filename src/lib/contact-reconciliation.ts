// Self-healing pass for orphan contacts.
//
// discoverNewContact (src/lib/discovery.ts) commits a contact to D1 inside the
// classify-batch workflow step. The matching conversations row + the
// conversation_contacts junction are inserted in the later stage-approvals
// step. If the workflow fails between the two steps (sub-request cap, timeout,
// partial commit), the contact persists with no link, and on retry Outlook's
// delta token has already advanced — the source email is never re-fetched.
//
// This pass runs at the end of every successful ingestion: any contact whose
// email matches an existing conversation's from/to/cc gets back-linked, then
// total_interactions is recomputed from the junction so the counter is always
// the source of truth, not the increment trail.

import type { Env } from '../types/env';

export interface ReconciliationResult {
  orphan_contacts_scanned: number;
  links_inserted: number;
  contacts_with_counter_change: number;
}

export async function reconcileOrphanContacts(
  orgId: string,
  env: Env
): Promise<ReconciliationResult> {
  const orphans = await env.D1.prepare(
    `SELECT c.id, c.email FROM contacts c
       WHERE c.org_id = ? AND c.deleted_at IS NULL AND c.email IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM conversation_contacts cc WHERE cc.contact_id = c.id
         )`
  ).bind(orgId).all<{ id: string; email: string }>();

  let linksInserted = 0;

  for (const orphan of orphans.results) {
    if (!orphan.email) continue;
    const emailLower = orphan.email.toLowerCase();
    const jsonNeedle = `%"${emailLower}"%`;

    const matching = await env.D1.prepare(
      `SELECT id FROM conversations
         WHERE org_id = ?
           AND (LOWER(from_email) = ? OR LOWER(to_emails) LIKE ? OR LOWER(cc_emails) LIKE ?)`
    ).bind(orgId, emailLower, jsonNeedle, jsonNeedle).all<{ id: string }>();

    for (const conv of matching.results) {
      const result = await env.D1.prepare(
        `INSERT OR IGNORE INTO conversation_contacts (conversation_id, contact_id, role)
         VALUES (?, ?, 'participant')`
      ).bind(conv.id, orphan.id).run();
      if (result.meta?.changes) linksInserted++;
    }
  }

  // Make total_interactions and last_contact_date the canonical projection of
  // the junction table — fixes any drift left by failed mid-pipeline writes.
  const counterUpdate = await env.D1.prepare(
    `UPDATE contacts
       SET total_interactions = (
             SELECT COUNT(*) FROM conversation_contacts WHERE contact_id = contacts.id
           ),
           last_contact_date = (
             SELECT MAX(c.sent_at) FROM conversation_contacts cc
             JOIN conversations c ON c.id = cc.conversation_id
             WHERE cc.contact_id = contacts.id
           ),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND deleted_at IS NULL
       AND total_interactions != (
             SELECT COUNT(*) FROM conversation_contacts WHERE contact_id = contacts.id
           )`
  ).bind(orgId).run();

  return {
    orphan_contacts_scanned: orphans.results.length,
    links_inserted: linksInserted,
    contacts_with_counter_change: counterUpdate.meta?.changes || 0,
  };
}

// TRD §7.9 — Unified entity association engine + legacy auto-link helpers
import type { Env } from '../types/env';

// --- Canonical ordering: ensures entity_a < entity_b to prevent duplicates ---

function canonicalOrder(
  a: { type: string; id: string },
  b: { type: string; id: string }
): [{ type: string; id: string }, { type: string; id: string }] {
  const keyA = `${a.type}:${a.id}`;
  const keyB = `${b.type}:${b.id}`;
  return keyA <= keyB ? [a, b] : [b, a];
}

// --- Strength calculation by association type ---

function calculateStrength(
  assocType: string,
  evidenceCount: number,
  extraData?: { sharedCount?: number }
): number {
  switch (assocType) {
    case 'same_company': return 100;
    case 'deal_involvement': return 95;
    case 'co_meeting': return Math.min(79, 40 + evidenceCount * 5);
    case 'co_email': return Math.min(79, 40 + evidenceCount * 3);
    case 'direct_email': return Math.min(79, 50 + evidenceCount * 3);
    case 'same_sector': return 25;
    case 'shared_interests': return Math.min(39, 15 + (extraData?.sharedCount ?? 0) * 3);
    case 'investment_aligned': return 30;
    case 'mentioned_together': return 20;
    case 'introduced_by': return 60;
    default: return 50;
  }
}

// --- Core upsert ---

export async function upsertAssociation(
  orgId: string,
  entityA: { type: string; id: string },
  entityB: { type: string; id: string },
  assocType: string,
  reason: string,
  env: Env,
  extraData?: { sharedCount?: number }
): Promise<void> {
  if (entityA.id === entityB.id && entityA.type === entityB.type) return;

  const [a, b] = canonicalOrder(entityA, entityB);
  const strength = calculateStrength(assocType, 1, extraData);

  await env.D1.prepare(
    `INSERT INTO entity_associations
       (org_id, entity_a_type, entity_a_id, entity_b_type, entity_b_id, association_type, strength, reason, evidence_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(org_id, entity_a_type, entity_a_id, entity_b_type, entity_b_id, association_type) DO UPDATE SET
       evidence_count = evidence_count + 1,
       strength = ?,
       reason = ?,
       last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    orgId, a.type, a.id, b.type, b.id, assocType, strength, reason,
    calculateStrength(assocType, 2, extraData), reason
  ).run();
}

// --- Calculate associations for a single contact ---

export async function calculateAssociationsForContact(
  contactId: string,
  orgId: string,
  env: Env
): Promise<number> {
  let count = 0;

  const contact = await env.D1.prepare(
    `SELECT id, company_id, topics_of_interest FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{
    id: string; company_id: string | null; topics_of_interest: string | null;
  }>();
  if (!contact) return 0;

  // CONTACT → COMPANY
  if (contact.company_id) {
    const company = await env.D1.prepare(
      `SELECT id, name, sector FROM companies WHERE id = ? AND deleted_at IS NULL`
    ).bind(contact.company_id).first<{ id: string; name: string; sector: string | null }>();

    if (company) {
      await upsertAssociation(orgId,
        { type: 'contact', id: contactId },
        { type: 'company', id: company.id },
        'same_company', `Works at ${company.name}`, env
      );
      count++;

      // SAME COMPANY: other contacts at the same company
      const colleagues = await env.D1.prepare(
        `SELECT id, full_name FROM contacts WHERE company_id = ? AND org_id = ? AND id != ? AND deleted_at IS NULL`
      ).bind(contact.company_id, orgId, contactId).all<{ id: string; full_name: string }>();

      for (const c of colleagues.results) {
        await upsertAssociation(orgId,
          { type: 'contact', id: contactId },
          { type: 'contact', id: c.id },
          'same_company', `Both work at ${company.name}`, env
        );
        count++;
      }

      // SAME SECTOR: contacts at companies in the same sector
      if (company.sector) {
        const sectorContacts = await env.D1.prepare(
          `SELECT c.id, c.full_name, co.name as company_name FROM contacts c
           JOIN companies co ON c.company_id = co.id
           WHERE co.sector = ? AND co.org_id = ? AND c.id != ? AND c.deleted_at IS NULL AND co.deleted_at IS NULL
           AND c.company_id != ?
           LIMIT 50`
        ).bind(company.sector, orgId, contactId, contact.company_id).all<{
          id: string; full_name: string; company_name: string;
        }>();

        for (const sc of sectorContacts.results) {
          await upsertAssociation(orgId,
            { type: 'contact', id: contactId },
            { type: 'contact', id: sc.id },
            'same_sector', `Both in ${company.sector} sector`, env
          );
          count++;
        }
      }
    }
  }

  // CO-MEETINGS: contacts who attended the same events
  const coMeetingContacts = await env.D1.prepare(
    `SELECT DISTINCT ea2.contact_id, c.full_name FROM event_attendees ea1
     JOIN event_attendees ea2 ON ea1.event_id = ea2.event_id AND ea2.contact_id != ea1.contact_id
     JOIN contacts c ON ea2.contact_id = c.id AND c.deleted_at IS NULL
     WHERE ea1.contact_id = ?
     LIMIT 100`
  ).bind(contactId).all<{ contact_id: string; full_name: string }>();

  for (const cm of coMeetingContacts.results) {
    await upsertAssociation(orgId,
      { type: 'contact', id: contactId },
      { type: 'contact', id: cm.contact_id },
      'co_meeting', `Co-attended meetings`, env
    );
    count++;
  }

  // CO-EMAILS: contacts on the same conversations
  const coEmailContacts = await env.D1.prepare(
    `SELECT DISTINCT cc2.contact_id, c.full_name FROM conversation_contacts cc1
     JOIN conversation_contacts cc2 ON cc1.conversation_id = cc2.conversation_id AND cc2.contact_id != cc1.contact_id
     JOIN contacts c ON cc2.contact_id = c.id AND c.deleted_at IS NULL
     WHERE cc1.contact_id = ?
     LIMIT 100`
  ).bind(contactId).all<{ contact_id: string; full_name: string }>();

  for (const ce of coEmailContacts.results) {
    await upsertAssociation(orgId,
      { type: 'contact', id: contactId },
      { type: 'contact', id: ce.contact_id },
      'co_email', `Co-participants in email threads`, env
    );
    count++;
  }

  // SHARED INTERESTS: compare topics_of_interest
  if (contact.topics_of_interest) {
    let topics: string[] = [];
    try {
      topics = JSON.parse(contact.topics_of_interest);
    } catch {
      topics = contact.topics_of_interest.split(',').map(t => t.trim()).filter(Boolean);
    }

    if (topics.length > 0) {
      const otherContacts = await env.D1.prepare(
        `SELECT id, full_name, topics_of_interest FROM contacts
         WHERE org_id = ? AND id != ? AND topics_of_interest IS NOT NULL AND deleted_at IS NULL
         LIMIT 200`
      ).bind(orgId, contactId).all<{
        id: string; full_name: string; topics_of_interest: string;
      }>();

      for (const oc of otherContacts.results) {
        let otherTopics: string[] = [];
        try {
          otherTopics = JSON.parse(oc.topics_of_interest);
        } catch {
          otherTopics = oc.topics_of_interest.split(',').map(t => t.trim()).filter(Boolean);
        }

        const shared = topics.filter(t =>
          otherTopics.some(ot => ot.toLowerCase() === t.toLowerCase())
        );
        if (shared.length >= 3) {
          await upsertAssociation(orgId,
            { type: 'contact', id: contactId },
            { type: 'contact', id: oc.id },
            'shared_interests', `Share ${shared.length} interests: ${shared.slice(0, 3).join(', ')}`, env,
            { sharedCount: shared.length }
          );
          count++;
        }
      }
    }
  }

  return count;
}

// --- Calculate associations for a single company ---

export async function calculateAssociationsForCompany(
  companyId: string,
  orgId: string,
  env: Env
): Promise<number> {
  let count = 0;

  const company = await env.D1.prepare(
    `SELECT id, name, sector FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<{ id: string; name: string; sector: string | null }>();
  if (!company) return 0;

  // CONTACTS at this company
  const contacts = await env.D1.prepare(
    `SELECT id, full_name FROM contacts WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).all<{ id: string; full_name: string }>();

  for (const c of contacts.results) {
    await upsertAssociation(orgId,
      { type: 'company', id: companyId },
      { type: 'contact', id: c.id },
      'same_company', `${c.full_name} works at ${company.name}`, env
    );
    count++;
  }

  // SAME SECTOR: other companies
  if (company.sector) {
    const sectorCompanies = await env.D1.prepare(
      `SELECT id, name FROM companies WHERE sector = ? AND org_id = ? AND id != ? AND deleted_at IS NULL LIMIT 50`
    ).bind(company.sector, orgId, companyId).all<{ id: string; name: string }>();

    for (const sc of sectorCompanies.results) {
      await upsertAssociation(orgId,
        { type: 'company', id: companyId },
        { type: 'company', id: sc.id },
        'same_sector', `Both in ${company.sector} sector`, env
      );
      count++;
    }
  }

  // DEALS for this company
  const deals = await env.D1.prepare(
    `SELECT id, title FROM deals WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).all<{ id: string; title: string }>();

  for (const d of deals.results) {
    await upsertAssociation(orgId,
      { type: 'company', id: companyId },
      { type: 'deal', id: d.id },
      'deal_involvement', `Deal: ${d.title}`, env
    );
    count++;
  }

  return count;
}

// --- Incremental update for a single contact (used after ingestion/enrichment) ---

export async function incrementalAssociationUpdate(
  contactId: string,
  orgId: string,
  env: Env
): Promise<void> {
  try {
    await calculateAssociationsForContact(contactId, orgId, env);
  } catch (e) {
    console.error(`[associations] incremental update failed for contact ${contactId}:`, e);
  }
}

// --- Full recalculation (daily cron) ---

export async function recalculateAllAssociations(
  orgId: string,
  env: Env
): Promise<void> {
  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts WHERE org_id = ? AND deleted_at IS NULL AND merged_into IS NULL LIMIT 500`
  ).bind(orgId).all<{ id: string }>();

  for (const c of contacts.results) {
    try {
      await calculateAssociationsForContact(c.id, orgId, env);
    } catch (e) {
      console.error(`[associations] recalc failed for contact ${c.id}:`, e);
    }
  }

  const companies = await env.D1.prepare(
    `SELECT id FROM companies WHERE org_id = ? AND deleted_at IS NULL LIMIT 200`
  ).bind(orgId).all<{ id: string }>();

  for (const c of companies.results) {
    try {
      await calculateAssociationsForCompany(c.id, orgId, env);
    } catch (e) {
      console.error(`[associations] recalc failed for company ${c.id}:`, e);
    }
  }
}

// --- Legacy helpers (keep for backward compatibility with contact_associations table) ---

export async function autoLinkAttendees(
  eventId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const attendees = await env.D1.prepare(
    'SELECT contact_id FROM event_attendees WHERE event_id = ? AND contact_id IS NOT NULL'
  ).bind(eventId).all<{ contact_id: string }>();

  const contactIds = attendees.results.map(a => a.contact_id);
  if (contactIds.length < 2) return;

  for (let i = 0; i < contactIds.length; i++) {
    for (let j = i + 1; j < contactIds.length; j++) {
      const [a, b] =
        contactIds[i] < contactIds[j]
          ? [contactIds[i], contactIds[j]]
          : [contactIds[j], contactIds[i]];

      await env.D1.prepare(
        `INSERT INTO contact_associations (org_id, contact_id_a, contact_id_b, relationship, inferred_from, confidence)
         VALUES (?, ?, ?, 'co-meeting', ?, 0.8)
         ON CONFLICT(contact_id_a, contact_id_b) DO UPDATE SET
           confidence = MIN(1.0, confidence + 0.1),
           inferred_from = json_set(COALESCE(inferred_from, '{}'), '$.last_event', ?)`
      ).bind(orgId, a, b, JSON.stringify({ event_id: eventId }), eventId).run();

      // Also write to entity_associations
      await upsertAssociation(orgId,
        { type: 'contact', id: a },
        { type: 'contact', id: b },
        'co_meeting', `Co-attended event`, env
      );
    }
  }
}

export async function autoLinkConversationParticipants(
  conversationId: string,
  contactIds: string[],
  orgId: string,
  env: Env
): Promise<void> {
  if (contactIds.length < 2) return;

  for (let i = 0; i < contactIds.length; i++) {
    for (let j = i + 1; j < contactIds.length; j++) {
      const [a, b] =
        contactIds[i] < contactIds[j]
          ? [contactIds[i], contactIds[j]]
          : [contactIds[j], contactIds[i]];

      await env.D1.prepare(
        `INSERT INTO contact_associations (org_id, contact_id_a, contact_id_b, relationship, inferred_from, confidence)
         VALUES (?, ?, ?, 'co-email', ?, 0.6)
         ON CONFLICT(contact_id_a, contact_id_b) DO UPDATE SET
           confidence = MIN(1.0, confidence + 0.05)`
      ).bind(orgId, a, b, JSON.stringify({ conversation_id: conversationId })).run();

      // Also write to entity_associations
      await upsertAssociation(orgId,
        { type: 'contact', id: a },
        { type: 'contact', id: b },
        'co_email', `Co-participants in email`, env
      );
    }
  }
}

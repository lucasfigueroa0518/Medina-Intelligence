import type { Env } from '../types/env';

interface UserScore {
  userId: string;
  score: number;
  lastInteraction: string;
}

export async function calculateRelationshipOwner(
  contactId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const contact = await env.D1.prepare(
    `SELECT id, relationship_owner_id, relationship_owner_manual
     FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{
    id: string;
    relationship_owner_id: string | null;
    relationship_owner_manual: number;
  }>();

  if (!contact) return;
  if (contact.relationship_owner_manual === 1) return;

  const interactions = await env.D1.prepare(
    `SELECT c.participant_user_ids, c.sent_at
     FROM conversations c
     WHERE c.org_id = ?
       AND (c.from_contact_id = ? OR c.id IN (
         SELECT conversation_id FROM conversation_contacts WHERE contact_id = ?
       ))
       AND c.sent_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
     ORDER BY c.sent_at DESC`
  ).bind(orgId, contactId, contactId).all<{
    participant_user_ids: string | null;
    sent_at: string;
  }>();

  const events = await env.D1.prepare(
    `SELECT ea.user_id AS organizer_user_id, e.start_time
     FROM events e
     JOIN event_attendees ea ON ea.event_id = e.id AND ea.role = 'organizer'
     WHERE e.org_id = ? AND e.deleted_at IS NULL
       AND e.id IN (
         SELECT event_id FROM event_attendees WHERE contact_id = ?
       )
       AND e.start_time > strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
     ORDER BY e.start_time DESC`
  ).bind(orgId, contactId).all<{
    organizer_user_id: string | null;
    start_time: string;
  }>();

  const userScores = new Map<string, UserScore>();
  const now = Date.now();

  function addScore(userId: string, dateStr: string, baseWeight: number) {
    if (!userId) return;
    const daysAgo = (now - new Date(dateStr).getTime()) / 86_400_000;
    let timeMultiplier: number;
    if (daysAgo <= 30) timeMultiplier = 3;
    else if (daysAgo <= 60) timeMultiplier = 2;
    else timeMultiplier = 1;

    const existing = userScores.get(userId);
    const weightedScore = baseWeight * timeMultiplier;
    if (existing) {
      existing.score += weightedScore;
      if (dateStr > existing.lastInteraction) existing.lastInteraction = dateStr;
    } else {
      userScores.set(userId, { userId, score: weightedScore, lastInteraction: dateStr });
    }
  }

  for (const conv of interactions.results) {
    if (!conv.participant_user_ids) continue;
    try {
      const userIds: string[] = JSON.parse(conv.participant_user_ids);
      for (const uid of userIds) {
        addScore(uid, conv.sent_at, 1);
      }
    } catch {
      if (typeof conv.participant_user_ids === 'string' && conv.participant_user_ids.length > 10) {
        addScore(conv.participant_user_ids, conv.sent_at, 1);
      }
    }
  }

  for (const evt of events.results) {
    if (evt.organizer_user_id) {
      addScore(evt.organizer_user_id, evt.start_time, 2);
    }
  }

  // Filter scores to only include valid users (never contacts)
  const allCandidateIds = Array.from(userScores.keys());
  const validUserIds = new Set<string>();
  if (allCandidateIds.length > 0) {
    const placeholders = allCandidateIds.map(() => '?').join(',');
    const validRows = await env.D1.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND org_id = ?`
    ).bind(...allCandidateIds, orgId).all<{ id: string }>();
    for (const r of validRows.results) validUserIds.add(r.id);

    for (const candidateId of allCandidateIds) {
      if (!validUserIds.has(candidateId)) {
        userScores.delete(candidateId);
        console.warn(`[relationship-owner] filtered non-user ID "${candidateId}" from candidates for contact ${contactId}`);
      }
    }
  }

  const ranked = Array.from(userScores.values()).sort((a, b) => b.score - a.score);

  let ownerId: string | null = null;

  if (ranked.length === 0) {
    const creator = await env.D1.prepare(
      `SELECT user_id FROM audit_log
       WHERE org_id = ? AND entity_type = 'contact' AND entity_id = ? AND action = 'create' AND user_id IS NOT NULL
       LIMIT 1`
    ).bind(orgId, contactId).first<{ user_id: string }>();

    if (creator?.user_id) {
      const validUser = await env.D1.prepare(
        'SELECT id FROM users WHERE id = ? AND org_id = ?'
      ).bind(creator.user_id, orgId).first();
      ownerId = validUser ? creator.user_id : null;
    }

    // No interactions and no audit-recorded creator → leave NULL.
    // Never default to "first user in the org" — that quietly assigns every
    // ownerless contact to whoever signed up first.
  } else if (ranked.length === 1) {
    ownerId = ranked[0].userId;
  } else {
    const top = ranked[0];
    const second = ranked[1];
    const withinThreshold = second.score >= top.score * 0.8;
    if (withinThreshold) {
      ownerId = top.lastInteraction >= second.lastInteraction ? top.userId : second.userId;
    } else {
      ownerId = top.userId;
    }
  }

  if (ownerId !== contact.relationship_owner_id) {
    await env.D1.prepare(
      `UPDATE contacts SET relationship_owner_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(ownerId, contactId).run();
  }
}

export async function calculateAllRelationshipOwners(
  orgId: string,
  env: Env
): Promise<number> {
  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts WHERE org_id = ? AND deleted_at IS NULL AND relationship_owner_manual = 0`
  ).bind(orgId).all<{ id: string }>();

  let updated = 0;
  for (const c of contacts.results) {
    try {
      await calculateRelationshipOwner(c.id, orgId, env);
      updated++;
    } catch (e) {
      console.error(`[relationship-owner] failed for ${c.id}:`, e);
    }
  }
  return updated;
}

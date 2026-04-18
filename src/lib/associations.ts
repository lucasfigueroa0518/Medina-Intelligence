// TRD §7.9 — Auto-link contacts from meetings and conversations
import type { Env } from '../types/env';

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
    }
  }
}

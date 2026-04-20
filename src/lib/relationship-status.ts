import type { Env } from '../types/env';

type EngagementStatus = 'new' | 'active' | 'warm' | 'dormant' | 'churning' | 'close';

export async function calculateRelationshipStatus(
  contactId: string,
  orgId: string,
  env: Env
): Promise<void> {
  const contact = await env.D1.prepare(
    `SELECT id, engagement_status, engagement_status_manual, last_contact_date,
            total_interactions, meetings_last_30d, email_frequency_score, created_at
     FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(contactId, orgId).first<{
    id: string;
    engagement_status: string | null;
    engagement_status_manual: number;
    last_contact_date: string | null;
    total_interactions: number;
    meetings_last_30d: number;
    email_frequency_score: number;
    created_at: string;
  }>();

  if (!contact) return;
  if (contact.engagement_status_manual === 1) return;

  const now = Date.now();
  const createdMs = new Date(contact.created_at).getTime();
  const lastContactMs = contact.last_contact_date
    ? new Date(contact.last_contact_date).getTime()
    : null;

  const daysSinceCreation = (now - createdMs) / 86_400_000;
  const daysSinceLastContact = lastContactMs
    ? (now - lastContactMs) / 86_400_000
    : Infinity;

  const previousStatus = contact.engagement_status as EngagementStatus | null;

  let status: EngagementStatus;

  if (daysSinceCreation < 3 && contact.total_interactions === 0) {
    status = 'new';
  } else if (daysSinceLastContact <= 14 && contact.total_interactions >= 1) {
    status = 'active';
  } else if (daysSinceLastContact <= 30) {
    status = 'warm';
  } else if (daysSinceLastContact <= 90) {
    status = 'dormant';
  } else if (daysSinceLastContact > 90) {
    status = 'churning';
  } else {
    status = 'new';
  }

  if (status !== previousStatus) {
    await env.D1.prepare(
      `UPDATE contacts SET engagement_status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).bind(status, contactId).run();
  }
}

export async function calculateAllRelationshipStatuses(
  orgId: string,
  env: Env
): Promise<number> {
  const contacts = await env.D1.prepare(
    `SELECT id FROM contacts WHERE org_id = ? AND deleted_at IS NULL AND engagement_status_manual = 0`
  ).bind(orgId).all<{ id: string }>();

  let updated = 0;
  for (const c of contacts.results) {
    try {
      await calculateRelationshipStatus(c.id, orgId, env);
      updated++;
    } catch (e) {
      console.error(`[relationship-status] failed for ${c.id}:`, e);
    }
  }
  return updated;
}

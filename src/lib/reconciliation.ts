// TRD §7.4 — Event reconciliation (Outlook upsert, Firefly matching, standalone promotion, orphan flagging)
import type { Env } from '../types/env';
import { safelyUpsertEventTimelineItemsForContacts } from './contact-detail-read-model';

export interface OutlookEventLike {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: { displayName?: string } | null;
  body?: { content?: string } | null;
  attendees?: Array<{
    emailAddress: { name?: string; address: string };
    type?: string;
    status?: { response?: string };
  }>;
  organizer?: { emailAddress: { name?: string; address: string } };
}

export async function upsertOutlookEvent(
  event: OutlookEventLike,
  orgId: string,
  env: Env
): Promise<void> {
  await env.D1.prepare(
    `INSERT INTO events (id, org_id, title, event_type, start_time, end_time, location, description,
       source, outlook_event_id, reconciliation_status, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, 'meeting', ?, ?, ?, ?, 'outlook', ?, 'reconciled',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(outlook_event_id) DO UPDATE SET
       title = excluded.title, start_time = excluded.start_time, end_time = excluded.end_time,
       location = excluded.location, description = excluded.description,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  )
    .bind(
      orgId,
      event.subject,
      event.start.dateTime,
      event.end.dateTime,
      event.location?.displayName || null,
      event.body?.content || null,
      event.id
    )
    .run();

  const eventRow = await env.D1.prepare(
    'SELECT id FROM events WHERE outlook_event_id = ?'
  ).bind(event.id).first<{ id: string }>();
  if (!eventRow) return;

  for (const att of event.attendees || []) {
    const isOrganizer =
      event.organizer?.emailAddress.address === att.emailAddress.address;

    const contact = await env.D1.prepare(
      'SELECT id FROM contacts WHERE email = ? AND org_id = ? AND deleted_at IS NULL'
    ).bind(att.emailAddress.address, orgId).first<{ id: string }>();

    const user = await env.D1.prepare(
      'SELECT id FROM users WHERE email = ? AND org_id = ?'
    ).bind(att.emailAddress.address, orgId).first<{ id: string }>();

    const attendeeInsert = await env.D1.prepare(
      `INSERT OR IGNORE INTO event_attendees (event_id, contact_id, user_id, email, display_name, role, is_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        eventRow.id,
        contact?.id || null,
        user?.id || null,
        att.emailAddress.address,
        att.emailAddress.name || null,
        isOrganizer ? 'organizer' : att.type === 'optional' ? 'optional' : 'attendee',
        user ? 1 : 0
      )
      .run();
    if (attendeeInsert.meta?.changes && contact?.id) {
      await safelyUpsertEventTimelineItemsForContacts(
        env,
        orgId,
        eventRow.id,
        [contact.id],
        'outlook_event_attendee_linked'
      );
    }
  }
}

/**
 * Match a Firefly transcript event to an Outlook calendar event by attendee
 * overlap + start-time window, and reconcile both rows on match.
 *
 * Runs the same matcher whether or not `firefly_event_id` is set — the prior
 * `reconcileFireflyWithoutId` (since renamed) bailed when the id was present,
 * which silently skipped 100% of Phase F backfill events and 100% of webhook
 * events (both always carry firefly_event_id from Fireflies' GraphQL/payload).
 * As a result, every Firefly event landed `pending_reconciliation` and stayed
 * there. This unconditional matcher is the bidirectional reconciliation called
 * out in TRD v2.3 §7.4 that shipped only one direction.
 *
 * Match phases (unchanged from prior helper):
 *   • Phase 1: ±15 min, ≥2 attendee overlap (typical case)
 *   • Phase 2: ±24h, ≥3 attendee overlap, Outlook event updated > 1h after
 *     creation (catches reschedules where the calendar event moved but the
 *     transcript was recorded against the original time)
 *
 * On match: stamp the Outlook row with the transcript pointer + transcript_source,
 * flip both rows to `reconciled`. On no match: leave the Firefly row at
 * `pending_reconciliation`; the existing `promoteToStandalone` daily-cron pass
 * promotes it to `standalone` after 48-72h depending on whether firefly_event_id
 * is set.
 */
export async function reconcileFireflyToOutlook(
  event: {
    id: string;
    firefly_event_id?: string | null;
    start_time: string;
    transcript_r2_key?: string | null;
  },
  orgId: string,
  env: Env
): Promise<boolean> {
  const fireflyAttendees = await env.D1.prepare(
    'SELECT email FROM event_attendees WHERE event_id = ?'
  ).bind(event.id).all<{ email: string }>();
  const fireflyEmails = new Set(
    fireflyAttendees.results.map(a => a.email.toLowerCase())
  );

  // Phase 1: ±15 min, ≥2 attendee overlap
  const windowStart = new Date(
    new Date(event.start_time).getTime() - 15 * 60 * 1000
  ).toISOString();
  const windowEnd = new Date(
    new Date(event.start_time).getTime() + 15 * 60 * 1000
  ).toISOString();

  const candidates = await env.D1.prepare(
    `SELECT e.id FROM events e WHERE e.org_id = ? AND e.source = 'outlook'
       AND e.start_time BETWEEN ? AND ? AND e.deleted_at IS NULL AND e.reconciliation_status = 'reconciled'`
  ).bind(orgId, windowStart, windowEnd).all<{ id: string }>();

  for (const candidate of candidates.results) {
    const outlookAtt = await env.D1.prepare(
      'SELECT email FROM event_attendees WHERE event_id = ?'
    ).bind(candidate.id).all<{ email: string }>();
    const overlap = outlookAtt.results.filter(a =>
      fireflyEmails.has(a.email.toLowerCase())
    ).length;

    if (overlap >= 2) {
      await env.D1.batch([
        env.D1
          .prepare(
            `UPDATE events SET transcript_r2_key = ?, transcript_source = 'firefly', reconciliation_status = 'reconciled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          )
          .bind(event.transcript_r2_key || null, candidate.id),
        env.D1
          .prepare(
            `UPDATE events SET reconciliation_status = 'reconciled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          )
          .bind(event.id),
      ]);
      return true;
    }
  }

  // Phase 2: ±24h, ≥3 attendees, recently updated Outlook event
  const wideStart = new Date(
    new Date(event.start_time).getTime() - 24 * 60 * 60 * 1000
  ).toISOString();
  const wideEnd = new Date(
    new Date(event.start_time).getTime() + 24 * 60 * 60 * 1000
  ).toISOString();
  const oneHourAfterCreate = `strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at, '+1 hour')`;

  const rescheduleCandidates = await env.D1.prepare(
    `SELECT e.id FROM events e WHERE e.org_id = ? AND e.source = 'outlook'
       AND e.start_time BETWEEN ? AND ? AND e.deleted_at IS NULL AND e.reconciliation_status = 'reconciled'
       AND e.updated_at > ${oneHourAfterCreate}`
  ).bind(orgId, wideStart, wideEnd).all<{ id: string }>();

  for (const candidate of rescheduleCandidates.results) {
    const outlookAtt = await env.D1.prepare(
      'SELECT email FROM event_attendees WHERE event_id = ?'
    ).bind(candidate.id).all<{ email: string }>();
    const overlap = outlookAtt.results.filter(a =>
      fireflyEmails.has(a.email.toLowerCase())
    ).length;

    if (overlap >= 3) {
      await env.D1.batch([
        env.D1
          .prepare(
            `UPDATE events SET transcript_r2_key = ?, transcript_source = 'firefly', reconciliation_status = 'reconciled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          )
          .bind(event.transcript_r2_key || null, candidate.id),
        env.D1
          .prepare(
            `UPDATE events SET reconciliation_status = 'reconciled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          )
          .bind(event.id),
      ]);
      return true;
    }
  }

  return false;
}

export async function promoteToStandalone(orgId: string, env: Env): Promise<void> {
  const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
  const threeDaysAgo = new Date(Date.now() - 259200000).toISOString();

  // Firefly WITH ID → standalone after 48h
  await env.D1.prepare(
    `UPDATE events SET reconciliation_status = 'standalone',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND reconciliation_status = 'pending_reconciliation'
       AND source = 'firefly' AND firefly_event_id IS NOT NULL
       AND created_at < ? AND deleted_at IS NULL`
  ).bind(orgId, twoDaysAgo).run();

  // Firefly WITHOUT ID but WITH transcript → standalone after 72h
  await env.D1.prepare(
    `UPDATE events SET reconciliation_status = 'standalone',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND reconciliation_status = 'pending_reconciliation'
       AND source = 'firefly' AND firefly_event_id IS NULL
       AND transcript_r2_key IS NOT NULL
       AND created_at < ? AND deleted_at IS NULL`
  ).bind(orgId, threeDaysAgo).run();
}

export async function flagStaleOrphanedEvents(
  orgId: string,
  env: Env
): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 604800000).toISOString();
  await env.D1.prepare(
    `UPDATE events SET reconciliation_status = 'orphaned',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE org_id = ? AND reconciliation_status = 'pending_reconciliation'
       AND created_at < ? AND deleted_at IS NULL`
  ).bind(orgId, sevenDaysAgo).run();
}

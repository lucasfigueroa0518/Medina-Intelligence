// TRD §7.4 — Event reconciliation (Outlook upsert, Firefly matching, standalone promotion, orphan flagging)
import type { Env } from '../types/env';
import { safelyUpsertEventTimelineItemsForContacts } from './contact-detail-read-model';
import { upsertEventAttendee } from './event-attendees';
import {
  scoreReconciliation,
  type AttendeeRef,
  type FireflyMeeting,
  type OutlookCandidate,
  type ReconcileWeights,
  type ReconciliationDecision,
} from './reconciliation-scoring';

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

  // Always treat the organizer as an attendee, even when Microsoft Graph omits
  // them from attendees[] (which it routinely does for the organizer's own
  // copy of the event). Without this, a 2-person meeting that an internal user
  // organized persists with a single attendee row, so Firefly→Outlook
  // reconciliation sees overlap=1 against the (organizer+guest) transcript and
  // strands the row in pending_reconciliation. upsertEventAttendee dedups on
  // (event_id, lower(email)), so unioning the organizer in is idempotent even
  // when Graph *did* include them. (This is the structural fix for the Tony
  // pending-reconciliation class; existing rows backfill on the next hourly
  // calendarView upsert, which is idempotent via ON CONFLICT.)
  const organizerAddr = event.organizer?.emailAddress.address;
  const attendeesWithOrganizer = [...(event.attendees || [])];
  if (
    organizerAddr &&
    !attendeesWithOrganizer.some(
      a => a.emailAddress.address?.toLowerCase() === organizerAddr.toLowerCase()
    )
  ) {
    attendeesWithOrganizer.push({
      emailAddress: {
        address: organizerAddr,
        name: event.organizer?.emailAddress.name,
      },
      type: 'required',
    });
  }

  for (const att of attendeesWithOrganizer) {
    const isOrganizer =
      organizerAddr?.toLowerCase() === att.emailAddress.address?.toLowerCase();

    const contact = await env.D1.prepare(
      'SELECT id FROM contacts WHERE email = ? AND org_id = ? AND deleted_at IS NULL'
    ).bind(att.emailAddress.address, orgId).first<{ id: string }>();

    const user = await env.D1.prepare(
      'SELECT id FROM users WHERE email = ? AND org_id = ?'
    ).bind(att.emailAddress.address, orgId).first<{ id: string }>();

    const attendeeWrite = await upsertEventAttendee(env, {
      eventId: eventRow.id,
      contactId: contact?.id || null,
      userId: user?.id || null,
      email: att.emailAddress.address,
      displayName: att.emailAddress.name || null,
      role: isOrganizer ? 'organizer' : att.type === 'optional' ? 'optional' : 'attendee',
      isInternal: !!user,
    });
    if (attendeeWrite.inserted && contact?.id) {
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

// How far on either side of the Firefly recording start we pull Outlook
// candidates. The scorer applies time-decay inside this window and excludes
// anything past its own maxDeltaMinutes; ±24h is the outer bound so reschedules
// (calendar moved, transcript recorded against the original slot) are reachable.
const CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface FireflyEventRow {
  id: string;
  title: string;
  start_time: string;
  transcript_r2_key: string | null;
}

async function loadAttendeeRefs(
  eventId: string,
  env: Env
): Promise<AttendeeRef[]> {
  const rows = await env.D1.prepare(
    `SELECT email, user_id, is_internal FROM event_attendees WHERE event_id = ?`
  ).bind(eventId).all<{ email: string; user_id: string | null; is_internal: number | null }>();
  return rows.results.map(r => ({
    email: r.email,
    // An attendee is internal when it resolved to an org user (user_id) — the
    // is_internal flag is a denormalised mirror of the same fact.
    isInternal: !!r.user_id || Number(r.is_internal || 0) === 1,
  }));
}

/**
 * Gather the Firefly meeting and its scoreable Outlook candidates from D1.
 * Pure-data output so `scoreReconciliation` can decide without further I/O and
 * the dry-run diagnostic can reuse the exact same candidate set.
 */
export async function gatherReconciliationInputs(
  eventId: string,
  orgId: string,
  env: Env
): Promise<{ firefly: FireflyMeeting; candidates: OutlookCandidate[] } | null> {
  const fireflyRow = await env.D1.prepare(
    `SELECT id, title, start_time, transcript_r2_key
       FROM events
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(eventId, orgId).first<FireflyEventRow>();
  if (!fireflyRow) return null;

  const fireflyAttendees = await loadAttendeeRefs(fireflyRow.id, env);

  const windowStart = new Date(
    new Date(fireflyRow.start_time).getTime() - CANDIDATE_WINDOW_MS
  ).toISOString();
  const windowEnd = new Date(
    new Date(fireflyRow.start_time).getTime() + CANDIDATE_WINDOW_MS
  ).toISOString();

  const candidateRows = await env.D1.prepare(
    `SELECT id, title, start_time, created_at, updated_at, transcript_r2_key
       FROM events
      WHERE org_id = ? AND source = 'outlook'
        AND start_time BETWEEN ? AND ?
        AND deleted_at IS NULL`
  ).bind(orgId, windowStart, windowEnd).all<{
    id: string;
    title: string;
    start_time: string;
    created_at: string | null;
    updated_at: string | null;
    transcript_r2_key: string | null;
  }>();

  const candidates: OutlookCandidate[] = [];
  for (const row of candidateRows.results) {
    candidates.push({
      id: row.id,
      startTime: row.start_time,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      attendees: await loadAttendeeRefs(row.id, env),
      existingTranscriptR2Key: row.transcript_r2_key,
    });
  }

  return {
    firefly: {
      id: fireflyRow.id,
      startTime: fireflyRow.start_time,
      title: fireflyRow.title,
      transcriptR2Key: fireflyRow.transcript_r2_key,
      attendees: fireflyAttendees,
    },
    candidates,
  };
}

export interface ReconcileOptions {
  /** Score + explain only; never mutate. Powers the dry-run diagnostic. */
  dryRun?: boolean;
  weights?: Partial<ReconcileWeights>;
}

export interface ReconcileResult extends ReconciliationDecision {
  /** True only when this call mutated rows (matched + !dryRun + new attach). */
  applied: boolean;
}

/**
 * Match a transcript-bearing Firefly event to its Outlook calendar event by
 * scored evidence — time proximity, external/internal attendee overlap, title
 * similarity — and, on a confident *unambiguous* match, stamp the transcript
 * onto the Outlook row and flip both rows to `reconciled`.
 *
 * Replaces the prior phased thresholds (±15min/≥2, ±24h/≥3, first-match-wins),
 * which stranded legitimate matches (organizer dropped from Outlook attendees,
 * recording-start drift, single-external-attendee meetings, duplicate Outlook
 * rows). See reconciliation-scoring.ts for the model and the invariant.
 *
 * Safety properties:
 *   • Never attaches ambiguously — two distinct candidate meetings within the
 *     score margin leave the row `pending_reconciliation` with a diagnostic.
 *   • Never steals — a candidate already holding a different transcript is
 *     ineligible.
 *   • Idempotent — a candidate already holding *this* transcript returns
 *     `already_reconciled` and writes nothing.
 *   • dryRun returns the full decision (per-candidate scores + reasons) and
 *     mutates nothing.
 *
 * On no/ambiguous match the row stays `pending_reconciliation`; the existing
 * `promoteToStandalone` daily cron promotes long-pending rows to `standalone`.
 */
export async function reconcileFireflyToOutlook(
  event: {
    id: string;
    firefly_event_id?: string | null;
    start_time: string;
    transcript_r2_key?: string | null;
  },
  orgId: string,
  env: Env,
  opts: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const gathered = await gatherReconciliationInputs(event.id, orgId, env);
  if (!gathered) {
    return {
      outcome: 'no_candidates',
      chosenCandidateId: null,
      confidence: null,
      margin: null,
      scored: [],
      logicalGroups: [],
      explanation: `firefly event ${event.id} not found for org ${orgId}`,
      applied: false,
    };
  }

  if (!gathered.firefly.transcriptR2Key) {
    return {
      outcome: 'no_match',
      chosenCandidateId: null,
      confidence: null,
      margin: null,
      scored: [],
      logicalGroups: [],
      explanation: `firefly event ${event.id} has no transcript_r2_key; refusing calendar attachment`,
      applied: false,
    };
  }

  const decision = scoreReconciliation(gathered.firefly, gathered.candidates, opts.weights);

  if (opts.dryRun || decision.outcome !== 'matched' || !decision.chosenCandidateId) {
    if (!opts.dryRun && decision.outcome === 'already_reconciled') {
      await env.D1.prepare(
        `UPDATE events
            SET reconciliation_status = 'reconciled',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND reconciliation_status != 'reconciled'`
      ).bind(event.id).run();
      return { ...decision, applied: true };
    }
    return { ...decision, applied: false };
  }

  await env.D1.batch([
    env.D1
      .prepare(
        `UPDATE events
            SET transcript_r2_key = ?, transcript_source = 'firefly',
                reconciliation_status = 'reconciled',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .bind(gathered.firefly.transcriptR2Key, decision.chosenCandidateId),
    env.D1
      .prepare(
        `UPDATE events
            SET reconciliation_status = 'reconciled',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`
      )
      .bind(event.id),
  ]);

  return { ...decision, applied: true };
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

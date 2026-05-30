import type { Env } from '../types/env';

export type EventAttendeeRole = 'organizer' | 'presenter' | 'attendee' | 'optional';

export interface EventAttendeeInput {
  eventId: string;
  contactId?: string | null;
  userId?: string | null;
  email: string;
  displayName?: string | null;
  role?: EventAttendeeRole | string | null;
  isInternal?: boolean | number | null;
}

export interface EventAttendeeRow {
  id: string;
  event_id: string;
  contact_id: string | null;
  user_id: string | null;
  email: string;
  display_name: string | null;
  role: EventAttendeeRole | string | null;
  is_internal: number | null;
  created_at: string | null;
}

const ROLE_PRIORITY: Record<EventAttendeeRole, number> = {
  organizer: 4,
  presenter: 3,
  attendee: 2,
  optional: 1,
};

export function normalizeAttendeeEmail(email: string | null | undefined): string {
  return String(email || '').trim().toLowerCase();
}

export function normalizeAttendeeRole(role: string | null | undefined): EventAttendeeRole {
  if (role === 'organizer' || role === 'presenter' || role === 'optional') return role;
  return 'attendee';
}

function roleScore(role: string | null | undefined): number {
  return ROLE_PRIORITY[normalizeAttendeeRole(role)] || ROLE_PRIORITY.attendee;
}

function hasText(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

export function chooseCanonicalAttendee(rows: EventAttendeeRow[]): EventAttendeeRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const userDelta = Number(!!b.user_id) - Number(!!a.user_id);
    if (userDelta) return userDelta;
    const contactDelta = Number(!!b.contact_id) - Number(!!a.contact_id);
    if (contactDelta) return contactDelta;
    const roleDelta = roleScore(b.role) - roleScore(a.role);
    if (roleDelta) return roleDelta;
    const internalDelta = Number(!!b.is_internal) - Number(!!a.is_internal);
    if (internalDelta) return internalDelta;
    const aCreated = Date.parse(a.created_at || '') || 0;
    const bCreated = Date.parse(b.created_at || '') || 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id.localeCompare(b.id);
  })[0];
}

export function mergeAttendeeRows(rows: EventAttendeeRow[], canonical: EventAttendeeRow): EventAttendeeRow {
  const withUser = rows.find(r => hasText(r.user_id));
  const withContact = rows.find(r => hasText(r.contact_id));
  const withDisplay = rows.find(r => hasText(r.display_name));
  const strongestRole = [...rows].sort((a, b) => roleScore(b.role) - roleScore(a.role))[0]?.role;

  return {
    ...canonical,
    contact_id: canonical.contact_id || withContact?.contact_id || null,
    user_id: canonical.user_id || withUser?.user_id || null,
    email: normalizeAttendeeEmail(canonical.email),
    display_name: canonical.display_name || withDisplay?.display_name || null,
    role: normalizeAttendeeRole(strongestRole || canonical.role),
    is_internal: rows.some(r => Number(r.is_internal || 0) === 1) ? 1 : 0,
  };
}

export async function upsertEventAttendee(
  env: Env,
  input: EventAttendeeInput
): Promise<{ id: string | null; inserted: boolean; updated: boolean; skipped?: string }> {
  const email = normalizeAttendeeEmail(input.email);
  if (!email) return { id: null, inserted: false, updated: false, skipped: 'missing_email' };

  const existing = await env.D1.prepare(
    `SELECT *
       FROM event_attendees
      WHERE event_id = ? AND lower(trim(email)) = ?
      ORDER BY
        CASE WHEN user_id IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN contact_id IS NOT NULL THEN 0 ELSE 1 END,
        CASE role WHEN 'organizer' THEN 0 WHEN 'presenter' THEN 1 WHEN 'attendee' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 1`
  ).bind(input.eventId, email).first<EventAttendeeRow>();

  const role = normalizeAttendeeRole(input.role);
  const isInternal = input.isInternal ? 1 : 0;

  if (existing) {
    const merged = mergeAttendeeRows([
      existing,
      {
        id: existing.id,
        event_id: input.eventId,
        contact_id: input.contactId || null,
        user_id: input.userId || null,
        email,
        display_name: input.displayName || null,
        role,
        is_internal: isInternal,
        created_at: existing.created_at,
      },
    ], existing);

    await env.D1.prepare(
      `UPDATE event_attendees
          SET contact_id = ?,
              user_id = ?,
              email = ?,
              display_name = ?,
              role = ?,
              is_internal = ?
        WHERE id = ?`
    ).bind(
      merged.contact_id,
      merged.user_id,
      merged.email,
      merged.display_name,
      merged.role,
      merged.is_internal,
      existing.id
    ).run();

    return { id: existing.id, inserted: false, updated: true };
  }

  try {
    const id = crypto.randomUUID();
    await env.D1.prepare(
      `INSERT INTO event_attendees
         (id, event_id, contact_id, user_id, email, display_name, role, is_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      input.eventId,
      input.contactId || null,
      input.userId || null,
      email,
      input.displayName || null,
      role,
      isInternal
    ).run();
    return { id, inserted: true, updated: false };
  } catch (e: any) {
    if (!String(e?.message || e).toLowerCase().includes('unique')) throw e;
    const raced = await env.D1.prepare(
      `SELECT id FROM event_attendees WHERE event_id = ? AND lower(trim(email)) = ? LIMIT 1`
    ).bind(input.eventId, email).first<{ id: string }>();
    if (!raced?.id) throw e;
    return { id: raced.id, inserted: false, updated: false };
  }
}

export const __eventAttendeesTestHooks = {
  ROLE_PRIORITY,
  chooseCanonicalAttendee,
  mergeAttendeeRows,
  normalizeAttendeeEmail,
  normalizeAttendeeRole,
};

// Shared Firefly intelligence pipeline — used by both the webhook path and
// the historical backfill so both paths produce identical CRM side effects.
//
// Two surfaces:
//   1. autoCreateContactFromAttendee — turn a meeting attendee into a real
//      contact row when none exists. Mirrors what discoverNewContact does for
//      emails, but adapted for Firefly's attendee shape (display name often
//      arrives as the email local-part, not a real human name).
//   2. extractAndRouteSignals — load transcript from R2, extract structured
//      signals via Claude, route them through the approval queue, generate +
//      distribute the meeting summary, stamp signals_extracted_at.

import type { Env } from '../types/env';
import { extractTranscriptSignals, generateMeetingSummary } from './transcript-extraction';
import { routeTranscriptSignals, distributeMeetingSummary } from './signal-router';
import {
  isAutomatedEmail,
  findOrCreateCompanyByDomain,
  PERSONAL_DOMAINS,
} from './discovery';
import { isValidContactName, toTitleCase } from './name-quality';
import { safelyMaintainContactReadModels } from './contact-maintenance';

export interface AutoContactResult {
  contactId: string;
  created: boolean;
  companyId: string | null;
}

// Firefly often hands us the email local-part as the displayName ("patrick.dyer",
// "tony"). isValidContactName rejects all-lowercase single-token strings, so we
// pre-normalize: split on dots/underscores/hyphens, title-case each piece,
// rejoin with space. "patrick.dyer" → "Patrick Dyer", "tony" → "Tony".
export function normalizeAttendeeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.length < 2) return null;

  // If it has spaces and any uppercase, trust it — already a real name shape.
  if (/\s/.test(s) && /[A-Z]/.test(s)) {
    const candidate = toTitleCase(s);
    return isValidContactName(candidate) ? candidate : null;
  }

  // email-local-part shape: split on common separators
  if (/[._-]/.test(s) && !/\s/.test(s)) {
    const parts = s.split(/[._-]+/).filter(p => p.length > 0);
    if (parts.length >= 2) {
      const candidate = toTitleCase(parts.join(' '));
      if (isValidContactName(candidate)) return candidate;
    }
  }

  // Single lowercase token — title-case it. isValidContactName will accept
  // a capitalized single-word name in our context (≥3 chars, no digit run).
  const cap = toTitleCase(s);
  // Single-word names below 3 chars almost always indicate truncation/junk
  if (!cap.includes(' ') && cap.length < 3) return null;
  // Title-cased single token like "Tony" passes the all-lowercase guard.
  if (isValidContactName(cap)) return cap;
  return null;
}

export async function autoCreateContactFromAttendee(args: {
  email: string;
  displayName: string | null | undefined;
  orgId: string;
  env: Env;
}): Promise<AutoContactResult | null> {
  const { email, displayName, orgId, env } = args;

  const normalized = email.toLowerCase().trim();
  if (!normalized || !normalized.includes('@')) return null;

  const spam = isAutomatedEmail(normalized);
  if (spam.blocked) {
    console.log(`[firefly-intel] skip auto-create ${normalized}: ${spam.reason}`);
    return null;
  }

  // Existing contact?
  const existing = await env.D1.prepare(
    'SELECT id, company_id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, normalized).first<{ id: string; company_id: string | null }>();
  if (existing) {
    return { contactId: existing.id, created: false, companyId: existing.company_id };
  }

  const cleanName = normalizeAttendeeName(displayName);
  if (!cleanName) {
    console.log(`[firefly-intel] skip auto-create ${normalized}: unusable displayName=${JSON.stringify(displayName)}`);
    return null;
  }

  const domain = normalized.split('@')[1];
  let companyId: string | null = null;
  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    try {
      companyId = await findOrCreateCompanyByDomain(domain, orgId, env);
    } catch (e) {
      console.error(`[firefly-intel] company link failed for ${domain}:`, e);
    }
  }

  const contactId = crypto.randomUUID();
  const result = await env.D1.prepare(
    `INSERT OR IGNORE INTO contacts
       (id, org_id, full_name, email, company_id, source, source_confidence, contact_type, total_interactions)
     VALUES (?, ?, ?, ?, ?, 'firefly', 0.7, 'individual', 0)`
  ).bind(contactId, orgId, cleanName, normalized, companyId).run();

  if (!result.meta?.changes) {
    // Race: someone created the contact between our SELECT and INSERT.
    const raced = await env.D1.prepare(
      'SELECT id, company_id FROM contacts WHERE org_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(orgId, normalized).first<{ id: string; company_id: string | null }>();
    if (raced) return { contactId: raced.id, created: false, companyId: raced.company_id };
    return null;
  }

  console.log(`[firefly-intel] auto-created contact ${cleanName} <${normalized}> id=${contactId} company=${companyId || 'none'}`);
  await safelyMaintainContactReadModels(env, orgId, contactId, 'firefly_contact_created');
  return { contactId, created: true, companyId };
}

export interface ExtractionOutcome {
  event_id: string;
  contact_signals: number;
  company_signals: number;
  deal_signals: number;
  relationship_signals: number;
  contacts_routed: number;
  companies_routed: number;
  deals_routed: number;
  relationships_routed: number;
  new_companies_flagged: string[];
  summary_distributed_to: number;
  summary_excerpt: string;
}

// Loads the transcript, runs Claude extraction, routes signals to approval
// queue / direct apply, generates a summary, distributes it, and stamps
// signals_extracted_at. Idempotent: skips events that already have a stamp.
export async function extractAndRouteSignals(
  eventId: string,
  orgId: string,
  env: Env
): Promise<ExtractionOutcome | null> {
  const event = await env.D1.prepare(
    `SELECT id, title, start_time, transcript_r2_key
       FROM events
      WHERE id = ? AND org_id = ?
        AND transcript_r2_key IS NOT NULL
        AND signals_extracted_at IS NULL
        AND deleted_at IS NULL`
  ).bind(eventId, orgId).first<{
    id: string; title: string; start_time: string; transcript_r2_key: string;
  }>();
  if (!event) return null;

  const obj = await env.R2.get(event.transcript_r2_key);
  if (!obj) {
    console.warn(`[firefly-intel] event=${eventId}: transcript R2 object missing`);
    return null;
  }
  const transcriptText = await obj.text();
  if (transcriptText.length < 100) return null;

  const attendees = await env.D1.prepare(
    `SELECT display_name as name, email FROM event_attendees WHERE event_id = ?`
  ).bind(event.id).all<{ name: string; email: string | null }>();
  const participants = attendees.results.map(a => ({
    name: a.name,
    email: a.email || undefined,
  }));

  const signals = await extractTranscriptSignals(
    transcriptText, event.title, participants, orgId, env
  );

  let routed = {
    contact_signals_routed: 0,
    company_signals_routed: 0,
    deal_signals_routed: 0,
    relationship_signals_routed: 0,
    new_companies_flagged: [] as string[],
  };
  const totalSignals =
    signals.contact_signals.length +
    signals.company_signals.length +
    signals.deal_signals.length +
    signals.relationship_signals.length;

  if (totalSignals > 0) {
    routed = await routeTranscriptSignals(signals, event.id, orgId, env);
  }

  let summary = '';
  let distributedTo = 0;
  try {
    summary = await generateMeetingSummary(
      transcriptText, event.title, event.start_time, participants, orgId, env
    );
    if (summary) {
      distributedTo = await distributeMeetingSummary(
        summary, event.id, event.title, event.start_time, orgId, env
      );
      await env.D1.prepare(
        `UPDATE events SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(summary.substring(0, 2000), event.id).run();
    }
  } catch (e) {
    console.error(`[firefly-intel] summary generation failed for event=${eventId}:`, e);
  }

  await env.D1.prepare(
    `UPDATE events SET signals_extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).bind(event.id).run();

  return {
    event_id: event.id,
    contact_signals: signals.contact_signals.length,
    company_signals: signals.company_signals.length,
    deal_signals: signals.deal_signals.length,
    relationship_signals: signals.relationship_signals.length,
    contacts_routed: routed.contact_signals_routed,
    companies_routed: routed.company_signals_routed,
    deals_routed: routed.deal_signals_routed,
    relationships_routed: routed.relationship_signals_routed,
    new_companies_flagged: routed.new_companies_flagged,
    summary_distributed_to: distributedTo,
    summary_excerpt: summary.slice(0, 300),
  };
}

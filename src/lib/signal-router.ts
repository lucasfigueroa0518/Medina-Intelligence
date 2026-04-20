import type { Env } from '../types/env';
import type { TranscriptSignals, ContactSignal, CompanySignal, DealSignal, RelationshipSignal } from './transcript-extraction';
import { hashShort, getCurrentSyncJobId } from './helpers';

interface RoutedSignalResult {
  contact_signals_routed: number;
  company_signals_routed: number;
  deal_signals_routed: number;
  relationship_signals_routed: number;
  new_companies_flagged: string[];
}

async function resolveContactByName(
  name: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const row = await env.D1.prepare(
    'SELECT id FROM contacts WHERE org_id = ? AND LOWER(full_name) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, name).first<{ id: string }>();
  return row?.id ?? null;
}

async function resolveContactByEmail(
  email: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const row = await env.D1.prepare(
    'SELECT id FROM contacts WHERE org_id = ? AND LOWER(email) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, email).first<{ id: string }>();
  return row?.id ?? null;
}

async function resolveCompanyByName(
  name: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const row = await env.D1.prepare(
    'SELECT id FROM companies WHERE org_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1'
  ).bind(orgId, name).first<{ id: string }>();
  return row?.id ?? null;
}

async function resolveSpeakerToContact(
  speaker: string,
  eventId: string,
  orgId: string,
  env: Env
): Promise<string | null> {
  const attendee = await env.D1.prepare(
    `SELECT ea.contact_id FROM event_attendees ea
     WHERE ea.event_id = ? AND LOWER(ea.display_name) = LOWER(?) AND ea.contact_id IS NOT NULL
     LIMIT 1`
  ).bind(eventId, speaker).first<{ contact_id: string }>();
  if (attendee?.contact_id) return attendee.contact_id;

  return resolveContactByName(speaker, orgId, env);
}

async function stageSignalInApprovalQueue(
  orgId: string,
  entityType: 'contact' | 'company',
  entityId: string,
  field: string,
  value: unknown,
  confidence: number,
  sourceEventId: string,
  env: Env
): Promise<void> {
  const syncJobId = await getCurrentSyncJobId(orgId, 'enrichment', env).catch(() => 'transcript');
  const idempotencyKey = `${orgId}:${entityId}:${field}:${hashShort(JSON.stringify(value))}:${syncJobId}`;

  await env.D1.prepare(
    `INSERT OR IGNORE INTO approval_queue
       (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
        proposed_value, source_communication_id, source_visibility, confidence, status)
     VALUES (?, ?, ?, ?, 'transcript_extraction', ?, ?, ?, 'org_wide', ?, 'pending')`
  ).bind(
    idempotencyKey,
    orgId,
    entityType,
    entityId,
    field,
    JSON.stringify(value),
    sourceEventId,
    confidence
  ).run();
}

const DIRECT_APPLY_FIELDS = new Set([
  'communication_channel_preference',
  'location',
  'investment_focus',
  'check_size_range',
]);

async function routeContactSignal(
  signal: ContactSignal,
  eventId: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  const contactId = await resolveSpeakerToContact(signal.entity_identifier, eventId, orgId, env)
    || await resolveContactByName(signal.entity_identifier, orgId, env);

  if (!contactId) return false;

  if (signal.field === 'follow_up_commitment' || signal.field === 'personal_update') {
    await stageSignalInApprovalQueue(orgId, 'contact', contactId, signal.field, signal.value, signal.confidence, eventId, env);
    return true;
  }

  if (DIRECT_APPLY_FIELDS.has(signal.field)) {
    const existing = await env.D1.prepare(
      `SELECT ${signal.field} as v FROM contacts WHERE id = ?`
    ).bind(contactId).first<{ v: string | null }>().catch(() => null);

    if (!existing?.v) {
      await env.D1.prepare(
        `UPDATE contacts SET ${signal.field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).bind(signal.value, contactId).run();
      return true;
    }
  }

  await stageSignalInApprovalQueue(orgId, 'contact', contactId, signal.field, signal.value, signal.confidence, eventId, env);
  return true;
}

async function routeCompanySignal(
  signal: CompanySignal,
  eventId: string,
  orgId: string,
  env: Env,
  newCompanies: Set<string>
): Promise<boolean> {
  const companyId = await resolveCompanyByName(signal.company_name, orgId, env);

  if (!companyId) {
    newCompanies.add(signal.company_name);
    return false;
  }

  await stageSignalInApprovalQueue(orgId, 'company', companyId, signal.signal_type, signal.value, signal.confidence, eventId, env);
  return true;
}

async function routeDealSignal(
  signal: DealSignal,
  eventId: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  const companyId = await resolveCompanyByName(signal.company_name, orgId, env);
  if (!companyId) return false;

  const deal = await env.D1.prepare(
    `SELECT id FROM deals WHERE company_id = ? AND org_id = ? AND deleted_at IS NULL
     AND stage NOT IN ('closed_won', 'closed_lost')
     ORDER BY updated_at DESC LIMIT 1`
  ).bind(companyId, orgId).first<{ id: string }>();

  if (deal) {
    await stageSignalInApprovalQueue(orgId, 'company', deal.id, `deal_${signal.signal_type}`, signal.value, signal.confidence, eventId, env);
  } else {
    await stageSignalInApprovalQueue(orgId, 'company', companyId, `deal_${signal.signal_type}`, signal.value, signal.confidence, eventId, env);
  }
  return true;
}

async function routeRelationshipSignal(
  signal: RelationshipSignal,
  eventId: string,
  orgId: string,
  env: Env
): Promise<boolean> {
  if (!signal.people_involved?.length) return false;

  const mainPerson = signal.people_involved[0];
  const contactId = await resolveSpeakerToContact(mainPerson, eventId, orgId, env)
    || await resolveContactByName(mainPerson, orgId, env);

  if (!contactId) return false;

  await stageSignalInApprovalQueue(
    orgId, 'contact', contactId,
    `relationship_${signal.signal_type}`,
    { ...signal, people: signal.people_involved },
    signal.confidence,
    eventId,
    env
  );
  return true;
}

export async function routeTranscriptSignals(
  signals: TranscriptSignals,
  eventId: string,
  orgId: string,
  env: Env
): Promise<RoutedSignalResult> {
  const newCompanies = new Set<string>();
  let contactRouted = 0;
  let companyRouted = 0;
  let dealRouted = 0;
  let relRouted = 0;

  for (const s of signals.contact_signals) {
    try {
      if (await routeContactSignal(s, eventId, orgId, env)) contactRouted++;
    } catch (e) {
      console.error(`[signal-router] contact signal failed:`, e);
    }
  }

  for (const s of signals.company_signals) {
    try {
      if (await routeCompanySignal(s, eventId, orgId, env, newCompanies)) companyRouted++;
    } catch (e) {
      console.error(`[signal-router] company signal failed:`, e);
    }
  }

  for (const s of signals.deal_signals) {
    try {
      if (await routeDealSignal(s, eventId, orgId, env)) dealRouted++;
    } catch (e) {
      console.error(`[signal-router] deal signal failed:`, e);
    }
  }

  for (const s of signals.relationship_signals) {
    try {
      if (await routeRelationshipSignal(s, eventId, orgId, env)) relRouted++;
    } catch (e) {
      console.error(`[signal-router] relationship signal failed:`, e);
    }
  }

  if (newCompanies.size > 0) {
    for (const name of newCompanies) {
      const idempotencyKey = `${orgId}:new_company_flag:${hashShort(name)}`;
      await env.D1.prepare(
        `INSERT OR IGNORE INTO approval_queue
           (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
            proposed_value, source_communication_id, source_visibility, confidence, status)
         VALUES (?, ?, 'company', '', 'new_entity', 'company_name', ?, ?, 'org_wide', 0.75, 'pending')`
      ).bind(idempotencyKey, orgId, JSON.stringify(name), eventId).run();
    }
  }

  return {
    contact_signals_routed: contactRouted,
    company_signals_routed: companyRouted,
    deal_signals_routed: dealRouted,
    relationship_signals_routed: relRouted,
    new_companies_flagged: [...newCompanies],
  };
}

export async function distributeMeetingSummary(
  summary: string,
  eventId: string,
  meetingTitle: string,
  startTime: string,
  orgId: string,
  env: Env
): Promise<number> {
  const attendees = await env.D1.prepare(
    `SELECT DISTINCT contact_id FROM event_attendees
     WHERE event_id = ? AND contact_id IS NOT NULL`
  ).bind(eventId).all<{ contact_id: string }>();

  let distributed = 0;
  const r2Key = `${orgId}/transcript/summaries/${eventId}.txt`;
  await env.R2.put(r2Key, summary);

  for (const att of attendees.results) {
    const convId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.D1.prepare(
      `INSERT OR IGNORE INTO conversations
         (id, org_id, source, subject, body_r2_key, body_preview, direction, sent_at,
          from_email, to_emails, participant_user_ids, is_campaign_email, visibility, created_at, updated_at)
       VALUES (?, ?, 'firefly', ?, ?, ?, 'internal', ?, 'meeting-summary@firefly', '', '[]', 0, 'org_wide', ?, ?)`
    ).bind(
      convId, orgId,
      `Meeting Summary: ${meetingTitle}`,
      r2Key,
      summary.substring(0, 500),
      startTime,
      now, now
    ).run();

    await env.D1.prepare(
      `INSERT OR IGNORE INTO conversation_contacts (conversation_id, contact_id) VALUES (?, ?)`
    ).bind(convId, att.contact_id).run();

    distributed++;
  }

  const companyIds = await env.D1.prepare(
    `SELECT DISTINCT c.company_id FROM contacts c
     JOIN event_attendees ea ON ea.contact_id = c.id
     WHERE ea.event_id = ? AND c.company_id IS NOT NULL AND c.deleted_at IS NULL`
  ).bind(eventId).all<{ company_id: string }>();

  for (const row of companyIds.results) {
    await env.D1.prepare(
      `UPDATE companies SET last_news_summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND org_id = ?`
    ).bind(`[Meeting: ${meetingTitle}] ${summary.substring(0, 300)}`, row.company_id, orgId).run();
  }

  return distributed;
}

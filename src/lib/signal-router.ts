import type { Env } from '../types/env';
import type { ChunkMetadata } from '../types/interfaces';
import type { TranscriptSignals, ContactSignal, CompanySignal, DealSignal, RelationshipSignal } from './transcript-extraction';
import { hashShort } from './helpers';
import { chunkEmbedAndPersistAll } from './embedding';
import { recordSyntheticObservation } from './synthetic-observations';
import { safelyUpsertConversationTimelineItemsForContacts } from './contact-detail-read-model';

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
  // Widened 2026-04-30 to include 'deal' for routeDealSignal. Previously
  // deal-related rows were staged with entity_type='company', entity_id=deal.id
  // — internally inconsistent (the type said "company row" but the id was a
  // deal). Approval-queue consumers that dispatch on entity_type couldn't
  // route correctly. Matches deal-detection.ts's convention.
  entityType: 'contact' | 'company' | 'deal',
  entityId: string,
  field: string,
  value: unknown,
  confidence: number,
  sourceEventId: string,
  env: Env
): Promise<void> {
  // Idempotency key intentionally omits any per-cycle component (sync_job id,
  // timestamp). Same proposal across cycles must collapse, not pile up.
  const idempotencyKey = `${orgId}:${entityId}:${field}:${hashShort(JSON.stringify(value))}`;

  // Wave 6 payload contract: { value, metadata: { source_type,
  // source_description, context } }. Transcript signals don't have a
  // single observing user — meetings have multiple attendees, but the
  // mention itself is one observation regardless. resolveChannel maps
  // 'transcript_mention' to a single channel without observer
  // attribution.
  const proposedValue = JSON.stringify({
    value,
    metadata: {
      source_type: 'transcript_mention',
      source_description: 'Meeting transcript mention',
      context: { conversationId: sourceEventId },
    },
  });

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
    proposedValue,
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
    // Q12 — synthetic observation. Lands in synthetic_observations
    // (append-with-merge), not approval_queue. Channel:
    // 'transcript_mention' (resolved by source-channels.ts).
    await recordSyntheticObservation({
      orgId,
      entityType: 'contact',
      entityId: contactId,
      observationType: signal.field,
      observationValue: typeof signal.value === 'string' ? signal.value : JSON.stringify(signal.value),
      source: 'transcript_mention',
      context: { conversationId: eventId },
      confidence: signal.confidence,
      sourceCommunicationId: eventId,
    }, env);
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
     AND stage NOT IN ('closed', 'closed_won', 'closed_lost')
     ORDER BY updated_at DESC LIMIT 1`
  ).bind(companyId, orgId).first<{ id: string }>();

  if (deal) {
    // Deal exists → stage as a deal-typed proposal so approval-queue dispatch
    // can route correctly. Pre-fix used 'company' here with entity_id=deal.id
    // (internally inconsistent).
    await stageSignalInApprovalQueue(orgId, 'deal', deal.id, `deal_${signal.signal_type}`, signal.value, signal.confidence, eventId, env);
  } else {
    // No deal exists yet — signal still applies to the company. Keep as
    // company-typed; consumers can choose to escalate to a create_deal
    // proposal later if confidence + corroboration warrant it.
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

  // Q12 — relationship_* signals are observation-class. Land them in
  // synthetic_observations instead of approval_queue. observationValue
  // serializes the structured signal so the UI can render the
  // people_involved + signal_type detail back out.
  const obsType = `relationship_${signal.signal_type}`;
  await recordSyntheticObservation({
    orgId,
    entityType: 'contact',
    entityId: contactId,
    observationType: obsType,
    observationValue: JSON.stringify({ ...signal, people: signal.people_involved }),
    source: 'transcript_mention',
    context: { conversationId: eventId },
    confidence: signal.confidence,
    sourceCommunicationId: eventId,
  }, env);
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
      // Wave 6 payload contract — new_entity is a creation proposal,
      // not a field overwrite. metadata.context still attributes to the
      // transcript channel for the corroboration model (a company
      // mentioned in 2+ different meetings has 2 transcript_mention
      // observations, but TRANSCRIPT_MENTION is a single channel — so
      // it counts as 1 corroborating channel).
      const proposedValue = JSON.stringify({
        value: name,
        metadata: {
          source_type: 'transcript_mention',
          source_description: 'New company mentioned in meeting transcript',
          context: { conversationId: eventId },
        },
      });
      await env.D1.prepare(
        `INSERT OR IGNORE INTO approval_queue
           (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
            proposed_value, source_communication_id, source_visibility, confidence, status)
         VALUES (?, ?, 'company', '', 'new_entity', 'company_name', ?, ?, 'org_wide', 0.75, 'pending')`
      ).bind(idempotencyKey, orgId, proposedValue, eventId).run();
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

    // conversations.source CHECK accepts outlook/slack/manual (not firefly);
    // tag as 'manual' and rely on from_email='meeting-summary@firefly' for
    // origin attribution. The conversations table also has no `visibility`
    // column despite earlier code referencing one — leave it out.
    await env.D1.prepare(
      `INSERT OR IGNORE INTO conversations
         (id, org_id, source, subject, body_r2_key, body_preview, direction, sent_at,
          from_email, to_emails, participant_user_ids, is_campaign_email, created_at, updated_at)
       VALUES (?, ?, 'manual', ?, ?, ?, 'internal', ?, 'meeting-summary@firefly', '', '[]', 0, ?, ?)`
    ).bind(
      convId, orgId,
      `Meeting Summary: ${meetingTitle}`,
      r2Key,
      summary.substring(0, 500),
      startTime,
      now, now
    ).run();

    const linkInsert = await env.D1.prepare(
      `INSERT OR IGNORE INTO conversation_contacts (conversation_id, contact_id) VALUES (?, ?)`
    ).bind(convId, att.contact_id).run();
    if (linkInsert.meta?.changes) {
      await safelyUpsertConversationTimelineItemsForContacts(
        env,
        orgId,
        convId,
        [att.contact_id],
        'signal_router_conversation_linked'
      );
    }

    try {
      const meta: ChunkMetadata = {
        org_id: orgId,
        visibility: 'org_wide',
        document_type: 'transcript',
        source_table: 'conversations',
        source_id: convId,
        r2_key: r2Key,
        created_at: now,
        primary_entity_id: att.contact_id,
        entity_name: meetingTitle,
        date: startTime,
      };
      const entries = await chunkEmbedAndPersistAll(summary, meta, env);
      if (entries.length > 0) {
        await env.D1.batch(
          entries.map(e =>
            env.D1.prepare(
              'INSERT OR IGNORE INTO vector_entity_index (vector_id, entity_id, source_table, org_id) VALUES (?,?,?,?)'
            ).bind(e.vectorId, e.entityId, e.sourceTable, e.orgId)
          )
        );
      }
    } catch (e) {
      console.error(`[signal-router] embed failed for meeting summary conv=${convId}:`, e);
    }

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

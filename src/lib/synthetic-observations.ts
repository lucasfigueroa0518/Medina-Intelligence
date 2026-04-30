// Q12 — synthetic observations.
//
// Observation-class proposals (personal_update, follow_up_commitment,
// relationship_*, product_update, partnership) have a fundamentally
// different shape from field overwrites:
//   • No existing canonical entity field to corroborate against.
//   • 1-channel observation is valuable on first sighting (SHOW, not
//     HOLD per locked Wave 6 spec). Multi-channel STRENGTHENS metadata
//     (channels[] grows, last_observed_at advances), not gates surface.
//   • Lifecycle: discoverable until dismissed by a user.
//
// Storage: dedicated synthetic_observations table (migration 0070).
// UNIQUE(org, entity_type, entity_id, observation_type,
// observation_value) means same observation from a second channel
// UPDATEs in place — channels[] gets appended, last_observed_at
// advances. Different observations of the same type produce separate
// rows.
//
// Routing: extraction.ts and signal-router.ts now call
// recordSyntheticObservation for synthetic-class signals instead of
// raw INSERTing into approval_queue. Old approval_queue rows from
// pre-Q12 code drain naturally as users review them.

import type { Env } from '../types/env';
import { resolveChannel, type ChannelContext } from './source-channels';

// Synthetic observation types. Sourced from the LLM-extraction prompt
// (prompts/extraction.ts) and the transcript signal taxonomy in
// signal-router.ts. Centralized here so future additions land in one
// place.
export const SYNTHETIC_TYPES = new Set([
  'personal_update',
  'follow_up_commitment',
  'relationship_knows_person',
  'relationship_decision_maker',
  'relationship_introduction_offer',
  'product_update',
  'partnership',
]);

export function isSyntheticType(field: string): boolean {
  return SYNTHETIC_TYPES.has(field);
}

export interface RecordObservationInput {
  orgId: string;
  entityType: 'contact' | 'company' | 'deal';
  entityId: string;
  observationType: string;
  /** Already a string. Caller serializes complex values; the UNIQUE
   *  index keys on (entity, type, value) so two different worded
   *  observations of the same type produce separate rows. */
  observationValue: string;
  source: string;
  context: ChannelContext;
  confidence: number;
  evidence?: string | null;
  sourceCommunicationId?: string | null;
}

/**
 * Append-with-merge into synthetic_observations. First sighting INSERTs
 * a row with channels=[<resolvedChannel>]. Same observation from a
 * different channel UPDATEs the existing row: channels[] is unioned (set
 * semantics — same channel can't double-count), confidence takes the max,
 * last_observed_at advances. dismissed_at is cleared on re-observation
 * since a fresh sighting overrides a prior dismissal.
 */
export async function recordSyntheticObservation(
  input: RecordObservationInput,
  env: Env
): Promise<{ created: boolean; channels: string[] }> {
  const channel = resolveChannel(input.source, input.context);
  const now = new Date().toISOString();

  // Read first to compute the merged channels[] without losing the
  // append-set semantics. UPSERT-with-JSON-arithmetic is awkward in
  // SQLite; the read-modify-write costs one extra round-trip but keeps
  // the merge logic obvious and testable.
  const existing = await env.D1.prepare(
    `SELECT id, channels, confidence, dismissed_at FROM synthetic_observations
       WHERE org_id = ? AND entity_type = ? AND entity_id = ?
         AND observation_type = ? AND observation_value = ?`
  ).bind(
    input.orgId, input.entityType, input.entityId,
    input.observationType, input.observationValue
  ).first<{ id: string; channels: string; confidence: number; dismissed_at: string | null }>();

  if (existing) {
    let prior: string[] = [];
    try {
      const parsed = JSON.parse(existing.channels);
      if (Array.isArray(parsed)) prior = parsed.filter(s => typeof s === 'string');
    } catch { /* corrupted -> treat as fresh start */ }
    const merged = Array.from(new Set([...prior, channel]));
    const newConfidence = Math.max(existing.confidence, input.confidence);

    await env.D1.prepare(
      `UPDATE synthetic_observations
          SET channels = ?,
              confidence = ?,
              last_observed_at = ?,
              -- A fresh sighting clears a prior dismissal: the user may
              -- have dismissed an outdated observation, but if the LLM
              -- still sees evidence, it's worth re-surfacing.
              dismissed_at = NULL,
              dismissed_by = NULL,
              -- Update evidence + source_communication_id to the most
              -- recent sighting's payload. Older evidence is dropped —
              -- the row tracks "the strongest case for this
              -- observation right now," not a full history.
              evidence = COALESCE(?, evidence),
              source_communication_id = COALESCE(?, source_communication_id)
        WHERE id = ?`
    ).bind(
      JSON.stringify(merged),
      newConfidence,
      now,
      input.evidence ?? null,
      input.sourceCommunicationId ?? null,
      existing.id
    ).run();

    return { created: false, channels: merged };
  }

  await env.D1.prepare(
    `INSERT INTO synthetic_observations
       (org_id, entity_type, entity_id, observation_type, observation_value,
        channels, confidence, evidence, source_communication_id,
        first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.orgId, input.entityType, input.entityId,
    input.observationType, input.observationValue,
    JSON.stringify([channel]),
    input.confidence,
    input.evidence ?? null,
    input.sourceCommunicationId ?? null,
    now, now
  ).run();

  return { created: true, channels: [channel] };
}

export interface ObservationOutput {
  id: string;
  observation_type: string;
  observation_value: string;
  channels: string[];
  confidence: number;
  evidence: string | null;
  source_communication_id: string | null;
  first_observed_at: string;
  last_observed_at: string;
}

/**
 * List active (non-dismissed) observations for an entity. Ordered by
 * last_observed_at DESC so the most recently corroborated observations
 * surface first.
 */
export async function listObservationsForEntity(
  entityType: 'contact' | 'company' | 'deal',
  entityId: string,
  orgId: string,
  env: Env
): Promise<ObservationOutput[]> {
  const rows = await env.D1.prepare(
    `SELECT id, observation_type, observation_value, channels, confidence,
            evidence, source_communication_id, first_observed_at, last_observed_at
       FROM synthetic_observations
       WHERE org_id = ? AND entity_type = ? AND entity_id = ?
         AND dismissed_at IS NULL
       ORDER BY last_observed_at DESC
       LIMIT 100`
  ).bind(orgId, entityType, entityId).all<{
    id: string;
    observation_type: string;
    observation_value: string;
    channels: string;
    confidence: number;
    evidence: string | null;
    source_communication_id: string | null;
    first_observed_at: string;
    last_observed_at: string;
  }>();

  return rows.results.map(r => {
    let channels: string[] = [];
    try {
      const parsed = JSON.parse(r.channels);
      if (Array.isArray(parsed)) channels = parsed.filter(s => typeof s === 'string');
    } catch { /* default empty */ }
    return {
      id: r.id,
      observation_type: r.observation_type,
      observation_value: r.observation_value,
      channels,
      confidence: r.confidence,
      evidence: r.evidence,
      source_communication_id: r.source_communication_id,
      first_observed_at: r.first_observed_at,
      last_observed_at: r.last_observed_at,
    };
  });
}

/**
 * Dismiss a single observation. Sets dismissed_at + dismissed_by so it
 * stops surfacing in the entity detail page. A subsequent re-sighting
 * by the LLM clears the dismissal (the user may have dismissed an
 * outdated observation; if it's still being seen, it's worth showing
 * again). Returns the count actually updated for the caller's sanity.
 */
export async function dismissObservation(
  observationId: string,
  userId: string,
  orgId: string,
  env: Env
): Promise<{ ok: boolean }> {
  const result = await env.D1.prepare(
    `UPDATE synthetic_observations
        SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            dismissed_by = ?
      WHERE id = ? AND org_id = ? AND dismissed_at IS NULL`
  ).bind(userId, observationId, orgId).run();
  return { ok: (result.meta.changes ?? 0) > 0 };
}

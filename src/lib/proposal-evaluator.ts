// Wave 6 — proposal evaluator.
//
// One function: evaluateProposal(input, env). Reads entity_field_state,
// computes the corroboration disposition (apply / hold / queue / reject),
// commits the resulting state changes (and entity table writes when a
// corroborated value beats current), and returns the disposition.
//
// Architectural commitment, locked at audit's question round:
//
//   • Corroboration is the only quality signal. No source-authority matrix.
//     The current value is the truth until enough independent CHANNELS
//     disagree with it (3+ to overwrite, 2+ to fill an empty).
//   • A "channel" is an independent ORIGIN of information, not an API
//     call. Same channel proposing the same value twice is zero
//     corroboration (set semantics on insert into the channel list).
//     Channel taxonomy lives in source-channels.ts and is the only
//     place that knows the mapping from raw source string → channel.
//   • A human edit RESETS corroboration history. After approval, the
//     current_value_sources is reset to the human's manual_edit channel.
//     Past channel agreement does not carry forward against a fresh
//     human decision (commitApproval handles this).
//   • Recent rejections (within 90 days) auto-reject re-asks of the
//     same value. Don't pester the human with the same proposal.
//   • Last-human-edit lock (180 days) blocks automated overwrite
//     entirely. Inside the window, identical-to-current → REJECT
//     (already locked, no need), differing → HOLD (stash, never queue).
//
// What this evaluator does NOT cover (yet):
//
//   • new_entity proposals (signal-router's "new company discovered"
//     flag). These are creation, not field overwrite — there's no
//     current_value to defend.
//   • new_association synthetic fields (personal_update,
//     follow_up_commitment, relationship_*). These are observations
//     attached to an entity, not column overwrites.
//   • create_deal. The deal_signals_pending staging table from the
//     Phase 0 hotfix already implements a domain-specific corroboration
//     gate. Phase C may unify; first pass leaves it alone.
//   • update_contact/linkedin_profile (ReverseContact unverified). This
//     is a multi-field candidate — Phase D's UI will let the user
//     accept individual fields, at which point each field flows
//     through this evaluator on approval.
//
// Those four kinds keep their direct-queue paths (with the Phase B
// payload normalization). Everything else — progressive_update,
// linkedin_discovery for linkedin_url, transcript_extraction for real
// columns, enrichment proposeEntityUpdate calls — funnels here.

import type { Env } from '../types/env';
import { resolveChannel, type ChannelContext } from './source-channels';
import { updateEntityInIndex } from './entity-index';

// Tunables. Stored as constants, not magic numbers — Wave 6 spec
// reserves the right to adjust without code-spelunking.
export const CORROBORATION_TO_FILL_EMPTY = 2;
export const CORROBORATION_TO_OVERWRITE = 3;
export const HUMAN_EDIT_LOCK_DAYS = 180;
export const RECENT_REJECTION_DAYS = 90;

export type Disposition = 'apply' | 'reject' | 'hold' | 'queue';

export type ApplyMode =
  | 'silent_corroboration'   // current_value matched, channel appended
  | 'fill_empty'             // current was empty, promoted to current
  | 'overwrite_corroborated' // pending value crossed threshold, promoted
  | 'delete_corroborated';   // Q11: deletion crossed threshold, queued for review

export interface ProposalInput {
  orgId: string;
  entityType: 'contact' | 'company' | 'deal';
  entityId: string;
  fieldName: string;
  /** Already a string — caller is responsible for serializing complex
   *  values consistently (the corroboration map keys on this string,
   *  so {a:1, b:2} and {b:2, a:1} are the same proposal only if the
   *  caller normalizes before invoking).
   *  Ignored when proposedDeletion=true. */
  proposedValue: string;
  /** Q11: when true, this is a deletion proposal — the channel is
   *  arguing the field should be cleared (set to NULL). Same
   *  corroboration math (3 channels to QUEUE), reuses pending_deletions
   *  on entity_field_state, reuses rejected_values[__DELETE__] for the
   *  90-day no-re-ask. proposedValue is ignored when this flag is set. */
  proposedDeletion?: boolean;
  /** Raw source identifier — resolveChannel maps it to a canonical
   *  channel string. */
  source: string;
  context: ChannelContext;
  /** LLM/source confidence (0.0-1.0). Stored on the queue row when we
   *  surface for human review; does NOT affect the apply/hold decision
   *  — corroboration is the only quality signal. */
  confidence: number;
  /** Forwarded to the approval_queue row when disposition === 'queue'. */
  sourceCommunicationId?: string | null;
  sourceVisibility?: 'private' | 'org_wide' | 'confidential';
  sourceDescription?: string | null;
}

export interface EvaluationResult {
  disposition: Disposition;
  /** Why we picked this disposition. Useful in logs and the audit
   *  trail; never user-facing. */
  reason: string;
  /** Set when disposition === 'apply'. */
  applyMode?: ApplyMode;
  /** Channel string we resolved for this proposal — exposed so callers
   *  can log it without re-deriving. */
  channel: string;
}

interface FieldStateRow {
  id: string;
  current_value: string | null;
  current_value_sources: string;     // JSON array
  pending_proposals: string;         // JSON object
  pending_deletions: string;         // JSON array (Q11)
  rejected_values: string;           // JSON object
  last_human_edit_at: string | null;
  permanently_locked: number;
}

// Q11 — sentinel key in rejected_values{} marking "this field's
// deletion was dismissed within the 90-day no-re-ask window." Reused
// instead of adding a separate rejected_deletions column because the
// 90-day rule is symmetric across overwrites and deletions, and the
// existing rejected_values shape already carries timestamp values.
const DELETION_SENTINEL = '__DELETE__';
export { DELETION_SENTINEL };

function tableForEntity(t: 'contact' | 'company' | 'deal'): string {
  if (t === 'contact') return 'contacts';
  if (t === 'company') return 'companies';
  return 'deals';
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}

function parsePendingMap(json: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter(s => typeof s === 'string');
    }
    return out;
  } catch { return {}; }
}

function parseRejectedMap(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch { return {}; }
}

async function loadOrInit(
  input: ProposalInput,
  env: Env
): Promise<FieldStateRow> {
  const existing = await env.D1.prepare(
    `SELECT id, current_value, current_value_sources, pending_proposals,
            pending_deletions, rejected_values, last_human_edit_at, permanently_locked
       FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(input.entityType, input.entityId, input.fieldName)
   .first<FieldStateRow>();

  if (existing) return existing;

  // Cold path: no row exists in entity_field_state. Read the entity
  // table for the live value (Phase A backfill should have caught this,
  // but new entities created post-backfill won't have a row yet).
  const table = tableForEntity(input.entityType);
  const live = await env.D1.prepare(
    `SELECT ${input.fieldName} as v FROM ${table} WHERE id = ?`
  ).bind(input.entityId).first<{ v: unknown }>().catch(() => null);
  const currentValue =
    live?.v == null ? null
    : typeof live.v === 'string' ? live.v
    : String(live.v);

  // Insert a fresh row. current_value_sources defaults to
  // ['historical_unknown'] only when the entity table HAS a value —
  // truly empty fields start with []. This mirrors the Phase A backfill
  // logic for consistency.
  const sources = currentValue && currentValue.trim() !== ''
    ? '["historical_unknown"]'
    : '[]';
  await env.D1.prepare(
    `INSERT OR IGNORE INTO entity_field_state
       (entity_type, entity_id, field_name, current_value, current_value_sources)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    input.entityType, input.entityId, input.fieldName,
    currentValue, sources
  ).run();

  // Re-read so we get the auto-generated id and any defaults.
  const fresh = await env.D1.prepare(
    `SELECT id, current_value, current_value_sources, pending_proposals,
            pending_deletions, rejected_values, last_human_edit_at, permanently_locked
       FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(input.entityType, input.entityId, input.fieldName)
   .first<FieldStateRow>();

  if (!fresh) {
    // Should be impossible after the INSERT OR IGNORE above; if it
    // happens, the caller's race condition will get a HOLD on the
    // next attempt. Synthesize a minimal row to avoid throwing.
    return {
      id: '',
      current_value: currentValue,
      current_value_sources: sources,
      pending_proposals: '{}',
      pending_deletions: '[]',
      rejected_values: '{}',
      last_human_edit_at: null,
      permanently_locked: 0,
    };
  }
  return fresh;
}

// ───────────────────────── disposition logic ─────────────────────────

interface DecisionContext {
  channel: string;
  state: FieldStateRow;
  currentSources: string[];
  pending: Record<string, string[]>;
  pendingDeletions: string[];
  rejected: Record<string, string>;
  proposedValue: string;
  /** Q11: when true, decideDisposition takes the deletion branch
   *  (uses pending_deletions[] not pending_proposals{}, checks the
   *  __DELETE__ key in rejected_values, and resolves to QUEUE at 3+
   *  channels — same threshold as overwrite). */
  proposedDeletion: boolean;
}

function isWithinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < days * 86400000;
}

/**
 * Pure decision function — no DB writes. Returns the disposition + reason
 * without committing. Useful for dry-run / sweep paths (Phase E).
 */
export function decideDisposition(ctx: DecisionContext): {
  disposition: Disposition;
  reason: string;
  applyMode?: ApplyMode;
} {
  const { channel, state, currentSources, pending, pendingDeletions, rejected, proposedValue, proposedDeletion } = ctx;

  // 2. Permanent lock — applies to overwrites AND deletions.
  if (state.permanently_locked === 1) {
    return { disposition: 'reject', reason: 'permanently_locked' };
  }

  // 3. Human-edit lock (180-day window).
  if (isWithinDays(state.last_human_edit_at, HUMAN_EDIT_LOCK_DAYS)) {
    if (proposedDeletion) {
      // Deletion against a recently-human-edited value: HOLD silently
      // (channel is preserved in pending_deletions but no surface).
      // No "identical to current" shortcut — deletions don't compete
      // with current_value the way overwrites do.
      return { disposition: 'hold', reason: 'human_edit_lock_deletion' };
    }
    if (state.current_value === proposedValue) {
      return { disposition: 'reject', reason: 'human_edit_lock_identical' };
    }
    return { disposition: 'hold', reason: 'human_edit_lock_differing' };
  }

  // ── Q11: deletion branch ──────────────────────────────────────────
  if (proposedDeletion) {
    // Recent-rejection of THIS field's deletion (90-day no-re-ask).
    const deletionRejectedAt = rejected[DELETION_SENTINEL];
    if (deletionRejectedAt && isWithinDays(deletionRejectedAt, RECENT_REJECTION_DAYS)) {
      return { disposition: 'reject', reason: 'recently_rejected_deletion' };
    }
    // Nothing to delete — current is already empty.
    if (state.current_value === null || state.current_value.trim() === '') {
      return { disposition: 'reject', reason: 'deletion_against_empty_current' };
    }
    // Channel can't self-corroborate.
    if (pendingDeletions.includes(channel)) {
      return { disposition: 'reject', reason: 'channel_already_corroborates_deletion' };
    }
    const distinctAfter = pendingDeletions.length + 1;
    if (distinctAfter >= CORROBORATION_TO_OVERWRITE) {
      return {
        disposition: 'queue',
        reason: 'deletion_corroborated_pending_human_review',
        applyMode: 'delete_corroborated',
      };
    }
    return {
      disposition: 'hold',
      reason: `awaiting_deletion_corroboration_${distinctAfter}_of_${CORROBORATION_TO_OVERWRITE}`,
    };
  }

  // 4. Recent-rejection (90-day no-re-ask) — overwrite path.
  const rejectedAt = rejected[proposedValue];
  if (rejectedAt && isWithinDays(rejectedAt, RECENT_REJECTION_DAYS)) {
    return { disposition: 'reject', reason: 'recently_rejected' };
  }

  // 5. Identical to current.
  if (state.current_value === proposedValue) {
    if (currentSources.includes(channel)) {
      return { disposition: 'reject', reason: 'channel_already_corroborates_current' };
    }
    return {
      disposition: 'apply',
      reason: 'silent_corroboration',
      applyMode: 'silent_corroboration',
    };
  }

  // 6. Empty field — fill threshold is 2.
  if (state.current_value === null || state.current_value.trim() === '') {
    const channelsForValue = pending[proposedValue] || [];
    if (channelsForValue.includes(channel)) {
      return { disposition: 'reject', reason: 'channel_already_corroborates_pending' };
    }
    const distinctAfter = channelsForValue.length + 1;
    if (distinctAfter >= CORROBORATION_TO_FILL_EMPTY) {
      return { disposition: 'apply', reason: 'fill_empty_corroborated', applyMode: 'fill_empty' };
    }
    return { disposition: 'hold', reason: `awaiting_corroboration_${distinctAfter}_of_${CORROBORATION_TO_FILL_EMPTY}` };
  }

  // 7. Conflict — current exists, proposed differs. Overwrite threshold is 3.
  const channelsForValue = pending[proposedValue] || [];
  if (channelsForValue.includes(channel)) {
    return { disposition: 'reject', reason: 'channel_already_corroborates_pending' };
  }
  const distinctAfter = channelsForValue.length + 1;
  if (distinctAfter >= CORROBORATION_TO_OVERWRITE) {
    return { disposition: 'queue', reason: 'overwrite_corroborated_pending_human_review', applyMode: 'overwrite_corroborated' };
  }
  return { disposition: 'hold', reason: `awaiting_corroboration_${distinctAfter}_of_${CORROBORATION_TO_OVERWRITE}` };
}

// ───────────────────────── state mutations ─────────────────────────

async function applySilentCorroboration(
  state: FieldStateRow,
  currentSources: string[],
  channel: string,
  env: Env
): Promise<void> {
  const updated = JSON.stringify([...currentSources, channel]);
  await env.D1.prepare(
    `UPDATE entity_field_state
        SET current_value_sources = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(updated, state.id).run();
}

async function applyFillEmpty(
  input: ProposalInput,
  state: FieldStateRow,
  pending: Record<string, string[]>,
  channel: string,
  env: Env
): Promise<void> {
  const channelsForValue = pending[input.proposedValue] || [];
  const allChannels = Array.from(new Set([...channelsForValue, channel]));
  // Promote: write to entity table, update entity_field_state, clear
  // pending_proposals (we just resolved one; others are stale by
  // construction — they were attempts to fill an empty current that
  // is no longer empty).
  const table = tableForEntity(input.entityType);
  await env.D1.prepare(
    `UPDATE ${table} SET ${input.fieldName} = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(input.proposedValue, input.entityId).run();

  await env.D1.prepare(
    `UPDATE entity_field_state
        SET current_value = ?,
            current_value_sources = ?,
            pending_proposals = '{}',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(input.proposedValue, JSON.stringify(allChannels), state.id).run();
}

async function applyHold(
  state: FieldStateRow,
  pending: Record<string, string[]>,
  proposedValue: string,
  channel: string,
  env: Env
): Promise<void> {
  const next = { ...pending };
  const existing = next[proposedValue] || [];
  next[proposedValue] = Array.from(new Set([...existing, channel]));
  await env.D1.prepare(
    `UPDATE entity_field_state
        SET pending_proposals = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(next), state.id).run();
}

// Q11 — deletion HOLD: append channel to pending_deletions[]. Mirrors
// applyHold for the overwrite case but writes a different column.
async function applyHoldDeletion(
  state: FieldStateRow,
  pendingDeletions: string[],
  channel: string,
  env: Env
): Promise<void> {
  const updated = Array.from(new Set([...pendingDeletions, channel]));
  await env.D1.prepare(
    `UPDATE entity_field_state
        SET pending_deletions = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(updated), state.id).run();
}

async function applyQueue(
  input: ProposalInput,
  state: FieldStateRow,
  pending: Record<string, string[]>,
  currentSources: string[],
  channel: string,
  env: Env
): Promise<void> {
  // Same state mutation as HOLD (the channel needs to be recorded in
  // pending_proposals so future cycles see it), plus an
  // approval_queue insert keyed off (entity, field, value) so the
  // same conflict only ever produces one queue row.
  await applyHold(state, pending, input.proposedValue, channel, env);

  // Build the proposed_value envelope the listApprovalQueue parser
  // expects: { value, metadata }. Surface the corroboration trail so
  // the UI (Phase D) can render "Current sourced from [A,B,C].
  // Proposed sourced from [D,E,F]" without re-querying.
  const channelsForValue = Array.from(new Set([...(pending[input.proposedValue] || []), channel]));
  const proposedJson = JSON.stringify({
    value: input.proposedValue,
    metadata: {
      current_value: state.current_value,
      source_type: input.source,
      source_description: input.sourceDescription || input.source,
      context: input.context,
      // Wave 6 corroboration packet — Phase D reads this directly.
      current_value_sources: currentSources,
      proposed_value_sources: channelsForValue,
      corroboration_count: channelsForValue.length,
    },
  });

  // Idempotency keyed on (entity, field, value) so repeated proposals
  // for the same value collapse to one queue row. If a row already
  // exists, refresh its proposed_value (the corroboration trail just
  // changed) instead of producing a duplicate.
  const existingRow = await env.D1.prepare(
    `SELECT id FROM approval_queue
       WHERE org_id = ? AND entity_type = ? AND entity_id = ?
         AND field_name = ? AND status = 'pending'
         AND json_extract(proposed_value, '$.value') = ?`
  ).bind(input.orgId, input.entityType, input.entityId, input.fieldName, input.proposedValue)
   .first<{ id: string }>();

  if (existingRow) {
    await env.D1.prepare(
      `UPDATE approval_queue
          SET proposed_value = ?,
              confidence = MAX(confidence, ?),
              source_communication_id = COALESCE(?, source_communication_id),
              created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(
      proposedJson, input.confidence,
      input.sourceCommunicationId || null,
      existingRow.id
    ).run();
  } else {
    const idempotencyKey = `${input.orgId}:efs:${input.entityType}:${input.entityId}:${input.fieldName}:${hash16(input.proposedValue)}`;
    await env.D1.prepare(
      `INSERT OR IGNORE INTO approval_queue
         (idempotency_key, org_id, entity_type, entity_id, change_type,
          field_name, proposed_value, source_communication_id,
          source_visibility, confidence, status)
       VALUES (?, ?, ?, ?, 'progressive_update', ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      idempotencyKey, input.orgId, input.entityType, input.entityId,
      input.fieldName, proposedJson,
      input.sourceCommunicationId || null,
      input.sourceVisibility || 'org_wide',
      input.confidence
    ).run();
  }
}

// Q11 — deletion QUEUE: same state mutation as deletion HOLD (append
// channel to pending_deletions[]) plus an approval_queue insert. The
// proposed_value envelope carries `proposed_deletion: true` so the UI
// can render "Proposed: clear this field" instead of a value swap. The
// idempotency key uses the DELETION_SENTINEL so deletion proposals
// don't collide with overwrite proposals for the same field.
async function applyQueueDeletion(
  input: ProposalInput,
  state: FieldStateRow,
  pendingDeletions: string[],
  currentSources: string[],
  channel: string,
  env: Env
): Promise<void> {
  await applyHoldDeletion(state, pendingDeletions, channel, env);

  const channelsForDeletion = Array.from(new Set([...pendingDeletions, channel]));
  const proposedJson = JSON.stringify({
    value: null, // signals deletion to the UI
    metadata: {
      current_value: state.current_value,
      proposed_deletion: true,
      source_type: input.source,
      source_description: input.sourceDescription || `${input.source}: proposes clearing this field`,
      context: input.context,
      current_value_sources: currentSources,
      proposed_value_sources: channelsForDeletion,
      corroboration_count: channelsForDeletion.length,
    },
  });

  const existingRow = await env.D1.prepare(
    `SELECT id FROM approval_queue
       WHERE org_id = ? AND entity_type = ? AND entity_id = ?
         AND field_name = ? AND status = 'pending'
         AND json_extract(proposed_value, '$.metadata.proposed_deletion') = 1`
  ).bind(input.orgId, input.entityType, input.entityId, input.fieldName)
   .first<{ id: string }>();

  if (existingRow) {
    await env.D1.prepare(
      `UPDATE approval_queue
          SET proposed_value = ?,
              confidence = MAX(confidence, ?),
              source_communication_id = COALESCE(?, source_communication_id),
              created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(
      proposedJson, input.confidence,
      input.sourceCommunicationId || null,
      existingRow.id
    ).run();
  } else {
    const idempotencyKey = `${input.orgId}:efs:${input.entityType}:${input.entityId}:${input.fieldName}:${DELETION_SENTINEL}`;
    await env.D1.prepare(
      `INSERT OR IGNORE INTO approval_queue
         (idempotency_key, org_id, entity_type, entity_id, change_type,
          field_name, proposed_value, source_communication_id,
          source_visibility, confidence, status)
       VALUES (?, ?, ?, ?, 'progressive_deletion', ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      idempotencyKey, input.orgId, input.entityType, input.entityId,
      input.fieldName, proposedJson,
      input.sourceCommunicationId || null,
      input.sourceVisibility || 'org_wide',
      input.confidence
    ).run();
  }
}

// ───────────────────────── public entrypoint ─────────────────────────

/**
 * Evaluate a proposal. Reads entity_field_state, computes disposition,
 * commits all required state mutations, and returns the disposition.
 *
 * Caller does NOT need to do any further bookkeeping — entity_field_state,
 * the entity table (on apply), and approval_queue (on queue) are all
 * mutated in-line.
 */
export async function evaluateProposal(
  input: ProposalInput,
  env: Env
): Promise<EvaluationResult> {
  // 1. Resolve channel.
  const channel = resolveChannel(input.source, input.context);

  // Load (or initialize) the field state row.
  const state = await loadOrInit(input, env);
  const currentSources = parseStringArray(state.current_value_sources);
  const pending = parsePendingMap(state.pending_proposals);
  const pendingDeletions = parseStringArray(state.pending_deletions);
  const rejected = parseRejectedMap(state.rejected_values);

  const decision = decideDisposition({
    channel,
    state,
    currentSources,
    pending,
    pendingDeletions,
    rejected,
    proposedValue: input.proposedValue,
    proposedDeletion: input.proposedDeletion === true,
  });

  // 2-7 in decideDisposition. Now commit the state changes.
  switch (decision.disposition) {
    case 'reject':
      // No state change. The "recently rejected" check, the human-edit
      // lock check, and the self-corroboration checks are all
      // idempotent denials.
      break;

    case 'apply':
      if (decision.applyMode === 'silent_corroboration') {
        await applySilentCorroboration(state, currentSources, channel, env);
      } else if (decision.applyMode === 'fill_empty') {
        await applyFillEmpty(input, state, pending, channel, env);
        // entity-index only knows contact/company; deals don't have a
        // Vectorize index entry to refresh.
        if (input.entityType !== 'deal') {
          try { await updateEntityInIndex(input.orgId, input.entityType, input.entityId, env); } catch {}
        }
      }
      // overwrite_corroborated never returns 'apply' — it returns
      // 'queue' for human review.
      break;

    case 'hold':
      if (input.proposedDeletion === true) {
        await applyHoldDeletion(state, pendingDeletions, channel, env);
      } else {
        await applyHold(state, pending, input.proposedValue, channel, env);
      }
      break;

    case 'queue':
      if (input.proposedDeletion === true) {
        await applyQueueDeletion(input, state, pendingDeletions, currentSources, channel, env);
      } else {
        await applyQueue(input, state, pending, currentSources, channel, env);
      }
      break;
  }

  console.log(
    `[evaluator] ${input.entityType}/${input.entityId}.${input.fieldName} ` +
    `(${decision.disposition}/${decision.reason}) channel=${channel} ` +
    `value="${input.proposedValue.slice(0, 60)}"`
  );

  return {
    disposition: decision.disposition,
    reason: decision.reason,
    applyMode: decision.applyMode,
    channel,
  };
}

// ───────── post-human-resolution state updates (called by approval.ts) ─────────

/**
 * Called when a human APPROVES a queue row. Resets corroboration history
 * for the field — the human edit becomes the single authoritative
 * channel, and pending_proposals is cleared. Past channel agreement
 * doesn't carry forward against a fresh human decision.
 */
export async function recordApproval(
  params: {
    orgId: string;
    entityType: 'contact' | 'company' | 'deal';
    entityId: string;
    fieldName: string;
    approvedValue: string;
    userId: string | null;
  },
  env: Env
): Promise<void> {
  const channel = resolveChannel('manual_edit', { userId: params.userId });
  const now = new Date().toISOString();

  // The entity table itself has already been updated by approval.ts's
  // commitApproval. We just sync entity_field_state and timestamp the
  // human edit. last_human_edit_user_id is stamped so MARTy's
  // 180-day-lock check (Phase 1 entity-writes.ts) can grant the SAME
  // user permission to update their own prior edit.
  await env.D1.prepare(
    `INSERT INTO entity_field_state
       (entity_type, entity_id, field_name, current_value,
        current_value_sources, pending_proposals, pending_deletions,
        rejected_values, last_human_edit_at, last_human_edit_user_id)
     VALUES (?, ?, ?, ?, ?, '{}', '[]', '{}', ?, ?)
     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
       current_value = excluded.current_value,
       current_value_sources = excluded.current_value_sources,
       pending_proposals = '{}',
       pending_deletions = '[]',
       last_human_edit_at = excluded.last_human_edit_at,
       last_human_edit_user_id = excluded.last_human_edit_user_id,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    params.entityType, params.entityId, params.fieldName,
    params.approvedValue,
    JSON.stringify([channel]),
    now,
    params.userId
  ).run();
}

/**
 * Q11 — called when a human APPROVES a held DELETION proposal. The
 * entity table is set to NULL (deletion semantics), entity_field_state's
 * current_value goes to NULL, current_value_sources is reset to
 * [manual_edit_<userId>] (the human is the new sole "source" of the
 * cleared state), pending_proposals AND pending_deletions both clear,
 * last_human_edit_at stamps now. This makes the human's deletion the
 * canonical state and gates future automated proposals via the 180-day
 * human-edit lock the same way an overwrite-approval would.
 */
export async function recordApprovalOfDeletion(
  params: {
    orgId: string;
    entityType: 'contact' | 'company' | 'deal';
    entityId: string;
    fieldName: string;
    userId: string | null;
  },
  env: Env
): Promise<void> {
  const channel = resolveChannel('manual_edit', { userId: params.userId });
  const now = new Date().toISOString();
  await env.D1.prepare(
    `INSERT INTO entity_field_state
       (entity_type, entity_id, field_name, current_value,
        current_value_sources, pending_proposals, pending_deletions,
        rejected_values, last_human_edit_at, last_human_edit_user_id)
     VALUES (?, ?, ?, NULL, ?, '{}', '[]', '{}', ?, ?)
     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
       current_value = NULL,
       current_value_sources = excluded.current_value_sources,
       pending_proposals = '{}',
       pending_deletions = '[]',
       last_human_edit_at = excluded.last_human_edit_at,
       last_human_edit_user_id = excluded.last_human_edit_user_id,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).bind(
    params.entityType, params.entityId, params.fieldName,
    JSON.stringify([channel]),
    now,
    params.userId
  ).run();
}

/**
 * Called when a human REJECTS a queue row. Removes the value from
 * pending_proposals and adds it to rejected_values with a timestamp.
 * Does NOT change current_value or current_value_sources — rejecting
 * isn't an edit. last_human_edit_at is NOT bumped.
 */
export async function recordRejection(
  params: {
    orgId: string;
    entityType: 'contact' | 'company' | 'deal';
    entityId: string;
    fieldName: string;
    rejectedValue: string;
    /** Q11: when true, this is a deletion-rejection. Stamps the
     *  __DELETE__ sentinel in rejected_values and clears
     *  pending_deletions. The 90-day no-re-ask rule then suppresses
     *  future deletion proposals for this field. */
    isDeletion?: boolean;
  },
  env: Env
): Promise<void> {
  const state = await env.D1.prepare(
    `SELECT id, pending_proposals, pending_deletions, rejected_values
       FROM entity_field_state
       WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
  ).bind(params.entityType, params.entityId, params.fieldName)
   .first<{
     id: string;
     pending_proposals: string;
     pending_deletions: string;
     rejected_values: string;
   }>();

  if (!state) return; // No state row → nothing to record. Resolution still happens in approval_queue.

  const pending = parsePendingMap(state.pending_proposals);
  const pendingDeletions = parseStringArray(state.pending_deletions);
  const rejected = parseRejectedMap(state.rejected_values);

  if (params.isDeletion) {
    // Drop all channels from pending_deletions and stamp the sentinel.
    rejected[DELETION_SENTINEL] = new Date().toISOString();
    await env.D1.prepare(
      `UPDATE entity_field_state
          SET pending_deletions = '[]',
              rejected_values = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`
    ).bind(JSON.stringify(rejected), state.id).run();
    void pendingDeletions; // referenced for shape symmetry; we always wipe
    return;
  }

  delete pending[params.rejectedValue];
  rejected[params.rejectedValue] = new Date().toISOString();

  await env.D1.prepare(
    `UPDATE entity_field_state
        SET pending_proposals = ?,
            rejected_values = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`
  ).bind(JSON.stringify(pending), JSON.stringify(rejected), state.id).run();
}

// 16-char hex hash for idempotency keys. Avoids importing helpers.ts
// here so the evaluator stays a leaf module.
function hash16(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul((h2 + c) ^ (h2 >>> 13), 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

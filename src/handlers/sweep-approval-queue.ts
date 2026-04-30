// Wave 6 Phase E — sweep existing pending approval_queue rows through
// the new evaluator. Pre-Wave-6 rows were created by code paths that
// did NOT consult entity_field_state; the sweep re-evaluates each as
// though it were a fresh proposal arriving today, then dispatches to
// apply / hold / queue / reject per the corroboration model.
//
// Effect, for a representative pending queue at deploy time:
//   • Rows whose proposed_value matches current → APPLY (silent
//     corroboration: channel appended to current_value_sources, queue
//     row marked auto_approved). Removes "approve to confirm what's
//     already there" busywork.
//   • Rows whose value was already rejected within 90 days → REJECT.
//     The 90-day no-re-ask kicks in immediately.
//   • Rows whose value disagrees with current at single-channel
//     corroboration → HOLD (channel logged in
//     entity_field_state.pending_proposals, queue row marked rejected
//     since Wave 6 holds shouldn't surface). The channel is preserved
//     so future proposals corroborate against it.
//   • Rows that hit the 3-channel overwrite threshold (rare on first
//     sweep — most pending values have only 1 source) → stay in queue
//     with a refreshed corroboration packet for Phase D's UI.
//   • Rows from sources that don't fit the column-overwrite model
//     (new_entity, new_association synthetic fields, ReverseContact
//     unverified multi-field candidate, create_deal) → SKIPPED. Those
//     stay as-is; the user resolves them through the existing UI.
//
// Owner-only. Batched (default 100, capped at 500). Dry-run mode
// computes the decision without applying state changes. Re-runnable —
// the evaluator's internal idempotency (same channel can't
// self-corroborate) means a second sweep over the same data produces
// no further state changes.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { decideDisposition, evaluateProposal, type Disposition } from '../lib/proposal-evaluator';
import { resolveChannel, type ChannelContext } from '../lib/source-channels';

// Fields the evaluator can reason about. Matches
// progressive-enrichment.ts CONTACT_FIELDS / COMPANY_FIELDS — kept in
// sync by hand because importing across the lib boundary would create
// a circular dep through approval.ts.
const CONTACT_FIELDS = new Set([
  'full_name', 'job_title', 'phone', 'email', 'linkedin_url', 'twitter_url',
  'location', 'company_id', 'bio_summary', 'investment_focus', 'check_size_range',
  'communication_channel_preference', 'introduced_via', 'fund_name',
  'topics_of_interest', 'pain_points', 'investment_thesis_tags',
]);

const COMPANY_FIELDS = new Set([
  'name', 'sector', 'website', 'domain', 'description', 'hq_location',
  'employee_count', 'investment_status', 'stage', 'current_valuation',
  'linkedin_url', 'last_funding_amount', 'last_funding_round', 'last_funding_date',
]);

function isEvaluableField(entityType: string, fieldName: string | null): boolean {
  if (!fieldName) return false;
  if (entityType === 'contact') return CONTACT_FIELDS.has(fieldName);
  if (entityType === 'company') return COMPANY_FIELDS.has(fieldName);
  return false;
}

interface QueueRow {
  id: string;
  org_id: string;
  entity_type: string;
  entity_id: string;
  field_name: string | null;
  change_type: string;
  proposed_value: string | null;
  source_communication_id: string | null;
  source_visibility: string | null;
  confidence: number | null;
}

interface ParsedProposal {
  proposedValue: string;
  source: string;
  sourceDescription: string | null;
  context: ChannelContext;
}

/**
 * Pull the proposed value, source, and context out of an
 * approval_queue row. Pre-Phase-B rows may have raw values without a
 * metadata wrapper; those still parse cleanly with safe defaults.
 */
function parseProposal(row: QueueRow): ParsedProposal | null {
  if (!row.proposed_value) return null;

  let proposedValue = row.proposed_value;
  let source = row.change_type;
  let sourceDescription: string | null = null;
  let context: ChannelContext = {};

  try {
    const parsed = JSON.parse(row.proposed_value);
    if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
      proposedValue = typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value);
      const metadata = parsed.metadata;
      if (metadata && typeof metadata === 'object') {
        if (typeof metadata.source_type === 'string') source = metadata.source_type;
        if (typeof metadata.source_description === 'string') sourceDescription = metadata.source_description;
        if (metadata.context && typeof metadata.context === 'object') {
          context = {
            userId: typeof metadata.context.userId === 'string' ? metadata.context.userId : null,
            importId: typeof metadata.context.importId === 'string' ? metadata.context.importId : null,
            conversationId: typeof metadata.context.conversationId === 'string' ? metadata.context.conversationId : null,
          };
        }
      }
    } else if (typeof parsed === 'string') {
      proposedValue = parsed;
    }
  } catch { /* keep the raw string */ }

  // Source-comm-id from the row column is a fallback for context.conversationId
  // when the metadata didn't include it (older payloads).
  if (!context.conversationId && row.source_communication_id) {
    context.conversationId = row.source_communication_id;
  }

  return { proposedValue, source, sourceDescription, context };
}

interface SweepStats {
  scanned: number;
  applied: number;       // disposition='apply' (silent corroboration or fill_empty)
  rejected: number;      // disposition='reject'
  held: number;          // disposition='hold' (queue row removed, channel kept in state)
  queued: number;        // disposition='queue' (unchanged — stays for human review)
  skipped: number;       // not evaluable (creation/observation/multi-field)
  errors: Array<{ row_id: string; error: string }>;
}

function emptyStats(): SweepStats {
  return { scanned: 0, applied: 0, rejected: 0, held: 0, queued: 0, skipped: 0, errors: [] };
}

interface SweepRequestBody {
  dry_run?: boolean;
  batch_size?: number;
  /** Stop after this many rows in one call (across batches). Default
   *  300 to avoid Worker CPU limit; caller loops if more remain. */
  max_rows?: number;
}

/**
 * POST /api/admin/sweep-approval-queue
 *
 * Body: { dry_run?: boolean, batch_size?: number, max_rows?: number }
 * Returns: { stats, rows_remaining }
 *
 * dry_run=true projects what would happen without writing. Pure call
 * to decideDisposition — entity_field_state is read but not mutated,
 * approval_queue rows stay 'pending'.
 */
export async function sweepApprovalQueue(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('FORBIDDEN', 403, 'owner role required');
  }

  const body = (await parseJsonBody<SweepRequestBody>(request)) || {};
  const dryRun = body.dry_run === true;
  const batchSize = Math.min(Math.max(1, body.batch_size ?? 100), 500);
  const maxRows = Math.min(Math.max(1, body.max_rows ?? 300), 5000);

  const stats = emptyStats();
  let cursor = 0;

  while (stats.scanned < maxRows) {
    const remaining = maxRows - stats.scanned;
    const fetchSize = Math.min(batchSize, remaining);

    const rows = await env.D1.prepare(
      `SELECT id, org_id, entity_type, entity_id, field_name, change_type,
              proposed_value, source_communication_id, source_visibility, confidence
         FROM approval_queue
         WHERE org_id = ? AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`
    ).bind(ctx.orgId, fetchSize, cursor).all<QueueRow>();

    if (rows.results.length === 0) break;

    for (const row of rows.results) {
      stats.scanned++;
      try {
        // Skip non-column-overwrite kinds. These don't have an
        // entity_field_state row to evaluate against.
        if (!isEvaluableField(row.entity_type, row.field_name)) {
          stats.skipped++;
          continue;
        }
        if (row.change_type === 'create_deal' || row.change_type === 'new_entity') {
          stats.skipped++;
          continue;
        }

        const proposal = parseProposal(row);
        if (!proposal) {
          stats.skipped++;
          continue;
        }

        if (dryRun) {
          // Pure decision — load entity_field_state, decide, don't mutate.
          // We synthesize a minimal FieldStateRow read here rather than
          // calling evaluateProposal (which would mutate). Falls back to
          // the same defaults the evaluator uses cold-path.
          const stateRow = await env.D1.prepare(
            `SELECT id, current_value, current_value_sources, pending_proposals,
                    pending_deletions, rejected_values, last_human_edit_at, permanently_locked
               FROM entity_field_state
               WHERE entity_type = ? AND entity_id = ? AND field_name = ?`
          ).bind(row.entity_type, row.entity_id, row.field_name!).first<{
            id: string;
            current_value: string | null;
            current_value_sources: string;
            pending_proposals: string;
            pending_deletions: string;
            rejected_values: string;
            last_human_edit_at: string | null;
            permanently_locked: number;
          }>();

          // No state row means cold-path — treat as empty current with
          // no prior corroboration. This is what the evaluator's
          // loadOrInit would create on first contact.
          const channel = resolveChannel(proposal.source, proposal.context);
          const decision = decideDisposition({
            channel,
            state: stateRow ?? {
              id: '',
              current_value: null,
              current_value_sources: '[]',
              pending_proposals: '{}',
              pending_deletions: '[]',
              rejected_values: '{}',
              last_human_edit_at: null,
              permanently_locked: 0,
            },
            currentSources: stateRow ? safeArray(stateRow.current_value_sources) : [],
            pending: stateRow ? safeMap(stateRow.pending_proposals) : {},
            // The sweep is for legacy approval_queue rows which were
            // never deletion-shaped — pending_deletions stays empty
            // for the dry-run decision context.
            pendingDeletions: stateRow ? safeArray(stateRow.pending_deletions) : [],
            rejected: stateRow ? safeRejected(stateRow.rejected_values) : {},
            proposedValue: proposal.proposedValue,
            proposedDeletion: false,
          });
          tally(stats, decision.disposition);
          continue;
        }

        // Live path — evaluator commits all state changes.
        const evaluation = await evaluateProposal({
          orgId: ctx.orgId,
          entityType: row.entity_type as 'contact' | 'company' | 'deal',
          entityId: row.entity_id,
          fieldName: row.field_name!,
          proposedValue: proposal.proposedValue,
          source: proposal.source,
          context: proposal.context,
          confidence: row.confidence ?? 0.5,
          sourceCommunicationId: row.source_communication_id,
          sourceVisibility: (row.source_visibility as 'private' | 'org_wide' | 'confidential') || 'org_wide',
          sourceDescription: proposal.sourceDescription,
        }, env);

        // Reflect the disposition back onto the original queue row.
        // (The evaluator will have inserted a fresh queue row for QUEUE
        // disposition only when the value was new — for sweep we always
        // already have a row, so the evaluator's internal merge logic
        // collapses to update-in-place.)
        tally(stats, evaluation.disposition);
        if (evaluation.disposition === 'apply') {
          await env.D1.prepare(
            `UPDATE approval_queue
                SET status = 'auto_approved',
                    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    resolved_by = NULL
              WHERE id = ?`
          ).bind(row.id).run();
        } else if (evaluation.disposition === 'reject') {
          await env.D1.prepare(
            `UPDATE approval_queue
                SET status = 'rejected',
                    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    resolved_by = NULL
              WHERE id = ?`
          ).bind(row.id).run();
        } else if (evaluation.disposition === 'hold') {
          // Wave 6 says HOLD doesn't surface. The evaluator has already
          // recorded the channel into entity_field_state.pending_proposals,
          // so the data isn't lost — the queue row goes away.
          await env.D1.prepare(
            `UPDATE approval_queue
                SET status = 'rejected',
                    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    resolved_by = NULL
              WHERE id = ?`
          ).bind(row.id).run();
        }
        // 'queue' disposition: leave as 'pending' — the evaluator may
        // have refreshed the proposed_value envelope with a fresh
        // corroboration packet, which is exactly what the UI now reads.
      } catch (e: any) {
        stats.errors.push({ row_id: row.id, error: String(e?.message || e).slice(0, 200) });
      }
    }

    cursor += rows.results.length;
    if (rows.results.length < fetchSize) break;
  }

  // Approximate remaining = pending rows not yet visited.
  const remainingRow = await env.D1.prepare(
    `SELECT COUNT(*) as n FROM approval_queue WHERE org_id = ? AND status = 'pending'`
  ).bind(ctx.orgId).first<{ n: number }>();

  return jsonResponse({
    dry_run: dryRun,
    stats,
    rows_remaining: remainingRow?.n ?? 0,
  });
}

function tally(stats: SweepStats, disposition: Disposition): void {
  switch (disposition) {
    case 'apply':  stats.applied++; break;
    case 'reject': stats.rejected++; break;
    case 'hold':   stats.held++; break;
    case 'queue':  stats.queued++; break;
  }
}

function safeArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
  } catch { return []; }
}

function safeMap(json: string): Record<string, string[]> {
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

function safeRejected(json: string): Record<string, string> {
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

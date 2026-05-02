// Wave 4 — admin backfill: re-run applyHardSignalsToConversation across
// existing conversations to populate conversation_deals junctions.
//
// Necessary because Wave 4's timeline reads junctions only (not
// contact-overlap), but Phase B/D hard-signals only fire on NEW
// conversations at ingest time. Existing conversations resident at the
// time hard-signals shipped need a one-time re-scan to populate links
// for inherited_thread + auto_high.
//
// Strategy: walk every email-source conversation in the org for the
// last N days (default 90), call applyHardSignalsToConversation with
// the same args stage-approvals.ts uses at ingest time. Idempotent
// (junction PK collapses dupes), so re-running is safe.
//
// Bounded by limit + days_back to keep within Worker subrequest
// budget. Owner-only. dry_run=true returns the would-scan count
// without firing the signals.

import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { applyHardSignalsToConversation } from '../lib/deal-association';

interface BackfillBody {
  days_back?: number;
  limit?: number;
  dry_run?: boolean;
}

export async function handleBackfillDealTimeline(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') return errorResponse('FORBIDDEN', 403, 'owner-only');

  const body = (await parseJsonBody<BackfillBody>(request)) || {};
  const daysBack = Math.max(1, Math.min(body.days_back ?? 90, 365));
  const limit = Math.max(1, Math.min(body.limit ?? 1000, 5000));
  const dryRun = body.dry_run === true;

  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();

  const convs = await env.D1.prepare(
    `SELECT id, external_thread_id, subject
       FROM conversations
      WHERE org_id = ?
        AND sent_at >= ?
        AND (subject IS NOT NULL AND subject != '' OR external_thread_id IS NOT NULL)
      ORDER BY sent_at DESC
      LIMIT ?`
  ).bind(ctx.orgId, cutoff, limit).all<{ id: string; external_thread_id: string | null; subject: string | null }>();

  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      would_scan: convs.results.length,
      days_back: daysBack,
      cutoff,
    });
  }

  let inheritedThread = 0;
  let autoHigh = 0;
  let scanned = 0;
  for (const c of convs.results) {
    try {
      const r = await applyHardSignalsToConversation(
        c.id,
        c.external_thread_id,
        c.subject,
        ctx.orgId,
        env
      );
      inheritedThread += r.inherited_thread;
      autoHigh += r.auto_high;
      scanned++;
    } catch (e) {
      console.error(`[backfill-timeline] failed for conversation ${c.id}:`, e);
    }
  }

  return jsonResponse({
    dry_run: false,
    scanned,
    days_back: daysBack,
    inherited_thread_links: inheritedThread,
    auto_high_links: autoHigh,
  });
}

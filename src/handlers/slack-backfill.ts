// Owner-only admin endpoint for forcing a deeper Slack channel history pull
// than the per-channel KV marker would naturally yield.
//
// Why this exists: the regular hourly cron sync starts each new channel from
// `oldest=0` (full history) and advances the marker forward as messages are
// processed. After a channel has been synced once, the marker prevents
// refetching the older window — necessary for steady-state efficiency, but
// it leaves us without a way to deepen coverage when needed.
//
// T1's Phase E `backfillSlackChannelToDeal` reads `WHERE source='slack' AND
// external_message_id LIKE '<channelId>:%' AND sent_at >= now-60d` to backfill
// conversation_deals with `inherited_channel`. If a channel was first seen
// fewer than 60 days ago, or the bot was just invited and only post-invite
// messages exist in DB, that 60-day query lands empty and the deal page
// stays sparse. This endpoint lets ops force a deeper pull on demand.

import type { Env } from '../types/env';
import type { AuthContext, ClassifiableItem } from '../types/interfaces';
import { jsonResponse, errorResponse, parseJsonBody } from './utils';
import { backfillSlackChannelHistory } from '../integrations/slack';
import { classifyAndDeduplicate } from '../lib/classification';
import { processClassifiedItems } from '../lib/ingestion-shared';

interface BackfillBody {
  channel_id?: string;
  days_back?: number | null;   // null = "from oldest" (Slack's default)
  reset_marker?: boolean;      // if true, also clears slack_last_sync:{org}:{channel} so subsequent regular cron runs re-cover the same range
}

/**
 * POST /api/admin/backfill-slack-channel-history
 *
 * Body: { channel_id, days_back?, reset_marker? }
 *
 * Owner-only. Synchronous within a single Worker invocation, wallclock-budgeted
 * to ~25s by SLACK_MAX_RUNTIME_MS inside the fetch path; if the channel has
 * more history than fits in one tick, response will indicate cursor_remaining
 * and the operator can call again to continue.
 */
export async function handleBackfillSlackChannelHistory(
  request: Request,
  ctx: AuthContext,
  env: Env
): Promise<Response> {
  if (ctx.userRole !== 'owner') {
    return errorResponse('AUTH_FORBIDDEN', 403, 'Only owners can backfill Slack channel history.');
  }
  const body = (await parseJsonBody<BackfillBody>(request)) || {};
  if (!body.channel_id) {
    return errorResponse('VALIDATION_ERROR', 400, 'channel_id required');
  }
  const daysBack = body.days_back === undefined ? null : body.days_back;
  if (daysBack !== null && (daysBack < 1 || daysBack > 730)) {
    return errorResponse('VALIDATION_ERROR', 400, 'days_back must be 1..730 or null');
  }

  // Optional marker reset — useful if the operator wants subsequent regular
  // hourly syncs to also re-cover the same range (e.g. they suspect the
  // marker advanced past messages we should have ingested but didn't).
  if (body.reset_marker) {
    await env.KV.delete(`slack_last_sync:${ctx.orgId}:${body.channel_id}`);
  }

  // sync_jobs row for traceability — admin-triggered runs are rare enough
  // that they're worth tracking distinct from the hourly ingestion workflow.
  const syncJobId = crypto.randomUUID();
  await env.D1.prepare(
    `INSERT INTO sync_jobs (id, org_id, workflow_type, status, started_at, metadata)
     VALUES (?, ?, 'slack-channel-backfill', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`
  ).bind(
    syncJobId,
    ctx.orgId,
    JSON.stringify({
      triggered_by: ctx.userId,
      channel_id: body.channel_id,
      days_back: daysBack,
      reset_marker: !!body.reset_marker,
    })
  ).run().catch(e => {
    console.error(`[slack-backfill] sync_jobs insert failed:`, (e as any)?.message || e);
  });

  const fetchResult = await backfillSlackChannelHistory(
    ctx.orgId,
    body.channel_id,
    daysBack,
    env
  );

  // backfillSlackChannelHistory tucks the message list onto the result via
  // a hidden _messages property (kept off the public type so callers don't
  // accidentally reach for it; the admin handler is the one place that
  // wants raw messages to feed downstream classification).
  const messages: ClassifiableItem[] =
    (fetchResult as typeof fetchResult & { _messages?: ClassifiableItem[] })._messages ?? [];

  let stats: Awaited<ReturnType<typeof processClassifiedItems>> | null = null;
  if (messages.length > 0) {
    const classified = await classifyAndDeduplicate(messages, ctx.orgId, env);
    stats = await processClassifiedItems(classified, { orgId: ctx.orgId, syncJobId }, env);
  }

  // Close the sync_jobs row.
  const finalStatus =
    fetchResult.error
      ? 'failed'
      : (stats?.errors?.length ?? 0) > 0
        ? 'partial'
        : 'completed';

  await env.D1.prepare(
    `UPDATE sync_jobs
        SET status = ?,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            items_processed = ?,
            metadata = json_patch(COALESCE(metadata, '{}'), ?)
      WHERE id = ?`
  ).bind(
    finalStatus,
    stats?.items_staged ?? 0,
    JSON.stringify({
      ended_status: finalStatus,
      messages_fetched: fetchResult.messages_fetched,
      pages: fetchResult.pages,
      cursor_remaining: fetchResult.cursor_remaining,
      budget_exhausted: fetchResult.budget_exhausted,
      fetch_error: fetchResult.error,
      items_staged: stats?.items_staged ?? 0,
      items_embedded: stats?.items_embedded ?? 0,
      deal_signals_staged: stats?.deal_signals_staged ?? 0,
      classify_errors: stats?.errors?.slice(0, 5) ?? [],
    }),
    syncJobId
  ).run().catch(e => {
    console.error(`[slack-backfill] sync_jobs close failed for ${syncJobId}:`, (e as any)?.message || e);
  });

  return jsonResponse({
    ok: !fetchResult.error,
    sync_job_id: syncJobId,
    channel_id: fetchResult.channel_id,
    channel_name: fetchResult.channel_name,
    messages_fetched: fetchResult.messages_fetched,
    pages: fetchResult.pages,
    cursor_remaining: fetchResult.cursor_remaining,
    budget_exhausted: fetchResult.budget_exhausted,
    fetch_error: fetchResult.error,
    classify: stats
      ? {
          items_total: stats.items_total,
          items_staged: stats.items_staged,
          items_embedded: stats.items_embedded,
          deal_signals_staged: stats.deal_signals_staged,
          errors_count: stats.errors.length,
        }
      : null,
  });
}

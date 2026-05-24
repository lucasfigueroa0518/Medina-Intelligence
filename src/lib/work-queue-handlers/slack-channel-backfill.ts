import type { Env } from '../../types/env';
import type { ClassifiableItem } from '../../types/interfaces';
import type { WorkQueueHandler } from '../work-queue-driver';
import { backfillSlackChannelHistory } from '../../integrations/slack';
import { classifyAndDeduplicate } from '../classification';
import { processClassifiedItems, persistClassifiedStats } from '../ingestion-shared';

interface SlackChannelBackfillPayload {
  channel_id: string;
  days_back?: number | null;
}

export const slackChannelBackfillHandler: WorkQueueHandler = {
  domain: 'slack_channel_backfill',
  batchSize: 3,
  cadence: 'minute',

  process: async (item, env: Env) => {
    let payload: SlackChannelBackfillPayload;
    try {
      payload = JSON.parse(item.payload) as SlackChannelBackfillPayload;
    } catch (e) {
      throw new Error(`malformed payload: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!payload.channel_id) {
      throw new Error(`payload missing channel_id: ${item.payload}`);
    }

    const daysBack = payload.days_back == null
      ? 30
      : Math.max(1, Math.min(90, Math.floor(payload.days_back)));

    const result = await backfillSlackChannelHistory(
      item.org_id,
      payload.channel_id,
      daysBack,
      env
    );

    if (result.error) {
      throw new Error(`slack_channel_backfill_failed:${result.error}`);
    }

    const messages = (result as typeof result & { _messages?: ClassifiableItem[] })._messages || [];
    if (messages.length === 0) {
      if (result.budget_exhausted || result.cursor_remaining) {
        throw new Error('slack_channel_backfill_incomplete_budget_exhausted');
      }
      return;
    }

    const classified = await classifyAndDeduplicate(messages, item.org_id, env);
    const stats = await processClassifiedItems(
      classified,
      { orgId: item.org_id, syncJobId: `slack-repair-${item.id}` },
      env
    );
    await persistClassifiedStats(stats, `slack-repair-${item.id}`, env).catch(() => {});

    if (stats.items_staged < classified.length || stats.errors.length > 0) {
      throw new Error(`slack_channel_backfill_partial: staged=${stats.items_staged}/${classified.length}`);
    }

    await env.D1.prepare(
      `UPDATE slack_channels
          SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              last_error = NULL
        WHERE org_id = ? AND channel_id = ?`
    ).bind(item.org_id, payload.channel_id).run();
  },
};

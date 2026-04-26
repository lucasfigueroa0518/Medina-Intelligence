// Wrapper workflow around runDailyCron(). Lets us trigger the same logic the
// 0 0 * * * scheduled handler runs via `wrangler workflows trigger
// daily-cron-workflow` — no JWT needed, useful for end-to-end pipeline
// testing without waiting for midnight UTC.

import type { Env } from '../types/env';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runDailyCron } from '../lib/daily-cron';

console.log('[DailyCronWorkflow] module loaded');

interface DailyCronParams {
  org_id?: string; // when omitted, runs for every active org
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export class DailyCronWorkflow extends WorkflowEntrypoint<Env, DailyCronParams> {
  async run(event: WorkflowEvent<DailyCronParams>, step: WorkflowStep): Promise<void> {
    const requestedOrg = event?.payload?.org_id;

    const orgIds = await step.do('list-orgs', async () => {
      if (requestedOrg) return [requestedOrg];
      const rows = await this.env.D1.prepare(
        `SELECT id FROM organizations WHERE deleted_at IS NULL`
      ).all<{ id: string }>();
      return rows.results.map(r => r.id);
    });

    for (const orgId of orgIds) {
      await step.do(`run-${orgId}`, { retries: { limit: 1, delay: '10 seconds' } }, async () => {
        try {
          await runDailyCron(orgId, this.env);
          console.log(`[DailyCronWorkflow] runDailyCron(${orgId}) completed`);
        } catch (e) {
          console.error(`[DailyCronWorkflow] runDailyCron(${orgId}) failed:`, errMessage(e));
          throw e;
        }
      });
    }
  }
}

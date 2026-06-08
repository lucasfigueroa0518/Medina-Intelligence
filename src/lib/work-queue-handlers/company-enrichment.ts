import type { Env } from '../../types/env';
import { triggerCompanyEnrichment } from '../enrichment';
import { enqueueWork } from '../work-queue';
import type { WorkQueueHandler } from '../work-queue-driver';

export const COMPANY_ENRICHMENT_DOMAIN = 'company_enrichment';

interface CompanyEnrichmentPayload {
  company_id: string;
  origin: string;
  selected_at: string;
  prior_enrichment_last_run?: string | null;
}

function parsePayload(payload: string): CompanyEnrichmentPayload {
  const parsed = JSON.parse(payload) as CompanyEnrichmentPayload;
  if (!parsed.company_id) {
    throw new Error(`company_enrichment payload missing company_id: ${payload}`);
  }
  return {
    company_id: parsed.company_id,
    origin: parsed.origin || 'work_queue',
    selected_at: parsed.selected_at || new Date().toISOString(),
    prior_enrichment_last_run: parsed.prior_enrichment_last_run ?? null,
  };
}

export async function enqueueCompanyEnrichment(
  env: Env,
  orgId: string,
  companyId: string,
  opts: { origin?: string; priority?: number } = {}
): Promise<{ inserted: boolean; id?: string; skipped?: string }> {
  const company = await env.D1.prepare(
    `SELECT id, enrichment_last_run
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL AND merged_into IS NULL
      LIMIT 1`
  ).bind(companyId, orgId).first<{ id: string; enrichment_last_run: string | null }>();
  if (!company) return { inserted: false, skipped: 'company_not_found' };

  return enqueueWork(
    env,
    orgId,
    COMPANY_ENRICHMENT_DOMAIN,
    {
      company_id: company.id,
      origin: opts.origin || 'ingestion_treatment',
      selected_at: new Date().toISOString(),
      prior_enrichment_last_run: company.enrichment_last_run,
    } satisfies CompanyEnrichmentPayload,
    {
      upstream: 'gemini_enrichment',
      idempotency_key: `${orgId}:company_enrichment:${company.id}:${company.enrichment_last_run || 'never'}`,
      priority: opts.priority ?? 10,
      max_attempts: 4,
    }
  );
}

export const companyEnrichmentHandler: WorkQueueHandler = {
  domain: COMPANY_ENRICHMENT_DOMAIN,
  batchSize: 3,
  maxConcurrent: 3,
  cadence: 'minute',

  process: async (item, env) => {
    const payload = parsePayload(item.payload);
    await triggerCompanyEnrichment(payload.company_id, item.org_id, env);
  },
};

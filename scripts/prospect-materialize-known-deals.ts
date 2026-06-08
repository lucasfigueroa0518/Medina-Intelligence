#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { getPlatformProxy } from 'wrangler';

import {
  ensureProspectForDeal,
  normalizeProspectName,
  type EnsureProspectForDealResult,
} from '../src/lib/prospect-intelligence';
import type { Env } from '../src/types/env';

interface Args {
  orgId: string;
  configPath: string;
  apply: boolean;
  confirmProductionWrite: boolean;
  limit: number;
}

interface DealCandidate {
  deal_id: string;
  company_id: string | null;
  company_name: string | null;
  existing_prospect_id: string | null;
}

export interface MaterializeKnownDealsSummary {
  dry_run: boolean;
  org_id: string;
  scanned: number;
  created: number;
  updated: number;
  already_linked: number;
  skipped_no_company: number;
  conflicts: Array<{ deal_id: string; reason: string }>;
  results: Array<{
    deal_id: string;
    company_id: string | null;
    company_name: string | null;
    action: EnsureProspectForDealResult['action'] | 'conflict';
    prospect_id: string | null;
  }>;
}

function parseArgs(argv: string[]): Args {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) raw.set(key, 'true');
    else {
      raw.set(key, next);
      i += 1;
    }
  }
  const limit = Number(raw.get('limit') || 10_000);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('INVALID_LIMIT');
  return {
    orgId: raw.get('org-id') || 'medina-ventures',
    configPath: raw.get('config') || 'wrangler.toml',
    apply: raw.get('apply') === 'true',
    confirmProductionWrite: raw.get('confirm-production-write') === 'true',
    limit: Math.floor(limit),
  };
}

async function loadOpenDealCandidates(orgId: string, env: Env, limit: number): Promise<DealCandidate[]> {
  const rows = await env.D1.prepare(
    `SELECT d.id AS deal_id,
            d.company_id,
            c.name AS company_name,
            p.id AS existing_prospect_id
       FROM deals d
       LEFT JOIN companies c
         ON c.id = d.company_id
        AND c.org_id = d.org_id
        AND c.deleted_at IS NULL
       LEFT JOIN prospects p
         ON p.org_id = d.org_id
        AND p.deal_id = d.id
        AND p.deleted_at IS NULL
      WHERE d.org_id = ?
        AND d.deleted_at IS NULL
        AND d.stage != 'closed'
      ORDER BY d.created_at ASC, d.id ASC
      LIMIT ?`
  ).bind(orgId, limit).all<DealCandidate>();
  return rows.results || [];
}

async function prospectExistsByNormalizedName(orgId: string, normalizedName: string, env: Env): Promise<string | null> {
  const row = await env.D1.prepare(
    `SELECT id
       FROM prospects
      WHERE org_id = ? AND normalized_name = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(orgId, normalizedName).first<{ id: string }>();
  return row?.id || null;
}

export async function materializeKnownDeals(
  orgId: string,
  env: Env,
  options: { apply?: boolean; limit?: number } = {}
): Promise<MaterializeKnownDealsSummary> {
  const apply = options.apply === true;
  const rows = await loadOpenDealCandidates(orgId, env, options.limit || 10_000);
  const summary: MaterializeKnownDealsSummary = {
    dry_run: !apply,
    org_id: orgId,
    scanned: rows.length,
    created: 0,
    updated: 0,
    already_linked: 0,
    skipped_no_company: 0,
    conflicts: [],
    results: [],
  };

  for (const row of rows) {
    if (!row.company_id || !row.company_name) {
      summary.skipped_no_company++;
      summary.results.push({
        deal_id: row.deal_id,
        company_id: row.company_id,
        company_name: row.company_name,
        action: 'skipped_no_deal',
        prospect_id: null,
      });
      continue;
    }

    try {
      if (!apply) {
        if (row.existing_prospect_id) {
          summary.already_linked++;
          summary.results.push({ ...row, action: 'already_linked', prospect_id: row.existing_prospect_id });
          continue;
        }
        const existingNameProspect = await prospectExistsByNormalizedName(orgId, normalizeProspectName(row.company_name), env);
        if (existingNameProspect) {
          summary.updated++;
          summary.results.push({ ...row, action: 'updated', prospect_id: existingNameProspect });
        } else {
          summary.created++;
          summary.results.push({ ...row, action: 'created', prospect_id: null });
        }
        continue;
      }

      const result = await ensureProspectForDeal(orgId, row.deal_id, env);
      if (result.action === 'created') summary.created++;
      else if (result.action === 'updated') summary.updated++;
      else if (result.action === 'already_linked') summary.already_linked++;
      else summary.skipped_no_company++;
      summary.results.push({
        deal_id: row.deal_id,
        company_id: result.companyId,
        company_name: row.company_name,
        action: result.action,
        prospect_id: result.prospectId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      summary.conflicts.push({ deal_id: row.deal_id, reason });
      summary.results.push({
        deal_id: row.deal_id,
        company_id: row.company_id,
        company_name: row.company_name,
        action: 'conflict',
        prospect_id: null,
      });
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply && !args.confirmProductionWrite) {
    throw new Error('APPLY_REQUIRES_EXPLICIT_GO: rerun with --apply --confirm-production-write true only after Lucas GO');
  }
  const proxy = await getPlatformProxy({ configPath: args.configPath });
  try {
    const summary = await materializeKnownDeals(args.orgId, proxy.env as unknown as Env, {
      apply: args.apply,
      limit: args.limit,
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

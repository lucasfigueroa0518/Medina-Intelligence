import type { Env } from '../types/env';
import type { AuthContext } from '../types/interfaces';

export type FirmRelationshipState =
  | 'current_portfolio'
  | 'active_pipeline'
  | 'watchlist'
  | 'passed'
  | 'exited'
  | 'unknown';

export interface FirmRelationshipClassificationInput {
  id?: string;
  name: string;
  company_type?: string | null;
  investment_status?: string | null;
  tags?: string[];
  active_deal_count?: number;
  active_deals?: string[];
  relationship_states?: string[];
  authoritative_current_portfolio_active?: boolean;
}

export interface FirmRelationshipClassification {
  state: FirmRelationshipState;
  confidence: 'authoritative' | 'high' | 'medium' | 'low';
  reasons: string[];
  warnings: string[];
}

export interface FirmRelationshipCompany extends FirmRelationshipClassificationInput {
  domain?: string | null;
  website?: string | null;
  sector?: string | null;
  stage?: string | null;
  last_known_valuation?: number | null;
  investment_amount?: number | null;
  investment_date?: string | null;
  classification: FirmRelationshipClassification;
}

export interface FirmRelationshipSnapshot {
  current_portfolio: FirmRelationshipCompany[];
  active_pipeline: FirmRelationshipCompany[];
  watchlist: FirmRelationshipCompany[];
  passed: FirmRelationshipCompany[];
  exited: FirmRelationshipCompany[];
  unknown: FirmRelationshipCompany[];
  counts: Record<FirmRelationshipState, number>;
  classification_rules: string[];
  data_quality_warnings: string[];
  sources: Array<Record<string, unknown>>;
}

const CLOSED_DEAL_STAGES = new Set(['closed', 'closed_won', 'closed_lost']);
const PIPELINE_STATUSES = new Set(['prospect', 'due_diligence', 'term_sheet']);
const WATCHLIST_STATUSES = new Set(['tracking']);
const PORTFOLIO_TAGS = new Set(['portfolio', 'current portfolio', 'portfolio company']);
const FOUNDATIONAL_PORTFOLIO_NAME_KEYS = new Set([
  'tier4ai',
  'tierfourai',
  'qnect',
  'qunnect',
  'hedgehog',
  'hedgehogai',
  'neuralseek',
  'neuralseekai',
  'neuralseekinc',
]);
const FOUNDATIONAL_PORTFOLIO_LIKE_PATTERNS = [
  '%tier%4%ai%',
  '%tier%four%ai%',
  '%qnect%',
  '%qunnect%',
  '%hedgehog%',
  '%neural%seek%',
];

export function isOpenDealStage(stage: unknown): boolean {
  const value = String(stage || '').trim().toLowerCase();
  return !!value && !CLOSED_DEAL_STAGES.has(value);
}

export function normalizeCompanyNameKey(name: unknown): string {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

export function isFoundationalPortfolioCompanyName(name: unknown): boolean {
  const key = normalizeCompanyNameKey(name);
  if (FOUNDATIONAL_PORTFOLIO_NAME_KEYS.has(key)) return true;
  return key.includes('tier4ai')
    || key.includes('tierfourai')
    || key.includes('qnect')
    || key.includes('qunnect')
    || key.includes('hedgehog')
    || key.includes('neuralseek');
}

function hasPortfolioMarker(input: FirmRelationshipClassificationInput): boolean {
  const companyType = String(input.company_type || '').toLowerCase();
  const investmentStatus = String(input.investment_status || '').toLowerCase();
  const tags = (input.tags || []).map(tag => tag.toLowerCase());
  return companyType === 'portfolio'
    || investmentStatus === 'invested'
    || tags.some(tag => PORTFOLIO_TAGS.has(tag));
}

function normalizeStates(states: string[] | undefined): Set<string> {
  return new Set((states || []).map(state => state.trim().toLowerCase()).filter(Boolean));
}

export function classifyFirmRelationship(
  input: FirmRelationshipClassificationInput
): FirmRelationshipClassification {
  const relationshipStates = normalizeStates(input.relationship_states);
  const investmentStatus = String(input.investment_status || '').toLowerCase();
  const activeDealCount = Number(input.active_deal_count || 0);
  const activeDeals = input.active_deals || [];
  const hasAuthority = !!input.authoritative_current_portfolio_active;
  const portfolioMarker = hasPortfolioMarker(input);
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (relationshipStates.has('current_portfolio')) {
    reasons.push('Authoritative firm relationship row marks this company as current_portfolio.');
    if (investmentStatus && investmentStatus !== 'invested') {
      warnings.push(`CRM investment_status is "${investmentStatus}" but firm relationship says current_portfolio.`);
    }
    return { state: 'current_portfolio', confidence: 'authoritative', reasons, warnings };
  }

  if (relationshipStates.has('exited') || investmentStatus === 'exited') {
    reasons.push(relationshipStates.has('exited')
      ? 'Authoritative firm relationship row marks this company as exited.'
      : 'CRM investment_status is exited.');
    return { state: 'exited', confidence: relationshipStates.has('exited') ? 'authoritative' : 'high', reasons, warnings };
  }

  if (relationshipStates.has('passed') || investmentStatus === 'passed') {
    reasons.push(relationshipStates.has('passed')
      ? 'Authoritative firm relationship row marks this company as passed.'
      : 'CRM investment_status is passed.');
    return { state: 'passed', confidence: relationshipStates.has('passed') ? 'authoritative' : 'high', reasons, warnings };
  }

  if (relationshipStates.has('active_pipeline')) {
    reasons.push('Authoritative firm relationship row marks this company as active_pipeline.');
    if (portfolioMarker) warnings.push('CRM has a portfolio marker, but the authoritative firm relationship table does not mark this as current portfolio.');
    return { state: 'active_pipeline', confidence: 'authoritative', reasons, warnings };
  }

  if (relationshipStates.has('watchlist')) {
    reasons.push('Authoritative firm relationship row marks this company as watchlist.');
    if (portfolioMarker) warnings.push('CRM has a portfolio marker, but the authoritative firm relationship table does not mark this as current portfolio.');
    return { state: 'watchlist', confidence: 'authoritative', reasons, warnings };
  }

  if (hasAuthority && portfolioMarker) {
    warnings.push('CRM/tag data suggests portfolio, but current portfolio is governed by the authoritative firm relationship table and this company is not on that active allowlist.');
  } else if (!hasAuthority && portfolioMarker) {
    reasons.push('CRM company_type/investment_status/tag marks this company as portfolio/invested.');
    return { state: 'current_portfolio', confidence: 'high', reasons, warnings };
  }

  if (activeDealCount > 0 || PIPELINE_STATUSES.has(investmentStatus)) {
    if (activeDealCount > 0) reasons.push(`Has ${activeDealCount} active deal${activeDealCount === 1 ? '' : 's'}${activeDeals.length ? `: ${activeDeals.slice(0, 3).join('; ')}` : ''}.`);
    if (PIPELINE_STATUSES.has(investmentStatus)) reasons.push(`CRM investment_status is ${investmentStatus}.`);
    return { state: 'active_pipeline', confidence: activeDealCount > 0 ? 'high' : 'medium', reasons, warnings };
  }

  if (WATCHLIST_STATUSES.has(investmentStatus)) {
    reasons.push(`CRM investment_status is ${investmentStatus}.`);
    return { state: 'watchlist', confidence: 'medium', reasons, warnings };
  }

  reasons.push('No authoritative portfolio row, active deal, or investment-status signal found.');
  return { state: 'unknown', confidence: 'low', reasons, warnings };
}

export async function loadFirmRelationshipSnapshot(
  ctx: AuthContext,
  env: Env,
  opts: { includePipeline?: boolean; limit?: number } = {}
): Promise<FirmRelationshipSnapshot> {
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const relationshipTableAvailable = await hasRelationshipTable(ctx, env);
  if (relationshipTableAvailable) {
    await reconcileFoundationalPortfolioRelationships(ctx, env).catch(error => {
      console.warn('[firm-state] foundational portfolio reconciliation failed:', error?.message || error);
    });
  }
  const authoritativeCurrentCount = relationshipTableAvailable
    ? await currentPortfolioRelationshipCount(ctx, env)
    : 0;
  const authoritativeCurrentPortfolioActive = authoritativeCurrentCount > 0;
  const rows = await fetchCompanyStateRows(ctx, env, relationshipTableAvailable, limit);
  const buckets: Record<FirmRelationshipState, FirmRelationshipCompany[]> = {
    current_portfolio: [],
    active_pipeline: [],
    watchlist: [],
    passed: [],
    exited: [],
    unknown: [],
  };
  const dataQualityWarnings: string[] = [];

  for (const row of rows) {
    const tags = splitList(row.tag_names);
    const activeDeals = splitList(row.active_deals);
    const relationshipStates = splitList(row.relationship_states);
    const input: FirmRelationshipClassificationInput = {
      id: row.id,
      name: row.name,
      company_type: row.company_type,
      investment_status: row.investment_status,
      tags,
      active_deal_count: Number(row.active_deal_count || 0),
      active_deals: activeDeals,
      relationship_states: relationshipStates,
      authoritative_current_portfolio_active: authoritativeCurrentPortfolioActive,
    };
    const classification = classifyFirmRelationship(input);
    const company: FirmRelationshipCompany = {
      ...input,
      domain: row.domain,
      website: row.website,
      sector: row.sector,
      stage: row.stage,
      last_known_valuation: normalizeNumber(row.last_known_valuation),
      investment_amount: normalizeNumber(row.investment_amount),
      investment_date: row.investment_date,
      classification,
    };
    buckets[classification.state].push(company);
    for (const warning of classification.warnings) {
      dataQualityWarnings.push(`${row.name}: ${warning}`);
    }
  }

  sortCompanies(buckets.current_portfolio);
  sortCompanies(buckets.active_pipeline);
  sortCompanies(buckets.watchlist);
  sortCompanies(buckets.passed);
  sortCompanies(buckets.exited);
  sortCompanies(buckets.unknown);

  const visibleCompanies = [
    ...buckets.current_portfolio,
    ...(opts.includePipeline === false ? [] : buckets.active_pipeline),
    ...(opts.includePipeline === false ? [] : buckets.watchlist),
  ];

  return {
    current_portfolio: buckets.current_portfolio,
    active_pipeline: opts.includePipeline === false ? [] : buckets.active_pipeline,
    watchlist: opts.includePipeline === false ? [] : buckets.watchlist,
    passed: buckets.passed,
    exited: buckets.exited,
    unknown: buckets.unknown,
    counts: {
      current_portfolio: buckets.current_portfolio.length,
      active_pipeline: buckets.active_pipeline.length,
      watchlist: buckets.watchlist.length,
      passed: buckets.passed.length,
      exited: buckets.exited.length,
      unknown: buckets.unknown.length,
    },
    classification_rules: [
      'Current portfolio is authoritative when firm_company_relationships has active current_portfolio rows; CRM tags/fields become supporting evidence only.',
      'Pipeline means active non-closed deals or explicit prospect/due_diligence/term_sheet status, unless the company is already current portfolio.',
      'Watchlist/tracking is separate from active pipeline and current portfolio.',
      'Exited and passed are never treated as current portfolio unless explicitly asked for historical investments.',
    ],
    data_quality_warnings: dataQualityWarnings,
    sources: visibleCompanies.slice(0, 80).map(company => ({
      type: 'company',
      source_table: 'companies',
      source_id: company.id,
      entity_id: company.id,
      title: company.name,
      subtitle: company.classification.state,
      description: company.classification.reasons.join(' '),
      excerpt: [
        `Firm relationship: ${company.classification.state}`,
        company.company_type ? `company_type=${company.company_type}` : null,
        company.investment_status ? `investment_status=${company.investment_status}` : null,
        company.active_deal_count ? `active_deals=${company.active_deal_count}` : null,
      ].filter(Boolean).join('; '),
    })),
  };
}

async function hasRelationshipTable(ctx: AuthContext, env: Env): Promise<boolean> {
  try {
    await env.D1.prepare(
      `SELECT 1 FROM firm_company_relationships WHERE org_id = ? LIMIT 1`
    ).bind(ctx.orgId).first();
    return true;
  } catch {
    return false;
  }
}

async function currentPortfolioRelationshipCount(ctx: AuthContext, env: Env): Promise<number> {
  const row = await env.D1.prepare(
    `SELECT COUNT(*) AS count
       FROM firm_company_relationships
      WHERE org_id = ?
        AND relationship_state = 'current_portfolio'
        AND ended_at IS NULL`
  ).bind(ctx.orgId).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function reconcileFoundationalPortfolioRelationships(ctx: AuthContext, env: Env): Promise<void> {
  const now = new Date().toISOString();
  const where = [
    `lower(replace(replace(replace(replace(co.name, ' ', ''), '-', ''), '_', ''), '.', '')) IN (${Array.from(FOUNDATIONAL_PORTFOLIO_NAME_KEYS).map(() => '?').join(',')})`,
    ...FOUNDATIONAL_PORTFOLIO_LIKE_PATTERNS.map(() => 'lower(co.name) LIKE ?'),
  ].join(' OR ');
  await env.D1.prepare(
    `INSERT OR IGNORE INTO firm_company_relationships (
       id,
       org_id,
       company_id,
       relationship_state,
       source,
       confidence,
       effective_date,
       notes,
       created_at,
       updated_at
     )
     SELECT
       lower(hex(randomblob(16))),
       co.org_id,
       co.id,
       'current_portfolio',
       'foundational_runtime_reconciliation',
       1.0,
       '2026-05-17',
       'Runtime reconciliation for Medina current portfolio: Tier 4 AI, QNECT/Qunnect, Hedgehog, NeuralSeek.',
       ?,
       ?
      FROM companies co
     WHERE co.org_id = ?
       AND co.deleted_at IS NULL
       AND COALESCE(co.is_internal_entity, 0) = 0
       AND (${where})`
  ).bind(
    now,
    now,
    ctx.orgId,
    ...Array.from(FOUNDATIONAL_PORTFOLIO_NAME_KEYS),
    ...FOUNDATIONAL_PORTFOLIO_LIKE_PATTERNS
  ).run();
}

export async function upsertFirmCompanyRelationship(
  ctx: AuthContext,
  env: Env,
  input: {
    company_id?: string | null;
    company_name?: string | null;
    relationship_state?: 'current_portfolio' | 'active_pipeline' | 'watchlist' | 'passed' | 'exited' | 'other';
    effective_date?: string | null;
    notes?: string | null;
    create_if_missing?: boolean;
  }
): Promise<{
  company_id: string;
  company_name: string;
  relationship_state: string;
  created_company: boolean;
  relationship_inserted: boolean;
}> {
  const relationshipState = input.relationship_state || 'current_portfolio';
  let company = input.company_id
    ? await fetchCompanyById(ctx, env, input.company_id)
    : null;
  let createdCompany = false;

  if (!company && input.company_name) {
    company = await resolveCompanyByName(ctx, env, input.company_name);
  }

  if (!company && input.company_name && input.create_if_missing !== false) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.D1.prepare(
      `INSERT INTO companies (id, org_id, name, company_type, investment_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      ctx.orgId,
      input.company_name.trim(),
      relationshipState === 'current_portfolio' ? 'portfolio' : 'startup',
      relationshipState === 'current_portfolio' ? 'invested' : 'tracking',
      now,
      now
    ).run();
    company = { id, name: input.company_name.trim() };
    createdCompany = true;
  }

  if (!company) {
    throw new Error('COMPANY_NOT_FOUND');
  }

  const now = new Date().toISOString();
  await env.D1.prepare(
    `UPDATE firm_company_relationships
        SET ended_at = ?,
            updated_at = ?
      WHERE org_id = ?
        AND company_id = ?
        AND ended_at IS NULL
        AND relationship_state != ?`
  ).bind(now, now, ctx.orgId, company.id, relationshipState).run();

  const relationshipId = crypto.randomUUID();
  const insert = await env.D1.prepare(
    `INSERT OR IGNORE INTO firm_company_relationships (
       id,
       org_id,
       company_id,
       relationship_state,
       source,
       confidence,
       effective_date,
       notes,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, 'marty_user_assertion', 1.0, ?, ?, ?, ?)`
  ).bind(
    relationshipId,
    ctx.orgId,
    company.id,
    relationshipState,
    input.effective_date || now.slice(0, 10),
    input.notes || null,
    now,
    now
  ).run();

  await env.D1.prepare(
    `UPDATE firm_company_relationships
        SET source = 'marty_user_assertion',
            confidence = 1.0,
            effective_date = COALESCE(?, effective_date),
            notes = COALESCE(?, notes),
            updated_at = ?
      WHERE org_id = ?
        AND company_id = ?
        AND relationship_state = ?
        AND ended_at IS NULL`
  ).bind(
    input.effective_date || null,
    input.notes || null,
    now,
    ctx.orgId,
    company.id,
    relationshipState
  ).run();

  if (relationshipState === 'current_portfolio') {
    await env.D1.prepare(
      `UPDATE companies
          SET company_type = 'portfolio',
              investment_status = 'invested',
              updated_at = ?
        WHERE id = ?
          AND org_id = ?
          AND deleted_at IS NULL`
    ).bind(now, company.id, ctx.orgId).run();
  }

  return {
    company_id: company.id,
    company_name: company.name,
    relationship_state: relationshipState,
    created_company: createdCompany,
    relationship_inserted: (insert.meta?.changes || 0) > 0,
  };
}

async function fetchCompanyById(
  ctx: AuthContext,
  env: Env,
  companyId: string
): Promise<{ id: string; name: string } | null> {
  return env.D1.prepare(
    `SELECT id, name FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`
  ).bind(companyId, ctx.orgId).first<{ id: string; name: string }>();
}

async function resolveCompanyByName(
  ctx: AuthContext,
  env: Env,
  companyName: string
): Promise<{ id: string; name: string } | null> {
  const trimmed = companyName.trim();
  const key = normalizeCompanyNameKey(trimmed);
  const exact = await env.D1.prepare(
    `SELECT id, name FROM companies
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND lower(name) = lower(?)
      LIMIT 1`
  ).bind(ctx.orgId, trimmed).first<{ id: string; name: string }>();
  if (exact) return exact;

  const normalized = await env.D1.prepare(
    `SELECT id, name FROM companies
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND lower(replace(replace(replace(replace(name, ' ', ''), '-', ''), '_', ''), '.', '')) = ?
      LIMIT 1`
  ).bind(ctx.orgId, key).first<{ id: string; name: string }>();
  if (normalized) return normalized;

  const contains = await env.D1.prepare(
    `SELECT id, name FROM companies
      WHERE org_id = ?
        AND deleted_at IS NULL
        AND lower(name) LIKE ?
      ORDER BY length(name) ASC
      LIMIT 1`
  ).bind(ctx.orgId, `%${trimmed.toLowerCase()}%`).first<{ id: string; name: string }>();
  return contains || null;
}

async function fetchCompanyStateRows(
  ctx: AuthContext,
  env: Env,
  relationshipTableAvailable: boolean,
  limit: number
): Promise<any[]> {
  const relationshipSelect = relationshipTableAvailable
    ? `GROUP_CONCAT(DISTINCT fcr.relationship_state) AS relationship_states,`
    : `NULL AS relationship_states,`;
  const relationshipJoin = relationshipTableAvailable
    ? `LEFT JOIN firm_company_relationships fcr
         ON fcr.company_id = co.id
        AND fcr.org_id = co.org_id
        AND fcr.ended_at IS NULL`
    : '';

  const result = await env.D1.prepare(
    `SELECT
        co.id,
        co.name,
        co.domain,
        co.website,
        co.sector,
        co.stage,
        co.company_type,
        co.investment_status,
        co.last_known_valuation,
        co.investment_amount,
        co.investment_date,
        GROUP_CONCAT(DISTINCT t.name) AS tag_names,
        ${relationshipSelect}
        COUNT(DISTINCT CASE
          WHEN d.deleted_at IS NULL
           AND d.stage NOT IN ('closed','closed_won','closed_lost')
          THEN d.id
        END) AS active_deal_count,
        GROUP_CONCAT(DISTINCT CASE
          WHEN d.deleted_at IS NULL
           AND d.stage NOT IN ('closed','closed_won','closed_lost')
          THEN d.title || ' (' || d.stage || ')'
        END) AS active_deals
       FROM companies co
       LEFT JOIN company_tags ct ON ct.company_id = co.id
       LEFT JOIN tags t ON t.id = ct.tag_id AND t.org_id = co.org_id
       ${relationshipJoin}
       LEFT JOIN deals d ON d.company_id = co.id AND d.org_id = co.org_id
      WHERE co.org_id = ?
        AND co.deleted_at IS NULL
        AND COALESCE(co.is_internal_entity, 0) = 0
      GROUP BY co.id
      ORDER BY
        CASE
          WHEN ${relationshipTableAvailable ? "MAX(CASE WHEN fcr.relationship_state = 'current_portfolio' THEN 1 ELSE 0 END) = 1" : "0"} THEN 0
          WHEN co.company_type = 'portfolio' OR co.investment_status = 'invested' THEN 1
          WHEN COUNT(DISTINCT CASE
            WHEN d.deleted_at IS NULL
             AND d.stage NOT IN ('closed','closed_won','closed_lost')
            THEN d.id
          END) > 0 THEN 2
          ELSE 3
        END,
        co.name ASC
      LIMIT ?`
  ).bind(ctx.orgId, limit).all();
  return result.results as any[];
}

function splitList(value: unknown): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sortCompanies(companies: FirmRelationshipCompany[]): void {
  companies.sort((a, b) => a.name.localeCompare(b.name));
}

export const __firmRelationshipStateTestHooks = {
  classifyFirmRelationship,
  isFoundationalPortfolioCompanyName,
  isOpenDealStage,
  normalizeCompanyNameKey,
};

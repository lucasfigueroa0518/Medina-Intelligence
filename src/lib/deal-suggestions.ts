import type { Env } from '../types/env';
import { isCompanyInternal } from './internal-entity';

export const DEAL_STAGES = ['new', 'talking', 'due_diligence', 'term_sheet', 'closed'] as const;
export type DealStage = typeof DEAL_STAGES[number];

export const FUNDING_STAGES = [
  'pre_seed',
  'seed',
  'series_a',
  'series_b',
  'series_c',
  'series_d',
  'series_e_plus',
  'growth',
  'bridge',
  'secondary',
  'debt',
  'unknown',
] as const;
export type FundingStage = typeof FUNDING_STAGES[number];

export const REQUIRED_SUGGESTION_EVIDENCE = 4;
export const MIN_STRONG_EVIDENCE_CONFIDENCE = 0.78;
export const MIN_SUGGESTION_SOURCE_FAMILIES = 2;

export interface DealEvidenceSignal {
  orgId: string;
  companyId: string;
  sourceType: 'conversation' | 'event' | 'document';
  sourceId: string;
  sourceTitle?: string | null;
  sourceExcerpt?: string | null;
  sourceDate?: string | null;
  signalKind?: string | null;
  fundingStage?: string | null;
  amountUsd?: number | null;
  confidence: number;
  evidenceNote?: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
  is_internal_entity: number | null;
}

interface EvidenceRow {
  id: string;
  source_type: 'conversation' | 'event' | 'document';
  source_id: string;
  source_title: string | null;
  source_excerpt: string | null;
  source_date: string | null;
  signal_kind: string | null;
  funding_stage: string | null;
  amount_usd: number | null;
  confidence: number;
  evidence_note: string | null;
  created_at: string;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function normalizeFundingStage(raw: string | null | undefined): FundingStage | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['preseed', 'pre_seed', 'pre'].includes(s)) return 'pre_seed';
  if (['seed'].includes(s)) return 'seed';
  if (['series_a', 'a'].includes(s)) return 'series_a';
  if (['series_b', 'b'].includes(s)) return 'series_b';
  if (['series_c', 'c'].includes(s)) return 'series_c';
  if (['series_d', 'd'].includes(s)) return 'series_d';
  if (['series_e', 'series_f', 'series_g', 'series_e_plus', 'late_stage'].includes(s)) return 'series_e_plus';
  if (['growth', 'growth_equity'].includes(s)) return 'growth';
  if (['bridge', 'extension', 'seed_extension'].includes(s)) return 'bridge';
  if (['secondary'].includes(s)) return 'secondary';
  if (['debt', 'venture_debt', 'credit'].includes(s)) return 'debt';
  if (['unknown', 'undisclosed'].includes(s)) return 'unknown';
  return null;
}

function normalizeSignalKind(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || null;
}

async function getExternalCompany(companyId: string, orgId: string, env: Env): Promise<CompanyRow | null> {
  const company = await env.D1.prepare(
    `SELECT id, name, is_internal_entity
       FROM companies
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
  ).bind(companyId, orgId).first<CompanyRow>();
  if (!company) return null;
  if (company.is_internal_entity === 1) return null;
  if (await isCompanyInternal(companyId, orgId, env)) return null;
  return company;
}

async function findOpenDeal(companyId: string, orgId: string, env: Env): Promise<{ id: string; stage: DealStage } | null> {
  return env.D1.prepare(
    `SELECT id, stage
       FROM deals
      WHERE org_id = ? AND company_id = ?
        AND deleted_at IS NULL
        AND stage != 'closed'
      LIMIT 1`
  ).bind(orgId, companyId).first<{ id: string; stage: DealStage }>();
}

async function fetchStrongEvidence(companyId: string, orgId: string, env: Env): Promise<EvidenceRow[]> {
  const rows = await env.D1.prepare(
    `SELECT id, source_type, source_id, source_title, source_excerpt,
            source_date, signal_kind, funding_stage, amount_usd,
            confidence, evidence_note, created_at
       FROM deal_suggestion_evidence
      WHERE org_id = ? AND company_id = ? AND confidence >= ?
      ORDER BY COALESCE(source_date, created_at) DESC, confidence DESC
      LIMIT 20`
  ).bind(orgId, companyId, MIN_STRONG_EVIDENCE_CONFIDENCE).all<EvidenceRow>();
  return rows.results;
}

function summarizeEvidenceForMetadata(rows: EvidenceRow[]): Array<Record<string, unknown>> {
  return rows.slice(0, 8).map(r => ({
    id: r.id,
    type: r.source_type,
    source_id: r.source_id,
    title: r.source_title,
    date: r.source_date,
    confidence: r.confidence,
    signal_kind: r.signal_kind,
    funding_stage: r.funding_stage,
    note: r.evidence_note,
  }));
}

function chooseFundingStage(rows: EvidenceRow[]): FundingStage | null {
  for (const row of rows) {
    const normalized = normalizeFundingStage(row.funding_stage);
    if (normalized) return normalized;
  }
  return null;
}

function chooseAmount(rows: EvidenceRow[]): number | null {
  const amounts = rows
    .map(r => Number(r.amount_usd))
    .filter(v => Number.isFinite(v) && v > 0);
  return amounts.length ? Math.max(...amounts) : null;
}

function evidenceDate(row: EvidenceRow): string {
  return row.source_date || row.created_at;
}

async function linkEvidenceToDeal(
  dealId: string,
  orgId: string,
  rows: EvidenceRow[],
  env: Env
): Promise<void> {
  const { linkConversationToDeal, linkEventToDeal } = await import('./deal-association');
  const stmts: D1PreparedStatement[] = [];

  for (const row of rows) {
    if (row.source_type === 'conversation') {
      await linkConversationToDeal(row.source_id, dealId, 'llm_classification', row.confidence, orgId, env);
    } else if (row.source_type === 'event') {
      await linkEventToDeal(row.source_id, dealId, 'llm_classification', row.confidence, orgId, env);
    } else if (row.source_type === 'document') {
      stmts.push(env.D1.prepare(
        `INSERT OR IGNORE INTO document_links
           (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, 'deal', ?, 'derived', 'llm_extracted',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(row.source_id, orgId, dealId));
    }
  }

  if (stmts.length > 0) await env.D1.batch(stmts);

  await env.D1.prepare(
    `UPDATE deal_suggestion_evidence
        SET deal_id = ?, promoted_at = COALESCE(promoted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE org_id = ? AND id IN (${rows.map(() => '?').join(',')})`
  ).bind(dealId, orgId, ...rows.map(r => r.id)).run();
}

async function refreshDealEvidenceSummary(
  dealId: string,
  orgId: string,
  companyId: string,
  rows: EvidenceRow[],
  env: Env
): Promise<void> {
  const sorted = rows.slice().sort((a, b) => evidenceDate(a).localeCompare(evidenceDate(b)));
  const firstSeen = sorted[0] ? evidenceDate(sorted[0]) : null;
  const lastSeen = sorted[sorted.length - 1] ? evidenceDate(sorted[sorted.length - 1]) : null;
  const fundingStage = chooseFundingStage(rows);
  const sourceFamilies = Array.from(new Set(rows.map(r => r.source_type)));
  const metadata = {
    suggestion: {
      required_evidence: REQUIRED_SUGGESTION_EVIDENCE,
      source_families: sourceFamilies,
      evidence: summarizeEvidenceForMetadata(rows),
    },
  };

  await env.D1.prepare(
    `UPDATE deals
        SET suggestion_evidence_count = ?,
            evidence_first_seen_at = COALESCE(evidence_first_seen_at, ?),
            evidence_last_seen_at = ?,
            last_activity_date = COALESCE(?, last_activity_date),
            funding_stage = COALESCE(funding_stage, ?),
            source_metadata = json_patch(COALESCE(source_metadata, '{}'), ?),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND org_id = ? AND company_id = ?`
  ).bind(
    rows.length,
    firstSeen,
    lastSeen,
    lastSeen,
    fundingStage,
    JSON.stringify(metadata),
    dealId,
    orgId,
    companyId
  ).run();
}

async function promoteIfQualified(
  company: CompanyRow,
  orgId: string,
  env: Env
): Promise<{ promoted: boolean; dealId: string | null; reason: string }> {
  const existing = await findOpenDeal(company.id, orgId, env);
  const rows = await fetchStrongEvidence(company.id, orgId, env);

  if (existing) {
    if (rows.length > 0) {
      await linkEvidenceToDeal(existing.id, orgId, rows, env);
      await refreshDealEvidenceSummary(existing.id, orgId, company.id, rows, env);
    }
    return { promoted: false, dealId: existing.id, reason: 'existing_open_deal' };
  }

  const sourceFamilies = new Set(rows.map(r => r.source_type));
  if (rows.length < REQUIRED_SUGGESTION_EVIDENCE) {
    return { promoted: false, dealId: null, reason: 'not_enough_evidence' };
  }
  if (sourceFamilies.size < MIN_SUGGESTION_SOURCE_FAMILIES) {
    return { promoted: false, dealId: null, reason: 'not_enough_source_families' };
  }

  const dealId = crypto.randomUUID();
  const now = new Date().toISOString();
  const firstSeen = rows.reduce((min, row) => evidenceDate(row) < min ? evidenceDate(row) : min, evidenceDate(rows[0]));
  const lastSeen = rows.reduce((max, row) => evidenceDate(row) > max ? evidenceDate(row) : max, evidenceDate(rows[0]));
  const avgConfidence = rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length;
  const fundingStage = chooseFundingStage(rows);
  const amount = chooseAmount(rows);
  const sourceFamiliesLabel = Array.from(sourceFamilies).sort().join(', ');
  const sourceMetadata = {
    origin: {
      source_kind: 'ai_suggestion',
      approved_by: null,
      approved_at: null,
      confidence: avgConfidence,
      evidence: `${rows.length} corroborating evidence records across ${sourceFamiliesLabel}`,
    },
    suggestion: {
      required_evidence: REQUIRED_SUGGESTION_EVIDENCE,
      source_families: Array.from(sourceFamilies),
      evidence: summarizeEvidenceForMetadata(rows),
    },
  };

  await env.D1.prepare(
    `INSERT INTO deals
       (id, org_id, company_id, owner_id, title, stage, amount, currency,
        probability, lead_source, stage_changed_at, last_activity_date,
        days_in_stage, created_at, updated_at, source_metadata, funding_stage,
        evidence_first_seen_at, evidence_last_seen_at, suggestion_evidence_count)
     VALUES (?, ?, ?, NULL, ?, 'new', ?, 'USD', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    dealId,
    orgId,
    company.id,
    company.name,
    amount,
    avgConfidence,
    'AI-surfaced from internal evidence',
    now,
    lastSeen,
    now,
    now,
    JSON.stringify(sourceMetadata),
    fundingStage,
    firstSeen,
    lastSeen,
    rows.length
  ).run();

  await linkEvidenceToDeal(dealId, orgId, rows, env);

  try {
    const { linkContactsByCompanyMatch } = await import('./deal-association');
    await linkContactsByCompanyMatch(dealId, orgId, env);
  } catch (e) {
    console.error(`[deal-suggestions] contact auto-link failed for ${dealId}:`, e);
  }

  try {
    const { embedDeal } = await import('./embedding');
    await embedDeal(dealId, orgId, env);
  } catch (e) {
    console.error(`[deal-suggestions] embed failed for ${dealId}:`, e);
  }

  return { promoted: true, dealId, reason: 'qualified' };
}

export async function recordDealEvidenceSignal(
  signal: DealEvidenceSignal,
  env: Env
): Promise<{ recorded: boolean; promoted: boolean; dealId: string | null; reason: string }> {
  const confidence = clampConfidence(signal.confidence);
  if (confidence < MIN_STRONG_EVIDENCE_CONFIDENCE) {
    return { recorded: false, promoted: false, dealId: null, reason: 'low_confidence' };
  }

  const company = await getExternalCompany(signal.companyId, signal.orgId, env);
  if (!company) {
    return { recorded: false, promoted: false, dealId: null, reason: 'company_missing_or_internal' };
  }

  const fundingStage = normalizeFundingStage(signal.fundingStage);
  const signalKind = normalizeSignalKind(signal.signalKind);
  const sourceExcerpt = signal.sourceExcerpt ? signal.sourceExcerpt.slice(0, 1000) : null;
  const evidenceNote = signal.evidenceNote ? signal.evidenceNote.slice(0, 500) : null;

  await env.D1.prepare(
    `INSERT INTO deal_suggestion_evidence (
       id, org_id, company_id, source_type, source_id, source_title,
       source_excerpt, source_date, signal_kind, funding_stage, amount_usd,
       confidence, evidence_note, created_at
     ) VALUES (
       lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
     )
     ON CONFLICT(org_id, company_id, source_type, source_id) DO UPDATE SET
       source_title = COALESCE(excluded.source_title, deal_suggestion_evidence.source_title),
       source_excerpt = COALESCE(excluded.source_excerpt, deal_suggestion_evidence.source_excerpt),
       source_date = COALESCE(excluded.source_date, deal_suggestion_evidence.source_date),
       signal_kind = COALESCE(excluded.signal_kind, deal_suggestion_evidence.signal_kind),
       funding_stage = COALESCE(excluded.funding_stage, deal_suggestion_evidence.funding_stage),
       amount_usd = COALESCE(excluded.amount_usd, deal_suggestion_evidence.amount_usd),
       confidence = MAX(deal_suggestion_evidence.confidence, excluded.confidence),
       evidence_note = COALESCE(excluded.evidence_note, deal_suggestion_evidence.evidence_note)`
  ).bind(
    signal.orgId,
    company.id,
    signal.sourceType,
    signal.sourceId,
    signal.sourceTitle ?? null,
    sourceExcerpt,
    signal.sourceDate ?? null,
    signalKind,
    fundingStage,
    Number.isFinite(signal.amountUsd as number) ? signal.amountUsd : null,
    confidence,
    evidenceNote
  ).run();

  const promotion = await promoteIfQualified(company, signal.orgId, env);
  return {
    recorded: true,
    promoted: promotion.promoted,
    dealId: promotion.dealId,
    reason: promotion.reason,
  };
}

// Deal signal detection — runs over freshly classified items at the end of
// each ingestion cycle. This is deliberately conservative: individual items
// only become evidence records. A suggested deal is created later, and only
// after four strong pieces of evidence corroborate the same startup company.

import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
import { LLM_PROMPTS } from '../prompts';
import { recordDealEvidenceSignal } from './deal-suggestions';

interface DealSignal {
  is_deal: boolean;
  startup_company_name: string | null;
  funding_stage: string | null;
  amount_usd: number | null;
  signal_kind: 'pitch' | 'raise' | 'diligence' | 'terms' | 'financials' | 'internal_discussion' | null;
  confidence: number;
  evidence: string;
}

function parseDealResponse(raw: string): DealSignal | null {
  try {
    const cleaned = raw
      .trim()
      .replace(/```json\s*/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.is_deal !== 'boolean') return null;
    if (typeof parsed.confidence !== 'number') return null;
    return parsed as DealSignal;
  } catch {
    return null;
  }
}

export const DEAL_KEYWORDS = [
  'raise', 'raising', 'round', 'allocation', 'check size', 'safe',
  'term sheet', 'lead investor', 'pre-seed', 'seed round', 'series a',
  'series b', 'series c', 'investment opportunity', 'pitch deck',
  'data room', 'memo', 'diligence', 'valuation cap', 'pre-money',
  'post-money', 'committed', 'fund our', 'closing this', 'wire',
  'definitive agreement',
];

export interface DealDetectionSource {
  orgId: string;
  companyId: string;
  sourceType: 'conversation' | 'event' | 'document';
  sourceId: string;
  sourceTitle?: string | null;
  sourceDate?: string | null;
  bodyText: string;
  bodyPreview?: string | null;
  fromEmail?: string | null;
  direction?: string | null;
  sourceLabel?: string | null;
}

export interface DealDetectionResult {
  recorded: boolean;
  promoted: boolean;
  dealId: string | null;
  reason: string;
  companyName?: string;
  evidence?: string | null;
  confidence?: number | null;
}

export interface DealDetectionBatchStats {
  deal_signals_staged: number;
  deal_candidates_seen: number;
  deal_candidates_scanned: number;
  deal_candidates_deferred: number;
  deal_skip_reasons: Record<string, number>;
}

function normalizeCompanyName(name: string | null | undefined): string {
  return (name || '')
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|ai|technologies|technology)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function namesReferToSameStartup(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeCompanyName(a);
  const right = normalizeCompanyName(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function looksLikeDealText(text: string | null | undefined): boolean {
  const haystack = (text || '').toLowerCase();
  if (haystack.length < 80) return false;
  return DEAL_KEYWORDS.some(kw => haystack.includes(kw));
}

// Cheap pre-filter to avoid burning Claude budget on every item. Emails,
// meetings, and Slack messages are eligible; news remains excluded because it
// does not prove this firm is actually looking at the startup.
function looksLikeDealCandidate(item: ClassifiedItem): boolean {
  if (!item.companyId) return false;
  if (item.type !== 'email' && item.type !== 'calendar_event' && item.type !== 'slack_message') return false;
  const haystack = `${item.subject || ''}\n${item.bodyText || ''}\n${item.bodyPreview || ''}`.toLowerCase();
  return looksLikeDealText(haystack);
}

function emptyBatchStats(): DealDetectionBatchStats {
  return {
    deal_signals_staged: 0,
    deal_candidates_seen: 0,
    deal_candidates_scanned: 0,
    deal_candidates_deferred: 0,
    deal_skip_reasons: {},
  };
}

function incrementReason(stats: DealDetectionBatchStats, reason: string, count = 1): void {
  const key = reason || 'unknown';
  stats.deal_skip_reasons[key] = (stats.deal_skip_reasons[key] || 0) + count;
}

function sourceTypeForClassifiedItem(item: ClassifiedItem): 'conversation' | 'event' {
  return item.type === 'calendar_event' ? 'event' : 'conversation';
}

async function enqueueDeferredDealCandidate(
  orgId: string,
  item: ClassifiedItem,
  env: Env,
  origin: string
): Promise<boolean> {
  if (!item.companyId) return false;
  const sourceType = sourceTypeForClassifiedItem(item);
  const { enqueueWork } = await import('./work-queue');
  const result = await enqueueWork(
    env,
    orgId,
    'deal_evidence_detect',
    {
      source_type: sourceType,
      source_id: item.entityId,
      company_id: item.companyId,
      origin,
      detected_at: new Date().toISOString(),
    },
    {
      upstream: 'claude',
      idempotency_key: `${orgId}:${sourceType}:${item.entityId}:${item.companyId}:deal_evidence_detect:v1`,
      priority: 15,
      max_attempts: 5,
    }
  );
  return result.inserted || Boolean(result.id);
}

export async function detectDealSignalForSource(
  source: DealDetectionSource,
  env: Env
): Promise<DealDetectionResult> {
  if (!looksLikeDealText(`${source.sourceTitle || ''}\n${source.bodyText || ''}\n${source.bodyPreview || ''}`)) {
    return { recorded: false, promoted: false, dealId: null, reason: 'keyword_prefilter' };
  }

  const company = await env.D1.prepare(
    'SELECT name FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
  ).bind(source.companyId, source.orgId).first<{ name: string }>();
  if (!company?.name) {
    return { recorded: false, promoted: false, dealId: null, reason: 'company_missing' };
  }

  const sourceKind = source.sourceLabel || source.sourceType;
  const userPrompt = `${LLM_PROMPTS.DEAL_DETECTION_USER_PREFIX}

Resolved startup company candidate: ${company.name}
Source type: ${sourceKind}
Subject: ${source.sourceTitle || '(none)'}
From: ${source.fromEmail || '(unknown)'}
Direction: ${source.direction || 'unknown'}
Date: ${source.sourceDate || '(unknown)'}

---

${truncateToTokens(source.bodyText || '', 2000)}`;

  const raw = await callClaude(
    {
      system: LLM_PROMPTS.DEAL_DETECTION_SYSTEM,
      user: userPrompt,
      max_tokens: 400,
      orgId: source.orgId,
    },
    'low',
    env
  );

  const signal = parseDealResponse(raw);
  if (!signal || !signal.is_deal) {
    return { recorded: false, promoted: false, dealId: null, reason: 'llm_not_deal', companyName: company.name };
  }
  if (signal.confidence < 0.78) {
    return {
      recorded: false,
      promoted: false,
      dealId: null,
      reason: 'low_confidence',
      companyName: company.name,
      evidence: signal.evidence,
      confidence: signal.confidence,
    };
  }
  if (!namesReferToSameStartup(signal.startup_company_name, company.name)) {
    console.log(
      `[deal-detect] skipped ambiguous target. resolved="${company.name}" extracted="${signal.startup_company_name || ''}"`
    );
    return {
      recorded: false,
      promoted: false,
      dealId: null,
      reason: 'target_mismatch',
      companyName: company.name,
      evidence: signal.evidence,
      confidence: signal.confidence,
    };
  }

  const result = await recordDealEvidenceSignal({
    orgId: source.orgId,
    companyId: source.companyId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceTitle: source.sourceTitle || company.name,
    sourceExcerpt: signal.evidence || source.bodyPreview || null,
    sourceDate: source.sourceDate || null,
    signalKind: signal.signal_kind,
    fundingStage: signal.funding_stage,
    amountUsd: signal.amount_usd,
    confidence: signal.confidence,
    evidenceNote: signal.evidence,
  }, env);

  return {
    recorded: result.recorded,
    promoted: result.promoted,
    dealId: result.dealId,
    reason: result.reason,
    companyName: company.name,
    evidence: signal.evidence,
    confidence: signal.confidence,
  };
}

export async function detectAndStageDealSignals(
  items: ClassifiedItem[],
  orgId: string,
  env: Env
): Promise<number> {
  const stats = await detectAndStageDealSignalsDetailed(items, orgId, env);
  return stats.deal_signals_staged;
}

export async function detectAndStageDealSignalsDetailed(
  items: ClassifiedItem[],
  orgId: string,
  env: Env
): Promise<DealDetectionBatchStats> {
  const stats = emptyBatchStats();
  let candidates = items.filter(looksLikeDealCandidate);
  stats.deal_candidates_seen = candidates.length;
  if (candidates.length === 0) return stats;

  // Wave 1: drop candidates whose target company is an internal Medina-side
  // entity. Otherwise the LLM keeps generating create_deal proposals for
  // Medina's own LP raises / fund closes — those are not deals.
  const candidateCompanyIds = Array.from(new Set(candidates.map(c => c.companyId!).filter(Boolean)));
  if (candidateCompanyIds.length > 0) {
    const placeholders = candidateCompanyIds.map(() => '?').join(',');
    const rows = await env.D1.prepare(
      `SELECT id FROM companies
         WHERE org_id = ? AND id IN (${placeholders}) AND is_internal_entity = 1`
    ).bind(orgId, ...candidateCompanyIds).all<{ id: string }>();
    if (rows.results.length > 0) {
      const internalSet = new Set(rows.results.map(r => r.id));
      const before = candidates.length;
      candidates = candidates.filter(c => !internalSet.has(c.companyId!));
      const skipped = before - candidates.length;
      if (skipped > 0) {
        console.log(`[deal-detect] skipped ${skipped} candidates targeting internal entities`);
        incrementReason(stats, 'internal_company', skipped);
      }
    }
  }
  if (candidates.length === 0) return stats;

  // Cap LLM calls per ingestion cycle so a noisy batch can't eat the budget.
  const MAX_LLM_CALLS = 20;
  const budget = candidates.slice(0, MAX_LLM_CALLS);
  const overflow = candidates.slice(MAX_LLM_CALLS);
  if (overflow.length > 0) {
    stats.deal_candidates_deferred = overflow.length;
    incrementReason(stats, 'llm_budget_overflow_deferred', overflow.length);
    for (const item of overflow) {
      try {
        await enqueueDeferredDealCandidate(orgId, item, env, 'llm_budget_overflow');
      } catch (e) {
        console.error('[deal-detect] failed to enqueue overflow candidate:', e);
        incrementReason(stats, 'overflow_enqueue_failed');
      }
    }
  }

  for (const item of budget) {
    const sourceType = sourceTypeForClassifiedItem(item);
    let result: DealDetectionResult;
    try {
      stats.deal_candidates_scanned++;
      result = await detectDealSignalForSource({
        orgId,
        companyId: item.companyId!,
        sourceType,
        sourceId: item.entityId,
        sourceTitle: item.subject || null,
        sourceDate: item.sentAt,
        bodyText: item.bodyText || '',
        bodyPreview: item.bodyPreview || null,
        fromEmail: item.fromEmail || null,
        direction: item.direction || null,
        sourceLabel: item.type,
      }, env);
    } catch (e) {
      console.error('[deal-detect] claude call failed:', e);
      incrementReason(stats, 'llm_error');
      continue;
    }

    if (result.recorded) {
      stats.deal_signals_staged++;
      console.log(
        `[deal-detect] recorded evidence company=${result.companyName || item.companyId} source=${sourceType}:${item.entityId} ` +
        `confidence=${result.confidence ?? 'unknown'} promotion=${result.reason}${result.dealId ? ` deal=${result.dealId}` : ''}`
      );
    } else {
      incrementReason(stats, result.reason);
    }
  }

  return stats;
}

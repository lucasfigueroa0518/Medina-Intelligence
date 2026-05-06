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

const DEAL_KEYWORDS = [
  'raise', 'raising', 'round', 'allocation', 'check size', 'safe',
  'term sheet', 'lead investor', 'pre-seed', 'seed round', 'series a',
  'series b', 'series c', 'investment opportunity', 'pitch deck',
  'data room', 'memo', 'diligence', 'valuation cap', 'pre-money',
  'post-money', 'committed', 'fund our', 'closing this', 'wire',
  'definitive agreement',
];

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

// Cheap pre-filter to avoid burning Claude budget on every item. Emails,
// meetings, and Slack messages are eligible; news remains excluded because it
// does not prove this firm is actually looking at the startup.
function looksLikeDealCandidate(item: ClassifiedItem): boolean {
  if (!item.companyId) return false;
  if (item.type !== 'email' && item.type !== 'calendar_event' && item.type !== 'slack_message') return false;
  const haystack = `${item.subject || ''}\n${item.bodyText || ''}\n${item.bodyPreview || ''}`.toLowerCase();
  if (haystack.length < 80) return false;
  return DEAL_KEYWORDS.some(kw => haystack.includes(kw));
}

export async function detectAndStageDealSignals(
  items: ClassifiedItem[],
  orgId: string,
  env: Env
): Promise<number> {
  let candidates = items.filter(looksLikeDealCandidate);
  if (candidates.length === 0) return 0;

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
      }
    }
  }
  if (candidates.length === 0) return 0;

  // Cap LLM calls per ingestion cycle so a noisy batch can't eat the budget.
  const MAX_LLM_CALLS = 20;
  const budget = candidates.slice(0, MAX_LLM_CALLS);

  let staged = 0;

  for (const item of budget) {
    const company = await env.D1.prepare(
      'SELECT name FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL'
    ).bind(item.companyId!, orgId).first<{ name: string }>();
    if (!company?.name) continue;

    const userPrompt = `${LLM_PROMPTS.DEAL_DETECTION_USER_PREFIX}

Resolved startup company candidate: ${company.name}
Source type: ${item.type}
Subject: ${item.subject || '(none)'}
From: ${item.fromEmail || '(unknown)'}
Direction: ${item.direction || 'unknown'}
Date: ${item.sentAt}

---

${truncateToTokens(item.bodyText || '', 2000)}`;

    let raw: string;
    try {
      raw = await callClaude(
        {
          system: LLM_PROMPTS.DEAL_DETECTION_SYSTEM,
          user: userPrompt,
          max_tokens: 400,
          orgId,
        },
        'low',
        env
      );
    } catch (e) {
      console.error('[deal-detect] claude call failed:', e);
      continue;
    }

    const signal = parseDealResponse(raw);
    if (!signal || !signal.is_deal) continue;
    if (signal.confidence < 0.78) continue;
    if (!namesReferToSameStartup(signal.startup_company_name, company.name)) {
      console.log(
        `[deal-detect] skipped ambiguous target. resolved="${company.name}" extracted="${signal.startup_company_name || ''}"`
      );
      continue;
    }

    const sourceType = item.type === 'calendar_event' ? 'event' : 'conversation';
    const result = await recordDealEvidenceSignal({
      orgId,
      companyId: item.companyId!,
      sourceType,
      sourceId: item.entityId,
      sourceTitle: item.subject || company.name,
      sourceExcerpt: signal.evidence || item.bodyPreview || null,
      sourceDate: item.sentAt,
      signalKind: signal.signal_kind,
      fundingStage: signal.funding_stage,
      amountUsd: signal.amount_usd,
      confidence: signal.confidence,
      evidenceNote: signal.evidence,
    }, env);

    if (result.recorded) {
      staged++;
      console.log(
        `[deal-detect] recorded evidence company=${company.name} source=${sourceType}:${item.entityId} ` +
        `confidence=${signal.confidence} promotion=${result.reason}${result.dealId ? ` deal=${result.dealId}` : ''}`
      );
    }
  }

  return staged;
}

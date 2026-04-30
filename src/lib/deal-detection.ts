// Deal signal detection — runs over freshly classified items at the end of
// each ingestion cycle. Stages discovered deals in approval_queue rather than
// inserting deals directly so a human reviews before a record exists.

import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
import { hashShort } from './helpers';
import { LLM_PROMPTS } from '../prompts';

interface DealSignal {
  is_deal: boolean;
  stage: 'prospect' | 'qualified' | 'diligence' | 'term_sheet' | 'closing' | null;
  title: string | null;
  amount_usd: number | null;
  our_check_size_usd: number | null;
  lead_source: 'inbound_email' | 'warm_intro' | 'outbound' | 'meeting' | 'referral' | null;
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

// Cheap pre-filter to avoid burning Claude budget on every item. Phase C
// (2026-04-30): widened to include `calendar_event` so meeting transcripts
// flow through the same detection pipeline as emails. Slack messages and
// news items still excluded — they're noisier signal.
function looksLikeDealCandidate(item: ClassifiedItem): boolean {
  if (!item.companyId) return false;
  if (item.type !== 'email' && item.type !== 'calendar_event') return false;
  const haystack = `${item.subject || ''}\n${item.bodyText || ''}\n${item.bodyPreview || ''}`.toLowerCase();
  if (haystack.length < 80) return false;
  return DEAL_KEYWORDS.some(kw => haystack.includes(kw));
}

export async function detectAndStageDealSignals(
  items: ClassifiedItem[],
  orgId: string,
  env: Env
): Promise<number> {
  const candidates = items.filter(looksLikeDealCandidate);
  if (candidates.length === 0) return 0;

  // Cap LLM calls per ingestion cycle so a noisy batch can't eat the budget.
  const MAX_LLM_CALLS = 20;
  const budget = candidates.slice(0, MAX_LLM_CALLS);

  let staged = 0;

  for (const item of budget) {
    const userPrompt = `${LLM_PROMPTS.DEAL_DETECTION_USER_PREFIX}\n\nSubject: ${item.subject || '(none)'}\nFrom: ${item.fromEmail || '(unknown)'}\nDirection: ${item.direction || 'unknown'}\nDate: ${item.sentAt}\n\n---\n\n${truncateToTokens(item.bodyText || '', 2000)}`;

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
    if (signal.confidence < 0.7) continue;
    if (!signal.title || !signal.stage) continue;

    // Phase C: when a deal already exists for this company, treat the
    // signal as a LINK candidate (not a new-deal candidate). For
    // transcripts (item.type='calendar_event') the link target is
    // event_deals; for emails it's conversation_deals.
    //   confidence ≥ 0.9 → auto-link directly via junction
    //   0.7 ≤ confidence < 0.9 → propose via approval_queue 'link_to_deal'
    // Pre-existing item.type='email' behavior preserved when no deal
    // exists yet (still stages create_deal as before).
    const {
      findOpenDealForCompany,
      linkConversationToDeal,
      linkEventToDeal,
      proposeLinkToDeal,
    } = await import('./deal-association');

    const existingDeal = await findOpenDealForCompany(item.companyId!, orgId, env);
    if (existingDeal) {
      const kind: 'conversation' | 'event' =
        item.type === 'calendar_event' ? 'event' : 'conversation';
      if (signal.confidence >= 0.9) {
        const r = kind === 'event'
          ? await linkEventToDeal(item.entityId, existingDeal.id, 'llm_classification', signal.confidence, orgId, env)
          : await linkConversationToDeal(item.entityId, existingDeal.id, 'llm_classification', signal.confidence, orgId, env);
        if (r.inserted) {
          staged++;
          console.log(
            `[deal-detect] auto-linked ${kind}=${item.entityId} → deal=${existingDeal.id} (${existingDeal.title}) confidence=${signal.confidence}`
          );
        }
      } else {
        const r = await proposeLinkToDeal(
          {
            kind,
            sourceId: item.entityId,
            dealId: existingDeal.id,
            orgId,
            confidence: signal.confidence,
            sourceCommunicationId: item.entityId,
            visibility: item.visibility,
          },
          env
        );
        if (r.inserted) {
          staged++;
          console.log(
            `[deal-detect] proposed link ${kind}=${item.entityId} → deal=${existingDeal.id} confidence=${signal.confidence}`
          );
        }
      }
      continue;
    }

    // No existing deal for this company — stage create_deal proposal as
    // before (works for both emails and transcripts now that the
    // pre-filter allows calendar_event).
    const company = await env.D1.prepare(
      'SELECT name FROM companies WHERE id = ? AND org_id = ?'
    ).bind(item.companyId!, orgId).first<{ name: string }>();
    const dealTitle = signal.title || `${company?.name || 'Unknown'} opportunity`;

    const proposedValue = JSON.stringify({
      company_id: item.companyId,
      title: dealTitle.slice(0, 120),
      stage: signal.stage,
      amount: signal.amount_usd,
      our_allocation: signal.our_check_size_usd,
      lead_source: signal.lead_source,
      evidence: signal.evidence?.slice(0, 500),
      source_communication_id: item.entityId,
      source_sent_at: item.sentAt,
      // Phase C: tells commitCreateDealApproval which junction to write
      // when the proposal is accepted. Defaults to conversation for
      // back-compat with pre-Phase-C proposals.
      source_kind: item.type === 'calendar_event' ? 'event' : 'conversation',
    });

    // No per-cycle component — same source email/transcript must collapse across cycles.
    const idempotencyKey = `${orgId}:deal:${item.companyId}:${hashShort(item.entityId)}`;

    const result = await env.D1.prepare(
      `INSERT OR IGNORE INTO approval_queue
         (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
          proposed_value, source_communication_id, source_visibility, confidence, status)
       VALUES (?, ?, 'deal', ?, 'create_deal', 'deal', ?, ?, ?, ?, 'pending')`
    )
      .bind(
        idempotencyKey,
        orgId,
        item.companyId!,
        proposedValue,
        item.entityId,
        item.visibility || 'org_wide',
        signal.confidence
      )
      .run();

    if (result.meta?.changes) {
      staged++;
      console.log(
        `[deal-detect] staged create_deal "${dealTitle}" from ${item.type}=${item.entityId} company=${item.companyId} stage=${signal.stage} confidence=${signal.confidence}`
      );
    }
  }

  return staged;
}

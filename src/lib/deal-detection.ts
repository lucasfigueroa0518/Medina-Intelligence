// Deal signal detection — runs over freshly classified items at the end of
// each ingestion cycle.
//
// 2026-04-30 corroboration gate: a single email rarely indicates a real deal.
// The pre-corroboration design surfaced every detected signal and produced a
// 98.7% reject rate (303/307) on create_deal proposals. Now signals land in
// deal_signals_pending first; they only graduate to approval_queue once a
// SECOND distinct inbound conversation produces a deal signal for the same
// company. The promoted approval_queue row carries an array of corroborating
// source ids + count, so the UI can later surface "N sources agree" without
// re-joining.

import type { Env } from '../types/env';
import type { ClassifiedItem } from '../types/interfaces';
import { callClaude } from './claude';
import { truncateToTokens } from './tokens';
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

// Cheap pre-filter to avoid burning Claude budget on every email.
function looksLikeDealCandidate(item: ClassifiedItem): boolean {
  if (!item.companyId) return false;
  if (item.type !== 'email') return false;
  const haystack = `${item.subject || ''}\n${item.bodyText || ''}\n${item.bodyPreview || ''}`.toLowerCase();
  if (haystack.length < 80) return false;
  return DEAL_KEYWORDS.some(kw => haystack.includes(kw));
}

// Defensive: matches migrations/0065_deal_signals_pending.sql so the function
// is safe to run before the migration has been applied (e.g. local dev, or a
// staggered deploy where code lands before the wrangler d1 migration step).
async function ensureStagingTable(env: Env): Promise<void> {
  await env.D1.prepare(
    `CREATE TABLE IF NOT EXISTS deal_signals_pending (
       id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
       org_id TEXT NOT NULL,
       company_id TEXT NOT NULL,
       source_communication_id TEXT NOT NULL,
       proposed_value TEXT NOT NULL,
       confidence REAL NOT NULL,
       source_visibility TEXT NOT NULL DEFAULT 'org_wide',
       detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       promoted_to_approval_id TEXT,
       UNIQUE(org_id, company_id, source_communication_id)
     )`
  ).run();
  await env.D1.prepare(
    `CREATE INDEX IF NOT EXISTS idx_dsp_company_unpromoted
       ON deal_signals_pending(org_id, company_id, promoted_to_approval_id)`
  ).run();
}

interface StagedRow {
  source_communication_id: string;
  proposed_value: string;
  confidence: number;
}

// Build the merged proposed_value JSON for the queue row. Carries the most
// recent stage/title/amount fields plus an array of every corroborating
// source's communication id and a count, so reviewers can see "N sources
// agree" and drill into each one. Evidence strings from each staged signal
// are joined (capped) so the original LLM justification per source is
// preserved.
function buildMergedProposedValue(
  current: {
    companyId: string;
    title: string;
    stage: string;
    amount: number | null;
    ourAllocation: number | null;
    leadSource: string | null;
    evidence: string;
    sourceCommunicationId: string;
    sourceSentAt: string;
  },
  prior: StagedRow[]
): string {
  // Most recent signal's structured fields win — title/stage/amount can drift
  // as the deal progresses, and the latest message is usually closest to
  // truth. Older numbers are preserved in the per-source evidence trail.
  const allSourceIds = [
    current.sourceCommunicationId,
    ...prior
      .map(p => p.source_communication_id)
      .filter(id => id !== current.sourceCommunicationId),
  ];

  const allEvidence: string[] = [
    `(${current.sourceCommunicationId.slice(0, 8)}): ${current.evidence}`,
  ];
  for (const p of prior) {
    if (p.source_communication_id === current.sourceCommunicationId) continue;
    try {
      const parsed = JSON.parse(p.proposed_value);
      if (parsed?.evidence) {
        allEvidence.push(
          `(${String(p.source_communication_id).slice(0, 8)}): ${String(parsed.evidence)}`
        );
      }
    } catch { /* skip malformed staged row */ }
  }

  const joinedEvidence = allEvidence.join(' | ').slice(0, 1500);

  return JSON.stringify({
    company_id: current.companyId,
    title: current.title.slice(0, 120),
    stage: current.stage,
    amount: current.amount,
    our_allocation: current.ourAllocation,
    lead_source: current.leadSource,
    evidence: joinedEvidence,
    source_communication_id: current.sourceCommunicationId, // most recent — back-compat for UI
    source_sent_at: current.sourceSentAt,
    corroboration_count: allSourceIds.length,
    corroborating_communication_ids: allSourceIds,
  });
}

export async function detectAndStageDealSignals(
  items: ClassifiedItem[],
  orgId: string,
  env: Env
): Promise<number> {
  const candidates = items.filter(looksLikeDealCandidate);
  if (candidates.length === 0) return 0;

  await ensureStagingTable(env);

  // Cap LLM calls per ingestion cycle so a noisy batch can't eat the budget.
  const MAX_LLM_CALLS = 20;
  const budget = candidates.slice(0, MAX_LLM_CALLS);

  let staged = 0;
  let promoted = 0;

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

    const company = await env.D1.prepare(
      'SELECT name FROM companies WHERE id = ? AND org_id = ?'
    ).bind(item.companyId!, orgId).first<{ name: string }>();
    const dealTitle = signal.title || `${company?.name || 'Unknown'} opportunity`;

    const currentForMerge = {
      companyId: item.companyId!,
      title: dealTitle,
      stage: signal.stage,
      amount: signal.amount_usd,
      ourAllocation: signal.our_check_size_usd,
      leadSource: signal.lead_source,
      evidence: signal.evidence?.slice(0, 500) || '',
      sourceCommunicationId: item.entityId,
      sourceSentAt: item.sentAt,
    };

    // Always stage. UNIQUE(org_id, company_id, source_communication_id)
    // collapses re-classifications of the same email.
    const singleSourceProposed = JSON.stringify({
      company_id: currentForMerge.companyId,
      title: currentForMerge.title.slice(0, 120),
      stage: currentForMerge.stage,
      amount: currentForMerge.amount,
      our_allocation: currentForMerge.ourAllocation,
      lead_source: currentForMerge.leadSource,
      evidence: currentForMerge.evidence,
      source_communication_id: currentForMerge.sourceCommunicationId,
      source_sent_at: currentForMerge.sourceSentAt,
    });
    await env.D1.prepare(
      `INSERT OR IGNORE INTO deal_signals_pending
         (org_id, company_id, source_communication_id, proposed_value, confidence, source_visibility)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      orgId,
      item.companyId!,
      item.entityId,
      singleSourceProposed,
      signal.confidence,
      item.visibility || 'org_wide'
    ).run();

    staged++;

    // Decide promotion: any pending approval_queue create_deal row for this
    // company already counts (signals merge into it), and every distinct
    // staged source counts. ≥ 2 distinct sources → surface; otherwise hold.
    const existingQueue = await env.D1.prepare(
      `SELECT id, proposed_value, confidence FROM approval_queue
         WHERE org_id = ? AND entity_type = 'deal' AND entity_id = ?
           AND change_type = 'create_deal' AND status = 'pending'
         LIMIT 1`
    ).bind(orgId, item.companyId!).first<{ id: string; proposed_value: string; confidence: number }>();

    const stagedCountRow = await env.D1.prepare(
      `SELECT COUNT(DISTINCT source_communication_id) AS n FROM deal_signals_pending
         WHERE org_id = ? AND company_id = ? AND promoted_to_approval_id IS NULL`
    ).bind(orgId, item.companyId!).first<{ n: number }>();
    const distinctStaged = stagedCountRow?.n ?? 0;

    if (!existingQueue && distinctStaged < 2) {
      console.log(
        `[deal-detect] held ${item.companyId} (distinct_staged=${distinctStaged}, awaiting corroboration) — title="${dealTitle}"`
      );
      continue;
    }

    // Promote — gather every unpromoted staged row for this company so the
    // merged queue payload reflects every corroborating source.
    const stagedRowsResult = await env.D1.prepare(
      `SELECT source_communication_id, proposed_value, confidence FROM deal_signals_pending
         WHERE org_id = ? AND company_id = ? AND promoted_to_approval_id IS NULL`
    ).bind(orgId, item.companyId!).all<StagedRow>();
    const stagedRows = stagedRowsResult.results || [];

    const mergedProposedValue = buildMergedProposedValue(currentForMerge, stagedRows);
    const maxConfidence = Math.max(
      signal.confidence,
      existingQueue?.confidence ?? 0,
      ...stagedRows.map(r => r.confidence)
    );

    let approvalId: string | null = null;

    if (existingQueue) {
      await env.D1.prepare(
        `UPDATE approval_queue
            SET proposed_value = ?, confidence = ?
          WHERE id = ?`
      ).bind(mergedProposedValue, maxConfidence, existingQueue.id).run();
      approvalId = existingQueue.id;
      console.log(
        `[deal-detect] merged ${item.companyId} into existing queue row ${existingQueue.id} (now corroborated by ${stagedRows.length} source${stagedRows.length === 1 ? '' : 's'})`
      );
    } else {
      // INSERT keyed off company so every promotion for the same company
      // collapses to one queue row (the previous per-email key would have
      // produced a fresh row each cycle once we're past the corroboration
      // threshold).
      const idempotencyKey = `${orgId}:deal:${item.companyId}:corroborated`;
      const inserted = await env.D1.prepare(
        `INSERT OR IGNORE INTO approval_queue
           (idempotency_key, org_id, entity_type, entity_id, change_type, field_name,
            proposed_value, source_communication_id, source_visibility, confidence, status)
         VALUES (?, ?, 'deal', ?, 'create_deal', 'deal', ?, ?, ?, ?, 'pending')
         RETURNING id`
      ).bind(
        idempotencyKey,
        orgId,
        item.companyId!,
        mergedProposedValue,
        item.entityId,
        item.visibility || 'org_wide',
        maxConfidence
      ).first<{ id: string }>();

      if (inserted?.id) {
        approvalId = inserted.id;
      } else {
        // Idempotency-key conflict means a prior cycle already promoted under
        // the same canonical key; recover the existing row id so we still
        // stamp the staged signals as promoted (otherwise we'd re-promote on
        // the next cycle).
        const existing = await env.D1.prepare(
          `SELECT id FROM approval_queue WHERE idempotency_key = ? LIMIT 1`
        ).bind(idempotencyKey).first<{ id: string }>();
        approvalId = existing?.id ?? null;
      }
      console.log(
        `[deal-detect] promoted ${item.companyId} → approval_queue ${approvalId} (corroborated by ${stagedRows.length} source${stagedRows.length === 1 ? '' : 's'}) — title="${dealTitle}"`
      );
    }

    if (approvalId) {
      await env.D1.prepare(
        `UPDATE deal_signals_pending
            SET promoted_to_approval_id = ?
          WHERE org_id = ? AND company_id = ? AND promoted_to_approval_id IS NULL`
      ).bind(approvalId, orgId, item.companyId!).run();
      promoted++;
    }
  }

  if (staged > 0 || promoted > 0) {
    console.log(`[deal-detect] cycle: staged=${staged} promoted=${promoted}`);
  }

  // Returned count remains "things now visible in approval_queue from this
  // cycle" so the existing sync_jobs.metadata.deal_signals_staged counter
  // continues to mean what callers expect.
  return promoted;
}

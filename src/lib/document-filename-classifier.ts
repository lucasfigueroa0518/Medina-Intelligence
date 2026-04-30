// Wave 5 Phase C — filename-keyword pre-classifier.
//
// Cheap classifier that runs BEFORE the LLM. Three-tier disposition:
//   - high   → use the category directly, skip the LLM call entirely
//   - medium → still call the LLM, but pass the cheap match as a hint so
//              the model is biased toward the cheap signal
//   - null   → no keyword match; LLM-only path (existing behavior)
//
// Hit-rate isn't gated empirically (decision: ship cheap-as-fast-path
// always — the latency win is the value, not classification cost).
// Patterns are conservative and lower-cased; we only fire on obvious
// venture-domain keywords. False positives bias toward 'medium' so the
// LLM gets to override.
//
// Source of truth for the 14 categories:
//   src/lib/document-intelligence.ts:184-190 (allowlist)

import type { DocumentCategory } from './document-intelligence';

export type FilenameMatch = {
  category: DocumentCategory;
  confidence: 'high' | 'medium';
};

interface Rule {
  pattern: RegExp;
  category: DocumentCategory;
  confidence: 'high' | 'medium';
  why: string; // documentation-only — keeps the table self-explanatory
}

// Patterns are tested in order. First match wins. Order from most-specific
// (high-conf, narrow tokens) to least-specific (medium-conf, broad tokens)
// within each category cluster. Keeps the table reorderable without
// breaking semantics: more specific patterns naturally appear earlier.
const RULES: Rule[] = [
  // ── DEAL FLOW ──────────────────────────────────────────────────────────
  { pattern: /\b(pitch[\s_-]?deck|one[\s_-]?pager|company[\s_-]?overview|exec(?:utive)?[\s_-]?summary)\b/, category: 'deal_pitch', confidence: 'high', why: 'unambiguous pitch artifacts' },
  { pattern: /\b(deck|presentation)\b/, category: 'deal_pitch', confidence: 'medium', why: 'could be a pitch OR a board/portfolio deck — let LLM disambiguate' },

  { pattern: /\b(due[\s_-]?diligence|dd[\s_-]?(?:report|memo)|background[\s_-]?check|tech(?:nical)?[\s_-]?assessment)\b/, category: 'deal_diligence', confidence: 'high', why: 'DD-specific phrasing' },

  { pattern: /\b(term[\s_-]?sheet|loi|letter[\s_-]?of[\s_-]?intent|side[\s_-]?letter|safe|convertible[\s_-]?note|cap[\s_-]?table|shareholders?[\s_-]?agreement|investment[\s_-]?agreement|spa)\b/, category: 'deal_terms', confidence: 'high', why: 'transaction-doc nomenclature' },

  { pattern: /\b(financial[\s_-]?model|p[\s_-]?and[\s_-]?l|p&l|projections?|burn|runway|forecast|revenue[\s_-]?report)\b/, category: 'deal_financials', confidence: 'high', why: 'finance/modeling-specific' },
  { pattern: /\b(balance[\s_-]?sheet|income[\s_-]?statement|cash[\s_-]?flow)\b/, category: 'deal_financials', confidence: 'medium', why: 'could be deal_financials OR fund_admin (own books) — LLM picks' },

  // ── FUND OPERATIONS ────────────────────────────────────────────────────
  { pattern: /\b(lp[\s_-]?(?:report|update)|quarterly[\s_-]?(?:report|update)|q[1-4][\s_-]?20\d{2}|tvpi|dpi|moic|distribution[\s_-]?notice|k[\s_-]?1)\b/, category: 'fund_reporting', confidence: 'high', why: 'LP-reporting-specific tokens' },

  { pattern: /\b(lpa|limited[\s_-]?partnership[\s_-]?agreement|subscription[\s_-]?(?:doc|agreement)|nda|non[\s_-]?disclosure)\b/, category: 'fund_legal', confidence: 'high', why: 'fund-legal artifacts' },
  // 'agreement' / 'contract' alone are too broad — keep them out; LLM handles those.

  { pattern: /\b(bank[\s_-]?statement|wire[\s_-]?confirmation|tax[\s_-]?(?:doc|return|filing)|ein[\s_-]?letter|formation[\s_-]?doc|articles[\s_-]?of[\s_-]?(?:formation|incorporation))\b/, category: 'fund_admin', confidence: 'high', why: 'admin-doc-specific' },

  // ── RELATIONSHIPS ──────────────────────────────────────────────────────
  { pattern: /\b(contact[\s_-]?list|attendee[\s_-]?list|crm[\s_-]?export|vcard|linkedin[\s_-]?export|guest[\s_-]?list)\b/, category: 'contact_data', confidence: 'high', why: 'contact-data structures' },
  { pattern: /\.vcf$/, category: 'contact_data', confidence: 'high', why: 'vCard file extension' },

  { pattern: /\b(email[\s_-]?(?:thread|chain)|fwd?[\s_-]?re|reply[\s_-]?chain)\b/, category: 'correspondence', confidence: 'medium', why: 'plain "thread"/"reply" too noisy alone — restrict to email-thread phrasing' },

  { pattern: /\b(board[\s_-]?(?:deck|materials|pack)|ic[\s_-]?memo|meeting[\s_-]?(?:agenda|minutes|notes)|agenda)\b/, category: 'meeting_material', confidence: 'high', why: 'meeting-artifact nomenclature' },

  // ── MARKET INTELLIGENCE ────────────────────────────────────────────────
  { pattern: /\b(market[\s_-]?(?:map|report)|industry[\s_-]?report|competitive[\s_-]?analysis|whitepaper|white[\s_-]?paper|landscape[\s_-]?report)\b/, category: 'research', confidence: 'high', why: 'market-research-specific' },

  { pattern: /\b(portfolio[\s_-]?(?:update|report)|kpi[\s_-]?(?:dashboard|report)|milestone[\s_-]?report|board[\s_-]?package)\b/, category: 'portfolio_update', confidence: 'high', why: 'portfolio-update-specific' },

  // ── GENERAL ────────────────────────────────────────────────────────────
  { pattern: /\b(invoice|receipt|w[\s_-]?9|1099|policy|handbook|hr[\s_-]?doc|org[\s_-]?chart|vendor[\s_-]?contract|automatic_report|automated_report)\b/, category: 'internal_ops', confidence: 'high', why: 'ops/admin artifacts incl. systems-generated reports' },

  { pattern: /\b(template|guide|checklist|cheat[\s_-]?sheet|tutorial)\b/, category: 'reference', confidence: 'medium', why: 'reference-y but easily wrong (a "template" could be a deal_terms blank) — let LLM check' },
];

/**
 * Run the cheap filename pattern match. Returns `null` when nothing matches
 * (caller falls through to the LLM). Case-insensitive — input is normalized
 * to lowercase internally; rule patterns assume lowercase.
 */
export function classifyByFilename(fileName: string | null | undefined): FilenameMatch | null {
  const name = (fileName || '').toLowerCase().trim();
  if (!name) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(name)) {
      return { category: rule.category, confidence: rule.confidence };
    }
  }
  return null;
}

-- Wave 3 — brief_summary on deal_intelligence.
--
-- 2-3 sentence prose "State of the Union" generated alongside the existing
-- structured intelligence (sentiment / topics / risk_signals / momentum).
-- Recency-biased: the prompt instructs the model to weight the last 14
-- days. Same per-(deal, user) ACL keying as the rest of deal_intelligence
-- — the input set passes through filterConversationsByAcl before the
-- Haiku call, so the brief is implicitly redacted to what the user can
-- read.
--
-- Coordination note for T3: this is a Wave 3 column extension. The
-- compute path in src/lib/deal-intelligence.ts:computeDealIntelligence
-- now generates brief_summary in the same Claude call (single
-- max_tokens-bumped invocation, so no additional LLM cost beyond a few
-- hundred output tokens). T3 owns the parent file; please incorporate
-- when refactoring.

ALTER TABLE deal_intelligence ADD COLUMN brief_summary TEXT;

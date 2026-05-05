-- Wave-fix Chunk 3 (5a) — sample claim-grounding verification table.
--
-- Per-claim observability for MARTy citations. Sample 20% of responses
-- with citations; for each [^N] marker, ask a judge model "does this
-- source's excerpt actually support this claim?" Results land here for
-- analysis. NOT user-facing yet — purely infrastructure for measuring
-- the production fabrication rate.
--
-- Audit reference: 2026-05-05 Tony's Slack hallucination cited 10 emails
-- to support fabricated Slack content. With this table populated, we'd
-- have observed: 0/10 citations marked 'supported' on that turn —
-- 100% unsupported rate. Decisions on full vs heuristic verification
-- (Q5b/5c from the design doc) gate on data this table will produce.

CREATE TABLE agent_message_verifications (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  org_id TEXT NOT NULL,

  -- Which numbered source from the SOURCES list was cited
  source_id INTEGER NOT NULL,

  -- ~250 chars around the [^N] marker (the claim attributed to source N)
  claim_text TEXT NOT NULL,

  -- The actual source excerpt the model SHOULD have been drawing from
  -- (from CitationSource.excerpt, hydrated by citations.ts at retrieval).
  -- Null when the source had no excerpt populated (rare — Wave 4 Phase C
  -- backed this for documents/emails/meetings; some legacy paths may not).
  source_excerpt TEXT,

  -- Judge verdict on whether the excerpt supports the claim
  verdict TEXT NOT NULL CHECK(verdict IN ('supported','partial','unsupported','error')),

  -- Judge's self-reported confidence, 0-1 (rounded to 2 decimals)
  confidence REAL,

  -- Free-form judge reasoning, capped at ~500 chars. Useful for spot-
  -- checks of why the judge ruled unsupported.
  rationale TEXT,

  judge_model TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Lookup by message — when a UI surfaces a "verification badge" on a
-- specific message, it joins this on message_id.
CREATE INDEX idx_amv_message ON agent_message_verifications(message_id);

-- Trend analysis — "what's the unsupported rate by week?"
CREATE INDEX idx_amv_verdict_created ON agent_message_verifications(verdict, created_at);

-- Org scoping — multi-tenant safety on any query.
CREATE INDEX idx_amv_org_created ON agent_message_verifications(org_id, created_at);

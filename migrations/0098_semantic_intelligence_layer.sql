-- Semantic Intelligence Layer V1.
--
-- Additive, evidence-first metadata layer for MARTy. This is deliberately
-- separate from RAG chunks: RAG finds passages; semantic intelligence stores
-- durable, queryable assertions about entities, documents, events, and
-- observed external entities with provenance.
--
-- Core safety rule: every machine-generated assertion must have evidence.
-- Ingestion code stores short evidence quotes/pointers and status/confidence;
-- downstream structured query/export tools can require active assertions plus
-- evidence instead of trusting free-form model prose.

CREATE TABLE IF NOT EXISTS semantic_taxonomy (
  predicate TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  value_kind TEXT NOT NULL DEFAULT 'string'
    CHECK (value_kind IN ('string','number','date','boolean','enum','json')),
  applies_to TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS semantic_subjects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL
    CHECK (subject_type IN (
      'company','contact','deal','document','event','conversation','news_article',
      'observed_company','observed_person','observed_fund','market','topic'
    )),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  linked_entity_type TEXT
    CHECK (linked_entity_type IS NULL OR linked_entity_type IN (
      'company','contact','deal','document','event','conversation','news_article'
    )),
  linked_entity_id TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, subject_type, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_semantic_subjects_linked
  ON semantic_subjects (org_id, linked_entity_type, linked_entity_id);
CREATE INDEX IF NOT EXISTS idx_semantic_subjects_type
  ON semantic_subjects (org_id, subject_type, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS semantic_assertions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES semantic_subjects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (target_type IN (
      'semantic_subject','company','contact','deal','document','event',
      'conversation','news_article'
    )),
  target_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  value_normalized TEXT NOT NULL,
  value_json TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  confidence_label TEXT NOT NULL DEFAULT 'weak_inference'
    CHECK (confidence_label IN (
      'explicit','strong_inference','weak_inference','computed','human'
    )),
  extraction_method TEXT NOT NULL DEFAULT 'deterministic'
    CHECK (extraction_method IN (
      'deterministic','llm_evidence','llm_grounded','human','import'
    )),
  source_count INTEGER NOT NULL DEFAULT 1,
  semantic_version TEXT NOT NULL DEFAULT 'v1',
  source_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','rejected','stale')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, target_type, target_id, predicate, value_normalized)
);

CREATE INDEX IF NOT EXISTS idx_semantic_assertions_subject
  ON semantic_assertions (org_id, subject_id, status);
CREATE INDEX IF NOT EXISTS idx_semantic_assertions_predicate
  ON semantic_assertions (org_id, predicate, value_normalized, status);
CREATE INDEX IF NOT EXISTS idx_semantic_assertions_target
  ON semantic_assertions (org_id, target_type, target_id, status);

CREATE TABLE IF NOT EXISTS semantic_evidence (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assertion_id TEXT NOT NULL REFERENCES semantic_assertions(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  rag_chunk_id TEXT,
  source_field TEXT,
  quote TEXT NOT NULL,
  evidence_kind TEXT NOT NULL DEFAULT 'quote'
    CHECK (evidence_kind IN ('quote','field_value','table_cell','derived_from_record','human_note')),
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (assertion_id, source_table, source_id, rag_chunk_id, quote)
);

CREATE INDEX IF NOT EXISTS idx_semantic_evidence_source
  ON semantic_evidence (org_id, source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_semantic_evidence_assertion
  ON semantic_evidence (assertion_id);

CREATE TABLE IF NOT EXISTS semantic_tag_rollups (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES semantic_subjects(id) ON DELETE CASCADE,
  linked_entity_type TEXT,
  linked_entity_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  facets_json TEXT NOT NULL DEFAULT '{}',
  vc_profile_json TEXT NOT NULL DEFAULT '{}',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_rollups_linked
  ON semantic_tag_rollups (org_id, linked_entity_type, linked_entity_id);

CREATE TABLE IF NOT EXISTS semantic_source_state (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  semantic_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','completed','failed','skipped')),
  use_llm INTEGER NOT NULL DEFAULT 0 CHECK (use_llm IN (0,1)),
  assertion_count INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  subject_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_source_state_status
  ON semantic_source_state (org_id, status, source_table);
CREATE INDEX IF NOT EXISTS idx_semantic_source_state_version
  ON semantic_source_state (org_id, semantic_version, updated_at DESC);

CREATE TABLE IF NOT EXISTS semantic_refresh_watchlist (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','dismissed')),
  next_check_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, target_type, target_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_semantic_watchlist_due
  ON semantic_refresh_watchlist (org_id, status, next_check_at, priority DESC);

INSERT OR IGNORE INTO semantic_taxonomy
  (predicate, label, category, value_kind, applies_to, description)
VALUES
  ('entity.kind', 'Entity kind', 'identity', 'enum', '["company","observed_company","observed_fund","contact"]', 'Company/person/fund role such as VC fund, startup, LP, founder, operator.'),
  ('entity.location', 'Location', 'identity', 'string', '["company","contact","observed_company","observed_fund"]', 'Headquarters, office, or explicitly stated base/location.'),
  ('entity.geography_focus', 'Geography focus', 'identity', 'string', '["company","observed_fund"]', 'Where the entity invests, sells, operates, or focuses.'),
  ('company.sector', 'Sector', 'company_profile', 'string', '["company","observed_company","deal"]', 'Primary sector/category.'),
  ('company.subsector', 'Subsector', 'company_profile', 'string', '["company","observed_company","deal"]', 'More specific sector, e.g. cybersecurity, AI infrastructure, MarTech.'),
  ('company.business_model', 'Business model', 'company_profile', 'string', '["company","observed_company","deal"]', 'Business model or revenue model.'),
  ('company.customer_type', 'Customer type', 'company_profile', 'string', '["company","observed_company","deal"]', 'Target buyer/customer, e.g. enterprise, SMB, consumer, government.'),
  ('company.stage', 'Stage', 'company_profile', 'enum', '["company","observed_company","deal"]', 'Company or financing stage.'),
  ('company.traction_metric', 'Traction metric', 'company_profile', 'json', '["company","observed_company","deal","document"]', 'ARR, MRR, GMV, users, growth, pilots, customers, or other traction evidence.'),
  ('company.existing_investor', 'Existing investor', 'company_profile', 'string', '["company","observed_company","deal"]', 'Investor explicitly associated with a company.'),
  ('investment.stage_focus', 'Investment stage focus', 'investment_profile', 'string', '["company","observed_fund"]', 'Stages a fund invests in.'),
  ('investment.sector_focus', 'Investment sector focus', 'investment_profile', 'string', '["company","observed_fund"]', 'Sectors a fund invests in.'),
  ('investment.thesis', 'Investment thesis', 'investment_profile', 'string', '["company","observed_fund"]', 'A stated investing thesis or mandate.'),
  ('investment.check_size', 'Check size', 'investment_profile', 'string', '["company","observed_fund"]', 'Typical or explicit investment amount.'),
  ('investment.lead_or_follow', 'Lead/follow preference', 'investment_profile', 'enum', '["company","observed_fund"]', 'Whether the investor leads, follows, co-invests, or is fund-of-funds.'),
  ('deal.round_size', 'Round size', 'deal_flow', 'number', '["deal","company","observed_company"]', 'Capital being raised or round size.'),
  ('deal.valuation', 'Valuation', 'deal_flow', 'number', '["deal","company","observed_company"]', 'Pre/post/current valuation.'),
  ('deal.source', 'Deal source', 'deal_flow', 'string', '["deal","company"]', 'Referrer, source, scout, event, or inbound channel.'),
  ('deal.status', 'Deal status', 'deal_flow', 'enum', '["deal","company"]', 'CRM/investment status.'),
  ('deal.risk', 'Deal risk', 'deal_flow', 'string', '["deal","company","document","event","conversation"]', 'Explicit risk, concern, blocker, or diligence issue.'),
  ('deal.next_step', 'Next step', 'deal_flow', 'string', '["deal","company","event","conversation"]', 'Explicit next action or follow-up.'),
  ('deal.pass_reason', 'Pass reason', 'deal_flow', 'string', '["deal","company"]', 'Why the firm passed or declined.'),
  ('founder.background', 'Founder background', 'founder_profile', 'string', '["contact","observed_person","company","deal"]', 'Prior company, employer, education, technical/commercial background.'),
  ('founder.market_fit', 'Founder-market fit', 'founder_profile', 'string', '["contact","observed_person","company","deal"]', 'Evidence of founder-domain fit.'),
  ('event.attendee', 'Event attendee', 'events_campaigns', 'string', '["event","document","contact","observed_person"]', 'Person explicitly listed as invited, registered, attended, cancelled, or no-show.'),
  ('event.invited_by', 'Invited by', 'events_campaigns', 'string', '["event","document","contact","observed_person"]', 'Person who invited or referred an attendee.'),
  ('event.attendance_status', 'Attendance status', 'events_campaigns', 'enum', '["event","document","contact","observed_person"]', 'Registered, attended, cancelled, invited, no-show, etc.'),
  ('event.topic', 'Event topic', 'events_campaigns', 'string', '["event","document","conversation"]', 'Event/webinar/meeting topic.'),
  ('document.category', 'Document category', 'document_profile', 'enum', '["document"]', 'Pitch deck, attendee list, directory, market map, memo, financials, legal, etc.'),
  ('document.contains_entity', 'Document contains entity', 'document_profile', 'string', '["document"]', 'Named entity explicitly present in a document.'),
  ('market.trend', 'Market trend', 'market_intel', 'string', '["market","topic","news_article","document"]', 'Market trend or structural shift.'),
  ('market.signal', 'Market signal', 'market_intel', 'string', '["market","topic","news_article","document"]', 'News, funding, hiring, product, regulatory, or category momentum signal.');

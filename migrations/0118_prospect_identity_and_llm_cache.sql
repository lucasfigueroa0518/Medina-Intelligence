-- Cost-aware prospect identity and LLM cache support.

CREATE TABLE IF NOT EXISTS entity_identity_aliases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('company','prospect')),
  entity_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK(alias_kind IN ('normalized_name','domain','domain_brand','product','stealth','manual')),
  alias_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
  source_kind TEXT NOT NULL DEFAULT 'system'
    CHECK(source_kind IN ('system','classifier','enrichment','manual','migration')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, entity_type, entity_id, alias_kind, alias_value)
);

CREATE INDEX IF NOT EXISTS idx_entity_identity_alias_lookup
  ON entity_identity_aliases(org_id, alias_kind, alias_value);

CREATE INDEX IF NOT EXISTS idx_entity_identity_alias_entity
  ON entity_identity_aliases(org_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS prospect_classifier_cache (
  cache_key TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('conversation','event','document')),
  source_id TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  model TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  value_json TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_prospect_classifier_cache_org_source
  ON prospect_classifier_cache(org_id, source_type, source_id, classifier_version);

CREATE INDEX IF NOT EXISTS idx_prospect_classifier_cache_expiry
  ON prospect_classifier_cache(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS prospect_llm_cache (
  cache_key TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  decision_hash TEXT,
  value_json TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_prospect_llm_cache_stage
  ON prospect_llm_cache(org_id, stage, prompt_version, model);

CREATE INDEX IF NOT EXISTS idx_prospect_llm_cache_expiry
  ON prospect_llm_cache(expires_at)
  WHERE expires_at IS NOT NULL;

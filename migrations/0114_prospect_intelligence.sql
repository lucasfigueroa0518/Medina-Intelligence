-- Prospect Intelligence System.
--
-- Adds a metadata-only prospect layer beside deals. Raw source content stays in
-- the existing source tables/R2 objects and is ACL-checked at read time.

CREATE TABLE IF NOT EXISTS prospect_sectors (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  parent_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO prospect_sectors (key, label, parent_key, sort_order) VALUES
  ('ai_data', 'AI / Data', NULL, 10),
  ('cybersecurity', 'Cybersecurity', NULL, 20),
  ('quantum', 'Quantum', NULL, 30),
  ('dev_cloud_infra', 'Developer / Cloud Infrastructure', NULL, 40),
  ('enterprise_software', 'Enterprise Software', NULL, 50),
  ('fintech', 'Fintech', NULL, 60),
  ('healthcare', 'Healthcare', NULL, 70),
  ('aerospace_defense', 'Aerospace / Defense', NULL, 80),
  ('hardware_semis', 'Hardware / Semiconductors', NULL, 90),
  ('robotics', 'Robotics', NULL, 100),
  ('energy_climate', 'Energy / Climate', NULL, 110),
  ('materials_manufacturing', 'Materials / Manufacturing', NULL, 120),
  ('mobility_logistics', 'Mobility / Logistics', NULL, 130),
  ('real_estate_built_env', 'Real Estate / Built Environment', NULL, 140),
  ('consumer', 'Consumer', NULL, 150),
  ('agri_food', 'Agriculture / Food', NULL, 160),
  ('education', 'Education', NULL, 170),
  ('uncategorized', 'Uncategorized', NULL, 900);

CREATE TABLE IF NOT EXISTS dealmakers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  name TEXT,
  email TEXT,
  normalized_email TEXT,
  normalized_name TEXT,
  domain TEXT,
  dealmaker_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK(dealmaker_type IN ('person','firm','accelerator','syndicate','gov_channel','unknown')),
  warmth_level TEXT NOT NULL DEFAULT 'warm'
    CHECK(warmth_level IN ('warm','unknown')),
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, normalized_email)
);

CREATE INDEX IF NOT EXISTS idx_dealmakers_org_seen
  ON dealmakers(org_id, last_seen_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dealmakers_org_name_no_email
  ON dealmakers(org_id, normalized_name)
  WHERE normalized_email IS NULL AND normalized_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  domain TEXT,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','provisional','converted','merged','dismissed')),
  visibility TEXT NOT NULL DEFAULT 'firm'
    CHECK(visibility IN ('firm','restricted')),
  sector_key TEXT NOT NULL DEFAULT 'uncategorized'
    REFERENCES prospect_sectors(key),
  sector_confidence REAL NOT NULL DEFAULT 0,
  signal_count INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_signal_at TEXT,
  intro_source TEXT,
  signal_strength INTEGER NOT NULL DEFAULT 0,
  signal_strength_reasons TEXT NOT NULL DEFAULT '[]',
  enrichment_priority TEXT NOT NULL DEFAULT 'lazy'
    CHECK(enrichment_priority IN ('eager','lazy')),
  enrichment_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK(enrichment_status IN ('not_started','candidate','enriched','failed')),
  confidence REAL NOT NULL DEFAULT 0,
  provisional INTEGER NOT NULL DEFAULT 0 CHECK(provisional IN (0,1)),
  direction_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(direction_uncertain IN (0,1)),
  possible_duplicate_of TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  possible_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  possible_deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_org_normalized_active
  ON prospects(org_id, normalized_name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prospects_org_seen
  ON prospects(org_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_org_sector
  ON prospects(org_id, sector_key, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_strength
  ON prospects(org_id, signal_strength DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_deal
  ON prospects(org_id, deal_id)
  WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prospects_duplicate
  ON prospects(org_id, possible_duplicate_of)
  WHERE possible_duplicate_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS prospect_signals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('conversation','event','document')),
  source_id TEXT NOT NULL,
  mention_ordinal INTEGER NOT NULL,
  span_start INTEGER,
  span_end INTEGER,
  raw_mention_text TEXT NOT NULL,
  normalized_mention TEXT NOT NULL,
  source_title TEXT,
  occurred_at TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound'
    CHECK(direction IN ('inbound','outbound','internal','news')),
  direction_source TEXT NOT NULL DEFAULT 'deterministic'
    CHECK(direction_source IN ('deterministic','llm','mixed')),
  direction_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(direction_uncertain IN (0,1)),
  mention_type TEXT NOT NULL DEFAULT 'noise'
    CHECK(mention_type IN ('inbound_prospect','known_deal','intro_source','news','noise','web_analytics')),
  classifier_version TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  confidence_tier TEXT NOT NULL DEFAULT 'medium'
    CHECK(confidence_tier IN ('high','medium','low')),
  classification_status TEXT NOT NULL DEFAULT 'classified'
    CHECK(classification_status IN ('pending','classified','failed')),
  resolution_status TEXT NOT NULL DEFAULT 'resolved'
    CHECK(resolution_status IN ('pending','resolved','dropped')),
  error_message TEXT,
  classification_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TEXT,
  sector_key TEXT NOT NULL DEFAULT 'uncategorized'
    REFERENCES prospect_sectors(key),
  sector_confidence REAL NOT NULL DEFAULT 0,
  signal_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK(signal_kind IN ('intro','raise','deck','meeting','call','list_entry','cold_mention','unknown')),
  dealmaker_id TEXT REFERENCES dealmakers(id) ON DELETE SET NULL,
  dealmaker_name TEXT,
  has_deck INTEGER NOT NULL DEFAULT 0 CHECK(has_deck IN (0,1)),
  has_meeting INTEGER NOT NULL DEFAULT 0 CHECK(has_meeting IN (0,1)),
  ingestion_mode TEXT NOT NULL DEFAULT 'live'
    CHECK(ingestion_mode IN ('live','backfill')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, source_type, source_id, mention_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_prospect_signals_prospect
  ON prospect_signals(prospect_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospect_signals_source
  ON prospect_signals(org_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_prospect_signals_type
  ON prospect_signals(org_id, mention_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospect_signals_pending
  ON prospect_signals(org_id, classification_status, updated_at)
  WHERE classification_status != 'classified' OR resolution_status = 'pending';

CREATE TABLE IF NOT EXISTS prospect_classification_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_signal_id TEXT NOT NULL REFERENCES prospect_signals(id) ON DELETE CASCADE,
  classifier_version TEXT NOT NULL,
  previous_classification_json TEXT,
  new_classification_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_prospect_classification_history_signal
  ON prospect_classification_history(prospect_signal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prospect_soft_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL
    CHECK(link_type IN ('possible_duplicate','possible_company_match','possible_deal_attach')),
  target_type TEXT NOT NULL CHECK(target_type IN ('prospect','company','deal')),
  target_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, prospect_id, link_type, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_prospect_soft_links_prospect
  ON prospect_soft_links(prospect_id, link_type);

CREATE TABLE IF NOT EXISTS prospect_classifier_samples (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_signal_id TEXT REFERENCES prospect_signals(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('conversation','event','document')),
  source_id TEXT NOT NULL,
  mention_ordinal INTEGER NOT NULL,
  sample_reason TEXT NOT NULL,
  confidence_tier TEXT NOT NULL CHECK(confidence_tier IN ('high','medium','low')),
  predicted_mention_type TEXT NOT NULL,
  predicted_direction TEXT NOT NULL,
  predicted_sector_key TEXT NOT NULL,
  label_status TEXT NOT NULL DEFAULT 'unlabeled'
    CHECK(label_status IN ('unlabeled','labeled','adjudicated')),
  gold_mention_type TEXT,
  gold_direction TEXT,
  gold_sector_key TEXT,
  sampled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  labeled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, source_type, source_id, mention_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_prospect_classifier_samples_status
  ON prospect_classifier_samples(org_id, label_status, sampled_at DESC);

CREATE TABLE IF NOT EXISTS prospect_backfill_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','in_progress','completed','failed','cancelled')),
  source_families TEXT NOT NULL DEFAULT '[]',
  items_found INTEGER NOT NULL DEFAULT 0,
  items_processed INTEGER NOT NULL DEFAULT 0,
  signals_recorded INTEGER NOT NULL DEFAULT 0,
  measured_cost_per_item REAL,
  estimated_total_cost REAL,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_prospect_backfill_runs_org_status
  ON prospect_backfill_runs(org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS prospect_backfill_coverage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES prospect_backfill_runs(id) ON DELETE SET NULL,
  source_family TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'partial'
    CHECK(status IN ('completed','partial','failed')),
  items_scanned INTEGER NOT NULL DEFAULT 0,
  signals_recorded INTEGER NOT NULL DEFAULT 0,
  prospects_upserted INTEGER NOT NULL DEFAULT 0,
  classifications_pending INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, source_family, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS idx_prospect_backfill_coverage_org_family
  ON prospect_backfill_coverage(org_id, source_family, window_end DESC);

-- Extend entity_field_state to support prospects. SQLite cannot relax a CHECK
-- in place, so preserve all current rows and rebuild with the widened enum.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS entity_field_state_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('contact','company','deal','prospect')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  current_value TEXT,
  current_value_sources TEXT NOT NULL DEFAULT '[]',
  pending_proposals TEXT NOT NULL DEFAULT '{}',
  rejected_values TEXT NOT NULL DEFAULT '{}',
  last_human_edit_at TEXT,
  permanently_locked INTEGER NOT NULL DEFAULT 0 CHECK(permanently_locked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pending_deletions TEXT NOT NULL DEFAULT '[]',
  last_human_edit_user_id TEXT
);

INSERT OR IGNORE INTO entity_field_state_new (
  id, entity_type, entity_id, field_name, current_value, current_value_sources,
  pending_proposals, rejected_values, last_human_edit_at, permanently_locked,
  created_at, updated_at, pending_deletions, last_human_edit_user_id
)
SELECT
  id, entity_type, entity_id, field_name, current_value, current_value_sources,
  pending_proposals, rejected_values, last_human_edit_at, permanently_locked,
  created_at, updated_at,
  COALESCE(pending_deletions, '[]'),
  last_human_edit_user_id
FROM entity_field_state;

DROP TABLE entity_field_state;
ALTER TABLE entity_field_state_new RENAME TO entity_field_state;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_field_state_unique
  ON entity_field_state(entity_type, entity_id, field_name);
CREATE INDEX IF NOT EXISTS idx_efs_entity
  ON entity_field_state(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_efs_pending
  ON entity_field_state(field_name)
  WHERE pending_proposals != '{}';
CREATE INDEX IF NOT EXISTS idx_efs_pending_deletions
  ON entity_field_state(entity_type, entity_id)
  WHERE pending_deletions != '[]';

PRAGMA foreign_keys = ON;

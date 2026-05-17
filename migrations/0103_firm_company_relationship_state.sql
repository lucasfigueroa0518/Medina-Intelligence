-- Canonical firm relationship state for MARTy.
--
-- Company fields/tags are useful supporting evidence, but "current portfolio"
-- is a firm fact that should not be inferred from semantic retrieval alone.
-- This table provides an authoritative, time-aware override layer that MARTy
-- can consult before answering portfolio/pipeline questions.

CREATE TABLE IF NOT EXISTS firm_company_relationships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  relationship_state TEXT NOT NULL CHECK (
    relationship_state IN (
      'current_portfolio',
      'active_pipeline',
      'watchlist',
      'passed',
      'exited',
      'other'
    )
  ),
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL NOT NULL DEFAULT 1.0,
  effective_date TEXT,
  ended_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_firm_company_relationships_active_state
  ON firm_company_relationships (org_id, company_id, relationship_state)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_firm_company_relationships_org_state
  ON firm_company_relationships (org_id, relationship_state, ended_at);

CREATE INDEX IF NOT EXISTS idx_firm_company_relationships_company
  ON firm_company_relationships (company_id, ended_at);

-- Seed the current portfolio names that are known foundational Medina facts as
-- of this rollout. This is deliberately narrow; future changes should update
-- firm_company_relationships instead of relying on fuzzy company tags.
INSERT OR IGNORE INTO firm_company_relationships (
  id,
  org_id,
  company_id,
  relationship_state,
  source,
  confidence,
  effective_date,
  notes
)
SELECT
  lower(hex(randomblob(16))),
  org_id,
  id,
  'current_portfolio',
  'foundational_seed',
  1.0,
  '2026-05-17',
  'Seeded from Medina current portfolio correction: Tier 4 AI, QNECT/Qunnect, Hedgehog, NeuralSeek.'
FROM companies
WHERE deleted_at IS NULL
  AND lower(replace(replace(replace(name, ' ', ''), '-', ''), '_', '')) IN (
    'tier4ai',
    'qnect',
    'qunnect',
    'hedgehog',
    'neuralseek',
    'neuralseekai'
  );

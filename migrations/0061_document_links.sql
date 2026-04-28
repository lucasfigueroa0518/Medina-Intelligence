-- Wave 2: documents convergence — junction table for many-to-many entity links.
-- Replaces the four scalar FK columns (contact_id, company_id, deal_id,
-- conversation_id) with a normalized link table. Scalar columns are kept on
-- `documents` as a denormalization so handlers can be flipped back during
-- rollout if the junction queries misbehave; a future mini-wave drops them
-- after Wave 4 stabilizes the UI side.
--
-- link_kind / link_source: link_kind tells you *how* this doc relates to the
-- entity (a deck attached to an email is `attached` for the conversation,
-- `primary` for the company it pitches, `mentioned` for any individuals it
-- names). link_source distinguishes pipeline-written vs. user-clicked-link
-- vs. LLM-extracted-from-text — the last is for a future feature.

CREATE TABLE IF NOT EXISTS document_links (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  org_id TEXT NOT NULL,

  entity_type TEXT NOT NULL CHECK (entity_type IN ('contact', 'company', 'deal', 'conversation', 'event', 'agent_message')),
  entity_id TEXT NOT NULL,

  link_kind TEXT NOT NULL CHECK (link_kind IN ('primary', 'attached', 'mentioned', 'derived')),
  link_source TEXT NOT NULL CHECK (link_source IN ('pipeline', 'manual', 'llm_extracted')),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT,
  deleted_at TEXT,

  FOREIGN KEY (document_id) REFERENCES documents(id),
  UNIQUE (document_id, entity_type, entity_id, link_kind)
);

CREATE INDEX IF NOT EXISTS idx_document_links_doc
  ON document_links (document_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_links_entity
  ON document_links (entity_type, entity_id, org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_links_org_entity
  ON document_links (org_id, entity_type, entity_id) WHERE deleted_at IS NULL;

-- Backfill from existing scalar FKs. INSERT OR IGNORE so re-running this
-- migration on a partially-populated table is a no-op (the UNIQUE constraint
-- blocks dupes).
INSERT OR IGNORE INTO document_links (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
  SELECT lower(hex(randomblob(16))), id, org_id, 'contact', contact_id, 'primary', 'pipeline', created_at
    FROM documents WHERE contact_id IS NOT NULL AND deleted_at IS NULL;

INSERT OR IGNORE INTO document_links (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
  SELECT lower(hex(randomblob(16))), id, org_id, 'company', company_id, 'primary', 'pipeline', created_at
    FROM documents WHERE company_id IS NOT NULL AND deleted_at IS NULL;

INSERT OR IGNORE INTO document_links (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
  SELECT lower(hex(randomblob(16))), id, org_id, 'deal', deal_id, 'primary', 'pipeline', created_at
    FROM documents WHERE deal_id IS NOT NULL AND deleted_at IS NULL;

INSERT OR IGNORE INTO document_links (id, document_id, org_id, entity_type, entity_id, link_kind, link_source, created_at)
  SELECT lower(hex(randomblob(16))), id, org_id, 'conversation', conversation_id, 'primary', 'pipeline', created_at
    FROM documents WHERE conversation_id IS NOT NULL AND deleted_at IS NULL;

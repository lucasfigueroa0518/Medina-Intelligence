-- 0048: Document versioning, attachment tracking, access control
-- Recreates documents table to drop restrictive CHECK constraints on source/document_type
-- and adds new columns for version tracking, conversation linking, and access control.

DROP VIEW IF EXISTS active_documents;

CREATE TABLE documents_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'other',
  source TEXT NOT NULL DEFAULT 'manual',
  r2_key TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  extracted_text_preview TEXT,
  vector_id TEXT,
  custom_fields TEXT DEFAULT '{}',
  content_hash TEXT,
  parent_document_id TEXT,
  version_number INTEGER DEFAULT 1,
  conversation_id TEXT,
  visibility TEXT DEFAULT 'org_wide',
  participant_user_ids TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

INSERT INTO documents_new SELECT
  id, org_id, title, document_type, source, r2_key, file_name, file_size, mime_type,
  contact_id, company_id, deal_id, uploaded_by, processing_status, extracted_text_preview,
  vector_id, custom_fields,
  NULL, NULL, 1, NULL, 'org_wide', NULL, NULL,
  created_at, updated_at, deleted_at
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

CREATE INDEX idx_documents_org_id ON documents(org_id);
CREATE INDEX idx_documents_contact_id ON documents(contact_id);
CREATE INDEX idx_documents_company_id ON documents(company_id);
CREATE INDEX idx_documents_deal_id ON documents(deal_id);
CREATE INDEX idx_documents_processing_status ON documents(processing_status);
CREATE INDEX idx_documents_content_hash ON documents(content_hash);
CREATE INDEX idx_documents_parent ON documents(parent_document_id);
CREATE INDEX idx_documents_conversation ON documents(conversation_id);

-- Recreate the active_documents view
CREATE VIEW active_documents AS SELECT * FROM documents WHERE deleted_at IS NULL;

-- Attachment tracking on conversations
ALTER TABLE conversations ADD COLUMN has_attachments INTEGER DEFAULT 0;
ALTER TABLE conversations ADD COLUMN attachment_count INTEGER DEFAULT 0;

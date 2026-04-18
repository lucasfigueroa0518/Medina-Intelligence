CREATE TABLE documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'other'
    CHECK(document_type IN ('pitch_deck','financials','legal','memo','report','spreadsheet','presentation','other')),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK(source IN ('upload','email_attachment','manual')),
  r2_key TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  mime_type TEXT,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(processing_status IN ('pending','processing','completed','failed')),
  extracted_text_preview TEXT,
  vector_id TEXT,
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX idx_documents_org_id ON documents(org_id);
CREATE INDEX idx_documents_contact_id ON documents(contact_id);
CREATE INDEX idx_documents_company_id ON documents(company_id);
CREATE INDEX idx_documents_deal_id ON documents(deal_id);
CREATE INDEX idx_documents_processing_status ON documents(processing_status);

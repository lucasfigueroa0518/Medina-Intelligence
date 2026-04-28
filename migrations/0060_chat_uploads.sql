-- MARTy chat uploads: ephemeral file attachments tied to agent sessions.
-- Files live in R2 under chat-uploads/{userId}/{id}.{ext}; this row tracks
-- ownership, extracted text, expiry, and (optionally) a pointer back to the
-- documents row when the user opted to save it permanently to the RAG corpus.

CREATE TABLE IF NOT EXISTS chat_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  session_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  upload_type TEXT NOT NULL CHECK (upload_type IN ('pdf','image','document','spreadsheet','presentation','text','data')),
  extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','processing','completed','failed','skipped')),
  extracted_text TEXT,
  preview_text TEXT,
  saved_to_documents INTEGER NOT NULL DEFAULT 0,
  saved_document_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_uploads_user ON chat_uploads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_uploads_session ON chat_uploads(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_uploads_expiry ON chat_uploads(expires_at) WHERE saved_to_documents = 0;

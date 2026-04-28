-- MARTy retrieval failure handling: persist a friendly assistant message when
-- retrieveContext throws, with the underlying error captured in metadata for
-- debugging. The metadata column is general-purpose JSON for any per-message
-- diagnostic data that doesn't fit existing columns.

ALTER TABLE agent_messages ADD COLUMN metadata TEXT;

-- Composite indexes for scale — approval queue, conversations, conversation_contacts, contacts

CREATE INDEX IF NOT EXISTS idx_approval_org_status_date ON approval_queue(org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_org_sent ON conversations(org_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_conv_contacts_conversation ON conversation_contacts(conversation_id);

CREATE INDEX IF NOT EXISTS idx_contacts_org_name ON contacts(org_id, full_name);

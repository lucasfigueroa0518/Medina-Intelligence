CREATE TABLE conversation_contacts (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  role TEXT DEFAULT 'participant',
  PRIMARY KEY (conversation_id, contact_id)
);
CREATE INDEX idx_conv_contacts_contact ON conversation_contacts(contact_id);

-- 0109_contact_detail_read_models.sql
-- Fast contact-detail read models. These tables bound contact clicks to
-- contact-local indexed rows instead of org-wide joins over conversations,
-- events, and junction tables.

CREATE TABLE IF NOT EXISTS contact_activity_rollups (
  contact_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  first_interaction_date TEXT,
  last_activity_at TEXT,
  last_conversation_at TEXT,
  last_event_at TEXT,
  last_task_at TEXT,
  last_document_at TEXT,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0,
  weekly_interactions_json TEXT NOT NULL DEFAULT '[]',
  rebuilt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_activity_rollups_org_activity
  ON contact_activity_rollups(org_id, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_activity_rollups_org_updated
  ON contact_activity_rollups(org_id, updated_at);

CREATE TABLE IF NOT EXISTS contact_timeline_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('conversation', 'event', 'task', 'document')),
  item_id TEXT NOT NULL,
  item_timestamp TEXT NOT NULL,
  title TEXT,
  subtype TEXT,
  body_preview TEXT,
  source TEXT,
  external_thread_id TEXT,
  external_message_id TEXT,
  participant_user_ids TEXT,
  visibility TEXT,
  uploaded_by TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, contact_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_timeline_contact_time
  ON contact_timeline_items(org_id, contact_id, item_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_contact_timeline_source_item
  ON contact_timeline_items(item_type, item_id);

CREATE INDEX IF NOT EXISTS idx_contact_timeline_org_updated
  ON contact_timeline_items(org_id, updated_at);

CREATE TABLE IF NOT EXISTS contact_detail_read_model_repairs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(org_id, contact_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_contact_detail_repairs_status
  ON contact_detail_read_model_repairs(org_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_approval_contact_entity_date
  ON approval_queue(org_id, entity_type, entity_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_assoc_a_conf
  ON contact_associations(contact_id_a, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_contact_assoc_b_conf
  ON contact_associations(contact_id_b, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_conv_contacts_contact_conversation
  ON conversation_contacts(contact_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_event_attendees_contact_event
  ON event_attendees(contact_id, event_id);

CREATE INDEX IF NOT EXISTS idx_tasks_contact_due
  ON tasks(org_id, contact_id, due_date DESC);

CREATE INDEX IF NOT EXISTS idx_document_links_contact_created
  ON document_links(org_id, entity_type, entity_id, created_at DESC)
  WHERE deleted_at IS NULL;

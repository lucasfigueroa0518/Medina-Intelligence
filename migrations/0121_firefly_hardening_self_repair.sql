-- Fireflies hardening: durable webhook delivery ledger.
--
-- The webhook endpoint now records every Fireflies delivery before handing
-- work to queues. This makes "Fireflies sent nothing" distinguishable from
-- "we received it but failed/deferred hydration".

CREATE TABLE IF NOT EXISTS firefly_webhook_deliveries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  delivery_key TEXT NOT NULL,
  firefly_event_id TEXT,
  event_name TEXT,
  payload_hash TEXT NOT NULL,
  payload_excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','queued','ignored','hydrating','hydrated','deferred','failed')),
  work_queue_id TEXT,
  transcript_item_id TEXT REFERENCES firefly_transcript_items(id) ON DELETE SET NULL,
  selected_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  linked_events INTEGER NOT NULL DEFAULT 0,
  r2_staged INTEGER NOT NULL DEFAULT 0,
  embedding_queued INTEGER NOT NULL DEFAULT 0,
  prospect_queued INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  queued_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE(org_id, delivery_key)
);

CREATE INDEX IF NOT EXISTS idx_firefly_webhook_deliveries_org_status
  ON firefly_webhook_deliveries(org_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_firefly_webhook_deliveries_firefly
  ON firefly_webhook_deliveries(org_id, firefly_event_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_firefly_webhook_deliveries_user
  ON firefly_webhook_deliveries(org_id, selected_user_id, completed_at DESC);

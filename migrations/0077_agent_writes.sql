-- agent_writes — unified audit trail for every direct write that lands
-- through src/lib/entity-writes.ts. Distinguishes manual UI writes from
-- MARTy God Mode writes via the `origin` column. Every accepted field
-- write produces one row; entity creates produce a single create_entity
-- row with after_value = full payload; field deletions produce a
-- delete_field row with before_value populated.
--
-- This is separate from the legacy audit_events stream:
--  • audit_events is broad/coarse and used for the entity-level activity
--    feed. agent_writes is fine-grained (per-field) and built for the
--    "what has MARTy been touching" question without grepping JSON
--    metadata in audit_events.
--  • agent_writes never blocks a write — log failures are swallowed in
--    the helper so the user-facing write still succeeds.

CREATE TABLE IF NOT EXISTS agent_writes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  origin TEXT NOT NULL,             -- 'manual_ui' | 'marty'
  entity_type TEXT NOT NULL,        -- 'contact' | 'company' | 'deal'
  entity_id TEXT NOT NULL,
  field_name TEXT,                  -- NULL for create_entity rows
  action TEXT NOT NULL,             -- 'update' | 'delete_field' | 'create_entity'
  before_value TEXT,                -- JSON-encoded scalar/object; NULL for create_entity
  after_value TEXT,                 -- JSON-encoded scalar/object; NULL for delete_field
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_writes_org_created
  ON agent_writes(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_writes_origin_created
  ON agent_writes(org_id, origin, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_writes_entity
  ON agent_writes(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_writes_user
  ON agent_writes(user_id, created_at DESC);

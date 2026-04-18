CREATE TABLE audit_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL CHECK(action IN (
    'create','update','soft_delete','hard_delete',
    'merge','enrich',
    'tag_apply','tag_remove','tag_delete',
    'approve','reject','auto_approve',
    'campaign_send','import','login','token_refresh_failed'
  )),
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_data TEXT,
  after_data TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_log_org ON audit_log(org_id);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

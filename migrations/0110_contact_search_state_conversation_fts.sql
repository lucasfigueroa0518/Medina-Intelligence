-- 0110_contact_search_state_conversation_fts.sql
-- Pareto reliability hardening:
--   1. A normal indexed sidecar for contact_search_fts health checks.
--   2. FTS-backed conversation search for MARTy recall beyond the recent window.

CREATE TABLE IF NOT EXISTS contact_search_index_state (
  org_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  contact_updated_at TEXT,
  indexed_at TEXT,
  status TEXT NOT NULL DEFAULT 'indexed'
    CHECK (status IN ('indexed','stale','failed','deleted')),
  last_error TEXT,
  repair_attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_search_state_org_status
  ON contact_search_index_state(org_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_contact_search_state_org_indexed
  ON contact_search_index_state(org_id, indexed_at);

INSERT OR REPLACE INTO contact_search_index_state
  (org_id, contact_id, contact_updated_at, indexed_at, status, updated_at)
SELECT
  org_id,
  contact_id,
  updated_at,
  COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  'indexed',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM contact_search_fts
WHERE org_id IS NOT NULL
  AND org_id != ''
  AND contact_id IS NOT NULL
  AND contact_id != '';

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search_fts USING fts5(
  subject,
  body_preview,
  from_email,
  to_emails,
  cc_emails,
  participant_names,
  source,
  conversation_id UNINDEXED,
  org_id UNINDEXED,
  sent_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

DELETE FROM conversation_search_fts;

INSERT INTO conversation_search_fts
  (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
SELECT
  c.id,
  c.org_id,
  c.sent_at,
  COALESCE(c.subject, ''),
  COALESCE(c.body_preview, ''),
  COALESCE(c.from_email, ''),
  COALESCE(c.to_emails, ''),
  COALESCE(c.cc_emails, ''),
  COALESCE(p.participant_names, ''),
  COALESCE(c.source, '')
FROM conversations c
LEFT JOIN (
  SELECT
    cc.conversation_id,
    GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ') AS participant_names
  FROM conversation_contacts cc
  LEFT JOIN contacts ct ON ct.id = cc.contact_id
  GROUP BY cc.conversation_id
) p ON p.conversation_id = c.id;

DROP TRIGGER IF EXISTS trg_conversation_search_ai;
CREATE TRIGGER trg_conversation_search_ai
AFTER INSERT ON conversations
BEGIN
  DELETE FROM conversation_search_fts WHERE conversation_id = NEW.id;
  INSERT INTO conversation_search_fts
    (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
  VALUES (
    NEW.id,
    NEW.org_id,
    NEW.sent_at,
    COALESCE(NEW.subject, ''),
    COALESCE(NEW.body_preview, ''),
    COALESCE(NEW.from_email, ''),
    COALESCE(NEW.to_emails, ''),
    COALESCE(NEW.cc_emails, ''),
    COALESCE((
      SELECT GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ')
      FROM conversation_contacts cc
      LEFT JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.conversation_id = NEW.id
    ), ''),
    COALESCE(NEW.source, '')
  );
END;

DROP TRIGGER IF EXISTS trg_conversation_search_au;
CREATE TRIGGER trg_conversation_search_au
AFTER UPDATE ON conversations
BEGIN
  DELETE FROM conversation_search_fts WHERE conversation_id = NEW.id;
  INSERT INTO conversation_search_fts
    (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
  VALUES (
    NEW.id,
    NEW.org_id,
    NEW.sent_at,
    COALESCE(NEW.subject, ''),
    COALESCE(NEW.body_preview, ''),
    COALESCE(NEW.from_email, ''),
    COALESCE(NEW.to_emails, ''),
    COALESCE(NEW.cc_emails, ''),
    COALESCE((
      SELECT GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ')
      FROM conversation_contacts cc
      LEFT JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.conversation_id = NEW.id
    ), ''),
    COALESCE(NEW.source, '')
  );
END;

DROP TRIGGER IF EXISTS trg_conversation_search_ad;
CREATE TRIGGER trg_conversation_search_ad
AFTER DELETE ON conversations
BEGIN
  DELETE FROM conversation_search_fts WHERE conversation_id = OLD.id;
END;

DROP TRIGGER IF EXISTS trg_conversation_contacts_search_ai;
CREATE TRIGGER trg_conversation_contacts_search_ai
AFTER INSERT ON conversation_contacts
BEGIN
  DELETE FROM conversation_search_fts WHERE conversation_id = NEW.conversation_id;
  INSERT INTO conversation_search_fts
    (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
  SELECT
    c.id,
    c.org_id,
    c.sent_at,
    COALESCE(c.subject, ''),
    COALESCE(c.body_preview, ''),
    COALESCE(c.from_email, ''),
    COALESCE(c.to_emails, ''),
    COALESCE(c.cc_emails, ''),
    COALESCE((
      SELECT GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ')
      FROM conversation_contacts cc
      LEFT JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.conversation_id = c.id
    ), ''),
    COALESCE(c.source, '')
  FROM conversations c
  WHERE c.id = NEW.conversation_id;
END;

DROP TRIGGER IF EXISTS trg_conversation_contacts_search_au;
CREATE TRIGGER trg_conversation_contacts_search_au
AFTER UPDATE ON conversation_contacts
BEGIN
  DELETE FROM conversation_search_fts WHERE conversation_id = OLD.conversation_id;
  INSERT INTO conversation_search_fts
    (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
  SELECT
    c.id,
    c.org_id,
    c.sent_at,
    COALESCE(c.subject, ''),
    COALESCE(c.body_preview, ''),
    COALESCE(c.from_email, ''),
    COALESCE(c.to_emails, ''),
    COALESCE(c.cc_emails, ''),
    COALESCE((
      SELECT GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ')
      FROM conversation_contacts cc
      LEFT JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.conversation_id = c.id
    ), ''),
    COALESCE(c.source, '')
  FROM conversations c
  WHERE c.id = OLD.conversation_id;

  DELETE FROM conversation_search_fts WHERE conversation_id = NEW.conversation_id;
  INSERT INTO conversation_search_fts
    (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
  SELECT
    c.id,
    c.org_id,
    c.sent_at,
    COALESCE(c.subject, ''),
    COALESCE(c.body_preview, ''),
    COALESCE(c.from_email, ''),
    COALESCE(c.to_emails, ''),
    COALESCE(c.cc_emails, ''),
    COALESCE((
      SELECT GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ')
      FROM conversation_contacts cc
      LEFT JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.conversation_id = c.id
    ), ''),
    COALESCE(c.source, '')
  FROM conversations c
  WHERE c.id = NEW.conversation_id;
END;

DROP TRIGGER IF EXISTS trg_conversation_contacts_search_ad;
CREATE TRIGGER trg_conversation_contacts_search_ad
AFTER DELETE ON conversation_contacts
BEGIN
  DELETE FROM conversation_search_fts WHERE conversation_id = OLD.conversation_id;
  INSERT INTO conversation_search_fts
    (conversation_id, org_id, sent_at, subject, body_preview, from_email, to_emails, cc_emails, participant_names, source)
  SELECT
    c.id,
    c.org_id,
    c.sent_at,
    COALESCE(c.subject, ''),
    COALESCE(c.body_preview, ''),
    COALESCE(c.from_email, ''),
    COALESCE(c.to_emails, ''),
    COALESCE(c.cc_emails, ''),
    COALESCE((
      SELECT GROUP_CONCAT(COALESCE(ct.full_name, '') || ' ' || COALESCE(ct.email, ''), ' ')
      FROM conversation_contacts cc
      LEFT JOIN contacts ct ON ct.id = cc.contact_id
      WHERE cc.conversation_id = c.id
    ), ''),
    COALESCE(c.source, '')
  FROM conversations c
  WHERE c.id = OLD.conversation_id;
END;

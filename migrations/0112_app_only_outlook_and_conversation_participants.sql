-- App-only Outlook migration support + exact conversation ACL participants.

ALTER TABLE users ADD COLUMN outlook_mailbox TEXT;

CREATE TABLE IF NOT EXISTS conversation_participants (
  org_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'participant_user_ids',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_participants_user
  ON conversation_participants(org_id, user_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation
  ON conversation_participants(org_id, conversation_id);

INSERT OR IGNORE INTO conversation_participants (org_id, conversation_id, user_id, source)
SELECT c.org_id, c.id, CAST(j.value AS TEXT), 'backfill_json'
  FROM conversations c,
       json_each(CASE WHEN json_valid(c.participant_user_ids) THEN c.participant_user_ids ELSE '[]' END) j
 WHERE CAST(j.value AS TEXT) != '';

WITH RECURSIVE split(org_id, conversation_id, rest, user_id) AS (
  SELECT org_id, id, COALESCE(participant_user_ids, '') || ',', ''
    FROM conversations
   WHERE participant_user_ids IS NOT NULL
     AND participant_user_ids != ''
     AND NOT json_valid(participant_user_ids)
  UNION ALL
  SELECT org_id,
         conversation_id,
         substr(rest, instr(rest, ',') + 1),
         trim(substr(rest, 1, instr(rest, ',') - 1))
    FROM split
   WHERE rest != ''
)
INSERT OR IGNORE INTO conversation_participants (org_id, conversation_id, user_id, source)
SELECT org_id, conversation_id, user_id, 'backfill_csv'
  FROM split
 WHERE user_id != '';

-- 0042: Normalize the `lucas-admin` slug user ID to a proper UUID.
-- Old:  lucas-admin
-- New:  ceb817b3-57bf-43ed-9156-93ca493fc793
--
-- Touches users + 9 FK tables + JSON-encoded conversations.participant_user_ids.
-- Lucas's existing JWTs reference the old id and will stop matching the users
-- row after this runs; he will need to re-login. auth_tokens are repointed so
-- token-revocation rows survive.
--
-- FK enforcement is disabled for the duration of the batch so the users.id
-- update doesn't violate referencing tables mid-flight.

PRAGMA foreign_keys = OFF;

UPDATE users SET id = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE id = 'lucas-admin';

UPDATE conversations
   SET participant_user_ids = REPLACE(participant_user_ids, 'lucas-admin', 'ceb817b3-57bf-43ed-9156-93ca493fc793')
 WHERE participant_user_ids LIKE '%lucas-admin%';

UPDATE deals               SET owner_id              = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE owner_id              = 'lucas-admin';
UPDATE contacts            SET relationship_owner_id = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE relationship_owner_id = 'lucas-admin';
UPDATE agent_sessions      SET user_id               = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE user_id               = 'lucas-admin';
UPDATE approval_queue      SET resolved_by           = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE resolved_by           = 'lucas-admin';
UPDATE audit_log           SET user_id               = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE user_id               = 'lucas-admin';
UPDATE rag_query_logs      SET user_id               = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE user_id               = 'lucas-admin';
UPDATE auth_tokens         SET user_id               = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE user_id               = 'lucas-admin';
UPDATE contact_tags        SET applied_by            = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE applied_by            = 'lucas-admin';

-- The remaining FK columns currently have zero rows referencing 'lucas-admin'
-- (verified pre-flight) but are included for completeness in case new rows
-- arrive between count and execution.
UPDATE tasks                 SET created_by    = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE created_by    = 'lucas-admin';
UPDATE tasks                 SET assigned_to   = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE assigned_to   = 'lucas-admin';
UPDATE event_attendees       SET user_id       = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE user_id       = 'lucas-admin';
UPDATE documents             SET uploaded_by   = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE uploaded_by   = 'lucas-admin';
UPDATE merge_locks           SET locked_by     = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE locked_by     = 'lucas-admin';
UPDATE deal_notes            SET author_id     = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE author_id     = 'lucas-admin';
UPDATE deal_action_items     SET assignee_id   = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE assignee_id   = 'lucas-admin';
UPDATE email_campaigns       SET created_by    = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE created_by    = 'lucas-admin';
UPDATE email_campaigns       SET sender_user_id= 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE sender_user_id= 'lucas-admin';
UPDATE import_jobs           SET created_by    = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE created_by    = 'lucas-admin';
UPDATE duplicate_candidates  SET resolved_by   = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE resolved_by   = 'lucas-admin';
UPDATE dlq_entries           SET resolved_by   = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE resolved_by   = 'lucas-admin';
UPDATE graph_subscriptions   SET user_id       = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE user_id       = 'lucas-admin';
UPDATE tags                  SET created_by    = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE created_by    = 'lucas-admin';
UPDATE company_tags          SET applied_by    = 'ceb817b3-57bf-43ed-9156-93ca493fc793' WHERE applied_by    = 'lucas-admin';

PRAGMA foreign_keys = ON;

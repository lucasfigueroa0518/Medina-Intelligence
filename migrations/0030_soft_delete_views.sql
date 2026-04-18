CREATE VIEW active_contacts AS SELECT * FROM contacts WHERE deleted_at IS NULL;
CREATE VIEW active_companies AS SELECT * FROM companies WHERE deleted_at IS NULL;
CREATE VIEW active_events AS SELECT * FROM events WHERE deleted_at IS NULL;
CREATE VIEW active_documents AS SELECT * FROM documents WHERE deleted_at IS NULL;
CREATE VIEW active_deals AS SELECT * FROM deals WHERE deleted_at IS NULL;
CREATE VIEW active_tasks AS SELECT * FROM tasks WHERE deleted_at IS NULL;

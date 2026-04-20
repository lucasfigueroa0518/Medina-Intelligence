-- Add entity_type column to tags and seed default tags.
-- Since the UNIQUE(org_id, name) constraint must become UNIQUE(org_id, name, entity_type)
-- and SQLite cannot alter constraints, we recreate the tables (no existing tag data).

DROP TABLE IF EXISTS contact_tags;
DROP TABLE IF EXISTS company_tags;
DROP TABLE IF EXISTS tags;

CREATE TABLE tags (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#888888',
  entity_type TEXT NOT NULL DEFAULT 'contact' CHECK(entity_type IN ('contact', 'company')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(org_id, name, entity_type)
);
CREATE INDEX idx_tags_org_id ON tags(org_id);
CREATE INDEX idx_tags_entity_type ON tags(org_id, entity_type);

CREATE TABLE contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  applied_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE company_tags (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  applied_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (company_id, tag_id)
);
CREATE INDEX idx_company_tags_company ON company_tags(company_id);
CREATE INDEX idx_company_tags_tag ON company_tags(tag_id);

-- Seed contact tags
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Investor', '#10B981', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Founder', '#8B5CF6', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Government', '#F59E0B', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Startup', '#3B82F6', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Friend', '#EC4899', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Advisor', '#6366F1', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'LP', '#14B8A6', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Portfolio CEO', '#F97316', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Lawyer', '#64748B', 'contact');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Banker', '#78716C', 'contact');

-- Seed company tags
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Startup', '#3B82F6', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Fund', '#10B981', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Institution', '#8B5CF6', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Family Office', '#F59E0B', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'University', '#EC4899', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Portfolio Company', '#14B8A6', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Service Provider', '#64748B', 'company');
INSERT INTO tags (id, org_id, name, color, entity_type) VALUES (lower(hex(randomblob(16))), 'medina-ventures', 'Government', '#F97316', 'company');

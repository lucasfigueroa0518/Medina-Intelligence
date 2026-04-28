-- 0051: Add super_admin role and per-user email sharing toggle
-- Drops restrictive CHECK on role to allow super_admin, adds share_emails_org_wide column.

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  outlook_token TEXT,
  slack_token TEXT,
  outlook_delta_token TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  password_hash TEXT,
  email_verified INTEGER DEFAULT 0,
  last_login_at TEXT,
  phone TEXT,
  job_title TEXT,
  linkedin_url TEXT,
  bio TEXT,
  mfa_secret TEXT,
  mfa_recovery_codes TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_enrolled_at TEXT,
  mfa_failed_attempts INTEGER NOT NULL DEFAULT 0,
  mfa_locked_until TEXT,
  share_emails_org_wide INTEGER NOT NULL DEFAULT 0
);

INSERT INTO users_new (
  id, org_id, email, full_name, avatar_url, role, outlook_token, slack_token,
  outlook_delta_token, is_active, created_at, updated_at, deleted_at,
  password_hash, email_verified, last_login_at, phone, job_title, linkedin_url, bio,
  mfa_secret, mfa_recovery_codes, mfa_enabled, mfa_enrolled_at, mfa_failed_attempts, mfa_locked_until
)
SELECT
  id, org_id, email, full_name, avatar_url, role, outlook_token, slack_token,
  outlook_delta_token, is_active, created_at, updated_at, deleted_at,
  password_hash, email_verified, last_login_at, phone, job_title, linkedin_url, bio,
  mfa_secret, mfa_recovery_codes, mfa_enabled, mfa_enrolled_at, mfa_failed_attempts, mfa_locked_until
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX idx_users_org_id ON users(org_id);
CREATE INDEX idx_users_email ON users(email);

-- Set Tony as super_admin
UPDATE users SET role = 'super_admin' WHERE email = 'tony@medinavc.com';

PRAGMA foreign_keys = ON;

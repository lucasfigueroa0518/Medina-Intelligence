-- 0045: Optional TOTP 2FA

ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_recovery_codes TEXT;
ALTER TABLE users ADD COLUMN mfa_enrolled_at TEXT;
ALTER TABLE users ADD COLUMN mfa_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until TEXT;

-- Pending enrollment secrets — written when a user clicks "Enable 2FA" in settings,
-- consumed on successful enrollment confirm. Keyed by user_id (one pending at a time).
CREATE TABLE IF NOT EXISTS auth_mfa_pending (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  secret TEXT NOT NULL,
  recovery_hashes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

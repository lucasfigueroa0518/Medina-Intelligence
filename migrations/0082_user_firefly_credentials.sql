-- Phase 4 (2026-05-04) — persistent per-user Firefly API key.
--
-- Replaces the prior "user pastes API key on every backfill, key is
-- nuked on job completion per Phase F Q(a) least-privilege" UX with a
-- "set-once, reuse-forever" model. The driver
-- (driveFireflyProgressiveBackfill) now reads from this table first
-- and falls back to the legacy per-job api_key_encrypted column for
-- in-flight backfills created before this phase.
--
-- Security model:
--   • api_key_encrypted holds AES-256-GCM ciphertext via
--     src/lib/encryption.ts:encryptToken (same scheme as Outlook OAuth
--     tokens). Plaintext lives only in Worker memory at decrypt time
--     (src/lib/firefly-credentials.ts:getFireflyKey).
--   • No HTTP endpoint returns plaintext. Status endpoints return
--     metadata only (created_at, updated_at, last_used_at,
--     rotation_count).
--   • Hard delete on user-initiated revoke (DELETE
--     /api/settings/firefly-credentials). Re-storing creates a fresh
--     row — no soft-delete / revoked_at column. Per Lucas 2026-05-04:
--     simpler schema, simpler reasoning.
--   • User-removal cascade is handled by the FK constraint below
--     (ON DELETE CASCADE). When a user row is hard-deleted from
--     `users`, the corresponding credential row is removed
--     automatically. Note: no user-removal handler exists in the
--     codebase yet (Lucas 2026-05-04 audit confirmed no DELETE FROM
--     users / UPDATE users.deleted_at writers anywhere); the FK is
--     latent safety for whenever that handler is eventually built.
--     The schema is the audit surface — anyone reading the migration
--     sees the relationship without having to grep handler code.
--
-- Schema:
--   • user_id is PRIMARY KEY — one persistent key per user.
--   • created_at / updated_at: row lifecycle. updated_at advances on
--     every storeFireflyKey call (which UPSERTs).
--   • last_used_at: bumped on every getFireflyKey call. Drives the
--     "key is healthy / actively in use" signal for System Status.
--   • rotation_count: increments on every UPSERT-as-update. 0 means
--     "first store, never rotated"; >0 means "rotated N times since
--     creation". Helpful audit trail for "why did Tony's key suddenly
--     stop working — did he rotate it?"
--
-- Operationally:
--   • New backfill creation: when an api_key is supplied via the
--     existing /api/admin/firefly-progressive-backfill POST body,
--     storeFireflyKey writes here in addition to the legacy per-job
--     encryption (dual-write for safety during transition).
--   • New backfill creation WITHOUT api_key: the driver looks up here.
--     If no row exists, return error with prompt-to-set-up message.
--   • User removal: handled automatically by the FK ON DELETE CASCADE
--     below. Lucas 2026-05-04 course-correction: the original Q2
--     answer was "explicit DELETE in user-removal handler" but the
--     2026-05-04 codebase audit revealed no user-removal handler
--     exists yet. FK CASCADE is the auditable surface in the
--     current state (visible in the schema, not buried in handler
--     code) AND it's safety-by-default for whenever a removal
--     handler eventually gets built.

CREATE TABLE IF NOT EXISTS user_firefly_credentials (
  user_id TEXT PRIMARY KEY,
  api_key_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  rotation_count INTEGER NOT NULL DEFAULT 0,
  -- FK ON DELETE CASCADE: when a user row is removed (whenever such a
  -- handler exists), the credential row is automatically removed too.
  -- Latent safety; no current code path triggers it.
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- No additional indexes — PK lookup on user_id is the hot path.
-- System Status read scans the entire table (small — bounded by
-- active-Firefly-user count); a covering index would just bloat.

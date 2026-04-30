-- Wave 5 Phase E — canonicalize documents.source to 4 active values.
--
-- Pre-Phase-E state: src/lib/persist-document.ts:209-211 normalized
-- `manual_upload → upload` on insert, so production has a mix of
-- legacy 'upload' / 'manual' strings AND newer canonical names.
-- This migration backfills existing rows; persist-document no longer
-- normalizes (Phase E commit).
--
-- Mapping:
--   'manual'                              → 'manual_upload'
--   'upload' WHERE uploaded_by IS NOT NULL → 'manual_upload'
--   'upload' WHERE uploaded_by IS NULL    → 'email_attachment'
--
-- HEURISTIC SAFETY GATE — the second mapping rule rests on the
-- assumption that pre-Phase-E system-ingested rows ('uploaded_by IS NULL')
-- with source='upload' are exclusively email_attachment. This is true
-- IFF every such row has conversation_id IS NOT NULL (the email-thread
-- fingerprint).
--
-- ============================================================================
-- ⚠ RUN THIS GATE QUERY BEFORE APPLYING THIS MIGRATION ⚠
-- ============================================================================
--
--   SELECT
--     COUNT(*) FILTER (WHERE uploaded_by IS NULL) AS upload_no_uploader,
--     COUNT(*) FILTER (WHERE uploaded_by IS NULL AND conversation_id IS NOT NULL) AS upload_no_uploader_with_conversation
--   FROM documents
--   WHERE org_id='medina-ventures' AND deleted_at IS NULL AND source='upload';
--
-- EXPECTED: both counts equal. Then it is safe to apply this migration.
-- IF UNEQUAL: there are 'upload'/NULL-uploader rows that aren't email
-- attachments. Investigate before migrating; the heuristic miscategorizes
-- those rows. Do NOT run this migration until the gap is resolved.
-- ============================================================================
--
-- The migration includes an in-SQL guard via a CHECK-violating temp table
-- below: if any row violates the heuristic at apply time, the temp INSERT
-- raises a CHECK error and aborts the migration before any UPDATE runs.
-- This catches the case where new violating rows landed between gate-check
-- and migration-apply.

-- Guard step — abort migration if heuristic doesn't hold.
-- Inserts a row only when a violation exists; CHECK(id=0) fails on insert,
-- which aborts the entire transaction. No-op when no violation.
CREATE TABLE IF NOT EXISTS _migration_0068_gate (id INTEGER PRIMARY KEY CHECK(id = 0));
INSERT INTO _migration_0068_gate (id)
  SELECT 1 FROM documents
   WHERE source = 'upload'
     AND uploaded_by IS NULL
     AND conversation_id IS NULL
     AND deleted_at IS NULL
   LIMIT 1;
DROP TABLE _migration_0068_gate;

-- Step 1: legacy 'manual' → canonical 'manual_upload'
UPDATE documents
   SET source = 'manual_upload',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE source = 'manual'
   AND deleted_at IS NULL;

-- Step 2: 'upload' rows with a human uploader → 'manual_upload'
UPDATE documents
   SET source = 'manual_upload',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE source = 'upload'
   AND uploaded_by IS NOT NULL
   AND deleted_at IS NULL;

-- Step 3: 'upload' rows without uploader (system-ingested) → 'email_attachment'
UPDATE documents
   SET source = 'email_attachment',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE source = 'upload'
   AND uploaded_by IS NULL
   AND deleted_at IS NULL;

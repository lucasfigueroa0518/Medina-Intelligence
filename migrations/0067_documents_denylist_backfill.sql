-- Wave 5 Phase B — backfill existing junk rows to processing_status='excluded'.
-- New ingestions (post-deploy) skip these mimes/filenames pre-persist via
-- src/lib/document-denylist.ts isDenylisted() called from attachment-processor.ts.
-- This migration cleans up the historical pollution that landed before the
-- pre-persist filter shipped.
--
-- Denylist must match src/lib/document-denylist.ts exactly:
--   exact mime: text/calendar, application/ics, multipart/signed,
--               application/x-microsoft-rpmsg-message,
--               application/pkcs7-signature, application/x-pkcs7-signature
--   prefix mime: image/*, video/*, audio/*
--   exact filename: 'unavailable'
--
-- Leaves r2_key alone — orphan binaries cleaned in a future R2 GC sweep.
-- Leaves error_message populated so the row's history is recoverable.
-- Does NOT touch already-deleted (deleted_at IS NOT NULL) or already-excluded rows.

UPDATE documents
   SET processing_status = 'excluded',
       error_message = COALESCE(error_message, '[backfill] denylisted mime/filename'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND processing_status != 'excluded'
   AND (
        mime_type IN (
          'text/calendar',
          'application/ics',
          'multipart/signed',
          'application/x-microsoft-rpmsg-message',
          'application/pkcs7-signature',
          'application/x-pkcs7-signature'
        )
     OR mime_type LIKE 'image/%'
     OR mime_type LIKE 'video/%'
     OR mime_type LIKE 'audio/%'
     OR file_name = 'unavailable'
   );

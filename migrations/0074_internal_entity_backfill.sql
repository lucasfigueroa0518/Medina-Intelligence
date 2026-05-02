-- Wave 1 — initial backfill: mark known internal entities.
--
-- Two-pass:
--   (1) any company whose normalized domain matches a user's email domain
--       (the org-internal authoritative signal — only humans on the org's
--       payroll get user accounts at the org's domain).
--   (2) catch-all by company name token, for legacy entities created before
--       domain resolution was reliable.
--
-- The same logic runs in src/lib/internal-entity.ts at company-create time
-- (forward-looking). This file is the initial sweep over already-resident
-- companies.

-- Pass 1: domain matches a user email domain.
UPDATE companies
   SET is_internal_entity = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND is_internal_entity = 0
   AND lower(domain) IN (
     SELECT DISTINCT lower(substr(email, instr(email, '@') + 1))
       FROM users
      WHERE org_id = companies.org_id
        AND deleted_at IS NULL
   );

-- Pass 2: catch-all by name (fund-family entities that don't share the
-- org's domain — Medina Capital, Gryphon Capital Management, JFG Family
-- Office). Token-bounded so we don't false-positive a portfolio company
-- with "ventures" or "capital" in its name (those are caught only when
-- combined with the Medina/Gryphon/JFG family signal).
UPDATE companies
   SET is_internal_entity = 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE deleted_at IS NULL
   AND is_internal_entity = 0
   AND (
     lower(name) LIKE 'medina ventures%'
     OR lower(name) LIKE 'medina capital%'
     OR lower(name) LIKE 'medina partners%'
     OR lower(name) LIKE 'medina fund%'
     OR lower(name) LIKE 'gryphon capital%'
     OR lower(name) LIKE 'jfg family%'
     OR lower(domain) IN ('medinacapital.com','gryphcap.com','jfgfamilyoffice.com')
   );

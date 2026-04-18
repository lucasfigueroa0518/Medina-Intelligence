-- One-time cleanup for spam-discovered contacts and duplicate merge.
-- NOT a regular migration — run manually via `wrangler d1 execute`.
-- Order matters:
--   1) soft-delete spam contacts
--   2) merge duplicates (keep row with most interactions)
--   3) apply migration 0031_contacts_unique_email.sql to enforce the invariant

-- ------------------------------------------------------------------
-- STEP 1: Soft-delete spam contacts
-- ------------------------------------------------------------------

UPDATE contacts
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL
  AND email IS NOT NULL
  AND (
    -- Blocked domains (exact or subdomain)
    LOWER(email) LIKE '%@slack.com'        OR LOWER(email) LIKE '%.slack.com'
 OR LOWER(email) LIKE '%@anthropic.com'    OR LOWER(email) LIKE '%.anthropic.com'
 OR LOWER(email) LIKE '%@godaddy.com'      OR LOWER(email) LIKE '%.godaddy.com'
 OR LOWER(email) LIKE '%@fireflies.ai'     OR LOWER(email) LIKE '%.fireflies.ai'
 OR LOWER(email) LIKE '%@google.com'       OR LOWER(email) LIKE '%.google.com'
 OR LOWER(email) LIKE '%@microsoft.com'    OR LOWER(email) LIKE '%.microsoft.com'
 OR LOWER(email) LIKE '%@github.com'       OR LOWER(email) LIKE '%.github.com'
 OR LOWER(email) LIKE '%@stripe.com'       OR LOWER(email) LIKE '%.stripe.com'
 OR LOWER(email) LIKE '%@notion.so'        OR LOWER(email) LIKE '%.notion.so'
 OR LOWER(email) LIKE '%@linear.app'       OR LOWER(email) LIKE '%.linear.app'
 OR LOWER(email) LIKE '%@figma.com'        OR LOWER(email) LIKE '%.figma.com'
 OR LOWER(email) LIKE '%@vercel.com'       OR LOWER(email) LIKE '%.vercel.com'
 OR LOWER(email) LIKE '%@cloudflare.com'   OR LOWER(email) LIKE '%.cloudflare.com'
 OR LOWER(email) LIKE '%@amazonaws.com'    OR LOWER(email) LIKE '%.amazonaws.com'
    -- Automated local-part keywords
 OR LOWER(email) LIKE 'noreply%@%'
 OR LOWER(email) LIKE 'no-reply%@%'
 OR LOWER(email) LIKE '%notification%@%'
 OR LOWER(email) LIKE '%alert%@%'
 OR LOWER(email) LIKE '%digest%@%'
 OR LOWER(email) LIKE '%newsletter%@%'
 OR LOWER(email) LIKE '%unsubscribe%@%'
 OR LOWER(email) LIKE '%automated%@%'
 OR LOWER(email) LIKE '%mailer%@%'
 OR LOWER(email) LIKE 'mailer-daemon@%'
 OR LOWER(email) LIKE 'postmaster@%'
 OR LOWER(email) LIKE '%system%@%'
 OR LOWER(email) LIKE '%updates%@%'
 OR LOWER(email) LIKE '%billing%@%'
 OR LOWER(email) LIKE '%receipt%@%'
 OR LOWER(email) LIKE '%invoice%@%'
 OR LOWER(email) LIKE '%support%@%'
 OR LOWER(email) LIKE '%help%@%'
 OR LOWER(email) LIKE 'info@%'
 OR LOWER(email) LIKE 'team@%'
 OR LOWER(email) LIKE 'hello@%'
  );

-- ------------------------------------------------------------------
-- STEP 2: Merge remaining duplicates by (org_id, LOWER(email))
-- Keep the row with the highest total_interactions; tiebreak: oldest created_at.
-- Losers are soft-deleted and point merged_into at the winner.
-- ------------------------------------------------------------------

WITH ranked AS (
  SELECT
    id,
    org_id,
    LOWER(email) AS norm_email,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, LOWER(email)
      ORDER BY COALESCE(total_interactions, 0) DESC, created_at ASC, id ASC
    ) AS rn
  FROM contacts
  WHERE deleted_at IS NULL AND email IS NOT NULL
),
winners AS (
  SELECT org_id, norm_email, id AS winner_id
  FROM ranked WHERE rn = 1
)
UPDATE contacts
SET merged_into = (
      SELECT winner_id FROM winners
      WHERE winners.org_id = contacts.org_id
        AND winners.norm_email = LOWER(contacts.email)
    ),
    deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL
  AND email IS NOT NULL
  AND id IN (
    SELECT id FROM ranked WHERE rn > 1
  );

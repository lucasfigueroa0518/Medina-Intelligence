-- Migration 0034: Add domain column to companies for email-based contact matching
ALTER TABLE companies ADD COLUMN domain TEXT;
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);

-- Populate domain from existing website URLs
UPDATE companies SET domain = LOWER(
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(website, 'https://', ''),
        'http://', ''
      ),
      'www.', ''
    ),
    '/', ''
  )
) WHERE website IS NOT NULL AND website != '' AND domain IS NULL;

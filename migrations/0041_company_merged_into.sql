-- Mirror the contacts.merged_into convention: track when a placeholder
-- company (created from an email domain) is merged into another company
-- whose canonical name matches.
ALTER TABLE companies ADD COLUMN merged_into TEXT;
CREATE INDEX IF NOT EXISTS idx_companies_merged_into ON companies(merged_into);

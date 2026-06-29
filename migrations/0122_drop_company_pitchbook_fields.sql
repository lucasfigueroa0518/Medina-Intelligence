-- Company PitchBook fields are dead schema: no current ingestion or enrichment
-- path writes them, and company rows should not carry stale external IDs.
DROP INDEX IF EXISTS idx_companies_pitchbook_id;
ALTER TABLE companies DROP COLUMN pitchbook_id;
ALTER TABLE companies DROP COLUMN pitchbook_data_r2_key;

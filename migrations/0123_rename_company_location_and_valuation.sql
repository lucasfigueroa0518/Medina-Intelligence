-- Rename company fields to match their actual semantics and add
-- field-level timestamps for valuation observations.

ALTER TABLE companies RENAME COLUMN hq_location TO location_mentioned;
ALTER TABLE companies RENAME COLUMN current_valuation TO last_known_valuation;

ALTER TABLE companies ADD COLUMN last_known_valuation_seen_at TEXT;
ALTER TABLE companies ADD COLUMN last_known_valuation_source_date TEXT;

-- Preserve existing field-state/provenance history under the new names.
DELETE FROM entity_field_state
 WHERE entity_type = 'company'
   AND field_name = 'location_mentioned'
   AND EXISTS (
     SELECT 1
       FROM entity_field_state old
      WHERE old.entity_type = 'company'
        AND old.entity_id = entity_field_state.entity_id
        AND old.field_name = 'hq_location'
   );

UPDATE entity_field_state
   SET field_name = 'location_mentioned',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE entity_type = 'company'
   AND field_name = 'hq_location';

DELETE FROM entity_field_state
 WHERE entity_type = 'company'
   AND field_name = 'last_known_valuation'
   AND EXISTS (
     SELECT 1
       FROM entity_field_state old
      WHERE old.entity_type = 'company'
        AND old.entity_id = entity_field_state.entity_id
        AND old.field_name = 'current_valuation'
   );

UPDATE entity_field_state
   SET field_name = 'last_known_valuation',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE entity_type = 'company'
   AND field_name = 'current_valuation';

DELETE FROM entity_field_provenance
 WHERE entity_type = 'company'
   AND field_name = 'location_mentioned'
   AND EXISTS (
     SELECT 1
       FROM entity_field_provenance old
      WHERE old.org_id = entity_field_provenance.org_id
        AND old.entity_type = 'company'
        AND old.entity_id = entity_field_provenance.entity_id
        AND old.field_name = 'hq_location'
   );

UPDATE entity_field_provenance
   SET field_name = 'location_mentioned'
 WHERE entity_type = 'company'
   AND field_name = 'hq_location';

DELETE FROM entity_field_provenance
 WHERE entity_type = 'company'
   AND field_name = 'last_known_valuation'
   AND EXISTS (
     SELECT 1
       FROM entity_field_provenance old
      WHERE old.org_id = entity_field_provenance.org_id
        AND old.entity_type = 'company'
        AND old.entity_id = entity_field_provenance.entity_id
        AND old.field_name = 'current_valuation'
   );

UPDATE entity_field_provenance
   SET field_name = 'last_known_valuation'
 WHERE entity_type = 'company'
   AND field_name = 'current_valuation';

UPDATE approval_queue
   SET field_name = 'location_mentioned'
 WHERE entity_type = 'company'
   AND field_name = 'hq_location';

UPDATE approval_queue
   SET field_name = 'last_known_valuation'
 WHERE entity_type = 'company'
   AND field_name = 'current_valuation';

UPDATE agent_writes
   SET field_name = 'location_mentioned'
 WHERE entity_type = 'company'
   AND field_name = 'hq_location';

UPDATE agent_writes
   SET field_name = 'last_known_valuation'
 WHERE entity_type = 'company'
   AND field_name = 'current_valuation';

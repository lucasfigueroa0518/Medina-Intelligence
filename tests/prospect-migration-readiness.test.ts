import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runProspectMigrationReadinessCheck } from '../scripts/prospect-migration-readiness-check';

describe('prospect migration readiness proof', () => {
  it('guards the 0114 entity_field_state rebuild against stale temp tables', () => {
    const sql = readFileSync('migrations/0114_prospect_intelligence.sql', 'utf8');
    const dropIndex = sql.indexOf('DROP TABLE IF EXISTS entity_field_state_new');
    const createIndex = sql.indexOf('CREATE TABLE IF NOT EXISTS entity_field_state_new');

    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dropIndex);
  });

  it('proves repeat-apply, stale temp-table recovery, indexes, and uniqueness in temp SQLite', () => {
    const result = runProspectMigrationReadinessCheck();

    expect(result.passed).toBe(true);
    expect(result.checks.filter(check => check.status === 'fail')).toEqual([]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'empty.sectors_seeded', status: 'pass' }),
      expect.objectContaining({ name: 'empty.prospect_signals_company_id_exists', status: 'pass' }),
      expect.objectContaining({ name: 'seeded.prospect_rows_survive_repeat_apply', status: 'pass' }),
      expect.objectContaining({ name: 'seeded.signal_company_id_column_survives_repeat_apply', status: 'pass' }),
      expect.objectContaining({ name: 'stale_temp.no_entity_field_state_new_leftover', status: 'pass' }),
      expect.objectContaining({ name: 'indexes.expected_indexes_present', status: 'pass' }),
      expect.objectContaining({ name: 'query_plan.idx_prospects_org_normalized_active', status: 'pass' }),
      expect.objectContaining({ name: 'query_plan.idx_prospect_signals_company', status: 'pass' }),
      expect.objectContaining({ name: 'query_plan.idx_pbj_org_status', status: 'pass' }),
      expect.objectContaining({ name: 'constraints.duplicate_live_deal_backlink_rejected', status: 'pass' }),
      expect.objectContaining({ name: 'constraints.soft_deleted_duplicate_deal_backlink_allowed', status: 'pass' }),
    ]));
  });
});

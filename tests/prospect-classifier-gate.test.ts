import { describe, expect, it } from 'vitest';
import { evaluateProspectClassifierGate } from '../scripts/prospect-classifier-gate';

const passingSummary = {
  exact_create_precision: 0.989010989010989,
  exact_attach_precision: 0.9967532467532467,
  valuable_precision: 1,
  valuable_recall: 0.9755501222493888,
  wrong_entity_corrected_or_suppressed: 6,
};

const passingManifest = {
  rows_written: 0,
  changed_db: false,
  remote_d1_meta: {
    rows_read: 8982,
    rows_written: 0,
    changed_db: false,
  },
};

describe('prospect classifier replay gate', () => {
  it('passes the frozen final benchmark shape', () => {
    const result = evaluateProspectClassifierGate({
      summary: passingSummary,
      manifest: passingManifest,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.map(check => check.name)).toEqual([
      'exact_create_precision',
      'exact_attach_precision',
      'valuable_precision',
      'valuable_recall',
      'wrong_entity_corrected_or_suppressed',
      'rows_written',
      'changed_db',
    ]);
  });

  it('fails loudly on metric regression or replay writes', () => {
    const result = evaluateProspectClassifierGate({
      summary: {
        ...passingSummary,
        exact_create_precision: 0.97,
      },
      manifest: {
        rows_written: 1,
        changed_db: true,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.filter(check => !check.passed).map(check => check.name)).toEqual([
      'exact_create_precision',
      'rows_written',
      'changed_db',
    ]);
  });
});

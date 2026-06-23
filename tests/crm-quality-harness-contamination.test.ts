import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('CRM quality harness evidence policy', () => {
  it('keeps approved labels and prior-run artifacts out of the runtime replay script', () => {
    const source = readFileSync(join(repoRoot, 'scripts/crm-quality-local-d1-replay.ts'), 'utf8');

    expect(source).not.toContain('crm-quality-approved-gold-contract.csv');
    expect(source).not.toContain('crm-quality-approved-baseline-outcomes.csv');
    expect(source).not.toContain('crm-quality-approved-run-review-clean.csv');
    expect(source).not.toContain('junk-investigate-company-website-metadata.csv');
    expect(source).not.toContain('stage1-cleanup-report-approved-baseline.csv');
    expect(source).not.toContain('review_notes');
    expect(source).not.toContain('approved_expected_name_or_names');
  });

  it('marks runtime replay decisions as gold-blind by construction', () => {
    const source = readFileSync(join(repoRoot, 'scripts/crm-quality-local-d1-replay.ts'), 'utf8');

    expect(source).toContain('gold_used_at_runtime: false');
    expect(source).toContain('production_like_runtime_only; approved_baseline_scoring_only');
  });
});

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CRM_QUALITY_RULES } from '../src/lib/crm-quality-gate';
import { buildCrmQualityCanarySummary } from '../scripts/crm-quality-canary';

// The reviewed canary contract lives in gitignored outputs/ (real reviewed CRM
// rows — intentionally never committed). On checkouts without the artifacts
// (CI, fresh clones) this replay suite skips instead of failing; it runs in
// full wherever the contract directory exists.
const CONTRACT_DIR = join(process.cwd(), 'outputs', 'crm-stage1-investigation-20260619');

const tempDirs: string[] = [];

function tempOutputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crm-quality-canary-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(!existsSync(CONTRACT_DIR))('CRM quality canary harness', () => {
  it('evaluates the reviewed 200-entity canary without writing rows', () => {
    const summary = buildCrmQualityCanarySummary({
      contractDir: CONTRACT_DIR,
      outputDir: tempOutputDir(),
      minPassRate: 1,
      allowFailures: false,
    });

    expect(summary).toMatchObject({
      dry_run: true,
      canary_rows: 200,
      rows_written: 0,
      changed_db: false,
      passed: 200,
      failed: 0,
      pass_rate: 1,
    });
    expect(summary.rule_coverage[CRM_QUALITY_RULES.WRITE_GATE]).toBe(200);
    expect(summary.rule_coverage[CRM_QUALITY_RULES.EVIDENCE_LEDGER]).toBe(200);
    expect(summary.rule_coverage[CRM_QUALITY_RULES.COMPANY_PAGE_TITLE]).toBe(23);
    expect(summary.rule_coverage[CRM_QUALITY_RULES.COMPANY_DOMAIN_PLACEHOLDER]).toBe(20);
    expect(summary.rule_coverage[CRM_QUALITY_RULES.CONTACT_EMAIL_LOCAL_PART]).toBe(55);
    expect(summary.rule_coverage[CRM_QUALITY_RULES.DEDUP]).toBe(26);
  });
});

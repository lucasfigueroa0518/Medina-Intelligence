import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCrmQualitySourceReplaySummary } from '../scripts/crm-quality-source-replay';

// Same contract dependency as crm-quality-canary.test.ts: the reviewed canary
// artifacts live in gitignored outputs/ and are never committed. Skip (not
// fail) on checkouts without them — CI and fresh clones.
const CONTRACT_DIR = join(process.cwd(), 'outputs', 'crm-stage1-investigation-20260619');

const tempDirs: string[] = [];

function tempOutputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crm-quality-source-replay-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(!existsSync(CONTRACT_DIR))('CRM quality source-shaped replay', () => {
  it('replays reviewed canary rows through source-shaped paths without unsafe writes', async () => {
    const summary = await buildCrmQualitySourceReplaySummary({
      contractDir: CONTRACT_DIR,
      outputDir: tempOutputDir(),
      allowFailures: false,
    });

    expect(summary).toMatchObject({
      dry_run: true,
      validation_layer: 'source_shaped_replay',
      canary_rows: 200,
      production_rows_written: 0,
      safety_passed: 200,
      safety_failed: 0,
    });
    expect(summary.after_state_recovered).toBeGreaterThanOrEqual(100);
    expect(summary.source_trace_gaps).toBe(200 - summary.after_state_recovered);
    expect(summary.validation_strength_counts.raw_evidence_codepath).toBe(200);
    expect(summary.replay_path_counts.find_or_create_company_by_domain).toBe(26);
    expect(summary.replay_path_counts.firefly_auto_create_contact_from_attendee).toBe(17);
  });
});

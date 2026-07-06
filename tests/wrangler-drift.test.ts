import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line import/no-relative-packages
import { runChecks, CONFIG_FILES } from '../scripts/check-wrangler-drift.mjs';

const ROOT = process.cwd();
const tempDirs: string[] = [];

function repoCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wrangler-drift-'));
  tempDirs.push(dir);
  for (const file of CONFIG_FILES) cpSync(join(ROOT, file), join(dir, file));
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('wrangler config drift check', () => {
  it('passes on the committed configs', () => {
    const { failures } = runChecks(ROOT);
    expect(failures).toEqual([]);
  });

  it('catches a drifted parity var', () => {
    const dir = repoCopy();
    const file = join(dir, 'wrangler.pipelines.toml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('GEMINI_MAX_RPM = "500"', 'GEMINI_MAX_RPM = "900"'));
    const { failures } = runChecks(dir);
    expect(failures.some(f => f.includes('GEMINI_MAX_RPM') && f.includes('drifted'))).toBe(true);
  });

  it('catches an unclassified new var', () => {
    const dir = repoCopy();
    const file = join(dir, 'wrangler.toml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('[vars]', '[vars]\nBRAND_NEW_FLAG = "1"'));
    const { failures } = runChecks(dir);
    expect(failures.some(f => f.includes('BRAND_NEW_FLAG') && f.includes('unclassified'))).toBe(true);
  });

  it('catches cron trigger changes on any config', () => {
    const dir = repoCopy();
    const file = join(dir, 'wrangler.pipelines.toml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"* * * * *",', '"* * * * *",\n  "15 3 * * *",'));
    const { failures } = runChecks(dir);
    expect(failures.some(f => f.includes('cron triggers') && f.includes('wrangler.pipelines.toml'))).toBe(true);
  });

  it('catches a diverged D1 database_id', () => {
    const dir = repoCopy();
    const file = join(dir, 'wrangler.readonly.toml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'database_id = "4bb3705c-c471-43f7-b42f-b44ab62f5dab"',
        'database_id = "00000000-0000-0000-0000-000000000000"'
      )
    );
    const { failures } = runChecks(dir);
    expect(failures.some(f => f.includes('d1_database_id differs'))).toBe(true);
  });

  it('catches readonly gaining write-capable bindings', () => {
    const dir = repoCopy();
    const file = join(dir, 'wrangler.readonly.toml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8') + '\n[[r2_buckets]]\nbinding = "R2"\nbucket_name = "medina-ventures-storage"\n'
    );
    const { failures } = runChecks(dir);
    expect(failures.some(f => f.includes('wrangler.readonly.toml') && f.includes('unexpected r2 binding'))).toBe(true);
  });
});

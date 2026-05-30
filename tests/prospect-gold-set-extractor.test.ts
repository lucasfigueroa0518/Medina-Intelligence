import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('prospect gold-set candidate extractor contract', () => {
  it('extracts blind labeling candidates without classifier labels or committed raw output', () => {
    const script = readFileSync('scripts/extract-prospect-gold-set-candidates.ts', 'utf8');
    const gitignore = readFileSync('.gitignore', 'utf8');

    expect(script).toContain('sourcePrefilter');
    expect(script).toContain('parseDealflowList');
    expect(script).toContain("gold_mention_type: ''");
    expect(script).toContain("gold_direction: ''");
    expect(script).toContain("gold_sector_key: ''");
    expect(script).toContain('gold-candidates.dev.jsonl');
    expect(script).toContain('gold-candidates.test.jsonl');
    expect(script).toContain('CLASS_FLOORS');
    expect(script).not.toContain('callProspectClassifier');
    expect(script).not.toContain('callClaude');
    expect(gitignore).toContain('.prospect-gold-set/');
  });
});

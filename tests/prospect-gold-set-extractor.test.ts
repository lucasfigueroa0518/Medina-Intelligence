import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('prospect gold-set candidate extractor contract', () => {
  it('extracts blind labeling candidates without classifier labels or committed raw output', () => {
    const script = readFileSync('scripts/extract-prospect-gold-set-candidates.ts', 'utf8');
    const gitignore = readFileSync('.gitignore', 'utf8');

    expect(script).toContain('sourcePrefilter');
    expect(script).toContain('extractOrganizationMentionsFromSource');
    expect(script).toContain('mention.contextText');
    expect(script).toContain('source_subject');
    expect(script).toContain('source_sender');
    expect(script).toContain('context_char_count');
    expect(script).toContain("gold_mention_type: ''");
    expect(script).toContain("gold_direction: ''");
    expect(script).toContain("gold_sector_key: ''");
    expect(script).toContain('gold-candidates.dev.jsonl');
    expect(script).toContain('gold-candidates.test.jsonl');
    expect(script).toContain('gold-candidates.human-labeling.csv');
    expect(script).toContain('surrounding_context');
    expect(script).toContain('CLASS_FLOORS');
    expect(script).not.toContain('callProspectClassifier');
    expect(gitignore).toContain('.prospect-gold-set/');
  });
});

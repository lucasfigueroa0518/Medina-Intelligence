import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/types/env';
import {
  budgetUpstreamForClaudeModel,
  CLAUDE_HAIKU_MODEL,
  CLAUDE_OPUS_MODEL,
  CLAUDE_SONNET_MODEL,
  resolveDefaultClaudeModel,
  resolveMartyMaxModel,
  resolveMartyNormalModel,
  resolveQualityExceptionClaudeModel,
} from '../src/lib/model-policy';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (path.includes('/src/lib/pdfjs-vendor/')) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (path.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('Claude model policy', () => {
  it('uses Haiku by default and preserves MARTY/quality exceptions', () => {
    const env = {} as Env;

    expect(resolveDefaultClaudeModel()).toBe(CLAUDE_HAIKU_MODEL);
    expect(resolveMartyNormalModel(env)).toBe(CLAUDE_SONNET_MODEL);
    expect(resolveMartyMaxModel(env)).toBe(CLAUDE_OPUS_MODEL);
    expect(resolveQualityExceptionClaudeModel(env, 'document_extraction')).toBe(CLAUDE_SONNET_MODEL);
    expect(resolveQualityExceptionClaudeModel(env, 'artifact_planning')).toBe(CLAUDE_SONNET_MODEL);
    expect(resolveQualityExceptionClaudeModel(env, 'transcript_extraction')).toBe(CLAUDE_SONNET_MODEL);
  });

  it('routes Anthropic budget buckets by resolved model tier', () => {
    expect(budgetUpstreamForClaudeModel(CLAUDE_HAIKU_MODEL)).toBe('anthropic_haiku');
    expect(budgetUpstreamForClaudeModel(CLAUDE_SONNET_MODEL)).toBe('anthropic_sonnet');
    expect(budgetUpstreamForClaudeModel(CLAUDE_OPUS_MODEL)).toBe('anthropic_opus');
    expect(budgetUpstreamForClaudeModel('claude-custom-preview')).toBe('claude');
  });

  it('keeps Sonnet/Opus literals centralized', () => {
    const allowed = new Set([
      'src/lib/model-policy.ts',
      'src/lib/marty-lab.ts',
    ]);

    const offenders = sourceFiles(join(repoRoot, 'src'))
      .map(path => ({
        path,
        rel: relative(repoRoot, path),
        text: readFileSync(path, 'utf8'),
      }))
      .filter(file => !allowed.has(file.rel))
      .filter(file => /claude-(sonnet|opus)-/i.test(file.text))
      .map(file => file.rel);

    expect(offenders).toEqual([]);
  });

  it('keeps Gemini calls inside enrichment-only modules', () => {
    const allowed = new Set([
      'src/lib/enrichment.ts',
      'src/lib/linkedin-discovery.ts',
    ]);

    const offenders = sourceFiles(join(repoRoot, 'src'))
      .map(path => ({
        path,
        rel: relative(repoRoot, path),
        text: readFileSync(path, 'utf8'),
      }))
      .filter(file => file.rel !== 'src/lib/gemini.ts')
      .filter(file => !allowed.has(file.rel))
      .filter(file => /\bcallGemini\s*\(/.test(file.text))
      .map(file => file.rel);

    expect(offenders).toEqual([]);
  });
});

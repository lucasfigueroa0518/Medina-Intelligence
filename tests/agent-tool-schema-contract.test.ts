import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MARTy prospect tool schema contracts', () => {
  it('describes prospect defaults consistently with high-integrity query behavior', () => {
    const source = readFileSync('src/handlers/agent.ts', 'utf8');

    expect(source).toContain('Include provisional and direction-uncertain prospects. Default false; the default view is high-integrity active/converted deal flow.');
    expect(source).toContain('Include weak record_context-style signal counts as a separate context_signals section. Default false; context signals never mix into the main prospect count.');
    expect(source).toContain('Default view is reliable active/converted prospects only; provisional, direction-uncertain, or weak context-only records require explicit filters.');
    expect(source).toContain('Status filter. Defaults to high-integrity active and converted prospects. Pass provisional explicitly to inspect lower-confidence records.');
    expect(source).not.toContain('Include provisional prospects. Default true.');
    expect(source).not.toContain('Status filter. Defaults to active and provisional.');
  });
});

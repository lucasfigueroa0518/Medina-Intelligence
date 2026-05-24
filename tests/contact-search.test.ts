import { describe, expect, it } from 'vitest';
import { __contactSearchTestHooks } from '../src/lib/contact-search';

const {
  normalizeContactSearchText,
  extractContactSearchTerms,
  buildContactSearchQuery,
} = __contactSearchTestHooks;

describe('contact search query normalization', () => {
  it('normalizes case, punctuation, whitespace, and accents', () => {
    expect(normalizeContactSearchText('  Álvaro   González-Rico!!  ')).toBe('alvaro gonzalez-rico');
    expect(extractContactSearchTerms('  Álvaro   González-Rico!!  ')).toEqual(['alvaro', 'gonzalez', 'rico']);
  });

  it('builds all-token prefix FTS queries for non-contiguous names', () => {
    const query = buildContactSearchQuery('alvaro rico');
    expect(query?.terms).toEqual(['alvaro', 'rico']);
    expect(query?.ftsMatch).toBe('alvaro* AND rico*');
  });

  it('builds out-of-order name searches that can match every token', () => {
    const query = buildContactSearchQuery('henriquez raul');
    expect(query?.terms).toEqual(['henriquez', 'raul']);
    expect(query?.ftsMatch).toBe('henriquez* AND raul*');
  });

  it('splits email fragments into searchable local/domain tokens', () => {
    const query = buildContactSearchQuery('alvaro.gonzalez.rico@hotmail.com');
    expect(query?.terms).toEqual(['alvaro', 'gonzalez', 'rico', 'hotmail', 'com']);
    expect(query?.ftsMatch).toBe('alvaro* AND gonzalez* AND rico* AND hotmail* AND com*');
  });

  it('ignores one-character queries so the UI can fall back to normal listing', () => {
    expect(buildContactSearchQuery('a')).toBeNull();
    expect(buildContactSearchQuery('  ! ')).toBeNull();
  });
});

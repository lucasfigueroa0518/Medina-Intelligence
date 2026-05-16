import { describe, expect, it } from 'vitest';
import { normalizeCitationMarkers, parseNumericCitationIdentifier } from '../src/lib/citation-format';
import { parseCitationIdentifier, parseMessageWithCitations, trimPartialCitation } from '../frontend/lib/citations';

describe('MARTy citation grammar', () => {
  it('canonicalizes source-type labels inside numeric markers', () => {
    expect(parseCitationIdentifier('16 Slack')).toEqual({ kind: 'number', value: 16 });
    expect(parseCitationIdentifier('9 email')).toEqual({ kind: 'number', value: 9 });
    expect(parseCitationIdentifier('3: meeting')).toEqual({ kind: 'number', value: 3 });
    expect(parseNumericCitationIdentifier('16 Slack')).toEqual({ id: 16, hadLabel: true });
  });

  it('does not parse UUID-like citation fragments as numeric citations', () => {
    expect(parseCitationIdentifier('50af6179')).toEqual({ kind: 'hash', value: '50af6179' });
    expect(parseNumericCitationIdentifier('50af6179')).toBeNull();
  });

  it('tokenizes labeled markers for non-markdown render paths', () => {
    expect(parseMessageWithCitations('IC happened[^16 Slack] and counsel replied[^9 email].')).toEqual([
      { type: 'text', content: 'IC happened' },
      { type: 'citation', sourceId: 16 },
      { type: 'text', content: ' and counsel replied' },
      { type: 'citation', sourceId: 9 },
      { type: 'text', content: '.' },
    ]);
  });

  it('normalizes persisted output and strips invalid markers', () => {
    const normalized = normalizeCitationMarkers(
      'Valid label[^16 Slack], valid plain[^4], invalid number[^99 email], invalid raw[^abc-123], code `[^7 Slack]`.',
      new Set([4, 16])
    );

    expect(normalized.text).toBe('Valid label[^16], valid plain[^4], invalid number, invalid raw, code `[^7 Slack]`.');
    expect(normalized.stats).toEqual({
      valid_citations_used: 2,
      invalid_citations_stripped: 2,
      labeled_citations_canonicalized: 1,
    });
  });

  it('trims partial labeled markers during streaming', () => {
    expect(trimPartialCitation('pending Jake response[^9 sla')).toBe('pending Jake response');
  });
});

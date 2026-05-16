export interface CitationNormalizationStats {
  valid_citations_used: number;
  invalid_citations_stripped: number;
  labeled_citations_canonicalized: number;
}

export interface CitationNormalizationResult {
  text: string;
  stats: CitationNormalizationStats;
}

export function parseNumericCitationIdentifier(raw: unknown): { id: number; hadLabel: boolean } | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  const exact = text.match(/^(\d{1,3})$/);
  if (exact) {
    const id = Number(exact[1]);
    return id > 0 && id < 1000 ? { id, hadLabel: false } : null;
  }

  const labeled = text.match(/^(\d{1,3})(?:[\s:;,\-/]+[A-Za-z][^\]\r\n]*)$/);
  if (!labeled) return null;
  const id = Number(labeled[1]);
  return id > 0 && id < 1000 ? { id, hadLabel: true } : null;
}

export function normalizeCitationMarkers(
  text: string,
  validSourceIds?: Set<number>
): CitationNormalizationResult {
  const stats: CitationNormalizationStats = {
    valid_citations_used: 0,
    invalid_citations_stripped: 0,
    labeled_citations_canonicalized: 0,
  };

  if (!text) return { text, stats };

  const normalizeProse = (part: string) =>
    part.replace(/\[\^([^\]\r\n]+)\]/g, (match, rawIdentifier) => {
      const parsed = parseNumericCitationIdentifier(rawIdentifier);
      if (!parsed) {
        stats.invalid_citations_stripped++;
        return '';
      }

      if (validSourceIds && !validSourceIds.has(parsed.id)) {
        stats.invalid_citations_stripped++;
        return '';
      }

      stats.valid_citations_used++;
      if (parsed.hadLabel || match !== `[^${parsed.id}]`) {
        stats.labeled_citations_canonicalized++;
      }
      return `[^${parsed.id}]`;
    });

  return {
    text: text
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map(part => part.startsWith('`') ? part : normalizeProse(part))
      .join(''),
    stats,
  };
}

// Compute a human-recognizable single-letter fallback initial.
//
// Rules:
//   - "1200.vc" → "V" (longest alpha-bearing token is "vc")
//   - "13th Floor Capital" → "C" (longest token is "Capital")
//   - "1789 Capital" → "C"
//   - "" or numeric-only → "?"
export function initialFromName(name: string | null | undefined): string {
  if (!name) return '?';
  // Split on anything that isn't a unicode letter or number, then keep only
  // tokens that contain at least one letter. Numeric-only words like "1789"
  // are skipped so "1789 Capital" → "C" instead of "1".
  const tokens = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => /\p{L}/u.test(t));
  if (tokens.length === 0) {
    const m = name.match(/\p{L}/u);
    return m ? m[0].toUpperCase() : '?';
  }
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  const m = longest.match(/\p{L}/u);
  return m ? m[0].toUpperCase() : '?';
}

// Optional Google favicon URL for a domain — used as a richer fallback when
// a company has no logo_url set.
export function faviconUrl(domain: string | null | undefined, size = 64): string | null {
  if (!domain) return null;
  const cleaned = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!cleaned) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(cleaned)}&sz=${size}`;
}

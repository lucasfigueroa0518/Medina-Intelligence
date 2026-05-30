export type NewsQualityStatus = 'usable' | 'quarantined' | 'duplicate' | 'archived';

export interface NewsQualityAssessment {
  status: NewsQualityStatus;
  reason: string | null;
  normalizedUrl: string | null;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function normalizeNewsSourceUrl(raw: string | null | undefined): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    const removable = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_id',
      'fbclid',
      'gclid',
      'mc_cid',
      'mc_eid',
    ];
    for (const key of removable) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = stripTrailingSlash(url.pathname);
    const search = [...url.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return `${url.protocol.toLowerCase()}//${url.hostname}${url.pathname}${search ? `?${search}` : ''}`;
  } catch {
    return value.toLowerCase();
  }
}

export function isFutureNewsDate(
  publishedAt: string | null | undefined,
  now: Date = new Date(),
  toleranceDays = 1
): boolean {
  if (!publishedAt) return false;
  const ms = Date.parse(publishedAt);
  if (!Number.isFinite(ms)) return false;
  return ms > now.getTime() + toleranceDays * 24 * 60 * 60 * 1000;
}

export function assessNewsQuality(input: {
  sourceUrl?: string | null;
  publishedAt?: string | null;
  now?: Date;
}): NewsQualityAssessment {
  const normalizedUrl = normalizeNewsSourceUrl(input.sourceUrl);
  if (!normalizedUrl) {
    return { status: 'quarantined', reason: 'missing_source_url', normalizedUrl: null };
  }
  if (isFutureNewsDate(input.publishedAt, input.now)) {
    return { status: 'quarantined', reason: 'future_published_at', normalizedUrl };
  }
  return { status: 'usable', reason: null, normalizedUrl };
}

export const __newsQualityTestHooks = {
  assessNewsQuality,
  isFutureNewsDate,
  normalizeNewsSourceUrl,
};

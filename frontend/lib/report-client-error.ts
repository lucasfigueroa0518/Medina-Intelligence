// Fire-and-forget beacon from the error boundaries to
// /api/client-error, so CLIENT render crashes become visible in Vercel
// function logs (SSR crashes already are, via the boundaries'
// console.error). keepalive lets the request survive a navigation away
// from the crashed view. Must never throw and never block recovery.

export function reportClientError(source: 'error-boundary' | 'global-error', error: Error & { digest?: string }) {
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        message: String(error?.message ?? '').slice(0, 500),
        digest: error?.digest ?? '',
        path: typeof window !== 'undefined' ? window.location.pathname : '',
      }),
    }).catch(() => {});
  } catch {
    // Reporting is best-effort by definition.
  }
}

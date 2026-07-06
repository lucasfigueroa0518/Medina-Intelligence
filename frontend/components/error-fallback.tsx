'use client';

// Shared recovery card for React error boundaries (app/error.tsx,
// app/global-error.tsx). Same visual language as the contacts-style
// data-error card (border-semantic-error/30 + bg-semantic-error/10 +
// btn-secondary retry) so boundary failures read like the rest of the
// app's error states, just bigger.
//
// Boundaries are the LAST-RESORT net for render crashes. Data-fetch
// failures should still be handled by each surface's own error card
// per the standards in CLAUDE.md — reaching this component means a
// component threw during render.

interface ErrorFallbackProps {
  error: Error & { digest?: string };
  onRetry: () => void;
  title?: string;
  description?: string;
}

export function ErrorFallback({ error, onRetry, title, description }: ErrorFallbackProps) {
  return (
    <div className="w-full max-w-lg border border-semantic-error/30 bg-semantic-error/10 rounded-xl p-6">
      <div className="font-accent text-[11px] uppercase tracking-widest text-text-muted mb-2">
        Medina Intelligence Platform
      </div>
      <div className="text-base font-semibold text-text-primary">
        {title ?? 'Something broke while rendering this view.'}
      </div>
      <div className="text-sm text-text-secondary mt-1">
        {description ?? 'The rest of the app is unaffected. Your data is safe — this view crashed before it could draw.'}
      </div>
      {error?.message ? (
        <div className="mt-3 rounded-lg bg-bg-inset border border-border px-3 py-2 font-mono text-xs text-text-muted break-words max-h-32 overflow-y-auto">
          {error.message}
          {error.digest ? <span className="block mt-1 text-text-muted/70">digest: {error.digest}</span> : null}
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <button className="btn-secondary text-sm" onClick={onRetry}>
          Try again
        </button>
        <button
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    </div>
  );
}

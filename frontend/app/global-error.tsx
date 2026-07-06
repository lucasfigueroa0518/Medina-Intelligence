'use client';

// Last-resort boundary: catches render crashes in the ROOT layout
// (AuthGuard/AppShell included), where app/error.tsx can't help. It
// replaces the entire document, so it must render its own <html>/<body>
// and imports globals.css itself — it cannot assume anything from the
// crashed layout survived.

import './globals.css';
import { useEffect } from 'react';
import { ErrorFallback } from '@/components/error-fallback';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error-boundary]', error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body className="bg-bg-root text-text-primary min-h-screen">
        <div className="min-h-screen flex items-center justify-center p-6">
          <ErrorFallback
            error={error}
            onRetry={reset}
            title="The app shell failed to render."
            description="A crash in the application frame took down this page. Try again, or reload — your data is safe."
          />
        </div>
      </body>
    </html>
  );
}

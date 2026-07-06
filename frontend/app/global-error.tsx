'use client';

// Last-resort boundary: catches render crashes in the ROOT layout
// (AuthGuard/AppShell included), where app/error.tsx can't help. It
// replaces the entire document, so it must render its own <html>/<body>
// and imports globals.css itself — it cannot assume anything from the
// crashed layout survived. The font instantiations mirror layout.tsx
// (same variable names) so the recovery screen keeps the brand
// typography instead of falling back to system fonts (audit round 1,
// N5). The duplicate loaders cost a few duplicated CSS rules in the
// bundle — the underlying woff2 files are shared — which is the right
// trade for a boundary that must be self-sufficient.

import './globals.css';
import { Exo_2, Geist, JetBrains_Mono } from 'next/font/google';
import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-client-error';
import { ErrorFallback } from '@/components/error-fallback';

const geistSans = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-geist-sans',
  display: 'swap',
});

const exo2 = Exo_2({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-exo-2',
  display: 'swap',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error-boundary]', error);
    reportClientError('global-error', error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${exo2.variable} ${jetBrainsMono.variable} bg-bg-root text-text-primary min-h-screen`}
      >
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

'use client';

// Route-segment error boundary for everything under the root layout.
// A render crash in any page lands here INSIDE AuthGuard/AppShell, so
// the sidebar and navigation stay alive and the user can move to a
// healthy view. Crashes in the root layout itself are caught by
// app/global-error.tsx instead.

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorFallback } from '@/components/error-fallback';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  useEffect(() => {
    // No external error-reporting sink exists yet; console is the sink
    // (surfaces in Vercel function logs for SSR crashes).
    console.error('[error-boundary]', error);
  }, [error]);

  // reset() alone only re-renders the client tree; refresh() re-fetches
  // server-component data so data-shaped crashes get a real second chance.
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  return (
    <div className="flex-1 min-h-[60vh] flex items-center justify-center p-6">
      <ErrorFallback error={error} onRetry={retry} />
    </div>
  );
}

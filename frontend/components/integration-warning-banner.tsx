'use client';

import React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

interface Warning {
  type: string;
  message: string;
  consecutive_failures?: number;
}

export function IntegrationWarningBanner() {
  const [warnings, setWarnings] = React.useState<Warning[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    api
      .getMe()
      .then((data: any) => {
        if (data.warnings?.length) setWarnings(data.warnings);
      })
      .catch(() => {});
  }, []);

  const visible = warnings.filter(w => !dismissed.has(w.type));
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map(w => (
        <div
          key={w.type}
          className="fixed top-4 left-4 right-4 md:left-[340px] md:right-6 z-[95] bg-bg-elevated/95 backdrop-blur-xl border border-border border-l-4 border-l-semantic-warning rounded-xl shadow-2xl px-4 py-3 flex items-center justify-between gap-4"
        >
          <div className="text-sm text-text-primary">
            {w.message}{' '}
            <Link
              href="/settings?tab=integrations#sync-integrations"
              className="text-accent-magenta underline underline-offset-2"
            >
              Fix sync
            </Link>
          </div>
          <button
            onClick={() => setDismissed(prev => new Set(prev).add(w.type))}
            className="text-text-muted hover:text-text-primary text-xs shrink-0"
          >
            Dismiss
          </button>
        </div>
      ))}
    </>
  );
}

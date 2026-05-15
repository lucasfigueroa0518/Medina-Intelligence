'use client';

import React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

interface Warning {
  type: string;
  message: string;
  consecutive_failures?: number;
  last_successful_sync?: string | null;
  missed_days?: number;
  suggest_backfill_days?: 30;
  backfill_prompt?: string;
}

const SEVERAL_MISSED_SYNC_DAYS = 3;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

function displayMessage(w: Warning): string {
  if (w.type === 'outlook_token_expired') {
    return 'Outlook needs a quick refresh to keep email and calendar updates flowing.';
  }
  return w.message;
}

export function IntegrationWarningBanner() {
  const [warnings, setWarnings] = React.useState<Warning[]>([]);
  const [outlookLastSync, setOutlookLastSync] = React.useState<string | null>(null);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    api
      .getMe()
      .then((data: any) => {
        const nextWarnings = data.warnings || [];
        if (nextWarnings.length) setWarnings(nextWarnings);
        if (nextWarnings.some((w: Warning) => w.type === 'outlook_token_expired')) {
          api
            .getIntegrationsStatus()
            .then(status => setOutlookLastSync(status.outlook.last_sync || null))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const visible = warnings.filter(w => !dismissed.has(w.type));
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map(w => {
        const missedDays = w.missed_days ?? daysSince(w.last_successful_sync || outlookLastSync);
        const shouldSuggestBackfill =
          w.suggest_backfill_days === 30 ||
          (missedDays !== null && missedDays >= SEVERAL_MISSED_SYNC_DAYS);
        const backfillPrompt = w.backfill_prompt || (
          shouldSuggestBackfill && missedDays !== null
            ? `It looks like about ${missedDays} day${missedDays === 1 ? '' : 's'} may need a catch-up import. Refresh Outlook first, then start a 30-day backfill.`
            : null
        );

        return (
          <div
            key={w.type}
            className="fixed top-4 left-4 right-4 md:left-[340px] md:right-6 z-[95] bg-bg-elevated/95 backdrop-blur-xl border border-border border-l-4 border-l-semantic-warning rounded-xl shadow-2xl px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 text-sm text-text-primary">
              <span>{displayMessage(w)}</span>
              {backfillPrompt && (
                <span className="block mt-1 text-xs text-text-secondary">
                  {backfillPrompt}
                </span>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <Link
                href="/settings?tab=integrations#outlook-integration-refresh"
                className="text-sm text-accent-magenta underline underline-offset-2"
              >
                Refresh Outlook
              </Link>
              {shouldSuggestBackfill && (
                <Link
                  href="/settings?tab=integrations#email-history-import"
                  className="text-sm text-accent-magenta underline underline-offset-2"
                >
                  Start 30-day backfill
                </Link>
              )}
              <button
                onClick={() => setDismissed(prev => new Set(prev).add(w.type))}
                className="text-text-muted hover:text-text-primary text-xs"
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

'use client';

import React from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuthSession } from '@/components/auth-guard';

interface Warning {
  type: string;
  message: string;
  consecutive_failures?: number;
  last_successful_sync?: string | null;
  missed_days?: number;
  suggest_backfill_days?: 30;
  backfill_prompt?: string;
  severity?: 'warning' | 'critical';
  source?: string;
  recovery_status?: string;
  human_action_required?: boolean;
  recovery_window_start?: string | null;
  recovery_window_end?: string | null;
}

const SEVERAL_MISSED_SYNC_DAYS = 3;

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

function displayMessage(w: Warning): string {
  if (w.type.startsWith('ingestion_incident:')) {
    return w.message;
  }
  return w.message;
}

function incidentDetail(w: Warning): string {
  if (!w.human_action_required) {
    return `Automatic repair is ${w.recovery_status === 'repair_queued' || w.recovery_status === 'repairing' ? 'queued' : 'active'} for the affected window.`;
  }
  if (w.source === 'outlook_email' || w.source === 'calendar') {
    return 'Admin configuration is required. Automatic repair will run after Graph access is healthy.';
  }
  if (w.source === 'slack') {
    return 'Slack configuration is required before automatic repair can continue.';
  }
  if (w.source === 'fireflies') {
    return 'Fireflies configuration is required before automatic repair can continue.';
  }
  return 'Admin review is required before automatic repair can continue.';
}

export function IntegrationWarningBanner() {
  const { warnings } = useAuthSession();
  const [outlookLastSync, setOutlookLastSync] = React.useState<string | null>(null);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!warnings.length) {
      setOutlookLastSync(null);
      return;
    }
    api
      .getIntegrationsStatus()
      .then(status => setOutlookLastSync(status.outlook.last_sync || null))
      .catch(() => {});
  }, [warnings.length]);

  const visible = (warnings as Warning[]).filter(w => w.severity === 'critical' || !dismissed.has(w.type));
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map(w => {
        const isIncident = w.type.startsWith('ingestion_incident:');
        const isOutlookHealth = w.type === 'outlook_app_only_health';
        const missedDays = w.missed_days ?? daysSince(w.last_successful_sync || outlookLastSync);
        const shouldSuggestBackfill =
          !isOutlookHealth && (
            w.suggest_backfill_days === 30 ||
            (missedDays !== null && missedDays >= SEVERAL_MISSED_SYNC_DAYS)
          );
	        const backfillPrompt = w.backfill_prompt || (
	          shouldSuggestBackfill && missedDays !== null
	            ? `It looks like about ${missedDays} day${missedDays === 1 ? '' : 's'} may need a catch-up import. Check System Status, then start a 30-day backfill.`
	            : null
	        );
	        const canDismiss = w.severity !== 'critical';

	        return (
	          <div
	            key={w.type}
	            className={`fixed top-4 left-4 right-4 md:left-[340px] md:right-6 z-[95] bg-bg-elevated/95 backdrop-blur-xl border border-border border-l-4 ${w.severity === 'critical' ? 'border-l-semantic-error' : 'border-l-semantic-warning'} rounded-xl shadow-2xl px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`}
	          >
	            <div className="min-w-0 text-sm text-text-primary">
	              <span>{displayMessage(w)}</span>
	              {isIncident && (
	                <span className="block mt-1 text-xs text-text-secondary">
	                  {incidentDetail(w)}
	                </span>
	              )}
	              {!isIncident && backfillPrompt && (
	                <span className="block mt-1 text-xs text-text-secondary">
	                  {backfillPrompt}
	                </span>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
	              <Link
	                href={isIncident || isOutlookHealth ? '/settings?tab=system' : '/settings?tab=integrations#outlook-integration-refresh'}
	                className="text-sm text-accent-magenta underline underline-offset-2"
	              >
	                {isIncident || isOutlookHealth ? 'Open System Status' : 'Open Integrations'}
	              </Link>
	              {isIncident && (
	                <Link
	                  href="/settings?tab=integrations#sync-integrations"
	                  className="text-sm text-accent-magenta underline underline-offset-2"
	                >
	                  Sync & Integrations
	                </Link>
	              )}
	              {!isIncident && shouldSuggestBackfill && (
	                <Link
	                  href="/settings?tab=integrations#email-history-import"
	                  className="text-sm text-accent-magenta underline underline-offset-2"
                >
                  Start 30-day backfill
                </Link>
              )}
	              {canDismiss && (
	                <button
	                  onClick={() => setDismissed(prev => new Set(prev).add(w.type))}
	                  className="text-text-muted hover:text-text-primary text-xs"
	                >
	                  Dismiss
	                </button>
	              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

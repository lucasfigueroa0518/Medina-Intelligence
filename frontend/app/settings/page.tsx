'use client';

import React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import {
  api,
  getAuthToken,
  type IntegrationRow,
  type IntegrationsStatusResponse,
} from '@/lib/api';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [banner, setBanner] = React.useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  const [status, setStatus] = React.useState<IntegrationsStatusResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadStatus = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getIntegrationsStatus();
      setStatus(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load integration status');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount
  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Handle return-from-OAuth query params
  React.useEffect(() => {
    const connected = searchParams.get('connected');
    const err = searchParams.get('error');
    const message = searchParams.get('message');

    if (connected === 'outlook') {
      setBanner({ tone: 'success', message: 'Outlook connected successfully.' });
      router.replace('/settings');
      // Re-fetch status after successful connect so the UI flips to "Connected"
      loadStatus();
    } else if (err) {
      setBanner({
        tone: 'error',
        message: message || `Outlook connection failed: ${err}`,
      });
      router.replace('/settings');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const connectOutlook = () => {
    if (!API_ORIGIN) {
      setBanner({
        tone: 'error',
        message: 'NEXT_PUBLIC_API_URL is not set. Restart the dev server.',
      });
      return;
    }
    const token = getAuthToken();
    if (!token) {
      setBanner({
        tone: 'error',
        message: 'No auth token in localStorage. Reload the page.',
      });
      return;
    }
    window.location.href = `${API_ORIGIN}/auth/outlook?token=${encodeURIComponent(
      token
    )}`;
  };

  return (
    <div className="flex-1 flex flex-col">
      <TopBar title="Settings" />
      <div className="p-8 space-y-6 max-w-4xl">
        {banner && (
          <div
            className={`card border-l-4 ${
              banner.tone === 'success'
                ? 'border-semantic-success'
                : 'border-semantic-error'
            }`}
          >
            <div className="text-sm text-text-primary">{banner.message}</div>
          </div>
        )}

        <div className="card">
          <div className="font-medium mb-4">Sync Behavior</div>
          <div className="space-y-3 text-sm">
            <Toggle label="Auto-approve sync" />
            <Toggle label="Re-ranker enabled" checked />
            <Toggle label="News feed enabled" checked />
            <Toggle label="LinkedIn enrichment enabled" checked />
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="font-medium">Integrations</div>
            <button
              onClick={loadStatus}
              className="btn-ghost text-xs"
              disabled={loading}
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {error ? (
            <div className="text-sm text-semantic-error py-6">{error}</div>
          ) : loading && !status ? (
            <div className="space-y-3">
              {[0, 1, 2, 3].map(i => (
                <div
                  key={i}
                  className="h-16 bg-bg-surface-hover rounded-lg animate-pulse"
                />
              ))}
            </div>
          ) : status ? (
            <div className="space-y-3">
              <IntegrationRowView
                name="Microsoft Outlook 365"
                description="Email, calendar, and contacts via Microsoft Graph. Also used for campaign sends."
                row={status.outlook}
                onPrimaryClick={connectOutlook}
                primaryLabel={
                  status.outlook.status === 'connected' ? 'Reconnect' : 'Connect'
                }
              />
              <IntegrationRowView
                name="Slack"
                description="Public + private channel messages via the bot token."
                row={status.slack}
                primaryLabel={null}
              />
              <IntegrationRowView
                name="ReverseContact (LinkedIn)"
                description="LinkedIn contact + company enrichment."
                row={status.reversecontact}
                primaryLabel={null}
              />
              <IntegrationRowView
                name="Firefly AI"
                description="Meeting transcription + action items via webhook."
                row={status.firefly}
                primaryLabel={null}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, checked = false }: { label: string; checked?: boolean }) {
  const [on, setOn] = React.useState(checked);
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-text-secondary">{label}</span>
      <button
        onClick={() => setOn(!on)}
        className={`w-10 h-6 rounded-full transition-colors ${
          on ? 'bg-brand-gradient' : 'bg-bg-surface-hover'
        }`}
      >
        <span
          className={`block w-4 h-4 rounded-full bg-white transform transition-transform ${
            on ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
    </label>
  );
}

function statusColor(s: IntegrationRow['status']): string {
  switch (s) {
    case 'connected':
    case 'configured':
    case 'webhook_ready':
      return 'text-semantic-success';
    case 'not_connected':
    case 'not_configured':
    default:
      return 'text-text-muted';
  }
}

function IntegrationRowView({
  name,
  description,
  row,
  primaryLabel,
  onPrimaryClick,
}: {
  name: string;
  description: string;
  row: IntegrationRow;
  primaryLabel: string | null;
  onPrimaryClick?: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="flex items-start justify-between py-4 border-b border-border/50 last:border-0 gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">{name}</div>
        <div className="text-xs text-text-secondary mt-0.5">{description}</div>
        <div className={`text-xs mt-2 ${statusColor(row.status)}`}>● {row.label}</div>
        {row.detail && (
          <div className="text-xs text-text-muted mt-1">{row.detail}</div>
        )}
        {row.last_sync && (
          <div className="text-xs text-text-muted mt-1">
            Last sync: {formatRelative(row.last_sync)}
          </div>
        )}
        {row.webhook_url && (
          <div className="mt-2 flex items-center gap-2">
            <code className="text-xs bg-bg-input px-2 py-1 rounded font-mono text-text-primary truncate max-w-md">
              {row.webhook_url}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(row.webhook_url!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="btn-ghost text-xs"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>

      {primaryLabel && (
        <div className="shrink-0 flex items-center gap-2">
          {row.status === 'connected' && (
            <span className="badge bg-semantic-success/10 text-semantic-success text-xs">
              Manage
            </span>
          )}
          <button
            onClick={onPrimaryClick}
            className={
              row.status === 'connected' ? 'btn-ghost text-xs' : 'btn-secondary text-xs py-1.5'
            }
          >
            {primaryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

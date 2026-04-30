'use client';

import React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, X as XIcon, ChevronDown, ChevronUp, Users, Briefcase, Target, Sparkles, Mail, Clock, Loader2, User as UserIcon, Camera, Shield, LogOut, Trash2, Calendar, Mic, Lock, Unlock } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import {
  api,
  getAuthToken,
  resolveAvatarUrl,
  type IntegrationRow,
  type IntegrationsStatusResponse,
  type UserProfile,
  type SystemStatusResponse,
  type SystemStatusActiveTask,
  type SystemStatusRunHistoryEntry,
  type CompletenessMetric,
} from '@/lib/api';
import { useBackgroundTasks } from '@/components/background-task-indicator';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;

type SettingsTab = 'profile' | 'security' | 'integrations' | 'approvals' | 'system';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'integrations', label: 'Sync & Integrations' },
  { id: 'approvals', label: 'Approval Queue' },
  { id: 'system', label: 'System Status' },
];

export default function SettingsPageWrapper() {
  return (
    <React.Suspense fallback={<div className="flex-1 flex items-center justify-center text-text-secondary">Loading settings...</div>}>
      <SettingsPageInner />
    </React.Suspense>
  );
}

function SettingsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const tabParam = searchParams.get('tab') as SettingsTab | null;
  const [activeTab, setActiveTab] = React.useState<SettingsTab>(
    tabParam && TABS.some(t => t.id === tabParam) ? tabParam : 'profile'
  );

  const [banner, setBanner] = React.useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  const [status, setStatus] = React.useState<IntegrationsStatusResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showFirstConnect, setShowFirstConnect] = React.useState(false);

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

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Handle return-from-OAuth query params
  React.useEffect(() => {
    const connected = searchParams.get('connected');
    const err = searchParams.get('error');
    const message = searchParams.get('message');

    if (connected === 'outlook') {
      setShowFirstConnect(true);
      setActiveTab('integrations');
      router.replace('/settings?tab=integrations');
      loadStatus();
    } else if (err) {
      setBanner({
        tone: 'error',
        message: message || `Outlook connection failed: ${err}`,
      });
      setActiveTab('integrations');
      router.replace('/settings?tab=integrations');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    router.replace(`/settings?tab=${tab}`, { scroll: false });
  };

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

      {/* Tab bar — solid bg-bg-root (matches body) so scrolling content
          doesn't bleed through. `bg-bg-primary` was a broken token (no
          such color in tailwind.config.ts) which rendered transparent. */}
      <div className="sticky top-0 z-20 bg-bg-root border-b border-white/5">
        <div className="max-w-4xl px-8 overflow-x-auto scrollbar-hide">
          <div className="flex gap-0 min-w-max">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => switchTab(tab.id)}
                className={`px-5 py-3 text-sm whitespace-nowrap transition-colors ${
                  activeTab === tab.id
                    ? 'text-text-primary border-b-2 border-accent-magenta'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-8 max-w-4xl">
        {banner && (
          <div
            className={`card border-l-4 mb-6 ${
              banner.tone === 'success'
                ? 'border-semantic-success'
                : 'border-semantic-error'
            }`}
          >
            <div className="text-sm text-text-primary">{banner.message}</div>
          </div>
        )}

        {activeTab === 'profile' && <ProfileSection />}
        {activeTab === 'security' && <SecuritySection />}
        {activeTab === 'integrations' && (
          <SyncIntegrationsTab
            status={status}
            loading={loading}
            error={error}
            loadStatus={loadStatus}
            connectOutlook={connectOutlook}
          />
        )}
        {activeTab === 'approvals' && <ApprovalQueueSection />}
        {activeTab === 'system' && <SystemStatusSection />}
      </div>

      {showFirstConnect && (
        <FirstConnectModal
          onComplete={(days) => {
            setShowFirstConnect(false);
            const labels: Record<number, string> = { 30: '30 days', 90: '90 days', 180: '6 months', 365: '1 year', 0: 'all' };
            setBanner({ tone: 'success', message: `Outlook connected. Syncing last ${labels[days] || `${days} days`} of email.` });
          }}
          onSkip={() => {
            setShowFirstConnect(false);
            setBanner({ tone: 'success', message: 'Outlook connected successfully.' });
          }}
        />
      )}
    </div>
  );
}

// ─── Sync & Integrations Tab ─────��───────────────────────────────────────────

function SyncIntegrationsTab({
  status,
  loading,
  error,
  loadStatus,
  connectOutlook,
}: {
  status: IntegrationsStatusResponse | null;
  loading: boolean;
  error: string | null;
  loadStatus: () => void;
  connectOutlook: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="card">
        <div className="font-medium mb-4">Sync Behavior</div>
        <div className="space-y-3 text-sm">
          <Toggle label="Auto-approve sync" />
          <Toggle label="Re-ranker enabled" checked />
          <Toggle label="News feed enabled" checked />
          <Toggle label="LinkedIn enrichment enabled" checked />
        </div>
      </div>

      <EmailHistoricalBackfillSection isOutlookConnected={status?.outlook?.status === 'connected'} />

      <FireflyHistoricalBackfillSection />

      <EmailSyncSection isOutlookConnected={status?.outlook?.status === 'connected'} />

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
            <FireflyIntegrationCard row={status.firefly} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────���──────────────────────────────────────────────────

function humanField(f: string): string {
  return (f || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function cleanValue(raw: any): string {
  if (raw == null) return '';
  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && parsed.value !== undefined) return String(parsed.value);
    if (typeof parsed === 'string') return parsed;
  } catch { /* not JSON */ }
  return s;
}

function shortUrl(v: string): string {
  return v.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

const SYNC_OPTIONS = [
  { value: 30, label: 'Last 30 days (recommended)' },
  { value: 90, label: 'Last 90 days' },
  { value: 180, label: 'Last 6 months' },
  { value: 365, label: 'Last year' },
  { value: 0, label: 'All time' },
];

function FirstConnectModal({ onComplete, onSkip }: { onComplete: (days: number) => void; onSkip: () => void }) {
  const [selectedDays, setSelectedDays] = React.useState(30);
  const [saving, setSaving] = React.useState(false);

  async function handleStart() {
    setSaving(true);
    try {
      await api.updateSyncConfig({ sync_history_days: selectedDays });
      try { await api.triggerSync('ingestion'); } catch {}
      onComplete(selectedDays);
    } catch {
      onComplete(selectedDays);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onClick={onSkip}>
      <div className="rounded-2xl w-full max-w-md shadow-2xl p-6"
        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-brand-gradient flex items-center justify-center">
            <Mail size={20} className="text-white" />
          </div>
          <div>
            <div className="text-lg font-medium text-text-primary">Outlook Connected</div>
            <div className="text-xs text-text-muted">One more step</div>
          </div>
        </div>

        <div className="text-sm text-text-secondary mb-4">
          How far back should we sync your email?
        </div>

        <div className="space-y-2 mb-4">
          {SYNC_OPTIONS.map(o => (
            <label key={o.value}
              className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors"
              style={{
                background: selectedDays === o.value ? 'rgba(139,92,246,0.1)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${selectedDays === o.value ? 'rgba(139,92,246,0.3)' : 'rgba(255,255,255,0.06)'}`,
              }}>
              <input type="radio" name="sync_window" value={o.value}
                checked={selectedDays === o.value}
                onChange={() => setSelectedDays(o.value)} className="sr-only" />
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                selectedDays === o.value ? 'border-purple-400' : 'border-text-muted/30'
              }`}>
                {selectedDays === o.value && <div className="w-2 h-2 rounded-full bg-purple-400" />}
              </div>
              <span className="text-sm text-text-primary">{o.label}</span>
            </label>
          ))}
        </div>

        <div className="text-xs text-text-muted mb-5">
          You can always import more history later from Settings.
        </div>

        <div className="flex justify-end gap-3">
          <button className="btn-ghost text-sm" onClick={onSkip}>Skip</button>
          <button className="btn-primary text-sm" onClick={handleStart} disabled={saving}>
            {saving ? 'Setting up...' : 'Start Sync'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmailSyncSection({ isOutlookConnected }: { isOutlookConnected: boolean }) {
  const [syncDays, setSyncDays] = React.useState<number>(30);
  const [configLoaded, setConfigLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    api.getSyncConfig()
      .then(d => {
        const days = d.config.sync_history_days;
        const mapped = days >= 3650 ? 0 : days;
        setSyncDays(mapped);
        setConfigLoaded(true);
      })
      .catch(() => setConfigLoaded(true));
  }, []);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleSyncDaysChange(value: number) {
    setSyncDays(value);
    setSaving(true);
    try {
      await api.updateSyncConfig({ sync_history_days: value });
      setToast('Sync window updated');
    } catch { setToast('Failed to update'); }
    setSaving(false);
  }

  // Reference isOutlookConnected to keep the prop on the type signature even
  // though the section's only remaining surface (Sync History dropdown)
  // applies whether or not the user is currently connected — the value picks
  // up on first connect.
  void isOutlookConnected;

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Mail size={16} className="text-accent-magenta" />
        <div className="font-medium">Email Sync</div>
      </div>

      <div>
        <div className="text-xs text-text-muted mb-2">Sync History</div>
        <div className="text-xs text-text-secondary mb-2">
          When connecting Outlook for the first time, how far back should we import emails?
        </div>
        <select
          value={syncDays}
          onChange={e => handleSyncDaysChange(Number(e.target.value))}
          disabled={saving || !configLoaded}
          className="input text-sm py-1.5 px-3 w-72"
        >
          {SYNC_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {saving && <span className="text-[10px] text-text-muted ml-2">Saving...</span>}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
          style={{ background: '#1A1A1F', border: '1px solid rgba(34,197,94,0.3)', borderLeft: '3px solid #22C55E' }}>
          <div className="text-sm text-text-primary">{toast}</div>
        </div>
      )}
    </div>
  );
}

// ─── Email Historical Backfill (progressive, server-side, cron-driven) ─────
//
// Sibling to EmailSyncSection. The legacy section uses /admin/backfill-email
// (single-call inline backfill driven by a browser useEffect that auto-resumes
// page-batches). This section uses /backfill/{start,progress,cancel} which
// queues a parent + N×10-day window jobs that the server's */2 cron drives
// to completion with no browser involvement. UX: 18-pill progress strip, 5s
// poll, cancel button, owner user-picker, custom date-range modal.

const PROGRESSIVE_DAYS_OPTIONS: Array<30 | 60 | 90 | 180> = [30, 60, 90, 180];

function fmtDuration(s: number | null | undefined): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function EmailHistoricalBackfillSection({ isOutlookConnected }: { isOutlookConnected: boolean }) {
  const [me, setMe] = React.useState<UserProfile | null>(null);
  const [eligibleUsers, setEligibleUsers] = React.useState<Array<{
    id: string; email: string; full_name: string | null; role: string;
  }>>([]);
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<{
    parent: any | null;
    windows: any[];
    summary: any | null;
  } | null>(null);
  const [days, setDays] = React.useState<30 | 60 | 90 | 180>(90);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [dateRangeOpen, setDateRangeOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [, setTickN] = React.useState(0);
  const [toast, setToast] = React.useState<string | null>(null);

  const isOwner = me?.role === 'owner' || me?.role === 'super_admin';

  React.useEffect(() => {
    api.getMe().then(d => {
      setMe(d.user);
      setSelectedUserId(d.user.id);
      if (d.user.role === 'owner' || d.user.role === 'super_admin') {
        api.listProgressiveEligibleUsers()
          .then(r => setEligibleUsers(r.users))
          .catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const fetchProgress = React.useCallback(async () => {
    if (!selectedUserId) return;
    try {
      const isSelf = selectedUserId === me?.id;
      const r = await api.getProgressiveBackfillProgress(isSelf ? undefined : selectedUserId);
      setProgress({ parent: r.parent, windows: r.windows, summary: r.summary });
    } catch { /* ignore */ }
  }, [selectedUserId, me?.id]);

  React.useEffect(() => { fetchProgress(); }, [fetchProgress]);

  // 5s poll while active
  React.useEffect(() => {
    if (progress?.parent?.status !== 'active') return;
    const id = setInterval(fetchProgress, 5000);
    return () => clearInterval(id);
  }, [progress?.parent?.status, fetchProgress]);

  // 1s tick for elapsed display
  React.useEffect(() => {
    if (progress?.parent?.status !== 'active') return;
    const id = setInterval(() => setTickN(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [progress?.parent?.status]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function startBackfill(daysBack: 30 | 60 | 90 | 180) {
    setConfirmOpen(false);
    setLoading(true);
    try {
      const isSelf = selectedUserId === me?.id;
      await api.startProgressiveBackfill({
        days_back: daysBack,
        ...(isSelf ? {} : { user_id: selectedUserId! }),
      });
      setToast('Backfill started — first window kicks off within 2 minutes');
      fetchProgress();
    } catch (e: any) {
      setToast(`Failed: ${e?.message || 'unknown error'}`);
    }
    setLoading(false);
  }

  async function cancelBackfill() {
    setLoading(true);
    try {
      const isSelf = selectedUserId === me?.id;
      await api.cancelProgressiveBackfill(isSelf ? undefined : selectedUserId!);
      setToast('Backfill cancelled');
      fetchProgress();
    } catch (e: any) {
      setToast(`Cancel failed: ${e?.message || 'unknown'}`);
    }
    setLoading(false);
  }

  if (!isOutlookConnected) return null;

  const status = progress?.parent?.status;
  const summary = progress?.summary;
  const windows = progress?.windows ?? [];
  const isActive = status === 'active';
  const isDone = status === 'completed';
  const isCancelled = status === 'cancelled';
  const isIdle = !progress?.parent;
  const targetUserLabel = selectedUserId === me?.id
    ? 'yourself'
    : (eligibleUsers.find(u => u.id === selectedUserId)?.email ?? 'this user');

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Clock size={16} className="text-accent-purple" />
        <div className="font-medium">Email Historical Backfill</div>
        {isActive && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold ml-1"
            style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>
            ACTIVE
          </span>
        )}
      </div>

      {isOwner && eligibleUsers.length > 1 && (
        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">Backfill for</div>
          <select
            value={selectedUserId ?? ''}
            onChange={e => setSelectedUserId(e.target.value)}
            className="input text-sm py-1.5 px-3 w-72"
          >
            {eligibleUsers.map(u => (
              <option key={u.id} value={u.id}>
                {u.id === me?.id ? 'Yourself' : `${u.full_name || u.email}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {isIdle && (
        <div>
          <div className="text-xs text-text-secondary mb-3">
            Pull historical email in the background. Runs server-side in 10-day windows.
            Survives page refresh, paces itself across cron ticks. No babysitting.
          </div>
          <div className="flex flex-wrap gap-2">
            {PROGRESSIVE_DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => { setDays(d); setConfirmOpen(true); }}
                disabled={loading}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Clock size={13} /> Last {d} days
              </button>
            ))}
            <button
              onClick={() => setDateRangeOpen(true)}
              disabled={loading}
              className="btn-secondary text-xs py-1.5 flex items-center gap-2"
            >
              <Calendar size={13} /> Custom Date Range
            </button>
          </div>
        </div>
      )}

      {(isActive || isDone || isCancelled) && summary && (
        <div className="space-y-3">
          <div className="text-sm text-text-primary">
            <span className="font-medium">
              {isActive
                ? `${summary.windows_completed} of ${summary.windows_total} windows`
                : isDone
                ? 'Backfill complete'
                : 'Backfill cancelled'}
            </span>
            <span className="text-text-muted">
              {' · '}{summary.emails_total.toLocaleString()} emails
              {' · '}{summary.attachments_persisted.toLocaleString()} attachments
              {isActive && summary.eta_seconds !== null && ` · ETA ${fmtDuration(summary.eta_seconds)}`}
            </span>
          </div>

          {/* 18-pill progress strip */}
          <div className="flex flex-wrap gap-1">
            {windows.map((w: any) => {
              const cls = w.status === 'completed'
                ? 'bg-green-500/30 border-green-500/50'
                : w.status === 'in_progress'
                ? 'bg-accent-purple/30 border-accent-purple/60 animate-pulse'
                : w.status === 'failed'
                ? 'bg-red-500/30 border-red-500/50'
                : 'bg-white/5 border-white/10';
              const range = `${new Date(w.start_date).toISOString().slice(0, 10)} → ${new Date(w.end_date).toISOString().slice(0, 10)}`;
              const subtitle = `${w.emails_fetched ?? 0} emails · ${w.attachments_persisted ?? 0} attachments`;
              return (
                <div
                  key={w.id}
                  title={`Window ${w.window_index} (${range})\nstatus: ${w.status}\n${subtitle}${w.last_error ? '\n' + w.last_error : ''}`}
                  className={`h-2 w-6 rounded-sm border ${cls}`}
                />
              );
            })}
          </div>

          <div className="text-[10px] text-text-muted">
            Elapsed {fmtDuration(summary.elapsed_seconds)}
            {summary.avg_window_seconds !== null && ` · avg ${fmtDuration(summary.avg_window_seconds)}/window`}
            {summary.attachments_failed > 0 && ` · ${summary.attachments_failed} attachment failures`}
            {summary.attachments_skipped > 0 && ` · ${summary.attachments_skipped} skipped`}
          </div>

          <div className="flex items-center gap-2">
            {isActive && (
              <button
                onClick={cancelBackfill}
                disabled={loading}
                className="btn-ghost text-xs py-1.5 flex items-center gap-2 text-red-400 hover:text-red-300"
              >
                <XIcon size={13} /> Cancel backfill
              </button>
            )}
            {(isDone || isCancelled) && (
              <button
                onClick={() => setProgress(null)}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Clock size={13} /> Start a new backfill
              </button>
            )}
          </div>
        </div>
      )}

      {/* Confirmation modal for days_back */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setConfirmOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Start backfill</div>
            <div className="text-sm text-text-secondary mb-4">
              Pull last <strong>{days}</strong> days of email for <strong>{targetUserLabel}</strong>.
              Runs in 10-day windows, server-side. No need to keep this tab open.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={loading} onClick={() => startBackfill(days)}>
                {loading ? 'Starting...' : 'Start'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom date range modal */}
      {dateRangeOpen && (
        <ProgressiveDateRangeModal
          targetUserId={selectedUserId !== me?.id ? selectedUserId ?? undefined : undefined}
          targetUserLabel={targetUserLabel}
          onClose={() => setDateRangeOpen(false)}
          onStarted={() => {
            setDateRangeOpen(false);
            setToast('Backfill started');
            fetchProgress();
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
          style={{ background: '#1A1A1F', border: '1px solid rgba(34,197,94,0.3)', borderLeft: '3px solid #22C55E' }}>
          <div className="text-sm text-text-primary">{toast}</div>
        </div>
      )}
    </div>
  );
}

function ProgressiveDateRangeModal({
  targetUserId,
  targetUserLabel,
  onClose,
  onStarted,
}: {
  targetUserId?: string;
  targetUserLabel: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!startDate || !endDate) {
      setError('Both dates are required');
      return;
    }
    setLoading(true);
    try {
      await api.startProgressiveBackfill({
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
        ...(targetUserId ? { user_id: targetUserId } : {}),
      });
      onStarted();
    } catch (e: any) {
      setError(e?.message || 'Failed to start');
    }
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}>
      <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={e => e.stopPropagation()}>
        <div className="text-lg font-medium text-text-primary mb-2">Custom date range</div>
        <div className="text-sm text-text-secondary mb-4">
          Pulled in 10-day windows for <strong>{targetUserLabel}</strong>, newest first.
        </div>
        <div className="space-y-3 mb-4">
          <div>
            <div className="text-xs text-text-muted mb-1">Start date</div>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="input text-sm w-full" />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">End date</div>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="input text-sm w-full" />
          </div>
        </div>
        {error && <div className="text-xs text-red-400 mb-3">{error}</div>}
        <div className="flex justify-end gap-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={loading} onClick={submit}>
            {loading ? 'Starting...' : 'Start backfill'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Fireflies Historical Backfill (progressive, server-side, cron-driven) ─
//
// Sibling to EmailHistoricalBackfillSection. Owner-gated entirely (the
// underlying admin endpoints require role='owner'); the section returns null
// for non-owners. UX mirrors the Outlook section but the trigger modal also
// requires a Fireflies API key (one-time per backfill — encrypted server-side
// via TOKEN_ENCRYPTION_KEY, nuked when the parent flips to completed/cancelled,
// per Phase F's least-privilege design for transactional secrets).
//
// User-on-behalf-of selector reuses /backfill/eligible-users (lists Outlook-
// connected users in the org). Tony, the only org user we expect to need
// Fireflies recovery in this wave, is Outlook-connected, so this list is a
// fine proxy for "active org users" without adding a new backend endpoint.

const FIREFLY_PROGRESSIVE_DAYS_OPTIONS: Array<30 | 60 | 90 | 180> = [30, 60, 90, 180];

function FireflyHistoricalBackfillSection() {
  const [me, setMe] = React.useState<UserProfile | null>(null);
  const [eligibleUsers, setEligibleUsers] = React.useState<Array<{
    id: string; email: string; full_name: string | null; role: string;
  }>>([]);
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<{
    parent: any | null;
    windows: any[];
  } | null>(null);
  const [days, setDays] = React.useState<30 | 60 | 90 | 180>(90);
  const [triggerOpen, setTriggerOpen] = React.useState(false);
  const [dateRangeOpen, setDateRangeOpen] = React.useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const isOwner = me?.role === 'owner' || me?.role === 'super_admin';

  React.useEffect(() => {
    api.getMe().then(d => {
      setMe(d.user);
      setSelectedUserId(d.user.id);
      if (d.user.role === 'owner' || d.user.role === 'super_admin') {
        api.listProgressiveEligibleUsers()
          .then(r => setEligibleUsers(r.users))
          .catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const fetchProgress = React.useCallback(async () => {
    if (!selectedUserId) return;
    try {
      const r = await api.getFireflyProgressiveBackfillProgress(selectedUserId);
      setProgress({ parent: r.parent, windows: r.windows });
    } catch { /* ignore — owner-gated, may 403 for non-owners */ }
  }, [selectedUserId]);

  React.useEffect(() => { fetchProgress(); }, [fetchProgress]);

  // 5s poll while active; 30s poll while idle so the card refreshes if a
  // backfill is started from another tab / curl.
  React.useEffect(() => {
    if (!selectedUserId) return;
    const intervalMs = progress?.parent?.status === 'active' ? 5000 : 30000;
    const id = setInterval(fetchProgress, intervalMs);
    return () => clearInterval(id);
  }, [progress?.parent?.status, fetchProgress, selectedUserId]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  async function startDaysBackfill(daysBack: 30 | 60 | 90 | 180, fireflyApiKey: string) {
    if (!selectedUserId) return;
    setLoading(true);
    try {
      await api.startFireflyProgressiveBackfill({
        user_id: selectedUserId,
        fireflies_api_key: fireflyApiKey,
        days_back: daysBack,
      });
      setTriggerOpen(false);
      setToast('Backfill started — first window kicks off within 60 seconds');
      fetchProgress();
    } catch (e: any) {
      setToast(`Failed: ${e?.message || 'unknown error'}`);
    }
    setLoading(false);
  }

  async function cancelBackfill() {
    if (!selectedUserId) return;
    setLoading(true);
    setCancelConfirmOpen(false);
    try {
      await api.cancelFireflyProgressiveBackfill(selectedUserId);
      setToast('Backfill cancelled');
      fetchProgress();
    } catch (e: any) {
      setToast(`Cancel failed: ${e?.message || 'unknown'}`);
    }
    setLoading(false);
  }

  // Owner-only — backend endpoints all require role='owner'. Hide for
  // members so we don't show controls that would 403 on every action.
  if (!isOwner) return null;

  const status = progress?.parent?.status;
  const windows = progress?.windows ?? [];
  const isActive = status === 'active';
  const isDone = status === 'completed';
  const isCancelled = status === 'cancelled';
  const isIdle = !progress?.parent;

  // Sum counters across windows for the active/done summary line.
  const counters = windows.reduce(
    (acc: { fetched: number; persisted: number; duplicate: number; failed: number }, w: any) => ({
      fetched: acc.fetched + (w.transcripts_fetched ?? 0),
      persisted: acc.persisted + (w.transcripts_persisted ?? 0),
      duplicate: acc.duplicate + (w.transcripts_skipped_duplicate ?? 0),
      failed: acc.failed + (w.transcripts_failed ?? 0),
    }),
    { fetched: 0, persisted: 0, duplicate: 0, failed: 0 }
  );
  const completedCount = windows.filter((w: any) => w.status === 'completed').length;
  const totalWindows = progress?.parent?.total_windows ?? windows.length;
  const targetUserLabel = selectedUserId === me?.id
    ? 'yourself'
    : (eligibleUsers.find(u => u.id === selectedUserId)?.email ?? 'this user');

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Mic size={16} className="text-accent-purple" />
        <div className="font-medium">Fireflies Historical Backfill</div>
        {isActive && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold ml-1"
            style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>
            ACTIVE
          </span>
        )}
      </div>

      {eligibleUsers.length > 1 && (
        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">Backfill for</div>
          <select
            value={selectedUserId ?? ''}
            onChange={e => setSelectedUserId(e.target.value)}
            className="input text-sm py-1.5 px-3 w-72"
          >
            {eligibleUsers.map(u => (
              <option key={u.id} value={u.id}>
                {u.id === me?.id ? 'Yourself' : `${u.full_name || u.email}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {isIdle && (
        <div>
          <div className="text-xs text-text-secondary mb-3">
            Pull historical Fireflies meetings in the background. Runs server-side in
            10-day windows. Survives page refresh, paces itself across cron ticks.
            Requires the user's Fireflies API key (one-time, encrypted, nuked at
            completion).
          </div>
          <div className="flex flex-wrap gap-2">
            {FIREFLY_PROGRESSIVE_DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => { setDays(d); setTriggerOpen(true); }}
                disabled={loading}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Mic size={13} /> Last {d} days
              </button>
            ))}
            <button
              onClick={() => setDateRangeOpen(true)}
              disabled={loading}
              className="btn-secondary text-xs py-1.5 flex items-center gap-2"
            >
              <Calendar size={13} /> Custom Date Range
            </button>
          </div>
        </div>
      )}

      {(isActive || isDone || isCancelled) && (
        <div className="space-y-3">
          <div className="text-sm text-text-primary">
            <span className="font-medium">
              {isActive
                ? `${completedCount} of ${totalWindows} windows`
                : isDone
                ? 'Backfill complete'
                : 'Backfill cancelled'}
            </span>
            <span className="text-text-muted">
              {' · '}{counters.persisted.toLocaleString()} transcripts ingested
              {counters.duplicate > 0 && ` · ${counters.duplicate} already had`}
              {counters.failed > 0 && ` · ${counters.failed} failed`}
            </span>
          </div>

          {/* Per-window pill strip — 9 windows for a 90-day backfill. */}
          <div className="flex flex-wrap gap-1">
            {windows.map((w: any) => {
              const cls = w.status === 'completed'
                ? 'bg-green-500/30 border-green-500/50'
                : w.status === 'in_progress'
                ? 'bg-accent-purple/30 border-accent-purple/60 animate-pulse'
                : w.status === 'failed'
                ? 'bg-red-500/30 border-red-500/50'
                : 'bg-white/5 border-white/10';
              const range = `${new Date(w.start_date).toISOString().slice(0, 10)} → ${new Date(w.end_date).toISOString().slice(0, 10)}`;
              const subtitle = `${w.transcripts_persisted ?? 0} ingested · ${w.transcripts_skipped_duplicate ?? 0} dupes${w.transcripts_failed ? ` · ${w.transcripts_failed} failed` : ''}`;
              return (
                <div
                  key={w.id}
                  title={`Window ${w.window_index} (${range})\nstatus: ${w.status}\n${subtitle}${w.last_error ? '\n' + w.last_error : ''}`}
                  className={`h-2 w-6 rounded-sm border ${cls}`}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {isActive && (
              <button
                onClick={() => setCancelConfirmOpen(true)}
                disabled={loading}
                className="btn-ghost text-xs py-1.5 flex items-center gap-2 text-red-400 hover:text-red-300"
              >
                <XIcon size={13} /> Cancel backfill
              </button>
            )}
            {(isDone || isCancelled) && (
              <button
                onClick={() => setProgress(null)}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Mic size={13} /> Start a new backfill
              </button>
            )}
          </div>
        </div>
      )}

      {/* Trigger modal — pill-strip path passes days, Custom path passes
          start/end dates. Both share the API key + submit handler via the
          same modal component to keep the API-key UX consistent. */}
      {triggerOpen && (
        <FireflyTriggerModal
          days={days}
          targetUserLabel={targetUserLabel}
          loading={loading}
          onClose={() => setTriggerOpen(false)}
          onSubmit={(apiKey) => startDaysBackfill(days, apiKey)}
        />
      )}

      {dateRangeOpen && (
        <FireflyDateRangeModal
          targetUserId={selectedUserId ?? undefined}
          targetUserLabel={targetUserLabel}
          onClose={() => setDateRangeOpen(false)}
          onStarted={() => {
            setDateRangeOpen(false);
            setToast('Backfill started');
            fetchProgress();
          }}
        />
      )}

      {cancelConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setCancelConfirmOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Cancel the backfill?</div>
            <div className="text-sm text-text-secondary mb-4">
              Transcripts already ingested will be kept. Pending and in-progress
              windows will be marked failed and the encrypted API key will be wiped.
              You'll need to start a new backfill from scratch (and re-enter the
              API key) to resume.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setCancelConfirmOpen(false)}>Keep running</button>
              <button className="btn-primary" disabled={loading}
                style={{ background: '#DC2626', borderColor: '#DC2626' }}
                onClick={cancelBackfill}>
                {loading ? 'Cancelling...' : 'Cancel backfill'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
          style={{ background: '#1A1A1F', border: '1px solid rgba(34,197,94,0.3)', borderLeft: '3px solid #22C55E' }}>
          <div className="text-sm text-text-primary">{toast}</div>
        </div>
      )}
    </div>
  );
}

function FireflyTriggerModal({
  days,
  targetUserLabel,
  loading,
  onClose,
  onSubmit,
}: {
  days: 30 | 60 | 90 | 180;
  targetUserLabel: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: (apiKey: string) => void;
}) {
  const [apiKey, setApiKey] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function submit() {
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('Fireflies API key is required');
      return;
    }
    // Pass the key up; clear local state immediately so the typed secret
    // doesn't linger in the closed modal's component memory if the parent
    // re-opens it.
    onSubmit(trimmed);
    setApiKey('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}>
      <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={e => e.stopPropagation()}>
        <div className="text-lg font-medium text-text-primary mb-2">Start Fireflies backfill</div>
        <div className="text-sm text-text-secondary mb-4">
          Pull last <strong>{days}</strong> days of meetings for <strong>{targetUserLabel}</strong>.
          Runs in 10-day windows, server-side. No need to keep this tab open.
        </div>

        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">Fireflies API Key</div>
          <div className="flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="paste here"
              className="input text-sm py-1.5 px-3 flex-1 font-mono"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey(s => !s)}
              className="btn-ghost text-xs py-1.5 px-3"
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="text-[10px] text-text-muted mt-1.5">
            Encrypted server-side and used only for this backfill, then wiped when it
            completes or is cancelled. Get yours at <span className="text-text-secondary">app.fireflies.ai → Settings → Developer settings</span>.
          </div>
        </div>

        {error && <div className="text-xs text-red-400 mb-3">{error}</div>}
        <div className="flex justify-end gap-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={loading} onClick={submit}>
            {loading ? 'Starting...' : 'Start backfill'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FireflyDateRangeModal({
  targetUserId,
  targetUserLabel,
  onClose,
  onStarted,
}: {
  targetUserId?: string;
  targetUserLabel: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!startDate || !endDate) { setError('Both dates are required'); return; }
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) { setError('Fireflies API key is required'); return; }
    if (!targetUserId) { setError('No target user selected'); return; }
    setLoading(true);
    try {
      await api.startFireflyProgressiveBackfill({
        user_id: targetUserId,
        fireflies_api_key: trimmedKey,
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
      });
      setApiKey('');
      onStarted();
    } catch (e: any) {
      setError(e?.message || 'Failed to start');
    }
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}>
      <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={e => e.stopPropagation()}>
        <div className="text-lg font-medium text-text-primary mb-2">Custom date range</div>
        <div className="text-sm text-text-secondary mb-4">
          Pulled in 10-day windows for <strong>{targetUserLabel}</strong>, newest first.
        </div>
        <div className="space-y-3 mb-4">
          <div>
            <div className="text-xs text-text-muted mb-1">Start date</div>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="input text-sm w-full" />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">End date</div>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="input text-sm w-full" />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Fireflies API Key</div>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="paste here"
                className="input text-sm py-1.5 px-3 flex-1 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey(s => !s)}
                className="btn-ghost text-xs py-1.5 px-3"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="text-[10px] text-text-muted mt-1.5">
              Encrypted and wiped at completion.
            </div>
          </div>
        </div>
        {error && <div className="text-xs text-red-400 mb-3">{error}</div>}
        <div className="flex justify-end gap-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={loading} onClick={submit}>
            {loading ? 'Starting...' : 'Start backfill'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Approval Queue ─────────────────────���────────────────────────────────────

function ApprovalQueueSection() {
  const [entities, setEntities] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
  const [heldExpandedIds, setHeldExpandedIds] = React.useState<Set<string>>(new Set());
  const [entityTypeFilter, setEntityTypeFilter] = React.useState<string>('');
  const [toast, setToast] = React.useState<string | null>(null);
  const [showBulkConfirm, setShowBulkConfirm] = React.useState(false);
  const [bulkApproving, setBulkApproving] = React.useState(false);
  const [showDismissAllConfirm, setShowDismissAllConfirm] = React.useState(false);
  const [bulkDismissing, setBulkDismissing] = React.useState(false);
  // Wave 6 UX — toggle for held-proposals visibility surface. When off
  // (default), the queue shows only rows that crossed the 3-channel
  // overwrite threshold (or 2-channel empty-fill). When on, also surface
  // values the evaluator stashed in entity_field_state.pending_proposals
  // — the "alternative values we've heard but haven't surfaced" pipeline.
  const [showHeld, setShowHeld] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (entityTypeFilter) params.entity_type = entityTypeFilter;
      if (showHeld) params.include_held = 'true';
      const res = await api.listApprovalQueueGrouped(params);
      setEntities(res.entities || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [entityTypeFilter, showHeld]);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const toggleExpand = (key: string) => {
    setExpandedIds(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key); else s.add(key);
      return s;
    });
  };

  async function approveOne(id: string) {
    try { await api.approveItem(id); load(); setToast('Approved'); } catch { setToast('Failed'); }
  }
  async function rejectOne(id: string) {
    try { await api.rejectItem(id); load(); setToast('Rejected'); } catch { setToast('Failed'); }
  }
  async function approveAllEntity(entityType: string, entityId: string) {
    try { await api.approveAllForEntity(entityType, entityId); load(); setToast('All approved'); } catch { setToast('Failed'); }
  }
  async function rejectAllEntity(entityType: string, entityId: string) {
    try { await api.rejectAllForEntity(entityType, entityId); load(); setToast('All dismissed'); } catch { setToast('Failed'); }
  }
  async function approveHeld(entityType: string, entityId: string, fieldName: string, value: string) {
    try {
      await api.approveHeldProposal(entityType, entityId, fieldName, value);
      load();
      setToast('Held value applied');
    } catch { setToast('Failed'); }
  }
  async function dismissHeld(entityType: string, entityId: string, fieldName: string, value: string) {
    try {
      await api.dismissHeldProposal(entityType, entityId, fieldName, value);
      load();
      setToast('Held value dismissed');
    } catch { setToast('Failed'); }
  }
  async function toggleLock(entityType: string, entityId: string, fieldName: string, locked: boolean) {
    try {
      await api.toggleFieldLock(entityType, entityId, fieldName, locked);
      load();
      setToast(locked ? 'Field locked' : 'Field unlocked');
    } catch (e: any) {
      // Forbidden = caller isn't owner. Surface the role gate clearly.
      const msg = String(e?.message || '');
      setToast(msg.includes('403') ? 'Owner only' : 'Failed');
    }
  }
  const toggleHeldExpand = (key: string) => {
    setHeldExpandedIds(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key); else s.add(key);
      return s;
    });
  };

  async function handleBulkApproveAll() {
    setBulkApproving(true);
    try {
      const allIds = entities.flatMap(e => e.updates.map((u: any) => u.id));
      const result = await api.bulkApprove(allIds);
      const resolved = result.resolved?.length || 0;
      const conflicts = result.conflicts?.length || 0;
      setToast(
        conflicts > 0
          ? `Approved ${resolved} items. ${conflicts} conflicts.`
          : `Approved ${resolved} items.`
      );
      load();
    } catch {
      setToast('Bulk approve failed');
    }
    setBulkApproving(false);
    setShowBulkConfirm(false);
  }

  async function handleDismissAll() {
    setBulkDismissing(true);
    try {
      const result = await api.dismissAllApprovals();
      setToast(`Dismissed ${result.resolved_count} item${result.resolved_count !== 1 ? 's' : ''}.`);
      load();
    } catch {
      setToast('Dismiss all failed');
    }
    setBulkDismissing(false);
    setShowDismissAllConfirm(false);
  }

  const totalPending = entities.reduce((s, e) => s + e.updates.length, 0);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-amber-400" />
          <div className="font-medium">Approval Queue</div>
          {totalPending > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{ background: 'rgba(245,158,11,0.15)', color: '#FBBF24' }}>
              {totalPending}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={entityTypeFilter}
            onChange={e => setEntityTypeFilter(e.target.value)}
            className="input text-xs py-1 px-2"
          >
            <option value="">All types</option>
            <option value="contact">Contacts</option>
            <option value="company">Companies</option>
          </select>
          <button onClick={load} disabled={loading} className="btn-ghost text-xs">
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowDismissAllConfirm(true)}
            disabled={totalPending === 0 || loading}
            className="btn-ghost text-xs py-1.5 px-3"
            style={{ opacity: totalPending === 0 ? 0.5 : 1, cursor: totalPending === 0 ? 'not-allowed' : 'pointer' }}
          >
            Dismiss All
          </button>
          <button
            onClick={() => setShowBulkConfirm(true)}
            disabled={totalPending === 0 || loading}
            className="btn-primary text-xs py-1.5 px-3"
            style={{ opacity: totalPending === 0 ? 0.5 : 1, cursor: totalPending === 0 ? 'not-allowed' : 'pointer' }}
          >
            Approve All
          </button>
        </div>
      </div>

      {totalPending > 0 && !loading && (
        <div className="text-xs text-text-muted mb-3">
          {totalPending} pending update{totalPending !== 1 ? 's' : ''} across {entities.length} {entityTypeFilter || 'entit'}{entities.length !== 1 ? (entityTypeFilter ? 's' : 'ies') : (entityTypeFilter ? '' : 'y')}
        </div>
      )}

      {/* Wave 6 — held-proposals visibility toggle. When on, surface
          the channel-stash from entity_field_state.pending_proposals so
          the user can see what the corroboration model is holding back. */}
      <div className="flex items-center gap-2 mb-3 text-[11px] text-text-muted">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showHeld}
            onChange={e => setShowHeld(e.target.checked)}
            className="cursor-pointer"
          />
          Show held proposals
        </label>
        <span className="text-text-muted/60">— alternative values the corroboration model is holding silently (single-channel against existing). Approve to override; dismiss to mark recently-rejected.</span>
      </div>

      {loading && entities.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2].map(i => <div key={i} className="h-16 bg-bg-surface-hover rounded-lg animate-pulse" />)}
        </div>
      ) : entities.length === 0 ? (
        <div className="text-center text-text-muted py-8 text-sm">No pending approvals</div>
      ) : (
        <div className="space-y-3">
          {entities.map((entity: any) => {
            const key = `${entity.entity_type}:${entity.entity_id}`;
            const isExpanded = expandedIds.has(key);
            const visibleUpdates = isExpanded ? entity.updates : entity.updates.slice(0, 3);
            const hasMore = entity.updates.length > 3;
            const icon = entity.entity_type === 'company' ? <Briefcase size={14} />
              : entity.entity_type === 'deal' ? <Target size={14} />
              : <Users size={14} />;
            const href = entity.entity_type === 'contact' ? `/contacts/${entity.entity_id}`
              : entity.entity_type === 'company' ? `/companies/${entity.entity_id}` : '#';

            return (
              <div key={key} className="rounded-xl overflow-hidden"
                style={{ background: 'rgba(17,17,20,0.5)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center justify-between px-4 py-3"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <Link href={href} className="flex items-center gap-3 hover:text-accent-magenta transition-colors">
                    <div className="w-8 h-8 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xs">
                      {entity.entity_avatar
                        ? <img src={entity.entity_avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
                        : icon}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-text-primary">{entity.entity_name || entity.entity_id.slice(0, 8)}</div>
                      <div className="text-[10px] text-text-muted uppercase tracking-wider">{entity.entity_type} &middot; {entity.updates.length} update{entity.updates.length !== 1 ? 's' : ''}</div>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    <button onClick={() => approveAllEntity(entity.entity_type, entity.entity_id)}
                      className="px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors"
                      style={{ background: 'rgba(34,197,94,0.1)', color: '#4ADE80' }}>
                      Approve All
                    </button>
                    <button onClick={() => rejectAllEntity(entity.entity_type, entity.entity_id)}
                      className="px-2.5 py-1 rounded-lg text-[10px] font-medium text-text-muted hover:text-text-secondary transition-colors"
                      style={{ background: 'rgba(255,255,255,0.04)' }}>
                      Dismiss All
                    </button>
                  </div>
                </div>

                <div>
                  <div className="grid grid-cols-[100px_1fr_1fr_50px_56px] gap-x-2 px-4 py-1.5 text-[9px] uppercase tracking-wider text-text-muted/60 font-semibold"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span>Field</span><span>Current</span><span>Proposed</span><span>Conf</span><span></span>
                  </div>
                  {visibleUpdates.map((u: any) => {
                    const proposed = cleanValue(u.proposed_value);
                    const current = u.current_value ? cleanValue(u.current_value) : null;
                    const isUrl = u.field_name?.includes('url');
                    const hasCorroboration =
                      Array.isArray(u.current_value_sources) ||
                      Array.isArray(u.proposed_value_sources);
                    const isReversecontactUnverified =
                      u.candidate_fields && typeof u.candidate_fields === 'object';
                    const hasAlternatives =
                      Array.isArray(u.alternatives) && u.alternatives.length > 0;
                    return (
                      <div key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <div className="grid grid-cols-[100px_1fr_1fr_50px_56px] gap-x-2 items-center px-4 py-2">
                          <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider truncate">{humanField(u.field_name)}</span>
                          <span className="text-xs text-text-muted truncate">
                            {current ? shortUrl(current) : <span className="text-text-muted/50 italic">empty</span>}
                          </span>
                          {isReversecontactUnverified ? (
                            <span className="text-xs text-text-muted italic truncate">
                              candidate · expand for fields
                            </span>
                          ) : isUrl ? (
                            <a href={proposed} target="_blank" rel="noopener" className="text-xs text-accent-magenta hover:underline font-medium truncate">{shortUrl(proposed)}</a>
                          ) : (
                            <span className="text-xs text-text-primary font-medium truncate">{proposed}</span>
                          )}
                          <span className="text-[10px] text-text-muted tabular-nums">{Math.round((u.confidence || 0) * 100)}%</span>
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => approveOne(u.id)}
                              className="w-6 h-6 rounded flex items-center justify-center hover:bg-green-500/20 transition-colors"
                              style={{ background: 'rgba(34,197,94,0.08)' }}>
                              <Check size={12} className="text-green-400" />
                            </button>
                            <button onClick={() => rejectOne(u.id)}
                              className="w-6 h-6 rounded flex items-center justify-center hover:bg-red-500/20 transition-colors"
                              style={{ background: 'rgba(255,255,255,0.03)' }}>
                              <XIcon size={12} className="text-text-muted" />
                            </button>
                          </div>
                        </div>

                        {/* Wave 6 corroboration packet — channel attribution
                            for current and proposed values. Renders only
                            when the queue row was produced by the
                            evaluator's QUEUE path. */}
                        {hasCorroboration && (
                          <div className="px-4 pb-2 pt-0.5 grid grid-cols-[100px_1fr_1fr_50px_56px] gap-x-2 text-[10px] text-text-muted/70">
                            <span></span>
                            <span className="truncate" title={(u.current_value_sources || []).join(', ')}>
                              {Array.isArray(u.current_value_sources) && u.current_value_sources.length > 0
                                ? <>from <span className="text-text-muted">{u.current_value_sources.length === 1 ? u.current_value_sources[0] : `${u.current_value_sources.length} channels`}</span></>
                                : <span className="italic">no source recorded</span>}
                            </span>
                            <span className="truncate" title={(u.proposed_value_sources || []).join(', ')}>
                              {Array.isArray(u.proposed_value_sources) && u.proposed_value_sources.length > 0
                                ? <>from <span className="text-emerald-400/80">{u.proposed_value_sources.length === 1 ? u.proposed_value_sources[0] : `${u.proposed_value_sources.length} channels`} agree</span></>
                                : null}
                            </span>
                            <span></span>
                            <span></span>
                          </div>
                        )}

                        {/* ReverseContact unverified — render the
                            structured candidate fields instead of the
                            raw JSON blob. The reviewer sees real fields
                            with the identity score's reasoning. */}
                        {isReversecontactUnverified && (
                          <div className="px-4 pb-2 pt-0.5 text-[11px] text-text-muted/80">
                            {typeof u.identity_score === 'number' && (
                              <div className="mb-1">
                                identity match {Math.round(u.identity_score * 100)}%
                                {Array.isArray(u.identity_details) && u.identity_details.length > 0 && (
                                  <span className="text-text-muted/60"> — {u.identity_details.slice(0, 2).join('; ')}</span>
                                )}
                              </div>
                            )}
                            <div className="space-y-0.5">
                              {Object.entries(u.candidate_fields).map(([k, v]) => (
                                v ? (
                                  <div key={k} className="flex gap-2">
                                    <span className="text-amber-400/70 uppercase tracking-wider text-[9px] w-24 flex-shrink-0">{humanField(k)}</span>
                                    <span className="text-text-secondary truncate">{String(v)}</span>
                                  </div>
                                ) : null
                              ))}
                            </div>
                          </div>
                        )}

                        {/* LinkedIn discovery alternatives — Phase B
                            stopped dumping the candidates array as the
                            top-level value. Top candidate is the
                            proposed value; the rest live here as a
                            collapsed list of alternates. */}
                        {hasAlternatives && (
                          <div className="px-4 pb-2 pt-0.5 text-[10px] text-text-muted/70">
                            or one of: {(u.alternatives as string[]).slice(0, 3).map((alt: string, i: number) => (
                              <a key={i} href={alt} target="_blank" rel="noopener" className="text-accent-magenta/80 hover:underline ml-1">
                                {shortUrl(alt)}{i < Math.min(2, (u.alternatives as string[]).length - 1) ? ',' : ''}
                              </a>
                            ))}
                            {(u.alternatives as string[]).length > 3 && <span className="ml-1">+{(u.alternatives as string[]).length - 3} more</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {hasMore && !isExpanded && (
                  <button onClick={() => toggleExpand(key)}
                    className="w-full px-4 py-2 text-[11px] text-text-muted hover:text-text-secondary flex items-center justify-center gap-1 transition-colors"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                    and {entity.updates.length - 3} more <ChevronDown size={12} />
                  </button>
                )}
                {hasMore && isExpanded && (
                  <button onClick={() => toggleExpand(key)}
                    className="w-full px-4 py-2 text-[11px] text-text-muted hover:text-text-secondary flex items-center justify-center gap-1 transition-colors"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                    Show less <ChevronUp size={12} />
                  </button>
                )}

                {/* Wave 6 UX — held proposals subsection. Renders only
                    when ?include_held=true brought rows back. Default
                    collapsed; the user expands per entity to see the
                    "alternatives we've heard but haven't surfaced". */}
                {Array.isArray(entity.held_proposals) && entity.held_proposals.length > 0 && (
                  <>
                    <button
                      onClick={() => toggleHeldExpand(key)}
                      className="w-full px-4 py-2 text-[10px] uppercase tracking-wider text-text-muted/70 hover:text-text-secondary flex items-center justify-center gap-1 transition-colors"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.03)', background: 'rgba(255,255,255,0.015)' }}
                    >
                      {entity.held_proposals.length} held alternative{entity.held_proposals.length !== 1 ? 's' : ''}
                      {heldExpandedIds.has(key) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                    {heldExpandedIds.has(key) && (
                      <div style={{ borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                        {entity.held_proposals.map((h: any, idx: number) => {
                          const heldKey = `${key}:held:${h.field_name}:${idx}`;
                          const isUrl = h.field_name?.includes('url');
                          const currentDisplay = h.current_value ? cleanValue(h.current_value) : null;
                          const proposedDisplay = cleanValue(h.value);
                          return (
                            <div
                              key={heldKey}
                              className="grid grid-cols-[100px_1fr_1fr_44px_84px] gap-x-2 items-center px-4 py-2 text-[11px]"
                              style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}
                            >
                              <span className="font-semibold text-purple-400/80 uppercase tracking-wider truncate">
                                {humanField(h.field_name)}
                              </span>
                              <span className="text-text-muted truncate" title={Array.isArray(h.current_value_sources) ? h.current_value_sources.join(', ') : undefined}>
                                {currentDisplay ? shortUrl(currentDisplay) : <span className="italic text-text-muted/50">empty</span>}
                              </span>
                              {isUrl ? (
                                <a href={proposedDisplay} target="_blank" rel="noopener" className="text-text-secondary hover:text-accent-magenta hover:underline truncate">
                                  {shortUrl(proposedDisplay)}
                                </a>
                              ) : (
                                <span className="text-text-secondary truncate">{proposedDisplay}</span>
                              )}
                              <span className="text-[9px] text-text-muted/70 tabular-nums" title={Array.isArray(h.channels) ? h.channels.join(', ') : undefined}>
                                {Array.isArray(h.channels) ? `${h.channels.length}ch` : ''}
                              </span>
                              <div className="flex items-center gap-1 justify-end">
                                <button
                                  onClick={() => toggleLock(entity.entity_type, entity.entity_id, h.field_name, !h.permanently_locked)}
                                  className="w-6 h-6 rounded flex items-center justify-center hover:bg-amber-500/20 transition-colors"
                                  style={{ background: h.permanently_locked ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.03)' }}
                                  title={h.permanently_locked
                                    ? 'Field is permanently locked from automated proposals — click to unlock'
                                    : 'Permanently lock this field from automated proposals (owner only)'}
                                >
                                  {h.permanently_locked
                                    ? <Lock size={11} className="text-amber-400" />
                                    : <Unlock size={11} className="text-text-muted/70" />}
                                </button>
                                <button
                                  onClick={() => approveHeld(entity.entity_type, entity.entity_id, h.field_name, h.value)}
                                  className="w-6 h-6 rounded flex items-center justify-center hover:bg-green-500/20 transition-colors"
                                  style={{ background: 'rgba(34,197,94,0.06)' }}
                                  title="Approve this held value (commits as human edit, resets corroboration)"
                                >
                                  <Check size={11} className="text-green-400/80" />
                                </button>
                                <button
                                  onClick={() => dismissHeld(entity.entity_type, entity.entity_id, h.field_name, h.value)}
                                  className="w-6 h-6 rounded flex items-center justify-center hover:bg-red-500/20 transition-colors"
                                  style={{ background: 'rgba(255,255,255,0.03)' }}
                                  title="Dismiss (90-day no-re-ask on this value)"
                                >
                                  <XIcon size={11} className="text-text-muted" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk Approve Confirmation Modal */}
      {showBulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setShowBulkConfirm(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Approve All Updates</div>
            <div className="text-sm text-text-secondary mb-5">
              Approve all {totalPending} pending update{totalPending !== 1 ? 's' : ''} across {entities.length} {entities.length === 1 ? 'entity' : 'entities'}?
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost text-sm" onClick={() => setShowBulkConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn-primary text-sm"
                onClick={handleBulkApproveAll}
                disabled={bulkApproving}
              >
                {bulkApproving ? 'Approving...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dismiss All Confirmation Modal */}
      {showDismissAllConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setShowDismissAllConfirm(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Dismiss All Pending</div>
            <div className="text-sm text-text-secondary mb-5">
              Reject all {totalPending} pending update{totalPending !== 1 ? 's' : ''} across {entities.length} {entities.length === 1 ? 'entity' : 'entities'}? This can&apos;t be undone — re-enrichment will surface new suggestions if applicable.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost text-sm" onClick={() => setShowDismissAllConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn-primary text-sm"
                onClick={handleDismissAll}
                disabled={bulkDismissing}
                style={{ background: '#EF4444' }}
              >
                {bulkDismissing ? 'Dismissing...' : 'Dismiss All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-bg-elevated border-l-4 border-semantic-success rounded-xl shadow-2xl px-5 py-3">
          <div className="text-sm text-text-primary">{toast}</div>
        </div>
      )}
    </div>
  );
}

// ─── Profile Section ─────────────────────────────────────────────────────────

function ProfileSection() {
  const [user, setUser] = React.useState<UserProfile | null>(null);
  const [draft, setDraft] = React.useState<Partial<UserProfile>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [toast, setToast] = React.useState<{ tone: 'success' | 'error'; msg: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [sharingConfirmOpen, setSharingConfirmOpen] = React.useState(false);
  const [togglingSharing, setTogglingSharing] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const { user: u } = await api.getMe();
      setUser(u);
      setDraft({});
    } catch (e: any) {
      setToast({ tone: 'error', msg: e?.message || 'Failed to load profile' });
    }
    setLoading(false);
  }, []);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const hasChanges = React.useMemo(() => {
    if (!user) return false;
    const fields: Array<keyof UserProfile> = ['full_name', 'phone', 'job_title', 'linkedin_url', 'bio'];
    return fields.some(f => f in draft && (draft[f] ?? null) !== (user[f] ?? null));
  }, [user, draft]);

  const update = (field: keyof UserProfile, value: string) => {
    setDraft(prev => ({ ...prev, [field]: value }));
  };

  const valueOf = (field: keyof UserProfile): string => {
    if (field in draft) return (draft[field] as string | null) ?? '';
    return (user?.[field] as string | null) ?? '';
  };

  async function handleSave() {
    if (!user || !hasChanges) return;
    if ('full_name' in draft && (!draft.full_name || draft.full_name.trim().length === 0)) {
      setToast({ tone: 'error', msg: 'Full name cannot be empty' });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, string | null> = {};
      const fields: Array<keyof UserProfile> = ['full_name', 'phone', 'job_title', 'linkedin_url', 'bio'];
      for (const f of fields) {
        if (!(f in draft)) continue;
        const v = (draft[f] as string | null) ?? null;
        if (f === 'full_name') {
          payload[f] = (v as string).trim();
        } else {
          const trimmed = (v ?? '').trim();
          payload[f] = trimmed.length === 0 ? null : trimmed;
        }
      }
      const { user: updated } = await api.updateMyProfile(payload as any);
      setUser(updated);
      setDraft({});
      setToast({ tone: 'success', msg: 'Profile saved' });
    } catch (e: any) {
      setToast({ tone: 'error', msg: e?.message || 'Failed to save profile' });
    }
    setSaving(false);
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setToast({ tone: 'error', msg: 'Avatar must be 5MB or smaller' });
      return;
    }
    setUploading(true);
    try {
      const { avatar_url } = await api.uploadMyAvatar(file);
      setUser(u => u ? { ...u, avatar_url } : u);
      setToast({ tone: 'success', msg: 'Avatar updated' });
    } catch (err: any) {
      setToast({ tone: 'error', msg: err?.message || 'Failed to upload avatar' });
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  if (loading || !user) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <UserIcon size={16} className="text-accent-magenta" />
          <div className="font-medium">My Profile</div>
        </div>
        <div className="h-32 bg-bg-surface-hover rounded-lg animate-pulse" />
      </div>
    );
  }

  const token = getAuthToken();
  const avatarBase = resolveAvatarUrl(user.avatar_url);
  const avatarSrc = avatarBase
    ? (avatarBase.includes('?') ? `${avatarBase}&token=${encodeURIComponent(token || '')}` : `${avatarBase}?token=${encodeURIComponent(token || '')}`)
    : null;
  const initials = (user.full_name || user.email)
    .split(/\s+/)
    .map(p => p.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('');

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <UserIcon size={16} className="text-accent-magenta" />
        <div className="font-medium">My Profile</div>
      </div>

      <div className="flex items-start gap-6 mb-6">
        <div className="relative shrink-0">
          <div className="w-20 h-20 rounded-full overflow-hidden bg-brand-gradient flex items-center justify-center text-white text-2xl font-medium">
            {avatarSrc ? (
              <img src={avatarSrc} alt="" className="w-full h-full object-cover" />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full flex items-center justify-center transition-colors"
            style={{
              background: 'rgba(26,26,31,0.95)',
              border: '1px solid rgba(255,255,255,0.12)',
              cursor: uploading ? 'wait' : 'pointer',
            }}
            title="Change avatar"
          >
            {uploading ? <Loader2 size={12} className="animate-spin text-text-secondary" /> : <Camera size={12} className="text-text-secondary" />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleAvatarChange}
            className="hidden"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-medium text-text-primary truncate">{user.full_name}</div>
          <div className="text-xs text-text-muted">{user.email}</div>
          <div className="text-[10px] text-text-muted uppercase tracking-wider mt-1">{user.role === 'super_admin' ? 'Super Admin' : user.role}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <ProfileField label="Full name" required>
          <input type="text" value={valueOf('full_name')} onChange={e => update('full_name', e.target.value)} className="input text-sm w-full" />
        </ProfileField>
        <ProfileField label="Email" helper="Cannot be changed">
          <input type="email" value={user.email} disabled className="input text-sm w-full" style={{ opacity: 0.6, cursor: 'not-allowed' }} />
        </ProfileField>
        <ProfileField label="Job title">
          <input type="text" value={valueOf('job_title')} onChange={e => update('job_title', e.target.value)} placeholder="e.g. Managing Partner" className="input text-sm w-full" />
        </ProfileField>
        <ProfileField label="Phone">
          <input type="tel" value={valueOf('phone')} onChange={e => update('phone', e.target.value)} placeholder="+1 (555) 555-5555" className="input text-sm w-full" />
        </ProfileField>
        <div className="col-span-2">
          <ProfileField label="LinkedIn URL">
            <input type="url" value={valueOf('linkedin_url')} onChange={e => update('linkedin_url', e.target.value)} placeholder="https://linkedin.com/in/..." className="input text-sm w-full" />
          </ProfileField>
        </div>
        <div className="col-span-2">
          <ProfileField label="Bio">
            <textarea value={valueOf('bio')} onChange={e => update('bio', e.target.value)} rows={3} placeholder="A short bio for teammates" className="input text-sm w-full resize-y" />
          </ProfileField>
        </div>
      </div>

      <div className="flex justify-end mt-6">
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="btn-primary text-sm"
          style={{ opacity: hasChanges && !saving ? 1 : 0.5, cursor: hasChanges && !saving ? 'pointer' : 'not-allowed' }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Email Visibility Toggle */}
      <div className="mt-8 pt-6 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <Mail size={16} className="text-accent-magenta" />
          <div className="font-medium text-sm">Email Visibility</div>
        </div>
        <div className="flex items-center justify-between rounded-xl p-4" style={{ background: 'rgba(17,17,20,0.5)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-sm text-text-primary font-medium">Share my emails with the team</div>
            <div className="text-xs text-text-muted mt-1">
              When enabled, all emails you&apos;re part of become visible to everyone in the organization.
              Other team members will be able to see the full content of emails you sent or received.
              This does not affect emails where you are not a participant.
            </div>
          </div>
          <button
            onClick={() => {
              if (user.share_emails_org_wide) {
                handleToggleSharing(false);
              } else {
                setSharingConfirmOpen(true);
              }
            }}
            disabled={togglingSharing}
            className="relative w-11 h-6 rounded-full shrink-0 transition-colors"
            style={{ background: user.share_emails_org_wide ? '#22C55E' : 'rgba(255,255,255,0.1)' }}
          >
            <div className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
              style={{ transform: user.share_emails_org_wide ? 'translateX(20px)' : 'translateX(0)' }} />
          </button>
        </div>
      </div>

      {/* Sharing confirmation modal */}
      {sharingConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => !togglingSharing && setSharingConfirmOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Share email content?</div>
            <div className="text-sm text-text-secondary mb-6">
              This will make all your email content visible to the entire team. Everyone in the organization will be able to read emails you sent or received. You can turn this off at any time.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setSharingConfirmOpen(false)} disabled={togglingSharing}>Cancel</button>
              <button className="btn-primary" onClick={() => handleToggleSharing(true)} disabled={togglingSharing}>
                {togglingSharing ? 'Enabling...' : 'Enable Sharing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
          style={{
            background: '#1A1A1F',
            border: `1px solid ${toast.tone === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            borderLeft: `3px solid ${toast.tone === 'success' ? '#22C55E' : '#EF4444'}`,
          }}>
          <div className="text-sm text-text-primary">{toast.msg}</div>
        </div>
      )}
    </div>
  );

  async function handleToggleSharing(enable: boolean) {
    setTogglingSharing(true);
    try {
      const { user: updated } = await api.updateMyProfile({ share_emails_org_wide: enable } as any);
      setUser(updated);
      setSharingConfirmOpen(false);
      setToast({ tone: 'success', msg: enable ? 'Email sharing enabled' : 'Email sharing disabled' });
    } catch (e: any) {
      setToast({ tone: 'error', msg: e?.message || 'Failed to update sharing preference' });
    }
    setTogglingSharing(false);
  }
}

function ProfileField({ label, required, helper, children }: { label: string; required?: boolean; helper?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1.5">
        {label}
        {required && <span className="text-semantic-error ml-0.5">*</span>}
      </label>
      {children}
      {helper && <div className="text-[10px] text-text-muted mt-1">{helper}</div>}
    </div>
  );
}

// ─── Security Section ────────────────────────────────────────────────────────

function SecuritySection() {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Shield size={16} className="text-accent-magenta" />
        <div className="font-medium">Security</div>
      </div>
      <ChangePasswordPanel />
      <div className="border-t border-border/50 mt-6 pt-6">
        <TwoFactorPanel />
      </div>
      <div className="border-t border-border/50 mt-6 pt-6">
        <ActiveSessionsPanel />
      </div>
    </div>
  );
}

function TwoFactorPanel() {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [enrollment, setEnrollment] = React.useState<{ secret: string; otpauth_url: string; recovery_codes: string[]; qr: string } | null>(null);
  const [savedRecovery, setSavedRecovery] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [showDisable, setShowDisable] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const { enabled } = await api.mfaStatus();
      setEnabled(enabled);
    } catch { setEnabled(false); }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  async function startEnrollment() {
    setBusy(true);
    try {
      const data = await api.mfaEnrollStart();
      const QR = (await import('qrcode')).default;
      const qr = await QR.toDataURL(data.otpauth_url, { margin: 1, width: 200 });
      setEnrollment({ ...data, qr });
      setSavedRecovery(false);
      setCode('');
    } catch (e: any) {
      setMsg({ tone: 'error', text: e?.message || 'Could not start enrollment' });
    }
    setBusy(false);
  }

  async function confirmEnrollment() {
    if (!/^\d{6}$/.test(code.trim())) { setMsg({ tone: 'error', text: 'Enter the 6-digit code' }); return; }
    setBusy(true);
    try {
      await api.mfaEnrollConfirm(code.trim());
      setMsg({ tone: 'success', text: 'Two-factor authentication enabled' });
      setEnrollment(null);
      setEnabled(true);
    } catch (e: any) {
      setMsg({ tone: 'error', text: /INVALID_CODE/.test(e?.message || '') ? 'Invalid code' : (e?.message || 'Failed') });
    }
    setBusy(false);
  }

  async function disable() {
    if (!/^\d{6}$/.test(code.trim())) { setMsg({ tone: 'error', text: 'Enter the 6-digit code' }); return; }
    setBusy(true);
    try {
      await api.mfaDisable(code.trim());
      setMsg({ tone: 'success', text: 'Two-factor authentication disabled' });
      setEnabled(false);
      setShowDisable(false);
      setCode('');
    } catch (e: any) {
      setMsg({ tone: 'error', text: /INVALID_CODE/.test(e?.message || '') ? 'Invalid code' : (e?.message || 'Failed') });
    }
    setBusy(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm text-text-secondary">Two-factor authentication</div>
          <div className="text-[11px] text-text-muted mt-0.5">
            Use an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, etc.) to add a second step at sign-in.
          </div>
        </div>
        {enabled !== null && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${enabled ? 'bg-semantic-success/15 text-semantic-success' : 'bg-bg-input text-text-muted'}`}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        )}
      </div>

      {enabled === false && !enrollment && (
        <button onClick={startEnrollment} disabled={busy} className="btn-secondary text-sm py-1.5">
          {busy ? 'Loading...' : 'Enable 2FA'}
        </button>
      )}

      {enrollment && (
        <div className="mt-4 grid gap-4 max-w-xl">
          <div className="flex gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrollment.qr} alt="2FA QR code" width={160} height={160} className="rounded-lg bg-white p-2" />
            <div className="text-xs text-text-muted">
              <div className="mb-2">Scan this QR with your authenticator app, or enter the secret manually:</div>
              <code className="block break-all text-text-secondary bg-bg-input rounded px-2 py-1">{enrollment.secret}</code>
            </div>
          </div>

          <div>
            <div className="text-xs text-text-secondary mb-1">Recovery codes — save these somewhere safe. Each can be used once if you lose your device.</div>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs bg-bg-input rounded-lg p-3">
              {enrollment.recovery_codes.map(c => <div key={c}>{c}</div>)}
            </div>
            <label className="flex items-center gap-2 mt-2 text-xs text-text-secondary">
              <input type="checkbox" checked={savedRecovery} onChange={e => setSavedRecovery(e.target.checked)} />
              I&apos;ve saved my recovery codes
            </label>
          </div>

          <div>
            <ProfileField label="Code from your authenticator app">
              <input value={code} onChange={e => setCode(e.target.value)} maxLength={6} inputMode="numeric"
                className="input text-sm w-32 font-mono tracking-widest" placeholder="000000" />
            </ProfileField>
            <div className="flex items-center gap-3 mt-3">
              <button onClick={confirmEnrollment} disabled={busy || !savedRecovery || code.length !== 6} className="btn-secondary text-sm py-1.5"
                style={{ opacity: (!savedRecovery || code.length !== 6 || busy) ? 0.5 : 1 }}>
                {busy ? 'Confirming...' : 'Confirm'}
              </button>
              <button onClick={() => { setEnrollment(null); setCode(''); }} className="text-xs text-text-muted hover:text-text-primary">
                Cancel
              </button>
              {msg && <span className={`text-xs ${msg.tone === 'success' ? 'text-semantic-success' : 'text-semantic-error'}`}>{msg.text}</span>}
            </div>
          </div>
        </div>
      )}

      {enabled && !showDisable && (
        <button onClick={() => { setShowDisable(true); setCode(''); }} className="btn-secondary text-sm py-1.5">
          Disable 2FA
        </button>
      )}

      {enabled && showDisable && (
        <div className="mt-3 max-w-xl">
          <ProfileField label="Enter your current 6-digit code to disable" >
            <input value={code} onChange={e => setCode(e.target.value)} maxLength={6} inputMode="numeric"
              className="input text-sm w-32 font-mono tracking-widest" placeholder="000000" />
          </ProfileField>
          <div className="flex items-center gap-3 mt-3">
            <button onClick={disable} disabled={busy || code.length !== 6} className="btn-secondary text-sm py-1.5"
              style={{ opacity: (code.length !== 6 || busy) ? 0.5 : 1 }}>
              {busy ? 'Disabling...' : 'Disable 2FA'}
            </button>
            <button onClick={() => { setShowDisable(false); setCode(''); }} className="text-xs text-text-muted hover:text-text-primary">
              Cancel
            </button>
            {msg && <span className={`text-xs ${msg.tone === 'success' ? 'text-semantic-success' : 'text-semantic-error'}`}>{msg.text}</span>}
          </div>
        </div>
      )}

      {!enrollment && !showDisable && msg && (
        <div className={`mt-2 text-xs ${msg.tone === 'success' ? 'text-semantic-success' : 'text-semantic-error'}`}>{msg.text}</div>
      )}
    </div>
  );
}

function ChangePasswordPanel() {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  React.useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 8) { setMsg({ tone: 'error', text: 'New password must be at least 8 characters' }); return; }
    if (next !== confirm) { setMsg({ tone: 'error', text: 'New password and confirmation do not match' }); return; }
    setSaving(true);
    try {
      await api.changePassword(current, next);
      setMsg({ tone: 'success', text: 'Password changed' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e: any) {
      const text = e?.message?.includes('401') || /INVALID_CREDENTIALS/i.test(e?.message || '')
        ? 'Current password is incorrect'
        : (e?.message || 'Failed to change password');
      setMsg({ tone: 'error', text });
    }
    setSaving(false);
  }

  const canSubmit = current.length > 0 && next.length >= 8 && confirm.length > 0 && !saving;

  return (
    <div>
      <div className="text-sm text-text-secondary mb-3">Change password</div>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-x-4 gap-y-3 max-w-xl">
        <div className="col-span-2">
          <ProfileField label="Current password">
            <input type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" className="input text-sm w-full" />
          </ProfileField>
        </div>
        <ProfileField label="New password" helper="Min 8 characters">
          <input type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" className="input text-sm w-full" />
        </ProfileField>
        <ProfileField label="Confirm new password">
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" className="input text-sm w-full" />
        </ProfileField>
        <div className="col-span-2 flex items-center gap-3">
          <button type="submit" disabled={!canSubmit} className="btn-secondary text-sm py-1.5"
            style={{ opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
            {saving ? 'Updating...' : 'Update Password'}
          </button>
          {msg && <span className={`text-xs ${msg.tone === 'success' ? 'text-semantic-success' : 'text-semantic-error'}`}>{msg.text}</span>}
        </div>
      </form>
    </div>
  );
}

function ActiveSessionsPanel() {
  const [sessions, setSessions] = React.useState<Array<{ id: string; created_at: string; expires_at: string; current: boolean }> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { const { sessions } = await api.listMySessions(); setSessions(sessions); } catch { setSessions([]); }
    setLoading(false);
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3000); return () => clearTimeout(t); }, [msg]);

  async function revokeOne(id: string) {
    setBusy(id);
    try { await api.revokeMySession(id); setMsg('Session revoked'); load(); } catch { setMsg('Failed to revoke session'); }
    setBusy(null);
  }

  async function logoutAllOthers() {
    setBusy('all');
    try { const { revoked } = await api.revokeAllOtherSessions(); setMsg(`Logged out of ${revoked} other ${revoked === 1 ? 'device' : 'devices'}`); load(); } catch { setMsg('Failed to log out other sessions'); }
    setBusy(null);
  }

  const otherSessions = sessions?.filter(s => !s.current) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-text-secondary">Active sessions</div>
        {otherSessions.length > 0 && (
          <button onClick={logoutAllOthers} disabled={busy === 'all'}
            className="text-xs text-text-muted hover:text-semantic-error transition-colors flex items-center gap-1.5">
            <LogOut size={12} />
            {busy === 'all' ? 'Logging out...' : `Log out other ${otherSessions.length} device${otherSessions.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1].map(i => <div key={i} className="h-12 bg-bg-surface-hover rounded-lg animate-pulse" />)}</div>
      ) : !sessions || sessions.length === 0 ? (
        <div className="text-xs text-text-muted py-3">No active sessions found.</div>
      ) : (
        <div className="space-y-2">
          {sessions.map(s => (
            <div key={s.id} className="flex items-center justify-between px-3 py-2.5 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: s.current ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.04)' }}>
                  <Shield size={13} className={s.current ? 'text-accent-purple' : 'text-text-muted'} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-text-primary flex items-center gap-2">
                    <span>Session</span>
                    {s.current && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider"
                        style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>Current</span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    Started {formatRelative(s.created_at)} · expires {formatRelative(s.expires_at)}
                  </div>
                </div>
              </div>
              {!s.current && (
                <button onClick={() => revokeOne(s.id)} disabled={busy === s.id}
                  className="text-text-muted hover:text-semantic-error transition-colors p-1.5" title="Revoke session">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {msg && <div className="text-xs text-text-muted mt-3">{msg}</div>}
      <div className="text-[10px] text-text-muted mt-3">
        Sessions don&apos;t track device or IP yet — you only see start/expiry times. We&apos;ll add device info in a future release.
      </div>
    </div>
  );
}

// ─── Shared UI Components ────────────────────────────────────────────────────

function Toggle({ label, checked = false }: { label: string; checked?: boolean }) {
  const [on, setOn] = React.useState(checked);
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-text-secondary">{label}</span>
      <button
        onClick={() => setOn(!on)}
        className={`w-10 h-6 rounded-full transition-colors ${on ? 'bg-brand-gradient' : 'bg-bg-surface-hover'}`}
      >
        <span className={`block w-4 h-4 rounded-full bg-white transform transition-transform ${on ? 'translate-x-5' : 'translate-x-1'}`} />
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
    case 'configured_no_channels':
      return 'text-semantic-warning';
    case 'auth_failed':
      return 'text-semantic-error';
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
  primaryDisabled,
}: {
  name: string;
  description: string;
  row: IntegrationRow;
  primaryLabel: string | null;
  onPrimaryClick?: () => void;
  primaryDisabled?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const rateLimitColor =
    row.rate_limit_status === 'auth_failed'
      ? 'text-semantic-error'
      : row.rate_limit_status === 'rate_limited'
        ? 'text-semantic-warning'
        : '';

  return (
    <div className="flex items-start justify-between py-4 border-b border-border/50 last:border-0 gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">{name}</div>
        <div className="text-xs text-text-secondary mt-0.5">{description}</div>
        <div className={`text-xs mt-2 ${statusColor(row.status)}`}>● {row.label}</div>
        {row.detail && (
          <div className={`text-xs mt-1 ${rateLimitColor || 'text-text-muted'}`}>{row.detail}</div>
        )}
        {row.last_sync && (
          <div className="text-xs text-text-muted mt-1">Last sync: {formatRelative(row.last_sync)}</div>
        )}
        {row.items_processed != null && row.items_processed > 0 && (
          <div className="text-xs text-text-muted mt-0.5">
            {row.items_processed.toLocaleString()} items synced
            {row.items_failed ? `, ${row.items_failed} failed` : ''}
          </div>
        )}
        {row.team_name && <div className="text-xs text-text-muted mt-1">Team: {row.team_name}</div>}
        {row.channels_visible != null && (row.channels_visible > 0 || row.status === 'configured_no_channels') && (
          <div className="text-xs text-text-muted mt-0.5">
            {row.channels_visible} channel{row.channels_visible === 1 ? '' : 's'} visible
            {row.messages_synced != null && <> • {row.messages_synced.toLocaleString()} message{row.messages_synced === 1 ? '' : 's'} synced</>}
          </div>
        )}
        {row.warnings && row.warnings.length > 0 && (
          <div className="mt-2 space-y-1">
            {row.warnings.map((w, i) => (
              <div key={i} className="text-xs text-semantic-warning bg-semantic-warning/10 border-l-2 border-semantic-warning px-2 py-1 rounded">
                {w}
              </div>
            ))}
          </div>
        )}
        {row.webhook_url && (
          <div className="mt-2 flex items-center gap-2">
            <code className="text-xs bg-bg-input px-2 py-1 rounded font-mono text-text-primary truncate max-w-md">{row.webhook_url}</code>
            <button onClick={() => { navigator.clipboard.writeText(row.webhook_url!); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn-ghost text-xs">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>

      {primaryLabel && (
        <div className="shrink-0 flex items-center gap-2">
          {row.status === 'connected' && (
            <span className="badge bg-semantic-success/10 text-semantic-success text-xs">Manage</span>
          )}
          <button onClick={onPrimaryClick} disabled={primaryDisabled} className={`${row.status === 'connected' ? 'btn-ghost text-xs' : 'btn-secondary text-xs py-1.5'} ${primaryDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
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

// ─── Firefly Card ─────────���───────────────────────────────────���──────────────

const FIREFLY_WEBHOOK_URL = 'https://medina-ventures-api.intel-ad5.workers.dev/webhooks/firefly';

const FIREFLY_TROUBLESHOOTING: Array<{ q: string; a: React.ReactNode }> = [
  { q: '"Webhook ready" but no transcripts appearing', a: <>Verify the webhook URL is correct in Firefly's Integrations → Webhooks settings. Check the History tab in Firefly's webhook config for delivery attempts. Make sure Firefly is set to auto-join your meetings (Settings → Recording &amp; Privacy).</> },
  { q: 'Test event returns 401 Unauthorized', a: <>The signing secret doesn't match. Copy the secret from the setup guide above and paste it into Firefly's webhook Signing Secret field. Both values must be identical.</> },
  { q: 'Test event returns 200 but real meetings don\'t appear', a: <>Check that "Meeting Transcribed" is selected as a webhook event. Firefly only sends webhooks after the transcript is fully processed, which can take 5–15 minutes after a meeting ends.</> },
  { q: 'Meetings are being recorded but Firefly bot doesn\'t join', a: <>Go to Firefly Settings → Recording &amp; Privacy. Make sure "Auto-join" is enabled for your calendar. The Firefly bot needs calendar access to detect and join meetings.</> },
  { q: 'How to import past meeting transcripts', a: <>Scroll up to the "Fireflies Historical Backfill" card. Pick a window (Last 30 / 60 / 90 / 180 days) or a custom date range, paste your Fireflies API key, and click Start. The backfill runs server-side across cron ticks and survives page refreshes.</> },
];

function FireflyIntegrationCard({ row }: { row: IntegrationRow }) {
  const [guideOpen, setGuideOpen] = React.useState(false);

  return (
    <div>
      <IntegrationRowView
        name="Firefly AI"
        description="Meeting transcription + action items via webhook."
        row={row}
        primaryLabel={null}
      />
      <button onClick={() => setGuideOpen(o => !o)} className="mt-2 flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors">
        {guideOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Setup guide &amp; troubleshooting
      </button>
      <div className={`overflow-hidden transition-all duration-200 ${guideOpen ? 'max-h-[2000px] opacity-100 mt-3' : 'max-h-0 opacity-0'}`}>
        <div className="border border-border/50 rounded-lg p-4 space-y-5 bg-bg-elevated/40">
          <FireflySetupGuide />
          <div className="border-t border-border/50 pt-4"><FireflyTroubleshooting /></div>
        </div>
      </div>
    </div>
  );
}

function FireflySetupGuide() {
  const [copiedUrl, setCopiedUrl] = React.useState(false);
  const [copiedSecret, setCopiedSecret] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [showSecret, setShowSecret] = React.useState(false);
  const [loadingSecret, setLoadingSecret] = React.useState(false);

  const loadSecret = React.useCallback(() => {
    if (secret) return;
    setLoadingSecret(true);
    api.getFireflyWebhookSecret()
      .then(d => setSecret(d.secret))
      .catch(() => setSecret(null))
      .finally(() => setLoadingSecret(false));
  }, [secret]);

  React.useEffect(() => { loadSecret(); }, [loadSecret]);

  const copySecret = () => {
    if (!secret) return;
    navigator.clipboard.writeText(secret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 1500);
  };

  return (
    <div>
      <div className="text-sm font-medium text-text-primary mb-2">How to connect Firefly</div>
      <ol className="space-y-1.5 text-xs text-text-secondary list-decimal list-inside">
        <li>Log in to your Firefly account at <span className="text-text-primary">app.fireflies.ai</span></li>
        <li>Go to <span className="text-text-primary">Settings → Developer settings</span> (left sidebar)</li>
        <li>Copy your <span className="text-text-primary">API Key</span> (you'll need this for transcript backfill)</li>
        <li>Go to <span className="text-text-primary">Integrations</span> (left sidebar)</li>
        <li>Click the <span className="text-text-primary">"API"</span> filter tab, then find <span className="text-text-primary">"Webhooks"</span></li>
        <li>Click on the Webhooks card, then <span className="text-text-primary">"+ Add Config"</span> or edit the Default Configuration</li>
        <li>
          Set the Webhook URL to:
          <div className="mt-1 flex items-center gap-2">
            <code className="text-xs bg-bg-input px-2 py-1 rounded font-mono text-text-primary truncate flex-1">{FIREFLY_WEBHOOK_URL}</code>
            <button onClick={() => { navigator.clipboard.writeText(FIREFLY_WEBHOOK_URL); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 1500); }} className="btn-ghost text-xs shrink-0">
              {copiedUrl ? 'Copied' : 'Copy'}
            </button>
          </div>
        </li>
        <li>
          Set the Signing Secret to:
          <div className="mt-1 flex items-center gap-2">
            {loadingSecret ? (
              <span className="text-xs text-text-muted">Loading...</span>
            ) : secret ? (
              <>
                <code className="text-xs bg-bg-input px-2 py-1 rounded font-mono text-text-primary truncate flex-1 select-all">
                  {showSecret ? secret : '••••••••••••••••••••••••••••••••'}
                </code>
                <button onClick={() => setShowSecret(s => !s)} className="btn-ghost text-xs shrink-0">
                  {showSecret ? 'Hide' : 'Reveal'}
                </button>
                <button onClick={copySecret} className="btn-ghost text-xs shrink-0">
                  {copiedSecret ? 'Copied' : 'Copy'}
                </button>
              </>
            ) : (
              <span className="text-xs text-semantic-error">Failed to load secret</span>
            )}
          </div>
        </li>
        <li>Select these events: <span className="text-text-primary">"Meeting Transcribed"</span> and <span className="text-text-primary">"Meeting Summarized"</span></li>
        <li>Click <span className="text-text-primary">Continue</span>, then <span className="text-text-primary">"Send Test Event"</span> to verify</li>
        <li>You should see <span className="text-semantic-success">"Test event delivered successfully (HTTP 200)"</span></li>
        <li>Click <span className="text-text-primary">Continue → Update</span> to save</li>
      </ol>
      <div className="text-xs text-text-muted mt-3">Firefly will now automatically send meeting transcripts to your CRM when meetings are recorded.</div>
    </div>
  );
}

function FireflyTroubleshooting() {
  const [openIdx, setOpenIdx] = React.useState<number | null>(null);
  return (
    <div>
      <div className="text-sm font-medium text-text-primary mb-2">Troubleshooting</div>
      <div className="space-y-1">
        {FIREFLY_TROUBLESHOOTING.map((item, i) => {
          const open = openIdx === i;
          return (
            <div key={i} className="border-b border-border/30 last:border-0">
              <button onClick={() => setOpenIdx(open ? null : i)} className="w-full flex items-center justify-between gap-2 py-2 text-left text-xs text-text-primary hover:text-accent-magenta transition-colors">
                <span>{item.q}</span>
                {open ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
              </button>
              <div className={`overflow-hidden transition-all duration-200 ${open ? 'max-h-96 pb-2 opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="text-xs text-text-secondary leading-relaxed pl-2">→ {item.a}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ────────────────────────────────────────────────────────────────────────────
// System Status tab — active tasks + run history + data completeness.
// All numbers come from a single GET /api/settings/system-status which runs
// direct D1 queries (no KV counters, no estimates).
// ────────────────────────────────────────────────────────────────────────────

function SystemStatusSection() {
  const [data, setData] = React.useState<SystemStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.getSettingsSystemStatus().then(setData).catch(e => setError(e?.message || 'Failed to load'));
  }, []);

  React.useEffect(() => {
    load();
    // Refresh every 10s while the tab is open. No visibility-pause logic
    // needed — Settings is a low-frequency page.
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (error) {
    return (
      <div className="card p-6">
        <div className="text-sm text-semantic-error">{error}</div>
        <button onClick={load} className="btn-secondary text-xs mt-3">Retry</button>
      </div>
    );
  }
  if (!data) {
    return <div className="card p-6 text-sm text-text-muted">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <ActiveTasksCard tasks={data.active_tasks} />
      <RunHistoryCard rows={data.run_history} />
      <DataCompletenessCard c={data.completeness} />
    </div>
  );
}

// ── Section 1: Active Tasks ──────────────────────────────────────────────

function ActiveTasksCard({ tasks }: { tasks: SystemStatusActiveTask[] }) {
  return (
    <div className="card p-5">
      <div className="text-sm font-medium text-text-primary mb-3">Active Tasks</div>
      {tasks.length === 0 ? (
        <div className="text-sm text-text-muted">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success mr-2 align-middle" />
          No active tasks. Next email sync at <span className="text-text-primary">:00</span>, next enrichment at <span className="text-text-primary">:05</span>.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((t, i) => (
            <li key={i} className="text-sm text-text-primary flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success animate-pulse" />
              <span>
                {t.type} in progress — {t.items_processed.toLocaleString()} item{t.items_processed === 1 ? '' : 's'} processed — started {formatDuration(t.elapsed_seconds)} ago
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Section 2: Run History ───────────────────────────────────────────────

function RunHistoryCard({ rows }: { rows: SystemStatusRunHistoryEntry[] }) {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-5 pt-5 pb-3 text-sm font-medium text-text-primary">Run History</div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-text-muted">No runs recorded yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-inset/50 border-y border-border">
              <tr>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th align="right">Items</Th>
                <Th align="right">Failed</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => <RunHistoryRow key={r.id} row={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th className={`px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-text-muted ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function RunHistoryRow({ row }: { row: SystemStatusRunHistoryEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const failed = row.status === 'failed';
  return (
    <tr className={`border-b border-border/40 ${failed ? 'bg-semantic-error/[0.04]' : ''}`}>
      <td className="px-4 py-3 text-text-primary">{row.type}</td>
      <td className="px-4 py-3">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-4 py-3 text-text-primary tabular-nums text-right">{row.items_processed.toLocaleString()}</td>
      <td className={`px-4 py-3 tabular-nums text-right ${row.items_failed > 0 ? 'text-semantic-error' : 'text-text-muted'}`}>
        {row.items_failed > 0 ? row.items_failed.toLocaleString() : '—'}
      </td>
      <td className="px-4 py-3 text-text-secondary whitespace-nowrap">{formatRelative(row.started_at)}</td>
      <td className="px-4 py-3 text-text-secondary tabular-nums whitespace-nowrap">
        {row.duration_seconds === 0 ? '—' : formatDuration(row.duration_seconds)}
      </td>
      <td className="px-4 py-3 text-text-secondary text-xs max-w-xs">
        {row.error_message ? (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-left text-semantic-error hover:underline"
          >
            {expanded
              ? row.error_message
              : (row.error_message.length > 60
                  ? row.error_message.slice(0, 60) + '…'
                  : row.error_message)}
          </button>
        ) : ''}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: SystemStatusRunHistoryEntry['status'] }) {
  const cfg = {
    completed: { bg: 'bg-semantic-success/15', fg: 'text-semantic-success', label: 'Completed' },
    failed:    { bg: 'bg-semantic-error/15',   fg: 'text-semantic-error',   label: 'Failed' },
    timed_out: { bg: 'bg-semantic-warning/15', fg: 'text-semantic-warning', label: 'Timed out' },
  }[status];
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${cfg.bg} ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}

// ── Section 3: Data Completeness ─────────────────────────────────────────

function DataCompletenessCard({ c }: { c: SystemStatusResponse['completeness'] }) {
  return (
    <div className="card p-5 space-y-5">
      <div>
        <div className="text-sm font-medium text-text-primary">Data Completeness</div>
        <div className="text-xs text-text-muted mt-0.5">
          How much of your data is captured, connected, and searchable.
        </div>
      </div>

      <CompletenessGroup title="Email Coverage">
        <CompletenessBar
          label="embedded"
          metric={c.email_embedding}
          unit="conversations searchable by MARTy"
          warningHint="Some emails were ingested before embedding was wired up — they're stored but not retrievable. A backfill would re-embed them."
        />
        <CompletenessBar
          label="linked"
          metric={c.email_linkage}
          unit="connected to contacts"
          warningHint="Some emails couldn't be linked to a contact — likely auto-generated, no-reply, or from senders not in the CRM."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Contact Coverage">
        <CompletenessBar
          label="enriched"
          metric={c.contact_enrichment}
          unit="contacts have enrichment data"
          warningHint="Unenriched contacts are missing bio, title, or LinkedIn data. The enrichment cron picks them up over time."
        />
        <CompletenessBar
          label="have company"
          metric={c.contact_company}
          unit="linked to a company"
          warningHint="Contacts without a company are usually personal-domain emails (gmail.com, etc.) or first-time meeting attendees."
        />
        <CompletenessBar
          label="have LinkedIn"
          metric={c.contact_linkedin}
          unit="have a LinkedIn URL"
          warningHint="LinkedIn discovery only runs during enrichment. Many contacts won't have a discoverable profile (privacy settings, generic names, etc.)."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Company Coverage">
        <CompletenessBar
          label="enriched"
          metric={c.company_enrichment}
          unit="companies have enrichment data"
        />
        <CompletenessBar
          label="have LinkedIn"
          metric={c.company_linkedin}
          unit="companies have a LinkedIn URL"
          warningHint="Company enrichment doesn't currently resolve LinkedIn URLs — only contact-level enrichment does. Worth a separate pass."
        />
      </CompletenessGroup>

      <CompletenessGroup title="Meeting Coverage">
        <CompletenessBar
          label="embedded"
          metric={c.meeting_embedding}
          unit="meetings searchable by MARTy"
        />
        <CompletenessBar
          label="attendees linked"
          metric={c.meeting_attendees}
          unit="attendees connected to contacts or users"
          warningHint="Unlinked attendees are real people Firefly captured but no contact exists for them yet — auto-create runs on each new meeting going forward."
        />
      </CompletenessGroup>

      <ConnectedUsersBar metric={c.connected_users} />
    </div>
  );
}

function CompletenessGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-text-muted mb-2">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function CompletenessBar({
  label, metric, unit, warningHint,
}: { label: string; metric: CompletenessMetric; unit: string; warningHint?: string }) {
  const pct = metric.percentage;
  const color =
    pct >= 90 ? '#22C55E' :
    pct >= 50 ? '#F59E0B' :
    '#EF4444';
  const showHint = pct < 90 && warningHint;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-text-primary tabular-nums font-medium" style={{ color }}>{pct}% {label}</span>
        <span className="text-text-muted">
          {metric.current.toLocaleString()} of {metric.total.toLocaleString()} {unit}
        </span>
      </div>
      <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: color,
            transition: 'width 600ms ease-out, background 400ms ease-out',
          }}
        />
      </div>
      {showHint && (
        <div className="text-[11px] text-text-muted mt-1">{warningHint}</div>
      )}
    </div>
  );
}

function ConnectedUsersBar({ metric }: { metric: CompletenessMetric & { names_missing: string[] } }) {
  const pct = metric.percentage;
  const color =
    pct >= 90 ? '#22C55E' :
    pct >= 50 ? '#F59E0B' :
    '#EF4444';
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Connected Users</div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-text-primary tabular-nums font-medium" style={{ color }}>
          {metric.current} of {metric.total} users have Outlook connected
        </span>
      </div>
      <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: color, transition: 'width 600ms ease-out' }}
        />
      </div>
      {metric.names_missing.length > 0 && (
        <div className="text-[11px] text-text-muted mt-1">
          Missing: {metric.names_missing.join(', ')}
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

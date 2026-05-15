'use client';

import React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, X as XIcon, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Users, Briefcase, Target, Sparkles, Mail, Clock, Loader2, User as UserIcon, Camera, Shield, LogOut, Trash2, Calendar, Mic, Lock, Unlock } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { ExpandableText } from '@/components/expandable-text';
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
  type WorkQueueInventoryEntry,
  type StuckWorkQueueEntry,
  type BudgetSnapshotRow,
  type DealReplayEvidenceRow,
  type MartyLabStatusSnapshot,
  type MartyLabRunSnapshot,
  type DealReplayStatusSnapshot,
} from '@/lib/api';
import { useBackgroundTasks } from '@/components/background-task-indicator';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;

type SettingsTab = 'profile' | 'security' | 'integrations' | 'approvals' | 'system' | 'marty-sandbox';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'system', label: 'System Status' },
  { id: 'marty-sandbox', label: 'MARTy Sandbox' },
  { id: 'integrations', label: 'Sync & Integrations' },
  { id: 'security', label: 'Security' },
  { id: 'approvals', label: 'Approval Queue' },
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

  React.useEffect(() => {
    if (activeTab !== 'integrations') return;
    if (typeof window === 'undefined') return;
    const hashTarget = window.location.hash.replace(/^#/, '');
    if (!['sync-integrations', 'live-outlook-sync', 'email-history-import', 'outlook-integration-refresh'].includes(hashTarget)) return;
    window.setTimeout(() => {
      document.getElementById(hashTarget)?.scrollIntoView({ block: 'start' });
    }, 80);
  }, [activeTab]);

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
        <div className="max-w-4xl px-4 md:px-8 overflow-x-auto scrollbar-hide">
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

      <div className={`p-4 md:p-8 w-full ${activeTab === 'marty-sandbox' ? 'max-w-[112rem]' : 'max-w-4xl'}`}>
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
        {activeTab === 'marty-sandbox' && <MartySandboxSection />}
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
    <div id="sync-integrations" className="space-y-6 scroll-mt-24">
      <div className="card">
        <div className="font-medium mb-4">Sync Behavior</div>
        <div className="space-y-3 text-sm">
          <Toggle label="Auto-approve sync" />
          <Toggle label="Re-ranker enabled" checked />
          <Toggle label="News feed enabled" checked />
          <Toggle label="LinkedIn enrichment enabled" checked />
        </div>
      </div>

      <EmailSyncSection outlook={status?.outlook ?? null} />

      <EmailHistoricalBackfillSection
        isOutlookConnected={status?.outlook?.status === 'connected' || status?.outlook?.status === 'auth_failed'}
        needsOutlookRefresh={status?.outlook?.status === 'auth_failed'}
      />

      <FireflyHistoricalBackfillSection />

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
              anchorId="outlook-integration-refresh"
              name="Microsoft Outlook 365"
              description="Email, calendar, and contacts via Microsoft Graph. Also used for campaign sends."
              row={status.outlook}
              onPrimaryClick={connectOutlook}
              primaryLabel={
                status.outlook.status === 'auth_failed' || status.outlook.token_healthy === false
                  ? 'Refresh'
                  : status.outlook.status === 'connected'
                    ? 'Reconnect'
                  : 'Connect'
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
];

function syncHistoryLabel(days: number): string {
  if (days <= 0 || days >= 3650) return 'All available email history';
  if (days >= 365) return `Last ${Math.round(days / 365)} year${Math.round(days / 365) === 1 ? '' : 's'}`;
  if (days >= 180) return 'Last 6 months';
  return `Last ${days} days`;
}

function connectionTone(row: IntegrationRow | null): {
  label: string;
  dot: string;
  bg: string;
  text: string;
  help: string;
} {
  if (!row) {
    return {
      label: 'Checking',
      dot: 'bg-text-muted',
      bg: 'bg-white/5',
      text: 'text-text-muted',
      help: 'Loading the latest sync status.',
    };
  }
  if (row.status === 'connected' && row.token_healthy !== false) {
    return {
      label: 'Connected',
      dot: 'bg-semantic-success',
      bg: 'bg-semantic-success/10',
      text: 'text-semantic-success',
      help: 'New email and calendar updates are syncing automatically.',
    };
  }
  if (row.status === 'auth_failed' || row.token_healthy === false) {
    return {
      label: 'Refresh needed',
      dot: 'bg-semantic-error',
      bg: 'bg-semantic-error/10',
      text: 'text-semantic-error',
      help: 'Live updates are paused while Outlook waits for a refresh. Use the Microsoft Outlook refresh button in Integrations below to resume email and calendar activity.',
    };
  }
  return {
    label: 'Not connected',
    dot: 'bg-text-muted',
    bg: 'bg-white/5',
    text: 'text-text-muted',
    help: 'Connect Microsoft Outlook to sync email and meetings into MARTy.',
  };
}

function BackfillStat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-bg-elevated/35 p-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-sm font-medium text-text-primary">{value}</div>
      {hint && <div className="mt-1 text-[10px] text-text-muted leading-snug">{hint}</div>}
    </div>
  );
}

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

function EmailSyncSection({ outlook }: { outlook: IntegrationRow | null }) {
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

  const tone = connectionTone(outlook);
  const isHealthy = outlook?.status === 'connected' && outlook.token_healthy !== false;
  const needsRefresh = outlook?.status === 'auth_failed' || outlook?.token_healthy === false;

  return (
    <div id="live-outlook-sync" className="card scroll-mt-24">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-accent-magenta" />
            <div className="font-medium">Live Outlook Sync</div>
          </div>
          <div className="text-xs text-text-secondary mt-1 max-w-2xl">
            Shows whether new Outlook email and calendar activity are flowing into Medina Intelligence right now.
            Historical imports below are separate, background catch-up jobs.
          </div>
        </div>
        <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${tone.bg} ${tone.text}`}>
          <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
          {tone.label}
        </div>
      </div>

      <div className={`rounded-lg border px-3 py-2 text-xs mb-4 ${
        isHealthy
          ? 'border-semantic-success/20 bg-semantic-success/5 text-text-secondary'
          : needsRefresh
          ? 'border-semantic-error/30 bg-semantic-error/10 text-text-secondary'
          : 'border-border/60 bg-white/5 text-text-secondary'
      }`}>
        {tone.help}
        {outlook?.last_sync && (
          <span className="block mt-1 text-text-muted">Last successful sync: {formatRelative(outlook.last_sync)}.</span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <BackfillStat
          label="Mailbox"
          value={outlook?.connected_email || (isHealthy ? 'Connected' : 'Not connected')}
          hint={outlook?.connected_email ? 'Connected Microsoft account' : 'Connect Outlook to identify the mailbox'}
        />
        <BackfillStat
          label="First-time import"
          value={configLoaded ? syncHistoryLabel(syncDays) : 'Loading...'}
          hint="Used the next time Outlook is connected for the first time"
        />
        <BackfillStat
          label="Live updates"
          value={isHealthy ? 'On' : 'Paused'}
          hint={isHealthy ? 'New mail and calendar changes keep flowing' : needsRefresh ? 'Refresh Outlook to resume automatic sync' : 'Connect Outlook to start automatic sync'}
        />
      </div>

      <div>
        <div className="text-xs text-text-muted mb-2">Default history for new Outlook connections</div>
        <div className="text-xs text-text-secondary mb-2 max-w-xl">
          Choose how much older email to pull the first time a mailbox connects. You can import more history later without keeping this page open.
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

function EmailHistoricalBackfillSection({
  isOutlookConnected,
  needsOutlookRefresh = false,
}: {
  isOutlookConnected: boolean;
  needsOutlookRefresh?: boolean;
}) {
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
      setToast('Email import started — first batch begins within 2 minutes');
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
      setToast('Email import cancelled');
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
  const completedBatches = summary?.windows_completed ?? windows.filter((w: any) => w.status === 'completed').length;
  const totalBatches = summary?.windows_total ?? windows.length;
  const percentComplete = totalBatches > 0 ? Math.round((completedBatches / totalBatches) * 100) : 0;
  const currentBatch = windows.find((w: any) => w.status === 'in_progress');

  return (
    <div id="email-history-import" className="card scroll-mt-24">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-accent-purple" />
            <div className="font-medium">Email History Import</div>
            {isActive && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold ml-1"
                style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>
                RUNNING
              </span>
            )}
          </div>
          <div className="text-xs text-text-secondary mt-1 max-w-2xl">
            Pulls older Outlook email and attachments into MARTy in the background. You can leave this page while it works.
          </div>
        </div>
      </div>

      {needsOutlookRefresh && (
        <div className="mb-4 rounded-lg border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-xs leading-5 text-text-secondary">
          Refresh Outlook in the Integrations section below before starting a catch-up import.
        </div>
      )}

      {isOwner && eligibleUsers.length > 1 && (
        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">Import for</div>
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
            No email history import is running. Start one when you need older Outlook conversations
            and attachments to become searchable by MARTy.
          </div>
          <div className="flex flex-wrap gap-2">
            {PROGRESSIVE_DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => { setDays(d); setConfirmOpen(true); }}
                disabled={loading || needsOutlookRefresh}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Clock size={13} /> Last {d} days
              </button>
            ))}
            <button
              onClick={() => setDateRangeOpen(true)}
              disabled={loading || needsOutlookRefresh}
              className="btn-secondary text-xs py-1.5 flex items-center gap-2"
            >
              <Calendar size={13} /> Custom Date Range
            </button>
          </div>
        </div>
      )}

      {(isActive || isDone || isCancelled) && summary && (
        <div className="space-y-3">
          <div className="rounded-lg border border-accent-purple/20 bg-accent-purple/5 p-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-text-primary font-medium">
                {isActive
                  ? `Importing older email for ${targetUserLabel}`
                  : isDone
                  ? 'Email history import complete'
                  : 'Email history import cancelled'}
              </div>
              <div className="text-xs text-text-muted">
                {percentComplete}% checked
                {isActive && summary.eta_seconds !== null && ` · about ${fmtDuration(summary.eta_seconds)} remaining`}
              </div>
            </div>
            <div className="mt-3 h-2 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent-magenta transition-all"
                style={{ width: `${Math.max(2, Math.min(100, percentComplete))}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-text-secondary">
              {completedBatches} of {totalBatches} date batches checked
              {currentBatch && <> · currently checking {new Date(currentBatch.start_date).toLocaleDateString()} to {new Date(currentBatch.end_date).toLocaleDateString()}</>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <BackfillStat label="Emails found" value={summary.emails_total.toLocaleString()} />
            <BackfillStat label="Attachments saved" value={summary.attachments_persisted.toLocaleString()} />
            <BackfillStat label="Running for" value={fmtDuration(summary.elapsed_seconds)} />
            <BackfillStat
              label="Import pace"
              value={summary.avg_window_seconds !== null ? `${fmtDuration(summary.avg_window_seconds)} / batch` : 'Warming up'}
              hint="Small batches protect Outlook and keep the app usable"
            />
          </div>

          {/* Small date-batch progress strip */}
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
                  title={`Batch ${w.window_index} (${range})\nstatus: ${w.status}\n${subtitle}${w.last_error ? '\n' + w.last_error : ''}`}
                  className={`h-2 w-6 rounded-sm border ${cls}`}
                />
              );
            })}
          </div>

          <div className="text-[10px] text-text-muted">
            {summary.attachments_failed > 0 && ` · ${summary.attachments_failed} attachment failures`}
            {summary.attachments_skipped > 0 && ` · ${summary.attachments_skipped} skipped`}
            {summary.emails_total === 0 && 'No email found yet. That can be normal until the first batch finishes.'}
          </div>

          <div className="flex items-center gap-2">
            {isActive && (
              <button
                onClick={cancelBackfill}
                disabled={loading}
                className="btn-ghost text-xs py-1.5 flex items-center gap-2 text-red-400 hover:text-red-300"
              >
                <XIcon size={13} /> Cancel import
              </button>
            )}
            {(isDone || isCancelled) && (
              <button
                onClick={() => setProgress(null)}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Clock size={13} /> Start a new import
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
            <div className="text-lg font-medium text-text-primary mb-2">Start email history import</div>
            <div className="text-sm text-text-secondary mb-4">
              Pull last <strong>{days}</strong> days of email for <strong>{targetUserLabel}</strong>.
              Runs in small background batches. No need to keep this tab open.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={loading || needsOutlookRefresh} onClick={() => startBackfill(days)}>
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
            setToast('Email import started');
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
          Imported in small background batches for <strong>{targetUserLabel}</strong>, newest first.
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
            {loading ? 'Starting...' : 'Start import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Fireflies Historical Backfill (progressive, server-side, cron-driven) ─
//
// Every member gets a self-service import lane backed by their own stored
// Fireflies API key. Owners can inspect/start imports for org members, but the
// selected member's credential state drives the controls so Tony's key is never
// implied to work for Alvaro.

// Phase 4 1c (2026-05-04): dropped 180 — backend MAX_BACKFILL_DAYS is now
// 120 (src/lib/firefly-progressive-backfill.ts); a 180-day request would
// be rejected. Custom Date Range is the escape hatch for >90-day windows
// up to the 120-day cap.
const FIREFLY_PROGRESSIVE_DAYS_OPTIONS: Array<30 | 60 | 90> = [30, 60, 90];

type FireflyCredentialStatus = {
  exists: boolean;
  user_id?: string;
  created_at?: string | null;
  rotation_count: number;
  last_used_at: string | null;
  updated_at: string | null;
};

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
  const [targetCredStatus, setTargetCredStatus] = React.useState<FireflyCredentialStatus | null>(null);
  const [days, setDays] = React.useState<30 | 60 | 90>(90);
  const [triggerOpen, setTriggerOpen] = React.useState(false);
  const [dateRangeOpen, setDateRangeOpen] = React.useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  // Phase 4 1c (2026-05-04): persistent credential state. Drives the
  // Credentials sub-section UI and the disabled-state of all backfill
  // buttons. Credential ownership is per-user; members can only manage their
  // own key, while owners can see target-key status without plaintext.
  const [credStatus, setCredStatus] = React.useState<FireflyCredentialStatus | null>(null);
  const [credLoading, setCredLoading] = React.useState(false);
  const [credInput, setCredInput] = React.useState('');
  const [credShowKey, setCredShowKey] = React.useState(false);
  const [credEditOpen, setCredEditOpen] = React.useState(false);
  const [credRevokeConfirmOpen, setCredRevokeConfirmOpen] = React.useState(false);

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
      setTargetCredStatus(r.credential_status ?? null);
    } catch {
      setProgress(null);
      setTargetCredStatus(null);
    }
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

  // Phase 4 1c: load persistent credential status on mount. Refresh after
  // any credential mutation (save/rotate/revoke) so the UI's enabled-state
  // and "rotated N times" text stay in sync.
  const fetchCredStatus = React.useCallback(async () => {
    try {
      const r = await api.getMyFireflyCredential();
      setCredStatus({
        exists: r.status.exists,
        user_id: r.status.user_id,
        created_at: r.status.created_at,
        rotation_count: r.status.rotation_count,
        last_used_at: r.status.last_used_at,
        updated_at: r.status.updated_at,
      });
    } catch { /* leave null — UI treats null as "loading" */ }
  }, []);
  React.useEffect(() => { fetchCredStatus(); }, [fetchCredStatus]);

  async function saveCredential() {
    const trimmed = credInput.trim();
    if (!trimmed) { setToast('API key is required'); return; }
    setCredLoading(true);
    try {
      const r = await api.storeMyFireflyCredential(trimmed);
      setCredInput('');
      setCredEditOpen(false);
      setToast(r.stored === 'created' ? 'API key saved' : 'API key rotated');
      await fetchCredStatus();
      await fetchProgress();
    } catch (e: any) {
      setToast(`Save failed: ${e?.message || 'unknown'}`);
    }
    setCredLoading(false);
  }

  async function revokeCredential() {
    setCredLoading(true);
    setCredRevokeConfirmOpen(false);
    try {
      await api.revokeMyFireflyCredential();
      setToast('API key revoked');
      await fetchCredStatus();
      await fetchProgress();
    } catch (e: any) {
      setToast(`Revoke failed: ${e?.message || 'unknown'}`);
    }
    setCredLoading(false);
  }

  // Phase 4 1c: fireflies_api_key is no longer collected per-trigger.
  // Backend driver resolves the persistent credential row written by
  // saveCredential above. Buttons disable when the selected member has no
  // stored credential.
  async function startDaysBackfill(daysBack: 30 | 60 | 90) {
    if (!selectedUserId) return;
    setLoading(true);
    try {
      await api.startFireflyProgressiveBackfill({
        user_id: selectedUserId,
        days_back: daysBack,
      });
      setTriggerOpen(false);
      setToast('Meeting import started — first batch begins within 60 seconds');
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
      setToast('Meeting import cancelled');
      fetchProgress();
    } catch (e: any) {
      setToast(`Cancel failed: ${e?.message || 'unknown'}`);
    }
    setLoading(false);
  }

  const selectedIsSelf = selectedUserId === me?.id;
  const selectedUser = eligibleUsers.find(u => u.id === selectedUserId);
  const selectedName = selectedIsSelf
    ? 'you'
    : (selectedUser?.full_name || selectedUser?.email || 'this member');
  const targetCredentialStatus = selectedIsSelf ? credStatus : targetCredStatus;
  const credentialCheckLoading = selectedIsSelf ? credStatus === null : targetCredStatus === null;
  const selectedHasCredential = targetCredentialStatus?.exists === true;
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
    : (selectedUser?.full_name || selectedUser?.email || 'this member');
  const percentComplete = totalWindows > 0 ? Math.round((completedCount / totalWindows) * 100) : 0;
  const currentBatch = windows.find((w: any) => w.status === 'in_progress');

  return (
    <div className="card">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Mic size={16} className="text-accent-purple" />
            <div className="font-medium">Meeting Transcript Import</div>
            {isActive && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold ml-1"
                style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>
                RUNNING
              </span>
            )}
          </div>
          <div className="text-xs text-text-secondary mt-1 max-w-2xl">
            Pulls older Fireflies transcripts into Medina Intelligence so MARTy can search and summarize past meetings.
          </div>
        </div>
      </div>

      {eligibleUsers.length > 1 && (
        <div className="mb-4">
          <div className="text-xs text-text-muted mb-1">Import for</div>
          <select
            value={selectedUserId ?? ''}
            onChange={e => {
              setSelectedUserId(e.target.value);
              setCredEditOpen(false);
              setCredInput('');
            }}
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

      {/* Phase 4 1c (2026-05-04): Credentials sub-section. Folded INTO
          this card so the API key + the buttons that need it live
          together, eliminating the prior dual-source-of-truth UX
          (modals asking for a key the backend already has). */}
      <div className="mb-4 rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            {selectedIsSelf ? 'Your Fireflies API key' : `${selectedName}'s Fireflies API key`}
          </div>
          {selectedHasCredential && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{ background: 'rgba(34,197,94,0.15)', color: '#86EFAC' }}>
              SAVED
            </span>
          )}
        </div>
        {credentialCheckLoading ? (
          <div className="text-xs text-text-muted">Checking credential…</div>
        ) : selectedHasCredential ? (
          <div>
            <div className="text-xs text-text-secondary">
              {selectedIsSelf
                ? (credStatus?.rotation_count && credStatus.rotation_count > 0
                  ? `Rotated ${credStatus.rotation_count}x since first set.`
                  : 'Stored, encrypted at rest, and used automatically by your meeting imports.')
                : `Stored for ${selectedName}. Imports for this member use their own saved credential.`}
              {targetCredentialStatus?.last_used_at && (
                <> Last used {new Date(targetCredentialStatus.last_used_at).toISOString().slice(0, 10)}.</>
              )}
            </div>
            {selectedIsSelf ? (
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setCredInput(''); setCredEditOpen(true); }}
                  disabled={credLoading}
                  className="btn-ghost text-xs py-1.5"
                >
                  Rotate
                </button>
                <button
                  onClick={() => setCredRevokeConfirmOpen(true)}
                  disabled={credLoading}
                  className="btn-ghost text-xs py-1.5 text-red-400 hover:text-red-300"
                >
                  Revoke
                </button>
              </div>
            ) : (
              <div className="mt-2 text-xs text-text-muted">
                Only this member can rotate or revoke their own key from their account.
              </div>
            )}
          </div>
        ) : !selectedIsSelf ? (
          <div className="text-xs text-text-secondary">
            {selectedName} needs to save their Fireflies API key from their own account before meeting transcripts can be imported for them.
          </div>
        ) : (
          <div>
            <div className="text-xs text-text-secondary mb-2">
              Set once and reuse for every meeting import. Encrypted at rest (AES-256-GCM); plaintext
              never returned by any API. Get yours at <span className="text-text-primary">app.fireflies.ai → Settings → Developer settings</span>.
            </div>
            {credEditOpen ? (
              <div>
                <div className="flex gap-2">
                  <input
                    type={credShowKey ? 'text' : 'password'}
                    value={credInput}
                    onChange={e => setCredInput(e.target.value)}
                    placeholder="paste here"
                    className="input text-sm py-1.5 px-3 flex-1 font-mono"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setCredShowKey(s => !s)}
                    className="btn-ghost text-xs py-1.5 px-3"
                  >
                    {credShowKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={saveCredential} disabled={credLoading} className="btn-primary text-xs py-1.5">
                    {credLoading ? 'Saving…' : 'Save key'}
                  </button>
                  <button onClick={() => { setCredEditOpen(false); setCredInput(''); }} disabled={credLoading} className="btn-ghost text-xs py-1.5">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setCredInput(''); setCredEditOpen(true); }}
                className="btn-primary text-xs py-1.5"
              >
                Set up API key
              </button>
            )}
          </div>
        )}
      </div>

      {/* Rotate flow when credential already exists — shows the same input
          but submits as a rotation rather than a fresh save. */}
      {selectedIsSelf && credEditOpen && credStatus?.exists && (
        <div className="mb-4 rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(139,92,246,0.3)' }}>
          <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Rotate API key</div>
          <div className="flex gap-2">
            <input
              type={credShowKey ? 'text' : 'password'}
              value={credInput}
              onChange={e => setCredInput(e.target.value)}
              placeholder="paste new key"
              className="input text-sm py-1.5 px-3 flex-1 font-mono"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setCredShowKey(s => !s)}
              className="btn-ghost text-xs py-1.5 px-3"
            >
              {credShowKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="flex gap-2 mt-2">
            <button onClick={saveCredential} disabled={credLoading} className="btn-primary text-xs py-1.5">
              {credLoading ? 'Rotating…' : 'Rotate'}
            </button>
            <button onClick={() => { setCredEditOpen(false); setCredInput(''); }} disabled={credLoading} className="btn-ghost text-xs py-1.5">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isIdle && (
        <div>
          <div className="text-xs text-text-secondary mb-3">
            No meeting history import is running. Start one to recover older Fireflies transcripts
            in the background without keeping this page open.
            {!selectedHasCredential && (
              <span className="block mt-1 text-text-muted">
                {selectedIsSelf
                  ? 'Save your API key above to enable meeting imports.'
                  : `${selectedName} needs to save their Fireflies API key before an import can start.`}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {FIREFLY_PROGRESSIVE_DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => { setDays(d); setTriggerOpen(true); }}
                disabled={loading || !selectedHasCredential}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Mic size={13} /> Last {d} days
              </button>
            ))}
            <button
              onClick={() => setDateRangeOpen(true)}
              disabled={loading || !selectedHasCredential}
              className="btn-secondary text-xs py-1.5 flex items-center gap-2"
            >
              <Calendar size={13} /> Custom Date Range
            </button>
          </div>
        </div>
      )}

      {(isActive || isDone || isCancelled) && (
        <div className="space-y-3">
          <div className="rounded-lg border border-accent-purple/20 bg-accent-purple/5 p-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-text-primary font-medium">
                {isActive
                  ? `Importing older meeting transcripts for ${targetUserLabel}`
                  : isDone
                  ? 'Meeting transcript import complete'
                  : 'Meeting transcript import cancelled'}
              </div>
              <div className="text-xs text-text-muted">{percentComplete}% checked</div>
            </div>
            <div className="mt-3 h-2 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-accent-magenta transition-all"
                style={{ width: `${Math.max(2, Math.min(100, percentComplete))}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-text-secondary">
              {completedCount} of {totalWindows} date batches checked
              {currentBatch && <> · currently checking {new Date(currentBatch.start_date).toLocaleDateString()} to {new Date(currentBatch.end_date).toLocaleDateString()}</>}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <BackfillStat label="Transcripts saved" value={counters.persisted.toLocaleString()} />
            <BackfillStat label="Already had" value={counters.duplicate.toLocaleString()} hint="Skipped because they were already imported" />
            <BackfillStat label="Problems" value={counters.failed.toLocaleString()} />
            <BackfillStat label="Batches checked" value={`${completedCount} / ${totalWindows || 0}`} hint="Small batches protect Fireflies and keep the app usable" />
          </div>

          {/* Small date-batch progress strip. */}
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
                  title={`Batch ${w.window_index} (${range})\nstatus: ${w.status}\n${subtitle}${w.last_error ? '\n' + w.last_error : ''}`}
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
                <XIcon size={13} /> Cancel import
              </button>
            )}
            {(isDone || isCancelled) && (
              <button
                onClick={() => setProgress(null)}
                className="btn-secondary text-xs py-1.5 flex items-center gap-2"
              >
                <Mic size={13} /> Start a new import
              </button>
            )}
          </div>
        </div>
      )}

      {/* Trigger modals — Phase 4 1c: API key is resolved server-side from
          the persistent credential row. Modals are now confirmation-only;
          neither collects a key. */}
      {triggerOpen && (
        <FireflyTriggerModal
          days={days}
          targetUserLabel={targetUserLabel}
          loading={loading}
          onClose={() => setTriggerOpen(false)}
          onSubmit={() => startDaysBackfill(days)}
        />
      )}

      {dateRangeOpen && (
        <FireflyDateRangeModal
          targetUserId={selectedUserId ?? undefined}
          targetUserLabel={targetUserLabel}
          onClose={() => setDateRangeOpen(false)}
          onStarted={() => {
            setDateRangeOpen(false);
            setToast('Meeting import started');
            fetchProgress();
          }}
        />
      )}

      {credRevokeConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setCredRevokeConfirmOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Revoke saved API key?</div>
            <div className="text-sm text-text-secondary mb-4">
              The encrypted key will be deleted from the server. Future meeting imports will
              be disabled until you save a new key. Already-ingested transcripts are
              kept. Any in-flight import will stop at its next batch.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setCredRevokeConfirmOpen(false)}>Keep saved</button>
              <button className="btn-primary" disabled={credLoading}
                style={{ background: '#DC2626', borderColor: '#DC2626' }}
                onClick={revokeCredential}>
                {credLoading ? 'Revoking…' : 'Revoke key'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setCancelConfirmOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Cancel the meeting import?</div>
            <div className="text-sm text-text-secondary mb-4">
              Transcripts already ingested will be kept. Pending and in-progress
              pending batches will be stopped. Your saved API key stays put — you
              can start a new import any time without re-entering it.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setCancelConfirmOpen(false)}>Keep running</button>
              <button className="btn-primary" disabled={loading}
                style={{ background: '#DC2626', borderColor: '#DC2626' }}
                onClick={cancelBackfill}>
                {loading ? 'Cancelling...' : 'Cancel import'}
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

// Phase 4 1c (2026-05-04): API key input removed — backend resolves the
// persistent credential row from user_firefly_credentials. Modal is now
// purely a confirmation surface so the user gets one explicit "yes start
// it" beat before committing the windowed work.
function FireflyTriggerModal({
  days,
  targetUserLabel,
  loading,
  onClose,
  onSubmit,
}: {
  days: 30 | 60 | 90;
  targetUserLabel: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}>
      <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={e => e.stopPropagation()}>
        <div className="text-lg font-medium text-text-primary mb-2">Start meeting transcript import</div>
        <div className="text-sm text-text-secondary mb-4">
          Pull last <strong>{days}</strong> days of meetings for <strong>{targetUserLabel}</strong>.
          Runs in small background batches. No need to keep this tab open.
        </div>
        <div className="text-xs text-text-muted mb-4">
          Uses the saved Fireflies API key — no need to re-enter it.
        </div>
        <div className="flex justify-end gap-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={loading} onClick={onSubmit}>
            {loading ? 'Starting...' : 'Start import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Phase 4 1c (2026-05-04): API key input removed — backend resolves the
// persistent credential row from user_firefly_credentials.
// Phase 4 follow-up (2026-05-04): mirrors backend MAX_BACKFILL_DAYS in
// src/lib/firefly-progressive-backfill.ts. Keep these in sync — the
// backend cap is the source of truth; this client constant exists so
// the UI can clamp before submit instead of surfacing a generic 409.
const FIREFLY_MAX_BACKFILL_DAYS = 120;

// Auto-clamp helpers. Both inputs use yyyy-mm-dd strings (the native
// shape of <input type="date">), so we work in that space without going
// through Date objects for arithmetic — UTC date strings + day offsets
// dodge timezone surprises around DST boundaries.
function shiftDateString(yyyymmdd: string, deltaDays: number): string {
  const ms = Date.parse(yyyymmdd + 'T00:00:00Z');
  if (isNaN(ms)) return '';
  return new Date(ms + deltaDays * 86400000).toISOString().slice(0, 10);
}
function spanDays(startYmd: string, endYmd: string): number {
  const a = Date.parse(startYmd + 'T00:00:00Z');
  const b = Date.parse(endYmd + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.ceil((b - a) / 86400000);
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
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [clampedToast, setClampedToast] = React.useState<string | null>(null);

  // Phase 4 follow-up: mirror backend's 120-day cap as an HTML5 input
  // constraint AND an explicit auto-clamp on change. The HTML max/min
  // attributes give immediate visual blocking on the date picker; the
  // useEffect-style onChange handlers handle paste/keyboard entry that
  // skirts the picker. Auto-clamp instead of validate-only per Lucas
  // 2026-05-04 — friction-free UX, no resubmit cycle.
  const endMaxFromStart = startDate ? shiftDateString(startDate, FIREFLY_MAX_BACKFILL_DAYS) : undefined;
  const startMinFromEnd = endDate ? shiftDateString(endDate, -FIREFLY_MAX_BACKFILL_DAYS) : undefined;

  function showClampedToast(msg: string) {
    setClampedToast(msg);
    window.setTimeout(() => setClampedToast(null), 2500);
  }

  function onStartDateChange(next: string) {
    setStartDate(next);
    // If existing end_date now puts us beyond the cap, pull end_date
    // back to start + 120 days. User sees the clamp visibly + toast.
    if (next && endDate && spanDays(next, endDate) > FIREFLY_MAX_BACKFILL_DAYS) {
      const clamped = shiftDateString(next, FIREFLY_MAX_BACKFILL_DAYS);
      setEndDate(clamped);
      showClampedToast(`End date adjusted to maximum ${FIREFLY_MAX_BACKFILL_DAYS}-day window`);
    }
  }
  function onEndDateChange(next: string) {
    setEndDate(next);
    if (next && startDate && spanDays(startDate, next) > FIREFLY_MAX_BACKFILL_DAYS) {
      const clamped = shiftDateString(next, -FIREFLY_MAX_BACKFILL_DAYS);
      setStartDate(clamped);
      showClampedToast(`Start date adjusted to maximum ${FIREFLY_MAX_BACKFILL_DAYS}-day window`);
    }
  }

  async function submit() {
    setError(null);
    if (!startDate || !endDate) { setError('Both dates are required'); return; }
    if (!targetUserId) { setError('No target user selected'); return; }
    // Defense in depth — auto-clamp covers the picker path; this catches
    // any clamp bypass (paste, devtools, racy state) before hitting the
    // 409 round-trip.
    if (spanDays(startDate, endDate) > FIREFLY_MAX_BACKFILL_DAYS) {
      setError(`Date range cannot exceed ${FIREFLY_MAX_BACKFILL_DAYS} days. Adjust the start or end date.`);
      return;
    }
    setLoading(true);
    try {
      await api.startFireflyProgressiveBackfill({
        user_id: targetUserId,
        start_date: new Date(startDate).toISOString(),
        end_date: new Date(endDate).toISOString(),
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
          Imported in small background batches for <strong>{targetUserLabel}</strong>, newest first.
        </div>
        <div className="space-y-3 mb-4">
          <div>
            <div className="text-xs text-text-muted mb-1">Start date</div>
            <input
              type="date"
              value={startDate}
              min={startMinFromEnd}
              onChange={e => onStartDateChange(e.target.value)}
              className="input text-sm w-full"
            />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">End date</div>
            <input
              type="date"
              value={endDate}
              max={endMaxFromStart}
              onChange={e => onEndDateChange(e.target.value)}
              className="input text-sm w-full"
            />
          </div>
          <div className="text-[10px] text-text-muted">
            Maximum {FIREFLY_MAX_BACKFILL_DAYS} days per import — split longer pulls into
            multiple requests.
          </div>
        </div>
        <div className="text-xs text-text-muted mb-4">
          Uses the saved Fireflies API key — no need to re-enter it.
        </div>
        {clampedToast && (
          <div className="text-xs text-amber-300 mb-3"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', padding: '6px 10px', borderRadius: '6px' }}>
            {clampedToast}
          </div>
        )}
        {error && <div className="text-xs text-red-400 mb-3">{error}</div>}
        <div className="flex justify-end gap-3">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={loading} onClick={submit}>
            {loading ? 'Starting...' : 'Start import'}
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
  // Q11 — held DELETION proposals. Backend overload of the same
  // endpoints with is_deletion=true; frontend uses a separate API
  // helper for clarity at the call site.
  async function approveHeldDeletion(entityType: string, entityId: string, fieldName: string) {
    try {
      await api.approveHeldDeletion(entityType, entityId, fieldName);
      load();
      setToast('Field cleared');
    } catch { setToast('Failed'); }
  }
  async function dismissHeldDeletion(entityType: string, entityId: string, fieldName: string) {
    try {
      await api.dismissHeldDeletion(entityType, entityId, fieldName);
      load();
      setToast('Deletion dismissed');
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
                          // Q11 — deletion held proposal renders the
                          // proposed-cell as "(clear this field)"
                          // instead of a value swap.
                          const isDeletion = h.is_deletion === true;
                          const proposedDisplay = isDeletion ? '' : cleanValue(h.value);
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
                              {isDeletion ? (
                                <span className="text-rose-400/85 italic truncate" title="A channel is proposing this field be cleared">
                                  clear this field
                                </span>
                              ) : isUrl ? (
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
                                  onClick={() => isDeletion
                                    ? approveHeldDeletion(entity.entity_type, entity.entity_id, h.field_name)
                                    : approveHeld(entity.entity_type, entity.entity_id, h.field_name, h.value)}
                                  className="w-6 h-6 rounded flex items-center justify-center hover:bg-green-500/20 transition-colors"
                                  style={{ background: 'rgba(34,197,94,0.06)' }}
                                  title={isDeletion
                                    ? 'Clear this field (commits as human edit, resets corroboration)'
                                    : 'Approve this held value (commits as human edit, resets corroboration)'}
                                >
                                  <Check size={11} className="text-green-400/80" />
                                </button>
                                <button
                                  onClick={() => isDeletion
                                    ? dismissHeldDeletion(entity.entity_type, entity.entity_id, h.field_name)
                                    : dismissHeld(entity.entity_type, entity.entity_id, h.field_name, h.value)}
                                  className="w-6 h-6 rounded flex items-center justify-center hover:bg-red-500/20 transition-colors"
                                  style={{ background: 'rgba(255,255,255,0.03)' }}
                                  title={isDeletion
                                    ? 'Dismiss (90-day no-re-ask on deletion of this field)'
                                    : 'Dismiss (90-day no-re-ask on this value)'}
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
    case 'not_connected':
      return 'text-semantic-error';
    case 'not_configured':
    default:
      return 'text-text-muted';
  }
}

function IntegrationRowView({
  anchorId,
  name,
  description,
  row,
  primaryLabel,
  onPrimaryClick,
  primaryDisabled,
}: {
  anchorId?: string;
  name: string;
  description: string;
  row: IntegrationRow;
  primaryLabel: string | null;
  onPrimaryClick?: () => void;
  primaryDisabled?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const rateLimitColor =
    row.status === 'auth_failed' || row.rate_limit_status === 'auth_failed'
      ? 'text-semantic-error'
      : row.rate_limit_status === 'rate_limited'
        ? 'text-semantic-warning'
        : '';

  return (
    <div id={anchorId} className="flex scroll-mt-28 items-start justify-between py-4 border-b border-border/50 last:border-0 gap-4">
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
          {row.status === 'connected' && row.token_healthy !== false && (
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
  { q: 'How to import past meeting transcripts', a: <>Scroll up to the "Meeting Transcript Import" card. Pick Last 30 / 60 / 90 days or a custom date range, save your Fireflies API key, and click Start. The import runs in the background and survives page refreshes.</> },
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
        <li>Copy your <span className="text-text-primary">API Key</span> (you'll need this for meeting transcript imports)</li>
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
      <RateLimitIndicator budgets={data.budgets || []} />
      <ActiveTasksCard tasks={data.active_tasks} />
      <RunHistoryCard rows={data.run_history} />
      <DataCompletenessCard c={data.completeness} />
      <WorkQueueCard
        inventory={data.work_queue_inventory}
        stuck={data.stuck_work_queue}
      />
      <DealReplayStatusCard replay={data.deal_replay || emptyDealReplay} onRefresh={load} />
    </div>
  );
}

function MartySandboxSection() {
  const [data, setData] = React.useState<SystemStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api.getSettingsSystemStatus().then(setData).catch(e => setError(e?.message || 'Failed to load MARTy Sandbox'));
  }, []);

  React.useEffect(() => {
    load();
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
    return <div className="card p-6 text-sm text-text-muted">Loading MARTy Sandbox...</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="text-xl font-semibold text-text-primary">MARTy Sandbox</div>
        <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-muted">
          A controlled experiment studio for testing one MARTy improvement at a time. Each experiment runs discovery, applies one candidate upgrade, tests it, then waits for Ship or Reject.
        </div>
      </div>
      <MartyLabStatusCard lab={data.marty_lab || emptyMartyLab} onRefresh={load} />
    </div>
  );
}

const emptyMartyLab: MartyLabStatusSnapshot = {
  run: null,
  recent_runs: [],
  queued_runs: [],
  experiments: [],
  upgrade_candidates: [],
  versions: [],
  upgrade_trials: [],
  deep_work_items: [],
  code_patch_jobs: [],
  readiness: {
    ok: false,
    harness_version: 'unknown',
    generated_at: new Date().toISOString(),
    blockers: ['Readiness has not loaded yet.'],
    warnings: [],
    checks: [],
  },
  generated_at: new Date().toISOString(),
};

const emptyDealReplay: DealReplayStatusSnapshot = {
  run: null,
  queue: { pending: 0, in_progress: 0, completed: 0, failed: 0, dead_letter: 0 },
  generated_at: new Date().toISOString(),
};

function ReplayMetric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const color = tone === 'good'
    ? 'text-semantic-success'
    : tone === 'warn'
      ? 'text-semantic-warning'
      : tone === 'bad'
        ? 'text-semantic-error'
        : 'text-text-primary';
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.025] px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function ReplayStatusPill({ status }: { status: NonNullable<DealReplayStatusSnapshot['run']>['status'] }) {
  const cfg = {
    running: { label: 'Running', cls: 'bg-accent-magenta/15 text-accent-magenta' },
    completed: { label: 'Completed', cls: 'bg-semantic-success/15 text-semantic-success' },
    cancelled: { label: 'Cancelled', cls: 'bg-semantic-warning/15 text-semantic-warning' },
    failed: { label: 'Failed', cls: 'bg-semantic-error/15 text-semantic-error' },
  }[status];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.cls}`}>{cfg.label}</span>;
}

function MartyLabStatusPill({ status }: { status: string }) {
  const pretty = status.replace(/_/g, ' ');
  const cfg = status === 'running' || status === 'queued' || status === 'sandbox_applied' || status === 'pending'
    ? { cls: 'bg-accent-purple/15 text-accent-purple', label: status === 'sandbox_applied' ? 'Sandbox applied' : status.charAt(0).toUpperCase() + status.slice(1) }
    : status === 'completed' || status === 'graded' || status === 'validated' || status === 'accepted'
      ? { cls: 'bg-semantic-success/15 text-semantic-success', label: status.charAt(0).toUpperCase() + status.slice(1) }
    : status === 'blocked' || status === 'failed' || status === 'rejected'
        ? { cls: 'bg-semantic-error/15 text-semantic-error', label: status.charAt(0).toUpperCase() + status.slice(1) }
        : status === 'cancelled' || status === 'inconclusive'
          ? { cls: 'bg-semantic-warning/15 text-semantic-warning', label: status.charAt(0).toUpperCase() + status.slice(1) }
        : { cls: 'bg-white/[0.06] text-text-muted', label: status.charAt(0).toUpperCase() + status.slice(1) };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${cfg.cls}`}>{cfg.label.replace(/_/g, ' ') || pretty}</span>;
}

function formatLabScore(score: number | null | undefined): string {
  return typeof score === 'number' ? `${Math.round(score)}/100` : '—';
}

function formatLabList(values: string[] | undefined, fallback = 'None recorded yet'): string {
  if (!values || values.length === 0) return fallback;
  return values.slice(0, 3).join(' · ');
}

function formatLabNote(value: Record<string, unknown>): string {
  const title = value.title || value.label || value.dimension || value.type;
  const body = value.body || value.message || value.note || value.summary || value.text;
  if (title && body) return `${String(title)}: ${String(body)}`;
  if (body) return String(body);
  return JSON.stringify(value);
}

function labSummaryText(summary: Record<string, unknown> | null | undefined): string | null {
  if (!summary) return null;
  const conclusion = summary.conclusion || summary.current_phase || summary.message;
  return conclusion ? String(conclusion) : null;
}

function labEvidenceList(evidence: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = evidence?.[key];
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

type MartyLabExperimentRow = MartyLabStatusSnapshot['experiments'][number];
type MartyLabTrialRow = MartyLabStatusSnapshot['upgrade_trials'][number];
type MartyLabDeepWorkItemRow = MartyLabStatusSnapshot['deep_work_items'][number];
type MartyLabCodePatchJobRow = MartyLabStatusSnapshot['code_patch_jobs'][number];

function labRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function titleizeLabValue(value: unknown, fallback = 'Unknown'): string {
  const raw = String(value || fallback).replace(/_/g, ' ');
  return raw.replace(/\b\w/g, c => c.toUpperCase());
}

function labNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function labReadableEvidence(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const text = value.map(item => labReadableEvidence(item)).filter(Boolean).join('\n');
    return text || null;
  }
  const record = labRecord(value);
  if (record) {
    const lines = Object.entries(record)
      .slice(0, 8)
      .map(([key, item]) => {
        const text = labReadableEvidence(item);
        return text ? `${titleizeLabValue(key)}: ${text}` : null;
      })
      .filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}

function labDeepWorkBody(item: MartyLabDeepWorkItemRow): string {
  const evidence = labRecord(item.evidence) || {};
  const keys = [
    'recommended_implementation',
    'implementation',
    'why_it_matters',
    'why_it_matters_for_user_experience',
    'evidence_summary',
    'summary',
    'recommendation',
    'acceptance_tests',
    'root_cause',
  ];
  const parts = keys
    .map(key => labReadableEvidence(evidence[key]))
    .filter(Boolean) as string[];
  if (parts.length > 0) return Array.from(new Set(parts)).join('\n\n');
  return item.lever_ids.length > 0
    ? `Candidate levers: ${item.lever_ids.join(', ')}`
    : `Cluster: ${item.cluster_key}`;
}

function labCodePatchStatusLabel(status: MartyLabCodePatchJobRow['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'planning':
      return 'Writing patch brief';
    case 'ready_for_agent':
      return 'Ready for isolated agent';
    case 'in_agent_worktree':
      return 'In isolated worktree';
    case 'ready_for_review':
      return 'Ready for review';
    case 'validated':
      return 'Validated';
    case 'rejected':
      return 'Rejected';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return titleizeLabValue(status);
  }
}

function labCodePatchBody(job: MartyLabCodePatchJobRow): string {
  const patchScope = labRecord(job.patch_scope) || {};
  const validationPlan = labRecord(job.validation_plan) || {};
  const evidence = labRecord(job.evidence) || {};
  const brief = labRecord(patchScope.agent_brief)
    || labRecord(evidence.planning_output)
    || null;
  const parts = [
    brief?.summary ? `Summary: ${String(brief.summary)}` : null,
    brief?.patch_plan ? `Patch plan: ${labReadableEvidence(brief.patch_plan)}` : null,
    patchScope.recommended_files ? `Suggested files: ${labReadableEvidence(patchScope.recommended_files)}` : null,
    validationPlan.human_like_prompts ? `Human-like prompts: ${labReadableEvidence(validationPlan.human_like_prompts)}` : null,
    validationPlan.acceptance_tests ? `Acceptance tests: ${labReadableEvidence(validationPlan.acceptance_tests)}` : null,
  ].filter(Boolean) as string[];
  return parts.length > 0
    ? parts.join('\n\n')
    : 'This lane prepares an isolated code patch brief. It does not ship or deploy MARTy by itself.';
}

function labFailureClusterBody(cluster: Record<string, unknown>): string {
  return labReadableEvidence({
    failed_gate: cluster.failed_gate || cluster.failure_type,
    reason: cluster.reason || cluster.summary || cluster.note,
    affected_samples: cluster.count,
    suggested_next_step: cluster.suggested_next_step || cluster.recommendation,
  }) || 'Needs diagnosis before it can become a shippable upgrade.';
}

function labRoundPolicy(exp: MartyLabExperimentRow): { round: number; role: 'discovery' | 'validation' | 'global_guardrail'; sample: number } | null {
  const meta = labRecord(exp.followup_policy?.lab_round);
  if (!meta) return null;
  const role = meta.sample_role === 'discovery' || meta.sample_role === 'validation' || meta.sample_role === 'global_guardrail'
    ? meta.sample_role
    : null;
  const round = labNumber(meta.round_index, 0);
  const sample = labNumber(meta.sample_index, 1);
  return role && round > 0 ? { round, role, sample: sample > 0 ? sample : 1 } : null;
}

function labConversationRoleLabel(exp: MartyLabExperimentRow): string {
  const meta = labRoundPolicy(exp);
  if (!meta) return exp.variable_under_test ? 'Validation sample' : 'Discovery sample';
  if (meta.role === 'discovery') return `Round ${meta.round} discovery`;
  if (meta.role === 'global_guardrail') return `Round ${meta.round} golden ${meta.sample}`;
  return `Round ${meta.round} validation ${Math.max(1, meta.sample - 3)}/7`;
}

function labCurrentRound(
  run: MartyLabStatusSnapshot['run'],
  experiments: MartyLabExperimentRow[],
  fallbackTotal: number
): number {
  const fromSummary = labNumber(run?.summary?.current_round, 0);
  if (fromSummary > 0) return Math.min(fromSummary, fallbackTotal);
  const highestSeededRound = experiments.reduce((max, exp) => {
    const meta = labRoundPolicy(exp);
    return meta ? Math.max(max, meta.round) : max;
  }, 0);
  return highestSeededRound > 0 ? Math.min(highestSeededRound, fallbackTotal) : 1;
}

function labTrialDecisionText(trial: MartyLabTrialRow | null): string {
  if (!trial) return 'No controlled trial has been created yet.';
  const local = labRecord(trial.evidence?.local_validation);
  const global = labRecord(trial.evidence?.global_guardrail);
  const localSummary = labRecord(local?.summary);
  const globalSummary = labRecord(global?.summary);
  if (globalSummary) {
    return `Global guardrail · ${Number(globalSummary.wins || 0)}W/${Number(globalSummary.losses || 0)}L · ${titleizeLabValue(global?.decision || trial.status)}`;
  }
  if (localSummary) {
    return `Local validation · ${Number(localSummary.wins || 0)}W/${Number(localSummary.losses || 0)}L · ${titleizeLabValue(local?.decision || 'pending global')}`;
  }
  const pct = trial.valid_sample_size > 0 ? Math.round((trial.wins / trial.valid_sample_size) * 100) : null;
  const passLabel = trial.status === 'accepted'
    ? `${trial.wins}/${trial.valid_sample_size} clean measured wins (${pct ?? 0}%)`
    : trial.status === 'rejected'
      ? `${trial.wins}/${trial.valid_sample_size} clean measured wins`
      : trial.status === 'inconclusive'
        ? 'Inconclusive sample or regression guardrail'
        : 'Validation in progress';
  return `${titleizeLabValue(trial.status)} · ${passLabel}`;
}

function labTrialRoundIndex(trial: MartyLabTrialRow | null): number {
  const evidence = labRecord(trial?.evidence);
  return labNumber(evidence?.round_index, 0);
}

type MartyLabExperimentPage = {
  round: number;
  title: string;
  trial: MartyLabTrialRow | null;
  samples: MartyLabExperimentRow[];
};

const MARTY_LAB_UI_ROUND_SAMPLE_SIZE = 10;

function buildMartyLabExperimentPages(
  experiments: MartyLabExperimentRow[],
  trials: MartyLabTrialRow[]
): MartyLabExperimentPage[] {
  const byRound = new Map<number, MartyLabExperimentRow[]>();
  for (const exp of experiments) {
    const meta = labRoundPolicy(exp);
    if (!meta?.round) continue;
    if (meta.role === 'validation' && meta.sample > MARTY_LAB_UI_ROUND_SAMPLE_SIZE) continue;
    byRound.set(meta.round, [...(byRound.get(meta.round) || []), exp]);
  }
  return Array.from(byRound.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, samples]) => {
      const orderedSamples = [...samples].sort((a, b) => {
        const aMeta = labRoundPolicy(a);
        const bMeta = labRoundPolicy(b);
        return (aMeta?.sample || 0) - (bMeta?.sample || 0);
      });
      const trial = trials.find(item => labTrialRoundIndex(item) === round)
        || trials.find(item => orderedSamples.some(sample => sample.replicate_group === item.id))
        || null;
      return {
        round,
        trial,
        samples: orderedSamples,
        title: trial?.title || orderedSamples[0]?.variable_under_test || `Experiment ${round}`,
      };
    });
}

function labDeltaText(delta: number | null): string {
  if (delta === null) return 'Pending';
  return `${delta > 0 ? '+' : ''}${Math.round(delta)}`;
}

function labFriendlyOutcomeNote(note: string | null | undefined): string {
  const text = String(note || '').trim();
  if (!text) return 'No observation recorded yet.';
  if (/^[a-z0-9_]+$/i.test(text)) return titleizeLabValue(text);
  return text.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/gi, match => titleizeLabValue(match).toLowerCase());
}

function labExperimentOutcome(exp: MartyLabExperimentRow): { label: string; tone: 'good' | 'bad' | 'warn' | 'muted'; note: string } {
  const meta = labRoundPolicy(exp);
  const isDiscovery = meta?.role === 'discovery';
  if (exp.status === 'queued') return { label: 'Queued', tone: 'muted', note: 'Waiting for worker' };
  if (exp.status === 'running') return { label: 'Running', tone: 'warn', note: isDiscovery ? 'Finding deficiency' : 'Running paired test' };
  if (exp.status === 'failed') return { label: 'Failed', tone: 'bad', note: exp.recommendation || 'Runner failed' };
  if (exp.status === 'cancelled') return { label: 'Cancelled', tone: 'muted', note: 'Cancelled' };
  if (isDiscovery) {
    const finding = exp.findings.find(item => String((item as any)?.dimension || '') === 'bootcamp_discovery');
    return { label: 'Discovery', tone: 'warn', note: String((finding as any)?.note || exp.recommendation || 'Discovery completed') };
  }
  if (exp.privacy_failure || exp.status === 'blocked') return { label: 'Privacy fail', tone: 'bad', note: exp.recommendation || 'Privacy gate blocked candidate' };

  const baseline = typeof exp.baseline_score === 'number' ? exp.baseline_score : null;
  const candidate = typeof exp.candidate_score === 'number' ? exp.candidate_score : null;
  if (baseline === null || candidate === null) return { label: 'No grade', tone: 'warn', note: exp.recommendation || 'Missing paired grade' };
  const delta = candidate - baseline;
  const evaluator = labRecord(exp.tool_trace?.evaluator);
  const regressions = Array.isArray(evaluator?.pareto_regressions) ? evaluator?.pareto_regressions : [];
  const artifactReview = labRecord(exp.tool_trace?.artifact_review);
  if (artifactReview?.required === true && artifactReview.pass !== true) {
    return { label: 'Artifact loss', tone: 'bad', note: titleizeLabValue(artifactReview.decision || 'artifact did not beat baseline') };
  }
  if (regressions.length > 0) {
    return { label: 'Regression', tone: 'bad', note: `${regressions.length} protected priority regression${regressions.length === 1 ? '' : 's'}` };
  }
  if (delta > 0) return { label: 'Win', tone: 'good', note: exp.recommendation || 'Candidate beat baseline' };
  if (delta < 0) return { label: 'Loss', tone: 'bad', note: exp.recommendation || 'Baseline beat candidate' };
  return { label: 'Tie', tone: 'muted', note: exp.recommendation || 'No clear improvement' };
}

function labArtifactResultText(exp: MartyLabExperimentRow): string {
  const artifactReview = labRecord(exp.tool_trace?.artifact_review);
  if (!artifactReview?.required) return '—';
  const baseline = labRecord(artifactReview.baseline);
  const candidate = labRecord(artifactReview.candidate);
  const delta = Number(artifactReview.score_delta || 0);
  const verdict = artifactReview.pass === true ? 'Win' : 'Loss';
  return `${verdict} · ${String(baseline?.score ?? '—')}→${String(candidate?.score ?? '—')} (${delta > 0 ? '+' : ''}${delta})`;
}

function labApprovalAssessment(trial: MartyLabTrialRow | null): Record<string, unknown> | null {
  return labRecord(trial?.evidence?.approval_assessment);
}

function labRationaleList(assessment: Record<string, unknown> | null): string[] {
  const value = assessment?.rationale;
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean).slice(0, 4) : [];
}

function labExperimentTagline(page: MartyLabExperimentPage | null): string {
  const title = [
    page?.title,
    page?.trial?.upgrade_key,
    String(labRecord(page?.trial?.evidence?.upgrade)?.deficiency || ''),
    String(labRecord(page?.trial?.evidence?.approval_assessment)?.target_kind || ''),
  ].join(' ').toLowerCase();
  if (title.includes('retrieval') || title.includes('source') || title.includes('grounding') || title.includes('context') || title.includes('document-first')) {
    return 'Improves context retrieval. Finds the right source material before answering or creating artifacts.';
  }
  if (title.includes('xlsx') || title.includes('excel') || title.includes('workbook') || title.includes('formula')) {
    return 'Improves Excel artifact creation. Ensures workbook tabs, rows, and formulas are populated correctly.';
  }
  if (title.includes('docx') || title.includes('memo') || title.includes('word') || (title.includes('document') && !title.includes('document-first'))) {
    return 'Improves Word document creation. Produces richer, better-structured memos with usable tables and sections.';
  }
  if (title.includes('pptx') || title.includes('deck') || title.includes('presentation')) {
    return 'Improves PowerPoint deck creation. Produces more complete slides with stronger narrative structure and notes.';
  }
  if (title.includes('privacy') || title.includes('permission')) {
    return 'Improves privacy boundaries. Keeps answers useful while avoiding information the user should not see.';
  }
  if (title.includes('conversation') || title.includes('memory') || title.includes('intent')) {
    return 'Improves conversation carry. Helps MARTy remember the latest user intent across follow-up turns.';
  }
  return 'Improves MARTy response quality for this workflow while checking for regressions against the current baseline.';
}

type MartyLabTone = 'good' | 'warn' | 'bad' | 'purple' | 'muted';
type MartyLabRepairAction = 'clear_orphaned_lab_queue' | 'archive_legacy_full_lab' | 'quarantine_lab_artifacts';

function martyToneClasses(tone: MartyLabTone): { box: string; text: string; border: string; soft: string } {
  if (tone === 'good') return {
    box: 'border-semantic-success/25 bg-semantic-success/10 text-semantic-success',
    text: 'text-semantic-success',
    border: 'border-semantic-success/25',
    soft: 'bg-semantic-success/5',
  };
  if (tone === 'warn') return {
    box: 'border-semantic-warning/25 bg-semantic-warning/10 text-semantic-warning',
    text: 'text-semantic-warning',
    border: 'border-semantic-warning/25',
    soft: 'bg-semantic-warning/5',
  };
  if (tone === 'bad') return {
    box: 'border-semantic-error/25 bg-semantic-error/10 text-semantic-error',
    text: 'text-semantic-error',
    border: 'border-semantic-error/25',
    soft: 'bg-semantic-error/5',
  };
  if (tone === 'purple') return {
    box: 'border-accent-purple/25 bg-accent-purple/10 text-accent-purple',
    text: 'text-accent-purple',
    border: 'border-accent-purple/25',
    soft: 'bg-accent-purple/5',
  };
  return {
    box: 'border-white/10 bg-white/[0.04] text-text-muted',
    text: 'text-text-muted',
    border: 'border-white/10',
    soft: 'bg-white/[0.025]',
  };
}

function labRunModeLabel(run: MartyLabRunSnapshot | null | undefined): string {
  if (!run) return 'No run';
  return labRunIsCanary(run) ? 'Experiment' : 'Legacy full lab';
}

function labRunHarnessVersion(run: MartyLabRunSnapshot | null | undefined): string {
  if (!run) return '';
  return String(run.summary?.harness_version || run.upgrade_variable?.harness_version || '').trim();
}

function labRunIsCanary(run: MartyLabRunSnapshot | null | undefined): boolean {
  if (!run) return false;
  return Boolean(
    run.upgrade_variable?.mode === 'canary'
    || run.summary?.mode === 'canary'
    || run.suite_name.includes('canary')
  );
}

function labRunIsLegacyFullLab(run: MartyLabRunSnapshot | null | undefined, currentHarnessVersion?: string): boolean {
  if (!run || labRunIsCanary(run)) return false;
  const harness = labRunHarnessVersion(run);
  return !harness || !currentHarnessVersion || harness !== currentHarnessVersion;
}

function labRunShortTitle(run: MartyLabRunSnapshot | null | undefined): string {
  if (!run) return 'Next sandbox request';
  return cleanExperimentTitle(run.upgrade_title || String(run.summary?.current_upgrade_title || '') || run.candidate_label || labRunModeLabel(run));
}

function cleanExperimentTitle(value: unknown): string {
  const text = String(value || 'Experiment').trim();
  return text.replace(/^Round\s+\d+\s*:\s*/i, '').replace(/^Canary\s*:\s*/i, '').trim() || 'Experiment';
}

function labRunPhase(run: MartyLabRunSnapshot | null | undefined): string | null {
  if (!run) return null;
  return String(run.bootcamp_phase || run.summary?.current_phase || run.summary?.bootcamp_phase || '').trim() || null;
}

function labRunPhaseLabel(phase: string | null | undefined): string {
  if (phase === 'round_discovery') return 'finding the next weakness';
  if (phase === 'round_validation') return 'testing a candidate fix';
  if (phase === 'round_inconclusive_needs_review') return 'waiting for review';
  if (phase === 'bootcamp_complete') return 'ready for a decision';
  if (phase === 'human_shipped') return 'shipped';
  if (phase === 'human_rejected') return 'rejected';
  return phase ? phase.replace(/_/g, ' ') : 'running';
}

function labRunNeedsDecision(run: MartyLabRunSnapshot | null | undefined): boolean {
  return Boolean(run && run.status === 'completed' && !['human_shipped', 'human_rejected'].includes(labRunPhase(run) || ''));
}

function labRunChipState(run: MartyLabRunSnapshot, isCurrent: boolean): { label: string; tone: MartyLabTone } {
  const phase = labRunPhase(run);
  if (run.discarded_at || run.discard_reason) return { label: 'Archived', tone: 'warn' };
  if (run.status === 'running' || run.status === 'configured') return { label: 'Active', tone: 'purple' };
  if (run.status === 'queued') return { label: 'Queued', tone: 'purple' };
  if (phase === 'human_shipped') return { label: 'Shipped', tone: 'good' };
  if (phase === 'human_rejected') return { label: 'Rejected', tone: 'bad' };
  if (labRunNeedsDecision(run)) return { label: 'Needs decision', tone: 'warn' };
  if (run.status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
  if (run.status === 'failed') return { label: 'Failed', tone: 'bad' };
  return { label: isCurrent ? 'Current' : 'Finished', tone: 'muted' };
}

function labRunStateCopy(
  run: MartyLabRunSnapshot | null,
  args: {
    activeTrial: MartyLabTrialRow | null;
    isQuarantined: boolean;
    isViewingCurrent: boolean;
    pausedForRoundReview: boolean;
    completed: number;
    total: number;
    currentRound: number;
    roundTotal: number;
    readinessOk: boolean;
    readinessMessage: string;
  }
): { eyebrow: string; title: string; body: string; tone: MartyLabTone } {
  if (!run) {
    return {
      eyebrow: 'Sandbox queue',
      title: args.readinessOk ? 'Ready for the next controlled run' : 'Not ready to start',
      body: args.readinessMessage,
      tone: args.readinessOk ? 'good' : 'warn',
    };
  }
  if (args.isQuarantined) {
    return {
      eyebrow: args.isViewingCurrent ? 'Historical run selected' : 'Viewing history',
      title: 'Archived run: do not use for decisions',
      body: run.discard_reason || 'This run is kept only as historical context. Use the current run for Ship or Reject decisions.',
      tone: 'warn',
    };
  }
  if (!args.isViewingCurrent) {
    return {
      eyebrow: 'Viewing older result',
      title: `${labRunModeLabel(run)} from ${formatRelative(run.created_at)}`,
      body: 'This is a past run. It is useful for learning what happened, but it is not the active run.',
      tone: 'muted',
    };
  }
  if (args.pausedForRoundReview) {
    return {
      eyebrow: 'Human review needed',
      title: 'Review this experiment before the lab continues',
      body: 'Approve and continue or reject this experiment to keep the lab moving. Nothing ships from this round by itself.',
      tone: 'warn',
    };
  }
  if (run.status === 'running' || run.status === 'configured') {
    const phase = labRunPhaseLabel(labRunPhase(run));
    return {
      eyebrow: 'Current run',
      title: `Experiment ${args.currentRound} of ${args.roundTotal}: ${phase}`,
      body: `${labRunModeLabel(run)} is comparing a candidate fix against the accepted baseline. ${args.completed}/${args.total || run.total_experiments || 0} checks are complete. New sandbox requests can be queued while this finishes.`,
      tone: 'purple',
    };
  }
  if (labRunNeedsDecision(run)) {
    const trialStatus = args.activeTrial?.status ? titleizeLabValue(args.activeTrial.status) : 'Review';
    return {
      eyebrow: 'Decision needed',
      title: `${labRunModeLabel(run)} finished: ${trialStatus}`,
      body: 'Review the cover page, then Ship or Reject the whole run. The next queued run will not begin until this decision is made.',
      tone: args.activeTrial?.status === 'accepted' ? 'good' : args.activeTrial?.status === 'rejected' ? 'bad' : 'warn',
    };
  }
  if (labRunPhase(run) === 'human_shipped') {
    return {
      eyebrow: 'Finished result',
      title: 'This run was shipped',
      body: 'Its accepted upgrade became part of the baseline for future MARTy Sandbox runs.',
      tone: 'good',
    };
  }
  if (labRunPhase(run) === 'human_rejected') {
    return {
      eyebrow: 'Finished result',
      title: 'This run was rejected',
      body: 'The existing baseline stayed in place. Use Deep Work or a focused canary for the next attempt.',
      tone: 'bad',
    };
  }
  return {
    eyebrow: 'Finished result',
    title: `${labRunModeLabel(run)} is closed`,
    body: run.summary?.conclusion ? String(run.summary.conclusion) : 'This run is no longer active.',
    tone: 'muted',
  };
}

function MartyLabDecisionButtons({
  disabled,
  deciding,
  onDecide,
}: {
  disabled: boolean;
  deciding: 'ship' | 'reject' | null;
  onDecide: (decision: 'ship' | 'reject') => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onDecide('ship')}
        disabled={disabled || deciding !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-success/25 bg-semantic-success/10 px-3 py-1.5 text-xs font-medium text-semantic-success hover:bg-semantic-success/15 disabled:opacity-45"
      >
        <Check size={13} /> {deciding === 'ship' ? 'Shipping...' : 'Ship'}
      </button>
      <button
        type="button"
        onClick={() => onDecide('reject')}
        disabled={disabled || deciding !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-error/25 bg-semantic-error/10 px-3 py-1.5 text-xs font-medium text-semantic-error hover:bg-semantic-error/15 disabled:opacity-45"
      >
        <XIcon size={13} /> {deciding === 'reject' ? 'Rejecting...' : 'Reject'}
      </button>
    </div>
  );
}

function MartyLabRoundReviewButtons({
  disabled,
  reviewing,
  onReview,
}: {
  disabled: boolean;
  reviewing: 'approve_continue' | 'reject_continue' | null;
  onReview: (decision: 'approve_continue' | 'reject_continue') => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onReview('approve_continue')}
        disabled={disabled || reviewing !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-success/25 bg-semantic-success/10 px-3 py-1.5 text-xs font-medium text-semantic-success hover:bg-semantic-success/15 disabled:opacity-45"
      >
        <Check size={13} /> {reviewing === 'approve_continue' ? 'Continuing...' : 'Approve and continue lab'}
      </button>
      <button
        type="button"
        onClick={() => onReview('reject_continue')}
        disabled={disabled || reviewing !== null}
        className="inline-flex items-center gap-1 rounded-lg border border-semantic-error/25 bg-semantic-error/10 px-3 py-1.5 text-xs font-medium text-semantic-error hover:bg-semantic-error/15 disabled:opacity-45"
      >
        <XIcon size={13} /> {reviewing === 'reject_continue' ? 'Rejecting...' : 'Reject experiment'}
      </button>
    </div>
  );
}

function MartyLabPageShell({
  children,
  pageIndex,
  pageCount,
  onPrev,
  onNext,
  onSelect,
}: {
  children: React.ReactNode;
  pageIndex: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
}) {
  const pageLabel = pageIndex === 0 ? 'Cover' : `Experiment ${pageIndex}`;
  return (
    <section className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.015]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-3">
        <button
          type="button"
          onClick={onPrev}
          disabled={pageIndex <= 0}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-40"
          aria-label="Previous MARTy Lab page"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3 px-2">
          <div className="hidden shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-muted sm:block">
            {pageLabel}
          </div>
          <div className="flex min-w-0 items-center justify-center gap-1 overflow-x-auto">
            {Array.from({ length: pageCount }).map((_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                className={`h-2.5 w-2.5 shrink-0 rounded-full border transition ${
                  index === pageIndex
                    ? 'border-accent-magenta bg-accent-magenta'
                    : 'border-white/15 bg-white/[0.06] hover:bg-white/[0.12]'
                }`}
                aria-label={index === 0 ? 'MARTy Lab cover page' : `MARTy Lab experiment ${index}`}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={pageIndex >= pageCount - 1}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-40"
          aria-label="Next MARTy Lab page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="min-h-[24rem] p-4">{children}</div>
    </section>
  );
}

function MartyLabMiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'purple';
}) {
  const color = tone === 'good'
    ? 'text-semantic-success'
    : tone === 'warn'
      ? 'text-semantic-warning'
      : tone === 'bad'
        ? 'text-semantic-error'
        : tone === 'purple'
          ? 'text-accent-purple'
          : 'text-text-primary';
  return (
    <div className="rounded-lg border border-white/[0.05] bg-white/[0.025] px-3 py-2">
      <div className={`text-base font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-text-muted">{label}</div>
    </div>
  );
}

function MartyLabRoundSampleCard({ sample }: { sample: MartyLabExperimentRow }) {
  const outcome = labExperimentOutcome(sample);
  const roundMeta = labRoundPolicy(sample);
  const delta = typeof sample.candidate_score === 'number' && typeof sample.baseline_score === 'number'
    ? sample.candidate_score - sample.baseline_score
    : null;
  const outcomeTone = outcome.tone === 'good'
    ? 'bg-semantic-success/15 text-semantic-success'
    : outcome.tone === 'bad'
      ? 'bg-semantic-error/15 text-semantic-error'
      : outcome.tone === 'warn'
        ? 'bg-semantic-warning/15 text-semantic-warning'
        : 'bg-white/[0.05] text-text-muted';
  const label = roundMeta?.role === 'discovery'
    ? 'Discovery'
    : roundMeta?.role === 'global_guardrail'
      ? `Guardrail ${roundMeta.sample}`
      : `Validation ${Math.max(1, (roundMeta?.sample || 4) - 3)}/7`;
  const artifactText = labArtifactResultText(sample);

  return (
    <article className="rounded-lg border border-white/[0.05] bg-black/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
          <div className="mt-1 text-sm font-medium leading-snug text-text-primary">{sample.goal}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${outcomeTone}`}>{outcome.label}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MartyLabMiniStat label="Baseline" value={formatLabScore(sample.baseline_score)} />
        <MartyLabMiniStat label="Candidate" value={formatLabScore(sample.candidate_score)} />
        <MartyLabMiniStat
          label="Delta"
          value={labDeltaText(delta)}
          tone={delta && delta > 0 ? 'good' : delta && delta < 0 ? 'bad' : 'default'}
        />
      </div>
      <div className="mt-3 text-xs leading-relaxed text-text-secondary">{outcome.note}</div>
      {artifactText !== '—' && <div className="mt-1 text-[11px] text-text-muted">{artifactText}</div>}
      <details className="mt-3 rounded-md border border-white/[0.04] bg-white/[0.02] px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-text-muted">Prompt</summary>
        <ExpandableText
          text={sample.starting_prompt || sample.goal}
          collapsedLines={4}
          minToggleChars={220}
          className="mt-2 text-xs leading-relaxed text-text-secondary"
        />
      </details>
    </article>
  );
}

function martyLabExperimentStats(page: MartyLabExperimentPage, expectedSamples = 10) {
  const validationSamples = page.samples.filter(sample => labRoundPolicy(sample)?.role === 'validation');
  const closedSamples = page.samples.filter(sample => !['queued', 'running'].includes(sample.status));
  const scoredValidation = validationSamples.filter(sample => (
    typeof sample.baseline_score === 'number'
    && typeof sample.candidate_score === 'number'
    && !sample.privacy_failure
  ));
  const computedDeltas = scoredValidation.map(sample => (sample.candidate_score || 0) - (sample.baseline_score || 0));
  const computedWins = computedDeltas.filter(delta => delta > 0).length;
  const computedLosses = computedDeltas.filter(delta => delta < 0).length;
  const computedAverage = computedDeltas.length
    ? computedDeltas.reduce((sum, delta) => sum + delta, 0) / computedDeltas.length
    : null;
  const trial = page.trial;
  const useFinalTrialStats = Boolean(trial && trial.status !== 'pending' && trial.valid_sample_size > 0);
  const validationTotal = Math.max(7, validationSamples.length);
  const totalSamples = Math.max(expectedSamples, page.samples.length || expectedSamples);
  const waiting = page.samples.length === 0;
  const complete = closedSamples.length >= totalSamples;
  return {
    totalSamples,
    closedSamples: closedSamples.length,
    validationTotal,
    validSamples: useFinalTrialStats ? trial!.valid_sample_size : scoredValidation.length,
    wins: useFinalTrialStats ? trial!.wins : computedWins,
    losses: useFinalTrialStats ? trial!.losses : computedLosses,
    averageDelta: useFinalTrialStats ? trial!.average_delta : computedAverage,
    decision: trial && trial.status !== 'pending'
      ? titleizeLabValue(trial.status)
      : waiting
        ? 'Waiting'
        : complete
          ? 'Finalizing'
          : 'Testing now',
    };
}

type SandboxViewStateId =
  | 'idle_ready'
  | 'running_discovery'
  | 'running_validation'
  | 'paused_review'
  | 'ready_decision'
  | 'queued'
  | 'needs_cleanup'
  | 'historical'
  | 'failed';

type SandboxViewState = {
  id: SandboxViewStateId;
  eyebrow: string;
  title: string;
  body: string;
  tone: MartyLabTone;
};

function sandboxCheckLabel(key: string): string {
  const labels: Record<string, string> = {
    lab_work_queue_clear: 'Stuck sandbox work',
    legacy_full_lab_active: 'Legacy sandbox cleanup',
    sandbox_artifact_isolation: 'Sandbox artifact cleanup',
    round_inconclusive_needs_review: 'Needs your review',
    no_active_lab_run: 'Another improvement is already running',
    no_active_lab_run_race: 'Another improvement is already running',
    one_active_lab_run_per_suite: 'Another improvement is already running',
    one_active_lab_run_per_org: 'Another improvement is already running',
    human_decision_required: 'Waiting for Ship or Reject',
    sandbox_queue_pending: 'Queued improvement waiting',
  };
  return labels[key] || titleizeLabValue(key);
}

function sandboxRunViewState(args: {
  run: MartyLabRunSnapshot | null;
  readiness: MartyLabStatusSnapshot['readiness'];
  activeTrial: MartyLabTrialRow | null;
  isViewingCurrent: boolean;
  isQuarantined: boolean;
  pausedForRoundReview: boolean;
  canRepairLabQueue: boolean;
  canArchiveLegacyRun: boolean;
  canQuarantineLabArtifacts: boolean;
  runIsCanary: boolean;
  completed: number;
  expectedTotal: number;
  currentRound: number;
  roundTotal: number;
  discoveryCompleted: number;
  validationCompleted: number;
}): SandboxViewState {
  const {
    run,
    readiness,
    activeTrial,
    isViewingCurrent,
    isQuarantined,
    pausedForRoundReview,
    canRepairLabQueue,
    canArchiveLegacyRun,
    canQuarantineLabArtifacts,
    runIsCanary,
    completed,
    expectedTotal,
    currentRound,
    roundTotal,
    discoveryCompleted,
    validationCompleted,
  } = args;

  if (canArchiveLegacyRun) {
    return {
      id: 'needs_cleanup',
      eyebrow: 'Legacy sandbox cleanup',
      title: 'Archive the old full lab',
      body: 'This is an old full-lab result from before the experiment-only harness. Archive it to unblock clean experiments; nothing will ship.',
      tone: 'warn',
    };
  }

  if (!run) {
    if (canQuarantineLabArtifacts) {
      return {
        id: 'needs_cleanup',
        eyebrow: 'Sandbox cleanup',
        title: 'Quarantine old sandbox artifacts',
        body: 'Old sandbox-generated documents are still stored in the document table. They are hidden from MARTy retrieval, but quarantine them before starting a clean experiment.',
        tone: 'warn',
      };
    }
    if (canRepairLabQueue) {
      return {
        id: 'needs_cleanup',
        eyebrow: 'Sandbox cleanup',
        title: 'Sandbox cleanup needed',
        body: 'Some retryable sandbox work is still waiting even though no experiment is active. Clear it here, then start the next clean experiment.',
        tone: 'warn',
      };
    }
    if (!readiness.ok) {
      const blocker = readiness.checks.find(check => check.status === 'block');
      return {
        id: 'queued',
        eyebrow: 'Sandbox queue',
        title: sandboxCheckLabel(blocker?.key || 'sandbox_queue_pending'),
        body: readiness.blockers[0] || readiness.warnings[0] || 'The next improvement will wait until the current sandbox work finishes.',
        tone: 'warn',
      };
    }
    return {
      id: 'idle_ready',
      eyebrow: 'MARTy Improvement Studio',
      title: 'Ready to improve MARTy',
      body: 'Describe a MARTy problem or pick a focus area. The sandbox will test a candidate fix against the current accepted baseline.',
      tone: 'good',
    };
  }

  if (!isViewingCurrent || isQuarantined) {
    return {
      id: 'historical',
      eyebrow: 'Past result',
      title: 'Viewing a past sandbox result',
      body: 'This result is useful for learning what happened, but Ship and Reject decisions only apply to the current completed run.',
      tone: 'muted',
    };
  }

  if (pausedForRoundReview) {
    return {
      id: 'paused_review',
      eyebrow: 'Needs your review',
      title: 'Review this experiment to continue',
      body: 'The lab hit an inconclusive fix. Approve and continue or reject this experiment. Nothing ships from this decision by itself.',
      tone: 'warn',
    };
  }

  if (labRunNeedsDecision(run)) {
    const status = activeTrial?.status ? titleizeLabValue(activeTrial.status) : 'Review';
    return {
      id: 'ready_decision',
      eyebrow: 'Decision ready',
      title: `${labRunModeLabel(run)} finished: ${status}`,
      body: 'Review the cover page, then Ship or Reject this experiment. The next queued request waits for that decision.',
      tone: activeTrial?.status === 'accepted' ? 'good' : activeTrial?.status === 'rejected' ? 'warn' : 'warn',
    };
  }

  if (run.status === 'failed') {
    return {
      id: 'failed',
      eyebrow: 'Sandbox issue',
      title: 'This run failed',
      body: run.summary?.conclusion ? String(run.summary.conclusion) : 'The sandbox could not complete this run. Review details before starting another one.',
      tone: 'bad',
    };
  }

  if (run.status === 'running' || run.status === 'configured') {
    const phase = labRunPhase(run);
    if (phase === 'round_discovery') {
      return {
        id: 'running_discovery',
        eyebrow: 'Live now',
        title: runIsCanary
          ? `Finding weakness: discovery chat ${Math.min(3, discoveryCompleted + 1)} of 3`
          : `Finding weakness ${Math.max(1, currentRound)} of ${roundTotal}`,
        body: runIsCanary
          ? `${Math.min(3, discoveryCompleted)} of 3 discovery rounds are complete. MARTy is looking for a real gap before it tests a fix.`
          : `${completed.toLocaleString()} of ${expectedTotal.toLocaleString()} checks are complete. MARTy is looking for a real gap before it tests a fix.`,
        tone: 'purple',
      };
    }
    return {
      id: 'running_validation',
      eyebrow: 'Live now',
      title: runIsCanary
        ? `Testing fix: validation chat ${Math.min(7, validationCompleted + 1)} of 7`
        : `Testing fix ${Math.max(1, currentRound)} of ${roundTotal}`,
      body: runIsCanary
        ? `${Math.min(7, validationCompleted)} of 7 testing rounds are complete. The current candidate is being compared against the accepted baseline.`
        : `${completed.toLocaleString()} of ${expectedTotal.toLocaleString()} checks are complete. The current candidate is being compared against the accepted baseline.`,
      tone: 'purple',
    };
  }

  if (labRunPhase(run) === 'human_shipped') {
    return {
      id: 'historical',
      eyebrow: 'Shipped',
      title: 'This improvement was shipped',
      body: 'The accepted upgrade became the baseline for future sandbox tests.',
      tone: 'good',
    };
  }

  if (labRunPhase(run) === 'human_rejected') {
    return {
      id: 'historical',
      eyebrow: 'Rejected',
      title: 'This improvement was rejected',
      body: 'The existing baseline stayed in place. Start another focused experiment with a sharper problem statement.',
      tone: 'muted',
    };
  }

  return {
    id: 'historical',
    eyebrow: 'Closed',
    title: `${labRunModeLabel(run)} is closed`,
    body: run.summary?.conclusion ? String(run.summary.conclusion) : 'This run is no longer active.',
    tone: 'muted',
  };
}

function SandboxHeroState({
  state,
  progressPct,
  progressLabel,
  contextLabel,
  actions,
}: {
  state: SandboxViewState;
  progressPct?: number | null;
  progressLabel?: string | null;
  contextLabel?: string | null;
  actions?: React.ReactNode;
}) {
  const tone = martyToneClasses(state.tone);
  return (
    <section className={`rounded-xl border ${tone.border} ${tone.soft} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className={`text-[11px] font-semibold uppercase tracking-wide ${tone.text}`}>{state.eyebrow}</div>
          <h3 className="mt-1 text-2xl font-semibold leading-tight text-text-primary">{state.title}</h3>
          <p className="mt-2 max-w-4xl text-sm leading-relaxed text-text-secondary">{state.body}</p>
          {contextLabel && (
            <div className="mt-3 text-xs text-text-muted">{contextLabel}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {typeof progressPct === 'number' && progressLabel && (
        <div className="mt-5">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }} />
          </div>
          <div className="mt-2 text-xs text-text-muted">{progressLabel}</div>
        </div>
      )}
    </section>
  );
}

function SandboxFocusComposer({
  value,
  onChange,
  onStart,
  startDisabled,
  startVerb,
  startingMode,
  isBusy,
}: {
  value: string;
  onChange: (value: string) => void;
  onStart: () => void;
  startDisabled: boolean;
  startVerb: string;
  startingMode: 'canary' | null;
  isBusy: boolean;
}) {
  const chips = [
    { label: 'Retrieval', prompt: 'Focus on MARTy finding the right database records, source docs, and prior conversation context before answering.' },
    { label: 'Conversation carry', prompt: 'Focus on MARTy carrying user intent across short follow-ups and ambiguous messages.' },
    { label: 'Artifacts', prompt: 'Focus on DOCX, XLSX, and PPTX artifact quality, including formulas, tables, formatting, and visual completeness.' },
    { label: 'Privacy', prompt: 'Focus on privacy-safe answers that avoid leaking unrelated user or deal information.' },
    { label: 'Prompt logic', prompt: 'Focus on MARTy system/runtime logic and instruction-following quality.' },
  ];
  const title = isBusy ? 'Queue the next experiment focus' : 'What should MARTy improve?';
  const body = isBusy
    ? 'The current improvement keeps running. This request will wait its turn.'
    : 'Use plain language, like you would when telling Codex what went wrong with MARTy.';

  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{body}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map(chip => (
            <button
              key={chip.label}
              type="button"
              onClick={() => onChange(value.trim() ? `${value.trim()} ${chip.prompt}` : chip.prompt)}
              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-text-secondary hover:border-accent-purple/30 hover:bg-accent-purple/10 hover:text-accent-purple"
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Example: MARTy missed the source doc and gave me a generic answer. Focus on retrieval."
          className="min-w-[18rem] flex-1 rounded-lg border border-white/10 bg-bg-input px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-magenta/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={onStart}
          disabled={startDisabled}
          className="inline-flex items-center gap-1 rounded-lg border border-accent-magenta/25 bg-accent-magenta/10 px-3 py-2 text-xs font-medium text-accent-magenta hover:bg-accent-magenta/15 disabled:opacity-50"
        >
          <Sparkles size={14} /> {startingMode === 'canary' ? `${startVerb}ing...` : `${startVerb} experiment`}
        </button>
      </div>
    </section>
  );
}

function SandboxEvidenceDrawer({
  title = 'Evidence Details',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-lg border border-white/[0.06] bg-black/10">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-text-primary">
        <span>{title}</span>
        <ChevronDown size={14} className="text-text-muted" />
      </summary>
      <div className="border-t border-white/[0.05] p-3">{children}</div>
    </details>
  );
}

function SandboxRunPager({
  pageIndex,
  pageCount,
  onPrev,
  onNext,
  onSelect,
  children,
}: {
  pageIndex: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.015]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div>
          <div className="text-xs font-semibold text-text-primary">Experiment workspace</div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {pageIndex === 0 ? 'Experiment cover' : 'Rounds page'} · {pageCount} page{pageCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onPrev}
            disabled={pageIndex <= 0}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-35"
            aria-label="Previous sandbox page"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="flex max-w-[18rem] items-center gap-1 overflow-x-auto">
            {Array.from({ length: pageCount }).map((_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                className={`h-2.5 shrink-0 rounded-full border transition ${
                  index === pageIndex
                    ? 'w-6 border-accent-magenta bg-accent-magenta'
                    : 'w-2.5 border-white/15 bg-white/[0.06] hover:bg-white/[0.12]'
                }`}
                aria-label={index === 0 ? 'Experiment cover page' : 'Experiment rounds page'}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onNext}
            disabled={pageIndex >= pageCount - 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-text-secondary hover:bg-white/[0.04] disabled:opacity-35"
            aria-label="Next sandbox page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function labHumanPreferenceText(sample: MartyLabExperimentRow): string {
  const evaluator = labRecord(sample.tool_trace?.evaluator);
  const preference = labRecord(evaluator?.human_preference) || labRecord(sample.tool_trace?.human_preference);
  const winner = String(preference?.winner || preference?.pick || preference?.preferred || '').toLowerCase();
  if (winner.includes('candidate')) return 'Candidate';
  if (winner.includes('baseline')) return 'Baseline';
  if (winner.includes('tie')) return 'Tie';
  return 'Pending';
}

function labSampleIsClosed(sample: MartyLabExperimentRow): boolean {
  return !['queued', 'running'].includes(sample.status);
}

function labPlainExperimentConclusion(
  run: MartyLabRunSnapshot,
  trial: MartyLabTrialRow | null,
  rationale: string[]
): string {
  const status = trial?.status || run.status;
  if (labRunPhase(run) === 'human_shipped') {
    return 'This experiment was shipped. Its upgrade became the baseline for future MARTy tests.';
  }
  if (labRunPhase(run) === 'human_rejected') {
    return 'This experiment was rejected. The existing MARTy baseline stayed unchanged.';
  }
  if (run.status === 'running' || run.status === 'configured') {
    return 'This experiment is still running. Wait for the testing rounds to finish before making a Ship or Reject decision.';
  }
  if (status === 'accepted') {
    return 'The candidate produced enough evidence to recommend shipping. Review the testing rounds, then decide whether to make it the new baseline.';
  }
  if (status === 'rejected') {
    return 'The candidate did not improve MARTy enough to ship. The baseline should stay unchanged.';
  }
  if (status === 'inconclusive') {
    return 'The experiment found some signal, but not enough clean evidence to ship automatically. The baseline stays unchanged unless a human chooses otherwise.';
  }
  if (rationale.length > 0) return rationale[0];
  return run.summary?.conclusion ? String(run.summary.conclusion) : 'No conclusion has been recorded yet.';
}

function labUpgradeSummary(activeUpgrade: Record<string, unknown> | null, trial: MartyLabTrialRow | null): string {
  const upgrade = activeUpgrade || labRecord(trial?.evidence?.upgrade);
  const fields = [
    upgrade?.title,
    upgrade?.name,
    upgrade?.runtime_strategy,
    upgrade?.strategy,
    trial?.upgrade_key,
    trial?.title,
  ];
  const text = fields.map(item => String(item || '').trim()).find(Boolean);
  return cleanExperimentTitle(text || 'Candidate upgrade');
}

function labHypothesisSummary(activeUpgrade: Record<string, unknown> | null, trial: MartyLabTrialRow | null): string {
  const evidence = labRecord(trial?.evidence);
  const upgrade = activeUpgrade || labRecord(evidence?.upgrade);
  const fields = [
    upgrade?.hypothesis,
    upgrade?.deficiency,
    evidence?.hypothesis,
    evidence?.discovery_synthesis,
    evidence?.deficiency_summary,
  ];
  const text = fields.map(item => labReadableEvidence(item)).find(Boolean);
  return text || 'MARTy may be missing the user’s real intent or source context, so the experiment tests one focused upgrade against the current baseline.';
}

function ExperimentCoverSection({
  title,
  status,
  children,
}: {
  title: string;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3">
        <h5 className="text-sm font-semibold text-text-primary">{title}</h5>
        {status && <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-text-muted">{status}</span>}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-text-secondary">{children}</div>
    </section>
  );
}

function SandboxRoundCard({ sample }: { sample: MartyLabExperimentRow }) {
  const outcome = labExperimentOutcome(sample);
  const roundMeta = labRoundPolicy(sample);
  const delta = typeof sample.candidate_score === 'number' && typeof sample.baseline_score === 'number'
    ? sample.candidate_score - sample.baseline_score
    : null;
  const outcomeTone = outcome.tone === 'good'
    ? 'bg-semantic-success/15 text-semantic-success'
    : outcome.tone === 'bad'
      ? 'bg-semantic-error/15 text-semantic-error'
      : outcome.tone === 'warn'
        ? 'bg-semantic-warning/15 text-semantic-warning'
        : 'bg-white/[0.05] text-text-muted';
  const label = roundMeta?.role === 'discovery'
    ? 'Discovery'
    : roundMeta?.role === 'global_guardrail'
      ? `Guardrail ${roundMeta.sample}`
      : `Validation ${Math.max(1, (roundMeta?.sample || 4) - 3)}/7`;
  const artifactText = labArtifactResultText(sample);
  const humanPick = labHumanPreferenceText(sample);
  const note = labFriendlyOutcomeNote(outcome.note);
  const observation = roundMeta?.role === 'discovery'
    ? note || 'Discovery captured baseline behavior for this experiment.'
    : delta === null
      ? note
      : delta > 0
        ? `Improved by ${labDeltaText(delta)}. ${note}`
        : delta < 0
          ? `Regressed by ${labDeltaText(delta)}. ${note}`
          : `No measured lift. ${note}`;

  return (
    <details className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <summary className="cursor-pointer list-none px-4 py-3 marker:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
            <h5 className="mt-1 text-sm font-semibold leading-snug text-text-primary">{sample.goal}</h5>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">{observation}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {delta !== null && <span className={`text-sm font-semibold tabular-nums ${delta > 0 ? 'text-semantic-success' : delta < 0 ? 'text-semantic-error' : 'text-text-muted'}`}>{labDeltaText(delta)}</span>}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${outcomeTone}`}>{outcome.label}</span>
            <ChevronDown size={14} className="text-text-muted" />
          </div>
        </div>
      </summary>
      <div className="space-y-3 border-t border-white/[0.05] px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-4">
          <MartyLabMiniStat label="Baseline" value={formatLabScore(sample.baseline_score)} />
          <MartyLabMiniStat label="Candidate" value={formatLabScore(sample.candidate_score)} />
          <MartyLabMiniStat
            label="Delta"
            value={labDeltaText(delta)}
            tone={delta && delta > 0 ? 'good' : delta && delta < 0 ? 'bad' : 'default'}
          />
          <MartyLabMiniStat
            label="Human pick"
            value={humanPick}
            tone={humanPick === 'Candidate' ? 'good' : humanPick === 'Baseline' ? 'bad' : 'default'}
          />
        </div>
        {artifactText !== '—' && <p className="text-[11px] text-text-muted">{artifactText}</p>}
        <div className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-2">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Prompt</div>
            <ExpandableText
              text={sample.starting_prompt || sample.goal}
              collapsedLines={4}
              minToggleChars={220}
              className="mt-1 text-xs leading-relaxed text-text-secondary"
            />
          </div>
          {sample.recommendation && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Outcome summary</div>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{labFriendlyOutcomeNote(sample.recommendation)}</p>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function SandboxCoverPage({
  run,
  runIsCanary,
  currentRound,
  roundTotal,
  visibleRoundTotal,
  completed,
  expectedTotal,
  progressPct,
  acceptedTrialCount,
  rejectedTrialCount,
  inconclusiveTrialCount,
  privacyFailures,
  activeTrial,
  activeExperimentPage,
  activeUpgrade,
  activeLeverIds,
  activeCandidatePool,
  acceptedBaseline,
  approvalRationale,
  pausedForRoundReview,
  canShowRunDecision,
  decisionDisabled,
  deciding,
  reviewingRound,
  onDecide,
  onReview,
}: {
  run: MartyLabRunSnapshot;
  runIsCanary: boolean;
  currentRound: number;
  roundTotal: number;
  visibleRoundTotal: number;
  completed: number;
  expectedTotal: number;
  progressPct: number;
  acceptedTrialCount: number;
  rejectedTrialCount: number;
  inconclusiveTrialCount: number;
  privacyFailures: number;
  activeTrial: MartyLabTrialRow | null;
  activeExperimentPage: MartyLabExperimentPage | null;
  activeUpgrade: Record<string, unknown> | null;
  activeLeverIds: string[];
  activeCandidatePool: Record<string, unknown> | null;
  acceptedBaseline: MartyLabStatusSnapshot['versions'][number] | null;
  approvalRationale: string[];
  pausedForRoundReview: boolean;
  canShowRunDecision: boolean;
  decisionDisabled: boolean;
  deciding: 'ship' | 'reject' | null;
  reviewingRound: 'approve_continue' | 'reject_continue' | null;
  onDecide: (decision: 'ship' | 'reject') => void;
  onReview: (decision: 'approve_continue' | 'reject_continue') => void;
}) {
  const focusPrompt = typeof run.summary?.focus_prompt === 'string' ? run.summary.focus_prompt.trim() : '';
  const samples = activeExperimentPage?.samples || [];
  const discoverySamples = samples.filter(sample => labRoundPolicy(sample)?.role === 'discovery');
  const validationSamples = samples.filter(sample => labRoundPolicy(sample)?.role === 'validation');
  const discoveryDone = discoverySamples.filter(labSampleIsClosed).length;
  const validationDone = validationSamples.filter(labSampleIsClosed).length;
  const validationOutcomes = validationSamples.map(sample => labExperimentOutcome(sample));
  const validationWins = validationOutcomes.filter(outcome => outcome.label === 'Win').length;
  const validationLosses = validationOutcomes.filter(outcome => ['Loss', 'Regression', 'Artifact loss', 'Privacy fail'].includes(outcome.label)).length;
  const validationTies = validationOutcomes.filter(outcome => outcome.label === 'Tie').length;
  const validationStopped = validationSamples.filter(sample => ['cancelled', 'failed', 'blocked'].includes(sample.status)).length;
  const experimentProgressPct = Math.max(0, Math.min(100, Math.round(((discoveryDone + validationDone) / 10) * 100)));
  const recommendation = activeTrial?.status ? titleizeLabValue(activeTrial.status) : titleizeLabValue(run.status);
  const summary = run.summary?.conclusion ? String(run.summary.conclusion) : null;
  const title = cleanExperimentTitle(activeTrial?.title || run.upgrade_title || labRunShortTitle(run));
  const hypothesis = labHypothesisSummary(activeUpgrade, activeTrial);
  const appliedUpgrade = labUpgradeSummary(activeUpgrade, activeTrial);
  const conclusion = labPlainExperimentConclusion(run, activeTrial, approvalRationale);
  const phase = labRunPhase(run);
  const stageLabel = run.status === 'running' || run.status === 'configured'
    ? phase === 'round_discovery'
      ? `Discovery ${Math.min(3, discoveryDone + 1)} of 3`
      : `Testing ${Math.min(7, validationDone + 1)} of 7`
    : labRunNeedsDecision(run)
      ? 'Ready for decision'
      : labRunPhase(run) === 'human_shipped'
        ? 'Shipped'
        : labRunPhase(run) === 'human_rejected'
          ? 'Rejected'
          : titleizeLabValue(activeTrial?.status || run.status);
  const validationSummary = validationSamples.length > 0
    ? `${validationDone}/7 testing rounds recorded: ${validationWins} improved, ${validationLosses} regressed, ${validationTies} tied${validationStopped > 0 ? `, ${validationStopped} stopped early` : ''}.`
    : 'Testing rounds have not started yet. They will compare baseline MARTy against the candidate upgrade across seven human-like conversations.';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-4xl">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {runIsCanary ? 'Experiment' : 'Legacy full lab'}
          </div>
          <h4 className="mt-1 text-2xl font-semibold leading-tight text-text-primary">
            {title}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            {activeExperimentPage ? labExperimentTagline(activeExperimentPage) : 'The sandbox is testing a MARTy improvement against the accepted baseline.'}
          </p>
        </div>
        {pausedForRoundReview ? (
          <MartyLabRoundReviewButtons disabled={reviewingRound !== null} reviewing={reviewingRound} onReview={onReview} />
        ) : canShowRunDecision ? (
          <MartyLabDecisionButtons disabled={decisionDisabled} deciding={deciding} onDecide={onDecide} />
        ) : null}
      </div>

      <div className="rounded-lg border border-white/[0.06] bg-black/10 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-text-primary">{stageLabel}</div>
            <div className="mt-1 text-xs leading-relaxed text-text-muted">
              Three discovery rounds shape one hypothesis. Seven testing rounds compare the applied upgrade against the current baseline.
            </div>
          </div>
          <MartyLabStatusPill status={run.status} />
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full rounded-full bg-accent-magenta" style={{ width: `${experimentProgressPct || progressPct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>{discoveryDone}/3 discovery rounds</span>
          <span>{validationDone}/7 testing rounds</span>
          <span>Recommendation: {recommendation}</span>
          {privacyFailures > 0 && <span className="text-semantic-error">{privacyFailures} privacy issue{privacyFailures === 1 ? '' : 's'}</span>}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ExperimentCoverSection title="Discovery rounds" status={`${discoveryDone}/3`}>
          {discoveryDone < 3
            ? 'The sandbox is still gathering baseline MARTy behavior from realistic user conversations.'
            : 'The discovery rounds captured where baseline MARTy struggled before proposing one focused upgrade.'}
        </ExperimentCoverSection>

        <ExperimentCoverSection title="Hypothesis" status={activeTrial?.status === 'pending' ? 'Forming' : 'Set'}>
          {hypothesis}
        </ExperimentCoverSection>

        <ExperimentCoverSection title="Applied upgrade" status={activeLeverIds.length > 0 ? `${activeLeverIds.length} lever${activeLeverIds.length === 1 ? '' : 's'}` : undefined}>
          {appliedUpgrade}
        </ExperimentCoverSection>

        <ExperimentCoverSection title="Testing rounds" status={`${validationDone}/7`}>
          {validationSummary}
        </ExperimentCoverSection>
      </div>

      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className="text-sm font-semibold text-text-primary">Findings and conclusion</div>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">{conclusion}</p>
        {summary && summary !== conclusion && <p className="mt-2 text-xs leading-relaxed text-text-muted">{summary}</p>}
        {focusPrompt && (
          <div className="mt-3 rounded-md border border-accent-purple/15 bg-accent-purple/5 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-accent-purple">User focus</div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">{focusPrompt}</p>
          </div>
        )}
        {approvalRationale.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Why</div>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-text-secondary">
              {approvalRationale.map(item => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        </div>

      <SandboxEvidenceDrawer>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Raw run decisions</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <MartyLabMiniStat label="Accepted" value={acceptedTrialCount} tone="good" />
              <MartyLabMiniStat label="Rejected" value={rejectedTrialCount} tone="warn" />
              <MartyLabMiniStat label="Review" value={inconclusiveTrialCount} tone="warn" />
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current baseline</div>
            <div className="mt-2 text-sm font-medium text-text-primary">{acceptedBaseline?.label || 'Accepted MARTy baseline'}</div>
            <div className="mt-1 text-xs text-text-muted">Generation {acceptedBaseline?.generation ?? '—'}</div>
          </div>
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Candidate pool</div>
            <div className="mt-2 text-xs leading-relaxed text-text-secondary">
              Rank {String(activeCandidatePool?.selected_rank || activeCandidatePool?.rank || '—')} of {String(activeCandidatePool?.size || activeCandidatePool?.pool_size || '—')}
            </div>
            <div className="mt-2 text-[11px] text-text-muted">
              Run checks: {completed}/{expectedTotal} · Experiment {Math.max(1, currentRound)}/{Math.max(1, visibleRoundTotal || roundTotal)}
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Upgrade levers</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(activeLeverIds.length > 0 ? activeLeverIds : labEvidenceList(activeUpgrade, 'lever_ids')).slice(0, 6).map(lever => (
                <span key={lever} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-text-muted">{lever}</span>
              ))}
              {activeLeverIds.length === 0 && <span className="text-xs text-text-muted">No lever IDs recorded yet.</span>}
            </div>
          </div>
        </div>
      </SandboxEvidenceDrawer>
    </div>
  );
}

function SandboxExperimentPage({
  page,
  expectedSamples,
}: {
  page: MartyLabExperimentPage;
  expectedSamples: number;
}) {
  const stats = martyLabExperimentStats(page, expectedSamples);
  const tone = page.trial?.status === 'accepted'
    ? 'good'
    : page.trial?.status === 'rejected'
      ? 'warn'
      : page.trial?.status === 'inconclusive'
        ? 'warn'
        : 'purple';
  const statusTone = martyToneClasses(tone);
  const sortedSamples = [...page.samples].sort((a, b) => {
    const aMeta = labRoundPolicy(a);
    const bMeta = labRoundPolicy(b);
    return (aMeta?.sample || 0) - (bMeta?.sample || 0);
  });
  const discoveryDone = sortedSamples.filter(sample => labRoundPolicy(sample)?.role === 'discovery' && labSampleIsClosed(sample)).length;
  const validationDone = sortedSamples.filter(sample => labRoundPolicy(sample)?.role === 'validation' && labSampleIsClosed(sample)).length;
  const cleanTitle = cleanExperimentTitle(page.title);
  const liftText = typeof stats.averageDelta === 'number'
    ? `Average lift ${labDeltaText(stats.averageDelta)}`
    : 'Average lift pending';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-5xl">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Experiment rounds</div>
          <h4 className="mt-1 text-2xl font-semibold leading-tight text-text-primary">{cleanTitle}</h4>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{labExperimentTagline(page)}</p>
          <p className="mt-2 text-xs leading-relaxed text-text-muted">
            Discovery {discoveryDone}/3 · Testing {validationDone}/7 · {stats.wins} improved · {stats.losses} regressed · {liftText}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusTone.box}`}>{stats.decision}</span>
      </div>

      <div className="max-h-[42rem] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/10 p-2 pr-3">
        {sortedSamples.length > 0 ? (
          <div className="space-y-2">
            {sortedSamples.map(sample => <SandboxRoundCard key={sample.id} sample={sample} />)}
          </div>
        ) : (
          <div className="rounded-lg border border-white/[0.06] bg-black/10 p-5 text-sm leading-relaxed text-text-muted">
            This experiment has not started yet. It will fill with three discovery cards and seven validation cards when the lab reaches this step.
          </div>
        )}
      </div>
    </div>
  );
}

function SandboxImprovementQueue({
  run,
  liveRun,
  queuedRuns,
  recentRuns,
  readiness,
  readinessMessage,
  canRepairLabQueue,
  canQuarantineLabArtifacts,
  repairingAction,
  onRepairReadiness,
  deepWorkItems,
  activeFailureClusters,
  codePatchJobs,
  startDisabled,
  startVerb,
  startingCodePatchId,
  onStartLab,
  onStartCodePatch,
  onSelectRun,
  loadingRunId,
  isViewingCurrent,
}: {
  run: MartyLabRunSnapshot | null;
  liveRun: MartyLabRunSnapshot | null;
  queuedRuns: MartyLabStatusSnapshot['queued_runs'];
  recentRuns: MartyLabStatusSnapshot['recent_runs'];
  readiness: MartyLabStatusSnapshot['readiness'];
  readinessMessage: string;
  canRepairLabQueue: boolean;
  canQuarantineLabArtifacts: boolean;
  repairingAction: MartyLabRepairAction | null;
  onRepairReadiness: (action?: MartyLabRepairAction) => void;
  deepWorkItems: MartyLabDeepWorkItemRow[];
  activeFailureClusters: Array<Record<string, unknown>>;
  codePatchJobs: MartyLabCodePatchJobRow[];
  startDisabled: boolean;
  startVerb: string;
  startingCodePatchId: string | null;
  onStartLab: (focusOverride?: string) => void;
  onStartCodePatch: (item: MartyLabDeepWorkItemRow) => void;
  onSelectRun: (runId: string | null) => void;
  loadingRunId: string | null;
  isViewingCurrent: boolean;
}) {
  const deepWorkCount = deepWorkItems.length || activeFailureClusters.length;

  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.015] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-text-primary">Improvement queue</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            Pending runs, bigger fixes, and isolated code patches live here. Details stay collapsed until you need them.
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-muted">
          {queuedRuns.length} queued
        </span>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-3">
        <details className="rounded-lg border border-white/[0.06] bg-black/10" open={queuedRuns.length > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Queued requests</summary>
          <div className="space-y-2 border-t border-white/[0.05] p-3">
            {queuedRuns.length > 0 ? queuedRuns.map((queued, index) => (
              <div key={queued.id} className="rounded-md border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-text-primary">{index === 0 ? 'Next up' : `Queued ${index + 1}`}</div>
                  <MartyLabStatusPill status={queued.status} />
                </div>
                <div className="mt-1 text-[11px] text-text-muted">{labRunModeLabel(queued)} · {queued.total_experiments.toLocaleString()} checks</div>
                {typeof queued.summary?.focus_prompt === 'string' && queued.summary.focus_prompt.trim() && (
                  <ExpandableText
                    text={queued.summary.focus_prompt}
                    collapsedLines={2}
                    minToggleChars={110}
                    className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                  />
                )}
              </div>
            )) : (
              <div className="text-xs leading-relaxed text-text-muted">No queued sandbox requests.</div>
            )}
          </div>
        </details>

        <details className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/5" open={deepWorkCount > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Bigger fixes MARTy found</summary>
          <div className="max-h-[25rem] space-y-2 overflow-y-auto border-t border-semantic-warning/10 p-3 pr-2">
            {deepWorkItems.map(item => {
              const patchJob = codePatchJobs.find(job => job.deep_work_item_id === item.id);
              const focus = `${item.title}. ${labDeepWorkBody(item)}`;
              return (
                <div key={item.id} className="rounded-md border border-semantic-warning/15 bg-black/10 px-3 py-2">
                  <div className="text-xs font-medium leading-snug text-text-primary">{item.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                    <span>{titleizeLabValue(item.priority)}</span>
                    <span>·</span>
                    <span>{titleizeLabValue(item.failure_type)}</span>
                    {patchJob && <span className="rounded border border-accent-magenta/20 bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] text-accent-magenta">Patch {labCodePatchStatusLabel(patchJob.status)}</span>}
                  </div>
                  <ExpandableText text={labDeepWorkBody(item)} collapsedLines={3} minToggleChars={140} className="mt-2 text-[11px] leading-relaxed text-text-secondary" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onStartCodePatch(item)}
                      disabled={Boolean(patchJob) || startingCodePatchId === item.id || !isViewingCurrent}
                      className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
                    >
                      {startingCodePatchId === item.id ? 'Starting patch' : patchJob ? 'Patch started' : 'Start code patch'}
                    </button>
                    <button type="button" onClick={() => onStartLab(focus)} disabled={startDisabled} className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-white/[0.04] disabled:opacity-50">{startVerb} canary</button>
                  </div>
                </div>
              );
            })}
            {deepWorkItems.length === 0 && activeFailureClusters.map((cluster, index) => {
              const focus = `${titleizeLabValue(cluster.failed_gate || cluster.failure_type)}. ${labFailureClusterBody(cluster)}`;
              return (
                <div key={`${String(cluster.cluster_key || index)}`} className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-2">
                  <div className="text-xs font-medium leading-snug text-text-primary">{titleizeLabValue(cluster.failed_gate || cluster.failure_type)}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{Number(cluster.count || 0)} affected check{Number(cluster.count || 0) === 1 ? '' : 's'}</div>
                  <ExpandableText text={labFailureClusterBody(cluster)} collapsedLines={3} minToggleChars={140} className="mt-2 text-[11px] leading-relaxed text-text-secondary" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => onStartLab(focus)} disabled={startDisabled} className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50">{startVerb} canary</button>
                  </div>
                </div>
              );
            })}
            {deepWorkCount === 0 && <div className="text-xs leading-relaxed text-text-muted">No bigger fixes identified yet.</div>}
          </div>
        </details>

        <details className="rounded-lg border border-white/[0.06] bg-black/10" open={codePatchJobs.length > 0}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Isolated code patches</summary>
          <div className="max-h-[25rem] space-y-2 overflow-y-auto border-t border-white/[0.05] p-3 pr-2">
            {codePatchJobs.length > 0 ? codePatchJobs.map(job => (
              <div key={job.id} className="rounded-md border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium leading-snug text-text-primary">{job.title}</div>
                    <div className="mt-1 text-[11px] text-text-muted">{labCodePatchStatusLabel(job.status)} · {job.model}</div>
                  </div>
                  <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">No deploy</span>
                </div>
                <SandboxEvidenceDrawer title="Patch details">
                  <div className="space-y-2 text-[11px] leading-relaxed text-text-secondary">
                    <div>Branch: {job.branch_name || 'pending'}</div>
                    <div>Worktree: {job.worktree_path || 'pending'}</div>
                    <ExpandableText text={labCodePatchBody(job)} collapsedLines={4} minToggleChars={180} />
                  </div>
                </SandboxEvidenceDrawer>
              </div>
            )) : (
              <div className="text-xs leading-relaxed text-text-muted">No isolated code patches started yet.</div>
            )}
          </div>
        </details>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <details className="rounded-lg border border-white/[0.06] bg-black/10">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">
            Run history {loadingRunId ? '· loading' : ''}
          </summary>
          <div className="flex gap-2 overflow-x-auto border-t border-white/[0.05] p-3">
            <button
              type="button"
              onClick={() => onSelectRun(null)}
              className={`min-w-[13rem] rounded-lg border px-3 py-2 text-left transition ${!run ? 'border-accent-purple/25 bg-accent-purple/5' : 'border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]'}`}
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current lane</div>
              <div className="mt-1 truncate text-xs font-medium text-text-primary">{liveRun ? labRunShortTitle(liveRun) : 'Ready for next canary'}</div>
              <div className="mt-1 text-[11px] text-text-muted">{liveRun ? `${liveRun.completed_experiments}/${liveRun.total_experiments || 0} checks` : 'No active canary'}</div>
            </button>
            {recentRuns.map(item => {
              const selected = run?.id === item.id;
              const current = liveRun?.id === item.id;
              const chipState = labRunChipState(item, current);
              const tone = martyToneClasses(chipState.tone);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectRun(item.id)}
                  className={`min-w-[13rem] rounded-lg border px-3 py-2 text-left transition ${selected ? `${tone.border} ${tone.soft}` : 'border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.04]'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{current ? 'Current' : formatRelative(item.created_at)}</span>
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.box}`}>{chipState.label}</span>
                  </div>
                  <div className="mt-1 truncate text-xs font-medium text-text-primary">{labRunShortTitle(item)}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{labRunModeLabel(item)} · {item.completed_experiments}/{item.total_experiments || 0} checks</div>
                </button>
              );
            })}
          </div>
        </details>

        <details className="rounded-lg border border-white/[0.06] bg-black/10">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-primary">Readiness details</summary>
          <div className="space-y-2 border-t border-white/[0.05] p-3">
            <div className="text-xs leading-relaxed text-text-muted">{readiness.ok ? 'Ready for a clean canary.' : readinessMessage}</div>
            {canRepairLabQueue && (
              <button
                type="button"
                onClick={() => onRepairReadiness('clear_orphaned_lab_queue')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingAction === 'clear_orphaned_lab_queue' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingAction === 'clear_orphaned_lab_queue' ? 'Clearing stuck work' : 'Clear stuck sandbox work'}
              </button>
            )}
            {canQuarantineLabArtifacts && (
              <button
                type="button"
                onClick={() => onRepairReadiness('quarantine_lab_artifacts')}
                disabled={repairingAction !== null}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingAction === 'quarantine_lab_artifacts' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingAction === 'quarantine_lab_artifacts' ? 'Quarantining artifacts' : 'Quarantine sandbox artifacts'}
              </button>
            )}
            <div className="grid gap-1">
              {readiness.checks.map(check => (
                <div key={check.key} className="rounded border border-white/[0.04] bg-white/[0.02] px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
                  <span className="font-medium text-text-primary">{sandboxCheckLabel(check.key)}:</span> {check.detail}
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}

function MartyLabStatusCard({
  lab,
  onRefresh,
}: {
  lab: MartyLabStatusSnapshot;
  onRefresh: () => void;
}) {
  const [startingMode, setStartingMode] = React.useState<'canary' | null>(null);
  const [startingCodePatchId, setStartingCodePatchId] = React.useState<string | null>(null);
  const [repairingAction, setRepairingAction] = React.useState<MartyLabRepairAction | null>(null);
  const [canceling, setCanceling] = React.useState(false);
  const [deciding, setDeciding] = React.useState<'ship' | 'reject' | null>(null);
  const [reviewingRound, setReviewingRound] = React.useState<'approve_continue' | 'reject_continue' | null>(null);
  const [activePageIndex, setActivePageIndex] = React.useState(0);
  const [focusPrompt, setFocusPrompt] = React.useState('');
  const [viewLab, setViewLab] = React.useState<MartyLabStatusSnapshot | null>(null);
  const [loadingRunId, setLoadingRunId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const liveRun = lab.run;
  const selectedLab = viewLab || lab;
  const run = selectedLab.run;
  const isViewingCurrent = !viewLab || viewLab.run?.id === liveRun?.id;

  React.useEffect(() => {
    if (viewLab?.run?.id && liveRun?.id === viewLab.run.id) setViewLab(null);
  }, [liveRun?.id, viewLab?.run?.id]);

  async function startLab(focusOverride?: string) {
    setStartingMode('canary');
    setError(null);
    try {
      const requestedFocus = (focusOverride ?? focusPrompt).trim();
      await api.startMartyLabRun({
        mode: 'canary',
        round_count: 1,
        candidate_label: 'sandbox-experiment',
        focus_prompt: requestedFocus || undefined,
        queue_if_blocked: true,
      });
      if (!focusOverride) setFocusPrompt('');
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start MARTy Lab');
    } finally {
      setStartingMode(null);
    }
  }

  async function cancelLab() {
    if (!run || !isViewingCurrent || run.status !== 'running') return;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelMartyLabRun(run.id);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel MARTy Lab run');
    } finally {
      setCanceling(false);
    }
  }

  async function decideLab(decision: 'ship' | 'reject') {
    if (!run || !isViewingCurrent) return;
    setDeciding(decision);
    setError(null);
    try {
      await api.decideMartyLabRun(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || `Failed to ${decision} MARTy Lab candidate`);
    } finally {
      setDeciding(null);
    }
  }

  async function reviewRound(decision: 'approve_continue' | 'reject_continue') {
    if (!run || !isViewingCurrent) return;
    setReviewingRound(decision);
    setError(null);
    try {
      await api.reviewMartyLabRound(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to continue MARTy Lab');
    } finally {
      setReviewingRound(null);
    }
  }

  async function repairReadiness(action: MartyLabRepairAction = 'clear_orphaned_lab_queue') {
    setRepairingAction(action);
    setError(null);
    try {
      await api.repairMartyLabReadiness({ action });
      onRefresh();
    } catch (e: any) {
      const fallback = action === 'archive_legacy_full_lab'
        ? 'Failed to archive legacy sandbox run'
        : action === 'quarantine_lab_artifacts'
          ? 'Failed to quarantine sandbox artifacts'
          : 'Failed to clear stuck sandbox work';
      setError(e?.message || fallback);
    } finally {
      setRepairingAction(null);
    }
  }

  async function startCodePatch(item: MartyLabDeepWorkItemRow) {
    if (!run || !isViewingCurrent) return;
    setStartingCodePatchId(item.id);
    setError(null);
    try {
      const requestedFocus = focusPrompt.trim();
      await api.startMartyLabCodePatch(run.id, item.id, {
        focus_prompt: requestedFocus || undefined,
      });
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start isolated code patch');
    } finally {
      setStartingCodePatchId(null);
    }
  }

  async function selectRun(runId: string | null) {
    setError(null);
    if (!runId || runId === liveRun?.id) {
      setViewLab(null);
      setActivePageIndex(0);
      return;
    }
    setLoadingRunId(runId);
    try {
      const snapshot = await api.getMartyLabRun(runId);
      setViewLab(snapshot);
      setActivePageIndex(0);
    } catch (e: any) {
      setError(e?.message || 'Failed to load MARTy Sandbox run');
    } finally {
      setLoadingRunId(null);
    }
  }

  const experiments = selectedLab.experiments || [];
  const versions = selectedLab.versions || [];
  const trials = selectedLab.upgrade_trials || [];
  const deepWorkItems = selectedLab.deep_work_items || [];
  const codePatchJobs = selectedLab.code_patch_jobs || [];
  const queuedRuns = lab.queued_runs || [];
  const recentRuns = lab.recent_runs || [];
  const science = labRecord(run?.summary?.scientific_model);
  const isQuarantined = Boolean(run?.discarded_at || run?.discard_reason);
  const roundTotal = labNumber(science?.rounds, 8);
  const roundSampleSize = labNumber(science?.sample_size_per_round, 10);
  const completed = run?.completed_experiments || 0;
  const total = run?.total_experiments || experiments.length || 0;
  const expectedTotal = total || roundTotal * roundSampleSize;
  const progressPct = expectedTotal > 0 ? Math.round((completed / expectedTotal) * 100) : 0;
  const currentRound = run ? labCurrentRound(run, experiments, roundTotal) : 0;
  const acceptedTrialCount = trials.filter(trial => trial.status === 'accepted').length;
  const rejectedTrialCount = trials.filter(trial => trial.status === 'rejected').length;
  const inconclusiveTrialCount = trials.filter(trial => trial.status === 'inconclusive').length;
  const latestTrial = trials[0] || null;
  const activeTrial = trials.find(trial => trial.status === 'pending') || latestTrial;
  const activeUpgrade = labRecord(activeTrial?.evidence?.upgrade);
  const approvalAssessment = labApprovalAssessment(activeTrial);
  const approvalRationale = labRationaleList(approvalAssessment);
  const activeCandidatePool = labRecord(activeTrial?.evidence?.candidate_pool_summary);
  const activeLeverIds = labEvidenceList(activeUpgrade, 'lever_ids');
  const acceptedBaseline = versions.find(version => version.status === 'accepted') || versions[0] || null;
  const activeFailureClusters = Array.isArray(run?.summary?.active_failure_clusters)
    ? run?.summary?.active_failure_clusters as Array<Record<string, unknown>>
    : [];
  const privacyFailures = experiments.filter(exp => exp.privacy_failure).length;
  const experimentRows = [...experiments].sort((a, b) => {
    const aMeta = labRoundPolicy(a);
    const bMeta = labRoundPolicy(b);
    const aRound = aMeta?.round || 0;
    const bRound = bMeta?.round || 0;
    if (aRound !== bRound) return aRound - bRound;
    return (aMeta?.sample || 0) - (bMeta?.sample || 0);
  });
  const closedExperimentRows = experimentRows.filter(exp => !['queued', 'running'].includes(exp.status));
  const discoveryCompleted = closedExperimentRows.filter(exp => labRoundPolicy(exp)?.role === 'discovery').length;
  const validationCompleted = closedExperimentRows.filter(exp => labRoundPolicy(exp)?.role === 'validation').length;
  const seededExperimentPages = buildMartyLabExperimentPages(experimentRows, trials);
  const runIsCanary = labRunIsCanary(run);
  const visibleRoundTotal = run ? (runIsCanary ? 1 : roundTotal) : seededExperimentPages.length;
  const experimentPages = run
    ? Array.from({ length: Math.max(visibleRoundTotal, seededExperimentPages.length) }, (_, index) => {
      const round = index + 1;
      return seededExperimentPages.find(page => page.round === round) || {
        round,
        trial: null,
        samples: [],
        title: `Experiment ${round}`,
      };
    })
    : seededExperimentPages;
  const pageCount = Math.max(1, experimentPages.length + 1);

  React.useEffect(() => {
    setActivePageIndex(index => Math.min(index, pageCount - 1));
  }, [pageCount, run?.id]);

  const readiness = lab.readiness || emptyMartyLab.readiness;
  const readinessMessage = readiness.blockers[0] || readiness.warnings[0] || 'Ready for a clean controlled run.';
  const blockingKeys = readiness.checks.filter(check => check.status === 'block').map(check => check.key);
  const labQueueBlocker = readiness.checks.find(check => check.key === 'lab_work_queue_clear' && check.status === 'block');
  const artifactIsolationCheck = readiness.checks.find(check => check.key === 'sandbox_artifact_isolation' && check.status !== 'pass');
  const legacyRunBlocker = readiness.checks.find(check => check.key === 'legacy_full_lab_active' && check.status === 'block');
  const labQueueHasStaleRows = Array.isArray((labQueueBlocker?.data as any)?.stale_queue)
    && ((labQueueBlocker?.data as any)?.stale_queue as unknown[]).length > 0;
  const liveRunIsLegacyFullLab = labRunIsLegacyFullLab(liveRun, readiness.harness_version);
  const selectedRunIsLegacyFullLab = labRunIsLegacyFullLab(run, readiness.harness_version);
  const canArchiveLegacyRun = Boolean(isViewingCurrent && liveRun && selectedRunIsLegacyFullLab && liveRunIsLegacyFullLab && legacyRunBlocker);
  const canQuarantineLabArtifacts = Boolean(!liveRun && artifactIsolationCheck);
  const canRepairLabQueue = Boolean(!liveRun && labQueueBlocker);
  const canQueueWhenBlocked = !readiness.ok && blockingKeys.length > 0 && blockingKeys.every(key => [
    'no_active_lab_run',
    'human_decision_required',
    'sandbox_queue_pending',
    'no_active_lab_run_race',
    'one_active_lab_run_per_suite',
    'one_active_lab_run_per_org',
  ].includes(key) || (key === 'lab_work_queue_clear' && Boolean(liveRun) && !labQueueHasStaleRows));
  const startDisabled = Boolean(startingMode || canRepairLabQueue || canArchiveLegacyRun || canQuarantineLabArtifacts || (!readiness.ok && !canQueueWhenBlocked));
  const startVerb = readiness.ok && !liveRun ? 'Start' : 'Queue';
  const currentRunPhase = labRunPhase(run);
  const hasHumanDecision = currentRunPhase === 'human_shipped' || currentRunPhase === 'human_rejected';
  const pausedForRoundReview = Boolean(run?.status === 'running' && currentRunPhase === 'round_inconclusive_needs_review' && run.summary?.needs_human_round_review);
  const decisionDisabled = Boolean(!run || !runIsCanary || selectedRunIsLegacyFullLab || !isViewingCurrent || isQuarantined || run.status === 'running' || run.status === 'configured' || hasHumanDecision || !activeTrial?.candidate_version_id);
  const canShowRunDecision = Boolean(run && runIsCanary && !selectedRunIsLegacyFullLab && labRunNeedsDecision(run) && isViewingCurrent && !pausedForRoundReview && !isQuarantined);
  const activeTrialExperimentPage = experimentPages.find(page => page.trial?.id === activeTrial?.id)
    || (currentRound > 0 ? experimentPages[currentRound - 1] : null)
    || experimentPages[experimentPages.length - 1]
    || null;
  const selectedExperimentPage = activePageIndex > 0 ? experimentPages[activePageIndex - 1] || null : null;
  const viewState = sandboxRunViewState({
    run,
    readiness,
    activeTrial,
    isViewingCurrent,
    isQuarantined,
    pausedForRoundReview,
    canRepairLabQueue,
    canArchiveLegacyRun,
    canQuarantineLabArtifacts,
    runIsCanary,
    completed,
    expectedTotal,
    currentRound,
    roundTotal,
    discoveryCompleted,
    validationCompleted,
  });
  const contextLabel = run
    ? `${labRunModeLabel(run)} · ${isViewingCurrent ? 'current run' : `created ${formatRelative(run.created_at)}`}`
    : readiness.ok ? 'No active experiment' : 'Waiting for the sandbox to clear';
  const experimentProgressPct = runIsCanary
    ? Math.max(0, Math.min(100, Math.round(((Math.min(discoveryCompleted, 3) + Math.min(validationCompleted, 7)) / 10) * 100)))
    : progressPct;
  const experimentProgressLabel = runIsCanary
    ? `${Math.min(discoveryCompleted, 3)}/3 discovery rounds · ${Math.min(validationCompleted, 7)}/7 testing rounds`
    : `${completed.toLocaleString()} of ${expectedTotal.toLocaleString()} checks complete`;

  return (
    <div className="space-y-5">
      <SandboxHeroState
        state={viewState}
        progressPct={run ? experimentProgressPct : null}
        progressLabel={run ? experimentProgressLabel : null}
        contextLabel={contextLabel}
        actions={(
          <>
            {canArchiveLegacyRun && (
              <button
                type="button"
                onClick={() => repairReadiness('archive_legacy_full_lab')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'archive_legacy_full_lab' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'archive_legacy_full_lab' ? 'Archiving...' : 'Archive legacy run'}
              </button>
            )}
            {canQuarantineLabArtifacts && (
              <button
                type="button"
                onClick={() => repairReadiness('quarantine_lab_artifacts')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'quarantine_lab_artifacts' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'quarantine_lab_artifacts' ? 'Quarantining...' : 'Quarantine artifacts'}
              </button>
            )}
            {canRepairLabQueue && (
              <button
                type="button"
                onClick={() => repairReadiness('clear_orphaned_lab_queue')}
                disabled={repairingAction !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/15 disabled:opacity-50"
              >
                {repairingAction === 'clear_orphaned_lab_queue' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {repairingAction === 'clear_orphaned_lab_queue' ? 'Clearing...' : 'Clear stuck work'}
              </button>
            )}
            {!isViewingCurrent && (
              <button
                type="button"
                onClick={() => selectRun(null)}
                className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-white/[0.04]"
              >
                Back to current
              </button>
            )}
            {run?.status === 'running' && isViewingCurrent && !canArchiveLegacyRun && (
              <button
                type="button"
                onClick={cancelLab}
                disabled={canceling}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-3 py-2 text-xs font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                <XIcon size={13} /> {canceling ? 'Canceling...' : 'Cancel'}
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-white/[0.04]"
            >
              Refresh
            </button>
          </>
        )}
      />

      {error && (
        <div className="rounded-lg border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs text-semantic-error">
          {error}
        </div>
      )}

      <SandboxFocusComposer
        value={focusPrompt}
        onChange={setFocusPrompt}
        onStart={() => startLab()}
        startDisabled={startDisabled}
        startVerb={startVerb}
        startingMode={startingMode}
        isBusy={Boolean(liveRun || queuedRuns.length > 0 || !readiness.ok)}
      />

      {run && canArchiveLegacyRun ? (
        <section className="rounded-xl border border-semantic-warning/20 bg-semantic-warning/5 p-5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-semantic-warning">Cleanup required</div>
          <h4 className="mt-1 text-2xl font-semibold text-text-primary">Old full lab is blocking clean experiments</h4>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-secondary">
            This run came from the retired full-lab harness. Archive it to clear the sandbox lane. The action only discards the stale lab record; it does not ship or reject a MARTy upgrade.
          </p>
          <SandboxEvidenceDrawer title="Legacy run details">
            <div className="space-y-2 text-xs leading-relaxed text-text-secondary">
              <div>Run: {run.id}</div>
              <div>Harness: {labRunHarnessVersion(run) || 'Legacy harness'}</div>
              <div>Phase: {labRunPhaseLabel(labRunPhase(run))}</div>
              {run.discard_reason && <div>{run.discard_reason}</div>}
            </div>
          </SandboxEvidenceDrawer>
        </section>
      ) : run ? (
        <SandboxRunPager
          pageIndex={activePageIndex}
          pageCount={pageCount}
          onPrev={() => setActivePageIndex(index => Math.max(0, index - 1))}
          onNext={() => setActivePageIndex(index => Math.min(pageCount - 1, index + 1))}
          onSelect={setActivePageIndex}
        >
          {activePageIndex === 0 ? (
            <SandboxCoverPage
              run={run}
              runIsCanary={runIsCanary}
              currentRound={currentRound}
              roundTotal={roundTotal}
              visibleRoundTotal={visibleRoundTotal}
              completed={completed}
              expectedTotal={expectedTotal}
              progressPct={progressPct}
              acceptedTrialCount={acceptedTrialCount}
              rejectedTrialCount={rejectedTrialCount}
              inconclusiveTrialCount={inconclusiveTrialCount}
              privacyFailures={privacyFailures}
              activeTrial={activeTrial}
              activeExperimentPage={activeTrialExperimentPage}
              activeUpgrade={activeUpgrade}
              activeLeverIds={activeLeverIds}
              activeCandidatePool={activeCandidatePool}
              acceptedBaseline={acceptedBaseline}
              approvalRationale={approvalRationale}
              pausedForRoundReview={pausedForRoundReview}
              canShowRunDecision={canShowRunDecision}
              decisionDisabled={decisionDisabled}
              deciding={deciding}
              reviewingRound={reviewingRound}
              onDecide={decideLab}
              onReview={reviewRound}
            />
          ) : selectedExperimentPage ? (
            <SandboxExperimentPage
              page={selectedExperimentPage}
              expectedSamples={roundSampleSize}
            />
          ) : (
            <div className="rounded-lg border border-white/[0.06] bg-black/10 p-5 text-sm text-text-muted">No experiment selected.</div>
          )}
        </SandboxRunPager>
      ) : (
        <section className="rounded-xl border border-white/[0.08] bg-white/[0.015] p-5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Experiment</div>
          <h4 className="mt-1 text-2xl font-semibold text-text-primary">No active experiment</h4>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-text-secondary">
            {canQuarantineLabArtifacts
              ? 'Quarantine old sandbox artifacts above before starting a clean experiment.'
              : canRepairLabQueue
                ? 'Clear the stuck sandbox work above before starting another clean experiment.'
                : 'Start a focused experiment for one controlled improvement, or queue the next experiment focus.'}
          </p>
        </section>
      )}
    </div>
  );
}

function MartyLabStatusCardLegacy({
  lab,
  onRefresh,
}: {
  lab: MartyLabStatusSnapshot;
  onRefresh: () => void;
}) {
  const [startingMode, setStartingMode] = React.useState<'canary' | null>(null);
  const [startingCodePatchId, setStartingCodePatchId] = React.useState<string | null>(null);
  const [repairingReadiness, setRepairingReadiness] = React.useState(false);
  const [canceling, setCanceling] = React.useState(false);
  const [deciding, setDeciding] = React.useState<'ship' | 'reject' | null>(null);
  const [reviewingRound, setReviewingRound] = React.useState<'approve_continue' | 'reject_continue' | null>(null);
  const [activePageIndex, setActivePageIndex] = React.useState(0);
  const [focusPrompt, setFocusPrompt] = React.useState('');
  const [viewLab, setViewLab] = React.useState<MartyLabStatusSnapshot | null>(null);
  const [loadingRunId, setLoadingRunId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const liveRun = lab.run;
  const selectedLab = viewLab || lab;
  const run = selectedLab.run;
  const isViewingCurrent = !viewLab || viewLab.run?.id === liveRun?.id;

  React.useEffect(() => {
    if (viewLab?.run?.id && liveRun?.id === viewLab.run.id) setViewLab(null);
  }, [liveRun?.id, viewLab?.run?.id]);

  async function startLab(focusOverride?: string) {
    setStartingMode('canary');
    setError(null);
    try {
      const requestedFocus = (focusOverride ?? focusPrompt).trim();
      await api.startMartyLabRun({
        mode: 'canary',
        round_count: 1,
        candidate_label: 'sandbox-canary',
        focus_prompt: requestedFocus || undefined,
        queue_if_blocked: true,
      });
      if (!focusOverride) setFocusPrompt('');
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start MARTy Lab');
    } finally {
      setStartingMode(null);
    }
  }

  async function cancelLab() {
    if (!run || !isViewingCurrent || run.status !== 'running') return;
    setCanceling(true);
    setError(null);
    try {
      await api.cancelMartyLabRun(run.id);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to cancel MARTy Lab run');
    } finally {
      setCanceling(false);
    }
  }

  async function decideLab(decision: 'ship' | 'reject') {
    if (!run || !isViewingCurrent) return;
    setDeciding(decision);
    setError(null);
    try {
      await api.decideMartyLabRun(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || `Failed to ${decision} MARTy Lab candidate`);
    } finally {
      setDeciding(null);
    }
  }

  async function reviewRound(decision: 'approve_continue' | 'reject_continue') {
    if (!run || !isViewingCurrent) return;
    setReviewingRound(decision);
    setError(null);
    try {
      await api.reviewMartyLabRound(run.id, decision);
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to continue MARTy Lab');
    } finally {
      setReviewingRound(null);
    }
  }

  async function repairReadiness() {
    setRepairingReadiness(true);
    setError(null);
    try {
      await api.repairMartyLabReadiness({ action: 'clear_orphaned_lab_queue' });
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to repair MARTy Sandbox readiness');
    } finally {
      setRepairingReadiness(false);
    }
  }

  async function startCodePatch(item: MartyLabDeepWorkItemRow) {
    if (!run || !isViewingCurrent) return;
    setStartingCodePatchId(item.id);
    setError(null);
    try {
      const requestedFocus = focusPrompt.trim();
      await api.startMartyLabCodePatch(run.id, item.id, {
        focus_prompt: requestedFocus || undefined,
      });
      onRefresh();
    } catch (e: any) {
      setError(e?.message || 'Failed to start isolated code-patch lane');
    } finally {
      setStartingCodePatchId(null);
    }
  }

  async function selectRun(runId: string | null) {
    setError(null);
    if (!runId || runId === liveRun?.id) {
      setViewLab(null);
      setActivePageIndex(0);
      return;
    }
    setLoadingRunId(runId);
    try {
      const snapshot = await api.getMartyLabRun(runId);
      setViewLab(snapshot);
      setActivePageIndex(0);
    } catch (e: any) {
      setError(e?.message || 'Failed to load MARTy Lab run');
    } finally {
      setLoadingRunId(null);
    }
  }

  const experiments = selectedLab.experiments || [];
  const versions = selectedLab.versions || [];
  const trials = selectedLab.upgrade_trials || [];
  const deepWorkItems = selectedLab.deep_work_items || [];
  const codePatchJobs = selectedLab.code_patch_jobs || [];
  const queuedRuns = lab.queued_runs || [];
  const recentRuns = lab.recent_runs || [];
  const science = labRecord(run?.summary?.scientific_model);
  const isQuarantined = Boolean(run?.discarded_at || run?.discard_reason);
  const roundTotal = labNumber(science?.rounds, 8);
  const roundSampleSize = labNumber(science?.sample_size_per_round, 10);
  const validationPerRound = labNumber(science?.validation_conversations_per_round, 7);
  const discoveryPerRound = labNumber(science?.discovery_conversations_per_round, 1);
  const candidatePoolSize = labNumber(science?.candidate_pool_size, 5);
  const minCodeBackedCandidates = labNumber(science?.min_code_backed_candidates, 3);
  const completed = run?.completed_experiments || 0;
  const total = run?.total_experiments || experiments.length || 0;
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const currentRound = run ? labCurrentRound(run, experiments, roundTotal) : 0;
  const acceptedTrialCount = trials.filter(trial => trial.status === 'accepted').length;
  const rejectedTrialCount = trials.filter(trial => trial.status === 'rejected').length;
  const inconclusiveTrialCount = trials.filter(trial => trial.status === 'inconclusive').length;
  const decidedTrialCount = acceptedTrialCount + rejectedTrialCount + inconclusiveTrialCount;
  const latestTrial = trials[0] || null;
  const activeTrial = trials.find(trial => trial.status === 'pending') || latestTrial;
  const summaryText = labSummaryText(run?.summary);
  const autopilot = run?.summary?.autopilot && typeof run.summary.autopilot === 'object'
    ? run.summary.autopilot as Record<string, unknown>
    : null;
  const autopilotEnabled = autopilot?.enabled === true;
  const nextRunAfter = typeof autopilot?.next_run_after === 'string' ? autopilot.next_run_after : null;
  const activeFailureClusters = Array.isArray(run?.summary?.active_failure_clusters)
    ? run?.summary?.active_failure_clusters as Array<Record<string, unknown>>
    : [];
  const experimentRows = [...experiments].sort((a, b) => {
    const aMeta = labRoundPolicy(a);
    const bMeta = labRoundPolicy(b);
    const aRound = aMeta?.round || 0;
    const bRound = bMeta?.round || 0;
    if (aRound !== bRound) return aRound - bRound;
    return (aMeta?.sample || 0) - (bMeta?.sample || 0);
  });
  const seededExperimentPages = buildMartyLabExperimentPages(experimentRows, trials);
  const inferredRunIsCanary = Boolean(run && (run.upgrade_variable?.mode === 'canary' || run.suite_name.includes('canary')));
  const visibleRoundTotal = run ? (inferredRunIsCanary ? 1 : roundTotal) : seededExperimentPages.length;
  const experimentPages = run
    ? Array.from({ length: Math.max(visibleRoundTotal, seededExperimentPages.length) }, (_, index) => {
      const round = index + 1;
      return seededExperimentPages.find(page => page.round === round) || {
        round,
        trial: null,
        samples: [],
        title: `Experiment ${round}`,
      };
    })
    : seededExperimentPages;
  const pageCount = Math.max(1, experimentPages.length + 1);
  React.useEffect(() => {
    setActivePageIndex(index => Math.min(index, pageCount - 1));
  }, [pageCount, run?.id]);
  const activeLocal = labRecord(activeTrial?.evidence?.local_validation);
  const activeLocalSummary = labRecord(activeLocal?.summary);
  const activeUpgrade = labRecord(activeTrial?.evidence?.upgrade);
  const approvalAssessment = labApprovalAssessment(activeTrial);
  const approvalTarget = labRecord(approvalAssessment?.target);
  const approvalRegressions = labRecord(approvalAssessment?.regressions);
  const approvalRationale = labRationaleList(approvalAssessment);
  const activeCandidatePool = labRecord(activeTrial?.evidence?.candidate_pool_summary);
  const activeLeverIds = labEvidenceList(activeUpgrade, 'lever_ids');
  const acceptedBaseline = versions.find(version => version.status === 'accepted') || versions[0] || null;
  const readiness = lab.readiness || emptyMartyLab.readiness;
  const readinessTone = readiness.ok
    ? readiness.warnings.length > 0 ? 'warn' : 'good'
    : 'bad';
  const readinessMessage = readiness.blockers[0] || readiness.warnings[0] || 'Ready for a clean controlled run.';
  const blockingKeys = readiness.checks.filter(check => check.status === 'block').map(check => check.key);
  const labQueueBlocker = readiness.checks.find(check => check.key === 'lab_work_queue_clear' && check.status === 'block');
  const canRepairLabQueue = Boolean(!run && labQueueBlocker);
  const canQueueWhenBlocked = !readiness.ok && blockingKeys.length > 0 && blockingKeys.every(key => [
    'no_active_lab_run',
    'lab_work_queue_clear',
    'human_decision_required',
    'sandbox_queue_pending',
    'no_active_lab_run_race',
    'one_active_lab_run_per_suite',
  ].includes(key));
  const startDisabled = Boolean(startingMode || (!readiness.ok && !canQueueWhenBlocked));
  const startVerb = readiness.ok ? 'Start' : 'Queue';
  const currentRunPhase = labRunPhase(run);
  const hasHumanDecision = currentRunPhase === 'human_shipped' || currentRunPhase === 'human_rejected';
  const decisionDisabled = Boolean(!run || !isViewingCurrent || isQuarantined || run.status === 'running' || run.status === 'configured' || hasHumanDecision || !activeTrial?.candidate_version_id);
  const selectedExperimentPage = activePageIndex > 0 ? experimentPages[activePageIndex - 1] || null : null;
  const selectedExperimentStats = selectedExperimentPage ? martyLabExperimentStats(selectedExperimentPage, roundSampleSize) : null;
  const activeTrialExperimentPage = experimentPages.find(page => page.trial?.id === activeTrial?.id) || experimentPages[experimentPages.length - 1] || null;
  const pausedForRoundReview = Boolean(run?.status === 'running' && currentRunPhase === 'round_inconclusive_needs_review' && run.summary?.needs_human_round_review);
  const pausedReview = labRecord(run?.summary?.needs_human_round_review);
  const stateCopy = labRunStateCopy(run, {
    activeTrial,
    isQuarantined,
    isViewingCurrent,
	    pausedForRoundReview,
	    completed,
	    total,
	    currentRound,
	    roundTotal,
	    readinessOk: readiness.ok,
	    readinessMessage,
	  });
  const stateTone = martyToneClasses(stateCopy.tone);
  const selectedRunChip = run ? labRunChipState(run, isViewingCurrent) : null;
  const selectedRunTone = selectedRunChip ? martyToneClasses(selectedRunChip.tone) : martyToneClasses(readiness.ok ? 'good' : 'warn');
  const expectedTotal = total || roundTotal * roundSampleSize;
  const runIsCanary = inferredRunIsCanary;
  const canShowRunDecision = Boolean(run && labRunNeedsDecision(run) && !pausedForRoundReview);
  const laneMessage = readiness.ok
    ? 'Ready for a clean controlled run.'
    : canQueueWhenBlocked
      ? 'A run is already active. New requests will wait in the queue until the current run gets a Ship or Reject decision.'
      : readinessMessage;
  const labQueueBlockerQueue = Array.isArray(labRecord(labQueueBlocker?.data)?.queue)
    ? labRecord(labQueueBlocker?.data)?.queue as Array<Record<string, unknown>>
    : [];

  return (
    <div className="card p-5 space-y-4">
      <div className={`rounded-xl border ${stateTone.border} bg-white/[0.02] p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className={`text-[11px] font-semibold uppercase tracking-wide ${stateTone.text}`}>{stateCopy.eyebrow}</div>
            <div className="mt-1 text-xl font-semibold leading-tight text-text-primary">{stateCopy.title}</div>
            <div className="mt-2 max-w-4xl text-sm leading-relaxed text-text-secondary">{stateCopy.body}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {run && <MartyLabStatusPill status={run.status} />}
              {selectedRunChip && (
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${selectedRunTone.box}`}>
                  {selectedRunChip.label}
                </span>
              )}
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                {run ? labRunModeLabel(run) : readiness.ok ? 'Ready' : 'Waiting'}
              </span>
              {run && (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                  Experiment {currentRound}/{roundTotal}
                </span>
              )}
              {autopilotEnabled && (
                <span className="rounded-full border border-accent-purple/30 bg-accent-purple/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-purple">
                  Autopilot
                </span>
              )}
              {!isViewingCurrent && (
                <button
                  type="button"
                  onClick={() => selectRun(null)}
                  className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary hover:bg-white/[0.05]"
                >
                  Back to current run
                </button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canRepairLabQueue && (
              <button
                type="button"
                onClick={repairReadiness}
                disabled={repairingReadiness}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-2.5 py-1.5 text-[11px] text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                {repairingReadiness ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {repairingReadiness ? 'Clearing...' : 'Clear stuck queue'}
              </button>
            )}
            {run?.status === 'running' && isViewingCurrent && (
              <button
                type="button"
                onClick={cancelLab}
                disabled={canceling}
                className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-2.5 py-1.5 text-[11px] text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
              >
                <XIcon size={12} /> {canceling ? 'Canceling...' : 'Cancel'}
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-white/[0.04]"
            >
              Refresh
            </button>
          </div>
        </div>
        {run && (
          <div className="mt-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-text-muted">
              <span>{completed.toLocaleString()} of {expectedTotal.toLocaleString()} checks complete</span>
              <span>{isViewingCurrent ? 'Current run' : `Viewing history from ${formatRelative(run.created_at)}`}</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs text-semantic-error">
          {error}
        </div>
      )}

      {canRepairLabQueue && (
        <div className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/5 px-3 py-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-text-primary">Queue cleanup available</div>
              <div className="mt-1 max-w-3xl text-xs leading-relaxed text-text-secondary">
                The sandbox found leftover lab queue work, but there is no active lab run attached to it. Clearing it moves only retryable MARTy Lab queue rows to review history so a clean run can start.
              </div>
              {labQueueBlockerQueue.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {labQueueBlockerQueue.map((row, index) => (
                    <span key={`${String(row.domain || 'lab')}-${String(row.status || index)}`} className="rounded-full border border-semantic-warning/15 bg-semantic-warning/10 px-2 py-0.5 text-[10px] text-semantic-warning">
                      {titleizeLabValue(row.domain)} · {titleizeLabValue(row.status)} · {String(row.count || 0)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={repairReadiness}
              disabled={repairingReadiness}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-semantic-warning/25 px-2 py-1 text-[10px] font-medium text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
            >
              {repairingReadiness ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {repairingReadiness ? 'Clearing' : 'Clear stuck queue'}
            </button>
          </div>
        </div>
      )}

      {!run ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Sandbox cover</div>
          <div className="mt-1 text-lg font-semibold text-text-primary">No active lab run</div>
          <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
            {laneMessage} Start a focused canary for one controlled improvement, or queue the next canary focus.
          </div>
        </div>
      ) : (
        <MartyLabPageShell
          pageIndex={activePageIndex}
          pageCount={pageCount}
          onPrev={() => setActivePageIndex(index => Math.max(0, index - 1))}
          onNext={() => setActivePageIndex(index => Math.min(pageCount - 1, index + 1))}
          onSelect={setActivePageIndex}
        >
          {activePageIndex === 0 ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    {runIsCanary ? 'Canary run cover' : 'Legacy full lab run cover'}
                  </div>
                  <div className="mt-1 text-lg font-semibold text-text-primary">{activeTrial?.title || run.upgrade_title || labRunShortTitle(run)}</div>
                  {activeTrialExperimentPage && (
                    <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">{labExperimentTagline(activeTrialExperimentPage)}</div>
                  )}
                  <div className="mt-1 max-w-3xl text-xs leading-relaxed text-text-muted">
                    {pausedForRoundReview
                      ? 'The full lab is paused on an inconclusive experiment. Review the evidence, then continue without shipping or reject this experiment and continue.'
                      : run.status === 'running'
                      ? runIsCanary
                        ? 'Three discovery chats find a real weakness, then seven validation chats compare one candidate against the accepted baseline.'
                        : 'Eight controlled rounds run in sequence; each round discovers one weakness, validates one candidate, and compounds only approved improvements.'
                      : run.summary?.conclusion
                        ? String(run.summary.conclusion)
                        : 'The run is closed and ready for review.'}
                  </div>
                  {typeof run.summary?.focus_prompt === 'string' && run.summary.focus_prompt.trim() && (
                    <div className="mt-2 rounded-md border border-accent-purple/15 bg-accent-purple/5 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                      <span className="font-medium text-text-primary">Focus:</span> {run.summary.focus_prompt}
                    </div>
                  )}
                </div>
                {pausedForRoundReview ? (
                  <MartyLabRoundReviewButtons
                    disabled={reviewingRound !== null}
                    reviewing={reviewingRound}
                    onReview={reviewRound}
                  />
                ) : canShowRunDecision ? (
                  <MartyLabDecisionButtons disabled={decisionDisabled} deciding={deciding} onDecide={decideLab} />
                ) : null}
              </div>

              {pausedForRoundReview && (
                <div className="rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs leading-relaxed text-semantic-warning">
                  Paused after experiment {String(pausedReview?.round_index || '—')}. Approve and continue keeps the current baseline and starts the next experiment. Reject experiment also keeps the current baseline, marks this candidate rejected, and starts the next experiment.
                </div>
              )}

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)]">
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Run progress</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <MartyLabMiniStat label="Experiments" value={`${currentRound}/${roundTotal}`} tone={run.status === 'running' ? 'purple' : 'default'} />
                    <MartyLabMiniStat label="Checks" value={`${completed}/${expectedTotal}`} />
                    <MartyLabMiniStat label="Decided" value={`${decidedTrialCount}/${runIsCanary ? 1 : roundTotal}`} tone={decidedTrialCount > 0 ? 'good' : 'default'} />
                  </div>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Run decisions</div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <MartyLabMiniStat label="Ship-ready" value={acceptedTrialCount.toLocaleString()} tone="good" />
                    <MartyLabMiniStat label="Rejected" value={rejectedTrialCount.toLocaleString()} tone={rejectedTrialCount > 0 ? 'warn' : 'default'} />
                    <MartyLabMiniStat label="Review" value={inconclusiveTrialCount.toLocaleString()} tone={inconclusiveTrialCount > 0 ? 'warn' : 'default'} />
                  </div>
                </div>
              </div>

              {(run.privacy_failures || 0) > 0 && (
                <div className="rounded-lg border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs leading-relaxed text-semantic-error">
                  Privacy review found {run.privacy_failures.toLocaleString()} issue{run.privacy_failures === 1 ? '' : 's'} in this run.
                </div>
              )}

              <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                <div className="text-xs font-medium text-text-primary">{run.status === 'running' ? 'Current experiment' : 'Latest decision'}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <div className="text-sm font-medium text-text-primary">{String(approvalAssessment?.label || titleizeLabValue(activeTrial?.status || 'Pending'))}</div>
                  {activeTrial && <MartyLabStatusPill status={activeTrial.status} />}
                  {typeof approvalAssessment?.recommendation === 'string' && (
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-text-muted">{titleizeLabValue(approvalAssessment.recommendation)}</span>
                  )}
                </div>
                <div className="mt-2 text-xs leading-relaxed text-text-secondary">
                  {activeTrial?.conclusion || labTrialDecisionText(activeTrial)}
                </div>
              </div>

              <details className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-text-primary">Evidence details</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid gap-2 md:grid-cols-4">
                    <MartyLabMiniStat label="Approval score" value={approvalAssessment ? String(approvalAssessment.approval_score ?? '—') : '—'} tone={activeTrial?.status === 'accepted' ? 'good' : activeTrial?.status === 'rejected' ? 'bad' : 'warn'} />
                    <MartyLabMiniStat label="Valid signal" value={`${activeTrial?.valid_sample_size || labNumber(approvalAssessment?.valid_samples, 0)}/${validationPerRound}`} tone={(activeTrial?.valid_sample_size || 0) >= 5 ? 'good' : 'warn'} />
                    <MartyLabMiniStat label="Wins / losses" value={`${activeTrial?.wins || 0}/${activeTrial?.losses || 0}`} tone={(activeTrial?.wins || 0) > (activeTrial?.losses || 0) ? 'good' : 'warn'} />
                    <MartyLabMiniStat label="Target delta" value={approvalTarget?.average_delta !== undefined ? labDeltaText(Number(approvalTarget.average_delta)) : labDeltaText(activeTrial?.target_average_delta ?? null)} tone={(Number(approvalTarget?.average_delta ?? activeTrial?.target_average_delta ?? 0) > 0) ? 'good' : 'default'} />
                  </div>
                  {approvalRationale.length > 0 && (
                    <div className="grid gap-2 md:grid-cols-2">
                      {approvalRationale.map((item, index) => (
                        <div key={index} className="rounded-md border border-white/[0.04] bg-black/10 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                          {item}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-[11px] leading-relaxed text-text-muted">
                    Small unrelated losses: {String(approvalRegressions?.small_non_target_losses ?? 0)} · meaningful non-target losses: {String(approvalRegressions?.meaningful_non_target_losses ?? 0)} · severe: {String(activeTrial?.severe_regressions ?? 0)}
                  </div>
                  {acceptedBaseline && (
                    <div className="rounded-md border border-white/[0.04] bg-black/10 px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current baseline</div>
                      <div className="mt-1 text-xs font-medium text-text-primary line-clamp-1">{acceptedBaseline.label}</div>
                      <div className="mt-0.5 text-[11px] text-text-muted">Generation {acceptedBaseline.generation.toLocaleString()}</div>
                    </div>
                  )}
                  {(activeLeverIds.length > 0 || activeCandidatePool) && (
                    <div className="rounded-md border border-white/[0.04] bg-black/10 px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Candidate</div>
                      {activeCandidatePool && (
                        <div className="mt-1 text-[11px] text-text-muted">
                          Rank {String(activeCandidatePool.selected_rank || '—')} of {String(activeCandidatePool.candidate_count || candidatePoolSize)}
                          {' '}· code-backed {String(activeCandidatePool.code_backed_candidate_count || 0)}/{String(activeCandidatePool.required_code_backed_candidates || minCodeBackedCandidates)}
                        </div>
                      )}
                      {activeLeverIds.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {activeLeverIds.map(leverId => (
                            <span key={leverId} className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-text-muted">{leverId}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </details>
            </div>
          ) : selectedExperimentPage ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    Experiment {selectedExperimentPage.round} of {experimentPages.length}
                  </div>
                  <div className="mt-1 max-w-4xl text-lg font-semibold leading-snug text-text-primary">{selectedExperimentPage.title}</div>
                  <div className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">{labExperimentTagline(selectedExperimentPage)}</div>
                  <div className="mt-1 text-xs text-text-muted">
                    {(selectedExperimentStats?.closedSamples ?? 0).toLocaleString()}/{(selectedExperimentStats?.totalSamples ?? roundSampleSize).toLocaleString()} checks complete · {selectedExperimentStats?.decision || 'Pending'}
                  </div>
                </div>
                {selectedExperimentPage.trial && <MartyLabStatusPill status={selectedExperimentPage.trial.status} />}
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)]">
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Experiment progress</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <MartyLabMiniStat label="Checks complete" value={`${selectedExperimentStats?.closedSamples ?? 0}/${selectedExperimentStats?.totalSamples ?? roundSampleSize}`} />
                    <MartyLabMiniStat label="Validation graded" value={`${selectedExperimentStats?.validSamples ?? 0}/${selectedExperimentStats?.validationTotal ?? validationPerRound}`} />
                    <MartyLabMiniStat label="Decision" value={selectedExperimentStats?.decision || 'Pending'} tone={selectedExperimentPage.trial?.status === 'accepted' ? 'good' : selectedExperimentPage.trial?.status === 'rejected' ? 'bad' : selectedExperimentPage.trial?.status === 'inconclusive' ? 'warn' : 'default'} />
                  </div>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-black/10 p-3">
                  <div className="text-xs font-medium text-text-primary">Validation outcome</div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <MartyLabMiniStat label="Wins" value={(selectedExperimentStats?.wins ?? 0).toLocaleString()} tone="good" />
                    <MartyLabMiniStat label="Losses" value={(selectedExperimentStats?.losses ?? 0).toLocaleString()} tone={(selectedExperimentStats?.losses ?? 0) > 0 ? 'warn' : 'default'} />
                    <MartyLabMiniStat label="Avg lift" value={labDeltaText(selectedExperimentStats?.averageDelta ?? null)} tone={(selectedExperimentStats?.averageDelta ?? 0) > 0 ? 'good' : (selectedExperimentStats?.averageDelta ?? 0) < 0 ? 'bad' : 'default'} />
                  </div>
                </div>
              </div>

              <div className="max-h-[36rem] overflow-y-auto rounded-lg border border-white/[0.04] bg-white/[0.01] p-2">
                <div className="grid gap-2 xl:grid-cols-2">
                  {selectedExperimentPage.samples.length > 0 ? (
                    selectedExperimentPage.samples.map(sample => (
                      <MartyLabRoundSampleCard key={sample.id} sample={sample} />
                    ))
                  ) : (
                    <div className="rounded-lg border border-white/[0.04] bg-black/10 p-4 text-sm leading-relaxed text-text-muted xl:col-span-2">
                      This experiment has not started yet. It will fill with three discovery cards and seven validation cards when the lab reaches this step.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-text-muted">No experiment selected.</div>
          )}
        </MartyLabPageShell>
      )}

      <details className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-text-primary">
          <span>Controls, queue, and history</span>
          <span className="text-[11px] font-normal text-text-muted">{queuedRuns.length} queued</span>
        </summary>
        <div className="space-y-4 border-t border-white/[0.04] p-3">
          <div>
            <div className="text-xs font-medium text-text-primary">Focus the next run</div>
            <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
              Add a concrete problem or target area. If a run is active, this request waits for the current run to get Ship or Reject.
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={focusPrompt}
                onChange={event => setFocusPrompt(event.target.value)}
                placeholder="Example: I had a problem with Excel artifacts missing formulas. Focus on that."
                className="min-w-[18rem] flex-1 rounded-lg border border-white/10 bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-magenta/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => startLab()}
                disabled={startDisabled}
                className="inline-flex items-center gap-1 rounded-lg border border-accent-magenta/25 px-2.5 py-1.5 text-[11px] text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
              >
                <Sparkles size={12} /> {startingMode === 'canary' ? `${startVerb}ing...` : `${startVerb} canary`}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.04] bg-black/10 px-3 py-2 text-xs leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Queue state:</span> {laneMessage}
            {readiness.ok && readiness.warnings.length > 0 ? ` Warning: ${readiness.warnings[0]}` : ''}
          </div>

          {queuedRuns.length > 0 && (
            <div>
              <div className="text-xs font-medium text-text-primary">Queued runs</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {queuedRuns.map((queued, index) => (
                  <div key={queued.id} className="rounded-md border border-white/[0.05] bg-black/10 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-text-primary">{index === 0 ? 'Next' : `Queued ${index + 1}`}</div>
                      <MartyLabStatusPill status={queued.status} />
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">
                      {queued.upgrade_variable?.mode === 'canary' ? 'Canary' : 'Legacy full lab'} · {queued.total_experiments.toLocaleString()} checks
                    </div>
                    {typeof queued.summary?.focus_prompt === 'string' && queued.summary.focus_prompt.trim() && (
                      <ExpandableText
                        text={queued.summary.focus_prompt}
                        collapsedLines={2}
                        minToggleChars={110}
                        className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {recentRuns.length > 0 && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium text-text-primary">Past runs</div>
                {loadingRunId && <div className="text-[11px] text-text-muted">Loading run...</div>}
              </div>
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => selectRun(null)}
                  className={`min-w-[14rem] rounded-lg border px-3 py-2 text-left transition ${!run ? `${stateTone.border} ${stateTone.soft}` : 'border-white/[0.05] bg-black/10 hover:bg-white/[0.03]'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current run</span>
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${martyToneClasses(readiness.ok ? 'good' : 'warn').box}`}>
                      {readiness.ok ? 'Ready' : 'Waiting'}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs font-medium text-text-primary">Next canary</div>
                  <div className="mt-1 text-[11px] text-text-muted">Single controlled run at a time</div>
                </button>
                {recentRuns.map(item => {
                  const selected = run?.id === item.id;
                  const current = liveRun?.id === item.id;
                  const chipState = labRunChipState(item, current);
                  const tone = martyToneClasses(chipState.tone);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectRun(item.id)}
                      className={`min-w-[14rem] rounded-lg border px-3 py-2 text-left transition ${selected ? `${tone.border} ${tone.soft}` : 'border-white/[0.05] bg-black/10 hover:bg-white/[0.03]'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{current ? 'Current run' : formatRelative(item.created_at)}</span>
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.box}`}>{chipState.label}</span>
                      </div>
                      <div className="mt-1 truncate text-xs font-medium text-text-primary">{labRunShortTitle(item)}</div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {labRunModeLabel(item)} · {item.completed_experiments}/{item.total_experiments || 0} closed
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isQuarantined && (
            <div className="rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs leading-relaxed text-semantic-warning">
              This lab run is archived and should not drive Ship or Reject decisions. {run?.discard_reason || 'Its scorecards are kept only as historical context.'}
            </div>
          )}
        </div>
      </details>

      {(run && codePatchJobs.length > 0) && (
        <details className="rounded-lg border border-white/[0.06] bg-white/[0.02]">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-text-primary">Code Patch Lane</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                Isolated engineering briefs for Deep Work. These do not deploy or ship MARTy until a human reviews the patch and reruns a canary.
              </div>
            </div>
            <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-text-secondary">
              {codePatchJobs.length} job{codePatchJobs.length === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="grid max-h-[22rem] gap-2 overflow-y-auto border-t border-white/[0.06] p-3 pr-1 lg:grid-cols-2">
            {codePatchJobs.map(job => (
              <div key={job.id} className="rounded-md border border-white/[0.06] bg-black/10 px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium leading-snug text-text-primary">{job.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                      <span>{labCodePatchStatusLabel(job.status)}</span>
                      <span>·</span>
                      <span>{titleizeLabValue(job.priority)}</span>
                      <span>·</span>
                      <span>{job.model}</span>
                    </div>
                  </div>
                  <span className="shrink-0 rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">
                    No deploy
                  </span>
                </div>
                <div className="mt-2 grid gap-1.5 text-[11px] text-text-muted sm:grid-cols-2">
                  <div className="rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1">
                    Branch: <span className="text-text-secondary">{job.branch_name || 'pending'}</span>
                  </div>
                  <div className="rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1">
                    Worktree: <span className="text-text-secondary">{job.worktree_path || 'pending'}</span>
                  </div>
                </div>
                <ExpandableText
                  text={labCodePatchBody(job)}
                  collapsedLines={4}
                  minToggleChars={180}
                  className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                />
              </div>
            ))}
          </div>
        </details>
      )}

      {(run && (deepWorkItems.length > 0 || activeFailureClusters.length > 0)) && (
        <details className="rounded-lg border border-semantic-warning/20 bg-semantic-warning/5">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
            <div>
              <div className="text-xs font-medium text-text-primary">Deep Work</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                Engineering follow-up found by the lab. These items need a focused canary or lab before they can ship.
              </div>
            </div>
            <span className="shrink-0 rounded-md border border-semantic-warning/20 bg-semantic-warning/10 px-2 py-1 text-[10px] font-medium text-semantic-warning">
              {deepWorkItems.length || activeFailureClusters.length} item{(deepWorkItems.length || activeFailureClusters.length) === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="grid max-h-[24rem] gap-2 overflow-y-auto border-t border-semantic-warning/10 p-3 pr-1 md:grid-cols-2 xl:grid-cols-3">
            {deepWorkItems.map(item => {
              const patchJob = codePatchJobs.find(job => job.deep_work_item_id === item.id);
              return (
                <div key={item.id} className="rounded-md border border-semantic-warning/15 bg-black/10 px-2.5 py-2">
                  <div className="text-xs font-medium leading-snug text-text-primary">{item.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                    <span>{titleizeLabValue(item.priority)}</span>
                    <span>·</span>
                    <span>{titleizeLabValue(item.failure_type)}</span>
                    <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">Not included in Ship</span>
                    {patchJob && (
                      <span className="rounded border border-accent-magenta/20 bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] text-accent-magenta">
                        Patch {labCodePatchStatusLabel(patchJob.status)}
                      </span>
                    )}
                  </div>
                  <ExpandableText
                    text={labDeepWorkBody(item)}
                    collapsedLines={3}
                    minToggleChars={140}
                    className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => startCodePatch(item)}
                      disabled={Boolean(patchJob) || startingCodePatchId === item.id || !isViewingCurrent}
                      className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
                    >
                      {startingCodePatchId === item.id ? 'Starting patch' : patchJob ? 'Patch started' : 'Start code patch'}
                    </button>
                    <button
                      type="button"
                      onClick={() => startLab(`${item.title}. ${labDeepWorkBody(item)}`)}
                      disabled={startDisabled}
                      className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-white/[0.04] disabled:opacity-50"
                    >
                      {startVerb} canary
                    </button>
                  </div>
                </div>
              );
            })}
            {deepWorkItems.length === 0 && activeFailureClusters.map((cluster, index) => (
              <div key={`${String(cluster.cluster_key || index)}`} className="rounded-md border border-white/[0.04] bg-black/10 px-2.5 py-2">
                <div className="text-xs font-medium leading-snug text-text-primary">{titleizeLabValue(cluster.failed_gate || cluster.failure_type)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                  <span>{titleizeLabValue(cluster.priority)}</span>
                  <span>·</span>
                  <span>{Number(cluster.count || 0)} sample{Number(cluster.count || 0) === 1 ? '' : 's'}</span>
                  <span className="rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-text-muted">Needs diagnosis</span>
                </div>
                <ExpandableText
                  text={labFailureClusterBody(cluster)}
                  collapsedLines={3}
                  minToggleChars={140}
                  className="mt-2 text-[11px] leading-relaxed text-text-secondary"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => startLab(`${titleizeLabValue(cluster.failed_gate || cluster.failure_type)}. ${labFailureClusterBody(cluster)}`)}
                    disabled={startDisabled}
                    className="rounded-md border border-accent-magenta/25 px-2 py-1 text-[10px] font-medium text-accent-magenta hover:bg-accent-magenta/10 disabled:opacity-50"
                  >
                    {startVerb} canary
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function friendlyReplayReason(reason: string): string {
  return reason.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function DealReplayStatusCard({
  replay,
  onRefresh,
}: {
  replay: DealReplayStatusSnapshot;
  onRefresh: () => void;
}) {
  const [canceling, setCanceling] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [evidenceRows, setEvidenceRows] = React.useState<DealReplayEvidenceRow[]>([]);
  const [evidenceTotal, setEvidenceTotal] = React.useState(0);
  const [evidenceLoading, setEvidenceLoading] = React.useState(false);
  const [evidenceError, setEvidenceError] = React.useState<string | null>(null);
  const run = replay.run;
  const queue = replay.queue;

  const loadEvidence = React.useCallback(async (offset = 0) => {
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const result = await api.getDealReplayEvidence({ limit: 50, offset });
      setEvidenceTotal(result.total);
      setEvidenceRows(prev => offset === 0 ? result.evidence : [...prev, ...result.evidence]);
    } catch (e: any) {
      setEvidenceError(e?.message || 'Failed to load evidence');
    } finally {
      setEvidenceLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (evidenceOpen && evidenceRows.length === 0 && !evidenceLoading) {
      loadEvidence(0);
    }
  }, [evidenceOpen, evidenceRows.length, evidenceLoading, loadEvidence]);

  async function cancelReplay() {
    if (!run || run.status !== 'running') return;
    setCanceling(true);
    try {
      await api.cancelDealReplay();
      onRefresh();
    } finally {
      setCanceling(false);
    }
  }

  if (!run) {
    return (
      <div className="card p-5">
        <div className="text-sm font-medium text-text-primary">Deal Rebuild</div>
        <div className="text-xs text-text-muted mt-1">
          No six-week rebuild has been started yet. When it runs, this panel shows candidate scanning, conservative evidence, promotions, skips, and Claude deferrals.
        </div>
      </div>
    );
  }

  const queuedRemaining = queue.pending + queue.in_progress + queue.failed;
  const progressPct = run.enqueued_count > 0
    ? Math.min(100, Math.round((run.processed_count / run.enqueued_count) * 100))
    : 100;
  const skipReasons = Object.entries(run.skip_reasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const promoted = run.promoted_companies.slice(0, 5);
  const evidence = run.recent_evidence.slice(0, 5);
  const errors = run.recent_errors.slice(0, 4);
  const titleStatus = run.status === 'running'
    ? `Running for ${formatDuration(run.elapsed_seconds)}`
    : `Finished ${run.completed_at ? formatRelative(run.completed_at) : formatRelative(run.updated_at)}`;

  return (
    <div className="card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-text-primary">Deal Rebuild</div>
            <ReplayStatusPill status={run.status} />
          </div>
          <div className="text-xs text-text-muted mt-1">
            Conservative replay for the last {run.days_back} days. It only promotes a startup after 4 strong evidence records across at least 2 source families.
          </div>
          {run.last_event && (
            <div className="mt-2 text-xs text-text-secondary">{run.last_event}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right text-[11px] text-text-muted">
            <div>{titleStatus}</div>
            <div>{run.pace_per_minute.toLocaleString()} items/min</div>
          </div>
          {run.status === 'running' && (
            <button
              type="button"
              onClick={cancelReplay}
              disabled={canceling}
              className="inline-flex items-center gap-1 rounded-lg border border-semantic-warning/25 px-2.5 py-1.5 text-[11px] text-semantic-warning hover:bg-semantic-warning/10 disabled:opacity-50"
            >
              <XIcon size={12} /> Cancel
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-text-muted">
          <span>{run.processed_count.toLocaleString()} of {run.enqueued_count.toLocaleString()} candidates processed</span>
          <span>{queuedRemaining.toLocaleString()} still queued or retrying</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        <ReplayMetric label="Scanned" value={run.scanned_count.toLocaleString()} />
        <ReplayMetric label="Strong evidence" value={run.evidence_recorded_count.toLocaleString()} tone="good" />
        <ReplayMetric label="Promoted to New" value={run.promoted_count.toLocaleString()} tone="good" />
        <ReplayMetric label="Skipped" value={run.skipped_count.toLocaleString()} />
        <ReplayMetric label="Claude pauses" value={run.rate_limited_count.toLocaleString()} tone={run.rate_limited_count > 0 ? 'warn' : 'default'} />
        <ReplayMetric label="Errors" value={run.error_count.toLocaleString()} tone={run.error_count > 0 ? 'bad' : 'default'} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Queue State</div>
          <div className="mt-2 grid grid-cols-5 gap-2 text-center text-[11px]">
            {(['pending', 'in_progress', 'failed', 'dead_letter', 'completed'] as const).map(key => (
              <div key={key} className="rounded-md bg-white/[0.025] px-2 py-1">
                <div className="text-text-primary tabular-nums">{queue[key].toLocaleString()}</div>
                <div className="text-[10px] text-text-muted">{key.replace('_', ' ')}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Skipped Candidates</div>
          {skipReasons.length === 0 ? (
            <div className="mt-2 text-xs text-text-muted">No skipped candidates recorded yet.</div>
          ) : (
            <div className="mt-2 max-h-28 overflow-y-auto pr-1 space-y-1.5">
              {skipReasons.map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-text-secondary">{friendlyReplayReason(reason)}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">{count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Recent Evidence</div>
          {evidence.length === 0 ? (
            <div className="mt-2 text-xs text-text-muted">Strong evidence snippets will appear here as they are recorded.</div>
          ) : (
            <div className="mt-2 max-h-44 overflow-y-auto pr-1 space-y-2">
              {evidence.map((item, idx) => (
                <div key={`${item.company_name}-${item.at}-${idx}`} className="rounded-md bg-white/[0.025] px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-text-primary truncate">{item.company_name}</span>
                    <span className="shrink-0 text-[10px] text-text-muted">{item.source_type}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted truncate">
                    {item.source_title || 'Untitled source'}{typeof item.confidence === 'number' ? ` · ${(item.confidence * 100).toFixed(0)}%` : ''}
                  </div>
                  {item.evidence && (
                    <div className="mt-1 text-[11px] leading-relaxed text-text-secondary line-clamp-2">{item.evidence}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="text-xs font-medium text-text-primary">Promotions And Issues</div>
          {promoted.length === 0 && errors.length === 0 ? (
            <div className="mt-2 text-xs text-text-muted">Promoted startup cards and replay issues will appear here.</div>
          ) : (
            <div className="mt-2 max-h-44 overflow-y-auto pr-1 space-y-2">
              {promoted.map((item, idx) => (
                <div key={`${item.company_name}-${item.at}-${idx}`} className="rounded-md bg-semantic-success/[0.06] border border-semantic-success/10 px-2 py-1.5">
                  <div className="text-xs font-medium text-semantic-success truncate">{item.company_name}</div>
                  <div className="text-[11px] text-text-muted">Promoted {formatRelative(item.at)}</div>
                </div>
              ))}
              {errors.map((item, idx) => (
                <div key={`${item.error}-${item.at}-${idx}`} className="rounded-md bg-semantic-error/[0.06] border border-semantic-error/10 px-2 py-1.5">
                  <div className="text-xs text-semantic-error line-clamp-2">{item.error}</div>
                  <div className="text-[11px] text-text-muted">{item.source_type || 'source'} · {formatRelative(item.at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-text-primary">All Recorded Evidence</div>
            <div className="mt-0.5 text-[11px] text-text-muted">
              Read-only view of every strong evidence record written by the replay. Loading this does not touch the scan queue.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !evidenceOpen;
              setEvidenceOpen(next);
              if (next && evidenceRows.length === 0) loadEvidence(0);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-white/[0.04]"
          >
            {evidenceOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {evidenceOpen ? 'Hide evidence' : 'Show evidence'}
          </button>
        </div>

        {evidenceOpen && (
          <div className="mt-3">
            {evidenceError && (
              <div className="mb-2 rounded-md border border-semantic-error/20 bg-semantic-error/10 px-3 py-2 text-xs text-semantic-error">
                {evidenceError}
              </div>
            )}
            <div className="max-h-96 overflow-y-auto rounded-lg border border-white/[0.04]">
              {evidenceRows.length === 0 && !evidenceLoading ? (
                <div className="p-3 text-xs text-text-muted">No evidence records have been written yet.</div>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {evidenceRows.map(row => (
                    <div key={row.id} className="grid gap-2 p-3 lg:grid-cols-[minmax(150px,220px)_minmax(0,1fr)_auto]">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-text-primary">{row.company_name || 'Unknown company'}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {row.funding_stage && row.funding_stage !== 'unknown' && (
                            <span className="rounded-full bg-accent-magenta/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent-magenta">
                              {row.funding_stage.replace('_', ' ')}
                            </span>
                          )}
                          {row.signal_kind && (
                            <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                              {row.signal_kind}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                          <span>{row.source_type}</span>
                          <span>·</span>
                          <span className="min-w-0 truncate">{row.source_title || 'Untitled source'}</span>
                          {row.source_date && <span>· {formatRelative(row.source_date)}</span>}
                        </div>
                        {row.evidence_note && (
                          <div className="mt-1 text-xs leading-relaxed text-text-secondary">{row.evidence_note}</div>
                        )}
                        {row.source_excerpt && (
                          <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-text-muted">{row.source_excerpt}</div>
                        )}
                      </div>
                      <div className="flex items-start justify-between gap-3 lg:block lg:text-right">
                        <div className="text-xs font-medium text-semantic-success">{Math.round(row.confidence * 100)}%</div>
                        <div className="mt-0.5 text-[11px] text-text-muted">{formatRelative(row.created_at)}</div>
                        {row.promoted_at && (
                          <div className="mt-1 text-[10px] text-semantic-success">Promoted</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
              <span>
                Showing {evidenceRows.length.toLocaleString()} of {evidenceTotal.toLocaleString()} evidence records
              </span>
              {evidenceRows.length < evidenceTotal && (
                <button
                  type="button"
                  onClick={() => loadEvidence(evidenceRows.length)}
                  disabled={evidenceLoading}
                  className="rounded-lg border border-white/10 px-2.5 py-1.5 text-text-secondary hover:bg-white/[0.04] disabled:opacity-50"
                >
                  {evidenceLoading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section 4: Work Queue (Phase 5 1c, 2026-05-05) ──────────────────────
//
// Universal work_queue surface. Substrate ships in Phase 5; the registry
// is empty today so this card renders an empty state on every org. First
// pilot domain (Phase 5.1+, likely embed_retry) populates the inventory
// rows; the card auto-renders the per-domain breakdown without needing
// further frontend work — domain name is the row label.
//
// Reads `work_queue_inventory` (per-domain status counts) and
// `stuck_work_queue` (in_progress rows with stale heartbeat). The
// stuck list is rendered as a per-domain badge on the corresponding
// inventory row, NOT as a separate sub-table — that keeps the panel
// dense and operator-actionable: one row per domain, all signals
// co-located.

function WorkQueueCard({
  inventory,
  stuck,
}: {
  inventory: WorkQueueInventoryEntry[];
  stuck: StuckWorkQueueEntry[];
}) {
  // Aggregate inventory by domain. The backend returns one row per
  // (domain, status), so we collapse here for rendering.
  const byDomain = React.useMemo(() => {
    const m = new Map<string, {
      pending: number;
      in_progress: number;
      completed: number;
      failed: number;
      dead_letter: number;
    }>();
    for (const r of inventory) {
      const slot = m.get(r.domain) || { pending: 0, in_progress: 0, completed: 0, failed: 0, dead_letter: 0 };
      slot[r.status] = r.count;
      m.set(r.domain, slot);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [inventory]);

  // Stuck count per domain — surfaced as a red badge on the inventory row.
  const stuckByDomain = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stuck) m.set(s.domain, (m.get(s.domain) || 0) + 1);
    return m;
  }, [stuck]);

  const isEmpty = byDomain.length === 0;

  return (
    <div className="card p-5">
      <div className="text-sm font-medium text-text-primary mb-3">Work Queue</div>
      {isEmpty ? (
        <div className="text-sm text-text-muted">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success mr-2 align-middle" />
          No registered domains. The universal work queue substrate is live;
          domain pilots will populate this panel as they come online.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-text-muted text-left">
                <th className="pb-2 pr-4 font-medium">Domain</th>
                <th className="pb-2 pr-4 font-medium text-right">Pending</th>
                <th className="pb-2 pr-4 font-medium text-right">In progress</th>
                <th className="pb-2 pr-4 font-medium text-right">Dead-letter</th>
                <th className="pb-2 font-medium text-right">Stuck</th>
              </tr>
            </thead>
            <tbody>
              {byDomain.map(([domain, counts]) => {
                const stuckN = stuckByDomain.get(domain) ?? 0;
                return (
                  <tr key={domain} className="border-t border-border/30">
                    <td className="py-2 pr-4 font-mono text-xs text-text-primary">{domain}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                      {counts.pending.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-text-primary">
                      {counts.in_progress.toLocaleString()}
                    </td>
                    <td className={`py-2 pr-4 text-right tabular-nums ${counts.dead_letter > 0 ? 'text-semantic-error font-medium' : 'text-text-muted'}`}>
                      {counts.dead_letter.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {stuckN > 0 ? (
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ background: 'rgba(245,158,11,0.15)', color: '#FCD34D' }}>
                          {stuckN}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {stuck.length > 0 && (
            <div className="text-[10px] text-text-muted mt-3">
              Stuck = in-progress rows with no heartbeat for &gt;10 min. The
              minute-tick watchdog reclaims these on the next sweep; if the
              count persists across refreshes, the handler is genuinely
              degraded and warrants investigation.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section 1: Active Tasks ──────────────────────────────────────────────

function RateLimitIndicator({ budgets }: { budgets: BudgetSnapshotRow[] }) {
  const limited = React.useMemo(() => {
    const now = Date.now();
    return budgets.filter(b => {
      const openUntil = b.circuit_open_until ? new Date(b.circuit_open_until).getTime() : 0;
      const circuitActuallyOpen = b.circuit_open === true && openUntil > now;
      const hardCapHit = b.cap > 0 && b.used >= b.cap && b.consecutive_429s > 0;
      return circuitActuallyOpen || hardCapHit;
    });
  }, [budgets]);

  if (limited.length === 0) return null;
  const primary = limited[0];
  const resetText = primary.circuit_open_until ? ` until ${formatRelative(primary.circuit_open_until)}` : '';

  return (
    <div className="card p-4 border-semantic-warning/30 bg-semantic-warning/[0.04]">
      <div className="flex items-start gap-3">
        <Shield size={18} className="text-semantic-warning shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">Upstream rate limit active</div>
          <div className="text-xs text-text-secondary mt-1">
            {primary.upstream} is limiting requests{resetText}. MARTy will recover automatically when the circuit closes.
          </div>
          {limited.length > 1 && (
            <div className="text-[11px] text-text-muted mt-1">
              {limited.length - 1} other upstream budget{limited.length === 2 ? '' : 's'} also constrained.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function friendlyTaskType(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('webhook')) return 'Processing fresh Outlook updates';
  if (lower.includes('progressive') || lower.includes('backfill')) return 'Backfilling historical data';
  if (lower.includes('ingestion')) return 'Syncing email, calendar, Slack, and news';
  if (lower.includes('enrich')) return 'Enriching CRM records';
  if (lower.includes('embed')) return 'Indexing searchable knowledge';
  if (lower.includes('news')) return 'Refreshing market news';
  return type.replace(/[_-]+/g, ' ');
}

function summarizeActiveTasks(tasks: SystemStatusActiveTask[]) {
  const grouped = new Map<string, {
    label: string;
    count: number;
    processed: number;
    longest: number;
    latestStarted: string;
  }>();
  for (const t of tasks) {
    const label = friendlyTaskType(t.type);
    const existing = grouped.get(label) || {
      label,
      count: 0,
      processed: 0,
      longest: 0,
      latestStarted: t.started_at,
    };
    existing.count += 1;
    existing.processed += t.items_processed || 0;
    existing.longest = Math.max(existing.longest, t.elapsed_seconds || 0);
    if (new Date(t.started_at).getTime() > new Date(existing.latestStarted).getTime()) {
      existing.latestStarted = t.started_at;
    }
    grouped.set(label, existing);
  }
  return Array.from(grouped.values()).sort((a, b) => b.longest - a.longest);
}

function ActiveTasksCard({ tasks }: { tasks: SystemStatusActiveTask[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const summaries = React.useMemo(() => summarizeActiveTasks(tasks), [tasks]);
  const moving = summaries.filter(t => t.processed > 0);
  const stalled = summaries.filter(t => t.processed === 0 && t.longest >= 30 * 60);
  const warming = summaries.filter(t => t.processed === 0 && t.longest < 30 * 60);
  const totalProcessed = moving.reduce((acc, t) => acc + t.processed, 0);
  const visible = expanded ? [...moving, ...stalled, ...warming] : [...moving, ...stalled].slice(0, 3);
  const hasDataMovingWork = moving.length > 0;
  const zeroOnlyWork = tasks.length > 0 && !hasDataMovingWork;

  return (
    <div className="card p-5">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="text-sm font-medium text-text-primary">Active Work</div>
          <div className="text-xs text-text-muted mt-0.5">
            {tasks.length === 0
              ? 'No active background jobs'
              : hasDataMovingWork
                ? `${totalProcessed.toLocaleString()} item${totalProcessed === 1 ? '' : 's'} moving now · ${tasks.length} background job${tasks.length === 1 ? '' : 's'} tracked`
                : `No data-moving work right now · ${tasks.length} bookkeeping job${tasks.length === 1 ? '' : 's'} tracked`}
          </div>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-text-muted">
          {tasks.length > 0 && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success animate-pulse" />
          )}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {tasks.length === 0 ? (
        <div className="text-sm text-text-muted mt-3">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-semantic-success mr-2 align-middle" />
          No active tasks. Next email sync at <span className="text-text-primary">:00</span>, next enrichment at <span className="text-text-primary">:05</span>.
        </div>
      ) : (
        <div className={`mt-4 overflow-hidden transition-all duration-200 ${expanded ? 'max-h-96 opacity-100' : 'max-h-32 opacity-100'}`}>
          <div className="rounded-lg bg-white/[0.025] border border-white/[0.04] p-3 mb-3">
            <div className="text-xs text-text-secondary leading-relaxed">
              Active Work shows background jobs the system has marked as running. Zeros usually mean bookkeeping, startup, or a stale backfill window, not missing customer data. This panel highlights data that is actually moving and separates stale zero-work rows.
            </div>
          </div>

          {zeroOnlyWork && (
            <div className={`rounded-lg px-3 py-2 mb-3 border ${
              stalled.length > 0
                ? 'bg-semantic-warning/[0.06] border-semantic-warning/20'
                : 'bg-white/[0.025] border-white/[0.04]'
            }`}>
              <div className="text-sm text-text-primary">
                {stalled.length > 0 ? 'No records are moving; some job rows look stale.' : 'Background jobs are warming up.'}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">
                {stalled.length > 0
                  ? `${stalled.reduce((acc, t) => acc + t.count, 0).toLocaleString()} zero-work job row${stalled.reduce((acc, t) => acc + t.count, 0) === 1 ? '' : 's'} have been marked running for more than 30 minutes.`
                  : `${warming.reduce((acc, t) => acc + t.count, 0).toLocaleString()} job row${warming.reduce((acc, t) => acc + t.count, 0) === 1 ? '' : 's'} have not reported processed items yet.`}
              </div>
            </div>
          )}

          <div className={`space-y-2 ${expanded ? 'max-h-56 overflow-y-auto pr-1' : ''}`}>
            {visible.map(t => {
              const isStalled = t.processed === 0 && t.longest >= 30 * 60;
              const isWarming = t.processed === 0 && !isStalled;
              return (
                <div key={t.label} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                  isStalled
                    ? 'bg-semantic-warning/[0.04] border-semantic-warning/15'
                    : 'bg-white/[0.025] border-white/[0.04]'
                }`}>
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary truncate">{t.label}</div>
                    <div className="text-[11px] text-text-muted">
                      {t.count > 1 ? `${t.count} rows · ` : ''}
                      {isStalled ? 'stale zero-work row' : isWarming ? 'waiting to report work' : 'actively processing'} · {formatDuration(t.longest)}
                    </div>
                  </div>
                  <div className="text-right shrink-0 min-w-[88px]">
                    <div className={`text-sm tabular-nums ${t.processed > 0 ? 'text-text-primary' : 'text-text-muted'}`}>
                      {t.processed > 0 ? t.processed.toLocaleString() : 'No records'}
                    </div>
                    <div className="text-[10px] text-text-muted">{t.processed > 0 ? 'processed' : 'moved'}</div>
                  </div>
                </div>
              );
            })}
            {!expanded && [...moving, ...stalled].length > visible.length && (
              <div className="text-[11px] text-text-muted px-1">
                {[...moving, ...stalled].length - visible.length} more signal row{[...moving, ...stalled].length - visible.length === 1 ? '' : 's'} hidden. Expand to inspect.
              </div>
            )}
            {expanded && warming.length > 0 && (
              <div className="text-[11px] text-text-muted px-1">
                Warming rows are shown last because they have not yet moved records.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section 2: Run History ───────────────────────────────────────────────

function isZeroNoiseRun(row: SystemStatusRunHistoryEntry): boolean {
  return row.status === 'completed' && row.items_processed === 0 && row.items_failed === 0 && !row.error_message;
}

function isAttentionRun(row: SystemStatusRunHistoryEntry): boolean {
  return row.status !== 'completed' || row.items_failed > 0 || !!row.error_message;
}

function RunHistoryCard({ rows }: { rows: SystemStatusRunHistoryEntry[] }) {
  const [expanded, setExpanded] = React.useState(false);
  const attentionRows = rows.filter(isAttentionRun);
  const meaningfulRows = rows.filter(r => !isZeroNoiseRun(r) && !isAttentionRun(r));
  const zeroNoiseCount = rows.length - attentionRows.length - meaningfulRows.length;
  const latestMeaningful = [...attentionRows, ...meaningfulRows].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  )[0];
  const orderedRows = [...attentionRows, ...meaningfulRows].sort(
    (a, b) => Number(isAttentionRun(b)) - Number(isAttentionRun(a)) || new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
  const visibleRows = expanded ? orderedRows : orderedRows.slice(0, 4);

  return (
    <div className="card p-5 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="text-sm font-medium text-text-primary">Run History</div>
          <div className="text-xs text-text-muted mt-0.5">
            {latestMeaningful
              ? `Latest signal: ${latestMeaningful.type} · ${latestMeaningful.items_processed.toLocaleString()} processed · ${formatRelative(latestMeaningful.started_at)}`
              : 'No runs recorded yet'}
            {attentionRows.length > 0 ? ` · ${attentionRows.length} need attention` : ''}
          </div>
        </div>
        {rows.length > 0 && (
          <span className="text-text-muted">{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        )}
      </button>
      {rows.length === 0 ? (
        <div className="mt-3 text-sm text-text-muted">No runs recorded yet.</div>
      ) : (
        <div className="mt-4">
          <div className="rounded-lg bg-white/[0.025] border border-white/[0.04] p-3 mb-3">
            <div className="text-xs text-text-secondary leading-relaxed">
              Run History shows recent background runs after they finish. Completed rows with 0 processed are usually health checks, webhooks with no eligible records, or cleanup passes, so they are hidden unless you expand.
            </div>
            {zeroNoiseCount > 0 && (
              <div className="text-[11px] text-text-muted mt-1">
                {zeroNoiseCount} zero-record bookkeeping run{zeroNoiseCount === 1 ? '' : 's'} hidden from the main view.
              </div>
            )}
          </div>
          {visibleRows.length === 0 ? (
            <div className="rounded-lg bg-white/[0.025] border border-white/[0.04] px-3 py-2 text-sm text-text-secondary">
              Only bookkeeping runs finished recently. Nothing needs attention.
            </div>
          ) : (
            <div className={`space-y-2 ${expanded ? 'max-h-80 overflow-y-auto pr-1' : ''}`}>
              {visibleRows.map(r => <RunHistoryRow key={r.id} row={r} />)}
            </div>
          )}
          {!expanded && orderedRows.length > visibleRows.length && (
            <div className="mt-2 text-[11px] text-text-muted px-1">
              {orderedRows.length - visibleRows.length} more meaningful run{orderedRows.length - visibleRows.length === 1 ? '' : 's'} hidden. Expand to scroll.
            </div>
          )}
          {expanded && zeroNoiseCount > 0 && (
            <div className="mt-2 text-[11px] text-text-muted px-1">
              Hidden zero-record runs are omitted here too so this panel stays focused on failures and real throughput.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunHistoryRow({ row }: { row: SystemStatusRunHistoryEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const attention = isAttentionRun(row);
  const processedLabel = row.items_processed > 0
    ? `${row.items_processed.toLocaleString()} processed`
    : 'No records moved';
  return (
    <div className={`rounded-lg border px-3 py-2 ${
      attention ? 'bg-semantic-error/[0.045] border-semantic-error/15' : 'bg-white/[0.025] border-white/[0.04]'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm text-text-primary truncate">{row.type}</div>
            <StatusBadge status={row.status} />
          </div>
          <div className="text-[11px] text-text-muted mt-1 flex flex-wrap gap-x-2 gap-y-1">
            <span>{processedLabel}</span>
            {row.items_failed > 0 && <span className="text-semantic-error">{row.items_failed.toLocaleString()} failed</span>}
            <span>{formatRelative(row.started_at)}</span>
            <span>{row.duration_seconds === 0 ? 'instant' : formatDuration(row.duration_seconds)}</span>
          </div>
        </div>
        {row.error_message && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="shrink-0 text-[11px] text-semantic-error hover:underline"
          >
            {expanded ? 'Hide error' : 'Show error'}
          </button>
        )}
      </div>
      {row.error_message && expanded && (
        <div className="mt-2 rounded-md bg-semantic-error/10 border border-semantic-error/15 px-2 py-1.5 text-xs text-semantic-error leading-relaxed">
          {row.error_message}
        </div>
      )}
    </div>
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

      <CompletenessGroup title="Document Coverage">
        <CompletenessBar
          label="embedded"
          metric={c.document_embedding}
          unit="documents searchable by MARTy"
          warningHint="Unembedded documents are stored and preview/downloadable, but MARTy's semantic retrieval is weaker until the document self-healer processes them."
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

function completenessColor(label: string, pct: number): string {
  if (label.toLowerCase().includes('linkedin')) return '#60A5FA';
  if (pct >= 95) return '#22C55E';
  if (pct >= 80) return '#6B8F71';
  if (pct >= 50) return '#F59E0B';
  return '#EF4444';
}

function CompletenessBar({
  label, metric, unit, warningHint,
}: { label: string; metric: CompletenessMetric; unit: string; warningHint?: string }) {
  const pct = metric.percentage;
  const color = completenessColor(label, pct);
  const showHint = pct < 95 && warningHint;
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
    pct >= 95 ? '#22C55E' :
    pct >= 80 ? '#6B8F71' :
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

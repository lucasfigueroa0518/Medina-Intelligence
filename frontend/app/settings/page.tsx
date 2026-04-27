'use client';

import React from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, X as XIcon, ChevronDown, ChevronUp, Users, Briefcase, Target, Sparkles, Mail, Clock, Loader2, User as UserIcon, Camera, Shield, LogOut, Trash2 } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import {
  api,
  getAuthToken,
  resolveAvatarUrl,
  type IntegrationRow,
  type IntegrationsStatusResponse,
  type UserProfile,
} from '@/lib/api';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;

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
      setShowFirstConnect(true);
      router.replace('/settings');
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

        <ProfileSection />

        <SecuritySection />

        <div className="card">
          <div className="font-medium mb-4">Sync Behavior</div>
          <div className="space-y-3 text-sm">
            <Toggle label="Auto-approve sync" />
            <Toggle label="Re-ranker enabled" checked />
            <Toggle label="News feed enabled" checked />
            <Toggle label="LinkedIn enrichment enabled" checked />
          </div>
        </div>

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
              <IntegrationRowView
                name="Firefly AI"
                description="Meeting transcription + action items via webhook."
                row={status.firefly}
                primaryLabel={null}
              />
            </div>
          ) : null}
        </div>

        <ApprovalQueueSection />
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
  const [backfillProgress, setBackfillProgress] = React.useState<any>(null);
  const [backfillLoading, setBackfillLoading] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [backfillDays, setBackfillDays] = React.useState(365);
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

    api.getBackfillProgress()
      .then(d => setBackfillProgress(d.progress))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!backfillProgress || backfillProgress.status !== 'in_progress') return;
    const interval = setInterval(() => {
      api.getBackfillProgress()
        .then(d => {
          setBackfillProgress(d.progress);
          if (d.progress?.status !== 'in_progress') clearInterval(interval);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [backfillProgress?.status]);

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

  async function startBackfill() {
    setConfirmOpen(false);
    setBackfillLoading(true);
    try {
      const res = await api.startBackfill({ days_back: backfillDays });
      setBackfillProgress(res.progress);
      if (res.progress.status === 'in_progress') {
        setToast('Backfill started — importing emails in batches');
      } else if (res.progress.status === 'completed') {
        setToast(`Backfill complete — ${res.progress.total_fetched} emails imported`);
      }
    } catch { setToast('Failed to start backfill'); }
    setBackfillLoading(false);
  }

  async function resumeBackfill() {
    setBackfillLoading(true);
    try {
      const res = await api.startBackfill({ days_back: backfillDays });
      setBackfillProgress(res.progress);
    } catch { setToast('Failed to resume'); }
    setBackfillLoading(false);
  }

  const isRunning = backfillProgress?.status === 'in_progress';
  const isPaused = backfillProgress?.status === 'paused';

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Mail size={16} className="text-accent-magenta" />
        <div className="font-medium">Email Sync</div>
      </div>

      <div className="space-y-5">
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

        {isOutlookConnected && (
          <div className="border-t border-border/50 pt-4">
            <div className="text-xs text-text-muted mb-2">Historical Backfill</div>

            {isRunning ? (
              <div className="flex items-center gap-3 py-3 px-4 rounded-lg" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)' }}>
                <Loader2 size={16} className="text-accent-purple animate-spin" />
                <div className="flex-1">
                  <div className="text-sm text-text-primary">
                    Importing... {backfillProgress.total_fetched} emails processed
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    This runs in batches — the page will update automatically
                  </div>
                </div>
              </div>
            ) : isPaused ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 py-3 px-4 rounded-lg" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
                  <Clock size={16} className="text-amber-400" />
                  <div className="flex-1">
                    <div className="text-sm text-text-primary">
                      Paused — {backfillProgress.total_fetched} emails so far
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      {backfillProgress.error || 'Rate limit reached — click Resume to continue'}
                    </div>
                  </div>
                  <button onClick={resumeBackfill} disabled={backfillLoading} className="btn-secondary text-xs py-1">
                    {backfillLoading ? 'Resuming...' : 'Resume'}
                  </button>
                </div>
              </div>
            ) : backfillProgress?.status === 'completed' ? (
              <div className="flex items-center gap-3 py-3 px-4 rounded-lg" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
                <Check size={16} className="text-green-400" />
                <div className="flex-1">
                  <div className="text-sm text-text-primary">
                    Backfill complete — {backfillProgress.total_fetched} emails imported
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    Completed {formatRelative(backfillProgress.updated_at)}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-xs text-text-secondary mb-3">
                  Import older emails that were sent before your initial sync window. This runs in the background.
                </div>
                <button onClick={() => setConfirmOpen(true)} className="btn-secondary text-xs py-1.5 flex items-center gap-2">
                  <Clock size={13} />
                  Import Older Emails
                </button>
              </div>
            )}

            {backfillProgress?.status === 'failed' && (
              <div className="flex items-center gap-3 py-3 px-4 rounded-lg mt-2" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                <XIcon size={16} className="text-red-400" />
                <div className="flex-1">
                  <div className="text-sm text-text-primary">Backfill failed</div>
                  <div className="text-[10px] text-text-muted">{backfillProgress.error}</div>
                </div>
                <button onClick={resumeBackfill} disabled={backfillLoading} className="btn-secondary text-xs py-1">
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => setConfirmOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Import Older Emails</div>
            <div className="text-sm text-text-secondary mb-4">
              This will fetch emails older than your current sync window. Choose how far back to go:
            </div>
            <select
              value={backfillDays}
              onChange={e => setBackfillDays(Number(e.target.value))}
              className="input text-sm py-1.5 px-3 w-full mb-4"
            >
              <option value={90}>Last 3 months</option>
              <option value={180}>Last 6 months</option>
              <option value={365}>Last year</option>
              <option value={730}>Last 2 years</option>
            </select>
            <div className="text-xs text-text-muted mb-4">
              Emails will be imported in batches of 50. For large inboxes this may take several minutes.
              You can close this page — the import continues in the background and resumes automatically if interrupted.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={startBackfill} disabled={backfillLoading}>
                {backfillLoading ? 'Starting...' : 'Start Import'}
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

function ApprovalQueueSection() {
  const [entities, setEntities] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
  const [entityTypeFilter, setEntityTypeFilter] = React.useState<string>('');
  const [toast, setToast] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (entityTypeFilter) params.entity_type = entityTypeFilter;
      const res = await api.listApprovalQueueGrouped(params);
      setEntities(res.entities || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [entityTypeFilter]);

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
        </div>
      </div>

      {totalPending > 0 && !loading && (
        <div className="text-xs text-text-muted mb-3">
          {totalPending} pending update{totalPending !== 1 ? 's' : ''} across {entities.length} {entityTypeFilter || 'entit'}{entities.length !== 1 ? (entityTypeFilter ? 's' : 'ies') : (entityTypeFilter ? '' : 'y')}
        </div>
      )}

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
                    return (
                      <div key={u.id} className="grid grid-cols-[100px_1fr_1fr_50px_56px] gap-x-2 items-center px-4 py-2"
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider truncate">{humanField(u.field_name)}</span>
                        <span className="text-xs text-text-muted truncate">
                          {current ? shortUrl(current) : <span className="text-text-muted/50 italic">empty</span>}
                        </span>
                        {isUrl ? (
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
              </div>
            );
          })}
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

function ProfileSection() {
  const [user, setUser] = React.useState<UserProfile | null>(null);
  const [draft, setDraft] = React.useState<Partial<UserProfile>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [toast, setToast] = React.useState<{ tone: 'success' | 'error'; msg: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

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

  // Detect changes against the loaded user
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
      // Send only changed fields. Empty strings → null for nullable fields.
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
          <div className="text-[10px] text-text-muted uppercase tracking-wider mt-1">{user.role}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <ProfileField label="Full name" required>
          <input
            type="text"
            value={valueOf('full_name')}
            onChange={e => update('full_name', e.target.value)}
            className="input text-sm w-full"
          />
        </ProfileField>

        <ProfileField label="Email" helper="Cannot be changed">
          <input
            type="email"
            value={user.email}
            disabled
            className="input text-sm w-full"
            style={{ opacity: 0.6, cursor: 'not-allowed' }}
          />
        </ProfileField>

        <ProfileField label="Job title">
          <input
            type="text"
            value={valueOf('job_title')}
            onChange={e => update('job_title', e.target.value)}
            placeholder="e.g. Managing Partner"
            className="input text-sm w-full"
          />
        </ProfileField>

        <ProfileField label="Phone">
          <input
            type="tel"
            value={valueOf('phone')}
            onChange={e => update('phone', e.target.value)}
            placeholder="+1 (555) 555-5555"
            className="input text-sm w-full"
          />
        </ProfileField>

        <div className="col-span-2">
          <ProfileField label="LinkedIn URL">
            <input
              type="url"
              value={valueOf('linkedin_url')}
              onChange={e => update('linkedin_url', e.target.value)}
              placeholder="https://linkedin.com/in/..."
              className="input text-sm w-full"
            />
          </ProfileField>
        </div>

        <div className="col-span-2">
          <ProfileField label="Bio">
            <textarea
              value={valueOf('bio')}
              onChange={e => update('bio', e.target.value)}
              rows={3}
              placeholder="A short bio for teammates"
              className="input text-sm w-full resize-y"
            />
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
      // Lazy-load qrcode to keep initial bundle small
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
    if (next.length < 8) {
      setMsg({ tone: 'error', text: 'New password must be at least 8 characters' });
      return;
    }
    if (next !== confirm) {
      setMsg({ tone: 'error', text: 'New password and confirmation do not match' });
      return;
    }
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
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-secondary text-sm py-1.5"
            style={{ opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}
          >
            {saving ? 'Updating...' : 'Update Password'}
          </button>
          {msg && (
            <span className={`text-xs ${msg.tone === 'success' ? 'text-semantic-success' : 'text-semantic-error'}`}>
              {msg.text}
            </span>
          )}
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
    try {
      const { sessions } = await api.listMySessions();
      setSessions(sessions);
    } catch { setSessions([]); }
    setLoading(false);
  }, []);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3000);
    return () => clearTimeout(t);
  }, [msg]);

  async function revokeOne(id: string) {
    setBusy(id);
    try {
      await api.revokeMySession(id);
      setMsg('Session revoked');
      load();
    } catch { setMsg('Failed to revoke session'); }
    setBusy(null);
  }

  async function logoutAllOthers() {
    setBusy('all');
    try {
      const { revoked } = await api.revokeAllOtherSessions();
      setMsg(`Logged out of ${revoked} other ${revoked === 1 ? 'device' : 'devices'}`);
      load();
    } catch { setMsg('Failed to log out other sessions'); }
    setBusy(null);
  }

  const otherSessions = sessions?.filter(s => !s.current) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-text-secondary">Active sessions</div>
        {otherSessions.length > 0 && (
          <button
            onClick={logoutAllOthers}
            disabled={busy === 'all'}
            className="text-xs text-text-muted hover:text-semantic-error transition-colors flex items-center gap-1.5"
          >
            <LogOut size={12} />
            {busy === 'all' ? 'Logging out...' : `Log out other ${otherSessions.length} device${otherSessions.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map(i => <div key={i} className="h-12 bg-bg-surface-hover rounded-lg animate-pulse" />)}
        </div>
      ) : !sessions || sessions.length === 0 ? (
        <div className="text-xs text-text-muted py-3">No active sessions found.</div>
      ) : (
        <div className="space-y-2">
          {sessions.map(s => (
            <div key={s.id}
              className="flex items-center justify-between px-3 py-2.5 rounded-lg"
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
                        style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>
                        Current
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    Started {formatRelative(s.created_at)} · expires {formatRelative(s.expires_at)}
                  </div>
                </div>
              </div>
              {!s.current && (
                <button
                  onClick={() => revokeOne(s.id)}
                  disabled={busy === s.id}
                  className="text-text-muted hover:text-semantic-error transition-colors p-1.5"
                  title="Revoke session"
                >
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
}: {
  name: string;
  description: string;
  row: IntegrationRow;
  primaryLabel: string | null;
  onPrimaryClick?: () => void;
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
          <div className={`text-xs mt-1 ${rateLimitColor || 'text-text-muted'}`}>
            {row.detail}
          </div>
        )}
        {row.last_sync && (
          <div className="text-xs text-text-muted mt-1">
            Last sync: {formatRelative(row.last_sync)}
          </div>
        )}
        {row.items_processed != null && row.items_processed > 0 && (
          <div className="text-xs text-text-muted mt-0.5">
            {row.items_processed.toLocaleString()} items synced
            {row.items_failed ? `, ${row.items_failed} failed` : ''}
          </div>
        )}
        {row.team_name && (
          <div className="text-xs text-text-muted mt-1">
            Team: {row.team_name}
          </div>
        )}
        {row.channels_visible != null && (row.channels_visible > 0 || row.status === 'configured_no_channels') && (
          <div className="text-xs text-text-muted mt-0.5">
            {row.channels_visible} channel{row.channels_visible === 1 ? '' : 's'} visible
            {row.messages_synced != null && (
              <> • {row.messages_synced.toLocaleString()} message{row.messages_synced === 1 ? '' : 's'} synced</>
            )}
          </div>
        )}
        {row.warnings && row.warnings.length > 0 && (
          <div className="mt-2 space-y-1">
            {row.warnings.map((w, i) => (
              <div
                key={i}
                className="text-xs text-semantic-warning bg-semantic-warning/10 border-l-2 border-semantic-warning px-2 py-1 rounded"
              >
                ⚠️ {w}
              </div>
            ))}
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

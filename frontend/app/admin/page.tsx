'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';

type Tab = 'approval' | 'dlq' | 'enrichment' | 'sync';

export default function AdminPage() {
  const [tab, setTab] = React.useState<Tab>('approval');

  return (
    <div className="flex-1 flex flex-col">
      <TopBar title="Admin Dashboard" />
      <div className="px-8 border-b border-border flex gap-0">
        {(['approval', 'dlq', 'enrichment', 'sync'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 text-sm capitalize ${
              tab === t
                ? 'text-text-primary border-b-2 border-accent-magenta'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t === 'dlq' ? 'DLQ' : t}
          </button>
        ))}
      </div>
      <div className="flex-1 p-8 overflow-auto">
        {tab === 'approval' && <ApprovalTab />}
        {tab === 'dlq' && <DlqTab />}
        {tab === 'enrichment' && <EnrichmentTab />}
        {tab === 'sync' && <SyncTab />}
      </div>
    </div>
  );
}

function ApprovalTab() {
  const [items, setItems] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [confirmingAll, setConfirmingAll] = React.useState(false);
  const [bulkInFlight, setBulkInFlight] = React.useState(false);
  const [statusMsg, setStatusMsg] = React.useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .listApprovalQueue()
      .then(d => setItems(d.entries))
      .finally(() => setLoading(false));
  };

  React.useEffect(load, []);

  React.useEffect(() => {
    if (!statusMsg) return;
    const t = setTimeout(() => setStatusMsg(null), 5000);
    return () => clearTimeout(t);
  }, [statusMsg]);

  const approve = async (id: string) => {
    await api.approveItem(id);
    load();
  };
  const reject = async (id: string) => {
    await api.rejectItem(id);
    load();
  };

  const approveAll = async () => {
    const ids = items.map(i => i.id);
    setBulkInFlight(true);
    try {
      const res = await api.bulkApprove(ids);
      const resolved = res.resolved.length;
      const conflicts = res.conflicts.length;
      setStatusMsg(
        conflicts > 0
          ? `Approved ${resolved} item${resolved === 1 ? '' : 's'}, ${conflicts} already resolved`
          : `Approved ${resolved} item${resolved === 1 ? '' : 's'}`
      );
    } finally {
      setBulkInFlight(false);
      setConfirmingAll(false);
      load();
    }
  };

  if (loading) return <div className="text-text-secondary">Loading approvals...</div>;
  if (items.length === 0)
    return (
      <>
        {statusMsg && (
          <div className="card mb-3 text-sm text-semantic-success">{statusMsg}</div>
        )}
        <div className="card text-center py-12 text-text-secondary">No pending approvals</div>
      </>
    );

  return (
    <div className="space-y-3">
      {statusMsg && (
        <div className="card text-sm text-semantic-success">{statusMsg}</div>
      )}
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-secondary">
          {items.length} pending item{items.length === 1 ? '' : 's'}
        </div>
        {!confirmingAll ? (
          <button
            onClick={() => setConfirmingAll(true)}
            disabled={bulkInFlight}
            className="btn-primary"
          >
            Approve All
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-primary">
              Approve all {items.length} pending item{items.length === 1 ? '' : 's'}?
            </span>
            <button
              onClick={approveAll}
              disabled={bulkInFlight}
              className="btn-primary"
            >
              {bulkInFlight ? 'Approving...' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirmingAll(false)}
              disabled={bulkInFlight}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {items.map(item => {
        const display = cleanValue(item.proposed_value);
        const currentDisplay = item.current_value ? cleanValue(item.current_value) : null;
        const isUrl = item.field_name?.includes('url');
        return (
          <div key={item.id} className="card flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="badge capitalize">{item.entity_type}</span>
                <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">{humanField(item.field_name)}</span>
                {item.evidence_visible === false && (
                  <span className="text-xs text-text-muted italic">🔒 Private source</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-2 text-sm flex-wrap">
                {currentDisplay ? (
                  <span className="text-text-muted line-through truncate max-w-[200px]">{shortUrl(currentDisplay)}</span>
                ) : (
                  <span className="text-text-muted/50 italic text-xs">empty</span>
                )}
                <span className="text-text-muted">&rarr;</span>
                {isUrl ? (
                  <a href={display} target="_blank" rel="noopener" className="text-accent-magenta hover:underline font-medium truncate max-w-[280px]">{shortUrl(display)}</a>
                ) : (
                  <span className="text-text-primary font-medium truncate max-w-[280px]">{display}</span>
                )}
              </div>
              <div className="text-[11px] text-text-muted mt-1">
                {item.source_description || item.change_type || 'Unknown source'} &middot; {Math.round((item.confidence || 0) * 100)}% confidence
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => approve(item.id)} className="btn-primary">
                Approve
              </button>
              <button onClick={() => reject(item.id)} className="btn-destructive">
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
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

function humanField(f: string): string {
  return (f || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function DlqTab() {
  const [entries, setEntries] = React.useState<any[]>([]);
  React.useEffect(() => {
    api.listDlq().then(d => setEntries(d.entries));
  }, []);

  return (
    <div className="space-y-2">
      {entries.length === 0 ? (
        <div className="card text-center py-12 text-text-secondary">
          All integrations healthy
        </div>
      ) : (
        entries.map(e => (
          <div key={e.id} className="card flex items-center justify-between">
            <div>
              <div className="text-sm font-medium capitalize">{e.source}</div>
              <div className="text-xs text-text-muted">{e.error_message}</div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => api.replayDlq(e.id).then(() => window.location.reload())}
                className="btn-secondary"
              >
                Replay
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function EnrichmentTab() {
  const [status, setStatus] = React.useState<Record<string, any> | null>(null);
  React.useEffect(() => {
    api.getEnrichmentStatus().then(d => setStatus(d.status as any));
  }, []);

  if (!status) return <div className="text-text-secondary">Loading status...</div>;

  return (
    <div className="grid grid-cols-2 gap-4">
      {Object.entries(status).map(([source, state]: [string, any]) => {
        const rateLimited = state?.blocked_until && new Date(state.blocked_until) > new Date();
        return (
          <div key={source} className="card">
            <div className="font-medium capitalize mb-2">{source.replace('_', ' ')}</div>
            <div className="text-sm">
              <span className={rateLimited ? 'text-semantic-error' : 'text-semantic-success'}>
                {rateLimited ? '● Rate Limited' : '● Active'}
              </span>
            </div>
            {rateLimited && (
              <div className="text-xs text-text-muted mt-1">
                Until: {new Date(state.blocked_until).toLocaleString()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SyncTab() {
  const [status, setStatus] = React.useState<any>(null);
  const [userHealth, setUserHealth] = React.useState<{ users: any[]; tokenHealth: Record<string, any> } | null>(null);

  React.useEffect(() => {
    const load = () => api.getSyncStatus().then(setStatus);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    api.getAdminIntegrationStatus().then(setUserHealth).catch(() => {});
  }, []);

  if (!status) return <div className="text-text-secondary">Loading sync status...</div>;

  const types = ['ingestion', 'enrichment', 'daily'];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        {types.map(t => {
          const job = status[t];
          return (
            <div key={t} className="card">
              <div className="font-medium capitalize mb-2">{t}</div>
              {job ? (
                <>
                  <div className="text-sm">
                    Status: <span className="badge capitalize">{job.status}</span>
                  </div>
                  {job.started_at && (
                    <div className="text-xs text-text-muted mt-2">
                      Last run: {new Date(job.started_at).toLocaleString()}
                    </div>
                  )}
                  <div className="text-xs text-text-muted mt-1">
                    Processed: {job.items_processed || 0} · Failed: {job.items_failed || 0}
                  </div>
                </>
              ) : (
                <div className="text-text-muted text-sm">Never run</div>
              )}
            </div>
          );
        })}
      </div>

      {userHealth && (
        <div className="card">
          <div className="font-medium mb-3">User Token Health</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-border">
                <th className="pb-2">Name</th>
                <th className="pb-2">Email</th>
                <th className="pb-2">Outlook</th>
                <th className="pb-2">Failures</th>
              </tr>
            </thead>
            <tbody>
              {userHealth.users.map((u: any) => {
                const health = userHealth.tokenHealth[u.id];
                const failures = health?.count || 0;
                const rowColor = failures >= 3
                  ? 'bg-semantic-error/5'
                  : failures >= 1
                    ? 'bg-semantic-warning/5'
                    : '';
                return (
                  <tr key={u.id} className={`border-b border-border/30 ${rowColor}`}>
                    <td className="py-2 text-text-primary">{u.full_name || '—'}</td>
                    <td className="py-2 text-text-secondary">{u.email}</td>
                    <td className="py-2">
                      {!u.has_outlook ? (
                        <span className="text-text-muted">Not connected</span>
                      ) : failures >= 3 ? (
                        <span className="text-semantic-error">Failing</span>
                      ) : failures >= 1 ? (
                        <span className="text-semantic-warning">Degraded ({failures})</span>
                      ) : (
                        <span className="text-semantic-success">Healthy</span>
                      )}
                    </td>
                    <td className="py-2 text-text-muted">
                      {failures > 0 ? failures : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

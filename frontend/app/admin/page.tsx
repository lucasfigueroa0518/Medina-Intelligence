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

  const load = () => {
    setLoading(true);
    api
      .listApprovalQueue()
      .then(d => setItems(d.entries))
      .finally(() => setLoading(false));
  };

  React.useEffect(load, []);

  const approve = async (id: string) => {
    await api.approveItem(id);
    load();
  };
  const reject = async (id: string) => {
    await api.rejectItem(id);
    load();
  };

  if (loading) return <div className="text-text-secondary">Loading approvals...</div>;
  if (items.length === 0)
    return <div className="card text-center py-12 text-text-secondary">No pending approvals</div>;

  return (
    <div className="space-y-3">
      {items.map(item => (
        <div key={item.id} className="card flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="badge capitalize">{item.entity_type}</span>
              <span className="text-sm text-text-secondary">{item.field_name}</span>
              {item.evidence_visible === false && (
                <span className="text-xs text-text-muted italic">🔒 Private source</span>
              )}
            </div>
            <div className="text-sm mt-2 text-text-primary">
              Proposed: <code className="font-mono text-xs">{item.proposed_value}</code>
            </div>
            <div className="text-xs text-text-muted mt-1">
              Confidence: {((item.confidence || 0) * 100).toFixed(0)}%
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => approve(item.id)} className="btn-primary">
              Approve
            </button>
            <button onClick={() => reject(item.id)} className="btn-destructive">
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
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
  React.useEffect(() => {
    const load = () => api.getSyncStatus().then(setStatus);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (!status) return <div className="text-text-secondary">Loading sync status...</div>;

  const types = ['ingestion', 'enrichment', 'daily'];

  return (
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
  );
}

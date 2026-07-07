'use client';

import React from 'react';
import {
  X as XIcon,
  ChevronDown,
  ChevronUp,
  Mail,
  Shield,
  Users,
  Calendar,
} from 'lucide-react';
import {
  api,
  type SystemStatusResponse,
  type SystemStatusActiveTask,
  type SystemStatusRunHistoryEntry,
  type CompletenessMetric,
  type WorkQueueInventoryEntry,
  type StuckWorkQueueEntry,
  type BudgetSnapshotRow,
  type IngestionIncident,
  type DealReplayEvidenceRow,
  type DealReplayStatusSnapshot,
} from '@/lib/api';

// ────────────────────────────────────────────────────────────────────────────
// System Status tab — active tasks + run history + data completeness.
// All numbers come from a single GET /api/settings/system-status which runs
// direct D1 queries (no KV counters, no estimates).
// ────────────────────────────────────────────────────────────────────────────

export function SystemStatusSection() {
  const [data, setData] = React.useState<SystemStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Data-arrival timestamp: lets children evaluate time-window logic
  // (circuit open-until) as-of the snapshot instead of calling
  // Date.now() during render (impure + stale-memo hazard).
  const [fetchedAt, setFetchedAt] = React.useState(0);

  const load = React.useCallback(() => {
    api.getSettingsSystemStatus()
      .then(d => { setData(d); setFetchedAt(Date.now()); })
      .catch(e => setError(e?.message || 'Failed to load'));
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
	      <RateLimitIndicator budgets={data.budgets || []} asOf={fetchedAt} />
	      <OutlookAppOnlyHealthCard health={data.outlook_app_only_health} />
	      <IngestionIncidentsCard incidents={data.ingestion_incidents || []} />
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

function IngestionIncidentsCard({ incidents }: { incidents: IngestionIncident[] }) {
  const active = incidents.filter(i => i.status !== 'resolved');
  if (active.length === 0) {
    return (
      <div className="card p-5">
        <div className="flex items-start gap-3">
          <Shield size={18} className="text-semantic-success shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-medium text-text-primary">Ingestion Health</div>
            <div className="text-xs text-text-secondary mt-1">No active ingestion incidents. Source failures and dead letters will surface here automatically.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-5 border-semantic-error/25 bg-semantic-error/[0.03]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Ingestion Incidents</div>
          <div className="text-xs text-text-secondary mt-1">Failures are durable, visible, and repaired automatically unless tenant or mailbox configuration needs operator action.</div>
        </div>
        <span className="rounded-full border border-semantic-error/25 bg-semantic-error/10 px-2 py-1 text-[10px] font-medium text-semantic-error">
          {active.length} active
        </span>
      </div>
      <div className="space-y-2">
        {active.slice(0, 8).map(incident => (
          <div key={incident.id} className="rounded-lg border border-border/60 bg-bg-surface/60 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-text-primary">{incident.title}</div>
              <div className={`text-[10px] font-medium ${incident.severity === 'critical' ? 'text-semantic-error' : 'text-semantic-warning'}`}>
                {incident.status} · {incident.recovery_status.replace(/_/g, ' ')}
              </div>
            </div>
            <div className="mt-1 text-xs text-text-secondary">{incident.message}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-muted">
              <span>{incident.source.replace(/_/g, ' ')}</span>
              {incident.scope_id && <span>{incident.scope_type}: {incident.scope_id}</span>}
              <span>last seen {formatRelative(incident.last_seen_at)}</span>
              {incident.recovery_window_start && incident.recovery_window_end && (
                <span>repair window {new Date(incident.recovery_window_start).toLocaleDateString()} → {new Date(incident.recovery_window_end).toLocaleDateString()}</span>
              )}
              {incident.human_action_required === 1 && <span className="text-semantic-error">requires operator action</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutlookAppOnlyHealthCard({ health }: { health: SystemStatusResponse['outlook_app_only_health'] | null | undefined }) {
  if (!health) return null;
  const tone =
    health.status === 'healthy'
      ? { icon: 'text-semantic-success', border: 'border-semantic-success/20', bg: 'bg-semantic-success/[0.03]' }
      : health.status === 'degraded'
        ? { icon: 'text-semantic-warning', border: 'border-semantic-warning/25', bg: 'bg-semantic-warning/[0.04]' }
        : { icon: 'text-semantic-error', border: 'border-semantic-error/25', bg: 'bg-semantic-error/[0.04]' };

  return (
    <div className={`card p-5 ${tone.border} ${tone.bg}`}>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <Mail size={18} className={`${tone.icon} shrink-0 mt-0.5`} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">Outlook App-Only Health</div>
            <div className="text-xs text-text-secondary mt-1">{health.label}: {health.detail}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-[10px] text-text-muted sm:min-w-[260px]">
          <div>
            <div className="text-sm font-medium text-text-primary">{health.summary.healthy_mailboxes}</div>
            healthy
          </div>
          <div>
            <div className="text-sm font-medium text-text-primary">{health.summary.missing_subscriptions + health.summary.expired_subscriptions}</div>
            subscription gaps
          </div>
          <div>
            <div className="text-sm font-medium text-text-primary">{health.summary.stale_delegated_incidents}</div>
            stale legacy
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-text-muted border-b border-border/60">
              <th className="pb-2 pr-3">Mailbox</th>
              <th className="pb-2 pr-3">Graph</th>
              <th className="pb-2 pr-3">Subscriptions</th>
              <th className="pb-2 pr-3">Last email</th>
              <th className="pb-2 pr-3">Calendar</th>
              <th className="pb-2">Queue</th>
            </tr>
          </thead>
          <tbody>
            {health.mailboxes.map(m => {
              const graphOk = m.graph.messages_ok === true && m.graph.calendar_ok === true;
              return (
                <tr key={m.user_id} className="border-b border-border/30 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-text-primary">{m.full_name || m.email || m.user_id}</div>
                    <div className="text-text-muted">{m.mailbox || 'No mailbox target'}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={graphOk ? 'text-semantic-success' : m.graph.checked_at ? 'text-semantic-error' : 'text-text-muted'}>
                      {graphOk ? 'Passing' : m.graph.checked_at ? 'Failing' : 'Not checked'}
                    </span>
                    {m.graph.error && <div className="max-w-[220px] truncate text-text-muted">{m.graph.error}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={m.subscriptions.current.length === m.subscriptions.expected.length ? 'text-semantic-success' : 'text-semantic-warning'}>
                      {m.subscriptions.current.length}/{m.subscriptions.expected.length} current
                    </span>
                    {(m.subscriptions.missing.length > 0 || m.subscriptions.expired.length > 0 || m.subscriptions.legacy.length > 0) && (
                      <div className="text-text-muted">
                        {m.subscriptions.missing.length} missing · {m.subscriptions.expired.length} expired · {m.subscriptions.legacy.length} legacy
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-text-muted">
                    {m.last_email_ingested_at ? formatRelative(m.last_email_ingested_at) : 'No evidence'}
                  </td>
                  <td className="py-2 pr-3 text-text-muted">
                    {m.last_calendar_success_at ? formatRelative(m.last_calendar_success_at) : 'No sync evidence'}
                  </td>
                  <td className="py-2 text-text-muted">
                    {m.pending_work} pending · {m.dead_letter_work} dead-lettered
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Section 1: Active Tasks ──────────────────────────────────────────────

function RateLimitIndicator({ budgets, asOf }: { budgets: BudgetSnapshotRow[]; asOf: number }) {
  const limited = React.useMemo(() => {
    const now = asOf;
    return budgets.filter(b => {
      const openUntil = b.circuit_open_until ? new Date(b.circuit_open_until).getTime() : 0;
      const circuitActuallyOpen = b.circuit_open === true && openUntil > now;
      const hardCapHit = b.cap > 0 && b.used >= b.cap && b.consecutive_429s > 0;
      return circuitActuallyOpen || hardCapHit;
    });
  }, [budgets, asOf]);

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

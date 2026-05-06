'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';
import { useDealIntelligence } from '@/lib/use-deal-intelligence';
import {
  Check,
  Clock3,
  GripVertical,
  Hash,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

type DealStage = 'new' | 'talking' | 'due_diligence' | 'term_sheet' | 'closed';

const STAGES: Array<{ key: DealStage; label: string; tone: string }> = [
  { key: 'new', label: 'New', tone: '#C084FC' },
  { key: 'talking', label: 'Talking', tone: '#38BDF8' },
  { key: 'due_diligence', label: 'Due Diligence', tone: '#FACC15' },
  { key: 'term_sheet', label: 'Term Sheet', tone: '#FB923C' },
  { key: 'closed', label: 'Closed', tone: '#22C55E' },
];

const FUNDING_LABELS: Record<string, string> = {
  pre_seed: 'Pre-Seed',
  seed: 'Seed',
  series_a: 'Series A',
  series_b: 'Series B',
  series_c: 'Series C',
  series_d: 'Series D',
  series_e_plus: 'Series E+',
  growth: 'Growth',
  bridge: 'Bridge',
  secondary: 'Secondary',
  debt: 'Debt',
  unknown: 'Unknown Stage',
};

function normalizeStage(stage: string | null | undefined): DealStage {
  return STAGES.some(s => s.key === stage) ? stage as DealStage : 'talking';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No activity';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No activity';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function daysBetween(start: string | null | undefined): string {
  if (!start) return 'New';
  const first = new Date(start).getTime();
  if (!Number.isFinite(first)) return 'New';
  const days = Math.max(0, Math.floor((Date.now() - first) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function cardTitle(deal: any): string {
  return deal.company_name || deal.title || 'Untitled startup';
}

function lastActivity(deal: any): string | null {
  return deal.last_inferred_activity_date || deal.evidence_last_seen_at || deal.last_activity_date || deal.updated_at || deal.created_at || null;
}

function DealCard({
  deal,
  selected,
  busy,
  onToggle,
  onDecision,
  onDragStart,
  onOpen,
}: {
  deal: any;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onDecision: (decision: 'yes' | 'no' | 'delete') => void;
  onDragStart: () => void;
  onOpen: () => void;
}) {
  const { intelligence } = useDealIntelligence(deal.id);
  const topics = (intelligence?.topics || []).slice(0, 4);
  const stage = normalizeStage(deal.stage);
  const isSuggestion = stage === 'new';

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className="group rounded-lg border border-border bg-bg-inset/85 p-3 transition hover:border-purple-400/70 hover:bg-bg-inset cursor-pointer"
      style={{ boxShadow: selected ? '0 0 0 1px rgba(192,132,252,0.75)' : undefined }}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className="mt-0.5 h-5 w-5 rounded border border-border flex items-center justify-center"
          style={{ background: selected ? 'rgba(192,132,252,0.18)' : 'transparent' }}
          aria-label={selected ? 'Deselect deal' : 'Select deal'}
        >
          {selected && <Check size={13} style={{ color: '#D8B4FE' }} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-fg truncate">{cardTitle(deal)}</h3>
            <GripVertical size={15} className="text-muted shrink-0 opacity-50 group-hover:opacity-100" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted">
            <span className="rounded-full border border-border px-2 py-0.5">
              {FUNDING_LABELS[deal.funding_stage] || 'Stage Unknown'}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5">
              {formatDate(lastActivity(deal))}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5">
              Age {daysBetween(deal.evidence_first_seen_at || deal.created_at)}
            </span>
          </div>
        </div>
      </div>

      {topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {topics.map(topic => (
            <span key={topic} className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[11px] text-purple-200">
              <Hash size={10} />{topic}
            </span>
          ))}
        </div>
      )}

      <p className="mt-3 line-clamp-3 text-sm leading-5 text-fg/82">
        {intelligence?.brief_summary || deal.notes || 'MARTy is waiting for enough readable activity to build the current brief.'}
      </p>

      {isSuggestion && (
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onDecision('yes'); }}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500/15 px-2 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/24 disabled:opacity-50"
          >
            <Check size={13} /> Yes
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onDecision('no'); }}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-red-500/12 px-2 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          >
            <X size={13} /> No
          </button>
        </div>
      )}
    </article>
  );
}

export default function DealsPage() {
  const router = useRouter();
  const [deals, setDeals] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [toast, setToast] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [dragDealId, setDragDealId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const loadDeals = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listDeals({ limit: '500' });
      setDeals(res.deals || []);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void loadDeals(); }, [loadDeals]);

  React.useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const byStage = React.useMemo(() => {
    const buckets: Record<DealStage, any[]> = {
      new: [],
      talking: [],
      due_diligence: [],
      term_sheet: [],
      closed: [],
    };
    for (const deal of deals) buckets[normalizeStage(deal.stage)].push(deal);
    for (const key of Object.keys(buckets) as DealStage[]) {
      buckets[key].sort((a, b) => String(lastActivity(b) || '').localeCompare(String(lastActivity(a) || '')));
    }
    return buckets;
  }, [deals]);

  function toggleSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(ids: string[], decision: 'yes' | 'no' | 'delete') {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await api.bulkDecideDeals({ deal_ids: ids, decision });
      setSelectedIds(new Set());
      setToast(decision === 'yes' ? 'Moved to Talking' : decision === 'no' ? 'Suggestion denied' : 'Deals deleted');
      await loadDeals();
    } catch (e: any) {
      setToast(e?.message || 'Decision failed');
    } finally {
      setBusy(false);
    }
  }

  async function moveDeal(dealId: string, stage: DealStage) {
    if (stage === 'new') return;
    setBusy(true);
    try {
      await api.updateDeal(dealId, { stage });
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage } : d));
      setToast(`Moved to ${STAGES.find(s => s.key === stage)?.label}`);
    } catch (e: any) {
      setToast(e?.message || 'Move failed');
    } finally {
      setBusy(false);
      setDragDealId(null);
    }
  }

  const selected = Array.from(selectedIds);

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar title="Deals" />
      <main className="px-6 py-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted">
              <Sparkles size={14} /> Conservative Deal Flow
            </div>
            <h1 className="mt-2 text-2xl font-semibold">Deals</h1>
          </div>
          <button
            type="button"
            onClick={() => void loadDeals()}
            className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-fg"
          >
            Refresh
          </button>
        </div>

        {selected.length > 0 && (
          <div className="sticky top-3 z-20 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-purple-400/40 bg-bg-inset px-4 py-3 shadow-xl">
            <span className="text-sm text-fg">{selected.length} selected</span>
            <div className="flex items-center gap-2">
              <button disabled={busy} onClick={() => void decide(selected, 'yes')} className="inline-flex items-center gap-2 rounded-md bg-emerald-500/15 px-3 py-1.5 text-sm text-emerald-300 disabled:opacity-50"><Check size={15} />Yes</button>
              <button disabled={busy} onClick={() => void decide(selected, 'no')} className="inline-flex items-center gap-2 rounded-md bg-red-500/12 px-3 py-1.5 text-sm text-red-300 disabled:opacity-50"><X size={15} />No</button>
              <button disabled={busy} onClick={() => void decide(selected, 'delete')} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-50"><Trash2 size={15} />Delete</button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center text-muted">
            <Loader2 className="mr-2 animate-spin" size={18} /> Loading deals
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-5 lg:grid-cols-3 md:grid-cols-2">
            {STAGES.map(stage => (
              <section
                key={stage.key}
                onDragOver={(e) => { if (stage.key !== 'new') e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragDealId) void moveDeal(dragDealId, stage.key);
                }}
                className="min-h-[520px] rounded-lg border border-border bg-bg-panel/60 p-3"
              >
                <header className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.tone }} />
                    <h2 className="text-sm font-semibold">{stage.label}</h2>
                  </div>
                  <span className="text-xs text-muted">{byStage[stage.key].length}</span>
                </header>
                <div className="space-y-3">
                  {byStage[stage.key].map(deal => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      selected={selectedIds.has(deal.id)}
                      busy={busy}
                      onToggle={() => toggleSelected(deal.id)}
                      onDecision={(decision) => void decide([deal.id], decision)}
                      onDragStart={() => setDragDealId(deal.id)}
                      onOpen={() => router.push(`/deals/${deal.id}`)}
                    />
                  ))}
                  {byStage[stage.key].length === 0 && (
                    <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
                      {stage.key === 'new' ? 'No AI suggestions waiting.' : 'No deals here.'}
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-bg-inset px-4 py-2 text-sm shadow-xl">
          <Clock3 size={14} className="mr-2 inline-block text-purple-300" />{toast}
        </div>
      )}
    </div>
  );
}

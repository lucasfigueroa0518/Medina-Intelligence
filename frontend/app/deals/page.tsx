'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';
import { useDealIntelligence } from '@/lib/use-deal-intelligence';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  MomentumSparkline,
  RiskFlag,
  SentimentIndicator,
  TopicChips,
} from '@/components/deal-intelligence';

type DealStage = 'new' | 'talking' | 'due_diligence' | 'term_sheet' | 'closed';

const STAGES: Array<{ key: DealStage; label: string; color: string }> = [
  { key: 'new', label: 'New', color: '#D946A8' },
  { key: 'talking', label: 'Talking', color: '#3B82F6' },
  { key: 'due_diligence', label: 'Due Diligence', color: '#EAB308' },
  { key: 'term_sheet', label: 'Term Sheet', color: '#F97316' },
  { key: 'closed', label: 'Closed', color: '#22C55E' },
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

function cardTitle(deal: any): string {
  return deal.company_name || deal.title || 'Untitled startup';
}

function lastActivity(deal: any): string | null {
  return deal.last_inferred_activity_date || deal.evidence_last_seen_at || deal.last_activity_date || deal.updated_at || deal.created_at || null;
}

function daysAgo(value: string | null | undefined): number {
  if (!value) return 999;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function daysBetween(start: string | null | undefined): string {
  if (!start) return 'New';
  const days = daysAgo(start);
  if (days === 999) return 'New';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

function DealCard({
  deal,
  stageColor,
  selected,
  busy,
  isDragging,
  onToggle,
  onDecision,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  deal: any;
  stageColor: string;
  selected: boolean;
  busy: boolean;
  isDragging: boolean;
  onToggle: () => void;
  onDecision: (decision: 'yes' | 'no' | 'delete') => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const { intelligence } = useDealIntelligence(deal.id);
  const stage = normalizeStage(deal.stage);
  const isSuggestion = stage === 'new';
  const activityDays = daysAgo(lastActivity(deal));
  const activityColor = activityDays <= 2 ? '#22C55E' : activityDays <= 7 ? '#EAB308' : '#71717A';
  const hasAmount = deal.amount && deal.amount > 0;
  const hasValuation = deal.valuation && deal.valuation > 0;
  const showCompanySubtitle = Boolean(deal.company_name && deal.title && !String(deal.title).toLowerCase().includes(String(deal.company_name).toLowerCase()));

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`card cursor-grab active:cursor-grabbing hover:border-border-hover transition-all group ${
        isDragging ? 'opacity-40 scale-95' : ''
      } ${selected ? 'ring-2 ring-accent-magenta/40' : ''}`}
      style={{ borderLeft: `3px solid ${stageColor}35` }}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onToggle(); }}
          className={`shrink-0 mt-0.5 w-3.5 h-3.5 rounded flex items-center justify-center transition-all ${
            selected
              ? 'bg-accent-magenta border-accent-magenta'
              : 'border border-white/15 opacity-0 group-hover:opacity-100 hover:border-white/40'
          }`}
          title={selected ? 'Deselect' : 'Select for bulk action'}
        >
          {selected && <Check size={10} className="text-white" />}
        </button>
        <GripVertical
          size={14}
          className="text-text-muted/30 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">{cardTitle(deal)}</div>
          {showCompanySubtitle && (
            <div className="text-xs text-text-muted mt-0.5 truncate">{deal.company_name}</div>
          )}
        </div>
      </div>

      {(hasAmount || hasValuation) && (
        <div className="text-xs text-text-secondary mt-2 font-accent font-semibold">
          {hasAmount && formatCurrency(deal.amount)}
          {hasAmount && hasValuation && ' @ '}
          {hasValuation && `${formatCurrency(deal.valuation)} pre`}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span
          className="text-[10px] font-accent px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(255,255,255,0.04)', color: '#A1A1AA' }}
        >
          {FUNDING_LABELS[deal.funding_stage] || 'Stage unknown'}
        </span>
        <span
          className="text-[10px] font-accent px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(255,255,255,0.04)', color: '#A1A1AA' }}
        >
          Age {daysBetween(deal.evidence_first_seen_at || deal.created_at)}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-2.5">
        <MomentumSparkline intelligence={intelligence} size="compact" />
        <SentimentIndicator intelligence={intelligence} size="compact" />
      </div>
      <div className="mt-1.5"><TopicChips intelligence={intelligence} size="compact" /></div>
      <div className="mt-1.5"><RiskFlag intelligence={intelligence} size="compact" /></div>

      <p className="mt-2.5 line-clamp-3 text-xs leading-5 text-text-secondary">
        {intelligence?.brief_summary || deal.notes || 'MARTy is waiting for enough readable activity to build the current brief.'}
      </p>

      <div className="flex items-center gap-2 mt-2.5">
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: activityColor }}
          title={activityDays === 999 ? 'No activity yet' : `Last activity: ${activityDays}d ago`}
        />
        <span className="text-[10px] text-text-muted font-accent">
          {activityDays === 999 ? 'No activity' : `${activityDays}d ago`}
        </span>
      </div>

      {isSuggestion && (
        <div className="mt-3 flex items-center gap-2 border-t border-white/[0.04] pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={e => { e.stopPropagation(); onDecision('yes'); }}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: 'rgba(34,197,94,0.12)', color: '#4ADE80', border: '1px solid rgba(34,197,94,0.22)' }}
          >
            <Check size={12} /> Yes
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={e => { e.stopPropagation(); onDecision('no'); }}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40"
            style={{ background: 'rgba(239,68,68,0.10)', color: '#F87171', border: '1px solid rgba(239,68,68,0.20)' }}
          >
            <X size={12} /> No
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
  const [dragOverStage, setDragOverStage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

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
    const t = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const updateScrollButtons = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollButtons();
    el.addEventListener('scroll', updateScrollButtons, { passive: true });
    const ro = new ResizeObserver(updateScrollButtons);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollButtons);
      ro.disconnect();
    };
  }, [loading, updateScrollButtons]);

  function scrollBy(dir: 'left' | 'right') {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -320 : 320, behavior: 'smooth' });
  }

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

  const totalPipeline = deals
    .filter(d => normalizeStage(d.stage) !== 'closed')
    .reduce((sum, d) => sum + (d.amount || 0), 0);

  function toggleSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDragStart(e: React.DragEvent, dealId: string) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dealId);
    setDragDealId(dealId);
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
      setDragOverStage(null);
    }
  }

  const selected = Array.from(selectedIds);

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="Deal Pipeline"
        actions={
          <div className="flex items-center gap-4">
            {totalPipeline > 0 && (
              <span
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-xl font-accent"
                style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)' }}
              >
                <span className="text-sm text-text-muted font-semibold">Pipeline:</span>
                <span className="text-xl font-bold text-semantic-success">{formatCurrency(totalPipeline)}</span>
              </span>
            )}
            <button className="btn-secondary flex items-center gap-2 py-2" onClick={() => void loadDeals()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 relative">
        {canScrollLeft && (
          <button
            onClick={() => scrollBy('left')}
            className="absolute left-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center bg-bg-elevated/80 backdrop-blur-sm border border-border/50 text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-all shadow-lg"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        {canScrollRight && (
          <button
            onClick={() => scrollBy('right')}
            className="absolute right-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center bg-bg-elevated/80 backdrop-blur-sm border border-border/50 text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-all shadow-lg"
          >
            <ChevronRight size={16} />
          </button>
        )}

        <div ref={scrollRef} className="h-full p-6 overflow-x-auto deals-scroll">
          {loading ? (
            <div className="flex h-64 items-center text-text-secondary">
              <Loader2 className="mr-2 animate-spin" size={18} /> Loading pipeline...
            </div>
          ) : (
            <div className="flex gap-4 h-full min-w-max">
              {STAGES.map(stage => {
                const dealsForStage = byStage[stage.key];
                const isDropTarget = dragOverStage === stage.key;
                const stageTotal = dealsForStage.reduce((s, d) => s + (d.amount || 0), 0);
                const countLabel = dealsForStage.length === 1 ? '1 deal' : `${dealsForStage.length} deals`;
                const headerParts = [stage.label, countLabel];
                if (stageTotal > 0) headerParts.push(formatCurrency(stageTotal));

                return (
                  <section
                    key={stage.key}
                    className={`w-72 flex-shrink-0 rounded-xl p-3 transition-all duration-150 ${isDropTarget ? 'ring-2 ring-accent-magenta/40' : ''}`}
                    style={{
                      background: isDropTarget ? 'rgba(217,70,168,0.06)' : 'rgba(17,17,20,0.4)',
                    }}
                    onDragOver={e => { if (stage.key !== 'new') { e.preventDefault(); setDragOverStage(stage.key); } }}
                    onDragLeave={() => setDragOverStage(null)}
                    onDrop={e => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain') || dragDealId;
                      if (id) void moveDeal(id, stage.key);
                    }}
                  >
                    <div className="flex items-center gap-2 mb-3 px-2">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: stage.color }} />
                      <span className="text-sm font-semibold text-text-primary truncate font-accent">
                        {headerParts.join(' · ')}
                      </span>
                    </div>

                    <div className="space-y-2">
                      {dealsForStage.map(deal => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          stageColor={stage.color}
                          selected={selectedIds.has(deal.id)}
                          busy={busy}
                          isDragging={dragDealId === deal.id}
                          onToggle={() => toggleSelected(deal.id)}
                          onDecision={(decision) => void decide([deal.id], decision)}
                          onDragStart={(e) => handleDragStart(e, deal.id)}
                          onDragEnd={() => { setDragDealId(null); setDragOverStage(null); }}
                          onOpen={() => router.push(`/deals/${deal.id}`)}
                        />
                      ))}
                      {dealsForStage.length === 0 && (
                        <div className="rounded-xl border border-dashed border-white/10 px-3 py-8 text-center text-sm text-text-muted">
                          {stage.key === 'new' ? 'No AI suggestions waiting.' : 'No deals here.'}
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .deals-scroll::-webkit-scrollbar { height: 6px; }
        .deals-scroll::-webkit-scrollbar-track { background: transparent; }
        .deals-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
        .deals-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
      `}} />

      {selected.length > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3"
          style={{ background: '#1A1A1F', border: '1px solid rgba(217,70,168,0.30)', borderLeft: '3px solid #D946A8' }}
        >
          <span className="text-sm text-text-primary font-medium">{selected.length} selected</span>
          <div className="w-px h-5 bg-white/10" />
          <button disabled={busy} onClick={() => void decide(selected, 'yes')} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">
            Yes
          </button>
          <button disabled={busy} onClick={() => void decide(selected, 'no')} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">
            No
          </button>
          <button disabled={busy} onClick={() => void decide(selected, 'delete')} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-semantic-error hover:bg-red-500/10 disabled:opacity-50">
            <Trash2 size={12} /> Delete
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-text-muted hover:text-text-primary p-1 rounded">
            <X size={14} />
          </button>
        </div>
      )}

      {toast && (() => {
        const isError = /fail|error/i.test(toast);
        return (
          <div
            className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
            style={{
              background: '#1A1A1F',
              border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`,
              borderLeft: `3px solid ${isError ? '#EF4444' : '#22C55E'}`,
            }}
          >
            <div className="text-sm text-text-primary">{toast}</div>
          </div>
        );
      })()}
    </div>
  );
}

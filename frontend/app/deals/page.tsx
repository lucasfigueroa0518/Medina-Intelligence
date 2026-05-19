'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { ExpandableText } from '@/components/expandable-text';
import { api, type DealReplayStatusSnapshot, type DetectedDealCandidate } from '@/lib/api';
import { cleanIntelBrief } from '@/lib/intelligence-briefing';
import { useDealIntelligence } from '@/lib/use-deal-intelligence';
import { demoDeals, demoDetectedDeals, demoToastMessage, useDemoMode } from '@/lib/demo-mode';
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

type DealStage = 'new' | 'talking' | 'due_diligence' | 'term_sheet' | 'closed';

const STAGES: Array<{ key: DealStage; label: string; color: string }> = [
  { key: 'new', label: 'New', color: '#D946A8' },
  { key: 'talking', label: 'Talking', color: '#3B82F6' },
  { key: 'due_diligence', label: 'Due Diligence', color: '#EAB308' },
  { key: 'term_sheet', label: 'Term Sheet', color: '#F97316' },
  { key: 'closed', label: 'Closed', color: '#22C55E' },
];

function normalizeStage(stage: string | null | undefined): DealStage {
  return STAGES.some(s => s.key === stage) ? stage as DealStage : 'talking';
}

function cardTitle(deal: any): string {
  return deal.company_name || deal.title || 'Untitled startup';
}

function lastActivity(deal: any): string | null {
  return deal.last_inferred_activity_date || deal.evidence_last_seen_at || deal.last_activity_date || deal.updated_at || deal.created_at || null;
}

function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

function DealCard({
  deal,
  stage,
  stageColor,
  selected,
  busy,
  isDragging,
  onToggle,
  onYes,
  onNo,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  deal: any;
  stage: DealStage;
  stageColor: string;
  selected: boolean;
  busy: boolean;
  isDragging: boolean;
  onToggle: () => void;
  onYes: () => void;
  onNo: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const { intelligence } = useDealIntelligence(deal.id);
  const brief = cleanIntelBrief(intelligence?.brief_summary) || cleanIntelBrief(deal.notes) || 'No current intel brief yet.';

  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`card relative !p-3 cursor-grab active:cursor-grabbing hover:border-border-hover transition-all group ${
        isDragging ? 'opacity-40 scale-95' : ''
      } ${selected ? 'ring-2 ring-accent-magenta/40' : ''}`}
      style={{ borderLeft: `3px solid ${stageColor}35` }}
    >
      <div className={`absolute right-2 top-2 flex items-center gap-1 transition-opacity ${
        selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
      }`}>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onToggle(); }}
          disabled={busy}
          className={`shrink-0 w-4 h-4 rounded flex items-center justify-center transition-all ${
            selected
              ? 'bg-accent-magenta border-accent-magenta'
              : 'border border-white/15 hover:border-white/40'
          }`}
          title={selected ? 'Deselect' : 'Select for bulk action'}
        >
          {selected && <Check size={10} className="text-white" />}
        </button>
        <GripVertical
          size={14}
          className="text-text-muted/30 shrink-0"
        />
      </div>
      <div className="min-w-0 pr-8">
        <div className="truncate text-sm font-semibold text-text-primary">{cardTitle(deal)}</div>
        <ExpandableText
          text={brief}
          collapsedLines={2}
          minToggleChars={120}
          className="mt-1 text-xs leading-5 text-text-secondary"
        />
        {stage === 'new' && (
          <div className="mt-3">
            <div className="mb-2 rounded-md border border-accent-magenta/15 bg-accent-magenta/[0.06] px-2 py-1.5 text-[11px] leading-4 text-text-secondary">
              Is this actually a deal? Yes moves it to Talking; drag it afterward if another stage fits better.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={e => { e.stopPropagation(); onYes(); }}
                className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-2 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/[0.10] disabled:opacity-50"
              >
                Yes, move
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={e => { e.stopPropagation(); onNo(); }}
                className="rounded-lg border border-red-500/20 bg-red-500/[0.05] px-2 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/[0.10] disabled:opacity-50"
              >
                No, reject
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function OtherDetectedDeals({
  candidates,
  open,
  busyCompanyId,
  onToggle,
  onPromote,
}: {
  candidates: DetectedDealCandidate[];
  open: boolean;
  busyCompanyId: string | null;
  onToggle: () => void;
  onPromote: (candidate: DetectedDealCandidate) => void;
}) {
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group w-full rounded-lg border border-accent-magenta/35 bg-accent-magenta/[0.08] px-3 py-3 text-left shadow-[0_0_22px_rgba(217,70,168,0.14)] transition-all hover:-translate-y-0.5 hover:border-accent-magenta/60 hover:bg-accent-magenta/[0.12] hover:shadow-[0_0_30px_rgba(217,70,168,0.20)]"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-magenta/35 bg-accent-magenta/[0.16] text-accent-magenta">
              <Sparkles size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-semibold text-text-primary">Other detected deals</div>
                {candidates.length > 0 && (
                  <span className="rounded-full bg-accent-magenta px-2 py-0.5 text-[10px] font-bold leading-none text-white">
                    {candidates.length}
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-[11px] text-text-secondary">
                {candidates.length > 0
                  ? `${candidates.length} below auto-threshold · 2+ strong evidence`
                  : 'None waiting for manual review'}
              </div>
            </div>
          </div>
          <ChevronRight size={16} className={`shrink-0 text-accent-magenta transition-transform group-hover:text-text-primary ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-accent-magenta/20 bg-bg-surface/80 p-2 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          {candidates.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-text-muted">
              Detected deals will appear here after at least two strong evidence records.
            </div>
          ) : candidates.map(candidate => {
            const latest = candidate.latest_evidence;
            const brief = latest?.evidence_note || latest?.source_excerpt || 'Strong evidence found, but not enough yet for automatic promotion.';
            const families = candidate.source_families.length > 0 ? candidate.source_families.join(', ') : 'source evidence';
            const pct = Math.round((candidate.avg_confidence || 0) * 100);
            return (
              <article key={candidate.company_id} className="rounded-lg border border-white/10 bg-black/20 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-text-primary">{candidate.company_name}</div>
                    <div className="mt-0.5 text-[11px] text-text-muted">
                      {candidate.evidence_count} evidence · {candidate.source_family_count} families · {pct}% avg
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyCompanyId === candidate.company_id}
                    onClick={() => onPromote(candidate)}
                    className="shrink-0 rounded-md border border-accent-magenta/35 bg-accent-magenta/[0.12] px-2 py-1 text-[11px] font-medium text-accent-magenta transition-colors hover:bg-accent-magenta/[0.18] disabled:opacity-50"
                  >
                    {busyCompanyId === candidate.company_id ? <Loader2 size={12} className="animate-spin" /> : 'Add'}
                  </button>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-text-secondary">{brief}</p>
                <div className="mt-2 truncate text-[10px] text-text-muted">{families}</div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DealsPage() {
  const router = useRouter();
  const demoMode = useDemoMode();
  const [deals, setDeals] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [toast, setToast] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [dragDealId, setDragDealId] = React.useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [replayStatus, setReplayStatus] = React.useState<DealReplayStatusSnapshot | null>(null);
  const [detectedCandidates, setDetectedCandidates] = React.useState<DetectedDealCandidate[]>([]);
  const [detectedOpen, setDetectedOpen] = React.useState(false);
  const [detectedBusyId, setDetectedBusyId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  const loadDeals = React.useCallback(async () => {
    if (demoMode) {
      setDeals(demoDeals);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.listDeals({ limit: '500' });
      setDeals(res.deals || []);
    } finally {
      setLoading(false);
    }
  }, [demoMode]);

  React.useEffect(() => { void loadDeals(); }, [loadDeals]);

  const loadDetectedCandidates = React.useCallback(async () => {
    if (demoMode) {
      setDetectedCandidates(demoDetectedDeals as DetectedDealCandidate[]);
      return;
    }
    try {
      const res = await api.getDetectedDealCandidates({ limit: 25 });
      setDetectedCandidates(res.candidates || []);
    } catch {
      setDetectedCandidates([]);
    }
  }, [demoMode]);

  React.useEffect(() => { void loadDetectedCandidates(); }, [loadDetectedCandidates]);

  React.useEffect(() => {
    if (demoMode) {
      setReplayStatus(null);
      return;
    }
    let cancelled = false;
    async function loadReplayStatus() {
      try {
        const status = await api.getDealReplayStatus();
        if (!cancelled) setReplayStatus(status);
      } catch {
        if (!cancelled) setReplayStatus(null);
      }
    }
    void loadReplayStatus();
    const interval = window.setInterval(loadReplayStatus, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [demoMode]);

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
    if (demoMode) {
      if (decision === 'yes') {
        setDeals(prev => prev.map(deal => ids.includes(deal.id) ? { ...deal, stage: 'talking' } : deal));
        setToast('Demo mode: confirmed and moved to Talking locally');
      } else {
        setDeals(prev => prev.filter(deal => !ids.includes(deal.id)));
        setToast(decision === 'no' ? 'Demo mode: rejected suggestion locally' : demoToastMessage('Deleting deals'));
      }
      setSelectedIds(new Set());
      setBusy(false);
      return;
    }
    try {
      await api.bulkDecideDeals({ deal_ids: ids, decision });
      setSelectedIds(new Set());
      setToast(decision === 'yes' ? 'Confirmed and moved to Talking' : decision === 'no' ? 'Rejected suggestion' : 'Deals deleted');
      await loadDeals();
      void loadDetectedCandidates();
    } catch (e: any) {
      setToast(e?.message || 'Decision failed');
    } finally {
      setBusy(false);
    }
  }

  async function promoteDetectedCandidate(candidate: DetectedDealCandidate) {
    setDetectedBusyId(candidate.company_id);
    if (demoMode) {
      const demoDeal = {
        id: `demo-deal-${candidate.company_id}`,
        title: candidate.company_name,
        company_name: candidate.company_name,
        company_id: candidate.company_id,
        stage: 'new',
        amount: 0,
        notes: candidate.latest_evidence?.evidence_note || candidate.latest_evidence?.source_excerpt || 'Synthetic detected deal promoted locally for recording.',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        evidence_first_seen_at: new Date(Date.now() - 4 * 86400000).toISOString(),
        evidence_last_seen_at: new Date().toISOString(),
      };
      setDeals(prev => [demoDeal, ...prev]);
      setDetectedCandidates(prev => prev.filter(item => item.company_id !== candidate.company_id));
      setDetectedOpen(false);
      setDetectedBusyId(null);
      setToast(`Demo mode: ${candidate.company_name} added to New locally`);
      return;
    }
    try {
      await api.promoteDetectedDealCandidate(candidate.company_id);
      setDetectedOpen(false);
      setToast(`${candidate.company_name} added to New`);
      await Promise.all([loadDeals(), loadDetectedCandidates()]);
    } catch (e: any) {
      setToast(e?.message || 'Could not add detected deal');
    } finally {
      setDetectedBusyId(null);
    }
  }

  async function moveDeal(dealId: string, stage: DealStage) {
    if (stage === 'new') return;
    setBusy(true);
    if (demoMode) {
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage } : d));
      setToast(`Demo mode: moved to ${STAGES.find(s => s.key === stage)?.label} locally`);
      setBusy(false);
      setDragDealId(null);
      setDragOverStage(null);
      return;
    }
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

      <DealReplayBanner status={replayStatus} />

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
                    className={`${stage.key === 'new' ? 'w-80 border border-accent-magenta/20 shadow-[0_0_34px_rgba(217,70,168,0.10)]' : 'w-72'} flex-shrink-0 rounded-xl p-3 transition-all duration-150 ${isDropTarget ? 'ring-2 ring-accent-magenta/40' : ''}`}
                    style={{
                      background: isDropTarget
                        ? 'rgba(217,70,168,0.06)'
                        : stage.key === 'new'
                          ? 'linear-gradient(180deg, rgba(217,70,168,0.10), rgba(17,17,20,0.64) 34%, rgba(17,17,20,0.42))'
                          : 'rgba(17,17,20,0.4)',
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

                    {stage.key === 'new' && (
                      <>
                        <div className="mb-3 rounded-lg border border-accent-magenta/35 bg-accent-magenta/[0.10] px-3 py-3 shadow-[0_0_26px_rgba(217,70,168,0.16)]">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-magenta/35 bg-accent-magenta/[0.18] text-accent-magenta">
                              <Sparkles size={15} />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold leading-5 text-text-primary">
                                Review AI-surfaced suggestions
                              </div>
                              <div className="mt-1 text-[11px] leading-4 text-text-secondary">
                                Yes confirms the deal and moves it to Talking; drag cards afterward to set the right stage.
                              </div>
                            </div>
                          </div>
                        </div>
                        <OtherDetectedDeals
                          candidates={detectedCandidates}
                          open={detectedOpen}
                          busyCompanyId={detectedBusyId}
                          onToggle={() => setDetectedOpen(v => !v)}
                          onPromote={candidate => void promoteDetectedCandidate(candidate)}
                        />
                      </>
                    )}

                    <div className="space-y-2">
                      {dealsForStage.map(deal => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          stage={stage.key}
                          stageColor={stage.color}
                          selected={selectedIds.has(deal.id)}
                          busy={busy}
                          isDragging={dragDealId === deal.id}
                          onToggle={() => toggleSelected(deal.id)}
                          onYes={() => void decide([deal.id], 'yes')}
                          onNo={() => void decide([deal.id], 'no')}
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
            Confirm
          </button>
          <button disabled={busy} onClick={() => void decide(selected, 'no')} className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">
            Reject
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

function DealReplayBanner({ status }: { status: DealReplayStatusSnapshot | null }) {
  const run = status?.run;
  if (!run || run.status !== 'running') return null;

  const totalWork = Math.max(
    run.processed_count + (status?.queue.pending || 0) + (status?.queue.in_progress || 0),
    run.enqueued_count,
    1
  );
  const pct = Math.min(100, Math.max(2, Math.round((run.processed_count / totalWork) * 100)));

  return (
    <div className="mx-4 mt-4 rounded-xl border border-accent-magenta/20 bg-accent-magenta/[0.06] px-4 py-3 md:mx-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Deal rebuild running</div>
          <div className="mt-0.5 text-xs text-text-muted">
            {run.processed_count.toLocaleString()} processed · {run.promoted_count.toLocaleString()} promoted to New · {run.rate_limited_count.toLocaleString()} Claude pauses
          </div>
        </div>
        <a href="/settings?tab=system" className="text-xs text-accent-magenta transition-colors hover:text-accent-magenta/80">
          View run cockpit
        </a>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

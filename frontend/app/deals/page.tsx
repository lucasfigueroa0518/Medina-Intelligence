'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { CompanySearchField } from '@/components/company-search-field';
import { api, type DealReplayStatusSnapshot } from '@/lib/api';
import {
  Plus,
  X as XIcon,
  GripVertical,
  ChevronLeft,
  ChevronRight,
  Filter,
  Check,
  Trash2,
} from 'lucide-react';
import {
  SentimentIndicator,
  TopicChips,
  RiskFlag,
  MomentumSparkline,
} from '@/components/deal-intelligence';
import { useDealIntelligence } from '@/lib/use-deal-intelligence';

type DealStage =
  | 'prospect' | 'first_contact' | 'meeting_scheduled'
  | 'due_diligence' | 'term_sheet' | 'closing'
  | 'closed_won' | 'closed_lost';

const STAGES: { key: DealStage; label: string; color: string }[] = [
  { key: 'prospect', label: 'Prospect', color: '#71717A' },
  { key: 'first_contact', label: 'First Contact', color: '#3B82F6' },
  { key: 'meeting_scheduled', label: 'Meeting Scheduled', color: '#06B6D4' },
  { key: 'due_diligence', label: 'Due Diligence', color: '#EAB308' },
  { key: 'term_sheet', label: 'Term Sheet', color: '#F97316' },
  { key: 'closing', label: 'Closing', color: '#8B5CF6' },
  { key: 'closed_won', label: 'Closed Won', color: '#22C55E' },
  { key: 'closed_lost', label: 'Closed Lost', color: '#EF4444' },
];

const INSTRUMENT_OPTIONS = [
  { value: 'safe', label: 'SAFE' },
  { value: 'convertible_note', label: 'Convertible Note' },
  { value: 'equity', label: 'Equity' },
  { value: 'debt', label: 'Debt' },
  { value: 'other', label: 'Other' },
];

interface CreateDealForm {
  title: string;
  company_id: string | null;
  company_name: string;
  stage: DealStage;
  amount: string;
  valuation: string;
  our_allocation: string;
  instrument_type: string;
  expected_close: string;
  lead_source: string;
  owner_id: string;
}

const EMPTY_FORM: CreateDealForm = {
  title: '', company_id: null, company_name: '', stage: 'prospect',
  amount: '', valuation: '', our_allocation: '', instrument_type: '',
  expected_close: '', lead_source: '', owner_id: '',
};

export default function DealsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [deals, setDeals] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [form, setForm] = React.useState<CreateDealForm>({ ...EMPTY_FORM });
  const [creating, setCreating] = React.useState(false);
  const [users, setUsers] = React.useState<any[]>([]);
  const [toast, setToast] = React.useState<string | null>(null);
  const [dragDealId, setDragDealId] = React.useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [filterPanelOpen, setFilterPanelOpen] = React.useState(false);
  /* Day-5 Phase C: bulk selection state. Set of selected deal IDs; cleared
     on every fresh data load (deals re-fetched after a filter / sort change
     would otherwise leave stale selection refs around). */
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkConfirmArchive, setBulkConfirmArchive] = React.useState(false);
  const [replayStatus, setReplayStatus] = React.useState<DealReplayStatusSnapshot | null>(null);

  function toggleSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function bulkSetStage(stage: string) {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const r = await api.bulkUpdateDeals({
        deal_ids: Array.from(selectedIds),
        updates: { stage },
      });
      setToast(`${r.updated_count} deal${r.updated_count === 1 ? '' : 's'} moved to ${STAGES.find(s => s.key === stage)?.label || stage}`);
      clearSelection();
      setRefreshKey(k => k + 1);
    } catch (e: any) {
      setToast(`Bulk update failed: ${e?.message || 'unknown'}`);
    }
    setBulkBusy(false);
  }
  async function bulkSetOwner(ownerId: string | null) {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const r = await api.bulkUpdateDeals({
        deal_ids: Array.from(selectedIds),
        updates: { owner_id: ownerId },
      });
      const label = ownerId
        ? (users.find(u => u.id === ownerId)?.full_name || users.find(u => u.id === ownerId)?.email || 'user')
        : 'unassigned';
      setToast(`${r.updated_count} deal${r.updated_count === 1 ? '' : 's'} → ${label}`);
      clearSelection();
      setRefreshKey(k => k + 1);
    } catch (e: any) {
      setToast(`Bulk reassign failed: ${e?.message || 'unknown'}`);
    }
    setBulkBusy(false);
  }
  async function bulkArchive() {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const r = await api.bulkUpdateDeals({
        deal_ids: Array.from(selectedIds),
        archive: true,
      });
      setToast(`${r.updated_count} deal${r.updated_count === 1 ? '' : 's'} archived`);
      clearSelection();
      setBulkConfirmArchive(false);
      setRefreshKey(k => k + 1);
    } catch (e: any) {
      setToast(`Bulk archive failed: ${e?.message || 'unknown'}`);
    }
    setBulkBusy(false);
  }

  /* ── Day-5 Phase A: filter state. URL is the source of truth — values
       persist across refresh and share-links. Filter row updates the URL,
       the listDeals fetch reads from URL, refetch chained on URL changes. */
  const filters = React.useMemo(() => ({
    stage: searchParams.getAll('stage').filter(Boolean),
    owner_id: searchParams.getAll('owner_id').filter(Boolean),
    instrument_type: searchParams.getAll('instrument_type').filter(Boolean),
    lead_source: searchParams.getAll('lead_source').filter(Boolean),
    min_amount: searchParams.get('min_amount') ?? '',
    max_amount: searchParams.get('max_amount') ?? '',
    has_memo: searchParams.get('has_memo') ?? '',  // '' | 'true' | 'false'
  }), [searchParams]);

  const filterCount =
    filters.stage.length +
    filters.owner_id.length +
    filters.instrument_type.length +
    filters.lead_source.length +
    (filters.min_amount ? 1 : 0) +
    (filters.max_amount ? 1 : 0) +
    (filters.has_memo ? 1 : 0);

  function updateFilters(mut: (sp: URLSearchParams) => void) {
    const next = new URLSearchParams(searchParams.toString());
    mut(next);
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }

  function toggleArrayFilter(key: string, value: string) {
    updateFilters(sp => {
      const cur = sp.getAll(key);
      sp.delete(key);
      if (cur.includes(value)) {
        for (const v of cur) if (v !== value) sp.append(key, v);
      } else {
        for (const v of cur) sp.append(key, v);
        sp.append(key, value);
      }
    });
  }

  function setScalarFilter(key: string, value: string | null) {
    updateFilters(sp => {
      sp.delete(key);
      if (value !== null && value !== '') sp.append(key, value);
    });
  }

  function clearAllFilters() {
    router.replace('?', { scroll: false });
  }

  /* ── Horizontal scroll state ── */
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

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
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -300 : 300, behavior: 'smooth' });
  }

  /* ── Data loading ── refetch when filters change OR refreshKey bumps. */
  React.useEffect(() => {
    setLoading(true);
    api.listDeals(searchParams)
      .then(d => setDeals(d.deals))
      .finally(() => setLoading(false));
    // searchParams from useSearchParams is reactive; this effect fires
    // every time the URL filter set changes.
  }, [refreshKey, searchParams]);

  React.useEffect(() => {
    api.listUsers().then(u => setUsers(u.users || []));
  }, []);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  React.useEffect(() => {
    let cancelled = false;
    async function loadReplayStatus() {
      try {
        const status = await api.getDealReplayStatus();
        if (!cancelled) setReplayStatus(status);
      } catch {
        if (!cancelled) setReplayStatus(null);
      }
    }
    loadReplayStatus();
    const id = window.setInterval(loadReplayStatus, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  function openModal() {
    setForm({ ...EMPTY_FORM });
    setModalOpen(true);
  }

  async function handleCreate() {
    if (!form.title.trim() || !form.company_id) return;
    setCreating(true);
    try {
      const data: any = {
        title: form.title.trim(),
        company_id: form.company_id,
        stage: form.stage,
      };
      if (form.amount) data.amount = parseFloat(form.amount);
      if (form.valuation) data.valuation = parseFloat(form.valuation);
      if (form.our_allocation) data.our_allocation = parseFloat(form.our_allocation);
      if (form.instrument_type) data.instrument_type = form.instrument_type;
      if (form.expected_close) data.expected_close = form.expected_close;
      if (form.lead_source) data.lead_source = form.lead_source.trim();
      if (form.owner_id) data.owner_id = form.owner_id;

      await api.createDeal(data);
      setModalOpen(false);
      setRefreshKey(k => k + 1);
      setToast('Deal created');
    } catch (e: any) {
      setToast(`Failed: ${e.message || 'Unknown error'}`);
    } finally {
      setCreating(false);
    }
  }

  /* ── Drag and drop ── */

  function handleDragStart(e: React.DragEvent, dealId: string) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dealId);
    setDragDealId(dealId);
  }

  function handleDragOver(e: React.DragEvent, stage: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverStage(stage);
  }

  function handleDragLeave() {
    setDragOverStage(null);
  }

  async function handleDrop(e: React.DragEvent, targetStage: string) {
    e.preventDefault();
    setDragOverStage(null);
    const dealId = e.dataTransfer.getData('text/plain');
    if (!dealId) return;

    const deal = deals.find(d => d.id === dealId);
    if (!deal || deal.stage === targetStage) {
      setDragDealId(null);
      return;
    }

    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, stage: targetStage } : d));
    setDragDealId(null);

    try {
      await api.updateDeal(dealId, { stage: targetStage });
      const stageLabel = STAGES.find(s => s.key === targetStage)?.label || targetStage;
      setToast(`Deal moved to ${stageLabel}`);
    } catch (e: any) {
      setRefreshKey(k => k + 1);
      setToast(`Move failed: ${e.message || 'Unknown error'}`);
    }
  }

  function handleDragEnd() {
    setDragDealId(null);
    setDragOverStage(null);
  }

  /* Day-5 Phase B: per-column sort. Read from URL ?sort=...; client-side
     sort applied to the already-loaded deals so column re-sort doesn't
     trigger a refetch. Default 'expected_close' matches backend's existing
     ORDER BY (server-side sort is the fallback when ?sort= is absent). */
  const sortKey = (searchParams.get('sort') || 'expected_close') as DealSortKey;
  const dealsByStage = STAGES.map(stage => ({
    ...stage,
    deals: sortDealsForColumn(deals.filter(d => d.stage === stage.key), sortKey),
  }));

  const totalPipeline = deals
    .filter(d => !['closed_won', 'closed_lost'].includes(d.stage))
    .reduce((s, d) => s + (d.amount || 0), 0);

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
            <button
              onClick={() => setFilterPanelOpen(o => !o)}
              className={`btn-ghost flex items-center gap-2 text-xs py-1.5 ${filterCount > 0 ? 'text-accent-magenta' : ''}`}
              title="Filters"
            >
              <Filter size={14} />
              {filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
            </button>
            {/* Day-5 Phase B: sort dropdown. Client-side sort applied to
                already-loaded deals (no refetch). */}
            <select
              value={sortKey}
              onChange={e => setScalarFilter('sort', e.target.value === 'expected_close' ? null : e.target.value)}
              className="input text-xs py-1.5 px-2"
              title="Sort within column"
            >
              {SORT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>Sort: {opt.label}</option>
              ))}
            </select>
            <button className="btn-primary flex items-center gap-2" onClick={openModal}>
              <Plus size={16} /> Add Deal
            </button>
          </div>
        }
      />

      <DealReplayBanner status={replayStatus} />

      {/* ── Day-5 Phase A: filter panel. URL-state-driven; refresh / share-link
           preserves selections. Multi-select chips for stage/owner/instrument/
           lead-source. Range inputs for amount. Tri-state for has_memo. ── */}
      {filterPanelOpen && (
        <DealFiltersPanel
          filters={filters}
          users={users}
          allDeals={deals}
          onToggle={toggleArrayFilter}
          onSetScalar={setScalarFilter}
          onClearAll={clearAllFilters}
          onClose={() => setFilterPanelOpen(false)}
        />
      )}

      {/* ── Pipeline board with scroll arrows ── */}
      <div className="flex-1 relative">
        {/* Left scroll arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scrollBy('left')}
            className="absolute left-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full
              flex items-center justify-center
              bg-bg-elevated/80 backdrop-blur-sm border border-border/50
              text-text-muted hover:text-text-primary hover:bg-bg-elevated
              transition-all shadow-lg"
          >
            <ChevronLeft size={16} />
          </button>
        )}

        {/* Right scroll arrow */}
        {canScrollRight && (
          <button
            onClick={() => scrollBy('right')}
            className="absolute right-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full
              flex items-center justify-center
              bg-bg-elevated/80 backdrop-blur-sm border border-border/50
              text-text-muted hover:text-text-primary hover:bg-bg-elevated
              transition-all shadow-lg"
          >
            <ChevronRight size={16} />
          </button>
        )}

        <div
          ref={scrollRef}
          className="h-full p-6 overflow-x-auto deals-scroll"
        >
          {loading ? (
            <div className="text-text-secondary">Loading pipeline...</div>
          ) : (
            <div className="flex gap-4 h-full min-w-max">
              {dealsByStage.map((stage) => {
                const isClosed = stage.key === 'closed_won' || stage.key === 'closed_lost';
                const isDropTarget = dragOverStage === stage.key;
                const stageTotal = stage.deals.reduce((s, d) => s + (d.amount || 0), 0);
                const dealCount = stage.deals.length;
                const countLabel = dealCount === 1 ? '1 deal' : `${dealCount} deals`;

                /* Column header: "Term Sheet · 1 deal · $5.0M" */
                const headerParts = [stage.label, countLabel];
                if (stageTotal > 0) headerParts.push(formatCurrency(stageTotal));
                const headerText = headerParts.join(' \u00B7 ');

                return (
                  <div
                    key={stage.key}
                    className={`w-72 flex-shrink-0 rounded-xl p-3 transition-all duration-150 ${
                      isClosed ? 'border-l-4' : ''
                    } ${isDropTarget ? 'ring-2 ring-accent-magenta/40' : ''}`}
                    style={{
                      background: isDropTarget ? 'rgba(217,70,168,0.06)' : 'rgba(17,17,20,0.4)',
                      borderColor: isClosed ? stage.color + '30' : undefined,
                    }}
                    onDragOver={e => handleDragOver(e, stage.key)}
                    onDragLeave={handleDragLeave}
                    onDrop={e => handleDrop(e, stage.key)}
                  >
                    {/* Column header */}
                    <div className="flex items-center gap-2 mb-3 px-2">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: stage.color }} />
                      <span className="text-sm font-semibold text-text-primary truncate font-accent">
                        {headerText}
                      </span>
                    </div>

                    <div className="space-y-2">
                      {stage.deals.map(deal => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          stageColor={stage.color}
                          isDragging={dragDealId === deal.id}
                          onDragStart={handleDragStart}
                          onDragEnd={handleDragEnd}
                          selected={selectedIds.has(deal.id)}
                          onToggleSelect={() => toggleSelected(deal.id)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Scrollbar style ── */}
      <style dangerouslySetInnerHTML={{ __html: `
        .deals-scroll::-webkit-scrollbar {
          height: 6px;
        }
        .deals-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .deals-scroll::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.12);
          border-radius: 3px;
        }
        .deals-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.22);
        }
      `}} />

      {/* ── Day-5 Phase C: bulk action bar. Floats at the bottom when 1+
          deals are selected. Stays out of the way otherwise. ── */}
      {selectedIds.size > 0 && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          users={users}
          busy={bulkBusy}
          onSetStage={bulkSetStage}
          onSetOwner={bulkSetOwner}
          onArchive={() => setBulkConfirmArchive(true)}
          onClear={clearSelection}
        />
      )}

      {bulkConfirmArchive && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => !bulkBusy && setBulkConfirmArchive(false)}
        >
          <div
            className="bg-bg-elevated rounded-2xl w-full max-w-sm shadow-2xl border border-border p-6"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-lg font-medium text-text-primary mb-2">
              Archive {selectedIds.size} deal{selectedIds.size === 1 ? '' : 's'}?
            </div>
            <div className="text-sm text-text-secondary mb-4">
              Archived deals are soft-deleted (hidden from the board) but kept in the database
              for audit / restore. This is reversible — contact an admin to recover if needed.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setBulkConfirmArchive(false)} disabled={bulkBusy}>
                Cancel
              </button>
              <button
                className="btn-primary"
                style={{ background: '#DC2626', borderColor: '#DC2626' }}
                onClick={bulkArchive}
                disabled={bulkBusy}
              >
                {bulkBusy ? 'Archiving...' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Deal Modal ── */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => !creating && setModalOpen(false)}
        >
          <div
            className="bg-bg-elevated rounded-2xl w-full max-w-lg shadow-2xl border border-border overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-lg font-medium text-text-primary">New Deal</h2>
              <button onClick={() => setModalOpen(false)} disabled={creating}
                className="text-text-muted hover:text-text-primary transition-colors">
                <XIcon size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Title *</label>
                <input className="input w-full mt-1" value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="Series A — Acme Corp" disabled={creating} />
              </div>
              <div>
                <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Company *</label>
                <div className="mt-1">
                  <CompanySearchField
                    companyId={form.company_id}
                    companyName={form.company_name}
                    onChange={(cid, cname) => setForm(f => ({ ...f, company_id: cid, company_name: cname }))}
                    disabled={creating}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Stage</label>
                  <select className="input w-full mt-1" value={form.stage}
                    onChange={e => setForm(f => ({ ...f, stage: e.target.value as DealStage }))} disabled={creating}>
                    {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Instrument</label>
                  <select className="input w-full mt-1" value={form.instrument_type}
                    onChange={e => setForm(f => ({ ...f, instrument_type: e.target.value }))} disabled={creating}>
                    <option value="">Select...</option>
                    {INSTRUMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Deal Size ($)</label>
                  <input className="input w-full mt-1" type="number" value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="5000000" disabled={creating} />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Valuation ($)</label>
                  <input className="input w-full mt-1" type="number" value={form.valuation}
                    onChange={e => setForm(f => ({ ...f, valuation: e.target.value }))}
                    placeholder="25000000" disabled={creating} />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Our Alloc ($)</label>
                  <input className="input w-full mt-1" type="number" value={form.our_allocation}
                    onChange={e => setForm(f => ({ ...f, our_allocation: e.target.value }))}
                    placeholder="500000" disabled={creating} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Expected Close</label>
                  <input className="input w-full mt-1" type="date" value={form.expected_close}
                    onChange={e => setForm(f => ({ ...f, expected_close: e.target.value }))} disabled={creating} />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Lead Source</label>
                  <input className="input w-full mt-1" value={form.lead_source}
                    onChange={e => setForm(f => ({ ...f, lead_source: e.target.value }))}
                    placeholder="Warm intro, Event, etc." disabled={creating} />
                </div>
              </div>
              {users.length > 0 && (
                <div>
                  <label className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Owner</label>
                  <select className="input w-full mt-1" value={form.owner_id}
                    onChange={e => setForm(f => ({ ...f, owner_id: e.target.value }))} disabled={creating}>
                    <option value="">Me (default)</option>
                    {users.map((u: any) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-border">
              <button className="btn-ghost" onClick={() => setModalOpen(false)} disabled={creating}>Cancel</button>
              <button className="btn-primary" onClick={handleCreate}
                disabled={creating || !form.title.trim() || !form.company_id}>
                {creating ? 'Creating...' : 'Create Deal'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (() => {
        const isError = /fail|error/i.test(toast);
        return (
          <div className="fixed bottom-6 right-6 z-[60] rounded-xl shadow-2xl px-5 py-3"
            style={{ background: '#1A1A1F', border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`, borderLeft: `3px solid ${isError ? '#EF4444' : '#22C55E'}` }}>
            <div className="text-sm text-text-primary">{toast}</div>
          </div>
        );
      })()}
    </div>
  );
}

/* ── Deal Card ── */

// Day-5 deal_intelligence consumer wave: card now reads via the shared
// useDealIntelligence(dealId) hook against the future
// GET /api/deals/:id/intelligence endpoint (T3's Wave 6+ evaluator populates).
// The hook returns mock empty state today; components render their
// empty-state paths cleanly until real data flows.

function DealCard({ deal, stageColor, isDragging, onDragStart, onDragEnd, selected, onToggleSelect }: {
  deal: any;
  stageColor: string;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const daysInStage = deal.stage_changed_at
    ? Math.floor((Date.now() - new Date(deal.stage_changed_at).getTime()) / 86_400_000)
    : deal.days_in_stage || 0;

  // Day-4 fix: deals.last_activity_date is stale-by-design (only bumped by
  // manual deal edits, NOT by inbound conversations). Backend also returns
  // last_inferred_activity_date computed at query time from the
  // deal_contacts → conversation_contacts → conversations join. Prefer the
  // inferred value; fall back to the legacy column then created_at so we
  // never render NaN on first-day deals.
  const lastActivityIso: string | undefined =
    deal.last_inferred_activity_date ?? deal.last_activity_date ?? deal.created_at;
  const lastActivity = lastActivityIso
    ? (Date.now() - new Date(lastActivityIso).getTime()) / 86_400_000
    : 999;
  const activityColor = lastActivity <= 2 ? '#22C55E' : lastActivity <= 7 ? '#EAB308' : '#71717A';

  const hasAmount = deal.amount && deal.amount > 0;
  const hasValuation = deal.valuation && deal.valuation > 0;

  /* Duplicate company name check: if the title already contains the company name, don't show it again */
  const showCompanySubtitle = (() => {
    if (!deal.company_name) return false;
    return !deal.title.toLowerCase().includes(deal.company_name.toLowerCase());
  })();

  /* Day-5 redesign: card DNA shifts from stats-clutter to intelligence-feed.
     PR #2's owner avatar / lead_source badge / expected_close tag were
     intentionally not carried forward. Probability %, open_items_count, and
     contacts_count are also removed as clutter under the new framing. The
     card now surfaces sentiment / topics / risk / momentum from
     deal_intelligence (T3 evaluator wave) — empty-state today, fills in
     when T3 lands. See docs/deal-intelligence-contract.md. */
  const { intelligence } = useDealIntelligence(deal.id);

  return (
    <Link href={`/deals/${deal.id}`}>
      <div
        draggable
        onDragStart={e => { e.stopPropagation(); onDragStart(e, deal.id); }}
        onDragEnd={onDragEnd}
        className={`card cursor-grab active:cursor-grabbing hover:border-border-hover transition-all group ${
          isDragging ? 'opacity-40 scale-95' : ''
        } ${selected ? 'ring-2 ring-accent-magenta/40' : ''}`}
        style={{ borderLeft: `3px solid ${stageColor}20` }}
      >
        {/* Top row: select checkbox + grip + title + company. Checkbox click
            stops propagation so it never navigates to detail. */}
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            onClick={e => { e.preventDefault(); e.stopPropagation(); onToggleSelect(); }}
            className={`shrink-0 mt-0.5 w-3.5 h-3.5 rounded flex items-center justify-center transition-all ${
              selected
                ? 'bg-accent-magenta border-accent-magenta'
                : 'border border-white/15 opacity-0 group-hover:opacity-100 hover:border-white/40'
            }`}
            title={selected ? 'Deselect' : 'Select for bulk action'}
            style={{ borderWidth: 1 }}
          >
            {selected && <Check size={10} className="text-white" />}
          </button>
          <GripVertical
            size={14}
            className="text-text-muted/30 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary truncate">{deal.title}</div>
            {showCompanySubtitle && (
              <div className="text-xs text-text-muted mt-0.5 truncate">{deal.company_name}</div>
            )}
          </div>
        </div>

        {/* Amount / valuation line */}
        {(hasAmount || hasValuation) && (
          <div className="text-xs text-text-secondary mt-2 font-accent font-semibold">
            {hasAmount && formatCurrency(deal.amount)}
            {hasAmount && hasValuation && ' @ '}
            {hasValuation && `${formatCurrency(deal.valuation)} pre`}
          </div>
        )}

        {/* Sentiment + momentum row — always renders, neutral when empty.
            Always-rendered so the card height stays stable when data lands. */}
        <div className="flex items-center gap-2 mt-2.5">
          <MomentumSparkline intelligence={intelligence} size="compact" />
          <SentimentIndicator intelligence={intelligence} size="compact" />
        </div>

        {/* Topic chips — hidden entirely when empty. */}
        <div className="mt-1.5"><TopicChips intelligence={intelligence} size="compact" /></div>

        {/* Risk flag — hidden entirely when count is 0. */}
        <div className="mt-1.5"><RiskFlag intelligence={intelligence} size="compact" /></div>

        {/* Bottom row: activity dot + days-in-stage. Stripped of probability,
            open_items_count, contacts_count per Day-5 reframe. */}
        <div className="flex items-center gap-2 mt-2.5">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: activityColor }}
            title={`Last activity: ${Math.floor(lastActivity)}d ago`}
          />
          {daysInStage > 0 && (
            <span className="text-[10px] text-text-muted font-accent font-semibold">{daysInStage}d in stage</span>
          )}
          <span className="text-[10px] text-text-muted font-accent">
            · {Math.floor(lastActivity)}d ago
          </span>
        </div>
      </div>
    </Link>
  );
}

/* (Inline MomentumSparkline + SentimentIndicator removed — replaced by the
   shared `@/components/deal-intelligence` module which both the board card
   and the detail page strip consume. The shared module accepts a single
   `intelligence` prop from useDealIntelligence and handles its own
   empty/populated state branching.) */

/* ── Day-5 Phase B: per-column sort ── */

type DealSortKey =
  | 'expected_close'      // default — matches the server-side ORDER BY
  | 'amount_desc'         // largest deals first
  | 'last_activity_desc'  // most recently touched first (uses inferred field)
  | 'days_in_stage_desc'; // longest-stuck first

const SORT_OPTIONS: Array<{ value: DealSortKey; label: string }> = [
  { value: 'expected_close',      label: 'Expected close' },
  { value: 'amount_desc',         label: 'Amount (high → low)' },
  { value: 'last_activity_desc',  label: 'Last activity' },
  { value: 'days_in_stage_desc',  label: 'Stuck longest' },
];

function sortDealsForColumn(deals: any[], key: DealSortKey): any[] {
  const copy = deals.slice();
  switch (key) {
    case 'amount_desc':
      copy.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
      break;
    case 'last_activity_desc': {
      // Use the same fallback chain DealCard renders so the visible "Xd ago"
      // dot ordering matches what the user sees.
      const ts = (d: any): number => {
        const iso = d.last_inferred_activity_date ?? d.last_activity_date ?? d.created_at;
        const v = iso ? new Date(iso).getTime() : 0;
        return Number.isFinite(v) ? v : 0;
      };
      copy.sort((a, b) => ts(b) - ts(a));
      break;
    }
    case 'days_in_stage_desc': {
      const days = (d: any): number => {
        if (d.stage_changed_at) {
          const dt = (Date.now() - new Date(d.stage_changed_at).getTime()) / 86_400_000;
          return Number.isFinite(dt) ? dt : 0;
        }
        return d.days_in_stage ?? 0;
      };
      copy.sort((a, b) => days(b) - days(a));
      break;
    }
    case 'expected_close':
    default: {
      // NULLs last (matches backend's ORDER BY ... NULLS LAST). Within
      // not-NULL: ascending (closer = earlier).
      copy.sort((a, b) => {
        const av = a.expected_close ? new Date(a.expected_close).getTime() : Number.POSITIVE_INFINITY;
        const bv = b.expected_close ? new Date(b.expected_close).getTime() : Number.POSITIVE_INFINITY;
        return av - bv;
      });
      break;
    }
  }
  return copy;
}

function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

/* ── Day-5 Phase C: bulk action bar ── */

function BulkActionBar({
  selectedCount, users, busy, onSetStage, onSetOwner, onArchive, onClear,
}: {
  selectedCount: number;
  users: any[];
  busy: boolean;
  onSetStage: (stage: string) => void;
  onSetOwner: (ownerId: string | null) => void;
  onArchive: () => void;
  onClear: () => void;
}) {
  const [stagePickerOpen, setStagePickerOpen] = React.useState(false);
  const [ownerPickerOpen, setOwnerPickerOpen] = React.useState(false);

  // Close pickers on outside click. Lightweight — both are simple dropdowns
  // and don't justify a portal / focus-trap.
  React.useEffect(() => {
    if (!stagePickerOpen && !ownerPickerOpen) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-bulk-picker]')) {
        setStagePickerOpen(false);
        setOwnerPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [stagePickerOpen, ownerPickerOpen]);

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3"
      style={{
        background: '#1A1A1F',
        border: '1px solid rgba(217,70,168,0.30)',
        borderLeft: '3px solid #D946A8',
      }}
    >
      <span className="text-sm text-text-primary font-medium">
        {selectedCount} selected
      </span>

      <div className="w-px h-5 bg-white/10" />

      {/* Set stage */}
      <div className="relative" data-bulk-picker>
        <button
          onClick={() => { setStagePickerOpen(o => !o); setOwnerPickerOpen(false); }}
          disabled={busy}
          className="btn-secondary text-xs py-1 disabled:opacity-50"
        >
          Set stage…
        </button>
        {stagePickerOpen && (
          <div
            className="absolute bottom-full left-0 mb-2 rounded-lg shadow-xl py-1 min-w-[180px]"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            {STAGES.map(s => (
              <button
                key={s.key}
                onClick={() => { onSetStage(s.key); setStagePickerOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-white/[0.04] text-left"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Reassign owner */}
      <div className="relative" data-bulk-picker>
        <button
          onClick={() => { setOwnerPickerOpen(o => !o); setStagePickerOpen(false); }}
          disabled={busy}
          className="btn-secondary text-xs py-1 disabled:opacity-50"
        >
          Reassign…
        </button>
        {ownerPickerOpen && (
          <div
            className="absolute bottom-full left-0 mb-2 rounded-lg shadow-xl py-1 min-w-[200px] max-h-64 overflow-y-auto"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <button
              onClick={() => { onSetOwner(null); setOwnerPickerOpen(false); }}
              className="w-full px-3 py-1.5 text-xs text-text-muted hover:bg-white/[0.04] text-left italic"
            >
              Unassigned
            </button>
            {users.map(u => (
              <button
                key={u.id}
                onClick={() => { onSetOwner(u.id); setOwnerPickerOpen(false); }}
                className="w-full px-3 py-1.5 text-xs text-text-primary hover:bg-white/[0.04] text-left"
              >
                {u.full_name || u.email}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Archive */}
      <button
        onClick={onArchive}
        disabled={busy}
        className="btn-ghost text-xs py-1 flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-50"
      >
        <Trash2 size={12} /> Archive
      </button>

      <div className="w-px h-5 bg-white/10" />

      <button
        onClick={onClear}
        disabled={busy}
        className="btn-ghost text-xs py-1 disabled:opacity-50"
      >
        Clear
      </button>
    </div>
  );
}

function DealReplayBanner({ status }: { status: DealReplayStatusSnapshot | null }) {
  const run = status?.run;
  if (!run || run.status !== 'running') return null;

  const progressPct = run.enqueued_count > 0
    ? Math.min(100, Math.round((run.processed_count / run.enqueued_count) * 100))
    : 0;

  return (
    <div className="mx-6 mt-4 rounded-xl border border-accent-magenta/20 bg-accent-magenta/[0.06] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Deal rebuild running</div>
          <div className="text-xs text-text-muted mt-0.5">
            {run.processed_count.toLocaleString()} processed · {run.promoted_count.toLocaleString()} promoted to New · {run.rate_limited_count.toLocaleString()} Claude pauses
          </div>
        </div>
        <Link href="/settings?tab=system" className="text-xs text-accent-magenta hover:underline">
          View run cockpit
        </Link>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
        <div className="h-full rounded-full bg-accent-magenta transition-all" style={{ width: `${progressPct}%` }} />
      </div>
    </div>
  );
}

/* ── Day-5 Phase A: filter panel ── */

const FILTER_INSTRUMENT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'safe', label: 'SAFE' },
  { value: 'convertible_note', label: 'Convertible Note' },
  { value: 'equity', label: 'Equity' },
  { value: 'debt', label: 'Debt' },
  { value: 'other', label: 'Other' },
];

interface FiltersShape {
  stage: string[];
  owner_id: string[];
  instrument_type: string[];
  lead_source: string[];
  min_amount: string;
  max_amount: string;
  has_memo: string;
}

function DealFiltersPanel({
  filters, users, allDeals, onToggle, onSetScalar, onClearAll, onClose,
}: {
  filters: FiltersShape;
  users: any[];
  allDeals: any[];
  onToggle: (key: string, value: string) => void;
  onSetScalar: (key: string, value: string | null) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  // Distinct lead_source values from currently-loaded deals (cheap; no need
  // for a separate /distinct-lead-sources endpoint with current data volume).
  // 0% population today means this list is empty; we surface a freeform input
  // alongside the chip list so users can filter ahead of data.
  const distinctLeadSources = React.useMemo(() => {
    const set = new Set<string>();
    for (const d of allDeals) {
      const ls = (d.lead_source ?? '').trim();
      if (ls) set.add(ls);
    }
    return Array.from(set).sort();
  }, [allDeals]);
  const [leadSourceInput, setLeadSourceInput] = React.useState('');

  return (
    <div
      className="border-b border-border px-6 py-4"
      style={{ background: 'rgba(17,17,20,0.55)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">
          Filters
        </span>
        <div className="flex items-center gap-3">
          <button onClick={onClearAll} className="btn-ghost text-xs py-1">Clear all</button>
          <button onClick={onClose} className="btn-ghost text-xs py-1 flex items-center gap-1">
            <XIcon size={12} /> Close
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Stage (multi) */}
        <FilterColumn label="Stage">
          <ChipRow>
            {STAGES.map(s => (
              <FilterChip
                key={s.key}
                label={s.label}
                active={filters.stage.includes(s.key)}
                onClick={() => onToggle('stage', s.key)}
                color={s.color}
              />
            ))}
          </ChipRow>
        </FilterColumn>

        {/* Owner (multi + Unassigned sentinel) */}
        <FilterColumn label="Owner">
          <ChipRow>
            <FilterChip
              label="Unassigned"
              active={filters.owner_id.includes('unassigned')}
              onClick={() => onToggle('owner_id', 'unassigned')}
            />
            {users.map(u => (
              <FilterChip
                key={u.id}
                label={u.full_name || u.email}
                active={filters.owner_id.includes(u.id)}
                onClick={() => onToggle('owner_id', u.id)}
              />
            ))}
          </ChipRow>
        </FilterColumn>

        {/* Instrument */}
        <FilterColumn label="Instrument">
          <ChipRow>
            {FILTER_INSTRUMENT_OPTIONS.map(opt => (
              <FilterChip
                key={opt.value}
                label={opt.label}
                active={filters.instrument_type.includes(opt.value)}
                onClick={() => onToggle('instrument_type', opt.value)}
              />
            ))}
          </ChipRow>
        </FilterColumn>

        {/* Lead source — distinct values from current data + freeform add */}
        <FilterColumn label="Lead Source">
          <div className="space-y-2">
            <ChipRow>
              {distinctLeadSources.length === 0 && filters.lead_source.length === 0 && (
                <span className="text-[10px] text-text-muted/70 italic">
                  No lead_source values populated yet
                </span>
              )}
              {distinctLeadSources.map(ls => (
                <FilterChip
                  key={ls}
                  label={ls}
                  active={filters.lead_source.includes(ls)}
                  onClick={() => onToggle('lead_source', ls)}
                />
              ))}
              {filters.lead_source.filter(ls => !distinctLeadSources.includes(ls)).map(ls => (
                <FilterChip
                  key={`extra-${ls}`}
                  label={ls}
                  active={true}
                  onClick={() => onToggle('lead_source', ls)}
                />
              ))}
            </ChipRow>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={leadSourceInput}
                onChange={e => setLeadSourceInput(e.target.value)}
                placeholder="Add filter value..."
                className="input text-xs py-1 px-2 flex-1 min-w-0"
                onKeyDown={e => {
                  if (e.key === 'Enter' && leadSourceInput.trim()) {
                    onToggle('lead_source', leadSourceInput.trim());
                    setLeadSourceInput('');
                  }
                }}
              />
              <button
                onClick={() => {
                  if (leadSourceInput.trim()) {
                    onToggle('lead_source', leadSourceInput.trim());
                    setLeadSourceInput('');
                  }
                }}
                className="btn-secondary text-xs py-1 px-2"
              >
                Add
              </button>
            </div>
          </div>
        </FilterColumn>

        {/* Has Memo (tri-state) */}
        <FilterColumn label="Memo">
          <ChipRow>
            <FilterChip
              label="Has memo"
              active={filters.has_memo === 'true'}
              onClick={() => onSetScalar('has_memo', filters.has_memo === 'true' ? null : 'true')}
            />
            <FilterChip
              label="No memo"
              active={filters.has_memo === 'false'}
              onClick={() => onSetScalar('has_memo', filters.has_memo === 'false' ? null : 'false')}
            />
          </ChipRow>
        </FilterColumn>

        {/* Amount range */}
        <FilterColumn label="Amount range">
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={filters.min_amount}
              onChange={e => onSetScalar('min_amount', e.target.value || null)}
              placeholder="Min"
              className="input text-xs py-1 px-2 w-28"
            />
            <span className="text-text-muted text-xs">to</span>
            <input
              type="number"
              value={filters.max_amount}
              onChange={e => onSetScalar('max_amount', e.target.value || null)}
              placeholder="Max"
              className="input text-xs py-1 px-2 w-28"
            />
          </div>
        </FilterColumn>
      </div>
    </div>
  );
}

function FilterColumn({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1">{children}</div>;
}

function FilterChip({ label, active, onClick, color }: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] font-accent px-2 py-0.5 rounded transition-colors"
      style={{
        background: active
          ? (color ? `${color}30` : 'rgba(217,70,168,0.20)')
          : 'rgba(255,255,255,0.04)',
        color: active
          ? (color || '#F0ABFC')
          : 'rgba(255,255,255,0.65)',
        border: active
          ? `1px solid ${color ? color + '50' : 'rgba(217,70,168,0.40)'}`
          : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {label}
    </button>
  );
}

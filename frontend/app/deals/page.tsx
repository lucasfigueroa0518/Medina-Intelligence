'use client';

import React from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/top-bar';
import { CompanySearchField } from '@/components/company-search-field';
import { api } from '@/lib/api';
import {
  Plus,
  X as XIcon,
  GripVertical,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Users,
} from 'lucide-react';

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

  /* ── Data loading ── */

  React.useEffect(() => {
    api.listDeals()
      .then(d => setDeals(d.deals))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  React.useEffect(() => {
    api.listUsers().then(u => setUsers(u.users || []));
  }, []);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

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

  const dealsByStage = STAGES.map(stage => ({
    ...stage,
    deals: deals.filter(d => d.stage === stage.key),
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
            <button className="btn-primary flex items-center gap-2" onClick={openModal}>
              <Plus size={16} /> Add Deal
            </button>
          </div>
        }
      />

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

function DealCard({ deal, stageColor, isDragging, onDragStart, onDragEnd }: {
  deal: any;
  stageColor: string;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
}) {
  const daysInStage = deal.stage_changed_at
    ? Math.floor((Date.now() - new Date(deal.stage_changed_at).getTime()) / 86_400_000)
    : deal.days_in_stage || 0;

  const lastActivity = deal.last_activity_date
    ? (Date.now() - new Date(deal.last_activity_date).getTime()) / 86_400_000
    : 999;
  const activityColor = lastActivity <= 2 ? '#22C55E' : lastActivity <= 7 ? '#EAB308' : '#71717A';

  const hasAmount = deal.amount && deal.amount > 0;
  const hasValuation = deal.valuation && deal.valuation > 0;

  /* Duplicate company name check: if the title already contains the company name, don't show it again */
  const showCompanySubtitle = (() => {
    if (!deal.company_name) return false;
    return !deal.title.toLowerCase().includes(deal.company_name.toLowerCase());
  })();

  /* AI probability badge: show when probability is NOT manually set */
  const isAiProbability = (() => {
    try {
      const sm = typeof deal.source_metadata === 'string'
        ? JSON.parse(deal.source_metadata)
        : deal.source_metadata;
      if (!sm?.probability) return true;
      return sm.probability.source !== 'manual';
    } catch { return true; }
  })();

  return (
    <Link href={`/deals/${deal.id}`}>
      <div
        draggable
        onDragStart={e => { e.stopPropagation(); onDragStart(e, deal.id); }}
        onDragEnd={onDragEnd}
        className={`card cursor-grab active:cursor-grabbing hover:border-border-hover transition-all group ${
          isDragging ? 'opacity-40 scale-95' : ''
        }`}
        style={{ borderLeft: `3px solid ${stageColor}20` }}
      >
        {/* Top row: grip + title + company */}
        <div className="flex items-start gap-1.5">
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

        {/* Bottom row: activity dot, days badge, people count, probability */}
        <div className="flex items-center justify-between mt-2.5">
          <div className="flex items-center gap-2">
            {/* Activity dot (green/yellow/gray, no label) */}
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: activityColor }}
              title={`Last activity: ${Math.floor(lastActivity)}d ago`}
            />

            {/* Days in stage badge */}
            {daysInStage > 0 && (
              <span className="text-[10px] text-text-muted font-accent font-semibold">{daysInStage}d</span>
            )}

            {/* Open items */}
            {deal.open_items_count > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-semantic-warning font-accent">
                <AlertCircle size={10} />
                {deal.open_items_count}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* People count */}
            {deal.contacts_count > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-text-muted font-accent">
                <Users size={10} />
                {deal.contacts_count}
              </span>
            )}

            {/* Probability */}
            {deal.probability > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-text-muted font-accent font-semibold">
                {(deal.probability * 100).toFixed(0)}%
                {isAiProbability && (
                  <span className="text-[8px] font-bold px-1 py-px rounded bg-amber-500/15 text-amber-400 leading-none font-accent">
                    AI
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function formatCurrency(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Mail, Calendar, FileText, Activity, Clock, Users, Building2,
  Check, X as XIcon, Plus, ChevronDown, ChevronUp, ChevronRight, Trash2,
  DollarSign, Target, AlertCircle, CheckCircle2, MoreHorizontal,
  Sparkles, ArrowRight, Lock, Upload, Paperclip,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { DocumentUploadModal } from '@/components/document-upload-modal';
import { api } from '@/lib/api';

/* ───────── Stage configuration ───────── */

type DealStage =
  | 'prospect' | 'first_contact' | 'meeting_scheduled'
  | 'due_diligence' | 'term_sheet' | 'closing'
  | 'closed_won' | 'closed_lost';

const STAGE_COLORS: Record<DealStage, string> = {
  prospect:          '#71717A',
  first_contact:     '#3B82F6',
  meeting_scheduled: '#06B6D4',
  due_diligence:     '#EAB308',
  term_sheet:        '#F97316',
  closing:           '#8B5CF6',
  closed_won:        '#22C55E',
  closed_lost:       '#EF4444',
};

const STAGE_LABELS: Record<DealStage, string> = {
  prospect:          'Prospect',
  first_contact:     'First Contact',
  meeting_scheduled: 'Meeting Scheduled',
  due_diligence:     'Due Diligence',
  term_sheet:        'Term Sheet',
  closing:           'Closing',
  closed_won:        'Closed Won',
  closed_lost:       'Closed Lost',
};

const INSTRUMENT_OPTIONS = [
  { value: 'safe', label: 'SAFE' },
  { value: 'convertible_note', label: 'Convertible Note' },
  { value: 'equity', label: 'Equity' },
  { value: 'debt', label: 'Debt' },
  { value: 'other', label: 'Other' },
];

const INSTRUMENT_LABEL: Record<string, string> = Object.fromEntries(
  INSTRUMENT_OPTIONS.map(o => [o.value, o.label])
);

const ROLE_OPTIONS = [
  { value: 'founder', label: 'Founder' },
  { value: 'ceo', label: 'CEO' },
  { value: 'cfo', label: 'CFO' },
  { value: 'cto', label: 'CTO' },
  { value: 'legal', label: 'Legal' },
  { value: 'deal_lead', label: 'Deal Lead' },
  { value: 'analyst', label: 'Analyst' },
  { value: 'co_investor', label: 'Co-Investor' },
  { value: 'board_member', label: 'Board Member' },
  { value: 'advisor', label: 'Advisor' },
  { value: 'champion', label: 'Champion' },
  { value: 'blocker', label: 'Blocker' },
  { value: 'other', label: 'Other' },
];

const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLE_OPTIONS.map(o => [o.value, o.label])
);

type TimelineFilter = 'all' | 'emails' | 'meetings' | 'notes';

/* ───────── Source citation helpers ───────── */

type SourceType = 'manual' | 'email' | 'meeting' | 'ai_extracted';

const SOURCE_COLORS: Record<SourceType, { bg: string; text: string; label: string }> = {
  manual:       { bg: 'rgba(113,113,122,0.12)', text: '#A1A1AA', label: 'Manual' },
  email:        { bg: 'rgba(59,130,246,0.12)', text: '#60A5FA', label: 'Email' },
  meeting:      { bg: 'rgba(6,182,212,0.12)', text: '#22D3EE', label: 'Meeting' },
  ai_extracted: { bg: 'rgba(245,158,11,0.12)', text: '#FBBF24', label: 'AI' },
};

function parseSourceMeta(deal: any): Record<string, any> {
  if (!deal?.source_metadata) return {};
  try {
    return typeof deal.source_metadata === 'string'
      ? JSON.parse(deal.source_metadata)
      : deal.source_metadata;
  } catch { return {}; }
}

function CitationPill({ field, meta }: { field: string; meta: Record<string, any> }) {
  const info = meta[field];
  if (!info?.source) return null;
  const src = SOURCE_COLORS[info.source as SourceType] || SOURCE_COLORS.manual;
  const isAi = info.source !== 'manual';
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider cursor-default font-accent"
      style={{ background: src.bg, color: src.text }}
      title={`Source: ${src.label}${info.set_at ? ` — ${new Date(info.set_at).toLocaleDateString()}` : ''}${info.set_by ? ` by ${info.set_by.slice(0, 8)}` : ''}`}
    >
      {isAi && <Sparkles size={8} />}
      {src.label}
    </span>
  );
}

function AiBadge({ field, meta }: { field: string; meta: Record<string, any> }) {
  const info = meta[field];
  if (!info?.source || info.source === 'manual') return null;
  return (
    <span
      className="text-[8px] font-semibold px-1 py-px rounded bg-amber-500/15 text-amber-400 leading-none cursor-default font-accent"
      title={`Set by ${info.source} on ${info.set_at ? new Date(info.set_at).toLocaleDateString() : 'unknown'}`}
    >
      AI
    </span>
  );
}

/* ───────── Edit form types ───────── */

interface EditFormData {
  title: string;
  amount: string;
  valuation: string;
  our_allocation: string;
  instrument_type: string;
  expected_close: string;
  actual_close_date: string;
  lead_source: string;
  thesis_fit: string;
  probability: string;
  notes: string;
}

/* ───────── Page component ───────── */

export default function DealDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  /* ── Core state ── */
  const [deal, setDeal] = React.useState<any>(null);
  const [contacts, setContacts] = React.useState<{ theirs: any[]; ours: any[]; other: any[] }>({ theirs: [], ours: [], other: [] });
  const [actionItems, setActionItems] = React.useState<any[]>([]);
  const [notes, setNotes] = React.useState<any[]>([]);
  const [company, setCompany] = React.useState<any>(null);
  const [timeline, setTimeline] = React.useState<any[]>([]);
  const [orgUsers, setOrgUsers] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshKey, setRefreshKey] = React.useState(0);

  /* ── UI state ── */
  const [editMode, setEditMode] = React.useState(false);
  const [editForm, setEditForm] = React.useState<EditFormData>({
    title: '', amount: '', valuation: '', our_allocation: '',
    instrument_type: '', expected_close: '', actual_close_date: '',
    lead_source: '', thesis_fit: '', probability: '', notes: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = React.useState(false);

  /* ── Timeline state ── */
  const [timelineFilter, setTimelineFilter] = React.useState<TimelineFilter>('all');
  const [timelineLimit, setTimelineLimit] = React.useState(20);
  const [timelineLoading, setTimelineLoading] = React.useState(false);

  /* ── Action items state ── */
  const [newItemDesc, setNewItemDesc] = React.useState('');
  const [newItemDue, setNewItemDue] = React.useState('');
  const [addingItem, setAddingItem] = React.useState(false);
  const [showCompleted, setShowCompleted] = React.useState(false);

  /* ── Notes state ── */
  const [newNote, setNewNote] = React.useState('');
  const [addingNote, setAddingNote] = React.useState(false);

  /* ── Documents state — same pattern as contacts/[id] Documents tab ── */
  const [documents, setDocuments] = React.useState<any[]>([]);
  const [docsLoading, setDocsLoading] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [uploadVisibility, setUploadVisibility] = React.useState<'private' | 'org_wide'>('private');
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Wave 5 Phase F: drag-drop on the Documents card.
  const [docDropOver, setDocDropOver] = React.useState(false);
  const [docUploadOpen, setDocUploadOpen] = React.useState(false);
  const [docUploadFiles, setDocUploadFiles] = React.useState<File[]>([]);
  const docDropCounterRef = React.useRef(0);

  /* ── Contact search state (Theirs / Other side) ── */
  const [contactQuery, setContactQuery] = React.useState('');
  const [contactResults, setContactResults] = React.useState<any[]>([]);
  const [contactSearching, setContactSearching] = React.useState(false);
  const [contactRole, setContactRole] = React.useState('');
  const [contactSide, setContactSide] = React.useState<'theirs' | 'other'>('theirs');
  const [addingContact, setAddingContact] = React.useState(false);
  const [showAddContact, setShowAddContact] = React.useState(false);
  const contactSearchRef = React.useRef<HTMLInputElement>(null);
  const contactDropdownRef = React.useRef<HTMLDivElement>(null);

  /* ── Ours (user) add state ── */
  const [showAddOurs, setShowAddOurs] = React.useState(false);
  const [oursUserId, setOursUserId] = React.useState('');
  const [oursRole, setOursRole] = React.useState('');
  const [addingOurs, setAddingOurs] = React.useState(false);

  /* ── Data fetching ── */
  React.useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getDeal(id),
      api.getDealTimeline(id).catch(() => ({ entries: [] })),
    ]).then(([d, t]) => {
      setDeal(d.deal);
      setContacts(d.contacts || { theirs: [], ours: [], other: [] });
      setActionItems(d.action_items || []);
      setNotes(d.notes || []);
      setCompany(d.company || null);
      setOrgUsers(d.users || []);
      setTimeline(t.entries || []);
    }).finally(() => setLoading(false));
  }, [id, refreshKey]);

  /* ── Toast auto-dismiss ── */
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  /* ── Documents fetch ── */
  React.useEffect(() => {
    setDocsLoading(true);
    api.listDocuments({ deal_id: id }).then(r => setDocuments(r.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setDocsLoading(false));
  }, [id, refreshKey]);

  async function handleDocUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.uploadDocument(file, { deal_id: id, visibility: uploadVisibility });
      setToast(res.duplicate ? 'Duplicate document — already exists' : 'Document uploaded');
      setRefreshKey(k => k + 1);
    } catch (err: any) { setToast(`Upload failed: ${err.message}`); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function handleDocDelete(docId: string) {
    try {
      await api.deleteDocument(docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
      setToast('Document deleted');
    } catch { setToast('Delete failed'); }
  }

  /* ── Contact search debounce ── */
  React.useEffect(() => {
    if (contactQuery.trim().length < 2) {
      setContactResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setContactSearching(true);
      try {
        const res = await api.listContacts({ keyword: contactQuery.trim() });
        setContactResults(res.contacts?.slice(0, 8) || []);
      } catch { setContactResults([]); }
      finally { setContactSearching(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [contactQuery]);

  /* ── Close dropdowns on outside click ── */
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        contactDropdownRef.current &&
        !contactDropdownRef.current.contains(e.target as Node) &&
        contactSearchRef.current &&
        !contactSearchRef.current.contains(e.target as Node)
      ) {
        setContactResults([]);
      }
      const target = e.target as HTMLElement;
      if (overflowOpen && !target.closest('[data-overflow-menu]')) {
        setOverflowOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [overflowOpen]);

  /* ── Edit mode helpers ── */
  function enterEditMode() {
    if (!deal) return;
    const prob = deal.probability != null
      ? (deal.probability <= 1 ? (deal.probability * 100).toFixed(0) : String(deal.probability))
      : '';
    setEditForm({
      title: deal.title || '',
      amount: deal.amount != null ? String(deal.amount) : '',
      valuation: deal.valuation != null ? String(deal.valuation) : '',
      our_allocation: deal.our_allocation != null ? String(deal.our_allocation) : '',
      instrument_type: deal.instrument_type || '',
      expected_close: deal.expected_close ? deal.expected_close.split('T')[0] : '',
      actual_close_date: deal.actual_close_date ? deal.actual_close_date.split('T')[0] : '',
      lead_source: deal.lead_source || '',
      thesis_fit: deal.thesis_fit || '',
      probability: prob,
      notes: deal.notes || '',
    });
    setEditMode(true);
  }

  async function handleSave() {
    if (!editForm.title.trim()) return;
    setSaving(true);
    try {
      const probVal = editForm.probability ? parseFloat(editForm.probability) : null;
      const normalizedProb = probVal != null ? (probVal > 1 ? probVal / 100 : probVal) : null;
      await api.updateDeal(id, {
        title: editForm.title.trim(),
        amount: editForm.amount ? parseFloat(editForm.amount) : null,
        valuation: editForm.valuation ? parseFloat(editForm.valuation) : null,
        our_allocation: editForm.our_allocation ? parseFloat(editForm.our_allocation) : null,
        instrument_type: editForm.instrument_type || null,
        expected_close: editForm.expected_close || null,
        actual_close_date: editForm.actual_close_date || null,
        lead_source: editForm.lead_source.trim() || null,
        thesis_fit: editForm.thesis_fit.trim() || null,
        probability: normalizedProb,
        notes: editForm.notes.trim() || null,
      });
      setEditMode(false);
      setRefreshKey(k => k + 1);
      setToast('Deal updated');
    } catch (e: any) { setToast(`Save failed: ${e.message || 'Unknown error'}`); }
    finally { setSaving(false); }
  }

  /* ── Quick actions ── */
  async function handleQuickStage(stage: 'closed_won' | 'closed_lost') {
    try {
      await api.updateDeal(id, { stage });
      setDeal((d: any) => ({ ...d, stage }));
      setToast(`Deal marked as ${STAGE_LABELS[stage]}`);
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
  }

  /* ── Delete ── */
  async function handleDelete() {
    setDeleting(true);
    try { await api.deleteDeal(id); router.push('/deals'); }
    catch (e: any) { alert(e.message || 'Delete failed'); setDeleting(false); }
  }

  /* ── Action items ── */
  async function handleAddItem() {
    if (!newItemDesc.trim()) return;
    setAddingItem(true);
    try {
      await api.createDealActionItem(id, {
        description: newItemDesc.trim(),
        assignee_id: null,
        due_date: newItemDue || null,
      });
      setNewItemDesc('');
      setNewItemDue('');
      setRefreshKey(k => k + 1);
      setToast('Action item added');
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
    finally { setAddingItem(false); }
  }

  async function handleToggleItem(item: any) {
    const newStatus = item.status === 'completed' ? 'open' : 'completed';
    try {
      await api.updateDealActionItem(id, item.id, { status: newStatus });
      setActionItems(prev => prev.map(i =>
        i.id === item.id ? { ...i, status: newStatus } : i
      ));
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
  }

  async function handleDeleteItem(itemId: string) {
    try {
      await api.deleteDealActionItem(id, itemId);
      setActionItems(prev => prev.filter(i => i.id !== itemId));
      setToast('Action item deleted');
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
  }

  /* ── Notes ── */
  async function handleAddNote() {
    if (!newNote.trim()) return;
    setAddingNote(true);
    try {
      await api.createDealNote(id, { content: newNote.trim() });
      setNewNote('');
      setRefreshKey(k => k + 1);
      setToast('Note added');
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
    finally { setAddingNote(false); }
  }

  async function handleDeleteNote(noteId: string) {
    try {
      await api.deleteDealNote(id, noteId);
      setNotes(prev => prev.filter(n => n.id !== noteId));
      setToast('Note deleted');
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
  }

  /* ── Contacts (theirs / other side — from contacts table) ── */
  async function handleAddContact(contactId: string, contactName: string) {
    if (!contactRole.trim()) { setToast('Please select a role'); return; }
    setAddingContact(true);
    try {
      await api.addDealContact(id, {
        contact_id: contactId,
        role: contactRole.trim(),
        side: contactSide,
      });
      setContactQuery('');
      setContactRole('');
      setContactSide('theirs');
      setContactResults([]);
      setShowAddContact(false);
      setRefreshKey(k => k + 1);
      setToast(`${contactName} added to deal`);
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
    finally { setAddingContact(false); }
  }

  /* ── Ours side — from org users, not contacts ── */
  async function handleAddOurs() {
    if (!oursUserId || !oursRole) { setToast('Select a team member and role'); return; }
    setAddingOurs(true);
    try {
      await api.addDealContact(id, {
        contact_id: oursUserId,
        role: oursRole,
        side: 'ours',
      });
      setOursUserId('');
      setOursRole('');
      setShowAddOurs(false);
      setRefreshKey(k => k + 1);
      const user = orgUsers.find(u => u.id === oursUserId);
      setToast(`${user?.full_name || 'Team member'} added`);
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
    finally { setAddingOurs(false); }
  }

  async function handleRemoveContact(contactId: string) {
    try {
      await api.removeDealContact(id, contactId);
      setRefreshKey(k => k + 1);
      setToast('Contact removed');
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
  }

  /* ── Timeline load more ── */
  async function handleLoadMore() {
    setTimelineLoading(true);
    try {
      const res = await api.getDealTimeline(id);
      setTimeline(res.entries || []);
      setTimelineLimit(l => l + 20);
    } catch { /* ignore */ }
    finally { setTimelineLoading(false); }
  }

  /* ── Render guards ── */
  if (loading) return <div className="flex-1 flex items-center justify-center text-text-secondary">Loading...</div>;
  if (!deal) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4">
      <div className="text-text-secondary">Deal not found</div>
      <Link href="/deals" className="btn-secondary">Back to Deals</Link>
    </div>
  );

  /* ── Computed values ── */
  const stage = (deal.stage || 'prospect') as DealStage;
  const stageColor = STAGE_COLORS[stage] || '#71717A';
  const stageLabel = STAGE_LABELS[stage] || deal.stage;
  const sourceMeta = parseSourceMeta(deal);

  const daysInStage = deal.stage_changed_at
    ? Math.floor((Date.now() - new Date(deal.stage_changed_at).getTime()) / 86_400_000)
    : null;
  const dealAge = deal.created_at
    ? Math.floor((Date.now() - new Date(deal.created_at).getTime()) / 86_400_000)
    : 0;
  const openItems = actionItems.filter(i => i.status !== 'completed');
  const completedItems = actionItems.filter(i => i.status === 'completed');

  const displayProbability = deal.probability != null
    ? (deal.probability <= 1 ? Math.round(deal.probability * 100) : Math.round(deal.probability))
    : null;

  const filteredTimeline = timeline.filter(entry => {
    if (!entry.timestamp) return false;
    if (entry.type === 'audit' && !formatAuditEntry(entry)) return false;
    if (timelineFilter === 'all') return true;
    if (timelineFilter === 'emails') return entry.type === 'conversation';
    if (timelineFilter === 'meetings') return entry.type === 'event';
    if (timelineFilter === 'notes') return entry.type === 'note';
    return true;
  });

  const visibleTimeline = filteredTimeline.slice(0, timelineLimit);
  const hasMore = filteredTimeline.length > timelineLimit;

  return (
    <div className="flex-1 overflow-auto">
      {/* ── Edit mode sticky bar ── */}
      {editMode && (
        <div className="sticky top-0 z-30 border-b px-8 py-3 flex items-center justify-between"
          style={{ background: 'rgba(9,9,11,0.92)', backdropFilter: 'blur(16px)', borderColor: 'rgba(217,70,168,0.25)' }}>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-2 h-2 rounded-full bg-accent-magenta animate-pulse" />
            Editing {deal.title}
          </div>
          <div className="flex gap-3">
            <button className="btn-ghost" onClick={() => setEditMode(false)} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving || !editForm.title.trim()}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {!editMode && (
        <TopBar
          title="Deal Pipeline"
          breadcrumb={
            <div className="text-sm text-text-muted">
              <Link href="/deals" className="hover:text-text-primary">Deals</Link>
              <span className="mx-1.5">/</span>
              <span className="text-text-secondary">{deal.title}</span>
            </div>
          }
          actions={
            <div className="flex gap-3 items-center">
              {stage !== 'closed_won' && stage !== 'closed_lost' && (
                <>
                  <button
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:scale-[1.03]"
                    style={{ background: 'rgba(34,197,94,0.12)', color: '#4ADE80', border: '1px solid rgba(34,197,94,0.25)' }}
                    onClick={() => handleQuickStage('closed_won')}
                  >
                    Won
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:scale-[1.03]"
                    style={{ background: 'rgba(239,68,68,0.12)', color: '#F87171', border: '1px solid rgba(239,68,68,0.25)' }}
                    onClick={() => handleQuickStage('closed_lost')}
                  >
                    Lost
                  </button>
                </>
              )}
              <button className="btn-secondary" onClick={enterEditMode}>Edit</button>

              {/* Overflow menu */}
              <div className="relative" data-overflow-menu>
                <button
                  className="btn-ghost px-2"
                  onClick={() => setOverflowOpen(o => !o)}
                >
                  <MoreHorizontal size={16} />
                </button>
                {overflowOpen && (
                  <div
                    className="absolute right-0 top-full mt-1 w-40 rounded-xl py-1 shadow-2xl z-20"
                    style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <button
                      className="w-full text-left px-4 py-2 text-sm text-semantic-error hover:bg-white/[0.04] transition-colors"
                      onClick={() => { setOverflowOpen(false); setDeleteOpen(true); }}
                    >
                      Delete Deal
                    </button>
                  </div>
                )}
              </div>
            </div>
          }
        />
      )}

      {/* ── IDENTITY BAR ── */}
      <div className="px-8 py-5 border-b border-border" style={{ background: 'rgba(17,17,20,0.6)' }}>
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-xl bg-brand-gradient flex items-center justify-center text-white text-lg font-semibold shrink-0 shadow-lg shadow-accent-magenta/10">
            <Target size={24} />
          </div>
          <div className="flex-1 min-w-0">
            {editMode ? (
              <input
                className="font-display text-2xl leading-tight bg-transparent border-b border-accent-magenta/30 focus:border-accent-magenta outline-none w-full text-text-primary pb-0.5"
                value={editForm.title}
                onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                disabled={saving}
                placeholder="Deal Title"
              />
            ) : (
              <h1 className="font-display text-2xl leading-tight">{deal.title}</h1>
            )}
            <div className="flex items-center gap-3 mt-1.5">
              {company && (
                <Link href={`/companies/${company.id}`} className="text-sm text-accent-magenta hover:underline flex items-center gap-1">
                  <Building2 size={13} />
                  {company.name}
                </Link>
              )}
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider font-accent"
                style={{
                  background: hexToRgba(stageColor, 0.12),
                  color: stageColor,
                  border: `1px solid ${hexToRgba(stageColor, 0.25)}`,
                }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: stageColor }} />
                {stageLabel}
              </span>
            </div>
            {deal.owner_name && (
              <div className="text-xs text-text-muted mt-1.5 flex items-center gap-1">
                <Users size={11} /> Owned by {deal.owner_name}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── RELATIONSHIP PULSE STRIP ── */}
      <div className="border-b border-border">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {/* Stage */}
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Stage</div>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold font-accent"
              style={{
                background: hexToRgba(stageColor, 0.12),
                color: stageColor,
                border: `1px solid ${hexToRgba(stageColor, 0.25)}`,
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: stageColor }} />
              {stageLabel}
            </span>
            {daysInStage != null && (
              <div className="text-[9px] text-text-muted mt-1.5">{daysInStage} day{daysInStage !== 1 ? 's' : ''} in {stageLabel}</div>
            )}
          </div>

          {/* Last Activity — Day-4 fix: prefer query-time inferred value
              (deal_contacts → conversation_contacts → conversations MAX) over
              the stale-by-design deals.last_activity_date column, which is
              only bumped by manual deal edits. Fall back to the legacy
              column then created_at so first-day deals don't render '--'.
              Day-5 Phase D: when last_inferred_activity_sender / _subject
              are populated, show a "by [sender] · [subject]" subtitle line
              so "what got touched" is glanceable. */}
          {(() => {
            const lastActivityIso: string | undefined =
              (deal as any).last_inferred_activity_date ?? deal.last_activity_date ?? deal.created_at;
            const inferredSender = (deal as any).last_inferred_activity_sender as string | undefined;
            const inferredSubject = (deal as any).last_inferred_activity_subject as string | undefined;
            const subtitle = inferredSender && inferredSubject
              ? `${inferredSender} · ${inferredSubject}`
              : inferredSender || inferredSubject || null;
            return (
              <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
                <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Last Activity</div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-semibold tabular-nums font-accent">
                    {lastActivityIso ? fmtRel(lastActivityIso) : '--'}
                  </span>
                  <Clock size={12} className="text-text-muted" />
                </div>
                {lastActivityIso && (
                  <div className="text-[9px] text-text-muted mt-1">
                    {new Date(lastActivityIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                )}
                {subtitle && (
                  <div className="text-[10px] text-text-secondary mt-1.5 truncate" title={subtitle}>
                    {subtitle}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Deal Age */}
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Deal Age</div>
            <div className="flex items-end gap-1">
              <span className="text-2xl font-semibold tabular-nums font-accent">{dealAge}</span>
              <span className="text-[10px] text-text-muted mb-1">days</span>
            </div>
            <div className="text-[9px] text-text-muted mt-1">
              since {new Date(deal.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </div>
          </div>

          {/* Open Items */}
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Open Items</div>
            <span className={`text-2xl font-semibold tabular-nums font-accent ${openItems.length > 0 ? 'text-amber-400' : ''}`}>
              {openItems.length}
            </span>
            {completedItems.length > 0 && (
              <div className="text-[9px] text-text-muted mt-1">
                {completedItems.length} completed
              </div>
            )}
          </div>

          {/* Owner */}
          <div className="px-5 py-4">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Owner</div>
            {deal.owner_name ? (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[10px] font-semibold shadow-md shadow-accent-purple/10">
                  {deal.owner_name.charAt(0)}
                </div>
                <div>
                  <div className="text-xs text-text-primary font-medium leading-tight">{deal.owner_name}</div>
                  {deal.owner_email && (
                    <div className="text-[9px] text-text-muted leading-tight">{deal.owner_email}</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full border-2 border-dashed border-white/10 flex items-center justify-center">
                  <Users size={12} className="text-text-muted/40" />
                </div>
                <span className="text-xs text-text-muted">Unassigned</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── INTELLIGENCE PULSE STRIP (NEW Day-5) ──
          Reads from deal_intelligence (T3 evaluator wave). Empty-state today —
          fills in when T3 ships per docs/deal-intelligence-contract.md. */}
      <DealIntelligenceStrip deal={deal} />

      {/* ── MAIN CONTENT ── */}
      <div className="p-6 lg:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">

          {/* ═══ LEFT COLUMN (60%) ═══ */}
          <div className="lg:col-span-7 space-y-5">

            {/* CARD: Activity Timeline */}
            <GlassCard>
              <div className="flex items-center justify-between mb-4">
                <span className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">Activity Timeline</span>
                <div className="flex gap-1">
                  {(['all', 'emails', 'meetings', 'notes'] as TimelineFilter[]).map(f => (
                    <button
                      key={f}
                      onClick={() => { setTimelineFilter(f); setTimelineLimit(20); }}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-medium capitalize transition-colors ${
                        timelineFilter === f
                          ? 'text-text-primary'
                          : 'text-text-muted hover:text-text-secondary'
                      }`}
                      style={timelineFilter === f ? { background: 'rgba(255,255,255,0.06)' } : undefined}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {visibleTimeline.length === 0 ? (
                <div className="text-sm text-text-muted py-8 text-center">No activity yet</div>
              ) : (
                <div className="space-y-1">
                  {visibleTimeline.map((entry, i) => (
                    <TimelineRow key={entry.id || i} entry={entry} />
                  ))}
                </div>
              )}

              {hasMore && (
                <button
                  onClick={handleLoadMore}
                  disabled={timelineLoading}
                  className="mt-4 text-xs text-accent-magenta hover:text-accent-purple transition-colors disabled:opacity-40"
                >
                  {timelineLoading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </GlassCard>

            {/* CARD: Conversations (Day-5 Phase 3) — thread-grouped view of
                emails tied to deal contacts. Distinct from the chronological
                Activity Timeline above; this surfaces reply chains as
                collapsible threads with subject + last-sender + message count
                in the header, and expands to show every message inline with
                the same canReadEmailContent gate the timeline uses. */}
            <DealConversationsCard dealId={id} />

            {/* CARD: Action Items */}
            <GlassCard>
              <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">Action Items</div>

              {openItems.length === 0 && completedItems.length === 0 && (
                <div className="text-sm text-text-muted py-4 text-center">No action items yet — add one below</div>
              )}
              <div className="space-y-1">
                {openItems.map(item => (
                  <ActionItemRow
                    key={item.id}
                    item={item}
                    onToggle={() => handleToggleItem(item)}
                    onDelete={() => handleDeleteItem(item.id)}
                  />
                ))}
              </div>

              {completedItems.length > 0 && (
                <div className="mt-3">
                  <button
                    onClick={() => setShowCompleted(!showCompleted)}
                    className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                  >
                    {showCompleted ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    {completedItems.length} completed
                  </button>
                  {showCompleted && (
                    <div className="mt-2 space-y-1 opacity-60">
                      {completedItems.map(item => (
                        <ActionItemRow
                          key={item.id}
                          item={item}
                          onToggle={() => handleToggleItem(item)}
                          onDelete={() => handleDeleteItem(item.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <input
                  className="flex-1 bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-accent-magenta outline-none placeholder:text-text-muted"
                  placeholder="Add action item..."
                  value={newItemDesc}
                  onChange={e => setNewItemDesc(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddItem()}
                  disabled={addingItem}
                />
                <input
                  type="date"
                  className="bg-bg-input border border-border rounded-lg px-2 py-2 text-xs text-text-secondary focus:border-accent-magenta outline-none w-32"
                  value={newItemDue}
                  onChange={e => setNewItemDue(e.target.value)}
                  disabled={addingItem}
                />
                <button
                  onClick={handleAddItem}
                  disabled={addingItem || !newItemDesc.trim()}
                  className="px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-30"
                  style={{ background: 'rgba(217,70,168,0.12)', color: '#D946A8', border: '1px solid rgba(217,70,168,0.2)' }}
                >
                  <Plus size={14} />
                </button>
              </div>
            </GlassCard>

            {/* CARD: Deal Memo */}
            <GlassCard>
              <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3 flex items-center gap-1.5">
                <FileText size={11} /> Deal Memo
              </div>
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-12 h-12 rounded-xl bg-brand-gradient/10 flex items-center justify-center mb-3">
                  <Sparkles size={20} className="text-accent-magenta" />
                </div>
                <p className="text-sm text-text-muted mb-3">
                  Generate an AI-powered investment memo based on deal data, timeline, and notes.
                </p>
                <button
                  className="px-4 py-2 rounded-lg text-xs font-medium transition-all hover:scale-[1.02]"
                  style={{ background: 'rgba(217,70,168,0.12)', color: '#D946A8', border: '1px solid rgba(217,70,168,0.2)' }}
                  onClick={() => setToast('Memo generation coming soon')}
                >
                  <span className="flex items-center gap-1.5">
                    <Sparkles size={12} />
                    Generate Memo
                  </span>
                </button>
              </div>
            </GlassCard>
          </div>

          {/* ═══ RIGHT COLUMN (40%) ═══ */}
          <div className="lg:col-span-5 space-y-5">

            {/* CARD: Deal Details */}
            <GlassCard>
              <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3 flex items-center gap-1.5">
                <DollarSign size={11} /> Deal Details
              </div>
              {editMode ? (
                <div className="space-y-3">
                  <EF label="Amount ($)" type="number" v={editForm.amount} set={v => setEditForm(f => ({ ...f, amount: v }))} d={saving} />
                  <EF label="Valuation ($)" type="number" v={editForm.valuation} set={v => setEditForm(f => ({ ...f, valuation: v }))} d={saving} />
                  <EF label="Our Allocation ($)" type="number" v={editForm.our_allocation} set={v => setEditForm(f => ({ ...f, our_allocation: v }))} d={saving} />
                  <label className="block">
                    <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Instrument Type</div>
                    <select
                      className="bg-bg-input border border-border rounded-lg text-sm px-3 py-2 text-text-secondary focus:border-accent-magenta outline-none w-full"
                      value={editForm.instrument_type}
                      onChange={e => setEditForm(f => ({ ...f, instrument_type: e.target.value }))}
                      disabled={saving}
                    >
                      <option value="">Select...</option>
                      {INSTRUMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  <EF label="Expected Close" type="date" v={editForm.expected_close} set={v => setEditForm(f => ({ ...f, expected_close: v }))} d={saving} />
                  <EF label="Actual Close" type="date" v={editForm.actual_close_date} set={v => setEditForm(f => ({ ...f, actual_close_date: v }))} d={saving} />
                  <EF label="Lead Source" v={editForm.lead_source} set={v => setEditForm(f => ({ ...f, lead_source: v }))} d={saving} />
                  <EF label="Thesis Fit" v={editForm.thesis_fit} set={v => setEditForm(f => ({ ...f, thesis_fit: v }))} d={saving} />
                  <EF label="Probability (%)" type="number" v={editForm.probability} set={v => setEditForm(f => ({ ...f, probability: v }))} d={saving} />
                  <label className="block">
                    <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Notes</div>
                    <textarea
                      className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-secondary focus:border-accent-magenta outline-none resize-none"
                      rows={3}
                      value={editForm.notes}
                      onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                      disabled={saving}
                    />
                  </label>
                </div>
              ) : (
                <div className="space-y-2.5 text-sm">
                  {deal.amount != null && (
                    <div className="flex items-center gap-2">
                      <KV k="Amount" v={fmtCurrency(deal.amount)} />
                      <CitationPill field="amount" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.valuation != null && (
                    <div className="flex items-center gap-2">
                      <KV k="Valuation" v={fmtCurrency(deal.valuation)} />
                      <CitationPill field="valuation" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.our_allocation != null && (
                    <div className="flex items-center gap-2">
                      <KV k="Our Allocation" v={fmtCurrency(deal.our_allocation)} />
                      <CitationPill field="our_allocation" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.instrument_type && (
                    <div className="flex items-center gap-2">
                      <KV k="Instrument" v={INSTRUMENT_LABEL[deal.instrument_type] || deal.instrument_type} />
                      <CitationPill field="instrument_type" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.expected_close && (
                    <div className="flex items-center gap-2">
                      <KV k="Expected Close" v={new Date(deal.expected_close).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} />
                      <CitationPill field="expected_close" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.actual_close_date && (
                    <KV k="Actual Close" v={new Date(deal.actual_close_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} />
                  )}
                  {deal.lead_source && (
                    <div className="flex items-center gap-2">
                      <KV k="Lead Source" v={deal.lead_source} />
                      <CitationPill field="lead_source" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.thesis_fit && (
                    <div className="flex items-center gap-2">
                      <KV k="Thesis Fit" v={deal.thesis_fit} />
                      <CitationPill field="thesis_fit" meta={sourceMeta} />
                    </div>
                  )}
                  {displayProbability != null && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted shrink-0">Probability</span>
                      <div className="flex items-center gap-2 flex-1">
                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(100, displayProbability)}%`,
                              background: displayProbability >= 70 ? '#22C55E' : displayProbability >= 40 ? '#F59E0B' : '#71717A',
                            }}
                          />
                        </div>
                        <span className="text-xs font-semibold tabular-nums text-text-secondary font-accent">{displayProbability}%</span>
                        <AiBadge field="probability" meta={sourceMeta} />
                      </div>
                      <CitationPill field="probability" meta={sourceMeta} />
                    </div>
                  )}
                  {deal.notes && (
                    <div className="pt-2 border-t border-white/[0.04]">
                      <div className="text-xs text-text-muted mb-1">Notes</div>
                      <div className="text-sm text-text-secondary whitespace-pre-wrap">{deal.notes}</div>
                    </div>
                  )}
                  {!deal.amount && !deal.valuation && !deal.instrument_type && !deal.lead_source && (
                    <div className="text-xs text-text-muted italic">No deal details yet — click Edit to add</div>
                  )}
                </div>
              )}
            </GlassCard>

            {/* CARD: People Involved */}
            <GlassCard>
              <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-4 flex items-center gap-1.5">
                <Users size={11} /> People Involved
              </div>

              {/* ── Deal Owner (separate from sides) ── */}
              <div className="mb-4 pb-3 border-b border-white/[0.04]">
                <div className="text-[9px] uppercase tracking-[0.14em] font-semibold text-text-muted mb-2">Deal Owner</div>
                {deal.owner_name ? (
                  <div className="flex items-center gap-2.5 py-1.5 px-2 -mx-2">
                    <div className="w-7 h-7 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[10px] font-semibold shrink-0">
                      {deal.owner_name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary truncate">{deal.owner_name}</div>
                    </div>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                      style={{ background: 'rgba(217,70,168,0.1)', color: '#D946A8' }}>
                      Owner
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-text-muted italic">No owner assigned</div>
                )}
              </div>

              {/* ── Theirs ── */}
              <div className="mb-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[9px] uppercase tracking-[0.14em] font-semibold text-text-muted">Theirs</div>
                  <button
                    onClick={() => { setContactSide('theirs'); setShowAddContact(!showAddContact); setShowAddOurs(false); }}
                    className="text-[10px] text-accent-magenta hover:text-accent-purple transition-colors flex items-center gap-0.5"
                  >
                    <Plus size={9} /> Add
                  </button>
                </div>
                {(contacts.theirs || []).length > 0 ? (
                  <div className="space-y-1">
                    {(contacts.theirs || []).map((p: any) => (
                      <PersonRow key={p.id} person={p} onRemove={() => handleRemoveContact(p.id)} />
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-text-muted italic py-1">No contacts on their side</div>
                )}
              </div>

              {/* ── Ours (platform users only) ── */}
              <div className="mb-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[9px] uppercase tracking-[0.14em] font-semibold text-text-muted">Ours</div>
                  <button
                    onClick={() => { setShowAddOurs(!showAddOurs); setShowAddContact(false); }}
                    className="text-[10px] text-accent-magenta hover:text-accent-purple transition-colors flex items-center gap-0.5"
                  >
                    <Plus size={9} /> Add
                  </button>
                </div>
                {showAddOurs && (
                  <div className="mb-2 p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <select
                      className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-secondary focus:border-accent-magenta outline-none mb-2"
                      value={oursUserId}
                      onChange={e => setOursUserId(e.target.value)}
                      disabled={addingOurs}
                    >
                      <option value="">Select team member...</option>
                      {orgUsers.map((u: any) => (
                        <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                      ))}
                    </select>
                    <select
                      className="w-full bg-bg-input border border-border rounded-lg px-2 py-1.5 text-xs text-text-secondary focus:border-accent-magenta outline-none mb-2"
                      value={oursRole}
                      onChange={e => setOursRole(e.target.value)}
                      disabled={addingOurs}
                    >
                      <option value="">Role...</option>
                      {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <button
                      onClick={handleAddOurs}
                      disabled={addingOurs || !oursUserId || !oursRole}
                      className="w-full px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-30"
                      style={{ background: 'rgba(217,70,168,0.12)', color: '#D946A8', border: '1px solid rgba(217,70,168,0.2)' }}
                    >
                      {addingOurs ? 'Adding...' : 'Add Team Member'}
                    </button>
                  </div>
                )}
                {(contacts.ours || []).length > 0 ? (
                  <div className="space-y-1">
                    {(contacts.ours || []).map((p: any) => (
                      <PersonRow key={p.id} person={p} onRemove={() => handleRemoveContact(p.id)} />
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-text-muted italic py-1">No team members assigned</div>
                )}
              </div>

              {/* ── Other ── */}
              <div className="mb-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[9px] uppercase tracking-[0.14em] font-semibold text-text-muted">Other</div>
                  <button
                    onClick={() => { setContactSide('other'); setShowAddContact(!showAddContact); setShowAddOurs(false); }}
                    className="text-[10px] text-accent-magenta hover:text-accent-purple transition-colors flex items-center gap-0.5"
                  >
                    <Plus size={9} /> Add
                  </button>
                </div>
                {(contacts.other || []).length > 0 ? (
                  <div className="space-y-1">
                    {(contacts.other || []).map((p: any) => (
                      <PersonRow key={p.id} person={p} onRemove={() => handleRemoveContact(p.id)} />
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-text-muted italic py-1">No other contacts</div>
                )}
              </div>

              {/* ── Add contact form (for theirs / other) ── */}
              {showAddContact && (
                <div className="mt-2 p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-[10px] text-text-muted mb-1.5">
                    Adding to <span className="font-semibold capitalize">{contactSide}</span>
                  </div>
                  <div className="relative">
                    <input
                      ref={contactSearchRef}
                      className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-accent-magenta outline-none placeholder:text-text-muted"
                      placeholder="Search contacts..."
                      value={contactQuery}
                      onChange={e => setContactQuery(e.target.value)}
                      disabled={addingContact}
                    />
                    {contactSearching && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-text-muted">Searching...</div>
                    )}
                    {contactResults.length > 0 && (
                      <div
                        ref={contactDropdownRef}
                        className="absolute top-full left-0 right-0 mt-1 z-20 rounded-xl shadow-2xl py-1.5 max-h-48 overflow-y-auto"
                        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        {contactResults.map(c => (
                          <button
                            key={c.id}
                            onClick={() => handleAddContact(c.id, c.full_name)}
                            disabled={addingContact}
                            className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-white/[0.04]"
                          >
                            <div className="w-6 h-6 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[9px] font-semibold shrink-0">
                              {c.full_name?.charAt(0) || '?'}
                            </div>
                            <div className="min-w-0">
                              <div className="text-text-primary truncate">{c.full_name}</div>
                              {c.job_title && <div className="text-[10px] text-text-muted truncate">{c.job_title}</div>}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="mt-2">
                    <select
                      className="w-full bg-bg-input border border-border rounded-lg px-2 py-1.5 text-xs text-text-secondary focus:border-accent-magenta outline-none"
                      value={contactRole}
                      onChange={e => setContactRole(e.target.value)}
                      disabled={addingContact}
                    >
                      <option value="">Role...</option>
                      {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </GlassCard>

            {/* CARD: Company */}
            {company && (
              <GlassCard>
                <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3 flex items-center gap-1.5">
                  <Building2 size={11} /> Company
                </div>
                <Link href={`/companies/${company.id}`} className="flex items-center gap-3 group">
                  <div className="w-10 h-10 rounded-xl bg-brand-gradient flex items-center justify-center text-white text-sm font-semibold shrink-0 shadow-sm">
                    {company.name?.charAt(0) || '?'}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary group-hover:text-accent-magenta transition-colors truncate">
                      {company.name}
                    </div>
                    {company.sector && (
                      <div className="text-xs text-text-muted truncate">{company.sector}</div>
                    )}
                  </div>
                </Link>
              </GlassCard>
            )}

            {/* CARD: Notes */}
            <GlassCard>
              <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3 flex items-center gap-1.5">
                <FileText size={11} /> Notes
              </div>

              {notes.length === 0 && (
                <div className="text-sm text-text-muted py-4 text-center">No notes yet — add one below</div>
              )}

              <div className="space-y-2">
                {notes.map((note: any) => (
                  <div key={note.id} className="py-2.5 px-3 -mx-3 rounded-lg transition-colors hover:bg-white/[0.02] group">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-text-secondary whitespace-pre-wrap">{note.content}</div>
                        <div className="flex items-center gap-2 mt-1.5">
                          {note.author_name && (
                            <span className="text-[10px] text-text-muted">{note.author_name}</span>
                          )}
                          {note.created_at && (
                            <span className="text-[10px] text-text-muted">{fmtRel(note.created_at)}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteNote(note.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-semantic-error shrink-0 mt-0.5"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3">
                <textarea
                  className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:border-accent-magenta outline-none resize-none placeholder:text-text-muted"
                  rows={2}
                  placeholder="Add a note..."
                  value={newNote}
                  onChange={e => setNewNote(e.target.value)}
                  disabled={addingNote}
                />
                <div className="flex justify-end mt-2">
                  <button
                    onClick={handleAddNote}
                    disabled={addingNote || !newNote.trim()}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-30"
                    style={{ background: 'rgba(217,70,168,0.12)', color: '#D946A8', border: '1px solid rgba(217,70,168,0.2)' }}
                  >
                    {addingNote ? 'Adding...' : 'Add Note'}
                  </button>
                </div>
              </div>
            </GlassCard>

            {/* CARD: Documents */}
            <div
              className="relative"
              onDragEnter={e => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                docDropCounterRef.current++;
                setDocDropOver(true);
              }}
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
              onDragLeave={() => {
                docDropCounterRef.current = Math.max(0, docDropCounterRef.current - 1);
                if (docDropCounterRef.current === 0) setDocDropOver(false);
              }}
              onDrop={e => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                docDropCounterRef.current = 0;
                setDocDropOver(false);
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length > 0) { setDocUploadFiles(dropped); setDocUploadOpen(true); }
              }}
            >
              {docDropOver && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none rounded-xl"
                  style={{ background: 'rgba(217,70,168,0.08)', border: '2px dashed rgba(217,70,168,0.5)' }}>
                  <div className="px-3 py-2 rounded-lg bg-bg-elevated border border-border shadow-xl flex items-center gap-2">
                    <Upload size={14} className="text-accent-magenta" />
                    <span className="text-xs font-medium text-text-primary">Drop to attach to this deal</span>
                  </div>
                </div>
              )}
              <GlassCard>
              <div className="flex items-center justify-between mb-3">
                <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display flex items-center gap-1.5">
                  <FileText size={11} /> Documents
                  {documents.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold tabular-nums normal-case tracking-normal"
                      style={{ background: 'rgba(217,70,168,0.12)', color: '#D946A8' }}>
                      {documents.length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={uploadVisibility}
                    onChange={e => setUploadVisibility(e.target.value as 'private' | 'org_wide')}
                    disabled={uploading}
                    className="bg-bg-inset border border-border text-text-secondary text-[10px] px-1.5 py-1 rounded disabled:opacity-50"
                    title="Who can read this document"
                  >
                    <option value="private">Private</option>
                    <option value="org_wide">Org-wide</option>
                  </select>
                  <label className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium cursor-pointer transition-colors ${
                    uploading ? 'opacity-50 pointer-events-none' : 'hover:bg-white/[0.06]'
                  }`}
                    style={{ background: 'rgba(217,70,168,0.12)', color: '#D946A8', border: '1px solid rgba(217,70,168,0.2)' }}>
                    <Upload size={11} />
                    {uploading ? 'Uploading...' : 'Upload'}
                    <input ref={fileInputRef} type="file" className="hidden" onChange={handleDocUpload} disabled={uploading} />
                  </label>
                </div>
              </div>
              {docsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="h-12 bg-bg-surface animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : documents.length === 0 ? (
                <div className="text-center py-6">
                  <FileText size={22} className="mx-auto text-text-muted/30 mb-2" />
                  <div className="text-text-muted text-xs">No documents linked to this deal yet</div>
                  <div className="text-text-muted/60 text-[10px] mt-1">Upload a document or it will appear here when MARTy or the system links one</div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {documents.map((doc: any) => (
                    <div key={doc.id} className="flex items-center gap-2.5 py-2 px-2 -mx-2 rounded-lg transition-colors hover:bg-white/[0.03] group">
                      <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                        style={{ background: doc.source === 'email_attachment' ? 'rgba(59,130,246,0.12)' : 'rgba(139,92,246,0.12)' }}>
                        {doc.source === 'email_attachment'
                          ? <Paperclip size={12} className="text-blue-400" />
                          : <FileText size={12} className="text-purple-400" />}
                      </div>
                      <Link href={`/documents/${doc.id}`} className="flex-1 min-w-0 group/link">
                        <div className="text-xs font-medium text-text-primary truncate group-hover/link:text-accent-magenta transition-colors">
                          {doc.title || doc.file_name}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="px-1 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wider"
                            style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                            {(doc.document_type || 'other').replace(/_/g, ' ')}
                          </span>
                          {doc.file_size && <span className="text-[9px] text-text-muted">{fmtSize(doc.file_size)}</span>}
                          <span className="text-[9px] text-text-muted">{fmtRel(doc.created_at)}</span>
                        </div>
                      </Link>
                      <button onClick={() => handleDocDelete(doc.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-text-muted hover:text-semantic-error shrink-0"
                        title="Delete document">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>
            </div>
          </div>
        </div>
      </div>

      <DocumentUploadModal
        open={docUploadOpen}
        onClose={() => { setDocUploadOpen(false); setDocUploadFiles([]); }}
        onUploaded={() => { setRefreshKey(k => k + 1); setToast('Documents uploaded'); }}
        initialFiles={docUploadFiles}
        dealId={id}
      />

      {/* ── Delete modal ── */}
      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => !deleting && setDeleteOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Delete Deal</div>
            <div className="text-sm text-text-secondary mb-6">
              Delete <span className="font-medium text-text-primary">{deal.title}</span>? This cannot be undone.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>Cancel</button>
              <button className="btn-primary bg-semantic-error hover:bg-semantic-error/90" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
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

/* ───────── Sub-components ───────── */

/** Day-5 Intelligence Pulse Strip. Reads from deal_intelligence (per-user
 *  storage, populated by T3's evaluator wave per docs/deal-intelligence-contract.md).
 *  Today this renders entirely as empty-state messaging — the contract is
 *  signed but no schema migration has landed yet, so the read shape is
 *  reserved on the deal object as `deal.deal_intelligence`. When T3 ships,
 *  the consumer handler joins the row in and the strip lights up.
 *
 *  Per-user is the load-bearing security invariant — sentiment / topics /
 *  risk are derived from conversation bodies the user can read, and a global
 *  row would leak content across canReadEmailContent boundaries. */
function DealIntelligenceStrip({ deal }: { deal: any }) {
  const di = (deal && deal.deal_intelligence) || {};
  const parseJson = (v: unknown): any[] => {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string') return [];
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  };
  const sentimentScore: number | null = typeof di.sentiment_score === 'number' ? di.sentiment_score : null;
  const sentimentDirection: 'improving' | 'stable' | 'declining' | null = di.sentiment_direction ?? null;
  const topics: string[] = parseJson(di.active_topics).filter((s: unknown): s is string => typeof s === 'string');
  const riskCount: number = Number.isFinite(di.risk_signal_count) ? Number(di.risk_signal_count) : 0;
  const riskExamples: Array<{ text: string; source_id?: string; source_type?: string; sent_at?: string }> =
    parseJson(di.risk_signal_examples).filter((e: any) => e && typeof e === 'object' && typeof e.text === 'string');
  const momentumTrend: 'increasing' | 'decreasing' | 'stable' | null = di.momentum_trend ?? null;
  const momentumBuckets: Array<{ week_start: string; count: number }> =
    parseJson(di.momentum_buckets).filter((b: any) =>
      b && typeof b === 'object' && typeof b.week_start === 'string' && Number.isFinite(b.count)
    );

  return (
    <div className="border-b border-border">
      <div className="px-8 py-4 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">
          Intelligence
        </span>
        <span className="text-[9px] text-text-muted/60 italic">
          {Object.keys(di).length === 0
            ? 'awaiting evaluator (T3 Wave 6) — data lands automatically'
            : `last computed ${di.last_computed_at ? fmtRel(di.last_computed_at) : '—'}`}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {/* Sentiment */}
        <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Sentiment</div>
          {sentimentScore === null && sentimentDirection === null ? (
            <div className="text-xs text-text-muted italic">Insufficient data yet</div>
          ) : (
            <div className="flex items-center gap-2">
              <span
                className="text-2xl font-semibold tabular-nums font-accent"
                style={{
                  color:
                    sentimentDirection === 'improving' ? '#22C55E' :
                    sentimentDirection === 'declining' ? '#EF4444' : '#A1A1AA',
                }}
              >
                {sentimentScore !== null
                  ? `${sentimentScore >= 0 ? '+' : ''}${sentimentScore.toFixed(2)}`
                  : '—'}
              </span>
              {sentimentDirection && (
                <span className="text-[10px] text-text-muted capitalize">{sentimentDirection}</span>
              )}
            </div>
          )}
        </div>

        {/* Active Topics */}
        <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Active Topics</div>
          {topics.length === 0 ? (
            <div className="text-xs text-text-muted italic">No active topics extracted</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {topics.slice(0, 5).map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="text-[10px] font-accent px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(139,92,246,0.10)', color: '#A78BFA' }}
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Risk Signals */}
        <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Risk Signals</div>
          {riskCount === 0 ? (
            <div className="text-xs text-text-muted italic">No risk signals detected</div>
          ) : (
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums font-accent text-red-400">
                  {riskCount}
                </span>
                <span className="text-[10px] text-text-muted">
                  signal{riskCount === 1 ? '' : 's'}
                </span>
              </div>
              {riskExamples.length > 0 && (
                <div className="text-[10px] text-text-muted mt-1 truncate" title={riskExamples[0].text}>
                  ↳ {riskExamples[0].text}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Momentum */}
        <div className="px-5 py-4">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Momentum</div>
          {momentumBuckets.length === 0 ? (
            <div className="text-xs text-text-muted italic">No conversation activity yet</div>
          ) : (
            <div className="flex items-center gap-2">
              <DetailMomentumSparkline buckets={momentumBuckets} trend={momentumTrend} />
              <span
                className="text-[10px] capitalize"
                style={{
                  color:
                    momentumTrend === 'increasing' ? '#22C55E' :
                    momentumTrend === 'decreasing' ? '#EF4444' : '#A1A1AA',
                }}
              >
                {momentumTrend ?? 'stable'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Larger sparkline for the detail page strip. Same shape as the board card
 *  version but bigger (so the bucket-by-bucket trend reads). */
function DetailMomentumSparkline({ buckets, trend }: {
  buckets: Array<{ week_start: string; count: number }>;
  trend: 'increasing' | 'decreasing' | 'stable' | null;
}) {
  const W = 80, H = 28, PAD = 3;
  const color = trend === 'increasing' ? '#22C55E'
    : trend === 'decreasing' ? '#EF4444'
    : '#71717A';
  const counts = buckets.map(b => b.count);
  const maxC = Math.max(...counts, 1);
  const stepX = (W - 2 * PAD) / Math.max(buckets.length - 1, 1);
  const points = counts.map((c, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((c / maxC) * (H - 2 * PAD));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const tooltip = buckets.map(b => `${b.week_start.slice(0, 10)}: ${b.count}`).join('\n');
  return (
    <svg width={W} height={H} className="shrink-0">
      <title>{tooltip}</title>
      <polyline points={points} fill="none" stroke={color} strokeWidth={2}
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Day-5 Phase 3: thread-grouped conversations card on the detail page.
 *  Consumes GET /api/deals/:id/conversations. Threads collapsed by default;
 *  click expands to show every message in the thread with body_preview
 *  (when can_read_body) or a "—" placeholder (when redacted by ACL).
 *
 *  ACL behavior matches the existing Activity Timeline:
 *    - Subject + last-sent-at + message_count visible regardless
 *    - sender_name + sender_email + body_preview only when can_read_body
 *    - Threads with can_read_any=false render the metadata but never the
 *      body content
 *
 *  404 handling: if the worker is older than Phase 2 (endpoint not yet
 *  deployed), the catch path falls through to "no conversations" empty
 *  state. Better than a crash. Once the worker catches up, the card
 *  populates on next refresh. */
function DealConversationsCard({ dealId }: { dealId: string }) {
  const [data, setData] = React.useState<{
    threads: Array<{
      external_thread_id: string | null;
      subject: string;
      last_sender_name: string | null;
      last_sent_at: string;
      message_count: number;
      can_read_any: boolean;
      participants: Array<{ contact_id: string | null; name: string | null; email: string | null }>;
      messages: Array<{
        id: string;
        external_message_id: string | null;
        source: string;
        sender_name: string | null;
        sender_email: string | null;
        sent_at: string;
        direction: string | null;
        can_read_body: boolean;
        body_preview: string | null;
        has_attachments: boolean;
      }>;
    }>;
    ungrouped_count: number;
    truncated: boolean;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [endpointMissing, setEndpointMissing] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setEndpointMissing(false);
    api.getDealConversations(dealId)
      .then(r => { if (alive) setData(r); })
      .catch((e: any) => {
        // 404 → worker hasn't deployed Phase 2 yet. Treat as "no data" rather
        // than a hard error so the surrounding page renders normally.
        if (alive && e?.status === 404) setEndpointMissing(true);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dealId]);

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const threads = data?.threads ?? [];

  return (
    <GlassCard>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">
          Conversations
        </span>
        {threads.length > 0 && (
          <span className="text-[10px] text-text-muted font-accent">
            {threads.length} thread{threads.length === 1 ? '' : 's'}
            {data?.truncated && ' (more available)'}
          </span>
        )}
      </div>

      {loading && (
        <div className="text-sm text-text-muted py-4 text-center">Loading…</div>
      )}

      {!loading && endpointMissing && (
        <div className="text-xs text-text-muted italic py-2">
          Worker hasn't picked up the conversations endpoint yet — auto-recovers on next deploy.
        </div>
      )}

      {!loading && !endpointMissing && threads.length === 0 && (
        <div className="text-sm text-text-muted py-4 text-center">
          No conversations linked to this deal yet.
        </div>
      )}

      {!loading && threads.length > 0 && (
        <div className="space-y-1.5">
          {threads.map((thread, idx) => {
            const key = thread.external_thread_id ?? `__ungrouped__:${idx}`;
            const isOpen = expanded.has(key);
            const headerSender = thread.last_sender_name ?? '—';
            return (
              <div
                key={key}
                className="rounded-lg overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}
              >
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
                >
                  {isOpen
                    ? <ChevronDown size={12} className="text-text-muted shrink-0" />
                    : <ChevronRight size={12} className="text-text-muted shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">{thread.subject}</div>
                    <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-2">
                      <span>{headerSender}</span>
                      <span>·</span>
                      <span>{thread.message_count} message{thread.message_count === 1 ? '' : 's'}</span>
                      <span>·</span>
                      <span>{fmtRel(thread.last_sent_at)}</span>
                      {!thread.can_read_any && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-0.5 text-text-muted/60">
                            <Lock size={9} /> redacted
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-white/[0.04] px-3 py-2 space-y-2 bg-black/10">
                    {thread.messages.map(msg => {
                      const senderLabel = msg.can_read_body
                        ? (msg.sender_name || msg.sender_email || 'Unknown')
                        : '—';
                      return (
                        <div key={msg.id} className="text-xs">
                          <div className="flex items-center gap-2 text-text-muted">
                            <span className="font-medium text-text-secondary">{senderLabel}</span>
                            <span className="text-[10px]">{fmtRel(msg.sent_at)}</span>
                            {msg.has_attachments && (
                              <span className="text-[9px] inline-flex items-center gap-0.5 text-text-muted/70">
                                <FileText size={9} /> attachment
                              </span>
                            )}
                            {!msg.can_read_body && (
                              <span className="text-[9px] inline-flex items-center gap-0.5 text-text-muted/60">
                                <Lock size={9} /> redacted
                              </span>
                            )}
                          </div>
                          {msg.can_read_body
                            ? (msg.body_preview && (
                                <div className="text-text-secondary mt-1 line-clamp-3 leading-snug">
                                  {msg.body_preview}
                                </div>
                              ))
                            : (
                              <div className="text-text-muted/50 italic mt-1">
                                You don't have access to this message body.
                              </div>
                            )}
                          {/* Day-5 Phase D: Open-in-Outlook deep-link. Only for
                              source='outlook' messages with a non-null
                              external_message_id. Outlook web's deeplink
                              endpoint takes the URL-encoded Graph message id;
                              clicking opens the message in the user's signed-in
                              Outlook session (no extra auth flow). For non-
                              outlook sources (slack / manual / firefly
                              transcripts) we hide the link entirely. */}
                          {msg.source === 'outlook' && msg.external_message_id && msg.can_read_body && (
                            <a
                              href={`https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(msg.external_message_id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-[10px] text-accent-magenta hover:text-accent-purple mt-1.5 transition-colors"
                            >
                              <ArrowRight size={10} /> Open in Outlook
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}

function GlassCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative rounded-xl p-5 transition-all duration-200 hover:border-white/[0.1]"
      style={{
        background: 'rgba(17,17,20,0.65)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      {children}
    </div>
  );
}

function TimelineRow({ entry }: { entry: any }) {
  const meta = parseEntryMeta(entry);
  const isStageChange = entry.type === 'audit' && meta.old_stage && meta.new_stage;
  const isRestrictedEmail =
    entry.type === 'conversation' && entry.canReadContent === false;

  const iconMap: Record<string, React.ReactNode> = {
    conversation: isRestrictedEmail
      ? <Lock size={14} className="text-text-muted" />
      : <Mail size={14} className="text-blue-400" />,
    event:        <Calendar size={14} className="text-cyan-400" />,
    note:         <FileText size={14} className="text-purple-400" />,
    audit:        <Activity size={14} className="text-zinc-400" />,
  };

  let icon = iconMap[entry.type] || <Activity size={14} className="text-text-muted" />;
  if (isStageChange) icon = <ArrowRight size={14} className="text-amber-400" />;
  if (entry.type === 'audit' && meta.sub_action === 'add_contact') icon = <Users size={14} className="text-purple-400" />;
  if (entry.type === 'audit' && meta.sub_action === 'create_note') icon = <FileText size={14} className="text-purple-400" />;
  if (entry.type === 'audit' && meta.sub_action === 'create_action_item') icon = <CheckCircle2 size={14} className="text-cyan-400" />;

  const description = entry.type === 'audit'
    ? formatAuditEntry(entry)
    : (entry.subject || entry.title || entry.description || entry.content || 'Untitled');

  const timestamp = entry.timestamp || entry.date || entry.created_at;

  if (!description || !timestamp) return null;

  return (
    <div className="flex items-start gap-3 py-2.5 px-3 -mx-3 rounded-lg transition-colors hover:bg-white/[0.02]">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'rgba(255,255,255,0.04)' }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary truncate">{description}</div>
        {isStageChange && (
          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-text-muted">
            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
              style={{ background: hexToRgba(STAGE_COLORS[meta.old_stage as DealStage] || '#71717A', 0.12), color: STAGE_COLORS[meta.old_stage as DealStage] || '#71717A' }}>
              {STAGE_LABELS[meta.old_stage as DealStage] || meta.old_stage}
            </span>
            <ArrowRight size={10} />
            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
              style={{ background: hexToRgba(STAGE_COLORS[meta.new_stage as DealStage] || '#71717A', 0.12), color: STAGE_COLORS[meta.new_stage as DealStage] || '#71717A' }}>
              {STAGE_LABELS[meta.new_stage as DealStage] || meta.new_stage}
            </span>
          </div>
        )}
        {isRestrictedEmail ? (
          <div className="text-xs text-text-muted italic mt-0.5">You are not a participant in this email</div>
        ) : entry.body_preview ? (
          <div className="text-xs text-text-muted mt-0.5 truncate">{entry.body_preview}</div>
        ) : null}
        {entry.attendees && (
          <div className="text-xs text-text-muted mt-0.5 truncate">{entry.attendees}</div>
        )}
        {entry.user_name && entry.type === 'audit' && (
          <div className="text-[10px] text-text-muted mt-0.5">{entry.user_name}</div>
        )}
        {entry.author_name && entry.type === 'note' && (
          <div className="text-[10px] text-text-muted mt-0.5">{entry.author_name}</div>
        )}
      </div>
      <span className="text-[10px] text-text-muted shrink-0 mt-1">
        {fmtRel(timestamp)}
      </span>
    </div>
  );
}

function parseEntryMeta(entry: any): any {
  if (!entry.metadata) return {};
  if (typeof entry.metadata === 'string') {
    try { return JSON.parse(entry.metadata); } catch { return {}; }
  }
  return entry.metadata;
}

const FIELD_LABELS: Record<string, string> = {
  amount: 'amount', valuation: 'valuation', our_allocation: 'allocation',
  instrument_type: 'instrument', probability: 'probability', stage: 'stage',
  expected_close: 'expected close', actual_close_date: 'actual close',
  lead_source: 'lead source', thesis_fit: 'thesis fit', title: 'title',
  notes: 'notes', owner_id: 'owner',
};

function formatAuditEntry(entry: any): string {
  const action = entry.action || entry.subtype || '';
  const meta = parseEntryMeta(entry);

  if (action === 'create') {
    if (meta.sub_action === 'create_note') return 'Note added';
    if (meta.sub_action === 'create_action_item') return 'Action item added';
    if (meta.sub_action === 'add_contact') {
      const role = meta.role ? ` as ${ROLE_LABEL[meta.role] || meta.role}` : '';
      return `Contact added to deal${role}`;
    }
    return 'Deal created';
  }

  if (action === 'soft_delete') return 'Deal deleted';

  if (action === 'update') {
    if (meta.sub_action === 'add_contact') {
      const role = meta.role ? ` as ${ROLE_LABEL[meta.role] || meta.role}` : '';
      return `Contact added to deal${role}`;
    }
    if (meta.sub_action === 'remove_contact') return 'Contact removed from deal';
    if (meta.old_stage && meta.new_stage) {
      const from = STAGE_LABELS[meta.old_stage as DealStage] || meta.old_stage;
      const to = STAGE_LABELS[meta.new_stage as DealStage] || meta.new_stage;
      return `Stage changed from ${from} to ${to}`;
    }
    const changed = entry.changed_fields as string[] | undefined;
    if (changed && changed.length > 0) {
      const labels = changed
        .filter(f => FIELD_LABELS[f])
        .map(f => FIELD_LABELS[f]);
      if (labels.length > 0) return `Deal updated — ${labels.join(', ')}`;
    }
    return 'Deal updated';
  }

  if (!action) return '';
  return action.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
}

function PersonRow({ person, onRemove }: { person: any; onRemove: () => void }) {
  const roleDisplay = person.role
    ? (ROLE_LABEL[person.role] || person.role.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()))
    : null;

  return (
    <div className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded-lg transition-colors hover:bg-white/[0.02] group">
      <div className="w-7 h-7 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[10px] font-semibold shrink-0">
        {(person.full_name || person.name || '?').charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <Link href={`/contacts/${person.id}`} className="text-sm text-text-primary hover:text-accent-magenta transition-colors truncate block">
          {person.full_name || person.name}
        </Link>
      </div>
      {roleDisplay && (
        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider shrink-0"
          style={{ background: 'rgba(139,92,246,0.1)', color: '#A78BFA' }}>
          {roleDisplay}
        </span>
      )}
      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-semantic-error"
      >
        <XIcon size={12} />
      </button>
    </div>
  );
}

function ActionItemRow({ item, onToggle, onDelete }: { item: any; onToggle: () => void; onDelete: () => void }) {
  const isCompleted = item.status === 'completed';
  const isOverdue = !isCompleted && item.due_date && new Date(item.due_date) < new Date();

  return (
    <div className="flex items-center gap-2.5 py-2 px-2 -mx-2 rounded-lg transition-colors hover:bg-white/[0.02] group">
      <button onClick={onToggle} className="shrink-0">
        {isCompleted ? (
          <CheckCircle2 size={16} className="text-green-400" />
        ) : (
          <div className="w-4 h-4 rounded-full border border-white/20 hover:border-accent-magenta transition-colors" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${isCompleted ? 'line-through text-text-muted' : 'text-text-primary'}`}>
          {item.description}
        </span>
      </div>
      {item.assignee_name && (
        <span className="text-[10px] text-text-muted shrink-0">{item.assignee_name}</span>
      )}
      {item.due_date && (
        <span className={`text-[10px] shrink-0 ${isOverdue ? 'text-red-400 font-semibold' : 'text-text-muted'}`}>
          {isOverdue && <AlertCircle size={10} className="inline mr-0.5 -mt-0.5" />}
          {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      )}
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-semantic-error shrink-0"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-text-muted shrink-0">{k}</span>
      <span className="text-text-secondary text-sm">{v}</span>
    </div>
  );
}

function EF({ label, v, set, type, d }: { label: string; v: string; set: (v: string) => void; type?: string; d?: boolean }) {
  return (
    <label className="block">
      <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">{label}</div>
      <input type={type || 'text'} className="input w-full" value={v} onChange={e => set(e.target.value)} disabled={d} />
    </label>
  );
}

/* ───────── Utilities ───────── */

function fmtRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const d = 86_400_000;
  if (ms < 0) return 'Upcoming';
  if (ms < d) return 'Today';
  if (ms < 2 * d) return 'Yesterday';
  if (ms < 7 * d) return `${Math.floor(ms / d)}d ago`;
  if (ms < 30 * d) return `${Math.floor(ms / (7 * d))}w ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtCurrency(val: number): string {
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(1)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toLocaleString()}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

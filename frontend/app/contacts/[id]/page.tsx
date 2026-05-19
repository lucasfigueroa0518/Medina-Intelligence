'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Mail, Phone, MapPin, Linkedin, Twitter, Calendar,
  ChevronDown, ChevronUp, ExternalLink, TrendingUp, TrendingDown, Minus,
  Users, Briefcase, Target, DollarSign, Hash, Info, ArrowRight,
  Check, X as XIcon, Sparkles, RefreshCw, Upload, FileText, Paperclip, Trash2,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { Timeline, TimelineEntry } from '@/components/timeline';
import { CompanySearchField } from '@/components/company-search-field';
import { TagPicker } from '@/components/tag-picker';
import { DocumentUploadModal } from '@/components/document-upload-modal';
import { DocumentPreviewModal } from '@/components/document-preview-modal';
import { DocumentActions } from '@/components/document-actions';
import { RecentObservations } from '@/components/recent-observations';
import { api } from '@/lib/api';
import { cleanIntelBrief } from '@/lib/intelligence-briefing';
import {
  DEMO_IDS,
  demoContactDetailFixture,
  demoRecentObservationsForContact,
  demoToastMessage,
  useDemoMode,
} from '@/lib/demo-mode';

type Tab = 'overview' | 'timeline' | 'associations' | 'documents' | 'deals';

const CONTACT_TYPE_OPTIONS = [
  { value: 'individual', label: 'Individual' },
  { value: 'family', label: 'Family' },
  { value: 'institutional_investor', label: 'Institutional Investor' },
  { value: 'company', label: 'Company' },
  { value: 'other', label: 'Other' },
];

const ENGAGEMENT_STATUSES = [
  { value: 'active',   label: 'Active',   dot: '#22C55E', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.25)',  text: '#4ADE80' },
  { value: 'warm',     label: 'Warm',     dot: '#3B82F6', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)', text: '#60A5FA' },
  { value: 'new',      label: 'New',      dot: '#F59E0B', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)', text: '#FBBF24' },
  { value: 'dormant',  label: 'Dormant',  dot: '#F97316', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.25)', text: '#FB923C' },
  { value: 'churning', label: 'Churning', dot: '#EF4444', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.25)',  text: '#F87171' },
  { value: 'close',    label: 'Close',    dot: '#A855F7', bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.25)', text: '#C084FC' },
];

interface EditFormData {
  full_name: string; email: string; phone: string; job_title: string;
  contact_type: string; linkedin_url: string; twitter_url: string;
  company_id: string | null; company_name: string;
  location: string; introduced_via: string; investment_focus: string;
  check_size_range: string; fund_name: string; commitment_status: string;
}

export function ContactDetailContent({ forcedId }: { forcedId?: string } = {}) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = forcedId || String(params?.id || '');
  const demoMode = useDemoMode();
  const isDemoContact = id === DEMO_IDS.contact || id.startsWith('demo-contact');
  const demoFixture = demoContactDetailFixture;

  const [contact, setContact] = React.useState<any>(() => (isDemoContact ? demoFixture.contact : null));
  const [tags, setTags] = React.useState<any[]>(() => (isDemoContact ? demoFixture.tags || [] : []));
  const [associations, setAssociations] = React.useState<any[]>(() => (isDemoContact ? demoFixture.associations || [] : []));
  const [entityAssociations, setEntityAssociations] = React.useState<any[]>(() => (isDemoContact ? demoFixture.entity_associations || [] : []));
  const [signals, setSignals] = React.useState<any[]>(() => (isDemoContact ? demoFixture.signals || [] : []));
  const [timeline, setTimeline] = React.useState<TimelineEntry[]>(() => (isDemoContact ? demoFixture.timeline as TimelineEntry[] : []));
  const [fullBio, setFullBio] = React.useState<string | null>(() => (isDemoContact ? demoFixture.full_bio : null));
  const [enrichmentMeta, setEnrichmentMeta] = React.useState<any>(() => (isDemoContact ? demoFixture.enrichment_meta : null));
  const [activeTab, setActiveTab] = React.useState<Tab>('overview');
  const [loading, setLoading] = React.useState(!isDemoContact);
  const [editMode, setEditMode] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [editForm, setEditForm] = React.useState<EditFormData>({
    full_name: '', email: '', phone: '', job_title: '', contact_type: '',
    linkedin_url: '', twitter_url: '', company_id: null, company_name: '',
    location: '', introduced_via: '', investment_focus: '', check_size_range: '',
    fund_name: '', commitment_status: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [toast, setToast] = React.useState<string | null>(null);
  const [enriching, setEnriching] = React.useState(false);
  const [enriched, setEnriched] = React.useState(false);
  const [weeklyInteractions, setWeeklyInteractions] = React.useState<any[]>(() => (isDemoContact ? demoFixture.weekly_interactions || [] : []));
  const [firstInteractionDate, setFirstInteractionDate] = React.useState<string | null>(() => (isDemoContact ? demoFixture.first_interaction_date || null : null));
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [bioExpanded, setBioExpanded] = React.useState(false);
  const [pendingUpdates, setPendingUpdates] = React.useState<any[]>(() => (isDemoContact ? demoFixture.pending_updates || [] : []));
  const [approvingIds, setApprovingIds] = React.useState<Set<string>>(new Set());
  const [approvedFields, setApprovedFields] = React.useState<Set<string>>(new Set());
  const [documents, setDocuments] = React.useState<any[]>(() => (isDemoContact ? demoFixture.documents || [] : []));
  const [docsLoading, setDocsLoading] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [uploadVisibility, setUploadVisibility] = React.useState<'private' | 'org_wide'>('private');
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Wave 5 Phase F: drag-drop on the Documents tab. Existing single-file
  // inline button is kept; drop opens the new multi-file modal instead.
  const [docDropOver, setDocDropOver] = React.useState(false);
  const [docUploadOpen, setDocUploadOpen] = React.useState(false);
  const [docUploadFiles, setDocUploadFiles] = React.useState<File[]>([]);
  const docDropCounterRef = React.useRef(0);
  // Wave 5 Phase G — preview modal state
  const [previewDocId, setPreviewDocId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isDemoContact) {
      const fixture = demoContactDetailFixture;
      setContact(fixture.contact);
      setTags(fixture.tags || []);
      setAssociations(fixture.associations || []);
      setSignals(fixture.signals || []);
      setWeeklyInteractions(fixture.weekly_interactions || []);
      setFirstInteractionDate(fixture.first_interaction_date || null);
      setTimeline(fixture.timeline as TimelineEntry[]);
      setFullBio(fixture.full_bio);
      setEnrichmentMeta(fixture.enrichment_meta);
      setEntityAssociations(fixture.entity_associations || []);
      setPendingUpdates(fixture.pending_updates || []);
      setDocuments(fixture.documents || []);
      setApprovedFields(new Set());
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.getContact(id),
      api.getContactTimeline(id).catch(() => ({ entries: [] })),
      api.getContactEnrichment(id).catch(() => null),
      api.getContactAssociations(id).catch(() => ({ associations: [] })),
      api.getContactPendingUpdates(id).catch(() => ({ updates: [] })),
    ]).then(([c, t, e, ea, pu]) => {
      setContact(c.contact);
      setTags(c.tags);
      setAssociations((c as any).associations || []);
      setSignals((c as any).signals || []);
      setWeeklyInteractions((c as any).weekly_interactions || []);
      setFirstInteractionDate((c as any).first_interaction_date || null);
      setTimeline(t.entries as TimelineEntry[]);
      setFullBio(e?.full_bio ?? null);
      setEnrichmentMeta(e);
      setEntityAssociations(ea.associations || []);
      setPendingUpdates(pu.updates || []);
      setApprovedFields(new Set());
    }).finally(() => setLoading(false));
  }, [id, refreshKey, isDemoContact]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  React.useEffect(() => {
    if (isDemoContact) {
      if (activeTab === 'documents') setDocuments(demoContactDetailFixture.documents || []);
      setDocsLoading(false);
      return;
    }
    if (activeTab !== 'documents') return;
    setDocsLoading(true);
    api.listDocuments({ contact_id: id }).then(r => setDocuments(r.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setDocsLoading(false));
  }, [activeTab, id, refreshKey, isDemoContact]);

  async function handleDocUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isDemoContact) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      setToast(demoToastMessage('Document upload'));
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadDocument(file, { contact_id: id, visibility: uploadVisibility });
      if (res.duplicate) {
        setToast('Duplicate document — already exists');
      } else {
        setToast('Document uploaded');
      }
      setRefreshKey(k => k + 1);
    } catch (err: any) { setToast(`Upload failed: ${err.message}`); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function handleDocDelete(docId: string) {
    if (isDemoContact) {
      setDocuments(prev => prev.filter(d => d.id !== docId));
      setToast(demoToastMessage('Document delete'));
      return;
    }
    try {
      await api.deleteDocument(docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
      setToast('Document deleted');
    } catch { setToast('Delete failed'); }
  }

  const hasInvestorTag = tags.some(t => t.name === 'Investor' || t.name === 'LP');

  function enterEditMode() {
    if (!contact) return;
    setEditForm({
      full_name: contact.full_name || '', email: contact.email || '',
      phone: contact.phone || '', job_title: contact.job_title || '',
      contact_type: contact.contact_type || 'individual',
      linkedin_url: contact.linkedin_url || '', twitter_url: contact.twitter_url || '',
      company_id: contact.company_id || null,
      company_name: contact.company_name || '', location: contact.location || '',
      introduced_via: contact.introduced_via || '',
      investment_focus: contact.investment_focus || '',
      check_size_range: contact.check_size_range || '',
      fund_name: contact.fund_name || '', commitment_status: contact.commitment_status || '',
    });
    setEditMode(true);
  }

  async function handleSave() {
    if (!editForm.full_name.trim()) return;
    setSaving(true);
    try {
      if (isDemoContact) {
        setContact((c: any) => ({
          ...c,
          full_name: editForm.full_name.trim(),
          email: editForm.email.trim() || null,
          phone: editForm.phone.trim() || null,
          job_title: editForm.job_title.trim() || null,
          contact_type: editForm.contact_type,
          linkedin_url: editForm.linkedin_url.trim() || null,
          twitter_url: editForm.twitter_url.trim() || null,
          company_id: editForm.company_id,
          company_name: editForm.company_name,
          location: editForm.location.trim() || null,
          introduced_via: editForm.introduced_via.trim() || null,
          investment_focus: editForm.investment_focus.trim() || null,
          check_size_range: editForm.check_size_range.trim() || null,
          fund_name: editForm.fund_name.trim() || null,
          commitment_status: editForm.commitment_status.trim() || null,
        }));
        setEditMode(false);
        setToast(demoToastMessage('Contact edit'));
        return;
      }
      await api.updateContact(id, {
        full_name: editForm.full_name.trim(),
        email: editForm.email.trim() || null, phone: editForm.phone.trim() || null,
        job_title: editForm.job_title.trim() || null, contact_type: editForm.contact_type,
        linkedin_url: editForm.linkedin_url.trim() || null,
        twitter_url: editForm.twitter_url.trim() || null,
        company_id: editForm.company_id,
        location: editForm.location.trim() || null,
        introduced_via: editForm.introduced_via.trim() || null,
        investment_focus: editForm.investment_focus.trim() || null,
        check_size_range: editForm.check_size_range.trim() || null,
        fund_name: editForm.fund_name.trim() || null,
        commitment_status: editForm.commitment_status.trim() || null,
      });
      setEditMode(false);
      setRefreshKey(k => k + 1);
      setToast('Contact updated');
    } catch (e: any) { setToast(`Save failed: ${e.message || 'Unknown error'}`); }
    finally { setSaving(false); }
  }

  async function handleStatusChange(v: string) {
    setStatusOpen(false);
    if (isDemoContact) {
      setContact((c: any) => ({ ...c, engagement_status: v, engagement_status_manual: 1 }));
      setToast(demoToastMessage('Status change'));
      return;
    }
    try {
      await api.updateContact(id, { engagement_status: v });
      setContact((c: any) => ({ ...c, engagement_status: v, engagement_status_manual: 1 }));
      setToast(`Status → ${v}`);
    } catch (e: any) { setToast(`Failed: ${e.message}`); }
  }

  async function handleEnrich() {
    if (isDemoContact) {
      setEnriching(true);
      window.setTimeout(() => {
        setEnriching(false);
        setEnriched(true);
        setToast(demoToastMessage('Enrichment'));
      }, 450);
      return;
    }
    setEnriching(true);
    try {
      await api.enrichContact(id);
      setToast('Enrichment started');
      setTimeout(() => { setEnriching(false); setEnriched(true); setRefreshKey(k => k + 1); }, 5000);
    } catch (e: any) { setToast(`Enrichment failed: ${e.message}`); setEnriching(false); }
  }

  async function handleApproveSuggestion(updateId: string, fieldName: string) {
    if (isDemoContact) {
      setApprovedFields(prev => new Set(prev).add(fieldName));
      setPendingUpdates(prev => prev.filter(u => u.id !== updateId));
      setToast(demoToastMessage('Suggestion approval'));
      return;
    }
    setApprovingIds(prev => new Set(prev).add(updateId));
    try {
      const res = await api.approveItem(updateId);
      setApprovedFields(prev => new Set(prev).add(fieldName));
      setPendingUpdates(prev => prev.filter(u => u.id !== updateId));
      setToast(`Updated ${humanField(fieldName)}`);
      if (res.re_enrich_triggered) setToast(`Updated ${humanField(fieldName)} — re-enrichment triggered`);
      setTimeout(() => setRefreshKey(k => k + 1), 1000);
    } catch { setToast('Failed to approve'); }
    setApprovingIds(prev => { const s = new Set(prev); s.delete(updateId); return s; });
  }

  async function handleRejectSuggestion(updateId: string) {
    if (isDemoContact) {
      setPendingUpdates(prev => prev.filter(u => u.id !== updateId));
      setToast(demoToastMessage('Suggestion dismissal'));
      return;
    }
    setApprovingIds(prev => new Set(prev).add(updateId));
    try {
      await api.rejectItem(updateId);
      setPendingUpdates(prev => prev.filter(u => u.id !== updateId));
    } catch { setToast('Failed to dismiss'); }
    setApprovingIds(prev => { const s = new Set(prev); s.delete(updateId); return s; });
  }

  async function handleApproveAll() {
    if (isDemoContact) {
      setPendingUpdates([]);
      setToast(demoToastMessage('Suggestion approval'));
      return;
    }
    try {
      await api.approveAllForEntity('contact', id);
      setPendingUpdates([]);
      setToast('All suggestions approved');
      setTimeout(() => setRefreshKey(k => k + 1), 1000);
    } catch { setToast('Failed to approve all'); }
  }

  async function handleRejectAll() {
    if (isDemoContact) {
      setPendingUpdates([]);
      setToast(demoToastMessage('Suggestion dismissal'));
      return;
    }
    try {
      await api.rejectAllForEntity('contact', id);
      setPendingUpdates([]);
      setToast('All suggestions dismissed');
    } catch { setToast('Failed to dismiss all'); }
  }

  async function handleDelete() {
    if (isDemoContact) {
      router.push('/contacts');
      return;
    }
    setDeleting(true);
    try { await api.deleteContact(id); router.push('/contacts'); }
    catch (e: any) { alert(e.message || 'Delete failed'); setDeleting(false); }
  }

  if (loading) return <div className="flex-1 flex items-center justify-center text-text-secondary">Loading...</div>;
  if (!contact) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4">
      <div className="text-text-secondary">Contact not found</div>
      <Link href="/contacts" className="btn-secondary">Back to Contacts</Link>
    </div>
  );

  const es = ENGAGEMENT_STATUSES.find(s => s.value === contact.engagement_status) || ENGAGEMENT_STATUSES[2];
  const bio = cleanIntelBrief(fullBio || contact.bio_summary);
  const bioParas = bio ? bio.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean) : [];
  const hasInvestment = contact.investment_focus || contact.check_size_range || contact.fund_name || contact.commitment_status;
  const showInvestmentCard = editMode ? hasInvestorTag : (hasInvestorTag || hasInvestment);
  const topics = jsonArr(contact.topics_of_interest);
  const confidence = contact.source_confidence ?? 1;
  const emailVel = contact.email_frequency_score || 0;

  return (
    <div className="flex-1 overflow-auto">
      {/* ── Edit mode sticky bar ── */}
      {editMode && (
        <div className="sticky top-0 z-30 border-b px-4 md:px-8 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{ background: 'rgba(9,9,11,0.92)', backdropFilter: 'blur(16px)', borderColor: 'rgba(217,70,168,0.25)' }}>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-2 h-2 rounded-full bg-accent-magenta animate-pulse" />
            Editing {contact.full_name}
          </div>
          <div className="flex gap-3">
            <button className="btn-ghost" onClick={() => setEditMode(false)} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving || !editForm.full_name.trim()}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {!editMode && (
        <TopBar title={contact.full_name}
          breadcrumb={<div className="text-sm text-text-muted"><Link href="/contacts" className="hover:text-text-primary">Contacts</Link>{' / '}{contact.full_name}</div>}
          actions={
            <div className="flex gap-3">
              <button className="btn-secondary" onClick={handleEnrich} disabled={enriching}>
                {enriching ? 'Enriching...' : enriched ? 'Re-enrich' : 'Enrich Now'}
              </button>
              <button className="btn-secondary" onClick={enterEditMode}>Edit</button>
              <button className="btn-ghost text-semantic-error hover:bg-semantic-error/10" onClick={() => setDeleteOpen(true)}>Delete</button>
            </div>
          }
        />
      )}

      {/* ── IDENTITY BAR ── */}
      <div className="px-4 md:px-8 py-5 border-b border-border" style={{ background: 'rgba(17,17,20,0.6)' }}>
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-full bg-brand-gradient flex items-center justify-center text-white text-lg font-semibold shrink-0 shadow-lg shadow-accent-magenta/10">
            {(editMode ? editForm.full_name : contact.full_name).charAt(0) || '?'}
          </div>
          <div className="flex-1 min-w-0">
            {editMode ? (
              <>
                <input className="font-display text-2xl leading-tight bg-transparent border-b border-accent-magenta/30 focus:border-accent-magenta outline-none w-full text-text-primary pb-0.5"
                  value={editForm.full_name} onChange={e => setEditForm(f => ({ ...f, full_name: e.target.value }))} disabled={saving} placeholder="Full Name" />
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <input className="text-sm bg-transparent border-b border-white/10 focus:border-accent-magenta/30 outline-none text-text-secondary w-36"
                    value={editForm.job_title} onChange={e => setEditForm(f => ({ ...f, job_title: e.target.value }))} disabled={saving} placeholder="Job title" />
                  <span className="text-sm text-text-muted">at</span>
                  <div className="w-48">
                    <CompanySearchField companyId={editForm.company_id} companyName={editForm.company_name}
                      onChange={(cid, cn) => setEditForm(f => ({ ...f, company_id: cid, company_name: cn }))}
                      onCompanyCreated={n => setToast(`${n} added`)} disabled={saving} />
                  </div>
                </div>
                <div className="flex items-center gap-1 mt-1.5">
                  <MapPin size={11} className="text-text-muted" />
                  <input className="text-xs bg-transparent border-b border-white/10 focus:border-accent-magenta/30 outline-none text-text-muted w-40"
                    value={editForm.location} onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} disabled={saving} placeholder="Location" />
                </div>
                <div className="flex items-center gap-2 mt-2.5">
                  <select className="bg-bg-input border border-border rounded text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 text-text-secondary focus:border-accent-magenta outline-none"
                    value={editForm.contact_type} onChange={e => setEditForm(f => ({ ...f, contact_type: e.target.value }))} disabled={saving}>
                    {CONTACT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <TagPicker entityType="contact" entityId={id} tags={tags} onTagsChange={setTags} />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <h1 className="font-display text-2xl leading-tight">{contact.full_name}</h1>
                  <div className="flex items-center gap-1">
                    <SocialIcon url={contact.linkedin_url} Icon={Linkedin} color="#60A5FA" />
                    <SocialIcon url={contact.twitter_url} Icon={Twitter} color="#38BDF8" />
                  </div>
                </div>
                <div className="text-sm text-text-secondary mt-0.5">
                  {contact.job_title || 'No title'}
                  {contact.company_name && <>
                    {' at '}
                    {contact.company_id
                      ? <Link href={`/companies/${contact.company_id}`} className="text-accent-magenta hover:underline">{contact.company_name}</Link>
                      : <span className="text-text-secondary">{contact.company_name}</span>
                    }
                  </>}
                </div>
                {contact.location && (
                  <div className="text-xs text-text-muted mt-1 flex items-center gap-1"><MapPin size={11} />{contact.location}</div>
                )}
                <div className="flex items-center gap-1.5 mt-2.5">
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider font-accent"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                    {contact.contact_type?.replace(/_/g, ' ')}
                  </span>
                  <TagPicker entityType="contact" entityId={id} tags={tags} onTagsChange={setTags} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── RELATIONSHIP PULSE ── */}
      <div className="border-b border-border">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {/* 1: Status */}
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04] relative">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Status</div>
            <button onClick={() => setStatusOpen(!statusOpen)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold font-accent transition-all hover:scale-[1.03]"
              style={{ background: es.bg, border: `1px solid ${es.border}`, color: es.text }}>
              <span className="w-2 h-2 rounded-full" style={{ background: es.dot }} />
              {es.label}
              <ChevronDown size={11} />
            </button>
            <div className="text-[9px] text-text-muted mt-1.5">
              {contact.engagement_status_manual ? 'Manually set' : 'Based on recency & frequency'}
            </div>
            {statusOpen && <>
              <div className="fixed inset-0 z-40" onClick={() => setStatusOpen(false)} />
              <div className="absolute top-full left-4 mt-1 z-50 rounded-xl shadow-2xl py-1.5 min-w-[150px]"
                style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}>
                {ENGAGEMENT_STATUSES.map(s => (
                  <button key={s.value} onClick={() => handleStatusChange(s.value)}
                    className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors"
                    style={{ color: s.text }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <span className="w-2 h-2 rounded-full" style={{ background: s.dot }} />
                    {s.label}
                  </button>
                ))}
              </div>
            </>}
          </div>

          {/* 2: Last Contact */}
          <MetricCell label="Last Contact"
            value={contact.last_contact_date ? fmtRel(contact.last_contact_date) : '—'}
            sub={contact.last_contact_date ? new Date(contact.last_contact_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
            icon={<Mail size={12} className="text-text-muted" />} />

          {/* 3: Interactions */}
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Interactions</div>
            <div className="flex items-end gap-2">
              <span className="text-2xl font-semibold tabular-nums font-accent">{contact.total_interactions || 0}</span>
              {weeklyInteractions.length >= 4 && <MiniSparkline data={weeklyInteractions} />}
            </div>
            <div className="flex items-center gap-1 mt-1">
              {weeklyInteractions.length >= 4 ? (
                <SparklineTrendLabel data={weeklyInteractions} />
              ) : firstInteractionDate ? (
                <span className="text-[9px] text-text-muted">since {new Date(firstInteractionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              ) : (
                <span className="text-[9px] text-text-muted">No interactions yet</span>
              )}
            </div>
          </div>

          {/* 4: Meetings */}
          <MetricCell label="Meetings (30d)"
            value={contact.meetings_last_30d || 0}
            sub={contact.meetings_last_30d > 0 ? `${contact.meetings_last_30d} scheduled` : 'None'}
            icon={<Calendar size={12} className="text-text-muted" />} />

          {/* 5: Email Velocity */}
          <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Email Velocity</div>
            <div className="flex items-end gap-2">
              <span className="text-2xl font-semibold tabular-nums font-accent">{emailVel.toFixed(1)}</span>
              <span className="text-[10px] text-text-muted mb-1">/wk</span>
            </div>
            <div className="mt-1.5">
              <VelocityBar value={emailVel} max={5} />
            </div>
          </div>

          {/* 6: Owner */}
          <div className="px-5 py-4">
            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Owner</div>
            {contact.owner_name ? (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[10px] font-semibold shadow-md shadow-accent-purple/10">
                  {contact.owner_name.charAt(0)}
                </div>
                <div>
                  <div className="text-xs text-text-primary font-medium leading-tight">{contact.owner_name}</div>
                  {contact.owner_email && (
                    <div className="text-[9px] text-text-muted leading-tight">{contact.owner_email}</div>
                  )}
                  <div className="text-[9px] text-text-muted leading-tight">
                    <Tip text="Most active team member with this contact">Relationship owner</Tip>
                  </div>
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

      {/* ── TABS ── */}
      <div className="px-4 md:px-8 border-b border-border flex gap-0 overflow-x-auto">
        {(['overview', 'timeline', 'associations', 'documents', 'deals'] as Tab[]).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-5 py-3 text-sm capitalize transition-colors relative ${
              activeTab === t ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}>
            {t}
            {activeTab === t && <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-brand-gradient" />}
          </button>
        ))}
      </div>

      {/* ── TAB CONTENT ── */}
      <div className="p-4 md:p-6 lg:p-8">
        {activeTab === 'overview' && (
          <div className="space-y-5">
            {/* Q12 — synthetic observations from LLM extraction over
                conversations the user can read. Self-contained: hides
                itself when there's nothing to show. */}
            <RecentObservations
              entityType="contact"
              entityId={id}
              observationsOverride={isDemoContact ? demoRecentObservationsForContact : undefined}
            />
            {/* Pending Suggestions Banner */}
            {pendingUpdates.length > 0 && !editMode && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.04)' }}>
                <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid rgba(245,158,11,0.12)' }}>
                  <div className="flex items-center gap-2">
                    <Sparkles size={14} className="text-amber-400" />
                    <span className="text-sm font-medium text-text-primary">
                      {pendingUpdates.length} suggested update{pendingUpdates.length !== 1 ? 's' : ''} from recent activity
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={handleApproveAll}
                      className="px-3 py-1 rounded-lg text-[11px] font-medium transition-colors"
                      style={{ background: 'rgba(34,197,94,0.12)', color: '#4ADE80' }}>
                      Approve All
                    </button>
                    <button onClick={handleRejectAll}
                      className="px-3 py-1 rounded-lg text-[11px] font-medium text-text-muted hover:text-text-secondary transition-colors"
                      style={{ background: 'rgba(255,255,255,0.04)' }}>
                      Dismiss All
                    </button>
                  </div>
                </div>
                <div className="divide-y divide-white/[0.04]">
                  {pendingUpdates.map((u: any) => {
                    const proposed = cleanValue(u.proposed_value);
                    const current = u.current_value ? cleanValue(u.current_value) : null;
                    const isUrl = u.field_name?.includes('url');
                    return (
                      <div key={u.id} className="flex items-center gap-4 px-5 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">{humanField(u.field_name)}</span>
                            {current ? (
                              <span className="text-xs text-text-muted line-through truncate max-w-[160px]">{shortUrl(current)}</span>
                            ) : (
                              <span className="text-[10px] text-text-muted/50 italic">empty</span>
                            )}
                            <span className="text-xs text-text-muted">&rarr;</span>
                            {isUrl ? (
                              <a href={proposed} target="_blank" rel="noopener" className="text-sm text-accent-magenta hover:underline font-medium truncate max-w-[240px]">{shortUrl(proposed)}</a>
                            ) : (
                              <span className="text-sm text-text-primary font-medium">{proposed}</span>
                            )}
                          </div>
                          <div className="text-[10px] text-text-muted mt-0.5">{u.source_description} &middot; confidence {Math.round((u.confidence || 0) * 100)}%</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button onClick={() => handleApproveSuggestion(u.id, u.field_name)} disabled={approvingIds.has(u.id)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-green-500/20"
                            style={{ background: 'rgba(34,197,94,0.1)' }} title="Approve">
                            <Check size={14} className="text-green-400" />
                          </button>
                          <button onClick={() => handleRejectSuggestion(u.id)} disabled={approvingIds.has(u.id)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-red-500/20"
                            style={{ background: 'rgba(255,255,255,0.04)' }} title="Dismiss">
                            <XIcon size={14} className="text-text-muted" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* ═══ LEFT COLUMN ═══ */}
            <div className="lg:col-span-7 space-y-5">

              {/* CARD 1: Intel Brief — NOT editable, show Re-enrich */}
              {bio && (
                <GlassCard accent>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">Intel Brief</span>
                    <div className="flex items-center gap-3">
                      {enrichmentMeta?.enrichment_last_run && (
                        <span className="text-[10px] text-text-muted">
                          Enriched {fmtRel(enrichmentMeta.enrichment_last_run)}
                        </span>
                      )}
                      <button onClick={handleEnrich} disabled={enriching}
                        className="text-[10px] text-accent-magenta hover:text-accent-purple transition-colors disabled:opacity-40 flex items-center gap-1">
                        <RefreshCw size={10} className={enriching ? 'animate-spin' : ''} />
                        {enriching ? 'Enriching...' : 'Re-enrich'}
                      </button>
                    </div>
                  </div>
                  <div className="relative">
                    <div className="text-sm text-text-secondary leading-relaxed space-y-3 overflow-hidden transition-all duration-500"
                      style={{ maxHeight: bioExpanded ? `${bioParas.length * 120}px` : '120px' }}>
                      {bioParas.map((p: string, i: number) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
                    </div>
                    {!bioExpanded && bioParas.length > 2 && (
                      <div className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none"
                        style={{ background: 'linear-gradient(to top, rgba(17,17,20,0.95), transparent)' }} />
                    )}
                  </div>
                  {bioParas.length > 2 && (
                    <button onClick={() => setBioExpanded(!bioExpanded)}
                      className="flex items-center gap-1 text-xs text-accent-magenta hover:text-accent-purple mt-3 transition-colors">
                      {bioExpanded ? <><ChevronUp size={13} />Show less</> : <><ChevronDown size={13} />Read more</>}
                    </button>
                  )}
                </GlassCard>
              )}

              {/* CARD 2: Key Signals */}
              {!editMode && (() => {
                const deduped = signals.reduce((acc: any[], s: any) => {
                  const key = `${s.field_name}:${s.proposed_value}`;
                  if (!acc.find((x: any) => `${x.field_name}:${x.proposed_value}` === key)) acc.push(s);
                  return acc;
                }, []);
                const hasEnrichment = enrichmentMeta?.enrichment_last_run;
                if (deduped.length === 0 && !hasEnrichment) return null;
                return (
                  <GlassCard>
                    <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">Intelligence</div>
                    {hasEnrichment && (
                      <div className="flex items-center gap-2 py-2 px-3 -mx-3 rounded-lg mb-1" style={{ background: 'rgba(139,92,246,0.06)' }}>
                        <RefreshCw size={13} className="text-accent-purple shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs text-text-secondary">
                            Enrichment ran {fmtRel(enrichmentMeta.enrichment_last_run)}
                            {enrichmentMeta.contributions ? ` · ${enrichmentMeta.contributions} fields updated` : ''}
                          </span>
                        </div>
                      </div>
                    )}
                    {deduped.length > 0 && (
                      <div className="space-y-1">
                        {deduped.slice(0, 5).map((s: any, i: number) => (
                          <div key={i} className="flex items-center gap-3 py-2 px-3 -mx-3 rounded-lg transition-colors hover:bg-white/[0.02]">
                            <SignalDot confidence={s.confidence} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-text-secondary truncate block">
                                {humanField(s.field_name)}: {sigVal(s.proposed_value)}
                              </span>
                            </div>
                            <span className="text-[10px] text-text-muted shrink-0">{fmtRel(s.created_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {deduped.length === 0 && (
                      <div className="text-xs text-text-muted py-1">No intelligence gathered yet</div>
                    )}
                    {deduped.length > 5 && (
                      <button onClick={() => setActiveTab('timeline')}
                        className="flex items-center gap-1 text-xs text-accent-magenta hover:text-accent-purple mt-3 transition-colors">
                        View all <ArrowRight size={12} />
                      </button>
                    )}
                  </GlassCard>
                );
              })()}

              {/* CARD 3: Topics & Interests */}
              {!editMode && topics.length > 0 && (
                <GlassCard>
                  <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">Topics & Interests</div>
                  <div className="flex flex-wrap gap-1.5">
                    {topics.map((t: string, i: number) => (
                      <Link key={i} href={`/contacts?keyword=${encodeURIComponent(t)}`}
                        className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-all hover:scale-[1.04] cursor-pointer"
                        style={{ background: 'rgba(217,70,168,0.08)', color: '#D946A8', border: '1px solid rgba(217,70,168,0.15)' }}>
                        {t}
                      </Link>
                    ))}
                  </div>
                </GlassCard>
              )}
            </div>

            {/* ═══ RIGHT COLUMN ═══ */}
            <div className="lg:col-span-5 space-y-5">

              {/* CARD 4: Contact Details */}
              <GlassCard>
                <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">Contact Details</div>
                {editMode ? (
                  <div className="space-y-3">
                    <EF label="Email" type="email" v={editForm.email} set={v => setEditForm(f => ({ ...f, email: v }))} d={saving} />
                    <EF label="Phone" type="tel" v={editForm.phone} set={v => setEditForm(f => ({ ...f, phone: v }))} d={saving} />
                    <EF label="LinkedIn URL" type="url" v={editForm.linkedin_url} set={v => setEditForm(f => ({ ...f, linkedin_url: v }))} d={saving} />
                    <EF label="Twitter URL" type="url" v={editForm.twitter_url} set={v => setEditForm(f => ({ ...f, twitter_url: v }))} d={saving} />
                    <EF label="Introduced Via" v={editForm.introduced_via} set={v => setEditForm(f => ({ ...f, introduced_via: v }))} d={saving} />
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    <DRow icon={<Mail size={13} />} value={contact.email} href={contact.email ? `mailto:${contact.email}` : undefined} />
                    <DRow icon={<Phone size={13} />} value={contact.phone} href={contact.phone ? `tel:${contact.phone}` : undefined} />
                    <DRow icon={<Linkedin size={13} />} value={contact.linkedin_url ? 'View Profile' : null} href={contact.linkedin_url} ext />
                    <DRow icon={<Twitter size={13} />} value={contact.twitter_url ? 'View Profile' : null} href={contact.twitter_url} ext />
                    <DRow icon={<MapPin size={13} />} value={contact.location} />
                    <DRow icon={<Users size={13} />} value={contact.introduced_via} />
                  </div>
                )}
              </GlassCard>

              {/* CARD 5: Investment Profile — only if Investor/LP tagged or has data */}
              {showInvestmentCard && (
                <GlassCard>
                  <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3 flex items-center gap-1.5">
                    <Briefcase size={11} /> Investment Profile
                  </div>
                  {editMode ? (
                    <div className="space-y-3">
                      <EF label="Investment Focus" v={editForm.investment_focus} set={v => setEditForm(f => ({ ...f, investment_focus: v }))} d={saving} />
                      <EF label="Check Size" v={editForm.check_size_range} set={v => setEditForm(f => ({ ...f, check_size_range: v }))} d={saving} />
                      <EF label="Fund Name" v={editForm.fund_name} set={v => setEditForm(f => ({ ...f, fund_name: v }))} d={saving} />
                      <EF label="Commitment Status" v={editForm.commitment_status} set={v => setEditForm(f => ({ ...f, commitment_status: v }))} d={saving} />
                    </div>
                  ) : (
                    <div className="space-y-2.5 text-sm">
                      {contact.investment_focus && <KV k="Focus" v={contact.investment_focus} />}
                      {contact.check_size_range && (
                        <div className="flex items-center gap-1.5">
                          <DollarSign size={11} className="text-text-muted" />
                          <span className="text-text-secondary">{contact.check_size_range}</span>
                        </div>
                      )}
                      {contact.fund_name && <KV k="Fund" v={contact.fund_name} />}
                      {contact.commitment_status && (
                        <div className="flex items-center gap-2">
                          <span className="text-text-muted text-xs">Status</span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold capitalize"
                            style={{ background: 'rgba(34,197,94,0.12)', color: '#4ADE80', border: '1px solid rgba(34,197,94,0.2)' }}>
                            {contact.commitment_status}
                          </span>
                        </div>
                      )}
                      {!hasInvestment && (
                        <div className="text-xs text-text-muted italic">No investment data yet — click Edit to add</div>
                      )}
                    </div>
                  )}
                </GlassCard>
              )}

              {/* CARD 6: Mutual Connections */}
              {!editMode && associations.length > 0 && (
                <GlassCard>
                  <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">In Common</div>
                  <div className="flex flex-wrap gap-2">
                    {associations.slice(0, 6).map((a: any, i: number) => {
                      const oid = a.contact_id_a === id ? a.contact_id_b : a.contact_id_a;
                      const name = a.other_name || oid.slice(0, 8);
                      return (
                        <Link key={i} href={`/contacts/${oid}`}
                          className="flex flex-col items-center gap-1 p-2 rounded-lg transition-all hover:bg-white/[0.03] hover:scale-[1.04] group w-16">
                          <div className="w-8 h-8 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[11px] font-semibold shadow-sm">
                            {name.charAt(0)}
                          </div>
                          <span className="text-[10px] text-text-muted group-hover:text-text-secondary text-center leading-tight truncate w-full">
                            {name.split(' ')[0]}
                          </span>
                        </Link>
                      );
                    })}
                    {associations.length > 6 && (
                      <div className="flex flex-col items-center justify-center p-2 w-16">
                        <div className="w-8 h-8 rounded-full border border-dashed border-white/10 flex items-center justify-center text-[10px] text-text-muted">
                          +{associations.length - 6}
                        </div>
                      </div>
                    )}
                  </div>
                </GlassCard>
              )}

              {/* CARD 7: Source & Confidence */}
              {!editMode && (
                <GlassCard>
                  <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">Source & Confidence</div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider capitalize font-accent"
                      style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                      {contact.source}
                    </span>
                    <span className="text-sm font-semibold tabular-nums font-accent" style={{ color: confColor(confidence) }}>
                      {(confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <ConfBar value={confidence} />
                  {contact.communication_channel_preference && (
                    <div className="text-[10px] text-text-muted mt-2.5">
                      Preferred channel: <span className="text-text-secondary capitalize">{contact.communication_channel_preference}</span>
                    </div>
                  )}
                </GlassCard>
              )}
            </div>
          </div>
          </div>
        )}

        {activeTab === 'timeline' && <Timeline entries={timeline} />}
        {activeTab === 'associations' && (
          <div className="space-y-2">
            {entityAssociations.length === 0
              ? <div className="text-center text-text-muted py-12">No associations discovered yet</div>
              : <>
                  {entityAssociations.filter((a: any) => a.strength >= 60).length > 0 && (
                    <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2 mt-4">Strong Associations</div>
                  )}
                  {entityAssociations.filter((a: any) => a.strength >= 60).map((a: any, i: number) => (
                    <AssociationRow key={`s-${i}`} a={a} />
                  ))}
                  {entityAssociations.filter((a: any) => a.strength >= 30 && a.strength < 60).length > 0 && (
                    <>
                      <div className="border-t border-white/[0.04] my-4" />
                      <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Moderate Associations</div>
                    </>
                  )}
                  {entityAssociations.filter((a: any) => a.strength >= 30 && a.strength < 60).map((a: any, i: number) => (
                    <AssociationRow key={`m-${i}`} a={a} />
                  ))}
                  {entityAssociations.filter((a: any) => a.strength < 30).length > 0 && (
                    <>
                      <div className="border-t border-white/[0.04] my-4" />
                      <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">Weak Associations</div>
                    </>
                  )}
                  {entityAssociations.filter((a: any) => a.strength < 30).map((a: any, i: number) => (
                    <AssociationRow key={`w-${i}`} a={a} />
                  ))}
                </>
            }
          </div>
        )}
        {activeTab === 'documents' && (
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
                <div className="px-4 py-2.5 rounded-lg bg-bg-elevated border border-border shadow-xl flex items-center gap-2.5">
                  <Upload size={18} className="text-accent-magenta" />
                  <span className="text-sm font-medium text-text-primary">Drop to attach to this contact</span>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between mb-5">
              <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">
                Documents ({documents.length})
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={uploadVisibility}
                  onChange={e => setUploadVisibility(e.target.value as 'private' | 'org_wide')}
                  disabled={uploading}
                  className="bg-bg-inset border border-border text-text-secondary text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-50"
                  title="Who can read this document"
                >
                  <option value="private">Private — only you</option>
                  <option value="org_wide">Org-wide — everyone in your team</option>
                </select>
                <label className={`btn-secondary flex items-center gap-2 cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  <Upload size={14} />
                  {uploading ? 'Uploading...' : 'Upload'}
                  <input ref={fileInputRef} type="file" className="hidden" onChange={handleDocUpload} disabled={uploading} />
                </label>
              </div>
            </div>
            {docsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-16 bg-bg-surface animate-pulse rounded-xl" />
                ))}
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-12">
                <FileText size={32} className="mx-auto text-text-muted/30 mb-3" />
                <div className="text-text-muted text-sm">No documents linked to this contact</div>
                <div className="text-text-muted/60 text-xs mt-1">Upload a document or email attachments will appear here automatically</div>
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc: any) => {
                  const canPreviewDoc = Boolean(
                    doc.r2_key ||
                    (typeof doc.extracted_text_preview === 'string' && doc.extracted_text_preview.trim().length > 0)
                  );
                  return (
                  <div key={doc.id}
                    onClick={() => {
                      if (canPreviewDoc) setPreviewDocId(doc.id);
                      else setToast('Preview is unavailable for this document');
                    }}
                    className="flex items-center gap-4 rounded-xl p-4 transition-all hover:bg-white/[0.05] cursor-pointer"
                    style={{ background: 'rgba(17,17,20,0.5)', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: doc.source === 'email_attachment' ? 'rgba(59,130,246,0.12)' : 'rgba(139,92,246,0.12)' }}>
                      {doc.source === 'email_attachment'
                        ? <Paperclip size={16} className="text-blue-400" />
                        : <FileText size={16} className="text-purple-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">{doc.title || doc.file_name}</span>
                        {doc.version_number > 1 && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                            style={{ background: 'rgba(245,158,11,0.12)', color: '#FBBF24' }}>
                            v{doc.version_number}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                          style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                          {(doc.document_type || 'other').replace(/_/g, ' ')}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                          style={{
                            background: doc.source === 'email_attachment' ? 'rgba(59,130,246,0.08)' : 'rgba(139,92,246,0.08)',
                            color: doc.source === 'email_attachment' ? '#93C5FD' : '#C084FC',
                          }}>
                          {doc.source === 'email_attachment' ? 'email' : doc.source}
                        </span>
                        {doc.file_size && (
                          <span className="text-[10px] text-text-muted">{fmtSize(doc.file_size)}</span>
                        )}
                        <span className="text-[10px] text-text-muted">{fmtRel(doc.created_at)}</span>
                        {doc.processing_status && doc.processing_status !== 'completed' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                            style={{
                              background: doc.processing_status === 'failed' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)',
                              color: doc.processing_status === 'failed' ? '#F87171' : '#FBBF24',
                            }}>
                            {doc.processing_status}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <DocumentActions
                        doc={doc}
                        variant="compact"
                        onPreview={documentId => setPreviewDocId(documentId)}
                        onError={setToast}
                      />
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          void handleDocDelete(doc.id);
                        }}
                        className="p-2 rounded-lg text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors"
                        title="Delete document"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {activeTab === 'deals' && <div className="text-center text-text-muted py-12">No deals linked</div>}
      </div>

      <DocumentUploadModal
        open={docUploadOpen}
        onClose={() => { setDocUploadOpen(false); setDocUploadFiles([]); }}
        onUploaded={() => { setRefreshKey(k => k + 1); setToast('Documents uploaded'); }}
        initialFiles={docUploadFiles}
        contactId={id}
      />

      <DocumentPreviewModal
        docId={previewDocId}
        onClose={() => setPreviewDocId(null)}
      />

      {/* Delete modal */}
      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => !deleting && setDeleteOpen(false)}>
          <div className="rounded-2xl w-full max-w-sm shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-2">Delete Contact</div>
            <div className="text-sm text-text-secondary mb-6">
              Delete <span className="font-medium text-text-primary">{contact.full_name}</span>? This cannot be undone.
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

export default function ContactDetailPage() {
  return <ContactDetailContent />;
}

/* ───────── Sub-components ───────── */

function GlassCard({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div className="relative rounded-xl p-5 transition-all duration-200 hover:border-white/[0.1]"
      style={{
        background: 'rgba(17,17,20,0.65)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.05)',
      }}>
      {accent && (
        <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
          style={{ background: 'linear-gradient(180deg, #D946A8, #8B5CF6)' }} />
      )}
      <div className={accent ? 'pl-3' : ''}>{children}</div>
    </div>
  );
}

function MetricCell({ label, value, sub, icon }: { label: string; value: React.ReactNode; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-r border-b lg:border-b-0 border-white/[0.04]">
      <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted mb-2">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-2xl font-semibold tabular-nums font-accent">{value}</span>
        {icon}
      </div>
      {sub && <div className="text-[9px] text-text-muted mt-1">{sub}</div>}
    </div>
  );
}

function getSparklineTrend(data: any[]): 'up' | 'down' | 'flat' {
  if (data.length < 2) return 'flat';
  const half = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, half).reduce((s: number, d: any) => s + (d.cnt || 0), 0) / half;
  const secondHalf = data.slice(half).reduce((s: number, d: any) => s + (d.cnt || 0), 0) / (data.length - half);
  if (secondHalf > firstHalf * 1.2) return 'up';
  if (secondHalf < firstHalf * 0.8) return 'down';
  return 'flat';
}

function MiniSparkline({ data }: { data: any[] }) {
  const counts = data.map((d: any) => d.cnt || 0);
  const max = Math.max(...counts, 1);
  const w = 48;
  const h = 20;
  const pad = 2;
  const points = counts.map((v: number, i: number) => {
    const x = pad + (i / (counts.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v / max) * (h - pad * 2));
    return `${x},${y}`;
  });
  const path = `M${points.join(' L')}`;
  const trend = getSparklineTrend(data);
  const color = trend === 'up' ? '#22C55E' : trend === 'down' ? '#F97316' : '#71717A';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="mb-1">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparklineTrendLabel({ data }: { data: any[] }) {
  const trend = getSparklineTrend(data);
  if (trend === 'up') return (
    <span className="flex items-center gap-1">
      <TrendingUp size={11} className="text-green-400" />
      <span className="text-[9px] text-green-400/70">trending up</span>
    </span>
  );
  if (trend === 'down') return (
    <span className="flex items-center gap-1">
      <TrendingDown size={11} className="text-orange-400" />
      <span className="text-[9px] text-orange-400/70">trending down</span>
    </span>
  );
  return (
    <span className="flex items-center gap-1">
      <Minus size={11} className="text-text-muted" />
      <span className="text-[9px] text-text-muted">steady</span>
    </span>
  );
}

function VelocityBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  const color = pct > 60 ? '#22C55E' : pct > 30 ? '#F59E0B' : '#71717A';
  return (
    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function ConfBar({ value }: { value: number }) {
  const pct = Math.min(100, value * 100);
  return (
    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: confColor(value) }} />
    </div>
  );
}

function SignalDot({ confidence }: { confidence: number }) {
  const c = confidence >= 0.85 ? '#22C55E' : confidence >= 0.7 ? '#F59E0B' : '#EF4444';
  return <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c }} />;
}

function SocialIcon({ url, Icon, color }: { url: string | null; Icon: any; color: string }) {
  if (url) return (
    <a href={url} target="_blank" rel="noopener" className="transition-all hover:scale-110" style={{ color }}>
      <Icon size={16} />
    </a>
  );
  return <Icon size={16} style={{ color: 'rgba(113,113,122,0.3)' }} />;
}

function DRow({ icon, value, href, ext }: { icon: React.ReactNode; value: string | null | undefined; href?: string; ext?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2.5 py-2 -mx-2 px-2 rounded-lg transition-colors hover:bg-white/[0.02]">
      <span className="text-text-muted shrink-0">{icon}</span>
      {href ? (
        <a href={href} target={ext ? '_blank' : undefined} rel={ext ? 'noopener' : undefined}
          className="text-sm text-accent-magenta hover:text-accent-purple transition-colors flex items-center gap-1 truncate">
          {value}{ext && <ExternalLink size={10} />}
        </a>
      ) : <span className="text-sm text-text-secondary truncate">{value}</span>}
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

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const [s, setS] = React.useState(false);
  return (
    <span className="relative inline-flex items-center gap-0.5 cursor-help" onMouseEnter={() => setS(true)} onMouseLeave={() => setS(false)}>
      {children}
      <Info size={9} className="text-text-muted" />
      {s && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 px-3 py-2 text-[10px] text-text-primary rounded-lg shadow-xl z-50"
          style={{ background: '#222228', border: '1px solid rgba(255,255,255,0.1)' }}>
          {text}
        </span>
      )}
    </span>
  );
}

const TYPE_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  same_company: { bg: 'rgba(34,197,94,0.12)', text: '#4ADE80' },
  deal_involvement: { bg: 'rgba(168,85,247,0.12)', text: '#C084FC' },
  co_meeting: { bg: 'rgba(59,130,246,0.12)', text: '#60A5FA' },
  co_email: { bg: 'rgba(59,130,246,0.08)', text: '#93C5FD' },
  direct_email: { bg: 'rgba(217,70,168,0.12)', text: '#D946A8' },
  same_sector: { bg: 'rgba(245,158,11,0.12)', text: '#FBBF24' },
  shared_interests: { bg: 'rgba(168,85,247,0.08)', text: '#A78BFA' },
  investment_aligned: { bg: 'rgba(34,197,94,0.08)', text: '#86EFAC' },
  mentioned_together: { bg: 'rgba(113,113,122,0.12)', text: '#A1A1AA' },
  introduced_by: { bg: 'rgba(217,70,168,0.08)', text: '#F0ABFC' },
};

function AssociationRow({ a }: { a: any }) {
  const href = a.other_type === 'contact' ? `/contacts/${a.other_id}`
    : a.other_type === 'company' ? `/companies/${a.other_id}`
    : `/deals/${a.other_id}`;
  const icon = a.other_type === 'company' ? <Briefcase size={14} />
    : a.other_type === 'deal' ? <Target size={14} />
    : <Users size={14} />;
  const strengthColor = a.strength >= 60 ? '#22C55E' : a.strength >= 30 ? '#F59E0B' : '#71717A';
  const types: string[] = a.association_types || [a.association_type];

  return (
    <Link href={href}
      className="flex items-center gap-4 rounded-xl p-4 transition-all hover:bg-white/[0.03] group"
      style={{ background: 'rgba(17,17,20,0.5)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="w-9 h-9 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xs font-semibold shrink-0 shadow-sm">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-text-primary group-hover:text-accent-magenta transition-colors truncate">
            {a.entity_name || a.other_id?.slice(0, 8)}
          </span>
          {types.map((t: string) => {
            const c = TYPE_BADGE_COLORS[t] || { bg: 'rgba(113,113,122,0.12)', text: '#A1A1AA' };
            return (
              <span key={t} className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider shrink-0"
                style={{ background: c.bg, color: c.text }}>
                {(t || '').replace(/_/g, ' ')}
              </span>
            );
          })}
        </div>
        <div className="text-xs text-text-muted mt-0.5 truncate">{a.reason}</div>
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <span className="text-xs font-semibold tabular-nums" style={{ color: strengthColor }}>{a.strength}</span>
        <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${a.strength}%`, background: strengthColor }} />
        </div>
      </div>
    </Link>
  );
}

/* ───────── Utilities ───────── */


function confColor(v: number): string {
  if (v >= 0.8) return '#22C55E';
  if (v >= 0.5) return '#F59E0B';
  return '#EF4444';
}

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

function jsonArr(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p.filter((s: any) => typeof s === 'string' && s) : []; }
  catch { return []; }
}

function humanField(f: string): string {
  return f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sigVal(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && v.value !== undefined) {
      const s = String(v.value);
      return s.length > 60 ? s.slice(0, 60) + '...' : s;
    }
    const s = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '...' : s;
  } catch { return raw?.length > 60 ? raw.slice(0, 60) + '...' : (raw || ''); }
}

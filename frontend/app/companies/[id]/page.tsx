'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Users, Briefcase, Target, MapPin, Globe,
  ChevronDown, ChevronUp, ExternalLink, RefreshCw,
  Upload, FileText, Paperclip, Trash2,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { TagPicker } from '@/components/tag-picker';
import { DocumentActions } from '@/components/document-actions';
import { api } from '@/lib/api';
import { initialFromName, faviconUrl } from '@/lib/avatar';
import { cleanIntelBrief } from '@/lib/intelligence-briefing';
import {
  demoCompanyDetailFixture,
  demoToastMessage,
} from '@/lib/demo-mode';

const DocumentUploadModal = dynamic(
  () => import('@/components/document-upload-modal').then(mod => mod.DocumentUploadModal),
  { ssr: false },
);

const DocumentPreviewModal = dynamic(
  () => import('@/components/document-preview-modal').then(mod => mod.DocumentPreviewModal),
  { ssr: false },
);

const STAGE_OPTIONS = [
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' },
  { value: 'series_c', label: 'Series C' },
  { value: 'growth', label: 'Growth' },
  { value: 'public', label: 'Public' },
  { value: 'unknown', label: 'Unknown' },
];

const COMPANY_TYPE_OPTIONS = [
  { value: 'startup', label: 'Startup' },
  { value: 'fund', label: 'Fund' },
  { value: 'corporation', label: 'Corporation' },
  { value: 'government', label: 'Government' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
];

const INVESTMENT_STATUS_OPTIONS = [
  { value: 'tracking', label: 'Tracking' },
  { value: 'in_diligence', label: 'In Diligence' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'passed', label: 'Passed' },
  { value: 'exited', label: 'Exited' },
  { value: 'none', label: 'None' },
];

function sortCompanyNewsArticles(articles: any[] | undefined): any[] {
  return [...(articles || [])].sort((a, b) => {
    const aDirect = a?.relevance_tag === 'direct_mention';
    const bDirect = b?.relevance_tag === 'direct_mention';
    if (aDirect !== bDirect) return aDirect ? -1 : 1;
    const aTime = Date.parse(a?.published_at || '');
    const bTime = Date.parse(b?.published_at || '');
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}

function parseCustomFields(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

interface EditFormData {
  name: string;
  description: string;
  sector: string;
  stage: string;
  company_type: string;
  investment_status: string;
  website: string;
  location: string;
  domain: string;
}

export default function CompanyDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const isDemoCompany = id.startsWith('demo-company');
  const [data, setData] = React.useState<any>(null);
  const [tags, setTags] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [enriching, setEnriching] = React.useState(false);
  const [enriched, setEnriched] = React.useState(false);
  const [fullBio, setFullBio] = React.useState<string | null>(null);
  const [enrichmentMeta, setEnrichmentMeta] = React.useState<any>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [companyAssociations, setCompanyAssociations] = React.useState<any[]>([]);
  const [editMode, setEditMode] = React.useState(false);
  const [editForm, setEditForm] = React.useState<EditFormData>({
    name: '', description: '', sector: '', stage: '', company_type: '',
    investment_status: '', website: '', location: '', domain: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [newsExpanded, setNewsExpanded] = React.useState(false);
  const [documentsExpanded, setDocumentsExpanded] = React.useState(false);
  const [associationsExpanded, setAssociationsExpanded] = React.useState(false);

  // Documents block — same pattern as contacts/[id]/page.tsx Documents tab
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
  // Wave 5 Phase G — preview modal state
  const [previewDocId, setPreviewDocId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (isDemoCompany) {
      const fixture = demoCompanyDetailFixture;
      setData(fixture.data);
      setTags(fixture.tags || []);
      setFullBio(fixture.full_bio);
      setEnrichmentMeta(fixture.enrichment_meta);
      setCompanyAssociations(fixture.associations || []);
      setDocuments(fixture.documents || []);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.getCompany(id),
      api.getCompanyEnrichment(id).catch(() => null),
      api.getCompanyAssociations(id).catch(() => ({ associations: [] })),
    ])
      .then(([c, e, ea]) => {
        setData(c);
        setTags(c.tags || []);
        setFullBio(e?.full_bio ?? null);
        setEnrichmentMeta(e);
        setCompanyAssociations(ea.associations || []);
      })
      .finally(() => setLoading(false));
  }, [id, refreshKey, isDemoCompany]);

  React.useEffect(() => {
    if (isDemoCompany) {
      setDocuments(demoCompanyDetailFixture.documents || []);
      setDocsLoading(false);
      return;
    }
    setDocsLoading(true);
    api.listDocuments({ company_id: id }).then(r => setDocuments(r.documents || []))
      .catch(() => setDocuments([]))
      .finally(() => setDocsLoading(false));
  }, [id, refreshKey, isDemoCompany]);

  async function handleDocUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isDemoCompany) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      setToast(demoToastMessage('Document upload'));
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadDocument(file, { company_id: id, visibility: uploadVisibility });
      setToast(res.duplicate ? 'Duplicate document — already exists' : 'Document uploaded');
      setRefreshKey(k => k + 1);
    } catch (err: any) { setToast(`Upload failed: ${err.message}`); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function handleDocDelete(docId: string) {
    if (isDemoCompany) {
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

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function enterEditMode() {
    if (!data?.company) return;
    const c = data.company;
    setEditForm({
      name: c.name || '', description: c.description || '',
      sector: c.sector || '', stage: c.stage || '',
      company_type: c.company_type || '', investment_status: c.investment_status || '',
      website: c.website || '', location: c.location || '', domain: c.domain || '',
    });
    setEditMode(true);
  }

  async function handleSave() {
    if (!editForm.name.trim()) return;
    setSaving(true);
    try {
      if (isDemoCompany) {
        setData((current: any) => ({
          ...(current || {}),
          company: {
            ...(current?.company || {}),
            name: editForm.name.trim(),
            description: editForm.description.trim() || null,
            sector: editForm.sector.trim() || null,
            stage: editForm.stage || null,
            company_type: editForm.company_type || null,
            investment_status: editForm.investment_status || null,
            website: editForm.website.trim() || null,
            location: editForm.location.trim() || null,
            domain: editForm.domain.trim() || null,
          },
        }));
        setEditMode(false);
        setToast(demoToastMessage('Company edit'));
        return;
      }
      await api.updateCompany(id, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
        sector: editForm.sector.trim() || null,
        stage: editForm.stage || null,
        company_type: editForm.company_type || null,
        investment_status: editForm.investment_status || null,
        website: editForm.website.trim() || null,
        location: editForm.location.trim() || null,
        domain: editForm.domain.trim() || null,
      });
      setEditMode(false);
      setRefreshKey(k => k + 1);
      setToast('Company updated');
    } catch (e: any) { setToast(`Save failed: ${e.message || 'Unknown error'}`); }
    finally { setSaving(false); }
  }

  async function handleEnrich() {
    if (isDemoCompany) {
      setEnriching(true);
      window.setTimeout(() => {
        setEnriching(false);
        setEnriched(true);
        setToast(demoToastMessage('Enrichment'));
      }, 450);
      return;
    }
    const isProspectOrigin = (data?.prospect_signals || []).length > 0 ||
      (tags || []).some((tag: any) => String(tag.name || '').toLowerCase() === 'investment prospect');
    const hasDomainAnchor = Boolean(data?.company?.domain || data?.company?.website);
    if (isProspectOrigin && !hasDomainAnchor) {
      setToast('Limited information: enrichment is paused until a verified website/domain or additional corroborating evidence is available.');
      return;
    }
    setEnriching(true);
    try {
      await api.enrichCompany(id);
      setToast('Enrichment started — results will appear shortly');
      setTimeout(() => {
        setEnriching(false);
        setEnriched(true);
        setRefreshKey(k => k + 1);
      }, 5000);
    } catch (e: any) {
      setToast(`Enrichment failed: ${e.message || 'Unknown error'}`);
      setEnriching(false);
    }
  }

  async function handleDelete() {
    if (isDemoCompany) {
      router.push('/companies');
      return;
    }
    setDeleting(true);
    try {
      await api.deleteCompany(id);
      router.push('/companies');
    } catch (e: any) {
      alert(e.message || 'Delete failed');
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        Loading...
      </div>
    );
  }

  if (!data?.company) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="text-text-secondary">Company not found</div>
        <Link href="/companies" className="btn-secondary">
          Back to Companies
        </Link>
      </div>
    );
  }

  const company = data.company;
  const companyCustomFields = parseCustomFields(company.custom_fields);
  const prospectOrigin = companyCustomFields.prospect_origin || {};
  const limitedInfoProspect = Boolean(
    prospectOrigin.limited_info ||
    companyCustomFields.limited_info_prospect?.status === 'limited_info'
  );
  const bio = cleanIntelBrief(fullBio);
  const briefText = isSubstantiveText(bio) ? bio : '';
  const descriptionText = isSubstantiveText(company.description) ? normalizeLongText(company.description) : '';
  const overviewMode: 'brief' | 'description' | 'empty' = briefText
    ? 'brief'
    : descriptionText
      ? 'description'
      : 'empty';
  const overviewText = overviewMode === 'brief' ? briefText : overviewMode === 'description' ? descriptionText : '';
  const overviewBlocks = textBlocks(overviewText);
  const newsArticles = sortCompanyNewsArticles(data.news_articles);
  const prospectSignals = data.prospect_signals || [];
  const primaryProspectSignal = prospectSignals[0] || null;
  const isInvestmentProspect = prospectSignals.length > 0 ||
    company.investment_status === 'prospect' ||
    tags.some((tag: any) => String(tag.name || '').toLowerCase() === 'investment prospect');
  const hasDomainAnchor = Boolean(company.domain || company.website);
  const enrichmentBlocked = isInvestmentProspect && !hasDomainAnchor;
  const contactCount = data.contacts?.length || 0;
  const activeDealCount = (data.deals || []).filter((deal: any) =>
    !['closed_won', 'closed_lost', 'exited'].includes(String(deal.stage || '').toLowerCase())
  ).length;
  return (
    <div className="flex-1 overflow-auto">
      {/* ── Edit mode sticky bar ── */}
      {editMode && (
        <div className="sticky top-0 z-30 border-b px-4 md:px-8 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{ background: 'rgba(9,9,11,0.92)', backdropFilter: 'blur(16px)', borderColor: 'rgba(217,70,168,0.25)' }}>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-2 h-2 rounded-full bg-accent-magenta animate-pulse" />
            Editing {company.name}
          </div>
          <div className="flex gap-3">
            <button className="btn-ghost" onClick={() => setEditMode(false)} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving || !editForm.name.trim()}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {!editMode && (
        <TopBar
          title={company.name}
          actions={
            <div className="flex gap-3">
              <button
                className="btn-secondary"
                onClick={handleEnrich}
                disabled={enriching || enrichmentBlocked}
                title={enrichmentBlocked ? 'Limited information: enrichment is paused until a verified website/domain or additional corroborating evidence is available.' : undefined}
              >
                {enriching ? 'Enriching...' : enriched ? 'Re-enrich' : 'Enrich Now'}
              </button>
              <button className="btn-secondary" onClick={enterEditMode}>Edit</button>
              <button className="btn-ghost text-semantic-error hover:bg-semantic-error/10" onClick={() => setDeleteOpen(true)}>Delete</button>
            </div>
          }
        />
      )}

      {/* ── COMPANY IDENTITY ── */}
      <div className="border-b border-border bg-bg-root px-4 py-6 md:px-8">
        <div className="mx-auto max-w-[1440px]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <CompanyLogo
                name={editMode ? editForm.name : company.name}
                domain={company.domain || company.website}
                logoUrl={company.logo_url}
              />
              {editMode ? (
                <div className="mt-4 max-w-2xl space-y-3">
                  <input className="w-full bg-transparent pb-1 text-3xl font-semibold leading-tight text-text-primary outline-none border-b border-accent-magenta/40 focus:border-accent-magenta"
                    value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} disabled={saving} placeholder="Company Name" />
                  <div className="flex flex-wrap items-center gap-2">
                    <select className="bg-bg-input border border-border rounded text-xs px-2 py-1 text-text-secondary focus:border-accent-magenta outline-none"
                      value={editForm.sector} onChange={e => setEditForm(f => ({ ...f, sector: e.target.value }))} disabled={saving}>
                      <option value="">Sector...</option>
                      <option value="Technology">Technology</option>
                      <option value="Finance">Finance</option>
                      <option value="Healthcare">Healthcare</option>
                      <option value="Real Estate">Real Estate</option>
                      <option value="Energy">Energy</option>
                      <option value="Consumer">Consumer</option>
                      <option value="Education">Education</option>
                      <option value="Other">Other</option>
                    </select>
                    <select className="bg-bg-input border border-border rounded text-xs px-2 py-1 text-text-secondary focus:border-accent-magenta outline-none"
                      value={editForm.stage} onChange={e => setEditForm(f => ({ ...f, stage: e.target.value }))} disabled={saving}>
                      <option value="">Stage...</option>
                      {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="bg-bg-input border border-border rounded text-xs px-2 py-1 text-text-secondary focus:border-accent-magenta outline-none"
                      value={editForm.company_type} onChange={e => setEditForm(f => ({ ...f, company_type: e.target.value }))} disabled={saving}>
                      <option value="">Type...</option>
                      {COMPANY_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="bg-bg-input border border-border rounded text-xs px-2 py-1 text-text-secondary focus:border-accent-magenta outline-none"
                      value={editForm.investment_status} onChange={e => setEditForm(f => ({ ...f, investment_status: e.target.value }))} disabled={saving}>
                      <option value="">Inv. Status...</option>
                      {INVESTMENT_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <TagPicker entityType="company" entityId={id} tags={tags} onTagsChange={setTags} />
                  </div>
                </div>
              ) : (
                <>
                  <h1 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight text-text-primary md:text-4xl">
                    {company.name}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {activeDealCount > 0 && <IdentityTag tone="hot">{activeDealCount > 1 ? `${activeDealCount} active deals` : 'Active deal'}</IdentityTag>}
                    {company.investment_status && <IdentityTag tone="hot">{company.investment_status.replace(/_/g, ' ')}</IdentityTag>}
                    {company.company_type && <IdentityTag>{company.company_type.replace(/_/g, ' ')}</IdentityTag>}
                    {limitedInfoProspect && <IdentityTag tone="warning">Limited info</IdentityTag>}
                    {primaryProspectSignal && (
                      <IdentityTag tone="info">
                        {primaryProspectSignal.mention_type === 'known_deal' ? 'Known deal signal' : 'Inbound prospect'}
                      </IdentityTag>
                    )}
                    <TagPicker entityType="company" entityId={id} tags={tags} onTagsChange={setTags} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-secondary">
                    {(company.sector || company.stage) && (
                      <span>{company.sector || 'No sector'}{company.stage ? ` · ${company.stage.replace(/_/g, ' ')}` : ''}</span>
                    )}
                    {company.location && (
                      <span className="inline-flex items-center gap-1.5"><MapPin size={13} />{company.location}</span>
                    )}
                    {company.website && (
                      <a href={company.website} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-accent-magenta hover:text-accent-purple">
                        <Globe size={13} />Website
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
            {enrichmentBlocked && (
              <div className="max-w-md rounded-lg border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2 text-xs text-text-secondary">
                <span className="font-medium text-text-primary">Limited information.</span>{' '}
                Enrichment is paused until a verified website/domain or corroborating evidence is available.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 md:p-8">
        <div className="mx-auto max-w-[1440px] space-y-6">
          <section className="rounded-lg border border-border bg-[#0D0D10] p-5 shadow-2xl shadow-black/20 md:p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-text-muted">
                  {overviewMode === 'brief' ? 'Intelligence Briefing' : 'Company Description'}
                </div>
                {overviewMode === 'brief' && enrichmentMeta?.enrichment_last_run && (
                  <div className="mt-1 text-xs text-text-muted">Enriched {fmtRel(enrichmentMeta.enrichment_last_run)}</div>
                )}
              </div>
              {overviewMode === 'brief' && (
                <button onClick={handleEnrich} disabled={enriching || enrichmentBlocked}
                  title={enrichmentBlocked ? 'Limited information: enrichment is paused until a verified website/domain or additional corroborating evidence is available.' : undefined}
                  className="inline-flex items-center gap-1.5 self-start rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-hover hover:text-text-primary disabled:opacity-40 sm:self-auto">
                  <RefreshCw size={12} className={enriching ? 'animate-spin' : ''} />
                  {enriching ? 'Enriching...' : 'Re-enrich'}
                </button>
              )}
            </div>
            {editMode ? (
              <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
                <textarea className="min-h-40 w-full resize-none rounded-lg border border-border bg-bg-input px-4 py-3 text-sm leading-7 text-text-secondary outline-none focus:border-accent-magenta"
                  value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} disabled={saving}
                  placeholder="Company description..." />
                <div className="space-y-3">
                  <label className="block">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Website</div>
                    <input type="url" className="input w-full" value={editForm.website} onChange={e => setEditForm(f => ({ ...f, website: e.target.value }))} disabled={saving} />
                  </label>
                  <label className="block">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Domain</div>
                    <input type="text" className="input w-full" value={editForm.domain} onChange={e => setEditForm(f => ({ ...f, domain: e.target.value }))} disabled={saving} placeholder="example.com" />
                  </label>
                </div>
              </div>
            ) : overviewMode === 'empty' ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-text-muted">
                No intelligence brief or company description yet.
              </div>
            ) : (
              <div className="max-h-[360px] space-y-4 overflow-y-auto pr-2 text-[15px] leading-7 text-text-secondary">
                {overviewBlocks.map((block, i) => <PrettyTextBlock key={i} block={block} />)}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-bg-surface px-4 py-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-[0.16em] text-text-muted">
                Contacts <span className="ml-1 font-normal tabular-nums text-text-muted/70">({contactCount})</span>
              </div>
            </div>
            {contactCount === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
                No contacts linked to this company yet.
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-1">
                {data.contacts.map((c: any) => (
                  <Link key={c.id} href={`/contacts/${c.id}`} className="group flex w-24 shrink-0 flex-col items-center gap-2 rounded-lg px-2 py-2 text-center transition-colors hover:bg-bg-surface-hover">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-bg-elevated text-sm font-semibold text-text-primary transition-colors group-hover:border-accent-magenta/50">
                      {contactInitials(c.full_name)}
                    </div>
                    <div className="w-full text-xs font-medium leading-4 text-text-primary line-clamp-2">{c.full_name}</div>
                    {c.job_title && <div className="w-full truncate text-[10px] text-text-muted">{c.job_title}</div>}
                  </Link>
                ))}
              </div>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <main className="order-2 min-w-0 lg:order-1">
              <ScrollPanel
                title="Relevant News"
                count={newsArticles.length}
                expanded={newsExpanded}
                onToggle={() => setNewsExpanded(v => !v)}
                collapsedMax={420}
                expandedMax="min(70vh, 760px)"
              >
                {newsArticles.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-text-muted">
                    No relevant news linked to this company yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {newsArticles.map((article: any) => {
                      const rawUrl = article.source_url ? String(article.source_url) : '';
                      const domain = newsDomain(rawUrl) || article.source_name || null;
                      return (
                        <a
                          key={article.id}
                          href={rawUrl || '#'}
                          target={rawUrl ? '_blank' : undefined}
                          rel={rawUrl ? 'noopener noreferrer' : undefined}
                          onClick={e => { if (!rawUrl) e.preventDefault(); }}
                          className="block rounded-lg border border-border bg-bg-surface/70 px-4 py-3 transition-colors hover:border-border-hover hover:bg-bg-surface-hover"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-text-primary">{article.title || 'Untitled article'}</span>
                                {rawUrl && <ExternalLink size={12} className="shrink-0 text-text-muted" />}
                              </div>
                              {article.summary && (
                                <div className="mt-1.5 text-xs leading-5 text-text-secondary line-clamp-3">{article.summary}</div>
                              )}
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              article.relevance_tag === 'direct_mention' ? 'bg-semantic-success/15 text-semantic-success' :
                              article.relevance_tag === 'competitor' ? 'bg-semantic-warning/15 text-semantic-warning' :
                              article.relevance_tag === 'industry_trend' ? 'bg-accent-purple/15 text-accent-purple' :
                              article.relevance_tag === 'technology' ? 'bg-accent-magenta/15 text-accent-magenta' :
                              'bg-text-muted/15 text-text-muted'
                            }`}>
                              {(article.relevance_tag || 'news').replace(/_/g, ' ')}
                            </span>
                            {domain && <span className="text-[10px] text-text-muted">{domain}</span>}
                            {article.published_at && (
                              <span className="text-[10px] text-text-muted">
                                {new Date(article.published_at).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </a>
                      );
                    })}
                  </div>
                )}
              </ScrollPanel>
            </main>

            <aside className="order-1 space-y-4 lg:order-2">
              <div
                className="card relative overflow-hidden"
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
                      <span className="text-sm font-medium text-text-primary">Drop to attach to this company</span>
                    </div>
                  </div>
                )}
                <div className="mb-4 flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => setDocumentsExpanded(v => !v)}
                    className="flex min-w-0 items-center gap-2 text-left text-xs uppercase tracking-[0.16em] text-text-muted hover:text-text-primary"
                    aria-expanded={documentsExpanded}
                  >
                    {documentsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    Documents
                    <span className="rounded bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-accent-magenta">
                      {documents.length}
                    </span>
                  </button>
                  <div className="flex flex-wrap items-center gap-2">
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
                <div className="overflow-y-auto pr-1" style={{ maxHeight: documentsExpanded ? 'min(70vh, 680px)' : 300 }}>
                  {docsLoading ? (
                    <div className="space-y-3">
                      {Array.from({ length: 2 }).map((_, i) => (
                        <div key={i} className="h-16 bg-bg-surface animate-pulse rounded-xl" />
                      ))}
                    </div>
                  ) : documents.length === 0 ? (
                    <div className="text-center py-10">
                      <FileText size={28} className="mx-auto text-text-muted/30 mb-3" />
                      <div className="text-text-muted text-sm">No documents linked to this company yet</div>
                      <div className="text-text-muted/60 text-xs mt-1">Upload a document or it will appear here when MARTy or the system links one</div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {documents.map((doc: any) => (
                        <div key={doc.id}
                          onClick={() => {
                            if (doc.r2_key || String(doc.extracted_text_preview || '').trim()) setPreviewDocId(doc.id);
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
                          <div className="flex-1 min-w-0 group">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text-primary truncate group-hover:text-accent-magenta transition-colors">
                                {doc.title || doc.file_name}
                              </span>
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
                            <button onClick={e => { e.stopPropagation(); handleDocDelete(doc.id); }}
                              className="p-2 rounded-lg text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors"
                              title="Delete document">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setAssociationsExpanded(v => !v)}
                  className="mb-3 flex w-full items-center gap-2 text-left text-xs uppercase tracking-[0.16em] text-text-muted hover:text-text-primary"
                  aria-expanded={associationsExpanded}
                >
                  {associationsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Associations
                  <span className="rounded bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-accent-magenta">
                    {companyAssociations.length}
                  </span>
                </button>
                <div className="overflow-y-auto pr-1" style={{ maxHeight: associationsExpanded ? 'min(70vh, 520px)' : 220 }}>
                  {companyAssociations.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-text-muted">
                      No associations detected yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {companyAssociations.map((a: any, i: number) => {
                        const href = a.other_type === 'contact' ? `/contacts/${a.other_id}`
                          : a.other_type === 'company' ? `/companies/${a.other_id}`
                          : '#';
                        const icon = a.other_type === 'contact' ? <Users size={13} className="text-text-muted" />
                          : a.other_type === 'deal' ? <Target size={13} className="text-text-muted" />
                          : <Briefcase size={13} className="text-text-muted" />;
                        const strengthColor = a.strength >= 60 ? '#22C55E' : a.strength >= 30 ? '#F59E0B' : '#71717A';
                        const types: string[] = a.association_types || [a.association_type];
                        return (
                          <Link key={i} href={href} className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-bg-surface">
                            {icon}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-text-primary">{a.entity_name}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {types.map((t: string) => (
                                  <span key={t} className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                                    style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                                    {(t || '').replace(/_/g, ' ')}
                                  </span>
                                ))}
                              </div>
                              <div className="mt-1 truncate text-xs text-text-muted">{a.reason}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <div className="h-1.5 w-10 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                <div className="h-full rounded-full" style={{ width: `${a.strength}%`, background: strengthColor }} />
                              </div>
                              <span className="text-[10px] font-semibold tabular-nums" style={{ color: strengthColor }}>{a.strength}</span>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {deleteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => !deleting && setDeleteOpen(false)}
        >
          <div
            className="bg-bg-elevated rounded-2xl w-full max-w-sm shadow-2xl border border-border p-6"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-lg font-medium text-text-primary mb-2">Delete Company</div>
            <div className="text-sm text-text-secondary mb-6">
              Are you sure you want to delete <span className="font-medium text-text-primary">{company.name}</span>? This cannot be undone.
            </div>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>Cancel</button>
              <button
                className="btn-primary bg-semantic-error hover:bg-semantic-error/90"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <DocumentUploadModal
        open={docUploadOpen}
        onClose={() => { setDocUploadOpen(false); setDocUploadFiles([]); }}
        onUploaded={() => { setRefreshKey(k => k + 1); setToast('Documents uploaded'); }}
        initialFiles={docUploadFiles}
        companyId={id}
      />

      <DocumentPreviewModal
        docId={previewDocId}
        onClose={() => setPreviewDocId(null)}
      />

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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CompanyLogo({ name, domain, logoUrl }: { name: string; domain?: string | null; logoUrl?: string | null }) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const src = !imgFailed ? (logoUrl || faviconUrl(domain, 96)) : null;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className="h-16 w-16 rounded-lg border border-border bg-bg-surface object-cover"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-border bg-brand-gradient text-xl font-semibold text-white">
      {initialFromName(name)}
    </div>
  );
}

function IdentityTag({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'hot' | 'warning' | 'info' }) {
  const styles = {
    neutral: 'bg-white/[0.06] text-text-secondary',
    hot: 'bg-accent-magenta/15 text-accent-magenta',
    warning: 'bg-semantic-warning/15 text-semantic-warning',
    info: 'bg-semantic-info/15 text-semantic-info',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${styles}`}>
      {children}
    </span>
  );
}

function ScrollPanel({
  title,
  count,
  expanded,
  onToggle,
  collapsedMax,
  expandedMax,
  children,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  collapsedMax: number;
  expandedMax: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="mb-4 flex w-full items-center gap-2 text-left text-xs uppercase tracking-[0.16em] text-text-muted hover:text-text-primary"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {title}
        <span className="rounded bg-accent-magenta/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-accent-magenta">
          {count}
        </span>
      </button>
      <div className="overflow-y-auto pr-1 transition-[max-height] duration-200" style={{ maxHeight: expanded ? expandedMax : collapsedMax }}>
        {children}
      </div>
    </section>
  );
}

function PrettyTextBlock({ block }: { block: string }) {
  const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
  const bulletLines = lines.filter(line => /^[-*•]\s+/.test(line));

  if (lines.length > 1 && bulletLines.length === lines.length) {
    return (
      <ul className="list-disc space-y-2 pl-5">
        {lines.map((line, i) => (
          <li key={i}>{line.replace(/^[-*•]\s+/, '')}</li>
        ))}
      </ul>
    );
  }

  return <p className="whitespace-pre-wrap">{block}</p>;
}

function normalizeLongText(raw: any): string {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isSubstantiveText(raw: any): boolean {
  const text = normalizeLongText(raw);
  const lower = text.toLowerCase();
  if (!text) return false;
  return !['n/a', 'na', 'none', 'null', 'undefined', 'unknown', 'no description', 'no description yet'].includes(lower);
}

function textBlocks(raw: string): string[] {
  const normalized = normalizeLongText(raw);
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  if (blocks.length > 1 || normalized.length < 420) return blocks;

  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
    ?.map(sentence => sentence.trim())
    .filter(Boolean);
  if (!sentences || sentences.length < 3) return [normalized];

  const grouped: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    grouped.push(sentences.slice(i, i + 2).join(' '));
  }
  return grouped;
}

function contactInitials(name: string | null | undefined): string {
  const parts = String(name || '')
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
}

function newsDomain(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    try {
      return new URL(`https://${rawUrl}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }
}

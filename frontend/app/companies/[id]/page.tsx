'use client';

import React from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Info, Users, Briefcase, Target, MapPin, Globe, Mail,
  ChevronDown, ChevronUp, ExternalLink, RefreshCw, Link2,
} from 'lucide-react';
import { TopBar } from '@/components/top-bar';
import { TagPicker } from '@/components/tag-picker';
import { api } from '@/lib/api';

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
  const [newsTooltip, setNewsTooltip] = React.useState(false);
  const [companyAssociations, setCompanyAssociations] = React.useState<any[]>([]);
  const [editMode, setEditMode] = React.useState(false);
  const [editForm, setEditForm] = React.useState<EditFormData>({
    name: '', description: '', sector: '', stage: '', company_type: '',
    investment_status: '', website: '', location: '', domain: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [bioExpanded, setBioExpanded] = React.useState(false);

  React.useEffect(() => {
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
  }, [id, refreshKey]);

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
  const bio = fullBio;
  const bioParas = bio ? bio.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean) : [];

  return (
    <div className="flex-1 overflow-auto">
      {/* ── Edit mode sticky bar ── */}
      {editMode && (
        <div className="sticky top-0 z-30 border-b px-8 py-3 flex items-center justify-between"
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
      <div className="px-8 py-5 border-b border-border" style={{ background: 'rgba(17,17,20,0.6)' }}>
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-xl bg-brand-gradient flex items-center justify-center text-white text-lg font-semibold shrink-0 shadow-lg shadow-accent-magenta/10">
            {(editMode ? editForm.name : company.name).charAt(0) || '?'}
          </div>
          <div className="flex-1 min-w-0">
            {editMode ? (
              <>
                <input className="font-display text-2xl leading-tight bg-transparent border-b border-accent-magenta/30 focus:border-accent-magenta outline-none w-full text-text-primary pb-0.5"
                  value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} disabled={saving} placeholder="Company Name" />
                <div className="flex items-center gap-3 mt-2 flex-wrap">
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
                  <span className="text-sm text-text-muted">·</span>
                  <select className="bg-bg-input border border-border rounded text-xs px-2 py-1 text-text-secondary focus:border-accent-magenta outline-none"
                    value={editForm.stage} onChange={e => setEditForm(f => ({ ...f, stage: e.target.value }))} disabled={saving}>
                    <option value="">Stage...</option>
                    {STAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1 mt-1.5">
                  <MapPin size={11} className="text-text-muted" />
                  <input className="text-xs bg-transparent border-b border-white/10 focus:border-accent-magenta/30 outline-none text-text-muted w-40"
                    value={editForm.location} onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} disabled={saving} placeholder="Location" />
                </div>
                <div className="flex items-center gap-2 mt-2.5">
                  <select className="bg-bg-input border border-border rounded text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 text-text-secondary focus:border-accent-magenta outline-none"
                    value={editForm.company_type} onChange={e => setEditForm(f => ({ ...f, company_type: e.target.value }))} disabled={saving}>
                    <option value="">Type...</option>
                    {COMPANY_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <select className="bg-bg-input border border-border rounded text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 text-text-secondary focus:border-accent-magenta outline-none"
                    value={editForm.investment_status} onChange={e => setEditForm(f => ({ ...f, investment_status: e.target.value }))} disabled={saving}>
                    <option value="">Inv. Status...</option>
                    {INVESTMENT_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <TagPicker entityType="company" entityId={id} tags={tags} onTagsChange={setTags} />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <h1 className="font-display text-2xl leading-tight">{company.name}</h1>
                  {company.website && (
                    <a href={company.website} target="_blank" rel="noopener" className="text-accent-magenta hover:text-accent-purple transition-colors">
                      <Globe size={16} />
                    </a>
                  )}
                </div>
                <div className="text-sm text-text-secondary mt-0.5">
                  {company.sector || 'No sector'} · {company.stage?.replace(/_/g, ' ') || 'Unknown stage'}
                </div>
                {company.location && (
                  <div className="text-xs text-text-muted mt-1 flex items-center gap-1"><MapPin size={11} />{company.location}</div>
                )}
                <div className="flex items-center gap-1.5 mt-2.5">
                  {company.company_type && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider"
                      style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                      {company.company_type}
                    </span>
                  )}
                  {company.investment_status && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider"
                      style={{ background: 'rgba(217,70,168,0.08)', color: '#D946A8' }}>
                      {company.investment_status.replace(/_/g, ' ')}
                    </span>
                  )}
                  <TagPicker entityType="company" entityId={id} tags={tags} onTagsChange={setTags} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="p-8 space-y-6">
        {/* Description Card */}
        <div className="relative rounded-xl p-5 transition-all duration-200 hover:border-white/[0.1]"
          style={{ background: 'rgba(17,17,20,0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-2">Description</div>
          {editMode ? (
            <textarea className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-secondary focus:border-accent-magenta outline-none resize-none"
              rows={4} value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} disabled={saving}
              placeholder="Company description..." />
          ) : (
            <div className="text-sm text-text-secondary">
              {company.description || 'No description yet'}
            </div>
          )}
        </div>

        {/* Edit-mode extra fields */}
        {editMode && (
          <div className="relative rounded-xl p-5"
            style={{ background: 'rgba(17,17,20,0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display mb-3">Additional Details</div>
            <div className="space-y-3">
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Website</div>
                <input type="url" className="input w-full" value={editForm.website} onChange={e => setEditForm(f => ({ ...f, website: e.target.value }))} disabled={saving} />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Domain</div>
                <input type="text" className="input w-full" value={editForm.domain} onChange={e => setEditForm(f => ({ ...f, domain: e.target.value }))} disabled={saving} placeholder="example.com" />
              </label>
            </div>
          </div>
        )}

        {/* Intel Brief — NOT editable */}
        {bio && (
          <div className="relative rounded-xl p-5 transition-all duration-200 hover:border-white/[0.1]"
            style={{ background: 'rgba(17,17,20,0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
              style={{ background: 'linear-gradient(180deg, #D946A8, #8B5CF6)' }} />
            <div className="pl-3">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[11px] uppercase tracking-[0.14em] font-medium text-text-muted font-display">Intelligence Briefing</span>
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
            </div>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-4">
          <div className="card">
            <div className="text-xs uppercase text-text-muted mb-2">Contacts</div>
            <div className="text-2xl font-medium">{data.contacts?.length || 0}</div>
          </div>
          <div className="card">
            <div className="text-xs uppercase text-text-muted mb-2">Deals</div>
            <div className="text-2xl font-medium">{data.deals?.length || 0}</div>
          </div>
          <div className="card">
            <div className="text-xs uppercase text-text-muted mb-2 flex items-center gap-1.5">
              News Score
              <span
                className="relative inline-block"
                onMouseEnter={() => setNewsTooltip(true)}
                onMouseLeave={() => setNewsTooltip(false)}
              >
                <Info size={13} className="text-text-muted cursor-help" />
                {newsTooltip && (
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 px-3 py-2 text-xs text-text-primary bg-bg-elevated border border-border rounded-lg shadow-xl z-50 font-normal normal-case tracking-normal">
                    AI-generated relevance score (0-10) based on recent news mentions, competitor activity, industry trends, and regulatory signals. Updated each ingestion cycle.
                  </span>
                )}
              </span>
            </div>
            {(() => {
              const score = company.news_relevance_score;
              if (!score) return <div className="text-sm text-text-muted">No recent news</div>;
              const color = score > 7 ? '#22C55E' : score >= 4 ? '#F59E0B' : '#EF4444';
              return (
                <>
                  <div className="text-2xl font-medium">
                    {score.toFixed(1)}
                    <span className="text-sm text-text-muted font-normal"> / 10</span>
                  </div>
                  <div className="w-full h-2 bg-bg-surface-hover rounded-full overflow-hidden mt-2">
                    <div className="h-full rounded-full transition-all" style={{ width: `${(score / 10) * 100}%`, background: color }} />
                  </div>
                </>
              );
            })()}
          </div>
        </div>

        {data.news_articles?.length > 0 && (
          <div className="card">
            <div className="text-xs uppercase text-text-muted mb-3">Industry News</div>
            <div className="space-y-3">
              {data.news_articles.map((article: any) => {
                const hasValidUrl = article.source_url && !article.source_url.includes('vertexaisearch.cloud.google.com');
                const domain = hasValidUrl ? (() => {
                  try { return new URL(article.source_url).hostname.replace(/^www\./, ''); } catch { return null; }
                })() : null;
                return (
                  <div key={article.id} className="flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-bg-surface transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {hasValidUrl ? (
                          <a href={article.source_url} target="_blank" rel="noopener noreferrer"
                            className="text-sm font-medium text-text-primary hover:text-white hover:underline transition-colors truncate flex items-center gap-1.5">
                            {article.title}
                            <ExternalLink size={11} className="text-text-muted shrink-0" />
                          </a>
                        ) : (
                          <div className="text-sm font-medium text-text-secondary truncate">
                            {article.title}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-text-secondary line-clamp-2">{article.summary}</div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${
                          article.relevance_tag === 'direct_mention' ? 'bg-semantic-success/15 text-semantic-success' :
                          article.relevance_tag === 'competitor' ? 'bg-semantic-warning/15 text-semantic-warning' :
                          article.relevance_tag === 'industry_trend' ? 'bg-accent-purple/15 text-accent-purple' :
                          article.relevance_tag === 'technology' ? 'bg-accent-magenta/15 text-accent-magenta' :
                          'bg-text-muted/15 text-text-muted'
                        }`}>
                          {(article.relevance_tag || '').replace(/_/g, ' ')}
                        </span>
                        {domain ? (
                          <span className="text-[10px] text-text-muted">{domain}</span>
                        ) : article.source_name ? (
                          <span className="text-[10px] text-text-muted">{article.source_name}</span>
                        ) : null}
                        {article.published_at && (
                          <span className="text-[10px] text-text-muted">
                            {new Date(article.published_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {data.contacts?.length > 0 && (
          <div className="card">
            <div className="text-xs uppercase text-text-muted mb-3">Contacts</div>
            <div className="space-y-2">
              {data.contacts.map((c: any) => (
                <Link key={c.id} href={`/contacts/${c.id}`} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-bg-surface transition-colors">
                  <div>
                    <div className="text-sm font-medium text-text-primary">{c.full_name}</div>
                    <div className="text-xs text-text-muted">{c.job_title || 'No title'}</div>
                  </div>
                  <div className="text-xs text-text-muted">{c.email}</div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {data.deals?.length > 0 && (
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase text-text-muted">Active Deals</div>
              <Link href={`/deals`} className="text-[10px] text-accent-magenta hover:text-accent-purple transition-colors">
                View Pipeline
              </Link>
            </div>
            <div className="space-y-2">
              {data.deals.map((deal: any) => {
                const stageColor: Record<string, string> = {
                  prospect: '#71717A', first_contact: '#3B82F6', meeting_scheduled: '#06B6D4',
                  due_diligence: '#EAB308', term_sheet: '#F97316', closing: '#8B5CF6',
                  closed_won: '#22C55E', closed_lost: '#EF4444',
                };
                const color = stageColor[deal.stage] || '#71717A';
                const daysInStage = deal.stage_changed_at
                  ? Math.floor((Date.now() - new Date(deal.stage_changed_at).getTime()) / 86_400_000)
                  : 0;
                return (
                  <Link key={deal.id} href={`/deals/${deal.id}`}
                    className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-bg-surface transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <Target size={14} className="text-text-muted shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{deal.title}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                            style={{ background: color + '18', color }}>
                            {(deal.stage || '').replace(/_/g, ' ')}
                          </span>
                          {daysInStage > 0 && (
                            <span className="text-[10px] text-text-muted">{daysInStage}d in stage</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {deal.amount ? (
                        <div className="text-sm text-text-primary font-medium">
                          {deal.amount >= 1e6 ? `$${(deal.amount / 1e6).toFixed(1)}M` : `$${(deal.amount / 1e3).toFixed(0)}K`}
                        </div>
                      ) : (
                        <div className="text-xs text-text-muted">No amount</div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {companyAssociations.length > 0 && (
          <div className="card">
            <div className="text-xs uppercase text-text-muted mb-3">Associations</div>
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
                  <Link key={i} href={href} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-bg-surface transition-colors">
                    {icon}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary truncate">{a.entity_name}</span>
                        {types.map((t: string) => (
                          <span key={t} className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                            style={{ background: 'rgba(255,255,255,0.05)', color: '#A1A1AA' }}>
                            {(t || '').replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-text-muted truncate">{a.reason}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                          <div className="h-full rounded-full" style={{ width: `${a.strength}%`, background: strengthColor }} />
                        </div>
                        <span className="text-[10px] font-semibold tabular-nums" style={{ color: strengthColor }}>{a.strength}</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
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

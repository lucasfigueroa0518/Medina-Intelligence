'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { FilterPanel } from '@/components/filter-panel';
import { TagManagerModal } from '@/components/tag-manager-modal';
import { api } from '@/lib/api';
import { Plus, Search, X as XIcon, Settings2 } from 'lucide-react';

const COMPANY_TYPE_OPTIONS = [
  { value: 'startup', label: 'Startup' },
  { value: 'fund', label: 'Fund' },
  { value: 'corporation', label: 'Corporation' },
  { value: 'government', label: 'Government' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
];

interface Tag {
  id: string;
  name: string;
  color: string;
}

export default function CompaniesPage() {
  const router = useRouter();
  const [companies, setCompanies] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState<string[]>([]);
  const [allTags, setAllTags] = React.useState<Tag[]>([]);
  const [tagManagerOpen, setTagManagerOpen] = React.useState(false);
  const [filterCounts, setFilterCounts] = React.useState<{ tags: Record<string, number> }>({ tags: {} });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createForm, setCreateForm] = React.useState({ name: '', domain: '', website: '', sector: '', company_type: '', location: '' });
  const [creating, setCreating] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Cumulative pagination — same shape as the contacts page: 100/page, total
  // from server, "Load more" button below the list. Scales cleanly to ~10k
  // records; if the dataset crosses 100k swap to cursor-based.
  const PAGE_SIZE = 100;
  const [total, setTotal] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const loadCompanies = React.useCallback(() => {
    setLoading(true);
    api.listCompanies({ limit: String(PAGE_SIZE), offset: '0' })
      .then(d => {
        setCompanies(d.companies);
        setTotal(d.total ?? d.companies.length);
      })
      .finally(() => setLoading(false));
  }, []);

  const loadMore = React.useCallback(() => {
    if (loadingMore || companies.length >= total) return;
    setLoadingMore(true);
    api.listCompanies({ limit: String(PAGE_SIZE), offset: String(companies.length) })
      .then(d => {
        setCompanies(prev => [...prev, ...d.companies]);
        if (typeof d.total === 'number') setTotal(d.total);
      })
      .finally(() => setLoadingMore(false));
  }, [companies.length, total, loadingMore]);

  async function handleCreateCompany() {
    if (!createForm.name.trim()) return;
    setCreating(true);
    try {
      await api.createCompany({
        name: createForm.name.trim(),
        domain: createForm.domain.trim() || null,
        website: createForm.website.trim() || null,
        sector: createForm.sector.trim() || null,
        company_type: createForm.company_type || null,
        location: createForm.location.trim() || null,
      });
      setCreateOpen(false);
      setCreateForm({ name: '', domain: '', website: '', sector: '', company_type: '', location: '' });
      setToast('Company created');
      loadCompanies();
    } catch (e: any) { setToast(`Failed: ${e.message || 'Unknown error'}`); }
    finally { setCreating(false); }
  }

  const loadTags = React.useCallback(() => {
    api.listTags('company').then(d => setAllTags(d.tags as Tag[])).catch(() => {});
  }, []);

  React.useEffect(() => {
    loadTags();
    api.getCompanyFilterCounts().then(setFilterCounts).catch(() => {});
  }, [loadTags]);

  React.useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  const filtered = React.useMemo(() => {
    let result = companies;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(c =>
        c.name?.toLowerCase().includes(q) ||
        c.sector?.toLowerCase().includes(q) ||
        c.company_type?.toLowerCase().includes(q)
      );
    }
    if (tagFilter.length > 0) {
      const tagSet = new Set(tagFilter);
      result = result.filter(c => c.tags?.some((t: any) => tagSet.has(t.id)));
    }
    return result;
  }, [companies, search, tagFilter]);

  const isFiltered = tagFilter.length > 0;
  const activeFilterLabels = allTags.filter(t => tagFilter.includes(t.id)).map(t => t.name);

  const columns: Column<any>[] = [
    {
      key: 'name',
      header: 'Name',
      width: '220px',
      accessor: row => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-lg bg-brand-gradient flex items-center justify-center text-white text-xs font-medium">
            {row.name?.charAt(0)}
          </div>
          <span className="font-medium truncate" title={row.name}>{row.name}</span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: '100px',
      accessor: row => <span className="badge capitalize">{row.company_type}</span>,
    },
    {
      key: 'tags',
      header: 'Tags',
      width: '180px',
      accessor: row => (
        <div className="flex items-center gap-1 flex-wrap">
          {(row.tags || []).slice(0, 3).map((t: any) => (
            <span key={t.id} className="px-1.5 py-0.5 rounded text-[9px] font-medium font-accent"
              style={{ background: t.color + '25', color: t.color }}>
              {t.name}
            </span>
          ))}
          {(row.tags || []).length > 3 && (
            <span className="text-[9px] text-text-muted">+{(row.tags || []).length - 3}</span>
          )}
        </div>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      width: '120px',
      accessor: row => (
        <span className="badge capitalize">{row.stage?.replace('_', ' ') || '\u2014'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Investment Status',
      width: '150px',
      accessor: row => (
        <span className="badge capitalize">{row.investment_status?.replace('_', ' ')}</span>
      ),
    },
    {
      key: 'valuation',
      header: 'Valuation',
      width: '120px',
      accessor: row => formatCurrency(row.current_valuation),
    },
    {
      key: 'news_score',
      header: 'News Score',
      width: '110px',
      accessor: row => {
        const score = row.news_relevance_score;
        if (!score) return <span className="text-xs text-text-muted">{'\u2014'}</span>;
        const color = score > 7 ? '#22C55E' : score >= 4 ? '#F59E0B' : '#EF4444';
        return (
          <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 bg-bg-surface-hover rounded-full overflow-hidden">
              <div className="h-1.5 rounded-full" style={{ width: `${(score / 10) * 100}%`, background: color }} />
            </div>
            <span className="text-xs font-semibold font-accent" style={{ color }}>{score.toFixed(1)}</span>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex-1 flex">
      <FilterPanel
        sections={[
          {
            label: 'Tags',
            defaultOpen: true,
            children: (
              <>
                {allTags.length > 0 ? allTags.map(tag => {
                  const count = filterCounts.tags[tag.id] || 0;
                  const active = tagFilter.includes(tag.id);
                  return (
                    <label key={tag.id}
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                        active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                      }`}>
                      <input type="checkbox" checked={active}
                        onChange={e => {
                          setTagFilter(prev =>
                            e.target.checked ? [...prev, tag.id] : prev.filter(t => t !== tag.id)
                          );
                        }} />
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                      <span className="flex-1">{tag.name}</span>
                      <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                    </label>
                  );
                }) : (
                  <div className="text-xs text-text-muted">No tags yet</div>
                )}
                <button onClick={() => setTagManagerOpen(true)}
                  className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-accent-magenta transition-colors mt-1">
                  <Settings2 size={11} /> Edit Tags
                </button>
              </>
            ),
          },
        ]}
        onClearAll={() => setTagFilter([])}
        activeCount={tagFilter.length}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          title="Companies"
          search={
            <div className="relative flex-1 min-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input type="text" placeholder="Search companies..."
                value={search} onChange={e => setSearch(e.target.value)}
                className="input pl-10 w-full" />
            </div>
          }
          actions={
            <button className="btn-primary flex items-center gap-2" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Add Company
            </button>
          }
        />
        <div className="flex-1 p-6 overflow-auto">
          {/* Active filter summary */}
          {isFiltered && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-xs text-text-muted">Filtering:</span>
              {activeFilterLabels.map(label => (
                <span key={label} className="px-2 py-0.5 rounded text-[10px] font-medium"
                  style={{ background: 'rgba(217,70,168,0.1)', color: '#D946A8' }}>
                  {label}
                </span>
              ))}
              <button onClick={() => setTagFilter([])}
                className="text-[10px] text-text-muted hover:text-text-secondary ml-1 flex items-center gap-0.5">
                <XIcon size={10} /> Clear All
              </button>
            </div>
          )}

          <div className="text-sm text-text-secondary mb-4">
            {loading ? 'Loading...' : isFiltered
              ? `Showing ${filtered.length} of ${companies.length} loaded (${total} total)`
              : `Showing ${companies.length} of ${total} companies`
            }
          </div>
          <DataTable
            columns={columns}
            data={filtered}
            loading={loading}
            emptyMessage="No companies yet"
            getRowId={c => c.id}
            onRowClick={c => router.push(`/companies/${c.id}`)}
          />
          {!loading && companies.length < total && (
            <div className="flex justify-center mt-4">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="btn-secondary text-sm"
              >
                {loadingMore ? 'Loading...' : `Load more (${total - companies.length} remaining)`}
              </button>
            </div>
          )}
        </div>
      </main>

      <TagManagerModal
        entityType="company"
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        onChanged={() => {
          loadTags();
          api.getCompanyFilterCounts().then(setFilterCounts).catch(() => {});
        }}
      />

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={() => !creating && setCreateOpen(false)}>
          <div className="rounded-2xl w-full max-w-md shadow-2xl p-6"
            style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-lg font-medium text-text-primary mb-4">Add Company</div>
            <div className="space-y-3">
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Name *</div>
                <input className="input w-full" value={createForm.name} onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} disabled={creating} placeholder="Company name" />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Domain</div>
                <input className="input w-full" value={createForm.domain} onChange={e => setCreateForm(f => ({ ...f, domain: e.target.value }))} disabled={creating} placeholder="example.com" />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Website</div>
                <input type="url" className="input w-full" value={createForm.website} onChange={e => setCreateForm(f => ({ ...f, website: e.target.value }))} disabled={creating} placeholder="https://example.com" />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Sector</div>
                <input className="input w-full" value={createForm.sector} onChange={e => setCreateForm(f => ({ ...f, sector: e.target.value }))} disabled={creating} placeholder="Technology, Finance, etc." />
              </label>
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Type</div>
                <select className="input w-full" value={createForm.company_type} onChange={e => setCreateForm(f => ({ ...f, company_type: e.target.value }))} disabled={creating}>
                  <option value="">Select type...</option>
                  {COMPANY_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="block">
                <div className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">Location</div>
                <input className="input w-full" value={createForm.location} onChange={e => setCreateForm(f => ({ ...f, location: e.target.value }))} disabled={creating} placeholder="City, Country" />
              </label>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button className="btn-ghost" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</button>
              <button className="btn-primary" onClick={handleCreateCompany} disabled={creating || !createForm.name.trim()}>
                {creating ? 'Creating...' : 'Create Company'}
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

function formatCurrency(v?: number | null): string {
  if (v == null) return '\u2014';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

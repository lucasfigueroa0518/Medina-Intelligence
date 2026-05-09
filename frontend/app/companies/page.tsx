'use client';

import React, { Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { FilterPanel } from '@/components/filter-panel';
import { SortDropdown, SortOption } from '@/components/sort-dropdown';
import { QuickFilters, QuickFilter } from '@/components/quick-filters';
import { TagManagerModal } from '@/components/tag-manager-modal';
import { api } from '@/lib/api';
import { initialFromName, faviconUrl } from '@/lib/avatar';
import { DEMO_COMPANY_TOTAL, demoCompanies, demoTags, demoToastMessage, useDemoMode } from '@/lib/demo-mode';
import { Plus, Search, X as XIcon, Settings2 } from 'lucide-react';

interface Tag { id: string; name: string; color: string }
interface CityOpt { name: string; count: number }

const COMPANY_TYPES = [
  { value: 'startup',       label: 'Startup' },
  { value: 'vc_firm',       label: 'VC Firm' },
  { value: 'family_office', label: 'Family Office' },
  { value: 'portfolio',     label: 'Portfolio' },
  { value: 'lp',            label: 'LP' },
  { value: 'other',         label: 'Other' },
];

const INVESTMENT_STATUSES = [
  { value: 'tracking',       label: 'Tracking' },
  { value: 'prospect',       label: 'Prospect' },
  { value: 'due_diligence',  label: 'Due Diligence' },
  { value: 'term_sheet',     label: 'Term Sheet' },
  { value: 'invested',       label: 'Invested' },
  { value: 'passed',         label: 'Passed' },
  { value: 'exited',         label: 'Exited' },
];

const NEWS_SCORE_OPTIONS = [
  { value: 'high',   label: 'High (7+)' },
  { value: 'medium', label: 'Medium (3–7)' },
  { value: 'low',    label: 'Low (0–3)' },
  { value: 'none',   label: 'None' },
];

const SORT_OPTIONS: SortOption[] = [
  { key: 'news_score',        label: 'News Score (highest first)', defaultDir: 'desc' },
  { key: 'name',              label: 'Name (A–Z)',                 defaultDir: 'asc' },
  { key: 'city',              label: 'City',                       defaultDir: 'asc' },
  { key: 'investment_status', label: 'Investment Status',          defaultDir: 'asc' },
  { key: 'created_at',        label: 'Date Added (newest first)',  defaultDir: 'desc' },
];

const COMPANY_TYPE_OPTIONS = [
  { value: 'startup', label: 'Startup' },
  { value: 'fund', label: 'Fund' },
  { value: 'corporation', label: 'Corporation' },
  { value: 'government', label: 'Government' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
];

const PAGE_SIZE = 100;

interface FilterState {
  search: string;
  type: string[];
  investment_status: string[];
  city: string;
  news_score: string;            // single-select
  has_deals: boolean;
  tags: string[];
  sort: string;
  order: 'asc' | 'desc';
}

const DEFAULT_SORT = 'news_score';
const DEFAULT_ORDER: 'asc' | 'desc' = 'desc';

function emptyFilters(): FilterState {
  return {
    search: '',
    type: [],
    investment_status: [],
    city: '',
    news_score: '',
    has_deals: false,
    tags: [],
    sort: DEFAULT_SORT,
    order: DEFAULT_ORDER,
  };
}

function readFromUrl(sp: URLSearchParams): FilterState {
  const csv = (k: string) => (sp.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
  const order = sp.get('order');
  return {
    search: sp.get('search') || '',
    type: csv('type'),
    investment_status: csv('investment_status'),
    city: sp.get('city') || '',
    news_score: sp.get('news_score') || '',
    has_deals: sp.get('has_deals') === 'true',
    tags: csv('tags'),
    sort: sp.get('sort') || DEFAULT_SORT,
    order: order === 'asc' || order === 'desc' ? order : DEFAULT_ORDER,
  };
}

function toParams(f: FilterState): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.search) p.search = f.search;
  if (f.type.length) p.type = f.type.join(',');
  if (f.investment_status.length) p.investment_status = f.investment_status.join(',');
  if (f.city) p.city = f.city;
  if (f.news_score) p.news_score = f.news_score;
  if (f.has_deals) p.has_deals = 'true';
  if (f.tags.length) p.tags = f.tags.join(',');
  // sort + order travel together. Stripping individually causes the backend's
  // per-column defaultDir (COMPANY_SORT_MAP) to override the user's chosen
  // order whenever it happens to coincide with DEFAULT_ORDER — arrow flips
  // visually but rows don't reorder.
  if (f.sort !== DEFAULT_SORT || f.order !== DEFAULT_ORDER) {
    p.sort = f.sort;
    p.order = f.order;
  }
  return p;
}

const QUICK_FILTERS: QuickFilter<FilterState>[] = [
  { key: 'portfolio', label: 'Portfolio',        preset: { investment_status: ['invested'] } },
  { key: 'tracking',  label: 'Tracking',         preset: { investment_status: ['tracking'] } },
  { key: 'in_news',   label: 'In News',          preset: { news_score: 'high,medium' } },
  { key: 'has_deals', label: 'Has Active Deals', preset: { has_deals: true } },
];

function newsScoreLabel(value: string): string {
  const map: Record<string, string> = {
    high: 'High (7+)',
    medium: 'Medium (3–7)',
    low: 'Low (0–3)',
    none: 'None',
    'high,medium': 'In News',
  };
  return map[value] ?? value;
}

export default function CompaniesPageWrapper() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <CompaniesPage />
    </Suspense>
  );
}

function CompaniesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const demoMode = useDemoMode();

  const [filters, setFilters] = React.useState<FilterState>(() =>
    readFromUrl(searchParams ? new URLSearchParams(searchParams.toString()) : new URLSearchParams())
  );
  const [searchInput, setSearchInput] = React.useState(filters.search);
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout>>();

  const [companies, setCompanies] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createForm, setCreateForm] = React.useState({ name: '', domain: '', website: '', sector: '', company_type: '', location: '' });
  const [creating, setCreating] = React.useState(false);
  const [tagManagerOpen, setTagManagerOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const [allTags, setAllTags] = React.useState<Tag[]>([]);
  const [allCities, setAllCities] = React.useState<CityOpt[]>([]);
  const [filterCounts, setFilterCounts] = React.useState<{ tags: Record<string, number> }>({ tags: {} });

  // URL sync
  React.useEffect(() => {
    const params = toParams(filters);
    const qs = new URLSearchParams(params).toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  React.useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setFilters(f => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 300);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchInput]);

  React.useEffect(() => {
    if (demoMode) {
      setAllTags(demoTags);
      setAllCities([
        { name: 'Miami', count: 382 },
        { name: 'New York', count: 271 },
        { name: 'San Francisco', count: 214 },
        { name: 'Los Angeles', count: 167 },
        { name: 'Mountain View', count: 1 },
      ]);
      setFilterCounts({ tags: Object.fromEntries(demoTags.map((tag, index) => [tag.id, [512, 408, 447, 389][index] || 100])) });
      return;
    }
    api.listTags('company').then(d => setAllTags(d.tags as Tag[])).catch(() => {});
    api.listCompanyCities().then(d => setAllCities(d.cities)).catch(() => {});
    api.getCompanyFilterCounts().then(setFilterCounts).catch(() => {});
  }, [demoMode]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const buildParams = React.useCallback((offset: number): Record<string, string> => ({
    ...toParams(filters),
    limit: String(PAGE_SIZE),
    offset: String(offset),
  }), [filters]);

  const loadCompanies = React.useCallback(() => {
    if (demoMode) {
      setLoading(false);
      const q = filters.search.trim().toLowerCase();
      const rows = q
        ? demoCompanies.filter(c => [c.name, c.domain, c.sector, c.hq_location].filter(Boolean).some(v => String(v).toLowerCase().includes(q)))
        : demoCompanies;
      setCompanies(rows);
      setTotal(q ? rows.length : DEMO_COMPANY_TOTAL);
      return Promise.resolve();
    }
    setLoading(true);
    return api.listCompanies(buildParams(0))
      .then(d => {
        setCompanies(d.companies);
        setTotal(d.total ?? d.companies.length);
      })
      .finally(() => setLoading(false));
  }, [buildParams, demoMode, filters.search]);

  const loadMore = React.useCallback(() => {
    if (demoMode) return;
    if (loadingMore || companies.length >= total) return;
    setLoadingMore(true);
    api.listCompanies(buildParams(companies.length))
      .then(d => {
        setCompanies(prev => [...prev, ...d.companies]);
        if (typeof d.total === 'number') setTotal(d.total);
      })
      .finally(() => setLoadingMore(false));
  }, [buildParams, companies.length, total, loadingMore, demoMode]);

  React.useEffect(() => { loadCompanies(); }, [loadCompanies]);

  async function handleCreateCompany() {
    if (!createForm.name.trim()) return;
    if (demoMode) {
      setToast(demoToastMessage('Creating companies'));
      setCreateOpen(false);
      return;
    }
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

  // Chips
  type Chip = { label: string; onRemove: () => void };
  const chips: Chip[] = [];
  for (const t of filters.type) chips.push({
    label: `Type: ${COMPANY_TYPES.find(o => o.value === t)?.label ?? t}`,
    onRemove: () => setFilters(f => ({ ...f, type: f.type.filter(x => x !== t) })),
  });
  for (const s of filters.investment_status) chips.push({
    label: `Status: ${INVESTMENT_STATUSES.find(o => o.value === s)?.label ?? s}`,
    onRemove: () => setFilters(f => ({ ...f, investment_status: f.investment_status.filter(x => x !== s) })),
  });
  if (filters.city) chips.push({
    label: `City: ${filters.city}`,
    onRemove: () => setFilters(f => ({ ...f, city: '' })),
  });
  if (filters.news_score) chips.push({
    label: `News: ${newsScoreLabel(filters.news_score)}`,
    onRemove: () => setFilters(f => ({ ...f, news_score: '' })),
  });
  if (filters.has_deals) chips.push({
    label: 'Has Active Deals',
    onRemove: () => setFilters(f => ({ ...f, has_deals: false })),
  });
  for (const tagId of filters.tags) {
    const tag = allTags.find(t => t.id === tagId);
    if (!tag) continue;
    chips.push({
      label: `Tag: ${tag.name}`,
      onRemove: () => setFilters(f => ({ ...f, tags: f.tags.filter(x => x !== tagId) })),
    });
  }
  if (filters.sort !== DEFAULT_SORT || filters.order !== DEFAULT_ORDER) {
    const opt = SORT_OPTIONS.find(o => o.key === filters.sort);
    chips.push({
      label: `Sort: ${opt?.label ?? filters.sort} ${filters.order === 'asc' ? '↑' : '↓'}`,
      onRemove: () => setFilters(f => ({ ...f, sort: DEFAULT_SORT, order: DEFAULT_ORDER })),
    });
  }

  const isFiltered = chips.length > 0;

  function handleSort(key: string) {
    setFilters(f => {
      if (f.sort === key) return { ...f, order: f.order === 'asc' ? 'desc' : 'asc' };
      const opt = SORT_OPTIONS.find(o => o.key === key);
      return { ...f, sort: key, order: opt?.defaultDir ?? 'asc' };
    });
  }

  const columns: Column<any>[] = [
    {
      key: 'name', sortKey: 'name', header: 'Name', width: '220px', sortable: true,
      accessor: row => <CompanyAvatarCell name={row.name} domain={row.domain} logoUrl={row.logo_url} />,
    },
    {
      key: 'type', header: 'Type', width: '110px', sortable: false,
      accessor: row => <span className="badge capitalize">{(row.company_type || '').replace(/_/g, ' ')}</span>,
    },
    {
      key: 'tags', header: 'Tags', width: '180px',
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
      key: 'city', sortKey: 'city', header: 'City', width: '140px', sortable: true,
      accessor: row => {
        const city = extractCity(row.hq_location);
        return <span className="truncate block" title={row.hq_location || undefined}>{city}</span>;
      },
    },
    {
      key: 'investment_status', sortKey: 'investment_status', header: 'Investment Status', width: '150px', sortable: true,
      accessor: row => <span className="badge capitalize">{row.investment_status?.replace('_', ' ')}</span>,
    },
    {
      key: 'news_score', sortKey: 'news_score', header: 'News Score', width: '110px', sortable: true,
      accessor: row => {
        const score = row.news_relevance_score;
        if (!score) return <span className="text-xs text-text-muted">{'—'}</span>;
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
    <div className="flex-1 flex flex-col md:flex-row min-w-0">
      <FilterPanel
        sections={[
          {
            label: 'Type',
            defaultOpen: true,
            children: COMPANY_TYPES.map(opt => {
              const active = filters.type.includes(opt.value);
              return (
                <label key={opt.value}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({
                      ...f, type: e.target.checked ? [...f.type, opt.value] : f.type.filter(t => t !== opt.value),
                    }))} />
                  <span className="flex-1">{opt.label}</span>
                </label>
              );
            }),
          },
          {
            label: 'Investment Status',
            defaultOpen: true,
            children: INVESTMENT_STATUSES.map(opt => {
              const active = filters.investment_status.includes(opt.value);
              return (
                <label key={opt.value}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({
                      ...f,
                      investment_status: e.target.checked
                        ? [...f.investment_status, opt.value]
                        : f.investment_status.filter(s => s !== opt.value),
                    }))} />
                  <span className="flex-1">{opt.label}</span>
                </label>
              );
            }),
          },
          {
            label: 'City',
            defaultOpen: false,
            children: <CityTypeahead options={allCities} value={filters.city} onChange={c => setFilters(f => ({ ...f, city: c }))} />,
          },
          {
            label: 'News Score',
            defaultOpen: false,
            children: NEWS_SCORE_OPTIONS.map(opt => {
              const active = filters.news_score === opt.value;
              return (
                <label key={opt.value}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="radio" name="news_score" checked={active}
                    onChange={() => setFilters(f => ({ ...f, news_score: opt.value }))} />
                  <span className="flex-1">{opt.label}</span>
                </label>
              );
            }),
          },
          {
            label: 'Deals',
            defaultOpen: false,
            children: (
              <label className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                filters.has_deals ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}>
                <input type="checkbox" checked={filters.has_deals}
                  onChange={e => setFilters(f => ({ ...f, has_deals: e.target.checked }))} />
                <span className="flex-1">Only companies with deals</span>
              </label>
            ),
          },
          {
            label: 'Tags',
            defaultOpen: false,
            children: (
              <>
                {allTags.length > 0 ? allTags.map(tag => {
                  const count = filterCounts.tags[tag.id] || 0;
                  const active = filters.tags.includes(tag.id);
                  return (
                    <label key={tag.id}
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                        active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                      }`}>
                      <input type="checkbox" checked={active}
                        onChange={e => setFilters(f => ({
                          ...f, tags: e.target.checked ? [...f.tags, tag.id] : f.tags.filter(t => t !== tag.id),
                        }))} />
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                      <span className="flex-1">{tag.name}</span>
                      <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                    </label>
                  );
                }) : (
                  <div className="text-xs text-text-muted">No tags yet</div>
                )}
                <button onClick={() => demoMode ? setToast(demoToastMessage('Editing tags')) : setTagManagerOpen(true)}
                  className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-accent-magenta transition-colors mt-1">
                  <Settings2 size={11} /> Edit Tags
                </button>
              </>
            ),
          },
        ]}
        onClearAll={() => { setFilters(emptyFilters()); setSearchInput(''); }}
        activeCount={chips.length}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar
          title="Companies"
          search={
            <div className="relative flex-1 min-w-0 md:min-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input type="text" placeholder="Search companies by name, domain, or description..."
                value={searchInput} onChange={e => setSearchInput(e.target.value)}
                className="input pl-10 w-full" />
            </div>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SortDropdown
                options={SORT_OPTIONS}
                value={filters.sort}
                dir={filters.order}
                onChange={(key, dir) => setFilters(f => ({ ...f, sort: key, order: dir }))}
              />
              <button
                className="btn-primary flex items-center gap-2"
                onClick={() => demoMode ? setToast(demoToastMessage('Adding companies')) : setCreateOpen(true)}
              >
                <Plus size={16} /> Add Company
              </button>
            </div>
          }
        />

        <div className="flex-1 p-4 md:p-6 overflow-auto">
          <QuickFilters<FilterState>
            filters={filters}
            presets={QUICK_FILTERS}
            onApply={next => setFilters(next)}
            onClearAll={() => { setFilters(emptyFilters()); setSearchInput(''); }}
          />
          {isFiltered && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {chips.map((chip, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium"
                  style={{ background: 'rgba(217,70,168,0.1)', color: '#D946A8' }}>
                  {chip.label}
                  <button onClick={chip.onRemove} className="hover:text-white transition-colors">
                    <XIcon size={11} />
                  </button>
                </span>
              ))}
              <button onClick={() => { setFilters(emptyFilters()); setSearchInput(''); }}
                className="text-[11px] text-text-muted hover:text-text-secondary ml-1">
                Clear All
              </button>
            </div>
          )}

          <div className="text-sm text-text-secondary mb-4">
            {loading ? 'Loading...' : `Showing ${companies.length} of ${total} ${isFiltered ? 'matching ' : ''}companies`}
          </div>

          <DataTable
            columns={columns}
            data={companies}
            loading={loading}
            emptyMessage="No companies match your filters"
            getRowId={c => c.id}
            onRowClick={c => router.push(`/companies/${c.id}`)}
            sortKey={filters.sort}
            sortDir={filters.order}
            onSort={handleSort}
          />

          {!demoMode && !loading && companies.length < total && (
            <div className="flex justify-center mt-4">
              <button onClick={loadMore} disabled={loadingMore} className="btn-secondary text-sm">
                {loadingMore ? 'Loading...' : `Load more (${total - companies.length} remaining)`}
              </button>
            </div>
          )}
          {!demoMode && !loading && companies.length > 0 && companies.length >= total && (
            <div className="text-center mt-4 text-xs text-text-muted">End of results</div>
          )}
        </div>
      </main>

      <TagManagerModal
        entityType="company"
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        onChanged={() => {
          api.listTags('company').then(d => setAllTags(d.tags as Tag[])).catch(() => {});
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

// Avatar tile that prefers logo_url, falls back to a Google favicon if a
// domain is present, and finally to a gradient tile with the initial of
// the longest alpha-bearing word in the company name. The favicon image
// disappears via onError so the gradient placeholder takes over without
// a flicker of broken-image icon.
function CompanyAvatarCell({ name, domain, logoUrl }: { name: string; domain?: string | null; logoUrl?: string | null }) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const src = logoUrl || (!imgFailed ? faviconUrl(domain) : null);
  return (
    <div className="flex items-center gap-3 min-w-0">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="w-8 h-8 shrink-0 rounded-lg object-cover bg-bg-surface-hover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="w-8 h-8 shrink-0 rounded-lg bg-brand-gradient flex items-center justify-center text-white text-xs font-medium">
          {initialFromName(name)}
        </div>
      )}
      <span className="font-medium truncate" title={name}>{name}</span>
    </div>
  );
}

function CityTypeahead({
  options,
  value,
  onChange,
}: {
  options: CityOpt[];
  value: string;
  onChange: (city: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  if (value) {
    return (
      <div className="flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded bg-accent-magenta/10 text-sm">
        <span className="flex-1 truncate text-text-primary" title={value}>{value}</span>
        <button onClick={() => onChange('')} className="text-text-muted hover:text-text-primary">
          <XIcon size={12} />
        </button>
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => o.name.toLowerCase().includes(q)).slice(0, 12)
    : options.slice(0, 8);
  return (
    <div className="space-y-1">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search cities..."
        className="input w-full text-sm"
      />
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filtered.map(opt => (
          <button
            key={opt.name}
            onClick={() => { onChange(opt.name); setQuery(''); }}
            className="w-full flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover/50"
          >
            <span className="flex-1 text-left truncate" title={opt.name}>{opt.name}</span>
            <span className="text-[10px] tabular-nums text-text-muted">{opt.count}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="text-xs text-text-muted px-1.5 py-1">No matches</div>
        )}
      </div>
    </div>
  );
}

function extractCity(location: string | null | undefined): string {
  if (!location) return '—';
  return location.split(',')[0].trim() || '—';
}

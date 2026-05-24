'use client';

import React, { Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { FilterPanel } from '@/components/filter-panel';
import { SortDropdown, SortOption } from '@/components/sort-dropdown';
import { QuickFilters, QuickFilter } from '@/components/quick-filters';
import { ContactCreateModal } from '@/components/contact-create-modal';
import { TagManagerModal } from '@/components/tag-manager-modal';
import { api } from '@/lib/api';
import { initialFromName } from '@/lib/avatar';
import { DEMO_CONTACT_TOTAL, demoCompany, demoContacts, demoTags, demoToastMessage, useDemoMode } from '@/lib/demo-mode';
import { Search, Plus, X as XIcon, Settings2 } from 'lucide-react';

interface Contact {
  id: string;
  full_name: string;
  email: string;
  company_name?: string;
  contact_type: string;
  engagement_status?: string | null;
  last_contact_date?: string;
  total_interactions: number;
  next_followup_date?: string;
  tags?: { id: string; name: string; color: string }[];
}

interface Tag { id: string; name: string; color: string }
interface CompanyOpt { id: string; name: string; count: number }

const CONTACT_TYPES = ['individual', 'family', 'institutional_investor', 'company'];
const ENGAGEMENT_STATUSES = ['active', 'warm', 'new', 'dormant', 'churning', 'close'];

const STATUS_PILL: Record<string, { bg: string; text: string; label: string }> = {
  active:   { bg: 'rgba(34,197,94,0.12)',  text: '#4ADE80', label: 'Active' },
  warm:     { bg: 'rgba(168,85,247,0.14)', text: '#C084FC', label: 'Warm' },
  new:      { bg: 'rgba(245,158,11,0.12)', text: '#FBBF24', label: 'New' },
  dormant:  { bg: 'rgba(148,163,184,0.14)',text: '#94A3B8', label: 'Dormant' },
  churning: { bg: 'rgba(100,116,139,0.14)',text: '#64748B', label: 'Churning' },
  close:    { bg: 'rgba(217,70,168,0.12)', text: '#D946A8', label: 'Close' },
};

const LAST_CONTACT_OPTIONS = [
  { value: 'today',         label: 'Today' },
  { value: 'this_week',     label: 'This Week' },
  { value: 'this_month',    label: 'This Month' },
  { value: '1_3_months',    label: '1–3 Months Ago' },
  { value: '3_plus_months', label: '3+ Months Ago' },
  { value: 'never',         label: 'Never' },
];

const INTERACTIONS_OPTIONS = [
  { value: '0',         label: '0' },
  { value: '1_10',      label: '1–10' },
  { value: '11_50',     label: '11–50' },
  { value: '51_200',    label: '51–200' },
  { value: '200_plus',  label: '200+' },
];

const SORT_OPTIONS: SortOption[] = [
  { key: 'last_contact', label: 'Last Contact (newest first)', defaultDir: 'desc' },
  { key: 'name',         label: 'Name (A–Z)',             defaultDir: 'asc' },
  { key: 'interactions', label: 'Interactions (most first)',   defaultDir: 'desc' },
  { key: 'status',       label: 'Status',                      defaultDir: 'asc' },
  { key: 'created_at',   label: 'Date Added (newest first)',   defaultDir: 'desc' },
];

const PAGE_SIZE = 100;

interface FilterState {
  search: string;
  type: string[];
  status: string[];
  // last_contact stores either a single bucket value ("this_week") or a
  // comma-joined bucket list ("1_3_months,3_plus_months") used by the
  // "Stale 30+ Days" quick filter. The backend's readMulti splits on commas.
  last_contact: string;
  interactions: string;       // single-select bucket
  company_id: string;
  tags: string[];
  has_followup_overdue: boolean;
  in_active_deals: boolean;
  sort: string;
  order: 'asc' | 'desc';
}

const DEFAULT_SORT = 'last_contact';
const DEFAULT_ORDER: 'asc' | 'desc' = 'desc';

function emptyFilters(): FilterState {
  return {
    search: '',
    type: [],
    status: [],
    last_contact: '',
    interactions: '',
    company_id: '',
    tags: [],
    has_followup_overdue: false,
    in_active_deals: false,
    sort: DEFAULT_SORT,
    order: DEFAULT_ORDER,
  };
}

function readFiltersFromUrl(sp: URLSearchParams): FilterState {
  const csv = (k: string) => (sp.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
  const order = sp.get('order');
  return {
    search: sp.get('search') || '',
    type: csv('type'),
    status: csv('status'),
    last_contact: sp.get('last_contact') || '',
    interactions: sp.get('interactions') || '',
    company_id: sp.get('company_id') || '',
    tags: csv('tags'),
    has_followup_overdue: sp.get('has_followup_overdue') === 'true',
    in_active_deals: sp.get('in_active_deals') === 'true',
    sort: sp.get('sort') || DEFAULT_SORT,
    order: order === 'asc' || order === 'desc' ? order : DEFAULT_ORDER,
  };
}

function filtersToParams(f: FilterState): Record<string, string> {
  const p: Record<string, string> = {};
  const search = f.search.trim();
  if (search.length >= 2) p.search = search;
  if (f.type.length) p.type = f.type.join(',');
  if (f.status.length) p.status = f.status.join(',');
  if (f.last_contact) p.last_contact = f.last_contact;
  if (f.interactions) p.interactions = f.interactions;
  if (f.company_id) p.company_id = f.company_id;
  if (f.tags.length) p.tags = f.tags.join(',');
  if (f.has_followup_overdue) p.has_followup_overdue = 'true';
  if (f.in_active_deals) p.in_active_deals = 'true';
  // sort + order travel together. Stripping individually causes the backend's
  // per-column defaultDir (CONTACT_SORT_MAP) to override the user's chosen
  // order whenever it happens to coincide with DEFAULT_ORDER — arrow flips
  // visually but rows don't reorder.
  if (f.sort !== DEFAULT_SORT || f.order !== DEFAULT_ORDER) {
    p.sort = f.sort;
    p.order = f.order;
  }
  return p;
}

const QUICK_FILTERS: QuickFilter<FilterState>[] = [
  { key: 'active',          label: 'Active',         preset: { status: ['active'] } },
  { key: 'new_this_week',   label: 'New This Week',  preset: { status: ['new'], last_contact: 'this_week' } },
  { key: 'stale_30_plus',   label: 'Stale 30+ Days', preset: { last_contact: '1_3_months,3_plus_months' } },
  { key: 'in_active_deals', label: 'In Active Deals', preset: { in_active_deals: true } },
];

function lastContactLabel(value: string): string {
  const map: Record<string, string> = {
    today: 'Today',
    this_week: 'This Week',
    this_month: 'This Month',
    '1_3_months': '1–3 Months Ago',
    '3_plus_months': '3+ Months Ago',
    never: 'Never',
    '1_3_months,3_plus_months': '30+ Days Ago',
  };
  return map[value] ?? value;
}

export default function ContactsPageWrapper() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <ContactsPage />
    </Suspense>
  );
}

function ContactsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const demoMode = useDemoMode();

  const [filters, setFilters] = React.useState<FilterState>(() =>
    readFiltersFromUrl(searchParams ? new URLSearchParams(searchParams.toString()) : new URLSearchParams())
  );
  const [searchInput, setSearchInput] = React.useState(filters.search);
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout>>();
  const contactsRequestSeqRef = React.useRef(0);
  const contactsAbortRef = React.useRef<AbortController | null>(null);

  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [tagManagerOpen, setTagManagerOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const [allTags, setAllTags] = React.useState<Tag[]>([]);
  const [allCompanies, setAllCompanies] = React.useState<CompanyOpt[]>([]);
  const [filterCounts, setFilterCounts] = React.useState<{
    contact_type: Record<string, number>;
    engagement_status: Record<string, number>;
    tags: Record<string, number>;
    overdue_followups: number;
  }>({ contact_type: {}, engagement_status: {}, tags: {}, overdue_followups: 0 });

  // Sync filters back into the URL on every change. router.replace (not push)
  // so the back button doesn't undo individual filter clicks.
  React.useEffect(() => {
    const params = filtersToParams(filters);
    const qs = new URLSearchParams(params).toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  // Debounce search input → filters.search
  React.useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setFilters(f => f.search === searchInput ? f : { ...f, search: searchInput });
    }, 300);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchInput]);

  // Static rail data — tags, company list, filter counts. Loaded once.
  React.useEffect(() => {
    if (demoMode) {
      setAllTags(demoTags);
      setAllCompanies([{ id: demoCompany.id, name: demoCompany.name, count: 624 }]);
      setFilterCounts({
        contact_type: { individual: DEMO_CONTACT_TOTAL },
        engagement_status: { active: 1418, warm: 934, new: 617, dormant: 312, churning: 143, close: 55 },
        tags: Object.fromEntries(demoTags.map((tag, index) => [tag.id, [928, 741, 864, 606][index] || 250])),
        overdue_followups: 0,
      });
      return;
    }
    api.listTags('contact').then(d => setAllTags(d.tags as Tag[])).catch(() => {});
    api.listContactCompanies().then(d => setAllCompanies(d.companies)).catch(() => {});
    api.getContactFilterCounts().then(setFilterCounts).catch(() => {});
  }, [demoMode]);

  const buildParams = React.useCallback((offset: number): Record<string, string> => {
    return {
      ...filtersToParams(filters),
      limit: String(PAGE_SIZE),
      offset: String(offset),
    };
  }, [filters]);

  const loadContacts = React.useCallback(() => {
    if (demoMode) {
      setLoading(false);
      const q = filters.search.trim().toLowerCase();
      const rows = q
        ? demoContacts.filter(c => [c.full_name, c.email, c.company_name].filter(Boolean).some(v => String(v).toLowerCase().includes(q)))
        : demoContacts;
      setContacts(rows as Contact[]);
      setTotal(q ? rows.length : DEMO_CONTACT_TOTAL);
      return Promise.resolve();
    }
    contactsAbortRef.current?.abort();
    const controller = new AbortController();
    contactsAbortRef.current = controller;
    const requestSeq = contactsRequestSeqRef.current + 1;
    contactsRequestSeqRef.current = requestSeq;
    setLoading(true);
    return api.listContacts(buildParams(0), { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted || requestSeq !== contactsRequestSeqRef.current) return;
        setContacts(data.contacts as Contact[]);
        setTotal(data.total ?? data.contacts.length);
      })
      .catch(error => {
        if ((error as any)?.name === 'AbortError') return;
        setToast('Unable to load contacts');
      })
      .finally(() => {
        if (contactsAbortRef.current === controller) contactsAbortRef.current = null;
        if (requestSeq === contactsRequestSeqRef.current) setLoading(false);
      });
  }, [buildParams, demoMode, filters.search]);

  const loadMore = React.useCallback(() => {
    if (demoMode) return;
    if (loadingMore || contacts.length >= total) return;
    const requestSeq = contactsRequestSeqRef.current;
    setLoadingMore(true);
    api.listContacts(buildParams(contacts.length))
      .then(data => {
        if (requestSeq !== contactsRequestSeqRef.current) return;
        setContacts(prev => [...prev, ...(data.contacts as Contact[])]);
        if (typeof data.total === 'number') setTotal(data.total);
      })
      .finally(() => setLoadingMore(false));
  }, [buildParams, contacts.length, total, loadingMore, demoMode]);

  React.useEffect(() => { loadContacts(); }, [loadContacts]);
  React.useEffect(() => () => contactsAbortRef.current?.abort(), []);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // -- chip rendering -----------------------------------------------------
  type Chip = { label: string; onRemove: () => void };
  const chips: Chip[] = [];
  for (const t of filters.type) chips.push({
    label: `Type: ${t.replace(/_/g, ' ')}`,
    onRemove: () => setFilters(f => ({ ...f, type: f.type.filter(x => x !== t) })),
  });
  for (const s of filters.status) chips.push({
    label: `Status: ${STATUS_PILL[s]?.label ?? s}`,
    onRemove: () => setFilters(f => ({ ...f, status: f.status.filter(x => x !== s) })),
  });
  if (filters.last_contact) chips.push({
    label: `Last Contact: ${lastContactLabel(filters.last_contact)}`,
    onRemove: () => setFilters(f => ({ ...f, last_contact: '' })),
  });
  if (filters.interactions) chips.push({
    label: `Interactions: ${INTERACTIONS_OPTIONS.find(o => o.value === filters.interactions)?.label ?? filters.interactions}`,
    onRemove: () => setFilters(f => ({ ...f, interactions: '' })),
  });
  if (filters.company_id) {
    const co = allCompanies.find(c => c.id === filters.company_id);
    chips.push({
      label: `Company: ${co?.name ?? '…'}`,
      onRemove: () => setFilters(f => ({ ...f, company_id: '' })),
    });
  }
  for (const tagId of filters.tags) {
    const tag = allTags.find(t => t.id === tagId);
    if (!tag) continue;
    chips.push({
      label: `Tag: ${tag.name}`,
      onRemove: () => setFilters(f => ({ ...f, tags: f.tags.filter(x => x !== tagId) })),
    });
  }
  if (filters.has_followup_overdue) chips.push({
    label: 'Overdue Follow-up',
    onRemove: () => setFilters(f => ({ ...f, has_followup_overdue: false })),
  });
  if (filters.in_active_deals) chips.push({
    label: 'In Active Deals',
    onRemove: () => setFilters(f => ({ ...f, in_active_deals: false })),
  });
  if (filters.sort !== DEFAULT_SORT || filters.order !== DEFAULT_ORDER) {
    const opt = SORT_OPTIONS.find(o => o.key === filters.sort);
    chips.push({
      label: `Sort: ${opt?.label ?? filters.sort} ${filters.order === 'asc' ? '↑' : '↓'}`,
      onRemove: () => setFilters(f => ({ ...f, sort: DEFAULT_SORT, order: DEFAULT_ORDER })),
    });
  }

  const isFiltered = chips.length > 0;

  // -- column definitions -------------------------------------------------
  const columns: Column<Contact>[] = [
    {
      key: 'name', sortKey: 'name', header: 'Name', width: '220px', sortable: true,
      accessor: row => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xs font-medium">
            {initialFromName(row.full_name)}
          </div>
          <span className="font-medium truncate" title={row.full_name}>{row.full_name}</span>
        </div>
      ),
    },
    {
      key: 'company', sortKey: 'company', header: 'Company', width: '180px', sortable: true,
      accessor: row => (
        <span className="truncate block" title={row.company_name || undefined}>
          {row.company_name || '—'}
        </span>
      ),
    },
    {
      key: 'type', sortKey: 'type', header: 'Type', width: '100px', sortable: true,
      accessor: row => <span className="badge capitalize">{row.contact_type}</span>,
    },
    {
      key: 'tags', header: 'Tags', width: '180px',
      accessor: row => (
        <div className="flex items-center gap-1 flex-wrap">
          {(row.tags || []).slice(0, 3).map(t => (
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
      key: 'last_contact', sortKey: 'last_contact', header: 'Last Contact', width: '120px', sortable: true,
      accessor: row => (row.last_contact_date ? formatRelative(row.last_contact_date) : '—'),
    },
    {
      key: 'interactions', sortKey: 'interactions', header: 'Interactions', width: '90px', sortable: true,
      accessor: row => row.total_interactions,
    },
    {
      key: 'status', sortKey: 'status', header: 'Status', width: '110px', sortable: true,
      accessor: row => {
        const s = row.engagement_status;
        if (!s) return <span className="text-text-muted">{'—'}</span>;
        const pill = STATUS_PILL[s];
        if (!pill) return <span className="badge capitalize">{s}</span>;
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold font-accent"
            style={{ background: pill.bg, color: pill.text }}>
            {pill.label}
          </span>
        );
      },
    },
  ];

  function handleSort(key: string) {
    setFilters(f => {
      // If clicking the active sort, flip direction; otherwise switch and use
      // the option's default direction.
      if (f.sort === key) {
        return { ...f, order: f.order === 'asc' ? 'desc' : 'asc' };
      }
      const opt = SORT_OPTIONS.find(o => o.key === key);
      return { ...f, sort: key, order: opt?.defaultDir ?? 'asc' };
    });
  }

  return (
    <div className="flex-1 flex flex-col md:flex-row min-w-0">
      <FilterPanel
        sections={[
          {
            label: 'Contact Type',
            defaultOpen: true,
            children: CONTACT_TYPES.map(type => {
              const count = filterCounts.contact_type[type] || 0;
              const active = filters.type.includes(type);
              return (
                <label key={type}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({
                      ...f,
                      type: e.target.checked ? [...f.type, type] : f.type.filter(t => t !== type),
                    }))} />
                  <span className="capitalize flex-1">{type.replace(/_/g, ' ')}</span>
                  <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                </label>
              );
            }),
          },
          {
            label: 'Status',
            defaultOpen: true,
            children: ENGAGEMENT_STATUSES.map(status => {
              const count = filterCounts.engagement_status[status] || 0;
              const active = filters.status.includes(status);
              const pill = STATUS_PILL[status];
              return (
                <label key={status}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({
                      ...f,
                      status: e.target.checked ? [...f.status, status] : f.status.filter(s => s !== status),
                    }))} />
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: pill?.text || '#94A3B8' }} />
                  <span className="flex-1">{pill?.label ?? status}</span>
                  <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                </label>
              );
            }),
          },
          {
            label: 'Last Contact',
            defaultOpen: false,
            children: LAST_CONTACT_OPTIONS.map(opt => {
              const active = filters.last_contact === opt.value;
              return (
                <label key={opt.value}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="radio" name="last_contact" checked={active}
                    onChange={() => setFilters(f => ({ ...f, last_contact: opt.value }))} />
                  <span className="flex-1">{opt.label}</span>
                </label>
              );
            }),
          },
          {
            label: 'Interactions',
            defaultOpen: false,
            children: INTERACTIONS_OPTIONS.map(opt => {
              const active = filters.interactions === opt.value;
              return (
                <label key={opt.value}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="radio" name="interactions" checked={active}
                    onChange={() => setFilters(f => ({ ...f, interactions: opt.value }))} />
                  <span className="flex-1">{opt.label}</span>
                </label>
              );
            }),
          },
          {
            label: 'Company',
            defaultOpen: false,
            children: <CompanyTypeahead
              options={allCompanies}
              value={filters.company_id}
              onChange={id => setFilters(f => ({ ...f, company_id: id }))}
            />,
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
                          ...f,
                          tags: e.target.checked ? [...f.tags, tag.id] : f.tags.filter(t => t !== tag.id),
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
          {
            label: 'Follow-up',
            defaultOpen: false,
            children: (() => {
              const count = filterCounts.overdue_followups;
              const active = filters.has_followup_overdue;
              return (
                <label className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                  active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({ ...f, has_followup_overdue: e.target.checked }))} />
                  <span className="flex-1">Overdue only</span>
                  {count > 0 && <span className="text-[10px] text-semantic-error tabular-nums">{count}</span>}
                </label>
              );
            })(),
          },
        ]}
        onClearAll={() => { setFilters(emptyFilters()); setSearchInput(''); }}
        activeCount={chips.length}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar
          title="Contacts"
          search={
            <div className="relative flex-1 min-w-0 md:min-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input type="text" placeholder="Search contacts by name, email, or company..."
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
                onClick={() => demoMode ? setToast(demoToastMessage('Adding contacts')) : setCreateOpen(true)}
              >
                <Plus size={16} /> Add Contact
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
            {loading ? 'Loading...' : `Showing ${contacts.length} of ${total} ${isFiltered ? 'matching ' : ''}contacts`}
          </div>

          <DataTable
            columns={columns}
            data={contacts}
            loading={loading}
            emptyMessage="No contacts match your filters"
            getRowId={c => c.id}
            onRowClick={c => router.push(`/contacts/${c.id}`)}
            sortKey={filters.sort}
            sortDir={filters.order}
            onSort={handleSort}
          />

          {!demoMode && !loading && contacts.length < total && (
            <div className="flex justify-center mt-4">
              <button onClick={loadMore} disabled={loadingMore} className="btn-secondary text-sm">
                {loadingMore ? 'Loading...' : `Load more (${total - contacts.length} remaining)`}
              </button>
            </div>
          )}
          {!demoMode && !loading && contacts.length > 0 && contacts.length >= total && (
            <div className="text-center mt-4 text-xs text-text-muted">End of results</div>
          )}
        </div>
      </main>

      <ContactCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          setToast('Contact created');
          loadContacts();
        }}
      />

      <TagManagerModal
        entityType="contact"
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        onChanged={() => {
          api.listTags('contact').then(d => setAllTags(d.tags as Tag[])).catch(() => {});
          api.getContactFilterCounts().then(setFilterCounts).catch(() => {});
        }}
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

function CompanyTypeahead({
  options,
  value,
  onChange,
}: {
  options: CompanyOpt[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const selected = options.find(o => o.id === value);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => o.name.toLowerCase().includes(q)).slice(0, 12)
    : options.slice(0, 8);

  if (selected) {
    return (
      <div className="flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded bg-accent-magenta/10 text-sm">
        <span className="flex-1 truncate text-text-primary" title={selected.name}>{selected.name}</span>
        <span className="text-[10px] text-text-muted tabular-nums">{selected.count}</span>
        <button onClick={() => onChange('')} className="text-text-muted hover:text-text-primary">
          <XIcon size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search companies..."
        className="input w-full text-sm"
      />
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filtered.map(opt => (
          <button
            key={opt.id}
            onClick={() => { onChange(opt.id); setQuery(''); }}
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

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return '1d ago';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  return `${Math.floor(diff / (30 * day))}mo ago`;
}

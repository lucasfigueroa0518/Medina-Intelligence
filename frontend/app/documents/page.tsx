'use client';

import React, { Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { FilterPanel } from '@/components/filter-panel';
import { SortDropdown, SortOption } from '@/components/sort-dropdown';
import { QuickFilters, QuickFilter } from '@/components/quick-filters';
import { api } from '@/lib/api';
import {
  Search,
  X as XIcon,
  Download,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  File as FileIcon,
  Mail,
  Upload,
  MessageSquare,
  Wand2,
} from 'lucide-react';

interface Document {
  id: string;
  title: string;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  source: string;
  document_type: string;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  uploaded_by: string | null;
  processing_status: string;
  created_at: string;
  _contact_name: string | null;
  _company_name: string | null;
  _deal_title: string | null;
}

const DOCUMENT_TYPES = [
  'pitch_deck', 'financials', 'legal', 'memo', 'report',
  'spreadsheet', 'presentation', 'other',
];

// Sources that the backend stamps onto documents. The migration history
// added email_attachment / chat_upload / intelligent_import / manual_upload
// alongside the original 'upload' / 'manual'.
const SOURCES = [
  'email_attachment',
  'manual_upload',
  'upload',
  'chat_upload',
  'intelligent_import',
  'manual',
];

const SOURCE_LABEL: Record<string, string> = {
  email_attachment:    'Email',
  manual_upload:       'Upload',
  upload:              'Upload',
  chat_upload:         'Chat',
  intelligent_import:  'Smart Import',
  manual:              'Manual',
};

const SOURCE_PILL: Record<string, { bg: string; text: string; icon: typeof Mail }> = {
  email_attachment:    { bg: 'rgba(168,85,247,0.14)', text: '#C084FC', icon: Mail },
  manual_upload:       { bg: 'rgba(34,197,94,0.12)',  text: '#4ADE80', icon: Upload },
  upload:              { bg: 'rgba(34,197,94,0.12)',  text: '#4ADE80', icon: Upload },
  chat_upload:         { bg: 'rgba(245,158,11,0.12)', text: '#FBBF24', icon: MessageSquare },
  intelligent_import:  { bg: 'rgba(217,70,168,0.12)', text: '#D946A8', icon: Wand2 },
  manual:              { bg: 'rgba(148,163,184,0.14)',text: '#94A3B8', icon: Upload },
};

const SORT_OPTIONS: SortOption[] = [
  { key: 'created_at', label: 'Date Added (newest first)', defaultDir: 'desc' },
  { key: 'file_name',  label: 'Name (A–Z)',                defaultDir: 'asc'  },
  { key: 'file_size',  label: 'Size (largest first)',      defaultDir: 'desc' },
];

const PAGE_SIZE = 100;

interface FilterState {
  search: string;
  source: string[];
  document_type: string[];
  mime_type: string[];   // CSV LIKE-prefix patterns (e.g. ['application/pdf'])
  date_from: string;     // ISO date — backend compares lexicographically
  date_to: string;
  contact_id: string;
  company_id: string;
  deal_id: string;
  mine: boolean;
  sort: string;
  order: 'asc' | 'desc';
}

const DEFAULT_SORT = 'created_at';
const DEFAULT_ORDER: 'asc' | 'desc' = 'desc';

function emptyFilters(): FilterState {
  return {
    search: '',
    source: [],
    document_type: [],
    mime_type: [],
    date_from: '',
    date_to: '',
    contact_id: '',
    company_id: '',
    deal_id: '',
    mine: false,
    sort: DEFAULT_SORT,
    order: DEFAULT_ORDER,
  };
}

function readFiltersFromUrl(sp: URLSearchParams): FilterState {
  const csv = (k: string) => (sp.get(k) || '').split(',').map(s => s.trim()).filter(Boolean);
  const order = sp.get('order');
  return {
    search:        sp.get('search') || '',
    source:        csv('source'),
    document_type: csv('document_type'),
    mime_type:     csv('mime_type'),
    date_from:     sp.get('date_from') || '',
    date_to:       sp.get('date_to') || '',
    contact_id:    sp.get('contact_id') || '',
    company_id:    sp.get('company_id') || '',
    deal_id:       sp.get('deal_id') || '',
    mine:          sp.get('mine') === 'true',
    sort:          sp.get('sort') || DEFAULT_SORT,
    order:         order === 'asc' || order === 'desc' ? order : DEFAULT_ORDER,
  };
}

function filtersToParams(f: FilterState): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.search) p.search = f.search;
  if (f.source.length) p.source = f.source.join(',');
  if (f.document_type.length) p.document_type = f.document_type.join(',');
  if (f.mime_type.length) p.mime_type = f.mime_type.join(',');
  if (f.date_from) p.date_from = f.date_from;
  if (f.date_to) p.date_to = f.date_to;
  if (f.contact_id) p.contact_id = f.contact_id;
  if (f.company_id) p.company_id = f.company_id;
  if (f.deal_id) p.deal_id = f.deal_id;
  if (f.mine) p.mine = 'true';
  if (f.sort && f.sort !== DEFAULT_SORT) p.sort = f.sort;
  if (f.order !== DEFAULT_ORDER) p.order = f.order;
  return p;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

const QUICK_FILTERS: QuickFilter<FilterState>[] = [
  { key: 'recent',    label: 'Recent (7d)',       preset: { date_from: isoDaysAgo(7) } },
  { key: 'email',     label: 'Email Attachments', preset: { source: ['email_attachment'] } },
  { key: 'pdfs',      label: 'PDFs',              preset: { mime_type: ['application/pdf'] } },
  { key: 'mine',      label: 'Mine',              preset: { mine: true } },
];

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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

function mimeBadge(mime: string | null): { label: string; icon: typeof FileIcon } {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('application/pdf')) return { label: 'PDF', icon: FileText };
  if (m.includes('spreadsheet') || m.includes('excel') || m.startsWith('text/csv'))
    return { label: m.startsWith('text/csv') ? 'CSV' : 'XLSX', icon: FileSpreadsheet };
  if (m.includes('wordprocessingml') || m.includes('msword')) return { label: 'DOCX', icon: FileText };
  if (m.includes('presentationml') || m.includes('powerpoint')) return { label: 'PPTX', icon: FileText };
  if (m.startsWith('image/')) return { label: 'Image', icon: ImageIcon };
  if (m.startsWith('text/')) return { label: 'Text', icon: FileText };
  return { label: '—', icon: FileIcon };
}

export default function DocumentsPageWrapper() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <DocumentsPage />
    </Suspense>
  );
}

function DocumentsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [filters, setFilters] = React.useState<FilterState>(() =>
    readFiltersFromUrl(searchParams ? new URLSearchParams(searchParams.toString()) : new URLSearchParams())
  );
  const [searchInput, setSearchInput] = React.useState(filters.search);
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout>>();

  const [documents, setDocuments] = React.useState<Document[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const [filterCounts, setFilterCounts] = React.useState<{
    source: Record<string, number>;
    document_type: Record<string, number>;
    date_bucket: { last_7d: number; last_30d: number; older: number };
    mine: number;
  }>({ source: {}, document_type: {}, date_bucket: { last_7d: 0, last_30d: 0, older: 0 }, mine: 0 });

  // URL sync — replace, not push, so back button doesn't undo each chip click.
  React.useEffect(() => {
    const params = filtersToParams(filters);
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
    api.getDocumentFilterCounts().then(setFilterCounts).catch(() => {});
  }, []);

  const buildParams = React.useCallback((offset: number): Record<string, string> => {
    return {
      ...filtersToParams(filters),
      limit: String(PAGE_SIZE),
      offset: String(offset),
    };
  }, [filters]);

  const loadDocuments = React.useCallback(() => {
    setLoading(true);
    return api.listDocuments(buildParams(0))
      .then(data => {
        setDocuments(data.documents as Document[]);
        setTotal(data.total ?? data.documents.length);
      })
      .finally(() => setLoading(false));
  }, [buildParams]);

  const loadMore = React.useCallback(() => {
    if (loadingMore || documents.length >= total) return;
    setLoadingMore(true);
    api.listDocuments(buildParams(documents.length))
      .then(data => {
        setDocuments(prev => [...prev, ...(data.documents as Document[])]);
        if (typeof data.total === 'number') setTotal(data.total);
      })
      .finally(() => setLoadingMore(false));
  }, [buildParams, documents.length, total, loadingMore]);

  React.useEffect(() => { loadDocuments(); }, [loadDocuments]);

  // -- chips --------------------------------------------------------------
  type Chip = { label: string; onRemove: () => void };
  const chips: Chip[] = [];
  for (const s of filters.source) chips.push({
    label: `Source: ${SOURCE_LABEL[s] ?? s}`,
    onRemove: () => setFilters(f => ({ ...f, source: f.source.filter(x => x !== s) })),
  });
  for (const t of filters.document_type) chips.push({
    label: `Type: ${t.replace(/_/g, ' ')}`,
    onRemove: () => setFilters(f => ({ ...f, document_type: f.document_type.filter(x => x !== t) })),
  });
  for (const m of filters.mime_type) chips.push({
    label: `MIME: ${m}`,
    onRemove: () => setFilters(f => ({ ...f, mime_type: f.mime_type.filter(x => x !== m) })),
  });
  if (filters.date_from || filters.date_to) chips.push({
    label: `Date: ${filters.date_from ? new Date(filters.date_from).toLocaleDateString() : '…'} → ${filters.date_to ? new Date(filters.date_to).toLocaleDateString() : '…'}`,
    onRemove: () => setFilters(f => ({ ...f, date_from: '', date_to: '' })),
  });
  if (filters.mine) chips.push({
    label: 'Mine',
    onRemove: () => setFilters(f => ({ ...f, mine: false })),
  });
  if (filters.sort !== DEFAULT_SORT || filters.order !== DEFAULT_ORDER) {
    const opt = SORT_OPTIONS.find(o => o.key === filters.sort);
    chips.push({
      label: `Sort: ${opt?.label ?? filters.sort} ${filters.order === 'asc' ? '↑' : '↓'}`,
      onRemove: () => setFilters(f => ({ ...f, sort: DEFAULT_SORT, order: DEFAULT_ORDER })),
    });
  }
  const isFiltered = chips.length > 0;

  // -- columns ------------------------------------------------------------
  const columns: Column<Document>[] = [
    {
      key: 'name', sortKey: 'file_name', header: 'Name', width: '32%', sortable: true,
      accessor: row => {
        const badge = mimeBadge(row.mime_type);
        const Icon = badge.icon;
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <Icon size={16} className="shrink-0 text-text-muted" />
            <span className="truncate" title={row.title || row.file_name || ''}>
              {row.title || row.file_name || '(untitled)'}
            </span>
          </div>
        );
      },
    },
    {
      key: 'mime', header: 'Type', width: '80px',
      accessor: row => <span className="badge text-[10px]">{mimeBadge(row.mime_type).label}</span>,
    },
    {
      key: 'source', header: 'Source', width: '130px',
      accessor: row => {
        const pill = SOURCE_PILL[row.source];
        const label = SOURCE_LABEL[row.source] ?? row.source;
        if (!pill) return <span className="badge capitalize">{label}</span>;
        const Icon = pill.icon;
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium font-accent"
            style={{ background: pill.bg, color: pill.text }}>
            <Icon size={10} />
            {label}
          </span>
        );
      },
    },
    {
      key: 'linked', header: 'Linked', width: '180px',
      accessor: row => {
        if (row.contact_id && row._contact_name) {
          return (
            <Link href={`/contacts/${row.contact_id}`} onClick={e => e.stopPropagation()}
              className="text-text-secondary hover:text-accent-magenta truncate block" title={row._contact_name}>
              {row._contact_name}
            </Link>
          );
        }
        if (row.company_id && row._company_name) {
          return (
            <Link href={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()}
              className="text-text-secondary hover:text-accent-magenta truncate block" title={row._company_name}>
              {row._company_name}
            </Link>
          );
        }
        if (row.deal_id && row._deal_title) {
          return (
            <Link href={`/deals/${row.deal_id}`} onClick={e => e.stopPropagation()}
              className="text-text-secondary hover:text-accent-magenta truncate block" title={row._deal_title}>
              {row._deal_title}
            </Link>
          );
        }
        return <span className="text-text-muted">—</span>;
      },
    },
    {
      key: 'size', sortKey: 'file_size', header: 'Size', width: '90px', sortable: true,
      accessor: row => <span className="tabular-nums text-text-secondary">{formatBytes(row.file_size)}</span>,
    },
    {
      key: 'added', sortKey: 'created_at', header: 'Added', width: '110px', sortable: true,
      accessor: row => <span className="text-text-secondary">{formatRelative(row.created_at)}</span>,
    },
    {
      key: 'actions', header: '', width: '50px',
      accessor: row => (
        <button
          title="Download"
          onClick={async e => {
            e.stopPropagation();
            try {
              const { downloadUrl } = await api.getDocument(row.id);
              if (downloadUrl) window.open(downloadUrl, '_blank');
            } catch { /* ignore */ }
          }}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-white/[0.06] transition-colors"
        >
          <Download size={14} />
        </button>
      ),
    },
  ];

  function handleSort(key: string) {
    setFilters(f => {
      if (f.sort === key) return { ...f, order: f.order === 'asc' ? 'desc' : 'asc' };
      const opt = SORT_OPTIONS.find(o => o.key === key);
      return { ...f, sort: key, order: opt?.defaultDir ?? 'desc' };
    });
  }

  return (
    <div className="flex-1 flex">
      <FilterPanel
        sections={[
          {
            label: 'Source',
            defaultOpen: true,
            children: SOURCES.map(s => {
              const count = filterCounts.source[s] || 0;
              const active = filters.source.includes(s);
              return (
                <label key={s}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({
                      ...f,
                      source: e.target.checked ? [...f.source, s] : f.source.filter(x => x !== s),
                    }))} />
                  <span className="flex-1">{SOURCE_LABEL[s] ?? s}</span>
                  <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                </label>
              );
            }),
          },
          {
            label: 'Document Type',
            defaultOpen: true,
            children: DOCUMENT_TYPES.map(t => {
              const count = filterCounts.document_type[t] || 0;
              const active = filters.document_type.includes(t);
              return (
                <label key={t}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({
                      ...f,
                      document_type: e.target.checked ? [...f.document_type, t] : f.document_type.filter(x => x !== t),
                    }))} />
                  <span className="capitalize flex-1">{t.replace(/_/g, ' ')}</span>
                  <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                </label>
              );
            }),
          },
          {
            label: 'Date Added',
            defaultOpen: false,
            children: (
              <div className="space-y-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-text-muted uppercase tracking-wider">From</label>
                  <input
                    type="date"
                    value={filters.date_from ? filters.date_from.slice(0, 10) : ''}
                    onChange={e => setFilters(f => ({ ...f, date_from: e.target.value ? new Date(e.target.value).toISOString() : '' }))}
                    className="input w-full text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-text-muted uppercase tracking-wider">To</label>
                  <input
                    type="date"
                    value={filters.date_to ? filters.date_to.slice(0, 10) : ''}
                    onChange={e => setFilters(f => ({ ...f, date_to: e.target.value ? new Date(e.target.value).toISOString() : '' }))}
                    className="input w-full text-sm"
                  />
                </div>
                <div className="text-[10px] text-text-muted">
                  Last 7d: {filterCounts.date_bucket.last_7d} · 30d: {filterCounts.date_bucket.last_30d}
                </div>
              </div>
            ),
          },
          {
            label: 'Uploaded By',
            defaultOpen: false,
            children: (() => {
              const count = filterCounts.mine;
              const active = filters.mine;
              return (
                <label className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                  active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters(f => ({ ...f, mine: e.target.checked }))} />
                  <span className="flex-1">Mine only</span>
                  <span className="text-[10px] tabular-nums text-text-muted">{count}</span>
                </label>
              );
            })(),
          },
        ]}
        onClearAll={() => { setFilters(emptyFilters()); setSearchInput(''); }}
        activeCount={chips.length}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          title="Documents"
          search={
            <div className="relative flex-1 min-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input type="text" placeholder="Search documents by title or filename..."
                value={searchInput} onChange={e => setSearchInput(e.target.value)}
                className="input pl-10 w-full" />
            </div>
          }
          actions={
            <div className="flex items-center gap-2">
              <SortDropdown
                options={SORT_OPTIONS}
                value={filters.sort}
                dir={filters.order}
                onChange={(key, dir) => setFilters(f => ({ ...f, sort: key, order: dir }))}
              />
            </div>
          }
        />

        <div className="flex-1 p-6 overflow-auto">
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
            {loading ? 'Loading...' : `Showing ${documents.length} of ${total} ${isFiltered ? 'matching ' : ''}documents`}
          </div>

          <DataTable
            columns={columns}
            data={documents}
            loading={loading}
            emptyMessage="No documents match your filters"
            getRowId={d => d.id}
            onRowClick={d => router.push(`/documents/${d.id}`)}
            sortKey={filters.sort}
            sortDir={filters.order}
            onSort={handleSort}
          />

          {!loading && documents.length < total && (
            <div className="flex justify-center mt-4">
              <button onClick={loadMore} disabled={loadingMore} className="btn-secondary text-sm">
                {loadingMore ? 'Loading...' : `Load more (${total - documents.length} remaining)`}
              </button>
            </div>
          )}
          {!loading && documents.length > 0 && documents.length >= total && (
            <div className="text-center mt-4 text-xs text-text-muted">End of results</div>
          )}
        </div>
      </main>
    </div>
  );
}

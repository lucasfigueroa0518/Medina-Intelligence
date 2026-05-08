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
import { DocumentUploadModal } from '@/components/document-upload-modal';
import { DocumentPreviewModal } from '@/components/document-preview-modal';
import { DocumentActions } from '@/components/document-actions';
import {
  Search,
  X as XIcon,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  File as FileIcon,
  Mail,
  Upload,
  MessageSquare,
  Wand2,
  Plus,
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

// Source of truth: src/lib/document-intelligence.ts:184-190 (classifier
// allowlist) + 'other' as a transitional bucket. Wave 5 Phase F: rendered
// in the filter rail as a 5+1 collapsible accordion (Deal / Fund /
// Relationships / Market intel / General + Transitional 'other'). Lucas
// approved the 5-bucket grouping in Phase 0; the original spec said 4 but
// promoting research+portfolio_update to their own Market intel bucket
// keeps that group distinct from internal General materials.
const CATEGORY_BUCKETS: { label: string; children: string[] }[] = [
  { label: 'Deal',          children: ['deal_pitch', 'deal_diligence', 'deal_terms', 'deal_financials'] },
  { label: 'Fund',          children: ['fund_reporting', 'fund_legal', 'fund_admin'] },
  { label: 'Relationships', children: ['contact_data', 'correspondence', 'meeting_material'] },
  { label: 'Market intel',  children: ['research', 'portfolio_update'] },
  { label: 'General',       children: ['internal_ops', 'reference'] },
  { label: 'Transitional',  children: ['other'] },
];

// Flat list for chip removal handlers + the FilterState shape.
const DOCUMENT_TYPES = CATEGORY_BUCKETS.flatMap(b => b.children);

// Wave 5 Phase E canonical 4-value source set. Migration 0068 backfilled
// legacy 'upload'/'manual' rows to canonical names; persist-document no
// longer normalizes manual_upload → upload. Unknown sources still render
// safely via the `?? s` fallback at the row accessor.
const SOURCES = [
  'email_attachment',
  'manual_upload',
  'chat_upload',
  'intelligent_import',
];

const SOURCE_LABEL: Record<string, string> = {
  email_attachment:    'Email',
  manual_upload:       'Upload',
  chat_upload:         'Chat',
  intelligent_import:  'Smart Import',
};

const SOURCE_PILL: Record<string, { bg: string; text: string; icon: typeof Mail }> = {
  email_attachment:    { bg: 'rgba(168,85,247,0.14)', text: '#C084FC', icon: Mail },
  manual_upload:       { bg: 'rgba(34,197,94,0.12)',  text: '#4ADE80', icon: Upload },
  chat_upload:         { bg: 'rgba(245,158,11,0.12)', text: '#FBBF24', icon: MessageSquare },
  intelligent_import:  { bg: 'rgba(217,70,168,0.12)', text: '#D946A8', icon: Wand2 },
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
  // sort + order travel together. Backend documents handler currently uses a
  // single global 'desc' fallback (no per-column defaultDir), so the strip
  // pattern is latent here today — but the moment per-column defaults are
  // added, stripping individually would silently override the user's chosen
  // direction. Keep them paired to match contacts + companies behavior.
  if (f.sort !== DEFAULT_SORT || f.order !== DEFAULT_ORDER) {
    p.sort = f.sort;
    p.order = f.order;
  }
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

  // Upload modal — opened via TopBar button or page-level drag-drop.
  // initialFiles seeds the queue from a drop hand-off.
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [uploadInitialFiles, setUploadInitialFiles] = React.useState<File[]>([]);
  const [pageDragOver, setPageDragOver] = React.useState(false);
  const dragCounterRef = React.useRef(0);
  // Wave 5 Phase G — preview modal state. Row click opens in-context
  // preview rather than full-page navigation; modal exposes "Open in
  // detail page" for power users.
  const [previewDocId, setPreviewDocId] = React.useState<string | null>(null);

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
      key: 'name', sortKey: 'file_name', header: 'Name', width: '44%', sortable: true,
      accessor: row => {
        const badge = mimeBadge(row.mime_type);
        const Icon = badge.icon;
        const failed = row.processing_status === 'failed';
        const excluded = row.processing_status === 'excluded';
        const dimmed = failed || excluded;
        return (
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <Icon size={16} className={`shrink-0 ${failed ? 'text-semantic-error/70' : excluded ? 'text-text-muted/50' : 'text-text-muted'}`} />
              <span className={`truncate ${dimmed ? 'text-text-secondary' : ''}`} title={row.title || row.file_name || ''}>
                {row.title || row.file_name || '(untitled)'}
              </span>
              {failed && (
                <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium font-accent uppercase tracking-wider"
                  style={{ background: 'rgba(239,68,68,0.12)', color: '#FCA5A5' }}>
                  Failed
                </span>
              )}
              {excluded && (
                <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium font-accent uppercase tracking-wider"
                  style={{ background: 'rgba(148,163,184,0.14)', color: '#94A3B8' }}>
                  Excluded
                </span>
              )}
            </div>
            <div className="shrink-0">
              <DocumentActions
                doc={row}
                variant="icon"
                onPreview={documentId => setPreviewDocId(documentId)}
              />
            </div>
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
  ];

  function handleSort(key: string) {
    setFilters(f => {
      if (f.sort === key) return { ...f, order: f.order === 'asc' ? 'desc' : 'asc' };
      const opt = SORT_OPTIONS.find(o => o.key === key);
      return { ...f, sort: key, order: opt?.defaultDir ?? 'desc' };
    });
  }

  return (
    <div className="flex-1 flex flex-col md:flex-row min-w-0">
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
            children: (
              <div className="space-y-3">
                {CATEGORY_BUCKETS.map(bucket => (
                  <BucketGroup
                    key={bucket.label}
                    label={bucket.label}
                    children={bucket.children}
                    counts={filterCounts.document_type}
                    selected={filters.document_type}
                    onToggle={(cat, on) => setFilters(f => ({
                      ...f,
                      document_type: on
                        ? [...f.document_type, cat]
                        : f.document_type.filter(x => x !== cat),
                    }))}
                    onToggleBucket={(children, on) => setFilters(f => ({
                      ...f,
                      document_type: on
                        ? Array.from(new Set([...f.document_type, ...children]))
                        : f.document_type.filter(x => !children.includes(x)),
                    }))}
                  />
                ))}
              </div>
            ),
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

      <main
        className="flex-1 flex flex-col overflow-hidden relative min-w-0"
        onDragEnter={e => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          dragCounterRef.current++;
          setPageDragOver(true);
        }}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
        }}
        onDragLeave={() => {
          dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
          if (dragCounterRef.current === 0) setPageDragOver(false);
        }}
        onDrop={e => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          dragCounterRef.current = 0;
          setPageDragOver(false);
          const dropped = Array.from(e.dataTransfer.files);
          if (dropped.length > 0) {
            setUploadInitialFiles(dropped);
            setUploadOpen(true);
          }
        }}
      >
        <TopBar
          title="Documents"
          search={
            <div className="relative flex-1 min-w-0 md:min-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input type="text" placeholder="Search documents by title or filename..."
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
                onClick={() => { setUploadInitialFiles([]); setUploadOpen(true); }}
                className="btn-primary flex items-center gap-1.5 text-sm"
              >
                <Plus size={14} /> Upload
              </button>
            </div>
          }
        />

        {/* Page-level drag-drop overlay — appears when files are dragged over /documents */}
        {pageDragOver && (
          <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
            style={{ background: 'rgba(217,70,168,0.08)', backdropFilter: 'blur(2px)', border: '2px dashed rgba(217,70,168,0.5)' }}>
            <div className="px-6 py-4 rounded-xl bg-bg-elevated border border-border shadow-2xl">
              <div className="flex items-center gap-3">
                <Upload size={24} className="text-accent-magenta" />
                <div>
                  <div className="text-sm font-medium text-text-primary">Drop to upload</div>
                  <div className="text-[11px] text-text-muted">Files will land in your Documents library</div>
                </div>
              </div>
            </div>
          </div>
        )}

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
            {loading ? 'Loading...' : `Showing ${documents.length} of ${total} ${isFiltered ? 'matching ' : ''}documents`}
          </div>

          <DataTable
            columns={columns}
            data={documents}
            loading={loading}
            emptyMessage="No documents match your filters"
            getRowId={d => d.id}
            onRowClick={d => setPreviewDocId(d.id)}
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

      <DocumentUploadModal
        open={uploadOpen}
        onClose={() => { setUploadOpen(false); setUploadInitialFiles([]); }}
        onUploaded={() => { loadDocuments(); api.getDocumentFilterCounts().then(setFilterCounts).catch(() => {}); }}
        initialFiles={uploadInitialFiles}
      />

      <DocumentPreviewModal
        docId={previewDocId}
        onClose={() => setPreviewDocId(null)}
      />
    </div>
  );
}

// Bucket-grouped category filter row: parent checkbox + expandable child
// list. Parent state derives from children: 'all' (filled), 'partial'
// (mixed), or 'none' (empty). Toggling parent flips all children at once.
function BucketGroup({
  label,
  children,
  counts,
  selected,
  onToggle,
  onToggleBucket,
}: {
  label: string;
  children: string[];
  counts: Record<string, number>;
  selected: string[];
  onToggle: (cat: string, on: boolean) => void;
  onToggleBucket: (children: string[], on: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedInBucket = children.filter(c => selected.includes(c));
  const state: 'all' | 'partial' | 'none' =
    selectedInBucket.length === 0 ? 'none'
    : selectedInBucket.length === children.length ? 'all'
    : 'partial';
  const total = children.reduce((sum, c) => sum + (counts[c] || 0), 0);
  const checkboxRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = (state === 'partial');
  }, [state]);
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={state === 'all'}
          onChange={e => onToggleBucket(children, e.target.checked)}
        />
        <button
          onClick={() => setOpen(o => !o)}
          className="flex-1 flex items-center justify-between text-left text-text-secondary hover:text-text-primary"
        >
          <span className="font-medium">{label}</span>
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] tabular-nums text-text-muted">{total}</span>
            <span className="text-text-muted text-xs">{open ? '−' : '+'}</span>
          </span>
        </button>
      </div>
      {open && (
        <div className="space-y-1 mt-1.5 ml-5">
          {children.map(cat => {
            const count = counts[cat] || 0;
            const active = selected.includes(cat);
            return (
              <label key={cat}
                className={`flex items-center gap-2 text-xs cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                  active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                }`}>
                <input type="checkbox" checked={active}
                  onChange={e => onToggle(cat, e.target.checked)} />
                <span className="capitalize flex-1">{cat.replace(/_/g, ' ')}</span>
                <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

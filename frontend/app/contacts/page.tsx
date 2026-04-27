'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { FilterPanel } from '@/components/filter-panel';
import { ContactCreateModal } from '@/components/contact-create-modal';
import { TagManagerModal } from '@/components/tag-manager-modal';
import { api } from '@/lib/api';
import { Search, Plus, X as XIcon, Settings2 } from 'lucide-react';

interface Contact {
  id: string;
  full_name: string;
  email: string;
  company_name?: string;
  contact_type: string;
  last_contact_date?: string;
  total_interactions: number;
  next_followup_date?: string;
  tags?: { id: string; name: string; color: string }[];
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

const CONTACT_TYPES = ['individual', 'family', 'institutional_investor', 'company'];

export default function ContactsPage() {
  const router = useRouter();
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<{
    contact_types: string[];
    has_followup_overdue: boolean;
    tag_ids: string[];
  }>({ contact_types: [], has_followup_overdue: false, tag_ids: [] });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [tagManagerOpen, setTagManagerOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const [allTags, setAllTags] = React.useState<Tag[]>([]);
  const [filterCounts, setFilterCounts] = React.useState<{
    contact_type: Record<string, number>;
    tags: Record<string, number>;
    overdue_followups: number;
  }>({ contact_type: {}, tags: {}, overdue_followups: 0 });

  const loadTags = React.useCallback(() => {
    api.listTags('contact').then(d => setAllTags(d.tags as Tag[])).catch(() => {});
  }, []);

  React.useEffect(() => {
    loadTags();
    api.getContactFilterCounts().then(setFilterCounts).catch(() => {});
  }, [loadTags]);

  const loadContacts = React.useCallback(() => {
    const params: Record<string, string> = {};
    if (search) params.keyword = search;
    if (filters.has_followup_overdue) params.has_followup_overdue = 'true';

    setLoading(true);
    return api
      .listContacts(params)
      .then(data => setContacts(data.contacts as Contact[]))
      .finally(() => setLoading(false));
  }, [search, filters.has_followup_overdue]);

  React.useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const filteredContacts = React.useMemo(() => {
    let result = contacts;
    if (filters.contact_types.length > 0) {
      result = result.filter(c => filters.contact_types.includes(c.contact_type));
    }
    if (filters.tag_ids.length > 0) {
      const tagSet = new Set(filters.tag_ids);
      result = result.filter(c => c.tags?.some(t => tagSet.has(t.id)));
    }
    return result;
  }, [contacts, filters.contact_types, filters.tag_ids]);

  const isFiltered = filters.contact_types.length > 0 || filters.tag_ids.length > 0;
  const activeFilterLabels: string[] = [
    ...filters.contact_types.map(t => t.replace(/_/g, ' ')),
    ...allTags.filter(t => filters.tag_ids.includes(t.id)).map(t => t.name),
  ];

  const columns: Column<Contact>[] = [
    {
      key: 'name',
      header: 'Name',
      width: '220px',
      accessor: row => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xs font-medium">
            {row.full_name.charAt(0)}
          </div>
          <span className="font-medium truncate" title={row.full_name}>{row.full_name}</span>
        </div>
      ),
      sortable: true,
    },
    {
      key: 'company',
      header: 'Company',
      width: '180px',
      accessor: row => (
        <span className="truncate block" title={row.company_name || undefined}>
          {row.company_name || '\u2014'}
        </span>
      ),
      sortable: true,
    },
    {
      key: 'type',
      header: 'Type',
      width: '100px',
      accessor: row => <span className="badge capitalize">{row.contact_type}</span>,
    },
    {
      key: 'tags',
      header: 'Tags',
      width: '180px',
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
      key: 'last_contact',
      header: 'Last Contact',
      width: '120px',
      accessor: row => (row.last_contact_date ? formatRelative(row.last_contact_date) : '\u2014'),
      sortable: true,
    },
    {
      key: 'interactions',
      header: 'Interactions',
      width: '90px',
      accessor: row => row.total_interactions,
      sortable: true,
    },
    {
      key: 'followup',
      header: 'Follow-up',
      width: '120px',
      accessor: row => {
        if (!row.next_followup_date) return '\u2014';
        const overdue = new Date(row.next_followup_date) < new Date();
        return (
          <span className={overdue ? 'text-semantic-error' : ''}>
            {formatRelative(row.next_followup_date)}
            {overdue && ' \u00b7 Overdue'}
          </span>
        );
      },
      sortable: true,
    },
  ];

  return (
    <div className="flex-1 flex">
      <FilterPanel
        sections={[
          {
            label: 'Contact Type',
            defaultOpen: true,
            children: CONTACT_TYPES.map(type => {
              const count = filterCounts.contact_type[type] || 0;
              const active = filters.contact_types.includes(type);
              return (
                <label key={type}
                  className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                    active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                  }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => {
                      const next = e.target.checked
                        ? [...filters.contact_types, type]
                        : filters.contact_types.filter(t => t !== type);
                      setFilters({ ...filters, contact_types: next });
                    }} />
                  <span className="capitalize flex-1">{type.replace(/_/g, ' ')}</span>
                  <span className={`text-[10px] tabular-nums ${count === 0 ? 'text-text-muted/50' : 'text-text-muted'}`}>{count}</span>
                </label>
              );
            }),
          },
          {
            label: 'Tags',
            defaultOpen: true,
            children: (
              <>
                {allTags.length > 0 ? allTags.map(tag => {
                  const count = filterCounts.tags[tag.id] || 0;
                  const active = filters.tag_ids.includes(tag.id);
                  return (
                    <label key={tag.id}
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                        active ? 'bg-accent-magenta/10 text-text-primary' : count === 0 ? 'text-text-muted' : 'text-text-secondary hover:text-text-primary'
                      }`}>
                      <input type="checkbox" checked={active}
                        onChange={e => {
                          const next = e.target.checked
                            ? [...filters.tag_ids, tag.id]
                            : filters.tag_ids.filter(t => t !== tag.id);
                          setFilters({ ...filters, tag_ids: next });
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
          {
            label: 'Follow-up',
            children: (() => {
              const count = filterCounts.overdue_followups;
              const active = filters.has_followup_overdue;
              return (
                <label className={`flex items-center gap-2 text-sm cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 transition-colors ${
                  active ? 'bg-accent-magenta/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}>
                  <input type="checkbox" checked={active}
                    onChange={e => setFilters({ ...filters, has_followup_overdue: e.target.checked })} />
                  <span className="flex-1">Overdue only</span>
                  {count > 0 && <span className="text-[10px] text-semantic-error tabular-nums">{count}</span>}
                </label>
              );
            })(),
          },
        ]}
        onClearAll={() => setFilters({ contact_types: [], has_followup_overdue: false, tag_ids: [] })}
        activeCount={filters.contact_types.length + (filters.has_followup_overdue ? 1 : 0) + filters.tag_ids.length}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          title="Contacts"
          search={
            <div className="relative flex-1 min-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input type="text" placeholder="Search contacts..."
                value={search} onChange={e => setSearch(e.target.value)}
                className="input pl-10 w-full" />
            </div>
          }
          actions={
            <button className="btn-primary flex items-center gap-2" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Add Contact
            </button>
          }
        />

        <div className="flex-1 p-6 overflow-auto">
          {/* Active filter summary */}
          {isFiltered && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-xs text-text-muted">Filtering:</span>
              {activeFilterLabels.map(label => (
                <span key={label} className="px-2 py-0.5 rounded text-[10px] font-medium capitalize"
                  style={{ background: 'rgba(217,70,168,0.1)', color: '#D946A8' }}>
                  {label}
                </span>
              ))}
              <button onClick={() => setFilters({ contact_types: [], has_followup_overdue: false, tag_ids: [] })}
                className="text-[10px] text-text-muted hover:text-text-secondary ml-1 flex items-center gap-0.5">
                <XIcon size={10} /> Clear All
              </button>
            </div>
          )}

          <div className="text-sm text-text-secondary mb-4">
            {loading ? 'Loading...' : isFiltered
              ? `Showing ${filteredContacts.length} of ${contacts.length} contacts`
              : `${contacts.length} contacts`
            }
          </div>
          <DataTable
            columns={columns}
            data={filteredContacts}
            loading={loading}
            emptyMessage="No contacts match your filters"
            getRowId={c => c.id}
            onRowClick={c => router.push(`/contacts/${c.id}`)}
          />
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
          loadTags();
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

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return '1d ago';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  return `${Math.floor(diff / (30 * day))}mo ago`;
}

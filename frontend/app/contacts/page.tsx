'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { FilterPanel } from '@/components/filter-panel';
import { ContactCreateModal } from '@/components/contact-create-modal';
import { api } from '@/lib/api';
import { Search, Plus } from 'lucide-react';

interface Contact {
  id: string;
  full_name: string;
  email: string;
  company_name?: string;
  contact_type: string;
  last_contact_date?: string;
  total_interactions: number;
  next_followup_date?: string;
}

export default function ContactsPage() {
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [filters, setFilters] = React.useState<{
    contact_types: string[];
    has_followup_overdue: boolean;
  }>({ contact_types: [], has_followup_overdue: false });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const loadContacts = React.useCallback(() => {
    const params: Record<string, string> = {};
    if (search) params.keyword = search;
    if (filters.has_followup_overdue) params.has_followup_overdue = 'true';

    setLoading(true);
    return api
      .listContacts(params)
      .then(data => setContacts(data.contacts as Contact[]))
      .finally(() => setLoading(false));
  }, [search, filters]);

  React.useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  // Auto-dismiss toast
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const columns: Column<Contact>[] = [
    {
      key: 'name',
      header: 'Name',
      width: '220px',
      accessor: row => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xs font-medium">
            {row.full_name.charAt(0)}
          </div>
          <span className="font-medium">{row.full_name}</span>
        </div>
      ),
      sortable: true,
    },
    {
      key: 'company',
      header: 'Company',
      width: '180px',
      accessor: row => row.company_name || '—',
      sortable: true,
    },
    {
      key: 'type',
      header: 'Type',
      width: '100px',
      accessor: row => <span className="badge capitalize">{row.contact_type}</span>,
    },
    {
      key: 'last_contact',
      header: 'Last Contact',
      width: '120px',
      accessor: row => (row.last_contact_date ? formatRelative(row.last_contact_date) : '—'),
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
        if (!row.next_followup_date) return '—';
        const overdue = new Date(row.next_followup_date) < new Date();
        return (
          <span className={overdue ? 'text-semantic-error' : ''}>
            {formatRelative(row.next_followup_date)}
            {overdue && ' · Overdue'}
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
            children: ['individual', 'family', 'institutional_investor', 'company'].map(
              type => (
                <label
                  key={type}
                  className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer hover:text-text-primary"
                >
                  <input
                    type="checkbox"
                    checked={filters.contact_types.includes(type)}
                    onChange={e => {
                      const next = e.target.checked
                        ? [...filters.contact_types, type]
                        : filters.contact_types.filter(t => t !== type);
                      setFilters({ ...filters, contact_types: next });
                    }}
                  />
                  <span className="capitalize">{type.replace('_', ' ')}</span>
                </label>
              )
            ),
          },
          {
            label: 'Follow-up',
            children: (
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer hover:text-text-primary">
                <input
                  type="checkbox"
                  checked={filters.has_followup_overdue}
                  onChange={e =>
                    setFilters({ ...filters, has_followup_overdue: e.target.checked })
                  }
                />
                <span>Overdue only</span>
              </label>
            ),
          },
        ]}
        onClearAll={() => setFilters({ contact_types: [], has_followup_overdue: false })}
        activeCount={filters.contact_types.length + (filters.has_followup_overdue ? 1 : 0)}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          title="Contacts"
          search={
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                placeholder="Search contacts..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="input pl-10 w-[280px]"
              />
            </div>
          }
          actions={
            <button
              className="btn-primary flex items-center gap-2"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={16} /> Add Contact
            </button>
          }
        />

        <div className="flex-1 p-6 overflow-auto">
          <div className="text-sm text-text-secondary mb-4">
            {loading ? 'Loading...' : `${contacts.length} contacts`}
          </div>
          <DataTable
            columns={columns}
            data={contacts}
            loading={loading}
            emptyMessage="No contacts match your filters"
            getRowId={c => c.id}
            onRowClick={c => (window.location.href = `/contacts/${c.id}`)}
          />
        </div>
      </main>

      <ContactCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={contact => {
          setCreateOpen(false);
          setToast('Contact created');
          loadContacts();
          // Optional: jump straight into the new contact's detail page.
          // window.location.href = `/contacts/${contact.id}`;
        }}
      />

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-bg-elevated border-l-4 border-semantic-success rounded-xl shadow-2xl px-5 py-3">
          <div className="text-sm text-text-primary">{toast}</div>
        </div>
      )}
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

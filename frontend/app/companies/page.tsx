'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { api } from '@/lib/api';
import { Plus } from 'lucide-react';

export default function CompaniesPage() {
  const [companies, setCompanies] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api
      .listCompanies()
      .then(d => setCompanies(d.companies))
      .finally(() => setLoading(false));
  }, []);

  const columns: Column<any>[] = [
    {
      key: 'name',
      header: 'Name',
      width: '220px',
      accessor: row => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-gradient flex items-center justify-center text-white text-xs font-medium">
            {row.name?.charAt(0)}
          </div>
          <span className="font-medium">{row.name}</span>
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
      key: 'stage',
      header: 'Stage',
      width: '120px',
      accessor: row => (
        <span className="badge capitalize">{row.stage?.replace('_', ' ') || '—'}</span>
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
      accessor: row => (
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-bg-surface-hover rounded">
            <div
              className="h-1.5 rounded bg-brand-gradient"
              style={{ width: `${(row.news_relevance_score || 0) * 100}%` }}
            />
          </div>
          <span className="text-xs">{((row.news_relevance_score || 0) * 100).toFixed(0)}</span>
        </div>
      ),
    },
  ];

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="Companies"
        actions={
          <button className="btn-primary flex items-center gap-2">
            <Plus size={16} /> Add Company
          </button>
        }
      />
      <div className="flex-1 p-6 overflow-auto">
        <div className="text-sm text-text-secondary mb-4">
          {loading ? 'Loading...' : `${companies.length} companies`}
        </div>
        <DataTable
          columns={columns}
          data={companies}
          loading={loading}
          emptyMessage="No companies yet"
          getRowId={c => c.id}
          onRowClick={c => (window.location.href = `/companies/${c.id}`)}
        />
      </div>
    </div>
  );
}

function formatCurrency(v?: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v}`;
}

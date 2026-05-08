'use client';

import React from 'react';
import { TopBar } from '@/components/top-bar';
import { DataTable, Column } from '@/components/data-table';
import { api } from '@/lib/api';
import { Plus } from 'lucide-react';

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api
      .listCampaigns()
      .then(d => setCampaigns(d.campaigns))
      .finally(() => setLoading(false));
  }, []);

  const columns: Column<any>[] = [
    { key: 'title', header: 'Title', width: '300px', accessor: row => row.title },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      accessor: row => {
        const colorMap: Record<string, string> = {
          draft: 'text-text-muted',
          scheduled: 'text-semantic-warning',
          sending: 'text-accent-magenta',
          sent: 'text-semantic-success',
          failed: 'text-semantic-error',
          cancelled: 'text-text-muted line-through',
        };
        return (
          <span className={`badge ${colorMap[row.status] || ''}`}>{row.status}</span>
        );
      },
    },
    { key: 'recipients', header: 'Recipients', width: '110px', accessor: row => row.total_recipients || 0 },
    { key: 'sent', header: 'Sent', width: '80px', accessor: row => row.total_sent || 0 },
    { key: 'failed', header: 'Failed', width: '80px', accessor: row => row.total_failed || 0 },
    {
      key: 'created',
      header: 'Created',
      width: '120px',
      accessor: row => new Date(row.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="Campaigns"
        actions={
          <button className="btn-primary flex items-center gap-2">
            <Plus size={16} /> Create Campaign
          </button>
        }
      />
      <div className="flex-1 p-4 md:p-6 overflow-auto">
        <DataTable
          columns={columns}
          data={campaigns}
          loading={loading}
          emptyMessage="No campaigns yet"
          getRowId={c => c.id}
          onRowClick={c => (window.location.href = `/campaigns/${c.id}`)}
        />
      </div>
    </div>
  );
}

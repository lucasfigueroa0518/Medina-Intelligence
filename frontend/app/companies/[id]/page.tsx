'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { TopBar } from '@/components/top-bar';
import { api } from '@/lib/api';

export default function CompanyDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    api
      .getCompany(params.id)
      .then(setData)
      .finally(() => setLoading(false));
  }, [params.id]);

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

  return (
    <div className="flex-1 overflow-auto">
      <TopBar title={company.name} actions={<button className="btn-secondary">Enrich Now</button>} />
      <div className="px-8 py-6 border-b border-border bg-bg-surface">
        <div className="font-display text-3xl">{company.name}</div>
        <div className="text-sm text-text-secondary mt-1">
          {company.sector || 'No sector'} · {company.stage?.replace('_', ' ') || 'Unknown stage'}
        </div>
      </div>
      <div className="p-8 space-y-6">
        <div className="card">
          <div className="text-xs uppercase text-text-muted mb-2">Description</div>
          <div className="text-sm text-text-secondary">
            {company.description || 'No description yet'}
          </div>
        </div>
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
            <div className="text-xs uppercase text-text-muted mb-2">News Score</div>
            <div className="text-2xl font-medium">
              {((company.news_relevance_score || 0) * 100).toFixed(0)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
